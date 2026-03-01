"""
Database Explorer Delegate - Natural language database exploration subagent.

This delegate uses Gemini to plan and execute database queries based on
natural language prompts, then synthesizes results into a coherent answer.
"""

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from google import genai
from google.genai import types

logger = logging.getLogger("hester.daemon.tasks.db_explorer_delegate")


# System prompt for database query planning
DB_PLANNER_PROMPT = """You are a database exploration assistant. Given a natural language question about a database, plan which operations to execute to answer it.

Available operations:
- list_tables: List all tables (no args)
- describe_table: Get table structure (args: table_name, schema_name="public")
- list_functions: List database functions (args: schema_name="public", query="")
- list_rls_policies: Get RLS policies for a table (args: table_name, schema_name="public")
- list_constraints: Get constraints for a table (args: table_name, schema_name="public")
- execute_select: Run a SELECT query (args: query, limit=10)
- count_rows: Count rows in a table (args: table_name, schema_name="public", where_clause="")

IMPORTANT: Only plan operations that directly help answer the question. Be efficient.

Respond with a JSON array of operations to execute:
[
  {"operation": "list_tables", "args": {}},
  {"operation": "describe_table", "args": {"table_name": "profiles"}},
  {"operation": "execute_select", "args": {"query": "SELECT column FROM table", "limit": 10}}
]

Keep it minimal - 1-3 operations is usually enough.
"""

# System prompt for synthesizing results
DB_SYNTHESIZER_PROMPT = """You are a database exploration assistant. Based on the operations executed and their results, provide a clear, informative answer to the user's question.

Be concise but thorough. Include:
- Direct answer to the question
- Relevant details from the query results
- Any important observations

If the results don't fully answer the question, explain what was found and what might be missing.
"""


class DbExplorerDelegate:
    """
    Database exploration delegate using natural language prompts.

    Uses Gemini to:
    1. Plan which database operations to execute
    2. Execute the planned operations via db_tools
    3. Synthesize results into a natural language answer

    This allows asking questions like "What vector columns exist in the profiles table?"
    without knowing the exact SQL or tool calls needed.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "gemini-2.5-flash",
    ):
        """
        Initialize the database explorer delegate.

        Args:
            api_key: Google API key (defaults to GOOGLE_API_KEY env var)
            model: Gemini model to use
        """
        self.api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        if not self.api_key:
            raise ValueError("GOOGLE_API_KEY environment variable is required")

        self.model = model
        self._client = None

        logger.info(f"DbExplorerDelegate initialized with model={model}")

    @property
    def client(self) -> genai.Client:
        """Lazy load Gemini client."""
        if self._client is None:
            self._client = genai.Client(api_key=self.api_key)
        return self._client

    async def _plan_operations(self, prompt: str, context: str = "") -> List[Dict]:
        """
        Use Gemini to plan which database operations to execute.

        Args:
            prompt: The user's natural language question
            context: Additional context from previous batches

        Returns:
            List of operation dicts: [{"operation": str, "args": dict}]
        """
        import json

        planning_prompt = f"""Question: {prompt}

{f"Context: {context}" if context else ""}

Plan the database operations needed to answer this question."""

        response = self.client.models.generate_content(
            model=self.model,
            contents=planning_prompt,
            config=types.GenerateContentConfig(
                system_instruction=DB_PLANNER_PROMPT,
                temperature=0.1,  # Low temperature for consistent planning
            ),
        )

        # Parse JSON response
        text = response.text.strip()

        # Extract JSON from markdown code blocks if present
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].split("```")[0].strip()

        try:
            operations = json.loads(text)
            if not isinstance(operations, list):
                operations = [operations]
            return operations
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse operation plan: {e}")
            # Fallback to basic table listing
            return [{"operation": "list_tables", "args": {}}]

    async def _execute_operation(
        self,
        operation: str,
        args: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Execute a single database operation.

        Args:
            operation: Operation name (e.g., "describe_table")
            args: Operation arguments

        Returns:
            Operation result dict
        """
        from ..tools.db_tools import (
            list_tables,
            describe_table,
            list_functions,
            list_rls_policies,
            list_column_constraints,
            execute_select,
            count_rows,
        )
        from ..tools.base import ToolResult

        try:
            result = None
            if operation == "list_tables":
                result = await list_tables()
            elif operation == "describe_table":
                result = await describe_table(**args)
            elif operation == "list_functions":
                result = await list_functions(**args)
            elif operation == "list_rls_policies":
                result = await list_rls_policies(**args)
            elif operation == "list_constraints":
                result = await list_column_constraints(**args)
            elif operation == "execute_select":
                result = await execute_select(**args)
            elif operation == "count_rows":
                result = await count_rows(**args)
            else:
                return {"success": False, "error": f"Unknown operation: {operation}"}

            # Convert ToolResult to dict
            if isinstance(result, ToolResult):
                return result.model_dump()
            return result
        except Exception as e:
            logger.error(f"Operation {operation} failed: {e}")
            return {"success": False, "error": str(e)}

    async def _synthesize_results(
        self,
        prompt: str,
        operations: List[Dict],
        results: List[Dict],
    ) -> str:
        """
        Use Gemini to synthesize operation results into an answer.

        Args:
            prompt: Original user question
            operations: List of operations that were executed
            results: List of operation results

        Returns:
            Natural language answer
        """
        # Build context with operations and results
        context_parts = [f"Question: {prompt}\n\nOperations executed:"]

        for op, result in zip(operations, results):
            op_name = op.get("operation", "unknown")
            op_args = op.get("args", {})
            context_parts.append(f"\n## {op_name}({op_args})")

            if result.get("success", False):
                # Truncate very large results
                result_str = str(result.get("data", result))
                if len(result_str) > 3000:
                    result_str = result_str[:3000] + "... (truncated)"
                context_parts.append(f"Result: {result_str}")
            else:
                context_parts.append(f"Error: {result.get('error', 'Unknown error')}")

        synthesis_prompt = "\n".join(context_parts)

        response = self.client.models.generate_content(
            model=self.model,
            contents=synthesis_prompt,
            config=types.GenerateContentConfig(
                system_instruction=DB_SYNTHESIZER_PROMPT,
                temperature=0.3,
            ),
        )

        return response.text.strip()

    async def execute(
        self,
        prompt: str,
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a natural language database query.

        Args:
            prompt: Natural language question about the database
            context: Optional context from previous batches

        Returns:
            Dict with answer, operations executed, and success status
        """
        try:
            # Step 1: Plan operations
            operations = await self._plan_operations(prompt, context)
            logger.info(f"Planned {len(operations)} database operations")

            # Step 2: Execute operations
            results = []
            for op in operations:
                result = await self._execute_operation(
                    operation=op.get("operation", ""),
                    args=op.get("args", {}),
                )
                results.append(result)

            # Step 3: Synthesize answer
            answer = await self._synthesize_results(prompt, operations, results)

            return {
                "success": True,
                "answer": answer,
                "operations": operations,
                "operation_count": len(operations),
            }

        except Exception as e:
            logger.error(f"Database exploration failed: {e}")
            return {
                "success": False,
                "error": str(e),
                "answer": f"Failed to explore database: {e}",
                "operations": [],
            }

    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch using this delegate.

        This method is called by TaskExecutor for db_explorer batches.

        Args:
            batch: The batch to execute
            context: Context from previous batches

        Returns:
            Dict with success, output, and optional summary
        """
        from .models import TaskBatch

        # Execute the query
        result = await self.execute(
            prompt=batch.prompt,
            context=context,
        )

        # Format output
        output = self._format_output(result)
        summary = result.get("answer", "")[:500] if result.get("answer") else None

        return {
            "success": result.get("success", False),
            "output": output,
            "summary": summary,
        }

    def _format_output(self, result: Dict[str, Any]) -> str:
        """Format result as markdown output."""
        lines = ["# Database Exploration Results\n"]

        if not result.get("success"):
            lines.append(f"**Error:** {result.get('error', 'Unknown error')}")
            return "\n".join(lines)

        lines.append("## Answer\n")
        lines.append(result.get("answer", "No answer generated"))
        lines.append("\n## Operations Executed\n")

        for op in result.get("operations", []):
            op_name = op.get("operation", "unknown")
            op_args = op.get("args", {})
            if op_args:
                args_str = ", ".join(f"{k}={v!r}" for k, v in op_args.items())
                lines.append(f"- `{op_name}({args_str})`")
            else:
                lines.append(f"- `{op_name}()`")

        return "\n".join(lines)
