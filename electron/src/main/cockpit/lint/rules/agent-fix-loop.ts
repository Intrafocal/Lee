/**
 * agent/fix-loop (contract v4 §7.3): in one agent session the same tool call
 * (by `agent.tool` post signature) failed in N or more distinct turns (turns
 * are separated by `agent.prompt`). Pure. Steward-gated (family 'agent').
 */

import type { LeeEvent } from '../../../../shared/copilot';
import type { LintFixResult } from '../../../../shared/cockpit';
import { num, tsOf } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';
import { FIX_CHECKIN, fixCheckin, fixOpenTab, taskRef } from './v4-common';

export const FIX_LOOP = 'agent/fix-loop';

const SESSION_KEEP_MS = 2 * 86_400_000;
/** Only failures in the session's last this-many turns count. */
const RECENT_TURNS = 10;

interface Session {
  ws: string | null;
  pty: number | null;
  turn: number;
  last: number;
  /** signature -> tool name and the turns it failed in. */
  fails: Map<string, { tool: string; turns: Set<number> }>;
}

export class FixLoopRule implements LintRule {
  readonly id = FIX_LOOP;
  readonly family = 'agent' as const;
  readonly consumes = ['agent.prompt', 'agent.tool', 'agent.session_end', 'agent.exit'];
  private sessions = new Map<string, Session>();

  ingest(ev: LeeEvent): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const sid = typeof d.session_id === 'string' ? d.session_id : null;
    if (!sid) return;
    if (ev.type === 'agent.session_end' || ev.type === 'agent.exit') {
      this.sessions.delete(sid);
      return;
    }
    let s = this.sessions.get(sid);
    if (!s) {
      s = { ws: ev.workspace, pty: null, turn: 0, last: 0, fails: new Map() };
      this.sessions.set(sid, s);
    }
    if (typeof d.pty_id === 'number') s.pty = d.pty_id;
    if (ev.workspace) s.ws = ev.workspace;
    s.last = Math.max(s.last, tsOf(ev));
    if (ev.type === 'agent.prompt') {
      s.turn++;
      return;
    }
    if (ev.type !== 'agent.tool' || d.phase !== 'post' || d.failed !== true || typeof d.signature !== 'string') return;
    const f = s.fails.get(d.signature) ?? { tool: typeof d.tool === 'string' ? d.tool : 'a tool', turns: new Set<number>() };
    f.turns.add(s.turn);
    s.fails.set(d.signature, f);
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const [sid, s] of this.sessions) {
      if (ctx.now - s.last > SESSION_KEEP_MS) {
        this.sessions.delete(sid);
        continue;
      }
      if (!s.ws) continue;
      const cfg = ctx.config(FIX_LOOP, s.ws);
      if (cfg.severity === 'off') continue;
      const n = Math.max(2, num(cfg, 'turns', 3));
      for (const [sig, f] of s.fails) {
        const turns = [...f.turns].filter((t) => t > s.turn - RECENT_TURNS);
        if (turns.length < n) continue;
        const task = s.pty != null ? ctx.taskByPty(s.pty) : null;
        out.push({
          rule: FIX_LOOP,
          workspace: s.ws,
          subject: `${sid}:${sig}`,
          message: `The agent keeps failing the same ${f.tool} call`,
          evidence: [`${f.tool} (${sig}) failed in ${turns.length} separate turns of this session`],
          fixes: [FIX_CHECKIN, { id: 'open-tab', label: 'Open the tab' }],
          item_ref: task ? taskRef(task) : s.pty != null ? `pty:${s.pty}` : null,
          state_key: `${FIX_LOOP}:${Math.floor(turns.length / n)}`,
        });
      }
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    const sid = f.subject.slice(0, f.subject.lastIndexOf(':'));
    const pty = this.sessions.get(sid)?.pty ?? null;
    if (fixId === 'checkin') return fixCheckin(pty, ctx);
    if (fixId === 'open-tab') return fixOpenTab(pty, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}
