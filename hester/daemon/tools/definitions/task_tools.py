"""
Task management tool definitions - create, update, batch, execute tasks.
"""

from .models import ToolDefinition


CREATE_TASK_TOOL = ToolDefinition(
    name="create_task",
    description="""Create a new task for complex work that requires planning and delegation.
Use this when you detect a request that requires multiple steps, code changes, or research.

A task goes through phases:
1. PLANNING: Gather context (files, web research, codebase understanding)
2. READY: Batches defined, user approves execution
3. EXECUTING: Batches delegated to Claude Code or Hester tools
4. COMPLETED/FAILED: Final status

The task_id should be a hyphenated 2-3 word summary of the task.

Examples:
- create_task(task_id="add-jwt-auth", title="Implement user authentication", goal="Add JWT auth to the API")
- create_task(task_id="fix-memory-leak", title="Fix memory leak in processor", goal="Find and fix the memory leak causing OOM")
- create_task(task_id="update-deploy-docs", title="Update deployment docs", goal="Update docs/Deploy.md with current CI/CD setup")
- create_task(task_id="refactor-api-routes", title="Refactor API routes", goal="Consolidate duplicate route handlers")""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "Hyphenated 2-3 word ID for the task (e.g., 'update-deploy-docs', 'fix-auth-bug', 'add-user-search')",
            },
            "title": {
                "type": "string",
                "description": "Short, descriptive title for the task",
            },
            "goal": {
                "type": "string",
                "description": "What the user wants to accomplish",
            },
        },
        "required": ["task_id", "title"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

GET_TASK_TOOL = ToolDefinition(
    name="get_task",
    description="""Get details of an existing task.

Examples:
- get_task(task_id="update-deploy-docs")
- get_task(task_id="fix-auth-bug")""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to retrieve",
            },
        },
        "required": ["task_id"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

UPDATE_TASK_TOOL = ToolDefinition(
    name="update_task",
    description="""Update a task with new information during planning.
Use this to add context, batches, or success criteria to a task.

Examples:
- update_task(task_id="add-jwt-auth", goal="Updated goal description")
- update_task(task_id="fix-memory-leak", context={"files": ["src/auth.py"], "codebase_notes": "Uses FastAPI"})
- update_task(task_id="update-deploy-docs", success_criteria=["Tests pass", "Login works"])""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to update",
            },
            "goal": {
                "type": "string",
                "description": "Updated goal description",
            },
            "context": {
                "type": "object",
                "description": "Context updates: {files: [...], web_research: [...], codebase_notes: '...'}",
            },
            "batches": {
                "type": "array",
                "description": "List of batch definitions",
                "items": {"type": "object"},
            },
            "success_criteria": {
                "type": "array",
                "description": "List of success criteria",
                "items": {"type": "string"},
            },
            "status": {
                "type": "string",
                "description": "New status (planning, ready, executing, completed, failed)",
            },
        },
        "required": ["task_id"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

LIST_TASKS_TOOL = ToolDefinition(
    name="list_tasks",
    description="""List all tasks, optionally filtered by status.

Examples:
- list_tasks() - list all tasks
- list_tasks(status="planning") - list tasks in planning
- list_tasks(status="ready") - list tasks ready to execute""",
    parameters={
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "description": "Filter by status (planning, ready, executing, completed, failed)",
            },
        },
        "required": [],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

ADD_BATCH_TOOL = ToolDefinition(
    name="add_batch",
    description="""Add a work batch to a task.
A batch is a unit of work delegated to various handlers.

DELEGATE SELECTION GUIDE:

1. code_explorer - USE FOR ALL CODEBASE RESEARCH/EXPLORATION
   - Searching/reading codebase files
   - Finding patterns, usages, or implementations
   - Understanding how code works
   - Database schema exploration
   - REQUIRES: prompt (the research question)
   - OPTIONAL: toolset (observe|research|develop), steps

2. web_researcher - USE FOR WEB RESEARCH
   - External best practices
   - Documentation lookups
   - Technology comparisons
   - REQUIRES: prompt (the research question)

3. claude_code - USE FOR CODE IMPLEMENTATION
   - Writing new code
   - Modifying existing files
   - Refactoring
   - REQUIRES: prompt (implementation instructions)
   - OPTIONAL: steps, context_from

4. validator - USE FOR VALIDATION/TESTING
   - Running test suites
   - Linting/type checking
   - REQUIRES: action (validate|test)

5. manual - USE ONLY FOR HUMAN-REQUIRED TASKS
   - Physical actions (deploy buttons, approvals)
   - Tasks requiring credentials you don't have
   - External system interactions without API
   - NEVER use for research - use code_explorer instead
   - NEVER use for implementation - use claude_code instead

6. docs_manager - USE FOR DOCUMENTATION MANAGEMENT
   - Semantic search over docs (action="search")
   - Check docs for drift against code (action="check")
   - Extract verifiable claims from docs (action="claims")
   - Index docs for search (action="index")
   - Get index status (action="status")
   - Create new markdown file (action="write")
   - Update existing markdown file (action="update")
   - REQUIRES: params with action + (query OR doc_path) + (content for write/update)
   - OPTIONAL: params.limit, params.threshold, params.section, params.append

7. db_explorer - USE FOR DATABASE EXPLORATION
   - Natural language database queries
   - Schema exploration and analysis
   - Data pattern analysis
   - REQUIRES: prompt (the analysis question)

8. test_runner - USE FOR RUNNING TESTS
   - Execute test suites (pytest, flutter, jest)
   - Get structured test results with pass/fail counts
   - REQUIRES: params with path, framework (optional), args (optional)

IMPORTANT: If a batch involves searching/reading/understanding code,
use delegate="code_explorer", NOT "manual". The code_explorer will
automatically execute the research using available tools.

For code_explorer batches, use toolset to control scope:
- observe: Read-only codebase access (default)
- research: Observe + web search, docs, database queries
- develop: Observe + file writing suggestions

Use context_from to chain context from previous batches.

Examples:
- add_batch(task_id="add-jwt-auth", title="Implement login", delegate="claude_code",
    prompt="Create login endpoint at POST /auth/login with email/password",
    steps=["Create route", "Add validation", "Return JWT"])
- add_batch(task_id="fix-memory-leak", title="Run tests", delegate="validator",
    action="validate", steps=["Run pytest", "Check coverage"])
- add_batch(task_id="add-vector-search", title="Research patterns", delegate="code_explorer",
    prompt="Find existing vector search patterns in the matching service", toolset="observe")
- add_batch(task_id="scroll-feature", title="Research scroll APIs", delegate="code_explorer",
    prompt="Find scrolling mechanisms and keyboard shortcut handling in the PTY manager",
    toolset="observe", steps=["Find terminal components", "Locate scroll APIs", "Check keybindings"])
- add_batch(task_id="add-vector-search", title="Research best practices", delegate="web_researcher",
    prompt="What are best practices for pgvector similarity search at scale?")
- add_batch(task_id="add-vector-search", title="Implement", delegate="claude_code",
    prompt="Add semantic matching using pgvector", context_from=["batch-1", "batch-2"])""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to add batch to",
            },
            "title": {
                "type": "string",
                "description": "Batch title",
            },
            "delegate": {
                "type": "string",
                "enum": ["claude_code", "validator", "code_explorer", "web_researcher", "manual", "docs_manager", "db_explorer", "test_runner"],
                "description": "Who handles the batch: code_explorer for codebase research, web_researcher for web research, claude_code for implementation, validator for testing, docs_manager for documentation, db_explorer for database analysis, test_runner for running tests, manual ONLY for human-required tasks",
            },
            "prompt": {
                "type": "string",
                "description": "For claude_code/code_explorer/web_researcher: the prompt to send",
            },
            "action": {
                "type": "string",
                "description": "For validator: the action (validate, test)",
            },
            "steps": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Step descriptions for this batch",
            },
            "toolset": {
                "type": "string",
                "enum": ["observe", "research", "develop"],
                "description": "For code_explorer: tool scope level (default: observe)",
            },
            "scoped_tools": {
                "type": "array",
                "items": {"type": "string"},
                "description": "For code_explorer: explicit tool list (overrides toolset)",
            },
            "context_from": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Batch IDs to pull context from (for chaining)",
            },
            "context_bundle": {
                "type": "string",
                "description": "Path to context bundle file to include",
            },
        },
        "required": ["task_id", "title"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

ADD_CONTEXT_TOOL = ToolDefinition(
    name="add_context",
    description="""Add context to a task during planning.
Use this to record relevant files, web research, or codebase understanding.

Examples:
- add_context(task_id="add-jwt-auth", files=["src/auth.py", "src/models/user.py"])
- add_context(task_id="fix-memory-leak", web_research=["Memory profiling techniques"])
- add_context(task_id="update-deploy-docs", codebase_notes="Uses GitHub Actions with Cloud Build")""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to add context to",
            },
            "files": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Relevant file paths",
            },
            "web_research": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Web research findings",
            },
            "codebase_notes": {
                "type": "string",
                "description": "Notes about the codebase",
            },
        },
        "required": ["task_id"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

MARK_TASK_READY_TOOL = ToolDefinition(
    name="mark_task_ready",
    description="""Mark a task as ready for execution after planning is complete.
The task must have at least one batch defined.

Examples:
- mark_task_ready(task_id="update-deploy-docs")
- mark_task_ready(task_id="fix-auth-bug")""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to mark as ready",
            },
        },
        "required": ["task_id"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)

DELETE_TASK_TOOL = ToolDefinition(
    name="delete_task",
    description="""Delete a task and its file.

Examples:
- delete_task(task_id="update-deploy-docs")
- delete_task(task_id="abandoned-feature")""",
    parameters={
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to delete",
            },
        },
        "required": ["task_id"],
    },
    environments={"daemon", "cli"},  # Not available in slack or subagent
)


# All task management tools
TASK_TOOLS = [
    CREATE_TASK_TOOL,
    GET_TASK_TOOL,
    UPDATE_TASK_TOOL,
    LIST_TASKS_TOOL,
    ADD_BATCH_TOOL,
    ADD_CONTEXT_TOOL,
    MARK_TASK_READY_TOOL,
    DELETE_TASK_TOOL,
]
