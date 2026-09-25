/**
 * Copilot v0/v1 shared contract.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix A).
 * This file is copied VERBATIM from that document by every work package that
 * needs it. Do not edit it inside a work package; change the contract instead.
 */

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
  | 'retro.answered';

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
  | 'waiting' // agent is idle at its prompt waiting on you
  | 'blocker' // agent reported lee-status: blocked
  | 'decision' // agent reported lee-status: waiting (a question for you)
  | 'failure' // agent process exited non-zero
  | 'review' // agent finished a turn (ambient)
  | 'summary'; // away-policy summary (v1)

export type AttentionSeverity = 'ambient' | 'needs-you' | 'blocking';

export type AttentionState = 'open' | 'snoozed' | 'resolved' | 'dismissed';

export type AttentionActionName = 'approve' | 'deny' | 'reply' | 'open' | 'snooze' | 'dismiss' | 'wake';

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
  lee_status?: LeeStatusBlock | null;
  actions: AttentionActionName[];
  snoozed_until?: string | null;
}

export type FocusItem =
  | { kind: 'agent'; pty_id: number; window_id: number | null; label: string }
  | { kind: 'files'; workspace: string | null; paths: string[] }
  | { kind: 'workspace'; workspace: string };

export interface FocusState {
  active: boolean;
  session_id: string | null;
  source: 'manual' | 'inferred' | null;
  started_at: string | null;
  item: FocusItem | null;
  /** Non-blocking items held during this session. */
  quiet_count: number;
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
 * view. Never carries prompt text or tool inputs; last_summary is the
 * agent's own words.
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
}

export interface AttentionSnapshot {
  items: AttentionItem[];
  counts: { blocking: number; needs_you: number; ambient: number; parked: number };
  focus: FocusState;
  away: AwayState;
  /** Running agents. Optional: older Lee builds omit it; older clients ignore it. */
  agents?: AgentSummary[];
  generated_at: string;
}

export interface ReplyRequest {
  action: 'approve' | 'deny' | 'text';
  /** Required when action is 'text'. */
  text?: string;
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
}
