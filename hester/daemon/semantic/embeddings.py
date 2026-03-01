"""
EmbeddingService - Centralized embedding generation with Redis caching.

Provides:
- Single-text and batch embedding generation
- Redis caching for performance
- Pre-computation of agent/tool embeddings at startup
- Graceful degradation when services unavailable

Uses Google's gemini-embedding-001 model (768 dimensions).
"""

import hashlib
import logging
import os
import struct
from typing import Any, Dict, List, Optional, TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    import redis.asyncio as redis

logger = logging.getLogger("hester.daemon.semantic.embeddings")

# Embedding configuration
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768
CACHE_TTL_SECONDS = 86400 * 7  # 7 days

# Redis key prefix for embedding cache
REDIS_EMBEDDING_PREFIX = "hester:embedding:"


class EmbeddingService:
    """
    Centralized embedding generation service with Redis caching.

    Usage:
        service = EmbeddingService(redis_client=redis_client)

        # Generate single embedding
        embedding = await service.embed("some text")

        # Generate batch embeddings
        embeddings = await service.embed_batch(["text1", "text2", "text3"])

        # Pre-compute embeddings for agents/tools (at startup)
        agent_embeddings = await service.embed_agents(agent_registrations)
        tool_embeddings = await service.embed_tools(tool_registrations)
    """

    def __init__(
        self,
        redis_client: Optional["redis.Redis"] = None,
        api_key: Optional[str] = None,
    ):
        """
        Initialize the embedding service.

        Args:
            redis_client: Optional Redis client for caching
            api_key: Optional Google API key (falls back to GOOGLE_API_KEY env var)
        """
        self._redis = redis_client
        self._api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        self._genai_client = None

        # Track availability
        self._redis_available = redis_client is not None
        self._api_available = bool(self._api_key)

        if not self._api_available:
            logger.warning("GOOGLE_API_KEY not set - embedding generation unavailable")

    @property
    def is_available(self) -> bool:
        """Check if embedding generation is available."""
        return self._api_available

    @property
    def cache_available(self) -> bool:
        """Check if Redis caching is available."""
        return self._redis_available

    def _get_client(self):
        """Get or create Google GenAI client."""
        if not self._api_available:
            raise ValueError("Embedding service unavailable: GOOGLE_API_KEY not set")

        if self._genai_client is None:
            from google import genai
            self._genai_client = genai.Client(api_key=self._api_key)

        return self._genai_client

    def _cache_key(self, text: str) -> str:
        """Generate cache key for text."""
        text_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
        return f"{REDIS_EMBEDDING_PREFIX}{text_hash}"

    def _serialize_embedding(self, embedding: np.ndarray) -> bytes:
        """Serialize numpy array to bytes for Redis storage."""
        return struct.pack(f"{len(embedding)}f", *embedding.tolist())

    def _deserialize_embedding(self, data: bytes) -> np.ndarray:
        """Deserialize bytes from Redis to numpy array."""
        count = len(data) // 4  # float32 is 4 bytes
        values = struct.unpack(f"{count}f", data)
        return np.array(values, dtype=np.float32)

    async def _get_cached(self, text: str) -> Optional[np.ndarray]:
        """Get embedding from cache if available."""
        if not self._redis_available or not self._redis:
            return None

        try:
            key = self._cache_key(text)
            data = await self._redis.get(key)
            if data:
                return self._deserialize_embedding(data)
        except Exception as e:
            logger.debug(f"Cache read failed: {e}")

        return None

    async def _set_cached(self, text: str, embedding: np.ndarray) -> None:
        """Store embedding in cache."""
        if not self._redis_available or not self._redis:
            return

        try:
            key = self._cache_key(text)
            data = self._serialize_embedding(embedding)
            await self._redis.setex(key, CACHE_TTL_SECONDS, data)
        except Exception as e:
            logger.debug(f"Cache write failed: {e}")

    async def embed(self, text: str, use_cache: bool = True) -> np.ndarray:
        """
        Generate embedding for a single text.

        Args:
            text: Text to embed
            use_cache: Whether to use Redis cache (default: True)

        Returns:
            768-dimensional numpy array

        Raises:
            ValueError: If embedding service unavailable
        """
        if not self._api_available:
            raise ValueError("Embedding service unavailable: GOOGLE_API_KEY not set")

        # Check cache first
        if use_cache:
            cached = await self._get_cached(text)
            if cached is not None:
                return cached

        # Generate embedding
        client = self._get_client()
        result = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text,
            config={"output_dimensionality": EMBEDDING_DIMENSIONS},
        )
        embedding = np.array(result.embeddings[0].values, dtype=np.float32)

        # Cache result
        if use_cache:
            await self._set_cached(text, embedding)

        return embedding

    async def embed_batch(
        self,
        texts: List[str],
        use_cache: bool = True,
    ) -> List[np.ndarray]:
        """
        Generate embeddings for multiple texts.

        Optimizes by batching uncached texts and checking cache first.

        Args:
            texts: List of texts to embed
            use_cache: Whether to use Redis cache

        Returns:
            List of 768-dimensional numpy arrays (same order as input)
        """
        if not texts:
            return []

        if not self._api_available:
            raise ValueError("Embedding service unavailable: GOOGLE_API_KEY not set")

        results: List[Optional[np.ndarray]] = [None] * len(texts)
        uncached_indices: List[int] = []
        uncached_texts: List[str] = []

        # Check cache for each text
        if use_cache:
            for i, text in enumerate(texts):
                cached = await self._get_cached(text)
                if cached is not None:
                    results[i] = cached
                else:
                    uncached_indices.append(i)
                    uncached_texts.append(text)
        else:
            uncached_indices = list(range(len(texts)))
            uncached_texts = texts

        # Generate embeddings for uncached texts
        if uncached_texts:
            client = self._get_client()

            # Batch embed (API supports up to 100 texts per request)
            batch_size = 100
            for batch_start in range(0, len(uncached_texts), batch_size):
                batch_texts = uncached_texts[batch_start:batch_start + batch_size]
                batch_indices = uncached_indices[batch_start:batch_start + batch_size]

                result = client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=batch_texts,
                    config={"output_dimensionality": EMBEDDING_DIMENSIONS},
                )

                for i, embedding_data in enumerate(result.embeddings):
                    embedding = np.array(embedding_data.values, dtype=np.float32)
                    idx = batch_indices[i]
                    results[idx] = embedding

                    # Cache each result
                    if use_cache:
                        await self._set_cached(batch_texts[i], embedding)

        # Convert to list (all should be populated now)
        return [r for r in results if r is not None]

    async def embed_agents(
        self,
        agents: List["DelegateRegistration"],
    ) -> Dict[str, np.ndarray]:
        """
        Pre-compute embeddings for agent descriptions.

        Called at startup to cache agent embeddings for semantic routing.

        Args:
            agents: List of DelegateRegistration objects

        Returns:
            Dict mapping agent name to embedding
        """
        from .base import DelegateRegistration

        if not agents:
            return {}

        # Build embedding texts from descriptions + keywords
        texts = []
        for agent in agents:
            # Combine description and keywords for richer embedding
            text = f"{agent.description}"
            if agent.keywords:
                text += f" Keywords: {', '.join(agent.keywords)}"
            texts.append(text)

        embeddings = await self.embed_batch(texts)

        result = {}
        for agent, embedding in zip(agents, embeddings):
            result[agent.name] = embedding
            agent.embedding = embedding  # Also store on registration

        logger.debug(f"Pre-computed embeddings for {len(result)} agents")
        return result

    async def embed_tools(
        self,
        tools: List["ToolRegistration"],
    ) -> Dict[str, np.ndarray]:
        """
        Pre-compute embeddings for tool descriptions.

        Called at startup to cache tool embeddings for semantic routing.

        Args:
            tools: List of ToolRegistration objects

        Returns:
            Dict mapping tool name to embedding
        """
        from .base import ToolRegistration

        if not tools:
            return {}

        # Build embedding texts from descriptions + keywords
        texts = []
        for tool in tools:
            text = f"{tool.description}"
            if tool.keywords:
                text += f" Keywords: {', '.join(tool.keywords)}"
            texts.append(text)

        embeddings = await self.embed_batch(texts)

        result = {}
        for tool, embedding in zip(tools, embeddings):
            result[tool.name] = embedding
            tool.embedding = embedding  # Also store on registration

        logger.debug(f"Pre-computed embeddings for {len(result)} tools")
        return result

    def cosine_similarity(
        self,
        embedding1: np.ndarray,
        embedding2: np.ndarray,
    ) -> float:
        """
        Compute cosine similarity between two embeddings.

        Args:
            embedding1: First embedding vector
            embedding2: Second embedding vector

        Returns:
            Similarity score between -1 and 1
        """
        norm1 = np.linalg.norm(embedding1)
        norm2 = np.linalg.norm(embedding2)

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return float(np.dot(embedding1, embedding2) / (norm1 * norm2))

    def cosine_similarity_batch(
        self,
        query_embedding: np.ndarray,
        candidate_embeddings: List[np.ndarray],
    ) -> List[float]:
        """
        Compute cosine similarity between query and multiple candidates.

        Args:
            query_embedding: Query embedding vector
            candidate_embeddings: List of candidate embedding vectors

        Returns:
            List of similarity scores
        """
        if not candidate_embeddings:
            return []

        # Stack candidates into matrix for efficient computation
        candidates_matrix = np.vstack(candidate_embeddings)

        # Normalize query
        query_norm = query_embedding / (np.linalg.norm(query_embedding) + 1e-10)

        # Normalize candidates
        candidates_norms = np.linalg.norm(candidates_matrix, axis=1, keepdims=True)
        candidates_normalized = candidates_matrix / (candidates_norms + 1e-10)

        # Compute all similarities at once
        similarities = np.dot(candidates_normalized, query_norm)

        return similarities.tolist()
