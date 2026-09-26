"""
Cockpit History: verified wins, tasks closed in range and operation readings.
Deterministic, no model. Goal-impact wording is v4.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from ..copilot.digest import verified_wins
from ..copilot.event_reader import iso
from .readings import ReadingsStore
from .tasks import CockpitTaskStore, parse_time, to_api

MAX_DAYS = 90


def build_history(
    workspace: Path,
    days: int = 7,
    now: Optional[datetime] = None,
    events_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    until = now + timedelta(seconds=1)
    wins = verified_wins(Path(workspace), since=since, until=until, events_dir=events_dir)

    tasks = []
    for task in CockpitTaskStore(workspace).load_all():
        closed = parse_time(task.get("closed_at"))
        if task.get("status") in ("done", "discarded") and closed and since <= closed < until:
            tasks.append(to_api(task))
    tasks.sort(key=lambda t: str(t.get("closed_at") or ""), reverse=True)

    readings = ReadingsStore(workspace).with_previous(iso(since), iso(until))
    return {
        "workspace": str(workspace),
        "since": iso(since),
        "wins": wins,
        "tasks": tasks,
        "readings": readings,
    }
