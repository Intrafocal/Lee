"""
Claude Delegate - Claude Code Agent SDK integration for task execution.
"""

import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, Optional

from .models import TaskBatch, BatchStatus

logger = logging.getLogger("hester.daemon.tasks.claude_delegate")


class ClaudeDelegate:
    """
    Delegates work batches to Claude Code via the Agent SDK.

    Uses ClaudeSDKClient for persistent sessions when available,
    falling back to query() for one-shot execution.
    """

    def __init__(
        self,
        working_dir: Optional[Path] = None,
        model: str = "claude-sonnet-4-20250514",
        on_output: Optional[Callable[[str], None]] = None,
        api_key: Optional[str] = None,
        cli_path: Optional[str] = None,
    ):
        """
        Initialize the Claude delegate.

        Args:
            working_dir: Working directory for Claude Code
            model: Claude model to use
            on_output: Callback for streaming output
            api_key: Anthropic API key (defaults to HESTER_ANTHROPIC_KEY env var)
            cli_path: Path to Claude CLI (defaults to CLAUDE_CLI_PATH env var)
        """
        self.working_dir = working_dir or Path.cwd()
        self.model = model
        self.on_output = on_output
        self.api_key = api_key or os.environ.get("HESTER_ANTHROPIC_KEY")
        self.cli_path = cli_path or os.environ.get("CLAUDE_CLI_PATH")
        self._client = None

    async def execute_batch(
        self,
        batch: TaskBatch,
        context: Optional[str] = None,
        stream: bool = True,
    ) -> Dict[str, Any]:
        """
        Execute a batch using Claude Code.

        Args:
            batch: The batch to execute
            context: Additional context to include in the prompt
            stream: Whether to stream output

        Returns:
            Dict with execution results
        """
        if not batch.prompt:
            return {
                "success": False,
                "error": "Batch has no prompt defined",
            }

        # Verify API key is configured
        await self._check_api_key()

        # Build the full prompt
        prompt_parts = [batch.prompt]

        if context:
            prompt_parts.insert(0, f"Context:\n{context}\n\n")

        # Add tool hints from prepare step if available
        if batch.tool_hints:
            prompt_parts.insert(0, f"Hints: {batch.tool_hints}\n\n")

        if batch.steps:
            steps_text = "\n".join(f"- {step}" for step in batch.steps)
            prompt_parts.append(f"\n\nSteps to complete:\n{steps_text}")

        full_prompt = "".join(prompt_parts)

        logger.info(f"Executing batch via Claude Code: {batch.title}")

        try:
            if stream:
                return await self._execute_streaming(batch, full_prompt)
            else:
                return await self._execute_oneshot(batch, full_prompt)

        except Exception as e:
            logger.error(f"Claude Code execution failed: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    def _create_transport(self, prompt: str, options):
        """Create a transport with custom CLI path if configured."""
        from claude_code_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
        return SubprocessCLITransport(prompt=prompt, options=options, cli_path=self.cli_path)

    async def _execute_streaming(
        self,
        batch: TaskBatch,
        prompt: str,
    ) -> Dict[str, Any]:
        """Execute with streaming output."""
        try:
            from claude_code_sdk import (
                query,
                ClaudeCodeOptions,
                AssistantMessage,
                ResultMessage,
                TextBlock,
                ToolUseBlock,
            )

            options = ClaudeCodeOptions(
                model=self.model,
                cwd=str(self.working_dir),
                allowed_tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
                permission_mode="acceptEdits",  # Auto-accept file edits
            )

            output_parts = []
            tool_calls = []
            result_info = None

            # Use custom transport if cli_path is configured
            transport = self._create_transport(prompt, options) if self.cli_path else None

            async for message in query(prompt=prompt, options=options, transport=transport):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            output_parts.append(block.text)
                            if self.on_output:
                                self.on_output(block.text)
                        elif isinstance(block, ToolUseBlock):
                            tool_calls.append({
                                "name": block.name,
                                "input": block.input,
                            })
                elif isinstance(message, ResultMessage):
                    result_info = {
                        "result": message.result,
                        "cost_usd": message.total_cost_usd,
                        "usage": message.usage,
                        "is_error": message.is_error,
                    }

            output = "".join(output_parts)
            batch.output = output

            if result_info and result_info.get("is_error"):
                batch.status = BatchStatus.FAILED
                return {
                    "success": False,
                    "output": output,
                    "error": result_info.get("result"),
                    "cost_usd": result_info.get("cost_usd"),
                }

            batch.status = BatchStatus.COMPLETED
            return {
                "success": True,
                "output": output,
                "tool_calls": tool_calls,
                "cost_usd": result_info.get("cost_usd") if result_info else None,
            }

        except ImportError as e:
            raise RuntimeError(
                "claude-code-sdk is not installed. Install it with: pip install claude-code-sdk"
            ) from e

    async def _execute_oneshot(
        self,
        batch: TaskBatch,
        prompt: str,
    ) -> Dict[str, Any]:
        """Execute without streaming."""
        try:
            from claude_code_sdk import (
                query,
                ClaudeCodeOptions,
                AssistantMessage,
                ResultMessage,
                TextBlock,
                ToolUseBlock,
            )

            options = ClaudeCodeOptions(
                model=self.model,
                cwd=str(self.working_dir),
                allowed_tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
                permission_mode="acceptEdits",
            )

            output_parts = []
            tool_calls = []
            result_info = None

            # Use custom transport if cli_path is configured
            transport = self._create_transport(prompt, options) if self.cli_path else None

            async for message in query(prompt=prompt, options=options, transport=transport):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            output_parts.append(block.text)
                        elif isinstance(block, ToolUseBlock):
                            tool_calls.append({
                                "name": block.name,
                                "input": block.input,
                            })
                elif isinstance(message, ResultMessage):
                    result_info = {
                        "result": message.result,
                        "cost_usd": message.total_cost_usd,
                        "usage": message.usage,
                        "is_error": message.is_error,
                    }

            output = "".join(output_parts)
            batch.output = output

            if result_info and result_info.get("is_error"):
                batch.status = BatchStatus.FAILED
                return {
                    "success": False,
                    "output": output,
                    "error": result_info.get("result"),
                }

            batch.status = BatchStatus.COMPLETED
            return {
                "success": True,
                "output": output,
                "tool_calls": tool_calls,
            }

        except ImportError as e:
            raise RuntimeError(
                "claude-code-sdk is not installed. Install it with: pip install claude-code-sdk"
            ) from e

    async def _check_api_key(self) -> None:
        """Verify API key is available."""
        if not self.api_key:
            raise RuntimeError(
                "Anthropic API key not configured. Set HESTER_ANTHROPIC_KEY environment variable."
            )

    async def execute_batches(
        self,
        batches: list[TaskBatch],
        context: Optional[str] = None,
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        Execute multiple batches sequentially.

        Args:
            batches: List of batches to execute
            context: Shared context for all batches

        Yields:
            Results for each batch
        """
        for batch in batches:
            batch.status = BatchStatus.RUNNING
            yield {
                "batch_id": batch.id,
                "status": "started",
                "title": batch.title,
            }

            result = await self.execute_batch(batch, context=context)

            yield {
                "batch_id": batch.id,
                "status": "completed" if result["success"] else "failed",
                "title": batch.title,
                "result": result,
            }

            if not result["success"]:
                batch.status = BatchStatus.FAILED
                break  # Stop on failure

    async def execute_batches_with_session(
        self,
        batches: list[TaskBatch],
        context: Optional[str] = None,
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        Execute multiple batches in a persistent Claude Code session.

        This maintains context between batches for more coherent multi-step tasks.

        Args:
            batches: List of batches to execute
            context: Shared context for all batches

        Yields:
            Results for each batch
        """
        try:
            from claude_code_sdk import (
                ClaudeSDKClient,
                ClaudeCodeOptions,
                AssistantMessage,
                TextBlock,
            )

            options = ClaudeCodeOptions(
                model=self.model,
                cwd=str(self.working_dir),
                allowed_tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
                permission_mode="acceptEdits",
            )

            async with ClaudeSDKClient(options=options) as client:
                for batch in batches:
                    batch.status = BatchStatus.RUNNING
                    yield {
                        "batch_id": batch.id,
                        "status": "started",
                        "title": batch.title,
                    }

                    # Build prompt with context
                    prompt = batch.prompt
                    if context:
                        prompt = f"Context:\n{context}\n\n{prompt}"
                    if batch.steps:
                        steps_text = "\n".join(f"- {step}" for step in batch.steps)
                        prompt = f"{prompt}\n\nSteps to complete:\n{steps_text}"

                    output_parts = []
                    async for message in client.process(prompt):
                        if isinstance(message, AssistantMessage):
                            for block in message.content:
                                if isinstance(block, TextBlock):
                                    output_parts.append(block.text)
                                    if self.on_output:
                                        self.on_output(block.text)

                    batch.output = "".join(output_parts)
                    batch.status = BatchStatus.COMPLETED

                    yield {
                        "batch_id": batch.id,
                        "status": "completed",
                        "title": batch.title,
                        "result": {"success": True, "output": batch.output},
                    }

        except ImportError as e:
            raise RuntimeError(
                "claude-code-sdk is not installed. Install it with: pip install claude-code-sdk"
            ) from e

    def build_context_from_task(self, task) -> str:
        """
        Build context string from task for Claude Code.

        Args:
            task: The task to build context from

        Returns:
            Context string
        """
        parts = []

        parts.append(f"# Task: {task.title}")
        parts.append(f"\n## Goal\n{task.goal}")

        if task.context.files:
            parts.append(f"\n## Relevant Files\n" + "\n".join(f"- {f}" for f in task.context.files))

        if task.context.codebase_notes:
            parts.append(f"\n## Codebase Notes\n{task.context.codebase_notes}")

        if task.context.web_research:
            parts.append(f"\n## Research\n" + "\n".join(f"- {r}" for r in task.context.web_research))

        if task.success_criteria:
            parts.append(f"\n## Success Criteria\n" + "\n".join(f"- {c}" for c in task.success_criteria))

        return "\n".join(parts)
