/**
 * Project rules (contract v4 §7.3): `.lee/lint/*.yaml` regexes matched against
 * added lines (the working-tree diff against HEAD) and lines of untracked
 * files, in files matching the rule's `paths` globs. Findings carry rule id
 * `project/<id>`. Pure: the defs and lines come from the context.
 */

import * as path from 'path';
import type { LintFixResult } from '../../../../shared/cockpit';
import { UNAVAILABLE } from '../types';
import type { AddedLine, LintContext, LintFinding, LintFixContext, LintRule, ProjectRuleDef } from '../types';
import { FIX_SUPPRESS_ITEM, shortHash } from './v4-common';

export const PROJECT_RULE = 'project/*';
const MAX_EVIDENCE = 5;
const MAX_FINDINGS_PER_RULE = 20;

/** Glob to RegExp: `**` any depth, `*` within a segment, `?` one char; a glob without '/' matches the basename anywhere. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function pathMatches(p: string, globs: string[]): boolean {
  if (globs.length === 0) return true;
  return globs.some((g) => globToRegExp(g).test(p));
}

/** Only this much of a line is tested (a minified bundle's one line can be megabytes). */
export const MAX_LINE_CHARS = 2000;
/** Lines tested per evaluate, across every rule and workspace. */
export const MAX_LINES_PER_EVALUATE = 100_000;
/** A rule whose matching takes longer than this is skipped for the current lines. */
export const RULE_BUDGET_MS = 200;

interface Compiled {
  re: RegExp | null;
  globs: RegExp[];
}

const compiledCache = new Map<string, Compiled>();

/** The rule's regex and path globs, compiled once per (pattern, paths). */
function compile(def: ProjectRuleDef): Compiled {
  const key = `${def.pattern}\0${def.paths.join('\0')}`;
  let c = compiledCache.get(key);
  if (!c) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(def.pattern, 'm');
    } catch {
      re = null;
    }
    c = { re, globs: def.paths.map(globToRegExp) };
    if (compiledCache.size > 500) compiledCache.clear();
    compiledCache.set(key, c);
  }
  return c;
}

export interface MatchBudget {
  /** Lines left to test in this evaluate; decremented. */
  lines: number;
  /** Per-rule time bound (ms). */
  ms?: number;
  now?: () => number;
}

/**
 * Matches of one rule over the added lines, grouped by file (sorted). Pure.
 * With a budget: returns null when the budget ran out or the rule took longer
 * than `budget.ms` (the rule is skipped for these lines).
 */
export function projectMatches(def: ProjectRuleDef, lines: AddedLine[], budget?: MatchBudget): Map<string, AddedLine[]> | null {
  const out = new Map<string, AddedLine[]>();
  const { re, globs } = compile(def);
  if (!re) return out;
  const clock = budget?.now ?? Date.now;
  const started = budget?.ms != null ? clock() : 0;
  let lastPath: string | null = null;
  let lastOk = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.path !== lastPath) {
      lastPath = l.path;
      lastOk = globs.length === 0 || globs.some((g) => g.test(l.path));
    }
    if (!lastOk) continue;
    if (budget) {
      if (budget.lines <= 0) return null;
      budget.lines--;
      if (budget.ms != null && (i & 63) === 0 && clock() - started > budget.ms) return null;
    }
    if (!re.test(l.text.length > MAX_LINE_CHARS ? l.text.slice(0, MAX_LINE_CHARS) : l.text)) continue;
    const list = out.get(l.path) ?? [];
    list.push(l);
    out.set(l.path, list);
  }
  if (budget?.ms != null && clock() - started > budget.ms) return null;
  return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

type Warn = (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;

interface Memo {
  lines: AddedLine[];
  key: string;
  /** null: skipped (too slow or over the line budget) for these lines. */
  matches: Map<string, AddedLine[]> | null;
}

export class ProjectRules implements LintRule {
  readonly id = PROJECT_RULE;
  readonly family = 'project' as const;
  readonly consumes: string[] = [];
  ingest(): void {}
  /** Per workspace + rule id: matches until the lines or the rule change. */
  private memo = new Map<string, Memo>();

  constructor(private warn?: Warn) {}

  private matches(ws: string, def: ProjectRuleDef, lines: AddedLine[], budget: MatchBudget): Map<string, AddedLine[]> | null {
    const k = `${ws}\0${def.id}`;
    const key = `${def.pattern}\0${def.paths.join('\0')}`;
    const hit = this.memo.get(k);
    if (hit && hit.lines === lines && hit.key === key) return hit.matches;
    const t0 = Date.now();
    const m = projectMatches(def, lines, budget);
    if (m === null && budget.lines <= 0) {
      // Out of lines for this evaluate: keep the last answer (no flapping) and
      // try again next time rather than memoizing a skip.
      return hit?.matches ?? null;
    }
    if (m === null) {
      this.warn?.('WARN', 'Lint: project rule too slow, skipped until the changes move on', {
        workspace: ws,
        rule: `project/${def.id}`,
        file: def.file,
        ms: Date.now() - t0,
      });
    }
    this.memo.set(k, { lines, key, matches: m });
    return m;
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    const budget: MatchBudget = { lines: MAX_LINES_PER_EVALUATE, ms: RULE_BUDGET_MS };
    const live = new Set<string>();
    for (const ws of ctx.workspaces()) {
      const defs = ctx.projectRules(ws);
      if (defs.length === 0) continue;
      const lines = ctx.addedLines(ws);
      if (!lines) continue;
      for (const def of defs) {
        const rule = `project/${def.id}`;
        if (ctx.config(rule, ws).severity === 'off') continue;
        live.add(`${ws}\0${def.id}`);
        const matches = this.matches(ws, def, lines, budget);
        if (!matches) continue;
        let n = 0;
        for (const [file, hits] of matches) {
          if (n++ >= MAX_FINDINGS_PER_RULE) break;
          out.push({
            rule,
            workspace: ws,
            subject: file,
            message: `${def.message} (${file})`,
            evidence: hits.slice(0, MAX_EVIDENCE).map((h) => `${file}:${h.line}: ${h.text.trim().slice(0, 160)}`),
            fixes: [{ id: 'open-file', label: `Open ${path.basename(file)}:${hits[0].line}` }, FIX_SUPPRESS_ITEM],
            item_ref: null,
            state_key: `${rule}:${shortHash(hits.map((h) => h.text))}`,
          });
        }
      }
    }
    for (const k of [...this.memo.keys()]) if (!live.has(k)) this.memo.delete(k);
    return out;
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    if (fixId !== 'open-file') return { success: false, error: 'unknown_fix' };
    if (!f.workspace) return { success: false, error: 'no_workspace' };
    if (!ctx.effects.openFile) return UNAVAILABLE;
    const m = /^.*?:(\d+):/.exec(f.evidence[0] ?? '');
    const line = m ? Number(m[1]) : null;
    const ok = await ctx.effects.openFile(f.workspace, path.join(f.workspace, f.subject), line);
    return ok ? { success: true, message: `Opened ${f.subject}` } : { success: false, error: 'No window for this workspace' };
  }
}
