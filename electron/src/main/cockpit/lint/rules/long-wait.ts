/**
 * toil/long-wait (contracts §8.3): you started an operation and sat at the
 * machine, idle, until it finished, several times this week. Pure.
 */

import type { LeeEvent } from '../../../../shared/copilot';
import type { LintFixResult } from '../../../../shared/cockpit';
import { DAY_MS, UNAVAILABLE, bucket, median, num, tsOf } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';

export const RULE_ID = 'toil/long-wait';

const KEEP_MS = 8 * DAY_MS;
const MAX_IDLE_KEYS = 20;

interface Run {
  ws: string;
  op: string;
  start: number;
  end: number | null;
  by: string;
  at_machine: boolean;
}

export class LongWaitRule implements LintRule {
  readonly id = RULE_ID;
  readonly family = 'toil' as const;
  readonly consumes = ['operation.run', 'operation.result', 'presence.change', 'input.counts'];
  private runs = new Map<string, Run>();
  /** Times at_machine went false. */
  private away: number[] = [];
  private keys: Array<{ ts: number; keys: number }> = [];

  ingest(ev: LeeEvent): void {
    const d = ev.data as Record<string, unknown>;
    const ts = tsOf(ev);
    switch (ev.type as string) {
      case 'operation.run': {
        if (!ev.workspace || typeof d.run_id !== 'string' || typeof d.op !== 'string') return;
        const prev = this.runs.get(d.run_id);
        this.runs.set(d.run_id, {
          ws: ev.workspace,
          op: d.op,
          start: ts,
          end: prev?.end ?? null,
          by: typeof d.by === 'string' ? d.by : '',
          at_machine: ev.ctx?.at_machine !== false,
        });
        return;
      }
      case 'operation.result': {
        if (typeof d.run_id !== 'string') return;
        const r = this.runs.get(d.run_id);
        if (r) r.end = ts;
        else if (ev.workspace && typeof d.op === 'string') {
          const dur = typeof d.duration_ms === 'number' ? d.duration_ms : 0;
          this.runs.set(d.run_id, { ws: ev.workspace, op: d.op, start: ts - dur, end: ts, by: typeof d.by === 'string' ? d.by : '', at_machine: true });
        }
        return;
      }
      case 'presence.change': {
        const to = d.to as Record<string, unknown> | undefined;
        const from = d.from as Record<string, unknown> | undefined;
        if (to && to.at_machine === false && (!from || from.at_machine !== false)) this.away.push(ts);
        return;
      }
      case 'input.counts': {
        const k = typeof d.keys === 'number' ? d.keys : 0;
        if (k > 0) this.keys.push({ ts, keys: k });
        return;
      }
    }
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const cutoff = ctx.now - KEEP_MS;
    for (const [id, r] of this.runs) if (r.start < cutoff) this.runs.delete(id);
    this.away = this.away.filter((t) => t >= cutoff);
    this.keys = this.keys.filter((k) => k.ts >= cutoff);

    const waits = new Map<string, { ws: string; op: string; mins: number[] }>();
    for (const r of this.runs.values()) {
      if (r.end === null || r.by !== 'user' || !r.at_machine) continue;
      const cfg = ctx.config(RULE_ID, r.ws);
      if (cfg.severity === 'off') continue;
      if (r.start < ctx.now - num(cfg, 'window_days', 7) * DAY_MS) continue;
      const dur = r.end - r.start;
      if (dur < num(cfg, 'min_minutes', 3) * 60_000) continue;
      if (this.away.some((t) => t >= r.start && t <= r.end!)) continue;
      let keys = 0;
      for (const k of this.keys) if (k.ts > r.start && k.ts <= r.end) keys += k.keys;
      if (keys > MAX_IDLE_KEYS) continue;
      const key = `${r.ws}\0${r.op}`;
      const w = waits.get(key) ?? { ws: r.ws, op: r.op, mins: [] };
      w.mins.push(dur / 60_000);
      waits.set(key, w);
    }

    const out: LintFinding[] = [];
    for (const w of waits.values()) {
      const cfg = ctx.config(RULE_ID, w.ws);
      const minOcc = Math.max(1, num(cfg, 'min_occurrences', 3));
      if (w.mins.length < minOcc) continue;
      if (this.alreadyNotifies(ctx, w.ws, w.op)) continue;
      out.push({
        rule: RULE_ID,
        workspace: w.ws,
        subject: w.op,
        message: `You wait on ${w.op} while it runs`,
        evidence: [`You waited on ${w.op} ${w.mins.length} times this week (median ${Math.round(median(w.mins))} min)`],
        fixes: [{ id: 'notify-when-done', label: 'Run it in the background with a notification', confirm_text: `Set notify_on_done: true on ${w.op} in .lee/operations.yaml` }],
        item_ref: `op:${w.ws}:${w.op}`,
        state_key: `${RULE_ID}:${bucket(w.mins.length, minOcc)}`,
      });
    }
    return out;
  }

  private alreadyNotifies(ctx: LintContext, ws: string, op: string): boolean {
    if (!ctx.ops) return false;
    try {
      return ctx.ops.snapshot(ws).operations.some((o) => o.def.name === op && o.def.notify_on_done === true);
    } catch {
      return false;
    }
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId !== 'notify-when-done') return { success: false, error: 'unknown_fix' };
    if (!ctx.ops) return UNAVAILABLE;
    if (!f.workspace) return { success: false, error: 'no_workspace' };
    const ok = await ctx.ops.setFlag(f.workspace, f.subject, 'notify_on_done', true);
    if (!ok) return { success: false, error: `Couldn't update ${f.subject}` };
    return { success: true, message: `${f.subject} will notify you when it's done` };
  }
}
