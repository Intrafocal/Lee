"""
Cockpit task store: one markdown file per task at
``<workspace>/.hester/cockpit/tasks/<id>.md`` (0600), YAML frontmatter with
every CockpitTask field plus ``applied_through``, and a free-form body for
your notes that is never parsed.

Hester is the only writer. Lee relays explicit launches (POST /cockpit/tasks)
and the event follower keeps every task current. Writes are atomic (temp +
rename); callers serialise them with the workspace context's lock.
"""

import copy
import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

TASK_ID_RE = re.compile(r"^task-[A-Za-z0-9_-]{1,64}$")
KINDS = ("bug", "question", "prototype", "chore", "unknown")
LEADS = ("delegate", "human", "plan")
OPEN_STATUSES = ("running", "waiting", "idle", "review", "queued")
CLOSED_STATUSES = ("done", "discarded")
STATUSES = OPEN_STATUSES + CLOSED_STATUSES
PATCH_STATUSES = ("queued", "running", "review")
TITLE_SOURCES = ("user", "agent", "auto")
ORIGIN_KINDS = ("launcher", "agent", "checkin", "someday", "operation", "lint", "hester", "explore", "goal-eval")
MAX_FILES = 200
MAX_TEXT = 2000
MAX_TITLE = 200
MAX_COMMITS = 20
MAX_RECENT_EVENTS = 50
DEFAULT_TIMEBOX_MIN = 30
RECENT_CLOSED_DAYS = 7

NAME_SOURCES = ("user", "custom-title", "ai-title")
MAX_NAME = 120
MAX_CONTEXT_FILES = 50
MAX_CONTEXT_BUNDLES = 10

FIELDS = (
    "id", "workspace", "title", "title_source", "name", "name_source", "context",
    "kind", "status", "lead", "play", "agent",
    "sessions", "serves", "workstream", "confirmed", "confirmed_at", "urgency", "quadrant",
    "timebox_min", "due", "origin", "busy_ms", "turns", "files", "files_count", "summary",
    "lee_status", "last_checkin_at", "commits", "outcome", "accepted", "created_at",
    "updated_at", "closed_at", "version", "worktree",
    # v4: quadrant derivation (contract section 4) and scope growth
    "importance_rank", "overrides", "urgency_cleared_at", "files_at_first_report",
)
FOLLOWER_ONLY = ("busy_ms", "turns", "files", "sessions")
# Persisted in the frontmatter but not part of the API shape.
EXTRA_KEYS = ("applied_through", "name_custom_seen")
MAX_PARSE_CACHE = 5000

# libyaml when present: task files are re-read on every snapshot and reindex.
_YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)

# Parsed frontmatter keyed by path, reused while (mtime_ns, size) is unchanged,
# so a load_all() over months of task files costs a stat per file, not a parse.
_parse_cache: Dict[str, Tuple[int, int, Dict[str, Any], str]] = {}


class TaskError(ValueError):
    pass


class TaskNotFound(KeyError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_s(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def new_task_id() -> str:
    return f"task-{secrets.token_hex(4)}"


def first_line(text: Any, limit: int = 80) -> str:
    s = str(text or "").strip()
    line = s.splitlines()[0].strip() if s else ""
    return line if len(line) <= limit else line[: limit - 1] + "…"


def clip(text: Any, limit: int = MAX_TEXT) -> Optional[str]:
    if text is None:
        return None
    s = str(text)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def is_open(task: Dict[str, Any]) -> bool:
    return task.get("status") not in CLOSED_STATUSES


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _stringify_times(value: Any) -> Any:
    if isinstance(value, datetime):
        return iso_s(value if value.tzinfo else value.replace(tzinfo=timezone.utc))
    if isinstance(value, dict):
        return {k: _stringify_times(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_stringify_times(v) for v in value]
    return value


def default_task(task_id: str, workspace: str, now: Optional[datetime] = None) -> Dict[str, Any]:
    stamp = iso_s(now or utc_now())
    return {
        "id": task_id,
        "workspace": workspace,
        "title": "(untitled)",
        "title_source": "auto",
        "name": None,
        "name_source": None,
        "name_custom_seen": None,
        "context": None,
        "kind": "unknown",
        "status": "queued",
        "lead": "delegate",
        "play": False,
        "agent": None,
        "sessions": [],
        "serves": [],
        "workstream": None,
        "confirmed": False,
        "confirmed_at": None,
        "urgency": None,
        "quadrant": None,
        "timebox_min": DEFAULT_TIMEBOX_MIN,
        "due": None,
        "origin": None,
        "busy_ms": 0,
        "turns": 0,
        "files": [],
        "files_count": 0,
        "summary": None,
        "lee_status": None,
        "last_checkin_at": None,
        "commits": [],
        "outcome": None,
        "accepted": None,
        "created_at": stamp,
        "updated_at": stamp,
        "closed_at": None,
        "version": 0,
        "worktree": None,
        "importance_rank": None,
        "overrides": None,
        "urgency_cleared_at": None,
        "files_at_first_report": None,
        "applied_through": None,
    }


def to_api(task: Dict[str, Any]) -> Dict[str, Any]:
    return {k: task.get(k) for k in FIELDS}


# ---------------------------------------------------------------------------
# Quadrants (copilot v4, contract section 4): pure and deterministic
# ---------------------------------------------------------------------------

QUADRANT_RANK = {"Q1": 0, "Q2": 1, "Q3": 2, None: 3, "Q4": 4}


def _due_date(value: Any):
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except ValueError:
        dt = parse_time(s)
        return dt.date() if dt else None


def derive(task: Dict[str, Any], goals: List[Dict[str, Any]], now: Optional[datetime] = None) -> Dict[str, Any]:
    """
    ``{important, urgent, urgency, quadrant, importance_rank}`` for a task.

    ``goals`` is ``parse_goals_full(...)['goals']`` (ids and priorities).
    Important: ``overrides.important`` if set, else the task serves a known
    goal. Urgent: ``overrides.urgent`` if set, else waiting, an open
    operation-origin task, or ``due`` within a day. Neither: Q4 when chosen
    play, overridden unimportant or once-urgent; otherwise unclassified (None).
    """
    now = now or utc_now()
    priorities = {g["id"]: int(g.get("priority") or 0) for g in goals or [] if isinstance(g, dict) and g.get("id")}
    overrides = task.get("overrides") if isinstance(task.get("overrides"), dict) else {}
    served = [gid for gid in task.get("serves") or [] if gid in priorities]
    rank = min(priorities[g] for g in served) if served else None
    important = overrides.get("important") if isinstance(overrides.get("important"), bool) else bool(served)

    urgency: Optional[Dict[str, Any]] = None
    forced = overrides.get("urgent")
    if isinstance(forced, bool):
        urgency = {"signal": "override", "ref": None} if forced else None
    else:
        origin = task.get("origin") or {}
        due = _due_date(task.get("due"))
        if task.get("status") == "waiting":
            urgency = {"signal": "agent-waiting", "ref": None}
        elif is_open(task) and origin.get("kind") == "operation":
            urgency = {"signal": "op-failure", "ref": origin.get("ref")}
        elif due is not None and due <= now.date() + timedelta(days=1):
            urgency = {"signal": "due", "ref": due.isoformat()}
    urgent = urgency is not None

    if important:
        quadrant: Optional[str] = "Q1" if urgent else "Q2"
    elif urgent:
        quadrant = "Q3"
    elif task.get("play") or overrides.get("important") is False or task.get("urgency_cleared_at"):
        quadrant = "Q4"
    else:
        quadrant = None
    return {"important": important, "urgent": urgent, "urgency": urgency, "quadrant": quadrant, "importance_rank": rank}


def apply_derived(task: Dict[str, Any], goals: List[Dict[str, Any]], now: Optional[datetime] = None, saving: bool = True) -> Dict[str, Any]:
    """Store the derived fields on the task; on save, stamp ``urgency_cleared_at`` when urgency just cleared."""
    now = now or utc_now()
    before = task.get("urgency")
    d = derive(task, goals, now)
    # An agent waiting on you and then resuming is the ordinary rhythm, not a
    # cleared urgency: only a real signal (a failure, a due date, your override)
    # clearing makes continued unlinked work Q4 drift.
    if saving and before and before.get("signal") != "agent-waiting" and d["urgency"] is None:
        task["urgency_cleared_at"] = iso_s(now)
        d = derive(task, goals, now)
    task["urgency"] = d["urgency"]
    task["quadrant"] = d["quadrant"]
    task["importance_rank"] = d["importance_rank"]
    return task


def workspace_goals(workspace: Path) -> List[Dict[str, Any]]:
    from .goals import load_goals_full

    try:
        return load_goals_full(Path(workspace))["goals"]
    except Exception:
        return []


def open_sort_key(task: Dict[str, Any]):
    """Within one status: quadrant (Q1, Q2, Q3, unclassified, Q4), then goal priority."""
    rank = task.get("importance_rank")
    return (QUADRANT_RANK.get(task.get("quadrant"), 3), rank if isinstance(rank, int) else 1_000_000)


def task_sessions(task: Dict[str, Any]) -> List[str]:
    out = [s for s in task.get("sessions") or [] if isinstance(s, str) and s]
    sid = (task.get("agent") or {}).get("session_id")
    if isinstance(sid, str) and sid and sid not in out:
        out.append(sid)
    return out


# ---------------------------------------------------------------------------
# Validation of caller-supplied fields
# ---------------------------------------------------------------------------


def _title(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TaskError("title must be a non-empty string")
    t = " ".join(value.strip().split())
    return t if len(t) <= MAX_TITLE else t[: MAX_TITLE - 1] + "…"


def _choice(name: str, value: Any, choices) -> str:
    if value not in choices:
        raise TaskError(f"{name} must be one of {', '.join(choices)}")
    return value


def _bool(name: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise TaskError(f"{name} must be a boolean")
    return value


def _str_list(name: str, value: Any) -> List[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise TaskError(f"{name} must be a list of strings")
    out: List[str] = []
    for v in value:
        v = v.strip()
        if v and v not in out:
            out.append(v)
    return out


def _opt_str(name: str, value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TaskError(f"{name} must be a string or null")
    return value.strip() or None


def _opt_int(name: str, value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TaskError(f"{name} must be a non-negative integer or null")
    return value


def _agent(value: Any, base: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TaskError("agent must be an object or null")
    out = dict(base or {"provider": "claude", "pty_id": None, "session_id": None, "tab_label": None, "model": None})
    for key in ("provider", "session_id", "tab_label", "model"):
        if key in value and value[key] is not None:
            out[key] = _opt_str(f"agent.{key}", value[key])
    if "pty_id" in value and value["pty_id"] is not None:
        out["pty_id"] = _opt_int("agent.pty_id", value["pty_id"])
    out["provider"] = out.get("provider") or "claude"
    return out


def clean_name(value: Any) -> Optional[str]:
    """Trim, collapse whitespace, drop control characters, clip; '' -> None (same as Lee's cleanName)."""
    if not isinstance(value, str):
        return None
    s = " ".join("".join(" " if (ord(c) < 32 or ord(c) == 127) else c for c in value).split())
    if not s:
        return None
    return s if len(s) <= MAX_NAME else s[: MAX_NAME - 1] + "…"


def apply_name(task: Dict[str, Any], name: Any, source: str) -> bool:
    """
    Record a name observation with the precedence rule (addendum 2026-09-26b):
    user > custom-title (/rename, --name) > ai-title > the derived title. A
    name you typed is replaced only by a later, different custom-title; an
    ai-title never replaces a user or custom name. ``name=None`` from the user
    clears it. Returns whether the stored name or its source changed.
    """
    if source not in NAME_SOURCES:
        raise TaskError(f"name source must be one of {', '.join(NAME_SOURCES)}")
    if name is not None and not isinstance(name, str):
        raise TaskError("name must be a string or null")
    n = clean_name(name)
    cur, cur_src, seen = task.get("name"), task.get("name_source"), task.get("name_custom_seen")
    if source == "user":
        if n == cur and (n is None or cur_src == "user"):
            return False
        task["name"], task["name_source"] = n, ("user" if n else None)
        return True
    if source == "custom-title":
        if not n or n == seen:
            return False
        task["name_custom_seen"] = n
        if n == cur:
            return False
        task["name"], task["name_source"] = n, "custom-title"
        return True
    if not n or n == cur or cur_src in ("user", "custom-title"):
        return False
    task["name"], task["name_source"] = n, "ai-title"
    return True


def _context(value: Any) -> Optional[Dict[str, Any]]:
    """Files (workspace-relative paths) and bundle ids attached at launch; references only."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TaskError("context must be an object or null")
    files = _str_list("context.files", value.get("files") or [])
    bundles = _str_list("context.bundles", value.get("bundles") or [])
    for f in files:
        if f.startswith("/") or ".." in f.split("/"):
            raise TaskError("context.files must be workspace-relative paths")
    return {"files": files[:MAX_CONTEXT_FILES], "bundles": bundles[:MAX_CONTEXT_BUNDLES]}


def clean_worktree(value: Any) -> Optional[Dict[str, Any]]:
    """A spike's worktree {slug, path, branch} from the relay or the task.launch event; else None."""
    if not isinstance(value, dict):
        return None
    out = {k: (str(value[k]) if isinstance(value.get(k), (str, int)) and str(value[k]) else None) for k in ("slug", "path", "branch")}
    return out if out["path"] or out["slug"] else None


def _origin(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TaskError("origin must be an object or null")
    kind = _choice("origin.kind", value.get("kind"), ORIGIN_KINDS)
    ref = value.get("ref")
    return {"kind": kind, "ref": None if ref is None else str(ref)}


# ---------------------------------------------------------------------------
# Workspace version counter
# ---------------------------------------------------------------------------


class VersionCounter:
    """Per-workspace counter bumped on every task, reading or workstream-link write."""

    def __init__(self, workspace: Path):
        self.path = Path(workspace) / ".hester" / "cockpit" / "state.json"

    def _read(self) -> Dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self) -> int:
        v = self._read().get("version")
        return v if isinstance(v, int) else 0

    def bump(self) -> int:
        state = self._read()
        v = state.get("version") if isinstance(state.get("version"), int) else 0
        state["version"] = v + 1
        atomic_write(self.path, json.dumps(state))
        return v + 1


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class CockpitTaskStore:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.dir = self.workspace / ".hester" / "cockpit" / "tasks"
        self.recent_path = self.workspace / ".hester" / "cockpit" / "recent.json"
        self.counter = VersionCounter(self.workspace)

    # ---------------------------------------------------------------- files

    def _path(self, task_id: str) -> Path:
        if not isinstance(task_id, str) or not TASK_ID_RE.match(task_id):
            raise TaskError(f"invalid task id: {task_id!r}")
        return self.dir / f"{task_id}.md"

    @staticmethod
    def _parse(content: str) -> Tuple[Dict[str, Any], str]:
        if not content.startswith("---\n"):
            raise TaskError("missing frontmatter")
        end = content.find("\n---\n", 3)
        if end < 0:
            raise TaskError("unterminated frontmatter")
        meta = yaml.load(content[4:end + 1], Loader=_YAML_LOADER) or {}
        if not isinstance(meta, dict):
            raise TaskError("frontmatter is not a mapping")
        return _stringify_times(meta), content[end + 5:]

    def _load(self, path: Path) -> Optional[Tuple[Dict[str, Any], str]]:
        key = str(path)
        try:
            st = path.stat()
            hit = _parse_cache.get(key)
            if hit is not None and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
                meta, body = copy.deepcopy(hit[2]), hit[3]
            else:
                meta, body = self._parse(path.read_text(encoding="utf-8"))
                if len(_parse_cache) >= MAX_PARSE_CACHE:
                    _parse_cache.clear()
                _parse_cache[key] = (st.st_mtime_ns, st.st_size, copy.deepcopy(meta), body)
        except FileNotFoundError:
            _parse_cache.pop(key, None)
            return None
        except (OSError, TaskError, yaml.YAMLError):
            return None
        task = default_task(str(meta.get("id") or path.stem), str(meta.get("workspace") or self.workspace))
        task.update({k: v for k, v in meta.items() if k in FIELDS or k in EXTRA_KEYS})
        return task, body

    def get(self, task_id: str) -> Optional[Dict[str, Any]]:
        loaded = self._load(self._path(task_id))
        return loaded[0] if loaded else None

    def require(self, task_id: str) -> Dict[str, Any]:
        task = self.get(task_id)
        if task is None:
            raise TaskNotFound(task_id)
        return task

    def _body(self, task_id: str) -> str:
        loaded = self._load(self._path(task_id))
        return loaded[1] if loaded else ""

    def delete(self, task_id: str) -> None:
        """Remove a task file (the follower folds a duplicate automatic task into a launched one)."""
        path = self._path(task_id)
        _parse_cache.pop(str(path), None)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        self.counter.bump()

    def load_all(self) -> List[Dict[str, Any]]:
        out = []
        try:
            paths = sorted(self.dir.glob("task-*.md"))
        except OSError:
            return out
        for p in paths:
            if not TASK_ID_RE.match(p.stem):
                continue
            loaded = self._load(p)
            if loaded:
                out.append(loaded[0])
        return out

    def list(self, status: str = "open", limit: int = 100) -> List[Dict[str, Any]]:
        if status not in ("open", "closed", "all"):
            raise TaskError("status must be open, closed or all")
        tasks = self.load_all()
        if status == "open":
            tasks = [t for t in tasks if is_open(t)]
        elif status == "closed":
            tasks = [t for t in tasks if not is_open(t)]
        tasks.sort(key=lambda t: (str(t.get("updated_at") or ""), t["id"]), reverse=True)
        return [to_api(t) for t in tasks[: max(0, limit)]]

    def save(self, task: Dict[str, Any], body: Optional[str] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
        """Write the task (bumps its version, updated_at and the workspace version)."""
        path = self._path(task["id"])
        if body is None:
            body = self._body(task["id"])
        task["updated_at"] = iso_s(now or utc_now())
        task["version"] = int(task.get("version") or 0) + 1
        task["files_count"] = len(task.get("files") or [])
        apply_derived(task, workspace_goals(self.workspace), now or utc_now())
        meta = {k: task.get(k) for k in FIELDS}
        for k in EXTRA_KEYS:
            meta[k] = task.get(k)
        head = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, default_flow_style=False)
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        atomic_write(path, f"---\n{head}---\n{body}")
        _parse_cache.pop(str(path), None)
        self.counter.bump()
        return task

    # ---------------------------------------------------------------- recent events

    def recent_events(self, limit: int = 20) -> List[Dict[str, Any]]:
        try:
            rows = json.loads(self.recent_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        rows = [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
        rows.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
        return rows[:limit]

    def record_event(self, kind: str, task: Dict[str, Any], text: str, at: Optional[str] = None) -> None:
        rows = self.recent_events(MAX_RECENT_EVENTS)
        rows.insert(0, {"at": at or iso_s(utc_now()), "task_id": task["id"], "kind": kind, "text": text})
        rows.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
        atomic_write(self.recent_path, json.dumps(rows[:MAX_RECENT_EVENTS]))

    # ---------------------------------------------------------------- mutations

    def upsert(self, payload: Dict[str, Any], now: Optional[datetime] = None) -> Tuple[Dict[str, Any], bool]:
        """POST /cockpit/tasks: create, or merge into an existing task (fields given win)."""
        now = now or utc_now()
        task_id = payload.get("id") or new_task_id()
        self._path(task_id)
        existing = self.get(task_id)
        created = existing is None
        task = existing or default_task(task_id, str(self.workspace), now)
        body = None
        # Once the follower has applied events to a task, its status and live
        # pty are newer than anything a (late, spooled or retried) relay says.
        followed = not created and bool(task.get("applied_through"))

        if created:
            task["title_source"] = "user"
        if "lead" in payload and payload["lead"] is not None:
            task["lead"] = _choice("lead", payload["lead"], LEADS)
        if created and "timebox_min" not in payload:
            task["timebox_min"] = DEFAULT_TIMEBOX_MIN if task["lead"] == "delegate" else None
        if "title" in payload and payload["title"] is not None:
            task["title"] = _title(payload["title"])
        elif created:
            raise TaskError("title is required")
        if "title_source" in payload and payload["title_source"] is not None:
            task["title_source"] = _choice("title_source", payload["title_source"], TITLE_SOURCES)
        if "kind" in payload and payload["kind"] is not None:
            task["kind"] = _choice("kind", payload["kind"], KINDS)
        if "play" in payload and payload["play"] is not None:
            task["play"] = _bool("play", payload["play"])
        if "status" in payload and payload["status"] is not None:
            status = _choice("status", payload["status"], OPEN_STATUSES)
            if is_open(task) and not followed:
                task["status"] = status
        if "agent" in payload:
            agent = _agent(payload["agent"], task.get("agent"))
            if followed and agent is None:
                agent = task.get("agent")
            elif followed:
                current = task.get("agent") or {}
                if current:
                    agent = dict(current, **{
                        k: v for k, v in agent.items() if k != "pty_id" and current.get(k) is None and v is not None
                    })
                else:
                    agent["pty_id"] = None
            task["agent"] = agent
        if "serves" in payload and payload["serves"] is not None:
            task["serves"] = _str_list("serves", payload["serves"])
        if "workstream" in payload:
            task["workstream"] = _opt_str("workstream", payload["workstream"])
        if "origin" in payload and payload["origin"] is not None:
            task["origin"] = _origin(payload["origin"])
        if payload.get("worktree") is not None:
            if not isinstance(payload["worktree"], (dict, bool)):
                raise TaskError("worktree must be an object or null")
            worktree = clean_worktree(payload["worktree"])
            if worktree is not None:
                task["worktree"] = worktree
        if "timebox_min" in payload:
            task["timebox_min"] = _opt_int("timebox_min", payload["timebox_min"])
        if "due" in payload:
            task["due"] = _opt_str("due", payload["due"])
        if payload.get("name") is not None:
            apply_name(task, payload["name"], payload.get("name_source") or "user")
        if "context" in payload and payload["context"] is not None:
            task["context"] = _context(payload["context"])
        if "confirmed" in payload and payload["confirmed"] is not None:
            if _bool("confirmed", payload["confirmed"]) and not task.get("confirmed"):
                task["confirmed"] = True
                task["confirmed_at"] = iso_s(now)
        note = payload.get("note")
        if note is not None:
            if not isinstance(note, str):
                raise TaskError("note must be a string")
            if note.strip():
                current = "" if created else self._body(task_id)
                body = (current.rstrip("\n") + "\n\n" if current.strip() else "") + note.strip() + "\n"
        self.save(task, body=body if body is not None else ("" if created else None), now=now)
        if created:
            self.record_event("created", task, f"Task created: {task['title']}")
        return task, created

    def patch(self, task_id: str, payload: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        task = self.require(task_id)
        allowed = {"title", "name", "kind", "lead", "play", "serves", "workstream", "timebox_min", "due", "status",
                   "important", "urgent"}
        unknown = set(payload) - allowed
        if unknown:
            raise TaskError(f"cannot patch: {', '.join(sorted(unknown))}")
        if "title" in payload:
            title = _title(payload["title"])
            if title != task.get("title"):
                task["title"] = title
                task["title_source"] = "user"
        if "name" in payload:
            # Rename in the Cockpit: your name (null or "" clears it).
            apply_name(task, payload["name"], "user")
        if "kind" in payload:
            task["kind"] = _choice("kind", payload["kind"], KINDS)
        if "lead" in payload:
            task["lead"] = _choice("lead", payload["lead"], LEADS)
        if "play" in payload:
            task["play"] = _bool("play", payload["play"])
        if "serves" in payload:
            task["serves"] = _str_list("serves", payload["serves"])
        if "workstream" in payload:
            task["workstream"] = _opt_str("workstream", payload["workstream"])
        if "timebox_min" in payload:
            task["timebox_min"] = _opt_int("timebox_min", payload["timebox_min"])
        if "due" in payload:
            task["due"] = _opt_str("due", payload["due"])
        if "status" in payload:
            task["status"] = _choice("status", payload["status"], PATCH_STATUSES)
            task["closed_at"] = None
        if "important" in payload or "urgent" in payload:
            # Quadrant overrides: true/false set, null clears (back to derived). No reason asked.
            current = task.get("overrides") if isinstance(task.get("overrides"), dict) else {}
            overrides = {"important": current.get("important"), "urgent": current.get("urgent"), "at": None}
            for key in ("important", "urgent"):
                if key in payload:
                    value = payload[key]
                    if value is not None and not isinstance(value, bool):
                        raise TaskError(f"{key} must be a boolean or null")
                    overrides[key] = value
            overrides["at"] = iso_s(now or utc_now())
            task["overrides"] = overrides
        return self.save(task, now=now)

    def find_by_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """The newest task (open first) that has this agent session."""
        hits = [t for t in self.load_all() if session_id in task_sessions(t)]
        if not hits:
            return None
        hits.sort(key=lambda t: (is_open(t), str(t.get("updated_at") or "")), reverse=True)
        return hits[0]

    def set_name(self, payload: Dict[str, Any], now: Optional[datetime] = None) -> Tuple[Dict[str, Any], bool]:
        """POST /cockpit/tasks/name: {task_id? | session_id?, name, source} with the precedence rule."""
        task_id, session_id = payload.get("task_id"), payload.get("session_id")
        task = None
        if isinstance(task_id, str) and task_id:
            task = self.get(task_id)
        if task is None and isinstance(session_id, str) and session_id:
            task = self.find_by_session(session_id)
        if task is None:
            raise TaskNotFound(task_id or session_id or "")
        before = task.get("name_custom_seen")
        changed = apply_name(task, payload.get("name"), payload.get("source") or "user")
        if changed or task.get("name_custom_seen") != before:
            self.save(task, now=now)
        return task, changed

    def confirm(self, task_id: str, payload: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        task = self.require(task_id)
        if payload.get("serves") is not None:
            task["serves"] = _str_list("serves", payload["serves"])
        if "workstream" in payload:
            task["workstream"] = _opt_str("workstream", payload["workstream"])
        if payload.get("title") is not None:
            task["title"] = _title(payload["title"])
            task["title_source"] = "user"
        if not task.get("confirmed"):
            task["confirmed"] = True
            task["confirmed_at"] = iso_s(now)
        return self.save(task, now=now)

    def link(self, task_id: str, payload: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        task = self.require(task_id)
        if not any(payload.get(k) is not None for k in ("pty_id", "session_id")):
            raise TaskError("pty_id or session_id is required")
        task["agent"] = _agent(
            {k: payload.get(k) for k in ("pty_id", "session_id", "provider", "tab_label")},
            task.get("agent"),
        )
        if not task.get("confirmed"):
            task["confirmed"] = True
            task["confirmed_at"] = iso_s(now)
        return self.save(task, now=now)

    def close(self, task_id: str, payload: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        task = self.require(task_id)
        status = _choice("status", payload.get("status"), CLOSED_STATUSES)
        accepted = payload.get("accepted")
        accepted = (status == "done") if accepted is None else _bool("accepted", accepted)
        note = _opt_str("note", payload.get("note"))
        task["status"] = status
        task["accepted"] = accepted
        task["closed_at"] = iso_s(now)
        task["outcome"] = outcome_text(task, status, note)
        task["commits"] = task_commits(self.workspace, task) if accepted else []
        if task.get("agent"):
            task["agent"] = dict(task["agent"], pty_id=None)
        self.save(task, now=now)
        self.record_event("closed", task, f"{'Done' if status == 'done' else 'Discarded'}: {task['title']}")
        return task

    def promote(self, task_id: str, payload: Dict[str, Any], ws_store, now: Optional[datetime] = None) -> Tuple[Dict[str, Any], str]:
        """Create a workstream from the task (deterministic) and link it."""
        from ..workstream.models import Workstream, WorkstreamBrief

        now = now or utc_now()
        task = self.require(task_id)
        title = _title(payload["title"]) if payload.get("title") is not None else task["title"]
        summary = (task.get("lee_status") or {}).get("summary") or task.get("summary")
        objective = title + (f"\n\n{summary}" if summary else "")
        brief = WorkstreamBrief(objective=objective)
        ws = Workstream(title=title, brief=brief, serves=list(task.get("serves") or []))
        ws_store.create(ws)
        ws_store.save_brief(ws.id, brief)
        task["workstream"] = ws.id
        if not task.get("confirmed"):
            task["confirmed"] = True
            task["confirmed_at"] = iso_s(now)
        self.save(task, now=now)
        return task, ws.id


def outcome_text(task: Dict[str, Any], status: str, note: Optional[str]) -> str:
    parts = [f"{'Done' if status == 'done' else 'Discarded'} by you."]
    report = (task.get("lee_status") or {}).get("summary") or task.get("summary")
    if report:
        parts.append(f"Agent's last report (the agent's words): {clip(report)}")
    if note:
        parts.append(note)
    return " ".join(parts)


def task_commits(workspace: Path, task: Dict[str, Any]) -> List[str]:
    """Commits on the default branch since the task was created that touch its files."""
    from ..copilot.digest import _norm, git_wins

    files = {_norm(f, str(workspace)) for f in task.get("files") or [] if isinstance(f, str) and f}
    created = parse_time(task.get("created_at"))
    if not files or created is None:
        return []
    out: List[str] = []
    for win in sorted(git_wins(Path(workspace), created - timedelta(seconds=1)), key=lambda w: w.get("at") or ""):
        if files.intersection(win.get("_files") or []):
            out.append(win["ref"])
    return out[:MAX_COMMITS]
