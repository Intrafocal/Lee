"""
Gemini Client - Shared Gemini SDK wrapper for workstream modules.

Uses the modern `google.genai` SDK with gemini-3-flash-preview model.
Provides JSON-mode generation with automatic thinking config for Gemini 3.
"""

import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("hester.daemon.workstream.gemini")


def _get_model_name() -> str:
    """Get the Gemini model name from settings."""
    try:
        from ..settings import get_settings
        return get_settings().gemini_model_deep
    except Exception:
        return "gemini-3-flash-preview"


def _get_client():
    """Get a configured Gemini client."""
    from google import genai
    return genai.Client()


async def generate_json(
    prompt: str,
    model_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate a JSON response from Gemini.

    Uses gemini-3-flash-preview with thinking_config for Gemini 3 models.
    Returns parsed JSON dict. Raises on failure (no silent fallbacks).

    Args:
        prompt: The full prompt text
        model_name: Override model (defaults to settings.gemini_model_deep)

    Returns:
        Parsed JSON dict from Gemini response
    """
    from google.genai import types

    client = _get_client()
    model = model_name or _get_model_name()

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        temperature=0.3,
    )

    # Gemini 3 models require thinking_config
    if "gemini-3" in model:
        config.thinking_config = types.ThinkingConfig(thinking_level="low")

    response = await client.aio.models.generate_content(
        model=model,
        contents=prompt,
        config=config,
    )

    return json.loads(response.text)


async def generate_text(
    prompt: str,
    model_name: Optional[str] = None,
    temperature: float = 0.5,
) -> str:
    """Generate a text response from Gemini.

    Args:
        prompt: The full prompt text
        model_name: Override model (defaults to settings.gemini_model_deep)
        temperature: Generation temperature

    Returns:
        Text response from Gemini
    """
    from google.genai import types

    client = _get_client()
    model = model_name or _get_model_name()

    config = types.GenerateContentConfig(
        temperature=temperature,
    )

    if "gemini-3" in model:
        config.thinking_config = types.ThinkingConfig(thinking_level="low")

    response = await client.aio.models.generate_content(
        model=model,
        contents=prompt,
        config=config,
    )

    return response.text.strip() if response.text else ""
