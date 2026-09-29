"""
Whisper, locally: ``faster-whisper`` (the ``voice-local`` extra; arm64 wheels,
no ffmpeg since the WAV is decoded here). The model loads lazily with
``local_files_only`` (``hester voice setup`` is the only download), int8 on the
CPU, runs in a thread behind a lock, and is unloaded after 10 minutes idle.
Each call is logged as ``model.call`` (provider ``other``, location ``local``).
"""

import asyncio
import importlib.util
import time
from typing import Any, Callable, List, Optional

from ...copilot.model_log import record_model_call
from ..audio import WavInfo, pcm16_to_float32
from .base import ProviderError, STTProvider

IDLE_UNLOAD_S = 600


def installed() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def _model_path(name: str, local_only: bool = True) -> str:
    from faster_whisper.utils import download_model

    return download_model(name, local_files_only=local_only)


def _load(name: str) -> Any:
    from faster_whisper import WhisperModel

    return WhisperModel(_model_path(name), device="cpu", compute_type="int8", local_files_only=True)


def download(name: str) -> str:
    """``hester voice setup``: fetch the model into the Hugging Face cache (the one network fetch)."""
    return _model_path(name, local_only=False)


class WhisperSTT(STTProvider):
    name = "whisper"
    location = "local"

    def __init__(
        self,
        model: str,
        is_installed: Callable[[], bool] = installed,
        model_present: Optional[Callable[[str], bool]] = None,
        loader: Callable[[str], Any] = _load,
        idle_unload_s: float = IDLE_UNLOAD_S,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._model_name = model
        self._is_installed = is_installed
        self._model_present = model_present or self._present
        self._loader = loader
        self._idle_unload_s = idle_unload_s
        self._clock = clock
        self._model: Any = None
        self._last_used = 0.0
        self._lock: Optional[asyncio.Lock] = None
        self._unload_handle: Optional[asyncio.TimerHandle] = None

    @property
    def model(self) -> str:
        return self._model_name

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @staticmethod
    def _present(name: str) -> bool:
        try:
            _model_path(name)
            return True
        except Exception:
            return False

    def availability(self) -> Optional[str]:
        if not self._is_installed():
            return "whisper_not_installed"
        if self._model is None and not self._model_present(self._model_name):
            return "whisper_model_missing"
        return None

    def _run(self, info: WavInfo, hint: List[str]) -> str:
        if self._model is None:
            self._model = self._loader(self._model_name)
        segments, _ = self._model.transcribe(
            pcm16_to_float32(info.pcm),
            language="en" if self._model_name.endswith(".en") else None,
            initial_prompt=", ".join(hint) or None,
            vad_filter=True,
            beam_size=5,
        )
        return " ".join(s.text.strip() for s in segments if getattr(s, "text", "").strip())

    def maybe_unload(self) -> bool:
        """Drop the model after ``idle_unload_s`` without a call (200–500 MB while loaded)."""
        if self._model is not None and self._clock() - self._last_used >= self._idle_unload_s:
            if self._lock is None or not self._lock.locked():
                self._model = None
                return True
        return False

    def _schedule_unload(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._unload_handle is not None:
            self._unload_handle.cancel()
        self._unload_handle = loop.call_later(self._idle_unload_s, self.maybe_unload)

    async def transcribe(self, wav: bytes, info: WavInfo, hint: List[str]) -> str:
        if self._lock is None:
            self._lock = asyncio.Lock()
        started = time.monotonic()
        ok = False
        try:
            async with self._lock:
                text = await asyncio.to_thread(self._run, info, hint)
            ok = True
            return text
        except Exception as e:
            raise ProviderError(type(e).__name__)
        finally:
            self._last_used = self._clock()
            self._schedule_unload()
            record_model_call(
                provider="other", model=f"whisper-{self._model_name}", op="transcribe", location="local",
                ok=ok, duration_ms=(time.monotonic() - started) * 1000, cost_basis="local",
            )
