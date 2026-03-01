"""
Bespoke Agent Registries - Prompt, Tool, and Agent configuration.

Provides composable agent building from YAML-defined components with
semantic embedding-based routing.

Usage:
    from lee.hester.daemon.registries import get_prompt_registry, get_agent_registry

    # Get singleton registries
    prompt_registry = get_prompt_registry()
    agent_registry = get_agent_registry()

    # Route a message to best prompt
    prompt_match = await prompt_registry.match(message, embedding_service)

    # Check for pre-bundled agent match
    agent_match = await agent_registry.match(message, embedding_service)
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional, Any, TYPE_CHECKING

import yaml
import numpy as np

from .models import (
    PromptConfig,
    PromptRoutingConfig,
    PromptRegistryData,
    ToolsetConfig,
    AgentConfig,
    AgentRoutingConfig,
    AgentRegistryData,
    PromptMatch,
    AgentMatch,
    ThinkingTier,
    EmbeddingCacheEntry,
)

if TYPE_CHECKING:
    from ..semantic.embeddings import EmbeddingService

logger = logging.getLogger("hester.daemon.registries")

REGISTRY_DIR = Path(__file__).parent


class PromptRegistry:
    """
    Registry for domain-specific prompts with semantic routing.

    Prompts are loaded from prompts.yaml and matched to user messages
    using embedding similarity.
    """

    def __init__(self, registry_dir: Optional[Path] = None):
        self.registry_dir = registry_dir or REGISTRY_DIR
        self._data: Optional[PromptRegistryData] = None
        self._prompt_cache: Dict[str, str] = {}  # prompt_id -> content
        self._embeddings: Dict[str, np.ndarray] = {}  # prompt_id -> embedding
        self._embeddings_initialized = False

    @property
    def data(self) -> PromptRegistryData:
        """Get registry data, loading if needed."""
        if self._data is None:
            self._load()
        return self._data

    def _load(self) -> None:
        """Load prompts.yaml and validate."""
        prompts_file = self.registry_dir / "prompts.yaml"
        if not prompts_file.exists():
            raise FileNotFoundError(
                f"Prompts registry required but not found: {prompts_file}"
            )

        with open(prompts_file) as f:
            raw = yaml.safe_load(f)

        self._data = PromptRegistryData.model_validate(raw)
        logger.info(f"Loaded {len(self._data.prompts)} prompts from registry")

    def get(self, prompt_id: str) -> Optional[PromptConfig]:
        """Get a prompt configuration by ID."""
        return self.data.prompts.get(prompt_id)

    def get_content(self, prompt_id: str) -> str:
        """
        Get the full prompt content (loading from file if needed).

        Raises ValueError if prompt not found.
        """
        if prompt_id in self._prompt_cache:
            return self._prompt_cache[prompt_id]

        config = self.get(prompt_id)
        if not config:
            raise ValueError(f"Prompt '{prompt_id}' not found in registry")

        if config.template:
            content = config.template
        elif config.template_file:
            template_path = self.registry_dir / config.template_file
            if template_path.exists():
                content = template_path.read_text()
            else:
                raise FileNotFoundError(
                    f"Prompt template file not found: {template_path}"
                )
        else:
            raise ValueError(f"Prompt '{prompt_id}' has no template or template_file")

        self._prompt_cache[prompt_id] = content
        return content

    async def initialize_embeddings(
        self,
        embedding_service: "EmbeddingService",
    ) -> None:
        """
        Pre-compute embeddings for all prompts.

        Called at startup to cache prompt embeddings for semantic routing.
        """
        if self._embeddings_initialized:
            return

        # Build embedding text for each prompt
        texts = []
        prompt_ids = []

        for prompt_id, config in self.data.prompts.items():
            # Combine description and keywords for richer embedding
            text = f"{config.name}: {config.description}"
            if config.keywords:
                text += f" Keywords: {', '.join(config.keywords)}"
            texts.append(text)
            prompt_ids.append(prompt_id)

        if texts:
            embeddings = await embedding_service.embed_batch(texts)
            for prompt_id, embedding in zip(prompt_ids, embeddings):
                self._embeddings[prompt_id] = embedding

        self._embeddings_initialized = True
        logger.debug(f"Initialized embeddings for {len(self._embeddings)} prompts")

    async def match(
        self,
        message: str,
        embedding_service: "EmbeddingService",
    ) -> PromptMatch:
        """
        Match a message to the best prompt using semantic similarity.

        Args:
            message: User message to match
            embedding_service: Service for generating embeddings

        Returns:
            PromptMatch with best matching prompt and score
        """
        # Ensure embeddings are initialized
        await self.initialize_embeddings(embedding_service)

        if not self._embeddings:
            # No embeddings available, return fallback
            return PromptMatch(
                prompt_id=self.data.routing.fallback,
                score=0.0,
            )

        # Embed the message
        msg_embedding = await embedding_service.embed(message)

        # Find best match
        best_match = PromptMatch(
            prompt_id=self.data.routing.fallback,
            score=0.0,
        )

        for prompt_id, prompt_embedding in self._embeddings.items():
            score = embedding_service.cosine_similarity(msg_embedding, prompt_embedding)

            if score > best_match.score:
                config = self.get(prompt_id)
                best_match = PromptMatch(
                    prompt_id=prompt_id,
                    score=score,
                    keywords_matched=config.keywords if config else [],
                )

        # Apply threshold - return fallback if below
        if best_match.score < self.data.routing.match_threshold:
            if self.data.routing.log_routing:
                logger.debug(
                    f"Prompt match below threshold ({best_match.score:.3f} < "
                    f"{self.data.routing.match_threshold}), using fallback"
                )
            return PromptMatch(
                prompt_id=self.data.routing.fallback,
                score=0.0,
            )

        if self.data.routing.log_routing:
            logger.debug(
                f"Prompt match: {best_match.prompt_id} (score={best_match.score:.3f})"
            )

        return best_match

    def merge_plugin_prompts(
        self,
        prompt_configs: Dict[str, Any],
        prompt_templates: Dict[str, str],
    ) -> None:
        """Merge a plugin's prompts into the registry."""
        # Ensure data is loaded
        _ = self.data

        for prompt_id, config_dict in prompt_configs.items():
            config = PromptConfig(**config_dict) if isinstance(config_dict, dict) else config_dict
            self._data.prompts[prompt_id] = config
            logger.info(f"Registered plugin prompt: {prompt_id}")

        # Cache templates directly (bypass file loading)
        for prompt_id, content in prompt_templates.items():
            self._prompt_cache[prompt_id] = content

        # Reset embeddings so they're recomputed with plugin prompts
        self._embeddings_initialized = False

    def list_prompts(self) -> List[str]:
        """List all prompt IDs."""
        return list(self.data.prompts.keys())

    def get_tier_constraints(self, prompt_id: str) -> tuple[ThinkingTier, ThinkingTier, ThinkingTier]:
        """
        Get tier constraints for a prompt.

        Returns:
            Tuple of (min_tier, preferred_tier, max_tier)
        """
        config = self.get(prompt_id)
        if not config:
            return (ThinkingTier.QUICK, ThinkingTier.STANDARD, ThinkingTier.DEEP)
        return (config.min_tier, config.preferred_tier, config.max_tier)


class AgentRegistry:
    """
    Registry for pre-bundled agent configurations.

    Agents combine a prompt, toolset, and model tier into a reusable
    configuration for common task types.
    """

    def __init__(self, registry_dir: Optional[Path] = None):
        self.registry_dir = registry_dir or REGISTRY_DIR
        self._data: Optional[AgentRegistryData] = None
        self._embeddings: Dict[str, np.ndarray] = {}  # agent_id -> embedding
        self._embeddings_initialized = False

    @property
    def data(self) -> AgentRegistryData:
        """Get registry data, loading if needed."""
        if self._data is None:
            self._load()
        return self._data

    def _load(self) -> None:
        """Load agents.yaml and validate."""
        agents_file = self.registry_dir / "agents.yaml"
        if not agents_file.exists():
            raise FileNotFoundError(
                f"Agents registry required but not found: {agents_file}"
            )

        with open(agents_file) as f:
            raw = yaml.safe_load(f)

        self._data = AgentRegistryData.model_validate(raw)
        logger.info(
            f"Loaded {len(self._data.agents)} agents, "
            f"{len(self._data.toolsets)} toolsets from registry"
        )

    def get_agent(self, agent_id: str) -> Optional[AgentConfig]:
        """Get an agent configuration by ID."""
        return self.data.agents.get(agent_id)

    def get_toolset(self, toolset_id: str) -> Optional[ToolsetConfig]:
        """Get a toolset configuration by ID."""
        return self.data.toolsets.get(toolset_id)

    def resolve_tools(self, toolset_id: str) -> List[str]:
        """
        Resolve a toolset ID to a list of tool names.

        Uses TOOL_CATEGORIES from tool definitions.
        """
        from ..tools.definitions import TOOL_CATEGORIES

        toolset = self.get_toolset(toolset_id)
        if not toolset:
            logger.warning(f"Toolset '{toolset_id}' not found, returning empty list")
            return []

        tools = set()
        for category in toolset.categories:
            category_tools = TOOL_CATEGORIES.get(category, [])
            tools.update(category_tools)

        return list(tools)

    async def initialize_embeddings(
        self,
        embedding_service: "EmbeddingService",
    ) -> None:
        """
        Pre-compute embeddings for all agents.

        Called at startup to cache agent embeddings for semantic routing.
        """
        if self._embeddings_initialized:
            return

        # Build embedding text for each agent
        texts = []
        agent_ids = []

        for agent_id, config in self.data.agents.items():
            # Combine description and keywords for richer embedding
            text = f"{config.name}: {config.description}"
            if config.keywords:
                text += f" Keywords: {', '.join(config.keywords)}"
            texts.append(text)
            agent_ids.append(agent_id)

        if texts:
            embeddings = await embedding_service.embed_batch(texts)
            for agent_id, embedding in zip(agent_ids, embeddings):
                self._embeddings[agent_id] = embedding

        self._embeddings_initialized = True
        logger.debug(f"Initialized embeddings for {len(self._embeddings)} agents")

    async def match(
        self,
        message: str,
        embedding_service: "EmbeddingService",
    ) -> Optional[AgentMatch]:
        """
        Match a message to a pre-bundled agent using semantic similarity.

        Args:
            message: User message to match
            embedding_service: Service for generating embeddings

        Returns:
            AgentMatch if above threshold, None otherwise (build bespoke)
        """
        # Ensure embeddings are initialized
        await self.initialize_embeddings(embedding_service)

        if not self._embeddings:
            return None

        # Embed the message
        msg_embedding = await embedding_service.embed(message)

        # Find best match
        best_match: Optional[AgentMatch] = None

        for agent_id, agent_embedding in self._embeddings.items():
            score = embedding_service.cosine_similarity(msg_embedding, agent_embedding)

            if score > self.data.routing.match_threshold:
                if best_match is None or score > best_match.confidence:
                    config = self.get_agent(agent_id)
                    best_match = AgentMatch(
                        agent_id=agent_id,
                        confidence=score,
                        keywords_matched=config.keywords if config else [],
                    )

        if best_match:
            logger.debug(
                f"Agent match: {best_match.agent_id} "
                f"(confidence={best_match.confidence:.3f})"
            )
        else:
            logger.debug(
                "No agent match above threshold, will build bespoke agent"
            )

        return best_match

    def merge_plugin_agents(
        self,
        agent_configs: Dict[str, Any],
        toolset_configs: Dict[str, Any],
    ) -> None:
        """Merge a plugin's agents and toolsets into the registry."""
        # Ensure data is loaded
        _ = self.data

        for agent_id, config_dict in agent_configs.items():
            agent = AgentConfig(**config_dict) if isinstance(config_dict, dict) else config_dict
            self._data.agents[agent_id] = agent
            logger.info(f"Registered plugin agent: {agent_id}")

        for toolset_id, config_dict in toolset_configs.items():
            toolset = ToolsetConfig(**config_dict) if isinstance(config_dict, dict) else config_dict
            self._data.toolsets[toolset_id] = toolset

        # Reset embeddings so they're recomputed with plugin agents
        self._embeddings_initialized = False

    def list_agents(self) -> List[str]:
        """List all agent IDs."""
        return list(self.data.agents.keys())

    def list_toolsets(self) -> List[str]:
        """List all toolset IDs."""
        return list(self.data.toolsets.keys())


# =============================================================================
# Singleton Registry Instances
# =============================================================================

_prompt_registry: Optional[PromptRegistry] = None
_agent_registry: Optional[AgentRegistry] = None


def get_prompt_registry(registry_dir: Optional[Path] = None) -> PromptRegistry:
    """
    Get or create the prompt registry singleton.

    Args:
        registry_dir: Optional path to registry directory (only used on first call)
    """
    global _prompt_registry
    if _prompt_registry is None:
        _prompt_registry = PromptRegistry(registry_dir)
    return _prompt_registry


def get_agent_registry(registry_dir: Optional[Path] = None) -> AgentRegistry:
    """
    Get or create the agent registry singleton.

    Args:
        registry_dir: Optional path to registry directory (only used on first call)
    """
    global _agent_registry
    if _agent_registry is None:
        _agent_registry = AgentRegistry(registry_dir)
    return _agent_registry


def reset_registries() -> None:
    """Reset registry singletons (for testing)."""
    global _prompt_registry, _agent_registry
    _prompt_registry = None
    _agent_registry = None


__all__ = [
    # Registry classes
    "PromptRegistry",
    "AgentRegistry",
    # Singleton getters
    "get_prompt_registry",
    "get_agent_registry",
    "reset_registries",
    # Models (re-export for convenience)
    "PromptMatch",
    "AgentMatch",
    "ThinkingTier",
]
