"""
Code Explorer Delegate - Scoped codebase exploration subagent.

This delegate runs a headless ReAct loop with tool scoping for batch execution.
It is designed to be used as a subagent and cannot orchestrate tasks or spawn other agents.
"""

import logging
import os
from functools import partial
from pathlib import Path
from typing import Any, Dict, List, Optional

from rich.console import Console

from ..tools.scoping import get_allowed_tools, ForbiddenToolError
from ..tools import (
    get_available_tools,
    ToolDefinition,
    read_file,
    search_files,
    search_content,
    list_directory,
    change_directory,
    extract_doc_claims,
    validate_claim,
    find_doc_drift,
    semantic_doc_search,
    write_markdown,
    update_markdown,
    web_search,
    db_list_tables,
    db_describe_table,
    db_list_functions,
    db_list_rls_policies,
    db_list_constraints,
    db_execute_select,
    db_count_rows,
    summarize_text,
    get_context_bundle,
    list_context_bundles,
)
from ...shared.gemini_tools import GeminiToolCapability

logger = logging.getLogger("hester.daemon.tasks.code_explorer_delegate")
console = Console()


# System prompt for code explorer - emphasizes scoped execution
CODE_EXPLORER_SYSTEM_PROMPT = """You are a Code Explorer, a focused codebase exploration assistant.

You are running as a SUBAGENT with LIMITED TOOLS. You cannot:
- Create or manage tasks
- Add batches or context to tasks
- Spawn other agents or delegates
- Orchestrate complex workflows

Your job is to ANSWER THE QUERY using the tools available to you, then provide a clear response.

## Available Tools
{tools_description}

## Working Directory
{working_dir}

## Instructions
1. Think about what information you need
2. Use tools to gather that information
3. Provide a clear, focused answer

Be concise and factual. If you cannot answer with the available tools, say so.
"""


class CodeExplorerDelegate(GeminiToolCapability):
    """
    Delegate for executing scoped code_explorer batches.

    Runs a standalone ReAct loop with tool filtering and hard enforcement
    of forbidden tools. Cannot orchestrate tasks or spawn other agents.
    """

    def __init__(
        self,
        working_dir: Path,
        toolset: str = "observe",
        scoped_tools: Optional[List[str]] = None,
        max_steps: int = 10,
        quiet: bool = False,
        api_key: Optional[str] = None,
        model: str = "gemini-2.5-flash",
    ):
        """
        Initialize the delegate.

        Args:
            working_dir: Working directory for file operations
            toolset: Tool scope level ("observe", "research", "develop", "full")
            scoped_tools: Explicit list of tools (overrides toolset)
            max_steps: Maximum ReAct iterations
            quiet: Suppress progress output
            api_key: Google API key (defaults to GOOGLE_API_KEY env var)
            model: Gemini model to use
        """
        # Get API key
        api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY environment variable is required")

        # Initialize Gemini capability
        super().__init__(api_key=api_key, model=model)

        self.working_dir = Path(working_dir)
        self.toolset = toolset
        self.max_steps = max_steps
        self.quiet = quiet

        # Get base tools for subagent environment (excludes orchestration tools)
        subagent_tools = {t.name for t in get_available_tools("subagent")}

        # Get toolset-specific tools (observe/research/develop/full)
        toolset_tools = set(get_allowed_tools(
            toolset=toolset,
            is_subagent=False,  # Don't double-filter, we handle it via environment
            scoped_tools=scoped_tools,
        ))

        # Intersect: only tools in both subagent environment AND toolset
        self.allowed_tools = list(subagent_tools & toolset_tools)

        # Register filtered tools
        self._register_filtered_tools()
        self._create_tool_handlers()

        logger.info(
            f"CodeExplorerDelegate initialized: toolset={toolset}, "
            f"allowed_tools={len(self.allowed_tools)}, max_steps={max_steps}"
        )

    def _register_filtered_tools(self) -> None:
        """Register only the allowed tools with Gemini."""
        # Get all subagent-available tools, then filter to allowed set
        subagent_tools = get_available_tools("subagent")
        tools = []
        for tool in subagent_tools:
            if tool.name in self.allowed_tools:
                tools.append({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                })

        self._tool_definitions = tools
        logger.debug(f"Registered {len(tools)} filtered tools")

    def _create_tool_handlers(self) -> None:
        """Create tool handlers bound to working directory."""
        working_dir = str(self.working_dir)

        # Base handlers - all read-only tools
        handlers = {
            # File tools
            "read_file": partial(read_file, working_dir=working_dir),
            "search_files": partial(search_files, working_dir=working_dir),
            "search_content": partial(search_content, working_dir=working_dir),
            "list_directory": partial(list_directory, working_dir=working_dir),
            "change_directory": partial(change_directory, working_dir=working_dir),
            # Documentation tools
            "extract_doc_claims": partial(extract_doc_claims, working_dir=working_dir),
            "validate_claim": partial(validate_claim, working_dir=working_dir),
            "find_doc_drift": partial(find_doc_drift, working_dir=working_dir),
            "semantic_doc_search": partial(semantic_doc_search, working_dir=working_dir),
            "write_markdown": partial(write_markdown, working_dir=working_dir),
            "update_markdown": partial(update_markdown, working_dir=working_dir),
            # Web search
            "web_search": web_search,
            # Summarize
            "summarize": summarize_text,
            # Database tools
            "db_list_tables": db_list_tables,
            "db_describe_table": db_describe_table,
            "db_list_functions": db_list_functions,
            "db_list_rls_policies": db_list_rls_policies,
            "db_list_constraints": db_list_constraints,
            "db_execute_select": db_execute_select,
            "db_count_rows": db_count_rows,
            # Context bundles (read-only)
            "get_context_bundle": partial(get_context_bundle, working_dir=working_dir),
            "list_context_bundles": partial(list_context_bundles, working_dir=working_dir),
        }

        # Filter to only allowed tools
        self._tool_handlers = {
            name: handler
            for name, handler in handlers.items()
            if name in self.allowed_tools
        }

        logger.debug(f"Created {len(self._tool_handlers)} tool handlers")

    def _build_tools_description(self) -> str:
        """Build description of available tools for system prompt."""
        subagent_tools = get_available_tools("subagent")
        lines = []
        for tool in subagent_tools:
            if tool.name in self.allowed_tools:
                lines.append(f"- **{tool.name}**: {tool.description.split('.')[0]}")
        return "\n".join(lines)

    async def execute(
        self,
        prompt: str,
        context: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute a query using the scoped ReAct loop.

        Args:
            prompt: The query to execute
            context: Optional context to include (from bundle or previous batch)

        Returns:
            Dict with response, findings, success status
        """
        # Build system prompt
        tools_desc = self._build_tools_description()
        system_prompt = CODE_EXPLORER_SYSTEM_PROMPT.format(
            tools_description=tools_desc,
            working_dir=str(self.working_dir),
        )

        # Add context if provided
        if context:
            system_prompt += f"\n\n## Context\n{context}"

        # Build messages
        messages = [{"role": "user", "content": prompt}]

        if not self.quiet:
            console.print(f"[dim]Starting ReAct loop (max {self.max_steps} steps)...[/dim]")

        try:
            # Run ReAct loop with tool filtering
            result = await self.generate_with_tools(
                system_prompt=system_prompt,
                messages=messages,
                max_iterations=self.max_steps,
                tool_filter=self.allowed_tools,  # Enforce tool filter
            )

            # Extract response and findings
            response = result.get("text", "")
            tool_calls = result.get("tool_calls", [])

            # Extract key findings from tool results
            findings = []
            for tc in tool_calls:
                if tc.success and tc.result:
                    # Summarize tool results as findings
                    result_str = str(tc.result)
                    if len(result_str) > 100:
                        result_str = result_str[:100] + "..."
                    findings.append(f"{tc.tool_name}: {result_str}")

            return {
                "success": True,
                "response": response,
                "findings": findings,
                "tool_calls": len(tool_calls),
                "iterations": result.get("iterations", 0),
            }

        except ForbiddenToolError as e:
            # Hard enforcement - subagent tried to use forbidden tool
            logger.error(f"Subagent attempted forbidden tool: {e.tool_name}")
            return {
                "success": False,
                "error": str(e),
                "response": f"Error: {e}",
                "findings": [],
            }
        except Exception as e:
            logger.error(f"Subagent execution failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "response": f"Execution failed: {e}",
                "findings": [],
            }

    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch using this delegate.

        This method is called by TaskExecutor for code_explorer batches.

        Args:
            batch: The batch to execute
            context: Context from previous batches

        Returns:
            Dict with success, output, and optional summary
        """
        from .models import TaskBatch

        # Use batch's toolset/scoped_tools if specified
        if batch.toolset and batch.toolset != self.toolset:
            self.toolset = batch.toolset

            # Get base tools for subagent environment
            subagent_tools = {t.name for t in get_available_tools("subagent")}

            # Get toolset-specific tools
            toolset_tools = set(get_allowed_tools(
                toolset=batch.toolset,
                is_subagent=False,
                scoped_tools=batch.scoped_tools if batch.scoped_tools else None,
            ))

            # Intersect
            self.allowed_tools = list(subagent_tools & toolset_tools)
            self._register_filtered_tools()
            self._create_tool_handlers()

        # Execute the query
        result = await self.execute(
            prompt=batch.prompt,
            context=context,
        )

        # Format output for batch
        output = result.get("response", "")
        if result.get("findings"):
            output += "\n\nFindings:\n"
            for finding in result["findings"]:
                output += f"- {finding}\n"

        return {
            "success": result.get("success", False),
            "output": output,
            "summary": result.get("response", "")[:500] if result.get("response") else None,
        }
