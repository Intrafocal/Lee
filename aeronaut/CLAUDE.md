# Aeronaut — working notes

Flutter client for Lee + Hester over the LAN. Read `README.md` first for what
the app is, how to run it, and the manual test checklist; this file is the
map for editing it.

## Scope

Current milestone: **pair once, see and steer every Lee window, ask Hester
cheaply.**

Kept: structured live view of the IDE, one-tap focus/spawn, terminal I/O,
cheap Hester chat, machine health, a read-only file viewer (markdown/code/
images) and a Files browser (see "Tab type support" below).

Cut, on purpose — don't re-add without a decision: DevOps dashboard (the stub
screen was deleted), Library screen, in-app editing (the viewer is
read-only), voice input, a bespoke VPN (use Tailscale).

## Stack

| Piece | Choice |
|-------|--------|
| Framework | Flutter (3.29+; developed on 3.41.6 / Dart 3.11) |
| State | `flutter_riverpod` 2.x, `StateNotifier` pattern |
| HTTP / WS | `http`, `web_socket_channel` 3.x |
| Terminal | `xterm` 4.x |
| Markdown | `flutter_markdown_plus` (the maintained fork of the discontinued `flutter_markdown`; identical API) |
| QR | `mobile_scanner` 7.x |
| SVG | `flutter_svg` 2.x (file viewer's image kind; actively maintained, no native deps) |
| Storage | `shared_preferences` |
| Models | `equatable`, hand-written JSON — **no codegen**, no `build_runner` |

No syntax highlighter was added for the code viewer (`file_viewer_screen.dart`'s
`_CodeView`) — plain monospace with a line-number gutter. Pulling in a
highlighter (e.g. `flutter_highlight`) is a reasonable follow-up but wasn't
justified for this pass; note it here rather than re-litigating the choice.
Same reasoning for PDF: no PDF-rendering package was added, so `pdf`-kind
files show metadata (path/size) instead of a rendered page — see the file
viewer table entry above.

`flutter_riverpod` stays on 2.x: 3.x moves `StateNotifier` into a legacy
import and wants the `Notifier` API, which is a rewrite of all eight
providers rather than a version bump.

## Layout

See the tree in `README.md`. The shape that matters:

- `models/lee_context.dart` mirrors `electron/src/shared/context.ts` and the
  wider `Tab['type']` union in `electron/src/renderer/components/TabBar.tsx`.
- `services/*_api.dart` are thin, stateless-per-call HTTP clients; they take a
  `Machine` and are constructed ad hoc at call sites.
- `providers/` holds all mutable state. Nothing else keeps state.
- `screens/` are `ConsumerWidget` / `ConsumerStatefulWidget`.

## Things to know before editing

**Tab types.** `TabType.fromString` falls back to `TabType.unknown`, *never*
to `terminal` — an unknown type renders a read-only generic view with a Focus
button. When Lee gains a tab type, add it to the `TabType` enum, `label`,
`iconForTabType` in `widgets/tab_bar.dart`, and the wire-value test in
`test/widget_test.dart`. Everything else keeps working without the addition.

**PTY, not type name.** `TabContext.opensTerminal` is `ptyId != null`. The
terminal (xterm) view is for tabs Lee actually backed with a process. Both
`ptyId` and `pty_id` are accepted on the wire.

**File content.** Editor-like tabs get their content from
`LeeContext.editorFor(tab)`, not from `TabContext.filePath` (that field is
parsed defensively but Lee doesn't currently send it — see "Tab type
support" for the full wire-payload story). Fetching the actual bytes goes
through `services/fs_api.dart` (`GET /fs/read`, `GET /fs/list` on Lee,
added alongside this) — same bearer auth and 401 handling as `LeeApi`.

**Auth.** Both servers require `Authorization: Bearer <token>` on every route
except `GET /health`; WebSockets take `?token=`. The token is
`~/.lee/api-token` on the Lee machine and persists across Lee restarts.
Every 401 goes through `ApiAuth.reportUnauthorized` →
`authGuardProvider` → machine marked `unauthorized`, WebSocket torn down, and
"Token rejected. Re-pair this machine." in the banner. Never swallow a 401 in
a new API method: call `_isUnauthorized(response)` on the way past.

**Health probes.** Machine reachability uses `LeeApi.probe()` (authenticated
`GET /windows`), not `GET /health`, so a rejected token shows up as
`MachineHealth.unauthorized` rather than a false "online".

**Pairing payload.** Built by `aeronaut:get-pairing-qr` in
`electron/src/main/main.ts`:
`{ name, host, hostPort, hesterPort, token }`. The parser in
`qr_scanner_screen.dart` also accepts `apiPort` / `leePort` as aliases of
`hostPort` and `daemonPort` for `hesterPort`, and numbers sent as strings, so
a rename on the Lee side doesn't strand installed builds. Re-pairing the same
`host:hostPort` updates the saved machine in place.

**Multi-window.** One machine can run several Lee windows. `windowsProvider`
polls `GET /windows`; every command carries `window_id`; the context stream is
filtered by window id in `connection_provider.dart`.

## Tab type support

Audit of all 26 `Tab['type']` wire values in
`electron/src/renderer/components/TabBar.tsx`, what Lee renders for each
(`App.tsx`'s `renderTab`), what actually reaches Aeronaut over the context
stream today, and what this build does with it.

**The wire payload gap, found doing this audit.** `App.tsx`'s
`lee.context.update()` call maps every tab to exactly
`{ id, type, label, ptyId, dockPosition, state }` before sending it — despite
`TabContext` in `context.ts` declaring `provider`, and despite `TabData` in
the renderer carrying `filePath`, `browserUrl`, `machineConfig`, and
`workstreamId`. So:

- Editor-like tabs (`file`, `editor-panel`, and legacy `editor`) get their
  path for free anyway — Lee separately maintains a real per-tab
  `context.editors: Record<tabId, EditorContext>` (file/language/cursor/
  modified), which *is* sent and which this app now reads via
  `LeeContext.editorFor(tab)`. This was already on the wire and simply never
  parsed on this side (tracked as punch-list D10); it's the thing that makes
  the new file viewer possible at all.
- Browser tabs are the same story: `context.browsers[tab.id]` (url/title/
  loading) is real and already parsed.
- **`kicad`/`model`/`pdf`/`binary`/`spyglass`/`workstream` tabs have no path
  on the wire at all.** Their `filePath`/`machineConfig`/`workstreamId` live
  only in the renderer's local `TabData` and are never reported to
  `ContextBridge`. Fixing that means editing `App.tsx`'s
  `lee.context.update()` call, which is out of scope here (this pass was
  restricted to read-only additions in `api-server.ts`); `TabContext` parses
  a `filePath`/`browserUrl` field defensively so a future Lee change needs no
  client update, but until Lee sends it, these tabs cannot show their path
  from the context stream alone. The generic view says so plainly and offers
  the Files browser as a workaround instead of guessing.
- **Agent `provider` is the same gap** — the type badge for `agent` tabs
  would show "Agent (claude)" if Lee sent it, but it never does, so it always
  shows plain "Agent". Not a client bug; nothing to fix here.

| Wire type | Lee renders | Extra fields actually on the wire | Aeronaut before this work | Aeronaut now |
|---|---|---|---|---|
| `terminal` | `TerminalPane` (xterm) | — | xterm | xterm (unchanged) |
| `editor` | `TerminalPane` — legacy OSC-driven Python Textual editor in a PTY (that editor is otherwise deleted, see punch-list G1; this path is likely dead) | `context.editors[id]` if the legacy path still reports one | metadata-only (`EditorScreen`, no content) | `EditorScreen` embeds `FileViewerScreen`: real content, or "No file open" if nothing was ever reported |
| `editor-panel` | `EditorPanel` (React code editor, no PTY) | `context.editors[id]`: file, language, cursor, selection, modified | metadata-only | full content viewer (markdown/code/image), see below |
| `file` | `EditorPanel` | `context.editors[id]` | metadata-only | same upgrade as `editor-panel` |
| `files` | `FileTreePane` (React file tree) | — | nothing (fell to the generic view) | `FilesBrowserBody`: live `/fs/list` tree, lazy-expanding directories, tap a file to view it; also reachable from a Files icon in the home screen app bar even with no `files` tab open in Lee |
| `browser` | `BrowserPane` (embedded webview + CDP) | `context.browsers[id]`: url, title, loading | CDP screencast (already full-featured) | unchanged screencast + "Open in Safari" action, seeded from `browsers[id].url` before the cast connects |
| `hester` | xterm if `ptyId`, else Hester chat | `ptyId` | xterm / `HesterScreen` chat | unchanged |
| `claude` | xterm (Claude Code CLI) | `ptyId` | xterm | unchanged |
| `git` | xterm (lazygit) | `ptyId` | xterm | unchanged |
| `docker` | xterm (lazydocker) | `ptyId` | xterm | unchanged |
| `flutter` | xterm (flx) | `ptyId` | xterm | unchanged |
| `k8s` | xterm (k9s) | `ptyId` | xterm | unchanged |
| `hester-qa` | xterm if `ptyId`, else chat | `ptyId` | xterm / chat | unchanged |
| `devops` | xterm (Hester devops TUI) | `ptyId` | xterm | unchanged |
| `system` | xterm (btop) | `ptyId` | xterm | unchanged |
| `sql` | xterm (pgcli) | `ptyId` | xterm | unchanged |
| `library` | `LibraryPane` (React snippets/bookmarks, no PTY) | — | generic read-only view | unchanged — kept generic per this task's scope |
| `workstream` | `WorkstreamPane` (React task tracker, no PTY) | — (`workstreamId` is client-only) | generic | unchanged |
| `spyglass` | `SpyglassPane` (remote machine browser+cast, no PTY) | — (`machineConfig` is client-only) | generic | unchanged |
| `bridge` | xterm (ssh to a remote TUI) | `ptyId` | xterm | unchanged |
| `custom` | xterm (arbitrary configured TUI) | `ptyId` | xterm | unchanged |
| `agent` | xterm if `ptyId`, else chat | `ptyId`; `provider` declared but never sent (see above) | xterm/chat, no provider badge | unchanged — provider badge stays generic until Lee sends it |
| `kicad` | `KiCadPane` (KiCanvas, no PTY) | — (`filePath` is client-only) | generic | generic view now fetches `/fs/read?stat=1` metadata *if* `filePath` is ever present (forward-compat only), else explains the gap and offers a **Browse Files** button |
| `model` | `ModelViewerPane` (three.js STL/glTF/STEP, no PTY) | — | generic | same as `kicad` |
| `pdf` | `PdfPane` (PDF.js, no PTY) | — | generic | same as `kicad` |
| `binary` | `BinaryFilePane` (hex interstitial, no PTY) | — | generic | same as `kicad` |

New/changed screens: `screens/file_viewer_screen.dart` (markdown via
`flutter_markdown_plus`, monospace+line-numbers code, inline images via
`Image.memory`/`flutter_svg`, PDF placeholder, generic-text-with-64KB-cap
fallback), `screens/files_screen.dart` (`FilesBrowserBody` + `FilesScreen`),
`screens/editor_screen.dart` (now takes a `TabContext` and embeds the file
viewer instead of showing metadata only), `screens/browser_screen.dart`
("Open in Safari"), `screens/home_screen.dart`'s `_GenericTabView` (file-
backed metadata section + Browse Files button).

New Lee-side endpoints backing this: `GET /fs/read` and `GET /fs/list` in
`electron/src/main/api-server.ts` — see the root `CLAUDE.md`'s Unified
Command API section for the shapes. No `/fs/workspaces` endpoint was added:
`GET /windows` already returns `{ id, workspace, focused }` for every open
window, which is what a workspace picker needs.

## Checks

```bash
flutter pub get
flutter analyze     # must be clean — `dart fix --apply` handles the lint churn
flutter test
flutter build web              # fast smoke build
flutter build ios --no-codesign
```

Analyzer settings come from `flutter_lints` 6.

## Related

- `../CLAUDE.md` — Lee
- `../hester/CLAUDE.md` — Hester daemon
- `../docs/Aeronaut.md` — design notes, parked ideas
- `../docs/plans/2026-09-14-punch-list.md` — section D tracks this app
