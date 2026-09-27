"""
The Cockpit event follower: tails Lee's event log (``~/.lee/events/``) and
keeps task records current. Deterministic, no model, so it runs regardless of
presence (C2).

Every 2 s it reads new complete lines after a cursor ``{file, offset}`` kept in
``~/.hester/cockpit/follower.json``; with no cursor it starts at the files of
the last 48 h. Each task remembers ``applied_through`` (``"<ts>|<id>"`` of the
last event applied), so replaying the log after a crash or a reset cursor
never counts anything twice. Operation readings are de-duplicated by
``(run_id, metric)``.

If applying a batch fails for some workspace (a read-only checkout, a full
disk), the cursor goes back to where the batch started so the next tick
replays it (``applied_through`` makes that safe); after ``MAX_APPLY_RETRIES``
failed ticks the batch is given up so one broken workspace can't stall the
rest.

PTY ids restart at 1 with every Lee launch (``app.start``). A task whose pty
was last seen before the most recent launch is not matched by pty alone.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..copilot.digest import _norm
from ..copilot.event_reader import events_dir as default_events_dir
from ..copilot.event_reader import list_files, parse_ts
from ..copilot.usage import accumulate, merge_usage
from . import handoffs, spikes
from .plain import plain_title
from .tasks import (
    CLOSED_STATUSES,
    MAX_FILES,
    atomic_write,
    clean_worktree,
    clip,
    default_task,
    is_open,
    iso_s,
    new_task_id,
    parse_time,
    task_sessions,
)

logger = logging.getLogger("hester.daemon.cockpit.follower")

TICK_S = 2.0
START_LOOKBACK = timedelta(hours=48)
CLOSED_IGNORE = timedelta(hours=24)
MAX_PENDING = 500
MAX_APPLY_RETRIES = 5
MAX_BOOTS = 20

FOLLOW_TYPES = {
    "task.launch",
    "agent.session_start",
    "agent.prompt",
    "agent.tool",
    "agent.waiting",
    "agent.turn_end",
    "agent.usage",
    "agent.session_end",
    "agent.exit",
    "checkin.result",
    "operation.result",
    "app.start",
}

# Origins whose ref points back at what launched them (a spike node, a hand-off record).
REF_ORIGINS = ("explore", "exploration")

LEE_STATUS_MAP = {"done": "review", "blocked": "waiting", "waiting": "waiting", "in-progress": "running"}


def default_state_file() -> Path:
    override = os.environ.get("HESTER_COCKPIT_STATE_DIR")
    base = Path(override).expanduser() if override else Path.home() / ".hester" / "cockpit"
    return base / "follower.json"


def event_key(ev: Dict[str, Any]) -> str:
    return f"{ev.get('ts')}|{ev.get('id')}"


def _key_tuple(key: Optional[str]) -> Optional[Tuple[datetime, str]]:
    if not isinstance(key, str) or "|" not in key:
        return None
    ts, _, eid = key.partition("|")
    dt = parse_ts(ts)
    return (dt, eid) if dt else None


def already_applied(task: Dict[str, Any], ev: Dict[str, Any]) -> bool:
    done = _key_tuple(task.get("applied_through"))
    if done is None:
        return False
    return (ev["_ts"], str(ev.get("id"))) <= done


def status_from_lee_status(lee_status: Any) -> str:
    s = lee_status.get("status") if isinstance(lee_status, dict) else None
    return LEE_STATUS_MAP.get(s, "idle")


def launch_ref(data: Dict[str, Any]) -> Optional[str]:
    """The origin ref a ``task.launch`` event carries (``origin_ref``, or ``origin.ref``)."""
    ref = data.get("origin_ref")
    if ref is None and isinstance(data.get("origin"), dict):
        ref = data["origin"].get("ref")
    return str(ref) if isinstance(ref, str) and ref else None


def launch_timebox(data: Dict[str, Any], lead: str) -> Optional[int]:
    """A ``task.launch``'s ``timebox_min`` (1-1440), else 30 for a delegate lead."""
    tb = data.get("timebox_min")
    if isinstance(tb, int) and not isinstance(tb, bool) and 1 <= tb <= 1440:
        return tb
    return 30 if lead == "delegate" else None


def _file_key(name: str) -> Optional[Tuple[str, int]]:
    base = name[:-len(".jsonl")] if name.endswith(".jsonl") else name
    day, _, suffix = base.partition(".")
    try:
        return (day, int(suffix or 0))
    except ValueError:
        return None


class EventFollower:
    def __init__(
        self,
        registry=None,
        events_dir: Optional[Path] = None,
        state_file: Optional[Path] = None,
        clock=None,
    ):
        self._registry = registry
        self._events_dir = events_dir
        self._state_file = state_file
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._loaded = False
        self._cursor: Optional[Dict[str, Any]] = None
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._session_ws: Dict[str, str] = {}
        self._session_cwd: Dict[str, str] = {}
        self._pty_ws: Dict[int, str] = {}
        self._indexed: set = set()
        self._by_session: Dict[str, Tuple[str, str]] = {}
        self._by_pty: Dict[int, Tuple[str, str]] = {}
        self._task_task: Optional[asyncio.Task] = None
        self._boots: List[datetime] = []
        self._apply_failures = 0

    # ------------------------------------------------------------------ plumbing

    @property
    def registry(self):
        if self._registry is None:
            from ..workspaces.registry import get_registry
            self._registry = get_registry()
        return self._registry

    def _dir(self) -> Path:
        return Path(self._events_dir) if self._events_dir else default_events_dir()

    def _state_path(self) -> Path:
        return Path(self._state_file) if self._state_file else default_state_file()

    def _load_state(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            state = json.loads(self._state_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        cursor = state.get("cursor") if isinstance(state, dict) else None
        if isinstance(cursor, dict) and isinstance(cursor.get("file"), str) and isinstance(cursor.get("offset"), int):
            self._cursor = cursor
        pending = state.get("pending") if isinstance(state, dict) else None
        if isinstance(pending, dict):
            self._pending = {k: v for k, v in pending.items() if isinstance(v, dict)}
            boots = state.get("boots") if isinstance(state, dict) else None
            if isinstance(boots, list):
                self._boots = sorted(b for b in (parse_ts(x) for x in boots) if b is not None)[-MAX_BOOTS:]
            for sid, p in self._pending.items():
                if p.get("workspace"):
                    self._session_ws[sid] = p["workspace"]
                if p.get("cwd"):
                    self._session_cwd[sid] = p["cwd"]

    def _save_state(self) -> None:
        cutoff = iso_s(self._clock() - START_LOOKBACK)
        pending = {k: v for k, v in self._pending.items() if str(v.get("ts") or "") >= cutoff}
        if len(pending) > MAX_PENDING:
            keep = sorted(pending.items(), key=lambda kv: str(kv[1].get("ts") or ""))[-MAX_PENDING:]
            pending = dict(keep)
        self._pending = pending
        try:
            atomic_write(self._state_path(), json.dumps({
                "cursor": self._cursor, "pending": pending,
                "boots": [iso_s(b) for b in self._boots[-MAX_BOOTS:]],
            }))
        except OSError as e:
            logger.warning(f"Cannot save follower state: {e}")

    def reset_cursor(self) -> None:
        self._load_state()
        self._cursor = None

    # ------------------------------------------------------------------ reading

    def read_new(self) -> List[Dict[str, Any]]:
        """New events after the cursor, advancing it (complete lines only)."""
        self._load_state()
        files = list_files(self._dir())
        if not files:
            return []
        now = self._clock()
        min_ts: Optional[datetime] = None
        start = 0
        offset = 0
        if self._cursor is None:
            cutoff_day = (now - START_LOOKBACK).astimezone().date()
            start = next((i for i, f in enumerate(files) if f[0] >= cutoff_day), len(files))
            min_ts = now - START_LOOKBACK
        else:
            names = [f[2].name for f in files]
            if self._cursor["file"] in names:
                start = names.index(self._cursor["file"])
                offset = self._cursor["offset"]
            else:
                key = _file_key(self._cursor["file"])
                start = next(
                    (i for i, f in enumerate(files) if key is None or (f[0].isoformat(), f[1]) > key),
                    len(files),
                )
        events: List[Dict[str, Any]] = []
        for i in range(start, len(files)):
            path = files[i][2]
            pos = offset if i == start else 0
            try:
                size = path.stat().st_size
                if size < pos:
                    pos = 0
                with open(path, "rb") as f:
                    f.seek(pos)
                    chunk = f.read()
            except OSError as e:
                logger.debug(f"Cannot read {path}: {e}")
                continue
            end = chunk.rfind(b"\n")
            complete = chunk[: end + 1] if end >= 0 else b""
            self._cursor = {"file": path.name, "offset": pos + len(complete)}
            for raw in complete.decode("utf-8", errors="replace").splitlines():
                if not any(f'"{t}"' in raw for t in FOLLOW_TYPES):
                    continue
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(ev, dict) or ev.get("type") not in FOLLOW_TYPES:
                    continue
                ts = parse_ts(ev.get("ts"))
                if ts is None or (min_ts is not None and ts < min_ts):
                    continue
                ev["_ts"] = ts
                events.append(ev)
        return events

    # ------------------------------------------------------------------ indexes

    def _index_workspace(self, ctx) -> None:
        ws = str(ctx.path)
        if ws in self._indexed:
            return
        self._indexed.add(ws)
        for task in ctx.tasks().load_all():
            self._index_task(ws, task)

    def _index_task(self, ws: str, task: Dict[str, Any]) -> None:
        for sid in task_sessions(task):
            self._by_session[sid] = (ws, task["id"])
            self._session_ws.setdefault(sid, ws)
        pty = (task.get("agent") or {}).get("pty_id")
        if isinstance(pty, int) and is_open(task):
            self._by_pty[pty] = (ws, task["id"])

    def _workspace_for_cwd(self, cwd: Optional[str]) -> Optional[str]:
        if not cwd:
            return None
        p = os.path.normpath(cwd)
        best = None
        for ctx in self.registry.list():
            root = str(ctx.path)
            if p == root or p.startswith(root.rstrip(os.sep) + os.sep):
                if best is None or len(root) > len(best):
                    best = root
        return best

    def _resolve_ws(self, ev: Dict[str, Any]) -> Optional[str]:
        data = ev.get("data") or {}
        sid = data.get("session_id") if isinstance(data.get("session_id"), str) else None
        pty = data.get("pty_id") if isinstance(data.get("pty_id"), int) else None
        ws = os.path.normpath(ev["workspace"]) if isinstance(ev.get("workspace"), str) and ev["workspace"] else None
        if ws is None:
            ws = self._workspace_for_cwd(data.get("cwd") or (self._session_cwd.get(sid) if sid else None))
        if ws is None and sid:
            ws = self._session_ws.get(sid) or (self._by_session.get(sid) or (None,))[0]
        if ws is None and pty is not None:
            ws = self._pty_ws.get(pty) or (self._by_pty.get(pty) or (None,))[0]
        if ws is None:
            return None
        if sid:
            self._session_ws[sid] = ws
            if ev.get("type") == "agent.session_start" and data.get("cwd"):
                self._session_cwd[sid] = os.path.normpath(data["cwd"])
        if pty is not None:
            self._pty_ws[pty] = ws
        return ws

    # ------------------------------------------------------------------ tick

    async def tick(self) -> int:
        """Read and apply new events. Returns how many were applied to some workspace."""
        self._load_state()
        prev_cursor = dict(self._cursor) if self._cursor else None
        events = await asyncio.to_thread(self.read_new)
        groups: Dict[str, List[Dict[str, Any]]] = {}
        order: List[str] = []
        for ev in events:
            if ev.get("type") == "app.start":
                self._note_boot(ev["_ts"])
                continue
            ws = self._resolve_ws(ev)
            if ws is None:
                continue
            if ws not in groups:
                groups[ws] = []
                order.append(ws)
            groups[ws].append(ev)
        applied = 0
        failed = False
        for ws in order:
            try:
                ctx = self.registry.get(ws, source="request")
            except ValueError:
                continue
            try:
                async with ctx.lock:
                    # Off the event loop: a reindex parses the workspace's task files.
                    applied += await asyncio.to_thread(self._apply_workspace, ctx, groups[ws])
            except asyncio.CancelledError:
                raise
            except Exception as e:
                failed = True
                logger.warning(f"Cockpit follower could not apply events for {ws}: {e}")
        if failed and events:
            self._apply_failures += 1
            if self._apply_failures < MAX_APPLY_RETRIES:
                self._cursor = prev_cursor
                return applied
            logger.warning(f"Cockpit follower giving up on a batch after {self._apply_failures} failed ticks")
        self._apply_failures = 0
        self._save_state()
        return applied

    def _note_boot(self, ts: datetime) -> None:
        """A Lee launch: PTY ids restart, so pty-only matches from before it are stale."""
        if ts not in self._boots:
            self._boots.append(ts)
            self._boots.sort()
            self._boots = self._boots[-MAX_BOOTS:]
        if ts == self._boots[-1]:
            self._pty_ws.clear()
            self._by_pty.clear()

    def _boot_before(self, ts: datetime) -> Optional[datetime]:
        best = None
        for b in self._boots:
            if b <= ts:
                best = b
        return best

    def _pty_current(self, task: Dict[str, Any], ev: Dict[str, Any]) -> bool:
        """Was the task's pty seen in the same Lee run as this event?"""
        boot = self._boot_before(ev["_ts"])
        if boot is None:
            return True
        seen = [parse_time(task.get("created_at"))]
        done = _key_tuple(task.get("applied_through"))
        if done is not None:
            seen.append(done[0])
        seen = [s for s in seen if s is not None]
        return bool(seen) and max(seen) >= boot

    async def run(self, interval: float = TICK_S) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Cockpit follower tick failed: {e}")
            await asyncio.sleep(interval)

    def start(self) -> None:
        if self._task_task is None or self._task_task.done():
            self._task_task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self._task_task is not None:
            self._task_task.cancel()
            try:
                await self._task_task
            except (asyncio.CancelledError, Exception):
                pass
            self._task_task = None

    # ------------------------------------------------------------------ apply

    def _apply_workspace(self, ctx, events: List[Dict[str, Any]]) -> int:
        self._index_workspace(ctx)
        ws = str(ctx.path)
        store = ctx.tasks()
        cache: Dict[str, Dict[str, Any]] = {}
        dirty: set = set()
        notes: List[Tuple[str, str, str, str]] = []
        removed: set = set()
        turn_ends: set = set()

        def load(task_id: str) -> Optional[Dict[str, Any]]:
            if task_id not in cache:
                try:
                    task = store.get(task_id)
                except ValueError:
                    task = None
                if task is None:
                    return None
                cache[task_id] = task
            return cache[task_id]

        def mark(task: Dict[str, Any], ev: Dict[str, Any]) -> None:
            task["applied_through"] = event_key(ev)
            cache[task["id"]] = task
            dirty.add(task["id"])

        def set_status(task: Dict[str, Any], status: str, ev: Dict[str, Any]) -> None:
            if task.get("status") == status:
                return
            task["status"] = status
            if status in ("review", "waiting"):
                notes.append(("status", task["id"], f"{task.get('title')}: {status}", iso_s(ev["_ts"])))

        reindexed = [False]

        def find(ev: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            task = lookup(ev)
            data = ev.get("data") or {}
            if task is None and not reindexed[0] and (data.get("session_id") or isinstance(data.get("pty_id"), int)):
                # Tasks created or linked over HTTP since the index was built
                # (Tabs "Assign...", the relay) must not become duplicates.
                reindexed[0] = True
                self._indexed.discard(ws)
                self._index_workspace(ctx)
                task = lookup(ev)
            return task

        def lookup(ev: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            data = ev.get("data") or {}
            tid = data.get("task_id")
            if isinstance(tid, str) and tid:
                task = load(tid)
                if task is not None:
                    return task
            sid = data.get("session_id")
            if isinstance(sid, str) and sid in self._by_session:
                hit_ws, hit_id = self._by_session[sid]
                if hit_ws == ws:
                    task = load(hit_id)
                    if task is not None:
                        return task
            pty = data.get("pty_id")
            if isinstance(pty, int) and pty in self._by_pty:
                hit_ws, hit_id = self._by_pty[pty]
                if hit_ws == ws:
                    task = load(hit_id)
                    if task is not None and is_open(task) and self._pty_current(task, ev):
                        task_sid = (task.get("agent") or {}).get("session_id")
                        if not sid or not task_sid or task_sid == sid:
                            return task
            return None

        def recently_closed(task: Dict[str, Any], ev: Dict[str, Any]) -> bool:
            closed = parse_time(task.get("closed_at"))
            return closed is not None and ev["_ts"] - closed < CLOSED_IGNORE

        def new_task(task_id: Optional[str], ev: Dict[str, Any]) -> Dict[str, Any]:
            task = default_task(task_id or new_task_id(), ws, ev["_ts"])
            store._path(task["id"])
            return task

        def attach_session(task: Dict[str, Any], sid: Optional[str], pty: Optional[int], provider: Optional[str] = None) -> None:
            agent = dict(task.get("agent") or {"provider": provider or "claude", "pty_id": None, "session_id": None, "tab_label": None, "model": None})
            if sid and not agent.get("session_id"):
                agent["session_id"] = sid
            if pty is not None:
                agent["pty_id"] = pty
            task["agent"] = agent
            if sid:
                sessions = list(task.get("sessions") or [])
                if sid not in sessions:
                    sessions.append(sid)
                task["sessions"] = sessions
            self._index_task(ws, task)

        def is_auto(task: Dict[str, Any]) -> bool:
            return (task.get("origin") or {}).get("kind") == "agent" and not task.get("confirmed")

        def fold(src: Dict[str, Any], dst: Dict[str, Any]) -> None:
            """Move an automatic task's progress into ``dst`` and drop ``src``."""
            dst["busy_ms"] = int(dst.get("busy_ms") or 0) + int(src.get("busy_ms") or 0)
            dst["turns"] = int(dst.get("turns") or 0) + int(src.get("turns") or 0)
            if src.get("usage"):
                dst["usage"] = merge_usage(dst.get("usage"), src["usage"])
            files = list(dst.get("files") or [])
            for f in src.get("files") or []:
                if f not in files and len(files) < MAX_FILES:
                    files.append(f)
            dst["files"] = files
            dst["files_count"] = len(files)
            sessions = list(dst.get("sessions") or [])
            for sid_ in src.get("sessions") or []:
                if sid_ not in sessions:
                    sessions.append(sid_)
            dst["sessions"] = sessions
            for key in ("summary", "lee_status", "last_checkin_at"):
                if not dst.get(key) and src.get(key):
                    dst[key] = src[key]
            # the file count at the agent's first report (0 is a real value)
            if dst.get("files_at_first_report") is None and src.get("files_at_first_report") is not None:
                dst["files_at_first_report"] = src["files_at_first_report"]
            if dst.get("title_source") == "auto" and src.get("title_source") == "agent" and src.get("title"):
                dst["title"], dst["title_source"] = src["title"], "agent"
            if is_open(dst) and src.get("status") in ("waiting", "idle", "review"):
                dst["status"] = src["status"]
            if src.get("agent"):
                agent = dict(dst.get("agent") or {})
                for k, v in src["agent"].items():
                    if agent.get(k) is None and v is not None:
                        agent[k] = v
                dst["agent"] = agent
            done = _key_tuple(src.get("applied_through"))
            if done is not None and (_key_tuple(dst.get("applied_through")) or done) <= done:
                dst["applied_through"] = src["applied_through"]
            cache.pop(src["id"], None)
            dirty.discard(src["id"])
            removed.add(src["id"])
            for m in (self._by_session, self._by_pty):
                for k, v in list(m.items()):
                    if v == (ws, src["id"]):
                        m[k] = (ws, dst["id"])
            cache[dst["id"]] = dst

        def apply_report(task: Dict[str, Any], data: Dict[str, Any], ev: Dict[str, Any], respect_agent_title: bool) -> None:
            lee_status = data.get("lee_status") if isinstance(data.get("lee_status"), dict) else None
            summary = clip(data.get("summary")) if data.get("summary") else None
            if summary:
                task["summary"] = summary
            task["lee_status"] = lee_status
            if task.get("files_at_first_report") is None:
                # Set once: the baseline for Lee's scope/task-growth lint rule.
                task["files_at_first_report"] = len(task.get("files") or [])
            set_status(task, status_from_lee_status(lee_status), ev)
            source = task.get("title_source")
            if source == "auto" or (not respect_agent_title and source != "user"):
                title = plain_title((lee_status or {}).get("summary") or data.get("summary"), 80)
                if title:
                    task["title"] = title
                    task["title_source"] = "agent"

        applied = 0
        for ev in events:
            t = ev.get("type")
            data = ev.get("data") or {}
            sid = data.get("session_id") if isinstance(data.get("session_id"), str) and data.get("session_id") else None
            pty = data.get("pty_id") if isinstance(data.get("pty_id"), int) else None

            if t == "operation.result":
                if data.get("op") and data.get("run_id"):
                    ctx.readings().append(ev.get("ts"), str(data["op"]), str(data["run_id"]), data.get("readings") or [])
                    applied += 1
                continue

            task = find(ev)
            if task is not None and already_applied(task, ev):
                continue
            if task is not None and not is_open(task):
                if recently_closed(task, ev) or t != "agent.prompt":
                    continue
                task = None

            if t == "task.launch":
                tid = data.get("task_id")
                if not isinstance(tid, str) or not tid:
                    continue
                adopted = None
                if task is not None and task["id"] != tid and is_auto(task):
                    # The hooks beat a slow relay to the log: fold the automatic
                    # task into the launched one instead of keeping both.
                    adopted, task = task, load(tid)
                if task is None:
                    try:
                        task = new_task(tid, ev)
                    except ValueError:
                        continue
                    lead = data.get("lead") if data.get("lead") in ("delegate", "human", "plan") else "delegate"
                    task.update({
                        "lead": lead,
                        "kind": data.get("kind") if data.get("kind") in ("bug", "question", "prototype", "chore", "unknown") else "unknown",
                        "play": bool(data.get("play")),
                        "title": "(untitled)",
                        "title_source": "auto",
                        "status": "running" if (pty is not None or sid) else "queued",
                        "origin": {"kind": data.get("origin_kind") or "launcher", "ref": launch_ref(data)},
                        "timebox_min": launch_timebox(data, lead),
                    })
                    if data.get("confirmed"):
                        task["confirmed"] = True
                        task["confirmed_at"] = iso_s(ev["_ts"])
                    if pty is not None or sid:
                        task["agent"] = {
                            "provider": data.get("provider") or "claude", "pty_id": pty, "session_id": sid,
                            "tab_label": None, "model": data.get("model"),
                        }
                    notes.append(("created", task["id"], "Task launched", iso_s(ev["_ts"])))
                if adopted is not None:
                    fold(adopted, task)
                worktree = clean_worktree(data.get("worktree"))
                if worktree is not None and not task.get("worktree"):
                    task["worktree"] = worktree
                origin = task.get("origin") or {}
                if data.get("origin_kind") in REF_ORIGINS and origin.get("kind") == data["origin_kind"] and not origin.get("ref"):
                    task["origin"] = {"kind": data["origin_kind"], "ref": launch_ref(data)}
                if pty is not None or sid:
                    attach_session(task, sid, pty, data.get("provider"))
                if sid:
                    self._pending.pop(sid, None)
                mark(task, ev)
                applied += 1
                continue

            if t == "agent.session_start":
                if task is None:
                    if sid:
                        self._pending[sid] = {
                            "pty_id": pty, "cwd": data.get("cwd"), "workspace": ws,
                            "provider": data.get("provider"), "ts": iso_s(ev["_ts"]),
                        }
                    continue
                attach_session(task, sid, pty)
                if sid:
                    self._pending.pop(sid, None)
                mark(task, ev)
                applied += 1
                continue

            if t == "agent.prompt" and task is None:
                if not sid:
                    continue
                pending = self._pending.pop(sid, {})
                task = new_task(None, ev)
                cwd = pending.get("cwd") or self._session_cwd.get(sid) or ws
                provider = pending.get("provider") or data.get("provider") or "claude"
                name = "Pi" if provider == "pi" else "Claude"
                task.update({
                    "title": f"{name} in {os.path.basename(os.path.normpath(cwd)) or cwd}",
                    "title_source": "auto",
                    "status": "running",
                    "origin": {"kind": "agent", "ref": None},
                })
                attach_session(task, sid, pty if pty is not None else pending.get("pty_id"), provider)
                notes.append(("auto_created", task["id"], f"Automatic task: {task['title']}", iso_s(ev["_ts"])))

            if t == "checkin.result":
                if not data.get("ok"):
                    continue
                if task is None:
                    task = new_task(None, ev)
                    task.update({"status": "running", "origin": {"kind": "checkin", "ref": data.get("checkin_id")}})
                    if pty is not None or sid:
                        attach_session(task, sid, pty)
                    notes.append(("auto_created", task["id"], "Task from a check-in", iso_s(ev["_ts"])))
                apply_report(task, data, ev, respect_agent_title=False)
                task["last_checkin_at"] = iso_s(ev["_ts"])
                mark(task, ev)
                applied += 1
                continue

            if task is None:
                continue

            if sid:
                self._pending.pop(sid, None)
            if sid and sid not in (task.get("sessions") or []):
                attach_session(task, sid, pty)

            if t in ("agent.prompt", "agent.tool"):
                set_status(task, "running", ev)
                if t == "agent.tool" and data.get("writes"):
                    base = self._session_cwd.get(sid or "") or ws
                    files = list(task.get("files") or [])
                    for f in data.get("files") or []:
                        if isinstance(f, str) and f:
                            p = _norm(f, base)
                            if p not in files and len(files) < MAX_FILES:
                                files.append(p)
                    task["files"] = files
                    task["files_count"] = len(files)
            elif t == "agent.waiting":
                set_status(task, "waiting", ev)
            elif t == "agent.turn_end":
                busy = data.get("busy_ms")
                if isinstance(busy, (int, float)) and not isinstance(busy, bool) and busy > 0:
                    task["busy_ms"] = int(task.get("busy_ms") or 0) + int(busy)
                task["turns"] = int(task.get("turns") or 0) + 1
                apply_report(task, data, ev, respect_agent_title=True)
                turn_ends.add(task["id"])
            elif t == "agent.usage":
                task["usage"] = accumulate(task.get("usage"), data.get("by_model"))
            elif t in ("agent.session_end", "agent.exit"):
                old_pty = (task.get("agent") or {}).get("pty_id")
                if task.get("agent"):
                    task["agent"] = dict(task["agent"], pty_id=None)
                for key in {old_pty, pty}:
                    if isinstance(key, int) and self._by_pty.get(key) == (ws, task["id"]):
                        self._by_pty.pop(key, None)
                if task.get("status") in ("running", "waiting", "idle"):
                    set_status(task, "review", ev)
            mark(task, ev)
            applied += 1

        for task_id in dirty:
            if task_id in removed:
                continue
            task = cache[task_id]
            if task.get("status") in CLOSED_STATUSES:
                task["agent"] = dict(task["agent"], pty_id=None) if task.get("agent") else None
            store.save(task)
        for task_id in removed:
            store.delete(task_id)
        # Spike nodes follow their explore-origin tasks (launch, status, evidence);
        # hand-off records their exploration-origin tasks (state, result).
        for task_id in dirty:
            task = cache.get(task_id)
            if task_id in removed or task is None:
                continue
            kind = (task.get("origin") or {}).get("kind")
            if kind == "explore":
                spikes.sync(ctx, task, turn_end=task_id in turn_ends)
            elif kind == handoffs.ORIGIN_KIND:
                handoffs.sync(ctx, task, turn_end=task_id in turn_ends)
        for kind, task_id, text, at in notes:
            if task_id in cache and task_id not in removed:
                store.record_event(kind, cache[task_id], text, at=at)
        return applied
