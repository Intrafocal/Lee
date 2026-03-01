"""
ReAct package - Modular ReAct loop and tool calling support.

This package provides:
- models: Data classes and enums for ReAct phases and tool results
- capability: Base ReActCapability mixin for function calling
- hybrid: HybridReActCapability for local/cloud routing
"""

from .models import (
    ReActPhase,
    PhaseUpdate,
    PhaseCallback,
    ToolResult,
)

from .capability import ReActCapability, GeminiToolCapability

from .hybrid import HybridReActCapability, HybridGeminiCapability


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
