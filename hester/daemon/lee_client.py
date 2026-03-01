"""
Lee Context Client - WebSocket client for real-time Lee context updates.

Connects to Lee's WebSocket server at ws://localhost:9001/context/stream
for real-time context updates, with HTTP fallback for commands.
"""

import asyncio
import json
import logging
from typing import Any, Callable, Optional
from contextlib import asynccontextmanager

import httpx
import websockets
from websockets.client import WebSocketClientProtocol

from .models import LeeContext

logger = logging.getLogger("hester.daemon.lee_client")

# Lee API configuration
LEE_API_HOST = "127.0.0.1"
LEE_API_PORT = 9001
LEE_API_URL = f"http://{LEE_API_HOST}:{LEE_API_PORT}"
LEE_WS_URL = f"ws://{LEE_API_HOST}:{LEE_API_PORT}/context/stream"

# Reconnection settings
RECONNECT_DELAY = 5.0  # seconds
MAX_RECONNECT_DELAY = 60.0  # seconds


class LeeContextClient:
    """
    Client for Lee IDE context awareness and control.

    Provides:
    - Real-time context updates via WebSocket
    - HTTP fallback for context fetching
    - Command execution for UI control
    - Auto-reconnection with exponential backoff

    Usage:
        client = LeeContextClient()
        await client.connect()

        # Get current context
        ctx = client.context
        print(f"Current file: {client.current_file}")
        print(f"Idle: {client.idle_seconds}s")

        # Execute commands
        await client.open_file("/path/to/file.py")
        await client.spawn_tui("git")

        await client.disconnect()
    """

    def __init__(
        self,
        on_context_update: Optional[Callable[[LeeContext], None]] = None,
        api_url: str = LEE_API_URL,
        ws_url: str = LEE_WS_URL,
    ):
        self._api_url = api_url
        self._ws_url = ws_url
        self._ws: Optional[WebSocketClientProtocol] = None
        self._context: Optional[LeeContext] = None
        self._connected = False
        self._reconnect_task: Optional[asyncio.Task] = None
        self._on_context_update = on_context_update
        self._on_context_update_async: Optional[Callable[[LeeContext], Any]] = None
        self._current_reconnect_delay = RECONNECT_DELAY

    def set_context_callback(
        self,
        callback: Optional[Callable[[LeeContext], Any]] = None,
        is_async: bool = False,
    ) -> None:
        """
        Set or update the context update callback.

        Args:
            callback: Function to call when context updates
            is_async: If True, callback is an async function
        """
        if is_async:
            self._on_context_update_async = callback
            self._on_context_update = None
        else:
            self._on_context_update = callback
            self._on_context_update_async = None

    @property
    def connected(self) -> bool:
        """Check if WebSocket is connected."""
        return self._connected and self._ws is not None

    @property
    def context(self) -> Optional[LeeContext]:
        """Get the current cached context."""
        return self._context

    @property
    def current_file(self) -> Optional[str]:
        """Get the current file being edited."""
        if self._context and self._context.editor:
            return self._context.editor.file
        return None

    @property
    def focused_panel(self) -> Optional[str]:
        """Get the currently focused panel."""
        if self._context:
            return self._context.focused_panel
        return None

    @property
    def idle_seconds(self) -> float:
        """Get seconds since last user interaction."""
        if self._context and self._context.activity:
            return self._context.activity.idle_seconds
        return 0.0

    @property
    def active_tabs(self) -> list[dict[str, Any]]:
        """Get list of active tabs."""
        if self._context and self._context.tabs:
            return [tab.model_dump() for tab in self._context.tabs]
        return []

    async def connect(self) -> bool:
        """
        Connect to Lee's WebSocket server.

        Returns True if connected, False otherwise.
        Auto-reconnection runs in background on failure.
        """
        try:
            self._ws = await websockets.connect(self._ws_url)
            self._connected = True
            self._current_reconnect_delay = RECONNECT_DELAY
            logger.info(f"Connected to Lee at {self._ws_url}")

            # Start listening for updates in background
            asyncio.create_task(self._listen_loop())
            return True

        except Exception as e:
            logger.warning(f"Failed to connect to Lee: {e}")
            self._connected = False
            self._schedule_reconnect()
            return False

    async def disconnect(self) -> None:
        """Disconnect from Lee's WebSocket server."""
        # Cancel reconnection task
        if self._reconnect_task:
            self._reconnect_task.cancel()
            self._reconnect_task = None

        # Close WebSocket
        if self._ws:
            await self._ws.close()
            self._ws = None

        self._connected = False
        logger.info("Disconnected from Lee")

    async def _listen_loop(self) -> None:
        """Listen for WebSocket messages."""
        if not self._ws:
            return

        try:
            async for message in self._ws:
                try:
                    data = json.loads(message)
                    if data.get("type") == "context_update":
                        self._context = LeeContext.model_validate(data.get("data", {}))
                        # Call sync callback if set
                        if self._on_context_update:
                            self._on_context_update(self._context)
                        # Call async callback if set (non-blocking)
                        if self._on_context_update_async:
                            asyncio.create_task(self._on_context_update_async(self._context))
                except json.JSONDecodeError as e:
                    logger.warning(f"Invalid JSON from Lee: {e}")
                except Exception as e:
                    logger.error(f"Error processing Lee message: {e}")

        except websockets.exceptions.ConnectionClosed:
            logger.warning("Lee WebSocket connection closed")
            self._connected = False
            self._schedule_reconnect()
        except Exception as e:
            logger.error(f"Lee WebSocket error: {e}")
            self._connected = False
            self._schedule_reconnect()

    def _schedule_reconnect(self) -> None:
        """Schedule a reconnection attempt with exponential backoff."""
        if self._reconnect_task and not self._reconnect_task.done():
            return  # Already scheduled

        async def reconnect():
            await asyncio.sleep(self._current_reconnect_delay)
            logger.info(f"Attempting to reconnect to Lee...")

            success = await self.connect()
            if not success:
                # Exponential backoff
                self._current_reconnect_delay = min(
                    self._current_reconnect_delay * 2,
                    MAX_RECONNECT_DELAY
                )

        self._reconnect_task = asyncio.create_task(reconnect())

    async def fetch_context(self) -> Optional[LeeContext]:
        """
        Fetch context via HTTP (fallback when WebSocket unavailable).

        Returns LeeContext or None on failure.
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self._api_url}/context")
                if response.status_code == 200:
                    data = response.json()
                    self._context = LeeContext.model_validate(data.get("data", {}))
                    return self._context
        except Exception as e:
            logger.warning(f"Failed to fetch context from Lee: {e}")
        return None

    async def send_command(
        self,
        domain: str,
        action: str,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        """
        Send a command to Lee via the unified /command endpoint.

        Args:
            domain: Command domain (system, editor, tui, panel)
            action: Action to perform
            params: Additional parameters
            timeout: Request timeout in seconds

        Returns:
            Response data dict with 'success' and 'data' or 'error'
        """
        payload = {
            "domain": domain,
            "action": action,
            "params": params or {},
        }

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{self._api_url}/command",
                    json=payload,
                )
                return response.json()
        except httpx.ConnectError:
            return {"success": False, "error": "Cannot connect to Lee IDE"}
        except httpx.TimeoutException:
            return {"success": False, "error": f"Request timed out after {timeout}s"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ========================================
    # Convenience Methods
    # ========================================

    async def open_file(self, file_path: str) -> dict[str, Any]:
        """Open a file in the editor."""
        return await self.send_command("editor", "open", {"file": file_path})

    async def save_file(self) -> dict[str, Any]:
        """Save the current file."""
        return await self.send_command("editor", "save")

    async def focus_tab(self, tab_id: int) -> dict[str, Any]:
        """Focus a specific tab."""
        return await self.send_command("system", "focus_tab", {"tab_id": str(tab_id)})

    async def close_tab(self, tab_id: int) -> dict[str, Any]:
        """Close a specific tab."""
        return await self.send_command("system", "close_tab", {"tab_id": str(tab_id)})

    async def create_tab(
        self,
        tab_type: str = "terminal",
        label: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create a new tab."""
        params = {"type": tab_type}
        if label:
            params["label"] = label
        if cwd:
            params["cwd"] = cwd
        return await self.send_command("system", "create_tab", params)

    async def focus_panel(self, panel: str) -> dict[str, Any]:
        """Focus a panel (center, left, right, bottom)."""
        return await self.send_command("panel", "focus", {"panel": panel})

    async def spawn_tui(
        self,
        tui_type: str,
        command: Optional[str] = None,
        label: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Spawn a TUI application.

        Args:
            tui_type: Type of TUI (git, docker, k8s, flutter, terminal, custom)
            command: Command for custom TUI
            label: Tab label
            cwd: Working directory
        """
        params: dict[str, Any] = {}
        if command:
            params["command"] = command
        if label:
            params["label"] = label
        if cwd:
            params["cwd"] = cwd
        return await self.send_command("tui", tui_type, params)

    async def open_lazygit(self, cwd: Optional[str] = None) -> dict[str, Any]:
        """Open lazygit for git operations."""
        return await self.spawn_tui("git", cwd=cwd)

    async def open_lazydocker(self) -> dict[str, Any]:
        """Open lazydocker for Docker management."""
        return await self.spawn_tui("docker")

    async def open_k9s(self) -> dict[str, Any]:
        """Open k9s for Kubernetes management."""
        return await self.spawn_tui("k8s")


@asynccontextmanager
async def lee_context_client(
    on_context_update: Optional[Callable[[LeeContext], None]] = None,
):
    """
    Context manager for Lee context client.

    Usage:
        async with lee_context_client() as client:
            print(f"Current file: {client.current_file}")
            await client.open_file("/path/to/file.py")
    """
    client = LeeContextClient(on_context_update=on_context_update)
    try:
        await client.connect()
        yield client
    finally:
        await client.disconnect()
