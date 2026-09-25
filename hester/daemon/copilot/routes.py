"""
Copilot HTTP routes on the Hester daemon (:9000).

Someday (capture store), the session-start digest and the weekly retro.
Every endpoint takes an explicit ``workspace`` (absolute path), falling back
to the daemon's current workspace, so it works for any open Lee window.
Callers are the shared token (Lee, the renderer) or a paired device token;
the auth middleware puts the caller on ``request.state.principal``.
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...shared.auth import auth_headers
from ...shared.workspace import get_current_workspace
from . import digest as digest_mod
from . import lee_events
from . import retro as retro_mod
from .event_reader import parse_ts
from .someday import SomedayError, SomedayStore, age_ms

logger = logging.getLogger("hester.daemon.copilot.routes")


def _ok(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": True, "data": data})


def _err(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "error": message})


class BadRequest(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def principal_of(request: Request) -> Dict[str, Any]:
    p = getattr(request.state, "principal", None)
    return p if isinstance(p, dict) else {"kind": "shared"}


def caller_actor(request: Request) -> Dict[str, Any]:
    """Device principal -> device actor; the shared token -> the user in Lee."""
    p = principal_of(request)
    if p.get("kind") == "device" and p.get("device_id"):
        return {
            "kind": "user",
            "surface": "device",
            "device_id": str(p["device_id"]),
            "device_kind": str(p.get("device_kind") or "device"),
        }
    return {"kind": "user", "surface": "lee"}


def caller_surface(request: Request) -> str:
    p = principal_of(request)
    if p.get("kind") == "device":
        return str(p.get("device_kind") or "device")
    return "lee"


def resolve_workspace(value: Optional[str]) -> Path:
    if value is None or value == "":
        return get_current_workspace()
    if not isinstance(value, str):
        raise BadRequest("workspace must be a string")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise BadRequest("workspace must be an absolute path")
    if not path.is_dir():
        raise BadRequest("workspace does not exist", 404)
    return path.resolve()


async def _json_body(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        raise BadRequest("body must be JSON")
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    return body


async def fetch_attention_items(timeout: float = 2.0) -> Optional[List[Dict[str, Any]]]:
    """Compact open items from Lee's ``GET /attention``; None when Lee is unreachable."""
    url = f"{lee_events.get_client().lee_url}/attention"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, params={"compact": "1"}, headers=auth_headers())
    except Exception as e:
        logger.debug(f"Lee /attention unreachable: {e}")
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json().get("data") or {}
        items = data.get("items") or []
        return [i for i in items if isinstance(i, dict)]
    except Exception:
        return None


def create_copilot_router() -> APIRouter:
    router = APIRouter(tags=["copilot"])

    # ------------------------------------------------------------------ someday

    @router.post("/someday")
    async def someday_create(request: Request):
        try:
            body = await _json_body(request)
            ws = resolve_workspace(body.get("workspace"))
            source = body.get("source") if isinstance(body.get("source"), dict) else {}
            p = principal_of(request)
            if p.get("kind") == "device":
                source = {"surface": p.get("device_kind") or "device", "device_id": p.get("device_id")}
            tags = body.get("tags") if isinstance(body.get("tags"), list) else None
            item = SomedayStore(ws).create(
                text=body.get("text"),
                as_=body.get("as") or "someday",
                source=source,
                tags=tags,
            )
        except BadRequest as e:
            return _err(str(e), e.status)
        except SomedayError as e:
            return _err(str(e))
        return _ok(item.to_dict(), 201)

    @router.get("/someday")
    async def someday_list(request: Request, workspace: Optional[str] = None, status: str = "open"):
        try:
            ws = resolve_workspace(workspace)
        except BadRequest as e:
            return _err(str(e), e.status)
        if status not in ("open", "all", "explored", "promoted", "dropped", "kept"):
            return _err("status must be open or all")
        return _ok([i.to_dict() for i in SomedayStore(ws).list(status)])

    @router.post("/someday/{item_id}/triage")
    async def someday_triage(item_id: str, request: Request):
        try:
            body = await _json_body(request)
            ws = resolve_workspace(body.get("workspace"))
            note = body.get("note")
            if note is not None and not isinstance(note, str):
                raise BadRequest("note must be a string")
            item = SomedayStore(ws).triage(item_id, str(body.get("action") or ""), note=note)
        except BadRequest as e:
            return _err(str(e), e.status)
        except SomedayError as e:
            return _err(str(e))
        except KeyError:
            return _err("not found", 404)
        lee_events.ingest(
            "someday.triage",
            {"someday_id": item.id, "action": item.triage["action"], "age_ms": age_ms(item)},
            workspace=str(ws),
            actor=caller_actor(request),
        )
        return _ok(item.to_dict())

    # ------------------------------------------------------------------ digest

    @router.get("/copilot/digest")
    async def copilot_digest(
        request: Request,
        workspace: Optional[str] = None,
        since: Optional[str] = None,
        focus: Optional[str] = None,
        only_related: str = "0",
    ):
        try:
            ws = resolve_workspace(workspace)
            since_dt = None
            if since:
                since_dt = parse_ts(since)
                if since_dt is None:
                    raise BadRequest("since must be an ISO 8601 time")
            focus_obj = None
            if focus:
                try:
                    focus_obj = json.loads(focus)
                except json.JSONDecodeError:
                    raise BadRequest("focus must be JSON")
                if focus_obj is not None and not isinstance(focus_obj, dict):
                    raise BadRequest("focus must be a FocusItem object")
        except BadRequest as e:
            return _err(str(e), e.status)

        items = await fetch_attention_items()
        data = await asyncio.to_thread(
            digest_mod.build_digest,
            ws,
            since=since_dt,
            focus=focus_obj,
            only_related=only_related in ("1", "true", "yes"),
            attention_items=items,
        )
        lee_events.ingest(
            "digest.shown",
            {
                "since": data["since"],
                "wins": len(data["wins"]),
                "waiting": len(data["waiting"]),
                "claims": len(data["agent_claims"]),
                "surface": caller_surface(request),
            },
            workspace=data["workspace"],
            actor=caller_actor(request),
        )
        return _ok(data)

    # ------------------------------------------------------------------ retro

    def _week_wins(ws: Path, week: str) -> List[Dict[str, Any]]:
        local_start = retro_mod.week_start(week)
        start = local_start.astimezone().astimezone(timezone.utc)
        # Bound to the end of that ISO week so a past week's retro doesn't
        # count wins made since.
        end = (local_start + timedelta(days=7)).astimezone().astimezone(timezone.utc)
        return digest_mod.verified_wins(ws, since=start, until=min(end, datetime.now(timezone.utc)))

    @router.get("/copilot/retro")
    async def copilot_retro_get(request: Request, workspace: Optional[str] = None):
        try:
            ws = resolve_workspace(workspace)
        except BadRequest as e:
            return _err(str(e), e.status)
        info = retro_mod.status()
        if info["due"] and retro_mod.mark_shown(info["week"]):
            lee_events.ingest(
                "retro.shown", {"week": info["week"], "answered": []},
                workspace=None, actor=caller_actor(request),
            )
        wins = await asyncio.to_thread(_week_wins, ws, info["week"])
        return _ok({
            "week": info["week"],
            "due": info["due"],
            "answered": info["answered"],
            "skipped": info["skipped"],
            "questions": info["questions"],
            "wins": wins,
        })

    @router.post("/copilot/retro")
    async def copilot_retro_post(request: Request):
        try:
            body = await _json_body(request)
            week = body.get("week") or retro_mod.status()["week"]
            if not isinstance(week, str) or not retro_mod.WEEK_RE.match(week):
                raise BadRequest("week must look like 2026-W39")
            try:
                retro_mod.week_start(week)  # rejects W00, W60, W53 in 52-week years
            except ValueError:
                raise BadRequest(f"{week} is not an ISO week")
            try:
                answers = retro_mod.clean_answers(body.get("answers"))
            except ValueError as e:
                raise BadRequest(str(e))
            skipped = bool(body.get("skipped"))
            ws = resolve_workspace(body.get("workspace"))
        except BadRequest as e:
            return _err(str(e), e.status)
        wins = await asyncio.to_thread(_week_wins, ws, week)
        record = retro_mod.save(week, answers=answers, skipped=skipped, wins_count=len(wins))
        if not skipped:
            lee_events.ingest(
                "retro.answered", {"week": week, "answered": [q for q in retro_mod.QUESTION_IDS if q in answers]},
                workspace=None, actor=caller_actor(request),
            )
        return _ok(record)

    return router
