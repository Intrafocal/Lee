/**
 * Loader for project lint rules (contract v4 §7.3): `<workspace>/.lee/lint/*.yaml`,
 * mtime-cached. A file holds one rule or `rules: [...]`:
 *
 *   id: no-console-log            # default: the file name
 *   message: console.log left in  # default: "Matches <id>"
 *   severity: warn                # off | info | warn | needs-you (default warn)
 *   pattern: "console\\.log\\("   # JS regex, compiled with the m flag (alias: regex)
 *   paths: ["src/**\/*.ts"]        # globs, workspace-relative (default: all files)
 *
 * `ast_grep:` rules are not supported (ast-grep isn't installed): they are
 * loaded, skipped, and logged once to lee.log. Invalid regexes are skipped
 * the same way.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { LintSeverity } from '../../../shared/cockpit';
import type { ProjectRuleDef } from './types';

const SEVERITIES: LintSeverity[] = ['off', 'info', 'warn', 'needs-you'];
const MAX_RULES = 100;
const MAX_FILE_BYTES = 256 * 1024;

type Log = (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate the rules of one parsed file. Pure apart from `warn`. */
export function parseProjectRuleDoc(doc: unknown, file: string, warn: (msg: string, details: Record<string, unknown>) => void): ProjectRuleDef[] {
  const stem = path.basename(file).replace(/\.ya?ml$/i, '');
  const list: unknown[] = isObj(doc) && Array.isArray(doc.rules) ? doc.rules : [doc];
  const out: ProjectRuleDef[] = [];
  list.forEach((raw, i) => {
    if (!isObj(raw)) return;
    const idRaw = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : list.length > 1 ? `${stem}-${i + 1}` : stem;
    const id = idRaw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    if (raw.ast_grep !== undefined) {
      warn('Lint: project rule uses ast_grep, which is not supported; skipped', { file, rule: id });
      return;
    }
    const pattern = typeof raw.pattern === 'string' ? raw.pattern : typeof raw.regex === 'string' ? raw.regex : null;
    if (!pattern) {
      warn('Lint: project rule has no pattern; skipped', { file, rule: id });
      return;
    }
    try {
      new RegExp(pattern, 'm');
    } catch (err) {
      warn('Lint: project rule has an invalid regex; skipped', { file, rule: id, error: String(err) });
      return;
    }
    const sev = typeof raw.severity === 'string' && (SEVERITIES as string[]).includes(raw.severity) ? (raw.severity as LintSeverity) : 'warn';
    const paths = Array.isArray(raw.paths) ? raw.paths.filter((p): p is string => typeof p === 'string') : typeof raw.paths === 'string' ? [raw.paths] : [];
    out.push({
      id,
      message: typeof raw.message === 'string' && raw.message.trim() ? raw.message.trim().slice(0, 200) : `Matches ${id}`,
      severity: sev,
      pattern,
      paths,
      file,
    });
  });
  return out;
}

export class ProjectRuleLoader {
  private cache = new Map<string, { sig: string; rules: ProjectRuleDef[] }>();
  private warned = new Set<string>();

  constructor(private log?: Log) {}

  /** Rules for a workspace; re-read only when a file's mtime/size (or the file list) changes. */
  load(ws: string): ProjectRuleDef[] {
    const dir = path.join(ws, '.lee', 'lint');
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort();
    } catch {
      this.cache.delete(ws);
      return [];
    }
    const stats: string[] = [];
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        stats.push(`${n}:${st.mtimeMs}:${st.size}`);
      } catch {
        // raced
      }
    }
    const sig = stats.join('|');
    const hit = this.cache.get(ws);
    if (hit && hit.sig === sig) return hit.rules;
    const rules: ProjectRuleDef[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      const file = path.join(dir, n);
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        const doc = yaml.load(fs.readFileSync(file, 'utf8'));
        for (const r of parseProjectRuleDoc(doc, file, (msg, details) => this.warnOnce(`${sig}:${msg}:${JSON.stringify(details)}`, msg, details))) {
          if (seen.has(r.id) || rules.length >= MAX_RULES) continue;
          seen.add(r.id);
          rules.push(r);
        }
      } catch (err) {
        this.warnOnce(`${sig}:${file}`, 'Lint: could not read a project rule file', { file, error: String(err) });
      }
    }
    this.cache.set(ws, { sig, rules });
    return rules;
  }

  /** Severity of `project/<id>` from its file, or null when no such rule. */
  severity(ws: string, id: string): LintSeverity | null {
    return this.load(ws).find((r) => r.id === id)?.severity ?? null;
  }

  private warnOnce(key: string, msg: string, details: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log?.('WARN', msg, details);
  }
}
