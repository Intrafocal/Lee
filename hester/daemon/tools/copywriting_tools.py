"""
Copywriting Tools - Content analysis and rewriting handlers.

Uses Gemini for AI-powered content analysis and transformation.
All operations work on provided content only - no external lookups.
"""

import logging
import re
from typing import Any, Dict, Optional

logger = logging.getLogger("hester.daemon.tools.copywriting")

# Lazy-loaded client
_gemini_client = None


def _get_client():
    """Get or create the Gemini client."""
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        _gemini_client = genai.Client()
    return _gemini_client


# Coefficiency brand voice guidelines for reference
COEFFICIENCY_VOICE = """
Coefficiency Brand Voice:
- Direct and confident, never hedging or apologetic
- No corporate buzzwords or hollow jargon
- Speaks like a trusted advisor with scar tissue
- Uses "you" and "we" - personal but professional
- Acknowledges hard truths without sugarcoating
- Concise - every word earns its place
- Pattern: observation, implication, action
"""


async def analyze_tone(
    content: str,
    brand_voice: str = "neutral",
    model: str = "gemini-2.5-flash",
) -> Dict[str, Any]:
    """
    Analyze the tone and voice of content.

    Args:
        content: The content to analyze
        brand_voice: Brand voice to compare against ("coefficiency" or "neutral")
        model: Gemini model to use

    Returns:
        Dict with analysis results
    """
    if not content or not content.strip():
        return {
            "success": False,
            "error": "No content provided",
        }

    try:
        client = _get_client()

        brand_context = ""
        if brand_voice == "coefficiency":
            brand_context = f"\n\nCompare against this brand voice standard:\n{COEFFICIENCY_VOICE}"

        prompt = f"""Analyze the tone and voice of this content:{brand_context}

Content to analyze:
---
{content[:5000]}
---

Provide a structured analysis with:
1. **Formality Level**: (formal/professional/casual/conversational) with examples
2. **Emotional Temperature**: (warm/neutral/cool/cold) with examples
3. **Confidence Level**: (assertive/balanced/tentative/uncertain) with examples
4. **Voice Characteristics**: Key patterns you notice
5. **Strengths**: What works well
6. **Opportunities**: What could be improved
{"7. **Brand Alignment**: How well it matches Coefficiency voice (if brand_voice is coefficiency)" if brand_voice == "coefficiency" else ""}

Be specific and cite examples from the text."""

        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )

        analysis = response.text.strip() if response.text else "Analysis failed"

        return {
            "success": True,
            "analysis": analysis,
            "content_length": len(content),
            "brand_voice_checked": brand_voice,
        }

    except Exception as e:
        logger.error(f"Tone analysis error: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def analyze_readability(
    content: str,
    target_level: Optional[str] = None,
    model: str = "gemini-2.5-flash",
) -> Dict[str, Any]:
    """
    Analyze the readability and comprehension level of content.

    Args:
        content: The content to analyze
        target_level: Target audience level for recommendations
        model: Gemini model to use

    Returns:
        Dict with readability metrics and recommendations
    """
    if not content or not content.strip():
        return {
            "success": False,
            "error": "No content provided",
        }

    # Calculate basic metrics locally
    sentences = re.split(r'[.!?]+', content)
    sentences = [s.strip() for s in sentences if s.strip()]
    words = content.split()

    avg_sentence_length = len(words) / max(len(sentences), 1)

    # Complex words (3+ syllables, simplified heuristic)
    complex_words = [w for w in words if len(w) > 10]
    complex_percentage = (len(complex_words) / max(len(words), 1)) * 100

    try:
        client = _get_client()

        target_context = ""
        if target_level:
            level_descriptions = {
                "executive": "busy executives who skim for key points",
                "professional": "professionals with domain knowledge",
                "general": "general audience with no specialized knowledge",
                "simple": "readers who prefer simple, clear language",
            }
            target_context = f"\n\nTarget audience: {level_descriptions.get(target_level, target_level)}"

        prompt = f"""Analyze the readability of this content:{target_context}

Content to analyze:
---
{content[:5000]}
---

Basic metrics calculated:
- Word count: {len(words)}
- Sentence count: {len(sentences)}
- Average sentence length: {avg_sentence_length:.1f} words
- Complex word percentage: {complex_percentage:.1f}%

Provide:
1. **Flesch-Kincaid Grade Level estimate**: X.X (years of education needed)
2. **Flesch Reading Ease estimate**: X/100 (higher = easier to read)
3. **Jargon/Technical Terms Found**: List any specialized terms
4. **Sentence Complexity Assessment**: Are sentences too long/complex?
5. **Recommendations**: Specific suggestions to improve readability for the target audience
6. **Overall Assessment**: Is this appropriate for the target audience?

Be specific with examples."""

        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )

        analysis = response.text.strip() if response.text else "Analysis failed"

        return {
            "success": True,
            "analysis": analysis,
            "metrics": {
                "word_count": len(words),
                "sentence_count": len(sentences),
                "avg_sentence_length": round(avg_sentence_length, 1),
                "complex_word_percentage": round(complex_percentage, 1),
            },
            "target_level": target_level,
        }

    except Exception as e:
        logger.error(f"Readability analysis error: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def adjust_temperature(
    content: str,
    direction: str,
    intensity: int = 2,
    model: str = "gemini-2.5-flash",
) -> Dict[str, Any]:
    """
    Adjust the emotional temperature of content.

    Args:
        content: The content to adjust
        direction: "warmer" or "cooler"
        intensity: 1 (slight), 2 (moderate), or 3 (significant)
        model: Gemini model to use

    Returns:
        Dict with adjusted content and explanation
    """
    if not content or not content.strip():
        return {
            "success": False,
            "error": "No content provided",
        }

    if direction not in ("warmer", "cooler"):
        return {
            "success": False,
            "error": f"Invalid direction: {direction}. Use 'warmer' or 'cooler'.",
        }

    intensity = max(1, min(3, intensity))

    try:
        client = _get_client()

        intensity_desc = {1: "slight", 2: "moderate", 3: "significant"}

        if direction == "warmer":
            direction_guidance = """
Make it warmer by:
- Using more personal pronouns (you, we, I)
- Adding conversational phrases
- Showing empathy and connection
- Using contractions where natural
- Adding warmth without being unprofessional"""
        else:
            direction_guidance = """
Make it cooler by:
- Using more formal language
- Removing excessive enthusiasm
- Using third-person where appropriate
- Removing unnecessary contractions
- Maintaining professional distance"""

        prompt = f"""Adjust the emotional temperature of this content.

Direction: Make it {direction} ({intensity_desc[intensity]} adjustment)
{direction_guidance}

Original content:
---
{content[:5000]}
---

Provide:
1. **Rewritten Content**: The adjusted version
2. **Changes Made**: Brief bullet points of what you changed and why

Preserve the core message and meaning. Don't add new information."""

        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )

        result = response.text.strip() if response.text else content

        return {
            "success": True,
            "result": result,
            "direction": direction,
            "intensity": intensity,
            "original_length": len(content),
        }

    except Exception as e:
        logger.error(f"Temperature adjustment error: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def rewrite_content(
    content: str,
    tone: Optional[str] = None,
    length: str = "same",
    audience: Optional[str] = None,
    voice: str = "active",
    preserve_key_points: bool = True,
    model: str = "gemini-2.5-flash",
) -> Dict[str, Any]:
    """
    Rewrite content with specified parameters.

    Args:
        content: The content to rewrite
        tone: Target tone
        length: Target length relative to original
        audience: Target audience
        voice: Grammatical voice preference
        preserve_key_points: Whether to preserve key points
        model: Gemini model to use

    Returns:
        Dict with rewritten content and summary
    """
    if not content or not content.strip():
        return {
            "success": False,
            "error": "No content provided",
        }

    try:
        client = _get_client()

        # Build requirements
        requirements = []

        if tone:
            tone_guidance = {
                "professional": "Maintain professional, business-appropriate language",
                "casual": "Use conversational, approachable language",
                "urgent": "Convey urgency and importance",
                "inspirational": "Be motivating and uplifting",
                "direct": "Be clear, concise, and to the point - no fluff",
                "empathetic": "Show understanding and care for the reader",
            }
            requirements.append(f"Tone: {tone_guidance.get(tone, tone)}")

        if length == "shorter":
            requirements.append("Length: Make it significantly shorter (50-70% of original)")
        elif length == "longer":
            requirements.append("Length: Expand with more detail (130-150% of original)")
        else:
            requirements.append("Length: Keep roughly the same length")

        if audience:
            audience_guidance = {
                "executive": "For executives - lead with conclusions, minimal detail",
                "technical": "For technical readers - precise terminology acceptable",
                "general": "For general audience - avoid jargon, explain concepts",
                "customer": "For customers - benefits-focused, clear value proposition",
                "internal": "For internal team - can assume context, direct",
            }
            requirements.append(f"Audience: {audience_guidance.get(audience, audience)}")

        requirements.append(f"Voice: Prefer {voice} voice")

        if preserve_key_points:
            requirements.append("IMPORTANT: Preserve all key points and facts")

        prompt = f"""Rewrite this content according to these requirements:

Requirements:
{chr(10).join(f'- {r}' for r in requirements)}

Original content:
---
{content[:5000]}
---

Provide:
1. **Rewritten Content**: The new version
2. **Changes Summary**: What you changed and why (2-3 bullet points)

Do not add new facts or claims not in the original."""

        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )

        result = response.text.strip() if response.text else content

        return {
            "success": True,
            "result": result,
            "parameters": {
                "tone": tone,
                "length": length,
                "audience": audience,
                "voice": voice,
                "preserve_key_points": preserve_key_points,
            },
            "original_length": len(content),
        }

    except Exception as e:
        logger.error(f"Content rewrite error: {e}")
        return {
            "success": False,
            "error": str(e),
        }
