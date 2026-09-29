"""
Read-only access to Lee's machine-wide event log (``~/.lee/events/``).

One file per local calendar day, ``YYYY-MM-DD.jsonl``, continued in
``YYYY-MM-DD.1.jsonl``, ``.2.jsonl``... past the size cap. Each line is a
LeeEvent whose ``ts`` is UTC. Lee main is the only writer; Hester only reads.
"""

import json
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional

logger = logging.getLogger("hester.daemon.copilot.event_reader")

_FILE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$")


def events_dir() -> Path:
    override = os.environ.get("LEE_EVENTS_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".lee" / "events"


def parse_ts(value: Any) -> Optional[datetime]:
    """Parse an ISO 8601 timestamp to an aware UTC datetime (naive input is taken as UTC)."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value:
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def list_files(directory: Optional[Path] = None) -> List[tuple]:
    """[(local date, suffix, path)] sorted by date then suffix."""
    d = Path(directory) if directory else events_dir()
    out = []
    try:
        entries = list(d.iterdir())
    except OSError:
        return []
    for p in entries:
        m = _FILE_RE.match(p.name)
        if not m:
            continue
        try:
            day = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            continue
        out.append((day, int(m.group(4) or 0), p))
    out.sort(key=lambda t: (t[0], t[1]))
    return out


def iter_events(
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    directory: Optional[Path] = None,
    types: Optional[Iterable[str]] = None,
) -> Iterator[Dict[str, Any]]:
    """Yield events with ``since <= ts < until`` in file order. Bad lines are skipped."""
    type_set = set(types) if types else None
    needles = [f'"{t}"' for t in type_set] if type_set else None
    # File names are local dates; widen by a day on each side for time zones.
    first_day = (since.astimezone() - timedelta(days=1)).date() if since else None
    last_day = (until.astimezone() + timedelta(days=1)).date() if until else None
    for day, _suffix, path in list_files(directory):
        if first_day and day < first_day:
            continue
        if last_day and day > last_day:
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if needles and not any(n in line for n in needles):
                        continue
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(ev, dict):
                        continue
                    if type_set and ev.get("type") not in type_set:
                        continue
                    ts = parse_ts(ev.get("ts"))
                    if ts is None:
                        continue
                    if since and ts < since:
                        continue
                    if until and ts >= until:
                        continue
                    ev["_ts"] = ts
                    yield ev
        except OSError as e:
            logger.debug(f"Cannot read {path}: {e}")


def read_events(
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    directory: Optional[Path] = None,
    types: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """Like iter_events, sorted by ``ts`` (stable). Each event gets ``_ts`` (datetime)."""
    events = list(iter_events(since, until, directory, types))
    events.sort(key=lambda e: e["_ts"])
    return events
