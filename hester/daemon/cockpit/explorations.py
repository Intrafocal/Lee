"""
Explore: durable explorations (spec §7.5, v-now scope: section + persistence).

One markdown file per exploration at
``<workspace>/.hester/explore/<id>.md`` (0600, dir 0700; ``.hester/`` is
gitignored), YAML frontmatter plus a free-form body:

    ---
    id: exp-1a2b3c4d
    title: ...
    status: active | archived
    ...
    ---
    # <title>

    ## Seed

    <seed text>

    ## Log

    ### You · 2026-09-26T10:00:00Z

    ...

    ### Hester · 2026-09-26T10:00:05Z

    ...

This replaces nothing yet: the Library pane's tree sessions (Redis, 2 h TTL)
are untouched. An exploration's deep dive is a Hester chat session with the
deterministic id ``explore-<id>``: POST .../open seeds that session from the
file, and every finished turn in it is appended back to the file's Log
(``record_turn``), so the file outlives the session's TTL and a later open
re-seeds from it.

Not in scope yet (spec §7.5, later): spikes, decision nodes, archive as
knowledge, promote to goal/workstream/task.
"""

import copy
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .plain import plain_title
from .tasks import atomic_write, iso_s

logger = logging.getLogger("hester.daemon.cockpit.explorations")

EXP_ID_RE = re.compile(r"^exp-[0-9a-f]{8}$")
SESSION_PREFIX = "explore-"
STATUSES = ("active", "archived")
ORIGIN_KINDS = ("cockpit", "someday", "hester")
FIELDS = (
    "id", "workspace", "title", "status", "seed", "origin", "session_id", "turns",
    "created_at", "updated_at", "last_touched_at", "archived_at", "version",
)
MAX_TITLE = 200
MAX_SEED = 8000
MAX_TURN_TEXT = 8000
CONTEXT_CHARS = 12000
LOG_HEADING = "## Log"

_YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class ExplorationError(ValueError):
    pass


class ExplorationNotFound(KeyError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_exploration_id() -> str:
    return f"exp-{secrets.token_hex(4)}"


def session_id_for(exp_id: str) -> str:
    return f"{SESSION_PREFIX}{exp_id}"


def exploration_id_from_session(session_id: Any) -> Optional[str]:
    """``explore-exp-1a2b3c4d`` -> ``exp-1a2b3c4d``; None for any other session."""
    if not isinstance(session_id, str) or not session_id.startswith(SESSION_PREFIX):
        return None
    exp_id = session_id[len(SESSION_PREFIX):]
    return exp_id if EXP_ID_RE.match(exp_id) else None


def _clip(text: Any, limit: int) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _stringify_times(meta: Dict[str, Any]) -> Dict[str, Any]:
    for k, v in list(meta.items()):
        if isinstance(v, datetime):
            meta[k] = iso_s(v if v.tzinfo else v.replace(tzinfo=timezone.utc))
    return meta


class ExplorationStore:
    """File-first exploration store for one workspace. Callers serialise writes (ctx.lock)."""

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.dir = self.workspace / ".hester" / "explore"

    # ---------------------------------------------------------------- files

    def _path(self, exp_id: str) -> Path:
        if not isinstance(exp_id, str) or not EXP_ID_RE.match(exp_id):
            raise ExplorationError(f"invalid exploration id: {exp_id!r}")
        return self.dir / f"{exp_id}.md"

    def _load(self, path: Path) -> Optional[Tuple[Dict[str, Any], str]]:
        try:
            content = path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return None
        if not content.startswith("---\n"):
            return None
        end = content.find("\n---\n", 3)
        if end < 0:
            return None
        try:
            meta = yaml.load(content[4:end + 1], Loader=_YAML_LOADER) or {}
        except yaml.YAMLError:
            return None
        if not isinstance(meta, dict):
            return None
        meta = _stringify_times(meta)
        exp = {k: meta.get(k) for k in FIELDS}
        exp["id"] = str(meta.get("id") or path.stem)
        exp["workspace"] = str(meta.get("workspace") or self.workspace)
        exp["status"] = meta.get("status") if meta.get("status") in STATUSES else "active"
        exp["turns"] = int(meta.get("turns") or 0)
        exp["version"] = int(meta.get("version") or 0)
        exp["session_id"] = meta.get("session_id") or session_id_for(exp["id"])
        return exp, content[end + 5:]

    def _save(self, exp: Dict[str, Any], body: str, now: datetime) -> Dict[str, Any]:
        path = self._path(exp["id"])
        exp["updated_at"] = iso_s(now)
        exp["version"] = int(exp.get("version") or 0) + 1
        head = yaml.safe_dump({k: exp.get(k) for k in FIELDS}, sort_keys=False, allow_unicode=True, default_flow_style=False)
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        atomic_write(path, f"---\n{head}---\n{body}")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return exp

    # ---------------------------------------------------------------- reads

    def get(self, exp_id: str) -> Optional[Dict[str, Any]]:
        loaded = self._load(self._path(exp_id))
        return loaded[0] if loaded else None

    def require(self, exp_id: str) -> Dict[str, Any]:
        exp = self.get(exp_id)
        if exp is None:
            raise ExplorationNotFound(exp_id)
        return exp

    def body(self, exp_id: str) -> str:
        loaded = self._load(self._path(exp_id))
        if loaded is None:
            raise ExplorationNotFound(exp_id)
        return loaded[1]

    def load_all(self) -> List[Dict[str, Any]]:
        out = []
        try:
            paths = sorted(self.dir.glob("exp-*.md"))
        except OSError:
            return out
        for p in paths:
            if not EXP_ID_RE.match(p.stem):
                continue
            loaded = self._load(p)
            if loaded:
                out.append(loaded[0])
        return out

    def list(self, status: str = "active", limit: int = 100) -> List[Dict[str, Any]]:
        if status not in ("active", "archived", "all"):
            raise ExplorationError("status must be active, archived or all")
        items = self.load_all()
        if status != "all":
            items = [e for e in items if e["status"] == status]
        items.sort(key=lambda e: (str(e.get("last_touched_at") or e.get("updated_at") or ""), e["id"]), reverse=True)
        return items[: max(0, limit)]

    # ---------------------------------------------------------------- writes

    def create(self, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        seed = _clip(body.get("seed"), MAX_SEED) if body.get("seed") is not None else ""
        if body.get("seed") is not None and not isinstance(body.get("seed"), str):
            raise ExplorationError("seed must be a string")
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            raise ExplorationError("title must be a string")
        title = _clip(title, MAX_TITLE) if title and title.strip() else (plain_title(seed, 80) or "")
        if not title:
            raise ExplorationError("title or seed is required")
        origin = body.get("origin") or {"kind": "cockpit", "ref": None}
        if not isinstance(origin, dict) or origin.get("kind") not in ORIGIN_KINDS:
            raise ExplorationError(f"origin.kind must be one of {', '.join(ORIGIN_KINDS)}")
        origin = {"kind": origin["kind"], "ref": origin.get("ref") if isinstance(origin.get("ref"), str) else None}
        exp_id = body.get("id") or new_exploration_id()
        path = self._path(exp_id)
        if path.exists():
            raise ExplorationError(f"exploration {exp_id} already exists")
        exp = {k: None for k in FIELDS}
        exp.update({
            "id": exp_id,
            "workspace": str(self.workspace),
            "title": title,
            "status": "active",
            "seed": seed or None,
            "origin": origin,
            "session_id": session_id_for(exp_id),
            "turns": 0,
            "created_at": iso_s(now),
            "last_touched_at": iso_s(now),
            "version": 0,
        })
        text = f"# {title}\n\n## Seed\n\n{seed or '(none)'}\n\n{LOG_HEADING}\n"
        return self._save(exp, text, now)

    def patch(self, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        loaded = self._load(self._path(exp_id))
        if loaded is None:
            raise ExplorationNotFound(exp_id)
        exp, text = loaded
        unknown = set(body) - {"title", "status"}
        if unknown:
            raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
        if "title" in body:
            if not isinstance(body["title"], str) or not body["title"].strip():
                raise ExplorationError("title must be a non-empty string")
            exp["title"] = _clip(body["title"], MAX_TITLE)
        if "status" in body:
            if body["status"] not in STATUSES:
                raise ExplorationError("status must be active or archived")
            if body["status"] != exp["status"]:
                exp["status"] = body["status"]
                exp["archived_at"] = iso_s(now) if body["status"] == "archived" else None
        return self._save(exp, text, now)

    def record_turn(self, exp_id: str, user: Optional[str], assistant: Optional[str], now: Optional[datetime] = None) -> Dict[str, Any]:
        """Append one exchange of the deep dive to the Log and touch the exploration."""
        now = now or utc_now()
        loaded = self._load(self._path(exp_id))
        if loaded is None:
            raise ExplorationNotFound(exp_id)
        exp, text = loaded
        if LOG_HEADING not in text:
            text = text.rstrip("\n") + f"\n\n{LOG_HEADING}\n"
        stamp = iso_s(now)
        parts = []
        if user and user.strip():
            parts.append(f"\n### You · {stamp}\n\n{_clip(user, MAX_TURN_TEXT)}\n")
        if assistant and assistant.strip():
            parts.append(f"\n### Hester · {stamp}\n\n{_clip(assistant, MAX_TURN_TEXT)}\n")
        if not parts:
            return exp
        text = text.rstrip("\n") + "\n" + "".join(parts)
        exp["turns"] = int(exp.get("turns") or 0) + 1
        exp["last_touched_at"] = stamp
        if exp["status"] == "archived":
            exp["status"], exp["archived_at"] = "active", None
        return self._save(exp, text, now)

    def touch(self, exp_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        loaded = self._load(self._path(exp_id))
        if loaded is None:
            raise ExplorationNotFound(exp_id)
        exp, text = loaded
        exp["last_touched_at"] = iso_s(now)
        return self._save(exp, text, now)

    # ---------------------------------------------------------------- seeding

    def context_text(self, exp_id: str, limit: int = CONTEXT_CHARS) -> str:
        """System-message seed for the deep-dive session: the file, newest log kept."""
        exp = self.require(exp_id)
        text = self.body(exp_id).strip()
        if len(text) > limit:
            text = "…(earlier log omitted)…\n" + text[-limit:]
        return (
            "You are Hester in an Explore deep dive with the user: an open-ended, "
            "thinking-out-loud investigation, not a task to finish. Build on what is "
            "already written, raise options and trade-offs, and ask what to dig into "
            f"next. The exploration is titled \"{exp['title']}\" and lives at "
            f".hester/explore/{exp_id}.md in the workspace; each exchange here is "
            "appended to its Log automatically.\n\n"
            "The exploration so far:\n\n" + text
        )


def to_api(exp: Dict[str, Any]) -> Dict[str, Any]:
    return {k: copy.deepcopy(exp.get(k)) for k in FIELDS}


# ---------------------------------------------------------------------------
# Deep-dive sessions: seed on open, write back after each turn
# ---------------------------------------------------------------------------

# Workspace of each deep-dive session opened since the daemon started.
_session_workspaces: Dict[str, Path] = {}
_session_manager_getter = None


def configure_sessions(getter) -> None:
    """Give the store the daemon's Hester SessionManager (a zero-arg getter; main.py)."""
    global _session_manager_getter
    _session_manager_getter = getter


def _sessions():
    return _session_manager_getter() if _session_manager_getter else None


async def open_session(store: ExplorationStore, exp_id: str) -> Dict[str, Any]:
    """Make sure ``explore-<id>`` exists and is seeded from the file. Returns {session_id, seeded}."""
    exp = store.require(exp_id)
    sid = exp.get("session_id") or session_id_for(exp_id)
    _session_workspaces[sid] = store.workspace
    manager = _sessions()
    if manager is None:
        return {"session_id": sid, "seeded": False}
    session = await manager.get(sid)
    if session is not None:
        return {"session_id": sid, "seeded": False}
    session = await manager.create(sid, str(store.workspace))
    session.add_message("system", store.context_text(exp_id))
    lines = [f"**Exploring: {exp['title']}**"]
    if exp.get("seed"):
        lines.append(str(exp["seed"]))
    if int(exp.get("turns") or 0) > 0:
        lines.append(f"_{exp['turns']} earlier exchange(s) are in .hester/explore/{exp_id}.md; I have them in context._")
    lines.append("Where do you want to start?")
    session.add_message("assistant", "\n\n".join(lines))
    await manager.save(session)
    return {"session_id": sid, "seeded": True}


def _workspace_for_session(session_id: str, exp_id: str, working_directory: Optional[str]) -> Optional[Path]:
    ws = _session_workspaces.get(session_id)
    if ws is not None:
        return ws
    if working_directory:
        cand = Path(working_directory)
        if (cand / ".hester" / "explore" / f"{exp_id}.md").exists():
            return cand
    return None


def record_session_turn(session_id: Any, working_directory: Optional[str], user: Optional[str], assistant: Optional[str]) -> bool:
    """Write a finished deep-dive turn back to its exploration. Never raises."""
    exp_id = exploration_id_from_session(session_id)
    if exp_id is None:
        return False
    try:
        ws = _workspace_for_session(session_id, exp_id, working_directory)
        if ws is None:
            return False
        ExplorationStore(ws).record_turn(exp_id, user, assistant)
        return True
    except Exception as e:  # write-back must never break a chat turn
        logger.warning(f"Explore write-back failed for {session_id}: {e}")
        return False
