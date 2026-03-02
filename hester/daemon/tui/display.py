"""
TUI display - HesterChatTUI for rendering the chat interface.
"""

import asyncio
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .constants import STYLES
from .models import ChatMessage, PendingImage, TUIChatState
from .utils import get_clipboard_image


class HesterChatTUI:
    """
    Interactive TUI chat interface for Hester daemon.

    Provides a Claude Code-style experience with:
    - Rich text rendering
    - Tool call visualization
    - Streaming responses
    - Conversation history
    """

    def __init__(
        self,
        working_directory: Optional[str] = None,
        session_id: Optional[str] = None,
    ):
        """
        Initialize the chat TUI.

        Args:
            working_directory: Working directory for file operations
            session_id: Optional session ID (generates one if not provided)
        """
        self.console = Console()
        self.working_directory = working_directory or os.getcwd()

        # Track if this is a resumed session (session_id was explicitly provided)
        self.is_resumed_session = session_id is not None
        self.session_id = session_id or f"tui-{uuid.uuid4().hex[:8]}"

        self.state = TUIChatState(
            session_id=self.session_id,
            working_directory=self.working_directory,
        )

        # Daemon client (lazy initialized)
        self._client = None
        self._agent = None

        # Pending task execution (set by /execute command)
        self._pending_task_execution: Optional[str] = None

        # Pending tasks menu (set by /tasks command)
        self._pending_tasks_menu: bool = False

        # Pending task action menu (set by /task <id> command)
        self._pending_task_action: Optional[str] = None

        # Running background tasks {task_id: asyncio.Task}
        self._running_tasks: Dict[str, asyncio.Task] = {}

    def _create_header(self) -> Panel:
        """Create the header panel."""
        header = Text()
        header.append("Hester ", style="bold green")
        header.append("— ", style="dim")
        header.append("AI Sidekick and Daemon\n", style="dim italic")
        header.append(f"📁 {self.working_directory}", style="dim")

        return Panel(
            header,
            border_style="green",
            padding=(0, 1),
        )

    def _create_status_line(self) -> Text:
        """Create the status line.

        Format: Hester is thinking/acting/observing/responding/done ([depth-model]) [LOCAL/CLOUD] @agent/#prompt | tokens | tools

        Examples:
          Hester is responding (standard-3-flash) [CLOUD] @db_explorer | 1234 tok | read_file, db_query
          Hester is thinking (deep-3-flash) [CLOUD] #code_analysis | 567 tok | search_content
          Hester is acting (quick-gemma3n) [LOCAL E4B] | read_file: main.py
        """
        status = Text()

        # Start with "Hester is "
        status.append("Hester is ", style="dim")

        # Phase indicator (ReAct step) - verb form
        if self.state.status == "preparing":
            status.append("preparing", style="blue dim")
        elif self.state.status == "thinking":
            status.append("thinking", style=STYLES["thinking"])
        elif self.state.status == "acting":
            status.append("acting", style=STYLES["tool"])
        elif self.state.status == "observing":
            status.append("observing", style="blue")
        elif self.state.status == "responding":
            status.append("responding", style=STYLES["hester"])
        elif self.state.status == "error":
            status.append("error", style=STYLES["error"])
        elif self.state.status == "ready" and self.state.tools_used:
            status.append("done", style="green")
        else:
            status.append("ready", style="green dim")

        # Depth and model combined: ([depth-model])
        if self.state.thinking_depth or self.state.model_used:
            status.append(" (", style="dim")
            if self.state.thinking_depth:
                depth_style = self._get_depth_style(self.state.thinking_depth)
                status.append(self.state.thinking_depth.lower(), style=depth_style)
            if self.state.model_used:
                model_short = self._shorten_model_name(self.state.model_used)
                if self.state.thinking_depth:
                    status.append("-", style="dim")
                status.append(model_short, style="dim")
            status.append(")", style="dim")

        # Local/Cloud indicator for hybrid routing (only show when we have phase info)
        if self.state.status in ("preparing", "thinking", "observing", "responding") and self.state.has_phase_info:
            if self.state.is_local:
                status.append(" [", style="dim")
                status.append("LOCAL", style="cyan bold")
                if self.state.precision:
                    status.append(f" {self.state.precision.upper()}", style="cyan dim")
                status.append("]", style="dim")
            else:
                status.append(" [", style="dim")
                status.append("CLOUD", style="yellow")
                status.append("]", style="dim")

        # Semantic routing indicator: @agent_id or #prompt_id
        if self.state.agent_id:
            # Pre-bundled agent matched (e.g., @db_explorer)
            status.append(" @", style="dim")
            status.append(self.state.agent_id, style="magenta")
        elif self.state.prompt_id and self.state.prompt_id != "general":
            # Bespoke agent with specific prompt (e.g., #code_analysis)
            status.append(" #", style="dim")
            status.append(self.state.prompt_id, style="blue")

        # Budget indicator (when budget info is available)
        if self.state.cloud_calls_remaining is not None or self.state.local_calls_remaining is not None:
            budget_parts = []
            if self.state.cloud_calls_remaining is not None:
                budget_parts.append(f"☁ {self.state.cloud_calls_remaining}")
            if self.state.local_calls_remaining is not None:
                budget_parts.append(f"💻 {self.state.local_calls_remaining}")
            if budget_parts:
                status.append(" ", style="dim")
                status.append(" / ".join(budget_parts), style="dim")

        # Token count
        if self.state.total_tokens > 0:
            status.append(" | ", style="dim")
            status.append(f"{self.state.total_tokens} tok", style="dim")

        # Current tool with context (when acting/observing) or tools list (when done)
        if self.state.status in ("acting", "observing") and self.state.current_tool:
            status.append(" | ", style="dim")
            status.append(self.state.current_tool, style=STYLES["tool"])
            if self.state.tool_context:
                status.append(f": {self.state.tool_context}", style="dim")
        elif self.state.tools_used:
            status.append(" | ", style="dim")
            status.append(", ".join(self.state.tools_used[-3:]), style="dim")

        return status

    def _get_depth_style(self, depth: str) -> str:
        """Get style for thinking depth indicator."""
        depth_styles = {
            "QUICK": "cyan dim",
            "STANDARD": "blue",
            "DEEP": "magenta",
            "REASONING": "magenta bold",
        }
        return depth_styles.get(depth, "dim")

    def _shorten_model_name(self, model: str) -> str:
        """Shorten model name for display."""
        # gemini-2.5-flash-lite -> 2.5-lite
        # gemini-3-flash-preview -> 3-flash
        # gemini-3.1-pro-preview -> 3.1-pro
        if model.startswith("gemini-"):
            short = model.replace("gemini-", "")
            short = short.replace("-preview", "")
            short = short.replace("flash-lite", "lite")
            return short
        # Local models: gemma3n-e4b -> gemma3n, functiongemma -> fgemma
        if model == "functiongemma":
            return "fgemma"
        if model.startswith("gemma3n-"):
            return "gemma3n"
        if model.startswith("gemma3"):
            return "gemma3"
        return model

    def _create_messages_panel(self, max_messages: int = 20) -> Panel:
        """Create the messages display panel."""
        content = Text()

        if not self.state.messages:
            content.append("No messages yet. Type a message to start chatting.\n", style="dim")
            content.append("\nExamples:\n", style="dim")
            content.append("  • ", style="dim")
            content.append("What files are in this directory?\n", style="cyan dim")
            content.append("  • ", style="dim")
            content.append("Read the main.py file\n", style="cyan dim")
            content.append("  • ", style="dim")
            content.append("Search for TODO comments\n", style="cyan dim")
        else:
            # Show last N messages
            for msg in self.state.messages[-max_messages:]:
                timestamp = msg.timestamp.strftime("%H:%M")

                if msg.role == "user":
                    content.append(f"\n[{timestamp}] ", style="dim")
                    content.append("You: ", style=STYLES["user"])
                    content.append(f"{msg.content}\n")

                elif msg.role == "hester":
                    content.append(f"\n[{timestamp}] ", style="dim")
                    content.append("Hester: ", style=STYLES["hester"])
                    # Truncate long messages for display
                    display_content = msg.content
                    if len(display_content) > 500:
                        display_content = display_content[:500] + "..."
                    content.append(f"{display_content}\n")

                elif msg.role == "tool":
                    content.append(f"  └─ ", style="dim")
                    content.append(f"🔧 {msg.tool_name}", style=STYLES["tool"])
                    if msg.tool_result:
                        if msg.tool_result.get("success", True):
                            content.append(" ✓\n", style="green dim")
                        else:
                            content.append(f" ✗ {msg.tool_result.get('error', '')}\n", style="red dim")
                    else:
                        content.append("\n")

                elif msg.role == "error":
                    content.append(f"\n[{timestamp}] ", style="dim")
                    content.append("Error: ", style=STYLES["error"])
                    content.append(f"{msg.content}\n")

        return Panel(
            content,
            title="[bold]Conversation[/bold]",
            border_style="blue",
            padding=(1, 2),
        )

    def _create_input_hint(self) -> Text:
        """Create the input hint line."""
        hint = Text()
        hint.append("  ", style="dim")
        hint.append("↑↓", style="bold")
        hint.append(" history  ", style="dim")
        hint.append("/", style="bold")
        hint.append(" commands  ", style="dim")
        hint.append("Ctrl+C", style="bold")
        hint.append(" interrupt", style="dim")
        return hint

    def _render_full_layout(self) -> Group:
        """Render the full TUI layout."""
        return Group(
            self._create_header(),
            Text(),  # Spacer
            self._create_messages_panel(),
            Text(),  # Spacer
            self._create_status_line(),
            self._create_input_hint(),
        )

    def print_welcome(self):
        """Print the welcome message with clean spacing."""
        self.console.clear()

        # 1 empty line above header
        self.console.print()

        # Print header
        self.console.print(self._create_header())

        # 1 empty line between header and input
        self.console.print()

    def print_messages(self):
        """Print the conversation messages."""
        self.console.print(self._create_messages_panel())

    def print_status(self):
        """Print the current status."""
        self.console.print(self._create_status_line())

    def add_user_message(self, content: str):
        """Add a user message to the conversation."""
        self.state.messages.append(ChatMessage(
            role="user",
            content=content,
        ))

    def add_hester_message(self, content: str, is_streaming: bool = False):
        """Add a Hester response to the conversation."""
        self.state.messages.append(ChatMessage(
            role="hester",
            content=content,
            is_streaming=is_streaming,
        ))

    def add_tool_call(self, tool_name: str, result: Optional[Dict[str, Any]] = None):
        """Add a tool call to the conversation."""
        self.state.messages.append(ChatMessage(
            role="tool",
            content="",
            tool_name=tool_name,
            tool_result=result,
        ))
        if tool_name not in self.state.tools_used:
            self.state.tools_used.append(tool_name)

    def add_error(self, message: str):
        """Add an error message to the conversation."""
        self.state.messages.append(ChatMessage(
            role="error",
            content=message,
        ))
        self.state.status = "error"
        self.state.error_message = message

    def restore_conversation_history(self, messages: List[Dict[str, Any]]) -> int:
        """
        Restore conversation history from a session.

        Args:
            messages: List of message dicts with 'role', 'content', and optional 'timestamp'

        Returns:
            Number of messages restored
        """
        restored = 0
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            # Skip system messages (they're added internally)
            if role == "system":
                continue

            # Map roles to TUI message types
            if role == "user":
                self.state.messages.append(ChatMessage(
                    role="user",
                    content=content,
                    timestamp=datetime.fromisoformat(msg["timestamp"]) if "timestamp" in msg else datetime.now(),
                ))
                restored += 1
            elif role == "assistant":
                self.state.messages.append(ChatMessage(
                    role="hester",
                    content=content,
                    timestamp=datetime.fromisoformat(msg["timestamp"]) if "timestamp" in msg else datetime.now(),
                ))
                restored += 1

        return restored

    def set_thinking(self, thinking: bool = True):
        """Set the thinking state."""
        self.state.is_thinking = thinking
        self.state.status = "thinking" if thinking else "ready"
        self.state.current_tool = None
        self.state.tool_context = None
        # Reset all per-request state when starting a new request
        if thinking:
            self.state.has_phase_info = False
            # Reset semantic routing fields for new query
            self.state.prompt_id = None
            self.state.agent_id = None
            self.state.routing_reason = None
            # Reset tools_used for new request (don't carry over from previous requests)
            self.state.tools_used = []
            # Reset model/depth info (will be populated by phase updates)
            self.state.thinking_depth = None
            self.state.model_used = None
            # Reset token counts for new request
            self.state.total_tokens = 0
            self.state.prompt_tokens = 0
            self.state.completion_tokens = 0
            # Reset hybrid routing state
            self.state.is_local = False
            self.state.precision = None
            self.state.cloud_calls_remaining = None
            self.state.local_calls_remaining = None

    def set_tool_call(self, tool_name: str):
        """Set the current tool being called."""
        self.state.status = "tool_call"
        self.state.current_tool = tool_name

    def set_responding(self):
        """Set the responding state."""
        self.state.status = "responding"
        self.state.current_tool = None

    def set_ready(self):
        """Set the ready state."""
        self.state.status = "ready"
        self.state.is_thinking = False
        self.state.current_tool = None
        self.state.error_message = None

    def handle_command(self, command: str) -> bool:
        """
        Handle a slash command.

        Returns True if the command was handled, False otherwise.
        """
        cmd = command.lower().strip()

        if cmd in ["/help", "/h", "/?", "/help"]:
            self._print_help()
            return True

        elif cmd in ["/clear", "/c"]:
            self.state.messages.clear()
            self.state.tools_used.clear()
            self.console.clear()
            self.print_welcome()
            return True

        elif cmd in ["/quit", "/q", "/exit"]:
            self.console.print("\n[dim]Goodbye![/dim]")
            return True  # Signal to exit

        elif cmd.startswith("/cd "):
            new_dir = command[4:].strip()
            self._change_directory(new_dir)
            return True

        elif cmd == "/pwd":
            self.console.print(f"[dim]Working directory: {self.working_directory}[/dim]")
            return True

        elif cmd == "/session":
            self.console.print(f"[dim]Session ID: {self.session_id}[/dim]")
            return True

        elif cmd == "/tasks":
            self._pending_tasks_menu = True
            return True

        elif cmd == "/task" or cmd.startswith("/task "):
            task_id = command[5:].strip() if len(command) > 5 else ""
            if not task_id:
                # No ID provided - get most recently updated task
                from ..tasks import TaskStore
                store = TaskStore(working_dir=Path(self.working_directory))
                tasks = store.list_all()
                if tasks:
                    # Tasks are already sorted by updated_at desc
                    task_id = tasks[0].id
                else:
                    self.console.print("[dim]No tasks found.[/dim]")
                    return True
            self._pending_task_action = task_id
            return True

        elif cmd.startswith("/execute "):
            task_id = command[9:].strip()
            return self._execute_task_command(task_id)

        elif cmd == "/paste":
            self._paste_image()
            return True

        elif cmd in ["/clear-images", "/clearimages"]:
            self._clear_pending_images()
            return True

        elif cmd == "/prompts":
            self._show_prompts()
            return True

        elif cmd == "/agents":
            self._show_agents()
            return True

        return False

    def _show_prompts(self) -> None:
        """Show available prompt overrides."""
        from .constants import get_prompt_overrides

        prompts = get_prompt_overrides()
        if not prompts:
            self.console.print("[yellow]No prompts loaded from registry[/yellow]")
            return

        self.console.print("\n[bold]Available Prompt Overrides[/bold]\n")
        self.console.print("[dim]Use #prompt_name to override auto-routing[/dim]\n")

        for prompt_id, description in sorted(prompts):
            self.console.print(f"  [cyan]#{prompt_id}[/cyan] - {description}")
        self.console.print()

    def _show_agents(self) -> None:
        """Show available agent overrides."""
        from .constants import get_agent_overrides

        agents = get_agent_overrides()
        if not agents:
            self.console.print("[yellow]No agents loaded from registry[/yellow]")
            return

        self.console.print("\n[bold]Available Agent Overrides[/bold]\n")
        self.console.print("[dim]Use @agent_name to override auto-routing[/dim]\n")

        for agent_id, description in sorted(agents):
            self.console.print(f"  [cyan]@{agent_id}[/cyan] - {description}")
        self.console.print()

    def _paste_image(self) -> None:
        """Paste image from clipboard."""
        img_data = get_clipboard_image()
        if img_data:
            data, mime_type, width, height = img_data
            self.state.pending_images.append(
                PendingImage(
                    data=data,
                    mime_type=mime_type,
                    source="clipboard",
                    width=width,
                    height=height,
                )
            )
            size_kb = len(data) / 1024
            self.console.print(
                f"[green]✓ Image added:[/green] {width}x{height} "
                f"({size_kb:.1f}KB, {mime_type})"
            )
            self.console.print(
                f"[dim]  {len(self.state.pending_images)} image(s) pending. "
                f"Type your message and press Enter to send.[/dim]"
            )
        else:
            self.console.print("[yellow]No image found in clipboard.[/yellow]")
            self.console.print(
                "[dim]  Copy an image to clipboard first (e.g., screenshot), "
                "then use /paste or Ctrl+V.[/dim]"
            )

    def _clear_pending_images(self) -> None:
        """Clear all pending images."""
        count = len(self.state.pending_images)
        self.state.pending_images.clear()
        if count > 0:
            self.console.print(f"[dim]Cleared {count} pending image(s).[/dim]")
        else:
            self.console.print("[dim]No pending images to clear.[/dim]")

    def _show_tasks(self) -> bool:
        """Show list of all tasks."""
        try:
            from ..tasks import TaskStore, TaskStatus

            store = TaskStore(working_dir=Path(self.working_directory))
            tasks = store.list_all()

            if not tasks:
                self.console.print("[dim]No tasks found.[/dim]")
                return True

            table = Table(title="Tasks", border_style="blue")
            table.add_column("ID", style="cyan")
            table.add_column("Title")
            table.add_column("Status")
            table.add_column("Batches", justify="right")
            table.add_column("Updated", style="dim")

            status_styles = {
                TaskStatus.PLANNING: "yellow",
                TaskStatus.READY: "green",
                TaskStatus.EXECUTING: "blue",
                TaskStatus.COMPLETED: "green dim",
                TaskStatus.FAILED: "red",
            }

            for task in tasks:
                status_style = status_styles.get(task.status, "dim")
                table.add_row(
                    task.id,
                    task.title[:40] + "..." if len(task.title) > 40 else task.title,
                    f"[{status_style}]{task.status.value}[/{status_style}]",
                    str(len(task.batches)),
                    task.updated_at.strftime("%Y-%m-%d %H:%M"),
                )

            self.console.print(table)
            return True

        except Exception as e:
            self.console.print(f"[red]Error listing tasks: {e}[/red]")
            return True

    def _show_task(self, task_id: str) -> bool:
        """Show details of a specific task."""
        try:
            from ..tasks import TaskStore, TaskStatus

            store = TaskStore(working_dir=Path(self.working_directory))
            task = store.get(task_id)

            if not task:
                self.console.print(f"[red]Task not found: {task_id}[/red]")
                return True

            # Determine status style and indicator
            status_style = "cyan"
            status_indicator = ""
            if task.status == TaskStatus.EXECUTING:
                status_style = "yellow"
                status_indicator = " ⟳"
            elif task.status == TaskStatus.COMPLETED:
                status_style = "green"
                status_indicator = " ✓"
            elif task.status == TaskStatus.FAILED:
                status_style = "red"
                status_indicator = " ✗"

            # Build task display
            content = Text()
            content.append(f"# {task.title}\n", style="bold")
            content.append(f"\nStatus: ", style="dim")
            content.append(f"{task.status.value}{status_indicator}\n", style=status_style)
            content.append(f"\n## Goal\n{task.goal}\n", style="")

            if task.context.files:
                content.append(f"\n## Context Files\n", style="bold")
                # Ensure files is iterable as list (not string)
                files_list = task.context.files if isinstance(task.context.files, list) else [task.context.files]
                for f in files_list:
                    content.append(f"  - {f}\n", style="dim")

            if task.batches:
                content.append(f"\n## Batches ({len(task.batches)})\n", style="bold")
                for i, batch in enumerate(task.batches, 1):
                    if batch.status.value == "completed":
                        status_icon = "✓"
                        batch_style = "green"
                    elif batch.status.value == "running":
                        status_icon = "▶"
                        batch_style = "yellow"
                    elif batch.status.value == "failed":
                        status_icon = "✗"
                        batch_style = "red"
                    else:
                        status_icon = "○"
                        batch_style = ""
                    content.append(f"  {status_icon} {i}. {batch.title} ", style=batch_style)
                    content.append(f"[{batch.delegate.value}]\n", style="dim")

            if task.success_criteria:
                content.append(f"\n## Success Criteria\n", style="bold")
                for c in task.success_criteria:
                    content.append(f"  - {c}\n", style="dim")

            # Show log tail for running or recently completed/failed tasks
            if task.log and task.status in [TaskStatus.EXECUTING, TaskStatus.COMPLETED, TaskStatus.FAILED]:
                content.append(f"\n## Recent Log\n", style="bold")
                # Show last 5 log entries
                recent_logs = task.log[-5:]
                for entry in recent_logs:
                    timestamp = entry.timestamp.strftime("%H:%M:%S")
                    # Truncate long log entries
                    event_text = entry.event[:100] + "..." if len(entry.event) > 100 else entry.event
                    content.append(f"  [{timestamp}] {event_text}\n", style="dim")

            content.append(f"\nFile: {store._task_path(task_id)}\n", style="dim")

            self.console.print(Panel(content, title=f"Task: {task_id}", border_style="blue"))
            return True

        except Exception as e:
            self.console.print(f"[red]Error showing task: {e}[/red]")
            return True

    def _execute_task_command(self, task_id: str) -> bool:
        """Start executing a task - sets flag for async execution in run loop."""
        self._pending_task_execution = task_id
        return True

    def _print_help(self):
        """Print help information."""
        help_text = """
[bold]Keyboard Shortcuts[/bold]

[cyan]↑/↓[/cyan]            Navigate input history
[cyan]↓[/cyan] [dim](empty)[/dim]     Show command menu
[cyan]←/→[/cyan]            Move cursor in input
[cyan]/[/cyan]              Show command menu (type to filter)
[cyan]↑/↓[/cyan] [dim](menu)[/dim]   Navigate menu, Enter to select
[cyan]Ctrl+V[/cyan]         Paste image from clipboard
[cyan]Ctrl+C[/cyan]         Interrupt current task
[cyan]Ctrl+C ×2[/cyan]      Exit chat

[bold]Commands[/bold]

[cyan]/help, /h[/cyan]      Show this help
[cyan]/clear, /c[/cyan]     Clear conversation
[cyan]/quit, /q[/cyan]      Exit chat
[cyan]/cd <dir>[/cyan]      Change working directory
[cyan]/pwd[/cyan]           Show working directory
[cyan]/session[/cyan]       Show session ID
[cyan]/prompts[/cyan]       List available prompt overrides
[cyan]/agents[/cyan]        List available agent overrides

[bold]Model Selection[/bold]

Prefix your message to control model:

[dim]Local (Ollama):[/dim]
[cyan]/local[/cyan]         Fast local (gemma3n)
[cyan]/deeplocal[/cyan]     Complex local (gemma3)

[dim]Cloud (Gemini):[/dim]
[cyan]/quick[/cyan]         Fast cloud (2.5-flash)
[cyan]/standard[/cyan]      Balanced (2.5-flash)
[cyan]/deep[/cyan]          Complex (3-flash)
[cyan]/pro[/cyan]           Reasoning (3-pro)

[dim]Examples:[/dim]
  /local what time is it?
  /deep explain this architecture
  /pro why is this test failing?

[bold]Routing Overrides[/bold]

Force a specific prompt or agent instead of auto-routing:

[cyan]#prompt_name[/cyan]   Use a specific prompt (e.g., #scene, #research)
[cyan]@agent_name[/cyan]    Use a specific agent (e.g., @scene_developer)

[dim]Examples:[/dim]
  #scene how do I add a new stage?
  @web_researcher latest React 19 features
  #database show me all vector columns

[dim]Use /prompts to list prompts, /agents to list agents[/dim]

[bold]What I Can Do[/bold]

• Read and analyze code files
• Search for files by name or pattern
• Search code content for patterns
• List directory contents
• Query the database (read-only)
• Explain code structure and logic
• Answer questions about your codebase
• Manage complex tasks with planning & delegation
• [cyan]Analyze images[/cyan] (paste with Ctrl+V or /paste)

[bold]Task Management[/bold]

[cyan]/tasks[/cyan]         List all tasks with actions
[cyan]/task [id][/cyan]     View task and show action menu (latest if no id)
[cyan]/execute <id>[/cyan]  Execute a ready task directly

[dim]Just type naturally - I'll pick the right model and tools.[/dim]
"""
        self.console.print(Panel(help_text, title="Help", border_style="blue"))

    def _change_directory(self, new_dir: str) -> Optional[str]:
        """
        Change the working directory.

        Returns:
            The new directory path if successful, None otherwise.
        """
        try:
            path = Path(new_dir).expanduser().resolve()
            if path.is_dir():
                self.working_directory = str(path)
                self.state.working_directory = str(path)
                self.console.print(f"[green]Changed to: {path}[/green]")
                return str(path)
            else:
                self.console.print(f"[red]Not a directory: {new_dir}[/red]")
                return None
        except Exception as e:
            self.console.print(f"[red]Error: {e}[/red]")
            return None
