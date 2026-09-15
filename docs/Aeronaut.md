# Aeronaut — Lee's Mobile Companion

> Your IDE from your pocket. Not a remote desktop — a native mobile client for
> Lee's nervous system.

Design notes. For how to build, run and test the app, see
`aeronaut/README.md`; for editing conventions, `aeronaut/CLAUDE.md`.

## Overview

**Aeronaut** is a Flutter app that connects to one or more running Lee
instances on the local network and renders their structured state as native
mobile UI. It doesn't stream pixels, so it works over cellular, uses almost no
bandwidth, and feels like a native app — because it is one.

Named for Lee Scoresby's profession in *His Dark Materials*: the aeronaut
navigates from above and sees the whole picture.

The trio:

- **Lee** — the editor (the balloon, the vehicle)
- **Hester** — the daemon (the intelligence, the awareness)
- **Aeronaut** — the mobile companion (the vantage point)

**Design philosophy:** most of what you want from your phone isn't coding —
it's monitoring, reviewing, querying, and kicking off tasks.

## Current milestone

**Pair once, see and steer every Lee window, ask Hester cheaply.**

Kept:

- structured live view of the IDE (tabs, editor file, cursor, workspace)
- one-tap focus and TUI spawn, per Lee window
- a real terminal (xterm emulation over the PTY WebSocket)
- cheap Hester chat with ReAct phases, sessions and context bundles
- machine health, including which workspace the daemon is pointed at

Cut:

- DevOps dashboard (the stub screen is deleted)
- Library, Files and code-viewer milestones
- a Raspberry Pi WireGuard gateway — use Tailscale
- voice input

## Multi-machine, multi-window

Aeronaut treats each Lee instance as a named **machine**, identified by
`(host, hostPort)`:

| Machine | Address | Use case |
|---------|---------|----------|
| MacBook Pro | 192.168.1.100:9001 | primary dev |
| Mac Mini | 192.168.1.101:9001 | long CI runs, GPU tasks |

Machines persist on the phone (SharedPreferences) and are probed in the
background for reachability.

A single Lee process can hold several **windows**, one workspace each.
`GET /windows` lists them; Aeronaut picks one with the workspace switcher,
filters the context stream by `window_id`, and stamps every command with it.
This replaced the older idea of one Machine entry per workspace.

## Architecture

```
┌──────────────────────────────┐          ┌────────────────────────────────┐
│ Aeronaut (iPhone)            │  WiFi    │ Mac (192.168.1.100)            │
│                              │◄────────►│  Lee     :9001                 │
│  Machines → Home → Terminal  │          │  Hester  :9000                 │
│                   Hester     │          │   window 1: lee                │
│                   Detail     │          │   window 2: graphosyne         │
└──────────────────────────────┘          └────────────────────────────────┘
```

| Port | Protocol | Purpose |
|------|----------|---------|
| 9001 | WS `/context/stream` | real-time IDE state |
| 9001 | WS `/pty/:id/stream` | terminal output and input |
| 9001 | WS `/browser/:id/cast` | remote browser frames |
| 9001 | HTTP `/context`, `/windows`, `/command` | snapshot, windows, remote control |
| 9000 | HTTP + SSE `/context/stream` | Hester chat |
| 9000 | HTTP `/health`, `/sessions`, `/bundles` | daemon status, history, bundles |

The endpoint tables in `aeronaut/README.md` are the authoritative list.

## Auth

Both servers require `Authorization: Bearer <token>` on every route except
`GET /health`; WebSocket upgrades carry `?token=` instead, since the browser
and `web_socket_channel` can't set a header on an upgrade.

- The token lives in `~/.lee/api-token` on the Lee machine (0600), generated
  once and **persistent across launches** — a phone paired once stays paired.
- One token covers Lee and Hester on that machine.
- Pairing is a QR code: `{ name, host, hostPort, hesterPort, token }`, built by
  `aeronaut:get-pairing-qr` in `electron/src/main/main.ts` and shown from
  View ▸ Aeronaut Pairing.
- A 401 is surfaced as "Token rejected. Re-pair this machine.", the machine is
  marked unauthorized, and the reconnect loop stops. It is never reported as a
  generic connection failure.

Rotating the token means deleting `~/.lee/api-token`, restarting Lee, and
re-scanning.

## Screens

| Screen | Content |
|--------|---------|
| Machines | saved machines, status dot (online / offline / token rejected), QR + manual add |
| Machine detail | Lee health and version, whether the token is accepted, Hester `auth`, the daemon's current workspace, model and tool count |
| Home | window switcher, tab strip from `LeeContext.tabs`, per-tab content, new-tab sheet from `availableTuis` |
| Terminal | xterm over `/pty/:id/stream`, real keyboard input, resize |
| Editor | current file, language, cursor, modified flag (read-only) |
| Browser | remote browser cast with touch/scroll/key forwarding |
| Hester | chat with SSE ReAct phases, markdown answers |
| Sessions / Bundles | Hester session picker and context bundle reader |

Tab routing rules, including the `unknown` fallback, are documented in
`aeronaut/README.md`.

## UX principles

1. **Read-heavy, write-light** — monitoring and reviewing, not editing.
2. **One-handed** — thumb-reachable controls, swipe navigation.
3. **Push, don't poll** — WebSocket for state, SSE for Hester.
4. **Offline-tolerant** — auto-reconnect, last-known state on drop; except on
   a rejected token, where retrying is pointless.
5. **Never a blank screen** — an unrecognised tab type still shows its title,
   a type badge and a Focus button.

## Data flow examples

### Viewing terminal output on the phone

```
1. Aeronaut connects: ws://192.168.1.100:9001/pty/3/stream?token=…
2. Host adds a listener on the existing PTY EventEmitter
3. Terminal output fans out to both the Electron renderer and the phone
4. Phone feeds the bytes into xterm.dart (escape sequences, alt screen, colors)
5. Typing on the phone → ws.send("ls -la\r") → ptyManager.write(3, …)
```

The PTY is unaware of how many listeners exist; a slow mobile client can only
grow its own send buffer.

### Switching tabs from the phone

```
1. Context arrives over /context/stream, filtered to the selected window
2. User taps "Terminal 1"
3. POST /command { domain: "system", action: "focus_tab",
                   params: { tab_id: 2, window_id: 3 } }
4. ContextBridge emits 'change' → the stream echoes the new active tab
```

### Asking Hester a question

```
1. POST :9000/context/stream { session_id, source: "Aeronaut", message }
2. event: phase → { phase: "thinking", iteration: 1 }
   event: phase → { phase: "acting", tool_name: "read_file", … }
   event: response → { text: "…" }
   event: done
3. Phases drive the indicator; the response renders as markdown
```

## Security

- LAN-only by default; nothing is exposed to the internet.
- Bearer token per machine, stored with the machine record on the phone.
- The editor view is read-only — no code editing from the phone.
- Hester's own boundaries still apply.
- For off-LAN access, use Tailscale: the machine keeps its address and token,
  and nothing in Lee, Hester or Aeronaut changes.

---

## Appendix: Ideas (parked)

Not planned. Kept here so the reasoning isn't lost.

**mDNS discovery.** Lee advertises `_lee._tcp` with TXT records for workspace
and name; Aeronaut lists instances instead of needing an IP. Pairing still
needs the token. (`package:nsd` on the Flutter side.)

**Notifications.** Task completion, QA results, service health, idle nudges.
Needs either a push relay or local notifications while foregrounded.

**Watch mode.** Keep the WebSocket alive in the background and surface
long-running tasks as iOS Live Activities.

**Library tab.** Tree-of-thought sessions over Hester's existing
`/library/...` endpoints — session list, node tree, per-node SSE chat, agent
mode selector, synthesis, doc and web search. No backend work needed.

**Files tab.** Needs three new REST endpoints on Lee (`/fs/readdir`,
`/fs/readFile`, `/fs/stat`; the filesystem is IPC-only today), then a
lazy-loading tree that opens files on the desktop.

**Code viewer.** Read-only syntax-highlighted view of the active file, on top
of the Files tab's `readFile`. Tap a line to send it to Hester. Full editing
stays out of scope; if it's ever wanted, a WebView around CodeMirror is the
pragmatic path.

**Pi VPN gateway.** WireGuard on a Raspberry Pi as the way back into the LAN.
Superseded by Tailscale.

**Voice input.** Hold-to-talk, iOS speech-to-text into the Hester chat, with
optional TTS playback of the answer.

**Machine reordering.** Drag to set a preferred order in the machines list.
