# Copilot v2: implementation contracts

> **Status:** Contract for parallel implementation, 2026-09-25
> **Spec:** [`docs/13-Copilot.md`](../13-Copilot.md) §2.2–§2.3, §4.2, §5, §6.0–§7.7 (minus Goals and Explore), §9, §10 (toil family), §12–§15 · **Goals:** [`GOALS.md`](../../GOALS.md)
> **Builds on:** [`2026-09-25-copilot-v0-v1-contracts.md`](2026-09-25-copilot-v0-v1-contracts.md) (event log, attention queue, hooks, principals, C3 rules, presence). Read its §0, §2, §4.3–§4.4 and §5 first.
> **Branch:** `copilot-spec`. Five work packages (A–E) are built at the same time in separate git worktrees and merged afterwards. F (devices) is deferred.

This document is the only thing the implementers share. Each package depends on the **contracts** here (types, endpoints, IPC channels, file formats, bus interfaces), never on another package's code. If you need something this document doesn't give you, stub it behind the contract and write the question into your final report. Don't reach into another package's files.

**Drift warning.** While v2 is being built, other agents are still editing `electron/src/main/copilot/**`, `electron/src/shared/copilot.ts`, `aeronaut/**` and `dirigible/**`. v2 therefore puts **all** new Electron main-process code in a new directory, `electron/src/main/cockpit/`, and adds its types in a new file, `electron/src/shared/cockpit.ts`. From the v0/v1 code it uses only these stable interfaces:

| Stable v0/v1 interface | Used for |
|---|---|
| `copilotBus`, `logEvent()` from `electron/src/main/copilot/bus.ts` (v0 Appendix B) | writing events; listening to `agent.*`, `attention.*`, `focus.*`, `presence.change`, `input.counts` |
| Types `Actor`, `Principal`, `LeeEvent`, `LeeEventInput`, `LeeEventType`, `LeeStatusBlock`, `AgentState`, `AgentSummary`, `AttentionItem`, `AttentionSnapshot` from `electron/src/shared/copilot.ts` | typing |
| `window.lee.copilot` (`getSnapshot`, `onSnapshot`, `reply`, `snooze`, `dismiss`, `openItem`, `focusStart/Stop`, `capture`, `logCeremony`, `onReturn`) | renderer data and actions |
| `parseLeeStatus(text)` from `electron/src/main/copilot/hook-payload.ts` | check-in replies |
| `getHesterPort()` from `electron/src/main/copilot/capture.ts` | Lee → Hester calls |
| `res.locals.principal` set by the v0 auth middleware | C3 checks |
| `ptyManager.write`, `.get`, `.getAll`, `.isClaudePty`, `.getAgentDefinition`, `.log`, events `'data'`, `'exit'` | tabs, runs |
| `windowRegistry.get/getAll/getFocused`, `contextBridge.getContext()` | tab ↔ PTY ↔ window ↔ workspace mapping |
| Hester `GET/POST /someday*`, `GET /copilot/digest`, `hester/daemon/copilot/event_reader.py`, `lee_events.ingest()` | Someday section, History, event reading |

If one of these changes shape under you, adapt at the call site and report it; don't edit the v0/v1 file.

---

## 0. How to use this document

### 0.1 Packages at a glance

| Pkg | Name | Owns | Depends on (contract only) |
|---|---|---|---|
| **A** | `lee-tab` | PTY output ring and tab state, shell integration and command capture, the `tab` command domain, check-ins, the task/agent **launcher** (incl. relay of task records to Hester), the Feed store's IPC/HTTP, tab lists for the renderer | Appendix A–E |
| **B** | `lee-ops` | Operations: config and `.lee/operations.yaml`, auto-detect and confirm, runs in terminal tabs, status, `produces:` readings, the `ops` command domain and Hester's run/propose rules, operation agents and escalation | Appendix A–E; A's `TabRuntime` and `TaskLauncher` via the cockpit bus |
| **C** | `lee-cockpit-ui` | Renderer: Cockpit/Workbench modes, the Cockpit overlay, agent tiles, the tab drawer, the Launcher and `Run ▾`, sections Feed, Tasks, Operations, Someday, Tabs, History, the rail, mode chip; `App.tsx` integration | Appendix A, D, E; `window.lee.copilot`; Hester HTTP (§6, §9) |
| **D** | `lee-lint` | Lint engine, the four toil rules and their fixes, outcomes and demotion, nudge-budget persistence and HTTP, status-bar `⚠ N` and problems flyout, lint Feed entries | Appendix A–E; B's `OpsProvider`, A's `TaskLauncher` via the bus |
| **E** | `hester-multi-ws` | Hester daemon multi-workspace rework; Cockpit task store, event follower and endpoints; operation readings; History; Someday promote-to-task; metric formula v3; Hester tools for tabs and operations | Lee event log (§2), Lee HTTP (§5.4, §7.8), task file format (§6) |
| F | `devices` | **Deferred to v6** (spec §15 item 7). No new device surfaces in v2; see §11 | — |

The brief suggested one `lee-ops-tab` package; it is split into A and B because the tab runtime (A) is needed by check-ins, the launcher and runs alike, while operations (B) are large enough on their own (five detectors, config writing, runs, agents). They meet only at the `TabRuntime`/`TaskLauncher` interfaces in the cockpit bus.

### 0.2 Verbatim shared files

Four new files are defined in full in the appendices and must be **byte-identical** in every branch that has them. Nobody edits them inside a package. Extract them from the repo root with:

```bash
python3 - <<'EOF'
import re, pathlib
doc = pathlib.Path('docs/plans/2026-09-25-copilot-v2-contracts.md').read_text()
for m in re.finditer(r'<!-- FILE: (\S+) -->\n```\w*\n(.*?)\n```\n', doc, re.S):
    p = pathlib.Path(m.group(1)); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(m.group(2) + '\n'); print('wrote', p)
EOF
```

| File | Appendix | Needed by |
|---|---|---|
| `electron/src/shared/cockpit.ts` | A | A, B, C, D |
| `electron/src/main/cockpit/cockpit-bus.ts` | B | A, B, D (C: no) |
| `electron/src/main/cockpit/cockpit-config.ts` | C | A, B, D |
| `electron/src/main/preload-cockpit.ts` | D | A, B, C, D |

They were typechecked under `tsconfig.main.json` and under the renderer config (`noUnusedLocals`, `noUnusedParameters`, `isolatedModules`) against the current `shared/copilot.ts` and `copilot/bus.ts`, and `cockpit-bus.ts` and `cockpit-config.ts` were run under plain node (Feed dedupe, nudge budget, config merge, the C3 guard on Feed actions).

The v0/v1 verbatim files (`shared/copilot.ts`, `copilot/bus.ts`, `copilot/config.ts`, `preload-copilot.ts`) are **not** re-extracted or edited by any v2 package.

### 0.3 Identical edits

`electron/src/shared/lee-api.ts` and `electron/src/main/preload.ts` get a two-line hook-up (Appendix E) that A, B, C and D all apply character for character, so `window.lee.cockpit` typechecks in every worktree. Git merges identical changes cleanly. No other edits to those two files.

### 0.4 Shared-file rules

| File | Who may edit | Where |
|---|---|---|
| `electron/src/main/api-server.ts` | **A only** (3 anchored edits, §12.A) | B and D reach Express and `/command` through the cockpit bus |
| `electron/src/main/main.ts` | **A** (import + init), **B** (import + init + shutdown), **C** (one replaced line: `resetZoom` accelerator), **D** (import + init + shutdown) | distinct anchors, §12 |
| `electron/src/main/pty-manager.ts` | **A only** (import + one line in `spawn()`) | §12.A |
| `electron/src/renderer/App.tsx` | **C only** (5 anchored edits, §3.8) | |
| `electron/src/renderer/components/StatusBar.tsx` | **C** (mode chip), **D** (lint status) | distinct anchors, §12 |
| `electron/src/shared/shortcuts.ts` | **C only** (one entry) | |
| `electron/src/main/copilot/**`, `electron/src/shared/copilot.ts`, `preload-copilot.ts` | **nobody** | in flight elsewhere |
| `hester/**`, `tests/copilot/**` | **E only** | |
| `aeronaut/**`, `dirigible/**` | **nobody** | F deferred |
| `docs/**`, `GOALS.md`, `CLAUDE.md`, `electron/package.json` | nobody (report doc changes in your final message; new smoke scripts are run with `node` directly, not via npm scripts) | |

New Electron main-process logic goes in **new files under `electron/src/main/cockpit/`**. Modules marked *pure* must not import `electron`, so they can be smoke-tested with plain node after `npm run build:main` (with `electron` stubbed where a module needs it, as `scripts/copilot-queue-smoke.js` does).

### 0.5 Constraints every package must respect

- **C1 local-first.** Nothing leaves the machine unless a user action caused it. Operation health checks probe only `127.0.0.1`/`localhost`. Operation agents and task launches start cloud models only from a click or keypress (or a device action). No new device notification channel.
- **C2 quiet while you work.** No model runs automatically. Lint, the follower, auto-detect, status detection, check-in *proposals* and escalation *proposals* are deterministic code. A check-in types a fixed prompt into **your** agent only when you click Check in (the agent's model then runs, on your action). Hester can propose; it cannot launch or type.
- **C3 the human decides.** Hester (shared token) can **never** type into any PTY through v2: no `send_input`, no check-in, no ad-hoc command, no Feed action (§5.3, §7.8). It can run a *defined, confirmed* operation without `confirm: true` (spec §7.4), which Lee types. Everything else from Hester becomes a Feed **proposal** that shows the exact text and target and runs on one human click. Any text Lee types into an agent was shown to the user first (the Reply box, the fixed check-in prompt on the button, a proposal's `confirm_text`).
- **Never content** (v0 §0.5) still holds for the event log: v2 events carry ids, counts, signatures, program names, paths and timings. Command lines typed in terminals are **never stored anywhere** (user decision 2026-09-25): Lee main keeps recent ones in memory only (§5.2); prompts and typed text never. The agent's own words (summaries, lee-status blocks) remain the one exception, capped at 2000 characters.
- **Ceremony is counted.** Every confirm, assignment, link, dismissal and suppression v2 asks of you is logged as `ui.ceremony` (renderer: `window.lee.copilot.logCeremony(action, target)`; main: `logEvent({type:'ui.ceremony', …})`), with the targets listed in §2.3. A v2 feature that asks for something must remove more toil than it adds (GOALS.md G1 vs G2 tension).

---

## 1. Scope

Only spec §15 item 3 (v2). **Out:** Explore and persisted explorations (v3), the Goals section, Evaluate, steward, "What next?", quadrants as ordering, the `human_balance` strip, launch suggestions and the Q4 note (v4), hygiene/scope/attention/agent-use lint families and project rules (v2–v4 per §1.2, but not this contract), copilot mode (v5), device Cockpit surfaces (v6).

| # | Feature (spec ref) | Pkgs | Moves / makes measurable (GOALS.md) | Costs (two-sided) |
|---|---|---|---|---|
| 1 | Cockpit and Workbench modes; the wall around agent terminals only; agent tiles; own tabs in a drawer (§6.0) | C, A | **peek_rate ↓** (running agents are tiles, not terminals; going in is deliberate and logged), **creative_share ↑** (own tabs one step away); guard **attention_latency** not rising (Approve/Reply on the tile) | Mode switching is a new habit; a "go into" step for agents (counted, not ceremony) |
| 2 | Cockpit sections Feed, Tasks, Operations, Someday, Tabs, History, plus rail digest (§7.1, §7.2, §7.4, §7.6, §7.7, §8.1) | C, A, B, D, E | **catch_up_time ↓** (one place to steer from), **lost_threads** (tasks with last activity become countable), **capture_pickup ↑** (Someday finally visible with triage) | Screen space; polling Hester (local only) |
| 3 | Tasks with leads, confirmed links, created from launches, agent events, check-ins, Someday and lint (§7.2, §2.2) | E, A, C | **attributed_agent_time** (measurable: busy time of sessions linked to confirmed tasks), **background_leverage** "accepted" part (tasks closed accepted), **lost_threads** | Confirm/link/close clicks → `toil_load` (ceremony). Mitigation: launching is zero-field; auto-tasks never *require* confirming |
| 4 | Check-ins and the `tab` domain (§4.2) | A, C, E | **attention_latency** for hook-less agents; **peek_rate ↓** (ask instead of watch); task freshness | The check-in turn costs the agent a turn (on your click) |
| 5 | Operations: `operations:` over `services:`, one-shot/long-running, auto-detect with confirm, terminal tabs as operations, `produces:` readings (§7.4) | B, A, E | **toil_load ↓** (re-running commands, flaky reruns become visible and fixable), **tool_failures** (op failures become Feed items with a task path), goal readings for v4 | One confirm step per detected set (ceremony, counted) |
| 6 | Hester running operations with confirm rules (§7.4) | B, E | **toil_load ↓** ("rebuild and restart the server"), **pull_usage** (asked, typed by type) | Proposal clicks for `confirm: true` and ad-hoc commands (ceremony) |
| 7 | Operation agents on small models, launched by a user action; escalation to a task (§7.4) | B, A | **toil_load ↓** (failure triage), **background_leverage** (agent time on accepted fixes); guard: spend per accepted result (model recorded per task) | Model spend on click (C1-compliant) |
| 8 | Toil lint family with fixes; engine with outcomes, demotion, per-item nudge budget (§10, §3 rule 2) | D, A, B | **toil_load ↓** via fixes; **nudge_acceptance** measurable (fixed / shown); guard **pull_usage** not driven by push (nudge cap) | Nudges (G3 vs flow); each rule demotes itself when ignored |
| 9 | Multi-workspace Hester daemon (§13) | E | Prerequisite for per-workspace Cockpit models across windows; fixes the workstream router serving the boot workspace after a switch (**tool_failures ↓**) | Riskiest change; compatibility kept (§9.7) |
| 10 | Metric formula v3 (attributed_agent_time, background_leverage accepted, toil_load v2 parts, peek_rate with modes, nudge_acceptance) | E | Makes rows 1, 3, 5, 8 measurable | None |

**v2 success test** (read against the confounded baseline, spec §15 decision): `peek_rate` falls without `attention_latency` rising; `attributed_agent_time` is computable and reported; `toil_load` (including ceremony) does not rise after two weeks; `nudge_acceptance` is reported per rule.

---

## 2. Event log additions

Same file, envelope, writer and "never content" rules as v0 §2. Lee main writes v2 events with `logCockpitEvent(type, input)` from the cockpit bus (Appendix B), which casts the new type names into the v0 `LeeEventType` union at runtime; the v0 writer does not validate types. The **ingest allowlist is unchanged**: Hester writes nothing new to the event log in v2.

### 2.1 Types and `data` fields

| type | writer | `data` fields | Notes |
|---|---|---|---|
| `tab.input` | A | `pty_id`, `tab_id?`, `target_kind: 'agent'\|'shell'\|'tui'`, `purpose` (TabInputPurpose), `chars`, `submit` | every write through the `tab` domain, check-ins and op runs; actor = the principal's actor (local user, device, or `{kind:'system'}` for Lee's own op typing). **No text** |
| `tab.read` | A | `pty_id`, `chars`, `lines?` | only for non-`local-user` callers (Hester, devices); renderer tile reads aren't logged |
| `terminal.command` | A | `pty_id`, `tab_id?`, `sig`, `argv0`, `by: 'user'\|'lee'`, `op: string\|null`, `exit_code: number\|null`, `started_at`, `duration_ms`, `cwd_rel: string\|null` | one line when a shell command ends (shell integration only). `sig` = first 12 hex of sha1(normalized command). `cwd_rel` relative to the workspace, null outside it. **No command text** |
| `checkin.start` | A | `checkin_id`, `pty_id`, `session_id?`, `source: 'hook'\|'screen'` | actor = the human who clicked |
| `checkin.result` | A | `checkin_id`, `pty_id`, `session_id?`, `task_id?`, `ok`, `error?`, `source`, `lee_status?` (LeeStatusBlock), `summary?` (agent's words ≤ 2000), `duration_ms` | Hester's follower applies it to the task (§6.4) |
| `checkin.proposed` | A | `pty_id`, `reason: 'hookless_busy'\|'hester'`, `entry_id` | a Feed proposal was created |
| `task.launch` | A | `task_id`, `pty_id?`, `session_id?`, `provider?`, `lead`, `kind`, `confirmed`, `play`, `worktree`, `permission_mode?`, `model?`, `origin_kind` | **no title, no prompt** |
| `operation.run` | B | `run_id`, `op`, `kind`, `by` (RunBy), `pty_id`, `reused_tab`, `confirm_required`, `inputs_sig` | actor = principal's actor, or `{kind:'hester'}` for Hester |
| `operation.result` | B | `run_id`, `op`, `status: 'passed'\|'failed'\|'stopped'\|'unknown'`, `exit_code`, `duration_ms`, `inputs_sig`, `by`, `readings: [{metric, value, unit}]` | readings are numbers parsed by `produces:` |
| `operation.status` | B | `op`, `from`, `to` (OperationStatus) | long-running transitions only |
| `operation.suggested` | B | `count`, `sources: string[]` | once per detection pass with new suggestions |
| `operation.confirmed` | B | `names: string[]`, `count` | also a `ui.ceremony {action:'confirm', target:'operations'}` |
| `operation.proposal` | B | `proposal_id`, `op: string\|null`, `adhoc: boolean`, `by: 'hester'\|'lint'` | **no command text** |
| `operation.proposal_resolved` | B | `proposal_id`, `approved: boolean`, `latency_ms` | actor = the human |
| `opagent.launch` | B | `task_id`, `pty_id?`, `op?`, `purpose: 'fix'\|'adhoc'\|'escalate'`, `model` | |
| `opagent.escalate` | B | `from_task_id`, `task_id`, `op?` | |
| `cockpit.mode` | C (via IPC) | `from`, `to` (LeeMode), `reason` (ModeReason) | `window_id` set by A from the sender |
| `cockpit.go_into` | C (via IPC) | `pty_id`, `agent_state`, `from` (GoIntoFrom) | a deliberate look at an agent terminal |
| `feed.action` | bus | `entry_kind`, `producer`, `action`, `principal` | written by `cockpitBus.actOnFeed` |
| `lint.open` | D | `diag_id`, `rule`, `subject`, `severity`, `item_ref?` | |
| `lint.shown` | D | `diag_id`, `rule`, `surface: 'status'\|'feed'` | once per diagnostic per state; the denominator of nudge_acceptance |
| `lint.outcome` | D | `diag_id`, `rule`, `outcome` (LintOutcome), `fix_id?` | |
| `lint.demote` | D | `rule`, `from`, `to`, `ratio`, `n` | |
| `nudge.claim` | bus | `item_ref`, `source`, `granted`, `reason` | |

### 2.2 Renderer events

The renderer sends `CockpitRendererEvent` on IPC `cockpit:event` (fire-and-forget). A validates the shape and logs it with `source: 'renderer'`, `actor: {kind:'user', surface:'lee'}`, `window_id` of the sender and the window's workspace. Unknown shapes are dropped.

### 2.3 Ceremony targets added in v2

`ui.ceremony` `action` values are the v0 `CeremonyAction`s. v2 `target` strings: `task-confirm`, `task-link`, `task-close`, `task-assign`, `operations` (confirming suggestions), `operation-confirm` (running a `confirm: true` op), `proposal` (approving or rejecting a Hester/lint proposal), `checkin` (never: a check-in you asked for is not ceremony; don't log it), `lint-dismiss`, `lint-suppress`, `feed:<kind>` (dismissals, logged by the bus). Launching work, going into an agent, and replying are **not** ceremony.

---

## 3. Cockpit and Workbench modes (package C)

### 3.1 State model

Mode is **per window**, held in a renderer module-level store (`components/cockpit/cockpitMode.ts`), so the overlay, the status-bar chip and `App.tsx` share it without prop drilling.

```ts
interface CockpitModeState {
  enabled: boolean;                 // cockpit.enabled (from App's merged config prop)
  mode: LeeMode;                    // 'cockpit' | 'workbench'
  reason: ModeReason;
  since: number;
  section: 'feed' | 'tasks' | 'ops' | 'someday' | 'tabs' | 'history';
  enteredPtys: Set<number>;         // agent terminals you went into (shown in the workbench strip)
  selected: { kind: 'tile' | 'feed' | 'row' | 'drawer'; id: string } | null;
}
// cockpitModeStore: get(), subscribe(fn), set(mode, reason), toggle(reason), enter(ptyId), forget(ptyId), select(sel)
// useCockpitMode(opts): subscribes, wires the automatic transitions below, returns { state, stripTabs(centerTabs), isAgentTab(tab) }
```

Every transition calls `window.lee.cockpit.logEvent({ type: 'cockpit.mode', data: { from, to, reason } })`. `section` is remembered per workspace in `localStorage` (`lee:cockpit:<workspace>:section`, wrapped in try/catch). Nothing else persists; on window load the mode is `cockpit.default_mode` (default `cockpit`), or always `workbench` when `cockpit.enabled` is false (then `CockpitHost` renders nothing and `stripTabs` is the identity).

**Agent tab** (what the wall goes around): a tab whose `ptyId` is in `snapshot.agents[].pty_id`, or whose `type === 'agent'`, or whose PTY A reports with `kind: 'agent'` in `TabRuntimeInfo`. Everything else (editor, file viewers, plain terminals, browser, TUIs) is an **own tab**.

### 3.2 Transitions

| Trigger | From → to | reason |
|---|---|---|
| Window load | → `default_mode` | `default` |
| `⌘0` (registry action `cockpit_toggle`) or the mode chip | toggle | `manual` |
| `snapshot.focus.active` false → true | → workbench | `focus_start` |
| `snapshot.focus.active` true → false | → cockpit | `focus_end` |
| `snapshot.away.active` false → true (handoff) | → cockpit | `handoff` |
| `window.lee.copilot.onReturn` | → cockpit | `return` |
| Go into an agent (tile Enter/click, Feed "Open", Tabs row, `cockpit:go-into` from main) | → workbench, `enter(pty)`, activate its tab | `go_into` |
| Open an own tab from the drawer, or an own tab becomes active while in cockpit (⌘1–9, a file opened by Hester) | → workbench | `open_tab` |
| A **new** agent tab becomes active while in cockpit (⇧⌘C, `system:create-tab` with `command: 'claude'`) | stay in cockpit; select its tile | — |
| An existing agent tab becomes active while in cockpit by any other path | → workbench, `enter(pty)` | `go_into` |

"New" = the tab id did not exist 2 s earlier. Going into a **finished** agent is normal (GOALS.md "less reading vs informed review"); `cockpit.go_into` records `agent_state` so metrics can tell a review (idle/waiting) from a peek (busy).

### 3.3 The overlay (never hide terminals)

`CockpitHost` renders the Cockpit through `ReactDOM.createPortal(…, document.body)` as a `position: fixed` layer covering the tab strip and main content, from the bottom of `.title-bar` to the top of `.status-bar` (measure both with `getBoundingClientRect` on mount and on `resize`). **It must not change the layout under it:** no `display: none`, no size change on `.main-content`, `.terminal-container` or `TabBar`. `TerminalPane.safeResize` computes columns from the container's width, so hiding it would resize every agent PTY to one column. Terminals stay mounted and sized underneath.

Keyboard safety (C3): while mode is `cockpit`, a `focusin` listener in the capture phase moves focus back to the overlay root whenever it lands inside `.main-content` or the tab strip (xterm's hidden textarea, CodeMirror), and entering cockpit mode blurs `document.activeElement` first. Keystrokes typed in the Cockpit can never reach an agent PTY underneath. Acceptance tests this (§13.C).

### 3.4 Layout

```
┌ title bar ─────────────────────────────────────────────────────────────────────────┐
├ HEADER: <workspace> · [Cockpit|Workbench ⌘0] ·············· [+ Task n] [Run ▾ o] [Focus] ┤
├ NAV ────────┬ AGENTS (tiles, wraps; collapsible) ───────────────────────────┬ RAIL ──────┤
│ Feed     3  │ ┌ Claude · Fix /fs 404 ┐ ┌ Pi · refactor ┐ ┌ ▶ op: build ┐   │ Since you  │
│ Tasks    2  │ │ busy 12m · Edit      │ │ screen · idle │ │ failed 1m   │   │ left… (v1  │
│ Ops      1  │ │ "Added requireAuth…" │ │ > _           │ │ Fix w/agent │   │ digest)    │
│ Someday  7  │ │ [Approve][Reply][⏎]  │ │ [Check in][⏎] │ └─────────────┘   │            │
│ Tabs     6  │ ├ SECTION: selected (title, one-line summary, rows) ───────────┤ [Ask…]     │
│ History     │ │                                                              │            │
├─────────────┴─┴──────────────────────────────────────────────────────────────┴────────────┤
│ DRAWER: own tabs, names only:  main.py · Terminal 2 · lazygit · Browser        [` focus] │
└ status bar (unchanged; + mode chip left, + ⚠ N right) ───────────────────────────────────┘
```

Badges: ember when the section has needs-you content (Feed: open needs-you/blocking entries and attention items; Tasks: `waiting`/`review` tasks; Ops: failed/crashed/unhealthy ops, proposals and pending suggestions; Someday: open items older than 7 days).

### 3.5 Agent tiles

One tile per agent PTY **in this window's workspace** (any window). Data, merged by the pure `tileModel()` in `lib/cockpitModel.ts`:

| Field | Source (first present wins) |
|---|---|
| state chip | open attention item for the PTY (`approval` → "needs approval", `waiting`/`blocker`/`decision` → "waiting on you"); else `snapshot.agents[i].state` (`busy` with `busy_since` → "busy 12m", `idle` → "idle", `waiting`); else `TabRuntimeInfo.state.state` |
| title | Hester task title for this PTY (`task.agent.pty_id`), else the tab label |
| summary | `snapshot.agents[i].last_summary`, else task `summary`, labelled "Claude says" (the agent's words); for `fidelity: 'screen'` agents, `TabRuntimeInfo.tail` in monospace instead |
| meta | `last_tool`, `files_touched_count`, task `busy_ms`, lead badge, `unconfirmed` badge for auto tasks, model for op agents |
| actions | Approve/Deny (approval item → `window.lee.copilot.reply`), Reply (text item; inline box; the typed text *is* what is shown and sent), **Check in** (hover shows the exact `CHECKIN_PROMPT`; `window.lee.cockpit.checkin`), **Go into** (Enter), Confirm (unconfirmed task → Hester confirm), Accept/Discard (task in `review`) |

`snapshot.agents` is optional (older builds omit it); tiles must render from tabs + items + tasks alone.

### 3.6 Starting agents (⇧⌘C) and the drawer

- ⇧⌘C keeps its existing handler (`createTab('agent', undefined, 'claude')`). In cockpit mode the new tab is created underneath and appears as a selected tile; **Enter** goes into it. In workbench mode it becomes active and is added to `enteredPtys` (you started it where you work). No change to the launch path, so one-offs stay instant (G2 vs speed of one-offs).
- `+ Task` / `n` opens the Launcher (§4.2) for structured launches.
- The **drawer** lists own tabs (all docks) by label and icon only. `` ` `` focuses it, ←/→ select, Enter opens (→ workbench, `open_tab`). Clicking opens.

### 3.7 Keyboard map (inside the Cockpit; ignored while typing in an input)

| Key | Action |
|---|---|
| `⌘0` | Cockpit ↔ Workbench (global, registry `cockpit_toggle`; the menu's Reset Zoom moves to `⇧⌘0`) |
| `1`–`6` | Feed, Tasks, Ops, Someday, Tabs, History |
| `j`/`k` or ↓/↑ | next/previous row in the section |
| `h`/`l` or ←/→ | previous/next agent tile |
| `Enter` | go into the selected agent / open the selected row's target |
| `a` / `d` | approve / deny the selected approval |
| `r` | reply to the selected item (inline box; Enter sends, Shift+Enter newline, Esc cancels) |
| `c` | check in on the selected agent: shows the fixed prompt and target; Enter sends, Esc cancels |
| `n` | Launcher (new task) |
| `o` | `Run ▾` operations menu |
| `x` | dismiss the selected Feed entry |
| `` ` `` | focus the drawer |
| `?` | key help |
| `Esc` | close popovers / clear selection |

`⌘1`–`⌘9`, ⇧⌘C and every other global chord keep working (the existing hotkey map runs first). Known gap: `⌘N` tab numbers follow `centerTabs`, not the filtered strip, so in the workbench they can activate a hidden agent tab (which then counts as going into it).

### 3.8 `App.tsx` integration (C only; five anchored edits)

"Anchor" = insert immediately after the quoted existing line unless stated otherwise. Nothing else in `App.tsx` changes.

1. After `import { attentionByPty } from './lib/copilotAttention';` insert:
   ```ts
   import { CockpitHost } from './components/cockpit/CockpitHost';
   import { useCockpitMode, cockpitModeStore } from './components/cockpit/cockpitMode';
   ```
2. After `  const centerTabs = useMemo(() => tabsWithAttention.filter(t => t.dockPosition === 'center'), [tabsWithAttention]);` insert:
   ```ts
     const cockpitMode = useCockpitMode({ workspace, snapshot: copilot.snapshot, activeTabId, tabs: tabsWithAttention });
     const stripTabs = useMemo(() => cockpitMode.stripTabs(centerTabs), [cockpitMode, centerTabs]);
   ```
3. **Replace** the line `        tabs={centerTabs}` (the first prop of `<TabBar`, the only occurrence) with `        tabs={stripTabs}`.
4. After `    handlers['claude'] = () => createTab('agent' as Tab['type'], undefined, 'claude');` insert:
   ```ts
       handlers['cockpit_toggle'] = () => cockpitModeStore.toggle('manual');
   ```
5. Immediately **before** the line `      <StatusBar` insert:
   ```tsx
         <CockpitHost
           mode={cockpitMode}
           workspace={workspace}
           config={config?.cockpit ?? null}
           tabs={tabsWithAttention}
           activeTabId={activeTabId}
           copilot={copilot}
           onCreateTab={createTab}
           onOpenTab={(tabId: number) => {
             const t = tabs.find((x) => x.id === tabId);
             if (!t) return;
             if (t.dockPosition === 'center') { setActiveTabId(tabId); setFocusedPanel('center'); }
             else handlePanelTabSelect(tabId, t.dockPosition);
           }}
           onAskHester={(prompt: string) => { setPendingPrompt(prompt); setAutoSubmitPrompt(false); setShowCommandPalette(true); }}
         />
   ```

`useCockpitMode` returns a memoized object whose identity changes only when the state changes. `CockpitHost` also owns the **create-tab bridge**: it subscribes to `window.lee.cockpit.onCreateTab`, calls `onCreateTab(type === 'agent' ? 'agent' : 'terminal', 'center', label, command ? { command, args } : undefined)` (for `type: 'agent'` pass `provider` as the label argument the way `createTab('agent', …, provider)` expects), waits (≤ 3 s) until the returned tab id has a `ptyId` in `tabs`, and replies `createTabResult({ request_id, tab_id, pty_id })`. It leaves the new tab inactive unless `activate` is true (restore the previously active tab id right after creation). It also handles `onGoInto` (find the tab by `pty_id`, `onOpenTab`, `enter(pty)`, mode → workbench).

Other renderer edits (C only): `components/StatusBar.tsx` — after `import './copilot/copilot.css';` insert `import { CockpitModeChip } from './cockpit/CockpitModeChip';`, and after `      <div className="status-bar-left">` insert `        <CockpitModeChip />` (shows "Cockpit" / "Workbench ⌘0", plus an ember count of needs-you Feed entries while in the workbench; click toggles). `src/shared/shortcuts.ts` — after the `claude` entry insert
`  { action: 'cockpit_toggle', defaultChord: 'meta+0', scope: 'renderer', group: 'View', description: 'Switch between the Cockpit and the Workbench' },`.
`src/main/main.ts` — **replace** `        { role: 'resetZoom' as const },` with `        { role: 'resetZoom' as const, accelerator: 'CmdOrCtrl+Shift+0' },` (frees ⌘0).

---

## 4. Cockpit sections: data sources

All Hester calls from the renderer go through `lib/hesterCockpit.ts` (C): `fetch('http://127.0.0.1:<hester port>/…?workspace=<abs>', { headers: { Authorization: 'Bearer ' + token, 'X-Lee-Workspace': workspace } })`, reusing `getApiToken()` from `lib/hesterAuth.ts`. A failed Hester call renders "Hester offline" in that section only; Lee-sourced parts (tiles, Feed entries from Lee, Ops, Tabs) keep working (spec §13 degradation).

Refresh: Hester `GET /cockpit/snapshot?since_version=N` every 5 s while the Cockpit is visible, every 30 s otherwise (for badges), and 1 s after any `onSnapshot` change whose agents' states changed. Lee data is pushed (`onChange`/`onSnapshot`).

### 4.1 Feed

Merged by the pure `mergeFeed()` (C) from three sources, newest first with needs-you pinned:

| Source | Kinds | Actions |
|---|---|---|
| `window.lee.copilot` snapshot items (this workspace) | `approval`, `blocker`, `decision`, `failure` (agent exit), `review` (as `event`) | the item's own actions via `window.lee.copilot.*` (reuse `AttentionItemRow` from `components/copilot/`) |
| `window.lee.cockpit.feed` (Lee main FeedStore, this workspace + machine-wide) | `failure` (ops), `proposal` (Hester ops/check-ins, lint escalations, op-agent "save as operation"), `lint`, `event` (check-in results, Hester's tab reads/runs, op passes), `metric` (op readings) | `entry.actions` via `feed.act(id, actionId, payload)`; any `confirm_text` is displayed verbatim before the click takes effect; `dismiss` always |
| Hester snapshot (`tasks.recent_events`) | `event` (task created, auto-task created, closed) | open the task |

Every row can set the rail's "about:" context (§4.7). At most three inline actions per row.

### 4.2 Tasks

Rows: running, waiting, idle, review, then queued, then closed in the last 7 days (Hester `GET /cockpit/snapshot` → `tasks.open` + `tasks.recent_closed`). Each row: title, lead, kind, status, agent tile link, busy time, files count, confirmed badge, serves, workstream, origin. Actions: **Confirm** (auto tasks; one click; optional goal/workstream pickers), **Link…** (goal ids from `GET /cockpit/goals`, workstreams from `GET /workstream/` with `X-Lee-Workspace`), **Accept** / **Discard** (review → closed `done` with `accepted: true` / `discarded`), **Promote…** (→ workstream), **Go into** (if the agent is alive), **Check in**.

**Launcher** (`+ Task`, `n`): one text field (the prompt) and Enter launches with defaults; optional chips: kind (bug/question/prototype/chore), lead (`delegate` default · `human` "I'll do this myself" · `plan`), **play**, worktree (default on for delegate), provider. Calls `window.lee.cockpit.launch(LaunchRequest)`. Zero required fields beyond the prompt (a `human`-lead task needs only a title). Works with Hester down (A spools the record, §5.6). No Q4 note, no suggestion chip (v4).

### 4.3 Operations

From `window.lee.cockpit.ops.list(workspace)` / `onChange`: defined operations (name, kind, status, last result with duration and age, running indicator, linked tab, last readings), services as status rows, **Suggestions** (auto-detected, unconfirmed: checkboxes + **Confirm selected** + Dismiss), **Proposals** (Hester/lint: exact command + target shown; Approve/Reject). Row actions: **Run** (params prompt; `confirm: true` ops show the exact command and target first; serial ports suggested for a `port` param via `serialPorts()`), **Stop**, **Open tab** (go into the linked terminal; own tab → workbench), **Fix with agent** (failed runs; B), **Create task** (failed runs; prefilled from the log excerpt), **Edit** (form → `ops.save`). `Run ▾` in the header lists defined ops, "Run a command…" (ad-hoc, local user; shows the command; runs in a new terminal tab) and "Ask an agent to run…" (op agent, §7.7).

### 4.4 Someday (added to v2 scope for capture_pickup)

- List: Hester `GET /someday?workspace=<ws>&status=open` (toggle "all" → `status=all`), newest first: text, age, source (`lee`/`aeronaut`/`dirigible`), `as: explore` tag.
- Capture field at the top: `window.lee.copilot.capture({ text, workspace, as })` (the existing v0 path, with spooling).
- Triage buttons (deterministic, no model), each `POST /someday/{id}/triage` with `workspace`:

| Button | Body | Also |
|---|---|---|
| **Explore** | `{action:'explore'}` | none in v2 (explorations are v3) |
| **Plan with agent** | `{action:'explore'}` | then `launch({ lead:'plan', prompt: item.text, title: first line, kind:'question', origin:{kind:'someday', ref:id} })` |
| **Promote → task** | `{action:'promote', to:'task'}` | Hester creates a queued, confirmed task (§6.5) and returns it; the row links to it |
| **Keep** | `{action:'keep'}` | |
| **Drop** | `{action:'drop'}` | |

Triage is the capture's own lifecycle, not ceremony: don't log `ui.ceremony` for it (Hester already ingests `someday.triage`).

### 4.5 Tabs

Flat list of every tab in this workspace from `window.lee.cockpit.tabs.list(workspace)` (A) joined with renderer tabs: label, kind, fidelity tier (§7.6: structured / screen / activity), state and quiet time, linked task or operation, `last_command` ("Terminal: npm run dev" for unlinked shells), window. Unlinked rows show **Assign…**: agent → pick an open task without an agent (`POST /cockpit/tasks/{id}/link {pty_id, session_id}`) or "New task from this" (`POST /cockpit/tasks` with `agent`, `confirmed: true`); shell → pick an operation (`ops.linkTab`). Assigning logs `ui.ceremony {action:'assign', target:'task-assign'}`.

### 4.6 History

Hester `GET /cockpit/history?workspace=&days=7`: verified wins (commits on the default branch, merges, decisions, operations passed, Someday decided) and closed tasks with outcome and `accepted`, each with readings from `produces:` where the task or run produced one ("cold_start_ms 1412 (was 1590)"). Goal impact wording ("G1 +180 ms") needs goal metric mapping and is v4.

### 4.7 Rail

The v1 digest (`fetchDigest` from `lib/hesterCopilot.ts`, `GET /copilot/digest?workspace=`), unchanged, with "Progress" first. **Ask Hester…** calls `onAskHester("About <selected item title>: ")`, opening the existing palette with the prompt pre-filled and not auto-submitted (palette surface; the steward is v4). No "What next?" (v4).

---

## 5. Tabs, the `tab` domain, check-ins and the launcher (package A)

### 5.1 Output ring and tab state

A subscribes to `ptyManager.on('data')` and `'exit'` (never edits `api-server.ts`'s own `ptyBuffers`) and keeps, per PTY:

- **Output ring** (*pure*, `cockpit/output-ring.ts`): the last `cockpit.tab.output_buffer_kb` (256) KB of characters, plus a monotonic **cursor** = total characters appended since spawn. `read({since})` returns text after `since` (or from the oldest kept, with `truncated: true`); `read({lines})` returns the last N lines. Text is ANSI-stripped at read time: remove CSI (`\x1b\[[0-?]*[ -/]*[@-~]`), OSC (`\x1b\][^\x07\x1b]*(\x07|\x1b\\)`), other two-byte escapes, apply `\r` (keep text after the last `\r` of each line) and backspaces. Full-screen TUIs (Claude Code) read back noisy; that's accepted for the screen tier, and Claude reports come from hooks anyway.
- **Streaming OSC parser** (*pure*, `cockpit/shell-osc.ts`): recognises, across chunk boundaries, `OSC 133;A`/`B` (prompt), `133;C` (command starts), `133;D[;<exit>]` (command ended), `OSC 633;E;<escaped cmdline>` and `OSC 7;file://<host><path>`. These sequences reach xterm.js, Aeronaut and Dirigible unchanged; all three ignore unknown OSCs (Dirigible `vt.cpp` state `Osc`, verified).
- **Agent session state** from `copilotBus` events (`agent.session_start/prompt/tool/waiting/turn_end/session_end/exit`, keyed by `pty_id`), without touching the v0 queue.

`TabStateInfo.state` is decided in this order (first rule that applies):

| # | Condition | state | source |
|---|---|---|---|
| 1 | PTY no longer exists | `exited` | `none` |
| 2 | PTY has a Claude session (hook events seen) | last event: `prompt`/`tool` → `busy`; `waiting` → `awaiting-input`; `turn_end`/`session_start` → `idle-at-prompt` | `hooks` |
| 3 | Shell with integration seen | after `133;C` without `D` → `busy`; after `D` or `A` → `idle-at-prompt` | `shell-integration` |
| 4 | Agent/TUI with `prompt_pattern`/`awaiting_pattern` (regex strings on the agent or TUI definition in config, read via `ptyManager.getAgentDefinition(provider, windowId)`) matched against the last 5 stripped lines, and quiet ≥ `quiet_ms` | `idle-at-prompt` / `awaiting-input` | `pattern` |
| 5 | Shell (no integration): node-pty foreground process title (`ptyManager.get(id).pty.process`) equals the shell's basename and quiet ≥ `quiet_ms` | `idle-at-prompt`; otherwise `busy` | `foreground` |
| 6 | Output within `quiet_ms` | `busy` | `quiet` |
| 7 | Otherwise | `unknown` | `quiet` |

This answers spec §16 "idle detection for agents without hooks": `prompt_pattern:` and `awaiting_pattern:` live on the agent/TUI definitions in config, no defaults except for shells.

`TabRuntimeInfo.kind`: `agent` if `ptyManager.isClaudePty(id)` or the tab's `type === 'agent'` or it has a `provider`; `shell` for terminal tabs without a command (login shell); `tui` for other PTYs; `other` otherwise. `fidelity`: `structured` for Claude with hooks; `screen` for other agents; `activity` for shells and TUIs. Tab ↔ PTY ↔ window ↔ workspace comes from `windowRegistry` contexts (`ctx.tabs[].ptyId`), exactly as v0 does.

### 5.2 Shell integration and command capture

On by default (`cockpit.shell_integration: true`); applies only to Lee's **default login-shell** PTYs (`spawn()` called with no `command`). A's `cockpit/shell-integration.ts` exports `withShellIntegration(cmd: string, args: string[], env: Record<string,string>, isDefaultShell: boolean): string[]` (mutates `env`, returns args), called once from `pty-manager.ts` (§12.A):

- **zsh:** `env.LEE_ORIG_ZDOTDIR = env.ZDOTDIR ?? ''`, `env.ZDOTDIR = ~/.lee/shell/zsh`. That directory's `.zshenv`, `.zprofile`, `.zshrc`, `.zlogin` each source the user's own file from `${LEE_ORIG_ZDOTDIR:-$HOME}` first; `.zshrc` then installs `precmd`/`preexec` hooks and finally restores `ZDOTDIR` to the user's value so child shells are untouched. Args unchanged.
- **bash:** args become `['--init-file', ~/.lee/shell/bash/lee.bashrc]` (replacing `-l`); that file emulates a login shell (sources `/etc/profile`, then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`), then installs a `PROMPT_COMMAND` hook and a `DEBUG` trap guarded to fire once per command.
- **Other shells** (fish, sh, custom): unchanged; state falls back to rules 5–6.
- Hooks emit only: `OSC 133;D;<status>` (before each prompt except the first), `OSC 133;A`, `OSC 7;file://$HOST$PWD` in precmd; `OSC 633;E;<cmdline>` then `OSC 133;C` in preexec. `<cmdline>` escapes `\` as `\\`, `;` as `\x3b`, and control characters as `\xHH`. Guard with `LEE_SHELL_INTEGRATION=1` so a nested source is a no-op. Nothing else is printed; the user's prompt is not modified.
- Scripts are written at Lee start to `~/.lee/shell/` (dir `0700`, files `0644`) and overwritten each start. `cockpit.shell_integration: false` stops injection.

On `133;C` A emits `cockpitBus.emitTerminal({phase:'start', …})`; on `133;D` it emits `phase:'end'` with `exit_code` and `duration_ms`, logs `terminal.command` (§2.1) and keeps the full line **in memory only**: a bounded ring per workspace (last 200 commands: `{ts, sig, text, cwd, pty_id, exit_code, by}`), never written to disk and lost on restart (user decision 2026-09-25: no command text stored anywhere). `by` is `lee` when the command was typed by an operation run (A marks the PTY's next command after a `send` with `purpose: 'operation'`), else `user`. `TabRuntime.commandText(ws, sig)` reads memory only; when the text is gone (after a restart) the "make it an operation" fix opens the operation editor empty with the program name (`argv0`) prefilled.

Normalised command = trimmed, runs of whitespace collapsed to one space. `argv0` = first word after any leading `VAR=value` assignments and `sudo`/`env`/`time`.

### 5.3 The `tab` command domain

Registered with `cockpitBus.registerCommandDomain('tab', …)`; reached through Lee's existing `POST /command` (A's `api-server.ts` edit routes unknown domains to the bus, §12.A). Tabs are addressed by **`pty_id`** (unique machine-wide). `tab_id` is accepted with `window_id`; `tab_id` alone resolves only when exactly one window has it (else `409 {"error":"ambiguous_tab"}`), because renderer tab ids are per window.

| action | params | returns |
|---|---|---|
| `list` | `workspace?` | `TabRuntimeInfo[]` (`last_command.text` always null over HTTP) |
| `state` | `pty_id` (or `tab_id` [+ `window_id`]) | `TabStateInfo` |
| `read_output` | `pty_id`, `since?`, `lines?`, `max_chars?` | `TabReadResult` |
| `send_input` | `pty_id`, `text`, `submit?` | `TabSendResult` |
| `checkin` | `pty_id` | `CheckinResult` |

Envelope: `{"success": true, "data": …}`; errors `{"success": false, "error": "<TabSendError|CheckinError|…>"}` with 403 for `forbidden`, 404 `not_found`, 409 for state errors, 400 `invalid`.

**C3 rules by principal** (the same checks back the IPC channels, where the caller is `local-user`):

| action | local-user (IPC) | device | shared, loopback (Hester, scripts) | shared, LAN |
|---|---|---|---|---|
| `list`, `state` | ✓ | ✓ | ✓ | 403 |
| `read_output` | ✓ | ✓ | ✓ (logs `tab.read`; Feed `event` "Hester read <label> (N lines)", deduped per PTY per 5 min) | 403 |
| `send_input` into an agent PTY | ✓ | ✓ | **403** | 403 |
| `send_input` into a shell/TUI PTY | ✓ | ✓ | **403** (Hester uses `ops`, §7.8) | 403 |
| `checkin` | performs it | performs it | **creates a Feed proposal** (202, `proposed: true`) | 403 |

**Send rules** (all principals that may send):
- Agent PTY: state must be `idle-at-prompt`. `busy` → `busy` (never interrupt a running turn); `awaiting-input` → `awaiting_input` (a permission prompt is answered only by v0 Reply, i.e. your click); `unknown` → `state_unknown` unless `force: true` from `local-user`. Text: 1–4000 chars after stripping control characters except `\n`/`\t`; written as bracketed paste (`\x1b[200~` … `\x1b[201~`), then `\r` after 30 ms when `submit`.
- Shell/TUI PTY: `idle-at-prompt` required except for `purpose: 'manual'` from a human. One line only (no `\n`), control characters rejected; `\r` appended when `submit`.
- Every send logs `tab.input` (no text). Sends by Lee on your behalf (check-ins, op runs) post a Feed `event` whose `text` is the exact text sent and who asked (spec §4.2 "logged to the Cockpit feed"); Feed entries live in memory in Lee main and the renderer, never the event log.

The renderer is responsible for showing typed text before sending it (C3): the Reply box shows your text; the Check in button's hover and the `c` confirm show `CHECKIN_PROMPT`; proposals show `confirm_text`.

### 5.4 Other HTTP routes (A, via `cockpitBus.withExpressApp`)

| Method & path | Returns | Principal |
|---|---|---|
| `GET /cockpit/tabs?workspace=` | `TabRuntimeInfo[]` (text null) | any except shared LAN |
| `GET /cockpit/feed?workspace=` | `FeedSnapshot` | any except shared LAN |
| `POST /cockpit/feed/:id/act` `{action, payload?}` | `FeedActionResult` | device only (shared → 403 via the bus guard; local user uses IPC) |
| `POST /cockpit/launch` `LaunchRequest` | `LaunchResult` | device only (a launch runs a model: shared → 403, C2) |

### 5.5 Check-ins

`checkin(ptyId, {force?})` for a human; `tab.checkin` from Hester becomes a proposal.

1. Resolve the PTY; it must be `kind: 'agent'` (`not_agent`). One check-in per PTY at a time (`in_progress`).
2. State gate: `busy` → poll every 1 s up to `cockpit.checkin.wait_idle_s` (120), then `busy`; `awaiting-input` → `awaiting_input` at once (approvals are your click); `unknown` → `state_unknown` unless `force` from `local-user`.
3. Log `checkin.start`; remember `cursor(pty)`.
4. Send `CHECKIN_PROMPT` (Appendix A) with the agent send rule, `purpose: 'checkin'`.
5. Wait up to `cockpit.checkin.timeout_s` (180):
   - `source: 'hook'` (Claude with hooks): the next `agent.turn_end` for that PTY; take `data.lee_status` and `data.summary`.
   - `source: 'screen'`: wait for the state to leave and return to `idle-at-prompt` (quiet ≥ 2 × `quiet_ms`), then parse the **last** fenced `lee-status` block in `read({since: cursor})` with v0 `parseLeeStatus`; summary = the block's `summary`, else the last 20 stripped lines (≤ 2000 chars).
6. Log `checkin.result`; post a Feed `event` "Checked in on <label>: <status>" with the summary (`text_is_agent: true`). Hester's follower updates or creates the task (§6.4). Return `CheckinResult`.

The v0 queue will also see the check-in turn as a turn end (an ambient `review` item); accepted.

**Proposal rule (deterministic, no model):** every 60 s, for each agent with `fidelity: 'screen'` whose state has been `busy` continuously for ≥ `cockpit.checkin.propose_after_min` (20) with no check-in in that time, claim a nudge (`item_ref: "pty:<id>"`, `state_key: "busy-since:<since>"`, `source: 'checkin'`); if granted, post a Feed `proposal` "Check in on <label>?" with action `checkin` (`confirm_text` = `CHECKIN_PROMPT`) and log `checkin.proposed`. The same proposal is what a Hester `tab.checkin` creates (reason `hester`, no nudge claim: you asked Hester). Check-ins you trigger don't count toward `toil_load`.

### 5.6 The launcher and task relay

`TaskLauncher.launch(req, principal, windowId)` (IPC `cockpit:launch` for the renderer; `POST /cockpit/launch` for devices; B for operation agents):

1. `workspace` must be an open window's workspace. Window: the sender's if its workspace matches, else the focused window with that workspace, else any window with it.
2. `task_id` = `req.task_id` or `task-` + 8 lowercase hex. For Claude, `session_id` = `crypto.randomUUID()`.
3. `lead: 'human'` → no agent: relay a task `{status:'queued', agent:null}` and return.
4. Build argv (Claude; provider from `req.provider` or `cockpit.launch.provider`):
   `['--permission-mode', mode, ...(worktree ? ['--worktree', slug] : []), '--session-id', uuid, '-n', title, ...(model ? ['--model', model] : []), ...(tools ? ['--tools', tools.join(',')] : []), ...(allowed ? ['--allowedTools', allowed.join(',')] : []), ...(prompt ? ['--', prompt] : [])]`
   where `mode` = `req.permission_mode` ?? (`plan` lead → `plan`, else `acceptEdits`); `worktree` = `req.worktree` ?? (`delegate` && `cockpit.launch.worktree_for_delegate`); `title` = `req.title` ?? first 60 chars of the prompt ?? "Task"; `slug` as v0 §7.1. The `--` keeps a prompt starting with `-` from being read as a flag; hooks are injected by v0's `withClaudeHooks` because the command is `claude`. Flags verified against `claude --help` 2.1.283: `--model`, `--tools`, `--allowedTools`, `--permission-mode` (choices `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`; there is no `default` any more, `manual` is the prompting mode), `--session-id`, `-n`, `-w/--worktree`. Non-Claude providers: open an agent tab (`type: 'agent', provider`) and reject a `prompt` with `prompt_unsupported`.
5. Open the tab with `TabRuntime.openTab({type:'terminal', command:'claude', args, label, activate: !!req.go_into})`: send `cockpit:create-tab` (`CreateTabRequest`) to the window and wait ≤ 3 s for `cockpit:create-tab-result`. **Fallback** when no result arrives (package C not merged, or an old window): send the v0 channel `system:create-tab` `{type:'terminal', label, command, args}` and learn the PTY from the `agent.session_start` hook whose `session_id` matches (Claude), or from `ptyManager.getAll()` by a new process whose `name` equals the unique label (terminals), within 10 s.
6. Relay the task record to Hester: `POST http://127.0.0.1:<getHesterPort()>/cockpit/tasks` (shared token, header `X-Lee-Workspace`) with `{id, workspace, title, title_source:'user', kind, lead, play, status:'running', agent:{provider, pty_id, session_id, tab_label, model}, serves, confirmed:true, origin: req.origin ?? {kind:'launcher'}}`. On failure append to `~/.lee/spool/tasks.jsonl` (`0600`) and retry every 60 s while non-empty (same pattern as the v0 capture spool). The prompt is never sent to Hester or logged.
7. Log `task.launch`. If `go_into`, send `cockpit:go-into`. Return `LaunchResult`.

`createTask(input)` relays a task with no agent (`status: 'queued'` unless given) the same way; used by lint (§8) and the Someday "Promote" fallback. Everything created through the launcher is **confirmed** (you made it). Automatic tasks come only from Hester's follower (§6.4) and are unconfirmed.

A keeps `pty_id → task_id` for tasks it launched (memory) and reports it as `TabRuntimeInfo.task_id`.

### 5.7 IPC handlers (A)

A registers every `COCKPIT_IPC` channel in Appendix A marked "Package A": `tabsList`, `tabRead`, `tabState`, `tabSend`, `tabFocus`, `checkin`, `launch`, `feedGet`, `feedAct`, `rendererEvent`, `createTabResult`, and pushes `tabsPush` (debounced 500 ms on state/label changes) and `feedPush` (debounced 250 ms on `cockpitBus.feed` `'change'`) to every window. `tabFocus(ptyId)` focuses the owning `BrowserWindow` and sends it `cockpit:go-into {pty_id, tab_id}`. IPC calls act as `{kind:'local-user'}` with `actor {kind:'user', surface:'lee'}` and `window_id` = the sender's.

---

## 6. Tasks (records: package E; launches: package A)

### 6.1 Ownership

| Who | Does |
|---|---|
| **Hester (E)** | The only writer of task files. Serves the task endpoints. Follows Lee's event log to create automatic tasks and keep every task current (busy time, status, summary, files). Links, confirms, closes and promotes on request |
| **Lee main (A)** | Generates task ids at launch, relays explicit tasks to Hester with a spool, logs `task.launch` and `checkin.result` |
| **Renderer (C)** | Reads tasks from Hester; confirm/link/close/promote via Hester endpoints; launches via A |

This keeps launching instant and offline (C1): the agent starts at once; the record reaches Hester when it's up.

### 6.2 Storage

`<workspace>/.hester/cockpit/tasks/<id>.md`, one file per task, mode `0600`, atomic writes (temp + rename), YAML frontmatter with every `CockpitTask` field (Appendix A) plus `applied_through`, and a free-form body for your notes (never parsed). **Not** `.hester/tasks/`: that directory already belongs to Hester's batch Task System (`hester/daemon/tasks/store.py` globs `*.md` there and would fail to parse these). Spec §12's row for Tasks is updated to `.hester/cockpit/tasks/` by this decision.

```markdown
---
id: task-7f3a91c2
workspace: /Users/ben/Development/Lee
title: Fix /fs/list 404 against packaged Lee
title_source: user          # user | agent | auto
kind: bug                   # bug | question | prototype | chore | unknown
status: running             # queued | running | waiting | idle | review | done | discarded
lead: delegate              # delegate | human | plan
play: false
agent: {provider: claude, pty_id: 12, session_id: 0f1c…, tab_label: Fix /fs/list, model: null}
sessions: [0f1c…]
serves: []                  # goal ids from GOALS.md, e.g. [G2]
workstream: null
confirmed: true
confirmed_at: 2026-09-25T14:03:11Z
urgency: null
quadrant: null              # v4
timebox_min: 30             # default 30 for delegate lead (spec §7.2); unused until v4
due: null
origin: {kind: launcher, ref: null}
busy_ms: 0
turns: 0
files: []                   # written paths, max 200
files_count: 0
summary: null               # agent's words
lee_status: null
last_checkin_at: null
commits: []
outcome: null
accepted: null
created_at: 2026-09-25T14:03:11Z
updated_at: 2026-09-25T14:03:11Z
closed_at: null
version: 1
applied_through: "2026-09-25T14:03:11.512Z|mfz1k2a3-4f-9c1e2a"
---
```

Statuses beyond spec §7.2: `queued` (created, not started: `human` lead, Someday promote, lint) and `idle` (the agent finished a turn without reporting a status).

### 6.3 Endpoints (Hester :9000; shared or device token; workspace per §9.3)

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /cockpit/snapshot` | `?workspace=&since_version=` | `CockpitSnapshot` or `{"unchanged": true, "version": N}` |
| `GET /cockpit/tasks` | `?workspace=&status=open\|closed\|all&limit=100` | `CockpitTask[]`, newest `updated_at` first |
| `GET /cockpit/tasks/{id}` | `?workspace=` | `CockpitTask` |
| `POST /cockpit/tasks` | `TaskCreate` (below) | `201 CockpitTask`. **Upsert on `id`**: an existing task is merged (fields given win, except `busy_ms`, `turns`, `files`, `sessions`, which only the follower changes) |
| `PATCH /cockpit/tasks/{id}` | any of `title`, `kind`, `lead`, `play`, `serves`, `workstream`, `timebox_min`, `due`, `status` (`queued`/`running`/`review` only) | `CockpitTask`; a changed `title` sets `title_source: 'user'` |
| `POST /cockpit/tasks/{id}/confirm` | `{serves?, workstream?, title?}` | `CockpitTask` with `confirmed: true`, `confirmed_at` |
| `POST /cockpit/tasks/{id}/link` | `{pty_id?, session_id?, provider?, tab_label?}` | attaches an agent (Tabs "Assign…"); sets `confirmed: true` |
| `POST /cockpit/tasks/{id}/close` | `{status: 'done'\|'discarded', accepted?: bool, note?}` | `CockpitTask`; `accepted` defaults to `status == 'done'`; outcome and commits per §6.6 |
| `POST /cockpit/tasks/{id}/promote` | `{title?}` | `{task, workstream_id}`: creates a workstream in this workspace's `WorkstreamStore` (deterministic; brief = title + the task's summary; `serves` copied) and sets `task.workstream` |
| `GET /cockpit/goals` | `?workspace=` | `[{id, title, kind: 'goal'\|'constraint'}]` parsed from `<workspace>/GOALS.md` headings `### G<n> <title>` and `- **C<n> <title>.**` lines; `[]` if absent (link picker only; the Goals section is v4) |
| `GET /cockpit/history` | `?workspace=&days=7` | `{wins: DigestWin[], tasks: CockpitTask[] (closed in range), readings: Reading[]}` |
| `GET /cockpit/readings` | `?workspace=&metric=&limit=50` | `Reading[]` newest first |

`TaskCreate` = `{id?, workspace, title, title_source?, kind?, lead?, play?, status?, agent?, serves?, workstream?, confirmed?, origin?, timebox_min?, due?, note?}`; defaults `kind: 'unknown'`, `lead: 'delegate'`, `status: 'queued'`, `confirmed: false`, id generated as `task-` + 8 hex when absent.

`CockpitSnapshot` = `{workspace, workspace_id, version, tasks: {open: CockpitTask[], recent_closed: CockpitTask[] (7 d, ≤ 20), recent_events: [{at, task_id, kind: 'created'|'auto_created'|'closed'|'status', text}] (≤ 20)}, workstreams: [{id, title, phase, serves, task_ids}], someday: {open, untriaged_over_7d}, readings: {latest: Reading[] (one per metric)}, generated_at}`. `version` is a per-workspace counter bumped on every task, reading or workstream-link write.

`Reading` = `{ts, metric, value, unit, source: {kind: 'operation', op, run_id}}`.

Hester's own agent tools may **read** tasks but never confirm, link, close or promote them (C3: those are your decisions); E enforces this by giving tools the store's read methods only.

### 6.4 The event follower (E)

`hester/daemon/cockpit/follower.py`, an asyncio task started in lifespan, deterministic, no model (so it runs regardless of presence):

- Every 2 s, read new lines from `~/.lee/events/` using `event_reader` file ordering and a cursor `{file, offset}` stored in `~/.hester/cockpit/follower.json`. With no cursor, start at the beginning of the last 48 h of files. A rotated or truncated file resets its offset.
- Consumes: `task.launch`, `agent.session_start`, `agent.prompt`, `agent.tool`, `agent.waiting`, `agent.turn_end`, `agent.session_end`, `agent.exit`, `checkin.result`, `operation.result`.
- Indexes (rebuilt from task files at start): `session_id → task_id`, `pty_id → task_id` (open tasks), plus closed-task sessions for 24 h (their later events are ignored rather than creating a new task).
- Workspace: `event.workspace`; if null, the registry workspace containing `data.cwd`; else skip.
- **Idempotent:** each task keeps `applied_through` = `"<ts>|<id>"` of the last event applied; events at or before it are skipped. Writes are batched per task per tick; each write bumps `version`.

| Event | Effect |
|---|---|
| `task.launch` | Upsert a stub if the relay hasn't arrived: `{id, lead, kind, confirmed, play, agent:{provider, pty_id, session_id}, title:"(untitled)", title_source:'auto', status:'running', origin:{kind: origin_kind}}` |
| `agent.session_start` | Session with a matching task (by `session_id`) → set `agent.pty_id`. Otherwise remember it as *pending* (no task yet: prewarmed Claudes start sessions nobody uses) |
| `agent.prompt` on a pending session | Create an **automatic** task: `confirmed: false`, `origin: {kind:'agent'}`, `title: "Claude in <basename(cwd)>"`, `title_source: 'auto'`, `kind: 'unknown'`, `lead: 'delegate'`, `status: 'running'`, `agent` from the session |
| `agent.prompt`, `agent.tool` | `status: running` (unless closed); `agent.tool` with `writes: true` adds `files` (dedupe, cap 200) and `files_count` |
| `agent.waiting` | `status: waiting` |
| `agent.turn_end` | `busy_ms += busy_ms`, `turns += 1`, `summary`, `lee_status`; status from `lee_status.status`: `done` → `review`, `blocked`/`waiting` → `waiting`, `in-progress` → `running`, none → `idle`. If `title_source` is `auto`: title = first line of `lee_status.summary` or `summary` (≤ 80 chars), `title_source: 'agent'` |
| `agent.session_end`, `agent.exit` | `agent.pty_id: null`; `running`/`waiting`/`idle` → `review` |
| `checkin.result` | Task by session/pty, else create an unconfirmed task with `origin: {kind:'checkin'}`. Update `summary`, `lee_status`, `last_checkin_at`, status mapping as for `turn_end`, title as above unless `title_source: 'user'` |
| `operation.result` | Append each reading to `<workspace>/.hester/goals/metrics.jsonl` (§7.6) and bump `version` |

### 6.5 Someday promote (E)

`POST /someday/{id}/triage` gains an optional `to: 'task'` for `action: 'promote'`. When present, Hester creates a task `{title: first line of the text (≤ 80), status:'queued', lead:'delegate', kind:'unknown', confirmed:true, origin:{kind:'someday', ref:<someday id>}}`, records `triage.note = "task:<id>"` if no note was given, and returns `{"success": true, "data": {"item": SomedayItem, "task": CockpitTask}}`. Without `to`, behaviour is unchanged (`data` is the item). `explore`/`keep`/`drop` are unchanged.

### 6.6 Close, outcome and commits (deterministic)

On `close`: `closed_at`, `status`, `accepted`. `outcome` = `"<Done|Discarded> by you."` + (`" Agent's last report: "` + `lee_status.summary` or `summary`, labelled as the agent's words) + (`note` if given). No model (the spec's Hester-written outcome from a final check-in is available by clicking Check in first). For `accepted: true`, `commits` = commits on the default branch (`main`, else `master`) since `created_at` (`git log --first-parent --name-only`) whose changed files intersect `files` (≤ 20). Closing is ceremony only when Lee asked for it (it didn't): the renderer logs `ui.ceremony {action:'confirm', target:'task-close'}` only when closing from a Lee prompt, never for a close you started.

### 6.7 Links to goals and workstreams

`serves` holds goal ids from `GOALS.md` (`GET /cockpit/goals`). `workstream` holds a workstream id from this workspace's store. A task linked to a workstream shows under Tasks until v4 moves workstreams under Goals. Any link you make sets `confirmed: true`, since `attributed_agent_time` counts only links you made or confirmed.

---

## 7. Operations (package B)

### 7.1 Config schema

Operations come from three places, merged by name (first wins): `operations:` in `<ws>/.lee/config.yaml` (hand-written), then `<ws>/.lee/operations.yaml` (written by Lee when you confirm), then `services:` (existing DevOps model, read-only mapping). `operation_agent:` comes from `getCockpitConfig(ws).operation_agent`.

```yaml
# <ws>/.lee/config.yaml (hand-written; Lee never rewrites this file for operations)
operation_agent:
  model: claude-haiku-4-5-20251001   # failure triage and single-step ad-hoc ops
  plan_model: sonnet                 # multi-step ad-hoc ops
  escalate_model: sonnet             # when the fix becomes a code task

operations:
  - name: bench-startup
    kind: oneshot                    # oneshot | long-running
    command: npm run bench:startup
    cwd: electron                    # relative to the workspace
    produces: { metric: cold_start_ms, parse: "cold_start_ms=(\\d+)", unit: ms }   # or a list
    idle_ok: true                    # recorded; copilot mode (v5) uses it
  - name: dev-server
    kind: long-running
    command: npm run dev
    cwd: electron
    ports: [5173]
    health: http://127.0.0.1:5173/
    match: ["npm run dev*", "vite*"] # extra globs that link hand-typed commands
  - name: flash-tdeck
    kind: oneshot
    command: idf.py -p {port} flash
    cwd: dirigible/firmware
    params: [port]
    confirm: true                    # outward-facing: always ask
    allowed_tools: ["Bash(idf.py:*)", "Bash(ls /dev/cu.*)"]   # for its operation agent
    notify_on_done: false
    timeout_min: 10
```

`OperationDef` (Appendix A) is the parsed form. Validation: `name` matches `^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$`; `command` non-empty, single line; `produces[].parse` must compile as a JS regex with at least one capture group (invalid entries are skipped with a `lee.log` WARN); `health` must be `http://127.0.0.1…` or `http://localhost…` (else ignored, C1).

`<ws>/.lee/operations.yaml` (machine-written, js-yaml dump; you may hand-edit it):

```yaml
# Written by Lee when you confirm operations in the Cockpit. Hand edits are kept.
# Operations in .lee/config.yaml win on name clashes.
version: 1
operations:
  - name: electron:build
    kind: oneshot
    command: npm run build
    cwd: electron
    detected_from: electron/package.json
    confirmed_at: 2026-09-25T15:02:11Z
dismissed_suggestions: [electron:postinstall]
```

Writing a separate file keeps your comments in `config.yaml` intact (js-yaml can't round-trip them). Confirming is your click (C3).

**Services mapping (read-only):** each `services[i]` (also inside `environments.<active>.services`) becomes a status row `service:<name>` (kind `long-running`, `source: 'service'`, `ports`, `health_checks[0]` as `health`, `service.detect`), and each of its `actions[j]` becomes a one-shot operation `<name>/<action>` with the action's `command`, the service `cwd`, and `confirm: true` when the environment has `confirm_actions: true`. Only `detect: port` (and `flutter`) get live status in v2; `docker`/`supabase` rows show "status: see DevOps". Macros are not mapped.

### 7.2 Auto-detect and confirm

Pure scanners in `cockpit/ops-detect.ts`, over the workspace root and directories up to depth 2 (skipping `node_modules`, `.git`, `build*`, `dist`, `.venv`, `venv`, `Pods`, `.dart_tool`):

| Source | Suggestions |
|---|---|
| `package.json` `scripts` | `<dir>:<script>` → `npm run <script>` (`pnpm`/`yarn` when their lockfile is present); `kind: long-running` for names matching `^(dev\|start\|serve\|watch)` or commands containing `--watch`, `vite$`, `nodemon`, `next dev`; skip `pre*`/`post*` lifecycle scripts |
| `Makefile` | `<dir>:make:<target>` for explicit targets (`^[A-Za-z0-9_.-]+:` not starting with `.`, not pattern rules) |
| `pyproject.toml` | `pytest` when `[tool.pytest.ini_options]` exists or a `tests/` dir is next to it; entries of `[tool.taskipy.tasks]`, `[tool.pdm.scripts]`, `[tool.poe.tasks]` (simple `key = "cmd"` lines; a line-based reader, no TOML dependency) |
| ESP-IDF project (dir with `CMakeLists.txt` including `$ENV{IDF_PATH}/tools/cmake/project.cmake`) | `<dir>:build` (`idf.py build`), `<dir>:flash` (`idf.py -p {port} flash`, `params: [port]`, `confirm: true`), `<dir>:monitor` (long-running, `idf.py -p {port} monitor`) |
| `pubspec.yaml` | `<dir>:analyze` (`flutter analyze`), `<dir>:test` (`flutter test`), `<dir>:run` (long-running, `flutter run`) |

Tools not on `PATH` (this machine: Flutter and ESP-IDF): look in `cockpit.detect.tool_paths`, then `~/Development/flutter/bin`, `~/flutter/bin`, and for IDF an `export.sh` under `$IDF_PATH`, `~/esp/esp-idf`, `~/Development/hardware/esp-idf`; when found, the suggested command uses the absolute path, or prefixes `. <export.sh> >/dev/null && ` for `idf.py`. Names matching `deploy|publish|release|install|flash|dist|upload` get `confirm: true` (spec §16 "operation confirmation": declared per operation, with this inference only as the suggested default).

Detection runs when a workspace is first seen and lazily on `ops.list` when any scanned file's mtime changed (cached per workspace). Suggestions exclude names already defined or dismissed. Nothing inferred ever runs without confirmation. **Confirm selected** appends the chosen suggestions to `operations.yaml` and logs `operation.confirmed` plus one `ui.ceremony {action:'confirm', target:'operations'}` per click, however many were selected.

### 7.3 Running in terminal tabs

`run(OpRunRequest, principal)` (IPC `cockpit:ops:run`, `/command` `ops.run`):

1. Resolve the operation (or ad-hoc `command`, local user only; others → proposal). Substitute `{param}` with single-quoted values; missing → `missing_params`.
2. Principal rules (§7.8). A `confirm: true` operation from the local user or a device requires `confirmed: true` in the request (the UI showed the command and target) and logs `ui.ceremony {action:'confirm', target:'operation-confirm'}`.
3. Pick the tab: `req.pty_id` (must be `kind: 'shell'` at `idle-at-prompt`); else the operation's linked PTY if alive, a shell, and idle at its prompt; else a new tab via `TabRuntime.openTab({type:'terminal', label: '▶ ' + name, activate: false})`, waiting ≤ 10 s for `idle-at-prompt`. **Never** type into a tab whose state is `busy`, `awaiting-input` or `unknown`.
4. Line = `cd '<abs cwd>' && ` (only when the tab's OSC 7 cwd differs or is unknown) + `(export K='v' …; <command>)` when `env` is set, else `<command>`. If the tab has no shell integration, append `; printf '\033]133;D;%s\007' "$?"` so completion is still detected.
5. `TabRuntime.send(pty, {text: line, submit: true, purpose: 'operation'}, principal)`; create an `OperationRun` (`status: 'running'`, `inputs_sig`), link the PTY to the operation, log `operation.run`. For Hester, post a Feed `event` "Hester ran <name> in <label>" with the exact line.
6. Completion: the next `cockpitBus.onTerminal` `phase: 'end'` for that PTY with `by: 'lee'`. `exit_code` 0 → `passed`; 130/143 → `stopped`; other → `failed`; missing → `unknown`. Read the run's output with `TabRuntime.read(pty, {since: startCursor, max_chars: 262144})`, parse `produces:` (§7.6), save the log to `~/.lee/ops/<wsid>/<name>.last.log` (≤ 256 KB, `0600`), log `operation.result`, update state.
7. Feed: `failed` → `failure` entry (needs-you) with actions `create-task`, `fix-with-agent`, `open-tab`; `passed` → an ambient `event` (ttl 1 h) only when `by` is Hester or `notify_on_done` is set; `notify_on_done` also sends the existing `status:push` IPC (`type: 'success'`/`'error'`) to every window.
8. `timeout_min` passed with no completion → `status: 'unknown'` (never killed).

`inputs_sig` = first 12 hex of sha1(`git rev-parse HEAD` + `git status --porcelain=v1 -uno`) in the operation's cwd at start (2 s timeout; null outside git). It is what `toil/flaky-operation` compares.

**Stop:** `ptyManager.write(pty, '\x03')` to the linked PTY of a running operation (logs `tab.input {purpose:'operation', chars:1}`).

**Terminal tabs are operations by default (spec §7.4):** on every `onTerminal` `start` signal with `by: 'user'`, B links the PTY to the defined operation whose normalised `command` (params as `*`) or `match` globs equal the command line, with the same cwd. A linked long-running operation shows `running` while that command runs, even though you typed it. Unlinked shells show as "Terminal: <last command>" (from `TabRuntimeInfo.last_command`).

### 7.4 Status detection

| Kind | Status |
|---|---|
| one-shot | `running` during a run; else the last run's `passed`/`failed`/`stopped`/`unknown`; `idle` if never run |
| long-running | `running` while its command is the foreground command in the linked tab (between `133;C` and `133;D`), or, with no linked tab, while any of `ports` accepts a TCP connection on 127.0.0.1; `unhealthy` when running and `health` returned non-2xx or failed 3 times in a row (probed every 15 s, 2 s timeout); `crashed` when its command ended with a non-zero exit while it was `running`; `stopped` after a zero/130/143 exit; `idle` otherwise |

A `crashed` long-running operation posts a Feed `failure` with severity **blocking** and sends `status:push` (`type: 'error'`) to every window (spec §5: "a running operation that crashed" is blocking). It is not an attention-queue item in v2 (that queue is v0 code, in flight). Transitions log `operation.status`.

State persists in `~/.lee/ops/<wsid>/state.json`: the last 20 runs per operation and the confirmed suggestions' dismissals cache.

### 7.5 Operations snapshot and IPC

`OperationsSnapshot` (Appendix A) via `cockpit:ops:list` and pushed on `cockpit:ops` (one workspace per message, debounced 250 ms). B also registers the other `COCKPIT_IPC` channels marked "Package B" and `GET /cockpit/ops?workspace=` (any principal except shared LAN). B installs `cockpitBus.setOps(provider)` implementing `OpsProvider` (`snapshot`, `suggest`, `setFlag`) for D.

### 7.6 `produces:` → goal metric readings

After a run ends (any status), for each `produces` entry: run the regex over the run's stripped output with the `g` flag and take the **last** match's first group; `Number()` it; skip `NaN`. Readings go into `operation.result.readings` (numbers only, so the event log stays content-free) and the Feed (`metric` entry, ambient, ttl 24 h: "cold_start_ms 1412 (last 1590)"). Hester's follower appends each reading to `<workspace>/.hester/goals/metrics.jsonl`:

```json
{"ts":"2026-09-25T15:10:02.114Z","kind":"reading","metric":"cold_start_ms","value":1412,"unit":"ms","source":{"kind":"operation","op":"bench-startup","run_id":"run_mfz…"},"workspace":"/Users/ben/Development/Lee"}
```

Existing lines written by `hester goals metrics --write` have no `kind` field; readers treat a missing `kind` as `"metrics"`. Goal evaluation over readings is v4.

### 7.7 Operation agents

Launched **only** by a human action (C2): the `fix-with-agent` action on a `failure` entry, "Fix with agent" on an Ops row, or `Run ▾ → Ask an agent to run…`. Never by Hester, a timer or a rule. `startAgent(OpAgentRequest)` builds a `LaunchRequest` and calls `cockpitBus.launcher.launch(req, principal, windowId)` (error `launcher_unavailable` if A is absent):

| Field | `fix` | `adhoc` |
|---|---|---|
| `title` | `Fix: <op>` | `Op: <first 40 chars of request>` |
| `kind`, `lead` | `chore`, `delegate` | `chore`, `delegate` |
| `model` | `operation_agent.model` | `model`, or `plan_model` when `multi_step` |
| `permission_mode` | `manual` | `manual` |
| `tools` | `['Bash', 'Read', 'Grep', 'Glob']` | same |
| `allowed_tools` | `['Read', 'Grep', 'Glob', 'Bash(<first word> <second word unless it starts with ->:*)', ...op.allowed_tools]` | `['Read', 'Grep', 'Glob', 'Bash(ls:*)']` |
| `worktree` | `false` (environment fixes happen in the real tree) | `false` |
| `origin` | `{kind:'operation', ref: op}` | `{kind:'operation', ref: null}` |
| `prompt` | FIX template | ADHOC template |

Without `Edit`/`Write` in `--tools`, an operation agent can't edit tracked files except through Bash commands, which prompt (you approve through the v0 queue) unless they match `allowed_tools` (C3). Templates (fixed text; only the angle-bracket fields are substituted):

```
FIX: You are an operation agent in Lee. The operation "<name>" failed.
Command: <command>
Working directory: <abs cwd>
Exit code: <code>
Last lines of output:
<last 80 stripped lines of the run log>

Find the cause. If it is environmental (a missing dependency, a wrong port, a stale build directory), try the obvious fix and re-run the command once to confirm. Do not edit tracked source files; if the fix needs code changes, stop and say so. End with a lee-status block.
```

```
ADHOC: You are an operation agent in Lee, working in <workspace>. The user asked: "<request>"
Work out the command or commands, run them, and report. Prefer the project's existing scripts (package.json, Makefile, idf.py, flutter). Do not edit tracked source files. If this should become a saved operation, end your summary with one line in the form "operation: <name> | <command> | <cwd relative to the workspace>". End with a lee-status block.
```

Log `opagent.launch`. The agent is an ordinary Claude tab: hooks, waiting items, Reply, busy time, the tile and the task all work unchanged, and its busy time and model are on its task (the spend guard of `background_leverage`).

**After its turns** (B watches `agent.turn_end` for the agent's PTY on `copilotBus`):
- A summary line matching `^operation:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.*)$` → `OpsProvider.suggest` (unconfirmed) plus a Feed `proposal` "Save '<name>' as an operation?" whose `confirm_text` is the command; approving confirms it (ceremony `operations`).
- `lee_status.status == 'blocked'` → claim a nudge (`item_ref: "op:<ws>:<name>"`, `state_key: "blocked:<turns>"`, `source: 'ops'`) and, if granted, a Feed `proposal` "Escalate to a task?". Approving calls the launcher with `lead: 'delegate'`, `model: escalate_model`, `permission_mode: 'acceptEdits'`, `worktree: true`, `origin: {kind:'operation', ref}`, and an ESCALATE prompt: `You are continuing work an operation agent started on "<name>". Its report: <agent's last summary>. Command: <command>. Last lines of output: <excerpt>. Make the code change needed so the operation passes. End with a lee-status block.` Log `opagent.escalate`.

### 7.8 The `ops` command domain and Hester running operations

`cockpitBus.registerCommandDomain('ops', …)`:

| action | params | local-user (IPC) | device | shared, loopback (Hester) | shared LAN |
|---|---|---|---|---|---|
| `list` | `workspace` | ✓ | ✓ | ✓ | 403 |
| `status` | `workspace`, `name` | ✓ | ✓ | ✓ | 403 |
| `result` | `run_id` | ✓ + log tail (≤ 200 lines) | ✓ | ✓ | 403 |
| `run` defined, confirmed, no `confirm: true`, all params given | `workspace`, `name`, `params?` | ✓ | ✓ | **✓ runs** (spec §7.4: "can run when Hester is asked") | 403 |
| `run` with `confirm: true` | same + `confirmed` | ✓ with `confirmed: true` | ✓ with `confirmed: true` | **→ proposal** (`202 {proposal_id}`) | 403 |
| `run` ad-hoc / `propose` | `workspace`, `command`, `cwd?`, `reason?` | runs after the UI's confirm | → proposal | **→ proposal** | 403 |
| `stop` | `workspace`, `name` | ✓ | ✓ | ✓ only for an operation Hester may run | 403 |
| `agent` | — | via IPC `cockpit:ops:agent` only | 403 (no device UI in v2) | **403** (C2) | 403 |

A proposal is an `OperationProposal` (expires after 30 min) plus a Feed `proposal` entry whose `confirm_text` is the exact line to be typed and the target ("in a new terminal tab" or the linked tab's label), with actions `approve`/`reject`; logs `operation.proposal`/`operation.proposal_resolved`. Approving runs it with `by: 'user'` and logs `ui.ceremony {action:'confirm', target:'proposal'}`.

Hester's existing `ui_control` (`tui custom`) and `devops_*` tools can still start commands; they are not changed in v2 (open decision 21). E's new tools route Hester's operations through `ops` (§10).

---

## 8. Work lint: engine and toil family (package D)

### 8.1 Where it runs

In **Lee main**, not the Hester daemon (a deliberate deviation from spec §13, decision 1): every toil signal (event log, terminal commands, operation runs, approvals) is produced in Lee main, the status bar and Feed are Lee surfaces, and it keeps lint independent of the daemon rework. The engine has no model client (spec §1.3). Hester's existing `git_watcher` hints stay where they are until the hygiene family moves (not v2).

### 8.2 Rule interface (*pure*, `cockpit/lint/engine.ts`, `cockpit/lint/types.ts`)

```ts
export interface LintFinding {
  rule: string;
  workspace: string | null;
  subject: string;            // stable within the rule
  message: string;            // fixed wording, no model
  evidence: string[];         // why it fired; each line is a fact
  fixes: LintFix[];           // at least one (spec §10.3 rule 4)
  item_ref: string | null;    // the task/op it's about, else null (engine uses "lint:<ws>:<rule>:<subject>")
  state_key: string;          // changes when the underlying facts change
}

export interface LintContext {
  now: number;
  config(rule: string, workspace: string | null): LintRuleConfig;   // from cockpit-config.ts
  commandText(workspace: string, sig: string): string | null;       // cockpitBus.tabRuntime
  toolInfo(signature: string): { tool: string; preview: string | null } | null;
  ops: OpsProvider | null;                                          // cockpitBus.ops
}

export interface LintFixContext extends LintContext {
  launcher: TaskLauncher | null;                                    // cockpitBus.launcher
  writeClaudeAllow(workspace: string, rule: string): Promise<void>; // §8.4
}

export interface LintRule {
  id: string;                 // e.g. 'toil/repeated-sequence'
  family: 'toil';
  consumes: string[];         // event types (v0 and v2)
  ingest(ev: LeeEvent): void; // history at startup, then live
  evaluate(ctx: LintContext): LintFinding[];
  fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult>;
}
```

**Engine loop:** at startup, stream the last 8 days of `~/.lee/events/*.jsonl` (skip lines whose text doesn't contain `"type":"<a consumed type>"` before `JSON.parse`), `ingest` them; then `copilotBus.on('event')` live. `evaluate` runs 2 s after ingesting (debounced) and every 60 s. Findings are diffed against open diagnostics by `id` = `lint_` + first 12 hex of sha1(rule, workspace, subject):
- new → diagnostic created, `lint.open`;
- present → evidence/message/state updated;
- gone → resolved; if it was **shown** and has no outcome yet, outcome `ignored` (the condition cleared without its fix; spec §10.3 rule 2).
- shown, still open and untouched for 7 days → outcome `ignored` once (it stays listed).

**Visibility and the nudge budget.** The problems flyout lists every open diagnostic (you pulled it). The `⚠ N` count and a Feed `lint` entry are **nudges**: a diagnostic joins them only after `cockpitBus.claimNudge({item_ref, state_key, source:'lint', workspace})` is granted. `focus` denials are retried every 60 s; `same_state`/`overridden` stay quiet until `state_key` changes. When the renderer reports it displayed them (`lint.shown(ids, surface)`), D logs `lint.shown` once per diagnostic per `state_key`.

**Outcomes:** `fixed` only via the diagnostic's own fix; `dismissed` (Dismiss; also `NudgeBudget.override`); `suppressed` (scoped ignore); `ignored` (above). Each is logged as `lint.outcome` and appended to `<ws>/.hester/lint/outcomes.jsonl` (`{ts, diag_id, rule, subject, outcome, fix_id?}`; machine-wide diagnostics use `~/.lee/lint/outcomes.jsonl`). Dismiss logs `ui.ceremony {action:'dismiss', target:'lint-dismiss'}`, suppress `{action:'dismiss', target:'lint-suppress'}`.

**Scoped suppression** (`<ws>/.hester/lint/suppressions.json`): `item` (until the diagnostic's `state_key` changes), `branch` (until `git rev-parse --abbrev-ref HEAD` differs from the value recorded), `workspace` (until removed in the flyout).

**Demotion** (spec §10.3 rule 2): per rule per workspace, over outcomes in the last `demotion.window_days` (30): if there are ≥ `min_outcomes` (10) and (dismissed + ignored + suppressed) / total ≥ `dismiss_ratio` (0.8), the effective severity drops one level (`needs-you` → `warn` → `info`; `info` stays `info` and the rule is **flagged for rework**). Stored in `<ws>/.hester/lint/rules.json`, logged as `lint.demote`, shown in the flyout's rule list. Recomputed daily; a rule recovers one level when the ratio falls below 0.5.

Severity `off` rules produce nothing. Only `warn` and `needs-you` count in `⚠ N`; `info` shows in the flyout and Feed (ambient).

### 8.3 The four toil rules

| Rule (default severity) | Consumes | Fires when | Evidence (fixed wording) | Fixes | `item_ref` |
|---|---|---|---|---|---|
| `toil/repeated-sequence` (warn) | `terminal.command` | Per workspace, the same sequence of 1–`max_len` (3) consecutive **hand-typed** commands (`by: 'user'`, same PTY, gaps ≤ 10 min) occurs ≥ `min_repeats` (3) times, non-overlapping, within `window_days` (7), with `op: null` for all of them; commands shorter than `min_chars` (8) or whose `argv0`/text is in the ignore list (`cd, ls, ll, la, pwd, clear, exit, history, cat, less, head, tail, vim, nvim, nano, code, open, git status, git diff, git log, git add, git commit` + `ignore_commands`) are skipped; a longer sequence suppresses its own sub-sequences | "`<text 1> && <text 2>` run by hand <n> times since <weekday>", "No operation matches it" | `make-operation`: `OpsProvider.suggest(ws, {name: <argv0>-<first arg> (deduped), kind:'oneshot', command: texts joined with ' && ', cwd: common cwd_rel}, 'lint:toil/repeated-sequence')`; result message "Added to Operations suggestions: confirm it there". `ignore-command`: adds the sigs to the workspace suppression list | `cmdseq:<ws>:<sigs>` |
| `toil/flaky-operation` (warn) | `operation.result` | Among the last `window_runs` (10) results of one operation, consecutive runs with the **same `inputs_sig`** flip between `passed` and `failed` ≥ `min_flips` (2) times | "<k> of the last <n> runs failed with no change to HEAD or the working tree", "inputs <sig>" | `create-task`: `launcher.createTask({title: 'Investigate flaky <op>', kind:'bug', lead:'delegate', status:'queued', origin:{kind:'lint', ref:'toil/flaky-operation'}, note: evidence + path of the last failing log})` | `op:<ws>:<op>` |
| `toil/long-wait` (info) | `operation.run`, `operation.result`, `presence.change`, `input.counts` | ≥ `min_occurrences` (3) runs of one operation in `window_days` (7), each started `by: 'user'`, lasting ≥ `min_minutes` (3), during which `at_machine` stayed true (no `presence.change` to false) and Lee `input.counts` keys totalled ≤ 20 (idle but present) | "You waited on <op> <n> times this week (median <m> min)" | `notify-when-done`: `OpsProvider.setFlag(ws, op, 'notify_on_done', true)` ("run it in the background with a notification") | `op:<ws>:<op>` |
| `toil/repeat-approval` (warn) | `attention.reply`, `agent.tool` | (a) the same `tool_signature` approved (`action: 'approve'`) ≥ `min_repeats` (10) times in `window_days` (7); or (b) ≥ `fast_streak` (10) consecutive approvals each with `latency_ms` < `fast_ms` (2000) | (a) "Approved `<tool>: <preview>` <n> times this week"; (b) "<n> approvals in a row, each in under 2 s" | `allow-in-project`: add the rule (a: derived from the tool and preview; b: the 3 most-approved tools in the streak) to `permissions.allow` in `<ws>/.claude/settings.local.json`; `confirm_text` shows the exact rule(s) and file | (a) `approval:<ws>:<signature>`; (b) `approval:<ws>:streak` |

`toolInfo(signature)`: the tool name comes from `agent.tool` events with that `signature`; the preview comes only from the renderer, which reports `{signature, tool, preview}` for approval items it displays (`lint.learnTool`, kept in memory, never persisted or logged). The Bash rule is `Bash(<first word> <second word unless it starts with ->:*)`; Edit/Write/other tools use the bare tool name. A (a)-finding whose preview is unknown is **not emitted** until it's learned (every diagnostic must carry a working fix).

### 8.4 Fix side effects

- `writeClaudeAllow`: read `<ws>/.claude/settings.local.json` (missing → `{}`; invalid JSON → fail with "settings.local.json isn't valid JSON; not changed"), ensure `permissions.allow` is an array, append missing rules, write atomically keeping mode. Only after your click on a fix whose `confirm_text` showed the rule (C3). This is Claude Code's per-user local settings file; Lee's hook installation still never touches `.claude/` (v0 decision 4).
- Every fix returns `LintFixResult.message` for a toast, records outcome `fixed` with `fix_id`, and resolves the diagnostic.

### 8.5 Surfaces

- **Status bar** (`components/lint/LintStatus.tsx`, mounted by D in `StatusBar.tsx`): `⚠ N` (visible warn + needs-you diagnostics for this window's workspace plus machine-wide). Hidden while `snapshot.focus.active` (spec §9: during focus the bar shows only the quiet count). Click → **problems flyout** (portal) grouped by family and rule: message, evidence, fixes (the `confirm_text` is shown inline and a second click applies it), Dismiss, "Ignore for this item" / "until the branch changes" / "in this workspace", and the rule list with demotion flags. Reports displayed ids with `lint.shown(ids, 'status')`. Reports approval tools seen in `window.lee.copilot.onSnapshot` items with `lint.learnTool`.
- **Feed:** D posts each visible diagnostic with `producer: 'lint'`, `kind: 'lint'`, `severity` (`info` → ambient, `warn` → needs-you, `needs-you` → needs-you), `item_ref`, `ref.diag_id`, `actions` = its fixes (≤ 2) + `suppress-item`, `dedupe_key` = diag id; `registerFeedActionHandler('lint', …)` routes actions. Resolving a diagnostic closes its entry.
- The spec's "top diagnostic cycling in the message slot" and "Ask Hester" on a diagnostic are **not** in v2 (they need `StatusMessage` changes and the steward).

### 8.6 D's other duties

- **Nudge budget persistence:** at init set `cockpitBus.nudges.perHour = getCockpitConfig().cockpit.nudges.max_per_hour`, `load()` from `~/.lee/cockpit/nudges.json`, save on `'change'` (debounced 1 s) and at shutdown; drop records older than 30 days.
- **HTTP** (via `cockpitBus.withExpressApp`): `GET /cockpit/lint?workspace=` (`LintSnapshot`; any principal except shared LAN); `POST /nudges/claim` (`NudgeClaimRequest` → `NudgeClaim`; shared loopback only, for the v4 steward); `POST /nudges/override` `{item_ref, state_key}` (shared loopback or device).
- **IPC:** the `COCKPIT_IPC` channels marked "Package D"; push `lintPush` on change (debounced 500 ms).

---

## 9. Multi-workspace Hester daemon (package E)

This is the riskiest part of v2. The design keeps every existing client working unchanged and adds per-workspace state beside the current single binding, rather than replacing it.

### 9.1 Today

- `POST /workspace {path}` (called by Lee's `ptyManager.setDaemonWorkspace` on window focus and workspace change) runs `_switch_workspace`: `set_current_workspace`, reloads plugins, **replaces `app_state.ws_store`**, re-creates the bundle service, re-points the knowledge store/engine, and restarts the git watcher, task watcher, proactive watcher and proactive config manager.
- `get_current_workspace()` (`hester/shared/workspace.py`) is global; `workspace_key_prefix()` derives Redis prefixes (Library sessions) from it at call time.
- **Bug:** `create_workstream_router(ws_store=…)` captures the boot store in its `WorkstreamOrchestrator`, so `/workstream/*` keeps serving the **boot** workspace after a switch while `app_state.ws_store` points elsewhere.
- Copilot routes (v0/v1) already take an explicit `workspace` and build stores per request.

### 9.2 Model

New package `hester/daemon/workspaces/`:

```python
@dataclass
class WorkspaceContext:
    path: Path                      # resolved absolute
    id: str                         # workspace_id(path): first 8 hex of sha1
    sources: set[str]               # {'window', 'request', 'boot', 'active'}
    opened_at: float
    last_used: float
    lock: asyncio.Lock              # serializes task/reading writes
    # lazily created, cached:
    def ws_store(self) -> WorkstreamStore
    def tasks(self) -> CockpitTaskStore          # hester/daemon/cockpit/tasks.py
    def readings(self) -> ReadingsStore          # hester/daemon/cockpit/readings.py
    def someday(self) -> SomedayStore
    def config(self) -> dict                     # _load_workspace_config(path), mtime-cached

class WorkspaceRegistry:
    def get(self, path, source='request') -> WorkspaceContext   # ensure; validates
    def active(self) -> WorkspaceContext                         # the focused window's (POST /workspace)
    def set_active(self, path) -> WorkspaceContext
    def list(self) -> list[WorkspaceContext]
    async def sync_from_lee(self) -> None                        # GET {lee_url}/windows
    def evict_idle(self, now) -> int
```

`app_state.workspaces: WorkspaceRegistry` is created in lifespan right after `set_current_workspace(boot)`, seeded with the boot workspace (`sources={'boot','active'}`).

### 9.3 Which workspace a request is about

A contextvar `request_workspace: ContextVar[Optional[Path]]` in `hester/shared/workspace.py`, set once per authenticated request inside `_call_as_user` (the one place every authenticated request passes through), from the first present of:

1. `?workspace=` query parameter,
2. `X-Lee-Workspace` header,
3. nothing → unset (the active workspace applies).

(JSON-body `workspace` fields, as the copilot routes use, are resolved by the route itself with `resolve_workspace()`, unchanged.)

Validation: absolute, exists, is a directory; else `400 {"error": "workspace must be an absolute directory"}` from the middleware (before the route runs). A valid path is registered (`source='request'`).

`hester/shared/workspace.py` changes:

```python
request_workspace: ContextVar[Optional[Path]]           # new
def get_active_workspace() -> Path                      # new: the old get_current_workspace() behaviour
def get_current_workspace() -> Path                     # now: request_workspace if set, else get_active_workspace()
@contextmanager
def use_workspace(path) -> Iterator[Path]               # new: sets request_workspace for a block (background tasks, tests)
```

`set_current_workspace()` keeps its meaning (sets the active workspace) and is still called by `_switch_workspace`. Because `get_current_workspace()` prefers the request's workspace, every call-time consumer (`workspace_key_prefix`, `model_log` workspace attribution, copilot routes' defaults) becomes per-request **only when a client sends the header or query**. Clients that send neither get exactly today's behaviour.

### 9.4 What is per-workspace and what follows the active workspace

| Component | v2 behaviour |
|---|---|
| Cockpit tasks, readings, history, snapshot (new) | **Per workspace** via `registry.get(current).tasks()` etc. |
| Workstreams (`/workstream/*`, workstream agent tools, `/orchestrate/telemetry` links) | **Per workspace**: `create_workstream_router(ws_store_provider=lambda: registry.get(get_current_workspace()).ws_store(), …)`; the orchestrator is built per request (it holds no state beyond its stores); `init_workstream_tools(provider)` takes the same provider. Fixes the §9.1 bug |
| Someday, digest, retro, metrics (v0/v1) | Already per request; unchanged |
| Library sessions (Redis prefix) | Call-time prefix: per request when the header is sent, else active. The Library pane sends no header → unchanged |
| Chat sessions (`/context*`) | Unchanged: each session carries its own `working_directory` for tools |
| Plugins, knowledge store/engine, git watcher, task watcher, proactive watcher/config, bundle service | **Follow the active workspace**, re-pointed by `POST /workspace` exactly as today. They are about "what you're looking at"; making them per-workspace is v5 (copilot mode iterates workspaces) |
| Event follower (new) | **Machine-wide**, one task, routes events by `event.workspace` |

### 9.5 `POST /workspace` and new endpoints

- `POST /workspace {path}`: meaning is now "**set the active workspace**" (the focused window's). It calls `registry.set_active(path)` (which also registers it, `source='active'`) and then runs `_switch_workspace` for the follow-active singletons, minus the `ws_store` replacement (the registry owns stores now). Response keeps its fields (`success`, `workspace`, `workspace_id`, `changes`) and adds `"workspaces": [{"path", "id", "active"}]`. `GET /workspace` is unchanged (returns the active one).
- `GET /workspaces` → `[{path, id, active, sources, opened_at, last_used}]`.
- `POST /workspaces/open {path}` → registers (source `request`), returns the entry. `POST /workspaces/close {path}` → drops the in-memory context (files untouched; `400` for the active workspace).
- **Sync with Lee:** every 15 s and after each `POST /workspace`, `sync_from_lee()` calls `GET {lee_url}/windows` with the shared token and registers every window workspace (`source='window'`), clearing `window` from those no longer open. Contexts with no `window`/`active`/`boot` source and unused for 30 min are evicted (in-memory only). Cap 32 contexts (LRU beyond that). Lee unreachable → keep the current set.

### 9.6 Concurrency

Task and reading writes take the context's `asyncio.Lock`. The follower and HTTP handlers both use it. Store methods are synchronous file I/O under the lock (small files). The follower never holds a lock across ticks.

### 9.7 Backward compatibility (must hold; acceptance tests it)

| Client | Sends | Behaviour |
|---|---|---|
| Lee main `setDaemonWorkspace` | `POST /workspace` | Same effect for singletons; now also sets active in the registry |
| Lee renderer Library, Workstream pane, command palette, digest, retro, Someday | no header (v1) | Active workspace = focused window's: same as today. Workstream pane now actually follows focus (bug fixed) |
| Lee renderer Cockpit (v2) | `?workspace=` + `X-Lee-Workspace` | Per window's workspace, even when another window is focused |
| `hester chat --daemon-url` TUIs | no header | Unchanged. E adds `X-Lee-Workspace: <--dir or cwd>` to the chat client's requests so model-call attribution and Library prefixes follow the TUI's workspace; the server treats its absence as before |
| Aeronaut / Dirigible (chat, digest, Someday) | device token, `workspace` param where they already send it | Unchanged |
| `hester workstream` CLI (`DAEMON_URL`) | no header | Active workspace, as today |

### 9.8 Cockpit endpoints keyed by workspace

Every §6.3 endpoint resolves its workspace with §9.3 (query or header, else active) and uses `registry.get(ws)`. Responses include `workspace` and `workspace_id`. The renderer always sends both query and header (§4).

---

## 10. Hester tools and metrics (package E)

### 10.1 Tools (user-triggered surfaces only)

New `hester/daemon/tools/cockpit_tools.py` with definitions in `hester/daemon/tools/definitions/cockpit_tools.py`, registered like `devops_tools`. All call Lee `POST /command` with the shared token via `LeeContextClient.send_command` (or the `ui_control` helper), passing `X-Lee-Workspace`:

| Tool | Lee call | Notes |
|---|---|---|
| `cockpit_tasks` | (Hester store, read-only) | list open tasks for the workspace |
| `lee_tabs` | `tab.list` | |
| `lee_tab_read` | `tab.read_output {pty_id, lines ≤ 200}` | logged by Lee as `tab.read` + Feed event |
| `lee_tab_checkin` | `tab.checkin {pty_id}` | always becomes a proposal the user clicks |
| `lee_operations` | `ops.list` | |
| `lee_operation_run` | `ops.run {name, params}` | runs only defined, confirmed, non-`confirm` ops; otherwise returns the proposal id; the tool's reply tells the user to approve it in the Cockpit |
| `lee_operation_propose` | `ops.propose {command, cwd, reason}` | ad-hoc |
| `lee_operation_result` | `ops.result {run_id}` | for "did it pass?" and turning a failure into a task suggestion in the reply |

No tool can confirm, link, close tasks, send input, approve proposals or launch agents.

### 10.2 Metric formula v3 (`hester/daemon/copilot/metrics.py`, `formula_version: 3`)

| Metric | Change |
|---|---|
| **attributed_agent_time** (new) | Σ `agent.turn_end.busy_ms` whose `session_id` belongs to a task (task files, any workspace in range) with `confirmed: true` at computation time ÷ Σ all `agent.turn_end.busy_ms`. Tasks with `play: true` still count (play is chosen) |
| **background_leverage** | "accepted" part now available: Σ busy_ms of sessions of tasks closed with `accepted: true`, per hour of focus time; report busy-only too. Guards: spend per accepted task (model + busy_ms reported), reverted share still unavailable |
| **toil_load** | add: manual command repeats (`terminal.command by:'user'` whose `sig` was run by hand ≥ 2 times in the previous 7 days and `op` is null), flaky reruns (an `operation.run` whose previous run of the same `op` with the same `inputs_sig` failed), and the v2 ceremony targets (§2.3) via `ui.ceremony`. Remove `toil_load.command_repeats` from `unavailable` |
| **peek_rate** | a `tab.focus` interval is cut at `cockpit.mode to=cockpit` (the overlay covers tabs) and restarts at the next `tab.focus` after `to=workbench`. `cockpit.go_into` into a busy agent followed by no keys is a peek; into an idle/waiting agent it is a review (not counted) |
| **nudge_acceptance** (new) | `lint.outcome outcome='fixed'` ÷ (`fixed` + `dismissed` + `suppressed` + `ignored`), overall and per rule |
| **lost_threads** (new, partial) | tasks not closed with no follower update for 7 days |

`unavailable` lists what still can't be computed (`background_leverage.reverted`, goal-linked parts of `human_balance`).

### 10.3 Digest wins

`GET /copilot/digest` gains a win kind `operation`: `operation.result status='passed'` in range for the workspace, `title: "<op> passed"`, `verified: true`, `ref: run_id`. History (`/cockpit/history`) reuses it.

---

## 11. Devices (package F: deferred)

No Aeronaut or Dirigible changes in v2 (spec §15 item 7: devices render the full Cockpit model in v6). Checked for compatibility: v2 adds **no** new `/context/stream` message types; the new OSCs in PTY streams (133, 633, 7) are ignored by Dirigible's VT parser (`vt.cpp`, `State::Osc`) and by `xterm` 4.x in Aeronaut; devices can already reach `POST /cockpit/launch` and `POST /cockpit/feed/:id/act` with their tokens, but no device UI uses them yet. Aeronaut's "In flight" view keeps reading `snapshot.agents`.

---

## 12. Work packages

Each package lists files it **OWNS** (create or edit freely) and **SHARED** edits it may make (only what is listed, at the stated anchors). "Anchor" = insert immediately after the quoted existing line unless stated otherwise. Every Lee package (A–D) also extracts the four verbatim files (Appendix A–D) and applies the identical edits (Appendix E).

### A. `lee-tab`

**OWNS (new, under `electron/src/main/cockpit/`):**
- `output-ring.ts` (*pure*): §5.1 ring, cursor, `read`, ANSI strip.
- `shell-osc.ts` (*pure*): streaming OSC 133/633/7 parser.
- `tab-state.ts` (*pure*): the §5.1 state table as a function of its inputs.
- `shell-integration.ts`: writes `~/.lee/shell/**`; `withShellIntegration()` (§5.2).
- `command-history.ts`: in-memory ring per workspace (append, lookup by sig); never persisted.
- `tab-runtime.ts`: implements `TabRuntime` (ptyManager subscriptions, window mapping, create-tab bridge with fallback).
- `tab-domain.ts`: the `tab` command domain and its C3 table (§5.3).
- `checkin.ts`: §5.5 including the proposal rule.
- `launcher.ts`: `TaskLauncher`; exported *pure* `buildClaudeArgs(req, ids)`.
- `task-relay.ts`: Hester relay and `~/.lee/spool/tasks.jsonl`.
- `tabs-main.ts`: `initCockpitTabs({ ptyManager })`: `cockpitBus.setTabRuntime/setLauncher`, command domain, IPC (§5.7), HTTP (§5.4), Feed push, renderer-event logging, Feed action handlers for producers `tabs`, `checkin`, `launch`.
- `electron/scripts/cockpit-tab-smoke.js`.

**SHARED edits:**
- `api-server.ts`:
  1. Anchor `import { registerQueueRoutes } from './copilot/queue-routes';` → `import { cockpitBus } from './cockpit/cockpit-bus';`
  2. Anchor `    registerQueueRoutes(this.app, { ptyManager: this.ptyManager });` → `    cockpitBus.setExpressApp(this.app);`
  3. In `POST /command`, **replace** the block
     ```ts
               default:
                 res.status(400).json({
                   success: false,
                   error: `Unknown domain: ${domain}. Use: system, editor, tui, panel, status, browser`,
                 });
     ```
     with
     ```ts
               default: {
                 // Copilot v2 domains ('tab', 'ops') register on the cockpit bus.
                 const cockpitDomain = cockpitBus.getCommandDomain(domain);
                 if (cockpitDomain) {
                   const out = await cockpitDomain(action, params, res.locals.principal as Principal | undefined);
                   res.status(out.status).json(out.body);
                   return;
                 }
                 res.status(400).json({
                   success: false,
                   error: `Unknown domain: ${domain}. Use: system, editor, tui, panel, status, browser, tab, ops`,
                 });
               }
     ```
     (`Principal` is already imported in `api-server.ts`.)
- `main.ts`: (1) anchor `import { initCopilotQueue } from './copilot/queue';` → `import { initCockpitTabs } from './cockpit/tabs-main';`; (2) anchor `  initCopilotQueue({ ptyManager });` → `  initCockpitTabs({ ptyManager });`.
- `pty-manager.ts` (A only): (1) anchor `import { isClaude, withClaudeHooks } from './copilot/hook-install';` → `import { withShellIntegration } from './cockpit/shell-integration';`; (2) in `spawn()`, anchor ``    env.LEE_API_URL = `http://127.0.0.1:${this.apiPort}`;`` → `    finalArgs = withShellIntegration(cmd, finalArgs, env, !command);`.

**Stubs:** without C, the create-tab bridge falls back (§5.6 step 5). Without E, the relay spools.

**Must not touch:** `electron/src/main/copilot/**`, the renderer, other packages' files.

### B. `lee-ops`

**OWNS (new, under `electron/src/main/cockpit/`):**
- `ops-config.ts` (*pure*): parse/validate/merge `operations:`, `operations.yaml`, `services:` (§7.1).
- `ops-detect.ts` (*pure*): the five detectors and tool-path resolution (§7.2).
- `ops-file.ts`: read/write `<ws>/.lee/operations.yaml`.
- `ops-produces.ts` (*pure*): §7.6 parsing.
- `ops-runtime.ts`: runs, linking, status, health probes, state persistence (§7.3–§7.4).
- `ops-domain.ts`: the `ops` command domain and proposals (§7.8).
- `ops-agent.ts`: operation agents, templates, save-as-operation, escalation (§7.7).
- `ops-main.ts`: `initCockpitOps({ ptyManager })`, `shutdownCockpitOps()`; `cockpitBus.setOps`, IPC (§7.5), HTTP, Feed action handler for producer `ops`.
- `electron/scripts/cockpit-ops-smoke.js`.

**SHARED edits:**
- `main.ts`: (1) anchor `import { logEvent } from './copilot/bus';` → `import { initCockpitOps, shutdownCockpitOps } from './cockpit/ops-main';`; (2) anchor `  initCopilotCore({ apiServer, ptyManager });` → `  initCockpitOps({ ptyManager });`; (3) in `will-quit`, anchor `  mdnsAdvertiser?.stop();` → `  shutdownCockpitOps();`.

**Stubs:** `cockpitBus.tabRuntime`/`launcher` may be null in B's worktree: `run` returns `{success:false, error:'tab_runtime_unavailable'}`, `startAgent` `launcher_unavailable`. The smoke test installs a fake `TabRuntime` that records sends and emits terminal signals.

**Must not touch:** `api-server.ts`, `pty-manager.ts`, A's or D's files.

### C. `lee-cockpit-ui`

**OWNS (new):**
- `electron/src/renderer/components/cockpit/`: `CockpitHost.tsx`, `cockpitMode.ts`, `CockpitHeader.tsx`, `CockpitNav.tsx`, `AgentTiles.tsx`, `AgentTile.tsx`, `TabDrawer.tsx`, `Launcher.tsx`, `RunMenu.tsx`, `CockpitRail.tsx`, `CockpitModeChip.tsx`, `KeyHelp.tsx`, `sections/FeedSection.tsx`, `sections/TasksSection.tsx`, `sections/OperationsSection.tsx`, `sections/SomedaySection.tsx`, `sections/TabsSection.tsx`, `sections/HistorySection.tsx`, `cockpit.css`.
- `electron/src/renderer/lib/cockpitModel.ts` (*pure*: `mergeFeed`, `tileModel`, `stripTabs`, `isAgentTab`, `nextMode(state, trigger)`, `keyAction(key, ctx)`), `electron/src/renderer/lib/hesterCockpit.ts` (typed wrappers for §6.3 and Someday), `electron/src/renderer/hooks/useCockpit.ts`, optional dev fake `hooks/cockpitFake.ts` behind `import.meta.env.DEV && localStorage.getItem('cockpitFake') === '1'` (tree-shaken from production).
- `electron/scripts/cockpit-renderer-smoke.mjs` (compiles `lib/cockpitModel.ts` with esbuild, like `copilot-renderer-smoke.mjs`).

**SHARED edits:** `App.tsx` (the five edits in §3.8, nothing else); `StatusBar.tsx` (anchor `import './copilot/copilot.css';` → the `CockpitModeChip` import; anchor `      <div className="status-bar-left">` → `        <CockpitModeChip />`); `src/shared/shortcuts.ts` (anchor the `action: 'claude'` entry line → the `cockpit_toggle` entry, §3.8); `main.ts` (replace the `resetZoom` line, §3.8).

**Stubs:** if `window.lee.cockpit` is undefined, or an invoke rejects with "No handler registered", treat it as empty data (and if `tabs.list` itself is unavailable, force workbench and render nothing). Use existing CSS variables and existing `IconName`s; don't regenerate design tokens or icons (`design/build.mjs`).

**Must not touch:** anything in `src/main/` beyond the verbatim/identical-edit files and the one `main.ts` line; `components/copilot/**` (import `AttentionItemRow` read-only).

### D. `lee-lint`

**OWNS (new):**
- `electron/src/main/cockpit/lint/`: `types.ts`, `engine.ts` (*pure*), `event-scan.ts`, `store.ts` (outcomes, suppressions, demotions), `rules/repeated-sequence.ts`, `rules/flaky-operation.ts`, `rules/long-wait.ts`, `rules/repeat-approval.ts` (all *pure*), `claude-allow.ts`.
- `electron/src/main/cockpit/lint-main.ts`: `initCockpitLint()`, `shutdownCockpitLint()`, IPC, HTTP (§8.6), Feed producer `lint`, nudge persistence.
- `electron/src/renderer/components/lint/`: `LintStatus.tsx`, `LintFlyout.tsx`, `lint.css`.
- `electron/scripts/cockpit-lint-smoke.js`.

**SHARED edits:**
- `main.ts`: (1) anchor `import { fsWatcher } from './fs-watcher';` → `import { initCockpitLint, shutdownCockpitLint } from './cockpit/lint-main';`; (2) anchor `  mdnsAdvertiser = new MdnsAdvertiser((level, message, details) => ptyManager.log(level, message, details));` → `  initCockpitLint();`; (3) in `will-quit`, anchor `  globalShortcut.unregisterAll();` → `  shutdownCockpitLint();`.
- `StatusBar.tsx`: anchor `import { MachineStatus } from './MachineStatus';` → `import { LintStatus } from './lint/LintStatus';`; anchor `      <div className="status-bar-right">` → `        <LintStatus workspace={workspace} />`.

**Stubs:** `cockpitBus.ops`/`launcher`/`tabRuntime` may be null: the affected fix returns `{success:false, error:'unavailable'}` and the diagnostic stays open. The smoke test feeds synthetic `LeeEvent`s.

**Must not touch:** `api-server.ts`, `pty-manager.ts`, `App.tsx`, other packages' files.

### E. `hester-multi-ws`

**OWNS:** all of `hester/` and new files in `tests/copilot/`.
- New: `hester/daemon/workspaces/{__init__,registry,routes}.py`; `hester/daemon/cockpit/{__init__,tasks,follower,readings,history,goals,routes}.py`; `hester/daemon/tools/cockpit_tools.py`, `hester/daemon/tools/definitions/cockpit_tools.py`.
- Edits: `hester/shared/workspace.py` (§9.3); `hester/daemon/main.py` (`AppState.workspaces`; lifespan: registry, sync loop, follower start/stop; `_call_as_user` sets `request_workspace` and returns 400 on an invalid one; `POST /workspace`; include `create_cockpit_router()` and `create_workspaces_router()`; workstream router and tools via provider; `/orchestrate/telemetry` resolves the store through the registry; `_switch_workspace` stops replacing `ws_store`); `hester/daemon/workstream/routes.py` (`ws_store_provider`); `hester/daemon/tools/workstream_tools.py` (provider); `hester/daemon/copilot/routes.py` (promote `to: 'task'`); `hester/daemon/copilot/digest.py` (operation wins); `hester/daemon/copilot/metrics.py` (v3); the `hester chat` daemon client (`X-Lee-Workspace`); the tool registry (register cockpit tools).
- Tests (new): `tests/copilot/test_workspace_registry.py`, `test_request_workspace.py`, `test_workstream_per_workspace.py`, `test_cockpit_tasks.py`, `test_follower.py`, `test_readings.py`, `test_someday_promote.py`, `test_metrics_v3.py`.

**Stubs:** Lee's v2 events may not exist while E is built; tests use fixture event files. `GET /windows` unreachable → registry keeps its set.

---

## 13. Acceptance checks

**Common (A–D):** `git diff --stat` shows only owned files, the listed shared edits and the verbatim/identical-edit files. Re-running the extraction script leaves `git diff` empty for the four verbatim files. Then:

```bash
cd electron && npm run build:main && npm run typecheck && npm run build \
  && node scripts/copilot-queue-smoke.js && npm run test:copilot-renderer
```

### A `lee-tab`
```bash
cd electron && npm run build:main && node scripts/cockpit-tab-smoke.js
```
The smoke test (electron stubbed, `HOME` → temp dir) covers: ring cursor, `since`, `truncated`, `lines`, ANSI/`\r` stripping; the OSC parser with sequences split across chunks; every row of the §5.1 state table; send rules for each principal and state (agent `busy` → `busy`, `awaiting-input` → `awaiting_input`, shared → `forbidden`); `buildClaudeArgs` (prompt after `--`, `--session-id`, mode per lead, `--tools`/`--allowedTools` joined); a hook-path check-in resolved by a fake `agent.turn_end` on `copilotBus`; the relay spooling to `~/.lee/spool/tasks.jsonl` when Hester's port is closed.

Behavioural (`npm start`; `T=$(cat ~/.lee/api-token)`):
- A Lee terminal: `echo $ZDOTDIR` shows your original value (or nothing); your prompt, aliases and PATH are unchanged; `ls -la` then `echo done` → `~/.lee/events/$(date +%F).jsonl` has two `terminal.command` lines with `sig`/`argv0` and **no** command text, and no file under `~/.lee/` contains it (`grep -r 'echo done' ~/.lee` finds nothing). Repeat with `cockpit.shell_integration: false` → no `ZDOTDIR` change, no events. If you use bash, check a bash terminal too.
- `curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' localhost:9001/command -d '{"domain":"tab","action":"read_output","params":{"pty_id":<id>,"lines":20}}'` returns text and a cursor, and a `tab.read` event plus a Feed "Hester read" entry appear. The same with `"action":"send_input"` → **403**. `"action":"checkin"` → 202 `proposed: true` and a proposal in the Feed.
- Check in on a Claude tab from the Cockpit: the fixed prompt is typed into the tab, a `checkin.result` with `lee_status` is logged, and the task updates (with E). Check in while Claude shows a permission prompt → `awaiting_input`, nothing typed.
- Launch from the Launcher with Hester stopped: the tab starts at once with `--session-id` (`ps -o args=`), `~/.lee/spool/tasks.jsonl` has the record without the prompt; start Hester → spool drains within ~60 s.

### B `lee-ops`
```bash
cd electron && npm run build:main && node scripts/cockpit-ops-smoke.js
```
The smoke test covers: detectors over a fixture tree (package.json with `dev`, `build`, `postinstall`; a Makefile; pyproject with pytest and taskipy; an IDF project; a pubspec) → expected names, kinds and `confirm` flags; config merge order and validation (bad regex skipped, non-local `health` ignored); `produces` last-match parsing; a run through a fake `TabRuntime` (pass, fail, stopped, missing exit → unknown); the principal table (shared + `confirm: true` → proposal; ad-hoc → proposal; `agent` → 403); `operations.yaml` round trip keeping a hand-added field; operation-agent argv (`--model`, `--permission-mode manual`, `--tools Bash,Read,Grep,Glob`, `--allowedTools`).

Behavioural (this repo):
- Ops suggests `electron:build`, `electron:dev` (long-running), `aeronaut:analyze`/`aeronaut:test`, `dirigible/firmware:build`, `dirigible/firmware:flash` (`confirm: true`), with absolute tool paths for Flutter/IDF. Confirm two → `.lee/operations.yaml` has them; `.lee/config.yaml` is byte-identical.
- Run `electron:build` → a `▶ electron:build` tab, `operation.run`/`operation.result` with `duration_ms`; the Ops row shows passed. Break the build → a `failure` Feed entry; **Fix with agent** opens a Claude tab whose argv has the configured model and flags (verify `claude` accepts them; small cost; report the model alias that works).
- `curl … /command -d '{"domain":"ops","action":"run","params":{"workspace":"<ws>","name":"electron:build"}}'` with the shared token runs it and posts "Hester ran …"; the same for `dirigible/firmware:flash` → 202 with `proposal_id`, nothing typed until you approve in the Feed.
- Type `npm run dev` by hand in `electron/` → `electron:dev` shows running; Ctrl-C → stopped.
- A fixture operation `echo cold_start_ms=1412` with `produces` → `operation.result.readings` and (with E) a reading line in `.hester/goals/metrics.jsonl`.

### C `lee-cockpit-ui`
```bash
cd electron && node scripts/cockpit-renderer-smoke.mjs
```
Covers `mergeFeed` order (blocking, needs-you pinned, newest), `tileModel` with and without `snapshot.agents`, `stripTabs`, every row of §3.2 via `nextMode`, and `keyAction` ignoring keys while an input is focused.

Behavioural (with A–E merged, or the dev fake):
- The Cockpit covers the tab strip and main area; `stty size` in an agent terminal is identical before and after ⌘0 twice (PTY sizes untouched).
- Click into an agent terminal, press ⌘0, type `jjj r x`: nothing reaches the agent (xterm focus trap).
- ⇧⌘C in cockpit → a selected tile; Enter → workbench with that agent in the strip; other running agents are not in the strip; ⌘0 back.
- Focus start → workbench; stop → cockpit; handoff → cockpit; return after 30 min away → cockpit. `cockpit.mode` and `cockpit.go_into` lines appear in the event log.
- Approve and Reply on a tile work (v0 actions); Check in shows the exact prompt first.
- Each section renders with Hester stopped ("Hester offline" only where Hester data is needed). Someday: capture, then Promote → a queued task in Tasks; Drop removes it.
- ⌘0 no longer resets zoom; ⇧⌘0 does. `cockpit.enabled: false` → the UI is exactly today's.
- Light and dark themes; 1280 px and 800 px window widths.

### D `lee-lint`
```bash
cd electron && npm run build:main && node scripts/cockpit-lint-smoke.js
```
Covers each rule at and just below its thresholds, the ignore list, sequence de-duplication, flips with different `inputs_sig` not counting, long-wait presence gating, repeat-approval (a) and (b), a finding without a learned preview not emitted; the engine diff (new/update/resolve → `ignored` only when shown); demotion at 10 outcomes and 0.8; nudge `same_state`/`focus`/`rate`; `settings.local.json` merge (missing file, existing rules, invalid JSON refused).

Behavioural: run the same two commands by hand three times in a Lee terminal → a `toil/repeated-sequence` diagnostic, `⚠ 1`, a Feed lint entry; **Make it an operation** → a suggestion in Ops. Approve the same Bash command 10 times (hook script simulation plus flyout Approve) → `toil/repeat-approval` with the exact rule; applying it writes `.claude/settings.local.json`. During focus `⚠` is hidden. Dismiss → `lint.outcome dismissed`, not shown again until the facts change.

### E `hester-multi-ws`
```bash
~/.lee/venv/bin/python -m compileall -q hester
PYTHONPATH=$(pwd) ~/.lee/venv/bin/python -m pytest tests/copilot -q
```
Tests must cover: registry get/active/sync/evict/cap; `X-Lee-Workspace` and `?workspace=` resolution and the 400 for bad paths; `get_current_workspace()` precedence; `/workstream/` serving the request's workspace, and the active one after `POST /workspace` (bug regression); task upsert merge rules, confirm/link/close (outcome text, commits against a fixture git repo), promote; the follower over a fixture events dir (stub from `task.launch`, auto-task only after `agent.prompt`, busy/turns/status mapping, check-in, session end → review, idempotent re-run after resetting the cursor); readings appended; Someday promote `to: 'task'`; metrics v3 formulas over fixture events and task files; the existing v0/v1 tests still pass unchanged.

Behavioural: with two Lee windows on two workspaces, `curl -H "Authorization: Bearer $T" -H "X-Lee-Workspace: <A>" localhost:9000/cockpit/tasks` and the same for `<B>` return different sets while either window is focused; `GET /workspaces` lists both; the Workstream pane follows window focus; Library and `hester chat` tabs in both windows still work; `POST /workspace` responses keep their old fields. An idle daemon for 2 minutes still produces zero `model.call` lines. `hester goals metrics --since 1d` prints `attributed_agent_time` and `nudge_acceptance`.

### Merged system check (after all packages land)
Launch a delegate task from the Cockpit, let it finish a turn, Accept it: the tile, the task (busy time, summary, `review` → `done`, `accepted: true`), History and `hester goals metrics` (attributed and accepted busy time) all agree. Aeronaut and Dirigible still pair, show waiting items and stream terminals (no regressions from OSCs).

---

## 14. Open decisions (made here; revisit if wrong)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Where the lint engine runs | Lee main (TypeScript), not the Hester daemon | All toil signals are produced in Lee main; the surfaces are Lee's; deterministic code needs no daemon; keeps lint off the risky rework. Deviation from spec §13 |
| 2 | Task storage path | `.hester/cockpit/tasks/<id>.md` | `.hester/tasks/` is taken by Hester's batch Task System, whose store globs `*.md` there. Spec §12 row to be updated |
| 3 | Who writes task records | Hester only; Lee relays explicit launches (with a spool) and Hester follows the event log for everything agent-derived | One writer, no locking across processes; launching stays instant and offline; Hester catches up after downtime |
| 4 | Lee → Hester integration for agent-derived updates | Tail `~/.lee/events/` (cursor file) rather than a new push API | The log already exists on the same machine and is ordered; no new endpoint on either side; replay after crashes is free |
| 5 | Task ids | Generated by Lee at launch, `task-` + 8 hex | The agent's tab exists before Hester knows; Hester's upsert makes the relay and the `task.launch` stub idempotent |
| 6 | New statuses | `queued` and `idle` added to spec §7.2's set | A promoted Someday item or `human`-lead task hasn't started; an agent that ended a turn without a status isn't in review |
| 7 | Cockpit rendering | A fixed overlay via portal; terminals stay mounted and sized | `display:none` would resize agent PTYs to one column (`safeResize` uses the container width) |
| 8 | Keyboard safety | Focus trap while in cockpit mode | Keys typed in the Cockpit must never reach an agent underneath (C3) |
| 9 | Cockpit chord | ⌘0 (spec §9); the menu's Reset Zoom moves to ⇧⌘0 | The spec names ⌘0; zoom reset is rare |
| 10 | Mode state scope | Per window; the Cockpit *model* is per workspace (Lee main + Hester), view state (mode, section, entered agents) per window | Answers spec §16 "multiple windows on one workspace" |
| 11 | `tab` domain addressing | `pty_id` primary; `tab_id` needs `window_id` when ambiguous | Renderer tab ids are per window; PTY ids are unique |
| 12 | Hester and PTY input | No `send_input` for the shared token at all; defined operations run through `ops` (Lee types the configured command); everything else is a proposal | The spec's rules (§7.4) hold without trusting Hester to classify commands; C3 is structural |
| 13 | Check-ins from Hester | Always a Feed proposal | The check-in prompt is fixed, but typing into an agent needs a human action (C3) |
| 14 | Hook-less agent idle detection | `prompt_pattern`/`awaiting_pattern` on agent/TUI definitions; check-ins refuse `unknown` state unless forced by you | Answers spec §16; never type into an agent whose state is a guess |
| 15 | Shell integration | On by default for zsh (ZDOTDIR wrapper) and bash (`--init-file`), off switch in config, other shells untouched | Needed for command capture, exit codes and safe typing; the wrapper approach leaves user dotfiles untouched. Risk: shell startup regressions (acceptance checks it) |
| 16 | Command text storage | **None** (user decision): memory-only ring in Lee main; the event log gets only `sig`/`argv0` | The "make it an operation" fix uses the in-memory text when available and falls back to `argv0` after a restart |
| 17 | Where confirmed operations are written | `<ws>/.lee/operations.yaml`, merged under `config.yaml`'s `operations:` | js-yaml can't preserve comments; never rewrite your config |
| 18 | `services:` | Mapped read-only into operations and status rows; `detect: docker/supabase` status stays in the DevOps TUI | Reuse without duplicating detection logic in v2 |
| 19 | Operation agents | `--permission-mode manual`, `--tools Bash,Read,Grep,Glob`, `--allowedTools` narrow list, no worktree, model `claude-haiku-4-5-20251001` by default (spec value; alias to be verified live) | Can't edit files without a prompt (C3); environment fixes need the real tree; `manual` replaces the old `default` mode in `claude` 2.1.283 |
| 20 | Crashed long-running operations | Blocking Feed entry + `status:push` error, not an attention item | The attention queue is v0 code and in flight; revisit when it settles |
| 21 | Existing Hester command paths (`ui_control tui custom`, `devops_*`) | Unchanged in v2, flagged | Restricting them could break current workflows; they already require a user-triggered chat request. Revisit with C3 telemetry |
| 22 | `POST /workspace` | Keeps its name and response; now means "set active"; per-request workspace via query or `X-Lee-Workspace`; follow-active singletons unchanged | Backward compatible for every existing client; per-workspace only where v2 needs it |
| 23 | Workstream store | Per request through the registry | Fixes the router serving the boot workspace after a switch |
| 24 | Feed persistence | Lee-main Feed entries are in memory only in v2 | Attention items, tasks, runs and diagnostics persist with their owners; the Feed is a view. Spec §12's `.hester/cockpit/` feed log is deferred |
| 25 | Nudge budget home | Lee main (cockpit bus), persisted by D, exposed to Hester over loopback for the v4 steward | Lint and check-in proposals, its v2 users, are in Lee main; one budget across sources as spec §3 requires |
| 26 | What counts as a nudge | A diagnostic in `⚠ N` or the Feed; the problems flyout (pulled) doesn't | Matches "shown" in nudge_acceptance to what was pushed at you |
| 27 | Repeat-approval fix | Writes `permissions.allow` in `<ws>/.claude/settings.local.json` after showing the exact rule | The fix is a permission rule (spec §10.2); Claude Code's local settings file is the per-user place for it; hooks still never touch `.claude/` |
| 28 | Operation confirmation | Declared per operation (`confirm: true`); detection proposes it for deploy/publish/release/install/flash/dist/upload names | Answers spec §16 |
| 29 | Someday in v2 | Section with capture and deterministic triage; Promote creates a queued task; "Plan with agent" is an explicit launch | capture_pickup had no surface in Lee (user report) |
| 30 | Devices | Deferred to v6; compatibility verified | Spec phasing; no cheap surface would move a metric enough |
| 31 | Out of v2 though near | Q4 note, suggestion chip, rail "What next?", steward, message-slot lint cycling, Ask Hester on diagnostics, goal-impact wording in History | v4 (they need goals or the steward) |

**Known gaps, accepted for v2:** commands typed in shells without integration (fish, custom) aren't captured; ⌘1–9 indexes follow `centerTabs`, not the filtered strip; a check-in turn also produces an ambient v0 `review` item; operation status for `detect: docker/supabase` services isn't live; Feed entries are lost on restart; stripped output of full-screen TUIs is noisy; spend per accepted task is busy time and model name, not tokens.

---

## Appendix A: `electron/src/shared/cockpit.ts` (verbatim)

Types, v2 event names, IPC channel names, `CHECKIN_PROMPT` and the `window.lee.cockpit` interface. Imported by main, preload and renderer. Imports only stable types from `./copilot`.

<!-- FILE: electron/src/shared/cockpit.ts -->
```ts
/**
 * Copilot v2 (Cockpit) shared contract: types, event names, IPC channels and
 * the window.lee.cockpit interface. Imported by main, preload and renderer.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix A).
 * This file is copied VERBATIM from that document by every work package that
 * needs it. Do not edit it inside a work package; change the contract instead.
 *
 * Only stable v0/v1 types are imported from ./copilot.
 */

import type { AgentState, LeeStatusBlock } from './copilot';

// ---------------------------------------------------------------------------
// Event log additions (written through logCockpitEvent() in cockpit-bus.ts)
// ---------------------------------------------------------------------------

export type CockpitEventType =
  | 'tab.input'
  | 'tab.read'
  | 'terminal.command'
  | 'checkin.start'
  | 'checkin.result'
  | 'checkin.proposed'
  | 'task.launch'
  | 'operation.run'
  | 'operation.result'
  | 'operation.status'
  | 'operation.suggested'
  | 'operation.confirmed'
  | 'operation.proposal'
  | 'operation.proposal_resolved'
  | 'opagent.launch'
  | 'opagent.escalate'
  | 'cockpit.mode'
  | 'cockpit.go_into'
  | 'feed.action'
  | 'lint.open'
  | 'lint.shown'
  | 'lint.outcome'
  | 'lint.demote'
  | 'nudge.claim';

// ---------------------------------------------------------------------------
// Tabs (package A)
// ---------------------------------------------------------------------------

export type TabRunState = 'idle-at-prompt' | 'busy' | 'awaiting-input' | 'exited' | 'unknown';

/** Where a TabRunState came from, most to least trustworthy. */
export type TabStateSource = 'hooks' | 'shell-integration' | 'pattern' | 'foreground' | 'quiet' | 'none';

export type TabKind = 'agent' | 'shell' | 'tui' | 'other';

/** Spec section 7.6 fidelity tiers. */
export type TabFidelity = 'structured' | 'screen' | 'activity';

export interface TabStateInfo {
  pty_id: number;
  state: TabRunState;
  source: TabStateSource;
  /** ISO time the current state began. */
  since: string;
  /** Milliseconds since the PTY last produced output. */
  quiet_ms: number;
  /** node-pty foreground process title, when known. */
  foreground: string | null;
}

export interface TabLastCommand {
  /** First 12 hex of sha1(normalized command line). */
  sig: string;
  /** Program name only, e.g. "npm". */
  argv0: string;
  /** Full command line. Only over IPC to the local renderer; null over HTTP. */
  text: string | null;
  exit_code: number | null;
  at: string;
}

export interface TabRuntimeInfo {
  pty_id: number;
  tab_id: number | null;
  window_id: number | null;
  workspace: string | null;
  label: string;
  /** TabContext.type of the owning tab, when a tab shows this PTY. */
  tab_type: string | null;
  kind: TabKind;
  provider: string | null;
  fidelity: TabFidelity;
  state: TabStateInfo;
  shell_integration: boolean;
  /** Shell cwd from OSC 7, when shell integration is active. */
  cwd: string | null;
  last_command: TabLastCommand | null;
  /** Linked operation name (package B), if any. */
  operation: string | null;
  /** Linked task id, if Lee launched it for a task. */
  task_id: string | null;
  session_id: string | null;
  /** Last <= 5 ANSI-stripped lines. Only for fidelity 'screen'; [] otherwise. */
  tail: string[];
}

export interface TabReadRequest {
  /** Cursor from a previous read (total bytes seen). Omit for the tail. */
  since?: number;
  /** Return only the last N lines (default 200, max 2000). Ignored when `since` is set. */
  lines?: number;
  /** Cap on returned characters (default 65536, max 262144). */
  max_chars?: number;
}

export interface TabReadResult {
  pty_id: number;
  /** ANSI-stripped text. */
  text: string;
  /** Pass back as `since` to read only newer output. */
  cursor: number;
  /** True when output older than `since` was already dropped from the ring. */
  truncated: boolean;
  state: TabRunState;
}

export type TabInputPurpose = 'manual' | 'reply' | 'checkin' | 'operation' | 'op-agent';

export interface TabSendRequest {
  text: string;
  /** Append Enter. Agent PTYs get bracketed paste, then Enter after 30 ms. */
  submit?: boolean;
  purpose?: TabInputPurpose;
  /** Local user only: send even though the state is 'unknown'. Never overrides 'busy' or 'awaiting-input'. */
  force?: boolean;
}

export type TabSendError = 'not_found' | 'forbidden' | 'busy' | 'awaiting_input' | 'state_unknown' | 'invalid';

export interface TabSendResult {
  success: boolean;
  error?: TabSendError;
  state?: TabRunState;
  chars?: number;
}

// ---------------------------------------------------------------------------
// Check-ins (package A)
// ---------------------------------------------------------------------------

/** The fixed check-in prompt (spec 4.2). Typed verbatim; never varied. */
export const CHECKIN_PROMPT =
  "Reply with only a lee-status block (status, summary, blockers, files, next) describing your current work. Don't change anything.";

export type CheckinError = 'not_found' | 'not_agent' | 'busy' | 'awaiting_input' | 'state_unknown' | 'timeout' | 'forbidden' | 'in_progress';

export interface CheckinResult {
  success: boolean;
  checkin_id?: string;
  error?: CheckinError;
  /** Parsed block, or null when the reply had none (summary is still returned). */
  lee_status?: LeeStatusBlock | null;
  /** The agent's own words (<= 2000 chars). */
  summary?: string | null;
  source?: 'hook' | 'screen';
  task_id?: string | null;
  /** For a shared-token caller: a Feed proposal was created instead of typing. */
  proposed?: boolean;
}

// ---------------------------------------------------------------------------
// Tasks (records owned by Hester, package E; launched by package A)
// ---------------------------------------------------------------------------

export type TaskKind = 'bug' | 'question' | 'prototype' | 'chore' | 'unknown';
export type TaskLead = 'delegate' | 'human' | 'plan';
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'idle' | 'review' | 'done' | 'discarded';

export type TaskOriginKind = 'launcher' | 'agent' | 'checkin' | 'someday' | 'operation' | 'lint' | 'hester';

export interface TaskOrigin {
  kind: TaskOriginKind;
  ref?: string | null;
}

export interface TaskAgentRef {
  provider: string;
  pty_id: number | null;
  session_id: string | null;
  tab_label: string | null;
  model?: string | null;
}

export interface CockpitTask {
  id: string;
  workspace: string;
  title: string;
  title_source: 'user' | 'agent' | 'auto';
  kind: TaskKind;
  status: TaskStatus;
  lead: TaskLead;
  play: boolean;
  agent: TaskAgentRef | null;
  sessions: string[];
  serves: string[];
  workstream: string | null;
  /** You made or confirmed the links; only confirmed tasks count for attributed_agent_time. */
  confirmed: boolean;
  confirmed_at: string | null;
  urgency: { signal: string; ref: string | null } | null;
  /** Always null in v2 (quadrants are v4). */
  quadrant: null;
  timebox_min: number | null;
  due: string | null;
  origin: TaskOrigin | null;
  busy_ms: number;
  turns: number;
  files: string[];
  files_count: number;
  /** The agent's latest summary, verbatim (<= 2000). */
  summary: string | null;
  lee_status: LeeStatusBlock | null;
  last_checkin_at: string | null;
  commits: string[];
  outcome: string | null;
  accepted: boolean | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  version: number;
}

export type ClaudePermissionMode = 'acceptEdits' | 'plan' | 'manual' | 'auto' | 'dontAsk';

export interface LaunchRequest {
  workspace: string;
  title?: string;
  /** Initial prompt. Never written to the event log or lee.log. */
  prompt?: string;
  kind?: TaskKind;
  /** Default 'delegate'. 'human' creates a task and launches nothing. */
  lead?: TaskLead;
  play?: boolean;
  serves?: string[];
  /** Agent provider key; default cockpit.launch.provider ('claude'). */
  provider?: string;
  /** Default: cockpit.launch.worktree_for_delegate for lead 'delegate', else false. */
  worktree?: boolean;
  model?: string;
  /** Default from lead: delegate -> acceptEdits, plan -> plan. */
  permission_mode?: ClaudePermissionMode;
  /** Claude --tools (available built-in tools). */
  tools?: string[];
  /** Claude --allowedTools (no prompt for these). */
  allowed_tools?: string[];
  origin?: TaskOrigin;
  /** Tab label; default: title. */
  label?: string;
  /** Open the agent's terminal right away (workbench). Default false: a tile. */
  go_into?: boolean;
  /** Attach the launch to an existing task instead of creating one. */
  task_id?: string;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
  task_id?: string;
  pty_id?: number | null;
  tab_id?: number | null;
  session_id?: string | null;
  /** The task record reached Hester (false: spooled for retry). */
  relayed?: boolean;
}

// ---------------------------------------------------------------------------
// Feed (entries produced in Lee main; attention items and Hester tasks are
// merged in by the renderer, not stored here)
// ---------------------------------------------------------------------------

export type FeedKind = 'approval' | 'blocker' | 'decision' | 'failure' | 'metric' | 'lint' | 'proposal' | 'event' | 'prepared';
export type FeedSeverity = 'ambient' | 'needs-you' | 'blocking';
export type FeedProducer = 'tabs' | 'checkin' | 'launch' | 'ops' | 'lint' | 'hester';
export type FeedEntryState = 'open' | 'done' | 'dismissed' | 'expired';

export interface FeedAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger' | 'plain';
  /** Exact text/command the action will type or run; the UI must show it before sending (C3). */
  confirm_text?: string | null;
  /** Optional single input the UI collects and passes as payload[param]. */
  input?: { kind: 'text' | 'select'; param: string; placeholder?: string; options?: string[] } | null;
}

export interface FeedRef {
  task_id?: string;
  pty_id?: number;
  op?: string;
  run_id?: string;
  diag_id?: string;
  proposal_id?: string;
  checkin_id?: string;
}

export interface FeedEntry {
  id: string;
  version: number;
  workspace: string | null;
  kind: FeedKind;
  severity: FeedSeverity;
  producer: FeedProducer;
  title: string;
  text: string | null;
  /** True when `text` is an agent's own words (label it as such). */
  text_is_agent: boolean;
  created_at: string;
  updated_at: string;
  state: FeedEntryState;
  /** Nudge-budget key of the item this is about, if any. */
  item_ref: string | null;
  ref: FeedRef;
  /** At most three shown inline; 'dismiss' is always available and not listed. */
  actions: FeedAction[];
  pinned: boolean;
  expires_at: string | null;
}

export interface FeedSnapshot {
  workspace: string | null;
  entries: FeedEntry[];
  generated_at: string;
}

export interface FeedActionResult {
  success: boolean;
  error?: string;
  entry?: FeedEntry;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Operations (package B)
// ---------------------------------------------------------------------------

export type OperationKind = 'oneshot' | 'long-running';

export interface OperationProduces {
  metric: string;
  /** JS regex source; the first capture group must parse as a number. */
  parse: string;
  unit?: string | null;
}

export interface OperationDef {
  name: string;
  kind: OperationKind;
  command: string;
  /** Relative to the workspace (or absolute). Default: workspace root. */
  cwd?: string | null;
  /** Placeholders used as {name} in command. */
  params?: string[];
  /** Outward-facing: always ask before running. */
  confirm?: boolean;
  produces?: OperationProduces[];
  /** Copilot mode (v5) may run it; recorded only in v2. */
  idle_ok?: boolean;
  /** Extra --allowedTools rules for this operation's agent. */
  allowed_tools?: string[];
  env?: Record<string, string>;
  ports?: number[];
  /** http://127.0.0.1 or http://localhost URL only (C1). */
  health?: string | null;
  notify_on_done?: boolean;
  /** Extra command-line globs that link a hand-typed command to this operation. */
  match?: string[];
  description?: string | null;
  timeout_min?: number | null;
}

export type OperationSource = 'config' | 'operations-file' | 'service';
export type OperationStatus = 'idle' | 'running' | 'passed' | 'failed' | 'stopped' | 'unknown' | 'unhealthy' | 'crashed';
export type RunBy = 'user' | 'hester' | 'device' | 'lee';

export interface OperationReading {
  metric: string;
  value: number;
  unit: string | null;
}

export interface OperationRun {
  run_id: string;
  op: string;
  workspace: string;
  pty_id: number | null;
  tab_id: number | null;
  by: RunBy;
  started_at: string;
  ended_at: string | null;
  status: 'running' | 'passed' | 'failed' | 'stopped' | 'unknown';
  exit_code: number | null;
  duration_ms: number | null;
  readings: OperationReading[];
  inputs_sig: string | null;
}

export interface OperationInfo {
  def: OperationDef;
  source: OperationSource;
  status: OperationStatus;
  last_run: OperationRun | null;
  running: OperationRun | null;
  linked_pty_id: number | null;
  service: { name: string; detect: string | null } | null;
}

export interface OperationSuggestion {
  def: OperationDef;
  /** e.g. "package.json", "electron/package.json", "Makefile", "pyproject.toml", "dirigible/firmware (idf.py)", "aeronaut/pubspec.yaml". */
  detected_from: string;
}

export interface OperationProposal {
  id: string;
  workspace: string;
  /** Defined operation name, or null for an ad-hoc command. */
  op: string | null;
  command: string;
  cwd: string | null;
  by: 'hester' | 'lint';
  reason: string | null;
  created_at: string;
  expires_at: string;
}

export interface OperationAgentConfig {
  model: string;
  plan_model: string;
  escalate_model: string;
}

export interface OperationsSnapshot {
  workspace: string;
  operations: OperationInfo[];
  suggestions: OperationSuggestion[];
  proposals: OperationProposal[];
  agent: OperationAgentConfig;
  generated_at: string;
}

export interface OpRunRequest {
  workspace: string;
  /** Defined operation. Exactly one of name / command. */
  name?: string;
  /** Ad-hoc command (local user only; others get a proposal). */
  command?: string;
  cwd?: string | null;
  params?: Record<string, string>;
  /** The caller showed the exact command and the user confirmed it. */
  confirmed?: boolean;
  /** Run in this tab (must be a shell at its prompt). */
  pty_id?: number;
}

export interface OpRunResult {
  success: boolean;
  error?: string;
  run?: OperationRun;
  proposal_id?: string;
  needs_confirm?: boolean;
  missing_params?: string[];
}

export interface OpAgentRequest {
  workspace: string;
  purpose: 'fix' | 'adhoc';
  /** For 'fix': the failed operation (and run). */
  op?: string;
  run_id?: string;
  /** For 'adhoc': what to do, as typed by the user. */
  request?: string;
  /** Use plan_model instead of model. */
  multi_step?: boolean;
}

// ---------------------------------------------------------------------------
// Lint (package D)
// ---------------------------------------------------------------------------

export type LintSeverity = 'off' | 'info' | 'warn' | 'needs-you';
export type LintOutcome = 'fixed' | 'dismissed' | 'ignored' | 'suppressed';
export type LintSuppressScope = 'item' | 'branch' | 'workspace';

export interface LintFix {
  id: string;
  label: string;
  /** Exact change the fix makes (a permission rule, a command); shown before applying. */
  confirm_text?: string | null;
}

export interface LintDiagnostic {
  id: string;
  rule: string;
  family: 'toil';
  /** Effective severity after demotion. */
  severity: LintSeverity;
  base_severity: LintSeverity;
  workspace: string | null;
  /** Stable key of what it's about within the rule (a command sig, an op name, a tool signature). */
  subject: string;
  message: string;
  evidence: string[];
  fixes: LintFix[];
  item_ref: string | null;
  created_at: string;
  updated_at: string;
  shown: boolean;
  demoted: boolean;
}

export interface LintRuleStatus {
  rule: string;
  severity: LintSeverity;
  base_severity: LintSeverity;
  demoted: boolean;
  flagged_for_rework: boolean;
  outcomes_30d: Record<LintOutcome, number>;
}

export interface LintSnapshot {
  workspace: string | null;
  diagnostics: LintDiagnostic[];
  counts: { info: number; warn: number; needs_you: number };
  rules: LintRuleStatus[];
  generated_at: string;
}

export interface LintFixResult {
  success: boolean;
  error?: string;
  /** What the fix did, for a toast. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Nudge budget (spec 3 rule 2; shared by lint, check-in proposals, ops, v4 steward)
// ---------------------------------------------------------------------------

export type NudgeSource = 'lint' | 'checkin' | 'ops' | 'steward';

export interface NudgeClaimRequest {
  /** e.g. "task:<ws>:<id>", "pty:<id>", "op:<ws>:<name>", "lint:<ws>:<rule>:<subject>". */
  item_ref: string;
  /** Changes whenever the item's state changes; one nudge per value. */
  state_key: string;
  source: NudgeSource;
  workspace?: string | null;
  /** Blocking items may nudge during focus. Nothing in v2 sets it. */
  blocking?: boolean;
}

export interface NudgeClaim {
  granted: boolean;
  reason: 'same_state' | 'overridden' | 'rate' | 'focus' | null;
}

// ---------------------------------------------------------------------------
// Cockpit / Workbench modes (renderer, package C)
// ---------------------------------------------------------------------------

export type LeeMode = 'cockpit' | 'workbench';
export type ModeReason = 'default' | 'manual' | 'focus_start' | 'focus_end' | 'handoff' | 'return' | 'go_into' | 'open_tab';
export type GoIntoFrom = 'tile' | 'feed' | 'drawer' | 'hotkey' | 'tabs' | 'other-window';

export type CockpitRendererEvent =
  | { type: 'cockpit.mode'; data: { from: LeeMode; to: LeeMode; reason: ModeReason } }
  | { type: 'cockpit.go_into'; data: { pty_id: number; agent_state: AgentState | TabRunState; from: GoIntoFrom } };

/** Main asks a window's renderer to create a tab and report its ids. */
export interface CreateTabRequest {
  request_id: string;
  type: 'terminal' | 'agent';
  label: string;
  /** For type 'terminal': command and args (else the login shell). */
  command?: string;
  args?: string[];
  /** For type 'agent': provider key. */
  provider?: string;
  /** Make it the active tab (workbench) instead of leaving it as a tile. */
  activate: boolean;
}

export interface CreateTabResult {
  request_id: string;
  tab_id: number | null;
  pty_id: number | null;
  error?: string;
}

/** Main asks the window that shows pty_id to open it (and leave cockpit mode). */
export interface GoIntoRequest {
  pty_id: number;
  tab_id: number | null;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const COCKPIT_IPC = {
  // Package A (lee-tab)
  tabsList: 'cockpit:tabs:list',
  /** main to renderer: TabRuntimeInfo[] (debounced 500 ms). */
  tabsPush: 'cockpit:tabs',
  tabRead: 'cockpit:tabs:read',
  tabState: 'cockpit:tabs:state',
  tabSend: 'cockpit:tabs:send',
  tabFocus: 'cockpit:tabs:focus',
  checkin: 'cockpit:checkin',
  launch: 'cockpit:launch',
  feedGet: 'cockpit:feed:get',
  /** main to renderer: FeedSnapshot for all workspaces (renderer filters). */
  feedPush: 'cockpit:feed',
  feedAct: 'cockpit:feed:act',
  /** send, renderer to main: CockpitRendererEvent. */
  rendererEvent: 'cockpit:event',
  /** main to renderer: CreateTabRequest. */
  createTab: 'cockpit:create-tab',
  /** send, renderer to main: CreateTabResult. */
  createTabResult: 'cockpit:create-tab-result',
  /** main to renderer: GoIntoRequest. */
  goInto: 'cockpit:go-into',
  // Package B (lee-ops)
  opsList: 'cockpit:ops:list',
  /** main to renderer: OperationsSnapshot (one workspace per message). */
  opsPush: 'cockpit:ops',
  opsRun: 'cockpit:ops:run',
  opsStop: 'cockpit:ops:stop',
  opsConfirm: 'cockpit:ops:confirm',
  opsDismissSuggestion: 'cockpit:ops:dismiss-suggestion',
  opsSave: 'cockpit:ops:save',
  opsLinkTab: 'cockpit:ops:link-tab',
  opsAgent: 'cockpit:ops:agent',
  opsSerialPorts: 'cockpit:ops:serial-ports',
  // Package D (lee-lint)
  lintList: 'cockpit:lint:list',
  /** main to renderer: LintSnapshot (one workspace per message; null workspace = machine-wide). */
  lintPush: 'cockpit:lint',
  lintFix: 'cockpit:lint:fix',
  lintDismiss: 'cockpit:lint:dismiss',
  lintSuppress: 'cockpit:lint:suppress',
  lintShown: 'cockpit:lint:shown',
  /** send, renderer to main: { signature, tool, preview } seen on an approval item. Memory only. */
  lintLearnTool: 'cockpit:lint:learn-tool',
} as const;

export type CockpitUnsubscribe = () => void;

/** window.lee.cockpit */
export interface CockpitAPI {
  // Package A (lee-tab)
  tabs: {
    list: (workspace?: string | null) => Promise<TabRuntimeInfo[]>;
    onChange: (cb: (tabs: TabRuntimeInfo[]) => void) => CockpitUnsubscribe;
    read: (ptyId: number, req: TabReadRequest) => Promise<TabReadResult>;
    state: (ptyId: number) => Promise<TabStateInfo>;
    send: (ptyId: number, req: TabSendRequest) => Promise<TabSendResult>;
    /** Focus the window showing ptyId and open that tab there. */
    focus: (ptyId: number) => Promise<{ success: boolean; error?: string }>;
  };
  checkin: (ptyId: number, opts?: { force?: boolean }) => Promise<CheckinResult>;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  feed: {
    get: (workspace?: string | null) => Promise<FeedSnapshot>;
    onChange: (cb: (snapshot: FeedSnapshot) => void) => CockpitUnsubscribe;
    /** actionId 'dismiss' is always accepted. */
    act: (entryId: string, actionId: string, payload?: Record<string, string>) => Promise<FeedActionResult>;
  };
  logEvent: (event: CockpitRendererEvent) => void;
  onCreateTab: (cb: (req: CreateTabRequest) => void) => CockpitUnsubscribe;
  createTabResult: (res: CreateTabResult) => void;
  onGoInto: (cb: (req: GoIntoRequest) => void) => CockpitUnsubscribe;
  // Package B (lee-ops)
  ops: {
    list: (workspace: string) => Promise<OperationsSnapshot>;
    onChange: (cb: (snapshot: OperationsSnapshot) => void) => CockpitUnsubscribe;
    run: (req: OpRunRequest) => Promise<OpRunResult>;
    stop: (workspace: string, name: string) => Promise<{ success: boolean; error?: string }>;
    confirm: (workspace: string, names: string[]) => Promise<{ success: boolean; error?: string }>;
    dismissSuggestion: (workspace: string, name: string) => Promise<{ success: boolean }>;
    save: (workspace: string, def: OperationDef) => Promise<{ success: boolean; error?: string }>;
    linkTab: (ptyId: number, workspace: string, name: string | null) => Promise<{ success: boolean; error?: string }>;
    startAgent: (req: OpAgentRequest) => Promise<LaunchResult>;
    serialPorts: () => Promise<string[]>;
  };
  // Package D (lee-lint)
  lint: {
    list: (workspace?: string | null) => Promise<LintSnapshot>;
    onChange: (cb: (snapshot: LintSnapshot) => void) => CockpitUnsubscribe;
    fix: (diagId: string, fixId: string) => Promise<LintFixResult>;
    dismiss: (diagId: string) => Promise<{ success: boolean }>;
    suppress: (diagId: string, scope: LintSuppressScope) => Promise<{ success: boolean }>;
    /** The renderer displayed these diagnostics (outside focus). */
    shown: (diagIds: string[], surface: 'status' | 'feed') => void;
    learnTool: (info: { signature: string; tool: string; preview: string }) => void;
  };
}
```

## Appendix B: `electron/src/main/cockpit/cockpit-bus.ts` (verbatim)

The in-process seam between A, B and D: `logCockpitEvent`, the Feed store, the nudge budget, provider slots (`TabRuntime`, `TaskLauncher`, `OpsProvider`), the `/command` domain registry, the Express hook, terminal signals and Feed action routing (with the C3 guard). *Pure* (no `electron`).

<!-- FILE: electron/src/main/cockpit/cockpit-bus.ts -->
```ts
/**
 * Cockpit bus: the in-process seam between the v2 Lee main packages
 * A (lee-tab), B (lee-ops) and D (lee-lint). No package imports another's
 * modules; all of them import this file.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix B).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * - A registers the tab runtime, the task launcher, the command history and
 *   the '/command' domain 'tab'; A's api-server.ts edit calls setExpressApp()
 *   and getCommandDomain().
 * - B registers the ops provider and the '/command' domain 'ops'.
 * - D persists the nudge budget and registers its HTTP routes.
 * - Everyone posts Feed entries and registers a Feed action handler for their
 *   producer name.
 *
 * Electron-free on purpose (smoke-testable with plain node).
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { Application } from 'express';
import type { LeeEvent, LeeEventInput, LeeEventType, Principal } from '../../shared/copilot';
import { copilotBus, logEvent } from '../copilot/bus';
import type {
  CockpitEventType,
  FeedAction,
  FeedActionResult,
  FeedEntry,
  FeedEntryState,
  FeedKind,
  FeedProducer,
  FeedRef,
  FeedSeverity,
  FeedSnapshot,
  LaunchRequest,
  LaunchResult,
  NudgeClaim,
  NudgeClaimRequest,
  OperationDef,
  OperationsSnapshot,
  TabReadRequest,
  TabReadResult,
  TabRuntimeInfo,
  TabSendRequest,
  TabSendResult,
  TabStateInfo,
  TaskOrigin,
} from '../../shared/cockpit';

// ---------------------------------------------------------------------------
// Event log helper
// ---------------------------------------------------------------------------

/** Log a v2 event type through the v0 bus (same envelope, same sink). */
export function logCockpitEvent<T = Record<string, unknown>>(
  type: CockpitEventType,
  input: Omit<LeeEventInput<T>, 'type'>,
): LeeEvent<T> {
  return logEvent<T>({ ...input, type: type as unknown as LeeEventType });
}

function isoNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Feed store
// ---------------------------------------------------------------------------

export interface FeedPostInput {
  workspace: string | null;
  kind: FeedKind;
  severity: FeedSeverity;
  producer: FeedProducer;
  title: string;
  text?: string | null;
  text_is_agent?: boolean;
  item_ref?: string | null;
  ref?: FeedRef;
  actions?: FeedAction[];
  pinned?: boolean;
  /** Milliseconds until the entry expires (default: never). */
  ttl_ms?: number | null;
  /** An open entry with the same key is updated instead of duplicated. */
  dedupe_key?: string | null;
}

const SEVERITY_ORDER: Record<FeedSeverity, number> = { blocking: 0, 'needs-you': 1, ambient: 2 };
const MAX_ENTRIES = 500;

export class FeedStore extends EventEmitter {
  private entries = new Map<string, FeedEntry>();
  private dedupe = new Map<string, string>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    super();
    this.now = opts.now ?? Date.now;
  }

  post(input: FeedPostInput): FeedEntry {
    const now = this.now();
    const key = input.dedupe_key ?? null;
    const existingId = key ? this.dedupe.get(key) : undefined;
    const existing = existingId ? this.entries.get(existingId) : undefined;
    if (existing && existing.state === 'open') {
      const updated: FeedEntry = {
        ...existing,
        version: existing.version + 1,
        severity: input.severity,
        title: input.title,
        text: input.text ?? null,
        text_is_agent: input.text_is_agent ?? false,
        ref: input.ref ?? existing.ref,
        actions: input.actions ?? existing.actions,
        pinned: input.pinned ?? existing.pinned,
        updated_at: isoNow(now),
        expires_at: input.ttl_ms != null ? isoNow(now + input.ttl_ms) : existing.expires_at,
      };
      this.entries.set(updated.id, updated);
      this.emit('change', updated);
      return updated;
    }
    const entry: FeedEntry = {
      id: newId('feed'),
      version: 1,
      workspace: input.workspace,
      kind: input.kind,
      severity: input.severity,
      producer: input.producer,
      title: input.title,
      text: input.text ?? null,
      text_is_agent: input.text_is_agent ?? false,
      created_at: isoNow(now),
      updated_at: isoNow(now),
      state: 'open',
      item_ref: input.item_ref ?? null,
      ref: input.ref ?? {},
      actions: input.actions ?? [],
      pinned: input.pinned ?? false,
      expires_at: input.ttl_ms != null ? isoNow(now + input.ttl_ms) : null,
    };
    this.entries.set(entry.id, entry);
    if (key) this.dedupe.set(key, entry.id);
    this.trim();
    this.emit('change', entry);
    return entry;
  }

  get(id: string): FeedEntry | null {
    this.sweep();
    return this.entries.get(id) ?? null;
  }

  /** Close an entry. Returns the updated entry, or null if unknown. */
  setState(id: string, state: FeedEntryState): FeedEntry | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.state === state) return e;
    const updated: FeedEntry = { ...e, state, version: e.version + 1, updated_at: isoNow(this.now()) };
    this.entries.set(id, updated);
    this.emit('change', updated);
    return updated;
  }

  /** Close every open entry with this dedupe key (e.g. a proposal that was answered elsewhere). */
  closeByKey(key: string, state: FeedEntryState = 'done'): void {
    const id = this.dedupe.get(key);
    if (id) this.setState(id, state);
  }

  /**
   * Entries for one workspace plus machine-wide (workspace null) ones. Pass
   * undefined for all. Order: open before closed; pinned; severity; newest.
   */
  list(workspace?: string | null, opts: { includeClosed?: boolean; limit?: number } = {}): FeedEntry[] {
    this.sweep();
    const out: FeedEntry[] = [];
    for (const e of this.entries.values()) {
      if (workspace !== undefined && e.workspace !== null && e.workspace !== workspace) continue;
      if (!opts.includeClosed && e.state !== 'open') continue;
      out.push(e);
    }
    out.sort((a, b) => {
      const ao = a.state === 'open' ? 0 : 1;
      const bo = b.state === 'open' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (s !== 0) return s;
      return b.created_at.localeCompare(a.created_at);
    });
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  snapshot(workspace?: string | null): FeedSnapshot {
    return {
      workspace: workspace ?? null,
      entries: this.list(workspace, { includeClosed: true, limit: 200 }),
      generated_at: isoNow(this.now()),
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.state === 'open' && e.expires_at && Date.parse(e.expires_at) <= now) {
        this.setState(e.id, 'expired');
      }
    }
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const closed = [...this.entries.values()]
      .filter((e) => e.state !== 'open')
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    for (const e of closed) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(e.id);
    }
  }
}

export type FeedActionHandler = (
  entry: FeedEntry,
  actionId: string,
  payload: Record<string, string>,
  by: Principal,
) => Promise<FeedActionResult>;

// ---------------------------------------------------------------------------
// Nudge budget
// ---------------------------------------------------------------------------

export interface NudgeRecord {
  item_ref: string;
  state_key: string;
  granted_at: number;
  overridden: boolean;
}

export class NudgeBudget extends EventEmitter {
  private records = new Map<string, NudgeRecord>();
  private grants: number[] = [];
  private readonly now: () => number;
  perHour: number;

  constructor(opts: { perHour?: number; now?: () => number } = {}) {
    super();
    this.perHour = opts.perHour ?? 6;
    this.now = opts.now ?? Date.now;
  }

  /** At most one nudge per item per state, none during focus unless blocking, and a machine-wide hourly cap. */
  claim(req: NudgeClaimRequest, focusActive: boolean): NudgeClaim {
    const now = this.now();
    const rec = this.records.get(req.item_ref);
    if (rec && rec.state_key === req.state_key) {
      return { granted: false, reason: rec.overridden ? 'overridden' : 'same_state' };
    }
    if (focusActive && !req.blocking) return { granted: false, reason: 'focus' };
    this.grants = this.grants.filter((t) => now - t < 3_600_000);
    if (this.grants.length >= this.perHour && !req.blocking) return { granted: false, reason: 'rate' };
    this.grants.push(now);
    const next: NudgeRecord = { item_ref: req.item_ref, state_key: req.state_key, granted_at: now, overridden: false };
    this.records.set(req.item_ref, next);
    this.emit('change');
    return { granted: true, reason: null };
  }

  /** The user dismissed or overrode a nudge: stay quiet on the item until its state changes. */
  override(itemRef: string, stateKey: string): void {
    this.records.set(itemRef, { item_ref: itemRef, state_key: stateKey, granted_at: this.now(), overridden: true });
    this.emit('change');
  }

  export(): NudgeRecord[] {
    return [...this.records.values()];
  }

  load(records: NudgeRecord[]): void {
    for (const r of records) {
      if (r && typeof r.item_ref === 'string' && typeof r.state_key === 'string') this.records.set(r.item_ref, r);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider interfaces (implemented by one package, used by others)
// ---------------------------------------------------------------------------

/** Package A. */
export interface TabRuntime {
  list(workspace?: string | null): TabRuntimeInfo[];
  get(ptyId: number): TabRuntimeInfo | null;
  state(ptyId: number): TabStateInfo;
  read(ptyId: number, req: TabReadRequest): TabReadResult;
  /** Total bytes seen so far on this PTY (a read cursor for "from now on"). */
  cursor(ptyId: number): number;
  /** Enforces the C3 rules of the contract's section 5.3. */
  send(ptyId: number, req: TabSendRequest, by: Principal): Promise<TabSendResult>;
  /** Ask a window (default: the focused window of `workspace`) to open a tab. */
  openTab(opts: {
    workspace: string;
    window_id?: number | null;
    type: 'terminal' | 'agent';
    label: string;
    command?: string;
    args?: string[];
    provider?: string;
    activate?: boolean;
  }): Promise<{ pty_id: number | null; tab_id: number | null; error?: string }>;
  /** Full text of a recent hand-typed command, by signature (in-memory only; null after a restart). */
  commandText(workspace: string, sig: string): string | null;
}

export interface TaskCreateInput {
  workspace: string;
  title: string;
  kind?: LaunchRequest['kind'];
  lead?: LaunchRequest['lead'];
  status?: 'queued' | 'review';
  origin?: TaskOrigin;
  note?: string | null;
  confirmed?: boolean;
}

/** Package A. */
export interface TaskLauncher {
  launch(req: LaunchRequest, by: Principal, windowId?: number | null): Promise<LaunchResult>;
  /** A task with no agent (queued), relayed to Hester with spool-on-failure. */
  createTask(input: TaskCreateInput): Promise<{ task_id: string; relayed: boolean }>;
}

/** Package B. */
export interface OpsProvider {
  snapshot(workspace: string): OperationsSnapshot;
  /** Add an unconfirmed suggestion (e.g. from the toil/repeated-sequence fix). */
  suggest(workspace: string, def: OperationDef, detectedFrom: string): void;
  /** Set a boolean flag on a defined operation in .lee/operations.yaml. */
  setFlag(workspace: string, name: string, flag: 'notify_on_done' | 'confirm', value: boolean): Promise<boolean>;
}

/**
 * In-process only, never logged: a command started or ended in a shell that
 * has Lee's shell integration (package A emits; B links runs, D may listen).
 */
export interface TerminalCommandSignal {
  pty_id: number;
  workspace: string | null;
  phase: 'start' | 'end';
  /** First 12 hex of sha1(normalized command line). */
  sig: string;
  argv0: string;
  /** Full command line. Never write it to the event log. */
  text: string;
  cwd: string | null;
  /** 'lee' when Lee typed it (an operation run), else 'user'. */
  by: 'user' | 'lee';
  exit_code: number | null;
  started_at: string;
  duration_ms: number | null;
}

export interface CommandDomainResult {
  status: number;
  body: unknown;
}

export type CommandDomainHandler = (
  action: string,
  params: Record<string, unknown>,
  principal: Principal | undefined,
) => Promise<CommandDomainResult>;

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

class CockpitBus extends EventEmitter {
  readonly feed = new FeedStore();
  readonly nudges = new NudgeBudget();
  private app: Application | null = null;
  private appWaiters: Array<(app: Application) => void> = [];
  private domains = new Map<string, CommandDomainHandler>();
  private feedHandlers = new Map<FeedProducer, FeedActionHandler>();
  private focusActive = false;
  tabRuntime: TabRuntime | null = null;
  launcher: TaskLauncher | null = null;
  ops: OpsProvider | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
    copilotBus.on('event', (e: LeeEvent) => {
      if (e.type === 'focus.start') this.focusActive = true;
      else if (e.type === 'focus.end') this.focusActive = false;
    });
  }

  /** api-server.ts (package A's edit) hands over the Express app once routes are set up. */
  setExpressApp(app: Application): void {
    this.app = app;
    const waiting = this.appWaiters;
    this.appWaiters = [];
    for (const fn of waiting) {
      try {
        fn(app);
      } catch (err) {
        console.error('[cockpit] route registration failed:', err);
      }
    }
  }

  /** Register HTTP routes now, or as soon as the app exists. Routes sit behind the auth middleware. */
  withExpressApp(fn: (app: Application) => void): void {
    if (this.app) {
      try {
        fn(this.app);
      } catch (err) {
        console.error('[cockpit] route registration failed:', err);
      }
    } else {
      this.appWaiters.push(fn);
    }
  }

  registerCommandDomain(domain: string, handler: CommandDomainHandler): void {
    this.domains.set(domain, handler);
  }

  getCommandDomain(domain: string): CommandDomainHandler | undefined {
    return this.domains.get(domain);
  }

  setTabRuntime(rt: TabRuntime | null): void {
    this.tabRuntime = rt;
  }

  setLauncher(l: TaskLauncher | null): void {
    this.launcher = l;
  }

  setOps(p: OpsProvider | null): void {
    this.ops = p;
  }

  emitTerminal(signal: TerminalCommandSignal): void {
    try {
      this.emit('terminal', signal);
    } catch (err) {
      console.error('[cockpit] terminal listener failed:', err);
    }
  }

  onTerminal(fn: (signal: TerminalCommandSignal) => void): () => void {
    this.on('terminal', fn);
    return () => {
      this.off('terminal', fn);
    };
  }

  isFocusActive(): boolean {
    return this.focusActive;
  }

  claimNudge(req: NudgeClaimRequest): NudgeClaim {
    const res = this.nudges.claim(req, this.focusActive);
    logCockpitEvent('nudge.claim', {
      workspace: req.workspace ?? null,
      data: { item_ref: req.item_ref, source: req.source, granted: res.granted, reason: res.reason },
    });
    return res;
  }

  registerFeedActionHandler(producer: FeedProducer, handler: FeedActionHandler): void {
    this.feedHandlers.set(producer, handler);
  }

  /** Run a Feed action. 'dismiss' is built in: closes the entry and quiets its item until it changes. */
  async actOnFeed(entryId: string, actionId: string, payload: Record<string, string>, by: Principal): Promise<FeedActionResult> {
    // Feed actions approve proposals and type into tabs: humans only (C3).
    if (by.kind === 'shared') return { success: false, error: 'forbidden' };
    const entry = this.feed.get(entryId);
    if (!entry) return { success: false, error: 'not_found' };
    if (entry.state !== 'open') return { success: false, error: 'closed', entry };
    if (actionId === 'dismiss') {
      const updated = this.feed.setState(entryId, 'dismissed') ?? undefined;
      if (entry.item_ref) this.nudges.override(entry.item_ref, `dismissed:${entry.version}`);
      logEvent({
        type: 'ui.ceremony',
        workspace: entry.workspace,
        actor: by.kind === 'device'
          ? { kind: 'user', surface: 'device', device_id: by.device_id, device_kind: by.device_kind }
          : { kind: 'user', surface: 'lee' },
        data: { action: 'dismiss', target: `feed:${entry.kind}` },
      });
      return { success: true, entry: updated };
    }
    if (!entry.actions.some((a) => a.id === actionId)) return { success: false, error: 'unknown_action', entry };
    const handler = this.feedHandlers.get(entry.producer);
    if (!handler) return { success: false, error: 'producer_unavailable', entry };
    logCockpitEvent('feed.action', {
      workspace: entry.workspace,
      data: { entry_kind: entry.kind, producer: entry.producer, action: actionId, principal: by.kind },
    });
    try {
      return await handler(entry, actionId, payload, by);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), entry };
    }
  }
}

export const cockpitBus = new CockpitBus();
```

## Appendix C: `electron/src/main/cockpit/cockpit-config.ts` (verbatim)

Reads `cockpit:`, `operation_agent:` and `lint:` from the global and workspace config files. *Pure*.

<!-- FILE: electron/src/main/cockpit/cockpit-config.ts -->
```ts
/**
 * Cockpit (v2) settings: the `cockpit:`, `operation_agent:` and `lint:` blocks
 * of ~/.config/lee/config.yaml, ~/.lee/config.yaml and <workspace>/.lee/config.yaml
 * (later wins), deep-merged over the defaults below. Unknown keys are ignored,
 * except under `lint:`, whose keys are rule ids.
 *
 * Operations (`operations:`, `services:`) are NOT read here; package B owns them.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix C).
 * Copied VERBATIM. Do not edit inside a work package.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { LintSeverity } from '../../shared/cockpit';

export interface LintRuleConfig {
  severity: LintSeverity;
  /** Rule-specific numeric/string/list parameters (min_repeats, window_days, ...). */
  [param: string]: unknown;
}

export interface CockpitConfig {
  cockpit: {
    enabled: boolean;
    default_mode: 'cockpit' | 'workbench';
    tab: {
      output_buffer_kb: number;
      quiet_ms: number;
    };
    checkin: {
      timeout_s: number;
      wait_idle_s: number;
      propose_after_min: number;
    };
    shell_integration: boolean;
    launch: {
      provider: string;
      worktree_for_delegate: boolean;
    };
    nudges: {
      max_per_hour: number;
    };
    detect: {
      enabled: boolean;
      /** Extra directories to look for tools not on PATH (flutter, idf.py). */
      tool_paths: string[];
    };
  };
  operation_agent: {
    model: string;
    plan_model: string;
    escalate_model: string;
  };
  /** Parsed from the flat `lint:` block: every key but `demotion` is a rule id. */
  lint: {
    rules: Record<string, LintRuleConfig>;
    demotion: { min_outcomes: number; dismiss_ratio: number; window_days: number };
  };
}

export const COCKPIT_DEFAULTS: CockpitConfig = {
  cockpit: {
    enabled: true,
    default_mode: 'cockpit',
    tab: { output_buffer_kb: 256, quiet_ms: 1500 },
    checkin: { timeout_s: 180, wait_idle_s: 120, propose_after_min: 20 },
    shell_integration: true,
    launch: { provider: 'claude', worktree_for_delegate: true },
    nudges: { max_per_hour: 6 },
    detect: { enabled: true, tool_paths: [] },
  },
  operation_agent: {
    model: 'claude-haiku-4-5-20251001',
    plan_model: 'sonnet',
    escalate_model: 'sonnet',
  },
  lint: {
    rules: {
      'toil/repeated-sequence': { severity: 'warn', min_repeats: 3, window_days: 7, max_len: 3, min_chars: 8, ignore_commands: [] },
      'toil/flaky-operation': { severity: 'warn', window_runs: 10, min_flips: 2 },
      'toil/long-wait': { severity: 'info', min_minutes: 3, min_occurrences: 3, window_days: 7 },
      'toil/repeat-approval': { severity: 'warn', min_repeats: 10, window_days: 7, fast_ms: 2000, fast_streak: 10 },
    },
    demotion: { min_outcomes: 10, dismiss_ratio: 0.8, window_days: 30 },
  },
};

const SEVERITIES: LintSeverity[] = ['off', 'info', 'warn', 'needs-you'];
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: CockpitConfig }>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (isPlainObject(cur)) out[k] = merge(cur, v);
    else if (Array.isArray(cur)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (v === null || typeof v === typeof cur || cur === null) out[k] = v;
  }
  return out as T;
}

/** `lint:` accepts `rule: warn` or `rule: { severity: warn, param: value }`, plus `demotion: {...}`. */
function mergeLint(base: CockpitConfig['lint'], overlay: unknown): CockpitConfig['lint'] {
  if (!isPlainObject(overlay)) return base;
  const rules: Record<string, LintRuleConfig> = { ...base.rules };
  let demotion = base.demotion;
  for (const [rule, v] of Object.entries(overlay)) {
    if (rule === 'demotion') {
      demotion = merge(demotion, v);
      continue;
    }
    const cur: LintRuleConfig = rules[rule] ?? { severity: 'warn' };
    if (typeof v === 'string' && (SEVERITIES as string[]).includes(v)) {
      rules[rule] = { ...cur, severity: v as LintSeverity };
    } else if (isPlainObject(v)) {
      const sev = typeof v.severity === 'string' && (SEVERITIES as string[]).includes(v.severity) ? (v.severity as LintSeverity) : cur.severity;
      rules[rule] = { ...cur, ...v, severity: sev };
    }
    // Other shapes (e.g. `scope/areas: [...]`, v4) are ignored in v2.
  }
  return { rules, demotion };
}

function readDoc(file: string): Record<string, unknown> | undefined {
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    return isPlainObject(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

function configFiles(workspace: string | null | undefined): string[] {
  const home = os.homedir();
  const files = [path.join(home, '.config', 'lee', 'config.yaml'), path.join(home, '.lee', 'config.yaml')];
  if (workspace) files.push(path.join(workspace, '.lee', 'config.yaml'));
  return files;
}

/** Effective cockpit config for a workspace (null = machine-wide only). Cached 10 s. */
export function getCockpitConfig(workspace?: string | null): CockpitConfig {
  const key = workspace || '';
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let value: CockpitConfig = COCKPIT_DEFAULTS;
  for (const file of configFiles(workspace)) {
    const doc = readDoc(file);
    if (!doc) continue;
    value = {
      cockpit: merge(value.cockpit, doc.cockpit),
      operation_agent: merge(value.operation_agent, doc.operation_agent),
      lint: mergeLint(value.lint, doc.lint),
    };
  }
  cache.set(key, { at: now, value });
  return value;
}

/** Rule config with its severity; unknown rules get { severity: 'off' }. */
export function lintRuleConfig(rule: string, workspace?: string | null): LintRuleConfig {
  return getCockpitConfig(workspace).lint.rules[rule] ?? { severity: 'off' };
}

export function invalidateCockpitConfig(): void {
  cache.clear();
}
```

## Appendix D: `electron/src/main/preload-cockpit.ts` (verbatim)

The renderer half of the IPC contract, exposed as `window.lee.cockpit`.

<!-- FILE: electron/src/main/preload-cockpit.ts -->
```ts
/**
 * window.lee.cockpit: the renderer half of the Cockpit (v2) IPC contract.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix D).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * Compiled by tsconfig.main.json (no DOM lib).
 */

import { ipcRenderer } from 'electron';
import { COCKPIT_IPC } from '../shared/cockpit';
import type {
  CockpitAPI,
  CreateTabRequest,
  FeedSnapshot,
  GoIntoRequest,
  LintSnapshot,
  OperationsSnapshot,
  TabRuntimeInfo,
} from '../shared/cockpit';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export const cockpitApi: CockpitAPI = {
  tabs: {
    list: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.tabsList, workspace ?? null),
    onChange: (cb) => subscribe<TabRuntimeInfo[]>(COCKPIT_IPC.tabsPush, cb),
    read: (ptyId, req) => ipcRenderer.invoke(COCKPIT_IPC.tabRead, ptyId, req),
    state: (ptyId) => ipcRenderer.invoke(COCKPIT_IPC.tabState, ptyId),
    send: (ptyId, req) => ipcRenderer.invoke(COCKPIT_IPC.tabSend, ptyId, req),
    focus: (ptyId) => ipcRenderer.invoke(COCKPIT_IPC.tabFocus, ptyId),
  },
  checkin: (ptyId, opts) => ipcRenderer.invoke(COCKPIT_IPC.checkin, ptyId, opts ?? {}),
  launch: (req) => ipcRenderer.invoke(COCKPIT_IPC.launch, req),
  feed: {
    get: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.feedGet, workspace ?? null),
    onChange: (cb) => subscribe<FeedSnapshot>(COCKPIT_IPC.feedPush, cb),
    act: (entryId, actionId, payload) => ipcRenderer.invoke(COCKPIT_IPC.feedAct, entryId, actionId, payload ?? {}),
  },
  logEvent: (event) => ipcRenderer.send(COCKPIT_IPC.rendererEvent, event),
  onCreateTab: (cb) => subscribe<CreateTabRequest>(COCKPIT_IPC.createTab, cb),
  createTabResult: (res) => ipcRenderer.send(COCKPIT_IPC.createTabResult, res),
  onGoInto: (cb) => subscribe<GoIntoRequest>(COCKPIT_IPC.goInto, cb),
  ops: {
    list: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.opsList, workspace),
    onChange: (cb) => subscribe<OperationsSnapshot>(COCKPIT_IPC.opsPush, cb),
    run: (req) => ipcRenderer.invoke(COCKPIT_IPC.opsRun, req),
    stop: (workspace, name) => ipcRenderer.invoke(COCKPIT_IPC.opsStop, workspace, name),
    confirm: (workspace, names) => ipcRenderer.invoke(COCKPIT_IPC.opsConfirm, workspace, names),
    dismissSuggestion: (workspace, name) => ipcRenderer.invoke(COCKPIT_IPC.opsDismissSuggestion, workspace, name),
    save: (workspace, def) => ipcRenderer.invoke(COCKPIT_IPC.opsSave, workspace, def),
    linkTab: (ptyId, workspace, name) => ipcRenderer.invoke(COCKPIT_IPC.opsLinkTab, ptyId, workspace, name),
    startAgent: (req) => ipcRenderer.invoke(COCKPIT_IPC.opsAgent, req),
    serialPorts: () => ipcRenderer.invoke(COCKPIT_IPC.opsSerialPorts),
  },
  lint: {
    list: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.lintList, workspace ?? null),
    onChange: (cb) => subscribe<LintSnapshot>(COCKPIT_IPC.lintPush, cb),
    fix: (diagId, fixId) => ipcRenderer.invoke(COCKPIT_IPC.lintFix, diagId, fixId),
    dismiss: (diagId) => ipcRenderer.invoke(COCKPIT_IPC.lintDismiss, diagId),
    suppress: (diagId, scope) => ipcRenderer.invoke(COCKPIT_IPC.lintSuppress, diagId, scope),
    shown: (diagIds, surface) => ipcRenderer.send(COCKPIT_IPC.lintShown, { diag_ids: diagIds, surface }),
    learnTool: (info) => ipcRenderer.send(COCKPIT_IPC.lintLearnTool, info),
  },
};
```

## Appendix E: identical edits (A, B, C and D apply exactly these)

Apply character for character; git merges identical changes cleanly. No other edits to these two files.

**`electron/src/shared/lee-api.ts`**

1. Immediately after the line
   `import type { CopilotAPI } from './copilot';`
   insert the line
   `import type { CockpitAPI } from './cockpit';`
2. Immediately after the line `  copilot: CopilotAPI;` (the last member of `export interface LeeAPI {`), insert these two lines:
   ```ts
     /** Copilot v2 Cockpit (docs/plans/2026-09-25-copilot-v2-contracts.md). */
     cockpit: CockpitAPI;
   ```

**`electron/src/main/preload.ts`**

1. Immediately after the line `import { copilotApi } from './preload-copilot';` insert the line
   `import { cockpitApi } from './preload-cockpit';`
2. Immediately after the line `  copilot: copilotApi,` (the last member of `const api: LeeAPI = {`), insert the line
   `  cockpit: cockpitApi,`

---

## Appendix F: configuration reference (v2 keys)

```yaml
# ~/.lee/config.yaml or ~/.config/lee/config.yaml (machine-wide), or <ws>/.lee/config.yaml (per workspace; wins)
cockpit:
  enabled: true
  default_mode: cockpit          # cockpit | workbench
  tab: { output_buffer_kb: 256, quiet_ms: 1500 }
  checkin: { timeout_s: 180, wait_idle_s: 120, propose_after_min: 20 }
  shell_integration: true
  launch: { provider: claude, worktree_for_delegate: true }
  nudges: { max_per_hour: 6 }
  detect: { enabled: true, tool_paths: [] }

operation_agent:
  model: claude-haiku-4-5-20251001
  plan_model: sonnet
  escalate_model: sonnet

lint:
  toil/repeated-sequence: { severity: warn, min_repeats: 3, window_days: 7, max_len: 3, min_chars: 8, ignore_commands: [] }
  toil/flaky-operation: { severity: warn, window_runs: 10, min_flips: 2 }
  toil/long-wait: { severity: info, min_minutes: 3, min_occurrences: 3, window_days: 7 }
  toil/repeat-approval: { severity: warn, min_repeats: 10, window_days: 7, fast_ms: 2000, fast_streak: 10 }
  demotion: { min_outcomes: 10, dismiss_ratio: 0.8, window_days: 30 }

# Per workspace only:
operations: [ ... ]              # section 7.1
agents:
  pi: { prompt_pattern: "^> $", awaiting_pattern: "\\(y/n\\)" }   # section 5.1 rule 4 (example)
```

Files v2 creates: `~/.lee/shell/**`, `~/.lee/spool/tasks.jsonl`, `~/.lee/ops/<wsid>/{state.json,<op>.last.log}`, `~/.lee/cockpit/nudges.json`, `~/.lee/lint/*` (machine-wide diagnostics), `<ws>/.lee/operations.yaml`, `<ws>/.hester/cockpit/tasks/*.md`, `<ws>/.hester/lint/{outcomes.jsonl,suppressions.json,rules.json}`, `<ws>/.hester/goals/metrics.jsonl` (reading lines), `~/.hester/cockpit/follower.json`, and on a fix click `<ws>/.claude/settings.local.json`.
