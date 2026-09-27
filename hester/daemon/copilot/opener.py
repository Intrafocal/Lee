"""
The opener (Deep D1 contract section 8.1; spec 14 section 6).

``build_opener`` assembles the top of the Copilot section: where you left off
and every surface that could get your brain working, in a fixed order. It is
assembly, not generation: deterministic, from records, with no model client.
It ranks nothing beyond "pick up where you left off" first.

Before building, it writes the session records Deep sessions that ended
``away`` or ``quit`` never got from the ending ritual (it sees their
``focus.end`` in Lee's event log), so "stopped at" and "arrived since" have a
session to measure from. Callers hold the workspace lock.
"""

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..cockpit import deep
from ..cockpit.explorations import ExplorationStore
from ..cockpit.goal_status import QUIET_DAYS
from .digest import q2_candidates_safe
from .event_reader import iso, parse_ts, read_events
from .someday import SomedayStore

logger = logging.getLogger("hester.daemon.copilot.opener")

SURFACE_ORDER = ("blank", "open_questions", "captured_away", "reading_list", "q2", "quiet")
AWAY_SURFACES = ("aeronaut", "dirigible", "device")
EVENTS_LOOKBACK = timedelta(days=30)
CAPTURED_FALLBACK = timedelta(days=7)
MAX_ITEMS = 10
MAX_Q2 = 5
MAX_QUIET = 5
MAX_STOPPED_LINE = 160
MAX_ITEM_TEXT = 280
AUTO_REASONS = ("away", "quit")


def _clip(text: Any, limit: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _tail(text: str, limit: int) -> str:
    """The end of a line, keeping where you stopped: ``…the vector clock only helps if every write``."""
    s = " ".join(text.split())
    return s if len(s) <= limit else "…" + s[-(limit - 1):]


# ---------------------------------------------------------------------------
# Deep sessions from the event log
# ---------------------------------------------------------------------------


def deep_sessions(events: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """``{focus_session_id: {started_at, ended_at, reason, exploration_id, workspace}}`` for ``source: 'deep'``."""
    out: Dict[str, Dict[str, Any]] = {}
    for ev in events:
        t = ev.get("type")
        d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        sid = d.get("session_id")
        if not sid:
            continue
        if t == "focus.start" and d.get("source") == "deep":
            out[sid] = {"started_at": ev.get("ts"), "ended_at": None, "reason": None,
                        "exploration_id": None, "workspace": None}
        if sid not in out:
            continue
        item = d.get("item") if isinstance(d.get("item"), dict) else None
        if t in ("focus.start", "focus.item") and item and item.get("kind") == "exploration":
            out[sid]["exploration_id"] = item.get("exploration_id")
            out[sid]["workspace"] = item.get("workspace")
        elif t == "focus.end":
            out[sid]["ended_at"] = ev.get("ts")
            out[sid]["reason"] = d.get("reason")
    return out


def _same_ws(a: Any, b: Path) -> bool:
    if not isinstance(a, str) or not a:
        return False
    try:
        return Path(a).resolve() == Path(b).resolve()
    except OSError:
        return False


def write_missing_sessions(
    store: ExplorationStore, sessions: Dict[str, Dict[str, Any]], known: Dict[str, Any],
) -> int:
    """A ``SessionRecord`` (no stopped-at, no rating) for each Deep session that ended away or quit without one."""
    written = 0
    for sid, s in sessions.items():
        exp_id = s.get("exploration_id")
        if s.get("reason") not in AUTO_REASONS or not s.get("ended_at") or not deep.is_exploration_id(exp_id):
            continue
        if not _same_ws(s.get("workspace"), store.workspace) or exp_id not in known:
            continue
        if any(r.get("focus_session_id") == sid for r in deep.list_sessions(store, exp_id)):
            continue
        deep.add_session(store, exp_id, {
            "focus_session_id": sid, "started_at": s.get("started_at") or s["ended_at"], "ended_at": s["ended_at"],
            "reason": s["reason"], "stopped_at": None, "rating": None, "questions_kept": [],
        })
        written += 1
    return written


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def _touched(exp: Dict[str, Any]) -> str:
    return max(str(exp.get("last_touched_at") or exp.get("updated_at") or ""), str(exp.get("page_updated_at") or ""))


def _pick_up(
    store: ExplorationStore, active: List[Dict[str, Any]], records: Dict[str, List[Dict[str, Any]]],
) -> Optional[Dict[str, Any]]:
    latest: Optional[Tuple[str, Dict[str, Any], Dict[str, Any]]] = None
    for exp in active:
        for r in records.get(exp["id"], []):
            key = str(r.get("ended_at") or "")
            if latest is None or key > latest[0]:
                latest = (key, exp, r)
    if latest is not None:
        exp, last = latest[1], latest[2]
    else:
        written = [e for e in active if int(e.get("page_chars") or 0) > 0]
        if not written:
            return None
        exp = max(written, key=_touched)
        last = None
    page = deep.read_page_text(store, exp["id"])
    stopped = (last or {}).get("stopped_at")
    if not stopped:
        line = deep.last_nonempty_line(page)
        stopped = _tail(line, MAX_STOPPED_LINE) if line else None
    since = parse_ts((last or {}).get("ended_at"))
    answers = 0
    for a in deep.list_answers(store, exp["id"]):
        if a.get("status") != "done":
            continue
        if since is None:
            answers += 0 if (a.get("read_at") or a.get("dismissed_at")) else 1
        else:
            at = parse_ts(a.get("answered_at"))
            answers += 1 if at is not None and at > since else 0
    return {
        "exploration": {"id": exp["id"], "title": exp.get("title"), "last_touched_at": exp.get("last_touched_at")},
        "stopped_at": stopped,
        "arrived": {
            "answers": answers,
            "open_questions": sum(1 for q in exp.get("questions") or [] if q.get("status") == "open"),
        },
    }


def build_opener(
    workspace: Path,
    *,
    now: Optional[datetime] = None,
    events_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    ws = Path(workspace)
    store = ExplorationStore(ws)

    events = read_events(since=now - EVENTS_LOOKBACK, until=now + timedelta(seconds=1), directory=events_dir)
    sessions = deep_sessions(events)
    everything = {e["id"]: e for e in store.load_all()}
    if write_missing_sessions(store, sessions, everything):
        everything = {e["id"]: e for e in store.load_all()}
    active = [e for e in everything.values() if e.get("status") == "active"]
    records = {e["id"]: deep.list_sessions(store, e["id"]) for e in active}

    pick_up = _pick_up(store, active, records)

    # The end of the last Deep session (records, or the log for sessions with nothing open).
    ends = [parse_ts(r.get("ended_at")) for rows in records.values() for r in rows]
    ends += [
        parse_ts(s.get("ended_at")) for s in sessions.values()
        if s.get("ended_at") and _same_ws(s.get("workspace"), ws)
    ]
    ends = [e for e in ends if e is not None and e <= now]
    last_end = max(ends) if ends else None

    surfaces: List[Dict[str, Any]] = [{"kind": "blank"}]

    questions = []
    for exp in active:
        for q in exp.get("questions") or []:
            if q.get("status") == "open":
                questions.append({
                    "exploration_id": exp["id"], "exploration_title": exp.get("title"),
                    "question_id": q["id"], "text": q.get("text"), "_at": str(q.get("at") or ""),
                })
    questions.sort(key=lambda q: q["_at"], reverse=True)
    if questions:
        surfaces.append({"kind": "open_questions", "count": len(questions),
                         "items": [{k: v for k, v in q.items() if k != "_at"} for q in questions[:MAX_ITEMS]]})

    since = last_end or (now - CAPTURED_FALLBACK)
    captured = []
    for item in SomedayStore(ws).list("open"):
        created = parse_ts(item.created_at)
        if item.source.get("surface") in AWAY_SURFACES and created is not None and created > since:
            captured.append({"someday_id": item.id, "text": _clip(item.text, MAX_ITEM_TEXT),
                             "surface": item.source.get("surface"), "created_at": item.created_at})
    captured.sort(key=lambda c: str(c["created_at"]), reverse=True)
    if captured:
        surfaces.append({"kind": "captured_away", "count": len(captured), "items": captured[:MAX_ITEMS]})

    reading = []
    for exp in active:
        for r in deep.list_references(store, exp["id"]):
            if r.get("kind") == "link" and not r.get("opened_at") and r.get("url"):
                reading.append({"exploration_id": exp["id"], "reference_id": r["id"],
                                "title": r.get("title") or r["url"], "url": r["url"], "_at": str(r.get("at") or "")})
    reading.sort(key=lambda r: r["_at"], reverse=True)
    if reading:
        surfaces.append({"kind": "reading_list", "count": len(reading),
                         "items": [{k: v for k, v in r.items() if k != "_at"} for r in reading[:MAX_ITEMS]]})

    q2 = [c for c in q2_candidates_safe(ws, now) if c.get("kind") != "exploration-quiet"][:MAX_Q2]
    if q2:
        surfaces.append({"kind": "q2", "items": q2})

    picked = (pick_up or {}).get("exploration", {}).get("id")
    quiet = []
    for exp in active:
        touched = parse_ts(exp.get("last_touched_at") or exp.get("updated_at"))
        if exp["id"] == picked or touched is None or (now - touched).days < QUIET_DAYS:
            continue
        quiet.append({"exploration_id": exp["id"], "title": exp.get("title"), "last_touched_at": exp.get("last_touched_at")})
    quiet.sort(key=lambda q: str(q.get("last_touched_at") or ""), reverse=True)
    if quiet:
        surfaces.append({"kind": "quiet", "items": quiet[:MAX_QUIET]})

    return {"generated_at": iso(now), "workspace": str(ws), "pick_up": pick_up, "surfaces": surfaces}
