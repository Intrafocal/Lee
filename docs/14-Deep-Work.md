# Deep Work: Lee as a place to think

> **Status:** Draft, 2026-09-26
> **Builds on:** `13-Copilot.md` (still being built). This spec changes 13's priorities: 13 makes steering cheap, and this spec says what that cheapness is for.
> **Proposes:** a new top goal, **G0 Deep work**, for `GOALS.md` (§1.1). Agents propose; the human commits.

## 0. Origin notes

The notes this spec grew from, kept as written:

> My hypothesis is that real human work is disrupted by interacting too much with coding agents.
>
> Cockpit is a good start, moves the babysitting job to Hester, at least in part. Capture/explore are good. Defining goals is even better.
>
> I expect real work though often involves HARD THINKING. That means blank sheet of paper. Or doing research on the web/reading books/watching videos. Lee and Hester should support and encourage this work.
>
> Deep work like this is a key goal. All our other goals about minimizing babysitting etc are to make room for this.
>
> I can tell I've been doing deep work when my brain hurts a bit (in a good way). I can tell I've been doing mindless work when I feel the need to constantly babysit, to poke agents, to say "one more turn."
>
> Play and rapid prototyping aren't distinct from deep work, they let us break out of the monotony of mindless work. Slow, steady progress (important but not urgent) is arguably even better.
>
> Taking time to think through an idea often means ending a session, going outside, taking a walk, making dinner. A good night sleep, reading a book, taking a shower. Some of our best ideas and problem solving happen in the unconscious.
>
> Lee exists to discourage the frenetic conscious mind's habits of busy work. Turning off Lee is a sign that the unconscious has time to work. While the unconscious works, Hester prepares for our next turn of conscious work.
>
> Hester's first goal on open should be: does the operator already have a deep work task in mind? If so, get them plugged into it right away. If not, suggest as many surfaces that could get their brain working in deep mode as possible, let them choose.

## 1. Why

13 treats the human as the bottleneck and makes steering cheap: one attention queue, agent tiles instead of terminals, digests, check-ins. That's necessary, but it isn't the point. **Cheap steering buys time; this spec is about what the time is for.**

The work that matters most is hard thinking: a blank page, reading, research, sketching a UI, working a problem until it gives. It's slow, it's often solitary, and much of it happens away from the machine. The habit it competes with is "one more turn": poking agents because it feels like progress.

So Lee takes a position:

1. **Deep work comes first.** On open, Hester's first question is whether you already have something to think about. Updates, digests and queues come after, and are a good way to break up a long session.
2. **Lee has a place to think.** A mode, **Deep**, next to the Cockpit and **Manual** (13's Workbench, renamed), with a surface for writing, a canvas for UI, a browser for research, and **Workbench**, a quiet code editor for hand coding and review (§3, §4).
3. **Hester is a tool, not a companion, while you think.** No chat sidecar. Hester acts on what you select, files things behind the scenes, and never asks for a reply (§5).
4. **Ending a session is part of the design.** Closing Lee after a good session is a win. Hester's preparation for next time is deterministic assembly of what you already left behind (§7, §8).
5. **Agency first, so deep work feels safe.** Checking on your agents is agency, not a lapse. Hopping from Deep to the Cockpit and back is normal, one key each way, and never counted against you (§3.1). Knowing you can look at any moment is what makes it safe to stop looking. Lee maximizes deep time by making it easy to return to, not by walling it off.

Play and prototyping count. Deep mode doesn't ask whether what you're doing is serious; it asks that you're doing it rather than watching agents.

### 1.1 Proposed goal: G0 Deep work

Proposed text for `GOALS.md`, placed above G1. In this framing G1 (friction), G4 (focused bursts), G2 (managed agents) and G3 (Hester's value) are all means to G0.

```markdown
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
  - available: no; needs the ending ritual
  - target: share of sessions rated deep rising
- metric: **deep_time**: minutes per week in Deep sessions with input (writing, coding
  by hand, reviewing, marking up, reading with scrolls or selections), not just open.
  Hops to the Cockpit during a session neither count toward it nor end it.
  - kind: proxy
  - signal: mode changes and input counts from the event log
  - available: no; needs Deep mode
  - target: rising
  - guard: total active hours not rising, and session_depth not falling
- metric: **turn_churn**: prompts sent to an agent within 2 minutes of that agent's
  previous turn ending, per active hour. "One more turn," measured directly.
  - kind: runnable
  - signal: UserPromptSubmit and Stop hook events (13 §4.1)
  - available: partly; hooks exist for Lee-launched Claude sessions
  - target: falling
  - guard: background_leverage not falling
- metric: **time_to_deep**: in sessions that go deep, time from opening Lee (or
  returning to the machine) to the first input in Deep mode.
  - kind: runnable
  - signal: presence, mode changes and input counts
  - available: no; needs Deep mode
  - target: falling
```

**New tensions:**

- **G0 vs G2 (deep vs attention latency):** nothing interrupts Deep mode, so agents wait longer. Default: agents park during Deep; `attention_latency` is measured separately inside and outside Deep sessions, and only outside is expected to fall. Arbiter: session_depth together with attention_latency outside Deep.
- **G0 vs agency (deep vs checking in):** walling Deep off would raise deep_time on paper and make it feel unsafe to go deep at all. Default: the Cockpit is always one key away and hops are never scored, nudged or counted against a session. Arbiter: session_depth (and deep_time over weeks), never hop counts.
- **G0 vs G1 (thinking vs finishing):** a blank page can be avoidance too. Default: Lee doesn't judge what you do in Deep mode; the ending ritual's rating is the check. Arbiter: session_depth and weekly_retro.

### 1.2 Goal check

Two-sided, per `GOALS.md`.

| Part | Moves | Costs | Phase |
|---|---|---|---|
| Deep mode with zero interruptions (§3) | G0 deep_time ↑, G4 focus_interruptions → 0 in Deep | G2 attention_latency ↑ while deep (by design, see tension) | D1 |
| Opener on the Copilot section (§6) | G0 time_to_deep ↓, G1 catch_up_time ↓ | Digest one scroll lower | D1 |
| Page + selection actions + ask, don't wait (§4.1, §5) | G0 deep_time ↑, G4 capture_pickup ↑, G2 lost_threads ↓ | Answers cost cloud spend on demand | D1 |
| Ending ritual (§7) | G0 session_depth measurable; G1 catch_up_time ↓ next time | One step per session (toil_load, small; skippable) | D1 |
| Browse with bookmarks and screenshots (§4.3) | G0 deep_time ↑ for research | None | D2 |
| Board, renders and markup (§4.2, §9) | G0 deep_time ↑ for UI thinking; G2 attributed_agent_time ↑ (spin-offs carry their exploration) | Local CPU for builds and simulators, on engagement only | D3 |
| Render resurfacing in the opener (§6, §9.4) | G0 time_to_deep ↓ | None | D3 |
| `⌘0` mode switcher, one-key hops, hops unscored (§3.1) | G0 deep_time ↑ over weeks (safety to go deep); G2 attention_latency held | None; the risk that hopping becomes babysitting is watched by turn_churn and peek_rate, not by the mode | D1 |
| **Manual** mode with no wall; the wall moves to the mode boundary (§3) | G1 toil_load ↓ (no wall repair or holds to fight); agency | peek_rate may rise in Manual; it's measured, not blocked | D1 |
| **Workbench** in Deep: tabs, multi-diff review, batched review comments, terminals (§4.4) | G0 deep_time ↑; G1 good friction (`human` lead has a home); G4 background_leverage ↑ (finished spin-offs reviewed in place); G0 turn_churn ↓ (batched replies) | `@codemirror/merge` and a diff view to build | D2 |
| Manual Focus retired into Deep (§3.2) | Removes a mode that overlaps (toil_load ↓) | Retrain one habit | D1 |

### 1.3 What this changes in 13

| 13 says | This spec says |
|---|---|
| Two modes, Cockpit and Workbench (§6.0) | Three modes: **Cockpit**, **Deep** and **Manual**. Workbench's hands-on half becomes a view inside Deep; its multiplexer half becomes Manual (§3) |
| The wall covers agent terminals inside Workbench, side panels included (§6.0, v2) | **No wall inside a mode.** Cockpit and Deep never show agent terminals; Manual shows everything; "go into" switches to Manual (§3) |
| Manual **Focus** toggle; blocking items still interrupt (§5.1) | Manual Focus becomes **Go deep**. Deep has no interruptions at all. Inferred focus stays, in Manual, with 13's rules (§3.2) |
| Session start shows the digest (§5.1, §8.1) | Session start shows the **opener** first; the digest sits below it (§6) |
| Default landing section is Feed (§6.0) | Default landing section is **Copilot**, which starts with the opener |
| Hester prepares while you're away with a local model (§11) | Preparation for deep work is **deterministic assembly** of what you left behind; model work happens when you click, during the session (§5.3, §8). Copilot mode is unchanged and optional for this |
| Explorations are a Seed and a Log in one file (§7.5) | An exploration gains a **Page**, a **Board**, **References**, **Answers** and a **Workbench** working set (§4.4, §10) |
| `⌘0` toggles Cockpit ↔ Workbench (keys pass, `docs/shortcuts.md`) | `⌘0` is a `⌘Tab`-style **mode switcher**; `⇧⌘0` Cockpit ↔ Deep, `⌥⌘0` Cockpit ↔ Manual; Reset Zoom loses `⇧⌘0` (§3.1) |
| A `human`-lead task has no surface of its own (§2.2, §2.3) | It opens in Deep's **Workbench** (§4.4) |
| Hester in the Cockpit is conversational (§8) | In Deep mode Hester is **not** conversational: selection actions and quiet arrivals only; `⌘/` stays for a quick question (§5) |
| v5 Copilot mode is next (§11, §15) | **Parked** (2026-09-26). Its deterministic jobs already run elsewhere, and its local-model jobs are what §5.3 and §8 replace. The daemon stops when Lee closes (§8), so it stays parked |
| v6 devices render the full Cockpit (§15) | After D1, so devices are built on Deep's attention model (§3.2) |
| Pinned nav items, later (§6.0) | Dropped; the opener covers them (§6) |

---

# Part I: Modes

## 3. Cockpit, Deep, Manual

*Decided 2026-09-26.* 13's Workbench tried to be two things: the familiar multiplexer (every tab, agent terminals included) and the place for hands-on work. Seeing an agent terminal beside your own code puts the two at the same level, and that's where babysitting starts. So Workbench splits:

- its **hands-on half** becomes **Workbench**, a view inside Deep: editor, diffs, your own terminals, no interruptions (§4.4);
- its **multiplexer half** becomes **Manual** mode: every tab, every agent, every TUI, full control, no wall.

| | **Cockpit** (steering) | **Deep** (thinking and making) | **Manual** (direct control) |
|---|---|---|---|
| For | Seeing and steering everything | Writing, research, UI thinking, coding by hand, review | Driving agents and tools by hand: the multiplexer Lee started as |
| Main area | The Cockpit sections | One exploration: Page, Board, Browse or Workbench (§4) | All tabs, splits and docks, as today |
| Agents | Live tiles | **Not shown.** Spin-offs report into the exploration | **Everything visible**, agent terminals included. No wall |
| Your terminals | In the drawer | In Workbench (§4.4) | Yes |
| TUIs (lazygit, lazydocker, k9s, btop…) | In the drawer | No | **All TUIs live here** |
| Interruptions | All, by severity | **None** | 13's rules: blocking only while focus is inferred (13 §5.1) |
| Status bar | Full | A neutral count and run results | Full |
| Hester | Copilot section, steward on demand | Action row, quiet arrivals, `⌘/` (§5) | `⌘/` palette |

**Why "Manual".** It says what the mode is (doing by hand what Hester and the Cockpit could do for you) the way a manual transmission is full control, not a failure. The name carries the gentle concern; nothing else does. Time in Manual is recorded and shown neutrally in the weekly retro as a mode split, and is never scored, nudged or linted (§3.1). Lee never opens in Manual; it opens on the opener (§6).

**The wall moves to the mode boundary.** 13 §6.0 walls agent terminals *inside* Workbench (entered PTYs, holds, wall repair in `cockpitMode.ts`, side panels included). That's replaced by a rule between modes: **Cockpit and Deep never show agent terminals; Manual shows everything.** "Go into" an agent from a Cockpit tile switches to Manual with that tab focused. This reverses the v2 decision that the wall covers side-panel agents; the friction of changing mode is the gentle friction now.

### 3.1 Switching

**Checking in on your agents is agency, and hopping between modes is normal.** Deep time is maximized by making Deep easy to leave and easy to return to, so the operator never has to choose between thinking and knowing. Switching is one key and keeps each mode's state.

Keys, following the ⌘-chord convention from the keys pass (`docs/shortcuts.md`: actions are ⌘ chords, bare keys are navigation only):

| Chord | Does |
|---|---|
| `⌘0` | **Mode switcher**, like `⌘Tab`. A quick tap returns to the last mode. Holding ⌘ shows three cards (Cockpit, Deep, Manual), each with a live one-line state ("2 waiting", "Workbench · api-server.ts:212", "6 tabs"); `0` again cycles; releasing ⌘ commits |
| `⇧⌘0` | Cockpit ↔ Deep |
| `⌥⌘0` | Cockpit ↔ Manual |
| `⌥⌘1`–`⌥⌘4` | Page / Board / Browse / Workbench inside Deep (§4) |

`⇧⌘0` is Reset Zoom today (`main.ts`, the View menu's `resetZoom` role); Reset Zoom keeps its menu item and loses the accelerator. `⌘=` / `⌘-` still zoom. No ⌥⌘ chords are registered today. The mode chip in the status bar shows the mode and opens the switcher on click. `⌘1`–`⌘9` keep switching tabs in Manual.

- Each mode remembers where it was: the Cockpit section, the exploration, view, file and cursor in Deep, the tabs in Manual.
- Entering Deep with no exploration open (a key, the switcher, Go deep) opens a **blank Page**: the running Deep session's exploration if there is one, else a new untitled exploration. *Revised 2026-09-27;* it used to send you to the opener's field. A device's Go deep with nothing open still shows the opener on the Mac (§8.1).
- Leaving Deep for a moment doesn't end the Deep session. The session ends through the ending ritual (§7), or after being away from the machine (13 §5.1 presence) for longer than `deep.idle_end_minutes` (default 45), which counts as an unrated ending. An extended session (§8.1) isn't idle-ended until its extension runs out.
- **Hops are never scored.** Time in the Cockpit or Manual during a Deep session is recorded (mode changes are events) but isn't subtracted, nudged, linted or shown back as a problem. `turn_churn` measures prompting agents the moment they finish, which can happen from any mode; looking is not churn.
- **Outside Deep, you see everything.** Parked items, approvals and waiting agents are all there, as usual. Deep holds interruptions; it never hides state from you when you go looking.
- **Coming back** to Deep after a hop is instant and exact: same view, same scroll, same cursor, same selection.

### 3.2 Focus becomes Deep

What Focus is today (v0/v1 code): an **attention state**, not a surface. `FocusState` (`electron/src/shared/copilot.ts`) is a session, manual or inferred, about a `FocusItem` (an agent, a set of files or a workspace). It holds non-blocking items, and starting it switches to Workbench (`nextMode` in `lib/cockpitModel.ts`). Two details show it was built for steering: an agent can be the focus item, and items about the focus item still interrupt.

Deep is what Focus was reaching for. So:

- **Manual Focus is retired.** "Start focus" in the status bar menu becomes **Go deep**. The `focus.start` / `focus.end` events and `FocusState` stay; a Deep session is a focus session with `source: 'deep'`, a new `FocusItem` kind `{ kind: 'exploration', id }`, and an attention policy of `none`.
- **Inferred focus stays**, in Manual only, with 13's rules. Sustained work in Manual is focused but not necessarily deep, and it needs no toggle. (Inside Deep, including Workbench, the Deep session is the focus session.)
- **Devices** (Aeronaut, Dirigible) show "In deep work" instead of "Focus" and hold notifications the same way. They have no Deep mode; they can only queue what the next session opens (§8.1).

### 3.3 Attention in Deep

- **Nothing interrupts.** Not approvals, not blocking items, not items past their waiting limit. Agents that need you park, as under the away policy (13 §5.1).
- **One exception you opt into:** items marked "wake me for this" (13 §5.1) still show as a single line in the Deep header, never a modal or sound.
- **Spin-offs from this exploration** (§5.1) report into its Answers tray, not the attention queue, unless they need you, in which case they park like any other agent.
- The status bar shows only `N waiting` in a neutral colour.
- `focus_interruptions` for Deep sessions should read zero; anything else is a bug.

---

# Part II: The Deep surface

## 4. One exploration, four views

Deep mode always has one **exploration** open (13 §7.5; the store already exists at `.hester/explore/`). The exploration is the unit of deep work: it holds your writing, your board, your references and Hester's answers, and it's what the next session reopens.

Four views, switched with tabs in the Deep header or `⌥⌘1`–`⌥⌘4` (§3.1). Page, Board and Browse always belong to an exploration; Workbench usually does, but can open without one (§4.4).

| View | For | You can |
|---|---|---|
| **Page** | Writing: a blank sheet, an outline, working a problem through | Write markdown; select text for actions (§5.1) |
| **Board** | Spatial thinking: renders of UI, screenshots, pinned references and answers | Place, arrange and mark up items with text boxes; select for actions |
| **Browse** | Reading and research | Browse the web, **bookmark** (save a reference) and **screenshot** (save an image to the Board); select for actions |
| **Workbench** | Writing code by hand; reviewing code | Edit with tabs; review diffs from spin-offs, tasks and the working tree; run your own terminals; select for actions |

### 4.1 Page

- A markdown editor (CodeMirror, as in `EditorPanel`), full width, generous margins, no line numbers, with a live preview toggle. It's the exploration's `page.md`.
- **A margin** on the right shows Hester's arrivals anchored to where you asked (§5.3), as small markers you can expand. Nothing in the margin moves the text or takes focus.
- Pasting a URL keeps it as a link and offers **Keep as reference** (§5.2). Pasting an image puts it on the Board and links it.
- The Page is yours. Hester never writes into it. Accepting an answer into the Page is an explicit **Insert** from the margin.

### 4.2 Board

- An infinite spatial canvas with items: **renders** (§9), **screenshots** from Browse, **pasted images**, **reference cards** (title, URL, your note), **answer cards** (§5.3) and **text boxes**.
- **Markup:** click anywhere on an image to drop a text box with a leader line to that point. Text boxes can also stand alone. That's the whole markup vocabulary for now: text boxes and arrows.
- Any item or text box can be selected for actions (§5.1). A text box on a render, spun off as a task, carries the image, the point and your note.
- Stored as `board.json` plus image files (§10). Lee draws it; the daemon only stores it.
- Implementation: a small canvas layer in the renderer (pan, zoom, drag, text boxes). A library such as tldraw or Excalidraw is worth evaluating against C1 and the renderer CSP before building one.

### 4.3 Browse

- The existing `BrowserPane` (webview, back/forward, URL bar), embedded in the exploration rather than as a tab. Its history for the session belongs to the exploration.
- **Bookmark** (`⌘D`, as in any browser; Deep isn't the Cockpit, so it doesn't clash with ⌘D deny): saves the page to the exploration's References with title, URL, time, and your current selection as a quote, if any. An optional one-line note.
- **Screenshot** (`⌥⌘S` proposed; `⇧⌘S` is Save As and `⇧⌘3`–`5` belong to macOS): saves the visible viewport, or a region you drag, to the Board as an image, with its URL. Uses the CDP `Page.captureScreenshot` path `browser-manager.ts` already has.
- **Select text** on a page for the same actions as the Page (§5.1).
- Navigation you do is never gated. Hester-initiated navigation keeps its domain approval (CLAUDE.md, Browser Tabs).

Videos and PDFs are whatever the browser shows. Dedicated readers (EPUB, timestamped video notes) are later, if at all.

### 4.4 Workbench

Writing code by hand and reading code carefully are deep work too. Workbench is a code editor built for that: an editor, a diff view and your own terminals, with nothing running that you didn't start and nothing asking for you. It borrows what VS Code and JetBrains do well and leaves out what works against the goals.

```
┌ Deep · mesh sync ─────────── Page  Board  Browse  [Workbench] ─────────────┐
│ WORKING SET   │ api-server.ts │ auth.test.ts │ context.ts │   │ REVIEW      │
│ ● api-server  │ api-server.ts › requireAuth                   │ ▸ Yours     │
│   auth.test   │                                               │    3 files  │
│ RECENT        │   editor (one file, or split into two)        │ ▸ Spin-off 2│
│   routes.py   │                                               │    ✓ done   │
│   explore.py  │                                               │    5 files  │
│               ├───────────────────────────────────────────────┤             │
│               │ TERMINAL  zsh · npm test                      │             │
└───────────────┴───────────────────────────────────────────────┴─────────────┘
  Deep · 2 waiting · Run ▸ tests ✓ 14s
```

**Layout.** JetBrains-style tool windows around the editor: **working set** on the left, **terminal** at the bottom, **Review** on the right. One key hides every tool window (JetBrains "Hide All Tool Windows", VS Code Zen), and Workbench opens with them collapsed except the working set. Editor **tabs** as usual, with at most a two-way split (VS Code editor groups).

**Navigation by keyboard:**

| Borrowed from | In Workbench |
|---|---|
| VS Code `⌘P`, JetBrains Search Everywhere | **Quick Open** (`⌘P`, free today): one fuzzy box for files, recent files and this exploration's references |
| JetBrains Recent Locations (`⇧⌘E`) | The **working set**: recently edited and viewed locations with a line of context each. The best "where was I" after a hop, and what the next session reopens |
| VS Code `⌃-`, JetBrains `⌘[` / `⌘]` | **Back / forward** through locations, scoped to Workbench |
| VS Code `⌃Tab` | Most-recently-used tab switching |

**Review:**

| Borrowed from | In Workbench |
|---|---|
| VS Code multi-diff editor | Every changed file in one scrolling view, each collapsible, each with a **Viewed** checkbox. How you review what an agent produced without opening files one by one |
| JetBrains changelists | The **Review** panel groups changes by who made them: **Yours** (the working tree against `HEAD`), and each finished spin-off or task in `review` (its worktree diff, 13 §7.2), as its own group. 13's scope, shown where you review |
| GitHub PR review | **Batched review comments** (below) |
| Both | Side-by-side or inline diff, toggled |

**Review comments are batched.** While you read a diff, comments on lines pile up as drafts. When you're done reading, **Send review** delivers them all to the task's agent as **one** message through 13's Reply, with the full text shown first (C3). One considered reply instead of five pokes is the direct counter to `turn_churn`. If the agent is gone, Send review becomes a spin-off seeded with the comments and their lines. A comment can also be **Captured** or **Kept** as a note on the Page instead of sent.

**Context actions.** JetBrains `⌥⏎` and VS Code `⌘.` both answer "what can I do here?". In Lee that's the action row (§5.1), on **`⌘.`** in every Deep view: Ask about these lines, Spin off "do this here", Capture, Keep.

**Terminals.** The bottom panel holds **your** shells (VS Code's integrated terminal, `` ⌃` `` to toggle). If an agent starts in one (you type `claude` or `pi`), it becomes an agent (13 §7.6): its tile appears in the Cockpit and the Workbench terminal shows one line, "agent running · `⌥⌘0` to drive it in Manual". Deep never shows agent output. TUIs (lazygit and the rest) belong to Manual; running one by hand in a Workbench terminal is your call.

**Running things.** JetBrains run configurations are Lee's operations (13 §7.4). **Run ▾** (`⌘{`, as in the Cockpit) starts one and a rerun key repeats the last; results arrive quietly in the status bar and a Run tool window.

**Hand coding.** A task with `human` lead ("I'll do this one myself", 13 §2.2) opens in Workbench. Good friction finally has a home.

**Without an exploration.** Workbench can open on its own (from the switcher, or a file link) when you just want to write code. Its working set is then kept per workspace, and the Deep session still has an ending ritual. **Explore** on the action row, or **Attach to exploration**, links it later.

**Left out, because of the goals:**

- **Inline AI completions (ghost text).** A model on every keystroke breaks C2, and hand coding is the good friction G1 protects. Hester in Workbench is `⌘.` and `⌘/`, both on demand.
- **Notification toasts, extension popups, activity badges.** Deep has no interruptions.
- **Full IDE chrome.** Four surfaces are enough: working set, editor, terminal, Review.

**Later:** taking a single hunk from an agent's worktree diff into your tree (JetBrains' `>>` apply chunk); JetBrains-style **Local History** (automatic snapshots, "this file 20 minutes ago"), a safety net when you and an agent touched the same file; language servers (go-to-definition, diagnostics), which Lee's CodeMirror editor doesn't have. The diff views need `@codemirror/merge`, which isn't installed yet.

Saves are ordinary saves (`⌘S`). Workbench changes no git state by itself; commits happen in a terminal or in Manual (lazygit).

---

# Part III: Hester in Deep mode

## 5. A tool, not a companion

There is **no Hester sidecar** in Deep mode. A chat panel is a smaller copy of the thing Deep mode is for escaping. Instead Hester works on what you point at, files things behind the scenes, and never asks for a reply.

The rule: **nothing Hester does in Deep mode requires a response.**

### 5.1 Selection actions

Select text (Page, Browse, Workbench), an item or a text box (Board), and a small action row appears beside the selection. It disappears when the selection does.

**Keys.** A bare letter would type over the selection, and bare-key actions are what the keys pass removed from the Cockpit. So the row is reached with **`⌘.`** (free today, and VS Code's quick-fix chord; JetBrains' `⌥⏎` is the same idea): it moves keyboard focus into the row, where the letters below pick an action, like menu mnemonics, and Esc returns to the text with the selection intact. Clicking works without `⌘.`.

| Action | Key in the row | What happens | Model? |
|---|---|---|---|
| **Capture** | `c` | Saves the selection to Someday with its source (exploration, URL or file, surrounding text) | No |
| **Keep** | `k` | Adds it to this exploration's References (a quote, a link, an image) | No |
| **Ask** | `a` | Opens a one-line field pre-filled with nothing; you type a question (or just press Enter to ask "explain this"). It's queued; the answer arrives later (§5.3) | Yes, on demand |
| **Spin off** | `s` | Starts a background agent task (13 §7.2, `delegate` lead) seeded with the selection, its source and the exploration's title. You never see its terminal | Yes, on demand |
| **Explore** | `e` | Starts a new exploration seeded from the selection, linked to this one. It doesn't switch; it's for tangents you want to park | No |

Everything here is a click or a key you pressed, so every model call is on demand (C1, C2) and logged with its trigger.

### 5.2 Affordances while you type

Some things are worth offering without a selection. They're **deterministic**, never model-driven (C2), and they appear as a small, dim button at the end of the line, never a popup:

| Pattern | Offers |
|---|---|
| A line ending in `?` | **Ask** (the line is the question) and **Mark as open question** |
| A pasted or typed URL | **Keep as reference** |
| A line starting `later:` or `someday:` | **Capture** (the rest of the line) |
| A line starting `todo:` or `agent:` | **Spin off** |
| A line starting `render:` followed by a render target name | **Render** (§9) |

The button fades after a few seconds or when you keep typing. Accepting any of them is one click; ignoring them costs nothing. Rejected or ignored affordances feed the same outcome counts as lint (13 §10.3), so a pattern that's always ignored turns itself down.

### 5.3 Ask, don't wait

Asking is fire-and-forget:

1. You ask (a selection action, an affordance, or the `?` button). The question is recorded in the exploration with its anchor (the selection, the Page position, the Board item).
2. Hester answers **in the background**, with the exploration as context: the Page, References, the Board's text, the anchor. It runs as an ordinary on-demand request on a new surface, `deep-ask` (13 §3 implementation note): the steward is **off**, and cloud or local routing follows Hester's existing rules.
3. The answer **arrives quietly**: a marker in the Page margin at the anchor, a card on the Board next to the item, and a count in the Deep header's **Answers** tray. No sound, no toast, no focus change.
4. You read it when you reach a pause. From the margin or card: **Insert** (into the Page, quoted and attributed), **Keep** (to References), **Pin** (to the Board), **Follow up** (asks again, same anchor) or **Dismiss**.

**Spin-offs work the same way.** A spun-off agent's result (its final summary, `lee-status` block and diff stat, 13 §4.1) arrives as an answer card. If it needs you, it parks (§3.3); its card shows "waiting on you" without escalating.

This is how Hester's thinking work moves **into the session**. Instead of Hester guessing between sessions what you'll want, you ask as the question occurs to you, keep working, and the answers are ready by the time you look. By the time you end the session, most of what "preparation" would have done is already done, by request.

### 5.4 Behind the scenes

Deterministic, no model:

- **References** are grouped by domain and by the Page section you were writing when you kept them.
- **Browse history** for the session is attached to the exploration (URLs and titles, not content).
- **Captures** carry their source, so a Someday item remembers which exploration and passage it came from.
- **Open questions**: lines ending in `?` that you marked, and Asks you haven't read, are listed in the exploration's header.
- **Links**: explorations spun out of this one, tasks spun off from it, and renders pinned to it are recorded as links (13 §2.1), so the exploration is where its work can be traced back to.

### 5.5 The palette stays

`⌘/` still opens the command palette for a quick question when you really do want an answer now. It's the one conversational surface in Deep mode, and it's one you summon. Its answers can be sent to the exploration (**Keep**, **Pin**) from the palette.

---

# Part IV: Sessions

## 6. The opener

The Copilot section becomes the default landing section (replacing Feed, 13 §6.0), and its top is the **opener**. Hester's first job on open (and on return after being away) is one question: **do you already have something to think about?**

```
┌ Copilot ──────────────────────────────────────────────────────────────────┐
│  What's on your mind?  [ type to start, or pick below ______________ ]  ↵ │
│                                                                           │
│  Pick up where you left off                                               │
│   ▸ Mesh sync conflicts · "…the vector clock only helps if every write"   │
│     3 answers arrived · 1 spin-off finished · 2 open questions            │
│                                                                           │
│  Or start from                                                            │
│   ✎ Blank page        ? Open questions (4)      ▣ Renders (2 stale)       │
│   ⌁ Captured away (3) ☰ Reading list (7)        ◇ Q2: G1 has had no work  │
│   ~ Quiet explorations (2)                                                │
├───────────────────────────────────────────────────────────────────────────┤
│  Since you left… (digest, 13 §8.1)                                        │
└───────────────────────────────────────────────────────────────────────────┘
```

- **Yes:** type into "What's on your mind?" and press Enter. If it matches an exploration's title, that one opens; otherwise a new exploration is created with your text as its seed and the Page open with the cursor below it. One keystroke from Lee opening to writing.
- **Pick up where you left off:** the last Deep session's exploration, with its "stopped at" note (§7) and what arrived since. Enter opens it at the cursor.
- **Or start from:** every surface that could get your brain working, in a fixed order, each only shown if non-empty. Picking one opens Deep mode on it:

| Surface | Source (all deterministic) |
|---|---|
| **Blank page** | Always present. A new exploration with no seed |
| **Open questions** | Marked `?` lines and unanswered follow-ups across explorations |
| **Renders** | Render targets with a render older than their last source change, or pinned renders you haven't looked at in a while (§9.4) |
| **Captured away** | Someday items captured from devices since your last session (13 §5.1) |
| **Reading list** | References kept but not yet opened, across explorations |
| **Q2** | The digest's Q2 candidates (13 §2.2): a goal nothing serves, an evaluation due |
| **Quiet explorations** | Active explorations untouched for a week or more |

The opener recommends nothing and ranks nothing beyond "where you left off" first; Hester's opinion is still one click away (**What next?**, 13 §8.1). Choosing is yours.

**Cockpit updates come after.** The digest and the needs-you queue sit below the opener. If something is genuinely blocking (an operation crashed, an agent past its limit), the needs-you pill in the status bar shows it as usual; the opener doesn't hide it, it just doesn't lead with it.

## 7. The ending ritual

A session ends when you choose **End session** (Deep header or the status bar mode chip menu). It has no chord, on purpose: ending is deliberate, and mode hops must never end a session by accident. One small sheet:

1. **Where did you stop?** Pre-filled with the last sentence you wrote on the Page. Edit it or leave it. (Stopping mid-thought is a feature: it's the easiest place to restart.)
2. **Open questions:** the `?` lines from this session, each with a checkbox to keep open.
3. **How deep was that?** Deep / mixed / shallow. One tap, optional. This is `session_depth` (G0).
4. **Anything for agents while you're away?** Optional. It's 13's handoff (§5.1) pre-filled with this session's `todo:` lines and unfinished spin-offs.
5. **Close Lee** (the default button) or **Stay open**. If Asks are still running, the sheet says so in one line ("2 Asks still running. Closing Lee stops them; they'll come back as Retry") and **Stay open** becomes the default, so Enter never quietly stops work.

Nothing is required, and **Esc** ends the session without the sheet (recorded as an unrated ending). There are no timers, no break reminders and no "you've been deep for two hours" cues. Lee's encouragement to stop is that stopping is easy and leaves things in a good state.

## 8. Between sessions: deterministic preparation

Hester's preparation for the next session is **assembly, not generation**. Everything the opener shows (§6) is computed from records: the "stopped at" note, open questions, answers and spin-off results that arrived after you left, captures from devices, kept-but-unread references, stale renders, Q2 candidates.

This works because the thinking already happened during the session, when you asked (§5.3). Answers and spin-offs that were still running when you ended finish on their own and are waiting when you return.

- **No model runs between sessions for deep work.** Copilot mode (13 §11) is parked, and ProactiveWatcher's model tasks stay off unless a workspace enables them (13 §14). The opener never depends on either.
- **Lee can be closed, and closing it stops everything.** *Decided 2026-09-27:* the daemon stays a child of Lee main. In-flight Asks and spin-offs (D2; their agent processes are Lee's PTYs) stop with it, are recorded as interrupted, and are offered as **Retry** in the opener. A spin-off retried this way resumes from its worktree rather than starting over. Nothing is lost silently.
- **Devices feed the loop.** An idea captured on Dirigible during a walk (13 §5.1) lands in "Captured away", which is exactly the unconscious-to-conscious handoff the origin notes describe.

### 8.1 Devices: carry, not Deep

*Decided 2026-09-26.* Neither device gets a Deep mode. A phone screen and a T-Deck aren't places for hard thinking at length, and Deep work happens at the machine. But the devices are what you have with you during the other half of the loop, the walk, the shower, dinner (§0), so they carry the exploration out of a session and bring thoughts back into the next one.

| | **Aeronaut** (phone) | **Dirigible** (T-Deck) |
|---|---|---|
| **Cockpit** (first screen; 13 §5.1, §5.2) | Needs-you queue with quick-reply chips; **review wins** visually (diffs, and renders once D3 exists); launch from Someday or a template | One item per page; read an agent's full reply with the trackball and write a considered reply; capture a sentence |
| **Carry** | The last session's stopped-at note and open questions, read-only; the **reading list** (kept references not yet opened, §4.3), because reading is research | The stopped-at note and open questions; capture a longer thought **into an exploration** (a paragraph suits the keyboard) |
| **Manual** | Terminals and files, one level down (exists) | Terminal and tabs screens (exists) |
| **Deep** | A state, not a mode: "In deep work" | Same |

- **Carry flows into the opener.** Anything captured on a device lands in **Captured away** (§6), and a capture made into an exploration shows under **Pick up where you left off** with that exploration.
- **Open next.** A device can pick what the next session opens first: an exploration or a captured thought. The opener puts it at the top of "Pick up where you left off". This replaces the device Focus toggle (Dirigible's `f` key, `screen_waiting.cpp` `focus_toggle`), since Deep can't start remotely.
- **No bypass while you're deep.** While a Deep session is running at the machine, devices get no pushes either; agents park (§3.3) and the device header says "In deep work". Pulling the phone out and replying is a hop: agency, never scored (§3.1). `turn_churn` counts prompts from every surface, so poking agents from the phone shows up where it should.
- **After the ending ritual** the away policy applies as 13 §5.1 says: at most one summary, and wake-me items only. The ritual's handoff step (§7) is where you set it.
- **Idle-end push** (*decided 2026-09-27*, with 13 v6). When a Deep session is about to end from idleness with Lee still open (a few minutes before `deep.idle_end_minutes`), the devices get **one** push: **Extend** (another 45 minutes, for the walk that's still thinking), **End and rate** (deep / mixed / shallow, plus an optional stopped-at note on Dirigible), or **Capture** a thought into the exploration. Ignoring it ends the session unrated, as today. At most one per session, never in quiet hours; Dirigible uses plain letters (`e` extend, `d`/`m`/`s` rate, `c` capture). It's the only push Deep ever sends, and it arrives when you're already away.
- **`device_creative_share`** (G4) gets its best source: captures made away from the machine that feed the next Deep session.

**Compatibility in D1.** Devices aren't changed in D1, and today's firmware and app keep working: `focus_active` stays true during a Deep session, so they hold notifications correctly; the snapshot gains `mode` and `deep: { exploration_id, title } | null` for v6; the focus-set endpoint devices call keeps working, and "start" means Go deep with no exploration (the Mac shows the opener).

**Phasing.** Device surfaces are 13's v6, built after D1 on this model. The reading list needs D2's references, so it comes after D2.

---

# Part V: Renders

## 9. Renders

UI is easier to think about when you can see it and mark it up. Lee detects the things in a workspace that can be rendered, renders them when you're thinking about them, and puts the images on the Board.

### 9.1 Render targets

Detected like operations (13 §7.4; `electron/src/main/cockpit/ops-detect.ts` already scans `package.json`, `Makefile`, `pyproject.toml`, ESP-IDF and `pubspec.yaml`), and confirmed once before they're used:

| Target | Detected by | Render recipe |
|---|---|---|
| **Web UI** | A dev-server script (`dev`, `start`, `serve`) in `package.json`, a Vite/Next/Storybook config | Start or reuse the dev server operation; capture routes with a headless browser (Electron's offscreen `webContents` or Playwright) |
| **Flutter app** | `pubspec.yaml` with a `flutter:` section | Golden screenshots via `flutter test` with a render harness, or a running simulator's screenshot |
| **iOS / macOS app** | `*.xcodeproj` / `*.xcworkspace` | `xcrun simctl io booted screenshot` against a booted simulator; build first if stale |
| **Storybook** | `.storybook/` | Capture stories by id (the most reliable web target, since stories are addressable) |
| **Electron (Lee itself)** | `electron/package.json` with an Electron dependency | Screenshot of a Lee window or a harness route |
| **KiCad / STEP** | `.kicad_sch`, `.kicad_pcb`, `.step` | Lee's existing viewers (`KiCadPane`, `ModelViewerPane`) rendered offscreen |

A target has a name, a recipe, and **views**: routes, story ids, screens or files. Views are discovered where the framework makes that cheap (Storybook stories, Next pages, Flutter golden tests) and otherwise added by hand. Confirmed targets live in `.lee/config.yaml`:

```yaml
renders:
  - name: aeronaut
    kind: flutter
    cwd: aeronaut
    recipe: golden             # golden | simulator
    views: [home, pairing, attention_item]
  - name: cockpit
    kind: web
    operation: dev-server      # reuse an operation (13 §7.4)
    base_url: http://localhost:5173
    views: ["/#cockpit", "/#cockpit/tasks"]
```

Detection, like operations, only **suggests**. Nothing is rendered from an unconfirmed target.

### 9.2 When rendering happens

Renders run **on demand, when you're thinking about them**, never on a timer:

- **Render** on a target or view (Board toolbar, a `render:` affordance, or the opener's Renders surface).
- **Opening an exploration** that has renders pinned re-renders the ones whose source has changed since (git: any commit or working-tree change under the target's `cwd`), in the background. The old image stays until the new one arrives, and both are kept so you can compare.

Rendering uses no model, so C2 doesn't apply, but it does use the machine: builds and simulators run at lowered priority, one render job at a time, and a render never starts a long-running operation you didn't already have running without asking once per session.

### 9.3 Marking up

Renders are Board items (§4.2). Click on one to drop a text box pointing at that spot. Text boxes on renders are the main way UI thinking turns into work:

- **Spin off** a text box: a task with the image, the point, the view name and your note ("this spacing is off; the tiles should wrap at 3").
- **Capture** it: a Someday item with the image.
- **Leave it**: it stays on the Board as a note for next time.

### 9.4 Resurfacing

Renders are also a way into deep work. The opener's **Renders** surface (§6) shows targets whose latest render is stale, and pinned renders with open text boxes. A render of a screen you haven't looked at in two weeks is a good prompt to think about it.

---

# Part VI: Shared

## 10. Data and storage

An exploration grows from one file into a directory. The existing single-file format (`hester/daemon/cockpit/explorations.py`) migrates on first open.

```
.hester/explore/<id>/
  exploration.md        # frontmatter + Seed + Log (today's format, unchanged)
  page.md               # your writing (§4.1)
  board.json            # items, positions, text boxes, links to images (§4.2)
  images/               # renders, screenshots, pasted images (with source metadata in board.json)
  references.jsonl      # bookmarks and kept quotes: url, title, quote, note, section, at (§4.3, §5.4)
  answers.jsonl         # asks and spin-off results: anchor, question, answer, status, at (§5.3)
  sessions.jsonl        # Deep sessions: start, end, stopped-at note, depth rating, questions kept (§7)
```

| Data | Location | Tracked in git? |
|---|---|---|
| Explorations (all of the above) | `.hester/explore/<id>/` | No |
| Render targets | `.lee/config.yaml` `renders:` | No |
| Render history | `.hester/explore/<id>/images/` for pinned renders; `.hester/renders/<target>/` for the latest per view | No |
| Deep mode and session events (mode changes, input counts, affordance outcomes) | `~/.lee/events/` (13 §12) | No |
| G0 metric readings | `.hester/goals/metrics.jsonl` | No |

As in 13 §12: local by default, promoted on request. "Write this up" on an exploration proposes where its Page belongs in the tracked tree (a doc, an ADR) as an ordinary change for you to review.

## 11. Architecture

- **Renderer:** `LeeMode` becomes `'cockpit' | 'deep' | 'manual'` (`shared/cockpit.ts`; `'workbench'` is renamed `'manual'`), with new `ModeReason`s (`deep_start`, `deep_end`, `hop`), and `nextMode` gains the switcher and Deep transitions. The in-mode wall (entered PTYs, holds, wall repair in `cockpitMode.ts`) is removed in favour of the mode rule (§3). The Page, Board, Browse and Workbench views are new components under `components/deep/`; Browse wraps `BrowserPane`, Workbench wraps `EditorPanel` with tabs, a multi-diff view on `@codemirror/merge`, and `TerminalPane` for your shells. The `⌘0` switcher is an overlay owned by the mode store. Deep's and the switcher's chords go in the `SHORTCUTS` registry (`shared/shortcuts.ts`) so they show in `docs/shortcuts.md` and can be overridden with `keybindings:`; the action row's letters are local to the row, like the Cockpit's `keyAction`.
- **Lee main:** owns Deep sessions as focus sessions with `source: 'deep'` (§3.2), the `exploration` focus item kind, the attention policy `none`, and render jobs (they reuse the operations runtime in `ops-runtime.ts` and the browser manager's screenshot path).
- **Hester daemon:** the exploration store grows the files in §10 and endpoints for page, board, references, answers and sessions. `deep-ask` is a new user-triggered surface; answers stream to the renderer over the existing Cockpit stream as `answer` deltas. The opener is assembled by a deterministic `opener` builder alongside `copilot/digest.py`, with no model client (13 §13 model routing).
- **Degradation:** Deep mode works without Hester for writing, the Board and Browse; Ask and Spin off show "Hester offline" and queue locally until it's back.

## 12. Phasing

Deep work builds on 13's Explore (v3) and uses its Someday, tasks and hooks. It can start before 13's v4 (Goals, steward) because it needs neither.

1. **D1: A place to think.**
   - Three modes, Cockpit, Deep and Manual, with the `⌘0` switcher; Workbench renamed Manual and the in-mode wall replaced by the mode rule; zero-interruption attention in Deep; manual Focus retired into Go deep (§3).
   - Explorations as directories; the **Page** with margin (§4.1, §10).
   - Selection actions **Capture**, **Keep**, **Ask**, **Explore**; ask, don't wait with the `deep-ask` surface (§5.1, §5.3).
   - Typing affordances for `?`, URLs and `later:` (§5.2).
   - The **opener** as the Copilot section's top, landing on Copilot (§6).
   - The **ending ritual** with `session_depth` (§7).
   - G0 metrics in the event log; `turn_churn` first, since the hooks exist.
   - **Success test:** over two weeks, time_to_deep under a minute in sessions that go deep, and at least half of Deep sessions rated deep or mixed.
   - **Status (2026-09-26):** built to the contract, [`plans/2026-09-26-deep-d1-contracts.md`](plans/2026-09-26-deep-d1-contracts.md); the Hester side (explorations as directories, deep-ask, the opener, G0 metrics at formula v6) is in.
2. **D2: Research and code.** **Browse** in Deep mode with bookmark and screenshot (§4.3); the **Board** with screenshots, reference and answer cards and text boxes (§4.2); **Spin off** with results as answer cards (§5.1, §5.3); **Workbench** with tabs, working set, Quick Open, terminals, multi-diff review, batched review comments and `human`-lead tasks (§4.4).
3. **D3: Renders.** Render target detection and recipes, starting with Web/Storybook and Flutter, then iOS and Lee's own viewers (§9); markup-to-task; stale renders in the opener (§9.4).
4. **Devices (13 v6, after D1):** the device Cockpit, Carry and Open next (§8.1); the reading list after D2.
5. **Later:**
   - **Studio:** deep work not tied to one workspace (strategy, reading, thinking about the world). Likely a v2 of Explore rather than a separate feature.
   - **Voice:** capturing a thought on a walk by voice (`hester/docs/VoicePlan.md`), into "Captured away".
   - Dedicated readers (EPUB, timestamped video notes).
   - Workbench: take a single hunk from an agent's diff; Local History; language servers.

## 13. Open questions

Resolved in conversation (2026-09-26):
- ~~Sidecar vs tool~~: no sidecar; selection actions, deterministic affordances, quiet arrivals, and the palette (§5).
- ~~Preparation between sessions~~: deterministic assembly; model work happens on demand during the session (§5.3, §8).
- ~~Interruptions in Deep~~: none; switching modes is one key (§3).
- ~~Focus vs Deep~~: manual Focus was an early Deep; it's retired into Go deep, and inferred focus stays in Manual (§3.2).
- ~~Renders~~: detected like operations, rendered on demand, marked up on the Board, resurfaced in the opener (§9).
- ~~Surface~~: four views, Page, Board, Browse and Workbench (§4). ~~Hops~~: normal, one key, never scored (§3.1).
- ~~Workbench vs Manual~~: Workbench's multiplexer half is Manual mode (no wall, all TUIs); its hands-on half is Deep's Workbench view with tabs and terminals (§3, §4.4). ~~Review replies~~: batched (§4.4). ~~Take a hunk~~: later. ~~Scope~~: per workspace; Studio later (§12). ~~Stopping~~: the ending ritual only (§7). ~~Reading~~: the browser (§4.3). ~~Voice~~: later.
- ~~Ask routing~~ (2026-09-26): `deep-ask` uses Hester's existing hybrid routing (local or cloud per `prepare.py`), steward off. A heavier Ask that runs as a small agent with tools can come with Spin off in D2.
- ~~Key bindings~~ (2026-09-26): as proposed: `⌘0` switcher, `⇧⌘0` Cockpit ↔ Deep (Reset Zoom keeps its menu item, loses the accelerator), `⌥⌘0` Cockpit ↔ Manual, `⌥⌘1`–`4` views, `⌘.` action row; `⌘P`, `⌥⌘S` and `⌘D` with their D2 views. The D1 contract checks each against CodeMirror's keymap and macOS text chords before registering.
- ~~Daemon lifetime~~ (2026-09-27): the daemon stays a child of Lee main; closing Lee stops it, and interrupted work comes back as Retry (§7, §8).
- ~~Leaving Deep without ending~~ (2026-09-27): 45 minutes is fine; a device push just before the idle end offers Extend, End and rate, or Capture (§8.1).
- ~~Dive in~~ (2026-09-26): Explore's **Dive in / Continue** opens the exploration in Deep (the Page). The per-node chats stay in the Library, which is reachable from Manual; the existing Log is kept.

Open:
- **Device questions (§8.1):** is **Open next** the right replacement for Dirigible's `f` (the alternative is to drop the key)? Should the Aeronaut reading list be in v6 or later? Does voice capture (`hester/docs/VoicePlan.md`) join v6 for Aeronaut, since it belongs to the walk, or stay later?
- **Board library:** build a small canvas or adopt tldraw/Excalidraw? Depends on licence, bundle size and the renderer CSP.
- **Render views:** how far should view discovery go (Next routes, Flutter golden tests), and what's the fallback when a web route needs auth or state?
