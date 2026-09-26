/**
 * Task launcher (contract §5.6): starts an agent for a task in a new tab
 * (instantly, offline) and relays the task record to Hester with a spool.
 * The prompt goes only into the agent's argv: never to Hester, the event log
 * or lee.log.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type { Principal } from '../../shared/copilot';
import type { ClaudePermissionMode, LaunchRequest, LaunchResult, TaskKind, TaskLead, TaskOrigin } from '../../shared/cockpit';
import { COCKPIT_IPC } from '../../shared/cockpit';
import { windowRegistry } from '../window-registry';
import { logCockpitEvent, type TaskCreateInput, type TaskLauncher } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import type { TaskRelay, TaskRecord } from './task-relay';
import { actorFor, type TabRuntimeImpl } from './tab-runtime';

const KINDS: TaskKind[] = ['bug', 'question', 'prototype', 'chore', 'unknown'];
const LEADS: TaskLead[] = ['delegate', 'human', 'plan'];
const MODES: ClaudePermissionMode[] = ['acceptEdits', 'plan', 'manual', 'auto', 'dontAsk'];
const TITLE_MAX = 60;
const PROMPT_MAX = 100_000;

export function newTaskId(): string {
  return `task-${crypto.randomBytes(4).toString('hex')}`;
}

export function slugify(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'agent'}-${suffix}`;
}

export interface LaunchPlan {
  lead: TaskLead;
  kind: TaskKind;
  permission_mode: ClaudePermissionMode;
  worktree: boolean;
  title: string;
  /** The title was given (not derived from the prompt's first line). */
  titled: boolean;
}

/** Defaults from contract §5.6 step 4 (pure). */
export function launchPlan(req: LaunchRequest, opts: { worktree_for_delegate: boolean }): LaunchPlan {
  const lead: TaskLead = LEADS.includes(req.lead as TaskLead) ? (req.lead as TaskLead) : 'delegate';
  const kind: TaskKind = KINDS.includes(req.kind as TaskKind) ? (req.kind as TaskKind) : 'unknown';
  const permission_mode: ClaudePermissionMode = MODES.includes(req.permission_mode as ClaudePermissionMode)
    ? (req.permission_mode as ClaudePermissionMode)
    : lead === 'plan'
      ? 'plan'
      : 'acceptEdits';
  const worktree = typeof req.worktree === 'boolean' ? req.worktree : lead === 'delegate' && opts.worktree_for_delegate;
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
  const titled = typeof req.title === 'string' && !!req.title.trim();
  const title = (titled ? (req.title as string).trim() : prompt.split('\n')[0].slice(0, TITLE_MAX).trim()) || 'Task';
  return { lead, kind, permission_mode, worktree, title, titled };
}

/** Claude argv for a launch (pure). The prompt follows `--`, so a leading '-' stays positional. */
export function buildClaudeArgs(
  req: LaunchRequest,
  ids: { session_id: string; slug?: string | null; worktree_for_delegate?: boolean },
): string[] {
  const plan = launchPlan(req, { worktree_for_delegate: ids.worktree_for_delegate ?? true });
  // The worktree dir and branch are on disk: named after a given title, never the prompt.
  const slug = plan.worktree ? ids.slug ?? slugify(plan.titled ? plan.title : 'task', crypto.randomBytes(2).toString('hex')) : null;
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
  const tools = list(req.tools);
  const allowed = list(req.allowed_tools);
  return [
    '--permission-mode',
    plan.permission_mode,
    ...(slug ? ['--worktree', slug] : []),
    '--session-id',
    ids.session_id,
    '-n',
    plan.title,
    ...(req.model ? ['--model', req.model] : []),
    ...(tools.length ? ['--tools', tools.join(',')] : []),
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    ...(prompt ? ['--', prompt] : []),
  ];
}

function providerLabel(provider: string): string {
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Agent';
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function openWorkspace(requested: unknown): string | null {
  if (typeof requested !== 'string' || !requested.trim()) return null;
  for (const [, w] of windowRegistry.getAll()) {
    if (w.workspace && samePath(w.workspace, requested.trim())) return w.workspace;
  }
  return null;
}

function validOrigin(o: unknown): TaskOrigin | null {
  if (!o || typeof o !== 'object') return null;
  const v = o as Record<string, unknown>;
  const kinds = ['launcher', 'agent', 'checkin', 'someday', 'operation', 'lint', 'hester'];
  if (typeof v.kind !== 'string' || !kinds.includes(v.kind)) return null;
  return { kind: v.kind as TaskOrigin['kind'], ref: typeof v.ref === 'string' ? v.ref : null };
}

export class TaskLauncherImpl implements TaskLauncher {
  private readonly rt: TabRuntimeImpl;
  private readonly relayer: TaskRelay;

  constructor(rt: TabRuntimeImpl, relay: TaskRelay) {
    this.rt = rt;
    this.relayer = relay;
  }

  async launch(req: LaunchRequest, by: Principal, windowId?: number | null): Promise<LaunchResult> {
    // A launch runs a model: humans only (C2).
    if (by.kind === 'shared') return { success: false, error: 'forbidden' };
    if (!req || typeof req !== 'object') return { success: false, error: 'invalid' };
    const workspace = openWorkspace(req.workspace);
    if (!workspace) return { success: false, error: "workspace must be an open window's workspace" };
    const win = this.rt.pickWindow(workspace, windowId ?? null);
    if (win == null) return { success: false, error: 'no_window' };
    if (req.prompt != null && (typeof req.prompt !== 'string' || req.prompt.length > PROMPT_MAX)) return { success: false, error: 'invalid' };
    if (req.task_id != null && (typeof req.task_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(req.task_id))) {
      return { success: false, error: 'invalid' };
    }

    const cfg = getCockpitConfig(workspace).cockpit;
    const plan = launchPlan(req, { worktree_for_delegate: cfg.launch.worktree_for_delegate });
    const taskId = req.task_id ?? newTaskId();
    const origin = validOrigin(req.origin) ?? { kind: 'launcher', ref: null };
    const serves = Array.isArray(req.serves) ? req.serves.filter((s): s is string => typeof s === 'string') : [];
    const record = (status: TaskRecord['status'], agent: TaskRecord['agent']): TaskRecord => ({
      id: taskId,
      workspace,
      // A title derived from the prompt would put prompt text in the spool and
      // Hester's task file: such a task starts untitled and Hester names it
      // from the agent's own summary (title_source 'auto', contract §6.4).
      title: plan.titled ? plan.title : '(untitled)',
      title_source: plan.titled ? 'user' : 'auto',
      kind: plan.kind,
      lead: plan.lead,
      play: !!req.play,
      status,
      agent,
      serves,
      confirmed: true,
      origin,
    });

    if (plan.lead === 'human') {
      const relayed = await this.relayer.relay(record('queued', null));
      return { success: true, task_id: taskId, pty_id: null, tab_id: null, session_id: null, relayed };
    }

    const provider = typeof req.provider === 'string' && req.provider ? req.provider : cfg.launch.provider;
    // The tab label reaches lee.log (PTY name) and the saved session, so it is
    // never derived from the prompt: an explicit label or title, else generic.
    const explicitTitle = typeof req.title === 'string' && req.title.trim() ? req.title.trim().slice(0, TITLE_MAX) : null;
    const label = (typeof req.label === 'string' && req.label.trim()) || explicitTitle || `${providerLabel(provider)} task`;
    const model = typeof req.model === 'string' && req.model ? req.model : null;
    let sessionId: string | null = null;
    let opened: { pty_id: number | null; tab_id: number | null; error?: string };
    if (provider === 'claude') {
      sessionId = crypto.randomUUID();
      const args = buildClaudeArgs(req, { session_id: sessionId, worktree_for_delegate: cfg.launch.worktree_for_delegate });
      // An agent tab (type 'agent', provider 'claude'), so it is typed, walled,
      // iconed and restored like ⇧⌘C Claude tabs; the argv carries the
      // pre-assigned session id and prompt, and hooks are added at spawn.
      opened = await this.rt.openTab(
        { workspace, window_id: win, type: 'agent', provider: 'claude', label, command: 'claude', args, activate: !!req.go_into },
        { session_id: sessionId },
      );
    } else {
      if (typeof req.prompt === 'string' && req.prompt.trim()) return { success: false, error: 'prompt_unsupported' };
      opened = await this.rt.openTab({ workspace, window_id: win, type: 'agent', label, provider, activate: !!req.go_into });
    }
    if (opened.pty_id == null && opened.error && opened.error !== 'timeout') {
      return { success: false, error: opened.error, task_id: taskId };
    }
    if (opened.pty_id != null) this.rt.setTask(opened.pty_id, taskId, sessionId);

    const relayed = await this.relayer.relay(
      record('running', { provider, pty_id: opened.pty_id, session_id: sessionId, tab_label: label, model }),
    );

    logCockpitEvent('task.launch', {
      workspace,
      window_id: win,
      actor: actorFor(by),
      data: {
        task_id: taskId,
        ...(opened.pty_id != null ? { pty_id: opened.pty_id } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        provider,
        lead: plan.lead,
        kind: plan.kind,
        confirmed: true,
        play: !!req.play,
        worktree: provider === 'claude' ? plan.worktree : false,
        ...(provider === 'claude' ? { permission_mode: plan.permission_mode } : {}),
        ...(model ? { model } : {}),
        origin_kind: origin.kind,
      },
    });

    if (req.go_into && opened.pty_id != null) {
      try {
        windowRegistry.get(win)?.browserWindow.webContents.send(COCKPIT_IPC.goInto, { pty_id: opened.pty_id, tab_id: opened.tab_id });
      } catch {
        // window gone
      }
    }
    return { success: true, task_id: taskId, pty_id: opened.pty_id, tab_id: opened.tab_id, session_id: sessionId, relayed };
  }

  async createTask(input: TaskCreateInput): Promise<{ task_id: string; relayed: boolean }> {
    const taskId = newTaskId();
    const kind: TaskKind = KINDS.includes(input.kind as TaskKind) ? (input.kind as TaskKind) : 'unknown';
    const lead: TaskLead = LEADS.includes(input.lead as TaskLead) ? (input.lead as TaskLead) : 'delegate';
    const relayed = await this.relayer.relay({
      id: taskId,
      workspace: input.workspace,
      title: (input.title || 'Task').slice(0, 200),
      title_source: 'user',
      kind,
      lead,
      play: false,
      status: input.status ?? 'queued',
      agent: null,
      serves: [],
      confirmed: input.confirmed ?? true,
      origin: input.origin ?? { kind: 'launcher', ref: null },
      ...(input.note ? { note: input.note } : {}),
    });
    return { task_id: taskId, relayed };
  }
}
