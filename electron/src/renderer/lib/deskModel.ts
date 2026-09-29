/**
 * Pure model for the Desk surface (docs/16-Desk.md; D2 contract §7). No
 * React, no DOM, no window: scripts/desk-renderer-smoke.mjs runs it bundled
 * with esbuild.
 *
 * - Camera maths: fit a rect, screen ↔ Desk, zoom about a point, pan (§7.2:
 *   CSS transforms, no canvas library). They live in lib/canvas/ (shared
 *   with a Board) and are re-exported here under the Desk's names.
 * - Layout: a card's rect on the Desk, the Goals corner in every Area, the
 *   empty-spot hit test and a new card's placement.
 * - Landing (decision 2): DeskLast to a card and line, and the cursor there.
 * - The Esc rule: the innermost open thing first, then zoom out.
 * - Sessions: touched cards per focus session, in first-touched order.
 * - Drawers: the strip's counts. Cards: the quiet count line, waiting cards.
 * - Tools (Cursor, Move, Draw): the keys, Esc back to Cursor, the pointer's
 *   shape, where a dragged card or Area lands, edits shown before Hester
 *   answers, and strokes (simplified, relative to their Area, smoothed).
 * - Local memory: the one-time exp-<hex> → pg-<hex> key migration.
 */

import { cardIdForOrigin, cardKindOf, pageIdForExploration, IDEAS_DRAWER, MAX_STROKE_POINTS, STASHED_DRAWER } from '../../shared/desk';
import type { Desk, DeskArea, DeskCard, DeskCardSummary, DeskLast, DeskRect, DeskStroke, DeskStrokeCreate } from '../../shared/desk';
import type { IconName } from '../icons/iconData.generated';
import type { TaskOrigin, TaskStatus } from '../../shared/cockpit';
import { boundsOf, clamp, inside, overlaps, round, type Point, type Size } from './canvas/camera';
import { STROKE_WIDTH, isLine, simplifyStroke } from './canvas/stroke';

// ---------------------------------------------------------------------------
// Camera (lib/canvas/camera.ts, shared with a Board; Desk names kept here)
// ---------------------------------------------------------------------------

export {
  IDENTITY,
  MAX_SCALE,
  MIN_SCALE,
  boundsOf,
  cameraTransform,
  clampScale,
  fitRect,
  panBy,
  screenToWorld as screenToDesk,
  wheelCamera,
  worldToScreen as deskToScreen,
  zoomAt,
} from './canvas/camera';
export type { Camera, Point, Size } from './canvas/camera';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const CARD_W = 360;
export const CARD_H = 240;
/** An Area's name strip, in Desk px; nothing starts under it. */
export const AREA_HEAD = 56;
export const GOALS_W = 240;
export const GOALS_H = 132;
export const GOALS_INSET = 24;
const GAP = 24;

/** Areas on the Desk (not stashed). */
export function areasOnDesk(desk: Pick<Desk, 'areas'>): DeskArea[] {
  return desk.areas.filter((a) => !a.drawer_id);
}

/** An Area's own cards (never the pinned Goals card). */
export function cardsIn(desk: Pick<Desk, 'cards'>, areaId: string): DeskCard[] {
  return desk.cards.filter((c) => c.area_id === areaId && !c.pinned);
}

/** The Goals card's spot in an Area's top-right corner, relative to the Area. */
export function goalsCorner(area: Pick<DeskRect, 'w'>): DeskRect {
  return { x: Math.max(GOALS_INSET, area.w - GOALS_W - GOALS_INSET), y: GOALS_INSET, w: GOALS_W, h: GOALS_H };
}

/** A card's rect on the Desk. The Goals card is drawn in `inArea`'s corner. */
export function cardRectOnDesk(card: Pick<DeskCard, 'x' | 'y' | 'w' | 'h' | 'pinned'>, area: DeskRect | null | undefined): DeskRect | null {
  if (!area) return null;
  if (card.pinned) {
    const g = goalsCorner(area);
    return { x: area.x + g.x, y: area.y + g.y, w: g.w, h: g.h };
  }
  return { x: area.x + card.x, y: area.y + card.y, w: card.w || CARD_W, h: card.h || CARD_H };
}

/** The Area under a Desk point (the last drawn wins, as on screen). */
export function areaAt(areas: readonly DeskArea[], p: Point): DeskArea | null {
  for (let i = areas.length - 1; i >= 0; i--) if (inside(p, areas[i])) return areas[i];
  return null;
}

/**
 * An empty spot: inside the Area, below its name strip, and on no card and
 * not on the Goals corner. `rel` is relative to the Area.
 */
export function isEmptySpot(area: DeskRect, cards: ReadonlyArray<Pick<DeskCard, 'x' | 'y' | 'w' | 'h'>>, rel: Point): boolean {
  if (rel.x < 0 || rel.y < AREA_HEAD || rel.x > area.w || rel.y > area.h) return false;
  if (inside(rel, goalsCorner(area))) return false;
  return !cards.some((c) => inside(rel, { x: c.x, y: c.y, w: c.w || CARD_W, h: c.h || CARD_H }));
}

/**
 * Where a new card goes for a click at `rel` (relative to the Area): its
 * top-left at the click, kept inside the Area, then nudged down (then right)
 * until it overlaps no card and not the Goals corner.
 */
export function placeNewCard(area: DeskRect, cards: ReadonlyArray<Pick<DeskCard, 'x' | 'y' | 'w' | 'h'>>, rel: Point, size: Size = { w: CARD_W, h: CARD_H }): DeskRect {
  const clampX = (x: number) => Math.round(Math.max(GAP, Math.min(x, area.w - size.w - GAP)));
  const clampY = (y: number) => Math.round(Math.max(AREA_HEAD, Math.min(y, area.h - size.h - GAP)));
  const taken = [...cards.map((c) => ({ x: c.x, y: c.y, w: c.w || CARD_W, h: c.h || CARD_H })), goalsCorner(area)];
  const free = (r: DeskRect) => !taken.some((t) => overlaps(r, t, GAP / 2));
  const start = { x: clampX(rel.x), y: clampY(rel.y), ...size };
  if (free(start)) return start;
  const step = size.h / 2 + GAP;
  for (let col = 0; col < 6; col++) {
    for (let row = 0; row < 12; row++) {
      const r = { x: clampX(start.x + col * (size.w + GAP)), y: start.y + row * step, ...size };
      if (r.y + r.h > area.h - GAP && row > 0) break;
      if (free(r)) return r;
    }
  }
  // A full Area: below everything (the Area grows when Hester next lays it out).
  const bottom = Math.max(AREA_HEAD, ...taken.map((t) => t.y + t.h + GAP));
  return { x: start.x, y: bottom, ...size };
}

/** Next to `from` (right, else below): "New Page from this" when Hester doesn't place it. */
export function placeBeside(area: DeskRect, cards: ReadonlyArray<Pick<DeskCard, 'x' | 'y' | 'w' | 'h'>>, from: Pick<DeskCard, 'x' | 'y' | 'w' | 'h'>): DeskRect {
  return placeNewCard(area, cards, { x: from.x + (from.w || CARD_W) + GAP, y: from.y });
}

// ---------------------------------------------------------------------------
// Zoom levels and what the camera shows
// ---------------------------------------------------------------------------

export type DeskZoom = 'overview' | 'area' | 'card';

/** The Desk rect a zoom level shows; null when there's nothing to show (an empty Desk). */
export function focusRect(desk: Pick<Desk, 'areas' | 'cards'>, zoom: DeskZoom, areaId: string | null, cardId: string | null): DeskRect | null {
  const onDesk = areasOnDesk(desk);
  const area = onDesk.find((a) => a.id === areaId) ?? null;
  if (zoom === 'card' && cardId) {
    const card = desk.cards.find((c) => c.id === cardId);
    const home = card && !card.pinned ? onDesk.find((a) => a.id === card.area_id) ?? null : area ?? onDesk[0] ?? null;
    const r = card ? cardRectOnDesk(card, home) : null;
    if (r) return r;
  }
  if ((zoom === 'area' || zoom === 'card') && area) return area;
  return boundsOf(onDesk);
}

/** The Area to centre on when zooming out of a card: its own, else the one you were in. */
export function areaForCard(desk: Pick<Desk, 'cards'>, cardId: string | null, current: string | null): string | null {
  const card = cardId ? desk.cards.find((c) => c.id === cardId) : null;
  return card && !card.pinned && card.area_id ? card.area_id : current;
}

// ---------------------------------------------------------------------------
// Landing (decision 2, §7.2)
// ---------------------------------------------------------------------------

export type Landing = { kind: 'card'; card_id: string; area_id: string | null; title: string; line: number | null } | { kind: 'overview' };

/** GET /desk/last → where to land: the card and its stopped-at line, else the overview. */
export function landingFor(last: DeskLast | null | undefined): Landing {
  const c = last?.card;
  if (!c) return { kind: 'overview' };
  return { kind: 'card', card_id: c.id, area_id: c.area_id, title: c.title, line: typeof last?.stopped_line === 'number' && last.stopped_line > 0 ? last.stopped_line : null };
}

/** The offset of the end of 1-based `line` (clamped to the text's lines). */
export function lineEnd(text: string, line: number): number {
  const lines = text.split('\n');
  const n = Math.max(1, Math.min(Math.floor(line), lines.length));
  let off = 0;
  for (let i = 0; i < n - 1; i++) off += lines[i].length + 1;
  return off + lines[n - 1].length;
}

export interface LandCursor {
  anchor: number;
  head: number;
  scroll: number;
}

/**
 * Where the cursor goes on landing: the end of the stopped-at line
 * (`reveal`: scroll it into view), else the card's saved cursor, else the
 * end of the Page.
 */
export function landingCursor(text: string, line: number | null | undefined, saved: LandCursor | null | undefined): { cursor: LandCursor; reveal: boolean } {
  if (typeof line === 'number' && line > 0) {
    const at = lineEnd(text, line);
    return { cursor: { anchor: at, head: at, scroll: 0 }, reveal: true };
  }
  if (saved) {
    const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
    return { cursor: { anchor: clamp(saved.anchor), head: clamp(saved.head), scroll: saved.scroll }, reveal: false };
  }
  return { cursor: { anchor: text.length, head: text.length, scroll: 0 }, reveal: true };
}

// ---------------------------------------------------------------------------
// Esc (decision 2): the innermost open thing first, then zoom out
// ---------------------------------------------------------------------------

/** Things Esc closes before it zooms out, innermost first. */
export const ESC_LAYERS = ['sheet', 'input', 'picker', 'popover', 'source', 'reading', 'row', 'selection', 'preview', 'drawer'] as const;
export type EscLayer = (typeof ESC_LAYERS)[number];

export type EscStep = { kind: 'none' } | { kind: 'close'; layer: EscLayer } | { kind: 'zoom'; to: 'overview' };

/**
 * `handled`: something inside already took this Esc (CodeMirror closed its
 * picker or collapsed a selection, a field cancelled). Only an Esc with
 * nothing open zooms out; from a card or an Area it goes to the overview.
 */
export function escapeStep(open: ReadonlySet<EscLayer> | readonly EscLayer[], zoom: DeskZoom, handled = false): EscStep {
  if (handled) return { kind: 'none' };
  const has = (l: EscLayer) => (open instanceof Set ? open.has(l) : (open as readonly EscLayer[]).includes(l));
  for (const l of ESC_LAYERS) if (has(l)) return { kind: 'close', layer: l };
  if (zoom === 'card' || zoom === 'area') return { kind: 'zoom', to: 'overview' };
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Tools: Cursor, Move, Draw, Rectangle
// ---------------------------------------------------------------------------

export type DeskTool = 'cursor' | 'move' | 'draw' | 'area';

export const DESK_TOOLS: ReadonlyArray<{ tool: DeskTool; key: string; label: string; icon: IconName }> = [
  { tool: 'cursor', key: 'V', label: 'Cursor', icon: 'pointer' },
  { tool: 'move', key: 'M', label: 'Move', icon: 'move' },
  { tool: 'draw', key: 'D', label: 'Draw', icon: 'draw' },
  { tool: 'area', key: 'R', label: 'Rectangle: a new Area, or size one', icon: 'area' },
];

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** V, M, D or R picks a tool; never with ⌘, ctrl or ⌥, and never while you type into something. */
export function toolForKey(e: KeyLike, typing: boolean): DeskTool | null {
  if (typing || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null;
  const k = e.key.toLowerCase();
  return DESK_TOOLS.find((t) => t.key.toLowerCase() === k)?.tool ?? null;
}

export type DeskEscStep = EscStep | { kind: 'tool'; to: 'cursor' };

/** The Desk's Esc: the innermost open thing, then Move or Draw back to Cursor, then zoom out. */
export function deskEscapeStep(open: ReadonlySet<EscLayer> | readonly EscLayer[], zoom: DeskZoom, tool: DeskTool): DeskEscStep {
  const step = escapeStep(open, zoom);
  if (step.kind === 'close') return step;
  return tool !== 'cursor' ? { kind: 'tool', to: 'cursor' } : step;
}

/** The pointer's shape: grab (grabbing while dragging) in Move, a crosshair in Draw and Rectangle. */
export function toolCursor(tool: DeskTool, dragging: boolean): 'default' | 'grab' | 'grabbing' | 'crosshair' {
  if (tool === 'move') return dragging ? 'grabbing' : 'grab';
  return tool === 'draw' || tool === 'area' ? 'crosshair' : 'default';
}

/** The smallest Area the Rectangle tool makes (Desk units): a drag smaller than this grows to it. */
export const MIN_DRAWN_AREA = { w: 320, h: 220 } as const;

/** Rectangle: the Area a drag from `a` to `b` (Desk points) outlines, whichever way it went, at least MIN_DRAWN_AREA. */
export function rectFromDrag(a: Point, b: Point): DeskRect {
  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  return {
    x,
    y,
    w: Math.max(MIN_DRAWN_AREA.w, Math.round(Math.abs(b.x - a.x))),
    h: Math.max(MIN_DRAWN_AREA.h, Math.round(Math.abs(b.y - a.y))),
  };
}

export { DRAG_SLOP, dragDelta, movedEnough } from './canvas/camera';

/**
 * Where a dragged card lands: in the Area under the pointer (`pointer`, a
 * Desk point), else back in its own, its top-left moved by `delta` and kept
 * inside that Area below the name strip.
 */
export function dropCard(
  card: Pick<DeskCard, 'x' | 'y' | 'w' | 'h'>,
  from: DeskArea,
  delta: Point,
  areas: readonly DeskArea[],
  pointer: Point,
): { area_id: string; x: number; y: number } {
  const to = areaAt(areas, pointer) ?? from;
  const w = card.w || CARD_W;
  const h = card.h || CARD_H;
  const x = from.x + card.x + delta.x - to.x;
  const y = from.y + card.y + delta.y - to.y;
  return { area_id: to.id, x: Math.round(clamp(x, 0, to.w - w)), y: Math.round(clamp(y, AREA_HEAD, to.h - h)) };
}

/** A dragged Area's new top-left; its cards and lines are relative to it, so they come along. */
export function dropArea(area: Pick<DeskRect, 'x' | 'y'>, delta: Point): { x: number; y: number } {
  return { x: Math.round(area.x + delta.x), y: Math.round(area.y + delta.y) };
}

/**
 * Rectangle on an existing Area: its right edge, bottom edge or corner drags
 * to size it. The top-left stays put, so its cards and lines (kept relative
 * to that corner) stay where they are. Never smaller than a drawn Area, nor
 * than what's in it (`content`: the right and bottom of its cards, Area px).
 */
export type AreaHandle = 'e' | 's' | 'se';
export const AREA_HANDLES: readonly AreaHandle[] = ['e', 's', 'se'];

export function resizeArea(
  area: Pick<DeskRect, 'w' | 'h'>,
  handle: AreaHandle,
  delta: Point,
  content: { right: number; bottom: number } = { right: 0, bottom: 0 },
): { w: number; h: number } {
  const minW = Math.max(MIN_DRAWN_AREA.w, Math.ceil(content.right));
  const minH = Math.max(MIN_DRAWN_AREA.h, Math.ceil(content.bottom));
  return {
    w: handle === 's' ? area.w : Math.max(minW, Math.round(area.w + delta.x)),
    h: handle === 'e' ? area.h : Math.max(minH, Math.round(area.h + delta.y)),
  };
}

/** The right and bottom of an Area's cards, in Area px, with a margin; what resizing can't cut off. */
export function areaContent(cards: ReadonlyArray<Pick<DeskRect, 'x' | 'y' | 'w' | 'h'>>, margin = 16): { right: number; bottom: number } {
  let right = 0;
  let bottom = 0;
  for (const c of cards) {
    right = Math.max(right, c.x + c.w + margin);
    bottom = Math.max(bottom, c.y + c.h + margin);
  }
  return { right, bottom };
}

/** The taskbar's New menu: what you can start on the Desk. The rest come later (§3). */
export type NewKind = 'page' | 'board';
export const NEW_KINDS: ReadonlyArray<{ kind: NewKind; label: string; ready: boolean }> = [
  { kind: 'page', label: 'Page', ready: true },
  { kind: 'board', label: 'Board', ready: true },
];

/** Where New puts a card: the Area you're in, else the one under the middle of the view, else the first. */
export function newCardArea(areas: readonly DeskArea[], current: string | null, viewCentre: Point | null): DeskArea | null {
  return (
    (current ? areas.find((a) => a.id === current) : undefined) ??
    (viewCentre ? areaAt(areas, viewCentre) : null) ??
    areas[0] ??
    null
  );
}

/** What you changed here and Hester hasn't answered yet: shown at once, dropped once GET /desk has it. */
export interface DeskEdits {
  cards: Readonly<Record<string, { area_id: string; x: number; y: number }>>;
  areas: Readonly<Record<string, { x: number; y: number; w?: number; h?: number }>>;
  /** Strokes drawn and not yet in the Desk (temporary ids). */
  added: readonly DeskStroke[];
  /** Strokes deleted and maybe still in the Desk. */
  removed: readonly string[];
}

export const NO_EDITS: DeskEdits = { cards: {}, areas: {}, added: [], removed: [] };

/** The Desk with your edits on top; the same object when there are none. */
export function withEdits<D extends Pick<Desk, 'areas' | 'cards' | 'strokes'>>(desk: D, e: DeskEdits): D {
  const none = !Object.keys(e.cards).length && !Object.keys(e.areas).length && !e.added.length && !e.removed.length;
  if (none) return desk;
  const removed = new Set(e.removed);
  return {
    ...desk,
    areas: desk.areas.map((a) => (e.areas[a.id] ? { ...a, ...e.areas[a.id] } : a)),
    cards: desk.cards.map((c) => (e.cards[c.id] ? { ...c, ...e.cards[c.id] } : c)),
    strokes: [...(desk.strokes ?? []), ...e.added].filter((s) => !removed.has(s.id)),
  };
}

function omitKey<T>(r: Readonly<Record<string, T>>, k: string | undefined): Readonly<Record<string, T>> {
  if (!k || !(k in r)) return r;
  const rest = { ...r };
  delete rest[k];
  return rest;
}

/** One edit less (the one Hester now has, or that failed). */
export function dropEdit(e: DeskEdits, what: { card?: string; area?: string; added?: string; removed?: string }): DeskEdits {
  return {
    cards: omitKey(e.cards, what.card),
    areas: omitKey(e.areas, what.area),
    added: what.added ? e.added.filter((s) => s.id !== what.added) : e.added,
    removed: what.removed ? e.removed.filter((id) => id !== what.removed) : e.removed,
  };
}

// ---- strokes ----

export { STROKE_STEP_PX, STROKE_TOLERANCE_PX, STROKE_WIDTH, segmentDistance, simplifyPoints, strokePath } from './canvas/stroke';

/**
 * A drawn line (Desk points, at camera `scale`) as a stroke to save:
 * simplified to within a screen pixel (looser until it fits Hester's cap),
 * in the Area where it starts (relative to it), else on the Desk. Null for
 * a click, which isn't a line.
 */
export function strokeFromDrag(points: readonly Point[], scale: number, areas: readonly DeskArea[]): DeskStrokeCreate | null {
  if (!isLine(points)) return null;
  const pts = simplifyStroke(points, scale, MAX_STROKE_POINTS);
  const area = areaAt(areas, points[0]);
  const ox = area?.x ?? 0;
  const oy = area?.y ?? 0;
  return { area_id: area?.id ?? null, points: pts.map((p): [number, number] => [round(p.x - ox), round(p.y - oy)]), width: STROKE_WIDTH };
}

/** A stroke's points on the Desk; null when its Area isn't on the Desk (stashed, or gone). */
export function strokeOnDesk(stroke: Pick<DeskStroke, 'area_id' | 'points'>, areas: ReadonlyArray<Pick<DeskArea, 'id' | 'x' | 'y'>>): Point[] | null {
  let ox = 0;
  let oy = 0;
  if (stroke.area_id) {
    const a = areas.find((x) => x.id === stroke.area_id);
    if (!a) return null;
    ox = a.x;
    oy = a.y;
  }
  return stroke.points.map(([x, y]) => ({ x: x + ox, y: y + oy }));
}

// ---------------------------------------------------------------------------
// Touched cards (the ending ritual, §7.2)
// ---------------------------------------------------------------------------

export interface Touched {
  session_id: string | null;
  cards: string[];
}

export const NO_TOUCHED: Touched = { session_id: null, cards: [] };

/** Add a card zoomed into; a different focus session starts a fresh list. Same object when nothing changed. */
export function touchCard(t: Touched, sessionId: string | null, cardId: string | null): Touched {
  const fresh = t.session_id !== sessionId;
  const cards = fresh ? [] : t.cards;
  if (!cardId || !isDeskCardId(cardId)) return fresh ? { session_id: sessionId, cards } : t;
  if (!fresh && cards.includes(cardId)) return t;
  return { session_id: sessionId, cards: [...cards, cardId] };
}

/** An in-memory Page became a card: its draft id is replaced where it stood. */
export function renameTouched(t: Touched, from: string, to: string): Touched {
  if (!t.cards.includes(from)) return t;
  const cards = t.cards.map((c) => (c === from ? to : c)).filter((c, i, all) => all.indexOf(c) === i);
  return { ...t, cards };
}

/** A stored Touched, defensively. */
export function parseTouched(raw: unknown): Touched {
  if (!raw || typeof raw !== 'object') return NO_TOUCHED;
  const v = raw as { session_id?: unknown; cards?: unknown };
  const cards = Array.isArray(v.cards) ? v.cards.filter((c): c is string => typeof c === 'string' && isDeskCardId(c)) : [];
  return { session_id: typeof v.session_id === 'string' ? v.session_id : null, cards: cards.filter((c, i) => cards.indexOf(c) === i) };
}

// ---------------------------------------------------------------------------
// Drawers and cards
// ---------------------------------------------------------------------------

/** The strip's counts: open ideas (the Ideas Drawer's count), and stashed Areas. */
export function drawerCounts(desk: Pick<Desk, 'drawers' | 'areas'>): { ideas: number; stashed: number } {
  const ideas = desk.drawers.find((d) => d.id === IDEAS_DRAWER)?.count ?? 0;
  const pa = desk.drawers.find((d) => d.id === STASHED_DRAWER);
  const stashed = pa ? Math.max(pa.count, pa.area_ids.length) : desk.areas.filter((a) => a.drawer_id === STASHED_DRAWER).length;
  return { ideas, stashed };
}

/** Stashed Areas, most recently stashed first (the Drawer's order, then any it doesn't list). */
export function stashedAreas(desk: Pick<Desk, 'drawers' | 'areas'>): DeskArea[] {
  const order = desk.drawers.find((d) => d.id === STASHED_DRAWER)?.area_ids ?? [];
  const away = desk.areas.filter((a) => !!a.drawer_id);
  const rank = (a: DeskArea) => {
    const i = order.indexOf(a.id);
    return i < 0 ? order.length : i;
  };
  return [...away].sort((a, b) => rank(a) - rank(b) || (b.updated_at < a.updated_at ? -1 : b.updated_at > a.updated_at ? 1 : 0));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A card's quiet count line: "2 answers · 1 hand-off · 3 questions" (empty parts left out). */
export function cardCountLine(s: Pick<DeskCardSummary, 'answers_unread' | 'answers_pending' | 'handoffs_in_flight' | 'open_questions'> | null | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.answers_pending > 0) parts.push(`${plural(s.answers_pending, 'ask')} running`);
  if (s.answers_unread > 0) parts.push(`${plural(s.answers_unread, 'answer')} new`);
  if (s.handoffs_in_flight > 0) parts.push(plural(s.handoffs_in_flight, 'hand-off'));
  if (s.open_questions > 0) parts.push(plural(s.open_questions, 'question'));
  return parts.join(' · ');
}

/** Cards with a hand-off waiting on you (their ember dot): open tasks in 'waiting' whose origin is a card. */
export function waitingCardIds(tasks: ReadonlyArray<{ status: TaskStatus; origin: TaskOrigin | null }>): Set<string> {
  const out = new Set<string>();
  for (const t of tasks) {
    if (t.status !== 'waiting') continue;
    const id = cardIdForOrigin(t.origin);
    if (id) out.add(id);
  }
  return out;
}

export function isPageId(id: string | null | undefined): id is string {
  return !!id && /^pg-[0-9a-f]{8}$/.test(id);
}

/** A Board card's id (docs/16-Desk.md §3.1): `bd-` and 8 hex. */
export function isBoardId(id: string | null | undefined): id is string {
  return !!id && /^bd-[0-9a-f]{8}$/.test(id);
}

/** A card a Deep session can be on (B5): a Page or a Board. */
export function isDeskCardId(id: string | null | undefined): id is string {
  return !!cardKindOf(id);
}

// ---------------------------------------------------------------------------
// Local memory: exp-<hex> → pg-<hex> (§7.2)
// ---------------------------------------------------------------------------

/** An id as a card id: pg ids as they are, exp ids mapped by their hex; anything else unchanged. */
export function asCardId(id: string): string {
  return pageIdForExploration(id) ?? id;
}

/**
 * The Deep memory record (`lee:deep:<workspace>`) with exploration ids moved
 * to card ids: `exploration_id` → `card_id` (and the alias), cursor keys
 * mapped. `changed` false when there was nothing to move.
 */
export function migrateDeepMemory(raw: unknown): { changed: boolean; next: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { changed: false, next: {} };
  const v = { ...(raw as Record<string, unknown>) };
  let changed = false;
  const eid = typeof v.exploration_id === 'string' ? v.exploration_id : null;
  const mapped = eid ? pageIdForExploration(eid) : null;
  if (mapped) {
    v.exploration_id = mapped;
    changed = true;
  }
  if (typeof v.card_id !== 'string' && (mapped || (eid && isPageId(eid)))) {
    v.card_id = mapped ?? eid;
    changed = true;
  }
  if (v.cursors && typeof v.cursors === 'object' && !Array.isArray(v.cursors)) {
    const cursors: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(v.cursors as Record<string, unknown>)) {
      const to = pageIdForExploration(k);
      if (to) {
        changed = true;
        if (!(to in cursors)) cursors[to] = c;
      } else cursors[k] = c;
    }
    v.cursors = cursors;
  }
  return { changed, next: v };
}

/** Page mirror keys to copy (`lee:deep:page:<ws>:exp-…` → `…:pg-…`); a target that exists is left alone. */
export function mirrorKeyMoves(keys: readonly string[], workspace: string): Array<{ from: string; to: string }> {
  const prefix = `lee:deep:page:${workspace}:`;
  const have = new Set(keys);
  const out: Array<{ from: string; to: string }> = [];
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue;
    const to = pageIdForExploration(k.slice(prefix.length));
    if (to && !have.has(prefix + to)) out.push({ from: k, to: prefix + to });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Drawer: a start menu of folders, date groups and search
// ---------------------------------------------------------------------------

export type DateBucket = 'today' | 'week' | 'older';

export const DATE_BUCKETS: ReadonlyArray<{ bucket: DateBucket; label: string }> = [
  { bucket: 'today', label: 'Today' },
  { bucket: 'week', label: 'This week' },
  { bucket: 'older', label: 'Older' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** By the local calendar: today, the six days before, or anything earlier (and anything undated). */
export function dateBucket(iso: string | null | undefined, now: Date): DateBucket {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'older';
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= midnight) return 'today';
  return t >= midnight - 6 * DAY_MS ? 'week' : 'older';
}

export interface DrawerEntry {
  kind: 'area' | 'idea';
  id: string;
  text: string;
  /** When it went in the Drawer: stashed, or captured. */
  at: string | null;
  /** '3 cards' for an Area; where an idea came from. */
  meta: string;
}

export interface DrawerFolder {
  id: string;
  name: string;
  entries: DrawerEntry[];
}

/** What people call the stashed Areas' Drawer. */
export const STASHED = 'Stashed';

const newestFirst = (a: DrawerEntry, b: DrawerEntry) => String(b.at ?? '').localeCompare(String(a.at ?? ''));

/**
 * The Drawer's folders: Ideas, Stashed, then your own Drawers by name. Each
 * holds its entries newest first; an empty folder of your own is still shown.
 */
export function drawerFolders(
  desk: Pick<Desk, 'drawers' | 'areas' | 'cards'>,
  ideas: ReadonlyArray<{ id: string; text: string; created_at: string; source?: { surface?: string } }>,
): DrawerFolder[] {
  const areaEntry = (a: DeskArea): DrawerEntry => {
    const n = desk.cards.filter((c) => c.area_id === a.id).length;
    return { kind: 'area', id: a.id, text: a.name, at: a.stashed_at ?? a.updated_at ?? null, meta: `${n} ${n === 1 ? 'card' : 'cards'}` };
  };
  const inDrawer = (id: string) => desk.areas.filter((a) => a.drawer_id === id).map(areaEntry).sort(newestFirst);
  const folders: DrawerFolder[] = [
    {
      id: IDEAS_DRAWER,
      name: 'Ideas',
      entries: ideas
        .map((i) => ({ kind: 'idea' as const, id: i.id, text: i.text, at: i.created_at, meta: i.source?.surface && i.source.surface !== 'lee' ? `from ${i.source.surface}` : '' }))
        .sort(newestFirst),
    },
    { id: STASHED_DRAWER, name: STASHED, entries: inDrawer(STASHED_DRAWER) },
  ];
  const own = desk.drawers.filter((d) => d.kind === 'areas' && d.id !== STASHED_DRAWER).sort((a, b) => a.name.localeCompare(b.name));
  for (const d of own) folders.push({ id: d.id, name: d.name, entries: inDrawer(d.id) });
  return folders;
}

/** A folder's entries as Today / This week / Older, leaving out empty groups. */
export function byDate(entries: readonly DrawerEntry[], now: Date): Array<{ bucket: DateBucket; label: string; entries: DrawerEntry[] }> {
  return DATE_BUCKETS.map((b) => ({ ...b, entries: entries.filter((e) => dateBucket(e.at, now) === b.bucket) })).filter((g) => g.entries.length > 0);
}

/** Search: every word of the query, in any order, ignoring case; folders with no match drop out. */
export function searchDrawer(folders: readonly DrawerFolder[], query: string): DrawerFolder[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...folders];
  const hit = (e: DrawerEntry) => {
    const hay = `${e.text} ${e.meta}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return folders.map((f) => ({ ...f, entries: f.entries.filter(hit) })).filter((f) => f.entries.length > 0);
}
