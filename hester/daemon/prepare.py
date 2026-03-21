"""
FunctionGemma Prepare Step - Lightweight preprocessing for the ReAct loop.

Uses FunctionGemma (270M params) via Ollama to:
1. Classify thinking depth when not explicitly provided
2. Select relevant tools from the 50+ available tools
3. Detect if request is a task vs question
4. Classify task type (feature, bugfix, refactor, test)
5. Per-batch prepare for task execution

Reduces Gemini token usage and provides faster classification.
"""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Any, Tuple, Callable, TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from .registries import PromptRegistry

from .thinking_depth import ThinkingDepth, DepthClassification, classify_complexity
from .tools.base import HESTER_TOOLS, ToolDefinition, get_available_tools

# Optional import for semantic routing (may not be initialized)
try:
    from .semantic import SemanticRouter
except ImportError:
    SemanticRouter = None  # type: ignore

# Optional import for bespoke agent registries
try:
    from .registries import (
        get_prompt_registry,
        get_agent_registry,
        PromptMatch,
        AgentMatch,
        ThinkingTier,
    )
    REGISTRIES_AVAILABLE = True
except ImportError:
    REGISTRIES_AVAILABLE = False
    get_prompt_registry = None  # type: ignore
    get_agent_registry = None  # type: ignore
    PromptMatch = None  # type: ignore
    AgentMatch = None  # type: ignore
    ThinkingTier = None  # type: ignore

# Optional import for embedding service
try:
    from .semantic.embeddings import EmbeddingService
except ImportError:
    EmbeddingService = None  # type: ignore

logger = logging.getLogger("hester.daemon.prepare")


# ============================================================================
# Shortcut Detection - Fast programmatic handling of simple commands
# ============================================================================

class ShortcutType(str, Enum):
    """Type of shortcut detected."""
    TOOL = "tool"  # Execute a tool directly (cd, ls, cat)
    CLI = "cli"  # Execute a Hester CLI command (hester db tables)
    SLASH = "slash"  # Execute a TUI slash command (/status, /tasks)


@dataclass
class ShortcutResult:
    """Result of shortcut detection for simple commands."""
    is_shortcut: bool
    shortcut_type: Optional[ShortcutType] = None
    tool_name: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    cli_command: Optional[List[str]] = None  # For CLI commands: ["db", "tables"]
    slash_command: Optional[str] = None  # For slash commands: "status"
    reason: str = ""


# Patterns for shortcut detection (processed before FunctionGemma)
# Type annotation uses Callable, initialized below
SHORTCUT_PATTERNS: List[Tuple[re.Pattern, str, Callable]] = []  # Populated by _init_shortcut_patterns()


def _extract_cd_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract arguments for change_directory from a cd command."""
    path = match.group(1).strip()
    # Remove quotes if present
    if (path.startswith('"') and path.endswith('"')) or (path.startswith("'") and path.endswith("'")):
        path = path[1:-1]
    return {"path": path}


def _extract_ls_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract arguments for list_directory from an ls command."""
    args = {}

    # Check for -a flag in the original message
    if " -a" in message or " --all" in message:
        args["show_hidden"] = True

    # Try to get path from group 2 (the path after optional flags)
    # Fall back to group 1 if only 1 group captured
    path = None
    try:
        if match.lastindex and match.lastindex >= 2:
            path = match.group(2)
        elif match.lastindex and match.lastindex >= 1:
            path = match.group(1)
    except IndexError:
        pass

    if path and path.strip():
        path = path.strip()
        # Remove quotes if present
        if (path.startswith('"') and path.endswith('"')) or (path.startswith("'") and path.endswith("'")):
            path = path[1:-1]
        # Filter out flags from path - they're not actual paths
        path_parts = [p for p in path.split() if not p.startswith('-')]
        if path_parts:
            args["path"] = ' '.join(path_parts)

    return args


def _extract_cat_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract arguments for read_file from a cat command."""
    path = match.group(1).strip()
    # Remove quotes if present
    if (path.startswith('"') and path.endswith('"')) or (path.startswith("'") and path.endswith("'")):
        path = path[1:-1]
    return {"file_path": path}


def _extract_pwd_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract arguments for list_directory (current dir)."""
    return {}  # No path means current directory


# Initialize shortcut patterns
def _init_shortcut_patterns() -> List[Tuple[re.Pattern, str, Callable]]:
    """Initialize the shortcut patterns list."""
    return [
        # cd command variants - use .+? and allow optional trailing slash
        (re.compile(r"^cd\s+(.+?)/?$", re.IGNORECASE), "change_directory", _extract_cd_args),
        (re.compile(r"^chdir\s+(.+?)/?$", re.IGNORECASE), "change_directory", _extract_cd_args),
        (re.compile(r"^go\s+to\s+(.+?)/?$", re.IGNORECASE), "change_directory", _extract_cd_args),
        (re.compile(r"^change\s+(?:directory|dir|folder)\s+(?:to\s+)?(.+?)/?$", re.IGNORECASE), "change_directory", _extract_cd_args),
        (re.compile(r"^navigate\s+to\s+(.+?)/?$", re.IGNORECASE), "change_directory", _extract_cd_args),

        # ls command variants - use word boundary or optional path-like args only
        # Don't match natural language like "list the files and explain"
        (re.compile(r"^ls(?:\s+(-[a-z]+\s*)*([./\w-]*))?$", re.IGNORECASE), "list_directory", _extract_ls_args),
        (re.compile(r"^dir(?:\s+(-[a-z]+\s*)*([./\w-]*))?$", re.IGNORECASE), "list_directory", _extract_ls_args),
        # "list" only with no args or simple path, not "list the files"
        (re.compile(r"^list$", re.IGNORECASE), "list_directory", _extract_ls_args),

        # cat/read command variants - only match file-path-like strings
        # Path pattern: starts with ./ or ../ or / or contains / or has file extension
        # Also match quoted paths. Excludes natural language like "show me the X"
        (re.compile(r'^cat\s+(["\']?.+["\']?)$', re.IGNORECASE), "read_file", _extract_cat_args),
        # For read/show/view/open, require path-like pattern to avoid "show me X", "read about Y"
        # Match: ./file, ../file, /path, file.ext, path/to/file, "quoted path"
        (re.compile(r'^read\s+(["\'][^"\']+["\']|\.{1,2}/\S+|/\S+|\S+\.\w+|\S+/\S+)$', re.IGNORECASE), "read_file", _extract_cat_args),
        (re.compile(r'^show\s+(["\'][^"\']+["\']|\.{1,2}/\S+|/\S+|\S+\.\w+|\S+/\S+)$', re.IGNORECASE), "read_file", _extract_cat_args),
        (re.compile(r'^view\s+(["\'][^"\']+["\']|\.{1,2}/\S+|/\S+|\S+\.\w+|\S+/\S+)$', re.IGNORECASE), "read_file", _extract_cat_args),
        (re.compile(r'^open\s+(["\'][^"\']+["\']|\.{1,2}/\S+|/\S+|\S+\.\w+|\S+/\S+)$', re.IGNORECASE), "read_file", _extract_cat_args),

        # pwd command
        (re.compile(r"^pwd$", re.IGNORECASE), "list_directory", _extract_pwd_args),
        (re.compile(r"^where\s+am\s+i\??$", re.IGNORECASE), "list_directory", _extract_pwd_args),
        (re.compile(r"^current\s+(?:directory|dir|folder)\??$", re.IGNORECASE), "list_directory", _extract_pwd_args),
    ]


SHORTCUT_PATTERNS = _init_shortcut_patterns()


def detect_shortcut(message: str) -> ShortcutResult:
    """
    Detect if a message is a simple shortcut command that can be executed directly.

    This runs BEFORE FunctionGemma to handle simple, well-defined commands
    like 'cd ../', 'ls', 'cat file.py' without the overhead of LLM inference.

    Supports three types of shortcuts:
    1. TOOL shortcuts: cd, ls, cat, pwd -> execute tool directly
    2. CLI shortcuts: hester db tables, db query -> execute Hester CLI
    3. SLASH shortcuts: /status, /tasks, /session -> execute TUI command

    Args:
        message: The user's message

    Returns:
        ShortcutResult indicating if this is a shortcut and what to execute
    """
    # Clean up message
    cleaned = message.strip()

    # Skip if message is too long (likely not a simple command)
    if len(cleaned) > 200:
        return ShortcutResult(is_shortcut=False, reason="Message too long for shortcut")

    # Check for slash commands first (highest priority)
    slash_result = _detect_slash_command(cleaned)
    if slash_result.is_shortcut:
        return slash_result

    # Check for Hester CLI commands
    cli_result = _detect_cli_command(cleaned)
    if cli_result.is_shortcut:
        return cli_result

    # Skip if message contains question marks (questions should go through ReAct)
    # or too many commas (complex lists), but allow multiple dots for paths like ../
    if '?' in cleaned or cleaned.count(',') > 2:
        return ShortcutResult(is_shortcut=False, reason="Message too complex for shortcut")

    # Skip if has sentence-like structure (multiple sentences with periods not in paths)
    # Path-like dots: ../, ./file, /path/to/file.ext
    non_path_dots = re.sub(r'\.\.|\./|\.\w+$', '', cleaned).count('.')
    if non_path_dots > 1:
        return ShortcutResult(is_shortcut=False, reason="Message too complex for shortcut")

    # Try file/directory tool patterns
    for pattern, tool_name, extract_fn in SHORTCUT_PATTERNS:
        match = pattern.match(cleaned)
        if match:
            try:
                args = extract_fn(match, cleaned)
                return ShortcutResult(
                    is_shortcut=True,
                    shortcut_type=ShortcutType.TOOL,
                    tool_name=tool_name,
                    tool_args=args,
                    reason=f"Matched shortcut pattern for {tool_name}",
                )
            except Exception as e:
                logger.debug(f"Shortcut extraction failed for {tool_name}: {e}")
                continue

    return ShortcutResult(is_shortcut=False, reason="No shortcut pattern matched")


# ============================================================================
# Slash Command Detection (/status, /tasks, /session, etc.)
# ============================================================================

# Slash commands that can be executed as shortcuts
SLASH_COMMANDS = {
    "/help": {"description": "Show help information"},
    "/status": {"description": "Show daemon status"},
    "/session": {"description": "Show session ID"},
    "/pwd": {"description": "Show working directory"},
    "/tasks": {"description": "List all tasks"},
    "/task": {"description": "View task details", "has_arg": True},
    "/clear": {"description": "Clear conversation history"},
}


def _detect_slash_command(message: str) -> ShortcutResult:
    """Detect if message is a slash command."""
    if not message.startswith('/'):
        return ShortcutResult(is_shortcut=False)

    # Parse command and optional argument
    parts = message.split(None, 1)
    cmd = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else None

    if cmd in SLASH_COMMANDS:
        return ShortcutResult(
            is_shortcut=True,
            shortcut_type=ShortcutType.SLASH,
            slash_command=cmd,
            tool_args={"arg": arg} if arg else {},
            reason=f"Slash command: {cmd}",
        )

    return ShortcutResult(is_shortcut=False, reason="Unknown slash command")


# ============================================================================
# CLI Command Detection (hester db tables, db query, devops status, etc.)
# ============================================================================

# CLI command patterns - maps patterns to CLI command lists
# Format: (regex_pattern, cli_command_list, optional_args_extractor)
CLI_COMMAND_PATTERNS: List[Tuple[re.Pattern, List[str], Optional[Callable]]] = []


def _extract_db_query_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract args for db query command."""
    query = match.group(1).strip()
    # Remove quotes if present
    if (query.startswith('"') and query.endswith('"')) or (query.startswith("'") and query.endswith("'")):
        query = query[1:-1]
    return {"query": query}


def _extract_db_describe_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract args for db describe command."""
    table = match.group(1).strip()
    return {"table": table}


def _extract_db_count_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract args for db count command."""
    table = match.group(1).strip()
    return {"table": table}


def _extract_devops_logs_args(match: re.Match, message: str) -> Dict[str, Any]:
    """Extract args for devops logs command."""
    service = match.group(1).strip()
    return {"service": service}


def _init_cli_command_patterns() -> List[Tuple[re.Pattern, List[str], Optional[Callable]]]:
    """Initialize CLI command patterns."""
    return [
        # Database commands
        (re.compile(r"^(?:hester\s+)?db\s+tables$", re.IGNORECASE), ["db", "tables"], None),
        (re.compile(r"^(?:hester\s+)?db\s+functions$", re.IGNORECASE), ["db", "functions"], None),
        (re.compile(r"^(?:hester\s+)?db\s+describe\s+(\w+)$", re.IGNORECASE), ["db", "describe"], _extract_db_describe_args),
        (re.compile(r"^(?:hester\s+)?db\s+count\s+(\w+)$", re.IGNORECASE), ["db", "count"], _extract_db_count_args),
        (re.compile(r"^(?:hester\s+)?db\s+query\s+[\"']?(.+?)[\"']?$", re.IGNORECASE), ["db", "query"], _extract_db_query_args),

        # Daemon commands
        (re.compile(r"^(?:hester\s+)?daemon\s+status$", re.IGNORECASE), ["daemon", "status"], None),

        # DevOps commands
        (re.compile(r"^(?:hester\s+)?devops\s+status$", re.IGNORECASE), ["devops", "status"], None),
        (re.compile(r"^(?:hester\s+)?devops\s+health$", re.IGNORECASE), ["devops", "health"], None),
        (re.compile(r"^(?:hester\s+)?devops\s+docker$", re.IGNORECASE), ["devops", "docker"], None),
        (re.compile(r"^(?:hester\s+)?devops\s+ps$", re.IGNORECASE), ["devops", "ps"], None),
        (re.compile(r"^(?:hester\s+)?devops\s+logs\s+(\w+)$", re.IGNORECASE), ["devops", "logs"], _extract_devops_logs_args),

        # Docs commands
        (re.compile(r"^(?:hester\s+)?docs\s+index-status$", re.IGNORECASE), ["docs", "index-status"], None),

        # QA commands
        (re.compile(r"^(?:hester\s+)?qa\s+list-scenes$", re.IGNORECASE), ["qa", "list-scenes"], None),
        (re.compile(r"^(?:hester\s+)?qa\s+list-personas$", re.IGNORECASE), ["qa", "list-personas"], None),
    ]


CLI_COMMAND_PATTERNS = _init_cli_command_patterns()


def _detect_cli_command(message: str) -> ShortcutResult:
    """Detect if message is a Hester CLI command."""
    for pattern, cli_cmd, extract_fn in CLI_COMMAND_PATTERNS:
        match = pattern.match(message)
        if match:
            args = {}
            if extract_fn:
                try:
                    args = extract_fn(match, message)
                except Exception as e:
                    logger.debug(f"CLI arg extraction failed: {e}")
                    continue

            return ShortcutResult(
                is_shortcut=True,
                shortcut_type=ShortcutType.CLI,
                cli_command=cli_cmd,
                tool_args=args,
                reason=f"CLI command: {' '.join(cli_cmd)}",
            )

    return ShortcutResult(is_shortcut=False, reason="Not a CLI command")


# Core tools always included as fallback
CORE_TOOLS = {"read_file", "search_files", "search_content", "list_directory"}

# Task-related tools
TASK_TOOLS = {"create_task", "get_task", "update_task", "list_tasks", "add_batch", "add_context", "mark_task_ready"}


def get_task_tools_for_environment(environment: str = "daemon") -> List[str]:
    """
    Get task tools filtered by environment.

    Task tools have environments={"daemon", "cli"} and should NOT be available
    in Slack, subagent, or other restricted environments.

    Args:
        environment: Runtime environment (daemon, cli, slack, subagent, etc.)

    Returns:
        List of task tool names available in the environment
    """
    available = get_available_tools(environment)
    available_names = {t.name for t in available}
    return [t for t in TASK_TOOLS if t in available_names]


class RequestType(str, Enum):
    """Classification of user request type."""
    QUESTION = "question"  # Direct answer needed
    TASK = "task"  # Multi-step work required


class TaskType(str, Enum):
    """Classification of task type."""
    FEATURE = "feature"  # New functionality
    BUGFIX = "bugfix"  # Fix a bug
    REFACTOR = "refactor"  # Improve existing code
    TEST = "test"  # Write tests
    RESEARCH = "research"  # Investigation/exploration
    DOCS = "docs"  # Documentation
    CONFIG = "config"  # Configuration changes

# FunctionGemma output parsing patterns
FUNCTION_CALL_PATTERN = re.compile(
    r"<start_function_call>call:(\w+)\{(.+?)\}<end_function_call>",
    re.DOTALL
)

# Routing override patterns
# #prompt_name - explicit prompt override (e.g., #scene, #research, #code_analysis)
# @agent_name - explicit agent override (e.g., @scene_developer, @web_researcher)
PROMPT_OVERRIDE_PATTERN = re.compile(r"#(\w+)")
AGENT_OVERRIDE_PATTERN = re.compile(r"@(\w+)")


@dataclass
class RoutingOverride:
    """Result from parsing routing overrides in user message."""
    explicit_prompt_id: Optional[str] = None  # From #prompt syntax
    explicit_agent_id: Optional[str] = None   # From @agent syntax
    cleaned_message: str = ""                 # Message with overrides stripped


def parse_routing_overrides(message: str) -> RoutingOverride:
    """
    Parse routing override prefixes from message.

    Supports:
    - #prompt_name - Select a specific prompt (e.g., #scene, #research)
    - @agent_name - Select a specific agent (e.g., @scene_developer, @web_researcher)

    Only the FIRST match of each type is used. Overrides are stripped from
    the beginning of the message only.

    Args:
        message: User message that may contain routing overrides

    Returns:
        RoutingOverride with explicit IDs and cleaned message
    """
    result = RoutingOverride(cleaned_message=message)
    remaining = message.strip()

    # Check for prompt override at start: #prompt_name
    prompt_match = PROMPT_OVERRIDE_PATTERN.match(remaining)
    if prompt_match:
        result.explicit_prompt_id = prompt_match.group(1).lower()
        remaining = remaining[prompt_match.end():].strip()
        logger.info(f"Prompt override detected: #{result.explicit_prompt_id}")

    # Check for agent override at start: @agent_name
    agent_match = AGENT_OVERRIDE_PATTERN.match(remaining)
    if agent_match:
        result.explicit_agent_id = agent_match.group(1).lower()
        remaining = remaining[agent_match.end():].strip()
        logger.info(f"Agent override detected: @{result.explicit_agent_id}")

    # Also check if message started with @ (agent first, then prompt)
    if not result.explicit_agent_id and not result.explicit_prompt_id:
        agent_match = AGENT_OVERRIDE_PATTERN.match(message.strip())
        if agent_match:
            result.explicit_agent_id = agent_match.group(1).lower()
            remaining = message.strip()[agent_match.end():].strip()
            logger.info(f"Agent override detected: @{result.explicit_agent_id}")

            # Check for prompt override after agent
            prompt_match = PROMPT_OVERRIDE_PATTERN.match(remaining)
            if prompt_match:
                result.explicit_prompt_id = prompt_match.group(1).lower()
                remaining = remaining[prompt_match.end():].strip()
                logger.info(f"Prompt override detected: #{result.explicit_prompt_id}")

    result.cleaned_message = remaining
    return result


@dataclass
class PrepareResult:
    """Result from the FunctionGemma prepare step."""
    thinking_depth: ThinkingDepth
    relevant_tools: List[str]
    confidence: float
    used_fallback: bool
    reason: str
    prepare_time_ms: float = 0.0
    # Task detection fields (optional)
    request_type: Optional[RequestType] = None
    task_type: Optional[TaskType] = None

    # Hybrid routing fields (from FunctionGemma)
    use_local_think: bool = False  # Whether to use local model for THINK phase
    think_model: Optional[str] = None  # "gemma3-4b", "gemma3-12b", or None (cloud)

    # Bespoke agent routing fields
    prompt_id: str = "general"  # Selected prompt from registry
    agent_id: Optional[str] = None  # Matched pre-bundled agent (if any)
    toolset_id: Optional[str] = None  # Named toolset (if agent matched)
    prompt_match: Optional[Any] = None  # PromptMatch details
    agent_match: Optional[Any] = None  # AgentMatch details
    observe_model: Optional[str] = None  # Model for OBSERVE phase, defaults to "gemma3-4b"
    routing_reason: str = ""  # Why this routing was chosen

    # Explicit routing overrides (from #prompt and @agent syntax)
    explicit_prompt_id: Optional[str] = None  # User specified #prompt override
    explicit_agent_id: Optional[str] = None   # User specified @agent override


@dataclass
class TaskDetectionResult:
    """Result from task detection."""
    request_type: RequestType
    task_type: Optional[TaskType]  # Only set if request_type == TASK
    confidence: float
    reason: str
    suggested_tools: List[str] = field(default_factory=list)
    prepare_time_ms: float = 0.0


@dataclass
class BatchPrepareResult:
    """Result from per-batch prepare step."""
    thinking_depth: ThinkingDepth
    relevant_tools: List[str]
    tool_hints: str  # Natural language hints for Claude Code
    estimated_complexity: str  # "simple", "moderate", "complex"
    confidence: float
    prepare_time_ms: float = 0.0


class OllamaFunctionGemma:
    """
    Client for FunctionGemma via Ollama.

    FunctionGemma is a 270M parameter model fine-tuned for function calling.
    It runs locally via Ollama for fast (<100ms) inference.

    Uses /api/chat with tools parameter instead of /api/generate, because
    FunctionGemma's Modelfile has RENDERER/PARSER directives that intercept
    raw text output — /api/generate always returns empty response fields.
    The /api/chat endpoint returns proper tool_calls instead.
    """

    DEFAULT_OLLAMA_URL = "http://localhost:11434"
    MODEL_NAME = "functiongemma"  # Requires: ollama pull functiongemma

    def __init__(
        self,
        ollama_url: Optional[str] = None,
        timeout: float = 2.0,  # Fast timeout for prepare step
    ):
        self.ollama_url = ollama_url or self.DEFAULT_OLLAMA_URL
        self.timeout = timeout
        self._available: Optional[bool] = None

    async def is_available(self) -> bool:
        """Check if Ollama and FunctionGemma are available."""
        if self._available is not None:
            return self._available

        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                response = await client.get(f"{self.ollama_url}/api/tags")
                if response.status_code == 200:
                    models = response.json().get("models", [])
                    self._available = any(
                        m.get("name", "").startswith(self.MODEL_NAME)
                        for m in models
                    )
                else:
                    self._available = False
        except Exception as e:
            logger.debug(f"Ollama not available: {e}")
            self._available = False

        return self._available

    async def chat_with_tools(
        self,
        messages: List[Dict[str, str]],
        tools: List[Dict[str, Any]],
        temperature: float = 0.1,
    ) -> Optional[Dict[str, Any]]:
        """
        Call FunctionGemma via /api/chat with tool definitions.

        Returns the first tool_call from the response, or None if the model
        didn't call a tool or the request failed.

        Returns:
            Dict with 'name' and 'arguments' keys, or None
        """
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                payload = {
                    "model": self.MODEL_NAME,
                    "messages": messages,
                    "tools": tools,
                    "stream": False,
                    "options": {
                        "temperature": temperature,
                        "num_predict": 256,
                    }
                }

                response = await client.post(
                    f"{self.ollama_url}/api/chat",
                    json=payload,
                )

                if response.status_code == 200:
                    data = response.json()
                    msg = data.get("message", {})
                    tool_calls = msg.get("tool_calls", [])
                    if tool_calls:
                        call = tool_calls[0]
                        fn = call.get("function", {})
                        return {
                            "name": fn.get("name", ""),
                            "arguments": fn.get("arguments", {}),
                        }
                    # No tool call — check if there's text content as fallback
                    content = msg.get("content", "").strip()
                    if content:
                        logger.debug(f"FunctionGemma returned text instead of tool_call: {content[:100]}")

        except asyncio.TimeoutError:
            logger.debug("FunctionGemma timed out")
        except Exception as e:
            logger.debug(f"FunctionGemma error: {e}")

        return None

    async def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional[str]:
        """
        Generate response from FunctionGemma using /api/chat with tools.

        For backwards compatibility, returns a synthetic function call string
        that parse_function_call() can parse. If tools are provided, uses
        chat_with_tools and converts the result.

        Returns None if generation fails or times out.
        """
        if not tools:
            # Build default prepare_request tool
            tools = [PREPARE_REQUEST_TOOL]

        messages = [{"role": "user", "content": prompt}]
        if system:
            messages.insert(0, {"role": "system", "content": system})

        result = await self.chat_with_tools(messages, tools, temperature=0.1)
        if result:
            # Convert tool_call back to the function call format for parse_function_call()
            name = result["name"]
            args = result["arguments"]
            # Build key-value string: key:<escape>value<escape>
            kv_parts = []
            for k, v in args.items():
                kv_parts.append(f"{k}:<escape>{v}<escape>")
            args_str = ",".join(kv_parts)
            return f"<start_function_call>call:{name}{{{args_str}}}<end_function_call>"

        return None

    async def classify(
        self,
        prompt: str,
        options: List[str],
        timeout: float = 2.0,
    ) -> Optional[str]:
        """
        Classify input into one of the given options.

        Uses FunctionGemma with a classify tool that has an enum parameter.
        Returns None if classification fails or response doesn't match options.
        """
        classify_tool = {
            "type": "function",
            "function": {
                "name": "classify",
                "description": "Classify the input into one of the given categories.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "description": "The selected category",
                            "enum": options,
                        }
                    },
                    "required": ["category"],
                },
            },
        }

        messages = [{"role": "user", "content": prompt}]

        try:
            old_timeout = self.timeout
            self.timeout = timeout
            result = await self.chat_with_tools(messages, [classify_tool], temperature=0.0)
            self.timeout = old_timeout

            if result and result["name"] == "classify":
                category = result["arguments"].get("category", "")
                # Validate against options
                for option in options:
                    if category.lower() == option.lower():
                        return option
                logger.debug(f"FunctionGemma classification result '{category}' not in options {options}")

        except Exception as e:
            logger.debug(f"FunctionGemma classification error: {e}")

        return None


# Ollama tool definitions for FunctionGemma /api/chat
PREPARE_REQUEST_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "prepare_request",
        "description": "Classify the thinking depth and select relevant tools for a user query.",
        "parameters": {
            "type": "object",
            "properties": {
                "depth": {
                    "type": "string",
                    "description": "Thinking depth needed: QUICK for greetings/simple, STANDARD for single-file reads, DEEP for multi-file analysis, REASONING for debugging/design.",
                    "enum": ["QUICK", "STANDARD", "DEEP", "REASONING"],
                },
                "tools": {
                    "type": "string",
                    "description": "Comma-separated list of relevant tool names, or NONE for simple greetings.",
                },
                "use_local": {
                    "type": "string",
                    "description": "Whether local models can handle initial reasoning. true for simple lookups, false for complex multi-step tasks.",
                    "enum": ["true", "false"],
                },
                "think_model": {
                    "type": "string",
                    "description": "Local model for thinking phase.",
                    "enum": ["gemma3-4b", "gemma3-12b", "none"],
                },
                "observe_model": {
                    "type": "string",
                    "description": "Local model for observing tool results.",
                    "enum": ["gemma3-4b", "gemma3-12b"],
                },
            },
            "required": ["depth", "tools"],
        },
    },
}

PREPARE_BATCH_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "prepare_batch",
        "description": "Classify the thinking depth, select tools, and estimate complexity for a task batch.",
        "parameters": {
            "type": "object",
            "properties": {
                "depth": {
                    "type": "string",
                    "description": "Thinking depth needed.",
                    "enum": ["QUICK", "STANDARD", "DEEP", "REASONING"],
                },
                "tools": {
                    "type": "string",
                    "description": "Comma-separated list of relevant tool names.",
                },
                "complexity": {
                    "type": "string",
                    "description": "Estimated complexity of the batch.",
                    "enum": ["simple", "moderate", "complex"],
                },
                "hints": {
                    "type": "string",
                    "description": "Brief natural language hints for the executor (max 100 chars).",
                },
            },
            "required": ["depth", "tools", "complexity"],
        },
    },
}

DETECT_TASK_TOOL: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "detect_task",
        "description": "Classify whether the user request is a question or a task, and identify the task type.",
        "parameters": {
            "type": "object",
            "properties": {
                "request_type": {
                    "type": "string",
                    "description": "QUESTION for direct answers, TASK for multi-step work.",
                    "enum": ["question", "task"],
                },
                "task_type": {
                    "type": "string",
                    "description": "Type of task, or NONE if this is a question.",
                    "enum": ["feature", "bugfix", "refactor", "test", "research", "docs", "config", "NONE"],
                },
            },
            "required": ["request_type", "task_type"],
        },
    },
}


def get_tool_summaries(environment: str = "daemon") -> str:
    """
    Generate condensed tool summaries for FunctionGemma context.

    Args:
        environment: Runtime environment (lee, daemon, cli, tui, slack, agent)

    Format: name: one-line description (max 80 chars)
    """
    lines = []
    available_tools = get_available_tools(environment)
    for tool in available_tools:
        # Extract first sentence of description
        desc = tool.description.split('\n')[0].strip()
        if len(desc) > 80:
            desc = desc[:77] + "..."
        lines.append(f"{tool.name}: {desc}")
    return "\n".join(lines)


def build_prepare_prompt(
    message: str,
    file_context: Optional[str] = None,
    hybrid_routing_enabled: bool = True,
    environment: str = "daemon",
) -> str:
    """
    Build the prompt for FunctionGemma.

    Args:
        message: User's query
        file_context: Optional active file path
        hybrid_routing_enabled: Whether to include routing info
        environment: Runtime environment (lee, daemon, cli, tui, slack, agent)

    Returns a prompt that asks FunctionGemma to:
    1. Classify the thinking depth needed
    2. Select relevant tools for the query
    3. Recommend local vs cloud model routing (if hybrid enabled)
    """
    tool_summaries = get_tool_summaries(environment)

    context_hint = ""
    if file_context:
        context_hint = f"\nUser is viewing file: {file_context}"

    # Base routing fields for hybrid mode
    routing_fields = ""
    routing_rules = ""
    if hybrid_routing_enabled:
        routing_fields = ",use_local:<escape>true|false<escape>,think_model:<escape>MODEL<escape>,observe_model:<escape>MODEL<escape>"
        routing_rules = """
Routing rules (use_local):
- true: Simple lookups, single file reads, basic questions, 1-2 tools
- false: Multi-step reasoning, debugging, architecture, 3+ tools, complex synthesis

Model selection (for think_model and observe_model):
- gemma3-4b: Fast (~100-200ms), simple parsing, basic tasks, short outputs
- gemma3-12b: Best quality (~300-500ms), complex output parsing, multi-file reasoning
- none: (think_model only) Use cloud Gemini

Observe model hints:
- gemma3-4b: Simple file reads, short outputs, single results, structured data
- gemma3-12b: Large diffs, stack traces, complex JSON, multi-file outputs
"""

    return f"""Analyze this user query and determine:
1. What thinking depth is needed (QUICK, STANDARD, DEEP, or REASONING)
2. Which tools are relevant for answering this query
3. Whether local models can handle initial reasoning

User query: {message}{context_hint}

Available tools:
{tool_summaries}

Respond with a function call using this format:
<start_function_call>call:prepare_request{{depth:<escape>DEPTH<escape>,tools:<escape>tool1,tool2,tool3<escape>{routing_fields}}}<end_function_call>

Where DEPTH is one of: QUICK, STANDARD, DEEP, REASONING
And tools is a comma-separated list of relevant tool names.

Rules:
- QUICK: Greetings, simple questions, yes/no answers - often needs NO tools
- STANDARD: Single file reads, basic searches, simple queries
- DEEP: Multi-file analysis, architecture questions, comparisons
- REASONING: Debugging, design decisions, complex investigations

Only select tools that are directly relevant to the query. Select NONE for simple greetings.
{routing_rules}"""


def parse_function_call(response: str) -> Optional[Dict[str, str]]:
    """
    Parse FunctionGemma's function call response.

    Expected format:
    <start_function_call>call:prepare_request{depth:<escape>VALUE<escape>,tools:<escape>VALUES<escape>}<end_function_call>
    """
    match = FUNCTION_CALL_PATTERN.search(response)
    if not match:
        return None

    func_name = match.group(1)
    args_str = match.group(2)

    if func_name != "prepare_request":
        return None

    # Parse the key-value pairs
    result = {}
    # Pattern for: key:<escape>value<escape>
    kv_pattern = re.compile(r"(\w+):<escape>(.+?)<escape>")
    for m in kv_pattern.finditer(args_str):
        result[m.group(1)] = m.group(2)

    return result


def validate_tools(tool_names: List[str], environment: str = "daemon") -> List[str]:
    """
    Validate and filter tool names against known tools.

    Args:
        tool_names: List of tool names to validate
        environment: Runtime environment (lee, daemon, cli, tui, slack, agent)

    Returns only valid tool names (excluding Lee-only tools if not connected).
    """
    available_tools = get_available_tools(environment)
    valid_tools = {t.name for t in available_tools}
    return [t for t in tool_names if t in valid_tools]


def parse_depth(depth_str: str) -> Optional[ThinkingDepth]:
    """Parse depth string to ThinkingDepth enum."""
    depth_map = {
        "QUICK": ThinkingDepth.QUICK,
        "STANDARD": ThinkingDepth.STANDARD,
        "DEEP": ThinkingDepth.DEEP,
        "REASONING": ThinkingDepth.REASONING,
    }
    return depth_map.get(depth_str.upper())


# =============================================================================
# Bespoke Agent Routing
# =============================================================================

async def _route_bespoke_agent(
    message: str,
    embedding_service: Optional["EmbeddingService"],
    use_bespoke_routing: bool,
    ollama_client: Optional[OllamaFunctionGemma] = None,
) -> Dict[str, Any]:
    """
    Route a message to a bespoke agent configuration using registries.

    This is Phase 1 of prepare_request - it determines which prompt
    and toolset to use based on semantic similarity matching.

    Strategy:
    1. Check for pre-bundled agent match (e.g., code_explorer, db_explorer)
    2. If agent matches: use its prompt, toolset, and model tier
    3. If no agent matches: route to best prompt and build bespoke config

    Args:
        message: User's message to route
        embedding_service: Optional embedding service for semantic matching
        use_bespoke_routing: Whether to use registry-based routing
        ollama_client: Optional Ollama client for meta-prompt classification

    Returns:
        Dict containing:
        - prompt_id: ID of selected prompt
        - agent_id: ID of matched agent (or None)
        - toolset_id: ID of toolset (if agent matched)
        - tools: List of tool names (if agent matched)
        - prompt_match: PromptMatch details (or None)
        - agent_match: AgentMatch details (or None)
        - routing_reason: Human-readable routing explanation
    """
    result: Dict[str, Any] = {
        "prompt_id": "general",
        "agent_id": None,
        "toolset_id": None,
        "tools": None,
        "prompt_match": None,
        "agent_match": None,
        "routing_reason": "",
    }

    # Skip if registries not available or routing disabled
    if not REGISTRIES_AVAILABLE or not use_bespoke_routing:
        result["routing_reason"] = "Bespoke routing disabled or unavailable"
        logger.debug(f"Bespoke routing skipped: REGISTRIES_AVAILABLE={REGISTRIES_AVAILABLE}, use_bespoke_routing={use_bespoke_routing}")
        return result

    # Skip if no embedding service (required for semantic matching)
    if embedding_service is None:
        result["routing_reason"] = "No embedding service for semantic routing"
        logger.debug("Bespoke routing skipped: embedding_service is None")
        return result

    logger.debug(f"Bespoke routing enabled: registries available, embedding service present")

    try:
        # Get registry singletons
        prompt_registry = get_prompt_registry()
        agent_registry = get_agent_registry()

        # Step 1: Try to match a pre-bundled agent
        agent_match = await agent_registry.match(message, embedding_service)

        if agent_match:
            # Agent matched! Use its configuration
            agent_config = agent_registry.get_agent(agent_match.agent_id)
            if agent_config:
                result["agent_id"] = agent_match.agent_id
                result["agent_match"] = agent_match
                result["prompt_id"] = agent_config.prompt
                result["toolset_id"] = agent_config.toolset

                # Resolve toolset to tool names
                result["tools"] = agent_registry.resolve_tools(agent_config.toolset)

                result["routing_reason"] = (
                    f"Agent: {agent_match.agent_id} "
                    f"(confidence={agent_match.confidence:.2f}, "
                    f"toolset={agent_config.toolset})"
                )

                logger.info(
                    f"Bespoke routing: matched agent '{agent_match.agent_id}' "
                    f"with {len(result['tools'])} tools"
                )
                return result

        # Step 2: No agent match - route to best prompt
        prompt_match = await prompt_registry.match(message, embedding_service)

        # Step 3: If semantic routing fell back (score=0), try meta-prompt classification
        if prompt_match.score == 0.0 and ollama_client:
            meta_prompts = prompt_registry.data.routing.meta_prompts
            if meta_prompts:
                # Try FunctionGemma classification for meta-prompts
                meta_result = await _classify_meta_prompt(
                    message=message,
                    meta_prompts=meta_prompts,
                    prompt_registry=prompt_registry,
                    ollama_client=ollama_client,
                )
                if meta_result:
                    result["prompt_id"] = meta_result
                    result["prompt_match"] = PromptMatch(
                        prompt_id=meta_result,
                        score=0.0,  # Meta-classification doesn't have a score
                    )
                    result["routing_reason"] = f"Meta-prompt: {meta_result} (via FunctionGemma)"

                    logger.info(
                        f"Bespoke routing: classified as meta-prompt '{meta_result}'"
                    )
                    return result

        result["prompt_id"] = prompt_match.prompt_id
        result["prompt_match"] = prompt_match
        result["routing_reason"] = (
            f"Prompt: {prompt_match.prompt_id} "
            f"(score={prompt_match.score:.2f})"
        )

        # Note: tools will be determined by FunctionGemma or fallback
        # since we didn't match a pre-bundled agent

        logger.info(
            f"Bespoke routing: matched prompt '{prompt_match.prompt_id}' "
            f"(score={prompt_match.score:.2f})"
        )

    except Exception as e:
        logger.warning(f"Bespoke agent routing failed: {e}")
        result["routing_reason"] = f"Routing error: {e}"

    return result


async def _classify_meta_prompt(
    message: str,
    meta_prompts: List[str],
    prompt_registry: "PromptRegistry",
    ollama_client: OllamaFunctionGemma,
) -> Optional[str]:
    """
    Use FunctionGemma to classify a message into one of the meta-prompt categories.

    This is called when semantic routing doesn't confidently match a domain prompt,
    suggesting the user's request is either:
    - Multi-domain exploration (spans code + database + docs, etc.)
    - Implementation planning (needs task decomposition)
    - Novel concept exploration (researching unfamiliar technology)

    Args:
        message: User's message
        meta_prompts: List of meta-prompt IDs to choose from
        prompt_registry: Registry containing prompt configs
        ollama_client: FunctionGemma client for classification

    Returns:
        Selected meta-prompt ID, or None if classification fails
    """
    if not meta_prompts or not ollama_client:
        return None

    # Build classification prompt with descriptions
    options = []
    for prompt_id in meta_prompts:
        config = prompt_registry.get(prompt_id)
        if config:
            options.append(f"- {prompt_id}: {config.description}")

    options_str = "\n".join(options)

    classification_prompt = f"""Classify this user request into ONE of these categories:

{options_str}

User request: "{message}"

Respond with ONLY the category name (e.g., "multi_domain_exploration"), nothing else."""

    try:
        # Quick FunctionGemma call for classification
        response = await ollama_client.classify(
            prompt=classification_prompt,
            options=meta_prompts,
            timeout=2.0,  # Quick timeout for classification
        )

        if response and response in meta_prompts:
            return response

    except Exception as e:
        logger.debug(f"Meta-prompt classification failed: {e}")

    return None


async def prepare_request(
    message: str,
    explicit_depth: Optional[ThinkingDepth] = None,
    file_context: Optional[str] = None,
    ollama_client: Optional[OllamaFunctionGemma] = None,
    hybrid_routing_enabled: bool = True,
    environment: str = "daemon",
    semantic_router: Optional["SemanticRouter"] = None,
    semantic_threshold: float = 0.50,
    semantic_max_tools: int = 15,
    embedding_service: Optional["EmbeddingService"] = None,
    use_bespoke_routing: bool = True,
) -> PrepareResult:
    """
    Run the FunctionGemma prepare step with optional semantic pre-filtering.

    This is the main entry point for the prepare step. It will:
    1. (NEW) Route to bespoke agent or prompt using semantic embeddings
    2. (NEW) If semantic_router provided, pre-filter tools semantically
    3. Check if Ollama/FunctionGemma is available
    4. If yes, use FunctionGemma for depth + tool selection + routing
    5. If no, fall back to regex classification + all tools

    Args:
        message: User's query
        explicit_depth: User-specified depth override (from /quick, /deep, etc.)
        file_context: Optional active file path for context
        ollama_client: Optional Ollama client (for testing)
        hybrid_routing_enabled: Whether to include routing in prepare prompt
        environment: Runtime environment (lee, daemon, cli, tui, slack, agent)
        semantic_router: Optional SemanticRouter for tool pre-filtering
        semantic_threshold: Cosine similarity threshold for tool matching
        semantic_max_tools: Maximum tools after semantic pre-filtering
        embedding_service: Optional EmbeddingService for bespoke agent routing
        use_bespoke_routing: Whether to use registry-based prompt/agent routing

    Returns:
        PrepareResult with thinking_depth, relevant_tools, routing, and metadata
    """
    start_time = time.perf_counter()

    # If explicit depth provided, we still want to select tools
    # but we'll use the explicit depth
    use_explicit_depth = explicit_depth is not None

    # =========================================================================
    # ROUTING OVERRIDES (Phase 0)
    # =========================================================================
    # Check for explicit #prompt and @agent overrides BEFORE semantic routing.
    # These bypass all automatic routing and use the specified prompt/agent directly.
    routing_override = parse_routing_overrides(message)
    working_message = routing_override.cleaned_message

    explicit_prompt_id: Optional[str] = routing_override.explicit_prompt_id
    explicit_agent_id: Optional[str] = routing_override.explicit_agent_id

    # Initialize routing variables
    prompt_id: str = "general"
    agent_id: Optional[str] = None
    toolset_id: Optional[str] = None
    prompt_match: Optional[Any] = None
    agent_match: Optional[Any] = None
    registry_tools: Optional[List[str]] = None
    routing_reason: str = ""

    # If explicit agent override, resolve it directly from registry
    if explicit_agent_id and REGISTRIES_AVAILABLE:
        try:
            agent_registry = get_agent_registry()
            agent_config = agent_registry.get_agent(explicit_agent_id)
            if agent_config:
                agent_id = explicit_agent_id
                prompt_id = agent_config.prompt
                toolset_id = agent_config.toolset
                registry_tools = agent_registry.resolve_tools(agent_config.toolset)
                routing_reason = f"Explicit agent override: @{explicit_agent_id}"
                logger.info(f"Using explicit agent override: @{explicit_agent_id} -> {len(registry_tools)} tools")
            else:
                logger.warning(f"Unknown agent override: @{explicit_agent_id}, falling back to semantic routing")
                explicit_agent_id = None  # Clear invalid override
        except Exception as e:
            logger.warning(f"Failed to resolve agent override @{explicit_agent_id}: {e}")
            explicit_agent_id = None

    # If explicit prompt override (and no agent override), resolve it directly
    if explicit_prompt_id and not agent_id and REGISTRIES_AVAILABLE:
        try:
            prompt_registry = get_prompt_registry()
            prompt_config = prompt_registry.get(explicit_prompt_id)
            if prompt_config:
                prompt_id = explicit_prompt_id
                routing_reason = f"Explicit prompt override: #{explicit_prompt_id}"
                logger.info(f"Using explicit prompt override: #{explicit_prompt_id}")
            else:
                logger.warning(f"Unknown prompt override: #{explicit_prompt_id}, falling back to semantic routing")
                explicit_prompt_id = None  # Clear invalid override
        except Exception as e:
            logger.warning(f"Failed to resolve prompt override #{explicit_prompt_id}: {e}")
            explicit_prompt_id = None

    # =========================================================================
    # BESPOKE AGENT ROUTING (Phase 1)
    # =========================================================================
    # Check registries for pre-bundled agent match or prompt routing.
    # SKIP if we already have an explicit override.
    if not agent_id and not explicit_prompt_id:
        bespoke_result = await _route_bespoke_agent(
            message=working_message,
            embedding_service=embedding_service,
            use_bespoke_routing=use_bespoke_routing,
            ollama_client=ollama_client,
        )

        # Extract routing results
        prompt_id = bespoke_result.get("prompt_id", "general")
        agent_id = bespoke_result.get("agent_id")
        toolset_id = bespoke_result.get("toolset_id")
        prompt_match = bespoke_result.get("prompt_match")
        agent_match = bespoke_result.get("agent_match")
        registry_tools = bespoke_result.get("tools")  # May be None
        routing_reason = bespoke_result.get("routing_reason", "")

    # =========================================================================
    # SEMANTIC PRE-FILTERING (NEW)
    # =========================================================================
    # If semantic router is available, pre-filter tools based on query similarity.
    # This reduces the candidate set before FunctionGemma, improving both speed
    # and accuracy by focusing on semantically relevant tools.
    semantic_prefiltered_tools: Optional[List[str]] = None
    semantic_time_ms = 0.0

    if semantic_router is not None:
        try:
            semantic_start = time.perf_counter()
            # Get all available tool names
            available_tools = get_available_tools(environment)
            available_tool_names = [t.name for t in available_tools]

            # Route to relevant tools using semantic similarity
            tool_match = await semantic_router.route_to_tools(
                query=message,
                available_tools=available_tool_names,
                threshold=semantic_threshold,
                max_tools=semantic_max_tools,
            )

            if tool_match.tools:
                semantic_prefiltered_tools = [t.name for t in tool_match.tools]
                logger.info(
                    f"Semantic pre-filter: {len(semantic_prefiltered_tools)} tools selected "
                    f"(top: {semantic_prefiltered_tools[0] if semantic_prefiltered_tools else 'none'}, "
                    f"scores: {[f'{t.name}:{t.score:.2f}' for t in tool_match.tools[:3]]})"
                )
            else:
                logger.debug("Semantic pre-filter returned no tools, using full set")

            semantic_time_ms = (time.perf_counter() - semantic_start) * 1000

        except Exception as e:
            logger.warning(f"Semantic pre-filtering failed, continuing without: {e}")
            semantic_prefiltered_tools = None

    # Try FunctionGemma
    client = ollama_client or OllamaFunctionGemma()

    if await client.is_available():
        prompt = build_prepare_prompt(message, file_context, hybrid_routing_enabled, environment)
        response = await client.generate(prompt, tools=[PREPARE_REQUEST_TOOL])

        if response:
            parsed = parse_function_call(response)
            if parsed:
                # Parse depth (unless explicit)
                depth = explicit_depth
                if not use_explicit_depth and "depth" in parsed:
                    depth = parse_depth(parsed["depth"])
                if depth is None:
                    depth = ThinkingDepth.STANDARD

                # Parse tools
                tools: List[str] = []
                if "tools" in parsed:
                    tool_str = parsed["tools"]
                    # Handle "NONE" or empty
                    if tool_str.upper() != "NONE" and tool_str.strip():
                        tool_names = [t.strip() for t in tool_str.split(",")]
                        tools = validate_tools(tool_names, environment)

                # If semantic pre-filtering was done, merge with FunctionGemma selection
                # Prioritize semantic results but include FunctionGemma picks too
                if semantic_prefiltered_tools:
                    # Union: semantic picks + FunctionGemma picks, preserving order
                    merged_tools = list(semantic_prefiltered_tools)
                    for t in tools:
                        if t not in merged_tools:
                            merged_tools.append(t)
                    tools = merged_tools

                # Ensure minimum tools if none selected and not QUICK
                if not tools and depth != ThinkingDepth.QUICK:
                    tools = list(CORE_TOOLS)

                # Parse routing fields (hybrid mode)
                use_local_think = False
                think_model: Optional[str] = None
                observe_model: Optional[str] = "gemma3-4b"  # Default
                routing_reason = ""

                if hybrid_routing_enabled:
                    use_local_str = parsed.get("use_local", "false").lower()
                    use_local_think = use_local_str == "true"

                    think_model_raw = parsed.get("think_model", "")
                    if think_model_raw and think_model_raw.lower() != "none":
                        # Validate model name
                        valid_models = {"gemma3-4b", "gemma3-12b"}
                        if think_model_raw in valid_models:
                            think_model = think_model_raw
                        else:
                            # Try to match partial names
                            for vm in valid_models:
                                if think_model_raw.lower() in vm.lower():
                                    think_model = vm
                                    break

                    observe_model_raw = parsed.get("observe_model", "gemma3-4b")
                    valid_observe = {"gemma3-4b", "gemma3-12b"}
                    if observe_model_raw in valid_observe:
                        observe_model = observe_model_raw
                    else:
                        observe_model = "gemma3-4b"  # Default

                    hybrid_routing_reason = f"FunctionGemma: local={use_local_think}, think={think_model}, observe={observe_model}"
                    # Combine with bespoke routing reason if present
                    if routing_reason:
                        full_routing_reason = f"{routing_reason}; {hybrid_routing_reason}"
                    else:
                        full_routing_reason = hybrid_routing_reason

                elapsed_ms = (time.perf_counter() - start_time) * 1000

                # Merge registry tools with FunctionGemma selection (registry takes priority)
                final_tools = tools
                if registry_tools:
                    # Start with registry tools, add FunctionGemma picks not already included
                    final_tools = list(registry_tools)
                    for t in tools:
                        if t not in final_tools:
                            final_tools.append(t)

                return PrepareResult(
                    thinking_depth=depth,
                    relevant_tools=final_tools,
                    confidence=0.9,
                    used_fallback=False,
                    reason="FunctionGemma classification",
                    prepare_time_ms=elapsed_ms,
                    use_local_think=use_local_think,
                    think_model=think_model,
                    observe_model=observe_model,
                    routing_reason=full_routing_reason,
                    # Bespoke agent fields
                    prompt_id=prompt_id,
                    agent_id=agent_id,
                    toolset_id=toolset_id,
                    prompt_match=prompt_match,
                    agent_match=agent_match,
                    # Explicit overrides
                    explicit_prompt_id=explicit_prompt_id,
                    explicit_agent_id=explicit_agent_id,
                )

    # Fallback: Use regex classification + semantic pre-filtered tools (or all tools)
    logger.debug("Using fallback: regex classification + semantic/all tools")

    if use_explicit_depth:
        depth = explicit_depth
        classification_reason = "User explicit depth override"
    else:
        classification = classify_complexity(message)
        depth = classification.depth
        classification_reason = classification.reason

    # Tool priority: registry_tools > semantic_prefiltered > all tools
    if registry_tools:
        tools = list(registry_tools)
        classification_reason = f"{classification_reason} (registry tools)"
    elif semantic_prefiltered_tools:
        tools = semantic_prefiltered_tools
        classification_reason = f"{classification_reason} (with semantic pre-filter)"
    else:
        # Get all available tool names (filtered by environment)
        available_tools = get_available_tools(environment)
        tools = [t.name for t in available_tools]

    elapsed_ms = (time.perf_counter() - start_time) * 1000

    # Determine if we should use local models
    # LOCAL and DEEPLOCAL tiers always use local, QUICK uses local if hybrid enabled
    from .thinking_depth import is_local_depth, get_local_model_for_depth
    use_local_fallback = is_local_depth(depth) or (depth == ThinkingDepth.QUICK and hybrid_routing_enabled)

    logger.info(f"Fallback routing: depth={depth.name}, is_local={is_local_depth(depth)}, use_local_fallback={use_local_fallback}")

    # Determine the local model to use
    if is_local_depth(depth):
        # Explicit local tier - use the specific local model
        think_model_fallback = get_local_model_for_depth(depth)
        fallback_routing = f"Explicit local tier: {depth.name}"
    elif use_local_fallback:
        # QUICK tier with hybrid routing - use fast local model
        think_model_fallback = "gemma3-4b"
        fallback_routing = "Fallback: heuristic routing based on depth"
    else:
        think_model_fallback = None
        fallback_routing = "Fallback: heuristic routing based on depth"

    # Build full routing reason
    if routing_reason:
        full_routing_reason = f"{routing_reason}; {fallback_routing}"
    else:
        full_routing_reason = fallback_routing

    return PrepareResult(
        thinking_depth=depth,
        relevant_tools=tools,
        confidence=0.7 if not use_explicit_depth else 1.0,
        used_fallback=True,
        reason=f"Fallback: {classification_reason}",
        prepare_time_ms=elapsed_ms + semantic_time_ms,  # Include semantic time
        use_local_think=use_local_fallback,
        think_model=think_model_fallback,
        observe_model="gemma3-4b" if hybrid_routing_enabled else None,
        routing_reason=full_routing_reason,
        # Bespoke agent fields
        prompt_id=prompt_id,
        agent_id=agent_id,
        toolset_id=toolset_id,
        prompt_match=prompt_match,
        agent_match=agent_match,
        # Explicit overrides
        explicit_prompt_id=explicit_prompt_id,
        explicit_agent_id=explicit_agent_id,
    )


def filter_tools_by_names(
    tool_names: List[str],
) -> List[ToolDefinition]:
    """
    Filter HESTER_TOOLS to only include tools with the given names.

    Preserves the order from tool_names.
    """
    tool_map = {t.name: t for t in HESTER_TOOLS}
    return [tool_map[name] for name in tool_names if name in tool_map]


def get_filtered_tool_definitions(
    tool_names: List[str],
) -> List[Dict[str, Any]]:
    """
    Get tool definitions in dict format for the subset of tools.

    Returns list of dicts with name, description, parameters.
    """
    tools = filter_tools_by_names(tool_names)
    return [
        {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }
        for tool in tools
    ]


# ============================================================================
# Task Detection
# ============================================================================

def build_task_detection_prompt(message: str) -> str:
    """
    Build prompt for FunctionGemma to detect if request is a task vs question.
    """
    return f"""Analyze this user request and determine:
1. Is this a QUESTION (direct answer needed) or TASK (multi-step work required)?
2. If TASK, what type? (feature, bugfix, refactor, test, research, docs, config)

User request: {message}

Respond with a function call:
<start_function_call>call:detect_task{{request_type:<escape>TYPE<escape>,task_type:<escape>TASKTYPE<escape>}}<end_function_call>

Where TYPE is: question OR task
And TASKTYPE is: feature, bugfix, refactor, test, research, docs, config, or NONE

Rules:
- QUESTION: "What does X do?", "How does Y work?", "Show me Z", simple lookups
- TASK: "Add feature X", "Fix bug Y", "Refactor Z", "Write tests for W"

Task type rules:
- feature: New functionality, additions, enhancements
- bugfix: Fix errors, resolve issues, correct behavior
- refactor: Improve code structure, rename, reorganize
- test: Write tests, add coverage, testing tasks
- research: Investigate, explore, find information
- docs: Documentation, comments, README updates
- config: Configuration changes, settings, environment
"""


def parse_task_detection(response: str) -> Optional[Dict[str, str]]:
    """Parse FunctionGemma's task detection response."""
    match = FUNCTION_CALL_PATTERN.search(response)
    if not match:
        return None

    func_name = match.group(1)
    args_str = match.group(2)

    if func_name != "detect_task":
        return None

    result = {}
    kv_pattern = re.compile(r"(\w+):<escape>(.+?)<escape>")
    for m in kv_pattern.finditer(args_str):
        result[m.group(1)] = m.group(2)

    return result


def parse_request_type(type_str: str) -> Optional[RequestType]:
    """Parse request type string to enum."""
    type_map = {
        "question": RequestType.QUESTION,
        "task": RequestType.TASK,
    }
    return type_map.get(type_str.lower())


def parse_task_type(type_str: str) -> Optional[TaskType]:
    """Parse task type string to enum."""
    if not type_str or type_str.upper() == "NONE":
        return None
    type_map = {
        "feature": TaskType.FEATURE,
        "bugfix": TaskType.BUGFIX,
        "refactor": TaskType.REFACTOR,
        "test": TaskType.TEST,
        "research": TaskType.RESEARCH,
        "docs": TaskType.DOCS,
        "config": TaskType.CONFIG,
    }
    return type_map.get(type_str.lower())


# Regex patterns for fallback task detection
TASK_PATTERNS = [
    (r"\b(add|create|implement|build|make|write)\b", TaskType.FEATURE),
    (r"\b(fix|resolve|repair|correct|debug)\b", TaskType.BUGFIX),
    (r"\b(refactor|reorganize|restructure|clean up|improve)\b", TaskType.REFACTOR),
    (r"\b(test|write tests|add tests|coverage)\b", TaskType.TEST),
    (r"\b(investigate|research|explore|find out|look into)\b", TaskType.RESEARCH),
    (r"\b(document|docs|readme|comment)\b", TaskType.DOCS),
    (r"\b(config|configure|setup|settings|env)\b", TaskType.CONFIG),
]

QUESTION_PATTERNS = [
    r"^(what|how|why|where|when|who|which|can you explain)\b",
    r"\?$",
    r"^(show me|tell me|explain|describe)\b",
]


def classify_request_fallback(message: str, environment: str = "daemon") -> TaskDetectionResult:
    """
    Fallback classification using regex patterns.

    Used when FunctionGemma is unavailable.

    Args:
        message: User's request
        environment: Runtime environment for filtering task tools
    """
    message_lower = message.lower().strip()

    # Check for question patterns first
    for pattern in QUESTION_PATTERNS:
        if re.search(pattern, message_lower, re.IGNORECASE):
            return TaskDetectionResult(
                request_type=RequestType.QUESTION,
                task_type=None,
                confidence=0.6,
                reason="Regex: matched question pattern",
            )

    # Check for task patterns
    for pattern, task_type in TASK_PATTERNS:
        if re.search(pattern, message_lower, re.IGNORECASE):
            return TaskDetectionResult(
                request_type=RequestType.TASK,
                task_type=task_type,
                confidence=0.6,
                reason=f"Regex: matched {task_type.value} pattern",
                suggested_tools=get_task_tools_for_environment(environment),
            )

    # Default: treat as question
    return TaskDetectionResult(
        request_type=RequestType.QUESTION,
        task_type=None,
        confidence=0.4,
        reason="Regex: no clear pattern, defaulting to question",
    )


async def detect_task(
    message: str,
    ollama_client: Optional[OllamaFunctionGemma] = None,
    environment: str = "daemon",
) -> TaskDetectionResult:
    """
    Detect if user request is a task or question.

    Uses FunctionGemma for classification, falls back to regex.

    Args:
        message: User's request
        ollama_client: Optional Ollama client (for testing)
        environment: Runtime environment for filtering task tools (daemon, cli, slack, etc.)

    Returns:
        TaskDetectionResult with request_type, task_type, and metadata
    """
    start_time = time.perf_counter()

    client = ollama_client or OllamaFunctionGemma()

    if await client.is_available():
        prompt = build_task_detection_prompt(message)
        response = await client.generate(prompt, tools=[DETECT_TASK_TOOL])

        if response:
            parsed = parse_task_detection(response)
            if parsed:
                request_type = parse_request_type(parsed.get("request_type", ""))
                task_type = parse_task_type(parsed.get("task_type", ""))

                if request_type is None:
                    request_type = RequestType.QUESTION

                # Suggest task tools if this is a task (filtered by environment)
                suggested_tools = get_task_tools_for_environment(environment) if request_type == RequestType.TASK else []

                elapsed_ms = (time.perf_counter() - start_time) * 1000

                return TaskDetectionResult(
                    request_type=request_type,
                    task_type=task_type,
                    confidence=0.85,
                    reason="FunctionGemma classification",
                    suggested_tools=suggested_tools,
                    prepare_time_ms=elapsed_ms,
                )

    # Fallback to regex
    logger.debug("Using fallback: regex task detection")
    result = classify_request_fallback(message, environment)
    result.prepare_time_ms = (time.perf_counter() - start_time) * 1000
    return result


# ============================================================================
# Per-Batch Prepare
# ============================================================================

def build_batch_prepare_prompt(
    batch_description: str,
    batch_files: List[str],
    task_context: str,
) -> str:
    """
    Build prompt for FunctionGemma to prepare a task batch.

    Args:
        batch_description: What this batch should accomplish
        batch_files: Files that may be involved
        task_context: Overall task context
    """
    tool_summaries = get_tool_summaries()

    files_hint = ""
    if batch_files:
        files_hint = f"\nRelevant files: {', '.join(batch_files[:10])}"

    return f"""Analyze this task batch and determine:
1. What thinking depth is needed (QUICK, STANDARD, DEEP, or REASONING)
2. Which tools are relevant for this batch
3. Estimated complexity (simple, moderate, complex)
4. Brief hints for the executor

Task context: {task_context}
Batch description: {batch_description}{files_hint}

Available tools:
{tool_summaries}

Respond with a function call:
<start_function_call>call:prepare_batch{{depth:<escape>DEPTH<escape>,tools:<escape>tool1,tool2<escape>,complexity:<escape>COMPLEXITY<escape>,hints:<escape>HINTS<escape>}}<end_function_call>

Where:
- DEPTH: QUICK, STANDARD, DEEP, or REASONING
- tools: comma-separated relevant tool names
- complexity: simple, moderate, or complex
- hints: Brief natural language hints for the executor (max 100 chars)

Rules:
- simple: Single file change, straightforward logic
- moderate: Multiple files, some analysis needed
- complex: Architecture changes, debugging, multi-step reasoning
"""


def parse_batch_prepare(response: str) -> Optional[Dict[str, str]]:
    """Parse FunctionGemma's batch prepare response."""
    match = FUNCTION_CALL_PATTERN.search(response)
    if not match:
        return None

    func_name = match.group(1)
    args_str = match.group(2)

    if func_name != "prepare_batch":
        return None

    result = {}
    kv_pattern = re.compile(r"(\w+):<escape>(.+?)<escape>")
    for m in kv_pattern.finditer(args_str):
        result[m.group(1)] = m.group(2)

    return result


def estimate_batch_complexity_fallback(
    batch_description: str,
    batch_files: List[str],
) -> str:
    """
    Estimate batch complexity using heuristics.

    Used when FunctionGemma is unavailable.
    """
    desc_lower = batch_description.lower()

    # Complex indicators
    complex_patterns = [
        r"\b(refactor|architecture|design|debug|investigate)\b",
        r"\b(multiple|several|across|all)\b",
        r"\b(complex|difficult|tricky)\b",
    ]

    # Simple indicators
    simple_patterns = [
        r"\b(add|create|simple|single|one)\b",
        r"\b(update|modify|change)\b",
        r"\b(rename|move|copy)\b",
    ]

    complex_score = sum(1 for p in complex_patterns if re.search(p, desc_lower))
    simple_score = sum(1 for p in simple_patterns if re.search(p, desc_lower))

    # File count also affects complexity
    file_count = len(batch_files)
    if file_count > 5:
        complex_score += 1
    elif file_count <= 1:
        simple_score += 1

    if complex_score > simple_score:
        return "complex"
    elif simple_score > complex_score:
        return "simple"
    else:
        return "moderate"


def get_depth_for_complexity(complexity: str) -> ThinkingDepth:
    """Map complexity to thinking depth."""
    complexity_map = {
        "simple": ThinkingDepth.STANDARD,
        "moderate": ThinkingDepth.DEEP,
        "complex": ThinkingDepth.REASONING,
    }
    return complexity_map.get(complexity, ThinkingDepth.STANDARD)


async def prepare_batch(
    batch_description: str,
    batch_files: List[str],
    task_context: str,
    ollama_client: Optional[OllamaFunctionGemma] = None,
) -> BatchPrepareResult:
    """
    Prepare a task batch with thinking depth and tool selection.

    This is called before executing each batch in a task to:
    1. Determine appropriate thinking depth
    2. Select relevant tools
    3. Generate hints for the executor (Claude Code)

    Args:
        batch_description: What this batch should accomplish
        batch_files: Files that may be involved
        task_context: Overall task context
        ollama_client: Optional Ollama client (for testing)

    Returns:
        BatchPrepareResult with thinking_depth, tools, hints, and complexity
    """
    start_time = time.perf_counter()

    client = ollama_client or OllamaFunctionGemma()

    if await client.is_available():
        prompt = build_batch_prepare_prompt(batch_description, batch_files, task_context)
        response = await client.generate(prompt, tools=[PREPARE_BATCH_TOOL])

        if response:
            parsed = parse_batch_prepare(response)
            if parsed:
                # Parse depth
                depth = parse_depth(parsed.get("depth", "STANDARD"))
                if depth is None:
                    depth = ThinkingDepth.STANDARD

                # Parse tools
                tools: List[str] = []
                if "tools" in parsed:
                    tool_str = parsed["tools"]
                    if tool_str.upper() != "NONE" and tool_str.strip():
                        tool_names = [t.strip() for t in tool_str.split(",")]
                        tools = validate_tools(tool_names)

                # Ensure minimum tools
                if not tools:
                    tools = list(CORE_TOOLS)

                # Parse complexity
                complexity = parsed.get("complexity", "moderate").lower()
                if complexity not in ("simple", "moderate", "complex"):
                    complexity = "moderate"

                # Get hints
                hints = parsed.get("hints", "")[:200]  # Limit length

                elapsed_ms = (time.perf_counter() - start_time) * 1000

                return BatchPrepareResult(
                    thinking_depth=depth,
                    relevant_tools=tools,
                    tool_hints=hints,
                    estimated_complexity=complexity,
                    confidence=0.85,
                    prepare_time_ms=elapsed_ms,
                )

    # Fallback
    logger.debug("Using fallback: heuristic batch prepare")

    complexity = estimate_batch_complexity_fallback(batch_description, batch_files)
    depth = get_depth_for_complexity(complexity)

    # Select tools based on batch description
    all_tools = [t.name for t in HESTER_TOOLS]

    elapsed_ms = (time.perf_counter() - start_time) * 1000

    return BatchPrepareResult(
        thinking_depth=depth,
        relevant_tools=all_tools,
        tool_hints="",  # No hints in fallback mode
        estimated_complexity=complexity,
        confidence=0.5,
        prepare_time_ms=elapsed_ms,
    )


# ============================================================================
# Hybrid ReAct Loop: OllamaGemmaClient
# ============================================================================

class OllamaGemmaClient:
    """
    Client for multiple Gemma variants via Ollama for hybrid ReAct loop.

    Supports:
    - gemma3:4b - Fast (~100-200ms), simple parsing/tasks (OBSERVE, simple THINK)
    - gemma3:12b - Best quality (~300-500ms), complex parsing/reasoning (THINK)
    - functiongemma - Prepare step (existing functionality)

    Uses Ollama's keep_alive for KV cache warming.
    """

    MODEL_CONFIGS: Dict[str, Dict[str, Any]] = {
        "gemma3-4b": {
            "ollama_name": "gemma3:4b",
            "timeout": 2.0,
            "use_case": "observe",
            "precision": "4b",
        },
        "gemma3-12b": {
            "ollama_name": "gemma3:12b",
            "timeout": 4.0,
            "use_case": "think-standard",
            "precision": "12b",
        },
        "functiongemma": {
            "ollama_name": "functiongemma:latest",
            "timeout": 2.0,
            "use_case": "prepare",
            "precision": "full",
        },
    }

    DEFAULT_OLLAMA_URL = "http://localhost:11434"

    def __init__(
        self,
        ollama_url: Optional[str] = None,
        default_timeout_ms: float = 500.0,
        warm_context_ttl_seconds: int = 300,
    ):
        self.ollama_url = ollama_url or self.DEFAULT_OLLAMA_URL
        self.default_timeout_ms = default_timeout_ms
        self.warm_context_ttl_seconds = warm_context_ttl_seconds
        self._model_availability: Dict[str, Optional[bool]] = {}

    async def check_model_available(self, model_key: str) -> bool:
        """
        Check if a specific Gemma model is available via Ollama.

        Uses cached result if previously checked.
        """
        if model_key in self._model_availability:
            return self._model_availability[model_key] or False

        config = self.MODEL_CONFIGS.get(model_key)
        if not config:
            self._model_availability[model_key] = False
            return False

        ollama_name = config["ollama_name"]

        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                response = await client.get(f"{self.ollama_url}/api/tags")
                if response.status_code == 200:
                    models = response.json().get("models", [])
                    # Check if model name matches (with or without tag)
                    base_name = ollama_name.split(":")[0]
                    available = any(
                        m.get("name", "").startswith(base_name)
                        for m in models
                    )
                    self._model_availability[model_key] = available
                    return available
        except Exception as e:
            logger.debug(f"Ollama model check failed for {model_key}: {e}")

        self._model_availability[model_key] = False
        return False

    async def check_models_available(self) -> Dict[str, bool]:
        """Check availability of all configured models."""
        results = {}
        for model_key in self.MODEL_CONFIGS:
            results[model_key] = await self.check_model_available(model_key)
        return results

    async def generate_with_precision(
        self,
        prompt: str,
        model_key: str,
        system: Optional[str] = None,
        keep_alive: Optional[str] = None,
        timeout_ms: Optional[float] = None,
    ) -> Optional[str]:
        """
        Generate response from a Gemma model with specified precision.

        Args:
            prompt: The user prompt
            model_key: One of "gemma3-4b", "gemma3-12b", "functiongemma"
            system: Optional system prompt
            keep_alive: Ollama keep_alive parameter (e.g., "5m" for KV cache)
            timeout_ms: Timeout in milliseconds (uses model default if not specified)

        Returns:
            Generated text or None if failed/timeout
        """
        config = self.MODEL_CONFIGS.get(model_key)
        if not config:
            logger.warning(f"Unknown model key: {model_key}")
            return None

        timeout_s = (timeout_ms or self.default_timeout_ms) / 1000.0
        timeout_s = min(timeout_s, config["timeout"])  # Use model max as ceiling

        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                payload: Dict[str, Any] = {
                    "model": config["ollama_name"],
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": 0.1,
                        "num_predict": 512,
                    }
                }
                if system:
                    payload["system"] = system
                if keep_alive:
                    payload["keep_alive"] = keep_alive
                elif self.warm_context_ttl_seconds > 0:
                    payload["keep_alive"] = f"{self.warm_context_ttl_seconds}s"

                response = await client.post(
                    f"{self.ollama_url}/api/generate",
                    json=payload,
                )

                if response.status_code == 200:
                    return response.json().get("response", "")

        except asyncio.TimeoutError:
            logger.debug(f"Model {model_key} timed out after {timeout_s}s")
        except Exception as e:
            logger.debug(f"Model {model_key} error: {e}")

        return None

    async def observe_tool_output(
        self,
        tool_name: str,
        tool_output: Any,
        context: str,
        model_key: Optional[str] = None,
    ) -> "ObservationResult":
        """
        Parse tool output locally with Gemma to extract key information.

        This is the OBSERVE phase of the hybrid ReAct loop.

        Args:
            tool_name: Name of the tool that was executed
            tool_output: Raw output from the tool
            context: Truncated system context for understanding
            model_key: Model to use (defaults to gemma3-4b)

        Returns:
            ObservationResult with extracted information and sufficiency decision
        """
        from .models import ObservationResult

        start_time = time.perf_counter()
        model = model_key or "gemma3-4b"

        # Truncate output if too long
        output_str = str(tool_output)
        if len(output_str) > 4000:
            output_str = output_str[:2000] + "\n...[truncated]...\n" + output_str[-1500:]

        prompt = f"""Parse this tool output and extract key information.

Tool: {tool_name}
Output:
{output_str}

Context: {context[:500]}

Respond in this exact format:
FINDINGS:
- [key finding 1]
- [key finding 2]
- [etc.]

SUFFICIENT: [yes/no] (Is this enough to answer the user's question?)
NEEDS_MORE: [yes/no] (Does this require complex follow-up reasoning?)
NEXT_ACTION: [tool name or "none"] (If not sufficient, what tool should be called next?)
CONFIDENCE: [0.0-1.0] (How confident are you in this interpretation?)
"""

        response = await self.generate_with_precision(
            prompt=prompt,
            model_key=model,
            timeout_ms=self.default_timeout_ms,
        )

        elapsed_ms = (time.perf_counter() - start_time) * 1000

        # Parse response
        if response:
            return self._parse_observation_response(response, elapsed_ms, model)

        # Fallback: return minimal observation
        return ObservationResult(
            key_findings=["Tool executed successfully"],
            data_extracted={},
            is_sufficient=False,
            needs_more_reasoning=True,
            suggested_action=None,
            confidence=0.3,
            parse_time_ms=elapsed_ms,
            model_used="fallback",
        )

    def _parse_observation_response(
        self,
        response: str,
        elapsed_ms: float,
        model_used: str,
    ) -> "ObservationResult":
        """Parse the observation response into ObservationResult."""
        from .models import ObservationResult

        # Extract findings
        findings: List[str] = []
        findings_match = re.search(r"FINDINGS:\s*(.*?)(?=SUFFICIENT:|$)", response, re.DOTALL)
        if findings_match:
            findings_text = findings_match.group(1)
            findings = [
                line.strip().lstrip("-").strip()
                for line in findings_text.strip().split("\n")
                if line.strip() and line.strip().startswith("-")
            ]

        # Extract yes/no fields
        is_sufficient = self._extract_yes_no(response, "SUFFICIENT:")
        needs_more = self._extract_yes_no(response, "NEEDS_MORE:")

        # Extract next action
        next_action = None
        action_match = re.search(r"NEXT_ACTION:\s*(\w+)", response)
        if action_match:
            action = action_match.group(1).lower()
            if action != "none":
                next_action = action

        # Extract confidence
        confidence = 0.5
        conf_match = re.search(r"CONFIDENCE:\s*([\d.]+)", response)
        if conf_match:
            try:
                confidence = float(conf_match.group(1))
                confidence = max(0.0, min(1.0, confidence))
            except ValueError:
                pass

        return ObservationResult(
            key_findings=findings or ["Observation parsed"],
            data_extracted={},
            is_sufficient=is_sufficient,
            needs_more_reasoning=needs_more,
            suggested_action=next_action,
            confidence=confidence,
            parse_time_ms=elapsed_ms,
            model_used=model_used,
        )

    def _extract_yes_no(self, text: str, prefix: str) -> bool:
        """Extract yes/no value after a prefix."""
        pattern = rf"{prefix}\s*(yes|no)"
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).lower() == "yes"
        return False

    async def think_simple(
        self,
        current_state: str,
        available_tools: List[str],
        user_query: str,
        model_key: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Simple THINK phase for straightforward queries.

        Used when FunctionGemma prepare step recommends local thinking.

        Args:
            current_state: Current conversation/tool state
            available_tools: List of available tool names
            user_query: The user's original query
            model_key: Model to use (defaults to gemma3-4b)

        Returns:
            Dict with 'response' or 'tool_call' or None if should escalate to cloud
        """
        model = model_key or "gemma3-4b"

        tools_str = ", ".join(available_tools[:15])  # Limit tools in prompt

        prompt = f"""You are a helpful coding assistant. Analyze this query and decide what to do.

User query: {user_query}

Current state:
{current_state[:2000]}

Available tools: {tools_str}

If you can answer directly, respond with:
ANSWER: [your response]

If you need to call a tool, respond with:
TOOL: [tool_name]
ARGS: {{"arg1": "value1", "arg2": "value2"}}

If this is too complex and needs more sophisticated reasoning, respond with:
ESCALATE: [reason]
"""

        response = await self.generate_with_precision(
            prompt=prompt,
            model_key=model,
            timeout_ms=self.default_timeout_ms * 2,  # Allow more time for thinking
        )

        if not response:
            return None

        # Parse response
        if response.strip().startswith("ANSWER:"):
            return {"response": response.split("ANSWER:", 1)[1].strip()}

        if response.strip().startswith("TOOL:"):
            # Parse tool call
            lines = response.strip().split("\n")
            tool_name = lines[0].split("TOOL:", 1)[1].strip()
            args = {}
            for line in lines[1:]:
                if line.strip().startswith("ARGS:"):
                    try:
                        import json
                        args_str = line.split("ARGS:", 1)[1].strip()
                        args = json.loads(args_str)
                    except Exception:
                        pass
            return {"tool_call": {"name": tool_name, "args": args}}

        if response.strip().startswith("ESCALATE:"):
            return None  # Signal to use cloud

        return None


# ============================================================================
# Warm Context Manager
# ============================================================================

class WarmContextManager:
    """
    Manages warm context (KV cache) for local Gemma models.

    Uses Ollama's keep_alive parameter to maintain model context in VRAM.
    First request loads the context, subsequent requests only process deltas.
    """

    def __init__(
        self,
        client: OllamaGemmaClient,
        ttl_seconds: int = 300,
    ):
        self.client = client
        self.ttl_seconds = ttl_seconds
        self._context_hashes: Dict[str, float] = {}  # model -> last_warm_time
        self._last_context: Dict[str, str] = {}  # model -> context_hash

    def _hash_context(self, system_prompt: str, codebase_context: str) -> str:
        """Generate hash for context content."""
        import hashlib
        content = f"{system_prompt}|{codebase_context}"
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    async def ensure_warm(
        self,
        model_key: str,
        system_prompt: str,
        codebase_context: str,
    ) -> bool:
        """
        Ensure model has warm context loaded.

        If context is the same and within TTL, returns True immediately.
        Otherwise, sends a warm-up request to load context into KV cache.

        Args:
            model_key: Model to warm up
            system_prompt: System prompt to load
            codebase_context: Codebase context to load

        Returns:
            True if context is warm, False if warming failed
        """
        context_hash = self._hash_context(system_prompt, codebase_context)
        current_time = time.time()

        # Check if already warm
        last_time = self._context_hashes.get(model_key, 0)
        last_hash = self._last_context.get(model_key, "")

        if (
            context_hash == last_hash
            and (current_time - last_time) < self.ttl_seconds
        ):
            logger.debug(f"Context already warm for {model_key}")
            return True

        # Warm up with a minimal prompt
        logger.debug(f"Warming context for {model_key}")
        result = await self.client.generate_with_precision(
            prompt="Ready.",  # Minimal prompt to load context
            model_key=model_key,
            system=f"{system_prompt}\n\nCodebase context:\n{codebase_context[:2000]}",
            keep_alive=f"{self.ttl_seconds}s",
            timeout_ms=2000,  # Allow more time for initial load
        )

        if result is not None:
            self._context_hashes[model_key] = current_time
            self._last_context[model_key] = context_hash
            return True

        return False

    def cleanup_expired(self) -> None:
        """Remove expired context entries."""
        current_time = time.time()
        expired_keys = [
            model
            for model, last_time in self._context_hashes.items()
            if (current_time - last_time) > self.ttl_seconds
        ]
        for key in expired_keys:
            del self._context_hashes[key]
            if key in self._last_context:
                del self._last_context[key]
