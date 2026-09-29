"""
Workspace registry routes: which workspaces the daemon is serving.

``POST /workspace`` (set the active workspace) stays in main.py because it
re-points the follow-active singletons.
"""

import json
from typing import Any, Dict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...shared.workspace import get_active_workspace
from .registry import WorkspaceError, get_registry


def _err(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "error": message})


async def _path_of(request: Request) -> Any:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        raise WorkspaceError("body must be JSON")
    if not isinstance(body, dict):
        raise WorkspaceError("body must be a JSON object")
    return body.get("path") or body.get("workspace")


def create_workspaces_router() -> APIRouter:
    router = APIRouter(tags=["workspaces"])

    @router.get("/workspaces")
    async def list_workspaces() -> Dict[str, Any]:
        return {"success": True, "data": get_registry().entries()}

    @router.post("/workspaces/open")
    async def open_workspace(request: Request):
        try:
            ctx = get_registry().open(await _path_of(request))
        except WorkspaceError as e:
            return _err(str(e))
        return {"success": True, "data": ctx.entry(ctx.path == get_active_workspace())}

    @router.post("/workspaces/close")
    async def close_workspace(request: Request):
        try:
            closed = get_registry().close(await _path_of(request))
        except WorkspaceError as e:
            return _err(str(e))
        return {"success": True, "data": {"closed": closed}}

    return router
