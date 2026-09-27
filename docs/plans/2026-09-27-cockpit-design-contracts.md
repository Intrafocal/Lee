# Cockpit design: a desk, not a dashboard

> **Status:** Contract, 2026-09-27
> **Design:** the canvas [Lee Cockpit redesign](https://claude.ai/artifact/1ju2NEnseyKSgmuy1t1moC). Artboards: "Chosen · The desk, with the rail" (Home), "Quieter chrome", "Work: one column", "Work: tap in to one agent", "Library", "Deep: the Page", and the device row "On the phone and the T-Deck".
> **Specs:** [`docs/13-Copilot.md`](../13-Copilot.md) §6–§9 (the Cockpit), [`docs/14-Deep-Work.md`](../14-Deep-Work.md) §4.1, §5, §6 (Page, opener) and §8.1 (devices).
> **Builds on:** the D1 contract ([`2026-09-26-deep-d1-contracts.md`](2026-09-26-deep-d1-contracts.md)); D1 is merged.
> **Packages:**
> - **S** (scaffold) runs first and alone: tokens, fonts, UI primitives, section ids, shared types (§9).
> - Then, in parallel:
>   - **M** (Lee main: agent activity and the user's name, §7).
>   - **R1** (shell, Home, and the Goals/Ops/History restyle: §2, §3, §6.3).
>   - **R2** (Work and Library: §4, §5).
>   - **R3** (Deep Page, palette, global focus: §6.1, §6.2, §1.4).
>
> They share only this document and S's commit. Each package builds in its own worktree; a merge step follows.
> **Out:** building the device designs (§8 records them for 13's v6); Manual mode (unchanged, by decision).

## 0. Why, and the rules

The Cockpit felt impersonal and overwhelming:
- **No hierarchy.** Four same-weight cards stacked.
- **Accent everywhere.** Phosphor on six things at once, and ember on a button and three counts.
- **Seven badges.**
- **Chrome everywhere.** Three bars above the content and three below.
- **The system's vocabulary** instead of your words: "Q2 (5)", "Steward on · Not today", "agent claim".

The redesign has three colour-and-type rules and two layout rules. Every package holds all five.

1. **Phosphor marks the one next step on screen.** It's used for at most one filled control per view, plus the caret, the text selection and the new-answer dot. Continue, Allow and Send are each that step in their own view. Links, active nav, tabs and focus rings are never phosphor.
2. **Ember means needs you, and nothing else.** It shows as a dot, never a number, and never on a button or border. Counts of things that don't need you are neutral text or removed.
3. **Your words are in a writing typeface.** Anything you wrote appears in **Newsreader**: the opener's question and field, Pick up's last sentence, the Page, open questions, and exploration snippets. The machine's words stay in the system sans; commands and paths stay mono.
4. **One column.** Each Cockpit view is a single centred column: 680px for Home and Work, 760px for Library. The only exception is Goals/Ops/History, which keep their tables. There are no side panels.
5. **Scroll, and tap to drill in.** Lists scroll. Tapping or clicking an item opens its detail view in place, and Esc returns you. A quick reply is one click. Snooze and dismiss are a horizontal swipe; approving is never a swipe.

**Goal check (two-sided):**

| Part | Moves | Costs |
|---|---|---|
| Home as a desk: the serif question, your last sentence, Continue | G0 time_to_deep ↓ (Deep is the obvious action) | The digest is shortened to one sentence plus the items that need you; full detail is one click away |
| Six sections, one ember dot, no dock or drawer | G1 toil_load ↓, G2 peek_rate ↓ (no wall of tiles) | Agents are one click further away (Work) |
| Work: one column, quick replies, drill-in | G2 attention_latency ↓ (answer in one click), G0 turn_churn ↓ (considered replies in the detail view) | None |
| Quieter chrome (focus ring, accents) | Readability; less visual noise | Keyboard focus is subtler; kept visible at 1px (§1.4) |

## 1. Tokens, fonts and primitives (S)

### 1.1 Tokens (`design/tokens.json`, then `node design/build.mjs`)

- `font.write`: `"'Newsreader', 'Iowan Old Style', Georgia, serif"`. It's generated into `--font-write` (CSS), the Dart tokens and the TS tokens. Dirigible doesn't use it (§8.2).
- Colour **roles** are documented on the existing tokens without changing their values: `phosphor` "the one next step"; `ember` "needs you only"; `lit` "reserved for the terminal's bright green; never UI". The generated CSS gains semantic aliases:
  - `--accent-next: var(--phosphor)`
  - `--needs-you: var(--ember)`
  - `--focus-ring: var(--ground-5)`
  - `--caret: var(--phosphor)`
  - `--selection: rgba(var(--phosphor-rgb), 0.22)`
- New spacing and size aliases for the redesign: `--col-home: 680px`, `--col-library: 760px`, `--rail: 56px`.

Never hand-edit the generated files (`styles/tokens.css`, `theme/tokens.generated.ts`, `aeronaut/lib/theme/phosphor_tokens.dart`).

### 1.2 Newsreader, bundled

- The Newsreader variable font (Google Fonts, SIL Open Font License 1.1): the roman and the italic, as woff2, in `electron/src/renderer/assets/fonts/`, with `OFL.txt` next to them. They're fetched once at build time and committed.
- `@font-face` declarations go in `styles/fonts.css`, imported by `main.tsx`: `font-display: swap`, the weight range `200 800`, and `opsz` enabled.
- **No runtime fetch** (C1). The renderer CSP already allows `font-src 'self'`. Remove `https://fonts.gstatic.com` from `font-src` in `main.ts` if nothing else uses it (check with a grep; leave it if something does, and note which).
- Aeronaut gets the same files under `aeronaut/assets/fonts/` with a `pubspec.yaml` entry, **but no Aeronaut UI changes** (§8).

### 1.3 Primitives (`components/cockpit/ui/`, new, S)

These are small presentational components. Every Cockpit view uses them instead of ad-hoc markup, which is how "standard components" is enforced:

| Component | Props | Look |
|---|---|---|
| `SectionHead` | `title`, `summary?: string`, `right?: ReactNode` | 20px/500 title, a 13px `--text-2` summary on the same baseline |
| `Eyebrow` | `tone?: 'default' \| 'needs'` | 12px uppercase, 0.06em tracking, `--text-3` (or `--needs-you` for "Waiting on you") |
| `Card` | `tone?: 'plain' \| 'raised' \| 'needs'`, `onOpen?`, `children` | radius 10px, `--ground-2` fill, 1px `--ground-3` border. `raised`: `--ground-3` fill with a `--ground-5` border (the one item that needs you most). The whole card is a button when `onOpen` is set |
| `Row` | `dot?: DotKind`, `title`, `sub?`, `meta?`, `onOpen?` | 14px title, 13px `--text-3` sub, 12px meta on the right with `›` |
| `Dot` | `kind: 'needs' \| 'working' \| 'done' \| 'idle'` | 7px: ember, phosphor, a 1px `--text-2` ring, `--text-3` |
| `Chip` | `label`, `onClick` | a 16px-radius pill, `--ground-3` fill, `--ground-4` border, 13px |
| `Btn` | `kind: 'next' \| 'plain' \| 'quiet'`, `kbd?` | `next`: phosphor fill with `--on-phosphor` text, **at most one per view**. `plain`: `--ground-4` fill. `quiet`: text only |
| `QuietLinks` | `items: {label, onClick, kbd?}[]` | 13px `--text-2` links in a row, with a top rule |
| `WritingQuote` | `text` | Newsreader italic, 17–19px, `--text-2`, with curly quotes |

- **Dev check:** `ui/nextGuard.ts`, used in development only, warns in the console when more than one `Btn kind="next"` is mounted in the same view root.
- **`cockpit.css`:** the old card classes (`.cockpit-brief-card`, `.cockpit-tile`, …) are deleted by their owning packages as their views move over. S doesn't delete them.

### 1.4 Global focus (R3)

`styles/index.css:87`'s rule becomes:
- **Buttons, rows, chips and `[tabindex]`:** `box-shadow: 0 0 0 1px var(--focus-ring)` plus the background brightening one ground step.
- **Text inputs and textareas:** no ring. Their border (or underline) brightens from `--ground-4` to `--ground-5`, and the caret is `--caret`. The caret shows where you're typing.

`--lit` is removed from all UI CSS (grep `var(--lit)` outside terminal and xterm code).

## 2. The shell (R1)

### 2.1 The rail replaces the nav and the header

- **`CockpitNav`** becomes a 56px icon rail. Each item is a 36px button with an icon, an `aria-label` and a tooltip carrying the label.
  - The active item gets a `--ground-3` fill and `--text-1` icon.
  - The only badge is a 6px ember dot at the top right when the section has needs-you items. There are no counts.
- **`CockpitHeader` is removed.** Its parts move:

| Was | Now |
|---|---|
| Mode switch (Cockpit / Deep / Manual) | The status bar mode chip and `⌘0` (unchanged) |
| `+ Task` `+ Explore` `Run ▾` | **New ⌘N**: the Launcher gains three choices at the top, **Task**, **Explore** and **Run…**. Enter still launches a task, and `⌘{` still opens Run |
| Back to Deep / Go deep | Home's Continue, and `⇧⌘0` |
| Focus / Stop focus | Gone (retired in D1) |
| Steward on · Not today (Copilot header) | The status bar's Hester menu: "Steward: on / quiet today / off" |

- **The agent dock (`AgentTiles`) and the tab drawer (`TabDrawer`) are removed from the Cockpit.** Agents live in Work (§4), and your own tabs live in Manual. `⌘T` in the Cockpit goes to Manual on the last tab.
- **The status bar in the Cockpit** reads: `Lee · Cockpit ⌘0` … `2 agents working · 1 waiting` (the waiting count in `--text-2`, **not** ember) · `New ⌘N` · `Ask ⌘/` · the clock.

### 2.2 Six sections

`SectionId` becomes `'home' | 'work' | 'goals' | 'library' | 'ops' | 'history'` (S writes the type and the migration).

| New | Absorbs | Icon (existing `IconName` if one fits, else a new one in `design/icons.json`) |
|---|---|---|
| **Home** | Copilot | house |
| **Work** | Feed, Tasks, agent tiles | tray |
| **Goals** | Goals | target |
| **Library** | Explore, Someday, Files | books |
| **Ops** | Ops | play |
| **History** | History | clock |

- **Remembered sections migrate:** `copilot` → `home`; `feed`, `tasks` → `work`; `explore`, `someday`, `files` → `library`; `tabs` → `home`. This covers `localStorage lee:cockpit:<ws>:section` and any `setSection` callers.
- `DEFAULT_SECTION = 'home'`.
- `requestSteward` targets `home` for what-next and asks, and `work` for task link-goal.
- **The Tabs section is deleted.** Its "Assign…" action moves to the Work detail view of an unassigned agent (§4.3).

## 3. Home (R1)

This replaces `CopilotSection`. It's one column of `--col-home`, 104px from the top.

1. **The greeting**, above the question: `<weekday> <part of day>` in 13px `--text-3` ("Sunday morning"). `greeting(now)` in `lib/cockpitModel.ts` is a pure function: 05:00–11:59 morning, 12:00–16:59 afternoon, 17:00–21:59 evening, otherwise night.
2. **The question:** "What's on your mind, `<name>`?" in Newsreader at 40px. Without a name (§7.2) it's "What's on your mind?".
3. **The field:** borderless, with a 1px underline in `--ground-5`, Newsreader at 22px. Its placeholder is "Start writing. Enter opens a Page.", and a `↵` hint sits at the right. Its behaviour is unchanged from D1 §8.2 (an exact title match opens that exploration, anything else creates one).
4. **Pick up where you left off** (only when the opener has `pick_up`): one `Card`, clickable as a whole.
   - An eyebrow, with the relative time on the right.
   - The exploration title at 17px/500.
   - `stopped_at` as a `WritingQuote` at 19px.
   - "`N` answers came back · `M` open questions".
   - `Btn next` "Continue ⇧⌘0". **This is the view's phosphor.**
5. **Or start from:** an eyebrow, then plain text links in a wrapping row. Each is a sentence, not a label:
   - "A blank page"
   - "`n` open questions"
   - "`n` thoughts from your phone" (captured away; the T-Deck counts too; the wording is "from your phone" when every item's surface is aeronaut, "from your devices" otherwise)
   - "`n` things to read"
   - Q2 items, each written out ("G1 hasn't had any work this week", from the candidate's own text)
   - "`n` quiet explorations"

   Behaviour is as in D1 §8.2.
6. **Meanwhile:** the digest, reduced to what matters, below a rule.
   - An eyebrow.
   - **One sentence** built by a pure `meanwhileSentence(digest, attention)`, for example "Two agents finished while you were away. One is waiting on you." It covers wins, finished turns and waiting items, in words, with no "claims".
   - **Up to three needs-you rows:** `Dot needs`, the agent's name, a one-line ask, and one `Btn plain` for its primary action (Allow for approvals, Reply otherwise, where Reply opens Work's detail view), plus a quiet second action.
   - **Quiet links:**
     - **See what shipped** expands the digest's wins and changed files inline.
     - **Ask Hester what to do next** runs What next? and shows `StewardAnswerView` inline below, with its proposals.
   - The weekly retro, when due, is one more quiet link ("This week's retro").
   - Work lint shows as a neutral `⚠ N` quiet link to Ops (lint findings are shown in Ops).
7. **Removed from Home:** the Ask Hester card (asking is `⌘/`, §6.2), the "about:" chips, the "Copilot mode" placeholder, the separate What next? card, and the agent text dump.

`OpenerCard` (R2's file in D1) moves to R1 for this rewrite. It becomes `HomeSection.tsx`'s opener part, and R2 doesn't edit it.

## 4. Work (R2)

This replaces Feed, Tasks and the agent tiles: `sections/WorkSection.tsx`, built from the primitives. The data is the same as today's: the attention snapshot, the tile models (`cockpitModel.ts`), Hester's tasks, and the Feed entries.

### 4.1 The list (one column, `--col-home`)

- **`SectionHead`:** "Work", with the summary "`n` waiting on you · `n` working · `n` done today".
- **Waiting on you** (a `needs` eyebrow). One `Card` per item, in the queue's order (blocking, then needs-you, oldest first). The first card is `raised`. Each card has:
  - a meta line: `Dot needs`, the agent's name, "· provider · workspace", and the age on the right;
  - its body, by kind:
    - **approval:** "Wants to run a command" (or the tool's plain description) and the exact command or preview in mono;
    - **question** (Claude AskUserQuestion): the question and its options as `Chip`s;
    - **waiting, blocker, decision:** the agent's words (the summary text, clipped at 6 lines with "More" opening the detail);
  - its actions:
    - **approval:** `Btn next` "Allow" (only on the raised card; the others get `Btn plain`), `Btn plain` "Deny", quiet "Reply";
    - **text-capable items:** the quick-reply chips (§4.4) and a quiet "Write a reply…" that opens the detail with the reply field focused.

  The whole card opens the detail view (§4.2), except on its controls.
- **In flight:** a neutral eyebrow over one grouped `Card` of `Row`s, ordered as Aeronaut's `InFlightGroups`:
  - busy agents, longest-running first, with `Dot working` and the sub-line "what it's doing now" (§7.1);
  - then those ready to review, with `Dot done` and "done · ready to review";
  - then idle.

  Agents idle for more than 2 hours fold into "`n` earlier today".
- **Operations** that are running or failed show as `Row`s in In flight: failed ones with `Dot needs` and "failed · 2m", linking to Ops. Other Feed entries (lint, metrics, proposals) don't appear in Work; they belong to Home's Meanwhile or to Ops.
- **Empty state:** "Nothing needs you." in Newsreader at 22px, with Continue (to Deep) as the view's `Btn next`.

### 4.2 The detail view

Clicking a card or row replaces the list in place: same column, with "‹ Work" and a quiet `esc` at the top.
- **Header:** `Dot`, the name at 22px, and a meta line: provider, workspace, "started 18m ago", "waiting on you 2m", and "serves G0" if it's linked to a goal.
- **"It asked" / "It said":** the agent's full last message as prose (markdown through the existing `AgentMarkdown`), at 16px.
- **The pending action,** if any:
  - an approval shows the command block with `Btn next` Allow, Deny, and "Allow for this session" when the v2 repeat-approval fix applies;
  - a question shows its options.
- **The reply box:** the four quick-reply chips, a textarea ("Or write a reply"), the hint "Sent exactly as written" (C3), and `Btn next` "Send ⌘⏎". It uses the existing Reply path.
- **Along the way:** the last 8 activity entries (§7.1) as "time · description".
- **Quiet links:** Check in, Rename, "Open terminal in Manual ⌥⌘0" (the go-into path, which switches to Manual), Accept and Discard (tasks in review), Assign… (unassigned agents, moved from Tabs), and Close agent (with the two-step confirm while working).
- **Keys:** ↑/↓ move to the previous or next item in the list without going back; Esc returns to the list with the item selected.

### 4.3 Keys and gestures

- **In the list:** ↑/↓ move the selection (a `Card` or `Row` gets the 1px focus ring); ⏎ opens it; ⌘⏎ allows or sends the primary action on the selected waiting item; the Cockpit's existing ⌘ chords still apply (⌘D deny, ⌘E rename, ⇧⌘. check in).
- **Swipe** on a waiting card: a horizontal trackpad scroll (`wheel` with `|deltaX| > |deltaY|`) accumulating past 120px. Leftward **snoozes** (until the item changes); rightward **dismisses**. While you swipe, the card translates with the gesture, and it snaps back below the threshold.
  - **After it fires:** the card collapses into a one-line row, "Snoozed · Undo" (or "Dismissed · Undo"), for 5 seconds.
  - **Approve and deny are never gestures.**
  - Mouse users get the same actions from a quiet `⋯` menu on the card.

### 4.4 Quick replies

`QUICK_REPLIES` in `shared/cockpit.ts` (S) is `['Yes, go ahead', 'Stop and wait for me', 'Explain first', 'Show me the diff']`. It's the same list as Aeronaut's `quickReplyChips`, and the doc comment names both places. The list card shows the first three; the detail view shows all four. A chip sends through the existing Reply path immediately. The text is shown on the chip, so C3's "show the text first" holds.

## 5. Library (R2)

This replaces Explore, Someday and Files: `sections/LibrarySection.tsx`, one column of `--col-library`.

- **Head:** `SectionHead` "Library"; tabs **Explorations**, **Ideas** and **Files** (a segmented control in `--ground-3`); a quiet "New exploration" on the right.
- **Find:** a borderless search field with an underline. It filters the current tab by title and text, client-side.
- **Explorations:** a `Card` per active exploration, newest touched first. Each has:
  - the title at 16px/500 and the relative time;
  - a `WritingQuote` of the last session's `stopped_at`, else the Page's last non-empty line;
  - a meta line: "`words` words · `n` answers · `n` open questions", plus "quiet" after 7 days.

  Clicking it opens the exploration in Deep. A `⋯` menu offers "Open tree (Manual)", "Open file", "Archive" and "Archive as knowledge". "Archived (n)" folds at the bottom.
- **Ideas:** today's Someday list as `Row`s. Each shows the text (in Newsreader when it came from a device capture), the source and the age. Triage (Explore, Plan with agent, Promote to task, Keep, Drop) moves into a `⋯` menu, apart from **Explore**, which is a quiet inline action. The capture field sits at the top: borderless, Newsreader.
- **Files:** today's Files section in the new styling. Opening a file goes to Manual, as today.

Page word counts come from `to_api`'s `page_chars`. Words are estimated as chars / 5.7, rounded and shown as "about `n` words" under 1,000 (no daemon change).

## 6. Deep and the palette (R3)

### 6.1 The Page

This matches the "Deep: the Page" artboard.
- **The body:** Newsreader at 20px, line height 1.65, `--text-1`, in a 72ch column. The ground is `--ground-0` (darker than the Cockpit), so Deep reads as a different room.
- **The header:** one quiet 44px line with no fill: the title (click to rename) at 13px `--text-2`; the view name "Page" in `--text-3`; then on the right "`n` answers" and "`n` questions" as quiet buttons, and End session as a plain outline button. The Answers tray and open-questions popovers keep their D1 behaviour.
- **The margin:** answers are notes with no border or card. A 6px dot (phosphor when unread, `--text-3` when read), then "Hester answered" or "asking…" in 12px `--text-3`, then the question at 13px `--text-2`. Expanding a note shows the answer in the system sans at 14px, with Insert, Keep, Follow up and Dismiss as quiet buttons.
- **The action row:** four `plain` buttons, each showing its key letter in `--text-3` ("Ask a"). There's no phosphor in the row.
- **Selection** uses `--selection`, and the caret is `--caret`.
- **The ending ritual sheet:** restyled with the primitives, with a Newsreader "Where did you stop?" field. Behaviour is unchanged.
- **The status bar in Deep:** "Deep · ⇧⌘0 Cockpit" on the left and "`n` waiting" on the right, both in `--text-3`.

### 6.2 The palette (`⌘/`)

- **The input** follows the rule in §1.4: no ring; the field's border brightens and the caret is phosphor. The `⌘/` hint is plain `--text-3` text with no pill.
- **About:** when the Cockpit has a selected item (a Work card or row, a Library exploration, a Goals row), the palette opens with a quiet line "about: `<kind>` `<title>` ×" above the field. Clearing it with × makes the question general. This replaces Home's Ask Hester card. With an "about" set, the palette sends through `/cockpit/ask` (the steward surfaces, as the card did); without one it streams through `/context/stream` as today.
- **Keep** (D1 §5) stays, restyled.

### 6.3 Goals, Ops and History (R1)

Their data and layout are unchanged. The restyle:
- `SectionHead` and `Eyebrow`s instead of their current headers;
- tables and rows in the primitives' type scale;
- ember only for needs-you rows (failed ops, evaluation due);
- every count badge removed or made neutral;
- one `Btn next` at most (Ops: none; Goals: "Evaluate" only when an evaluation is due).

Work lint lives in Ops as its own group (it was in Copilot).

## 7. Lee main (M)

### 7.1 Agent activity

- **Per agent session:** `CopilotQueue`'s session keeps a ring of the last 20 **activity entries**, fed from the existing `agent.tool` pre and post handling:

  ```
  { at, tool, preview, files: string[], writes, failed?: true }
  ```

  where `preview` is `toolPreview` (already computed for pending tools), capped at 160 chars.
- **The attention snapshot:** each `agents[]` entry gains:
  - `now: AgentNow | null`: the open tool if one is running, else the last entry within 60s, else null;
  - `recent: AgentActivity[]`: the last 8, newest last.

  Devices get the same fields (§8).
- **The description:** the pure `describeActivity(entry | now)` goes in `shared/cockpit.ts`, so the renderer and the smoke tests share it (and the Dart and C++ ports copy its table in v6). It returns a short present-tense phrase:

| Tool | Phrase |
|---|---|
| Edit, Write, MultiEdit, NotebookEdit | "Editing `<basename>`" (several files: "Editing `n` files") |
| Read | "Reading `<basename>`" / "Reading `n` files" |
| Grep, Glob | "Searching" (+ " for `<pattern>`" when the preview has one, ≤ 30 chars) |
| Bash | test runners (`test`, `pytest`, `jest`, `vitest`, `smoke`) → "Running tests"; builds (`build`, `dist`, `tsc`, `idf.py`) → "Building"; `git …` → "Using git"; else "Running `<first word>`" |
| WebFetch, WebSearch | "Reading the web" |
| Task / Agent | "Working with a subagent" |
| AskUserQuestion | "Asking you a question" |
| anything else | the tool name |

  A failed entry gets " (failed)". For the timeline, a post entry reads in the past tense: "Edited", "Read", "Ran tests", "Built". It's the same table with a `past` column.
- Nothing about activity is written to the event log beyond today's `agent.tool` events.

### 7.2 The user's name

- `window.lee.app.userName(): Promise<string | null>` (IPC `app:user-name`). The order:
  1. `app.user_name` in the merged config;
  2. else the first word of the macOS full name (`id -F`, run once and cached; on other platforms `os.userInfo().username` isn't used, because a login name isn't a first name);
  3. else null.
- Settings (config) documents `app.user_name`. `CLAUDE.md`'s configuration example gains it (M).

## 8. The phone and the T-Deck (design only, 13 v6)

This records the canvas's device row as the plan for 13's v6 device work. **Nothing here is built in this contract.** The same model runs on every surface: needs-you first, the agent's words, big actions, quick replies, tap to drill in, and Carry for your own thinking.

### 8.1 Aeronaut

- **Tabs:** **Work**, **Library**, **Hester**, **Machine** (Machines, Tabs and Files merge into Machine: that machine's tabs and files, plus the machine switcher).
- **Work:** the Now screen, renamed and restyled to §4:
  - Waiting cards: 44px Allow and Deny; quick-reply chips in a sideways scroll; swipe to snooze or dismiss, as today.
  - In flight as grouped rows with the "doing now" sub-line.
  - Capture as the header's + button.
- **One agent:** "It asked" as prose; the four quick replies as a 2×2 grid of 48px buttons; "Along the way"; a reply bar pinned to the bottom with a round phosphor Send.
- **Library:** tabs **Carry** (first), Explorations and Ideas.
  - Carry: "You stopped at" (Newsreader italic), open questions (Newsreader), `Btn next` "Capture a thought into this", "Open this first on the Mac" (14 §8.1 Open next), and "`n` things to read".
- **Fonts:** Newsreader is bundled by S (§1.2), ready for v6.

### 8.2 Dirigible (320×240, Montserrat only)

- **Views:** **Work** (the waiting pager), **In flight**, **Library** (Carry), plus today's Tabs, Terminal, Hester and Files. Keys: `w` Work, `i` In flight, `l` Library; every key a plain letter.
- **Work pager:** one item per page, as now. Questions get the quick replies as letter buttons: **Go (G)**, **Wait (W)**, **Why (E)**, **Reply (R)**; approvals keep Approve (Y) and Deny (N).
- **In flight:** a trackball list; press opens the agent; `c` checks in.
- **Library (Carry):** one exploration per page (j/k): "You stopped at" in Montserrat italic, one open question, **Add a thought (C)** and **Open next (O)**. `O` replaces the old `f` Focus key (14 §8.1).
- The 14 §8.1 idle-end push (Extend, End and rate, Capture) uses the same page layout.

## 9. Shared types and seams (S writes these first)

```ts
// shared/cockpit.ts
export type SectionId = 'home' | 'work' | 'goals' | 'library' | 'ops' | 'history';
export const LEGACY_SECTION: Record<string, SectionId> = {
  copilot: 'home', feed: 'work', tasks: 'work', explore: 'library', someday: 'library', files: 'library', tabs: 'home',
  home: 'home', work: 'work', goals: 'goals', library: 'library', ops: 'ops', history: 'history',
};
/** Same list as aeronaut/lib/widgets/attention_tile.dart quickReplyChips. */
export const QUICK_REPLIES = ['Yes, go ahead', 'Stop and wait for me', 'Explain first', 'Show me the diff'] as const;
export interface AgentActivity { at: string; tool: string; preview: string; files: string[]; writes: boolean; failed?: true; phase: 'pre' | 'post' }
export interface AgentNow { tool: string; preview: string; files: string[]; since: string }
export function describeActivity(a: { tool: string; preview: string; files: string[]; failed?: boolean }, tense?: 'now' | 'past'): string;
// Attention snapshot agents[] gain: now?: AgentNow | null; recent?: AgentActivity[];
// window.lee.app gains: userName(): Promise<string | null>;
```

`describeActivity` is implemented by S with the §7.1 table, since it's pure. M feeds its data, and R2 renders it.

**S also:**
- writes `lib/cockpitModel.ts`'s `SectionId` migration (`readSection` maps through `LEGACY_SECTION`);
- adds stub section components `HomeSection`, `WorkSection` and `LibrarySection` that render the old sections for now (so the app builds at every step);
- creates `components/cockpit/ui/` (§1.3);
- sets up tokens and fonts (§1.1–§1.2);
- adds a `userName` stub returning null in preload (M replaces it);
- commits as `chore(cockpit-design): scaffold (tokens, Newsreader, primitives, sections)`.

**Ownership after S:**

| Files | Owner |
|---|---|
| `CockpitHost.tsx`, `CockpitNav.tsx`, `CockpitHeader.tsx` (deleted), `AgentTiles.tsx`/`AgentTile.tsx` (deleted after Work lands; R1 deletes them in the merge step if R2 no longer imports them), `TabDrawer.tsx` (deleted), `Launcher.tsx`, `StatusBar.tsx`, `HomeSection.tsx` (+ the D1 `OpenerCard.tsx` it absorbs), `GoalsSection.tsx`, `OperationsSection.tsx`, `HistorySection.tsx`, `lib/cockpitModel.ts` (except `describeActivity`, which lives in shared), `scripts/cockpit-renderer-smoke.mjs` | R1 |
| `WorkSection.tsx` and its parts (`components/cockpit/work/**`), `LibrarySection.tsx` (+ `ExploreSection`, `SomedaySection`, `FilesSection` it reuses or replaces), `lib/workModel.ts` (new, pure: ordering, folding, swipe thresholds), `scripts/cockpit-work-smoke.mjs` (new) | R2 |
| `components/deep/**`, `CommandPalette.tsx`, `styles/index.css` (the focus rule, `--lit` removal), `scripts/deep-renderer-smoke.mjs` | R3 |
| `electron/src/main/**`, `electron/src/shared/*` after S, `CLAUDE.md`, main smokes | M |
| `design/**`, generated token files, `components/cockpit/ui/**`, fonts | S, then read-only for everyone (R1–R3 report needed primitive changes as questions) |

`cockpit.css` is split by S into `cockpit-shell.css` (R1), `work.css` (R2) and `library.css` (R2). R3 keeps `components/deep/deep.css`. Nobody edits another package's stylesheet.

## 10. Tests

- **S:**
  - `node design/build.mjs` is clean and the generated files are committed;
  - typecheck and all existing smokes pass with the stub sections;
  - a unit block for `describeActivity` (every table row, the past tense, failures, several files) and `LEGACY_SECTION`, in `cockpit-renderer-smoke.mjs`.
- **M:**
  - `copilot-queue-smoke.js`: the activity ring (pre and post, a cap of 20, `now` while a tool is open and for 60s after, `recent` of 8 in the snapshot);
  - the `userName` order (config, then `id -F` stubbed, then null).
- **R1:**
  - `greeting()` boundaries;
  - `meanwhileSentence()` cases (nothing, only wins, waiting only, both);
  - section migration from every legacy id;
  - the Launcher's three choices;
  - that no Cockpit view mounts more than one `next` button (render each section with fixture data through the nextGuard in the smoke).
- **R2:** `lib/workModel.ts`:
  - waiting order;
  - In flight order and "earlier" folding at 2h;
  - swipe accumulation (threshold, direction, snap back, ignoring vertical);
  - the chips shown (3 in the list, 4 in the detail);
  - detail next and previous;
  - Library word estimate and "quiet".
- **R3:**
  - the palette's about-routing (with an "about" → `/cockpit/ask`, without → `/context/stream`);
  - that `var(--lit)` appears in no renderer CSS outside the terminal;
  - that Deep smokes still pass.
- **Everyone:** typecheck, `npm run build`, the daemon suite (untouched, as a check). Then an **in-app pass with the user** before the contract is called done: agents can't judge the look.

## 11. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Layout | Home: one centred column (the desk) with the icon rail | Chosen 2026-09-27 from the two layouts on the canvas |
| 2 | Sections | Six: Home, Work, Goals, Library, Ops, History | Chosen 2026-09-27; Work is steering, Library is ideas |
| 3 | Writing face | Newsreader, bundled, for your words only | Chosen 2026-09-27; personal, and it signals Deep |
| 4 | Greeting | Name and time of day | Chosen 2026-09-27 |
| 5 | Work | One column like Aeronaut's Now; drill-in; quick replies; swipe to snooze or dismiss | Chosen 2026-09-27; one model on every surface |
| 6 | Asking | `⌘/` only, with "about" carried from the selection | One conversational surface; removes a card from Home |
| 7 | Agent dock and tab drawer | Removed from the Cockpit | Work and Manual cover them; less chrome |
| 8 | Manual | Unchanged | "Manual mode UI is fine" |
| 9 | Devices | Designed now, built in v6 | Keeps this contract to the Mac |
| 10 | Aeronaut tabs | Work, Library, Hester, Machine | Machines, Tabs and Files are one machine's view |
