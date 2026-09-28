/**
 * A Board as a picture (plan docs/plans/2026-09-28-boards.md §4): a set of
 * items drawn onto a 2D canvas for a rect, then a PNG Blob. preview.png is
 * the whole Board; a flattened selection (the Ask or hand-off's snapshot)
 * is the selection's rect with only its items.
 *
 * No React. drawBoard takes any 2D context and the images already decoded
 * (ImageBitmaps by asset name, lib/boardAssets.ts), so the smoke drives it
 * with a stub context; renderBoardPng makes an offscreen canvas (or a
 * <canvas> where there's no OffscreenCanvas). A canvas can't read CSS
 * variables: the surface passes the theme's colours (BoardColors).
 */

import { CARD_LINK_RE, type BoardItem, type BoardNote } from '../../shared/board';
import type { Rect } from './canvas/camera';
import { traceStroke } from './canvas/stroke';
import { leaderLine, pinPoint, previewScale, sortByZ, PREVIEW_MAX_PX } from './boardModel';

export interface BoardColors {
  /** The Board's paper. */
  ground: string;
  /** A note's box, an image still loading. */
  card: string;
  border: string;
  text: string;
  muted: string;
  /** Lines you drew, and leaders. */
  ink: string;
  /** A highlight's fill and edge. */
  highlight: string;
  highlightEdge: string;
  /** An Ask's sticky note. */
  sticky: string;
}

/** Phosphor's dark ground (styles/tokens.css) for when the surface doesn't pass its own. */
export const DEFAULT_BOARD_COLORS: BoardColors = {
  ground: '#0a1410',
  card: '#0d1a14',
  border: '#1a3028',
  text: '#e6f0eb',
  muted: '#6b8a7e',
  ink: '#9fbcb0',
  highlight: 'rgba(230, 240, 235, 0.12)',
  highlightEdge: 'rgba(230, 240, 235, 0.45)',
  sticky: '#1f2a1c',
};

/** The 2D calls drawBoard makes (a CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D has them all). */
export interface Ctx2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void;
}

export interface RenderOptions {
  /** Output px per Board px; by default the longest side is at most `maxPx`. */
  scale?: number;
  maxPx?: number;
  colors?: Partial<BoardColors>;
  /** Fill the paper first (default true). */
  background?: boolean;
  /** Only these items (a selection); every item when absent. */
  only?: readonly string[];
  /** A linked card's title, for a link item. */
  titleOf?: (cardId: string) => string;
  /** The words an Ask or hand-off shows (its question, its kind); 'Ask' / 'Hand-off' when absent. */
  answerLabel?: (item: BoardItem) => string;
  /** Tests: make the canvas. */
  createCanvas?: (w: number, h: number) => { getContext(kind: '2d'): unknown; convertToBlob?: (o: { type: string }) => Promise<Blob>; toBlob?: (cb: (b: Blob | null) => void, type: string) => void } | null;
}

const FONT = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const LINE_H = 19;
const PAD = 10;

/** Markdown as the plain words a canvas draws: `[[pg-…|Title]]` → Title, links → their text, marks gone. */
export function plainText(md: string): string {
  return md
    .replace(CARD_LINK_RE, (_m, id: string, title?: string) => (title && title.trim()) || id)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?)/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .trim();
}

/** Words wrapped to `maxW` by `measure`; a word longer than the line is cut by characters. */
export function wrapLines(text: string, maxW: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= maxW) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      if (measure(word) <= maxW) {
        line = word;
        continue;
      }
      let part = '';
      for (const ch of word) {
        if (measure(part + ch) > maxW && part) {
          out.push(part);
          part = '';
        }
        part += ch;
      }
      line = part;
    }
    out.push(line);
  }
  return out;
}

function roundedRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

function textBox(ctx: Ctx2D, text: string, r: Rect, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.font = FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  const lines = wrapLines(text, Math.max(8, r.w - 2 * PAD), (s) => ctx.measureText(s).width);
  const fits = Math.max(1, Math.floor((r.h - PAD) / LINE_H));
  lines.slice(0, fits).forEach((l, i) => ctx.fillText(l, r.x + PAD, r.y + PAD + i * LINE_H));
  ctx.restore();
}

function drawLeader(ctx: Ctx2D, note: BoardNote, items: readonly BoardItem[], c: BoardColors, unit: number): void {
  const line = leaderLine(note, items);
  const pin = pinPoint(items, note.pin);
  if (line) {
    ctx.beginPath();
    ctx.moveTo(line.from.x, line.from.y);
    ctx.lineTo(line.to.x, line.to.y);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = unit;
    ctx.stroke();
  }
  if (pin) {
    ctx.beginPath();
    ctx.arc(pin.x, pin.y, 3 * unit, 0, Math.PI * 2);
    ctx.fillStyle = c.ink;
    ctx.fill();
  }
}

/**
 * Draw `items` for Board rect `rect` at `scale` output px per Board px.
 * `images` holds decoded images by asset name; one still missing draws as
 * an empty card.
 */
export function drawBoard(
  ctx: Ctx2D,
  items: readonly BoardItem[],
  rect: Rect,
  images: ReadonlyMap<string, CanvasImageSource>,
  scale: number,
  opts: Omit<RenderOptions, 'scale' | 'maxPx' | 'createCanvas'> = {},
): void {
  const c = { ...DEFAULT_BOARD_COLORS, ...opts.colors };
  const only = opts.only ? new Set(opts.only) : null;
  const shown = sortByZ(only ? items.filter((it) => only.has(it.id)) : items);
  // Lines and edges stay about a pixel wide in the picture whatever its scale.
  const unit = 1 / Math.max(scale, 1e-6);
  ctx.save();
  if (opts.background !== false) {
    ctx.fillStyle = c.ground;
    ctx.fillRect(0, 0, rect.w * scale, rect.h * scale);
  }
  ctx.scale(scale, scale);
  ctx.translate(-rect.x, -rect.y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const it of shown) {
    switch (it.kind) {
      case 'image': {
        const img = images.get(it.asset);
        if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
        else {
          ctx.fillStyle = c.card;
          ctx.fillRect(it.x, it.y, it.w, it.h);
        }
        break;
      }
      case 'highlight':
        ctx.fillStyle = c.highlight;
        ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.beginPath();
        ctx.rect(it.x, it.y, it.w, it.h);
        ctx.strokeStyle = c.highlightEdge;
        ctx.lineWidth = unit;
        ctx.stroke();
        break;
      case 'stroke':
        ctx.beginPath();
        traceStroke(ctx, it.points.map(([x, y]) => ({ x, y })));
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = it.width;
        ctx.stroke();
        break;
      case 'note':
        // Leaders read against the whole Board, not just what's drawn.
        drawLeader(ctx, it, items, c, unit);
        roundedRect(ctx, it.x, it.y, it.w, it.h, 6);
        ctx.fillStyle = c.card;
        ctx.fill();
        ctx.strokeStyle = c.border;
        ctx.lineWidth = unit;
        ctx.stroke();
        textBox(ctx, plainText(it.text), it, c.text);
        break;
      case 'ask':
        roundedRect(ctx, it.x, it.y, it.w, it.h, 3);
        ctx.fillStyle = c.sticky;
        ctx.fill();
        textBox(ctx, opts.answerLabel?.(it) || 'Ask', it, c.text);
        break;
      case 'handoff': {
        roundedRect(ctx, it.x, it.y, it.w, it.h, 6);
        ctx.fillStyle = c.card;
        ctx.fill();
        ctx.strokeStyle = c.border;
        ctx.lineWidth = unit;
        ctx.stroke();
        // The clipboard's clip.
        const cw = Math.min(40, it.w / 3);
        ctx.fillStyle = c.muted;
        ctx.fillRect(it.x + (it.w - cw) / 2, it.y - 4, cw, 8);
        textBox(ctx, opts.answerLabel?.(it) || 'Hand-off', { x: it.x, y: it.y + 6, w: it.w, h: it.h - 6 }, c.text);
        break;
      }
      case 'link':
        roundedRect(ctx, it.x, it.y, it.w, it.h, 6);
        ctx.fillStyle = c.card;
        ctx.fill();
        ctx.strokeStyle = c.border;
        ctx.lineWidth = unit;
        ctx.stroke();
        textBox(ctx, `→ ${opts.titleOf?.(it.card_id) || it.card_id}`, it, c.muted);
        break;
    }
  }
  ctx.restore();
}

/**
 * Draw `items` for `rect` onto a new canvas and encode it as PNG; null when
 * there's no canvas to draw on (or the rect is empty).
 */
export async function renderBoardPng(
  items: readonly BoardItem[],
  rect: Rect,
  images: ReadonlyMap<string, CanvasImageSource>,
  opts: RenderOptions = {},
): Promise<Blob | null> {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const scale = opts.scale ?? previewScale(rect, opts.maxPx ?? PREVIEW_MAX_PX);
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  const canvas = opts.createCanvas ? opts.createCanvas(w, h) : makeCanvas(w, h);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) return null;
  drawBoard(ctx, items, rect, images, scale, opts);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  if (canvas.toBlob) return new Promise((resolve) => canvas.toBlob?.((b) => resolve(b), 'image/png'));
  return null;
}

function makeCanvas(w: number, h: number): NonNullable<ReturnType<NonNullable<RenderOptions['createCanvas']>>> | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as unknown as ReturnType<typeof makeCanvas>;
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return el as unknown as ReturnType<typeof makeCanvas>;
}
