# Deep, next revision: contract

> **Status:** Contract, 2026-09-27
> **Requirements:** [`2026-09-27-deep-next-requirements.md`](2026-09-27-deep-next-requirements.md), R1–R12 (read it first; this document says who builds what, and the shapes they share).
> **Builds on:** Deep D1 and the Cockpit redesign, both merged on `copilot-spec`. The redesign's rules (design contract §0) still hold: phosphor for the one next step, ember for needs you, your words in Newsreader.
> **Shared types are already committed:** `DeepAnswer.kind` / `handoff` (`DeepHandoff`, `HandoffKind`, `HandoffState`), `DeepReference.file` / `lines`, `Exploration.purpose` and the two new origin kinds (`lib/hesterCockpit.ts`), and the new optional `PageEditor` props (the seam in §3).

## 1. Packages

Three agents, each in its own worktree and branch, merged afterwards:

| Package | Owns | Requirements |
|---|---|---|
| **B** (backend) | `hester/`, `tests/`, `electron/src/main/**`, `electron/src/shared/**` (after the committed types), main smokes | R2 (section context), R3 (hand-offs: records, launch, results), R8 (delete empty explorations), R10 (file references), R12 (goals purpose, Draft from README, metric-less goals) |
| **RA** (the Page) | `components/deep/PageEditor.tsx`, `lib/deepModel.ts`, new files under `components/deep/page/`, `components/deep/deep.css` rules for the Page and margin, `scripts/deep-renderer-smoke.mjs` | R1, R2 (splitting questions, `⌘⏎`), R4, R5, R9, R10 (the `[[` picker and source panel), R11 (`@` mentions), R12's margin prompts |
| **RB** (around the Page) | `components/deep/DeepHost.tsx`, `EndSessionSheet.tsx`, a new `components/deep/HandoffSheet.tsx`, `lib/hesterDeep.ts`, Cockpit sections (`HomeSection`, `GoalsSection`, `WorkSection`), `scripts/cockpit-*-smoke.mjs` | R3 (the sheet and launching), R6, R7, R8 (opener: no exploration until text; old handoff dialog in Work), R12 (entry points, the Goals Page, Draft goals), wiring the §3 seam |

## 2. Hester and Lee main (B)

**Asks with their section (R2).** `POST /cockpit/explorations/{id}/asks` accepts an optional `section_text` (≤ 6 000 chars). `deep_ask` puts it right after the title and seed as "The section this is about", before the anchor quote. When it's absent, behaviour is as today.

**Hand-offs (R3).**
- `POST /cockpit/explorations/{id}/handoffs` `{ kind: 'spike'|'docs'|'research', provider: 'claude'|'pi', brief, anchor }` creates an answer record with `kind: 'handoff'`, `surface: 'deep-handoff'`, `question` = the brief's first line, `status: 'queued'`, `handoff: { kind, provider, brief, task_id: null, state: 'launching' }`. It returns the record (201).
- `PATCH /cockpit/explorations/{id}/answers/{aid}` also accepts `{ task_id }` for hand-offs, and sets `handoff.state: 'running'`.
- **Results come back through the follower.** For a task whose `origin` is `{ kind: 'exploration', ref: '<exp id>#<answer id>' }`, `follower.py` keeps the record in step:
  - `agent.waiting` or a pending approval → `state: 'waiting'`;
  - a turn end with the task in review → `state: 'review'`, and `answer` = the task's latest summary (its `lee-status` summary and next, else the message);
  - task closed as done → `state: 'done'`, `status: 'done'`, `answered_at`;
  - task discarded → `state: 'error'`, `error: 'discarded'`.

  Each change is ingested to Lee as `deep.answer` (existing path), so the Page updates.
- **Templates:** a pure `handoff_brief(kind, section_text, exploration_title, exploration_id)` in `hester/daemon/cockpit/deep.py`, also exposed as `GET /cockpit/handoff-template?kind=` → `{ template }`. RB renders the brief client-side from the same template text.
  - **Spike:** a throwaway prototype in a worktree, timeboxed; report what was tried, what worked, and the size and constraints found, not a recommendation to merge.
  - **Docs:** write or update repository docs as a diff; name the target file (or propose one under `docs/`) and change nothing else.
  - **Research:** no code changes; compare options against the section's criteria, with sources.
- **Launching is Lee main's.** RB calls `window.lee.cockpit.launch(LaunchRequest)` with:
  - `lead: 'delegate'`, `origin: { kind: 'exploration', ref: '<exp>#<aid>' }`;
  - `kind`: spike → `prototype`, docs → `chore`, research → `question`;
  - `worktree`: spike and docs `true`, research `false`;
  - research gets `tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']`;
  - `timebox_min`: spike 45, docs 30, research 20;
  - `prompt`: the brief.

  B checks that `TaskOrigin` accepts `kind: 'exploration'` end to end: Lee's relay, Hester's task store, the follower.

**Deleting empty explorations (R8).** `DELETE /cockpit/explorations/{id}` removes the directory only when the title is still `Untitled · …`, `page.md` is empty or whitespace, and there are no answers, references or questions. Otherwise it returns 409 `{ error: 'not_empty' }`.

**File references (R10).** `POST /references` accepts `kind: 'quote'|'link'` with `file` (workspace-relative, must exist inside the workspace) and `lines: [start, end]` (1-based, start ≤ end) and `source: { kind: 'file' }`. The file isn't read; it's only validated.

**Goals Page (R12).**
- `POST /cockpit/explorations` accepts `purpose: 'goals'`. If the workspace already has an exploration with that purpose, it returns that one (200) instead of creating a second.
- `GET /cockpit/explorations?purpose=goals` filters on it.
- `to_api` includes `purpose`.
- `POST /cockpit/explorations/{id}/draft-from-readme` (a user action: steward off, hybrid routing, logged with trigger user and surface `goals-readme`) reads `README.md` and `CLAUDE.md` if present (≤ 12 000 chars each) and returns `{ text }`: a first guess at the four prompts' answers as short markdown under four `##` headings. It never writes the Page.
- **Metric-less goals:** `goal_status` returns goals with no metrics with `measured: false` and never flags them. The Goals section shows them as "not measured yet". Check that `parse_goals_full` accepts a goal that is just a heading and a paragraph.

**Tests (B):** the daemon suite (asks with section text; hand-off create, patch and follower transitions using fixture events; delete guard; file reference validation; purpose uniqueness; draft-from-readme with a fake agent; metric-less goals), plus a Lee main smoke if `TaskOrigin` needed a change.

## 3. The seam between RA and RB

`PageEditor` gains optional props (already in the file):
- `answers`, `onAskMany`, `onHandOff`, `onReplyHandoff`, `mentionTargets`, `files`, `onQuote`, `marginPrompts`.

RA implements their behaviour inside the Page. RB passes them from `DeepHost` and does the network work:
- `onAskMany`: one `POST /asks` per item, with `section_text`.
- `onHandOff`: open the Hand off sheet.
- `onReplyHandoff`: reply through the hand-off's task agent. Use the existing Work reply path: the attention item if there is one, else `tabs.send` to its pty.
- `files.list`: `window.lee.cockpit.files(workspace)`.
- `files.read`: the renderer's existing file read (`lee.fs`).
- `onQuote`: `POST /references`.

Neither package edits the other's files. `DeepHost` renders `<PageEditor … />` with the new props; RA doesn't touch `DeepHost`.

## 4. The Page (RA)

- **R1:** the row reads **Ask Hester · Hand off · Keep · Capture · Explore**. Letters appear, underlined in the labels, only while the row has keyboard focus (`⌘.`).
- **R2:**
  - The selection's question lines (trimmed, ending in `?`) → `onAskMany` with one entry each; each anchor is that line and `sectionText` its section.
  - A selection with no question shows **Ask about this…** with the D1 field.
  - `⌘⏎` with a selection = Ask Hester.
- **R4:** a pure `sectionsOf(markdown) → Array<{ from, to, heading: string | null, text }>` in `lib/deepModel.ts`:
  - headings delimit sections, up to the next heading of the same or a higher level;
  - with no headings, a section is a paragraph block;
  - a list joins the line just before it when that line ends with `:`.
- **R5:** margin marks, one per section, at the section's first line. They're computed from `answers` by re-anchoring each to its section, using the states and marks in the requirements. Several items show the most urgent mark plus a count. Clicking one lists that section's cards (answers, and hand-offs with state, "Open in Work", and Reply when waiting). Opening a card still uses `renderCard`.
- **R9:** live formatting:
  - markers hidden off the cursor's line; fenced code with language highlighting; GFM tables rendered when the cursor is outside them;
  - `⌘B`, `⌘I`, `⌘⇧K` and `⌘⌥C` on the Page;
  - "Insert table" in the row when nothing is selected;
  - `⌘E` preview retired.

  `⌘I` must not reach the app's idle-tabs handler while the Page has focus: stop propagation in the Page, since `shortcuts.ts` belongs to B.
- **R10:**
  - `[[` opens an inline fuzzy picker over `files.list()`: markdown first, then everything else.
  - Picking a file opens a read-only source panel (at most half the width) via `files.read`.
  - **Quote it** inserts `> text` plus `> — [[path#Lstart-Lend|label]]` and calls `onQuote`. Enter without a highlight inserts `[[path]]`.
  - Clicking a `[[…]]` link opens the panel at those lines. Esc closes it.
- **R11:**
  - `@` opens a list of `mentionTargets`.
  - A mention offers its line-end affordance, and only `⌘⏎` or a click sends it:
    - `@hester` → `onAskMany` with the line;
    - `@claude`/`@pi` → `onHandOff` with that provider;
    - a hand-off → `onReplyHandoff`.
  - The sent line gets its mark.
- **R12:** `marginPrompts`, when given, show quietly in the margin at the top and fade when the Page has text under a heading that matches (case-insensitive substring), or on ×.

**Tests (RA)** in `deep-renderer-smoke.mjs`:
- `sectionsOf` cases: headings, paragraphs, a list after a colon;
- question splitting;
- mark aggregation (most urgent plus a count);
- the mention and `[[` parsers;
- live formatting's hide-markers decision as a pure function.

## 5. Around the Page (RB)

- **R3 Hand off sheet** (`HandoffSheet.tsx`):
  - choose the kind (Spike, Docs or Research) and the provider (default Claude);
  - the brief = template + the section text word for word + "From the exploration '<title>' (<id>)", editable;
  - shown exactly as it'll be sent;
  - **Launch** is the sheet's one `next` button.

  Launch does: `POST /handoffs` → `lee.cockpit.launch(...)` → `PATCH` the record with `task_id`. If launching fails, the record gets `status: 'error'`.
- **R6 "This session" in the ritual:** replaces the handoff step with three lists:
  - **Asked:** this session's Asks with their state; resolve or keep open.
  - **Handed off:** with kind and state.
  - **Still open on the Page:** unanswered question lines and requirement-style sections, each one click from Ask or Hand off.

  The Handoff dialog link moves to Work's header `⋯` menu ("Hand off to agents…").
- **R7:**
  - Click the header title to rename it inline.
  - Auto-title: while the title starts with `Untitled`, the first Ask, the first Hand off or the ritual sets it from the first heading, else the first line (≤ 60 chars, cut at a word), through `PATCH`.
- **R8:**
  - The opener doesn't create an exploration until the Page has text: Enter opens an in-memory Page, and the first save with content creates the exploration and writes `page.md`.
  - When an Untitled, empty Page closes, `DELETE` it and ignore the 409.
- **R12:**
  - **Entry points** when there's no `GOALS.md` or no goals:
    - Home's "Or start from" leads with "This project doesn't have goals yet";
    - Goals' empty state asks "What is this project for?" in Newsreader, with a field.

    Both open the Goals Page (`POST … purpose: 'goals'`, which returns the existing one), with the typed text as the first line.
  - **On the Goals Page:**
    - `marginPrompts`: the four prompts;
    - a **Draft goals** header action → `POST /cockpit/goals/draft` with the Page as the instruction → the diff shown in a sheet → Apply;
    - **Draft from README** as a quiet margin action while the Page is nearly empty → insert the returned text, attributed.
  - Goals with `measured: false` read "not measured yet" in the Goals section.

**Tests (RB)** in the Cockpit smokes: the brief builder, the hand-off state labels, the auto-title rule, the opener's deferred create, the ritual's "This session" lists, and the goals entry points (shown only without goals).

## 6. Checks and merging

Each agent runs, checking every exit code:
- from `electron/`: `npm run build:main`, `npm run typecheck`, every smoke in `scripts/`, `npm run build`;
- the daemon suite for B.

It commits work in progress as it goes on its own branch: `deep-next-b`, `deep-next-ra` or `deep-next-rb`. The integrator merges B, then RA, then RB onto `copilot-spec`, runs everything, and fixes only integration breakage.
