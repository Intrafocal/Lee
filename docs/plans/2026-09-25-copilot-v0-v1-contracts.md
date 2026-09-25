# Copilot v0 + v1: implementation contracts

> **Status:** Contract for parallel implementation, 2026-09-25
> **Spec:** [`docs/13-Copilot.md`](../13-Copilot.md) §4.1, §5, §5.1, §8.1, §9, §12–§15 · **Goals:** [`GOALS.md`](../../GOALS.md)
> **Branch:** `copilot-spec`. Six work packages (A–F) are built at the same time in separate git worktrees and merged afterwards.

This document is the only thing the six implementers share. Each package depends on the **contracts** here (types, endpoints, IPC channels, file formats), never on another package's code. If you need something this document doesn't give you, stub it behind the contract and write the question into your final report. Don't reach into another package's files.

---

## 0. How to use this document

### 0.1 Packages at a glance

| Pkg | Name | Owns | Depends on (contract only) |
|---|---|---|---|
| **A** | `lee-core` | Event log, presence and engagement, input capture, per-device tokens and pairing, auth and attribution, Hester ingest, capture relay | Appendix A–D |
| **B** | `lee-queue-hooks` | Attention queue, focus sessions, Claude Code hooks and their install, Reply, v1 away policy and handoff | Appendix A–D; A's HTTP principal (`res.locals.principal`) |
| **C** | `lee-ui` | Every Lee renderer surface in §9 (status bar pill and flyout, banner, Focus, capture, handoff, digest, retro, device list) | Appendix A and D; Hester HTTP API (§8) |
| **D** | `hester` | Someday store, C1/C2 gating, model-call logging, digest, retro, metrics, device-token acceptance | Lee HTTP API (§2.6, §3, §5.6), event log format (§2), device file format (§4.1) |
| **E** | `aeronaut` | Flutter app: Now screen (Reply, Capture, Launch, Wins), ticket pairing | Lee HTTP/WS API, Hester HTTP API |
| **F** | `dirigible` | T-Deck firmware: Waiting list, Reply, Capture, device id | Lee HTTP/WS API |

### 0.2 Verbatim shared files

Four files are defined in full in the appendices and must be **byte-identical** in every branch that has them. Nobody edits them inside a package. Any package that needs them extracts them with this command, run from the repo root:

```bash
python3 - <<'EOF'
import re, pathlib
doc = pathlib.Path('docs/plans/2026-09-25-copilot-v0-v1-contracts.md').read_text()
for m in re.finditer(r'<!-- FILE: (\S+) -->\n```\w*\n(.*?)\n```\n', doc, re.S):
    p = pathlib.Path(m.group(1)); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(m.group(2) + '\n'); print('wrote', p)
EOF
```

| File | Appendix | Needed by |
|---|---|---|
| `electron/src/shared/copilot.ts` | A | A, B, C |
| `electron/src/main/copilot/bus.ts` | B | A, B |
| `electron/src/main/copilot/config.ts` | C | A, B |
| `electron/src/main/preload-copilot.ts` | D | A, B, C |

These files have been typechecked under both `tsconfig.main.json` (no DOM, CommonJS) and the renderer config (`noUnusedLocals`, `isolatedModules`), and `bus.ts` and `config.ts` have been run under plain node.

### 0.3 Identical edits

Two existing files need a one-line hook-up that A, B and C all need in order to compile. Each of those packages applies **exactly** the edits in Appendix E, character for character. Git merges identical changes cleanly. Nobody makes any other change to `preload.ts` or `lee-api.ts`.

### 0.4 Shared-file rules

| File | Who may edit | Where |
|---|---|---|
| `electron/src/main/api-server.ts` | **A** (several delimited edits, §10.A); **B** (one import + one call, §10.B) | anchors given per package |
| `electron/src/main/main.ts` | **A** (4 anchored inserts + 1 replaced value); **B** (1 import + 1 call) | anchors given per package |
| `electron/src/main/pty-manager.ts` | **B only** | §10.B |
| `electron/src/main/pairing-store.ts` | **A only** | §10.A |
| `electron/src/renderer/App.tsx` | **nobody** | C mounts everything from `StatusBar.tsx` |
| `electron/src/renderer/components/StatusBar.tsx`, `PairingDialog.tsx` | **C only** | |
| `hester/**` | **D only** | |
| `aeronaut/**` | **E only** | |
| `dirigible/**` | **F only** | |
| `docs/**`, `GOALS.md`, `CLAUDE.md` | nobody (report doc changes in your final message) | |

All new Electron main-process logic goes in **new files under `electron/src/main/copilot/`**. Modules marked *pure* must not import `electron` (so they can be smoke-tested with `node` after `npm run build:main`).

### 0.5 Constraints every package must respect

- **C1 local-first.** Nothing leaves the machine unless a user action caused it. Device notifications travel only over the existing LAN/Tailscale WebSocket (`/context/stream`); no push service, no cloud relay.
- **C2 quiet while you work.** No model (local or cloud) runs automatically while `presence.at_machine` is true. Lee main never calls a model. Every model call Hester makes is logged with its trigger (§8.3).
- **C3 the human decides.** A Reply (approve, deny, or text typed into an agent) happens only on a human click or keypress in Lee's renderer or on a paired device with its own token. The shared token (Hester, the hook script, scripts) can never reply, snooze, dismiss, start focus or hand off (§4.4).
- **Never content.** The event log stores counts, ids, paths and timings. It never stores keystrokes, user prompt text, reply text, capture text or tool inputs. The agent's own words (its last message, its Notification text) are the one exception (spec §4), capped at 2000 characters.

---

## 1. Scope

Only §15 items 1 (v0) and 2 (v1). The Cockpit tab, tasks, the `tab` command domain (§4.2), check-ins, lint, steward, and copilot mode are **out of scope**. Reply writes to a PTY through `ptyManager.write`; it is not the `tab` domain.

| # | Feature (spec ref) | Phase | Pkgs | Makes measurable / moves (GOALS.md) |
|---|---|---|---|---|
| 1 | Machine-wide event log (§12, §13) | v0 | A (+ writers everywhere) | Prerequisite for every metric below; C1, C2, C3 telemetry |
| 2 | Input counts per tab, tab focus, never content | v0 | A | **peek_rate**, creative_share, catch_up_time (first steering action) |
| 3 | Presence (at the machine) vs engagement (any surface) | v0 | A | **catch_up_time** (returning), **C2** (model calls while at machine), gates D's automatic work |
| 4 | Per-device tokens, issued at pairing, revocable, attributed | v0 | A, E, F, C, D | **device_creative_share** (per device), its guard (sessions outside chosen hours) |
| 5 | Claude Code hooks, compliance-free, per-session install (§4.1) | v0 | B | **attention_latency** (Notification → reply), **background_leverage** (busy time from turn start/end), peek_rate (agent state), toil_load (repeated approvals) |
| 6 | One machine-wide waiting queue, focus-relative blocking (§5) | v0 | B, C, E, F | **focus_interruptions** ↓, **attention_latency** ↓, toil_load (snooze/dismiss counted as ceremony) |
| 7 | Reply on every surface (status bar, Aeronaut, Dirigible) | v0 | B, C, E, F | attention_latency ↓, peek_rate ↓, device_creative_share ↑ |
| 8 | Focus toggle + deterministic inference; quiet during focus | v0 | B, C | **focus_interruptions** (sessions exist to count against); human_balance later |
| 9 | Idea capture from any surface into Someday (replaces `hester ideas`) | v0 | D, A, C, E, F | **capture_pickup** (capture + later triage), device_creative_share ↑, tool_failures ↓ (broken command removed) |
| 10 | Gate C1/C2 violations; log every model call with its trigger | v0 | D | **C1**, **C2** telemetry = 0 |
| 11 | UI ceremony logging | v0 | A, B, C | **toil_load** (ceremony part) |
| 12 | Metrics computation from the event log | v0 | D | Baseline for the v0 success test (peek_rate, attention_latency, focus_interruptions) |
| 13 | Handoff with away policy (§5.1) | v1 | B, C, E | **background_leverage** ↑, **focus_interruptions** ↓; costs one handoff step (toil_load, counted) |
| 14 | Deterministic session-start digest with verified wins (§8.1) | v1 | D, C, E | **catch_up_time** ↓ |
| 15 | Weekly retro prompt and storage (§8.1) | v1 | D, C | **weekly_retro**, **surprise** (judged metrics become collectable) |

**v0 success test (spec §15):** against a two-week baseline taken in the first days of v0, peek_rate and attention_latency fall and focus_interruptions stays ≤ 1 per session. Item 12 exists so the baseline can be computed.

---

## 2. Event log

### 2.1 Location, rotation, retention

- Directory: `~/.lee/events/` (mode `0700`). Written **only** by Lee main (package A's writer). Everyone else appends through `logEvent()` (in-process, Appendix B) or `POST /events/ingest` (Hester, §2.6).
- File per **local** calendar day: `~/.lee/events/YYYY-MM-DD.jsonl` (mode `0600`). The line's `ts` is UTC; the file name uses the local date at write time.
- Size cap: when the current file exceeds `copilot.event_log.max_file_mb` (default 50), continue in `YYYY-MM-DD.1.jsonl`, `.2.jsonl`, and so on. Readers glob `YYYY-MM-DD*.jsonl` and sort by suffix.
- Retention: at startup, delete day files older than `copilot.event_log.retention_days` (default 180).
- Writes: buffered in memory, flushed with `fs.appendFile` every 1 s or at 200 lines, whichever is first; flushed synchronously (`appendFileSync`) from `will-quit`. One JSON object per line, `\n`-terminated, no pretty printing. A write failure is logged to `lee.log` once per minute and never throws into callers.

### 2.2 Envelope

Every line is a `LeeEvent` (Appendix A):

```json
{"v":1,"id":"mfz1k2a3-4f-9c1e2a","ts":"2026-09-25T14:03:11.512Z","type":"attention.reply",
 "source":"lee-main","workspace":"/Users/ben/Development/Lee","window_id":1,
 "actor":{"kind":"user","surface":"device","device_id":"dev_3f9a1c2b7d10","device_kind":"aeronaut"},
 "ctx":{"at_machine":false,"engaged":true,"focus_session_id":null,"away":true},
 "data":{"item_id":"att_…","kind":"approval","action":"approve","text_chars":0,"latency_ms":41200}}
```

- `id`, `ts`, `ctx` are stamped by `copilotBus.logEvent()` (Appendix B). `ctx` is the presence and focus state **at write time**, which makes C2 (model call while at machine) and focus metrics a filter, not a join.
- `workspace` is the absolute path of the related window's workspace, or `null` when machine-wide.
- `actor` defaults to `{kind:'system'}`.

### 2.3 Event types and `data` fields

Field names are fixed. Optional fields are marked `?`. *Writer* is the package that emits it.

| type | writer | `data` fields | Notes |
|---|---|---|---|
| `app.start` | A | `version`, `pid` | |
| `app.quit` | A | — | written synchronously at `will-quit` |
| `window.focus` | A | `focused: boolean` | BrowserWindow focus/blur; `window_id` set |
| `tab.focus` | A | `tab_id`, `tab_type`, `provider?`, `pty_id?`, `file_path?`, `label`, `prev_tab_id?` | the active tab of the focused panel changed, or its window gained focus |
| `input.counts` | A | `tab_id`, `tab_type`, `provider?`, `pty_id?`, `file_path?`, `keys`, `clicks`, `wheels`, `span_ms` | one line per (window, tab) with non-zero counts; flushed every 60 s, on tab change, and at quit. `keys` = keyDown events that are not auto-repeat |
| `presence.change` | A | `from: {at_machine, lee_active, engaged}`, `to: {…same}`, `reason: 'os_idle'\|'os_active'\|'lock'\|'unlock'\|'suspend'\|'resume'\|'lee_input'\|'lee_idle'\|'device'\|'engaged_timeout'`, `away_ms?` | `away_ms` on at_machine false→true |
| `device.paired` | A | `device_id`, `name`, `kind`, `via: 'code'\|'qr'\|'manual'`, `ip?` | |
| `device.revoked` | A | `device_id` | |
| `device.request` | A | `device_id`, `device_kind`, `method`, `route`, `status`, `category` | every non-GET request from a device (or a legacy LAN shared-token client, `device_id: "legacy:<ip>"`). `route` is the Express route pattern (`/attention/:id/reply`), never a raw path with ids. Categories in §4.5 |
| `device.views` | A | `device_id`, `device_kind`, `count`, `window_s: 60` | GETs and WebSocket opens from a device, aggregated per device per minute |
| `capture` | A | `someday_id?`, `text_chars`, `as`, `spooled: boolean` | actor = the capturing user/device |
| `ui.ceremony` | A (IPC), C (via IPC), B | `action` (CeremonyAction), `target?` | confirms, dismissals, snoozes, assignments the tool asked for |
| `agent.session_start` | B | `session_id`, `pty_id?`, `provider: 'claude'`, `cwd?`, `source?` (`startup\|resume\|clear\|compact`) | actor = agent |
| `agent.prompt` | B | `session_id`, `pty_id?`, `prompt_chars` | UserPromptSubmit; **no prompt text** |
| `agent.tool` | B | `session_id`, `pty_id?`, `phase: 'pre'\|'post'`, `tool`, `files: string[]`, `writes: boolean`, `signature` | `signature` = first 12 hex of sha1(tool + JSON(tool_input)); **no tool input** |
| `agent.waiting` | B | `session_id`, `pty_id?`, `notification_type?`, `item_id`, `kind: 'approval'\|'waiting'` | Notification / PermissionRequest |
| `agent.turn_end` | B | `session_id`, `pty_id?`, `busy_ms`, `summary?` (agent's words, ≤ 2000), `lee_status?` (LeeStatusBlock) | Stop |
| `agent.session_end` | B | `session_id`, `pty_id?`, `reason?` | SessionEnd |
| `agent.exit` | B | `pty_id`, `code`, `session_id?` | PTY exit of a tracked agent |
| `attention.open` | B | `item_id`, `kind`, `severity`, `source` (AttentionSource), `tool_signature?` | never includes `tool.preview` |
| `attention.update` | B | `item_id`, `version`, `changes: string[]`, `severity` | |
| `attention.escalate` | B | `item_id`, `from`, `to: 'blocking'`, `reason: 'focus'\|'age'`, `surfaced: boolean`, `during_focus: boolean` | `surfaced` = the banner/notify actually fired |
| `attention.reply` | B | `item_id`, `kind`, `action: 'approve'\|'deny'\|'text'`, `text_chars`, `tool_signature?`, `latency_ms` | actor = the human (Lee or device) |
| `attention.resolve` | B | `item_id`, `kind`, `resolution: 'reply'\|'answered_in_tab'\|'superseded'\|'agent_exit'\|'dismissed'\|'expired'`, `latency_ms` | |
| `attention.snooze` | B | `item_id`, `until` | also counts as ceremony |
| `attention.dismiss` | B | `item_id` | also counts as ceremony |
| `attention.wake` | B | `item_id?`, `pty_id?`, `wake: boolean` | |
| `focus.start` | B | `session_id`, `source: 'manual'\|'inferred'`, `item` (FocusItem), `surface: 'lee'\|'device'\|'auto'` | |
| `focus.item` | B | `session_id`, `item` | the files set grew, or the item changed |
| `focus.end` | B | `session_id`, `reason: 'manual'\|'away'\|'switch'\|'handoff'\|'quit'`, `duration_ms`, `interruptions` | `interruptions` = count of surfaced escalations during the session |
| `handoff.start` | B | `handoff_id`, `summary` (SummaryPolicy), `followups`, `launches`, `wake_items`, `wake_ptys` | counts as ceremony (one per session) |
| `handoff.launch` | B | `handoff_id`, `provider`, `workspace`, `worktree`, `permission_mode` | one per launched agent |
| `away.summary` | B | `handoff_id`, `parked`, `waiting`, `turns_ended` | |
| `handoff.end` | B | `handoff_id`, `reason: 'return'\|'manual'`, `away_ms` | |
| `model.call` | D (via ingest) | `provider: 'gemini'\|'ollama'\|'other'`, `model`, `op: 'generate'\|'stream'\|'embed'\|'subprocess'`, `location: 'cloud'\|'local'`, `trigger: {kind: 'user'\|'automatic'\|'unknown', name?, surface?, request_path?}`, `ok`, `duration_ms?`, `ts_source` | For `op: 'subprocess'` the event is recorded before the run (§8.2), so `ok` means "launched" and `duration_ms` is absent |
| `someday.triage` | D (via ingest) | `someday_id`, `action: 'explore'\|'promote'\|'drop'\|'keep'`, `age_ms` | actor = the human |
| `digest.shown` | D (via ingest) | `since`, `wins`, `waiting`, `claims`, `surface` | actor = the viewer |
| `retro.shown` / `retro.answered` | D (via ingest) | `week`, `answered: string[]` (question ids only) | answers themselves live in the retro file (§8.6) |

### 2.4 Writer API (package A implements, everyone uses)

Everyone in Lee main calls the bus (Appendix B):

```ts
import { logEvent } from './copilot/bus';            // path relative to src/main
logEvent({ type: 'attention.dismiss', window_id, workspace,
           actor: { kind: 'user', surface: 'lee' }, data: { item_id } });
```

Package A implements the sink in `electron/src/main/copilot/event-log.ts` (*pure*):

```ts
export interface EventLogOptions {
  dir: string;                 // ~/.lee/events
  maxFileBytes: number;        // from config
  retentionDays: number;
  flushIntervalMs?: number;    // default 1000
  flushLines?: number;         // default 200
  onError?: (err: unknown) => void;
}
export class EventLogWriter implements EventSink {   // EventSink from bus.ts
  constructor(opts: EventLogOptions);
  write(event: LeeEvent): void;        // buffer
  flush(): Promise<void>;
  flushSync(): void;                   // for will-quit
  prune(now?: Date): number;           // delete files older than retention; returns count
  currentFile(now?: Date): string;
}
```

### 2.5 Metric formulas (package D computes; listed here so the schema is proven sufficient)

All metrics are computed over a window `[from, to)` from the event log alone. An **active hour** is an hour-long bucket in which `ctx.at_machine` and some `input.counts` both occur.

| Metric | Formula from events |
|---|---|
| **peek_rate** | Count `tab.focus` intervals (focus → next `tab.focus`/`window.focus false`) on tabs whose `pty_id` has an agent session that was **busy** at interval start (between `agent.prompt`/first `agent.tool pre` and the next `agent.waiting`/`agent.turn_end`), interval ≥ 2 s, with zero `keys` in `input.counts` for that tab during the interval. Divide by active hours. |
| **toil_load** (v0 part) | Per active hour: `ui.ceremony` + `attention.snooze` + `attention.dismiss` + `handoff.start` + repeated approvals (an `attention.reply action=approve` whose `tool_signature` was already approved in the previous 24 h). Manual command repeats need shell integration: not measurable in v0 (noted). |
| **creative_share** (proxy) | keys+clicks in editor/file tabs and `attention.reply action=text` and `capture` vs keys in terminal tabs during agent busy time + approvals + peeks. Rough; reported with the formula version. |
| **catch_up_time** | For each `presence.change` at_machine false→true with `away_ms ≥ 30 min`: time to the first steering action: `attention.reply`, `agent.prompt`, `focus.start`, `capture`, or `input.counts` with `keys > 0` in an editor/file tab. |
| **focus_interruptions** | Per `focus.end`: its `interruptions` (cross-check: `attention.escalate surfaced=true during_focus=true` with that `ctx.focus_session_id`). |
| **background_leverage** (v0: busy time only) | Σ `agent.turn_end.busy_ms` per hour of focus time (Σ `focus.end.duration_ms`). "Accepted result" needs v2 tasks; report busy time and mark accepted as unavailable. |
| **device_creative_share** | Per device and overall: creative / (creative + managing) over `device.request` (categories §4.5) plus `device.views` minutes as managing. |
| **capture_pickup** | Captures with `ctx.at_machine=false` (or a device actor) that got a `someday.triage` with `action ∈ {explore, promote, drop}` (a `keep` doesn't count) within 14 days / all such captures older than 14 days. Spooled captures (`spooled: true`) with no `someday_id` can't be linked to a triage and are left out of both counts (formula_version 2). |
| **attention_latency** | Median over `attention.resolve` with `kind ∈ {approval, waiting, decision, blocker}` and `resolution ∈ {reply, answered_in_tab}` of `latency_ms` (= resolve time − item `created_at`). |
| **C1** | `model.call` with `location='cloud'` and `trigger.kind ≠ 'user'`. Target 0. |
| **C2** | `model.call` with `trigger.kind ≠ 'user'` and `ctx.at_machine = true`. Target 0. |
| **C3** | `attention.reply` whose `actor.kind ≠ 'user'`. Target 0 (and structurally impossible, §4.4). |

### 2.6 Ingest endpoint (package A)

`POST /events/ingest` on Lee main :9001. **Principal must be `shared` with `loopback: true`** (Hester on the same machine), else 403.

Request:
```json
{ "events": [
  { "type": "model.call", "workspace": "/abs/ws",
    "actor": { "kind": "hester" },
    "data": { "provider": "gemini", "model": "gemini-2.5-flash", "op": "generate",
              "location": "cloud", "trigger": { "kind": "user", "surface": "palette", "request_path": "/context/stream" },
              "ok": true, "duration_ms": 1830, "ts_source": "2026-09-25T14:03:09.100Z" } }
] }
```
- At most 500 events per request. Allowed `type` values: `model.call`, `someday.triage`, `digest.shown`, `retro.shown`, `retro.answered`. Others are rejected per item.
- `source` is forced to `"hester"`. `actor` is accepted as given if it is a valid `Actor`, else `{kind:'hester'}`. `ts` and `ctx` are stamped by Lee at ingest; Hester's own time goes in `data.ts_source`.

Response: `200 {"success": true, "data": {"accepted": 1, "rejected": [{"index": 3, "reason": "type not allowed"}]}}`.

---

## 3. Presence and engagement (package A)

### 3.1 Definitions

| Signal | True when | Source | Gates |
|---|---|---|---|
| `at_machine` | OS idle time < `presence.at_machine_idle_seconds` (300) **and** screen not locked **and** system not suspended | `powerMonitor.getSystemIdleTime()` polled every 5 s; `powerMonitor` `lock-screen`/`unlock-screen`/`suspend`/`resume` events apply immediately; any Lee input sets it true immediately | D's automatic work (C2); `catch_up_time`; manual focus end (B) |
| `lee_active` | keyboard or mouse input in a Lee window within `presence.lee_active_seconds` (120) | `before-input-event` (keyboard, main process) + `copilot:input` IPC (mouse, preload) | B's away-end detection; focus inference |
| `engaged` | any human action from any surface within `presence.engaged_seconds` (300) | Lee input, or **any** authenticated request from a `device` principal (including views) | notifications (B) |

**Deviation from spec, deliberate:** spec §5.1 defines "at the machine" as input in a Lee window. We use OS-level input because C2 must hold while you're typing in a browser next to Lee, and `catch_up_time` measures returning to the machine, not to Lee. `lee_active` keeps the narrower signal. Recorded in §12.

Checking your phone makes you `engaged` (device request) but never `at_machine`.

### 3.2 Input capture (never content)

- **Keyboard:** A attaches `bw.webContents.on('before-input-event', …)` per window and counts `input.type === 'keyDown' && !input.isAutoRepeat`. Only the count is kept. Nothing about `input.key` is stored or forwarded. Keystrokes inside `<webview>` browser tabs are not seen (they go to the guest's webContents); accepted gap.
- **Mouse:** the preload (Appendix D) counts `mousedown` and `wheel` in the capture phase and sends `copilot:input` (`InputBatch {clicks, wheels, span_ms}`) at most once per second while there is activity. Main attributes it to the sender's window.
- **Tab attribution:** main resolves the window's active tab as `ctx.panels[ctx.focusedPanel].activeTabId` in `windowRegistry.get(id).contextBridge.getContext()`, and takes `type`, `provider`, `ptyId`, `filePath`, `label` from `ctx.tabs`. Counts accumulate per (window_id, tab_id) and flush as `input.counts` (§2.3).

### 3.3 Presence API

- In-process: A calls `copilotBus.setPresenceProvider(() => presence.get())`.
- HTTP: `GET /presence` → `200 {"success": true, "data": PresenceState}` (any principal).
- IPC: `copilot:presence:get` (invoke) and push `copilot:presence` (PresenceState) to every window on each change.
- **Pushed to Hester and devices:** on every change, A calls `copilotBus.broadcast({ type: 'presence', data: PresenceState })`. That message goes out on the existing `ws://<host>:9001/context/stream` socket, which Hester's `LeeContextClient`, Aeronaut and Dirigible already hold open. All three ignore message types they don't know (verified: `hester/daemon/lee_client.py` only handles `context_update`; Dirigible `lee_client.cpp` returns on other types; Aeronaut `connection_provider.dart` switches on `type`). D may also poll `GET /presence` (§8.2).
- A `presence.change` event is logged on every transition of `at_machine`, `lee_active` or `engaged`.

---

## 4. Per-device tokens (package A; clients E, F; verifier D)

### 4.1 Storage

- Directory `~/.lee/devices/` (mode `0700`); one file per device, `~/.lee/devices/<device_id>.json` (mode `0600`):

```json
{
  "device_id": "dev_3f9a1c2b7d10",
  "name": "Ben's iPhone",
  "kind": "aeronaut",
  "token_sha256": "9b1f…64 hex",
  "created_at": "2026-09-25T14:00:00.000Z",
  "last_seen_at": "2026-09-25T15:10:02.000Z",
  "last_ip": "192.168.1.23",
  "paired_via": "qr",
  "revoked_at": null
}
```

- `device_id` = `dev_` + 12 lowercase hex. The raw token is a `crypto.randomUUID()` (36 characters, so Dirigible's typed-token meter still turns green) and is **never stored**: only its sha256 hex. It is returned exactly once, at issuance.
- `last_seen_at`/`last_ip` are updated in memory and flushed to the file at most every 5 minutes and at quit.
- Revocation sets `revoked_at` (the file is kept for attribution history). A revoked token is rejected everywhere; A also closes any open WebSockets authenticated with it.
- Pure module `electron/src/main/copilot/device-tokens.ts`:

```ts
export interface DeviceRecord extends DeviceInfo { token_sha256: string }   // DeviceInfo from shared/copilot.ts
export class DeviceTokenStore {
  constructor(dir: string);
  issue(opts: { name: string; kind: string; via: 'code' | 'qr' | 'manual'; ip?: string }): { record: DeviceRecord; token: string };
  verify(token: string): DeviceRecord | null;         // constant-time compare on sha256; null if revoked/unknown
  revoke(deviceId: string): boolean;
  list(): DeviceInfo[];                                // newest first, token_sha256 omitted
  touch(deviceId: string, ip: string): void;
  flush(): void;
  createTicket(ttlMs?: number): { ticket: string; expiresIn: number };   // default 600_000, 32 hex, single use, in memory only
  redeemTicket(ticket: string): boolean;               // true once, then false
}
```

### 4.2 Issuance at pairing

**Code approval (Dirigible, existing E19 flow).** Unchanged on the wire except the grant: `GET /pair/poll` returning `approved` now issues a **device token** at the moment of release (not at approval), so an approved-but-never-collected request creates nothing:

```json
{ "status": "approved", "token": "<device token, uuid>", "device_id": "dev_3f9a1c2b7d10", "hester_port": 9000, "name": "bens-mbp" }
```
`PairingStore.poll` changes its grant callback to receive the entry: `poll(nonce, grant: (entry: PairingEntry) => PairingGrant)`, and `PairingGrant` gains `device_id?: string` (A edits `pairing-store.ts`). The device record uses `entry.device`, `entry.kind`, `via: 'code'`, `entry.ip`. A `device.paired` event is logged. A also logs `ui.ceremony {action:'confirm', target:'pairing'}` when the approve/deny dialog is answered.

**QR (Aeronaut).** The QR no longer carries the shared token. `aeronaut:get-pairing-qr` (main.ts) returns:

```json
{ "name": "bens-mbp", "host": "192.168.1.10", "hostPort": 9001, "apiPort": 9001, "hesterPort": 9000,
  "ticket": "5c0e…32 hex", "ticketExpiresIn": 600, "pairVersion": 2 }
```
The phone exchanges the ticket at a new unauthenticated route:

`POST /pair/redeem` `{ "ticket": "…", "device": "Ben's iPhone", "kind": "aeronaut" }`
- `200 {"status":"approved","token":"…","device_id":"dev_…","hester_port":9000,"name":"bens-mbp"}`
- `410 {"status":"expired"}` for unknown, used or expired tickets (indistinguishable)
- `400` on a malformed body (same validation rules as `validatePairingBody` for `device`/`kind`)
- `429` beyond 10 attempts per IP per minute; `404` when `hester.pairing_enabled` is false.
- Excluded from CORS like the other `/pair/*` routes. Showing the QR on Lee's screen is the physical-proximity proof, so no dialog. `via: 'qr'`.

**Manual (typed token).** Lee's Devices list (C) offers **Create device token** (IPC `copilot:devices:create`, local-user only), which returns a token once for typing into Dirigible's Token fallback or Aeronaut's Add Machine screen. `via: 'manual'`.

### 4.3 Auth middleware and principals

A replaces the inline middleware in `APIServer` with `copilotAuthMiddleware(getSharedToken)` from `electron/src/main/copilot/auth.ts`:

```ts
export function authenticateToken(token: string | null | undefined, ip: string, sharedToken: string): Principal | null;
export function copilotAuthMiddleware(getSharedToken: () => string): express.RequestHandler; // sets res.locals.principal
export function authenticateWsToken(request: IncomingMessage, sharedToken: string): Principal | null; // reads ?token=
export function requirePrincipal(...kinds: Array<Principal['kind']>): express.RequestHandler; // 403 otherwise
export function requireLoopbackShared(): express.RequestHandler;
export function noteDeviceView(principal: Principal | undefined): void;     // WS open / GET: per-minute device.views
export function noteDeviceWsInput(principal: Principal | undefined): void;  // PTY WS message: per-minute pty_input count
```
- Unauthenticated: `OPTIONS *`, `GET /health`, `POST /pair/request`, `GET /pair/poll`, `POST /pair/redeem`. Everything else needs a token.
- Token equal to `~/.lee/api-token` → `{kind:'shared', loopback, ip}`. `loopback` is true for `127.0.0.1`, `::1`, `::ffff:127.0.0.1`. **The shared token keeps working** for the renderer's daemon fetches, the hook script, Hester, Spyglass and already-paired devices.
- A device token → `{kind:'device', …}`, and `store.touch()`.
- `res.locals.principal` is always set on authenticated routes. B's routes read it.
- The WebSocket upgrade handler uses `authenticateWsToken` and stores the principal on the request (`(request as any)._principal`), so A can count device views and PTY input.

### 4.4 C3 enforcement by principal

| Endpoint group | local-user (IPC) | device | shared, loopback | shared, LAN (legacy) |
|---|---|---|---|---|
| GET `/attention*`, `/focus`, `/away`, `/presence`, `/handoff/proposals` | ✓ | ✓ | ✓ | ✓ |
| Reply, snooze, dismiss, wake, open, focus start/stop, handoff start/end | ✓ | ✓ | **403** | **403** |
| Typed input on the `/pty/:id/stream` WebSocket into an agent PTY (one Lee spawned as `claude`) | ✓ (IPC) | ✓ | dropped | dropped |
| `POST /capture` | ✓ | ✓ | ✓ (scripts) | ✓ |
| `POST /agent/hook` | — | 403 | ✓ | 403 |
| `POST /events/ingest` | — | 403 | ✓ | 403 |
| `GET /devices`, `DELETE /devices/:id` | ✓ (IPC) | own id only | ✓ | 403 |

Hester has only the shared token, so it structurally cannot reply or approve (C3). A legacy device that still holds the shared token can read but must re-pair to reply.

Agent-PTY keystrokes over the PTY stream are Reply-class: with the shared token the stream still delivers output and accepts resize, and typed input into shell PTYs still works (Spyglass types into remote shells, and the shared token can already run commands through `/command`), but typed input into an agent PTY is silently dropped. Spyglass (which uses the remote machine's shared token) therefore can't answer remote agent prompts until it pairs for a device token.

### 4.5 Attribution into the event log

A registers, right after the auth middleware, a `res.on('finish')` hook that logs for device principals (and for `shared` with `loopback: false`, as `device_id: "legacy:<ip>"`, `device_kind: "legacy"`):

- non-GET → `device.request` with `route = req.route?.path ?? '(unmatched)'` and a category;
- GET → added to the per-device per-minute `device.views` counter.

Category: `res.locals.deviceCategory` if a handler set it, else this default table:

| Route | Default category | Creative? |
|---|---|---|
| `POST /capture` | `capture` | ✓ |
| `POST /attention/:id/reply` | B overrides: `approve` (approve/deny on an approval), `decide` (text on a decision/blocker), `reply` (other text) | approve ✗, decide ✓, reply ✓ |
| `POST /handoff/start` | `launch` | ✓ |
| `POST /focus/start`, `POST /focus/stop` | `start_work` | ✓ |
| `POST /attention/:id/snooze\|dismiss\|wake\|open`, `POST /handoff/end` | `triage` | ✗ |
| `POST /command` | `command` | ✗ |
| PTY WebSocket messages | `pty_input` (counted per minute into `device.views` with `category: 'pty_input'`, not per keystroke) | ✗ |
| anything else | `other` | ✗ |

Every device request also marks the presence `engaged` with `engaged_via: 'device'`.

### 4.6 Hester accepts device tokens (package D)

Devices call Hester :9000 directly (chat, digest). D extends `hester/shared/auth.py` with `device_for_token(token) -> Optional[dict]` that reads `~/.lee/devices/*.json` (cached; re-read when the directory's or any file's mtime changes), compares `sha256(token)` with `secrets.compare_digest`, and rejects `revoked_at != null`. The daemon middleware accepts the shared token **or** a valid device token, and sets `request.state.principal = {"kind": "shared"|"device", "device_id": …, "device_kind": …}`.

---

## 5. Attention queue and focus (package B)

### 5.1 Item model

`AttentionItem`, `AttentionSnapshot`, `FocusItem`, `FocusState`, `AwayState` are defined in Appendix A. Producers in v0/v1:

| Kind | Created by | Title (fixed wording) | Text | Actions |
|---|---|---|---|---|
| `approval` | `PermissionRequest` hook, or `Notification` classified as permission | `Claude wants to use <tool>` | Notification message or `tool.preview` | approve, deny, open, snooze, dismiss, wake |
| `waiting` | `Notification` classified as waiting (idle prompt / anything else) | `Claude is waiting for you` | Notification message + last turn summary | reply, open, snooze, dismiss, wake |
| `blocker` | `Stop` with `lee-status` `status: blocked` | `Claude is blocked` | `blockers` or summary | reply, open, snooze, dismiss, wake |
| `decision` | `Stop` with `lee-status` `status: waiting` | `Claude needs a decision` | `blockers`/`next` or summary | reply, open, snooze, dismiss, wake |
| `failure` | tracked agent PTY exits with code ≠ 0 | `Claude exited (code N)` | last summary | open, dismiss |
| `review` | `Stop` otherwise | `Claude finished a turn` | summary (labelled as the agent's words) | reply, open, dismiss |
| `summary` | away policy (v1, §7) | `While you were away` | deterministic summary | open (opens the digest), dismiss |

**One open item per agent session.** A newer state for the same `pty_id` (or `session_id` if the pty is unknown) **supersedes** the older open item: the old one resolves with `superseded`, except an open `approval`, which is only superseded by another `approval` or resolved by the tool completing.

Notification classification (tolerant): `notification_type === 'permission_prompt'` or `/permission|approve|allow|wants to (use|run)/i` on `message` → approval; `notification_type === 'auth_success'` → ignore; otherwise waiting.

**Resolution in the tab** (`answered_in_tab`): an open `approval` resolves on `PostToolUse` or `PostToolUseFailure` of the pending tool (matched by `tool_use_id`, then tool signature, then tool name only when neither is known), a newer `PreToolUse` from the same agent with a different `tool_use_id` arriving ≥ 2 s after the approval opened, an `idle_prompt` Notification (which also ends the turn), in-tab Enter, a digit or Esc typed into the agent PTY while it is paused on the prompt (Esc also ends the turn), `UserPromptSubmit`, or `Stop`. A deny resolves that agent's other open approvals. Approve/deny when the session is no longer paused on a prompt returns **409 `stale`**, writes no keys, and resolves the item `answered_in_tab`. `waiting`/`blocker`/`decision`/`review` resolve on `UserPromptSubmit`. `review` also resolves on `tab.focus` of that agent's tab (you looked at a finished result, which is the good kind of reading), and expires after `attention.review_expiry_hours` (12). Any open item resolves `agent_exit` when its PTY exits.

Order in lists: severity (blocking, needs-you, ambient), then `active_wait_ms` descending. Quadrants don't exist until v4.

### 5.2 Severity rules (recomputed every 15 s and on every change)

```
base      = ambient for review/summary; needs-you for everything else
blocking  = base == needs-you AND not snoozed AND not parked AND (
              related_to_focus                                   -- reason 'focus'
              OR active_wait_ms >= waiting_limit_minutes * 60000  -- reason 'age', default 20 min
            )
```
- `related_to_focus`: focus item `agent` → same `pty_id`; `files` → the item's agent session has written (Edit/Write/MultiEdit/NotebookEdit) any path in `focus.item.paths`; `workspace` → never (only age escalates).
- `active_wait_ms` stops accruing while the away policy is active (§7).
- A transition to blocking logs `attention.escalate` once per item per focus session (or once per item outside focus). `surfaced` is true when the banner is shown on some Lee window or `notify` is true.
- Snoozed items (`state: 'snoozed'`) are hidden from counts until `snoozed_until` passes, or, for `until: 'change'`, until the item's source produces a new hook event.
- Dismissed items stay dismissed unless their session produces a new state (which creates a new item).

### 5.3 Focus sessions

**Manual.** `focusStart(item?)` from Lee, or `POST /focus/start` from a device. Default item when none is passed: from the focused window's active tab. An agent tab with a tracked session → `{kind:'agent'}`; a tab with `filePath` → `{kind:'files', paths:[filePath]}`; otherwise `{kind:'workspace'}`. From a device with no item: `{kind:'workspace', workspace: <focused window's workspace>}`. Starting while a session is active replaces its item (logs `focus.item`).

**Inferred (deterministic).** B keeps one-minute buckets from `input.counts` events: each bucket's key is the tab with the most keys+clicks in that minute, mapped to `agent:<pty_id>` if that tab has an agent session, `files:<workspace>` if it has a `file_path` (all files in a workspace are one family), else `null`. Start an inferred session when, in the last `focus.infer_window_minutes` (10) buckets, at least `focus.infer_min_active_minutes` (7) are active and all active buckets share one non-null key. The item is `agent` or `files` (paths = files with input in those buckets).

**While active:** for a `files` item, every `input.counts` with keys in a tab with a new `file_path` adds it to `paths` (cap 50; logs `focus.item`).

**End:**
- manual: `focusStop()`; `at_machine` false for `focus.manual_end_away_minutes` (15); handoff start; app quit.
- inferred: the above, or `at_machine` false for `focus.inferred_end_away_minutes` (5), or `focus.switch_minutes` (3) consecutive active buckets with a different key (`reason: 'switch'`). A manual start converts an inferred session to manual (same `session_id`).
- `focus.end.interruptions` = surfaced escalations during the session.

**During focus** only blocking items surface. `FocusState.quiet_count` = open needs-you + ambient items not related to focus. C shows only that count (§9.1).

### 5.4 Notify (devices)

`notify` is computed per item:

```
notify = !inQuietHours() && state == 'open' && (
           away.active ? (item.wake || source.pty_id in away.wake_pty_ids)
                       : severity == 'blocking' )
```
Devices alert (vibrate, sound, LED, header blink) only when an item's `notify` changes from false to true. They are **pull-first** otherwise. Everything travels on the existing LAN/Tailscale WebSocket (C1).

### 5.5 Reply: what reaches the agent

Reply is `ptyManager.write(pty_id, bytes)`, executed only for a human principal (§4.4), and only if `req.version === item.version` (else `409 {"success":false,"error":"stale"}`) and the PTY is alive (else `410`).

| Item kind | `action` | Bytes written | Why |
|---|---|---|---|
| `approval` | `approve` | `"\r"` | Enter accepts the highlighted default option ("Yes") in Claude Code's permission prompt |
| `approval` | `deny` | `"\x1b"` | Esc declines and returns control to the prompt |
| `waiting`, `blocker`, `decision`, `review` | `text` | `"\x1b[200~" + text + "\x1b[201~"`, then after 30 ms `"\r"` | bracketed paste keeps multi-line text from submitting early; Enter submits |

- `text` is required for `action: 'text'`: 1–4000 characters after stripping control characters other than `\n` and `\t`.
- "Approve always" is not offered (it would change the agent's permissions; not a v0 feature).
- After writing, the item resolves `reply` (`attention.reply` + `attention.resolve`). `res.locals.deviceCategory` is set per §4.5.
- Keys are named constants in `reply.ts` (`APPROVE_KEYS`, `DENY_KEYS`). B must verify them manually against the installed Claude Code (`claude --version` → 2.1.282 at time of writing) and report any difference.

### 5.6 HTTP endpoints on Lee main :9001 (package B)

All responses use the existing envelope `{ "success": true, "data": … }` / `{ "success": false, "error": "…" }`.

| Method & path | Body / query | Returns | Principal |
|---|---|---|---|
| `GET /attention` | `?compact=1` (text ≤ 280, no `files`, ≤ 25 items), `?all=1` (include resolved in the last 24 h) | `AttentionSnapshot` | any |
| `GET /attention/:id` | — | `AttentionItem` (full) | any |
| `POST /attention/:id/reply` | `ReplyRequest` | `ActionResult` | human |
| `POST /attention/:id/snooze` | `SnoozeRequest` | `ActionResult` | human |
| `POST /attention/:id/dismiss` | — | `ActionResult` | human |
| `POST /attention/:id/wake` | `{ "wake": true }` | `ActionResult` | human |
| `POST /attention/:id/open` | — | `ActionResult` (focuses the owning window and sends `system:focus-tab`) | human |
| `GET /focus` | — | `FocusState` | any |
| `POST /focus/start` | `{ "item"?: FocusItem }` | `FocusState` | human |
| `POST /focus/stop` | — | `FocusState` | human |
| `GET /away` | — | `AwayState` | any |
| `GET /handoff/proposals` | — | `HandoffProposals` | any |
| `POST /handoff/start` | `HandoffRequest` | `HandoffResult` | human |
| `POST /handoff/end` | — | `AwayState` | human |
| `POST /agent/hook` | raw Claude Code hook JSON; headers §6.2 | `204`, or `200 text/plain` (SessionStart hint) | shared, loopback |

"human" = `local-user` (IPC) or `device`.

**WebSocket.** On every queue, focus or away change (debounced 250 ms), B calls `copilotBus.broadcast({ type: 'attention_snapshot', data: <compact snapshot> })`. B registers `copilotBus.onStreamConnect(send => send({ type: 'attention_snapshot', data: compact }))` so a new client gets the current state immediately. On return (§7) B broadcasts `{ type: 'copilot_return', data: ReturnInfo }`.

### 5.7 Renderer IPC equivalents (package B implements handlers)

Channels are the `COPILOT_IPC` constants in Appendix A; the preload wrapper is Appendix D.

| Channel | Kind | Args → result |
|---|---|---|
| `copilot:attention:get` | invoke | → `AttentionSnapshot` (full) |
| `copilot:attention` | push | `AttentionSnapshot` (full) to every window on change (debounced 100 ms) |
| `copilot:attention:reply` | invoke | `(itemId, ReplyRequest)` → `ActionResult` |
| `copilot:attention:snooze` | invoke | `(itemId, SnoozeRequest)` → `ActionResult` |
| `copilot:attention:dismiss` | invoke | `(itemId)` → `ActionResult` |
| `copilot:attention:wake` | invoke | `(itemId, wake)` → `ActionResult` |
| `copilot:attention:open` | invoke | `(itemId)` → `ActionResult` |
| `copilot:focus:start` / `:stop` | invoke | `(item \| null)` / `()` → `FocusState` |
| `copilot:handoff:proposals` / `:start` / `:end` | invoke | `()` → `HandoffProposals`; `(HandoffRequest)` → `HandoffResult`; `()` → `AwayState` |
| `copilot:return` | push | `ReturnInfo` |

IPC calls act as `{kind:'local-user'}` with `actor {kind:'user', surface:'lee'}`, `window_id` = the sender's window.

---

## 6. Claude Code hooks (package B)

### 6.1 Verified mechanism

Verified on this machine against `claude` 2.1.282 (`claude --help` and `~/.claude/cache/changelog.md`):

- `--settings <file-or-json>`: "Path to a settings JSON file or a JSON string to load additional settings from". This is the per-session install; the project's `.claude/` is never touched. Settings loaded this way are additive to user/project settings, so the user's own hooks keep running. (Merging of hook arrays across sources is the documented behaviour; B verifies it in acceptance.)
- Hook events available: `SessionStart` (input has `source`), `UserPromptSubmit`, `PreToolUse`, `PostToolUse` (has `duration_ms`), `PermissionRequest`, `Notification` (matcher values exist per notification type), `Stop` (input includes `last_assistant_message`, the final assistant text, and `background_tasks`), `SessionEnd`. All inputs carry `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
- `Notification` input carries `message`; `notification_type` (e.g. `permission_prompt`, `idle_prompt`, `auth_success`) is **not confirmed locally**: treat as optional.
- Settings files that fail validation are **silently ignored** by Claude Code. So the settings file uses only long-established fields (`type`, `command`, `timeout`, `matcher`) and no `async`.
- `--session-id <uuid>`, `--permission-mode acceptEdits`, `-w/--worktree [name]`, `-n/--name` and a positional `prompt` exist (used by handoff launch, §7).
- **Not confirmed:** that hook subprocesses inherit Claude Code's environment (`LEE_PTY_ID`). It is standard for command hooks and `CLAUDE_PROJECT_DIR` is added on top of it, but B must verify. Fallback in §6.4.

### 6.2 Files Lee writes (at every Lee start, by B's `hook-install.ts`)

`~/.lee/hooks/` (mode `0700`):

1. `claude-hook.sh` (mode `0755`), exactly:

```sh
#!/bin/sh
# Lee relay for Claude Code hooks. Written by Lee at startup; edits are overwritten.
# Usage (from --settings): /bin/sh claude-hook.sh <HookEventName>   (payload on stdin)
EVENT="${1:-unknown}"
HDR="$HOME/.lee/hooks/auth-header"
# Lee sets LEE_API_URL for its own PTYs. The bearer token only ever goes to
# Lee's loopback API: anything but http://127.0.0.1:<port> falls back to the default.
BASE="${LEE_API_URL:-http://127.0.0.1:9001}"
PORT="${BASE#http://127.0.0.1:}"
case "$PORT" in ''|*[!0-9]*) BASE="http://127.0.0.1:9001" ;; esac
URL="$BASE/agent/hook"
if [ ! -r "$HDR" ]; then cat >/dev/null; exit 0; fi
# -f: an error status prints nothing, so an auth or server error body never
# reaches Claude's context through the SessionStart output below.
if RESP=$(curl -fsS --max-time 2 -X POST "$URL" \
  -H @"$HDR" \
  -H "Content-Type: application/json" \
  -H "X-Lee-Hook-Event: $EVENT" \
  -H "X-Lee-Pty-Id: ${LEE_PTY_ID:-}" \
  -H "X-Lee-Window-Id: ${LEE_WINDOW_ID:-}" \
  --data-binary @- 2>/dev/null); then
  if [ "$EVENT" = "SessionStart" ] && [ -n "$RESP" ]; then printf '%s\n' "$RESP"; fi
fi
exit 0
```
   The script never parses JSON (Lee does), never prints anything for other events (so `PermissionRequest` makes no decision and the normal prompt shows), and always exits 0 (Lee being down never breaks Claude).

2. `auth-header` (mode `0600`): one line, `Authorization: Bearer <contents of ~/.lee/api-token>`. Using `curl -H @file` keeps the token out of `ps` output. (macOS ships curl 8.x; `-H @file` needs ≥ 7.55.)

3. `claude-settings.json`, with the absolute path of the script substituted (JSON-escaped):

```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "/bin/sh '/Users/<you>/.lee/hooks/claude-hook.sh' SessionStart", "timeout": 5 }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' UserPromptSubmit", "timeout": 5 }] }],
    "PreToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' PreToolUse", "timeout": 5 }] }],
    "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' PostToolUse", "timeout": 5 }] }],
    "PostToolUseFailure":[{ "matcher": "*", "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' PostToolUseFailure", "timeout": 5 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' PermissionRequest", "timeout": 5 }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' Notification", "timeout": 5 }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' Stop", "timeout": 5 }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "/bin/sh '…/claude-hook.sh' SessionEnd", "timeout": 5 }] }]
  }
}
```
   `PermissionRequest` is omitted when `copilot.hooks.permission_request` is false. If the path contains a single quote, B escapes it for sh.

The files are rewritten at each start (and `auth-header` whenever the token file changes). If `copilot.hooks.claude` is false, the settings file is deleted and no flag is injected.

### 6.3 Per-session installation (`pty-manager.ts`, B)

One injection point, `PTYManager.spawn()`, covers every path that launches Claude: agent tabs (`spawnAgent`), configured TUIs (`spawnConfiguredTUI` → `spawnTUI`), prewarm (`prewarmTUI('claude')` → `spawnTUI`), and `system:create-tab` with `command: 'claude'` (renderer → `pty:spawn`).

- Every PTY gets `LEE_PTY_ID=<id>`, `LEE_WINDOW_ID=<windowId>` (if known) and `LEE_API_URL=http://127.0.0.1:<api port, 9001>` in its environment.
- If `path.basename(cmd) === 'claude'` and the settings file exists, prepend `--settings <abs path>` to the argv, unless argv already contains `--settings`. Shell-wrapped spawns (`shell: true`) and `claude` typed by hand in a terminal are not hooked (documented gap; matches "agents Lee launches").

### 6.4 `POST /agent/hook` processing

Headers: `X-Lee-Hook-Event` (authoritative event name; fall back to body `hook_event_name`), `X-Lee-Pty-Id` (may be empty), `X-Lee-Window-Id`. Body: the hook JSON; every field optional. Tolerate unknown fields and invalid JSON (→ `204`, logged once).

**Session → PTY mapping:** `X-Lee-Pty-Id` if present → remember `session_id → pty_id`. Else look up `session_id` in that map. Else leave `pty_id: null`: the item still appears, but `reply` and `open` are omitted from its `actions`. Window/tab/workspace come from scanning `windowRegistry` contexts for the tab whose `ptyId` matches; `workspace` falls back to the window's workspace, then `cwd`.

| Hook | Lee does |
|---|---|
| `SessionStart` | `agent.session_start`; register session. If `hooks.lee_status_hint`, respond `200 text/plain`: `When you finish a unit of work or need a decision, you may end your message with a fenced lee-status block (status: done / in-progress / blocked / waiting; summary; blockers; files; next). It is optional.` |
| `UserPromptSubmit` | `agent.prompt` (`prompt_chars` only); mark busy; resolve open items `answered_in_tab` (§5.1) |
| `PreToolUse` | `agent.tool phase=pre`; remember as the pending tool (name, preview, signature); files = `tool_input.file_path \| path \| notebook_path`; `writes` for Edit/Write/MultiEdit/NotebookEdit; mark busy |
| `PermissionRequest` | create/refresh `approval` (tool from payload `tool_name`/`tool_input`, else the pending tool); `agent.waiting kind=approval` |
| `PostToolUse`, `PostToolUseFailure` | `agent.tool phase=post`; resolve the open approval for that call (§5.1 matching) `answered_in_tab`; resume busy only when no approval is left |
| `Notification` | classify (§5.1); approval → merge into the open approval (sets its text) or create; waiting → create `waiting`; `agent.waiting`; pause busy |
| `Stop` | summary = `last_assistant_message` if present, else the text blocks of the last `type: "assistant"` entry in `transcript_path` (read at most the last 256 KB; tolerate failure). Parse the **last** fenced block whose info string is `lee-status` (lines `key: value`; `files` comma-separated; unknown keys ignored). `agent.turn_end {busy_ms, summary, lee_status}`; create `blocker`/`decision`/`review` per §5.1 |
| `SessionEnd` | `agent.session_end`; resolve that session's open items `superseded` except failures |

Busy accounting per session: busy starts on `UserPromptSubmit` (or the first `PreToolUse` if none); pauses on `PermissionRequest`/`Notification`; resumes on `PostToolUse`; ends on `Stop` → `busy_ms`.

### 6.5 What happens to `hester/daemon/workstream/hooks.py`

It is **deleted** by package D, along with its two exports in `hester/daemon/workstream/__init__.py`. It has no callers anywhere in the repo (verified: `grep -rn "setup_workstream_hooks\|generate_claude_code_hooks"` finds only its own module and `__init__.py`). It wrote into the project's `.claude/settings.local.json` and treated `Stop` as completion; both are replaced by §6. `POST /orchestrate/telemetry` stays (other callers use it).

---

## 7. v1: away policy and handoff (package B state; C, E surfaces)

### 7.1 Handoff flow

1. User opens **Hand off…** (status bar flyout, the Focus-stop prompt, or Aeronaut's Launch). The surface calls `handoffProposals()` / `GET /handoff/proposals`:
   - `agents`: every tracked agent session with its tab, state (`busy`, `idle` = after Stop with no open item, `waiting` = open approval/waiting item, derived from open items only, not from a leftover activity state, `unknown`), and last summary.
   - `waiting`: open items (for boundary triage now, or to leave parked).
   - `workspaces`: open windows' workspaces; `default_summary: {mode:'on_return'}`.
2. The user fills in, all optional: follow-up text for idle agents, new background agents to launch (workspace, prompt, title, worktree default **on**, permission mode default **`acceptEdits`**: the `delegate` lead, spec §2.2), the summary policy, and "wake me" marks on items and agents.
3. **Launch** calls `handoffStart(HandoffRequest)` / `POST /handoff/start`. B, in order:
   - ends any focus session (`reason: 'handoff'`);
   - sends each follow-up with the text Reply rule (§5.5), only to agents currently `idle` (others skipped and reported);
   - launches each new agent by sending `system:create-tab` to the window whose workspace matches, `{ type: 'terminal', label: title || 'Claude', command: 'claude', args: ['--permission-mode', mode, ...(worktree ? ['--worktree', slug] : []), '-n', title, '--', prompt] }` (the `--` ends option parsing so a prompt starting with `-` is never read as a flag; `--settings` from §6.3 is inserted before it; lee.log records only the arg count for `claude` commands, never the prompt) (`title` defaults to the first 40 characters of the prompt; `slug` = title lower-cased, `[^a-z0-9-]` → `-`, max 40, plus a 4-hex suffix). Hooks are injected by §6.3 because the command's basename is `claude`. Logs `handoff.launch`;
   - activates the away state and logs `handoff.start` (counted as ceremony).

   Every step is caused by that one human click (C3).

### 7.2 Away-policy state on the queue

While `away.active`:
- New items and still-open items from sessions without a wake mark get `parked: true`, severity capped at needs-you (no age escalation, and `active_wait_ms` doesn't accrue), `notify: false`. The agent simply waits (it is already blocked on its prompt); the others keep working.
- Items with `wake: true`, or from a `pty_id` in `wake_pty_ids`, follow normal severity and get `notify: true` (outside quiet hours). Wake can be toggled later (`POST /attention/:id/wake`), including from a device.
- **Summary** (at most one per handoff):
  - `{mode:'at', at}`: at that time B creates one `summary` item (`notify: true` unless quiet hours) whose text is deterministic: `"<n> waiting (<k> parked) · <t> turns finished · <s> sessions ended since <HH:MM>"` plus up to 5 one-line agent summaries. Logs `away.summary`.
  - `{mode:'on_return'}`: no item while away; the digest shows on return.
  - `{mode:'none'}`: nothing.
- **Where the summary is delivered:** as a queue item, so it reaches the status bar (on return), Aeronaut's Now screen and Dirigible's Waiting list over `/context/stream`. Devices alert once because `notify` flips true. Nothing goes through a push service (C1).

### 7.3 Return

The away state ends when any of these happens: the first Lee keyboard/mouse input (`lee_active` false→true) while away (`reason: 'return'`), `handoffEnd()` / `POST /handoff/end` (`reason: 'manual'`), or a manual focus start in Lee. Device engagement does **not** end it. On end: unpark all items (they keep their `created_at`; severity is recomputed with the accrued `active_wait_ms`), log `handoff.end`, push `copilot:return` (IPC) and broadcast `copilot_return` with `ReturnInfo {reason:'handoff_end', …}`.

B also emits `ReturnInfo {reason:'presence'}` without a handoff when `presence.change` shows at_machine false→true with `away_ms ≥ away.return_min_away_minutes` (30). C shows the session-start digest on either (§9.1).

---

## 8. Hester side (package D)

**Single-workspace binding.** The daemon serves one workspace at a time (`POST /workspace`, `_switch_workspace` in `hester/daemon/main.py`). Everything new here takes an explicit `workspace` parameter (absolute path) and constructs its stores per request, so it works for any open window regardless of the current binding. When the parameter is absent, it uses `get_current_workspace()`. Nothing in v0/v1 requires the multi-workspace rework (v2).

New code lives in a new package `hester/daemon/copilot/`: `someday.py`, `routes.py`, `digest.py`, `retro.py`, `metrics.py`, `model_log.py`, `lee_events.py` (ingest client), `event_reader.py`, `presence.py`. The router is included from `main.py` the same way `create_workstream_router` is.

### 8.1 Someday store (replaces `hester ideas`)

Files: `<workspace>/.hester/someday/<id>.md`, one per item, created with `0600`:

```markdown
---
id: sd_20260925T141500_3fa2
created_at: 2026-09-25T14:15:00Z
status: open            # open | explored | promoted | dropped | kept
as: someday             # someday | explore
source:
  surface: aeronaut     # lee | aeronaut | dirigible | device | cli | shared
  device_id: dev_3f9a1c2b7d10
tags: []
triage: null            # {action, at, note} once triaged
---
Idea text exactly as captured.
```
`id` = `sd_` + UTC `YYYYMMDDTHHMMSS` + `_` + 4 hex. Writes are atomic (temp file + rename).

HTTP (on :9000, shared or device token):

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /someday` | `{ "text", "workspace"?, "as"?: "someday"\|"explore", "source": {"surface", "device_id"?} }` | `201 {"success": true, "data": SomedayItem}` |
| `GET /someday` | `?workspace=&status=open\|all` | `{"success": true, "data": [SomedayItem…]}` newest first |
| `POST /someday/{id}/triage` | `{ "workspace"?, "action": "explore"\|"promote"\|"drop"\|"keep", "note"? }` | `{"success": true, "data": SomedayItem}`; ingests `someday.triage` with the caller as actor |

`SomedayItem` = the frontmatter fields plus `text`. Normally Lee's `POST /capture` (§9) is the one calling `POST /someday`, passing `source` from the device principal; Hester doesn't log `capture` (Lee does).

CLI: new `hester someday capture "text" [--dir PATH] [--explore]` and `hester someday list [--dir PATH] [--all]`, writing the store directly (no daemon needed). **Delete** `hester/cli/ideas.py` and its registration in `hester/cli/main.py`. **Delete** `ProactiveWatcher.check_ideas`, `_score_ideas`, the `ideas` task loop and the `ideas_failures`/`last_ideas_check` status fields. Keep `IdeasConfig` in `proactive/models.py` so existing configs still parse, documented as ignored.

### 8.2 C1/C2 gating

Presence client (`copilot/presence.py`): `async def at_machine() -> Optional[bool]` does `GET {settings.lee_url}/presence` with the shared token, cached 10 s. It also updates its cache from `presence` messages on the existing `LeeContextClient` WebSocket (add a branch in `_listen_loop` for `type == "presence"`). If Lee is unreachable it returns `None`, which callers treat as **at the machine** (fail quiet).

**KnowledgeEngine** (`daemon/knowledge/engine.py`):
- Add `set_auto_match(enabled: bool)`; `on_lee_context` returns immediately unless enabled. Default **off**.
- The switch is `hester.proactive.knowledge_auto_match` (new field on `ProactiveConfig`, default `false`), applied from the existing `on_proactive_config_change` callback in `main.py`.
- When enabled, `_process_context_debounced` sets the model trigger to `automatic:knowledge.auto_match` before calling `router.match_knowledge` (so it's logged and counts against C2 if you're at the machine; enabling it is the user's explicit choice).
- The idle doc-gap check (`_idle_check_loop`) uses no model; it stays.

**ProactiveWatcher** (`daemon/knowledge/proactive_watcher.py`, `daemon/proactive/models.py`):
- Model-using tasks are `docs_index` (runs `hester docs index`, Gemini embeddings), `drift_check` (`hester docs drift`) and `bundles`. Their `enabled` defaults change to **`false`**.
- New `ProactiveConfig.run_while_present: bool = False`. Before each run of a model-using task, `_task_loop` checks `at_machine()`. If it is `True` or `None` and `run_while_present` is false, skip the run (log at debug level). Otherwise record a `model.call` with `op: 'subprocess'`, `trigger: {kind:'automatic', name:'proactive.<task>'}`, `location: 'cloud'`, then run.
- `devops`, `tests` and custom tasks run no model; unchanged.

Resulting defaults:

```yaml
hester:
  proactive:
    knowledge_auto_match: false   # new
    run_while_present: false      # new
    tasks:
      docs_index:  { enabled: false }   # was true
      drift_check: { enabled: false }   # was true
      bundles:     { enabled: false }   # was true
```

**Startup audit.** D must check that nothing calls a model during daemon boot (e.g. semantic tool routing embedding the tool registry). Anything that does must become lazy (on the first user request). Acceptance: two minutes of an idle daemon produce zero `model.call` events.

### 8.3 Model-call logging with trigger

`copilot/model_log.py`:

```python
current_trigger: contextvars.ContextVar[dict | None]   # {"kind": "user"|"automatic"|"unknown", "name"?, "surface"?, "request_path"?}
def set_trigger(kind: str, **fields) -> contextvars.Token
def record_model_call(*, provider: str, model: str, op: str, location: str, ok: bool, duration_ms: float | None) -> None
def install_model_call_logging() -> None   # idempotent; called once in lifespan startup
```
- `install_model_call_logging()` wraps, at class level, `google.genai.models.Models.generate_content`, `.generate_content_stream`, `.embed_content` and the `AsyncModels` equivalents, so every Gemini call in the daemon process is recorded (provider `gemini`, location `cloud`), whichever module made it.
- Ollama: add explicit `record_model_call(provider='ollama', location='local', …)` around the HTTP calls in `daemon/prepare.py` (the `/api/chat` call near line 720 and the `/api/generate` call in `OllamaGemmaClient` near line 2199).
- Trigger: an HTTP middleware sets `{kind:'user', surface: request.headers.get('X-Lee-Trigger') or 'http', request_path}` for every authenticated request. Tasks spawned from a request inherit it (asyncio copies contextvars). Background loops set `automatic` explicitly. Anything else is `unknown`, which the C1/C2 formulas count as automatic (conservative).
- Delivery: `lee_events.py` queues events and POSTs them to `{lee_url}/events/ingest` every 2 s (batch ≤ 500) with the shared token; keeps at most 2000 in memory on failure (drop oldest, warn once).
- Known gap: CLI processes that call models outside the daemon (`hester ask`, `hester docs index` run by hand) are not logged. They are user-invoked by definition.

### 8.4 Session-start digest (v1, deterministic, no model)

`GET /copilot/digest?workspace=<abs>&since=<ISO>&focus=<url-encoded JSON FocusItem>&only_related=0|1`

- `since` default: the start of the most recent away period in Lee's event log (the latest `handoff.start`, or the latest `presence.change` to `at_machine:false` that preceded a return of ≥ 30 min), else 12 h ago. Read from `~/.lee/events/` directly (`event_reader.py`; same machine, read-only).
- Response:

```json
{ "success": true, "data": {
  "generated_at": "…", "workspace": "/abs", "since": "…", "focus": null,
  "top_line": "3 wins · 2 waiting · 1 agent claim",
  "wins": [ { "kind": "commit", "title": "fix(api): …", "ref": "a1b2c3d", "at": "…", "verified": true, "related": false },
            { "kind": "merge", … }, { "kind": "decision", "title": "Answered Claude: …", "ref": "att_…", … },
            { "kind": "someday_decided", … } ],
  "agent_claims": [ { "session_id": "…", "pty_id": 12, "summary": "…", "lee_status": {…}, "at": "…", "verified": false, "related": true } ],
  "changed": { "agent_files": ["…"], "commits": 4 },
  "waiting": [ /* AttentionItems from full Lee GET /attention, compacted in Hester the way Lee's compact=1 does (no snoozed, no files/lee_status, text clipped to 280), filtered to this workspace, then capped at 25; top_line counts all */ ],
  "someday": { "open": 7, "untriaged_over_7d": 2 },
  "retro": { "due": true, "week": "2026-W39" }
} }
```
- **Verified wins only:** commits reachable from the default branch (`main`, else `master`, else the current branch) with commit time ≥ `since` (`git log --first-parent`); merges = commits with more than one parent; decisions = `attention.reply` events with `kind ∈ {decision, blocker}` in range for this workspace; Someday triage in range. "Operations passed" arrive with v2 operations. An agent's own claim ("tests pass") is always in `agent_claims` with `verified: false`, never in `wins` (spec §2.3).
- **Focus filter:** `related` is true when a win's changed files, or a claim's session files, intersect `focus.paths` (files), or the session's `pty_id` matches (agent). Related entries sort first; `only_related=1` drops the others.
- Ingests `digest.shown` (`actor` = the caller: device principal → device actor, shared → `{kind:'user', surface:'lee'}` since the renderer is the only shared-token caller of this endpoint).
- If Lee's `/attention` is unreachable, `waiting` is `[]` and `top_line` says "Lee offline".

### 8.5 Metrics (v0 item 12)

`copilot/metrics.py` implements §2.5. CLI: `hester goals metrics [--since 14d] [--until now] [--workspace PATH] [--write]` prints a table, and with `--write` appends one line to `<workspace>/.hester/goals/metrics.jsonl`:

```json
{"ts":"…","from":"…","to":"…","formula_version":2,"workspace":null,
 "metrics":{"peek_rate":1.8,"attention_latency_ms":95000,"focus_interruptions_avg":0.4, "...": "..."},
 "unavailable":["background_leverage.accepted","toil_load.command_repeats"]}
```
Deterministic; no model. `workspace: null` means machine-wide.

### 8.6 Weekly retro (v1)

- Schedule: `copilot.retro` in `~/.lee/config.yaml` (`day: fri`, `time: "16:00"` defaults; D reads it itself, Lee ignores it). It is due from that local time until answered or skipped for the ISO week.
- Storage: `~/.hester/retro/<YYYY>-W<ww>.json`:

```json
{ "week": "2026-W39", "shown_at": "…", "answered_at": "…", "skipped": false,
  "answers": { "ideas_or_plumbing": "…", "stuck_good_bad": "…", "surprise": "yes: …" },
  "wins_count": 12 }
```
- `GET /copilot/retro` → `{ week, due, answered, skipped, questions: [{id:'ideas_or_plumbing', text:'Ideas or plumbing?'}, {id:'stuck_good_bad', text:'Where were you stuck in a good way, and where in a bad way?'}, {id:'surprise', text:"Did Hester show you something about your work you didn't already know?"}], wins: [verified wins for the week] }`. Ingests `retro.shown` the first time it's returned while due. With `?peek=1` it has no side effects (never marks shown); status pollers such as Lee's retro chip use it, and only the surface that renders the retro card fetches without it.
- `POST /copilot/retro` `{ week, answers?, skipped? }` → saved file; ingests `retro.answered` with the answered question ids only. All answers optional.

---

## 9. Surfaces

### 9.1 Lee renderer (package C)

All inside the status bar, mounted from `StatusBar.tsx`. Overlays (flyout, banner, dialogs, panels) render through `ReactDOM.createPortal(…, document.body)`, so `App.tsx` is untouched. Data comes from `window.lee.copilot` (Appendix A `CopilotAPI`). Hester calls use `fetch('http://127.0.0.1:9000/…', { headers: { Authorization: 'Bearer ' + await window.lee.getApiToken() } })`, as the renderer already does; CSP allows `http://127.0.0.1:*`.

| Element | Behaviour | Calls |
|---|---|---|
| **Needs-you pill** | Outside focus: `N need you` when `counts.needs_you + counts.blocking > 0`. Click opens the flyout | `getSnapshot`, `onSnapshot` |
| **Flyout** | Items grouped: Blocking, Needs you, Recent (ambient). Each row: title, source tab label + workspace basename, age, the agent's text (labelled as the agent's words), inline actions per `item.actions`: **Approve**/**Deny** (approval), **Reply…** (inline text box, Enter sends, Shift+Enter newline), **Open**, **Snooze** (15 min / 1 h / until it changes), **Dismiss**, **Wake me** (only while away). Footer: **Focus** toggle, **Capture…**, **Hand off…** | `reply`, `snooze`, `dismiss`, `setWake`, `openItem`, `focusStart/Stop` |
| **Blocking banner** | Raised banner above the status bar for each open blocking item (newest first, one at a time, "+N more") with the same inline actions, until handled or dismissed. Shown during focus too; that is the one allowed interruption | same |
| **Focus mode** | While `focus.active`: the message slot shows only `Focus · <quiet_count> queued` (and a subtle "inferred" marker); existing Hester status messages are held (not shown, still counted in the badge); no rotating hint. Clicking offers **Stop focus** and **Stop and hand off…** | `focusStop`, `handoffProposals` |
| **Capture** | Popover with a single text field + "as exploration" checkbox; Enter captures. Toast "Captured" or "Saved; will sync when Hester is back" if `spooled` | `capture` |
| **Handoff dialog** (v1) | From `HandoffProposals`: agents (follow-up text for idle ones; "wake me" toggle each), new launches (workspace, prompt, title, worktree ✓, permission mode acceptEdits ✓), summary policy (none / when I'm back / at time), waiting items (wake toggles). **Launch** is the only commit button | `handoffProposals`, `handoffStart` |
| **Session-start digest panel** (v1) | Opens on `onReturn`, and on a manual focus start (with that focus item). On an inferred focus start it shows only a "Digest ready" chip. Leads with wins, then waiting (with inline actions), agent claims (labelled "Claude says"), Someday counts, retro. "Hester offline" if the fetch fails | Hester `GET /copilot/digest`; queue actions |
| **Weekly retro** (v1) | Card in the digest panel when `retro.due`, and a chip outside focus. Three optional text fields; **Save** and **Skip this week** | Hester `GET/POST /copilot/retro` |
| **Devices** | In `PairingDialog.tsx`: show the ticket QR (no token; ticket expiry countdown), a devices list (name, kind, paired via, last seen, **Revoke**), and **Create device token** (token shown once, copy button) | `aeronaut.getPairingQR`, `devices.list/revoke/create` |
| **Ceremony** | Dismissing an existing status message in the flyout calls `logCeremony('status_dismiss')`. Snooze/dismiss/handoff are logged by B already, so don't double-log | `logCeremony` |

No new global keyboard shortcuts in v0/v1 (they would need `App.tsx`/`shortcuts.ts`). Use existing CSS variables and existing `IconName`s; don't regenerate design tokens or icons.

### 9.2 Aeronaut (package E)

New first tab **Now** (`RootTab.now` first in the enum and bar; it becomes the default when a machine is selected, Machines otherwise), built for steering, not monitoring:

| Section | Behaviour | Endpoint |
|---|---|---|
| **Waiting** (Reply) | Live list from `attention_snapshot` WS messages (plus `GET /attention?compact=1` on connect and pull-to-refresh). Approve/Deny for approvals; Reply (text) for others; Snooze/Dismiss in a swipe or menu; Wake toggle while away. In-app banner (and haptic) when an item's `notify` flips true | Lee `GET /attention`, `POST /attention/:id/{reply,snooze,dismiss,wake}` |
| **Capture** | Text field + "exploration" toggle; picks the workspace from the selected window | Lee `POST /capture` |
| **Focus** | Small toggle showing Lee's focus state | Lee `GET /focus`, `POST /focus/start\|stop` |
| **Launch** (v1) | Hand-off sheet: summary policy, wake toggles, new agent launches | Lee `GET /handoff/proposals`, `POST /handoff/start` |
| **Wins** (v1) | Verified wins + agent claims from the digest | Hester `GET /copilot/digest?workspace=…` |

Tabs/Files/Hester stay as they are (one level down).

Pairing: the QR scanner accepts `ticket` (pairVersion 2): `POST /pair/redeem {ticket, device: <device name>, kind: 'aeronaut'}` → store `token` and new `Machine.deviceId`. If the QR has `token` (old Lee), keep today's behaviour. Handle `410` with "QR expired, show a new one on Lee". A 401 with a stored device token still shows "Token rejected. Re-pair this machine." Hester calls keep using `machine.token` (D accepts device tokens).

### 9.3 Dirigible (package F)

| Piece | Behaviour | Endpoint |
|---|---|---|
| Per-device token | The pairing grant now carries a device token and `device_id`; parse `device_id` into `PairingClient::Grant` (optional), store it in NVS next to the token, and show it in the summary card. The typed-token fallback still takes a 36-character UUID (a device token created in Lee's Devices list) | `/pair/request`, `/pair/poll` (unchanged) |
| Waiting view (new `View::Waiting`, default view after connect) | List of compact items (severity colour, title, tab label, age); header centre shows `N waiting`; header blinks when an item's `notify` flips true | WS `attention_snapshot` on the existing `/context/stream`; `GET /attention?compact=1` on connect |
| Reply | Item detail: approval → **Approve**/**Deny** keys; other kinds → text entry, Enter sends. Echo `version`; on 409, refresh | `POST /attention/:id/reply` |
| Capture | Top row of the Waiting view (and a menu entry): text entry → send | `POST /capture` |

Memory budget: compact snapshots are ≤ 25 items with text ≤ 280 characters. Parse with cJSON, and keep only id/version/kind/severity/title/text/tab_label/notify/actions per item.

---

## 10. Work packages

Each package lists files it **OWNS** (create or edit freely) and **SHARED** edits it may make (only what is listed, at the stated anchors). "Anchor" = insert immediately after the quoted existing line unless stated otherwise.

### A. `lee-core`

**OWNS (new):**
- `electron/src/main/copilot/event-log.ts` (*pure*): `EventLogWriter` (§2.4).
- `electron/src/main/copilot/presence.ts`: `PresenceTracker` (powerMonitor polling, input intake, transitions, push, broadcast).
- `electron/src/main/copilot/input-tracker.ts`: per-window `before-input-event` counting, `copilot:input` intake, tab attribution, `input.counts` / `tab.focus` / `window.focus` events.
- `electron/src/main/copilot/device-tokens.ts` (*pure*): §4.1.
- `electron/src/main/copilot/auth.ts`: §4.3; also the device attribution `finish` hook and the per-minute `device.views` aggregator (§4.5).
- `electron/src/main/copilot/core-routes.ts`: `registerCoreRoutes(app, deps)` with `POST /events/ingest`, `GET /presence`, `GET /devices`, `DELETE /devices/:id`, `POST /pair/redeem`, `POST /capture`.
- `electron/src/main/copilot/capture.ts`: capture relay to Hester `POST /someday` (shared token, `http://127.0.0.1:<hester port>`); on failure append to `~/.lee/spool/someday.jsonl` and retry every 60 s while non-empty; `capture` event.
- `electron/src/main/copilot/core.ts`: `initCopilotCore({ apiServer, ptyManager })`, `attachCopilotWindow(bw, contextBridge)`, `shutdownCopilotCore()`, plus A's IPC handlers (`copilot:presence:get`, `copilot:input`, `copilot:ceremony`, `copilot:capture`, `copilot:devices:*`). Registers the bus sink and presence provider, logs `app.start`, prunes old logs.
- The four verbatim files (Appendix A–D) and the identical edits (Appendix E).
- `electron/src/main/pairing-store.ts`: `poll(nonce, grant: (entry) => PairingGrant)`; `PairingGrant.device_id?`.

**SHARED edits:**
- `api-server.ts`:
  1. Anchor `import { ipcMain } from 'electron';` → add `import { copilotAuthMiddleware, authenticateWsToken, noteDeviceWsInput, noteDeviceView } from './copilot/auth';`, `import { registerCoreRoutes } from './copilot/core-routes';`, `import { copilotBus } from './copilot/bus';`.
  2. **Replace** the body of the auth `this.app.use((req, res, next) => { … })` block (the one starting with the comment `// Auth middleware - require Bearer token`) with `this.app.use(copilotAuthMiddleware(() => this.authToken));`. Keep the comment and update it.
  3. In `start()`, in the upgrade handler, **replace** `const token = url.searchParams.get('token'); if (token !== this.authToken) {` with a principal check via `authenticateWsToken(request, this.authToken)` (same 401 behaviour), and set `(request as any)._principal = principal;`.
  4. In the `/context/stream` connection handler, after the initial `context_update` send block, add `copilotBus.runStreamConnect((msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); });`.
  5. In `start()`, anchor `this.browserCastWss = new WebSocketServer({ noServer: true });` → add `copilotBus.setBroadcaster((msg) => { const s = JSON.stringify(msg); this.wsClients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(s); }); });`.
  6. In the PTY stream connection handler: call `noteDeviceView((request as any)._principal)` on connect and `noteDeviceWsInput((request as any)._principal)` at the top of `ws.on('message', …)`.
  7. `/pair/poll`: the grant closure receives the entry and issues a device token (§4.2).
  8. Anchor `private setupRoutes(): void {` → add `registerCoreRoutes(this.app, { getHesterPort: () => this.pairingHesterPort, getPairingName: () => this.pairingName, isPairingEnabled: () => this.pairingEnabled, log: (level, message, details) => this.ptyManager.log(level, message, details) });` (`ptyManager.log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, any>)`).
- `main.ts`:
  1. Anchor `import { APIServer } from './api-server';` → `import { initCopilotCore, attachCopilotWindow, shutdownCopilotCore, issueQrTicket } from './copilot/core';`.
  2. In `app.whenReady()`, anchor the closing `});` of `apiServer = new APIServer({ … });` → `initCopilotCore({ apiServer, ptyManager });`.
  3. In `createWindow()`, anchor `windowRegistry.register(bw, workspace || null, contextBridge);` → `attachCopilotWindow(bw, contextBridge);`.
  4. In `aeronaut:get-pairing-qr`, replace `token: apiServer.getAuthToken(),` with `...issueQrTicket(),` (returns `{ ticket, ticketExpiresIn, pairVersion: 2 }`).
  5. In `will-quit`, anchor `machineManager?.dispose();` → `shutdownCopilotCore();`.
  6. In `showPairingApprovalDialog`, after `apiServer.resolvePairing(entry.nonce, approved);` → `logEvent({ type: 'ui.ceremony', actor: { kind: 'user', surface: 'lee' }, data: { action: 'confirm', target: 'pairing' } });` (import `logEvent` from `./copilot/bus` in edit 1).

**Must not touch:** `pty-manager.ts`, anything in `src/renderer/`, B's files.

### B. `lee-queue-hooks`

**OWNS (new):**
- `electron/src/main/copilot/hook-payload.ts` (*pure*): tolerant normalisation, Notification classification, tool file extraction, signature, transcript tail reader, `parseLeeStatus(text): LeeStatusBlock | null`.
- `electron/src/main/copilot/agent-sessions.ts` (*pure*): per-session state, `session_id ↔ pty_id` map, busy accounting, pending tool, files written.
- `electron/src/main/copilot/attention-queue.ts` (*pure*): items, supersede/resolve rules, severity, notify, snapshots (full and compact).
- `electron/src/main/copilot/focus.ts` (*pure*): manual sessions, minute buckets, inference, end rules.
- `electron/src/main/copilot/away.ts` (*pure*): away state, parking, summary scheduling and text.
- `electron/src/main/copilot/reply.ts`: key constants and PTY writes.
- `electron/src/main/copilot/hook-install.ts`: writes `~/.lee/hooks/*`; exports `withClaudeHooks(cmd: string, args: string[]): string[]`.
- `electron/src/main/copilot/queue-routes.ts`: `registerQueueRoutes(app, { ptyManager })` for everything in §5.6 including `POST /agent/hook`.
- `electron/src/main/copilot/queue.ts`: `initCopilotQueue({ ptyManager })`: wiring, timers, IPC handlers (§5.7), bus subscriptions (`input.counts`, `tab.focus`, `presence.change`), `copilotBus.setFocusProvider`, `copilotBus.onStreamConnect`, PTY exit handling, and launching via `system:create-tab`.
- The verbatim files and the identical edits.

**SHARED edits:**
- `api-server.ts`: (1) anchor `import { LeeContext } from '../shared/context';` → `import { registerQueueRoutes } from './copilot/queue-routes';`; (2) at the **end** of `setupRoutes()`, after the `this.app.delete('/process/:id', …)` route's closing `});` → `registerQueueRoutes(this.app, { ptyManager: this.ptyManager });`.
- `main.ts`: (1) anchor `import { windowRegistry } from './window-registry';` → `import { initCopilotQueue } from './copilot/queue';`; (2) at the **end** of `setupIPC()`, after the `aeronaut:get-pairing-qr` handler's closing `});` → `initCopilotQueue({ ptyManager });`.
- `pty-manager.ts` (B only): (1) anchor `import { TUIDefinition, AgentDefinition } from '../shared/context';` → `import { withClaudeHooks } from './copilot/hook-install';`; (2) in `spawn()`, anchor the closing `}` of `if (!cmd) { … }` → `finalArgs = withClaudeHooks(cmd, finalArgs);`; (3) in `spawn()`, anchor the closing `}` of `if (extraEnv) { Object.assign(env, extraEnv); }` → `env.LEE_PTY_ID = String(id); if (windowId != null) env.LEE_WINDOW_ID = String(windowId); if (!env.LEE_API_URL) env.LEE_API_URL = 'http://127.0.0.1:9001';`.

**Note:** B's routes rely on `res.locals.principal` (set by A). In B's worktree, until A merges, treat a missing principal as `{kind:'shared', loopback:true, ip:'127.0.0.1'}` **only** for `/agent/hook`, and as "not human" everywhere else (403). This is correct behaviour once A lands too.

**Must not touch:** A's files, the renderer, `pairing-store.ts`.

### C. `lee-ui`

**OWNS:**
- New: `electron/src/renderer/components/copilot/` with `CopilotStatus.tsx` (entry point used by StatusBar), `AttentionFlyout.tsx`, `AttentionItemRow.tsx`, `BlockingBanner.tsx`, `FocusControl.tsx`, `CapturePopover.tsx`, `HandoffDialog.tsx`, `DigestPanel.tsx`, `RetroCard.tsx`, `DevicesList.tsx`, `copilot.css`; `electron/src/renderer/hooks/useCopilot.ts` (snapshot/presence subscription and Hester fetch helpers); `electron/src/renderer/lib/hesterCopilot.ts` (typed wrappers for §8 endpoints).
- Edit: `electron/src/renderer/components/StatusBar.tsx` (mount `<CopilotStatus workspace={workspace} … />` in `status-bar-center`; focus-mode suppression of the message slot; ceremony logging on dismiss), `electron/src/renderer/components/PairingDialog.tsx` (ticket QR, devices list).
- The verbatim `shared/copilot.ts` and `preload-copilot.ts`, and the identical edits (Appendix E), so `window.lee.copilot` typechecks.

**Stub strategy:** everything goes through `window.lee.copilot` and Hester fetches. If `window.lee.copilot` is undefined at runtime (A/B not merged), render nothing. For local development C may add a dev-only fake behind `import.meta.env.DEV && localStorage.getItem('copilotFake') === '1'` in `useCopilot.ts`, returning canned snapshots; it must be tree-shaken from production builds.

**Must not touch:** `App.tsx`, anything in `src/main/` other than the verbatim/identical-edit files, generated design tokens/icons.

### D. `hester`

**OWNS:** all of `hester/` (and a new top-level `tests/copilot/` for pytest). Specifically:
- New `hester/daemon/copilot/` (§8 files) and `hester/cli/someday.py`, `hester/cli/goals.py` (`hester goals metrics`).
- Edits: `hester/daemon/main.py` (include the router; call `install_model_call_logging()` in lifespan; trigger middleware; wire `knowledge_auto_match` in `on_proactive_config_change`; accept device tokens in `require_bearer_token`), `hester/shared/auth.py` (`device_for_token`), `hester/daemon/lee_client.py` (`presence` message branch), `hester/daemon/knowledge/engine.py`, `hester/daemon/knowledge/proactive_watcher.py`, `hester/daemon/proactive/models.py`, `hester/daemon/prepare.py` (two `record_model_call` sites), `hester/cli/main.py` (register `someday`, `goals`; remove `ideas`).
- Deletes: `hester/cli/ideas.py`, `hester/daemon/workstream/hooks.py` (+ its exports in `workstream/__init__.py`).

**Stub strategy:** Lee's `/presence`, `/attention` and `/events/ingest` may not exist yet in D's worktree. Every call must tolerate 404/connection errors (presence → `None` → treat as at the machine; attention → `[]`; ingest → buffer). Tests use fakes.

### E. `aeronaut`

**OWNS:** all of `aeronaut/`. Expected new files: `lib/models/attention.dart`, `lib/services/copilot_api.dart` (Lee copilot endpoints), `lib/providers/attention_provider.dart`, `lib/screens/now_screen.dart`, `lib/widgets/attention_tile.dart`, `lib/widgets/handoff_sheet.dart`; edits to `lib/screens/root_shell.dart`, `lib/screens/qr_scanner_screen.dart`, `lib/models/machine.dart` (`deviceId`), `lib/providers/connection_provider.dart` (route `attention_snapshot`, `presence`, `copilot_return` messages), `lib/services/hester_api.dart` (`getDigest`). Tests in `aeronaut/test/` for model parsing and QR ticket handling. Use existing generated Phosphor icons only.

### F. `dirigible`

**OWNS:** all of `dirigible/`. Expected: `core/include/dirigible/attention.hpp` + `core/src/attention.cpp` (compact snapshot model and parser; add to `platform/esp32/components/dirigible-core/CMakeLists.txt` SRCS); `LeeConnection` gains `onCopilotMessage(std::function<void(cJSON*)>)` for non-`context_update` types, `attentionReply(id, action, text, version, cb)`, `capture(text, cb)`, `fetchAttention(cb)`; `PairingClient::Grant::device_id`; NVS `device_id`; `firmware/main/screen_waiting.cpp` (+ `View::Waiting` in `app.hpp`, `CMakeLists.txt` SRCS, menu entry, default view); README section.

---

## 11. Acceptance checks

Common: `git diff --stat` shows only files your package owns, the listed shared edits, and the verbatim/identical-edit files. The verbatim files match the appendix byte for byte (re-run the extraction script: `git diff` must be empty).

### A `lee-core`
```bash
cd electron && npm run typecheck && npm run build
node -e "const {EventLogWriter}=require('./dist/main/copilot/event-log.js'); const os=require('os'),fs=require('fs'),p=require('path'); const d=fs.mkdtempSync(p.join(os.tmpdir(),'ev')); const w=new EventLogWriter({dir:d,maxFileBytes:1e6,retentionDays:180}); w.write({v:1,id:'x',ts:new Date().toISOString(),type:'app.start',source:'lee-main',workspace:null,window_id:null,actor:{kind:'system'},ctx:{at_machine:true,engaged:true,focus_session_id:null,away:false},data:{}}); w.flushSync(); console.log(fs.readdirSync(d), fs.readFileSync(p.join(d,fs.readdirSync(d)[0]),'utf8'))"
node -e "const {DeviceTokenStore}=require('./dist/main/copilot/device-tokens.js'); const s=new DeviceTokenStore(require('fs').mkdtempSync('/tmp/dv')); const {record,token}=s.issue({name:'t',kind:'test',via:'manual'}); console.log(!!s.verify(token), s.revoke(record.device_id), s.verify(token)===null)"
```
Behavioural (with `npm start`; `T=$(cat ~/.lee/api-token)`):
- `tail -f ~/.lee/events/$(date +%F).jsonl` shows `app.start`, then `tab.focus` on tab switches and `input.counts` about once a minute while typing. `grep -c '"key"' ~/.lee/events/*.jsonl` finds nothing, and no line contains typed text.
- `curl -s -H "Authorization: Bearer $T" localhost:9001/presence` → `at_machine: true`. Lock the screen → a `presence.change` with `reason: "lock"` within 5 s.
- `curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' localhost:9001/events/ingest -d '{"events":[{"type":"model.call","data":{"provider":"gemini","model":"x","op":"generate","location":"cloud","trigger":{"kind":"user"},"ok":true}}]}'` → `accepted: 1`, and the line appears with `source: "hester"`. The same request from a device token → 403.
- Pair Dirigible (or simulate `POST /pair/request` + approve + `GET /pair/poll`): the token returned ≠ `~/.lee/api-token`; `~/.lee/devices/dev_*.json` exists with only `token_sha256`; that token works on `GET /windows`; after revoke it gets 401 and its open `/context/stream` socket closes.
- QR: `pairingInfo` has `ticket`, no `token`; `POST /pair/redeem` works once, then `410`.
- `GET /windows` with the shared token still works (renderer, Hester and old devices unaffected).
- `POST /capture` with Hester down → `spooled: true` and a line in `~/.lee/spool/someday.jsonl`; start Hester → the file drains within ~60 s.

### B `lee-queue-hooks`
```bash
cd electron && npm run typecheck && npm run build
node -e "const q=require('./dist/main/copilot/hook-payload.js'); console.log(q.parseLeeStatus('done\n\`\`\`lee-status\nstatus: blocked\nsummary: x\nfiles: a.ts, b.ts\n\`\`\`'))"
```
Behavioural:
- After start: `~/.lee/hooks/claude-settings.json`, `claude-hook.sh` (0755) and `auth-header` (0600) exist. `ps -o args= -p <pid of a Claude tab>` shows `--settings …/claude-settings.json`; `ps eww` on it shows `LEE_PTY_ID`.
- Simulated Notification: `echo '{"session_id":"s1","hook_event_name":"Notification","message":"Claude needs your permission to use Bash","cwd":"/tmp"}' | LEE_PTY_ID=<a real agent pty id> sh ~/.lee/hooks/claude-hook.sh Notification` → `GET /attention` shows an `approval`; the events file has `agent.waiting` and `attention.open`.
- The same hook POSTed with a device token → 403. A reply with the shared token → 403 (C3).
- **Live check (one real session, small cost):** in a Lee Claude tab ask for something that needs a Bash permission. The approval appears in the status bar within ~1 s; **Approve** from the flyout proceeds exactly as pressing Enter in the tab; `attention.resolve` has `latency_ms`. Then let a turn finish: `agent.turn_end` has a `summary` equal to Claude's last message, and a `review` item appears. Confirm your own `~/.claude/settings.json` hooks still fire (hooks merge). Report the verified approve/deny keys.
- Reply with a stale `version` → 409; after the PTY exits → 410 and a `failure` item for non-zero exits.
- Focus: start focus on agent tab X. An approval from agent X shows the banner (blocking, `reason: focus`); one from agent Y only increments `quiet_count`; after 20 active minutes it escalates (`reason: age`). `focus.end.interruptions` matches the banners shown. Inference: type in one file for 10 minutes → `focus.start source: inferred`.
- v1: `POST /handoff/start` with one launch → a new Claude tab running `--permission-mode acceptEdits --worktree …`; new items are `parked: true, notify: false`, except wake-marked ones (`notify: true`); a summary item appears at `summary.at`; the first Lee keypress logs `handoff.end` and pushes `copilot:return`.

### C `lee-ui`
```bash
cd electron && npm run typecheck && npm run build
```
Behavioural (with A and B merged, or the dev fake): the pill appears and counts match `GET /attention`; Approve/Deny/Reply/Snooze/Dismiss/Open each work from the flyout and the banner; during focus the message slot shows only `Focus · N queued` and incoming Hester status messages are held; capture works and shows the spooled toast when Hester is down; the handoff dialog launches and closes; the digest panel opens on return and on a manual focus start, and shows "Hester offline" gracefully; the retro card saves and skips; PairingDialog shows no token, lists devices and revokes one. Check light and dark themes, and 1280 px and 800 px window widths.

### D `hester`
```bash
~/.lee/venv/bin/python -m compileall -q hester
~/.lee/venv/bin/pip install -q 'pytest>=7' 'pytest-asyncio>=0.21'   # dev extras from pyproject.toml, if missing
~/.lee/venv/bin/python -m pytest tests/copilot -q
```
Tests must cover: the Someday store (create/list/triage/atomic write, frontmatter round trip); the digest over a fixture git repo and a fixture events dir (verified wins vs claims, focus filtering, `since` detection); metrics formulas over a fixture events file (each metric in §2.5); `device_for_token` (valid, revoked, unknown, mtime cache); the ProactiveWatcher gate (model task skipped when `at_machine` is True or None, runs when False with `run_while_present` false); model-call logging (a patched genai call records trigger `user` inside a request context and `unknown` outside).
Behavioural: `hester ideas` no longer exists; `hester someday capture "x"` writes `.hester/someday/sd_*.md`; an idle daemon for 2 minutes produces **zero** `model.call` lines; a palette question produces `model.call` with `trigger.kind: "user"`; `GET /copilot/digest` answers in < 1 s on this repo; a device token works on `GET /health/deep` and `POST /context/stream`; a revoked one gets 401.

### E `aeronaut`
```bash
export PATH=$HOME/Development/flutter/bin:$PATH && cd aeronaut && flutter analyze && flutter test
```
Tests: `AttentionItem.fromJson` (compact and full), snapshot parsing, QR payload v1 (token) vs v2 (ticket) handling, `Machine` JSON round trip with `deviceId`. Behavioural (simulator against a running Lee): scan the QR → redeem → device appears in Lee's Devices list; the Now tab lists waiting items live; Approve/Reply work; capture lands in `.hester/someday/`; v1 Launch starts a handoff; Wins shows verified wins.

### F `dirigible`
```bash
source ~/Development/hardware/esp-idf/export.sh && cd dirigible/firmware && idf.py build
```
Also build `-DDIRIGIBLE_UI_DEMO=1` once to make sure the demo still compiles (don't ship it). Behavioural (on device): pair → the device shows its `device_id`; the Waiting view is the default and updates live; Approve/Deny/Reply work; capture lands in Someday; the header blinks when `notify` flips.

---

## 12. Open decisions (made here; revisit if wrong)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Definition of `at_machine` | OS-level idle (powerMonitor) + lock/suspend, not Lee-window input; `lee_active` keeps the narrower signal | C2 must hold while you type in another app next to Lee; `catch_up_time` is about returning to the machine. Spec §5.1 says "in a Lee window", so this deviates on purpose |
| 2 | Where devices get queue updates | Multiplexed onto the existing `/context/stream` WS as new `type`s, not a new socket | Every client already holds that socket and ignores unknown types (verified in all three); ESP32 memory; one fewer upgrade route in `api-server.ts` |
| 3 | Hook transport | `/bin/sh` + `curl` relay script; Lee does all parsing | No dependency on python/node on PATH; Lee-side parsing keeps the script trivial and unchanging. HTTP-type hooks exist but can't carry `LEE_PTY_ID` without less-proven env interpolation |
| 4 | Settings file per session vs per install | One static `claude-settings.json` passed with `--settings` to every Lee-launched Claude; per-session identity via `LEE_PTY_ID` env | Nothing to clean up; per-session behaviour without per-session files. Still satisfies "never edit the project's `.claude/`" |
| 5 | Approvals source | `PermissionRequest` hook in addition to `Notification` | Notification for permission prompts may fire after a delay (changelog: "idle desktop notification"); PermissionRequest fires when the dialog shows. Switchable via `copilot.hooks.permission_request` |
| 6 | Approve/deny keystrokes | Enter / Esc | Default option is "Yes"; Esc declines. Must be verified live (B acceptance) |
| 7 | Reply to a free-text prompt | Bracketed paste + Enter | Multi-line text must not submit early |
| 8 | Device token format | UUID v4 (122 bits), stored as sha256 only | Keeps Dirigible's 36-char typed-token UI; the raw token never touches disk |
| 9 | QR pairing | Single-use 10-minute ticket redeemed at `POST /pair/redeem`; no dialog | The QR on Lee's screen is proof of physical presence; the shared token no longer leaves the machine in a QR |
| 10 | Shared token | Keeps working for renderer, hooks, Hester, Spyglass and legacy devices; LAN use attributed as `legacy:<ip>`; can't reply/approve | Nothing breaks on upgrade; C3 holds structurally. Rotating it is a later step |
| 11 | Who may reply | Only `local-user` (IPC) and device principals | Hester and scripts share the shared token, so denying that token is what makes C3 enforceable |
| 12 | Capture path | Devices and renderer → Lee `POST /capture` → Hester `POST /someday`; spool on failure | Attribution and the `capture` event live in Lee's log; Someday format stays owned by Hester; nothing is lost when Hester is down |
| 13 | Someday format | One markdown file with YAML frontmatter per item | Human-readable, greppable, easy to promote into the repo later (§12 "promoted on request") |
| 14 | Model-call logging | Class-level wrap of `google.genai` Models/AsyncModels + explicit Ollama sites + contextvar trigger | One choke point covers ~15 call sites; conservative `unknown` counts as automatic |
| 15 | C1/C2 defaults | Knowledge auto-match off; model-using proactive tasks off; when enabled, they run only while not at the machine (unless `run_while_present`) | Spec §14 "gate both behind a user action or an explicit setting" |
| 16 | Retro storage | `~/.hester/retro/<week>.json` (machine-wide) | The retro is about the operator's week, not one workspace. `~/.hester/` already exists (pid file) |
| 17 | Waiting limit | 20 min, machine-wide config, not per agent/lead | Spec default; per-agent limits stay an open question (§16) |
| 18 | Focus inference | 7 of the last 10 minutes active, all on one item; ends on 3 minutes elsewhere or 5 minutes away | Deterministic, cheap, tunable in config |
| 19 | Handoff launches | `claude --permission-mode acceptEdits --worktree <slug>` via `system:create-tab` | The `delegate` lead (spec §2.2) without new tab plumbing; hooks attach through the same `spawn()` path |
| 20 | Status bar vs `StatusMessage` extension | The queue has its own pill/flyout/banner; `StatusMessage` gets no `severity`/`actions` fields yet | Spec §9's extension exists for lint (v2); adding it now would touch `App.tsx` for no v0 benefit |
| 21 | Event log time zones | File per local date, `ts` in UTC | Humans browse by local day; computation uses UTC |
| 22 | Metrics computation | In v0 (D), deterministic CLI writing `.hester/goals/metrics.jsonl` | The v0 success test needs a baseline within v0 |
| 23 | Workspace for machine-wide Lee → Hester calls | Explicit `workspace` param on every new Hester endpoint | Keeps v0/v1 independent of the single-workspace binding (§13 caveat) |

**Known gaps, accepted for v0/v1:** keystrokes inside browser `<webview>` tabs; Claude launched by hand in a terminal or through `shell: true` isn't hooked; `toil_load`'s command-repeat part needs shell integration; `background_leverage` "accepted" needs v2 tasks; model calls from standalone CLI processes aren't logged; Aeronaut can't alert while iOS has suspended it (pull-first by design, C1).

---
## Appendix A: `electron/src/shared/copilot.ts` (verbatim)

Types, IPC channel names and the `window.lee.copilot` interface. Imported by main, preload and renderer.

<!-- FILE: electron/src/shared/copilot.ts -->
```ts
/**
 * Copilot v0/v1 shared contract.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix A).
 * This file is copied VERBATIM from that document by every work package that
 * needs it. Do not edit it inside a work package; change the contract instead.
 */

// ---------------------------------------------------------------------------
// Actors and principals
// ---------------------------------------------------------------------------

/** Who caused an event. Written into every event-log line. */
export type Actor =
  | { kind: 'user'; surface: 'lee' }
  | { kind: 'user'; surface: 'device'; device_id: string; device_kind: string }
  | { kind: 'agent'; provider: string; session_id: string | null; pty_id: number | null }
  | { kind: 'hester' }
  | { kind: 'system' };

/** Who is calling Lee main. HTTP principals are set by the auth middleware on res.locals.principal. */
export type Principal =
  /** The renderer, over IPC. Never produced by HTTP. */
  | { kind: 'local-user' }
  /** The shared ~/.lee/api-token: Hester, hook script, CLI scripts, Spyglass, legacy devices. */
  | { kind: 'shared'; loopback: boolean; ip: string }
  /** A paired device with its own token (~/.lee/devices/). */
  | { kind: 'device'; device_id: string; name: string; device_kind: string; ip: string };

// ---------------------------------------------------------------------------
// Event log (~/.lee/events/YYYY-MM-DD.jsonl)
// ---------------------------------------------------------------------------

export type LeeEventType =
  | 'app.start'
  | 'app.quit'
  | 'window.focus'
  | 'tab.focus'
  | 'input.counts'
  | 'presence.change'
  | 'device.paired'
  | 'device.revoked'
  | 'device.request'
  | 'device.views'
  | 'capture'
  | 'ui.ceremony'
  | 'agent.session_start'
  | 'agent.prompt'
  | 'agent.tool'
  | 'agent.waiting'
  | 'agent.turn_end'
  | 'agent.session_end'
  | 'agent.exit'
  | 'attention.open'
  | 'attention.update'
  | 'attention.escalate'
  | 'attention.reply'
  | 'attention.resolve'
  | 'attention.snooze'
  | 'attention.dismiss'
  | 'attention.wake'
  | 'focus.start'
  | 'focus.item'
  | 'focus.end'
  | 'handoff.start'
  | 'handoff.launch'
  | 'away.summary'
  | 'handoff.end'
  | 'model.call'
  | 'someday.triage'
  | 'digest.shown'
  | 'retro.shown'
  | 'retro.answered';

export type EventSource = 'lee-main' | 'renderer' | 'hook' | 'hester' | 'device';

/** Presence/focus snapshot stamped onto every event at write time. */
export interface EventContext {
  at_machine: boolean;
  engaged: boolean;
  focus_session_id: string | null;
  away: boolean;
}

export interface LeeEvent<T = Record<string, unknown>> {
  v: 1;
  id: string;
  /** ISO 8601 UTC with milliseconds, stamped by Lee main when the line is written. */
  ts: string;
  type: LeeEventType;
  source: EventSource;
  workspace: string | null;
  window_id: number | null;
  actor: Actor;
  ctx: EventContext;
  data: T;
}

export interface LeeEventInput<T = Record<string, unknown>> {
  type: LeeEventType;
  source?: EventSource;
  workspace?: string | null;
  window_id?: number | null;
  actor?: Actor;
  data: T;
}

// ---------------------------------------------------------------------------
// Presence and engagement
// ---------------------------------------------------------------------------

export interface PresenceState {
  /** OS-level keyboard/mouse input within presence.at_machine_idle_seconds and screen not locked. Gates local compute (C2). */
  at_machine: boolean;
  /** Keyboard/mouse input in a Lee window within presence.lee_active_seconds. */
  lee_active: boolean;
  /** Any human action from any surface (Lee input or device request) within presence.engaged_seconds. */
  engaged: boolean;
  engaged_via: 'lee' | 'device' | null;
  engaged_device_id: string | null;
  locked: boolean;
  last_lee_input_at: string | null;
  last_engaged_at: string | null;
  /** When at_machine last became false; null while at the machine. */
  away_since: string | null;
  /** When the current at_machine value began. */
  since: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  device_id: string;
  name: string;
  kind: string;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  paired_via: 'code' | 'qr' | 'manual';
  revoked_at: string | null;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureRequest {
  text: string;
  /** Absolute workspace path; must be an open window's workspace. Default: focused window's workspace. */
  workspace?: string | null;
  /** 'explore' marks it as the seed of an exploration (tag only in v0). */
  as?: 'someday' | 'explore';
}

export interface CaptureResult {
  success: boolean;
  someday_id?: string | null;
  /** True when Hester was unreachable and the capture was spooled for later delivery. */
  spooled?: boolean;
  error?: string;
}

export type CeremonyAction =
  | 'confirm'
  | 'dismiss'
  | 'snooze'
  | 'assign'
  | 'required_field'
  | 'status_dismiss'
  | 'dialog';

// ---------------------------------------------------------------------------
// Attention queue
// ---------------------------------------------------------------------------

export type AttentionKind =
  | 'approval' // agent is showing a permission prompt
  | 'waiting' // agent is idle at its prompt waiting on you
  | 'blocker' // agent reported lee-status: blocked
  | 'decision' // agent reported lee-status: waiting (a question for you)
  | 'failure' // agent process exited non-zero
  | 'review' // agent finished a turn (ambient)
  | 'summary'; // away-policy summary (v1)

export type AttentionSeverity = 'ambient' | 'needs-you' | 'blocking';

export type AttentionState = 'open' | 'snoozed' | 'resolved' | 'dismissed';

export type AttentionActionName = 'approve' | 'deny' | 'reply' | 'open' | 'snooze' | 'dismiss' | 'wake';

export interface LeeStatusBlock {
  status: 'done' | 'in-progress' | 'blocked' | 'waiting' | null;
  summary: string | null;
  blockers: string | null;
  files: string[];
  next: string | null;
}

export interface AttentionSource {
  kind: 'agent' | 'lee';
  provider: string | null;
  session_id: string | null;
  pty_id: number | null;
  window_id: number | null;
  tab_id: number | null;
  tab_label: string | null;
  workspace: string | null;
  cwd: string | null;
}

export interface AttentionItem {
  id: string;
  /** Bumped on every change; replies must echo it (stale replies get 409). */
  version: number;
  kind: AttentionKind;
  severity: AttentionSeverity;
  state: AttentionState;
  /** Held by the away policy (v1). */
  parked: boolean;
  /** "Wake me for this" (v1). */
  wake: boolean;
  /** True when this item may alert a device right now (see section 5.4). */
  notify: boolean;
  related_to_focus: boolean;
  created_at: string;
  updated_at: string;
  /** Time spent waiting, excluding time while the away policy was active. */
  active_wait_ms: number;
  /** Short line, e.g. "Claude wants to run Bash". */
  title: string;
  /** The agent's own words (verbatim, max 2000 chars; max 280 in compact form). */
  text: string;
  source: AttentionSource;
  /** Files the agent session wrote (max 50). Omitted in compact form. */
  files?: string[];
  /** Pending tool for approvals: name and a short preview (max 200 chars). Never written to the event log. */
  tool?: { name: string; preview: string; signature: string } | null;
  lee_status?: LeeStatusBlock | null;
  actions: AttentionActionName[];
  snoozed_until?: string | null;
}

export type FocusItem =
  | { kind: 'agent'; pty_id: number; window_id: number | null; label: string }
  | { kind: 'files'; workspace: string | null; paths: string[] }
  | { kind: 'workspace'; workspace: string };

export interface FocusState {
  active: boolean;
  session_id: string | null;
  source: 'manual' | 'inferred' | null;
  started_at: string | null;
  item: FocusItem | null;
  /** Non-blocking items held during this session. */
  quiet_count: number;
}

export type SummaryPolicy = { mode: 'none' } | { mode: 'on_return' } | { mode: 'at'; at: string };

export interface AwayState {
  active: boolean;
  handoff_id: string | null;
  started_at: string | null;
  summary: SummaryPolicy;
  summary_delivered: boolean;
  wake_item_ids: string[];
  wake_pty_ids: number[];
  parked_count: number;
}

export interface AttentionSnapshot {
  items: AttentionItem[];
  counts: { blocking: number; needs_you: number; ambient: number; parked: number };
  focus: FocusState;
  away: AwayState;
  generated_at: string;
}

export interface ReplyRequest {
  action: 'approve' | 'deny' | 'text';
  /** Required when action is 'text'. */
  text?: string;
  /** Must equal the item's current version. */
  version: number;
}

export interface SnoozeRequest {
  /** ISO time, or 'change' (until the item changes). Exactly one of until/minutes. */
  until?: string;
  minutes?: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  item?: AttentionItem;
}

export interface HandoffAgent {
  pty_id: number;
  window_id: number | null;
  tab_id: number | null;
  label: string;
  provider: string;
  workspace: string | null;
  state: 'busy' | 'idle' | 'waiting' | 'unknown';
  last_summary: string | null;
}

export interface HandoffProposals {
  agents: HandoffAgent[];
  waiting: AttentionItem[];
  workspaces: string[];
  default_summary: SummaryPolicy;
}

export interface HandoffLaunch {
  workspace: string;
  prompt: string;
  title?: string;
  worktree: boolean;
  permission_mode: 'acceptEdits' | 'default' | 'plan';
}

export interface HandoffRequest {
  followups: Array<{ pty_id: number; text: string }>;
  launch: HandoffLaunch[];
  summary: SummaryPolicy;
  wake: { item_ids: string[]; pty_ids: number[] };
  note?: string;
}

export interface HandoffResult {
  success: boolean;
  away?: AwayState;
  launched?: number;
  error?: string;
}

export interface ReturnInfo {
  reason: 'handoff_end' | 'presence';
  away_since: string;
  returned_at: string;
  away_ms: number;
  handoff_id: string | null;
}

/** Messages multiplexed onto the existing ws://:9001/context/stream socket. */
export type CopilotStreamMessage =
  | { type: 'attention_snapshot'; data: AttentionSnapshot }
  | { type: 'presence'; data: PresenceState }
  | { type: 'copilot_return'; data: ReturnInfo };

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const COPILOT_IPC = {
  /** send, renderer to main: InputBatch (mouse clicks and wheel events, counts only). */
  input: 'copilot:input',
  /** send, renderer to main: { action: CeremonyAction; target?: string }. */
  ceremony: 'copilot:ceremony',
  presenceGet: 'copilot:presence:get',
  /** main to renderer: PresenceState. */
  presencePush: 'copilot:presence',
  capture: 'copilot:capture',
  devicesList: 'copilot:devices:list',
  devicesRevoke: 'copilot:devices:revoke',
  devicesCreate: 'copilot:devices:create',
  snapshotGet: 'copilot:attention:get',
  /** main to renderer: AttentionSnapshot. */
  snapshotPush: 'copilot:attention',
  reply: 'copilot:attention:reply',
  snooze: 'copilot:attention:snooze',
  dismiss: 'copilot:attention:dismiss',
  wake: 'copilot:attention:wake',
  open: 'copilot:attention:open',
  focusStart: 'copilot:focus:start',
  focusStop: 'copilot:focus:stop',
  handoffProposals: 'copilot:handoff:proposals',
  handoffStart: 'copilot:handoff:start',
  handoffEnd: 'copilot:handoff:end',
  /** main to renderer: ReturnInfo. */
  returnPush: 'copilot:return',
} as const;

export interface InputBatch {
  clicks: number;
  wheels: number;
  span_ms: number;
}

export type CopilotUnsubscribe = () => void;

/** window.lee.copilot */
export interface CopilotAPI {
  // Package A (lee-core)
  getPresence: () => Promise<PresenceState>;
  onPresence: (cb: (presence: PresenceState) => void) => CopilotUnsubscribe;
  logCeremony: (action: CeremonyAction, target?: string) => void;
  capture: (req: CaptureRequest) => Promise<CaptureResult>;
  devices: {
    list: () => Promise<DeviceInfo[]>;
    revoke: (deviceId: string) => Promise<{ success: boolean; error?: string }>;
    create: (name: string, kind: string) => Promise<{ success: boolean; device?: DeviceInfo; token?: string; error?: string }>;
  };
  // Package B (lee-queue-hooks)
  getSnapshot: () => Promise<AttentionSnapshot>;
  onSnapshot: (cb: (snapshot: AttentionSnapshot) => void) => CopilotUnsubscribe;
  reply: (itemId: string, req: ReplyRequest) => Promise<ActionResult>;
  snooze: (itemId: string, req: SnoozeRequest) => Promise<ActionResult>;
  dismiss: (itemId: string) => Promise<ActionResult>;
  setWake: (itemId: string, wake: boolean) => Promise<ActionResult>;
  openItem: (itemId: string) => Promise<ActionResult>;
  focusStart: (item?: FocusItem | null) => Promise<FocusState>;
  focusStop: () => Promise<FocusState>;
  handoffProposals: () => Promise<HandoffProposals>;
  handoffStart: (req: HandoffRequest) => Promise<HandoffResult>;
  handoffEnd: () => Promise<AwayState>;
  onReturn: (cb: (info: ReturnInfo) => void) => CopilotUnsubscribe;
}
```

## Appendix B: `electron/src/main/copilot/bus.ts` (verbatim)

In-process seam between A and B: event logging, presence/focus providers, stream broadcast.

<!-- FILE: electron/src/main/copilot/bus.ts -->
```ts
/**
 * Copilot bus: the in-process seam between work packages A (lee-core) and
 * B (lee-queue-hooks). Neither package imports the other's modules; both
 * import this file.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix B).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * - Package A registers the event sink (the JSONL writer), the presence
 *   provider and the WebSocket broadcaster.
 * - Package B registers the focus/away provider and stream-connect handlers.
 * - Anyone may call logEvent(); anyone may subscribe to 'event'.
 *
 * Electron-free on purpose, so modules built on it can be smoke-tested with
 * plain node.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type {
  Actor,
  CopilotStreamMessage,
  EventContext,
  LeeEvent,
  LeeEventInput,
  PresenceState,
} from '../../shared/copilot';

export interface EventSink {
  write(event: LeeEvent): void;
}

export interface FocusContextProvider {
  (): { focus_session_id: string | null; away: boolean };
}

type StreamSend = (msg: CopilotStreamMessage) => void;

const MAX_PENDING = 5000;

class CopilotBus extends EventEmitter {
  private sink: EventSink | null = null;
  private pending: LeeEvent[] = [];
  private presenceProvider: (() => PresenceState) | null = null;
  private focusProvider: FocusContextProvider | null = null;
  private broadcaster: StreamSend | null = null;
  private connectHandlers: Array<(send: StreamSend) => void> = [];
  private seq = 0;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Package A: install the event-log writer. Flushes anything logged earlier. */
  setEventSink(sink: EventSink | null): void {
    this.sink = sink;
    if (sink && this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const e of queued) sink.write(e);
    }
  }

  /** Package A: current presence. */
  setPresenceProvider(fn: (() => PresenceState) | null): void {
    this.presenceProvider = fn;
  }

  getPresence(): PresenceState | null {
    try {
      return this.presenceProvider ? this.presenceProvider() : null;
    } catch {
      return null;
    }
  }

  /** Package B: current focus session and away flag. */
  setFocusProvider(fn: FocusContextProvider | null): void {
    this.focusProvider = fn;
  }

  private context(): EventContext {
    const p = this.getPresence();
    let focus: { focus_session_id: string | null; away: boolean } = { focus_session_id: null, away: false };
    try {
      if (this.focusProvider) focus = this.focusProvider();
    } catch {
      // keep defaults
    }
    return {
      at_machine: p ? p.at_machine : true,
      engaged: p ? p.engaged : true,
      focus_session_id: focus.focus_session_id,
      away: focus.away,
    };
  }

  /**
   * Stamp and record an event. Emits 'event' synchronously (listeners must not
   * throw) and hands the line to the sink, or queues it until a sink exists.
   */
  logEvent<T = Record<string, unknown>>(input: LeeEventInput<T>): LeeEvent<T> {
    const now = Date.now();
    const actor: Actor = input.actor ?? { kind: 'system' };
    const event: LeeEvent<T> = {
      v: 1,
      id: `${now.toString(36)}-${(this.seq++).toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      ts: new Date(now).toISOString(),
      type: input.type,
      source: input.source ?? 'lee-main',
      workspace: input.workspace ?? null,
      window_id: input.window_id ?? null,
      actor,
      ctx: this.context(),
      data: input.data,
    };
    const generic = event as unknown as LeeEvent;
    if (this.sink) {
      try {
        this.sink.write(generic);
      } catch (err) {
        console.error('[copilot] event sink failed:', err);
      }
    } else {
      this.pending.push(generic);
      if (this.pending.length > MAX_PENDING) this.pending.shift();
    }
    try {
      this.emit('event', generic);
    } catch (err) {
      console.error('[copilot] event listener failed:', err);
    }
    return event;
  }

  /** Package A: how to push a message to every /context/stream client. */
  setBroadcaster(fn: StreamSend | null): void {
    this.broadcaster = fn;
  }

  /** Push a message to every /context/stream WebSocket client (devices, Hester). */
  broadcast(msg: CopilotStreamMessage): void {
    if (!this.broadcaster) return;
    try {
      this.broadcaster(msg);
    } catch (err) {
      console.error('[copilot] broadcast failed:', err);
    }
  }

  /** Package B (and A): send an initial message to each newly connected stream client. */
  onStreamConnect(handler: (send: StreamSend) => void): void {
    this.connectHandlers.push(handler);
  }

  /** Called by the API server for each new /context/stream connection. */
  runStreamConnect(send: StreamSend): void {
    for (const h of this.connectHandlers) {
      try {
        h(send);
      } catch (err) {
        console.error('[copilot] stream connect handler failed:', err);
      }
    }
  }
}

export const copilotBus = new CopilotBus();

export function logEvent<T = Record<string, unknown>>(input: LeeEventInput<T>): LeeEvent<T> {
  return copilotBus.logEvent(input);
}
```

## Appendix C: `electron/src/main/copilot/config.ts` (verbatim)

Machine-wide `copilot:` settings with defaults. Example `~/.lee/config.yaml` block: `copilot: { attention: { waiting_limit_minutes: 20, quiet_hours: "22:00-08:00" }, hooks: { permission_request: true } }`.

<!-- FILE: electron/src/main/copilot/config.ts -->
```ts
/**
 * Machine-wide Copilot settings: the `copilot:` block of ~/.config/lee/config.yaml
 * and ~/.lee/config.yaml (later wins), deep-merged over COPILOT_DEFAULTS.
 * Workspace .lee/config.yaml files are NOT consulted: the queue, presence and
 * event log are machine-wide.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix C).
 * Copied VERBATIM. Do not edit inside a work package.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface CopilotConfig {
  enabled: boolean;
  presence: {
    at_machine_idle_seconds: number;
    lee_active_seconds: number;
    engaged_seconds: number;
  };
  attention: {
    waiting_limit_minutes: number;
    /** "HH:MM-HH:MM" local time, may wrap midnight; null = none. */
    quiet_hours: string | null;
    review_expiry_hours: number;
  };
  focus: {
    infer_enabled: boolean;
    infer_window_minutes: number;
    infer_min_active_minutes: number;
    switch_minutes: number;
    manual_end_away_minutes: number;
    inferred_end_away_minutes: number;
  };
  hooks: {
    claude: boolean;
    permission_request: boolean;
    lee_status_hint: boolean;
  };
  event_log: {
    retention_days: number;
    max_file_mb: number;
  };
  away: {
    return_min_away_minutes: number;
  };
}

export const COPILOT_DEFAULTS: CopilotConfig = {
  enabled: true,
  presence: {
    at_machine_idle_seconds: 300,
    lee_active_seconds: 120,
    engaged_seconds: 300,
  },
  attention: {
    waiting_limit_minutes: 20,
    quiet_hours: null,
    review_expiry_hours: 12,
  },
  focus: {
    infer_enabled: true,
    infer_window_minutes: 10,
    infer_min_active_minutes: 7,
    switch_minutes: 3,
    manual_end_away_minutes: 15,
    inferred_end_away_minutes: 5,
  },
  hooks: {
    claude: true,
    permission_request: true,
    lee_status_hint: true,
  },
  event_log: {
    retention_days: 180,
    max_file_mb: 50,
  },
  away: {
    return_min_away_minutes: 30,
  },
};

const CACHE_MS = 30_000;
let cached: { at: number; value: CopilotConfig } | null = null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (!(k in out)) continue; // unknown keys are ignored
    const cur = out[k];
    if (isPlainObject(cur)) out[k] = merge(cur, v);
    else if (v === null || typeof v === typeof cur || cur === null) out[k] = v;
  }
  return out as T;
}

function readBlock(file: string): unknown {
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    return isPlainObject(doc) ? doc.copilot : undefined;
  } catch {
    return undefined;
  }
}

/** Current machine-wide copilot config (cached for 30 s). */
export function getCopilotConfig(): CopilotConfig {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const home = os.homedir();
  let value: CopilotConfig = COPILOT_DEFAULTS;
  for (const file of [
    path.join(home, '.config', 'lee', 'config.yaml'),
    path.join(home, '.lee', 'config.yaml'),
  ]) {
    const block = readBlock(file);
    if (block !== undefined) value = merge(value, block);
  }
  cached = { at: now, value };
  return value;
}

/** Drop the cache (e.g. after the global config is saved). */
export function invalidateCopilotConfig(): void {
  cached = null;
}

/** True if `date` falls inside quiet hours ("22:00-08:00", local time). */
export function inQuietHours(date: Date = new Date(), cfg: CopilotConfig = getCopilotConfig()): boolean {
  const spec = cfg.attention.quiet_hours;
  if (!spec) return false;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const cur = date.getHours() * 60 + date.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
```

## Appendix D: `electron/src/main/preload-copilot.ts` (verbatim)

Preload implementation of `CopilotAPI` plus the mouse-input reporter.

<!-- FILE: electron/src/main/preload-copilot.ts -->
```ts
/**
 * window.lee.copilot: the renderer half of the Copilot IPC contract, plus the
 * mouse-input reporter (counts only, never targets or content).
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix D).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * Compiled by tsconfig.main.json (no DOM lib), so DOM access goes through a
 * minimal structural type on globalThis.
 */

import { ipcRenderer } from 'electron';
import { COPILOT_IPC } from '../shared/copilot';
import type {
  AttentionSnapshot,
  CeremonyAction,
  CopilotAPI,
  InputBatch,
  PresenceState,
  ReturnInfo,
} from '../shared/copilot';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

type ListenerTarget = {
  addEventListener?: (type: string, cb: () => void, opts?: { capture?: boolean; passive?: boolean }) => void;
};

/** Batch mouse clicks and wheel events; send at most one IPC per second while active. */
function installInputReporter(): void {
  const target = globalThis as unknown as ListenerTarget;
  if (typeof target.addEventListener !== 'function') return;
  let clicks = 0;
  let wheels = 0;
  let first = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (clicks === 0 && wheels === 0) return;
    const batch: InputBatch = { clicks, wheels, span_ms: Date.now() - first };
    clicks = 0;
    wheels = 0;
    ipcRenderer.send(COPILOT_IPC.input, batch);
  };
  const bump = (kind: 'click' | 'wheel') => {
    if (clicks === 0 && wheels === 0) first = Date.now();
    if (kind === 'click') clicks++;
    else wheels++;
    if (!timer) timer = setTimeout(flush, 1000);
  };
  const opts = { capture: true, passive: true };
  target.addEventListener('mousedown', () => bump('click'), opts);
  target.addEventListener('wheel', () => bump('wheel'), opts);
}

installInputReporter();

export const copilotApi: CopilotAPI = {
  getPresence: () => ipcRenderer.invoke(COPILOT_IPC.presenceGet),
  onPresence: (cb) => subscribe<PresenceState>(COPILOT_IPC.presencePush, cb),
  logCeremony: (action: CeremonyAction, target?: string) =>
    ipcRenderer.send(COPILOT_IPC.ceremony, { action, target }),
  capture: (req) => ipcRenderer.invoke(COPILOT_IPC.capture, req),
  devices: {
    list: () => ipcRenderer.invoke(COPILOT_IPC.devicesList),
    revoke: (deviceId) => ipcRenderer.invoke(COPILOT_IPC.devicesRevoke, deviceId),
    create: (name, kind) => ipcRenderer.invoke(COPILOT_IPC.devicesCreate, name, kind),
  },
  getSnapshot: () => ipcRenderer.invoke(COPILOT_IPC.snapshotGet),
  onSnapshot: (cb) => subscribe<AttentionSnapshot>(COPILOT_IPC.snapshotPush, cb),
  reply: (itemId, req) => ipcRenderer.invoke(COPILOT_IPC.reply, itemId, req),
  snooze: (itemId, req) => ipcRenderer.invoke(COPILOT_IPC.snooze, itemId, req),
  dismiss: (itemId) => ipcRenderer.invoke(COPILOT_IPC.dismiss, itemId),
  setWake: (itemId, wake) => ipcRenderer.invoke(COPILOT_IPC.wake, itemId, wake),
  openItem: (itemId) => ipcRenderer.invoke(COPILOT_IPC.open, itemId),
  focusStart: (item) => ipcRenderer.invoke(COPILOT_IPC.focusStart, item ?? null),
  focusStop: () => ipcRenderer.invoke(COPILOT_IPC.focusStop),
  handoffProposals: () => ipcRenderer.invoke(COPILOT_IPC.handoffProposals),
  handoffStart: (req) => ipcRenderer.invoke(COPILOT_IPC.handoffStart, req),
  handoffEnd: () => ipcRenderer.invoke(COPILOT_IPC.handoffEnd),
  onReturn: (cb) => subscribe<ReturnInfo>(COPILOT_IPC.returnPush, cb),
};
```

## Appendix E: identical edits (A, B and C apply exactly these)

Apply character for character; git merges identical changes cleanly. No other edits to these two files.

**`electron/src/shared/lee-api.ts`**

1. Immediately after the line
   `import type { LeeContext, TUIDefinition, AgentDefinition, MachineConfig } from './context';`
   insert the line
   `import type { CopilotAPI } from './copilot';`
2. Inside `export interface LeeAPI {`, immediately after the closing `  };` of the `aeronaut: { … }` member (the last member), insert these two lines:
   ```ts
     /** Copilot v0/v1 (docs/plans/2026-09-25-copilot-v0-v1-contracts.md). */
     copilot: CopilotAPI;
   ```

**`electron/src/main/preload.ts`**

1. Immediately after the line `} from '../shared/lee-api';` that closes the **first** import block (the one listing `StatusMessagePayload,`), insert the line
   `import { copilotApi } from './preload-copilot';`
2. Inside `const api: LeeAPI = {`, immediately after the closing `  },` of the `aeronaut: { … }` member (the last member, just before `};`), insert the line
   `  copilot: copilotApi,`

---

