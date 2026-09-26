# Deep D1: A place to think

> **Status:** Contract, 2026-09-26
> **Spec:** [`docs/14-Deep-Work.md`](../14-Deep-Work.md) §3, §4.1, §5.1–§5.3, §5.5, §6, §7, §8, §8.1 (compatibility only), §10, §11, §12 D1 · builds on [`docs/13-Copilot.md`](../13-Copilot.md) · **Goals:** [`GOALS.md`](../../GOALS.md) (G0 proposed in 14 §1.1)
> **Builds on:** the v0–v4 contracts (`docs/plans/2026-09-2*-copilot-*.md`).
> **Packages:** **S** (scaffold, runs first and alone: the §12 shared types and the R1/R2 seam in §14), then in parallel **P** (Python: `hester/`, `tests/`, spec docs), **M** (Lee main: `electron/src/main/**`, `electron/src/shared/**`, main smokes in `electron/scripts/`, `docs/shortcuts.md`, the Key Bindings table in `CLAUDE.md`), **R1** (renderer modes: §1.2–§1.4, §8.3 and the mounts in §14) and **R2** (renderer Deep surface: §4, §5, §7, §8.2, §9, the palette in §5). They share only this document and S's commit. `electron/src/shared/*` is **M's** after S; R1 and R2 import it without editing. Each package builds in its own worktree on its own branch; a merge step follows.

## 0. Scope and goal check

**In:**
- Three modes, **Cockpit**, **Deep** and **Manual**; `workbench` renamed `manual`; the `⌘0` switcher and the mode chords (§1).
- The in-mode wall removed; the mode rule replaces it (§1.4).
- Deep sessions as focus sessions with `source: 'deep'`, the `exploration` focus item and attention policy `none`; manual Focus retired into **Go deep** (§2).
- Explorations as directories with `page.md`, `references.jsonl`, `answers.jsonl`, `sessions.jsonl` and open questions (§3).
- The **Page** with its margin (§4).
- Selection actions **Capture**, **Keep**, **Ask**, **Explore** on `⌘.` (§5); `deep-ask` on Hester's hybrid routing (§6).
- Typing affordances for `?`, URLs and `later:`/`someday:` (§7).
- The **opener** at the top of Copilot, and Copilot as the landing section (§8).
- The **ending ritual** (§9).
- G0 metrics `turn_churn`, `deep_time`, `time_to_deep`, `session_depth` (§10).
- Device compatibility fields (§2.5).

**Out (D2+):** the Board, Browse and Workbench views (their tabs don't render in D1; `⌥⌘2`–`⌥⌘4` aren't registered), Spin off, `todo:`/`agent:` and `render:` affordances, Pin, Quick Open `⌘P`, `⌘D`, `⌥⌘S`, renders, device UI (13 v6), Open next, automatic affordance demotion (outcomes are logged now; the rule comes with D2), editing `GOALS.md` (G0 text stays a proposal in 14 §1.1; the human applies it).

**Two-sided check** (14 §1.2, D1 rows):

| Part | Moves | Costs |
|---|---|---|
| Deep with zero interruptions | G0 deep_time ↑, G4 focus_interruptions → 0 in Deep | G2 attention_latency ↑ while deep (by design) |
| Opener, landing on Copilot | G0 time_to_deep ↓, G1 catch_up_time ↓ | Digest one scroll lower |
| Page, selection actions, deep-ask | G0 deep_time ↑, G4 capture_pickup ↑ | Model spend per Ask, on demand only |
| Ending ritual | session_depth measurable; catch_up_time ↓ next time | One optional sheet per session |
| Switcher, hops unscored; Manual with no wall | agency; G1 toil_load ↓ | peek_rate may rise in Manual; measured, not blocked |

**Invariants:**
- **C2:** no model runs unless a user action triggered it. `deep-ask` runs only from Ask (row, affordance, Follow up, Retry). The opener, affordances, references, questions and metrics are deterministic.
- **C3:** Hester never writes into `page.md`. Only **Insert** (a click) does, and it's the renderer writing the user's own document.
- **Deep has no interruptions.** While a Deep session is active, the attention queue raises nothing to `blocking` and notifies nothing, except items marked wake-me (§2.3). Any other interruption during Deep is a bug, and `focus_interruptions` for Deep sessions must read 0.
- **Hops are never scored.** No code counts, nudges, lints or shows back mode changes as a problem.
- **Nothing requires a reply or a reason.** Every sheet field is optional; Esc always works.

## 1. Modes (M types, R behaviour)

### 1.1 Types and whitelists (M)

- `shared/cockpit.ts`: `LeeMode = 'cockpit' | 'deep' | 'manual'`. `ModeReason` gains `'deep_start' | 'deep_end' | 'hop' | 'switcher'` and keeps the existing values (`'focus_start'`/`'focus_end'` stay for old log lines; new code doesn't emit them).
- `main/cockpit/tabs-main.ts`: `MODES` and `MODE_REASONS` follow the types. `validRendererEvent` **accepts `'workbench'` as a legacy alias and rewrites it to `'manual'`** before logging.
- `main/cockpit/cockpit-config.ts`: `default_mode` is removed from the typed config (unknown keys are ignored). Lee always opens in Cockpit (14 §3: never opens in Manual). `cockpit.enabled: false` keeps meaning "no Cockpit": the window behaves as Manual only, and Deep is unavailable.
- New `CockpitEventType`s: `'deep.input' | 'deep.view' | 'deep.action' | 'deep.affordance' | 'deep.switcher'` (§10.1), accepted by `validRendererEvent` with the data shapes in §12.

### 1.2 Mode store (R)

`cockpitModeStore` keeps mode per window, as today.
- Initial mode `'cockpit'` (was `'workbench'`); `configure(enabled)` drops `defaultMode`.
- `lastMode: LeeMode` is kept for the switcher's quick tap.
- Per-mode memory: Cockpit's section (as today), Deep's `{exploration_id, view, scroll, selection}` (§4.4), Manual's active tab (the existing tab state).

`nextMode(state, trigger)` (`lib/cockpitModel.ts`), replacing the table in the v2 contract:

| Trigger | Result |
|---|---|
| `load` | `cockpit` (section `copilot`, §8.3) |
| `switcher {to}` | `to`, reason `switcher` |
| `toggle_deep` (`⇧⌘0`) | `cockpit` → `deep`; `deep` → `cockpit`; `manual` → `deep`. Reason `hop` if a Deep session is active, else `deep_start` when entering Deep |
| `toggle_manual` (`⌥⌘0`) | `cockpit` → `manual`; `manual` → `cockpit`; `deep` → `manual`. Reason `hop` |
| `deep_session {active:true}` (from `snapshot.focus.source === 'deep'` becoming active in this window's workspace) | `deep`, reason `deep_start` |
| `deep_session {active:false}` | `cockpit` if the mode was `deep`, reason `deep_end`; otherwise unchanged |
| `handoff`, `return` | `cockpit` unless a Deep session is active and the mode is `deep` (return after a short absence keeps you in Deep) |
| `go_into` (a tile, a tab row, "Open tab") | `manual`, with that tab focused |
| `open_tab` (Files, Explore "Open file", Library, own tab from the drawer) | `manual` |
| `tab_activated` | no change (the wall is gone) |

Entering Deep with no exploration open (§3.1 of 14) switches to **Cockpit, section Copilot, with the opener's field focused** rather than an empty Deep. Once an exploration is chosen, the mode is `deep`.

### 1.3 Keys (M registry, R handling)

`shared/shortcuts.ts` (M):

| action | chord | scope | group | note |
|---|---|---|---|---|
| `mode_switcher` | `meta+0` | renderer | View | replaces `cockpit_toggle`; `resolveChord` treats a `keybindings:` entry for `cockpit_toggle` as `mode_switcher` |
| `mode_deep` | `meta+shift+0` | renderer | View | Cockpit ↔ Deep |
| `mode_manual` | `meta+alt+0` | renderer | View | Cockpit ↔ Manual |
| `deep_view_page` | `meta+alt+1` | renderer | View | Page; `⌥⌘2`–`4` come with D2 |
| `deep_actions` | `meta+.` | renderer | Editor | action row; only in Deep |

- `main.ts:638`: the View menu's `resetZoom` item keeps its role and **loses its accelerator** (menu shows no chord). `⌘=`/`⌘-` unchanged.
- **`useHotkeys` (R) must match on `e.code` for digits and punctuation**, because `e.key` for `⇧⌘0` is `)` and for `⌥⌘0` is `º` on a US Mac. Build the chord from modifiers plus `code` (`Digit0`→`0`, `Period`→`.`) and match either the `key`-based or the `code`-based spelling, so existing chords keep working. Covered by the smoke test (§11).
- Checked free: `⌘.`, `⌥⌘0`–`⌥⌘4` (no renderer, registry, CodeMirror default or macOS text binding; CodeMirror binds only `Mod-Alt-ArrowUp/Down`, `Mod-Alt-\`, `Mod-Alt-g`). `⇧⌘.` stays the Cockpit's check-in.
- **Switcher behaviour (R):** `⌘0` keydown records the time. If `Meta` is released within 250 ms with no further `0`, switch to `lastMode` (quick tap). If `Meta` is held past 250 ms, or `0` is pressed again while held, show the switcher overlay: three cards (Cockpit "N waiting", Deep "<exploration title> · Page" or "Nothing open", Manual "N tabs"); each further `0` moves the highlight; releasing `Meta` commits; Esc cancels. Clicking a card commits. The mode chip in the status bar opens the same overlay (click), with the same cards.
- `docs/shortcuts.md` (M) gains the five rows and a Reset Zoom row ("menu only"), and the missing `⌘0` row is fixed. `CLAUDE.md`'s Key Bindings table (M) gains rows for `⌘0`, `⇧⌘0`, `⌥⌘0`, `⌥⌘1` and `⌘.`.

### 1.4 The wall goes; the mode rule stays (R)

**Rule:** Cockpit and Deep are overlays that never show an agent terminal. Manual is the full tab layout with nothing hidden.

- Remove from `cockpitMode.ts`: `enteredPtys`, `enter`, `forget`, `hold`/`holding`/`holdEpoch`, `quiet`/`takeQuiet`, the wall-repair effect, `getWall`/`CockpitWallState`.
- Remove from `lib/cockpitModel.ts`: `wallRepair`, `stripTabs`, `stripNeighbor`, `fallbackTab` (if unused after the change), and `nextMode`'s `enter` handling. Keep `isAgentTab` and `isWallExempt` (renamed `isOwnTab` semantics for the drawer: the drawer lists your own tabs).
- App.tsx: TabBar gets all tabs; ⌘1–9 and next/prev go over all tabs; `hiddenTabIds` is removed from `PanelLayout`; dock/close fallbacks use the plain neighbour.
- CockpitHost: the create-tab bridge no longer holds; the "leaving the Cockpit falls back to an own tab" block (:339–350) goes.
- Deep is a new portal overlay, `DeepHost` (§4), mounted the same way as `CockpitHost` (between the title bar and the status bar, nothing underneath unmounts).
- All labels: "Workbench" → "Manual" (chip, header switch, `TabDrawer`, section copy such as "opens in the Workbench" → "opens in Manual"). CSS `.is-workbench` → `.is-manual`.
- The Cockpit header's mode switch shows three segments: **Cockpit**, **Deep ⇧⌘0**, **Manual ⌥⌘0**.

## 2. Deep sessions and attention (M)

### 2.1 Focus types (M, `shared/copilot.ts`)

- `FocusItem` gains `{ kind: 'exploration'; workspace: string; exploration_id: string | null; title: string }`. `exploration_id: null` means "Deep with nothing open yet" (a device's Go deep, §2.5).
- `FocusState.source: 'manual' | 'inferred' | 'deep' | null`. New `FocusState.policy: 'normal' | 'none'` (`'none'` iff `source === 'deep'`). New `FocusState.deep: { exploration_id: string | null; title: string; workspace: string } | null`.
- `FocusEndReason` gains `'deep_end'` (ritual or Esc) and keeps `'away'`, `'quit'`, `'handoff'`.
- `CopilotAPI` gains `deepStart(req: DeepStartRequest)`, `deepEnd(req: DeepEndRequest)`; IPC `copilot:deep:start`, `copilot:deep:end`. HTTP: `POST /deep/start`, `POST /deep/end` in `queue-routes.ts` (renderer token or device token).
- `focusStart` from the renderer is **no longer called** by R (manual Focus is retired). The IPC and HTTP `POST /focus/start` stay for devices and old callers: **a device or HTTP focus start becomes `deepStart({workspace: <focused window's workspace>, exploration_id: null, surface})`**. `POST /focus/stop` from a device ends a Deep session with reason `'deep_end'` and no rating.

### 2.2 FocusTracker (M, `copilot/focus.ts`)

- `start(item, 'deep', surface, actor, now)`: replaces any existing session (manual or inferred) by ending it with reason `'switch'` first. If a Deep session is already active, a new `deepStart` with a different exploration **updates the item** (`focus.item` event) instead of starting a new session.
- `tick()` for `source: 'deep'`: no switch-end; no inference. It ends the session with reason `'away'` after `deep.idle_end_minutes` (default 45, `copilot/config.ts` under a new `deep:` block) of not being at the machine. Device engagement doesn't reset it (13 §5.1 presence).
- Inference never starts while a Deep session is active. **Inference only runs while no window is in Deep mode**, which is in practice Manual and Cockpit; the renderer reports its mode (next bullet).
- M learns each window's mode from the existing `cockpit.mode` renderer events (keep `windowModes: Map<window_id, LeeMode>` in `tabs-main.ts` or the focus owner).
- `isRelated` for `exploration` items returns false for everything (no agent is "related" to a Deep session; spin-offs come in D2).
- `focus.start` data gains `policy`; `focus.end` data gains `deep_rating?: 'deep' | 'mixed' | 'shallow' | null` and `stopped_at_chars?: number` (length only, never content).

### 2.3 Attention policy `none` (M, `attention-queue.ts`, `cockpit-bus.ts`)

While `focus.policy === 'none'`:
- `blocking = isWoken(item) && base === 'needs-you' && open && !parked`. Age and focus-relatedness never escalate. `isWoken` is the away module's check (`item.wake`, `wake_item_ids`, `wake_pty_ids`) made available outside away.
- `notify = !quietHours && open && isWoken(item)`.
- Items that would have escalated are **parked** as under the away policy (13 §5.1): they wait, and stay in the queue for when you look.
- `NudgeBudget.claim()` denies every request, including `blocking` ones, with reason `'deep'`.
- `quietCount()` counts all open needs-you items (the status bar's neutral "N waiting").
- `attention.escalate` is never logged during Deep except for woken items; `focus.noteInterruption()` is called only for those.

### 2.4 Close Lee (M)

`window.lee.app.quit()` (preload, IPC `app:quit`) calls `app.quit()` after ending any Deep session with the reason the caller passed (the ritual has already sent `deepEnd`, so normally this ends nothing).

### 2.5 Device compatibility (M)

The attention snapshot devices read (`GET /attention`, the `attention_snapshot` broadcast) keeps `focus_active: true` during a Deep session, so Aeronaut and Dirigible hold notifications with no change. It gains `mode: LeeMode` (the focused window's mode) and `deep: { exploration_id, title } | null`. Nothing else changes for devices in D1.

## 3. Explorations as directories (P)

### 3.1 Layout and migration

```
.hester/explore/<id>/            # 0700
  exploration.md                 # frontmatter + Seed + Log + Node sections (today's format)
  page.md                        # the Page; created empty
  references.jsonl               # §3.4
  answers.jsonl                  # §3.5
  sessions.jsonl                 # §3.6
.hester/explore/evidence/        # unchanged; spike diffs stay here and old diff_path values stay valid
```

- `ExplorationStore._path(id)` → `<dir>/<id>/exploration.md`. `_load` takes the id from frontmatter, falling back to the **parent directory name** (not `path.stem`). `load_all` globs `exp-*/exploration.md`.
- **Migration on load:** `load_all` and `get` also see legacy flat files `exp-*.md`. Under the workspace lock, a legacy file is moved with `mkdir(<id>, 0o700)` + `os.replace(<id>.md, <id>/exploration.md)` and an empty `page.md` is created. Idempotent; if both exist, the directory wins and the flat file is left alone with a WARN.
- Update every path string: `_workspace_for_session`, the prompt strings at `explorations.py:808,825,1043`, `explore_ops.py:178,264`, comments in `main.py`/`agent.py`. `spikes.py` keeps `evidence/`.
- New frontmatter fields: `links: [{kind: 'exploration', id, rel: 'child'|'parent', at}]`, `questions: [Question]` (§3.7). `ORIGIN_KINDS` gains `'exploration'` and `'opener'`.
- `to_api` gains `page_chars`, `page_updated_at`, `answers_unread`, `answers_pending`, `open_questions` (count), `last_session: SessionRecord | null`, `links`.

### 3.2 Endpoints (all under `/cockpit/explorations/{id}`, envelope and workspace resolution as today, under `ctx.lock`)

| Method | Path | Body | `data` |
|---|---|---|---|
| GET | `/page` | — | `{text, version}`; `version` = sha1 of the content, first 12 hex |
| PUT | `/page` | `{text, base_version}` | `{version}`; **409** `{error:'version_conflict', version, text}` if `base_version` isn't current. ≤ 1 MB |
| GET | `/references` | — | `Reference[]`, newest first |
| POST | `/references` | `{kind, quote?, url?, title?, note?, section?, source?}` | `Reference` (201) |
| PATCH | `/references/{rid}` | `{note?, opened?: true}` | `Reference` |
| GET | `/answers` | — | `Answer[]`, newest first |
| POST | `/asks` | `{question, anchor}` | `Answer` with `status:'queued'` (202); §6 |
| PATCH | `/answers/{aid}` | `{read?: true, dismissed?: true, inserted?: true, kept?: true}` | `Answer` |
| POST | `/answers/{aid}/retry` | — | `Answer` re-queued (202) |
| GET | `/questions` | — | `Question[]` |
| POST | `/questions` | `{text, source: 'page'|'ask', anchor?}` | `Question` (201) |
| PATCH | `/questions/{qid}` | `{status: 'open'|'closed'}` | `Question` |
| POST | `/sessions` | `SessionRecord` without `id` | `SessionRecord` (201) |
| POST | `/explore` | `{seed, anchor?}` | the new child `Exploration` (201); links both ways; origin `{kind:'exploration', ref:<id>}`; doesn't touch the parent's `last_touched_at` |

`POST /cockpit/explorations` also accepts `{page?: string}` (initial `page.md`, used by the opener, §8.2) and `origin.kind: 'opener'`.

Append-only JSONL files are rewritten atomically on PATCH (read, modify, `atomic_write`). Each file is capped at 5 000 records (oldest dropped with a WARN).

### 3.3 Anchors

`Anchor = { kind: 'page', quote: string (≤ 500 chars), offset: number, section: string | null } | { kind: 'none' }`. `section` is the nearest preceding markdown heading. The renderer re-anchors by searching for `quote` nearest `offset` (§4.2); P stores it verbatim.

### 3.4 References

`Reference = { id: 'ref-<8hex>', kind: 'quote'|'link', quote?, url?, title?, note?, section?, source?: {kind: 'page'|'palette'|'answer', ref?}, at, opened_at? }`. In D1, Keep makes `quote` references (from a Page selection, possibly with a URL in it) and `link` references (from the URL affordance). A `link` reference is unread until `opened_at` is set (the renderer sets it when you open the link).

### 3.5 Answers

`Answer = { id: 'ans-<8hex>', anchor, question, status: 'queued'|'running'|'done'|'error'|'interrupted', answer?, error?, surface: 'deep-ask', model?: {location: 'local'|'cloud', name}, asked_at, answered_at?, read_at?, dismissed_at?, inserted_at?, kept_at?, follow_up_of?: string }`.

### 3.6 Sessions

`SessionRecord = { id: 'ses-<8hex>', focus_session_id, started_at, ended_at, reason: 'ritual'|'esc'|'away'|'quit', stopped_at: string | null (≤ 1000 chars), rating: 'deep'|'mixed'|'shallow'|null, questions_kept: string[] }`. Written by the renderer's ritual (§9) and by P itself for Deep sessions that ended with reason `away` or `quit` (P sees `focus.end` with `source: 'deep'` in the event log when building the opener and writes a record with `stopped_at: null, rating: null` if none exists for that `focus_session_id`).

### 3.7 Questions

`Question = { id: 'q-<8hex>', text (≤ 500), source: 'page'|'ask', anchor?, status: 'open'|'closed', at, closed_at? }`, stored in `exploration.md` frontmatter.

## 4. The Page and the Deep surface (R)

### 4.1 DeepHost

`components/deep/DeepHost.tsx`, a portal overlay like `CockpitHost`, rendered when this window's mode is `deep` and an exploration is open.

**Header:**
- The exploration title (click to rename).
- View tabs showing **Page** only in D1.
- An **Answers** tray: "N answers" when some are unread, "N asking…" while pending. Clicking lists the answers and jumps to each anchor.
- The **wake line**: one line naming a woken waiting item, when one exists (§2.3). Clicking it hops to Cockpit.
- **Open questions** (count, a list on click).
- **End session**.
- A dim `⇧⌘0 Cockpit` hint.

There is no chat panel, no feed and no toasts.

**Degraded:** if Hester is offline, the Page still edits: it writes locally and PUTs when Hester is back; see §4.3. Ask shows "Hester offline · queued" and is queued locally.

### 4.2 Page

`components/deep/PageEditor.tsx`, a new CodeMirror component. It reuses EditorPanel's pieces rather than EditorPanel itself.

- Extensions: `markdown()`, `EditorView.lineWrapping`, `history`, `drawSelection`, `highlightSpecialChars`, and the default, history and search keymaps. **No** line numbers, fold gutter, active-line gutter, autocompletion or `crosshairCursor`.
- Layout: a centred column with a max width of about 72ch, generous margins, and themed from the design tokens (`--ground-*`, `--text-*`, `--font-ui` for prose). It doesn't use `oneDark`.
- **Live preview toggle:** `⌘E` inside the Page only, with a scoped listener. It renders `MarkdownPreview`.
- **Margin:** a right gutter column outside the text column. It holds one marker per answer at its re-anchored line: a filled dot when unread, hollow when read, a spinner while pending.
  - Re-anchoring: search for `quote` nearest the stored `offset`. If it isn't found, show the marker at the section heading, else at the top.
  - Clicking a marker expands a card with the question and answer, plus **Insert**, **Keep**, **Follow up** and **Dismiss** (Pin is D2).
  - Nothing in the margin moves the text or takes focus unless clicked.
- **Insert** puts the answer below the anchor's paragraph as a blockquote with the attribution line `> — Hester, <date>`, then PATCHes `inserted`. **Keep** POSTs a `quote` reference with `source {kind:'answer', ref}`. **Follow up** opens the Ask field pre-anchored, with `follow_up_of`. **Dismiss** PATCHes `dismissed`.
- Opening an unread answer card PATCHes `read`.

### 4.3 Saving

- Saves are debounced (800 ms) through `PUT /page` with `base_version`.
- On **409** the renderer keeps your text and shows "Changed elsewhere · Keep mine / Load theirs". Keep mine re-PUTs with the new version; Load theirs replaces the buffer.
- On a network error it retries with backoff and keeps an unsaved-changes dot in the header. The buffer is also mirrored to `localStorage lee:deep:page:<ws>:<id>` (try/catch) so a crash doesn't lose writing.
- **`⌘S`** saves immediately.

### 4.4 Memory across hops

Leaving Deep keeps DeepHost mounted (hidden), so scroll, cursor, selection and undo history survive hops exactly. Switching exploration remounts. The open exploration and view are kept per window in `cockpitModeStore`, and restored on app restart from `localStorage lee:deep:<ws>`.

### 4.5 Input counting

While DeepHost is visible, count keydown, click and wheel events in DeepHost. Every 60 s, and on leaving Deep, log `deep.input {exploration_id, view:'page', keys, clicks, wheels, span_ms}` if any are non-zero (§10.1).

## 5. Selection actions (R, P endpoints)

- A small **action row** appears beside a non-empty Page selection, and disappears when the selection empties.
- **`⌘.`** moves focus into the row; `c`, `k`, `a` and `e` pick an action; Esc returns focus to the text with the selection intact. Clicking works without `⌘.`.
- The letters are handled by a pure `deepRowKey(key)` in `lib/deepModel.ts`, in the style of `keyAction`.

| Action | Key | Call |
|---|---|---|
| **Capture** | `c` | `POST /someday {workspace, text: selection, as:'someday', source:{surface:'lee', exploration_id, section, context: ≤ 300 chars around the selection}}` |
| **Keep** | `k` | `POST /references {kind:'quote', quote: selection, section, source:{kind:'page'}}`; if the selection is exactly a URL, `kind:'link', url` |
| **Ask** | `a` | A one-line field opens under the row. Enter with empty text asks "Explain this." `POST /asks {question, anchor}`. A marker appears in the margin at once, in the pending state |
| **Explore** | `e` | `POST /explore {seed: selection, anchor}`. It doesn't switch; a one-line confirmation in the header reads "Explored: <title>" |

- Each action logs `deep.action {action, exploration_id, chars}`. It never logs content.
- **P, Someday source (`copilot/someday.py`):** `normalize_source` keeps `surface` and `device_id` as today, and additionally `exploration_id` (matches `EXP_ID_RE`), `section` (≤ 200), `url` (http/https only, ≤ 2000), `file` (a workspace-relative path, ≤ 500) and `context` (≤ 500). Unknown keys are dropped. Device principals still override `surface`.
- **Palette (§5.5 of 14, R):** `CommandPalette` gains an optional `exploration?: {workspace, id}` prop. It's passed while in Deep. When present, the footer shows **Keep** (`⌘K` inside the palette), which POSTs the last response text as a `quote` reference with `source {kind:'palette'}`.

## 6. `deep-ask` (P)

- `POST /asks` validates the request: `question` ≤ 2000 chars, and a valid `anchor`. It appends an `Answer` with `status:'queued'`, logs `steward.request {surface:'deep-ask', about_kind:'exploration'}` through `lee_events.ingest`, schedules the run, and returns 202.
- **Runner** (`cockpit/deep_ask.py`):
  - At most 2 runs in flight per workspace, FIFO.
  - Each run sets `status:'running'`, then calls `steward.call_model(ws, 'deep-ask', question, context, rid)` directly. It does **not** call `steward.answer` (no proposals or steer).
  - `deep-ask` is **not** in `STEER_SURFACES`, so `steward.md` is never layered.
  - Hybrid routing and model-call logging come from `agent.process_context` as they are. The user trigger is set from the original request: capture the `model_log` trigger in the route and re-enter it in the task, so logged calls carry `trigger {kind:'user', surface:'deep-ask'}`.
- **Context**, built deterministically and capped at 24 000 chars in this order:
  1. The exploration title and seed.
  2. The anchor's section and the quote with ±1 000 chars around it from `page.md`.
  3. The rest of `page.md`, truncated from the far end.
  4. Open questions.
  5. The last 20 references (quote, url, title, note).
  6. The `follow_up_of` question and answer, if any.
- **Prompt:** a short system section, appended as `steward_context`:
  > You're answering a question asked while the user is thinking and writing. Answer the question directly and concisely, in markdown. Don't offer to do more, don't ask questions back, and don't propose actions.
- **Completion:**
  - Success writes `status:'done'`, `answer`, `answered_at`, and `model` (from the last `model.call` in the request context, if available).
  - Failure writes `status:'error'` and `error` (≤ 300 chars).
  - Either way it then ingests `deep.answer {workspace, exploration_id, answer_id, status}` to Lee.
- **Restart:** on daemon start, `queued` and `running` answers become `interrupted`. The UI offers **Retry**, which re-queues through a user click.
- **Metrics:** add `'deep-ask'` to `metrics.PULL_SURFACES` and bump `FORMULA_VERSION` to 6. That bump is shared with §10, so bump once.

**M:** `INGEST_TYPES` gains `'deep.answer'`. On ingest, M forwards the event to every renderer window with IPC `deep:answer` (`window.lee.deep.onAnswer(cb)`, preload) and doesn't raise an attention item. R refreshes that exploration's answers when the event arrives, and also polls `GET /answers` every 20 s while an answer it asked is pending (so a missed event isn't fatal).

## 7. Typing affordances (R)

`lib/deepModel.ts` exports `affordanceFor(line: string, pasted: boolean): Affordance | null`. It's pure and deterministic:

| Pattern | Offers |
|---|---|
| Trimmed line ends with `?` (and has ≥ 3 words) | **Ask** (the line is the question; anchor = the line) and **Mark open question** (`POST /questions {text, source:'page', anchor}`) |
| The line contains a bare `http(s)://` URL just typed or pasted | **Keep as reference** (`kind:'link'`, `title` = the markdown link text if present) |
| Line starts `later:` or `someday:` (case-insensitive) | **Capture** (the rest of the line) |

- It renders as a dim inline button at the end of the cursor's line (a CodeMirror widget decoration), never a popup.
- It appears after the line matches and the cursor stays on that line for 400 ms. It fades after 5 s, when you type more on the line, or when you leave the line.
- `⌘.` with no selection activates the visible affordance's first option.
- Each shown affordance logs `deep.affordance {pattern: 'question'|'url'|'later', outcome: 'accepted'|'ignored'}` once, when accepted or when it fades.

## 8. The opener (P builder, R surface)

### 8.1 Builder (P)

`copilot/opener.py` exports `build_opener(workspace, *, now=None, events_dir=None) -> Opener`. It's deterministic and uses no model client. It's served by `GET /copilot/opener?workspace=` and logs `opener.shown` (ingested; add it to `INGEST_TYPES`, M).

```jsonc
{
  "generated_at": "...", "workspace": "...",
  "pick_up": {                               // null if no exploration has a session or a Page
    "exploration": { "id", "title", "last_touched_at" },
    "stopped_at": "…the vector clock only helps if every write",  // last SessionRecord.stopped_at, else the last non-empty Page line (≤ 160 chars)
    "arrived": { "answers": 3, "open_questions": 2 }             // answers done since the last session ended, and open questions
  },
  "surfaces": [                              // fixed order, only non-empty ones except blank
    { "kind": "blank" },
    { "kind": "open_questions", "count": 4, "items": [{ "exploration_id", "exploration_title", "question_id", "text" }] },
    { "kind": "captured_away", "count": 3, "items": [{ "someday_id", "text", "surface", "created_at" }] },
    { "kind": "reading_list", "count": 7, "items": [{ "exploration_id", "reference_id", "title", "url" }] },
    { "kind": "q2", "items": [ /* q2_candidates_safe output, at most 5 */ ] },
    { "kind": "quiet", "items": [{ "exploration_id", "title", "last_touched_at" }] }
  ]
}
```

- **pick_up:** the exploration from the most recent `SessionRecord` across the workspace, else the most recently touched exploration with a non-empty Page. Before building, P writes missing session records for Deep sessions that ended `away`/`quit` (§3.6).
- **open_questions:** open `Question`s across active explorations, newest first, up to 10 items.
- **captured_away:** open Someday items whose `source.surface` ∈ {aeronaut, dirigible, device} created after the end of the last Deep session. If there's none, use the last 7 days. Up to 10.
- **reading_list:** `link` references with no `opened_at`, across active explorations, up to 10.
- **q2:** `digest.q2_candidates_safe`, minus `exploration-quiet` (it has its own row).
- **quiet:** active explorations untouched for 7 days or more (`goal_status.QUIET_DAYS`), up to 5, excluding `pick_up`.

### 8.2 Surface (R)

- The opener card sits at the **top of the Copilot section**, above Ask Hester, What next? and Since you left…. It follows 14 §6's mockup: the field "What's on your mind?", then "Pick up where you left off", then "Or start from".
- **Field + Enter:**
  - If the text case-insensitively equals an active exploration's title, open that one.
  - Otherwise `POST /cockpit/explorations {seed: text, page: text + "\n\n", origin:{kind:'opener'}}`, then `deepStart` and open the Page with the cursor at the end.
  - Either way it's one keystroke from typing to writing.
- **Pick up:** Enter or click opens the exploration in Deep, at the saved cursor if this window has one, else at the end of the Page.
- **Surfaces:**
  - **Blank page** creates an exploration with no seed (title "Untitled · <date>") and opens it.
  - **Open questions** and **Reading list** open a small list; picking an item opens its exploration, and for a reading item also opens the URL in the system browser and PATCHes `opened` (Browse is D2).
  - **Captured away** lists the items; picking one creates an exploration seeded from it (`POST /someday/{id}/triage {action:'explore'}`, the v3 path) and opens it.
  - **Q2** items act as they do in the digest.
  - **Quiet** opens that exploration.
- **Refresh:** on load, on `returnNonce`, and every 10 minutes while Copilot is visible.

### 8.3 Landing and Explore (R)

- `DEFAULT_SECTION = 'copilot'`. **On app start the section is always Copilot**, whatever is remembered; the remembered section still applies to switches within the session.
- On return after an absence (`returnNonce`) the section is Copilot, unless a Deep session is active and the window is in Deep.
- **Explore section:**
  - **Dive in / Continue** now opens the exploration in **Deep**: `deepStart({exploration_id})`, then the mode is `deep`.
  - **Open tree** still opens the Library, which switches to Manual.
  - **Open file** points at `<id>/page.md`.
  - The chat-tab dive-in path (`openExplorationTab` → Hester session) is removed from the Explore section; the Library's per-node chats are unchanged.
- **Tasks section:** "Start focus on this task" is removed. Human-lead tasks get their Workbench home in D2.

## 9. Ending ritual (R, M, P)

**End session** (Deep header, and the mode chip's menu while a Deep session is active) opens a small sheet with no chord:

1. **Where did you stop?** A text field pre-filled with the last sentence written on the Page. The renderer tracks the last edited position; the sentence is the text from the previous `.`, `?`, `!` or newline to the next one, ≤ 1 000 chars.
2. **Open questions:** this session's `?`-affordance questions and unread Asks, each with a checkbox, checked by default ("keep open"). Unchecked questions are PATCHed `closed`.
3. **How deep was that?** Three toggle buttons: Deep, mixed, shallow. None is selected by default.
4. **Anything for agents while you're away?** A link, "Hand off…", that opens the existing v1 handoff dialog. The pre-fill from `todo:` lines is D2.
5. Two buttons: **Close Lee** (the default, Enter) and **Stay open**.

**On either button:**
- `POST /sessions` with `SessionRecord {focus_session_id, started_at, ended_at, reason:'ritual', stopped_at, rating, questions_kept}`.
- `deepEnd({reason:'ritual', rating, stopped_at_chars})`.
- The mode changes to `cockpit` (reason `deep_end`).
- **Close Lee** then calls `window.lee.app.quit()`.

**Esc** on the sheet ends the session unrated: `deepEnd({reason:'esc', rating:null})` and a `SessionRecord` with `reason:'esc'`, plus the stopped-at text if you edited it. Closing the sheet with its × means "never mind" and keeps the session.

There are no timers or reminders anywhere.

## 10. G0 metrics (P formulas; M and R events)

### 10.1 Events

| Type | Source | Data |
|---|---|---|
| `focus.start` / `focus.end` with `source:'deep'` | M | as §2.2 (`policy`, `deep_rating`, `stopped_at_chars`, `reason`) |
| `cockpit.mode` | R (via M whitelist) | `{from, to, reason}` with the new modes and reasons |
| `deep.input` | R | `{exploration_id, view, keys, clicks, wheels, span_ms}` |
| `deep.view` | R | `{exploration_id, view}` on entering a view (D1: `page`) |
| `deep.action` | R | `{action: 'capture'|'keep'|'ask'|'explore'|'insert'|'follow_up'|'dismiss', exploration_id, chars?}` |
| `deep.affordance` | R | `{pattern, outcome}` |
| `deep.switcher` | R | `{from, to, via: 'tap'|'overlay'|'chip'}` |
| `deep.answer` | P (ingested) | `{workspace, exploration_id, answer_id, status}` |
| `opener.shown` | P (ingested) | `{workspace, pick_up: bool, surfaces: string[]}` |

Every event carries counts and ids only, never Page text, questions or answers.

### 10.2 Formulas (`copilot/metrics.py`, `FORMULA_VERSION = 6`)

- **`turn_churn`**:
  - An `agent.prompt` counts as churn when the same session (`session_id`, falling back to `pty_id` via `BusyIndex`'s rule) had an `agent.turn_end` ≤ 120 s before it and no other `agent.prompt` between them.
  - The metric is the churn count / `active_hours` → `{value, count, active_hours}`.
- **`deep_time`**:
  - The sum of `deep.input` `span_ms` over events with `keys + clicks + wheels > 0`, in minutes, over the window.
  - The value is minutes per 7 days (scaled when the window differs) → `{value, minutes, sessions}`.
- **`time_to_deep`**:
  - For each Deep session in the window rated `deep` (`focus.end.deep_rating == 'deep'`), find the **start of the stretch**: the latest of Lee's start (the first event of that day's run after a gap of 30 minutes or more with no events) or a return (`presence.change` to `at_machine:true` after ≥ 30 min away), before the session's `focus.start`.
  - Measure the seconds from that start to the session's first `deep.input` with non-zero input.
  - The value is the median → `{value_s, n}`, or `null` when `n = 0`.
- **`session_depth`**:
  - Over Deep `focus.end` events in the window: `{deep, mixed, shallow, unrated, share_deep: deep / (deep+mixed+shallow) | null}`.
- Add all four to the record's `metrics`. Add their names to `goal_status.METRIC_KEY` only if they differ; the record keys are the GOALS.md names.
- `focus_interruptions` stays computed over all sessions. It also gains `deep: <count during source:'deep' sessions>`, which should read 0.

`GOALS.md` isn't edited. Until the human adds G0, the metrics are computed and visible in the readings but no goal cites them.

## 11. Tests

**P** (`tests/copilot/`, run with `PYTHONPATH=$(pwd) ~/.lee/venv/bin/python -m pytest tests/copilot -q`):
- **Migration:** flat → directory, idempotent, directory wins, the id comes from frontmatter or the directory name, and `record_session_turn` write-back works to the new path. Update the existing tests that hard-code `.hester/explore/<id>.md`.
- **Page:** GET/PUT with a version conflict (409 carries the current text), and the size cap.
- **References, questions, sessions:** CRUD, caps, atomic rewrite.
- **deep-ask:**
  - Uses the `FakeAgent` pattern (`test_steward.py`).
  - Queued → running → done, and error.
  - The context order and cap; `steward.md` is never layered for `deep-ask`.
  - The trigger is `user`/`deep-ask` inside the task.
  - Concurrency is capped at 2.
  - Restart marks work interrupted; retry works.
  - The ingest of `deep.answer` is attempted (the Lee client is unreachable in tests, so assert the buffered call).
- **Someday:** `normalize_source` keeps the new fields and drops unknown keys; device override still applies.
- **Opener:** over fixture explorations, someday items and an events dir: pick_up precedence, missing session records written for away-ended sessions, captured_away windowing, reading_list, quiet excluding pick_up, fixed surface order.
- **Metrics:** each G0 formula over fixture events, including the churn session fallback, a rated-only `time_to_deep`, and a scaled `deep_time`; `FORMULA_VERSION == 6` (update the existing asserts for 5).

**M** (smokes; `npm run build:main` first):
- `copilot-queue-smoke.js`:
  - A Deep start replaces an inferred session.
  - A second `deepStart` updates the item.
  - Idle end at 45 min.
  - No inference while any window is in Deep.
  - Policy `none`: neither age nor relatedness escalates; a woken item does.
  - `notify` only for woken items; `NudgeBudget` denies with `'deep'`.
  - `quietCount` counts all open needs-you items.
  - A device `POST /focus/start` becomes a Deep start with `exploration_id:null`.
  - The snapshot has `focus_active:true`, `mode` and `deep`.
- `cockpit-tab-smoke.js`: `validRendererEvent` takes the new modes, reasons and `deep.*` types, and rewrites legacy `'workbench'`.
- **Ingest:** `deep.answer` and `opener.shown` are accepted, and `deep.answer` is forwarded to windows.
- **Shortcuts:** the new registry entries resolve; a `cockpit_toggle` override maps to `mode_switcher`; `menuAccelerator` for resetZoom is gone.

**R** (smokes, esbuild-bundled):
- `cockpit-renderer-smoke.mjs`:
  - The new `nextMode` table, replacing the workbench and wall assertions.
  - The `useHotkeys` chord builder: `⇧⌘0`, `⌥⌘0` and `⌘.` via `e.code`, and old chords unchanged.
  - The switcher state machine: tap, hold, cycle, Esc.
  - `deepRowKey`, and `affordanceFor` over the pattern table with negative cases.
  - Last-sentence extraction for "Where did you stop?".
  - Anchor re-location (moved quote, missing quote → section, then top).
- `cockpit-explore-smoke.mjs`: the new client functions against the stub server (page, asks, answers, references, questions, sessions, explore, opener).
- `npm run typecheck` and `npm run build` pass.

**Everyone:** the existing suites still pass.

## 12. Shared types (M writes these into `electron/src/shared/cockpit.ts` and `shared/copilot.ts` first; R imports)

```ts
// shared/cockpit.ts
export type LeeMode = 'cockpit' | 'deep' | 'manual';
export type ModeReason =
  | 'default' | 'manual' | 'focus_start' | 'focus_end' | 'handoff' | 'return' | 'go_into' | 'open_tab'
  | 'deep_start' | 'deep_end' | 'hop' | 'switcher';
export type DeepView = 'page';                       // 'board' | 'browse' | 'workbench' in D2
export type DeepAction = 'capture' | 'keep' | 'ask' | 'explore' | 'insert' | 'follow_up' | 'dismiss';
export type AffordancePattern = 'question' | 'url' | 'later';
export type DeepRendererEvent =
  | { type: 'deep.input'; data: { exploration_id: string; view: DeepView; keys: number; clicks: number; wheels: number; span_ms: number } }
  | { type: 'deep.view'; data: { exploration_id: string; view: DeepView } }
  | { type: 'deep.action'; data: { action: DeepAction; exploration_id: string; chars?: number } }
  | { type: 'deep.affordance'; data: { pattern: AffordancePattern; outcome: 'accepted' | 'ignored' } }
  | { type: 'deep.switcher'; data: { from: LeeMode; to: LeeMode; via: 'tap' | 'overlay' | 'chip' } };
// CockpitRendererEvent becomes CockpitRendererEvent | DeepRendererEvent.

export type Anchor =
  | { kind: 'page'; quote: string; offset: number; section: string | null }
  | { kind: 'none' };
export interface DeepReference {
  id: string; kind: 'quote' | 'link'; quote?: string; url?: string; title?: string; note?: string;
  section?: string | null; source?: { kind: 'page' | 'palette' | 'answer'; ref?: string };
  at: string; opened_at?: string;
}
export type AnswerStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted';
export interface DeepAnswer {
  id: string; anchor: Anchor; question: string; status: AnswerStatus; answer?: string; error?: string;
  surface: 'deep-ask'; model?: { location: 'local' | 'cloud'; name: string };
  asked_at: string; answered_at?: string; read_at?: string; dismissed_at?: string;
  inserted_at?: string; kept_at?: string; follow_up_of?: string;
}
export interface DeepQuestion {
  id: string; text: string; source: 'page' | 'ask'; anchor?: Anchor;
  status: 'open' | 'closed'; at: string; closed_at?: string;
}
export type DepthRating = 'deep' | 'mixed' | 'shallow';
export interface DeepSessionRecord {
  id: string; focus_session_id: string; started_at: string; ended_at: string;
  reason: 'ritual' | 'esc' | 'away' | 'quit'; stopped_at: string | null;
  rating: DepthRating | null; questions_kept: string[];
}
export type OpenerSurface =
  | { kind: 'blank' }
  | { kind: 'open_questions'; count: number; items: Array<{ exploration_id: string; exploration_title: string; question_id: string; text: string }> }
  | { kind: 'captured_away'; count: number; items: Array<{ someday_id: string; text: string; surface: string; created_at: string }> }
  | { kind: 'reading_list'; count: number; items: Array<{ exploration_id: string; reference_id: string; title: string; url: string }> }
  | { kind: 'q2'; items: unknown[] }
  | { kind: 'quiet'; items: Array<{ exploration_id: string; title: string; last_touched_at: string }> };
export interface Opener {
  generated_at: string; workspace: string;
  pick_up: null | {
    exploration: { id: string; title: string; last_touched_at: string };
    stopped_at: string | null;
    arrived: { answers: number; open_questions: number };
  };
  surfaces: OpenerSurface[];
}
export interface DeepAnswerEvent { workspace: string; exploration_id: string; answer_id: string; status: AnswerStatus }

// shared/copilot.ts
export type FocusItem =
  | /* existing agent | files | workspace | task */
  | { kind: 'exploration'; workspace: string; exploration_id: string | null; title: string };
export type FocusSource = 'manual' | 'inferred' | 'deep';
export interface FocusState {
  active: boolean; session_id: string | null; source: FocusSource | null; started_at: string | null;
  item: FocusItem | null; quiet_count: number;
  policy: 'normal' | 'none';
  deep: { exploration_id: string | null; title: string; workspace: string } | null;
}
export type FocusEndReason = 'manual' | 'away' | 'switch' | 'handoff' | 'quit' | 'deep_end';
export interface DeepStartRequest { workspace: string; exploration_id: string | null; title?: string; surface?: string }
export interface DeepEndRequest { reason: 'ritual' | 'esc'; rating?: DepthRating | null; stopped_at_chars?: number }
// CopilotAPI gains: deepStart(req): Promise<FocusState>; deepEnd(req): Promise<FocusState>;
// window.lee.deep = { onAnswer(cb: (e: DeepAnswerEvent) => void): () => void };
// window.lee.app.quit(): void;
// Attention snapshot gains: mode: LeeMode; deep: { exploration_id: string | null; title: string } | null;
```

## 13. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Where mode lives | Renderer, per window, as today. M learns window modes from `cockpit.mode` events | The mode is a view; the Deep *session* is machine-wide and lives in the focus tracker |
| 2 | Deep session vs mode | The session is a focus session (`source:'deep'`); the mode is per window. Hopping changes the mode, never the session | 14 §3.1: hops never end a session |
| 3 | Answer delivery | Background run; the answer is stored in `answers.jsonl`; `deep.answer` is ingested to Lee and forwarded over IPC; a 20 s poll is the fallback | The daemon has no Cockpit stream or token streaming; "arrives quietly" doesn't need deltas |
| 4 | Ask routing | `steward.call_model` with surface `deep-ask`, steward off, Hester's hybrid routing unchanged | Decided 2026-09-26 |
| 5 | Evidence diffs | Stay in `.hester/explore/evidence/` | Old `diff_path` values stay valid; no second migration |
| 6 | Migration timing | On load, under the workspace lock | "Migrates on first open" (14 §10) without a separate step |
| 7 | Page conflicts | Version check, 409 with both sides kept | The Page is the user's; never drop writing silently |
| 8 | Affordance demotion | Logged now, rule later | Needs data first; 13 §10.3's rule applies once there's a baseline |
| 9 | Device Focus start | Becomes Go deep with no exploration | Keeps today's firmware working (14 §8.1) |
| 10 | `default_mode` config | Removed; Lee opens in the Cockpit on Copilot | 14 §3: never opens in Manual |
| 11 | Reading list without Browse | Opens the URL in the system browser in D1 | Browse is D2; the list is useful before it |
| 12 | Views in D1 | Page only; the other tabs are hidden, not disabled | No dead controls |

## 14. Package seams (S writes these; R1 and R2 build against them)

**S (scaffold)** commits, on `copilot-spec`, before anything else:
1. The §12 types verbatim in `shared/cockpit.ts` and `shared/copilot.ts`. Just enough main-process edits for `npm run typecheck` to pass: `policy: 'normal'`, `deep: null` where `FocusState` is built; `'workbench'` → `'manual'` wherever a literal must satisfy `LeeMode`, including `tabs-main.ts`'s `MODES`, with the legacy alias from §1.1.
2. In `components/cockpit/cockpitMode.ts` (**R1's** afterwards), the Deep navigation API, implemented simply:
   ```ts
   interface DeepNav { exploration_id: string | null; title: string; view: DeepView }
   cockpitModeStore.openDeep(exploration_id: string, title: string): void   // remembers it and sets mode 'deep' (reason 'deep_start' or 'hop')
   cockpitModeStore.getDeep(): DeepNav                                      // this window's Deep memory
   cockpitModeStore.requestEndSession(): void                               // the mode chip's "End session"
   cockpitModeStore.onEndSessionRequest(cb: () => void): () => void
   cockpitModeStore.focusOpener(): void                                     // cockpit + section 'copilot' + focus the opener field
   cockpitModeStore.onFocusOpener(cb: () => void): () => void
   ```
3. `components/deep/DeepHost.tsx` (**R2's** afterwards) as a stub with the final props, rendering nothing:
   ```ts
   export interface DeepHostProps {
     workspace: string;
     visible: boolean;                 // this window's mode is 'deep'
     explorationId: string | null;
     copilot: UseCopilotResult;        // snapshot for the wake line and "N waiting"
     onHop: (to: LeeMode) => void;     // header hint and the wake line
   }
   ```
4. `components/deep/OpenerCard.tsx` (**R2's**) as a stub `export function OpenerCard(props: { workspace: string; returnNonce: number }): JSX.Element | null`. `CopilotSection` (**R2's**) renders it first.
5. `lib/hesterDeep.ts` (**R2's**) as an empty module with a header comment.

S then runs `npm run typecheck` and the existing smokes, and commits with the message `chore(deep): D1 scaffold (types and renderer seams)`.

**Ownership after S:**

| Files | Owner |
|---|---|
| `cockpitMode.ts`, `lib/cockpitModel.ts`, `CockpitHost.tsx`, `CockpitHeader.tsx`, `CockpitModeChip.tsx`, `TabDrawer.tsx`, `App.tsx`, `PanelLayout.tsx`, `TabBar.tsx`, `StatusBar.tsx`, `hooks/useHotkeys.ts`, `sections/*` except `CopilotSection.tsx`, a new `components/cockpit/ModeSwitcher.tsx`, `cockpit.css`, `scripts/cockpit-renderer-smoke.mjs` | R1 |
| `components/deep/**`, `lib/deepModel.ts`, `lib/hesterDeep.ts`, `sections/CopilotSection.tsx`, `CommandPalette.tsx`, a new `scripts/deep-renderer-smoke.mjs`, `scripts/cockpit-explore-smoke.mjs` | R2 |

- **Retiring manual Focus is R1's** (`components/copilot/*` included): the Cockpit header's Focus button, the status bar's "Start focus", `FocusControl.tsx` and `CopilotStatus.tsx` become **Go deep**. Go deep calls `deepStart` with the open exploration from `getDeep()` if there is one; otherwise it calls `cockpitModeStore.focusOpener()`. While a Deep session is active, the status bar shows "Deep · N waiting" in a neutral colour (§3.3 of 14), and the chip's menu has End session (`requestEndSession`).
- R1 mounts `<DeepHost>` in `App.tsx` next to `<CockpitHost>` when the Cockpit is enabled, and passes `CommandPalette` its `exploration` prop while in Deep with an exploration open.
- R2 opens explorations through `window.lee.copilot.deepStart` followed by `cockpitModeStore.openDeep`, and ends sessions through `deepEnd` followed by `cockpitModeStore.set('cockpit', 'deep_end')`.
- R1's Explore section **Dive in** uses the same two calls.
- If a package needs something from another package's file that the contract doesn't give it, it writes the question into its final report rather than editing that file.
