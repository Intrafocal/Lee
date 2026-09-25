"""
Delivery of Hester's events into Lee's machine-wide event log.

Events are queued in memory and POSTed to ``{lee_url}/events/ingest`` every
2 s in batches of at most 500, with the shared token. Lee stamps ``ts`` and
``ctx``; Hester's own time goes in ``data.ts_source``. When Lee is down (or
doesn't have the endpoint yet) events stay buffered, up to 2000; the oldest
are dropped beyond that.
"""

import asyncio
import logging
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable, Deque, Dict, List, Optional

import httpx

from ...shared.auth import auth_headers

logger = logging.getLogger("hester.daemon.copilot.lee_events")

DEFAULT_LEE_URL = "http://127.0.0.1:9001"
FLUSH_INTERVAL_S = 2.0
MAX_BATCH = 500
MAX_BUFFER = 2000

INGEST_TYPES = {"model.call", "someday.triage", "digest.shown", "retro.shown", "retro.answered"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LeeEventsClient:
    def __init__(
        self,
        lee_url: str = DEFAULT_LEE_URL,
        headers: Callable[[], Dict[str, str]] = auth_headers,
        interval: float = FLUSH_INTERVAL_S,
        max_buffer: int = MAX_BUFFER,
        max_batch: int = MAX_BATCH,
    ):
        self.lee_url = lee_url.rstrip("/")
        self._headers = headers
        self._interval = interval
        self._max_buffer = max_buffer
        self._max_batch = max_batch
        self._queue: Deque[Dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._task: Optional[asyncio.Task] = None
        self._warned_drop = False
        self._warned_fail = False

    def __len__(self) -> int:
        with self._lock:
            return len(self._queue)

    def enqueue(self, event: Dict[str, Any]) -> None:
        """Queue one event (thread-safe, never raises)."""
        with self._lock:
            self._queue.append(event)
            self._trim_locked()

    def _trim_locked(self) -> None:
        dropped = 0
        while len(self._queue) > self._max_buffer:
            self._queue.popleft()
            dropped += 1
        if dropped and not self._warned_drop:
            self._warned_drop = True
            logger.warning(f"Lee event buffer full; dropping oldest events (cap {self._max_buffer})")

    def _take_batch(self) -> List[Dict[str, Any]]:
        with self._lock:
            batch = []
            while self._queue and len(batch) < self._max_batch:
                batch.append(self._queue.popleft())
            return batch

    def _requeue_front(self, batch: List[Dict[str, Any]]) -> None:
        with self._lock:
            self._queue.extendleft(reversed(batch))
            self._trim_locked()

    async def flush(self, client: Optional[httpx.AsyncClient] = None) -> int:
        """POST everything queued. Returns the number of events Lee accepted."""
        accepted = 0
        while True:
            batch = self._take_batch()
            if not batch:
                return accepted
            try:
                if client is not None:
                    resp = await client.post(
                        f"{self.lee_url}/events/ingest", json={"events": batch}, headers=self._headers()
                    )
                else:
                    async with httpx.AsyncClient(timeout=5.0) as c:
                        resp = await c.post(
                            f"{self.lee_url}/events/ingest", json={"events": batch}, headers=self._headers()
                        )
            except Exception as e:
                self._requeue_front(batch)
                self._warn_fail(f"Lee event ingest unreachable: {e}")
                return accepted
            if resp.status_code != 200:
                self._requeue_front(batch)
                self._warn_fail(f"Lee event ingest returned {resp.status_code}")
                return accepted
            self._warned_fail = False
            try:
                data = resp.json().get("data") or {}
                accepted += int(data.get("accepted", len(batch)))
                for rej in data.get("rejected") or []:
                    logger.debug(f"Lee rejected event {rej}")
            except Exception:
                accepted += len(batch)

    def _warn_fail(self, msg: str) -> None:
        if not self._warned_fail:
            self._warned_fail = True
            logger.warning(msg)
        else:
            logger.debug(msg)

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval)
                if len(self):
                    await self.flush()
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.debug(f"Lee event flush failed: {e}")

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
        if len(self):
            try:
                await asyncio.wait_for(self.flush(), timeout=3.0)
            except Exception:
                pass


_client = LeeEventsClient()


def get_client() -> LeeEventsClient:
    return _client


def configure(lee_url: Optional[str]) -> None:
    if lee_url:
        _client.lee_url = lee_url.rstrip("/")


def ingest(
    type: str,
    data: Dict[str, Any],
    *,
    workspace: Optional[str] = None,
    actor: Optional[Dict[str, Any]] = None,
) -> None:
    """Queue one event for Lee's log. Only the types Lee accepts from Hester."""
    if type not in INGEST_TYPES:
        raise ValueError(f"event type not ingestible: {type}")
    payload = dict(data)
    payload.setdefault("ts_source", utc_now_iso())
    event: Dict[str, Any] = {"type": type, "workspace": workspace, "data": payload}
    event["actor"] = actor or {"kind": "hester"}
    _client.enqueue(event)


def start_delivery(lee_url: Optional[str] = None) -> None:
    configure(lee_url)
    _client.start()


async def stop_delivery() -> None:
    await _client.stop()
