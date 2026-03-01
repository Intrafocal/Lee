"""
GitWatcher - Background task for git status polling.

Polls git status periodically and suggests:
- Documentation for new files
- Commits for uncommitted changes

Poll Interval: 10 minutes (600s)
"""

import asyncio
import logging
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("hester.daemon.knowledge.git_watcher")

# Poll interval (10 minutes)
POLL_INTERVAL_SECONDS = 600


@dataclass
class GitStatus:
    """Parsed git status information."""

    untracked_files: List[str] = field(default_factory=list)
    modified_files: List[str] = field(default_factory=list)
    staged_files: List[str] = field(default_factory=list)
    deleted_files: List[str] = field(default_factory=list)
    branch: str = ""
    ahead: int = 0
    behind: int = 0

    @property
    def has_changes(self) -> bool:
        """Check if there are any uncommitted changes."""
        return bool(
            self.untracked_files or
            self.modified_files or
            self.staged_files or
            self.deleted_files
        )

    @property
    def total_changes(self) -> int:
        """Total number of changed files."""
        return (
            len(self.untracked_files) +
            len(self.modified_files) +
            len(self.staged_files) +
            len(self.deleted_files)
        )


class GitWatcher:
    """
    Background task that polls git status and suggests actions.

    Suggests:
    - "N new files. Document?" when untracked files detected
    - "N uncommitted changes. Commit?" when changes exist

    Usage:
        watcher = GitWatcher(working_dir=Path("/workspace"))
        await watcher.start()
        # ... later ...
        await watcher.stop()
    """

    def __init__(
        self,
        working_dir: Path,
        poll_interval: int = POLL_INTERVAL_SECONDS,
    ):
        """
        Initialize the git watcher.

        Args:
            working_dir: Working directory (must be a git repo)
            poll_interval: Poll interval in seconds (default: 600)
        """
        self._working_dir = Path(working_dir)
        self._poll_interval = poll_interval
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._last_status: Optional[GitStatus] = None
        self._seen_untracked: Set[str] = set()  # Track files we've already suggested

    @property
    def is_running(self) -> bool:
        """Check if watcher is running."""
        return self._running

    async def start(self) -> None:
        """Start the git watcher background task."""
        if self._running:
            logger.warning("GitWatcher already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(f"GitWatcher started: interval={self._poll_interval}s")

    async def stop(self) -> None:
        """Stop the git watcher."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("GitWatcher stopped")

    async def _poll_loop(self) -> None:
        """Main polling loop."""
        while self._running:
            try:
                await asyncio.sleep(self._poll_interval)
            except asyncio.CancelledError:
                return

            if not self._running:
                return

            await self.check_status()

    async def check_status(self) -> None:
        """
        Check git status and push suggestions if needed.

        Called periodically by the poll loop.
        """
        try:
            status = await self._get_git_status()
            if not status:
                return

            self._last_status = status

            # Check for new untracked files
            new_untracked = [
                f for f in status.untracked_files
                if f not in self._seen_untracked
            ]

            if new_untracked:
                # Mark as seen
                self._seen_untracked.update(new_untracked)

                # Suggest documentation
                await self._push_status(
                    f"{len(new_untracked)} new files. Document?",
                    "hint",
                    prompt=f"document new files: {', '.join(new_untracked[:5])}",
                    ttl=180,
                )

            # Check for uncommitted changes
            if status.has_changes and status.total_changes >= 5:
                await self._push_status(
                    f"{status.total_changes} uncommitted changes. Commit?",
                    "hint",
                    prompt="commit the current changes",
                    ttl=180,
                )

        except Exception as e:
            logger.debug(f"Git status check failed: {e}")

    async def _get_git_status(self) -> Optional[GitStatus]:
        """
        Get current git status.

        Returns:
            GitStatus or None if not a git repo
        """
        try:
            # Check if it's a git repo
            result = subprocess.run(
                ["git", "rev-parse", "--git-dir"],
                cwd=self._working_dir,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                return None

            # Get branch info
            branch_result = subprocess.run(
                ["git", "branch", "--show-current"],
                cwd=self._working_dir,
                capture_output=True,
                text=True,
            )
            branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""

            # Get status --porcelain
            status_result = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=self._working_dir,
                capture_output=True,
                text=True,
            )
            if status_result.returncode != 0:
                return None

            status = GitStatus(branch=branch)

            for line in status_result.stdout.strip().split("\n"):
                if not line:
                    continue

                # Parse status codes
                index_status = line[0] if len(line) > 0 else " "
                work_tree_status = line[1] if len(line) > 1 else " "
                file_path = line[3:].strip() if len(line) > 3 else ""

                if not file_path:
                    continue

                # Untracked
                if index_status == "?" and work_tree_status == "?":
                    status.untracked_files.append(file_path)
                # Staged
                elif index_status in "MADRCT" and work_tree_status == " ":
                    status.staged_files.append(file_path)
                # Modified
                elif work_tree_status == "M":
                    status.modified_files.append(file_path)
                # Deleted
                elif work_tree_status == "D" or index_status == "D":
                    status.deleted_files.append(file_path)

            # Get ahead/behind info
            status_sb = subprocess.run(
                ["git", "status", "-sb"],
                cwd=self._working_dir,
                capture_output=True,
                text=True,
            )
            if status_sb.returncode == 0:
                first_line = status_sb.stdout.split("\n")[0]
                if "ahead" in first_line:
                    import re
                    ahead_match = re.search(r"ahead (\d+)", first_line)
                    if ahead_match:
                        status.ahead = int(ahead_match.group(1))
                if "behind" in first_line:
                    import re
                    behind_match = re.search(r"behind (\d+)", first_line)
                    if behind_match:
                        status.behind = int(behind_match.group(1))

            return status

        except Exception as e:
            logger.debug(f"Failed to get git status: {e}")
            return None

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
        except Exception as e:
            logger.debug(f"Failed to push status: {e}")

    def get_last_status(self) -> Optional[GitStatus]:
        """Get the last known git status."""
        return self._last_status

    def clear_seen_files(self) -> None:
        """Clear the set of seen untracked files."""
        self._seen_untracked.clear()
