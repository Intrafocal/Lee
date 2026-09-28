"""
The opener (Deep D1 contract section 8.1; spec 14 section 6; Desk D2 §6.4).

``build_opener`` assembles the top of the Copilot section: where you left off
and every surface that could get your brain working, in a fixed order. It is
assembly, not generation: deterministic, from records, with no model client.
It ranks nothing beyond "pick up where you left off" first, and that is the
Desk's ``GET /desk/last``: the last card zoomed into, the last session's card,
or the most recently written one.

The surfaces read the Desk (``.hester/desk/``; the migration runs first when
it's due). Items carry ``card_id`` (and ``card_title``), and keep
``exploration_id`` / ``exploration_title`` as legacy aliases holding the card's.

Before building, it writes the Desk session records Deep sessions that ended
``away`` or ``quit`` never got from the ending ritual (it sees their
``focus.*`` in Lee's event log), so "stopped at" and "arrived since" have a
session to measure from. Callers hold the workspace lock.
"""

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..cockpit import deep
from ..cockpit.desk import DeskStore, is_card_id, page_id_for_exploration
from ..cockpit.goal_status import QUIET_DAYS
from .digest import q2_candidates_safe
from .event_reader import iso, parse_ts, read_events
from .ideas import IdeasStore

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
    """
    ``{focus_session_id: {started_at, ended_at, reason, items, workspace}}`` for
    ``source: 'deep'``. ``items`` are the session's ``focus.start`` and
    ``focus.item`` refs in order: ``('card', pg-…)`` for Desk items (Desk D2)
    and ``('exploration', exp-…)`` for the pre-Desk ones.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for ev in events:
        t = ev.get("type")
        d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        sid = d.get("session_id")
        if not sid:
            continue
        if t == "focus.start" and d.get("source") == "deep":
            out[sid] = {"started_at": ev.get("ts"), "ended_at": None, "reason": None, "items": [], "workspace": None}
        if sid not in out:
            continue
        item = d.get("item") if isinstance(d.get("item"), dict) else None
        if t in ("focus.start", "focus.item") and item and item.get("kind") in ("card", "exploration"):
            out[sid]["workspace"] = item.get("workspace") or out[sid]["workspace"]
            ref = item.get("card_id") if item["kind"] == "card" else item.get("exploration_id")
            if isinstance(ref, str) and ref:
                out[sid]["items"].append((item["kind"], ref))
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


def session_cards(desk: DeskStore, items: List[Any]) -> List[str]:
    """The session's card ids in first-touched order (exploration refs through the migration); unknown ones dropped."""
    out: List[str] = []
    for kind, ref in items:
        card = ref if kind == "card" and is_card_id(ref) else None
        if kind == "exploration":
            card = desk.card_for_exploration(ref) or page_id_for_exploration(ref)
        if card and card not in out and desk.card_exists(card):
            out.append(card)
    return out


def _last_card(desk: DeskStore, items: List[Any]) -> Optional[str]:
    for kind, ref in reversed(items):
        found = session_cards(desk, [(kind, ref)])
        if found:
            return found[0]
    return None


def write_missing_sessions(desk: DeskStore, sessions: Dict[str, Dict[str, Any]]) -> int:
    """
    A ``DeskSessionRecord`` (no stopped-at, no rating) for each Deep session
    in this workspace that ended away or quit without one. ``cards_touched``
    comes from its ``focus.start`` and ``focus.item`` card ids; the last of
    them is ``stopped_card_id``.
    """
    known = {r.get("focus_session_id") for r in desk.list_sessions()}
    written = 0
    for sid, s in sessions.items():
        if s.get("reason") not in AUTO_REASONS or not s.get("ended_at") or sid in known:
            continue
        if not _same_ws(s.get("workspace"), desk.workspace) or not s.get("items"):
            continue
        cards = session_cards(desk, s["items"])
        if not cards:
            continue
        desk.add_session({
            "focus_session_id": sid, "started_at": s.get("started_at") or s["ended_at"], "ended_at": s["ended_at"],
            "reason": s["reason"], "stopped_at": None, "rating": None, "questions_kept": [],
            "cards_touched": cards, "stopped_card_id": _last_card(desk, s["items"]),
        })
        written += 1
    return written


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def pick_up_from(last: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The opener's ``pick_up`` from ``GET /desk/last`` (``exploration`` is the legacy alias)."""
    card = last.get("card")
    if not card:
        return None
    arrived = last.get("arrived") or {}
    return {
        "card": card,
        "exploration": {"id": card["id"], "title": card.get("title"), "last_touched_at": card.get("last_touched_at")},
        "stopped_at": last.get("stopped_at"),
        "stopped_line": last.get("stopped_line"),
        "arrived": {
            "answers": int(arrived.get("answers") or 0) + int(arrived.get("handoffs") or 0),
            "open_questions": int(arrived.get("open_questions") or 0),
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
    desk = DeskStore(ws)
    desk.load(now)  # migrates first when it's due

    events = read_events(since=now - EVENTS_LOOKBACK, until=now + timedelta(seconds=1), directory=events_dir)
    sessions = deep_sessions(events)
    write_missing_sessions(desk, sessions)

    pick_up = pick_up_from(desk.last(now))
    cards = desk.briefs(on_desk=True)

    # The end of the last Deep session (records, or the log for sessions with nothing open).
    ends = [parse_ts(r.get("ended_at")) for r in desk.list_sessions()]
    ends += [
        parse_ts(s.get("ended_at")) for s in sessions.values()
        if s.get("ended_at") and _same_ws(s.get("workspace"), ws)
    ]
    ends = [e for e in ends if e is not None and e <= now]
    last_end = max(ends) if ends else None

    surfaces: List[Dict[str, Any]] = [{"kind": "blank"}]

    questions = []
    for card in cards:
        for q in deep.list_questions(desk.store(card["id"]), card["id"]):
            if q.get("status") == "open":
                questions.append({
                    "card_id": card["id"], "card_title": card["title"],
                    "exploration_id": card["id"], "exploration_title": card["title"],
                    "question_id": q["id"], "text": q.get("text"), "_at": str(q.get("at") or ""),
                })
    questions.sort(key=lambda q: q["_at"], reverse=True)
    if questions:
        surfaces.append({"kind": "open_questions", "count": len(questions),
                         "items": [{k: v for k, v in q.items() if k != "_at"} for q in questions[:MAX_ITEMS]]})

    since = last_end or (now - CAPTURED_FALLBACK)
    captured = []
    for item in IdeasStore(ws).list("open"):
        created = parse_ts(item.created_at)
        if item.source.get("surface") in AWAY_SURFACES and created is not None and created > since:
            captured.append({"someday_id": item.id, "text": _clip(item.text, MAX_ITEM_TEXT),
                             "surface": item.source.get("surface"), "created_at": item.created_at})
    captured.sort(key=lambda c: str(c["created_at"]), reverse=True)
    if captured:
        surfaces.append({"kind": "captured_away", "count": len(captured), "items": captured[:MAX_ITEMS]})

    reading = []
    for card in cards:
        for r in deep.list_references(desk.store(card["id"]), card["id"]):
            if r.get("kind") == "link" and not r.get("opened_at") and r.get("url"):
                reading.append({"card_id": card["id"], "exploration_id": card["id"], "reference_id": r["id"],
                                "title": r.get("title") or r["url"], "url": r["url"], "_at": str(r.get("at") or "")})
    reading.sort(key=lambda r: r["_at"], reverse=True)
    if reading:
        surfaces.append({"kind": "reading_list", "count": len(reading),
                         "items": [{k: v for k, v in r.items() if k != "_at"} for r in reading[:MAX_ITEMS]]})

    q2 = [c for c in q2_candidates_safe(ws, now) if c.get("kind") != "page-quiet"][:MAX_Q2]
    if q2:
        surfaces.append({"kind": "q2", "items": q2})

    picked = ((pick_up or {}).get("card") or {}).get("id")
    quiet = []
    for card in cards:
        touched = parse_ts(card.get("last_touched_at") or card.get("created_at"))
        if card["id"] == picked or touched is None or (now - touched).days < QUIET_DAYS:
            continue
        quiet.append({"card_id": card["id"], "exploration_id": card["id"], "title": card["title"],
                      "last_touched_at": card.get("last_touched_at")})
    quiet.sort(key=lambda q: str(q.get("last_touched_at") or ""), reverse=True)
    if quiet:
        surfaces.append({"kind": "quiet", "items": quiet[:MAX_QUIET]})

    return {"generated_at": iso(now), "workspace": str(ws), "pick_up": pick_up, "surfaces": surfaces}
