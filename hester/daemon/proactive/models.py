"""
Hester Proactive Tasks - Pydantic models for configuration.

These models define the schema for the `hester.proactive` section
in .lee/config.yaml.
"""

from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class TaskConfig(BaseModel):
    """Base configuration for a proactive task."""

    enabled: bool = Field(default=True, description="Whether this task is enabled")
    interval: int = Field(description="Interval in seconds between task runs")


class DocsIndexConfig(TaskConfig):
    """Configuration for documentation indexing task."""

    interval: int = Field(default=1800, description="Indexing interval (30 min default)")


class DriftCheckConfig(TaskConfig):
    """Configuration for documentation drift checking task."""

    interval: int = Field(default=1200, description="Drift check interval (20 min default)")
    threshold: float = Field(default=0.7, description="Drift score threshold")


class DevOpsConfig(TaskConfig):
    """Configuration for DevOps service monitoring task."""

    interval: int = Field(default=600, description="Monitoring interval (10 min default)")
    services: List[str] = Field(
        default_factory=list,
        description="Services to monitor (empty = all in config)"
    )


class TestsConfig(TaskConfig):
    """Configuration for unit test execution task."""

    interval: int = Field(default=3600, description="Test run interval (60 min default)")
    command: str = Field(
        default="pytest tests/unit -q",
        description="Test command to execute"
    )
    timeout: int = Field(default=300, description="Test timeout in seconds")


class BundlesConfig(TaskConfig):
    """Configuration for context bundle refresh task."""

    interval: int = Field(default=7200, description="Bundle refresh interval (2 hours default)")


class IdeasConfig(TaskConfig):
    """Configuration for ideas review surfacing task."""

    enabled: bool = Field(default=False, description="Ideas surfacing disabled by default")
    interval: int = Field(default=1800, description="Ideas check interval (30 min default)")
    min_score: float = Field(default=0.4, description="Minimum review-worthiness score")
    max_per_check: int = Field(default=1, description="Maximum ideas to surface per check")


class BuiltInTasks(BaseModel):
    """Container for all built-in task configurations."""

    docs_index: DocsIndexConfig = Field(default_factory=DocsIndexConfig)
    drift_check: DriftCheckConfig = Field(default_factory=DriftCheckConfig)
    devops: DevOpsConfig = Field(default_factory=DevOpsConfig)
    tests: TestsConfig = Field(default_factory=TestsConfig)
    bundles: BundlesConfig = Field(default_factory=BundlesConfig)
    ideas: IdeasConfig = Field(default_factory=IdeasConfig)


class CustomTaskConfig(BaseModel):
    """Configuration for a custom shell command task."""

    id: str = Field(description="Unique task identifier")
    name: str = Field(description="Display name for the task")
    command: str = Field(description="Shell command to execute")
    interval: int = Field(description="Interval in seconds between runs")
    timeout: int = Field(default=60, description="Command timeout in seconds")
    notify_on: Literal["success", "failure", "always"] = Field(
        default="failure",
        description="When to send notifications"
    )
    enabled: bool = Field(default=True, description="Whether this task is enabled")
    cwd: Optional[str] = Field(
        default=None,
        description="Working directory for command (relative to workspace)"
    )


class ProactiveConfig(BaseModel):
    """
    Root configuration for Hester proactive tasks.

    This is the schema for the `hester.proactive` section in .lee/config.yaml.

    Example:
        hester:
          proactive:
            enabled: true
            tasks:
              docs_index:
                enabled: true
                interval: 1800
              tests:
                command: "pytest tests/ -q"
            custom:
              - id: lint
                name: Lint Check
                command: "npm run lint"
                interval: 900
    """

    enabled: bool = Field(default=True, description="Master switch for all proactive tasks")
    tasks: BuiltInTasks = Field(default_factory=BuiltInTasks)
    custom: List[CustomTaskConfig] = Field(
        default_factory=list,
        description="Custom shell command tasks"
    )
    max_failures: int = Field(
        default=3,
        description="Maximum failures before silencing notifications"
    )

    @classmethod
    def from_workspace_config(cls, workspace_config: dict) -> "ProactiveConfig":
        """
        Extract ProactiveConfig from workspace config dictionary.

        Args:
            workspace_config: The full workspace config from .lee/config.yaml

        Returns:
            ProactiveConfig instance with defaults for missing fields
        """
        hester = workspace_config.get("hester", {})
        proactive_raw = hester.get("proactive", {})

        if not proactive_raw:
            return cls()

        return cls.model_validate(proactive_raw)
