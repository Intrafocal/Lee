"""
Tool Scoping System - Controls which tools are available to subagents.

Implements hard enforcement of tool restrictions for subagent execution.
Tool availability is determined by the `environments` field on each ToolDefinition.
"""

from enum import Enum
from typing import List, Set

from .definitions import get_available_tools


class ToolCategory(str, Enum):
    """Categories for grouping tools by capability level."""
    OBSERVE = "observe"      # Read-only codebase access
    RESEARCH = "research"    # Observe + web/docs/db queries
    ACT = "act"              # Write files, run commands
    ORCHESTRATE = "orchestrate"  # Task/agent management (forbidden for subagents)


# Tool sets define which tools are available at each scope level
TOOL_SETS = {
    "observe": [
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
        # Git read-only tools
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
    ],
    "research": [
        # Include observe tools
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
        # Git read-only tools
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
        # Add research tools
        "web_search",
        "semantic_doc_search",
        "db_list_tables",
        "db_describe_table",
        "db_list_functions",
        "db_list_rls_policies",
        "db_list_constraints",
        "db_execute_select",
        "db_count_rows",
        "extract_doc_claims",
        "validate_claim",
        "find_doc_drift",
        "summarize",
        "get_context_bundle",
        "list_context_bundles",
        # Redis read-only tools
        "redis_list_keys",
        "redis_get_key",
        "redis_key_info",
        "redis_stats",
    ],
    "develop": [
        # Include observe tools
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
        # Git tools (read + write)
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
        "git_add",
        "git_commit",
        # Add development tools (note: actual write tools would go here)
        # For now, we don't have write_file/edit_file in Hester's tool set
        # as those are handled by Claude Code delegate
        "summarize",
    ],
    "full": [
        # All non-orchestration tools
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
        # Git tools (all)
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
        "git_add",
        "git_commit",
        "web_search",
        "semantic_doc_search",
        "db_list_tables",
        "db_describe_table",
        "db_list_functions",
        "db_list_rls_policies",
        "db_list_constraints",
        "db_execute_select",
        "db_count_rows",
        "extract_doc_claims",
        "validate_claim",
        "find_doc_drift",
        "summarize",
        "get_context_bundle",
        "list_context_bundles",
        "ui_control",
        "status_message",
        "devops_list_services",
        "devops_start_service",
        "devops_stop_service",
        "devops_service_status",
        "devops_service_logs",
        "devops_health_check",
        "devops_docker_status",
        "devops_docker_logs",
        "devops_compose_up",
        "devops_compose_down",
        "devops_compose_build",
        "devops_compose_rebuild",
        "devops_compose_ps",
        "devops_compose_logs",
        "create_context_bundle",
        "refresh_context_bundle",
        "add_bundle_source",
        # Redis tools (all, including delete)
        "redis_list_keys",
        "redis_get_key",
        "redis_key_info",
        "redis_delete_key",
        "redis_stats",
    ],
}


def _get_subagent_tools() -> Set[str]:
    """Get tools available in the subagent environment."""
    return {t.name for t in get_available_tools("subagent")}


class ForbiddenToolError(Exception):
    """Raised when a subagent attempts to use a forbidden tool."""

    def __init__(self, tool_name: str):
        self.tool_name = tool_name
        super().__init__(
            f"Tool '{tool_name}' is forbidden for subagents. "
            f"Subagents cannot orchestrate tasks or spawn other agents."
        )


def get_allowed_tools(
    toolset: str = "observe",
    is_subagent: bool = False,
    scoped_tools: List[str] = None,
) -> List[str]:
    """
    Get list of allowed tools based on toolset and subagent status.

    Args:
        toolset: The tool scope level ("observe", "research", "develop", "full")
        is_subagent: Whether this is a subagent (filters by environment="subagent")
        scoped_tools: Explicit list of tools to use (overrides toolset if provided)

    Returns:
        List of allowed tool names
    """
    # Start with explicit tool list if provided, else use toolset
    if scoped_tools:
        tools = set(scoped_tools)
    else:
        tools = set(TOOL_SETS.get(toolset, TOOL_SETS["observe"]))

    # Filter to subagent-allowed tools if running as subagent
    if is_subagent:
        subagent_tools = _get_subagent_tools()
        tools = tools & subagent_tools

    return list(tools)


def validate_tool_allowed(
    tool_name: str,
    allowed_tools: List[str],
    is_subagent: bool = False,
) -> None:
    """
    Validate that a tool is allowed. Raises ForbiddenToolError if not.

    This implements HARD enforcement - subagents cannot bypass restrictions.

    Args:
        tool_name: Name of the tool to validate
        allowed_tools: List of allowed tool names
        is_subagent: Whether this is a subagent

    Raises:
        ForbiddenToolError: If the tool is forbidden for subagents
        ValueError: If the tool is not in the allowed list
    """
    # Hard enforcement for subagents - check environment restrictions
    if is_subagent:
        subagent_tools = _get_subagent_tools()
        if tool_name not in subagent_tools:
            raise ForbiddenToolError(tool_name)

    # Check if tool is in the allowed list
    if tool_name not in allowed_tools:
        raise ValueError(
            f"Tool '{tool_name}' is not available in the current toolset. "
            f"Available tools: {', '.join(sorted(allowed_tools))}"
        )


def get_tool_category(tool_name: str) -> ToolCategory:
    """
    Determine the category of a tool based on its capabilities.

    Args:
        tool_name: Name of the tool

    Returns:
        ToolCategory for the tool
    """
    # Orchestration tools - not available in subagent environment
    subagent_tools = _get_subagent_tools()
    if tool_name not in subagent_tools:
        # Check if it exists at all (in daemon environment)
        daemon_tools = {t.name for t in get_available_tools("daemon")}
        if tool_name in daemon_tools:
            return ToolCategory.ORCHESTRATE

    # Observe-only tools (read-only codebase access)
    observe_tools = {
        "read_file", "search_files", "search_content", "list_directory", "change_directory",
        # Git read-only tools
        "git_status", "git_diff", "git_log", "git_branch",
    }
    if tool_name in observe_tools:
        return ToolCategory.OBSERVE

    # Research tools (read-only but includes external data)
    research_tools = {
        "web_search", "semantic_doc_search", "db_list_tables", "db_describe_table",
        "db_list_functions", "db_list_rls_policies", "db_list_constraints",
        "db_execute_select", "db_count_rows", "extract_doc_claims", "validate_claim",
        "find_doc_drift", "summarize", "get_context_bundle", "list_context_bundles",
        # Redis read-only tools
        "redis_list_keys", "redis_get_key", "redis_key_info", "redis_stats",
    }
    if tool_name in research_tools:
        return ToolCategory.RESEARCH

    # Everything else is an action tool
    return ToolCategory.ACT


def describe_toolset(toolset: str) -> str:
    """Get a human-readable description of a toolset's capabilities."""
    descriptions = {
        "observe": "Read-only access to files and codebase. Can search, read, and navigate but not modify.",
        "research": "Read-only access plus web search, database queries, and documentation analysis.",
        "develop": "Observe access plus ability to suggest code changes (delegated to Claude Code).",
        "full": "All tools except task orchestration (which is reserved for the main orchestrator).",
    }
    return descriptions.get(toolset, f"Unknown toolset: {toolset}")
