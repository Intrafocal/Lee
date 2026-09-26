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

import type { AgentState, LeeStatusBlock } from './copilot';

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
  | 'nudge.claim';

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
  /** Local user only: send even though the state is 'unknown'. Never overrides 'busy' or 'awaiting-input'. */
  force?: boolean;
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

export type TaskOriginKind = 'launcher' | 'agent' | 'checkin' | 'someday' | 'operation' | 'lint' | 'hester';

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

export interface CockpitTask {
  id: string;
  workspace: string;
  title: string;
  title_source: 'user' | 'agent' | 'auto';
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
  /** Always null in v2 (quadrants are v4). */
  quadrant: null;
  timebox_min: number | null;
  due: string | null;
  origin: TaskOrigin | null;
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
  /** Default from lead: delegate -> acceptEdits, plan -> plan. */
  permission_mode?: ClaudePermissionMode;
  /** Claude --tools (available built-in tools). */
  tools?: string[];
  /** Claude --allowedTools (no prompt for these). */
  allowed_tools?: string[];
  origin?: TaskOrigin;
  /** Tab label; default: title. */
  label?: string;
  /** Open the agent's terminal right away (workbench). Default false: a tile. */
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
  family: 'toil';
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
  reason: 'same_state' | 'overridden' | 'rate' | 'focus' | null;
}

// ---------------------------------------------------------------------------
// Cockpit / Workbench modes (renderer, package C)
// ---------------------------------------------------------------------------

export type LeeMode = 'cockpit' | 'workbench';
export type ModeReason = 'default' | 'manual' | 'focus_start' | 'focus_end' | 'handoff' | 'return' | 'go_into' | 'open_tab';
export type GoIntoFrom = 'tile' | 'feed' | 'drawer' | 'hotkey' | 'tabs' | 'other-window';

export type CockpitRendererEvent =
  | { type: 'cockpit.mode'; data: { from: LeeMode; to: LeeMode; reason: ModeReason } }
  | { type: 'cockpit.go_into'; data: { pty_id: number; agent_state: AgentState | TabRunState; from: GoIntoFrom } };

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
  /** Make it the active tab (workbench) instead of leaving it as a tile. */
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
  checkin: 'cockpit:checkin',
  checkinCancel: 'cockpit:checkin:cancel',
  launch: 'cockpit:launch',
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
} as const;

export type CockpitUnsubscribe = () => void;

/** window.lee.cockpit */
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
  };
  /** Returns at once ({state: 'queued' | 'sent'}); the result arrives via the Feed and tabs.onChange. */
  checkin: (ptyId: number, opts?: { force?: boolean }) => Promise<CheckinResult>;
  /** Cancel the PTY's pending check-in (nothing is typed after this). */
  checkinCancel: (ptyId: number) => Promise<{ success: boolean; error?: string }>;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
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
