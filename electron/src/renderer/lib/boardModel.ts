/**
 * Pure model for a Board (docs/16-Desk.md §3.1; plan
 * docs/plans/2026-09-28-boards.md §4; contract shared/board.ts). No React,
 * no DOM: scripts/board-renderer-smoke.mjs runs it bundled with esbuild.
 *
 * - Items: making images, annotations (notes), highlights and lines, in
 *   Board px, each on top of the rest (z).
 * - Hit testing (the topmost item under a point; a line within a few
 *   screen px), the resize handles, marquee selection and the selection's
 *   rect, the Ask or hand-off target, and the annotations it carries.
 * - Moving (a highlight goes with its image; a pinned note's leader
 *   follows its pin), resizing (an image keeps its shape; its highlights
 *   scale with it), deleting (a highlight goes with its image; a note
 *   pinned to what went keeps its text, unpinned) and z order.
 * - Pins: (u, v) within an image or highlight, and the leader line from
 *   the note's edge to the pin.
 * - Tools: Select (V), Annotate (A), Highlight (H), Draw (D); the Esc rule.
 * - Saving: a small state machine for the debounced PUT with its version;
 *   a 409 reloads (the caller says so). The preview's pace and rect.
 *
 * Undo and redo are lib/canvas/history.ts over whole item lists.
 */

import { MAX_BOARD_ITEMS, type BoardHighlight, type BoardImage, type BoardItem, type BoardLink, type BoardNote, type BoardPin, type BoardStroke, type BoardTarget } from '../../shared/board';
import { boundsOf, clamp, inside, overlaps, rectBetween, round, type Point, type Rect, type Size } from './canvas/camera';
import { STROKE_WIDTH, isLine, polylineDistance, simplifyStroke } from './canvas/stroke';
import type { IconName } from '../icons/iconData.generated';

// ---------------------------------------------------------------------------
// Sizes and pace
// ---------------------------------------------------------------------------

export const BOARD_MIN_SCALE = 0.05;
export const BOARD_MAX_SCALE = 8;
/** A new annotation's box, Board px. */
export const NOTE_W = 220;
export const NOTE_H = 72;
/** How far up and right of its pin a pinned note starts. */
export const PIN_OFFSET = 40;
/** The longest side a new image gets, Board px (its own pixels ÷ the screen's density, if smaller). */
export const IMAGE_MAX = 960;
/** Nothing resizes smaller than this, Board px. */
export const MIN_ITEM = 16;
/** A highlight smaller than this on either side is a click, not a region. */
export const MIN_HIGHLIGHT = 6;
/** Screen px either side of a line that still picks it. */
export const STROKE_HIT_PX = 6;
/** Screen px around a corner that grabs its handle. */
export const HANDLE_PX = 8;
/** The most points a Board line keeps. */
export const MAX_BOARD_STROKE_POINTS = 2000;

/** board.json is PUT this long after the last change (as the Page is). */
export const BOARD_SAVE_MS = 800;
/** After a failed save (Hester offline), try again after this. */
export const BOARD_RETRY_MS = 5000;
/** preview.png is redrawn after a save, at most this often. */
export const PREVIEW_EVERY_MS = 4000;
/** preview.png's longest side, px. */
export const PREVIEW_MAX_PX = 1200;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** `it-` and 8 hex. */
export function newItemId(rand: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += Math.floor(rand() * 16).toString(16);
  return `it-${hex}`;
}

export function itemRect(it: Pick<BoardItem, 'x' | 'y' | 'w' | 'h'>): Rect {
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

/** Back to front (by z, then as listed). */
export function sortByZ<T extends Pick<BoardItem, 'z'>>(items: readonly T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.z - b.it.z || a.i - b.i).map((x) => x.it);
}

/** The z a new item gets: on top of everything. */
export function nextZ(items: ReadonlyArray<Pick<BoardItem, 'z'>>): number {
  let top = 0;
  for (const it of items) top = Math.max(top, it.z);
  return top + 1;
}

/** Every item's rect together; null for an empty Board. */
export function boardBounds(items: readonly BoardItem[]): Rect | null {
  return boundsOf(items.map(itemRect));
}

export function canAdd(items: readonly BoardItem[], n = 1): boolean {
  return items.length + n <= MAX_BOARD_ITEMS;
}

/** An image's size on the Board: its pixels ÷ the screen's density, the longest side at most `max`. */
export function imageSize(natural: Size, dpr = 1, max = IMAGE_MAX): Size {
  const w = Math.max(1, natural.w / Math.max(1, dpr));
  const h = Math.max(1, natural.h / Math.max(1, dpr));
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** An image centred on `centre` (where you pasted or dropped it). */
export function makeImage(items: readonly BoardItem[], asset: string, natural: Size, centre: Point, dpr = 1, id = newItemId()): BoardImage {
  const s = imageSize(natural, dpr);
  return { id, kind: 'image', asset, x: Math.round(centre.x - s.w / 2), y: Math.round(centre.y - s.h / 2), w: s.w, h: s.h, z: nextZ(items) };
}

/**
 * An annotation where you clicked; pinned (to an image or highlight under
 * the click) it starts up and to the right of its pin, with a leader back.
 */
export function makeNote(items: readonly BoardItem[], at: Point, pin: BoardPin | null = null, text = '', id = newItemId()): BoardNote {
  const x = pin ? at.x + PIN_OFFSET : at.x;
  const y = pin ? at.y - NOTE_H - PIN_OFFSET : at.y;
  return { id, kind: 'note', text, x: Math.round(x), y: Math.round(y), w: NOTE_W, h: NOTE_H, z: nextZ(items), ...(pin ? { pin } : {}) };
}

/** A link box to another card, centred on `centre`. */
export const LINK_W = 240;
export const LINK_H = 40;
export function makeLink(items: readonly BoardItem[], cardId: string, centre: Point, id = newItemId()): BoardLink {
  return { id, kind: 'link', card_id: cardId, x: Math.round(centre.x - LINK_W / 2), y: Math.round(centre.y - LINK_H / 2), w: LINK_W, h: LINK_H, z: nextZ(items) };
}

/** Pasted text that is one card link and nothing else: its card id. */
export function loneCardLink(text: string): string | null {
  const m = /^\[\[((?:pg|bd)-[0-9a-f]{8})(?:\|[^\]]*)?\]\]$/.exec(text.trim());
  return m ? m[1] : null;
}

/** A `[[` being typed in a note, up to the caret: where it starts and what's typed after it; null when there's none. */
export function linkQueryAt(text: string, caret: number): { from: number; query: string } | null {
  const m = /\[\[([^\]\n|[]{0,60})$/.exec(text.slice(0, caret));
  return m ? { from: caret - m[0].length, query: m[1] } : null;
}

/** A highlight dragged from `a` to `b`: kept inside the image it's on. Null for a click. */
export function makeHighlight(items: readonly BoardItem[], a: Point, b: Point, on: BoardImage | null, id = newItemId()): BoardHighlight | null {
  let r = rectBetween(a, b);
  if (on) r = clipRect(r, itemRect(on));
  if (r.w < MIN_HIGHLIGHT || r.h < MIN_HIGHLIGHT) return null;
  return { id, kind: 'highlight', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), z: nextZ(items), ...(on ? { item_id: on.id } : {}) };
}

/**
 * A line drawn at camera `scale` (Board points): simplified to within a
 * screen pixel, its width the Desk's on screen at the zoom it was drawn,
 * its x/y/w/h its bounds. Null for a click.
 */
export function makeStroke(items: readonly BoardItem[], points: readonly Point[], scale: number, id = newItemId()): BoardStroke | null {
  if (!isLine(points)) return null;
  const pts = simplifyStroke(points, scale, MAX_BOARD_STROKE_POINTS).map((p): [number, number] => [round(p.x), round(p.y)]);
  const b = pointsBounds(pts);
  return { id, kind: 'stroke', points: pts, width: round(clamp(STROKE_WIDTH / scale, 0.5, 48)), ...b, z: nextZ(items) };
}

function pointsBounds(pts: ReadonlyArray<[number, number]>): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: round(x0), y: round(y0), w: round(Math.max(1, x1 - x0)), h: round(Math.max(1, y1 - y0)) };
}

function clipRect(r: Rect, to: Rect): Rect {
  const x0 = clamp(r.x, to.x, to.x + to.w);
  const y0 = clamp(r.y, to.y, to.y + to.h);
  const x1 = clamp(r.x + r.w, to.x, to.x + to.w);
  const y1 = clamp(r.y + r.h, to.y, to.y + to.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function updateItem(items: readonly BoardItem[], id: string, patch: Partial<BoardItem>): BoardItem[] {
  return items.map((it) => (it.id === id ? ({ ...it, ...patch, id: it.id, kind: it.kind } as BoardItem) : it));
}

// ---------------------------------------------------------------------------
// Hit testing and selection
// ---------------------------------------------------------------------------

/** Is `p` on the item? A line within `tol` (Board px) of its path; anything else inside its rect. */
export function hitItem(it: BoardItem, p: Point, tol = 0): boolean {
  if (it.kind === 'stroke') {
    const r = itemRect(it);
    const pad = tol + it.width / 2;
    if (!inside(p, { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad })) return false;
    return polylineDistance(p, it.points.map(([x, y]) => ({ x, y }))) <= pad;
  }
  return inside(p, itemRect(it));
}

/** The topmost item under `p` (optionally only some kinds). */
export function itemAt(items: readonly BoardItem[], p: Point, tol = 0, only?: ReadonlyArray<BoardItem['kind']>): BoardItem | null {
  const sorted = sortByZ(items);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const it = sorted[i];
    if (only && !only.includes(it.kind)) continue;
    if (hitItem(it, p, tol)) return it;
  }
  return null;
}

/** What Annotate pins to: the topmost image or highlight under `p`. */
export function pinTargetAt(items: readonly BoardItem[], p: Point): BoardImage | BoardHighlight | null {
  return itemAt(items, p, 0, ['image', 'highlight']) as BoardImage | BoardHighlight | null;
}

/** What Highlight marks: the topmost image under `p`. */
export function imageAt(items: readonly BoardItem[], p: Point): BoardImage | null {
  return itemAt(items, p, 0, ['image']) as BoardImage | null;
}

/** Marquee: every item the rect touches, back to front. */
export function itemsInRect(items: readonly BoardItem[], r: Rect): string[] {
  return sortByZ(items)
    .filter((it) => overlaps(r, itemRect(it)))
    .map((it) => it.id);
}

/** Shift-click: in or out of the selection. */
export function toggleSelected(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** The selected items' rect together; null for none. */
export function selectionRect(items: readonly BoardItem[], ids: readonly string[]): Rect | null {
  const set = new Set(ids);
  return boundsOf(items.filter((it) => set.has(it.id)).map(itemRect));
}

/** What an Ask or a hand-off on the selection is about: its items and its rect (whole Board px). */
export function selectionTarget(items: readonly BoardItem[], ids: readonly string[]): BoardTarget | null {
  const known = ids.filter((id) => items.some((it) => it.id === id));
  const r = selectionRect(items, known);
  if (!r) return null;
  return { item_ids: known, rect: { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.w), h: Math.ceil(r.h) } };
}

/** The annotations a selection carries: its own notes, and notes pinned to what's in it; non-empty, in z order. */
export function selectionNotes(items: readonly BoardItem[], ids: readonly string[]): string[] {
  const set = new Set(ids);
  return sortByZ(items)
    .filter((it): it is BoardNote => it.kind === 'note' && (set.has(it.id) || (!!it.pin && set.has(it.pin.item_id))))
    .map((n) => n.text.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Move, resize, delete, z order
// ---------------------------------------------------------------------------

function shift(it: BoardItem, dx: number, dy: number): BoardItem {
  const moved = { ...it, x: round(it.x + dx), y: round(it.y + dy) };
  if (it.kind === 'stroke') return { ...(moved as BoardStroke), points: it.points.map(([x, y]): [number, number] => [round(x + dx), round(y + dy)]) };
  return moved as BoardItem;
}

/** The ids a move of `ids` takes along: them, and the highlights on any image among them. */
export function movingWith(items: readonly BoardItem[], ids: readonly string[]): Set<string> {
  const set = new Set(ids);
  for (const it of items) if (it.kind === 'highlight' && it.item_id && set.has(it.item_id)) set.add(it.id);
  return set;
}

/** Move `ids` by `delta` (Board px). A pinned note's pin is (u, v) on its item, so its leader follows. */
export function moveItems(items: readonly BoardItem[], ids: readonly string[], delta: Point): BoardItem[] {
  if (!delta.x && !delta.y) return items.slice();
  const set = movingWith(items, ids);
  return items.map((it) => (set.has(it.id) ? shift(it, delta.x, delta.y) : it));
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se';
export const HANDLES: readonly Handle[] = ['nw', 'ne', 'sw', 'se'];

/** Images, notes, highlights and lines resize; asks, hand-offs and links keep their size. */
export function isResizable(it: BoardItem): boolean {
  return it.kind === 'image' || it.kind === 'note' || it.kind === 'highlight' || it.kind === 'stroke';
}

/** The corner handle under `p` (Board px) on rect `r` at camera `scale`, or null. */
export function handleAt(r: Rect, p: Point, scale: number): Handle | null {
  const tol = HANDLE_PX / scale;
  const corners: Array<[Handle, number, number]> = [
    ['nw', r.x, r.y],
    ['ne', r.x + r.w, r.y],
    ['sw', r.x, r.y + r.h],
    ['se', r.x + r.w, r.y + r.h],
  ];
  for (const [h, x, y] of corners) if (Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol) return h;
  return null;
}

/**
 * `r` with corner `handle` dragged by `delta`; the opposite corner stays.
 * `aspect` (w / h) keeps an image's shape. Never smaller than MIN_ITEM.
 */
export function resizeRect(r: Rect, handle: Handle, delta: Point, aspect: number | null = null): Rect {
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  let w = Math.max(MIN_ITEM, r.w + (west ? -delta.x : delta.x));
  let h = Math.max(MIN_ITEM, r.h + (north ? -delta.y : delta.y));
  if (aspect && aspect > 0) {
    // The larger change wins; the other side follows it.
    if (w / r.w >= h / r.h) h = Math.max(MIN_ITEM, w / aspect);
    else w = Math.max(MIN_ITEM, h * aspect);
    if (h === MIN_ITEM) w = Math.max(MIN_ITEM, h * aspect);
  }
  const x = west ? r.x + r.w - w : r.x;
  const y = north ? r.y + r.h - h : r.y;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

function mapRect(inner: Rect, from: Rect, to: Rect): Rect {
  const kx = to.w / Math.max(1e-6, from.w);
  const ky = to.h / Math.max(1e-6, from.h);
  return { x: round(to.x + (inner.x - from.x) * kx), y: round(to.y + (inner.y - from.y) * ky), w: round(inner.w * kx), h: round(inner.h * ky) };
}

/** Item `id` resized to `to`: a line's points scale, and an image's highlights scale with it. */
export function resizeItem(items: readonly BoardItem[], id: string, to: Rect): BoardItem[] {
  const target = items.find((it) => it.id === id);
  if (!target) return items.slice();
  const from = itemRect(target);
  return items.map((it) => {
    if (it.id === id) {
      if (it.kind === 'stroke') {
        const kx = to.w / Math.max(1e-6, from.w);
        const ky = to.h / Math.max(1e-6, from.h);
        return { ...it, ...to, points: it.points.map(([x, y]): [number, number] => [round(to.x + (x - from.x) * kx), round(to.y + (y - from.y) * ky)]) };
      }
      return { ...it, ...to } as BoardItem;
    }
    if (target.kind === 'image' && it.kind === 'highlight' && it.item_id === id) return { ...it, ...mapRect(itemRect(it), from, to) };
    return it;
  });
}

/** An image keeps its shape when resized; the rest don't. */
export function aspectFor(it: BoardItem): number | null {
  return it.kind === 'image' ? it.w / Math.max(1, it.h) : null;
}

/**
 * Delete `ids`: a highlight goes with its image; a note pinned to anything
 * that went keeps its words and loses its pin.
 */
export function removeItems(items: readonly BoardItem[], ids: readonly string[]): BoardItem[] {
  const gone = movingWith(items, ids);
  return items
    .filter((it) => !gone.has(it.id))
    .map((it) => (it.kind === 'note' && it.pin && gone.has(it.pin.item_id) ? { ...it, pin: null } : it));
}

/** Bring `ids` to the front, keeping their order among themselves. */
export function bringToFront(items: readonly BoardItem[], ids: readonly string[]): BoardItem[] {
  const set = new Set(ids);
  let z = nextZ(items.filter((it) => !set.has(it.id)));
  const order = new Map(sortByZ(items.filter((it) => set.has(it.id))).map((it) => [it.id, z++]));
  return items.map((it) => (order.has(it.id) ? { ...it, z: order.get(it.id) as number } : it));
}

/** Send `ids` to the back, keeping their order among themselves. */
export function sendToBack(items: readonly BoardItem[], ids: readonly string[]): BoardItem[] {
  const set = new Set(ids);
  const rest = items.filter((it) => !set.has(it.id));
  const low = rest.length ? Math.min(...rest.map((it) => it.z)) : 1;
  const moving = sortByZ(items.filter((it) => set.has(it.id)));
  const order = new Map(moving.map((it, i) => [it.id, low - moving.length + i]));
  return items.map((it) => (order.has(it.id) ? { ...it, z: order.get(it.id) as number } : it));
}

// ---------------------------------------------------------------------------
// Pins and leader lines
// ---------------------------------------------------------------------------

/** A pin at `p` on `target`: u and v 0–1 within it. */
export function pinFor(target: Pick<BoardItem, 'id' | 'x' | 'y' | 'w' | 'h'>, p: Point): BoardPin {
  return {
    item_id: target.id,
    u: round(clamp((p.x - target.x) / Math.max(1e-6, target.w), 0, 1), 4),
    v: round(clamp((p.y - target.y) / Math.max(1e-6, target.h), 0, 1), 4),
  };
}

/** Where a pin is on the Board; null when its item is gone. */
export function pinPoint(items: readonly BoardItem[], pin: BoardPin | null | undefined): Point | null {
  if (!pin) return null;
  const it = items.find((x) => x.id === pin.item_id);
  return it ? { x: it.x + pin.u * it.w, y: it.y + pin.v * it.h } : null;
}

/**
 * A pinned note's leader: from where the line to the pin leaves the note's
 * box, to the pin. Null when unpinned, its item is gone, or the pin is
 * under the note.
 */
export function leaderLine(note: BoardNote, items: readonly BoardItem[]): { from: Point; to: Point } | null {
  const to = pinPoint(items, note.pin);
  if (!to) return null;
  const r = itemRect(note);
  if (inside(to, r)) return null;
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  // Scale the centre→pin vector to the box's edge.
  const t = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
  return { from: { x: round(c.x + dx * t), y: round(c.y + dy * t) }, to: { x: round(to.x), y: round(to.y) } };
}

// ---------------------------------------------------------------------------
// Tools and Esc
// ---------------------------------------------------------------------------

export type BoardTool = 'select' | 'annotate' | 'highlight' | 'draw';

export const BOARD_TOOLS: ReadonlyArray<{ tool: BoardTool; key: string; label: string; icon: IconName }> = [
  { tool: 'select', key: 'V', label: 'Select', icon: 'pointer' },
  { tool: 'annotate', key: 'A', label: 'Annotate', icon: 'edit' },
  { tool: 'highlight', key: 'H', label: 'Highlight', icon: 'area' },
  { tool: 'draw', key: 'D', label: 'Draw', icon: 'draw' },
];

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

/** V, A, H or D picks a tool; never with a modifier, and never while you type into something. */
export function boardToolForKey(e: KeyLike, typing: boolean): BoardTool | null {
  if (typing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return null;
  const k = e.key.toLowerCase();
  return BOARD_TOOLS.find((t) => t.key.toLowerCase() === k)?.tool ?? null;
}

export type BoardEscStep = 'cancel' | 'stop-editing' | 'deselect' | 'select-tool' | 'zoom-out';

/** Esc on a Board: a drag in progress, then the note you're writing, the selection, back to Select, then out to the Desk. */
export function boardEscapeStep(s: { dragging: boolean; editing: boolean; selected: number; tool: BoardTool }): BoardEscStep {
  if (s.dragging) return 'cancel';
  if (s.editing) return 'stop-editing';
  if (s.selected > 0) return 'deselect';
  if (s.tool !== 'select') return 'select-tool';
  return 'zoom-out';
}

/** The pointer's shape: grab while Space is down (grabbing while panning), a crosshair to draw or highlight, text to annotate. */
export function boardCursor(tool: BoardTool, s: { panning?: boolean; space?: boolean; handle?: Handle | null } = {}): string {
  if (s.panning) return 'grabbing';
  if (s.space) return 'grab';
  if (s.handle) return s.handle === 'nw' || s.handle === 'se' ? 'nwse-resize' : 'nesw-resize';
  if (tool === 'draw' || tool === 'highlight') return 'crosshair';
  if (tool === 'annotate') return 'text';
  return 'default';
}

// ---------------------------------------------------------------------------
// Saving: debounced, versioned; a 409 reloads
// ---------------------------------------------------------------------------

export interface BoardSave {
  /** The version Hester last gave; null before the first load. */
  version: string | null;
  /** Changed since the last PUT started. */
  dirty: boolean;
  saving: boolean;
  /** The last PUT failed (Hester offline): try again after BOARD_RETRY_MS. */
  failed: boolean;
}

export const SAVE_START: BoardSave = { version: null, dirty: false, saving: false, failed: false };

export type BoardSaveEvent =
  | { type: 'loaded'; version: string }
  | { type: 'edit' }
  | { type: 'start' }
  | { type: 'saved'; version: string }
  /** Hester has a newer Board: take its version (the caller shows its items). */
  | { type: 'conflict'; version: string }
  | { type: 'failed' };

export function saveStep(s: BoardSave, e: BoardSaveEvent): BoardSave {
  switch (e.type) {
    case 'loaded':
      return { version: e.version, dirty: false, saving: false, failed: false };
    case 'edit':
      return { ...s, dirty: true };
    case 'start':
      return { ...s, dirty: false, saving: true };
    case 'saved':
      // Edits made while it was in flight keep `dirty` and go in the next PUT.
      return { ...s, version: e.version, saving: false, failed: false };
    case 'conflict':
      return { version: e.version, dirty: false, saving: false, failed: false };
    case 'failed':
      return { ...s, dirty: true, saving: false, failed: true };
  }
}

/** When to PUT next: null when there's nothing to save or one is in flight. */
export function saveDelay(s: BoardSave): number | null {
  if (!s.dirty || s.saving) return null;
  return s.failed ? BOARD_RETRY_MS : BOARD_SAVE_MS;
}

/** What the header says after a 409. */
export const CONFLICT_NOTICE = 'This Board changed elsewhere, so it was reloaded';

/** How long until the preview may be redrawn: 0 now, else the wait. */
export function previewDelay(lastAt: number | null, now: number): number {
  return lastAt == null ? 0 : Math.max(0, lastAt + PREVIEW_EVERY_MS - now);
}

/** The preview's rect: everything on the Board with a margin; null for an empty Board. */
export function previewRect(items: readonly BoardItem[], pad = 24): Rect | null {
  const b = boardBounds(items);
  return b ? { x: Math.floor(b.x - pad), y: Math.floor(b.y - pad), w: Math.ceil(b.w + 2 * pad), h: Math.ceil(b.h + 2 * pad) } : null;
}

/** The scale that draws `r` with its longest side at most `maxPx` (never above 1). */
export function previewScale(r: Size, maxPx = PREVIEW_MAX_PX): number {
  return Math.min(1, maxPx / Math.max(1, r.w, r.h));
}

/** Items from Hester, defensively: known kinds with numbers where the contract wants them. */
export function parseItems(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return raw.filter(
    (it): it is BoardItem =>
      !!it &&
      typeof it === 'object' &&
      typeof (it as BoardItem).id === 'string' &&
      typeof (it as BoardItem).kind === 'string' &&
      num((it as BoardItem).x) &&
      num((it as BoardItem).y) &&
      num((it as BoardItem).w) &&
      num((it as BoardItem).h) &&
      ((it as BoardItem).kind !== 'stroke' || Array.isArray((it as BoardStroke).points)),
  ).map((it) => (num(it.z) ? it : { ...it, z: 0 }));
}
