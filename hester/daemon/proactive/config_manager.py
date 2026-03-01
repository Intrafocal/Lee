"""
Hester Proactive Config Manager - Manages proactive task configuration.

Extracts configuration from workspace config (via Lee context),
detects changes, and notifies ProactiveWatcher for hot-reload.
"""

import hashlib
import json
import logging
from pathlib import Path
from typing import Callable, Optional

from .models import ProactiveConfig

logger = logging.getLogger("hester.daemon.proactive.config_manager")


class ProactiveConfigManager:
    """
    Manages proactive task configuration from workspace config.

    Configuration flows:
    1. Lee loads .lee/config.yaml on startup
    2. Lee sends workspace config via WebSocket (LeeContext)
    3. ConfigManager extracts hester.proactive section
    4. On change, notifies ProactiveWatcher for hot-reload

    Usage:
        config_manager = ProactiveConfigManager(
            working_dir=Path("/project"),
            on_config_change=lambda cfg: watcher.update_config(cfg),
        )

        # Called when Lee context updates
        config_manager.update_from_workspace_config(lee_context.workspace_config)
    """

    def __init__(
        self,
        working_dir: Path,
        on_config_change: Optional[Callable[[ProactiveConfig], None]] = None,
    ):
        """
        Initialize the config manager.

        Args:
            working_dir: Working directory (project root)
            on_config_change: Callback when config changes
        """
        self._working_dir = working_dir
        self._on_config_change = on_config_change
        self._current_config: ProactiveConfig = ProactiveConfig()
        self._last_config_hash: Optional[str] = None

    @property
    def config(self) -> ProactiveConfig:
        """Get the current configuration."""
        return self._current_config

    def update_from_workspace_config(
        self,
        workspace_config: Optional[dict],
    ) -> bool:
        """
        Update config from workspace config (from LeeContext).

        Args:
            workspace_config: Full workspace config dict from Lee

        Returns:
            True if config changed, False otherwise
        """
        if workspace_config is None:
            workspace_config = {}

        # Extract hester.proactive section
        hester = workspace_config.get("hester", {})
        proactive_raw = hester.get("proactive", {})

        # Compute hash to detect changes
        config_hash = self._compute_hash(proactive_raw)

        if config_hash == self._last_config_hash:
            logger.debug("Proactive config unchanged (hash match)")
            return False

        self._last_config_hash = config_hash

        # Parse new config
        try:
            new_config = ProactiveConfig.from_workspace_config(workspace_config)
        except Exception as e:
            logger.error(f"Failed to parse proactive config: {e}")
            return False

        # Check if semantically different
        if new_config == self._current_config:
            logger.debug("Proactive config unchanged (semantic match)")
            return False

        # Update current config
        old_config = self._current_config
        self._current_config = new_config

        # Log changes
        self._log_config_changes(old_config, new_config)

        # Notify callback
        if self._on_config_change:
            try:
                self._on_config_change(new_config)
            except Exception as e:
                logger.error(f"Config change callback failed: {e}")

        return True

    def _compute_hash(self, config_dict: dict) -> str:
        """Compute a hash of the config dictionary for change detection."""
        try:
            serialized = json.dumps(config_dict, sort_keys=True, default=str)
            return hashlib.md5(serialized.encode()).hexdigest()
        except Exception:
            return ""

    def _log_config_changes(
        self,
        old: ProactiveConfig,
        new: ProactiveConfig,
    ) -> None:
        """Log meaningful config changes."""
        changes = []

        if old.enabled != new.enabled:
            changes.append(f"enabled: {old.enabled} -> {new.enabled}")

        # Check built-in task changes
        for task_name in ["docs_index", "drift_check", "devops", "tests", "bundles", "ideas"]:
            old_task = getattr(old.tasks, task_name)
            new_task = getattr(new.tasks, task_name)

            if old_task.enabled != new_task.enabled:
                changes.append(f"{task_name}.enabled: {old_task.enabled} -> {new_task.enabled}")
            if old_task.interval != new_task.interval:
                changes.append(f"{task_name}.interval: {old_task.interval}s -> {new_task.interval}s")

        # Check custom tasks
        old_custom_ids = {t.id for t in old.custom}
        new_custom_ids = {t.id for t in new.custom}

        added = new_custom_ids - old_custom_ids
        removed = old_custom_ids - new_custom_ids

        if added:
            changes.append(f"custom tasks added: {', '.join(added)}")
        if removed:
            changes.append(f"custom tasks removed: {', '.join(removed)}")

        if changes:
            logger.info(f"Proactive config updated: {'; '.join(changes)}")
        else:
            logger.info("Proactive config reloaded (no significant changes)")

    def get_summary(self) -> dict:
        """Get a summary of current config for health checks."""
        cfg = self._current_config

        enabled_tasks = []
        if cfg.enabled:
            if cfg.tasks.docs_index.enabled:
                enabled_tasks.append("docs_index")
            if cfg.tasks.drift_check.enabled:
                enabled_tasks.append("drift_check")
            if cfg.tasks.devops.enabled:
                enabled_tasks.append("devops")
            if cfg.tasks.tests.enabled:
                enabled_tasks.append("tests")
            if cfg.tasks.bundles.enabled:
                enabled_tasks.append("bundles")
            if cfg.tasks.ideas.enabled:
                enabled_tasks.append("ideas")

            for custom in cfg.custom:
                if custom.enabled:
                    enabled_tasks.append(f"custom:{custom.id}")

        return {
            "enabled": cfg.enabled,
            "enabled_tasks": enabled_tasks,
            "custom_task_count": len(cfg.custom),
            "config_hash": self._last_config_hash,
        }
