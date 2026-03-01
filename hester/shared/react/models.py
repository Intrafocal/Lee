"""
Gemini ReAct models - data classes and enums for ReAct loop.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Awaitable, Callable, Dict, List, Optional


class ReActPhase(Enum):
    """Phases in the ReAct loop for status updates."""
    PREPARE = "preparing"  # FunctionGemma tool selection
    THINK = "thinking"
    ACT = "acting"
    OBSERVE = "observing"
    RESPOND = "responding"


@dataclass
class PhaseUpdate:
    """Update about the current ReAct phase."""
    phase: ReActPhase
    tool_name: Optional[str] = None
    tool_context: Optional[str] = None  # e.g., file path, table name
    iteration: int = 0
    model_used: Optional[str] = None  # Current model being used
    # Prepare step fields
    tools_selected: Optional[int] = None  # Number of tools selected
    prepare_time_ms: Optional[float] = None  # Time for prepare step
    # Hybrid routing fields
    is_local: bool = False  # Whether using local model
    precision: Optional[str] = None  # "e2b", "e4b", "full"
    cloud_calls_remaining: Optional[int] = None  # Budget tracking
    local_calls_remaining: Optional[int] = None  # Budget tracking
    # Semantic routing fields (bespoke agent selection)
    prompt_id: Optional[str] = None  # Selected prompt (e.g., "code_analysis", "database")
    agent_id: Optional[str] = None  # Matched pre-bundled agent (e.g., "db_explorer")
    routing_reason: Optional[str] = None  # Why this routing was chosen


@dataclass
class ToolResult:
    """Result from a tool execution."""

    tool_name: str
    arguments: Dict[str, Any]
    result: Any
    success: bool
    error: Optional[str] = None


# Type alias for phase callback
PhaseCallback = Callable[[PhaseUpdate], Awaitable[None]]
