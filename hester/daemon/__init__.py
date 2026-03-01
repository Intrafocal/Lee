"""
Hester Daemon Mode - AI assistant service for Lee editor.

Runs on port 9000 and uses Gemini 3 Pro with a text-based ReAct loop.

NOTE: HesterDaemonAgent is NOT auto-imported to avoid pulling in heavy dependencies.
Import it explicitly: from hester.daemon.agent import HesterDaemonAgent
"""

from .session import (
    SessionManager, HesterSession, InMemorySessionManager,
    ExplorationNode, ExplorationSession, ExplorationSessionManager,
)
from .models import (
    ContextRequest,
    ContextResponse,
    EditorState,
    EditorCommand,
    ImageData,
)
from .settings import HesterDaemonSettings, get_daemon_settings

# Lazy import for HesterDaemonAgent to avoid heavy dependency chain
def get_daemon_agent_class():
    """Get HesterDaemonAgent class (lazy import to avoid heavy deps)."""
    from .agent import HesterDaemonAgent
    return HesterDaemonAgent

__all__ = [
    "get_daemon_agent_class",
    "SessionManager",
    "InMemorySessionManager",
    "HesterSession",
    "ContextRequest",
    "ContextResponse",
    "EditorState",
    "EditorCommand",
    "ImageData",
    "ExplorationNode",
    "ExplorationSession",
    "ExplorationSessionManager",
    "HesterDaemonSettings",
    "get_daemon_settings",
]
