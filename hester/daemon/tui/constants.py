"""
TUI constants - styles, options, and command definitions.
"""

from typing import List, Tuple

from rich.style import Style

from ..thinking_depth import ThinkingDepth


# Rich styles for TUI elements
STYLES = {
    "user": Style(color="cyan", bold=True),
    "hester": Style(color="green"),
    "tool": Style(color="yellow", dim=True),
    "error": Style(color="red", bold=True),
    "thinking": Style(color="magenta", italic=True),
    "dim": Style(dim=True),
}

# Depth options for escalation selector (depth, name, short_desc)
# These are escalation options from current tier, so local tiers not included
DEPTH_OPTIONS = [
    (ThinkingDepth.STANDARD, "standard", "+5"),
    (ThinkingDepth.DEEP, "deep", "+10"),
    (ThinkingDepth.PRO, "pro", "+15"),
]

# Available slash commands for completion
SLASH_COMMANDS = [
    ("/help", "Show help information"),
    ("/clear", "Clear conversation history"),
    ("/quit", "Exit chat"),
    ("/cd", "Change working directory"),
    ("/pwd", "Show working directory"),
    ("/session", "Show session ID"),
    # Model selection - local
    ("/local", "Local fast model (gemma4:e4b)"),
    ("/deeplocal", "Local deep model (gemma4:e4b)"),
    # Model selection - cloud
    ("/quick", "Cloud fast (gemini-2.5-flash)"),
    ("/standard", "Cloud balanced (gemini-2.5-flash)"),
    ("/deep", "Cloud complex (gemini-3-flash)"),
    ("/pro", "Cloud reasoning (gemini-3.1-pro)"),
    # Image commands
    ("/paste", "Paste image from clipboard"),
    ("/clear-images", "Clear pending images"),
    # Task commands
    ("/tasks", "List all tasks"),
    ("/task", "View task with actions: /task [id] (latest if no id)"),
    ("/execute", "Execute a ready task: /execute <id>"),
    # Routing commands
    ("/prompts", "List available prompt overrides (#prompt_name)"),
    ("/agents", "List available agent overrides (@agent_name)"),
]


def get_prompt_overrides() -> List[Tuple[str, str]]:
    """
    Get available prompt overrides from the registry.

    Returns list of (prompt_id, description) tuples for autocomplete.
    """
    try:
        from ..registries import get_prompt_registry
        registry = get_prompt_registry()
        return [
            (prompt_id, config.description)
            for prompt_id, config in registry.data.prompts.items()
            if not getattr(config, 'meta_prompt', False)  # Exclude meta-prompts
        ]
    except Exception:
        # Fallback if registry not available
        return []


def get_agent_overrides() -> List[Tuple[str, str]]:
    """
    Get available agent overrides from the registry.

    Returns list of (agent_id, description) tuples for autocomplete.
    """
    try:
        from ..registries import get_agent_registry
        registry = get_agent_registry()
        return [
            (agent_id, config.description)
            for agent_id, config in registry.data.agents.items()
        ]
    except Exception:
        # Fallback if registry not available
        return []
