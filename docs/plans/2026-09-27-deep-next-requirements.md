# Deep, next revision: requirements

> **Status:** Requirements, 2026-09-27. Input for the next Deep contract (D1.1 fixes plus the start of D2).
> **Source:** the first real Deep session (`.hester/explore/exp-30e56c7e`: 52 minutes, rated deep) and the conversation after it.
> **Specs:** [`docs/14-Deep-Work.md`](../14-Deep-Work.md) §4.1, §5.1–§5.3, §7; the D1 contract; the Cockpit design contract (§6.1, the Page's look).

## What worked

- **Blank page** from `⇧⌘0`: straight into writing.
- **Highlight to Ask**: the right gesture.
- **The ending ritual**: useful, apart from its handoff step.

## What didn't

- **The action row's letter hints.** "Ask a" reads as a shortcut to press, and `⌘A` then selects all, so the row gets clicked instead.
- **Ask always wants a new prompt**, even when the highlighted text is already the question.
- **Handing work to an agent** has no path from the Page. The ritual's handoff step opens the v1 dialog, which is about running agents, not this session.
- **Nothing on the Page shows** what's been asked or handed off.
- **Renaming** isn't discoverable. The session ended with the title still "Untitled · Sep 27".
- **A thin answer:** a bare "What do you think?" about a pasted paragraph came back as an echo, because the model only had the selection.
- **An empty duplicate exploration**, created by the opener before writing started.

## Requirements

### R1. The action row shows words, not letters

- The row reads **Ask Hester · Hand off · Keep · Capture · Explore**, with no key hints.
- `⌘.` moves focus into the row. Only then are the mnemonic letters shown, underlined in the labels, like menu mnemonics.
- Esc returns to the text with the selection intact (as in D1).

### R2. Ask what's highlighted, as written

- **A selection that is a question** (its trimmed text ends with `?`) makes **Ask Hester** send it immediately, with no field.
- **A selection with several question lines** creates **one Ask per question** (*decided 2026-09-27*). Each Ask gets its own margin dot and its own ritual entry.
- **A selection with no question** gets **Ask about this…**, which opens the field (D1 behaviour).
- **`⌘⏎`** with a selection does the same as clicking Ask Hester.
- **Context** is the whole **section** the selection is in (R4), not just the selection. It's sent together with the exploration's title, the rest of the Page (truncated as in D1 §6) and open questions. The selection is marked as the anchor.
- Routing stays Hester's hybrid routing (D1 decision). Whether Page Asks should prefer the cloud thinking tier is left as an open question (below).

### R3. Hand off a section, with almost no retyping

- **Hand off** acts on a selection, or on the section the cursor is in when nothing is selected. It opens one sheet:
  - **Kind:** **Spike**, **Docs** or **Research** (*decided 2026-09-27*).
  - **Brief, pre-filled and editable:** a fixed template for the kind, then the section's text word for word, then "From the exploration '`<title>`'" with its id. You type nothing unless you want to.
  - **Shown exactly as it will be sent** (C3), with **Launch** as the sheet's one phosphor button.
- **Spike:** a `delegate`-lead task in a git worktree with a timebox (default 45 minutes). The template asks for a throwaway prototype and a report of evidence (what was tried, what worked, size and constraints found), not a recommendation to merge.
- **Docs:** writes or updates **repository docs as a diff in a worktree** (*decided 2026-09-27*). The template asks it to name the target file (or propose one under `docs/`) and to change nothing else. The result is reviewed like any task in review.
- **Research:** no code changes (read-only tools: read, search, web). The template asks for options compared against the section's criteria, with sources. It's effectively a heavy Ask that runs as an agent.
- Every hand-off is a Cockpit task with `origin: {kind: 'exploration', ref: '<exp>#<section anchor>'}`. It shows in Work like any agent. **Its result comes back to the Page** as an answer card in that section's margin (D1's answers store, with `kind: 'handoff'`).

### R4. Sections

- A **section** is a markdown heading and everything below it up to the next heading of the same or a higher level.
- On a Page without headings, a section is a **paragraph block**: text separated by blank lines. A list counts as one block with the paragraph just before it (so "Key requirements:" plus its bullets is one section).
- Sections are computed from the text each time (a pure function, `sectionsOf(markdown)`) and never stored. Anchors use D1's quote plus offset, re-located after edits.

### R5. A status dot beside each section in the margin

| State | Mark |
|---|---|
| Ask pending | small spinner |
| Answered, unread | filled phosphor dot |
| Answered, read | hollow dot |
| Handed off, running | a small agent mark in phosphor |
| Handed off, waiting on you | ember dot (the one place ember shows in Deep, since you'd otherwise miss it) |
| Handed off, done | hollow agent mark |

- A section with several items shows **one mark for its most urgent state**, plus a count ("3").
- Clicking a mark opens the card list for that section: answers, and hand-offs with their status and result, "Open in Work", and **Reply** for a hand-off that's waiting on you.
- Marks never move the text or take focus.

### R6. The ritual tracks what happened

The ritual's step 4 (the v1 handoff dialog) is replaced by **"This session"**:
- **Asked:** each question with its state (answered, unread, pending). Items can be left open or marked resolved.
- **Handed off:** each hand-off with its kind and status.
- **Still open on the Page:** unanswered question lines and requirement-style sections (a list under a line ending in `:`), each with **Ask** or **Hand off** one click away.
- Hand-offs still running when you choose Close Lee get D1's in-flight line ("closing Lee stops them; they'll come back as Retry").
- **The v1 handoff dialog moves to Work** in the Cockpit, where "what should my running agents do while I'm away" belongs.

### R7. Renaming

- Click the title in the Deep header to edit it inline. Enter saves; Esc cancels.
- **Automatic title** (*decided 2026-09-27*): while the title is still "Untitled · …", the first Ask, the first Hand off or the ritual sets it from the Page's first heading, else its first line (≤ 60 chars, trimmed at a word). The same inline editor changes it afterwards.

### R8. D1 fixes found in use

- **The opener creates no exploration until the Page has text.** Entering the question and pressing Enter opens a Page. The exploration is written on the first save that has content. Leaving an empty Page creates nothing.
- **Insert** keeps the attribution line (D1 §4.2). Pasting an answer by hand is the user's own choice, so there's nothing to enforce there.
- **Deleting empty explorations:** explorations that are still Untitled with an empty Page and no Asks are removed when the Page closes.

### R9. Markdown on the Page

- **Live formatting** (the Obsidian style): bold, italic, `code`, headings, lists, blockquotes and links render in place as you type. Their markdown characters show only on the line the cursor is on. The D1 `⌘E` edit/preview toggle is retired.
- **Code blocks:** fenced blocks with syntax highlighting (CodeMirror language support by the fence's language tag).
- **Tables:** GFM tables render as tables while the cursor is outside them, and as their text while you edit inside. **Insert table** is in the `⌘.` row when nothing is selected (a 3×2 starter).
- **Keys (Page only):**
  - `⌘B` bold, `⌘I` italic, `⌘⇧K` inline code, `⌘⌥C` code block.
  - `⌘I` is Lee's "idle tabs" shortcut today. It needs `notInEditor` in `shared/shortcuts.ts` so the Page gets it.
  - Check each key against CodeMirror's defaults before registering it.
- The file stays plain markdown (`page.md`). Nothing proprietary is added to it.

### R10. Quoting other files with `[[`

- **Typing `[[`** opens an inline fuzzy picker of workspace files (*decided 2026-09-27*), in this order: markdown first, then recently opened, then everything else (the Files section's sources).
- **Picking a file** opens it read-only in a **source panel** beside the Page, with markdown rendered.
- **Highlight text in the panel, then Quote it.** This inserts a blockquote on the Page:

  ```
  > the quoted text
  > — [[docs/14-Deep-Work.md#L120-L128|14-Deep-Work §6]]
  ```

  It also records a **reference** on the exploration (`kind: 'quote'`, `file`, `lines`, `section`). The quote is text you can edit; the reference keeps its source.
- **Enter without a highlight** inserts a link, `[[docs/14-Deep-Work.md]]`, and records a `link` reference to the file.
- **A `[[…]]` link in the Page** opens the source panel at those lines when clicked. The Page renders it as the short label after `|`.
- Esc closes the panel. The panel never takes over the Page; it's half width at most.
- Later: mark a quote as stale when its source lines change (from git).

### R11. `@` mentions

Mentions reach three kinds of target (*decided 2026-09-27*):

| Mention | Does |
|---|---|
| `@hester` | Turns the line (or the selection, or the section) into an Ask (R2). The line-end button reads "Ask Hester ⌘⏎" |
| `@claude`, `@pi` (the agent providers from the TUI config) | Opens the Hand off sheet (R3), pre-filled from the line or section, with that provider selected |
| `@<a hand-off from this exploration>` | Replies to that agent through the existing Reply path, showing the exact text first |

- **Typing `@`** opens an inline list: Hester, the providers, then this exploration's hand-offs by name.
- **Nothing is sent as you type.** A mention offers its line-end button (D1 §5.2's affordance), and only a click or `⌘⏎` sends. A hand-off still shows its full brief (C3).
- **Agents that weren't started from this exploration can't be mentioned.** They stay in Work, which keeps the Cockpit's babysitting out of Deep.
- A sent mention's line gets the matching margin mark (R5).

## Open questions

- **Ask routing for Page Asks:** keep hybrid routing (`gemini-3-flash-preview` answered all three today), or send Page Asks to the thinking tier by default? R2's section context may be enough to fix thin answers.
- **Hand-off timeboxes:** Spike 45 minutes by default. What should Research and Docs default to?
- **Research tools:** does Research get web access by default (C1 is about Hester's automatic behaviour, and this is a user action), or does it ask once per hand-off?
- **Board:** the session's requirements (Figma-like pan and drag, click-to-type text boxes, arrows and flowcharts, image paste, interactive mockups; "build our own on an open-source drawing backend"; Renders, Pages and maybe code on the canvas; artifact artboards) should seed the Board contract. They're also the first **Research/Spike hand-off** once R3 exists.
