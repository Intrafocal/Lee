# Aeronaut

Lee's mobile companion. A Flutter app (iOS / Android / web) that pairs with one
or more machines running [Lee](../CLAUDE.md) and its Hester daemon, shows the
IDE's live state, steers it, and asks Hester questions — over the LAN, with no
cloud in the path.

Aeronaut is **not** a remote desktop. It never streams the desktop; it reads
Lee's structured context over a WebSocket and renders it as native UI.

> Named for Lee Scoresby's profession in *His Dark Materials* — the aeronaut
> navigates from above and sees the whole picture.

## What it does

**Milestone: pair once, see and steer every Lee window, ask Hester cheaply.**

- **Pair once** — scan the QR from Lee (View ▸ Aeronaut Pairing). Host, ports
  and bearer token arrive in one scan and persist on the phone.
- **See** — a live tab strip for whichever Lee window you pick, plus the
  editor's current file, cursor and modified flag; read-only rendering of
  the file itself (markdown, source with line numbers, images) and a Files
  browser rooted at the workspace.
- **Steer** — tap a tab to focus it on the desktop; spawn a terminal or any
  TUI Lee has configured; type into a real terminal (full xterm emulation).
- **Ask** — Hester chat with SSE streaming and ReAct phase indicators,
  session history, and the context bundle browser.

**Out of scope** (deliberately cut): the DevOps dashboard, in-app editing
(the file viewer is read-only), voice input, and any VPN of our own (use
Tailscale).

## Running it

Requires Flutter 3.29+ (developed against 3.41.6, Dart 3.11).

```bash
cd aeronaut
flutter pub get
flutter run -d chrome        # web — fastest loop, no camera so pair manually
flutter run -d <device-id>   # iOS / Android
flutter analyze
flutter test
```

### Against a local Lee

1. Start Lee (`cd electron && npm run dev`). It listens on `:9001`; the Hester
   daemon it spawns listens on `:9000`. Both bind `0.0.0.0` so the LAN can
   reach them.
2. Get the token: `cat ~/.lee/api-token`. It persists across launches, so a
   phone paired once stays paired.
3. Pair:
   - **QR** — in Lee, View ▸ Aeronaut Pairing, then tap the QR icon in
     Aeronaut's Machines screen.
   - **Manually** — the **+** button: name, host (your Mac's LAN IP, not
     `localhost`, unless you're running Aeronaut on the web on the same Mac),
     host port `9001`, Hester port `9000`, and the token.
4. Tap the machine to connect.

Aeronaut on the web can't open the camera, and browsers block requests to a
LAN host from a page served elsewhere unless CORS allows it — Lee's API server
sends permissive CORS headers, so `flutter run -d chrome` against
`127.0.0.1:9001` works. If the app hangs on "Connecting…", check
`http://localhost:9001/health` in the same browser first.

## Manual test checklist

Run this with a phone after any change to pairing, context, or the API.
`~/.lee/api-token` must exist on the Mac and Lee must be running.

| # | Step | Expect |
|---|------|--------|
| 1 | **Pair via QR.** Lee ▸ View ▸ Aeronaut Pairing; scan from Aeronaut's Machines screen. | Machine appears with a green dot. Scanning the same Mac again refreshes the entry instead of adding a duplicate. |
| 2 | **Context stream, window 1.** Tap the machine. | Tab strip matches the focused Lee window. Editor tabs show the open file; viewer tabs (pdf, model, kicad) show a type badge, a Focus button, and a Browse Files fallback — never a blank terminal. |
| 3 | **Context stream, window 2.** Open a second Lee window on another workspace; use the workspace switcher under the machine name. | Tab strip swaps to the second window's tabs; workspace name in the app bar changes. |
| 4 | **Focus a tab.** Tap any tab in the strip. | That tab comes forward on the desktop, in the right window. |
| 5 | **Terminal.** New tab ▸ Terminal, then type `ls` and Return. | Output renders with colors; the same terminal exists on the desktop. Escape sequences (e.g. `htop`, `lazygit`) render correctly. |
| 6 | **Hester.** Tap the Hester icon; ask one question. | Phase indicator cycles preparing → thinking → … ; a markdown answer arrives. |
| 7 | **Machine health.** Info icon in the app bar (or long-press the machine card ▸ Health & workspace). | Lee version, "token accepted", Hester `auth: bearer`, and the daemon's current workspace path. |
| 8 | **Pairing survives a restart.** Quit Lee, relaunch it, pull-to-refresh in Aeronaut. | Reconnects with the same token — no re-pair. (The Lee window ids change, so re-pick the workspace.) |
| 9 | **Bad token.** Edit the machine's token to garbage (or rotate `~/.lee/api-token` and restart Lee). | A red banner reads "Token rejected. Re-pair this machine.", the machine card turns amber, and the reconnect loop stops instead of spinning. Re-pair via QR clears it. |
| 10 | **View a markdown file.** Open a `.md` file in Lee's editor (or tap one from Files). | Renders as formatted markdown, not raw text; path, size and mtime show in the header; the refresh icon re-fetches after editing the file on the desktop. |
| 11 | **Browse files.** Tap the Files icon in the app bar (works even with no `files` tab open in Lee). | Tree rooted at the workspace; tapping a directory expands it in place; tapping a file opens the viewer; a code file shows monospace with line numbers, an image renders inline. |

## Architecture

```
lib/
├── main.dart, app.dart              # ProviderScope, MaterialApp, dark theme
├── models/
│   ├── machine.dart                 # a paired Lee instance (host, ports, token)
│   ├── lee_context.dart             # LeeContext / TabContext / TabType / EditorContext
│   ├── fs_entry.dart                # /fs/read /fs/list response models + FileViewKind classifier
│   └── hester_models.dart           # ChatMessage, PhaseEvent, ReActPhase, BundleSummary
├── services/
│   ├── lee_api.dart                 # HTTP client for Lee  (:9001)
│   ├── hester_api.dart              # HTTP client for Hester (:9000)
│   ├── fs_api.dart                  # GET /fs/read, GET /fs/list
│   ├── api_auth.dart                # shared 401 sink + ApiStatus
│   └── machine_store.dart           # SharedPreferences persistence
├── providers/                       # Riverpod StateNotifiers
│   ├── machines_provider.dart       # saved machines, active machine, health probes
│   ├── connection_provider.dart     # context WebSocket + auto-reconnect
│   ├── context_provider.dart        # LeeContext stream + convenience selectors
│   ├── windows_provider.dart        # GET /windows, active window selection
│   ├── pty_provider.dart            # per-PTY WebSocket → xterm Terminal
│   ├── browser_cast_provider.dart   # remote browser frames
│   ├── hester_provider.dart         # Hester SSE chat
│   └── auth_provider.dart           # turns a 401 into UI state
├── screens/
│   ├── machines_screen.dart         # machine list (launch screen)
│   ├── add_machine_screen.dart      # manual pairing form
│   ├── qr_scanner_screen.dart       # QR pairing
│   ├── machine_detail_screen.dart   # Lee + Hester health, daemon workspace
│   ├── home_screen.dart             # tab strip + per-tab routing
│   ├── editor_screen.dart           # live cursor/language bar + embedded FileViewerScreen
│   ├── file_viewer_screen.dart      # markdown/code/image/pdf-placeholder/text file renderer
│   ├── files_screen.dart            # Files browser (FilesBrowserBody + full-route FilesScreen)
│   ├── terminal_screen.dart         # xterm view over a PTY
│   ├── browser_screen.dart          # remote browser cast + "Open in Safari"
│   ├── hester_screen.dart           # chat
│   ├── sessions_screen.dart         # Hester sessions
│   └── bundles_screen.dart          # context bundles
├── widgets/                         # tab strip, machine card/switcher, auth banner, …
└── theme/                           # GitHub-dark palette + spacing constants
```

### Tab routing

`_TabContent` in `home_screen.dart` picks a view, in order:

1. editor-like types (`editor`, `editor-panel`, `file`) → `EditorScreen`,
   which reads the real file path from `LeeContext.editorFor(tab)` (Lee's
   per-tab `context.editors` map) and renders it with `FileViewerScreen`
2. `browser` → `BrowserScreen`
3. `files` → `FilesBrowserBody` (embedded, no extra chrome)
4. **any tab with a `ptyId`** → `TerminalScreen` (xterm)
5. agent-like types with no PTY (`hester`, `hester-qa`, `claude`, `agent`) →
   `HesterScreen`
6. everything else, including types this build doesn't know → a read-only
   generic view: title, type badge, Focus button, and — for `pdf`/`model`/
   `kicad`/`binary` — a Browse Files button (see `CLAUDE.md`'s "Tab type
   support" for why those four can't show their path directly yet)

The PTY check is on `ptyId`, not on the type name, so viewer tabs Lee grows
later (`pdf`, `model`, `kicad`, `binary`) and React panes (`files`, `library`,
`workstream`) can't end up rendering as blank terminals.

The Files browser is also reachable from a **Files** icon in the home
screen's app bar (pushes the full-route `FilesScreen`), independent of
whether a `files` tab happens to be open in Lee.

### Endpoints and auth

Every route on both servers requires `Authorization: Bearer <token>` except
`GET /health`. WebSocket upgrades can't carry a header, so the token rides as
`?token=`. The token is `~/.lee/api-token` on the Lee machine; it persists
across Lee launches.

**Lee, `:9001`**

| Method | Route | Used for |
|--------|-------|----------|
| GET | `/health` | reachability (unauthenticated) |
| GET | `/windows` | open Lee windows; also the authenticated probe |
| GET | `/context` | full context snapshot |
| GET | `/fs/read?path=&stat=` | file content (utf8/base64, 2 MB cap) or, with `stat=1`, just metadata |
| GET | `/fs/list?path=` | one directory's entries (dirs first); defaults to the focused window's workspace |
| POST | `/command` | `system` / `editor` / `tui` / `panel` / `browser` domains |
| WS | `/context/stream` | live `LeeContext` |
| WS | `/pty/:id/stream` | terminal I/O |
| WS | `/browser/:id/cast` | browser frames |

**Hester, `:9000`**

| Method | Route | Used for |
|--------|-------|----------|
| GET | `/health` | status, `auth`, current `workspace`, model |
| POST | `/context/stream` | chat (SSE, ReAct phases) |
| POST | `/context` | synchronous chat |
| GET | `/sessions`, `/session/:id/history` | session list and history |
| DELETE | `/session/:id` | delete a session |
| GET | `/bundles`, `/bundles/:id` | context bundles |

A 401 from either client is funnelled through `services/api_auth.dart` to
`authGuardProvider`, which marks the machine `unauthorized`, tears down the
context WebSocket (no reconnect storm), and shows
"Token rejected. Re-pair this machine."

`/fs/read` and `/fs/list` only serve paths under an open window's workspace
(symlinks resolved before the check) — a path outside every workspace is a
403, handled by `FsApi` as `FsErrorKind.forbidden`. A file over 2 MB is a
413 (still carries size/mtime/mime so the viewer can say how big it is); a
binary file type the viewer can't render is a 415. There's no
`/fs/workspaces` endpoint — `GET /windows` already returns
`{ id, workspace, focused }` for every window, which is what the Files
browser's root picker needs.

## Conventions

- **State**: Riverpod `StateNotifier`; `StreamProvider` for the context stream.
- **Models**: `Equatable`, hand-written `fromJson`/`toJson` (no codegen).
- **API clients**: take a `Machine`, own an `http.Client`, `dispose()` when done.
- **Colors and spacing**: `AeronautColors.*` / `AeronautTheme.spacing*` only.

## Related

- `../CLAUDE.md` — Lee
- `../hester/CLAUDE.md` — Hester daemon
- `../docs/Aeronaut.md` — design notes and parked ideas
- `CLAUDE.md` — working notes for agents editing this app
