# The Desk: a direction for Deep's next phase

> **Status:** Spec (D2 foundations), 2026-09-27. Named **Desk** (not Desktop) on 2026-09-27: the modes are Desk (deep work), Cockpit (orchestration) and Manual (hands on). Captures decisions made in conversation after the first real Deep sessions, and the six scope decisions of 2026-09-27 (§2–§6).
> **Contract:** [`plans/2026-09-27-desk-foundation-contract.md`](plans/2026-09-27-desk-foundation-contract.md) (packages H, D, C, V; the store, routes, events and seams).
> **Replaces:** 14 §4's four separate views (Page, Board, Browse, Workbench) and the "exploration" as Deep's unit. D2 in 14 §12 is now the Desk.
> **Origin:** the Deep Canvas Page (`.hester/explore/exp-30e56c7e`, 2026-09-27): "Canvas becomes the container for all Deep work… These all get arranged visually on the canvas…"

## 1. Why

"Exploration" does seven jobs under one word, noun and verb at once. It is:
- a storage folder;
- a topic;
- the unit of a Deep session;
- a chat log with a decision tree;
- the verb on several buttons;
- a list item;
- a special case: the Goals Page and hand-off origins.

That's where the vocabulary gets stuck: Capture, Explore and "Dive in" all read alike and do different things. Deep work also isn't only writing. It's writing, looking, researching and building, side by side, so the Desk gives each of those its own kind of card on one surface.

## 2. The Desk

*Decided 2026-09-27.*

- **One Desk per workspace.** Deep mode is *being at the Desk*.
- **Areas** are named regions of the one Desk surface: zoom out to see them all, zoom in to work in one. They replace explorations as the way thinking is grouped by topic.
- **Drawers** hold whole Areas you've **stashed** (archived or parked; *renamed from "put away" 2026-09-28*, ids and routes included: the `stashed` Drawer, `/desk/areas/{id}/stash` and `/unstash`, `stashed_at`; Hester rewrites an old `desk.json` once). Cards always travel with their Area. You can unstash an Area.
- **Goals** are one card, pinned to the Desk's top-right corner at every zoom, so it's there whichever Area you're in (*revised 2026-09-27*: first drawn once per Area, which read as separate goals). It lists GOALS.md's goals; zooming it opens the Goals Page. A project without goals shows the "What is this project for?" prompt there (Deep next R12).
- **An Area's menu** (its ⋯, or a right-click on the Area): Rename, New Page here, Stash.
- **Lines and arrangement mean nothing yet.** Hester doesn't place or connect anything, and never reads the lines you draw. Revisit when there's a reason.
- **You arrange it yourself** (*added 2026-09-27*) with three tools in a small bar at the bottom of the Desk:
  - **Cursor** (`V`, the default): everything above, as before (click to preview and open, click an empty spot to start a Page, drag bare Desk to pan, right-click menus).
  - **Move** (`M`): drag a Page card within its Area or into another, or drag an Area from anywhere inside it (not on a card) and its cards and lines come with it. Bare Desk still pans. The pinned Goals card doesn't move.
  - **Rectangle** (`R`): drag out a new Area (a click makes the smallest size), then name it; `Esc` or an empty name cancels. It also sizes an Area (*2026-09-28*): drag its right edge, bottom edge or corner. The top-left stays put, so cards and lines stay where they are, and an Area never gets smaller than its cards.
  - **Draw** (`D`): freehand lines in one quiet colour, the same width at any zoom. A line started inside an Area belongs to it: it moves with the Area, is stashed with it and is deleted with it. A line started on bare Desk belongs to the Desk.
  - The tools live in the **taskbar** along the bottom, with the Drawer at its left (opening upward like a start menu) and **New** after the tools; the right end says what the current tool does. New (*2026-09-28*, replacing New Area: Rectangle makes Areas) is a menu of what you can start: Page now, Board once it's built (shown as "soon"), then the other Desk items. A new card goes in the Area you're in, else the one in the middle of the view.
  - In Cursor, click a line to select it; `Delete` (or its right-click menu) deletes it with no confirm, and `⌘Z` undoes the last draw or delete this session. `Esc` goes back to Cursor once nothing smaller is open. Positions and lines are kept by Hester (`desk.json`).
- **Opening Deep** (*decided 2026-09-27*) lands you zoomed into your last card at the stopped-at line. One key (`Esc` from a zoomed card, once nothing smaller is open) takes you to the Desk overview.
- **Drawers this round:** the **Ideas** Drawer (the Ideas store, `.hester/ideas/`; was Someday, §6) and **Stashed** (Areas). An Area's cards go with it.
- **Images on a Page** (*2026-09-28*, [`plans/2026-09-28-tether-review-voice.md`](plans/2026-09-28-tether-review-voice.md) §4.4): a photo, screenshot or scribble sent from a device (Send to Lee) is stored with the card in `pages/<id>/assets/` (`POST /desk/pages/{id}/assets`, PNG or JPEG up to 10 MB) and written into the Page as `![caption](assets/<file>)`; deleting the card deletes its images. `hester desk page` lists them as paths.
- **The Drawer is a start menu** (*2026-09-28*): the taskbar's Drawer button opens it upward. It lists folders (Ideas, Stashed, then your own Drawers); hovering or → flies a folder out to the right, its entries grouped **Today / This week / Older** (by when they were stashed or captured). Search sits at the bottom by the button, focused on open: every word, any order, results grouped by folder. ↑↓ move, → and ← go in and out of a folder, Enter acts, Esc closes.
- **Claude Code can read the Desk** (*2026-09-28*): every Claude that Lee launches gets Lee's plugin (`--plugin-dir ~/.lee/claude-plugin`, written at startup next to the hooks) with two read-only skills, `lee:desk` (Areas, Pages and their margins, the last card) and `lee:drawer` (Stashed Areas, Ideas, search). Both call `hester desk …`, which reads the files directly, so they work with Hester off; neither writes.

**D2 foundations scope** (*decided 2026-09-27*):
- Hester's `.hester/desk/` store (§5) and the migration from explorations;
- sessions that belong to the Desk (§4);
- a zoomable Desk surface with Areas, Page cards (read-only hover preview, zoom to full screen to edit in the existing Page editor), the pinned Goals card in every Area, and the Ideas Drawer.

Board, Browser, Workbench and Workbook cards come later. Every card has a `kind`, so they slot in.

## 3. Cards

Every card has a **hover preview** (read-only) and a **zoom to full screen** button. You only edit when zoomed in.

| Card | What it is | Notes |
|---|---|---|
| **Page** | Writing: requirements, reasoning, the blank page | Today's Page, with its Asks, hand-offs, references, open questions and margin marks. A Page owns its answers and hand-offs |
| **Board** | Thinking visually: screenshots, images, renders and mockups, marked up | §3.1 (*decided 2026-09-28*); 14 §9's renders feed it later |
| **Browser** | Research, testing web apps: a browser inside the Lee window | The point is to keep you from alt-tabbing out of Lee, since Hester loses context outside it. Hester's existing CDP control applies |
| **Workbench** | Writing code and managing config: a lightweight IDE (VS Code / JetBrains-inspired) | 14 §4.4's vision |
| **Workbook** | Jupyter-like: cells of code, output and notes | New; separate from Workbench |
| **Machine** (maybe, later) | A lightweight VM inside the Lee window | Probably not worth it; the browser, Board renders and a mirrored simulator cover most testing |

**Starting something:** on an empty part of an Area, typing starts a Page, pasting an image starts a Board, and choosing a file starts a Workbench (from the origin notes). While Page is the only kind (D2 foundations), typing always starts a Page.

**Hand-off results** (*decided 2026-09-27*) stay in the Page's margin and in Work for now, not as separate cards. A hand-off's origin is `page#answer`; old `exp#answer` refs are still accepted.

### 3.1 Board

*Decided 2026-09-28* (the Boards Page in the Desk Items Area, pg-fd4ee522; replaces 14 §4.2). Build plan: [`plans/2026-09-28-boards.md`](plans/2026-09-28-boards.md).

A Board is where the Operator thinks visually: a canvas of screenshots, images, renders and mockups, marked up with annotations, highlights and drawing. It holds what words handle badly: comparing layouts, circling what's wrong in a render, gathering visual references.

- **Items on a Board:**
  - **Images**: pasted, dropped, chosen from a file, or sent from a device (Send to Lee with a Board focused).
  - **Annotations**: a text box, standalone or **pinned** to a point on an image or highlight, with a leader line to the pin.
  - **Highlights**: a selected region of an image, shown as a quiet translucent box. A highlight can carry annotations.
  - **Freehand drawing**: the Desk's Draw, one quiet colour at a fixed width.
  - **Ask cards** and **hand-off cards** (below).
  - **Links** to Pages.
- **Asks and hand-offs are their own cards on the Board**, not a margin. Asking about a selection drops a **sticky note** beside it, with a thin leader to what was selected; it shows the question, and clicking it expands it to the answer (and a follow-up field). A hand-off drops a **clipboard** that shows its kind and state, and expands to the result. Like a Page's, they're `answers.jsonl` rows that belong to the Board; the card on the canvas is where they sit.
- **What a selection sends:** Lee flattens the selection (the images with their markup) into one PNG kept in the Board's assets, and sends it with the text of the selected annotations. An Ask on a Board needs a model that reads images; a hand-off gets the image's path (Claude Code reads image paths).
- **Every asset has an optional `source`**: where it came from, pointing at another Desk item (a Browser's screenshot, a Workbench's output, a hand-off's result) or a file or URL, with when it was taken. Page images get the same field. It's what "refresh from source" (the snapshot-references spec) will use; this round only records it.
- **Links, not embeds.** A Page can't embed a Board, but it can link one with `[[`, and a Board can link Pages (a link item, or `[[` in an annotation). The `[[` picker lists Desk cards as well as files; clicking a link opens the card.
- **Starting one:** "New Board here" in an Area's menu, or pasting an image on an empty part of an Area.
- **On the Desk** a Board card's hover preview is a picture of the Board, which Lee saves (`preview.png`) as you work. The phone's Review shows the same picture; the T-Deck stays Pages only.
- **Hester stores it; Lee draws it.** The canvas is Lee's own, built on the Desk surface's camera and tools, not tldraw or Excalidraw: the vocabulary is small, it should look like the Desk, tldraw needs a paid licence, and Excalidraw's look, size and remote fonts fit Lee's CSP and style badly. Revisit Excalidraw if Boards ever need shapes and connectors.
- **Later:** the **Visualize** hand-off (an agent makes a diagram, mockup or render, and it lands on the Board as an image whose source is the hand-off); Renders (14 §9); refreshing assets from their source.

## 4. Sessions

*Decided 2026-09-27.*

- **A Deep session belongs to the Desk**, not to one card or Area: it's time at the Desk across whatever cards you touch.
- The ending ritual lists the cards you touched.
- "Pick up where you left off" is your last card and the last sentence you wrote in it.
- **Events** keep G0's metrics working: `focus.start` and `focus.item` carry `item: { kind: 'card', card_id, card_kind, … }`, with a `focus.item` each time you zoom into a different card. `deep.input` is only emitted inside a card, and `desk.zoom` records zooming in and out (contract §5).
- **The idle-end push** (*decided 2026-09-27*, 14 §8.1). Just before Deep's 45-minute idle end, and only while Lee is open, the devices get one push: **Extend**, **End and rate**, or **Capture**.

## 5. What happens to "exploration"

| Today | Becomes |
|---|---|
| The folder (`.hester/explore/<id>/`) | `.hester/desk/`: `desk.json` (Areas, card positions, Drawers) plus one folder per card (for example `pages/<id>/page.md`, its answers, references, questions) |
| A topic | An **Area** |
| The session unit | The Desk (§4) |
| The v3 node tree and "Dive in" Hester chat | **Retired** (*decided 2026-09-27*); old ones aren't kept. Spikes became hand-offs, evidence became hand-off results, decisions became Page sections |
| The verb "Explore" | **New Page from this** (a Page placed next to the one you're in); Ideas triage "Start a Page"; tasks "Think it through on a Page" (`POST /cockpit/tasks/{id}/escalate` makes a Page card in the first Area, 2026-09-28) |
| Library › Explorations | The Desk: its cards by Area, and Drawers (Library is gone, §6) |
| Hand-off origin `exp#answer` | `page#answer` |
| The Goals Page (`purpose: goals`) | The pinned Goals card (§2) |
| Tether on devices | Your last card and its stopped-at line (*decided 2026-09-27*; renamed from Carry 2026-09-28, routes included: `/tether/*`). *2026-09-28:* devices become Work · Review · Hester, and **Review** reads the Desk (phone: Areas → Pages → a Page; T-Deck: Pages, newest first), the Drawer (phone) and Files; still no Desk canvas and no editing on devices |

**Migration** (*decided 2026-09-27*):
- It **copies**. Each existing exploration becomes a Page card in an Area named after it, with its Page, answers, references, questions and sessions.
- `.hester/explore/` is left untouched as a backup.
- Node trees and chats aren't carried over.
- It's idempotent: running it again changes nothing.
- The v3 node tree and "Dive in" chat UI are retired from the renderer. *2026-09-28:* Hester's pre-Desk routes (`/cockpit/explorations/*`, `/library/sessions/*`) are removed too; `ExplorationStore` stays only as the migration's read-only source.

## 6. Cockpit and Desk

*Decided 2026-09-27.* The three modes are **Desk** (deep work), **Cockpit** (orchestration) and **Manual** (hands on).

**The Cockpit's job is reassurance.** It exists so you trust that the work is handled, and feel free to go back to the Desk. What reassures you stays in the Cockpit; your own thinking moves to the Desk.

| Today | Goes to |
|---|---|
| Work, Ops | Cockpit (unchanged) |
| **History** | Folded into **Home**: a "shipped this week" strip, the weekly retro. Usage moves to Ops |
| Goals: status (metrics, on track, Evaluate) | Cockpit's **Goals** |
| Goals: the Goals Page | The Desk, pinned in every Area (§2) |
| Library: explorations | The Desk: Areas and Drawers |
| Library: ideas (Someday, now **Ideas**) | The Desk: an **"Ideas" Drawer** next to the Drawers of stashed Areas. Captures from the phone and T-Deck land there. Drag one onto an Area to start a Page from it |
| Library: files | The Desk (Workbench) and Manual |
| Home's opener ("What's on your mind?", start-from links) | The Desk's front: typing on an empty Area starts a Page |

**The Cockpit becomes Home, Work, Goals and Ops** (`⌘1`–`⌘4`; *decided 2026-09-27* that this restructure happens now, with D2 foundations). Library is gone: explorations go to Desk Areas and Drawers, ideas to the Ideas Drawer, and files to Manual (and later Workbench). Usage moves to Ops. **Home** is one reassuring sentence ("Everything's handled. Two agents working, one needs you."), the one or two things that need you (answerable there), what shipped, and one big door, **Back to your Desk**, showing your last card and your stopped-at line. You check the Cockpit and then leave it; the Desk is where you stay.

**Devices** (*decided 2026-09-27*; 13 v6, second pass) get Cockpit and Tether, never Deep. This round:
- the idle-end push (§4);
- Dirigible's key for the fourth quick reply, "Show me the diff";
- Dirigible's In flight folds agents older than 2h;
- Aeronaut's one-agent screen gets Check in, Rename, Accept and Assign;
- "Snoozed · Undo" collapses on the phone;
- Tether becomes your last Desk card and its stopped-at line;
- `/carry/capture` (now `/tether/capture`) spools offline instead of returning 503.

## 7. Still open

- **The action row's vocabulary** (Capture vs Explore vs Keep), to settle after the current Deep round ships. The working proposal: drop Capture from the Page row; "New Page from this"; "Keep as reference".
- **Workbook:** which languages (the project's Python, JS/TS, shell, SQL through the configured `sql:` connections)? Can its output become a Board card?
- **Browser and Hester:** only watching (pages as context for Asks), or also acting (navigating, filling in forms) when asked?
- **Devices:** a read-only view of the Desk on the phone or T-Deck, or Tether only? (This round is Tether only.)
