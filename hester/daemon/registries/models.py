"""
Bespoke Agent Registry Models - Pydantic models for registry data.

Defines the data structures for prompts, agents, toolsets, and routing results.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from enum import Enum

from pydantic import BaseModel, Field
import numpy as np


class ThinkingTier(str, Enum):
    """Model tiers for thinking depth."""
    QUICK = "QUICK"
    STANDARD = "STANDARD"
    DEEP = "DEEP"
    REASONING = "REASONING"


# =============================================================================
# Prompt Registry Models
# =============================================================================


class PromptConfig(BaseModel):
    """Configuration for a domain-specific prompt."""
    name: str
    description: str
    keywords: List[str] = Field(default_factory=list)
    min_tier: ThinkingTier = ThinkingTier.QUICK
    preferred_tier: ThinkingTier = ThinkingTier.STANDARD
    max_tier: ThinkingTier = ThinkingTier.DEEP
    template: Optional[str] = None  # Inline template
    template_file: Optional[str] = None  # Path to external .md file
    meta_prompt: bool = False  # If True, selected via FunctionGemma when semantic routing is uncertain


class PromptRoutingConfig(BaseModel):
    """Configuration for prompt routing behavior."""
    match_threshold: float = 0.5  # Minimum similarity score for match
    fallback: str = "general"  # Default prompt when no match
    meta_prompts: List[str] = Field(default_factory=list)  # Meta-prompts for FunctionGemma classification
    log_routing: bool = True


class PromptRegistryData(BaseModel):
    """Full prompt registry YAML structure."""
    prompts: Dict[str, PromptConfig]
    routing: PromptRoutingConfig = Field(default_factory=PromptRoutingConfig)


# =============================================================================
# Agent Registry Models
# =============================================================================


class ToolsetConfig(BaseModel):
    """Named toolset configuration - maps to tool categories."""
    description: str
    categories: List[str]


class AgentConfig(BaseModel):
    """Pre-bundled agent configuration."""
    name: str
    description: str
    prompt: str  # Reference to prompt ID in prompt registry
    toolset: str  # Reference to toolset ID
    model_tier: ThinkingTier = ThinkingTier.STANDARD
    max_iterations: int = 10
    keywords: List[str] = Field(default_factory=list)


class AgentRoutingConfig(BaseModel):
    """Configuration for agent routing behavior."""
    match_threshold: float = 0.6  # Higher threshold for agent selection
    fallback_to_bespoke: bool = True  # Build bespoke if no agent matches


class AgentRegistryData(BaseModel):
    """Full agent registry YAML structure."""
    toolsets: Dict[str, ToolsetConfig]
    agents: Dict[str, AgentConfig]
    routing: AgentRoutingConfig = Field(default_factory=AgentRoutingConfig)


# =============================================================================
# Routing Result Models
# =============================================================================


@dataclass
class PromptMatch:
    """Result of prompt semantic matching."""
    prompt_id: str
    score: float
    keywords_matched: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "prompt_id": self.prompt_id,
            "score": self.score,
            "keywords_matched": self.keywords_matched,
        }


@dataclass
class AgentMatch:
    """Result of agent matching."""
    agent_id: str
    confidence: float
    keywords_matched: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "agent_id": self.agent_id,
            "confidence": self.confidence,
            "keywords_matched": self.keywords_matched,
        }


@dataclass
class BespokeAgentConfig:
    """
    Runtime configuration for a bespoke or pre-bundled agent.

    This is the final resolved configuration used to execute the agent.
    """
    prompt_id: str
    prompt_content: str
    tools: List[str]
    model_tier: ThinkingTier
    max_iterations: int
    is_prebundled: bool = False
    agent_id: Optional[str] = None
    toolset_id: Optional[str] = None
    routing_info: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for logging/serialization."""
        return {
            "prompt_id": self.prompt_id,
            "tools_count": len(self.tools),
            "model_tier": self.model_tier.value,
            "max_iterations": self.max_iterations,
            "is_prebundled": self.is_prebundled,
            "agent_id": self.agent_id,
            "toolset_id": self.toolset_id,
        }


# =============================================================================
# Embedding Cache Models
# =============================================================================


@dataclass
class EmbeddingCacheEntry:
    """Cached embedding with metadata."""
    id: str  # prompt_id or agent_id
    text: str  # Original text that was embedded
    embedding: np.ndarray

    def __post_init__(self):
        """Ensure embedding is numpy array."""
        if not isinstance(self.embedding, np.ndarray):
            self.embedding = np.array(self.embedding, dtype=np.float32)


__all__ = [
    # Enums
    "ThinkingTier",
    # Prompt models
    "PromptConfig",
    "PromptRoutingConfig",
    "PromptRegistryData",
    # Agent models
    "ToolsetConfig",
    "AgentConfig",
    "AgentRoutingConfig",
    "AgentRegistryData",
    # Routing results
    "PromptMatch",
    "AgentMatch",
    "BespokeAgentConfig",
    # Embedding
    "EmbeddingCacheEntry",
]
