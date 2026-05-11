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
    description="""Lee IDE control: highlight editor lines, open/close files, manage tabs, open TUI apps.

Use this tool (NOT read_file) when asked to highlight, scroll to, or navigate to lines in the editor.

IMPORTANT: When the user asks you to highlight, point to, scroll to, or visually mark lines in the editor,
use this tool with domain="editor". Do NOT read the file content instead — use ui_control to manipulate
the live editor view directly.

EDITOR TAB ROUTING (READ THIS BEFORE ANY EDITOR ACTION):
The Lee window can have multiple editor panels mounted at once (e.g. one in the
center panel, one in a side panel). Editor commands MUST be addressed to a
specific tab_id, otherwise the wrong panel — or none — will respond. The
workflow is:

  1. Call action="status" first. The response has the shape:
       {
         "active_tab_id": <int|null>,   # the editor in the focused panel
         "editors": [                   # all mounted editor panels
           {"tab_id": 12, "file": "/path/foo.py", "language": "python", ...},
           ...
         ]
       }
  2. Pick the right tab_id (usually `active_tab_id`, or match by file path
     from `editors`).
  3. Pass that tab_id on EVERY subsequent editor command in this turn:
       params={"tab_id": 12, ...}

If `editors` is empty (no editor is open) and you need to act on a file:
  a. Call action="open" with the file path. The response includes the new
     tab_id: {"action": "open", "file": "...", "tab_id": 17}.
  b. Use that tab_id for follow-up commands (goto_line, highlight, select, ...).

Calling editor actions WITHOUT tab_id will silently no-op when the editor
tab isn't the currently-selected tab in its panel. Always pass tab_id.

EDITOR actions (domain="editor"):
- Get editor status (CALL THIS FIRST): action="status", params={}
- Open file: action="open", params={"file": "/path/to/file.py"}  → response includes tab_id
- Open file at line: action="open", params={"file": "/path/to/file.py", "line": 42}
- Save a specific editor: action="save", params={"tab_id": 12}
- Close a specific editor: action="close", params={"tab_id": 12}
- Jump cursor to line + scroll into view: action="goto_line", params={"tab_id": 12, "line": 42, "column": 1}
- Visually highlight lines in the editor (yellow glow, auto-clears): action="highlight", params={"tab_id": 12, "ranges": [{"fromLine": 5, "fromCol": 1, "toLine": 10, "toCol": 999}], "duration_ms": 4000}
- Select a range of text (like a click-drag): action="select", params={"tab_id": 12, "from_line": 10, "from_col": 1, "to_line": 15, "to_col": 40}
- Insert text at position: action="insert", params={"tab_id": 12, "line": 5, "column": 1, "text": "# TODO\\n"}
- Replace range with text: action="replace", params={"tab_id": 12, "from_line": 3, "from_col": 1, "to_line": 3, "to_col": 20, "text": "new content"}

SYSTEM actions (domain="system"):
- Create terminal tab: action="create_tab", params={"type": "terminal"}
- Focus tab: action="focus_tab", params={"tab_id": 1}
- Close tab: action="close_tab", params={"tab_id": 2}

TUI actions (domain="tui"):
- Open lazygit: action="open", params={"tui": "git"}
- Open lazydocker: action="open", params={"tui": "docker"}
- Open k9s: action="open", params={"tui": "k8s"}
- Open Flutter tools: action="open", params={"tui": "flutter"}
- Open custom TUI: action="open", params={"tui": "custom", "command": "htop", "label": "System"}

PANEL actions (domain="panel"):
- Focus panel: action="focus", params={"panel": "left"}
- Toggle panel: action="toggle", params={"panel": "right"}

Note: Only works when Hester is running inside Lee IDE (port 9001).""",
    parameters={
        "type": "object",
        "properties": {
            "domain": {
                "type": "string",
                "enum": ["system", "editor", "tui", "panel"],
                "description": "Domain: 'editor' for file/cursor ops, 'system' for tabs, 'tui' for TUI apps, 'panel' for panels",
            },
            "action": {
                "type": "string",
                "description": "Action to perform. Editor: open, save, close, goto_line, select, highlight, insert, replace, status. System: create_tab, focus_tab, close_tab. TUI: open. Panel: focus, toggle.",
            },
            "params": {
                "type": "object",
                "description": "Parameters for the action. See description for per-action parameter details.",
            },
        },
        "required": ["domain", "action"],
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
