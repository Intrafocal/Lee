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
export const DRAWER_ID_RE = /^(stashed|ideas|drw-[0-9a-f]{8})$/;
export const STROKE_ID_RE = /^stk-[0-9a-f]{8}$/;
/** Hester's caps: points per stroke, strokes per Desk. */
export const MAX_STROKE_POINTS = 2000;
export const MAX_STROKES = 2000;
/** The two built-in Drawers. 'ideas' is the Ideas store; 'stashed' holds Areas. */
export const IDEAS_DRAWER = 'ideas';
export const STASHED_DRAWER = 'stashed';

/** Desk coordinates, in CSS px at zoom 1. Areas sit on the Desk; a card's x/y are relative to its Area's top-left. */
export interface DeskRect { x: number; y: number; w: number; h: number }

export interface DeskArea extends DeskRect {
  id: string;
  name: string;
  /** null: on the Desk. Else the Drawer it's stashed in (x/y are kept for unstashing it). */
  drawer_id: string | null;
  /** When it was stashed, else null. Older Hesters omit it. */
  stashed_at?: string | null;
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
  /** kind 'areas': its Areas, most recently stashed first. Always [] for 'ideas'. */
  area_ids: string[];
  /** Areas in it, or open Ideas for 'ideas'. */
  count: number;
}

/**
 * A freehand line you drew. It means nothing: Hester stores it and never
 * reads, places or connects it. Points are relative to its Area's top-left,
 * or to the Desk when area_id is null; it moves, is stashed and is deleted
 * with its Area.
 */
export interface DeskStroke {
  id: string;
  area_id: string | null;
  points: Array<[number, number]>;
  /** Screen px, the same at every zoom. */
  width: number;
  created_at: string;
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
  /** Always both built-ins first: [ideas, stashed], then any others. */
  drawers: DeskDrawer[];
  /** Every stroke, stashed Areas' too. Absent from a Hester older than the Desk's tools. */
  strokes?: DeskStroke[];
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

/** GET /desk/last: where "Back to your Desk", landing, Carry and the opener's pick-up start. */
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
export interface DeskStrokeCreate { area_id: string | null; points: Array<[number, number]>; width?: number }
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
