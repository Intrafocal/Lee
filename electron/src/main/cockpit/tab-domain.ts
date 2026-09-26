/**
 * The `tab` command domain (contract §5.3), reached through POST /command.
 * Tabs are addressed by pty_id; tab_id needs window_id when ambiguous.
 *
 * C3: the shared token can list, read and propose a check-in, never type.
 */

import type { Principal } from '../../shared/copilot';
import type { TabReadRequest } from '../../shared/cockpit';
import { windowRegistry } from '../window-registry';
import { cockpitBus, logCockpitEvent, type CommandDomainHandler, type CommandDomainResult } from './cockpit-bus';
import type { CheckinManager } from './checkin';
import type { TabRuntimeImpl } from './tab-runtime';
import { actorFor } from './tab-runtime';

const READ_FEED_TTL_MS = 5 * 60_000;

const ERROR_STATUS: Record<string, number> = {
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  ambiguous_tab: 409,
  busy: 409,
  awaiting_input: 409,
  state_unknown: 409,
  in_progress: 409,
  not_agent: 409,
  timeout: 504,
};

function fail(error: string): CommandDomainResult {
  return { status: ERROR_STATUS[error] ?? 400, body: { success: false, error } };
}

function ok(data: unknown, status = 200): CommandDomainResult {
  return { status, body: { success: true, data } };
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** pty_id, or tab_id (+ window_id). */
export function resolvePty(rt: TabRuntimeImpl, params: Record<string, unknown>): { pty_id: number } | { error: string } {
  const ptyId = num(params.pty_id);
  if (ptyId != null) return rt.exists(ptyId) ? { pty_id: ptyId } : { error: 'not_found' };
  const tabId = num(params.tab_id);
  if (tabId == null) return { error: 'invalid' };
  const windowId = num(params.window_id);
  const hits: number[] = [];
  for (const [id, w] of windowRegistry.getAll()) {
    if (windowId != null && id !== windowId) continue;
    let tabs;
    try {
      tabs = w.contextBridge.getContext().tabs;
    } catch {
      continue;
    }
    const t = tabs.find((x) => x.id === tabId);
    if (t) {
      if (t.ptyId == null) return { error: 'not_found' };
      hits.push(t.ptyId);
    }
  }
  if (hits.length === 0) return { error: 'not_found' };
  if (hits.length > 1) return { error: 'ambiguous_tab' };
  return { pty_id: hits[0] };
}

export function createTabDomain(rt: TabRuntimeImpl, checkins: CheckinManager): CommandDomainHandler {
  return async (action, params, principal) => {
    // HTTP always sets a principal; without one, act as the least-trusted local caller.
    const by: Principal = principal ?? { kind: 'shared', loopback: true, ip: '127.0.0.1' };
    if (by.kind === 'shared' && !by.loopback) return fail('forbidden');
    const p = params && typeof params === 'object' ? params : {};

    switch (action) {
      case 'list': {
        const ws = typeof p.workspace === 'string' && p.workspace ? p.workspace : null;
        const list = rt.list(ws, { withText: false });
        // Screen text reaches the shared token only through read_output, which
        // posts a "Hester read" notice; the list carries no tail for it.
        return ok(by.kind === 'shared' ? list.map((t) => ({ ...t, tail: [] })) : list);
      }
      case 'state': {
        const r = resolvePty(rt, p);
        if ('error' in r) return fail(r.error);
        return ok(rt.state(r.pty_id));
      }
      case 'read_output': {
        const r = resolvePty(rt, p);
        if ('error' in r) return fail(r.error);
        const req: TabReadRequest = {};
        const since = num(p.since);
        const lines = num(p.lines);
        const max = num(p.max_chars);
        if (since != null) req.since = since;
        if (lines != null) req.lines = lines;
        if (max != null) req.max_chars = max;
        const out = rt.read(r.pty_id, req);
        const nLines = out.text ? out.text.split('\n').length : 0;
        const ws = rt.workspaceOf(r.pty_id);
        logCockpitEvent('tab.read', {
          workspace: ws,
          window_id: rt.windowOf(r.pty_id),
          actor: actorFor(by),
          data: { pty_id: r.pty_id, chars: out.text.length, ...(req.since == null ? { lines: nLines } : {}) },
        });
        if (by.kind === 'shared') {
          cockpitBus.feed.post({
            workspace: ws,
            kind: 'event',
            severity: 'ambient',
            producer: 'tabs',
            title: `Hester read ${rt.labelOf(r.pty_id)} (${nLines} lines)`,
            ref: { pty_id: r.pty_id },
            ttl_ms: READ_FEED_TTL_MS,
            dedupe_key: `hester-read:${r.pty_id}`,
          });
        }
        return ok(out);
      }
      case 'send_input': {
        if (by.kind === 'shared') return fail('forbidden');
        const r = resolvePty(rt, p);
        if ('error' in r) return fail(r.error);
        if (typeof p.text !== 'string') return fail('invalid');
        const res = await rt.send(r.pty_id, { text: p.text, submit: p.submit === true, purpose: 'manual' }, by);
        if (!res.success) return fail(res.error ?? 'invalid');
        return ok(res);
      }
      case 'checkin': {
        const r = resolvePty(rt, p);
        if ('error' in r) return fail(r.error);
        if (by.kind === 'shared') {
          const info = rt.get(r.pty_id);
          if (!info || info.kind !== 'agent') return fail(info ? 'not_agent' : 'not_found');
          const entry = checkins.propose(r.pty_id, 'hester');
          if (!entry) return fail('not_agent');
          return ok({ success: false, proposed: true, entry_id: entry.id }, 202);
        }
        // Returns at once: {checkin_id, state: 'queued' | 'sent'}; the result
        // follows in the Feed and GET /cockpit/tabs (`checkin`).
        const res = await checkins.checkin(r.pty_id, { by });
        if (!res.success) return fail(res.error ?? 'invalid');
        return ok(res);
      }
      case 'checkin_cancel': {
        if (by.kind === 'shared') return fail('forbidden');
        const r = resolvePty(rt, p);
        if ('error' in r) return fail(r.error);
        const res = checkins.cancel(r.pty_id, by);
        if (!res.success) return fail(res.error ?? 'not_found');
        return ok(res);
      }
      default:
        return fail('invalid');
    }
  };
}
