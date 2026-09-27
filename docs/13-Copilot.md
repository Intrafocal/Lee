# Copilot: Hester as a Project Copilot

> **Status:** Draft, 2026-09-25
> **Mockups:** https://claude.ai/artifact/JbShzvpbCvGvGnpAaUtnrX (artboard **E** is the chosen Cockpit direction)
> **Supersedes in part:** `11-Workstream-Architecture.md` (workstreams move under Goals; the lifecycle stops being a waterfall)

## 1. Why

Most changes to a project are small enough to hand straight to a coding agent. Some aren't: they start from an intent rather than a feature request, have several possible paths, and need exploring before anyone knows what to build. Lee already has pieces for both (agent tabs, the Library, Workstreams, the DevOps TUI, Hester's live context), but they are separate tabs with no shared picture of the project and weak links between them.

AI also makes building cheap, and that changes where the risk is. The hard part is no longer producing code. It's spending time on the right things, keeping work separated and visible, and not drowning in parallel agents.

This spec moves Hester from an assistant you ask things to a **copilot for the whole project**. It has four parts:

| Part | What it is |
|---|---|
| **I. Hester as copilot** | How work is categorized and prioritized, Hester's opinionated **steward** stance, and how it controls tabs |
| **II. Cockpit** | The default tab for every workspace: where you see and steer everything |
| **III. Work lint** | Real-time diagnostics about *how* you're working, not just the code: scope, time, patterns |
| **IV. Copilot mode** | While you're away, Hester uses spare local compute to prepare for your return |

Once several agents run in parallel, the human is the bottleneck. Every part serves the same aim: route your attention to what matters and make steering cheap, so the operator's time goes to ideas, strategy and the world rather than to managing environments and babysitting agents.

### 1.1 Goals

This spec's goals are Lee's goals, and they live in **[`GOALS.md`](../GOALS.md)** at the repo root (promoted 2026-09-25). That file is the source of truth. In short:

| | Goal | Core measure |
|---|---|---|
| **G1** | Humane, fun development: remove bad friction, keep good friction | peek_rate, toil_load, tool_failures, creative_share, catch_up_time |
| **G4** | Focused bursts, from anywhere: agents work in the background, humans in discrete high-focus sessions, on any device | focus_interruptions, background_leverage, device_creative_share, capture_pickup |
| **G2** | Better than one-off agent sessions | attributed_agent_time, attention_latency, lost_threads |
| **G3** | Hester is distinctly valuable | nudge_acceptance, pull_usage, human_balance |

Listed in priority order; IDs are stable, so G4 sits second. Constraints: **C1** local-first, **C2** quiet while you work, **C3** the human decides; each has telemetry in `GOALS.md`.

G1 is the purpose, G4 is the shape of the work, and G2 and G3 are how Lee and Hester get there. `GOALS.md` is written independently of this spec, so the spec can be evaluated against it without circularity. Almost none of its metrics are measurable today; §15 v0 exists largely to make them measurable.

### 1.2 Goal check

Two-sided, per `GOALS.md`: for each part, the metrics it moves, the metrics it costs, and when it lands. Revised 2026-09-25 after three independent reviews (one Sonnet, two Opus) found the first version graded almost everything "Core" by only asking what each part serves.

| Part | Moves | Costs | Phase |
|---|---|---|---|
| Event log, presence, per-device tokens (§12, §13) | Makes every G1/G4 metric and C1–C3 telemetry measurable | Small local storage | v0 |
| Agent hooks, compliance-free (§4.1) | G1 peek_rate ↓, G2 attention_latency ↓ | None for the operator | v0 |
| Machine-wide waiting queue, focus-relative (§5) | G4 focus_interruptions ↓, G2 attention_latency ↓ | Some non-focus items wait longer (G4 vs G2 tension) | v0 |
| Device reply and capture (§5.1) | G4 device_creative_share ↑, capture_pickup ↑ | Risk of "never away" (guarded by off-hours sessions) | v0 |
| Focus sessions, handoff with away policy (§5.1) | G4 background_leverage ↑, focus_interruptions ↓ | One handoff step per session (toil_load, small) | v0 focus toggle; v1 handoff |
| Session-start digest, weekly retro (§8.1) | G1 catch_up_time ↓; enables weekly_retro and surprise | None | v1 |
| Tasks, check-ins, operations, `tab` domain, Cockpit tab (§4.2, §7) | G2 attributed_agent_time ↑, G1 toil_load ↓ (Hester runs operations) | Assign/confirm steps count toward toil_load | v2 |
| Toil lint (§10.2) | G1 toil_load ↓ via fixes | Nudges (G3 vs flow) | v2 |
| Explore made durable (§7.5) | G2 lost_threads ↓; fixes known breakage (tool_failures ↓) | None | v3 |
| Goals section, Evaluate, steward, quadrants as ordering (§2.2, §3, §7.3) | G3 pull_usage ↑, human_balance ↑ | Cloud spend on demand only | v4 (built 2026-09-26) |
| Hygiene, scope, attention lint (§10.2) | G3 nudge_acceptance (to be proven) | Nudges; each rule demotes itself if ignored | v2–v4 (hygiene, scope, attention, agent-use and project rules built in v4) |
| Copilot mode (§11) | G1 catch_up_time ↓ | Local compute while away; complexity | v5 (kept as specified by decision) |
| ~~`pattern/duplicate-*`, `agent/spec-in-prompt`~~ | Nothing in `GOALS.md` | Nudges | **Cut** |
| ~~Play budget, required reasons~~ | Nothing | G1 (ceremony, capped play) | **Cut** |

### 1.3 Three layers of compute

The human is the pilot. Hester's work splits into three layers, with a hard line between each:

| | **Lint and live Cockpit** | **Copilot mode** | **Steward / on-demand Hester** |
|---|---|---|---|
| What | Pattern matching over signals: counts, timings, paths, repeats | Gather, measure, index, condense, pre-assemble context | Judge, recommend, prioritize, push back, write proposals |
| Runs on | **Deterministic code only**, no model | Deterministic code **plus the local model** | **Cloud models**, or the local model where Hester's existing routing picks it (`prepare.py`) |
| When | Continuously, while you work | **Only while you're away from the machine** (§11) | **Only on demand**: when you ask (evaluate, check in, "what next?", "ask about this") |
| Output | Diagnostics with evidence | Facts, digests and evidence, labelled as such | Opinions and recommendations, attributed to Hester |

**While you're working, no model runs unless you ask for one.** Lint and the live Cockpit are deterministic, the local model runs only in copilot mode (so it never competes with you for the machine), and cloud models run only for a request you made. Nothing automatic recommends anything. The point of the first two layers is to make the third faster, cheaper and better grounded: when you ask, the evidence is already there.

This is enforced in code (§13): the lint engine and live Cockpit have no model client, the copilot job runner gets a local-only client and runs only while you're away from the machine, and only request handlers triggered by a user action can reach a model otherwise. **Hester breaks this today** (§14): `KnowledgeEngine` embeds editor context through Gemini on every context change, and `ProactiveWatcher` runs cloud-backed indexing and checks on timers. Gating those is part of v0.

---

# Part I: Hester as copilot

## 2. The four kinds of work

Work falls into four categories, and they're told apart by **lifecycle**, not by which tool runs them.

| Category | Examples | Lifecycle | Done means |
|---|---|---|---|
| **Tasks** | Quick question, fix a bug, prototype a feature | ask → agent → review → close | Answered, merged or discarded |
| **Goals** | Define or update a goal, evaluate progress, build toward it | Lasts for the project: define → build → evaluate → refine | Never; revised or retired |
| **Operations** | Run the server, build the executable, install the app, flash firmware | Run on demand or keep running; repeat | Never; has a status and a last result |
| **Open ended** | Explore a new idea, learn a new approach | Branch → learn → prune → promote or archive | Knowledge captured, or promoted |

### 2.1 How work moves between categories

The links between categories are where most of the value is. Each one is a first-class action in the UI:

| From | To | Trigger |
|---|---|---|
| Open ended | Goal | "This should be a goal": the exploration seeds a GOALS.md entry |
| Open ended | Workstream / Task | Promote a branch that won |
| Task | Open ended | Escalate: "this turned into a question" |
| Task | Workstream | A task outgrows one agent session (it can exist without a goal; see §7.2) |
| Goal | Task(s) | Evaluation finds a gap, e.g. "Spike: defer mDNS start" |
| Operation | Goal | A measuring operation (e.g. `bench:startup`) records a goal metric |
| Operation | Task | A failure creates a task, pre-filled with the log excerpt |

Every link is recorded, so work can be traced back to where it came from, and a goal's history shows which tasks and workstreams moved it.

### 2.2 Importance, urgency, and who leads

Building used to be expensive, and that cost quietly kept not-important work from getting done. Without it, it's easy to spend days on work that is neither important nor urgent. Two separate questions govern work, and an earlier draft wrongly merged them:

1. **Who leads, and how much the agent may do on its own:** decided by the **nature** of the work.
2. **What comes first, and where your time is going:** decided by **importance and urgency** (the Eisenhower grid).

Merging them made important-but-not-urgent goal work read-only for agents, the one kind of work most worth running in the background. Keeping them apart fixes that.

**Who leads (chosen at launch, default `delegate`):**

| Lead | For | Agent permissions | Your role |
|---|---|---|---|
| `delegate` | Chores and well-understood work, at any importance | Accept-edits in a worktree; you review the result | Review finished results |
| `human` | Hard, interesting problems you want to solve yourself (good friction) | No agent, or an assistant on default permissions | You do the work |
| `plan` | Questions and unknowns: explore first | Read-only / plan mode | Decide on the plan |

Handed-off work (§5.1) runs as `delegate` under the away policy.

**Importance and urgency (for ordering and balance only):** both axes are derived, not declared.
- **Important:** serves a goal in `GOALS.md`, weighted by the goal's priority.
- **Urgent:** a live signal says it can't wait: a failing operation, a metric regression, an agent waiting on you, a broken build, someone waiting, or an explicit `due:` date. Urgency expires when the signal clears.
- **Unclassified:** work with no goal link and no urgency, the common case for quick one-offs. It's not Q4, not drift, and not counted in `human_balance`. It becomes classified when you link it or it gains a signal.

You can override either axis on any item, and the override is recorded.

| | **Urgent** | **Not urgent** |
|---|---|---|
| **Important** | **Q1** · first in the queue | **Q2** · protected: surfaced whenever the queue is clear |
| **Not important** | **Q3** · handled, ideally delegated | **Q4** · unchosen drift. Parked, unless it's **play** (§2.3) |

The quadrant sets the item's **order in the attention queue** and its band in the `human_balance` strip. It does not set permissions or who leads.

**Keeping Q4 out, without ceremony:**
- **At launch:** placement is deterministic and instant (§6). Only **new work** (a prototype or feature) with no goal and no urgency gets one line: "No goal and nothing waiting. Park it, link a goal, or go." Going needs no reason. Quick questions, bugs and chores are unclassified and get nothing.
- **While running:** the `time/*` lint rules (§10) catch drift: a timebox exceeded, polish loops, a cleared urgency signal. Each offers **Wrap up**, **Promote**, or **Park**, subject to the per-item nudge budget (§3).
- **Parking** records the idea in the **Someday** list (§12), the single capture store shared with devices.

**Keeping Q2 alive:** urgent work always crowds out important work. When the needs-you queue is empty, the digest (§8.1) lists **Q2 candidates**, found deterministically: a goal with nothing serving it, an exploration that has gone quiet, an evaluation that's due. "What next?" asks the steward to pick one. The Goals section shows the **human_balance** strip: *your* focus time by quadrant over the last 7 days, e.g. "4% Q2; G1 got none of your time this week." Agent time is excluded, so good delegation doesn't read as neglect.

### 2.3 Play, toil, and good friction

G1 asks Lee to curate friction, not just remove it. That takes three distinctions the quadrants alone don't make.

**Play is not drift.** Play is Q4 by definition (not important, not urgent), but it's *chosen*: tinkering with a new library, a side experiment, building something because it's fun. Drift is unchosen: a task that quietly turned into polishing. The difference is intent, so play is declared:
- **+ Play** in the Launcher (or "this is play" on any task or exploration) marks it as play. It's never pushed back on, never flagged by `time/*` rules, and never counted as drift.
- Play is **uncapped**. The `human_balance` strip shows it as its own positive band; more play is fine (G1 wants more of it).
- Play that turns out to matter can be promoted like anything else (§2.1): to an exploration, a goal, or a workstream.

**Delegate monotony, not challenge.** The `delegate` lead is for chores. When a task is hard *and* interesting to you, doing it yourself is good friction, not inefficiency. `human` lead ("I'll do this one myself") is a first-class choice in the Launcher and on any task: no agent is launched, and nothing flags it.

**Toil is measured and attacked.** Bad friction leaves deterministic traces: running the same commands by hand again and again, operations that fail intermittently, long waits on builds, approving the same harmless action repeatedly. `toil_load` (G1) counts these from the event log whether or not a rule detects them, and it also counts the **ceremony** Lee itself asks of you (confirms, assignments, snoozes, dismissals). The `toil/*` lint rules (§10.2) attach a fix that removes the toil (make it an operation, allow that action, investigate the flaky operation), not just a notice.

**No required reasons.** Nothing in Lee requires you to type a justification: not "Do it anyway", not pruning a branch. A reason field is always offered and always optional, and can be added later.

**Progress is visible, and verified.** Finishing things is part of the fun. The digest (§8.1) and History lead with progress, counting only **deterministic** evidence: merged commits, operations that passed, goals whose metric moved, decisions recorded. An agent's own claim ("tests pass") is shown as the agent's claim, not as a win, until something confirms it.

## 3. Steward mode

Hester is **opinionated about where your time goes**. It's the tough voice that pushes toward Q1 and Q2 work and away from Q4 (§2.2). It says plainly when something isn't worth doing, names the tradeoff, and recommends the alternative.

The steward is a **thinking-tier** stance (§1.3): it speaks only when you ask, using the evidence preparation has already gathered. It is **not** in the launch path. Launching is instant and deterministic (§6); the steward's view of a launch is available afterwards, as a suggestion you can open.

**When it's on.** On by default for any request that decides what work to do or how:
- "What next?" and proposals you ask for
- check-ins, and "Ask Hester" on a lint diagnostic (§10.4)
- goal evaluation
- rail messages that steer a work item ("keep going on this", "start that")

Automatic diagnostics (timebox exceeded, scope growing) fire with fixed wording and fixed quick fixes, with no model involved. The steward's voice comes in when you engage with them.

**When it's off.** Questions get answers, not coaching:
- quick Ask Hester (`⌘/` palette)
- a rail question with no work item selected, or a plain question about one ("why is it touching auth?")
- Hester TUI chats

The rule of thumb: if you're **asking**, Hester answers. If you're **deciding to spend time**, the steward weighs in. When a quick ask turns into work ("ok, go fix it"), the steward gets one line at that moment, e.g. "That's Q3, so timeboxed at 30 minutes", and then gets out of the way.

**How it behaves:**
1. **Evidence, not vibes.** Every pushback cites something: the goal (or the lack of one), the urgency signal (or its absence), time already spent, the `human_balance` strip. "This serves no goal and nothing is waiting on it" rather than "are you sure?"
2. **Says it once, across every source.** Each item has a single **nudge budget**: at most one nudge per change in its state, whether the nudge comes from the steward, a lint rule, or a check-in's drift question. After you override, it stays quiet on that item until something changes.
3. **Always offers the alternative.** Pushback comes with a concrete better use of the time: "Park it. G1 has had no work in 9 days; here's a 20-minute spike instead."
4. **Never blocks, never asks you to justify yourself.** You can always override, with no reason required. The override is recorded.
5. **Blunt, not scolding.** Short, direct, no moralizing. It says what would change its mind ("if Aeronaut users are hitting this, it's urgent; tell me and I'll re-place it").
6. **Good friction on request.** In Explore and on goals, "Challenge this" asks the steward to argue against your idea, find the hard part, or ask what would make it ten times simpler. Pushback you ask for is the good kind.

**Examples:**
- After a launch, if you open its suggestion: *"No goal, nothing waiting on it. Park it. If it matters, tell me which goal it serves."*
- Drift: *"45 min into a 30 min Q3 task, and the last six edits were spacing tweaks. Wrap it or park it."*
- "What next?", nothing urgent: *"Queue's clear. G1 is over target and nothing is working on it. The best hour you can spend today is the mDNS spike."*
- After an override: *"Doing it anyway: noted."* Then nothing more until the timebox runs out.

**Controls:** `hester.steward: on | off` per workspace (default `on`), and **Not today** in the rail, which quiets it until tomorrow and is itself recorded.

**Implementation:** requests to the daemon carry a `surface` field (`launch-suggest`, `what-next`, `check-in`, `evaluate`, `lint-ask`, `rail-steer`, `rail-ask`, `palette`, `tui`). All of them are user-triggered and may use cloud models. Automatic paths (`digest`, `lint`, `copilot`) are not surfaces and never reach the steward. The steer surfaces layer a `steward.md` prompt from `hester/daemon/registries/prompts/` over the base prompt, with the item's quadrant, lead, goals, timebox and override history in context. `rail-ask`, `palette` and `tui` never load it. Classifying a rail message as ask or steer is done by Hester, and it errs toward ask.

**Steering an agent always shows the text first (C3).** When a `rail-steer` message would be typed into an agent's tab, Lee shows the exact text and the target tab, and sends it on one click. A misclassified message can't steer an agent that edits tracked files.

## 4. Knowing what agents are doing

Hester learns what agents are doing in two ways: agents **push** events through hooks (§4.1), and Hester **pulls** by checking in through the tab (§4.2). Push is preferred wherever an agent supports hooks, because it costs the operator nothing: no reading agent output, no asking. Pull covers agents without hooks, and moments when you want an answer now.

**Push works without the agent's cooperation.** Everything essential comes from hook events Lee already receives: files touched (tool events), waiting on you (`Notification`), turn ended (`Stop`), and the agent's own last message as its summary, extracted verbatim and labelled as the agent's words. Nothing depends on the agent remembering a format.

An agent *may* add a structured `lee-status` block, which enriches the report with explicit status, blockers and next step. Check-ins ask for it. It's optional:

````
```lee-status
status: done | in-progress | blocked | waiting
summary: Added requireAuth to the /fs routes; tests pass.
blockers: /context is read unauthenticated by Aeronaut. Change it too, or leave it?
files: electron/src/main/api-server.ts, electron/src/main/api-server.test.ts
next: Waiting on the /context decision before touching it.
```
````

The agent writes the report; it already knows what it did. No Hester model is involved, and C2 holds. Lee parses everything deterministically.

### 4.1 Agent events via hooks

For Claude Code, using its hook events. Events go to Lee main's event log and attention queue (§13), which is machine-wide, so a blocker in one project is visible while you work in another.

| Hook | What Lee does |
|---|---|
| `SessionStart` | Registers the session with its tab, workspace and task. Adds one optional line to the session's context: "When you finish a unit of work or need a decision, you may end with a `lee-status` block." |
| `PreToolUse` / `PostToolUse` | Records files touched and tools used (already captured by `workstream/hooks.py`). Marks the agent busy. |
| `Stop` (end of each turn) | Records turn end and busy time. Extracts the last assistant message as the turn summary, plus a `lee-status` block if present. |
| `Notification` (waiting on you) | Posts an immediate `approval` or `waiting` item to the attention queue with the agent's message. This replaces the 10-second-quiet heuristic for Claude. |
| `UserPromptSubmit` | Records that you prompted (not the content) for deterministic lint and metrics. |
| `SessionEnd` | Marks the session finished and drafts the task's outcome from its last summary. |

What Lee and Hester do with the events:
- update the task (§7.2): busy time, summary, files; a `done` status (if reported) moves it to review
- turn a `Notification` or a reported blocker into a waiting item, with the agent's question as the text and **Reply…** / **Open tab** as actions, on every surface including devices (§5.1)
- add the summary to the digest (§8.1), labelled as the agent's claim
- feed lint and metrics: `scope/task-growth` uses files touched, `agent/fix-loop` uses repeated failures, `background_leverage` uses busy time

**Installation.** Lee attaches the hooks to agent sessions *it launches*, through a per-session settings file, rather than editing the project's `.claude/` settings. Agents you start outside Lee aren't affected. (Confirm the exact mechanism, e.g. a `--settings` flag, against current Claude Code docs during v1.)

**Other agents.** Any agent that can run a command at the end of a turn (e.g. Codex's `notify`) can post the same events to the same endpoint. Agents with no hook support fall back to check-ins (§4.2) and the screen tail (§7.6). Check-ins Hester runs on your behalf don't count toward `toil_load`, so using a hook-less agent isn't penalized.

**Fix to the existing hooks.** `hester/daemon/workstream/hooks.py` treats `Stop` as the session completing and has no `Notification` hook. `Stop` fires at the end of every turn; completion belongs on `SessionEnd`. This hook set replaces it.

### 4.2 Tab control: check-ins and runs

Hester works with agent and terminal tabs by typing into them and reading them back, like a person at the keyboard. That works with any agent CLI (Claude, Pi, Codex) with no integration needed.

**New `tab` command domain** on `POST /command` (Lee :9001), built on the existing `ptyManager.write` and per-PTY ring buffer (`ptyBuffers`) in `electron/src/main/api-server.ts`:

| Action | Params | Does |
|---|---|---|
| `send_input` | `tab_id`, `text`, `submit` (bool) | Writes to the tab's PTY; `submit` appends Enter |
| `read_output` | `tab_id`, `since` (cursor) or `lines` | Returns buffered output (ANSI stripped) and a new cursor |
| `state` | `tab_id` | `idle-at-prompt` \| `busy` \| `awaiting-input` \| `exited`, from telemetry where available, else a prompt heuristic plus output quiet time |

**Check-in** (on request: "check in on Claude" or a tile's Check in button; or proposed by a deterministic rule, e.g. a hook-less agent busy for 20 minutes with no check-in, which is a fixed proposal, not a model call). *Asynchronous and queued since 2026-09-26:* asking returns at once, and nothing waits on the agent.
1. If the agent is `idle-at-prompt`, send now. If it is busy, **queue** the check-in: it is typed when the current turn ends (the `Stop` hook, or the tab back at its prompt for hook-less agents). If it is waiting on a permission prompt, it stays queued until you answer that prompt. Never interrupt a running turn, and never answer a permission prompt. Approvals are always your click (§5). There is no "stayed busy" failure; a queued check-in can be cancelled from its tile.
2. Send a fixed check-in prompt: *"Reply with only a `lee-status` block (status, summary, blockers, files, next) describing your current work. Don't change anything."* The reply timeout starts here.
3. Parse the block, then create or update the tab's Task (§7.2) and post a feed event, exactly as for a hook report (§4.1). The tile shows "check-in pending" / "checking in…" meanwhile, and the result (or a failure) arrives as a Feed entry and a toast.

Check-ins Hester proposes still need your OK (C3); once you accept, they use the same queue.

The check-in prompt and reply are visible in the tab, since that's where they're typed. A check-in only reads; it never tells the agent to do anything else.

**Runs** (§7.4) use the same `send_input` / `read_output` pair, with the confirmation rules defined there.

Every `tab` action Hester takes is logged to the Cockpit feed with the tab, the text sent, and who asked for it.

## 5. Attention model

There is **one attention queue for the whole machine**, across every window, workspace and device, owned by Lee main (§13). A blocker in project B shows while you work in project A.

Every item has a severity:

| Severity | Examples | Where it shows |
|---|---|---|
| **ambient** | The digest, a metric moved within target, an `info` lint, something copilot mode prepared | Rail, Feed, status bar line |
| **needs-you** | Decision pending, an agent waiting on you about something you're *not* focused on, idle staged changes, a failed one-shot, a `warn` lint | Feed pinned, nav badge, status bar pill |
| **blocking** | An agent waiting on you about the item you're **focused on**; any waiting item past its limit (default 20 min); a running operation that crashed | All of the above plus a status bar escalation |

**Blocking is relative to focus.** An approval is only blocking if it concerns what you're working on right now, or has waited too long. With four agents on default permissions, treating every approval as blocking would make focus impossible. Within the queue, items are ordered by quadrant (§2.2), then age.

Needs-you items can be snoozed (until a time, or until the item changes). Dismissed items don't come back unless their state changes. Both count as ceremony in `toil_load`.

### 5.1 Focus sessions and background work (G4)

Human work comes in discrete, high-focus sessions; agent work runs in between. The attention model is built around that rhythm.

**A focus session** starts when you press **Focus** (status bar, Cockpit, or a device), or is inferred deterministically from sustained activity on one item (e.g. 10 minutes of editing or exploring without switching). It ends when you stop, leave the machine, or switch items for good. The focus item is what makes blocking relative (§5). Editing that isn't linked to any task or exploration is focused on "the files you're editing", and agents touching those files count as related.

**During a session:**
- Only **blocking** items interrupt: waiting items about your focus item, or past their limit. Everything else queues silently; the status bar shows a quiet count and **nothing else**: no rotating digest line, no cycling lint (§9).
- Agent events still land in the Feed; they just don't ask for you.

**At the boundaries:**
- **Session start** shows what's ready: the digest (§8.1) filtered to what you're about to work on, plus any queued items. You start with context, not with catching up.
- **Session end** offers a **handoff**: what should agents do while you're away? It pre-fills proposals from open tasks and the runbook (§7.3) so you can queue background work in a few clicks, then lets the queued items through. Working through them is **boundary triage**, which never counts as thrash (§10.2).

**Away policy.** A handoff sets how agents behave until you're back:
- handed-off work runs with `delegate` lead (§2.2): accept-edits, in a worktree
- an agent that needs you **parks** (waits) while the others continue; it doesn't escalate to a notification
- you get **at most one summary** at a time you choose (or none), not a stream of pings
- only items you explicitly marked "wake me for this" notify you

**On devices (Aeronaut, Dirigible)**, a session is short and can happen anywhere. The device's first screen is built for creative and steering actions, not monitoring:
- **Reply**: answer waiting agents and pending decisions (§4.1)
- **Capture** an idea (to Someday, or as the seed of an exploration)
- **Launch** background work, including a handoff
- **Review wins**: what shipped, what got decided

Watching tabs and reading output is still possible, one level down. Devices are **pull-first**: notifications follow the away policy and quiet hours (the G4 vs G1 tension in `GOALS.md`), and they travel over the local network or Tailscale, not a cloud push service (C1). Each device gets its **own token** at pairing, so its actions can be attributed (`device_creative_share`) and revoked individually.

**Presence vs engagement.** Two different signals, often confused:
- **At the machine:** keyboard and mouse input in a Lee window. This gates local compute (copilot mode, §11) and defines "returning" for `catch_up_time`.
- **Engaged:** any action from any surface, including devices. This gates notifications and counts toward focus and device metrics.

Checking your phone makes you engaged but doesn't make you "at the machine", so it doesn't preempt copilot mode on the Mac.

### 5.2 Device profiles

The two devices share one data model (the attention queue, Someday, the digest) but are good at different things, so each surface is designed to its device's strengths rather than ported between them. From hands-on use:

| | **Dirigible (T-Deck)** | **Aeronaut (phone)** |
|---|---|---|
| Strong | Trackball scrolling through long text; typing letters (a real keyboard, good for longer replies); touch and swipe | Visual display; touch, buttons and swipes |
| Weak | Precise pointing (the trackball); symbols and numbers (non-standard key combos) | Typing |
| Best for | Reading an agent's full words and writing a considered reply; capturing an idea in a sentence | Quick decisions at a glance; reviewing visual output (diffs, previews, possibly a canvas shared with Lee) |

**Design rules that follow:**

- **Dirigible:** one item per page, swipe or `j`/`k` between items, trackball scrolls the text. Actions are a few large touch buttons, each also bound to a **plain letter** (`y` approve, `n` deny, `r` reply, `d` dismiss, `c` capture, `f` focus). No shortcut needs a symbol or a digit. Replies get a large text box. Montserrat for text; monospace only in the terminal.
- **Aeronaut:** buttons and swipes over typing. Offer **quick-reply chips** (e.g. "Yes, go ahead", "Stop and wait for me", "Explain first") alongside the text field; prefer tap targets to text entry for anything common. Use the larger, richer display for visual context (diffs, previews, wins).
- **Both:** the terminal stream for a tab is open only while that terminal is on screen, since Lee treats an open stream as "viewed on this device" and sizes the PTY to it.

---

# Part II: Cockpit

## 6. Layout

### 6.0 Two modes: Cockpit and Workbench

*Decided 2026-09-25.* The Cockpit is a **mode**, not a tab among tabs. The babysitting habit is watching agent output, so the wall goes around the **agent terminals only**; your own editor, terminal and browser tabs are the creative work G1 wants more of, and stay one step away.

| | **Cockpit mode** (steering) | **Workbench mode** (hands-on) |
|---|---|---|
| When | Default between focus sessions and on return | Entered by starting focus (§5.1) or opening something to work on |
| Main area | The Cockpit, full window (layout below) | Today's tabs, centred on what you're working on |
| Agents | **Live tiles**, not terminals: state, busy time, latest summary, Approve/Reply on the tile. Opening an agent's terminal is a deliberate "go into" action | Only the agent terminals you explicitly went into |
| Your own tabs | A drawer along the bottom: names only, one click or keystroke to open | Normal tab strip |

- Starting focus drops you into the workbench; ending focus or handing off returns you to the cockpit.
- Starting an agent (⇧⌘C) stays instant: in cockpit mode it opens a tile, with one key to go into its terminal (G2 speed of one-offs).
- Going into a *finished* agent to review its result is normal, not penalised ("less reading vs informed review" in `GOALS.md`).
- The test is `peek_rate`: it should fall without `attention_latency` rising.
- Hester chat and DevOps tabs are your own tabs, never walled as agents. The wall covers agent terminals in every dock, side panels included.

Per workspace. The Cockpit answers three questions: **Where are we heading?** (goals), **What's in flight?** (tasks, workstreams, explorations, operations, tabs), **What needs me?** (approvals, decisions, failures, drift).

*Revised 2026-09-27:* the Cockpit's look and structure are redesigned in [`plans/2026-09-27-cockpit-design-contracts.md`](plans/2026-09-27-cockpit-design-contracts.md): an icon rail with six sections (Home, Work, Goals, Library, Ops, History), Home as a single column that leads into Deep, Work in the same layout as Aeronaut's Now, and no agent dock or tab drawer. Where it conflicts with the layout below, the contract wins.

*Revised 2026-09-26.* The right rail is gone: Hester lives in a **Copilot** section, first in the nav, so the center keeps the full width.

```
┌ tabs ──────────────────────────────────────────────────────────────────────────┐
├ NAV ───────┬ SECTION ─────────────────────────── [+Task][+Explore][Run ▾] ────┤
│ Copilot  • │                                                                  │
│ Feed     3 │   agent tiles (wrap; collapsible)                                │
│ Tasks    2 │   ──────────────────────────────                                 │
│ Ops        │   selected section                                               │
│ Files      │   (Copilot: Ask Hester · since you left… · away summary ·        │
│ Someday  4 │    work lint · weekly retro · copilot mode)                      │
│ Explore    │                                                                  │
│ Tabs     6 │                                                                  │
│ History    │                                                                  │
├────────────┴──────────────────────────────────────────────────────────────────┤
│ your tabs (drawer)                                                             │
├────────────────────────────────────────────────────────────────────────────────┤
│ status bar: ambient Hester line · lint count · needs-you pill (§9)             │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Left nav**, in this order (click to switch; no keys, since actions are ⌘ chords and ⌘1–9 stay on tabs): **Copilot**, Feed, Tasks, Ops, **Files**, Someday, **Explore**, Tabs, History. Each has a badge: ember when something in it needs you, a neutral count otherwise. Copilot shows only a neutral dot when a fresh brief is waiting after an absence (never ember, C2); Someday is always a neutral count (old untriaged ideas don't need you). There is no Goals section yet (§7.3). ~~Below them, **Pinned** items (a workstream, an exploration) for direct jumps (later).~~ *Dropped 2026-09-26:* the opener's "Pick up where you left off" and "Quiet explorations" (`14-Deep-Work.md` §6) cover it.
- **Copilot** is always present and is where you invoke Hester in steward mode and, later, see copilot mode (§8, §11): Ask Hester (about the last item you selected), the "since you left…" digest, the away summary, a work-lint summary, the weekly retro when due, and copilot mode's status (an empty state until Part IV is built). The default landing section stays Feed.
- **Files** is a keyboard-navigable workspace file browser (the Workbench file tree's data sources); opening a file switches to the Workbench and opens it the way the Workbench does.
- **Center:** the selected section, with a title, a one-line summary, and the **launch buttons** top right.
- **Launch buttons:** `+ Task`, `+ Explore`, and `Run ▾` (operations menu). Goals are defined less often and are reached from the Goals section. A single `⌘N` opens the Launcher (mockup row 3). You type what you want and press **Enter**: it launches immediately. Placement is **deterministic** (kind from the button or a prefix, lead defaults to `delegate`, goal links only if you add them), and nothing waits on a model. The Launcher also takes an optional **Name** (the session's display name, `claude --name`; it becomes the tab and tile label) and an optional **context picker**: workspace files (fuzzy search) and Hester context bundles, attached as `@path` references to the agent's initial prompt, so the agent reads them itself (deterministic, offline, nothing summarised; the task keeps only the paths and bundle ids). Afterwards, a **suggestion** chip offers Hester's view (goals it might serve, a better lead, starting branches) on demand. Only new work with no goal and no urgency gets the one-line Q4 note (§2.2). You can also mark anything as **play** or **I'll do this myself** (§2.3), and neither is pushed back on. Launching works offline (C1).

## 7. Sections

### 7.1 Feed

A merged stream across all categories. Newest first, with needs-you items pinned at the top.

Item kinds: `approval` (an agent waiting on a permission prompt), `blocker` (an agent reported a blocker, §4.1), `decision` (an exploration or workstream blocked on a choice), `failure` (an operation or test run failed), `metric` (a goal metric moved), `lint` (a work-lint diagnostic, §10), `proposal` (Hester suggests an action), `event` (commit, task closed, operation finished), `prepared` (something copilot mode made while you were away, §11).

Every item has at most three inline actions and can be the "about" context for Ask Hester in the Copilot section (§8.3).

### 7.2 Tasks

Short work handed to an agent. A Task is a **light record**:

```yaml
id: task-7f3a
title: Fix /fs/list 404 against packaged Lee
name: Login loop                         # optional session name; shown instead of the title (below)
context: { files: [src/auth.ts], bundles: [auth] }   # attached at launch; references only
kind: bug | question | prototype | chore
status: running | waiting | review | done | discarded
agent: { provider: claude, tab_id: 3 }   # null once the tab closes
lead: delegate | human | plan            # who leads (§2.2); default delegate
serves: [G2]                             # optional; drives importance (§2.2)
confirmed: true                          # you made or confirmed the links (counts for attributed_agent_time)
urgency: { signal: op-failure, ref: build-electron }   # optional; null = not urgent
quadrant: Q3                             # derived from serves + urgency; null = unclassified
timebox_min: 30                          # default for delegate lead
due: 2026-10-01                          # optional
origin: { kind: goal-eval, ref: G1 }     # optional, see §2.1
commits: [76e30ea]
outcome: "one-paragraph summary written by Hester on close"
created_at / closed_at
```

- **Named** (optional): a name you type (Launcher, Rename, or renaming the agent's tab) wins; otherwise Claude's own session title is picked up from its transcript, a `/rename` in the session first (it also replaces a name you typed, when it is newer), then Claude's AI title; otherwise the title derived from the agent's summary. Only the title lines of the transcript are read. Pi tasks have your name or the derived title.
- **Created** by `+ Task`, by the Launcher, from agent events (§4.1), or from a **check-in** (§4.2). Automatically created tasks are marked unconfirmed and don't count toward `attributed_agent_time` until you confirm or link them.
- **Kept current by check-ins:** when asked, Hester has the agent report on its current work and updates the task's title, status and summary from the reply.
- **Closed** when the agent's work is merged or discarded, or by hand. Hester writes the outcome from a final check-in plus the diff.
- **Grow into a workstream** (`Promote…`). The workstream shows under Tasks until it's linked to a goal, then moves under that goal.
- **Escalate** to an exploration. The task's transcript seeds the root node.

The section lists running and waiting tasks, then recently closed ones.

### 7.3 Goals

Goals last as long as the project and are defined in **`GOALS.md` at the repo root** (tracked in git, so goal changes get reviewed and have a history).

The example below is illustrative (it uses performance-style goals to show runnable metrics). Lee's own goals are in [`GOALS.md`](../GOALS.md).

```markdown
# Goals

## Constraints
- **C1 Local-first.** Core editing works with no network and no cloud services.

## Goals (in priority order)

### G1 Fast to a working session
Time from launch to a usable terminal and editor.
- metric: cold_start_ms
- measure: op:bench-startup        # an Operation, see 7.4
- target: < 1500

### G3 Low onboarding cost
- metric: setup_steps (proxy)
- measure: op:fresh-clone-check
- target: <= 6

## Tensions
- **G1 vs G2:** prewarming Hester costs startup. Default: G1 wins on the critical path.
```

Rules:
- Stable IDs (`G1`, `C1`), so tasks, workstreams and commits can reference them.
- There are three kinds of metric: **runnable** (an operation prints a number), **proxy** (runnable but only loosely tied to the goal; labelled so), and **judged** (a written rubric scored by Hester or a human).
- Readings are stored outside GOALS.md (§12), so the file's git history only records changes to the definitions.
- Agents may **propose** edits to GOALS.md. Only the human commits them.

The Goals section shows one row per goal: value, target, trend, and what is **serving** it (workstreams, tasks). A goal with nothing serving it and a bad trend is flagged. Tensions and constraints are listed below, followed by the `human_balance` strip (§2.2).

Actions on a goal:
- **Define / update:** opens GOALS.md, or a guided edit with Hester, which produces a diff you review.
- **Evaluate** (thinking, on demand): Hester compares the latest reading against the target and recent work and proposes tasks. If copilot mode has already assembled the goal's **evidence packet** (§11.3), Evaluate starts from it; otherwise it runs the measuring operation first.
- **Build toward:** creates a workstream linked to the goal.

**Workstreams** keep the existing backend (`hester/daemon/workstream/`: brief, design doc, runbook, dispatch, telemetry) with three changes:
1. `serves: [G…]` on the brief (empty when grown from a task).
2. Phases become state shown on the workstream, not a strict gate. You can go back to design from execution without pausing.
3. Design decisions record which goals they traded off ("A over B because G2 > G4").

### 7.4 Operations

Repeatable processes with a status. They build on the existing `services:` model (`docs/DevOps-Config.md`: detection, ports, health checks, named actions).

Two shapes:
- **Long-running:** dev server, Docker, Redis. Status: running, stopped or unhealthy, detected as today.
- **One-shot:** build, install, flash, benchmark, test suite. Status: last run result, duration and time; logs kept.

```yaml
operations:                     # extends services:, same file
  - name: bench-startup
    kind: oneshot
    command: npm run bench:startup
    cwd: electron
    produces: { metric: cold_start_ms, parse: "cold_start_ms=(\\d+)" }
    idle_ok: true               # copilot mode may run it (§11)
  - name: flash-tdeck
    kind: oneshot
    command: idf.py -p {port} flash
    cwd: dirigible/firmware
    params: [port]
    confirm: true               # outward-facing: ask before running
```

**Auto-detect:** on first open (and when the files change) Lee scans `package.json` scripts, `Makefile`, `pyproject.toml`, `idf.py` projects and `pubspec.yaml`, and **suggests** operations. You confirm them once, and confirmed ones are written to config. Nothing inferred runs without confirmation.

Running an operation opens (or reuses) a terminal tab linked to it, so the Tabs view and Operations show the same process. A failure lands in the Feed as a `failure` item with a "Create task" action.

**Terminal tabs are Operations by default.** A plain Terminal tab is an unnamed operation. Once it runs a command that matches a defined operation (e.g. `npm run dev` → `dev-server`), it links to that operation; otherwise it shows as "Terminal: <last command>". Running long-lived things in terminals is the ordinary case, so no extra step is required.

**Hester can run operations** in terminal tabs using the same tab control commands as check-ins (§4.2):
- It reuses the operation's linked tab, or an idle terminal at a shell prompt, or opens a new one. It never types into a terminal that has a foreground process running.
- Confirmed operations without `confirm: true` can run when Hester is asked ("rebuild and restart the server"). Operations with `confirm: true`, and any **ad-hoc command** that isn't a defined operation, run only after you approve a proposal showing the exact command and tab.
- Output is read back from the tab's buffer, so Hester can report the result or turn a failure into a task.

**Operation agents: small models for the parts that need judgment.** Running a *defined* operation needs no model at all: Lee types its command, which is free and instant. A model earns its place only where judgment is needed, and there a small Claude Code agent is the most cost-effective tool:

| Situation | Who runs it | Model |
|---|---|---|
| Defined operation (`npm run build`, `idf.py build`) | Lee, deterministically | None |
| A defined operation failed | Operation agent, started with the operation, its command and the log excerpt: read the error, try the obvious fix (missing dependency, wrong port, stale build dir), report | `operation_agent.model` (default Haiku) |
| Undefined or multi-step operation ("build and flash the T-Deck") | Operation agent: find the port, pick the command, run it, and propose saving it as a defined operation | `operation_agent.model`, or `operation_agent.plan_model` (Sonnet) for multi-step |
| The fix turns into real code changes | Escalate to a normal task (§7.2, `delegate` lead) | Sonnet or Opus |

Operation agents are ordinary Claude Code tabs launched with `--model` and a narrow `--allowedTools` list, so the v0 machinery applies unchanged: hooks, waiting items, Reply, busy time and the event log. They never start by themselves; you launch one from a `failure` item ("Fix with agent"), from `Run ▾`, or through a handoff (C2). The allowed-tools list keeps a build agent from wandering off (C3), and its spend counts toward `background_leverage`'s guard (G4).

```yaml
operation_agent:
  model: claude-haiku-4-5-20251001   # failure triage, single-step ad-hoc ops
  plan_model: sonnet                 # multi-step ad-hoc ops
  escalate_model: sonnet             # when the fix becomes a code task

operations:
  - name: flash-tdeck
    kind: oneshot
    command: idf.py -p {port} flash
    cwd: dirigible/firmware
    confirm: true
    allowed_tools: ["Bash(idf.py *)", "Bash(ls /dev/cu.*)"]   # for its operation agent
```

Model aliases and flag names come from `claude --help` (2.1.282: `--model` takes an alias such as `sonnet` or a full model name; `--allowedTools`). Operation agents are v2, with the rest of Operations.

### 7.5 Explore (open ended)

Someday is quick idea capture; Explore is for deeper dives.

**Now (v-now, decided 2026-09-26: section + persistence only):**
- Explorations are **persisted to disk**, one markdown file each in the workspace's gitignored `.hester/explore/<id>.md` (frontmatter, a Seed and a Log), file-first like the Cockpit task store, instead of Redis with a 2 h TTL.
- The **Explore** section (right after Someday) lists them (title, last touched, exchanges, archived), `+ Explore` (header or section) creates one, and **Dive in / Continue** opens a Hester chat tab on the session `explore-<id>`, seeded from the file. Every finished turn there is appended to the file's Log, so the file outlives the chat session and a later dive re-seeds from it. Explorations can be archived.
- **Promote → Explore** on a Someday item creates an exploration seeded from the idea.

**Done in v3 (2026-09-26, Explore absorbs the Library;** contract: [`plans/2026-09-26-copilot-v3-contracts.md`](plans/2026-09-26-copilot-v3-contracts.md)**):**
- **One store.** The Library pane is a tree view onto the same `.hester/explore/<id>.md` files (`session_id` is the exploration id). Its Redis tree sessions (2 h TTL) are gone; nothing about an exploration expires, and deleting in the Library archives. Per-node chats keep their agents and write each finished exchange to the node's `## Node <id> · <label>` section of the file.
- The node tree has **decision**, **spike** and **evidence** nodes. Pruning a branch records a decision; a reason is optional and can be added later. A spike runs an agent in a git worktree as a task with `delegate` lead and a timebox (origin `explore`, ref `<exp>/<node>`); the follower keeps the spike's status in step with the task, and on review or close its summary (labelled as the agent's claim), files, diffstat, diff (`.hester/explore/evidence/<exp>-<node>.diff`) and commits come back as an evidence node.
- Promote actions: to Task, to Workstream (decision nodes become design decisions), to Goal (a **draft** in `.hester/goals/drafts/<exp>.md`, never GOALS.md). Promotion carries the tree's outline (decisions, spikes, evidence), not a transcript dump.
- A task can be **escalated** to an exploration (seeded from its title, the agent's last report and its files; the task stays open).
- An exploration can be **archived as knowledge**: a deterministic note at `.hester/knowledge/explore-<id>.md`, which Hester reads with the `knowledge_notes` tool.
- Everything except the per-node chats (which you trigger) is deterministic; no action requires a reason.

### 7.6 Tabs

A flat view of every open tab, kept alongside the categories because "what is running right now" is its own question. Each tab tile shows the category and item it belongs to (if any) and a **fidelity tier**:

1. **Structured:** agent reports and telemetry via hooks (Claude Code, §4.1) or internal (Hester): status, summary, blockers, tool, files touched, linked task.
2. **Screen tail:** agents without hooks (Pi, Codex): the last few lines of the terminal buffer plus the deterministic `state` (§4.2): busy, idle at prompt, awaiting input. To understand what the agent is doing, check in.
3. **Activity only:** other TUIs (lazygit, btop): active or idle, and for how long.

Unlinked tabs show an "Assign…" action (to a task, operation or exploration).

What counts as an agent follows the process, not how the tab was opened: tasks launched from the Cockpit open as agent tabs, and a terminal where you started `claude` or `pi` by hand becomes an agent (tile, wall, icon) while that agent runs. An agent's name (§7.2) is its tab label.

### 7.7 History

Commits and closed items, each showing its goal impact where known ("G1 +180 ms", "G3 −1 step").

## 8. Hester in the Cockpit

*Revised 2026-09-26:* "the rail" below now means the **Copilot** nav section (§6.0); the surface names (`rail-ask`, `rail-steer`) are kept.

### 8.1 Digest and "What next?"

The top of the Copilot section has two parts, one per tier (§1.3):

- **Digest** (preparation, automatic): a factual "since you left" list that leads with **progress** (what shipped, what got decided, which goals moved), then what changed, what's waiting, and Q2 candidates. It's assembled deterministically from the Cockpit model; after a copilot-mode period it also includes the local-model recaps prepared while you were idle (§11.3). It recommends nothing. It regenerates when you return after being idle and on a slow timer, and its top line goes to the status bar as an ambient message. Every line links to its item.
- **What next?** (thinking, on demand): a button that asks the steward to read the digest and the Cockpit model and recommend where to spend the next stretch of time, with evidence.

After a copilot-mode period, the digest leads with what was prepared (§11.6).

**Weekly retro.** Once a week (at a time you choose), the digest adds a short retro: the week's verified wins, `human_balance`, and three questions feeding `GOALS.md`'s judged metrics: "Ideas or plumbing?", "Where were you stuck in a good way, and where in a bad way?" (`weekly_retro`), and "Did Hester show you something about your work you didn't already know?" (`surprise`). Answering is optional and takes under a minute.

### 8.2 Proposals

Hester's output is mostly **proposals**: an action you can take in one click (send a message to an agent, prune a branch, create a task, run an operation). Two sources:
- **Fixed proposals**, attached automatically by rules: a lint diagnostic's quick fixes, "Create task" on a failure, "Wrap up / Promote / Park" on drift. No model is involved.
- **Hester's proposals**, written by the thinking tier when you ask or act (What next?, Evaluate, a steer message in the rail).

Accepting a proposal is logged, and prunes and choices become decision records.

### 8.3 Context selection

Selecting any item (a feed card, a task, a goal, a tile, a lint diagnostic) sets the **about:** context for Ask Hester in the Copilot section; it survives switching to Copilot, and can be cleared there. Questions asked there are answered about that item, with Hester given its full record, linked tabs and telemetry.

## 9. Status bar

The status bar carries Hester's attention items on every tab. It builds on the existing `status` domain (`push` / `clear` / `clear_all` with `ttl`, `electron/src/main/api-server.ts`).

- **Ambient:** the digest's top line (§8.1) rotates through the existing message slot on a slow timer (e.g. 10 min, or when you come back after being idle). **Not during focus.**
- **Lint count:** `⚠ N`, like an editor's problems count. Outside focus, the message slot may show the highest-severity diagnostic; clicking the count opens the flyout as a problems panel grouped by rule family (§10.4).
- **During focus (§5.1):** the status bar shows only a quiet count of queued items and escalates only for blocking items.
- **Needs-you:** a persistent `N need you` pill. Clicking it opens a flyout of the needs-you list with inline actions and "Open Cockpit ⌘0" (mockup S2).
- **Blocking:** escalates to the raised banner (mockup S3) until handled or dismissed.
- The Cockpit tab shows an ember count badge in the tab strip.

To support this, `StatusMessage` gains `severity`, `source: 'cockpit' | 'lint'`, `itemId`, `ruleId` and `actions[]`, so the status bar can render inline actions that call back into Hester.

---

# Part III: Work lint

## 10. Work lint

A linter for **how you're working**, not just the code. It watches the same signals as the Cockpit and emits diagnostics with the familiar linter shape: rule ID, severity, evidence, quick fix, per-project configuration. The Cockpit and the status bar are where they show.

**Lint is purely deterministic pattern matching.** No model, local or cloud, is involved in deciding whether a rule fires. Every rule is a predicate over counts, timings, paths, string repeats or syntax patterns, so a diagnostic is reproducible and its evidence is the explanation. Judgment about a diagnostic is available on demand, by asking Hester about it (§10.4).

Hester had two rules without the structure: `hester/daemon/knowledge/git_watcher.py` pushed "N uncommitted changes. Commit?" (≥5 changes) and "N new files. Document?", and `KnowledgeEngine` ran an idle doc-gap check. Both became rules in this engine in v4 (`commit/large-diff`, `commit/new-files-undocumented`) and are gone from Hester.

### 10.1 Model

```yaml
rule: scope/mixed-changes
family: scope
severity: warn                   # off | info | warn | needs-you
evidence:
  - "uncommitted changes span aeronaut/, dirigible/firmware/, electron/src/main/"
  - "no single task or workstream covers all three"
message: "These changes look like 2–3 separate pieces of work."
fixes: [split-commit, create-workstreams, assign-to-task, ignore-until-branch-changes]
item: null                       # task/workstream it's about, if any
```

**Signals:** the event log (§12: focus, input counts, presence, hook events, approvals, device actions), git, check-in records, PTY output, and Cockpit records (tasks, leads, quadrants, timeboxes, goals). **Matchers:** git plumbing, regex over text and output, and syntax queries with tree-sitter (already Lee's syntax engine) or ast-grep.

### 10.2 Rule families

Every rule below is deterministic. The "how it matches" column is the whole detector.

| Family | Rule | How it matches | Steward-gated |
|---|---|---|---|
| **Toil** (§2.3) | `toil/repeated-sequence` | the same command sequence run by hand in a terminal ≥ 3 times in a week, with no matching operation; fix: make it an operation | No |
| | `toil/flaky-operation` | an operation's result flips between pass and fail across runs with no intervening change to its inputs; fix: create a task to investigate | No |
| | `toil/long-wait` | an operation you started keeps you idle-but-present for > N min, repeatedly; fix: run it in the background with a notification | No |
| | `toil/repeat-approval` | the same tool action (e.g. running the same test command) approved ≥ 10 times, or ≥ 10 approvals in a row each given in < 2 s; fix: allow that action for this session or project (the fix is a permission rule, not a scolding) | No |
| **Hygiene** | `commit/large-diff` (existing) | changed files ≥ `min_changes` | No |
| | `commit/new-files-undocumented` (existing) | new untracked files with no mention in docs | No |
| | `branch/stale`, `stash/forgotten` | age since last commit or stash > threshold | No |
| **Scope** | `scope/mixed-changes` | uncommitted paths fall into ≥ 2 configured areas (e.g. `aeronaut/`, `dirigible/`, `electron/`), or map to tasks or goals that don't overlap | No |
| | `scope/task-growth` | a task's files touched grows past N× its count at the first check-in | No |
| **Attention** | `time/timebox-exceeded` | task agent time > `timebox_min` | Yes |
| | `time/polish-loop` | ≥ N consecutive small edits (< K changed lines) to the same files | Yes |
| | `time/q4-drift` | task has no `serves:` and its urgency signal has cleared, but work continues | Yes |
| | `focus/thrash` | during a focus session, you switched between ≥ 4 distinct `human`-lead items within an hour. Replying to agents and boundary triage (§5.1) never count; orchestrating is the job | Yes |
| | `balance/q2-starved` | Q2 share of *your* focus time over the last 7 days < threshold | Yes |
| **Agent use** | `agent/fix-loop` | the same failing test name or error signature appears after ≥ 3 prompts to the same agent | Yes |
| **Project rules** | project rules | regex or ast-grep patterns defined by the project (§10.5), for the code conventions it cares about. General code linting is left to eslint, ruff, clippy and friends | No |

Cut after review: `pattern/duplicate-*` (plain code linting, serves no goal), `agent/spec-in-prompt` (it penalized writing thorough prompts, which is good friction), and `agent/rubber-stamp` (merged into `toil/repeat-approval`, whose fix removes the cause).

A single fresh diff is cheap to match in real time. Whole-repository scans (stale branches, project rules over the whole tree) run at low priority in copilot mode (§11.3), and their results feed the same diagnostics.

### 10.3 Rules for being trusted

1. **Precision over recall.** Thresholds start conservative. A rule that can't be written as a clear predicate isn't a lint rule; it's a question to ask Hester.
2. **Every rule is measured.** Each diagnostic's outcome is recorded: **fixed** (only when you used its quick fix, not when the condition cleared by itself, e.g. you'd have committed anyway), dismissed, or ignored. A rule whose diagnostics are mostly dismissed *or ignored* is demoted a level automatically and flagged for rework. The same outcomes feed `nudge_acceptance` (G3), with ignored counted in the denominator.
3. **Scoped suppression.** "Ignore for this task" or "ignore until the branch changes" plays the role of `eslint-disable-line`, instead of a global snooze.
4. **Every diagnostic has a quick fix**, and each fix is a Cockpit action or a proposal, never just a nudge.
5. **Steward gating.** Toil, hygiene, scope and project rules always run. Attention and agent-use rules are opinions about how you spend time, so they follow the `hester.steward` setting.
6. **One nudge budget per item** (§3): lint shares it with the steward and check-ins.

### 10.4 Surfaces

- **Status bar:** `⚠ N` count, the top diagnostic cycling in the message slot, the problems-panel flyout (§9).
- **Cockpit:** `lint` items in the Feed; diagnostics about a task or workstream also show on that item.
- **Rail:** selecting a diagnostic makes it the "about:" context. Its evidence already says why it fired. **Ask Hester** brings in the steward, on demand, for anything that needs judgment ("is this split worth doing?").

### 10.5 Configuration

Configured like eslint, in `.lee/config.yaml`:

```yaml
lint:
  commit/large-diff: { severity: info, min_changes: 5 }
  scope/mixed-changes: warn
  focus/thrash: { severity: info, items_per_hour: 4 }
  toil/repeat-approval: { severity: warn, min_repeats: 10 }
  scope/areas: [aeronaut/, dirigible/, electron/, hester/, editor/]
```

**Project rules** go in `.lee/lint/*.yaml`, each a regex or ast-grep pattern with a message and severity:

```yaml
id: project/hardcoded-daemon-url
language: typescript
pattern: "'http://127.0.0.1:9000'"
paths: [electron/src/renderer/**]
message: "Use the shared daemon URL helper instead of a literal."
severity: warn
```

---

# Part IV: Copilot mode

## 11. Copilot mode

While Lee is open but you're away, Hester uses **spare local compute to equip you for your return**. It doesn't do the thinking. That stays with you and with on-demand, cloud-backed Hester (§1.3). Copilot mode gathers, measures, indexes and digests across every open workspace, so that when you come back the Cockpit is current and any question you ask Hester starts from evidence that's already assembled. It stops the instant you come back.

The name fits the analogy: the copilot runs the checklists and has the charts ready. The pilot decides where to fly.

### 11.1 When it starts

- Lee is running with at least one window open.
- You've been **away from the machine for `idle_minutes` (default 30)**: no keyboard or mouse input in any Lee window (§5.1, "presence vs engagement").

Device activity (Aeronaut, Dirigible) makes you *engaged* but not *at the machine*, so a phone check doesn't preempt copilot mode or reset its clock. Agents producing output, operations running, and Hester's own actions never count.

**Presence** is computed in Lee main from its event log (§12). Today's `lastInteraction` in `context-bridge.ts` only updates on editor and tab events, not terminal keystrokes, so v0 adds input events from every tab. Lee main publishes a machine-wide `presence` event to Hester: `{ at_machine: bool, engaged: bool, last_input, source }`.

### 11.2 Local only

- All inference uses a **local model** through the existing Ollama client (`OllamaGemmaClient`, `hester/daemon/prepare.py`). There are **no cloud model calls and no web access**: nothing leaves the machine except localhost traffic.
- This is enforced in code, not by prompt: the copilot job runner is given a client that can only reach the local model, and a tool set with no network tools.
- The local model is used only for mechanical work: condensing, extracting, classifying, embedding. It doesn't evaluate, recommend or decide, so its limits matter little. A weak summary is still a faster starting point than none.

### 11.3 What it does

Per open workspace, in turn, in this priority order:

1. **Goal evidence packets.** For each goal: compute its runnable metrics from the event log, run a measuring operation if one is marked `idle_ok: true` (§7.4), and collect the commits, tasks and workstreams since the last evaluation that touch it. The result is a packet, not a verdict. **Evaluate** (§7.3) starts from it when you ask.
2. **Context bundles.** Refresh stale bundles, and rebuild bundles for active workstreams and goals, so agents and on-demand Hester start with current context.
3. **Full lint scans.** Run the deterministic scans that are too slow for real time (§10.2): stale branches and stashes, project rules over the whole tree. No model is involved; idle time is just when the CPU is free.
4. **Cockpit digest.** Assemble the "while you were away" digest (§8.1): verified wins, what changed and moved; Q2 candidates; quiet explorations with a short factual recap of each; Someday items grouped by similarity (grouping, not triage).
5. **Knowledge index.** Index new or changed docs, embedding them only if a **local** embedding model is configured (the only embedder in Hester today is Gemini, which copilot mode can't use), and extract a factual outline of finished explorations, ready for "archive as knowledge" when you ask.

Work is split into **small resumable units** (each a few minutes at most) and checkpointed after each, so stopping loses at most the unit in progress.

### 11.4 What it never does

- Type into any tab: no check-ins and no runs. Agents may be mid-turn, and check-ins are visible in the tab.
- Approve anything, message an agent, or answer a prompt.
- Edit tracked files, commit, or touch git state (it reads git; it doesn't write it).
- Run operations not marked `idle_ok: true`. `idle_ok` operations run in a scratch worktree; if one would still change tracked files in the workspace (a formatter, codegen), the job aborts and reports instead (C3).
- Raise anything above `ambient`. Nothing it finds is urgent by definition, and it never sends device notifications. Real urgency (a crashed operation, a blocked agent) is still raised by the normal Cockpit, as it would be whether or not copilot mode is running.

All output goes to `.hester/copilot/` plus Feed items of kind `prepared`, with a run log (jobs, durations, model, units completed or abandoned).

### 11.5 Stopping

The moment Lee main sees you back at the machine, it sends `at_machine: true` as an **event, not a poll**. Hester then:
1. cancels in-flight inference (aborts the Ollama request),
2. checkpoints or drops the current unit,
3. **unloads the model** (Ollama `keep_alive: 0`), so its memory and GPU are free.

Target: CPU and GPU released **within one second** of your first input. Copilot mode starts again only after another full idle period.

### 11.6 Guards and on return

**Guards.** Default: on AC power only. It pauses when system load is high (e.g. a build is running) or under thermal pressure, and there's a daily budget (`max_hours_per_day`). Jobs run at lowered process priority.

**On return.** The digest leads with a "while you were away" section: what was prepared, each item linked. Nothing is a recommendation. It's the material for yours, or for Hester's when you ask ("What next?", Evaluate, Ask Hester). The Feed holds the `prepared` items.

### 11.7 Configuration

Machine-wide, in `~/.config/lee/config.yaml`, with a per-workspace opt-out:

```yaml
hester:
  copilot:
    enabled: true
    idle_minutes: 30
    model: gemma                # local model via Ollama
    ac_only: true
    max_hours_per_day: 4
    jobs: [goal-evidence, bundles, lint-scan, digest, knowledge-index]
```

```yaml
# .lee/config.yaml in a workspace
hester:
  copilot: { enabled: false }
```

---

# Part V: Shared

## 12. Data and storage (per workspace)

| Data | Location | Tracked in git? |
|---|---|---|
| Goals, constraints, tensions | `GOALS.md` (repo root) | Yes |
| **Event log** (machine-wide): focus and input counts per tab (never content), presence and engagement, hook events, approvals, device actions per device, model/network calls with their triggering action, UI ceremony | `~/.lee/events/` (per day, tagged by workspace), written by Lee main | No (outside the repo) |
| Per-device tokens | `~/.lee/devices/` (issued at pairing; revocable) | No |
| Goal metric readings | `.hester/goals/metrics.jsonl` (computed from the event log) | No |
| Someday (single capture store, shared with devices; replaces the broken `hester ideas`) | `.hester/someday/` | No |
| Tasks | `.hester/tasks/` (light records, §7.2) | No |
| Workstreams | `.hester/workstreams/` (existing) | No |
| Explorations (Explore and the Library; one markdown file each, plus spike diffs in `evidence/`) | `.hester/explore/` (replaces the Library's Redis TTL) | No |
| Knowledge notes (explorations archived as knowledge) | `.hester/knowledge/` | No |
| Goal drafts (promoted explorations; GOALS.md is edited only by a human) | `.hester/goals/drafts/` | No |
| Operations | `.lee/config.yaml` `operations:` / `services:` | No |
| Lint config | `.lee/config.yaml` `lint:` | No |
| Lint outcomes and suppressions | `.hester/lint/` | No |
| Feed and attention state | `.hester/cockpit/` (feed log, snoozes, dismissals) | No |
| Copilot output and run log | `.hester/copilot/` | No |
| Decisions, Hester conversations, check-in replies, overrides | `.hester/` (with the item they belong to) | No |

**Local by default, promoted on request.** Everything Hester produces (decisions, conversations, check-ins, exploration trees, summaries, copilot drafts) stays in gitignored `.hester/` or `.lee/`. Nothing is written into the tracked tree unless you ask for it: "promote this decision", "write this exploration up". Hester then proposes where it belongs (an ADR in `docs/`, a section of an existing doc, a GOALS.md edit, a code comment) and writes it there as an ordinary change for you to review. GOALS.md is the only file here that's tracked from the start, and it's still only edited when you ask.

## 13. Architecture

- **Lee main (:9001)** is machine-wide by nature (it sees every window and device connection), so it owns the machine-wide pieces: the **event log**, **presence and engagement**, **per-device tokens**, and the **attention queue** (§5). It receives agent hook events directly (§4.1), and stays the authority for tabs, PTYs and running operations, the `tab` domain (§4.2), and actions that spawn or focus tabs. This lets v0 ship without reworking the daemon.
- **Hester daemon (:9000)** owns the per-workspace **Cockpit model**: goals, metrics, tasks, workstreams, explorations, lint diagnostics, and the digest. It also hosts the **lint engine** and the **copilot job runner**. **Caveat:** today the daemon serves one workspace at a time and re-points itself when window focus changes (`POST /workspace` in `hester/daemon/main.py`). A per-workspace Cockpit model for every open window needs the daemon to hold several workspaces at once; that rework is part of v2.
- **Model routing** enforces the three layers (§1.3): the lint engine and live Cockpit have **no model client**; the copilot job runner gets a **local** client (Ollama only) and runs only while you're away from the machine; user-triggered surfaces (§3) may use cloud models or Hester's existing local routing (`prepare.py`, `hybrid_routing_enabled`). Automatic code can't construct a cloud client, and every model call is written to the event log with its trigger (C1/C2 telemetry).
- **API:** `GET /cockpit?workspace=…` (snapshot) and `WS /cockpit/stream` (deltas), plus `POST /cockpit/items/{id}/actions/{action}`. Lint diagnostics are Cockpit items with `kind: lint`.
- **Renderers:** the Lee Cockpit tab and status bar first, then Aeronaut and Dirigible (§5.1), whose first screens are capture, decide, launch and review rather than a tab monitor.
- **Degradation:** the tab renders local data (tabs, git, operations) without Hester, and Hester-sourced panels show "Hester offline" rather than blocking. The tab must not slow startup.

## 14. Existing code to reuse and fix

| Area | State | Needed |
|---|---|---|
| Library → Workstream promote | **Fixed in v3.** Was broken twice: preload lacked `sendCommand` (punch list C27), and `promote_to_workstream` called nonexistent `manager.get_session` | Now the Explore promote (`hester/daemon/cockpit/explore_ops.py`): an outline brief plus design decisions; the pane opens the workstream through `onOpenWorkstream` |
| Library persistence | **Fixed in v3.** Was Redis with a 2 h TTL (`hester/daemon/session.py`) | The Explore file store (`.hester/explore/`); the Redis managers are deleted |
| Workstream backend | **`serves:` and soft phases done in v4.** Complete on the backend; UI partial | `POST /workstream/{id}/phase/{phase}` accepts any phase, backwards included; decisions carry a goal trade-off |
| DevOps services | `services:` model plus TUI | Extend to `operations:`, one-shots, `produces:`, `idle_ok:` |
| Agent telemetry and hooks | `AgentTelemetry` with task and workstream IDs; `workstream/hooks.py` registers SessionStart, PreToolUse, PostToolUse, Stop, treats Stop as completion, and writes into `.claude/settings.local.json` | Report hooks (§4.1): `lee-status` parsing, Notification, SessionEnd, per-session install; screen-tail tier |
| Status bar | Message queue plus flyout | Severity, actions, lint count, needs-you pill |
| Context stream | Tabs carry `provider`, `workstreamId` (punch list D10) | Add `taskId`, `operationId` |
| PTY input/output | `ptyManager.write` and `ptyBuffers` exist, reachable only via the Aeronaut PTY WebSocket | `tab` command domain: `send_input`, `read_output`, `state` (§4.2) |
| Proactive hints | **Moved in v4.** `git_watcher.py` no longer pushes the commit/new-file hints and `KnowledgeEngine` has no idle doc-gap check; `GitWatcher` only caches status | Lint rules `commit/large-diff` and `commit/new-files-undocumented` in Lee main (§10) |
| Local model | `OllamaGemmaClient` used by the hybrid ReAct loop, on request | Model routing (§13); keep the user-triggered local routing; the copilot job runner is the only *automatic* user of the local client |
| Idle tracking | `lastInteraction` / `idleSeconds` in `context-bridge.ts`, updated only on editor and tab events (not terminal input); the 10-second-quiet idle heuristic in `TerminalPane.tsx`, only on watched tabs | Event log with input counts from every tab; at-the-machine presence vs engagement, sent as events |
| **C1/C2 violations** | **Fixed in v0.** `KnowledgeEngine` auto-match (Gemini embeddings on every context change) is behind `hester.proactive.knowledge_auto_match`, default off and reset on workspace switch. `ProactiveWatcher`'s model tasks (`docs_index`, `drift_check`, `bundles`) are disabled by default; a workspace that enables one gets it only while you're away (or always, with `run_while_present`), and every run is logged as an automatic model call. The ideas check is deleted | *Decided 2026-09-26:* keep them off by default. Enabling one is the opt-in for cloud model calls between sessions, which `14-Deep-Work.md` §8 otherwise avoids |
| Idea capture | `hester ideas capture` exists but imports `hester.ideas`, which doesn't exist; `ProactiveWatcher.check_ideas` calls it on a timer | Replace with the Someday store (§12); delete the broken path |
| Device auth | One shared bearer token (`~/.lee/api-token`) for renderer, hooks, Aeronaut and Dirigible | Per-device tokens issued at pairing (§5.1) |

## 15. Phasing

Ordered so the top-priority goals (G1, G4) move first, and so every phase is useful on its own. Revised after review: the first ordering built G2/G3 machinery first and G1/G4 last.

1. **v0: Blocker relay (≈ 2 weeks).** Proves the concept against G1 and G4.
   - **Event log and presence** in Lee main (§12, §13), with input counts from every tab and at-the-machine vs engaged.
   - **Per-device tokens** at pairing.
   - **Claude Code hooks, compliance-free** (§4.1): `Notification`, `Stop`, `SessionEnd`, tool events; per-session install; replaces the `workstream/hooks.py` set.
   - **One machine-wide waiting queue** (§5) in the status bar, Aeronaut and Dirigible, with **Reply** on each; focus-relative blocking.
   - A **Focus** toggle that holds everything non-blocking.
   - **Idea capture** from any surface into the Someday store (replacing the broken `hester ideas`).
   - **Gate the C1/C2 violations** (§14) and log every model call with its trigger.
   - **Success test:** against a two-week baseline taken in the first days of v0, `peek_rate` and `attention_latency` fall and `focus_interruptions` stays ≤ 1 per session.
2. **v1: Handoff and return.** Handoff with the away policy (§5.1); the deterministic session-start digest and verified wins (§8.1); the weekly retro.
3. **v2: Cockpit and tasks.** Cockpit and Workbench modes (§6.0) with the Cockpit's sections (Feed, Tasks, Operations, Tabs, History); agent tiles; tasks with leads and confirmed links; check-ins and the `tab` domain; Hester running operations; the toil lint family with fixes; the daemon rework to hold several workspaces (§13).
4. **v3: Explore.** Persisted explorations (fixes the broken promote and the 2 h Redis expiry), decision and spike nodes, working promotes.
5. **v4: Goals and steward.** The Goals section and Evaluate; quadrants as ordering and the `human_balance` strip; steward mode, What next? and launch suggestions; the attention and agent-use lint rules; project rules.
   - *Status 2026-09-26:* built to [`docs/plans/2026-09-26-copilot-v4-contracts.md`](plans/2026-09-26-copilot-v4-contracts.md). Hester side: full GOALS.md parsing, `GET /cockpit/goals/status`, `human_balance` (metrics formula v4), derived quadrants with overrides, the steward endpoints (`/cockpit/what-next`, `/cockpit/goals/{id}/evaluate`, `/cockpit/tasks/{id}/suggest`, `/cockpit/ask`, `/cockpit/goals/draft` and `/apply`, `/cockpit/goals/{id}/workstream`, `/cockpit/steward`, `/cockpit/proposals/{id}/outcome`), digest Q2 candidates and History goal impact. The ask/steer split is deterministic (a fixed list of instruction prefixes), so it costs no model call.
6. **v5: Copilot mode**, as specified in §11.
   - *Parked 2026-09-26* by `14-Deep-Work.md`. Its deterministic jobs already run elsewhere: lint evaluates on a timer in Lee main (`lint-main.ts`), and Evaluate builds its evidence packet on demand (v4). What's left is local-model work while Lee is open and you're away, and 14 moves that thinking into the session (Ask, 14 §5.3), prepares the next session by deterministic assembly (14 §8), and makes **Close Lee** the default at the end of a session (14 §7). *2026-09-27:* the daemon stays a child of Lee main and stops when Lee closes, so v5 stays parked; 14 §5.3 and §8 supersede it.
7. **v6: Anywhere, complete.** Aeronaut and Dirigible render the full Cockpit model (reply and capture already shipped in v0).
   - *Sequenced after 14's D1 (2026-09-26):* D1 replaces device Focus with "In deep work" and adds "Captured away" (14 §3.2, §6), so device surfaces are built against the D1 attention model. Devices get a Cockpit and a **Carry** slice (stopped-at note, open questions, captures into an exploration, **Open next** replacing Dirigible's `f` focus toggle), never a Deep mode (14 §8.1). The Lee-main Feed stays in memory (v2 decision 24): its sources persist their own state, so the `.hester/cockpit/` feed log is not planned.
8. **Later:** PR checks against goals.

*Decision 2026-09-25:* v2 is built immediately after v0/v1 rather than after the two-week v0 baseline. The v0 success test is therefore read against a confounded baseline: `peek_rate`, `attention_latency` and `focus_interruptions` will reflect v0–v2 together.

## 16. Open questions

Resolved:
- ~~Implicit tasks~~: tasks come from agent events, check-ins or explicit creation; automatic ones stay unconfirmed until you confirm or link them (§7.2).
- ~~Terminal tabs~~: terminal tabs are operations by default, and Hester can run things in them (§7.4).
- ~~Sharing~~: local in `.hester/` / `.lee/`, promoted into the repo only when asked (§12).
- ~~Q4 friction~~: one line at launch for new, unlinked, non-urgent work; no required reasons anywhere (§2.2, §2.3).
- ~~Enforcing quadrant defaults~~: quadrants no longer set permissions; the lead (`delegate`/`human`/`plan`) does, and it's applied at launch (§2.2).
- ~~Launcher default~~: the button (or prefix) always wins; Hester's view is an after-the-fact suggestion (§6).
- ~~Report compliance~~: nothing depends on the agent; `lee-status` is optional enrichment (§4).
- ~~Play budget~~: cut; play is uncapped and shown as a positive band (§2.3).
- ~~Local model capability~~: the local model only prepares, and only while you're idle (§1.3, §11.2); thinking is cloud and on demand, so its limits matter little.
- ~~Lint rule authoring~~: lint is deterministic only; projects add regex or ast-grep rules in `.lee/lint/` (§10.5).
- ~~Check-in format~~: check-ins ask for the optional `lee-status` block; hook events never depend on it (§4).

Open:

- **Idle detection for agents without hooks:** the `state` heuristic (prompt detection plus quiet time) needs a pattern for each agent CLI. Should these live in the TUI definitions in config (`prompt_pattern:`)?
- **Urgency sources:** beyond Lee's own signals (failures, regressions, blocked agents, `due:`), should external sources count, e.g. GitHub issues labelled urgent, or PR review requests?
- **Agent spend:** `background_leverage`'s guard needs spend per accepted result. Claude Code transcripts carry token usage; is that enough, or does Lee need provider billing data?
- **Waiting limit:** 20 minutes before a non-focus waiting item becomes blocking is a guess. Per agent? Per lead?
- **Away-policy defaults:** when should the single summary arrive by default, and what may be marked "wake me for this"?
- **Operation confirmation:** which operations need a confirm step (flash, install, deploy)? Declared per operation (`confirm: true`) or inferred?
- **Goal evaluation cadence:** on demand only, on a schedule, or triggered by merges to main? (Copilot mode covers "while idle".)
- **Multiple windows on one workspace:** one shared Cockpit model with per-window view state?
