/**
 * Task launcher (contract §5.6): starts an agent for a task in a new tab
 * (instantly, offline) and relays the task record to Hester with a spool.
 * The prompt goes only into the agent's argv: never to Hester, the event log
 * or lee.log.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import type { Principal } from '../../shared/copilot';
import type { ClaudePermissionMode, LaunchRequest, LaunchResult, TaskKind, TaskLead, TaskOrigin, TaskWorktree } from '../../shared/cockpit';
import { COCKPIT_IPC } from '../../shared/cockpit';
import { windowRegistry } from '../window-registry';
import { logCockpitEvent, type TaskCreateInput, type TaskLauncher } from './cockpit-bus';
import { getCockpitConfig, permissionDefault, type PermissionDefault } from './cockpit-config';
import type { TaskRelay, TaskRecord } from './task-relay';
import { actorFor, type TabRuntimeImpl } from './tab-runtime';
import { cleanName } from './session-name';
import { contextRefs, withContext } from './workspace-files';

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

/**
 * Defaults from contract §5.6 step 4 (pure). The permission mode is decided
 * here: plan lead -> 'plan' (it wins over 'auto', given or defaulted); else an
 * explicit mode; else cockpit.launch.permission_default ('auto' by default,
 * 'default' falls back to acceptEdits).
 */
export function launchPlan(
  req: LaunchRequest,
  opts: { worktree_for_delegate: boolean; permission_default?: PermissionDefault },
): LaunchPlan {
  const lead: TaskLead = LEADS.includes(req.lead as TaskLead) ? (req.lead as TaskLead) : 'delegate';
  const kind: TaskKind = KINDS.includes(req.kind as TaskKind) ? (req.kind as TaskKind) : 'unknown';
  const given = MODES.includes(req.permission_mode as ClaudePermissionMode) ? (req.permission_mode as ClaudePermissionMode) : null;
  const permission_mode: ClaudePermissionMode =
    lead === 'plan' && (given == null || given === 'auto')
      ? 'plan'
      : given ?? ((opts.permission_default ?? 'auto') === 'auto' ? 'auto' : 'acceptEdits');
  const worktree = typeof req.worktree === 'boolean' ? req.worktree : lead === 'delegate' && opts.worktree_for_delegate;
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
  const titled = typeof req.title === 'string' && !!req.title.trim();
  const title = (titled ? (req.title as string).trim() : prompt.split('\n')[0].slice(0, TITLE_MAX).trim()) || 'Task';
  return { lead, kind, permission_mode, worktree, title, titled };
}

/**
 * The session name for a launch: the Name you typed, else a title you typed.
 * Never derived from the prompt (Claude writes it to the transcript as a
 * custom-title, which Lee reads back and stores on the task).
 */
export function launchName(req: LaunchRequest): string | null {
  return cleanName(req.name) ?? (typeof req.title === 'string' ? cleanName(req.title) : null);
}

/** A worktree slug for a launch: named after a given title, never the prompt. */
export function worktreeSlug(plan: LaunchPlan): string {
  return slugify(plan.titled ? plan.title : 'task', crypto.randomBytes(2).toString('hex'));
}

const toplevels = new Map<string, string>();

/**
 * The git top level for a workspace (`git rev-parse --show-toplevel`), cached
 * per workspace; the workspace itself when it isn't in a repo or git fails.
 */
export function gitToplevel(workspace: string): string {
  const hit = toplevels.get(workspace);
  if (hit) return hit;
  let top = workspace;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) top = out;
  } catch {
    // not a repo, no git, or timed out: the workspace
  }
  toplevels.set(workspace, top);
  return top;
}

/**
 * Where `claude --worktree <slug>` puts the worktree (contract v3 §4):
 * `<git top level>/.claude/worktrees/<slug>` on branch `worktree-<slug>`
 * (the workspace itself when it isn't in a git repo).
 */
export function worktreeFor(workspace: string, slug: string): TaskWorktree {
  return { slug, path: path.join(gitToplevel(workspace), '.claude', 'worktrees', slug), branch: `worktree-${slug}` };
}

/**
 * Claude argv for a launch (pure). The prompt follows `--`, so a leading '-'
 * stays positional. `refs` are context references (`@path`) appended to it.
 */
export function buildClaudeArgs(
  req: LaunchRequest,
  ids: {
    session_id: string;
    slug?: string | null;
    worktree_for_delegate?: boolean;
    permission_default?: PermissionDefault;
    refs?: readonly string[];
  },
): string[] {
  const plan = launchPlan(req, { worktree_for_delegate: ids.worktree_for_delegate ?? true, permission_default: ids.permission_default });
  // The worktree dir and branch are on disk: named after a given title, never the prompt.
  const slug = plan.worktree ? ids.slug ?? worktreeSlug(plan) : null;
  const prompt = withContext(typeof req.prompt === 'string' ? req.prompt.trim() : '', ids.refs ?? []);
  const name = launchName(req);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
  const tools = list(req.tools);
  const allowed = list(req.allowed_tools);
  return [
    '--permission-mode',
    plan.permission_mode,
    ...(slug ? ['--worktree', slug] : []),
    '--session-id',
    ids.session_id,
    ...(name ? ['--name', name] : []),
    ...(req.model ? ['--model', req.model] : []),
    ...(tools.length ? ['--tools', tools.join(',')] : []),
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    ...(prompt ? ['--', prompt] : []),
  ];
}

/**
 * Pi argv for a launch (pure): `pi [--name n] -- [@files...] [prompt]`. Pi
 * takes an initial message and `@file` arguments itself, so the context refs
 * are passed as its own file arguments.
 */
export function buildPiArgs(req: LaunchRequest, refs: readonly string[] = []): string[] {
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
  const name = launchName(req);
  const tail = [...refs, ...(prompt ? [prompt] : [])];
  return [...(name ? ['--name', name] : []), ...(tail.length ? ['--', ...tail] : [])];
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

export function validOrigin(o: unknown): TaskOrigin | null {
  if (!o || typeof o !== 'object') return null;
  const v = o as Record<string, unknown>;
  const kinds = ['launcher', 'agent', 'checkin', 'someday', 'operation', 'lint', 'hester', 'explore'];
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
    const permission_default = permissionDefault(cfg.launch.permission_default);
    const plan = launchPlan(req, { worktree_for_delegate: cfg.launch.worktree_for_delegate, permission_default });
    const taskId = req.task_id ?? newTaskId();
    const origin = validOrigin(req.origin) ?? { kind: 'launcher', ref: null };
    const serves = Array.isArray(req.serves) ? req.serves.filter((s): s is string => typeof s === 'string') : [];
    const name = launchName(req);
    // Context: paths and bundle ids only; the references go into the argv.
    const ctx = contextRefs(workspace, req.context);
    const provider = typeof req.provider === 'string' && req.provider ? req.provider : cfg.launch.provider;
    // Only a claude launch runs in a worktree; its slug is fixed here so the
    // argv, the relayed record and the task.launch event all name the same one.
    const worktree: TaskWorktree | null =
      plan.lead !== 'human' && provider === 'claude' && plan.worktree ? worktreeFor(workspace, worktreeSlug(plan)) : null;
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
      ...(name ? { name, name_source: 'user' as const } : {}),
      ...(ctx.files.length || ctx.bundles.length ? { context: { files: ctx.files, bundles: ctx.bundles } } : {}),
      ...(worktree ? { worktree } : {}),
    });

    if (plan.lead === 'human') {
      const relayed = await this.relayer.relay(record('queued', null));
      return { success: true, task_id: taskId, pty_id: null, tab_id: null, session_id: null, relayed };
    }

    // The tab label reaches lee.log (PTY name) and the saved session, so it is
    // never derived from the prompt: an explicit label or title, else generic.
    const explicitTitle = typeof req.title === 'string' && req.title.trim() ? req.title.trim().slice(0, TITLE_MAX) : null;
    const label = (typeof req.label === 'string' && req.label.trim()) || name || explicitTitle || `${providerLabel(provider)} task`;
    const model = typeof req.model === 'string' && req.model ? req.model : null;
    let sessionId: string | null = null;
    let opened: { pty_id: number | null; tab_id: number | null; error?: string };
    if (provider === 'claude') {
      sessionId = crypto.randomUUID();
      const args = buildClaudeArgs(req, {
        session_id: sessionId,
        slug: worktree?.slug ?? null,
        worktree_for_delegate: cfg.launch.worktree_for_delegate,
        permission_default,
        refs: ctx.refs,
      });
      // An agent tab (type 'agent', provider 'claude'), so it is typed, walled,
      // iconed and restored like ⇧⌘C Claude tabs; the argv carries the
      // pre-assigned session id and prompt, and hooks are added at spawn.
      opened = await this.rt.openTab(
        { workspace, window_id: win, type: 'agent', provider: 'claude', label, command: 'claude', args, activate: !!req.go_into },
        { session_id: sessionId },
      );
    } else if (provider === 'pi') {
      // Pi takes a name, an initial message and @file arguments on its command line.
      const args = buildPiArgs(req, ctx.refs);
      opened = await this.rt.openTab({ workspace, window_id: win, type: 'agent', label, provider, command: 'pi', args, activate: !!req.go_into });
    } else {
      const hasPrompt = typeof req.prompt === 'string' && !!req.prompt.trim();
      if (hasPrompt || ctx.refs.length) return { success: false, error: 'prompt_unsupported' };
      opened = await this.rt.openTab({ workspace, window_id: win, type: 'agent', label, provider, activate: !!req.go_into });
    }
    if (opened.pty_id == null && opened.error && opened.error !== 'timeout') {
      return { success: false, error: opened.error, task_id: taskId };
    }
    if (opened.pty_id != null) {
      this.rt.setTask(opened.pty_id, taskId, sessionId);
      // Your name, as yours; the record below carries it to Hester.
      if (name) this.rt.setName(opened.pty_id, name, 'user', { relay: false });
    }

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
        // An object when the agent runs in a worktree (truthy, as the old boolean was), else false.
        worktree: worktree ?? false,
        ...(provider === 'claude' ? { permission_mode: plan.permission_mode } : {}),
        ...(model ? { model } : {}),
        origin_kind: origin.kind,
        ...(origin.ref ? { origin_ref: origin.ref } : {}),
        named: !!name,
        ...(ctx.files.length ? { context_files: ctx.files.length } : {}),
        ...(ctx.bundles.length ? { context_bundles: ctx.bundles.length } : {}),
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
