/**
 * tetherModel - Send to Lee's pure logic in the renderer
 * (docs/plans/2026-09-28-tether-review-voice.md §4.3, §4.4). No DOM, no
 * fetch, so scripts/tether-send-smoke.mjs checks it directly:
 *
 * - checkSend: what a send may do here (submit only for tabs and Hester, and
 *   only with text; never for a Page or a Board).
 * - pageInsertion / findInsertion: a send as its own paragraph at the Page's
 *   cursor (the end when the Page isn't open), and finding it again for Undo
 *   while it's unchanged.
 * - imageMarkdown / parsePageImages: `![caption](assets/<file>)` in and out.
 * - inboxFileName / tabPasteText: an image for a tab goes to
 *   ~/.lee/inbox/<send_id>-<n>.<ext> and its path is pasted with the text.
 * - chipLine: the status bar's "From your phone: photo → Taxonomy".
 * - boardSendItems: a send on a Board (B5): images side by side mid-view (to
 *   the right of everything when the Board isn't open), a caption pinned to
 *   its image, the text as one note under them.
 * - buildSendTargets: what this window can take, for GET /tether/targets.
 */

import type { BoardItem, BoardNote } from '../../shared/board';
import { cardKindOf } from '../../shared/desk';
import type { SendItem, SendTarget, SendTargets } from '../../shared/tether';
import { boardBounds, imageSize, makeNote, newItemId, nextZ, pinFor, NOTE_H, NOTE_W } from './boardModel';
import type { Point, Size } from './canvas/camera';

// ---------------------------------------------------------------------------
// What a send may do
// ---------------------------------------------------------------------------

export type SendCheck = { ok: true } | { ok: false; error: string };

export function hasText(items: readonly SendItem[]): boolean {
  return items.some((i) => i.kind === 'text' && i.text.trim().length > 0);
}

/**
 * Main validated the request; this is the renderer's own guard, so a send it
 * can't honour fails plainly instead of doing half of it. Submit (Send) is for
 * tabs and Hester only; Hester needs text, a tab takes an image alone (§4.2).
 * A Page and a Board only take Deliver.
 */
export function checkSend(target: SendTarget, items: readonly SendItem[], submit: boolean | undefined): SendCheck {
  if (!items.length) return { ok: false, error: 'no_items' };
  // A tab takes Send with only an image (its path, then Enter); Hester needs text.
  const imageForTab = target.kind === 'tab' && items.some((i) => i.kind === 'image');
  if (submit && (target.kind === 'page' || target.kind === 'board' || (!hasText(items) && !imageForTab))) return { ok: false, error: 'submit_not_allowed' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// A Page: its own paragraph, and Undo
// ---------------------------------------------------------------------------

export interface Insertion {
  /** Where the insert goes in the doc. */
  from: number;
  /** What's inserted, blank lines around the text included. */
  insert: string;
  /** Where the text itself starts (and ends): the caret goes to `textTo`. */
  textFrom: number;
  textTo: number;
}

/**
 * `text` as its own paragraph at `cursor`: after the cursor's line (a send
 * never splits a line), with a blank line before and after unless one is
 * already there. `cursor` null means the end of the Page.
 */
export function pageInsertion(doc: string, cursor: number | null, text: string): Insertion {
  const body = text.replace(/^\n+|\s+$/g, '');
  let from = cursor == null ? doc.length : Math.max(0, Math.min(cursor, doc.length));
  const eol = doc.indexOf('\n', from);
  from = eol < 0 ? doc.length : eol;
  const before = doc.slice(0, from);
  const after = doc.slice(from);
  const lead = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after.length === 0 ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = `${lead}${body}${tail}`;
  return { from, insert, textFrom: from + lead.length, textTo: from + lead.length + body.length };
}

/**
 * Where an earlier insertion is now, while it's unchanged: at its place, else
 * the one place its text appears (edits above it moved it). Null when it was
 * edited, or appears more than once (Undo can't tell which).
 */
export function findInsertion(doc: string, ins: Pick<Insertion, 'from' | 'insert'>): { from: number; to: number } | null {
  const n = ins.insert.length;
  if (!n) return null;
  // Whole lines only: text typed onto either end changed it.
  const whole = (at: number) =>
    doc.slice(at, at + n) === ins.insert &&
    (at === 0 || ins.insert.startsWith('\n') || doc[at - 1] === '\n') &&
    (at + n === doc.length || ins.insert.endsWith('\n') || doc[at + n] === '\n');
  if (whole(ins.from)) return { from: ins.from, to: ins.from + n };
  const found: number[] = [];
  for (let at = doc.indexOf(ins.insert); at >= 0; at = doc.indexOf(ins.insert, at + 1)) if (whole(at)) found.push(at);
  return found.length === 1 ? { from: found[0], to: found[0] + n } : null;
}

/** `doc` with the insertion taken out, or null when it can't be found unchanged. */
export function removeInsertion(doc: string, ins: Pick<Insertion, 'from' | 'insert'>): string | null {
  const r = findInsertion(doc, ins);
  return r ? doc.slice(0, r.from) + doc.slice(r.to) : null;
}

// ---------------------------------------------------------------------------
// Images on a Page (§4.4)
// ---------------------------------------------------------------------------

/** A caption safe inside `![…]`: one line, no brackets. */
export function imageCaption(caption: string | undefined): string {
  return (caption ?? '').replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim();
}

/** `![caption](assets/<name>)`. */
export function imageMarkdown(caption: string | undefined, path: string): string {
  return `![${imageCaption(caption)}](${path})`;
}

export interface PageImage {
  /** Offsets within the line. */
  from: number;
  to: number;
  alt: string;
  /** `assets/<name>` as written. */
  path: string;
  name: string;
}

const PAGE_IMAGE_RE = /!\[([^\]\n]*)\]\((assets\/([A-Za-z0-9._-]+\.(?:png|jpe?g)))\)/g;

/** The Page's own images on a line: `![…](assets/<name>.png|jpg)`. Other image links are left as text. */
export function parsePageImages(line: string): PageImage[] {
  const out: PageImage[] = [];
  PAGE_IMAGE_RE.lastIndex = 0;
  for (let m = PAGE_IMAGE_RE.exec(line); m; m = PAGE_IMAGE_RE.exec(line)) {
    out.push({ from: m.index, to: m.index + m[0].length, alt: m[1], path: m[2], name: m[3] });
  }
  return out;
}

export function extForMime(mime: string): 'png' | 'jpg' {
  return mime === 'image/jpeg' ? 'jpg' : 'png';
}

// ---------------------------------------------------------------------------
// A Board (B5): image items and a note
// ---------------------------------------------------------------------------

/** Between the images of one send, and between them and the Board's content. */
export const BOARD_SEND_GAP = 24;

/** A sent image once uploaded: its asset, its own pixels, and its caption. */
export interface BoardSendImage {
  asset: string;
  natural: Size;
  caption?: string;
}

/** The texts of a send as one note: each as written, a blank line between. */
export function boardSendText(items: readonly SendItem[]): string {
  return items
    .filter((i): i is Extract<SendItem, { kind: 'text' }> => i.kind === 'text')
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A send's items on a Board: the images side by side in order, the text as
 * one note under them, the whole block centred on `at` (the middle of the
 * view). With `at` null (the Board isn't open) the block goes to the right
 * of everything on the Board, tops aligned. A caption is a note pinned to
 * its image's top-right corner. Each item on top of the last.
 */
export function boardSendItems(
  items: readonly BoardItem[],
  images: readonly BoardSendImage[],
  text: string,
  at: Point | null,
  dpr = 1,
  newId: () => string = newItemId,
): BoardItem[] {
  const sizes = images.map((im) => imageSize(im.natural, dpr));
  const rowW = sizes.reduce((w, s) => w + s.w, 0) + BOARD_SEND_GAP * Math.max(0, sizes.length - 1);
  const rowH = sizes.reduce((h, s) => Math.max(h, s.h), 0);
  const body = text.trim();
  const blockW = Math.max(rowW, body ? NOTE_W : 0);
  const blockH = rowH + (body ? (rowH ? BOARD_SEND_GAP : 0) + NOTE_H : 0);
  let left: number;
  let top: number;
  if (at) {
    left = at.x - blockW / 2;
    top = at.y - blockH / 2;
  } else {
    const b = boardBounds([...items]);
    left = b ? b.x + b.w + BOARD_SEND_GAP * 2 : 0;
    top = b ? b.y : 0;
  }
  left = Math.round(left);
  top = Math.round(top);
  const out: BoardItem[] = [];
  const all = () => [...items, ...out];
  let x = left;
  images.forEach((im, i) => {
    const s = sizes[i];
    const img: BoardItem = { id: newId(), kind: 'image', asset: im.asset, x, y: top, w: s.w, h: s.h, z: nextZ(all()) };
    out.push(img);
    x += s.w + BOARD_SEND_GAP;
    const caption = (im.caption ?? '').trim();
    if (caption) out.push(makeNote(all(), { x: img.x + img.w, y: img.y }, pinFor(img, { x: img.x + img.w, y: img.y }), caption, newId()));
  });
  if (body) {
    const note: BoardNote = { id: newId(), kind: 'note', text: body, x: left, y: top + (rowH ? rowH + BOARD_SEND_GAP : 0), w: NOTE_W, h: NOTE_H, z: nextZ(all()) };
    out.push(note);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A tab: the inbox and the paste
// ---------------------------------------------------------------------------

/** `<send_id>-<n>.<ext>` in ~/.lee/inbox (n from 1); the id kept to safe characters. */
export function inboxFileName(sendId: string, n: number, mime: string): string {
  const id = sendId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'send';
  return `${id}-${n}.${extForMime(mime)}`;
}

export function inboxPath(home: string, sendId: string, n: number, mime: string): string {
  return `${home.replace(/\/+$/, '')}/.lee/inbox/${inboxFileName(sendId, n, mime)}`;
}

/** A path as a shell and Claude Code read it: quoted when it has spaces. */
export function pastePath(path: string): string {
  return /\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/**
 * What's pasted into a tab, in the items' order: each text as written, each
 * image as its saved path (`paths[i]` for item i), separated by a space, or a
 * newline after text that ends in one.
 */
export function tabPasteText(items: readonly SendItem[], paths: ReadonlyArray<string | null>): string {
  let out = '';
  items.forEach((item, i) => {
    const piece = item.kind === 'text' ? item.text.replace(/\s+$/, '') : paths[i] ? pastePath(paths[i]!) : '';
    if (!piece) return;
    out = out ? `${out}${/\n$/.test(out) ? '' : ' '}${piece}` : piece;
  });
  return out;
}

/** The question for Hester's palette: the texts, one paragraph each. */
export function paletteQuestion(items: readonly SendItem[]): string {
  return items
    .filter((i): i is Extract<SendItem, { kind: 'text' }> => i.kind === 'text')
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// The status bar chip (§4.3)
// ---------------------------------------------------------------------------

export function deviceLabel(source: string | undefined | null): string {
  if (source === 'aeronaut' || source === 'phone') return 'your phone';
  if (source === 'dirigible' || source === 'tdeck' || source === 't-deck') return 'the T-Deck';
  return 'a device';
}

export function targetLabel(t: SendTarget): string {
  switch (t.kind) {
    case 'page':
    case 'board':
      return t.title || 'Untitled';
    case 'hester':
      return 'Hester';
    case 'tab':
      return t.label || `tab ${t.pty_id}`;
  }
}

/** "photo", "voice note", "text", or several joined: "photo + text". */
export function itemsLabel(items: readonly SendItem[]): string {
  const names: string[] = [];
  for (const i of items) {
    const n = i.kind === 'image' ? i.source : i.input === 'voice' ? 'voice note' : 'text';
    if (!names.includes(n)) names.push(n);
  }
  return names.join(' + ') || 'nothing';
}

/** "From your phone: photo → Taxonomy" (the chip adds "· Undo" when it can). */
export function chipLine(source: string | undefined | null, items: readonly SendItem[], target: SendTarget): string {
  const d = deviceLabel(source);
  return `From ${d}: ${itemsLabel(items)} → ${targetLabel(target)}`;
}

/** Compose sends from a device's tab view show no chip: you're watching that tab. */
export function showsChip(req: { target: SendTarget; compose?: boolean }): boolean {
  return !(req.compose ?? false);
}

export const CHIP_MS = 8000;

// ---------------------------------------------------------------------------
// Targets (GET /tether/targets)
// ---------------------------------------------------------------------------

export interface TargetInputs {
  /** The zoomed card (a Page or a Board, by its id), if any. */
  zoomedCard: { card_id: string; title: string } | null;
  paletteOpen: boolean;
  /** The PTY tab in front of you (the focused agent, terminal or TUI tab). */
  focusedPtyId: number | null;
  /** Pages and Boards this window has touched this session, most recent last. */
  touchedCards: ReadonlyArray<{ card_id: string; title: string }>;
  tabs: ReadonlyArray<{ ptyId: number | null; label: string; type: string; provider?: string | null }>;
}

function tabKind(type: string, provider: string | null | undefined): 'agent' | 'terminal' | 'tui' {
  if (type === 'agent' || type === 'claude' || (type === 'terminal' && provider)) return 'agent';
  return type === 'terminal' ? 'terminal' : 'tui';
}

/** A card as a target: a Page or a Board by its id; anything else isn't one. */
function cardTarget(c: { card_id: string; title: string }): SendTarget | null {
  const kind = cardKindOf(c.card_id);
  return kind ? { kind, card_id: c.card_id, title: c.title } : null;
}

/**
 * The focus, in order: the zoomed Page or Board, the open palette, the
 * focused PTY tab. The rest: touched cards (most recent first), Hester, each
 * PTY tab. Nothing appears twice.
 */
export function buildSendTargets(input: TargetInputs): SendTargets {
  // Every tab with a PTY: agents, terminals and TUIs (editors and browsers have none).
  const ptyTabs = input.tabs.filter((t) => t.ptyId != null);
  const tabTarget = (t: TargetInputs['tabs'][number]): SendTarget => ({
    kind: 'tab',
    pty_id: t.ptyId!,
    label: t.label,
    tab_kind: tabKind(t.type, t.provider),
    provider: t.provider ?? null,
  });
  let focus: SendTarget | null = null;
  const zoomed = input.zoomedCard ? cardTarget(input.zoomedCard) : null;
  if (zoomed) focus = zoomed;
  else if (input.paletteOpen) focus = { kind: 'hester' };
  else if (input.focusedPtyId != null) {
    const t = ptyTabs.find((x) => x.ptyId === input.focusedPtyId);
    if (t) focus = tabTarget(t);
  }
  const same = (a: SendTarget, b: SendTarget | null) =>
    !!b &&
    a.kind === b.kind &&
    (a.kind === 'page' || a.kind === 'board' ? a.card_id === (b as typeof a).card_id : a.kind === 'tab' ? a.pty_id === (b as typeof a).pty_id : true);
  const targets: SendTarget[] = [];
  const add = (t: SendTarget) => {
    if (same(t, focus) || targets.some((x) => same(t, x))) return;
    targets.push(t);
  };
  for (const c of [...input.touchedCards].reverse()) {
    const t = cardTarget(c);
    if (t) add(t);
  }
  add({ kind: 'hester' });
  for (const t of ptyTabs) add(tabTarget(t));
  return { focus, targets };
}
