/**
 * Freehand lines, shared by the Desk's Draw and a Board's: simplification
 * (to within a screen pixel, looser until it fits a cap) and the smoothed
 * path an SVG or a 2D canvas draws. Pure.
 */

import { clamp, round, type Point } from './camera';

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

/** The distance from `p` to a polyline (Infinity for no points). */
export function polylineDistance(p: Point, points: readonly Point[]): number {
  if (!points.length) return Infinity;
  if (points.length === 1) return Math.hypot(p.x - points[0].x, p.y - points[0].y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
  return best;
}

/** Is a drag a line at all? A click (every point the same) isn't. */
export function isLine(points: readonly Point[]): boolean {
  return points.length >= 2 && points.some((p) => p.x !== points[0].x || p.y !== points[0].y);
}

/**
 * A drawn line (world points, at camera `scale`) simplified to within a
 * screen pixel, loosened until it has at most `max` points.
 */
export function simplifyStroke(points: readonly Point[], scale: number, max: number): Point[] {
  let tol = STROKE_TOLERANCE_PX / scale;
  let pts = simplifyPoints(points, tol);
  while (pts.length > max) pts = simplifyPoints(points, (tol *= 2));
  return pts;
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

/** The same curve as strokePath, onto anything with a 2D canvas's path calls. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
}

export function traceStroke(ctx: PathSink, points: ReadonlyArray<Point>): void {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length < 3) {
    if (points[1]) ctx.lineTo(points[1].x, points[1].y);
    return;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}
