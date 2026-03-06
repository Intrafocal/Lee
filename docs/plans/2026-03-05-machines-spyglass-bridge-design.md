# Machines: Spyglass & Bridge

> Lee-to-Lee connectivity. Monitor remote instances (Spyglass) and run TUIs on remote machines (Bridge).

## Overview

Lee instances can connect to other Lee instances via two tools:

- **Spyglass** — A tab showing a remote Lee's live state (tabs, editor, activity). Supports remote control via the existing command API.
- **Bridge** — SSH into a remote machine to run a TUI in a specific workspace. Uses the remote Lee API for discovery (workspaces, TUI configs), plain SSH for execution.

Configured machines appear as emoji indicators in the status bar with hover tooltips.

## Machine Config (`~/.lee/config.yaml`)

```yaml
machines:
  - name: Mac Mini
    emoji: "\U0001F5A5"
    host: 192.168.1.101
    user: ben
    ssh_port: 22        # optional, default 22
    lee_port: 9001      # optional, default 9001
    hester_port: 9000   # optional, default 9000

  - name: Mac Mini (CI)
    emoji: "\U0001F3D7"
    host: 192.168.1.101
    user: ben
    lee_port: 9002
    hester_port: 9003
```

Machines are identified by `(host, lee_port)` tuple. Same host can have multiple entries with different ports for different workspaces.

## Status Bar

- Each machine renders its `emoji` in the status bar (right side, near existing indicators)
- Background health pings to `host:lee_port/health` every 15 seconds
- Online: full opacity. Offline: dimmed (CSS opacity or grayscale filter)
- Hover tooltip: `"Mac Mini - online"` or `"Mac Mini - offline"`
- **Left-click**: open/focus a Spyglass tab for that machine
- **Right-click**: open Bridge picker for that machine (pre-selects the machine)

## Spyglass (Tab Type: `spyglass`)

A React tab that connects to a remote Lee's API and renders its state.

### Connection

- WebSocket to `ws://host:lee_port/context/stream` for live `LeeContext`
- Falls back to polling `GET /context` if WebSocket drops
- Auto-reconnect on disconnect (3-second retry, matching Aeronaut behavior)

### UI

Renders the remote machine's state in a read-friendly layout:

- **Header**: Machine name + emoji + connection status dot
- **Tab strip**: Remote tabs (type icon, label, active/idle state)
- **Editor panel**: Current file, language, cursor position, modified indicator
- **Activity**: Idle time, recent actions, session duration
- **Workspace**: Path displayed in header or breadcrumb

### Remote Control

- Click a remote tab to focus it: `POST host:lee_port/command { domain: "system", action: "focus_tab", params: { tab_id } }`
- Can send any command domain: `system`, `editor`, `tui`, `panel`
- Action buttons for common operations (open terminal, spawn TUI, etc.)

### Tab Properties

- Label: `"[emoji] Mac Mini"` (e.g., the configured emoji + machine name)
- Type: `spyglass`
- No PTY (pure WebSocket/HTTP client)

## Bridge (Tab Type: `bridge`)

Bridge is a **core tab type** — visible in the tab menu and splash screen alongside terminal, git, docker, etc.

### Flow

1. User activates Bridge via:
   - Right-click machine emoji in status bar (machine pre-selected)
   - Tab menu / splash screen "Bridge" entry (shows machine picker first)
2. **Machine picker**: List of configured machines with online/offline status
3. **Discovery**: `GET host:lee_port/context` to read `workspaceConfig.tuis` and `workspace` path
4. **TUI picker**: Shows available TUIs from remote config (lazygit, terminal, claude, etc.) grouped by workspace
5. **Connection**: Spawns local PTY running:
   ```
   ssh -t user@host -p ssh_port "cd /workspace/path && command args..."
   ```
6. Renders as a normal terminal tab

### Tab Properties

- Label: `"[emoji] lazygit"` (machine emoji + TUI name)
- Type: `bridge`
- Has PTY (the SSH session)

### SSH Details

- Uses `-t` for TTY allocation (required for TUIs)
- Assumes SSH key auth is configured (no password handling)
- `cd` to the workspace path before running the command
- TUI command and args come from the remote machine's `workspaceConfig.tuis` definition
- If the remote Lee API is unreachable, Bridge can still work with manual command entry (fallback)

## New Types

```typescript
// Machine configuration from ~/.lee/config.yaml
interface MachineConfig {
  name: string;
  emoji: string;
  host: string;
  user: string;
  ssh_port?: number;   // default 22
  lee_port?: number;    // default 9001
  hester_port?: number; // default 9000
}

// Runtime machine state (config + health)
interface MachineState {
  config: MachineConfig;
  online: boolean;
  lastPing: number;
  context?: LeeContext; // Cached from last Spyglass connection
}

// New tab types added to TabType union
type TabType = ... | 'spyglass' | 'bridge';
```

## New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `MachineManager` | `src/main/machine-manager.ts` | Load config, health pinging, expose machine state via IPC |
| `MachineStatus` | `src/renderer/components/MachineStatus.tsx` | Status bar emoji indicators with health state, click/right-click handlers |
| `SpyglassPane` | `src/renderer/components/SpyglassPane.tsx` | Remote Lee context viewer + command sender |
| `BridgePicker` | `src/renderer/components/BridgePicker.tsx` | Machine + workspace + TUI selection flow |

## Backend Work

Minimal — the remote APIs already exist:

| Need | Status |
|------|--------|
| `/health` endpoint | Exists |
| `/context` + `/context/stream` | Exists |
| `/command` API | Exists |
| TUI discovery via `workspaceConfig.tuis` | Exists (in LeeContext) |
| CORS headers | Exists |

**New work (main process only):**
- `MachineManager`: reads `~/.lee/config.yaml`, runs 15-second health ping timer, exposes state via IPC
- IPC handlers: `lee:getMachines`, `lee:getMachineHealth`, `lee:bridgeDiscovery` (fetches remote context)
- Config watcher: reload machines if `~/.lee/config.yaml` changes

## Renderer Work

- `MachineStatus` in status bar (emoji row with hover/click/right-click)
- `SpyglassPane` tab component (WebSocket client, context renderer, command buttons)
- `BridgePicker` modal/sheet (machine list -> TUI list -> spawn SSH PTY)
- Register `spyglass` and `bridge` in tab type routing
- Add Bridge to splash screen and tab creation menu

## Data Flow

### Spyglass

```
User clicks machine emoji in status bar
  -> App.tsx creates tab { type: 'spyglass', machineId: 'mac-mini' }
  -> SpyglassPane mounts, connects WS to remote :9001/context/stream
  -> Receives LeeContext updates, renders remote state
  -> User clicks remote tab -> POST /command to remote Lee
  -> Remote Lee switches tab -> context update flows back via WS
```

### Bridge

```
User right-clicks machine emoji (or picks Bridge from tab menu)
  -> BridgePicker opens
  -> Fetches GET remote:9001/context for workspace + TUI config
  -> User picks "lazygit" in "/Users/ben/my-project"
  -> App.tsx creates tab { type: 'bridge' }
  -> PTY spawns: ssh -t ben@192.168.1.101 "cd /Users/ben/my-project && lazygit"
  -> Renders in TerminalPane like any other PTY tab
```

## Security

- SSH key auth only (no password storage)
- No bearer token auth yet (same LAN trust model as current Lee)
- Future: reuse Aeronaut's token auth when needed
- Bridge commands are visible in the picker — no arbitrary command injection
