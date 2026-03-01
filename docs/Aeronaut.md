# Aeronaut - Lee's Mobile Companion

> Your IDE from your pocket. Not a remote desktop — a native mobile client for Lee's nervous system.

## Overview

**Aeronaut** is a mobile app that connects to **one or more** running Lee instances on the local network, giving you native access to your IDE state from your phone. Named for Lee Scoresby's profession in *His Dark Materials* — the aeronaut who navigates from above, seeing the full picture.

Aeronaut is **not** a remote desktop. It doesn't stream pixels. It connects to Lee's existing HTTP + WebSocket APIs and renders structured state as native mobile UI. This means it works over cellular, uses almost no bandwidth, and feels like a native app — because it is one.

**Design philosophy:** Most of what you want to do from your phone isn't coding — it's monitoring, reviewing, querying, and kicking off tasks. Aeronaut is built for that.

### Multi-Machine Support

Aeronaut treats each Lee instance as a named **machine**. You might have:

| Machine | IP | Workspace | Use Case |
|---------|-----|-----------|----------|
| MacBook Pro | 192.168.1.100 | coefficiency | Primary dev — Sybil, Frame, services |
| Mac Mini | 192.168.1.101 | coefficiency | Background — long CI runs, GPU tasks |
| Mac Mini | 192.168.1.101 | side-project | Secondary workspace on same machine |

Each machine has its own Lee Host (port 9001) and optionally its own Hester daemon (port 9000). Aeronaut maintains independent WebSocket connections to each and lets you switch between them with a swipe or tap.

A Lee instance can also run multiple workspaces (different ports or same port, different workspace paths). Aeronaut identifies each connection by `(host, port, workspace)` tuple.

## Architecture

```
┌─────────────────────────────────┐
│   Aeronaut (iPhone)             │
│                                 │         ┌──────────────────────────────────┐
│  ┌───────────────────────────┐  │  WiFi   │   MacBook Pro (192.168.1.100)    │
│  │ Machine Switcher          │  │◄───────►│   Lee :9001 + Hester :9000       │
│  │  ├─ MacBook Pro           │  │         └──────────────────────────────────┘
│  │  ├─ Mac Mini (coeff)      │  │
│  │  └─ Mac Mini (side-proj)  │  │         ┌──────────────────────────────────┐
│  └───────────────────────────┘  │◄───────►│   Mac Mini (192.168.1.101)       │
│                                 │         │   Lee :9001 + Hester :9000       │
│  ┌───────────────────────────┐  │         │   Lee :9002 + Hester :9003       │
│  │ Tab Navigator             │  │         └──────────────────────────────────┘
│  │ Editor Preview            │  │
│  │ Terminal Viewer           │  │
│  │ Git Status                │  │
│  │ DevOps Dashboard          │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Hester Chat               │  │
│  │ Voice Input               │  │
│  │ Task Monitor              │  │
│  │ Bundle Browser            │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

**Per machine, Aeronaut connects to:**

| Port | Protocol | Purpose |
|------|----------|---------|
| Host (default 9001) | WS `/context/stream` | Real-time IDE state |
| Host (default 9001) | WS `/pty/:id/stream` * | Terminal output fan-out |
| Host (default 9001) | HTTP `POST /command` | Remote control |
| Hester (default 9000) | SSE `POST /context/stream` | AI chat streaming |

`* = needs to be built (Phase 1)`

## What Already Exists (No Changes Needed)

Lee's Electron app already exposes everything Aeronaut needs for context awareness and remote control:

### Host API (Port 9001)

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/health` | GET | Health check | Exists |
| `/context` | GET | Full `LeeContext` snapshot | Exists |
| `/context/stream` | WS | Real-time context updates (50ms debounce) | Exists |
| `/command` | POST | Unified command API (all domains) | Exists |
| `/processes` | GET | List active PTY processes | Exists |
| `/process/:id` | DELETE | Kill a PTY process | Exists |
| `/editor/status` | GET | Editor daemon status | Exists |

### Hester Daemon API (Port 9000)

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/health` | GET | Health check with component status | Exists |
| `/context/stream` | POST | SSE streaming (ReAct phases) | Exists |
| `/context` | POST | Process context (full request/response) | Exists |
| `/session/{id}` | GET | Session info | Exists |
| `/sessions` | GET | List active sessions | Exists |

### LeeContext (Already Streamed via WebSocket)

The `ContextBridge` already aggregates and streams the full IDE state:

```typescript
interface LeeContext {
  workspace: string;
  workspaceConfig: WorkspaceConfig | null;
  panels: Record<DockPosition, PanelContext | null>;
  focusedPanel: DockPosition;
  tabs: TabContext[];           // All open tabs with type, label, ptyId, dock
  editor: EditorContext | null; // Current file, cursor, selection, modified
  browsers?: Record<number, BrowserContext>;
  activity: ActivityContext;    // Idle time, recent actions, session duration
  timestamp: number;
}
```

### Command API (Already Supports All Actions)

Aeronaut can control Lee via `POST /command` with these domains:

| Domain | Actions |
|--------|---------|
| `system` | `focus_tab`, `close_tab`, `create_tab`, `focus_window` |
| `editor` | `open`, `save`, `close`, `status` |
| `tui` | `git`, `docker`, `k8s`, `flutter`, `hester`, `claude`, `terminal`, `custom` |
| `panel` | `toggle`, `show`, `hide`, `resize`, `focus` |
| `status` | `push`, `clear`, `clear_all` |
| `browser` | `navigate`, `screenshot`, `dom`, `click`, `type`, `fill_form` |

## What Needs to Be Built

### Phase 1: Backend — PTY Streaming + LAN Access

Two additions to Lee's Electron `api-server.ts`:

#### 1. PTY Output WebSocket (`/pty/:id/stream`)

Subscribe to a PTY's output stream over WebSocket. The `PTYManager` already extends `EventEmitter` and emits `data` events per PTY ID — adding a second listener has zero impact on the Electron renderer.

```typescript
// New WebSocket path on the existing server
// Client connects: ws://192.168.x.x:9001/pty/3/stream
// Server fans out PTY data to all connected WebSocket clients
// Client can send messages back as PTY input (keyboard)
```

**Why this is safe:** `EventEmitter` supports unlimited listeners. Each WebSocket client gets its own send buffer. Slow mobile clients can't block the Electron renderer — worst case, the WS buffer grows and the client drops frames. The PTY itself is completely unaware of how many listeners exist.

**Backpressure handling:** If a mobile client falls behind, we can either:
- Let the WebSocket buffer grow (fine for short bursts)
- Drop messages when buffer exceeds a threshold (terminal output is ephemeral)
- Throttle: batch PTY output into 100ms chunks for mobile clients

#### 2. LAN Binding

Lee's Express server currently calls `this.app.listen(this.port)` with no host argument — Express defaults to `0.0.0.0` (all interfaces), so it's **already LAN-accessible**.

Hester daemon binds to `127.0.0.1` by default. For Aeronaut, set `HESTER_HOST=0.0.0.0` before launching the daemon. This could be:
- A flag in `.lee/config.yaml`: `aeronaut: { enabled: true }`
- An env var override
- Automatic when Aeronaut is detected on the network

#### 3. Simple Auth (Shared Secret)

Since this opens ports to the LAN, add a lightweight auth layer:

- On first launch, Lee generates a random token and stores it in `~/.lee/aeronaut.token`
- Lee displays a QR code in the status bar (or via `Cmd+Shift+A`) containing `{ host, port, token }`
- Aeronaut scans the QR to pair — stores the token locally
- All Aeronaut requests include `Authorization: Bearer <token>` header
- Express middleware validates the token on all routes when Aeronaut mode is enabled

No accounts, no cloud, no certificates. Just a shared secret over local WiFi.

### Phase 2: Aeronaut Flutter App

#### Technology Choice: Flutter

- Frame is already Flutter — shared toolchain, CI, and knowledge
- Cross-platform (iOS + Android) from one codebase
- Riverpod for state management (same as Frame)
- Strong WebSocket and SSE support in Dart

#### App Structure

```
aeronaut/
├── lib/
│   ├── main.dart
│   ├── models/
│   │   ├── machine.dart             # Machine config (name, host, ports, token)
│   │   ├── lee_context.dart         # LeeContext, TabContext, etc.
│   │   └── hester_models.dart       # Session, phase events
│   ├── providers/
│   │   ├── machines_provider.dart    # Saved machines list + active machine
│   │   ├── connection_provider.dart  # WebSocket to active machine's Host
│   │   ├── context_provider.dart     # LeeContext state from WS
│   │   ├── pty_provider.dart         # PTY output streams
│   │   └── hester_provider.dart      # Hester SSE chat
│   ├── services/
│   │   ├── lee_api.dart             # HTTP client for /command, /context
│   │   ├── hester_api.dart          # HTTP client for Hester daemon
│   │   ├── discovery.dart           # mDNS / QR code pairing
│   │   └── machine_store.dart       # Persist machine configs (SharedPreferences)
│   ├── screens/
│   │   ├── machines_screen.dart     # Machine list + add/edit/connect
│   │   ├── home_screen.dart         # Tab navigator (main view)
│   │   ├── terminal_screen.dart     # PTY output viewer + input
│   │   ├── editor_screen.dart       # Read-only code view
│   │   ├── hester_screen.dart       # Chat with voice input
│   │   └── devops_screen.dart       # Service status dashboard
│   └── widgets/
│       ├── machine_card.dart        # Machine status card (name, IP, online/offline)
│       ├── machine_switcher.dart    # Compact switcher in app bar
│       ├── tab_bar.dart             # Horizontal tab strip (from tabs[])
│       ├── code_viewer.dart         # Syntax-highlighted read-only code
│       ├── terminal_view.dart       # Terminal output renderer
│       └── react_phase_indicator.dart # Hester ReAct phase display
├── pubspec.yaml
└── test/
```

#### Machine Model

Each saved connection is a **Machine**:

```dart
class Machine {
  final String id;          // UUID, generated on create
  final String name;        // "MacBook Pro", "Mac Mini (CI)"
  final String host;        // "192.168.1.100"
  final int hostPort;       // 9001 (Lee Host)
  final int? hesterPort;    // 9000 (Hester daemon, optional)
  final String token;       // Bearer token from ~/.lee/aeronaut.token
  final String? workspace;  // "/Users/ben/Coefficiency/..." (from /context)
  final DateTime? lastSeen; // Last successful connection
}
```

Machines are persisted locally on the phone. On launch, Aeronaut pings `/health` on each saved machine to show online/offline status. The active machine is the one whose WebSocket connections are live.

**Multiple workspaces on one host:** If the same Mac runs Lee on two different ports (e.g., `:9001` for coefficiency, `:9002` for side-project), these are two separate Machine entries with the same `host` but different `hostPort`. The workspace path (discovered from `LeeContext.workspace` on first connect) disambiguates them in the UI.

#### Screen Designs

**Machines Screen (home on first launch, settings thereafter):**
- List of saved machines as cards showing: name, host:port, workspace, online/offline status, last seen
- Each card shows a green/red dot from background `/health` pings
- Tap a machine card → connect and go to Home Screen
- Long-press → edit name, ports, delete
- "+" button → QR scan or manual entry (host, port, token)
- QR code contains: `{ name, host, hostPort, hesterPort, token }`
- Active machine highlighted with accent color
- Swipe between machines when connected (or use compact switcher in app bar)

**Home Screen (Tab Navigator):**
- App bar shows active machine name + compact switcher dropdown (tap to switch machines)
- Renders `LeeContext.tabs[]` as a scrollable tab strip at top
- Tapping a tab sends `POST /command { domain: "system", action: "focus_tab", params: { tab_id } }` to focus on Mac
- Current view shows tab-type-appropriate content:
  - Editor tab → code viewer
  - Terminal tab → terminal output
  - Git tab → git status summary
  - Browser tab → URL + title + screenshot
- Pull-to-refresh fetches fresh `/context`
- Floating action button: create new tab (terminal, TUI picker)
- Switching machines: dropdown in app bar, or swipe gesture — disconnects from current, connects to new

**Terminal Screen:**
- Subscribes to `WS /pty/:id/stream` for output
- Renders terminal output in a monospace view (scrollable)
- Input field at bottom — sends keystrokes to PTY via WebSocket
- Swipe between terminal tabs
- Voice-to-text input for commands (iOS native dictation)

**Editor Screen:**
- Read-only code viewer with syntax highlighting
- Shows current file from `LeeContext.editor.file`
- Cursor position indicator from `editor.cursor`
- Modified indicator from `editor.modified`
- Tap a line → could send to Hester as context ("Explain line 42")
- File breadcrumb from file path

**Hester Screen:**
- Chat interface with message bubbles
- Voice input button (hold to speak → transcribe → send)
- SSE streaming: shows ReAct phases in real-time (thinking → acting → observing → responding)
- Session picker (from `/sessions`)
- Context awareness — automatically includes current Lee state

**DevOps Screen:**
- Service status cards (via Hester devops tools)
- Start/stop buttons for each service
- Log viewer (tails service logs)
- Docker container status

#### Key UX Principles

1. **Read-heavy, write-light** — you're monitoring and reviewing, not editing code
2. **One-handed operation** — thumb-reachable controls, swipe navigation
3. **Voice-first for Hester** — phone keyboard is painful; voice is natural
4. **Push, don't poll** — WebSocket for state, SSE for Hester; no polling loops
5. **Offline-tolerant** — graceful disconnect/reconnect, show last-known state when connection drops

### Phase 3: Enhanced Features

#### mDNS Discovery

Auto-discover Lee instances on the network instead of manual entry:

```dart
// Each Lee instance advertises via mDNS:
// Service: _lee._tcp.local.
// Port: 9001
// TXT records: { workspace: "/path/to/project", name: "MacBook Pro" }
//
// Aeronaut scans and shows available instances:
// "MacBook Pro — coefficiency (192.168.1.100)"
// "Mac Mini — coefficiency (192.168.1.101)"
// "Mac Mini — side-project (192.168.1.101:9002)"
//
// Tap to pair — still requires token for auth.
```

Uses `package:nsd` (Network Service Discovery) on Flutter. Lee advertises on startup, stops on quit.

#### Notifications

- **Task completion** — Hester tasks finish → push notification
- **QA test results** — scene test passes/fails
- **Service health** — staging goes down
- **Idle nudge** — "You've been idle for 30min, lazygit is still open"

Requires a lightweight push relay (or just local notifications when app is foregrounded).

#### Watch Mode (Background Monitoring)

When Aeronaut is in the background:
- Maintains WebSocket connection (iOS background modes)
- Monitors for specific events (test failures, deployments, errors)
- Surfaces iOS Live Activities for long-running tasks

#### Pi VPN Gateway

For true remote access beyond local WiFi:

```
iPhone → WireGuard VPN → Raspberry Pi → LAN → Mac(s) (9001/9000)
```

- Pi runs WireGuard server on home network
- Aeronaut connects to Pi VPN when off-WiFi
- Same LAN IPs, same auth tokens — no changes to Lee or Hester
- All machines on the LAN become reachable through the single VPN tunnel
- Latency: ~20-50ms additional (acceptable for monitoring, not for typing)
- Per-machine latency shown in machine switcher (helps you know which machine to use remotely)

## Implementation Plan

### Milestone 1: Proof of Concept ✅

**Goal:** See Lee's tabs on your phone, switch between them, connect to multiple machines.

**Backend:**
- [x] Add `/pty/:id/stream` WebSocket endpoint to `api-server.ts`
- [ ] Add bearer token auth middleware to `api-server.ts` (read from `~/.lee/aeronaut.token`)
- [x] Verify Host is LAN-accessible (Express default `0.0.0.0`)

**Flutter:**
- [x] Scaffold `aeronaut/` Flutter project
- [x] Machine model + local persistence (SharedPreferences)
- [x] Machines screen: list saved machines, add via manual entry (host:port:token)
- [x] Health-check ping to show online/offline per machine
- [x] WebSocket connection to active machine's `/context/stream`
- [x] Home screen rendering `tabs[]` as a list with machine name in app bar
- [x] Tap tab → `POST /command` to focus on Mac
- [x] Basic terminal output view (subscribe to PTY WebSocket)
- [x] Machine switcher in app bar (dropdown to switch active connection)

### Milestone 2: Full Tab Experience ✅

**Goal:** Useful views for each tab type.

- [x] Editor screen: file metadata viewer (path, cursor, language, modified)
- [x] Terminal screen: full xterm emulation with escape sequences, cursor, colors
- [x] Browser screen: remote browser cast with touch/scroll/key forwarding (beyond original spec)
- [x] Tab creation: header icon → bottom sheet with TUI picker (terminal, git, docker, hester, claude)
- [x] Pull-to-refresh for context
- [x] TUI command handler delegates to renderer for proper PTY spawning + prewarming

### Milestone 3: Hester Integration ✅

**Goal:** Talk to Hester from your phone.

- [x] Hester daemon binds to `0.0.0.0` for LAN access
- [x] Hester chat screen (HesterScreen) with SSE streaming — accessible via rabbit icon in header
- [x] ReAct phase indicator (preparing → thinking → acting → responding)
- [ ] Voice input (iOS speech-to-text → Hester)
- [x] Session management (list, load, delete sessions)
- [x] Context bundles browser (list + read bundle content)

### Milestone 4: QR Pairing + Polish

**Goal:** Frictionless setup, especially for multiple machines.

- [ ] Lee generates QR code containing `{ name, host, hostPort, hesterPort, token }` (via `Cmd+Shift+A` or status bar)
- [ ] Aeronaut QR scanner → auto-creates Machine entry
- [ ] Bearer token auth — generated per-machine, validated in Express middleware
- [x] Auto-reconnect on disconnect (3-second retry)
- [x] Background health pings for all saved machines (15-second interval)
- [x] Connection status in app bar (color-coded dot)
- [x] Graceful disconnect handling (auto-retry with last-known state)
- [x] Dark theme matching Lee's aesthetic (GitHub dark + terminal green)
- [ ] Machine reordering (drag to set preferred order)

### Milestone 5: Library Tab

**Goal:** AI exploration from your phone — tree-of-thought sessions via Hester's Library API.

All endpoints already exist on Hester daemon (`:9000`). No backend work needed.

**Flutter:**
- [ ] Library screen: session list (create, switch, delete)
- [ ] Node tree: collapsible tree of thought nodes per session
- [ ] Node chat: SSE streaming conversation per node (same pattern as HesterScreen)
- [ ] Agent mode selector: ideate, research, analyze, design, implement, docs, web
- [ ] Synthesis: summarize/compare/combine selected nodes
- [ ] Doc search integration (`GET /docs/search`)
- [ ] Web search integration (`POST /research/web`)

**Hester endpoints (all exist):**
```
GET    /library/sessions
POST   /library/sessions
GET    /library/sessions/{id}
DELETE /library/sessions/{id}
POST   /library/sessions/{id}/nodes
POST   /library/sessions/{id}/nodes/{nodeId}/chat      (SSE)
POST   /library/sessions/{id}/nodes/{nodeId}/continue   (SSE)
POST   /library/sessions/{id}/synthesize                 (SSE)
POST   /library/sessions/{id}/visualize                  (SSE)
```

### Milestone 6: Files Tab

**Goal:** Browse and navigate the workspace file tree from your phone.

Requires new REST endpoints on Lee's API server — file system ops are currently IPC-only.

**Backend (api-server.ts):**
- [ ] `GET /fs/readdir?path=<dir>` — list directory contents (name, path, type)
- [ ] `GET /fs/readFile?path=<file>` — read file content
- [ ] `GET /fs/stat?path=<file>` — file metadata (size, modified)

**Flutter:**
- [ ] File tree screen: lazy-loading collapsible directory tree
- [ ] File icons by extension
- [ ] Filter/search within tree
- [ ] Tap file → opens in editor on Mac via `POST /command { domain: "editor", action: "open" }`
- [ ] Cache directory children locally to avoid repeated API calls

### Milestone 7: Code Viewer

**Goal:** Read-only syntax-highlighted code viewer for the active editor file.

Depends on Milestone 6's `readFile` endpoint.

- [ ] Read-only code viewer with syntax highlighting (use `flutter_highlight` or similar)
- [ ] File content fetched via `GET /fs/readFile` when editor tab is active
- [ ] Cursor position indicator from `LeeContext.editor.cursor`
- [ ] Line numbers, language badge, modification indicator
- [ ] Tap line → send to Hester as context ("Explain line 42")

**Note:** Full editing is out of scope for mobile — Aeronaut is read-heavy by design. If editing is ever needed, a WebView embedding CodeMirror is the pragmatic path.

### Milestone 8: Remote Access via Pi (future)

- [ ] WireGuard config for Raspberry Pi
- [ ] Aeronaut VPN toggle per machine (local WiFi vs. remote via Pi)
- [ ] Latency indicator per machine (color-coded: green <50ms, yellow <200ms, red >200ms)
- [ ] Latency-aware UI (disable terminal input when >200ms)

## Data Flow Examples

### Viewing Terminal Output on Phone

```
1. Aeronaut connects: WS ws://192.168.1.100:9001/pty/3/stream
2. Host adds listener: ptyManager.on('data', (id, data) => { if (id === 3) ws.send(data) })
3. Terminal produces output → node-pty → EventEmitter
4. Two listeners fire:
   a. Electron renderer (existing) — renders in xterm.js
   b. Aeronaut WebSocket — sends to phone
5. Phone renders in monospace ScrollView
6. User types on phone → ws.send("ls -la\r") → ptyManager.write(3, "ls -la\r")
```

### Switching Tabs from Phone

```
1. Active machine: "MacBook Pro" (192.168.1.100:9001)
2. Aeronaut receives LeeContext via /context/stream WebSocket
3. Renders tabs[]: [{id:1, type:"editor", label:"main.py"}, {id:2, type:"terminal", label:"Terminal 1"}]
4. User taps "Terminal 1"
5. Aeronaut sends: POST http://192.168.1.100:9001/command
   { domain: "system", action: "focus_tab", params: { tab_id: 2 } }
6. Host receives → IPC to Electron renderer → tab switches on MacBook
7. ContextBridge emits 'change' → WebSocket broadcasts → Aeronaut updates active tab highlight
```

### Switching Machines

```
1. User is viewing MacBook Pro tabs
2. Taps machine switcher in app bar → selects "Mac Mini (CI)"
3. Aeronaut closes WebSocket to 192.168.1.100:9001
4. Opens WebSocket to 192.168.1.101:9001/context/stream
5. Receives LeeContext for Mac Mini — different tabs, different workspace
6. UI updates: new tab list, new workspace name in header
7. Previous machine's last-known state is cached locally
```

### Asking Hester a Question by Voice

```
1. Active machine: "MacBook Pro" — Hester at 192.168.1.100:9000
2. User holds voice button on Hester screen
3. iOS speech-to-text: "What does the canvas reactor do?"
4. Aeronaut sends: POST http://192.168.1.100:9000/context/stream
   { session_id: "aeronaut-abc", message: "What does the canvas reactor do?" }
5. SSE stream begins:
   event: phase → { phase: "thinking", iteration: 1 }
   event: phase → { phase: "acting", tool_name: "read_file", tool_context: "canvas_reactor.py" }
   event: phase → { phase: "observing", iteration: 1 }
   event: response → { text: "The CanvasReactor handles reactive canvas pushes..." }
   event: done
5. Aeronaut renders phases in real-time, then shows final response
6. Optional: TTS playback of response (iOS native)
```

## Security Considerations

- **LAN-only by default** — no ports exposed to internet
- **Bearer token auth** — generated per-machine, stored in iOS Keychain
- **Per-machine tokens** — each Lee instance has its own `~/.lee/aeronaut.token`; compromising one doesn't compromise others
- **No code editing** — editor view is read-only; reduces blast radius
- **Terminal input is opt-in** — can be disabled per-machine in config
- **Hester boundaries still apply** — no production data, no code changes, suggest only
- **VPN for remote** — WireGuard encrypted tunnel via Pi, not port forwarding
- **Token rotation** — `lee aeronaut rotate-token` regenerates the token and shows new QR

## Naming

**Aeronaut** — Lee Scoresby's profession. An aeronaut navigates from above, seeing the full landscape. Aeronaut gives you that aerial view of your development environment from wherever you are.

The trio:
- **Lee** — the editor (the balloon, the vehicle)
- **Hester** — the daemon (the intelligence, the awareness)
- **Aeronaut** — the mobile companion (the vantage point, the overview)
