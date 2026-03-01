"""
SemanticRouter - Unified semantic matching for Hester ReAct triage.

Provides semantic routing capabilities for:
- Plan Node: route_to_best_agent() for DIRECT/DELEGATE/TASK decision
- Prepare Node: route_to_tools() for tool pre-filtering before FunctionGemma
- Knowledge Engine: match_knowledge() for proactive context loading

This is a shared capability used across Hester's architecture as defined
in docs/07-Hester-React-Triage.md.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, TYPE_CHECKING, Union

import numpy as np

from .embeddings import EmbeddingService
from .base import DelegateRegistration, ToolRegistration

if TYPE_CHECKING:
    import redis.asyncio as redis

logger = logging.getLogger("hester.daemon.semantic.router")


# =============================================================================
# Data Classes
# =============================================================================


@dataclass
class RouteCandidate:
    """A candidate match from semantic routing."""

    item: Union[DelegateRegistration, ToolRegistration, "MatchedBundle", "MatchedDoc"]
    score: float
    match_type: str = "semantic"  # "semantic" or "keyword"


@dataclass
class MatchedBundle:
    """A matched context bundle."""

    bundle_id: str
    title: str
    score: float
    tags: List[str] = field(default_factory=list)


@dataclass
class MatchedDoc:
    """A matched documentation chunk."""

    doc_hash: str
    file_path: str
    heading: str
    score: float
    chunk_text: str = ""


@dataclass
class KnowledgeMatchResult:
    """Result of knowledge matching operation."""

    bundles: List[MatchedBundle]
    docs: List[MatchedDoc]
    query_embedding: Optional[np.ndarray] = None
    match_time_ms: float = 0.0


@dataclass
class ToolMatchResult:
    """Result of tool matching operation."""

    tools: List[RouteCandidate]
    query_embedding: Optional[np.ndarray] = None
    match_time_ms: float = 0.0


@dataclass
class AgentMatchResult:
    """Result of agent matching operation."""

    best_agent: Optional[DelegateRegistration]
    score: float
    all_candidates: List[RouteCandidate]
    match_time_ms: float = 0.0


# =============================================================================
# Semantic Router
# =============================================================================


class SemanticRouter:
    """
    Unified semantic matching for Hester ReAct triage.

    Provides three main matching capabilities:
    1. Agent routing (Plan Node): Find best agent for DELEGATE strategy
    2. Tool routing (Prepare Node): Pre-filter tools before FunctionGemma
    3. Knowledge matching: Find relevant bundles and docs for context

    Usage:
        router = SemanticRouter(embedding_service, redis_client)

        # Pre-load embeddings at startup
        await router.load_embeddings()

        # Route to best agent
        result = await router.route_to_best_agent("implement auth feature")

        # Pre-filter tools
        result = await router.route_to_tools("read the auth config file")

        # Match knowledge
        result = await router.match_knowledge("working on authentication")
    """

    def __init__(
        self,
        embedding_service: EmbeddingService,
        redis_client: Optional["redis.Redis"] = None,
    ):
        """
        Initialize the semantic router.

        Args:
            embedding_service: EmbeddingService for generating embeddings
            redis_client: Optional Redis client for knowledge store access
        """
        self.embeddings = embedding_service
        self.redis = redis_client

        # Cached embeddings (populated by load_embeddings)
        self._agent_embeddings: Dict[str, np.ndarray] = {}
        self._tool_embeddings: Dict[str, np.ndarray] = {}
        self._bundle_embeddings: Dict[str, np.ndarray] = {}
        self._doc_embeddings: Dict[str, np.ndarray] = {}

        # Metadata caches
        self._agent_meta: Dict[str, DelegateRegistration] = {}
        self._tool_meta: Dict[str, ToolRegistration] = {}
        self._bundle_meta: Dict[str, Dict[str, Any]] = {}
        self._doc_meta: Dict[str, Dict[str, Any]] = {}

        self._initialized = False

    @property
    def is_available(self) -> bool:
        """Check if router is available (embedding service working)."""
        return self.embeddings.is_available

    # =========================================================================
    # Initialization
    # =========================================================================

    async def load_embeddings(self, namespace: Optional[str] = None) -> int:
        """
        Load embeddings from registry and Redis into memory cache.

        Should be called at startup after HesterRegistry.initialize().

        Args:
            namespace: Optional namespace to load ("agents", "tools", "bundles", "docs")
                       If None, loads all namespaces.

        Returns:
            Number of embeddings loaded
        """
        from .registry import HesterRegistry

        count = 0

        # Load agent embeddings
        if namespace is None or namespace == "agents":
            delegates = HesterRegistry.list_delegates()
            if delegates:
                agent_embeddings = await self.embeddings.embed_agents(delegates)
                self._agent_embeddings = agent_embeddings
                for delegate in delegates:
                    self._agent_meta[delegate.name] = delegate
                count += len(agent_embeddings)
                logger.debug(f"Loaded {len(agent_embeddings)} agent embeddings")

        # Load tool embeddings
        if namespace is None or namespace == "tools":
            tools = HesterRegistry.list_tools()
            if tools:
                tool_embeddings = await self.embeddings.embed_tools(tools)
                self._tool_embeddings = tool_embeddings
                for tool in tools:
                    self._tool_meta[tool.name] = tool
                count += len(tool_embeddings)
                logger.debug(f"Loaded {len(tool_embeddings)} tool embeddings")

        # Load bundle embeddings from Redis (if available)
        if (namespace is None or namespace == "bundles") and self.redis:
            bundle_count = await self._load_bundle_embeddings()
            count += bundle_count

        # Load doc embeddings from Redis (if available)
        if (namespace is None or namespace == "docs") and self.redis:
            doc_count = await self._load_doc_embeddings()
            count += doc_count

        self._initialized = True
        return count

    async def _load_bundle_embeddings(self) -> int:
        """Load bundle embeddings from Redis knowledge store."""
        if not self.redis:
            return 0

        try:
            # Get bundle index
            bundle_ids = await self.redis.smembers("hester:bundles:index")
            if not bundle_ids:
                return 0

            count = 0
            for bundle_id in bundle_ids:
                bid = bundle_id.decode() if isinstance(bundle_id, bytes) else bundle_id

                # Get embedding
                embedding_data = await self.redis.get(f"hester:bundle:{bid}:embedding")
                if embedding_data:
                    embedding = self._deserialize_embedding(embedding_data)
                    self._bundle_embeddings[bid] = embedding

                    # Get metadata
                    meta_data = await self.redis.get(f"hester:bundle:{bid}:meta")
                    if meta_data:
                        import json
                        meta = json.loads(meta_data)
                        self._bundle_meta[bid] = meta

                    count += 1

            logger.debug(f"Loaded {count} bundle embeddings from Redis")
            return count

        except Exception as e:
            logger.warning(f"Failed to load bundle embeddings: {e}")
            return 0

    async def _load_doc_embeddings(self) -> int:
        """Load doc embeddings from Redis knowledge store."""
        if not self.redis:
            return 0

        try:
            # Get doc index
            doc_hashes = await self.redis.smembers("hester:docs:index")
            if not doc_hashes:
                return 0

            count = 0
            for doc_hash in doc_hashes:
                dhash = doc_hash.decode() if isinstance(doc_hash, bytes) else doc_hash

                # Get embedding
                embedding_data = await self.redis.get(f"hester:doc:{dhash}:embedding")
                if embedding_data:
                    embedding = self._deserialize_embedding(embedding_data)
                    self._doc_embeddings[dhash] = embedding

                    # Get metadata
                    meta_data = await self.redis.get(f"hester:doc:{dhash}:meta")
                    if meta_data:
                        import json
                        meta = json.loads(meta_data)
                        self._doc_meta[dhash] = meta

                    count += 1

            logger.debug(f"Loaded {count} doc embeddings from Redis")
            return count

        except Exception as e:
            logger.warning(f"Failed to load doc embeddings: {e}")
            return 0

    def _deserialize_embedding(self, data: bytes) -> np.ndarray:
        """Deserialize embedding from Redis bytes."""
        import struct
        count = len(data) // 4
        values = struct.unpack(f"{count}f", data)
        return np.array(values, dtype=np.float32)

    # =========================================================================
    # Agent Routing (Plan Node)
    # =========================================================================

    async def route_to_best_agent(
        self,
        query: str,
        threshold: float = 0.60,
    ) -> AgentMatchResult:
        """
        Find the best matching agent for a query.

        Used by Plan Node to decide DELEGATE strategy.

        Args:
            query: User query or task description
            threshold: Minimum similarity score to consider

        Returns:
            AgentMatchResult with best agent and all candidates
        """
        import time
        start_time = time.perf_counter()

        if not self._agent_embeddings:
            # Fall back to keyword matching
            best_agent, score = self._keyword_route_agent(query)
            return AgentMatchResult(
                best_agent=best_agent,
                score=score,
                all_candidates=[RouteCandidate(best_agent, score, "keyword")] if best_agent else [],
                match_time_ms=(time.perf_counter() - start_time) * 1000,
            )

        # Generate query embedding
        query_embedding = await self.embeddings.embed(query)

        # Compute similarities
        candidates = []
        for name, embedding in self._agent_embeddings.items():
            score = self.embeddings.cosine_similarity(query_embedding, embedding)
            if score >= threshold:
                agent = self._agent_meta.get(name)
                if agent:
                    candidates.append(RouteCandidate(agent, score, "semantic"))

        # Sort by score descending
        candidates.sort(key=lambda c: c.score, reverse=True)

        best_agent = candidates[0].item if candidates else None
        best_score = candidates[0].score if candidates else 0.0

        return AgentMatchResult(
            best_agent=best_agent,
            score=best_score,
            all_candidates=candidates,
            match_time_ms=(time.perf_counter() - start_time) * 1000,
        )

    def _keyword_route_agent(
        self,
        query: str,
    ) -> Tuple[Optional[DelegateRegistration], float]:
        """
        Fallback keyword-based agent routing.

        Args:
            query: User query

        Returns:
            Tuple of (best_agent, score)
        """
        query_lower = query.lower()
        best_agent = None
        best_score = 0.0

        for name, agent in self._agent_meta.items():
            # Check keyword matches
            matches = sum(1 for kw in agent.keywords if kw.lower() in query_lower)
            if matches > 0:
                score = min(0.5 + (matches * 0.1), 0.9)  # Cap at 0.9 for keyword
                if score > best_score:
                    best_score = score
                    best_agent = agent

        return best_agent, best_score

    # =========================================================================
    # Tool Routing (Prepare Node)
    # =========================================================================

    async def route_to_tools(
        self,
        query: str,
        available_tools: Optional[List[str]] = None,
        threshold: float = 0.50,
        max_tools: int = 15,
    ) -> ToolMatchResult:
        """
        Find relevant tools for a query.

        Used by Prepare Node to pre-filter tools before FunctionGemma.

        Args:
            query: User query or task description
            available_tools: Optional list of tool names to consider
            threshold: Minimum similarity score to consider
            max_tools: Maximum number of tools to return

        Returns:
            ToolMatchResult with ranked tools
        """
        import time
        start_time = time.perf_counter()

        if not self._tool_embeddings:
            # Fall back to keyword matching
            tools = self._keyword_route_tools(query, available_tools, max_tools)
            return ToolMatchResult(
                tools=tools,
                match_time_ms=(time.perf_counter() - start_time) * 1000,
            )

        # Generate query embedding
        query_embedding = await self.embeddings.embed(query)

        # Filter to available tools
        tool_embeddings = self._tool_embeddings
        if available_tools:
            tool_embeddings = {
                k: v for k, v in tool_embeddings.items()
                if k in available_tools
            }

        if not tool_embeddings:
            return ToolMatchResult(tools=[], match_time_ms=0)

        # Compute similarities
        candidates = []
        for name, embedding in tool_embeddings.items():
            score = self.embeddings.cosine_similarity(query_embedding, embedding)
            if score >= threshold:
                tool = self._tool_meta.get(name)
                if tool:
                    candidates.append(RouteCandidate(tool, score, "semantic"))

        # Sort by score descending and limit
        candidates.sort(key=lambda c: c.score, reverse=True)
        candidates = candidates[:max_tools]

        return ToolMatchResult(
            tools=candidates,
            query_embedding=query_embedding,
            match_time_ms=(time.perf_counter() - start_time) * 1000,
        )

    def _keyword_route_tools(
        self,
        query: str,
        available_tools: Optional[List[str]],
        max_tools: int,
    ) -> List[RouteCandidate]:
        """
        Fallback keyword-based tool routing.

        Args:
            query: User query
            available_tools: Optional filter
            max_tools: Max results

        Returns:
            List of RouteCandidate
        """
        query_lower = query.lower()
        candidates = []

        for name, tool in self._tool_meta.items():
            if available_tools and name not in available_tools:
                continue

            # Check keyword matches
            matches = sum(1 for kw in tool.keywords if kw.lower() in query_lower)
            if matches > 0:
                score = min(0.4 + (matches * 0.1), 0.8)  # Cap at 0.8 for keyword
                candidates.append(RouteCandidate(tool, score, "keyword"))

        candidates.sort(key=lambda c: c.score, reverse=True)
        return candidates[:max_tools]

    # =========================================================================
    # Knowledge Matching (Proactive System)
    # =========================================================================

    async def match_knowledge(
        self,
        context: str,
        bundle_threshold: float = 0.80,
        doc_threshold: float = 0.70,
        max_bundles: int = 3,
        max_docs: int = 5,
    ) -> KnowledgeMatchResult:
        """
        Match context against bundles and docs for proactive loading.

        Used by Knowledge Engine to pre-load relevant knowledge.

        Args:
            context: Current context (file, topic, conversation)
            bundle_threshold: Minimum score for bundle matches
            doc_threshold: Minimum score for doc matches
            max_bundles: Maximum bundles to return
            max_docs: Maximum docs to return

        Returns:
            KnowledgeMatchResult with matched bundles and docs
        """
        import time
        start_time = time.perf_counter()

        bundles: List[MatchedBundle] = []
        docs: List[MatchedDoc] = []
        query_embedding = None

        # Generate context embedding
        if self.embeddings.is_available:
            query_embedding = await self.embeddings.embed(context)

            # Match bundles
            if self._bundle_embeddings:
                for bid, embedding in self._bundle_embeddings.items():
                    score = self.embeddings.cosine_similarity(query_embedding, embedding)
                    if score >= bundle_threshold:
                        meta = self._bundle_meta.get(bid, {})
                        bundles.append(MatchedBundle(
                            bundle_id=bid,
                            title=meta.get("title", bid),
                            score=score,
                            tags=meta.get("tags", []),
                        ))

                bundles.sort(key=lambda b: b.score, reverse=True)
                bundles = bundles[:max_bundles]

            # Match docs
            if self._doc_embeddings:
                for dhash, embedding in self._doc_embeddings.items():
                    score = self.embeddings.cosine_similarity(query_embedding, embedding)
                    if score >= doc_threshold:
                        meta = self._doc_meta.get(dhash, {})
                        docs.append(MatchedDoc(
                            doc_hash=dhash,
                            file_path=meta.get("file_path", ""),
                            heading=meta.get("heading", ""),
                            score=score,
                        ))

                docs.sort(key=lambda d: d.score, reverse=True)
                docs = docs[:max_docs]

        return KnowledgeMatchResult(
            bundles=bundles,
            docs=docs,
            query_embedding=query_embedding,
            match_time_ms=(time.perf_counter() - start_time) * 1000,
        )

    # =========================================================================
    # Generic Matching
    # =========================================================================

    async def match(
        self,
        query: str,
        candidates: List[Any],
        get_text: callable,
        threshold: float = 0.70,
        max_results: int = 5,
    ) -> List[Tuple[Any, float]]:
        """
        Generic semantic matching for future use cases.

        Args:
            query: Query text
            candidates: List of candidate items
            get_text: Function to extract text from candidate for embedding
            threshold: Minimum similarity score
            max_results: Maximum results

        Returns:
            List of (candidate, score) tuples sorted by score descending
        """
        if not candidates or not self.embeddings.is_available:
            return []

        # Generate query embedding
        query_embedding = await self.embeddings.embed(query)

        # Generate candidate embeddings
        texts = [get_text(c) for c in candidates]
        candidate_embeddings = await self.embeddings.embed_batch(texts)

        # Compute similarities
        results = []
        for candidate, embedding in zip(candidates, candidate_embeddings):
            score = self.embeddings.cosine_similarity(query_embedding, embedding)
            if score >= threshold:
                results.append((candidate, score))

        # Sort by score descending
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:max_results]

    # =========================================================================
    # Cache Management
    # =========================================================================

    async def refresh_bundle_embeddings(self) -> int:
        """Refresh bundle embeddings from Redis."""
        self._bundle_embeddings.clear()
        self._bundle_meta.clear()
        return await self._load_bundle_embeddings()

    async def refresh_doc_embeddings(self) -> int:
        """Refresh doc embeddings from Redis."""
        self._doc_embeddings.clear()
        self._doc_meta.clear()
        return await self._load_doc_embeddings()

    def get_stats(self) -> Dict[str, Any]:
        """Get router statistics."""
        return {
            "initialized": self._initialized,
            "embedding_service_available": self.embeddings.is_available,
            "redis_available": self.redis is not None,
            "agent_count": len(self._agent_embeddings),
            "tool_count": len(self._tool_embeddings),
            "bundle_count": len(self._bundle_embeddings),
            "doc_count": len(self._doc_embeddings),
        }
