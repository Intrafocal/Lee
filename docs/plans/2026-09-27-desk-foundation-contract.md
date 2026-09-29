# Desk foundations (D2): contract

> **Status:** Contract, 2026-09-27
> **Direction:** [`../16-Desk.md`](../16-Desk.md) (read it first: it says what the Desk is and why; this document says who builds what, and the exact shapes they share). Decisions 1–6 of 2026-09-27 are recorded there.
> **Builds on:** Deep D1 and Deep next ([`2026-09-27-deep-next-contract.md`](2026-09-27-deep-next-contract.md)) and the Cockpit redesign ([`2026-09-27-cockpit-design-contracts.md`](2026-09-27-cockpit-design-contracts.md)), all merged on `copilot-spec`. The design rules still hold: phosphor marks the one next step (at most one `Btn kind="next"` per view), ember is needs-you and shows as a dot, your own words are in Newsreader, one column, scroll and tap to drill in.
> **Not settled, don't rename:** the action row's Capture / Explore / Keep. **Settled names:** Desk, Area, Drawer, card, Ideas Drawer.

## 0. What this round builds

- **The Desk store** in Hester (`.hester/desk/`), with Areas, card positions, Drawers and one folder per card. Only **Page** cards this round; every card has a `kind` so Board, Browser, Workbench and Workbook slot in later.
- **Migration** from `.hester/explore/`. It copies and is idempotent, and it leaves the old folder untouched as a backup.
- **Sessions belong to the Desk.** The ending ritual lists the cards you touched; "pick up" is your last card and its stopped-at line.
- **The Desk surface:** Deep mode becomes the Desk. Areas, Page cards with a hover preview and a zoom to full screen (the existing Page editor), the pinned Goals card in every Area, the Ideas Drawer and the Put away Drawer. Entering Deep lands you zoomed into your last card at the stopped-at line; one key goes to the Desk overview.
- **The Cockpit becomes Home, Work, Goals and Ops** (`⌘1`–`⌘4`). History folds into Home, Usage moves to Ops, and Library goes. Home gets the **Back to your Desk** door.
- **Devices (13 v6, second pass):** the idle-end push, "Show me the diff" on Dirigible, In flight folding, Aeronaut's one-agent actions, "Snoozed · Undo", Tether as your last Desk card, and `/carry/capture` spooling offline.

**Not this round:** Board, Browser, Workbench and Workbook cards; hand-off results as cards (they stay in the Page's margin and in Work); a Desk view on devices; lines or arrangement that mean anything; Hester placing cards. The v3 node tree and the "Dive in" chat are retired from the renderer. Their Hester code may stay, but nothing new depends on it.

## 1. Packages and ownership

Four agents, each in its own worktree and branch, built in parallel after the seam commit **Z** (§2), then merged.

| Package | Branch | Owns |
|---|---|---|
| **H** (Hester) | `desk-h` | `hester/**`, `tests/**` |
| **D** (the Desk surface) | `desk-d` | `electron/src/renderer/components/deep/**`, `electron/src/renderer/components/desk/**` (new), `components/cockpit/cockpitMode.ts`, `components/CommandPalette.tsx`, `components/paletteAbout.ts`, `lib/hesterDeep.ts`, `lib/deepModel.ts`, `lib/hesterDesk.ts` (new), `lib/deskModel.ts` (new), `scripts/deep-renderer-smoke.mjs`, `scripts/cockpit-explore-smoke.mjs`, `scripts/desk-renderer-smoke.mjs` (new) |
| **C** (the Cockpit) | `desk-c` | `electron/src/renderer/components/cockpit/**` except `cockpitMode.ts`, `components/StatusBar.tsx`, `components/copilot/**`, `components/lint/**`, `components/LibraryPane.tsx`, `components/library/**`, `renderer/App.tsx`, `lib/cockpitModel.ts`, `lib/workModel.ts`, `lib/hesterCockpit.ts`, `electron/src/shared/shortcuts.ts`, `docs/shortcuts.md`, `CLAUDE.md`, `docs/15-Usage.md`, `scripts/cockpit-renderer-smoke.mjs`, `scripts/cockpit-work-smoke.mjs`, `scripts/copilot-renderer-smoke.mjs` |
| **V** (devices and Lee main) | `desk-v` | `aeronaut/**`, `dirigible/**`, `electron/src/main/**` (including `preload.ts`), `electron/src/shared/**` except `shortcuts.ts` (after Z), `docs/Dirigible.md`, the main smokes (`scripts/copilot-*-smoke.js`, `scripts/cockpit-{lint,ops,shell,tab,pi}-smoke.*`) |

**Why V owns all of Lee main.** The idle-end push and spooling need the Deep session to know its card, so the card plumbing in main (the `card` focus item, `deepStart` with `card_id`, the `deep.*` event validator, `deep.answer` forwarding, the `page` task origin in the launcher) belongs to the same package. There's one owner per file.

**Shared files, one owner each:**

| File | Owner | Others |
|---|---|---|
| `shared/desk.ts` (new), `shared/copilot.ts`, `shared/cockpit.ts` | Z writes §2, then **V** | read-only; they report a needed change as a question |
| `shared/shortcuts.ts` | **C** | D implements its Desk keys locally and C lists them (§8) |
| `main/preload.ts` | **V** | no new IPC is needed this round (§9.1) |
| `renderer/App.tsx` | **C** | D needs no App change: `DeepHost` keeps its export and props (§7.1) |
| `components/cockpit/cockpitMode.ts` | **D** | C calls `openDesk` (Z's stub, §2.4) and doesn't edit the file |
| `lib/hesterCockpit.ts` | **C** | C doesn't delete its exploration or v3-tree exports this round (the explore smoke imports them); dead exports go in the merge step |
| `docs/16-Desk.md`, `docs/13`, `docs/14`, this contract | the integrator | agents report contract gaps in their final message |

Nobody edits another package's stylesheet: `deep.css` and `desk.css` (new) are D's, and `cockpit-shell.css`, `work.css` and `library.css` (deleted) are C's.

## 2. Step Z: the seam commit (before branching)

The integrator makes one commit on `copilot-spec` before creating the four worktrees: `chore(desk): seam types and stubs (Z)`. It contains exactly §2.1–§2.4. It may make the smallest compile fixes anywhere (for example a missing case in a `Record<AttentionKind, …>`) and must leave `npm run build:main`, `npm run typecheck` and every smoke passing. After Z, §1's ownership applies.

### 2.1 `electron/src/shared/desk.ts` (new, verbatim)

```ts
/**
 * The Desk (docs/16-Desk.md): Hester's .hester/desk/ store as the renderer,
 * Lee main and devices see it. Shapes: docs/plans/2026-09-27-desk-foundation-contract.md §2–§5.
 */
import type { Anchor, DepthRating } from './cockpit';

/** Only 'page' this round; 'board' | 'browser' | 'workbench' | 'workbook' slot in later. */
export type DeskCardKind = 'page';
export const DESK_CARD_KINDS: readonly DeskCardKind[] = ['page'];

export const PAGE_ID_RE = /^pg-[0-9a-f]{8}$/;
export const AREA_ID_RE = /^area-[0-9a-f]{8}$/;
export const DRAWER_ID_RE = /^(put-away|ideas|drw-[0-9a-f]{8})$/;
/** The two built-in Drawers. 'ideas' is the Someday store; 'put-away' holds Areas. */
export const IDEAS_DRAWER = 'ideas';
export const PUT_AWAY_DRAWER = 'put-away';

/** Desk coordinates, in CSS px at zoom 1. Areas sit on the Desk; a card's x/y are relative to its Area's top-left. */
export interface DeskRect { x: number; y: number; w: number; h: number }

export interface DeskArea extends DeskRect {
  id: string;
  name: string;
  /** null: on the Desk. Else the Drawer it's put away in (x/y are kept for taking it back out). */
  drawer_id: string | null;
  created_at: string;
  updated_at: string;
  /** The exploration it was migrated from, else null. */
  migrated_from: string | null;
}

export interface DeskCardSummary {
  page_chars: number;
  page_updated_at: string | null;
  /** The start of page.md (≤ 600 chars, cut at a line), for the hover preview. */
  excerpt: string;
  answers_unread: number;
  answers_pending: number;
  /** Hand-offs in state launching, running, waiting or review. */
  handoffs_in_flight: number;
  open_questions: number;
}

export interface DeskCard extends DeskRect {
  id: string;
  kind: DeskCardKind;
  /** null only for the pinned Goals card, which shows in every Area. */
  area_id: string | null;
  title: string;
  purpose: 'goals' | null;
  /** True only for the Goals card: drawn in each Area's top-right corner, never moved. */
  pinned: boolean;
  created_at: string;
  updated_at: string;
  last_touched_at: string | null;
  migrated_from: string | null;
  summary: DeskCardSummary;
}

export interface DeskDrawer {
  id: string;
  name: string;
  kind: 'areas' | 'ideas';
  /** kind 'areas': its Areas, most recently put away first. Always [] for 'ideas'. */
  area_ids: string[];
  /** Areas in it, or open Someday items for 'ideas'. */
  count: number;
}

export interface DeskMigrationReport {
  at: string;
  migrated: number;
  already: number;
  skipped_empty: number;
  goals_card_id: string | null;
  errors: Array<{ exploration_id: string; error: string }>;
}

/** GET /desk */
export interface Desk {
  version: 1;
  workspace: string;
  areas: DeskArea[];
  cards: DeskCard[];
  /** Always both built-ins first: [ideas, put-away], then any others. */
  drawers: DeskDrawer[];
  goals_card_id: string | null;
  last: { card_id: string; at: string } | null;
  /** The last migration run that migrated anything; null when none ever did. */
  migration: DeskMigrationReport | null;
}

export interface DeskCardBrief {
  id: string;
  kind: DeskCardKind;
  title: string;
  area_id: string | null;
  area_name: string | null;
  purpose: 'goals' | null;
  last_touched_at: string | null;
}

export type DeskSessionReason = 'ritual' | 'esc' | 'away' | 'quit' | 'device';
export interface DeskQuestionRef { card_id: string; question_id: string }
export interface DeskSessionRecord {
  id: string;
  focus_session_id: string;
  started_at: string;
  ended_at: string;
  reason: DeskSessionReason;
  stopped_at: string | null;
  /** The card the stopped-at line is in (the last card zoomed into). */
  stopped_card_id: string | null;
  rating: DepthRating | null;
  questions_kept: DeskQuestionRef[];
  /** Card ids zoomed into during the session, in first-touched order. */
  cards_touched: string[];
}
export type DeskSessionCreate = Omit<DeskSessionRecord, 'id'>;

/** GET /desk/last: where "Back to your Desk", landing, Tether and the opener's pick-up start. */
export interface DeskLast {
  card: DeskCardBrief | null;
  /** Why this card: a device's Open next, the last card zoomed into, the last session's, or the most recently written. */
  source: 'open_next' | 'last' | 'session' | 'recent' | null;
  /** The stopped-at sentence, tail-clipped to 160 chars with a leading "…". */
  stopped_at: string | null;
  /** 1-based line in page.md where stopped_at is; null when not found. */
  stopped_line: number | null;
  /** Since the last session ended (or unread, with no session). */
  arrived: { answers: number; handoffs: number; open_questions: number; captured: number };
  last_session: DeskSessionRecord | null;
}

// Requests ------------------------------------------------------------------

export interface DeskAreaCreate { name: string; x?: number; y?: number; w?: number; h?: number }
export interface DeskAreaPatch { name?: string; x?: number; y?: number; w?: number; h?: number }
export interface DeskCardPatch { x?: number; y?: number; w?: number; h?: number; area_id?: string; title?: string }

export interface DeskPageCreate {
  /** Required unless purpose is 'goals'. */
  area_id?: string | null;
  x?: number; y?: number; w?: number; h?: number;
  title?: string;
  /** The first page.md content: the deferred create writes the Page's text with it (Deep next R8). */
  text?: string;
  purpose?: 'goals';
  /** "New Page from this": placed next to this card, in its Area, when area_id and x/y are absent. */
  from?: { card_id: string; anchor?: Anchor };
}
/** POST /desk/pages: 201 when created; 200 with created: false for an existing Goals card. */
export interface DeskPageCreated { card: DeskCard; page: { text: string; version: string }; created: boolean }

export interface IdeaToPage { area_id?: string | null; x?: number; y?: number }
export interface IdeaToPageResult { card: DeskCard; area: DeskArea; someday_id: string }

// Helpers -------------------------------------------------------------------

/** exp-1a2b3c4d -> pg-1a2b3c4d (migration keeps the hex, so old refs map without a lookup). */
export function pageIdForExploration(expId: string): string | null {
  const m = /^exp-([0-9a-f]{8})$/.exec(expId);
  return m ? `pg-${m[1]}` : null;
}

/** The Page card a task came from: origin {kind:'page', ref:'pg-…#ans-…'}, or the old {kind:'exploration', ref:'exp-…#ans-…'}. */
export function cardIdForOrigin(origin: { kind: string; ref?: string | null } | null | undefined): string | null {
  const head = (origin?.ref ?? '').split('#')[0];
  if (origin?.kind === 'page') return PAGE_ID_RE.test(head) ? head : null;
  if (origin?.kind === 'exploration') return pageIdForExploration(head);
  return null;
}
```

### 2.2 `electron/src/shared/copilot.ts` (additions)

```ts
import type { DeskCardKind } from './desk';

// FocusItem gains:
  /** Desk D2: a Deep session at the Desk; card_id null = at the overview with no card yet. */
  | { kind: 'card'; workspace: string; card_id: string | null; card_kind: DeskCardKind | null; title: string };

// FocusState.deep becomes (card fields optional so older payloads still type):
  deep: { exploration_id: string | null; title: string; workspace: string; card_id?: string | null; card_kind?: DeskCardKind | null } | null;

// DeepStartRequest becomes:
export interface DeepStartRequest {
  workspace: string;
  /** Legacy (D1); ignored when card_id is present. */
  exploration_id: string | null;
  title?: string;
  surface?: string;
  card_id?: string | null;
  card_kind?: DeskCardKind | null;
}

// AttentionSnapshot.deep becomes:
  deep?: { exploration_id: string | null; title: string; card_id?: string | null; card_kind?: DeskCardKind | null } | null;

// AttentionKind gains:
  | 'deep_idle'; // Desk D2: the one idle-end push (§9.2); devices only, never shown in the Cockpit

// AttentionActionName gains 'extend' | 'end_rate' | 'capture'.

// AttentionItem gains:
  /** kind 'deep_idle' only. */
  deep_idle?: { session_id: string; ends_at: string; card: { card_id: string; title: string } | null } | null;

/** POST /deep/idle-end (§9.2). */
export type DeepIdleEndRequest =
  | { item_id: string; version: number; action: 'extend' }
  | { item_id: string; version: number; action: 'end_rate'; rating: DepthRating | null; stopped_at?: string | null };
```

### 2.3 `electron/src/shared/cockpit.ts` (additions)

```ts
import type { DeskCardKind } from './desk';

// TaskOriginKind gains 'page'. Comment: 'page' refs a hand-off record ('<page id>#<answer id>'); 'exploration' is the pre-Desk form.
// AboutKind gains 'page'.

// DeepRendererEvent: deep.input / deep.view / deep.action data gain `card_id?: string` and
// `card_kind?: DeskCardKind`; their `exploration_id` becomes optional (legacy). New variant:
  | { type: 'desk.zoom'; data: { card_id: string | null; card_kind: DeskCardKind | null; via: 'land' | 'key' | 'click' | 'link' } };

// DeepAnswerEvent gains `card_id?: string` (Hester sends both, §5.3).

// Opener (legacy aliases kept; §6.4):
//   pick_up gains card?: DeskCardBrief; stopped_line?: number | null
//   open_questions / reading_list / quiet items gain card_id?: string (and open_questions card_title?: string)

/** The four Cockpit sections (Desk D2, docs/16-Desk.md §6). C switches to these; SectionId and LEGACY_SECTION stay until the merge step. */
export type CockpitSectionId = 'home' | 'work' | 'goals' | 'ops';
export const COCKPIT_SECTION: Record<string, CockpitSectionId> = {
  copilot: 'home', feed: 'work', tasks: 'work', explore: 'home', someday: 'home', files: 'home', tabs: 'home',
  library: 'home', history: 'home', home: 'home', work: 'work', goals: 'goals', ops: 'ops',
};
```

### 2.4 `components/cockpit/cockpitMode.ts` (stubs that D implements)

```ts
/** Where openDesk lands (Desk D2 §7.2). */
export type DeskTarget =
  | { kind: 'last' }                                            // your last card at its stopped-at line (GET /desk/last)
  | { kind: 'card'; card_id: string; line?: number | null }
  | { kind: 'goals'; first_line?: string }                      // the Goals card; creates it (POST /desk/pages purpose goals)
  | { kind: 'overview' };

/** Switch to Deep (the Desk) and land on `target`; starts or retargets the Deep session. */
export async function openDesk(api: CopilotAPI | null | undefined, workspace: string, target: DeskTarget): Promise<void> {
  // Z stub: D replaces the body. Keeps today's behaviour so the app builds and runs.
  goDeep(api, workspace);
}
```

## 3. The store (H)

```
.hester/desk/
  desk.json                       # layout and Drawers (below)
  sessions.jsonl                  # DeskSessionRecord, one per line
  pages/<pg-id>/
    card.json                     # { id, kind: 'page', title, purpose, seed, goals: [], origin, created_at, updated_at, last_touched_at, migrated_from }
    page.md                       # your writing
    answers.jsonl                 # asks and hand-offs (today's DeepAnswer rows, same ids)
    references.jsonl              # today's DeepReference rows
    questions.jsonl               # today's DeepQuestion rows (they lived in exploration frontmatter)
```

`desk.json`:

```json
{
  "version": 1,
  "areas":   [{ "id": "area-1a2b3c4d", "name": "Mesh sync", "x": 0, "y": 0, "w": 1200, "h": 800,
                "drawer_id": null, "put_away_at": null, "created_at": "…Z", "updated_at": "…Z", "migrated_from": "exp-1a2b3c4d" }],
  "cards":   [{ "id": "pg-1a2b3c4d", "kind": "page", "area_id": "area-1a2b3c4d", "x": 48, "y": 96, "w": 360, "h": 240 }],
  "drawers": [{ "id": "put-away", "name": "Put away" }],
  "goals_card_id": "pg-9f8e7d6c",
  "last": { "card_id": "pg-1a2b3c4d", "at": "…Z" },
  "migration": { "map": { "exp-1a2b3c4d": "pg-1a2b3c4d", "exp-00000000": null }, "last_report": { } }
}
```

- **Titles live in `card.json` only.** `desk.json` holds layout. `GET /desk` joins them.
- **Ids:** `pg-`, `area-` and `drw-` with 8 hex characters, and `ses-` for sessions. Answer, reference and question ids keep today's formats. `ideas` and `put-away` are fixed.
- **The Goals card** is a Page with `purpose: 'goals'`, `area_id: null` and `pinned: true`. Its layout entry has x/y/w/h 0, since D draws it in each Area's corner. There's at most one per workspace.
- **An empty Desk** gets one Area, `Main`, at 0,0, created on first read.
- **Writes** go under the workspace lock (`ctx.lock`), with `atomic_write` for `desk.json` and `card.json` and today's jsonl helpers for the rest. Layout writes are last-write-wins, which is fine with one user.
- **Deep's record code is reused.** `deep.py`'s answers, references, questions, page read and write, hand-off and delete-empty functions take a store and an id today. H gives them a page store with the same surface (`require`, `exists`, `get`, `dir`, `page_path`, `touch`, `workspace`) so the Page's rules (1 MB cap, version conflict, anchors, file references, R8 delete guard) are exactly the same on a card. Questions move from frontmatter to `questions.jsonl`, with the same row shape.

## 4. HTTP routes (H)

Hester on `:9000`, the copilot envelope as everywhere: `{ success: true, data, workspace, workspace_id }`, errors `{ success: false, error }`. The workspace comes from `?workspace=` or `X-Lee-Workspace`, else the body's `workspace`, else the active one. Common errors: **400** with a message for a bad body or bad id, **404** `not found` for an unknown card, Area or Drawer, **409** as listed. Every `/desk` read runs the migration first when it's due (§6.1).

| Method and path | Body | 2xx `data` | Errors |
|---|---|---|---|
| `GET /desk` | | `Desk` | |
| `POST /desk/migrate` | | `DeskMigrationReport` (runs now; a no-op run reports `migrated: 0`) | |
| `GET /desk/last` | | `DeskLast` | |
| `PUT /desk/last` | `{ card_id }` | `{ card_id, at }` | 404 unknown card |
| `POST /desk/areas` | `DeskAreaCreate` | 201 `DeskArea` (without x/y it's placed in the next free grid slot, §6.1) | 400 empty or > 120-char name |
| `PATCH /desk/areas/{id}` | `DeskAreaPatch` | `DeskArea` | |
| `DELETE /desk/areas/{id}` | | `{ deleted: true }` | 409 `not_empty` when it has cards |
| `POST /desk/areas/{id}/put-away` | `{ drawer_id? }` (default `put-away`) | `DeskArea` | 400 `ideas` or unknown Drawer |
| `POST /desk/areas/{id}/take-out` | `{ x?, y? }` | `DeskArea` (`drawer_id: null`) | 409 `not_put_away` |
| `POST /desk/drawers` | `{ name }` | 201 `DeskDrawer` | |
| `PATCH /desk/drawers/{id}` | `{ name }` | `DeskDrawer` | 400 for `ideas` |
| `PATCH /desk/cards/{id}` | `DeskCardPatch` | `DeskCard` | 400 moving the Goals card, or `area_id` in a Drawer |
| `POST /desk/pages` | `DeskPageCreate` | 201 `DeskPageCreated`, or 200 with `created: false` for an existing Goals card | 400 no `area_id` and no `from` (unless goals); 404 `from.card_id` |
| `GET /desk/pages/{id}` | | `DeskCard` | |
| `PATCH /desk/pages/{id}` | `{ title }` | `DeskCard` | |
| `DELETE /desk/pages/{id}` | | `{ deleted: true }` | 409 `not_empty` (same guard as Deep next R8) |
| `GET /desk/pages/{id}/page` | | `{ text, version }` | |
| `PUT /desk/pages/{id}/page` | `{ text, base_version }` | `{ version }` | 409 `{ error: 'version_conflict', version, text }` (also under `data`, as today) |
| `GET/POST /desk/pages/{id}/references`, `PATCH …/references/{rid}` | as today's exploration routes | | |
| `GET /desk/pages/{id}/answers`, `PATCH …/answers/{aid}`, `POST …/answers/{aid}/retry` | as today | | |
| `POST /desk/pages/{id}/asks` | as today (`question`, `anchor`, `section_text?`, `follow_up_of?`) | 202 `DeepAnswer` | |
| `POST /desk/pages/{id}/handoffs` | as today | 201 `DeepAnswer` | |
| `GET/POST /desk/pages/{id}/questions`, `PATCH …/questions/{qid}` | as today | | |
| `POST /desk/pages/{id}/draft-from-readme` | | `{ text, sources? }` | as today |
| `GET /desk/sessions?limit=` | | `DeskSessionRecord[]`, newest first (default 20, max 200) | |
| `POST /desk/sessions` | `DeskSessionCreate` | 201 `DeskSessionRecord` | 400 as today's session validation, plus `cards_touched` and `stopped_card_id` must be page ids (unknown ids are dropped, not refused) |
| `POST /desk/ideas/{someday_id}/page` | `IdeaToPage` | 201 `IdeaToPageResult` | 404 unknown item; 409 `not_open` |

- `GET /cockpit/handoff-template` is unchanged.
- **The Ideas Drawer's contents** are `GET /someday?status=open`, and its Keep, Drop and Promote are `POST /someday/{id}/triage`, as today. `POST /desk/ideas/{id}/page` creates a Page whose text is the idea's text, in `area_id` or, without one, in a new Area named after the idea (first line, ≤ 60 chars, cut at a word). It marks the item `explored` and records `origin: { kind: 'someday', ref }` in `card.json`. Someday triage `action: 'explore'` now does the same (new Area) and returns `{ item, card, exploration: { id: card.id, title } }`; the last key is a legacy alias.
- **Deletes are only for empty things.** No route deletes a card with content, or an Area with cards: put the Area away instead.

## 5. Sessions on the Desk

### 5.1 Events (Lee's event log; G0 metrics read these)

| Event | When | `data` |
|---|---|---|
| `focus.start` | entering Deep, as today | `{ session_id, source: 'deep', item: { kind: 'card', workspace, card_id, card_kind, title }, … }`. `card_id` is null at the overview with no card yet |
| `focus.item` | zooming into a **different** card (never on zooming out) | `{ session_id, item: { kind: 'card', … } }` |
| `focus.end` | as today | unchanged (`reason`, `duration_ms`, `interruptions`, `deep_rating`, `stopped_at_chars`), plus `ended_via: 'device'` when a device ended it (§9.2) |
| `deep.input` | as today, **only while zoomed into a card** | `{ card_id, card_kind, view: 'page', keys, clicks, wheels, span_ms }` (no text) |
| `deep.action` | as today | `{ action, card_id, chars? }` |
| `desk.zoom` | each zoom in or out | `{ card_id \| null, card_kind \| null, via: 'land' \| 'key' \| 'click' \| 'link' }` |
| `deep.idle_push` | the one push is sent | `{ session_id, ends_at }` |
| `deep.extend` | Extend from a device | `{ session_id, minutes, surface }` |

- `deep_time`, `time_to_deep` and `session_depth` need no formula change. They read `focus.*` and `deep.input` spans, which keep their meaning: input inside a card. Overview panning isn't emitted as `deep.input`.
- Lee main's validator (V) accepts `exploration_id` as a legacy alias of `card_id` on `deep.*` and drops anything else.
- H's `opener.deep_sessions` and `metrics` accept `item.kind` `'card'` (→ `card_id`) and `'exploration'` (legacy).

### 5.2 Records

- **Where they're written.** A session's `DeskSessionRecord` is written by whoever ended it:
  - the ritual or Esc → D, with `POST /desk/sessions`;
  - Extend's end or End and rate from a device → V (Lee main), with `POST /desk/sessions` and `reason: 'device'`, or `'away'` for an ignored push;
  - away or quit with no record → H, from the event log, as `write_missing_sessions` does today, now for the Desk. `cards_touched` comes from the session's `focus.start` and `focus.item` card ids, and `stopped_card_id` is the last of them.
- **`stopped_at`** is the last sentence you wrote in `stopped_card_id` (the ritual pre-fills it, as today).
- The old per-exploration `sessions.jsonl` is migrated into `.hester/desk/sessions.jsonl` (§6.1). `open_next` staleness and the opener read the Desk's.

### 5.3 `deep.answer` to Lee

H ingests `deep.answer` with `{ workspace, card_id, exploration_id: <same card id>, answer_id, status, kind?, state? }`. The duplicate `exploration_id` keeps a Lee main from before V's change forwarding it. V's `deepAnswerEvent` accepts either field and emits `DeepAnswerEvent` with both.

## 6. H: Hester

### 6.1 Migration

- **When:** lazily on every `/desk` read, cheaply (a directory listing compared with `migration.map`), and on `POST /desk/migrate`. It runs under the workspace lock.
- **Idempotent.** An exploration id already in `migration.map` is skipped. That includes `null` entries for skipped ones. An exploration created later (an old client) is migrated on the next read. Edits to an already-migrated exploration aren't carried over; the old routes are no longer used by any new code.
- **For each exploration** in `.hester/explore/` (directories and legacy single files, through `ExplorationStore.load_all()`):
  - **Empty and Untitled** (Deep next R8's `is_empty`) → `map[exp] = null`, counted as `skipped_empty`.
  - **`purpose: 'goals'`** → the Goals card, `pg-<hex>`, `pinned`, with no Area. A second one (it shouldn't happen) becomes an ordinary Page.
  - **Otherwise** → an Area `area-<hex>` named after the exploration's title, and a Page `pg-<hex>` in it at `x: 48, y: 96, w: 360, h: 240`, with `title` and `seed` from the exploration. It carries `goals` links, `created_at`, `last_touched_at` and `migrated_from: exp`. Archived explorations' Areas go in `put-away`.
  - **Copied:** `page.md`, `answers.jsonl` and `references.jsonl` byte for byte, keeping ids; the frontmatter `questions` → `questions.jsonl`. Pending answers are then marked `interrupted` by the runner's recovery, so they offer Retry.
  - **Sessions:** each `sessions.jsonl` row → the Desk's, with `stopped_card_id: pg-<hex>`, `cards_touched: [pg-<hex>]` and `questions_kept` strings → `{ card_id, question_id }`. Duplicates by `focus_session_id` are skipped.
  - **Not copied:** the node tree, the Log and chats.
  - **Never written or deleted:** `.hester/explore/`.
- **Collisions.** If `pg-<hex>` or `area-<hex>` already exists and isn't from this exploration, H uses a fresh random id and records it in the map.
- **Layout:** Areas in a 3-column grid of 1200×800 slots with a 200 gap, in exploration `created_at` order. New Areas without a position take the next free slot.
- **Open next:** `.hester/deep/open_next.json`'s `exploration_id` is rewritten to `card_id` through the map.
- **Reporting:** the run's `DeskMigrationReport` is stored in `desk.json` when it migrated anything, and logged.

### 6.2 Hand-offs

- **The origin is `{ kind: 'page', ref: '<pg id>#<ans id>' }`.** `tasks.py` `ORIGIN_KINDS` gains `page`, and the follower's `REF_ORIGINS` gains it too.
- **`handoffs.sync`** accepts both forms:
  - `page` refs go to the page store;
  - `exploration` refs map to `pg-<hex>` when `migration.map` has them, else they go to the exploration as today.
- **The ingest** is §5.3's.
- **`handoff_brief`** gains the Page form, "From the Page '<title>' (<id>)". The template text is unchanged.

### 6.3 deep-ask on Page cards

- **`DeepAskRunner`, `Job`, `context_for` and `build_context`** take a store-and-id pair that can be a page. The context uses the card's title and seed and today's anchor, section and reference rules, unchanged.
- **Logging:** `steward.request` stays `{ surface: 'deep-ask', about_kind: 'exploration' }`, so `pull_usage` doesn't move.
- **The steward's `about`** accepts `{ kind: 'page', id }` and reads the Page like an exploration.
- **Recovery** (`ensure_recovered`, `interrupt_pending`) covers pages.

### 6.4 The opener, pick-up, Open next and Tether's source

- **`GET /desk/last`** picks the card in this order:
  1. a live Open next `card_id`, which gives `source: 'open_next'`;
  2. `desk.json` `last` (`'last'`);
  3. the latest session's `stopped_card_id` (`'session'`);
  4. the most recently written page (`'recent'`);
  5. else `card: null`.
- **`stopped_at`:** the latest session's, when its `stopped_card_id` is this card, else the card's last non-empty line (tail-clipped as today).
- **`stopped_line`:** the 1-based line of the last occurrence of `stopped_at`'s text (without the leading "…", whitespace-normalised) in `page.md`, else the last non-empty line's number, else null.
- **`arrived`:** since the latest session ended:
  - done answers and done hand-offs on the card (`answered_at` after the end);
  - its open questions;
  - open Someday items with `source.card_id` equal to the card, created after the end.
- **`GET /copilot/opener`** keeps its shape, and its `pick_up` is built from `/desk/last`:
  - `pick_up: { card: DeskCardBrief, exploration: { id: card.id, title, last_touched_at }, open_next, stopped_at, stopped_line, arrived: { answers, open_questions } }`;
  - surfaces read the Desk. `open_questions` items gain `card_id` and `card_title`, `reading_list` and `quiet` items gain `card_id`, and every `exploration_id` / `exploration_title` stays as a legacy alias holding the card id and title;
  - Tether (V) reads this.
- **Open next** (`open_next.py`, `GET/POST/DELETE /copilot/open-next`):
  - the record holds `card_id`;
  - `POST` accepts `card_id`, or `exploration_id` (a legacy alias, mapped through the migration or `pg-<hex>`), or `someday_id`;
  - `GET` returns `{ card_id?, exploration_id? (= card_id), someday_id?, set_at, surface }`;
  - it's stale when a Desk session record whose `cards_touched` includes the card started at or after `set_at`, as today otherwise.
- **Someday:** `normalize_source` accepts `card_id` (a page id) next to `exploration_id`.
- **Goals and the digest:**
  - `goal_status` keeps its `explorations` key this round, but its items are Page cards `{ id: 'pg-…', title }`;
  - digest Q2's `exploration-quiet` becomes `page-quiet` with `ref` = the card id.

### 6.5 Tests (H), in `tests/copilot/`

- The store: create, patch and move cards and Areas; put away and take out; the Goals card is unique (200 on the second create); an empty Desk gets `Main`; layout joins titles.
- Page routes: the conflict 409, the delete guard 409, file-reference validation, asks with `section_text`, hand-off create and PATCH, all against a card.
- Migration:
  - a fixture `.hester/explore/` with an active, an archived, an empty-Untitled, a goals and a legacy single-file exploration, plus sessions and pending answers;
  - it runs twice (the second reports `migrated: 0` and `already: 4`);
  - the explore tree is byte-identical before and after;
  - collisions; Open next rewritten.
- Hand-off sync for `page` refs and for `exploration` refs mapped through the migration.
- `/desk/last`: each `source` in order; `stopped_line` found, not found and absent; `arrived` counts.
- Sessions: POST validation; `write_missing_sessions` from `focus.*` card events (fixture events); `cards_touched` order.
- Opener and Open next: legacy aliases present; `exploration_id` accepted.
- Ideas to Page: new Area vs given Area; the item becomes `explored`; 409 when not open.
- The G0 metrics suite still passes with card-kind focus items (add a fixture).

## 7. D: the Desk surface

### 7.1 Where it lives

- **`DeepHost.tsx` keeps its export and props** (App.tsx renders it as today; `explorationId` becomes unused and C may drop it after merge). It renders the Desk: a new `components/desk/DeskSurface.tsx` plus parts, with `desk.css`.
- **The Page editor is reused as is** for a zoomed Page card. `PageEditor`'s props don't change. `DeepHost` feeds it from `lib/hesterDesk.ts` instead of the exploration routes.
- **`lib/hesterDesk.ts`** (new) is the typed client for every §4 route, using the same `call` pattern and envelope handling as `hesterDeep.ts`.
- **`lib/hesterDeep.ts`'s helpers** (brief builder, state labels, auto-title, session lists, the goals rules) stay and take card ids. The hand-off launch request uses `origin: { kind: 'page', ref: '<pg>#<ans>' }`.

### 7.2 Behaviour

- **Three zoom levels:** the overview (every Area on the Desk), an Area (it fills the view), and a card (full screen, editable). Pan and zoom use CSS transforms, with no canvas library; the maths is pure in `lib/deskModel.ts`.
- **Cards** show their title in Newsreader (your words), a quiet count line (answers, hand-offs, questions), and an ember dot only when a hand-off in the card is `waiting`.
  - **Hover** (300 ms) shows the read-only preview: `summary.excerpt` rendered as markdown.
  - The **zoom** button (or Enter on a focused card, or a double-click) zooms to full screen.
  - Nothing is editable below full screen.
- **The Goals card** is drawn in every Area's top-right corner. Zooming it opens the Goals card's Page with today's Goals Page behaviour (the four margin prompts, Draft goals, Draft from README). With no Goals card yet it reads "What is this project for?"; typing there creates it (`POST /desk/pages { purpose: 'goals', text }`).
- **Starting a Page:** click an empty spot in an Area and type. The Page is in memory until it has text (Deep next R8's deferred create), then `POST /desk/pages { area_id, x, y, text }`. **New Area** on the overview asks for a name.
  - **"Explore" in the action row** (the name isn't changed) makes a Page next to the current card: `POST /desk/pages { from: { card_id, anchor }, text }`.
- **Drawers** are a strip along the bottom of the overview: **Ideas** (n) and **Put away** (n). Opening one shows a one-column sheet:
  - **Ideas:** Someday items, with Start a Page (or drag one onto an Area: `POST /desk/ideas/{id}/page`), Keep and Drop.
  - **Put away:** Areas, with Take out.
  - An Area's `⋯` has Rename and Put away.
- **Landing** (decision 2) is `openDesk(target)`:
  - `{ kind: 'last' }` calls `GET /desk/last` and zooms into `card` with the cursor at the end of `stopped_line`, scrolled into view. If `stopped_line` is null, it uses the card's saved cursor (localStorage), else the end of the Page.
  - With no card, it shows the overview.
  - Entering Deep by `⌘0`, `⇧⌘0`, Go deep or the switcher lands `last` unless this window was already at the Desk: coming back after a hop is instant and exact (14 §3.1).
  - `openDesk` calls `deepStart({ workspace, exploration_id: null, card_id, card_kind: 'page', title })` on landing and on every zoom into a different card. Zooming out doesn't call it. It also calls `PUT /desk/last` (debounced 2 s) on each zoom-in.
- **One key to the overview: `Esc`** from a zoomed card, centred on that card's Area. Esc closes the innermost thing first (a picker, a popover, the source panel, the action row, a multi-selection). Only an Esc with none of those open zooms out. The rule is a pure function in `deskModel.ts`. From an Area, Esc goes to the overview too.
- **The ending ritual** (`EndSessionSheet`):
  - it lists **the cards you touched** this session (titles in Newsreader, one click to zoom back);
  - "Where did you stop?" is pre-filled from the last card;
  - the Asked, Handed off and Still open lists span the touched cards;
  - `POST /desk/sessions` with `cards_touched` and `stopped_card_id`.

  The renderer tracks touched cards per `focus_session_id` (in memory, mirrored to localStorage).
- **Ended from a device:** when the focus state shows the Deep session ended while the Desk is showing, D stays on the Desk with no sheet. The next zoom starts a new session.
- **Local memory:**
  - cursors and Page mirrors are keyed by card id;
  - a one-time pass maps stored `exp-<hex>` keys to `pg-<hex>` (`pageIdForExploration`);
  - `DeepNav` in `cockpitMode.ts` gains `card_id` and `zoom: 'overview' | 'area' | 'card'` and `area_id`, and keeps `exploration_id` as an alias of `card_id` until the merge step.
- **The palette** (`CommandPalette.tsx`) sends `about: { kind: 'page', id }` from a zoomed card.
- **Next buttons:** the overview and the Drawers have no `next` button (the Desk is a place, not a flow). The Page and the ritual keep their existing rules.

### 7.3 Tests (D)

- New `scripts/desk-renderer-smoke.mjs`, for `deskModel.ts`:
  - the zoom maths (fit an Area, fit a card, screen to Desk and back);
  - the landing target (`DeskLast` × saved cursor × null line);
  - the Esc rule;
  - touched-card accumulation and order;
  - the empty-spot hit test and new-card placement;
  - the Goals corner position;
  - the drawer counts;
  - the `exp` → `pg` key migration.
- `hesterDesk.ts`: every route's method, path, workspace header and envelope, with a stub fetch.
- `deep-renderer-smoke.mjs` and `cockpit-explore-smoke.mjs` still pass, updated for card ids and the `page` origin; drop v3-tree cases only if the functions they import are gone.

## 8. C: the Cockpit

- **The rail is Home, Work, Goals and Ops**, with `⌘1`–`⌘4`:
  - `lib/cockpitModel.ts` defines `SectionId` as `CockpitSectionId` and `SECTIONS = ['home', 'work', 'goals', 'ops']`, and `readSection` maps through `COCKPIT_SECTION`;
  - `digitTarget` returns null in Deep, since the Desk has no views.
- **Home** is one column, top to bottom:
  1. the greeting and **one reassuring sentence** (today's `meanwhileSentence`, which says "Everything's handled." when nothing waits);
  2. **the one or two things that need you**, answerable there with Work's waiting card, and "n more in Work" beyond two;
  3. **shipped this week**: History's wins strip (`GET /cockpit/history?days=7`) and the weekly retro when it's due;
  4. **Back to your Desk**, the view's one `next` button: a big door showing your last card's title (Newsreader) and its stopped-at line (Newsreader italic), from `GET /desk/last` (C adds `fetchDeskLast` to `hesterCockpit.ts`).
     - It calls `openDesk(api, workspace, { kind: 'last' })`.
     - With no card, or a 404 from an old daemon, it reads "Go to your Desk".
  - The opener ("What's on your mind?", Or start from) leaves Home.
- **Work** is unchanged, except:
  - it filters out `kind: 'deep_idle'` items, which are devices-only;
  - a hand-off task's "Open its Page" uses `cardIdForOrigin(task.origin)` → `openDesk({ kind: 'card', card_id })`.
- **Goals:**
  - the empty state's "What is this project for?" → `openDesk({ kind: 'goals', first_line })`;
  - the "serving" rows open cards with `openDesk({ kind: 'card' })`;
  - `page-quiet` Q2 candidates open their card.
- **Ops** gains **Usage** (today's `UsagePanel`, moved). `docs/15-Usage.md` §6.3 and §9 decision 4 now say it lives in Ops.
- **Removed:**
  - `LibrarySection`, `ExploreSection`, `SomedaySection`, `FilesSection`, `HistorySection` and `library.css`;
  - the Launcher's Explore choice becomes **New Page**, which does `openDesk({ kind: 'overview' })`;
  - the Library pane's exploration tree (`components/library/ExplorationTree.tsx`, and its "Dive in" chat entry) comes out of `LibraryPane`. The pane stays for whatever else it shows, or goes, along with its `library` shortcut, if nothing is left.
- **Keys:**
  - `shared/shortcuts.ts`: `tab_1`–`tab_9` descriptions say "rail section 1–4 in the Cockpit, nothing in Deep";
  - a documentation-only `desk_overview` entry (`esc`, "Deep: from a zoomed card, back to the Desk overview"), since D implements it;
  - regenerate `docs/shortcuts.md`;
  - update `KeyHelp.tsx`;
  - update `CLAUDE.md`'s key table (`Cmd+1-9`: "tabs in Manual, the rail's sections in the Cockpit (1 Home, 2 Work, 3 Goals, 4 Ops)"; add `Esc` in Deep).
- **Tests (C)** in `cockpit-renderer-smoke.mjs`:
  - the four sections and every legacy id through `COCKPIT_SECTION`;
  - `digitTarget` in each mode;
  - Home's sentence cases;
  - the door's label with a card, without one, and offline;
  - needs-you capped at two with "n more";
  - `deep_idle` filtered;
  - `cardIdForOrigin` for both origin forms;
  - at most one `next` per section through the nextGuard.

  `cockpit-work-smoke.mjs` still passes.

## 9. V: devices and Lee main

### 9.1 Desk sessions in Lee main

- **`deepStart`:**
  - with `card_id` present, the item is `{ kind: 'card', … }`;
  - with only `exploration_id` (older renderers, devices' Go deep), it's a card item with `card_id: null` (or the id, when it's already a page id);
  - "Go deep with null keeps the current card" carries over;
  - `focusItemKey` and `parseFocusItem` learn `card`;
  - `FocusState.deep` and the snapshot's `deep` fill `card_id` and `card_kind`, and keep `exploration_id = card_id` for old device builds.
- **Logging:** `focus.item` only when `card_id` changes to a different non-null id.
- **`tabs-main.ts`:** `validDeepEvent` takes `card_id` (or legacy `exploration_id`) and `desk.zoom`.
- **The launcher** accepts origin kind `page`.
- **`core-routes.ts`:** `deepAnswerEvent` handles §5.3.
- **Preload:** no new IPC; `window.lee.copilot.deepStart` passes the wider request through.

### 9.2 The idle-end push (decision 6)

- **When it's sent:**
  - a Deep session is running, and presence says away;
  - away time reaches `deep.idle_end_minutes − deep.idle_warn_minutes` (new config, default 5, so 40 of 45);
  - it hasn't been sent this session, and it isn't quiet hours.

  Lee main opens one attention item: `kind: 'deep_idle'`, `severity: 'needs-you'`, `source.kind: 'lee'`, `notify: true`, not parked by Deep's `none` policy (it's the one exception), `title: 'Still thinking?'`, `text` = the card's title, `deep_idle: { session_id, ends_at, card }`, and `actions: ['extend', 'end_rate', 'capture', 'dismiss']`. It logs `deep.idle_push`.
- **Actions:**
  - `POST /deep/idle-end` with `DeepIdleEndRequest` (device principal; a 409 on a stale version).
  - **Extend:** the idle deadline becomes now + `idle_end_minutes`, measured from the extension rather than from `away_since`. It logs `deep.extend`, and no second push follows.
  - **End and rate:** ends the session (`focus.end` with `reason: 'deep_end'`, `deep_rating`, `ended_via: 'device'`) and posts the Desk session record to Hester (`reason: 'device'`, the device's `stopped_at` or null, `stopped_card_id` and `cards_touched` from the session's focus items). If Hester is offline, main spools the record, like captures.
  - **Capture** is `/carry/capture` with the item's `card.card_id`; the item stays open.
- **Resolution:** the item resolves when you're back at the machine, on either action, or at the session's end. Ignoring it ends the session unrated at the deadline, as today.
- **In the Cockpit:** the item isn't shown (C filters it). It exists only while Lee is open.

### 9.3 Tether and capture (Lee main)

*Renamed from Carry, 2026-09-28; the routes keep `/carry`.*

`GET /carry` `data`:

```ts
export interface Carry {
  workspace: string;
  pick_up: {
    card_id: string; card_kind: DeskCardKind; title: string; area_name: string | null;
    stopped_at: string | null; stopped_line: number | null; last_touched_at: string | null;
    exploration_id: string;           // legacy alias = card_id, for app and firmware before this round
  } | null;
  open_questions: Array<{ card_id: string; exploration_id: string; question_id: string; text: string }>;
  captured_count: number;
  reading_count: number;
  open_next: { card_id?: string; exploration_id?: string; someday_id?: string; set_at: string } | null;
  /** Captures waiting in Lee's spool for Hester. */
  spooled: number;
}
```

- **Where it comes from:** built from the opener (§6.4). An old daemon's opener (no `card`) still gives a Tether view, using `exploration.id` as the card id.
- **`POST /carry/capture`** takes `{ workspace?, text, card_id?, exploration_id? }`, and sends `source.card_id` to Hester.
  - **Hester offline → spooled** through the existing capture spool (`~/.lee/spool/someday.jsonl`), with the source kept, and `200 { success: true, someday_id: null, spooled: true }`. No more 503; this was the 15 leftover.
- **`POST /carry/open-next`** takes exactly one of `card_id`, `exploration_id` (legacy) or `someday_id`.

### 9.4 Devices

- **Aeronaut:**
  - **Library:** Tether first; your last Desk card's title, area and "You stopped at" (Newsreader italic); open questions; `Btn next` "Capture a thought into this"; "Open this first on the Mac". The Explorations tab goes (a Desk view on the phone is still open, 16 §7). Ideas stays.
  - **The idle-end push:** a notification and a card with Extend, End and rate (deep / mixed / shallow) and Capture.
  - **The one-agent screen** gains **Check in**, **Rename**, **Accept** (a task in review) and **Assign** (an agent with no task: to an open task or a new one), through existing Lee main routes (the `/command` `tab` domain, Hester task routes proxied by main). A new main route is added only where none exists, and listed in `docs/Dirigible.md`'s wire protocol section.
  - **Swipe to snooze** leaves a collapsed "Snoozed · Undo" row for 5 s.
- **Dirigible:**
  - **Work pager:** the fourth quick reply **Show me the diff** on `F` (`d` is already Dismiss in `screen_waiting.cpp`).
  - **In flight:** agents idle for more than 2 h fold into an "Earlier (n)" row, the same rule as `workModel` on the Mac.
  - **Library (Tether):** the last Desk card, as on the phone; `C` Add a thought (into the card); `O` Open next.
  - **The idle-end push:** a Tether-style page, with `e` extend, `d` / `m` / `s` rate (then an optional stopped-at line), and `c` capture. It's its own page, so `d` there doesn't clash with the pager's Dismiss.
- **`docs/Dirigible.md`:**
  - the keys and screens above and the new endpoints;
  - rename the "Desk mode" idea there, since Desk is now taken.

### 9.5 Tests (V)

- `copilot-queue-smoke.js`:
  - card focus items (`focus.item` only on a real change);
  - `deepStart` with a legacy `exploration_id`;
  - the idle push: at 40 of 45, once per session, not in quiet hours, not when at the machine, and resolved on return;
  - Extend moves the deadline, with no second push;
  - End and rate posts a record to a fake Hester, or spools it offline;
  - `deepAnswerEvent` with `card_id`;
  - the `deep.*` validator with both id fields and `desk.zoom`;
  - `buildCarry` with and without `card`;
  - capture spooling (200 `spooled: true`);
  - open-next with `card_id`.
- **Aeronaut:** `export PATH=~/Development/flutter/bin:$PATH`, then `flutter analyze` and `flutter test` in `aeronaut/` (add model tests for `Carry` and the `deep_idle` item).
- **Dirigible:** `source ~/Development/hardware/esp-idf/export.sh`, then `idf.py build` in `dirigible/firmware`. Build only; never flash.

## 10. Against an old daemon

The Desk **needs the new Hester**. The packaged app's `~/.lee/venv` is updated by a reinstall, which the user does after merging; no agent reinstalls Hester. Until then:

- **D:** `GET /desk` returning 404 shows the Desk's one quiet line: "Hester is older than this Lee. Reinstall it to use the Desk." Deep has nothing else, and the Cockpit and Manual are unaffected. No fallback to exploration routes.
- **C:** the door reads "Go to your Desk", with no card, when `/desk/last` 404s. Everything else in the Cockpit uses routes an old daemon has.
- **V:** Tether reads the old opener (`exploration.id` as the card id). Captures and Open next with `exploration_id` still work. `card_id` is sent only when the daemon's opener included `card`.
- **H:** keeps every existing `/cockpit/explorations/*` route working. Nothing new calls them.

## 11. Checks and merging

Each agent checks every exit code, and never hides a failure behind a pipe:

- **Renderer and main packages (D, C, V):** from `electron/`, `npm run build:main`, then `npm run typecheck`, then every `node scripts/*smoke*` it owns plus the rest as a check, then `npm run build`.
- **H, and everyone as a check:** from the repo root, `PYTHONPATH=$(pwd) ~/.lee/venv/bin/python -m pytest tests/copilot -q`.
- **V:** also §9.5's Flutter and IDF builds.
- **Never:** `npm run dist:mac`, reinstalling Hester, flashing or installing onto devices, pushing, touching the untracked files, or editing `GOALS.md`.

Each commits as it goes on its own branch.

**Merging:**

1. The integrator merges **H, V, D, C** in that order onto `copilot-spec` and runs everything.
2. In the merge step it removes what the contract left for it:
   - `SectionId` and `LEGACY_SECTION` in shared, if unused;
   - `DeepNav.exploration_id`, if unused;
   - `DeepHost`'s `explorationId` prop;
   - dead exploration exports in `hesterCockpit.ts`.
3. It fixes only integration breakage.
4. An in-app pass with the user follows: agents can't judge the look.

## 12. Decisions this contract makes (revisable)

| # | Topic | Decision | Why |
|---|---|---|---|
| 1 | Ids | `pg-<hex>` and `area-<hex>` reuse the exploration's hex in migration | Old refs (hand-off origins, Open next, device state, local cursors) map with no lookup |
| 2 | Overview key | `Esc` from a zoomed card, innermost thing first | Every free ⌘ chord collides with CodeMirror or macOS text keys; Esc reads as "leave full screen" |
| 3 | Goals card | One Page card, `pinned`, no Area, drawn in every Area's corner | "Pinned in every Area" without copies |
| 4 | Deep time | `deep.input` only inside a card | Panning the Desk isn't deep work; G0 formulas stay unchanged |
| 5 | Idle-end push | An attention item of a new kind, answered by `POST /deep/idle-end` | Reuses the device delivery path; the actions aren't replies |
| 6 | Device Desk view | None this round; the phone's Explorations tab goes | Migration copies, so the old list would go stale; a Desk view on devices is still open |
| 7 | Old explorations routes | Kept, unused by new code | Decision 4 (2026-09-27): the old code may stay |
