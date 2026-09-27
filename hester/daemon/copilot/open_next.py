"""
Open next (docs/14-Deep-Work.md §8.1): what the next Deep session opens first.

A device (or Lee) picks an exploration or a captured thought; the opener puts
it at the top of "Pick up where you left off". One record per workspace at
``<workspace>/.hester/deep/open_next.json``::

    {"exploration_id": "...", "someday_id": "...", "set_at": "...Z", "surface": "aeronaut"}

It clears itself: when a Deep session record for that exploration starts at
or after ``set_at`` (the next session happened), when the Someday item is no
longer open, or ``MAX_AGE`` after it was set. Reads do the clearing, so every
caller sees the same answer. Deterministic; no model.
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from ..cockpit.explorations import EXP_ID_RE, ExplorationNotFound, ExplorationStore
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


def _session_since(workspace: Path, exp_id: str, set_at: datetime) -> bool:
    """A Deep session record for ``exp_id`` that started at or after ``set_at``."""
    from ..cockpit import deep

    try:
        records = deep.list_sessions(ExplorationStore(workspace), exp_id)
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
    exp_id = rec.get("exploration_id")
    if isinstance(exp_id, str) and exp_id and _session_since(workspace, exp_id, set_at):
        return True
    sd_id = rec.get("someday_id")
    if isinstance(sd_id, str) and sd_id and not exp_id:
        item = SomedayStore(workspace).get(sd_id)
        if item is None or item.status != "open":
            return True
    return False


def get(workspace: Path, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The live record, or None (clearing a stale one)."""
    now = now or datetime.now(timezone.utc)
    rec = _read(workspace)
    if rec is None:
        return None
    if _stale(workspace, rec, now):
        clear(workspace)
        return None
    out: Dict[str, Any] = {"set_at": rec.get("set_at"), "surface": rec.get("surface") or "lee"}
    for key in ("exploration_id", "someday_id"):
        if isinstance(rec.get(key), str) and rec[key]:
            out[key] = rec[key]
    return out


def set_(
    workspace: Path,
    *,
    exploration_id: Any = None,
    someday_id: Any = None,
    surface: str = "lee",
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Validate and write; replaces any earlier pick. 400 on bad ids, 404 on missing ones."""
    now = now or datetime.now(timezone.utc)
    if exploration_id in ("", None) and someday_id in ("", None):
        raise OpenNextError("exploration_id or someday_id is required")
    rec: Dict[str, Any] = {}
    if exploration_id not in ("", None):
        if not isinstance(exploration_id, str) or not EXP_ID_RE.match(exploration_id):
            raise OpenNextError("exploration_id is not an exploration id")
        try:
            exp = ExplorationStore(workspace).get(exploration_id)
        except ExplorationNotFound:
            exp = None
        except Exception:
            exp = None
        if exp is None:
            raise OpenNextError("exploration not found", 404)
        rec["exploration_id"] = exploration_id
    if someday_id not in ("", None):
        if not isinstance(someday_id, str) or not SOMEDAY_ID_RE.match(someday_id):
            raise OpenNextError("someday_id is not a Someday id")
        if SomedayStore(workspace).get(someday_id) is None:
            raise OpenNextError("someday item not found", 404)
        rec["someday_id"] = someday_id
    rec["set_at"] = iso_s(now)
    rec["surface"] = str(surface or "lee")
    atomic_write(path_for(workspace), json.dumps(rec, indent=2) + "\n")
    return dict(rec)


def on_session(workspace: Path, exp_id: str, record: Dict[str, Any]) -> bool:
    """A session record was posted: clear the pick if it was for this exploration and set before the session started."""
    rec = _read(workspace)
    if rec is None or rec.get("exploration_id") != exp_id:
        return False
    set_at = parse_ts(rec.get("set_at"))
    started = parse_ts(record.get("started_at"))
    if set_at is None or (started is not None and started >= set_at):
        return clear(workspace)
    return False
