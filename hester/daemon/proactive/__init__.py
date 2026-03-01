"""
Hester Proactive Tasks - Config-driven background task system.

This package provides:
- ProactiveConfig: Pydantic models for task configuration
- ProactiveConfigManager: Loads config from .lee/config.yaml via Lee context
- Integration with ProactiveWatcher for execution
"""

from .models import (
    ProactiveConfig,
    BuiltInTasks,
    TaskConfig,
    DocsIndexConfig,
    DriftCheckConfig,
    DevOpsConfig,
    TestsConfig,
    BundlesConfig,
    IdeasConfig,
    CustomTaskConfig,
)
from .config_manager import ProactiveConfigManager

__all__ = [
    "ProactiveConfig",
    "ProactiveConfigManager",
    "BuiltInTasks",
    "TaskConfig",
    "DocsIndexConfig",
    "DriftCheckConfig",
    "DevOpsConfig",
    "TestsConfig",
    "BundlesConfig",
    "IdeasConfig",
    "CustomTaskConfig",
]
