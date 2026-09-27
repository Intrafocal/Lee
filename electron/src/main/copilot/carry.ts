/**
 * Carry for devices (docs/14-Deep-Work.md §8.1; cockpit design contract §8;
 * Desk D2 §9.3): Lee main routes that read and write a workspace's carried
 * thinking through Hester, so a phone or T-Deck needs only its Lee token.
 * Carry's pick-up is your last Desk card.
 *
 *   GET  /carry?workspace=<ws>   pick_up, open questions, counts, open_next, spooled
 *                                (Hester GET /copilot/opener + /copilot/open-next)
 *   POST /carry/capture          { workspace?, text, card_id? | exploration_id? } -> Hester POST /someday
 *   POST /carry/open-next        { workspace?, card_id? | exploration_id? | someday_id? } -> Hester POST /copilot/open-next
 *
 * Any authenticated principal, as for POST /capture. The workspace must be
 * an open window's; default the focused window's. Hester unreachable: GET
 * /carry and open-next answer 503 { error: 'hester_offline' }; a capture is
 * spooled (~/.lee/spool/someday.jsonl) and answers 200 { spooled: true }.
 *
 * A pre-Desk Hester's opener has no `card`: its exploration id stands in as
 * the card id, and ids that aren't page ids go back to Hester as
 * exploration_id, so captures and Open next still work against it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Application, Request, Response } from 'express';
import { encodeWorkspaceHeader } from '../../shared/cockpit';
import type { Opener } from '../../shared/cockpit';
import type { Principal } from '../../shared/copilot';
import { PAGE_ID_RE, type DeskCardKind } from '../../shared/desk';
import { actorForPrincipal } from './auth';
import { logEvent } from './bus';
import { CAPTURE_MAX_CHARS, getCaptureRelay, getHesterPort, resolveCaptureWorkspace, type SomedayPayload } from './capture';
import { captureSourceFor } from './core-routes';

const REQUEST_TIMEOUT_MS = 5000;
export const CARRY_QUESTIONS_MAX = 5;
const ID_MAX = 128;
const ID_RE = /^[A-Za-z0-9_.:-]+$/;

export interface CarryOpenNext {
  card_id?: string;
  exploration_id?: string;
  someday_id?: string;
  set_at: string;
}

export interface Carry {
  workspace: string;
  pick_up: {
    card_id: string;
    card_kind: DeskCardKind;
    title: string;
    area_name: string | null;
    stopped_at: string | null;
    stopped_line: number | null;
    last_touched_at: string | null;
    /** Legacy alias = card_id, for app and firmware builds before the Desk. */
    exploration_id: string;
  } | null;
  open_questions: Array<{ card_id: string; exploration_id: string; question_id: string; text: string }>;
  captured_count: number;
  reading_count: number;
  open_next: CarryOpenNext | null;
  /** Captures waiting in Lee's spool for Hester. */
  spooled: number;
}

/** A Hester call's result: offline (network error or timeout) or an HTTP answer. */
export type HesterResult = { offline: true } | { offline: false; status: number; body: unknown };

export type HesterCall = (method: 'GET' | 'POST', route: string, workspace: string | null, body?: unknown) => Promise<HesterResult>;

function readSharedToken(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.lee', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Lee main -> Hester with the shared token and X-Lee-Workspace. Never throws. */
export const hesterCall: HesterCall = async (method, route, workspace, body) => {
  let res: globalThis.Response;
  try {
    res = await fetch(`http://127.0.0.1:${getHesterPort()}${route}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${readSharedToken()}`,
        ...(workspace ? { 'X-Lee-Workspace': encodeWorkspaceHeader(workspace) } : {}),
      },
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

function validId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= ID_MAX && ID_RE.test(v) ? v : null;
}

/** A card id Hester takes as `card_id` when it's a page id, else as the pre-Desk `exploration_id`. */
export function cardRef(id: string): { card_id: string } | { exploration_id: string } {
  return PAGE_ID_RE.test(id) ? { card_id: id } : { exploration_id: id };
}

export function parseOpenNext(raw: unknown): CarryOpenNext | null {
  if (!isRecord(raw)) return null;
  const card_id = str(raw.card_id);
  const exploration_id = str(raw.exploration_id) ?? card_id;
  const someday_id = str(raw.someday_id);
  if (!exploration_id && !someday_id) return null;
  return {
    ...(card_id ? { card_id } : {}),
    ...(exploration_id ? { exploration_id } : {}),
    ...(someday_id ? { someday_id } : {}),
    set_at: str(raw.set_at) ?? new Date(0).toISOString(),
  };
}

function lineNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * The Carry view from Hester's opener (and open-next): your last Desk card,
 * or (a pre-Desk Hester) the exploration it picks up. That card's open
 * questions come first.
 */
export function buildCarry(opener: Opener, openNext: CarryOpenNext | null, fallbackWorkspace: string | null, spooled = 0): Carry {
  const p = opener.pick_up;
  const card = p?.card && typeof p.card.id === 'string' && p.card.id ? p.card : null;
  const id = card?.id ?? (p?.exploration?.id || null);
  const pick_up: Carry['pick_up'] = p && id
    ? {
        card_id: id,
        card_kind: 'page',
        title: card?.title ?? p.exploration?.title ?? '',
        area_name: card?.area_name ?? null,
        stopped_at: p.stopped_at ?? null,
        stopped_line: lineNumber(p.stopped_line),
        last_touched_at: card?.last_touched_at ?? p.exploration?.last_touched_at ?? null,
        exploration_id: id,
      }
    : null;
  let questions: Carry['open_questions'] = [];
  let captured = 0;
  let reading = 0;
  for (const s of opener.surfaces ?? []) {
    if (s.kind === 'open_questions') {
      questions = (s.items ?? [])
        .filter((q) => q && (q.card_id || q.exploration_id) && q.question_id && typeof q.text === 'string')
        .map((q) => {
          const qid = (q.card_id || q.exploration_id) as string;
          return { card_id: qid, exploration_id: qid, question_id: q.question_id, text: q.text };
        });
    } else if (s.kind === 'captured_away') {
      captured = typeof s.count === 'number' ? s.count : s.items?.length ?? 0;
    } else if (s.kind === 'reading_list') {
      reading = typeof s.count === 'number' ? s.count : s.items?.length ?? 0;
    }
  }
  if (pick_up) {
    const mine = questions.filter((q) => q.card_id === pick_up.card_id);
    questions = [...mine, ...questions.filter((q) => q.card_id !== pick_up.card_id)];
  }
  return {
    workspace: opener.workspace || fallbackWorkspace || '',
    pick_up,
    open_questions: questions.slice(0, CARRY_QUESTIONS_MAX),
    captured_count: captured,
    reading_count: reading,
    open_next: openNext,
    spooled,
  };
}

/** Where a Carry write came from: the device's kind, else 'lee' (the renderer). */
export function carrySource(p: Principal | undefined): { surface: string; device_id?: string } {
  return p?.kind === 'device' ? captureSourceFor(p) : { surface: 'lee' };
}

function offline(res: Response): void {
  res.status(503).json({ success: false, error: 'hester_offline' });
}

function wsQuery(ws: string | null): string {
  return ws ? `?workspace=${encodeURIComponent(ws)}` : '';
}

export interface CarryRoutesDeps {
  /** Tests inject a fake; defaults to the real Hester. */
  hester?: HesterCall;
  /** Spool a capture Hester couldn't take; false when it couldn't be written. Defaults to the capture relay's spool. */
  spool?: (payload: SomedayPayload) => boolean;
  /** Captures waiting in the spool. Defaults to the capture relay's. */
  spooledCount?: () => number;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
}

export function registerCarryRoutes(app: Application, deps: CarryRoutesDeps = {}): void {
  const hester = deps.hester ?? hesterCall;
  const spool = deps.spool ?? ((payload: SomedayPayload) => getCaptureRelay()?.spool(payload) ?? false);
  const spooledCount = deps.spooledCount ?? (() => getCaptureRelay()?.pending() ?? 0);

  app.get('/carry', async (req: Request, res: Response) => {
    const ws = resolveCaptureWorkspace(req.query.workspace, null);
    if (!ws.ok) {
      res.status(400).json({ success: false, error: ws.error });
      return;
    }
    try {
      const q = wsQuery(ws.workspace);
      const [op, nx] = await Promise.all([
        hester('GET', `/copilot/opener${q}`, ws.workspace),
        hester('GET', `/copilot/open-next${q}`, ws.workspace),
      ]);
      if (op.offline) {
        offline(res);
        return;
      }
      if (op.status < 200 || op.status >= 300) {
        res.status(502).json({ success: false, error: errorOf(op.body, op.status) });
        return;
      }
      const opener = dataOf(op.body);
      if (!isRecord(opener)) {
        res.status(502).json({ success: false, error: 'Hester returned no opener' });
        return;
      }
      // open-next is optional: an older Hester without it still gives a Carry view.
      const openNext = !nx.offline && nx.status >= 200 && nx.status < 300 ? parseOpenNext(dataOf(nx.body)) : null;
      res.json({ success: true, data: buildCarry(opener as unknown as Opener, openNext, ws.workspace, spooledCount()) });
    } catch (err) {
      deps.log?.('ERROR', 'Carry read failed', { error: String(err) });
      res.status(500).json({ success: false, error: 'Carry failed' });
    }
  });

  app.post('/carry/capture', async (req: Request, res: Response) => {
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
    // card_id, else the legacy exploration_id: the card the thought is about.
    const rawId = body.card_id ?? body.exploration_id;
    let cardId: string | null = null;
    if (rawId !== undefined && rawId !== null) {
      cardId = validId(rawId);
      if (!cardId) {
        res.status(400).json({ success: false, error: 'card_id must be a card id' });
        return;
      }
    }
    const ws = resolveCaptureWorkspace(body.workspace, null);
    if (!ws.ok) {
      res.status(400).json({ success: false, error: ws.error });
      return;
    }
    const logCapture = (someday_id: string | null, spooled: boolean) =>
      logEvent({
        type: 'capture',
        workspace: ws.workspace,
        window_id: ws.window_id,
        actor: actorForPrincipal(p),
        data: {
          ...(someday_id ? { someday_id } : {}),
          text_chars: text.length,
          as: 'someday',
          spooled,
          via: 'carry',
          ...(cardId ? cardRef(cardId) : {}),
        },
      });
    try {
      const payload: SomedayPayload = {
        text,
        as: 'someday',
        source: { ...carrySource(p), ...(cardId ? cardRef(cardId) : {}) },
        ...(ws.workspace ? { workspace: ws.workspace } : {}),
      };
      const r = await hester('POST', '/someday', ws.workspace, payload);
      if (r.offline) {
        // Desk D2 §9.3: never lose a thought to an offline Hester.
        if (!spool(payload)) {
          res.status(503).json({ success: false, error: 'Hester is unreachable and the spool could not be written' });
          return;
        }
        logCapture(null, true);
        res.json({ success: true, data: { success: true, someday_id: null, spooled: true } });
        return;
      }
      if (r.status < 200 || r.status >= 300) {
        res.status(r.status === 400 || r.status === 404 || r.status === 422 ? 400 : 502).json({ success: false, error: errorOf(r.body, r.status) });
        return;
      }
      const item = dataOf(r.body);
      const someday_id = isRecord(item) ? str(item.id) : null;
      logCapture(someday_id, false);
      res.json({ success: true, data: { success: true, someday_id, spooled: false } });
    } catch (err) {
      deps.log?.('ERROR', 'Carry capture failed', { error: String(err) });
      res.status(500).json({ success: false, error: 'Capture failed' });
    }
  });

  app.post('/carry/open-next', async (req: Request, res: Response) => {
    const p = res.locals.principal as Principal | undefined;
    res.locals.deviceCategory = 'start_work';
    const body = isRecord(req.body) ? req.body : {};
    const given = (['card_id', 'exploration_id', 'someday_id'] as const).filter((k) => body[k] != null);
    if (given.length !== 1) {
      res.status(400).json({ success: false, error: 'give exactly one of card_id, exploration_id or someday_id' });
      return;
    }
    const id = validId(body[given[0]]);
    if (!id) {
      res.status(400).json({ success: false, error: `${given[0]} must be an id` });
      return;
    }
    const somedayId = given[0] === 'someday_id' ? id : null;
    const ws = resolveCaptureWorkspace(body.workspace, null);
    if (!ws.ok) {
      res.status(400).json({ success: false, error: ws.error });
      return;
    }
    try {
      const r = await hester('POST', '/copilot/open-next', ws.workspace, {
        ...(somedayId ? { someday_id: somedayId } : cardRef(id)),
        surface: carrySource(p).surface,
        ...(ws.workspace ? { workspace: ws.workspace } : {}),
      });
      if (r.offline) {
        offline(res);
        return;
      }
      if (r.status < 200 || r.status >= 300) {
        res.status(r.status === 400 || r.status === 404 || r.status === 422 ? r.status : 502).json({ success: false, error: errorOf(r.body, r.status) });
        return;
      }
      res.json({ success: true, data: { open_next: parseOpenNext(dataOf(r.body)) } });
    } catch (err) {
      deps.log?.('ERROR', 'Carry open-next failed', { error: String(err) });
      res.status(500).json({ success: false, error: 'Open next failed' });
    }
  });
}
