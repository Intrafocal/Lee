/**
 * Asks and hand-offs on a Board (Boards B3, docs/16-Desk.md §3.1): the pure
 * half. Asking about a selection drops a sticky note beside it; handing it
 * off drops a clipboard. Both are answers.jsonl rows that belong to the
 * Board (an `ask` or `handoff` item points at one by `answer_id`).
 *
 * - The target and anchor: the selected items and the marquee, the
 *   flattened snapshot's asset, and the text of the annotations in it.
 * - Placing a new sticky or clipboard beside the target without covering
 *   anything on the Board (Board px), and its sizes collapsed and open.
 * - What a sticky and a clipboard say, collapsed and open (deepModel's
 *   handoffNoteText and handoffLabel, the margin's words).
 * - The section a Board hand-off's brief carries: the notes and the
 *   snapshot's path (Claude Code reads image paths).
 */

import type { BoardAnchor, BoardAsk, BoardHandoff, BoardItem, BoardTarget } from '../../shared/board';
import type { DeepAnswer } from '../../shared/cockpit';
import { handoffLabel, handoffNoteText, isPending } from './deepModel';

export interface Rect { x: number; y: number; w: number; h: number }
type Size = { w: number; h: number };

/** Board px. Collapsed shows the question (or the hand-off's line); open shows the answer. */
export const STICKY_SIZE: { collapsed: Size; open: Size } = { collapsed: { w: 200, h: 132 }, open: { w: 340, h: 320 } };
export const CLIPBOARD_SIZE: { collapsed: Size; open: Size } = { collapsed: { w: 216, h: 120 }, open: { w: 360, h: 340 } };
/** Between the target and a new card, and between a new card and anything else. */
export const PLACE_GAP = 24;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function rectOf(it: Pick<BoardItem, 'x' | 'y' | 'w' | 'h'>): Rect {
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

/** The smallest rect around all of them, or null. */
export function unionRect(rects: readonly Rect[]): Rect | null {
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

/** Overlap, with `gap` of clear space required around `a`. */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x - gap < b.x + b.w && a.x + a.w + gap > b.x && a.y - gap < b.y + b.h && a.y + a.h + gap > b.y;
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

// ---------------------------------------------------------------------------
// The target and the anchor
// ---------------------------------------------------------------------------

/**
 * What an Ask or hand-off is about: the selected items (only ones on the
 * Board, never a sticky or clipboard) and the marquee, else the selection's
 * bounds. Null when there's nothing to ask about.
 */
export function selectionTarget(items: readonly BoardItem[], ids: readonly string[], marquee?: Rect | null): BoardTarget | null {
  const chosen = items.filter((it) => ids.includes(it.id) && it.kind !== 'ask' && it.kind !== 'handoff');
  const rect = marquee && marquee.w > 0 && marquee.h > 0 ? marquee : unionRect(chosen.map(rectOf));
  if (!rect) return null;
  return { item_ids: chosen.map((it) => it.id), rect: round(rect) };
}

/**
 * The annotations an Ask sends (§3.1: "the text of the selected
 * annotations"): notes selected, and notes pinned to a selected item, top to
 * bottom, each once, empty ones left out.
 */
export function selectionNotes(items: readonly BoardItem[], ids: readonly string[]): string[] {
  const picked = items.filter(
    (it): it is Extract<BoardItem, { kind: 'note' }> => it.kind === 'note' && (ids.includes(it.id) || (!!it.pin && ids.includes(it.pin.item_id))),
  );
  picked.sort((a, b) => a.y - b.y || a.x - b.x);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of picked) {
    const t = n.text.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** `sel-1a2b3c4d.png` or `assets/sel-1a2b3c4d.png` → `assets/sel-1a2b3c4d.png`. */
export function snapshotPath(name: string): string {
  return name.startsWith('assets/') ? name : `assets/${name}`;
}

/** The anchor an Ask or hand-off on a Board carries. */
export function boardAnchor(target: BoardTarget, snapshot: string, notes: readonly string[]): BoardAnchor {
  return { kind: 'board', item_ids: [...target.item_ids], rect: { ...target.rect }, snapshot: snapshotPath(snapshot), notes: [...notes] };
}

// ---------------------------------------------------------------------------
// Placing a sticky or clipboard
// ---------------------------------------------------------------------------

/**
 * Where a new card of `size` goes beside `target`: to the right, top-aligned,
 * then below, left and above; each side slides along until it covers nothing
 * on the Board (items other than `ignore`). Falls back to the right of
 * everything.
 */
export function placeBeside(target: Rect, size: Size, items: readonly Pick<BoardItem, 'id' | 'x' | 'y' | 'w' | 'h'>[], ignore: readonly string[] = []): { x: number; y: number } {
  const others = items.filter((it) => !ignore.includes(it.id)).map(rectOf);
  const clear = (r: Rect) => !others.some((o) => overlaps(r, o, PLACE_GAP / 2));
  const g = PLACE_GAP;
  const step = Math.max(24, Math.round(Math.min(size.w, size.h) / 3));
  const sides: Array<(i: number) => Rect> = [
    (i) => ({ x: target.x + target.w + g, y: target.y + i * step, ...size }),
    (i) => ({ x: target.x + i * step, y: target.y + target.h + g, ...size }),
    (i) => ({ x: target.x - g - size.w, y: target.y + i * step, ...size }),
    (i) => ({ x: target.x + i * step, y: target.y - g - size.h, ...size }),
  ];
  // Near first: the first free spot on each side, nearest slide wins.
  for (let i = 0; i < 40; i++) {
    for (const side of sides) {
      const r = side(i);
      if (clear(r)) return { x: Math.round(r.x), y: Math.round(r.y) };
    }
  }
  const all = unionRect(others) ?? target;
  return { x: Math.round(all.x + all.w + g), y: Math.round(target.y) };
}

/** `it-<hex8>`, as Lee makes item ids. */
export function newItemId(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(rand() * 16).toString(16);
  return `it-${s}`;
}

const topZ = (items: readonly Pick<BoardItem, 'z'>[]) => items.reduce((m, it) => Math.max(m, it.z), 0);

/** A new sticky for `answerId`, collapsed, beside its target and above everything. */
export function newAskItem(answerId: string, target: BoardTarget, items: readonly BoardItem[], id: string = newItemId()): BoardAsk {
  const size = STICKY_SIZE.collapsed;
  const at = placeBeside(target.rect, size, items);
  return { id, kind: 'ask', answer_id: answerId, target, open: false, ...at, ...size, z: topZ(items) + 1 };
}

/** A new clipboard for `answerId`, collapsed, beside its target and above everything. */
export function newHandoffItem(answerId: string, target: BoardTarget, items: readonly BoardItem[], id: string = newItemId()): BoardHandoff {
  const size = CLIPBOARD_SIZE.collapsed;
  const at = placeBeside(target.rect, size, items);
  return { id, kind: 'handoff', answer_id: answerId, target, open: false, ...at, ...size, z: topZ(items) + 1 };
}

/** Its size for `open` (the sticky's or the clipboard's). */
export function cardSize(kind: 'ask' | 'handoff', open: boolean): Size {
  const s = kind === 'ask' ? STICKY_SIZE : CLIPBOARD_SIZE;
  return open ? s.open : s.collapsed;
}

/** Open or close in place: the top-left stays, the size changes, and an opened card comes to the top. */
export function toggleCard<T extends BoardAsk | BoardHandoff>(item: T, items: readonly BoardItem[], open: boolean = !item.open): T {
  const size = cardSize(item.kind, open);
  const top = topZ(items);
  return { ...item, open, ...size, z: open && item.z < top ? top + 1 : item.z };
}

/**
 * The thin leader from a card to what it's about: from the card's nearest
 * edge point to the target's nearest edge point. Null when they overlap.
 */
export function leaderLine(card: Rect, target: Rect): [number, number, number, number] | null {
  if (overlaps(card, target)) return null;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  const tx = clamp(cx, target.x, target.x + target.w);
  const ty = clamp(cy, target.y, target.y + target.h);
  const sx = clamp(tx, card.x, card.x + card.w);
  const sy = clamp(ty, card.y, card.y + card.h);
  return [Math.round(sx), Math.round(sy), Math.round(tx), Math.round(ty)];
}

/** The answers the Board's sticky and clipboard items point at (for "which rows have no card yet"). */
export function answerIdsOnBoard(items: readonly BoardItem[]): Set<string> {
  const out = new Set<string>();
  for (const it of items) if (it.kind === 'ask' || it.kind === 'handoff') out.add(it.answer_id);
  return out;
}

// ---------------------------------------------------------------------------
// What the cards say
// ---------------------------------------------------------------------------

type AnswerLike = Pick<DeepAnswer, 'id' | 'question' | 'status' | 'answer' | 'error' | 'read_at' | 'anchor' | 'kind' | 'handoff' | 'follow_up_of'>;

export type StickyState = 'asking' | 'new' | 'read' | 'error' | 'missing';

export interface StickyText {
  state: StickyState;
  /** The question as asked. */
  question: string;
  /** The small line: "Asking…", "New answer", "Answered", "Couldn’t answer". */
  status: string;
  /** Open only: the answer (markdown), or the error. */
  answer: string | null;
  error: string | null;
  /** Retry shows on an error. */
  canRetry: boolean;
  /** Follow-up shows once there's an answer. */
  canFollowUp: boolean;
}

/** A sticky's words from its answer row (null: the row is gone, or not loaded yet). */
export function stickyText(a: AnswerLike | null | undefined): StickyText {
  if (!a) {
    return { state: 'missing', question: '', status: 'Not found', answer: null, error: null, canRetry: false, canFollowUp: false };
  }
  const question = a.question.trim();
  if (isPending(a)) return { state: 'asking', question, status: 'Asking…', answer: null, error: null, canRetry: false, canFollowUp: false };
  if (a.status === 'error' || a.status === 'interrupted') {
    const error = a.error?.trim() || (a.status === 'interrupted' ? 'Interrupted before it answered.' : 'Hester couldn’t answer.');
    return { state: 'error', question, status: 'Couldn’t answer', answer: null, error, canRetry: true, canFollowUp: false };
  }
  const answer = a.answer?.trim() || null;
  return {
    state: a.read_at ? 'read' : 'new',
    question,
    status: a.read_at ? 'Answered' : 'New answer',
    answer,
    error: null,
    canRetry: false,
    canFollowUp: !!answer,
  };
}

/** The follow-ups to a sticky's answer, oldest first (they show under it, open). */
export function followUpsOf<T extends Pick<DeepAnswer, 'id' | 'follow_up_of' | 'asked_at'>>(answerId: string, answers: readonly T[]): T[] {
  const out: T[] = [];
  const ids = new Set([answerId]);
  // A follow-up to a follow-up stays in the same thread.
  for (const a of [...answers].sort((x, y) => x.asked_at.localeCompare(y.asked_at))) {
    if (a.follow_up_of && ids.has(a.follow_up_of)) {
      out.push(a);
      ids.add(a.id);
    }
  }
  return out;
}

export type ClipboardState = 'starting' | 'running' | 'waiting' | 'review' | 'done' | 'error' | 'missing';

export interface ClipboardText {
  state: ClipboardState;
  /** "Spike · working", "Research · waiting on you". */
  label: string;
  /** The result's first line once in, else what was handed off. */
  line: string;
  /** Open only: the result (markdown), or the error. */
  result: string | null;
  error: string | null;
  /** Open in Work shows once the hand-off has a task. */
  taskId: string | null;
}

/** A clipboard's words from its hand-off row. */
export function clipboardText(a: AnswerLike | null | undefined): ClipboardText {
  if (!a) return { state: 'missing', label: 'Hand-off', line: 'Not found', result: null, error: null, taskId: null };
  const h = a.handoff ?? null;
  const st = h?.state ?? (isPending(a) ? 'running' : a.status === 'done' ? 'done' : 'error');
  const state: ClipboardState = st === 'launching' ? 'starting' : (st as ClipboardState);
  const failed = a.status === 'error' || st === 'error';
  // A Board hand-off's anchor has no quote: its line is the result, else what was asked.
  const line = handoffNoteText(a) || (a.anchor?.kind === 'board' ? a.anchor.notes[0] ?? '' : '') || 'The selection';
  return {
    state: failed ? 'error' : state,
    label: handoffLabel(h),
    line,
    result: a.answer?.trim() || null,
    error: failed ? a.error?.trim() || 'The hand-off stopped.' : null,
    taskId: h?.task_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// A Board hand-off's brief
// ---------------------------------------------------------------------------

/** The snapshot's path on disk: `<workspace>/.hester/desk/boards/<id>/assets/sel-….png`. */
export function snapshotFile(workspace: string, boardId: string, snapshot: string): string {
  return `${workspace.replace(/\/+$/, '')}/.hester/desk/boards/${boardId}/${snapshotPath(snapshot)}`;
}

/**
 * What a Board hand-off hands off (the "section" HandoffSheet puts in the
 * brief): what you wrote about it, the annotations, and the picture's path.
 */
export function boardHandoffSection(anchor: BoardAnchor, file: string, what?: string | null): string {
  const parts: string[] = [];
  if (what?.trim()) parts.push(what.trim());
  if (anchor.notes.length) parts.push(['Notes on the selection:', ...anchor.notes.map((n) => `- ${n.replace(/\s*\n\s*/g, ' ')}`)].join('\n'));
  parts.push(`The selection as an image: ${file}`);
  return parts.join('\n\n');
}
