/**
 * Copilot v2 (Cockpit) shared contract: types, event names, IPC channels and
 * the window.lee.cockpit interface. Imported by main, preload and renderer.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix A).
 * This file is copied VERBATIM from that document by every work package that
 * needs it. Do not edit it inside a work package; change the contract instead.
 *
 * Only stable v0/v1 types are imported from ./copilot.
 */

import type { BoardAnchor, VisualResult } from './board';
import type { AgentState, LeeStatusBlock } from './copilot';
import type { DeskCardBrief, DeskCardKind } from './desk';

// ---------------------------------------------------------------------------
// Event log additions (written through logCockpitEvent() in cockpit-bus.ts)
// ---------------------------------------------------------------------------

export type CockpitEventType =
  | 'tab.input'
  | 'tab.read'
  | 'terminal.command'
  | 'checkin.start'
  | 'checkin.result'
  | 'checkin.proposed'
  | 'task.launch'
  | 'operation.run'
  | 'operation.result'
  | 'operation.status'
  | 'operation.suggested'
  | 'operation.confirmed'
  | 'operation.proposal'
  | 'operation.proposal_resolved'
  | 'opagent.launch'
  | 'opagent.escalate'
  | 'cockpit.mode'
  | 'cockpit.go_into'
  | 'feed.action'
  | 'lint.open'
  | 'lint.shown'
  | 'lint.outcome'
  | 'lint.demote'
  | 'nudge.claim'
  | 'deep.input'
  | 'deep.view'
  | 'deep.action'
  | 'deep.affordance'
  | 'deep.switcher'
  | 'desk.zoom'
  | 'deep.idle_push'
  | 'deep.extend';

// ---------------------------------------------------------------------------
// Tabs (package A)
// ---------------------------------------------------------------------------

export type TabRunState = 'idle-at-prompt' | 'busy' | 'awaiting-input' | 'exited' | 'unknown';

/** Where a TabRunState came from, most to least trustworthy. */
export type TabStateSource = 'hooks' | 'shell-integration' | 'pattern' | 'foreground' | 'quiet' | 'none';

export type TabKind = 'agent' | 'shell' | 'tui' | 'other';

/** Spec section 7.6 fidelity tiers. */
export type TabFidelity = 'structured' | 'screen' | 'activity';

export interface TabStateInfo {
  pty_id: number;
  state: TabRunState;
  source: TabStateSource;
  /** ISO time the current state began. */
  since: string;
  /** Milliseconds since the PTY last produced output. */
  quiet_ms: number;
  /** node-pty foreground process title, when known. */
  foreground: string | null;
}

export interface TabLastCommand {
  /** First 12 hex of sha1(normalized command line). */
  sig: string;
  /** Program name only, e.g. "npm". */
  argv0: string;
  /** Full command line. Only over IPC to the local renderer; null over HTTP. */
  text: string | null;
  exit_code: number | null;
  at: string;
}

export interface TabRuntimeInfo {
  pty_id: number;
  tab_id: number | null;
  window_id: number | null;
  workspace: string | null;
  label: string;
  /** TabContext.type of the owning tab, when a tab shows this PTY. */
  tab_type: string | null;
  kind: TabKind;
  provider: string | null;
  fidelity: TabFidelity;
  state: TabStateInfo;
  shell_integration: boolean;
  /** Shell cwd from OSC 7, when shell integration is active. */
  cwd: string | null;
  last_command: TabLastCommand | null;
  /** Linked operation name (package B), if any. */
  operation: string | null;
  /** Linked task id, if Lee launched it for a task. */
  task_id: string | null;
  session_id: string | null;
  /**
   * The agent session's name (addendum 2026-09-26b): typed by you (launcher,
   * Rename) or detected from Claude's transcript title lines (/rename,
   * --name, the AI title). Null when none is known.
   */
  name?: string | null;
  name_source?: AgentNameSource | null;
  /** A check-in queued behind the agent's turn or typed and awaiting its reply; null otherwise. */
  checkin?: TabCheckinInfo | null;
  /** Last <= 5 ANSI-stripped lines. Only for fidelity 'screen'; [] otherwise. */
  tail: string[];
}

/**
 * Where an agent's name came from, highest precedence first: 'user' (typed in
 * Lee), 'custom-title' (Claude /rename or --name), 'ai-title' (Claude's own).
 * A 'user' name is replaced only by a later, different custom-title.
 */
export type AgentNameSource = 'user' | 'custom-title' | 'ai-title';

export interface TabReadRequest {
  /** Cursor from a previous read (total bytes seen). Omit for the tail. */
  since?: number;
  /** Return only the last N lines (default 200, max 2000). Ignored when `since` is set. */
  lines?: number;
  /** Cap on returned characters (default 65536, max 262144). */
  max_chars?: number;
}

export interface TabReadResult {
  pty_id: number;
  /** ANSI-stripped text. */
  text: string;
  /** Pass back as `since` to read only newer output. */
  cursor: number;
  /** True when output older than `since` was already dropped from the ring. */
  truncated: boolean;
  state: TabRunState;
}

export type TabInputPurpose = 'manual' | 'reply' | 'checkin' | 'operation' | 'op-agent';

export interface TabSendRequest {
  text: string;
  /** Append Enter. Agent PTYs get bracketed paste, then Enter after 30 ms. */
  submit?: boolean;
  purpose?: TabInputPurpose;
  /**
   * Local user only: send even though the state is 'unknown'. Never types
   * into a busy agent (that is `while_busy`) and never overrides
   * 'awaiting-input'.
   */
  force?: boolean;
  /**
   * v4: local user only, agent tabs only: type even while the agent is busy
   * (the agent queues it). For an explicit click on text shown first (the
   * steer card's "Send now (agent is busy)", the wrap-up lint fix). Never
   * overrides 'awaiting-input'.
   */
  while_busy?: boolean;
}

export type TabSendError = 'not_found' | 'forbidden' | 'busy' | 'awaiting_input' | 'state_unknown' | 'invalid';

export interface TabSendResult {
  success: boolean;
  error?: TabSendError;
  state?: TabRunState;
  chars?: number;
}

// ---------------------------------------------------------------------------
// Check-ins (package A)
// ---------------------------------------------------------------------------

/** The fixed check-in prompt (spec 4.2). Typed verbatim; never varied. */
export const CHECKIN_PROMPT =
  "Reply with only a lee-status block (status, summary, blockers, files, next) describing your current work. Don't change anything.";

/**
 * Check-in errors. Returned synchronously by the request: not_found,
 * not_agent, forbidden, in_progress, state_unknown (without force).
 * Delivered later (checkin.result, Feed): timeout, state_unknown (a queued
 * hook-less agent went quiet in a state Lee can't read), not_found (the tab
 * closed), cancelled. `busy` and `awaiting_input` are no longer returned: a
 * busy or prompting agent's check-in is queued (addendum 2026-09-26b).
 */
export type CheckinError =
  | 'not_found'
  | 'not_agent'
  | 'busy'
  | 'awaiting_input'
  | 'state_unknown'
  | 'timeout'
  | 'forbidden'
  | 'in_progress'
  | 'cancelled';

/** A pending check-in on a PTY (TabRuntimeInfo.checkin). */
export interface TabCheckinInfo {
  id: string;
  /** 'queued': waiting for the agent's turn to end; 'sent': typed, awaiting the reply. */
  state: 'queued' | 'sent';
  queued_at: string;
  sent_at: string | null;
}

/**
 * The check-in request's answer is immediate: `{success: true, checkin_id,
 * state}`. The final result (lee_status, summary, or a later error) has the
 * same shape and arrives asynchronously (Feed entry, event log, runtime push).
 */
export interface CheckinResult {
  success: boolean;
  checkin_id?: string;
  /** For the immediate answer: queued behind the current turn, or typed now. */
  state?: 'queued' | 'sent';
  error?: CheckinError;
  /** Parsed block, or null when the reply had none (summary is still returned). */
  lee_status?: LeeStatusBlock | null;
  /** The agent's own words (<= 2000 chars). */
  summary?: string | null;
  source?: 'hook' | 'screen';
  task_id?: string | null;
  /** For a shared-token caller: a Feed proposal was created instead of typing. */
  proposed?: boolean;
}

// ---------------------------------------------------------------------------
// Tasks (records owned by Hester, package E; launched by package A)
// ---------------------------------------------------------------------------

export type TaskKind = 'bug' | 'question' | 'prototype' | 'chore' | 'unknown';
export type TaskLead = 'delegate' | 'human' | 'plan';
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'idle' | 'review' | 'done' | 'discarded';

/**
 * Where a task came from. 'explore' refs a spike node ('<exp>/<node>'); 'exploration'
 * (Deep next R3) refs a hand-off record ('<exp>#<answer id>'), which Hester's follower keeps in step.
 * 'page' (Desk D2) refs a hand-off record ('<page id>#<answer id>'); 'exploration' is the pre-Desk form.
 */
export type TaskOriginKind = 'launcher' | 'agent' | 'checkin' | 'someday' | 'operation' | 'lint' | 'hester' | 'explore' | 'goal-eval' | 'exploration' | 'page' | 'board';

// ---------------------------------------------------------------------------
// Copilot v4: goals and steward (contract 2026-09-26 v4 §9)
// ---------------------------------------------------------------------------

export type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type LintFamily = 'toil' | 'hygiene' | 'scope' | 'attention' | 'agent' | 'project';
export interface TaskOverrides { important: boolean | null; urgent: boolean | null; at: string | null }
export interface GitSnapshot {
  workspace: string; at: number; branch: string | null; default_branch: string | null;
  changed: Array<{ path: string; status: string }>; untracked: string[];
  branches: Array<{ name: string; last_commit_ms: number; merged: boolean }>;
  stashes: Array<{ ref: string; ms: number; message: string }>;
}
export type StewardSurface = 'launch-suggest' | 'what-next' | 'evaluate' | 'lint-ask' | 'rail-steer' | 'rail-ask' | 'goal-edit' | 'palette' | 'tui';
export type ProposalAction = 'create_task' | 'launch' | 'link_goal' | 'set_lead' | 'park' | 'open' | 'run_op' | 'explore';
export interface Proposal { id: string; label: string; action: ProposalAction; params: Record<string, unknown> }
export interface StewardSteer { task_id: string; pty_id: number | null; text: string }
export interface StewardAnswer { text: string; proposals: Proposal[]; steer?: StewardSteer | null; surface: StewardSurface; request_id: string; packet?: unknown; stale_measure?: string | null }
export type AboutKind = 'task' | 'exploration' | 'goal' | 'lint' | 'feed' | 'tile' | 'operation' | 'page';
export interface AboutRef { kind: AboutKind; id: string; label: string; record?: unknown }

/** A launch's git worktree (claude `--worktree <slug>`), contract v3 §4. */
export interface TaskWorktree {
  slug: string;
  path: string;
  branch: string;
}

export interface TaskOrigin {
  kind: TaskOriginKind;
  ref?: string | null;
}

export interface TaskAgentRef {
  provider: string;
  pty_id: number | null;
  session_id: string | null;
  tab_label: string | null;
  model?: string | null;
}

/**
 * Context attached at launch (addendum 2026-09-26b): workspace-relative file
 * paths and Hester context bundle ids. Only these references are stored,
 * never file or bundle content.
 */
export interface TaskContextRef {
  files: string[];
  bundles: string[];
}

export interface CockpitTask {
  id: string;
  workspace: string;
  title: string;
  title_source: 'user' | 'agent' | 'auto';
  /** Session name (see AgentNameSource); shown instead of the title when set. Older daemons omit it. */
  name?: string | null;
  name_source?: AgentNameSource | null;
  /** Files and bundles attached at launch (references only). */
  context?: TaskContextRef | null;
  kind: TaskKind;
  status: TaskStatus;
  lead: TaskLead;
  play: boolean;
  agent: TaskAgentRef | null;
  sessions: string[];
  serves: string[];
  workstream: string | null;
  /** You made or confirmed the links; only confirmed tasks count for attributed_agent_time. */
  confirmed: boolean;
  confirmed_at: string | null;
  urgency: { signal: string; ref: string | null } | null;
  /** Derived by Hester (v4 §4); null = unclassified. */
  quadrant: Quadrant | null;
  /** Minimum priority of the served goals (ordering inside a quadrant). */
  importance_rank: number | null;
  /** Your important/urgent overrides. */
  overrides: TaskOverrides | null;
  /** Set when derived urgency went from non-null to null. */
  urgency_cleared_at: string | null;
  /** files_count at the first turn_end / check-in report (scope/task-growth). */
  files_at_first_report: number | null;
  timebox_min: number | null;
  due: string | null;
  origin: TaskOrigin | null;
  /** The launch's git worktree, when it ran in one. Older daemons omit it. */
  worktree?: TaskWorktree | null;
  busy_ms: number;
  turns: number;
  files: string[];
  files_count: number;
  /** The agent's latest summary, verbatim (<= 2000). */
  summary: string | null;
  lee_status: LeeStatusBlock | null;
  last_checkin_at: string | null;
  commits: string[];
  outcome: string | null;
  accepted: boolean | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  version: number;
}

export type ClaudePermissionMode = 'acceptEdits' | 'plan' | 'manual' | 'auto' | 'dontAsk';

export interface LaunchRequest {
  workspace: string;
  title?: string;
  /**
   * Optional session name you typed: Claude gets `--name <name>`, Pi
   * `--name <name>`; stored on the task (name_source 'user') and used as the
   * tab label. Never derived from the prompt.
   */
  name?: string;
  /**
   * Context to attach (deterministic, offline): each file becomes an
   * `@relative/path` reference and each bundle an `@.hester/context/bundles/<id>.md`
   * reference appended to the initial prompt. Paths must be inside the workspace.
   */
  context?: { files?: string[]; bundles?: string[] };
  /** Initial prompt. Never written to the event log or lee.log. */
  prompt?: string;
  kind?: TaskKind;
  /** Default 'delegate'. 'human' creates a task and launches nothing. */
  lead?: TaskLead;
  play?: boolean;
  serves?: string[];
  /** Agent provider key; default cockpit.launch.provider ('claude'). */
  provider?: string;
  /** Default: cockpit.launch.worktree_for_delegate for lead 'delegate', else false. */
  worktree?: boolean;
  model?: string;
  /**
   * Default: plan lead -> plan (also over an explicit 'auto'); else
   * cockpit.launch.permission_default: 'auto', or 'default' -> acceptEdits.
   */
  permission_mode?: ClaudePermissionMode;
  /** Claude --tools (available built-in tools). */
  tools?: string[];
  /** Claude --allowedTools (no prompt for these). */
  allowed_tools?: string[];
  origin?: TaskOrigin;
  /**
   * The task's timebox in minutes (1-1440); default: Hester's (30 for a
   * delegate lead). Hand-offs pass spike 45, docs 30, research 20.
   */
  timebox_min?: number;
  /** Tab label; default: title. */
  label?: string;
  /** Open the agent's terminal right away (Manual). Default false: a tile. */
  go_into?: boolean;
  /** Attach the launch to an existing task instead of creating one. */
  task_id?: string;
}

export interface LaunchResult {
  success: boolean;
  error?: string;
  task_id?: string;
  pty_id?: number | null;
  tab_id?: number | null;
  session_id?: string | null;
  /** The task record reached Hester (false: spooled for retry). */
  relayed?: boolean;
}

/**
 * Resume a task's Claude session (`claude --resume <session_id>`) in a new
 * agent tab. Claude files sessions under the directory they ran in, so it
 * runs in the task's worktree when that still exists, else the workspace.
 */
export interface ResumeRequest {
  workspace: string;
  task_id: string;
  session_id: string;
  /** The task's worktree path, if it ran in one. */
  cwd?: string | null;
  label?: string | null;
}

export interface ResumeResult {
  success: boolean;
  error?: string;
  pty_id?: number | null;
  tab_id?: number | null;
  /** Where it runs. */
  cwd?: string;
  /** The worktree was gone: it runs in the workspace root instead. */
  fell_back?: boolean;
}

// ---------------------------------------------------------------------------
// Feed (entries produced in Lee main; attention items and Hester tasks are
// merged in by the renderer, not stored here)
// ---------------------------------------------------------------------------

export type FeedKind = 'approval' | 'blocker' | 'decision' | 'failure' | 'metric' | 'lint' | 'proposal' | 'event' | 'prepared';
export type FeedSeverity = 'ambient' | 'needs-you' | 'blocking';
export type FeedProducer = 'tabs' | 'checkin' | 'launch' | 'ops' | 'lint' | 'hester';
export type FeedEntryState = 'open' | 'done' | 'dismissed' | 'expired';

export interface FeedAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger' | 'plain';
  /** Exact text/command the action will type or run; the UI must show it before sending (C3). */
  confirm_text?: string | null;
  /** Optional single input the UI collects and passes as payload[param]. */
  input?: { kind: 'text' | 'select'; param: string; placeholder?: string; options?: string[] } | null;
}

export interface FeedRef {
  task_id?: string;
  pty_id?: number;
  op?: string;
  run_id?: string;
  diag_id?: string;
  proposal_id?: string;
  checkin_id?: string;
}

export interface FeedEntry {
  id: string;
  version: number;
  workspace: string | null;
  kind: FeedKind;
  severity: FeedSeverity;
  producer: FeedProducer;
  title: string;
  text: string | null;
  /** True when `text` is an agent's own words (label it as such). */
  text_is_agent: boolean;
  created_at: string;
  updated_at: string;
  state: FeedEntryState;
  /** Nudge-budget key of the item this is about, if any. */
  item_ref: string | null;
  ref: FeedRef;
  /** At most three shown inline; 'dismiss' is always available and not listed. */
  actions: FeedAction[];
  pinned: boolean;
  expires_at: string | null;
}

export interface FeedSnapshot {
  workspace: string | null;
  entries: FeedEntry[];
  generated_at: string;
}

export interface FeedActionResult {
  success: boolean;
  error?: string;
  entry?: FeedEntry;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Operations (package B)
// ---------------------------------------------------------------------------

export type OperationKind = 'oneshot' | 'long-running';

export interface OperationProduces {
  metric: string;
  /** JS regex source; the first capture group must parse as a number. */
  parse: string;
  unit?: string | null;
}

export interface OperationDef {
  name: string;
  kind: OperationKind;
  command: string;
  /** Relative to the workspace (or absolute). Default: workspace root. */
  cwd?: string | null;
  /** Placeholders used as {name} in command. */
  params?: string[];
  /** Outward-facing: always ask before running. */
  confirm?: boolean;
  produces?: OperationProduces[];
  /** Copilot mode (v5) may run it; recorded only in v2. */
  idle_ok?: boolean;
  /** Extra --allowedTools rules for this operation's agent. */
  allowed_tools?: string[];
  env?: Record<string, string>;
  ports?: number[];
  /** http://127.0.0.1 or http://localhost URL only (C1). */
  health?: string | null;
  notify_on_done?: boolean;
  /** Extra command-line globs that link a hand-typed command to this operation. */
  match?: string[];
  description?: string | null;
  timeout_min?: number | null;
}

export type OperationSource = 'config' | 'operations-file' | 'service';
export type OperationStatus = 'idle' | 'running' | 'passed' | 'failed' | 'stopped' | 'unknown' | 'unhealthy' | 'crashed';
export type RunBy = 'user' | 'hester' | 'device' | 'lee';

export interface OperationReading {
  metric: string;
  value: number;
  unit: string | null;
}

export interface OperationRun {
  run_id: string;
  op: string;
  workspace: string;
  pty_id: number | null;
  tab_id: number | null;
  by: RunBy;
  started_at: string;
  ended_at: string | null;
  status: 'running' | 'passed' | 'failed' | 'stopped' | 'unknown';
  exit_code: number | null;
  duration_ms: number | null;
  readings: OperationReading[];
  inputs_sig: string | null;
}

export interface OperationInfo {
  def: OperationDef;
  source: OperationSource;
  status: OperationStatus;
  last_run: OperationRun | null;
  running: OperationRun | null;
  linked_pty_id: number | null;
  service: { name: string; detect: string | null } | null;
}

export interface OperationSuggestion {
  def: OperationDef;
  /** e.g. "package.json", "electron/package.json", "Makefile", "pyproject.toml", "dirigible/firmware (idf.py)", "aeronaut/pubspec.yaml". */
  detected_from: string;
}

export interface OperationProposal {
  id: string;
  workspace: string;
  /** Defined operation name, or null for an ad-hoc command. */
  op: string | null;
  command: string;
  cwd: string | null;
  by: 'hester' | 'lint';
  reason: string | null;
  created_at: string;
  expires_at: string;
}

export interface OperationAgentConfig {
  model: string;
  plan_model: string;
  escalate_model: string;
}

export interface OperationsSnapshot {
  workspace: string;
  operations: OperationInfo[];
  suggestions: OperationSuggestion[];
  proposals: OperationProposal[];
  agent: OperationAgentConfig;
  generated_at: string;
}

export interface OpRunRequest {
  workspace: string;
  /** Defined operation. Exactly one of name / command. */
  name?: string;
  /** Ad-hoc command (local user only; others get a proposal). */
  command?: string;
  cwd?: string | null;
  params?: Record<string, string>;
  /** The caller showed the exact command and the user confirmed it. */
  confirmed?: boolean;
  /** Run in this tab (must be a shell at its prompt). */
  pty_id?: number;
}

export interface OpRunResult {
  success: boolean;
  error?: string;
  run?: OperationRun;
  proposal_id?: string;
  needs_confirm?: boolean;
  missing_params?: string[];
}

export interface OpAgentRequest {
  workspace: string;
  purpose: 'fix' | 'adhoc';
  /** For 'fix': the failed operation (and run). */
  op?: string;
  run_id?: string;
  /** For 'adhoc': what to do, as typed by the user. */
  request?: string;
  /** Use plan_model instead of model. */
  multi_step?: boolean;
}

// ---------------------------------------------------------------------------
// Lint (package D)
// ---------------------------------------------------------------------------

export type LintSeverity = 'off' | 'info' | 'warn' | 'needs-you';
export type LintOutcome = 'fixed' | 'dismissed' | 'ignored' | 'suppressed';
export type LintSuppressScope = 'item' | 'branch' | 'workspace';

export interface LintFix {
  id: string;
  label: string;
  /** Exact change the fix makes (a permission rule, a command); shown before applying. */
  confirm_text?: string | null;
}

export interface LintDiagnostic {
  id: string;
  rule: string;
  family: LintFamily;
  /** Effective severity after demotion. */
  severity: LintSeverity;
  base_severity: LintSeverity;
  workspace: string | null;
  /** Stable key of what it's about within the rule (a command sig, an op name, a tool signature). */
  subject: string;
  message: string;
  evidence: string[];
  fixes: LintFix[];
  item_ref: string | null;
  created_at: string;
  updated_at: string;
  shown: boolean;
  demoted: boolean;
}

export interface LintRuleStatus {
  rule: string;
  severity: LintSeverity;
  base_severity: LintSeverity;
  demoted: boolean;
  flagged_for_rework: boolean;
  outcomes_30d: Record<LintOutcome, number>;
}

export interface LintSnapshot {
  workspace: string | null;
  diagnostics: LintDiagnostic[];
  counts: { info: number; warn: number; needs_you: number };
  rules: LintRuleStatus[];
  generated_at: string;
}

export interface LintFixResult {
  success: boolean;
  error?: string;
  /** What the fix did, for a toast. */
  message?: string;
  /**
   * v4 §7.3: renderer-side fixes. When `renderer_action` is set, main did
   * nothing else and the renderer performs it ('link-goal' opens the task's
   * goal picker; 'what-next' switches to Copilot and runs What next?).
   */
  data?: LintFixData;
}

export type LintRendererAction = 'link-goal' | 'what-next';

export interface LintFixData {
  renderer_action?: LintRendererAction;
  task_id?: string | null;
  workspace?: string | null;
}

// ---------------------------------------------------------------------------
// Nudge budget (spec 3 rule 2; shared by lint, check-in proposals, ops, v4 steward)
// ---------------------------------------------------------------------------

export type NudgeSource = 'lint' | 'checkin' | 'ops' | 'steward';

export interface NudgeClaimRequest {
  /** e.g. "task:<ws>:<id>", "pty:<id>", "op:<ws>:<name>", "lint:<ws>:<rule>:<subject>". */
  item_ref: string;
  /** Changes whenever the item's state changes; one nudge per value. */
  state_key: string;
  source: NudgeSource;
  workspace?: string | null;
  /** Blocking items may nudge during focus. Nothing in v2 sets it. */
  blocking?: boolean;
}

export interface NudgeClaim {
  granted: boolean;
  /** 'deep': a Deep session is active; every claim is denied, blocking ones too (Deep D1 §2.3). */
  reason: 'same_state' | 'overridden' | 'rate' | 'focus' | 'deep' | null;
}

// ---------------------------------------------------------------------------
// Cockpit / Deep / Manual modes (renderer, package C)
// ---------------------------------------------------------------------------

export type LeeMode = 'cockpit' | 'deep' | 'manual';
export type ModeReason =
  | 'default' | 'manual' | 'focus_start' | 'focus_end' | 'handoff' | 'return' | 'go_into' | 'open_tab'
  | 'deep_start' | 'deep_end' | 'hop' | 'switcher';
export type GoIntoFrom = 'tile' | 'feed' | 'drawer' | 'hotkey' | 'tabs' | 'other-window';

export type CockpitRendererEvent =
  | { type: 'cockpit.mode'; data: { from: LeeMode; to: LeeMode; reason: ModeReason } }
  | { type: 'cockpit.go_into'; data: { pty_id: number; agent_state: AgentState | TabRunState; from: GoIntoFrom } }
  | DeepRendererEvent;

// ---------------------------------------------------------------------------
// Deep (D1). Source of truth: docs/plans/2026-09-26-deep-d1-contracts.md §12.
// ---------------------------------------------------------------------------

export type DeepView = 'page';                       // 'board' | 'browse' | 'workbench' in D2
export type DeepAction = 'capture' | 'keep' | 'ask' | 'explore' | 'insert' | 'follow_up' | 'dismiss';
export type AffordancePattern = 'question' | 'url' | 'later';
export type DeepRendererEvent =
  | { type: 'deep.input'; data: { exploration_id?: string; card_id?: string; card_kind?: DeskCardKind; view: DeepView; keys: number; clicks: number; wheels: number; span_ms: number } }
  | { type: 'deep.view'; data: { exploration_id?: string; card_id?: string; card_kind?: DeskCardKind; view: DeepView } }
  | { type: 'deep.action'; data: { action: DeepAction; exploration_id?: string; card_id?: string; card_kind?: DeskCardKind; chars?: number } }
  | { type: 'deep.affordance'; data: { pattern: AffordancePattern; outcome: 'accepted' | 'ignored' } }
  | { type: 'deep.switcher'; data: { from: LeeMode; to: LeeMode; via: 'tap' | 'overlay' | 'chip' } }
  | { type: 'desk.zoom'; data: { card_id: string | null; card_kind: DeskCardKind | null; via: 'land' | 'key' | 'click' | 'link' } };

export type Anchor =
  | { kind: 'page'; quote: string; offset: number; section: string | null }
  | BoardAnchor
  | { kind: 'none' };
export interface DeepReference {
  id: string; kind: 'quote' | 'link'; quote?: string; url?: string; title?: string; note?: string;
  section?: string | null; source?: { kind: 'page' | 'palette' | 'answer' | 'file'; ref?: string };
  at: string; opened_at?: string;
  /** Deep next R10: a quote or link from a workspace file ([[ ), with its line range. */
  file?: string; lines?: [number, number];
}
export type AnswerStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted';
/** Deep next R3: what a hand-off asks an agent to do. */
export type HandoffKind = 'spike' | 'docs' | 'research';
/** Where a hand-off's agent is (from its Cockpit task); 'done' when its result is in `answer`. */
export type HandoffState = 'launching' | 'running' | 'waiting' | 'review' | 'done' | 'error';
export interface DeepHandoff {
  kind: HandoffKind;
  provider: string;
  /** The brief exactly as sent (C3). */
  brief: string;
  task_id: string | null;
  state: HandoffState;
}
export interface DeepAnswer {
  id: string; anchor: Anchor; question: string; status: AnswerStatus; answer?: string; error?: string;
  surface: 'deep-ask' | 'deep-handoff' | 'deep-visualize'; model?: { location: 'local' | 'cloud'; name: string };
  /** Deep next R3/R5: 'handoff' records share the answers store and the margin; absent = 'ask'. Boards B6: 'visualize' (a Board's only). */
  kind?: 'ask' | 'handoff' | 'visualize';
  handoff?: DeepHandoff;
  /** A Visualize's result (Boards B6, shared/board.ts): null until it's done. */
  visual?: VisualResult | null;
  /** A Visualize's whole brief (`question` is its first line). */
  brief?: string;
  asked_at: string; answered_at?: string; read_at?: string; dismissed_at?: string;
  inserted_at?: string; kept_at?: string; follow_up_of?: string;
}
export interface DeepQuestion {
  id: string; text: string; source: 'page' | 'ask'; anchor?: Anchor;
  status: 'open' | 'closed'; at: string; closed_at?: string;
}
export type DepthRating = 'deep' | 'mixed' | 'shallow';
export interface DeepSessionRecord {
  id: string; focus_session_id: string; started_at: string; ended_at: string;
  reason: 'ritual' | 'esc' | 'away' | 'quit'; stopped_at: string | null;
  rating: DepthRating | null; questions_kept: string[];
}
export type OpenerSurface =
  | { kind: 'blank' }
  | { kind: 'open_questions'; count: number; items: Array<{ exploration_id: string; exploration_title: string; question_id: string; text: string; card_id?: string; card_title?: string }> }
  | { kind: 'captured_away'; count: number; items: Array<{ someday_id: string; text: string; surface: string; created_at: string }> }
  | { kind: 'reading_list'; count: number; items: Array<{ exploration_id: string; reference_id: string; title: string; url: string; card_id?: string }> }
  | { kind: 'q2'; items: unknown[] }
  | { kind: 'quiet'; items: Array<{ exploration_id: string; title: string; last_touched_at: string; card_id?: string }> };
export interface Opener {
  generated_at: string; workspace: string;
  pick_up: null | {
    exploration: { id: string; title: string; last_touched_at: string };
    card?: DeskCardBrief;
    stopped_at: string | null;
    stopped_line?: number | null;
    arrived: { answers: number; open_questions: number };
  };
  surfaces: OpenerSurface[];
}
export interface DeepAnswerEvent { workspace: string; exploration_id: string; answer_id: string; status: AnswerStatus; card_id?: string }

/** Main asks a window's renderer to create a tab and report its ids. */
export interface CreateTabRequest {
  request_id: string;
  type: 'terminal' | 'agent';
  label: string;
  /** For type 'terminal': the command (else the login shell). */
  command?: string;
  /**
   * For type 'terminal': the command's args. For type 'agent': extra argv
   * after the provider definition's own args (a launch's session id, name,
   * prompt); an agent spawned with args never adopts a prewarmed process.
   */
  args?: string[];
  /** For type 'agent': provider key. `label` is the tab's display label. */
  provider?: string;
  /** For type 'agent': the directory to run it in (a resumed session's); else the workspace. */
  cwd?: string;
  /** Make it the active tab (Manual) instead of leaving it as a tile. */
  activate: boolean;
}

export interface CreateTabResult {
  request_id: string;
  tab_id: number | null;
  pty_id: number | null;
  error?: string;
}

/** Main asks the window that shows pty_id to open it (and leave cockpit mode). */
export interface GoIntoRequest {
  pty_id: number;
  tab_id: number | null;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const COCKPIT_IPC = {
  // Package A (lee-tab)
  tabsList: 'cockpit:tabs:list',
  /** main to renderer: TabRuntimeInfo[] (debounced 500 ms). */
  tabsPush: 'cockpit:tabs',
  tabRead: 'cockpit:tabs:read',
  tabState: 'cockpit:tabs:state',
  tabSend: 'cockpit:tabs:send',
  tabFocus: 'cockpit:tabs:focus',
  tabRename: 'cockpit:tabs:rename',
  filesList: 'cockpit:files:list',
  checkin: 'cockpit:checkin',
  checkinCancel: 'cockpit:checkin:cancel',
  launch: 'cockpit:launch',
  /** invoke(ResumeRequest): ResumeResult. */
  resume: 'cockpit:resume',
  /** invoke(workspace): LaunchDefaults (the Launcher's initial toggles). */
  launchDefaults: 'cockpit:launch:defaults',
  feedGet: 'cockpit:feed:get',
  /** main to renderer: FeedSnapshot for all workspaces (renderer filters). */
  feedPush: 'cockpit:feed',
  feedAct: 'cockpit:feed:act',
  /** send, renderer to main: CockpitRendererEvent. */
  rendererEvent: 'cockpit:event',
  /** main to renderer: CreateTabRequest. */
  createTab: 'cockpit:create-tab',
  /** send, renderer to main: CreateTabResult. */
  createTabResult: 'cockpit:create-tab-result',
  /** main to renderer: GoIntoRequest. */
  goInto: 'cockpit:go-into',
  // Package B (lee-ops)
  opsList: 'cockpit:ops:list',
  /** main to renderer: OperationsSnapshot (one workspace per message). */
  opsPush: 'cockpit:ops',
  opsRun: 'cockpit:ops:run',
  opsStop: 'cockpit:ops:stop',
  opsConfirm: 'cockpit:ops:confirm',
  opsDismissSuggestion: 'cockpit:ops:dismiss-suggestion',
  opsSave: 'cockpit:ops:save',
  opsLinkTab: 'cockpit:ops:link-tab',
  opsAgent: 'cockpit:ops:agent',
  opsSerialPorts: 'cockpit:ops:serial-ports',
  // Package D (lee-lint)
  lintList: 'cockpit:lint:list',
  /** main to renderer: LintSnapshot (one workspace per message; null workspace = machine-wide). */
  lintPush: 'cockpit:lint',
  lintFix: 'cockpit:lint:fix',
  lintDismiss: 'cockpit:lint:dismiss',
  lintSuppress: 'cockpit:lint:suppress',
  lintShown: 'cockpit:lint:shown',
  /** send, renderer to main: { signature, tool, preview } seen on an approval item. Memory only. */
  lintLearnTool: 'cockpit:lint:learn-tool',
  /** invoke (item_ref, state_key): the local user overrides a nudge (a dismissed steward proposal). */
  nudgeOverride: 'cockpit:nudges:override',
} as const;

export type CockpitUnsubscribe = () => void;

/** window.lee.cockpit */
export interface LaunchDefaults {
  /** cockpit.launch.permission_default: 'auto' launches Claude with --permission-mode auto. */
  permission_default: 'auto' | 'default';
}

export interface CockpitAPI {
  // Package A (lee-tab)
  tabs: {
    list: (workspace?: string | null) => Promise<TabRuntimeInfo[]>;
    onChange: (cb: (tabs: TabRuntimeInfo[]) => void) => CockpitUnsubscribe;
    read: (ptyId: number, req: TabReadRequest) => Promise<TabReadResult>;
    state: (ptyId: number) => Promise<TabStateInfo>;
    send: (ptyId: number, req: TabSendRequest) => Promise<TabSendResult>;
    /** Focus the window showing ptyId and open that tab there. */
    focus: (ptyId: number) => Promise<{ success: boolean; error?: string }>;
    /** Set (or with null/'' clear) the agent's name as yours (name_source 'user'); relayed to its task. */
    rename: (ptyId: number, name: string | null) => Promise<{ success: boolean; error?: string }>;
  };
  /** Workspace files for the Launcher's context picker (relative paths, gitignored files excluded, capped). */
  files: (workspace: string) => Promise<{ files: string[]; truncated: boolean }>;
  /** Returns at once ({state: 'queued' | 'sent'}); the result arrives via the Feed and tabs.onChange. */
  checkin: (ptyId: number, opts?: { force?: boolean }) => Promise<CheckinResult>;
  /** Cancel the PTY's pending check-in (nothing is typed after this). */
  checkinCancel: (ptyId: number) => Promise<{ success: boolean; error?: string }>;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  /** Resume a task's Claude session in a new agent tab; optional so older hosts/mocks still type. */
  resume?: (req: ResumeRequest) => Promise<ResumeResult>;
  /** The workspace's launch defaults (cockpit.launch); optional so older hosts/mocks still type. */
  launchDefaults?: (workspace: string) => Promise<LaunchDefaults>;
  feed: {
    get: (workspace?: string | null) => Promise<FeedSnapshot>;
    onChange: (cb: (snapshot: FeedSnapshot) => void) => CockpitUnsubscribe;
    /** actionId 'dismiss' is always accepted. */
    act: (entryId: string, actionId: string, payload?: Record<string, string>) => Promise<FeedActionResult>;
  };
  logEvent: (event: CockpitRendererEvent) => void;
  onCreateTab: (cb: (req: CreateTabRequest) => void) => CockpitUnsubscribe;
  createTabResult: (res: CreateTabResult) => void;
  onGoInto: (cb: (req: GoIntoRequest) => void) => CockpitUnsubscribe;
  // Package B (lee-ops)
  ops: {
    list: (workspace: string) => Promise<OperationsSnapshot>;
    onChange: (cb: (snapshot: OperationsSnapshot) => void) => CockpitUnsubscribe;
    run: (req: OpRunRequest) => Promise<OpRunResult>;
    stop: (workspace: string, name: string) => Promise<{ success: boolean; error?: string }>;
    confirm: (workspace: string, names: string[]) => Promise<{ success: boolean; error?: string }>;
    dismissSuggestion: (workspace: string, name: string) => Promise<{ success: boolean }>;
    save: (workspace: string, def: OperationDef) => Promise<{ success: boolean; error?: string }>;
    linkTab: (ptyId: number, workspace: string, name: string | null) => Promise<{ success: boolean; error?: string }>;
    startAgent: (req: OpAgentRequest) => Promise<LaunchResult>;
    serialPorts: () => Promise<string[]>;
  };
  // Package D (lee-lint)
  lint: {
    list: (workspace?: string | null) => Promise<LintSnapshot>;
    onChange: (cb: (snapshot: LintSnapshot) => void) => CockpitUnsubscribe;
    fix: (diagId: string, fixId: string) => Promise<LintFixResult>;
    dismiss: (diagId: string) => Promise<{ success: boolean }>;
    suppress: (diagId: string, scope: LintSuppressScope) => Promise<{ success: boolean }>;
    /** The renderer displayed these diagnostics (outside focus). */
    shown: (diagIds: string[], surface: 'status' | 'feed') => void;
    learnTool: (info: { signature: string; tool: string; preview: string }) => void;
    /** Record a nudge override (the local user): that item stays quiet until its state changes. */
    overrideNudge: (itemRef: string, stateKey: string) => Promise<{ success: boolean }>;
  };
}

/**
 * The `X-Lee-Workspace` header value for a workspace path. Header values must
 * be ByteStrings, so '%' and everything outside printable ASCII is
 * percent-encoded (UTF-8); printable ASCII paths, spaces included, pass
 * unchanged. Mirrors hester/shared/workspace.py encode_workspace_header();
 * the daemon tries the decoded value first, then the raw one.
 */
export function encodeWorkspaceHeader(workspace: string): string {
  return workspace.replace(/%|[^\x20-\x7E]/gu, (ch) => {
    try {
      return encodeURIComponent(ch);
    } catch {
      return '%EF%BF%BD'; // lone surrogate: U+FFFD, as Python's quote would fail on it anyway
    }
  });
}

// ---------------------------------------------------------------------------
// Cockpit design (docs/plans/2026-09-27-cockpit-design-contracts.md §9)
// ---------------------------------------------------------------------------

/** The four Cockpit sections (Desk D2, docs/16-Desk.md §6). C switches to these; SectionId and LEGACY_SECTION stay until the merge step. */
export type CockpitSectionId = 'home' | 'work' | 'goals' | 'ops';
export const COCKPIT_SECTION: Record<string, CockpitSectionId> = {
  copilot: 'home', feed: 'work', tasks: 'work', explore: 'home', someday: 'home', files: 'home', tabs: 'home',
  library: 'home', history: 'home', home: 'home', work: 'work', goals: 'goals', ops: 'ops',
};

/** The six Cockpit sections (§2.2). Remembered ids from older builds map through LEGACY_SECTION. */
export type SectionId = 'home' | 'work' | 'goals' | 'library' | 'ops' | 'history';

/** Every section id Lee has used, old and new, to its section now (§2.2). */
export const LEGACY_SECTION: Record<string, SectionId> = {
  copilot: 'home', feed: 'work', tasks: 'work', explore: 'library', someday: 'library', files: 'library', tabs: 'home',
  home: 'home', work: 'work', goals: 'goals', library: 'library', ops: 'ops', history: 'history',
};

/**
 * The quick replies (§4.4): Work's list card shows the first three, the
 * detail view all four. Same list as aeronaut/lib/widgets/attention_tile.dart
 * quickReplyChips; change both together.
 */
export const QUICK_REPLIES = ['Yes, go ahead', 'Stop and wait for me', 'Explain first', 'Show me the diff'] as const;

/** One entry of an agent session's activity ring (§7.1), from agent.tool pre and post. */
export interface AgentActivity {
  at: string;
  tool: string;
  /** toolPreview, capped at 160 chars. */
  preview: string;
  files: string[];
  writes: boolean;
  failed?: true;
  phase: 'pre' | 'post';
}

/**
 * One finished turn of an agent session, for Work's "Updates" feed: when it
 * ended, the agent's last message (clipped to 600 chars) and its parsed
 * lee-status block. The queue keeps the last 10 per session, in memory only.
 */
export interface AgentUpdate {
  at: string;
  summary: string | null;
  lee_status: LeeStatusBlock | null;
}

/** What an agent is doing now (§7.1): the open tool, else the last entry within 60s. */
// ---------------------------------------------------------------------------
// Usage (docs/15-Usage.md). Contract for the usage and device builds.
// ---------------------------------------------------------------------------

/** §2: what a cost figure means. Subscription usage is shown as tokens only (§9). */
export type CostBasis = 'billed' | 'subscription' | 'estimate' | 'local';

/** §4.1 token counts. `thinking` is a subset of `output`. Unknown fields are omitted. */
export interface UsageTokens {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  thinking?: number;
}

/**
 * An agent session's running usage (§6.2), summed over its turns and its
 * subagents' transcripts, deduplicated by message id.
 * `shown_tokens` = input + output + cache_write (cache reads are excluded:
 * they dwarf everything else and cost little); the breakdown is in `tokens`.
 * `cost_usd` is present only for 'billed' and 'estimate' (never displayed for
 * 'subscription').
 */
export interface AgentUsage {
  tokens: UsageTokens;
  shown_tokens: number;
  cost_basis: CostBasis;
  cost_usd?: number;
  /** Per model, when the session used more than one. */
  by_model?: Array<{ model: string; tokens: UsageTokens; cost_usd?: number }>;
}

/** §6.1: the latest Claude subscription windows seen from any Lee-launched session. */
export interface UsageLimits {
  five_hour?: { used_pct: number; resets_at: string | null };
  seven_day?: { used_pct: number; resets_at: string | null };
  /** When this snapshot was taken (the status line render). */
  as_of: string;
}

/** "412k tok" / "1.2M tok": the compact token label used in Work and on devices. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} tok`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tok`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M tok`;
}

export interface AgentNow {
  tool: string;
  preview: string;
  files: string[];
  since: string;
}

type ActivityVerb = { now: string; past: string };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const SEARCH_PATTERN_MAX = 30;

const EDITING: ActivityVerb = { now: 'Editing', past: 'Edited' };
const READING: ActivityVerb = { now: 'Reading', past: 'Read' };

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** "Editing main.ts", "Editing 3 files", or the bare verb when nothing names a file. */
function onFiles(verb: string, files: readonly string[], preview: string): string {
  if (files.length > 1) return `${verb} ${files.length} files`;
  const one = files[0] ?? preview.trim();
  return one ? `${verb} ${baseName(one)}` : verb;
}

/** Leading `cd <dir> &&` / `cd <dir>;` segments: they say where, not what. */
const LEADING_CD = /^\s*cd(?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?\s*(?:&&|;)\s*/;

/** The command after any leading `cd <dir> &&` / `cd <dir>;` segments (the whole command when nothing follows). */
export function stripLeadingCd(command: string): string {
  let rest = command;
  for (let m = LEADING_CD.exec(rest); m && rest.slice(m[0].length).trim(); m = LEADING_CD.exec(rest)) rest = rest.slice(m[0].length);
  return rest;
}

/** A Bash command in words: tests, builds and git by name, else its first word. */
function describeCommand(full: string, past: boolean): string {
  const command = stripLeadingCd(full);
  const words = command.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const first = words[0] ? baseName(words[0]) : '';
  if (first === 'git') return past ? 'Used git' : 'Using git';
  const lower = command.toLowerCase();
  if (/\b(test|tests|pytest|jest|vitest|smoke)\b/.test(lower)) return past ? 'Ran tests' : 'Running tests';
  if (/\b(build|dist|tsc)\b|\bidf\.py\b/.test(lower)) return past ? 'Built' : 'Building';
  if (!first) return past ? 'Ran a command' : 'Running a command';
  return `${past ? 'Ran' : 'Running'} ${first}`;
}

/**
 * A tool call as a short phrase (§7.1): present tense for "what it's doing
 * now", past tense for the "Along the way" timeline. A failed entry gets
 * " (failed)". Pure, so the renderer and the smokes share it; the Dart and
 * C++ ports copy this table (13 v6).
 */
export function describeActivity(
  a: { tool: string; preview: string; files: string[]; failed?: boolean },
  tense: 'now' | 'past' = 'now',
): string {
  const past = tense === 'past';
  const preview = a.preview ?? '';
  const files = a.files ?? [];
  let phrase: string;
  if (EDIT_TOOLS.has(a.tool)) {
    phrase = onFiles(EDITING[tense], files, preview);
  } else if (a.tool === 'Read') {
    phrase = onFiles(READING[tense], files, preview);
  } else if (SEARCH_TOOLS.has(a.tool)) {
    const p = preview.trim();
    // toolPreview prefers a path over the pattern; a path or JSON is not a pattern.
    const pattern = p && p !== a.tool && p.length <= SEARCH_PATTERN_MAX && !/^[/~{[]/.test(p) ? p : '';
    phrase = `${past ? 'Searched' : 'Searching'}${pattern ? ` for ${pattern}` : ''}`;
  } else if (a.tool === 'Bash') {
    phrase = describeCommand(preview, past);
  } else if (WEB_TOOLS.has(a.tool)) {
    phrase = past ? 'Read the web' : 'Reading the web';
  } else if (SUBAGENT_TOOLS.has(a.tool)) {
    phrase = past ? 'Worked with a subagent' : 'Working with a subagent';
  } else if (a.tool === 'AskUserQuestion') {
    phrase = past ? 'Asked you a question' : 'Asking you a question';
  } else {
    phrase = a.tool;
  }
  return a.failed ? `${phrase} (failed)` : phrase;
}
