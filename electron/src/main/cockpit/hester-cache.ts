/**
 * Hester cache (contract v4 §7.1): for each workspace with an open window,
 * polls Hester every 30 s (and on demand) for the task snapshot and the
 * steward state, and every 10 min for goal status (for human_balance).
 *
 * Deterministic and model-free: these are plain reads. If Hester is offline
 * the last good value is kept; with no good value yet, readers get null /
 * false and the rules that need them don't fire.
 *
 * Electron-free apart from the default workspace provider (window registry),
 * so the smoke test drives it with a fake fetch.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeWorkspaceHeader, type CockpitTask, type Quadrant } from '../../shared/cockpit';

const POLL_MS = 30_000;
const GOALS_POLL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 5000;

export interface StewardState {
  enabled: boolean;
  not_today_until: string | null;
  active: boolean;
}

export type BalanceBand = Quadrant | 'play' | 'unclassified';

export interface HumanBalance {
  share: number | null;
  ms: Record<BalanceBand, number>;
  by_goal: Record<string, number>;
  line: string | null;
}

export interface HesterCacheDeps {
  /** Workspaces with an open window. */
  workspaces(): string[];
  /** GET a Hester route for a workspace; resolves to the parsed JSON body or throws. */
  get(route: string, workspace: string): Promise<unknown>;
  now?: () => number;
}

interface WsEntry {
  tasks: CockpitTask[] | null;
  tasksAt: number;
  steward: StewardState | null;
  balance: HumanBalance | null;
  goalsAt: number;
  inflight: Promise<void> | null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Hester wraps route data as {success, data}; accept either shape. */
function unwrap(body: unknown): Record<string, unknown> | null {
  const o = obj(body);
  if (!o) return null;
  if (o.success === false) return null;
  return obj(o.data) ?? o;
}

const QUADRANTS = new Set(['Q1', 'Q2', 'Q3', 'Q4']);

/** Normalise one task from the snapshot (older daemons omit the v4 fields). */
export function normaliseTask(raw: unknown): CockpitTask | null {
  const t = obj(raw);
  if (!t || typeof t.id !== 'string') return null;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    ...(t as unknown as CockpitTask),
    quadrant: QUADRANTS.has(t.quadrant as string) ? (t.quadrant as Quadrant) : null,
    importance_rank: n(t.importance_rank),
    overrides: (obj(t.overrides) as CockpitTask['overrides']) ?? null,
    urgency_cleared_at: typeof t.urgency_cleared_at === 'string' ? t.urgency_cleared_at : null,
    files_at_first_report: n(t.files_at_first_report),
    serves: strs(t.serves),
    files: strs(t.files),
    files_count: n(t.files_count) ?? strs(t.files).length,
    busy_ms: n(t.busy_ms) ?? 0,
    timebox_min: n(t.timebox_min),
    play: t.play === true,
    agent: (obj(t.agent) as CockpitTask['agent']) ?? null,
  };
}

export function parseSteward(body: unknown): StewardState | null {
  const d = unwrap(body);
  if (!d || typeof d.active !== 'boolean') return null;
  return {
    enabled: d.enabled !== false,
    not_today_until: typeof d.not_today_until === 'string' ? d.not_today_until : null,
    active: d.active,
  };
}

export function parseBalance(body: unknown): HumanBalance | null {
  const d = unwrap(body);
  const hb = obj(d?.human_balance);
  if (!hb) return null;
  const msIn = obj(hb.ms) ?? {};
  const ms = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, play: 0, unclassified: 0 } as Record<BalanceBand, number>;
  for (const k of Object.keys(ms) as BalanceBand[]) {
    const v = msIn[k];
    if (typeof v === 'number' && Number.isFinite(v)) ms[k] = v;
  }
  const byGoal: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(hb.by_goal) ?? {})) if (typeof v === 'number') byGoal[k] = v;
  return {
    share: typeof hb.share === 'number' && Number.isFinite(hb.share) ? hb.share : null,
    ms,
    by_goal: byGoal,
    line: typeof hb.line === 'string' ? hb.line : null,
  };
}

export class HesterCache extends EventEmitter {
  private readonly deps: HesterCacheDeps;
  private readonly now: () => number;
  private entries = new Map<string, WsEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: HesterCacheDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private entry(ws: string): WsEntry {
    let e = this.entries.get(ws);
    if (!e) {
      e = { tasks: null, tasksAt: 0, steward: null, balance: null, goalsAt: 0, inflight: null };
      this.entries.set(ws, e);
    }
    return e;
  }

  start(pollMs = POLL_MS): void {
    if (this.timer) return;
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Poll every open workspace now (goal status only when due, or `force`). */
  async refreshAll(opts: { force?: boolean } = {}): Promise<void> {
    const open = new Set(this.deps.workspaces());
    for (const ws of [...this.entries.keys()]) if (!open.has(ws)) this.entries.delete(ws);
    await Promise.all([...open].map((ws) => this.refresh(ws, opts)));
  }

  /** On demand for one workspace. Concurrent calls share one request. */
  refresh(ws: string, opts: { force?: boolean } = {}): Promise<void> {
    const e = this.entry(ws);
    if (e.inflight) return e.inflight;
    e.inflight = this.doRefresh(ws, e, !!opts.force).finally(() => {
      e.inflight = null;
    });
    return e.inflight;
  }

  private async doRefresh(ws: string, e: WsEntry, force: boolean): Promise<void> {
    const before = JSON.stringify([e.tasks, e.steward, e.balance]);
    const snap = this.deps.get('/cockpit/snapshot', ws).then(
      (body) => {
        const d = unwrap(body);
        const tasks = obj(d?.tasks);
        if (!tasks) return;
        const list = [...(Array.isArray(tasks.open) ? tasks.open : []), ...(Array.isArray(tasks.recent_closed) ? tasks.recent_closed : [])];
        e.tasks = list.map(normaliseTask).filter((t): t is CockpitTask => t !== null);
        e.tasksAt = this.now();
      },
      () => undefined,
    );
    const steward = this.deps.get('/cockpit/steward', ws).then(
      (body) => {
        const s = parseSteward(body);
        if (s) e.steward = s;
      },
      () => undefined,
    );
    const jobs: Array<Promise<void>> = [snap, steward];
    if (force || this.now() - e.goalsAt >= GOALS_POLL_MS) {
      jobs.push(
        this.deps.get('/cockpit/goals/status?days=7', ws).then(
          (body) => {
            const b = parseBalance(body);
            if (b) {
              e.balance = b;
              e.goalsAt = this.now();
            }
          },
          () => undefined,
        ),
      );
    }
    await Promise.all(jobs);
    if (JSON.stringify([e.tasks, e.steward, e.balance]) !== before) this.emit('change', ws);
  }

  /** Open tasks plus those closed in the last 7 days; null before the first good read. */
  tasks(ws: string | null): CockpitTask[] | null {
    if (!ws) return null;
    return this.entries.get(ws)?.tasks ?? null;
  }

  task(ws: string | null, taskId: string): CockpitTask | null {
    return this.tasks(ws)?.find((t) => t.id === taskId) ?? null;
  }

  /** The task whose agent runs in this PTY (open tasks first). */
  taskByPty(ptyId: number | null): CockpitTask | null {
    if (ptyId == null) return null;
    let closed: CockpitTask | null = null;
    for (const e of this.entries.values()) {
      for (const t of e.tasks ?? []) {
        if (t.agent?.pty_id !== ptyId) continue;
        if (t.status !== 'done' && t.status !== 'discarded') return t;
        closed = closed ?? t;
      }
    }
    return closed;
  }

  findTask(taskId: string): CockpitTask | null {
    for (const e of this.entries.values()) {
      const t = e.tasks?.find((x) => x.id === taskId);
      if (t) return t;
    }
    return null;
  }

  steward(ws: string | null): StewardState | null {
    if (!ws) return null;
    return this.entries.get(ws)?.steward ?? null;
  }

  /** False until Hester has answered once (rules that need the steward don't fire). */
  stewardActive(ws: string | null): boolean {
    return this.steward(ws)?.active === true;
  }

  humanBalance(ws: string | null): HumanBalance | null {
    if (!ws) return null;
    return this.entries.get(ws)?.balance ?? null;
  }

  /** Test seam. */
  set(ws: string, v: { tasks?: CockpitTask[] | null; steward?: StewardState | null; balance?: HumanBalance | null }): void {
    const e = this.entry(ws);
    if (v.tasks !== undefined) e.tasks = v.tasks;
    if (v.steward !== undefined) e.steward = v.steward;
    if (v.balance !== undefined) e.balance = v.balance;
    this.emit('change', ws);
  }
}

// ---------------------------------------------------------------------------
// Singleton (Lee main)
// ---------------------------------------------------------------------------

function readSharedToken(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.lee', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** A Hester request from Lee main with the shared token and X-Lee-Workspace. Throws on network errors and non-2xx. */
export async function hesterRequest(
  port: number,
  method: 'GET' | 'POST' | 'PATCH',
  route: string,
  workspace: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${readSharedToken()}`,
      'X-Lee-Workspace': encodeWorkspaceHeader(workspace),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const o = obj(parsed);
    const err = typeof o?.error === 'string' ? o.error : typeof o?.detail === 'string' ? o.detail : `Hester returned ${res.status}`;
    throw new Error(err);
  }
  return parsed;
}

let instance: HesterCache | null = null;

/** The main-process cache; `start()` it once (tabs-main does). */
export function getHesterCache(deps?: Partial<HesterCacheDeps> & { getHesterPort?: () => number }): HesterCache {
  if (instance) return instance;
  const port = deps?.getHesterPort ?? (() => 9000);
  instance = new HesterCache({
    workspaces:
      deps?.workspaces ??
      (() => {
        // Lazy: keeps this module Electron-free until used in the app.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { windowRegistry } = require('../window-registry') as typeof import('../window-registry');
        const out = new Set<string>();
        for (const [, w] of windowRegistry.getAll()) if (w.workspace) out.add(w.workspace);
        return [...out];
      }),
    get: deps?.get ?? ((route, ws) => hesterRequest(port(), 'GET', route, ws)),
    now: deps?.now,
  });
  return instance;
}

/** The cache if it exists (never creates it). */
export function peekHesterCache(): HesterCache | null {
  return instance;
}
