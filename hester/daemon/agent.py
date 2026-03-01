"""
Hester Daemon Agent - ReAct loop with thinking depth for code exploration.

Uses a text-based ReAct pattern: THINK → ACT → OBSERVE → RESPOND

Thinking Depth Tiers:
- Quick (Tier 0): gemini-2.5-flash-lite - Simple tasks
- Standard (Tier 1): gemini-2.5-flash - Normal tasks
- Deep (Tier 2): gemini-3-flash-preview - Complex analysis
- Reasoning (Tier 3): gemini-3.1-pro-preview - Deep reasoning

Users can override with /quick, /deep, or /reason prefixes.
"""

import asyncio
import logging
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple, TYPE_CHECKING
from functools import partial

if TYPE_CHECKING:
    from .lee_client import LeeContextClient
    from .knowledge import KnowledgeEngine, WarmContext
    from .semantic import SemanticRouter
    from .semantic.embeddings import EmbeddingService

from .models import (
    ContextRequest,
    ContextResponse,
    EditorCommand,
    CommandType,
    Thought,
    PlannedAction,
    Observation,
    ReActTrace,
    InferenceBudget,
)
from .session import HesterSession, SessionManager
from .settings import HesterDaemonSettings
from .thinking_depth import (
    ThinkingDepth,
    DepthClassification,
    classify_complexity,
    get_model_for_depth,
    get_cloud_model_for_depth,
)
from .tools import (
    HESTER_TOOLS,
    get_available_tools,
    get_tools_description,
    read_file,
    search_files,
    search_content,
    list_directory,
    change_directory,
    extract_doc_claims,
    validate_claim,
    find_doc_drift,
    semantic_doc_search,
    write_markdown,
    update_markdown,
    # Web search
    web_search,
    # Database tools
    db_list_tables,
    db_describe_table,
    db_list_functions,
    db_list_rls_policies,
    db_list_constraints,
    db_execute_select,
    db_count_rows,
    # Task management tools
    init_task_store,
    create_task,
    get_task,
    update_task,
    list_tasks,
    delete_task,
    mark_task_ready,
    add_batch,
    add_context,
    # UI control
    execute_ui_control,
    # Status bar message handlers
    push_status_message,
    clear_status_message,
    clear_all_status_messages,
    # DevOps tools
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
    # Context Bundle tools
    create_context_bundle,
    get_context_bundle,
    list_context_bundles,
    refresh_context_bundle,
    add_bundle_source,
    # Git tools
    git_status,
    git_diff,
    git_log,
    git_branch,
    git_add,
    git_commit,
    # Copywriting tools
    analyze_tone,
    analyze_readability,
    adjust_temperature,
    rewrite_content,
    # Redis tools
    redis_list_keys,
    redis_get_key,
    redis_key_info,
    redis_delete_key,
    redis_stats,
    # Summarize tool
    summarize_text,
    # Visualization tools
    execute_render_mermaid,
    execute_generate_image,
    execute_render_markdown,
    # Workstream tools
    execute_workstream_create,
    execute_workstream_set_brief,
    execute_workstream_advance_to_design,
    execute_workstream_list,
)
from ..shared.gemini_tools import HybridGeminiCapability, ToolResult, PhaseCallback, PhaseUpdate, ReActPhase
from .prepare import (
    prepare_request,
    detect_task,
    detect_shortcut,
    ShortcutResult,
    ShortcutType,
    OllamaFunctionGemma,
    OllamaGemmaClient,
    WarmContextManager,
    PrepareResult,
    TaskDetectionResult,
    RequestType,
    TaskType,
)

# Import registries for bespoke agent prompts
try:
    from .registries import get_prompt_registry, PromptMatch
    REGISTRIES_AVAILABLE = True
except ImportError:
    REGISTRIES_AVAILABLE = False
    get_prompt_registry = None  # type: ignore
    PromptMatch = None  # type: ignore

# Import tools description generator
from .tools.definitions import get_tools_description_for_names

logger = logging.getLogger("hester.daemon.agent")


# Command prefixes for manual depth override
# Simplified to 6 clear tiers: 2 local + 4 cloud
DEPTH_COMMANDS = {
    # Local tiers (Ollama)
    "/local": ThinkingDepth.LOCAL,        # gemma3n - fast local
    "/deeplocal": ThinkingDepth.DEEPLOCAL,  # gemma3 - complex local
    # Cloud tiers (Gemini)
    "/quick": ThinkingDepth.QUICK,        # gemini-2.5-flash - fast cloud
    "/standard": ThinkingDepth.STANDARD,  # gemini-2.5-flash - balanced
    "/deep": ThinkingDepth.DEEP,          # gemini-3-flash - complex
    "/pro": ThinkingDepth.PRO,            # gemini-3-pro - reasoning
}


class HesterDaemonAgent(HybridGeminiCapability):
    """
    Hester daemon agent for code exploration with thinking depth.

    Handles requests from the Lee editor, uses tools to explore code,
    and returns responses with optional editor commands.

    Thinking Depth:
    - Automatically classifies message complexity
    - Selects appropriate model tier
    - Users can override with /local, /deeplocal, /quick, /standard, /deep, /pro
    """

    def __init__(
        self,
        settings: HesterDaemonSettings,
        session_manager: SessionManager,
        lee_client: Optional["LeeContextClient"] = None,
        knowledge_engine: Optional["KnowledgeEngine"] = None,
        semantic_router: Optional["SemanticRouter"] = None,
        embedding_service: Optional["EmbeddingService"] = None,
        environment: str = "daemon",
    ):
        """
        Initialize the daemon agent.

        Args:
            settings: Daemon configuration
            session_manager: Redis session manager
            lee_client: Optional Lee context client for live IDE context
            knowledge_engine: Optional KnowledgeEngine for proactive context loading
            semantic_router: Optional SemanticRouter for tool pre-filtering
            embedding_service: Optional EmbeddingService for bespoke agent routing
            environment: Runtime environment (daemon, cli, tui, slack, agent)
        """
        # Initialize Gemini tool capability with default model
        super().__init__(
            api_key=settings.google_api_key.get_secret_value(),
            model=settings.gemini_model,
        )

        self.settings = settings
        self.sessions = session_manager
        self.lee_client = lee_client
        self.knowledge_engine = knowledge_engine
        self.semantic_router = semantic_router
        self.embedding_service = embedding_service
        self._base_environment = environment

        # Warning flag for Redis unavailability (shown once per session)
        self._redis_warning_shown = False

        # Lee connection state helper
        self._is_lee_connected = lambda: bool(self.lee_client and self.lee_client.connected)

        # Build model tier map
        self._model_tiers = {
            "quick": settings.gemini_model_quick,
            "standard": settings.gemini_model_standard,
            "deep": settings.gemini_model_deep,
            "reasoning": settings.gemini_model_reasoning,
        }

        # Build iteration limit map per depth
        self._iteration_limits = {
            ThinkingDepth.QUICK: settings.max_iterations_quick,
            ThinkingDepth.STANDARD: settings.max_iterations_standard,
            ThinkingDepth.DEEP: settings.max_iterations_deep,
            ThinkingDepth.REASONING: settings.max_iterations_reasoning,
        }

        # Plugin loader (set externally by main.py after plugin loading)
        self._plugin_loader = None

        # Register tools with handlers
        self._register_hester_tools()

        # Initialize Ollama client for prepare step (FunctionGemma)
        self._ollama_client: Optional[OllamaFunctionGemma] = None
        if settings.ollama_enabled and settings.prepare_step_enabled:
            self._ollama_client = OllamaFunctionGemma(
                ollama_url=settings.ollama_url,
                timeout=settings.ollama_timeout,
            )
            logger.info(f"Prepare step enabled: Ollama at {settings.ollama_url}")

        # Initialize local Gemma client for hybrid ReAct loop
        self._local_client: Optional[OllamaGemmaClient] = None
        self._warm_context: Optional[WarmContextManager] = None
        if settings.hybrid_routing_enabled and settings.gemma3n_enabled:
            self._local_client = OllamaGemmaClient(
                ollama_url=settings.ollama_url,
                default_timeout_ms=settings.local_timeout_ms,
                warm_context_ttl_seconds=settings.warm_context_ttl_seconds,
            )
            if settings.warm_context_enabled:
                self._warm_context = WarmContextManager(
                    client=self._local_client,
                    ttl_seconds=settings.warm_context_ttl_seconds,
                )
            logger.info(
                f"Hybrid routing enabled: local models for OBSERVE/THINK, "
                f"timeout={settings.local_timeout_ms}ms, warm_context={settings.warm_context_enabled}"
            )

        # Log knowledge engine state
        if self.knowledge_engine:
            logger.info(
                f"Knowledge engine enabled: "
                f"bundle_threshold={settings.knowledge_bundle_threshold}, "
                f"doc_threshold={settings.knowledge_doc_threshold}, "
                f"max_warm_tokens={settings.knowledge_max_warm_tokens}"
            )
        else:
            logger.info("Knowledge engine: disabled (not initialized)")

        # Log semantic router state
        if self.semantic_router:
            logger.info(
                f"Semantic router enabled: "
                f"tool_threshold={settings.semantic_tool_threshold}, "
                f"max_tools={settings.semantic_tool_max}"
            )
        else:
            logger.info("Semantic router: disabled (not initialized)")

        logger.info(
            f"Thinking depth enabled: {settings.thinking_depth_enabled}, "
            f"Prepare step enabled: {settings.prepare_step_enabled}, "
            f"Hybrid routing enabled: {settings.hybrid_routing_enabled}, "
            f"Models: quick={settings.gemini_model_quick}, "
            f"standard={settings.gemini_model_standard}, "
            f"deep={settings.gemini_model_deep}, "
            f"reasoning={settings.gemini_model_reasoning}, "
            f"Iterations: quick={settings.max_iterations_quick}, "
            f"standard={settings.max_iterations_standard}, "
            f"deep={settings.max_iterations_deep}, "
            f"reasoning={settings.max_iterations_reasoning}"
        )

    @property
    def environment(self) -> str:
        """Get the environment for tool filtering."""
        return self._base_environment

    def _get_max_iterations(self, depth: ThinkingDepth) -> int:
        """Get the maximum iterations allowed for a thinking depth."""
        return self._iteration_limits.get(depth, self.settings.max_iterations_standard)

    def _create_budget_for_depth(self, depth: ThinkingDepth) -> InferenceBudget:
        """Create an inference budget based on thinking depth."""
        budget_cloud_calls = {
            ThinkingDepth.QUICK: self.settings.budget_cloud_calls_quick,
            ThinkingDepth.STANDARD: self.settings.budget_cloud_calls_standard,
            ThinkingDepth.DEEP: self.settings.budget_cloud_calls_deep,
            ThinkingDepth.REASONING: self.settings.budget_cloud_calls_reasoning,
        }
        budget_cloud_tokens = {
            ThinkingDepth.QUICK: self.settings.budget_cloud_tokens_quick,
            ThinkingDepth.STANDARD: self.settings.budget_cloud_tokens_standard,
            ThinkingDepth.DEEP: self.settings.budget_cloud_tokens_deep,
            ThinkingDepth.REASONING: self.settings.budget_cloud_tokens_reasoning,
        }

        return InferenceBudget(
            cloud_calls_remaining=budget_cloud_calls.get(depth, self.settings.budget_cloud_calls_standard),
            cloud_tokens_remaining=budget_cloud_tokens.get(depth, self.settings.budget_cloud_tokens_standard),
            local_calls_remaining=self.settings.budget_local_calls_default,
            local_time_budget_ms=self.settings.budget_local_time_ms_default,
        )

    def _parse_depth_command(self, message: str) -> Tuple[Optional[ThinkingDepth], str]:
        """
        Parse depth command prefix from message.

        Args:
            message: User message that may start with /quick, /deep, etc.

        Returns:
            Tuple of (explicit depth or None, cleaned message)
        """
        message_lower = message.lower().strip()

        for cmd, depth in DEPTH_COMMANDS.items():
            if message_lower.startswith(cmd):
                # Remove the command prefix
                cleaned = message[len(cmd):].strip()
                logger.info(f"Depth command detected: {cmd} -> {depth.name}")
                return depth, cleaned

        return None, message

    def _determine_thinking_depth(
        self,
        message: str,
        explicit_depth: Optional[ThinkingDepth] = None,
    ) -> Tuple[ThinkingDepth, str, DepthClassification]:
        """
        Determine the thinking depth for a message.

        Args:
            message: User message
            explicit_depth: Explicitly requested depth (from command)

        Returns:
            Tuple of (depth, model_name, classification)
        """
        if explicit_depth is not None:
            # User explicitly requested a depth
            model = get_model_for_depth(explicit_depth, self._model_tiers)
            classification = DepthClassification(
                depth=explicit_depth,
                confidence=1.0,
                reason="User explicitly requested via command",
                signals=["explicit_command"],
            )
            return explicit_depth, model, classification

        if not self.settings.thinking_depth_enabled:
            # Thinking depth disabled, use default
            return (
                ThinkingDepth.STANDARD,
                self.settings.gemini_model,
                DepthClassification(
                    depth=ThinkingDepth.STANDARD,
                    confidence=1.0,
                    reason="Thinking depth disabled",
                    signals=["disabled"],
                ),
            )

        # Classify message complexity
        classification = classify_complexity(message)
        model = get_model_for_depth(classification.depth, self._model_tiers)

        logger.info(
            f"Classified depth: {classification.depth.name} "
            f"(confidence={classification.confidence:.2f}, "
            f"reason={classification.reason})"
        )

        return classification.depth, model, classification

    def _register_hester_tools(self) -> None:
        """Register Hester tools filtered by environment."""
        # Get tools filtered by environment (slack, daemon, lee, etc.)
        available_tools = get_available_tools(self._base_environment)

        # Convert to format expected by GeminiToolCapability
        tools = []
        for tool in available_tools:
            tools.append({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })

        # Tool handlers will be created per-request with working_dir bound
        self._tool_definitions = tools
        logger.info(f"Registered {len(tools)} tools for environment={self._base_environment}")

    def _create_tool_handlers(
        self,
        working_dir: str,
    ) -> Dict[str, Any]:
        """
        Create tool handlers bound to a specific working directory.

        Args:
            working_dir: Working directory for file operations

        Returns:
            Dict mapping tool names to handler functions
        """
        from pathlib import Path

        # Initialize task store for this working directory
        init_task_store(working_dir=Path(working_dir))

        handlers = {
            # File tools
            "read_file": partial(read_file, working_dir=working_dir),
            "search_files": partial(search_files, working_dir=working_dir),
            "search_content": partial(search_content, working_dir=working_dir),
            "list_directory": partial(list_directory, working_dir=working_dir),
            "change_directory": partial(change_directory, working_dir=working_dir),
            # Documentation tools
            "extract_doc_claims": partial(extract_doc_claims, working_dir=working_dir),
            "validate_claim": partial(validate_claim, working_dir=working_dir),
            "find_doc_drift": partial(find_doc_drift, working_dir=working_dir),
            "semantic_doc_search": partial(semantic_doc_search, working_dir=working_dir),
            "write_markdown": partial(write_markdown, working_dir=working_dir),
            "update_markdown": partial(update_markdown, working_dir=working_dir),
            # Web search (no working_dir needed)
            "web_search": web_search,
            # Database tools (no working_dir needed)
            "db_list_tables": db_list_tables,
            "db_describe_table": db_describe_table,
            "db_list_functions": db_list_functions,
            "db_list_rls_policies": db_list_rls_policies,
            "db_list_constraints": db_list_constraints,
            "db_execute_select": db_execute_select,
            "db_count_rows": db_count_rows,
            # Task management tools (use initialized store)
            "create_task": create_task,
            "get_task": get_task,
            "update_task": update_task,
            "list_tasks": list_tasks,
            "delete_task": delete_task,
            "mark_task_ready": mark_task_ready,
            "add_batch": add_batch,
            "add_context": add_context,
            # UI control (for Lee/Mosaic IDE integration) - filtered at prepare time if not connected
            "ui_control": execute_ui_control,
            # DevOps tools (service management)
            "devops_list_services": partial(devops_list_services, working_dir=working_dir),
            "devops_start_service": partial(devops_start_service, working_dir=working_dir),
            "devops_stop_service": partial(devops_stop_service, working_dir=working_dir),
            "devops_service_status": partial(devops_service_status, working_dir=working_dir),
            "devops_service_logs": partial(devops_service_logs, working_dir=working_dir),
            "devops_health_check": partial(devops_health_check, working_dir=working_dir),
            "devops_docker_status": devops_docker_status,
            "devops_docker_logs": devops_docker_logs,
            # Docker Compose tools
            "devops_compose_up": partial(devops_compose_up, working_dir=working_dir),
            "devops_compose_down": partial(devops_compose_down, working_dir=working_dir),
            "devops_compose_build": partial(devops_compose_build, working_dir=working_dir),
            "devops_compose_rebuild": partial(devops_compose_rebuild, working_dir=working_dir),
            "devops_compose_ps": partial(devops_compose_ps, working_dir=working_dir),
            "devops_compose_logs": partial(devops_compose_logs, working_dir=working_dir),
            # Context Bundle tools
            "create_context_bundle": partial(create_context_bundle, working_dir=working_dir),
            "get_context_bundle": partial(get_context_bundle, working_dir=working_dir),
            "list_context_bundles": partial(list_context_bundles, working_dir=working_dir),
            "refresh_context_bundle": partial(refresh_context_bundle, working_dir=working_dir),
            "add_bundle_source": partial(add_bundle_source, working_dir=working_dir),
            # Status bar message tool
            "status_message": self._handle_status_message,
            # Git tools
            "git_status": partial(git_status, working_dir=working_dir),
            "git_diff": partial(git_diff, working_dir=working_dir),
            "git_log": partial(git_log, working_dir=working_dir),
            "git_branch": partial(git_branch, working_dir=working_dir),
            "git_add": partial(git_add, working_dir=working_dir),
            "git_commit": partial(git_commit, working_dir=working_dir),
            # Copywriting tools (no working_dir needed)
            "analyze_tone": analyze_tone,
            "analyze_readability": analyze_readability,
            "adjust_temperature": adjust_temperature,
            "rewrite_content": rewrite_content,
            # Redis tools (no working_dir needed)
            "redis_list_keys": redis_list_keys,
            "redis_get_key": redis_get_key,
            "redis_key_info": redis_key_info,
            "redis_delete_key": redis_delete_key,
            "redis_stats": redis_stats,
            # Summarize tool (no working_dir needed)
            "summarize": summarize_text,
            # Visualization tools
            "render_mermaid": execute_render_mermaid,
            "generate_image": execute_generate_image,
            "render_markdown": execute_render_markdown,
            # Workstream tools (no working_dir needed - use orchestrator)
            "workstream_create": execute_workstream_create,
            "workstream_set_brief": execute_workstream_set_brief,
            "workstream_advance_to_design": execute_workstream_advance_to_design,
            "workstream_list": execute_workstream_list,
        }

        # Plugin tool handlers
        if self._plugin_loader:
            for plugin in self._plugin_loader.loaded.values():
                for name, handler in plugin.tool_handlers.items():
                    handlers[name] = handler

        return handlers

    def _build_system_prompt(
        self,
        session: HesterSession,
        warm_context: Optional["WarmContext"] = None,
        prepare_result: Optional[PrepareResult] = None,
    ) -> str:
        """
        Build the system prompt using the bespoke agent registry.

        Loads the prompt template from the registry based on prepare_result.prompt_id
        and substitutes working directory, tools, and editor context.

        Args:
            session: Current session with editor state
            warm_context: Optional pre-loaded knowledge context from KnowledgeEngine
            prepare_result: Prepare result with prompt_id and tool list

        Returns:
            Complete system prompt with all context sections
        """
        # Build editor context section from multiple sources
        editor_context = self._build_editor_context(session)

        # Build tools description from prepare result's tool list
        tool_names = prepare_result.relevant_tools if prepare_result else None
        if tool_names:
            tools_description = get_tools_description_for_names(tool_names)
        else:
            # Fallback: use all tools
            from .tools import get_tools_description
            tools_description = get_tools_description()

        # Get prompt template from registry
        prompt_id = prepare_result.prompt_id if prepare_result else "general"
        base_prompt = self._get_prompt_from_registry(
            prompt_id=prompt_id,
            working_dir=session.working_directory,
            tools_description=tools_description,
            editor_context=editor_context,
        )

        # Inject warm context from KnowledgeEngine (proactive loading)
        if warm_context is not None:
            warm_section = warm_context.to_prompt_section()
            if warm_section:
                base_prompt += f"\n\n## Pre-loaded Knowledge Context\n{warm_section}"
                logger.debug(
                    f"Injected warm context: {len(warm_context.bundles)} bundles, "
                    f"{len(warm_context.docs)} docs, ~{warm_context.token_estimate} tokens"
                )

        return base_prompt

    def _build_editor_context(self, session: HesterSession) -> str:
        """Build the editor context section from multiple sources."""
        editor_context_parts = []

        # 1. Live context from Lee IDE (via WebSocket)
        if self.lee_client and self.lee_client.connected:
            live_ctx = self.lee_client.context
            if live_ctx:
                # Current editor state
                if live_ctx.editor and live_ctx.editor.file:
                    editor_context_parts.append(f"Current file open in editor: {live_ctx.editor.file}")
                    if live_ctx.editor.language:
                        editor_context_parts.append(f"Language: {live_ctx.editor.language}")
                    if live_ctx.editor.cursor:
                        editor_context_parts.append(
                            f"Cursor at line {live_ctx.editor.cursor.line}, column {live_ctx.editor.cursor.column}"
                        )
                    if live_ctx.editor.selection:
                        editor_context_parts.append(
                            f"Selected text:\n```\n{live_ctx.editor.selection}\n```"
                        )
                    if live_ctx.editor.modified:
                        editor_context_parts.append("(file has unsaved changes)")

                # Focused panel and tabs
                editor_context_parts.append(f"\nFocused panel: {live_ctx.focused_panel}")

                # List open tabs with their types
                if live_ctx.tabs:
                    tab_summary = []
                    for tab in live_ctx.tabs:
                        state_indicator = "→" if tab.state == "active" else " "
                        tab_summary.append(f"  {state_indicator} [{tab.type}] {tab.label}")
                    editor_context_parts.append(f"Open tabs:\n" + "\n".join(tab_summary))

                # Activity context
                if live_ctx.activity:
                    idle = live_ctx.activity.idle_seconds
                    if idle > 60:
                        editor_context_parts.append(f"\nUser idle for {int(idle)}s")

                    # Recent actions (last 5)
                    if live_ctx.activity.recent_actions:
                        recent = live_ctx.activity.recent_actions[-5:]
                        actions_summary = [f"  - {a.type}: {a.target}" for a in recent]
                        editor_context_parts.append(f"Recent actions:\n" + "\n".join(actions_summary))

        # 2. Fallback to session-based context (from HTTP request)
        elif session.editor_state:
            state = session.editor_state
            if state.active_file:
                editor_context_parts.append(f"Active file: {state.active_file}")
            if state.cursor_line:
                editor_context_parts.append(f"Cursor at line: {state.cursor_line}")

        # 3. File context from explicit selection
        if session.last_file_context:
            ctx = session.last_file_context
            if ctx.selected_text:
                editor_context_parts.append(
                    f"Selected text:\n```\n{ctx.selected_text}\n```"
                )
            if ctx.visible_range:
                editor_context_parts.append(
                    f"Visible lines: {ctx.visible_range[0]}-{ctx.visible_range[1]}"
                )

        return "\n".join(editor_context_parts) if editor_context_parts else "No specific context from editor."

    def _get_prompt_from_registry(
        self,
        prompt_id: str,
        working_dir: str,
        tools_description: str,
        editor_context: str,
    ) -> str:
        """
        Load and format a prompt template from the registry.

        Args:
            prompt_id: ID of the prompt to load (e.g., "general", "code_analysis")
            working_dir: Current working directory
            tools_description: Formatted description of available tools
            editor_context: Editor context section

        Returns:
            Formatted prompt with all placeholders substituted
        """
        if not REGISTRIES_AVAILABLE:
            logger.warning("Registries not available, using fallback prompt")
            return self._build_fallback_prompt(working_dir, tools_description, editor_context)

        try:
            registry = get_prompt_registry()
            template = registry.get_content(prompt_id)

            # Substitute placeholders
            prompt = template.format(
                working_dir=working_dir,
                tools_description=tools_description,
                editor_context=editor_context,
            )

            logger.debug(f"Loaded prompt '{prompt_id}' from registry")
            return prompt

        except Exception as e:
            logger.warning(f"Failed to load prompt '{prompt_id}' from registry: {e}")
            return self._build_fallback_prompt(working_dir, tools_description, editor_context)

    def _build_fallback_prompt(
        self,
        working_dir: str,
        tools_description: str,
        editor_context: str,
    ) -> str:
        """Build a fallback prompt when registry is unavailable."""
        return f"""You are Hester, an AI assistant for code exploration and development tasks.

## Working Directory
You are operating in: {working_dir}

## Available Tools
{tools_description}

## Guidelines
- Use available tools to explore and understand the codebase
- Be concise and direct in your responses
- Provide specific details (file paths, line numbers) when relevant
- If you can't find something, say so clearly

## Context from Editor
{editor_context}
"""

    async def process_context(
        self,
        request: ContextRequest,
        phase_callback: Optional[PhaseCallback] = None,
    ) -> ContextResponse:
        """
        Process a context request from Lee editor.

        Args:
            request: Context request with user message and editor state
            phase_callback: Optional callback for real-time phase updates

        Returns:
            Response with Hester's answer and optional commands
        """
        trace_id = f"react-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        started_at = datetime.now()

        # Parse depth command from message
        user_message = request.message or ""
        explicit_depth, cleaned_message = self._parse_depth_command(user_message)

        # Extract working directory from editor_state or use default
        working_dir = (
            request.editor_state.working_directory
            if request.editor_state
            else self.settings.working_directory or "."
        )

        # =====================================================================
        # SHORTCUT DETECTION - Fast path for simple commands like cd, ls, cat
        # =====================================================================
        shortcut = detect_shortcut(cleaned_message)
        if shortcut.is_shortcut and shortcut.tool_name:
            logger.info(f"Shortcut detected: {shortcut.tool_name} - {shortcut.reason}")
            shortcut_response = await self._execute_shortcut(
                request=request,
                shortcut=shortcut,
                working_dir=working_dir,
                trace_id=trace_id,
                started_at=started_at,
                phase_callback=phase_callback,
            )
            if shortcut_response:
                return shortcut_response
            # If shortcut execution failed, fall through to normal flow
            logger.warning(f"Shortcut execution failed, falling back to normal flow")

        # Get file context for prepare step
        file_context_hint = (
            request.editor_state.active_file
            if request.editor_state and hasattr(request.editor_state, 'active_file')
            else None
        )

        # Run prepare step for depth classification, tool selection, and task detection
        prepare_result: Optional[PrepareResult] = None
        task_detection: Optional[TaskDetectionResult] = None
        tool_filter: Optional[List[str]] = None

        if self.settings.prepare_step_enabled:
            # Notify PREPARE phase (always local - uses FunctionGemma or heuristic)
            if phase_callback:
                await phase_callback(PhaseUpdate(
                    phase=ReActPhase.PREPARE,
                    iteration=0,
                    is_local=True,
                    precision="local",
                ))

            # Run prepare_request and detect_task concurrently
            prepare_result, task_detection = await asyncio.gather(
                prepare_request(
                    message=cleaned_message,
                    explicit_depth=explicit_depth,
                    file_context=file_context_hint,
                    ollama_client=self._ollama_client,
                    environment=self.environment,
                    # Pass semantic router for tool pre-filtering
                    semantic_router=self.semantic_router if self.settings.use_semantic_tool_routing else None,
                    semantic_threshold=self.settings.semantic_tool_threshold,
                    semantic_max_tools=self.settings.semantic_tool_max,
                    # Pass embedding service for bespoke agent routing
                    embedding_service=self.embedding_service,
                    use_bespoke_routing=self.settings.use_bespoke_routing if hasattr(self.settings, 'use_bespoke_routing') else True,
                ),
                detect_task(
                    message=cleaned_message,
                    ollama_client=self._ollama_client,
                    environment=self.environment,
                ),
            )

            # Merge task detection into prepare result
            prepare_result.request_type = task_detection.request_type
            prepare_result.task_type = task_detection.task_type

            # If task detected, ensure task tools are included
            if task_detection.request_type == RequestType.TASK and task_detection.suggested_tools:
                current_tools = set(prepare_result.relevant_tools) if prepare_result.relevant_tools else set()
                current_tools.update(task_detection.suggested_tools)
                prepare_result.relevant_tools = list(current_tools)

            # Use prepare result for depth and tools
            depth = prepare_result.thinking_depth
            # For local tiers, get the cloud fallback model (used when hybrid loop falls back to cloud)
            # The actual local model is in prepare_result.think_model
            from .thinking_depth import is_local_depth, get_cloud_model_for_depth
            if is_local_depth(depth):
                model = get_cloud_model_for_depth(depth)
            else:
                model = get_model_for_depth(depth, self._model_tiers)
            classification = DepthClassification(
                depth=depth,
                confidence=prepare_result.confidence,
                reason=prepare_result.reason,
                signals=["prepare_step"] if not prepare_result.used_fallback else ["prepare_fallback"],
            )
            tool_filter = prepare_result.relevant_tools if prepare_result.relevant_tools else None

            # Update phase callback with prepare result
            if phase_callback:
                # PREPARE always uses local FunctionGemma (or heuristic fallback which is also local)
                prepare_model = "functiongemma" if not prepare_result.used_fallback else "heuristic"
                await phase_callback(PhaseUpdate(
                    phase=ReActPhase.PREPARE,
                    iteration=0,
                    model_used=prepare_model,
                    tools_selected=len(prepare_result.relevant_tools) if prepare_result.relevant_tools else 0,
                    prepare_time_ms=prepare_result.prepare_time_ms,
                    # PREPARE is always local (FunctionGemma or heuristic)
                    is_local=True,
                    precision="local",
                    # Include semantic routing info
                    prompt_id=prepare_result.prompt_id,
                    agent_id=prepare_result.agent_id,
                    routing_reason=prepare_result.routing_reason,
                ))

            # Log task detection result with routing info
            task_type_str = task_detection.task_type.value if task_detection.task_type else "none"
            routing_str = ""
            if prepare_result.agent_id:
                routing_str = f", agent=@{prepare_result.agent_id}"
            elif prepare_result.prompt_id and prepare_result.prompt_id != "general":
                routing_str = f", prompt=#{prepare_result.prompt_id}"
            if prepare_result.routing_reason:
                routing_str += f" ({prepare_result.routing_reason[:50]}...)" if len(prepare_result.routing_reason) > 50 else f" ({prepare_result.routing_reason})"
            logger.info(
                f"Prepare step: depth={depth.name}, tools={len(prepare_result.relevant_tools)}, "
                f"time={prepare_result.prepare_time_ms:.1f}ms, fallback={prepare_result.used_fallback}, "
                f"request_type={task_detection.request_type.value}, task_type={task_type_str}{routing_str}"
            )
        else:
            # Original flow without prepare step
            depth, model, classification = self._determine_thinking_depth(
                cleaned_message,
                explicit_depth,
            )

        logger.info(
            f"Processing with depth={depth.name}, model={model}, "
            f"reason={classification.reason}"
        )

        # Get or create session
        session = await self.sessions.get_or_create(
            session_id=request.session_id,
            working_directory=working_dir,
        )

        # Update editor state if provided
        if request.editor_state:
            session.update_editor_state(request.editor_state)

        # Build file context from request fields if provided
        if request.file and request.content:
            from .models import FileContext
            file_context = FileContext(
                file_path=request.file,
                line_start=request.line_start or 1,
                line_end=request.line_end or 1,
                content=request.content,
                language=request.language,
            )
            session.update_file_context(file_context)

        # Add cleaned user message to history (without command prefix)
        session.add_message("user", cleaned_message)

        # Build messages for LLM
        messages = session.get_messages_for_llm()

        # Inject images into the last user message if present
        if request.images and messages:
            # Find the last user message and add images to it
            for i in range(len(messages) - 1, -1, -1):
                if messages[i].get("role") == "user":
                    messages[i]["images"] = [
                        {"data": img.data, "mime_type": img.mime_type}
                        for img in request.images
                    ]
                    logger.info(f"Injected {len(request.images)} images into user message")
                    break

        # Fetch warm context from knowledge engine (proactive loading)
        warm_context: Optional["WarmContext"] = None
        if self.knowledge_engine and self.settings.knowledge_engine_enabled:
            try:
                warm_context = await self.knowledge_engine.buffer.get(request.session_id)
                if warm_context:
                    self.knowledge_engine.metrics.cache_hits += 1
                    logger.debug(f"Using warm context: {warm_context.trigger}")
                elif not self.knowledge_engine.buffer.is_available:
                    # Redis unavailable - warn once per session
                    if not self._redis_warning_shown:
                        logger.warning("Warm context buffer unavailable (Redis not connected)")
                        self._redis_warning_shown = True
            except Exception as e:
                logger.debug(f"Failed to fetch warm context: {e}")
                warm_context = None

        system_prompt = self._build_system_prompt(
            session,
            warm_context=warm_context,
            prepare_result=prepare_result,
        )

        # Create handlers bound to working directory
        handlers = self._create_tool_handlers(session.working_directory)

        # Temporarily register handlers for this request
        for name, handler in handlers.items():
            self._tool_handlers[name] = handler

        try:
            # Get iteration limit based on thinking depth
            max_iterations = self._get_max_iterations(depth)

            # Create budget for hybrid routing
            budget = self._create_budget_for_depth(depth)

            # Ensure warm context if enabled
            if self._warm_context and self._local_client and prepare_result:
                # Get observe model from prepare result for warm-up
                observe_model = prepare_result.observe_model or "gemma3n-e2b"
                await self._warm_context.ensure_warm(
                    model_key=observe_model,
                    system_prompt=system_prompt[:1500],  # Truncate for efficiency
                    codebase_context=f"Working directory: {session.working_directory}",
                )

            # Run ReAct with tools using selected model and depth-based iteration limit
            # Use hybrid loop if local client is available, otherwise standard loop
            if self._local_client and self.settings.hybrid_routing_enabled and prepare_result:
                # Use hybrid local/cloud ReAct loop
                result = await self.generate_with_hybrid_tools(
                    system_prompt=system_prompt,
                    messages=messages,
                    max_iterations=max_iterations,
                    model=model,
                    phase_callback=phase_callback,
                    tool_filter=tool_filter,
                    budget=budget,
                    local_client=self._local_client,
                    prepare_result=prepare_result,
                    local_timeout_ms=self.settings.local_timeout_ms,
                    local_respond_confidence_threshold=self.settings.local_respond_confidence_threshold,
                )
            else:
                # Standard cloud-only ReAct loop
                result = await self.generate_with_tools(
                    system_prompt=system_prompt,
                    messages=messages,
                    max_iterations=max_iterations,
                    model=model,  # Use thinking depth model
                    phase_callback=phase_callback,  # Pass through for TUI updates
                    tool_filter=tool_filter,  # Filter tools from prepare step
                )

            # Handle change_directory tool results - update session working dir
            tool_calls = result.get("tool_calls", [])
            for tc in tool_calls:
                if tc.tool_name == "change_directory" and tc.success:
                    new_dir = tc.result.get("new_working_dir") if tc.result else None
                    if new_dir:
                        logger.info(f"Changing working directory: {session.working_directory} -> {new_dir}")
                        session.working_directory = new_dir
                        # Re-register tool handlers with new working directory
                        handlers = self._create_tool_handlers(new_dir)
                        for name, handler in handlers.items():
                            self._tool_handlers[name] = handler
                        await self.sessions.save(session)

            # Build trace from tool calls
            trace = self._build_trace(
                trace_id=trace_id,
                tool_calls=tool_calls,
                final_text=result.get("text") or "",
                iterations=result.get("iterations", 0),
                started_at=started_at,
                thinking_depth=depth,
                model_used=result.get("model_used", model),
                prompt_tokens=result.get("prompt_tokens", 0),
                completion_tokens=result.get("completion_tokens", 0),
            )

            # Check if max iterations was reached (needs user decision)
            if result.get("max_iterations_reached"):
                logger.info(f"Max iterations reached at depth {depth.name}")
                response = ContextResponse(
                    session_id=request.session_id,
                    response=None,  # No response yet
                    trace=trace,
                    status="max_iterations",
                )
                # Attach continuation state for potential escalation
                response._continuation_state = result.get("_continuation_state")
                response._current_depth = depth
                response._result = result
                response._session = session
                return response

            # Build response
            if result.get("success"):
                response_text = result.get("text")

                # Handle empty response (model returned no text but also no function calls)
                # This can happen when the model generates an empty response after tool calls
                # Treat it like max_iterations and offer depth escalation
                if not response_text and result.get("tool_calls"):
                    logger.info(f"Empty response after {len(result.get('tool_calls', []))} tool calls at depth {depth.name}")
                    response = ContextResponse(
                        session_id=request.session_id,
                        response=None,
                        trace=trace,
                        status="max_iterations",  # Use same status to trigger depth selector
                    )
                    response._continuation_state = result.get("_continuation_state")
                    response._current_depth = depth
                    response._result = result
                    response._session = session
                    return response

                response_text = response_text or "I couldn't generate a response. Please try rephrasing your question."

                # Inject generated images into response text
                response_text = self._inject_generated_images(response_text, result.get("tool_calls", []))

                # Add assistant response to history
                session.add_message("assistant", response_text)
                session.trace_ids.append(trace_id)
                await self.sessions.save(session)

                # Extract any editor commands from response
                commands = self._extract_commands(response_text, result.get("tool_calls", []))

                return ContextResponse(
                    session_id=request.session_id,
                    response=response_text,
                    trace=trace,
                    commands=commands if commands else None,
                )
            else:
                error_msg = result.get("error", "Unknown error")
                logger.error(f"ReAct failed: {error_msg}")

                return ContextResponse(
                    session_id=request.session_id,
                    response=f"I encountered an error: {error_msg}",
                    trace=trace,
                )

        except Exception as e:
            logger.exception(f"Error processing context: {e}")
            return ContextResponse(
                session_id=request.session_id,
                response=f"An unexpected error occurred: {str(e)}",
            )

    async def continue_with_depth(
        self,
        previous_response: ContextResponse,
        new_depth: ThinkingDepth,
        phase_callback: Optional[PhaseCallback] = None,
    ) -> ContextResponse:
        """
        Continue processing after max iterations with a new depth.

        Args:
            previous_response: The response that hit max iterations
            new_depth: The new thinking depth to use
            phase_callback: Optional callback for phase updates

        Returns:
            New ContextResponse with continued processing
        """
        # Get continuation state from previous response
        continuation_state = getattr(previous_response, '_continuation_state', None)
        previous_result = getattr(previous_response, '_result', {})
        session = getattr(previous_response, '_session', None)

        if not continuation_state:
            return ContextResponse(
                session_id=previous_response.session_id,
                response="Cannot continue: no continuation state available.",
                status="error",
            )

        # Get new model and iteration limit for the depth
        new_model = get_model_for_depth(new_depth, self._model_tiers)
        new_max_iterations = self._get_max_iterations(new_depth)

        logger.info(
            f"Continuing with depth={new_depth.name}, model={new_model}, "
            f"additional_iterations={new_max_iterations}"
        )

        trace_id = f"react-continue-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        started_at = datetime.now()

        try:
            # Continue with tools
            result = await self.continue_with_tools(
                continuation_state=continuation_state,
                max_iterations=new_max_iterations,
                model=new_model,
                phase_callback=phase_callback,
                previous_tool_calls=previous_result.get("tool_calls", []),
                previous_iterations=previous_result.get("iterations", 0),
                previous_prompt_tokens=previous_result.get("prompt_tokens", 0),
                previous_completion_tokens=previous_result.get("completion_tokens", 0),
            )

            # Build updated trace
            trace = self._build_trace(
                trace_id=trace_id,
                tool_calls=result.get("tool_calls", []),
                final_text=result.get("text") or "",
                iterations=result.get("iterations", 0),
                started_at=started_at,
                thinking_depth=new_depth,
                model_used=result.get("model_used", new_model),
                prompt_tokens=result.get("prompt_tokens", 0),
                completion_tokens=result.get("completion_tokens", 0),
            )

            # Check if max iterations was reached again
            if result.get("max_iterations_reached"):
                logger.info(f"Max iterations reached again at depth {new_depth.name}")
                response = ContextResponse(
                    session_id=previous_response.session_id,
                    response=None,
                    trace=trace,
                    status="max_iterations",
                )
                response._continuation_state = result.get("_continuation_state")
                response._current_depth = new_depth
                response._result = result
                response._session = session
                return response

            # Success!
            if result.get("success"):
                response_text = result.get("text")

                # Handle empty response after tool calls (same as max_iterations)
                if not response_text and result.get("tool_calls"):
                    logger.info(f"Empty response after continuation at depth {new_depth.name}")
                    response = ContextResponse(
                        session_id=previous_response.session_id,
                        response=None,
                        trace=trace,
                        status="max_iterations",
                    )
                    response._continuation_state = result.get("_continuation_state")
                    response._current_depth = new_depth
                    response._result = result
                    response._session = session
                    return response

                response_text = response_text or "I couldn't generate a response. Please try rephrasing your question."

                # Inject generated images into response text
                response_text = self._inject_generated_images(response_text, result.get("tool_calls", []))

                # Add assistant response to history
                if session:
                    session.add_message("assistant", response_text)
                    session.trace_ids.append(trace_id)
                    await self.sessions.save(session)

                return ContextResponse(
                    session_id=previous_response.session_id,
                    response=response_text,
                    trace=trace,
                )
            else:
                error_msg = result.get("error", "Unknown error")
                logger.error(f"Continuation failed: {error_msg}")
                return ContextResponse(
                    session_id=previous_response.session_id,
                    response=f"I encountered an error: {error_msg}",
                    trace=trace,
                )

        except Exception as e:
            logger.exception(f"Error during continuation: {e}")
            return ContextResponse(
                session_id=previous_response.session_id,
                response=f"An unexpected error occurred: {str(e)}",
            )

    def _build_trace(
        self,
        trace_id: str,
        tool_calls: List[ToolResult],
        final_text: str,
        iterations: int,
        started_at: datetime,
        thinking_depth: Optional[ThinkingDepth] = None,
        model_used: Optional[str] = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
    ) -> ReActTrace:
        """Build a ReAct trace from tool call results."""
        thoughts: List[Thought] = []
        actions: List[PlannedAction] = []
        observations: List[Observation] = []

        for i, tool_call in enumerate(tool_calls):
            # Create thought (we don't have the actual thinking, so infer it)
            thoughts.append(Thought(
                step=i + 1,
                reasoning=f"Decided to use {tool_call.tool_name}",
                conclusion=f"Call {tool_call.tool_name} with provided arguments",
            ))

            # Create action
            actions.append(PlannedAction(
                step=i + 1,
                tool_name=tool_call.tool_name,
                tool_input=tool_call.arguments,
                rationale=f"Using {tool_call.tool_name} to gather information",
            ))

            # Create observation
            if tool_call.success:
                result_summary = self._summarize_result(tool_call.result)
                observations.append(Observation(
                    step=i + 1,
                    tool_name=tool_call.tool_name,
                    result=tool_call.result,
                    interpretation=result_summary,
                ))
            else:
                observations.append(Observation(
                    step=i + 1,
                    tool_name=tool_call.tool_name,
                    result={"error": tool_call.error},
                    interpretation=f"Tool failed: {tool_call.error}",
                ))

        trace = ReActTrace(
            trace_id=trace_id,
            thoughts=thoughts,
            actions=actions,
            observations=observations,
            final_response=final_text,
            started_at=started_at,
            completed_at=datetime.now(),
            iterations=iterations,
        )

        # Add thinking depth metadata
        if thinking_depth is not None:
            trace.thinking_depth = thinking_depth.name
        if model_used is not None:
            trace.model_used = model_used

        # Add token usage
        trace.prompt_tokens = prompt_tokens
        trace.completion_tokens = completion_tokens
        trace.total_tokens_used = prompt_tokens + completion_tokens

        return trace

    def _summarize_result(self, result: Any) -> str:
        """Create a brief summary of a tool result."""
        if isinstance(result, dict):
            if "matches" in result:
                count = len(result.get("matches", []))
                return f"Found {count} matches"
            if "content" in result:
                lines = result.get("lines_returned", 0)
                return f"Read {lines} lines of content"
            if "items" in result:
                count = result.get("total_count", 0)
                return f"Listed {count} items"
            if "success" in result and not result["success"]:
                return f"Failed: {result.get('error', 'unknown error')}"
            return "Completed successfully"
        return str(result)[:100]

    def _inject_generated_images(
        self,
        response_text: str,
        tool_calls: List[ToolResult],
    ) -> str:
        """Append generated image data URIs to the response text.

        The generate_image tool stashes raw bytes on ToolResult._image_data
        (set by the ReAct loop after popping from the result dict).
        We encode them as markdown data URIs so frontends can render them.
        """
        import base64 as _b64

        for tc in tool_calls:
            if tc.tool_name == "generate_image" and tc.success and hasattr(tc, "_image_data"):
                b64_str = _b64.b64encode(tc._image_data).decode("ascii")
                mime = getattr(tc, "_image_mime_type", "image/png")
                img_title = (tc.result or {}).get("title", "Generated Image")
                response_text += f"\n\n![{img_title}](data:{mime};base64,{b64_str})"
        return response_text

    def _extract_commands(
        self,
        response_text: str,
        tool_calls: List[ToolResult],
    ) -> Optional[List[EditorCommand]]:
        """
        Extract editor commands from the response and tool calls.

        If a file was read successfully, suggest opening it in the editor.
        """
        commands = []

        for tool_call in tool_calls:
            if tool_call.tool_name == "read_file" and tool_call.success:
                result = tool_call.result
                if isinstance(result, dict) and result.get("success"):
                    file_path = result.get("file_path")
                    start_line = result.get("start_line", 1)

                    if file_path:
                        commands.append(EditorCommand(
                            command_type=CommandType.OPEN_FILE,
                            file=file_path,
                            line=start_line,
                        ))

        return commands if commands else None

    async def _execute_shortcut(
        self,
        request: ContextRequest,
        shortcut: ShortcutResult,
        working_dir: str,
        trace_id: str,
        started_at: datetime,
        phase_callback: Optional[PhaseCallback] = None,
    ) -> Optional[ContextResponse]:
        """
        Execute a shortcut command directly without the full ReAct loop.

        This provides instant response for simple commands:
        - TOOL shortcuts: cd ../, ls, cat file.py -> execute tool directly
        - CLI shortcuts: hester db tables, devops status -> run CLI command
        - SLASH shortcuts: /status, /tasks, /session -> execute TUI command

        Args:
            request: The context request
            shortcut: The detected shortcut with type and execution info
            working_dir: Current working directory
            trace_id: Trace ID for this request
            started_at: When processing started
            phase_callback: Optional callback for phase updates

        Returns:
            ContextResponse if shortcut executed successfully, None to fall back to normal flow
        """
        try:
            # Notify shortcut phase
            if phase_callback:
                shortcut_type_str = shortcut.shortcut_type.value if shortcut.shortcut_type else "shortcut"
                await phase_callback(PhaseUpdate(
                    phase=ReActPhase.PREPARE,
                    iteration=0,
                    model_used=f"shortcut:{shortcut_type_str}",
                    prepare_time_ms=0.0,
                    is_local=True,  # Shortcuts are purely local, no cloud API
                ))

            # Get or create session
            session = await self.sessions.get_or_create(
                session_id=request.session_id,
                working_directory=working_dir,
            )

            # Route to appropriate handler based on shortcut type
            if shortcut.shortcut_type == ShortcutType.TOOL:
                return await self._execute_tool_shortcut(
                    request, shortcut, session, trace_id, started_at, phase_callback
                )
            elif shortcut.shortcut_type == ShortcutType.CLI:
                return await self._execute_cli_shortcut(
                    request, shortcut, session, trace_id, started_at, phase_callback
                )
            elif shortcut.shortcut_type == ShortcutType.SLASH:
                return await self._execute_slash_shortcut(
                    request, shortcut, session, trace_id, started_at, phase_callback
                )
            else:
                logger.warning(f"Unknown shortcut type: {shortcut.shortcut_type}")
                return None

        except Exception as e:
            logger.exception(f"Error executing shortcut: {e}")
            return None

    async def _execute_tool_shortcut(
        self,
        request: ContextRequest,
        shortcut: ShortcutResult,
        session: HesterSession,
        trace_id: str,
        started_at: datetime,
        phase_callback: Optional[PhaseCallback] = None,
    ) -> Optional[ContextResponse]:
        """Execute a tool shortcut (cd, ls, cat, etc.)."""
        # Create handlers bound to working directory
        handlers = self._create_tool_handlers(session.working_directory)
        for name, handler in handlers.items():
            self._tool_handlers[name] = handler

        # Get the tool handler
        tool_name = shortcut.tool_name
        handler = self._tool_handlers.get(tool_name)
        if not handler:
            logger.warning(f"Shortcut handler not found: {tool_name}")
            return None

        # Execute the tool directly
        try:
            tool_args = shortcut.tool_args or {}
            result = await handler(**tool_args)
        except Exception as e:
            logger.error(f"Shortcut tool execution failed: {e}")
            return None

        # Build tool result
        success = result.get("success", False) if isinstance(result, dict) else True
        tool_result = ToolResult(
            tool_name=tool_name,
            arguments=shortcut.tool_args or {},
            result=result,
            success=success,
            error=result.get("error") if isinstance(result, dict) and not success else None,
        )

        # Handle change_directory - update session working dir
        if tool_name == "change_directory" and success:
            new_dir = result.get("new_working_dir") if isinstance(result, dict) else None
            if new_dir:
                logger.info(f"Shortcut: Changing working directory: {session.working_directory} -> {new_dir}")
                session.working_directory = new_dir
                # Re-register tool handlers with new working directory
                handlers = self._create_tool_handlers(new_dir)
                for name, handler in handlers.items():
                    self._tool_handlers[name] = handler
                await self.sessions.save(session)

        # Build response text based on tool result
        response_text = self._format_shortcut_response(tool_name, result, shortcut.tool_args)

        return await self._finalize_shortcut_response(
            request, session, trace_id, started_at, phase_callback,
            response_text, [tool_result], "tool"
        )

    async def _execute_cli_shortcut(
        self,
        request: ContextRequest,
        shortcut: ShortcutResult,
        session: HesterSession,
        trace_id: str,
        started_at: datetime,
        phase_callback: Optional[PhaseCallback] = None,
    ) -> Optional[ContextResponse]:
        """Execute a Hester CLI command shortcut (db tables, devops status, etc.)."""
        import subprocess

        cli_cmd = shortcut.cli_command or []
        args = shortcut.tool_args or {}

        # Build the full hester command
        cmd = ["hester"] + cli_cmd

        # Add arguments based on the command type
        if "query" in cli_cmd and "query" in args:
            cmd.append(args["query"])
        elif "describe" in cli_cmd and "table" in args:
            cmd.append(args["table"])
        elif "count" in cli_cmd and "table" in args:
            cmd.append(args["table"])
        elif "logs" in cli_cmd and "service" in args:
            cmd.append(args["service"])

        logger.info(f"Executing CLI shortcut: {' '.join(cmd)}")

        try:
            # Run the command and capture output
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=session.working_directory,
            )

            if result.returncode == 0:
                response_text = result.stdout.strip() if result.stdout else "Command completed successfully."
                success = True
            else:
                response_text = f"Command failed:\n{result.stderr.strip() if result.stderr else 'Unknown error'}"
                success = False

        except subprocess.TimeoutExpired:
            response_text = "CLI command timed out after 30 seconds."
            success = False
        except FileNotFoundError:
            response_text = "Hester CLI not found. Make sure it's installed and in PATH."
            success = False
        except Exception as e:
            response_text = f"Error running CLI command: {e}"
            success = False

        # Build tool result for trace
        tool_result = ToolResult(
            tool_name=f"cli:{' '.join(cli_cmd)}",
            arguments=args,
            result={"output": response_text, "success": success},
            success=success,
        )

        return await self._finalize_shortcut_response(
            request, session, trace_id, started_at, phase_callback,
            response_text, [tool_result], "cli"
        )

    async def _execute_slash_shortcut(
        self,
        request: ContextRequest,
        shortcut: ShortcutResult,
        session: HesterSession,
        trace_id: str,
        started_at: datetime,
        phase_callback: Optional[PhaseCallback] = None,
    ) -> Optional[ContextResponse]:
        """Execute a slash command shortcut (/status, /tasks, /session, etc.)."""
        cmd = shortcut.slash_command or ""
        args = shortcut.tool_args or {}

        response_text = ""
        success = True

        if cmd == "/help":
            response_text = """Available commands:
  /help      - Show this help message
  /status    - Show daemon status
  /session   - Show current session ID
  /pwd       - Show working directory
  /tasks     - List all tasks
  /task <id> - View task details
  /clear     - Clear conversation history
  /prompts   - List available prompt overrides
  /agents    - List available agent overrides

Model selection (prefix your message):
  /local     - Local fast (gemma3n)
  /deeplocal - Local complex (gemma3)
  /quick     - Cloud fast (gemini-2.5-flash)
  /standard  - Cloud balanced (gemini-2.5-flash)
  /deep      - Cloud complex (gemini-3-flash)
  /pro       - Cloud reasoning (gemini-3.1-pro)

Routing overrides (prefix your message):
  #prompt_name - Use specific prompt (e.g., #scene, #research)
  @agent_name  - Use specific agent (e.g., @scene_developer)

Tool shortcuts:
  cd <path>  - Change directory
  ls [path]  - List directory
  cat <file> - Read file
  pwd        - Show working directory"""

        elif cmd == "/status":
            health = await self.health_check()
            response_text = f"""Daemon Status: {health.get('status', 'unknown')}
Model: {health.get('agent', {}).get('model', 'unknown')}
Tools: {health.get('agent', {}).get('tools_registered', 0)}
Sessions: {health.get('sessions', {}).get('active_sessions', 0)}"""

        elif cmd == "/session":
            response_text = f"Session ID: {session.session_id}"

        elif cmd == "/pwd":
            response_text = f"Working directory: {session.working_directory}"

        elif cmd == "/tasks":
            # List tasks from task store
            try:
                tasks = await list_tasks()
                if tasks:
                    lines = ["Tasks:"]
                    for task in tasks[:10]:  # Limit to 10
                        status = task.get("status", "unknown")
                        title = task.get("title", "Untitled")[:50]
                        task_id = task.get("id", "?")[:8]
                        lines.append(f"  [{status}] {task_id}: {title}")
                    if len(tasks) > 10:
                        lines.append(f"  ... and {len(tasks) - 10} more")
                    response_text = "\n".join(lines)
                else:
                    response_text = "No tasks found."
            except Exception as e:
                response_text = f"Error listing tasks: {e}"
                success = False

        elif cmd == "/task":
            task_id = args.get("arg")
            if task_id:
                try:
                    task = await get_task(task_id)
                    if task:
                        response_text = f"""Task: {task.get('title', 'Untitled')}
ID: {task.get('id', '?')}
Status: {task.get('status', 'unknown')}
Goal: {task.get('goal', 'No goal specified')}"""
                    else:
                        response_text = f"Task not found: {task_id}"
                        success = False
                except Exception as e:
                    response_text = f"Error getting task: {e}"
                    success = False
            else:
                response_text = "Usage: /task <task_id>"
                success = False

        elif cmd == "/clear":
            session.messages = []
            await self.sessions.save(session)
            response_text = "Conversation history cleared."

        else:
            response_text = f"Unknown slash command: {cmd}"
            success = False

        # Build tool result for trace
        tool_result = ToolResult(
            tool_name=f"slash:{cmd}",
            arguments=args,
            result={"output": response_text, "success": success},
            success=success,
        )

        return await self._finalize_shortcut_response(
            request, session, trace_id, started_at, phase_callback,
            response_text, [tool_result], "slash"
        )

    async def _finalize_shortcut_response(
        self,
        request: ContextRequest,
        session: HesterSession,
        trace_id: str,
        started_at: datetime,
        phase_callback: Optional[PhaseCallback],
        response_text: str,
        tool_results: List[ToolResult],
        shortcut_type: str,
    ) -> ContextResponse:
        """Finalize and return a shortcut response."""
        # Notify RESPOND phase
        if phase_callback:
            await phase_callback(PhaseUpdate(
                phase=ReActPhase.RESPOND,
                iteration=0,
                model_used=f"shortcut:{shortcut_type}",
                is_local=True,  # Shortcuts are purely local, no cloud API
            ))

        # Build trace
        trace = self._build_trace(
            trace_id=trace_id,
            tool_calls=tool_results,
            final_text=response_text,
            iterations=1,
            started_at=started_at,
            thinking_depth=ThinkingDepth.QUICK,
            model_used=f"shortcut:{shortcut_type}",
        )

        # Add to session history
        user_message = request.message or ""
        session.add_message("user", user_message)
        session.add_message("assistant", response_text)
        session.trace_ids.append(trace_id)
        await self.sessions.save(session)

        # Extract editor commands
        commands = self._extract_commands(response_text, tool_results)

        return ContextResponse(
            session_id=request.session_id,
            response=response_text,
            trace=trace,
            commands=commands,
        )

    def _format_shortcut_response(
        self,
        tool_name: str,
        result: Any,
        tool_args: Optional[Dict[str, Any]],
    ) -> str:
        """Format a human-readable response for a shortcut execution."""
        if not isinstance(result, dict):
            return str(result)

        if not result.get("success", False):
            error = result.get("error", "Unknown error")
            return f"Error: {error}"

        # Format based on tool type
        if tool_name == "change_directory":
            new_dir = result.get("new_working_dir", "")
            return f"Changed directory to: {new_dir}"

        elif tool_name == "list_directory":
            path = result.get("path", ".")
            items = result.get("items", [])
            dir_count = result.get("directory_count", 0)
            file_count = result.get("file_count", 0)

            lines = [f"Contents of {path}: {dir_count} directories, {file_count} files\n"]

            # Format items (directories first, then files) as markdown list
            for item in items[:30]:  # Limit display
                name = item.get("name", "")
                is_dir = item.get("is_directory", False)
                size = item.get("size")
                if is_dir:
                    lines.append(f"- 📁 **{name}/**")
                else:
                    size_str = f" ({size:,} bytes)" if size is not None else ""
                    lines.append(f"- 📄 {name}{size_str}")

            if len(items) > 30:
                lines.append(f"\n*... and {len(items) - 30} more items*")

            return "\n".join(lines)

        elif tool_name == "read_file":
            file_path = result.get("file_path", "")
            content = result.get("content", "")
            lines_returned = result.get("lines_returned", 0)

            # Truncate content for display
            if len(content) > 2000:
                content = content[:2000] + "\n... (content truncated)"

            return f"File: {file_path} ({lines_returned} lines)\n\n{content}"

        else:
            # Generic success response
            return f"Executed {tool_name} successfully"

    async def _handle_status_message(
        self,
        action: str,
        message: Optional[str] = None,
        type: Optional[str] = None,
        prompt: Optional[str] = None,
        ttl: Optional[int] = None,
        id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Handle status_message tool calls by dispatching to the appropriate helper.

        Actions:
        - push: Add a message to the status bar queue
        - clear: Remove a specific message by ID
        - clear_all: Remove all messages from the queue
        """
        if action == "push":
            if not message:
                return {"success": False, "error": "Message required for push action"}
            result = await push_status_message(
                message=message,
                message_type=type or "hint",
                prompt=prompt,
                ttl=ttl,
                message_id=id,
            )
        elif action == "clear":
            if not id:
                return {"success": False, "error": "Message ID required for clear action"}
            result = await clear_status_message(message_id=id)
        elif action == "clear_all":
            result = await clear_all_status_messages()
        else:
            return {"success": False, "error": f"Unknown action: {action}"}

        # Convert ToolResult to dict
        return {
            "success": result.success,
            "data": result.data,
            "message": result.message,
            "error": result.error,
        }

    async def health_check(self) -> Dict[str, Any]:
        """Perform a health check on the agent."""
        try:
            # Test simple generation
            result = await self.simple_generate(
                prompt="Say 'OK' if you can hear me.",
                system_prompt="Respond with just 'OK'.",
            )

            return {
                "status": "healthy",
                "model": self.settings.gemini_model,
                "tools_registered": len(self._tool_definitions),
                "test_response": result[:20] if result else None,
            }
        except Exception as e:
            logger.error(f"Health check failed: {e}")
            return {
                "status": "unhealthy",
                "error": str(e),
            }
