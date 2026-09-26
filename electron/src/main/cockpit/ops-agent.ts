/**
 * Operation agents (package B): small-model Claude tabs started only by a
 * human action (C2) to triage a failed operation or run an ad-hoc request;
 * "save as operation" and "escalate to a task" proposals from their turns.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.7.
 */

import * as crypto from 'crypto';
import type { LeeEvent, LeeStatusBlock, Principal } from '../../shared/copilot';
import type { LaunchRequest, LaunchResult, OpAgentRequest, OperationAgentConfig, OperationDef, OperationRun } from '../../shared/cockpit';
import { copilotBus } from '../copilot/bus';
import { cockpitBus, logCockpitEvent } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import { OP_NAME_RE, validateOperation } from './ops-config';
import type { OpsRuntime } from './ops-runtime';
import { actorFor } from './ops-runtime';

export const OP_AGENT_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];
const SAVE_LINE_RE = /^operation:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.*)$/m;
const EXCERPT_LINES = 80;
const TITLE_REQUEST_CHARS = 40;
const SUMMARY_MAX = 2000;

/** `Bash(<first word> <second word unless it starts with ->:*)` for an operation's command. */
export function bashRuleFor(command: string): string {
  const segs = command.split(/\s*&&\s*/);
  const words = segs[segs.length - 1].trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const first = words[0] ?? '';
  const second = words[1] && !words[1].startsWith('-') && !/[{}'"$]/.test(words[1]) ? ` ${words[1]}` : '';
  return `Bash(${first}${second}:*)`;
}

export function fixPrompt(o: { name: string; command: string; cwd: string; exitCode: number | null; excerpt: string }): string {
  return (
    `You are an operation agent in Lee. The operation "${o.name}" failed.\n` +
    `Command: ${o.command}\n` +
    `Working directory: ${o.cwd}\n` +
    `Exit code: ${o.exitCode ?? 'unknown'}\n` +
    `Last lines of output:\n${o.excerpt}\n\n` +
    'Find the cause. If it is environmental (a missing dependency, a wrong port, a stale build directory), try the obvious fix and re-run the command once to confirm. ' +
    'Do not edit tracked source files; if the fix needs code changes, stop and say so. End with a lee-status block.'
  );
}

export function adhocPrompt(workspace: string, request: string): string {
  return (
    `You are an operation agent in Lee, working in ${workspace}. The user asked: "${request}"\n` +
    'Work out the command or commands, run them, and report. Prefer the project\'s existing scripts (package.json, Makefile, idf.py, flutter). ' +
    'Do not edit tracked source files. If this should become a saved operation, end your summary with one line in the form ' +
    '"operation: <name> | <command> | <cwd relative to the workspace>". End with a lee-status block.'
  );
}

export function escalatePrompt(o: { name: string; report: string; command: string; excerpt: string }): string {
  return (
    `You are continuing work an operation agent started on "${o.name}". Its report: ${o.report}. ` +
    `Command: ${o.command}. Last lines of output: ${o.excerpt}. ` +
    'Make the code change needed so the operation passes. End with a lee-status block.'
  );
}

/** The LaunchRequest for an operation agent (§7.7 table). */
export function buildOpAgentLaunch(o: {
  req: OpAgentRequest;
  agent: OperationAgentConfig;
  def?: OperationDef | null;
  cwd?: string;
  run?: OperationRun | null;
  excerpt?: string;
}): LaunchRequest {
  const { req, agent } = o;
  if (req.purpose === 'fix') {
    const def = o.def!;
    return {
      workspace: req.workspace,
      title: `Fix: ${def.name}`,
      prompt: fixPrompt({ name: def.name, command: def.command, cwd: o.cwd ?? req.workspace, exitCode: o.run?.exit_code ?? null, excerpt: o.excerpt ?? '' }),
      kind: 'chore',
      lead: 'delegate',
      model: agent.model,
      permission_mode: 'manual',
      tools: [...OP_AGENT_TOOLS],
      allowed_tools: ['Read', 'Grep', 'Glob', bashRuleFor(def.command), ...(def.allowed_tools ?? [])],
      worktree: false,
      origin: { kind: 'operation', ref: def.name },
    };
  }
  const request = (req.request ?? '').trim();
  return {
    workspace: req.workspace,
    title: `Op: ${request.slice(0, TITLE_REQUEST_CHARS)}`,
    prompt: adhocPrompt(req.workspace, request),
    kind: 'chore',
    lead: 'delegate',
    model: req.multi_step ? agent.plan_model : agent.model,
    permission_mode: 'manual',
    tools: [...OP_AGENT_TOOLS],
    allowed_tools: ['Read', 'Grep', 'Glob', 'Bash(ls:*)'],
    worktree: false,
    origin: { kind: 'operation', ref: null },
  };
}

/** A summary's "operation: name | command | cwd" line, validated. */
export function parseSaveLine(summary: string | null | undefined): OperationDef | null {
  if (!summary) return null;
  const m = SAVE_LINE_RE.exec(summary);
  if (!m) return null;
  const name = m[1].trim().replace(/\s+/g, '-');
  if (!OP_NAME_RE.test(name)) return null;
  const cwd = m[3].trim().replace(/^\.\/?$/, '');
  return validateOperation({ name, kind: 'oneshot', command: m[2].trim(), ...(cwd ? { cwd } : {}) }, []);
}

interface TrackedAgent {
  workspace: string;
  task_id: string;
  pty_id: number | null;
  session_id: string | null;
  op: string | null;
  purpose: 'fix' | 'adhoc' | 'escalate';
  command: string | null;
  excerpt: string;
  turns: number;
}

interface PendingProposal {
  kind: 'save' | 'escalate';
  workspace: string;
  def?: OperationDef;
  agent?: TrackedAgent;
  report?: string;
}

export class OpsAgents {
  private agents: TrackedAgent[] = [];
  private pending = new Map<string, PendingProposal>();
  private listener: ((e: LeeEvent) => void) | null = null;

  constructor(private readonly runtime: OpsRuntime) {}

  start(): void {
    this.listener = (e) => {
      if (e.type === 'agent.turn_end') this.onTurnEnd(e);
    };
    copilotBus.on('event', this.listener);
  }

  stop(): void {
    if (this.listener) copilotBus.off('event', this.listener);
    this.listener = null;
  }

  private excerpt(workspace: string, name: string): string {
    return this.runtime.logTail(workspace, name, EXCERPT_LINES) ?? '(no output captured)';
  }

  /** Human action only (IPC or a Feed click). */
  async startAgent(req: OpAgentRequest, principal: Principal, windowId: number | null = null): Promise<LaunchResult> {
    if (principal.kind === 'shared') return { success: false, error: 'forbidden' };
    if (!this.runtime.isOpenWorkspace(req.workspace)) return { success: false, error: 'unknown_workspace' };
    const launcher = cockpitBus.launcher;
    if (!launcher) return { success: false, error: 'launcher_unavailable' };
    const agent = getCockpitConfig(req.workspace).operation_agent;
    let launch: LaunchRequest;
    let tracked: Omit<TrackedAgent, 'task_id' | 'pty_id' | 'session_id'>;
    if (req.purpose === 'fix') {
      if (!req.op) return { success: false, error: 'invalid' };
      const m = this.runtime.getOperation(req.workspace, req.op);
      if (!m) return { success: false, error: 'not_found' };
      const run = (req.run_id ? this.runtime.getRun(req.workspace, req.run_id) : null) ?? this.runtime.lastRun(req.workspace, req.op);
      const excerpt = this.excerpt(req.workspace, req.op);
      const cwd = this.runtime.absCwd(req.workspace, m.def.cwd);
      launch = buildOpAgentLaunch({ req, agent, def: m.def, cwd, run, excerpt });
      tracked = { workspace: req.workspace, op: m.def.name, purpose: 'fix', command: m.def.command, excerpt, turns: 0 };
    } else if (req.purpose === 'adhoc') {
      if (!req.request || !req.request.trim()) return { success: false, error: 'invalid' };
      launch = buildOpAgentLaunch({ req, agent });
      tracked = { workspace: req.workspace, op: null, purpose: 'adhoc', command: null, excerpt: '', turns: 0 };
    } else {
      return { success: false, error: 'invalid' };
    }
    const res = await launcher.launch(launch, principal, windowId);
    if (res.success && res.task_id) {
      this.track({ ...tracked, task_id: res.task_id, pty_id: res.pty_id ?? null, session_id: res.session_id ?? null });
      logCockpitEvent('opagent.launch', {
        workspace: req.workspace,
        actor: actorFor(principal),
        data: { task_id: res.task_id, ...(res.pty_id != null ? { pty_id: res.pty_id } : {}), ...(tracked.op ? { op: tracked.op } : {}), purpose: req.purpose, model: launch.model },
      });
    }
    return res;
  }

  private track(a: TrackedAgent): void {
    this.agents = [...this.agents.filter((x) => x.task_id !== a.task_id), a].slice(-50);
  }

  private findAgent(data: Record<string, unknown>): TrackedAgent | null {
    const pty = typeof data.pty_id === 'number' ? data.pty_id : null;
    const sid = typeof data.session_id === 'string' ? data.session_id : null;
    return this.agents.find((a) => (pty != null && a.pty_id === pty) || (sid != null && a.session_id === sid)) ?? null;
  }

  onTurnEnd(e: LeeEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const a = this.findAgent(data);
    if (!a) return;
    if (a.pty_id == null && typeof data.pty_id === 'number') a.pty_id = data.pty_id;
    a.turns += 1;
    const summary = typeof data.summary === 'string' ? data.summary.slice(0, SUMMARY_MAX) : null;
    const lee = (data.lee_status ?? null) as LeeStatusBlock | null;
    const save = parseSaveLine(summary);
    if (save) this.proposeSave(a, save);
    if (lee?.status === 'blocked' && a.op && a.purpose !== 'escalate') this.proposeEscalate(a, lee.summary ?? summary ?? '');
  }

  private proposeSave(a: TrackedAgent, def: OperationDef): void {
    this.runtime.suggest(a.workspace, def, 'operation agent');
    const id = `opsave_${crypto.randomBytes(4).toString('hex')}`;
    this.pending.set(id, { kind: 'save', workspace: a.workspace, def });
    cockpitBus.feed.post({
      workspace: a.workspace,
      kind: 'proposal',
      severity: 'ambient',
      producer: 'ops',
      title: `Save '${def.name}' as an operation?`,
      text: def.cwd ? `in ${def.cwd}` : null,
      ref: { proposal_id: id, op: def.name, task_id: a.task_id },
      actions: [
        { id: 'approve', label: 'Save', style: 'primary', confirm_text: def.command },
        { id: 'reject', label: 'Not now', style: 'plain' },
      ],
      dedupe_key: `ops:save:${a.workspace}:${def.name}`,
    });
  }

  private proposeEscalate(a: TrackedAgent, report: string): void {
    const claim = cockpitBus.claimNudge({
      item_ref: `op:${a.workspace}:${a.op}`,
      state_key: `blocked:${a.turns}`,
      source: 'ops',
      workspace: a.workspace,
    });
    if (!claim.granted) return;
    const id = `opesc_${crypto.randomBytes(4).toString('hex')}`;
    this.pending.set(id, { kind: 'escalate', workspace: a.workspace, agent: a, report });
    const prompt = escalatePrompt({ name: a.op!, report, command: a.command ?? '', excerpt: a.excerpt });
    cockpitBus.feed.post({
      workspace: a.workspace,
      kind: 'proposal',
      severity: 'needs-you',
      producer: 'ops',
      title: `Escalate ${a.op} to a task?`,
      text: report || null,
      text_is_agent: !!report,
      item_ref: `op:${a.workspace}:${a.op}`,
      ref: { proposal_id: id, op: a.op!, task_id: a.task_id },
      actions: [
        { id: 'approve', label: 'Escalate', style: 'primary', confirm_text: prompt },
        { id: 'reject', label: 'Not now', style: 'plain' },
      ],
      dedupe_key: `ops:escalate:${a.workspace}:${a.op}`,
    });
  }

  hasProposal(id: string): boolean {
    return this.pending.has(id);
  }

  async resolve(id: string, approved: boolean, principal: Principal, windowId: number | null = null): Promise<{ success: boolean; error?: string; data?: unknown }> {
    const p = this.pending.get(id);
    if (!p) return { success: false, error: 'not_found' };
    this.pending.delete(id);
    if (p.kind === 'save') {
      if (!approved) return this.runtime.dismissSuggestion(p.workspace, p.def!.name, principal);
      return this.runtime.confirm(p.workspace, [p.def!.name], principal);
    }
    if (!approved) return { success: true };
    const a = p.agent!;
    const launcher = cockpitBus.launcher;
    if (!launcher) return { success: false, error: 'launcher_unavailable' };
    const agent = getCockpitConfig(a.workspace).operation_agent;
    const launch: LaunchRequest = {
      workspace: a.workspace,
      title: `Fix: ${a.op}`,
      prompt: escalatePrompt({ name: a.op!, report: p.report ?? '', command: a.command ?? '', excerpt: a.excerpt }),
      kind: 'bug',
      lead: 'delegate',
      model: agent.escalate_model,
      permission_mode: 'acceptEdits',
      worktree: true,
      origin: { kind: 'operation', ref: a.op },
    };
    const res = await launcher.launch(launch, principal, windowId);
    if (res.success && res.task_id) {
      this.track({ ...a, task_id: res.task_id, pty_id: res.pty_id ?? null, session_id: res.session_id ?? null, purpose: 'escalate', turns: 0 });
      logCockpitEvent('opagent.escalate', { workspace: a.workspace, actor: actorFor(principal), data: { from_task_id: a.task_id, task_id: res.task_id, op: a.op } });
      logCockpitEvent('opagent.launch', {
        workspace: a.workspace,
        actor: actorFor(principal),
        data: { task_id: res.task_id, ...(res.pty_id != null ? { pty_id: res.pty_id } : {}), op: a.op, purpose: 'escalate', model: launch.model },
      });
    }
    return { success: res.success, error: res.error, data: res };
  }
}
