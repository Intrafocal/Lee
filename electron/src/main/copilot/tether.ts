/**
 * Tether for devices (docs/plans/2026-09-28-tether-review-voice.md §3.3,
 * §4.2; docs/14-Deep-Work.md §8.1): Lee main routes that read a workspace's
 * Desk through Hester, trimmed for a phone or a T-Deck, take captures, and
 * deliver Send to Lee into a window. A device needs only its Lee token.
 *
 *   GET  /tether                      Tether: Pick up (your last card), open questions, counts
 *   POST /tether/capture              { workspace?, text, card_id?, input? } -> Hester POST /ideas
 *   GET  /tether/desk                 TetherDesk: the Areas on the Desk and their Pages
 *   GET  /tether/pages?limit=50       TetherCard[]: every Page, stashed too, newest first
 *   GET  /tether/pages/:id            TetherPage (?text_only=1: { card, text })
 *   GET  /tether/pages/:id/assets/:name  a Page's image, proxied from Hester
 *   GET  /tether/drawer               TetherDrawer: Stashed Areas and open Ideas
 *   GET  /tether/targets              SendTargets for the window with the workspace
 *   POST /tether/send                 SendRequest -> IPC tether:send, answered by tether:send-result
 *
 * Any authenticated principal. `?workspace=` (or the body's) must be an open
 * window's; default the focused window's. Hester unreachable: 503 { error:
 * 'hester_offline' }, except a capture, which is spooled
 * (~/.lee/spool/ideas.jsonl) and answers 200 { spooled: true }.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain } from 'electron';
import type { Application, Request, Response } from 'express';
import { encodeWorkspaceHeader } from '../../shared/cockpit';
import type { DeepAnswer, DeepQuestion, DeepReference, Opener } from '../../shared/cockpit';
import type { Principal } from '../../shared/copilot';
import type { LeeContext, PanelContext, TabContext } from '../../shared/context';
import { PAGE_ID_RE, type Desk, type DeskArea, type DeskCard } from '../../shared/desk';
import { TETHER_IPC, type TetherSendDelivery, type TetherSendFrom, type TetherSendOutcome } from '../../shared/lee-api';
import type {
  SendItem,
  SendResult,
  SendTarget,
  SendTargets,
  Tether,
  TetherCard,
  TetherDesk,
  TetherDrawer,
  TetherPage,
} from '../../shared/tether';
import { windowRegistry, type WindowState } from '../window-registry';
import { actorForPrincipal } from './auth';
import { logEvent } from './bus';
import { CAPTURE_MAX_CHARS, getCaptureRelay, getHesterPort, resolveCaptureWorkspace, type IdeaPayload } from './capture';
import { captureSourceFor } from './core-routes';

const REQUEST_TIMEOUT_MS = 5000;
export const TETHER_QUESTIONS_MAX = 5;
export const TETHER_PAGES_DEFAULT = 50;
export const TETHER_PAGES_MAX = 200;
export const TETHER_IDEAS_MAX = 200;
/** TetherPage.text is cut at a line past this many bytes. */
export const TETHER_TEXT_MAX_BYTES = 200 * 1024;

/** §4.2 limits on POST /tether/send. */
export const TETHER_SEND_MAX_BYTES = 15 * 1024 * 1024;
export const TETHER_SEND_MAX_ITEMS = 4;
export const TETHER_SEND_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TETHER_SEND_TEXT_MAX_CHARS = 20_000;
export const TETHER_SEND_CAPTION_MAX_CHARS = 500;
export const TETHER_SEND_TIMEOUT_MS = 10_000;

const ASSET_NAME_RE = /^[A-Za-z0-9_-]{1,128}\.(png|jpe?g)$/;
const ASSET_TYPES = new Set(['image/png', 'image/jpeg']);

/** A Hester call's result: offline (network error or timeout) or an HTTP answer. */
export type HesterResult = { offline: true } | { offline: false; status: number; body: unknown };

export type HesterCall = (method: 'GET' | 'POST', route: string, workspace: string | null, body?: unknown) => Promise<HesterResult>;

/** A Hester GET whose body is bytes (a Page's image). */
export type HesterRawResult = { offline: true } | { offline: false; status: number; contentType: string; body: Buffer };
export type HesterRawCall = (route: string, workspace: string | null) => Promise<HesterRawResult>;

function readSharedToken(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.lee', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function hesterHeaders(workspace: string | null, json: boolean): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${readSharedToken()}`,
    ...(workspace ? { 'X-Lee-Workspace': encodeWorkspaceHeader(workspace) } : {}),
  };
}

/** Lee main -> Hester with the shared token and X-Lee-Workspace. Never throws. */
export const hesterCall: HesterCall = async (method, route, workspace, body) => {
  let res: globalThis.Response;
  try {
    res = await fetch(`http://127.0.0.1:${getHesterPort()}${route}`, {
      method,
      headers: hesterHeaders(workspace, body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { offline: true };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { offline: false, status: res.status, body: parsed };
};

export const hesterRaw: HesterRawCall = async (route, workspace) => {
  try {
    const res = await fetch(`http://127.0.0.1:${getHesterPort()}${route}`, {
      headers: hesterHeaders(workspace, false),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { offline: false, status: res.status, contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim(), body };
  } catch {
    return { offline: true };
  }
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Hester's `{success, data}` envelope, or the bare body. */
function dataOf(body: unknown): unknown {
  return isRecord(body) && 'data' in body ? body.data : body;
}

function errorOf(body: unknown, status: number): string {
  if (isRecord(body)) {
    if (typeof body.error === 'string') return body.error;
    if (typeof body.detail === 'string') return body.detail;
  }
  return `Hester returned ${status}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function validCardId(v: unknown): string | null {
  return typeof v === 'string' && PAGE_ID_RE.test(v) ? v : null;
}

function lineNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

function newestFirst<T>(key: (x: T) => string | null): (a: T, b: T) => number {
  return (a, b) => (key(b) ?? '').localeCompare(key(a) ?? '');
}

// ---------------------------------------------------------------------------
// Trimming Hester's Desk for devices (§3.3)
// ---------------------------------------------------------------------------

/** The Tether view from Hester's opener: your last Desk card, then open questions (that card's first). */
export function buildTether(opener: Opener, fallbackWorkspace: string | null, spooled = 0): Tether {
  const p = opener.pick_up;
  const card = p?.card && typeof p.card.id === 'string' && p.card.id ? p.card : null;
  const pick_up: Tether['pick_up'] = p && card
    ? {
        card_id: card.id,
        card_kind: 'page',
        title: card.title ?? '',
        area_name: card.area_name ?? null,
        stopped_at: p.stopped_at ?? null,
        stopped_line: lineNumber(p.stopped_line),
        last_touched_at: card.last_touched_at ?? null,
      }
    : null;
  let questions: Tether['open_questions'] = [];
  let captured = 0;
  for (const s of opener.surfaces ?? []) {
    if (s.kind === 'open_questions') {
      questions = (s.items ?? [])
        .filter((q) => q && (q.card_id || q.exploration_id) && q.question_id && typeof q.text === 'string')
        .map((q) => ({ card_id: (q.card_id || q.exploration_id) as string, question_id: q.question_id, text: q.text }));
    } else if (s.kind === 'captured_away') {
      captured = typeof s.count === 'number' ? s.count : s.items?.length ?? 0;
    }
  }
  if (pick_up) {
    const mine = questions.filter((q) => q.card_id === pick_up.card_id);
    questions = [...mine, ...questions.filter((q) => q.card_id !== pick_up.card_id)];
  }
  return {
    workspace: opener.workspace || fallbackWorkspace || '',
    pick_up,
    open_questions: questions.slice(0, TETHER_QUESTIONS_MAX),
    captured_count: captured,
    spooled,
  };
}

/**
 * A card as a device lists it. `answers` counts the unread ones (what's new
 * to read on the Page); `updated_at` is when its text last changed.
 */
export function tetherCard(card: DeskCard, areas: Map<string, DeskArea>): TetherCard {
  const area = card.area_id ? areas.get(card.area_id) : undefined;
  const s = card.summary;
  return {
    id: card.id,
    kind: card.kind,
    title: card.title ?? '',
    area_id: card.area_id ?? null,
    area_name: area?.name ?? null,
    stashed: !!area && area.drawer_id != null,
    updated_at: s?.page_updated_at ?? card.updated_at ?? null,
    chars: num(s?.page_chars),
    answers: num(s?.answers_unread),
    open_questions: num(s?.open_questions),
  };
}

function areaMap(desk: Desk): Map<string, DeskArea> {
  return new Map((desk.areas ?? []).map((a) => [a.id, a]));
}

const byUpdated = newestFirst<TetherCard>((c) => c.updated_at);

/** GET /tether/desk: the Areas on the Desk (not stashed) with their Pages, newest first; the Goals card apart. */
export function buildTetherDesk(desk: Desk): TetherDesk {
  const areas = areaMap(desk);
  const cards = (desk.cards ?? []).map((c) => ({ raw: c, card: tetherCard(c, areas) }));
  const goals = cards.find((c) => c.raw.purpose === 'goals')?.card ?? null;
  return {
    workspace: desk.workspace,
    areas: (desk.areas ?? [])
      .filter((a) => a.drawer_id == null)
      .map((a) => ({
        id: a.id,
        name: a.name,
        cards: cards.filter((c) => c.raw.area_id === a.id && c.raw.purpose !== 'goals').map((c) => c.card).sort(byUpdated),
      })),
    goals_card: goals,
    last_card_id: desk.last?.card_id ?? null,
  };
}

/** GET /tether/pages: every Page, stashed ones too, newest first (the T-Deck's list). */
export function buildTetherPages(desk: Desk, limit = TETHER_PAGES_DEFAULT): TetherCard[] {
  const areas = areaMap(desk);
  return (desk.cards ?? [])
    .filter((c) => c.kind === 'page')
    .map((c) => tetherCard(c, areas))
    .sort(byUpdated)
    .slice(0, Math.max(1, Math.min(TETHER_PAGES_MAX, limit)));
}

/** At most `maxBytes` of UTF-8, cut at the last whole line with "…" after it. */
export function cutText(text: string, maxBytes = TETHER_TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Decoding a byte prefix may end in a broken character; the cut at a line drops it.
  const head = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  const nl = head.lastIndexOf('\n');
  return `${nl > 0 ? head.slice(0, nl) : head.replace(/�$/, '')}\n…`;
}

/** A reference's one line of "where": its link, else its file and lines, else its section. */
function referenceWhere(r: DeepReference): string | null {
  if (r.url) return r.url;
  if (r.file) return r.lines ? `${r.file}:${r.lines[0]}-${r.lines[1]}` : r.file;
  return r.section ?? null;
}

/** GET /tether/pages/:id: the Page's text, then its margin (answers, hand-offs, open questions, references). */
export function buildTetherPage(
  card: TetherCard,
  text: string,
  answers: DeepAnswer[],
  questions: DeepQuestion[],
  references: DeepReference[],
): TetherPage {
  const live = answers.filter((a) => a && typeof a.id === 'string' && !a.dismissed_at);
  return {
    card,
    text: cutText(text),
    answers: live
      .filter((a) => a.kind !== 'handoff')
      .map((a) => ({ id: a.id, question: a.question ?? '', answer: a.answer ?? null, status: a.status ?? '' })),
    handoffs: live
      .filter((a) => a.kind === 'handoff')
      .map((a) => ({
        id: a.id,
        kind: a.handoff?.kind ?? '',
        provider: a.handoff?.provider ?? null,
        status: a.handoff?.state ?? a.status ?? '',
        result: a.answer ?? null,
      })),
    open_questions: questions.filter((q) => q && q.status === 'open').map((q) => ({ id: q.id, text: q.text })),
    references: references
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => ({ title: r.title || r.url || r.file || (r.kind === 'quote' ? 'Quote' : 'Link'), where: referenceWhere(r), quote: r.quote ?? null })),
  };
}

/** GET /tether/drawer: the Stashed Areas (most recently stashed first) with their Pages, and open Ideas, newest first. */
export function buildTetherDrawer(desk: Desk, ideas: unknown[]): TetherDrawer {
  const areas = areaMap(desk);
  const cards = (desk.cards ?? []).map((c) => tetherCard(c, areas));
  const stashed = (desk.areas ?? [])
    .filter((a) => a.drawer_id != null)
    .map((a) => ({ id: a.id, name: a.name, stashed_at: a.stashed_at ?? null, cards: cards.filter((c) => c.area_id === a.id).sort(byUpdated) }))
    .sort(newestFirst((a) => a.stashed_at));
  const out: TetherDrawer['ideas'] = [];
  for (const i of ideas) {
    if (!isRecord(i) || !str(i.id) || typeof i.text !== 'string') continue;
    if (i.status !== undefined && i.status !== 'open') continue;
    out.push({
      id: i.id as string,
      text: i.text,
      created_at: str(i.created_at) ?? '',
      surface: isRecord(i.source) ? str(i.source.surface) : null,
    });
  }
  return { stashed, ideas: out.sort(newestFirst((i) => i.created_at)).slice(0, TETHER_IDEAS_MAX) };
}

// ---------------------------------------------------------------------------
// Send to Lee: targets (§4.2)
// ---------------------------------------------------------------------------

/** The Deep session's Page and the cards it touched (the queue's focus tracker). */
export interface TetherDeepInfo {
  workspace: string;
  card: { card_id: string; title: string } | null;
  touched: string[];
}

/** A PTY tab as a Send target: agents (Claude, Pi, …), terminals, and every other TUI. */
export function tabTarget(tab: TabContext): Extract<SendTarget, { kind: 'tab' }> | null {
  if (typeof tab.ptyId !== 'number') return null;
  const agent = tab.type === 'agent' || tab.type === 'claude';
  return {
    kind: 'tab',
    pty_id: tab.ptyId,
    label: tab.label ?? '',
    tab_kind: agent ? 'agent' : tab.type === 'terminal' ? 'terminal' : 'tui',
    provider: agent ? tab.provider ?? (tab.type === 'claude' ? 'claude' : null) : null,
  };
}

function sameTarget(a: SendTarget, b: SendTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tab' && b.kind === 'tab') return a.pty_id === b.pty_id;
  if ((a.kind === 'page' || a.kind === 'board') && (b.kind === 'page' || b.kind === 'board')) return a.card_id === b.card_id;
  return true;
}

export interface TargetInputs {
  tabs: TabContext[];
  /** The focused panel's active tab id. */
  activeTabId: number | null;
  paletteOpen: boolean;
  /** The Deep session, when it's in this window's workspace. */
  deep: TetherDeepInfo | null;
  /** Page titles by card id (from Hester's Desk); a touched Page without one is left out. */
  titles: Map<string, string>;
}

/**
 * What's in front of you, then everything else: the palette when it's open,
 * else the zoomed Page, else the focused tab when it's an agent. The rest are
 * the Pages this Deep session touched, Hester and every PTY tab.
 */
export function buildTargets(inp: TargetInputs): SendTargets {
  const tabs = inp.tabs.map(tabTarget).filter((t): t is Extract<SendTarget, { kind: 'tab' }> => t !== null);
  const active = inp.activeTabId != null ? inp.tabs.find((t) => t.id === inp.activeTabId) : undefined;
  const activeTarget = active ? tabTarget(active) : null;
  let focus: SendTarget | null = null;
  if (inp.paletteOpen) focus = { kind: 'hester' };
  else if (inp.deep?.card) focus = { kind: 'page', card_id: inp.deep.card.card_id, title: inp.deep.card.title };
  else if (activeTarget?.tab_kind === 'agent') focus = activeTarget;
  // The zoomed Page first, then the others this session touched, most recent first.
  const pages: SendTarget[] = [];
  const addPage = (card_id: string, title: string) => {
    if (!pages.some((p) => p.kind === 'page' && p.card_id === card_id)) pages.push({ kind: 'page', card_id, title });
  };
  if (inp.deep?.card) addPage(inp.deep.card.card_id, inp.deep.card.title);
  for (const id of [...(inp.deep?.touched ?? [])].reverse()) {
    const title = inp.titles.get(id);
    if (title !== undefined) addPage(id, title);
  }
  const all: SendTarget[] = [...pages, { kind: 'hester' }, ...tabs];
  return { focus, targets: focus ? all.filter((t) => !sameTarget(t, focus!)) : all };
}

// ---------------------------------------------------------------------------
// Send to Lee: validation (§4.2)
// ---------------------------------------------------------------------------

export type SendCheck =
  | { ok: true; target: SendTarget | 'focus'; items: SendItem[]; submit: boolean; compose: boolean; bytes: number[] }
  | { ok: false; status: number; error: string };

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function bad(error: string): SendCheck {
  return { ok: false, status: 400, error };
}

function imageMatches(mime: string, buf: Buffer): boolean {
  if (mime === 'image/png') return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** A SendRequest body, checked (§4.2). `bytes` is each item's size (UTF-8 text, decoded image) for the event. */
export function checkSendRequest(body: unknown): SendCheck {
  if (!isRecord(body)) return bad('body must be an object');
  let target: SendTarget | 'focus';
  const t = body.target;
  if (t === 'focus') target = 'focus';
  else if (!isRecord(t)) return bad("target must be 'focus' or a target");
  else if (t.kind === 'hester') target = { kind: 'hester' };
  else if (t.kind === 'page') {
    const card_id = validCardId(t.card_id);
    if (!card_id) return bad('target.card_id must be a Page id');
    target = { kind: 'page', card_id, title: typeof t.title === 'string' ? t.title.slice(0, 200) : '' };
  } else if (t.kind === 'tab') {
    if (typeof t.pty_id !== 'number' || !Number.isInteger(t.pty_id) || t.pty_id < 0) return bad('target.pty_id must be an integer');
    target = { kind: 'tab', pty_id: t.pty_id, label: '', tab_kind: 'terminal', provider: null };
  } else if (t.kind === 'board') return bad('Board targets are not built yet');
  else return bad('target.kind must be page, hester or tab');

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) return bad('items must be a non-empty array');
  if (raw.length > TETHER_SEND_MAX_ITEMS) return bad(`at most ${TETHER_SEND_MAX_ITEMS} items`);
  const items: SendItem[] = [];
  const bytes: number[] = [];
  for (const [n, it] of raw.entries()) {
    if (!isRecord(it)) return bad(`items[${n}] must be an object`);
    if (it.kind === 'text') {
      if (typeof it.text !== 'string' || !it.text.trim()) return bad(`items[${n}].text is required`);
      if (it.text.length > TETHER_SEND_TEXT_MAX_CHARS) return bad(`items[${n}].text must be at most ${TETHER_SEND_TEXT_MAX_CHARS} characters`);
      if (it.input !== undefined && it.input !== 'voice') return bad(`items[${n}].input must be 'voice'`);
      items.push({ kind: 'text', text: it.text, ...(it.input === 'voice' ? { input: 'voice' as const } : {}) });
      bytes.push(Buffer.byteLength(it.text, 'utf8'));
    } else if (it.kind === 'image') {
      if (it.mime !== 'image/png' && it.mime !== 'image/jpeg') return bad(`items[${n}].mime must be image/png or image/jpeg`);
      if (it.source !== 'photo' && it.source !== 'screenshot' && it.source !== 'scribble') return bad(`items[${n}].source must be photo, screenshot or scribble`);
      if (typeof it.data_b64 !== 'string' || !it.data_b64 || it.data_b64.length % 4 !== 0 || !B64_RE.test(it.data_b64)) {
        return bad(`items[${n}].data_b64 must be base64`);
      }
      // Decoded size from the length, before decoding anything large.
      const pad = it.data_b64.endsWith('==') ? 2 : it.data_b64.endsWith('=') ? 1 : 0;
      const size = (it.data_b64.length / 4) * 3 - pad;
      if (size > TETHER_SEND_IMAGE_MAX_BYTES) return bad(`items[${n}] is larger than ${TETHER_SEND_IMAGE_MAX_BYTES / (1024 * 1024)} MB`);
      if (!imageMatches(it.mime, Buffer.from(it.data_b64.slice(0, 16), 'base64'))) return bad(`items[${n}] is not a ${it.mime === 'image/png' ? 'PNG' : 'JPEG'}`);
      if (it.caption !== undefined && (typeof it.caption !== 'string' || it.caption.length > TETHER_SEND_CAPTION_MAX_CHARS)) {
        return bad(`items[${n}].caption must be a string of at most ${TETHER_SEND_CAPTION_MAX_CHARS} characters`);
      }
      items.push({
        kind: 'image',
        mime: it.mime,
        data_b64: it.data_b64,
        source: it.source,
        ...(typeof it.caption === 'string' && it.caption.trim() ? { caption: it.caption.trim() } : {}),
      });
      bytes.push(size);
    } else return bad(`items[${n}].kind must be text or image`);
  }

  if (body.submit !== undefined && typeof body.submit !== 'boolean') return bad('submit must be a boolean');
  const submit = body.submit === true;
  if (submit) {
    if (target !== 'focus' && target.kind === 'page') return bad('submit is not allowed for a Page');
    if (!items.some((i) => i.kind === 'text')) return bad('submit needs a text item');
  }
  if (body.compose !== undefined && typeof body.compose !== 'boolean') return bad('compose must be a boolean');
  return { ok: true, target, items, submit, compose: body.compose === true, bytes };
}

// ---------------------------------------------------------------------------
// Send to Lee: the IPC round trip (§4.2)
// ---------------------------------------------------------------------------

/** The part of a BrowserWindow the round trip uses (tests pass a fake). */
export interface DeliveryWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

/** Sends tether:send to a window and waits for its tether:send-result. */
export class TetherSendBroker {
  private pending = new Map<string, { resolve: (o: TetherSendOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

  deliver(win: DeliveryWindow, delivery: TetherSendDelivery, timeoutMs = TETHER_SEND_TIMEOUT_MS): Promise<TetherSendOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(delivery.send_id);
        resolve({ send_id: delivery.send_id, ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pending.set(delivery.send_id, { resolve, timer });
      try {
        if (win.isDestroyed()) throw new Error('window closed');
        win.webContents.send(TETHER_IPC.send, delivery);
      } catch {
        this.settle({ send_id: delivery.send_id, ok: false, error: 'no_window' });
      }
    });
  }

  /** The renderer's answer; one for an unknown (or timed-out) send_id is ignored. */
  settle(outcome: unknown): boolean {
    if (!isRecord(outcome) || typeof outcome.send_id !== 'string') return false;
    const p = this.pending.get(outcome.send_id);
    if (!p) return false;
    this.pending.delete(outcome.send_id);
    clearTimeout(p.timer);
    p.resolve({
      send_id: outcome.send_id,
      ok: outcome.ok === true,
      ...(typeof outcome.error === 'string' && outcome.error ? { error: outcome.error.slice(0, 64) } : {}),
    });
    return true;
  }
}

export const tetherSendBroker = new TetherSendBroker();

/** Window id -> whether its Command Palette is open (the renderer reports it). */
const paletteOpen = new Map<number, boolean>();

let ipcInstalled = false;

/** tether:send-result and tether:palette from renderers. Called once from initCopilotCore. */
export function installTetherIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on(TETHER_IPC.sendResult, (_e, outcome: unknown) => {
    tetherSendBroker.settle(outcome);
  });
  ipcMain.on(TETHER_IPC.palette, (e, payload: unknown) => {
    const id = windowIdForSender(e.sender);
    if (id == null) return;
    if (isRecord(payload) && payload.open === true) paletteOpen.set(id, true);
    else paletteOpen.delete(id);
  });
  ipcMain.handle(TETHER_IPC.inboxImage, (_e, image: unknown) => saveInboxImage(image));
}

/** ~/.lee/inbox/: images sent to a tab, typed as a path (§4.3). 0600, pruned after 7 days. */
export const INBOX_DIR = path.join(os.homedir(), '.lee', 'inbox');
const INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INBOX_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Write one image for a tab target; its absolute path, or null for a bad request. Never throws. */
export function saveInboxImage(image: unknown, dir: string = INBOX_DIR, now: number = Date.now()): string | null {
  try {
    if (!isRecord(image)) return null;
    const { send_id, n, mime, data_b64 } = image;
    const ext = typeof mime === 'string' ? INBOX_EXT[mime] : undefined;
    if (typeof send_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(send_id) || !Number.isInteger(n) || (n as number) < 0 || (n as number) > 16 || !ext || typeof data_b64 !== 'string') return null;
    const bytes = Buffer.from(data_b64, 'base64');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        if (now - fs.statSync(f).mtimeMs > INBOX_TTL_MS) fs.rmSync(f, { force: true });
      } catch {
        /* gone already */
      }
    }
    const file = path.join(dir, `${send_id}-${n}.${ext}`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

function windowIdForSender(sender: unknown): number | null {
  for (const [id, ws] of windowRegistry.getAll()) {
    if (ws.browserWindow.webContents === sender) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Where a Tether write came from: the device's kind, else 'lee' (the renderer). */
export function tetherSource(p: Principal | undefined): { surface: string; device_id?: string } {
  return p?.kind === 'device' ? captureSourceFor(p) : { surface: 'lee' };
}

function tetherFrom(p: Principal | undefined): TetherSendFrom {
  const s = tetherSource(p);
  return p?.kind === 'device' ? { surface: s.surface, device_name: p.name } : { surface: s.surface };
}

function offline(res: Response): void {
  res.status(503).json({ success: false, error: 'hester_offline' });
}

function wsQuery(ws: string | null, extra = ''): string {
  const q = [ws ? `workspace=${encodeURIComponent(ws)}` : '', extra].filter(Boolean).join('&');
  return q ? `?${q}` : '';
}

export interface TetherRoutesDeps {
  /** Tests inject a fake; defaults to the real Hester. */
  hester?: HesterCall;
  hesterRaw?: HesterRawCall;
  /** Spool a capture Hester couldn't take; false when it couldn't be written. Defaults to the capture relay's spool. */
  spool?: (payload: IdeaPayload) => boolean;
  /** Captures waiting in the spool. Defaults to the capture relay's. */
  spooledCount?: () => number;
  /** The running Deep session (the queue's focus tracker); null outside Deep. */
  deep?: () => TetherDeepInfo | null;
  broker?: TetherSendBroker;
  sendTimeoutMs?: number;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
}

/** Answered = done; else the parsed data. */
type Fetched<T> = { ok: true; data: T } | { ok: false };

export function registerTetherRoutes(app: Application, deps: TetherRoutesDeps = {}): void {
  const hester = deps.hester ?? hesterCall;
  const raw = deps.hesterRaw ?? hesterRaw;
  const spool = deps.spool ?? ((payload: IdeaPayload) => getCaptureRelay()?.spool(payload) ?? false);
  const spooledCount = deps.spooledCount ?? (() => getCaptureRelay()?.pending() ?? 0);
  const deepInfo = deps.deep ?? (() => null);
  const broker = deps.broker ?? tetherSendBroker;

  /** The workspace from ?workspace= (400 when it isn't an open window's). */
  function workspaceOf(req: Request, res: Response): { workspace: string | null; window_id: number | null } | null {
    const ws = resolveCaptureWorkspace(req.query.workspace, null);
    if (!ws.ok) {
      res.status(400).json({ success: false, error: ws.error });
      return null;
    }
    return ws;
  }

  /** A Hester GET's data, or the error answered (503 offline, Hester's 4xx, else 502). */
  async function get<T>(res: Response, route: string, workspace: string | null): Promise<Fetched<T>> {
    const r = await hester('GET', route, workspace);
    if (r.offline) {
      if (!res.headersSent) offline(res);
      return { ok: false };
    }
    if (r.status < 200 || r.status >= 300) {
      if (!res.headersSent) {
        const status = r.status === 400 || r.status === 404 ? r.status : 502;
        res.status(status).json({ success: false, error: errorOf(r.body, r.status) });
      }
      return { ok: false };
    }
    return { ok: true, data: dataOf(r.body) as T };
  }

  async function getDesk(res: Response, workspace: string | null): Promise<Desk | null> {
    const d = await get<Desk>(res, `/desk${wsQuery(workspace)}`, workspace);
    if (!d.ok) return null;
    if (!isRecord(d.data) || !Array.isArray(d.data.cards)) {
      if (!res.headersSent) res.status(502).json({ success: false, error: 'Hester returned no Desk' });
      return null;
    }
    return d.data;
  }

  function failed(res: Response, what: string, err: unknown): void {
    deps.log?.('ERROR', `Tether ${what} failed`, { error: String(err) });
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Tether failed' });
  }

  app.get('/tether', async (req: Request, res: Response) => {
    const ws = workspaceOf(req, res);
    if (!ws) return;
    try {
      const op = await get<unknown>(res, `/copilot/opener${wsQuery(ws.workspace)}`, ws.workspace);
      if (!op.ok) return;
      if (!isRecord(op.data)) {
        res.status(502).json({ success: false, error: 'Hester returned no opener' });
        return;
      }
      res.json({ success: true, data: buildTether(op.data as unknown as Opener, ws.workspace, spooledCount()) });
    } catch (err) {
      failed(res, 'read', err);
    }
  });

  app.post('/tether/capture', async (req: Request, res: Response) => {
    const p = res.locals.principal as Principal | undefined;
    res.locals.deviceCategory = 'capture';
    const body = isRecord(req.body) ? req.body : {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ success: false, error: 'text is required' });
      return;
    }
    if (text.length > CAPTURE_MAX_CHARS) {
      res.status(400).json({ success: false, error: `text must be at most ${CAPTURE_MAX_CHARS} characters` });
      return;
    }
    let cardId: string | null = null;
    if (body.card_id !== undefined && body.card_id !== null) {
      cardId = validCardId(body.card_id);
      if (!cardId) {
        res.status(400).json({ success: false, error: 'card_id must be a Page id' });
        return;
      }
    }
    if (body.input !== undefined && body.input !== null && body.input !== 'voice') {
      res.status(400).json({ success: false, error: "input must be 'voice'" });
      return;
    }
    const voice = body.input === 'voice';
    const ws = resolveCaptureWorkspace(body.workspace, null);
    if (!ws.ok) {
      res.status(400).json({ success: false, error: ws.error });
      return;
    }
    const logCapture = (id: string | null, spooled: boolean) =>
      logEvent({
        type: 'capture',
        workspace: ws.workspace,
        window_id: ws.window_id,
        actor: actorForPrincipal(p),
        data: {
          // The capture event's wire name for the id stays someday_id (metrics read it).
          ...(id ? { someday_id: id } : {}),
          text_chars: text.length,
          as: 'someday',
          spooled,
          via: 'tether',
          ...(voice ? { input: 'voice' } : {}),
          ...(cardId ? { card_id: cardId } : {}),
        },
      });
    try {
      const payload: IdeaPayload = {
        text,
        as: 'someday',
        source: { ...tetherSource(p), ...(cardId ? { card_id: cardId } : {}) },
        ...(ws.workspace ? { workspace: ws.workspace } : {}),
        ...(voice ? { input: 'voice' as const } : {}),
      };
      const r = await hester('POST', '/ideas', ws.workspace, payload);
      if (r.offline) {
        // Desk D2 §9.3: never lose a thought to an offline Hester.
        if (!spool(payload)) {
          res.status(503).json({ success: false, error: 'Hester is unreachable and the spool could not be written' });
          return;
        }
        logCapture(null, true);
        res.json({ success: true, data: { id: null, spooled: true } });
        return;
      }
      if (r.status < 200 || r.status >= 300) {
        res.status(r.status === 400 || r.status === 404 || r.status === 422 ? 400 : 502).json({ success: false, error: errorOf(r.body, r.status) });
        return;
      }
      const item = dataOf(r.body);
      const id = isRecord(item) ? str(item.id) : null;
      logCapture(id, false);
      res.json({ success: true, data: { id, spooled: false } });
    } catch (err) {
      failed(res, 'capture', err);
    }
  });

  app.get('/tether/desk', async (req: Request, res: Response) => {
    const ws = workspaceOf(req, res);
    if (!ws) return;
    try {
      const desk = await getDesk(res, ws.workspace);
      if (desk) res.json({ success: true, data: buildTetherDesk(desk) });
    } catch (err) {
      failed(res, 'desk', err);
    }
  });

  app.get('/tether/pages', async (req: Request, res: Response) => {
    const ws = workspaceOf(req, res);
    if (!ws) return;
    const limit = req.query.limit === undefined ? TETHER_PAGES_DEFAULT : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      res.status(400).json({ success: false, error: 'limit must be a positive integer' });
      return;
    }
    try {
      const desk = await getDesk(res, ws.workspace);
      if (desk) res.json({ success: true, data: buildTetherPages(desk, limit) });
    } catch (err) {
      failed(res, 'pages', err);
    }
  });

  app.get('/tether/pages/:id', async (req: Request, res: Response) => {
    const id = validCardId(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, error: 'not a Page id' });
      return;
    }
    const ws = workspaceOf(req, res);
    if (!ws) return;
    const textOnly = req.query.text_only === '1' || req.query.text_only === 'true';
    const page = (rest: string) => `/desk/pages/${id}${rest}${wsQuery(ws.workspace)}`;
    try {
      const [desk, text, answers, questions, references] = await Promise.all([
        getDesk(res, ws.workspace),
        get<{ text?: unknown }>(res, page('/page'), ws.workspace),
        textOnly ? Promise.resolve({ ok: true as const, data: [] }) : get<DeepAnswer[]>(res, page('/answers'), ws.workspace),
        textOnly ? Promise.resolve({ ok: true as const, data: [] }) : get<DeepQuestion[]>(res, page('/questions'), ws.workspace),
        textOnly ? Promise.resolve({ ok: true as const, data: [] }) : get<DeepReference[]>(res, page('/references'), ws.workspace),
      ]);
      if (!desk || !text.ok || !answers.ok || !questions.ok || !references.ok) return;
      const raw = desk.cards.find((c) => c.id === id);
      if (!raw) {
        res.status(404).json({ success: false, error: 'not found' });
        return;
      }
      const card = tetherCard(raw, areaMap(desk));
      const body = isRecord(text.data) && typeof text.data.text === 'string' ? text.data.text : '';
      const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
      const out = textOnly
        ? { card, text: cutText(body) }
        : buildTetherPage(card, body, list<DeepAnswer>(answers.data), list<DeepQuestion>(questions.data), list<DeepReference>(references.data));
      res.json({ success: true, data: out });
    } catch (err) {
      failed(res, 'page', err);
    }
  });

  app.get('/tether/pages/:id/assets/:name', async (req: Request, res: Response) => {
    const id = validCardId(req.params.id);
    const name = typeof req.params.name === 'string' && ASSET_NAME_RE.test(req.params.name) ? req.params.name : null;
    if (!id || !name) {
      res.status(400).json({ success: false, error: 'not a Page asset' });
      return;
    }
    const ws = workspaceOf(req, res);
    if (!ws) return;
    try {
      const r = await raw(`/desk/pages/${id}/assets/${name}${wsQuery(ws.workspace)}`, ws.workspace);
      if (r.offline) {
        offline(res);
        return;
      }
      if (r.status === 404) {
        res.status(404).json({ success: false, error: 'not found' });
        return;
      }
      if (r.status < 200 || r.status >= 300 || !ASSET_TYPES.has(r.contentType)) {
        res.status(502).json({ success: false, error: `Hester returned ${r.status}` });
        return;
      }
      res.set('Content-Type', r.contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(r.body);
    } catch (err) {
      failed(res, 'asset', err);
    }
  });

  app.get('/tether/drawer', async (req: Request, res: Response) => {
    const ws = workspaceOf(req, res);
    if (!ws) return;
    try {
      const [desk, ideas] = await Promise.all([
        getDesk(res, ws.workspace),
        get<unknown>(res, `/ideas${wsQuery(ws.workspace, 'status=open')}`, ws.workspace),
      ]);
      if (!desk || !ideas.ok) return;
      res.json({ success: true, data: buildTetherDrawer(desk, Array.isArray(ideas.data) ? ideas.data : []) });
    } catch (err) {
      failed(res, 'drawer', err);
    }
  });

  /** The window a send or its targets are for: 503 no_window when none has the workspace. */
  function windowFor(requested: unknown, res: Response): { state: WindowState; id: number; workspace: string | null } | null {
    const ws = resolveCaptureWorkspace(requested, null);
    const state = ws.ok && ws.window_id != null ? windowRegistry.get(ws.window_id) : undefined;
    if (!ws.ok || !state || ws.window_id == null) {
      res.status(503).json({ success: false, error: 'no_window' });
      return null;
    }
    return { state, id: ws.window_id, workspace: ws.workspace };
  }

  /** Targets for a window. Page titles come from Hester's Desk when it answers; offline, only the zoomed Page is named. */
  async function targetsFor(win: { state: WindowState; id: number; workspace: string | null }): Promise<SendTargets> {
    let ctx: Partial<LeeContext> = {};
    try {
      ctx = win.state.contextBridge.getContext();
    } catch {
      ctx = {};
    }
    const d = deepInfo();
    const deep = d && win.workspace && path.resolve(d.workspace) === path.resolve(win.workspace) ? d : null;
    const titles = new Map<string, string>();
    if (deep && deep.touched.length > 0) {
      const r = await hester('GET', `/desk${wsQuery(win.workspace)}`, win.workspace);
      const desk = !r.offline && r.status >= 200 && r.status < 300 ? dataOf(r.body) : null;
      if (isRecord(desk) && Array.isArray(desk.cards)) {
        for (const c of desk.cards as DeskCard[]) if (c && typeof c.id === 'string') titles.set(c.id, c.title ?? '');
      }
    }
    const panels = ctx.panels as Record<string, PanelContext | null> | undefined;
    const panel = ctx.focusedPanel ? panels?.[ctx.focusedPanel] : undefined;
    return buildTargets({
      tabs: Array.isArray(ctx.tabs) ? ctx.tabs : [],
      activeTabId: panel?.activeTabId ?? null,
      paletteOpen: paletteOpen.get(win.id) === true,
      deep,
      titles,
    });
  }

  app.get('/tether/targets', async (req: Request, res: Response) => {
    const win = windowFor(req.query.workspace, res);
    if (!win) return;
    try {
      res.json({ success: true, data: await targetsFor(win) });
    } catch (err) {
      failed(res, 'targets', err);
    }
  });

  app.post('/tether/send', async (req: Request, res: Response) => {
    const p = res.locals.principal as Principal | undefined;
    res.locals.deviceCategory = 'send';
    const check = checkSendRequest(req.body);
    if (!check.ok) {
      res.status(check.status).json({ success: false, error: check.error });
      return;
    }
    const win = windowFor(isRecord(req.body) ? req.body.workspace : undefined, res);
    if (!win) return;
    try {
      let target: SendTarget;
      if (check.target === 'focus') {
        const focus = (await targetsFor(win)).focus;
        if (!focus) {
          res.status(409).json({ success: false, error: 'no_target' });
          return;
        }
        target = focus;
      } else if (check.target.kind === 'tab') {
        // The tab as this window has it (label, kind, provider): it must be one of its PTY tabs.
        const ptyId = check.target.pty_id;
        let tabs: TabContext[] = [];
        try {
          tabs = win.state.contextBridge.getContext().tabs ?? [];
        } catch {
          tabs = [];
        }
        const tab = tabs.find((t) => t.ptyId === ptyId);
        const resolved = tab ? tabTarget(tab) : null;
        if (!resolved) {
          res.status(400).json({ success: false, error: 'target.pty_id is not a tab in that window' });
          return;
        }
        target = resolved;
      } else {
        target = check.target;
      }
      if (check.submit && (target.kind === 'page' || target.kind === 'board')) {
        res.status(400).json({ success: false, error: 'submit is not allowed for a Page' });
        return;
      }
      const send_id = `snd_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
      const from = tetherFrom(p);
      const outcome = await broker.deliver(
        win.state.browserWindow,
        { send_id, target, items: check.items, submit: check.submit, compose: check.compose, from },
        deps.sendTimeoutMs ?? TETHER_SEND_TIMEOUT_MS,
      );
      // Kinds and sizes only, never content (§4.2).
      logEvent({
        type: 'tether.send',
        workspace: win.workspace,
        window_id: win.id,
        actor: actorForPrincipal(p),
        data: {
          source_device: from.surface,
          target_kind: target.kind,
          submit: check.submit,
          items: check.items.map((it, n) => ({
            kind: it.kind,
            ...(it.kind === 'image' ? { source: it.source } : {}),
            ...(it.kind === 'text' && it.input ? { input: it.input } : {}),
            bytes: check.bytes[n],
          })),
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      });
      if (outcome.ok) {
        const result: SendResult = { send_id, delivered_to: target };
        res.json({ success: true, data: result });
      } else if (outcome.error === 'timeout') {
        res.status(504).json({ success: false, error: 'timeout', send_id });
      } else if (outcome.error === 'no_window') {
        res.status(503).json({ success: false, error: 'no_window', send_id });
      } else if (outcome.error === 'no_target') {
        res.status(409).json({ success: false, error: 'no_target', send_id });
      } else {
        res.status(502).json({ success: false, error: outcome.error ?? 'delivery_failed', send_id });
      }
    } catch (err) {
      failed(res, 'send', err);
    }
  });
}
