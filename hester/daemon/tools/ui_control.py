"""
Hester UI Control Tool.

Allows Hester to control the Lee IDE (tabs, splits, focus, TUI apps),
the editor TUI (open files, goto line), and browser tabs via HTTP API.

Lee Architecture:
- Lee (Electron/Node.js): Main IDE shell with tabs, panes, API server on port 9001
- Editor TUI (Python/Textual): Code editing TUI that runs inside Lee
- TUI Apps: External TUIs (lazygit, lazydocker, k9s, flx) that run in Lee tabs
- Browser Tabs: Embedded Chromium webviews with CDP access for automation

API: Uses unified POST /command endpoint with { domain, action, params }.
"""

import logging
from typing import Literal, Optional, Any

import httpx

from .base import ToolResult

logger = logging.getLogger("hester.tools.ui_control")

# Lee IDE API endpoint
LEE_API_URL = "http://127.0.0.1:9001"


# Tool definition for ReAct
UI_CONTROL_TOOL = {
    "name": "ui_control",
    "description": """Control the Lee IDE interface. Use this to:
- Create new terminal tabs
- Open files in the editor
- Focus or close tabs
- Open TUI applications (lazygit, lazydocker, k9s, flx)
- Control panels (focus, show, hide)
- Automate browser tabs (navigate, screenshot, click, type)

Domains:
- system: Tab/window management (focus_tab, close_tab, create_tab, focus_window)
- editor: File operations (open, save, save_as, close)
- tui: Open TUI apps (git, docker, k8s, flutter, terminal, or custom)
- panel: Panel control (focus, toggle, show, hide, resize)
- browser: Browser automation (navigate, screenshot, dom, click, type, fill_form, list, get)

Browser actions:
- navigate: Go to URL (requires user approval for new domains)
  params: {tab_id, url}
- screenshot: Capture viewport as base64 PNG
  params: {tab_id}
- dom/snapshot: Get accessibility tree for element discovery
  params: {tab_id}
- click: Click element by CSS selector
  params: {tab_id, selector}
- type: Type text into element
  params: {tab_id, selector, text}
- fill_form: Fill multiple form fields
  params: {tab_id, fields: [{selector, value}, ...]}
- list: Get all browser tabs
- get: Get specific browser tab state
  params: {tab_id}

Example actions:
- {"domain": "system", "action": "create_tab", "params": {"type": "terminal"}}
- {"domain": "editor", "action": "open", "params": {"file": "/path/to/file.py"}}
- {"domain": "tui", "action": "git"}
- {"domain": "tui", "action": "custom", "params": {"command": "htop", "label": "System"}}
- {"domain": "panel", "action": "focus", "params": {"panel": "left"}}
- {"domain": "browser", "action": "navigate", "params": {"tab_id": 1, "url": "https://github.com"}}
- {"domain": "browser", "action": "screenshot", "params": {"tab_id": 1}}
- {"domain": "browser", "action": "click", "params": {"tab_id": 1, "selector": "#login-btn"}}
""",
    "parameters": {
        "type": "object",
        "properties": {
            "domain": {
                "type": "string",
                "enum": ["system", "editor", "tui", "panel", "browser"],
                "description": "Domain: 'system' for tabs, 'editor' for file ops, 'tui' for TUI apps, 'panel' for panels, 'browser' for web automation",
            },
            "action": {
                "type": "string",
                "description": "Action to perform (e.g., 'create_tab', 'open', 'git', 'focus', 'navigate', 'screenshot')",
            },
            "params": {
                "type": "object",
                "description": "Additional parameters for the action",
            },
        },
        "required": ["domain", "action"],
    },
}


async def execute_ui_control(
    domain: Literal["system", "editor", "tui", "panel", "browser"],
    action: str,
    params: Optional[dict[str, Any]] = None,
    timeout: float = 5.0,
) -> ToolResult:
    """
    Execute a UI control command via Lee IDE unified API.

    Args:
        domain: 'system' for tabs/window, 'editor' for file ops, 'tui' for TUI apps,
                'panel' for panels, 'browser' for web automation
        action: Action to perform
        params: Additional parameters
        timeout: Request timeout in seconds

    Returns:
        ToolResult with success status and data
    """
    endpoint = f"{LEE_API_URL}/command"
    payload = {"domain": domain, "action": action, "params": params or {}}

    logger.info(f"UI control: {domain}/{action} with {params}")

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, json=payload)

            if response.status_code == 200:
                data = response.json()
                return ToolResult(
                    success=True,
                    data=data.get("data"),
                    message=f"Successfully executed {action}",
                )
            else:
                # Try to parse JSON error, fall back to raw text
                try:
                    error = response.json().get("error", "Unknown error")
                except (ValueError, AttributeError):
                    error = response.text or f"HTTP {response.status_code}"
                return ToolResult(
                    success=False,
                    error=f"API error: {error}",
                )

    except httpx.ConnectError:
        return ToolResult(
            success=False,
            error="Cannot connect to Lee IDE. Is it running on port 9001?",
        )
    except httpx.TimeoutException:
        return ToolResult(
            success=False,
            error=f"Request timed out after {timeout}s",
        )
    except Exception as e:
        logger.exception("UI control error")
        return ToolResult(
            success=False,
            error=f"Unexpected error: {str(e)}",
        )


# Convenience functions for common actions


async def create_terminal_tab(
    label: Optional[str] = None,
    cwd: Optional[str] = None,
) -> ToolResult:
    """Create a new terminal tab."""
    params: dict[str, Any] = {"type": "terminal"}
    if label:
        params["label"] = label
    if cwd:
        params["cwd"] = cwd

    return await execute_ui_control("system", "create_tab", params)


async def open_file(
    path: str,
    line: Optional[int] = None,
) -> ToolResult:
    """Open a file in the editor."""
    params: dict[str, Any] = {"file": path}
    if line is not None:
        params["line"] = line

    return await execute_ui_control("editor", "open", params)


async def focus_tab(tab_id: int) -> ToolResult:
    """Focus a specific tab."""
    return await execute_ui_control("system", "focus_tab", {"tab_id": str(tab_id)})


async def close_tab(tab_id: int) -> ToolResult:
    """Close a specific tab."""
    return await execute_ui_control("system", "close_tab", {"tab_id": str(tab_id)})


async def send_to_editor(action: str, **params: Any) -> ToolResult:
    """Send a command to the editor."""
    return await execute_ui_control("editor", action, params)


async def focus_panel(panel: Literal["center", "left", "right", "bottom"]) -> ToolResult:
    """Focus a specific panel."""
    return await execute_ui_control("panel", "focus", {"panel": panel})


async def get_editor_context() -> ToolResult:
    """Get current editor context (file, selection, etc.)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{LEE_API_URL}/context")

            if response.status_code == 200:
                try:
                    data = response.json()
                    return ToolResult(
                        success=True,
                        data=data.get("data"),
                        message="Retrieved editor context",
                    )
                except (ValueError, AttributeError):
                    return ToolResult(
                        success=False,
                        error="Invalid JSON response from Lee IDE",
                    )
            else:
                return ToolResult(
                    success=False,
                    error=f"Failed to get context: HTTP {response.status_code}",
                )

    except httpx.ConnectError:
        return ToolResult(
            success=False,
            error="Cannot connect to Lee IDE. Is it running on port 9001?",
        )
    except Exception as e:
        logger.exception("Get editor context error")
        return ToolResult(
            success=False,
            error=str(e),
        )


# TUI convenience functions


async def open_tui(
    tui: Literal["git", "docker", "k8s", "flutter", "terminal", "custom"],
    command: Optional[str] = None,
    label: Optional[str] = None,
    cwd: Optional[str] = None,
) -> ToolResult:
    """
    Open a TUI application in a new Lee tab.

    Args:
        tui: TUI type - 'git' (lazygit), 'docker' (lazydocker), 'k8s' (k9s),
             'flutter' (flx), 'terminal', or 'custom' (requires command)
        command: Command to run (only for 'custom' type)
        label: Tab label (optional)
        cwd: Working directory (optional)

    Returns:
        ToolResult with pty_id on success
    """
    # TUI domain uses action as the TUI type
    params: dict[str, Any] = {}
    if command:
        params["command"] = command
    if label:
        params["label"] = label
    if cwd:
        params["cwd"] = cwd

    return await execute_ui_control("tui", tui, params)


async def open_lazygit(cwd: Optional[str] = None) -> ToolResult:
    """Open lazygit for Git operations."""
    return await open_tui("git", cwd=cwd)


async def open_lazydocker() -> ToolResult:
    """Open lazydocker for Docker management."""
    return await open_tui("docker")


async def open_k9s() -> ToolResult:
    """Open k9s for Kubernetes management."""
    return await open_tui("k8s")


async def open_flx(cwd: Optional[str] = None) -> ToolResult:
    """Open flx for Flutter hot reload management."""
    return await open_tui("flutter", cwd=cwd)


async def open_terminal(label: Optional[str] = None, cwd: Optional[str] = None) -> ToolResult:
    """Open a new terminal tab."""
    return await open_tui("terminal", label=label, cwd=cwd)


# Status bar message functions


async def push_status_message(
    message: str,
    message_type: Literal["hint", "info", "success", "warning"] = "hint",
    prompt: Optional[str] = None,
    ttl: Optional[int] = None,
    message_id: Optional[str] = None,
) -> ToolResult:
    """
    Push a message to Lee's status bar.

    The message appears in the status bar at the bottom of Lee.
    If the user clicks on it or presses ⌘/, the prompt (if provided)
    is sent immediately to Hester.

    Args:
        message: Short message to display (e.g., "Commit these changes?")
        message_type: Type of message - 'hint' (default), 'info', 'success', 'warning'
        prompt: Optional prompt to auto-send when clicked/⌘/
        ttl: Optional time-to-live in seconds (auto-dismiss after)
        message_id: Optional unique ID (auto-generated if not provided)

    Returns:
        ToolResult with the message ID on success
    """
    params: dict[str, Any] = {
        "message": message,
        "type": message_type,
    }
    if prompt:
        params["prompt"] = prompt
    if ttl:
        params["ttl"] = ttl
    if message_id:
        params["id"] = message_id

    return await execute_ui_control("status", "push", params)


async def clear_status_message(message_id: str) -> ToolResult:
    """Clear a specific status message by ID."""
    return await execute_ui_control("status", "clear", {"id": message_id})


async def clear_all_status_messages() -> ToolResult:
    """Clear all status messages from the queue."""
    return await execute_ui_control("status", "clear_all")


# Browser automation functions


async def browser_navigate(tab_id: int, url: str) -> ToolResult:
    """
    Navigate a browser tab to a URL.

    Note: Navigation to new domains requires user approval.
    Pre-approved domains: google.com, github.com, stackoverflow.com, duckduckgo.com

    Args:
        tab_id: Browser tab ID
        url: URL to navigate to

    Returns:
        ToolResult with approval status. If not immediately approved,
        includes requestId for pending approval.
    """
    return await execute_ui_control("browser", "navigate", {"tab_id": tab_id, "url": url})


async def browser_screenshot(tab_id: int) -> ToolResult:
    """
    Capture a screenshot of a browser tab.

    Args:
        tab_id: Browser tab ID

    Returns:
        ToolResult with base64-encoded PNG in data field
    """
    return await execute_ui_control("browser", "screenshot", {"tab_id": tab_id})


async def browser_get_dom(tab_id: int) -> ToolResult:
    """
    Get the accessibility tree (DOM snapshot) of a browser tab.

    Use this to discover element selectors before clicking/typing.

    Args:
        tab_id: Browser tab ID

    Returns:
        ToolResult with accessibility tree data
    """
    return await execute_ui_control("browser", "dom", {"tab_id": tab_id})


async def browser_click(tab_id: int, selector: str) -> ToolResult:
    """
    Click an element in a browser tab by CSS selector.

    Args:
        tab_id: Browser tab ID
        selector: CSS selector (e.g., "#submit-btn", ".login-link", "button[type=submit]")

    Returns:
        ToolResult with click coordinates on success
    """
    return await execute_ui_control("browser", "click", {"tab_id": tab_id, "selector": selector})


async def browser_type(tab_id: int, selector: str, text: str) -> ToolResult:
    """
    Type text into an element in a browser tab.

    Clicks the element first to focus it, then types each character.

    Args:
        tab_id: Browser tab ID
        selector: CSS selector for the input element
        text: Text to type

    Returns:
        ToolResult with typed text on success
    """
    return await execute_ui_control(
        "browser", "type", {"tab_id": tab_id, "selector": selector, "text": text}
    )


async def browser_fill_form(
    tab_id: int,
    fields: list[dict[str, str]],
) -> ToolResult:
    """
    Fill multiple form fields in a browser tab.

    Args:
        tab_id: Browser tab ID
        fields: List of {selector, value} dicts

    Returns:
        ToolResult with per-field success status
    """
    return await execute_ui_control("browser", "fill_form", {"tab_id": tab_id, "fields": fields})


async def browser_list() -> ToolResult:
    """
    Get all active browser tabs.

    Returns:
        ToolResult with list of browser states (tabId, url, title, loading)
    """
    return await execute_ui_control("browser", "list", {})


async def browser_get(tab_id: int) -> ToolResult:
    """
    Get state of a specific browser tab.

    Args:
        tab_id: Browser tab ID

    Returns:
        ToolResult with browser state (url, title, loading, canGoBack, canGoForward)
    """
    return await execute_ui_control("browser", "get", {"tab_id": tab_id})


# Note: STATUS_MESSAGE_TOOL is defined in base.py to be included in HESTER_TOOLS
