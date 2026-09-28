/**
 * Visualize on a Board (Boards B6, plan docs/plans/2026-09-28-boards.md §5b):
 * the pure half. Visualize runs Hester's diagram agent on a selection and a
 * brief; a `visual` item (a small frame) stands beside the selection while
 * it works, and when the row is done Lee adds what it made beside the frame
 * once (`result_item_id`).
 *
 * - The frame: a new one beside its target (boardAskModel.placeBeside), its
 *   sizes collapsed and open, and what it says (brief, progress, error, what
 *   it made).
 * - The result: what to place for a VisualResult (an image, a Mermaid
 *   diagram to draw, or a note), its size (an image's pixels, capped), where
 *   it goes (beside the frame, covering nothing), and whether it's already
 *   on the Board (two windows, a reload).
 * - Mermaid: the DSL without its fence, the theme Lee draws it in, and the
 *   SVG's size and a sized copy to rasterise (lib/mermaidPng does the DOM).
 */

import type { BoardAsset, BoardImage, BoardItem, BoardNote, BoardTarget, BoardVisual, VisualResult } from '../../shared/board';
import type { DeepAnswer } from '../../shared/cockpit';
import { newItemId, placeBeside, rectOf } from './boardAskModel';
import { imageSize, NOTE_H } from './boardModel';
import { isPending } from './deepModel';

type Size = { w: number; h: number };

/** Board px. Collapsed shows the brief and progress (or what it made); open shows the brief in full. */
export const FRAME_SIZE: { collapsed: Size; open: Size } = { collapsed: { w: 224, h: 116 }, open: { w: 320, h: 240 } };
/** A placed result image's longest side (Board px). */
export const RESULT_MAX = 640;
/** A placed markdown result: a note this wide, as tall as its text (roughly), within these. */
export const RESULT_NOTE_W = 320;
export const RESULT_NOTE_MAX_H = 480;
/** A Mermaid diagram is drawn at 2x, its longest side at most this many pixels. */
export const MERMAID_SCALE = 2;
export const MERMAID_MAX_PX = 2400;

const topZ = (items: readonly Pick<BoardItem, 'z'>[]) => items.reduce((m, it) => Math.max(m, it.z), 0);

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** A new frame for `answerId`, collapsed, beside its target and above everything. */
export function newVisualItem(answerId: string, target: BoardTarget, items: readonly BoardItem[], id: string = newItemId()): BoardVisual {
  const size = FRAME_SIZE.collapsed;
  const at = placeBeside(target.rect, size, items);
  return { id, kind: 'visual', answer_id: answerId, target, result_item_id: null, open: false, ...at, ...size, z: topZ(items) + 1 };
}

/** Open or close in place, as a sticky does: the top-left stays, an opened frame comes to the top. */
export function toggleVisual(item: BoardVisual, items: readonly BoardItem[], open: boolean = !item.open): BoardVisual {
  const size = open ? FRAME_SIZE.open : FRAME_SIZE.collapsed;
  const top = topZ(items);
  return { ...item, open, ...size, z: open && item.z < top ? top + 1 : item.z };
}

type RowLike = Pick<DeepAnswer, 'id' | 'question' | 'brief' | 'status' | 'error' | 'read_at' | 'visual'>;

export type FrameState = 'queued' | 'running' | 'new' | 'done' | 'error' | 'missing';

export interface FrameText {
  state: FrameState;
  /** What you asked it to show. */
  brief: string;
  /** The small line: "Waiting to start…", "Making it…", "Diagram", "Couldn’t make it". */
  status: string;
  /** Done: what it made ("Made a diagram: Login flow"). */
  line: string | null;
  error: string | null;
  canRetry: boolean;
}

const NOUN: Record<VisualResult['type'], { a: string; label: string }> = {
  image: { a: 'an image', label: 'Image' },
  mermaid: { a: 'a diagram', label: 'Diagram' },
  markdown: { a: 'a note', label: 'Note' },
};

/** "Made a diagram: Login flow" (the title left out when it's empty). */
export function madeLine(v: VisualResult): string {
  const title = v.title?.trim();
  return `Made ${NOUN[v.type]?.a ?? 'something'}${title ? `: ${title}` : ''}`;
}

/** A frame's words from its row (null: the row is gone, or not loaded yet). */
export function frameText(a: RowLike | null | undefined): FrameText {
  if (!a) return { state: 'missing', brief: '', status: 'Not found', line: null, error: null, canRetry: false };
  // Hester keeps the whole brief in `brief` and its first line in `question`.
  const brief = (a.brief ?? a.question)?.trim() ?? '';
  if (isPending(a)) {
    const queued = a.status === 'queued';
    return { state: queued ? 'queued' : 'running', brief, status: queued ? 'Waiting to start…' : 'Making it…', line: null, error: null, canRetry: false };
  }
  if (a.status === 'error' || a.status === 'interrupted') {
    const error = a.error?.trim() || (a.status === 'interrupted' ? 'Interrupted before it finished.' : 'Hester couldn’t make it.');
    return { state: 'error', brief, status: 'Couldn’t make it', line: null, error, canRetry: true };
  }
  const v = a.visual ?? null;
  if (!v) return { state: 'error', brief, status: 'Couldn’t make it', line: null, error: 'It finished without a result.', canRetry: true };
  return { state: a.read_at ? 'done' : 'new', brief, status: NOUN[v.type]?.label ?? 'Done', line: madeLine(v), error: null, canRetry: false };
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export type ResultPlan = { kind: 'image'; asset: string } | { kind: 'mermaid'; dsl: string } | { kind: 'note'; text: string };

/** What a result becomes on the Board: an image item, a Mermaid diagram to draw (then an image), or a note. */
export function whatToPlace(v: VisualResult): ResultPlan | null {
  if (v.type === 'image') return v.asset ? { kind: 'image', asset: v.asset } : null;
  if (v.type === 'mermaid') {
    const dsl = mermaidSource(v.dsl);
    return dsl ? { kind: 'mermaid', dsl } : null;
  }
  if (v.type === 'markdown') {
    const text = v.text?.trim();
    return text ? { kind: 'note', text } : null;
  }
  return null;
}

/** Placing is due: the row is done with a result, and the frame has none on the Board yet. */
export function needsResult(item: Pick<BoardVisual, 'result_item_id'>, row: Pick<DeepAnswer, 'status' | 'visual'> | null | undefined): boolean {
  return !item.result_item_id && !!row && row.status === 'done' && !!row.visual;
}

/** The assets Hester (or another window) saved for this answer: the ones whose source is it. */
export function assetsFromAnswer(assets: readonly BoardAsset[], answerId: string): string[] {
  return assets.filter((a) => a.source?.kind === 'answer' && a.source.answer_id === answerId).map((a) => a.name);
}

/**
 * The result already on the Board, if it is (another window placed it and
 * this one reloaded, or the save of `result_item_id` was lost): the item
 * `result_item_id` names; an image of the result's asset or of an asset
 * saved for this answer; a note with the result's text. Null when it isn't.
 */
export function findPlacedResult(
  item: Pick<BoardVisual, 'id' | 'result_item_id'>,
  items: readonly BoardItem[],
  v: VisualResult,
  answerAssets: readonly string[] = [],
): string | null {
  if (item.result_item_id && items.some((it) => it.id === item.result_item_id)) return item.result_item_id;
  const plan = whatToPlace(v);
  if (!plan) return null;
  for (const it of items) {
    if (it.id === item.id) continue;
    if (it.kind === 'image' && ((plan.kind === 'image' && it.asset === plan.asset) || (plan.kind !== 'note' && answerAssets.includes(it.asset)))) return it.id;
    if (it.kind === 'note' && plan.kind === 'note' && it.text.trim() === plan.text) return it.id;
  }
  return null;
}

/** An image result's size on the Board: its pixels ÷ the density it was drawn at, the longest side at most RESULT_MAX. */
export function resultImageSize(natural: Size, dpr = 1): Size {
  return imageSize(natural, dpr, RESULT_MAX);
}

/** A markdown result's note: RESULT_NOTE_W wide, about as tall as its wrapped lines, within NOTE_H and RESULT_NOTE_MAX_H. */
export function resultNoteSize(text: string): Size {
  const perLine = 40;
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return { w: RESULT_NOTE_W, h: Math.max(NOTE_H, Math.min(RESULT_NOTE_MAX_H, 24 + lines * 20)) };
}

/** An image item for the result, beside its frame (covering nothing) and above everything. */
export function resultImage(frame: BoardVisual, items: readonly BoardItem[], asset: string, natural: Size, dpr = 1, id: string = newItemId()): BoardImage {
  const size = resultImageSize(natural, dpr);
  const at = placeBeside(rectOf(frame), size, items);
  return { id, kind: 'image', asset, ...at, ...size, z: topZ(items) + 1 };
}

/** A note item for a markdown result, beside its frame. */
export function resultNote(frame: BoardVisual, items: readonly BoardItem[], text: string, id: string = newItemId()): BoardNote {
  const size = resultNoteSize(text);
  const at = placeBeside(rectOf(frame), size, items);
  return { id, kind: 'note', text, ...at, ...size, z: topZ(items) + 1 };
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/** The DSL without a ```mermaid fence around it (the agent sometimes keeps one). */
export function mermaidSource(dsl: string | null | undefined): string {
  const t = (dsl ?? '').trim();
  const m = /^```(?:mermaid)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * How Lee draws a diagram for a Board: a quiet dark ground in the Phosphor
 * tokens' colours, plain SVG labels (no HTML, so the SVG rasterises), and
 * strict security (no clicks or scripts in the DSL).
 */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict' as const,
  theme: 'base' as const,
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  themeVariables: {
    darkMode: true,
    background: '#0d1a14',
    primaryColor: '#13261e',
    primaryTextColor: '#e6f0eb',
    primaryBorderColor: '#2a4a3e',
    secondaryColor: '#1a3028',
    secondaryTextColor: '#e6f0eb',
    secondaryBorderColor: '#2a4a3e',
    tertiaryColor: '#0a1410',
    tertiaryTextColor: '#e6f0eb',
    tertiaryBorderColor: '#2a4a3e',
    lineColor: '#6b8a7e',
    textColor: '#e6f0eb',
    mainBkg: '#13261e',
    nodeBorder: '#44aa99',
    clusterBkg: '#0a1410',
    clusterBorder: '#2a4a3e',
    edgeLabelBackground: '#0d1a14',
    noteBkgColor: '#1a3028',
    noteTextColor: '#e6f0eb',
    noteBorderColor: '#2a4a3e',
    fontSize: '14px',
  },
};
/** The ground a diagram is drawn on (its PNG has no transparency). */
export const MERMAID_GROUND = '#0d1a14';

/** The `<svg …>` open tag. */
function rootTag(svg: string): { tag: string; at: number } | null {
  const at = svg.indexOf('<svg');
  if (at < 0) return null;
  const end = svg.indexOf('>', at);
  return end < 0 ? null : { tag: svg.slice(at, end + 1), at };
}

/** An SVG's size in px: its viewBox, else numeric width and height; null when it has neither. */
export function svgSize(svg: string): Size | null {
  const root = rootTag(svg);
  if (!root) return null;
  const vb = /\bviewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/.exec(root.tag);
  if (vb) {
    const w = Number(vb[3]);
    const h = Number(vb[4]);
    if (w > 0 && h > 0) return { w, h };
  }
  const attr = (n: string) => {
    const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`).exec(root.tag);
    return m ? Number(m[1]) : NaN;
  };
  const w = attr('width');
  const h = attr('height');
  return w > 0 && h > 0 ? { w, h } : null;
}

/** The SVG with explicit width and height (mermaid's is `width="100%"` with a max-width style), so an <img> draws it at that size. */
export function sizedSvg(svg: string, size: Size): string {
  const root = rootTag(svg);
  if (!root) return svg;
  let tag = root.tag
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/g, '')
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/, '');
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  tag = tag.replace('<svg', `<svg width="${Math.round(size.w)}" height="${Math.round(size.h)}"`);
  return svg.slice(0, root.at) + tag + svg.slice(root.at + root.tag.length);
}

/** The canvas for a diagram of `size`: MERMAID_SCALE, less if its longest side would pass MERMAID_MAX_PX. */
export function rasterSize(size: Size, scale = MERMAID_SCALE, maxPx = MERMAID_MAX_PX): { w: number; h: number; scale: number } {
  const k = Math.min(scale, maxPx / Math.max(size.w, size.h, 1));
  return { w: Math.max(1, Math.round(size.w * k)), h: Math.max(1, Math.round(size.h * k)), scale: k };
}

// ---------------------------------------------------------------------------
// preview.png
// ---------------------------------------------------------------------------

/** What a frame says in preview.png: its brief, else "Visualize". */
export function frameLabel(a: RowLike | null | undefined): string {
  const t = frameText(a);
  return t.line || t.brief || 'Visualize';
}
