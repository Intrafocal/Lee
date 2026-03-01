"""
WarmContextBuffer - Per-session pre-loaded context with token budget management.

Stores warm context in Redis with:
- Token budget management (8000 tokens max)
- 1-hour TTL for session-specific data
- Graceful degradation (no in-memory fallback)

When Redis is unavailable:
- is_available returns False
- update() and get() return None
- Knowledge Engine logs warning and skips proactive loading
- Agent proceeds in normal reactive mode
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    import redis.asyncio as redis

logger = logging.getLogger("hester.daemon.knowledge.buffer")

# Redis key prefix and TTL
WARM_CONTEXT_PREFIX = "hester:session:"
WARM_CONTEXT_TTL = 3600  # 1 hour

# Token budget
MAX_WARM_TOKENS = 8000
CHARS_PER_TOKEN = 4  # Approximate


@dataclass
class LoadedBundle:
    """A bundle loaded into warm context."""

    bundle_id: str
    title: str
    content: str
    score: float
    token_estimate: int = 0


@dataclass
class LoadedDocChunk:
    """A doc chunk loaded into warm context."""

    doc_hash: str
    file_path: str
    heading: str
    chunk_text: str
    score: float
    token_estimate: int = 0


@dataclass
class WarmContext:
    """
    Pre-loaded context for a session.

    Contains bundles and docs that were semantically matched
    to the current editor context.
    """

    bundles: List[LoadedBundle] = field(default_factory=list)
    docs: List[LoadedDocChunk] = field(default_factory=list)
    trigger: str = ""  # What triggered this load (e.g., "file:auth.py")
    updated: datetime = field(default_factory=datetime.utcnow)

    def to_prompt_section(self) -> str:
        """
        Format warm context as a prompt section for injection.

        Returns:
            Formatted string for system prompt
        """
        sections = []

        if self.bundles:
            sections.append("## Pre-loaded Context Bundles\n")
            for bundle in self.bundles:
                sections.append(f"### {bundle.title}")
                sections.append(bundle.content)
                sections.append("")

        if self.docs:
            sections.append("## Relevant Documentation\n")
            for doc in self.docs:
                if doc.heading:
                    sections.append(f"### {doc.file_path} - {doc.heading}")
                else:
                    sections.append(f"### {doc.file_path}")
                sections.append(doc.chunk_text)
                sections.append("")

        return "\n".join(sections) if sections else ""

    @property
    def token_estimate(self) -> int:
        """Estimate total tokens in warm context."""
        bundle_tokens = sum(b.token_estimate for b in self.bundles)
        doc_tokens = sum(d.token_estimate for d in self.docs)
        return bundle_tokens + doc_tokens

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to dict for Redis storage."""
        return {
            "bundles": [
                {
                    "bundle_id": b.bundle_id,
                    "title": b.title,
                    "content": b.content,
                    "score": b.score,
                    "token_estimate": b.token_estimate,
                }
                for b in self.bundles
            ],
            "docs": [
                {
                    "doc_hash": d.doc_hash,
                    "file_path": d.file_path,
                    "heading": d.heading,
                    "chunk_text": d.chunk_text,
                    "score": d.score,
                    "token_estimate": d.token_estimate,
                }
                for d in self.docs
            ],
            "trigger": self.trigger,
            "updated": self.updated.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WarmContext":
        """Deserialize from dict."""
        return cls(
            bundles=[
                LoadedBundle(
                    bundle_id=b["bundle_id"],
                    title=b["title"],
                    content=b["content"],
                    score=b["score"],
                    token_estimate=b.get("token_estimate", 0),
                )
                for b in data.get("bundles", [])
            ],
            docs=[
                LoadedDocChunk(
                    doc_hash=d["doc_hash"],
                    file_path=d["file_path"],
                    heading=d["heading"],
                    chunk_text=d["chunk_text"],
                    score=d["score"],
                    token_estimate=d.get("token_estimate", 0),
                )
                for d in data.get("docs", [])
            ],
            trigger=data.get("trigger", ""),
            updated=datetime.fromisoformat(data["updated"]) if "updated" in data else datetime.utcnow(),
        )


class WarmContextBuffer:
    """
    Per-session warm context buffer with Redis storage.

    Manages pre-loaded context for each session, respecting token budget
    and providing graceful degradation when Redis is unavailable.

    Usage:
        buffer = WarmContextBuffer(redis_client)

        # Check availability
        if buffer.is_available:
            # Update warm context from match results
            warm = await buffer.update(session_id, match_result, "file:auth.py")

            # Get warm context for prompt injection
            warm = await buffer.get(session_id)
            if warm:
                system_prompt += warm.to_prompt_section()
        else:
            # Redis unavailable - proceed without warm context
            pass
    """

    MAX_TOKENS = MAX_WARM_TOKENS

    def __init__(self, redis_client: Optional["redis.Redis"]):
        """
        Initialize the buffer.

        Args:
            redis_client: Redis client (None = buffer unavailable)
        """
        self._redis = redis_client
        self._redis_available = redis_client is not None

    @property
    def is_available(self) -> bool:
        """Check if warm context buffer is available (Redis connected)."""
        return self._redis_available

    async def update(
        self,
        session_id: str,
        match_result: "KnowledgeMatchResult",
        trigger: str,
        store: Optional["KnowledgeStore"] = None,
    ) -> Optional[WarmContext]:
        """
        Update warm context for a session from match results.

        Loads bundle and doc content from KnowledgeStore, respecting token budget.

        Args:
            session_id: Session identifier
            match_result: Results from SemanticRouter.match_knowledge()
            trigger: What triggered this update (e.g., "file:auth.py")
            store: KnowledgeStore for loading content

        Returns:
            WarmContext if successful, None if Redis unavailable
        """
        if not self._redis_available or not self._redis:
            return None

        from ..semantic.router import KnowledgeMatchResult

        bundles: List[LoadedBundle] = []
        docs: List[LoadedDocChunk] = []
        total_tokens = 0

        # Load bundles (highest scores first)
        for matched_bundle in match_result.bundles:
            if total_tokens >= self.MAX_TOKENS:
                break

            content = ""
            if store:
                content = await store.get_bundle_content(matched_bundle.bundle_id) or ""

            if not content:
                continue

            # Estimate tokens and check budget
            token_estimate = len(content) // CHARS_PER_TOKEN
            if total_tokens + token_estimate > self.MAX_TOKENS:
                # Truncate content to fit
                available_tokens = self.MAX_TOKENS - total_tokens
                available_chars = available_tokens * CHARS_PER_TOKEN
                content = content[:available_chars] + "\n...[truncated]..."
                token_estimate = available_tokens

            bundles.append(LoadedBundle(
                bundle_id=matched_bundle.bundle_id,
                title=matched_bundle.title,
                content=content,
                score=matched_bundle.score,
                token_estimate=token_estimate,
            ))
            total_tokens += token_estimate

        # Load docs (highest scores first)
        for matched_doc in match_result.docs:
            if total_tokens >= self.MAX_TOKENS:
                break

            chunk_text = ""
            if store:
                chunk_text = await store.get_doc_chunk(matched_doc.doc_hash) or ""

            if not chunk_text:
                continue

            # Estimate tokens and check budget
            token_estimate = len(chunk_text) // CHARS_PER_TOKEN
            if total_tokens + token_estimate > self.MAX_TOKENS:
                # Truncate chunk to fit
                available_tokens = self.MAX_TOKENS - total_tokens
                available_chars = available_tokens * CHARS_PER_TOKEN
                chunk_text = chunk_text[:available_chars] + "\n...[truncated]..."
                token_estimate = available_tokens

            docs.append(LoadedDocChunk(
                doc_hash=matched_doc.doc_hash,
                file_path=matched_doc.file_path,
                heading=matched_doc.heading,
                chunk_text=chunk_text,
                score=matched_doc.score,
                token_estimate=token_estimate,
            ))
            total_tokens += token_estimate

        # Create warm context
        warm_context = WarmContext(
            bundles=bundles,
            docs=docs,
            trigger=trigger,
            updated=datetime.utcnow(),
        )

        # Store in Redis
        try:
            key = f"{WARM_CONTEXT_PREFIX}{session_id}:warm"
            await self._redis.setex(
                key,
                WARM_CONTEXT_TTL,
                json.dumps(warm_context.to_dict()),
            )
            logger.debug(
                f"Updated warm context for session {session_id}: "
                f"{len(bundles)} bundles, {len(docs)} docs, {total_tokens} tokens"
            )
        except Exception as e:
            logger.warning(f"Failed to store warm context: {e}")
            return None

        return warm_context

    async def get(self, session_id: str) -> Optional[WarmContext]:
        """
        Get warm context for a session.

        Args:
            session_id: Session identifier

        Returns:
            WarmContext if available, None if not found or Redis unavailable
        """
        if not self._redis_available or not self._redis:
            return None

        try:
            key = f"{WARM_CONTEXT_PREFIX}{session_id}:warm"
            data = await self._redis.get(key)
            if data:
                data_str = data.decode() if isinstance(data, bytes) else data
                return WarmContext.from_dict(json.loads(data_str))
        except Exception as e:
            logger.debug(f"Failed to get warm context: {e}")

        return None

    async def clear(self, session_id: str) -> None:
        """
        Clear warm context for a session.

        Args:
            session_id: Session identifier
        """
        if not self._redis_available or not self._redis:
            return

        try:
            key = f"{WARM_CONTEXT_PREFIX}{session_id}:warm"
            await self._redis.delete(key)
        except Exception as e:
            logger.debug(f"Failed to clear warm context: {e}")

    async def get_stats(self, session_id: str) -> Dict[str, Any]:
        """
        Get statistics for session's warm context.

        Args:
            session_id: Session identifier

        Returns:
            Dict with context stats
        """
        warm = await self.get(session_id)
        if not warm:
            return {
                "available": self._redis_available,
                "has_context": False,
                "bundle_count": 0,
                "doc_count": 0,
                "token_estimate": 0,
            }

        return {
            "available": self._redis_available,
            "has_context": True,
            "bundle_count": len(warm.bundles),
            "doc_count": len(warm.docs),
            "token_estimate": warm.token_estimate,
            "trigger": warm.trigger,
            "updated": warm.updated.isoformat(),
        }
