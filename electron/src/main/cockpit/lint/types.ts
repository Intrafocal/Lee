/**
 * Work lint rule interface (contracts §8.2). Pure: no Electron, no I/O.
 */

import type { LeeEvent, Principal } from '../../../shared/copilot';
import type { CockpitTask, GitSnapshot, LintFamily, LintFix, LintFixResult, LintSeverity } from '../../../shared/cockpit';
import type { OpsProvider, TaskLauncher } from '../cockpit-bus';
import type { LintRuleConfig } from '../cockpit-config';
import type { HumanBalance } from '../hester-cache';

/** An added line from the working-tree diff against HEAD, or a line of an untracked file (v4 project rules). */
export interface AddedLine {
  path: string;
  line: number;
  text: string;
}

/** A `.lee/lint/*.yaml` rule (v4 §7.3), already validated. */
export interface ProjectRuleDef {
  /** Without the `project/` prefix. */
  id: string;
  message: string;
  severity: LintSeverity;
  /** JS regex source, compiled with the `m` flag. */
  pattern: string;
  /** Workspace-relative globs; empty = every file. */
  paths: string[];
  file: string;
}

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
  // v4 §7.3 providers. All return cached values (null = not known yet) and never block.
  /** Workspaces with an open window. */
  workspaces(): string[];
  git(workspace: string): GitSnapshot | null;
  /** Lower-cased text of the Markdown under docs/ and the root README (new-files-undocumented). */
  docText(workspace: string): string | null;
  /** Added diff lines and untracked-file lines; only computed while the workspace has project rules. */
  addedLines(workspace: string): AddedLine[] | null;
  tasks(workspace: string): CockpitTask[] | null;
  /** The task whose agent runs in this PTY. */
  taskByPty(ptyId: number): CockpitTask | null;
  stewardActive(workspace: string | null): boolean;
  humanBalance(workspace: string): HumanBalance | null;
  projectRules(workspace: string): ProjectRuleDef[];
}

/** Side effects a v4 fix may take. Each is optional: missing means 'unavailable'. */
export interface LintEffects {
  /** Spawn the git TUI tab in the workspace's window. */
  openGit?(workspace: string): Promise<boolean>;
  /** Open a file (absolute path) at a line in the workspace's window. */
  openFile?(workspace: string, file: string, line: number | null): Promise<boolean>;
  /**
   * Type into an agent tab (the tab domain's send_input with submit) as `by`,
   * the principal who clicked the fix. Only the local user types while the
   * agent is busy.
   */
  sendInput?(ptyId: number, text: string, by: Principal): Promise<{ success: boolean; error?: string }>;
  checkin?(ptyId: number): Promise<{ success: boolean; error?: string }>;
  focusTab?(ptyId: number): Promise<{ success: boolean; error?: string }>;
  /** Ideas capture (source lee). */
  capture?(workspace: string, text: string): Promise<{ success: boolean; error?: string }>;
  /** A Hester request (shared token, X-Lee-Workspace). Throws on failure. */
  hester?(workspace: string, method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown): Promise<unknown>;
  endFocus?(): Promise<boolean>;
}

export interface LintFixContext extends LintContext {
  /** Who applied the fix (the renderer: local-user; a Feed action: its principal). */
  by: Principal;
  launcher: TaskLauncher | null;
  writeClaudeAllow(workspace: string, rules: string[]): Promise<void>;
  ignoreCommands(workspace: string, sigs: string[]): Promise<void>;
  effects: LintEffects;
}

export interface LintRule {
  /** e.g. 'toil/repeated-sequence'. Project rules use 'project/*'; their findings carry 'project/<id>'. */
  id: string;
  family: LintFamily;
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
