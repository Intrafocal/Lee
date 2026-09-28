/**
 * Undo, shared by the Desk and a Board. Pure.
 *
 * - pushCapped: a bounded stack (the Desk's ⌘Z of lines drawn and deleted).
 * - History: undo and redo of whole snapshots (a Board's items). `record`
 *   keeps the state before a change; undo swaps the current state for it
 *   and keeps the current one for redo; any new change clears redo.
 */

export const UNDO_MAX = 50;

/** `list` with `item` on top, the oldest dropped past `max`. */
export function pushCapped<T>(list: readonly T[], item: T, max = UNDO_MAX): T[] {
  return [...list, item].slice(-max);
}

export interface History<T> {
  past: readonly T[];
  future: readonly T[];
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/** Before a change: keep `before` to undo to; redo is gone. */
export function record<T>(h: History<T>, before: T, max = UNDO_MAX): History<T> {
  return { past: pushCapped(h.past, before, max), future: [] };
}

/** Undo from `current`: the state to show, or null when there's nothing to undo. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!h.past.length) return null;
  const state = h.past[h.past.length - 1];
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current] }, state };
}

/** Redo from `current`: the state to show, or null when there's nothing to redo. */
export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!h.future.length) return null;
  const state = h.future[h.future.length - 1];
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1) }, state };
}

/** Forget the last `record` (a change that turned out to change nothing). */
export function dropLast<T>(h: History<T>): History<T> {
  return h.past.length ? { ...h, past: h.past.slice(0, -1) } : h;
}
