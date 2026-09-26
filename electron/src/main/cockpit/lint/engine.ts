/**
 * Work lint engine (contracts §8.2). Pure: no Electron. Everything with a side
 * effect outside the store (event log, nudge budget, Feed, git) is injected, so
 * the smoke test drives it with synthetic events and fakes.
 *
 * Findings are diffed against open diagnostics by id; a diagnostic joins the
 * status count and the Feed (a nudge) only once the nudge budget grants it.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { LeeEvent } from '../../../shared/copilot';
import type {
  CockpitEventType,
  LintDiagnostic,
  LintFixResult,
  LintOutcome,
  LintRuleStatus,
  LintSeverity,
  LintSnapshot,
  LintSuppressScope,
  NudgeClaim,
  NudgeClaimRequest,
} from '../../../shared/cockpit';
import type { OpsProvider, TaskLauncher } from '../cockpit-bus';
import type { LintRuleConfig } from '../cockpit-config';
import type { LintStore, RuleState } from './store';
import { DAY_MS } from './types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from './types';

export interface DemotionConfig {
  min_outcomes: number;
  dismiss_ratio: number;
  window_days: number;
}

/** Providers read on every use, so late registrations on the cockpit bus are picked up. */
export interface LintProviders {
  commandText(workspace: string, sig: string): string | null;
  toolInfo(signature: string): { tool: string; preview: string | null } | null;
  ops(): OpsProvider | null;
  launcher(): TaskLauncher | null;
  writeClaudeAllow(workspace: string, rules: string[]): Promise<void>;
}

export interface LintEngineDeps {
  rules: LintRule[];
  store: LintStore;
  providers: LintProviders;
  config(rule: string, workspace: string | null): LintRuleConfig;
  demotion(workspace: string | null): DemotionConfig;
  log(type: CockpitEventType, workspace: string | null, data: Record<string, unknown>): void;
  ceremony(workspace: string | null, target: 'lint-dismiss' | 'lint-suppress'): void;
  claimNudge(req: NudgeClaimRequest): NudgeClaim;
  overrideNudge(itemRef: string, stateKey: string): void;
  feedPost(diag: LintDiagnostic): void;
  feedClose(diagId: string, state: 'done' | 'dismissed'): void;
  /** Current branch of a workspace (null outside git). */
  branch(workspace: string): string | null;
  now?: () => number;
}

interface OpenDiag {
  diag: LintDiagnostic;
  finding: LintFinding;
  itemRef: string;
  stateKey: string;
  /** Granted a nudge: counted in ⚠ N and posted to the Feed. */
  visible: boolean;
  /** Budget said same_state/overridden for this state: stay quiet until it changes. */
  quietState: string | null;
  shownState: string | null;
  shownAt: number | null;
  outcome: LintOutcome | null;
  touched: boolean;
}

const LEVELS: LintSeverity[] = ['info', 'warn', 'needs-you'];
const IGNORE_AFTER_MS = 7 * DAY_MS;
const RECOMPUTE_MS = DAY_MS;
const RECOVER_BELOW = 0.5;

export function diagIdFor(rule: string, workspace: string | null, subject: string): string {
  return `lint_${crypto.createHash('sha1').update(`${rule}\0${workspace ?? ''}\0${subject}`).digest('hex').slice(0, 12)}`;
}

export function demote(base: LintSeverity, steps: number): LintSeverity {
  if (base === 'off') return 'off';
  const i = LEVELS.indexOf(base);
  return LEVELS[Math.max(0, i - Math.max(0, steps))];
}

function emptyState(): RuleState {
  return { steps: 0, flagged: false, changed_at: null, computed_at: null, ratio: 0, n: 0 };
}

export class LintEngine extends EventEmitter {
  private readonly deps: LintEngineDeps;
  private readonly now: () => number;
  private readonly consumed: Set<string>;
  private open = new Map<string, OpenDiag>();
  /** Workspace-suppressed diagnostics, listed in the flyout with severity 'off' so they can be un-ignored. */
  private muted = new Map<string, LintDiagnostic>();
  /** diag id -> state_key it was fixed or dismissed at. */
  private closed = new Map<string, string>();
  private closedLoaded = new Set<string>();

  constructor(deps: LintEngineDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.consumed = new Set(deps.rules.flatMap((r) => r.consumes));
  }

  consumedTypes(): string[] {
    return [...this.consumed];
  }

  ingest(ev: LeeEvent): boolean {
    if (!this.consumed.has(ev.type)) return false;
    for (const r of this.deps.rules) {
      if (!r.consumes.includes(ev.type)) continue;
      try {
        r.ingest(ev);
      } catch (err) {
        console.error(`[lint] ${r.id} ingest failed:`, err);
      }
    }
    return true;
  }

  private context(): LintContext {
    const p = this.deps.providers;
    return {
      now: this.now(),
      config: (rule, ws) => this.deps.config(rule, ws),
      commandText: (ws, sig) => p.commandText(ws, sig),
      toolInfo: (sig) => p.toolInfo(sig),
      ops: p.ops(),
      ignoredCommands: (ws) => new Set(this.deps.store.suppressions(ws).commands),
    };
  }

  private fixContext(): LintFixContext {
    const p = this.deps.providers;
    return {
      ...this.context(),
      launcher: p.launcher(),
      writeClaudeAllow: (ws, rules) => p.writeClaudeAllow(ws, rules),
      ignoreCommands: async (ws, sigs) => {
        const file = this.deps.store.suppressions(ws);
        const next = { ...file, commands: [...new Set([...file.commands, ...sigs])] };
        this.deps.store.saveSuppressions(ws, next);
      },
    };
  }

  private ruleState(ws: string | null, rule: string): RuleState {
    return this.deps.store.ruleStates(ws)[rule] ?? emptyState();
  }

  private effective(rule: string, ws: string | null): { base: LintSeverity; severity: LintSeverity; demoted: boolean } {
    const base = this.deps.config(rule, ws).severity;
    const st = this.ruleState(ws, rule);
    const severity = demote(base, st.steps);
    return { base, severity, demoted: severity !== base };
  }

  private loadClosed(ws: string | null): void {
    const k = ws ?? '';
    if (this.closedLoaded.has(k)) return;
    this.closedLoaded.add(k);
    for (const r of this.deps.store.outcomes(ws)) {
      if ((r.outcome === 'fixed' || r.outcome === 'dismissed') && r.state_key) this.closed.set(r.diag_id, r.state_key);
    }
  }

  private suppressedBy(f: LintFinding, id: string): LintSuppressScope | null {
    const entries = this.deps.store.suppressions(f.workspace).items.filter((e) => e.diag_id === id);
    for (const e of entries) {
      if (e.scope === 'workspace') return 'workspace';
      if (e.scope === 'item' && e.state_key === f.state_key) return 'item';
      if (e.scope === 'branch') {
        const now = f.workspace ? this.deps.branch(f.workspace) : null;
        if (e.branch != null ? now === e.branch : e.state_key === f.state_key) return 'branch';
      }
    }
    return null;
  }

  private makeDiag(f: LintFinding, id: string, prev: LintDiagnostic | null): LintDiagnostic {
    const sev = this.effective(f.rule, f.workspace);
    const at = new Date(this.now()).toISOString();
    return {
      id,
      rule: f.rule,
      family: 'toil',
      severity: sev.severity,
      base_severity: sev.base,
      workspace: f.workspace,
      subject: f.subject,
      message: f.message,
      evidence: f.evidence,
      fixes: f.fixes,
      item_ref: f.item_ref,
      created_at: prev?.created_at ?? at,
      updated_at: at,
      shown: prev?.shown ?? false,
      demoted: sev.demoted,
    };
  }

  /** Run every rule and reconcile open diagnostics. */
  evaluate(): void {
    const ctx = this.context();
    const findings: LintFinding[] = [];
    for (const r of this.deps.rules) {
      try {
        findings.push(...r.evaluate(ctx));
      } catch (err) {
        console.error(`[lint] ${r.id} evaluate failed:`, err);
      }
    }
    const now = this.now();
    const seen = new Set<string>();
    const mutedNow = new Map<string, LintDiagnostic>();
    const workspaces = new Set<string | null>();
    let changed = false;

    for (const f of findings) {
      if (f.fixes.length === 0) continue;
      if (this.deps.config(f.rule, f.workspace).severity === 'off') continue;
      workspaces.add(f.workspace);
      const id = diagIdFor(f.rule, f.workspace, f.subject);
      this.loadClosed(f.workspace);
      if (this.closed.get(id) === f.state_key) continue;
      const scope = this.suppressedBy(f, id);
      if (scope) {
        if (scope === 'workspace') mutedNow.set(id, { ...this.makeDiag(f, id, this.muted.get(id) ?? null), severity: 'off' });
        continue;
      }
      seen.add(id);
      const cur = this.open.get(id);
      if (!cur) {
        const diag = this.makeDiag(f, id, null);
        this.open.set(id, {
          diag,
          finding: f,
          itemRef: f.item_ref ?? `lint:${f.workspace ?? ''}:${f.rule}:${f.subject}`,
          stateKey: f.state_key,
          visible: false,
          quietState: null,
          shownState: null,
          shownAt: null,
          outcome: null,
          touched: false,
        });
        this.deps.log('lint.open', f.workspace, { diag_id: id, rule: f.rule, subject: f.subject, severity: diag.severity, item_ref: f.item_ref });
        changed = true;
        continue;
      }
      const stateChanged = cur.stateKey !== f.state_key;
      const before = JSON.stringify([cur.diag.message, cur.diag.evidence, cur.diag.fixes, cur.diag.severity]);
      const prevUpdated = cur.diag.updated_at;
      cur.diag = this.makeDiag(f, id, cur.diag);
      cur.finding = f;
      if (stateChanged) {
        cur.stateKey = f.state_key;
        cur.shownState = null;
        cur.shownAt = null;
        cur.outcome = null;
        cur.touched = false;
        cur.diag.shown = false;
      }
      if (stateChanged || before !== JSON.stringify([cur.diag.message, cur.diag.evidence, cur.diag.fixes, cur.diag.severity])) {
        if (cur.visible) this.deps.feedPost(cur.diag);
        changed = true;
      } else {
        cur.diag.updated_at = prevUpdated;
      }
    }

    for (const [id, o] of [...this.open]) {
      if (seen.has(id)) continue;
      if (o.diag.shown && o.outcome === null) this.recordOutcome(o, 'ignored');
      this.open.delete(id);
      if (o.visible) this.deps.feedClose(id, 'done');
      changed = true;
    }
    if (mutedNow.size !== this.muted.size || [...mutedNow.keys()].some((k) => !this.muted.has(k))) changed = true;
    this.muted = mutedNow;

    for (const o of this.open.values()) {
      if (o.shownAt !== null && !o.touched && o.outcome === null && now - o.shownAt >= IGNORE_AFTER_MS) {
        this.recordOutcome(o, 'ignored');
      }
      if (o.visible || o.diag.severity === 'off') continue;
      if (o.quietState === o.stateKey) continue;
      const res = this.deps.claimNudge({ item_ref: o.itemRef, state_key: o.stateKey, source: 'lint', workspace: o.diag.workspace });
      if (res.granted) {
        o.visible = true;
        o.quietState = null;
        this.deps.feedPost(o.diag);
        changed = true;
      } else if (res.reason === 'same_state' || res.reason === 'overridden') {
        o.quietState = o.stateKey;
      }
    }

    for (const ws of workspaces) this.recomputeDemotions(ws);
    if (changed) this.emit('change');
  }

  private recordOutcome(o: OpenDiag, outcome: LintOutcome, fixId?: string): void {
    o.outcome = outcome;
    const d = o.diag;
    this.deps.store.appendOutcome(d.workspace, {
      ts: new Date(this.now()).toISOString(),
      diag_id: d.id,
      rule: d.rule,
      subject: d.subject,
      outcome,
      ...(fixId ? { fix_id: fixId } : {}),
      state_key: o.stateKey,
    });
    this.deps.log('lint.outcome', d.workspace, { diag_id: d.id, rule: d.rule, outcome, ...(fixId ? { fix_id: fixId } : {}) });
  }

  private close(o: OpenDiag, feedState: 'done' | 'dismissed'): void {
    this.open.delete(o.diag.id);
    if (o.visible) this.deps.feedClose(o.diag.id, feedState);
    this.emit('change');
  }

  async fix(diagId: string, fixId: string): Promise<LintFixResult> {
    const o = this.open.get(diagId);
    if (!o) return { success: false, error: 'not_found' };
    const rule = this.deps.rules.find((r) => r.id === o.diag.rule);
    if (!rule || !o.finding.fixes.some((f) => f.id === fixId)) return { success: false, error: 'unknown_fix' };
    o.touched = true;
    let res: LintFixResult;
    try {
      res = await rule.fix(o.finding, fixId, this.fixContext());
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.success) return res;
    if (!this.open.has(diagId)) return res;
    this.recordOutcome(o, 'fixed', fixId);
    this.closed.set(diagId, o.stateKey);
    this.close(o, 'done');
    return res;
  }

  /** Dismiss. `fromFeed`: the Feed's built-in dismiss already logged the ceremony and overrode the nudge. */
  dismiss(diagId: string, opts: { fromFeed?: boolean } = {}): { success: boolean } {
    const o = this.open.get(diagId);
    if (!o) return { success: false };
    o.touched = true;
    this.recordOutcome(o, 'dismissed');
    this.closed.set(diagId, o.stateKey);
    this.deps.overrideNudge(o.itemRef, o.stateKey);
    if (!opts.fromFeed) this.deps.ceremony(o.diag.workspace, 'lint-dismiss');
    this.close(o, 'dismissed');
    return { success: true };
  }

  /** Scoped ignore. Asking for 'workspace' on a diagnostic already ignored in the workspace removes that ignore. */
  suppress(diagId: string, scope: LintSuppressScope): { success: boolean } {
    const muted = this.muted.get(diagId);
    if (muted) {
      if (scope !== 'workspace') return { success: false };
      const file = this.deps.store.suppressions(muted.workspace);
      this.deps.store.saveSuppressions(muted.workspace, { ...file, items: file.items.filter((e) => !(e.diag_id === diagId && e.scope === 'workspace')) });
      this.muted.delete(diagId);
      this.emit('change');
      return { success: true };
    }
    const o = this.open.get(diagId);
    if (!o) return { success: false };
    const ws = o.diag.workspace;
    o.touched = true;
    this.recordOutcome(o, 'suppressed');
    const file = this.deps.store.suppressions(ws);
    const branch = scope === 'branch' && ws ? this.deps.branch(ws) : null;
    this.deps.store.saveSuppressions(ws, {
      ...file,
      items: [
        ...file.items.filter((e) => !(e.diag_id === diagId && e.scope === scope)),
        {
          diag_id: diagId,
          rule: o.diag.rule,
          subject: o.diag.subject,
          scope,
          state_key: o.stateKey,
          branch,
          at: new Date(this.now()).toISOString(),
        },
      ],
    });
    this.deps.overrideNudge(o.itemRef, o.stateKey);
    this.deps.ceremony(ws, 'lint-suppress');
    if (scope === 'workspace') this.muted.set(diagId, { ...o.diag, severity: 'off' });
    this.close(o, 'dismissed');
    return { success: true };
  }

  /** The renderer displayed these (status count or Feed). Only nudged diagnostics count as shown. */
  shown(diagIds: string[], surface: 'status' | 'feed'): void {
    let changed = false;
    for (const id of diagIds) {
      const o = this.open.get(id);
      if (!o || !o.visible || o.shownState === o.stateKey) continue;
      o.shownState = o.stateKey;
      o.shownAt = this.now();
      o.diag.shown = true;
      this.deps.log('lint.shown', o.diag.workspace, { diag_id: id, rule: o.diag.rule, surface });
      changed = true;
    }
    if (changed) this.emit('change');
  }

  get(diagId: string): LintDiagnostic | null {
    return this.open.get(diagId)?.diag ?? null;
  }

  isVisible(diagId: string): boolean {
    return this.open.get(diagId)?.visible ?? false;
  }

  /** Workspaces with open or ignored diagnostics. */
  workspaces(): Array<string | null> {
    const out = new Set<string | null>();
    for (const o of this.open.values()) out.add(o.diag.workspace);
    for (const d of this.muted.values()) out.add(d.workspace);
    return [...out];
  }

  /**
   * Spec §10.3 rule 2, per rule per workspace, over outcomes since the last
   * level change: ≥ min_outcomes and ≥ dismiss_ratio ignored/dismissed/suppressed
   * drops one level (info stays and is flagged); below 0.5 recovers one.
   */
  recomputeDemotions(ws: string | null, force = false): void {
    const states = { ...this.deps.store.ruleStates(ws) };
    const cfg = this.deps.demotion(ws);
    const now = this.now();
    const since = now - cfg.window_days * DAY_MS;
    let dirty = false;
    for (const rule of this.deps.rules) {
      const st = { ...(states[rule.id] ?? emptyState()) };
      if (!force && st.computed_at && now - Date.parse(st.computed_at) < RECOMPUTE_MS) continue;
      const changedAt = st.changed_at ? Date.parse(st.changed_at) : -Infinity;
      const outs = this.deps.store.outcomes(ws).filter((r) => r.rule === rule.id && Date.parse(r.ts) >= since && Date.parse(r.ts) > changedAt);
      const n = outs.length;
      const bad = outs.filter((r) => r.outcome !== 'fixed').length;
      const ratio = n > 0 ? bad / n : 0;
      const base = this.deps.config(rule.id, ws).severity;
      const from = demote(base, st.steps);
      st.n = n;
      st.ratio = ratio;
      st.computed_at = new Date(now).toISOString();
      if (base !== 'off' && n >= cfg.min_outcomes && ratio >= cfg.dismiss_ratio) {
        if (from !== 'info') {
          st.steps += 1;
          st.changed_at = st.computed_at;
          this.deps.log('lint.demote', ws, { rule: rule.id, from, to: demote(base, st.steps), ratio, n });
        } else {
          st.flagged = true;
        }
      } else if (st.steps > 0 && n >= cfg.min_outcomes && ratio < RECOVER_BELOW) {
        st.steps -= 1;
        st.flagged = false;
        st.changed_at = st.computed_at;
        this.deps.log('lint.demote', ws, { rule: rule.id, from, to: demote(base, st.steps), ratio, n });
      }
      states[rule.id] = st;
      dirty = true;
    }
    if (!dirty) return;
    this.deps.store.saveRuleStates(ws, states);
    for (const o of this.open.values()) {
      if (o.diag.workspace !== ws) continue;
      const sev = this.effective(o.diag.rule, ws);
      if (sev.severity !== o.diag.severity) {
        o.diag = { ...o.diag, severity: sev.severity, base_severity: sev.base, demoted: sev.demoted };
        if (o.visible) this.deps.feedPost(o.diag);
        this.emit('change');
      }
    }
  }

  private ruleStatus(ws: string | null): LintRuleStatus[] {
    const cfg = this.deps.demotion(ws);
    const since = this.now() - cfg.window_days * DAY_MS;
    const outs = this.deps.store.outcomes(ws).filter((r) => Date.parse(r.ts) >= since);
    return this.deps.rules.map((r) => {
      const st = this.ruleState(ws, r.id);
      const sev = this.effective(r.id, ws);
      const counts: Record<LintOutcome, number> = { fixed: 0, dismissed: 0, ignored: 0, suppressed: 0 };
      for (const o of outs) if (o.rule === r.id && o.outcome in counts) counts[o.outcome]++;
      return {
        rule: r.id,
        severity: sev.severity,
        base_severity: sev.base,
        demoted: sev.demoted,
        flagged_for_rework: st.flagged,
        outcomes_30d: counts,
      };
    });
  }

  /** One workspace plus machine-wide diagnostics (null: machine-wide only). Counts are nudged diagnostics only. */
  snapshot(workspace: string | null): LintSnapshot {
    const diagnostics: LintDiagnostic[] = [];
    const counts = { info: 0, warn: 0, needs_you: 0 };
    for (const o of this.open.values()) {
      if (o.diag.workspace !== null && o.diag.workspace !== workspace) continue;
      diagnostics.push(o.diag);
      if (!o.visible) continue;
      if (o.diag.severity === 'info') counts.info++;
      else if (o.diag.severity === 'warn') counts.warn++;
      else if (o.diag.severity === 'needs-you') counts.needs_you++;
    }
    for (const d of this.muted.values()) {
      if (d.workspace === null || d.workspace === workspace) diagnostics.push(d);
    }
    const rank = (s: LintSeverity) => (s === 'needs-you' ? 0 : s === 'warn' ? 1 : s === 'info' ? 2 : 3);
    diagnostics.sort((a, b) => rank(a.severity) - rank(b.severity) || a.rule.localeCompare(b.rule) || b.updated_at.localeCompare(a.updated_at));
    return {
      workspace,
      diagnostics,
      counts,
      rules: this.ruleStatus(workspace),
      generated_at: new Date(this.now()).toISOString(),
    };
  }
}
