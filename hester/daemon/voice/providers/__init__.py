"""Speech-to-text providers: Gemini (the default) and local Whisper (an optional extra)."""

import threading
from pathlib import Path
from typing import Dict, Optional, Tuple

from ..config import VoiceConfig, google_api_key
from .base import REASONS, ProviderError, STTProvider
from .gemini import GeminiSTT
from .whisper import WhisperSTT

__all__ = ["REASONS", "ProviderError", "STTProvider", "GeminiSTT", "WhisperSTT", "get_provider", "set_provider"]

_providers: Dict[Tuple[str, str], STTProvider] = {}
_lock = threading.Lock()


def get_provider(config: VoiceConfig, workspace: Optional[Path] = None) -> STTProvider:
    """The provider the config names, one instance per (provider, model) so a loaded Whisper stays loaded."""
    model = config.whisper_model if config.provider == "whisper" else config.gemini_model
    key = (config.provider, model)
    with _lock:
        found = _providers.get(key)
        if found is None:
            if config.provider == "whisper":
                found = WhisperSTT(model)
            else:
                found = GeminiSTT(model, api_key=lambda: google_api_key(workspace))  # the first workspace's config; env wins
            _providers[key] = found
        return found


def set_provider(config: VoiceConfig, provider: Optional[STTProvider]) -> None:
    """Tests: put a fake in (or take it out with None)."""
    model = config.whisper_model if config.provider == "whisper" else config.gemini_model
    with _lock:
        if provider is None:
            _providers.pop((config.provider, model), None)
        else:
            _providers[(config.provider, model)] = provider
