/**
 * Pure model for the Deep surface (Deep D1 §4, §5, §7, §9). No React, no
 * DOM, no window: everything here is deterministic so the smoke test
 * (scripts/deep-renderer-smoke.mjs) can run it bundled with esbuild.
 *
 * - deepRowKey: the selection action row's letters (§5), in the style of keyAction.
 * - affordanceFor: the typing affordances for `?`, URLs and later:/someday: (§7).
 * - lastSentence: "Where did you stop?" for the ending ritual (§9).
 * - anchorFor / locateAnchor / sectionAt: Ask anchors and their re-location (§3.3, §4.2).
 * - answerInsertion: Insert's blockquote below the anchor's paragraph (§4.2).
 * - answersTray / pageMirrorKey / deepMemoryKey and a few small helpers.
 */

import type { AffordancePattern, Anchor, DeepAnswer } from '../../shared/cockpit';
import type { AttentionItem, AttentionSnapshot } from '../../shared/copilot';

// ---------------------------------------------------------------------------
// Selection action row (§5)
// ---------------------------------------------------------------------------

export type DeepRowAction = 'capture' | 'keep' | 'ask' | 'explore';
export type DeepRowKey = { kind: 'action'; action: DeepRowAction } | { kind: 'escape' } | { kind: 'move'; delta: 1 | -1 };

export interface DeepRowKeyContext {
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

/** The row's keys once ⌘. moved focus into it: c k a e pick, Esc returns, arrows move. */
export function deepRowKey(key: string, ctx: DeepRowKeyContext = {}): DeepRowKey | null {
  if (key === 'Escape') return { kind: 'escape' };
  if (ctx.meta || ctx.ctrl || ctx.alt) return null;
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'c':
      return { kind: 'action', action: 'capture' };
    case 'k':
      return { kind: 'action', action: 'keep' };
    case 'a':
      return { kind: 'action', action: 'ask' };
    case 'e':
      return { kind: 'action', action: 'explore' };
    case 'ArrowRight':
      return { kind: 'move', delta: 1 };
    case 'ArrowLeft':
      return { kind: 'move', delta: -1 };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Typing affordances (§7)
// ---------------------------------------------------------------------------

export type AffordanceOption =
  | { kind: 'ask'; label: 'Ask'; question: string }
  | { kind: 'mark_question'; label: 'Mark open question'; text: string }
  | { kind: 'keep_link'; label: 'Keep as reference'; url: string; title?: string }
  | { kind: 'capture'; label: 'Capture'; text: string };

export interface Affordance {
  pattern: AffordancePattern;
  options: AffordanceOption[];
}

/** An affordance shows after the cursor stays on a matching line this long. */
export const AFFORDANCE_DELAY_MS = 400;
/** ...and fades after this long. */
export const AFFORDANCE_FADE_MS = 5000;

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/g;
const LATER_RE = /^(?:[-*+]\s+)?(later|someday):\s*(.*)$/i;
/** Markdown decoration at the start of a line: list bullets, headings, quotes, task boxes. */
const LINE_PREFIX_RE = /^(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/;

function stripLinePrefix(line: string): string {
  return line.replace(LINE_PREFIX_RE, '').trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** The URLs in a line, in order. */
export function urlsIn(line: string): string[] {
  return line.match(URL_RE) ?? [];
}

/** The text of a markdown link `[text](url)` around this URL, if any. */
export function markdownLinkTitle(line: string, url: string): string | undefined {
  const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\[([^\\]]+)\\]\\(\\s*${esc}\\s*\\)`).exec(line);
  const t = m?.[1]?.trim();
  return t ? t : undefined;
}

/** True when the text is exactly one http(s) URL (Keep makes a `link` reference). */
export function isBareUrl(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  const m = t.match(URL_RE);
  return !!m && m.length === 1 && m[0] === t;
}

/**
 * The affordance for the cursor's line, or null. `pasted` is true when the
 * line's last change was a paste: a pasted URL anywhere in the line counts;
 * a typed one only once it's finished (at the end of the line).
 */
export function affordanceFor(line: string, pasted: boolean): Affordance | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const later = LATER_RE.exec(trimmed);
  if (later) {
    const rest = later[2].trim();
    return rest ? { pattern: 'later', options: [{ kind: 'capture', label: 'Capture', text: rest }] } : null;
  }

  const body = stripLinePrefix(trimmed);
  if (body.endsWith('?') && wordCount(body) >= 3) {
    return {
      pattern: 'question',
      options: [
        { kind: 'ask', label: 'Ask', question: body },
        { kind: 'mark_question', label: 'Mark open question', text: body },
      ],
    };
  }

  const urls = urlsIn(trimmed);
  if (urls.length) {
    let url: string | null = null;
    if (pasted) url = urls[urls.length - 1];
    else {
      // Typed: the URL is the last thing on the line (a markdown link's `)`,
      // a `>` or a closing full stop may follow it).
      const last = urls[urls.length - 1];
      const tail = trimmed.slice(trimmed.lastIndexOf(last) + last.length);
      if (/^[)>\]]*[.,;:!]?$/.test(tail)) url = last;
    }
    if (url) {
      const title = markdownLinkTitle(trimmed, url);
      return { pattern: 'url', options: [{ kind: 'keep_link', label: 'Keep as reference', url, ...(title ? { title } : {}) }] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ending ritual: "Where did you stop?" (§9)
// ---------------------------------------------------------------------------

export const STOPPED_AT_MAX = 1000;
const BOUNDARY = /[.?!\n]/;

/**
 * The sentence around `pos` (the last edited position): from the previous
 * `.`, `?`, `!` or newline to the next one, including its closing
 * punctuation. If that is blank (the cursor sits just past a full stop or on
 * an empty line) the sentence before it is used. At most 1 000 chars (the end
 * is kept: it's where you stopped).
 */
export function lastSentence(text: string, pos: number = text.length): string {
  let p = Math.max(0, Math.min(pos, text.length));
  while (p >= 0) {
    let start = p;
    while (start > 0 && !BOUNDARY.test(text[start - 1])) start--;
    let end = p;
    while (end < text.length && !BOUNDARY.test(text[end])) end++;
    const closing = end < text.length && text[end] !== '\n' ? text[end] : '';
    const s = (text.slice(start, end) + closing).trim();
    if (s.replace(/[.?!]/g, '').trim()) return s.length > STOPPED_AT_MAX ? s.slice(s.length - STOPPED_AT_MAX).trim() : s;
    if (start === 0) return '';
    p = start - 1;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Anchors (§3.3, §4.2)
// ---------------------------------------------------------------------------

export const ANCHOR_QUOTE_MAX = 500;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** The nearest markdown heading at or before `pos`, or null. */
export function sectionAt(text: string, pos: number): string | null {
  const p = Math.max(0, Math.min(pos, text.length));
  const lineEnd = text.indexOf('\n', p);
  // Up to the end of the line holding pos: a heading line is its own section.
  const lines = text.slice(0, lineEnd < 0 ? text.length : lineEnd).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

/** An anchor for a selection (or a line): the quote, where it was and its section. */
export function anchorFor(text: string, from: number, to: number): Anchor {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(text.length, Math.max(from, to));
  const quote = text.slice(a, b).trim().slice(0, ANCHOR_QUOTE_MAX);
  if (!quote) return { kind: 'none' };
  const lead = text.slice(a, b).length - text.slice(a, b).trimStart().length;
  return { kind: 'page', quote, offset: a + lead, section: sectionAt(text, a) };
}

export type AnchorVia = 'quote' | 'section' | 'top';

/**
 * Where an anchor sits in the current text: the occurrence of its quote
 * nearest the stored offset; else the start of its section's heading; else
 * the top.
 */
export function locateAnchor(text: string, anchor: Anchor | null | undefined): { pos: number; via: AnchorVia } {
  if (!anchor || anchor.kind !== 'page') return { pos: 0, via: 'top' };
  if (anchor.quote) {
    let best = -1;
    let i = text.indexOf(anchor.quote);
    while (i >= 0) {
      if (best < 0 || Math.abs(i - anchor.offset) < Math.abs(best - anchor.offset)) best = i;
      if (i > anchor.offset) break; // later matches are only further away
      i = text.indexOf(anchor.quote, i + 1);
    }
    if (best >= 0) return { pos: best, via: 'quote' };
  }
  if (anchor.section) {
    const want = anchor.section.trim();
    let off = 0;
    for (const line of text.split('\n')) {
      const m = HEADING_RE.exec(line);
      if (m && m[1].trim() === want) return { pos: off, via: 'section' };
      off += line.length + 1;
    }
  }
  return { pos: 0, via: 'top' };
}

/** ≤ max chars of text around a selection, for a capture's source context. */
export function contextAround(text: string, from: number, to: number, max = 300): string {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(text.length, Math.max(from, to));
  const room = Math.max(0, max - (b - a));
  const s = Math.max(0, a - Math.floor(room / 2));
  const e = Math.min(text.length, b + Math.ceil(room / 2));
  return text.slice(s, e).slice(0, max);
}

// ---------------------------------------------------------------------------
// Insert (§4.2)
// ---------------------------------------------------------------------------

/** The date on Insert's attribution line: YYYY-MM-DD, local time. */
export function attributionDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The change Insert makes: the answer as a blockquote with `> — Hester,
 * <date>`, placed after the paragraph that holds `pos` (the end of the
 * paragraph is the next blank line, or the end of the Page).
 */
export function answerInsertion(text: string, pos: number, answer: string, date: string): { from: number; insert: string } {
  const p = Math.max(0, Math.min(pos, text.length));
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = p;
  const m = blank.exec(text);
  const from = m ? m.index : text.length;
  const quoted = answer
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
  const lead = from === 0 ? '' : text.slice(0, from).endsWith('\n') ? '\n' : '\n\n';
  const tail = from >= text.length ? '\n' : '';
  return { from, insert: `${lead}${quoted}\n>\n> — Hester, ${date}${tail}` };
}

// ---------------------------------------------------------------------------
// Answers tray, memory keys, small helpers
// ---------------------------------------------------------------------------

export function isPending(a: Pick<DeepAnswer, 'status'>): boolean {
  return a.status === 'queued' || a.status === 'running';
}

export function isUnread(a: Pick<DeepAnswer, 'status' | 'read_at' | 'dismissed_at'>): boolean {
  return a.status === 'done' && !a.read_at && !a.dismissed_at;
}

/** The Answers tray's label: "N answers" while some are unread, "N asking…" while pending. */
export function answersTray(answers: ReadonlyArray<Pick<DeepAnswer, 'status' | 'read_at' | 'dismissed_at'>>): {
  unread: number;
  pending: number;
  label: string;
} {
  const live = answers.filter((a) => !a.dismissed_at);
  const unread = live.filter(isUnread).length;
  const pending = live.filter(isPending).length;
  const parts: string[] = [];
  if (unread) parts.push(`${unread} answer${unread === 1 ? '' : 's'}`);
  if (pending) parts.push(`${pending} asking…`);
  return { unread, pending, label: parts.length ? parts.join(' · ') : 'Answers' };
}

/** The margin marker for an answer: filled while unread, hollow once read, a spinner while pending. */
export function markerState(a: Pick<DeepAnswer, 'status' | 'read_at'>): 'pending' | 'unread' | 'read' | 'error' {
  if (isPending(a)) return 'pending';
  if (a.status === 'error' || a.status === 'interrupted') return 'error';
  return a.read_at ? 'read' : 'unread';
}

/** localStorage key of the Page's crash mirror (§4.3). */
export function pageMirrorKey(workspace: string, id: string): string {
  return `lee:deep:page:${workspace}:${id}`;
}

/** localStorage key of this workspace's Deep memory (§4.4). */
export function deepMemoryKey(workspace: string): string {
  return `lee:deep:${workspace}`;
}

/** Case-insensitive title match for the opener's field (§8.2). */
export function matchExploration<T extends { title: string }>(text: string, explorations: readonly T[]): T | null {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  return explorations.find((e) => e.title.trim().toLowerCase() === want) ?? null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Untitled · Sep 26": the Blank page's title (§8.2). */
export function untitledTitle(d: Date): string {
  return `Untitled · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Save retry backoff: 2 s, 4 s, 8 s … capped at 60 s. */
export function saveBackoffMs(attempt: number): number {
  return Math.min(60000, 2000 * 2 ** Math.max(0, attempt));
}

// ---------------------------------------------------------------------------
// Attention while deep (§4.1, 14 §3.3): the wake line and the neutral count
// ---------------------------------------------------------------------------

/** The first open item you asked to be woken for (item.wake or the away wake lists), or null. */
export function wokenItem(snapshot: Pick<AttentionSnapshot, 'items' | 'away'> | null | undefined): AttentionItem | null {
  if (!snapshot) return null;
  const ids = snapshot.away?.wake_item_ids ?? [];
  const ptys = snapshot.away?.wake_pty_ids ?? [];
  return (
    snapshot.items.find(
      (i) =>
        i.state === 'open' &&
        i.severity !== 'ambient' &&
        (i.wake || ids.includes(i.id) || (i.source.pty_id != null && ptys.includes(i.source.pty_id))),
    ) ?? null
  );
}

/** Open items that need you (blocking or needs-you), for a neutral "N waiting". */
export function waitingCount(snapshot: Pick<AttentionSnapshot, 'items'> | null | undefined): number {
  if (!snapshot) return 0;
  return snapshot.items.filter((i) => i.state === 'open' && i.severity !== 'ambient' && i.kind !== 'summary').length;
}
