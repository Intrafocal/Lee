"""
Task System Models - Pydantic models with markdown parsing.
"""

import re
import uuid
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    """Task lifecycle status."""
    PLANNING = "planning"
    READY = "ready"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"


class BatchStatus(str, Enum):
    """Batch execution status."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class BatchDelegate(str, Enum):
    """Who handles the batch."""
    CLAUDE_CODE = "claude_code"  # Full code implementation via Claude Code
    VALIDATOR = "validator"  # Run linting, type checks, tests
    MANUAL = "manual"  # Human must complete
    CODE_EXPLORER = "code_explorer"  # Scoped codebase exploration/research
    WEB_RESEARCHER = "web_researcher"  # Web research with Google Search
    # P2 Delegates
    DOCS_MANAGER = "docs_manager"  # Documentation management (search, check, write, update)
    DB_EXPLORER = "db_explorer"  # Natural language database exploration
    TEST_RUNNER = "test_runner"  # Multi-framework test execution


class TaskContext(BaseModel):
    """Context gathered during planning."""
    files: List[str] = Field(default_factory=list)
    web_research: List[str] = Field(default_factory=list)
    codebase_notes: str = ""


class TaskBatch(BaseModel):
    """A batch of work to be delegated."""
    id: str = Field(default_factory=lambda: f"batch-{uuid.uuid4().hex[:8]}")
    title: str
    delegate: BatchDelegate = BatchDelegate.CLAUDE_CODE
    prompt: str = ""  # For claude_code batches
    action: str = ""  # For hester batches (e.g., "validate", "test")
    steps: List[str] = Field(default_factory=list)
    status: BatchStatus = BatchStatus.PENDING
    output: Optional[str] = None
    # FunctionGemma prepare step fields
    thinking_depth: Optional[str] = None  # "QUICK", "STANDARD", "DEEP", "REASONING"
    relevant_tools: List[str] = Field(default_factory=list)
    tool_hints: str = ""  # Natural language hints for executor
    estimated_complexity: str = "moderate"  # "simple", "moderate", "complex"
    # Subagent context flow fields (Phase 1)
    context_from: List[str] = Field(default_factory=list)  # Batch IDs to pull context from
    context_bundle: Optional[str] = None  # Pre-built context file path
    toolset: Optional[str] = None  # "observe", "research", "develop", "full"
    scoped_tools: List[str] = Field(default_factory=list)  # Explicit tool list
    params: Dict[str, Any] = Field(default_factory=dict)  # Delegate-specific params
    output_as_context: bool = True  # Pass output to next batch
    output_summary: Optional[str] = None  # Summarized for context chaining


class TaskLogEntry(BaseModel):
    """A log entry for task history."""
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    event: str


class Task(BaseModel):
    """A task with markdown serialization."""
    id: str = Field(default_factory=lambda: f"task-{uuid.uuid4().hex[:8]}")
    title: str
    status: TaskStatus = TaskStatus.PLANNING
    goal: str = ""
    context: TaskContext = Field(default_factory=TaskContext)
    batches: List[TaskBatch] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list)
    log: List[TaskLogEntry] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    def add_log(self, event: str) -> None:
        """Add a log entry."""
        self.log.append(TaskLogEntry(event=event))
        self.updated_at = datetime.utcnow()

    def to_markdown(self) -> str:
        """Serialize task to markdown with YAML frontmatter."""
        # YAML frontmatter
        frontmatter = {
            "id": self.id,
            "status": self.status.value,
            "created": self.created_at.isoformat(),
            "updated": self.updated_at.isoformat(),
        }

        lines = ["---"]
        lines.append(yaml.dump(frontmatter, default_flow_style=False).strip())
        lines.append("---")
        lines.append("")

        # Title
        lines.append(f"# {self.title}")
        lines.append("")

        # Goal
        lines.append("## Goal")
        lines.append(self.goal if self.goal else "_No goal defined yet._")
        lines.append("")

        # Context
        lines.append("## Context")
        if self.context.files:
            lines.append(f"- **Files**: {', '.join(f'`{f}`' for f in self.context.files)}")
        if self.context.web_research:
            lines.append(f"- **Web Research**: {', '.join(self.context.web_research)}")
        if self.context.codebase_notes:
            lines.append(f"- **Codebase Notes**: {self.context.codebase_notes}")
        if not (self.context.files or self.context.web_research or self.context.codebase_notes):
            lines.append("_No context gathered yet._")
        lines.append("")

        # Batches
        lines.append("## Batches")
        lines.append("")
        if self.batches:
            for i, batch in enumerate(self.batches, 1):
                lines.append(f"### Batch {i}: {batch.title} [{batch.delegate.value}]")
                lines.append(f"**Status**: {batch.status.value}")
                lines.append("")

                # Prepare step metadata
                if batch.thinking_depth or batch.relevant_tools or batch.tool_hints:
                    prep_parts = []
                    if batch.thinking_depth:
                        prep_parts.append(f"Depth: {batch.thinking_depth}")
                    if batch.estimated_complexity != "moderate":
                        prep_parts.append(f"Complexity: {batch.estimated_complexity}")
                    if batch.relevant_tools:
                        tools_str = ", ".join(batch.relevant_tools[:5])
                        if len(batch.relevant_tools) > 5:
                            tools_str += f" (+{len(batch.relevant_tools) - 5} more)"
                        prep_parts.append(f"Tools: {tools_str}")
                    if prep_parts:
                        lines.append(f"**Prepare**: {' | '.join(prep_parts)}")
                    if batch.tool_hints:
                        lines.append(f"**Hints**: {batch.tool_hints}")
                    lines.append("")

                # Subagent context flow metadata
                if batch.context_from or batch.context_bundle or batch.toolset or batch.scoped_tools:
                    context_parts = []
                    if batch.toolset:
                        context_parts.append(f"Toolset: {batch.toolset}")
                    if batch.scoped_tools:
                        context_parts.append(f"Scoped tools: {', '.join(batch.scoped_tools[:5])}")
                    if batch.context_from:
                        context_parts.append(f"Context from: {', '.join(batch.context_from)}")
                    if batch.context_bundle:
                        context_parts.append(f"Bundle: {batch.context_bundle}")
                    if context_parts:
                        lines.append(f"**Subagent**: {' | '.join(context_parts)}")
                        lines.append("")

                if batch.delegate == BatchDelegate.CLAUDE_CODE and batch.prompt:
                    lines.append("Prompt for Claude Code:")
                    # Indent prompt as blockquote
                    for pline in batch.prompt.strip().split("\n"):
                        lines.append(f"> {pline}")
                    lines.append("")

                # Handle code_explorer and web_researcher prompts
                if batch.delegate in (BatchDelegate.CODE_EXPLORER, BatchDelegate.WEB_RESEARCHER) and batch.prompt:
                    lines.append(f"Prompt for {batch.delegate.value}:")
                    for pline in batch.prompt.strip().split("\n"):
                        lines.append(f"> {pline}")
                    lines.append("")

                if batch.action:
                    lines.append(f"**Action**: {batch.action}")
                    lines.append("")

                if batch.steps:
                    lines.append("Steps:")
                    for step in batch.steps:
                        checkbox = "[x]" if batch.status == BatchStatus.COMPLETED else "[ ]"
                        lines.append(f"- {checkbox} {step}")
                    lines.append("")

                if batch.output:
                    lines.append("**Output**:")
                    lines.append("```")
                    lines.append(batch.output)
                    lines.append("```")
                    lines.append("")

                if batch.output_summary:
                    lines.append(f"**Summary**: {batch.output_summary}")
                    lines.append("")
        else:
            lines.append("_No batches defined yet._")
            lines.append("")

        # Success Criteria
        lines.append("## Success Criteria")
        if self.success_criteria:
            for criterion in self.success_criteria:
                lines.append(f"- [ ] {criterion}")
        else:
            lines.append("_No success criteria defined yet._")
        lines.append("")

        # Log
        lines.append("## Log")
        if self.log:
            for entry in self.log:
                ts = entry.timestamp.strftime("%Y-%m-%dT%H:%M:%SZ")
                lines.append(f"- {ts}: {entry.event}")
        else:
            lines.append("_No log entries yet._")
        lines.append("")

        return "\n".join(lines)

    @classmethod
    def from_markdown(cls, content: str) -> "Task":
        """Parse task from markdown with YAML frontmatter."""
        # Split frontmatter and body
        frontmatter_match = re.match(r"^---\n(.*?)\n---\n(.*)$", content, re.DOTALL)
        if not frontmatter_match:
            raise ValueError("Invalid task file: missing YAML frontmatter")

        frontmatter_str, body = frontmatter_match.groups()
        frontmatter = yaml.safe_load(frontmatter_str)

        # Parse frontmatter
        task_id = frontmatter.get("id", f"task-{uuid.uuid4().hex[:8]}")
        status = TaskStatus(frontmatter.get("status", "planning"))
        created_at = datetime.fromisoformat(frontmatter["created"]) if "created" in frontmatter else datetime.utcnow()
        updated_at = datetime.fromisoformat(frontmatter["updated"]) if "updated" in frontmatter else datetime.utcnow()

        # Parse title from first H1
        title_match = re.search(r"^# (.+)$", body, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else "Untitled Task"

        # Parse goal section
        goal = ""
        goal_match = re.search(r"## Goal\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if goal_match:
            goal = goal_match.group(1).strip()
            if goal.startswith("_") and goal.endswith("_"):
                goal = ""  # Placeholder text

        # Parse context section
        context = TaskContext()
        context_match = re.search(r"## Context\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if context_match:
            context_text = context_match.group(1)

            # Parse files
            files_match = re.search(r"\*\*Files\*\*: (.+)", context_text)
            if files_match:
                files_str = files_match.group(1)
                context.files = [f.strip().strip("`") for f in files_str.split(",")]

            # Parse web research
            research_match = re.search(r"\*\*Web Research\*\*: (.+)", context_text)
            if research_match:
                context.web_research = [r.strip() for r in research_match.group(1).split(",")]

            # Parse codebase notes
            notes_match = re.search(r"\*\*Codebase Notes\*\*: (.+)", context_text)
            if notes_match:
                context.codebase_notes = notes_match.group(1).strip()

        # Parse batches section
        batches: List[TaskBatch] = []
        batches_match = re.search(r"## Batches\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if batches_match:
            batches_text = batches_match.group(1)

            # Find all batch headers
            batch_pattern = r"### Batch \d+: (.+?) \[(\w+)\]\n\*\*Status\*\*: (\w+)(.*?)(?=\n### |\n## |\Z)"
            for match in re.finditer(batch_pattern, batches_text, re.DOTALL):
                batch_title = match.group(1).strip()
                delegate_str = match.group(2)
                status_str = match.group(3)
                batch_body = match.group(4)

                batch = TaskBatch(
                    title=batch_title,
                    delegate=BatchDelegate(delegate_str),
                    status=BatchStatus(status_str),
                )

                # Parse prepare metadata
                prepare_match = re.search(r"\*\*Prepare\*\*: (.+)", batch_body)
                if prepare_match:
                    prepare_str = prepare_match.group(1)
                    # Parse depth
                    depth_match = re.search(r"Depth: (\w+)", prepare_str)
                    if depth_match:
                        batch.thinking_depth = depth_match.group(1)
                    # Parse complexity
                    complexity_match = re.search(r"Complexity: (\w+)", prepare_str)
                    if complexity_match:
                        batch.estimated_complexity = complexity_match.group(1)
                    # Parse tools (just the listed ones, ignore "+N more")
                    tools_match = re.search(r"Tools: ([^|]+)", prepare_str)
                    if tools_match:
                        tools_str = tools_match.group(1).strip()
                        # Remove (+N more) suffix
                        tools_str = re.sub(r"\s*\(\+\d+ more\)", "", tools_str)
                        batch.relevant_tools = [t.strip() for t in tools_str.split(",") if t.strip()]

                # Parse hints
                hints_match = re.search(r"\*\*Hints\*\*: (.+)", batch_body)
                if hints_match:
                    batch.tool_hints = hints_match.group(1).strip()

                # Parse prompt (blockquote)
                prompt_lines = []
                for line in batch_body.split("\n"):
                    if line.startswith("> "):
                        prompt_lines.append(line[2:])
                if prompt_lines:
                    batch.prompt = "\n".join(prompt_lines)

                # Parse action
                action_match = re.search(r"\*\*Action\*\*: (.+)", batch_body)
                if action_match:
                    batch.action = action_match.group(1).strip()

                # Parse steps
                steps = []
                for step_match in re.finditer(r"- \[[ x]\] (.+)", batch_body):
                    steps.append(step_match.group(1).strip())
                batch.steps = steps

                # Parse output
                output_match = re.search(r"\*\*Output\*\*:\n```\n(.*?)\n```", batch_body, re.DOTALL)
                if output_match:
                    batch.output = output_match.group(1)

                # Parse output summary
                summary_match = re.search(r"\*\*Summary\*\*: (.+)", batch_body)
                if summary_match:
                    batch.output_summary = summary_match.group(1).strip()

                # Parse subagent metadata
                subagent_match = re.search(r"\*\*Subagent\*\*: (.+)", batch_body)
                if subagent_match:
                    subagent_str = subagent_match.group(1)
                    # Parse toolset
                    toolset_match = re.search(r"Toolset: (\w+)", subagent_str)
                    if toolset_match:
                        batch.toolset = toolset_match.group(1)
                    # Parse scoped tools
                    scoped_match = re.search(r"Scoped tools: ([^|]+)", subagent_str)
                    if scoped_match:
                        batch.scoped_tools = [t.strip() for t in scoped_match.group(1).split(",") if t.strip()]
                    # Parse context from
                    context_from_match = re.search(r"Context from: ([^|]+)", subagent_str)
                    if context_from_match:
                        batch.context_from = [c.strip() for c in context_from_match.group(1).split(",") if c.strip()]
                    # Parse bundle
                    bundle_match = re.search(r"Bundle: ([^|]+)", subagent_str)
                    if bundle_match:
                        batch.context_bundle = bundle_match.group(1).strip()

                batches.append(batch)

        # Parse success criteria
        success_criteria: List[str] = []
        criteria_match = re.search(r"## Success Criteria\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if criteria_match:
            for line in criteria_match.group(1).split("\n"):
                step_match = re.match(r"- \[[ x]\] (.+)", line)
                if step_match:
                    success_criteria.append(step_match.group(1).strip())

        # Parse log
        log: List[TaskLogEntry] = []
        log_match = re.search(r"## Log\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if log_match:
            for line in log_match.group(1).split("\n"):
                entry_match = re.match(r"- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?): (.+)", line)
                if entry_match:
                    ts_str = entry_match.group(1)
                    if not ts_str.endswith("Z"):
                        ts_str += "Z"
                    try:
                        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    except ValueError:
                        ts = datetime.utcnow()
                    log.append(TaskLogEntry(timestamp=ts, event=entry_match.group(2).strip()))

        return cls(
            id=task_id,
            title=title,
            status=status,
            goal=goal,
            context=context,
            batches=batches,
            success_criteria=success_criteria,
            log=log,
            created_at=created_at,
            updated_at=updated_at,
        )
