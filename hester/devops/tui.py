"""
DevOps TUI - Simplified terminal interface for service management.

Provides a dashboard showing:
- Quick actions (docker-compose up/down, flutter run)
- Service status from config.yaml
- CLI command hints
- Command input box

Keyboard shortcuts:
- Ctrl+U: docker-compose up
- Ctrl+Shift+U: docker-compose up --build
- Ctrl+D: docker-compose down
- Ctrl+F: flutter run web
- Ctrl+I: flutter run iOS
- Ctrl+S: flutter run simulator
- Up/Down: Navigate services
- Enter: View logs / Execute command
- Esc: Exit fullscreen / Exit
- q: Quit

Uses Rich library for terminal rendering.
"""

import asyncio
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time
import tty
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from rich.console import Console, Group
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.style import Style
from rich.ansi import AnsiDecoder

from .manager import ServiceManager, ServiceConfig, ServiceAction, ServiceStatus


# Styles
STYLES = {
    "running": Style(color="green", bold=True),
    "stopped": Style(color="white", dim=True),
    "error": Style(color="red", bold=True),
    "starting": Style(color="yellow"),
    "healthy": Style(color="green"),
    "unhealthy": Style(color="red"),
    "unreachable": Style(color="yellow"),
    "key": Style(color="cyan", bold=True),
    "hint": Style(color="white", dim=True),
}


@dataclass
class TUIState:
    """Current TUI state."""
    selected_service_index: int = 0
    command_input: str = ""
    mode: str = "dashboard"  # dashboard | logs | command
    log_service_key: str = ""
    command_output: List[Any] = field(default_factory=list)  # List of Text or str (legacy, for non-service commands)
    command_running: bool = False
    background_pid: Optional[int] = None
    status_message: str = ""
    health_results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    service_statuses: Dict[str, ServiceStatus] = field(default_factory=dict)
    input_focused: bool = True
    # Flutter-specific state for hot reload
    flutter_master_fd: Optional[int] = None  # PTY master fd for sending input
    flutter_running: bool = False  # Is Flutter currently running?
    # Currently active service (for running actions)
    active_service: Optional[str] = None
    active_action: Optional[str] = None
    # Tabbed output - per-service output buffers
    service_outputs: Dict[str, List[Any]] = field(default_factory=dict)  # service_name -> output lines
    service_running: Dict[str, bool] = field(default_factory=dict)  # service_name -> is_running
    service_pids: Dict[str, int] = field(default_factory=dict)  # service_name -> PID
    service_master_fds: Dict[str, int] = field(default_factory=dict)  # service_name -> PTY master fd (for Flutter)
    active_output_tab: int = 0  # Index of currently viewed tab in command mode
    output_tabs: List[str] = field(default_factory=list)  # List of service names with output


class DevOpsTUI:
    """
    Simplified Rich-based TUI for service management.

    Features:
    - Quick actions panel with keyboard shortcuts
    - Flat service list with status
    - CLI hints section
    - Command input with auto-execution
    - Fullscreen log/command output views
    """

    def __init__(self, working_dir: str):
        self.console = Console()
        self.manager = ServiceManager(working_dir)
        self.state = TUIState()
        self._live: Optional[Live] = None
        self._running = False

        # Build quick actions map: shortcut_key -> (service, action)
        # e.g., 'u' -> (Docker, up), 'f' -> (Frame, web)
        self._quick_actions: Dict[str, tuple[ServiceConfig, ServiceAction]] = {}
        self._quick_actions = self.manager.get_action_shortcuts()

    def _get_service_cwd(self, service: ServiceConfig) -> str:
        """Get working directory for a service."""
        if service.cwd:
            return str(self.manager.working_dir / service.cwd)
        return str(self.manager.working_dir)

    def _get_selected_service(self) -> Optional[ServiceConfig]:
        """Get currently selected service."""
        if not self.manager.services:
            return None
        if self.state.selected_service_index >= len(self.manager.services):
            self.state.selected_service_index = 0
        return self.manager.services[self.state.selected_service_index]

    def _refresh(self):
        """Refresh the display."""
        if self._live:
            self._live.update(self._create_layout())

    # =========================================================================
    # Layout Builders
    # =========================================================================

    def _create_layout(self) -> Layout:
        """Create layout based on current mode."""
        if self.state.mode == "logs":
            return self._create_fullscreen_logs()
        elif self.state.mode == "command":
            return self._create_fullscreen_command()
        else:
            return self._create_dashboard_layout()

    def _create_dashboard_layout(self) -> Layout:
        """Create the main dashboard layout."""
        layout = Layout()

        layout.split_column(
            Layout(name="header", size=3),
            Layout(name="actions", size=6),
            Layout(name="services"),
            Layout(name="hints", size=6),
            Layout(name="input", size=3),
        )

        layout["header"].update(self._create_header_panel())
        layout["actions"].update(self._create_actions_panel())
        layout["services"].update(self._create_services_panel())
        layout["hints"].update(self._create_hints_panel())
        layout["input"].update(self._create_input_panel())

        return layout

    def _create_header_panel(self) -> Panel:
        """Create header panel."""
        header = Text()
        header.append("Hester DevOps Dashboard", style="bold cyan")
        header.append("  ", style="dim")
        header.append(str(self.manager.working_dir), style="dim")

        if self.state.command_running:
            header.append("  ")
            header.append("[Running in background]", style="yellow bold")
        elif self.state.status_message:
            header.append("  ")
            header.append(self.state.status_message, style="yellow")

        return Panel(
            header,
            border_style="blue",
            subtitle="[dim]q: quit[/dim]",
            subtitle_align="right",
        )

    def _create_actions_panel(self) -> Panel:
        """Create quick actions panel from configured shortcuts."""
        content = Text()

        # Show Flutter controls if running
        if self.state.flutter_running:
            content.append("  [", style="dim")
            content.append("r", style=Style(color="green", bold=True))
            content.append("] hot reload", style=STYLES["hint"])
            content.append("               [", style="dim")
            content.append("R", style=Style(color="yellow", bold=True))
            content.append("] hot restart\n", style=STYLES["hint"])

            content.append("  [", style="dim")
            content.append("q", style=Style(color="red", bold=True))
            content.append("] quit flutter", style=STYLES["hint"])
            content.append("             [", style="dim")
            content.append("p", style=STYLES["key"])
            content.append("] inspector  [", style=STYLES["hint"])
            content.append("o", style=STYLES["key"])
            content.append("] platform", style=STYLES["hint"])
        else:
            # Show configured quick actions (2 per row)
            # Format: "Service: action" e.g. "Docker: up", "Frame: web"
            actions = list(self._quick_actions.items())
            for i in range(0, len(actions), 2):
                # First action in row
                key1, (svc1, action1) = actions[i]
                label1 = f"{svc1.name}: {action1.name}"

                content.append("  [", style="dim")
                content.append(f"Ctrl+{key1.upper()}", style=STYLES["key"])
                content.append(f"] {label1}", style=STYLES["hint"])

                # Second action in row (if exists)
                if i + 1 < len(actions):
                    key2, (svc2, action2) = actions[i + 1]
                    label2 = f"{svc2.name}: {action2.name}"

                    # Pad to align second column
                    padding = max(1, 28 - len(label1))
                    content.append(" " * padding + "[", style="dim")
                    content.append(f"Ctrl+{key2.upper()}", style=STYLES["key"])
                    content.append(f"] {label2}", style=STYLES["hint"])

                content.append("\n")

        # Check if any services are running
        running_services = [name for name, running in self.state.service_running.items() if running]
        any_running = len(running_services) > 0 or self.state.flutter_running

        if any_running:
            running_text = ", ".join(running_services[:2])
            if len(running_services) > 2:
                running_text += f" +{len(running_services) - 2}"
            title = f"[bold]Quick Actions[/bold] [green]({running_text})[/green]"
        else:
            title = "[bold]Quick Actions[/bold]"

        return Panel(
            content,
            title=title,
            border_style="green" if any_running else "cyan",
        )

    def _create_services_panel(self) -> Panel:
        """Create services list panel showing services as categories with their status."""
        if not self.manager.services:
            return Panel(
                Text("No services configured.\nAdd services to .lee/config.yaml", style="yellow"),
                title="[bold]Services[/bold]",
                border_style="yellow",
            )

        table = Table(show_header=True, header_style="bold", box=None, expand=True)
        table.add_column("", width=5)  # Wider for tab indicators like [1], (2)
        table.add_column("Service", style="cyan", min_width=15)
        table.add_column("Actions", style="dim", min_width=20)
        table.add_column("Status", width=12)
        table.add_column("Active", width=10)

        for i, service in enumerate(self.manager.services):
            # Check if service has output tab (running via TUI)
            has_output = service.name in self.state.output_tabs
            is_tui_running = self.state.service_running.get(service.name, False)

            # Get service status (from external detection or TUI state)
            svc_status = self.state.service_statuses.get(service.name)
            if is_tui_running or (svc_status and svc_status.running):
                status = "RUNNING"
                status_style = STYLES["running"]
                indicator = "●"
                if is_tui_running:
                    active_action = self.state.active_action if self.state.active_service == service.name else "tui"
                else:
                    active_action = svc_status.active_action or svc_status.source if svc_status else "-"
            else:
                status = "STOPPED"
                status_style = STYLES["stopped"]
                indicator = "○"
                active_action = "-"

            # Show tab indicator if service has output
            if has_output:
                tab_index = self.state.output_tabs.index(service.name) + 1
                indicator = f"[{tab_index}]" if is_tui_running else f"({tab_index})"

            # Build actions list (comma separated)
            action_names = ", ".join(a.name for a in service.actions[:3])
            if len(service.actions) > 3:
                action_names += f" +{len(service.actions) - 3}"

            # Selection highlighting
            row_style = "reverse" if i == self.state.selected_service_index else ""

            table.add_row(
                indicator,
                service.name,
                action_names,
                Text(status, style=status_style),
                active_action,
                style=row_style,
            )

        return Panel(
            table,
            title="[bold]Services[/bold]",
            subtitle="[dim]Up/Down: navigate | Enter: run default action[/dim]",
            subtitle_align="right",
            border_style="green",
        )

    def _create_hints_panel(self) -> Panel:
        """Create CLI hints panel."""
        hints = Text()

        hints.append("  status", style=STYLES["key"])
        hints.append(" - Service status", style=STYLES["hint"])
        hints.append("          up [svc]", style=STYLES["key"])
        hints.append(" - Start services\n", style=STYLES["hint"])

        hints.append("  down", style=STYLES["key"])
        hints.append("   - Stop services", style=STYLES["hint"])
        hints.append("          rebuild", style=STYLES["key"])
        hints.append("  - Full rebuild\n", style=STYLES["hint"])

        hints.append("  logs <svc> -f", style=STYLES["key"])
        hints.append(" - Follow logs", style=STYLES["hint"])
        hints.append("    health", style=STYLES["key"])
        hints.append("   - Health checks\n", style=STYLES["hint"])

        hints.append("  ps", style=STYLES["key"])
        hints.append("     - Docker status", style=STYLES["hint"])
        hints.append("         docker", style=STYLES["key"])
        hints.append("   - Container info", style=STYLES["hint"])

        return Panel(
            hints,
            title="[bold]Hints[/bold]",
            subtitle="[dim]Commands run without 'hester devops' prefix[/dim]",
            subtitle_align="right",
            border_style="dim",
        )

    def _create_input_panel(self) -> Panel:
        """Create command input panel."""
        input_text = Text()
        input_text.append("> ", style="bold green")
        input_text.append(self.state.command_input, style="white")
        input_text.append("_", style="bold white blink" if self.state.input_focused else "dim")

        return Panel(
            input_text,
            border_style="green" if self.state.input_focused else "dim",
        )

    def _create_fullscreen_logs(self) -> Layout:
        """Create fullscreen log view."""
        layout = Layout()

        # Get service logs
        service = self._get_selected_service()
        if service:
            service_key = self.manager._get_service_key(service.name)
            running = self.manager.running_services.get(service_key)

            if running:
                logs = running.logs[-50:]
                content = Text()
                for line in logs:
                    if len(line) > 150:
                        line = line[:147] + "..."
                    content.append(f"{line}\n", style="dim")
                title = f"Logs: {service.name}"
            else:
                content = Text(f"Service '{service.name}' is not running.", style="yellow")
                title = f"Logs: {service.name} (stopped)"
        else:
            content = Text("No service selected", style="dim")
            title = "Logs"

        panel = Panel(
            content,
            title=f"[bold]{title}[/bold]",
            subtitle="[dim]Esc: back to dashboard[/dim]",
            subtitle_align="right",
            border_style="cyan",
        )

        layout.update(panel)
        return layout

    def _create_fullscreen_command(self) -> Layout:
        """Create fullscreen command output view with tabs for each service."""
        layout = Layout()

        # Check if we have tabbed output (multiple services running)
        if self.state.output_tabs:
            return self._create_tabbed_output_view()

        # Legacy single-buffer output for non-service commands
        content = Text()
        for line in self.state.command_output[-50:]:
            if isinstance(line, Text):
                content.append_text(line)
                content.append("\n")
            else:
                # Plain string - truncate if needed
                line_str = str(line)
                if len(line_str) > 150:
                    line_str = line_str[:147] + "..."
                content.append(f"{line_str}\n")

        if self.state.flutter_running:
            content.append("\n[Flutter running...]", style="green")
            subtitle = "[dim]r: reload | R: restart | q: quit | p: inspector | Esc: background[/dim]"
            border_style = "green"
            title = "[bold]Flutter[/bold]"
        elif self.state.command_running:
            content.append("\n[Running...]", style="yellow")
            subtitle = "[dim]Esc: dismiss (continues in background)[/dim]"
            border_style = "cyan"
            title = "[bold]Command Output[/bold]"
        else:
            subtitle = "[dim]Esc: dismiss | q: quit[/dim]"
            border_style = "cyan"
            title = "[bold]Command Output[/bold]"

        panel = Panel(
            content,
            title=title,
            subtitle=subtitle,
            subtitle_align="right",
            border_style=border_style,
        )

        layout.update(panel)
        return layout

    def _create_tabbed_output_view(self) -> Layout:
        """Create tabbed output view showing one service at a time."""
        layout = Layout()

        # Build tab bar
        tab_bar = Text()
        for i, service_name in enumerate(self.state.output_tabs):
            is_active = i == self.state.active_output_tab
            is_running = self.state.service_running.get(service_name, False)

            # Tab styling
            if is_active:
                tab_style = Style(color="black", bgcolor="white", bold=True)
                indicator = "●" if is_running else "○"
            else:
                tab_style = Style(color="white", dim=not is_running)
                indicator = "●" if is_running else "○"

            # Tab label with number shortcut
            tab_bar.append(f" [{i+1}] ", style=Style(color="cyan", bold=is_active))
            tab_bar.append(f"{indicator} ", style=Style(color="green" if is_running else "white", dim=not is_running))
            tab_bar.append(f"{service_name} ", style=tab_style)
            tab_bar.append("  ")

        # Get current tab's output
        if self.state.output_tabs:
            current_service = self.state.output_tabs[self.state.active_output_tab]
            output_lines = self.state.service_outputs.get(current_service, [])
            is_running = self.state.service_running.get(current_service, False)
            is_flutter = self._is_flutter_service(current_service)
        else:
            current_service = "Output"
            output_lines = []
            is_running = False
            is_flutter = False

        # Build content - show lines that fit in terminal height minus chrome
        # Tab bar (3 lines) + panel borders (2) + subtitle (1) + status (2) = ~8 lines of chrome
        available_lines = max(20, self.console.height - 10) if self.console.height else 40

        content = Text()
        for line in output_lines[-available_lines:]:
            if isinstance(line, Text):
                content.append_text(line)
                content.append("\n")
            else:
                line_str = str(line)
                if len(line_str) > 150:
                    line_str = line_str[:147] + "..."
                content.append(f"{line_str}\n")

        # Status line
        if is_flutter and is_running:
            content.append("\n[Flutter running...]", style="green")
            controls = "r: reload | R: restart | q: quit Flutter | "
        elif is_running:
            content.append("\n[Running...]", style="yellow")
            controls = ""
        else:
            controls = ""

        # Build subtitle with tab navigation hints
        subtitle_parts = []
        if controls:
            subtitle_parts.append(controls)
        subtitle_parts.append("1-9: switch tab | Esc: background | q: quit")
        subtitle = f"[dim]{' | '.join(subtitle_parts) if not controls else controls + '| '.join(subtitle_parts[1:])}[/dim]"

        # Combine tab bar and content
        combined = Group(
            Panel(tab_bar, border_style="dim", padding=(0, 1)),
            content,
        )

        panel = Panel(
            combined,
            title=f"[bold]{current_service}[/bold]",
            subtitle=subtitle,
            subtitle_align="right",
            border_style="green" if is_flutter and is_running else ("cyan" if is_running else "dim"),
        )

        layout.update(panel)
        return layout

    def _is_flutter_service(self, service_name: str) -> bool:
        """Check if a service is a Flutter service."""
        service = self.manager.get_service(service_name)
        return service.is_flutter() if service else False

    # =========================================================================
    # Keyboard Handling
    # =========================================================================

    def _read_key(self) -> str:
        """Read a single key or escape sequence from stdin using raw fd reads."""
        fd = sys.stdin.fileno()

        # Read first byte
        ch = os.read(fd, 1).decode('utf-8', errors='replace')

        if ch != '\x1b':
            return ch

        # Could be escape sequence - check for more bytes without blocking
        old_flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, old_flags | os.O_NONBLOCK)

        try:
            seq = ch
            try:
                # Try to read [ character
                ch2 = os.read(fd, 1).decode('utf-8', errors='replace')
                seq += ch2
                if ch2 == '[':
                    # Read the command character
                    ch3 = os.read(fd, 1).decode('utf-8', errors='replace')
                    seq += ch3
            except (BlockingIOError, OSError):
                pass
            return seq
        finally:
            fcntl.fcntl(fd, fcntl.F_SETFL, old_flags)

    async def _handle_input(self):
        """Handle keyboard input."""
        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)

        try:
            # Use cbreak mode - allows Rich to work properly
            tty.setcbreak(fd)

            while self._running:
                if select.select([sys.stdin], [], [], 0.1)[0]:
                    key = self._read_key()

                    # Handle arrow keys
                    if key == '\x1b[A':  # Up arrow
                        await self._move_selection(-1)
                        continue
                    elif key == '\x1b[B':  # Down arrow
                        await self._move_selection(1)
                        continue
                    elif key.startswith('\x1b'):
                        # Other escape sequence or plain escape
                        if key == '\x1b':
                            # Plain escape - clear input or dismiss fullscreen
                            if self.state.mode == "dashboard" and self.state.command_input:
                                self.state.command_input = ""
                                self._refresh()
                            elif self.state.mode in ("logs", "command"):
                                await self._handle_fullscreen_input(key)
                        continue

                    # Handle based on mode
                    if self.state.mode == "dashboard":
                        await self._handle_dashboard_input(key)
                    elif self.state.mode in ("logs", "command"):
                        await self._handle_fullscreen_input(key)

                await asyncio.sleep(0.05)

        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

    async def _handle_dashboard_input(self, char: str):
        """Handle input in dashboard mode (escape sequences handled in _handle_input)."""
        # Quit
        if char == 'q' and not self.state.command_input:
            self._running = False
            return

        # Handle Ctrl+<key> shortcuts from config
        # Ctrl+A = 0x01, Ctrl+B = 0x02, ..., Ctrl+Z = 0x1A
        if 0x01 <= ord(char) <= 0x1A:
            key = chr(ord('a') + ord(char) - 1)  # Convert to letter
            if key in self._quick_actions:
                service, action = self._quick_actions[key]
                await self._run_quick_action(service, action)
                return

        # Enter - execute command or run default action on selected service
        if char == '\n' or char == '\r':
            if self.state.command_input.strip():
                await self._execute_command(self.state.command_input.strip())
            else:
                # Run default action on selected service
                service = self._get_selected_service()
                if service:
                    default_action = service.get_default_action()
                    if default_action:
                        await self._run_quick_action(service, default_action)
                    else:
                        self.state.status_message = f"No actions for {service.name}"
                        self._refresh()
            return

        # Backspace
        if char == '\x7f' or char == '\x08':
            if self.state.command_input:
                self.state.command_input = self.state.command_input[:-1]
                self._refresh()
            return

        # Regular character input
        if char.isprintable():
            self.state.command_input += char
            self._refresh()

    async def _handle_fullscreen_input(self, char: str):
        """Handle input in fullscreen mode."""
        # Tab switching with number keys (1-9)
        if char.isdigit() and char != '0':
            tab_index = int(char) - 1
            if 0 <= tab_index < len(self.state.output_tabs):
                self.state.active_output_tab = tab_index
                self._refresh()
            return

        # Get current tab's service for Flutter detection
        current_service = None
        is_current_flutter = False
        if self.state.output_tabs:
            current_service = self.state.output_tabs[self.state.active_output_tab]
            is_current_flutter = self._is_flutter_service(current_service)
            is_current_running = self.state.service_running.get(current_service, False)
        else:
            is_current_running = self.state.command_running

        # Flutter-specific hot reload commands (for current tab or legacy mode)
        if (is_current_flutter and is_current_running) or self.state.flutter_running:
            if char == 'r':
                # Hot reload
                if self._send_flutter_key_to_service('r', current_service):
                    self._append_to_service_output(current_service, Text("→ Hot reload triggered", style="cyan"))
                    self._refresh()
                return
            elif char == 'R':
                # Hot restart
                if self._send_flutter_key_to_service('R', current_service):
                    self._append_to_service_output(current_service, Text("→ Hot restart triggered", style="yellow"))
                    self._refresh()
                return
            elif char == 'q':
                # Quit Flutter gracefully
                if self._send_flutter_key_to_service('q', current_service):
                    self._append_to_service_output(current_service, Text("→ Quitting Flutter...", style="red"))
                    self._refresh()
                return
            elif char == 'p':
                # Toggle widget inspector
                if self._send_flutter_key_to_service('p', current_service):
                    self._append_to_service_output(current_service, Text("→ Toggling widget inspector", style="cyan"))
                    self._refresh()
                return
            elif char == 'o':
                # Toggle platform (iOS/Android)
                if self._send_flutter_key_to_service('o', current_service):
                    self._append_to_service_output(current_service, Text("→ Toggling platform", style="cyan"))
                    self._refresh()
                return

        # Escape to exit fullscreen (command continues in background)
        if char == '\x1b':
            self.state.mode = "dashboard"
            # Don't clear outputs - processes continue in background
            self._refresh()
        # q to quit only if not running any commands
        elif char == 'q' and not self._any_service_running():
            self.state.mode = "dashboard"
            self.state.command_output = []
            self._refresh()

    def _any_service_running(self) -> bool:
        """Check if any service is currently running."""
        if self.state.command_running:
            return True
        return any(self.state.service_running.values())

    def _send_flutter_key_to_service(self, key: str, service_name: Optional[str]) -> bool:
        """Send a key to a Flutter service's PTY. Returns True if sent successfully."""
        # Try service-specific master fd first
        if service_name and service_name in self.state.service_master_fds:
            master_fd = self.state.service_master_fds[service_name]
            try:
                os.write(master_fd, key.encode())
                return True
            except OSError:
                return False
        # Fall back to legacy flutter_master_fd
        return self._send_flutter_key(key)

    def _append_to_service_output(self, service_name: Optional[str], line: Any):
        """Append a line to a service's output buffer."""
        if service_name and service_name in self.state.service_outputs:
            self.state.service_outputs[service_name].append(line)
        else:
            # Legacy fallback
            self.state.command_output.append(line)

    async def _move_selection(self, delta: int):
        """Move service selection."""
        if not self.manager.services:
            return
        self.state.selected_service_index = (
            self.state.selected_service_index + delta
        ) % len(self.manager.services)
        self._refresh()

    # =========================================================================
    # Command Execution
    # =========================================================================

    async def _run_quick_action(self, service: ServiceConfig, action: ServiceAction):
        """Run an action for a service."""
        cwd = self._get_service_cwd(service)

        # Track which service/action we're running
        self.state.active_service = service.name
        self.state.active_action = action.name

        # Initialize service output buffer if needed
        if service.name not in self.state.service_outputs:
            self.state.service_outputs[service.name] = []

        # Add to output tabs if not already there
        if service.name not in self.state.output_tabs:
            self.state.output_tabs.append(service.name)

        # Switch to this service's tab
        self.state.active_output_tab = self.state.output_tabs.index(service.name)

        if service.is_flutter():
            # Flutter services get special handling for hot reload
            if self.state.service_running.get(service.name, False):
                # Show existing Flutter output
                self.state.mode = "command"
                self._refresh()
            else:
                await self._run_service_command(service.name, action.command, cwd, is_flutter=True)
        else:
            # Regular command
            await self._run_service_command(service.name, action.command, cwd, is_flutter=False)

    async def _run_service_command(self, service_name: str, cmd: str, cwd: str, is_flutter: bool = False):
        """Run a command for a specific service with output routed to its buffer."""
        self.state.mode = "command"

        # Initialize/clear service output
        self.state.service_outputs[service_name] = [
            Text(f"$ {cmd}", style="bold green"),
            "",
        ]

        if is_flutter:
            self.state.service_outputs[service_name].append(
                Text("[r] hot reload  [R] hot restart  [q] quit Flutter", style="cyan")
            )
            self.state.service_outputs[service_name].append("")

        self.state.service_running[service_name] = True
        self._refresh()

        # Start the command with PTY
        asyncio.create_task(self._execute_service_pty(service_name, cmd, cwd, is_flutter))

    async def _execute_service_pty(self, service_name: str, cmd: str, cwd: str, is_flutter: bool = False):
        """Execute command with PTY, routing output to service-specific buffer."""
        decoder = AnsiDecoder()

        def read_pty_output(master_fd: int):
            """Read from PTY master fd."""
            output_lines = []
            try:
                while True:
                    r, _, _ = select.select([master_fd], [], [], 0.1)
                    if master_fd in r:
                        try:
                            data = os.read(master_fd, 4096)
                            if not data:
                                break
                            text = data.decode("utf-8", errors="replace")
                            output_lines.append(text)
                        except OSError:
                            break
                    else:
                        if output_lines:
                            break
            except Exception:
                pass
            return "".join(output_lines)

        def strip_braille(text: str) -> str:
            """Remove all Braille characters (U+2800 to U+28FF) from text."""
            return ''.join(c for c in text if not ('\u2800' <= c <= '\u28FF'))

        def is_docker_noise(line: str) -> bool:
            """Filter out Docker Compose interactive UI noise."""
            noise_patterns = [
                "View in Docker Desktop",
                "View Config",
                "Enable Watch",
                "Disable Watch",
                "✔ Container",  # Keep container status but filter the menu after
                "\x1b[?25l",  # Hide cursor escape
                "\x1b[?25h",  # Show cursor escape
                "\x1b[?1049h",  # Alt screen buffer
                "\x1b[?1049l",  # Main screen buffer
            ]
            # Check if line is mostly the interactive menu
            stripped = line.strip()
            if not stripped:
                return True
            # Filter lines that are just the menu options
            for pattern in noise_patterns[1:4]:  # View in Docker Desktop, View Config, Enable Watch
                if pattern in stripped and len(stripped) < 100:
                    return True
            return False

        def process_output(output: str):
            """Process PTY output, handling carriage returns for progress indicators."""
            output = strip_braille(output)
            output = output.replace('\r\n', '\n')

            lines = []
            for chunk in output.split('\n'):
                if '\r' in chunk:
                    segments = chunk.split('\r')
                    chunk = segments[-1]
                if chunk.strip():
                    lines.append(chunk)

            for line in lines:
                if not line.strip():
                    continue
                # Filter Docker Compose interactive UI noise
                if is_docker_noise(line):
                    continue
                try:
                    decoded = list(decoder.decode(line))
                    if decoded:
                        self.state.service_outputs[service_name].append(decoded[0])
                    else:
                        self.state.service_outputs[service_name].append(line)
                except Exception:
                    self.state.service_outputs[service_name].append(line)

        master_fd = None
        try:
            master_fd, slave_fd = pty.openpty()

            # Store master fd for Flutter hot reload
            if is_flutter:
                self.state.service_master_fds[service_name] = master_fd

            winsize = struct.pack("HHHH", 50, 120, 0, 0)
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            env["FORCE_COLOR"] = "1"
            env["CLICOLOR_FORCE"] = "1"
            # Disable Docker Compose interactive UI and hints
            env["DOCKER_CLI_HINTS"] = "false"
            env["COMPOSE_ANSI"] = "never"  # Disable ANSI sequences that create interactive UI
            env["COMPOSE_STATUS_STDOUT"] = "1"  # Send status to stdout not TUI
            env["BUILDKIT_PROGRESS"] = "plain"  # Plain build output instead of fancy TUI

            process = subprocess.Popen(
                cmd,
                shell=True,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=cwd,
                env=env,
                start_new_session=True,
            )
            self.state.service_pids[service_name] = process.pid

            os.close(slave_fd)

            loop = asyncio.get_event_loop()

            while process.poll() is None:
                output = await loop.run_in_executor(None, read_pty_output, master_fd)
                if output:
                    process_output(output)
                    # Keep last 500 lines
                    self.state.service_outputs[service_name] = self.state.service_outputs[service_name][-500:]
                    self._refresh()

                await asyncio.sleep(0.05)

            # Read remaining output
            output = await loop.run_in_executor(None, read_pty_output, master_fd)
            if output:
                process_output(output)

            self.state.service_outputs[service_name].append("")
            exit_style = "green" if process.returncode == 0 else "red"
            label = "Flutter" if is_flutter else "Process"
            self.state.service_outputs[service_name].append(
                Text(f"[{label} exited: {process.returncode}]", style=exit_style)
            )

        except Exception as e:
            self.state.service_outputs[service_name].append(Text(f"Error: {e}", style="red"))

        finally:
            if master_fd is not None:
                try:
                    os.close(master_fd)
                except OSError:
                    pass
            # Clean up service state
            if service_name in self.state.service_master_fds:
                del self.state.service_master_fds[service_name]
            self.state.service_running[service_name] = False
            if service_name in self.state.service_pids:
                del self.state.service_pids[service_name]
            self._refresh()

    async def _run_flutter_command(self, cmd: str, cwd: str):
        """Run Flutter command with PTY tracking for hot reload support."""
        self.state.mode = "command"
        self.state.command_output = [Text(f"$ {cmd}", style="bold green"), ""]
        self.state.command_output.append(Text("[r] hot reload  [R] hot restart  [q] quit Flutter", style="cyan"))
        self.state.command_output.append("")
        self.state.command_running = True
        self.state.flutter_running = True
        self._refresh()

        # Start Flutter with PTY tracking
        asyncio.create_task(self._execute_flutter_pty(cmd, cwd))

    async def _execute_flutter_pty(self, cmd: str, cwd: str):
        """Execute Flutter command with PTY, keeping master fd for hot reload."""
        decoder = AnsiDecoder()

        def read_pty_output(master_fd: int):
            """Read from PTY master fd."""
            output_lines = []
            try:
                while True:
                    r, _, _ = select.select([master_fd], [], [], 0.1)
                    if master_fd in r:
                        try:
                            data = os.read(master_fd, 4096)
                            if not data:
                                break
                            text = data.decode("utf-8", errors="replace")
                            output_lines.append(text)
                        except OSError:
                            break
                    else:
                        if output_lines:
                            break
            except Exception:
                pass
            return "".join(output_lines)

        def strip_braille(text: str) -> str:
            """Remove all Braille characters (U+2800 to U+28FF) from text."""
            return ''.join(c for c in text if not ('\u2800' <= c <= '\u28FF'))

        def process_output(output: str):
            """Process PTY output, handling carriage returns for progress indicators."""
            # First, strip all Braille characters (spinners)
            output = strip_braille(output)

            # Handle carriage returns - replace \r\n with \n first
            output = output.replace('\r\n', '\n')

            # For remaining \r (progress indicators), only keep content after last \r per line
            lines = []
            for chunk in output.split('\n'):
                if '\r' in chunk:
                    # Only keep the last segment after \r (the final overwrite)
                    segments = chunk.split('\r')
                    chunk = segments[-1]
                if chunk.strip():
                    lines.append(chunk)

            for line in lines:
                if not line.strip():
                    continue
                try:
                    decoded = list(decoder.decode(line))
                    if decoded:
                        self.state.command_output.append(decoded[0])
                    else:
                        self.state.command_output.append(line)
                except Exception:
                    self.state.command_output.append(line)

        master_fd = None
        try:
            # Create PTY
            master_fd, slave_fd = pty.openpty()

            # Store master fd for hot reload
            self.state.flutter_master_fd = master_fd

            # Set terminal size
            winsize = struct.pack("HHHH", 50, 120, 0, 0)
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

            # Setup environment
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            env["FORCE_COLOR"] = "1"

            process = subprocess.Popen(
                cmd,
                shell=True,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=cwd,
                env=env,
                start_new_session=True,
            )
            self.state.background_pid = process.pid

            os.close(slave_fd)

            loop = asyncio.get_event_loop()

            while process.poll() is None:
                output = await loop.run_in_executor(None, read_pty_output, master_fd)
                if output:
                    process_output(output)
                    self.state.command_output = self.state.command_output[-500:]
                    self._refresh()

                await asyncio.sleep(0.05)

            # Read remaining output
            output = await loop.run_in_executor(None, read_pty_output, master_fd)
            if output:
                process_output(output)

            self.state.command_output.append("")
            exit_style = "green" if process.returncode == 0 else "red"
            self.state.command_output.append(
                Text(f"[Flutter exited: {process.returncode}]", style=exit_style)
            )

        except Exception as e:
            self.state.command_output.append(Text(f"Error: {e}", style="red"))

        finally:
            if master_fd is not None:
                try:
                    os.close(master_fd)
                except OSError:
                    pass
            self.state.flutter_master_fd = None
            self.state.flutter_running = False
            self.state.command_running = False
            self.state.background_pid = None
            self._refresh()

    def _send_flutter_key(self, key: str) -> bool:
        """Send a key to Flutter process. Returns True if sent successfully."""
        if self.state.flutter_master_fd is not None and self.state.flutter_running:
            try:
                os.write(self.state.flutter_master_fd, key.encode())
                return True
            except OSError:
                return False
        return False

    async def _run_command_fullscreen(self, cmd: str, cwd: Optional[str] = None):
        """Run a command in background with PTY and show output in fullscreen."""
        self.state.mode = "command"
        self.state.command_output = [Text(f"$ {cmd}", style="bold green"), ""]
        self.state.command_running = True
        self._refresh()

        # Start the background task for command execution with PTY
        asyncio.create_task(self._execute_background_command_pty(cmd, cwd))

    async def _execute_background_command_pty(self, cmd: str, cwd: Optional[str] = None):
        """Execute command in background using PTY for full color support."""
        decoder = AnsiDecoder()

        def read_pty_output(master_fd: int):
            """Read from PTY master fd."""
            output_lines = []
            try:
                while True:
                    # Check if there's data to read
                    r, _, _ = select.select([master_fd], [], [], 0.1)
                    if master_fd in r:
                        try:
                            data = os.read(master_fd, 4096)
                            if not data:
                                break
                            text = data.decode("utf-8", errors="replace")
                            output_lines.append(text)
                        except OSError:
                            break
                    else:
                        # No data, check if process still running
                        if output_lines:
                            break
            except Exception:
                pass
            return "".join(output_lines)

        def strip_braille(text: str) -> str:
            """Remove all Braille characters (U+2800 to U+28FF) from text."""
            return ''.join(c for c in text if not ('\u2800' <= c <= '\u28FF'))

        def process_output(output: str):
            """Process PTY output, handling carriage returns for progress indicators."""
            # First, strip all Braille characters (spinners)
            output = strip_braille(output)

            # Handle carriage returns - replace \r\n with \n first
            output = output.replace('\r\n', '\n')

            # For remaining \r (progress indicators), only keep content after last \r per line
            lines = []
            for chunk in output.split('\n'):
                if '\r' in chunk:
                    # Only keep the last segment after \r (the final overwrite)
                    segments = chunk.split('\r')
                    chunk = segments[-1]
                if chunk.strip():
                    lines.append(chunk)

            for line in lines:
                if not line.strip():
                    continue
                try:
                    # Decode ANSI to Rich Text
                    decoded = list(decoder.decode(line))
                    if decoded:
                        self.state.command_output.append(decoded[0])
                    else:
                        self.state.command_output.append(line)
                except Exception:
                    self.state.command_output.append(line)

        try:
            # Create PTY
            master_fd, slave_fd = pty.openpty()

            # Set reasonable terminal size for proper formatting
            winsize = struct.pack("HHHH", 50, 120, 0, 0)
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

            # Spawn process with PTY
            work_dir = cwd or str(self.manager.working_dir)

            # Force color output for common tools
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            env["FORCE_COLOR"] = "1"
            env["CLICOLOR_FORCE"] = "1"
            # Docker-specific
            env["DOCKER_CLI_HINTS"] = "false"
            env["COMPOSE_ANSI"] = "always"

            process = subprocess.Popen(
                cmd,
                shell=True,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=work_dir,
                env=env,
                start_new_session=True,
            )
            self.state.background_pid = process.pid

            # Close slave in parent
            os.close(slave_fd)

            # Read output asynchronously
            loop = asyncio.get_event_loop()

            while process.poll() is None:
                # Read available output
                output = await loop.run_in_executor(None, read_pty_output, master_fd)
                if output:
                    process_output(output)
                    # Keep last 500 lines
                    self.state.command_output = self.state.command_output[-500:]
                    self._refresh()

                await asyncio.sleep(0.05)

            # Read any remaining output
            output = await loop.run_in_executor(None, read_pty_output, master_fd)
            if output:
                process_output(output)

            os.close(master_fd)

            self.state.command_output.append("")
            exit_style = "green" if process.returncode == 0 else "red"
            self.state.command_output.append(
                Text(f"[Exit code: {process.returncode}]", style=exit_style)
            )

        except Exception as e:
            self.state.command_output.append(Text(f"Error: {e}", style="red"))

        finally:
            self.state.command_running = False
            self.state.background_pid = None
            self._refresh()

    async def _execute_command(self, cmd: str):
        """Execute a devops command from input."""
        parts = cmd.strip().split()
        if not parts:
            return

        command = parts[0]
        args = parts[1:]

        # Map commands to docker-compose or other actions
        command_map = {
            "up": "docker-compose up",
            "down": "docker-compose down",
            "rebuild": "docker-compose up --build",
            "build": "docker-compose build",
            "ps": "docker-compose ps",
            "logs": "docker-compose logs",
            "status": "docker-compose ps",
            "docker": "docker ps",
        }

        if command in command_map:
            full_cmd = command_map[command]
            if args:
                full_cmd += " " + " ".join(args)
            self.state.command_input = ""
            await self._run_command_fullscreen(full_cmd)
        elif command == "health":
            self.state.command_input = ""
            await self._run_health_check()
        elif command == "flutter":
            # flutter run -d chrome etc - find Frame service for cwd
            frame_service = self.manager.get_service("Frame")
            cwd = self._get_service_cwd(frame_service) if frame_service else None
            self.state.command_input = ""
            await self._run_command_fullscreen(cmd, cwd=cwd)
        else:
            # Unknown command - try running it anyway
            self.state.command_input = ""
            await self._run_command_fullscreen(cmd)

    async def _run_health_check(self):
        """Run health checks on all services."""
        self.state.status_message = "Running health checks..."
        self._refresh()

        results = await self.manager.health_check()

        for result in results:
            # Store by service name (new format)
            self.state.health_results[result['service']] = result

        healthy = sum(1 for r in results if r["status"] == "healthy")
        self.state.status_message = f"Health: {healthy}/{len(results)} healthy"
        self._refresh()

    async def _refresh_service_statuses(self):
        """Refresh service statuses using external detection (Docker, Supabase, ports)."""
        self.state.status_message = "Checking services..."
        self._refresh()

        # Run in executor to avoid blocking (subprocess calls)
        loop = asyncio.get_event_loop()
        statuses = await loop.run_in_executor(
            None,
            self.manager.get_all_service_statuses,
            self.state.health_results,
        )

        self.state.service_statuses = statuses

        # Count running services
        running_count = sum(1 for s in statuses.values() if s.running)
        total_count = len(statuses)
        self.state.status_message = f"Services: {running_count}/{total_count} running"
        self._refresh()

    # =========================================================================
    # Main Run Loop
    # =========================================================================

    async def run(self):
        """Run the TUI."""
        self._running = True

        with Live(
            self._create_layout(),
            console=self.console,
            refresh_per_second=4,
            screen=True,
        ) as live:
            self._live = live

            # Run initial service status check and health check
            asyncio.create_task(self._refresh_service_statuses())
            asyncio.create_task(self._run_health_check())

            # Start periodic status refresh (every 10 seconds)
            asyncio.create_task(self._periodic_status_refresh())

            # Handle input
            await self._handle_input()

            self._live = None

        # Clean up
        self.console.print("\n[yellow]Stopping services...[/yellow]")
        self.manager.stop_all()
        self.console.print("[green]Done.[/green]")

    async def _periodic_status_refresh(self):
        """Periodically refresh service statuses."""
        while self._running:
            await asyncio.sleep(10)  # Refresh every 10 seconds
            if self._running and self.state.mode == "dashboard":
                await self._refresh_service_statuses()


async def run_devops_tui(working_dir: str):
    """
    Run the DevOps TUI.

    Args:
        working_dir: Working directory with .lee/config.yaml
    """
    tui = DevOpsTUI(working_dir)
    await tui.run()
