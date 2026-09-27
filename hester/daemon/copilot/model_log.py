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
explicitly at their call sites in ``daemon/prepare.py``, Claude delegates in
``tasks/claude_delegate.py``.

Usage (docs/15-Usage.md §3.4): each event carries a ``usage`` object when the
response reports tokens (Gemini ``usage_metadata``, the last streamed chunk's
for streams; Ollama's eval counts; a delegate's ``ResultMessage``). This
wrapper is the single source of usage events for Hester.
"""

import contextvars
import functools
import inspect
import logging
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, List, Optional

from ...shared.workspace import get_current_workspace
from . import lee_events

logger = logging.getLogger("hester.daemon.copilot.model_log")

current_trigger: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "hester_model_trigger", default=None
)

# Deep D1: a runner can collect the calls made inside a block (collect_calls),
# e.g. deep-ask recording which model answered.
call_sink: contextvars.ContextVar[Optional[List[Dict[str, Any]]]] = contextvars.ContextVar(
    "hester_model_call_sink", default=None
)

TRIGGER_KINDS = ("user", "automatic", "unknown")
PROVIDERS = ("gemini", "ollama", "anthropic")
# model.call's provider -> the §4.1 usage object's provider
USAGE_PROVIDER = {"gemini": "google", "ollama": "ollama", "anthropic": "anthropic"}
COST_BASES = ("billed", "subscription", "estimate", "local")
TOKEN_KEYS = ("input", "output", "cache_read", "cache_write", "thinking")
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


@contextmanager
def surface_override(surface: Optional[str]) -> Iterator[None]:
    """Within this block, model calls carry ``surface`` (the request's own surface beats X-Lee-Trigger)."""
    if not surface:
        yield
        return
    current = current_trigger.get()
    trigger_ = dict(current) if current else {"kind": "unknown"}
    trigger_["surface"] = str(surface)
    token = current_trigger.set(trigger_)
    try:
        yield
    finally:
        reset_trigger(token)


@contextmanager
def collect_calls() -> Iterator[List[Dict[str, Any]]]:
    """Within this block, each model call also appends ``{location, name, ok}`` to the yielded list."""
    calls: List[Dict[str, Any]] = []
    token = call_sink.set(calls)
    try:
        yield calls
    finally:
        try:
            call_sink.reset(token)
        except ValueError:
            call_sink.set(None)


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
    tokens: Optional[Dict[str, Any]] = None,
    cost_usd: Optional[float] = None,
    cost_basis: Optional[str] = None,
    compute_ms: Optional[float] = None,
) -> None:
    """
    Queue one ``model.call`` event. Never raises.

    With ``tokens`` (and/or ``cost_usd``) the event carries a ``usage`` object
    (docs/15-Usage.md §4.1). ``cost_basis`` defaults by provider: ``local``
    for Ollama (never a cost), ``estimate`` otherwise, priced from the price
    table when no ``cost_usd`` is given (unknown models: tokens, no cost).
    ``compute_ms`` (e.g. Ollama's ``total_duration``) is the usage's
    ``duration_ms``; the wall-clock ``duration_ms`` stands in without it.
    """
    try:
        data: Dict[str, Any] = {
            "provider": provider if provider in PROVIDERS else "other",
            "model": str(model or ""),
            "op": op,
            "location": location,
            "trigger": dict(trigger) if trigger else get_trigger(),
            "ok": bool(ok),
        }
        if duration_ms is not None:
            data["duration_ms"] = round(float(duration_ms), 1)
        usage = build_usage(
            data["provider"], data["model"], tokens=tokens, cost_usd=cost_usd,
            cost_basis=cost_basis, duration_ms=compute_ms if compute_ms is not None else duration_ms,
        )
        if usage is not None:
            data["usage"] = usage
        sink = call_sink.get()
        if sink is not None:
            sink.append({"location": location, "name": str(model or ""), "ok": bool(ok)})
        lee_events.ingest("model.call", data, workspace=_workspace(), actor={"kind": "hester"})
    except Exception as e:
        logger.debug(f"record_model_call failed: {e}")


def clean_tokens(tokens: Any) -> Optional[Dict[str, int]]:
    """Keep the §4.1 token keys with non-negative whole values; None when nothing is left."""
    if not isinstance(tokens, dict):
        return None
    out: Dict[str, int] = {}
    for key in TOKEN_KEYS:
        v = tokens.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            out[key] = int(v)
    return out or None


def build_usage(
    provider: str,
    model: str,
    *,
    tokens: Optional[Dict[str, Any]] = None,
    cost_usd: Optional[float] = None,
    cost_basis: Optional[str] = None,
    duration_ms: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """The §4.1 ``usage`` object, or None when there are neither tokens nor a cost."""
    toks = clean_tokens(tokens)
    cost = float(cost_usd) if isinstance(cost_usd, (int, float)) and not isinstance(cost_usd, bool) else None
    if toks is None and cost is None:
        return None
    basis = cost_basis if cost_basis in COST_BASES else ("local" if provider == "ollama" else "estimate")
    usage: Dict[str, Any] = {"provider": USAGE_PROVIDER.get(provider, "other"), "model": str(model or "")}
    if toks is not None:
        usage["tokens"] = toks
    if basis == "local":
        cost = None
    elif cost is None and basis == "estimate" and toks is not None:
        from .prices import cost_usd as price_cost

        cost = price_cost(model, toks)
    if cost is not None:
        usage["cost_usd"] = round(cost, 6)
    usage["cost_basis"] = basis
    if duration_ms is not None:
        usage["duration_ms"] = round(float(duration_ms), 1)
    return usage


def _num(obj: Any, name: str) -> int:
    v = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 0


def gemini_tokens(usage_metadata: Any) -> Optional[Dict[str, int]]:
    """
    §4.1 tokens from Gemini's ``usage_metadata``. The prompt count includes
    cached tokens, so ``input`` is the uncached part; thoughts are billed as
    output, so ``output`` = candidates + thoughts with ``thinking`` the subset.
    """
    if usage_metadata is None:
        return None
    prompt = _num(usage_metadata, "prompt_token_count") + _num(usage_metadata, "tool_use_prompt_token_count")
    cached = _num(usage_metadata, "cached_content_token_count")
    candidates = _num(usage_metadata, "candidates_token_count")
    thoughts = _num(usage_metadata, "thoughts_token_count")
    if not (prompt or cached or candidates or thoughts):
        return None
    tokens: Dict[str, int] = {"input": max(prompt - cached, 0), "output": candidates + thoughts}
    if cached:
        tokens["cache_read"] = cached
    if thoughts:
        tokens["thinking"] = thoughts
    return tokens


def response_tokens(result: Any) -> Optional[Dict[str, int]]:
    """Tokens from a generate/stream chunk, or an embed response (per-embedding statistics)."""
    try:
        meta = result.get("usage_metadata") if isinstance(result, dict) else getattr(result, "usage_metadata", None)
        tokens = gemini_tokens(meta)
        if tokens is not None:
            return tokens
        embeddings = result.get("embeddings") if isinstance(result, dict) else getattr(result, "embeddings", None)
        if isinstance(embeddings, list):
            total = 0
            for emb in embeddings:
                stats = emb.get("statistics") if isinstance(emb, dict) else getattr(emb, "statistics", None)
                total += _num(stats, "token_count") if stats is not None else 0
            if total:
                return {"input": total}
    except Exception as e:
        logger.debug(f"usage extraction failed: {e}")
    return None


def ollama_usage(data: Any) -> Dict[str, Any]:
    """``{tokens, compute_ms}`` from an Ollama response (``prompt_eval_count``, ``eval_count``, ``total_duration`` ns)."""
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}
    tokens = clean_tokens({"input": data.get("prompt_eval_count"), "output": data.get("eval_count")})
    if tokens:
        out["tokens"] = tokens
    total = data.get("total_duration")
    if isinstance(total, (int, float)) and not isinstance(total, bool) and total > 0:
        out["compute_ms"] = float(total) / 1_000_000.0
    return out


def _chunk_usage(chunk: Any) -> Any:
    try:
        return chunk.get("usage_metadata") if isinstance(chunk, dict) else getattr(chunk, "usage_metadata", None)
    except Exception:
        return None


def _elapsed_ms(start: float) -> float:
    return (time.monotonic() - start) * 1000.0


def _wrap_sync(fn, op: str):
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        trig = get_trigger()
        start = time.monotonic()
        ok = False
        tokens = None
        try:
            result = fn(self, *args, **kwargs)
            ok = True
            tokens = response_tokens(result)
            return result
        finally:
            record_model_call(
                provider="gemini", model=kwargs.get("model", ""), op=op, location="cloud",
                ok=ok, duration_ms=_elapsed_ms(start), trigger=trig, tokens=tokens,
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
            last_meta = None
            try:
                for chunk in fn(self, *args, **kwargs):
                    meta = _chunk_usage(chunk)
                    if meta is not None:
                        last_meta = meta
                    yield chunk
                ok = True
            finally:
                record_model_call(
                    provider="gemini", model=kwargs.get("model", ""), op="stream", location="cloud",
                    ok=ok, duration_ms=_elapsed_ms(start), trigger=trig, tokens=gemini_tokens(last_meta),
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
        tokens = None
        try:
            result = await fn(self, *args, **kwargs)
            ok = True
            tokens = response_tokens(result)
            return result
        finally:
            record_model_call(
                provider="gemini", model=kwargs.get("model", ""), op=op, location="cloud",
                ok=ok, duration_ms=_elapsed_ms(start), trigger=trig, tokens=tokens,
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
            last_meta = None
            try:
                async for chunk in stream:
                    meta = _chunk_usage(chunk)
                    if meta is not None:
                        last_meta = meta
                    yield chunk
                ok = True
            finally:
                record_model_call(
                    provider="gemini", model=model, op="stream", location="cloud",
                    ok=ok, duration_ms=_elapsed_ms(start), trigger=trig, tokens=gemini_tokens(last_meta),
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
