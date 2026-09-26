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

export function runtimeAgentPtys(tabs: readonly TabRuntimeInfo[] | null | undefined): Set<number> {
  return new Set((tabs ?? []).filter((t) => t.kind === 'agent').map((t) => t.pty_id));
}

export function isAgentTab(tab: ModelTab, sets: AgentSets): boolean {
  if (tab.type === 'agent' || tab.type === 'claude') return true;
  if (tab.ptyId == null) return false;
  return sets.snapshotAgents.has(tab.ptyId) || sets.runtimeAgents.has(tab.ptyId);
}

/** Workbench strip: own tabs plus the agent terminals you went into. Identity when the Cockpit is disabled. */
export function stripTabs<T extends ModelTab>(
  centerTabs: T[],
  opts: { enabled: boolean; enteredPtys: ReadonlySet<number>; sets: AgentSets },
): T[] {
  if (!opts.enabled) return centerTabs;
  const out = centerTabs.filter((t) => !isAgentTab(t, opts.sets) || (t.ptyId != null && opts.enteredPtys.has(t.ptyId)));
  return out.length === centerTabs.length ? centerTabs : out;
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
  summary: { text: string; label: string } | null;
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
  for (const t of input.tabs) if (t.ptyId != null && isAgentTab(t, input.sets)) add(t.ptyId);
  for (const id of agents.keys()) add(id);
  for (const r of input.runtime ?? []) {
    if (r.kind === 'agent' && r.state.state !== 'exited' && sameWorkspace(r.workspace, workspace)) add(r.pty_id);
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

    let chip: TileModel['chip'];
    let agentState: AgentState | TabRunState;
    if (needsItem) {
      chip = { label: needsItem.kind === 'approval' ? 'needs approval' : 'waiting on you', tone: 'needs' };
      agentState = 'waiting';
    } else if (agent) {
      agentState = agent.state;
      if (agent.state === 'busy') {
        const since = agent.busy_since ? Date.parse(agent.busy_since) : NaN;
        chip = { label: Number.isNaN(since) ? 'busy' : `busy ${formatDuration(now - since)}`, tone: 'busy' };
      } else if (agent.state === 'idle') chip = { label: 'idle', tone: 'idle' };
      else if (agent.state === 'waiting') chip = { label: 'waiting', tone: 'needs' };
      else chip = { label: 'unknown', tone: 'muted' };
    } else if (rt) {
      agentState = rt.state.state;
      const s = rt.state.state;
      if (s === 'busy') chip = { label: `busy ${formatDuration(now - Date.parse(rt.state.since))}`, tone: 'busy' };
      else if (s === 'idle-at-prompt') chip = { label: 'idle', tone: 'idle' };
      else if (s === 'awaiting-input') chip = { label: 'waiting on you', tone: 'needs' };
      else chip = { label: s, tone: 'muted' };
    } else {
      agentState = 'unknown';
      chip = { label: 'starting', tone: 'muted' };
    }

    const fidelity = rt?.fidelity ?? null;
    const screen = fidelity === 'screen';
    const summaryText = agent?.last_summary || task?.summary || null;
    const summary = !screen && summaryText ? { text: summaryText, label: `${providerName(provider)} says` } : null;
    const tail = screen && rt && rt.tail.length ? rt.tail : null;

    const meta: string[] = [];
    if (agent?.last_tool) meta.push(agent.last_tool);
    if (agent && agent.files_touched_count > 0) meta.push(`${agent.files_touched_count} file${agent.files_touched_count === 1 ? '' : 's'}`);
    if (task && task.busy_ms > 0) meta.push(`${formatDuration(task.busy_ms)} busy`);
    if (task && task.lead !== 'delegate') meta.push(task.lead === 'human' ? 'you lead' : 'plan');
    if (task && !task.confirmed) meta.push('unconfirmed');
    if (task?.agent?.model) meta.push(task.agent.model);
    if (screen) meta.push('screen');

    const title =
      task?.title && task.title !== '(untitled)' ? task.title : tab?.label ?? agent?.label ?? rt?.label ?? `${providerName(provider)} ${ptyId}`;

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
      title: event.text,
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
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** The drawer has keyboard focus: ←/→ move within it. */
  drawer?: boolean;
}

export function keyAction(key: string, ctx: KeyContext): CockpitKeyAction | null {
  if (ctx.inInput || ctx.meta || ctx.ctrl || ctx.alt) return null;
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

export function taskNeedsYou(task: CockpitTask): boolean {
  return task.status === 'waiting' || task.status === 'review';
}
