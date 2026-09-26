/**
 * Pure Cockpit model (contracts §3, §4): mode transitions, the tab-strip wall,
 * agent tiles, the merged Feed and the Cockpit keyboard map. No React, no
 * DOM, type-only imports, so scripts/cockpit-renderer-smoke.mjs can compile
 * it with esbuild and run it under plain node.
 */

import type { AgentState, AgentSummary, AttentionItem, AttentionSnapshot } from '../../shared/copilot';
import type {
  CockpitTask,
  FeedEntry,
  FeedKind,
  FeedSeverity,
  LeeMode,
  ModeReason,
  TabFidelity,
  TabRunState,
  TabRuntimeInfo,
} from '../../shared/cockpit';

export type SectionId = 'feed' | 'tasks' | 'ops' | 'someday' | 'tabs' | 'history';

export const SECTIONS: readonly SectionId[] = ['feed', 'tasks', 'ops', 'someday', 'tabs', 'history'];

export const SECTION_LABELS: Record<SectionId, string> = {
  feed: 'Feed',
  tasks: 'Tasks',
  ops: 'Ops',
  someday: 'Someday',
  tabs: 'Tabs',
  history: 'History',
};

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
// Agent tabs and the strip (§3.1)
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

/** Providers that are the user's own tools, not agents: Hester chat stays outside the wall (user decision 2026-09-25). */
const OWN_PROVIDERS = new Set(['hester']);
/** Tab types that are never walled, whatever A or the snapshot report: Hester chat, Hester QA, DevOps. */
const OWN_TAB_TYPES = new Set(['hester', 'hester-qa', 'devops']);

/** Hester chat and DevOps tabs stay visible like the user's own tabs, even when typed 'agent'. */
export function isWallExempt(tab: Pick<ModelTab, 'type' | 'provider'>): boolean {
  return OWN_TAB_TYPES.has(tab.type) || (!!tab.provider && OWN_PROVIDERS.has(tab.provider));
}

export function isOwnProvider(provider: string | null | undefined): boolean {
  return !!provider && OWN_PROVIDERS.has(provider);
}

export function runtimeAgentPtys(tabs: readonly TabRuntimeInfo[] | null | undefined): Set<number> {
  return new Set((tabs ?? []).filter((t) => t.kind === 'agent' && !isOwnProvider(t.provider)).map((t) => t.pty_id));
}

export function isAgentTab(tab: ModelTab, sets: AgentSets): boolean {
  if (isWallExempt(tab)) return false;
  if (tab.type === 'agent' || tab.type === 'claude') return true;
  if (tab.ptyId == null) return false;
  return sets.snapshotAgents.has(tab.ptyId) || sets.runtimeAgents.has(tab.ptyId);
}

/**
 * Workbench strip for one dock (center, or a side panel): own tabs plus the
 * agent terminals you went into. Identity when the Cockpit is disabled.
 */
export function stripTabs<T extends ModelTab>(
  tabs: T[],
  opts: { enabled: boolean; enteredPtys: ReadonlySet<number>; sets: AgentSets },
): T[] {
  if (!opts.enabled) return tabs;
  const out = tabs.filter((t) => !isAgentTab(t, opts.sets) || (t.ptyId != null && opts.enteredPtys.has(t.ptyId)));
  return out.length === tabs.length ? tabs : out;
}

/**
 * Where the active tab of a dock goes when that tab closes or moves away:
 * the last visible (strip) tab other than it, never a hidden agent.
 */
export function fallbackTab<T extends ModelTab>(visible: readonly T[], leavingId: number, pick: 'first' | 'last' = 'last'): T | null {
  const rest = visible.filter((t) => t.id !== leavingId);
  if (!rest.length) return null;
  return pick === 'first' ? rest[0] : rest[rest.length - 1];
}

/** Tab navigation (⌘1-9, next/prev) walks the strip you can see, not hidden agents. */
export function stripNeighbor<T extends ModelTab>(strip: readonly T[], activeId: number | null, delta: 1 | -1): T | null {
  if (strip.length < 2 || activeId == null) return null;
  const i = strip.findIndex((t) => t.id === activeId);
  if (i < 0) return delta > 0 ? strip[0] : strip[strip.length - 1];
  return strip[(i + delta + strip.length) % strip.length];
}

export interface WallRepairInput {
  enabled: boolean;
  mode: LeeMode;
  isAgent: boolean;
  entered: boolean;
  ptyId: number | null;
  /** The tab was an own tab when last seen active and is an agent now (you ran `claude` in it). */
  becameAgent: boolean;
  /** A hold (session restore, create-tab bridge) just ended with this tab active. */
  holdEnded: boolean;
}

/**
 * What to do with an active tab that is an agent you never went into, outside
 * a user activation: 'enter' it (you started it where you work, contracts §3.6),
 * 'redirect' to an own tab (it only got active through restore or a background
 * launch), or nothing.
 */
export function wallRepair(input: WallRepairInput): 'enter' | 'redirect' | null {
  if (!input.enabled || !input.isAgent || input.ptyId == null || input.entered) return null;
  if (input.becameAgent) return 'enter';
  if (input.holdEnded && input.mode === 'workbench') return 'redirect';
  return null;
}

// ---------------------------------------------------------------------------
// Mode transitions (§3.2)
// ---------------------------------------------------------------------------

export interface ModeInput {
  enabled: boolean;
  mode: LeeMode;
}

export type ModeTrigger =
  | { kind: 'load'; enabled: boolean; defaultMode: LeeMode }
  | { kind: 'toggle' }
  | { kind: 'focus'; active: boolean }
  | { kind: 'handoff' }
  | { kind: 'return' }
  | { kind: 'go_into'; ptyId: number }
  | { kind: 'open_tab' }
  | { kind: 'tab_activated'; isAgent: boolean; isNew: boolean; ptyId: number | null; entered: boolean };

export interface ModeDecision {
  mode: LeeMode;
  reason: ModeReason | null;
  /** Add this pty to enteredPtys. */
  enter?: number;
  /** Select this agent's tile (stay in the cockpit). */
  selectTile?: number;
  /** Log cockpit.go_into for `enter`. */
  goInto?: boolean;
}

/** Decide what a trigger does. null = nothing changes. */
export function nextMode(state: ModeInput, trigger: ModeTrigger): ModeDecision | null {
  if (trigger.kind === 'load') {
    const mode: LeeMode = trigger.enabled ? trigger.defaultMode : 'workbench';
    return { mode, reason: 'default' };
  }
  if (!state.enabled) return null;
  const to = (mode: LeeMode, reason: ModeReason): ModeDecision | null =>
    mode === state.mode ? null : { mode, reason };

  switch (trigger.kind) {
    case 'toggle':
      return { mode: state.mode === 'cockpit' ? 'workbench' : 'cockpit', reason: 'manual' };
    case 'focus':
      return trigger.active ? to('workbench', 'focus_start') : to('cockpit', 'focus_end');
    case 'handoff':
      return to('cockpit', 'handoff');
    case 'return':
      return to('cockpit', 'return');
    case 'go_into':
      return { mode: 'workbench', reason: state.mode === 'workbench' ? null : 'go_into', enter: trigger.ptyId, goInto: true };
    case 'open_tab':
      return to('workbench', 'open_tab');
    case 'tab_activated': {
      const { isAgent, isNew, ptyId, entered } = trigger;
      if (state.mode === 'cockpit') {
        if (!isAgent) return { mode: 'workbench', reason: 'open_tab' };
        if (ptyId == null) return null;
        if (isNew) return { mode: 'cockpit', reason: null, selectTile: ptyId };
        return { mode: 'workbench', reason: 'go_into', enter: ptyId, goInto: true };
      }
      if (!isAgent || ptyId == null || entered) return null;
      return { mode: 'workbench', reason: null, enter: ptyId, goInto: !isNew };
    }
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
  task: CockpitTask | null;
  /** A has this PTY as an agent (check-ins possible). */
  canCheckin: boolean;
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
    return !!t && isWallExempt(t);
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

    const title = taskTitle(task) || tab?.label || agent?.label || rt?.label || `${providerName(provider)} ${ptyId}`;

    return {
      ptyId,
      tabId: tab ? tab.id : null,
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
      task,
      canCheckin: rt?.kind === 'agent' && rt.state.state !== 'exited',
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
    rows.push({
      source: 'attention',
      id: `att:${item.id}`,
      kind: attentionFeedKind(item.kind),
      severity: item.severity,
      at: item.updated_at || item.created_at,
      title: item.title,
      item,
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
  | { kind: 'section'; section: SectionId }
  | { kind: 'row'; delta: 1 | -1 }
  | { kind: 'tile'; delta: 1 | -1 }
  | { kind: 'enter' }
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'reply' }
  | { kind: 'checkin' }
  | { kind: 'launcher' }
  | { kind: 'run' }
  | { kind: 'dismiss' }
  | { kind: 'drawer' }
  | { kind: 'drawer-move'; delta: 1 | -1 }
  | { kind: 'help' }
  | { kind: 'escape' };

export interface KeyContext {
  /** Focus is in an input, textarea, select or contenteditable. */
  inInput: boolean;
  /** Focus is on a button or link: Enter and Space activate it, not the Cockpit. */
  onControl?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** The drawer has keyboard focus: ←/→ move within it. */
  drawer?: boolean;
}

export function keyAction(key: string, ctx: KeyContext): CockpitKeyAction | null {
  if (ctx.inInput || ctx.meta || ctx.ctrl || ctx.alt) return null;
  if (ctx.onControl && (key === 'Enter' || key === ' ')) return null;
  if (key >= '1' && key <= '6' && key.length === 1) return { kind: 'section', section: SECTIONS[Number(key) - 1] };
  if (ctx.drawer) {
    if (key === 'ArrowLeft' || key === 'h') return { kind: 'drawer-move', delta: -1 };
    if (key === 'ArrowRight' || key === 'l') return { kind: 'drawer-move', delta: 1 };
  }
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return { kind: 'row', delta: 1 };
    case 'k':
    case 'ArrowUp':
      return { kind: 'row', delta: -1 };
    case 'h':
    case 'ArrowLeft':
      return { kind: 'tile', delta: -1 };
    case 'l':
    case 'ArrowRight':
      return { kind: 'tile', delta: 1 };
    case 'Enter':
      return { kind: 'enter' };
    case 'a':
      return { kind: 'approve' };
    case 'd':
      return { kind: 'deny' };
    case 'r':
      return { kind: 'reply' };
    case 'c':
      return { kind: 'checkin' };
    case 'n':
      return { kind: 'launcher' };
    case 'o':
      return { kind: 'run' };
    case 'x':
      return { kind: 'dismiss' };
    case '`':
      return { kind: 'drawer' };
    case '?':
      return { kind: 'help' };
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

/** A task's display title: a user's title as given; an agent/auto title made plain. */
export function taskTitle(task: Pick<CockpitTask, 'title' | 'title_source'> | null | undefined): string {
  if (!task || !task.title || task.title === '(untitled)') return '';
  if (task.title_source === 'user') return task.title;
  return plainTitle(task.title);
}
