"""
Hester Daemon Tools - Tools for the ReAct loop.
"""

from .base import (
    ToolDefinition,
    HESTER_TOOLS,
    READ_FILE_TOOL,
    SEARCH_FILES_TOOL,
    SEARCH_CONTENT_TOOL,
    LIST_DIRECTORY_TOOL,
    CHANGE_DIRECTORY_TOOL,
    UI_CONTROL_TOOL,
    EXTRACT_DOC_CLAIMS_TOOL,
    VALIDATE_CLAIM_TOOL,
    FIND_DOC_DRIFT_TOOL,
    SEMANTIC_DOC_SEARCH_TOOL,
    # Web search tool definition
    WEB_SEARCH_TOOL,
    # Summarize tool definition
    SUMMARIZE_TOOL,
    # Task management tool definitions
    CREATE_TASK_TOOL,
    GET_TASK_TOOL,
    UPDATE_TASK_TOOL,
    LIST_TASKS_TOOL,
    ADD_BATCH_TOOL,
    ADD_CONTEXT_TOOL,
    MARK_TASK_READY_TOOL,
    DELETE_TASK_TOOL,
    # Database tool definitions
    DB_LIST_TABLES_TOOL,
    DB_DESCRIBE_TABLE_TOOL,
    DB_LIST_FUNCTIONS_TOOL,
    DB_LIST_RLS_POLICIES_TOOL,
    DB_LIST_CONSTRAINTS_TOOL,
    DB_EXECUTE_SELECT_TOOL,
    DB_COUNT_ROWS_TOOL,
    # DevOps tool definitions
    DEVOPS_LIST_SERVICES_TOOL,
    DEVOPS_START_SERVICE_TOOL,
    DEVOPS_STOP_SERVICE_TOOL,
    DEVOPS_SERVICE_STATUS_TOOL,
    DEVOPS_SERVICE_LOGS_TOOL,
    DEVOPS_HEALTH_CHECK_TOOL,
    DEVOPS_DOCKER_STATUS_TOOL,
    DEVOPS_DOCKER_LOGS_TOOL,
    # Docker Compose tool definitions
    DEVOPS_COMPOSE_UP_TOOL,
    DEVOPS_COMPOSE_DOWN_TOOL,
    DEVOPS_COMPOSE_BUILD_TOOL,
    DEVOPS_COMPOSE_REBUILD_TOOL,
    DEVOPS_COMPOSE_PS_TOOL,
    DEVOPS_COMPOSE_LOGS_TOOL,
    # Context Bundle tool definitions
    CREATE_CONTEXT_BUNDLE_TOOL,
    GET_CONTEXT_BUNDLE_TOOL,
    LIST_CONTEXT_BUNDLES_TOOL,
    REFRESH_CONTEXT_BUNDLE_TOOL,
    ADD_BUNDLE_SOURCE_TOOL,
    # Status Bar tool definition
    STATUS_MESSAGE_TOOL,
    # Environment-based tool filtering
    get_available_tools,
    get_tools_description,
)
from .file_read import read_file
from .file_search import search_files, search_content, list_directory, change_directory
from .doc_tools import (
    extract_doc_claims,
    validate_claim,
    find_doc_drift,
    semantic_doc_search,
    write_markdown,
    update_markdown,
)
from .ui_control import (
    execute_ui_control,
    open_tui,
    open_lazygit,
    open_lazydocker,
    open_k9s,
    open_flx,
    create_terminal_tab,
    open_file,
    focus_tab,
    close_tab,
    get_editor_context,
    # Status bar message handlers
    push_status_message,
    clear_status_message,
    clear_all_status_messages,
)
from .web_search import web_search, format_search_result
from .summarize import summarize_text, summarize_claude_output
from .db_tools import (
    list_tables as db_list_tables,
    describe_table as db_describe_table,
    list_functions as db_list_functions,
    list_rls_policies as db_list_rls_policies,
    list_column_constraints as db_list_constraints,
    execute_select as db_execute_select,
    count_rows as db_count_rows,
    close_db,
)
# DevOps tools require yaml - make import optional
try:
    from .devops_tools import (
        devops_list_services,
        devops_start_service,
        devops_stop_service,
        devops_service_status,
        devops_service_logs,
        devops_health_check,
        devops_docker_status,
        devops_docker_logs,
        # Docker Compose handlers
        devops_compose_up,
        devops_compose_down,
        devops_compose_build,
        devops_compose_rebuild,
        devops_compose_ps,
        devops_compose_logs,
    )
    DEVOPS_AVAILABLE = True
except ImportError:
    DEVOPS_AVAILABLE = False
    # Provide stubs
    devops_list_services = None
    devops_start_service = None
    devops_stop_service = None
    devops_service_status = None
    devops_service_logs = None
    devops_health_check = None
    devops_docker_status = None
    devops_docker_logs = None
    devops_compose_up = None
    devops_compose_down = None
    devops_compose_build = None
    devops_compose_rebuild = None
    devops_compose_ps = None
    devops_compose_logs = None
from .context_tools import (
    create_context_bundle,
    get_context_bundle,
    list_context_bundles,
    refresh_context_bundle,
    add_bundle_source,
)
# Git tools require GitPython - make import optional
try:
    from .git_tools import (
        git_status,
        git_diff,
        git_log,
        git_branch,
        git_add,
        git_commit,
        generate_commit_message,
    )
    GIT_AVAILABLE = True
except ImportError:
    GIT_AVAILABLE = False
    git_status = None
    git_diff = None
    git_log = None
    git_branch = None
    git_add = None
    git_commit = None
    generate_commit_message = None
from .copywriting_tools import (
    analyze_tone,
    analyze_readability,
    adjust_temperature,
    rewrite_content,
)
# Redis tools require redis - make import optional
try:
    from .redis_tools import (
        redis_list_keys,
        redis_get_key,
        redis_key_info,
        redis_delete_key,
        redis_stats,
    )
    REDIS_TOOLS_AVAILABLE = True
except ImportError:
    REDIS_TOOLS_AVAILABLE = False
    redis_list_keys = None
    redis_get_key = None
    redis_key_info = None
    redis_delete_key = None
    redis_stats = None
from .visualization_tools import (
    execute_render_mermaid,
    execute_generate_image,
    execute_render_markdown,
)
from .workstream_tools import (
    init_workstream_tools,
    execute_workstream_create,
    execute_workstream_set_brief,
    execute_workstream_advance_to_design,
    execute_workstream_list,
)

# Task management tools - import from tasks package
from ..tasks.tools import (
    init_task_store,
    get_store as get_task_store,
    create_task,
    get_task,
    update_task,
    list_tasks,
    delete_task,
    mark_task_ready,
    add_batch,
    add_context,
)

__all__ = [
    # Base
    "ToolDefinition",
    "HESTER_TOOLS",
    "get_tools_description",
    # File tool definitions
    "READ_FILE_TOOL",
    "SEARCH_FILES_TOOL",
    "SEARCH_CONTENT_TOOL",
    "LIST_DIRECTORY_TOOL",
    "CHANGE_DIRECTORY_TOOL",
    # UI control tool definition
    "UI_CONTROL_TOOL",
    # Doc tool definitions
    "EXTRACT_DOC_CLAIMS_TOOL",
    "VALIDATE_CLAIM_TOOL",
    "FIND_DOC_DRIFT_TOOL",
    "SEMANTIC_DOC_SEARCH_TOOL",
    # Web search tool definition
    "WEB_SEARCH_TOOL",
    # Summarize tool definition
    "SUMMARIZE_TOOL",
    # Task management tool definitions
    "CREATE_TASK_TOOL",
    "GET_TASK_TOOL",
    "UPDATE_TASK_TOOL",
    "LIST_TASKS_TOOL",
    "ADD_BATCH_TOOL",
    "ADD_CONTEXT_TOOL",
    "MARK_TASK_READY_TOOL",
    "DELETE_TASK_TOOL",
    # Database tool definitions
    "DB_LIST_TABLES_TOOL",
    "DB_DESCRIBE_TABLE_TOOL",
    "DB_LIST_FUNCTIONS_TOOL",
    "DB_LIST_RLS_POLICIES_TOOL",
    "DB_LIST_CONSTRAINTS_TOOL",
    "DB_EXECUTE_SELECT_TOOL",
    "DB_COUNT_ROWS_TOOL",
    # DevOps tool definitions
    "DEVOPS_LIST_SERVICES_TOOL",
    "DEVOPS_START_SERVICE_TOOL",
    "DEVOPS_STOP_SERVICE_TOOL",
    "DEVOPS_SERVICE_STATUS_TOOL",
    "DEVOPS_SERVICE_LOGS_TOOL",
    "DEVOPS_HEALTH_CHECK_TOOL",
    "DEVOPS_DOCKER_STATUS_TOOL",
    "DEVOPS_DOCKER_LOGS_TOOL",
    # File tool handlers
    "read_file",
    "search_files",
    "search_content",
    "list_directory",
    "change_directory",
    # UI control tool handlers
    "execute_ui_control",
    "open_tui",
    "open_lazygit",
    "open_lazydocker",
    "open_k9s",
    "open_flx",
    "create_terminal_tab",
    "open_file",
    "focus_tab",
    "close_tab",
    "get_editor_context",
    # Doc tool handlers
    "extract_doc_claims",
    "validate_claim",
    "find_doc_drift",
    "semantic_doc_search",
    "write_markdown",
    "update_markdown",
    # Web search tool handler
    "web_search",
    "format_search_result",
    # Summarize tool handlers
    "summarize_text",
    "summarize_claude_output",
    # Database tool handlers
    "db_list_tables",
    "db_describe_table",
    "db_list_functions",
    "db_list_rls_policies",
    "db_list_constraints",
    "db_execute_select",
    "db_count_rows",
    "close_db",
    # Task management tool handlers
    "init_task_store",
    "get_task_store",
    "create_task",
    "get_task",
    "update_task",
    "list_tasks",
    "delete_task",
    "mark_task_ready",
    "add_batch",
    "add_context",
    # DevOps tool handlers
    "devops_list_services",
    "devops_start_service",
    "devops_stop_service",
    "devops_service_status",
    "devops_service_logs",
    "devops_health_check",
    "devops_docker_status",
    "devops_docker_logs",
    # Docker Compose tool handlers
    "devops_compose_up",
    "devops_compose_down",
    "devops_compose_build",
    "devops_compose_rebuild",
    "devops_compose_ps",
    "devops_compose_logs",
    # Docker Compose tool definitions
    "DEVOPS_COMPOSE_UP_TOOL",
    "DEVOPS_COMPOSE_DOWN_TOOL",
    "DEVOPS_COMPOSE_BUILD_TOOL",
    "DEVOPS_COMPOSE_REBUILD_TOOL",
    "DEVOPS_COMPOSE_PS_TOOL",
    "DEVOPS_COMPOSE_LOGS_TOOL",
    # Context Bundle tool definitions
    "CREATE_CONTEXT_BUNDLE_TOOL",
    "GET_CONTEXT_BUNDLE_TOOL",
    "LIST_CONTEXT_BUNDLES_TOOL",
    "REFRESH_CONTEXT_BUNDLE_TOOL",
    "ADD_BUNDLE_SOURCE_TOOL",
    # Context Bundle tool handlers
    "create_context_bundle",
    "get_context_bundle",
    "list_context_bundles",
    "refresh_context_bundle",
    "add_bundle_source",
    # Status Bar tool definition
    "STATUS_MESSAGE_TOOL",
    # Status Bar tool handlers
    "push_status_message",
    "clear_status_message",
    "clear_all_status_messages",
    # Git tool handlers
    "git_status",
    "git_diff",
    "git_log",
    "git_branch",
    "git_add",
    "git_commit",
    "generate_commit_message",
    # Copywriting tool handlers
    "analyze_tone",
    "analyze_readability",
    "adjust_temperature",
    "rewrite_content",
    # Redis tool handlers
    "redis_list_keys",
    "redis_get_key",
    "redis_key_info",
    "redis_delete_key",
    "redis_stats",
    # Visualization tool handlers
    "execute_render_mermaid",
    "execute_generate_image",
    "execute_render_markdown",
    # Workstream tool handlers
    "init_workstream_tools",
    "execute_workstream_create",
    "execute_workstream_set_brief",
    "execute_workstream_advance_to_design",
    "execute_workstream_list",
    # Environment-based tool filtering
    "get_available_tools",
]
