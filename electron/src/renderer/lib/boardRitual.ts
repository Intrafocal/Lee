/**
 * boardRitual - the ending ritual on a Board (B5; plan
 * docs/plans/2026-09-28-boards.md §5b). What a Page gives the sheet, from a
 * Board instead. Pure: scripts/board-renderer-smoke.mjs checks it.
 *
 * - Where did you stop? The note you touched last (the topmost), its first line.
 * - Asked: this session's Asks, then any older one still open (running, or
 *   answered and unread), so the sheet can keep or resolve it.
 * - Handed off: this session's hand-offs.
 * - Still open on the Board: note lines that end in "?" and weren't asked
 *   about, each with its note (for Ask and Hand off from the sheet).
 */

import type { BoardItem, BoardNote } from '../../shared/board';
import type { DeepAnswer } from '../../shared/cockpit';
import { STOPPED_AT_MAX } from './deepModel';
import { isHandoff, sessionLists, type SessionAsk, type SessionHandoff, type StillOpen } from './hesterDeep';

/** A still-open line and the note it's on. */
export type BoardStillOpen = StillOpen & { note_id: string };

export interface BoardRitual {
  prefill: string;
  asked: SessionAsk[];
  handedOff: SessionHandoff[];
  stillOpen: BoardStillOpen[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** A note's line without its markdown marks and `[[card|Title]]` links (their titles kept). */
const plain = (line: string) =>
  line
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();

function notesOf(items: readonly BoardItem[]): BoardNote[] {
  return items.filter((it): it is BoardNote => it.kind === 'note' && typeof it.text === 'string' && !!it.text.trim());
}

/** The topmost note's first line: the one you touched last. */
export function boardStoppedAt(items: readonly BoardItem[]): string {
  const notes = notesOf(items);
  if (!notes.length) return '';
  const top = notes.reduce((a, b) => (b.z >= a.z ? b : a));
  const line = top.text.split('\n').map(plain).find(Boolean) ?? '';
  return line.length > STOPPED_AT_MAX ? `${line.slice(0, STOPPED_AT_MAX - 1).trim()}…` : line;
}

type RitualAnswer = Pick<DeepAnswer, 'id' | 'question' | 'status' | 'asked_at' | 'read_at' | 'dismissed_at' | 'kind' | 'surface' | 'handoff'>;

export function boardRitual(items: readonly BoardItem[], all: readonly RitualAnswer[], since: string | null, max = 8): BoardRitual {
  // A Visualize isn't a question: its frame shows it, and it isn't kept or asked again.
  const answers = all.filter((a) => a.kind !== 'visualize');
  const lists = sessionLists(answers, since);
  const asked = [...lists.asked];
  // Older Asks still open: running, or answered and not read yet.
  for (const a of answers) {
    if (a.dismissed_at || isHandoff(a) || asked.some((x) => x.id === a.id)) continue;
    if (a.status === 'queued' || a.status === 'running') asked.push({ id: a.id, question: a.question, state: 'pending', label: 'asking…' });
    else if (a.status === 'done' && !a.read_at) asked.push({ id: a.id, question: a.question, state: 'unread', label: 'answered, unread' });
  }
  const askedQs = new Set(answers.map((a) => norm(a.question ?? '')));
  const stillOpen: BoardStillOpen[] = [];
  const notes = notesOf(items).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of notes) {
    for (const raw of n.text.split('\n')) {
      if (stillOpen.length >= max) break;
      const line = plain(raw);
      if (line.length < 2 || !line.endsWith('?') || askedQs.has(norm(line)) || stillOpen.some((o) => o.text === line)) continue;
      stillOpen.push({ kind: 'question', text: line, sectionText: n.text.trim(), from: 0, to: 0, note_id: n.id });
    }
  }
  return { prefill: boardStoppedAt(items), asked, handedOff: lists.handedOff, stillOpen };
}
