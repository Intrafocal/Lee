/**
 * Principals for Lee's HTTP/WS API (contracts §4.3–§4.5).
 *
 * - The shared ~/.lee/api-token → { kind: 'shared', loopback, ip }.
 * - A per-device token from ~/.lee/devices/ → { kind: 'device', … }.
 *
 * Also attributes device traffic into the event log: non-GET requests become
 * `device.request`, GETs, WebSocket opens and PTY WebSocket input are counted
 * per device per minute into `device.views`. Legacy LAN clients holding the
 * shared token are attributed as `legacy:<ip>`.
 */

import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type express from 'express';
import type { Actor, Principal } from '../../shared/copilot';
import { logEvent } from './bus';
import type { DeviceTokenStore } from './device-tokens';

type DevicePrincipal = Extract<Principal, { kind: 'device' }>;

interface AuthRuntime {
  store: DeviceTokenStore | null;
  onDeviceActivity: ((principal: DevicePrincipal) => void) | null;
}

const runtime: AuthRuntime = { store: null, onDeviceActivity: null };

/** Open WebSocket sockets per device, so revocation can close them. */
const deviceSockets = new Map<string, Set<Socket>>();

const VIEW_WINDOW_MS = 60_000;
interface ViewCounter {
  device_kind: string;
  views: number;
  pty_input: number;
}
const viewCounters = new Map<string, ViewCounter>();
let viewTimer: ReturnType<typeof setInterval> | null = null;

export function configureAuth(opts: {
  store: DeviceTokenStore;
  onDeviceActivity?: (principal: DevicePrincipal) => void;
}): void {
  runtime.store = opts.store;
  runtime.onDeviceActivity = opts.onDeviceActivity ?? null;
}

export function getDeviceStore(): DeviceTokenStore | null {
  return runtime.store;
}

export function normalizeIp(raw: string | undefined | null): string {
  const ip = raw || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function authenticateToken(
  token: string | null | undefined,
  ip: string,
  sharedToken: string,
): Principal | null {
  if (!token) return null;
  const addr = normalizeIp(ip);
  if (sharedToken && safeEqual(token, sharedToken)) {
    return { kind: 'shared', loopback: isLoopbackIp(ip) || isLoopbackIp(addr), ip: addr };
  }
  const store = runtime.store;
  if (!store) return null;
  const rec = store.verify(token);
  if (!rec) return null;
  store.touch(rec.device_id, addr);
  const principal: DevicePrincipal = {
    kind: 'device',
    device_id: rec.device_id,
    name: rec.name,
    device_kind: rec.kind,
    ip: addr,
  };
  try {
    runtime.onDeviceActivity?.(principal);
  } catch {
    // presence must never break auth
  }
  return principal;
}

function isUnauthenticatedRoute(req: express.Request): boolean {
  if (req.method === 'OPTIONS') return true;
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/pair/poll')) return true;
  if (req.method === 'POST' && (req.path === '/pair/request' || req.path === '/pair/redeem')) return true;
  return false;
}

/** The identity used for device attribution, or null for principals that aren't attributed. */
function deviceIdentity(principal: Principal | undefined): { device_id: string; device_kind: string } | null {
  if (!principal) return null;
  if (principal.kind === 'device') return { device_id: principal.device_id, device_kind: principal.device_kind };
  if (principal.kind === 'shared' && !principal.loopback) return { device_id: `legacy:${principal.ip}`, device_kind: 'legacy' };
  return null;
}

export function actorForPrincipal(principal: Principal | undefined): Actor {
  if (!principal || principal.kind === 'local-user') return { kind: 'user', surface: 'lee' };
  if (principal.kind === 'device') {
    return { kind: 'user', surface: 'device', device_id: principal.device_id, device_kind: principal.device_kind };
  }
  if (!principal.loopback) {
    return { kind: 'user', surface: 'device', device_id: `legacy:${principal.ip}`, device_kind: 'legacy' };
  }
  return { kind: 'user', surface: 'lee' };
}

const CATEGORY_TABLE: Array<[string, string, string]> = [
  ['POST', '/capture', 'capture'],
  ['POST', '/handoff/start', 'launch'],
  ['POST', '/focus/start', 'start_work'],
  ['POST', '/focus/stop', 'start_work'],
  ['POST', '/attention/:id/snooze', 'triage'],
  ['POST', '/attention/:id/dismiss', 'triage'],
  ['POST', '/attention/:id/wake', 'triage'],
  ['POST', '/attention/:id/open', 'triage'],
  ['POST', '/handoff/end', 'triage'],
  ['POST', '/command', 'command'],
];

export function defaultDeviceCategory(method: string, route: string): string {
  for (const [m, r, c] of CATEGORY_TABLE) if (m === method && r === route) return c;
  return 'other';
}

function attributeRequest(req: express.Request, res: express.Response, principal: Principal): void {
  const who = deviceIdentity(principal);
  if (!who) return;
  if (req.method === 'GET' || req.method === 'HEAD') {
    bumpView(who, 'views');
    return;
  }
  const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : '(unmatched)';
  const category =
    typeof res.locals.deviceCategory === 'string' ? res.locals.deviceCategory : defaultDeviceCategory(req.method, route);
  logEvent({
    type: 'device.request',
    actor: actorForPrincipal(principal),
    data: {
      device_id: who.device_id,
      device_kind: who.device_kind,
      method: req.method,
      route,
      status: res.statusCode,
      category,
    },
  });
}

export function copilotAuthMiddleware(getSharedToken: () => string): express.RequestHandler {
  return (req, res, next) => {
    if (isUnauthenticatedRoute(req)) {
      next();
      return;
    }
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const principal = authenticateToken(token, req.socket?.remoteAddress || req.ip || '', getSharedToken());
    if (!principal) {
      res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing token' });
      return;
    }
    res.locals.principal = principal;
    if (deviceIdentity(principal)) {
      res.on('finish', () => {
        try {
          attributeRequest(req, res, principal);
        } catch (err) {
          console.error('[copilot] device attribution failed:', err);
        }
      });
    }
    next();
  };
}

/**
 * Authenticate a WebSocket upgrade by its ?token= query parameter. Device
 * sockets are remembered so revoking the device closes them, and every
 * non-PTY socket open counts as a device view (PTY opens are counted by the
 * PTY stream handler).
 */
export function authenticateWsToken(request: IncomingMessage, sharedToken: string): Principal | null {
  let token: string | null = null;
  let pathname = '';
  try {
    const url = new URL(request.url || '', 'http://localhost');
    token = url.searchParams.get('token');
    pathname = url.pathname;
  } catch {
    return null;
  }
  const principal = authenticateToken(token, request.socket?.remoteAddress || '', sharedToken);
  if (!principal) return null;
  if (principal.kind === 'device' && request.socket) {
    const sock = request.socket;
    let set = deviceSockets.get(principal.device_id);
    if (!set) {
      set = new Set();
      deviceSockets.set(principal.device_id, set);
    }
    set.add(sock);
    sock.once('close', () => {
      const s = deviceSockets.get(principal.device_id);
      if (!s) return;
      s.delete(sock);
      if (s.size === 0) deviceSockets.delete(principal.device_id);
    });
  }
  if (!/^\/pty\/\d+\/stream$/.test(pathname)) noteDeviceView(principal);
  return principal;
}

export function requirePrincipal(...kinds: Array<Principal['kind']>): express.RequestHandler {
  return (_req, res, next) => {
    const p = res.locals.principal as Principal | undefined;
    if (!p || !kinds.includes(p.kind)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    next();
  };
}

export function requireLoopbackShared(): express.RequestHandler {
  return (_req, res, next) => {
    const p = res.locals.principal as Principal | undefined;
    if (!p || p.kind !== 'shared' || !p.loopback) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    next();
  };
}

function bumpView(who: { device_id: string; device_kind: string }, field: 'views' | 'pty_input'): void {
  let c = viewCounters.get(who.device_id);
  if (!c) {
    c = { device_kind: who.device_kind, views: 0, pty_input: 0 };
    viewCounters.set(who.device_id, c);
  }
  c[field]++;
  if (!viewTimer) {
    viewTimer = setInterval(flushDeviceViews, VIEW_WINDOW_MS);
    viewTimer.unref?.();
  }
}

export function noteDeviceView(principal: Principal | undefined): void {
  const who = deviceIdentity(principal);
  if (who) bumpView(who, 'views');
}

export function noteDeviceWsInput(principal: Principal | undefined): void {
  const who = deviceIdentity(principal);
  if (!who) return;
  bumpView(who, 'pty_input');
  if (principal && principal.kind === 'device') {
    try {
      runtime.onDeviceActivity?.(principal);
    } catch {
      // ignore
    }
  }
}

/** Write the per-minute device.views lines and reset the counters. */
export function flushDeviceViews(): void {
  if (viewCounters.size === 0) {
    if (viewTimer) {
      clearInterval(viewTimer);
      viewTimer = null;
    }
    return;
  }
  const entries = [...viewCounters.entries()];
  viewCounters.clear();
  for (const [device_id, c] of entries) {
    const actor: Actor = { kind: 'user', surface: 'device', device_id, device_kind: c.device_kind };
    if (c.views > 0) {
      logEvent({
        type: 'device.views',
        actor,
        data: { device_id, device_kind: c.device_kind, count: c.views, window_s: 60 },
      });
    }
    if (c.pty_input > 0) {
      logEvent({
        type: 'device.views',
        actor,
        data: { device_id, device_kind: c.device_kind, count: c.pty_input, window_s: 60, category: 'pty_input' },
      });
    }
  }
}

/** Issue a device token, persist its record and log `device.paired`. */
export function issueDeviceToken(opts: {
  name: string;
  kind: string;
  via: 'code' | 'qr' | 'manual';
  ip?: string;
}): { token: string; device_id: string; record: ReturnType<DeviceTokenStore['issue']>['record'] } {
  const store = runtime.store;
  if (!store) throw new Error('Device token store not initialized');
  const { record, token } = store.issue(opts);
  logEvent({
    type: 'device.paired',
    data: {
      device_id: record.device_id,
      name: record.name,
      kind: record.kind,
      via: opts.via,
      ...(opts.ip ? { ip: opts.ip } : {}),
    },
  });
  return { token, device_id: record.device_id, record };
}

/** Revoke a device: reject its token everywhere, close its open sockets, log `device.revoked`. */
export function revokeDevice(deviceId: string, actor?: Actor): boolean {
  const store = runtime.store;
  if (!store || !store.revoke(deviceId)) return false;
  const socks = deviceSockets.get(deviceId);
  if (socks) {
    for (const s of socks) {
      try {
        s.destroy();
      } catch {
        // already gone
      }
    }
    deviceSockets.delete(deviceId);
  }
  logEvent({ type: 'device.revoked', actor, data: { device_id: deviceId } });
  return true;
}
