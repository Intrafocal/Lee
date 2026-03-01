# Lee - Lightweight Editing Environment

## Overview

**Lee** (Lightweight Editing Environment) is a terminal-native Integrated Development Environment designed for speed, local-first development, and keyboard efficiency. It provides a rich TUI (Terminal User Interface) for editing code, managing local environments, and handling version control.

Lee operates alongside **Hester**, an AI daemon that maintains deep context of the editing session and can actively drive the editor interface upon request.

## Architecture

Lee uses a **Mosaic Architecture** that combines:

1. **Host Wrapper (Node.js)** - The container/window manager (`host/`)
   - Tab system and split panes using `react-blessed` and `neo-blessed`
   - Terminal emulation via `node-pty` (battle-tested by VS Code/Hyper)
   - API listener on port 9001 for system-level commands
   - Spawns Lee Python TUI as a child process

2. **Lee Editor (Python TUI)** - The editing environment (`editor/`)
   - Built with `textual` framework
   - Syntax highlighting via `tree-sitter`
   - File I/O, diff viewing, version control
   - API listener on port 9000 for editor commands
   - Context export to Hester for AI assistance

3. **Hester Daemon (AI Sidecar)** - See `hester/CLAUDE.md`
   - Receives context from Lee
   - Can orchestrate UI by sending commands to Host or Lee

## Electron App (`electron/`)

The Electron version provides a native desktop experience with:

- **Main Process** (`src/main/`) - Window management, PTY spawning, IPC handlers
- **Renderer Process** (`src/renderer/`) - React-based UI with xterm.js terminals
- **Preload Bridge** (`src/main/preload.ts`) - Secure IPC bridge exposing `window.lee` API

### PTY Management

The `PtyManager` class (`src/main/pty-manager.ts`) handles:
- Spawning PTY processes via `node-pty`
- Routing PTY data/exit events to renderer via IPC
- Prewarming editor and daemon processes for fast startup
- Port availability checks before spawning daemons

### Browser Tabs

Lee includes embedded browser tabs using Electron's `<webview>` tag, allowing Hester to drive web automation:

**Components:**
- `BrowserPane.tsx` - React component with webview, navigation bar, and Hester integration
- `BrowserManager` (`src/main/browser-manager.ts`) - Manages browser lifecycle and CDP access

**Features:**
- Full browser with back/forward/refresh and URL bar
- Keyboard shortcuts: `Cmd+L` (focus URL), `Cmd+R` (refresh), `Cmd+[`/`]` (back/forward)
- "Send to Hester" button to analyze current page
- CDP (Chrome DevTools Protocol) access for automation

**Hester Integration:**
Hester can control browser tabs via the `/command` API with `domain: "browser"`:

```json
// Navigate (requires user approval for new domains)
{ "domain": "browser", "action": "navigate", "params": { "tab_id": 1, "url": "https://example.com" } }

// Screenshot
{ "domain": "browser", "action": "screenshot", "params": { "tab_id": 1 } }

// Get DOM/accessibility tree
{ "domain": "browser", "action": "dom", "params": { "tab_id": 1 } }

// Click element
{ "domain": "browser", "action": "click", "params": { "tab_id": 1, "selector": "#submit-btn" } }

// Type into element
{ "domain": "browser", "action": "type", "params": { "tab_id": 1, "selector": "input[name=email]", "text": "user@example.com" } }

// Fill form
{ "domain": "browser", "action": "fill_form", "params": { "tab_id": 1, "fields": [{"selector": "#email", "value": "a@b.com"}] } }
```

**Security:**
- Hester-initiated navigation requires user approval for new domains
- Pre-approved domains: google.com, github.com, stackoverflow.com, duckduckgo.com
- Approved domains tracked per session
- No arbitrary JavaScript execution - only CDP interaction

### PTY Event Architecture

The renderer uses a **singleton event manager** (`src/renderer/hooks/usePtyEvents.ts`) to handle PTY events:

```typescript
// Global singleton - single listener routes events by PTY ID
import { ptyEventManager } from './hooks/usePtyEvents';

// Mark PTY as expected (enables buffering before handler registers)
ptyEventManager.expect(ptyId);

// Register handlers for a specific PTY
const cleanup = ptyEventManager.register(ptyId, onData, onExit);
```

**Why this pattern?**
- Avoids listener accumulation (each terminal adding its own `ipcRenderer.on`)
- Buffers data for expected PTYs until their handlers register
- Ignores data from prewarmed/background PTYs that don't need UI handlers

### Logging

Lee uses two log files in `~/.lee/logs/`:

| Log File | Source | Contents |
|----------|--------|----------|
| `lee.log` | Electron main process | PTY spawn/exit, port conflicts, prewarm events |
| `hester.log` | Hester daemon (Python) | Context processing, AI calls, session management |

**lee.log format:**
```
[2026-01-04 17:58:43] [INFO] Spawning PTY 1 {"command":"python","args":["-m","editor.main"],"cwd":"/path","name":"Editor"}
[2026-01-04 17:58:45] [INFO] Port 9000 already in use, assuming Hester daemon is already running
[2026-01-04 17:59:12] [INFO] PTY 1 exited {"name":"Editor","exitCode":0}
[2026-01-04 17:59:13] [WARN] PTY 2 exited {"name":"Terminal","exitCode":1}
```

**hester.log format:**
```
2026-01-04 17:58:44 [Hester Daemon] hester.daemon.main - INFO - Starting Hester daemon...
2026-01-04 17:58:44 [Hester Daemon] hester.daemon.main - INFO - Connected to Redis: redis://localhost:6379
2026-01-04 17:58:45 [Hester Daemon] hester.daemon.main - INFO - Processing context - session: abc123
```

**Viewing logs:**
```bash
# Tail main process logs
tail -f ~/.lee/logs/lee.log

# Tail Hester daemon logs
tail -f ~/.lee/logs/hester.log

# Search for errors across both
grep -E "\[WARN\]|\[ERROR\]|ERROR" ~/.lee/logs/*.log
```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Core Framework | Python 3.10+ with `textual` |
| Terminal Engine | `node-pty` (Node.js) for PTY bridging |
| Syntax Engine | `tree-sitter` (editor), `pygments` (markdown) |
| Version Control | `GitPython` |
| Process Management | `asyncio.subprocess` |
| Communication | `aiohttp` (server), `httpx` (client) |
| Diff Engine | `difflib` |

## Directory Structure

```
lee/
├── electron/               # Electron desktop app (primary)
│   ├── src/
│   │   ├── main/           # Main process
│   │   │   ├── main.ts           # App entry, window creation
│   │   │   ├── pty-manager.ts    # PTY spawning and lifecycle
│   │   │   ├── browser-manager.ts # Browser tab lifecycle and CDP
│   │   │   ├── api-server.ts     # HTTP/WS API for Hester (port 9001)
│   │   │   ├── context-bridge.ts # Aggregates context for Hester
│   │   │   └── preload.ts        # IPC bridge (window.lee API)
│   │   ├── renderer/       # Renderer process (React)
│   │   │   ├── App.tsx           # Main app component
│   │   │   ├── components/       # UI components
│   │   │   │   ├── TabBar.tsx        # Tab strip with docking
│   │   │   │   ├── TerminalPane.tsx  # xterm.js terminal
│   │   │   │   ├── BrowserPane.tsx   # Embedded browser with webview
│   │   │   │   ├── EditorPanel.tsx   # CodeMirror editor
│   │   │   │   └── FileTree.tsx      # File explorer
│   │   │   └── hooks/            # React hooks (usePtyEvents, useFocusManager)
│   │   └── shared/         # Shared types
│   │       └── context.ts        # LeeContext type definitions
│   └── package.json
├── editor/                 # Python TUI editor
│   ├── widgets/
│   │   ├── editor/         # Code editor components
│   │   │   ├── code_editor.py      # TextArea with syntax highlighting
│   │   │   ├── file_tabs.py        # Tab management
│   │   │   ├── split_editor.py     # Split view layouts
│   │   │   └── markdown_preview.py # Live markdown preview
│   │   └── diff/
│   │       └── diff_view.py        # Side-by-side diff tool
│   ├── screens/            # TUI screens
│   └── themes/             # Editor themes
├── host/                   # Node.js wrapper (legacy)
│   ├── src/
│   └── package.json
├── hester/                 # AI daemon (see hester/CLAUDE.md)
├── docs/                   # Documentation
└── pyproject.toml          # Python package config
```

## Editor Modules

### Code Editor (`editor/widgets/editor/code_editor.py`)

- `TextArea` with `tree-sitter` syntax highlighting
- Language detection from file extension (Python, JavaScript, TypeScript, Dart, Go, Rust, etc.)
- Line numbers and cursor tracking
- File loading/saving with modification tracking
- Selection tracking for Hester integration

**Language Support:**
```python
LANGUAGE_MAP = {
    ".py": "python", ".js": "javascript", ".ts": "typescript",
    ".dart": "dart", ".json": "json", ".yaml": "yaml",
    ".md": "markdown", ".html": "html", ".css": "css",
    ".go": "go", ".rs": "rust", ".sql": "sql", ...
}
```

### Split View Editor

- Horizontal container with left (editor) and right (preview) panes
- Debounced sync (200ms) from editor to markdown preview
- JetBrains-style layout

### Terminal Module

- Full interactive shell sessions via `textual_terminal.Terminal`
- Runs `claude-code`, `vim`, `htop`, `ssh`, etc.
- Keybinding: `Ctrl+T` spawns new terminal tab

### DevOps Dashboard

- Service management with `config.yaml`-driven controls
- Process isolation with `asyncio` subprocesses
- Live logging (stdout/stderr to `RichLog`)
- Hot reload support (e.g., 'r' for Flutter)

### Git Module

- Status column: Unstaged vs. Staged files
- Action buttons: Fetch, Pull, Push
- Commit interface with dedicated text box
- Auto-refresh on tab focus

### Diff View (`editor/widgets/diff/diff_view.py`)

- Side-by-side TextAreas
- `difflib` for delta computation
- Red backgrounds for deletions, green for additions

## Communication Protocol

Lee and Hester communicate via WebSocket (real-time) and HTTP (commands):

| Channel | Direction | Port | Purpose |
|---------|-----------|------|---------|
| WebSocket | Lee → Hester | :9001 `/context/stream` | Real-time context updates |
| HTTP | Hester → Lee | :9001 `/command` | Unified command API |
| HTTP | Lee → Hester | :9000 `/context/stream` | Query with SSE response |

### Live Context System

Lee maintains a **ContextBridge** that aggregates state from the renderer and pushes real-time updates to Hester via WebSocket. Hester automatically knows:

- **Current file**: What's open in the editor, cursor position, selection
- **Open tabs**: All tabs with type (editor, terminal, git, docker, etc.)
- **Focused panel**: Which panel the user is working in
- **Recent actions**: Last 50 user interactions
- **Idle time**: Seconds since last user activity

**Example context Hester receives:**
```
Current file open in editor: /path/to/main.py
Language: python
Cursor at line 42, column 5

Focused panel: center
Open tabs:
  → [editor] main.py
    [git] lazygit
    [terminal] Terminal 1

Recent actions:
  - file_open: main.py
  - tab_switch: 2
```

This means when you ask "help me push this branch" with lazygit open, Hester understands the context without you having to explain.

### Context Model

The full context model is defined in `src/shared/context.ts`:

```typescript
interface LeeContext {
  workspace: string;                    // Current working directory
  workspaceConfig?: WorkspaceConfig;    // .lee/config.yaml settings
  panels: Record<string, PanelContext>; // Panel states
  focusedPanel: string;                 // center | left | right | bottom
  tabs: TabContext[];                   // All open tabs
  editor?: EditorContext;               // Current editor state
  activity?: ActivityContext;           // User activity tracking
  timestamp: number;
}
```

### Unified Command API

Hester controls Lee via `POST /command`:

```json
{
  "domain": "editor",
  "action": "open",
  "params": { "file": "/path/to/file.py", "line": 42 }
}
```

**Domains:**
- `system` - Tab management (focus_tab, create_tab, close_tab)
- `editor` - File operations (open, save, close)
- `tui` - Spawn TUIs (git, docker, k8s, flutter, custom)
- `panel` - Panel focus control
- `browser` - Browser automation (navigate, screenshot, dom, click, type, fill_form)
- `status` - Status bar messages (push, clear, clear_all)

## Configuration

Create `~/.config/lee/config.yaml` or `.lee/config.yaml` in your workspace:

```yaml
app:
  name: "Lee"
  theme: "dracula"

hester:
  enabled: true
  url: "http://localhost:8888/context"
  listen_port: 9000

# SQL connections for pgcli (Cmd+Shift+S)
sql:
  default: local  # Name of default connection
  connections:
    - name: local
      host: 127.0.0.1
      port: 54322
      database: postgres
      user: postgres
      password: postgres
    - name: production
      host: db.example.com
      port: 5432
      database: myapp
      user: readonly
      ssl: true

# TUI definitions - customize or add new TUI tools
# Override defaults or define custom TUIs (except terminal, editor, daemon, files)
tuis:
  # Override git client (default: lazygit)
  git:
    command: lazygit
    name: Git
    cwd_aware: true

  # Override docker client (default: lazydocker)
  docker:
    command: lazydocker
    name: Docker

  # Kubernetes client with custom args
  k8s:
    command: k9s
    name: K8s
    # args, context, namespace can be passed at spawn time

  # Flutter dev tools
  flutter:
    command: flx
    name: Flutter
    cwd_from_config: flutter.path  # Reads cwd from flutter.path in this config
    cwd_aware: true

  # Claude Code
  claude:
    command: claude
    name: Claude
    env:
      DEBUG: "false"
    cwd_aware: true
    prewarm: true  # Prewarm for instant startup

  # Hester AI chat
  hester:
    command: hester
    name: Hester
    args:
      - chat
      - --daemon-url
      - http://localhost:9000
    cwd_aware: true
    prewarm: true

  # DevOps dashboard
  devops:
    command: hester
    name: DevOps
    args:
      - devops
      - tui
    cwd_aware: true

  # System monitor (default: btop)
  system:
    command: btop
    name: System Monitor

  # Custom TUI example - htop alternative
  htop:
    command: htop
    name: Process Monitor

  # Custom TUI example - ncdu for disk usage
  disk:
    command: ncdu
    name: Disk Usage
    cwd_aware: true

environments:
  - name: "Mobile Client"
    type: "flutter"
    path: "./app"
    hot_key: "r"

  - name: "Database"
    type: "docker"
    command: "docker-compose up"

  - name: "API Service"
    type: "venv"
    path: "./venvs/venv-api"
    command: "uvicorn main:app --reload"
```

### TUI Definition Schema

Each TUI definition supports the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `command` | string | **Required.** The CLI command to execute (e.g., `lazygit`, `btop`) |
| `name` | string | **Required.** Display name for the tab |
| `args` | string[] | Default arguments to pass to the command |
| `env` | object | Environment variables to set (e.g., `DEBUG: "false"`) |
| `cwd_aware` | boolean | If true, uses workspace directory as cwd |
| `cwd_from_config` | string | Config path to read cwd from (e.g., `flutter.path`) |
| `prewarm` | boolean | If true, prewarm this TUI for instant startup |
| `shortcut` | string | Keyboard shortcut (documentation only, e.g., `Cmd+Shift+G`) |

### Hardcoded Components

The following cannot be configured via `tuis:` as they have special handling:
- **terminal** - Core shell functionality with prewarm and login shell behavior
- **editor** - The Lee Python TUI with special lifecycle management
- **daemon** - Hester daemon background process
- **files** - React component with deep IDE integration

## Installation

```bash
# Create/activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install in editable mode
pip install -e .
```

## Usage

```bash
# Start Hester daemon (optional, for AI assistance)
hester daemon start

# Start Lee editor
lee

# Or with a workspace
lee --workspace ./myproject
```

## Key Bindings

| Key | Action |
|-----|--------|
| `Cmd+/` | **Command Palette** - Quick AI queries via Hester |
| `Cmd+Shift+T` | New terminal tab |
| `Cmd+Shift+B` | New browser tab |
| `Cmd+Shift+H` | Open Hester TUI |
| `Cmd+Shift+C` | Open Claude Code |
| `Cmd+Shift+G` | Git dashboard (lazygit) |
| `Cmd+Shift+D` | Docker dashboard (lazydocker) |
| `Cmd+Shift+K` | Kubernetes dashboard (k9s) |
| `Cmd+Shift+P` | SQL client (pgcli) |
| `Cmd+Shift+F` | Flutter dev tools (flx) |
| `Cmd+Shift+E` | File tree |
| `Cmd+Shift+O` | DevOps dashboard |
| `Cmd+1-9` | Switch to tab by number |
| `Cmd+W` | **Watch** - Toggle idle detection on current tab |
| `Cmd+I` | **Idle tabs** - Cycle through tabs marked as idle |
| `Cmd+Esc` | Close current tab |

**Browser Tab Shortcuts** (when browser tab is active):
| Key | Action |
|-----|--------|
| `Cmd+L` | Focus URL bar |
| `Cmd+R` | Refresh page |
| `Cmd+[` | Go back |
| `Cmd+]` | Go forward |

## Command Palette

The Command Palette (`Cmd+/`) provides quick access to Hester AI assistance without leaving your current context:

1. Press `Cmd+/` to open the palette
2. Type your question (e.g., "What does this function do?")
3. Watch ReAct phases stream in real-time:
   - **Preparing** - Tool selection
   - **Thinking** - Reasoning about the query
   - **Acting** - Calling tools (file_read, db_query, etc.)
   - **Observing** - Analyzing tool results
   - **Responding** - Generating final response
4. When done, either:
   - Press `Escape` to dismiss and continue working
   - Click "Open as Hester Tab" to continue the conversation in a full TUI

The daemon runs on port 9000 and auto-starts when Lee opens.

## Integration with Hester

Lee provides **live context** to Hester automatically via WebSocket. Hester TUI tabs spawned from Lee connect to the daemon (`--daemon-url http://localhost:9000`) for full context awareness.

**What Hester sees in its system prompt:**
```
Current file open in editor: /path/to/file.py
Language: python
Cursor at line 42, column 5
(file has unsaved changes)

Focused panel: center
Open tabs:
  → [editor] file.py
    [git] lazygit
    [terminal] Terminal 1
```

**Hester can then:**
- Answer questions about the code with full context
- Understand which TUI you're working with (git, docker, k8s)
- Open related files via command API
- Control the editor UI (focus tabs, spawn TUIs)
- Drive browser tabs (navigate, screenshot, fill forms)
- Be proactive based on idle time and recent actions

## Design Principles

1. **Stability** - Node.js handles terminal emulation; Python handles editing
2. **Modularity** - Lee crash doesn't kill Host; Hester hang doesn't stop editing
3. **Polyglot** - Can embed other TUIs (lazygit, htop) alongside Lee
4. **Local-first** - No cloud dependencies for core editing
5. **Keyboard-driven** - Full control without mouse

## Related Documentation

- `hester/CLAUDE.md` - Hester AI daemon documentation
- `docs/00-Lee-Initial.md` - Technical specification
- `docs/01-Mosaic-Infra.md` - Architecture details
