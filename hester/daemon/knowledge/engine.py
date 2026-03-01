"""
KnowledgeEngine - Main orchestrator for proactive knowledge management.

Watches Lee context and conversation to:
- Pre-load relevant knowledge based on current file/topic
- Detect documentation gaps
- Suggest documentation for new code
- Push status notifications to Lee

Debounce Configuration:
- file_open: 500ms
- tab_switch: 300ms
- conversation: 2000ms
- idle_check: 30000ms (30s)
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    import redis.asyncio as redis
    from ..lee_client import LeeContextClient, LeeContext

from .store import KnowledgeStore
from .buffer import WarmContextBuffer, WarmContext
from ..semantic.router import SemanticRouter

logger = logging.getLogger("hester.daemon.knowledge.engine")


# Debounce configuration (milliseconds)
DEBOUNCE_CONFIG = {
    "file_open": 500,
    "tab_switch": 300,
    "conversation": 2000,
    "idle_check": 30000,  # 30s
}

# Knowledge matching thresholds
DEFAULT_BUNDLE_THRESHOLD = 0.80
DEFAULT_DOC_THRESHOLD = 0.70
DEFAULT_MAX_BUNDLES = 3
DEFAULT_MAX_DOCS = 5


@dataclass
class KnowledgeMetrics:
    """Metrics for knowledge engine operations."""

    context_updates: int = 0
    matches_found: int = 0
    bundles_loaded: int = 0
    docs_loaded: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    doc_suggestions: int = 0
    commit_suggestions: int = 0


class KnowledgeEngine:
    """
    Main orchestrator for proactive knowledge management.

    Watches Lee context and conversation to pre-load relevant knowledge
    before the user asks questions. Uses SemanticRouter for matching
    and WarmContextBuffer for storage.

    Usage:
        engine = KnowledgeEngine(
            store=knowledge_store,
            router=semantic_router,
            buffer=warm_buffer,
            lee_client=lee_client,
            working_dir=Path("/workspace"),
        )

        # Start the engine
        await engine.start(session_id)

        # Engine automatically watches Lee context
        # Access warm context for prompt injection
        warm = await engine.buffer.get(session_id)

        # Process conversation messages
        await engine.on_conversation_message(message)

        # Stop engine
        await engine.stop()
    """

    def __init__(
        self,
        store: KnowledgeStore,
        router: SemanticRouter,
        buffer: WarmContextBuffer,
        lee_client: Optional["LeeContextClient"] = None,
        redis_client: Optional["redis.Redis"] = None,
        working_dir: Optional[Path] = None,
        # Thresholds
        bundle_threshold: float = DEFAULT_BUNDLE_THRESHOLD,
        doc_threshold: float = DEFAULT_DOC_THRESHOLD,
        max_bundles: int = DEFAULT_MAX_BUNDLES,
        max_docs: int = DEFAULT_MAX_DOCS,
    ):
        """
        Initialize the knowledge engine.

        Args:
            store: KnowledgeStore for bundle/doc access
            router: SemanticRouter for matching
            buffer: WarmContextBuffer for session context
            lee_client: Optional LeeContextClient for editor context
            redis_client: Optional Redis client
            working_dir: Working directory
            bundle_threshold: Minimum score for bundle matches
            doc_threshold: Minimum score for doc matches
            max_bundles: Maximum bundles to load
            max_docs: Maximum docs to load
        """
        self.store = store
        self.router = router
        self.buffer = buffer
        self.lee_client = lee_client
        self._redis = redis_client
        self._working_dir = Path(working_dir) if working_dir else Path.cwd()

        # Thresholds
        self._bundle_threshold = bundle_threshold
        self._doc_threshold = doc_threshold
        self._max_bundles = max_bundles
        self._max_docs = max_docs

        # State
        self._session_id: Optional[str] = None
        self._running = False
        self._last_context: Optional["LeeContext"] = None
        self._last_trigger: Optional[str] = None
        self._debounce_task: Optional[asyncio.Task] = None
        self._idle_task: Optional[asyncio.Task] = None
        self._redis_warning_shown = False

        # Metrics
        self.metrics = KnowledgeMetrics()

    @property
    def is_available(self) -> bool:
        """Check if engine is available (store and router ready)."""
        return self.store.is_available and self.router.is_available

    async def start(self, session_id: str) -> None:
        """
        Start the knowledge engine for a session.

        Args:
            session_id: Session identifier
        """
        if self._running:
            logger.warning("Knowledge engine already running")
            return

        self._session_id = session_id
        self._running = True
        self._redis_warning_shown = False

        # Start idle check task
        self._idle_task = asyncio.create_task(self._idle_check_loop())

        logger.info(f"Knowledge engine started for session {session_id}")

    async def stop(self) -> None:
        """Stop the knowledge engine."""
        self._running = False

        # Cancel tasks
        if self._debounce_task:
            self._debounce_task.cancel()
            self._debounce_task = None

        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None

        logger.info("Knowledge engine stopped")

    async def on_lee_context(self, context: "LeeContext") -> None:
        """
        Handle Lee context update.

        Called when editor context changes (file open, tab switch, etc.).
        Debounces context processing to avoid excessive matching.

        Args:
            context: Updated LeeContext from Lee editor
        """
        if not self._running or not self._session_id:
            return

        # Check if Redis is available
        if not self.buffer.is_available:
            if not self._redis_warning_shown:
                logger.warning("Warm context buffer unavailable (Redis not connected)")
                await self._push_status(
                    "Warm context disabled - Redis unavailable",
                    "warning",
                    ttl=90,
                )
                self._redis_warning_shown = True
            return

        # Determine trigger type and debounce delay
        trigger, delay_ms = self._classify_context_change(context)

        if not trigger:
            return

        # Cancel existing debounce task
        if self._debounce_task:
            self._debounce_task.cancel()

        # Start new debounce task
        self._debounce_task = asyncio.create_task(
            self._process_context_debounced(context, trigger, delay_ms)
        )

        self._last_context = context

    async def on_conversation_message(self, message: str) -> None:
        """
        Handle conversation message.

        Called when user sends a message. Uses longer debounce
        to avoid interrupting conversation flow.

        Args:
            message: User message
        """
        if not self._running or not self._session_id:
            return

        if not self.buffer.is_available:
            return  # Silently skip if Redis unavailable

        # Cancel existing debounce task
        if self._debounce_task:
            self._debounce_task.cancel()

        # Debounce conversation matching
        delay_ms = DEBOUNCE_CONFIG["conversation"]
        self._debounce_task = asyncio.create_task(
            self._process_conversation_debounced(message, delay_ms)
        )

    def _classify_context_change(
        self,
        context: "LeeContext",
    ) -> tuple[Optional[str], int]:
        """
        Classify context change type and get appropriate debounce delay.

        Args:
            context: New Lee context

        Returns:
            Tuple of (trigger_string, debounce_delay_ms) or (None, 0) if no change
        """
        # Check for file change
        if hasattr(context, "editor") and context.editor:
            current_file = getattr(context.editor, "file_path", None)
            if current_file:
                last_file = None
                if self._last_context and hasattr(self._last_context, "editor"):
                    last_file = getattr(self._last_context.editor, "file_path", None)

                if current_file != last_file:
                    return f"file:{current_file}", DEBOUNCE_CONFIG["file_open"]

        # Check for tab switch
        if hasattr(context, "focused_panel"):
            last_panel = None
            if self._last_context:
                last_panel = getattr(self._last_context, "focused_panel", None)

            if context.focused_panel != last_panel:
                return f"panel:{context.focused_panel}", DEBOUNCE_CONFIG["tab_switch"]

        return None, 0

    async def _process_context_debounced(
        self,
        context: "LeeContext",
        trigger: str,
        delay_ms: int,
    ) -> None:
        """
        Process context after debounce delay.

        Args:
            context: Lee context
            trigger: What triggered this update
            delay_ms: Debounce delay
        """
        try:
            await asyncio.sleep(delay_ms / 1000)
        except asyncio.CancelledError:
            return

        if not self._running or not self._session_id:
            return

        self.metrics.context_updates += 1

        # Build context string for matching
        context_text = self._build_match_context(context)
        if not context_text:
            return

        # Check if same as last trigger (avoid duplicate loads)
        if trigger == self._last_trigger:
            self.metrics.cache_hits += 1
            return

        self._last_trigger = trigger

        # Match knowledge
        try:
            match_result = await self.router.match_knowledge(
                context=context_text,
                bundle_threshold=self._bundle_threshold,
                doc_threshold=self._doc_threshold,
                max_bundles=self._max_bundles,
                max_docs=self._max_docs,
            )

            if match_result.bundles or match_result.docs:
                self.metrics.matches_found += 1
                self.metrics.bundles_loaded += len(match_result.bundles)
                self.metrics.docs_loaded += len(match_result.docs)

                # Update warm context
                warm = await self.buffer.update(
                    session_id=self._session_id,
                    match_result=match_result,
                    trigger=trigger,
                    store=self.store,
                )

                if warm:
                    # Push status notification
                    bundle_names = [b.title for b in warm.bundles]
                    if bundle_names:
                        await self._push_status(
                            f"Loaded: {', '.join(bundle_names[:3])}",
                            "info",
                            ttl=15,
                        )
            else:
                self.metrics.cache_misses += 1

        except Exception as e:
            logger.warning(f"Knowledge matching failed: {e}")

    async def _process_conversation_debounced(
        self,
        message: str,
        delay_ms: int,
    ) -> None:
        """
        Process conversation message after debounce delay.

        Args:
            message: User message
            delay_ms: Debounce delay
        """
        try:
            await asyncio.sleep(delay_ms / 1000)
        except asyncio.CancelledError:
            return

        if not self._running or not self._session_id:
            return

        # Match knowledge based on conversation
        try:
            match_result = await self.router.match_knowledge(
                context=message,
                bundle_threshold=self._bundle_threshold,
                doc_threshold=self._doc_threshold,
                max_bundles=self._max_bundles,
                max_docs=self._max_docs,
            )

            if match_result.bundles or match_result.docs:
                # Update warm context
                await self.buffer.update(
                    session_id=self._session_id,
                    match_result=match_result,
                    trigger=f"message:{message[:50]}",
                    store=self.store,
                )

        except Exception as e:
            logger.debug(f"Conversation matching failed: {e}")

    async def _idle_check_loop(self) -> None:
        """
        Background loop checking for idle time suggestions.

        Runs every 30s and suggests documentation for undocumented files.
        """
        while self._running:
            try:
                await asyncio.sleep(DEBOUNCE_CONFIG["idle_check"] / 1000)
            except asyncio.CancelledError:
                return

            if not self._running or not self._session_id:
                return

            await self._check_doc_gap()

    async def _check_doc_gap(self) -> None:
        """
        Check if current file has documentation.

        If the current file is undocumented and user has been idle,
        suggest creating documentation.
        """
        if not self._last_context:
            return

        # Get current file
        current_file = None
        if hasattr(self._last_context, "editor") and self._last_context.editor:
            current_file = getattr(self._last_context.editor, "file_path", None)

        if not current_file:
            return

        # Check if file is documented
        indexed_files = await self.store.get_indexed_files()
        file_name = Path(current_file).name

        # Simple check: is there any doc mentioning this file?
        has_doc = any(file_name in f for f in indexed_files)

        if not has_doc:
            # Check idle time
            idle_seconds = 0
            if hasattr(self._last_context, "activity"):
                idle_seconds = getattr(self._last_context.activity, "idle_seconds", 0)

            if idle_seconds >= 30:  # Only suggest after 30s idle
                self.metrics.doc_suggestions += 1
                await self._push_status(
                    f"No docs for {file_name}. Create?",
                    "hint",
                    prompt=f"document {current_file}",
                    ttl=90,
                )

    def _build_match_context(self, context: "LeeContext") -> str:
        """
        Build context string for semantic matching.

        Combines current file, language, selection, and open tabs.

        Args:
            context: Lee context

        Returns:
            Context string for embedding
        """
        parts = []

        # Current file
        if hasattr(context, "editor") and context.editor:
            editor = context.editor
            if hasattr(editor, "file_path") and editor.file_path:
                parts.append(f"Current file: {editor.file_path}")

            if hasattr(editor, "language") and editor.language:
                parts.append(f"Language: {editor.language}")

            if hasattr(editor, "selection") and editor.selection:
                parts.append(f"Selected: {editor.selection[:500]}")

        # Open tabs
        if hasattr(context, "tabs") and context.tabs:
            tab_names = []
            for tab in context.tabs[:5]:  # Limit to 5 tabs
                name = getattr(tab, "name", None) or getattr(tab, "title", None)
                if name:
                    tab_names.append(name)
            if tab_names:
                parts.append(f"Open: {', '.join(tab_names)}")

        return " ".join(parts)

    async def _push_status(
        self,
        message: str,
        message_type: str = "info",
        prompt: Optional[str] = None,
        ttl: Optional[int] = None,
    ) -> None:
        """
        Push status notification to Lee.

        Uses push_status_message from ui_control.py.

        Args:
            message: Status message
            message_type: Message type (hint, info, success, warning)
            prompt: Optional prompt for action
            ttl: Optional TTL in seconds
        """
        try:
            from ..tools.ui_control import push_status_message

            await push_status_message(
                message=message,
                message_type=message_type,
                prompt=prompt,
                ttl=ttl,
            )
        except Exception as e:
            logger.debug(f"Failed to push status: {e}")

    def get_metrics(self) -> Dict[str, Any]:
        """Get engine metrics."""
        return {
            "context_updates": self.metrics.context_updates,
            "matches_found": self.metrics.matches_found,
            "bundles_loaded": self.metrics.bundles_loaded,
            "docs_loaded": self.metrics.docs_loaded,
            "cache_hits": self.metrics.cache_hits,
            "cache_misses": self.metrics.cache_misses,
            "doc_suggestions": self.metrics.doc_suggestions,
            "commit_suggestions": self.metrics.commit_suggestions,
        }
