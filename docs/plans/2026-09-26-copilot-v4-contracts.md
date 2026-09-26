# Copilot v4: Goals and steward

> **Status:** Contract, 2026-09-26
> **Spec:** [`docs/13-Copilot.md`](../13-Copilot.md) §2.2–§2.3, §3, §5 (ordering), §6.0 (Launcher), §7.3, §8, §10 (all families), §15 v4 · **Goals:** [`GOALS.md`](../../GOALS.md)
> **Builds on:** v0/v1, v2 and v3 contracts (`docs/plans/2026-09-2*-copilot-*.md`).
> **Packages:** **P** (Python: `hester/`, `tests/`, docs), **M** (Lee main: `electron/src/main/**`, `electron/src/shared/**`, `electron/scripts/**`), **R** (renderer: `electron/src/renderer/**`). They share only this document. `electron/src/shared/*` is **M's**: M adds the §9 types first, verbatim, and R imports them without editing shared files.

## 0. Scope and goal check

This contract covers everything in §15 v4, plus the hygiene and scope lint families, which §1.2 places anywhere from v2 to v4:
- the Goals section and Evaluate, with Define/update (guided edit → diff → apply) and Build toward
- quadrants as ordering, with overrides
- the `human_balance` metric and strip
- steward mode, with `surface`, `steward.md`, What next?, launch suggestions, lint-ask, and rail ask/steer (show text first)
- Not today and `hester.steward`
- the one-line Q4 note in the Launcher
- lint: hygiene, scope, attention, agent-use, and project rules; the `git_watcher` and doc-gap hints move into lint
- workstreams: `serves`, soft phases, and trade-offs on decisions
- digest Q2 candidates
- History goal impact

**Two-sided check:**

| Part | Moves | Costs |
|---|---|---|
| Goals section, Evaluate, What next? | G3 `pull_usage` ↑ (all are pulls) and `human_balance` ↑ | Cloud spend, on demand only (C1 is held because each call is a user action) |
| Quadrant ordering | G2 `attention_latency` ↓ for Q1 | None |
| Steward pushback | `human_balance` ↑ | Nudges (G3 vs flow). It speaks only when asked; overrides are recorded and quiet it |
| Q4 note | `human_balance` ↑ | One line, no required action, Enter still launches (toil_load unchanged) |
| Lint families | `toil_load` ↓ via fixes, `nudge_acceptance` measured | Nudges: each rule demotes itself if ignored, and attention and agent rules are steward-gated |

**Invariants:**
- C2: no model runs unless a request handler was triggered by a user action. Lint, the quadrant, `human_balance`, Q2 candidates and the evidence packet are all deterministic.
- C3: Hester never types into a tab, edits GOALS.md or runs anything without a click. A steer shows the exact text first.
- No typed reason is ever required.

## 1. GOALS.md parsing (P, `hester/daemon/cockpit/goals.py`)

`parse_goals_full(text) -> {goals, constraints, tensions}`, tolerant of the current file shape.
- **Goals:** one per `### G<n> <title>` under any heading, in file order, with `priority` = index (0 = top).
  - `prose` is the paragraph text before the first metric (≤ 1500 chars).
  - `metrics` come from `- metric: **<name>**: <description>` bullets. Nested `- <key>: <value>` lines fill `kind`, `signal`, `available`, `target`, `guard` and `measure` (`op:<name>`, optional).
- **Constraints:** `- **C<n> <title>.** <text>` with nested `telemetry`, `available` and `target`. A target is written inside the telemetry line as "Target: 0" and is parsed from it.
- **Tensions:** `- **<A> vs <B> (<label>):** <text>` bullets, carrying `arbiter` (the text after `Arbiter:`) and `default` (the text after `Default:`, up to `Arbiter:`).
- `load_goals()` and `GET /cockpit/goals` stay unchanged for the link picker.

**Targets** are parsed into `{direction: 'falling'|'rising'|null, op: '>='|'<='|'>'|'<'|null, value: number|null, unit: '%'|null}`:
- `falling` and `rising` become a direction.
- `≥ 50%` becomes `{op:'>=', value:0.5, unit:'%'}`, since shares are stored as 0–1.
- `≤ 1 per session` becomes `{op:'<=', value:1}`.
- Anything else is `{direction:null, op:null}` and is shown verbatim.

## 2. Goal status (P)

`GET /cockpit/goals/status?days=7` returns:

```jsonc
{
  "generated_at": "...", "days": 7,
  "goals": [{
    "id": "G1", "title": "...", "priority": 0, "prose": "...",
    "metrics": [{ "name": "peek_rate", "kind": "runnable", "target_text": "falling", "target": {...},
                  "value": 1.2, "previous": 1.9, "trend": "down" | "up" | "flat" | null,
                  "ok": true | false | null, "source": "metrics" | "reading" | "judged" | null,
                  "at": "...", "available": "..." }],
    "serving": { "tasks": [{id, title, status, quadrant}], "workstreams": [{id, title, phase}], "explorations": [{id, title}] },
    "flagged": true,               // nothing serving AND at least one metric ok === false or trending the wrong way
    "last_evaluated_at": "..." | null,
    "focus_ms_7d": 123000          // from human_balance_by_goal
  }],
  "constraints": [{ "id": "C1", "title": "...", "violations": 0 | null }],
  "tensions": [{ "a": "G1", "b": "G2", "label": "...", "default": "...", "arbiter": "toil_load" }],
  "human_balance": { "share": 0.42 | null, "ms": {"Q1":0,"Q2":0,"Q3":0,"Q4":0,"play":0,"unclassified":0}, "by_goal": {"G1": 0}, "line": "4% Q2; G1 got none of your time this week." }
}
```

- **Values.** The newest metrics record (a `metrics.jsonl` line without `kind`) for this workspace. If none exists, or the newest is more than 1 h old, `metrics.run(now - days, now, workspace)` is computed and appended first. This is deterministic, with no model, and cached in memory for 10 min per workspace.
  - `previous` is the record closest to `generated_at - days`.
  - Readings (`kind: reading`) whose `metric` equals a GOALS metric name win when they are newer.
  - Judged metrics (`weekly_retro`, `surprise`) have `value: null`, `source: 'judged'` and `at` = the last retro answer time, if `retro.py` stores it.
- **Name mapping** (GOALS name → record key):

  | GOALS name | Record key |
  |---|---|
  | `catch_up_time` | `catch_up_time_ms` |
  | `attention_latency` | `attention_latency_ms` |
  | `focus_interruptions` | `focus_interruptions_avg` |
  | `background_leverage` | `background_leverage_accepted_ms_per_focus_hour` |
  | `human_balance` | `human_balance` |
  | every other name | the same key; missing → `null` |

- **`ok`** comes from `op`/`value` when set, otherwise from the direction against `previous` (`falling`: value < previous). With no data it is `null`.
- **Trend:** `flat` within ±2 %.
- **Serving:**
  - open tasks, plus tasks closed in the last 14 days, whose `serves` contains the id
  - workstreams whose `serves` contains the id
  - active explorations whose `serves` contains the id
- The route is also used by M (§7) for `human_balance`, and by the digest (§6).

## 3. `human_balance` (P, `metrics.py`, `FORMULA_VERSION = 4`)

Only your focus time counts, never agent time.

**Focus time:** `focus_intervals` clipped to minutes that had input (keys + clicks > 0 in an `input.counts` event for that window in that minute). Reuse the active-time logic `creative_share` uses.

Each interval is attributed to a task, taking the first rule that matches:
1. The focus session's current item is `{kind:'task', task_id}` (§9 `FocusItem`, from `focus.start` / `focus.item`). The whole interval goes to that task.
2. The interval's `pty_id` is the task's agent pty, joined via `BusyIndex`/`_task_session_map` for the sessions active then.
3. The interval's `file_path` is in the task's `files`, and the task was open at that time. The most recently updated such task wins.
4. Otherwise the interval is `unclassified`.

Each attributed task's quadrant (§4) at computation time picks its band. A Q4 task with `play: true` counts under `play`.

Output fields:
- `human_balance = (Q1 + Q2) / (Q1 + Q2 + Q3 + Q4 + play)`, or null when the denominator is 0 (unclassified is excluded, spec §2.2).
- `human_balance_ms` (bands) and `human_balance_by_goal` (ms per goal id; a task that serves two goals counts for both).
- Remove `human_balance.goal_linked` from `UNAVAILABLE`.

**Strip line** (deterministic, in `goals/status`): `"<Q2 %>% Q2"`, then for the top-priority goal that got 0 ms, `"; <Gid> got none of your time this week"`, then `"."`. If there is no focus time: `"No focus time recorded this week."`

## 4. Quadrants, urgency and overrides (P, `tasks.py`)

`derive(task, goals, now)` is pure and deterministic. It runs on every save, and is recomputed on read for `due`.

**Important:** `overrides.important` if set, otherwise the task's `serves` contains a known goal id. `importance_rank` is the minimum priority of the served goals, for ordering inside a quadrant.

**Urgent:** `overrides.urgent` if set, otherwise the first of these that holds:

| Condition | `urgency.signal` | `urgency.ref` |
|---|---|---|
| `status == 'waiting'` | `agent-waiting` | |
| task is open and `origin.kind == 'operation'` | `op-failure` | `origin.ref` |
| `due` ≤ today + 1 day | `due` | the date |

**Quadrant:**

| Important | Urgent | Quadrant |
|---|---|---|
| yes | yes | Q1 |
| yes | no | Q2 |
| no | yes | Q3 |
| no | no | `Q4` if `play`, or `overrides.important === false`, or `urgency_cleared_at` is set; otherwise `null` (unclassified) |

**New fields:**
- `urgency_cleared_at`: set on save when the derived urgency goes from non-null to null.
- `overrides: {important: bool|null, urgent: bool|null, at}`
- `importance_rank`
- `files_at_first_report`: the `files_count` at the first `turn_end` or check-in report, set once by the follower. Used by M's `scope/task-growth`.

**PATCH:** `/cockpit/tasks/{id}` also accepts `{important?: bool|null, urgent?: bool|null}`, which set or clear the overrides. The change is logged to Lee as a `task.override` event (`{task_id, important, urgent}`), through the existing Hester→Lee event path (`copilot/lee_events.py`).

`ORIGIN_KINDS` gains `goal-eval`, also in M's `TaskOriginKind` and `validOrigin`.

The snapshot's open tasks are ordered by `OPEN_ORDER`, then quadrant (Q1, Q2, Q3, null, Q4), then `importance_rank`, then `updated_at`.

## 5. Steward (P)

### 5.1 Surfaces and the prompt

- `ContextRequest` gains `surface: Optional[str]` and `steward_context: Optional[str]`.
- Surfaces: `launch-suggest`, `what-next`, `evaluate`, `lint-ask`, `rail-steer`, `rail-ask`, `goal-edit`, `palette`, `tui`.
- The model-call trigger's `surface` is `request.surface`, falling back to the `X-Lee-Trigger` header, then to `http`.
- **Steer surfaces** (`launch-suggest`, `what-next`, `evaluate`, `lint-ask`, `rail-steer`, `goal-edit`) layer `hester/daemon/registries/prompts/steward.md` (Appendix A, verbatim) and then `steward_context` after the base system prompt in `_build_system_prompt`, but only when the steward is on for the workspace (§5.4). `rail-ask`, `palette` and `tui` never load it.
- `hester/daemon/tui/handlers/message_processor.py` sends `X-Lee-Trigger: tui`. R's palette sends `palette`.

### 5.2 Endpoints

All are user-triggered, may use cloud models and are non-streaming. Each returns `{text, proposals, steer?, surface, request_id}`. `text` is the markdown answer with the `lee-proposals` block removed.

| Method | Path | Body | Builds `steward_context` from |
|---|---|---|---|
| POST | `/cockpit/what-next` | `{}` | the digest (§6, incl. Q2 candidates), open tasks with quadrant/lead/timebox/busy, goal status (flagged, trends), `human_balance` |
| POST | `/cockpit/goals/{gid}/evaluate` | `{}` | the **evidence packet**: goal definition, metric status with the last 5 values, serving items, commits since `last_evaluated_at` from serving tasks, readings, `focus_ms_7d`, open Q2 candidates for the goal. The packet is deterministic and returned as `packet`. The result is saved to `.hester/goals/evaluations/<gid>-<yyyymmddThhmmss>.md` (packet + answer), which sets `last_evaluated_at`. If a metric has `measure: op:<name>` and no reading in 24 h, the response also carries `stale_measure: "<name>"` so the renderer can offer to run it first. |
| POST | `/cockpit/tasks/{id}/suggest` | `{}` | the task record, goals, and open tasks serving the same goals. Asks for the goals it might serve, a better lead, and starting branches. |
| POST | `/cockpit/ask` | `{question, about?: {kind: task\|exploration\|goal\|lint\|feed\|tile\|operation, id, record?}}` | the about item's full record (P looks it up by kind/id; `lint` and `feed` records come from the body's `record`, because they live in Lee main) plus linked tabs. The surface is `rail-steer` if the question is classified steer, else `rail-ask` (§5.3). |
| POST | `/cockpit/goals/draft` | `{instruction, goal_id?}` | surface `goal-edit`. Hester returns a full proposed GOALS.md. The response also includes `{draft_id, diff}`, a unified diff made with `difflib` against the current file, and the draft is stored at `.hester/goals/drafts/<draft_id>.GOALS.md`. |
| POST | `/cockpit/goals/draft/{draft_id}/apply` | `{}` | writes GOALS.md from the draft **only on this explicit call**, and only if the file still matches the draft's base hash (409 otherwise). It never commits. |
| POST | `/cockpit/goals/{gid}/workstream` | `{title?}` | Build toward: a workstream with `serves: [gid]`; returns `{workstream_id, title, phase}` |
| GET/POST | `/cockpit/steward` | POST `{not_today?: bool}` | `{enabled (config), not_today_until: iso\|null, active: bool}`. Not today lasts until local midnight, is stored in `.hester/cockpit/steward.json`, and is logged as a `steward.quiet` event. |

- Each steer request logs a `steward.request` event `{surface, about_kind?, goal_id?}` to Lee, which feeds `pull_usage`.
- **Proposals:** the model may end its answer with one fenced block that P parses deterministically:

  ````
  ```lee-proposals
  - {label: "Spike: defer mDNS start", action: create_task, params: {title: "...", serves: [G1], lead: delegate, kind: prototype}}
  ```
  ````

  - Allowed actions and params:

    | Action | Params |
    |---|---|
    | `create_task` | `{title, serves?, lead?, kind?}` |
    | `launch` | `{prompt, lead?, kind?, serves?, title?}` |
    | `link_goal` | `{task_id, serves}` |
    | `set_lead` | `{task_id, lead}` |
    | `park` | `{text}` |
    | `open` | `{kind: task\|exploration\|goal\|workstream, id}` |
    | `run_op` | `{name}` |
    | `explore` | `{seed}` |

  - Anything else, or anything malformed, is dropped. At most 5 are kept.
  - Each proposal gets `id: "prop-<8 hex>"`. `create_task` from an evaluation gets `origin: {kind:'goal-eval', ref: gid}`.
  - Proposals are stored with the answer in `.hester/cockpit/proposals.jsonl`.
  - `POST /cockpit/proposals/{id}/outcome {outcome: accepted|dismissed}` records the outcome and logs a `proposal.outcome` event. R executes accepted proposals through existing client calls; P only records them.

### 5.3 Ask vs steer (rail)

The spec says Hester classifies and errs toward ask. For v4 the classification is **deterministic**, so it costs no extra model call. A question is steer only when **all** of these hold:
- `about.kind` is `task` or `tile`, and that task has a live agent pty
- the question starts (case-insensitive, after trimming) with one of: `keep going`, `continue`, `go ahead`, `stop`, `wait`, `tell it`, `tell the agent`, `ask it`, `have it`, `start`, `now `, `please `, `instead`, `don't`, `do not`, `switch to`, `focus on`

Otherwise it is ask.

For steer, the steward is asked to answer and to end with a fenced `lee-steer` block holding the exact text to type into the agent. P parses it into `steer: {task_id, pty_id, text}` (text ≤ 2000 chars). **Nothing is sent by P.** R shows the text and the target tab, and sends it only when you click (§8.4).

### 5.4 On/off

`hester.steward: on | off` comes from `WorkspaceContext.config()` (`<ws>/.lee/config.yaml`, merged). The default is `on`. `active = enabled and not not_today`.

When inactive, steer surfaces run without `steward.md`. The endpoints still work; they are answers, not coaching.

`GET /cockpit/steward` is also M's source for steward-gating lint (§7.3).

## 6. Digest, History, workstreams, knowledge hints (P)

- **Digest** (`build_digest`) adds `q2_candidates: [{kind: goal-unserved|exploration-quiet|evaluation-due, goal_id?, ref, title, detail}]`, deterministic:
  - `goal-unserved`: a goal with no open task, workstream or active exploration serving it
  - `exploration-quiet`: an active exploration untouched for ≥ 7 days
  - `evaluation-due`: a goal whose `last_evaluated_at` is more than 14 days old, or missing
  - At most 5, in goal priority order.
- **History**:
  - Each closed task gets `goal_impact: [gid]` from its `serves`.
  - Each reading whose metric is a GOALS metric (or is linked by `measure: op:<name>`) gets `goal_id` and `delta` (value − previous).
  - The renderer shows these as "G1 +180 ms".
- **Workstreams:**
  - `CreateWorkstreamRequest` and `_ws_response` gain `serves`.
  - Phases are soft: `POST /workstream/{id}/phase/{phase}` accepts any `WorkstreamPhase`, backwards included, without pausing.
  - `DesignDecision` gains `tradeoff: {favoured: [ids], over: [ids], note} | null`, rendered as "A over B because G2 > G4" in the design doc.
- **Knowledge hints:** remove the `git_watcher.py` "N uncommitted changes. Commit?" and "N new files. Document?" status pushes, and the `KnowledgeEngine` idle doc-gap check. They become the lint rules `commit/large-diff` and `commit/new-files-undocumented` (§7). Leave indexing untouched.

## 7. Lee main (M)

### 7.1 Hester cache (`electron/src/main/cockpit/hester-cache.ts`, new)

For each workspace with an open window, poll every 30 s (and on demand):
- `GET /cockpit/snapshot` gives the open tasks plus those closed in the last 7 days, with quadrant, `serves`, `timebox_min`, `busy_ms`, `files`, `files_count`, `files_at_first_report`, `lead`, `play`, `status`, `agent`, `urgency` and `updated_at`.
- `GET /cockpit/steward`
- `GET /cockpit/goals/status`, every 10 min

It uses the existing Hester client auth and the `X-Lee-Workspace` header used by `task-relay.ts`. If Hester is offline, the last good value is kept and rules that need it don't fire.

It exposes `tasks(ws)`, `taskByPty(pty)`, `stewardActive(ws)` and `humanBalance(ws)`.

### 7.2 Quadrant ordering

`attention-queue.ts` gains `setRanker(fn: (item) => {quadrant: Quadrant|null, rank: number})`. `rank` orders Q1 = 0, Q2 = 1, Q3 = 2, null = 3, Q4 = 4.

`snapshot()` sorts by: live before closed, then severity, then rank, then `active_wait_ms` descending.

The cockpit installs the ranker: `tabRuntime.taskOf(source.pty_id)`, then the cache task's quadrant. `AttentionItem.quadrant` is set for display.

### 7.3 Lint

`LintRule.family` becomes the `LintFamily` union (§9).

`LintContext` gains these providers:
- `git(ws)`: a `GitSnapshot` (§9) computed with `execFile('git', …)`, never a shell. It holds:
  - porcelain v1 status: changed and untracked files, excluding ignored ones
  - `for-each-ref refs/heads` with committer dates, plus `--merged <default>`
  - `stash list --format=%gd%x09%ct%x09%gs`
  - the current and default branch

  It is cached for 30 s per workspace and invalidated by `operation.result` and `agent.turn_end` events for that workspace.
- `tasks(ws)`, `stewardActive(ws)`, `humanBalance(ws)`: from §7.1
- `projectRules(ws)`: `.lee/lint/*.yaml`, mtime-cached

**New rules.** Defaults are added to `cockpit-config.ts`; thresholds are configurable as in spec §10.5. `mergeLint` now also keeps `scope/areas: string[]`.

| Rule | Family | Default | Predicate | Fixes |
|---|---|---|---|---|
| `commit/large-diff` | hygiene | info, `min_changes: 5` | changed + untracked ≥ min | `open-git` (spawns the git TUI tab), `suppress-branch` |
| `commit/new-files-undocumented` | hygiene | info | untracked or added source files (ext in a code list) whose basename appears in no `*.md` under `docs/` or the root README, via a fixed-string search | `create-task` ("Document <files>", `kind: chore`), `suppress-item` |
| `branch/stale` | hygiene | info, `days: 30` | a local branch not merged into default, last commit > days | `open-git` |
| `stash/forgotten` | hygiene | info, `days: 7` | stash age > days | `open-git` |
| `scope/mixed-changes` | scope | warn | changed paths fall into ≥ 2 of `scope/areas` (defaults to top-level dirs when unset) | `create-task` (one per area, confirm lists them), `open-git` |
| `scope/task-growth` | scope | warn, `factor: 3`, `min_files: 6` | open task with `files_count ≥ max(min_files, factor × files_at_first_report)` | `promote-workstream` (Hester `/cockpit/tasks/{id}/promote`), `checkin` |
| `time/timebox-exceeded` | attention | info | open, not play, not human lead, `busy_ms / 60000 > timebox_min` | `wrap-up`, `extend` (timebox +30), `promote-workstream`, `park` |
| `time/polish-loop` | attention | info, `turns: 6`, `max_files: 2` | a task's last N agent turns (turn_end) each wrote only the same ≤ max_files files, and no other files | `wrap-up`, `park` |
| `time/q4-drift` | attention | info | quadrant `Q4`, not play, agent busy within the last 10 min | `wrap-up`, `link-goal`, `park` |
| `focus/thrash` | attention | info, `items_per_hour: 4` | in one focus session, ≥ N distinct non-agent focus items (`focus.item`, excluding `kind: 'agent'`) within 60 min | `end-focus`, `suppress-item` |
| `balance/q2-starved` | attention | info, `min_share: 0.1`, `min_focus_h: 5` | 7-day Q2 share < min, with classified focus ≥ min_focus_h | `what-next` (opens Copilot and runs What next?) |
| `agent/fix-loop` | agent | warn, `turns: 3` | in one agent session, the same `agent.tool` post signature has `failed: true` in ≥ N distinct turns (turns are separated by `agent.prompt`) | `checkin`, `open-tab` |
| project rules (`project/<id>`) | project | from the file | the regex (JS, `m` flag) matches an **added** line of `git diff HEAD --unified=0` or a line of an untracked file (≤ 256 KB), in files matching `paths` globs | `open-file` (path:line), `suppress-item` |

- **`wrap-up`** carries `confirm_text` showing the exact text it types: `Please wrap up: finish the current step, summarise what you did in a lee-status block, and stop.` It types through the `tab` domain `send_input` with `submit: true`, and only after your click (C3).
- **`park`** captures the task title to Someday (`as: 'keep'`, source `lee`) and changes nothing else.
- **`link-goal`** and **`what-next`** are renderer-side fixes. The fix result returns `{success: true, data: {renderer_action: 'link-goal'|'what-next', task_id?}}` and R performs them.
- **`ast-grep` is not included** (not installed); project rules are regex only. A rule file with `ast_grep:` is loaded and skipped, with a warning in `lee.log`.
- **Steward gating:** the `attention` and `agent` families evaluate only when `stewardActive(ws)` is true. Otherwise their live diagnostics are withdrawn without an outcome, so they are not counted as ignored.

### 7.4 Focus on a task

`FocusItem` gains `{kind: 'task', workspace, task_id, label}`. `focus.ts` accepts it on manual start (`focus:start` IPC and the device route) and logs it in `focus.start` / `focus.item`. A focus session started this way is **related** for any attention item whose source pty is that task's agent. Inferred focus is unchanged.

### 7.5 Other M duties

- `TaskOriginKind` gains `'goal-eval'`.
- `CockpitTask` in `shared/cockpit.ts` gains the fields in §4.
- The `quadrant` type becomes `Quadrant | null`.
- Smoke tests: extend `cockpit-lint-smoke.js` with every new rule (pure, with fixtures: fake git snapshot, tasks, events) and steward gating. Add a ranker check to `copilot-queue-smoke.js`.

## 8. Renderer (R)

### 8.1 Nav and the Goals section

- `SECTIONS`: copilot, feed, **goals**, tasks, ops, files, someday, explore, tabs, history. Sections have no keys (click only; the `cockpit-keys` change made Cockpit actions ⌘ chords and removed bare section keys). `DEFAULT_SECTION` stays feed. Any new Cockpit key follows `docs/shortcuts.md` § Cockpit: ⌘ chords only, listed in `COCKPIT_KEYS`.
- Goals badge: ember when any goal is `flagged`, otherwise none.

`sections/GoalsSection.tsx` (data: `GET /cockpit/goals/status`, refreshed on section open and every 5 min):
- **One row per goal**, in priority order:
  - id, title, and metric chips (`name value → target`, trend arrow, ok colour, neutral when null)
  - serving counts; expand to list them, each clickable to select it
  - "Nothing serving" plus a flag when `flagged`
  - `last_evaluated_at`
- **Actions per goal:**
  - **Evaluate:** runs `stale_measure` first if you accept the prompt, using ops run IPC. Then shows the answer (markdown) with proposal buttons, inline under the row.
  - **Build toward:** creates the workstream and opens its tab through the v3 `onOpenWorkstream` path.
  - **Edit:** opens GOALS.md in the Workbench.
  - **Guided edit…:** takes an instruction, shows the diff (monospace, +/− colouring), then **Apply** (calls apply) or **Discard**.
- **Below the rows:**
  - tensions (a → b, default, arbiter)
  - constraints with violations
  - the **human_balance strip**: a stacked horizontal bar of Q1, Q2, Q3, Q4, play and unclassified (play in its own positive colour), a legend with hours, and the `line` sentence

### 8.2 Copilot section

- **Ask Hester** calls `POST /cockpit/ask` directly with `about: {kind, id, record?}`. `CockpitHost`'s `lastAbout` becomes an item ref, not a title; for lint and feed items R passes the record. The answer renders inline as markdown (`AgentMarkdown`) with proposals and, for a steer, the steer card (§8.4). Keep a "Open in palette" link for the old behaviour.
- A **What next?** button shows a spinner, then the answer and proposals.
- **Q2 candidates** from the digest are listed when the needs-you count is 0.
- A steward line reads "Steward on · Not today" (a toggle), or "Steward off (config)".

### 8.3 Proposals

`components/cockpit/Proposals.tsx` renders up to 5 buttons. Clicking executes the action with existing client calls:

| Action | Client call |
|---|---|
| `create_task` | Hester `POST /cockpit/tasks` with `status: 'queued'` |
| `launch` | `ctx.api.launch` |
| `link_goal` | `PATCH /cockpit/tasks/{id}` with `serves` |
| `set_lead` | `PATCH /cockpit/tasks/{id}` with `lead` |
| `park` | Someday capture |
| `open` | select or open the item |
| `run_op` | ops run IPC |
| `explore` | create an exploration |

It then posts `outcome: accepted`. A ✕ posts `dismissed` and, when the proposal is about a task, `POST /nudges/override` on Lee for `task:<id>`, which is recorded as an override. Nothing asks for a reason.

### 8.4 Steer card

The card shows "Send to **<tab label>**:" followed by the exact text in a read-only box, with **Send** and **Cancel**.

- **Send** types the text through the existing `tab` `send_input` IPC with `submit: true`, then logs through the cockpit IPC.
- If the tab is busy, the text is typed anyway, as the user explicitly clicked. The button label says "Send now (agent is busy)".

### 8.5 Tasks section, Launcher and lint

- **Task rows:**
  - A quadrant chip (Q1–Q4, "unclassified" dim, "play"). Clicking it opens a small menu: Important on/off/auto and Urgent on/off/auto, which PATCHes the overrides.
  - **Hester's view** calls `/suggest`, and the answer shows inline with proposals.
  - **Focus on this** starts focus with `FocusItem {kind:'task'}` through the existing focus IPC.
- **Launcher:**
  - Add goal chips: `serves` from `fetchGoals`, zero or more.
  - When `kind === 'prototype'` (or the text starts with the `proto:` prefix), there is no serves, no play and the lead isn't `human`, show one line under the input: *"No goal and nothing waiting. Park it, link a goal, or go."* It has two small buttons: **Park** (Someday capture of the text, then close the Launcher) and **Link goal** (focuses the goal chips).
  - Enter still launches immediately. Nothing else changes.
- **Lint:**
  - The flyout and the Feed lint items gain **Ask Hester**, which selects Copilot and asks with `about: {kind:'lint', id: diag.id, record: diag}`.
  - Handle `renderer_action` fix results (`link-goal` opens the task's goal picker; `what-next` switches to Copilot and runs it).
  - Show the new families' names in the flyout grouping.
- **Palette:** `CommandPalette.tsx` sends `X-Lee-Trigger: palette`.
- **History:** render `goal_impact` and reading deltas as chips.
- **Workstream picker/pane:** show `serves` and allow backward phase moves. This needs only the existing phase buttons to be enabled for earlier phases.

## 9. Shared types (M writes these into `electron/src/shared/cockpit.ts` first; R imports)

```ts
export type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type LintFamily = 'toil' | 'hygiene' | 'scope' | 'attention' | 'agent' | 'project';
export interface TaskOverrides { important: boolean | null; urgent: boolean | null; at: string | null }
// CockpitTask gains:
//   quadrant: Quadrant | null; importance_rank: number | null; overrides: TaskOverrides | null;
//   urgency_cleared_at: string | null; files_at_first_report: number | null; worktree?: {...} | null (v3)
export interface GitSnapshot {
  workspace: string; at: number; branch: string | null; default_branch: string | null;
  changed: Array<{ path: string; status: string }>; untracked: string[];
  branches: Array<{ name: string; last_commit_ms: number; merged: boolean }>;
  stashes: Array<{ ref: string; ms: number; message: string }>;
}
export type StewardSurface = 'launch-suggest' | 'what-next' | 'evaluate' | 'lint-ask' | 'rail-steer' | 'rail-ask' | 'goal-edit' | 'palette' | 'tui';
export type ProposalAction = 'create_task' | 'launch' | 'link_goal' | 'set_lead' | 'park' | 'open' | 'run_op' | 'explore';
export interface Proposal { id: string; label: string; action: ProposalAction; params: Record<string, unknown> }
export interface StewardSteer { task_id: string; pty_id: number | null; text: string }
export interface StewardAnswer { text: string; proposals: Proposal[]; steer?: StewardSteer | null; surface: StewardSurface; request_id: string; packet?: unknown; stale_measure?: string | null }
export type AboutKind = 'task' | 'exploration' | 'goal' | 'lint' | 'feed' | 'tile' | 'operation';
export interface AboutRef { kind: AboutKind; id: string; label: string; record?: unknown }
```

`LintDiagnostic.family` becomes `LintFamily`, and `AttentionItem` in `shared/copilot.ts` gains `quadrant?: Quadrant | null`. R's Goals status and Q2 candidate types live in `lib/hesterCockpit.ts`, which R owns.

## 10. Tests

- **P:** new `tests/copilot/test_goals_v4.py`, `test_quadrant.py`, `test_steward.py`, `test_human_balance.py`, and additions to `test_digest.py` and `test_metrics*`. They cover:
  - parsing the real `GOALS.md`, where every goal, metric, constraint and tension has the right fields
  - target parsing, and status with stubbed records
  - flagged
  - the quadrant table, including play, overrides and `urgency_cleared_at`
  - PATCH overrides
  - `human_balance` attribution precedence and bands
  - the strip line
  - Q2 candidates
  - steward prompt layering on and off by surface, config and not-today, with `process_context` stubbed (assert the system prompt contains `steward.md` only for steer surfaces)
  - proposals and steer block parsing, including malformed input
  - ask/steer classification
  - evaluate packet and file
  - draft diff/apply with the 409 on a changed base
  - workstream `serves` and soft phases
  - `git_watcher` hints gone
- **M:** `npm run typecheck` is clean, and the lint and queue smokes pass.
- **R:** `npm run typecheck` is clean, and `cockpit-renderer-smoke.mjs` is extended for section order (goals third), the Q4-note predicate and proposal execution mapping (pure functions exported from `cockpitModel.ts`).

## Appendix A: `hester/daemon/registries/prompts/steward.md` (verbatim)

````markdown
## Steward

You are also the user's steward: opinionated about where their time goes. The user asked you for judgment, so give it.

- Push toward important work (it serves a goal in GOALS.md) and away from work that is neither important nor urgent. Chosen play is never pushed back on.
- Evidence, not vibes. Every pushback cites something from the context below: the goal or the lack of one, the urgency signal or its absence, time already spent, the human_balance numbers. Never "are you sure?".
- Always offer the alternative: a concrete better use of the time, with a size ("a 20-minute spike").
- Say it once. If the context shows the user already overrode you on this item, don't repeat the pushback; answer what was asked.
- Never block and never ask the user to justify themselves. Overrides need no reason.
- Blunt, not scolding. Short sentences. No moralizing. Say what would change your mind.
- "I'll do this one myself" (human lead) is good friction, not inefficiency. Delegate monotony, not challenge.
- Agents' reports are claims until something deterministic (a merged commit, a passing operation) confirms them. Say which is which.

When a concrete next action would help, end your answer with at most five one-click proposals in exactly this form, and nothing after it:

```lee-proposals
- {label: "<short button text>", action: <create_task|launch|link_goal|set_lead|park|open|run_op|explore>, params: {...}}
```

Only use ids (task, goal, exploration, operation names) that appear in the context.
````

(For `rail-steer`, P appends: "The user wants to steer the agent working on this task. End with a fenced `lee-steer` block holding exactly the text to type into the agent's terminal, written to the agent, and nothing after it. It will be shown to the user before anything is sent.")
