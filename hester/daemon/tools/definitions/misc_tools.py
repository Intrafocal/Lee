"""
Miscellaneous tool definitions - web search, summarize, UI control, status message.
"""

from .models import ToolDefinition


WEB_SEARCH_TOOL = ToolDefinition(
    name="web_search",
    description="""Search the web for current information using Google Search.
Use this for questions about recent events, current prices, news, sports results,
or anything that requires up-to-date information beyond the training data.

Returns search results with source citations.

Examples:
- web_search(query="Who won the latest Super Bowl?")
- web_search(query="Current Bitcoin price USD")
- web_search(query="Latest news about OpenAI")
- web_search(query="Weather in San Francisco today")""",
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query - be specific for best results",
            },
        },
        "required": ["query"],
    },
)

SUMMARIZE_TOOL = ToolDefinition(
    name="summarize",
    description="""Summarize long text into a concise summary using AI.
Use this to condense verbose output, logs, documentation, or general content.

Dev Styles:
- "concise": Single sentence summary (default)
- "bullet": 2-3 bullet points
- "technical": Technical summary focusing on actions and outcomes

Copywriting Styles:
- "tldr": Single sentence essence, max 50 words
- "executive": 2-3 sentence executive summary, lead with conclusion
- "headline": Single punchy headline, max 10 words
- "abstract": Academic-style abstract, 100-150 words

Examples:
- summarize(text="Long output from command...", max_length=200)
- summarize(text="Verbose logs...", style="bullet")
- summarize(text="Long article...", style="tldr")
- summarize(text="Report...", style="executive")
- summarize(text="Blog post...", style="headline")""",
    parameters={
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "The text to summarize",
            },
            "max_length": {
                "type": "integer",
                "description": "Target maximum length in characters (default: 200). Applies mainly to concise/technical styles.",
            },
            "style": {
                "type": "string",
                "enum": ["concise", "bullet", "technical", "tldr", "executive", "headline", "abstract"],
                "description": "Summary style (default: concise)",
            },
            "context": {
                "type": "string",
                "description": "Optional context about what the text is",
            },
        },
        "required": ["text"],
    },
)

UI_CONTROL_TOOL = ToolDefinition(
    name="ui_control",
    description="""Control the Lee IDE interface.
Use this to interact with tabs, the editor, and TUI applications.

Available actions:
- Create terminal tab: ui_control(command_type="system", action="new_tab", params={"tab_type": "terminal"})
- Open file: ui_control(command_type="editor", action="open_file", params={"path": "/path/to/file.py"})
- Open file at line: ui_control(command_type="editor", action="open_file", params={"path": "/path/to/file.py", "line": 42})
- Focus tab: ui_control(command_type="system", action="focus_tab", params={"tab_id": 1})
- Close tab: ui_control(command_type="system", action="close_tab", params={"tab_id": 2})
- Open lazygit: ui_control(command_type="tui", action="open", params={"tui": "git"})
- Open lazydocker: ui_control(command_type="tui", action="open", params={"tui": "docker"})
- Open k9s: ui_control(command_type="tui", action="open", params={"tui": "k8s"})
- Open flx: ui_control(command_type="tui", action="open", params={"tui": "flutter"})
- Open custom TUI: ui_control(command_type="tui", action="open", params={"tui": "custom", "command": "htop", "label": "System"})

Note: Only works when Hester is running inside Lee IDE (port 9001).""",
    parameters={
        "type": "object",
        "properties": {
            "command_type": {
                "type": "string",
                "enum": ["system", "editor", "tui"],
                "description": "Type: 'system' for tabs, 'editor' for file ops, 'tui' for TUI apps",
            },
            "action": {
                "type": "string",
                "description": "Action to perform (new_tab, open_file, focus_tab, close_tab, open)",
            },
            "params": {
                "type": "object",
                "description": "Additional parameters for the action",
            },
        },
        "required": ["command_type", "action"],
    },
    environments={"daemon"},  # Lee only
)

STATUS_MESSAGE_TOOL = ToolDefinition(
    name="status_message",
    description="""Push hints or notifications to Lee's status bar.
Use this to proactively suggest actions or notify the user about something.

When the user clicks the message or presses Cmd+/, the prompt (if provided)
is automatically sent to Hester. This enables contextual suggestions like
"Commit these changes?" that trigger immediate action.

Actions:
- push: Add a message to the status bar queue
- clear: Remove a specific message by ID
- clear_all: Remove all messages from the queue

Message types:
- hint: Suggestion or question (default)
- info: Informational message
- success: Success confirmation
- warning: Warning or attention needed

Examples:
- Push a commit suggestion:
  status_message(action="push", message="Commit these changes?",
                 type="hint", prompt="commit the staged changes", ttl=15)
- Push success notification:
  status_message(action="push", message="Tests passed!", type="success", ttl=5)
- Push warning:
  status_message(action="push", message="Uncommitted changes", type="warning")
- Clear all messages:
  status_message(action="clear_all")""",
    parameters={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["push", "clear", "clear_all"],
                "description": "Action: 'push' to add message, 'clear' to remove by ID, 'clear_all' to remove all",
            },
            "message": {
                "type": "string",
                "description": "Message text to display (required for 'push')",
            },
            "type": {
                "type": "string",
                "enum": ["hint", "info", "success", "warning"],
                "description": "Message type - affects icon/color (default: 'hint')",
            },
            "prompt": {
                "type": "string",
                "description": "Prompt to auto-send when clicked or Cmd+/ pressed",
            },
            "ttl": {
                "type": "integer",
                "description": "Time-to-live in seconds (auto-dismiss after)",
            },
            "id": {
                "type": "string",
                "description": "Message ID (auto-generated if not provided; required for 'clear')",
            },
        },
        "required": ["action"],
    },
    environments={"daemon"},  # Lee only
)


# All misc tools
MISC_TOOLS = [
    WEB_SEARCH_TOOL,
    SUMMARIZE_TOOL,
    UI_CONTROL_TOOL,
    STATUS_MESSAGE_TOOL,
]
