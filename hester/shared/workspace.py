"""
Current-workspace tracking and workspace-scoped Redis key prefixes.

The daemon can be re-pointed at a different workspace at runtime (POST /workspace),
so anything that derives state from the workspace must ask for it at call time
rather than caching a value captured at boot.

One daemon serves every Lee window. The *active* workspace is the focused
window's (POST /workspace); a request can name its own workspace with
``?workspace=`` or ``X-Lee-Workspace``, which the auth middleware puts in
``request_workspace`` for the duration of that request.
"""

import hashlib
import logging
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator, Optional

logger = logging.getLogger("hester.shared.workspace")

_current_workspace: Optional[Path] = None

request_workspace: ContextVar[Optional[Path]] = ContextVar("hester_request_workspace", default=None)


def get_active_workspace() -> Path:
    """
    The active workspace (the focused Lee window's).

    Precedence: an explicit set_current_workspace() call (POST /workspace or boot)
    > HESTER_WORKING_DIRECTORY env > process cwd.
    """
    if _current_workspace is not None:
        return _current_workspace
    env_dir = os.environ.get("HESTER_WORKING_DIRECTORY")
    if env_dir:
        try:
            return Path(env_dir).expanduser().resolve()
        except OSError:
            pass
    return Path.cwd()


def get_current_workspace() -> Path:
    """The workspace this request (or block) is about, else the active one."""
    scoped = request_workspace.get()
    if scoped is not None:
        return scoped
    return get_active_workspace()


@contextmanager
def use_workspace(path) -> Iterator[Path]:
    """Scope get_current_workspace() to ``path`` for a block (background tasks, tests)."""
    resolved = Path(path).expanduser().resolve()
    token = request_workspace.set(resolved)
    try:
        yield resolved
    finally:
        request_workspace.reset(token)


def set_current_workspace(path) -> Path:
    """Set the active workspace. Returns the resolved path."""
    global _current_workspace
    resolved = Path(path).expanduser().resolve()
    _current_workspace = resolved
    return resolved


def workspace_id(path=None) -> str:
    """Short stable id for a workspace: first 8 hex of sha1 of the resolved path."""
    target = Path(path).expanduser().resolve() if path is not None else get_current_workspace()
    return hashlib.sha1(str(target).encode("utf-8")).hexdigest()[:8]


def workspace_key_prefix(path=None) -> str:
    """
    Redis key prefix scoped to a workspace, e.g. ``hester:ws:1a2b3c4d:``.

    Resolved at call time so a runtime workspace switch takes effect immediately.
    """
    return f"hester:ws:{workspace_id(path)}:"
