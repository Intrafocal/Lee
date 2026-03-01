# Aeronaut - Lee's Mobile Companion

> Flutter cross-platform app connecting to Lee + Hester on the local network. Named after Lee Scoresby's profession in Philip Pullman's *His Dark Materials*.

## Overview

Aeronaut gives you mobile and web access to your Lee editor, terminals, and Hester AI daemon. It maintains live WebSocket connections to Lee instances and streams real-time context updates.

## Architecture

| Component | Technology |
|-----------|------------|
| Framework | Flutter 3.29.3, Dart SDK ^3.7.2 |
| State | flutter_riverpod (StateNotifier pattern) |
| HTTP | http package |
| WebSocket | web_socket_channel |
| Storage | shared_preferences |
| Markdown | flutter_markdown |
| Theme | GitHub dark + terminal green (Material 3) |

## Connection Model

A **Machine** represents a Lee + Hester instance:
- `host` + `hostPort` (default 9001) = Lee Host API
- `host` + `hesterPort` (default 9000) = Hester Daemon API
- WebSocket at `ws://host:9001/context/stream` for real-time LeeContext
- Machines persisted to SharedPreferences, health-pinged every 15 seconds

**Data flow:**
1. User adds machine → saved to SharedPreferences
2. User taps machine → sets active → WebSocket connects to Lee
3. LeeContext streams in (tabs, editor, panels, activity)
4. Home screen renders tab strip, routes to type-appropriate screens
5. Hester chat: POST /context/stream (SSE) → parse phases → show response

## Directory Structure

```
lee/aeronaut/
├── lib/
│   ├── main.dart                      # Entry point, ProviderScope
│   ├── app.dart                       # MaterialApp with AeronautTheme
│   ├── models/
│   │   ├── machine.dart               # Machine (Equatable, JSON)
│   │   ├── lee_context.dart           # LeeContext, TabContext, TabType, EditorContext
│   │   └── hester_models.dart         # ChatMessage, PhaseEvent, ReActPhase, BundleSummary, HesterChatState
│   ├── services/
│   │   ├── machine_store.dart         # SharedPreferences persistence
│   │   ├── lee_api.dart               # HTTP client for Lee Host (9001)
│   │   └── hester_api.dart            # HTTP client for Hester daemon (9000)
│   ├── providers/
│   │   ├── machines_provider.dart     # MachinesNotifier: list + active + health pinging
│   │   ├── connection_provider.dart   # ConnectionNotifier: WebSocket + auto-reconnect (3s)
│   │   ├── context_provider.dart      # leeContextProvider (stream), tabsProvider, editorProvider
│   │   ├── pty_provider.dart          # PtyNotifier: family provider keyed on PTY ID
│   │   └── hester_provider.dart       # HesterChatNotifier: SSE streaming + phase state
│   ├── screens/
│   │   ├── machines_screen.dart       # Machine list (start screen)
│   │   ├── add_machine_screen.dart    # Add machine form
│   │   ├── home_screen.dart           # Tab strip + content routing
│   │   ├── editor_screen.dart         # Editor tab
│   │   ├── terminal_screen.dart       # PTY terminal
│   │   ├── browser_screen.dart        # Browser tab
│   │   ├── hester_screen.dart         # Chat with SSE + ReAct phases + markdown
│   │   ├── sessions_screen.dart       # Session list/picker/delete
│   │   ├── bundles_screen.dart        # Context bundle browser + detail
│   │   └── devops_screen.dart         # Placeholder
│   ├── widgets/
│   │   ├── machine_card.dart          # Machine list tile with status dot
│   │   ├── machine_switcher.dart      # Active machine dropdown (app bar)
│   │   ├── tab_bar.dart               # Lee tab strip
│   │   ├── new_tab_sheet.dart         # Bottom sheet for creating tabs
│   │   ├── terminal_output.dart       # Terminal text renderer
│   │   └── react_phase_indicator.dart # Animated pulsing phase indicator
│   └── theme/
│       ├── aeronaut_colors.dart       # Color palette (bgPrimary, bgSurface, accent, etc.)
│       └── aeronaut_theme.dart        # Material theme, text styles, spacing constants
├── test/
│   └── widget_test.dart               # Machine + LeeContext model tests
├── pubspec.yaml
└── web/                               # Flutter web scaffold
```

## Tab Routing (home_screen.dart)

`_TabContent` routes by `TabType`:

| Tab Type | PTY? | Screen |
|----------|------|--------|
| `editor` | - | EditorScreen |
| `browser` | - | BrowserScreen |
| `hester` / `hesterQa` / `claude` | yes | TerminalScreen |
| `hester` / `hesterQa` / `claude` | no | HesterScreen (real chat) |
| anything else | yes | TerminalScreen |
| anything else | no | GenericTabView |

## API Endpoints

### Lee Host API (port 9001)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Health check |
| GET | `/context` | Full context snapshot |
| POST | `/command` | Send commands (domain: system/editor/tui/panel/browser) |
| WS | `/context/stream` | Real-time LeeContext updates |
| WS | `/pty/:id/stream` | PTY data stream |

### Hester Daemon API (port 9000)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Health check |
| POST | `/context/stream` | SSE streaming with ReAct phases |
| POST | `/context` | Synchronous request/response |
| GET | `/sessions` | List session IDs |
| GET | `/session/:id/history` | Conversation history |
| DELETE | `/session/:id` | Delete session |
| GET | `/bundles` | List context bundles |
| GET | `/bundles/:id` | Get bundle content |

## SSE Streaming (hester_provider.dart)

`HesterChatNotifier` handles SSE:

1. Adds user `ChatMessage` to state
2. POST to `/context/stream` with `{session_id, source: "Aeronaut", message}`
3. Reads chunked byte stream → UTF-8 decode → split on `\n\n`
4. Parses `event:` + `data:` lines per SSE block
5. `phase` → updates `currentPhase` (drives `ReActPhaseIndicator`)
6. `response` → appends assistant `ChatMessage` with markdown content
7. `error` → sets error state
8. `done` → clears streaming state

## Theme

**AeronautColors** — GitHub dark palette:
- Backgrounds: `0xFF0D1117` (primary), `0xFF161B22` (surface), `0xFF21262D` (elevated)
- Text: `0xFFE6EDF3` (primary), `0xFF8B949E` (secondary), `0xFF484F58` (tertiary)
- Accent: `0xFF3FB950` (terminal green)
- Status: green (online), red (offline), amber (warning), blue (info)

**AeronautTheme** — Spacing constants:
- `spacingXs=4`, `spacingSm=8`, `spacingMd=16`, `spacingLg=24`, `spacingXl=32`
- `radiusSm=6`, `radiusMd=10`, `radiusLg=14`
- Fonts: SF Pro Text (body), JetBrainsMono (code)

**Markdown** — Dark-themed stylesheet: green inline code, code blocks with border, blue links, accent blockquote bars.

## Running

```bash
cd lee/aeronaut

flutter run -d chrome    # Web
flutter run -d ios       # iOS
flutter run -d android   # Android
flutter analyze          # Lint
flutter test             # Tests
```

## Adding a Machine

1. Tap **+** on Machines screen
2. Enter: Name, Host (IP/hostname), Host Port (9001), Hester Port (9000)
3. Optional: Bearer token
4. Save — app pings and shows online/offline status

## Conventions

- **State**: Riverpod `StateNotifier` for mutable state, `StreamProvider` for streams
- **Models**: `Equatable` for value equality, `fromJson`/`toJson` for serialization
- **Screens**: `ConsumerWidget` or `ConsumerStatefulWidget`
- **API clients**: Take a `Machine`, use `http.Client`, call `dispose()` when done
- **Family providers**: Per-PTY connections keyed on `int` PTY ID
- **Colors**: Always use `AeronautColors.*`, never hardcode
- **Spacing**: Always use `AeronautTheme.spacing*` / `AeronautTheme.radius*`

## CORS (Flutter Web)

Lee's API server (`lee/electron/src/main/api-server.ts`) has CORS middleware allowing all origins. If Aeronaut web shows a white screen or spins on "Connecting...":
1. Restart Lee to reload CORS middleware
2. Check `http://localhost:9001/health` from browser
3. Check browser console for CORS errors

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| flutter_riverpod | ^2.4.0 | State management |
| http | ^1.1.0 | REST API calls |
| web_socket_channel | ^2.4.0 | WebSocket connections |
| shared_preferences | ^2.2.2 | Machine persistence |
| equatable | ^2.0.5 | Value equality |
| uuid | ^4.2.1 | Session IDs |
| url_launcher | ^6.2.1 | Open links from markdown |
| flutter_markdown | ^0.7.7 | Markdown rendering |

## Related Documentation

- `lee/CLAUDE.md` — Lee editor
- `lee/hester/CLAUDE.md` — Hester daemon
- `lee/docs/Aeronaut.md` — Design notes
