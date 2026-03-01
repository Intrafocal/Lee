"""
TUI selectors - interactive keyboard-driven selection widgets.
"""

import sys
from typing import Optional

from rich.console import Console
from rich.text import Text

from ..thinking_depth import ThinkingDepth
from .constants import DEPTH_OPTIONS


class DepthSelector:
    """
    Horizontal arrow-key selector for choosing thinking depth continuation/escalation.

    Single-line display with left/right navigation.
    """

    def __init__(self, console: Console, current_depth: ThinkingDepth):
        self.console = console
        self.current_depth = current_depth
        self.selected_index = 0

        # Build options: current depth (2x), then higher depths, then cancel
        self.options = []

        # First option: continue at current depth (again)
        current_info = next((opt for opt in DEPTH_OPTIONS if opt[0] == current_depth), None)
        if current_info:
            self.options.append((current_depth, current_info[1], f"{current_info[2]} (again)"))

        # Add depths higher than current
        for opt in DEPTH_OPTIONS:
            if opt[0].value > current_depth.value:
                self.options.append(opt)

        # Add cancel option
        self.options.append((None, "cancel", ""))

    def _render(self) -> Text:
        """Render the single-line selector."""
        text = Text()
        text.append("Continue? ", style="yellow")
        text.append("[", style="dim")

        for i, (depth, name, extra) in enumerate(self.options):
            if i > 0:
                text.append(" | ", style="dim")

            if i == self.selected_index:
                # Selected option - highlighted
                text.append(name, style="cyan bold underline")
                if extra:
                    text.append(f" {extra}", style="cyan")
            else:
                # Unselected option
                text.append(name, style="dim")
                if extra:
                    text.append(f" {extra}", style="dim")

        text.append("]", style="dim")
        text.append("  ←→ select, enter confirm", style="dim")

        return text

    async def select(self) -> Optional[ThinkingDepth]:
        """
        Run the interactive selector.

        Returns:
            Selected ThinkingDepth or None if cancelled
        """
        import termios
        import tty

        # Save terminal settings
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            # Initial render
            self.console.print(self._render())

            # Set terminal to raw mode for key reading
            tty.setraw(fd)

            while True:
                # Read a keypress
                ch = sys.stdin.read(1)

                if ch == '\x1b':  # Escape sequence
                    # Read the rest of the escape sequence
                    ch2 = sys.stdin.read(1)
                    if ch2 == '[':
                        ch3 = sys.stdin.read(1)
                        if ch3 == 'D':  # Left arrow
                            self.selected_index = max(0, self.selected_index - 1)
                        elif ch3 == 'C':  # Right arrow
                            self.selected_index = min(len(self.options) - 1, self.selected_index + 1)
                    elif ch2 == '' or ch2 == '\x1b':  # Plain Escape
                        # Cancel
                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        sys.stdout.write("\033[1A\033[2K\r")  # Clear line
                        sys.stdout.flush()
                        return None

                elif ch == '\r' or ch == '\n':  # Enter
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")  # Clear line
                    sys.stdout.flush()
                    selected = self.options[self.selected_index]
                    return selected[0]  # Return the ThinkingDepth or None

                elif ch == '\x03':  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")  # Clear line
                    sys.stdout.flush()
                    raise KeyboardInterrupt

                elif ch == 'q' or ch == 'Q':  # Quick cancel
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")  # Clear line
                    sys.stdout.flush()
                    return None

                # Re-render (clear and reprint single line)
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                sys.stdout.write("\033[1A\033[2K\r")  # Move up, clear line
                sys.stdout.flush()
                self.console.print(self._render())
                tty.setraw(fd)

        finally:
            # Restore terminal settings
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


class TaskReadySelector:
    """
    Horizontal arrow-key selector for handling a ready task.

    Options: execute (background), stream (foreground), review, feedback, skip
    """

    def __init__(self, console: Console, task_id: str, task_title: str):
        self.console = console
        self.task_id = task_id
        self.task_title = task_title
        self.selected_index = 0

        # Options: review first, then execute modes, feedback, or skip
        self.options = [
            ("review", "review"),
            ("execute", "execute"),      # Background (default)
            ("stream", "stream"),        # Foreground/blocking
            ("feedback", "feedback"),
            ("skip", "skip"),
        ]

    def _render(self) -> Text:
        """Render the single-line selector."""
        text = Text()
        text.append(f"Task ", style="yellow")
        text.append(f"{self.task_id}", style="cyan bold")
        text.append(f" ready. ", style="yellow")
        text.append("[", style="dim")

        for i, (action, label) in enumerate(self.options):
            if i > 0:
                text.append(" | ", style="dim")

            if i == self.selected_index:
                style = "green bold underline" if action == "execute" else "cyan bold underline"
                text.append(label, style=style)
            else:
                text.append(label, style="dim")

        text.append("]", style="dim")
        text.append("  ←→ select, enter confirm", style="dim")

        return text

    async def select(self) -> Optional[str]:
        """
        Run the interactive selector.

        Returns:
            'execute', 'stream', 'review', 'feedback', or None (skip)
        """
        import termios
        import tty

        # Save terminal settings
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            # Initial render
            self.console.print(self._render())

            # Set terminal to raw mode for key reading
            tty.setraw(fd)

            while True:
                # Read a keypress
                ch = sys.stdin.read(1)

                if ch == '\x1b':  # Escape sequence
                    ch2 = sys.stdin.read(1)
                    if ch2 == '[':
                        ch3 = sys.stdin.read(1)
                        if ch3 == 'D':  # Left arrow
                            self.selected_index = max(0, self.selected_index - 1)
                        elif ch3 == 'C':  # Right arrow
                            self.selected_index = min(len(self.options) - 1, self.selected_index + 1)
                    elif ch2 == '' or ch2 == '\x1b':  # Plain Escape
                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        sys.stdout.write("\033[1A\033[2K\r")
                        sys.stdout.flush()
                        return None

                elif ch == '\r' or ch == '\n':  # Enter
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    action = self.options[self.selected_index][0]
                    return action if action != "skip" else None

                elif ch == '\x03':  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    raise KeyboardInterrupt

                # Quick keys
                elif ch == 'r' or ch == 'R':  # Quick review
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return "review"

                elif ch == 'e' or ch == 'E' or ch == 'y' or ch == 'Y':  # Quick execute (background)
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return "execute"

                elif ch == 's' or ch == 'S':  # Quick stream (foreground)
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return "stream"

                elif ch == 'f' or ch == 'F':  # Quick feedback
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return "feedback"

                elif ch == 'q' or ch == 'Q' or ch == 'n' or ch == 'N':  # Quick skip
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return None

                # Re-render
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                sys.stdout.write("\033[1A\033[2K\r")
                sys.stdout.flush()
                self.console.print(self._render())
                tty.setraw(fd)

        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


class FailedTaskRetrySelector:
    """
    Horizontal arrow-key selector for retrying a failed task.

    Options: replan, reset, cancel
    """

    def __init__(self, console: Console, task_id: str, task_title: str):
        self.console = console
        self.task_id = task_id
        self.task_title = task_title
        self.selected_index = 0

        self.options = [
            ("replan", "re-plan"),
            ("reset", "reset & retry"),
            ("cancel", "cancel"),
        ]

    def _render(self) -> Text:
        """Render the single-line selector."""
        text = Text()
        text.append(f"Retry ", style="yellow")
        text.append(f"{self.task_id}", style="red bold")
        text.append(f"? ", style="yellow")
        text.append("[", style="dim")

        for i, (action, label) in enumerate(self.options):
            if i > 0:
                text.append(" | ", style="dim")

            if i == self.selected_index:
                style = "green bold underline" if action == "replan" else "cyan bold underline"
                text.append(label, style=style)
            else:
                text.append(label, style="dim")

        text.append("]", style="dim")
        text.append("  ←→ select, enter confirm", style="dim")

        return text

    async def select(self) -> Optional[str]:
        """
        Run the interactive selector.

        Returns:
            'replan', 'reset', or None (cancel)
        """
        import termios
        import tty

        # Save terminal settings
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            # Initial render
            self.console.print(self._render())

            # Set terminal to raw mode for key reading
            tty.setraw(fd)

            while True:
                # Read a keypress
                ch = sys.stdin.read(1)

                if ch == '\x1b':  # Escape sequence
                    ch2 = sys.stdin.read(1)
                    if ch2 == '[':
                        ch3 = sys.stdin.read(1)
                        if ch3 == 'D':  # Left arrow
                            self.selected_index = max(0, self.selected_index - 1)
                        elif ch3 == 'C':  # Right arrow
                            self.selected_index = min(len(self.options) - 1, self.selected_index + 1)
                    elif ch2 == '' or ch2 == '\x1b':  # Plain Escape
                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        sys.stdout.write("\033[1A\033[2K\r")
                        sys.stdout.flush()
                        return None

                elif ch == '\r' or ch == '\n':  # Enter
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    action = self.options[self.selected_index][0]
                    return action if action != "cancel" else None

                elif ch == '\x03':  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    raise KeyboardInterrupt

                # Quick keys
                elif ch == 'p' or ch == 'P' or ch == '1':  # Quick re-plan
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return "replan"

                elif ch == 'r' or ch == 'R' or ch == '2':  # Quick reset
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return "reset"

                elif ch == 'c' or ch == 'C' or ch == 'q' or ch == 'Q' or ch == 'n' or ch == 'N' or ch == '3':  # Quick cancel
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    sys.stdout.write("\033[1A\033[2K\r")
                    sys.stdout.flush()
                    return None

                # Re-render
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                sys.stdout.write("\033[1A\033[2K\r")
                sys.stdout.flush()
                self.console.print(self._render())
                tty.setraw(fd)

        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


class TasksMenuSelector:
    """
    Vertical arrow-key selector for browsing and acting on tasks.

    Shows a list of tasks with status and contextual actions.
    """

    def __init__(self, console: Console, tasks: list, running_task_ids: set = None):
        self.console = console
        self.tasks = tasks
        self.running_task_ids = running_task_ids or set()
        self.selected_index = 0
        self.num_display_lines = 0  # Track how many lines we've rendered

    def _get_status_style(self, status_value: str) -> tuple:
        """Get style and icon for status."""
        styles = {
            "planning": ("yellow", "◐"),
            "ready": ("green", "●"),
            "executing": ("blue", "⟳"),
            "completed": ("green dim", "✓"),
            "failed": ("red", "✗"),
        }
        return styles.get(status_value, ("dim", "○"))

    def _get_actions_for_task(self, task) -> list:
        """Get contextual actions based on task status."""
        status = task.status.value
        actions = [("view", "v")]  # Always can view

        if status == "planning":
            actions.append(("edit", "e"))
        elif status == "ready":
            actions.extend([("execute", "e"), ("stream", "s")])
        elif status == "executing":
            actions.extend([("watch", "w"), ("logs", "l")])
        elif status == "completed":
            actions.append(("rerun", "r"))
        elif status == "failed":
            actions.extend([("retry", "r"), ("replan", "p")])

        actions.append(("delete", "d"))
        return actions

    def _render(self) -> list:
        """Render the task list with selection."""
        import shutil
        term_width = min(shutil.get_terminal_size().columns - 2, 70)  # Max 70 chars wide
        inner_width = term_width - 2  # Account for border chars

        lines = []

        # Top border with title
        title = f" Tasks ({len(self.tasks)}) "
        title_len = len(title)
        lines.append(Text("╭" + title + "─" * (inner_width - title_len) + "╮", style="dim"))

        # Hint line - build content first, then pad
        hint_content = "↑↓ navigate  enter/key select  q quit"
        hint = Text("│ ", style="dim")
        hint.append("↑↓", style="cyan")
        hint.append(" navigate  ", style="dim")
        hint.append("enter/key", style="cyan")
        hint.append(" select  ", style="dim")
        hint.append("q", style="cyan")
        hint.append(" quit", style="dim")
        # Pad to align right border (inner_width - 1 for leading space - content length)
        padding = inner_width - 1 - len(hint_content)
        hint.append(" " * max(0, padding) + "│", style="dim")
        lines.append(hint)
        lines.append(Text("├" + "─" * inner_width + "┤", style="dim"))

        if not self.tasks:
            no_tasks = "No tasks found."
            lines.append(Text("│ " + no_tasks + " " * (inner_width - len(no_tasks) - 1) + "│", style="dim"))
            lines.append(Text("╰" + "─" * inner_width + "╯", style="dim"))
            return lines

        for i, task in enumerate(self.tasks):
            is_selected = i == self.selected_index
            style, icon = self._get_status_style(task.status.value)

            # Check if task is running in background
            is_background = task.id in self.running_task_ids
            if is_background:
                icon = "⟳"
                style = "blue"

            # Build the visible content to calculate padding
            sel_indicator = "▸ " if is_selected else "  "
            status_text = f"[{task.status.value}]"
            bg_text = " (bg)" if is_background else ""

            # Calculate available space for title
            # Format: "│ " + sel + icon + " " + id + " " + title + " " + status + bg + " │"
            fixed_chars = 2 + 2 + 2 + len(task.id) + 1 + 1 + len(status_text) + len(bg_text) + 2
            max_title_len = inner_width - fixed_chars

            title = task.title[:max_title_len - 3] + "..." if len(task.title) > max_title_len else task.title

            # Build the line
            line = Text("│ ", style="dim")
            line.append(sel_indicator, style="cyan bold" if is_selected else "dim")
            line.append(f"{icon} ", style=style)
            line.append(task.id, style="cyan bold" if is_selected else "cyan")
            line.append(f" {title}", style="" if is_selected else "dim")
            line.append(f" {status_text}", style=style)
            if is_background:
                line.append(bg_text, style="blue dim")

            # Calculate actual content length and pad to right border
            content_len = 2 + 2 + 2 + len(task.id) + 1 + len(title) + 1 + len(status_text) + len(bg_text)
            padding = inner_width - content_len
            line.append(" " * max(0, padding) + "│", style="dim")
            lines.append(line)

            # Show actions for selected task
            if is_selected:
                action_line = Text("│     ", style="dim")
                actions = self._get_actions_for_task(task)
                action_content_len = 5  # "│     " prefix
                for j, (action, key) in enumerate(actions):
                    if j > 0:
                        action_line.append(" │ ", style="dim")
                        action_content_len += 3
                    action_line.append(f"[{key}]", style="cyan")
                    action_line.append(action, style="dim")
                    action_content_len += 2 + len(key) + len(action)
                # Pad action line to right border
                action_padding = inner_width - action_content_len
                action_line.append(" " * max(0, action_padding) + "│", style="dim")
                lines.append(action_line)

        # Bottom border
        lines.append(Text("╰" + "─" * inner_width + "╯", style="dim"))
        return lines

    def _clear_display(self):
        """Clear previously rendered lines."""
        if self.num_display_lines > 0:
            # Move up and clear each line
            sys.stdout.write(f"\033[{self.num_display_lines}A")
            for _ in range(self.num_display_lines):
                sys.stdout.write("\033[2K\n")
            sys.stdout.write(f"\033[{self.num_display_lines}A")
            sys.stdout.flush()

    async def select(self) -> tuple:
        """
        Run the interactive selector.

        Returns:
            Tuple of (action, task_id) or (None, None) if cancelled
        """
        import termios
        import tty

        if not self.tasks:
            self.console.print("[dim]No tasks found.[/dim]")
            return (None, None)

        # Save terminal settings
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            # Initial render
            lines = self._render()
            self.num_display_lines = len(lines)
            for line in lines:
                self.console.print(line)

            # Set terminal to raw mode for key reading
            tty.setraw(fd)

            while True:
                # Read a keypress
                ch = sys.stdin.read(1)
                selected_task = self.tasks[self.selected_index] if self.tasks else None
                actions = self._get_actions_for_task(selected_task) if selected_task else []
                action_keys = {key: action for action, key in actions}

                if ch == '\x1b':  # Escape sequence
                    ch2 = sys.stdin.read(1)
                    if ch2 == '[':
                        ch3 = sys.stdin.read(1)
                        if ch3 == 'A':  # Up arrow
                            self.selected_index = max(0, self.selected_index - 1)
                        elif ch3 == 'B':  # Down arrow
                            self.selected_index = min(len(self.tasks) - 1, self.selected_index + 1)
                    elif ch2 == '' or ch2 == '\x1b':  # Plain Escape
                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        self._clear_display()
                        return (None, None)

                elif ch == '\r' or ch == '\n':  # Enter - default to view
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    return ("view", selected_task.id if selected_task else None)

                elif ch == '\x03':  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    raise KeyboardInterrupt

                elif ch == 'q' or ch == 'Q':  # Quit
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    return (None, None)

                elif ch.lower() in action_keys:  # Action key
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    return (action_keys[ch.lower()], selected_task.id if selected_task else None)

                # Re-render
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                self._clear_display()
                lines = self._render()
                self.num_display_lines = len(lines)
                for line in lines:
                    self.console.print(line)
                tty.setraw(fd)

        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


class TaskActionSelector:
    """
    Compact action selector for a single task.

    Shows available actions in a single-line menu format.
    """

    def __init__(self, console: Console, task, is_running: bool = False):
        self.console = console
        self.task = task
        self.is_running = is_running
        self.num_display_lines = 0

    def _get_actions_for_task(self) -> list:
        """Get contextual actions based on task status."""
        status = self.task.status.value
        actions = []

        if status == "planning":
            actions.append(("edit", "e"))
        elif status == "ready":
            actions.extend([("execute", "x"), ("stream", "s")])
        elif status == "executing":
            actions.extend([("watch", "w"), ("logs", "l")])
        elif status == "completed":
            actions.append(("rerun", "r"))
        elif status == "failed":
            actions.extend([("retry", "r"), ("replan", "p")])

        actions.append(("delete", "d"))
        actions.append(("back", "q"))
        return actions

    def _render(self) -> Text:
        """Render the action bar."""
        import shutil
        term_width = min(shutil.get_terminal_size().columns - 2, 70)

        line = Text()
        line.append("Actions: ", style="dim")

        actions = self._get_actions_for_task()
        for i, (action, key) in enumerate(actions):
            if i > 0:
                line.append(" │ ", style="dim")
            line.append(f"[{key}]", style="cyan")
            line.append(action, style="dim")

        return line

    def _clear_display(self):
        """Clear previously rendered lines."""
        if self.num_display_lines > 0:
            sys.stdout.write(f"\033[{self.num_display_lines}A")
            for _ in range(self.num_display_lines):
                sys.stdout.write("\033[2K\n")
            sys.stdout.write(f"\033[{self.num_display_lines}A")
            sys.stdout.flush()

    async def select(self) -> Optional[str]:
        """
        Run the interactive action selector.

        Returns:
            Action string or None if cancelled
        """
        import termios
        import tty

        actions = self._get_actions_for_task()
        action_keys = {key: action for action, key in actions}

        # Save terminal settings
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            # Render action bar
            line = self._render()
            self.num_display_lines = 1
            self.console.print(line)

            # Set terminal to raw mode
            tty.setraw(fd)

            while True:
                ch = sys.stdin.read(1)

                if ch == '\x1b':  # Escape
                    ch2 = sys.stdin.read(1)
                    if ch2 == '' or ch2 == '\x1b':
                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        self._clear_display()
                        return None

                elif ch == '\x03':  # Ctrl+C
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    raise KeyboardInterrupt

                elif ch in ('q', 'Q', '\r', '\n'):  # Quit/Enter = back
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    return None

                elif ch.lower() in action_keys:
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                    self._clear_display()
                    return action_keys[ch.lower()]

        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
