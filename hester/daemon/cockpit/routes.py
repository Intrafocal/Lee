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
from . import explore_ops, spikes
from .explorations import ExplorationError, ExplorationNotFound, open_session
from .explorations import to_api as exploration_to_api
from .explorations import to_api_with_conversations
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


def list_bundles(workspace: Path) -> List[Dict[str, Any]]:
    """
    Context bundles in ``<workspace>/.hester/context/bundles/`` for the
    Launcher's context picker: ids, titles and the content file's path, never
    the content. Deterministic (no synthesis, no model).
    """
    try:
        from ...context.service import ContextBundleService
    except Exception:  # pragma: no cover - optional dependency missing
        return []
    try:
        statuses = ContextBundleService(working_dir=str(workspace)).list_all()
    except Exception:
        return []
    root = Path(workspace).resolve()
    out: List[Dict[str, Any]] = []
    for st in statuses:
        path = root / ".hester" / "context" / "bundles" / f"{st.id}.md"
        updated = st.updated if st.updated.tzinfo else st.updated.replace(tzinfo=timezone.utc)
        out.append({
            "id": st.id,
            "title": st.title,
            "updated": iso_s(updated),
            "stale": bool(st.is_stale),
            "source_count": st.source_count,
            "tags": list(st.tags or []),
            "path": str(path),
            "relative_path": str(path.relative_to(root)),
        })
    return out


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
            data = await asyncio.to_thread(ctx.tasks().list, status, n)
            return _ok(ctx, data)
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
                await _sync_spike(ctx, task)
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))
        return _ok(ctx, to_api(task), 201 if created else 200)

    @router.post("/cockpit/tasks/name")
    async def cockpit_task_name(request: Request):
        """A session name from Lee (you, /rename or Claude's AI title), by task id or session id."""
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            async with ctx.lock:
                task, changed = ctx.tasks().set_name(body)
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))
        except TaskNotFound:
            return _err("not found", 404)
        return _ok(ctx, {"task": to_api(task), "changed": changed})

    async def _mutate(request: Request, task_id: str, op: str):
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            store = ctx.tasks()
            async with ctx.lock:
                if op == "patch":
                    task = store.patch(task_id, body)
                    await _sync_spike(ctx, task)
                    return _ok(ctx, to_api(task))
                if op == "confirm":
                    return _ok(ctx, to_api(store.confirm(task_id, body)))
                if op == "link":
                    return _ok(ctx, to_api(store.link(task_id, body)))
                if op == "close":
                    task = await asyncio.to_thread(store.close, task_id, body)
                    await _sync_spike(ctx, task)
                    return _ok(ctx, to_api(task))
                if op == "promote":
                    task, ws_id = store.promote(task_id, body, ctx.ws_store())
                    return _ok(ctx, {"task": to_api(task), "workstream_id": ws_id})
                if op == "escalate":
                    task, exp = explore_ops.escalate(ctx, task_id)
                    return _ok(ctx, {"task": to_api(task), "exploration": exploration_to_api(exp)}, 201)
        except BadRequest as e:
            return _err(str(e), e.status)
        except TaskError as e:
            return _err(str(e))
        except ExplorationError as e:
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

    @router.post("/cockpit/tasks/{task_id}/escalate")
    async def cockpit_task_escalate(task_id: str, request: Request):
        """Escalate a task into an exploration; the task stays open."""
        return await _mutate(request, task_id, "escalate")

    @router.get("/cockpit/context/bundles")
    async def cockpit_context_bundles():
        """Hester context bundles for the Launcher's context picker (references only)."""
        try:
            ctx = context_for()
        except BadRequest as e:
            return _err(str(e), e.status)
        data = await asyncio.to_thread(list_bundles, Path(ctx.path))
        return _ok(ctx, data)

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

    # ------------------------------------------------------------ explorations

    @router.get("/cockpit/explorations")
    async def cockpit_explorations(status: str = "active", limit: Optional[str] = None):
        try:
            ctx = context_for()
            n = _int(limit, 100, 0, 1000, "limit")
            items = await asyncio.to_thread(ctx.explorations().list, status, n)
            return _ok(ctx, [exploration_to_api(e) for e in items])
        except BadRequest as e:
            return _err(str(e), e.status)
        except ExplorationError as e:
            return _err(str(e))

    @router.post("/cockpit/explorations")
    async def cockpit_exploration_create(request: Request):
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            async with ctx.lock:
                exp = ctx.explorations().create(body)
        except BadRequest as e:
            return _err(str(e), e.status)
        except ExplorationError as e:
            return _err(str(e))
        return _ok(ctx, exploration_to_api(exp), 201)

    @router.get("/cockpit/explorations/{exp_id}")
    async def cockpit_exploration(exp_id: str):
        try:
            ctx = context_for()
            store = ctx.explorations()
            exp = store.require(exp_id)
            body = store.body(exp_id)
            data = to_api_with_conversations(exp, body)
            data["body"] = body
            return _ok(ctx, data)
        except BadRequest as e:
            return _err(str(e), e.status)
        except ExplorationError as e:
            return _err(str(e))
        except ExplorationNotFound:
            return _err("not found", 404)

    @router.patch("/cockpit/explorations/{exp_id}")
    async def cockpit_exploration_patch(exp_id: str, request: Request):
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            async with ctx.lock:
                exp = ctx.explorations().patch(exp_id, body)
        except BadRequest as e:
            return _err(str(e), e.status)
        except ExplorationError as e:
            return _err(str(e))
        except ExplorationNotFound:
            return _err("not found", 404)
        return _ok(ctx, exploration_to_api(exp))

    @router.post("/cockpit/explorations/{exp_id}/open")
    async def cockpit_exploration_open(exp_id: str, request: Request):
        """Seed (if needed) the Hester chat session for the deep dive; Lee then spawns `hester chat --session`."""
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            store = ctx.explorations()
            async with ctx.lock:
                exp = store.touch(exp_id)
            opened = await open_session(store, exp_id)
        except BadRequest as e:
            return _err(str(e), e.status)
        except ExplorationError as e:
            return _err(str(e))
        except ExplorationNotFound:
            return _err("not found", 404)
        return _ok(ctx, {"exploration": exploration_to_api(exp), **opened})

    async def _exp_op(request: Request, fn, status: int = 200):
        """Run ``fn(ctx, store, body)`` (sync or async) on an exploration under the workspace lock."""
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            async with ctx.lock:
                data = fn(ctx, ctx.explorations(), body)
                if asyncio.iscoroutine(data):
                    data = await data
        except BadRequest as e:
            return _err(str(e), e.status)
        except (ExplorationError, TaskError) as e:
            return _err(str(e))
        except (ExplorationNotFound, TaskNotFound):
            return _err("not found", 404)
        return _ok(ctx, data, status)

    @router.post("/cockpit/explorations/{exp_id}/nodes")
    async def cockpit_exploration_node_add(exp_id: str, request: Request):
        return await _exp_op(request, lambda ctx, store, b: store.add_node(
            exp_id, b.get("parent") or "root", b.get("label"), b.get("kind") or "thought", b.get("mode"),
        ), 201)

    @router.patch("/cockpit/explorations/{exp_id}/nodes/{node_id}")
    async def cockpit_exploration_node_patch(exp_id: str, node_id: str, request: Request):
        return await _exp_op(request, lambda ctx, store, b: store.patch_node(exp_id, node_id, b))

    @router.post("/cockpit/explorations/{exp_id}/nodes/{node_id}/prune")
    async def cockpit_exploration_node_prune(exp_id: str, node_id: str, request: Request):
        def op(ctx, store, b):
            node, decision = store.prune(exp_id, node_id, b.get("reason"))
            return {"node": node, "decision": decision}
        return await _exp_op(request, op)

    @router.post("/cockpit/explorations/{exp_id}/decisions")
    async def cockpit_exploration_decide(exp_id: str, request: Request):
        return await _exp_op(request, lambda ctx, store, b: store.decide(exp_id, b), 201)

    @router.post("/cockpit/explorations/{exp_id}/spikes")
    async def cockpit_exploration_spike(exp_id: str, request: Request):
        return await _exp_op(request, lambda ctx, store, b: store.add_spike(exp_id, b), 201)

    @router.patch("/cockpit/explorations/{exp_id}/spikes/{node_id}")
    async def cockpit_exploration_spike_patch(exp_id: str, node_id: str, request: Request):
        def op(ctx, store, b):
            unknown = set(b) - {"task_id", "status", "worktree"}
            if unknown:
                raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
            return store.update_spike(exp_id, node_id, b)
        return await _exp_op(request, op)

    @router.post("/cockpit/explorations/{exp_id}/promote")
    async def cockpit_exploration_promote(exp_id: str, request: Request):
        return await _exp_op(request, lambda ctx, store, b: explore_ops.promote(ctx, exp_id, b))

    @router.post("/cockpit/explorations/{exp_id}/archive")
    async def cockpit_exploration_archive(exp_id: str, request: Request):
        def op(ctx, store, b):
            as_knowledge = b.get("as_knowledge", False)
            if not isinstance(as_knowledge, bool):
                raise ExplorationError("as_knowledge must be a boolean")
            return explore_ops.archive(ctx, exp_id, as_knowledge)
        return await _exp_op(request, op)

    return router


async def _sync_spike(ctx, task: Dict[str, Any]) -> None:
    """A task with an ``explore`` origin moves its spike node along (never raises)."""
    if (task.get("origin") or {}).get("kind") == "explore":
        await asyncio.to_thread(spikes.sync, ctx, task)
