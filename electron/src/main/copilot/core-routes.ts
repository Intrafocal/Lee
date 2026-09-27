/**
 * Package A HTTP routes on Lee main :9001 (contracts §2.6, §3.3, §4.2, §4.4, §10.A).
 *
 *   POST   /events/ingest   Hester (shared token, loopback only)
 *   GET    /presence        any principal
 *   GET    /devices         shared loopback: all; device: itself only
 *   DELETE /devices/:id     shared loopback: any; device: itself only
 *   POST   /pair/redeem     unauthenticated; single-use QR ticket → device token
 *   POST   /capture         any principal; relayed to Hester's Someday store
 */

import type { Application, Request, Response } from 'express';
import type { AnswerStatus, DeepAnswerEvent } from '../../shared/cockpit';
import { COPILOT_IPC } from '../../shared/copilot';
import type { Actor, CaptureRequest, LeeEventType, Principal } from '../../shared/copilot';
import { windowRegistry } from '../window-registry';
import { copilotBus, logEvent } from './bus';
import { actorForPrincipal, getDeviceStore, issueDeviceToken, normalizeIp, requireLoopbackShared, revokeDevice } from './auth';
import { getCaptureRelay, resolveCaptureWorkspace, setHesterPortProvider } from './capture';

export interface CoreRoutesDeps {
  getHesterPort: () => number;
  getPairingName: () => string;
  isPairingEnabled: () => boolean;
  log: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, any>) => void;
}

const INGEST_MAX = 500;
const INGEST_TYPES = new Set<LeeEventType>([
  'model.call',
  'someday.triage',
  'digest.shown',
  'retro.shown',
  'retro.answered',
  // v4
  'task.override',
  'steward.request',
  'steward.quiet',
  'proposal.outcome',
  // Deep D1 §6, §8.1
  'deep.answer',
  'opener.shown',
]);

const ANSWER_STATUSES = new Set<AnswerStatus>(['queued', 'running', 'done', 'error', 'interrupted']);
const DEEP_ID_MAX = 128;
const DEEP_WORKSPACE_MAX = 4096;

/**
 * The ids-only DeepAnswerEvent in an ingested deep.answer's data, or null when
 * malformed. `data.workspace` wins; the event's own workspace is the fallback.
 */
export function deepAnswerEvent(data: unknown, eventWorkspace?: unknown): DeepAnswerEvent | null {
  if (!isPlainObject(data)) return null;
  const { exploration_id, answer_id, status } = data;
  const workspace = data.workspace ?? eventWorkspace;
  if (!isStr(workspace, DEEP_WORKSPACE_MAX) || !isStr(exploration_id, DEEP_ID_MAX) || !isStr(answer_id, DEEP_ID_MAX)) return null;
  if (!ANSWER_STATUSES.has(status as AnswerStatus)) return null;
  return { workspace, exploration_id, answer_id, status: status as AnswerStatus };
}

/**
 * Send a deep.answer to every renderer window (IPC deep:answer). It raises no
 * attention item: the answer arrives quietly in the Page's margin (Deep D1 §6).
 * Returns how many windows it went to.
 */
export function forwardDeepAnswer(ev: DeepAnswerEvent): number {
  let n = 0;
  for (const ws of windowRegistry.getAll().values()) {
    try {
      if (ws.browserWindow.isDestroyed()) continue;
      ws.browserWindow.webContents.send(COPILOT_IPC.deepAnswer, ev);
      n++;
    } catch {
      // window closing
    }
  }
  return n;
}

const REDEEM_LIMIT = 10;
const REDEEM_WINDOW_MS = 60_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** Accept an Actor only if it has exactly one of the contract's shapes. */
export function parseActor(v: unknown): Actor | null {
  if (!isPlainObject(v)) return null;
  switch (v.kind) {
    case 'hester':
      return { kind: 'hester' };
    case 'system':
      return { kind: 'system' };
    case 'user':
      if (v.surface === 'lee') return { kind: 'user', surface: 'lee' };
      if (v.surface === 'device' && isStr(v.device_id, 128) && isStr(v.device_kind, 64)) {
        return { kind: 'user', surface: 'device', device_id: v.device_id, device_kind: v.device_kind };
      }
      return null;
    case 'agent':
      if (!isStr(v.provider, 64)) return null;
      return {
        kind: 'agent',
        provider: v.provider,
        session_id: isStr(v.session_id, 128) ? v.session_id : null,
        pty_id: typeof v.pty_id === 'number' && Number.isInteger(v.pty_id) ? v.pty_id : null,
      };
    default:
      return null;
  }
}

function sanitizeName(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '?');
}

/** Same rules as validatePairingBody for device/kind. */
export function validateDeviceNameKind(
  device: unknown,
  kind: unknown,
): { ok: true; device: string; kind: string } | { ok: false; reason: string } {
  const d = typeof device === 'string' ? device.trim() : '';
  if (!d || d.length > 64) return { ok: false, reason: 'device must be 1-64 characters' };
  const k = typeof kind === 'string' ? kind.trim() : '';
  if (!k || k.length > 32) return { ok: false, reason: 'kind must be 1-32 characters' };
  return { ok: true, device: sanitizeName(d), kind: sanitizeName(k) };
}

export function captureSourceFor(principal: Principal | undefined): { surface: string; device_id?: string } {
  if (!principal || principal.kind === 'local-user') return { surface: 'lee' };
  if (principal.kind === 'device') {
    const surface = principal.device_kind === 'aeronaut' || principal.device_kind === 'dirigible' ? principal.device_kind : 'device';
    return { surface, device_id: principal.device_id };
  }
  return { surface: 'shared' };
}

export function registerCoreRoutes(app: Application, deps: CoreRoutesDeps): void {
  setHesterPortProvider(deps.getHesterPort);
  const redeemAttempts = new Map<string, number[]>();

  app.post('/events/ingest', requireLoopbackShared(), (req: Request, res: Response) => {
    const events = isPlainObject(req.body) ? req.body.events : undefined;
    if (!Array.isArray(events)) {
      res.status(400).json({ success: false, error: 'events must be an array' });
      return;
    }
    if (events.length > INGEST_MAX) {
      res.status(400).json({ success: false, error: `at most ${INGEST_MAX} events per request` });
      return;
    }
    let accepted = 0;
    const rejected: Array<{ index: number; reason: string }> = [];
    events.forEach((raw: unknown, index: number) => {
      if (!isPlainObject(raw)) {
        rejected.push({ index, reason: 'event must be an object' });
        return;
      }
      if (typeof raw.type !== 'string' || !INGEST_TYPES.has(raw.type as LeeEventType)) {
        rejected.push({ index, reason: 'type not allowed' });
        return;
      }
      if (!isPlainObject(raw.data)) {
        rejected.push({ index, reason: 'data must be an object' });
        return;
      }
      logEvent({
        type: raw.type as LeeEventType,
        source: 'hester',
        workspace: typeof raw.workspace === 'string' && raw.workspace ? raw.workspace : null,
        window_id: typeof raw.window_id === 'number' && Number.isInteger(raw.window_id) ? raw.window_id : null,
        actor: parseActor(raw.actor) ?? { kind: 'hester' },
        data: raw.data,
      });
      if (raw.type === 'deep.answer') {
        const ev = deepAnswerEvent(raw.data, raw.workspace);
        if (ev) forwardDeepAnswer(ev);
      }
      accepted++;
    });
    res.json({ success: true, data: { accepted, rejected } });
  });

  app.get('/presence', (_req: Request, res: Response) => {
    const presence = copilotBus.getPresence();
    if (!presence) {
      res.status(503).json({ success: false, error: 'Presence not available' });
      return;
    }
    res.json({ success: true, data: presence });
  });

  app.get('/devices', (_req: Request, res: Response) => {
    const store = getDeviceStore();
    const p = res.locals.principal as Principal | undefined;
    if (!store) {
      res.status(503).json({ success: false, error: 'Device store not available' });
      return;
    }
    if (p?.kind === 'shared' && p.loopback) {
      res.json({ success: true, data: store.list() });
    } else if (p?.kind === 'device') {
      const own = store.get(p.device_id);
      res.json({ success: true, data: own ? [own] : [] });
    } else {
      res.status(403).json({ success: false, error: 'Forbidden' });
    }
  });

  app.delete('/devices/:id', (req: Request, res: Response) => {
    const store = getDeviceStore();
    const p = res.locals.principal as Principal | undefined;
    const id = req.params.id;
    if (!store) {
      res.status(503).json({ success: false, error: 'Device store not available' });
      return;
    }
    const allowed = (p?.kind === 'shared' && p.loopback) || (p?.kind === 'device' && p.device_id === id);
    if (!allowed) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    res.locals.deviceCategory = 'triage';
    if (!revokeDevice(id, p?.kind === 'device' ? actorForPrincipal(p) : { kind: 'system' })) {
      res.status(404).json({ success: false, error: 'Unknown or already revoked device' });
      return;
    }
    deps.log('INFO', 'Device revoked', { device_id: id });
    res.json({ success: true });
  });

  app.post('/pair/redeem', (req: Request, res: Response) => {
    if (!deps.isPairingEnabled()) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    const ip = normalizeIp(req.socket?.remoteAddress || req.ip);
    const now = Date.now();
    const recent = (redeemAttempts.get(ip) ?? []).filter((t) => now - t < REDEEM_WINDOW_MS);
    if (recent.length >= REDEEM_LIMIT) {
      redeemAttempts.set(ip, recent);
      res.status(429).json({ status: 'error', error: 'Too many attempts; try again in a minute' });
      return;
    }
    recent.push(now);
    redeemAttempts.set(ip, recent);
    for (const [k, times] of redeemAttempts) {
      if (times.every((t) => now - t >= REDEEM_WINDOW_MS)) redeemAttempts.delete(k);
    }

    const body = req.body;
    if (!isPlainObject(body) || typeof body.ticket !== 'string') {
      res.status(400).json({ status: 'error', error: 'ticket is required' });
      return;
    }
    const nk = validateDeviceNameKind(body.device, body.kind);
    if (!nk.ok) {
      res.status(400).json({ status: 'error', error: nk.reason });
      return;
    }
    const store = getDeviceStore();
    if (!store || !store.redeemTicket(body.ticket)) {
      res.status(410).json({ status: 'expired' });
      return;
    }
    try {
      const issued = issueDeviceToken({ name: nk.device, kind: nk.kind, via: 'qr', ip });
      deps.log('INFO', 'Device paired by QR ticket', { device_id: issued.device_id, device: nk.device, kind: nk.kind, ip });
      res.json({
        status: 'approved',
        token: issued.token,
        device_id: issued.device_id,
        hester_port: deps.getHesterPort(),
        name: deps.getPairingName(),
      });
    } catch (err) {
      deps.log('ERROR', 'Device token issuance failed', { error: String(err) });
      res.status(500).json({ status: 'error', error: 'Could not issue a device token' });
    }
  });

  app.post('/capture', async (req: Request, res: Response) => {
    const p = res.locals.principal as Principal | undefined;
    res.locals.deviceCategory = 'capture';
    const relay = getCaptureRelay();
    if (!relay) {
      res.status(503).json({ success: false, error: 'Capture not available' });
      return;
    }
    const body = (isPlainObject(req.body) ? req.body : {}) as Partial<CaptureRequest>;
    try {
      const ws = resolveCaptureWorkspace(body.workspace, null);
      if (!ws.ok) {
        res.status(400).json({ success: false, error: ws.error });
        return;
      }
      const result = await relay.capture(
        { text: body.text as string, as: body.as },
        { actor: actorForPrincipal(p), source: captureSourceFor(p), workspace: ws.workspace, window_id: ws.window_id },
      );
      // Same {success, data} envelope as every other :9001 route; Aeronaut
      // reads data, Dirigible accepts either shape.
      if (result.success) res.json({ success: true, data: result });
      else res.status(400).json({ success: false, error: result.error ?? 'Capture failed', data: result });
    } catch (err) {
      deps.log('ERROR', 'Capture failed', { error: String(err) });
      res.status(500).json({ success: false, error: 'Capture failed' });
    }
  });
}
