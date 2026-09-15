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
| D / E / F | Aeronaut, Dirigible, Spyglass | ⬜ (F1 and D5 landed via #2/#3/A10) |
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

Keep: structured live view of the IDE, one-tap focus/spawn, cheap Hester chat. Cut: DevOps screen (stub), Library/Files/code-viewer milestones, Pi VPN (use Tailscale), voice.

| # | Item | Effort | Status |
|---|------|--------|--------|
| D0 | Re-pair a phone against the now-persistent token and confirm context, PTY, and Hester chat work end to end | S | ⬜ needs the device |
| D1 | Fix token path string in `add_machine_screen.dart:145` (`aeronaut.token` → `api-token`); use `apiServer.port` in the QR | S | ⬜ |
| D2 | Add missing `TabType`s (agent, kicad, model, pdf, binary, spyglass, bridge) | S | ⬜ |
| D3 | Delete `devops_screen.dart`; rewrite `aeronaut/CLAUDE.md` and `README.md` | S | ⬜ |
| D4 | Replace discontinued `flutter_markdown`; bump `web_socket_channel`, `mobile_scanner`; `flutter analyze` on 3.38.9 | M | ⬜ |
| D5 | Hester auth so LAN exposure of :9000 is safe | M | ✅ via A10. Aeronaut already sends Bearer. |

## E. Dirigible (T-Deck hardware)

Milestone: **flash a T-Deck, pair from the Lee QR, watch tabs and type into one terminal, ask Hester one line.**

Source lives on branch `dirigible` (3 commits, pushed, merges cleanly onto `main`). The untracked `dirigible/` on `main` is residue: 520 MB of ESP-IDF build output plus the screenschema checkout.

| # | Item | Effort | Status |
|---|------|--------|--------|
| E1 | Merge `dirigible` → `main`; `rm -rf dirigible/app/build` | S | ⬜ |
| E2 | Re-provision or confirm the device's NVS token against the persistent token | S | ⬜ needs the device |
| E3 | Minimal ANSI stripper for the terminal label; cap to TERM_COLS×ROWS | M | ⬜ |
| E4 | Hester one-liner screen using the built `HesterClient` SSE | M | ⬜ |
| E5 | On-device pairing: host/port/token entry or mDNS `_lee._tcp` (Lee side: `bonjour-service`) | M | ⬜ |
| E6 | Move doc-only tiers (Linux/Luckfox, P4, LED/NPU/voice) to an "Ideas" appendix | S | ⬜ |

## F. Spyglass / Bridge

| # | Item | Effort | Status |
|---|------|--------|--------|
| F1 | Restore Spyglass | — | ✅ via #2/#3 (untested against a remote machine yet) |
| F2 | Remove or park the browser-cast viewer in Spyglass (~160 lines) | S | ⬜ |
| F3 | fs watcher on `~/.lee/config.yaml` so `MachineManager` reloads machines | S | ⬜ |
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
4. **Remote**: E1 merge, then D0/E2 with devices in hand, then D1-D3, F2-F3.
5. **Docs** G1-G9 once the code has settled.
