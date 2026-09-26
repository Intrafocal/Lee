/**
 * Shared pieces of the v4 lint rules (contract v4 §7.3): task helpers, stable
 * hashes for state keys, and the fixes several rules offer. Predicates stay in
 * the rule files and stay pure; only the fix helpers have side effects, all
 * through the injected LintFixContext.
 */

import * as crypto from 'crypto';
import type { CockpitTask, LintFix, LintFixResult } from '../../../../shared/cockpit';
import { UNAVAILABLE } from '../types';
import type { LintFinding, LintFixContext } from '../types';

export const WRAP_UP_TEXT =
  'Please wrap up: finish the current step, summarise what you did in a lee-status block, and stop.';

export function shortHash(...parts: unknown[]): string {
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 10);
}

export function isOpenTask(t: CockpitTask): boolean {
  return t.status !== 'done' && t.status !== 'discarded';
}

export function openTasks(tasks: CockpitTask[] | null): CockpitTask[] {
  return (tasks ?? []).filter(isOpenTask);
}

export function taskLabel(t: CockpitTask): string {
  return (t.name || t.title || t.id).slice(0, 120);
}

export function taskRef(t: CockpitTask): string {
  return `task:${t.workspace}:${t.id}`;
}

/** Task id and pty travel in the subject as "<task id>" (the finding's workspace names the workspace). */
export function taskOfFinding(f: LintFinding, ctx: LintFixContext): CockpitTask | null {
  if (!f.workspace) return null;
  const id = f.subject.split('\0')[0];
  return ctx.tasks(f.workspace)?.find((t) => t.id === id) ?? null;
}

// Fix descriptors -------------------------------------------------------------

export const FIX_OPEN_GIT: LintFix = { id: 'open-git', label: 'Open Git' };
export const FIX_SUPPRESS_BRANCH: LintFix = { id: 'suppress-branch', label: 'Ignore on this branch' };
export const FIX_SUPPRESS_ITEM: LintFix = { id: 'suppress-item', label: 'Ignore this' };
export const FIX_WRAP_UP: LintFix = { id: 'wrap-up', label: 'Ask it to wrap up', confirm_text: WRAP_UP_TEXT };
export const FIX_PARK: LintFix = { id: 'park', label: 'Park in Someday' };
export const FIX_PROMOTE: LintFix = { id: 'promote-workstream', label: 'Promote to a workstream' };
export const FIX_CHECKIN: LintFix = { id: 'checkin', label: 'Check in' };
export const FIX_LINK_GOAL: LintFix = { id: 'link-goal', label: 'Link a goal' };
export const FIX_EXTEND: LintFix = { id: 'extend', label: 'Extend by 30 min' };

// Fix effects -------------------------------------------------------------------

export async function fixOpenGit(f: LintFinding, ctx: LintFixContext): Promise<LintFixResult> {
  if (!f.workspace) return { success: false, error: 'no_workspace' };
  if (!ctx.effects.openGit) return UNAVAILABLE;
  const ok = await ctx.effects.openGit(f.workspace);
  return ok ? { success: true, message: 'Opened Git' } : { success: false, error: 'No window for this workspace' };
}

/** `wrap-up` (C3): types the exact confirm text into the task's agent, only because you clicked. */
export async function fixWrapUp(task: CockpitTask | null, ctx: LintFixContext): Promise<LintFixResult> {
  const pty = task?.agent?.pty_id;
  if (pty == null) return { success: false, error: 'The task has no live agent tab' };
  if (!ctx.effects.sendInput) return UNAVAILABLE;
  const r = await ctx.effects.sendInput(pty, WRAP_UP_TEXT);
  return r.success ? { success: true, message: `Asked ${taskLabel(task!)} to wrap up` } : { success: false, error: r.error ?? 'send_failed' };
}

/** `park`: captures the task title to Someday and changes nothing else. */
export async function fixPark(task: CockpitTask | null, ctx: LintFixContext): Promise<LintFixResult> {
  if (!task) return { success: false, error: 'not_found' };
  if (!ctx.effects.capture) return UNAVAILABLE;
  const r = await ctx.effects.capture(task.workspace, task.title || taskLabel(task));
  return r.success ? { success: true, message: 'Parked in Someday' } : { success: false, error: r.error ?? 'capture_failed' };
}

export async function fixPromote(task: CockpitTask | null, ctx: LintFixContext): Promise<LintFixResult> {
  if (!task) return { success: false, error: 'not_found' };
  if (!ctx.effects.hester) return UNAVAILABLE;
  try {
    const body = (await ctx.effects.hester(task.workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(task.id)}/promote`, {})) as {
      data?: { workstream_id?: string };
    } | null;
    const wsId = body?.data?.workstream_id;
    return { success: true, message: wsId ? `Promoted to workstream ${wsId}` : 'Promoted to a workstream' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fixExtend(task: CockpitTask | null, ctx: LintFixContext): Promise<LintFixResult> {
  if (!task) return { success: false, error: 'not_found' };
  if (!ctx.effects.hester) return UNAVAILABLE;
  const next = (task.timebox_min ?? 0) + 30;
  try {
    await ctx.effects.hester(task.workspace, 'PATCH', `/cockpit/tasks/${encodeURIComponent(task.id)}`, { timebox_min: next });
    return { success: true, message: `Timebox now ${next} min` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fixCheckin(ptyId: number | null | undefined, ctx: LintFixContext): Promise<LintFixResult> {
  if (ptyId == null) return { success: false, error: 'No live agent tab' };
  if (!ctx.effects.checkin) return UNAVAILABLE;
  const r = await ctx.effects.checkin(ptyId);
  return r.success ? { success: true, message: 'Check-in queued' } : { success: false, error: r.error ?? 'checkin_failed' };
}

export async function fixOpenTab(ptyId: number | null | undefined, ctx: LintFixContext): Promise<LintFixResult> {
  if (ptyId == null) return { success: false, error: 'No live agent tab' };
  if (!ctx.effects.focusTab) return UNAVAILABLE;
  const r = await ctx.effects.focusTab(ptyId);
  return r.success ? { success: true } : { success: false, error: r.error ?? 'not_found' };
}

/** Renderer-side fixes: main does nothing but hand the action back. */
export function rendererAction(action: 'link-goal' | 'what-next', f: LintFinding, taskId: string | null): LintFixResult {
  return { success: true, data: { renderer_action: action, task_id: taskId, workspace: f.workspace } };
}
