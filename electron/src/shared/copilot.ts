/**
 * Copilot v0/v1 shared contract.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix A).
 * This file is copied VERBATIM from that document by every work package that
 * needs it. Do not edit it inside a work package; change the contract instead.
 */

import type { AgentActivity, AgentNow, AgentUpdate, AgentUsage, DeepAnswerEvent, DepthRating, LeeMode, Quadrant, UsageLimits } from './cockpit';

// ---------------------------------------------------------------------------
// Actors and principals
// ---------------------------------------------------------------------------

/** Who caused an event. Written into every event-log line. */
export type Actor =
  | { kind: 'user'; surface: 'lee' }
  | { kind: 'user'; surface: 'device'; device_id: string; device_kind: string }
  | { kind: 'agent'; provider: string; session_id: string | null; pty_id: number | null }
  | { kind: 'hester' }
  | { kind: 'system' };

/** Who is calling Lee main. HTTP principals are set by the auth middleware on res.locals.principal. */
export type Principal =
  /** The renderer, over IPC. Never produced by HTTP. */
  | { kind: 'local-user' }
  /** The shared ~/.lee/api-token: Hester, hook script, CLI scripts, Spyglass, legacy devices. */
  | { kind: 'shared'; loopback: boolean; ip: string }
  /** A paired device with its own token (~/.lee/devices/). */
  | { kind: 'device'; device_id: string; name: string; device_kind: string; ip: string };

// ---------------------------------------------------------------------------
// Event log (~/.lee/events/YYYY-MM-DD.jsonl)
// ---------------------------------------------------------------------------

export type LeeEventType =
  | 'app.start'
  | 'app.quit'
  | 'window.focus'
  | 'tab.focus'
  | 'input.counts'
  | 'presence.change'
  | 'device.paired'
  | 'device.revoked'
  | 'device.request'
  | 'device.views'
  | 'capture'
  | 'ui.ceremony'
  | 'agent.session_start'
  | 'agent.prompt'
  | 'agent.tool'
  | 'agent.waiting'
  | 'agent.turn_end'
  | 'agent.session_end'
  | 'agent.exit'
  | 'attention.open'
  | 'attention.update'
  | 'attention.escalate'
  | 'attention.reply'
  | 'attention.resolve'
  | 'attention.snooze'
  | 'attention.dismiss'
  | 'attention.wake'
  | 'focus.start'
  | 'focus.item'
  | 'focus.end'
  | 'handoff.start'
  | 'handoff.launch'
  | 'away.summary'
  | 'handoff.end'
  | 'model.call'
  | 'someday.triage'
  | 'digest.shown'
  | 'retro.shown'
  | 'retro.answered'
  // v4 (Hester -> Lee via POST /events): task.override {task_id, important, urgent}; steward.request {surface, about_kind?, goal_id?};
  // steward.quiet {not_today, until}; proposal.outcome {proposal_id, outcome, action, surface, request_id}
  | 'task.override'
  | 'steward.request'
  | 'steward.quiet'
  | 'proposal.outcome'
  // Deep D1 §10.1 (Hester -> Lee via POST /events/ingest): deep.answer {workspace, exploration_id, answer_id, status};
  // opener.shown {workspace, pick_up, surfaces}
  | 'deep.answer'
  | 'opener.shown'
  // docs/15-Usage.md §4.2 (Lee main): agent.usage {session_id, pty_id?, provider, by_model};
  // limits.snapshot {source, five_hour?, seven_day?, session_id} on change
  | 'agent.usage'
  | 'limits.snapshot';

export type EventSource = 'lee-main' | 'renderer' | 'hook' | 'hester' | 'device';

/** Presence/focus snapshot stamped onto every event at write time. */
export interface EventContext {
  at_machine: boolean;
  engaged: boolean;
  focus_session_id: string | null;
  away: boolean;
}

export interface LeeEvent<T = Record<string, unknown>> {
  v: 1;
  id: string;
  /** ISO 8601 UTC with milliseconds, stamped by Lee main when the line is written. */
  ts: string;
  type: LeeEventType;
  source: EventSource;
  workspace: string | null;
  window_id: number | null;
  actor: Actor;
  ctx: EventContext;
  data: T;
}

export interface LeeEventInput<T = Record<string, unknown>> {
  type: LeeEventType;
  source?: EventSource;
  workspace?: string | null;
  window_id?: number | null;
  actor?: Actor;
  data: T;
}

// ---------------------------------------------------------------------------
// Presence and engagement
// ---------------------------------------------------------------------------

export interface PresenceState {
  /** OS-level keyboard/mouse input within presence.at_machine_idle_seconds and screen not locked. Gates local compute (C2). */
  at_machine: boolean;
  /** Keyboard/mouse input in a Lee window within presence.lee_active_seconds. */
  lee_active: boolean;
  /** Any human action from any surface (Lee input or device request) within presence.engaged_seconds. */
  engaged: boolean;
  engaged_via: 'lee' | 'device' | null;
  engaged_device_id: string | null;
  locked: boolean;
  last_lee_input_at: string | null;
  last_engaged_at: string | null;
  /** When at_machine last became false; null while at the machine. */
  away_since: string | null;
  /** When the current at_machine value began. */
  since: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  device_id: string;
  name: string;
  kind: string;
  created_at: string;
  last_seen_at: string | null;
  last_ip: string | null;
  paired_via: 'code' | 'qr' | 'manual';
  revoked_at: string | null;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureRequest {
  text: string;
  /** Absolute workspace path; must be an open window's workspace. Default: focused window's workspace. */
  workspace?: string | null;
  /** 'explore' marks it as the seed of an exploration (tag only in v0). */
  as?: 'someday' | 'explore';
}

export interface CaptureResult {
  success: boolean;
  someday_id?: string | null;
  /** True when Hester was unreachable and the capture was spooled for later delivery. */
  spooled?: boolean;
  error?: string;
}

export type CeremonyAction =
  | 'confirm'
  | 'dismiss'
  | 'snooze'
  | 'assign'
  | 'required_field'
  | 'status_dismiss'
  | 'dialog';

// ---------------------------------------------------------------------------
// Attention queue
// ---------------------------------------------------------------------------

export type AttentionKind =
  | 'approval' // agent is showing a permission prompt
  | 'question' // agent is showing a multiple-choice question (Claude Code's AskUserQuestion)
  | 'waiting' // agent is idle at its prompt waiting on you
  | 'blocker' // agent reported lee-status: blocked
  | 'decision' // agent reported lee-status: waiting (a question for you)
  | 'failure' // agent process exited non-zero
  | 'review' // agent finished a turn (ambient)
  | 'summary'; // away-policy summary (v1)

export type AttentionSeverity = 'ambient' | 'needs-you' | 'blocking';

export type AttentionState = 'open' | 'snoozed' | 'resolved' | 'dismissed';

export type AttentionActionName = 'approve' | 'deny' | 'choose' | 'reply' | 'open' | 'snooze' | 'dismiss' | 'wake';

export interface LeeStatusBlock {
  status: 'done' | 'in-progress' | 'blocked' | 'waiting' | null;
  summary: string | null;
  blockers: string | null;
  files: string[];
  next: string | null;
}

export interface AttentionSource {
  kind: 'agent' | 'lee';
  provider: string | null;
  session_id: string | null;
  pty_id: number | null;
  window_id: number | null;
  tab_id: number | null;
  tab_label: string | null;
  workspace: string | null;
  cwd: string | null;
}

/**
 * The question(s) an agent is showing, from AskUserQuestion's tool_input.
 * The agent's own words: shown in the queue, never written to the event log.
 * Caps: 4 questions, 8 options each, strings 300 chars (120 in compact form).
 */
export interface AttentionQuestion {
  questions: Array<{
    question: string;
    /** Short chip label ("Auth method"); null when the agent gave none. */
    header: string | null;
    multi_select: boolean;
    /** Empty for free-text / number questions. The picker also offers "Other" (free text), which is not listed. */
    options: Array<{ label: string; description: string | null }>;
  }>;
}

export interface AttentionItem {
  id: string;
  /** Bumped on every change; replies must echo it (stale replies get 409). */
  version: number;
  kind: AttentionKind;
  severity: AttentionSeverity;
  state: AttentionState;
  /** Held by the away policy (v1). */
  parked: boolean;
  /** "Wake me for this" (v1). */
  wake: boolean;
  /** True when this item may alert a device right now (see section 5.4). */
  notify: boolean;
  related_to_focus: boolean;
  created_at: string;
  updated_at: string;
  /** Time spent waiting, excluding time while the away policy was active. */
  active_wait_ms: number;
  /** Short line, e.g. "Claude wants to run Bash". */
  title: string;
  /** The agent's own words (verbatim, max 2000 chars; max 280 in compact form). */
  text: string;
  source: AttentionSource;
  /** Files the agent session wrote (max 50). Omitted in compact form. */
  files?: string[];
  /** Pending tool for approvals: name and a short preview (max 200 chars). Never written to the event log. */
  tool?: { name: string; preview: string; signature: string } | null;
  /** Question items only. Kept (clipped) in compact form. */
  question?: AttentionQuestion | null;
  lee_status?: LeeStatusBlock | null;
  /**
   * Includes 'choose' only when the item is a question a device can answer
   * with one option pick: exactly one question, single-select, with options.
   */
  actions: AttentionActionName[];
  snoozed_until?: string | null;
  /** The source task's quadrant (v4 §7.2), for display; absent when unknown. */
  quadrant?: Quadrant | null;
}

export type FocusItem =
  | { kind: 'agent'; pty_id: number; window_id: number | null; label: string }
  | { kind: 'files'; workspace: string | null; paths: string[] }
  | { kind: 'workspace'; workspace: string }
  /** v4 §7.4: focus on a Cockpit task; related to attention items from its agent pty. */
  | { kind: 'task'; workspace: string; task_id: string; label: string }
  /** Deep D1 §2.1: a Deep session; exploration_id null = Deep with nothing open yet. */
  | { kind: 'exploration'; workspace: string; exploration_id: string | null; title: string };

export type FocusSource = 'manual' | 'inferred' | 'deep';

export interface FocusState {
  active: boolean;
  session_id: string | null;
  source: FocusSource | null;
  started_at: string | null;
  item: FocusItem | null;
  /** Non-blocking items held during this session. */
  quiet_count: number;
  /** 'none' iff source === 'deep' (Deep D1 §2.3). */
  policy: 'normal' | 'none';
  deep: { exploration_id: string | null; title: string; workspace: string } | null;
}

export type FocusEndReason = 'manual' | 'away' | 'switch' | 'handoff' | 'quit' | 'deep_end';
export interface DeepStartRequest { workspace: string; exploration_id: string | null; title?: string; surface?: string }
export interface DeepEndRequest { reason: 'ritual' | 'esc'; rating?: DepthRating | null; stopped_at_chars?: number }

/** window.lee.deep (Deep D1 §6): main forwards Hester's ingested deep.answer events. */
export interface DeepAPI {
  onAnswer: (cb: (e: DeepAnswerEvent) => void) => CopilotUnsubscribe;
}

export type SummaryPolicy = { mode: 'none' } | { mode: 'on_return' } | { mode: 'at'; at: string };

export interface AwayState {
  active: boolean;
  handoff_id: string | null;
  started_at: string | null;
  summary: SummaryPolicy;
  summary_delivered: boolean;
  wake_item_ids: string[];
  wake_pty_ids: number[];
  parked_count: number;
}

export type AgentState = 'busy' | 'idle' | 'waiting' | 'unknown';

/**
 * One running agent (a Claude tab Lee launched), for the device "In flight"
 * view. Never carries prompt text or raw tool inputs; last_summary is the
 * agent's own words, and now/recent carry only short tool previews.
 */
export interface AgentSummary {
  pty_id: number;
  window_id: number | null;
  tab_id: number | null;
  label: string;
  provider: string;
  workspace: string | null;
  state: AgentState;
  /** ISO start of the current turn while busy or waiting in a turn; else null. */
  busy_since: string | null;
  /** ISO end of the last turn while idle; else null. */
  idle_since: string | null;
  /** Short name of the most recent tool call (may lag until the next push). */
  last_tool: string | null;
  /** The agent's last message; clipped to ~280 chars in compact snapshots. */
  last_summary: string | null;
  files_touched_count: number;
  /** Cockpit design §7.1: what it's doing now (the open tool, else the last entry within 60s). */
  now?: AgentNow | null;
  /** Cockpit design §7.1: the last 8 activity entries, newest last. */
  recent?: AgentActivity[];
  /** Work's Updates feed: the last 10 finished turns (summary, lee-status), newest last. */
  updates?: AgentUpdate[];
  /** The agent's session id (from its hooks), so a restored tab can resume it. Omitted in compact snapshots. */
  session_id?: string | null;
  /** The directory the session runs in (its worktree for a Cockpit task). Omitted in compact snapshots. */
  cwd?: string | null;
  /** docs/15-Usage.md §6.2: this agent session's usage so far (subagents included). Absent until its first turn ends. Kept in compact snapshots (devices show it). */
  usage?: AgentUsage | null;
}

export interface AttentionSnapshot {
  items: AttentionItem[];
  counts: { blocking: number; needs_you: number; ambient: number; parked: number };
  focus: FocusState;
  away: AwayState;
  /** Running agents. Optional: older Lee builds omit it; older clients ignore it. */
  agents?: AgentSummary[];
  /** Deep D1 §2.5: the focused window's mode. Lee main always sets it; optional for older builds. */
  mode?: LeeMode;
  /** Deep D1 §2.5: the Deep session, if one is active (focus.active stays true during it). */
  deep?: { exploration_id: string | null; title: string } | null;
  /** docs/15-Usage.md §6.1: the latest Claude subscription limits seen by any Lee-launched session; null when none. */
  limits?: UsageLimits | null;
  generated_at: string;
}

export interface ReplyRequest {
  /** 'choose' answers a question item whose actions include 'choose'. */
  action: 'approve' | 'deny' | 'choose' | 'text';
  /** Required when action is 'text'. */
  text?: string;
  /** Required when action is 'choose': 0-based index into question.questions[0].options. */
  choice?: number;
  /** Must equal the item's current version. */
  version: number;
}

export interface SnoozeRequest {
  /** ISO time, or 'change' (until the item changes). Exactly one of until/minutes. */
  until?: string;
  minutes?: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  item?: AttentionItem;
}

export interface HandoffAgent {
  pty_id: number;
  window_id: number | null;
  tab_id: number | null;
  label: string;
  provider: string;
  workspace: string | null;
  state: AgentState;
  last_summary: string | null;
}

export interface HandoffProposals {
  agents: HandoffAgent[];
  waiting: AttentionItem[];
  workspaces: string[];
  default_summary: SummaryPolicy;
}

export interface HandoffLaunch {
  workspace: string;
  prompt: string;
  title?: string;
  worktree: boolean;
  permission_mode: 'acceptEdits' | 'default' | 'plan';
}

export interface HandoffRequest {
  followups: Array<{ pty_id: number; text: string }>;
  launch: HandoffLaunch[];
  summary: SummaryPolicy;
  wake: { item_ids: string[]; pty_ids: number[] };
  note?: string;
}

export interface HandoffResult {
  success: boolean;
  away?: AwayState;
  launched?: number;
  error?: string;
}

export interface ReturnInfo {
  reason: 'handoff_end' | 'presence';
  away_since: string;
  returned_at: string;
  away_ms: number;
  handoff_id: string | null;
}

/** Messages multiplexed onto the existing ws://:9001/context/stream socket. */
export type CopilotStreamMessage =
  | { type: 'attention_snapshot'; data: AttentionSnapshot }
  | { type: 'presence'; data: PresenceState }
  | { type: 'copilot_return'; data: ReturnInfo };

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const COPILOT_IPC = {
  /** send, renderer to main: InputBatch (mouse clicks and wheel events, counts only). */
  input: 'copilot:input',
  /** send, renderer to main: { action: CeremonyAction; target?: string }. */
  ceremony: 'copilot:ceremony',
  presenceGet: 'copilot:presence:get',
  /** main to renderer: PresenceState. */
  presencePush: 'copilot:presence',
  capture: 'copilot:capture',
  devicesList: 'copilot:devices:list',
  devicesRevoke: 'copilot:devices:revoke',
  devicesCreate: 'copilot:devices:create',
  snapshotGet: 'copilot:attention:get',
  /** main to renderer: AttentionSnapshot. */
  snapshotPush: 'copilot:attention',
  reply: 'copilot:attention:reply',
  snooze: 'copilot:attention:snooze',
  dismiss: 'copilot:attention:dismiss',
  wake: 'copilot:attention:wake',
  open: 'copilot:attention:open',
  focusStart: 'copilot:focus:start',
  focusStop: 'copilot:focus:stop',
  handoffProposals: 'copilot:handoff:proposals',
  handoffStart: 'copilot:handoff:start',
  handoffEnd: 'copilot:handoff:end',
  /** main to renderer: ReturnInfo. */
  returnPush: 'copilot:return',
  /** Deep D1 §2.1: invoke(DeepStartRequest) / invoke(DeepEndRequest), both resolve to FocusState. */
  deepStart: 'copilot:deep:start',
  deepEnd: 'copilot:deep:end',
  /** main to renderer: DeepAnswerEvent (Deep D1 §6). */
  deepAnswer: 'deep:answer',
  /** send, renderer to main: { reason?: FocusEndReason } (Deep D1 §2.4). */
  appQuit: 'app:quit',
} as const;

export interface InputBatch {
  clicks: number;
  wheels: number;
  span_ms: number;
}

export type CopilotUnsubscribe = () => void;

/** window.lee.copilot */
export interface CopilotAPI {
  // Package A (lee-core)
  getPresence: () => Promise<PresenceState>;
  onPresence: (cb: (presence: PresenceState) => void) => CopilotUnsubscribe;
  logCeremony: (action: CeremonyAction, target?: string) => void;
  capture: (req: CaptureRequest) => Promise<CaptureResult>;
  devices: {
    list: () => Promise<DeviceInfo[]>;
    revoke: (deviceId: string) => Promise<{ success: boolean; error?: string }>;
    create: (name: string, kind: string) => Promise<{ success: boolean; device?: DeviceInfo; token?: string; error?: string }>;
  };
  // Package B (lee-queue-hooks)
  getSnapshot: () => Promise<AttentionSnapshot>;
  onSnapshot: (cb: (snapshot: AttentionSnapshot) => void) => CopilotUnsubscribe;
  reply: (itemId: string, req: ReplyRequest) => Promise<ActionResult>;
  snooze: (itemId: string, req: SnoozeRequest) => Promise<ActionResult>;
  dismiss: (itemId: string) => Promise<ActionResult>;
  setWake: (itemId: string, wake: boolean) => Promise<ActionResult>;
  openItem: (itemId: string) => Promise<ActionResult>;
  focusStart: (item?: FocusItem | null) => Promise<FocusState>;
  focusStop: () => Promise<FocusState>;
  handoffProposals: () => Promise<HandoffProposals>;
  handoffStart: (req: HandoffRequest) => Promise<HandoffResult>;
  handoffEnd: () => Promise<AwayState>;
  onReturn: (cb: (info: ReturnInfo) => void) => CopilotUnsubscribe;
  // Deep D1 §2.1
  deepStart: (req: DeepStartRequest) => Promise<FocusState>;
  deepEnd: (req: DeepEndRequest) => Promise<FocusState>;
}
