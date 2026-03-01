"""
Gemini Tool Capability - Function calling support for ReAct loop.

This module re-exports all components from the react subpackage
for backwards compatibility. New code should import directly from
`shared.react` for better organization.
"""

# Re-export everything from the react package
from .react import (
    # Models
    ReActPhase,
    PhaseUpdate,
    PhaseCallback,
    ToolResult,
    # Capabilities (new names)
    ReActCapability,
    HybridReActCapability,
    # Backwards compatibility aliases
    GeminiToolCapability,
    HybridGeminiCapability,
)

__all__ = [
    # Models
    "ReActPhase",
    "PhaseUpdate",
    "PhaseCallback",
    "ToolResult",
    # Capabilities (new names)
    "ReActCapability",
    "HybridReActCapability",
    # Backwards compatibility aliases
    "GeminiToolCapability",
    "HybridGeminiCapability",
]
