"""
TaskWatcher - Task completion hooks for documentation suggestions.

Monitors completed tasks and suggests documentation when:
- Significant code changes are made (>50 lines)
- New files are created
- Test files are modified

Triggered by ClaudeDelegate task completion.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger("hester.daemon.knowledge.task_watcher")

# Threshold for "significant" changes
SIGNIFICANT_LINES = 50


@dataclass
class CompletedTask:
    """Information about a completed task."""

    task_id: str
    title: str
    goal: str
    files_changed: List[str] = field(default_factory=list)
    files_created: List[str] = field(default_factory=list)
    lines_added: int = 0
    lines_removed: int = 0
    duration_seconds: float = 0
    completed_at: datetime = field(default_factory=datetime.utcnow)

    @property
    def total_lines_changed(self) -> int:
        """Total lines changed (added + removed)."""
        return self.lines_added + self.lines_removed

    @property
    def is_significant(self) -> bool:
        """Check if changes are significant enough to suggest documentation."""
        return (
            self.total_lines_changed >= SIGNIFICANT_LINES or
            len(self.files_created) >= 2
        )


class TaskWatcher:
    """
    Watches task completions and suggests documentation.

    Triggered by ClaudeDelegate or TaskExecutor after task completion.
    Analyzes changes and suggests documentation for significant work.

    Usage:
        watcher = TaskWatcher(working_dir=Path("/workspace"))

        # After task completes
        await watcher.on_task_complete(CompletedTask(
            task_id="...",
            title="Implement auth",
            goal="Add authentication",
            files_changed=["auth.py", "config.py"],
            lines_added=150,
        ))
    """

    def __init__(
        self,
        working_dir: Path,
        significant_lines: int = SIGNIFICANT_LINES,
    ):
        """
        Initialize the task watcher.

        Args:
            working_dir: Working directory
            significant_lines: Threshold for significant changes
        """
        self._working_dir = Path(working_dir)
        self._significant_lines = significant_lines
        self._recent_tasks: List[CompletedTask] = []
        self._suggested_files: Set[str] = set()  # Files we've already suggested

    async def on_task_complete(self, task: CompletedTask) -> None:
        """
        Handle task completion.

        Analyzes the completed task and suggests documentation if appropriate.

        Args:
            task: CompletedTask with details about what was done
        """
        # Store for history
        self._recent_tasks.append(task)
        if len(self._recent_tasks) > 50:  # Keep last 50 tasks
            self._recent_tasks.pop(0)

        # Check if task is significant
        if not task.is_significant:
            logger.debug(f"Task {task.task_id} not significant enough for doc suggestion")
            return

        # Check for files to suggest documentation
        files_to_document = []

        for file_path in task.files_created:
            if file_path not in self._suggested_files:
                files_to_document.append(file_path)

        for file_path in task.files_changed:
            # Check if it's a significant change to an undocumented file
            if self._is_code_file(file_path) and file_path not in self._suggested_files:
                files_to_document.append(file_path)

        if files_to_document:
            # Mark as suggested
            self._suggested_files.update(files_to_document)

            # Push suggestion
            await self._push_doc_suggestion(task, files_to_document)

    def _is_code_file(self, file_path: str) -> bool:
        """Check if file is a code file (not config, test, etc.)."""
        path = Path(file_path)
        ext = path.suffix.lower()

        # Skip test files
        if "test" in path.name.lower() or path.name.startswith("test_"):
            return False

        # Skip config files
        if path.name in ("pyproject.toml", "setup.py", "setup.cfg", "config.yaml"):
            return False

        # Only code files
        return ext in (".py", ".ts", ".js", ".dart", ".go", ".rs", ".java")

    async def _push_doc_suggestion(
        self,
        task: CompletedTask,
        files: List[str],
    ) -> None:
        """Push documentation suggestion to Lee."""
        try:
            from ..tools.ui_control import push_status_message

            if len(files) == 1:
                message = f"New code: {files[0]}. Document?"
                prompt = f"document {files[0]}"
            else:
                message = f"New code: {len(files)} files. Document?"
                prompt = f"document new code in {', '.join(files[:3])}"

            await push_status_message(
                message=message,
                message_type="hint",
                prompt=prompt,
                ttl=180,
            )

            logger.info(f"Suggested documentation for: {', '.join(files[:5])}")

        except Exception as e:
            logger.debug(f"Failed to push doc suggestion: {e}")

    def get_recent_tasks(self, limit: int = 10) -> List[CompletedTask]:
        """Get recent completed tasks."""
        return self._recent_tasks[-limit:]

    def clear_suggested_files(self) -> None:
        """Clear the set of suggested files."""
        self._suggested_files.clear()

    def get_stats(self) -> Dict[str, Any]:
        """Get watcher statistics."""
        return {
            "total_tasks_watched": len(self._recent_tasks),
            "suggested_files_count": len(self._suggested_files),
            "recent_significant_tasks": sum(
                1 for t in self._recent_tasks[-10:]
                if t.is_significant
            ),
        }


# Helper function for creating CompletedTask from git diff
async def analyze_task_changes(
    task_id: str,
    title: str,
    goal: str,
    working_dir: Path,
    before_commit: Optional[str] = None,
    after_commit: str = "HEAD",
) -> CompletedTask:
    """
    Analyze task changes using git diff.

    Args:
        task_id: Task identifier
        title: Task title
        goal: Task goal
        working_dir: Working directory
        before_commit: Commit before task (default: HEAD~1)
        after_commit: Commit after task (default: HEAD)

    Returns:
        CompletedTask with analyzed changes
    """
    import subprocess

    task = CompletedTask(
        task_id=task_id,
        title=title,
        goal=goal,
    )

    if before_commit is None:
        before_commit = "HEAD~1"

    try:
        # Get list of changed files
        diff_names = subprocess.run(
            ["git", "diff", "--name-only", before_commit, after_commit],
            cwd=working_dir,
            capture_output=True,
            text=True,
        )
        if diff_names.returncode == 0:
            task.files_changed = [
                f.strip() for f in diff_names.stdout.strip().split("\n")
                if f.strip()
            ]

        # Get list of new files
        diff_filter = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=A", before_commit, after_commit],
            cwd=working_dir,
            capture_output=True,
            text=True,
        )
        if diff_filter.returncode == 0:
            task.files_created = [
                f.strip() for f in diff_filter.stdout.strip().split("\n")
                if f.strip()
            ]

        # Get line counts
        diff_stat = subprocess.run(
            ["git", "diff", "--stat", before_commit, after_commit],
            cwd=working_dir,
            capture_output=True,
            text=True,
        )
        if diff_stat.returncode == 0:
            # Parse last line for totals
            lines = diff_stat.stdout.strip().split("\n")
            if lines:
                last_line = lines[-1]
                import re
                added_match = re.search(r"(\d+) insertion", last_line)
                removed_match = re.search(r"(\d+) deletion", last_line)
                if added_match:
                    task.lines_added = int(added_match.group(1))
                if removed_match:
                    task.lines_removed = int(removed_match.group(1))

    except Exception as e:
        logger.debug(f"Failed to analyze task changes: {e}")

    return task
