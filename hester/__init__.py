"""
Hester - The Internal Daemon for Coefficiency.

Sybil's infrastructure, applied to the system domain.
Watchful, practical, no BS.

Capabilities:
- HesterQA: Scene testing via simulated conversation (Phase 1)
- HesterBrief: Daily summaries for business team (Phase 4)
- HesterIdeas: Idea capture from any format (Phase 3)
- HesterDocs: Documentation sync and semantic search (Phase 5)
"""

__version__ = "0.1.0"

# Lazy imports to avoid pulling in heavy dependencies (MCP, PIL, etc.)
# when only using specific modules like slack
def __getattr__(name):
    """Lazy import QA components only when accessed."""
    if name in (
        "HesterQAAgent",
        "ConversationDriver",
        "SceneEvaluator",
        "HesterQAResult",
        "ENGAGED_USER",
        "Persona",
    ):
        from .qa import (
            HesterQAAgent,
            ConversationDriver,
            SceneEvaluator,
            HesterQAResult,
            ENGAGED_USER,
            Persona,
        )
        return locals()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "__version__",
    "HesterQAAgent",
    "ConversationDriver",
    "SceneEvaluator",
    "HesterQAResult",
    "ENGAGED_USER",
    "Persona",
]
