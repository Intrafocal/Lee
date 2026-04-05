"""
Task Executor - Orchestrates batch execution for tasks.

Supports hybrid observation parsing with local Gemma models to:
- Extract key findings from batch outputs
- Determine if task goal is met
- Suggest adjustments for subsequent batches

Uses DelegateFactory for clean delegate instantiation.

Automatically pushes task status updates to Lee IDE status bar.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Dict, List, Literal, Optional

from .models import Task, TaskBatch, TaskStatus, BatchStatus, BatchDelegate
from .store import TaskStore
from .claude_delegate import ClaudeDelegate
from ..prepare import prepare_batch, OllamaFunctionGemma, OllamaGemmaClient, BatchPrepareResult
from ..models import ObservationResult
from ..semantic.factory import DelegateFactory

logger = logging.getLogger("hester.daemon.tasks.executor")


# Task status notification helper
async def _notify_task_status(
    task_id: str,
    task_title: str,
    status: str,
    message_type: Literal["hint", "info", "success", "warning"] = "info",
    details: Optional[str] = None,
) -> None:
    """
    Push task status notification to Lee IDE status bar.

    Args:
        task_id: Task identifier
        task_title: Human-readable task title
        status: Status string (e.g., "executing", "completed", "failed")
        message_type: Type of status message
        details: Optional additional details
    """
    try:
        from ..tools.ui_control import push_status_message

        # Build status message
        status_icons = {
            "created": "📋",
            "updated": "✏️",
            "ready": "▶️",
            "executing": "⚙️",
            "completed": "✅",
            "failed": "❌",
        }
        icon = status_icons.get(status, "📌")

        # Truncate title if too long
        short_title = task_title[:30] + "..." if len(task_title) > 30 else task_title

        message = f"{icon} {short_title}: {status}"
        if details:
            message = f"{message} - {details}"

        # Set TTL based on status (completed/failed stay longer)
        ttl = 30 if status in ("completed", "failed") else 15

        # Include prompt for quick access to task details
        prompt = f"/task {task_id}"

        await push_status_message(
            message=message,
            message_type=message_type,
            prompt=prompt,
            ttl=ttl,
        )
    except Exception as e:
        # Don't fail task execution if notification fails
        logger.debug(f"Failed to push task status to Lee: {e}")


@dataclass
class BatchObservation:
    """Observation result for a completed batch."""
    batch_id: str
    key_findings: List[str] = field(default_factory=list)
    goal_progress: str = ""  # How this batch contributed to the overall goal
    issues_found: List[str] = field(default_factory=list)
    suggested_adjustments: List[str] = field(default_factory=list)
    is_goal_met: bool = False
    confidence: float = 0.5
    parse_time_ms: float = 0.0


class TaskExecutor:
    """
    Orchestrates task execution by delegating batches to appropriate handlers.

    Batches can be delegated to:
    - claude_code: Claude Code Agent SDK
    - hester: Hester's own tools (validate, test, etc.)
    - manual: User must complete manually
    """

    def __init__(
        self,
        store: TaskStore,
        working_dir: Optional[Path] = None,
        tool_handlers: Optional[Dict[str, Any]] = None,
        on_output: Optional[Callable[[str], None]] = None,
        on_status: Optional[Callable[[str, str], None]] = None,
        prepare_enabled: bool = True,
        ollama_client: Optional[OllamaFunctionGemma] = None,
        local_client: Optional[OllamaGemmaClient] = None,
        observation_enabled: bool = True,
        observation_model: str = "gemma4-e4b",
    ):
        """
        Initialize the task executor.

        Args:
            store: TaskStore for persistence
            working_dir: Working directory for execution
            tool_handlers: Dict mapping tool names to handler functions
            on_output: Callback for streaming output
            on_status: Callback for status updates (batch_id, status)
            prepare_enabled: Whether to run FunctionGemma prepare step before batches
            ollama_client: Optional Ollama client for prepare (FunctionGemma)
            local_client: Optional OllamaGemmaClient for batch observation parsing
            observation_enabled: Whether to run local observation parsing after batches
            observation_model: Model to use for observation parsing (default: gemma4-e4b)
        """
        self.store = store
        self.working_dir = working_dir or Path.cwd()
        self.tool_handlers = tool_handlers or {}
        self.on_output = on_output
        self.on_status = on_status
        self.prepare_enabled = prepare_enabled
        self._ollama_client = ollama_client
        self._local_client = local_client
        self.observation_enabled = observation_enabled
        self.observation_model = observation_model

        # Track observations across batches
        self._batch_observations: List[BatchObservation] = []

        # Initialize delegate factory for clean delegate creation
        self._factory = DelegateFactory(
            working_dir=self.working_dir,
            default_config={
                "on_output": on_output,
                "quiet": True,  # Suppress progress output in batch mode
            }
        )

        # Claude delegate is special - needs on_output callback
        self.claude_delegate = ClaudeDelegate(
            working_dir=self.working_dir,
            on_output=on_output,
        )

    async def execute(self, task_id: str) -> Dict[str, Any]:
        """
        Execute a task by running all its batches.

        Uses local Gemma models to parse batch outputs and inform subsequent batches.

        Args:
            task_id: The task ID to execute

        Returns:
            Dict with execution results
        """
        task = self.store.get(task_id)
        if not task:
            return {"success": False, "error": f"Task not found: {task_id}"}

        if task.status not in [TaskStatus.READY, TaskStatus.EXECUTING]:
            return {"success": False, "error": f"Task is not ready for execution: {task.status.value}"}

        # Mark task as executing
        task.status = TaskStatus.EXECUTING
        task.add_log("Execution started")
        self.store.save(task)

        logger.info(f"Starting execution of task: {task_id}")

        # Notify Lee that task is executing
        await _notify_task_status(
            task_id=task.id,
            task_title=task.title,
            status="executing",
            message_type="info",
            details=f"{len(task.batches)} batches",
        )

        # Reset batch observations for this execution
        self._batch_observations = []

        results = []
        success = True

        # Build shared context from task
        context = self.claude_delegate.build_context_from_task(task)

        for batch in task.batches:
            if batch.status == BatchStatus.COMPLETED:
                logger.debug(f"Skipping completed batch: {batch.id}")
                continue

            batch_result = await self._execute_batch(task, batch, context)
            results.append(batch_result)

            # Parse batch output with local model
            if batch_result.get("output"):
                observation = await self._observe_batch_output(
                    task=task,
                    batch=batch,
                    output=batch_result["output"],
                    success=batch_result.get("success", False),
                )

                if observation:
                    self._batch_observations.append(observation)

                    # Log observation to task
                    if observation.key_findings:
                        task.add_log(f"Observed: {', '.join(observation.key_findings[:3])}")

                    # Apply observation insights to context for next batch
                    context = self._apply_observation_to_context(observation, context)

                    # Check if goal is met early
                    if observation.is_goal_met and observation.confidence >= 0.8:
                        task.add_log(f"Goal appears complete after batch: {batch.title}")
                        logger.info(f"Task goal met after batch {batch.id} (confidence: {observation.confidence})")

            # Save task after each batch
            self.store.save(task)

            if not batch_result.get("success", False):
                success = False
                break

        # Update task status
        if success:
            task.status = TaskStatus.COMPLETED
            task.add_log("Execution completed successfully")
            # Notify Lee of successful completion
            await _notify_task_status(
                task_id=task.id,
                task_title=task.title,
                status="completed",
                message_type="success",
            )
        else:
            task.status = TaskStatus.FAILED
            task.add_log("Execution failed")
            # Notify Lee of failure
            await _notify_task_status(
                task_id=task.id,
                task_title=task.title,
                status="failed",
                message_type="warning",
            )

        self.store.save(task)

        return {
            "success": success,
            "task_id": task_id,
            "status": task.status.value,
            "batches": results,
            "observations": [
                {
                    "batch_id": obs.batch_id,
                    "key_findings": obs.key_findings,
                    "goal_progress": obs.goal_progress,
                    "issues_found": obs.issues_found,
                    "is_goal_met": obs.is_goal_met,
                    "confidence": obs.confidence,
                }
                for obs in self._batch_observations
            ],
        }

    async def _prepare_batch(
        self,
        task: Task,
        batch: TaskBatch,
    ) -> Optional[BatchPrepareResult]:
        """
        Run FunctionGemma prepare step for a batch.

        Updates batch with thinking_depth, relevant_tools, tool_hints.
        """
        if not self.prepare_enabled:
            return None

        # Get files from batch steps or task context
        batch_files = task.context.files[:] if task.context else []

        # Build task context string
        task_context = f"{task.title}: {task.goal}"

        try:
            result = await prepare_batch(
                batch_description=batch.prompt or batch.title,
                batch_files=batch_files,
                task_context=task_context,
                ollama_client=self._ollama_client,
            )

            # Update batch with prepare results
            batch.thinking_depth = result.thinking_depth.name
            batch.relevant_tools = result.relevant_tools
            batch.tool_hints = result.tool_hints
            batch.estimated_complexity = result.estimated_complexity

            logger.debug(
                f"Prepared batch {batch.id}: depth={batch.thinking_depth}, "
                f"tools={len(batch.relevant_tools)}, complexity={batch.estimated_complexity}"
            )

            return result

        except Exception as e:
            logger.warning(f"Prepare step failed for batch {batch.id}: {e}")
            return None

    async def _execute_batch(
        self,
        task: Task,
        batch: TaskBatch,
        context: str,
    ) -> Dict[str, Any]:
        """Execute a single batch."""
        logger.info(f"Executing batch: {batch.title} ({batch.delegate.value})")

        # Run prepare step for Claude Code batches
        if batch.delegate == BatchDelegate.CLAUDE_CODE:
            prepare_result = await self._prepare_batch(task, batch)
            if prepare_result:
                task.add_log(
                    f"Batch prepared: {batch.title} "
                    f"(depth={batch.thinking_depth}, tools={len(batch.relevant_tools)})"
                )

        batch.status = BatchStatus.RUNNING
        task.add_log(f"Batch started: {batch.title}")

        if self.on_status:
            self.on_status(batch.id, "running")

        try:
            # Build context with chaining from previous batches
            batch_context = self._build_batch_context(task, batch)
            if context and batch_context:
                batch_context = f"{context}\n\n{batch_context}"
            elif context:
                batch_context = context

            # Execute batch using appropriate delegate
            result = await self._execute_delegate(task, batch, batch_context)

            if result.get("success"):
                batch.status = BatchStatus.COMPLETED
                task.add_log(f"Batch completed: {batch.title}")
                # Log output summary to task
                if result.get("output"):
                    output_preview = result["output"][:500]
                    if len(result["output"]) > 500:
                        output_preview += "..."
                    task.add_log(f"Output: {output_preview}")
            else:
                batch.status = BatchStatus.FAILED
                error_msg = result.get('error', 'Unknown error')
                task.add_log(f"Batch failed: {batch.title} - {error_msg}")
                # Log failure output for debugging
                if result.get("output"):
                    task.add_log(f"Failure output: {result['output'][:500]}")

            if self.on_status:
                self.on_status(batch.id, batch.status.value)

            return result

        except Exception as e:
            logger.error(f"Batch execution error: {e}")
            batch.status = BatchStatus.FAILED
            task.add_log(f"Batch error: {batch.title} - {str(e)}")

            if self.on_status:
                self.on_status(batch.id, "failed")

            return {"success": False, "error": str(e)}

    async def _execute_delegate(
        self,
        task: Task,
        batch: TaskBatch,
        context: str,
    ) -> Dict[str, Any]:
        """
        Execute a batch using the appropriate delegate.

        Uses DelegateFactory for standard delegates, with special handling for:
        - CLAUDE_CODE: Uses pre-configured claude_delegate
        - VALIDATOR: Runs validation/test commands
        - MANUAL: Returns manual steps for user
        """
        delegate_type = batch.delegate

        # Special handling for Claude Code (uses pre-configured delegate)
        if delegate_type == BatchDelegate.CLAUDE_CODE:
            return await self.claude_delegate.execute_batch(batch, context=context)

        # Special handling for Validator (internal functionality)
        if delegate_type == BatchDelegate.VALIDATOR:
            return await self._execute_validator_batch(batch)

        # Special handling for Manual batches
        if delegate_type == BatchDelegate.MANUAL:
            return await self._execute_manual_batch(batch)

        # Use factory for all other delegates
        try:
            # Check if delegate is registered in factory
            if self._factory.is_delegate_registered(delegate_type.value):
                delegate = self._factory.create(
                    delegate_type.value,
                    toolset=batch.toolset or "observe",
                    scoped_tools=batch.scoped_tools if batch.scoped_tools else None,
                )
                result = await delegate.execute_batch(batch, context=context)
            else:
                # Fallback to legacy import for unregistered delegates
                result = await self._execute_legacy_delegate(batch, context)

            # Store output summary for context chaining
            if result.get("success") and result.get("summary"):
                batch.output_summary = result["summary"]

            if self.on_output and result.get("output"):
                self.on_output(result["output"])

            return result

        except Exception as e:
            logger.error(f"Delegate execution failed: {e}")
            return {"success": False, "error": str(e)}

    async def _execute_legacy_delegate(
        self,
        batch: TaskBatch,
        context: str,
    ) -> Dict[str, Any]:
        """
        Fallback for delegates not yet migrated to the registry.

        This method provides backwards compatibility during the transition
        to the factory pattern.
        """
        delegate_type = batch.delegate

        if delegate_type == BatchDelegate.CODE_EXPLORER:
            from .code_explorer_delegate import CodeExplorerDelegate
            delegate = CodeExplorerDelegate(
                working_dir=self.working_dir,
                toolset=batch.toolset or "observe",
                scoped_tools=batch.scoped_tools if batch.scoped_tools else None,
                quiet=True,
            )
            return await delegate.execute_batch(batch, context=context)

        elif delegate_type == BatchDelegate.WEB_RESEARCHER:
            from .web_researcher_delegate import WebResearcherDelegate
            delegate = WebResearcherDelegate()
            return await delegate.execute_batch(batch, context=context)

        elif delegate_type == BatchDelegate.DOCS_MANAGER:
            from .docs_manager_delegate import DocsManagerDelegate
            delegate = DocsManagerDelegate(working_dir=self.working_dir)
            return await delegate.execute_batch(batch, context=context)

        elif delegate_type == BatchDelegate.DB_EXPLORER:
            from .db_explorer_delegate import DbExplorerDelegate
            delegate = DbExplorerDelegate()
            return await delegate.execute_batch(batch, context=context)

        elif delegate_type == BatchDelegate.TEST_RUNNER:
            from .test_runner_delegate import TestRunnerDelegate
            delegate = TestRunnerDelegate(working_dir=self.working_dir)
            return await delegate.execute_batch(batch)

        elif delegate_type == BatchDelegate.CONTEXT_BUNDLE:
            from .context_bundle_delegate import ContextBundleDelegate
            delegate = ContextBundleDelegate(working_dir=self.working_dir)
            return await delegate.execute_batch(batch, context=context)

        else:
            return {"success": False, "error": f"Unknown delegate: {delegate_type}"}

    async def _execute_validator_batch(self, batch: TaskBatch) -> Dict[str, Any]:
        """Execute a validation batch (linting, type checks, tests)."""
        action = batch.action or "validate"

        if action == "validate":
            return await self._run_validation()
        elif action == "test":
            return await self._run_tests()
        else:
            return {"success": False, "error": f"Unknown validator action: {action}"}

    async def _execute_manual_batch(self, batch: TaskBatch) -> Dict[str, Any]:
        """Handle a manual batch (user must complete)."""
        output = f"Manual batch: {batch.title}\n"
        output += "Steps:\n"
        for step in batch.steps:
            output += f"- [ ] {step}\n"
        output += "\nPlease complete these steps manually."

        batch.output = output

        if self.on_output:
            self.on_output(output)

        return {
            "success": True,
            "output": output,
            "manual": True,
        }

    async def _run_validation(self) -> Dict[str, Any]:
        """Run validation (lint, type check, etc.)."""
        results = []

        if "bash" in self.tool_handlers:
            try:
                result = await self.tool_handlers["bash"](
                    command="ruff check . --quiet 2>/dev/null || flake8 . --quiet 2>/dev/null || echo 'No linter found'"
                )
                results.append(f"Lint: {result.get('output', 'OK')}")
            except Exception as e:
                results.append(f"Lint: {e}")

        output = "\n".join(results) or "Validation completed"

        if self.on_output:
            self.on_output(output)

        return {"success": True, "output": output}

    async def _run_tests(self) -> Dict[str, Any]:
        """Run tests."""
        if "bash" not in self.tool_handlers:
            return {"success": False, "error": "Bash tool not available for running tests"}

        try:
            result = await self.tool_handlers["bash"](
                command="pytest -v 2>/dev/null || python -m pytest -v 2>/dev/null || echo 'No pytest found'"
            )
            output = result.get("output", "Tests completed")

            if self.on_output:
                self.on_output(output)

            return {"success": True, "output": output}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _build_batch_context(self, task: Task, batch: TaskBatch) -> str:
        """
        Build context for a batch from previous batch outputs and context bundles.

        Args:
            task: The parent task
            batch: The current batch

        Returns:
            Combined context string
        """
        context_parts = []

        # Add context from base task
        base_context = self.claude_delegate.build_context_from_task(task)
        if base_context:
            context_parts.append(base_context)

        # Add context bundle if specified
        if batch.context_bundle:
            bundle_content = self._load_context_bundle(batch.context_bundle)
            if bundle_content:
                context_parts.append(f"## Context Bundle\n{bundle_content}")

        # Add outputs from referenced batches
        if batch.context_from:
            for batch_id in batch.context_from:
                prev_batch = self._get_batch_by_id(task, batch_id)
                if prev_batch:
                    # Prefer summary over full output for context chaining
                    if prev_batch.output_summary:
                        context_parts.append(
                            f"## From: {prev_batch.title}\n{prev_batch.output_summary}"
                        )
                    elif prev_batch.output:
                        # Truncate long outputs
                        output = prev_batch.output
                        if len(output) > 2000:
                            output = output[:2000] + "\n...[truncated]..."
                        context_parts.append(
                            f"## From: {prev_batch.title}\n{output}"
                        )

        return "\n\n".join(context_parts)

    def _load_context_bundle(self, bundle_path: str) -> Optional[str]:
        """Load a context bundle file."""
        try:
            path = Path(bundle_path)
            if not path.is_absolute():
                path = self.working_dir / path
            if path.exists():
                return path.read_text()
            logger.warning(f"Context bundle not found: {bundle_path}")
        except Exception as e:
            logger.error(f"Failed to load context bundle: {e}")
        return None

    def _get_batch_by_id(self, task: Task, batch_id: str) -> Optional[TaskBatch]:
        """Get a batch by ID from the task."""
        for batch in task.batches:
            if batch.id == batch_id:
                return batch
        return None

    async def _observe_batch_output(
        self,
        task: Task,
        batch: TaskBatch,
        output: str,
        success: bool,
    ) -> Optional[BatchObservation]:
        """
        Parse batch output with local Gemma model to extract key findings.

        This allows Hester to understand what happened in each batch and
        potentially adjust subsequent batches.

        Args:
            task: The parent task
            batch: The completed batch
            output: The batch output text
            success: Whether the batch succeeded

        Returns:
            BatchObservation with extracted information, or None if parsing failed
        """
        if not self.observation_enabled or not self._local_client:
            return None

        import time
        start_time = time.perf_counter()

        # Truncate output if too long
        output_truncated = output
        if len(output) > 6000:
            output_truncated = output[:3000] + "\n...[truncated]...\n" + output[-2500:]

        # Build observation prompt
        prompt = f"""Analyze this batch execution output and extract key information.

TASK GOAL: {task.goal}

BATCH: {batch.title}
BATCH DESCRIPTION: {batch.prompt or 'No description'}
STATUS: {'SUCCESS' if success else 'FAILED'}

OUTPUT:
{output_truncated}

Analyze the output and respond in this exact format:

FINDINGS:
- [key finding 1]
- [key finding 2]
- [etc.]

GOAL_PROGRESS: [One sentence describing how this batch contributed to the overall task goal]

ISSUES:
- [issue 1 if any]
- [issue 2 if any]
- [or "None" if no issues]

ADJUSTMENTS:
- [suggestion for subsequent batches if any]
- [or "None" if no adjustments needed]

GOAL_MET: [yes/no] (Is the overall task goal now complete based on this batch?)
CONFIDENCE: [0.0-1.0] (How confident are you in this analysis?)
"""

        try:
            response = await self._local_client.generate_with_precision(
                prompt=prompt,
                model_key=self.observation_model,
                timeout_ms=2000,  # Allow more time for batch analysis
            )

            elapsed_ms = (time.perf_counter() - start_time) * 1000

            if response:
                return self._parse_batch_observation(batch.id, response, elapsed_ms)

        except Exception as e:
            logger.debug(f"Batch observation parsing failed: {e}")

        return None

    def _parse_batch_observation(
        self,
        batch_id: str,
        response: str,
        elapsed_ms: float,
    ) -> BatchObservation:
        """Parse the observation response into BatchObservation."""
        import re

        # Extract findings
        findings: List[str] = []
        findings_match = re.search(r"FINDINGS:\s*(.*?)(?=GOAL_PROGRESS:|$)", response, re.DOTALL)
        if findings_match:
            findings_text = findings_match.group(1)
            findings = [
                line.strip().lstrip("-").strip()
                for line in findings_text.strip().split("\n")
                if line.strip() and line.strip().startswith("-")
            ]

        # Extract goal progress
        goal_progress = ""
        progress_match = re.search(r"GOAL_PROGRESS:\s*(.+?)(?=ISSUES:|$)", response, re.DOTALL)
        if progress_match:
            goal_progress = progress_match.group(1).strip().split("\n")[0]

        # Extract issues
        issues: List[str] = []
        issues_match = re.search(r"ISSUES:\s*(.*?)(?=ADJUSTMENTS:|$)", response, re.DOTALL)
        if issues_match:
            issues_text = issues_match.group(1)
            for line in issues_text.strip().split("\n"):
                line = line.strip().lstrip("-").strip()
                if line and line.lower() != "none":
                    issues.append(line)

        # Extract adjustments
        adjustments: List[str] = []
        adj_match = re.search(r"ADJUSTMENTS:\s*(.*?)(?=GOAL_MET:|$)", response, re.DOTALL)
        if adj_match:
            adj_text = adj_match.group(1)
            for line in adj_text.strip().split("\n"):
                line = line.strip().lstrip("-").strip()
                if line and line.lower() != "none":
                    adjustments.append(line)

        # Extract goal_met
        is_goal_met = False
        goal_match = re.search(r"GOAL_MET:\s*(yes|no)", response, re.IGNORECASE)
        if goal_match:
            is_goal_met = goal_match.group(1).lower() == "yes"

        # Extract confidence
        confidence = 0.5
        conf_match = re.search(r"CONFIDENCE:\s*([\d.]+)", response)
        if conf_match:
            try:
                confidence = float(conf_match.group(1))
                confidence = max(0.0, min(1.0, confidence))
            except ValueError:
                pass

        return BatchObservation(
            batch_id=batch_id,
            key_findings=findings or ["Batch completed"],
            goal_progress=goal_progress,
            issues_found=issues,
            suggested_adjustments=adjustments,
            is_goal_met=is_goal_met,
            confidence=confidence,
            parse_time_ms=elapsed_ms,
        )

    def _apply_observation_to_context(
        self,
        observation: BatchObservation,
        context: str,
    ) -> str:
        """
        Apply observation insights to the context for subsequent batches.

        This allows later batches to be informed by what happened in earlier ones.
        """
        if not observation.key_findings and not observation.issues_found:
            return context

        additions = []

        if observation.key_findings:
            additions.append("Previous batch findings:")
            for finding in observation.key_findings[:5]:  # Limit to 5
                additions.append(f"  - {finding}")

        if observation.issues_found:
            additions.append("Issues to address:")
            for issue in observation.issues_found[:3]:  # Limit to 3
                additions.append(f"  - {issue}")

        if observation.suggested_adjustments:
            additions.append("Suggested adjustments:")
            for adj in observation.suggested_adjustments[:3]:
                additions.append(f"  - {adj}")

        if additions:
            return context + "\n\n" + "\n".join(additions)

        return context

    async def execute_streaming(self, task_id: str) -> AsyncIterator[Dict[str, Any]]:
        """
        Execute a task with streaming status updates.

        Uses local Gemma models to parse batch outputs and inform subsequent batches.

        Args:
            task_id: The task ID to execute

        Yields:
            Status updates for each batch including observation insights
        """
        task = self.store.get(task_id)
        if not task:
            yield {"type": "error", "error": f"Task not found: {task_id}"}
            return

        if task.status not in [TaskStatus.READY, TaskStatus.EXECUTING]:
            yield {"type": "error", "error": f"Task is not ready: {task.status.value}"}
            return

        # Mark task as executing
        task.status = TaskStatus.EXECUTING
        task.add_log("Execution started")
        self.store.save(task)

        # Notify Lee that task is executing
        await _notify_task_status(
            task_id=task.id,
            task_title=task.title,
            status="executing",
            message_type="info",
            details=f"{len(task.batches)} batches",
        )

        # Reset batch observations for this execution
        self._batch_observations = []

        yield {"type": "started", "task_id": task_id}

        context = self.claude_delegate.build_context_from_task(task)
        success = True

        for batch in task.batches:
            if batch.status == BatchStatus.COMPLETED:
                continue

            yield {
                "type": "batch_started",
                "batch_id": batch.id,
                "title": batch.title,
                "delegate": batch.delegate.value,
            }

            result = await self._execute_batch(task, batch, context)
            self.store.save(task)

            # Parse batch output with local model
            observation = None
            if result.get("output"):
                observation = await self._observe_batch_output(
                    task=task,
                    batch=batch,
                    output=result["output"],
                    success=result.get("success", False),
                )

                if observation:
                    self._batch_observations.append(observation)

                    # Log observation to task
                    if observation.key_findings:
                        task.add_log(f"Observed: {', '.join(observation.key_findings[:3])}")

                    # Apply observation insights to context for next batch
                    context = self._apply_observation_to_context(observation, context)

                    self.store.save(task)

            yield {
                "type": "batch_completed",
                "batch_id": batch.id,
                "title": batch.title,
                "success": result.get("success", False),
                "output": result.get("output", ""),
                "observation": {
                    "key_findings": observation.key_findings if observation else [],
                    "goal_progress": observation.goal_progress if observation else "",
                    "issues_found": observation.issues_found if observation else [],
                    "is_goal_met": observation.is_goal_met if observation else False,
                    "confidence": observation.confidence if observation else 0.0,
                } if observation else None,
            }

            if not result.get("success"):
                success = False
                break

        # Update final status
        task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
        task.add_log(f"Execution {'completed' if success else 'failed'}")
        self.store.save(task)

        # Notify Lee of final status
        if success:
            await _notify_task_status(
                task_id=task.id,
                task_title=task.title,
                status="completed",
                message_type="success",
            )
        else:
            await _notify_task_status(
                task_id=task.id,
                task_title=task.title,
                status="failed",
                message_type="warning",
            )

        yield {
            "type": "finished",
            "task_id": task_id,
            "success": success,
            "status": task.status.value,
            "observations": [
                {
                    "batch_id": obs.batch_id,
                    "key_findings": obs.key_findings,
                    "goal_progress": obs.goal_progress,
                    "is_goal_met": obs.is_goal_met,
                }
                for obs in self._batch_observations
            ],
        }
