/**
 * Cockpit (v2) settings: the `cockpit:`, `operation_agent:` and `lint:` blocks
 * of ~/.config/lee/config.yaml, ~/.lee/config.yaml and <workspace>/.lee/config.yaml
 * (later wins), deep-merged over the defaults below. Unknown keys are ignored,
 * except under `lint:`, whose keys are rule ids.
 *
 * Operations (`operations:`, `services:`) are NOT read here; package B owns them.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix C),
 * plus later additions: cockpit.launch.permission_default ('auto' | 'default',
 * default 'auto'): the Claude permission mode for launches and plain agent
 * starts that don't pick one (a plan lead is always plan).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { LintSeverity } from '../../shared/cockpit';

export interface LintRuleConfig {
  severity: LintSeverity;
  /** Rule-specific numeric/string/list parameters (min_repeats, window_days, ...). */
  [param: string]: unknown;
}

export interface CockpitConfig {
  cockpit: {
    /**
     * false = no Cockpit: the window is Manual only and Deep is unavailable.
     * There is no default_mode (Deep D1 §1.1): Lee always opens in the Cockpit;
     * an old config's default_mode is ignored like any unknown key.
     */
    enabled: boolean;
    tab: {
      output_buffer_kb: number;
      quiet_ms: number;
    };
    checkin: {
      /** Reply timeout, counted from when the check-in prompt is typed. */
      timeout_s: number;
      /** Unused since check-ins queue behind a busy turn (addendum 2026-09-26b); kept so old configs parse. */
      wait_idle_s: number;
      propose_after_min: number;
    };
    shell_integration: boolean;
    launch: {
      provider: string;
      worktree_for_delegate: boolean;
      /**
       * Claude's permission mode for launches and plain agent starts that do
       * not choose one: 'auto' (`--permission-mode auto`) or 'default' (no
       * flag for plain starts, acceptEdits for delegate launches). A plan
       * lead is always 'plan'.
       */
      permission_default: PermissionDefault;
    };
    nudges: {
      max_per_hour: number;
    };
    detect: {
      enabled: boolean;
      /** Extra directories to look for tools not on PATH (flutter, idf.py). */
      tool_paths: string[];
    };
  };
  operation_agent: {
    model: string;
    plan_model: string;
    escalate_model: string;
  };
  /** Parsed from the flat `lint:` block: every key but `demotion` is a rule id. */
  lint: {
    rules: Record<string, LintRuleConfig>;
    demotion: { min_outcomes: number; dismiss_ratio: number; window_days: number };
    /**
     * v4 `lint: scope/areas: [...]`: path prefixes scope/mixed-changes groups
     * changes by (empty = top-level directories). Also copied into that
     * rule's `areas` parameter.
     */
    areas: string[];
  };
}

export type PermissionDefault = 'auto' | 'default';

/** A configured permission_default, validated: only 'default' opts out of auto. */
export function permissionDefault(v: unknown): PermissionDefault {
  return v === 'default' ? 'default' : 'auto';
}

/**
 * Prepend `--permission-mode auto` to a Claude spawn that doesn't choose a
 * mode itself (⇧⌘C, agent tabs, the prewarmed process, configured TUIs), when
 * cockpit.launch.permission_default is 'auto' (the default). Launches, ops
 * agents and handoffs pass their own --permission-mode and are left alone.
 * Never throws.
 */
export function withClaudePermissionDefault(cmd: string, args: string[], workspace: string | null): string[] {
  try {
    if (!cmd || path.basename(cmd) !== 'claude') return args;
    const end = args.indexOf('--');
    const opts = end >= 0 ? args.slice(0, end) : args;
    const chosen = opts.some(
      (a) => a === '--permission-mode' || a.startsWith('--permission-mode=') || a === '--dangerously-skip-permissions',
    );
    if (chosen) return args;
    if (permissionDefault(getCockpitConfig(workspace).cockpit.launch.permission_default) !== 'auto') return args;
    return ['--permission-mode', 'auto', ...args];
  } catch {
    return args;
  }
}

export const COCKPIT_DEFAULTS: CockpitConfig = {
  cockpit: {
    enabled: true,
    tab: { output_buffer_kb: 256, quiet_ms: 1500 },
    checkin: { timeout_s: 180, wait_idle_s: 120, propose_after_min: 20 },
    shell_integration: true,
    launch: { provider: 'claude', worktree_for_delegate: true, permission_default: 'auto' },
    nudges: { max_per_hour: 6 },
    detect: { enabled: true, tool_paths: [] },
  },
  operation_agent: {
    model: 'claude-haiku-4-5-20251001',
    plan_model: 'sonnet',
    escalate_model: 'sonnet',
  },
  lint: {
    rules: {
      'toil/repeated-sequence': { severity: 'warn', min_repeats: 3, window_days: 7, max_len: 3, min_chars: 8, ignore_commands: [] },
      'toil/flaky-operation': { severity: 'warn', window_runs: 10, min_flips: 2 },
      'toil/long-wait': { severity: 'info', min_minutes: 3, min_occurrences: 3, window_days: 7 },
      'toil/repeat-approval': { severity: 'warn', min_repeats: 10, window_days: 7, fast_ms: 2000, fast_streak: 10 },
      // v4 (contract 2026-09-26 v4 §7.3)
      'commit/large-diff': { severity: 'info', min_changes: 5 },
      'commit/new-files-undocumented': { severity: 'info' },
      'branch/stale': { severity: 'info', days: 30 },
      'stash/forgotten': { severity: 'info', days: 7 },
      'scope/mixed-changes': { severity: 'warn', areas: [] },
      'scope/task-growth': { severity: 'warn', factor: 3, min_files: 6 },
      'time/timebox-exceeded': { severity: 'info' },
      'time/polish-loop': { severity: 'info', turns: 6, max_files: 2 },
      'time/q4-drift': { severity: 'info' },
      'focus/thrash': { severity: 'info', items_per_hour: 4 },
      'balance/q2-starved': { severity: 'info', min_share: 0.1, min_focus_h: 5 },
      'agent/fix-loop': { severity: 'warn', turns: 3 },
    },
    areas: [],
    demotion: { min_outcomes: 10, dismiss_ratio: 0.8, window_days: 30 },
  },
};

const SEVERITIES: LintSeverity[] = ['off', 'info', 'warn', 'needs-you'];
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: CockpitConfig }>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (isPlainObject(cur)) out[k] = merge(cur, v);
    else if (Array.isArray(cur)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (v === null || typeof v === typeof cur || cur === null) out[k] = v;
  }
  return out as T;
}

/** `lint:` accepts `rule: warn` or `rule: { severity: warn, param: value }`, plus `demotion: {...}`. */
function mergeLint(base: CockpitConfig['lint'], overlay: unknown): CockpitConfig['lint'] {
  if (!isPlainObject(overlay)) return base;
  const rules: Record<string, LintRuleConfig> = { ...base.rules };
  let demotion = base.demotion;
  let areas = base.areas;
  for (const [rule, v] of Object.entries(overlay)) {
    if (rule === 'demotion') {
      demotion = merge(demotion, v);
      continue;
    }
    if (rule === 'scope/areas') {
      if (Array.isArray(v)) {
        areas = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        const cur = rules['scope/mixed-changes'] ?? { severity: 'warn' };
        rules['scope/mixed-changes'] = { ...cur, areas };
      }
      continue;
    }
    const cur: LintRuleConfig = rules[rule] ?? { severity: 'warn' };
    if (typeof v === 'string' && (SEVERITIES as string[]).includes(v)) {
      rules[rule] = { ...cur, severity: v as LintSeverity };
    } else if (isPlainObject(v)) {
      const sev = typeof v.severity === 'string' && (SEVERITIES as string[]).includes(v.severity) ? (v.severity as LintSeverity) : cur.severity;
      rules[rule] = { ...cur, ...v, severity: sev };
    }
    // Other shapes are ignored.
  }
  return { rules, demotion, areas };
}

function readDoc(file: string): Record<string, unknown> | undefined {
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    return isPlainObject(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

function configFiles(workspace: string | null | undefined): string[] {
  const home = os.homedir();
  const files = [path.join(home, '.config', 'lee', 'config.yaml'), path.join(home, '.lee', 'config.yaml')];
  if (workspace) files.push(path.join(workspace, '.lee', 'config.yaml'));
  return files;
}

/** Effective cockpit config for a workspace (null = machine-wide only). Cached 10 s. */
export function getCockpitConfig(workspace?: string | null): CockpitConfig {
  const key = workspace || '';
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let value: CockpitConfig = COCKPIT_DEFAULTS;
  for (const file of configFiles(workspace)) {
    const doc = readDoc(file);
    if (!doc) continue;
    value = {
      cockpit: merge(value.cockpit, doc.cockpit),
      operation_agent: merge(value.operation_agent, doc.operation_agent),
      lint: mergeLint(value.lint, doc.lint),
    };
  }
  cache.set(key, { at: now, value });
  return value;
}

/** Rule config with its severity; unknown rules get { severity: 'off' }. */
export function lintRuleConfig(rule: string, workspace?: string | null): LintRuleConfig {
  return getCockpitConfig(workspace).lint.rules[rule] ?? { severity: 'off' };
}

export function invalidateCockpitConfig(): void {
  cache.clear();
}
