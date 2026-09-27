# The Desk: a direction for Deep's next phase

> **Status:** Direction (not yet a spec), 2026-09-27. Named **Desk** (not Desktop) on 2026-09-27: the modes are Desk (deep work), Cockpit (orchestration) and Manual (hands on). Captures decisions made in conversation after the first real Deep sessions; D2 will be specified from this.
> **Replaces, when specified:** 14 §4's four separate views (Page, Board, Browse, Workbench) and the "exploration" as Deep's unit.
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
- **Drawers** hold whole Areas you've put away (archived or parked). Cards always travel with their Area. You can take an Area back out.
- **Goals** are pinned to every Area: a small Goals card fixed in a corner of whichever Area you're in. Zooming it opens the Goals Page. A project without goals shows the "What is this project for?" prompt there (Deep next R12).
- **Lines and arrangement mean nothing yet.** Hester doesn't place or connect anything. Revisit when there's a reason.

## 3. Cards

Every card has a **hover preview** (read-only) and a **zoom to full screen** button. You only edit when zoomed in.

| Card | What it is | Notes |
|---|---|---|
| **Page** | Writing: requirements, reasoning, the blank page | Today's Page, with its Asks, hand-offs, references, open questions and margin marks. A Page owns its answers and hand-offs |
| **Board** | Figma-like: explore and mark up visual information (renders, screenshots, mockups, text boxes) | 14 §4.2 and §9 carry over |
| **Browser** | Research, testing web apps: a browser inside the Lee window | The point is to keep you from alt-tabbing out of Lee, since Hester loses context outside it. Hester's existing CDP control applies |
| **Workbench** | Writing code and managing config: a lightweight IDE (VS Code / JetBrains-inspired) | 14 §4.4's vision |
| **Workbook** | Jupyter-like: cells of code, output and notes | New; separate from Workbench |
| **Machine** (maybe, later) | A lightweight VM inside the Lee window | Probably not worth it; the browser, Board renders and a mirrored simulator cover most testing |

**Starting something:** on an empty part of an Area, typing starts a Page, pasting an image starts a Board, and choosing a file starts a Workbench (from the origin notes).

## 4. Sessions

*Decided 2026-09-27.*

- **A Deep session belongs to the Desk**, not to one card or Area: it's time at the Desk across whatever cards you touch.
- The ending ritual lists the cards you touched.
- "Pick up where you left off" is your last card and the last sentence you wrote in it.

## 5. What happens to "exploration"

| Today | Becomes |
|---|---|
| The folder (`.hester/explore/<id>/`) | `.hester/desk/`: `desk.json` (Areas, card positions, Drawers) plus one folder per card (for example `pages/<id>/page.md`, its answers, references, questions) |
| A topic | An **Area** |
| The session unit | The Desk (§4) |
| The v3 node tree and "Dive in" Hester chat | **Retired** (*decided 2026-09-27*); old ones aren't kept. Spikes became hand-offs, evidence became hand-off results, decisions became Page sections |
| The verb "Explore" | **New Page from this** (a Page placed next to the one you're in); Someday triage "Start a Page"; tasks "Think it through on a Page" |
| Library › Explorations | Library › the Desk's cards by Area, and Drawers |
| Hand-off origin `exp#answer` | `page#answer` |
| The Goals Page (`purpose: goals`) | The pinned Goals card (§2) |
| Carry on devices | Your last card and its stopped-at line |

**Migration:** each existing exploration becomes a Page card in an Area named after it. Its node tree and chat log are dropped.

## 6. Still open

- **The action row's vocabulary** (Capture vs Explore vs Keep), to settle after the current Deep round ships. The working proposal: drop Capture from the Page row; "New Page from this"; "Keep as reference".
- **Hand-off results:** do they appear as cards next to the Page that asked, or stay in the Page's margin and in Work?
- **Opening Deep:** the overview of the whole Desk, or zoomed into your last card? Does typing on an empty region always start a Page?
- **Workbook:** which languages (the project's Python, JS/TS, shell, SQL through the configured `sql:` connections)? Can its output become a Board card?
- **Browser and Hester:** only watching (pages as context for Asks), or also acting (navigating, filling in forms) when asked?
- **Devices:** a read-only view of the Desk on the phone or T-Deck, or Carry only?
