import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from hester.daemon.copilot import lee_events, presence

UNREACHABLE = "http://127.0.0.1:9"


@pytest.fixture(autouse=True)
def isolated_copilot(monkeypatch, tmp_path):
    """Never talk to the real Lee or write to ~/.lee or ~/.hester."""
    client = lee_events.LeeEventsClient(lee_url=UNREACHABLE, headers=lambda: {})
    monkeypatch.setattr(lee_events, "_client", client)
    monkeypatch.setattr(presence, "_client", presence.PresenceClient(lee_url=UNREACHABLE, headers=lambda: {}))
    monkeypatch.setenv("LEE_EVENTS_DIR", str(tmp_path / "events"))
    monkeypatch.setenv("HESTER_RETRO_DIR", str(tmp_path / "retro"))
    return client


def queued(client: lee_events.LeeEventsClient) -> List[Dict[str, Any]]:
    with client._lock:
        return list(client._queue)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_event(
    type: str,
    ts: datetime,
    data: Optional[Dict[str, Any]] = None,
    *,
    at_machine: bool = True,
    focus_session_id: Optional[str] = None,
    workspace: Optional[str] = None,
    window_id: Optional[int] = None,
    actor: Optional[Dict[str, Any]] = None,
    source: str = "lee-main",
) -> Dict[str, Any]:
    return {
        "v": 1,
        "id": f"ev-{type}-{ts.timestamp()}",
        "ts": iso(ts),
        "type": type,
        "source": source,
        "workspace": workspace,
        "window_id": window_id,
        "actor": actor or {"kind": "system"},
        "ctx": {"at_machine": at_machine, "engaged": True, "focus_session_id": focus_session_id, "away": False},
        "data": data or {},
    }


def write_events(directory: Path, events: List[Dict[str, Any]]) -> None:
    """Write events into per-local-day files like Lee does."""
    directory.mkdir(parents=True, exist_ok=True)
    by_day: Dict[str, List[str]] = {}
    for ev in events:
        ts = datetime.fromisoformat(ev["ts"].replace("Z", "+00:00"))
        day = ts.astimezone().strftime("%Y-%m-%d")
        by_day.setdefault(day, []).append(json.dumps(ev, separators=(",", ":")))
    for day, lines in by_day.items():
        with open(directory / f"{day}.jsonl", "a") as f:
            f.write("\n".join(lines) + "\n")


def git(repo: Path, *args: str, when: Optional[datetime] = None) -> str:
    env = dict(os.environ)
    env.update({
        "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "t@example.com",
        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
    })
    if when is not None:
        stamp = when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000")
        env["GIT_AUTHOR_DATE"] = stamp
        env["GIT_COMMITTER_DATE"] = stamp
    out = subprocess.run(["git", "-C", str(repo), *args], env=env, capture_output=True, text=True, check=True)
    return out.stdout


def commit_file(repo: Path, rel: str, content: str, message: str, when: datetime) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    git(repo, "add", rel)
    git(repo, "commit", "-q", "-m", message, when=when)


@pytest.fixture
def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


@pytest.fixture
def events_dir(tmp_path) -> Path:
    return tmp_path / "events"


def minutes(n: float) -> timedelta:
    return timedelta(minutes=n)
