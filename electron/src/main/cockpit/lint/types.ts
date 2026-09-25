/**
 * Work lint rule interface (contracts §8.2). Pure: no Electron, no I/O.
 */

import type { LeeEvent } from '../../../shared/copilot';
import type { LintFix, LintFixResult } from '../../../shared/cockpit';
import type { OpsProvider, TaskLauncher } from '../cockpit-bus';
import type { LintRuleConfig } from '../cockpit-config';

export interface LintFinding {
  rule: string;
  workspace: string | null;
  /** Stable within the rule. */
  subject: string;
  /** Fixed wording, no model. */
  message: string;
  /** Why it fired; each line is a fact. */
  evidence: string[];
  /** At least one (spec §10.3 rule 4). */
  fixes: LintFix[];
  /** The task/op it's about, else null (the engine uses "lint:<ws>:<rule>:<subject>"). */
  item_ref: string | null;
  /** Changes when the underlying facts change. */
  state_key: string;
}

export interface LintContext {
  now: number;
  config(rule: string, workspace: string | null): LintRuleConfig;
  commandText(workspace: string, sig: string): string | null;
  toolInfo(signature: string): { tool: string; preview: string | null } | null;
  ops: OpsProvider | null;
  /** Command signatures the user chose to ignore in this workspace (the `ignore-command` fix). */
  ignoredCommands(workspace: string): ReadonlySet<string>;
}

export interface LintFixContext extends LintContext {
  launcher: TaskLauncher | null;
  writeClaudeAllow(workspace: string, rules: string[]): Promise<void>;
  ignoreCommands(workspace: string, sigs: string[]): Promise<void>;
}

export interface LintRule {
  /** e.g. 'toil/repeated-sequence'. */
  id: string;
  family: 'toil';
  /** Event types (v0 and v2). */
  consumes: string[];
  /** History at startup, then live. */
  ingest(ev: LeeEvent): void;
  evaluate(ctx: LintContext): LintFinding[];
  fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult>;
}

export const UNAVAILABLE: LintFixResult = { success: false, error: 'unavailable' };

export function num(cfg: LintRuleConfig, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function strList(cfg: LintRuleConfig, key: string): string[] {
  const v = cfg[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function tsOf(ev: LeeEvent): number {
  const t = Date.parse(ev.ts);
  return Number.isFinite(t) ? t : 0;
}

/** 0 at the threshold, 1 at twice it, 2 at four times...: state keys move on as facts grow, not on every repeat. */
export function bucket(n: number, threshold: number): number {
  if (threshold <= 0 || n < threshold) return 0;
  return Math.floor(Math.log2(n / threshold));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekday(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const DAY_MS = 86_400_000;
