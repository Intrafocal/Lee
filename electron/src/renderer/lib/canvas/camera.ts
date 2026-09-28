/**
 * Camera maths and gestures shared by the Desk and a Board (docs/16-Desk.md
 * §3.1; plan docs/plans/2026-09-28-boards.md §4). Pure: no React, no DOM.
 *
 * A camera maps a world (the Desk, a Board) onto the screen with one CSS
 * transform: screen = world × scale + (x, y). Wheel pans, pinch (or ⌘/ctrl
 * + wheel) zooms about the pointer; a press only counts as a drag once it
 * has moved DRAG_SLOP px.
 */

/** screen = world × scale + (x, y). */
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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 2;
export const IDENTITY: Camera = { scale: 1, x: 0, y: 0 };

export function clampScale(s: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, s));
}

/** The camera that shows `rect` whole and centred in `view`, `pad` px clear on every side. */
export function fitRect(view: Size, rect: Rect, pad = 48, max = MAX_SCALE, min = MIN_SCALE): Camera {
  const w = Math.max(1, view.w - 2 * pad);
  const h = Math.max(1, view.h - 2 * pad);
  const scale = clampScale(Math.min(w / Math.max(1, rect.w), h / Math.max(1, rect.h)), min, max);
  return {
    scale,
    x: view.w / 2 - (rect.x + rect.w / 2) * scale,
    y: view.h / 2 - (rect.y + rect.h / 2) * scale,
  };
}

export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale };
}

export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y };
}

/** Zoom by `factor` keeping the world point under `at` (screen) where it is. */
export function zoomAt(cam: Camera, at: Point, factor: number, min = MIN_SCALE, max = MAX_SCALE): Camera {
  const scale = clampScale(cam.scale * factor, min, max);
  const d = screenToWorld(cam, at);
  return { scale, x: at.x - d.x * scale, y: at.y - d.y * scale };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** A wheel event's camera: pinch (ctrl) or ⌘ + wheel zooms about `at`; otherwise it pans. */
export function wheelCamera(cam: Camera, e: WheelLike, at: Point, min = MIN_SCALE, max = MAX_SCALE): Camera {
  if (e.ctrlKey || e.metaKey) return zoomAt(cam, at, Math.exp(-e.deltaY * 0.01), min, max);
  return panBy(cam, -e.deltaX, -e.deltaY);
}

/** The CSS transform for the world layer. */
export function cameraTransform(cam: Camera): string {
  return `translate(${round(cam.x)}px, ${round(cam.y)}px) scale(${round(cam.scale, 4)})`;
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), Math.max(lo, hi));
}

/** The smallest rect holding every rect; null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
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

export function inside(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** The rect a drag from `a` to `b` outlines, whichever way it went. */
export function rectBetween(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Screen px a press may wander and still be a click. */
export const DRAG_SLOP = 4;

export function movedEnough(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_SLOP;
}

/** A drag in screen px as world px. */
export function dragDelta(from: Point, to: Point, scale: number): Point {
  return { x: (to.x - from.x) / scale, y: (to.y - from.y) / scale };
}
