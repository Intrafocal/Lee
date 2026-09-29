"""
Voice routes on the Hester daemon (:9000), in the copilot envelope.

``GET /voice`` -> ``VoiceCapabilities``. ``POST /voice/transcribe?purpose=reply|capture|ask|send
&item_id=&workspace=`` with ``Content-Type: audio/wav`` and the WAV as the raw
body -> ``TranscribeResult``. Errors are ``{success: false, error: <code>}``:
503 ``voice_disabled`` / ``voice_unavailable`` (with ``reason``), 415
``unsupported_media_type``, 413 ``too_large`` (Content-Length, checked before
reading) or ``too_long``, 422 ``too_short``, 502 ``provider_error``, 504
``timeout``. Every attempt past the purpose check is a ``voice.transcribe``
event with sizes and timings only, never the audio, the hint or the text.
"""

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..copilot import lee_events
from ..copilot.routes import BadRequest, caller_actor, resolve_workspace
from . import hints as hints_mod
from .audio import CHANNELS, SAMPLE_RATE, AudioError, max_bytes, parse_wav, validate
from .config import VoiceConfig, load_voice_config
from .providers import ProviderError, STTProvider, get_provider

logger = logging.getLogger("hester.daemon.voice.routes")

PURPOSES = ("reply", "capture", "ask", "send")
WAV_TYPES = ("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave")


def _ok(data: Any) -> JSONResponse:
    return JSONResponse(status_code=200, content={"success": True, "data": data})


def _fail(code: str, status: int, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "error": code, **extra})


def capabilities(config: VoiceConfig, provider: STTProvider) -> Dict[str, Any]:
    """``VoiceCapabilities`` (shared/voice.ts): the mic shows only when ``available``."""
    reason = "disabled" if not config.enabled else provider.availability()
    out: Dict[str, Any] = {
        "enabled": config.enabled,
        "available": config.enabled and reason is None,
        "provider": provider.name,
        "model": provider.model,
        "location": provider.location,
        "accepts": ["audio/wav"],
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "max_seconds": config.max_seconds,
        "max_bytes": max_bytes(config.max_seconds),
    }
    if reason:
        out["reason"] = reason
    return out


def create_voice_router(context_provider: Optional[Callable[[], Any]] = None, fetch_item=None) -> APIRouter:
    """``context_provider`` returns Lee's live context (``app_state.lee_client.context``) for the hint."""
    router = APIRouter(tags=["voice"])
    fetch = fetch_item or hints_mod.fetch_attention_item

    def _setup(workspace: Optional[str]):
        ws = resolve_workspace(workspace)
        config = load_voice_config(ws)
        return ws, config, get_provider(config, ws)

    @router.get("/voice")
    async def voice_capabilities(workspace: Optional[str] = None):
        try:
            _, config, provider = await asyncio.to_thread(_setup, workspace)
        except BadRequest as e:
            return _fail(str(e), e.status)
        return _ok(await asyncio.to_thread(capabilities, config, provider))

    @router.post("/voice/transcribe")
    async def voice_transcribe(
        request: Request,
        purpose: str = "",
        item_id: Optional[str] = None,
        workspace: Optional[str] = None,
    ):
        if purpose not in PURPOSES:
            return _fail(f"purpose must be one of {', '.join(PURPOSES)}", 400)
        try:
            ws, config, provider = await asyncio.to_thread(_setup, workspace)
        except BadRequest as e:
            return _fail(str(e), e.status)

        started = time.monotonic()
        event: Dict[str, Any] = {
            "purpose": purpose, "provider": provider.name, "model": provider.model, "location": provider.location,
            "audio_ms": 0, "bytes": 0, "ok": False, "text_chars": 0, "latency_ms": 0,
        }

        def done(response: JSONResponse, error: Optional[str] = None) -> JSONResponse:
            event["latency_ms"] = int((time.monotonic() - started) * 1000)
            if error:
                event["error"] = error
            try:
                lee_events.ingest("voice.transcribe", event, workspace=str(ws), actor=caller_actor(request))
            except Exception:
                pass
            return response

        if not config.enabled:
            return done(_fail("voice_disabled", 503), "voice_disabled")
        reason = await asyncio.to_thread(provider.availability)
        if reason:
            return done(_fail("voice_unavailable", 503, reason=reason), "voice_unavailable")
        content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type not in WAV_TYPES:
            return done(_fail("unsupported_media_type", 415), "unsupported_media_type")
        limit = max_bytes(config.max_seconds)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > limit:
            return done(_fail("too_large", 413), "too_large")
        body = await request.body()
        event["bytes"] = len(body)
        if len(body) > limit:
            return done(_fail("too_large", 413), "too_large")
        try:
            info = parse_wav(body)
            event["audio_ms"] = info.duration_ms
            validate(info, config.max_seconds)
        except AudioError as e:
            return done(_fail(e.code, e.status), e.code)

        lee_context = None
        if context_provider is not None:
            try:
                lee_context = context_provider()
            except Exception:
                lee_context = None
        hint = await hints_mod.hint_for(purpose, item_id, Path(ws), lee_context, fetch_item=fetch)

        try:
            text = await asyncio.wait_for(provider.transcribe(body, info, hint), timeout=config.timeout_s)
        except asyncio.TimeoutError:
            return done(_fail("timeout", 504), "timeout")
        except ProviderError as e:
            logger.warning(f"Voice transcription failed ({provider.name}): {e}")  # the error's type, never content
            return done(_fail("provider_error", 502), "provider_error")
        text = " ".join((text or "").split())
        event.update(ok=True, text_chars=len(text))
        response = _ok({
            "text": text, "provider": provider.name, "model": provider.model, "location": provider.location,
            "audio_ms": info.duration_ms, "latency_ms": int((time.monotonic() - started) * 1000),
        })
        return done(response)

    return router
