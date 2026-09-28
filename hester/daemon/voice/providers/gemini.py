"""
Gemini: the audio as an inline ``audio/wav`` part, a "transcribe verbatim, do
not answer" instruction with the preferred spellings, a ``{text}`` JSON schema
and temperature 0 (the config pattern of ``workstream/gemini.py``). The
daemon's class-level wrap (``copilot/model_log.py``) logs the call as a
``model.call`` with the request's trigger (``user``).
"""

import json
from typing import Any, Callable, List, Optional

from ..audio import WavInfo
from .base import ProviderError, STTProvider, instruction

SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}


def _default_client(api_key: Optional[str]):
    from google import genai

    return genai.Client(api_key=api_key) if api_key else genai.Client()


class GeminiSTT(STTProvider):
    name = "gemini"
    location = "cloud"

    def __init__(self, model: str, api_key: Callable[[], Optional[str]], client_factory=_default_client):
        self._model = model
        self._api_key = api_key
        self._client_factory = client_factory

    @property
    def model(self) -> str:
        return self._model

    def availability(self) -> Optional[str]:
        return None if self._api_key() else "no_api_key"

    def _config(self) -> Any:
        from google.genai import types

        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SCHEMA,
            temperature=0,
        )
        if "gemini-3" in self._model:
            config.thinking_config = types.ThinkingConfig(thinking_level="low")
        return config

    def _audio_part(self, wav: bytes) -> Any:
        from google.genai import types

        return types.Part.from_bytes(data=wav, mime_type="audio/wav")

    async def transcribe(self, wav: bytes, info: WavInfo, hint: List[str]) -> str:
        client = self._client_factory(self._api_key())
        try:
            response = await client.aio.models.generate_content(
                model=self._model,
                contents=[instruction(hint), self._audio_part(wav)],
                config=self._config(),
            )
        except Exception as e:
            raise ProviderError(type(e).__name__)
        raw = getattr(response, "text", None)
        try:
            data = json.loads(raw) if isinstance(raw, str) else None
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get("text"), str):
            raise ProviderError("no transcript in the response")
        return data["text"]
