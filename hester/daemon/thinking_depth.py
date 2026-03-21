"""
Thinking Depth - Complexity classification for model selection.

Implements tiered model selection based on task complexity:
- Quick (Tier 0): gemini-2.5-flash-lite - Greetings, clarifications, trivial lookups
- Standard (Tier 1): gemini-2.5-flash - File reads, searches, basic questions
- Deep (Tier 2): gemini-3-flash-preview - Multi-file analysis, architecture questions
- Reasoning (Tier 3): gemini-3.1-pro-preview - Complex debugging, high-stakes decisions
"""

import re
from enum import Enum
from typing import Optional, List, Dict, Any
from dataclasses import dataclass


class ThinkingDepth(Enum):
    """
    Thinking depth tiers for model selection.

    Local tiers (Ollama):
    - LOCAL: gemma3:4b (fast, ~100-200ms) - simple parsing, quick lookups
    - DEEPLOCAL: gemma3:12b (slower, ~300-500ms) - complex local reasoning

    Cloud tiers (Gemini):
    - QUICK: gemini-2.5-flash - fast cloud, simple questions
    - STANDARD: gemini-2.5-flash - balanced speed/quality
    - DEEP: gemini-3-flash - complex analysis, multi-file reasoning
    - PRO: gemini-3.1-pro - high-stakes decisions, deep reasoning
    """
    LOCAL = -2       # Local fast - gemma3:4b for quick parsing
    DEEPLOCAL = -1   # Local deep - gemma3:12b for complex local reasoning
    QUICK = 0        # Cloud fast - greetings, yes/no, simple clarifications
    STANDARD = 1     # Cloud balanced - file reads, searches, basic questions
    DEEP = 2         # Cloud complex - multi-file analysis, architecture
    PRO = 3          # Cloud reasoning - debugging, high-stakes decisions

    # Alias for backwards compatibility
    REASONING = 3


@dataclass
class DepthClassification:
    """Result of complexity classification."""
    depth: ThinkingDepth
    confidence: float
    reason: str
    signals: List[str]


# Patterns for quick classification (Tier 0)
QUICK_PATTERNS = [
    r"^(hi|hello|hey|thanks|thank you|ok|okay|got it|sure|yes|no|yep|nope)[\s!.?]*$",
    r"^what (is|are) (your|the) (name|version)",
    r"^(can you|do you|are you)",
    r"^how are you",
    r"^(good|great|nice|cool|awesome)[\s!.]*$",
]

# Patterns for standard tasks (Tier 1)
STANDARD_PATTERNS = [
    r"(read|show|open|display|cat|view)\s+(the\s+)?file",
    r"(find|search|look for|locate|grep)\s+(files?|the)",
    r"(list|show|what('s| is) in)\s+(the\s+)?(directory|folder|dir)",
    r"what (is|does|are)\s+\w+",
    r"where (is|are|can I find)",
    r"(show|find) (me\s+)?(the\s+)?definition",
    r"^(ls|pwd|cd)\s",
    # Database operations
    r"(list|show|describe)\s+(tables?|database|schema)",
    r"(query|select|count)\s+(from\s+)?\w+",
    # System operations
    r"(status|health|check)\s+(of\s+)?(service|container|system)",
    r"(start|stop|restart)\s+(service|container)",
    r"(docker|git)\s+\w+",
    # Simple web searches
    r"(search|look up|find)\s+.{5,20}$",  # Short search queries
]

# Patterns for deep analysis (Tier 2)
DEEP_PATTERNS = [
    r"(explain|analyze|understand|describe)\s+(the\s+)?(architecture|structure|design|flow|pattern)",
    r"(how|why)\s+(does|do|is|are)\s+.{20,}",  # Long how/why questions
    r"(refactor|restructure|reorganize|improve|optimize)",
    r"(compare|difference|relationship)\s+(between|of)",
    r"(all|every|each)\s+(file|class|function|module)s?\s+(that|which|where)",
    r"(trace|follow|track)\s+(the\s+)?(flow|path|execution|data)",
    r"(impact|affect|change)\s+.*(if|when|after)",
    r"(across|throughout|in all)\s+(the\s+)?(codebase|project|files)",
    # System analysis
    r"(monitor|analyze|investigate)\s+(system|performance|logs|metrics)",
    r"(deployment|infrastructure|configuration)\s+(analysis|review)",
    # Database analysis
    r"(schema|data model|relationship)\s+(analysis|design|review)",
    r"(query optimization|database performance|index)",
    # Research tasks
    r"(research|investigate|explore)\s+.{15,}",  # Research queries
    r"(best practices?|patterns?|approaches?)\s+(for|to)",
]

# Patterns for reasoning tasks (Tier 3)
REASONING_PATTERNS = [
    r"(debug|fix|solve|troubleshoot)\s+.*(error|bug|issue|problem|exception)",
    r"(why|how come)\s+.*(not working|failing|broken|wrong|incorrect)",
    r"(should I|would you recommend|what('s| is) (the best|better))",
    r"(design|architect|plan|strategy)\s+(for|to|a|the)",
    r"(trade-?off|pro.*con|advantage.*disadvantage)",
    r"(security|vulnerability|risk|threat)",
    r"(performance|optimize|bottleneck|slow)",
    r"(migrate|upgrade|deprecate|replace)\s+.{10,}",
    # System reasoning
    r"(root cause|incident|outage|failure)\s+(analysis|investigation)",
    r"(scaling|capacity planning|load balancing)",
    r"(disaster recovery|backup strategy|high availability)",
    # Complex research
    r"(comprehensive|detailed)\s+(analysis|research|investigation)",
    r"(evaluate|assess|compare)\s+.{20,}",  # Complex evaluation tasks
    # Decision support
    r"(recommend|suggest|advise)\s+.*(approach|solution|strategy)",
]

# Context signals that escalate complexity
ESCALATION_SIGNALS = {
    "multi_system": [
        r"multiple\s+(files?|services?|containers?|databases?)",
        r"across\s+(the\s+)?(project|system|infrastructure)",
        r"all\s+(the\s+)?(files?|classes?|modules?|services?)",
        r"everywhere",
        r"(codebase|entire system|full stack)",
    ],
    "uncertainty": [
        r"I('m| am)\s+not\s+sure",
        r"I\s+don('t|'?t)\s+understand",
        r"confused",
        r"help me (understand|figure out)",
        r"what('s| is)\s+going\s+on",
    ],
    "debugging": [
        r"error",
        r"exception",
        r"bug",
        r"not\s+working",
        r"fails?",
        r"broken",
        r"crash",
        r"stack\s*trace",
        r"outage",
        r"incident",
    ],
    "architecture": [
        r"architect",
        r"design\s+pattern",
        r"structure",
        r"organization",
        r"dependency",
        r"coupling",
        r"modular",
        r"infrastructure",
        r"deployment",
    ],
    "complexity": [
        r"complex",
        r"complicated",
        r"challenging",
        r"difficult",
        r"advanced",
        r"sophisticated",
        r"enterprise",
        r"production",
    ],
}


def classify_complexity(
    message: str,
    context: Optional[Dict[str, Any]] = None,
) -> DepthClassification:
    """
    Classify the complexity of a user message to determine thinking depth.

    Args:
        message: User's input message
        context: Optional context (conversation history, file context, etc.)

    Returns:
        DepthClassification with depth tier, confidence, and reasoning
    """
    message_lower = message.lower().strip()
    signals = []

    # Check for quick patterns first (Tier 0)
    for pattern in QUICK_PATTERNS:
        if re.search(pattern, message_lower):
            return DepthClassification(
                depth=ThinkingDepth.QUICK,
                confidence=0.95,
                reason="Simple greeting or acknowledgment",
                signals=["quick_pattern_match"],
            )

    # Check message length - very short messages are likely quick
    if len(message_lower) < 15 and "?" not in message:
        return DepthClassification(
            depth=ThinkingDepth.QUICK,
            confidence=0.8,
            reason="Very short message without question",
            signals=["short_message"],
        )

    # Check for reasoning patterns (Tier 3) - check before deep
    for pattern in REASONING_PATTERNS:
        if re.search(pattern, message_lower):
            signals.append(f"reasoning_pattern: {pattern[:30]}")

    # Check for escalation signals
    escalation_count = 0
    for category, patterns in ESCALATION_SIGNALS.items():
        for pattern in patterns:
            if re.search(pattern, message_lower):
                signals.append(f"escalation_{category}")
                escalation_count += 1
                break  # Only count each category once

    # If we have reasoning patterns or multiple escalation signals -> Tier 3
    if len([s for s in signals if s.startswith("reasoning_pattern")]) > 0:
        if escalation_count >= 2:
            return DepthClassification(
                depth=ThinkingDepth.REASONING,
                confidence=0.9,
                reason="Complex reasoning task with multiple escalation signals",
                signals=signals,
            )
        return DepthClassification(
            depth=ThinkingDepth.REASONING,
            confidence=0.85,
            reason="Task requires deep reasoning",
            signals=signals,
        )

    # Check for deep patterns (Tier 2)
    for pattern in DEEP_PATTERNS:
        if re.search(pattern, message_lower):
            signals.append(f"deep_pattern: {pattern[:30]}")

    if len([s for s in signals if s.startswith("deep_pattern")]) > 0:
        # Escalation signals can push deep -> reasoning
        if escalation_count >= 2:
            return DepthClassification(
                depth=ThinkingDepth.REASONING,
                confidence=0.8,
                reason="Complex analysis with escalation signals",
                signals=signals,
            )
        return DepthClassification(
            depth=ThinkingDepth.DEEP,
            confidence=0.85,
            reason="Task requires multi-step analysis",
            signals=signals,
        )

    # Check for standard patterns (Tier 1)
    for pattern in STANDARD_PATTERNS:
        if re.search(pattern, message_lower):
            signals.append(f"standard_pattern: {pattern[:30]}")

    if len([s for s in signals if s.startswith("standard_pattern")]) > 0:
        # Single escalation might push standard -> deep
        if escalation_count >= 1:
            return DepthClassification(
                depth=ThinkingDepth.DEEP,
                confidence=0.75,
                reason="Standard task with complexity signal",
                signals=signals,
            )
        return DepthClassification(
            depth=ThinkingDepth.STANDARD,
            confidence=0.85,
            reason="Standard file/search operation",
            signals=signals,
        )

    # Default based on message characteristics
    word_count = len(message.split())
    has_question = "?" in message

    if word_count > 30 or (has_question and word_count > 15):
        # Longer questions default to deep
        return DepthClassification(
            depth=ThinkingDepth.DEEP,
            confidence=0.7,
            reason="Complex question based on length",
            signals=["long_message", "has_question"] if has_question else ["long_message"],
        )

    if has_question:
        # Questions default to standard
        return DepthClassification(
            depth=ThinkingDepth.STANDARD,
            confidence=0.7,
            reason="Question requiring investigation",
            signals=["has_question"],
        )

    # Default to standard for unclassified messages
    return DepthClassification(
        depth=ThinkingDepth.STANDARD,
        confidence=0.6,
        reason="Default classification",
        signals=["no_pattern_match"],
    )


def get_model_for_depth(
    depth: ThinkingDepth,
    models: Dict[str, str],
) -> str:
    """
    Get the appropriate model for a thinking depth.

    Args:
        depth: The thinking depth tier
        models: Dict with keys 'local', 'deeplocal', 'quick', 'standard', 'deep', 'pro'

    Returns:
        Model name string
    """
    model_map = {
        ThinkingDepth.LOCAL: models.get("local", "gemma3-4b"),
        ThinkingDepth.DEEPLOCAL: models.get("deeplocal", "gemma3-12b"),
        ThinkingDepth.QUICK: models.get("quick", "gemini-2.5-flash"),
        ThinkingDepth.STANDARD: models.get("standard", "gemini-2.5-flash"),
        ThinkingDepth.DEEP: models.get("deep", "gemini-3-flash-preview"),
        ThinkingDepth.PRO: models.get("pro", "gemini-3.1-pro-preview"),
    }
    return model_map.get(depth, models.get("standard", "gemini-2.5-flash"))


def get_cloud_model_for_depth(depth: ThinkingDepth) -> str:
    """
    Get the default cloud Gemini model for a thinking depth.

    For local tiers, returns the equivalent cloud model as fallback.
    """
    cloud_models = {
        ThinkingDepth.LOCAL: "gemini-2.5-flash",  # Fallback for local
        ThinkingDepth.DEEPLOCAL: "gemini-2.5-flash",  # Fallback for deeplocal
        ThinkingDepth.QUICK: "gemini-2.5-flash",
        ThinkingDepth.STANDARD: "gemini-2.5-flash",
        ThinkingDepth.DEEP: "gemini-3-flash-preview",
        ThinkingDepth.PRO: "gemini-3.1-pro-preview",
    }
    return cloud_models.get(depth, "gemini-2.5-flash")


def is_local_depth(depth: ThinkingDepth) -> bool:
    """Check if a depth tier uses local models."""
    return depth in (ThinkingDepth.LOCAL, ThinkingDepth.DEEPLOCAL)


def get_local_model_for_depth(depth: ThinkingDepth) -> Optional[str]:
    """
    Get the local Ollama model key for a depth tier.

    Returns None for cloud tiers.
    Note: These are internal model keys (with dashes), not Ollama model names (with colons).
    The OllamaGemmaClient.MODEL_CONFIGS maps these to actual Ollama model names.
    """
    local_models = {
        ThinkingDepth.LOCAL: "gemma3-4b",       # Maps to ollama gemma3:4b
        ThinkingDepth.DEEPLOCAL: "gemma3-12b",   # Maps to ollama gemma3:12b
    }
    return local_models.get(depth)


# Type imports for routing
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from .models import InferenceBudget, ObservationResult, ModelRoutingDecision
    from .prepare import PrepareResult


def refine_routing_decision(
    prepare_result: "PrepareResult",
    iteration: int,
    budget: "InferenceBudget",
    observation: Optional["ObservationResult"] = None,
) -> "ModelRoutingDecision":
    """
    Refine the prepare step's routing decision based on runtime state.

    This allows runtime overrides of the FunctionGemma prepare recommendation
    based on:
    - Observation complexity (needs_more_reasoning)
    - Budget exhaustion
    - Iteration count for complex tasks

    Args:
        prepare_result: Result from FunctionGemma prepare step
        iteration: Current ReAct iteration (0-indexed)
        budget: Current inference budget state
        observation: Optional observation from previous tool execution

    Returns:
        ModelRoutingDecision with final routing choice
    """
    from .models import ModelRoutingDecision

    # Start with prepare's recommendation
    use_local = prepare_result.use_local_think
    model = prepare_result.think_model
    precision = "12b" if model and "12b" in model else ("4b" if model and "4b" in model else "full")
    reason = prepare_result.routing_reason

    # Check if user explicitly requested a local tier (LOCAL or DEEPLOCAL)
    # In that case, respect their choice and don't escalate to cloud
    explicit_local = is_local_depth(prepare_result.thinking_depth)

    # Override: if observation suggests complexity, escalate to cloud
    # BUT only if user didn't explicitly request local
    if observation and observation.needs_more_reasoning and not explicit_local:
        use_local = False
        model = None
        precision = "full"
        reason = f"Escalated: observation.needs_more_reasoning=True (was: {reason})"

    # Override: if budget exhausted, try local regardless of prepare
    if not budget.can_use_cloud() and budget.can_use_local():
        use_local = True
        model = model or "gemma3-4b"
        precision = "12b" if "12b" in model else "4b"
        reason = f"Budget override: cloud exhausted, using local (was: {reason})"

    # Override: later iterations may need cloud for synthesis
    if iteration > 3 and prepare_result.thinking_depth in (ThinkingDepth.DEEP, ThinkingDepth.PRO):
        use_local = False
        model = None
        precision = "full"
        reason = f"Iteration override: iteration {iteration} > 3 for {prepare_result.thinking_depth.name} (was: {reason})"

    # Determine final model name
    if use_local and model:
        model_name = model
    elif use_local and explicit_local:
        # User explicitly requested local, use local model even if prepare didn't set one
        model_name = get_local_model_for_depth(prepare_result.thinking_depth) or "gemma3-4b"
    else:
        model_name = get_cloud_model_for_depth(prepare_result.thinking_depth)

    return ModelRoutingDecision(
        use_local=use_local,
        model_name=model_name,
        precision=precision,
        reason=reason,
        fallback_model=get_cloud_model_for_depth(prepare_result.thinking_depth) if use_local else None,
    )
