"""
DelegateFactory - Factory for creating delegate instances with configuration.

Replaces the ~200 lines of conditional logic in TaskExecutor._execute_batch()
with a clean factory pattern.

Usage:
    factory = DelegateFactory(
        registry=HesterRegistry,
        default_config={
            "working_dir": Path("/workspace"),
            "api_key": "...",
        }
    )

    # Create delegate with defaults
    delegate = factory.create("code_explorer")

    # Create with overrides
    delegate = factory.create("code_explorer", toolset="research", max_steps=20)
"""

import logging
from pathlib import Path
from typing import Any, Dict, Optional, Type

from .base import BaseDelegate, DelegateRegistration
from .registry import HesterRegistry

logger = logging.getLogger("hester.daemon.semantic.factory")


class DelegateFactory:
    """
    Factory for creating delegate instances with merged configuration.

    Provides a clean API for instantiating delegates with:
    - Default configuration from the factory
    - Default configuration from the delegate registration
    - Override configuration from the caller

    Configuration precedence (highest to lowest):
    1. Override config from create() call
    2. Default config from DelegateRegistration
    3. Default config from factory initialization
    """

    def __init__(
        self,
        default_config: Optional[Dict[str, Any]] = None,
        working_dir: Optional[Path] = None,
    ):
        """
        Initialize the factory with default configuration.

        Args:
            default_config: Default configuration for all delegates
            working_dir: Default working directory (convenience parameter)
        """
        self._default_config = default_config or {}
        if working_dir:
            self._default_config["working_dir"] = working_dir

        logger.debug(f"DelegateFactory initialized with defaults: {list(self._default_config.keys())}")

    @property
    def working_dir(self) -> Optional[Path]:
        """Get the default working directory."""
        wd = self._default_config.get("working_dir")
        return Path(wd) if wd else None

    def create(
        self,
        delegate_name: str,
        **override_config,
    ) -> BaseDelegate:
        """
        Create a delegate instance with merged configuration.

        Args:
            delegate_name: Name of the delegate to create (e.g., "code_explorer")
            **override_config: Configuration overrides for this instance

        Returns:
            Instantiated delegate

        Raises:
            ValueError: If delegate is not registered
            TypeError: If delegate class doesn't inherit from BaseDelegate
        """
        registration = HesterRegistry.get_delegate(delegate_name)

        if not registration:
            # Try to find delegate by BatchDelegate enum value
            registration = self._find_delegate_by_enum(delegate_name)

        if not registration:
            raise ValueError(f"Unknown delegate: {delegate_name}")

        # Merge configurations (precedence: override > registration > factory default)
        config = {
            **self._default_config,
            **registration.default_config,
            **override_config,
        }

        # Ensure working_dir is a Path
        if "working_dir" in config and isinstance(config["working_dir"], str):
            config["working_dir"] = Path(config["working_dir"])

        # Add default toolset if not overridden
        if "toolset" not in config:
            config["toolset"] = registration.default_toolset

        logger.debug(
            f"Creating delegate: {delegate_name} with config keys: {list(config.keys())}"
        )

        try:
            return registration.delegate_class(**config)
        except TypeError as e:
            logger.error(f"Failed to instantiate {delegate_name}: {e}")
            raise TypeError(
                f"Failed to instantiate {delegate_name}. "
                f"Check that the delegate accepts the provided config: {e}"
            ) from e

    def _find_delegate_by_enum(self, name: str) -> Optional[DelegateRegistration]:
        """
        Try to find delegate by BatchDelegate enum value.

        This supports the transition from enum-based to registry-based delegation.

        Args:
            name: BatchDelegate enum value (e.g., "claude_code", "hester_agent")

        Returns:
            DelegateRegistration or None
        """
        # Map BatchDelegate enum values to registry names
        enum_to_registry = {
            "claude_code": "claude_code",
            "hester": "hester",
            "hester_agent": "code_explorer",  # Alias
            "code_explorer": "code_explorer",
            "web_researcher": "web_researcher",
            "gemini_grounded": "web_researcher",  # Alias
            "docs_manager": "docs_manager",
            "db_explorer": "db_explorer",
            "test_runner": "test_runner",
            "context_bundle": "context_bundle",
            "validator": "validator",
            "manual": "manual",
        }

        registry_name = enum_to_registry.get(name.lower())
        if registry_name:
            return HesterRegistry.get_delegate(registry_name)
        return None

    def create_from_batch(
        self,
        batch: "TaskBatch",
        **extra_config,
    ) -> BaseDelegate:
        """
        Create a delegate instance from a TaskBatch.

        Convenience method that extracts configuration from the batch.

        Args:
            batch: TaskBatch with delegate type and configuration
            **extra_config: Additional configuration

        Returns:
            Instantiated delegate
        """
        from ..tasks.models import TaskBatch

        config = {
            **extra_config,
        }

        # Extract batch-specific config
        if batch.toolset:
            config["toolset"] = batch.toolset
        if batch.scoped_tools:
            config["scoped_tools"] = batch.scoped_tools
        if batch.params:
            config.update(batch.params)

        return self.create(batch.delegate.value, **config)

    def is_delegate_registered(self, name: str) -> bool:
        """
        Check if a delegate is registered.

        Args:
            name: Delegate name or BatchDelegate enum value

        Returns:
            True if delegate exists in registry
        """
        if HesterRegistry.get_delegate(name):
            return True
        return self._find_delegate_by_enum(name) is not None

    def list_available_delegates(self) -> list[str]:
        """
        List all available delegate names.

        Returns:
            List of delegate names
        """
        return HesterRegistry.get_delegate_names()


# Module-level factory instance (lazy initialization)
_default_factory: Optional[DelegateFactory] = None


def get_default_factory() -> DelegateFactory:
    """
    Get the default DelegateFactory instance.

    Creates factory with minimal defaults if not already initialized.

    Returns:
        DelegateFactory instance
    """
    global _default_factory
    if _default_factory is None:
        _default_factory = DelegateFactory(working_dir=Path.cwd())
    return _default_factory


def set_default_factory(factory: DelegateFactory) -> None:
    """
    Set the default DelegateFactory instance.

    Args:
        factory: DelegateFactory to use as default
    """
    global _default_factory
    _default_factory = factory
