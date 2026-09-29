"""
Cockpit History: verified wins, tasks closed in range and operation readings.
Deterministic, no model. v4: closed tasks carry ``goal_impact`` (the goals
they served) and readings of a GOALS metric carry ``goal_id`` and ``delta``.
"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from ..copilot.digest import verified_wins
from ..copilot.event_reader import iso
from .readings import ReadingsStore
from .goals import load_goals_full
from .tasks import CockpitTaskStore, parse_time, to_api

MAX_DAYS = 90


def goal_metric_index(workspace: Path) -> Dict[Any, str]:
    """(``metric``, name) and (``op``, measure op) -> goal id, first goal in priority order wins."""
    out: Dict[Any, str] = {}
    for g in load_goals_full(workspace)["goals"]:
        for m in g["metrics"]:
            out.setdefault(("metric", m["name"]), g["id"])
            if m.get("measure"):
                out.setdefault(("op", m["measure"]), g["id"])
    return out


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

    goal_ids = {g["id"] for g in load_goals_full(Path(workspace))["goals"]}
    for t in tasks:
        t["goal_impact"] = [g for g in t.get("serves") or [] if g in goal_ids]

    readings = ReadingsStore(workspace).with_previous(iso(since), iso(until))
    metric_goal = goal_metric_index(Path(workspace))
    for r in readings:
        src = r.get("source") or {}
        gid = metric_goal.get(("metric", r.get("metric"))) or metric_goal.get(("op", src.get("op")))
        r["goal_id"] = gid
        value, prev = r.get("value"), r.get("previous")
        numeric = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (value, prev))
        r["delta"] = round(value - prev, 6) if numeric else None
    return {
        "workspace": str(workspace),
        "since": iso(since),
        "wins": wins,
        "tasks": tasks,
        "readings": readings,
    }
