/**
 * Pure words for the Deep Page's chrome (cockpit-design §6.1). No React, no
 * DOM, no imports: scripts/deep-renderer-smoke.mjs runs it bundled with
 * esbuild, and StatusBar can take deepStatusLine as it is.
 *
 * - countLabel: the header's quiet "3 answers" / "1 question".
 * - marginNoteLabel: a margin note's small line ("Hester answered", "asking…").
 * - deepStatusLine: the status bar while Deep shows ("Deep · ⇧⌘0 Cockpit",
 *   "2 waiting"), both in --text-3.
 */

export type MarginNoteState = 'pending' | 'unread' | 'read' | 'error';

/** "0 answers", "1 answer", "2 answers". */
export function countLabel(n: number, noun: 'answer' | 'question'): string {
  const k = Math.max(0, Math.floor(n || 0));
  return `${k} ${noun}${k === 1 ? '' : 's'}`;
}

/** The note's first line, in 12px --text-3 above the question. */
export function marginNoteLabel(state: MarginNoteState, queued = false): string {
  if (queued) return 'asking when Hester is back…';
  if (state === 'pending') return 'asking…';
  if (state === 'error') return 'Hester couldn’t answer';
  return 'Hester answered';
}

/** The status bar in Deep: left and right, both quiet. Right is empty when nothing waits. */
export function deepStatusLine(waiting: number): { left: string; right: string } {
  const n = Math.max(0, Math.floor(waiting || 0));
  return { left: 'Deep · ⇧⌘0 Cockpit', right: n ? `${n} waiting` : '' };
}

