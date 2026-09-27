/**
 * Pure Cockpit model (contracts §3, §4; Deep D1 §1): mode transitions, the
 * ⌘0 switcher, agent tiles, the merged Feed and the Cockpit keyboard map. No
 * React, no DOM, type-only imports (plus pure values from shared/cockpit), so
 * scripts/cockpit-renderer-smoke.mjs can bundle it with esbuild and run it
 * under plain node.
 */

import type { AgentState, AgentSummary, AttentionItem, AttentionSnapshot } from '../../shared/copilot';
import type {
  AgentNameSource,
  CockpitTask,
  FeedEntry,
  FeedKind,
  FeedSeverity,
  LaunchRequest,
  LeeMode,
  ModeReason,
  Proposal,
  Quadrant,
  TaskKind,
  TaskLead,
  TaskOrigin,
  TaskOverrides,
  TabFidelity,
  TabRunState,
  TabRuntimeInfo,
  SectionId,
} from '../../shared/cockpit';
// The one value import: pure data from shared (the smoke bundles it in).
import { LEGACY_SECTION } from '../../shared/cockpit';

export type { SectionId };

/** Nav order (sections have no keys: click only). Home first (cockpit-design §2.2). */
export const SECTIONS: readonly SectionId[] = ['home', 'work', 'goals', 'library', 'ops', 'history'];

/** Where the Cockpit lands on app start and on return (Deep D1 §8.3; cockpit-design §2.2). */
export const DEFAULT_SECTION: SectionId = 'home';

export const SECTION_LABELS: Record<SectionId, string> = {
  home: 'Home',
  work: 'Work',
  goals: 'Goals',
  library: 'Library',
  ops: 'Ops',
  history: 'History',
};

/**
 * A remembered or requested section id, old or new, as a section now
 * (cockpit-design §2.2): copilot and tabs → home, feed and tasks → work,
 * explore, someday and files → library. Unknown ids land on the default.
 */
export function readSection(id: string | null | undefined): SectionId {
  return (id && Object.prototype.hasOwnProperty.call(LEGACY_SECTION, id) ? LEGACY_SECTION[id] : null) ?? DEFAULT_SECTION;
}

/** The renderer tab fields the Cockpit needs (a structural subset of App's TabData). */
export interface ModelTab {
  id: number;
  type: string;
  label: string;
  ptyId: number | null;
  dockPosition?: string;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Agent tabs (§3.1)
// ---------------------------------------------------------------------------

export interface AgentSets {
  /** pty ids from snapshot.agents. */
  snapshotAgents: ReadonlySet<number>;
  /** pty ids A reports with kind 'agent'. */
  runtimeAgents: ReadonlySet<number>;
}

export function agentPtysFromSnapshot(snapshot: AttentionSnapshot | null | undefined): Set<number> {
  return new Set((snapshot?.agents ?? []).map((a) => a.pty_id));
}

/** Providers that are the user's own tools, not agents: Hester chat is never a tile (user decision 2026-09-25). */
const OWN_PROVIDERS = new Set(['hester']);
/** Tab types that are never agents, whatever A or the snapshot report: Hester chat, Hester QA, DevOps. */
const OWN_TAB_TYPES = new Set(['hester', 'hester-qa', 'devops']);

/** Hester chat and DevOps tabs are the user's own tabs (the drawer lists them), even when typed 'agent'. */
export function isOwnTab(tab: Pick<ModelTab, 'type' | 'provider'>): boolean {
  return OWN_TAB_TYPES.has(tab.type) || (!!tab.provider && OWN_PROVIDERS.has(tab.provider));
}

export function isOwnProvider(provider: string | null | undefined): boolean {
  return !!provider && OWN_PROVIDERS.has(provider);
}

export function runtimeAgentPtys(tabs: readonly TabRuntimeInfo[] | null | undefined): Set<number> {
  return new Set((tabs ?? []).filter((t) => t.kind === 'agent' && !isOwnProvider(t.provider)).map((t) => t.pty_id));
}

/**
 * Per agent pty (not Hester/DevOps): the provider it runs and its session
 * name, for tab icons and labels. A terminal running a hand-started Claude
 * or Pi is included (A reports it as kind 'agent').
 */
export function tabDisplayFromRuntime(
  tabs: readonly TabRuntimeInfo[] | null | undefined,
): Map<number, { provider: string | null; name: string | null }> {
  const out = new Map<number, { provider: string | null; name: string | null }>();
  for (const t of tabs ?? []) {
    if (t.kind !== 'agent' || isOwnProvider(t.provider) || t.state.state === 'exited') continue;
    out.set(t.pty_id, { provider: t.provider ?? null, name: t.name ?? null });
  }
  return out;
}

export function isAgentTab(tab: ModelTab, sets: AgentSets): boolean {
  if (isOwnTab(tab)) return false;
  if (tab.type === 'agent' || tab.type === 'claude') return true;
  if (tab.ptyId == null) return false;
  return sets.snapshotAgents.has(tab.ptyId) || sets.runtimeAgents.has(tab.ptyId);
}

// ---------------------------------------------------------------------------
// Mode transitions (Deep D1 §1.2)
// ---------------------------------------------------------------------------

/** The switcher's card order; each further ⌘0 moves the highlight along it. */
export const MODES: readonly LeeMode[] = ['cockpit', 'deep', 'manual'];

export const MODE_LABELS: Record<LeeMode, string> = {
  cockpit: 'Cockpit',
  deep: 'Deep',
  manual: 'Manual',
};

export interface ModeInput {
  enabled: boolean;
  mode: LeeMode;
  /** A Deep focus session is active in this window's workspace. */
  deepActive?: boolean;
  /** This window has an exploration to show in Deep (its Deep memory). */
  hasExploration?: boolean;
}

export type ModeTrigger =
  | { kind: 'load'; enabled: boolean }
  | { kind: 'switcher'; to: LeeMode }
  | { kind: 'toggle_deep' }
  | { kind: 'toggle_manual' }
  | { kind: 'deep_session'; active: boolean }
  | { kind: 'handoff' }
  | { kind: 'return' }
  | { kind: 'go_into'; ptyId: number }
  | { kind: 'open_tab' }
  | { kind: 'tab_activated' };

export interface ModeDecision {
  mode: LeeMode;
  reason: ModeReason | null;
  /** Log cockpit.go_into for this pty. */
  goInto?: number;
  /**
   * Deep was asked for with nothing open (D1 §1.2): show the Cockpit on
   * Copilot and focus the opener's field instead of an empty Deep.
   */
  opener?: true;
  /**
   * Deep was asked for by a key or the switcher with nothing open: open
   * Deep on a blank Page (a new untitled exploration). The mode changes
   * once it exists.
   */
  blank?: true;
}

export interface DeepSessionInfo {
  exploration_id: string | null;
  title: string;
}

/**
 * The active Deep focus session in this workspace, from the attention
 * snapshot (`focus.deep`, falling back to an `exploration` focus item), or
 * null when there is none here.
 */
export function deepSessionOf(snapshot: AttentionSnapshot | null | undefined, workspace: string): DeepSessionInfo | null {
  const f = snapshot?.focus;
  if (!f || !f.active || f.source !== 'deep') return null;
  const item = f.item && f.item.kind === 'exploration' ? f.item : null;
  const ws = f.deep?.workspace ?? item?.workspace ?? null;
  // A session with no workspace on record is machine-wide: every window sees it.
  if (ws && workspace && !sameWorkspace(ws, workspace)) return null;
  return {
    exploration_id: f.deep?.exploration_id ?? item?.exploration_id ?? null,
    title: f.deep?.title ?? item?.title ?? '',
  };
}

/** Decide what a trigger does. null = nothing changes. */
export function nextMode(state: ModeInput, trigger: ModeTrigger): ModeDecision | null {
  // Lee always opens in the Cockpit (14 §3); with the Cockpit off, Manual only.
  if (trigger.kind === 'load') return { mode: trigger.enabled ? 'cockpit' : 'manual', reason: 'default' };
  if (!state.enabled) return null;
  const to = (mode: LeeMode, reason: ModeReason): ModeDecision | null =>
    mode === state.mode ? null : { mode, reason };
  // Entering Deep: the open exploration; with nothing open, a key or the
  // switcher gets a blank Page, and a session started elsewhere (a device's
  // Go deep) gets the opener on Copilot.
  const toDeep = (reason: ModeReason, nothingOpen: 'blank' | 'opener' = 'blank'): ModeDecision | null => {
    if (state.hasExploration) return to('deep', reason);
    if (nothingOpen === 'blank') return { mode: state.mode, reason: null, blank: true };
    return { mode: 'cockpit', reason: state.mode === 'cockpit' ? null : reason, opener: true };
  };
  const deepReason: ModeReason = state.deepActive ? 'hop' : 'deep_start';

  switch (trigger.kind) {
    case 'switcher':
      return trigger.to === 'deep' ? toDeep('switcher') : to(trigger.to, 'switcher');
    case 'toggle_deep':
      return state.mode === 'deep' ? to('cockpit', 'hop') : toDeep(deepReason);
    case 'toggle_manual':
      return to(state.mode === 'manual' ? 'cockpit' : 'manual', 'hop');
    case 'deep_session':
      if (trigger.active) return toDeep('deep_start', 'opener');
      return state.mode === 'deep' ? to('cockpit', 'deep_end') : null;
    case 'handoff':
    case 'return':
      // A return after a short absence keeps you in Deep.
      if (state.deepActive && state.mode === 'deep') return null;
      return to('cockpit', trigger.kind);
    case 'go_into':
      return { mode: 'manual', reason: state.mode === 'manual' ? null : 'go_into', goInto: trigger.ptyId };
    case 'open_tab':
      return to('manual', 'open_tab');
    case 'tab_activated':
      // The wall is gone (D1 §1.4): a tab becoming active never changes the mode.
      return null;
  }
}

// ---------------------------------------------------------------------------
// The ⌘0 switcher (Deep D1 §1.3)
// ---------------------------------------------------------------------------

/** Holding ⌘ this long after ⌘0 shows the overlay; a quicker release is a tap. */
export const SWITCHER_HOLD_MS = 250;

export type SwitcherVia = 'tap' | 'overlay' | 'chip';

export interface SwitcherState {
  phase: 'idle' | 'pending' | 'open';
  /** When ⌘0 went down (pending). */
  downAt: number;
  highlight: LeeMode;
  /** The overlay was opened from the mode chip: ⌘ isn't held, so click or Enter commits. */
  fromChip: boolean;
}

export const SWITCHER_IDLE: SwitcherState = { phase: 'idle', downAt: 0, highlight: 'cockpit', fromChip: false };

export type SwitcherEvent =
  /** ⌘0 keydown (not a key repeat). */
  | { kind: 'zero'; now: number; lastMode: LeeMode }
  /** ⌘ released. */
  | { kind: 'meta_up'; now: number }
  /** The hold timer fired. */
  | { kind: 'tick'; now: number }
  | { kind: 'chip'; lastMode: LeeMode }
  | { kind: 'move'; delta: 1 | -1 }
  /** The pointer is over a card. */
  | { kind: 'highlight'; to: LeeMode }
  | { kind: 'enter' }
  | { kind: 'click'; to: LeeMode }
  | { kind: 'escape' };

export interface SwitcherStep {
  state: SwitcherState;
  /** Switch to this mode (the caller skips it when it already is the mode). */
  commit?: { to: LeeMode; via: SwitcherVia };
}

function cycleMode(m: LeeMode, delta: 1 | -1): LeeMode {
  const i = MODES.indexOf(m);
  return MODES[(i + delta + MODES.length) % MODES.length];
}

/**
 * The switcher's state machine. A tap (⌘ released within 250 ms, no second
 * 0) goes back to the last mode; holding ⌘, or a second 0, shows the three
 * cards with the last mode highlighted; each further 0 moves the highlight;
 * releasing ⌘ commits; Esc cancels. The chip opens the same cards,
 * committed by a click or Enter.
 */
export function switcherStep(s: SwitcherState, ev: SwitcherEvent): SwitcherStep {
  const done = (to: LeeMode, via: SwitcherVia): SwitcherStep => ({ state: SWITCHER_IDLE, commit: { to, via } });
  switch (ev.kind) {
    case 'zero':
      if (s.phase === 'idle') return { state: { phase: 'pending', downAt: ev.now, highlight: ev.lastMode, fromChip: false } };
      if (s.phase === 'pending') return { state: { ...s, phase: 'open' } };
      return { state: { ...s, highlight: cycleMode(s.highlight, 1) } };
    case 'tick':
      if (s.phase === 'pending' && ev.now - s.downAt >= SWITCHER_HOLD_MS) return { state: { ...s, phase: 'open' } };
      return { state: s };
    case 'meta_up':
      if (s.phase === 'pending') return done(s.highlight, ev.now - s.downAt < SWITCHER_HOLD_MS ? 'tap' : 'overlay');
      if (s.phase === 'open' && !s.fromChip) return done(s.highlight, 'overlay');
      return { state: s };
    case 'chip':
      if (s.phase !== 'idle') return { state: s };
      return { state: { phase: 'open', downAt: 0, highlight: ev.lastMode, fromChip: true } };
    case 'move':
      return s.phase === 'open' ? { state: { ...s, highlight: cycleMode(s.highlight, ev.delta) } } : { state: s };
    case 'highlight':
      return s.phase === 'open' && s.highlight !== ev.to ? { state: { ...s, highlight: ev.to } } : { state: s };
    case 'enter':
      return s.phase === 'open' ? done(s.highlight, s.fromChip ? 'chip' : 'overlay') : { state: s };
    case 'click':
      return s.phase === 'open' ? done(ev.to, s.fromChip ? 'chip' : 'overlay') : { state: s };
    case 'escape':
      return { state: SWITCHER_IDLE };
  }
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatAge(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const ms = now - t;
  if (ms < 60000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

// ---------------------------------------------------------------------------
// Agent tiles (§3.5)
// ---------------------------------------------------------------------------

export type TileTone = 'needs' | 'busy' | 'idle' | 'muted';

export interface TileModel {
  ptyId: number;
  /** Where the shown name came from, when the title is a session name. */
  nameSource: AgentNameSource | null;
  /** Tab in this window, if any. */
  tabId: number | null;
  windowId: number | null;
  provider: string | null;
  title: string;
  chip: { label: string; tone: TileTone };
  /** For cockpit.go_into. */
  agentState: AgentState | TabRunState;
  /** The agent's own words: `text` as sent (markdown), `preview` plain and short. */
  summary: { text: string; preview: string; label: string } | null;
  /** Screen-tier agents: the last lines instead of a summary. */
  tail: string[] | null;
  meta: string[];
  fidelity: TabFidelity | null;
  approval: AttentionItem | null;
  /** First open item that accepts a text reply. */
  replyItem: AttentionItem | null;
  /**
   * The notification the tile's Dismiss closes: the open item that needs you
   * (else any other open item: summary, review, failure), if it accepts
   * 'dismiss'. Dismissing uses the queue's dismiss, as the flyout does.
   */
  notice: AttentionItem | null;
  /** The agent is mid-turn (closing it needs a second click). */
  working: boolean;
  task: CockpitTask | null;
  /** A has this PTY as an agent (check-ins possible). */
  canCheckin: boolean;
  /** A check-in queued behind the agent's turn, or typed and awaiting its reply. */
  checkin: { id: string; state: 'queued' | 'sent'; label: string } | null;
  needsYou: boolean;
}

export interface TileInput {
  workspace: string;
  /** This window's tabs. */
  tabs: readonly ModelTab[];
  sets: AgentSets;
  snapshot: AttentionSnapshot | null | undefined;
  runtime: readonly TabRuntimeInfo[] | null | undefined;
  tasks: readonly CockpitTask[] | null | undefined;
  now: number;
}

const NEEDS_ITEM_KINDS = new Set(['approval', 'question', 'waiting', 'blocker', 'decision']);

function providerName(provider: string | null | undefined): string {
  if (!provider) return 'Agent';
  if (provider === 'claude') return 'Claude';
  if (provider === 'pi') return 'Pi';
  if (provider === 'hester') return 'Hester';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function sameWorkspace(a: string | null | undefined, ws: string): boolean {
  return !!a && a.replace(/\/+$/, '') === ws.replace(/\/+$/, '');
}

/** The tile chip for a pending check-in. */
export function checkinChipLabel(state: 'queued' | 'sent'): string {
  return state === 'queued' ? 'check-in pending' : 'checking in…';
}

/**
 * Check-in results to toast (pure): Feed entries from the check-in producer
 * about a check-in this window started (`mine`) that it has not toasted yet.
 */
export function checkinToasts(
  entries: readonly FeedEntry[],
  mine: ReadonlySet<string>,
  toasted: ReadonlySet<string>,
): Array<{ checkin_id: string; message: string; level: 'info' | 'error' }> {
  const out: Array<{ checkin_id: string; message: string; level: 'info' | 'error' }> = [];
  for (const e of entries) {
    const id = e.ref?.checkin_id;
    if (e.producer !== 'checkin' || e.kind !== 'event' || !id || !mine.has(id) || toasted.has(id)) continue;
    out.push({ checkin_id: id, message: e.title, level: /\bfailed\b/.test(e.title) ? 'error' : 'info' });
  }
  return out;
}

export function tileModel(input: TileInput): TileModel[] {
  const { workspace, snapshot, now } = input;
  const agents = new Map<number, AgentSummary>();
  for (const a of snapshot?.agents ?? []) {
    if (sameWorkspace(a.workspace, workspace)) agents.set(a.pty_id, a);
  }
  const runtime = new Map<number, TabRuntimeInfo>();
  for (const r of input.runtime ?? []) runtime.set(r.pty_id, r);
  const localTabs = new Map<number, ModelTab>();
  for (const t of input.tabs) if (t.ptyId != null) localTabs.set(t.ptyId, t);

  const ptys: number[] = [];
  const seen = new Set<number>();
  const add = (id: number) => {
    if (!seen.has(id)) {
      seen.add(id);
      ptys.push(id);
    }
  };
  // Hester chat / DevOps tabs are never tiles, whatever A or the snapshot report about their pty.
  const exempt = (id: number) => {
    const t = localTabs.get(id);
    return !!t && isOwnTab(t);
  };
  for (const t of input.tabs) if (t.ptyId != null && isAgentTab(t, input.sets)) add(t.ptyId);
  for (const [id, a] of agents) if (!exempt(id) && !isOwnProvider(a.provider)) add(id);
  for (const r of input.runtime ?? []) {
    if (r.kind === 'agent' && r.state.state !== 'exited' && sameWorkspace(r.workspace, workspace) && !exempt(r.pty_id) && !isOwnProvider(r.provider)) {
      add(r.pty_id);
    }
  }

  const taskByPty = new Map<number, CockpitTask>();
  for (const t of input.tasks ?? []) {
    const p = t.agent?.pty_id;
    if (p != null && !taskByPty.has(p)) taskByPty.set(p, t);
  }

  const openItems = (snapshot?.items ?? []).filter((i) => i.state === 'open');

  return ptys.map((ptyId) => {
    const agent = agents.get(ptyId) ?? null;
    const rt = runtime.get(ptyId) ?? null;
    const tab = localTabs.get(ptyId) ?? null;
    const linkedId = rt?.task_id ?? null;
    const task = taskByPty.get(ptyId) ?? (linkedId ? (input.tasks ?? []).find((t) => t.id === linkedId) ?? null : null);
    const items = openItems.filter((i) => i.source.pty_id === ptyId);
    const approval = items.find((i) => i.kind === 'approval' && i.actions.includes('approve')) ?? null;
    const replyItem = items.find((i) => i.actions.includes('reply')) ?? null;
    const needsItem = items.find((i) => NEEDS_ITEM_KINDS.has(i.kind)) ?? null;
    const dismissable = items.filter((i) => i.actions.includes('dismiss'));
    const notice = dismissable.find((i) => NEEDS_ITEM_KINDS.has(i.kind)) ?? dismissable[0] ?? null;
    const provider = agent?.provider ?? rt?.provider ?? tab?.provider ?? task?.agent?.provider ?? null;

    // One state source for tiles and the Tabs list: the tab runtime (hooks for
    // hooked agents, else shell/pattern/quiet) when it knows; the queue's
    // agent summary only when the runtime doesn't.
    let chip: TileModel['chip'];
    let agentState: AgentState | TabRunState;
    const rtState = rt && rt.state.state !== 'unknown' ? rt.state : null;
    const since = (iso: string | null | undefined): number => {
      const t = iso ? Date.parse(iso) : NaN;
      return Number.isNaN(t) ? NaN : t;
    };
    const idleChip = (): TileModel['chip'] => {
      const finished = since(agent?.idle_since);
      if (!Number.isNaN(finished)) return { label: now - finished < 60000 ? 'finished just now' : `finished ${formatDuration(now - finished)} ago`, tone: 'idle' };
      const idleAt = since(rtState?.since);
      return { label: Number.isNaN(idleAt) ? 'idle' : `idle ${formatDuration(now - idleAt)}`, tone: 'idle' };
    };
    let busyNow = false;
    if (needsItem) {
      chip = { label: needsItem.kind === 'approval' ? 'needs approval' : 'waiting on you', tone: 'needs' };
      agentState = 'waiting';
    } else if (rtState) {
      agentState = rtState.state;
      const s = rtState.state;
      if (s === 'busy') {
        busyNow = true;
        const t = since(agent?.state === 'busy' ? agent.busy_since : null);
        const from = Number.isNaN(t) ? since(rtState.since) : t;
        chip = { label: Number.isNaN(from) ? 'busy' : `busy ${formatDuration(now - from)}`, tone: 'busy' };
      } else if (s === 'idle-at-prompt') chip = idleChip();
      else if (s === 'awaiting-input') chip = { label: 'waiting on you', tone: 'needs' };
      else chip = { label: s, tone: 'muted' };
    } else if (agent && agent.state !== 'unknown') {
      agentState = agent.state;
      if (agent.state === 'busy') {
        busyNow = true;
        const t = since(agent.busy_since);
        chip = { label: Number.isNaN(t) ? 'busy' : `busy ${formatDuration(now - t)}`, tone: 'busy' };
      } else if (agent.state === 'idle') chip = idleChip();
      else chip = { label: 'waiting', tone: 'needs' };
    } else if (agent || rt) {
      agentState = 'unknown';
      chip = { label: rt ? `quiet ${formatDuration(rt.state.quiet_ms)}` : 'state unknown', tone: 'muted' };
    } else {
      agentState = 'unknown';
      chip = { label: 'starting', tone: 'muted' };
    }

    const fidelity = rt?.fidelity ?? null;
    const screen = fidelity === 'screen';
    const summaryText = agent?.last_summary || task?.summary || null;
    const preview = summaryText ? plainPreview(summaryText) : '';
    const summary = !screen && summaryText ? { text: summaryText, preview, label: `${providerName(provider)} says` } : null;
    const tail = screen && rt && rt.tail.length ? rt.tail : null;

    const meta: string[] = [];
    if (agent?.last_tool) meta.push(agent.last_tool);
    if (agent && agent.files_touched_count > 0) meta.push(`${agent.files_touched_count} file${agent.files_touched_count === 1 ? '' : 's'}`);
    // Busy time only while busy (the chip already says idle/finished otherwise).
    if (busyNow && task && task.busy_ms > 60000) meta.push(`${formatDuration(task.busy_ms)} busy in total`);
    if (task && task.lead !== 'delegate') meta.push(task.lead === 'human' ? 'you lead' : 'plan');
    if (task && !task.confirmed) meta.push('unconfirmed');
    if (task?.agent?.model) meta.push(task.agent.model);
    if (screen) meta.push('screen');

    // The live session name (Lee main, from hooks or your rename) is freshest; then the task's.
    const title = rt?.name || taskTitle(task) || tab?.label || agent?.label || rt?.label || `${providerName(provider)} ${ptyId}`;

    return {
      ptyId,
      tabId: tab ? tab.id : null,
      nameSource: rt?.name ? rt.name_source ?? null : task?.name ? task.name_source ?? null : null,
      windowId: agent?.window_id ?? rt?.window_id ?? null,
      provider,
      title,
      chip,
      agentState,
      summary,
      tail,
      meta,
      fidelity,
      approval,
      replyItem,
      notice,
      working: busyNow,
      task,
      canCheckin: rt?.kind === 'agent' && rt.state.state !== 'exited',
      checkin: rt?.checkin ? { id: rt.checkin.id, state: rt.checkin.state, label: checkinChipLabel(rt.checkin.state) } : null,
      needsYou: chip.tone === 'needs',
    };
  });
}

// ---------------------------------------------------------------------------
// Feed (§4.1)
// ---------------------------------------------------------------------------

export interface HesterTaskEvent {
  at: string;
  task_id: string;
  kind: 'created' | 'auto_created' | 'closed' | 'status' | string;
  text: string;
}

export type FeedRow =
  | { source: 'attention'; id: string; kind: FeedKind; severity: FeedSeverity; at: string; title: string; item: AttentionItem }
  | { source: 'lee'; id: string; kind: FeedKind; severity: FeedSeverity; at: string; title: string; entry: FeedEntry }
  | { source: 'hester'; id: string; kind: FeedKind; severity: FeedSeverity; at: string; title: string; event: HesterTaskEvent };

export function attentionFeedKind(kind: AttentionItem['kind']): FeedKind {
  switch (kind) {
    case 'approval':
      return 'approval';
    case 'blocker':
      return 'blocker';
    case 'failure':
      return 'failure';
    case 'question':
    case 'waiting':
    case 'decision':
      return 'decision';
    default:
      return 'event';
  }
}

export interface FeedInput {
  workspace: string;
  items?: readonly AttentionItem[] | null;
  entries?: readonly FeedEntry[] | null;
  events?: readonly HesterTaskEvent[] | null;
  /** Session names by pty: an attention item's source label shows the agent's current name. */
  names?: ReadonlyMap<number, string> | null;
}

function severityRank(row: FeedRow): number {
  if (row.severity === 'blocking') return 0;
  if (row.severity === 'needs-you' || (row.source === 'lee' && row.entry.pinned)) return 1;
  return 2;
}

function ts(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Newest first, with blocking then needs-you pinned on top. */
export function mergeFeed(input: FeedInput): FeedRow[] {
  const ws = input.workspace;
  const rows: FeedRow[] = [];
  for (const item of input.items ?? []) {
    if (item.state !== 'open') continue;
    if (item.source.workspace && !sameWorkspace(item.source.workspace, ws)) continue;
    const name = item.source.pty_id != null ? input.names?.get(item.source.pty_id) : undefined;
    const shown = name && name !== item.source.tab_label ? { ...item, source: { ...item.source, tab_label: name } } : item;
    rows.push({
      source: 'attention',
      id: `att:${item.id}`,
      kind: attentionFeedKind(item.kind),
      severity: item.severity,
      at: item.updated_at || item.created_at,
      title: item.title,
      item: shown,
    });
  }
  for (const entry of input.entries ?? []) {
    if (entry.state !== 'open') continue;
    if (entry.workspace && !sameWorkspace(entry.workspace, ws)) continue;
    rows.push({ source: 'lee', id: `lee:${entry.id}`, kind: entry.kind, severity: entry.severity, at: entry.updated_at || entry.created_at, title: entry.title, entry });
  }
  (input.events ?? []).forEach((event, i) => {
    rows.push({
      source: 'hester',
      id: `hester:${event.task_id}:${event.at}:${i}`,
      kind: 'event',
      severity: 'ambient',
      at: event.at,
      // Hester's notes embed task titles, which can be raw agent words.
      title: plainLine(event.text, 140) || 'Task update',
      event,
    });
  });
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => severityRank(a.row) - severityRank(b.row) || ts(b.row.at) - ts(a.row.at) || a.i - b.i)
    .map((x) => x.row);
}

export function feedNeedsCount(rows: readonly FeedRow[]): number {
  return rows.filter((r) => r.severity !== 'ambient').length;
}

// ---------------------------------------------------------------------------
// Keyboard map (§3.7)
// ---------------------------------------------------------------------------

export type CockpitKeyAction =
  | { kind: 'row'; delta: 1 | -1 }
  | { kind: 'enter' }
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'reply' }
  | { kind: 'checkin' }
  | { kind: 'rename' }
  | { kind: 'run' }
  | { kind: 'dismiss' }
  | { kind: 'manual' }
  | { kind: 'escape' };

export interface KeyContext {
  /** Focus is in an input, textarea, select or contenteditable. */
  inInput: boolean;
  /** Focus is on a button or link: Enter and Space activate it, not the Cockpit. */
  onControl?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /**
   * The physical key (`KeyboardEvent.code`). The shifted punctuation chords
   * (⌘< ⌘> ⌘{) match on it, since `key` under ⌘⇧ varies by layout and OS.
   */
  code?: string;
}

/**
 * The Cockpit's keys (display form), in the order KeyHelp lists them. Actions
 * follow Lee's ⌘-chord convention; only navigation (arrows, Enter, Esc) is
 * bare, so a stray keystroke can never approve, deny or send. ⌘N has no
 * keyAction: the File > New File menu accelerator owns it, and App routes it
 * to the Launcher while the Cockpit is showing.
 */
export const COCKPIT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['⌘0', 'Switch mode: tap for the last one, hold for Cockpit / Deep / Manual'],
  ['⇧⌘0 / ⌥⌘0', 'Cockpit ↔ Deep / Cockpit ↔ Manual'],
  ['⌘N', 'New: a task, an exploration or a run (the Launcher)'],
  ['↓ / ↑', 'Next / previous row'],
  ['Enter', 'Open the selected row'],
  ['⌘⏎ / ⌘D', 'Approve / deny the selected approval'],
  ['⌘<', 'Reply to the selected item'],
  ['⌘>', 'Check in on the selected agent (shows the prompt first; queued if it is busy)'],
  ['⌘E', 'Rename the selected agent or task'],
  ['⌘{', 'Run ▾ operations'],
  ['⌘⌫', 'Dismiss the selected Feed entry'],
  ['⌘T', 'Manual, on your last tab'],
  ['Esc', 'Close popovers, clear selection'],
];

export function keyAction(key: string, ctx: KeyContext): CockpitKeyAction | null {
  if (ctx.inInput || ctx.ctrl || ctx.alt) return null;
  if (ctx.meta) {
    if (ctx.shift) {
      if (ctx.code === 'Comma' || key === '<') return { kind: 'reply' };
      if (ctx.code === 'Period' || key === '>') return { kind: 'checkin' };
      if (ctx.code === 'BracketLeft' || key === '{') return { kind: 'run' };
      return null;
    }
    switch (key.length === 1 ? key.toLowerCase() : key) {
      case 'Enter':
        return { kind: 'approve' };
      case 'd':
        return { kind: 'deny' };
      case 'e':
        return { kind: 'rename' };
      case 'Backspace':
        return { kind: 'dismiss' };
      case 't':
        return { kind: 'manual' };
      default:
        return null;
    }
  }
  if (ctx.shift) return null;
  if (ctx.onControl && (key === 'Enter' || key === ' ')) return null;
  switch (key) {
    case 'ArrowDown':
      return { kind: 'row', delta: 1 };
    case 'ArrowUp':
      return { kind: 'row', delta: -1 };
    case 'Enter':
      return { kind: 'enter' };
    case 'Escape':
      return { kind: 'escape' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Section badges (§3.4)
// ---------------------------------------------------------------------------

export interface SectionBadge {
  count: number;
  ember: boolean;
  /** A quiet neutral dot (something new to read, nothing needs you). */
  dot?: boolean;
}

/**
 * Nav badge for Copilot: a neutral dot while a fresh brief (the digest after
 * an absence) hasn't been looked at. Never ember: the brief needs nothing
 * from you (C2 quiet).
 */
export function copilotBadge(input: { returnNonce: number; seenNonce: number }): SectionBadge {
  return { count: 0, ember: false, dot: input.returnNonce > input.seenNonce };
}

/**
 * Does this task genuinely need you? A waiting agent does; a finished one
 * awaiting review does only once you've confirmed the task. Unconfirmed
 * (automatic) tasks are ambient (spec §2.3 ceremony, §7.2).
 */
export function taskNeedsYou(task: Pick<CockpitTask, 'status' | 'confirmed'>): boolean {
  return task.status === 'waiting' || (task.status === 'review' && task.confirmed);
}

/**
 * Nav badge for Tasks: ember with the needs-you count when any task needs
 * you, else a neutral count of open tasks.
 */
export function tasksBadge(open: readonly Pick<CockpitTask, 'status' | 'confirmed'>[]): SectionBadge {
  const n = open.filter(taskNeedsYou).length;
  return n > 0 ? { count: n, ember: true } : { count: open.length, ember: false };
}

/**
 * Nav badge for Ops: failing operations and proposals (a run someone asked
 * for, awaiting your approval) are ember; auto-detected suggestions are
 * ambient (spec §7.4, §8.2) and only show as a neutral count.
 */
export function opsBadge(input: { failing: number; proposals: number; suggestions: number }): SectionBadge {
  const needs = input.failing + input.proposals;
  return needs > 0 ? { count: needs, ember: true } : { count: input.suggestions, ember: false };
}

/**
 * Nav badge for Someday: a neutral count of open ideas. Old untriaged ideas
 * are not "needs you" (the Someday section itself notes the older-than-a-week
 * count), so this is never ember.
 */
export function somedayBadge(input: { open: number; untriagedOver7d: number }): SectionBadge {
  return { count: input.open, ember: false };
}

// ---------------------------------------------------------------------------
// Plain text from agent words (titles and previews)
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

function stripInline(line: string): string {
  let s = line;
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, ''); // HTML tags
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images -> alt
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // [t](u) -> t
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1'); // [t][ref] -> t
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1'); // <autolink>
  s = s.replace(/(`+)([^`]*?)\1/g, '$2'); // inline code keeps its text
  s = s.replace(/(\*\*|__)(?=\S)([^]*?\S)\1/g, '$2'); // bold
  s = s.replace(/~~(?=\S)([^]*?\S)~~/g, '$1'); // strikethrough
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2'); // *em*
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2'); // _em_ (not snake_case)
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Markdown to plain lines: fenced code blocks (including lee-status) are
 * dropped with their contents; headings, quotes, list and task markers,
 * rules, table separators, emphasis, inline-code ticks, links (kept as their
 * text) and HTML tags are stripped. Blank lines are kept as '' (paragraph
 * breaks). An unclosed fence (a clipped message) drops the rest.
 */
export function stripMarkdown(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  let fence: string | null = null;
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Text that starts mid-code (a tail clip) has an odd number of fence lines
  // and a bare first fence closing code above it: drop through that fence.
  const fences = lines.map((l, i) => (FENCE_OPEN.test(l) ? i : -1)).filter((i) => i >= 0);
  if (fences.length % 2 === 1 && /^[ \t]*(`{3,}|~{3,})[ \t]*$/.test(lines[fences[0]]) && lines.slice(0, fences[0]).some((l) => looksLikeCode(l))) {
    lines = lines.slice(fences[0] + 1);
  }
  for (const raw of lines) {
    const open = FENCE_OPEN.exec(raw);
    if (fence !== null) {
      const t = raw.trim();
      if (open && t[0] === fence[0] && t.length >= fence.length && /^(`+|~+)$/.test(t)) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    let line = raw.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue; // rule
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line)) continue; // table separator
    line = line.replace(/^(>\s?)+/, '');
    line = line.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '');
    line = line.replace(/^([-*+]|\d{1,3}[.)])\s+/, '');
    line = line.replace(/^\[[ xX]\]\s+/, '');
    if (line.startsWith('|') && line.endsWith('|')) line = line.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
    line = stripInline(line);
    if (line) out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

const CODE_KEYWORD = /^(const|let|var|function|def|class|import|export|return|async|await|package|public|private)\s+\S/;

/** Does a (stripped) line look like source code rather than prose? */
export function looksLikeCode(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (/^(\/\/|\/\*|\*\/|#!|#include\b)/.test(s)) return true;
  if (/,\s*$/.test(s) && s.split(/\s+/).length <= 4) return true; // a list/object line: "key: value,"
  if (/\$\{|=>|\)\s*\{|;\s*$|^[)}\]]|[{[(]\s*$|['"`],\s*$|^['"`][^'"`]*['"`],?$/.test(s)) return true;
  if (CODE_KEYWORD.test(s) && /[=(){};]/.test(s)) return true;
  if (/^[\w.$[\]]+\s*[-+*/]?=\s*[^=\s]/.test(s)) return true; // x = y, x += 1
  // Symbol density; `name()` mentions in prose don't count.
  const sym = (s.replace(/\w\(\)/g, 'x').match(/[{}[\]();=<>$|&\\]/g) ?? []).length;
  return sym >= 3 && sym / s.length > 0.08;
}

function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/**
 * A plain-text title from agent words: markdown stripped, code-looking lines
 * skipped, the first meaningful sentence, at most `max` chars. '' when
 * nothing usable is left (callers fall back to a label).
 */
export function plainTitle(text: string | null | undefined, max = 80): string {
  const line = stripMarkdown(text).find((l) => l && !looksLikeCode(l) && /[A-Za-z]{2}/.test(l));
  if (!line) return '';
  const m = /^(.+?[.!?])(?=\s+\S)/.exec(line);
  const sentence = m && m[1].length >= 16 ? m[1] : line;
  return clipWords(sentence.replace(/[:;,]\s*$/, ''), max);
}

/** The first plain, non-code line, at most `max` chars (no sentence split). */
export function plainLine(text: string | null | undefined, max = 120): string {
  const line = stripMarkdown(text).find((l) => l && !looksLikeCode(l));
  return line ? clipWords(line, max) : '';
}

/** A plain-text preview: markdown stripped, code dropped, the first few lines joined. */
export function plainPreview(text: string | null | undefined, maxLines = 3, maxChars = 240): string {
  const lines = stripMarkdown(text).filter((l) => l && !looksLikeCode(l));
  return clipWords(lines.slice(0, maxLines).join(' '), maxChars);
}

/**
 * A task's display title: its session name when it has one (yours, a Claude
 * /rename or Claude's own title; addendum 2026-09-26b), else a user's title as
 * given, else an agent/auto title made plain.
 */
export function taskTitle(task: Pick<CockpitTask, 'title' | 'title_source' | 'name'> | null | undefined): string {
  if (task?.name) return task.name;
  if (!task || !task.title || task.title === '(untitled)') return '';
  if (task.title_source === 'user') return task.title;
  return plainTitle(task.title);
}

// ---------------------------------------------------------------------------
// Files section: the workspace tree as flat, keyboard-navigable rows
// ---------------------------------------------------------------------------

export interface FileEntryLite {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface FileRow {
  entry: FileEntryLite;
  depth: number;
  expanded: boolean;
}

function fileMatches(entry: FileEntryLite, filter: string, children: ReadonlyMap<string, readonly FileEntryLite[]>): boolean {
  if (entry.name.toLowerCase().includes(filter)) return true;
  if (entry.type !== 'directory') return false;
  return (children.get(entry.path) ?? []).some((c) => fileMatches(c, filter, children));
}

/**
 * Flatten the loaded tree into rows, depth first, directories as listed
 * (readdir already puts them first). A filter keeps entries whose name
 * matches or that hold a loaded match, and shows a matching directory's
 * loaded children as if expanded (same rule as FileTreePane).
 */
export function flattenFileTree(
  root: readonly FileEntryLite[],
  children: ReadonlyMap<string, readonly FileEntryLite[]>,
  expanded: ReadonlySet<string>,
  filter = '',
): FileRow[] {
  const f = filter.trim().toLowerCase();
  const out: FileRow[] = [];
  const walk = (items: readonly FileEntryLite[], depth: number) => {
    for (const e of items) {
      if (f && !fileMatches(e, f, children)) continue;
      const open = e.type === 'directory' && (expanded.has(e.path) || (!!f && (children.get(e.path) ?? []).some((c) => fileMatches(c, f, children))));
      out.push({ entry: e, depth, expanded: open });
      if (open) walk(children.get(e.path) ?? [], depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Launcher context picker: fuzzy match over workspace files and bundles
// ---------------------------------------------------------------------------

/**
 * Subsequence fuzzy score of `query` in `text` (case-insensitive), or
 * -Infinity when not every query character appears in order. Higher is better: consecutive
 * runs, matches at word/path boundaries and in the basename score more;
 * shorter texts win ties.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  const base = t.lastIndexOf('/') + 1;
  let score = 0;
  let ti = 0;
  let run = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return Number.NEGATIVE_INFINITY;
    run = i === prev + 1 ? run + 1 : 0;
    score += 1 + run * 2;
    const before = i > 0 ? t[i - 1] : '/';
    if (before === '/' || before === '_' || before === '-' || before === '.' || before === ' ') score += 3;
    if (i >= base) score += 1;
    prev = i;
    ti = i + 1;
  }
  if (t.slice(base).includes(q)) score += 10;
  return score - t.length * 0.01;
}

/** The best `limit` matches of `query` among `items` (by `key`), best first; stable for equal scores. */
export function fuzzyFilter<T>(query: string, items: readonly T[], key: (item: T) => string, limit = 20): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const score = fuzzyScore(query, key(item));
    if (score > Number.NEGATIVE_INFINITY) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.item);
}

// ---------------------------------------------------------------------------
// Copilot v4: goals, quadrants, steward (v4 contract §8)
// ---------------------------------------------------------------------------

/** Nav badge for Goals: ember with the flagged count when any goal is flagged, else none. */
export function goalsBadge(goals: readonly { flagged: boolean }[] | null | undefined): SectionBadge {
  const n = (goals ?? []).filter((g) => g.flagged).length;
  return n > 0 ? { count: n, ember: true } : { count: 0, ember: false };
}

export type QuadrantTone = 'q1' | 'q2' | 'q3' | 'q4' | 'play' | 'none';

/** The task row's quadrant chip: chosen play reads "play"; no quadrant reads "unclassified" (dim). */
export function quadrantChip(task: { quadrant?: Quadrant | null; play?: boolean }): { label: string; tone: QuadrantTone } {
  if (task.play) return { label: 'play', tone: 'play' };
  switch (task.quadrant) {
    case 'Q1':
      return { label: 'Q1', tone: 'q1' };
    case 'Q2':
      return { label: 'Q2', tone: 'q2' };
    case 'Q3':
      return { label: 'Q3', tone: 'q3' };
    case 'Q4':
      return { label: 'Q4', tone: 'q4' };
    default:
      return { label: 'unclassified', tone: 'none' };
  }
}

/** Quadrant order (v4 §4, §7.2): Q1, Q2, Q3, unclassified, Q4. */
export function quadrantRank(q: Quadrant | null | undefined): number {
  return q === 'Q1' ? 0 : q === 'Q2' ? 1 : q === 'Q3' ? 2 : q === 'Q4' ? 4 : 3;
}

export type OverrideChoice = 'on' | 'off' | 'auto';

export function overrideChoice(overrides: TaskOverrides | null | undefined, axis: 'important' | 'urgent'): OverrideChoice {
  const v = overrides?.[axis];
  return v === true ? 'on' : v === false ? 'off' : 'auto';
}

/** PATCH /cockpit/tasks/{id} body for an override pick (auto clears it). */
export function overridePatch(axis: 'important' | 'urgent', choice: OverrideChoice): { important?: boolean | null; urgent?: boolean | null } {
  const v = choice === 'on' ? true : choice === 'off' ? false : null;
  return axis === 'important' ? { important: v } : { urgent: v };
}

/**
 * The Launcher's one-line Q4 note (v4 §8.5): a prototype (kind, or a
 * `proto:` prefix) with no goal, no play and not a human lead. Never blocks.
 */
export function q4NoteVisible(input: {
  kind: TaskKind | null | undefined;
  text: string;
  serves: readonly string[];
  play: boolean;
  lead: TaskLead;
}): boolean {
  const proto = input.kind === 'prototype' || /^\s*proto:/i.test(input.text);
  return proto && input.serves.length === 0 && !input.play && input.lead !== 'human';
}

export const BALANCE_BANDS = ['Q1', 'Q2', 'Q3', 'Q4', 'play', 'unclassified'] as const;
export type BalanceBand = (typeof BALANCE_BANDS)[number];

/** Stacked-bar segments for the human_balance strip: every band in order, as a share of all focus time (0 when none). */
export function balanceSegments(
  ms: Partial<Record<BalanceBand, number>> | null | undefined,
): Array<{ band: BalanceBand; ms: number; share: number }> {
  const vals = BALANCE_BANDS.map((band) => ({ band, ms: Math.max(0, Number(ms?.[band]) || 0) }));
  const total = vals.reduce((a, v) => a + v.ms, 0);
  return vals.map((v) => ({ ...v, share: total > 0 ? v.ms / total : 0 }));
}

/** Hours for the strip legend: "0h", "0.4h", "12h". */
export function formatHours(ms: number): string {
  const h = Math.max(0, ms) / 3_600_000;
  if (h === 0) return '0h';
  if (h < 10) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round(h)}h`;
}

function trimNum(n: number): string {
  const abs = Math.abs(n);
  const r = abs >= 100 ? Math.round(n) : abs >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
  return String(r);
}

/** A goal metric value; a '%' target means the value is a 0-1 share. */
export function formatMetricValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '–';
  if (unit === '%') return `${trimNum(value * 100)}%`;
  return trimNum(value);
}

export function trendArrow(trend: 'down' | 'up' | 'flat' | null | undefined): string {
  return trend === 'down' ? '↓' : trend === 'up' ? '↑' : trend === 'flat' ? '→' : '';
}

/** History chip for a reading's goal impact: "G1 +180 ms". */
export function goalDeltaChip(goalId: string, delta: number | null | undefined, unit: string | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return goalId;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  return `${goalId} ${sign}${trimNum(Math.abs(delta))}${unit ? ` ${unit}` : ''}`;
}

/** The steer card's Send label: the text is typed even when the agent is busy (you clicked). */
export function steerSendLabel(state: string | null | undefined): string {
  return state === 'busy' ? 'Send now (agent is busy)' : 'Send';
}

/** `link_goal` adds goals: the task's current serves plus the proposed ones (order kept, no duplicates). */
export function mergeServes(current: readonly string[] | null | undefined, add: readonly string[]): string[] {
  return [...new Set([...(current ?? []), ...add])];
}

/** What a proposal click does, through existing client calls (v4 §8.3). null: malformed (not shown). */
export type ProposalPlan =
  | {
      kind: 'create_task';
      body: { workspace: string; title: string; status: 'queued'; serves?: string[]; lead?: TaskLead; kind?: TaskKind; origin?: TaskOrigin };
    }
  | { kind: 'launch'; req: LaunchRequest }
  | { kind: 'patch_task'; taskId: string; body: { serves: string[] } | { lead: TaskLead } }
  | { kind: 'park'; text: string }
  | { kind: 'open'; target: 'task' | 'exploration' | 'goal' | 'workstream'; id: string }
  | { kind: 'run_op'; name: string }
  | { kind: 'explore'; seed: string };

const PLAN_LEADS: readonly string[] = ['delegate', 'human', 'plan'];
const PLAN_KINDS: readonly string[] = ['bug', 'question', 'prototype', 'chore', 'unknown'];
const OPEN_TARGETS: readonly string[] = ['task', 'exploration', 'goal', 'workstream'];

function pStr(v: unknown, max = 4000): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function pList(v: unknown): string[] | null {
  if (v == null) return null;
  const arr: unknown[] | null = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!arr) return null;
  return arr.map((x) => pStr(x, 40)).filter((x): x is string => !!x);
}

function pLead(v: unknown): TaskLead | null {
  return typeof v === 'string' && PLAN_LEADS.includes(v) ? (v as TaskLead) : null;
}

function pKind(v: unknown): TaskKind | null {
  return typeof v === 'string' && PLAN_KINDS.includes(v) ? (v as TaskKind) : null;
}

function pOrigin(v: unknown): TaskOrigin | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { kind?: unknown; ref?: unknown };
  if (typeof o.kind !== 'string' || !o.kind) return null;
  return { kind: o.kind as TaskOrigin['kind'], ref: typeof o.ref === 'string' ? o.ref : null };
}

export function proposalPlan(p: Pick<Proposal, 'action' | 'params'>, workspace: string): ProposalPlan | null {
  const q = (p.params ?? {}) as Record<string, unknown>;
  switch (p.action) {
    case 'create_task': {
      const title = pStr(q.title, 200);
      if (!title) return null;
      const serves = pList(q.serves);
      const lead = pLead(q.lead);
      const kind = pKind(q.kind);
      const origin = pOrigin(q.origin);
      return {
        kind: 'create_task',
        body: {
          workspace,
          title,
          status: 'queued',
          ...(serves && serves.length ? { serves } : {}),
          ...(lead ? { lead } : {}),
          ...(kind ? { kind } : {}),
          ...(origin ? { origin } : {}),
        },
      };
    }
    case 'launch': {
      const prompt = pStr(q.prompt);
      if (!prompt) return null;
      const serves = pList(q.serves);
      const lead = pLead(q.lead);
      const kind = pKind(q.kind);
      const title = pStr(q.title, 200);
      const human = lead === 'human';
      return {
        kind: 'launch',
        req: {
          workspace,
          origin: { kind: 'hester' },
          ...(human ? { title: title ?? prompt.split('\n')[0].slice(0, 80) } : { prompt }),
          ...(title && !human ? { title } : {}),
          ...(lead ? { lead } : {}),
          ...(kind ? { kind } : {}),
          ...(serves && serves.length ? { serves } : {}),
        },
      };
    }
    case 'link_goal': {
      const taskId = pStr(q.task_id, 200);
      const serves = pList(q.serves);
      if (!taskId || !serves || !serves.length) return null;
      return { kind: 'patch_task', taskId, body: { serves } };
    }
    case 'set_lead': {
      const taskId = pStr(q.task_id, 200);
      const lead = pLead(q.lead);
      if (!taskId || !lead) return null;
      return { kind: 'patch_task', taskId, body: { lead } };
    }
    case 'park': {
      const text = pStr(q.text);
      return text ? { kind: 'park', text } : null;
    }
    case 'open': {
      const target = typeof q.kind === 'string' && OPEN_TARGETS.includes(q.kind) ? (q.kind as 'task' | 'exploration' | 'goal' | 'workstream') : null;
      const id = pStr(q.id, 200);
      return target && id ? { kind: 'open', target, id } : null;
    }
    case 'run_op': {
      const name = pStr(q.name, 200);
      return name ? { kind: 'run_op', name } : null;
    }
    case 'explore': {
      const seed = pStr(q.seed);
      return seed ? { kind: 'explore', seed } : null;
    }
    default:
      return null;
  }
}

/** The task a proposal is about (its ✕ records a nudge override for that task), or null. */
export function proposalTaskId(p: Pick<Proposal, 'action' | 'params'>): string | null {
  const q = (p.params ?? {}) as Record<string, unknown>;
  if (p.action === 'link_goal' || p.action === 'set_lead') return pStr(q.task_id, 200);
  if (p.action === 'open' && q.kind === 'task') return pStr(q.id, 200);
  return null;
}

/** Group label for a lint family in the flyout (v4 adds hygiene, scope, attention, agent, project). */
export const LINT_FAMILY_LABELS: Record<string, string> = {
  toil: 'Toil',
  hygiene: 'Hygiene',
  scope: 'Scope',
  attention: 'Attention',
  agent: 'Agent use',
  project: 'Project rules',
};

export function lintFamilyLabel(family: string): string {
  return LINT_FAMILY_LABELS[family] ?? family;
}

/** A lint fix result that asks the renderer to act (v4 §7.3: link-goal, what-next). */
export function rendererAction(res: unknown): { action: 'link-goal' | 'what-next'; taskId: string | null } | null {
  if (!res || typeof res !== 'object') return null;
  let data = (res as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  // Through the Feed (feed.act) the lint fix result is nested one level: {data: {success, data}}.
  if (!('renderer_action' in data) && 'data' in data) data = (data as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const d = data as { renderer_action?: unknown; task_id?: unknown };
  if (d.renderer_action !== 'link-goal' && d.renderer_action !== 'what-next') return null;
  return { action: d.renderer_action, taskId: typeof d.task_id === 'string' && d.task_id ? d.task_id : null };
}

// ---------------------------------------------------------------------------
// Cockpit design, the shell and Home (cockpit-design §2, §3, §6.3; R1)
// ---------------------------------------------------------------------------

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** A count in words ("two"), digits past twelve; `capital` for the start of a sentence. */
export function numberWord(n: number, capital = false): string {
  const w = n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
  return capital ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Home's greeting above the question (§3.1): "<weekday> <part of day>" in
 * local time. 05:00-11:59 morning, 12:00-16:59 afternoon, 17:00-21:59
 * evening, otherwise night (a night past midnight keeps its own weekday).
 */
export function greeting(now: Date): string {
  const h = now.getHours();
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night';
  return `${WEEKDAYS[now.getDay()]} ${part}`;
}

/** Home's question (§3.2): with your first name when Lee knows it (§7.2). */
export function homeQuestion(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  return n ? `What's on your mind, ${n}?` : "What's on your mind?";
}

/** The digest fields Meanwhile reads (a structural subset of DigestResponse). */
export interface MeanwhileDigest {
  wins: readonly unknown[];
  agent_claims: readonly { session_id: string }[];
}

/**
 * Meanwhile's one sentence (§3.6): what finished, what shipped and what's
 * waiting on you, in words ("Two agents finished while you were away. One
 * is waiting on you."). Finished turns count once per agent session; wins
 * are the digest's verified progress; `waiting` is what needs you now.
 */
/**
 * The line for "nothing is waiting on you": "Working on it." while agents are
 * busy, else "All clear." Shared by Work's empty state, Home's Meanwhile and
 * the attention flyout so they always agree.
 */
export function quietLine(working: number): string {
  return working > 0 ? 'Working on it.' : 'All clear.';
}

export function meanwhileSentence(
  digest: MeanwhileDigest | null | undefined,
  attention: { waiting: number; working?: number },
): string {
  const finished = new Set((digest?.agent_claims ?? []).map((c) => c.session_id)).size;
  const shipped = digest?.wins.length ?? 0;
  const waiting = Math.max(0, attention.waiting);
  const parts: string[] = [];
  if (finished > 0) {
    const agents = `${numberWord(finished, true)} ${plural(finished, 'agent', 'agents')} finished`;
    parts.push(
      shipped > 0
        ? `${agents} while you were away, and ${numberWord(shipped)} ${plural(shipped, 'thing', 'things')} shipped.`
        : `${agents} while you were away.`,
    );
  } else if (shipped > 0) {
    parts.push(`${numberWord(shipped, true)} ${plural(shipped, 'thing', 'things')} shipped while you were away.`);
  }
  if (waiting > 0) {
    // After "N agents finished", "One is waiting" reads as one of them; otherwise say what.
    parts.push(
      finished > 0
        ? `${numberWord(waiting, true)} ${plural(waiting, 'is', 'are')} waiting on you.`
        : `${numberWord(waiting, true)} ${plural(waiting, 'thing is', 'things are')} waiting on you.`,
    );
  } else {
    const quiet = quietLine(attention.working ?? 0);
    parts.push(parts.length ? quiet : `Quiet while you were away. ${quiet}`);
  }
  return parts.join(' ');
}

/** A Feed row from the attention queue (an agent waiting on you). */
export type AttentionFeedRow = Extract<FeedRow, { source: 'attention' }>;

/**
 * Home's needs-you rows (§3.6): attention items that need you, in the
 * queue's order (blocking, then needs-you, oldest first), at most `limit`.
 */
export function homeNeeds(rows: readonly FeedRow[], limit = 3): AttentionFeedRow[] {
  const rank = (r: AttentionFeedRow) => (r.severity === 'blocking' ? 0 : 1);
  return rows
    .filter((r): r is AttentionFeedRow => r.source === 'attention' && r.severity !== 'ambient' && r.item.kind !== 'summary')
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row) - rank(b.row) || ts(a.row.item.created_at) - ts(b.row.item.created_at) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.row);
}

/** Attention rows that need you: what Work's "Waiting on you" shows (summaries are Home's digest). */
export function workNeedsCount(rows: readonly FeedRow[]): number {
  return rows.filter((r) => r.source === 'attention' && r.severity !== 'ambient' && r.item.kind !== 'summary').length;
}

/** A Lee Feed row (an entry a Lee producer posted: check-in, ops, lint, tabs). */
export type LeeFeedRow = Extract<FeedRow, { source: 'lee' }>;

/**
 * Lee Feed entries that need you and have no other place (§4.1): a check-in
 * proposal, an operation agent's "Escalate to a task?", and the like. They
 * show in Home's Meanwhile. Lint findings are Ops' lint group, an
 * operation's failure is Ops (and Work's In flight), and a run proposal is
 * Ops' Proposals (`opsProposalIds`), so those stay out. Feed order.
 */
export function homeFeedNeeds(rows: readonly FeedRow[], opsProposalIds: Iterable<string> = []): LeeFeedRow[] {
  const inOps = new Set(opsProposalIds);
  return rows.filter(
    (r): r is LeeFeedRow =>
      r.source === 'lee' &&
      r.severity !== 'ambient' &&
      r.entry.producer !== 'lint' &&
      !(r.entry.kind === 'failure' && r.entry.ref.op) &&
      !(r.entry.ref.proposal_id && inOps.has(r.entry.ref.proposal_id)),
  );
}

/** The Q2 candidate fields a sentence needs (lib/hesterCockpit Q2Candidate). */
export interface Q2Like {
  kind: 'goal-unserved' | 'exploration-quiet' | 'evaluation-due';
  goal_id?: string | null;
  title: string;
  detail: string;
}

/**
 * A Q2 item written out as a sentence for "Or start from" (§3.5), from the
 * candidate's own text: "G1 has nothing open serving it", "Onboarding
 * notes: untouched for 9 days", "G2 was last evaluated 20 days ago".
 */
export function q2Sentence(c: Q2Like): string {
  const who = c.goal_id || c.title;
  const detail = (c.detail ?? '').trim().replace(/\.$/, '');
  const lower = detail ? detail.charAt(0).toLowerCase() + detail.slice(1) : '';
  switch (c.kind) {
    case 'goal-unserved':
      return `${who} has nothing open serving it`;
    case 'evaluation-due':
      if (/^never evaluated/i.test(detail)) return `${who} has never been evaluated`;
      return lower ? `${who} was ${lower}` : `${who} is due an evaluation`;
    case 'exploration-quiet':
      return lower ? `${c.title}: ${lower}` : `${c.title} has gone quiet`;
  }
  return c.title;
}

/** An "Or start from" surface (shared OpenerSurface), structurally. */
export type StartSurface =
  | { kind: 'blank' }
  | { kind: 'open_questions' | 'reading_list' | 'quiet'; count?: number; items: readonly unknown[] }
  | { kind: 'captured_away'; count?: number; items: readonly { surface: string }[] }
  | { kind: 'q2'; items: readonly unknown[] };

/**
 * One "Or start from" surface as a sentence (§3.5), or null when it has
 * nothing. Q2 is written per item (q2Sentence), so it returns null here.
 * Captured away says "from your phone" when every item came from Aeronaut,
 * "from your devices" otherwise (the T-Deck counts too).
 */
export function startSentence(s: StartSurface): string | null {
  if (s.kind === 'blank') return 'A blank page';
  if (s.kind === 'q2') return null;
  const n = typeof s.count === 'number' ? s.count : s.items.length;
  if (n <= 0 || !s.items.length) return null;
  switch (s.kind) {
    case 'open_questions':
      return `${n} open ${plural(n, 'question', 'questions')}`;
    case 'captured_away': {
      const phone = s.items.every((i) => i.surface === 'aeronaut');
      return `${n} ${plural(n, 'thought', 'thoughts')} from your ${phone ? 'phone' : 'devices'}`;
    }
    case 'reading_list':
      return `${n} ${plural(n, 'thing', 'things')} to read`;
    case 'quiet':
      return `${n} quiet ${plural(n, 'exploration', 'explorations')}`;
  }
  return null;
}

/** Pick up's arrivals line (§3.4): "2 answers came back · 1 open question". Empty when nothing arrived. */
export function arrivedLine(arrived: { answers: number; open_questions: number }): string {
  return [
    arrived.answers ? `${arrived.answers} ${plural(arrived.answers, 'answer', 'answers')} came back` : null,
    arrived.open_questions ? `${arrived.open_questions} open ${plural(arrived.open_questions, 'question', 'questions')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The Launcher's three choices at the top (§2.1): Task (Enter launches), Explore, Run… (⌘{). */
export type LauncherChoice = 'task' | 'explore' | 'run';
export const LAUNCHER_CHOICES: ReadonlyArray<{ id: LauncherChoice; label: string; kbd?: string }> = [
  { id: 'task', label: 'Task', kbd: '⏎' },
  { id: 'explore', label: 'Explore' },
  { id: 'run', label: 'Run…', kbd: '⌘{' },
];

/** Days after which a goal's evaluation is due (hester/daemon/cockpit/goal_status.py EVALUATION_DUE_DAYS). */
export const EVALUATION_DUE_DAYS = 14;

/** Never evaluated, or last evaluated more than EVALUATION_DUE_DAYS ago (the daemon's evaluation-due rule). */
export function evaluationDue(lastEvaluatedAt: string | null | undefined, now: number): boolean {
  if (!lastEvaluatedAt) return true;
  const t = Date.parse(lastEvaluatedAt);
  if (Number.isNaN(t)) return true;
  return now - t > EVALUATION_DUE_DAYS * 86400000;
}

export interface RailInput {
  /** Lee Feed entries only Home shows (homeFeedNeeds). */
  home?: number;
  /** What Work shows as needing you: attention items (workNeedsCount) plus tasks that need you. */
  work: number;
  goals: readonly { flagged: boolean; last_evaluated_at: string | null }[] | null | undefined;
  opsFailing: number;
  opsProposals: number;
  now: number;
}

/**
 * The rail's ember dots (§2.1): a section gets one when it holds something
 * that needs you. No counts anywhere. Home's own are the Lee Feed entries
 * nothing else shows (its attention rows are Work's items, and count there);
 * Library and History never do: ideas are never urgent.
 */
export function railDots(input: RailInput): Record<SectionId, boolean> {
  const goals = input.goals ?? [];
  return {
    home: (input.home ?? 0) > 0,
    work: input.work > 0,
    goals: goals.some((g) => g.flagged || evaluationDue(g.last_evaluated_at, input.now)),
    library: false,
    ops: input.opsFailing + input.opsProposals > 0,
    history: false,
  };
}

/**
 * The Cockpit's status-bar counts (§2.1), for this window's workspace:
 * busy agents, and open items that need you (shown in neutral text, never
 * ember).
 */
export function cockpitStatusCounts(input: {
  workspace: string;
  agents?: readonly Pick<AgentSummary, 'state' | 'workspace'>[] | null;
  items?: readonly Pick<AttentionItem, 'state' | 'severity' | 'kind' | 'source'>[] | null;
}): { working: number; waiting: number } {
  const ws = input.workspace;
  const mine = (w: string | null | undefined) => !w || !ws || sameWorkspace(w, ws);
  const working = (input.agents ?? []).filter((a) => a.state === 'busy' && mine(a.workspace)).length;
  const waiting = (input.items ?? []).filter(
    (i) => i.state === 'open' && i.severity !== 'ambient' && i.kind !== 'summary' && mine(i.source.workspace),
  ).length;
  return { working, waiting };
}

/** "2 agents working" and "1 waiting" (each null when zero). */
export function cockpitStatusParts(c: { working: number; waiting: number }): { working: string | null; waiting: string | null } {
  return {
    working: c.working > 0 ? `${c.working} ${plural(c.working, 'agent', 'agents')} working` : null,
    waiting: c.waiting > 0 ? `${c.waiting} waiting` : null,
  };
}
