"""
TUI completers - command and task completion for prompt_toolkit.
"""

from pathlib import Path
from typing import Callable, List

from prompt_toolkit.completion import Completer, Completion


class SlashCommandCompleter(Completer):
    """Completer for slash commands."""

    def __init__(self, commands: List[tuple]):
        self.commands = commands

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        # Only complete if starting with /
        if text.startswith("/"):
            for cmd, desc in self.commands:
                if cmd.startswith(text):
                    yield Completion(
                        cmd,
                        start_position=-len(text),
                        display=cmd,
                        display_meta=desc,
                    )


class CommandMenuCompleter(Completer):
    """Shows full command menu when triggered."""

    def __init__(self, commands: List[tuple]):
        self.commands = commands

    def get_completions(self, document, complete_event):
        # Show all commands
        for cmd, desc in self.commands:
            yield Completion(
                cmd,
                start_position=-len(document.text_before_cursor),
                display=cmd,
                display_meta=desc,
            )


class HesterCompleter(Completer):
    """
    Combined completer for Hester TUI.

    Handles:
    - Slash commands (/)
    - Task ID completion after /task or /execute
    """

    def __init__(self, commands: List[tuple], working_dir_getter: Callable[[], str]):
        self.commands = commands
        self.working_dir_getter = working_dir_getter  # Callable to get current working dir
        self._task_cache = []
        self._task_cache_time = 0

    def _get_tasks(self):
        """Get tasks with simple caching (refresh every 2 seconds)."""
        import time
        now = time.time()
        if now - self._task_cache_time > 2:
            try:
                from ..tasks import TaskStore
                store = TaskStore(working_dir=Path(self.working_dir_getter()))
                self._task_cache = store.list_all()
                self._task_cache_time = now
            except Exception:
                self._task_cache = []
        return self._task_cache

    def _get_status_indicator(self, status_value: str) -> str:
        """Get status indicator for display."""
        indicators = {
            "planning": "◐",
            "ready": "●",
            "executing": "⟳",
            "completed": "✓",
            "failed": "✗",
        }
        return indicators.get(status_value, "○")

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor

        # Check if completing task ID after /task or /execute
        if text.startswith("/task ") or text.startswith("/execute "):
            prefix = "/task " if text.startswith("/task ") else "/execute "
            partial_id = text[len(prefix):]

            tasks = self._get_tasks()
            for task in tasks:
                if task.id.startswith(partial_id) or not partial_id:
                    indicator = self._get_status_indicator(task.status.value)
                    # Truncate title for display
                    title = task.title[:30] + "..." if len(task.title) > 30 else task.title
                    yield Completion(
                        task.id,
                        start_position=-len(partial_id),
                        display=f"{indicator} {task.id}",
                        display_meta=f"{task.status.value}: {title}",
                    )
            return

        # Regular slash command completion
        if text.startswith("/"):
            for cmd, desc in self.commands:
                if cmd.startswith(text):
                    yield Completion(
                        cmd,
                        start_position=-len(text),
                        display=cmd,
                        display_meta=desc,
                    )
