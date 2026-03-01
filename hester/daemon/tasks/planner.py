"""
Task Planner - Context gathering and batch planning.
"""

import logging
from typing import Any, Dict, List, Optional

from .models import Task, TaskBatch, BatchDelegate, TaskStatus
from .store import TaskStore

logger = logging.getLogger("hester.daemon.tasks.planner")


class TaskPlanner:
    """
    Orchestrates context gathering and batch planning for tasks.

    The planner helps Hester gather relevant context using available tools
    and then structures that into actionable batches for delegation.
    """

    def __init__(self, store: TaskStore, tool_handlers: Dict[str, Any]):
        """
        Initialize the task planner.

        Args:
            store: TaskStore for persistence
            tool_handlers: Dict mapping tool names to handler functions
        """
        self.store = store
        self.tool_handlers = tool_handlers

    async def gather_context(
        self,
        task: Task,
        search_patterns: Optional[List[str]] = None,
        web_queries: Optional[List[str]] = None,
    ) -> Task:
        """
        Gather context for a task using available tools.

        Args:
            task: The task to gather context for
            search_patterns: Glob patterns to search for relevant files
            web_queries: Web search queries for external context

        Returns:
            Updated task with context
        """
        logger.info(f"Gathering context for task: {task.id}")

        # Search for relevant files
        if search_patterns and "search_files" in self.tool_handlers:
            for pattern in search_patterns:
                try:
                    result = await self.tool_handlers["search_files"](pattern=pattern)
                    if result.get("files"):
                        task.context.files.extend(result["files"][:10])  # Limit files
                        logger.debug(f"Found {len(result['files'])} files for pattern: {pattern}")
                except Exception as e:
                    logger.error(f"Error searching files with pattern {pattern}: {e}")

        # Web search for external context
        if web_queries and "web_search" in self.tool_handlers:
            for query in web_queries:
                try:
                    result = await self.tool_handlers["web_search"](query=query)
                    if result.get("content"):
                        # Store a summary of the web research
                        summary = result["content"][:500]  # Truncate for storage
                        task.context.web_research.append(f"{query}: {summary}")
                        logger.debug(f"Web search complete for: {query}")
                except Exception as e:
                    logger.error(f"Error with web search '{query}': {e}")

        # Deduplicate files
        task.context.files = list(dict.fromkeys(task.context.files))

        task.add_log("Context gathering complete")
        self.store.save(task)

        return task

    async def analyze_codebase(
        self,
        task: Task,
        file_paths: Optional[List[str]] = None,
    ) -> Task:
        """
        Analyze relevant code files to understand the codebase.

        Args:
            task: The task to analyze for
            file_paths: Specific files to analyze (or uses task.context.files)

        Returns:
            Updated task with codebase notes
        """
        files_to_analyze = file_paths or task.context.files[:5]  # Limit to 5 files

        if not files_to_analyze:
            logger.debug("No files to analyze for codebase context")
            return task

        if "read_file" not in self.tool_handlers:
            logger.warning("read_file tool not available for codebase analysis")
            return task

        notes = []
        for file_path in files_to_analyze:
            try:
                result = await self.tool_handlers["read_file"](file_path=file_path)
                if result.get("content"):
                    # Extract key observations
                    content = result["content"]
                    lines = content.split("\n")

                    # Look for imports, class definitions, function definitions
                    imports = [l for l in lines[:50] if l.strip().startswith(("import ", "from "))]
                    classes = [l for l in lines if l.strip().startswith("class ")]
                    functions = [l for l in lines if l.strip().startswith("def ") or l.strip().startswith("async def ")]

                    if imports or classes or functions:
                        note = f"**{file_path}**:\n"
                        if imports:
                            note += f"  - Imports: {', '.join(imports[:5])}\n"
                        if classes:
                            note += f"  - Classes: {len(classes)}\n"
                        if functions:
                            note += f"  - Functions: {len(functions)}\n"
                        notes.append(note)

            except Exception as e:
                logger.error(f"Error reading file {file_path}: {e}")

        if notes:
            task.context.codebase_notes = "\n".join(notes)
            task.add_log("Codebase analysis complete")
            self.store.save(task)

        return task

    def suggest_batches(
        self,
        task: Task,
        implementation_type: str = "feature",
    ) -> List[Dict[str, Any]]:
        """
        Suggest batch structure based on task goal and context.

        Args:
            task: The task to suggest batches for
            implementation_type: Type of work (feature, bugfix, refactor, test)

        Returns:
            List of suggested batch definitions
        """
        batches = []

        if implementation_type == "feature":
            # Standard feature implementation pattern
            batches = [
                {
                    "title": "Implement core functionality",
                    "delegate": "claude_code",
                    "prompt": f"Implement: {task.goal}\n\nContext:\n{task.context.codebase_notes}",
                    "steps": ["Create/modify necessary files", "Add implementation code"],
                },
                {
                    "title": "Add tests",
                    "delegate": "claude_code",
                    "prompt": f"Add tests for: {task.goal}",
                    "steps": ["Create test file", "Add unit tests", "Add integration tests if needed"],
                },
                {
                    "title": "Validate implementation",
                    "delegate": "validator",
                    "action": "validate",
                    "steps": ["Run tests", "Check for lint errors"],
                },
            ]

        elif implementation_type == "bugfix":
            batches = [
                {
                    "title": "Investigate and fix bug",
                    "delegate": "claude_code",
                    "prompt": f"Debug and fix: {task.goal}\n\nContext:\n{task.context.codebase_notes}",
                    "steps": ["Identify root cause", "Implement fix", "Add regression test"],
                },
                {
                    "title": "Verify fix",
                    "delegate": "validator",
                    "action": "validate",
                    "steps": ["Run tests", "Verify bug is fixed"],
                },
            ]

        elif implementation_type == "refactor":
            batches = [
                {
                    "title": "Refactor code",
                    "delegate": "claude_code",
                    "prompt": f"Refactor: {task.goal}\n\nContext:\n{task.context.codebase_notes}",
                    "steps": ["Identify code to refactor", "Apply refactoring", "Update affected code"],
                },
                {
                    "title": "Validate refactoring",
                    "delegate": "validator",
                    "action": "validate",
                    "steps": ["Run tests", "Check no regressions"],
                },
            ]

        elif implementation_type == "test":
            batches = [
                {
                    "title": "Write tests",
                    "delegate": "claude_code",
                    "prompt": f"Write tests for: {task.goal}\n\nContext:\n{task.context.codebase_notes}",
                    "steps": ["Analyze code to test", "Write unit tests", "Write integration tests"],
                },
                {
                    "title": "Run and verify tests",
                    "delegate": "validator",
                    "action": "validate",
                    "steps": ["Run test suite", "Check coverage"],
                },
            ]

        return batches

    async def prepare_for_execution(self, task: Task) -> Task:
        """
        Prepare a task for execution by validating it's ready.

        Args:
            task: The task to prepare

        Returns:
            Updated task

        Raises:
            ValueError: If task is not ready for execution
        """
        if not task.batches:
            raise ValueError("Task has no batches defined")

        if not task.goal:
            raise ValueError("Task has no goal defined")

        # Validate each batch has required fields
        for i, batch in enumerate(task.batches):
            if batch.delegate == BatchDelegate.CLAUDE_CODE and not batch.prompt:
                raise ValueError(f"Batch {i+1} ({batch.title}) is missing prompt for Claude Code")

        # Mark task as ready
        task.status = TaskStatus.READY
        task.add_log("Task prepared for execution")
        self.store.save(task)

        return task
