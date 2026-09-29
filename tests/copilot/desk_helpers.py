"""Small builders for Desk D2 tests (contract docs/plans/2026-09-27-desk-foundation-contract.md)."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from hester.daemon.cockpit.desk import DeskStore


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def main_area(desk: DeskStore, now: Optional[datetime] = None) -> str:
    raw = desk.load(now)
    return next(a["id"] for a in raw["areas"] if not a.get("drawer_id"))


def page(desk: DeskStore, title: str = "Untitled", text: str = "", now: Optional[datetime] = None,
         area_id: Optional[str] = None) -> Dict[str, Any]:
    card, _, _ = desk.create_page({"area_id": area_id or main_area(desk, now), "title": title, "text": text}, now)
    return card


def session(desk: DeskStore, cards: List[str], start: datetime, end: datetime, fsid: str = "f1",
            reason: str = "ritual", stopped_at: Optional[str] = None, rating: Optional[str] = None,
            stopped_card_id: Any = "last") -> Dict[str, Any]:
    return desk.add_session({
        "focus_session_id": fsid, "started_at": iso(start), "ended_at": iso(end), "reason": reason,
        "stopped_at": stopped_at, "rating": rating, "questions_kept": [], "cards_touched": cards,
        "stopped_card_id": (cards[-1] if cards else None) if stopped_card_id == "last" else stopped_card_id,
    })
