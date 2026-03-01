"""
HesterRegistry - Unified registry for delegates, tools, and semantic routing.

Provides centralized registration and lookup for:
- Delegate classes (code_explorer, docs_manager, etc.)
- Tool functions (read_file, web_search, etc.)
- Semantic routing via SemanticRouter integration

Replaces the hardcoded TOOL_SETS in scoping.py and conditional logic in TaskExecutor.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, TYPE_CHECKING

from .base import (
    DelegateRegistration,
    ToolRegistration,
    get_pending_registrations,
    clear_pending_registrations,
)

if TYPE_CHECKING:
    from .router import SemanticRouter

logger = logging.getLogger("hester.daemon.semantic.registry")


class HesterRegistry:
    """
    Unified registry for Hester delegates and tools.

    This is a singleton-like class using class-level storage for registrations.
    Initialized once at daemon startup, then accessed throughout the application.

    Usage:
        # At startup
        HesterRegistry.initialize()

        # Get delegate registration
        reg = HesterRegistry.get_delegate("code_explorer")

        # Get tools for a scope
        tools = HesterRegistry.get_tools_for_scope("observe")

        # Get semantic router
        router = HesterRegistry.get_router()
    """

    # Class-level storage
    _delegates: Dict[str, DelegateRegistration] = {}
    _tools: Dict[str, ToolRegistration] = {}
    _router: Optional["SemanticRouter"] = None
    _initialized: bool = False

    # Tool scope definitions (replaces hardcoded TOOL_SETS)
    # These are the base scope definitions; tools self-register into scopes
    SCOPES = {
        "observe": {
            "description": "Read-only codebase access",
            "includes": set(),  # Populated from tool registrations
        },
        "research": {
            "description": "Observe + web search, database, semantic search, summarize",
            "extends": "observe",
            "includes": set(),
        },
        "develop": {
            "description": "Observe + file writing, editing, bash",
            "extends": "observe",
            "includes": set(),
        },
        "full": {
            "description": "All tools except orchestration",
            "extends": "research",
            "includes": set(),
        },
    }

    # Subagent tool filtering is now handled by `environments` field on ToolDefinition
    # Use get_available_tools("subagent") to get tools available to subagents

    @classmethod
    def initialize(cls, working_dir: Optional[Path] = None) -> None:
        """
        Initialize the registry with pending registrations from decorators.

        Should be called once at daemon startup after all delegate/tool modules
        have been imported.

        Args:
            working_dir: Default working directory for delegates
        """
        if cls._initialized:
            logger.debug("HesterRegistry already initialized")
            return

        # Consume pending registrations from decorators
        pending_delegates, pending_tools = get_pending_registrations()

        for reg in pending_delegates:
            cls._delegates[reg.name] = reg
            logger.debug(f"Registered delegate: {reg.name}")

        for reg in pending_tools:
            cls._tools[reg.name] = reg
            # Add tool to its declared scopes
            for category in reg.categories:
                if category in cls.SCOPES:
                    cls.SCOPES[category]["includes"].add(reg.name)
            logger.debug(f"Registered tool: {reg.name} -> {reg.categories}")

        # Clear pending registrations
        clear_pending_registrations()

        cls._initialized = True
        logger.info(
            f"HesterRegistry initialized: {len(cls._delegates)} delegates, "
            f"{len(cls._tools)} tools"
        )

    @classmethod
    def register_delegate(cls, registration: DelegateRegistration) -> None:
        """
        Manually register a delegate (alternative to decorator).

        Args:
            registration: DelegateRegistration to add
        """
        cls._delegates[registration.name] = registration
        logger.debug(f"Manually registered delegate: {registration.name}")

    @classmethod
    def register_tool(cls, registration: ToolRegistration) -> None:
        """
        Manually register a tool (alternative to decorator).

        Args:
            registration: ToolRegistration to add
        """
        cls._tools[registration.name] = registration
        for category in registration.categories:
            if category in cls.SCOPES:
                cls.SCOPES[category]["includes"].add(registration.name)
        logger.debug(f"Manually registered tool: {registration.name}")

    @classmethod
    def get_delegate(cls, name: str) -> Optional[DelegateRegistration]:
        """
        Get delegate registration by name.

        Args:
            name: Delegate identifier (e.g., "code_explorer")

        Returns:
            DelegateRegistration or None if not found
        """
        return cls._delegates.get(name)

    @classmethod
    def get_tool(cls, name: str) -> Optional[ToolRegistration]:
        """
        Get tool registration by name.

        Args:
            name: Tool identifier (e.g., "read_file")

        Returns:
            ToolRegistration or None if not found
        """
        return cls._tools.get(name)

    @classmethod
    def list_delegates(cls, category: Optional[str] = None) -> List[DelegateRegistration]:
        """
        List all registered delegates, optionally filtered by category.

        Args:
            category: Optional category filter (e.g., "core", "research")

        Returns:
            List of DelegateRegistration objects
        """
        if category:
            return [d for d in cls._delegates.values() if d.category == category]
        return list(cls._delegates.values())

    @classmethod
    def list_tools(cls, scope: Optional[str] = None) -> List[ToolRegistration]:
        """
        List all registered tools, optionally filtered by scope.

        Args:
            scope: Optional scope filter (e.g., "observe", "research")

        Returns:
            List of ToolRegistration objects
        """
        if scope:
            tool_names = cls.get_tools_for_scope(scope)
            return [cls._tools[name] for name in tool_names if name in cls._tools]
        return list(cls._tools.values())

    @classmethod
    def get_tools_for_scope(cls, scope: str, is_subagent: bool = False) -> Set[str]:
        """
        Get tool names available in a given scope.

        Handles scope inheritance (e.g., "research" extends "observe").

        Args:
            scope: Scope name (observe, research, develop, full)
            is_subagent: If True, filters to tools available in "subagent" environment

        Returns:
            Set of tool names available in the scope
        """
        from ..tools.definitions import get_available_tools

        if scope not in cls.SCOPES:
            logger.warning(f"Unknown scope: {scope}, falling back to 'observe'")
            scope = "observe"

        tools: Set[str] = set()
        scope_def = cls.SCOPES[scope]

        # Add tools from extended scope (if any)
        if "extends" in scope_def:
            parent_scope = scope_def["extends"]
            tools.update(cls.get_tools_for_scope(parent_scope, is_subagent=False))

        # Add tools directly in this scope
        tools.update(scope_def.get("includes", set()))

        # Filter to subagent-allowed tools using environment-based system
        if is_subagent:
            subagent_tools = {t.name for t in get_available_tools("subagent")}
            tools &= subagent_tools

        return tools

    @classmethod
    def get_tool_definitions_for_scope(
        cls, scope: str, is_subagent: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Get tool definitions (schemas) for AI function calling.

        Args:
            scope: Scope name
            is_subagent: If True, excludes forbidden tools

        Returns:
            List of tool definition dicts
        """
        tool_names = cls.get_tools_for_scope(scope, is_subagent)
        definitions = []
        for name in tool_names:
            tool = cls._tools.get(name)
            if tool:
                definitions.append(tool.definition)
        return definitions

    @classmethod
    def set_router(cls, router: "SemanticRouter") -> None:
        """
        Set the semantic router for registry lookups.

        Args:
            router: Initialized SemanticRouter instance
        """
        cls._router = router
        logger.debug("SemanticRouter attached to HesterRegistry")

    @classmethod
    def get_router(cls) -> Optional["SemanticRouter"]:
        """
        Get the semantic router for semantic matching.

        Returns:
            SemanticRouter instance or None if not configured
        """
        return cls._router

    @classmethod
    def get_delegate_names(cls) -> List[str]:
        """Get list of all registered delegate names."""
        return list(cls._delegates.keys())

    @classmethod
    def get_tool_names(cls) -> List[str]:
        """Get list of all registered tool names."""
        return list(cls._tools.keys())

    @classmethod
    def is_initialized(cls) -> bool:
        """Check if registry has been initialized."""
        return cls._initialized

    @classmethod
    def reset(cls) -> None:
        """
        Reset registry state. Primarily for testing.
        """
        cls._delegates.clear()
        cls._tools.clear()
        cls._router = None
        cls._initialized = False
        # Reset scope includes
        for scope in cls.SCOPES.values():
            scope["includes"] = set()
        logger.debug("HesterRegistry reset")
