"""
TUI data models - chat messages, images, and state.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from ...shared.gemini_tools import PhaseUpdate, ReActPhase


@dataclass
class ChatMessage:
    """A message in the chat history."""
    role: str  # "user", "hester", "tool", "error"
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    tool_name: Optional[str] = None
    tool_result: Optional[Dict[str, Any]] = None
    is_streaming: bool = False


@dataclass
class PendingImage:
    """An image waiting to be sent with the next message."""
    data: bytes
    mime_type: str = "image/png"
    source: str = "clipboard"  # clipboard, file
    width: Optional[int] = None
    height: Optional[int] = None


@dataclass
class TUIChatState:
    """State for the TUI chat interface."""
    session_id: str = ""
    working_directory: str = ""
    messages: List[ChatMessage] = field(default_factory=list)
    is_thinking: bool = False
    current_tool: Optional[str] = None
    tool_context: Optional[str] = None  # e.g., file path, table name
    status: str = "ready"  # ready, thinking, acting, observing, responding, error
    error_message: Optional[str] = None
    tools_used: List[str] = field(default_factory=list)
    # Thinking depth tracking
    thinking_depth: Optional[str] = None  # QUICK, STANDARD, DEEP, REASONING
    model_used: Optional[str] = None
    # Token tracking
    total_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # Hybrid routing tracking
    is_local: bool = False  # Whether current phase uses local model
    has_phase_info: bool = False  # Whether we've received any phase updates (don't show LOCAL/CLOUD until we have info)
    precision: Optional[str] = None  # "e2b", "e4b", "full"
    cloud_calls_remaining: Optional[int] = None
    local_calls_remaining: Optional[int] = None
    # Semantic routing tracking (bespoke agent selection)
    prompt_id: Optional[str] = None  # Selected prompt (e.g., "code_analysis", "database")
    agent_id: Optional[str] = None  # Matched pre-bundled agent (e.g., "db_explorer")
    routing_reason: Optional[str] = None  # Why this routing was chosen
    # Pending images (from clipboard paste)
    pending_images: List[PendingImage] = field(default_factory=list)

    def update_from_phase(self, phase_update: PhaseUpdate) -> None:
        """Update state from a ReAct phase update."""
        # Map ReActPhase to status string
        phase_map = {
            ReActPhase.PREPARE: "preparing",
            ReActPhase.THINK: "thinking",
            ReActPhase.ACT: "acting",
            ReActPhase.OBSERVE: "observing",
            ReActPhase.RESPOND: "responding",
        }
        self.status = phase_map.get(phase_update.phase, "ready")
        self.current_tool = phase_update.tool_name
        self.tool_context = phase_update.tool_context

        # Update model if provided (keeps display in sync during execution)
        if phase_update.model_used:
            self.model_used = phase_update.model_used

        # Update hybrid routing info
        self.has_phase_info = True  # We now have phase info, can show LOCAL/CLOUD
        self.is_local = phase_update.is_local
        self.precision = phase_update.precision
        self.cloud_calls_remaining = phase_update.cloud_calls_remaining
        self.local_calls_remaining = phase_update.local_calls_remaining

        # Update semantic routing info (from PREPARE phase)
        if phase_update.prompt_id:
            self.prompt_id = phase_update.prompt_id
        if phase_update.agent_id:
            self.agent_id = phase_update.agent_id
        if phase_update.routing_reason:
            self.routing_reason = phase_update.routing_reason

        # Track tools used
        if phase_update.tool_name and phase_update.tool_name not in self.tools_used:
            self.tools_used.append(phase_update.tool_name)
