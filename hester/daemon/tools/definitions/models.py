"""
Tool models - base classes for tool definitions.
"""

from typing import Any, Dict, Optional, Set

from pydantic import BaseModel, Field


# Available environments for tool filtering
# - daemon: Hester for Lee (daemon, TUI, command palette) - all tools
# - cli: Headless CLI commands - no Lee UI tools
# - slack: Slack integration - restricted set
# - subagent: Spawned subagent - no orchestration tools
ALL_ENVIRONMENTS = {"daemon", "cli", "slack", "subagent"}


class ToolResult(BaseModel):
    """Result from a tool execution."""

    success: bool = Field(description="Whether the tool succeeded")
    data: Optional[Any] = Field(default=None, description="Result data")
    message: Optional[str] = Field(default=None, description="Success message")
    error: Optional[str] = Field(default=None, description="Error message if failed")


class ToolDefinition(BaseModel):
    """Definition of a tool for the ReAct loop."""

    name: str = Field(description="Tool name (used for invocation)")
    description: str = Field(description="What the tool does")
    parameters: Dict[str, Any] = Field(
        description="JSON Schema for parameters"
    )
    environments: Optional[Set[str]] = Field(
        default=None,
        description="Environments where this tool is available. None = all environments."
    )
