"""
Hester Shared Utilities.

Common functionality shared across Hester capabilities.

NOTE: surfaces module NOT auto-imported to avoid QA/MCP dependencies.
Import explicitly: from hester.shared.surfaces import format_qa_result
"""

from .gemini_tools import GeminiToolCapability, ToolResult

__all__ = ["GeminiToolCapability", "ToolResult"]
