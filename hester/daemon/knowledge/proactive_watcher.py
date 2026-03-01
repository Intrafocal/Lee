"""
ProactiveWatcher - Config-driven background tasks for Hester daemon.

Reads configuration from .lee/config.yaml via Lee context and supports:
- Built-in tasks: docs_index, drift_check, devops, tests, bundles, ideas
- Custom shell command tasks
- Hot-reload when configuration changes

Push status messages to Lee when issues are found.
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("hester.daemon.knowledge.proactive_watcher")


@dataclass
class ProactiveStatus:
    """Status information for proactive checks."""

    last_docs_index_check: Optional[datetime] = None
    last_drift_check: Optional[datetime] = None
    last_devops_check: Optional[datetime] = None
    last_test_run: Optional[datetime] = None
    last_ideas_check: Optional[datetime] = None
    last_bundle_refresh_check: Optional[datetime] = None

    # Custom task last runs (keyed by task id)
    custom_task_last_runs: Dict[str, datetime] = field(default_factory=dict)

    # Track failures to avoid spam
    docs_index_failures: int = 0
    drift_failures: int = 0
    devops_failures: int = 0
    test_failures: int = 0
    ideas_failures: int = 0
    bundle_refresh_failures: int = 0
    custom_task_failures: Dict[str, int] = field(default_factory=dict)

    # Cache results to detect changes
    last_drift_issues: Set[str] = field(default_factory=set)
    last_devops_issues: Set[str] = field(default_factory=set)
    last_test_results: Dict[str, Any] = field(default_factory=dict)
    last_surfaced_idea_ids: Set[str] = field(default_factory=set)
    last_bundle_refresh_count: int = 0

    @property
    def has_recent_activity(self) -> bool:
        """Check if any check has run recently (within 1 hour)."""
        now = datetime.now()
        one_hour_ago = now - timedelta(hours=1)

        times = [
            self.last_docs_index_check,
            self.last_drift_check,
            self.last_devops_check,
            self.last_test_run,
            self.last_ideas_check,
            self.last_bundle_refresh_check,
        ] + list(self.custom_task_last_runs.values())

        return any(t and t > one_hour_ago for t in times)


class ProactiveWatcher:
    """
    Config-driven background task runner for proactive monitoring.

    Configuration comes from .lee/config.yaml hester.proactive section,
    passed via Lee context updates.

    Built-in tasks:
    - docs_index: Documentation indexing
    - drift_check: Documentation drift analysis
    - devops: Service monitoring
    - tests: Unit test execution
    - bundles: Context bundle refresh
    - ideas: Ideas review surfacing

    Custom tasks:
    - Shell commands with configurable intervals

    Usage:
        watcher = ProactiveWatcher(working_dir=Path("/workspace"))
        watcher.update_config(proactive_config)  # From config manager
        await watcher.start()
        # ... later ...
        await watcher.stop()
    """

    def __init__(
        self,
        working_dir: Path,
        bundle_service: Optional[Any] = None,
    ):
        """
        Initialize the proactive watcher.

        Args:
            working_dir: Working directory (project root)
            bundle_service: Optional ContextBundleService for bundle refresh
        """
        self._working_dir = Path(working_dir)
        self._bundle_service = bundle_service

        # Config (will be set via update_config)
        self._config: Optional["ProactiveConfig"] = None

        self._running = False
        self._tasks: Dict[str, asyncio.Task] = {}  # task_id -> Task
        self._status = ProactiveStatus()

        # Lock for config updates during task management
        self._config_lock = asyncio.Lock()

    @property
    def is_running(self) -> bool:
        """Check if watcher is running."""
        return self._running

    def update_config(self, config: "ProactiveConfig") -> None:
        """
        Update configuration (hot-reload).

        Called by ProactiveConfigManager when config changes.
        If already running, will restart tasks with new config.
        """
        from ..proactive.models import ProactiveConfig

        old_config = self._config
        self._config = config

        if self._running:
            # Schedule async restart
            asyncio.create_task(self._hot_reload(old_config, config))

    async def _hot_reload(
        self,
        old_config: Optional["ProactiveConfig"],
        new_config: "ProactiveConfig",
    ) -> None:
        """Hot-reload tasks when config changes."""
        async with self._config_lock:
            logger.info("Hot-reloading proactive tasks with new config")

            # Stop all current tasks
            await self._stop_all_tasks()

            # Start fresh with new config
            if new_config.enabled:
                await self._start_all_tasks()
            else:
                logger.info("Proactive tasks disabled via config")

    async def start(self) -> None:
        """Start the proactive watcher background tasks."""
        if self._running:
            logger.warning("ProactiveWatcher already running")
            return

        if not self._config:
            logger.warning("ProactiveWatcher started without config, waiting for config update")
            self._running = True
            return

        self._running = True

        if self._config.enabled:
            await self._start_all_tasks()
        else:
            logger.info("Proactive tasks disabled via config")

    async def _start_all_tasks(self) -> None:
        """Start all enabled tasks based on current config."""
        if not self._config:
            return

        cfg = self._config
        tasks = cfg.tasks

        # Built-in tasks
        if tasks.docs_index.enabled:
            self._tasks["docs_index"] = asyncio.create_task(
                self._task_loop("docs_index", tasks.docs_index.interval, self.check_docs_index)
            )

        if tasks.drift_check.enabled:
            self._tasks["drift_check"] = asyncio.create_task(
                self._task_loop("drift_check", tasks.drift_check.interval, self.check_docs_drift)
            )

        if tasks.devops.enabled:
            self._tasks["devops"] = asyncio.create_task(
                self._task_loop("devops", tasks.devops.interval, self.check_devops_status)
            )

        if tasks.tests.enabled:
            self._tasks["tests"] = asyncio.create_task(
                self._task_loop("tests", tasks.tests.interval, self.run_unit_tests)
            )

        if tasks.bundles.enabled and self._bundle_service:
            self._tasks["bundles"] = asyncio.create_task(
                self._task_loop("bundles", tasks.bundles.interval, self.check_context_bundles)
            )

        if tasks.ideas.enabled:
            self._tasks["ideas"] = asyncio.create_task(
                self._task_loop("ideas", tasks.ideas.interval, self.check_ideas)
            )

        # Custom tasks
        for custom in cfg.custom:
            if custom.enabled:
                task_id = f"custom:{custom.id}"
                self._tasks[task_id] = asyncio.create_task(
                    self._custom_task_loop(custom)
                )

        # Log what's running
        running_tasks = list(self._tasks.keys())
        logger.info(f"ProactiveWatcher started with tasks: {', '.join(running_tasks)}")

    async def _stop_all_tasks(self) -> None:
        """Stop all running tasks."""
        for task_id, task in self._tasks.items():
            task.cancel()

        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

        self._tasks = {}

    async def stop(self) -> None:
        """Stop the proactive watcher."""
        self._running = False
        await self._stop_all_tasks()
        logger.info("ProactiveWatcher stopped")

    async def _task_loop(
        self,
        task_id: str,
        interval: int,
        handler: Any,
    ) -> None:
        """Generic task loop for built-in tasks."""
        while self._running:
            try:
                await asyncio.sleep(interval)
                if not self._running:
                    return
                await handler()
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error(f"Error in {task_id} loop: {e}")

    async def _custom_task_loop(self, task_config: "CustomTaskConfig") -> None:
        """Task loop for custom shell command tasks."""
        from ..proactive.models import CustomTaskConfig

        task_id = task_config.id

        while self._running:
            try:
                await asyncio.sleep(task_config.interval)
                if not self._running:
                    return

                await self._run_custom_task(task_config)

            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error(f"Error in custom task {task_id}: {e}")

    async def _run_custom_task(self, task_config: "CustomTaskConfig") -> None:
        """Execute a custom shell command task."""
        task_id = task_config.id
        self._status.custom_task_last_runs[task_id] = datetime.now()

        # Determine working directory
        cwd = self._working_dir
        if task_config.cwd:
            cwd = self._working_dir / task_config.cwd

        # Parse command
        cmd = task_config.command.split()

        logger.info(f"Running custom task '{task_config.name}': {task_config.command}")

        result = await self._run_command(cmd, timeout=task_config.timeout, cwd=cwd)

        # Track failures
        current_failures = self._status.custom_task_failures.get(task_id, 0)
        max_failures = self._config.max_failures if self._config else 3

        if result.returncode == 0:
            # Success
            self._status.custom_task_failures[task_id] = 0

            if task_config.notify_on in ("success", "always"):
                await self._push_status(
                    message=f"{task_config.name} completed",
                    message_type="success",
                    ttl=30,
                )

            # If was failing before, notify recovery
            if current_failures > 0 and task_config.notify_on == "failure":
                await self._push_status(
                    message=f"{task_config.name} recovered",
                    message_type="success",
                    ttl=60,
                )

        else:
            # Failure
            self._status.custom_task_failures[task_id] = current_failures + 1

            if task_config.notify_on in ("failure", "always"):
                if current_failures < max_failures:
                    # Extract error snippet
                    error_msg = (result.stderr or result.stdout or "")[:100]
                    await self._push_status(
                        message=f"{task_config.name} failed",
                        message_type="warning",
                        prompt=f"check logs for {task_id}",
                        ttl=120,
                    )

            logger.warning(f"Custom task '{task_id}' failed: {result.stderr or result.stdout}")

    # Built-in task handlers

    async def check_docs_index(self) -> None:
        """Check documentation indexing status and rebuild if needed."""
        try:
            self._status.last_docs_index_check = datetime.now()

            hester_dir = self._working_dir / ".hester"
            embeddings_file = hester_dir / "docs" / "embeddings.json"

            needs_indexing = False

            if not embeddings_file.exists():
                needs_indexing = True
                reason = "No documentation index found"
            else:
                stat = embeddings_file.stat()
                age = datetime.now() - datetime.fromtimestamp(stat.st_mtime)
                if age > timedelta(hours=24):
                    needs_indexing = True
                    reason = f"Documentation index is {age.days} days old"

            if needs_indexing:
                logger.info(f"Documentation indexing needed: {reason}")

                result = await self._run_hester_command(["docs", "index", "--all"])

                if result.returncode == 0:
                    self._status.docs_index_failures = 0
                    await self._push_status(
                        "Documentation indexed successfully",
                        "success",
                        ttl=30,
                    )
                else:
                    self._status.docs_index_failures += 1
                    max_failures = self._config.max_failures if self._config else 3
                    if self._status.docs_index_failures <= max_failures:
                        await self._push_status(
                            "Documentation indexing failed. Check logs?",
                            "warning",
                            prompt="check hester logs for indexing errors",
                            ttl=120,
                        )

        except Exception as e:
            logger.error(f"Documentation index check failed: {e}")
            self._status.docs_index_failures += 1

    async def check_docs_drift(self) -> None:
        """Check for documentation drift across the codebase."""
        import tempfile

        output_file = None
        try:
            self._status.last_drift_check = datetime.now()

            with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
                output_file = f.name

            result = await self._run_hester_command([
                "docs", "check", "--all", "-o", output_file
            ])

            if result.returncode == 0:
                try:
                    with open(output_file, 'r') as f:
                        drift_data = json.load(f)

                    current_issues = set()
                    threshold = 0.7
                    if self._config:
                        threshold = self._config.tasks.drift_check.threshold

                    if isinstance(drift_data, dict) and "files" in drift_data:
                        for file_info in drift_data["files"]:
                            if file_info.get("drift_score", 0) > threshold:
                                current_issues.add(file_info["path"])

                    new_issues = current_issues - self._status.last_drift_issues
                    resolved_issues = self._status.last_drift_issues - current_issues

                    if new_issues:
                        issue_count = len(new_issues)
                        sample_files = list(new_issues)[:3]

                        await self._push_status(
                            f"{issue_count} files have documentation drift",
                            "warning",
                            prompt=f"review drift in {', '.join(sample_files)}",
                            ttl=300,
                        )

                    if resolved_issues:
                        await self._push_status(
                            f"{len(resolved_issues)} drift issues resolved",
                            "success",
                            ttl=60,
                        )

                    self._status.last_drift_issues = current_issues
                    self._status.drift_failures = 0

                except (json.JSONDecodeError, KeyError, IOError) as e:
                    logger.warning(f"Failed to parse drift check output: {e}")

            else:
                self._status.drift_failures += 1
                max_failures = self._config.max_failures if self._config else 3
                if self._status.drift_failures <= max_failures:
                    await self._push_status(
                        "Documentation drift check failed",
                        "warning",
                        prompt="check hester drift analysis logs",
                        ttl=120,
                    )

        except Exception as e:
            logger.error(f"Documentation drift check failed: {e}")
            self._status.drift_failures += 1

        finally:
            if output_file and os.path.exists(output_file):
                try:
                    os.unlink(output_file)
                except:
                    pass

    async def check_devops_status(self) -> None:
        """Check DevOps service status and health."""
        try:
            self._status.last_devops_check = datetime.now()

            result = await self._run_hester_command(["devops", "status"])

            if result.returncode == 0:
                self._status.devops_failures = 0
                logger.debug("DevOps status check passed")
            else:
                self._status.devops_failures += 1
                max_failures = self._config.max_failures if self._config else 3
                if self._status.devops_failures <= max_failures:
                    await self._push_status(
                        "DevOps status check failed",
                        "warning",
                        prompt="check hester devops configuration",
                        ttl=120,
                    )

        except Exception as e:
            logger.error(f"DevOps status check failed: {e}")
            self._status.devops_failures += 1

    async def run_unit_tests(self) -> None:
        """Run unit tests and report failures."""
        try:
            self._status.last_test_run = datetime.now()

            # Get test command from config
            test_command = "pytest tests/unit -q"
            test_timeout = 300

            if self._config:
                test_command = self._config.tasks.tests.command
                test_timeout = self._config.tasks.tests.timeout

            # Parse command
            test_cmd = test_command.split()
            test_name = test_cmd[0]

            logger.info(f"Running tests: {test_command}")

            result = await self._run_command(test_cmd, timeout=test_timeout)

            if result.returncode == 0:
                if self._status.last_test_results.get(test_name, {}).get("failed", 0) > 0:
                    await self._push_status(
                        f"{test_name} tests now passing",
                        "success",
                        ttl=60,
                    )

                self._status.last_test_results[test_name] = {
                    "status": "passed",
                    "failed": 0,
                    "last_run": datetime.now().isoformat(),
                }

            else:
                failure_count = await self._parse_test_failures(
                    result.stdout, result.stderr, test_name
                )

                previous_failures = self._status.last_test_results.get(
                    test_name, {}
                ).get("failed", 0)

                if failure_count > previous_failures or previous_failures == 0:
                    self._status.test_failures += 1
                    max_failures = self._config.max_failures if self._config else 3

                    if self._status.test_failures <= max_failures:
                        await self._push_status(
                            f"{failure_count} {test_name} tests failing",
                            "warning",
                            prompt=f"run {test_name} tests and check failures",
                            ttl=300,
                        )

                self._status.last_test_results[test_name] = {
                    "status": "failed",
                    "failed": failure_count,
                    "last_run": datetime.now().isoformat(),
                }

        except Exception as e:
            logger.error(f"Unit test run failed: {e}")
            self._status.test_failures += 1

    async def check_ideas(self) -> None:
        """Check for review-worthy ideas and surface to Lee status bar."""
        try:
            self._status.last_ideas_check = datetime.now()

            # Get settings from config
            max_per_check = 1
            min_score = 0.4

            if self._config:
                max_per_check = self._config.tasks.ideas.max_per_check
                min_score = self._config.tasks.ideas.min_score

            result = await self._run_hester_command([
                "ideas", "list",
                "--status", "captured",
                "--limit", str(max_per_check * 5),
                "--json"
            ])

            if result.returncode != 0:
                self._status.ideas_failures += 1
                max_failures = self._config.max_failures if self._config else 3
                if self._status.ideas_failures <= max_failures:
                    logger.warning(f"Ideas check failed: {result.stderr}")
                return

            try:
                ideas = json.loads(result.stdout)
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse ideas JSON: {e}")
                self._status.ideas_failures += 1
                return

            if not ideas:
                self._status.ideas_failures = 0
                logger.debug("No captured ideas found")
                return

            scored_ideas = self._score_ideas(ideas)

            candidates = [
                idea for idea in scored_ideas
                if idea.get("score", 0) >= min_score
                and idea.get("id") not in self._status.last_surfaced_idea_ids
            ]

            if not candidates:
                self._status.ideas_failures = 0
                logger.debug("No review-worthy ideas above threshold")
                return

            for idea in candidates[:max_per_check]:
                title = idea.get("title") or idea.get("content", "")[:30]
                idea_id = idea.get("id", "")

                if len(title) > 40:
                    title = title[:37] + "..."

                await self._push_status(
                    message=f'Review "{title}"?',
                    message_type="hint",
                    prompt=f"@idea_explorer {idea_id}",
                    ttl=300,
                )
                self._status.last_surfaced_idea_ids.add(idea_id)
                logger.info(f"Surfaced idea for review: {idea_id}")

            self._status.ideas_failures = 0

        except Exception as e:
            logger.error(f"Ideas check failed: {e}")
            self._status.ideas_failures += 1

    async def check_context_bundles(self) -> None:
        """Check for stale context bundles and refresh them."""
        if not self._bundle_service:
            logger.debug("Bundle service not available")
            return

        try:
            self._status.last_bundle_refresh_check = datetime.now()

            statuses = self._bundle_service.list_all()

            if not statuses:
                logger.debug("No context bundles found")
                self._status.bundle_refresh_failures = 0
                return

            stale_bundles = [s for s in statuses if s.is_stale]

            if not stale_bundles:
                logger.debug(f"No stale bundles (checked {len(statuses)} bundles)")
                self._status.bundle_refresh_failures = 0
                self._status.last_bundle_refresh_count = 0
                return

            logger.info(f"Found {len(stale_bundles)} stale bundles, refreshing...")

            results = await self._bundle_service.refresh_stale()

            refreshed_count = sum(1 for r in results if r.success and r.changed)
            failed_count = sum(1 for r in results if not r.success)

            self._status.last_bundle_refresh_count = refreshed_count

            if refreshed_count > 0:
                bundle_names = [r.bundle_id for r in results if r.success and r.changed][:3]
                names_str = ", ".join(bundle_names)
                if len(bundle_names) < refreshed_count:
                    names_str += f" (+{refreshed_count - len(bundle_names)} more)"

                await self._push_status(
                    message=f"Refreshed {refreshed_count} context bundles",
                    message_type="success",
                    prompt="context status",
                    ttl=60,
                )
                logger.info(f"Refreshed {refreshed_count} bundles: {names_str}")

            if failed_count > 0:
                self._status.bundle_refresh_failures += 1
                max_failures = self._config.max_failures if self._config else 3
                if self._status.bundle_refresh_failures <= max_failures:
                    await self._push_status(
                        message=f"{failed_count} bundle refreshes failed",
                        message_type="warning",
                        prompt="hester context status",
                        ttl=120,
                    )
            else:
                self._status.bundle_refresh_failures = 0

        except Exception as e:
            logger.error(f"Context bundle refresh check failed: {e}")
            self._status.bundle_refresh_failures += 1

    def _score_ideas(self, ideas: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Score ideas by review-worthiness."""
        now = datetime.now()
        scored = []

        for idea in ideas:
            score = 0.0

            created_at_str = idea.get("created_at")
            if created_at_str:
                try:
                    created_at_str = created_at_str.replace("Z", "+00:00")
                    created_at = datetime.fromisoformat(created_at_str)
                    if created_at.tzinfo:
                        created_at = created_at.replace(tzinfo=None)
                    age_hours = (now - created_at).total_seconds() / 3600

                    if age_hours < 24:
                        score += 0.3
                    elif age_hours < 48:
                        score += 0.2
                    elif age_hours < 168:
                        score += 0.1
                except (ValueError, TypeError):
                    pass

            tags = idea.get("tags") or []
            if len(tags) >= 3:
                score += 0.2
            elif len(tags) >= 1:
                score += 0.1

            entities = idea.get("related_entities") or {}
            if entities.get("files") or entities.get("concepts"):
                score += 0.2
            elif entities:
                score += 0.1

            source = idea.get("source_type", "")
            if source in ("slack_dm", "voice"):
                score += 0.15
            elif source == "cli":
                score += 0.1

            content = idea.get("content") or ""
            if len(content) > 100:
                score += 0.15
            elif len(content) > 50:
                score += 0.1

            idea["score"] = score
            scored.append(idea)

        return sorted(scored, key=lambda x: x.get("score", 0), reverse=True)

    async def _parse_test_failures(self, stdout: str, stderr: str, test_runner: str) -> int:
        """Parse test output to extract failure count."""
        import re
        output = stdout + stderr

        try:
            if test_runner == "pytest":
                match = re.search(r"(\d+) failed", output)
                if match:
                    return int(match.group(1))
                return 1

            elif test_runner == "npm":
                lines = output.split("\n")
                for line in lines:
                    if "failing" in line.lower():
                        match = re.search(r"(\d+)", line)
                        if match:
                            return int(match.group(1))
                return 1

            elif "manage.py" in test_runner:
                if "FAILED" in output:
                    return output.count("FAILED")
                return 1

        except (ValueError, AttributeError):
            pass

        return 1

    async def _run_hester_command(self, args: List[str]) -> subprocess.CompletedProcess:
        """Run a hester CLI command."""
        hester_cmd = [sys.executable, "-m", "hester"] + args
        return await self._run_command(hester_cmd)

    async def _run_command(
        self,
        cmd: List[str],
        timeout: float = 30.0,
        cwd: Optional[Path] = None,
    ) -> subprocess.CompletedProcess:
        """Run a subprocess command asynchronously through an interactive login shell."""
        process = None
        work_dir = cwd or self._working_dir

        try:
            shell = os.environ.get("SHELL", "/bin/bash")

            cmd_str = " ".join(
                f'"{arg}"' if " " in arg else arg
                for arg in cmd
            )

            process = await asyncio.create_subprocess_exec(
                shell,
                "-il",
                "-c",
                cmd_str,
                cwd=work_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )

            return subprocess.CompletedProcess(
                args=cmd,
                returncode=process.returncode or 0,
                stdout=stdout.decode("utf-8", errors="replace"),
                stderr=stderr.decode("utf-8", errors="replace"),
            )

        except asyncio.TimeoutError:
            logger.warning(f"Command timed out: {' '.join(cmd)}")
            if process:
                try:
                    process.kill()
                    await process.wait()
                except:
                    pass

            return subprocess.CompletedProcess(
                args=cmd,
                returncode=124,
                stdout="",
                stderr=f"Command timed out after {timeout}s",
            )

        except Exception as e:
            logger.error(f"Command failed: {' '.join(cmd)}: {e}")
            return subprocess.CompletedProcess(
                args=cmd,
                returncode=1,
                stdout="",
                stderr=str(e),
            )

    async def _push_status(
        self,
        message: str,
        message_type: str = "hint",
        prompt: Optional[str] = None,
        ttl: Optional[int] = None,
    ) -> None:
        """Push status notification to Lee."""
        try:
            from ..tools.ui_control import push_status_message

            await push_status_message(
                message=message,
                message_type=message_type,
                prompt=prompt,
                ttl=ttl,
            )
            logger.info(f"Pushed status: {message}")
        except Exception as e:
            logger.debug(f"Failed to push status: {e}")

    def get_status(self) -> ProactiveStatus:
        """Get current proactive monitoring status."""
        return self._status

    def reset_failures(self) -> None:
        """Reset failure counters."""
        self._status.docs_index_failures = 0
        self._status.drift_failures = 0
        self._status.devops_failures = 0
        self._status.test_failures = 0
        self._status.ideas_failures = 0
        self._status.bundle_refresh_failures = 0
        self._status.custom_task_failures = {}
        logger.info("ProactiveWatcher failure counters reset")
