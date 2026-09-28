"""
The wire format, checked with stdlib ``wave``: 16 kHz, mono, 16-bit PCM WAV.

At 32 KB/s a 60 s clip is about 1.9 MB. ``max_bytes`` is what the route checks
against Content-Length before reading the body.
"""

import io
import wave
from array import array
from dataclasses import dataclass
from typing import Any

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes: 16-bit
MIN_MS = 300
HEADER_SLACK = 4096  # the RIFF header and any extra chunks (LIST, fact) a recorder adds
LENGTH_SLACK_MS = 500  # a client's max auto-stop lands a little past the cap


class AudioError(ValueError):
    """``code`` is the wire error (VoiceErrorCode); ``status`` its HTTP status."""

    def __init__(self, code: str, status: int, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    channels: int
    sample_width: int
    frames: int
    pcm: bytes

    @property
    def duration_ms(self) -> int:
        return int(self.frames * 1000 / self.sample_rate) if self.sample_rate else 0


def max_bytes(max_seconds: int) -> int:
    return HEADER_SLACK + max_seconds * SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH


def parse_wav(data: bytes) -> WavInfo:
    """The WAV's format and PCM frames; 415 ``unsupported_media_type`` when it isn't a readable PCM WAV."""
    if not data or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise AudioError("unsupported_media_type", 415, "not a WAV file")
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            info = WavInfo(
                sample_rate=w.getframerate(), channels=w.getnchannels(), sample_width=w.getsampwidth(),
                frames=w.getnframes(), pcm=w.readframes(w.getnframes()),
            )
    except (wave.Error, EOFError) as e:
        raise AudioError("unsupported_media_type", 415, f"unreadable WAV: {e}")
    # A streamed WAV may claim more frames than it carries; count what's there.
    frame_bytes = info.channels * info.sample_width
    if frame_bytes and len(info.pcm) // frame_bytes != info.frames:
        info = WavInfo(info.sample_rate, info.channels, info.sample_width, len(info.pcm) // frame_bytes, info.pcm)
    return info


def validate(info: WavInfo, max_seconds: int) -> None:
    """16 kHz mono 16-bit (415), at least 300 ms (422 ``too_short``), at most ``max_seconds`` (413 ``too_long``)."""
    if (info.sample_rate, info.channels, info.sample_width) != (SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH):
        raise AudioError(
            "unsupported_media_type", 415,
            f"need 16 kHz mono 16-bit PCM, got {info.sample_rate} Hz, {info.channels} ch, {info.sample_width * 8}-bit",
        )
    if info.duration_ms < MIN_MS:
        raise AudioError("too_short", 422, f"shorter than {MIN_MS} ms")
    if info.duration_ms > max_seconds * 1000 + LENGTH_SLACK_MS:
        raise AudioError("too_long", 413, f"longer than {max_seconds} s")


def pcm16_to_float32(pcm: bytes) -> Any:
    """Little-endian PCM16 as float32 in [-1, 1): a numpy array when numpy is there (whisper), else ``array('f')``."""
    try:
        import numpy as np

        return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    except ImportError:  # pragma: no cover - numpy is a dependency
        samples = array("h")
        samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
        return array("f", (s / 32768.0 for s in samples))
