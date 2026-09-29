/**
 * toil/flaky-operation (contracts §8.3): an operation flips between passed
 * and failed with the same inputs. Pure.
 */

import type { LeeEvent } from '../../../../shared/copilot';
import type { LintFixResult } from '../../../../shared/cockpit';
import { UNAVAILABLE, bucket, num, tsOf } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';

export const RULE_ID = 'toil/flaky-operation';

const KEEP_RUNS = 50;

interface Result {
  ts: number;
  run_id: string;
  status: string;
  inputs_sig: string | null;
}

export class FlakyOperationRule implements LintRule {
  readonly id = RULE_ID;
  readonly family = 'toil' as const;
  readonly consumes = ['operation.result'];
  /** "<ws>\0<op>" -> results, oldest first. */
  private results = new Map<string, Result[]>();

  ingest(ev: LeeEvent): void {
    if (ev.type !== ('operation.result' as string) || !ev.workspace) return;
    const d = ev.data as Record<string, unknown>;
    if (typeof d.op !== 'string' || typeof d.status !== 'string') return;
    const key = `${ev.workspace}\0${d.op}`;
    const list = this.results.get(key) ?? [];
    list.push({
      ts: tsOf(ev),
      run_id: typeof d.run_id === 'string' ? d.run_id : '',
      status: d.status,
      inputs_sig: typeof d.inputs_sig === 'string' ? d.inputs_sig : null,
    });
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > KEEP_RUNS) list.splice(0, list.length - KEEP_RUNS);
    this.results.set(key, list);
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const [key, all] of this.results) {
      const [ws, op] = key.split('\0');
      const cfg = ctx.config(RULE_ID, ws);
      if (cfg.severity === 'off') continue;
      const windowRuns = Math.max(2, num(cfg, 'window_runs', 10));
      const minFlips = Math.max(1, num(cfg, 'min_flips', 2));
      const recent = all.slice(-windowRuns);
      let flips = 0;
      let flipSig: string | null = null;
      for (let i = 1; i < recent.length; i++) {
        const a = recent[i - 1];
        const b = recent[i];
        if (!a.inputs_sig || a.inputs_sig !== b.inputs_sig) continue;
        const pf = (s: string) => s === 'passed' || s === 'failed';
        if (pf(a.status) && pf(b.status) && a.status !== b.status) {
          flips++;
          flipSig = b.inputs_sig;
        }
      }
      if (flips < minFlips || !flipSig) continue;
      const failed = recent.filter((r) => r.status === 'failed');
      out.push({
        rule: RULE_ID,
        workspace: ws,
        subject: op,
        message: `${op} is flaky`,
        evidence: [
          `${failed.length} of the last ${recent.length} runs failed with no change to HEAD or the working tree`,
          `inputs ${flipSig}`,
        ],
        fixes: [{ id: 'create-task', label: 'Create a task to investigate', confirm_text: `New task: Investigate flaky ${op}` }],
        item_ref: `op:${ws}:${op}`,
        state_key: `${RULE_ID}:${flipSig}:${bucket(flips, minFlips)}`,
      });
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId !== 'create-task') return { success: false, error: 'unknown_fix' };
    if (!ctx.launcher) return UNAVAILABLE;
    if (!f.workspace) return { success: false, error: 'no_workspace' };
    const list = this.results.get(`${f.workspace}\0${f.subject}`) ?? [];
    const lastFail = [...list].reverse().find((r) => r.status === 'failed');
    const note = [...f.evidence, ...(lastFail ? [`Last failing run: ${lastFail.run_id}`] : [])].join('\n');
    const res = await ctx.launcher.createTask({
      workspace: f.workspace,
      title: `Investigate flaky ${f.subject}`,
      kind: 'bug',
      lead: 'delegate',
      status: 'queued',
      origin: { kind: 'lint', ref: RULE_ID },
      note,
    });
    return { success: true, message: `Created task ${res.task_id}${res.relayed ? '' : ' (will reach Hester when it is running)'}` };
  }
}
