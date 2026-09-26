"""Multi-workspace model for the Hester daemon (contracts section 9)."""

from .registry import (
    WorkspaceContext,
    WorkspaceError,
    WorkspaceRegistry,
    get_registry,
    init_registry,
    validate_workspace,
)

__all__ = [
    "WorkspaceContext",
    "WorkspaceError",
    "WorkspaceRegistry",
    "get_registry",
    "init_registry",
    "validate_workspace",
]
