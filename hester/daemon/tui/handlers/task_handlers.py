"""
TUI task handlers - task execution, watching, retrying, and menu handling.
"""

import asyncio
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from prompt_toolkit.formatted_text import HTML
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel

from ..selectors import (
    FailedTaskRetrySelector,
    TaskActionSelector,
    TaskReadySelector,
    TasksMenuSelector,
)

if TYPE_CHECKING:
    from ..runner import HesterChatRunner


class TaskHandlers:
    """Handles task-related operations for the TUI runner."""

    def __init__(self, runner: "HesterChatRunner"):
        self.runner = runner
        self.console = Console()

    async def show_tasks_menu(self):
        """Show interactive tasks menu with arrow-key navigation."""
        from ...tasks import TaskStore, TaskStatus

        try:
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            tasks = store.list_all()

            # Get set of currently running background tasks
            running_ids = set(self.runner.tui._running_tasks.keys())

            # Show interactive selector
            selector = TasksMenuSelector(self.console, tasks, running_ids)
            action, task_id = await selector.select()

            if action is None or task_id is None:
                return

            # Handle the selected action
            await self._handle_task_action(action, task_id, store)

        except KeyboardInterrupt:
            pass
        except Exception as e:
            self.console.print(f"[red]Error showing tasks: {e}[/red]")
            import traceback
            self.console.print(f"[dim]{traceback.format_exc()}[/dim]")

    async def show_task_with_actions(self, task_id: str):
        """Show task details and present action menu."""
        from ...tasks import TaskStore, TaskStatus, BatchStatus

        try:
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            task = store.get(task_id)

            if not task:
                self.console.print(f"[red]Task not found: {task_id}[/red]")
                return

            # Show the task details first
            self.runner.tui._show_task(task_id)

            # Check if task is running in background
            is_running = task_id in self.runner.tui._running_tasks

            # Show action selector
            selector = TaskActionSelector(self.console, task, is_running)
            action = await selector.select()

            if action is None:
                return

            # Handle the selected action
            await self._handle_task_action(action, task_id, store, task=task)

        except KeyboardInterrupt:
            pass
        except Exception as e:
            self.console.print(f"[red]Error showing task: {e}[/red]")
            import traceback
            self.console.print(f"[dim]{traceback.format_exc()}[/dim]")

    async def _handle_task_action(self, action: str, task_id: str, store, task=None):
        """Handle a task action from a selector."""
        from ...tasks import TaskStatus, BatchStatus

        if task is None:
            task = store.get(task_id)

        if action == "view":
            self.runner.tui._show_task(task_id)

        elif action == "execute":
            await self.execute_task_background(task_id)

        elif action == "stream":
            await self.execute_task(task_id)

        elif action == "retry" or action == "rerun":
            # Reset failed batches and re-execute
            if task:
                for batch in task.batches:
                    if batch.status == BatchStatus.FAILED:
                        batch.status = BatchStatus.PENDING
                task.status = TaskStatus.READY
                task.add_log("Task reset for retry")
                store.save(task)
                await self.execute_task_background(task_id)

        elif action == "replan":
            # Trigger re-planning with failure context
            await self._handle_failed_task_retry(task_id, store)

        elif action == "watch":
            # Watch live stream of executing task
            await self.watch_task_stream(task_id)

        elif action == "logs":
            # Show task with log tail
            self.runner.tui._show_task(task_id)

        elif action == "edit":
            # Show task for editing
            self.runner.tui._show_task(task_id)
            self.console.print("[dim]Use Hester to update this task.[/dim]")

        elif action == "delete":
            # Confirm and delete
            self.console.print(f"[yellow]Delete task {task_id}?[/yellow] ", end="")
            confirm = await self.runner._prompt_session.prompt_async(
                HTML('<prompt>[y/N]:</prompt> '),
            )
            if confirm.strip().lower() == 'y':
                if store.delete(task_id):
                    self.console.print(f"[green]Task deleted: {task_id}[/green]")
                else:
                    self.console.print(f"[red]Failed to delete task[/red]")

    async def watch_task_stream(self, task_id: str):
        """Watch live output from an executing task. Press Escape or Ctrl+C to stop watching."""
        from ...tasks import TaskStore, TaskStatus

        self.console.print(f"\n[cyan]Watching task: {task_id}[/cyan]")
        self.console.print("[dim]Press Escape or Ctrl+C to stop watching...[/dim]\n")

        try:
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            last_log_count = 0

            # Set up non-blocking key detection
            import termios
            import tty
            import select

            fd = sys.stdin.fileno()
            old_settings = termios.tcgetattr(fd)

            try:
                tty.setcbreak(fd)  # Use cbreak instead of raw for better signal handling

                while True:
                    # Check for keypress (non-blocking)
                    if select.select([sys.stdin], [], [], 0.1)[0]:
                        ch = sys.stdin.read(1)
                        if ch == '\x1b':  # Escape
                            # Check for escape sequence or plain escape
                            if select.select([sys.stdin], [], [], 0.05)[0]:
                                sys.stdin.read(2)  # Consume rest of escape sequence
                            break
                        elif ch == '\x03':  # Ctrl+C
                            break
                        elif ch == 'q' or ch == 'Q':
                            break

                    # Refresh task state
                    task = store.get(task_id)
                    if not task:
                        self.console.print("[red]Task not found[/red]")
                        break

                    # Check if task is still executing
                    if task.status != TaskStatus.EXECUTING:
                        status_style = "green" if task.status == TaskStatus.COMPLETED else "red"
                        self.console.print(f"\n[{status_style}]Task {task.status.value}[/{status_style}]")
                        break

                    # Print any new log entries
                    if task.log and len(task.log) > last_log_count:
                        for entry in task.log[last_log_count:]:
                            timestamp = entry.timestamp.strftime("%H:%M:%S")
                            self.console.print(f"[dim][{timestamp}][/dim] {entry.event}")
                        last_log_count = len(task.log)

                    # Small delay to avoid busy loop
                    await asyncio.sleep(0.5)

            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

            self.console.print("\n[dim]Stopped watching.[/dim]")

        except KeyboardInterrupt:
            self.console.print("\n[dim]Stopped watching.[/dim]")
        except Exception as e:
            self.console.print(f"[red]Error watching task: {e}[/red]")

    async def execute_task(self, task_id: str):
        """Execute a task using the TaskExecutor with streaming output."""
        from ...tasks import TaskStore, TaskExecutor, TaskStatus

        self.console.print(f"\n[yellow]Executing task: {task_id}[/yellow]")

        try:
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            task = store.get(task_id)

            if not task:
                self.console.print(f"[red]Error: Task not found: {task_id}[/red]")
                return

            # Handle failed tasks - offer to retry with re-planning
            if task.status == TaskStatus.FAILED:
                await self._handle_failed_task_retry(task_id, store)
                return

            # Output callback for streaming
            def on_output(text: str):
                self.console.print(f"[dim]{text}[/dim]")

            # Status callback
            def on_status(batch_id: str, status: str):
                self.console.print(f"[cyan]Batch {batch_id}: {status}[/cyan]")

            executor = TaskExecutor(
                store=store,
                working_dir=Path(self.runner.tui.working_directory),
                on_output=on_output,
                on_status=on_status,
            )

            # Execute with streaming updates
            async for update in executor.execute_streaming(task_id):
                if update["type"] == "error":
                    self.console.print(f"[red]Error: {update['error']}[/red]")
                    break
                elif update["type"] == "started":
                    self.console.print(f"[green]Task started[/green]")
                elif update["type"] == "batch_started":
                    self.console.print(f"\n[yellow]> {update['title']}[/yellow] [{update['delegate']}]")
                elif update["type"] == "batch_completed":
                    if update["success"]:
                        self.console.print(f"[green]Batch completed[/green]")
                    else:
                        self.console.print(f"[red]Batch failed[/red]")
                    if update.get("output"):
                        # Summarize Claude Code output for cleaner display
                        output_text = update["output"]
                        if len(output_text) > 300:
                            try:
                                from ...tools import summarize_claude_output
                                batch_title = update.get("title", "batch")
                                output_text = await summarize_claude_output(
                                    output_text,
                                    task_title=batch_title,
                                    max_length=300,
                                )
                            except Exception:
                                # Fallback to truncation from END if summarize fails
                                output_text = "..." + output_text[-300:]
                        self.console.print(Panel(
                            output_text,
                            title="Output",
                            border_style="dim"
                        ))
                elif update["type"] == "finished":
                    if update["success"]:
                        self.console.print(f"\n[green bold]Task completed successfully[/green bold]")
                    else:
                        self.console.print(f"\n[red bold]Task failed[/red bold]")

        except Exception as e:
            self.console.print(f"[red]Error executing task: {e}[/red]")
            import traceback
            self.console.print(f"[dim]{traceback.format_exc()}[/dim]")

    async def execute_task_background(self, task_id: str):
        """Execute a task in the background (non-blocking).

        The task runs asynchronously while the user can continue chatting.
        Use /task <id> to check status and see log output.
        """
        from ...tasks import TaskStore, TaskExecutor, TaskStatus

        try:
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            task = store.get(task_id)

            if not task:
                self.console.print(f"[red]Error: Task not found: {task_id}[/red]")
                return

            # Handle failed tasks - offer to retry with re-planning
            if task.status == TaskStatus.FAILED:
                await self._handle_failed_task_retry(task_id, store)
                return

            # Store task in running tasks dict for tracking
            if not hasattr(self.runner.tui, '_running_tasks'):
                self.runner.tui._running_tasks = {}

            async def run_task():
                """Background coroutine that runs the task."""
                try:
                    executor = TaskExecutor(
                        store=store,
                        working_dir=Path(self.runner.tui.working_directory),
                        on_output=None,  # No streaming in background
                        on_status=None,
                    )

                    result = await executor.execute(task_id)

                    # Remove from running tasks when done
                    if hasattr(self.runner.tui, '_running_tasks') and task_id in self.runner.tui._running_tasks:
                        del self.runner.tui._running_tasks[task_id]

                    # Notify user
                    if result.get("success"):
                        self.console.print(f"\n[green]Background task completed: {task_id}[/green]")
                    else:
                        self.console.print(f"\n[red]Background task failed: {task_id}[/red]")

                except Exception as e:
                    if hasattr(self.runner.tui, '_running_tasks') and task_id in self.runner.tui._running_tasks:
                        del self.runner.tui._running_tasks[task_id]
                    self.console.print(f"\n[red]Background task error ({task_id}): {e}[/red]")

            # Create and store the background task
            background_task = asyncio.create_task(run_task())
            self.runner.tui._running_tasks[task_id] = background_task

            self.console.print(f"\n[green]Task started in background: {task_id}[/green]")
            self.console.print(f"[dim]Use /task {task_id} to check status and view logs.[/dim]")

        except Exception as e:
            self.console.print(f"[red]Error starting background task: {e}[/red]")
            import traceback
            self.console.print(f"[dim]{traceback.format_exc()}[/dim]")

    async def _handle_failed_task_retry(self, task_id: str, store):
        """Handle retrying a failed task by re-triggering planning with failure context."""
        from ...tasks import TaskStatus, BatchStatus

        task = store.get(task_id)
        if not task:
            return

        self.console.print(f"\n[yellow]Task '{task.title}' has failed.[/yellow]")

        # Gather failure context from task log and failed batches
        failure_context = self._build_failure_context(task)

        self.console.print(Panel(
            failure_context[:1000] + ("..." if len(failure_context) > 1000 else ""),
            title="Failure Context",
            border_style="red"
        ))

        # Use the arrow-key selector
        selector = FailedTaskRetrySelector(self.console, task_id, task.title)
        try:
            choice = await selector.select()
        except KeyboardInterrupt:
            return

        if choice == "replan":
            # Re-trigger planning with failure context
            await self._retry_with_replanning(task_id, task, store, failure_context)
        elif choice == "reset":
            # Reset failed batches and re-execute
            await self._reset_and_retry(task_id, task, store)
        else:
            self.console.print("[dim]Cancelled.[/dim]")

    def _build_failure_context(self, task) -> str:
        """Build a context string describing the task failure."""
        from ...tasks import BatchStatus

        lines = [
            f"# Task Failed: {task.title}",
            f"\n## Goal\n{task.goal}",
            "\n## Failed Batches"
        ]

        for batch in task.batches:
            if batch.status == BatchStatus.FAILED:
                lines.append(f"\n### {batch.title} (FAILED)")
                if batch.prompt:
                    lines.append(f"Prompt: {batch.prompt[:300]}...")
                if batch.output:
                    lines.append(f"Output:\n```\n{batch.output[:500]}\n```")
                if batch.steps:
                    lines.append("Steps:")
                    for step in batch.steps:
                        lines.append(f"  - {step}")

        # Include recent log entries
        lines.append("\n## Execution Log (recent)")
        for entry in task.log[-10:]:
            lines.append(f"- {entry.timestamp.strftime('%H:%M:%S')}: {entry.event}")

        return "\n".join(lines)

    async def _retry_with_replanning(self, task_id: str, task, store, failure_context: str):
        """Reset task to planning and send failure context to Hester for re-planning."""
        from ...tasks import TaskStatus, BatchStatus

        # Reset task status to planning
        task.status = TaskStatus.PLANNING
        task.add_log("Task reset for re-planning after failure")

        # Reset failed batches
        for batch in task.batches:
            if batch.status == BatchStatus.FAILED:
                batch.status = BatchStatus.PENDING
                batch.output = None

        store.save(task)

        self.console.print(f"\n[green]Task reset to planning status.[/green]")
        self.console.print("[yellow]Sending failure context to Hester for re-planning...[/yellow]\n")

        # Build the re-planning prompt
        replan_prompt = f"""The task "{task.title}" (ID: {task_id}) has failed and needs to be revised.

{failure_context}

Please review the failure and update the task:
1. Analyze what went wrong
2. Update the failed batch(es) with corrected prompts/steps
3. Use `update_task` or `add_batch` to fix the task
4. When ready, use `mark_task_ready` to mark it for re-execution

Focus on fixing the specific issues that caused the failure."""

        # Process through Hester
        try:
            response = await self.runner.message_processor.process_message(replan_prompt)
            self.runner.tui.add_hester_message(response)

            self.console.print()
            self.console.print("[green bold]Hester:[/green bold]", end=" ")
            try:
                self.console.print(Markdown(response))
            except Exception:
                self.console.print(response)

            # Check if task was marked ready
            ready_task_id = self.check_for_ready_task_from_tools()
            if ready_task_id:
                feedback = await self.prompt_task_ready(ready_task_id)
                self.runner.tui.state.tools_used = []
                if feedback:
                    feedback_response = await self.runner.message_processor.process_message(
                        f"Feedback on task {ready_task_id}: {feedback}"
                    )
                    self.console.print()
                    self.console.print("[green bold]Hester:[/green bold]", end=" ")
                    self.console.print(feedback_response)

        except Exception as e:
            self.console.print(f"[red]Error during re-planning: {e}[/red]")

    async def _reset_and_retry(self, task_id: str, task, store):
        """Reset failed batches and retry execution immediately."""
        from ...tasks import TaskStatus, BatchStatus, TaskExecutor

        # Reset task and failed batches
        task.status = TaskStatus.READY
        task.add_log("Task reset for retry (failed batches reset)")

        for batch in task.batches:
            if batch.status == BatchStatus.FAILED:
                batch.status = BatchStatus.PENDING
                batch.output = None

        store.save(task)

        self.console.print(f"\n[green]Failed batches reset. Retrying execution...[/green]\n")

        # Re-execute
        def on_output(text: str):
            self.console.print(f"[dim]{text}[/dim]")

        def on_status(batch_id: str, status: str):
            self.console.print(f"[cyan]Batch {batch_id}: {status}[/cyan]")

        executor = TaskExecutor(
            store=store,
            working_dir=Path(self.runner.tui.working_directory),
            on_output=on_output,
            on_status=on_status,
        )

        async for update in executor.execute_streaming(task_id):
            if update["type"] == "error":
                self.console.print(f"[red]Error: {update['error']}[/red]")
                break
            elif update["type"] == "started":
                self.console.print(f"[green]Task started[/green]")
            elif update["type"] == "batch_started":
                self.console.print(f"\n[yellow]> {update['title']}[/yellow] [{update['delegate']}]")
            elif update["type"] == "batch_completed":
                if update["success"]:
                    self.console.print(f"[green]Batch completed[/green]")
                else:
                    self.console.print(f"[red]Batch failed[/red]")
                if update.get("output"):
                    self.console.print(Panel(
                        update["output"][:500] + ("..." if len(update.get("output", "")) > 500 else ""),
                        title="Output",
                        border_style="dim"
                    ))
            elif update["type"] == "finished":
                if update["success"]:
                    self.console.print(f"\n[green bold]Task completed successfully[/green bold]")
                else:
                    self.console.print(f"\n[red bold]Task failed again[/red bold]")

    def check_for_ready_task_from_tools(self) -> Optional[str]:
        """
        Check if mark_task_ready was called by looking at tools_used.

        Returns:
            Task ID if a task is ready for execution, None otherwise
        """
        if "mark_task_ready" not in self.runner.tui.state.tools_used:
            return None

        # Find the most recent task that's in ready status
        try:
            from ...tasks import TaskStore, TaskStatus
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            ready_tasks = store.get_ready()
            if ready_tasks:
                # Return the most recently updated ready task
                return ready_tasks[0].id
        except Exception:
            pass

        return None

    async def prompt_task_ready(self, task_id: str) -> Optional[str]:
        """
        Prompt user for action on a ready task.

        Returns:
            User's feedback text if they chose feedback, None otherwise
        """
        from ...tasks import TaskStore

        try:
            store = TaskStore(working_dir=Path(self.runner.tui.working_directory))
            task = store.get(task_id)
            title = task.title if task else task_id

            while True:
                selector = TaskReadySelector(self.console, task_id, title)
                action = await selector.select()

                if action == "execute":
                    # Execute in background (non-blocking)
                    await self.execute_task_background(task_id)
                    return None

                elif action == "stream":
                    # Execute with streaming output (blocking)
                    await self.execute_task(task_id)
                    return None

                elif action == "review":
                    # Show the task details
                    self.runner.tui._show_task(task_id)
                    # Loop back to selector
                    continue

                elif action == "feedback":
                    # Get feedback from user and return it for Hester to process
                    self.console.print()
                    try:
                        feedback = await self.runner._prompt_session.prompt_async(
                            HTML('<prompt>Feedback:</prompt> '),
                        )
                        feedback = feedback.strip()
                        if feedback:
                            return feedback
                    except EOFError:
                        pass
                    # If empty feedback, loop back
                    continue

                else:  # skip/None
                    return None

        except KeyboardInterrupt:
            pass
        except Exception as e:
            self.console.print(f"[dim]Error prompting for task: {e}[/dim]")
            import traceback
            self.console.print(f"[dim]{traceback.format_exc()}[/dim]")

        return None
