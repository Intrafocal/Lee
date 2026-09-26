"""
Session-start digest (v1): deterministic, no model.

Leads with **verified** wins only (commits and merges on the default branch,
decisions answered in the attention queue, operations that passed, Someday
items triaged). What an
agent says about its own work ("tests pass") is listed separately under
``agent_claims`` with ``verified: false`` and is never a win.
"""

import logging
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import retro as retro_mod
from .event_reader import iso, parse_ts, read_events
from .someday import SomedayStore

logger = logging.getLogger("hester.daemon.copilot.digest")

RETURN_MIN_AWAY_MS = 30 * 60 * 1000
DEFAULT_LOOKBACK = timedelta(hours=12)
SINCE_SCAN = timedelta(days=7)
MAX_COMMITS = 500
MAX_WAITING = 25
MAX_AGENT_FILES = 50
GIT_TIMEOUT_S = 5.0

DIGEST_EVENT_TYPES = {
    "attention.open",
    "attention.reply",
    "agent.session_start",
    "agent.tool",
    "agent.turn_end",
    "operation.result",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _norm(path: str, base: Optional[str] = None) -> str:
    p = os.path.expanduser(str(path))
    if not os.path.isabs(p) and base:
        p = os.path.join(base, p)
    return os.path.normpath(p)


def _under(path: Optional[str], root: str) -> bool:
    if not path:
        return False
    p = os.path.normpath(path)
    return p == root or p.startswith(root.rstrip(os.sep) + os.sep)


# ---------------------------------------------------------------------------
# since
# ---------------------------------------------------------------------------


def detect_since(
    now: Optional[datetime] = None,
    events_dir: Optional[Path] = None,
    events: Optional[List[Dict[str, Any]]] = None,
) -> datetime:
    """Start of the most recent away period, else 12 h ago.

    Candidates: the latest ``handoff.start``, and the latest return to the
    machine after >= 30 min away (its ``presence.change`` to ``at_machine:false``,
    or ``ts - away_ms`` when that line is missing).
    """
    now = now or _utc_now()
    if events is None:
        events = read_events(
            since=now - SINCE_SCAN, until=now + timedelta(seconds=1),
            directory=events_dir, types={"handoff.start", "presence.change"},
        )
    best: Optional[datetime] = None
    last_away_start: Optional[datetime] = None
    for ev in events:
        ts = ev["_ts"]
        if ev.get("type") == "handoff.start":
            best = ts if best is None or ts > best else best
            continue
        if ev.get("type") != "presence.change":
            continue
        data = ev.get("data") or {}
        before = (data.get("from") or {}).get("at_machine")
        after = (data.get("to") or {}).get("at_machine")
        if before is True and after is False:
            last_away_start = ts
        elif before is False and after is True:
            away_ms = data.get("away_ms")
            start = last_away_start
            if start is None and isinstance(away_ms, (int, float)):
                start = ts - timedelta(milliseconds=away_ms)
            if start is not None:
                gone = away_ms if isinstance(away_ms, (int, float)) else (ts - start).total_seconds() * 1000
                if gone >= RETURN_MIN_AWAY_MS:
                    best = start if best is None or start > best else best
            last_away_start = None
    return best or (now - DEFAULT_LOOKBACK)


# ---------------------------------------------------------------------------
# git wins
# ---------------------------------------------------------------------------


def _git(workspace: Path, *args: str) -> Optional[str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(workspace), *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def default_branch(workspace: Path) -> Optional[str]:
    for name in ("main", "master"):
        if _git(workspace, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}") is not None:
            return name
    head = _git(workspace, "rev-parse", "--verify", "--quiet", "HEAD")
    return "HEAD" if head is not None else None


def git_wins(workspace: Path, since: datetime, until: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Commits on the default branch (first-parent) with commit time >= since.

    Each win carries ``_files`` (absolute paths changed relative to the first
    parent), used for focus filtering and stripped before returning to clients.
    """
    top = _git(workspace, "rev-parse", "--show-toplevel")
    branch = default_branch(workspace) if top is not None else None
    if not top or not branch:
        return []
    top = top.strip()
    out = _git(
        workspace, "log", branch, "--first-parent", "-m", "--name-only",
        f"--max-count={MAX_COMMITS}", f"--since={iso(since)}",
        "--format=%x1e%H%x1f%P%x1f%cI%x1f%s",
    )
    if not out:
        return []
    wins = []
    for block in out.split("\x1e"):
        block = block.strip("\n")
        if not block:
            continue
        header, _, rest = block.partition("\n")
        parts = header.split("\x1f")
        if len(parts) < 4:
            continue
        sha, parents, committed, subject = parts[0], parts[1].split(), parts[2], parts[3]
        at = parse_ts(committed)
        if at is None or at < since or (until and at >= until):
            continue
        files = sorted({_norm(line.strip(), top) for line in rest.splitlines() if line.strip()})
        wins.append({
            "kind": "merge" if len(parents) > 1 else "commit",
            "title": subject,
            "ref": sha[:7],
            "at": iso(at),
            "verified": True,
            "related": False,
            "_files": files,
        })
    return wins


# ---------------------------------------------------------------------------
# events: decisions and agent claims
# ---------------------------------------------------------------------------


class _Sessions:
    """What the event log says about agent sessions: workspace, pty, files written."""

    def __init__(self, events: Iterable[Dict[str, Any]]):
        self.workspace: Dict[str, str] = {}
        self.cwd: Dict[str, str] = {}
        self.pty: Dict[str, int] = {}
        self.files: Dict[str, Set[str]] = {}
        for ev in events:
            data = ev.get("data") or {}
            sid = data.get("session_id")
            if not sid:
                continue
            if isinstance(data.get("pty_id"), int):
                self.pty[sid] = data["pty_id"]
            if ev.get("workspace"):
                self.workspace.setdefault(sid, os.path.normpath(ev["workspace"]))
            if ev.get("type") == "agent.session_start" and data.get("cwd"):
                self.cwd[sid] = os.path.normpath(data["cwd"])
            if ev.get("type") == "agent.tool" and data.get("writes"):
                base = self.cwd.get(sid) or self.workspace.get(sid)
                for f in data.get("files") or []:
                    if isinstance(f, str) and f:
                        self.files.setdefault(sid, set()).add(_norm(f, base))

    def in_workspace(self, ev: Dict[str, Any], sid: Optional[str], ws: str) -> bool:
        if ev.get("workspace"):
            return os.path.normpath(ev["workspace"]) == ws
        if sid:
            if self.workspace.get(sid):
                return self.workspace[sid] == ws
            return _under(self.cwd.get(sid), ws)
        return False


def _first_line(text: Any, limit: int = 80) -> str:
    line = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    return line if len(line) <= limit else line[: limit - 1] + "…"


def decision_wins(
    events: List[Dict[str, Any]],
    sessions: _Sessions,
    workspace: str,
    since: datetime,
    until: datetime,
) -> List[Dict[str, Any]]:
    opens = {}
    last_turn: Dict[str, Dict[str, Any]] = {}
    wins = []
    for ev in events:
        data = ev.get("data") or {}
        t = ev.get("type")
        if t == "attention.open" and data.get("item_id"):
            opens[data["item_id"]] = ev
        elif t == "agent.turn_end" and data.get("session_id"):
            last_turn[data["session_id"]] = ev
        elif t == "attention.reply":
            if data.get("kind") not in ("decision", "blocker"):
                continue
            if not (since <= ev["_ts"] < until):
                continue
            opened = opens.get(data.get("item_id"))
            source = ((opened or {}).get("data") or {}).get("source") or {}
            sid = source.get("session_id")
            in_ws = sessions.in_workspace(ev, sid, workspace) or (
                opened is not None and sessions.in_workspace(opened, sid, workspace)
            )
            if not in_ws and source.get("workspace"):
                in_ws = os.path.normpath(source["workspace"]) == workspace
            if not in_ws:
                continue
            question = ""
            turn = last_turn.get(sid) if sid else None
            if turn:
                td = turn.get("data") or {}
                status = td.get("lee_status") or {}
                question = _first_line(status.get("blockers") or status.get("next") or status.get("summary") or td.get("summary"))
            wins.append({
                "kind": "decision",
                "title": f"Answered Claude: {question or ('a blocker' if data.get('kind') == 'blocker' else 'a decision')}",
                "ref": data.get("item_id"),
                "at": iso(ev["_ts"]),
                "verified": True,
                "related": False,
                "_pty": source.get("pty_id") if isinstance(source.get("pty_id"), int) else sessions.pty.get(sid),
                "_files": sorted(sessions.files.get(sid, set())) if sid else [],
            })
    return wins


def operation_wins(
    events: List[Dict[str, Any]],
    workspace: str,
    since: datetime,
    until: datetime,
) -> List[Dict[str, Any]]:
    """``operation.result`` with status passed in this workspace: Lee saw the exit code."""
    wins = []
    for ev in events:
        if ev.get("type") != "operation.result" or not (since <= ev["_ts"] < until):
            continue
        if not ev.get("workspace") or os.path.normpath(ev["workspace"]) != workspace:
            continue
        data = ev.get("data") or {}
        if data.get("status") != "passed" or not data.get("op"):
            continue
        win = {
            "kind": "operation",
            "title": f"{data['op']} passed",
            "ref": data.get("run_id"),
            "at": iso(ev["_ts"]),
            "verified": True,
            "related": False,
        }
        readings = [r for r in data.get("readings") or [] if isinstance(r, dict)]
        if readings:
            win["readings"] = readings
        wins.append(win)
    return wins


def agent_claims(
    events: List[Dict[str, Any]],
    sessions: _Sessions,
    workspace: str,
    since: datetime,
    until: datetime,
) -> List[Dict[str, Any]]:
    """The latest turn-end per session in range: the agent's own words, unverified."""
    latest: Dict[str, Dict[str, Any]] = {}
    for ev in events:
        if ev.get("type") != "agent.turn_end" or not (since <= ev["_ts"] < until):
            continue
        data = ev.get("data") or {}
        sid = data.get("session_id")
        if not sid or not (data.get("summary") or data.get("lee_status")):
            continue
        if not sessions.in_workspace(ev, sid, workspace):
            continue
        latest[sid] = ev
    claims = []
    for sid, ev in latest.items():
        data = ev.get("data") or {}
        status = data.get("lee_status") if isinstance(data.get("lee_status"), dict) else None
        files = set(sessions.files.get(sid, set()))
        base = sessions.cwd.get(sid) or sessions.workspace.get(sid) or workspace
        for f in (status or {}).get("files") or []:
            if isinstance(f, str) and f:
                files.add(_norm(f, base))
        pty = data.get("pty_id") if isinstance(data.get("pty_id"), int) else sessions.pty.get(sid)
        claims.append({
            "session_id": sid,
            "pty_id": pty,
            "summary": data.get("summary") or (status or {}).get("summary") or "",
            "lee_status": status,
            "at": iso(ev["_ts"]),
            "verified": False,
            "related": False,
            "_pty": pty,
            "_files": sorted(files),
        })
    return claims


# ---------------------------------------------------------------------------
# focus filter
# ---------------------------------------------------------------------------


def normalize_focus(focus: Any, workspace: str) -> Optional[Dict[str, Any]]:
    if not isinstance(focus, dict):
        return None
    kind = focus.get("kind")
    if kind == "files":
        paths = [_norm(p, workspace) for p in focus.get("paths") or [] if isinstance(p, str) and p]
        return {**focus, "paths": paths}
    if kind in ("agent", "workspace"):
        return dict(focus)
    return None


def is_related(entry: Dict[str, Any], focus: Optional[Dict[str, Any]]) -> bool:
    if not focus:
        return False
    if focus.get("kind") == "files":
        wanted = set(focus.get("paths") or [])
        return bool(wanted.intersection(entry.get("_files") or []))
    if focus.get("kind") == "agent":
        pty = entry.get("_pty")
        return pty is not None and pty == focus.get("pty_id")
    return False


def _finish(entries: List[Dict[str, Any]], focus: Optional[Dict[str, Any]], only_related: bool) -> List[Dict[str, Any]]:
    for e in entries:
        e["related"] = is_related(e, focus)
    if only_related:
        entries = [e for e in entries if e["related"]]
    entries.sort(key=lambda e: e.get("at") or "", reverse=True)
    entries.sort(key=lambda e: not e["related"])
    return [{k: v for k, v in e.items() if not k.startswith("_")} for e in entries]


# ---------------------------------------------------------------------------
# digest
# ---------------------------------------------------------------------------


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def verified_wins(
    workspace: Path,
    since: datetime,
    until: Optional[datetime] = None,
    focus: Optional[Dict[str, Any]] = None,
    only_related: bool = False,
    events: Optional[List[Dict[str, Any]]] = None,
    events_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    until = until or _utc_now()
    ws = os.path.normpath(str(workspace))
    if events is None:
        events = read_events(since=since - timedelta(days=2), until=until, directory=events_dir, types=DIGEST_EVENT_TYPES)
    sessions = _Sessions(events)
    focus_n = normalize_focus(focus, ws)
    raw = git_wins(Path(ws), since, until)
    raw += decision_wins(events, sessions, ws, since, until)
    raw += operation_wins(events, ws, since, until)
    raw += _someday_wins(Path(ws), since, until)
    return _finish(raw, focus_n, only_related)


def _someday_wins(workspace: Path, since: datetime, until: datetime) -> List[Dict[str, Any]]:
    wins = []
    for item in SomedayStore(workspace).triaged_between(since, until):
        action = (item.triage or {}).get("action") or item.status
        wins.append({
            "kind": "someday_decided",
            "title": f"Someday {action}: {_first_line(item.text, 60)}",
            "ref": item.id,
            "at": iso(parse_ts((item.triage or {}).get("at")) or since),
            "verified": True,
            "related": False,
        })
    return wins


def build_digest(
    workspace: Path,
    *,
    since: Optional[datetime] = None,
    focus: Optional[Dict[str, Any]] = None,
    only_related: bool = False,
    attention_items: Optional[List[Dict[str, Any]]] = None,
    now: Optional[datetime] = None,
    events_dir: Optional[Path] = None,
    retro_config: Optional[Dict[str, Any]] = None,
    retro_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """Assemble the digest. ``attention_items=None`` means Lee was unreachable."""
    now = now or _utc_now()
    ws = os.path.normpath(str(workspace))
    since = since or detect_since(now=now, events_dir=events_dir)
    until = now + timedelta(seconds=1)
    focus_n = normalize_focus(focus, ws)

    events = read_events(since=since - timedelta(days=2), until=until, directory=events_dir, types=DIGEST_EVENT_TYPES)
    sessions = _Sessions(events)

    commits = git_wins(Path(ws), since, until)
    raw_wins = (
        commits
        + decision_wins(events, sessions, ws, since, until)
        + operation_wins(events, ws, since, until)
        + _someday_wins(Path(ws), since, until)
    )
    wins = _finish(raw_wins, focus_n, only_related)
    claims = _finish(agent_claims(events, sessions, ws, since, until), focus_n, only_related)

    agent_files: Set[str] = set()
    for ev in events:
        if ev.get("type") != "agent.tool" or not (since <= ev["_ts"] < until):
            continue
        data = ev.get("data") or {}
        sid = data.get("session_id")
        if not data.get("writes") or not sessions.in_workspace(ev, sid, ws):
            continue
        base = sessions.cwd.get(sid) or sessions.workspace.get(sid) or ws
        for f in data.get("files") or []:
            if isinstance(f, str) and f:
                agent_files.add(_norm(f, base))

    lee_offline = attention_items is None
    waiting = []
    for item in attention_items or []:
        src = item.get("source") or {}
        item_ws = src.get("workspace") or src.get("cwd")
        if item_ws and _under(os.path.normpath(item_ws), ws):
            waiting.append(item)

    someday_counts = SomedayStore(Path(ws)).counts(now=now)
    retro_status = retro_mod.status(now=now, config=retro_config, directory=retro_dir)

    parts = [_plural(len(wins), "win", "wins")]
    parts.append("Lee offline" if lee_offline else f"{len(waiting)} waiting")
    # Same cap as Lee's compact snapshot, applied after the workspace filter.
    waiting = waiting[:MAX_WAITING]
    parts.append(_plural(len(claims), "agent claim", "agent claims"))

    return {
        "generated_at": iso(now),
        "workspace": ws,
        "since": iso(since),
        "focus": focus if isinstance(focus, dict) else None,
        "top_line": " · ".join(parts),
        "wins": wins,
        "agent_claims": claims,
        "changed": {"agent_files": sorted(agent_files)[:MAX_AGENT_FILES], "commits": len(commits)},
        "waiting": waiting,
        "someday": someday_counts,
        "retro": {"due": retro_status["due"], "week": retro_status["week"]},
    }
