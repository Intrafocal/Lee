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
 *
 * Deep next (docs/plans/2026-09-27-deep-next-contract.md §4):
 * - sectionsOf / sectionAtPos: sections (R4), computed, never stored.
 * - askPlan: a selection's question lines, one Ask each (R2).
 * - sectionMarkState / aggregateMarks / handoffLabel: the margin marks (R5).
 * - mentionQuery / mentionSlug / findMention: `@` mentions (R11).
 * - wikiQuery / parseWikiLinks / rankFiles / quoteBlock / quoteLabel: `[[` (R10).
 * - wrapToggle / codeBlockToggle / TABLE_STARTER / parseTable / touchesActive /
 *   liveHidden: live formatting (R9).
 * - promptAnswered: the Goals Page's margin prompts (R12).
 */

import type { AffordancePattern, Anchor, DeepAnswer } from '../../shared/cockpit';
import type { AttentionItem, AttentionSnapshot } from '../../shared/copilot';

// ---------------------------------------------------------------------------
// Selection action row (§5)
// ---------------------------------------------------------------------------

export type DeepRowAction = 'capture' | 'keep' | 'ask' | 'explore' | 'handoff' | 'table';
export type DeepRowKey = { kind: 'action'; action: DeepRowAction } | { kind: 'escape' } | { kind: 'move'; delta: 1 | -1 };

export interface DeepRowKeyContext {
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

/**
 * The row's keys once ⌘. moved focus into it (the letters show, underlined,
 * only then: R1): a h k c e pick (Ask Hester, Hand off, Keep, Capture,
 * Explore), t inserts a table when nothing is selected; Esc returns, arrows move.
 */
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
    case 'h':
      return { kind: 'action', action: 'handoff' };
    case 't':
      return { kind: 'action', action: 'table' };
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

// ---------------------------------------------------------------------------
// Deep next R4: sections
// ---------------------------------------------------------------------------

export interface PageSection {
  /** Offset of the section's first character (its heading line, or its block's first line). */
  from: number;
  /** Offset just past its last non-blank line. */
  to: number;
  /** The heading's text, or null for a paragraph block. */
  heading: string | null;
  /** 1–6 for a heading section, 0 for a paragraph block. */
  level: number;
  /** doc.slice(from, to): the section word for word, heading included. */
  text: string;
}

/** The section text sent with an Ask (B caps `section_text` at 6 000 chars). */
export const SECTION_TEXT_MAX = 6000;

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

interface ScanLine {
  from: number;
  to: number;
  text: string;
  blank: boolean;
  inFence: boolean;
  heading: { level: number; text: string } | null;
}

function scanLines(md: string): ScanLine[] {
  const out: ScanLine[] = [];
  let off = 0;
  let fence: string | null = null;
  for (const text of md.split('\n')) {
    const from = off;
    const to = off + text.length;
    off = to + 1;
    const f = FENCE_RE.exec(text);
    let inFence = fence != null;
    let heading: ScanLine['heading'] = null;
    if (f) {
      if (fence == null) {
        fence = f[1];
        inFence = true;
      } else if (f[1][0] === fence[0] && f[1].length >= fence.length && !text.trim().slice(f[1].length).trim()) {
        fence = null;
        inFence = true;
      }
    } else if (fence == null) {
      const h = HEADING_RE.exec(text);
      if (h) heading = { level: /^#+/.exec(text)![0].length, text: h[1].trim() };
    }
    out.push({ from, to, text, blank: !inFence && !text.trim(), inFence, heading });
  }
  return out;
}

/**
 * The Page's sections (R4), in document order. A heading section runs to the
 * next heading of the same or a higher level (so sections nest: an `##`
 * inside a `#` is its own section and part of the `#` one). Text that isn't
 * under a heading is split into paragraph blocks at blank lines; a list joins
 * the block before it when that block ends with `:` (or is itself a list).
 * Fenced code is never split and never holds headings.
 */
export function sectionsOf(md: string): PageSection[] {
  const lines = scanLines(md);
  const out: PageSection[] = [];
  const make = (a: number, b: number, heading: string | null, level: number): PageSection => {
    // a..b are line indexes (inclusive); trailing blank lines are trimmed.
    let end = b;
    while (end > a && !lines[end].text.trim()) end--;
    const from = lines[a].from;
    const to = lines[end].to;
    return { from, to, heading, level, text: md.slice(from, to) };
  };

  const firstHeading = lines.findIndex((l) => l.heading);
  const blockEnd = firstHeading < 0 ? lines.length : firstHeading;

  // Paragraph blocks: the whole Page with no headings, or the text before the first.
  type Block = { a: number; b: number; list: boolean };
  const isItem = (i: number) => !lines[i].inFence && LIST_ITEM_RE.test(lines[i].text);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (let i = 0; i < blockEnd; i++) {
    if (lines[i].blank) {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { a: i, b: i, list: isItem(i) };
    else {
      cur.b = i;
      if (isItem(i)) cur.list = true;
    }
  }
  if (cur) blocks.push(cur);
  const merged: Block[] = [];
  for (const blk of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && isItem(blk.a) && (prev.list || lines[prev.b].text.trim().endsWith(':'))) {
      prev.b = blk.b;
      prev.list = true;
    } else merged.push({ ...blk });
  }
  for (const blk of merged) out.push(make(blk.a, blk.b, null, 0));

  // Heading sections.
  for (let i = blockEnd; i < lines.length; i++) {
    const h = lines[i].heading;
    if (!h) continue;
    let j = i + 1;
    while (j < lines.length && !(lines[j].heading && lines[j].heading!.level <= h.level)) j++;
    out.push(make(i, j - 1, h.text, h.level));
  }
  return out.sort((x, y) => x.from - y.from || y.to - x.to);
}

/**
 * The section `pos` is in: the innermost one holding it, else the nearest one
 * before it (blank lines between blocks), else the first; null for an empty Page.
 */
export function sectionAtPos(sections: readonly PageSection[], pos: number): PageSection | null {
  let inner: PageSection | null = null;
  for (const s of sections) if (s.from <= pos && pos <= s.to && (!inner || s.from >= inner.from)) inner = s;
  if (inner) return inner;
  let before: PageSection | null = null;
  for (const s of sections) if (s.from <= pos && (!before || s.from >= before.from)) before = s;
  return before ?? sections[0] ?? null;
}

/** The section text for an Ask or a Hand off at `pos` (≤ SECTION_TEXT_MAX chars). */
export function sectionTextAt(doc: string, pos: number): string {
  return (sectionAtPos(sectionsOf(doc), pos)?.text ?? '').slice(0, SECTION_TEXT_MAX);
}

// ---------------------------------------------------------------------------
// Deep next R2: Ask what's highlighted, as written
// ---------------------------------------------------------------------------

export interface PlannedAsk {
  question: string;
  anchor: Anchor;
  sectionText: string;
}

/**
 * The selection's question lines (trimmed, list/quote/heading marks off,
 * ending in `?`), one Ask each, anchored on that line and carrying its
 * section. Empty when the selection holds no question ("Ask about this…").
 */
export function askPlan(doc: string, from: number, to: number): PlannedAsk[] {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(doc.length, Math.max(from, to));
  if (a === b) return [];
  const sections = sectionsOf(doc);
  const out: PlannedAsk[] = [];
  let lineStart = a;
  for (const raw of doc.slice(a, b).split('\n')) {
    const body = stripLinePrefix(raw);
    if (body.length > 1 && body.endsWith('?')) {
      const at = lineStart + raw.indexOf(body);
      out.push({
        question: body,
        anchor: anchorFor(doc, at, at + body.length),
        sectionText: (sectionAtPos(sections, at)?.text ?? body).slice(0, SECTION_TEXT_MAX),
      });
    }
    lineStart += raw.length + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deep next R5: the margin marks
// ---------------------------------------------------------------------------

export type SectionMarkState = 'waiting' | 'unread' | 'error' | 'pending' | 'running' | 'read' | 'done';

/** Most urgent first: a hand-off waiting on you, then a new answer, … a finished hand-off last. */
export const MARK_URGENCY: readonly SectionMarkState[] = ['waiting', 'unread', 'error', 'pending', 'running', 'read', 'done'];

/**
 * An answer's or hand-off's mark (R5). Asks: pending, unread, read (or
 * error). Hand-offs: running (the phosphor agent mark), waiting (ember),
 * done (hollow agent mark); a result in review you haven't opened reads as
 * a new answer.
 */
export function sectionMarkState(a: Pick<DeepAnswer, 'status' | 'read_at' | 'kind' | 'handoff'>): SectionMarkState {
  if (a.kind === 'handoff' || a.handoff) {
    const st = a.handoff?.state ?? (isPending(a) ? 'running' : a.status === 'done' ? 'done' : 'error');
    if (st === 'launching' || st === 'running') return 'running';
    if (st === 'waiting') return 'waiting';
    if (st === 'review') return a.read_at ? 'done' : 'unread';
    if (st === 'done') return 'done';
    return 'error';
  }
  return markerState(a);
}

export interface SectionMark {
  /** Stable while the section keeps its first item: that item's id. */
  key: string;
  /** Where the mark sits: the section's first line. */
  from: number;
  heading: string | null;
  /** The most urgent state among the section's items. */
  state: SectionMarkState;
  count: number;
  /** The section's items, most urgent first (input order within a state). */
  ids: string[];
}

/**
 * One mark per section with items: each item goes to the section its
 * re-anchored position is in; the mark shows the most urgent state and a count.
 */
export function aggregateMarks(
  sections: readonly PageSection[],
  items: ReadonlyArray<{ id: string; state: SectionMarkState; pos: number }>,
): SectionMark[] {
  const groups = new Map<number, { from: number; heading: string | null; items: Array<{ id: string; state: SectionMarkState; i: number }> }>();
  items.forEach((it, i) => {
    const s = sectionAtPos(sections, it.pos);
    const from = s ? s.from : 0;
    const g = groups.get(from) ?? { from, heading: s ? s.heading : null, items: [] };
    g.items.push({ id: it.id, state: it.state, i });
    groups.set(from, g);
  });
  const rank = (st: SectionMarkState) => MARK_URGENCY.indexOf(st);
  return Array.from(groups.values())
    .sort((x, y) => x.from - y.from)
    .map((g) => {
      const sorted = [...g.items].sort((x, y) => rank(x.state) - rank(y.state) || x.i - y.i);
      return { key: g.items[0].id, from: g.from, heading: g.heading, state: sorted[0].state, count: g.items.length, ids: sorted.map((x) => x.id) };
    });
}

const HANDOFF_KIND_LABEL: Record<string, string> = { spike: 'Spike', docs: 'Docs', research: 'Research' };
const HANDOFF_STATE_LABEL: Record<string, string> = {
  launching: 'starting…',
  running: 'working',
  waiting: 'waiting on you',
  review: 'result in',
  done: 'done',
  error: 'stopped',
};

/** A hand-off's small line in the margin: "Spike · working", "Research · waiting on you". */
export function handoffLabel(h: { kind: string; state: string } | null | undefined): string {
  if (!h) return 'Hand-off';
  return `${HANDOFF_KIND_LABEL[h.kind] ?? 'Hand-off'} · ${HANDOFF_STATE_LABEL[h.state] ?? h.state}`;
}

// ---------------------------------------------------------------------------
// Deep next R11: @ mentions
// ---------------------------------------------------------------------------

export interface MentionTargetLike {
  id: string;
  label: string;
  kind: 'hester' | 'provider' | 'handoff';
}

/** The word a target is mentioned by: "Board research" → "board-research". */
export function mentionSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** The `@partial` being typed at the end of `before` (the line up to the cursor), or null. */
export function mentionQuery(before: string): { query: string; start: number } | null {
  const m = /(^|[\s(])@([\w.-]*)$/.exec(before);
  if (!m) return null;
  return { query: m[2], start: m.index + m[1].length };
}

const KIND_ORDER = { hester: 0, provider: 1, handoff: 2 } as const;

/** The @ list: Hester, the providers, then this exploration's hand-offs, filtered by what's typed. */
export function mentionMatches<T extends MentionTargetLike>(query: string, targets: readonly T[]): T[] {
  const q = query.toLowerCase();
  return targets
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !q || mentionSlug(t.label).startsWith(q) || t.id.toLowerCase().startsWith(q) || t.label.toLowerCase().includes(q))
    .sort((x, y) => KIND_ORDER[x.t.kind] - KIND_ORDER[y.t.kind] || x.i - y.i)
    .map(({ t }) => t);
}

/**
 * The first mention of a known target in a line, with the line's text
 * without it (what gets sent), or null. `@` must start the line or follow a
 * space or `(`, so an email address isn't a mention.
 */
export function findMention<T extends MentionTargetLike>(
  line: string,
  targets: readonly T[],
): { target: T; from: number; to: number; text: string } | null {
  const re = /(^|[\s(])@([\w.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const word = m[2].replace(/[.-]+$/, '');
    const token = word.toLowerCase();
    const target = targets.find((t) => mentionSlug(t.label) === token || t.id.toLowerCase() === token);
    if (target) {
      const from = m.index + m[1].length;
      let to = from + 1 + word.length;
      // Punctuation that only attached the mention ("@claude:", "…, @pi.") goes with it.
      if (/[,:;.]/.test(line[to] ?? '')) to++;
      const text = stripLinePrefix((line.slice(0, from) + line.slice(to)).replace(/\s+/g, ' ')).replace(/^[,:;]\s*/, '').trim();
      return { target, from, to, text };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deep next R10: [[ file references
// ---------------------------------------------------------------------------

/** The `[[partial` being typed at the end of `before`, or null (closed, or on another line). */
export function wikiQuery(before: string): { query: string; start: number } | null {
  const m = /\[\[([^[\]\n|#]*)$/.exec(before);
  return m ? { query: m[1], start: m.index } : null;
}

export interface WikiLink {
  /** Offsets within the line. */
  from: number;
  to: number;
  path: string;
  /** 1-based, inclusive; null for a whole-file link. */
  lines: [number, number] | null;
  label: string | null;
}

/** `[[path]]`, `[[path#L3-L9]]`, `[[path#L3-L9|label]]`, `[[path|label]]` in a line. */
export function parseWikiLinks(line: string): WikiLink[] {
  const out: WikiLink[] = [];
  const re = /\[\[([^[\]\n|#]+)(?:#L(\d+)(?:-L?(\d+))?)?(?:\|([^[\]\n]+))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const a = m[2] ? parseInt(m[2], 10) : null;
    const b = m[3] ? parseInt(m[3], 10) : a;
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      path: m[1].trim(),
      lines: a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : null,
      label: m[4]?.trim() || null,
    });
  }
  return out;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** What a link shows when it isn't being edited: its label, else the file's name. */
export function wikiDisplay(link: Pick<WikiLink, 'path' | 'label'>): string {
  return link.label || basename(link.path);
}

const isMarkdownPath = (p: string) => /\.(md|mdx|markdown)$/i.test(p);

/** Lower is better; null when `q` isn't a subsequence of the path. */
function fuzzyScore(q: string, path: string): number | null {
  if (!q) return 0;
  const p = path.toLowerCase();
  const bi = basename(p).indexOf(q);
  if (bi >= 0) return bi;
  const pi = p.indexOf(q);
  if (pi >= 0) return 100 + pi;
  let gaps = 0;
  let j = 0;
  for (let i = 0; i < p.length && j < q.length; i++) {
    if (p[i] === q[j]) j++;
    else if (j > 0) gaps++;
  }
  return j === q.length ? 1000 + gaps : null;
}

/** The `[[` picker's list: fuzzy over the paths, markdown first, then everything else. */
export function rankFiles(query: string, files: readonly string[], limit = 50): string[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ p: string; md: number; s: number; i: number }> = [];
  files.forEach((p, i) => {
    const s = fuzzyScore(q, p);
    if (s != null) scored.push({ p, md: isMarkdownPath(p) ? 0 : 1, s, i });
  });
  scored.sort((a, b) => a.md - b.md || a.s - b.s || a.p.length - b.p.length || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.p);
}

/** The blockquote Quote it inserts: the text, then `> — [[path#La-Lb|label]]`. */
export function quoteBlock(text: string, path: string, lines: [number, number], label: string): string {
  const body = text
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
  return `${body}\n> — [[${path}#L${lines[0]}-L${lines[1]}|${label}]]`;
}

/**
 * A quote's short label: the file's name without extension, then `§` and the
 * nearest heading at or above the first quoted line (its number when it has
 * one: "## 6. Answers" → "§6"): "14-Deep-Work §6".
 */
export function quoteLabel(path: string, source: string, startLine: number): string {
  const stem = basename(path).replace(/\.[^.]+$/, '') || path;
  const lines = source.split('\n');
  for (let i = Math.min(startLine, lines.length) - 1; i >= 0; i--) {
    const h = HEADING_RE.exec(lines[i]);
    if (!h) continue;
    const text = h[1].trim();
    const num = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(text);
    const tag = num ? num[1] : text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
    return `${stem} §${tag}`;
  }
  return stem;
}

/** 1-based line numbers of a range in a text. */
export function lineRangeOf(text: string, from: number, to: number): [number, number] {
  const a = Math.max(0, Math.min(from, to));
  let b = Math.min(text.length, Math.max(from, to));
  // A selection that ends at the start of a line doesn't include that line.
  if (b > a && text[b - 1] === '\n') b--;
  const count = (n: number) => text.slice(0, n).split('\n').length;
  return [count(a), count(b)];
}

// ---------------------------------------------------------------------------
// Deep next R9: live formatting
// ---------------------------------------------------------------------------

export interface TextEdit {
  changes: Array<{ from: number; to: number; insert: string }>;
  /** The selection afterwards, in the new document. */
  selFrom: number;
  selTo: number;
}

function runOf(doc: string, pos: number, ch: string, dir: 1 | -1): number {
  let n = 0;
  for (let i = dir === 1 ? pos : pos - 1; i >= 0 && i < doc.length && doc[i] === ch; i += dir) n++;
  return n;
}

/** Whether runs of the marker's character on both sides make `marker` a wrap (`*` inside `**` isn't). */
function wrappedBy(before: number, after: number, marker: string): boolean {
  if (marker.length === 2) return before >= 2 && after >= 2;
  if (marker === '*' || marker === '_') return before % 2 === 1 && after % 2 === 1;
  return before >= 1 && after >= 1;
}

/**
 * ⌘B / ⌘I / ⌘⇧K: wrap the selection in `marker`, or unwrap it when it's
 * already wrapped (outside or inside the selection). Whitespace at the
 * selection's ends stays outside. An empty selection inserts the pair with
 * the cursor between (or steps out of an empty pair).
 */
export function wrapToggle(doc: string, from: number, to: number, marker: string): TextEdit {
  let a = Math.max(0, Math.min(from, to));
  let b = Math.min(doc.length, Math.max(from, to));
  const m = marker.length;
  const ch = marker[0];
  if (a === b) {
    if (doc.slice(a - m, a) === marker && doc.slice(a, a + m) === marker && wrappedBy(runOf(doc, a, ch, -1), runOf(doc, a, ch, 1), marker)) {
      return { changes: [{ from: a - m, to: a + m, insert: '' }], selFrom: a - m, selTo: a - m };
    }
    return { changes: [{ from: a, to: a, insert: marker + marker }], selFrom: a + m, selTo: a + m };
  }
  while (a < b && /\s/.test(doc[a])) a++;
  while (b > a && /\s/.test(doc[b - 1])) b--;
  // Wrapped outside the selection: **|text|**
  if (doc.slice(a - m, a) === marker && doc.slice(b, b + m) === marker && wrappedBy(runOf(doc, a, ch, -1), runOf(doc, b, ch, 1), marker)) {
    return { changes: [{ from: a - m, to: a, insert: '' }, { from: b, to: b + m, insert: '' }], selFrom: a - m, selTo: b - m };
  }
  // Wrapped inside it: |**text**|
  const inner = doc.slice(a, b);
  if (inner.length >= 2 * m + 1 && inner.startsWith(marker) && inner.endsWith(marker)) {
    if (wrappedBy(runOf(inner, 0, ch, 1), runOf(inner, inner.length, ch, -1), marker)) {
      return { changes: [{ from: a, to: a + m, insert: '' }, { from: b - m, to: b, insert: '' }], selFrom: a, selTo: b - 2 * m };
    }
  }
  return { changes: [{ from: a, to: a, insert: marker }, { from: b, to: b, insert: marker }], selFrom: a + m, selTo: b + m };
}

/**
 * ⌘⌥C: fence the selection's lines as a code block, or unfence them when
 * they're already fenced. With nothing on the line, an empty block with the
 * cursor inside.
 */
export function codeBlockToggle(doc: string, from: number, to: number): TextEdit {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(doc.length, Math.max(from, to));
  const lineStart = doc.lastIndexOf('\n', a - 1) + 1;
  let lineEnd = doc.indexOf('\n', b > a && doc[b - 1] === '\n' ? b - 1 : b);
  if (lineEnd < 0) lineEnd = doc.length;
  const prevStart = lineStart > 0 ? doc.lastIndexOf('\n', lineStart - 2) + 1 : -1;
  const prevLine = prevStart >= 0 ? doc.slice(prevStart, lineStart - 1) : null;
  let nextEnd = -1;
  if (lineEnd < doc.length) {
    nextEnd = doc.indexOf('\n', lineEnd + 1);
    if (nextEnd < 0) nextEnd = doc.length;
  }
  const nextLine = nextEnd >= 0 ? doc.slice(lineEnd + 1, nextEnd) : null;
  if (prevLine != null && nextLine != null && /^\s*```/.test(prevLine) && /^\s*```\s*$/.test(nextLine)) {
    const removed = lineStart - prevStart;
    return {
      changes: [{ from: prevStart, to: lineStart, insert: '' }, { from: lineEnd, to: nextEnd, insert: '' }],
      selFrom: a - removed,
      selTo: b - removed,
    };
  }
  if (!doc.slice(lineStart, lineEnd).trim()) {
    return { changes: [{ from: lineStart, to: lineEnd, insert: '```\n\n```' }], selFrom: lineStart + 4, selTo: lineStart + 4 };
  }
  return {
    changes: [{ from: lineStart, to: lineStart, insert: '```\n' }, { from: lineEnd, to: lineEnd, insert: '\n```' }],
    selFrom: a + 4,
    selTo: b + 4,
  };
}

/** Insert table's 3×2 starter (R9). */
export const TABLE_STARTER = '| Column | Column | Column |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';

/** Insert table at `pos`: its own block (on an empty line, or after the cursor's line), first header cell selected. */
export function tableInsertion(doc: string, pos: number): TextEdit {
  const p = Math.max(0, Math.min(pos, doc.length));
  let lineEnd = doc.indexOf('\n', p);
  if (lineEnd < 0) lineEnd = doc.length;
  const lineStart = doc.lastIndexOf('\n', p - 1) + 1;
  const emptyLine = !doc.slice(lineStart, lineEnd).trim();
  const at = emptyLine ? lineStart : lineEnd;
  const lead = emptyLine ? (lineStart === 0 || doc.slice(0, lineStart).endsWith('\n\n') ? '' : '\n') : '\n\n';
  const rest = doc.slice(lineEnd);
  const tail = !rest ? '\n' : rest.startsWith('\n\n') || !rest.trim() ? '' : '\n';
  const insert = `${lead}${TABLE_STARTER}${tail}`;
  const cell = at + lead.length + 2;
  return { changes: [{ from: at, to: lineEnd, insert }], selFrom: cell, selTo: cell + 'Column'.length };
}

export interface ParsedTable {
  head: string[];
  align: Array<'left' | 'center' | 'right' | null>;
  rows: string[][];
}

function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** A GFM table's cells (for rendering it while the cursor is outside), or null. */
export function parseTable(text: string): ParsedTable | null {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2 || !lines[0].includes('|')) return null;
  const delim = tableCells(lines[1]);
  if (!delim.length || !delim.every((c) => /^:?-+:?$/.test(c))) return null;
  const head = tableCells(lines[0]);
  const align = delim.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
  const rows = lines.slice(2).map((l) => {
    const cells = tableCells(l);
    return head.map((_, i) => cells[i] ?? '');
  });
  return { head, align, rows };
}

/** Whether [from, to] touches any of the active (cursor or selection) line ranges. */
export function touchesActive(from: number, to: number, active: ReadonlyArray<readonly [number, number]>): boolean {
  return active.some(([a, b]) => a <= to && b >= from);
}

/**
 * The live-formatting decision (R9): hide a markdown mark (a heading's `#`,
 * `**`, `*`, inline code's backticks, a link's `[`, `](url)`, a quote's `>`,
 * `~~`) unless it's on a line the cursor or selection touches. Code fences,
 * list bullets and images stay visible.
 */
export function liveHidden(node: string, parent: string | null, from: number, to: number, active: ReadonlyArray<readonly [number, number]>): boolean {
  let hideable = false;
  switch (node) {
    case 'HeaderMark':
    case 'EmphasisMark':
    case 'QuoteMark':
    case 'StrikethroughMark':
      hideable = true;
      break;
    case 'CodeMark':
      hideable = parent === 'InlineCode';
      break;
    case 'LinkMark':
    case 'URL':
      hideable = parent === 'Link';
      break;
  }
  return hideable && !touchesActive(from, to, active);
}

// ---------------------------------------------------------------------------
// Deep next R12: margin prompts
// ---------------------------------------------------------------------------

const normWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * A margin prompt is answered once a heading that matches it (either is a
 * case-insensitive substring of the other, punctuation ignored) has text
 * under it.
 */
export function promptAnswered(prompt: string, sections: readonly PageSection[]): boolean {
  const p = normWords(prompt);
  if (!p) return false;
  return sections.some((s) => {
    if (s.heading == null) return false;
    const h = normWords(s.heading);
    if (h.length < 3 || !(p.includes(h) || h.includes(p))) return false;
    return !!s.text.split('\n').slice(1).join('\n').trim();
  });
}
