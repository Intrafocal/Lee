"""
Copywriting tool definitions - content analysis and rewriting.

Tools for analyzing tone, readability, and transforming content.
"""

from .models import ToolDefinition


ANALYZE_TONE_TOOL = ToolDefinition(
    name="analyze_tone",
    description="""Analyze the tone and voice of content.

Evaluates content for:
- Formality level (formal, professional, casual, conversational)
- Emotional temperature (warm, neutral, cool, cold)
- Confidence level (assertive, tentative, uncertain)
- Brand alignment (matches Coefficiency voice or not)

Returns a detailed analysis with specific examples from the text.

Examples:
- analyze_tone(content="We're thrilled to announce our new product!")
- analyze_tone(content="Please find attached the quarterly report.", brand_voice="coefficiency")""",
    parameters={
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The content to analyze",
            },
            "brand_voice": {
                "type": "string",
                "enum": ["coefficiency", "neutral"],
                "description": "Brand voice to compare against (default: neutral)",
            },
        },
        "required": ["content"],
    },
)


ANALYZE_READABILITY_TOOL = ToolDefinition(
    name="analyze_readability",
    description="""Analyze the readability and comprehension level of content.

Evaluates:
- Flesch-Kincaid Grade Level (approximate years of education needed)
- Flesch Reading Ease score (0-100, higher = easier)
- Average sentence length
- Complex word percentage
- Jargon and technical terms found

Provides recommendations for target audience appropriateness.

Examples:
- analyze_readability(content="The synergistic paradigm shift enables...")
- analyze_readability(content="Click the button. Enter your email.", target_level="general")""",
    parameters={
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The content to analyze",
            },
            "target_level": {
                "type": "string",
                "enum": ["executive", "professional", "general", "simple"],
                "description": "Target audience level for recommendations",
            },
        },
        "required": ["content"],
    },
)


ADJUST_TEMPERATURE_TOOL = ToolDefinition(
    name="adjust_temperature",
    description="""Adjust the emotional temperature of content (make it warmer or cooler).

Temperature scale:
- "warmer": More personal, engaging, conversational, uses "you/we"
- "cooler": More professional, formal, objective, third-person

Preserves the core message while adjusting the emotional register.
Returns the rewritten content with a brief explanation of changes.

Examples:
- adjust_temperature(content="We need to discuss the budget.", direction="warmer")
- adjust_temperature(content="Hey! Super excited to share this!", direction="cooler")
- adjust_temperature(content="The meeting is scheduled.", direction="warmer", intensity=2)""",
    parameters={
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The content to adjust",
            },
            "direction": {
                "type": "string",
                "enum": ["warmer", "cooler"],
                "description": "Direction to adjust temperature",
            },
            "intensity": {
                "type": "integer",
                "description": "Adjustment intensity 1-3 (1=slight, 2=moderate, 3=significant). Default: 2",
            },
        },
        "required": ["content", "direction"],
    },
)


REWRITE_CONTENT_TOOL = ToolDefinition(
    name="rewrite_content",
    description="""Rewrite content with specified parameters.

Rewrites content while preserving meaning, adjusting for:
- Tone (professional, casual, urgent, inspirational, direct)
- Length (shorter, same, longer)
- Audience (executive, technical, general, customer)
- Voice (active, passive, mixed)

Returns the rewritten content and a summary of changes made.

Examples:
- rewrite_content(content="...", tone="direct", length="shorter")
- rewrite_content(content="...", audience="executive", voice="active")
- rewrite_content(content="...", tone="casual", preserve_key_points=True)""",
    parameters={
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "The content to rewrite",
            },
            "tone": {
                "type": "string",
                "enum": ["professional", "casual", "urgent", "inspirational", "direct", "empathetic"],
                "description": "Target tone for the rewrite",
            },
            "length": {
                "type": "string",
                "enum": ["shorter", "same", "longer"],
                "description": "Target length relative to original (default: same)",
            },
            "audience": {
                "type": "string",
                "enum": ["executive", "technical", "general", "customer", "internal"],
                "description": "Target audience for the rewrite",
            },
            "voice": {
                "type": "string",
                "enum": ["active", "passive", "mixed"],
                "description": "Grammatical voice preference (default: active)",
            },
            "preserve_key_points": {
                "type": "boolean",
                "description": "Whether to explicitly preserve key points (default: true)",
            },
        },
        "required": ["content"],
    },
)


# All copywriting tools
COPYWRITING_TOOLS = [
    ANALYZE_TONE_TOOL,
    ANALYZE_READABILITY_TOOL,
    ADJUST_TEMPERATURE_TOOL,
    REWRITE_CONTENT_TOOL,
]
