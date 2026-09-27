# Goals

What Lee and Hester are for, how we'll know, and what we trade off.

This file is deliberately independent of any spec or design: it says what success looks
like, not how to build it, so designs can be evaluated against it without circularity.
Agents may propose edits; only a human commits them. Metric readings live outside this
file (`.hester/goals/metrics.jsonl`), so its history records only changes to definitions.

**Format rules**

- IDs are stable. Priority is the order in this file, not the number.
- Every metric states its **kind** (runnable: computed from recorded signals; proxy:
  runnable but only loosely tied to the goal; judged: a human answers a question), its
  **signal** (what it's computed from), and whether that signal is **available** today.
- Every metric with a "rising" target has a **guard**: a metric that must not get worse
  while it rises, so it can't be satisfied by doing something harmful.
- Every tension names the **arbiter**: the metric that decides it. The arbiter must
  observe both sides of the tension.
- Constraints have telemetry too; a constraint no one measures is a hope.
- Evaluating a design against this file is two-sided: for each part, name the metrics it
  moves (and in which direction) *and* the metrics it costs.

## Constraints

- **C1 Local-first.** Core editing works with no network. Nothing leaves the machine
  unless you asked for it: cloud models run only on demand.
  - telemetry: outbound model or network calls not caused by a user action. Target: 0.
  - available: no; needs a model/network call log with the triggering action.
- **C2 Quiet while you work.** No model runs automatically while you're active.
  - telemetry: model calls (local or cloud) while you're at the machine and not caused by
    a user action. Target: 0.
  - available: no; same call log, plus at-the-machine presence.
- **C3 The human decides.** Hester never commits, approves, or edits tracked files on its own.
  - telemetry: commits, approvals and tracked-file writes by Hester or its jobs without a
    user action. Target: 0.
  - available: partly; git history plus an action log.

## Goals (in priority order)

G1 (friction), G4 (focused bursts), G2 (managed agents) and G3 (Hester's value) are all
means to G0: they make room for deep work.

### G0 Deep work

Hard thinking is the work that matters most: a blank page, reading and research,
sketching and marking up, working a problem until it gives. Lee makes room for it,
supports it while it happens, and gets out of the way, including by encouraging
you to stop. Every other goal exists to make room for this one.

Deep work includes play and rapid prototyping, and slow, steady progress on what's
important but not urgent. It often continues away from the machine; ending a
session well is part of it.

- metric: **session_depth**: at the end of a session, one tap: deep, mixed or shallow.
  "Deep" means your brain hurts a bit, in a good way.
  - kind: judged
  - signal: the ending ritual's rating (Deep sessions' focus.end)
  - available: yes (Deep D1)
  - target: share of sessions rated deep rising
  - guard: deep_time not falling
- metric: **deep_time**: minutes per week in Deep sessions with input (writing, coding
  by hand, reviewing, marking up, reading with scrolls or selections), not just open.
  Hops to the Cockpit during a session neither count toward it nor end it.
  - kind: proxy
  - signal: deep.input events from the event log
  - available: yes (Deep D1)
  - target: rising
  - guard: total active hours not rising, and session_depth not falling
- metric: **turn_churn**: prompts sent to an agent within 2 minutes of that agent's
  previous turn ending, per active hour. "One more turn," measured directly.
  - kind: runnable
  - signal: agent.prompt and agent.turn_end hook events
  - available: yes, for Lee-launched Claude sessions
  - target: falling
  - guard: background_leverage not falling
- metric: **time_to_deep**: in sessions rated deep, time from opening Lee (or
  returning to the machine) to the first input in Deep mode.
  - kind: runnable
  - signal: presence, focus.start and deep.input events
  - available: yes (Deep D1)
  - target: falling

### G1 Humane, fun development

Lee makes orchestration easy and centers human creativity and exploration. People are
rarely creative when they're mired in drudgery or overwhelmed with frustration, so
development should be fun. Lee and Hester curate the balance between the possibility of
invention and the practice of hard work:

- **Remove bad friction.** Irritation (flaky environments, repeated failures, waiting,
  babysitting agents, the tool itself breaking) and monotony (chores, re-running the same
  commands, approving trivia, ceremony) lead to busywork and wasted potential. Automate
  them away.
- **Keep good friction.** Hard problems you chose, pushback on your ideas, and challenges
  worth overcoming are where inspiration comes from. Don't automate them away; make room
  for them.

The operator spends more time developing novel ideas, working on strategy, playing, and
engaging with the world, and less managing environments or babysitting agents.

- metric: **peek_rate**: times per active hour you look at a running agent's output
  without typing anything, while the agent isn't waiting on you. Babysitting, measured
  directly.
  - kind: runnable
  - signal: focus and input events per tab, plus agent state
  - available: no; needs per-tab focus and keystroke counts (not content) and agent state
  - target: falling
- metric: **toil_load**: bad-friction events per active hour, counted from events
  whether or not anything detects them: repeated manual command sequences, restarts,
  repeated approvals of the same action, flaky-operation reruns, and **ceremony** (every
  confirm, required field, assignment, snooze or dismissal the tools ask of you).
  - kind: runnable
  - signal: event log of commands, approvals, operation runs and UI actions
  - available: no; needs an event log
  - target: falling
- metric: **tool_failures**: Lee or Hester features that errored, hung or silently did
  nothing when used, per week.
  - kind: runnable
  - signal: error logs (`~/.lee/logs`) plus user "this is broken" reports
  - available: partly (logs exist; attribution to a user action doesn't)
  - target: falling
- metric: **creative_share**: share of active time spent originating (exploring ideas,
  writing or editing by hand, planning, research, steering and reviewing agent results)
  vs managing (approvals, environment fixes, restarts, peeking at running output).
  - kind: proxy
  - signal: focus and input events per tab and activity type
  - available: no; same event log as peek_rate
  - target: rising
  - guard: total active hours not rising (more time in the tool isn't the goal)
- metric: **catch_up_time**: time from returning to the machine after ≥ 30 min away to
  your first steering action (starting work, replying to an agent, editing).
  - kind: runnable
  - signal: at-the-machine presence and the event log
  - available: no; needs presence and the event log
  - target: falling
  - guard: work started right after returning isn't discarded or reverted more often
- metric: **weekly_retro**: two questions once a week: "ideas or plumbing?" and "where
  was I stuck in a good way, and where in a bad way?"
  - kind: judged
  - available: no; needs a weekly prompt

### G4 Focused bursts, from anywhere

Agentic development isn't a contiguous process. Agents do long stretches of background
work; humans contribute in discrete, **high-focus** sessions: deciding, inventing,
steering. Lee is built for that rhythm. Human sessions are protected from interruption and
start with everything ready; between sessions, agents keep working without needing to be
watched.

Aeronaut and Dirigible exist so those sessions can happen **anywhere**. They began as ways
to babysit agents; they become places to be creative: capture an idea, answer a decision,
start background work, review what shipped. Monitoring is what they do least.

- metric: **focus_interruptions**: everything that interrupted a declared or detected
  focus session, per session, including blocking items.
  - kind: runnable
  - signal: focus sessions and the attention queue in the event log
  - available: no; needs focus sessions and an attention queue
  - target: ≤ 1 per session
- metric: **background_leverage**: agent busy time (working, not waiting on you) whose
  result you accepted, per hour of your focus time.
  - kind: runnable
  - signal: agent turn start/end, task outcomes, focus sessions
  - available: no; needs agent turn events and accepted/discarded outcomes
  - target: rising
  - guard: agent spend per accepted result, review time per accepted result, and the
    share of accepted work later reverted, all not rising
- metric: **device_creative_share**: share of Aeronaut and Dirigible actions that are
  capturing, deciding, starting work or replying to an agent, vs viewing tabs, approving
  and reading output.
  - kind: runnable
  - signal: device requests, attributed per device
  - available: no; all clients share one API token today, so requests can't be attributed
  - target: > 50%
  - guard: device sessions per day and device sessions outside chosen hours, not rising
- metric: **capture_pickup**: share of ideas captured away from the desk that you later
  reviewed and acted on (explored, promoted, or explicitly dropped).
  - kind: runnable
  - signal: capture records and later human actions on them
  - available: no; the existing capture command is broken
  - target: ≥ 70% within two weeks

### G2 Better than one-off agent sessions

Lee is where agentic development is managed, not just where code is edited: work is
visible, attributed and steerable across agents, days and projects.

- metric: **attributed_agent_time**: share of agent busy time linked to a goal, a
  multi-step plan, or a task you confirmed (automatic links don't count).
  - kind: runnable
  - signal: agent turn events plus links you made or confirmed
  - available: no; needs agent turn events and links
  - target: ≥ 60%
- metric: **attention_latency**: median time from an agent starting to wait on you to
  your response, measured the same way before and after any change.
  - kind: runnable
  - signal: the agent's own "waiting" event (Claude Code's Notification hook) and your reply
  - available: no; the hook isn't installed yet. Baseline once it is, before other changes.
  - target: falling
  - guard: focus_interruptions not rising
- metric: **lost_threads**: explorations and tasks that stopped with no outcome and no
  decision recorded. Ending something deliberately, with or without a reason, isn't lost.
  - kind: runnable
  - signal: item records with last-activity times
  - available: partly (workstream records exist; tasks and durable explorations don't)
  - target: falling

### G3 Hester is distinctly valuable

Hester is worth having *alongside* coding agents because it does what they can't: knows
what you're working on at an overview level, tracks your patterns and habits, and nudges
you to be aware of what you're building and why. None of these metrics reward Hester for
writing code.

- metric: **nudge_acceptance**: Hester's nudges acted on through the nudge's own fix,
  divided by all nudges shown (acted on, dismissed, or ignored).
  - kind: runnable
  - signal: nudge outcomes
  - available: no; needs outcome recording
  - target: ≥ 40%
- metric: **pull_usage**: times per week you ask Hester for judgment (what next, evaluate,
  ask about an item). Asking, not being told, is the honest signal of value.
  - kind: runnable
  - signal: user-triggered Hester requests by type
  - available: partly (requests are logged; not by type)
  - target: rising over the first month, then steady
  - guard: nudge count per week not rising (pull shouldn't be driven by push)
- metric: **human_balance**: share of *your* focus time spent on important work (work
  that serves a goal here), whether urgent or not. Agent time doesn't count.
  - kind: runnable
  - signal: focus sessions and the goal links of the items they were on
  - available: no; needs focus sessions and goal links
  - target: ≥ 50%
- metric: **surprise**: once a week: "did Hester show me something about my work I didn't
  already know?"
  - kind: judged
  - available: no; needs a weekly prompt

## Tensions

- **G0 vs G2 (deep vs attention latency):** nothing interrupts Deep mode, so agents wait
  longer. Default: agents park during Deep; attention_latency is measured separately inside
  and outside Deep sessions, and only outside is expected to fall. Arbiter: session_depth
  together with attention_latency outside Deep.
- **G0 vs agency (deep vs checking in):** walling Deep off would raise deep_time on paper and
  make it feel unsafe to go deep at all. Default: the Cockpit is always one key away, and
  hops are never scored, nudged or counted against a session. Arbiter: session_depth (and
  deep_time over weeks), never hop counts.
- **G0 vs G1 (thinking vs finishing):** a blank page can be avoidance too. Default: Lee
  doesn't judge what you do in Deep mode; the ending ritual's rating is the check.
  Arbiter: session_depth and weekly_retro.
- **G1 vs G2 (management becomes toil):** features for managing agents can themselves
  become management work. Default: a feature that asks you to manage something must
  remove more toil than it adds. Arbiter: toil_load, which counts ceremony alongside toil.
- **Good friction vs delegation:** delegating everything can swallow the hard, interesting
  problems along with the chores. Default: delegate monotony, not challenge; "I'll do this
  one myself" is always valid and never flagged. Arbiter: weekly_retro ("stuck in a good way").
- **Play vs importance:** play is unimportant by definition and often where invention
  starts. Default: chosen play is protected and uncapped, and never counted as drift;
  only unchosen drift into busywork is. Arbiter: weekly_retro.
- **Less reading vs informed review (G1 vs C3):** reading agent output is toil, but the
  human deciding needs to review results. Default: reviewing a *finished* result (a diff, a
  report) is creative work; watching a *running* agent is toil. Arbiter: peek_rate (falls)
  with background_leverage's reverted-work guard (doesn't rise).
- **G4 vs G1 (anywhere vs away):** working from anywhere can turn into never being away.
  Default: devices are pull-first; only what's blocking the work you chose to wait on
  notifies you, and quiet hours are respected. Arbiter: device_creative_share's guard
  (sessions outside chosen hours).
- **G4 vs G2 (focus vs attention latency):** protecting focus delays everything else.
  Default: during focus, only items about what you're focused on (or waiting past a set
  limit) interrupt; the rest waits for the session boundary. Arbiter: focus_interruptions
  together with attention_latency.
- **G4 leverage vs cost and review:** more background agent time means more spend and more
  to review. Default: leverage only counts accepted results. Arbiter: background_leverage's guards.
- **G2 vs speed of one-offs:** managing agents must not make a quick session slower.
  Default: quick work needs zero required fields and no round-trip before it starts;
  structure is added after the fact. Arbiter: toil_load (ceremony) and catch_up_time.
- **G3 vs flow:** nudges can become noise. Default: fewer nudges; any nudge that's mostly
  dismissed or ignored is turned down automatically, and each item gets at most one nudge
  per change in its state. Arbiter: nudge_acceptance.
