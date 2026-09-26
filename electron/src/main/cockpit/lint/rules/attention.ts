/**
 * Attention rules (contract v4 §7.3): time/timebox-exceeded, time/polish-loop,
 * time/q4-drift, focus/thrash and balance/q2-starved. Pure predicates over
 * Hester's cached tasks, human_balance and ingested events. The engine only
 * evaluates this family while the workspace's steward is active.
 */

import type { LeeEvent } from '../../../../shared/copilot';
import type { CockpitTask, LintFixResult } from '../../../../shared/cockpit';
import { num, tsOf } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';
import {
  FIX_EXTEND,
  FIX_LINK_GOAL,
  FIX_PARK,
  FIX_PROMOTE,
  FIX_SUPPRESS_ITEM,
  FIX_WRAP_UP,
  fixExtend,
  fixPark,
  fixPromote,
  fixWrapUp,
  openTasks,
  rendererAction,
  shortHash,
  taskLabel,
  taskOfFinding,
  taskRef,
} from './v4-common';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SESSION_KEEP_MS = 2 * 24 * HOUR;
const MAX_TURNS = 20;

function d(ev: LeeEvent): Record<string, unknown> {
  return (ev.data ?? {}) as Record<string, unknown>;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Per agent session: files written per finished turn, and the last activity.
 * Shared by polish-loop and q4-drift (each rule owns its own instance).
 */
export class AgentActivity {
  sessions = new Map<string, { pty: number | null; ws: string | null; last: number; current: Set<string>; turns: string[][] }>();

  ingest(ev: LeeEvent): void {
    const data = d(ev);
    const sid = typeof data.session_id === 'string' ? data.session_id : null;
    if (!sid) return;
    const ts = tsOf(ev);
    if (ev.type === 'agent.session_end' || ev.type === 'agent.exit') {
      this.sessions.delete(sid);
      return;
    }
    let s = this.sessions.get(sid);
    if (!s) {
      s = { pty: null, ws: ev.workspace, last: ts, current: new Set(), turns: [] };
      this.sessions.set(sid, s);
    }
    if (typeof data.pty_id === 'number') s.pty = data.pty_id;
    s.last = Math.max(s.last, ts);
    if (ev.type === 'agent.tool' && data.phase === 'post' && data.writes === true && data.failed !== true) {
      for (const f of strs(data.files)) s.current.add(f);
    } else if (ev.type === 'agent.turn_end') {
      s.turns.push([...s.current].sort());
      s.current = new Set();
      if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
    }
  }

  prune(now: number): void {
    for (const [id, s] of this.sessions) if (now - s.last > SESSION_KEEP_MS) this.sessions.delete(id);
  }

  /** The task's session: its agent session id, else any session on its agent PTY. */
  forTask(t: CockpitTask): { pty: number | null; last: number; turns: string[][] } | null {
    const sid = t.agent?.session_id;
    if (sid && this.sessions.has(sid)) return this.sessions.get(sid)!;
    const pty = t.agent?.pty_id;
    if (pty == null) return null;
    let best: { pty: number | null; last: number; turns: string[][] } | null = null;
    for (const s of this.sessions.values()) if (s.pty === pty && (!best || s.last > best.last)) best = s;
    return best;
  }
}

// ---------------------------------------------------------------------------

export const TIMEBOX_EXCEEDED = 'time/timebox-exceeded';

export function timeboxExceeded(t: CockpitTask): boolean {
  if (t.play || t.lead === 'human' || t.timebox_min == null || t.timebox_min <= 0) return false;
  return t.busy_ms / MIN > t.timebox_min;
}

export class TimeboxExceededRule implements LintRule {
  readonly id = TIMEBOX_EXCEEDED;
  readonly family = 'attention' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      if (ctx.config(TIMEBOX_EXCEEDED, ws).severity === 'off') continue;
      for (const t of openTasks(ctx.tasks(ws))) {
        if (!timeboxExceeded(t)) continue;
        out.push({
          rule: TIMEBOX_EXCEEDED,
          workspace: ws,
          subject: t.id,
          message: `${taskLabel(t)} is past its ${t.timebox_min} min timebox`,
          evidence: [`Agent busy ${Math.round(t.busy_ms / MIN)} min against a ${t.timebox_min} min timebox`],
          fixes: [FIX_WRAP_UP, FIX_EXTEND, FIX_PROMOTE, FIX_PARK],
          item_ref: taskRef(t),
          state_key: `${TIMEBOX_EXCEEDED}:${t.timebox_min}`,
        });
      }
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    const task = taskOfFinding(f, ctx);
    if (fixId === 'wrap-up') return fixWrapUp(task, ctx);
    if (fixId === 'extend') return fixExtend(task, ctx);
    if (fixId === 'promote-workstream') return fixPromote(task, ctx);
    if (fixId === 'park') return fixPark(task, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}

// ---------------------------------------------------------------------------

export const POLISH_LOOP = 'time/polish-loop';

/** The last `turns` turns each wrote files, and together no more than `maxFiles`. Pure. */
export function polishLoop(turns: string[][], n: number, maxFiles: number): string[] | null {
  if (turns.length < n) return null;
  const last = turns.slice(-n);
  if (last.some((t) => t.length === 0)) return null;
  const union = new Set(last.flat());
  return union.size <= maxFiles ? [...union].sort() : null;
}

export class PolishLoopRule implements LintRule {
  readonly id = POLISH_LOOP;
  readonly family = 'attention' as const;
  readonly consumes = ['agent.tool', 'agent.turn_end', 'agent.session_end', 'agent.exit'];
  readonly activity = new AgentActivity();

  ingest(ev: LeeEvent): void {
    this.activity.ingest(ev);
  }

  evaluate(ctx: LintContext): LintFinding[] {
    this.activity.prune(ctx.now);
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      const cfg = ctx.config(POLISH_LOOP, ws);
      if (cfg.severity === 'off') continue;
      const n = Math.max(2, num(cfg, 'turns', 6));
      const maxFiles = Math.max(1, num(cfg, 'max_files', 2));
      for (const t of openTasks(ctx.tasks(ws))) {
        if (t.play) continue;
        const s = this.activity.forTask(t);
        const files = s ? polishLoop(s.turns, n, maxFiles) : null;
        if (!files) continue;
        out.push({
          rule: POLISH_LOOP,
          workspace: ws,
          subject: t.id,
          message: `${taskLabel(t)} keeps reworking the same ${files.length === 1 ? 'file' : 'files'}`,
          evidence: [`The last ${n} turns each wrote only ${files.join(', ')}`],
          fixes: [FIX_WRAP_UP, FIX_PARK],
          item_ref: taskRef(t),
          state_key: `${POLISH_LOOP}:${shortHash(files)}:${Math.floor(s!.turns.length / n)}`,
        });
      }
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    const task = taskOfFinding(f, ctx);
    if (fixId === 'wrap-up') return fixWrapUp(task, ctx);
    if (fixId === 'park') return fixPark(task, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}

// ---------------------------------------------------------------------------

export const Q4_DRIFT = 'time/q4-drift';
const BUSY_WINDOW_MS = 10 * MIN;

export class Q4DriftRule implements LintRule {
  readonly id = Q4_DRIFT;
  readonly family = 'attention' as const;
  readonly consumes = ['agent.prompt', 'agent.tool', 'agent.turn_end', 'agent.session_end', 'agent.exit'];
  readonly activity = new AgentActivity();

  ingest(ev: LeeEvent): void {
    this.activity.ingest(ev);
  }

  evaluate(ctx: LintContext): LintFinding[] {
    this.activity.prune(ctx.now);
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      if (ctx.config(Q4_DRIFT, ws).severity === 'off') continue;
      for (const t of openTasks(ctx.tasks(ws))) {
        if (t.quadrant !== 'Q4' || t.play) continue;
        const s = this.activity.forTask(t);
        if (!s || ctx.now - s.last > BUSY_WINDOW_MS) continue;
        out.push({
          rule: Q4_DRIFT,
          workspace: ws,
          subject: t.id,
          message: `${taskLabel(t)} is neither important nor urgent, and its agent is busy`,
          evidence: [
            t.serves.length ? `Serves ${t.serves.join(', ')}, marked not important` : 'Serves no goal',
            `Agent active ${Math.max(0, Math.round((ctx.now - s.last) / MIN))} min ago; busy ${Math.round(t.busy_ms / MIN)} min so far`,
          ],
          fixes: [FIX_WRAP_UP, FIX_LINK_GOAL, FIX_PARK],
          item_ref: taskRef(t),
          state_key: `${Q4_DRIFT}:${t.overrides?.at ?? ''}:${t.urgency_cleared_at ?? ''}`,
        });
      }
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    const task = taskOfFinding(f, ctx);
    if (fixId === 'wrap-up') return fixWrapUp(task, ctx);
    if (fixId === 'link-goal') return rendererAction('link-goal', f, task?.id ?? f.subject);
    if (fixId === 'park') return fixPark(task, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}

// ---------------------------------------------------------------------------

export const FOCUS_THRASH = 'focus/thrash';

/** A focus item's identity for thrash counting; null for agent items (excluded). */
export function focusThrashKey(item: unknown): { key: string; workspace: string | null } | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const ws = typeof o.workspace === 'string' ? o.workspace : null;
  switch (o.kind) {
    case 'files': {
      // Adding a path to a files item is the same item; a new first path is a new one.
      const first = strs(o.paths)[0] ?? '';
      return { key: `files:${ws ?? ''}:${first}`, workspace: ws };
    }
    case 'task':
      return { key: `task:${ws ?? ''}:${String(o.task_id ?? '')}`, workspace: ws };
    case 'workspace':
      return { key: `workspace:${ws ?? ''}`, workspace: ws };
    default:
      return null;
  }
}

export class FocusThrashRule implements LintRule {
  readonly id = FOCUS_THRASH;
  readonly family = 'attention' as const;
  readonly consumes = ['focus.start', 'focus.item', 'focus.end'];
  private session: { id: string; items: Array<{ ts: number; key: string; ws: string | null }> } | null = null;

  ingest(ev: LeeEvent): void {
    const data = d(ev);
    const sid = typeof data.session_id === 'string' ? data.session_id : null;
    if (ev.type === 'focus.end') {
      if (!sid || this.session?.id === sid) this.session = null;
      return;
    }
    if (!sid) return;
    if (ev.type === 'focus.start' || !this.session || this.session.id !== sid) this.session = { id: sid, items: [] };
    const k = focusThrashKey(data.item);
    if (k) this.session.items.push({ ts: tsOf(ev), key: k.key, ws: k.workspace ?? ev.workspace });
    if (this.session.items.length > 200) this.session.items.splice(0, this.session.items.length - 200);
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const s = this.session;
    if (!s) return [];
    const recent = s.items.filter((i) => ctx.now - i.ts <= HOUR);
    if (recent.length === 0) return [];
    const ws = [...recent].reverse().find((i) => i.ws)?.ws ?? null;
    if (!ws) return [];
    const cfg = ctx.config(FOCUS_THRASH, ws);
    if (cfg.severity === 'off') return [];
    const n = Math.max(2, num(cfg, 'items_per_hour', 4));
    const distinct = [...new Set(recent.map((i) => i.key))];
    if (distinct.length < n) return [];
    return [
      {
        rule: FOCUS_THRASH,
        workspace: ws,
        subject: s.id,
        message: `Your focus moved between ${distinct.length} things in the last hour`,
        evidence: [`${distinct.length} different focus items in one focus session within 60 min (threshold ${n})`],
        fixes: [{ id: 'end-focus', label: 'End this focus session' }, FIX_SUPPRESS_ITEM],
        item_ref: null,
        state_key: `${FOCUS_THRASH}:${Math.floor(distinct.length / n)}`,
      },
    ];
  }

  async fix(_f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId !== 'end-focus') return { success: false, error: 'unknown_fix' };
    if (!ctx.effects.endFocus) return { success: false, error: 'unavailable' };
    const ok = await ctx.effects.endFocus();
    return ok ? { success: true, message: 'Focus ended' } : { success: false, error: 'No focus session' };
  }
}

// ---------------------------------------------------------------------------

export const Q2_STARVED = 'balance/q2-starved';

export class Q2StarvedRule implements LintRule {
  readonly id = Q2_STARVED;
  readonly family = 'attention' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      const cfg = ctx.config(Q2_STARVED, ws);
      if (cfg.severity === 'off') continue;
      const hb = ctx.humanBalance(ws);
      if (!hb) continue;
      const minShare = num(cfg, 'min_share', 0.1);
      const minFocusMs = num(cfg, 'min_focus_h', 5) * HOUR;
      const classified = hb.ms.Q1 + hb.ms.Q2 + hb.ms.Q3 + hb.ms.Q4 + hb.ms.play;
      if (classified < minFocusMs || classified <= 0) continue;
      const q2 = hb.ms.Q2 / classified;
      if (q2 >= minShare) continue;
      out.push({
        rule: Q2_STARVED,
        workspace: ws,
        subject: 'week',
        message: `Only ${Math.round(q2 * 100)}% of your focus went to important, not-urgent work this week`,
        evidence: [
          `${(hb.ms.Q2 / HOUR).toFixed(1)} h Q2 of ${(classified / HOUR).toFixed(1)} h classified focus (target at least ${Math.round(minShare * 100)}%)`,
          ...(hb.line ? [hb.line] : []),
        ],
        fixes: [{ id: 'what-next', label: 'What next?' }],
        item_ref: null,
        state_key: `${Q2_STARVED}:${Math.floor(q2 * 20)}`,
      });
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string): Promise<LintFixResult> {
    if (fixId !== 'what-next') return { success: false, error: 'unknown_fix' };
    return rendererAction('what-next', f, null);
  }
}
