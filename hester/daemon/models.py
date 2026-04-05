"""
Hester Daemon Models - Pydantic models for request/response handling.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, ConfigDict, field_validator
from enum import Enum


def to_camel_case(name: str) -> str:
    """Convert snake_case to camelCase for JSON aliases."""
    components = name.split('_')
    return components[0] + ''.join(x.title() for x in components[1:])


class EditorState(BaseModel):
    """Current state of the Lee editor."""

    open_files: List[str] = Field(
        default_factory=list,
        description="List of currently open file paths"
    )
    active_file: Optional[str] = Field(
        None,
        description="Currently active/focused file path"
    )
    cursor_line: Optional[int] = Field(
        None,
        description="Current cursor line (1-indexed)"
    )
    cursor_column: Optional[int] = Field(
        None,
        description="Current cursor column (1-indexed)"
    )
    working_directory: str = Field(
        description="Current working directory"
    )


class FileContext(BaseModel):
    """Context about a specific file or selection."""

    file_path: str = Field(description="Absolute path to the file")
    line_start: int = Field(description="Start line of selection (1-indexed)")
    line_end: int = Field(description="End line of selection (1-indexed)")
    content: str = Field(description="Selected text content")
    language: Optional[str] = Field(
        None,
        description="Detected language (e.g., 'python', 'typescript')"
    )
    timestamp: datetime = Field(default_factory=datetime.now)


class ImageData(BaseModel):
    """Image data for multimodal requests."""

    data: bytes = Field(description="Raw image bytes")
    mime_type: str = Field(default="image/png", description="MIME type of the image")
    source: str = Field(default="clipboard", description="Source of the image (clipboard, file, etc.)")

    model_config = ConfigDict(
        # Allow bytes in JSON serialization
        json_encoders={bytes: lambda v: v.hex()},
    )

    @field_validator("data", mode="before")
    @classmethod
    def decode_base64_data(cls, v):
        """Decode base64-encoded data from JSON requests."""
        import base64

        if isinstance(v, str):
            # Assume base64-encoded string from JSON
            return base64.b64decode(v)
        return v


class ContextRequest(BaseModel):
    """Request payload from Lee editor to Hester daemon."""

    session_id: str = Field(description="Unique session identifier")
    source: Literal["Lee", "Slack", "CLI"] = Field(default="Lee", description="Source application")

    # File context (optional - for code selection)
    file: Optional[str] = Field(None, description="Absolute file path")
    line_start: Optional[int] = Field(None, description="Selection start line (1-indexed)")
    line_end: Optional[int] = Field(None, description="Selection end line (1-indexed)")
    content: Optional[str] = Field(None, description="Selected code/text content")
    language: Optional[str] = Field(None, description="File language")

    # User message (optional - for direct questions)
    message: Optional[str] = Field(None, description="User message or question")

    # Image data (optional - for multimodal queries)
    images: Optional[List[ImageData]] = Field(
        None,
        description="Images to include in the query (e.g., from clipboard paste)"
    )

    # Editor state (optional - for full context)
    editor_state: Optional[EditorState] = Field(
        None,
        description="Current state of the editor"
    )


class CommandType(str, Enum):
    """Types of commands Hester can send to Lee."""

    OPEN_FILE = "open_file"
    SCROLL_TO = "scroll_to"
    HIGHLIGHT = "highlight"
    INSERT_TEXT = "insert_text"
    SHOW_MESSAGE = "show_message"


class EditorCommand(BaseModel):
    """Command for Lee editor to execute."""

    command_type: CommandType = Field(description="Type of command")
    file: Optional[str] = Field(None, description="Target file path")
    line: Optional[int] = Field(None, description="Target line number")
    column: Optional[int] = Field(None, description="Target column number")
    end_line: Optional[int] = Field(None, description="End line for ranges")
    end_column: Optional[int] = Field(None, description="End column for ranges")
    content: Optional[str] = Field(None, description="Text content")
    style: Optional[str] = Field(
        None,
        description="Style for highlighting (info, warning, error)"
    )


class ContinueRequest(BaseModel):
    """Request to continue processing after max_iterations."""

    session_id: str = Field(description="Session identifier")
    new_depth: str = Field(description="New thinking depth: STANDARD, DEEP, or REASONING")


class ContextResponse(BaseModel):
    """Response from Hester daemon to Lee editor."""

    session_id: str = Field(description="Session identifier")
    status: Literal["received", "processing", "complete", "error", "max_iterations"] = Field(
        default="complete",
        description="Processing status"
    )
    current_depth: Optional[str] = Field(
        None,
        description="Current thinking depth (when status is max_iterations)"
    )

    # Response content
    response: Optional[str] = Field(
        None,
        description="Hester's response text"
    )

    # Commands for the editor to execute
    commands: Optional[List[EditorCommand]] = Field(
        default=None,
        description="Commands for Lee to execute"
    )

    # Metadata
    trace_id: Optional[str] = Field(
        None,
        description="ReAct trace ID for debugging"
    )
    trace: Optional["ReActTrace"] = Field(
        None,
        description="Full ReAct trace for debugging"
    )
    thinking: Optional[str] = Field(
        None,
        description="Hester's thinking process (for verbose mode)"
    )
    tools_used: List[str] = Field(
        default_factory=list,
        description="Tools used during reasoning"
    )

    # Error handling
    error_message: Optional[str] = Field(
        None,
        description="Error message if status is 'error'"
    )


class SessionInfo(BaseModel):
    """Information about a Hester session."""

    session_id: str
    created_at: datetime
    last_activity: datetime
    message_count: int = Field(default=0)
    working_directory: str
    active_file: Optional[str] = None


class HealthResponse(BaseModel):
    """Health check response."""

    status: Literal["healthy", "degraded", "unhealthy"] = "healthy"
    service: str = "hester-daemon"
    version: str = "0.1.0"
    redis_connected: bool = False
    gemini_configured: bool = False
    uptime_seconds: Optional[float] = None


# ReAct-specific models

class ThinkingDepth(str, Enum):
    """Depth of thinking for ReAct."""

    QUICK = "quick"          # Simple queries
    STANDARD = "standard"    # Normal processing
    DEEP = "deep"           # Complex reasoning


class PlannedAction(BaseModel):
    """A planned action in the ReAct loop."""

    step: int = Field(description="Step number in the sequence")
    tool_name: str = Field(description="Name of the tool to use")
    tool_input: Dict[str, Any] = Field(
        default_factory=dict,
        description="Input parameters for the tool"
    )
    rationale: str = Field(description="Why this action is needed")


class Thought(BaseModel):
    """Result of the THINK phase in ReAct."""

    step: int = Field(description="Step number in the sequence")
    reasoning: str = Field(description="Reasoning process")
    conclusion: str = Field(description="Conclusion from reasoning")


class Observation(BaseModel):
    """Result of the OBSERVE phase in ReAct."""

    step: int = Field(description="Step number in the sequence")
    tool_name: str = Field(description="Tool that was executed")
    result: Any = Field(
        default=None,
        description="Result from the tool"
    )
    interpretation: Optional[str] = Field(None, description="Interpretation of the result")

    @property
    def success(self) -> bool:
        """Check if the observation indicates success."""
        if isinstance(self.result, dict):
            return not self.result.get("error")
        return True

    @property
    def error(self) -> Optional[str]:
        """Get error message if present."""
        if isinstance(self.result, dict):
            return self.result.get("error")
        return None


class ReActTrace(BaseModel):
    """Full trace of a ReAct execution."""

    trace_id: str = Field(description="Unique trace identifier")
    session_id: Optional[str] = Field(None, description="Session this trace belongs to")

    # Input
    user_input: Optional[str] = Field(None, description="Original user input")
    file_context: Optional[FileContext] = Field(None)

    # Phases
    thoughts: List[Thought] = Field(default_factory=list)
    actions: List[PlannedAction] = Field(default_factory=list)
    observations: List[Observation] = Field(default_factory=list)

    # Output
    final_response: Optional[str] = Field(None)

    # Metadata
    iterations: int = Field(default=0, description="Number of iterations")
    started_at: datetime = Field(default_factory=datetime.now)
    completed_at: Optional[datetime] = Field(None)
    total_tokens_used: int = Field(default=0)

    # Thinking depth metadata
    thinking_depth: Optional[str] = Field(
        None,
        description="Thinking depth tier used (QUICK, STANDARD, DEEP, REASONING)"
    )
    model_used: Optional[str] = Field(
        None,
        description="Gemini model used for this execution"
    )
    # Token usage
    prompt_tokens: int = Field(default=0, description="Input tokens used")
    completion_tokens: int = Field(default=0, description="Output tokens used")


# ============================================================================
# Hybrid ReAct Loop Models
# ============================================================================


@dataclass
class InferenceBudget:
    """
    Tracks remaining inference budget for cloud vs local calls.

    Used to control model routing in the hybrid ReAct loop.
    """

    # Cloud API calls remaining
    cloud_calls_remaining: int
    cloud_tokens_remaining: int

    # Local inference budget
    local_calls_remaining: int
    local_time_budget_ms: float

    # Usage tracking
    cloud_calls_used: int = 0
    local_calls_used: int = 0
    cloud_tokens_used: int = 0
    local_time_used_ms: float = 0.0

    def can_use_cloud(self) -> bool:
        """Check if cloud calls are available."""
        return self.cloud_calls_remaining > 0

    def can_use_local(self) -> bool:
        """Check if local inference budget available."""
        return self.local_calls_remaining > 0 and self.local_time_budget_ms > 0

    def record_cloud_call(self, tokens: int = 0) -> None:
        """Record a cloud API call."""
        self.cloud_calls_used += 1
        self.cloud_calls_remaining -= 1
        self.cloud_tokens_used += tokens
        self.cloud_tokens_remaining -= tokens

    def record_local_call(self, time_ms: float = 0.0) -> None:
        """Record a local inference call."""
        self.local_calls_used += 1
        self.local_calls_remaining -= 1
        self.local_time_used_ms += time_ms
        self.local_time_budget_ms -= time_ms

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "cloud_calls_remaining": self.cloud_calls_remaining,
            "cloud_tokens_remaining": self.cloud_tokens_remaining,
            "local_calls_remaining": self.local_calls_remaining,
            "local_time_budget_ms": self.local_time_budget_ms,
            "cloud_calls_used": self.cloud_calls_used,
            "local_calls_used": self.local_calls_used,
            "cloud_tokens_used": self.cloud_tokens_used,
            "local_time_used_ms": self.local_time_used_ms,
        }


@dataclass
class ObservationResult:
    """
    Result from local observation parsing using Gemma models.

    Used to extract key information from tool outputs and decide
    whether more reasoning is needed.
    """

    # Extracted information
    key_findings: List[str]
    data_extracted: Dict[str, Any]

    # Decision making
    is_sufficient: bool  # True if we have enough to respond
    needs_more_reasoning: bool  # True if complex follow-up needed
    suggested_action: Optional[str]  # Next tool to call if not sufficient

    # Metadata
    confidence: float  # 0.0-1.0
    parse_time_ms: float
    model_used: str  # "gemma4-e4b", "fallback"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "key_findings": self.key_findings,
            "data_extracted": self.data_extracted,
            "is_sufficient": self.is_sufficient,
            "needs_more_reasoning": self.needs_more_reasoning,
            "suggested_action": self.suggested_action,
            "confidence": self.confidence,
            "parse_time_ms": self.parse_time_ms,
            "model_used": self.model_used,
        }


@dataclass
class ModelRoutingDecision:
    """
    Decision on which model to use for a ReAct phase.

    Made by FunctionGemma at prepare time, can be refined at runtime.
    """

    use_local: bool
    model_name: str  # "gemma4-e4b" or "gemini-*"
    precision: str  # "4b", "12b", "full"
    reason: str
    estimated_time_ms: float = 0.0
    fallback_model: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "use_local": self.use_local,
            "model_name": self.model_name,
            "precision": self.precision,
            "reason": self.reason,
            "estimated_time_ms": self.estimated_time_ms,
            "fallback_model": self.fallback_model,
        }


# Need to import dataclass for the new models
from dataclasses import dataclass, field


# Rebuild models with forward references
ContextResponse.model_rebuild()


# ============================================================================
# Orchestration Telemetry Models (for Workstream Architecture)
# ============================================================================


class AgentStatus(str, Enum):
    """Agent activity status for telemetry."""

    STARTING = "starting"
    ACTIVE = "active"
    IDLE = "idle"
    WORKING = "working"
    BLOCKED = "blocked"
    ERROR = "error"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AgentType(str, Enum):
    """Types of agents in the orchestration system."""

    CLAUDE_CODE = "claude_code"
    HESTER = "hester"
    CUSTOM = "custom"


class TelemetryAction(str, Enum):
    """Actions for telemetry updates."""

    REGISTER = "register"
    UPDATE = "update"
    COMPLETE = "complete"


class AgentTelemetry(BaseModel):
    """Agent telemetry data for orchestration."""

    session_id: str = Field(description="Unique agent session identifier")
    agent_type: AgentType = Field(description="Type of agent")
    status: AgentStatus = Field(description="Current agent status")

    # Context information
    focus: Optional[str] = Field(None, description="Current agent focus/task description")
    active_file: Optional[str] = Field(None, description="Currently active file path")
    tool: Optional[str] = Field(None, description="Currently active tool name")
    progress: Optional[int] = Field(None, description="Progress percentage (0-100)")

    # Workstream integration
    workstream_id: Optional[str] = Field(None, description="Associated workstream ID")
    task_id: Optional[str] = Field(None, description="Associated runbook task ID")
    batch_id: Optional[str] = Field(None, description="Batch ID for grouped operations")

    # Tool and file tracking
    recent_tools: List[str] = Field(default_factory=list, description="Recently used tools (last 20)")
    files_touched: List[str] = Field(default_factory=list, description="Files read or written")

    # Timestamps
    registered_at: datetime = Field(default_factory=datetime.now, description="When agent was registered")
    last_updated: datetime = Field(default_factory=datetime.now, description="Last telemetry update")

    # Additional context
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional agent-specific metadata")
    result: Optional[str] = Field(None, description="Final result or error message (for completion)")

    def record_tool_use(self, tool_name: str, file_path: Optional[str] = None) -> None:
        """Record a tool use, maintaining a rolling window of recent tools."""
        self.recent_tools.append(tool_name)
        if len(self.recent_tools) > 20:
            self.recent_tools = self.recent_tools[-20:]
        if file_path and file_path not in self.files_touched:
            self.files_touched.append(file_path)
        self.last_updated = datetime.now()

    @field_validator("progress")
    @classmethod
    def validate_progress(cls, v):
        """Validate progress percentage is within valid range."""
        if v is not None and (v < 0 or v > 100):
            raise ValueError("Progress must be between 0 and 100")
        return v


class TelemetryRequest(BaseModel):
    """Request to send agent telemetry to daemon."""

    action: TelemetryAction = Field(description="Telemetry action type")
    session_id: str = Field(description="Agent session identifier")

    # Optional fields for different actions
    agent_type: Optional[AgentType] = Field(None, description="Agent type (required for register)")
    status: Optional[AgentStatus] = Field(None, description="Agent status")
    focus: Optional[str] = Field(None, description="Current focus/task")
    active_file: Optional[str] = Field(None, description="Active file path")
    tool: Optional[str] = Field(None, description="Active tool name")
    progress: Optional[int] = Field(None, description="Progress percentage")
    workstream_id: Optional[str] = Field(None, description="Workstream ID")
    task_id: Optional[str] = Field(None, description="Runbook task ID")
    batch_id: Optional[str] = Field(None, description="Batch ID for grouped operations")
    result: Optional[str] = Field(None, description="Result message (for complete)")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional metadata")

    @field_validator("progress")
    @classmethod
    def validate_progress(cls, v):
        """Validate progress percentage is within valid range."""
        if v is not None and (v < 0 or v > 100):
            raise ValueError("Progress must be between 0 and 100")
        return v


class TelemetryResponse(BaseModel):
    """Response from telemetry endpoint."""

    success: bool = Field(description="Whether the operation succeeded")
    session_id: str = Field(description="Agent session identifier")
    message: Optional[str] = Field(None, description="Response message")
    error: Optional[str] = Field(None, description="Error message if failed")
    data: Optional[Dict[str, Any]] = Field(None, description="Additional response data")


class AgentSessionInfo(BaseModel):
    """Information about an active agent session."""

    session_id: str
    agent_type: AgentType
    status: AgentStatus
    focus: Optional[str] = None
    active_file: Optional[str] = None
    tool: Optional[str] = None
    progress: Optional[int] = None
    workstream_id: Optional[str] = None
    registered_at: datetime
    last_updated: datetime
    metadata: Optional[Dict[str, Any]] = None


class AgentListRequest(BaseModel):
    """Request to list agent sessions with optional filters."""

    workstream_id: Optional[str] = Field(None, description="Filter by workstream ID")
    agent_type: Optional[AgentType] = Field(None, description="Filter by agent type")
    status: Optional[AgentStatus] = Field(None, description="Filter by status")


# ============================================================================
# Lee Context Models (for bidirectional Lee ↔ Hester communication)
# ============================================================================


class PanelContext(BaseModel):
    """State of a dockable panel (left, right, bottom, center)."""

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    active_tab_id: Optional[int] = Field(None, description="Currently active tab in this panel")
    visible: bool = Field(True, description="Whether the panel is visible")
    size: int = Field(50, description="Percentage of parent container")


class TabContext(BaseModel):
    """State of a single tab in Lee."""

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    id: int = Field(description="Unique tab identifier")
    type: str = Field(description="Tab type (editor, terminal, git, docker, etc.)")
    label: str = Field(description="Display label for the tab")
    pty_id: Optional[int] = Field(None, description="PTY process ID if applicable")
    dock_position: str = Field("center", description="Which panel the tab is docked in")
    state: Literal["active", "background", "idle"] = Field(
        "background",
        description="Tab activity state"
    )


class CursorPosition(BaseModel):
    """Cursor position in editor."""

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    line: int = Field(1, description="Line number (1-indexed)")
    column: int = Field(1, description="Column number (1-indexed)")


class EditorContext(BaseModel):
    """State from the Lee editor TUI (via OSC sequences)."""

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    file: Optional[str] = Field(None, description="Currently open file path")
    language: Optional[str] = Field(None, description="Detected language")
    cursor: CursorPosition = Field(default_factory=CursorPosition)
    selection: Optional[str] = Field(None, description="Selected text content")
    modified: bool = Field(False, description="Whether file has unsaved changes")
    daemon_port: Optional[int] = Field(None, description="Editor daemon HTTP port")


class UserAction(BaseModel):
    """User action for activity tracking."""

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    type: str = Field(description="Action type (tab_switch, file_open, command, etc.)")
    target: str = Field(description="Target of action (tab ID, file path, command)")
    timestamp: float = Field(description="Unix timestamp of action")


class ActivityContext(BaseModel):
    """User activity tracking for proactive assistance."""

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    last_interaction: float = Field(description="Unix timestamp of last user action")
    idle_seconds: float = Field(0, description="Seconds since last interaction")
    recent_actions: List[UserAction] = Field(
        default_factory=list,
        description="Last N user actions (max 50)"
    )
    session_duration: float = Field(0, description="Seconds since workspace opened")


class LeeContext(BaseModel):
    """
    Full context from Lee IDE.

    This is the complete state exposed to Hester for context awareness.
    Includes workspace, layout, tabs, editor state, and activity tracking.
    """

    model_config = ConfigDict(alias_generator=to_camel_case, populate_by_name=True)

    # Workspace
    workspace: str = Field(description="Current working directory")
    workspace_config: Optional[Dict[str, Any]] = Field(
        None,
        description="Workspace config from .lee/config.yaml"
    )

    # Layout - panel states
    panels: Dict[str, Optional[PanelContext]] = Field(
        description="Panel states (center, left, right, bottom)"
    )
    focused_panel: str = Field("center", description="Currently focused panel")

    # All tabs
    tabs: List[TabContext] = Field(default_factory=list, description="All open tabs")

    # Editor state (from OSC)
    editor: Optional[EditorContext] = Field(None, description="Current editor state")

    # Activity
    activity: Optional[ActivityContext] = Field(None, description="User activity tracking")

    # Timestamp of this context snapshot
    timestamp: float = Field(description="Unix timestamp of this snapshot")
