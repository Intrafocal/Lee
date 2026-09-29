/**
 * Hygiene rules (contract v4 §7.3): commit/large-diff,
 * commit/new-files-undocumented, branch/stale, stash/forgotten. Pure
 * predicates over the cached GitSnapshot (and the docs text); they replace
 * git_watcher's "commit?" / "document?" status pushes.
 */

import * as path from 'path';
import type { GitSnapshot, LintFixResult } from '../../../../shared/cockpit';
import { DAY_MS, UNAVAILABLE, bucket, num } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';
import { FIX_OPEN_GIT, FIX_SUPPRESS_BRANCH, FIX_SUPPRESS_ITEM, fixOpenGit, shortHash } from './v4-common';

/** Source extensions new-files-undocumented looks at. */
export const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.dart', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.swift', '.kt', '.java', '.rb', '.lua', '.sh',
]);

const MAX_LISTED = 5;

function list(items: string[]): string {
  return items.length <= MAX_LISTED ? items.join(', ') : `${items.slice(0, MAX_LISTED).join(', ')} and ${items.length - MAX_LISTED} more`;
}

function eachGit(ctx: LintContext, rule: string, fn: (ws: string, git: GitSnapshot) => void): void {
  for (const ws of ctx.workspaces()) {
    if (ctx.config(rule, ws).severity === 'off') continue;
    const git = ctx.git(ws);
    if (git) fn(ws, git);
  }
}

// ---------------------------------------------------------------------------

export const LARGE_DIFF = 'commit/large-diff';

export class LargeDiffRule implements LintRule {
  readonly id = LARGE_DIFF;
  readonly family = 'hygiene' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    eachGit(ctx, LARGE_DIFF, (ws, git) => {
      const min = Math.max(1, num(ctx.config(LARGE_DIFF, ws), 'min_changes', 5));
      const n = git.changed.length + git.untracked.length;
      if (n < min) return;
      const branch = git.branch ?? 'HEAD';
      out.push({
        rule: LARGE_DIFF,
        workspace: ws,
        subject: branch,
        message: `${n} uncommitted changes on ${branch}`,
        evidence: [
          `${git.changed.length} changed and ${git.untracked.length} untracked files`,
          ...(n > 0 ? [list([...git.changed.map((c) => c.path), ...git.untracked])] : []),
        ],
        fixes: [FIX_OPEN_GIT, FIX_SUPPRESS_BRANCH],
        item_ref: null,
        state_key: `${LARGE_DIFF}:${branch}:${bucket(n, min)}`,
      });
    });
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId === 'open-git') return fixOpenGit(f, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}

// ---------------------------------------------------------------------------

export const NEW_FILES_UNDOCUMENTED = 'commit/new-files-undocumented';

function isSourceFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  if (!CODE_EXTS.has(ext)) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === 'node_modules' || s === 'dist' || s === 'build' || s === 'docs' || s === 'test' || s === 'tests' || s === '__tests__')) return false;
  const base = path.basename(p);
  return !/(^test_|[._-](test|spec)\.)/i.test(base);
}

/** New (untracked or added) source files whose basename no doc mentions. Pure. */
export function undocumentedFiles(git: GitSnapshot, docText: string): string[] {
  const added = git.changed.filter((c) => c.status.includes('A')).map((c) => c.path);
  const out: string[] = [];
  for (const p of [...git.untracked, ...added]) {
    if (!isSourceFile(p) || out.includes(p)) continue;
    if (!docText.includes(path.basename(p).toLowerCase())) out.push(p);
  }
  return out.sort();
}

export class NewFilesUndocumentedRule implements LintRule {
  readonly id = NEW_FILES_UNDOCUMENTED;
  readonly family = 'hygiene' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    eachGit(ctx, NEW_FILES_UNDOCUMENTED, (ws, git) => {
      const docs = ctx.docText(ws);
      if (docs === null) return;
      const files = undocumentedFiles(git, docs);
      if (files.length === 0) return;
      const names = files.map((p) => path.basename(p));
      out.push({
        rule: NEW_FILES_UNDOCUMENTED,
        workspace: ws,
        subject: 'new-files',
        message: `${files.length} new file${files.length === 1 ? '' : 's'} not mentioned in the docs`,
        evidence: [`Not mentioned under docs/ or in README: ${list(files)}`],
        fixes: [
          { id: 'create-task', label: 'Create a task to document them', confirm_text: `New task (chore): Document ${list(names)}` },
          FIX_SUPPRESS_ITEM,
        ],
        item_ref: null,
        state_key: `${NEW_FILES_UNDOCUMENTED}:${shortHash(files)}`,
      });
    });
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId !== 'create-task') return { success: false, error: 'unknown_fix' };
    if (!f.workspace) return { success: false, error: 'no_workspace' };
    if (!ctx.launcher) return UNAVAILABLE;
    const git = ctx.git(f.workspace);
    const files = git ? undocumentedFiles(git, ctx.docText(f.workspace) ?? '') : [];
    const names = files.map((p) => path.basename(p));
    const res = await ctx.launcher.createTask({
      workspace: f.workspace,
      title: `Document ${list(names.length ? names : ['new files'])}`.slice(0, 200),
      kind: 'chore',
      lead: 'delegate',
      status: 'queued',
      origin: { kind: 'lint', ref: NEW_FILES_UNDOCUMENTED },
      note: files.join('\n'),
    });
    return { success: true, message: `Created task ${res.task_id}${res.relayed ? '' : ' (will reach Hester when it is running)'}` };
  }
}

// ---------------------------------------------------------------------------

export const BRANCH_STALE = 'branch/stale';

export class StaleBranchRule implements LintRule {
  readonly id = BRANCH_STALE;
  readonly family = 'hygiene' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    eachGit(ctx, BRANCH_STALE, (ws, git) => {
      const days = Math.max(1, num(ctx.config(BRANCH_STALE, ws), 'days', 30));
      const stale = git.branches
        .filter((b) => !b.merged && b.name !== git.branch && b.name !== git.default_branch && ctx.now - b.last_commit_ms > days * DAY_MS)
        .sort((a, b) => a.last_commit_ms - b.last_commit_ms);
      if (stale.length === 0) return;
      const names = stale.map((b) => b.name);
      out.push({
        rule: BRANCH_STALE,
        workspace: ws,
        subject: 'branches',
        message: `${stale.length} unmerged branch${stale.length === 1 ? '' : 'es'} untouched for over ${days} days`,
        evidence: stale.slice(0, MAX_LISTED).map((b) => `${b.name}: last commit ${Math.floor((ctx.now - b.last_commit_ms) / DAY_MS)} days ago, not merged into ${git.default_branch ?? 'the default branch'}`),
        fixes: [FIX_OPEN_GIT],
        item_ref: null,
        state_key: `${BRANCH_STALE}:${shortHash(names)}`,
      });
    });
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId === 'open-git') return fixOpenGit(f, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}

// ---------------------------------------------------------------------------

export const STASH_FORGOTTEN = 'stash/forgotten';

export class ForgottenStashRule implements LintRule {
  readonly id = STASH_FORGOTTEN;
  readonly family = 'hygiene' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    eachGit(ctx, STASH_FORGOTTEN, (ws, git) => {
      const days = Math.max(1, num(ctx.config(STASH_FORGOTTEN, ws), 'days', 7));
      const old = git.stashes.filter((s) => ctx.now - s.ms > days * DAY_MS);
      if (old.length === 0) return;
      out.push({
        rule: STASH_FORGOTTEN,
        workspace: ws,
        subject: 'stashes',
        message: `${old.length} stash${old.length === 1 ? '' : 'es'} older than ${days} days`,
        evidence: old.slice(0, MAX_LISTED).map((s) => `${s.ref} (${Math.floor((ctx.now - s.ms) / DAY_MS)} days): ${s.message.slice(0, 120)}`),
        fixes: [FIX_OPEN_GIT],
        item_ref: null,
        state_key: `${STASH_FORGOTTEN}:${shortHash(old.map((s) => s.ms))}`,
      });
    });
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId === 'open-git') return fixOpenGit(f, ctx);
    return { success: false, error: 'unknown_fix' };
  }
}
