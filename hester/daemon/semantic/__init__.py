"""
Semantic Package - Unified semantic routing and delegate management for Hester.

This package provides:
- BaseDelegate: Abstract base class for all task delegates
- HesterRegistry: Central registration for delegates, tools, and semantic routing
- DelegateFactory: Factory for creating delegate instances with configuration
- SemanticRouter: Unified semantic matching for knowledge, tools, and agents
- EmbeddingService: Centralized embedding generation with caching

Usage:
    from daemon.semantic import (
        BaseDelegate,
        HesterRegistry,
        DelegateFactory,
        SemanticRouter,
        EmbeddingService,
        register_delegate,
        register_tool,
    )
"""

from .base import (
    BaseDelegate,
    DelegateRegistration,
    ToolRegistration,
    register_delegate,
    register_tool,
)
from .registry import HesterRegistry
from .factory import DelegateFactory
from .embeddings import EmbeddingService
from .router import (
    SemanticRouter,
    RouteCandidate,
    KnowledgeMatchResult,
    ToolMatchResult,
    AgentMatchResult,
    MatchedBundle,
    MatchedDoc,
)

__all__ = [
    # Base classes and registrations
    "BaseDelegate",
    "DelegateRegistration",
    "ToolRegistration",
    # Decorators
    "register_delegate",
    "register_tool",
    # Registry and factory
    "HesterRegistry",
    "DelegateFactory",
    # Embedding and routing
    "EmbeddingService",
    "SemanticRouter",
    "RouteCandidate",
    "KnowledgeMatchResult",
    "ToolMatchResult",
    "AgentMatchResult",
    "MatchedBundle",
    "MatchedDoc",
]
