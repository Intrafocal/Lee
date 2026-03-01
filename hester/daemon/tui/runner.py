"""
TUI runner - HesterChatRunner for running the interactive chat loop.
"""

import os
import shutil
from pathlib import Path
from typing import List, Optional

# Disable CPR (cursor position request) warnings in PTY environments like Lee
# Must be set before importing prompt_toolkit
os.environ.setdefault("PROMPT_TOOLKIT_NO_CPR", "1")

from prompt_toolkit.formatted_text import HTML
from rich.console import Console

from .display import HesterChatTUI
from .handlers import create_prompt_session, MessageProcessor, TaskHandlers
from .rendering import render_response


class HesterChatRunner:
    """
    Runs the Hester chat TUI with the daemon agent.

    Handles the main loop, input, and delegates to specialized handlers.
    """

    def __init__(
        self,
        working_directory: Optional[str] = None,
        daemon_url: Optional[str] = None,
        session_id: Optional[str] = None,
    ):
        """
        Initialize the chat runner.

        Args:
            working_directory: Working directory for file operations
            daemon_url: URL of the Hester daemon (if using HTTP mode)
            session_id: Optional session ID to resume (e.g., from Command Palette)
        """
        self.working_directory = working_directory or os.getcwd()
        self.daemon_url = daemon_url
        self._resume_session_id = session_id
        self.tui = HesterChatTUI(
            working_directory=self.working_directory,
            session_id=session_id,
        )
        self.console = Console()

        # Processing state for interrupt handling
        self._is_processing = False

        # Input history for up/down arrow navigation
        self._input_history: List[str] = []
        self._history_index = 0

        # Track if we should show command menu on next down arrow
        self._at_history_end = True

        # Setup prompt_toolkit session with history and completions
        self._prompt_session = create_prompt_session(
            runner=self,
            working_dir_getter=lambda: self.working_directory,
        )

        # Initialize handlers
        self.message_processor = MessageProcessor(self)
        self.task_handlers = TaskHandlers(self)

    def _build_prompt_text(self) -> str:
        """Build prompt text with optional background task and image indicators."""
        parts = []

        # Check for running background tasks
        running_tasks = self.tui._running_tasks
        if running_tasks:
            # Clean up completed tasks
            completed = [tid for tid, task in running_tasks.items() if task.done()]
            for tid in completed:
                del running_tasks[tid]

        if running_tasks:
            count = len(running_tasks)
            task_ids = list(running_tasks.keys())[:2]  # Show max 2 task IDs
            ids_str = ", ".join(task_ids)
            if count > 2:
                ids_str += f" +{count - 2}"
            parts.append(f'<style fg="ansiblue">{ids_str}</style>')

        # Check for pending images
        pending_images = self.tui.state.pending_images
        if pending_images:
            count = len(pending_images)
            total_size = sum(len(img.data) for img in pending_images) / 1024
            if count == 1:
                img = pending_images[0]
                parts.append(f'<style fg="ansicyan">{img.width}x{img.height}</style>')
            else:
                parts.append(f'<style fg="ansicyan">{count} images ({total_size:.0f}KB)</style>')

        # Build final prompt
        if parts:
            return ' '.join(parts) + ' <prompt>You:</prompt> '
        else:
            return '<prompt>You:</prompt> '

    def _draw_input_separator(self):
        """Draw a subtle separator line above the input area."""
        term_width = shutil.get_terminal_size().columns

        # Draw a subtle separator line
        sep_chars = "-" * (term_width - 1)
        self.console.print(f"[dim]{sep_chars}[/dim]")

    async def run(self):
        """Run the interactive chat loop."""
        self.tui.print_welcome()

        # Load session history if resuming from a previous session
        if self.tui.is_resumed_session:
            await self.message_processor.load_session_history()

        # Track consecutive Ctrl+C presses (for exit confirmation)
        ctrl_c_count = 0

        try:
            while True:
                try:
                    # Get user input using prompt_toolkit
                    # - Up/Down arrows navigate history
                    # - Down on empty line at end of history shows command menu
                    # - Left/Right arrows move cursor for editing
                    # - Tab completes slash commands

                    # Draw separator above input
                    self._draw_input_separator()

                    # Reset history position tracking
                    self._at_history_end = True

                    try:
                        # Build prompt with background task indicator
                        prompt_text = self._build_prompt_text()
                        user_input = await self._prompt_session.prompt_async(
                            HTML(prompt_text),
                        )
                        user_input = user_input.strip()
                    except EOFError:
                        # Ctrl+D - exit
                        break

                    # Reset Ctrl+C counter on successful input
                    ctrl_c_count = 0

                    if not user_input:
                        continue

                    # Handle commands
                    if user_input.startswith("/"):
                        if user_input.lower() in ["/quit", "/q", "/exit"]:
                            break
                        if self.tui.handle_command(user_input):
                            # Check if there's a pending task execution
                            if self.tui._pending_task_execution:
                                task_id = self.tui._pending_task_execution
                                self.tui._pending_task_execution = None
                                await self.task_handlers.execute_task(task_id)
                            # Check if tasks menu was requested
                            if self.tui._pending_tasks_menu:
                                self.tui._pending_tasks_menu = False
                                await self.task_handlers.show_tasks_menu()
                            # Check if single task action menu was requested
                            if self.tui._pending_task_action:
                                task_id = self.tui._pending_task_action
                                self.tui._pending_task_action = None
                                await self.task_handlers.show_task_with_actions(task_id)
                            continue

                    # Add user message
                    self.tui.add_user_message(user_input)

                    # Process and get response
                    try:
                        response = await self.message_processor.process_message(user_input)
                        self.tui.add_hester_message(response)

                        # Print response with formatting
                        self.console.print()
                        self.console.print("[green bold]Hester:[/green bold]", end=" ")

                        # Render response (handles markdown, mermaid, images)
                        try:
                            render_response(self.console, response)
                        except Exception:
                            self.console.print(response)

                        # Check if mark_task_ready was called and prompt for action
                        ready_task_id = self.task_handlers.check_for_ready_task_from_tools()
                        if ready_task_id:
                            feedback = await self.task_handlers.prompt_task_ready(ready_task_id)
                            # Clear tools_used so we don't prompt again
                            self.tui.state.tools_used = []

                            # If user gave feedback, send it to Hester to update the task
                            if feedback:
                                feedback_msg = f"Update task {ready_task_id} based on this feedback: {feedback}"
                                self.tui.add_user_message(feedback_msg)
                                try:
                                    response = await self.message_processor.process_message(feedback_msg)
                                    self.tui.add_hester_message(response)
                                    self.console.print()
                                    self.console.print("[green bold]Hester:[/green bold]", end=" ")
                                    try:
                                        render_response(self.console, response)
                                    except Exception:
                                        self.console.print(response)
                                except Exception as e:
                                    self.console.print(f"[red]Error processing feedback: {e}[/red]")

                    except KeyboardInterrupt:
                        # Ctrl+C during processing - interrupt task, continue chat
                        self.console.print("\n[yellow]Task interrupted.[/yellow]")
                        self.tui.add_hester_message("[Task interrupted by user]")
                        ctrl_c_count = 0  # Reset so next Ctrl+C doesn't exit
                        continue

                    except Exception as e:
                        self.tui.add_error(str(e))
                        self.console.print(f"\n[red]Error: {e}[/red]")

                except KeyboardInterrupt:
                    # Ctrl+C during input prompt
                    ctrl_c_count += 1
                    if ctrl_c_count >= 2:
                        # Two consecutive Ctrl+C - exit
                        break
                    self.console.print("\n[dim]Press Ctrl+C again to quit, or continue typing.[/dim]")
                    continue

        except KeyboardInterrupt:
            pass
        finally:
            self.console.print("\n[dim]Session ended. Goodbye![/dim]")


async def run_chat_tui(
    working_directory: Optional[str] = None,
    tasks_dir: Optional[str] = None,
    daemon_url: Optional[str] = None,
    session_id: Optional[str] = None,
):
    """
    Run the Hester chat TUI.

    Args:
        working_directory: Working directory for file operations
        tasks_dir: Directory for task files (default: .hester/tasks/ in working dir)
        daemon_url: URL of the Hester daemon (optional, uses direct mode if not provided)
        session_id: Optional session ID to resume (e.g., from Command Palette)
    """
    # Initialize task store if tasks_dir is specified
    if tasks_dir:
        from ..tasks import init_task_store
        init_task_store(tasks_dir=Path(tasks_dir), working_dir=Path(working_directory or "."))

    runner = HesterChatRunner(
        working_directory=working_directory,
        daemon_url=daemon_url,
        session_id=session_id,
    )
    await runner.run()
