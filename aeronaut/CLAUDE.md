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

**Devices are Work · Review · Hester** (docs/plans/2026-09-28-tether-review-voice.md
§3.1, 2026-09-28): the phone reads and steers; it doesn't edit. Tabs, in
order: Work, Review, Hester, Machine (`screens/root_shell.dart`, `RootTab`).
- **Work** (`screens/work_screen.dart`, was Now): **Pick up** first
  (`widgets/pick_up_block.dart`, Lee `GET /tether` via `tetherProvider`: your
  last Desk card, its Area, the stopped-at line in Newsreader, up to five
  open questions; a tap opens the Page in Review through
  `reviewPageRequestProvider`), then the serif headline
  (`workLine`), waiting cards (`widgets/attention_tile.dart`: 44px Allow/Deny,
  the first three quick replies in a sideways scroll, swipe to snooze/dismiss
  (a swiped snooze leaves "Snoozed · Undo" for 5 s before it is sent),
  `⋯` for the rest), the Desk's "Still thinking?" push right after Pick up when one is open
  (`widgets/deep_idle_card.dart`: Extend, End and rate, Capture through Lee
  `POST /deep/idle-end` and `/tether/capture`), In flight (`widgets/in_flight_section.dart`: grouped rows
  with the "doing now" line and a token label), Progress. "In deep work"
  replaces Focus in the header while `snapshot.deep` is set. The header:
  Focus, Hand off, **Send to Lee**, Speak replies, Capture (+). Capture
  (`widgets/now_header_actions.dart`) goes to Ideas through Lee
  `POST /tether/capture` (spooled when Hester is away); its "Ideas" link
  opens Review › Drawer. The old "as exploration" toggle went with
  explorations.
- **One agent** (`screens/agent_screen.dart`): It asked / It said, Check in /
  Rename / Accept / Assign… (`widgets/agent_actions_row.dart`: the check-in
  through Lee's `/command` tab domain, the task writes straight to Hester's
  `/cockpit/tasks` routes), Allow/Deny,
  the four quick replies as a 2×2 grid, Updates, Along the way, and a pinned
  reply bar that sends through the item's Reply (disabled, "Reply from the
  Mac for now", when the agent has no open item).
- **Review** (`screens/review_screen.dart`, replaces Library): read-only,
  a segmented **Desk · Drawer · Files** (`reviewSectionProvider`). Desk:
  Areas on the Desk (`GET /tether/desk`) → `AreaScreen` (Pages, newest
  first) → `screens/page_screen.dart` (`GET /tether/pages/:id`: the markdown
  in Newsreader, `![…](assets/<name>)` fetched with the token from
  `GET /tether/pages/:id/assets/:name`, then Answers, Hand-offs, Open
  questions and References folded). Boards (`bd-…`, the `image` glyph; an
  Area row counts "2 Pages · 1 Board") open in `screens/board_screen.dart`
  through `openDeskCard` (every open in Review and Pick up goes through it):
  `GET /tether/boards/:id` (`TetherBoard`) and, when `has_preview`, the PNG
  from `GET /tether/boards/:id/preview` in an `InteractiveViewer` (a quiet
  placeholder otherwise), then its notes in Newsreader, its links (a tap
  opens that Page or Board), Asks and Hand-offs folded (`ReviewFold`,
  `ReviewEntry`, shared with the Page). Drawer (`GET /tether/drawer`): Stashed
  Areas → their Pages, and Ideas (no triage: that stays in Lee). Files:
  `FilesBrowserBody`, moved from Machine.
- **Hester**: the chat, with the mic, Send to Lee and Speak replies in its
  app bar.
- **Machine**: the machine list until one is chosen, then `HomeScreen`
  (the tab strip and the active tab) and "All machines". A PTY tab opens in
  Compose (below).

**Renames and removals (2026-09-28).** Carry → Tether (`models/tether.dart`,
`TetherResult`, ValueKeys `tether-*`, Lee `/tether/*`); Someday → Ideas
(`CaptureResult.ideaId`; the Someday screen, `SomedayItem` and Hester's
`/someday` calls are gone: the phone lists Ideas through Lee's
`/tether/drawer`); Put away → Stashed. **Open next is gone** (the button,
`OpenNext`, `/carry/open-next`). No aliases: an old Lee answers 404, and the
phone says "update Lee". `DigestSomeday` still mirrors the digest's
`someday` field, which is Hester's wire.

**Send to Lee** (§4; `widgets/send_to_lee_sheet.dart`, `widgets/composer.dart`,
`models/send_to_lee.dart` mirrors `SendTarget`/`SendItem`/`SendRequest` in
`electron/src/shared/tether.ts`, `services/tether_api.dart`
`POST /tether/send`, `GET /tether/targets`). The sheet offers Voice note,
Photo (camera), Screenshot (photo library), Scribble
(`screens/scribble_screen.dart`, PNG) and Text; several fit in one send (≤ 4
items, image ≤ 10 MB, text ≤ 20 000: `sendProblem`). "To: Taxonomy (the Page
you're on)" is Lee's focus; Change picks another. **Deliver** (plain) puts
it in the input; **Send** (phosphor, the one next step) also submits (Enter
in a tab, asked in Hester). A Page has only Deliver (then Deliver is the
phosphor one). Send never comes from voice; a failed send keeps the words.

**Compose in a tab** (§4.6; `screens/terminal_screen.dart`). A PTY tab opens
in **Compose**: the terminal is read-only (`readOnly`), and the `Composer`
below it targets the tab itself (`tabTarget`: `tab_kind` agent / terminal /
tui) through `POST /tether/send`, so text lands as one bracketed paste.
**Keys** is today's keystroke mode (the extra keys bar), remembered per tab
in SharedPreferences (`providers/keys_mode_provider.dart`,
`<machine id>:<pty id>`).

**Voice and readback** (§5.5; off unless Hester's `hester.voice.enabled`).
`models/voice.dart` mirrors `electron/src/shared/voice.ts` (keep them in
step: `appendTranscript`, the error codes, 16 kHz / 300 ms / 60 s).
`services/voice_api.dart` (`GET /voice`, `POST /voice/transcribe` with the
WAV as the raw body), `services/voice_recorder.dart` (`record`, WAV 16 kHz
mono, temp file deleted after reading; `VoiceRecorder` is the test seam),
`providers/voice_provider.dart` (capabilities cached 5 min and refetched
after a 503; one recording at a time; the cap auto-stops and still
transcribes; clips under 300 ms or below the silence peak are never
uploaded), `widgets/voice_button.dart` (`VoiceButton`: tap toggles, a hold
past 300 ms stops on release; the transcript goes into the field, caret at
the end, and focus returns; `VoiceStatusLine` under the field: elapsed,
Cancel, errors). The mic sits in the attention Reply field and the
one-agent reply bar (`input: 'voice'` on the reply), the capture sheets
(`input: 'voice'` on `/tether/capture`), Hester's input (`ask`) and every
Composer (`send`, tagged on the text item). Readback
(`providers/speech_provider.dart`, `services/speech_service.dart`
`flutter_tts`, `services/speech_sanitizer.dart`, vectors in
`test/speech_sanitizer_test.dart`): a voice message gets **only its next
reply** read, once: Hester's answer to a spoken question, or an agent's next
item after a spoken reply to it (approvals: title plus "Approve or deny on
screen."); a typed question or reply disarms it (2026-09-28: one voice
message used to switch readback on for good). "Speak replies"
(`SpeakerToggle`, in SharedPreferences) is manual only and reads every
Hester answer. Foreground only; recording stops it. The voice is iOS's
default for the language, i.e. the one chosen in Settings › Accessibility ›
Spoken Content (don't pick one in code). The listeners are in `RootShell`.
`theme/pending_icons.dart` now only holds `speakerOff`.

**Share extension** (`ios/LeeShare/`, target `LeeShare`, bundle
`com.intrafocal.aeronaut.LeeShare`, iOS 16+): "Lee" in the iOS share sheet
sends screenshots, photos (up to 4, downscaled to 2048 px JPEG), text or a
link to `POST /tether/send` with Deliver or Send, targets from
`GET /tether/targets`. Native SwiftUI, no Flutter. It reads the active
Machine (URL, token, name, workspace) from the App Group
`group.com.intrafocal.aeronaut`, which Aeronaut writes through the
`aeronaut/app_group` channel (`services/app_group.dart`, `AppGroupBridge` in
`AppDelegate.swift`) whenever the active Machine changes (`RootShell`). Both
targets carry the App Group entitlement; the target was added with the
`xcodeproj` gem, and its Embed phase sits before Flutter's Thin Binary
script (after it, Xcode reports a build cycle).

Design rules (§0): phosphor marks the one next step per view (`BtnKind.next`
in `widgets/work_ui.dart`), never nav or tabs; ember is a dot and means needs
you; your words (stopped-at notes, open questions, device captures) are in
Newsreader (`writingStyle`). `models/activity.dart` ports `describeActivity`,
`formatTokens` and `workLine` from Lee; keep it in step with
`electron/src/shared/cockpit.ts` (`test/activity_test.dart` pins the cases).
Usage shows as tokens only, dollars only for billed/estimated spend
(docs/15-Usage.md §9); the limits in the snapshot are parsed but not shown.

Cut, on purpose — don't re-add without a decision: DevOps dashboard (the stub
screen was deleted), in-app editing (the viewer and Review are read-only),
Open next, triage on the phone, server TTS or spoken alerts (§5.8), a
bespoke VPN (use Tailscale).

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
| Voice | `record` (WAV clips), `flutter_tts` (readback) |
| Images | `image_picker` (Send to Lee's photo and screenshot) |

No syntax highlighter was added for the code viewer (`file_viewer_screen.dart`'s
`_CodeView`) — plain monospace with a line-number gutter. Pulling in a
highlighter (e.g. `flutter_highlight`) is a reasonable follow-up but wasn't
justified for this pass; note it here rather than re-litigating the choice.
Same reasoning for PDF: no PDF-rendering package was added, so `pdf`-kind
files show metadata (path/size) instead of a rendered page — see the file
viewer table entry above.

`flutter_riverpod` stays on 2.x: 3.x moves `StateNotifier` into a legacy
import and wants the `Notifier` API, which is a rewrite of every provider
rather than a version bump.

`Info.plist` carries the camera (pairing and Send to Lee), microphone and
photo library usage strings; there is no speech-recognition permission,
since Hester transcribes.

## Layout

See the tree in `README.md`. The shape that matters:

- `models/lee_context.dart` mirrors `electron/src/shared/context.ts` and the
  wider `Tab['type']` union in `electron/src/renderer/components/TabBar.tsx`.
- `services/*_api.dart` are thin, stateless-per-call HTTP clients; they take a
  `Machine` and are constructed ad hoc at call sites. `TetherApi` and
  `VoiceApi` are built through `tetherApiFactoryProvider` /
  `voiceApiFactoryProvider` so widget tests can hand them a `MockClient`.
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
| `files` | `FileTreePane` (React file tree) | — | nothing (fell to the generic view) | `FilesBrowserBody`: live `/fs/list` tree, lazy-expanding directories, tap a file to view it; also Review › Files, even with no `files` tab open in Lee |
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
