"""
Base classes and registrations for Hester's semantic delegate system.

Provides:
- BaseDelegate: Abstract base class for all task delegates
- DelegateRegistration: Registration metadata for delegates
- ToolRegistration: Registration metadata for tools
- @register_delegate: Decorator for registering delegate classes
- @register_tool: Decorator for registering tool functions
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Type, TYPE_CHECKING

if TYPE_CHECKING:
    from ..tasks.models import TaskBatch

logger = logging.getLogger("hester.daemon.semantic.base")


# =============================================================================
# Registration Data Classes
# =============================================================================


@dataclass
class DelegateRegistration:
    """
    Registration metadata for a delegate class.

    Attributes:
        name: Unique identifier (e.g., "code_explorer", "docs_manager")
        delegate_class: The delegate class to instantiate
        description: Human-readable description for semantic routing
        keywords: Fallback keywords for keyword-based routing
        category: Category grouping (e.g., "core", "research", "develop")
        default_toolset: Default tool scope for this delegate
        default_config: Default configuration values
        embedding: Cached embedding vector (populated at startup)
    """

    name: str
    delegate_class: Type["BaseDelegate"]
    description: str
    keywords: List[str] = field(default_factory=list)
    category: str = "core"
    default_toolset: str = "observe"
    default_config: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[Any] = field(default=None, repr=False)  # np.ndarray

    def __hash__(self) -> int:
        return hash(self.name)


@dataclass
class ToolRegistration:
    """
    Registration metadata for a tool.

    Attributes:
        name: Unique identifier (e.g., "read_file", "web_search")
        definition: Tool schema/definition for AI
        implementation: The actual callable function
        description: Human-readable description for semantic routing
        keywords: Fallback keywords for keyword-based routing
        categories: Set of scopes this tool belongs to
        embedding: Cached embedding vector (populated at startup)
    """

    name: str
    definition: Dict[str, Any]  # Tool schema for function calling
    implementation: Callable
    description: str
    keywords: List[str] = field(default_factory=list)
    categories: Set[str] = field(default_factory=lambda: {"full"})
    embedding: Optional[Any] = field(default=None, repr=False)  # np.ndarray

    def __hash__(self) -> int:
        return hash(self.name)


# =============================================================================
# Base Delegate Abstract Class
# =============================================================================


class BaseDelegate(ABC):
    """
    Abstract base class for all Hester task delegates.

    All delegates must implement:
    - execute(): Standalone operation execution
    - execute_batch(): Batch execution for TaskExecutor integration

    Subclasses should also provide:
    - _format_output(): Format results as markdown
    - _generate_summary(): Generate concise summary for context chaining
    """

    def __init__(self, working_dir: Path, **kwargs):
        """
        Initialize the delegate.

        Args:
            working_dir: Working directory for file operations
            **kwargs: Additional configuration passed from factory
        """
        self.working_dir = Path(working_dir) if isinstance(working_dir, str) else working_dir
        self._config = kwargs
        logger.debug(f"{self.__class__.__name__} initialized: working_dir={working_dir}")

    @abstractmethod
    async def execute(self, **kwargs) -> Dict[str, Any]:
        """
        Execute a standalone operation.

        Args:
            **kwargs: Operation-specific parameters

        Returns:
            Dict with at minimum:
            - success: bool
            - Additional operation-specific fields
        """
        pass

    @abstractmethod
    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch for TaskExecutor integration.

        Args:
            batch: The TaskBatch to execute
            context: Context from previous batches

        Returns:
            Dict with:
            - success: bool
            - output: str (formatted output)
            - summary: str (for context chaining)
        """
        pass

    def _format_output(self, result: Dict[str, Any]) -> str:
        """
        Format operation result as markdown output.

        Override in subclasses for custom formatting.

        Args:
            result: The raw operation result

        Returns:
            Formatted markdown string
        """
        if not result.get("success"):
            return f"**Error:** {result.get('error', 'Unknown error')}"
        return str(result)

    def _generate_summary(self, result: Dict[str, Any]) -> str:
        """
        Generate a concise summary for context chaining.

        Override in subclasses for custom summaries.

        Args:
            result: The raw operation result

        Returns:
            Concise summary string
        """
        if not result.get("success"):
            return f"Operation failed: {result.get('error', 'Unknown error')}"
        return "Operation completed successfully"


# =============================================================================
# Registration Decorators
# =============================================================================


# Registry for pending registrations (populated by decorators, consumed by HesterRegistry)
_pending_delegates: List[DelegateRegistration] = []
_pending_tools: List[ToolRegistration] = []


def register_delegate(
    name: str,
    description: str,
    keywords: Optional[List[str]] = None,
    category: str = "core",
    default_toolset: str = "observe",
    default_config: Optional[Dict[str, Any]] = None,
) -> Callable[[Type[BaseDelegate]], Type[BaseDelegate]]:
    """
    Decorator to register a delegate class with HesterRegistry.

    Usage:
        @register_delegate(
            name="code_explorer",
            description="Search and analyze source code files.",
            keywords=["code", "file", "function", "class"],
            category="core",
            default_toolset="research",
        )
        class CodeExplorerDelegate(BaseDelegate):
            ...

    Args:
        name: Unique identifier for this delegate
        description: Human-readable description for semantic routing
        keywords: Fallback keywords for keyword-based routing
        category: Category grouping
        default_toolset: Default tool scope
        default_config: Default configuration values

    Returns:
        Decorator function
    """

    def decorator(cls: Type[BaseDelegate]) -> Type[BaseDelegate]:
        if not issubclass(cls, BaseDelegate):
            raise TypeError(f"{cls.__name__} must inherit from BaseDelegate")

        registration = DelegateRegistration(
            name=name,
            delegate_class=cls,
            description=description,
            keywords=keywords or [],
            category=category,
            default_toolset=default_toolset,
            default_config=default_config or {},
        )

        _pending_delegates.append(registration)
        logger.debug(f"Registered delegate: {name} ({cls.__name__})")

        # Also store registration on the class for introspection
        cls._registration = registration  # type: ignore

        return cls

    return decorator


def register_tool(
    name: str,
    description: str,
    definition: Dict[str, Any],
    keywords: Optional[List[str]] = None,
    categories: Optional[Set[str]] = None,
) -> Callable[[Callable], Callable]:
    """
    Decorator to register a tool function with HesterRegistry.

    Usage:
        @register_tool(
            name="read_file",
            description="Read the contents of a file from the filesystem.",
            definition={
                "name": "read_file",
                "description": "Read file contents",
                "parameters": {...}
            },
            keywords=["read", "file", "content", "cat"],
            categories={"observe", "research", "develop", "full"},
        )
        async def read_file(path: str, ...) -> Dict[str, Any]:
            ...

    Args:
        name: Unique identifier for this tool
        description: Human-readable description for semantic routing
        definition: Tool schema for function calling
        keywords: Fallback keywords for keyword-based routing
        categories: Set of scopes this tool belongs to

    Returns:
        Decorator function
    """

    def decorator(func: Callable) -> Callable:
        registration = ToolRegistration(
            name=name,
            definition=definition,
            implementation=func,
            description=description,
            keywords=keywords or [],
            categories=categories or {"full"},
        )

        _pending_tools.append(registration)
        logger.debug(f"Registered tool: {name}")

        # Also store registration on the function for introspection
        func._registration = registration  # type: ignore

        return func

    return decorator


def get_pending_registrations() -> tuple[List[DelegateRegistration], List[ToolRegistration]]:
    """
    Get all pending registrations from decorators.

    Called by HesterRegistry.initialize() to consume decorator registrations.

    Returns:
        Tuple of (delegates, tools) pending registration lists
    """
    return _pending_delegates.copy(), _pending_tools.copy()


def clear_pending_registrations() -> None:
    """
    Clear pending registrations after they've been consumed.

    Called by HesterRegistry.initialize() after processing.
    """
    _pending_delegates.clear()
    _pending_tools.clear()
