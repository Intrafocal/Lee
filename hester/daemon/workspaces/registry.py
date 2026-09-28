"""
Per-workspace state for the one daemon that serves every Lee window.

The active workspace (the focused window's, set by POST /workspace) still
drives the follow-active singletons in main.py (plugins, knowledge, watchers).
Everything v2 keys by workspace (Cockpit tasks, readings, workstreams) lives
on a WorkspaceContext from this registry instead, so two windows on two
workspaces are served side by side.
"""

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

import httpx

from ...shared.auth import auth_headers
from ...shared.config import config_paths, load_merged_config
from ...shared.workspace import get_active_workspace, workspace_id
from ..hester_dir import ensure_gitignored

logger = logging.getLogger("hester.daemon.workspaces.registry")

PROTECTED_SOURCES = {"window", "active", "boot"}
IDLE_EVICT_S = 30 * 60
MAX_CONTEXTS = 32
SYNC_INTERVAL_S = 15.0
SYNC_TIMEOUT_S = 2.0


class WorkspaceError(ValueError):
    pass


def validate_workspace(value: Any) -> Path:
    """An absolute, existing directory, resolved; else WorkspaceError."""
    if isinstance(value, Path):
        value = str(value)
    if not isinstance(value, str) or not value:
        raise WorkspaceError("workspace must be an absolute directory")
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise WorkspaceError("workspace must be an absolute directory")
    return path.resolve()


def _config_candidates(path: Path) -> List[Path]:
    return [Path(p) for p in config_paths(path)]


def _mtimes(paths: List[Path]) -> tuple:
    out = []
    for p in paths:
        try:
            out.append(p.stat().st_mtime_ns)
        except OSError:
            out.append(None)
    return tuple(out)


@dataclass(eq=False)
class WorkspaceContext:
    path: Path
    id: str
    sources: Set[str]
    opened_at: float
    last_used: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _ws_store: Any = field(default=None, repr=False)
    _tasks: Any = field(default=None, repr=False)
    _readings: Any = field(default=None, repr=False)
    _someday: Any = field(default=None, repr=False)
    _explorations: Any = field(default=None, repr=False)
    _desk: Any = field(default=None, repr=False)
    _config: Optional[dict] = field(default=None, repr=False)
    _config_key: Optional[tuple] = field(default=None, repr=False)

    def ws_store(self):
        if self._ws_store is None:
            from ..workstream.store import WorkstreamStore
            self._ws_store = WorkstreamStore(working_dir=self.path)
        return self._ws_store

    def tasks(self):
        if self._tasks is None:
            from ..cockpit.tasks import CockpitTaskStore
            self._tasks = CockpitTaskStore(self.path)
        return self._tasks

    def readings(self):
        if self._readings is None:
            from ..cockpit.readings import ReadingsStore
            self._readings = ReadingsStore(self.path)
        return self._readings

    def someday(self):
        if self._someday is None:
            from ..copilot.someday import SomedayStore
            self._someday = SomedayStore(self.path)
        return self._someday

    def explorations(self):
        if self._explorations is None:
            from ..cockpit.explorations import ExplorationStore
            self._explorations = ExplorationStore(self.path)
        return self._explorations

    def desk(self):
        if self._desk is None:
            from ..cockpit.desk import DeskStore
            self._desk = DeskStore(self.path)
        return self._desk

    def config(self) -> dict:
        key = _mtimes(_config_candidates(self.path))
        if self._config is None or key != self._config_key:
            try:
                self._config = load_merged_config(self.path) or {}
            except Exception as e:
                logger.warning(f"Config load failed for {self.path}: {e}")
                self._config = {}
            self._config_key = key
        return self._config

    def entry(self, active: bool) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "id": self.id,
            "active": active,
            "sources": sorted(self.sources),
            "opened_at": self.opened_at,
            "last_used": self.last_used,
        }


WindowsFetcher = Callable[[], Awaitable[Optional[List[Dict[str, Any]]]]]


class WorkspaceRegistry:
    def __init__(
        self,
        boot: Optional[Path] = None,
        lee_url: Optional[str] = None,
        fetch_windows: Optional[WindowsFetcher] = None,
        clock: Callable[[], float] = time.time,
        max_contexts: int = MAX_CONTEXTS,
        idle_evict_s: float = IDLE_EVICT_S,
    ):
        self._contexts: Dict[str, WorkspaceContext] = {}
        self._lock = threading.RLock()
        self._clock = clock
        self._lee_url = lee_url
        self._fetch_windows = fetch_windows or self._default_fetch_windows
        self._max = max_contexts
        self._idle_s = idle_evict_s
        boot_path = Path(boot).expanduser().resolve() if boot is not None else get_active_workspace()
        self._ensure(boot_path, {"boot", "active"})

    # ------------------------------------------------------------------ core

    def _ensure(self, path: Path, sources: Set[str]) -> WorkspaceContext:
        now = self._clock()
        with self._lock:
            ctx = self._contexts.get(str(path))
            if ctx is None:
                ctx = WorkspaceContext(
                    path=path, id=workspace_id(path), sources=set(), opened_at=now, last_used=now,
                )
                self._contexts[str(path)] = ctx
                ensure_gitignored(path)  # .hester/ stays out of the project's git
            ctx.sources.update(sources)
            ctx.last_used = now
            self._cap_locked()
            return ctx

    def _cap_locked(self) -> None:
        while len(self._contexts) > self._max:
            candidates = [c for c in self._contexts.values() if not (c.sources & {"active", "boot"})]
            if not candidates:
                return
            victim = min(candidates, key=lambda c: c.last_used)
            self._contexts.pop(str(victim.path), None)

    def get(self, path: Any, source: str = "request") -> WorkspaceContext:
        """The context for ``path`` (validated), registering it with ``source``."""
        return self._ensure(validate_workspace(path), {source})

    def peek(self, path: Any) -> Optional[WorkspaceContext]:
        try:
            key = str(Path(str(path)).expanduser().resolve())
        except OSError:
            return None
        with self._lock:
            return self._contexts.get(key)

    def active(self) -> WorkspaceContext:
        path = get_active_workspace()
        with self._lock:
            for ctx in self._contexts.values():
                if ctx.path != path:
                    ctx.sources.discard("active")
            return self._ensure(path, {"active"})

    def set_active(self, path: Any) -> WorkspaceContext:
        target = validate_workspace(path)
        with self._lock:
            for ctx in self._contexts.values():
                if ctx.path != target:
                    ctx.sources.discard("active")
            return self._ensure(target, {"active"})

    def list(self) -> List[WorkspaceContext]:
        with self._lock:
            return sorted(self._contexts.values(), key=lambda c: str(c.path))

    def entries(self) -> List[Dict[str, Any]]:
        active = get_active_workspace()
        return [c.entry(c.path == active) for c in self.list()]

    def open(self, path: Any) -> WorkspaceContext:
        return self.get(path, "request")

    def close(self, path: Any) -> bool:
        target = validate_workspace(path)
        if target == get_active_workspace():
            raise WorkspaceError("cannot close the active workspace")
        with self._lock:
            return self._contexts.pop(str(target), None) is not None

    def evict_idle(self, now: Optional[float] = None) -> int:
        now = self._clock() if now is None else now
        with self._lock:
            victims = [
                key for key, c in self._contexts.items()
                if not (c.sources & PROTECTED_SOURCES) and now - c.last_used >= self._idle_s
            ]
            for key in victims:
                self._contexts.pop(key, None)
            self._cap_locked()
            return len(victims)

    # ------------------------------------------------------------------ Lee sync

    def _lee_base(self) -> str:
        if self._lee_url:
            return self._lee_url.rstrip("/")
        from ..copilot import lee_events
        return lee_events.get_client().lee_url

    async def _default_fetch_windows(self) -> Optional[List[Dict[str, Any]]]:
        try:
            async with httpx.AsyncClient(timeout=SYNC_TIMEOUT_S) as client:
                resp = await client.get(f"{self._lee_base()}/windows", headers=auth_headers())
        except Exception as e:
            logger.debug(f"Lee /windows unreachable: {e}")
            return None
        if resp.status_code != 200:
            return None
        try:
            data = resp.json()
        except ValueError:
            return None
        rows = data.get("data") if isinstance(data, dict) else data
        return rows if isinstance(rows, list) else None

    async def sync_from_lee(self) -> None:
        """Register every open window's workspace; Lee unreachable keeps the current set."""
        rows = await self._fetch_windows()
        if rows is None:
            return
        open_paths: Set[Path] = set()
        for row in rows:
            raw = row.get("workspace") if isinstance(row, dict) else None
            try:
                open_paths.add(validate_workspace(raw))
            except WorkspaceError:
                continue
        with self._lock:
            for ctx in self._contexts.values():
                if ctx.path not in open_paths:
                    ctx.sources.discard("window")
            for path in open_paths:
                ctx = self._contexts.get(str(path))
                if ctx is None:
                    self._ensure(path, {"window"})
                else:
                    ctx.sources.add("window")
        self.evict_idle()


async def run_sync_loop(registry: WorkspaceRegistry, interval: float = SYNC_INTERVAL_S) -> None:
    while True:
        try:
            await registry.sync_from_lee()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"Workspace sync failed: {e}")
        await asyncio.sleep(interval)


_registry: Optional[WorkspaceRegistry] = None
_registry_lock = threading.Lock()


def get_registry() -> WorkspaceRegistry:
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = WorkspaceRegistry()
        return _registry


def init_registry(boot: Optional[Path] = None, lee_url: Optional[str] = None) -> WorkspaceRegistry:
    global _registry
    with _registry_lock:
        _registry = WorkspaceRegistry(boot=boot, lee_url=lee_url)
        return _registry


def reset_registry() -> None:
    global _registry
    with _registry_lock:
        _registry = None
