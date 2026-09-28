/**
 * tetherDelivery - Send to Lee, delivered (docs/plans/2026-09-28-tether-review-voice.md §4.3).
 * Main validates a device's POST /tether/send and hands it to this window
 * (lib/tetherIpc); this puts it where it was aimed and answers:
 *
 * - page: text as its own paragraph at the Page's cursor, through the editor
 *   so it saves and undoes normally (a Page open on this window registers a
 *   sink); a Page that isn't open gets it at its end through Hester's
 *   page route. Images are uploaded to the Page's assets first and go in as
 *   `![caption](assets/<file>)`.
 * - hester: the palette opens with the text as its question and the images
 *   attached; Send asks it.
 * - tab: pasted as one piece through xterm's paste() (bracketed when the
 *   program asked for it), images as their ~/.lee/inbox paths; `\r` only
 *   with Send.
 *
 * Then a quiet chip in the status bar for 8 s ("From your phone: photo →
 * Taxonomy · Undo"); Undo takes a Page insertion out while it's unchanged.
 * Compose sends from a device's tab view show no chip.
 */

import type { SendItem, SendTarget } from '../../shared/tether';
import { focusManager } from '../hooks/useFocusManager';
import { getPage, putPage } from './hesterDeep';
import { uploadPageAsset } from './hesterDesk';
import { answerTetherSend, onTetherSend, saveInboxImage, type TetherSendIpc } from './tetherIpc';
import {
  CHIP_MS,
  chipLine,
  checkSend,
  imageMarkdown,
  pageInsertion,
  paletteQuestion,
  removeInsertion,
  showsChip,
  tabPasteText,
  type Insertion,
} from './tetherModel';

type DeliverResult = { ok: true; undo?: () => Promise<boolean> } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Sinks: what the open Page and the palette register
// ---------------------------------------------------------------------------

/** A Page open on this window: inserts through its editor. */
export interface PageSink {
  cardId: string;
  /** Insert `text` as its own paragraph at the cursor; what went in, or null when the editor isn't ready. */
  insert(text: string): Insertion | null;
  /** Take an insertion out while it's unchanged; false when it changed. */
  remove(ins: Insertion): boolean;
}

export interface PaletteImage {
  mime: 'image/png' | 'image/jpeg';
  data_b64: string;
  source: string;
  caption?: string;
}

/** The palette's opener (App): the question, its images, and whether to ask it. */
export type PaletteSink = (q: { text: string; images: PaletteImage[]; submit: boolean }) => void;

const pageSinks = new Map<string, PageSink>();
let paletteSink: PaletteSink | null = null;

export function registerPageSink(sink: PageSink): () => void {
  pageSinks.set(sink.cardId, sink);
  return () => {
    if (pageSinks.get(sink.cardId) === sink) pageSinks.delete(sink.cardId);
  };
}

export function registerPaletteSink(sink: PaletteSink): () => void {
  paletteSink = sink;
  return () => {
    if (paletteSink === sink) paletteSink = null;
  };
}

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------

export interface SendChip {
  id: string;
  line: string;
  undo: (() => Promise<boolean>) | null;
}

let chip: SendChip | null = null;
let chipTimer: ReturnType<typeof setTimeout> | null = null;
const chipListeners = new Set<(c: SendChip | null) => void>();

function setChip(c: SendChip | null): void {
  chip = c;
  if (chipTimer) clearTimeout(chipTimer);
  chipTimer = c ? setTimeout(() => setChip(null), CHIP_MS) : null;
  for (const l of chipListeners) l(c);
}

export function currentSendChip(): SendChip | null {
  return chip;
}

export function onSendChip(cb: (c: SendChip | null) => void): () => void {
  chipListeners.add(cb);
  return () => chipListeners.delete(cb);
}

export function dismissSendChip(): void {
  setChip(null);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The page's text block: texts as written, images uploaded and linked; one block, one Undo. */
async function pageBlock(workspace: string, cardId: string, items: readonly SendItem[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      if (item.text.trim()) parts.push(item.text.trim());
      continue;
    }
    const up = await uploadPageAsset(workspace, cardId, b64ToBytes(item.data_b64), item.mime);
    if (!up.ok) return { ok: false, error: `image_upload: ${up.error}` };
    parts.push(imageMarkdown(item.caption, up.data.path));
  }
  return parts.length ? { ok: true, text: parts.join('\n\n') } : { ok: false, error: 'no_items' };
}

/** Insert at the end of a Page that isn't open, through Hester (one retry on a version conflict). */
async function remotePageInsert(workspace: string, cardId: string, text: string): Promise<DeliverResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pg = await getPage(workspace, cardId);
    if (!pg.ok) return { ok: false, error: pg.status === 404 ? 'page_not_found' : pg.error };
    const ins = pageInsertion(pg.data.text, null, text);
    const next = pg.data.text.slice(0, ins.from) + ins.insert + pg.data.text.slice(ins.from);
    const put = await putPage(workspace, cardId, next, pg.data.version);
    if (put.ok) {
      const undo = async () => {
        const now = await getPage(workspace, cardId);
        if (!now.ok) return false;
        const back = removeInsertion(now.data.text, ins);
        if (back == null) return false;
        const r = await putPage(workspace, cardId, back, now.data.version);
        return r.ok;
      };
      return { ok: true, undo };
    }
    if (!('conflict' in put) || !put.conflict) return { ok: false, error: put.error };
  }
  return { ok: false, error: 'page_conflict' };
}

async function deliverToPage(workspace: string, target: Extract<SendTarget, { kind: 'page' }>, items: readonly SendItem[]): Promise<DeliverResult> {
  const block = await pageBlock(workspace, target.card_id, items);
  if (!block.ok) return block;
  const sink = pageSinks.get(target.card_id);
  const ins = sink?.insert(block.text) ?? null;
  if (sink && ins) return { ok: true, undo: async () => sink.remove(ins) };
  return remotePageInsert(workspace, target.card_id, block.text);
}

function deliverToHester(items: readonly SendItem[], submit: boolean): DeliverResult {
  if (!paletteSink) return { ok: false, error: 'palette_unavailable' };
  const images: PaletteImage[] = items
    .filter((i): i is Extract<SendItem, { kind: 'image' }> => i.kind === 'image')
    .map((i) => ({ mime: i.mime, data_b64: i.data_b64, source: i.source, caption: i.caption }));
  paletteSink({ text: paletteQuestion(items), images, submit });
  return { ok: true };
}

/**
 * Paste into a PTY tab as one piece. Through its xterm when the tab is
 * mounted (paste() brackets it when the program enabled bracketed paste);
 * otherwise straight to the PTY, bracketed for an agent (Claude Code enables
 * it) and refused for multi-line text elsewhere, which would run line by line.
 */
async function pasteIntoTab(target: Extract<SendTarget, { kind: 'tab' }>, text: string, submit: boolean): Promise<DeliverResult> {
  const pty = typeof window !== 'undefined' ? window.lee?.pty : undefined;
  const term = focusManager.get(target.pty_id);
  if (term) term.paste(text);
  else if (!pty) return { ok: false, error: 'tab_not_found' };
  else if (!text.includes('\n')) await pty.write(target.pty_id, text);
  else if (target.tab_kind === 'agent') await pty.write(target.pty_id, `\x1b[200~${text}\x1b[201~`);
  else return { ok: false, error: 'tab_not_open' };
  if (submit) {
    // Let the program take the paste before Enter, so Enter isn't read as part of it.
    await delay(60);
    if (!pty) return { ok: false, error: 'tab_not_found' };
    await pty.write(target.pty_id, '\r');
  }
  return { ok: true };
}

async function deliverToTab(sendId: string, target: Extract<SendTarget, { kind: 'tab' }>, items: readonly SendItem[], submit: boolean): Promise<DeliverResult> {
  const paths: Array<string | null> = [];
  let n = 0;
  for (const item of items) {
    if (item.kind !== 'image') {
      paths.push(null);
      continue;
    }
    n += 1;
    const p = await saveInboxImage({ send_id: sendId, n, mime: item.mime, data_b64: item.data_b64 });
    if (!p) return { ok: false, error: 'inbox_unavailable' };
    paths.push(p);
  }
  const text = tabPasteText(items, paths);
  if (!text) return { ok: false, error: 'no_items' };
  return pasteIntoTab(target, text, submit);
}

/** Deliver one send; shows the chip on success. */
export async function deliverSend(workspace: string, req: TetherSendIpc): Promise<{ ok: boolean; error?: string }> {
  const check = checkSend(req.target, req.items, req.submit);
  if (!check.ok) return check;
  let r: DeliverResult;
  try {
    switch (req.target.kind) {
      case 'page':
        r = await deliverToPage(workspace, req.target, req.items);
        break;
      case 'hester':
        r = deliverToHester(req.items, !!req.submit);
        break;
      case 'tab':
        r = await deliverToTab(req.send_id, req.target, req.items, !!req.submit);
        break;
      default:
        r = { ok: false, error: 'board_not_built' };
    }
  } catch (e) {
    r = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!r.ok) return r;
  if (showsChip(req)) setChip({ id: req.send_id, line: chipLine(req.source_device, req.items, req.target), undo: r.undo ?? null });
  return { ok: true };
}

/**
 * Listen for sends from main for this window's workspace and answer each one
 * (tether:send-result). Returns an unsubscribe.
 */
export function startTetherDelivery(workspace: () => string): () => void {
  return onTetherSend((req) => {
    void deliverSend(workspace(), req).then((r) => answerTetherSend({ send_id: req.send_id, ok: r.ok, ...(r.ok ? {} : { error: r.error }) }));
  });
}
