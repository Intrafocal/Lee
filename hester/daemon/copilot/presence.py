"""
Presence client: is the operator at the machine? (C2 gate)

``at_machine()`` asks Lee (``GET {lee_url}/presence``, shared token), caching
the answer for 10 s, and also takes pushes from the ``presence`` messages on
the existing ``/context/stream`` socket. ``None`` means Lee couldn't be asked;
callers treat that as *at the machine* (fail quiet).
"""

import logging
import time
from typing import Any, Callable, Dict, Optional

import httpx

from ...shared.auth import auth_headers

logger = logging.getLogger("hester.daemon.copilot.presence")

DEFAULT_LEE_URL = "http://127.0.0.1:9001"
CACHE_TTL_S = 10.0


class PresenceClient:
    def __init__(
        self,
        lee_url: str = DEFAULT_LEE_URL,
        ttl: float = CACHE_TTL_S,
        headers: Callable[[], Dict[str, str]] = auth_headers,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.lee_url = lee_url.rstrip("/")
        self._ttl = ttl
        self._headers = headers
        self._clock = clock
        self._state: Optional[Dict[str, Any]] = None
        self._fetched_at: Optional[float] = None

    def update(self, state: Optional[Dict[str, Any]]) -> None:
        """Take a PresenceState pushed by Lee (or fetched)."""
        if isinstance(state, dict) and isinstance(state.get("at_machine"), bool):
            self._state = dict(state)
        else:
            self._state = None
        self._fetched_at = self._clock()

    def _fresh(self) -> bool:
        return self._fetched_at is not None and (self._clock() - self._fetched_at) < self._ttl

    async def get(self) -> Optional[Dict[str, Any]]:
        if self._fresh():
            return self._state
        state: Optional[Dict[str, Any]] = None
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self.lee_url}/presence", headers=self._headers())
            if resp.status_code == 200:
                body = resp.json()
                data = body.get("data") if isinstance(body, dict) else None
                if isinstance(data, dict):
                    state = data
        except Exception as e:
            logger.debug(f"Presence fetch failed: {e}")
        self.update(state)
        return self._state

    async def at_machine(self) -> Optional[bool]:
        state = await self.get()
        if state is None:
            return None
        return bool(state.get("at_machine"))


_client = PresenceClient()


def get_client() -> PresenceClient:
    return _client


def configure(lee_url: Optional[str]) -> None:
    if lee_url:
        _client.lee_url = lee_url.rstrip("/")


async def at_machine() -> Optional[bool]:
    return await _client.at_machine()


async def get_presence() -> Optional[Dict[str, Any]]:
    return await _client.get()


def on_presence_message(data: Any) -> None:
    """Handler for ``{"type": "presence", "data": PresenceState}`` on /context/stream."""
    _client.update(data if isinstance(data, dict) else None)
