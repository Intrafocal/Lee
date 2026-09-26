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

/** Matches of one rule over the added lines, grouped by file (sorted). Pure. */
export function projectMatches(def: ProjectRuleDef, lines: AddedLine[]): Map<string, AddedLine[]> {
  const out = new Map<string, AddedLine[]>();
  let re: RegExp;
  try {
    re = new RegExp(def.pattern, 'm');
  } catch {
    return out;
  }
  for (const l of lines) {
    if (!pathMatches(l.path, def.paths)) continue;
    if (!re.test(l.text)) continue;
    const list = out.get(l.path) ?? [];
    list.push(l);
    out.set(l.path, list);
  }
  return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export class ProjectRules implements LintRule {
  readonly id = PROJECT_RULE;
  readonly family = 'project' as const;
  readonly consumes: string[] = [];
  ingest(): void {}

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const ws of ctx.workspaces()) {
      const defs = ctx.projectRules(ws);
      if (defs.length === 0) continue;
      const lines = ctx.addedLines(ws);
      if (!lines) continue;
      for (const def of defs) {
        const rule = `project/${def.id}`;
        if (ctx.config(rule, ws).severity === 'off') continue;
        let n = 0;
        for (const [file, hits] of projectMatches(def, lines)) {
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
