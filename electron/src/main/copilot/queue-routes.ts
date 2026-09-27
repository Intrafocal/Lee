/**
 * HTTP routes for the attention queue, focus, handoff, the Claude Code
 * hook relay and the status line relay (docs/15-Usage.md §3.1) on Lee main :9001.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §4.4, §5.6, §6.4;
 * Deep sessions: docs/plans/2026-09-26-deep-d1-contracts.md §2.1.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { Application, NextFunction, Request, Response } from 'express';
import type { PTYManager } from '../pty-manager';
import type { Actor, Principal } from '../../shared/copilot';
import { getCopilotQueue, HookHeaders, Outcome } from './queue';
import { hookPaths } from './hook-install';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req: Request): boolean {
  return LOOPBACK.has(req.socket?.remoteAddress ?? '');
}

function principalOf(res: Response): Principal | undefined {
  return res.locals?.principal as Principal | undefined;
}

/** HTTP humans are paired devices only; local-user exists only over IPC (§4.4). */
function deviceActor(p: Principal | undefined): Actor | null {
  if (p?.kind !== 'device') return null;
  return { kind: 'user', surface: 'device', device_id: p.device_id, device_kind: p.device_kind };
}

function requireHuman(res: Response): Actor | null {
  const actor = deviceActor(principalOf(res));
  if (!actor) {
    res.status(403).json({ success: false, error: 'Forbidden: this action needs a person (Lee or a paired device)' });
    return null;
  }
  return actor;
}

/**
 * Hooks come from the local hook script with the shared token. Until the
 * auth middleware sets a principal, a missing one counts as shared+loopback
 * (the inline middleware already checked the shared token).
 */
function hookAllowed(req: Request, res: Response): boolean {
  const p = principalOf(res);
  if (!p) return isLoopback(req);
  return p.kind === 'shared' && p.loopback;
}

function send<T>(res: Response, outcome: Outcome<T>): void {
  if (outcome.category) res.locals.deviceCategory = outcome.category;
  if (outcome.status === 204) {
    res.status(204).end();
    return;
  }
  if (typeof outcome.body === 'string') {
    res.status(outcome.status).type('text/plain').send(outcome.body);
    return;
  }
  if (outcome.status === 200) {
    res.status(200).json({ success: true, data: outcome.body });
    return;
  }
  const body = outcome.body as { error?: string } | null;
  res.status(outcome.status).json({ success: false, error: outcome.error ?? body?.error ?? 'failed', data: outcome.body });
}

function hookHeaders(req: Request): HookHeaders {
  const h = (name: string) => {
    const v = req.header(name);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  return { event: h('X-Lee-Hook-Event'), ptyId: h('X-Lee-Pty-Id'), windowId: h('X-Lee-Window-Id') };
}

/** Shared-token check for requests whose body failed to parse before auth ran. */
function sharedTokenMatches(req: Request): boolean {
  let token = '';
  try {
    token = fs.readFileSync(hookPaths().tokenFile, 'utf8').trim();
  } catch {
    return false;
  }
  const got = Buffer.from(req.header('authorization') ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return token.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function registerQueueRoutes(app: Application, deps: { ptyManager: PTYManager }): void {
  const q = () => getCopilotQueue(deps.ptyManager);
  let badHookLogged = false;

  app.get('/attention', (req: Request, res: Response) => {
    const snap = q().snapshot({ compact: req.query.compact === '1', all: req.query.all === '1' });
    res.json({ success: true, data: snap });
  });

  app.get('/attention/:id', (req: Request, res: Response) => {
    const item = q().getItem(req.params.id);
    if (!item) {
      res.status(404).json({ success: false, error: 'not found' });
      return;
    }
    res.json({ success: true, data: item });
  });

  app.post('/attention/:id/reply', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().reply(req.params.id, req.body ?? null, actor));
  });

  app.post('/attention/:id/snooze', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().snooze(req.params.id, req.body ?? null, actor));
  });

  app.post('/attention/:id/dismiss', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().dismiss(req.params.id, actor));
  });

  app.post('/attention/:id/wake', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().setWake(req.params.id, req.body?.wake, actor));
  });

  app.post('/attention/:id/open', (req: Request, res: Response) => {
    if (!requireHuman(res)) return;
    send(res, q().openItem(req.params.id));
  });

  app.get('/focus', (_req: Request, res: Response) => {
    res.json({ success: true, data: q().focusState() });
  });

  // Deep D1 §2.1: a device's focus start is Go deep with nothing open; stop
  // ends a Deep session with reason 'deep_end' and no rating.
  app.post('/focus/start', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().focusStart(req.body?.item ?? null, actor, 'device'));
  });

  app.post('/focus/stop', (_req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().focusStop(actor));
  });

  // Deep D1 §2.1. The renderer uses IPC; over HTTP only paired devices are people.
  app.post('/deep/start', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().deepStart(req.body ?? null, actor, 'device'));
  });

  app.post('/deep/end', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().deepEnd(req.body ?? null, actor));
  });

  // Desk D2 §9.2: the idle-end push's Extend, or End and rate (DeepIdleEndRequest).
  app.post('/deep/idle-end', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().deepIdleEnd(req.body ?? null, actor));
  });

  app.get('/away', (_req: Request, res: Response) => {
    res.json({ success: true, data: q().awayState() });
  });

  app.get('/handoff/proposals', (_req: Request, res: Response) => {
    res.json({ success: true, data: q().handoffProposals() });
  });

  app.post('/handoff/start', (req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    send(res, q().handoffStart(req.body ?? null, actor));
  });

  app.post('/handoff/end', (_req: Request, res: Response) => {
    const actor = requireHuman(res);
    if (!actor) return;
    res.json({ success: true, data: q().endHandoff('manual', actor) });
  });

  app.post('/agent/hook', (req: Request, res: Response) => {
    if (!hookAllowed(req, res)) {
      res.status(403).json({ success: false, error: 'Forbidden: hooks are accepted from this machine only' });
      return;
    }
    try {
      send(res, q().handleHook(hookHeaders(req), req.body));
    } catch (err) {
      deps.ptyManager.log('WARN', 'Copilot: hook handling failed', { error: String(err) });
      res.status(204).end();
    }
  });

  // docs/15-Usage.md §3.1: the status line relay (claude-statusline.sh), same callers as hooks.
  app.post('/agent/status', (req: Request, res: Response) => {
    if (!hookAllowed(req, res)) {
      res.status(403).json({ success: false, error: 'Forbidden: status lines are accepted from this machine only' });
      return;
    }
    try {
      send(res, q().handleStatus(hookHeaders(req), req.body));
    } catch (err) {
      deps.ptyManager.log('WARN', 'Copilot: status line handling failed', { error: String(err) });
      res.status(204).end();
    }
  });

  // express.json() runs before auth and rejects oversized (>100 KB) or
  // malformed hook bodies. Keep the hook's header-only information and
  // answer 204, so Claude is never affected.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || (req.path !== '/agent/hook' && req.path !== '/agent/status') || res.headersSent) {
      next(err);
      return;
    }
    if (!isLoopback(req) || !sharedTokenMatches(req)) {
      res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing token' });
      return;
    }
    if (req.path === '/agent/status') {
      res.status(204).end();
      return;
    }
    if (!badHookLogged) {
      badHookLogged = true;
      deps.ptyManager.log('WARN', 'Copilot: hook body could not be parsed; using headers only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      q().handleHook(hookHeaders(req), null);
    } catch {
      // best effort
    }
    res.status(204).end();
  });
}
