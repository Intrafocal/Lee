"""
Open next (docs/14-Deep-Work.md §8.1; Desk D2 contract §6.4): what the next
Deep session opens first.

A device (or Lee) picks a Desk card or a captured thought; ``GET /desk/last``
and the opener put it first. One record per workspace at
``<workspace>/.hester/deep/open_next.json``::

    {"card_id": "pg-...", "someday_id": "...", "set_at": "...Z", "surface": "aeronaut"}

``exploration_id`` is a legacy alias: a POST with one is mapped to its card
through the Desk migration, and a record written before the Desk is rewritten
by the migration. It clears itself: when a Desk session record whose
``cards_touched`` includes the card starts at or after ``set_at`` (the next
session happened), when the Someday item is no longer open, or ``MAX_AGE``
after it was set. Reads do the clearing, so every caller sees the same
answer. Deterministic; no model.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from ..cockpit.explorations import EXP_ID_RE
from ..cockpit.tasks import atomic_write, iso_s
from .event_reader import parse_ts
from .someday import ID_RE as SOMEDAY_ID_RE
from .someday import SomedayStore

logger = logging.getLogger("hester.daemon.copilot.open_next")

MAX_AGE = timedelta(days=3)
FILE = Path(".hester") / "deep" / "open_next.json"


class OpenNextError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def path_for(workspace: Path) -> Path:
    return Path(workspace) / FILE


def _read(workspace: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path_for(workspace), "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        logger.debug(f"open_next unreadable: {e}")
        return None
    return data if isinstance(data, dict) else None


def clear(workspace: Path) -> bool:
    try:
        os.unlink(path_for(workspace))
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        logger.debug(f"open_next not cleared: {e}")
        return False


def _touches(record: Dict[str, Any], card_id: str) -> bool:
    return card_id in (record.get("cards_touched") or []) or record.get("stopped_card_id") == card_id


def _session_since(workspace: Path, card_id: str, set_at: datetime) -> bool:
    """A Desk session record that touched ``card_id`` and started at or after ``set_at``."""
    from ..cockpit.desk import DeskStore

    try:
        records = DeskStore(workspace).list_sessions()
    except Exception:
        return False
    for r in records:
        started = parse_ts(r.get("started_at"))
        if started is not None and started >= set_at and _touches(r, card_id):
            return True
    return False


def _legacy_session_since(workspace: Path, exp_id: str, set_at: datetime) -> bool:
    """A record from before the Desk: the exploration's own session that started at or after ``set_at``."""
    from ..cockpit import deep
    from ..cockpit.explorations import ExplorationStore

    try:
        records = deep.read_jsonl(ExplorationStore(workspace).exp_dir(exp_id) / deep.SESSIONS_FILE)
    except Exception:
        return False
    for r in records:
        started = parse_ts(r.get("started_at"))
        if started is not None and started >= set_at:
            return True
    return False


def _stale(workspace: Path, rec: Dict[str, Any], now: datetime) -> bool:
    set_at = parse_ts(rec.get("set_at"))
    if set_at is None or now - set_at >= MAX_AGE:
        return True
    card_id = rec.get("card_id")
    if isinstance(card_id, str) and card_id and _session_since(workspace, card_id, set_at):
        return True
    exp_id = rec.get("exploration_id")
    if not card_id and isinstance(exp_id, str) and exp_id and _legacy_session_since(workspace, exp_id, set_at):
        return True
    sd_id = rec.get("someday_id")
    if isinstance(sd_id, str) and sd_id and not card_id and not exp_id:
        item = SomedayStore(workspace).get(sd_id)
        if item is None or item.status != "open":
            return True
    return False


def _api(rec: Dict[str, Any]) -> Dict[str, Any]:
    """``{card_id?, exploration_id? (= card_id), someday_id?, set_at, surface}``."""
    out: Dict[str, Any] = {}
    card_id = rec.get("card_id")
    if isinstance(card_id, str) and card_id:
        out["card_id"] = card_id
        out["exploration_id"] = card_id  # legacy alias for devices from before the Desk
    elif isinstance(rec.get("exploration_id"), str) and rec["exploration_id"]:
        out["exploration_id"] = rec["exploration_id"]  # written before the Desk, not migrated yet
    if isinstance(rec.get("someday_id"), str) and rec["someday_id"]:
        out["someday_id"] = rec["someday_id"]
    out["set_at"] = rec.get("set_at")
    out["surface"] = rec.get("surface") or "lee"
    return out


def get(workspace: Path, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The live record, or None (clearing a stale one)."""
    now = now or datetime.now(timezone.utc)
    rec = _read(workspace)
    if rec is None:
        return None
    if _stale(workspace, rec, now):
        clear(workspace)
        return None
    return _api(rec)


def set_(
    workspace: Path,
    *,
    card_id: Any = None,
    exploration_id: Any = None,
    someday_id: Any = None,
    surface: str = "lee",
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Validate and write; replaces any earlier pick. ``exploration_id`` (legacy)
    maps to its card through the migration, which runs first when it's due
    (callers hold the workspace lock). 400 on bad ids, 404 on missing ones.
    """
    from ..cockpit.desk import DeskStore, is_page_id

    now = now or datetime.now(timezone.utc)
    if card_id in ("", None) and exploration_id in ("", None) and someday_id in ("", None):
        raise OpenNextError("card_id, exploration_id or someday_id is required")
    rec: Dict[str, Any] = {}
    desk = DeskStore(workspace)
    if card_id not in ("", None) or exploration_id not in ("", None):
        legacy = card_id in ("", None)
        value = exploration_id if legacy else card_id
        ok = is_page_id(value) or (legacy and isinstance(value, str) and bool(EXP_ID_RE.match(value)))
        if not ok:
            raise OpenNextError("exploration_id is not an exploration id" if legacy else "card_id is not a card id")
        desk.load(now)
        mapped = value if is_page_id(value) else desk.card_for_exploration(value)
        if mapped is None or not desk.pages.exists(mapped):
            raise OpenNextError("card not found", 404)
        rec["card_id"] = mapped
    if someday_id not in ("", None):
        if not isinstance(someday_id, str) or not SOMEDAY_ID_RE.match(someday_id):
            raise OpenNextError("someday_id is not a Someday id")
        if SomedayStore(workspace).get(someday_id) is None:
            raise OpenNextError("someday item not found", 404)
        rec["someday_id"] = someday_id
    rec["set_at"] = iso_s(now)
    rec["surface"] = str(surface or "lee")
    atomic_write(path_for(workspace), json.dumps(rec, indent=2) + "\n")
    return _api(rec)


def _clear_if_after(workspace: Path, rec: Dict[str, Any], record: Dict[str, Any]) -> bool:
    set_at = parse_ts(rec.get("set_at"))
    started = parse_ts(record.get("started_at"))
    if set_at is None or (started is not None and started >= set_at):
        return clear(workspace)
    return False


def on_desk_session(workspace: Path, record: Dict[str, Any]) -> bool:
    """A Desk session record was posted: clear the pick when the session touched its card and started after it was set."""
    rec = _read(workspace)
    card_id = (rec or {}).get("card_id")
    if not card_id or not _touches(record, card_id):
        return False
    return _clear_if_after(workspace, rec, record)


def on_session(workspace: Path, exp_id: str, record: Dict[str, Any]) -> bool:
    """An exploration's session record was posted (the pre-Desk route): clear a pick for it or for its card."""
    from ..cockpit.desk import DeskStore

    rec = _read(workspace)
    if rec is None:
        return False
    if rec.get("card_id"):
        if DeskStore(workspace).card_for_exploration(exp_id) != rec["card_id"]:
            return False
    elif rec.get("exploration_id") != exp_id:
        return False
    return _clear_if_after(workspace, rec, record)
