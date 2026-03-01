"""
Hester Daemon FastAPI Application.

HTTP service for the Hester daemon, runs on port 9000.
Provides endpoints for Lee editor integration including SSE streaming.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any, AsyncGenerator, Optional, Union

import yaml

from fastapi import FastAPI, HTTPException, Depends, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import redis.asyncio as redis

from .agent import HesterDaemonAgent
from .lee_client import LeeContextClient
from .models import (
    ContextRequest, ContextResponse, ContinueRequest, LeeContext,
    TelemetryRequest, TelemetryResponse, AgentTelemetry, AgentSessionInfo,
    AgentListRequest, AgentStatus, AgentType, EditorState
)
from .session import SessionManager, InMemorySessionManager, ExplorationSessionManager
from .settings import HesterDaemonSettings
from ..shared.gemini_tools import PhaseUpdate, ReActPhase

# Optional imports for knowledge management (graceful degradation if unavailable)
try:
    from .knowledge import KnowledgeStore, WarmContextBuffer, KnowledgeEngine, GitWatcher, TaskWatcher, ProactiveWatcher
    from .semantic import EmbeddingService, SemanticRouter
    KNOWLEDGE_AVAILABLE = True
except ImportError as e:
    logging.getLogger("hester.daemon.main").warning(f"Knowledge modules not available: {e}")
    KnowledgeStore = None  # type: ignore
    WarmContextBuffer = None  # type: ignore
    KnowledgeEngine = None  # type: ignore
    GitWatcher = None  # type: ignore
    TaskWatcher = None  # type: ignore
    ProactiveWatcher = None  # type: ignore
    EmbeddingService = None  # type: ignore
    SemanticRouter = None  # type: ignore
    KNOWLEDGE_AVAILABLE = False

# Optional import for context bundle service
try:
    from ..context.service import ContextBundleService
    CONTEXT_BUNDLES_AVAILABLE = True
except ImportError as e:
    logging.getLogger("hester.daemon.main").warning(f"Context bundle service not available: {e}")
    ContextBundleService = None  # type: ignore
    CONTEXT_BUNDLES_AVAILABLE = False

# Optional import for proactive config manager
try:
    from .proactive import ProactiveConfigManager, ProactiveConfig
    PROACTIVE_CONFIG_AVAILABLE = True
except ImportError as e:
    logging.getLogger("hester.daemon.main").warning(f"Proactive config manager not available: {e}")
    ProactiveConfigManager = None  # type: ignore
    ProactiveConfig = None  # type: ignore
    PROACTIVE_CONFIG_AVAILABLE = False

# Optional import for plugin system
try:
    from .plugins.loader import PluginLoader
    PLUGINS_AVAILABLE = True
except ImportError as e:
    logging.getLogger("hester.daemon.main").warning(f"Plugin system not available: {e}")
    PluginLoader = None  # type: ignore
    PLUGINS_AVAILABLE = False


def setup_file_logging() -> None:
    """Set up file logging to ~/.lee/logs/hester.log for daemon logs only."""
    try:
        # Ensure log directory exists
        home_dir = Path.home()
        log_dir = home_dir / '.lee' / 'logs'
        log_dir.mkdir(parents=True, exist_ok=True)

        log_file = log_dir / 'hester.log'

        # Create file handler
        file_handler = logging.FileHandler(log_file, mode='a')
        file_handler.setLevel(logging.INFO)

        # Create formatter that identifies daemon logs
        formatter = logging.Formatter(
            '%(asctime)s [Hester] %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        file_handler.setFormatter(formatter)

        # Only add handler to hester.* loggers to avoid capturing unrelated output
        # This prevents terminal/TUI output from polluting the log file
        hester_logger = logging.getLogger('hester')
        hester_logger.addHandler(file_handler)
        hester_logger.setLevel(logging.INFO)

    except Exception as e:
        # Use print since logger might not be fully configured yet
        print(f"Failed to setup file logging: {e}")


logger = logging.getLogger("hester.daemon.main")


# Global state
class AppState:
    settings: HesterDaemonSettings
    redis_client: Optional[redis.Redis] = None
    session_manager: SessionManager  # Can be SessionManager or InMemorySessionManager
    agent: HesterDaemonAgent
    lee_client: LeeContextClient
    redis_available: bool = False

    # Continuation states for max_iterations handling (keyed by session_id)
    # Stores (response, depth) tuples for sessions that hit max_iterations
    continuation_states: Dict[str, Any] = {}

    # Knowledge management components (optional, require Redis)
    knowledge_store: Optional["KnowledgeStore"] = None
    warm_buffer: Optional["WarmContextBuffer"] = None
    knowledge_engine: Optional["KnowledgeEngine"] = None
    semantic_router: Optional["SemanticRouter"] = None
    embedding_service: Optional["EmbeddingService"] = None
    git_watcher: Optional["GitWatcher"] = None
    task_watcher: Optional["TaskWatcher"] = None
    proactive_watcher: Optional["ProactiveWatcher"] = None

    # Context bundle service (for proactive bundle refreshing)
    bundle_service: Optional[Any] = None

    # Proactive config manager (extracts config from workspace config)
    proactive_config_manager: Optional["ProactiveConfigManager"] = None

    # Exploration session manager (Library pane)
    exploration_sessions: Optional["ExplorationSessionManager"] = None

    # Orchestration state (agent telemetry tracking)
    agent_sessions: Dict[str, AgentTelemetry] = {}

    # Workstream system
    ws_store: Optional[Any] = None  # WorkstreamStore

    # Plugin loader
    plugin_loader: Optional["PluginLoader"] = None


app_state = AppState()


def _load_workspace_config(working_dir: Path) -> dict:
    """Load .lee/config.yaml from workspace."""
    for config_path in [
        working_dir / ".lee" / "config.yaml",
        working_dir / "lee.yaml",
    ]:
        if config_path.exists():
            with open(config_path) as f:
                return yaml.safe_load(f) or {}
    return {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown."""
    # Startup - setup file logging first
    setup_file_logging()

    logger.info("Starting Hester daemon...")

    # Load settings
    app_state.settings = HesterDaemonSettings()
    logger.info(f"Loaded settings - port: {app_state.settings.port}")

    # Try to initialize Redis, fall back to in-memory if unavailable
    try:
        app_state.redis_client = redis.from_url(
            app_state.settings.redis_url,
            encoding="utf-8",
            decode_responses=True,
        )
        # Test the connection
        await app_state.redis_client.ping()
        app_state.redis_available = True
        logger.info(f"Connected to Redis: {app_state.settings.redis_url}")

        # Initialize Redis-backed session manager
        app_state.session_manager = SessionManager(
            redis_client=app_state.redis_client,
            ttl_seconds=app_state.settings.session_ttl_seconds,
        )

        # Initialize exploration session manager (Library pane)
        app_state.exploration_sessions = ExplorationSessionManager(
            redis_client=app_state.redis_client,
            ttl_seconds=app_state.settings.session_ttl_seconds * 2,  # Longer TTL for explorations
        )

    except Exception as e:
        logger.warning(f"Redis unavailable ({e}), falling back to in-memory sessions")
        app_state.redis_available = False
        app_state.redis_client = None

        # Initialize in-memory session manager
        app_state.session_manager = InMemorySessionManager(
            ttl_seconds=app_state.settings.session_ttl_seconds,
        )

    # Initialize Lee context client (connects to Lee WebSocket for real-time context)
    # Must be done before knowledge engine which depends on it
    def on_lee_context_update(ctx: LeeContext) -> None:
        """Handle real-time context updates from Lee."""
        logger.debug(f"Lee context update - file: {ctx.editor.file if ctx.editor else None}")

    app_state.lee_client = LeeContextClient(on_context_update=on_lee_context_update)
    # Connect in background (non-blocking, auto-reconnects)
    asyncio.create_task(app_state.lee_client.connect())
    logger.info("Lee context client initialized (connecting in background)")

    # Initialize knowledge management components (requires Redis + lee_client)
    if app_state.redis_available and KNOWLEDGE_AVAILABLE and app_state.settings.knowledge_engine_enabled:
        try:
            working_dir = Path(
                app_state.settings.working_directory or os.getcwd()
            )

            # Initialize embedding service
            google_api_key = app_state.settings.google_api_key.get_secret_value()
            app_state.embedding_service = EmbeddingService(
                api_key=google_api_key,
                redis_client=app_state.redis_client,
            )
            logger.info("Embedding service initialized")

            # Initialize semantic router
            app_state.semantic_router = SemanticRouter(
                embedding_service=app_state.embedding_service,
                redis_client=app_state.redis_client,
            )
            logger.info("Semantic router initialized")

            # Initialize knowledge store
            app_state.knowledge_store = KnowledgeStore(
                redis_client=app_state.redis_client,
                working_dir=working_dir,
            )
            logger.info("Knowledge store initialized")

            # Initialize warm context buffer
            app_state.warm_buffer = WarmContextBuffer(
                redis_client=app_state.redis_client,
            )
            logger.info("Warm context buffer initialized")

            # Initialize knowledge engine (now lee_client is available)
            app_state.knowledge_engine = KnowledgeEngine(
                store=app_state.knowledge_store,
                router=app_state.semantic_router,
                buffer=app_state.warm_buffer,
                lee_client=app_state.lee_client,
                redis_client=app_state.redis_client,
                working_dir=working_dir,
                bundle_threshold=app_state.settings.knowledge_bundle_threshold,
                doc_threshold=app_state.settings.knowledge_doc_threshold,
                max_bundles=app_state.settings.knowledge_max_bundles,
                max_docs=app_state.settings.knowledge_max_docs,
            )
            logger.info("Knowledge engine initialized")

            # Initialize background watchers
            app_state.git_watcher = GitWatcher(
                working_dir=working_dir,
                poll_interval=app_state.settings.knowledge_git_poll_interval,
            )
            app_state.task_watcher = TaskWatcher(
                working_dir=working_dir,
                significant_lines=app_state.settings.knowledge_significant_lines,
            )

            # Initialize context bundle service (for proactive refreshing)
            if CONTEXT_BUNDLES_AVAILABLE:
                try:
                    app_state.bundle_service = ContextBundleService(
                        working_dir=str(working_dir),
                    )
                    logger.info("Context bundle service initialized")
                except Exception as e:
                    logger.warning(f"Failed to initialize context bundle service: {e}")
                    app_state.bundle_service = None

            # Initialize proactive watcher (config-driven via .lee/config.yaml)
            # ProactiveWatcher starts with defaults, then updates via ProactiveConfigManager
            app_state.proactive_watcher = ProactiveWatcher(
                working_dir=working_dir,
                bundle_service=app_state.bundle_service,
            )

            # Initialize proactive config manager (hot-reload on config changes)
            if PROACTIVE_CONFIG_AVAILABLE:
                def on_proactive_config_change(config: "ProactiveConfig") -> None:
                    """Handle proactive config changes from workspace config."""
                    if app_state.proactive_watcher:
                        app_state.proactive_watcher.update_config(config)
                        logger.info("Proactive watcher config updated via hot-reload")

                app_state.proactive_config_manager = ProactiveConfigManager(
                    working_dir=working_dir,
                    on_config_change=on_proactive_config_change,
                )
                logger.info("Proactive config manager initialized")
            else:
                logger.warning("Proactive config manager not available")

            logger.info("Background watchers initialized (git, task, proactive)")

        except Exception as e:
            logger.warning(f"Failed to initialize knowledge components: {e}")
            # Knowledge is optional, continue without it
            app_state.knowledge_engine = None
            app_state.semantic_router = None
    elif not app_state.redis_available:
        logger.info("Knowledge engine disabled (requires Redis)")

    # Initialize agent with Lee context client for live IDE awareness
    # Also pass knowledge engine, semantic router, and embedding service if available
    app_state.agent = HesterDaemonAgent(
        settings=app_state.settings,
        session_manager=app_state.session_manager,
        lee_client=app_state.lee_client,
        knowledge_engine=app_state.knowledge_engine if hasattr(app_state, 'knowledge_engine') else None,
        semantic_router=app_state.semantic_router if hasattr(app_state, 'semantic_router') else None,
        embedding_service=app_state.embedding_service if hasattr(app_state, 'embedding_service') else None,
    )
    logger.info(f"Agent initialized with model: {app_state.settings.gemini_model}")

    # Load plugins from workspace config
    if PLUGINS_AVAILABLE:
        try:
            working_dir = Path(app_state.settings.working_directory or os.getcwd())
            app_state.plugin_loader = PluginLoader(workspace=working_dir)
            workspace_config = _load_workspace_config(working_dir)
            if workspace_config.get("plugins"):
                plugins = app_state.plugin_loader.load_all(workspace_config)
                # Register plugin tools into global registry
                from .tools.definitions import register_plugin_tools
                for plugin in plugins.values():
                    register_plugin_tools(plugin.tool_definitions, plugin.categories)
                # Pass plugin_loader to agent for handler merging
                app_state.agent._plugin_loader = app_state.plugin_loader
                # Merge plugin prompts and agents into registries
                if KNOWLEDGE_AVAILABLE:
                    from .registries import get_prompt_registry, get_agent_registry
                    prompt_registry = get_prompt_registry()
                    agent_registry = get_agent_registry()
                    for plugin in plugins.values():
                        if plugin.prompt_configs or plugin.prompt_templates:
                            prompt_registry.merge_plugin_prompts(
                                plugin.prompt_configs, plugin.prompt_templates
                            )
                        if plugin.agent_configs or plugin.toolset_configs:
                            agent_registry.merge_plugin_agents(
                                plugin.agent_configs, plugin.toolset_configs
                            )
                logger.info(f"Loaded {len(plugins)} plugin(s)")
            else:
                logger.debug("No plugins configured in workspace config")
        except Exception as e:
            logger.warning(f"Plugin loading failed: {e}")

    # Start knowledge engine if available
    if app_state.knowledge_engine:
        # Register Lee context handler for proactive knowledge loading + config updates
        async def on_lee_context_for_knowledge(ctx: LeeContext) -> None:
            """Forward Lee context to knowledge engine and config manager."""
            if app_state.knowledge_engine:
                await app_state.knowledge_engine.on_lee_context(ctx)

            # Update proactive config from workspace config (hot-reload)
            if app_state.proactive_config_manager and ctx.workspace_config:
                changed = app_state.proactive_config_manager.update_from_workspace_config(
                    ctx.workspace_config
                )
                if changed:
                    logger.debug("Proactive config updated from Lee context")

        # Wire up the async callback to receive Lee context updates
        app_state.lee_client.set_context_callback(on_lee_context_for_knowledge, is_async=True)

        # Start engine with initial session (daemon-level)
        asyncio.create_task(app_state.knowledge_engine.start("daemon-session"))
        logger.info("Knowledge engine started")

        # Start background watchers
        if app_state.git_watcher:
            asyncio.create_task(app_state.git_watcher.start())
            logger.info("Git watcher started")

        if app_state.proactive_watcher:
            asyncio.create_task(app_state.proactive_watcher.start())
            logger.info("Proactive watcher started")

    # Initialize Workstream system
    try:
        from .workstream.store import WorkstreamStore
        from .workstream.routes import create_workstream_router

        working_dir = Path(app_state.settings.working_directory or os.getcwd())
        app_state.ws_store = WorkstreamStore(working_dir=working_dir)

        # Initialize workstream tools for agent use
        from .tools.workstream_tools import init_workstream_tools
        init_workstream_tools(app_state.ws_store)

        ws_router = create_workstream_router(
            ws_store=app_state.ws_store,
            task_store=None,
            bundle_service=app_state.bundle_service,
        )
        app.include_router(ws_router)
        logger.info("Workstream system initialized at /workstream")
    except Exception as e:
        logger.warning(f"Failed to initialize workstream system: {e}")
        app_state.ws_store = None

    logger.info("Hester daemon ready")
    yield

    # Shutdown
    logger.info("Shutting down Hester daemon...")

    # Stop background watchers first
    if app_state.git_watcher:
        try:
            await app_state.git_watcher.stop()
            logger.info("Git watcher stopped")
        except Exception as e:
            logger.warning(f"Error stopping git watcher: {e}")

    if app_state.task_watcher:
        try:
            await app_state.task_watcher.stop()
            logger.info("Task watcher stopped")
        except Exception as e:
            logger.warning(f"Error stopping task watcher: {e}")

    if app_state.proactive_watcher:
        try:
            await app_state.proactive_watcher.stop()
            logger.info("Proactive watcher stopped")
        except Exception as e:
            logger.warning(f"Error stopping proactive watcher: {e}")

    # Stop knowledge engine
    if app_state.knowledge_engine:
        try:
            await app_state.knowledge_engine.stop()
            logger.info("Knowledge engine stopped")
        except Exception as e:
            logger.warning(f"Error stopping knowledge engine: {e}")

    # Disconnect from Lee
    await app_state.lee_client.disconnect()

    # Close Redis connection last
    if app_state.redis_client:
        await app_state.redis_client.close()

    logger.info("Hester daemon stopped")


# Create FastAPI app
app = FastAPI(
    title="Hester Daemon",
    description="AI assistant daemon for the Lee editor",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware for Lee editor
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Lee editor origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_agent() -> HesterDaemonAgent:
    """Dependency to get the agent instance."""
    return app_state.agent


def get_sessions() -> SessionManager:
    """Dependency to get the session manager."""
    return app_state.session_manager


def get_lee_client() -> LeeContextClient:
    """Dependency to get the Lee context client."""
    return app_state.lee_client


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """
    Health check endpoint.

    Returns status of the daemon and its dependencies.
    """
    # Check Redis connection (or report in-memory fallback)
    if app_state.redis_available and app_state.redis_client:
        try:
            await app_state.redis_client.ping()
            redis_status = "healthy"
        except Exception as e:
            logger.error(f"Redis health check failed: {e}")
            redis_status = f"unhealthy: {e}"
    else:
        redis_status = "unavailable (using in-memory sessions)"

    # Check agent
    agent_health = await app_state.agent.health_check()

    # Check Lee context client
    lee_connected = app_state.lee_client.connected
    lee_status = {
        "connected": lee_connected,
        "current_file": app_state.lee_client.current_file,
        "focused_panel": app_state.lee_client.focused_panel,
    }

    # Check knowledge engine status
    knowledge_status: Dict[str, Any] = {"enabled": False}
    if app_state.knowledge_engine:
        metrics = app_state.knowledge_engine.metrics
        knowledge_status = {
            "enabled": True,
            "context_updates": metrics.context_updates,
            "matches_found": metrics.matches_found,
            "bundles_loaded": metrics.bundles_loaded,
            "docs_loaded": metrics.docs_loaded,
            "cache_hits": metrics.cache_hits,
            "cache_misses": metrics.cache_misses,
        }
    elif app_state.settings.knowledge_engine_enabled and not app_state.redis_available:
        knowledge_status = {"enabled": False, "reason": "Redis unavailable"}
    elif not KNOWLEDGE_AVAILABLE:
        knowledge_status = {"enabled": False, "reason": "Knowledge modules not installed"}

    # Check proactive watcher status
    proactive_status: Dict[str, Any] = {"enabled": False}
    if app_state.proactive_watcher:
        status = app_state.proactive_watcher.get_status()

        # Get config summary if available
        config_summary = {}
        if app_state.proactive_config_manager:
            config_summary = app_state.proactive_config_manager.get_summary()

        proactive_status = {
            "enabled": config_summary.get("enabled", True),
            "running": app_state.proactive_watcher.is_running,
            "config_hash": config_summary.get("config_hash"),
            "enabled_tasks": config_summary.get("enabled_tasks", []),
            "custom_task_count": config_summary.get("custom_task_count", 0),
            "last_docs_check": status.last_docs_index_check.isoformat() if status.last_docs_index_check else None,
            "last_drift_check": status.last_drift_check.isoformat() if status.last_drift_check else None,
            "last_devops_check": status.last_devops_check.isoformat() if status.last_devops_check else None,
            "last_test_run": status.last_test_run.isoformat() if status.last_test_run else None,
            "last_ideas_check": status.last_ideas_check.isoformat() if status.last_ideas_check else None,
            "last_bundle_refresh": status.last_bundle_refresh_check.isoformat() if status.last_bundle_refresh_check else None,
            "last_bundle_refresh_count": status.last_bundle_refresh_count,
            "total_failures": (
                status.docs_index_failures + status.drift_failures +
                status.devops_failures + status.test_failures +
                status.ideas_failures + status.bundle_refresh_failures +
                sum(status.custom_task_failures.values())
            ),
        }

    # Daemon is healthy even without Redis (graceful degradation)
    is_healthy = agent_health.get("status") == "healthy"

    return {
        "status": "healthy" if is_healthy else "degraded",
        "service": "hester-daemon",
        "port": app_state.settings.port,
        "session_backend": "redis" if app_state.redis_available else "in-memory",
        "components": {
            "redis": redis_status,
            "agent": agent_health,
            "lee": lee_status,
            "knowledge": knowledge_status,
            "proactive": proactive_status,
        },
    }


# ============================================================================
# Orchestration Telemetry Endpoints
# ============================================================================


@app.post("/orchestrate/telemetry", response_model=TelemetryResponse)
async def process_telemetry(request: TelemetryRequest) -> TelemetryResponse:
    """
    Process agent telemetry for workstream orchestration.

    Handles registration, updates, and completion of agent sessions
    for real-time visibility into multi-agent workflows.
    """
    from datetime import datetime

    logger.info(
        f"Telemetry {request.action.value} - session: {request.session_id}, "
        f"agent: {request.agent_type.value if request.agent_type else 'unknown'}"
    )

    try:
        if request.action == "register":
            if not request.agent_type:
                return TelemetryResponse(
                    success=False,
                    session_id=request.session_id,
                    error="agent_type is required for registration"
                )

            # Create new agent telemetry record
            agent_telemetry = AgentTelemetry(
                session_id=request.session_id,
                agent_type=request.agent_type,
                status=request.status or AgentStatus.STARTING,
                focus=request.focus,
                active_file=request.active_file,
                tool=request.tool,
                progress=request.progress,
                workstream_id=request.workstream_id,
                task_id=request.task_id,
                batch_id=request.batch_id,
                metadata=request.metadata,
            )

            # Store in app state
            app_state.agent_sessions[request.session_id] = agent_telemetry

            logger.info(f"Registered agent session: {request.session_id} ({request.agent_type.value})")
            return TelemetryResponse(
                success=True,
                session_id=request.session_id,
                message=f"Registered {request.agent_type.value} agent session"
            )

        elif request.action == "update":
            # Find existing session
            if request.session_id not in app_state.agent_sessions:
                return TelemetryResponse(
                    success=False,
                    session_id=request.session_id,
                    error="Session not found. Must register first."
                )

            agent_telemetry = app_state.agent_sessions[request.session_id]

            # Update fields that were provided
            if request.status:
                agent_telemetry.status = request.status
            if request.focus:
                agent_telemetry.focus = request.focus
            if request.active_file:
                agent_telemetry.active_file = request.active_file
            if request.tool:
                # Track tool usage
                agent_telemetry.record_tool_use(request.tool, request.active_file)
                agent_telemetry.tool = request.tool
            elif request.tool is None and agent_telemetry.tool:
                # Tool cleared (PostToolUse)
                agent_telemetry.tool = None
            if request.progress is not None:
                agent_telemetry.progress = request.progress
            if request.workstream_id:
                agent_telemetry.workstream_id = request.workstream_id
            if request.task_id:
                agent_telemetry.task_id = request.task_id
            if request.batch_id:
                agent_telemetry.batch_id = request.batch_id
            if request.metadata:
                agent_telemetry.metadata = request.metadata

            # Update timestamp
            agent_telemetry.last_updated = datetime.now()

            # Bridge to workstream telemetry if associated
            if agent_telemetry.workstream_id and hasattr(app_state, 'ws_store') and app_state.ws_store:
                try:
                    app_state.ws_store.push_telemetry(agent_telemetry.workstream_id, {
                        "event_type": "agent_update",
                        "session_id": request.session_id,
                        "tool": request.tool,
                        "active_file": request.active_file,
                        "task_id": agent_telemetry.task_id,
                    })
                except Exception:
                    pass  # Telemetry bridging is best-effort

            logger.debug(f"Updated agent session: {request.session_id}")
            return TelemetryResponse(
                success=True,
                session_id=request.session_id,
                message="Agent session updated"
            )

        elif request.action == "complete":
            # Find existing session
            if request.session_id not in app_state.agent_sessions:
                return TelemetryResponse(
                    success=False,
                    session_id=request.session_id,
                    error="Session not found. Must register first."
                )

            agent_telemetry = app_state.agent_sessions[request.session_id]

            # Update final status and result
            agent_telemetry.status = request.status or AgentStatus.COMPLETED
            if request.result:
                agent_telemetry.result = request.result
            if request.workstream_id:
                agent_telemetry.workstream_id = request.workstream_id
            if request.metadata:
                agent_telemetry.metadata = request.metadata

            agent_telemetry.last_updated = datetime.now()

            logger.info(
                f"Completed agent session: {request.session_id} "
                f"({agent_telemetry.status.value})"
            )

            # Bridge completion to workstream telemetry
            if agent_telemetry.workstream_id and hasattr(app_state, 'ws_store') and app_state.ws_store:
                try:
                    app_state.ws_store.push_telemetry(agent_telemetry.workstream_id, {
                        "event_type": "agent_completed",
                        "session_id": request.session_id,
                        "status": agent_telemetry.status.value,
                        "task_id": agent_telemetry.task_id,
                        "files_touched": agent_telemetry.files_touched,
                        "tool_count": len(agent_telemetry.recent_tools),
                    })
                except Exception:
                    pass  # Telemetry bridging is best-effort

            return TelemetryResponse(
                success=True,
                session_id=request.session_id,
                message=f"Agent session completed with status: {agent_telemetry.status.value}"
            )

        else:
            return TelemetryResponse(
                success=False,
                session_id=request.session_id,
                error=f"Unknown action: {request.action}"
            )

    except Exception as e:
        logger.exception(f"Error processing telemetry: {e}")
        return TelemetryResponse(
            success=False,
            session_id=request.session_id,
            error=f"Internal error: {str(e)}"
        )


@app.get("/orchestrate/sessions/{session_id}", response_model=AgentSessionInfo)
async def get_agent_session(session_id: str) -> AgentSessionInfo:
    """
    Get information about a specific agent session.

    Returns detailed telemetry data for the requested session.
    """
    if session_id not in app_state.agent_sessions:
        raise HTTPException(status_code=404, detail="Agent session not found")

    agent_telemetry = app_state.agent_sessions[session_id]

    return AgentSessionInfo(
        session_id=agent_telemetry.session_id,
        agent_type=agent_telemetry.agent_type,
        status=agent_telemetry.status,
        focus=agent_telemetry.focus,
        active_file=agent_telemetry.active_file,
        tool=agent_telemetry.tool,
        progress=agent_telemetry.progress,
        workstream_id=agent_telemetry.workstream_id,
        registered_at=agent_telemetry.registered_at,
        last_updated=agent_telemetry.last_updated,
        metadata=agent_telemetry.metadata
    )


@app.get("/orchestrate/sessions")
async def list_agent_sessions(
    workstream_id: Optional[str] = None,
    agent_type: Optional[str] = None,
    status: Optional[str] = None
) -> Dict[str, Any]:
    """
    List active agent sessions with optional filtering.

    Returns a list of all agent sessions, optionally filtered by
    workstream ID, agent type, or status.
    """
    sessions = list(app_state.agent_sessions.values())

    # Apply filters
    if workstream_id:
        sessions = [s for s in sessions if s.workstream_id == workstream_id]

    if agent_type:
        try:
            agent_type_enum = AgentType(agent_type)
            sessions = [s for s in sessions if s.agent_type == agent_type_enum]
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid agent_type: {agent_type}"
            )

    if status:
        try:
            status_enum = AgentStatus(status)
            sessions = [s for s in sessions if s.status == status_enum]
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status: {status}"
            )

    # Convert to response format
    session_infos = []
    for agent_telemetry in sessions:
        session_infos.append({
            "session_id": agent_telemetry.session_id,
            "agent_type": agent_telemetry.agent_type.value,
            "status": agent_telemetry.status.value,
            "focus": agent_telemetry.focus,
            "active_file": agent_telemetry.active_file,
            "tool": agent_telemetry.tool,
            "progress": agent_telemetry.progress,
            "workstream_id": agent_telemetry.workstream_id,
            "task_id": agent_telemetry.task_id,
            "batch_id": agent_telemetry.batch_id,
            "recent_tools": agent_telemetry.recent_tools,
            "files_touched": agent_telemetry.files_touched,
            "registered_at": agent_telemetry.registered_at.isoformat(),
            "last_updated": agent_telemetry.last_updated.isoformat(),
            "metadata": agent_telemetry.metadata
        })

    # Sort by last_updated (most recent first)
    session_infos.sort(key=lambda x: x["last_updated"], reverse=True)

    return {
        "count": len(session_infos),
        "sessions": session_infos
    }


@app.delete("/orchestrate/sessions/{session_id}")
async def delete_agent_session(session_id: str) -> Dict[str, str]:
    """
    Delete an agent session.

    Removes the session from active tracking.
    """
    if session_id not in app_state.agent_sessions:
        raise HTTPException(status_code=404, detail="Agent session not found")

    del app_state.agent_sessions[session_id]
    logger.info(f"Deleted agent session: {session_id}")

    return {"status": "deleted", "session_id": session_id}


@app.post("/context", response_model=ContextResponse)
async def process_context(
    request: ContextRequest,
    agent: HesterDaemonAgent = Depends(get_agent),
) -> ContextResponse:
    """
    Process context from Lee editor.

    Receives the current editor context and user message,
    processes through the ReAct loop, and returns a response.
    """
    logger.info(
        f"Processing context - session: {request.session_id}, "
        f"message length: {len(request.message) if request.message else 0}"
    )

    try:
        response = await agent.process_context(request)
        logger.info(
            f"Context processed - session: {request.session_id}, "
            f"response length: {len(response.response) if response.response else 0}, "
            f"iterations: {response.trace.iterations if response.trace else 0}"
        )

        # If max_iterations, store continuation state for potential continue request
        if response.status == "max_iterations":
            current_depth = getattr(response, '_current_depth', None)
            app_state.continuation_states[request.session_id] = {
                "response": response,
                "depth": current_depth,
            }
            # Set current_depth in response for client
            response.current_depth = current_depth.name if current_depth else "STANDARD"
            logger.info(f"Stored continuation state for session {request.session_id}, depth={response.current_depth}")

        return response

    except Exception as e:
        logger.exception(f"Error processing context: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Error processing context: {str(e)}",
        )


@app.post("/context/continue", response_model=ContextResponse)
async def continue_context(
    request: ContinueRequest,
    agent: HesterDaemonAgent = Depends(get_agent),
) -> ContextResponse:
    """
    Continue processing after max_iterations was reached.

    Requires a previous request that returned status="max_iterations".
    The session_id must match a stored continuation state.
    """
    from .thinking_depth import ThinkingDepth

    logger.info(
        f"Continue request - session: {request.session_id}, "
        f"new_depth: {request.new_depth}"
    )

    # Get stored continuation state
    state = app_state.continuation_states.get(request.session_id)
    if not state:
        raise HTTPException(
            status_code=404,
            detail=f"No continuation state found for session {request.session_id}. "
                   "The session may have expired or no max_iterations occurred."
        )

    previous_response = state["response"]

    # Parse new depth
    try:
        new_depth = ThinkingDepth[request.new_depth.upper()]
    except KeyError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid depth: {request.new_depth}. Must be STANDARD, DEEP, or REASONING."
        )

    try:
        response = await agent.continue_with_depth(
            previous_response,
            new_depth,
        )

        # Clean up continuation state on success
        if response.status != "max_iterations":
            del app_state.continuation_states[request.session_id]
        else:
            # Update stored state for potential further continuation
            current_depth = getattr(response, '_current_depth', None)
            app_state.continuation_states[request.session_id] = {
                "response": response,
                "depth": current_depth,
            }
            response.current_depth = current_depth.name if current_depth else new_depth.name

        logger.info(
            f"Continue completed - session: {request.session_id}, "
            f"status: {response.status}, "
            f"response length: {len(response.response) if response.response else 0}"
        )
        return response

    except Exception as e:
        logger.exception(f"Error continuing context: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Error continuing context: {str(e)}",
        )


@app.post("/context/stream")
async def stream_context(
    request: ContextRequest,
    agent: HesterDaemonAgent = Depends(get_agent),
) -> StreamingResponse:
    """
    Stream context processing via Server-Sent Events.

    Returns real-time updates as Hester processes the request through
    the ReAct loop. Each SSE event has a type and JSON data:

    Event types:
    - phase: ReAct phase updates (preparing, thinking, acting, observing, responding)
    - response: Final response text
    - error: Error information
    - done: Processing complete

    Example SSE stream:
        event: phase
        data: {"phase": "thinking", "iteration": 1}

        event: phase
        data: {"phase": "acting", "tool_name": "read_file", "iteration": 1}

        event: response
        data: {"text": "The file contains...", "session_id": "abc123"}

        event: done
        data: {"session_id": "abc123"}
    """
    image_count = len(request.images) if request.images else 0
    logger.info(
        f"Streaming context - session: {request.session_id}, "
        f"message: {request.message[:50] if request.message else 'empty'}..., "
        f"images: {image_count}"
    )

    async def event_generator() -> AsyncGenerator[str, None]:
        """Generate SSE events as processing progresses."""
        phase_queue: asyncio.Queue[PhaseUpdate] = asyncio.Queue()

        async def phase_callback(update: PhaseUpdate) -> None:
            """Queue phase updates for streaming."""
            await phase_queue.put(update)

        # Start processing in background task
        process_task = asyncio.create_task(
            agent.process_context(request, phase_callback=phase_callback)
        )

        try:
            # Stream phase updates while processing
            while not process_task.done():
                try:
                    # Wait for phase update with timeout
                    update = await asyncio.wait_for(
                        phase_queue.get(),
                        timeout=0.1
                    )

                    # Format phase update as SSE
                    phase_data = {
                        "phase": update.phase.value,
                        "iteration": update.iteration,
                    }
                    if update.tool_name:
                        phase_data["tool_name"] = update.tool_name
                    if update.tool_context:
                        phase_data["tool_context"] = update.tool_context
                    if update.model_used:
                        phase_data["model_used"] = update.model_used
                    if update.is_local:
                        phase_data["is_local"] = update.is_local
                    if update.tools_selected is not None:
                        phase_data["tools_selected"] = update.tools_selected
                    if update.prepare_time_ms is not None:
                        phase_data["prepare_time_ms"] = update.prepare_time_ms
                    # Semantic routing fields
                    if update.prompt_id:
                        phase_data["prompt_id"] = update.prompt_id
                    if update.agent_id:
                        phase_data["agent_id"] = update.agent_id
                    if update.routing_reason:
                        phase_data["routing_reason"] = update.routing_reason

                    yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"

                except asyncio.TimeoutError:
                    # No update yet, continue checking if task is done
                    continue

            # Drain any remaining phase updates
            while not phase_queue.empty():
                update = await phase_queue.get()
                phase_data = {
                    "phase": update.phase.value,
                    "iteration": update.iteration,
                }
                if update.tool_name:
                    phase_data["tool_name"] = update.tool_name
                if update.tool_context:
                    phase_data["tool_context"] = update.tool_context
                yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"

            # Get the result
            response: ContextResponse = await process_task

            # If max_iterations, store continuation state for potential continue request
            # (Same logic as /context endpoint to enable /context/continue after streaming)
            if response.status == "max_iterations":
                current_depth = getattr(response, '_current_depth', None)
                app_state.continuation_states[request.session_id] = {
                    "response": response,
                    "depth": current_depth,
                }
                # Set current_depth in response for client
                response.current_depth = current_depth.name if current_depth else "STANDARD"
                logger.info(f"Stored continuation state for session {request.session_id}, depth={response.current_depth}")

            # Send final response
            response_data = {
                "session_id": response.session_id,
                "status": response.status,
            }
            if response.response:
                response_data["text"] = response.response
            if response.trace:
                response_data["iterations"] = response.trace.iterations
                response_data["tools_used"] = [
                    obs.tool_name for obs in response.trace.observations
                ] if response.trace.observations else []
                if response.trace.thinking_depth:
                    response_data["thinking_depth"] = response.trace.thinking_depth
                if response.trace.model_used:
                    response_data["model_used"] = response.trace.model_used

            # Include current_depth for max_iterations handling
            if response.current_depth:
                response_data["current_depth"] = response.current_depth

            yield f"event: response\ndata: {json.dumps(response_data)}\n\n"

            # Send done event
            yield f"event: done\ndata: {json.dumps({'session_id': response.session_id})}\n\n"

        except Exception as e:
            logger.exception(f"Error streaming context: {e}")
            error_data = {
                "error": str(e),
                "session_id": request.session_id,
            }
            yield f"event: error\ndata: {json.dumps(error_data)}\n\n"

            # Cancel the processing task if still running
            if not process_task.done():
                process_task.cancel()
                try:
                    await process_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


@app.get("/session/{session_id}")
async def get_session(
    session_id: str,
    sessions: SessionManager = Depends(get_sessions),
) -> Dict[str, Any]:
    """
    Get session information.

    Returns basic info about the session without full history.
    """
    info = await sessions.get_session_info(session_id)
    if info is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return info


@app.get("/session/{session_id}/history")
async def get_session_history(
    session_id: str,
    sessions: SessionManager = Depends(get_sessions),
) -> Dict[str, Any]:
    """
    Get full session history including conversation messages.

    Used to resume a session in the TUI (e.g., from Command Palette).
    Returns conversation history, editor state, and metadata.
    """
    session = await sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id": session.session_id,
        "created_at": session.created_at.isoformat(),
        "last_activity": session.last_activity.isoformat(),
        "working_directory": session.working_directory,
        "conversation_history": [
            {
                "role": msg.role,
                "content": msg.content,
                "timestamp": msg.timestamp.isoformat(),
                "metadata": msg.metadata,
            }
            for msg in session.conversation_history
        ],
        "editor_state": session.editor_state.model_dump() if session.editor_state else None,
        "trace_ids": session.trace_ids,
    }


@app.delete("/session/{session_id}")
async def delete_session(
    session_id: str,
    sessions: SessionManager = Depends(get_sessions),
) -> Dict[str, str]:
    """
    Delete a session.

    Ends the session and clears all associated data.
    """
    deleted = await sessions.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "deleted", "session_id": session_id}


@app.get("/sessions")
async def list_sessions(
    sessions: SessionManager = Depends(get_sessions),
) -> Dict[str, Any]:
    """
    List all active sessions.

    Returns a list of session IDs.
    """
    session_ids = await sessions.list_sessions()
    return {
        "count": len(session_ids),
        "sessions": session_ids,
    }


@app.get("/agentgraph/scene/{session_id}")
async def get_agentgraph_scene(
    session_id: str,
    user_id: Optional[str] = Query(None, description="User UUID for decryption"),
    email: Optional[str] = Query(None, description="User email (looks up UUID)"),
) -> Dict[str, Any]:
    """
    Get AgentGraph scene state for a Frame session.

    Retrieves and decrypts the LangGraph checkpoint from Redis, then extracts
    scene-related state (current stage, progress, scene_data, etc.).

    This endpoint is used by Lee's browser pane to capture session state
    when taking snapshots of Frame conversations.

    Args:
        session_id: The AgentGraph session ID
        user_id: User UUID for DEK lookup (required if email not provided)
        email: User email to look up UUID (alternative to user_id)

    Returns:
        Scene state including current stage, stage order, scene_data, etc.
    """
    from hester.cli.session import _get_session_state, _extract_scene_info, _lookup_user_id_by_email

    # Validate we have user identification
    if not user_id and not email:
        raise HTTPException(
            status_code=400,
            detail="Either user_id or email query parameter is required"
        )

    # Look up user_id from email if needed
    resolved_user_id = user_id
    if email and not user_id:
        resolved_user_id = await _lookup_user_id_by_email(email)
        if not resolved_user_id:
            raise HTTPException(
                status_code=404,
                detail=f"User not found for email: {email}"
            )

    # Get and decrypt session state
    result = await _get_session_state(session_id, resolved_user_id)

    if not result.get("success"):
        raise HTTPException(
            status_code=404,
            detail=result.get("error", "Failed to get session state")
        )

    # Extract scene info
    state = result.get("state", {})
    scene_info = _extract_scene_info(state)

    return scene_info


# ========================================================================
# Library Pane Endpoints — Doc search, index status, web research, save
# ========================================================================

@app.get("/docs/search")
async def docs_search(
    q: str = Query(..., description="Search query"),
    limit: int = Query(10, ge=1, le=25, description="Max results"),
):
    """Semantic search over indexed documentation."""
    try:
        from hester.docs.embeddings import DocEmbeddingService

        working_dir = app_state.settings.working_directory or os.getcwd()
        service = DocEmbeddingService(working_dir)
        results = await service.search(query=q, limit=limit)
        return {"results": results, "search_method": "embeddings"}
    except Exception as e:
        logger.error(f"Doc search error: {e}")
        return {"results": [], "error": str(e)}


@app.get("/docs/index-status")
async def docs_index_status():
    """Get documentation index status (file count, repo name)."""
    try:
        from hester.docs.embeddings import DocEmbeddingService

        working_dir = app_state.settings.working_directory or os.getcwd()
        service = DocEmbeddingService(working_dir)
        indexed_files = await service.get_indexed_files()
        return {
            "repo_name": service.repo_name,
            "file_count": len(indexed_files),
            "indexed_files": indexed_files,
        }
    except Exception as e:
        logger.error(f"Index status error: {e}")
        return {"file_count": 0, "indexed_files": [], "error": str(e)}


@app.post("/research/web")
async def research_web(body: Dict[str, Any]):
    """Web research via Gemini with Google Search grounding."""
    try:
        from hester.daemon.tasks.web_researcher_delegate import WebResearcherDelegate

        query = body.get("query")
        if not query:
            raise HTTPException(status_code=400, detail="query is required")

        context = body.get("context")
        max_sources = body.get("max_sources", 10)

        delegate = WebResearcherDelegate(max_sources=max_sources)
        result = await delegate.execute(prompt=query, context=context)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Web research error: {e}")
        return {"success": False, "error": str(e)}


@app.post("/docs/save")
async def docs_save(body: Dict[str, Any]):
    """Save content as a markdown doc and auto-index it."""
    try:
        from hester.daemon.tools.doc_tools import write_markdown

        path = body.get("path")
        content = body.get("content")
        if not path or not content:
            raise HTTPException(status_code=400, detail="path and content are required")

        working_dir = app_state.settings.working_directory or os.getcwd()
        result = await write_markdown(
            doc_path=path,
            content=content,
            working_dir=working_dir,
            overwrite=True,
        )

        # Auto-index the new file
        if result.get("success"):
            try:
                from hester.docs.embeddings import DocEmbeddingService

                service = DocEmbeddingService(working_dir)
                abs_path = result.get("path", "")
                await service.index_file(abs_path)
            except Exception as idx_err:
                logger.warning(f"Auto-index failed for {path}: {idx_err}")

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Doc save error: {e}")
        return {"success": False, "error": str(e)}


# ========================================================================
# Library Exploration Endpoints — Idea exploration workspace
# ========================================================================


def get_exploration_sessions() -> ExplorationSessionManager:
    """Dependency to get the exploration session manager."""
    if not app_state.exploration_sessions:
        raise HTTPException(status_code=503, detail="Exploration sessions not available (requires Redis)")
    return app_state.exploration_sessions


@app.post("/library/sessions")
async def create_exploration_session(
    body: Dict[str, Any],
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, Any]:
    """Create a new exploration session with a seed thought as root node."""
    title = body.get("title")
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    working_dir = body.get("working_directory", ".")
    session = await manager.create_session(title=title, working_directory=working_dir)

    return {
        "session_id": session.session_id,
        "title": session.title,
        "root_id": session.root_id,
        "nodes": {nid: n.model_dump() for nid, n in session.nodes.items()},
    }


@app.get("/library/sessions")
async def list_exploration_sessions(
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, Any]:
    """List all active exploration sessions."""
    sessions = await manager.list_sessions()
    return {"count": len(sessions), "sessions": sessions}


@app.get("/library/sessions/{session_id}")
async def get_exploration_session(
    session_id: str,
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, Any]:
    """Get the full exploration session tree."""
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Exploration session not found")

    return {
        "session_id": session.session_id,
        "title": session.title,
        "root_id": session.root_id,
        "active_node_id": session.active_node_id,
        "nodes": {nid: n.model_dump() for nid, n in session.nodes.items()},
        "created_at": session.created_at.isoformat(),
        "last_activity": session.last_activity.isoformat(),
    }


@app.delete("/library/sessions/{session_id}")
async def delete_exploration_session(
    session_id: str,
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, str]:
    """Delete an exploration session."""
    deleted = await manager.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Exploration session not found")
    return {"status": "deleted", "session_id": session_id}


@app.post("/library/sessions/{session_id}/nodes")
async def create_exploration_node(
    session_id: str,
    body: Dict[str, Any],
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, Any]:
    """Create a child node under a parent."""
    parent_id = body.get("parent_id")
    label = body.get("label")
    if not parent_id or not label:
        raise HTTPException(status_code=400, detail="parent_id and label are required")

    node = await manager.add_node(
        session_id=session_id,
        parent_id=parent_id,
        label=label,
        node_type=body.get("node_type", "thought"),
        agent_mode=body.get("agent_mode", "ideate"),
    )

    if not node:
        raise HTTPException(status_code=404, detail="Session or parent node not found")

    return {"node_id": node.id, "node": node.model_dump()}


@app.patch("/library/sessions/{session_id}/nodes/{node_id}")
async def rename_exploration_node(
    session_id: str,
    node_id: str,
    body: Dict[str, Any],
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, Any]:
    """Rename a node's label."""
    label = body.get("label")
    if not label or not label.strip():
        raise HTTPException(status_code=400, detail="label is required")

    success = await manager.rename_node(session_id, node_id, label.strip())
    if not success:
        raise HTTPException(status_code=404, detail="Session or node not found")

    return {"success": True, "node_id": node_id, "label": label.strip()}


@app.post("/library/sessions/{session_id}/nodes/{node_id}/chat")
async def stream_node_chat(
    session_id: str,
    node_id: str,
    body: Dict[str, Any],
    agent: HesterDaemonAgent = Depends(get_agent),
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> StreamingResponse:
    """
    SSE streaming chat on a specific exploration node.

    Routes to the appropriate Hester agent based on the node's agent_mode:
    - ideate -> @ideator
    - explore -> @idea_explorer
    - learn -> @teacher
    - search -> returns search results directly (no agent)
    """
    message = body.get("message", "")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    node = session.nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    # Save user message to node history
    await manager.add_node_message(session_id, node_id, "user", message)

    # Build breadcrumb context for system prompt injection
    breadcrumb = session.get_breadcrumb_summary(node_id)

    # Map agent_mode to @agent prefix
    agent_prefix_map = {
        "ideate": "@ideator",
        "explore": "@idea_explorer",
        "learn": "@teacher",
        "brainstorm": "@brainstorm",
        "visualize": "@diagram",
    }
    prefix = agent_prefix_map.get(node.agent_mode, "@idea_explorer")

    # Construct the routed message with breadcrumb context
    context_line = f"[Exploration context: {breadcrumb}]\n\n" if breadcrumb else ""
    routed_message = f"{prefix} {context_line}{message}"

    # Use a unique session ID per node to isolate conversation history
    node_session_id = f"library-{session_id}-{node_id}"

    request = ContextRequest(
        session_id=node_session_id,
        message=routed_message,
        source="Lee",
        editor_state=EditorState(
            working_directory=session.working_directory,
        ),
    )

    async def event_generator() -> AsyncGenerator[str, None]:
        phase_queue: asyncio.Queue = asyncio.Queue()

        async def phase_callback(update) -> None:
            await phase_queue.put(update)

        process_task = asyncio.create_task(
            agent.process_context(request, phase_callback=phase_callback)
        )

        try:
            while not process_task.done():
                try:
                    update = await asyncio.wait_for(phase_queue.get(), timeout=0.1)
                    phase_data = {
                        "phase": update.phase.value,
                        "iteration": update.iteration,
                    }
                    if update.tool_name:
                        phase_data["tool_name"] = update.tool_name
                    if update.tool_context:
                        phase_data["tool_context"] = update.tool_context
                    if update.agent_id:
                        phase_data["agent_id"] = update.agent_id
                    yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"
                except asyncio.TimeoutError:
                    continue

            # Drain remaining phase updates
            while not phase_queue.empty():
                update = await phase_queue.get()
                phase_data = {"phase": update.phase.value, "iteration": update.iteration}
                if update.tool_name:
                    phase_data["tool_name"] = update.tool_name
                yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"

            response = await process_task

            # If max_iterations, store continuation state so /continue can pick up
            can_continue = False
            if response.status == "max_iterations":
                current_depth = getattr(response, '_current_depth', None)
                app_state.continuation_states[node_session_id] = {
                    "response": response,
                    "depth": current_depth,
                }
                can_continue = True
                logger.info(f"Stored continuation state for library node {node_session_id}")

            # Handle max_iterations or empty response with a fallback
            response_text = response.response
            if not response_text and response.status == "max_iterations":
                tools_used = []
                if response.trace and response.trace.observations:
                    tools_used = [obs.tool_name for obs in response.trace.observations]
                response_text = (
                    "I explored extensively but ran out of iterations before forming "
                    "a complete response. Here's what I investigated:\n\n"
                    + (f"**Tools used:** {', '.join(tools_used)}\n\n" if tools_used else "")
                    + "Click **Continue** to let me keep going with more depth."
                )
            elif not response_text:
                response_text = "I couldn't generate a response. Please try rephrasing your question."

            # Save assistant response to node history
            await manager.add_node_message(
                session_id, node_id, "assistant", response_text
            )

            response_data = {
                "session_id": session_id,
                "node_id": node_id,
                "status": response.status,
                "text": response_text,
                "can_continue": can_continue,
            }
            if response.trace:
                response_data["iterations"] = response.trace.iterations
                response_data["tools_used"] = [
                    obs.tool_name for obs in response.trace.observations
                ] if response.trace.observations else []

            yield f"event: response\ndata: {json.dumps(response_data)}\n\n"
            yield f"event: done\ndata: {json.dumps({'session_id': session_id, 'node_id': node_id})}\n\n"

        except Exception as e:
            logger.exception(f"Error streaming node chat: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
            if not process_task.done():
                process_task.cancel()
                try:
                    await process_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/library/sessions/{session_id}/nodes/{node_id}/continue")
async def continue_node_chat(
    session_id: str,
    node_id: str,
    body: Dict[str, Any],
    agent: HesterDaemonAgent = Depends(get_agent),
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> StreamingResponse:
    """
    Continue processing after max_iterations on a node chat.

    Escalates to a deeper thinking depth and continues the ReAct loop.
    """
    from .thinking_depth import ThinkingDepth

    node_session_id = f"library-{session_id}-{node_id}"

    # Get stored continuation state
    state = app_state.continuation_states.get(node_session_id)
    if not state:
        raise HTTPException(
            status_code=404,
            detail="No continuation state found. The session may have expired."
        )

    previous_response = state["response"]
    current_depth = state.get("depth")

    # Escalate depth: STANDARD -> DEEP -> REASONING
    new_depth_str = body.get("new_depth")
    if new_depth_str:
        try:
            new_depth = ThinkingDepth[new_depth_str.upper()]
        except KeyError:
            raise HTTPException(status_code=400, detail=f"Invalid depth: {new_depth_str}")
    else:
        # Auto-escalate one level
        depth_order = [ThinkingDepth.STANDARD, ThinkingDepth.DEEP, ThinkingDepth.REASONING]
        current_idx = depth_order.index(current_depth) if current_depth in depth_order else 0
        new_depth = depth_order[min(current_idx + 1, len(depth_order) - 1)]

    logger.info(f"Continuing library node {node_session_id} at depth {new_depth.name}")

    async def event_generator() -> AsyncGenerator[str, None]:
        phase_queue: asyncio.Queue = asyncio.Queue()

        async def phase_callback(update) -> None:
            await phase_queue.put(update)

        process_task = asyncio.create_task(
            agent.continue_with_depth(
                previous_response,
                new_depth,
                phase_callback=phase_callback,
            )
        )

        try:
            while not process_task.done():
                try:
                    update = await asyncio.wait_for(phase_queue.get(), timeout=0.1)
                    phase_data = {
                        "phase": update.phase.value,
                        "iteration": update.iteration,
                    }
                    if update.tool_name:
                        phase_data["tool_name"] = update.tool_name
                    if update.tool_context:
                        phase_data["tool_context"] = update.tool_context
                    yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"
                except asyncio.TimeoutError:
                    continue

            # Drain remaining phases
            while not phase_queue.empty():
                update = await phase_queue.get()
                phase_data = {"phase": update.phase.value, "iteration": update.iteration}
                if update.tool_name:
                    phase_data["tool_name"] = update.tool_name
                yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"

            response = await process_task

            # Check if we hit max_iterations again
            can_continue = False
            if response.status == "max_iterations":
                new_current_depth = getattr(response, '_current_depth', None)
                app_state.continuation_states[node_session_id] = {
                    "response": response,
                    "depth": new_current_depth,
                }
                can_continue = True
            else:
                # Clean up continuation state on success
                app_state.continuation_states.pop(node_session_id, None)

            response_text = response.response
            if not response_text and response.status == "max_iterations":
                tools_used = []
                if response.trace and response.trace.observations:
                    tools_used = [obs.tool_name for obs in response.trace.observations]
                response_text = (
                    "Still exploring — ran out of iterations again.\n\n"
                    + (f"**Tools used:** {', '.join(tools_used)}\n\n" if tools_used else "")
                    + "Click **Continue** to keep going."
                )
            elif not response_text:
                response_text = "I couldn't generate a response."

            # Save to node history
            await manager.add_node_message(
                session_id, node_id, "assistant", response_text
            )

            response_data = {
                "session_id": session_id,
                "node_id": node_id,
                "status": response.status,
                "text": response_text,
                "can_continue": can_continue,
            }
            if response.trace:
                response_data["iterations"] = response.trace.iterations
                response_data["tools_used"] = [
                    obs.tool_name for obs in response.trace.observations
                ] if response.trace.observations else []

            yield f"event: response\ndata: {json.dumps(response_data)}\n\n"
            yield f"event: done\ndata: {json.dumps({'session_id': session_id, 'node_id': node_id})}\n\n"

        except Exception as e:
            logger.exception(f"Error continuing node chat: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
            if not process_task.done():
                process_task.cancel()
                try:
                    await process_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/library/sessions/{session_id}/save")
async def save_exploration_to_ideas(
    session_id: str,
    body: Dict[str, Any],
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> Dict[str, Any]:
    """Save an exploration session (or branch) as an idea."""
    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Build markdown from tree
    node_id = body.get("node_id", session.root_id)

    def render_node(nid: str, depth: int = 0) -> str:
        n = session.nodes.get(nid)
        if not n:
            return ""
        indent = "#" * min(depth + 1, 6)
        lines = [f"{indent} {n.label}"]
        for msg in n.conversation_history:
            if msg.role == "user":
                lines.append(f"\n**Q:** {msg.content}")
            elif msg.role == "assistant":
                lines.append(f"\n{msg.content}")
        for child_id in n.children:
            lines.append(render_node(child_id, depth + 1))
        return "\n".join(lines)

    content = render_node(node_id)
    tags = body.get("tags", ["exploration", "library"])

    try:
        # Look up idea_push handler from plugin system
        handler = None
        if app_state.plugin_loader:
            for plugin in app_state.plugin_loader.loaded.values():
                if "idea_push" in plugin.tool_handlers:
                    handler = plugin.tool_handlers["idea_push"]
                    break
        if handler is None:
            return {"success": False, "error": "idea_push tool not available (plugin not loaded)"}
        result = await handler(content=content, tags=tags)
        return result
    except Exception as e:
        logger.error(f"Failed to save exploration as idea: {e}")
        return {"success": False, "error": str(e)}


# ========================================================================
# Library Synthesis Endpoints — Summarize, Compare, Combine nodes
# ========================================================================


@app.post("/library/sessions/{session_id}/synthesize")
async def synthesize_nodes(
    session_id: str,
    body: Dict[str, Any],
    agent: HesterDaemonAgent = Depends(get_agent),
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> StreamingResponse:
    """
    Synthesize exploration nodes — summarize, compare, or combine.

    Body:
        action: "summarize" | "compare" | "combine"
        node_ids: list of node IDs to synthesize
        parent_id: optional parent for the new synthesis node (default: root)
    """
    action = body.get("action", "summarize")
    node_ids = body.get("node_ids", [])
    parent_id = body.get("parent_id")

    if action not in ("summarize", "compare", "combine"):
        raise HTTPException(status_code=400, detail="action must be summarize, compare, or combine")
    if not node_ids:
        raise HTTPException(status_code=400, detail="node_ids is required")
    if action in ("compare", "combine") and len(node_ids) < 2:
        raise HTTPException(status_code=400, detail=f"{action} requires at least 2 nodes")

    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Collect conversation histories
    node_contents = []
    node_labels = []
    for nid in node_ids:
        node = session.nodes.get(nid)
        if not node:
            continue
        node_labels.append(node.label)
        lines = [f'=== Node: "{node.label}" ({node.agent_mode}) ===']
        for msg in node.conversation_history:
            if msg.role == "user":
                lines.append(f"User: {msg.content}")
            elif msg.role == "assistant":
                lines.append(f"Assistant: {msg.content}")
        node_contents.append("\n".join(lines))

    if not node_contents:
        raise HTTPException(status_code=404, detail="No valid nodes found")

    combined_content = "\n\n".join(node_contents)

    # Build synthesis label
    if action == "summarize":
        short_label = node_labels[0]
        if len(short_label) > 40:
            short_label = short_label[:40] + "..."
        label = f"Summary: {short_label}"
    elif action == "compare":
        label = f"Compare: {' vs '.join(l[:20] for l in node_labels[:3])}"
    else:
        label = f"Combined: {' + '.join(l[:20] for l in node_labels[:3])}"

    # Create the synthesis node
    target_parent = parent_id or session.root_id
    new_node = await manager.add_node(
        session_id=session_id,
        parent_id=target_parent,
        label=label,
        node_type="thought",
        agent_mode="ideate",
    )
    if not new_node:
        raise HTTPException(status_code=500, detail="Failed to create synthesis node")

    new_node_id = new_node.id

    # Build the routed message for @synthesizer
    routed_message = f"@synthesizer #{action}\n\n{combined_content}"
    node_session_id = f"library-{session_id}-{new_node_id}"

    request = ContextRequest(
        session_id=node_session_id,
        message=routed_message,
        source="Lee",
        editor_state=EditorState(
            working_directory=session.working_directory,
        ),
    )

    async def event_generator() -> AsyncGenerator[str, None]:
        # Send the new node info immediately so frontend can show it
        yield f"event: node_created\ndata: {json.dumps({'node_id': new_node_id, 'label': label, 'parent_id': target_parent})}\n\n"

        phase_queue: asyncio.Queue = asyncio.Queue()

        async def phase_callback(update) -> None:
            await phase_queue.put(update)

        process_task = asyncio.create_task(
            agent.process_context(request, phase_callback=phase_callback)
        )

        try:
            while not process_task.done():
                try:
                    update = await asyncio.wait_for(phase_queue.get(), timeout=0.1)
                    phase_data = {
                        "phase": update.phase.value,
                        "iteration": update.iteration,
                    }
                    if update.tool_name:
                        phase_data["tool_name"] = update.tool_name
                    yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"
                except asyncio.TimeoutError:
                    continue

            # Drain remaining phases
            while not phase_queue.empty():
                update = await phase_queue.get()
                phase_data = {"phase": update.phase.value, "iteration": update.iteration}
                if update.tool_name:
                    phase_data["tool_name"] = update.tool_name
                yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"

            response = await process_task
            response_text = response.response or "Synthesis could not be completed."

            # Save to the synthesis node
            await manager.add_node_message(
                session_id, new_node_id, "assistant", response_text
            )

            response_data = {
                "session_id": session_id,
                "node_id": new_node_id,
                "status": response.status,
                "text": response_text,
                "action": action,
            }
            yield f"event: response\ndata: {json.dumps(response_data)}\n\n"
            yield f"event: done\ndata: {json.dumps({'session_id': session_id, 'node_id': new_node_id})}\n\n"

        except Exception as e:
            logger.exception(f"Error in synthesis stream: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
            if not process_task.done():
                process_task.cancel()
                try:
                    await process_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ========================================================================
# Library Visualize Endpoints — Diagram, image gen, structured markdown
# ========================================================================


@app.post("/library/sessions/{session_id}/visualize")
async def visualize_nodes(
    session_id: str,
    body: Dict[str, Any],
    agent: HesterDaemonAgent = Depends(get_agent),
    manager: ExplorationSessionManager = Depends(get_exploration_sessions),
) -> StreamingResponse:
    """
    Visualize exploration nodes — create diagrams, images, or structured markdown.

    Body:
        node_ids: list of node IDs to visualize
        prompt: optional user prompt for what to visualize
        parent_id: optional parent for the new visualization node (default: root)
    """
    node_ids = body.get("node_ids", [])
    user_prompt = body.get("prompt", "")
    parent_id = body.get("parent_id")

    if not node_ids:
        raise HTTPException(status_code=400, detail="node_ids is required")

    session = await manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Collect conversation histories
    node_contents = []
    node_labels = []
    for nid in node_ids:
        node = session.nodes.get(nid)
        if not node:
            continue
        node_labels.append(node.label)
        lines = [f'=== Node: "{node.label}" ({node.agent_mode}) ===']
        for msg in node.conversation_history:
            if msg.role == "user":
                lines.append(f"User: {msg.content}")
            elif msg.role == "assistant":
                lines.append(f"Assistant: {msg.content}")
        node_contents.append("\n".join(lines))

    if not node_contents:
        raise HTTPException(status_code=404, detail="No valid nodes found")

    combined_content = "\n\n".join(node_contents)

    # Build label
    if len(node_labels) == 1:
        short_label = node_labels[0]
        if len(short_label) > 35:
            short_label = short_label[:35] + "..."
        label = f"Visualize: {short_label}"
    else:
        label = f"Visualize: {' + '.join(l[:20] for l in node_labels[:3])}"

    # Create the visualization node
    target_parent = parent_id or session.root_id
    new_node = await manager.add_node(
        session_id=session_id,
        parent_id=target_parent,
        label=label,
        node_type="thought",
        agent_mode="visualize",
    )
    if not new_node:
        raise HTTPException(status_code=500, detail="Failed to create visualization node")

    new_node_id = new_node.id

    # Build the routed message for @diagram agent
    prompt_line = f"\n\nUser request: {user_prompt}" if user_prompt else ""
    routed_message = f"@diagram Visualize the following conversation threads:{prompt_line}\n\n{combined_content}"
    node_session_id = f"library-{session_id}-{new_node_id}"

    request = ContextRequest(
        session_id=node_session_id,
        message=routed_message,
        source="Lee",
        editor_state=EditorState(
            working_directory=session.working_directory,
        ),
    )

    async def event_generator() -> AsyncGenerator[str, None]:
        # Send the new node info immediately so frontend can show it
        yield f"event: node_created\ndata: {json.dumps({'node_id': new_node_id, 'label': label, 'parent_id': target_parent})}\n\n"

        phase_queue: asyncio.Queue = asyncio.Queue()

        async def phase_callback(update) -> None:
            await phase_queue.put(update)

        process_task = asyncio.create_task(
            agent.process_context(request, phase_callback=phase_callback)
        )

        try:
            while not process_task.done():
                try:
                    update = await asyncio.wait_for(phase_queue.get(), timeout=0.1)
                    phase_data = {
                        "phase": update.phase.value,
                        "iteration": update.iteration,
                    }
                    if update.tool_name:
                        phase_data["tool_name"] = update.tool_name
                    yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"
                except asyncio.TimeoutError:
                    continue

            # Drain remaining phases
            while not phase_queue.empty():
                update = await phase_queue.get()
                phase_data = {"phase": update.phase.value, "iteration": update.iteration}
                if update.tool_name:
                    phase_data["tool_name"] = update.tool_name
                yield f"event: phase\ndata: {json.dumps(phase_data)}\n\n"

            response = await process_task
            response_text = response.response or "Visualization could not be completed."

            # Save to the visualization node
            await manager.add_node_message(
                session_id, new_node_id, "assistant", response_text
            )

            response_data = {
                "session_id": session_id,
                "node_id": new_node_id,
                "status": response.status,
                "text": response_text,
            }
            yield f"event: response\ndata: {json.dumps(response_data)}\n\n"
            yield f"event: done\ndata: {json.dumps({'session_id': session_id, 'node_id': new_node_id})}\n\n"

        except Exception as e:
            logger.exception(f"Error in visualize stream: {e}")
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
            if not process_task.done():
                process_task.cancel()
                try:
                    await process_task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/library/sessions/{session_id}/promote-to-workstream")
async def promote_to_workstream(session_id: str, request: Request):
    """Promote library node(s) to a workstream with pre-populated brief."""
    body = await request.json()
    node_ids = body.get("node_ids", [])

    if not node_ids:
        raise HTTPException(status_code=400, detail="node_ids required")

    manager: ExplorationSessionManager = app_state.exploration_sessions
    session = manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not app_state.ws_store:
        raise HTTPException(status_code=503, detail="Workstream system not available")

    # Render selected nodes as markdown (same pattern as save-as-idea)
    lines = []
    title_parts = []
    for node_id in node_ids:
        node = session.nodes.get(node_id)
        if not node:
            continue
        title_parts.append(node.label)
        lines.append(f'## {node.label}\n')
        for msg in node.conversation_history:
            if msg.role == "user":
                lines.append(f"**User:** {msg.content}\n")
            elif msg.role == "assistant":
                lines.append(f"{msg.content}\n")
        lines.append("")

    content = "\n".join(lines)
    title = title_parts[0] if title_parts else "Untitled Workstream"

    # Create workstream via orchestrator
    from .workstream.orchestrator import WorkstreamOrchestrator
    orchestrator = WorkstreamOrchestrator(ws_store=app_state.ws_store)
    ws = await orchestrator.promote_from_idea(
        session_id=session_id,
        title=title,
        objective=content[:2000],  # Truncate to reasonable brief length
    )

    return {
        "workstream_id": ws.id,
        "title": ws.title,
        "phase": ws.phase.value,
    }


# ========================================================================
# Context Bundle Endpoints — List and view bundles for Aeronaut
# ========================================================================


@app.get("/bundles")
async def list_bundles() -> Dict[str, Any]:
    """List all context bundles with status."""
    if not app_state.bundle_service:
        raise HTTPException(status_code=503, detail="Context bundle service not available")

    try:
        statuses = app_state.bundle_service.list_all()
        return {
            "bundles": [
                {
                    "id": s.id,
                    "title": s.title,
                    "tags": s.tags,
                    "created_at": s.updated.isoformat(),
                    "updated_at": s.updated.isoformat(),
                    "stale": s.is_stale,
                    "source_count": s.source_count,
                }
                for s in statuses
            ]
        }
    except Exception as e:
        logger.error(f"Bundle list error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/bundles/{bundle_id}")
async def get_bundle_content(bundle_id: str) -> Dict[str, Any]:
    """Get the content of a context bundle."""
    if not app_state.bundle_service:
        raise HTTPException(status_code=503, detail="Context bundle service not available")

    content = app_state.bundle_service.get_content(bundle_id)
    if content is None:
        raise HTTPException(status_code=404, detail=f"Bundle '{bundle_id}' not found")

    return {"id": bundle_id, "content": content}


def create_app() -> FastAPI:
    """Factory function to create the app."""
    return app


if __name__ == "__main__":
    import uvicorn

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )

    # Setup file logging to ~/.lee/logs/hester.log
    setup_file_logging()

    settings = HesterDaemonSettings()
    uvicorn.run(
        "hester.daemon.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
