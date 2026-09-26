"""
Cockpit HTTP routes on the Hester daemon (:9000), contracts section 6.3.

Every endpoint is about one workspace: ``?workspace=`` or ``X-Lee-Workspace``
(set on ``request_workspace`` by the auth middleware), else a JSON body's
``workspace``, else the active one. Responses use the copilot envelope
``{"success": true, "data": ..., "workspace": ..., "workspace_id": ...}``.
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...shared.workspace import request_workspace
from ..workspaces.registry import WorkspaceError, get_registry, validate_workspace
from .goals import load_goals
from .history import MAX_DAYS, build_history
from .tasks import (
    OPEN_STATUSES,
    RECENT_CLOSED_DAYS,
    TaskError,
    TaskNotFound,
    is_open,
    iso_s,
    parse_time,
    to_api,
)

OPEN_ORDER = {s: i for i, s in enumerate(OPEN_STATUSES)}
MAX_RECENT = 20


class BadRequest(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _err(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "error": message})


def _ok(ctx, data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        "success": True, "data": data, "workspace": str(ctx.path), "workspace_id": ctx.id,
    })


def context_for(body_workspace: Any = None):
    """The WorkspaceContext this request is about (section 9.3)."""
    registry = get_registry()
    scoped = request_workspace.get()
    if scoped is not None:
        if body_workspace:
            try:
                if validate_workspace(body_workspace) != scoped:
                    raise BadRequest("workspace in the body differs from the request's workspace")
            except WorkspaceError as e:
                raise BadRequest(str(e))
        return registry.get(scoped, source="request")
    if body_workspace:
        try:
            return registry.get(body_workspace, source="request")
        except WorkspaceError as e:
            raise BadRequest(str(e))
    try:
        return registry.active()
    except WorkspaceError as e:
        raise BadRequest(str(e))


async def _body(request: Request) -> Dict[str, Any]:
    raw = await request.body()
    if not raw.strip():
        return {}
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        raise BadRequest("body must be JSON")
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    return body


def _int(value: Optional[str], default: int, lo: int, hi: int, name: str) -> int:
    if value is None or value == "":
        return default
    try:
        n = int(value)
    except ValueError:
        raise BadRequest(f"{name} must be an integer")
    return max(lo, min(hi, n))


def build_snapshot(ctx, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    store = ctx.tasks()
    tasks = store.load_all()
    open_tasks = [t for t in tasks if is_open(t)]
    open_tasks.sort(key=lambda t: str(t.get("updated_at") or ""), reverse=True)
    open_tasks.sort(key=lambda t: OPEN_ORDER.get(t.get("status"), len(OPEN_ORDER)))
    cutoff = now - timedelta(days=RECENT_CLOSED_DAYS)
    closed = [
        t for t in tasks
        if not is_open(t) and (parse_time(t.get("closed_at")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff
    ]
    closed.sort(key=lambda t: str(t.get("closed_at") or ""), reverse=True)

    by_ws: Dict[str, List[str]] = {}
    for t in tasks:
        if t.get("workstream"):
            by_ws.setdefault(t["workstream"], []).append(t["id"])
    workstreams = []
    ws_store = ctx.ws_store()
    try:
        ids = ws_store.list_all()
    except OSError:
        ids = []
    for wid in ids:
        w = ws_store.get(wid)
        if w is None:
            continue
        workstreams.append({
            "id": w.id,
            "title": w.title,
            "phase": w.phase.value,
            "serves": list(getattr(w, "serves", []) or []),
            "task_ids": sorted(by_ws.get(w.id, [])),
        })

    return {
        "workspace": str(ctx.path),
        "workspace_id": ctx.id,
        "version": store.counter.get(),
        "tasks": {
            "open": [to_api(t) for t in open_tasks],
            "recent_closed": [to_api(t) for t in closed[:MAX_RECENT]],
            "recent_events": store.recent_events(MAX_RECENT),
        },
        "workstreams": workstreams,
        "someday": ctx.someday().counts(now=now),
        "readings": {"latest": ctx.readings().latest()},
        "generated_at": iso_s(now),
    }


def create_cockpit_router() -> APIRouter:
    router = APIRouter(tags=["cockpit"])

    @router.get("/cockpit/snapshot")
    async def cockpit_snapshot(since_version: Optional[str] = None):
        try:
            ctx = context_for()
            since = _int(since_version, -1, -1, 2**62, "since_version")
        except BadRequest as e:
            return _err(str(e), e.status)
        version = ctx.tasks().counter.get()
        if since >= 0 and since == version:
            return _ok(ctx, {"unchanged": True, "version": version})
        snap = await asyncio.to_thread(build_snapshot, ctx)
        return _ok(ctx, snap)

    @router.get("/cockpit/tasks")
    async def cockpit_tasks(status: str = "open", limit: Optional[str] = None):
        try:
            ctx = context_for()
            n = _int(limit, 100, 0, 1000, "limit")
            return _ok(ctx, ctx.tasks().list(status, n))
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))

    @router.get("/cockpit/tasks/{task_id}")
    async def cockpit_task(task_id: str):
        try:
            ctx = context_for()
            return _ok(ctx, to_api(ctx.tasks().require(task_id)))
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))
        except TaskNotFound:
            return _err("not found", 404)

    @router.post("/cockpit/tasks")
    async def cockpit_task_create(request: Request):
        try:
            body = await _body(request)
            ctx = context_for(body.get("workspace"))
            async with ctx.lock:
                task, created = ctx.tasks().upsert(body)
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))
        return _ok(ctx, to_api(task), 201 if created else 200)

    async def _mutate(request: Request, task_id: str, op: str):
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            store = ctx.tasks()
            async with ctx.lock:
                if op == "patch":
                    return _ok(ctx, to_api(store.patch(task_id, body)))
                if op == "confirm":
                    return _ok(ctx, to_api(store.confirm(task_id, body)))
                if op == "link":
                    return _ok(ctx, to_api(store.link(task_id, body)))
                if op == "close":
                    task = await asyncio.to_thread(store.close, task_id, body)
                    return _ok(ctx, to_api(task))
                if op == "promote":
                    task, ws_id = store.promote(task_id, body, ctx.ws_store())
                    return _ok(ctx, {"task": to_api(task), "workstream_id": ws_id})
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))
        except TaskNotFound:
            return _err("not found", 404)
        return _err("unknown operation")

    @router.patch("/cockpit/tasks/{task_id}")
    async def cockpit_task_patch(task_id: str, request: Request):
        return await _mutate(request, task_id, "patch")

    @router.post("/cockpit/tasks/{task_id}/confirm")
    async def cockpit_task_confirm(task_id: str, request: Request):
        return await _mutate(request, task_id, "confirm")

    @router.post("/cockpit/tasks/{task_id}/link")
    async def cockpit_task_link(task_id: str, request: Request):
        return await _mutate(request, task_id, "link")

    @router.post("/cockpit/tasks/{task_id}/close")
    async def cockpit_task_close(task_id: str, request: Request):
        return await _mutate(request, task_id, "close")

    @router.post("/cockpit/tasks/{task_id}/promote")
    async def cockpit_task_promote(task_id: str, request: Request):
        return await _mutate(request, task_id, "promote")

    @router.get("/cockpit/goals")
    async def cockpit_goals():
        try:
            ctx = context_for()
        except BadRequest as e:
            return _err(str(e), e.status)
        return _ok(ctx, load_goals(ctx.path))

    @router.get("/cockpit/history")
    async def cockpit_history(days: Optional[str] = None):
        try:
            ctx = context_for()
            n = _int(days, 7, 1, MAX_DAYS, "days")
        except BadRequest as e:
            return _err(str(e), e.status)
        data = await asyncio.to_thread(build_history, Path(ctx.path), n)
        return _ok(ctx, data)

    @router.get("/cockpit/readings")
    async def cockpit_readings(metric: Optional[str] = None, limit: Optional[str] = None):
        try:
            ctx = context_for()
            n = _int(limit, 50, 0, 1000, "limit")
        except BadRequest as e:
            return _err(str(e), e.status)
        return _ok(ctx, ctx.readings().list(metric or None, n))

    return router
