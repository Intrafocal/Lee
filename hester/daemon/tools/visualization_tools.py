"""
Visualization tool executors for Hester ReAct agents.

Handles Mermaid diagram rendering, Gemini image generation,
and structured markdown rendering.
"""

import base64
import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger("hester.tools.visualization")


async def execute_render_mermaid(
    mermaid: str,
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Return Mermaid diagram DSL for frontend rendering.

    The frontend's MarkdownPreview component handles the actual SVG rendering
    via the mermaid.js library. This tool just wraps the content with metadata.
    """
    return {
        "type": "mermaid",
        "content": mermaid,
        "title": title or "Diagram",
    }


async def execute_generate_image(
    prompt: str,
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Generate an image using Gemini's image generation model.

    Uses gemini-2.5-flash-image with response_modalities=['IMAGE', 'TEXT']
    to produce a PNG image from a text prompt.
    """
    try:
        from google import genai
        from google.genai import types

        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            return {
                "type": "error",
                "error": "GOOGLE_API_KEY not set",
            }

        client = genai.Client(api_key=api_key)

        response = client.models.generate_content(
            model="gemini-2.5-flash-image",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE", "TEXT"],
            ),
        )

        # Extract image from response parts
        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                mime_type = part.inline_data.mime_type or "image/png"
                img_title = title or "Generated Image"
                return {
                    "type": "image",
                    "content": f"[Image generated successfully: {img_title}]",
                    "mime_type": mime_type,
                    "title": img_title,
                    # Raw bytes — popped by ReAct loop before serialization,
                    # then injected as a Part so the model can see the image
                    # without the base64 bloating the conversation text.
                    "_image_data": part.inline_data.data,
                    "_image_mime_type": mime_type,
                }

        # No image in response — return any text
        text_parts = [p.text for p in response.candidates[0].content.parts if p.text]
        return {
            "type": "error",
            "error": f"No image generated. Model response: {' '.join(text_parts)}",
        }

    except Exception as e:
        logger.error(f"Image generation error: {e}")
        return {
            "type": "error",
            "error": str(e),
        }


async def execute_render_markdown(
    markdown: str,
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Return structured markdown for frontend rendering.

    The frontend's MarkdownPreview component handles rendering.
    This tool wraps the content with metadata.
    """
    return {
        "type": "markdown",
        "content": markdown,
        "title": title or "Visualization",
    }
