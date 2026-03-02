"""
Hester Daemon Settings - Configuration for the daemon service.
"""

from pydantic_settings import BaseSettings
from pydantic import Field, SecretStr
from typing import Optional


class HesterDaemonSettings(BaseSettings):
    """Settings for Hester Daemon mode."""

    model_config = {"env_prefix": "HESTER_"}

    # Service configuration
    port: int = Field(default=9000, description="Port to listen on")
    host: str = Field(default="0.0.0.0", description="Host to bind to")

    # Redis configuration
    redis_url: str = Field(
        default="redis://localhost:6379",
        description="Redis connection URL"
    )
    session_ttl_seconds: int = Field(
        default=3600,
        description="Session timeout in seconds (1 hour default)"
    )

    # Lee communication
    lee_url: str = Field(
        default="http://localhost:9001",
        description="URL for Lee editor (to send commands)"
    )

    # Google AI (Gemini)
    google_api_key: SecretStr = Field(
        ...,
        validation_alias="GOOGLE_API_KEY",
        description="Google API key for Gemini"
    )

    # Thinking Depth Model Tiers
    # Quick: Simple greetings, clarifications, trivial lookups
    gemini_model_quick: str = Field(
        default="gemini-2.5-flash-lite",
        description="Fastest model for trivial tasks (Tier 0)"
    )
    # Standard: File reads, searches, basic code questions
    gemini_model_standard: str = Field(
        default="gemini-2.5-flash",
        description="Balanced model for standard tasks (Tier 1)"
    )
    # Deep: Complex analysis, multi-file reasoning, architecture questions
    gemini_model_deep: str = Field(
        default="gemini-3-flash-preview",
        description="Advanced model for complex reasoning (Tier 2)"
    )
    # Reasoning: High-stakes decisions, debugging complex issues
    gemini_model_reasoning: str = Field(
        default="gemini-3.1-pro-preview",
        description="Most capable model for deep reasoning (Tier 3)"
    )

    # Default model (backward compatibility)
    gemini_model: str = Field(
        default="gemini-2.5-flash",
        description="Default Gemini model (used if thinking depth disabled)"
    )

    # Enable/disable thinking depth
    thinking_depth_enabled: bool = Field(
        default=True,
        description="Enable automatic thinking depth selection"
    )

    # ReAct configuration - max iterations per depth tier
    max_iterations_quick: int = Field(
        default=3,
        description="Maximum ReAct iterations for QUICK depth"
    )
    max_iterations_standard: int = Field(
        default=5,
        description="Maximum ReAct iterations for STANDARD depth"
    )
    max_iterations_deep: int = Field(
        default=10,
        description="Maximum ReAct iterations for DEEP depth"
    )
    max_iterations_reasoning: int = Field(
        default=15,
        description="Maximum ReAct iterations for REASONING depth"
    )
    thinking_timeout_seconds: int = Field(
        default=60,
        description="Timeout per thinking phase"
    )

    # Ollama/FunctionGemma configuration (for prepare step)
    ollama_enabled: bool = Field(
        default=True,
        description="Enable FunctionGemma prepare step via Ollama"
    )
    ollama_url: str = Field(
        default="http://localhost:11434",
        description="Ollama server URL"
    )
    ollama_timeout: float = Field(
        default=2.0,
        description="Timeout for FunctionGemma calls (seconds)"
    )
    prepare_step_enabled: bool = Field(
        default=True,
        description="Enable the FunctionGemma prepare step for tool selection"
    )

    # ============================================================================
    # Hybrid ReAct Loop Configuration
    # ============================================================================
    # Uses local Gemma models (via Ollama) for OBSERVE and simple THINK phases,
    # cloud Gemini for complex reasoning and RESPOND phases.

    # Master switch for hybrid routing
    hybrid_routing_enabled: bool = Field(
        default=True,
        description="Enable hybrid local/cloud routing in ReAct loop"
    )

    # Local model configuration for OBSERVE phase
    gemma3n_enabled: bool = Field(
        default=True,
        description="Enable Gemma 3n models for local inference"
    )
    gemma3n_model_observe: str = Field(
        default="gemma3n:e2b",
        description="Ollama model name for OBSERVE phase (fastest)"
    )
    gemma3n_model_think: str = Field(
        default="gemma3n:e4b",
        description="Ollama model name for simple THINK phase"
    )
    gemma3_model_standard: str = Field(
        default="gemma3:4b",
        description="Ollama Gemma 3 model for moderate complexity tasks"
    )

    # Local model timeout - falls back to cloud if exceeded
    local_timeout_ms: int = Field(
        default=500,
        description="Timeout for local model calls in milliseconds (fallback to cloud)"
    )

    # Inference budget per depth tier - cloud calls
    budget_cloud_calls_quick: int = Field(
        default=2,
        description="Max cloud API calls for QUICK depth"
    )
    budget_cloud_calls_standard: int = Field(
        default=4,
        description="Max cloud API calls for STANDARD depth"
    )
    budget_cloud_calls_deep: int = Field(
        default=8,
        description="Max cloud API calls for DEEP depth"
    )
    budget_cloud_calls_reasoning: int = Field(
        default=12,
        description="Max cloud API calls for REASONING depth"
    )

    # Inference budget - cloud tokens (approximate)
    budget_cloud_tokens_quick: int = Field(
        default=4000,
        description="Max cloud tokens for QUICK depth"
    )
    budget_cloud_tokens_standard: int = Field(
        default=16000,
        description="Max cloud tokens for STANDARD depth"
    )
    budget_cloud_tokens_deep: int = Field(
        default=64000,
        description="Max cloud tokens for DEEP depth"
    )
    budget_cloud_tokens_reasoning: int = Field(
        default=128000,
        description="Max cloud tokens for REASONING depth"
    )

    # Inference budget - local calls
    budget_local_calls_default: int = Field(
        default=10,
        description="Default max local model calls per request"
    )
    budget_local_time_ms_default: float = Field(
        default=5000.0,
        description="Default total local inference time budget (ms)"
    )

    # Warm context (KV cache) configuration
    warm_context_enabled: bool = Field(
        default=True,
        description="Enable Ollama KV cache warming for faster subsequent calls"
    )
    warm_context_ttl_seconds: int = Field(
        default=300,
        description="TTL for warm context in Ollama (5 minutes default)"
    )

    # RESPOND phase routing
    local_respond_confidence_threshold: float = Field(
        default=0.85,
        description="Confidence threshold for using local model in RESPOND phase"
    )

    # Working directory
    working_directory: Optional[str] = Field(
        default=None,
        description="Default working directory (uses cwd if not set)"
    )

    # ============================================================================
    # Proactive Knowledge Management Configuration
    # ============================================================================
    # Pre-loads relevant knowledge based on Lee context for faster responses.

    # Master switch for proactive knowledge
    knowledge_engine_enabled: bool = Field(
        default=True,
        description="Enable proactive knowledge loading based on editor context"
    )

    # Semantic matching thresholds
    knowledge_bundle_threshold: float = Field(
        default=0.80,
        description="Cosine similarity threshold for bundle matching"
    )
    knowledge_doc_threshold: float = Field(
        default=0.70,
        description="Cosine similarity threshold for doc matching"
    )
    knowledge_max_bundles: int = Field(
        default=3,
        description="Maximum bundles to load into warm context"
    )
    knowledge_max_docs: int = Field(
        default=5,
        description="Maximum doc chunks to load into warm context"
    )
    knowledge_max_warm_tokens: int = Field(
        default=8000,
        description="Maximum tokens in warm context buffer"
    )

    # Debounce timing (ms) for context updates
    knowledge_debounce_file_open: int = Field(
        default=500,
        description="Debounce delay for file open events (ms)"
    )
    knowledge_debounce_tab_switch: int = Field(
        default=300,
        description="Debounce delay for tab switch events (ms)"
    )
    knowledge_debounce_conversation: int = Field(
        default=2000,
        description="Debounce delay for conversation messages (ms)"
    )

    # Background tasks
    knowledge_git_poll_interval: int = Field(
        default=600,
        description="Git status poll interval in seconds (10 min default)"
    )
    knowledge_doc_sync_interval: int = Field(
        default=1800,
        description="Doc embedding sync interval in seconds (30 min default)"
    )
    knowledge_idle_doc_suggestion: int = Field(
        default=30,
        description="Idle time before doc suggestion in seconds"
    )

    # Task watcher
    knowledge_significant_lines: int = Field(
        default=50,
        description="Line change threshold for doc suggestion"
    )

    # ============================================================================
    # NOTE: Proactive task settings have moved to .lee/config.yaml
    # See hester.proactive section for configuration.
    # ProactiveConfigManager handles loading and hot-reload.
    # ============================================================================

    # ============================================================================
    # Semantic Tool Routing Configuration
    # ============================================================================
    # Pre-filters tools using semantic similarity before FunctionGemma.

    use_semantic_tool_routing: bool = Field(
        default=True,
        description="Enable semantic pre-filtering of tools in prepare step"
    )
    semantic_tool_threshold: float = Field(
        default=0.50,
        description="Cosine similarity threshold for tool matching"
    )
    semantic_tool_max: int = Field(
        default=15,
        description="Maximum tools to pass to FunctionGemma after pre-filtering"
    )

    # PostgreSQL configuration (for database tools)
    postgres_host: str = Field(
        default="localhost",
        validation_alias="POSTGRES_HOST",
        description="PostgreSQL host"
    )
    postgres_port: int = Field(
        default=5432,
        validation_alias="POSTGRES_PORT",
        description="PostgreSQL port"
    )
    postgres_database: Optional[str] = Field(
        default=None,
        validation_alias="POSTGRES_DATABASE",
        description="PostgreSQL database name"
    )
    postgres_user: Optional[str] = Field(
        default=None,
        validation_alias="POSTGRES_USER",
        description="PostgreSQL username"
    )
    postgres_password: Optional[SecretStr] = Field(
        default=None,
        validation_alias="POSTGRES_PASSWORD",
        description="PostgreSQL password"
    )


# Singleton instance
_settings: Optional[HesterDaemonSettings] = None


def get_settings() -> HesterDaemonSettings:
    """Get or create settings instance."""
    global _settings
    if _settings is None:
        _settings = HesterDaemonSettings()
    return _settings


def get_daemon_settings() -> HesterDaemonSettings:
    """Alias for get_settings() for consistency with Slack integration."""
    return get_settings()
