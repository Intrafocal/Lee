"""
Copilot v4 Cockpit routes: goal status, steward endpoints, proposals, GOALS.md
drafts and Build toward (contract sections 2 and 5.2).

Every model-using endpoint here is a user action and non-streaming; each
returns ``{text, proposals, steer, surface, request_id}`` (plus endpoint
extras) in the Cockpit envelope. None asks for a reason. GOALS.md is written
only by ``POST /cockpit/goals/draft/{id}/apply``.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Request

from ..copilot import lee_events
from . import goal_status, steward
from .explorations import ExplorationNotFound
from .explorations import to_api as exploration_to_api
from .goals import load_goals_full
from .history import MAX_DAYS
from .routes import BadRequest, _body, _err, _int, _ok, context_for
from .steward import StewardError, context_json
from .tasks import TaskNotFound, apply_derived, is_open, open_sort_key, workspace_goals

logger = logging.getLogger("hester.daemon.cockpit.steward_routes")

TASK_CONTEXT_KEYS = (
    "id", "title", "name", "kind", "status", "lead", "play", "serves", "workstream", "quadrant", "importance_rank",
    "urgency", "overrides", "timebox_min", "busy_ms", "turns", "files_count", "summary", "lee_status", "origin",
    "confirmed", "agent", "created_at", "updated_at", "due",
)


def _actor(request: Request) -> Dict[str, Any]:
    from ..copilot.routes import caller_actor

    return caller_actor(request)


def _log(kind: str, data: Dict[str, Any], ctx, request: Request) -> None:
    try:
        lee_events.ingest(kind, data, workspace=str(ctx.path), actor=_actor(request))
    except Exception as e:  # never fail a request over telemetry
        logger.debug(f"could not log {kind}: {e}")


def _task_brief(task: Dict[str, Any]) -> Dict[str, Any]:
    return {k: task.get(k) for k in TASK_CONTEXT_KEYS}


def _public(answer: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in answer.items() if k != "raw"}


async def digest_for(ctx) -> Dict[str, Any]:
    """The session digest with Lee's live attention items (tests replace this)."""
    from ..copilot.digest import build_digest
    from ..copilot.routes import fetch_attention_items

    items = await fetch_attention_items()
    return await asyncio.to_thread(build_digest, Path(ctx.path), attention_items=items)


def _compact_digest(d: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "top_line": d.get("top_line"),
        "since": d.get("since"),
        "wins": [{k: w.get(k) for k in ("kind", "title", "ref", "at")} for w in (d.get("wins") or [])[:10]],
        "agent_claims": [
            {"session_id": c.get("session_id"), "summary": c.get("summary"), "at": c.get("at"), "verified": False}
            for c in (d.get("agent_claims") or [])[:10]
        ],
        "waiting": [
            {k: w.get(k) for k in ("id", "kind", "text", "severity", "source")} for w in (d.get("waiting") or [])[:10]
        ],
        "q2_candidates": d.get("q2_candidates") or [],
        "retro": d.get("retro"),
    }


def _compact_status(status: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "goals": [
            {
                "id": g["id"], "title": g["title"], "priority": g["priority"], "flagged": g["flagged"],
                "measured": g.get("measured", True),
                "last_evaluated_at": g["last_evaluated_at"], "focus_ms_7d": g["focus_ms_7d"],
                "serving": {k: len(v) for k, v in g["serving"].items()},
                "metrics": [
                    {k: m.get(k) for k in ("name", "value", "previous", "trend", "ok", "target_text", "source")}
                    for m in g["metrics"]
                ],
            }
            for g in status["goals"]
        ],
        "human_balance": status["human_balance"],
    }


def _open_tasks(ctx) -> List[Dict[str, Any]]:
    goals = workspace_goals(ctx.path)
    tasks = [apply_derived(t, goals, saving=False) for t in ctx.tasks().load_all() if is_open(t)]
    tasks.sort(key=open_sort_key)
    return tasks


def _goals_brief(workspace: Path) -> List[Dict[str, Any]]:
    return [
        {"id": g["id"], "title": g["title"], "priority": g["priority"], "prose": (g["prose"] or "")[:500],
         "metrics": [m["name"] for m in g["metrics"]]}
        for g in load_goals_full(workspace)["goals"]
    ]


def _find_task(ctx, about_id: Any, record: Any) -> Optional[Dict[str, Any]]:
    """A task by id, by a record's task_id, or by a live agent pty id (tiles)."""
    store = ctx.tasks()
    candidates = [about_id]
    if isinstance(record, dict):
        candidates += [record.get("task_id"), (record.get("task") or {}).get("id") if isinstance(record.get("task"), dict) else None]
    for cid in candidates:
        if isinstance(cid, str) and cid.startswith("task-"):
            try:
                task = store.get(cid)
            except ValueError:
                task = None
            if task is not None:
                return task
    ptys = [about_id] + ([record.get("pty_id")] if isinstance(record, dict) else [])
    for p in ptys:
        try:
            pty = int(p)
        except (TypeError, ValueError):
            continue
        hits = [t for t in store.load_all() if steward.live_pty(t) == pty]
        if hits:
            hits.sort(key=lambda t: str(t.get("updated_at") or ""), reverse=True)
            return hits[0]
    return None


def create_steward_router() -> APIRouter:
    router = APIRouter(tags=["cockpit-steward"])

    async def run(request: Request, fn, status: int = 200):
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            data = await fn(ctx, body)
        except BadRequest as e:
            return _err(str(e), e.status)
        except StewardError as e:
            return _err(str(e), e.status)
        except (TaskNotFound, ExplorationNotFound):
            return _err("not found", 404)
        except ValueError as e:
            return _err(str(e))
        except Exception:
            logger.exception(f"{request.method} {request.url.path} failed")
            return _err("Hester couldn't answer this time; the daemon log has the details", 502)
        return _ok(ctx, data, status)

    # ------------------------------------------------------------ goal status

    @router.get("/cockpit/goals/status")
    async def cockpit_goal_status(days: Optional[str] = None):
        try:
            ctx = context_for()
            n = _int(days, 7, 1, MAX_DAYS, "days")
        except BadRequest as e:
            return _err(str(e), e.status)
        data = await asyncio.to_thread(goal_status.build_status, Path(ctx.path), n)
        return _ok(ctx, data)

    # ------------------------------------------------------------ steward on/off

    @router.get("/cockpit/steward")
    async def cockpit_steward_get():
        try:
            ctx = context_for()
        except BadRequest as e:
            return _err(str(e), e.status)
        return _ok(ctx, steward.state(ctx.path, ctx.config()))

    @router.post("/cockpit/steward")
    async def cockpit_steward_post(request: Request):
        async def op(ctx, body):
            if "not_today" not in body:
                return steward.state(ctx.path, ctx.config())
            if not isinstance(body["not_today"], bool):
                raise BadRequest("not_today must be a boolean")
            async with ctx.lock:
                data = steward.set_not_today(ctx.path, ctx.config(), body["not_today"])
            _log("steward.quiet", {"not_today": body["not_today"], "until": data["not_today_until"]}, ctx, request)
            return data
        return await run(request, op)

    # ------------------------------------------------------------ what next

    @router.post("/cockpit/what-next")
    async def cockpit_what_next(request: Request):
        async def op(ctx, body):
            digest = await digest_for(ctx)
            status = await asyncio.to_thread(goal_status.build_status, Path(ctx.path), 7)
            tasks = [_task_brief(t) for t in await asyncio.to_thread(_open_tasks, ctx)]
            context = "\n\n".join([
                context_json("Digest (verified wins; agent claims are unverified)", _compact_digest(digest)),
                context_json("Open tasks (quadrant order)", tasks),
                context_json("Goal status", _compact_status(status)),
            ])
            message = (
                "What should I work on next? Give one recommendation with a size, and at most two alternatives, "
                "citing the context."
            )
            _log("steward.request", {"surface": "what-next"}, ctx, request)
            ans = await steward.answer(ctx.path, "what-next", message, context, record={"about": None})
            return _public(ans)
        return await run(request, op)

    # ------------------------------------------------------------ evaluate

    @router.post("/cockpit/goals/{gid}/evaluate")
    async def cockpit_goal_evaluate(gid: str, request: Request):
        async def op(ctx, body):
            if not goal_status.is_goal_id(gid):
                raise BadRequest("invalid goal id")
            packet = await asyncio.to_thread(goal_status.evidence_packet, Path(ctx.path), gid)
            if packet is None:
                raise StewardError("not found", 404)
            stale = packet.get("stale_measure")
            if body.get("packet_only"):
                return {"text": "", "proposals": [], "steer": None, "surface": "evaluate", "request_id": None,
                        "packet": packet, "stale_measure": stale, "evaluation_path": None}
            message = (
                f"Evaluate {gid} ({packet['goal']['title']}) against the evidence packet. Is it on track? "
                "What is working, what isn't, and what one thing would move it most? Say which evidence is "
                "verified and which is an agent's claim."
            )
            _log("steward.request", {"surface": "evaluate", "goal_id": gid}, ctx, request)
            ans = await steward.answer(
                ctx.path, "evaluate", message, context_json(f"Evidence packet for {gid}", packet),
                origin={"kind": "goal-eval", "ref": gid}, record={"goal_id": gid},
            )
            path = await asyncio.to_thread(
                steward.save_evaluation, Path(ctx.path), gid, packet["goal"]["title"], packet, ans["raw"],
                goal_status.utc_now(),
            )
            return {**_public(ans), "packet": packet, "stale_measure": stale, "evaluation_path": path}
        return await run(request, op)

    # ------------------------------------------------------------ task suggest

    @router.post("/cockpit/tasks/{task_id}/suggest")
    async def cockpit_task_suggest(task_id: str, request: Request):
        async def op(ctx, body):
            task = ctx.tasks().require(task_id)
            apply_derived(task, workspace_goals(ctx.path), saving=False)
            serves = set(task.get("serves") or [])
            related = [
                _task_brief(t) for t in await asyncio.to_thread(_open_tasks, ctx)
                if t["id"] != task_id and serves & set(t.get("serves") or [])
            ]
            context = "\n\n".join([
                context_json("Task", _task_brief(task)),
                context_json("Goals (GOALS.md, priority order)", _goals_brief(Path(ctx.path))),
                context_json("Open tasks serving the same goals", related),
            ])
            message = (
                f"For task {task_id}: which goals might it serve (goal ids from the context only), would a "
                "different lead (delegate, human, plan) be better and why, and what are two or three concrete "
                "starting branches?"
            )
            _log("steward.request", {"surface": "launch-suggest", "about_kind": "task"}, ctx, request)
            ans = await steward.answer(ctx.path, "launch-suggest", message, context,
                                       record={"about": {"kind": "task", "id": task_id}})
            return _public(ans)
        return await run(request, op)

    # ------------------------------------------------------------ ask / steer

    @router.post("/cockpit/ask")
    async def cockpit_ask(request: Request):
        async def op(ctx, body):
            question = body.get("question")
            if not isinstance(question, str) or not question.strip():
                raise BadRequest("question is required")
            question = question.strip()[: steward.MAX_QUESTION]
            about = body.get("about")
            if about is not None and not isinstance(about, dict):
                raise BadRequest("about must be an object")
            about = about or {}
            kind, about_id, record = about.get("kind"), about.get("id"), about.get("record")
            if kind is not None and kind not in steward.ABOUT_KINDS:
                raise BadRequest(f"about.kind must be one of {', '.join(steward.ABOUT_KINDS)}")
            sections: List[str] = []
            task = None
            goal_id = None
            if kind in ("task", "tile"):
                task = await asyncio.to_thread(_find_task, ctx, about_id, record)
                if task is not None:
                    apply_derived(task, workspace_goals(ctx.path), saving=False)
                    sections.append(context_json("Task", _task_brief(task)))
                    agent = task.get("agent") or {}
                    sections.append(context_json("Linked tab", {
                        "tab_label": agent.get("tab_label"), "pty_id": steward.live_pty(task),
                        "session_id": agent.get("session_id"), "provider": agent.get("provider"),
                    }))
                elif kind == "task":
                    raise StewardError("not found", 404)
                if kind == "tile" and record is not None:
                    sections.append(context_json("Tile", record))
            elif kind == "exploration":
                store = ctx.explorations()
                exp = store.require(str(about_id))
                data = exploration_to_api(exp)
                data.pop("nodes", None)
                sections.append(context_json("Exploration", data))
                sections.append("### Exploration outline\n\n" + store.outline(str(about_id))[: steward.MAX_CONTEXT])
            elif kind == "page":
                # Desk D2: a Page card, read like an exploration (its card and its Page).
                desk = ctx.desk()
                card = await asyncio.to_thread(desk.get_card, str(about_id))
                sections.append(context_json("Page card", {k: v for k, v in card.items() if k != "summary"}))
                page = await asyncio.to_thread(desk.pages.page_text, card["id"])
                sections.append("### The Page\n\n" + page[: steward.MAX_CONTEXT])
            elif kind == "goal":
                goal_id = str(about_id or "")
                status = await asyncio.to_thread(goal_status.build_status, Path(ctx.path), 7)
                entry = next((g for g in status["goals"] if g["id"] == goal_id), None)
                if entry is None:
                    raise StewardError("not found", 404)
                sections.append(context_json(f"Goal {goal_id}", entry))
            elif kind in ("lint", "feed", "operation"):
                sections.append(context_json(kind.capitalize(), record if record is not None else {"id": about_id}))
            mode = steward.classify(question, kind, task)
            if mode == "steer":
                surface = "rail-steer"
            elif kind == "lint":
                surface = "lint-ask"
            else:
                surface = "rail-ask"
            steer_target = {"task_id": task["id"], "pty_id": steward.live_pty(task)} if mode == "steer" and task else None
            _log("steward.request", {"surface": surface, "about_kind": kind, **({"goal_id": goal_id} if goal_id else {})},
                 ctx, request)
            ans = await steward.answer(
                ctx.path, surface, question, "\n\n".join(sections), steer_target=steer_target,
                record={"about": {"kind": kind, "id": about_id} if kind else None},
            )
            return _public(ans)
        return await run(request, op)

    # ------------------------------------------------------------ proposals

    @router.post("/cockpit/proposals/{proposal_id}/outcome")
    async def cockpit_proposal_outcome(proposal_id: str, request: Request):
        async def op(ctx, body):
            async with ctx.lock:
                row = await asyncio.to_thread(
                    steward.ProposalStore(ctx.path).record_outcome, proposal_id, body.get("outcome"), goal_status.utc_now(),
                )
            _log("proposal.outcome", {k: row.get(k) for k in ("proposal_id", "outcome", "action", "surface", "request_id")},
                 ctx, request)
            return {k: row.get(k) for k in ("proposal_id", "outcome", "action", "at")}
        return await run(request, op)

    # ------------------------------------------------------------ GOALS.md drafts

    @router.post("/cockpit/goals/draft")
    async def cockpit_goals_draft(request: Request):
        async def op(ctx, body):
            instruction = body.get("instruction")
            if not isinstance(instruction, str) or not instruction.strip():
                raise BadRequest("instruction is required")
            goal_id = body.get("goal_id")
            if goal_id is not None and not goal_status.is_goal_id(goal_id):
                raise BadRequest("goal_id must be a goal id like G1")
            current = steward.read_goals_text(Path(ctx.path))
            context = "### Current GOALS.md\n\n````markdown\n" + current + "\n````"
            if goal_id:
                context += f"\n\nThe edit is about {goal_id}."
            message = (
                f"{instruction.strip()}\n\nPropose the edit to GOALS.md. Keep its format rules and ids stable. "
                "Reply with a short explanation, then the complete proposed GOALS.md in one fenced ```markdown block."
            )
            _log("steward.request", {"surface": "goal-edit", **({"goal_id": goal_id} if goal_id else {})}, ctx, request)
            ans = await steward.answer(ctx.path, "goal-edit", message, context, record={"goal_id": goal_id})
            proposed = steward.extract_goals_file(ans["raw"])
            draft = {"draft_id": None, "diff": None, "path": None}
            if proposed is not None:
                async with ctx.lock:
                    # against the text the model saw, not a re-read (an edit meanwhile makes apply 409)
                    draft = await asyncio.to_thread(
                        steward.save_draft, Path(ctx.path), proposed, instruction.strip(), goal_id, goal_status.utc_now(),
                        current,
                    )
            text = ans["text"]
            if proposed is not None:
                # The diff is the proposal; keep only the explanation in text.
                text = steward._FENCE_RE.sub("", text).strip() or text
            return {**_public(ans), "text": text, **draft}
        return await run(request, op)

    @router.post("/cockpit/goals/draft/{draft_id}/apply")
    async def cockpit_goals_draft_apply(draft_id: str, request: Request):
        async def op(ctx, body):
            async with ctx.lock:
                return await asyncio.to_thread(steward.apply_draft, Path(ctx.path), draft_id)
        return await run(request, op)

    # ------------------------------------------------------------ build toward

    @router.post("/cockpit/goals/{gid}/workstream")
    async def cockpit_goal_workstream(gid: str, request: Request):
        async def op(ctx, body):
            from ..workstream.models import Workstream, WorkstreamBrief

            goal = next((g for g in load_goals_full(Path(ctx.path))["goals"] if g["id"] == gid), None)
            if goal is None:
                raise StewardError("not found", 404)
            title = body.get("title")
            if title is not None and (not isinstance(title, str) or not title.strip()):
                raise BadRequest("title must be a non-empty string")
            title = " ".join((title or f"Toward {gid}: {goal['title']}").split())[:200]
            prose = (goal.get("prose") or "").strip()
            brief = WorkstreamBrief(objective=f"{gid} {goal['title']}" + (f"\n\n{prose[:800]}" if prose else ""))
            ws = Workstream(title=title, brief=brief, serves=[gid])
            async with ctx.lock:
                store = ctx.ws_store()
                store.create(ws)
                store.save_brief(ws.id, brief)
                ctx.tasks().counter.bump()
            return {"workstream_id": ws.id, "title": ws.title, "phase": ws.phase.value, "serves": [gid]}
        return await run(request, op, 201)

    return router
