"""
Cockpit tool definitions: tasks (read-only), Lee tabs and operations.

No tool here can type into a terminal, confirm/link/close tasks, approve
proposals or launch agents (C3).
"""

from .models import ToolDefinition

# Need Lee on this machine: not available in slack
_COCKPIT_ENVIRONMENTS = {"daemon", "cli", "subagent"}


COCKPIT_TASKS_TOOL = ToolDefinition(
    name="cockpit_tasks",
    description="""List the Cockpit's tasks for this workspace (read-only): title, status, lead,
busy time, turns, files touched, the agent's latest summary and its terminal (pty_id).
You cannot confirm, link, close or promote tasks; those are the user's decisions.""",
    parameters={
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["open", "closed", "all"], "description": "Which tasks (default open)"},
            "limit": {"type": "integer", "description": "Max tasks (default 20, max 100)"},
        },
    },
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_TABS_TOOL = ToolDefinition(
    name="lee_tabs",
    description="""List Lee's tabs in this workspace with their state (idle-at-prompt, busy,
awaiting-input), kind (agent, shell, tui), linked task or operation and pty_id.""",
    parameters={"type": "object", "properties": {}},
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_TAB_READ_TOOL = ToolDefinition(
    name="lee_tab_read",
    description="""Read the last lines of a Lee terminal tab's output (ANSI stripped). The user sees
a note in the Cockpit feed that you read it. Use lee_tabs first to find the pty_id.""",
    parameters={
        "type": "object",
        "properties": {
            "pty_id": {"type": "integer", "description": "The tab's pty_id from lee_tabs"},
            "lines": {"type": "integer", "description": "How many lines (default 50, max 200)"},
        },
        "required": ["pty_id"],
    },
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_TAB_CHECKIN_TOOL = ToolDefinition(
    name="lee_tab_checkin",
    description="""Propose a check-in on an agent tab (asks the agent for a status report). This
never types anything: it adds a proposal to the Cockpit feed that runs only when the user clicks it.""",
    parameters={
        "type": "object",
        "properties": {"pty_id": {"type": "integer", "description": "The agent tab's pty_id"}},
        "required": ["pty_id"],
    },
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_OPERATIONS_TOOL = ToolDefinition(
    name="lee_operations",
    description="""List this workspace's operations (defined build/test/dev/deploy commands) with
status, last result, duration and readings, plus pending suggestions and proposals.""",
    parameters={"type": "object", "properties": {}},
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_OPERATION_RUN_TOOL = ToolDefinition(
    name="lee_operation_run",
    description="""Run a defined operation by name (e.g. 'electron:build') when the user asks.
Lee runs defined, confirmed operations directly; operations marked confirm (deploy, flash...)
become a proposal the user approves in the Cockpit. Tell the user when approval is needed.""",
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Operation name from lee_operations"},
            "params": {"type": "object", "description": "Values for the operation's parameters, if it has any"},
        },
        "required": ["name"],
    },
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_OPERATION_PROPOSE_TOOL = ToolDefinition(
    name="lee_operation_propose",
    description="""Propose an ad-hoc shell command. It is shown to the user exactly as written and
runs in a new terminal tab only if they approve it in the Cockpit feed.""",
    parameters={
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The exact command line"},
            "cwd": {"type": "string", "description": "Directory to run in (default: workspace root)"},
            "reason": {"type": "string", "description": "One line on why"},
        },
        "required": ["command"],
    },
    environments=_COCKPIT_ENVIRONMENTS,
)

LEE_OPERATION_RESULT_TOOL = ToolDefinition(
    name="lee_operation_result",
    description="""Get an operation run's result (passed/failed, exit code, duration, readings and
a log tail). Use it to answer "did it pass?" or to suggest a task for a failure.""",
    parameters={
        "type": "object",
        "properties": {"run_id": {"type": "string", "description": "The run id"}},
        "required": ["run_id"],
    },
    environments=_COCKPIT_ENVIRONMENTS,
)

COCKPIT_TOOLS = [
    COCKPIT_TASKS_TOOL,
    LEE_TABS_TOOL,
    LEE_TAB_READ_TOOL,
    LEE_TAB_CHECKIN_TOOL,
    LEE_OPERATIONS_TOOL,
    LEE_OPERATION_RUN_TOOL,
    LEE_OPERATION_PROPOSE_TOOL,
    LEE_OPERATION_RESULT_TOOL,
]
