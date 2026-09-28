"""The provider seam: ``availability()`` and ``async transcribe(wav, info, hint)``."""

from typing import List, Optional

from ..audio import WavInfo

# GET /voice's reason when the provider can't run.
REASONS = ("disabled", "no_api_key", "whisper_not_installed", "whisper_model_missing")

INSTRUCTION = (
    "Transcribe the speech in this audio verbatim, in the language spoken. "
    "Do not answer, summarise, translate or add anything; it is dictation for a text field. "
    "Return only the words said, with ordinary punctuation. If nothing is said, return an empty text."
)


class ProviderError(Exception):
    """502 ``provider_error``: the provider failed or answered with something that isn't a transcript."""


class STTProvider:
    name = "none"
    location = "cloud"

    @property
    def model(self) -> str:
        raise NotImplementedError

    def availability(self) -> Optional[str]:
        """None when it can transcribe now, else a reason from ``REASONS``."""
        raise NotImplementedError

    async def transcribe(self, wav: bytes, info: WavInfo, hint: List[str]) -> str:
        raise NotImplementedError


def instruction(hint: List[str]) -> str:
    if not hint:
        return INSTRUCTION
    return INSTRUCTION + " Preferred spellings for names that may come up: " + ", ".join(hint) + "."
