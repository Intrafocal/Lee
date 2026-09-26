/**
 * Scope rules (contract v4 §7.3): scope/mixed-changes (uncommitted changes
 * span several areas) and scope/task-growth (a task's files grew well past
 * what it had at its first report). Pure.
 */

import type { CockpitTask, GitSnapshot, LintFixResult } from '../../../../shared/cockpit';
import { UNAVAILABLE, num, strList } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';
import {
  FIX_CHECKIN,
  FIX_OPEN_GIT,
  FIX_PROMOTE,
  fixCheckin,
  fixOpenGit,
  fixPromote,
  openTasks,
  shortHash,
  taskLabel,
  taskOfFinding,
  taskRef,
} from './v4-common';

export const MIXED_CHANGES = 'scope/mixed-changes';

function normArea(a: string): string {
  return a.replace(/\\/g, '/').replace(/\/\*\*?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Area of a workspace-relative path: the longest configured prefix, or the top-level dir when none are configured. */
export function areaOf(p: string, areas: string[]): string | null {
  if (areas.length === 0) {
    const i = p.indexOf('/');
    return i > 0 ? p.slice(0, i) : '.';
  }
  let best: string | null = null;
  for (const raw of areas) {
    const a = normArea(raw);
    if (!a) continue;
    if ((p === a || p.startsWith(`${a}/`)) && (!best || a.length > best.length)) best = a;
  }
  return best;
}

/** Changed paths grouped by area (sorted). Pure. */
export function changesByArea(git: GitSnapshot, areas: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of [...git.changed.map((c) => c.path), ...git.untracked]) {
    const a = areaOf(p, areas);
    if (a === null) continue;
    const l = out.get(a) ?? [];
    l.push(p);
    out.set(a, l);
  }
  return new Map([...out.entries()].sort((x, y) => x[0].localeCompare(y[0])));
}

export class MixedChangesRule implements LintRule {
  readonly id = MIXED_CHANGES;
  readonly family = 'scope' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  private areas(ctx: LintContext, ws: string): string[] {
    return strList(ctx.config(MIXED_CHANGES, ws), 'areas');
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      if (ctx.config(MIXED_CHANGES, ws).severity === 'off') continue;
      const git = ctx.git(ws);
      if (!git) continue;
      const groups = changesByArea(git, this.areas(ctx, ws));
      if (groups.size < 2) continue;
      const names = [...groups.keys()];
      out.push({
        rule: MIXED_CHANGES,
        workspace: ws,
        subject: git.branch ?? 'HEAD',
        message: `Uncommitted changes span ${groups.size} areas: ${names.join(', ')}`,
        evidence: [...groups.entries()].slice(0, 6).map(([a, files]) => `${a}: ${files.length} file${files.length === 1 ? '' : 's'}`),
        fixes: [
          { id: 'create-task', label: 'Split into a task per area', confirm_text: names.map((a) => `New task (chore): Commit the ${a} changes`).join('\n') },
          FIX_OPEN_GIT,
        ],
        item_ref: null,
        state_key: `${MIXED_CHANGES}:${shortHash(names)}`,
      });
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId === 'open-git') return fixOpenGit(f, ctx);
    if (fixId !== 'create-task') return { success: false, error: 'unknown_fix' };
    if (!f.workspace) return { success: false, error: 'no_workspace' };
    if (!ctx.launcher) return UNAVAILABLE;
    const git = ctx.git(f.workspace);
    if (!git) return { success: false, error: 'git_unavailable' };
    const groups = changesByArea(git, this.areas(ctx, f.workspace));
    const ids: string[] = [];
    for (const [area, files] of groups) {
      const r = await ctx.launcher.createTask({
        workspace: f.workspace,
        title: `Commit the ${area} changes`,
        kind: 'chore',
        lead: 'human',
        status: 'queued',
        origin: { kind: 'lint', ref: MIXED_CHANGES },
        note: files.slice(0, 50).join('\n'),
      });
      ids.push(r.task_id);
    }
    return { success: true, message: `Created ${ids.length} tasks` };
  }
}

// ---------------------------------------------------------------------------

export const TASK_GROWTH = 'scope/task-growth';

/** Pure: grown when files_count >= max(min_files, factor x files_at_first_report). */
export function taskGrew(t: CockpitTask, factor: number, minFiles: number): boolean {
  if (t.files_at_first_report == null) return false;
  return t.files_count >= Math.max(minFiles, factor * t.files_at_first_report);
}

export class TaskGrowthRule implements LintRule {
  readonly id = TASK_GROWTH;
  readonly family = 'scope' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      const cfg = ctx.config(TASK_GROWTH, ws);
      if (cfg.severity === 'off') continue;
      const factor = Math.max(1, num(cfg, 'factor', 3));
      const minFiles = Math.max(1, num(cfg, 'min_files', 6));
      for (const t of openTasks(ctx.tasks(ws))) {
        if (!taskGrew(t, factor, minFiles)) continue;
        out.push({
          rule: TASK_GROWTH,
          workspace: ws,
          subject: t.id,
          message: `${taskLabel(t)} has grown to ${t.files_count} files`,
          evidence: [`${t.files_at_first_report} files at its first report, ${t.files_count} now (threshold ${Math.max(minFiles, factor * (t.files_at_first_report ?? 0))})`],
          fixes: [FIX_PROMOTE, FIX_CHECKIN],
          item_ref: taskRef(t),
          state_key: `${TASK_GROWTH}:${Math.floor(Math.log2(Math.max(1, t.files_count)))}`,
        });
      }
    }
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    const task = taskOfFinding(f, ctx);
    if (fixId === 'promote-workstream') return fixPromote(task, ctx);
    if (fixId === 'checkin') return fixCheckin(task?.agent?.pty_id, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}
