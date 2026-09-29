"""
``hester.voice`` from the merged Lee config (``load_merged_config``), cached by
the config files' mtimes, with ``HESTER_VOICE_*`` environment overrides::

    hester:
      voice:
        enabled: false          # off unless true
        provider: gemini        # or whisper (pip install 'lee-tools[voice-local]', then hester voice setup)
        gemini_model: gemini-3-flash-preview
        whisper_model: base.en
        max_seconds: 60
        timeout_s: 30
"""

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from ...shared.config import config_paths, load_merged_config

PROVIDERS = ("gemini", "whisper")
DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview"
DEFAULT_WHISPER_MODEL = "base.en"
DEFAULT_MAX_SECONDS = 60
DEFAULT_TIMEOUT_S = 30.0
MAX_SECONDS_CAP = 120
ENV_PREFIX = "HESTER_VOICE_"


@dataclass(frozen=True)
class VoiceConfig:
    enabled: bool = False
    provider: str = "gemini"
    gemini_model: str = DEFAULT_GEMINI_MODEL
    whisper_model: str = DEFAULT_WHISPER_MODEL
    max_seconds: int = DEFAULT_MAX_SECONDS
    timeout_s: float = DEFAULT_TIMEOUT_S


def _bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
        if v in ("0", "false", "no", "off", ""):
            return False
    return default


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _str(value: Any, default: str) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else default


def parse(section: Any, env: Optional[Dict[str, str]] = None) -> VoiceConfig:
    """A ``VoiceConfig`` from the ``hester.voice`` mapping and the environment (env wins)."""
    raw: Dict[str, Any] = dict(section) if isinstance(section, dict) else {}
    env = os.environ if env is None else env
    for key in ("enabled", "provider", "gemini_model", "whisper_model", "max_seconds", "timeout_s"):
        value = env.get(ENV_PREFIX + key.upper())
        if value is not None:
            raw[key] = value
    provider = _str(raw.get("provider"), "gemini").lower()
    return VoiceConfig(
        enabled=_bool(raw.get("enabled"), False),
        provider=provider if provider in PROVIDERS else "gemini",
        gemini_model=_str(raw.get("gemini_model"), DEFAULT_GEMINI_MODEL),
        whisper_model=_str(raw.get("whisper_model"), DEFAULT_WHISPER_MODEL),
        max_seconds=int(_num(raw.get("max_seconds"), DEFAULT_MAX_SECONDS, 1, MAX_SECONDS_CAP)),
        timeout_s=_num(raw.get("timeout_s"), DEFAULT_TIMEOUT_S, 0.1, 300),
    )


_cache: Dict[str, Tuple[Tuple[Any, ...], Dict[str, Any]]] = {}
_cache_lock = threading.Lock()


def _stamp(workspace: Optional[Path]) -> Tuple[Any, ...]:
    out = []
    for p in config_paths(workspace):
        try:
            out.append((str(p), p.stat().st_mtime_ns))
        except OSError:
            out.append((str(p), None))
    return tuple(out)


def _merged(workspace: Optional[Path]) -> Dict[str, Any]:
    key = str(workspace or "")
    stamp = _stamp(workspace)
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] == stamp:
            return hit[1]
    merged = load_merged_config(workspace)
    with _cache_lock:
        _cache[key] = (stamp, merged)
    return merged


def load_voice_config(workspace: Optional[Path] = None) -> VoiceConfig:
    merged = _merged(Path(workspace) if workspace else None)
    hester = merged.get("hester") if isinstance(merged.get("hester"), dict) else {}
    return parse(hester.get("voice"))


def google_api_key(workspace: Optional[Path] = None) -> Optional[str]:
    """The Gemini key: ``GOOGLE_API_KEY`` / ``GEMINI_API_KEY``, else ``hester.google_api_key`` in config."""
    for name in ("GOOGLE_API_KEY", "GEMINI_API_KEY"):
        if os.environ.get(name):
            return os.environ[name]
    merged = _merged(Path(workspace) if workspace else None)
    hester = merged.get("hester") if isinstance(merged.get("hester"), dict) else {}
    key = hester.get("google_api_key")
    return key if isinstance(key, str) and key.strip() else None


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
