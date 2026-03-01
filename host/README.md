# Lee

**Terminal IDE with Hester AI**

Lee is a Node.js terminal IDE built on the Mosaic architecture - combining robust terminal emulation with AI-powered assistance via Hester.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Lee IDE (Port 9001)                      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Tab 1: Editor (Python TUI via node-pty)                │ │
│  │ Tab 2: Terminal (bash/zsh)                             │ │
│  │ Tab 3: Any TUI (lazygit, htop, etc.)                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  Side Panels:                                               │
│   - Git status, staging, diff                               │
│   - DevOps (Docker, K8s)                                    │
│   - File browser                                            │
│                                                             │
│  Hester Sidecar:                                            │
│   - AI chat interface                                       │
│   - Context display                                         │
│   - Tool execution                                          │
│                                                             │
│  API Server (9001):                                         │
│   POST /command/system  → create tabs, splits, focus        │
│   POST /command/editor  → open file, goto line              │
│   GET  /context         → get editor state                  │
└─────────────────────────────────────────────────────────────┘
                         │
                         │ Port 9000
                         ▼
              ┌─────────────────────┐
              │  Hester Daemon      │
              │  (AI + ReAct)       │
              └─────────────────────┘
```

## Installation

```bash
# From npm (global install)
npm install -g @intrafocal/lee

# Or run without install
npx @intrafocal/lee

# Or from source
cd host
npm install
npm run build
```

## Requirements

- Node.js 18+
- Python 3.11+ (for editor component)

## Usage

```bash
# Start in current directory
lee

# Start in specific workspace
lee ~/projects/myapp

# With custom ports
lee --api-port 9002 --hester-port 9001

# Without Hester
lee --no-hester

# Help
lee --help
```

## Keybindings

| Key | Action |
|-----|--------|
| Ctrl+Q | Quit Lee |
| Ctrl+Shift+T | New terminal tab |
| Ctrl+W | Close current tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+\\ | Split horizontal |
| Ctrl+- | Split vertical |
| Ctrl+] | Focus next pane |
| Ctrl+[ | Focus previous pane |
| Ctrl+G | Git tab (lazygit) |
| Ctrl+D | Docker tab (lazydocker) |
| Ctrl+K | K8s tab (k9s) |
| Ctrl+F | Flutter tab (flx) |

## API Endpoints

### GET /health

Health check.

### GET /context

Get current editor state (file, line, selection).

### POST /command/system

System commands:
- `new_tab`: Create new tab
- `close_tab`: Close tab
- `focus_tab`: Focus tab
- `split`: Split view

```json
{"action": "new_tab", "tab_type": "terminal", "label": "Build"}
{"action": "split", "direction": "horizontal"}
```

### POST /command/editor

Editor commands (relayed via PTY):
- `open_file`: Open file
- `save_file`: Save file
- `goto_line`: Go to line

```json
{"action": "open_file", "path": "/path/to/file.py", "line": 42}
```

### POST /command/tui

TUI commands (spawn external TUI applications):
- `git` or `lazygit`: Open lazygit
- `docker` or `lazydocker`: Open lazydocker
- `k8s`, `k9s`, or `kubernetes`: Open k9s
- `flutter` or `flx`: Open flx (Flutter hot reload)
- `custom`: Open any TUI command

```json
{"tui": "git"}
{"tui": "docker"}
{"tui": "k8s"}
{"tui": "flutter"}
{"tui": "custom", "command": "htop", "label": "System Monitor"}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode
npm run dev

# Clean
npm run clean
```

## License

MIT
