# Hester ↔ Lee Context System

> Full bidirectional context awareness between Hester (AI daemon) and Lee (TUI multiplexer)

## Overview

Lee has evolved from a simple editor to a full TUI multiplexer, but Hester's integration hasn't kept pace. This document specifies a comprehensive context system that gives Hester:

1. **Full visibility** - knows which tab is focused, what's on screen, user activity patterns
2. **Complete control** - can act on any pane, inject text, highlight, navigate
3. **Proactive reasoning** - "I notice you've been looking at this error for 2 minutes..."

## Current State

### What Lee Tracks Internally

**React App State (`App.tsx`):**
- `tabs: TabData[]` - All open tabs with type, label, ptyId, dockPosition
- `activeTabId` / `activeLeftTabId` / `activeRightTabId` / `activeBottomTabId` - Active tab per panel
- `focusedPanel` - Which panel has keyboard focus
- `workspace` - Current working directory
- `editorDaemonPort` - Editor's HTTP server port

**PTY Manager State (`pty-manager.ts`):**
- Per-PTY: id, name, process handle, accumulated state
- `LeeState`: file, line, column, selection, modified, daemonPort
- Prewarmed editor reference
- Workspace config from `.lee/config.yaml`

**Editor State (via OSC sequences):**
- Current file path
- Cursor line/column
- Selected text
- Modified flag

### What Hester Currently Sees

Only `GET /context` which returns accumulated `LeeState`:
```typescript
{
  file?: string;
  line?: number;
  column?: number;
  selection?: string;
  modified?: boolean;
  daemonPort?: number;
}
```

**Missing:**
- No tab awareness
- No focus awareness
- No panel layout
- No activity tracking
- No real-time updates

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         LEE (Electron)                               │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │   React App      │───▶│  Context Bridge  │───▶│  API Server   │ │
│  │   (Full State)   │◀───│  (Aggregator)    │◀───│  (Port 9001)  │ │
│  └──────────────────┘    └──────────────────┘    └───────┬───────┘ │
│                                                           │         │
└───────────────────────────────────────────────────────────┼─────────┘
                                                            │
                         WebSocket / SSE                    │
                                                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       HESTER (Daemon)                                │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐ │
│  │  Context Store   │◀───│  Lee Client      │◀───│  ReAct Agent  │ │
│  │  (Redis/Memory)  │───▶│  (Subscriber)    │───▶│  (Gemini)     │ │
│  └──────────────────┘    └──────────────────┘    └───────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

1. **Context Bridge** (new) - Aggregates state from React app and PTY manager
2. **API Server** (enhanced) - Exposes full context + unified command API
3. **Lee Client** (new) - Hester's connection to Lee for context + commands
4. **Proactive Reasoner** (future) - Watches context and surfaces insights

## Data Models

### LeeContext (Full State)

```typescript
// lee/electron/src/shared/context.ts

interface LeeContext {
  // Workspace
  workspace: string;
  workspaceConfig: WorkspaceConfig | null;

  // Layout
  panels: {
    center: PanelContext;
    left: PanelContext | null;
    right: PanelContext | null;
    bottom: PanelContext | null;
  };
  focusedPanel: 'center' | 'left' | 'right' | 'bottom';

  // All tabs
  tabs: TabContext[];

  // Editor state (from OSC)
  editor: EditorContext | null;

  // Activity
  activity: ActivityContext;

  // Timestamp
  timestamp: number;
}

interface PanelContext {
  activeTabId: number | null;
  visible: boolean;
  size: number;  // percentage or pixels
}

interface TabContext {
  id: number;
  type: TabType;
  label: string;
  ptyId: number | null;
  dockPosition: DockPosition;
  state: 'active' | 'background' | 'idle';
}

interface EditorContext {
  file: string | null;
  language: string | null;
  cursor: { line: number; column: number };
  selection: string | null;
  modified: boolean;
  daemonPort: number | null;
}

interface ActivityContext {
  lastInteraction: number;        // timestamp
  idleSeconds: number;            // computed
  recentActions: UserAction[];    // last N actions
  sessionDuration: number;        // since workspace opened
}

interface UserAction {
  type: 'tab_switch' | 'file_open' | 'command' | 'edit' | 'terminal_input';
  target: string;                 // tab id, file path, command, etc.
  timestamp: number;
}

type TabType =
  | 'editor'
  | 'terminal'
  | 'git'
  | 'docker'
  | 'k8s'
  | 'flutter'
  | 'hester'
  | 'claude'
  | 'files';

type DockPosition = 'center' | 'left' | 'right' | 'bottom';
```

### Hester Python Models

```python
# hester/daemon/models.py (additions)

class PanelContext(BaseModel):
    active_tab_id: Optional[int] = None
    visible: bool = True
    size: int = 50

class TabContext(BaseModel):
    id: int
    type: str
    label: str
    pty_id: Optional[int] = None
    dock_position: str
    state: Literal["active", "background", "idle"] = "background"

class EditorContext(BaseModel):
    file: Optional[str] = None
    language: Optional[str] = None
    cursor: dict = {"line": 1, "column": 1}
    selection: Optional[str] = None
    modified: bool = False
    daemon_port: Optional[int] = None

class UserAction(BaseModel):
    type: str
    target: str
    timestamp: float

class ActivityContext(BaseModel):
    last_interaction: float
    idle_seconds: float = 0
    recent_actions: List[UserAction] = []
    session_duration: float = 0

class LeeContext(BaseModel):
    """Full context from Lee IDE."""
    workspace: str
    workspace_config: Optional[dict] = None
    panels: dict
    focused_panel: str = "center"
    tabs: List[TabContext] = []
    editor: Optional[EditorContext] = None
    activity: Optional[ActivityContext] = None
    timestamp: float
```

## Context Bridge Implementation

```typescript
// lee/electron/src/main/context-bridge.ts

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { LeeContext, UserAction } from '../shared/context';

export class ContextBridge extends EventEmitter {
  private context: LeeContext;
  private hesterSocket: WebSocket | null = null;
  private actionHistory: UserAction[] = [];
  private sessionStart: number;
  private lastInteraction: number;

  constructor(workspace: string) {
    super();
    this.sessionStart = Date.now();
    this.lastInteraction = Date.now();
    this.context = this.createInitialContext(workspace);
  }

  private createInitialContext(workspace: string): LeeContext {
    return {
      workspace,
      workspaceConfig: null,
      panels: {
        center: { activeTabId: null, visible: true, size: 100 },
        left: null,
        right: null,
        bottom: null,
      },
      focusedPanel: 'center',
      tabs: [],
      editor: null,
      activity: {
        lastInteraction: Date.now(),
        idleSeconds: 0,
        recentActions: [],
        sessionDuration: 0,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Update context from renderer state.
   * Called via IPC when React state changes.
   */
  updateFromRenderer(partial: Partial<LeeContext>): void {
    this.context = { ...this.context, ...partial, timestamp: Date.now() };
    this.pushContext();
  }

  /**
   * Update editor state from PTY OSC sequences.
   */
  updateFromPty(ptyId: number, state: LeeState): void {
    this.context.editor = {
      file: state.file || null,
      language: this.detectLanguage(state.file),
      cursor: { line: state.line || 1, column: state.column || 1 },
      selection: state.selection || null,
      modified: state.modified || false,
      daemonPort: state.daemonPort || null,
    };
    this.context.timestamp = Date.now();
    this.pushContext();
  }

  /**
   * Record a user action for activity tracking.
   */
  recordAction(action: UserAction): void {
    this.lastInteraction = Date.now();
    this.actionHistory.push(action);

    // Keep last 50 actions
    if (this.actionHistory.length > 50) {
      this.actionHistory = this.actionHistory.slice(-50);
    }

    this.updateActivity();
    this.pushContext();
  }

  private updateActivity(): void {
    const now = Date.now();
    this.context.activity = {
      lastInteraction: this.lastInteraction,
      idleSeconds: (now - this.lastInteraction) / 1000,
      recentActions: this.actionHistory.slice(-10),
      sessionDuration: (now - this.sessionStart) / 1000,
    };
  }

  /**
   * Get current context snapshot.
   */
  getContext(): LeeContext {
    this.updateActivity();
    return { ...this.context, timestamp: Date.now() };
  }

  /**
   * Connect to Hester daemon for real-time updates.
   */
  connectToHester(url: string = 'ws://127.0.0.1:9000/lee/connect'): void {
    try {
      this.hesterSocket = new WebSocket(url);

      this.hesterSocket.on('open', () => {
        console.log('Connected to Hester daemon');
        this.pushContext();
      });

      this.hesterSocket.on('close', () => {
        console.log('Disconnected from Hester daemon');
        this.hesterSocket = null;
        // Attempt reconnect after 5 seconds
        setTimeout(() => this.connectToHester(url), 5000);
      });

      this.hesterSocket.on('error', (err) => {
        console.error('Hester connection error:', err.message);
      });
    } catch (err) {
      console.error('Failed to connect to Hester:', err);
    }
  }

  /**
   * Push current context to Hester.
   */
  private pushContext(): void {
    if (this.hesterSocket?.readyState === WebSocket.OPEN) {
      this.hesterSocket.send(JSON.stringify({
        type: 'context_update',
        data: this.getContext(),
      }));
    }
  }

  private detectLanguage(file: string | undefined): string | null {
    if (!file) return null;
    const ext = file.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      py: 'python',
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      dart: 'dart',
      rs: 'rust',
      go: 'go',
      md: 'markdown',
      yaml: 'yaml',
      yml: 'yaml',
      json: 'json',
      sql: 'sql',
    };
    return langMap[ext || ''] || null;
  }
}
```

## API Endpoints

### Enhanced Existing Endpoints

```typescript
// GET /context - Now returns full LeeContext
GET /context
Response: LeeContext

// GET /health - Unchanged
GET /health
Response: { success: true, data: { status: 'healthy', ... } }

// GET /processes - Unchanged
GET /processes
Response: { success: true, data: PTYProcess[] }
```

### Unified Command API

```typescript
// POST /command - Single endpoint for all actions
POST /command
{
  "domain": "system" | "editor" | "tui" | "panel",
  "action": string,
  "params": object
}
```

#### System Commands

| Action | Params | Description |
|--------|--------|-------------|
| `focus_tab` | `{ tabId: number }` | Focus a specific tab |
| `close_tab` | `{ tabId: number }` | Close a tab |
| `create_tab` | `{ type: TabType, dock?: DockPosition, label?: string }` | Create new tab |
| `move_tab` | `{ tabId: number, dock: DockPosition }` | Move tab to different panel |
| `set_focus` | `{ panel: DockPosition }` | Focus a panel |
| `rename_tab` | `{ tabId: number, label: string }` | Rename a tab |

#### Editor Commands

| Action | Params | Description |
|--------|--------|-------------|
| `open_file` | `{ path: string, line?: number }` | Open file at optional line |
| `scroll_to` | `{ line: number }` | Scroll to line |
| `highlight` | `{ startLine: number, endLine: number, style?: string }` | Highlight range |
| `insert` | `{ line: number, text: string }` | Insert text at line |
| `replace` | `{ startLine: number, endLine: number, text: string }` | Replace range |
| `save` | `{}` | Save current file |
| `save_as` | `{ path: string }` | Save as new path |
| `close` | `{}` | Close current file |

#### TUI Commands

| Action | Params | Description |
|--------|--------|-------------|
| `spawn` | `{ type: TUIType, cwd?: string }` | Spawn TUI app |
| `send_keys` | `{ ptyId: number, keys: string }` | Send keystrokes |
| `kill` | `{ ptyId: number }` | Kill PTY process |

#### Panel Commands

| Action | Params | Description |
|--------|--------|-------------|
| `toggle` | `{ panel: DockPosition }` | Toggle panel visibility |
| `resize` | `{ panel: DockPosition, size: number }` | Resize panel |
| `split` | `{ direction: 'horizontal' \| 'vertical' }` | Split current panel |

### WebSocket Context Stream

```typescript
// WS /context/stream - Real-time context updates
// Hester connects here to receive live updates

// Server → Client messages:
{ type: 'context_update', data: LeeContext }
{ type: 'action', data: UserAction }

// Client → Server messages:
{ type: 'command', domain: string, action: string, params: object }
{ type: 'subscribe', topics: string[] }  // e.g., ['editor', 'tabs', 'activity']
```

## Hester Lee Client

```python
# hester/daemon/lee_client.py

import asyncio
import json
from typing import Callable, Optional, Any
import httpx
import websockets

from .models import LeeContext

class LeeContextClient:
    """
    Maintains real-time connection to Lee for context awareness and control.

    Usage:
        client = LeeContextClient()
        await client.connect()

        # Access current context
        ctx = client.context
        print(f"User is editing: {ctx.editor.file}")

        # Send commands
        await client.open_file("/path/to/file.py", line=42)
        await client.spawn_tui("git")
    """

    def __init__(
        self,
        api_url: str = "http://127.0.0.1:9001",
        ws_url: str = "ws://127.0.0.1:9001/context/stream",
    ):
        self.api_url = api_url
        self.ws_url = ws_url
        self.context: Optional[LeeContext] = None
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.on_context_update: Optional[Callable[[LeeContext], None]] = None
        self.on_action: Optional[Callable[[dict], None]] = None
        self._connected = False

    async def connect(self) -> bool:
        """Connect to Lee's context stream."""
        try:
            self.ws = await websockets.connect(self.ws_url)
            self._connected = True
            asyncio.create_task(self._listen())
            return True
        except Exception as e:
            print(f"Failed to connect to Lee: {e}")
            return False

    async def disconnect(self):
        """Disconnect from Lee."""
        if self.ws:
            await self.ws.close()
            self._connected = False

    async def _listen(self):
        """Listen for context updates from Lee."""
        try:
            async for message in self.ws:
                data = json.loads(message)

                if data["type"] == "context_update":
                    self.context = LeeContext(**data["data"])
                    if self.on_context_update:
                        self.on_context_update(self.context)

                elif data["type"] == "action":
                    if self.on_action:
                        self.on_action(data["data"])

        except websockets.exceptions.ConnectionClosed:
            self._connected = False
            # Attempt reconnect
            await asyncio.sleep(5)
            await self.connect()

    async def fetch_context(self) -> Optional[LeeContext]:
        """Fetch context via HTTP (fallback if WebSocket not connected)."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.api_url}/context")
                if response.status_code == 200:
                    data = response.json()
                    self.context = LeeContext(**data)
                    return self.context
        except Exception as e:
            print(f"Failed to fetch context: {e}")
        return None

    async def send_command(
        self,
        domain: str,
        action: str,
        **params: Any,
    ) -> dict:
        """Send command to Lee."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{self.api_url}/command",
                json={
                    "domain": domain,
                    "action": action,
                    "params": params,
                },
            )
            return response.json()

    # =========================================================================
    # Convenience Methods
    # =========================================================================

    async def focus_tab(self, tab_id: int) -> dict:
        """Focus a specific tab."""
        return await self.send_command("system", "focus_tab", tabId=tab_id)

    async def close_tab(self, tab_id: int) -> dict:
        """Close a tab."""
        return await self.send_command("system", "close_tab", tabId=tab_id)

    async def create_tab(
        self,
        tab_type: str,
        dock: str = "center",
        label: Optional[str] = None,
    ) -> dict:
        """Create a new tab."""
        params = {"type": tab_type, "dock": dock}
        if label:
            params["label"] = label
        return await self.send_command("system", "create_tab", **params)

    async def open_file(self, path: str, line: Optional[int] = None) -> dict:
        """Open a file in the editor."""
        params = {"path": path}
        if line is not None:
            params["line"] = line
        return await self.send_command("editor", "open_file", **params)

    async def scroll_to(self, line: int) -> dict:
        """Scroll editor to line."""
        return await self.send_command("editor", "scroll_to", line=line)

    async def highlight(
        self,
        start_line: int,
        end_line: int,
        style: str = "info",
    ) -> dict:
        """Highlight a range in the editor."""
        return await self.send_command(
            "editor",
            "highlight",
            startLine=start_line,
            endLine=end_line,
            style=style,
        )

    async def spawn_tui(self, tui_type: str, cwd: Optional[str] = None) -> dict:
        """Spawn a TUI application."""
        params = {"type": tui_type}
        if cwd:
            params["cwd"] = cwd
        return await self.send_command("tui", "spawn", **params)

    async def send_keys(self, pty_id: int, keys: str) -> dict:
        """Send keystrokes to a PTY."""
        return await self.send_command("tui", "send_keys", ptyId=pty_id, keys=keys)

    # =========================================================================
    # Context Queries
    # =========================================================================

    @property
    def is_connected(self) -> bool:
        """Check if connected to Lee."""
        return self._connected and self.ws is not None

    @property
    def current_file(self) -> Optional[str]:
        """Get currently open file path."""
        if self.context and self.context.editor:
            return self.context.editor.file
        return None

    @property
    def focused_panel(self) -> Optional[str]:
        """Get currently focused panel."""
        if self.context:
            return self.context.focused_panel
        return None

    @property
    def active_tabs(self) -> list:
        """Get list of active tabs."""
        if self.context:
            return [
                t for t in self.context.tabs
                if t.state == "active"
            ]
        return []

    @property
    def idle_seconds(self) -> float:
        """Get seconds since last user interaction."""
        if self.context and self.context.activity:
            return self.context.activity.idle_seconds
        return 0

    def get_tab_by_type(self, tab_type: str) -> Optional[dict]:
        """Find first tab of given type."""
        if self.context:
            for tab in self.context.tabs:
                if tab.type == tab_type:
                    return tab
        return None
```

## Proactive Reasoning

With full context, Hester can reason proactively about what the user needs:

```python
# hester/daemon/proactive.py

import asyncio
from typing import Optional
from .lee_client import LeeContextClient
from .models import LeeContext

class ProactiveReasoner:
    """
    Watches Lee context and surfaces insights proactively.

    This is Hester's "daemon" nature - always watching, occasionally speaking.
    """

    def __init__(self, client: LeeContextClient):
        self.client = client
        self.client.on_context_update = self.on_context_change
        self.last_suggestion_time = 0
        self.suggestion_cooldown = 60  # seconds between suggestions

    async def on_context_change(self, ctx: LeeContext):
        """Called whenever Lee context updates."""

        # Don't spam suggestions
        if self._on_cooldown():
            return

        # Check various triggers
        suggestion = await self._check_triggers(ctx)
        if suggestion:
            await self._deliver_suggestion(suggestion)

    async def _check_triggers(self, ctx: LeeContext) -> Optional[str]:
        """Check all trigger conditions."""

        # 1. User staring at error for too long
        if ctx.activity.idle_seconds > 60:
            if self._looks_like_error(ctx):
                return "I notice you've been looking at this for a while. Want me to help debug?"

        # 2. Repeated file opens (context switching pain)
        if self._repeated_file_opens(ctx.activity.recent_actions):
            return "You keep switching between these files. Want me to create a context bundle?"

        # 3. Rapid tab switches (lost/searching)
        if self._rapid_tab_switches(ctx.activity.recent_actions):
            return "Looking for something? I can help you find it."

        # 4. Long terminal command (might be stuck)
        if self._long_running_command(ctx):
            return "That command's been running a while. Want me to check on it?"

        # 5. Modified file not saved for 10+ minutes
        if self._unsaved_changes_warning(ctx):
            return "You have unsaved changes. Want me to remind you to save?"

        return None

    def _looks_like_error(self, ctx: LeeContext) -> bool:
        """Heuristic: does the current view look like an error?"""
        if not ctx.editor or not ctx.editor.file:
            return False

        # Check if selection contains error-like patterns
        selection = ctx.editor.selection or ""
        error_patterns = ["Error", "Exception", "Traceback", "failed", "FAILED"]
        return any(p in selection for p in error_patterns)

    def _repeated_file_opens(self, actions: list) -> bool:
        """Check if user opened same file 3+ times in 5 minutes."""
        file_opens = [
            a for a in actions
            if a.type == "file_open"
        ]

        if len(file_opens) < 3:
            return False

        # Count occurrences of each file
        from collections import Counter
        counts = Counter(a.target for a in file_opens)
        return any(c >= 3 for c in counts.values())

    def _rapid_tab_switches(self, actions: list) -> bool:
        """Check if user switched tabs 5+ times in 30 seconds."""
        tab_switches = [
            a for a in actions
            if a.type == "tab_switch"
        ]

        if len(tab_switches) < 5:
            return False

        # Check if 5 switches happened within 30 seconds
        recent = tab_switches[-5:]
        time_span = recent[-1].timestamp - recent[0].timestamp
        return time_span < 30

    def _long_running_command(self, ctx: LeeContext) -> bool:
        """Check for terminal commands running > 2 minutes."""
        # TODO: Would need terminal state tracking
        return False

    def _unsaved_changes_warning(self, ctx: LeeContext) -> bool:
        """Check for unsaved changes older than 10 minutes."""
        if not ctx.editor or not ctx.editor.modified:
            return False

        # TODO: Would need to track when file was last modified
        return False

    def _on_cooldown(self) -> bool:
        """Check if we're in suggestion cooldown period."""
        import time
        return (time.time() - self.last_suggestion_time) < self.suggestion_cooldown

    async def _deliver_suggestion(self, message: str):
        """Deliver a proactive suggestion to the user."""
        import time
        self.last_suggestion_time = time.time()

        # Options for delivery:
        # 1. Show in Lee's status bar
        # 2. Show notification toast
        # 3. Add to Hester tab
        # 4. Just log for now

        print(f"[Hester] 💡 {message}")

        # TODO: Implement actual delivery mechanism
        # await self.client.send_command("system", "show_notification", message=message)
```

## Implementation Phases

### Phase 1: Full Context Model

1. Define `LeeContext` TypeScript interface in `lee/electron/src/shared/context.ts`
2. Create `ContextBridge` class in `lee/electron/src/main/context-bridge.ts`
3. Wire renderer state updates through IPC to ContextBridge
4. Enhance `GET /context` to return full `LeeContext`
5. Add Python models to `hester/daemon/models.py`

### Phase 2: Unified Command API

1. Implement `POST /command` endpoint in `api-server.ts`
2. Add command handlers for each domain (system, editor, tui, panel)
3. Update Hester's `ui_control.py` tool to use new unified API
4. Create `LeeContextClient` in `hester/daemon/lee_client.py`

### Phase 3: WebSocket Context Stream

1. Add WebSocket server to Lee API (`/context/stream`)
2. Implement context push on state changes
3. Add WebSocket client to `LeeContextClient`
4. Handle reconnection gracefully

### Phase 4: Proactive Reasoning

1. Implement `ProactiveReasoner` class
2. Add trigger detection heuristics
3. Create notification/suggestion delivery mechanism
4. Add user preferences for proactive suggestions

## Security Considerations

### User Permission Model

Hester's control over Lee should be:

1. **Visible** - User sees what Hester is doing
2. **Interruptible** - User can cancel any action
3. **Configurable** - User controls what Hester can do proactively

```yaml
# ~/.lee/hester.yaml
permissions:
  # Can Hester open files without asking?
  auto_open_files: true

  # Can Hester create/close tabs?
  manage_tabs: true

  # Can Hester send keystrokes to terminals?
  terminal_input: false  # Dangerous - requires explicit permission

  # Proactive suggestions
  proactive:
    enabled: true
    cooldown_seconds: 60
    triggers:
      - idle_on_error
      - repeated_file_opens
      # - rapid_tab_switches  # Disabled
```

### Audit Trail

All Hester actions should be logged:

```python
# Every command sent to Lee is logged
{
  "timestamp": "2024-01-15T10:30:00Z",
  "source": "hester",
  "domain": "editor",
  "action": "open_file",
  "params": {"path": "/src/main.py", "line": 42},
  "result": "success"
}
```

## Testing Strategy

### Unit Tests

- Context model serialization/deserialization
- Command validation
- Action recording

### Integration Tests

- WebSocket connection/reconnection
- Command execution end-to-end
- Context updates propagate correctly

### E2E Tests

- Hester opens file, verify Lee shows it
- User edits file, verify Hester sees update
- Proactive suggestion triggers correctly

## Related Documentation

- `lee/CLAUDE.md` - Lee editor documentation
- `lee/hester/CLAUDE.md` - Hester daemon documentation
- `lee/docs/00-Lee-Initial.md` - Original Lee specification
- `lee/docs/01-Mosaic-Infra.md` - Lee architecture details
