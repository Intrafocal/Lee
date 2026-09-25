# Lee / Hester / Aeronaut / Dirigible — Punch List

Date: 2026-09-14. Last updated: 2026-09-15 (after Sprints 0, A, C, C-medium). Built from a full-repo review plus live inspection of `~/.lee`, running processes, and logs.

Effort: S = under an hour, M = a half day, L = multi-day. Status: ✅ done · 🟡 partial · ⬜ not started · ⛔ skipped/cut.

## Progress

| Sprint | Scope | Status |
|--------|-------|--------|
| 0 | Do-first items 1-7 | ✅ (key rotation deliberately skipped) |
| A | Hester config, lifecycle, latency (A1-A11) | ✅ |
| C (small) | Electron S-effort bugs (C0-C3, C5-C10, C13, C14, C16, C18, C19, C21, C24) | ✅ |
| C (medium) | C4, C11, C12, C15, C17, C20, C22, C23, C25, C26 | ✅ |
| B | Firebase / gcloud tools | ⬜ |
| D / E / F | Aeronaut, Dirigible, Spyglass | 🟡 (F1 and D5 landed via #2/#3/A10; F3, D1-Lee, E19 (code-approval pairing, both halves), and the Lee side of E5 landed 2026-09-15 alongside the Aeronaut/Dirigible device sprints; F2 skipped as over-budget; D12-D15 — tab-type audit, `/fs/*` endpoints, file viewer, Files browser — landed 2026-09-15) |
| G | Docs and hygiene | ⬜ |

Sprints 0, A, C, and C-medium were committed together on 2026-09-15 (the sprints overlapped on `main.ts`, `pty-manager.ts`, and `App.tsx`, so a per-sprint split wasn't practical). A signed, un-notarized `dist:mac` build including all four sprints is in `electron/out/`.

---

## Do first (unblocks everything else)

| # | Item | Effort | Status |
|---|------|--------|--------|
| 1 | Add `.lee/` to `.gitignore`; rotate the Google API key in `.lee/config.yaml` | S | 🟡 gitignore done. **Key rotation skipped by decision.** The key is no longer served over `/context` (C3), so exposure is now limited to the file itself. |
| 2 | Persist the Lee API token across launches | S | ✅ `APIServer.loadOrCreateAuthToken()` reads `~/.lee/api-token` (0600) or generates once. |
| 3 | Send the token from clients that never did | S | ✅ `lee_client.py send_command` + `fetch_context`; Spyglass fetches remote tokens via new `machines:getToken` IPC and shows a banner on failure. Aeronaut/Dirigible **not yet re-verified on real devices** (see D0/E2). |
| 4 | Deep-merge config (`~/.config/lee` < `~/.lee` < `<ws>/.lee`) | M | ✅ `electron/src/main/config-loader.ts`; used by prewarm, load, and both save paths; regex scrape deleted. |
| 5 | Surface daemon crashes | S | ✅ `on('exit')` with id check; 40-line ring buffer → `daemon-warning`; settings `ValidationError` logs one line to `hester.log` and exits 1. |
| 6 | Fix packaged venv deps | S | ✅ `numpy`, `websockets`, `slack_sdk` added; `textual`, `anthropic` removed; registries import failure logs once at boot. |
| 7 | Fix `pyproject.toml` entry points | S | ✅ `lee` script and `editor` package removed. |

## A. Hester: config, lifecycle, latency

| # | Item | Effort | Status |
|---|------|--------|--------|
| A1 | `/health` must not call Gemini | S | ✅ `/health` model-free (~40 ms); `/health/deep` and `hester daemon status --deep` do the live test. |
| A2 | Prepare step pays 2 s Ollama timeout per message | M | ✅ Process-wide availability cache keyed by (url, model), failure marks unavailable, 5-min re-probe, one log line per state change. `functiongemma` was installed all along; it was cold-load timeouts. Model names configurable via `hester.prepare_model` / `hester.local_model`. |
| A3 | Daemon follows the active workspace | M | ✅ `POST /workspace` (plugins unload/reload, stores and watchers rebound); Lee calls it on switch and window focus; `HESTER_WORKING_DIRECTORY` at spawn. Sessions and Redis survive. |
| A4 | Restart daemon when `hester:` config changes | S | ✅ Deep-compare on all four save paths; toast. |
| A5 | `hester doctor` | M | ✅ `hester doctor [--deep]`; shared Python config loader in `hester/shared/config.py`. |
| A6 | Log rotation | S | ✅ hester.log 10 MB ×5; lee.log 10 MB ×3 (rotates on launch). |
| A7 | Unify Python config precedence | S | ✅ devops manager, devops tools, plugin config all use the shared loader. |
| A8 | Scope Redis keys per workspace | M | ✅ `hester:ws:<8hex>:` prefix resolved at call time. **Old global keys are orphaned** (expire on 7-day TTL). |
| A9 | Stop creating `.hester/` on read | S | ✅ Lazy mkdir. |
| A10 | Daemon auth | M | ✅ Bearer middleware (exempt: `GET /health`, OPTIONS); every repo client sends it; renderer uses a `fetch` wrapper in `renderer/lib/hesterAuth.ts`. **Decision: fails open with a loud warning if `~/.lee/api-token` is missing.** `HESTER_AUTH_DISABLED=1` escape hatch. Bind host via `hester.listen_host` (default stays `0.0.0.0` for pairing). |
| A11 | Clean shutdown | S | ✅ `POST /shutdown` on `will-quit`; managed Redis stopped only on real quit and only if this daemon started it. |

## B. Hester: Firebase / gcloud capability (new)

Design: mirror `git_tools.py`. Fixed argv only (no shell strings), `--format=json`, `--quiet`, timeout, project passed per call as `--project` (never `gcloud config set`). Read-only by default; a `gcp_write` category only in the `full` toolset, refusing when project matches a `production_projects:` list in config.

| # | Item | Effort | Status |
|---|------|--------|--------|
| B1 | `definitions/gcp_tools.py` + `tools/gcp_tools.py` with `_run_gcloud` / `_run_firebase` helpers using the login-shell PATH trick from `devops_tools.py` | M | ⬜ |
| B2 | Read tools v1: `gcloud_config_list` (+auth list), `gcloud_projects_list`, `gcloud_run_services_list/describe/logs`, `gcloud_functions_list/logs`, `gcloud_logging_read`, `gcloud_secrets_list` (names only), `firebase_projects_list`, `firebase_use_show`, `firebase_functions_log`, `firebase_hosting_channels`, `firebase_emulator_status`, `firestore_query_emulator` (emulator host only, capped limit) | M | ⬜ |
| B3 | Write tools v1 (local only): `firebase_emulators_start/stop`. Out of scope: deploy, IAM, production Firestore writes | S | ⬜ |
| B4 | Register: categories `gcp`/`gcp_write`, `scoping.py` toolsets, `registries/agents.yaml` `gcp_assistant`, `agent.py:_create_tool_handlers` | S | ⬜ |
| B5 | `gcp:` config block: `project`, `region`, `firebase_project`, `emulator_hub`, `production_projects` | S | ⬜ |
| B6 | Surface "run `gcloud auth login` in a terminal" as a `ToolResult.error` when gcloud blocks on auth | S | ⬜ |

## C. Electron daily-driver bugs

| # | Item | Effort | Status |
|---|------|--------|--------|
| C0 | `npm run typecheck` didn't cover `tsconfig.main.json` | S | ✅ Now runs both. |
| C1 | Ctrl+R in terminal opens "Reload Lee?"; Cmd+R in browser reloads IDE | S | ✅ Meta-only intercept, skipped when a terminal/agent/browser tab is focused (via new `ContextBridge.getFocusedTabType()`); Reload menu item lost its accelerator. |
| C2 | Ctrl+W/I/`/`/1-9 never reach the shell | S | ✅ Exact chord only on mac; Ctrl-only chords ignored inside `.xterm`/`.cm-editor`. |
| C3 | Unauthenticated `GET /context` leaks config | S | ✅ Bearer required on all routes but `GET /health`; `redactWorkspaceConfigForContext()` strips API key, DB passwords, `machines` before the bridge. |
| C4 | No external-change detection; Cmd+S overwrites agent edits | M | ✅ `fs-watcher.ts` (one `fs.watch` per *directory*, so atomic renames still register); each file tab records the mtime of its buffer; clean buffers reload silently, dirty ones prompt Reload/Keep mine, and save re-checks (Overwrite/Cancel). Deleted files mark the tab and keep the buffer. |
| C5 | No unsaved-changes prompt | S | ✅ Close tab, close all, and quit dialog. Native dialogs since C25. |
| C6 | `once('exit')` consumed by wrong PTY | S | ✅ (Sprint 0) |
| C7 | Default TUIs missing; shortcuts no-op | S | ✅ `git`, `docker`, `k8s`, `system`, `flutter`, `sql` added; `isCommandAvailable()` PATH check with install hints; spawn failures reach the status bar. `sql` is bare `pgcli`; see C26. |
| C8 | Reload leaks every PTY | S | ✅ `killForWindow` before reload. |
| C9 | Session restore drops agent tabs | S | ✅ `provider` persisted; `agentProviders` in `createTab` deps. |
| C10 | No single-instance lock; EADDRINUSE uncaught | S | ✅ Lock + focus; `server.on('error')` → status message. No argv workspace routing exists. |
| C11 | Shell-string command building; DB password in `ps` | M | ✅ TUIs spawn the resolved binary with an argv array and an env object; login-shell PATH resolved once and cached (`extendedPath` getter). `shell: true` on a TUI/agent definition is the documented escape hatch. SQL password moves to `PGPASSWORD`. |
| C12 | Multi-window config leakage via `-1` placeholder | M | ✅ Placeholder and both first-window getters gone; every lookup takes a `windowId`. **The shared daemon is fed by the focused window** (`setDaemonWindow`, called from `bw.on('focus')` and prewarm — the same hook A3 uses); its `source:` env is applied explicitly since the daemon PTY belongs to no window. |
| C13 | Center render chain drifted from panel chain | S | ✅ Center now calls `renderTab`; ~140 duplicated lines gone. Dual-dispatch trap retired. |
| C14 | Panel commands fake success; `tui custom` tabless | S | ✅ 501 for toggle/show/hide/resize; custom routed through `system:create-tab`. |
| C15 | Shortcut conflicts (Cmd+Shift+O, Cmd+/, Cmd+Shift+A double-bound; global Cmd+Shift+L; Cmd+↓) | M | ✅ `shared/shortcuts.ts` generates menu accelerators, the hotkey map and `docs/shortcuts.md`. **DevOps → ⇧⌘J**; ⌘/ and ⇧⌘A are renderer-owned (menu items keep no accelerator); File ▸ Close lost its implicit ⌘W so Watch works as documented; ⌘↓ skips CodeMirror; the global chord is now opt-in `keybindings.global_focus_lee`, off by default. |
| C16 | Cmd+Esc / Cmd+W ignore focused panel | S | ✅ |
| C17 | File tree never auto-refreshes | M | ✅ Root + every expanded dir watched via the C4 module (non-recursive, 300 ms debounce, 200-dir LRU, `node_modules`/`.git`/`__pycache__`/`dist`/`build`/`out`/venv skipped). Only the changed directory is re-read, so expansion and filter survive. |
| C18 | "Skip" opens `/` from Dock | S | ✅ |
| C19 | Closed browser tabs never pruned from context | S | ✅ |
| C20 | Config editor Raw tab disagrees with merged view | S | ✅ New `config:sources` IPC returns per-top-level-key provenance; each structured section shows "from: ~/.lee/config.yaml"; Raw tab is a picker between the workspace and global files, each saved to its own path; `hester.google_api_key` defaults to the global file. |
| C21 | Session restore not failure-safe | S | ✅ Per-tab try/catch + outer finally. |
| C22 | Errors logged, not shown (38 empty catches, no `unhandledRejection`) | M | ✅ `notify()` in `App.tsx` and exported `pushStatus()` in `main.ts`; `unhandledRejection` added and `uncaughtException` now surfaces. 28 error/catch branches on user-initiated paths now report to the user; of the 63 bare `catch {` blocks, 0 are silent (52 carry a one-line reason, 11 have a meaningful body). StatusBar gained an `error` level. |
| C23 | `window.lee` is `any` | M | ✅ `shared/lee-api.ts` describes the full surface; preload declares `const api: LeeAPI` (so excess/missing/renamed members fail to compile) and `renderer/lee-global.d.ts` types `window.lee`. All 18 `(window as any).lee` accesses replaced. |
| C24 | `status:push` unvalidated | S | ✅ |
| C25 | Replace browser-native `confirm()` in C5 with a native Electron dialog via a preload `dialog` helper | S | ✅ `dialog:showMessageBox` → `lee.dialog.confirm()` returning a button index; C5's two chained confirms are now one Save / Don't Save / Cancel dialog, and C4's prompts use it too. |
| C26 | Wire top-level `sql.connections` / `sql.default` into the `sql` TUI's `connection` block (no such wiring exists; docs imply it does) | S | ✅ `getTUIDefinition('sql')` fills `connection` from `sql.default` (or the first entry) unless `tuis.sql.connection` overrides it; an unknown `sql.default` logs a warning. Password goes via `PGPASSWORD` (C11). |

| C27 | `LibraryPane`'s "Promote to workstream" calls `window.lee.sendCommand`, which the preload has never exposed — the branch has never run. Either add a `sendCommand` wrapper or route it through `lee.pty`/`system:create-tab` like every other tab spawn | S | ⬜ new (found while typing the preload API in C23) |
| C28 | `spawnConnectionTUI` still only knows Postgres (`postgresql://` + `PGPASSWORD`). A MySQL/SQLite entry under `sql.connections` would be built into a Postgres URL | S | ⬜ new (found in C26) |
| C29 | `fs.watch` is non-recursive by design here, so a file created in a *collapsed* directory isn't noticed until it's expanded, and the file-tree watch count is capped at 200 dirs (LRU). Fine day to day; revisit if it bites | S | ⬜ new (accepted limitation of C17) |
| C30 | `docs/shortcuts.md` is generated by hand-running a script over `SHORTCUTS`; wire it into an npm script so it can't drift | S | ⬜ new (from C15) |
| C31 | `command_palette_blank` is registered as `meta+shift+/`, but on a US layout `Shift+/` reports `e.key === '?'`, so `useHotkeys` builds `meta+shift+?` and the chord never matches. Either normalise shifted punctuation in `useHotkeys` or spell the chord `meta+shift+?` | S | ⬜ new (pre-existing; found while generating the hotkey map in C15) |

Structural (L each, after the S/M items): split `App.tsx` into `useTabs` reducer + `useSession` + `useHesterIpc`; `ProcessRegistry` with ownership and reconciliation replacing the warm-pool Map. (`config-loader.ts` already exists.)

## D. Aeronaut (mobile)

Milestone: **pair once, see and steer every Lee window, ask Hester cheaply.**

Keep: structured live view of the IDE, one-tap focus/spawn, cheap Hester chat, a read-only file viewer and Files browser (D14/D15, landed 2026-09-15). Cut: DevOps screen (stub), Library screen, in-app editing, Pi VPN (use Tailscale), voice.

| # | Item | Effort | Status |
|---|------|--------|--------|
| D0 | Re-pair a phone against the now-persistent token and confirm context, PTY, and Hester chat work end to end | S | ⬜ needs the device. A 9-step checklist is now in `aeronaut/README.md` ("Manual test checklist"). |
| D1 | Fix token path string in `add_machine_screen.dart:145` (`aeronaut.token` → `api-token`); QR parser | S | ✅ Hint now points at `~/.lee/api-token`. QR parser accepts `apiPort`/`leePort` (and `daemonPort`) aliases plus numbers-as-strings, and re-pairing the same `host:hostPort` updates the saved machine in place instead of duplicating it. The QR *port value* stays Lee-side (another agent owns `electron/`). |
| D2 | Add missing `TabType`s (agent, kicad, model, pdf, binary, spyglass, bridge) | S | ✅ All 26 wire values from `TabBar.tsx` mapped, plus an `unknown` fallback — unknown types render a read-only generic view (title, type badge, Focus), never a terminal. The xterm view is now gated on `ptyId != null` (`pty_id` accepted too), not on the type name. Icons and labels added for every type. |
| D3 | Delete `devops_screen.dart`; rewrite `aeronaut/CLAUDE.md` and `README.md` | S | ✅ Screen deleted (it had no route or reference). `README.md` (was the Flutter template) and `CLAUDE.md` rewritten: screens, providers, services, endpoints, auth, pairing flow, local-Lee run instructions, cut scope, manual checklist. `docs/Aeronaut.md` trimmed, with Library/Files/code-viewer/Pi VPN/voice/notifications moved to an "Ideas (parked)" appendix. |
| D4 | Replace discontinued `flutter_markdown`; bump `web_socket_channel`, `mobile_scanner`; `flutter analyze` | M | ✅ `flutter_markdown_plus ^1.0.12` (drop-in fork, import-only change), `web_socket_channel 2.4→3.0.3`, `mobile_scanner 6.0→7.4.2`, `shared_preferences 2.2→2.5.5`, `uuid 4.2→4.6`, `equatable 2.0→2.1`, `cupertino_icons 1.0.9`, `flutter_lints 5→6`; unused `json_annotation`/`json_serializable`/`build_runner` dropped (no codegen in the app). `flutter analyze` clean; `flutter test` 12 passing; `build web` and `build ios --no-codesign` both succeed. Left pinned: `flutter_riverpod` 2.x (3.x is a `StateNotifier`→`Notifier` rewrite) and `equatable` 3.x (drops `runtimeType` from equality). |
| D5 | Hester auth so LAN exposure of :9000 is safe | M | ✅ via A10, and verified on the client: both API clients send the bearer on every call including GETs, and every response path now funnels 401/403 through `services/api_auth.dart` → `authGuardProvider`, which marks the machine unauthorized, tears down the context WebSocket (stopping the reconnect storm) and shows "Token rejected. Re-pair this machine." Machine reachability now probes an authenticated route, so a bad token no longer reads as "online". |
| D6 | Show Hester's `workspace` and `auth` from `GET /health` in the machine detail view | S | ✅ New `machine_detail_screen.dart` (app-bar info icon, or long-press a machine card ▸ Health & workspace): Lee status/version/platform + whether the token is accepted, and Hester status, `auth`, current workspace path, session backend, model and tool count. |

### Follow-ups found while doing D1-D6

| # | Item | Effort | Status |
|---|------|--------|--------|
| D7 | The running Lee answered `GET /context` with a bogus bearer (200), i.e. the packaged build predates C3. Rebuild/relaunch before trusting D5 end to end — the source in `api-server.ts` is correct | S | ⬜ new |
| D8 | `browser_cast_provider.dart` (~274 lines) and `browser_screen.dart` are the remote-browser-cast feature, which is outside the current milestone and mirrors F2's Spyglass cast. Decide whether to keep or park it | S | ⬜ new |
| D9 | The new-tab sheet only offers `domain: tui` actions plus Terminal; browser/files/library tabs (which need `system:create_tab`) can't be spawned from the phone | S | ⬜ new |
| D10 | `LeeContext` ignores `workspaceConfig` and `editors` (the multi-editor array Lee now sends) and `ActivityContext` drops `recentActions` — all three are already on the wire | S | ✅ Lee now sends `provider`, `filePath`, `workstreamId`, `machineName`/`machineHost` per tab on the context wire (App.tsx + `TabContext`); Aeronaut already parsed them defensively |
| D11 | No test covers the QR payload parser or the 401 path; both are pure logic worth a widget/unit test | S | ⬜ new |
| D12 | Tab-type coverage audit: for each of the 26 `TabBar.tsx` wire types, what Lee renders, what's actually on the context-stream wire, and what Aeronaut shows | S | ✅ Full table in `aeronaut/CLAUDE.md` under "Tab type support". Key finding: `App.tsx`'s `lee.context.update()` only ever sends `{id, type, label, ptyId, dockPosition, state}` per tab — `provider` (agent tabs) and `filePath`/`machineConfig`/`workstreamId` (kicad/model/pdf/binary/spyglass/workstream) are never sent despite existing client-side in `TabData`/`TabContext`. Fixing that needs an `App.tsx` edit, out of scope for this pass (restricted to read-only `api-server.ts` additions); `TabContext.filePath`/`browserUrl` parse defensively for when it lands. |
| D13 | Lee-side read-only `/fs/*` endpoints for Aeronaut's file viewer and Files browser | M | ✅ `GET /fs/read?path=&stat=` and `GET /fs/list?path=` in `electron/src/main/api-server.ts`, behind the existing bearer middleware. Restricted to paths under an open window's workspace (symlinks resolved before the containment check, `fs.realpathSync`); 2 MB cap → 413 (with metadata); NUL-byte sniff (plus a forced set for images/pdf) → base64 or 415; `.git`/`node_modules`/`__pycache__`/`.dart_tool`/`build`/`dist`/`out` skipped in listings; rejected paths logged at WARN via the existing `ptyManager.log()`. No `/fs/workspaces` — `GET /windows` already returns `{id, workspace, focused}`. `npm run typecheck` and `npm run build` both clean; not exercised against the *running* packaged Lee (its binary predates the source, same as D7 — confirmed live: `/fs/list` 404s against the running instance, `/context` still leaks unauthenticated per D7). |
| D14 | Read-only file viewer (markdown/code/image/pdf/text) for editor-like tabs | M | ✅ `aeronaut/lib/screens/file_viewer_screen.dart`, driven by `services/fs_api.dart`. Markdown via existing `flutter_markdown_plus`; code as plain monospace with a line-number gutter (no highlighter package added — noted as a reasonable follow-up in `CLAUDE.md`, not done here); images (png/jpg/gif/webp/svg) via `Image.memory`/new `flutter_svg` dependency; PDF shows metadata only (no PDF package added); anything else utf8 shows metadata + first 64 KB. `EditorScreen` now takes the tab and resolves its path via `LeeContext.editorFor(tab)` (D10). |
| D15 | Files browser rooted at the workspace, driven by `/fs/list` | S | ✅ `aeronaut/lib/screens/files_screen.dart` (`FilesBrowserBody` embedded for a `files` tab; `FilesScreen` as a full route). Lazy-expanding directory tree (`ExpansionTile`, fetches + caches children on first expand); tapping a file pushes the D14 viewer. Reachable from a new Files icon in `home_screen.dart`'s app bar even with no `files` tab open in Lee. |
| D16 | Aeronaut could drop its QR pairing for the same `/pair/*` code-approval flow E19 built for Dirigible: show a 6-digit code in `add_machine_screen.dart`, `POST /pair/request` with `kind: "aeronaut"`, poll `/pair/poll` every 1.5 s, store `token`/`hester_port`/`name` from the grant. It removes `mobile_scanner` and the camera permission from the critical path, works when the phone can't see the laptop screen, and needs no Lee-side change - the routes take any `kind` string. The QR dialog stays for people who prefer it | S | ⬜ new (E19) |

## E. Dirigible (T-Deck hardware)

Milestone: **flash a T-Deck, pair from the Lee QR, watch tabs and type into one terminal, ask Hester one line.**

Source is on `main`. The firmware is now a plain ESP-IDF + LVGL 8 project at `dirigible/firmware/` — screenschema is gone (E7).

| # | Item | Effort | Status |
|---|------|--------|--------|
| E1 | Merge `dirigible` → `main`; `rm -rf dirigible/app/build` | S | ✅ merged by the coordinator; `dirigible/app/` is gone entirely with E7 |
| E2 | Re-provision or confirm the device's NVS token against the persistent token | S | 🟡 Flashed 2026-09-15 over USB: WiFi creds in the `ss_wifi` namespace survived and the device joined the LAN; the `dirigible` namespace is empty (device was never provisioned under it), so it boots into the pairing screen. Pair on-device once the new Lee dist (mDNS) is installed, or run the provision tool. |
| E3 | Minimal ANSI stripper for the terminal label; cap to TERM_COLS×ROWS | M | ✅ went further than a stripper: `firmware/main/vt.cpp` is a real cell grid with a small VT parser (CR/LF/BS/TAB, CUP, ED/EL, IL/DL, DCH/ICH, SU/SD, DECSTBM, SGR parsed-and-dropped, OSC swallowed), painted one LVGL label per row in `lv_font_unscii_8`. Grid measured from the font at boot (`lv_font_unscii_8` is 8 px advance, 9 px line height → 320x210 content area): **40x23**, sent upstream as `{type:"resize",cols,rows}` on the PTY WS. |
| E4 | Hester one-liner screen using the built `HesterClient` SSE | M | ✅ `firmware/main/screen_hester.cpp`: one input line, phase dots then the answer. Added `HesterClient::setToken()` (A10 bearer) and made `session_id` always transmitted — Hester's `ContextRequest` declares it required. |
| E5 | On-device pairing: host/port/token entry or mDNS `_lee._tcp` (Lee side: `bonjour-service`) | M | ✅ device side in `firmware/main/screen_pairing.cpp`: WiFi scan → password → `_lee._tcp` PTR query (reads the `hester=` and `ws=` TXT records E5-Lee publishes) or manual `host[:port]` → typed token → NVS. No on-screen keyboard (the T-Deck has a real one). The token is typed because the advertisement deliberately carries none. |
| E5-Lee | Lee advertises `_lee._tcp` via `bonjour-service` (`electron/src/main/mdns-advertiser.ts`, wired from `main.ts` next to `apiServer.start()`). Instance name: a `machines:` entry's friendly name if one resolves to this host, else `os.hostname()`. TXT: `v=1`, `hester=<port>`, `ws=<focused workspace basename>` (no token). Re-publishes `ws` on workspace/config changes via the same hook A3 uses (`applyConfigToMainProcess`); opt-out via `hester.advertise_mdns: false` (default on); stops on `will-quit`; socket bind/send errors are caught (via the `Bonjour` errorCallback plus a direct `.on('error')` on the underlying `multicast-dns` instance, which the library itself doesn't wire up) and logged as a WARN to `lee.log` instead of crashing. Verified structurally with a standalone script running the same code path (see report); wire-level `dns-sd -B` confirmation wasn't possible from this sandbox (multicast send is `EHOSTUNREACH` here regardless of our code - confirmed with a raw `dgram` test) but that failure path is exactly what the crash-guard above was built for, and it held. | M | ✅ |
| E6 | Move doc-only tiers (Linux/Luckfox, P4, LED/NPU/voice) to an "Ideas" appendix | S | ✅ `docs/Dirigible.md` rewritten around the T-Deck as the only shipped tier; Luckfox/P4/LED/voice/Hester-push/desk-mode/multi-machine are now an "Ideas (not planned)" appendix. Build, flash, provision, pairing, screen map, key bindings, NVS layout and the authenticated wire protocol are documented; new `dirigible/README.md`. |
| E7 | Decouple Dirigible from screenschema | L | ✅ T-Deck HAL lifted verbatim into `platform/esp32/components/tdeck-bsp/` (display/touch/keyboard/trackball/battery/I2C, every B-series fix preserved, each file naming its screenschema source path and commit `76b6ce9`); SSWebSocket/SSHttpClient/SSMdns/SSWifiManager/SSInput/SSBattery reimplemented on `esp_websocket_client`/`esp_http_client`/`mdns`/`esp_wifi` in `dirigible-esp32`; brookesia, the YAML schema and the codegen dropped; new `dirigible/firmware/` project. Submodule removed, `.gitmodules` deleted, `dirigible/app/`, `dirigible/third_party/` and `platform/esp32/test-build/` gone. `idf.py build` clean on ESP-IDF v5.4: **1,323,168 B / 0x1432a0** app image, 79% of the 6 MB OTA slot free. **Not flashed — no hardware here.** |
| E8 | Hester's `ContextRequest.source` is `Literal["Lee","Slack","CLI"]`, so a request tagged `"Dirigible"` 422s. Dirigible sends `"Lee"`; widen the Literal (and Aeronaut's too) so device traffic is attributable | S | ✅ Literal widened to include `Aeronaut` and `Dirigible` (Aeronaut was already sending `Aeronaut` and would have 422d too); firmware default now `Dirigible` |
| E9 | IRAM is at 16383/16384 bytes with the current sdkconfig — one byte spare. Any IRAM-ISR option added later will fail to link; consider `CONFIG_LWIP_IRAM_OPTIMIZATION=n` / moving WiFi ISRs to flash before it bites | S | ⬜ new (E7) |
| E10 | Machine names longer than 11 chars collide on the truncated `tok_<name>` NVS key. Pairing truncates to 11 to make it visible; hash the name into the key instead | S | ⬜ new (E7) |
| E11 | NVS holds the bearer and the WiFi password in plaintext. Enable flash encryption + `CONFIG_NVS_ENCRYPTION` with an `nvs_keys` partition | M | ⬜ new (E7) |
| E12 | `MachineManager` models several machines with per-machine tokens, but the UI only ever drives machine 0. Add a machine picker to the trackball menu | S | ⬜ new (E7) |
| E13 | Keyboard probe at boot logs `Keyboard not responding at 0x55: ESP_ERR_TIMEOUT — registering anyway`, but keys work afterwards (`First keyboard event: 0x43` seen on hardware). The keypad MCU is still booting when the probe runs; retry the probe after a delay or drop the warning | S | ✅ `tdeck_keyboard.cpp`: the probe now retries 5 times at 100 ms (≈500 ms total). A late success logs at **INFO** naming the attempt and elapsed ms; only five consecutive failures still WARN. Not verified on hardware from here — the coordinator flashes. Verified on hardware 2026-09-15: `Keyboard answered at 0x55 on attempt 3 (200 ms)`. |
| E14 | Pairing / screen chrome redesign — the pairing screen was a title, one list or a 26 px one-line textarea, and a grey hint, with most of the 320x210 content area black | M | ✅ Shared 20 px header (title \| step-status \| battery + WiFi glyph + link dot) and 16 px footer key legend factored into `app.cpp` (`chrome_set_title/centre/footer`, `chrome_show_footer`, `chrome_add_footer_button`), used by all four screens. Pairing gained four step chips, a persistent right-hand summary card (SSID + signal, IP, Lee name/host:port/workspace, Hester port, failures in red), 34 px `lv_font_unscii_16` inputs with a visible amber caret, a live `n/36` UUID check on the token, a `show` toggle on the password, RSSI signal bars and a lock mark on the WiFi rows, a 3 s progress strip and a real empty state on discovery, and **Back / Rescan / Manual** as footer buttons in the input group (so ESC, trackball and touch all step back). Tabs got type badges, a focus marker and a disconnected panel with Reconnect / Re-pair; Hester became chat-shaped with phases in the header. `-DDIRIGIBLE_UI_DEMO=1` cycles every pairing state on canned data. Build clean, IRAM unchanged at 16383/16384. **Not seen on a display — every rect is computed from `SCREEN_W`/`SCREEN_H`/font metrics, but the owner should sanity-check for clipping.** |
| E15 | `docs/Dirigible.md` still describes the pre-E14 chrome (“a 16 px header … and a 14 px status bar”) and the 40x23 terminal grid, which is now 40x24 since the terminal claims the footer band. Out of scope for E14 (outside `dirigible/`); `dirigible/README.md` is current | S | ⬜ new (E14) |
| E16 | The summary card is 128 px — 15 mono columns — so a long SSID or workspace name wraps onto two or three lines. If it looks cramped on the device, the alternative is a full-width ~60 px band across the top of the pairing body (38 columns, fewer lines) | S | ⬜ new (E14) |
| E17 | The pairing flow has no on-device way to *delete* a stored machine or wrong token; Re-pair only overwrites machine 0. Pairs with E12's machine picker | S | ⬜ new (E14) |
| E18 | The terminal's key legend is a 2 s flash on entry rather than a live footer, because the grid needs all 24 rows and the trackball long-press menu is disabled in the terminal. If the hint proves too easy to miss, make it re-flash on a modifier or allow the menu in the terminal | S | ⬜ new (E14) |
| E19 | Code-approval pairing, so the 36-char token is never typed on the device | M | ✅ **Lee:** new `electron/src/main/pairing-store.ts` (pure TTL/cap/decision state) plus two unauthenticated routes in `api-server.ts` - `POST /pair/request {device,kind,code,nonce}` → `{status:'pending',expires_in:120}`, `GET /pair/poll?nonce=` → `pending`/`denied`/`expired`/`approved`+`{token,hester_port,name}` once. 120 s TTL, max 3 undecided total and 1 per remote IP (429 past that), both routes named explicitly in the auth exemption and excluded from CORS, `hester.pairing_enabled: false` → 404, approvals/denials logged to `lee.log`. `main.ts` raises a native Approve/Deny dialog (Deny is `defaultId`) plus a status-bar line, one per entry. **Device:** new portable `core/{include/dirigible/pairing_client.hpp,src/pairing_client.cpp}` on the existing `IHttpClient`; `screen_pairing.cpp` step 4 is now Approve - `esp_random` 6-digit code + 16-byte hex nonce, code shown in `lv_font_unscii_16` letter-spaced `483 910`, 120 s countdown bar, 1.5 s poll, three consecutive transport errors before giving up; failures turn the card red with Retry / Token footer buttons. The typed-token step survives as step 6 behind that Token button. Verified: `npm run typecheck`/`build` clean, 48 endpoint+store assertions green against a dev instance on :9099 (the running Lee was never touched), `idf.py build` clean with IRAM unchanged at 16383/16384. **Not exercised on hardware** - the coordinator flashes. |

## F. Spyglass / Bridge

| # | Item | Effort | Status |
|---|------|--------|--------|
| F1 | Restore Spyglass | — | ✅ via #2/#3 (untested against a remote machine yet) |
| F2 | Remove or park the browser-cast viewer in Spyglass (~160 lines) | S | ⬜ skipped this round: `SpyglassPane.tsx` is 767 lines with the cast viewer, its `machines:getToken` usage, and matching CSS interleaved through the file - a careful removal plus verifying nothing else depends on the token fetch looked like more than the 30-minute budget alongside items 1-3, so left untouched |
| F3 | fs watcher on `~/.lee/config.yaml` so `MachineManager` reloads machines | S | ✅ `MachineManager.watchConfig()` (`electron/src/main/machine-manager.ts`) watches the `~/.lee` directory (survives the editor-swap atomic-rename case) filtered to `config.yaml`, debounced 500ms, calling the existing `loadConfig()`/`pingAll()` path and emitting `config-reloaded`; `main.ts` forwards that to `pushStatus('info', 'Machines config reloaded (N machines)')`. Closed via `MachineManager.dispose()`, now called from `will-quit` (it wasn't wired to app shutdown before). Considered reusing `fs-watcher.ts`, but its API is renderer/window-IPC-shaped (`watchFile(path, windowId)` → sends to a `BrowserWindow`), which doesn't fit a main-process-only consumer, so this uses a local `fs.watch` per the task's fallback option. |
| F4 | Reuse the bearer for the remote machine's Hester | M | ⬜ unblocked by A10 |

## G. Docs and repo hygiene

| # | Item | Effort | Status |
|---|------|--------|--------|
| G1 | Rewrite root `CLAUDE.md`: Architecture, Technology Stack, Editor Modules, Installation, Usage describe the deleted Python Textual editor and Node host. Add `cd electron && npm run dev`. | M | ⬜ |
| G2 | Config docs: remove `app:`, `hester.enabled/url/listen_port`; document `keybindings:`, `terminal:`, `agents:`, `machines:`, `source:`, `plugins:`, `services:`, `hester.{google_api_key,model,thinking_depth,ollama_url,prepare_model,local_model,listen_host}`, precedence | S | ⬜ |
| G3 | `tuis:` docs: list the built-in defaults now that C7 added them | S | ⬜ |
| G4 | `hester/CLAUDE.md`: `cli.py`→`cli/`, delegate filenames, Gemini 2.5→3.x, gemma4/Ollama hybrid layer, unlisted CLI groups (add `doctor`), `--host` default, auth, `/workspace`, `/shutdown`, and the two "Hard Boundaries" the code contradicts | M | ⬜ |
| G5 | Delete `host/`, `bin/lee`, `electron/main.js`, `electron/resources/icon.png.bak`, `install_claude.sh` | S | ⬜ |
| G6 | Archive `docs/00-Lee-Initial.md`, `docs/01-Mosaic-Infra.md`, completed `plans/` files; fix duplicate `07-` prefix | S | ⬜ |
| G7 | `hester slack`/`brief` import missing modules; `scope/` empty; `db/postgres_mcp_server.py` superseded | S | ⬜ |
| G8 | Version 0.2.0 vs 0.1.0; `testpaths` points at nothing | S | ⬜ |
| G9 | Document the venv gotcha: the packaged app reinstalls `hester-src` non-editably into `~/.lee/venv` when `pyproject.toml`'s hash changes; run `pip install -e .` afterwards to keep developing from the checkout | S | ⬜ new |

---

## Operational notes from this round

- Anything outside the repo that hits `:9000` or `:9001` now needs `Authorization: Bearer $(cat ~/.lee/api-token)`. `GET /health` on both stays open.
- To lock the daemon to loopback: `hester: {listen_host: 127.0.0.1}` in `~/.lee/config.yaml`.
- Bundle/doc/embedding caches restarted empty under per-workspace keys.
- Verified live after restart: daemon reports `auth: bearer`, workspace pinned, `/health` in ~40 ms; venv still editable.

## What's next

1. ~~**Commit** and rebuild `dist:mac`~~ — done 2026-09-15 (single commit).
2. **Sprint B** (Firebase/gcloud, B1-B6). Self-contained in `hester/`, good fit for a single agent.
3. ~~**Sprint C-medium**~~ — done (C4, C11, C12, C15, C17, C20, C22, C23, C25, C26). New follow-ups C27-C31.
4. **Remote**: E1 merge, then D0/E2 with devices in hand (D1-D6 are done; run the `aeronaut/README.md` checklist), then F2-F3.
5. **Docs** G1-G9 once the code has settled.
