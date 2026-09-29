/**
 * toil/repeat-approval (contracts §8.3): the same tool call approved again
 * and again, or a long streak of reflex approvals. The fix is a permission
 * rule in <ws>/.claude/settings.local.json, written only on your click. Pure.
 */

import type { LeeEvent } from '../../../../shared/copilot';
import type { LintFixResult } from '../../../../shared/cockpit';
import { bashPrefixRule } from '../../bash-rule';
import { DAY_MS, bucket, num, tsOf } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';

export const RULE_ID = 'toil/repeat-approval';

const KEEP_MS = 8 * DAY_MS;
const STREAK_TOOLS = 3;

interface Reply {
  ts: number;
  id: string;
  ws: string | null;
  action: string;
  signature: string | null;
  latency: number;
}

/**
 * `Bash(<prefix>:*)` for Bash (bash-rule.ts: never an interpreter-wide or
 * flag-dropping rule such as `Bash(python:*)` or `Bash(rm:*)` from
 * `rm -rf build`); the bare tool name otherwise.
 */
export function permissionRule(tool: string, preview: string | null): string | null {
  if (tool !== 'Bash') return tool || null;
  if (!preview) return null;
  return bashPrefixRule(preview);
}

export class RepeatApprovalRule implements LintRule {
  readonly id = RULE_ID;
  readonly family = 'toil' as const;
  readonly consumes = ['attention.reply', 'agent.tool'];
  private replies: Reply[] = [];
  private tools = new Map<string, string>();
  /**
   * The exact rules each current finding's confirm_text shows, by
   * workspace + state_key: the fix writes these and nothing else (C3), even
   * if a later evaluation would propose different ones.
   */
  private shownRules = new Map<string, string[]>();

  ingest(ev: LeeEvent): void {
    const d = ev.data as Record<string, unknown>;
    if ((ev.type as string) === 'agent.tool') {
      if (typeof d.signature === 'string' && typeof d.tool === 'string') this.tools.set(d.signature, d.tool);
      return;
    }
    if ((ev.type as string) !== 'attention.reply') return;
    if (d.kind !== undefined && d.kind !== 'approval') return;
    if (typeof d.action !== 'string') return;
    this.replies.push({
      ts: tsOf(ev),
      id: ev.id,
      ws: ev.workspace,
      action: d.action,
      signature: typeof d.tool_signature === 'string' ? d.tool_signature : null,
      latency: typeof d.latency_ms === 'number' ? d.latency_ms : Number.POSITIVE_INFINITY,
    });
  }

  private info(ctx: LintContext, signature: string): { tool: string; preview: string | null } | null {
    const learned = ctx.toolInfo(signature);
    const tool = learned?.tool ?? this.tools.get(signature);
    if (!tool) return null;
    return { tool, preview: learned?.preview ?? null };
  }

  /** The rule for one signature, or null when it isn't known well enough to write. */
  private ruleFor(ctx: LintContext, signature: string): { rule: string; tool: string; preview: string } | null {
    const info = this.info(ctx, signature);
    if (!info || info.preview === null) return null;
    const rule = permissionRule(info.tool, info.preview);
    return rule ? { rule, tool: info.tool, preview: info.preview } : null;
  }

  private shownKey(ws: string | null, subject: string, stateKey: string): string {
    return `${ws ?? ''}\u0000${subject}\u0000${stateKey}`;
  }

  evaluate(ctx: LintContext): LintFinding[] {
    this.replies = this.replies.filter((r) => ctx.now - r.ts < KEEP_MS).sort((a, b) => a.ts - b.ts);
    const out: LintFinding[] = [];
    const shown = new Map<string, string[]>();
    const byWs = new Map<string, Reply[]>();
    for (const r of this.replies) {
      if (!r.ws) continue;
      const arr = byWs.get(r.ws) ?? [];
      arr.push(r);
      byWs.set(r.ws, arr);
    }
    for (const [ws, replies] of byWs) {
      const cfg = ctx.config(RULE_ID, ws);
      if (cfg.severity === 'off') continue;
      const since = ctx.now - num(cfg, 'window_days', 7) * DAY_MS;
      const minRepeats = Math.max(1, num(cfg, 'min_repeats', 10));
      const fastMs = num(cfg, 'fast_ms', 2000);
      const fastStreak = Math.max(1, num(cfg, 'fast_streak', 10));
      const recent = replies.filter((r) => r.ts >= since);

      // (a) the same call approved again and again
      const counts = new Map<string, number>();
      for (const r of recent) if (r.action === 'approve' && r.signature) counts.set(r.signature, (counts.get(r.signature) ?? 0) + 1);
      for (const [sig, n] of counts) {
        if (n < minRepeats) continue;
        const known = this.ruleFor(ctx, sig);
        if (!known) continue;
        const stateKey = `${RULE_ID}:a:${bucket(n, minRepeats)}`;
        shown.set(this.shownKey(ws, sig, stateKey), [known.rule]);
        out.push({
          rule: RULE_ID,
          workspace: ws,
          subject: sig,
          message: `You keep approving ${known.tool}`,
          evidence: [`Approved \`${known.tool}: ${known.preview}\` ${n} times this week`],
          fixes: [{ id: 'allow-in-project', label: 'Allow it in this project', confirm_text: `Add ${known.rule} to permissions.allow in ${ws}/.claude/settings.local.json` }],
          item_ref: `approval:${ws}:${sig}`,
          state_key: stateKey,
        });
      }

      // (b) the latest streak of reflex approvals
      let streak: Reply[] = [];
      let best: Reply[] = [];
      for (const r of recent) {
        if (r.action === 'approve' && r.latency < fastMs) {
          streak.push(r);
          if (streak.length >= fastStreak) best = streak;
        } else {
          streak = [];
        }
      }
      if (best.length >= fastStreak) {
        const rules = this.streakRules(ctx, best);
        if (rules.length > 0) {
          shown.set(this.shownKey(ws, 'streak', `${RULE_ID}:b:${best[0].id}`), rules);
          out.push({
            rule: RULE_ID,
            workspace: ws,
            subject: 'streak',
            message: 'You approve without reading',
            evidence: [`${best.length} approvals in a row, each in under ${Math.round(fastMs / 1000)} s`],
            fixes: [{ id: 'allow-in-project', label: 'Allow these in this project', confirm_text: `Add ${rules.join(', ')} to permissions.allow in ${ws}/.claude/settings.local.json` }],
            item_ref: `approval:${ws}:streak`,
            state_key: `${RULE_ID}:b:${best[0].id}`,
          });
        }
      }
    }
    this.shownRules = shown;
    return out;
  }

  /** The three most-approved rules in a streak (signatures without a known rule are skipped). */
  private streakRules(ctx: LintContext, streak: Reply[]): string[] {
    const counts = new Map<string, number>();
    for (const r of streak) {
      if (!r.signature) continue;
      const known = this.ruleFor(ctx, r.signature)?.rule ?? this.bareRule(ctx, r.signature);
      if (known) counts.set(known, (counts.get(known) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, STREAK_TOOLS)
      .map(([rule]) => rule);
  }

  /** Non-Bash tools need no preview for their rule. */
  private bareRule(ctx: LintContext, signature: string): string | null {
    const info = this.info(ctx, signature);
    if (!info || info.tool === 'Bash') return null;
    return permissionRule(info.tool, null);
  }

  /** The rules this finding's confirm_text showed, if it is still the current finding. */
  private rulesFor(f: LintFinding): string[] {
    return this.shownRules.get(this.shownKey(f.workspace, f.subject, f.state_key)) ?? [];
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId !== 'allow-in-project') return { success: false, error: 'unknown_fix' };
    if (!f.workspace) return { success: false, error: 'no_workspace' };
    const rules = this.rulesFor(f);
    const shownText = f.fixes.find((x) => x.id === fixId)?.confirm_text ?? '';
    // Write only what the confirm text in front of the user named.
    if (rules.length === 0 || !shownText.startsWith(`Add ${rules.join(', ')} to `)) return { success: false, error: 'unavailable' };
    await ctx.writeClaudeAllow(f.workspace, rules);
    return { success: true, message: `Allowed ${rules.join(', ')} in .claude/settings.local.json` };
  }
}
