"""
Summarize Tool - AI-powered text summarization via Gemini.

Used to summarize verbose output from Claude Code or other tools,
and for copywriting-focused summaries (tldr, executive, headline, abstract).
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("hester.daemon.tools.summarize")

# Lazy-loaded client
_gemini_client = None


def _get_client():
    """Get or create the Gemini client."""
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        _gemini_client = genai.Client()
    return _gemini_client


async def summarize_text(
    text: str,
    max_length: int = 200,
    style: str = "concise",
    context: Optional[str] = None,
    model: str = "gemini-2.0-flash-lite",
) -> Dict[str, Any]:
    """
    Summarize text using Gemini.

    Args:
        text: The text to summarize
        max_length: Target maximum length in characters (default: 200)
        style: Summary style (default: "concise")
            Dev styles: "concise", "bullet", "technical"
            Copywriting styles: "tldr", "executive", "headline", "abstract"
        context: Optional context about what the text is (e.g., "Claude Code output")
        model: Gemini model to use (default: gemini-2.0-flash-lite for speed)

    Returns:
        Dict with:
        - summary: The summarized text
        - original_length: Length of original text
        - style: The style used
        - error: Error message if failed
    """
    if not text or not text.strip():
        return {
            "summary": "",
            "original_length": 0,
            "style": style,
        }

    # For headline style, don't skip even if short (user wants a headline)
    # For other styles, if text is already short enough, return as-is
    if style not in ("headline", "tldr") and len(text) <= max_length:
        return {
            "summary": text.strip(),
            "original_length": len(text),
            "style": style,
        }

    try:
        client = _get_client()

        # Build the summarization prompt based on style
        # Dev-focused styles
        if style == "bullet":
            style_instruction = "Summarize as 2-3 bullet points, each under 50 characters."
        elif style == "technical":
            style_instruction = f"Provide a technical summary in under {max_length} characters. Focus on what was done, files changed, and outcomes."
        # Copywriting styles
        elif style == "tldr":
            style_instruction = "Provide a TL;DR - single sentence capturing the essence. Maximum 50 words. Be direct, no fluff."
        elif style == "executive":
            style_instruction = "Provide an executive summary in 2-3 sentences. Lead with the conclusion, then the key supporting points. Maximum 100 words."
        elif style == "headline":
            style_instruction = "Write a single punchy headline that captures the core message. Maximum 10 words. No punctuation except ? or ! if needed."
        elif style == "abstract":
            style_instruction = "Write an academic-style abstract covering purpose, key points, and conclusions. 100-150 words."
        else:  # concise (default)
            style_instruction = f"Summarize in a single sentence under {max_length} characters. Focus on the key action and result."

        context_str = f"This is {context}. " if context else ""

        prompt = f"""{context_str}{style_instruction}

Text to summarize:
{text[:5000]}"""  # Increased limit for longer content

        logger.debug(f"Summarizing {len(text)} chars with style={style}")

        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )

        summary = response.text.strip() if response.text else text[:max_length] + "..."

        # Only enforce max_length for non-copywriting styles
        if style in ("concise", "technical") and len(summary) > max_length + 50:
            summary = summary[:max_length] + "..."

        logger.debug(f"Summary: {len(text)} -> {len(summary)} chars")

        return {
            "summary": summary,
            "original_length": len(text),
            "style": style,
        }

    except Exception as e:
        logger.error(f"Summarize error: {e}")
        # Fallback to simple truncation
        return {
            "summary": text[:max_length] + "..." if len(text) > max_length else text,
            "original_length": len(text),
            "style": style,
            "error": str(e),
        }


async def summarize_claude_output(
    output: str,
    task_title: Optional[str] = None,
    max_length: int = 300,
) -> str:
    """
    Summarize Claude Code output specifically.

    Optimized for summarizing verbose Claude Code execution output into
    a brief description of what was accomplished.

    Args:
        output: The Claude Code output text
        task_title: Optional task title for context
        max_length: Maximum summary length (default: 300)

    Returns:
        Summarized text string
    """
    context = "Claude Code execution output"
    if task_title:
        context = f"Claude Code output for task: {task_title}"

    result = await summarize_text(
        text=output,
        max_length=max_length,
        style="technical",
        context=context,
    )

    return result.get("summary", output[:max_length] + "...")
