/**
 * Pure model for the Desk surface (docs/16-Desk.md; D2 contract §7). No
 * React, no DOM, no window: scripts/desk-renderer-smoke.mjs runs it bundled
 * with esbuild.
 *
 * - Camera maths: fit a rect, screen ↔ Desk, zoom about a point, pan (§7.2:
 *   CSS transforms, no canvas library).
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

import { cardIdForOrigin, pageIdForExploration, IDEAS_DRAWER, MAX_STROKE_POINTS, PUT_AWAY_DRAWER } from '../../shared/desk';
import type { Desk, DeskArea, DeskCard, DeskCardSummary, DeskLast, DeskRect, DeskStroke, DeskStrokeCreate } from '../../shared/desk';
import type { IconName } from '../icons/iconData.generated';
import type { TaskOrigin, TaskStatus } from '../../shared/cockpit';

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** screen = desk × scale + (x, y). */
export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2;
export const IDENTITY: Camera = { scale: 1, x: 0, y: 0 };

export function clampScale(s: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, s));
}

/** The camera that shows `rect` whole and centred in `view`, `pad` px clear on every side. */
export function fitRect(view: Size, rect: DeskRect, pad = 48, max = MAX_SCALE): Camera {
  const w = Math.max(1, view.w - 2 * pad);
  const h = Math.max(1, view.h - 2 * pad);
  const scale = clampScale(Math.min(w / Math.max(1, rect.w), h / Math.max(1, rect.h)), MIN_SCALE, max);
  return {
    scale,
    x: view.w / 2 - (rect.x + rect.w / 2) * scale,
    y: view.h / 2 - (rect.y + rect.h / 2) * scale,
  };
}

export function screenToDesk(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale };
}

export function deskToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y };
}

/** Zoom by `factor` keeping the Desk point under `at` (screen) where it is. */
export function zoomAt(cam: Camera, at: Point, factor: number): Camera {
  const scale = clampScale(cam.scale * factor);
  const d = screenToDesk(cam, at);
  return { scale, x: at.x - d.x * scale, y: at.y - d.y * scale };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

/** The CSS transform for the Desk layer. */
export function cameraTransform(cam: Camera): string {
  return `translate(${round(cam.x)}px, ${round(cam.y)}px) scale(${round(cam.scale, 4)})`;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** The smallest rect holding every rect; null for none. */
export function boundsOf(rects: readonly DeskRect[]): DeskRect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

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

/** Areas on the Desk (not put away). */
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

function overlaps(a: DeskRect, b: DeskRect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function inside(p: Point, r: DeskRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
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
// Tools: Cursor, Move, Draw
// ---------------------------------------------------------------------------

export type DeskTool = 'cursor' | 'move' | 'draw';

export const DESK_TOOLS: ReadonlyArray<{ tool: DeskTool; key: string; label: string; icon: IconName }> = [
  { tool: 'cursor', key: 'V', label: 'Cursor', icon: 'pointer' },
  { tool: 'move', key: 'M', label: 'Move', icon: 'move' },
  { tool: 'draw', key: 'D', label: 'Draw', icon: 'draw' },
];

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** V, M or D picks a tool; never with ⌘, ctrl or ⌥, and never while you type into something. */
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

/** The pointer's shape: grab (grabbing while dragging) in Move, a crosshair in Draw. */
export function toolCursor(tool: DeskTool, dragging: boolean): 'default' | 'grab' | 'grabbing' | 'crosshair' {
  if (tool === 'move') return dragging ? 'grabbing' : 'grab';
  return tool === 'draw' ? 'crosshair' : 'default';
}

/** Screen px a press may wander and still be a click. */
export const DRAG_SLOP = 4;

export function movedEnough(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_SLOP;
}

/** A drag in screen px as Desk px. */
export function dragDelta(from: Point, to: Point, scale: number): Point {
  return { x: (to.x - from.x) / scale, y: (to.y - from.y) / scale };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), Math.max(lo, hi));
}

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

/** What you changed here and Hester hasn't answered yet: shown at once, dropped once GET /desk has it. */
export interface DeskEdits {
  cards: Readonly<Record<string, { area_id: string; x: number; y: number }>>;
  areas: Readonly<Record<string, { x: number; y: number }>>;
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

/** Screen px: the line's width, and how far apart the points you draw are kept. */
export const STROKE_WIDTH = 2;
export const STROKE_STEP_PX = 2;
/** Screen px a simplified line may stray from what you drew. */
export const STROKE_TOLERANCE_PX = 0.75;

/** Ramer–Douglas–Peucker: the fewest points within `tolerance` of the line. Endpoints are kept. */
export function simplifyPoints(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let far = -1;
    let dist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > dist) {
        dist = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** The distance from `p` to the segment a–b. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A drawn line (Desk points, at camera `scale`) as a stroke to save:
 * simplified to within a screen pixel (looser until it fits Hester's cap),
 * in the Area where it starts (relative to it), else on the Desk. Null for
 * a click, which isn't a line.
 */
export function strokeFromDrag(points: readonly Point[], scale: number, areas: readonly DeskArea[]): DeskStrokeCreate | null {
  if (points.length < 2 || !points.some((p) => p.x !== points[0].x || p.y !== points[0].y)) return null;
  let tol = STROKE_TOLERANCE_PX / scale;
  let pts = simplifyPoints(points, tol);
  while (pts.length > MAX_STROKE_POINTS) pts = simplifyPoints(points, (tol *= 2));
  const area = areaAt(areas, points[0]);
  const ox = area?.x ?? 0;
  const oy = area?.y ?? 0;
  return { area_id: area?.id ?? null, points: pts.map((p): [number, number] => [round(p.x - ox), round(p.y - oy)]), width: STROKE_WIDTH };
}

/** A stroke's points on the Desk; null when its Area isn't on the Desk (put away, or gone). */
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

/** A smoothed SVG path through the points: quadratic curves between midpoints. */
export function strokePath(points: ReadonlyArray<Point>): string {
  if (!points.length) return '';
  const f = (p: Point) => `${round(p.x)} ${round(p.y)}`;
  if (points.length < 3) return `M${f(points[0])}` + (points[1] ? `L${f(points[1])}` : '');
  let d = `M${f(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    d += `Q${f(points[i])} ${f(mid)}`;
  }
  return `${d}L${f(points[points.length - 1])}`;
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
  if (!cardId || !isPageId(cardId)) return fresh ? { session_id: sessionId, cards } : t;
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
  const cards = Array.isArray(v.cards) ? v.cards.filter((c): c is string => typeof c === 'string' && isPageId(c)) : [];
  return { session_id: typeof v.session_id === 'string' ? v.session_id : null, cards: cards.filter((c, i) => cards.indexOf(c) === i) };
}

// ---------------------------------------------------------------------------
// Drawers and cards
// ---------------------------------------------------------------------------

/** The strip's counts: open ideas (the Ideas Drawer's count), and put-away Areas. */
export function drawerCounts(desk: Pick<Desk, 'drawers' | 'areas'>): { ideas: number; putAway: number } {
  const ideas = desk.drawers.find((d) => d.id === IDEAS_DRAWER)?.count ?? 0;
  const pa = desk.drawers.find((d) => d.id === PUT_AWAY_DRAWER);
  const putAway = pa ? Math.max(pa.count, pa.area_ids.length) : desk.areas.filter((a) => a.drawer_id === PUT_AWAY_DRAWER).length;
  return { ideas, putAway };
}

/** Put-away Areas, most recently put away first (the Drawer's order, then any it doesn't list). */
export function putAwayAreas(desk: Pick<Desk, 'drawers' | 'areas'>): DeskArea[] {
  const order = desk.drawers.find((d) => d.id === PUT_AWAY_DRAWER)?.area_ids ?? [];
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
