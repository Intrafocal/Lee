"""
Tool definitions package - modular tool definitions for Hester ReAct.

This package contains tool definitions organized by category:
- models: ToolResult, ToolDefinition base classes
- file_tools: File reading, searching, listing, directory navigation
- doc_tools: Documentation claims, validation, drift detection
- task_tools: Task management (create, batch, execute)
- db_tools: Database queries and schema exploration
- devops_tools: Service management, docker, compose
- context_tools: Context bundle management
- redis_tools: Redis key management
- misc_tools: Web search, summarize, UI control, status messages
- copywriting_tools: Content analysis, tone, readability, rewriting
"""

import logging
from typing import Any, Dict, List

from .models import ToolResult, ToolDefinition

logger = logging.getLogger("hester.daemon.tools.definitions")

# Import all tool definitions
from .file_tools import (
    READ_FILE_TOOL,
    SEARCH_FILES_TOOL,
    SEARCH_CONTENT_TOOL,
    LIST_DIRECTORY_TOOL,
    CHANGE_DIRECTORY_TOOL,
    FILE_TOOLS,
)
from .doc_tools import (
    EXTRACT_DOC_CLAIMS_TOOL,
    VALIDATE_CLAIM_TOOL,
    FIND_DOC_DRIFT_TOOL,
    SEMANTIC_DOC_SEARCH_TOOL,
    WRITE_MARKDOWN_TOOL,
    UPDATE_MARKDOWN_TOOL,
    DOC_TOOLS,
)
from .task_tools import (
    CREATE_TASK_TOOL,
    GET_TASK_TOOL,
    UPDATE_TASK_TOOL,
    LIST_TASKS_TOOL,
    ADD_BATCH_TOOL,
    ADD_CONTEXT_TOOL,
    MARK_TASK_READY_TOOL,
    DELETE_TASK_TOOL,
    TASK_TOOLS,
)
from .db_tools import (
    DB_LIST_TABLES_TOOL,
    DB_DESCRIBE_TABLE_TOOL,
    DB_LIST_FUNCTIONS_TOOL,
    DB_LIST_RLS_POLICIES_TOOL,
    DB_LIST_CONSTRAINTS_TOOL,
    DB_EXECUTE_SELECT_TOOL,
    DB_COUNT_ROWS_TOOL,
    DB_TOOLS,
)
from .devops_tools import (
    DEVOPS_LIST_SERVICES_TOOL,
    DEVOPS_START_SERVICE_TOOL,
    DEVOPS_STOP_SERVICE_TOOL,
    DEVOPS_SERVICE_STATUS_TOOL,
    DEVOPS_SERVICE_LOGS_TOOL,
    DEVOPS_HEALTH_CHECK_TOOL,
    DEVOPS_DOCKER_STATUS_TOOL,
    DEVOPS_DOCKER_LOGS_TOOL,
    DEVOPS_COMPOSE_UP_TOOL,
    DEVOPS_COMPOSE_DOWN_TOOL,
    DEVOPS_COMPOSE_BUILD_TOOL,
    DEVOPS_COMPOSE_REBUILD_TOOL,
    DEVOPS_COMPOSE_PS_TOOL,
    DEVOPS_COMPOSE_LOGS_TOOL,
    DEVOPS_TOOLS,
)
from .context_tools import (
    CREATE_CONTEXT_BUNDLE_TOOL,
    GET_CONTEXT_BUNDLE_TOOL,
    LIST_CONTEXT_BUNDLES_TOOL,
    REFRESH_CONTEXT_BUNDLE_TOOL,
    ADD_BUNDLE_SOURCE_TOOL,
    CONTEXT_TOOLS,
)
from .redis_tools import (
    REDIS_LIST_KEYS_TOOL,
    REDIS_GET_KEY_TOOL,
    REDIS_KEY_INFO_TOOL,
    REDIS_DELETE_KEY_TOOL,
    REDIS_STATS_TOOL,
    REDIS_TOOLS,
)
from .misc_tools import (
    WEB_SEARCH_TOOL,
    SUMMARIZE_TOOL,
    UI_CONTROL_TOOL,
    STATUS_MESSAGE_TOOL,
    MISC_TOOLS,
)
from .git_tools import (
    GIT_STATUS_TOOL,
    GIT_DIFF_TOOL,
    GIT_LOG_TOOL,
    GIT_BRANCH_TOOL,
    GIT_ADD_TOOL,
    GIT_COMMIT_TOOL,
    GIT_READ_TOOLS,
    GIT_WRITE_TOOLS,
    GIT_TOOLS,
)
from .copywriting_tools import (
    ANALYZE_TONE_TOOL,
    ANALYZE_READABILITY_TOOL,
    ADJUST_TEMPERATURE_TOOL,
    REWRITE_CONTENT_TOOL,
    COPYWRITING_TOOLS,
)
from .visualization_tools import (
    RENDER_MERMAID_TOOL,
    GENERATE_IMAGE_TOOL,
    RENDER_MARKDOWN_TOOL,
    VISUALIZATION_TOOLS,
)
from .workstream_tools import (
    WORKSTREAM_CREATE_TOOL,
    WORKSTREAM_SET_BRIEF_TOOL,
    WORKSTREAM_ADVANCE_TO_DESIGN_TOOL,
    WORKSTREAM_LIST_TOOL,
    WORKSTREAM_TOOLS,
)


# All available tools - assembled from all categories
HESTER_TOOLS: List[ToolDefinition] = [
    *FILE_TOOLS,
    *DOC_TOOLS,
    *[WEB_SEARCH_TOOL],
    *[SUMMARIZE_TOOL],
    *TASK_TOOLS,
    *DB_TOOLS,
    *DEVOPS_TOOLS,
    *CONTEXT_TOOLS,
    *REDIS_TOOLS,
    *GIT_TOOLS,
    *[UI_CONTROL_TOOL, STATUS_MESSAGE_TOOL],
    *COPYWRITING_TOOLS,
    *VISUALIZATION_TOOLS,
    *WORKSTREAM_TOOLS,
]


# =============================================================================
# Tool Categories for Bespoke Agent Registry
# =============================================================================
# Maps category names to lists of tool names.
# Used by AgentRegistry to resolve toolsets to concrete tool lists.

TOOL_CATEGORIES: Dict[str, List[str]] = {
    # Observe - Read-only codebase access
    "observe": [
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
        # Git read-only
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
    ],

    # Database - Schema exploration and read-only queries
    "database": [
        "db_list_tables",
        "db_describe_table",
        "db_list_functions",
        "db_list_rls_policies",
        "db_list_constraints",
        "db_execute_select",
        "db_count_rows",
    ],

    # DevOps - Service and container management
    "devops": [
        "devops_list_services",
        "devops_service_status",
        "devops_service_logs",
        "devops_health_check",
        "devops_docker_status",
        "devops_docker_logs",
        "devops_compose_ps",
        "devops_compose_logs",
        # Write operations
        "devops_start_service",
        "devops_stop_service",
        "devops_compose_up",
        "devops_compose_down",
        "devops_compose_build",
        "devops_compose_rebuild",
    ],

    # Research - External data access
    "research": [
        "web_search",
        "semantic_doc_search",
        "summarize",
    ],

    # Context - Bundle management
    "context": [
        "get_context_bundle",
        "list_context_bundles",
        "create_context_bundle",
        "refresh_context_bundle",
        "add_bundle_source",
    ],

    # Docs - Documentation tools
    "docs": [
        "extract_doc_claims",
        "validate_claim",
        "find_doc_drift",
        "semantic_doc_search",
        "write_markdown",
        "update_markdown",
    ],

    # Git Write - Mutating git operations
    "git_write": [
        "git_add",
        "git_commit",
    ],

    # UI - Editor control (Lee-only)
    "ui": [
        "ui_control",
        "status_message",
    ],

    # Redis - Cache/session access
    "redis": [
        "redis_list_keys",
        "redis_get_key",
        "redis_key_info",
        "redis_stats",
        "redis_delete_key",
    ],

    # Orchestrate - Task management (restricted)
    "orchestrate": [
        "create_task",
        "get_task",
        "update_task",
        "list_tasks",
        "add_batch",
        "add_context",
        "mark_task_ready",
        "delete_task",
    ],

    # Copywriting - Content analysis and transformation
    "copywriting": [
        "analyze_tone",
        "analyze_readability",
        "adjust_temperature",
        "rewrite_content",
        "summarize",  # Shared with research category
    ],

    # Visualization - Mermaid diagrams, image generation, structured markdown
    "visualization": [
        "render_mermaid",
        "generate_image",
        "render_markdown",
    ],

    # Workstream - Workstream creation and management
    "workstream": [
        "workstream_create",
        "workstream_set_brief",
        "workstream_advance_to_design",
        "workstream_list",
    ],
}


def get_tools_by_categories(categories: List[str]) -> List[str]:
    """
    Resolve category names to a deduplicated list of tool names.

    Args:
        categories: List of category names (e.g., ["observe", "database"])

    Returns:
        List of tool names belonging to those categories
    """
    tools = set()
    for category in categories:
        category_tools = TOOL_CATEGORIES.get(category, [])
        tools.update(category_tools)
    return list(tools)


def get_tools_by_names(tool_names: List[str]) -> List[ToolDefinition]:
    """
    Get ToolDefinition objects by their names.

    Args:
        tool_names: List of tool names

    Returns:
        List of matching ToolDefinition objects
    """
    tools = []
    for name in tool_names:
        tool = get_tool_by_name(name)
        if tool:
            tools.append(tool)
    return tools


def get_tools_description_for_names(tool_names: List[str]) -> str:
    """
    Get formatted description for a specific set of tools.

    Args:
        tool_names: List of tool names to include

    Returns:
        Formatted string describing the tools
    """
    lines = ["## Available Tools\n"]

    tools = get_tools_by_names(tool_names)
    for tool in tools:
        lines.append(f"### {tool.name}")
        lines.append(tool.description)
        lines.append("")

        # Add parameter info
        params = tool.parameters.get("properties", {})
        required = tool.parameters.get("required", [])

        if params:
            lines.append("**Parameters:**")
            for name, info in params.items():
                req = " (required)" if name in required else ""
                desc = info.get("description", "")
                lines.append(f"- `{name}`{req}: {desc}")
            lines.append("")

    return "\n".join(lines)


def get_available_tools(environment: str = "daemon") -> List[ToolDefinition]:
    """
    Get list of available tools, filtering based on environment.

    Args:
        environment: Runtime environment (daemon, cli, slack, subagent)

    Returns:
        List of available ToolDefinition objects
    """
    return [
        t for t in HESTER_TOOLS
        if t.environments is None or environment in t.environments
    ]


def get_tools_description(environment: str = "daemon") -> str:
    """Get a formatted description of all available tools for prompts."""
    lines = ["## Available Tools\n"]

    available_tools = get_available_tools(environment)
    for tool in available_tools:
        lines.append(f"### {tool.name}")
        lines.append(tool.description)
        lines.append("")

        # Add parameter info
        params = tool.parameters.get("properties", {})
        required = tool.parameters.get("required", [])

        if params:
            lines.append("**Parameters:**")
            for name, info in params.items():
                req = " (required)" if name in required else ""
                desc = info.get("description", "")
                lines.append(f"- `{name}`{req}: {desc}")
            lines.append("")

    return "\n".join(lines)


def get_tool_by_name(name: str) -> ToolDefinition | None:
    """Get a tool definition by name."""
    for tool in HESTER_TOOLS:
        if tool.name == name:
            return tool
    return None


def to_gemini_function_declarations() -> List[Dict[str, Any]]:
    """Convert tool definitions to Gemini function declaration format."""
    declarations = []

    for tool in HESTER_TOOLS:
        declarations.append({
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        })

    return declarations


def register_plugin_tools(
    tool_defs: List[ToolDefinition],
    categories: Dict[str, List[str]],
) -> None:
    """Register tools and categories from a plugin."""
    HESTER_TOOLS.extend(tool_defs)
    TOOL_CATEGORIES.update(categories)
    logger.info(f"Registered {len(tool_defs)} plugin tools, {len(categories)} categories")


__all__ = [
    # Base classes
    "ToolResult",
    "ToolDefinition",
    # Tool collections
    "HESTER_TOOLS",
    "FILE_TOOLS",
    "DOC_TOOLS",
    "TASK_TOOLS",
    "DB_TOOLS",
    "DEVOPS_TOOLS",
    "CONTEXT_TOOLS",
    "REDIS_TOOLS",
    "GIT_TOOLS",
    "GIT_READ_TOOLS",
    "GIT_WRITE_TOOLS",
    "MISC_TOOLS",
    # Bespoke Agent Categories
    "TOOL_CATEGORIES",
    # Individual tools (for direct import)
    "READ_FILE_TOOL",
    "SEARCH_FILES_TOOL",
    "SEARCH_CONTENT_TOOL",
    "LIST_DIRECTORY_TOOL",
    "CHANGE_DIRECTORY_TOOL",
    "EXTRACT_DOC_CLAIMS_TOOL",
    "VALIDATE_CLAIM_TOOL",
    "FIND_DOC_DRIFT_TOOL",
    "SEMANTIC_DOC_SEARCH_TOOL",
    "WRITE_MARKDOWN_TOOL",
    "UPDATE_MARKDOWN_TOOL",
    "WEB_SEARCH_TOOL",
    "SUMMARIZE_TOOL",
    "CREATE_TASK_TOOL",
    "GET_TASK_TOOL",
    "UPDATE_TASK_TOOL",
    "LIST_TASKS_TOOL",
    "ADD_BATCH_TOOL",
    "ADD_CONTEXT_TOOL",
    "MARK_TASK_READY_TOOL",
    "DELETE_TASK_TOOL",
    "DB_LIST_TABLES_TOOL",
    "DB_DESCRIBE_TABLE_TOOL",
    "DB_LIST_FUNCTIONS_TOOL",
    "DB_LIST_RLS_POLICIES_TOOL",
    "DB_LIST_CONSTRAINTS_TOOL",
    "DB_EXECUTE_SELECT_TOOL",
    "DB_COUNT_ROWS_TOOL",
    "DEVOPS_LIST_SERVICES_TOOL",
    "DEVOPS_START_SERVICE_TOOL",
    "DEVOPS_STOP_SERVICE_TOOL",
    "DEVOPS_SERVICE_STATUS_TOOL",
    "DEVOPS_SERVICE_LOGS_TOOL",
    "DEVOPS_HEALTH_CHECK_TOOL",
    "DEVOPS_DOCKER_STATUS_TOOL",
    "DEVOPS_DOCKER_LOGS_TOOL",
    "DEVOPS_COMPOSE_UP_TOOL",
    "DEVOPS_COMPOSE_DOWN_TOOL",
    "DEVOPS_COMPOSE_BUILD_TOOL",
    "DEVOPS_COMPOSE_REBUILD_TOOL",
    "DEVOPS_COMPOSE_PS_TOOL",
    "DEVOPS_COMPOSE_LOGS_TOOL",
    "CREATE_CONTEXT_BUNDLE_TOOL",
    "GET_CONTEXT_BUNDLE_TOOL",
    "LIST_CONTEXT_BUNDLES_TOOL",
    "REFRESH_CONTEXT_BUNDLE_TOOL",
    "ADD_BUNDLE_SOURCE_TOOL",
    "REDIS_LIST_KEYS_TOOL",
    "REDIS_GET_KEY_TOOL",
    "REDIS_KEY_INFO_TOOL",
    "REDIS_DELETE_KEY_TOOL",
    "REDIS_STATS_TOOL",
    "UI_CONTROL_TOOL",
    "STATUS_MESSAGE_TOOL",
    # Git tools
    "GIT_STATUS_TOOL",
    "GIT_DIFF_TOOL",
    "GIT_LOG_TOOL",
    "GIT_BRANCH_TOOL",
    "GIT_ADD_TOOL",
    "GIT_COMMIT_TOOL",
    # Copywriting tools
    "ANALYZE_TONE_TOOL",
    "ANALYZE_READABILITY_TOOL",
    "ADJUST_TEMPERATURE_TOOL",
    "REWRITE_CONTENT_TOOL",
    "COPYWRITING_TOOLS",
    # Visualization tools
    "RENDER_MERMAID_TOOL",
    "GENERATE_IMAGE_TOOL",
    "RENDER_MARKDOWN_TOOL",
    "VISUALIZATION_TOOLS",
    # Workstream tool definitions
    "WORKSTREAM_CREATE_TOOL",
    "WORKSTREAM_SET_BRIEF_TOOL",
    "WORKSTREAM_ADVANCE_TO_DESIGN_TOOL",
    "WORKSTREAM_LIST_TOOL",
    "WORKSTREAM_TOOLS",
    # Functions
    "get_available_tools",
    "get_tools_description",
    "get_tool_by_name",
    "to_gemini_function_declarations",
    # Bespoke Agent Functions
    "get_tools_by_categories",
    "get_tools_by_names",
    "get_tools_description_for_names",
    # Plugin registration
    "register_plugin_tools",
]
