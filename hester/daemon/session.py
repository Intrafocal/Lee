"""
Hester Session Manager - Redis-backed session storage with TTL.
"""

import json
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any, TYPE_CHECKING
from pydantic import BaseModel, Field

# Redis is optional - only import if available
try:
    import redis.asyncio as redis
    REDIS_AVAILABLE = True
except ImportError:
    redis = None  # type: ignore
    REDIS_AVAILABLE = False

from .models import EditorState, FileContext

logger = logging.getLogger("hester.daemon.session")


class ConversationMessage(BaseModel):
    """A message in the conversation history."""

    role: str = Field(description="Message role: user, assistant, or system")
    content: str = Field(description="Message content")
    timestamp: datetime = Field(default_factory=datetime.now)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class HesterSession(BaseModel):
    """Persistent session state for Hester daemon."""

    session_id: str = Field(description="Unique session identifier")
    created_at: datetime = Field(default_factory=datetime.now)
    last_activity: datetime = Field(default_factory=datetime.now)

    # Conversation history
    conversation_history: List[ConversationMessage] = Field(
        default_factory=list,
        description="Full conversation history"
    )

    # Editor context
    editor_state: Optional[EditorState] = Field(
        None,
        description="Current editor state"
    )
    last_file_context: Optional[FileContext] = Field(
        None,
        description="Most recent file/selection context"
    )

    # ReAct trace history
    trace_ids: List[str] = Field(
        default_factory=list,
        description="IDs of ReAct traces for this session"
    )

    # Configuration
    working_directory: str = Field(
        default=".",
        description="Working directory for file operations"
    )
    max_history_length: int = Field(
        default=50,
        description="Maximum conversation history length"
    )

    def add_message(self, role: str, content: str, metadata: Optional[Dict] = None) -> None:
        """Add a message to conversation history, trimming if needed."""
        message = ConversationMessage(
            role=role,
            content=content,
            timestamp=datetime.now(),
            metadata=metadata or {}
        )
        self.conversation_history.append(message)

        # Trim old messages if over limit
        if len(self.conversation_history) > self.max_history_length:
            # Keep system messages and most recent messages
            system_msgs = [m for m in self.conversation_history if m.role == "system"]
            other_msgs = [m for m in self.conversation_history if m.role != "system"]

            # Keep last N-len(system) messages
            keep_count = self.max_history_length - len(system_msgs)
            self.conversation_history = system_msgs + other_msgs[-keep_count:]

        self.last_activity = datetime.now()

    def get_messages_for_llm(self) -> List[Dict[str, str]]:
        """Get conversation history in LLM-compatible format."""
        return [
            {"role": msg.role, "content": msg.content}
            for msg in self.conversation_history
        ]

    def update_editor_state(self, state: EditorState) -> None:
        """Update the editor state."""
        self.editor_state = state
        self.last_activity = datetime.now()

    def update_file_context(self, context: FileContext) -> None:
        """Update the file context."""
        self.last_file_context = context
        self.last_activity = datetime.now()


class SessionManager:
    """Manages Hester sessions with Redis persistence."""

    def __init__(
        self,
        redis_client: Any,  # redis.Redis when available
        ttl_seconds: int = 3600,
        key_prefix: str = "hester:session:"
    ):
        """
        Initialize the session manager.

        Args:
            redis_client: Async Redis client
            ttl_seconds: Session time-to-live in seconds
            key_prefix: Redis key prefix for sessions
        """
        self.redis = redis_client
        self.ttl = ttl_seconds
        self._key_prefix = key_prefix

    def _session_key(self, session_id: str) -> str:
        """Get the Redis key for a session."""
        return f"{self._key_prefix}{session_id}"

    async def get(self, session_id: str) -> Optional[HesterSession]:
        """Get a session by ID."""
        key = self._session_key(session_id)
        data = await self.redis.get(key)

        if data is None:
            return None

        try:
            session_data = json.loads(data)
            return HesterSession(**session_data)
        except (json.JSONDecodeError, ValueError) as e:
            logger.error(f"Failed to deserialize session {session_id}: {e}")
            return None

    async def create(
        self,
        session_id: str,
        working_directory: str = "."
    ) -> HesterSession:
        """Create a new session."""
        session = HesterSession(
            session_id=session_id,
            working_directory=working_directory
        )

        # Add system message
        session.add_message(
            role="system",
            content=(
                "You are Hester, the AI development daemon. "
                "You are watchful, practical, and direct. You help with code exploration "
                "and analysis. You have access to file read and search tools."
            )
        )

        await self.save(session)
        logger.info(f"Created new session: {session_id}")
        return session

    async def get_or_create(
        self,
        session_id: str,
        working_directory: str = "."
    ) -> HesterSession:
        """Get existing session or create a new one."""
        session = await self.get(session_id)

        if session is None:
            session = await self.create(session_id, working_directory)
        else:
            # Update working directory if changed
            if working_directory != session.working_directory:
                session.working_directory = working_directory
                await self.save(session)

        return session

    async def save(self, session: HesterSession) -> None:
        """Save a session to Redis."""
        key = self._session_key(session.session_id)
        session.last_activity = datetime.now()

        # Serialize with datetime handling
        data = session.model_dump_json()
        await self.redis.setex(key, self.ttl, data)

    async def delete(self, session_id: str) -> bool:
        """Delete a session."""
        key = self._session_key(session_id)
        result = await self.redis.delete(key)
        if result:
            logger.info(f"Deleted session: {session_id}")
        return result > 0

    async def refresh_ttl(self, session_id: str) -> bool:
        """Refresh the TTL for a session."""
        key = self._session_key(session_id)
        return await self.redis.expire(key, self.ttl)

    async def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict] = None
    ) -> Optional[HesterSession]:
        """Add a message to a session's conversation history."""
        session = await self.get(session_id)
        if session is None:
            return None

        session.add_message(role, content, metadata)
        await self.save(session)
        return session

    async def list_sessions(self, pattern: str = "*") -> List[str]:
        """List all session IDs matching a pattern."""
        full_pattern = f"{self._key_prefix}{pattern}"
        keys = await self.redis.keys(full_pattern)
        prefix_len = len(self._key_prefix)
        return [key.decode()[prefix_len:] for key in keys]

    async def cleanup_expired(self) -> int:
        """
        Cleanup expired sessions.

        Note: Redis handles TTL automatically, but this can be used
        for manual cleanup or debugging.
        """
        # Redis handles TTL automatically via setex
        # This method is here for potential future manual cleanup
        return 0

    async def get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get basic info about a session without loading full history."""
        session = await self.get(session_id)
        if session is None:
            return None

        return {
            "session_id": session.session_id,
            "created_at": session.created_at.isoformat(),
            "last_activity": session.last_activity.isoformat(),
            "message_count": len(session.conversation_history),
            "working_directory": session.working_directory,
            "active_file": (
                session.editor_state.active_file
                if session.editor_state else None
            ),
        }


class InMemorySessionManager:
    """
    In-memory session manager for TUI mode without Redis dependency.

    Same interface as SessionManager but stores sessions in a dict.
    Useful for single-user TUI sessions that don't need persistence.
    """

    def __init__(self, ttl_seconds: int = 3600):
        """
        Initialize the in-memory session manager.

        Args:
            ttl_seconds: Session time-to-live (not enforced, just for compatibility)
        """
        self._sessions: Dict[str, HesterSession] = {}
        self.ttl = ttl_seconds

    async def get(self, session_id: str) -> Optional[HesterSession]:
        """Get a session by ID."""
        return self._sessions.get(session_id)

    async def create(
        self,
        session_id: str,
        working_directory: str = "."
    ) -> HesterSession:
        """Create a new session."""
        session = HesterSession(
            session_id=session_id,
            working_directory=working_directory
        )

        # Add system message
        session.add_message(
            role="system",
            content=(
                "You are Hester, the AI development daemon. "
                "You are watchful, practical, and direct. You help with code exploration "
                "and analysis. You have access to file read and search tools."
            )
        )

        self._sessions[session_id] = session
        logger.info(f"Created new in-memory session: {session_id}")
        return session

    async def get_or_create(
        self,
        session_id: str,
        working_directory: str = "."
    ) -> HesterSession:
        """Get existing session or create a new one."""
        session = await self.get(session_id)

        if session is None:
            session = await self.create(session_id, working_directory)
        else:
            # Update working directory if changed
            if working_directory != session.working_directory:
                session.working_directory = working_directory

        return session

    async def save(self, session: HesterSession) -> None:
        """Save a session (just updates the dict)."""
        session.last_activity = datetime.now()
        self._sessions[session.session_id] = session

    async def delete(self, session_id: str) -> bool:
        """Delete a session."""
        if session_id in self._sessions:
            del self._sessions[session_id]
            logger.info(f"Deleted in-memory session: {session_id}")
            return True
        return False

    async def refresh_ttl(self, session_id: str) -> bool:
        """Refresh the TTL for a session (no-op for in-memory)."""
        return session_id in self._sessions

    async def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict] = None
    ) -> Optional[HesterSession]:
        """Add a message to a session's conversation history."""
        session = await self.get(session_id)
        if session is None:
            return None

        session.add_message(role, content, metadata)
        return session

    async def list_sessions(self, pattern: str = "*") -> List[str]:
        """List all session IDs."""
        # Simple pattern matching (just * for now)
        if pattern == "*":
            return list(self._sessions.keys())
        return [k for k in self._sessions.keys() if pattern in k]

    async def cleanup_expired(self) -> int:
        """Cleanup expired sessions (no-op for in-memory)."""
        return 0

    async def get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get basic info about a session."""
        session = await self.get(session_id)
        if session is None:
            return None

        return {
            "session_id": session.session_id,
            "created_at": session.created_at.isoformat(),
            "last_activity": session.last_activity.isoformat(),
            "message_count": len(session.conversation_history),
            "working_directory": session.working_directory,
            "active_file": (
                session.editor_state.active_file
                if session.editor_state else None
            ),
        }
