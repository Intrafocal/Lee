"""
Weekly retro (v1): schedule, due state and storage.

Schedule: ``copilot.retro`` in ``~/.config/lee/config.yaml`` / ``~/.lee/config.yaml``
(``day: fri``, ``time: "16:00"`` by default; Lee ignores the key). The retro is
due from that local time until answered or skipped, for that ISO week.
Storage: ``~/.hester/retro/<YYYY>-W<ww>.json`` (machine-wide).
"""

import json
import os
import re
import tempfile
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

QUESTIONS: List[Dict[str, str]] = [
    {"id": "ideas_or_plumbing", "text": "Ideas or plumbing?"},
    {"id": "stuck_good_bad", "text": "Where were you stuck in a good way, and where in a bad way?"},
    {"id": "surprise", "text": "Did Hester show you something about your work you didn't already know?"},
]
QUESTION_IDS = [q["id"] for q in QUESTIONS]
MAX_ANSWER = 4000

DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
DEFAULT_DAY = "fri"
DEFAULT_TIME = "16:00"
WEEK_RE = re.compile(r"^(\d{4})-W(\d{2})$")


def retro_dir() -> Path:
    override = os.environ.get("HESTER_RETRO_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".hester" / "retro"


def load_copilot_config() -> Dict[str, Any]:
    """The machine-wide ``copilot:`` block (``~/.config/lee`` then ``~/.lee``, later wins)."""
    merged: Dict[str, Any] = {}
    home = Path.home()
    for path in (home / ".config" / "lee" / "config.yaml", home / ".lee" / "config.yaml"):
        try:
            doc = yaml.safe_load(path.read_text()) or {}
        except (OSError, yaml.YAMLError):
            continue
        block = doc.get("copilot") if isinstance(doc, dict) else None
        if isinstance(block, dict):
            for k, v in block.items():
                if isinstance(v, dict) and isinstance(merged.get(k), dict):
                    merged[k] = {**merged[k], **v}
                else:
                    merged[k] = v
    return merged


def schedule(config: Optional[Dict[str, Any]] = None) -> Tuple[int, dtime]:
    cfg = config if config is not None else load_copilot_config()
    retro = cfg.get("retro") if isinstance(cfg, dict) else None
    retro = retro if isinstance(retro, dict) else {}
    day = str(retro.get("day") or DEFAULT_DAY).strip().lower()[:3]
    weekday = DAYS.get(day, DAYS[DEFAULT_DAY])
    raw_time = str(retro.get("time") or DEFAULT_TIME).strip()
    m = re.match(r"^(\d{1,2}):(\d{2})$", raw_time)
    at = dtime(16, 0)
    if m and int(m.group(1)) < 24 and int(m.group(2)) < 60:
        at = dtime(int(m.group(1)), int(m.group(2)))
    return weekday, at


def week_id(dt: datetime) -> str:
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def week_start(week: str) -> datetime:
    """Local midnight on the Monday of an ISO week (naive local time)."""
    m = WEEK_RE.match(week)
    if not m:
        raise ValueError(f"invalid week: {week!r}")
    return datetime.fromisocalendar(int(m.group(1)), int(m.group(2)), 1)


def due_at(week: str, config: Optional[Dict[str, Any]] = None) -> datetime:
    weekday, at = schedule(config)
    return datetime.combine((week_start(week) + timedelta(days=weekday)).date(), at)


def _path(week: str, directory: Optional[Path] = None) -> Path:
    if not WEEK_RE.match(week):
        raise ValueError(f"invalid week: {week!r}")
    return (Path(directory) if directory else retro_dir()) / f"{week}.json"


def load(week: str, directory: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(_path(week, directory).read_text())
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write(week: str, record: Dict[str, Any], directory: Optional[Path] = None) -> None:
    path = _path(week, directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def status(
    now: Optional[datetime] = None,
    config: Optional[Dict[str, Any]] = None,
    directory: Optional[Path] = None,
) -> Dict[str, Any]:
    """``{week, due, answered, skipped, due_at, questions}`` for the current ISO week."""
    now_local = (now or datetime.now().astimezone()).astimezone().replace(tzinfo=None)
    week = week_id(now_local)
    record = load(week, directory) or {}
    answered = bool(record.get("answered_at"))
    skipped = bool(record.get("skipped"))
    due = now_local >= due_at(week, config) and not answered and not skipped
    return {
        "week": week,
        "due": due,
        "answered": answered,
        "skipped": skipped,
        "due_at": due_at(week, config).astimezone().isoformat(timespec="seconds"),
        "questions": [dict(q) for q in QUESTIONS],
    }


def mark_shown(week: str, now: Optional[datetime] = None, directory: Optional[Path] = None) -> bool:
    """Record the first time the retro was shown. True if this call was the first."""
    record = load(week, directory) or {"week": week}
    if record.get("shown_at"):
        return False
    record["week"] = week
    record["shown_at"] = (now or datetime.now().astimezone()).astimezone().isoformat(timespec="seconds")
    _write(week, record, directory)
    return True


def clean_answers(answers: Any) -> Dict[str, str]:
    if answers is None:
        return {}
    if not isinstance(answers, dict):
        raise ValueError("answers must be an object")
    out: Dict[str, str] = {}
    for qid in QUESTION_IDS:
        value = answers.get(qid)
        if value is None:
            continue
        if not isinstance(value, str):
            raise ValueError(f"answer {qid} must be a string")
        value = value.strip()
        if len(value) > MAX_ANSWER:
            raise ValueError(f"answer {qid} is longer than {MAX_ANSWER} characters")
        if value:
            out[qid] = value
    return out


def save(
    week: str,
    answers: Optional[Dict[str, str]] = None,
    skipped: bool = False,
    wins_count: Optional[int] = None,
    now: Optional[datetime] = None,
    directory: Optional[Path] = None,
) -> Dict[str, Any]:
    stamp = (now or datetime.now().astimezone()).astimezone().isoformat(timespec="seconds")
    record = load(week, directory) or {}
    record["week"] = week
    record.setdefault("shown_at", None)
    record["skipped"] = bool(skipped)
    record["answers"] = dict(answers or {})
    record["answered_at"] = None if skipped else stamp
    if wins_count is not None:
        record["wins_count"] = int(wins_count)
    ordered = {k: record.get(k) for k in ("week", "shown_at", "answered_at", "skipped", "answers", "wins_count")}
    for k, v in record.items():
        ordered.setdefault(k, v)
    _write(week, ordered, directory)
    return ordered
