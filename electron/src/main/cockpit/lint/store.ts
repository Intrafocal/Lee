/**
 * Lint persistence (contracts §8.2): outcomes, scoped suppressions and rule
 * demotions per workspace under <ws>/.hester/lint/, machine-wide ones under
 * ~/.lee/lint/. Synchronous and small; no Electron.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LintOutcome, LintSuppressScope } from '../../../shared/cockpit';
import { DAY_MS } from './types';

export interface OutcomeRecord {
  ts: string;
  diag_id: string;
  rule: string;
  subject: string;
  outcome: LintOutcome;
  fix_id?: string;
  /** The diagnostic's state when the outcome was recorded (fixed/dismissed stay closed until it changes). */
  state_key?: string;
}

export interface SuppressionEntry {
  diag_id: string;
  rule: string;
  subject: string;
  scope: LintSuppressScope;
  /** scope 'item': quiet until the diagnostic's state_key differs. */
  state_key?: string | null;
  /** scope 'branch': quiet until HEAD's branch differs. */
  branch?: string | null;
  at: string;
}

export interface SuppressionFile {
  items: SuppressionEntry[];
  /** Command signatures ignored by toil/repeated-sequence's `ignore-command` fix. */
  commands: string[];
}

export interface RuleState {
  /** Levels below the configured severity. */
  steps: number;
  flagged: boolean;
  /** Last demotion/recovery (outcomes before it don't count again). */
  changed_at: string | null;
  computed_at: string | null;
  ratio: number;
  n: number;
}

export type RuleStates = Record<string, RuleState>;

const KEEP_OUTCOMES_MS = 90 * DAY_MS;

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export class LintStore {
  private readonly home: string;
  private outcomesCache = new Map<string, OutcomeRecord[]>();
  private suppressCache = new Map<string, SuppressionFile>();
  private rulesCache = new Map<string, RuleStates>();

  constructor(opts: { home?: string } = {}) {
    this.home = opts.home ?? os.homedir();
  }

  dir(workspace: string | null): string {
    return workspace ? path.join(workspace, '.hester', 'lint') : path.join(this.home, '.lee', 'lint');
  }

  private key(workspace: string | null): string {
    return workspace ?? '';
  }

  outcomes(workspace: string | null): OutcomeRecord[] {
    const k = this.key(workspace);
    const hit = this.outcomesCache.get(k);
    if (hit) return hit;
    const list: OutcomeRecord[] = [];
    const cutoff = Date.now() - KEEP_OUTCOMES_MS;
    try {
      for (const line of fs.readFileSync(path.join(this.dir(workspace), 'outcomes.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as OutcomeRecord;
          if (r && typeof r.diag_id === 'string' && typeof r.outcome === 'string' && Date.parse(r.ts) >= cutoff) list.push(r);
        } catch {
          // skip a torn line
        }
      }
    } catch {
      // no file yet
    }
    this.outcomesCache.set(k, list);
    return list;
  }

  appendOutcome(workspace: string | null, rec: OutcomeRecord): void {
    this.outcomes(workspace).push(rec);
    try {
      const dir = this.dir(workspace);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'outcomes.jsonl'), `${JSON.stringify(rec)}\n`);
    } catch (err) {
      console.error('[lint] could not record outcome:', err);
    }
  }

  suppressions(workspace: string | null): SuppressionFile {
    const k = this.key(workspace);
    const hit = this.suppressCache.get(k);
    if (hit) return hit;
    const raw = readJson<Partial<SuppressionFile>>(path.join(this.dir(workspace), 'suppressions.json'), {});
    const file: SuppressionFile = {
      items: Array.isArray(raw.items) ? raw.items.filter((e) => e && typeof e.diag_id === 'string') : [],
      commands: Array.isArray(raw.commands) ? raw.commands.filter((s) => typeof s === 'string') : [],
    };
    this.suppressCache.set(k, file);
    return file;
  }

  saveSuppressions(workspace: string | null, file: SuppressionFile): void {
    this.suppressCache.set(this.key(workspace), file);
    try {
      writeAtomic(path.join(this.dir(workspace), 'suppressions.json'), `${JSON.stringify(file, null, 2)}\n`);
    } catch (err) {
      console.error('[lint] could not save suppressions:', err);
    }
  }

  ruleStates(workspace: string | null): RuleStates {
    const k = this.key(workspace);
    const hit = this.rulesCache.get(k);
    if (hit) return hit;
    const raw = readJson<{ rules?: RuleStates }>(path.join(this.dir(workspace), 'rules.json'), {});
    const states: RuleStates = raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
    this.rulesCache.set(k, states);
    return states;
  }

  saveRuleStates(workspace: string | null, states: RuleStates): void {
    this.rulesCache.set(this.key(workspace), states);
    try {
      writeAtomic(path.join(this.dir(workspace), 'rules.json'), `${JSON.stringify({ rules: states }, null, 2)}\n`);
    } catch (err) {
      console.error('[lint] could not save rule states:', err);
    }
  }

  /** Workspaces (and null for machine-wide) this store has touched. */
  knownWorkspaces(): Array<string | null> {
    const keys = new Set<string>([...this.outcomesCache.keys(), ...this.suppressCache.keys(), ...this.rulesCache.keys()]);
    return [...keys].map((k) => (k === '' ? null : k));
  }
}
