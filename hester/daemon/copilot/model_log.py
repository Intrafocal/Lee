"""
Model-call logging with trigger (C1/C2 telemetry).

Every model call made in the daemon process is recorded as a ``model.call``
event in Lee's log, tagged with what caused it:

- ``user``: inside an authenticated HTTP request (set by the daemon's auth
  middleware; tasks spawned from the request inherit it through contextvars)
- ``automatic``: a background loop that set it explicitly
- ``unknown``: anything else; the C1/C2 formulas count it as automatic

Gemini calls are caught once, at class level, by wrapping
``google.genai.models.Models`` / ``AsyncModels``. Ollama calls are recorded
explicitly at their call sites in ``daemon/prepare.py``.
"""

import contextvars
import functools
import inspect
import logging
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional

from ...shared.workspace import get_current_workspace
from . import lee_events

logger = logging.getLogger("hester.daemon.copilot.model_log")

current_trigger: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "hester_model_trigger", default=None
)

TRIGGER_KINDS = ("user", "automatic", "unknown")
_WRAPPED_ATTR = "__hester_model_logged__"


def set_trigger(kind: str, **fields: Any) -> contextvars.Token:
    """Set the trigger for model calls made from the current context."""
    if kind not in TRIGGER_KINDS:
        kind = "unknown"
    trigger: Dict[str, Any] = {"kind": kind}
    for key in ("name", "surface", "request_path"):
        value = fields.get(key)
        if value:
            trigger[key] = str(value)
    return current_trigger.set(trigger)


def reset_trigger(token: contextvars.Token) -> None:
    try:
        current_trigger.reset(token)
    except ValueError:
        current_trigger.set(None)


@contextmanager
def trigger(kind: str, **fields: Any) -> Iterator[None]:
    token = set_trigger(kind, **fields)
    try:
        yield
    finally:
        reset_trigger(token)


def get_trigger() -> Dict[str, Any]:
    value = current_trigger.get()
    return dict(value) if value else {"kind": "unknown"}


def _workspace() -> Optional[str]:
    try:
        return str(get_current_workspace())
    except Exception:
        return None


def record_model_call(
    *,
    provider: str,
    model: str,
    op: str,
    location: str,
    ok: bool,
    duration_ms: Optional[float] = None,
    trigger: Optional[Dict[str, Any]] = None,
) -> None:
    """Queue one ``model.call`` event. Never raises."""
    try:
        data: Dict[str, Any] = {
            "provider": provider if provider in ("gemini", "ollama") else "other",
            "model": str(model or ""),
            "op": op,
            "location": location,
            "trigger": dict(trigger) if trigger else get_trigger(),
            "ok": bool(ok),
        }
        if duration_ms is not None:
            data["duration_ms"] = round(float(duration_ms), 1)
        lee_events.ingest("model.call", data, workspace=_workspace(), actor={"kind": "hester"})
    except Exception as e:
        logger.debug(f"record_model_call failed: {e}")


def _elapsed_ms(start: float) -> float:
    return (time.monotonic() - start) * 1000.0


def _wrap_sync(fn, op: str):
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        trig = get_trigger()
        start = time.monotonic()
        ok = False
        try:
            result = fn(self, *args, **kwargs)
            ok = True
            return result
        finally:
            record_model_call(
                provider="gemini", model=kwargs.get("model", ""), op=op, location="cloud",
                ok=ok, duration_ms=_elapsed_ms(start), trigger=trig,
            )

    setattr(wrapper, _WRAPPED_ATTR, True)
    return wrapper


def _wrap_sync_stream(fn):
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        trig = get_trigger()
        start = time.monotonic()

        def iterate():
            ok = False
            try:
                for chunk in fn(self, *args, **kwargs):
                    yield chunk
                ok = True
            finally:
                record_model_call(
                    provider="gemini", model=kwargs.get("model", ""), op="stream", location="cloud",
                    ok=ok, duration_ms=_elapsed_ms(start), trigger=trig,
                )

        return iterate()

    setattr(wrapper, _WRAPPED_ATTR, True)
    return wrapper


def _wrap_async(fn, op: str):
    @functools.wraps(fn)
    async def wrapper(self, *args, **kwargs):
        trig = get_trigger()
        start = time.monotonic()
        ok = False
        try:
            result = await fn(self, *args, **kwargs)
            ok = True
            return result
        finally:
            record_model_call(
                provider="gemini", model=kwargs.get("model", ""), op=op, location="cloud",
                ok=ok, duration_ms=_elapsed_ms(start), trigger=trig,
            )

    setattr(wrapper, _WRAPPED_ATTR, True)
    return wrapper


def _wrap_async_stream(fn):
    @functools.wraps(fn)
    async def wrapper(self, *args, **kwargs):
        trig = get_trigger()
        start = time.monotonic()
        model = kwargs.get("model", "")
        try:
            stream = await fn(self, *args, **kwargs)
        except BaseException:
            record_model_call(
                provider="gemini", model=model, op="stream", location="cloud",
                ok=False, duration_ms=_elapsed_ms(start), trigger=trig,
            )
            raise

        async def iterate():
            ok = False
            try:
                async for chunk in stream:
                    yield chunk
                ok = True
            finally:
                record_model_call(
                    provider="gemini", model=model, op="stream", location="cloud",
                    ok=ok, duration_ms=_elapsed_ms(start), trigger=trig,
                )

        return iterate()

    setattr(wrapper, _WRAPPED_ATTR, True)
    return wrapper


def _patch(cls, name: str, wrap) -> bool:
    fn = cls.__dict__.get(name)
    if fn is None or getattr(fn, _WRAPPED_ATTR, False):
        return False
    setattr(cls, name, wrap(fn))
    return True


def install_model_call_logging() -> bool:
    """Wrap google.genai's Models/AsyncModels once. Returns True if anything was patched."""
    try:
        from google.genai import models as genai_models
    except Exception as e:
        logger.info(f"google.genai not importable; Gemini calls won't be logged ({e})")
        return False

    patched = False
    sync_cls = genai_models.Models
    async_cls = genai_models.AsyncModels
    patched |= _patch(sync_cls, "generate_content", lambda f: _wrap_sync(f, "generate"))
    patched |= _patch(sync_cls, "embed_content", lambda f: _wrap_sync(f, "embed"))
    stream = sync_cls.__dict__.get("generate_content_stream")
    if stream is not None and inspect.isgeneratorfunction(stream):
        patched |= _patch(sync_cls, "generate_content_stream", _wrap_sync_stream)
    elif stream is not None:
        patched |= _patch(sync_cls, "generate_content_stream", lambda f: _wrap_sync(f, "stream"))
    patched |= _patch(async_cls, "generate_content", lambda f: _wrap_async(f, "generate"))
    patched |= _patch(async_cls, "embed_content", lambda f: _wrap_async(f, "embed"))
    patched |= _patch(async_cls, "generate_content_stream", _wrap_async_stream)
    if patched:
        logger.info("Model-call logging installed (google.genai Models/AsyncModels)")
    return patched
