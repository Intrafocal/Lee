/**
 * Per-window Cockpit/Workbench mode store (contracts §3.1, §3.2), shared by
 * the overlay, the status-bar chip and App.tsx without prop drilling.
 * Transition rules live in the pure nextMode() (lib/cockpitModel.ts).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AgentState, AttentionSnapshot } from '../../../shared/copilot';
import type { AboutRef, DeepView, GoIntoFrom, LeeMode, ModeReason, TabRunState } from '../../../shared/cockpit';
import {
  agentPtysFromSnapshot,
  isAgentTab as isAgentTabPure,
  nextMode,
  DEFAULT_SECTION,
  SECTIONS,
  stripTabs as stripTabsPure,
  wallRepair,
  type AgentSets,
  type ModelTab,
  type ModeDecision,
  type ModeTrigger,
  type SectionId,
} from '../../lib/cockpitModel';

export type { SectionId };

export interface CockpitSelection {
  kind: 'tile' | 'feed' | 'row' | 'drawer';
  id: string;
}

export interface CockpitModeState {
  enabled: boolean;
  /** configure() has run (config and the cockpit API were checked). */
  configured: boolean;
  mode: LeeMode;
  reason: ModeReason;
  since: number;
  section: SectionId;
  enteredPtys: ReadonlySet<number>;
  selected: CockpitSelection | null;
  /** pty ids A reports as agents (TabRuntimeInfo.kind), fed by CockpitHost. */
  runtimeAgents: ReadonlySet<number>;
  /** Per agent pty: what it runs and its session name (TabRuntimeInfo), for tab icons and labels. */
  tabDisplay: ReadonlyMap<number, TabDisplayInfo>;
  /** Needs-you Feed count, for the workbench chip. */
  needsCount: number;
  /** Bumped when a hold() ends, so the wall re-checks the active tabs. */
  holdEpoch: number;
  /** This window's Deep memory (Deep D1 §14): the open exploration and view. */
  deep: DeepNav;
}

/** What Deep shows in this window (Deep D1 §4.4). */
export interface DeepNav {
  exploration_id: string | null;
  title: string;
  view: DeepView;
}

/** What the tab strip shows for an agent pty: its provider (icon) and session name (label). */
export interface TabDisplayInfo {
  provider: string | null;
  name: string | null;
}

type Listener = () => void;

let state: CockpitModeState = {
  enabled: false,
  configured: false,
  mode: 'manual',
  reason: 'default',
  since: Date.now(),
  section: DEFAULT_SECTION,
  enteredPtys: new Set(),
  selected: null,
  runtimeAgents: new Set(),
  tabDisplay: new Map(),
  needsCount: 0,
  holdEpoch: 0,
  deep: { exploration_id: null, title: '', view: 'page' },
};

const listeners = new Set<Listener>();
/** A Deep focus session is active in this window's workspace (fed by useCockpitMode). */
let deepSessionActive = false;
const endSessionListeners = new Set<() => void>();
const focusOpenerListeners = new Set<() => void>();
let holdUntil = 0;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** Tab ids whose next activation Lee made, not you (close/dock fallbacks, wall redirects). */
const quietTabs = new Map<number, number>();
let sectionWorkspace = '';

/** The part of the state App.tsx depends on; a new object only when one of these changes. */
export type CockpitWallState = Pick<
  CockpitModeState,
  'enabled' | 'configured' | 'mode' | 'reason' | 'since' | 'enteredPtys' | 'runtimeAgents' | 'holdEpoch'
>;

function wallOf(s: CockpitModeState): CockpitWallState {
  return {
    enabled: s.enabled,
    configured: s.configured,
    mode: s.mode,
    reason: s.reason,
    since: s.since,
    enteredPtys: s.enteredPtys,
    runtimeAgents: s.runtimeAgents,
    holdEpoch: s.holdEpoch,
  };
}

let wall: CockpitWallState = wallOf(state);

function emit(next: Partial<CockpitModeState>): void {
  state = { ...state, ...next };
  const w = wall;
  if (
    w.enabled !== state.enabled ||
    w.configured !== state.configured ||
    w.mode !== state.mode ||
    w.enteredPtys !== state.enteredPtys ||
    w.runtimeAgents !== state.runtimeAgents ||
    w.holdEpoch !== state.holdEpoch
  ) {
    wall = wallOf(state);
  }
  listeners.forEach((l) => l());
}

function logMode(from: LeeMode, to: LeeMode, reason: ModeReason): void {
  try {
    window.lee?.cockpit?.logEvent({ type: 'cockpit.mode', data: { from, to, reason } });
  } catch {
    /* cockpit IPC not available */
  }
}

function sectionKey(workspace: string): string {
  return `lee:cockpit:${workspace}:section`;
}

function readSection(workspace: string): SectionId {
  try {
    const v = window.localStorage.getItem(sectionKey(workspace));
    if (v && (SECTIONS as readonly string[]).includes(v)) return v as SectionId;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SECTION;
}

function blurActive(): void {
  if (typeof document === 'undefined') return;
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}

function displayEqual(a: ReadonlyMap<number, TabDisplayInfo>, b: ReadonlyMap<number, TabDisplayInfo>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.provider !== v.provider || w.name !== v.name) return false;
  }
  return true;
}

function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function logGoInto(ptyId: number, agentState: AgentState | TabRunState, from: GoIntoFrom): void {
  try {
    window.lee?.cockpit?.logEvent({
      type: 'cockpit.go_into',
      data: { pty_id: ptyId, agent_state: agentState, from },
    });
  } catch {
    /* cockpit IPC not available */
  }
}

const launcherListeners = new Set<() => void>();

/**
 * A steward request from outside the Cockpit's own sections (the status-bar
 * lint flyout, a lint fix's renderer_action): ask about an item, run What
 * next?, or open a task's goal picker (v4 §8.5).
 */
export type StewardRequest =
  | { kind: 'ask'; about: AboutRef; question?: string }
  | { kind: 'what-next' }
  | { kind: 'link-goal'; taskId: string };

const stewardListeners = new Set<(req: StewardRequest) => void>();

export const cockpitModeStore = {
  /**
   * Show the Cockpit on the right section and hand the request to it. False
   * when no Cockpit can take it (disabled, or not mounted).
   */
  requestSteward(req: StewardRequest): boolean {
    if (!state.enabled || !stewardListeners.size) return false;
    if (state.mode !== 'cockpit') cockpitModeStore.set('cockpit', 'manual');
    cockpitModeStore.setSection(req.kind === 'link-goal' ? 'tasks' : 'copilot');
    for (const fn of stewardListeners) fn(req);
    return true;
  },
  onStewardRequest(fn: (req: StewardRequest) => void): () => void {
    stewardListeners.add(fn);
    return () => {
      stewardListeners.delete(fn);
    };
  },
  get(): CockpitModeState {
    return state;
  },
  /**
   * ⌘N (File > New File) while the Cockpit is showing opens its Launcher
   * instead. Returns false when no Cockpit is showing to take it, so the
   * caller falls back to a new untitled file.
   */
  requestLauncher(): boolean {
    if (!state.enabled || state.mode !== 'cockpit' || !launcherListeners.size) return false;
    for (const fn of launcherListeners) fn();
    return true;
  },
  onLauncherRequest(fn: () => void): () => void {
    launcherListeners.add(fn);
    return () => {
      launcherListeners.delete(fn);
    };
  },
  getWall(): CockpitWallState {
    return wall;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  set(mode: LeeMode, reason: ModeReason): void {
    if (mode === state.mode) return;
    if (mode === 'cockpit' && !state.enabled) return;
    const from = state.mode;
    if (mode === 'cockpit') blurActive();
    emit({ mode, reason, since: Date.now() });
    logMode(from, mode, reason);
  },
  toggle(reason: ModeReason): void {
    const d = nextMode(state, { kind: 'toggle' });
    if (d) cockpitModeStore.set(d.mode, reason);
  },
  enter(ptyId: number): void {
    if (state.enteredPtys.has(ptyId)) return;
    const next = new Set(state.enteredPtys);
    next.add(ptyId);
    emit({ enteredPtys: next });
  },
  forget(ptyId: number): void {
    if (!state.enteredPtys.has(ptyId)) return;
    const next = new Set(state.enteredPtys);
    next.delete(ptyId);
    emit({ enteredPtys: next });
  },
  select(sel: CockpitSelection | null): void {
    if (sel === state.selected || (sel && state.selected && sel.kind === state.selected.kind && sel.id === state.selected.id)) return;
    emit({ selected: sel });
  },
  setSection(section: SectionId): void {
    if (section === state.section) return;
    try {
      if (sectionWorkspace) window.localStorage.setItem(sectionKey(sectionWorkspace), section);
    } catch {
      /* storage unavailable */
    }
    emit({ section, selected: null });
  },
  /** Load the remembered section for this window's workspace. */
  useWorkspace(workspace: string): void {
    if (workspace === sectionWorkspace) return;
    sectionWorkspace = workspace;
    emit({ section: readSection(workspace) });
  },
  /** First call applies the default mode; later calls react only to enabled flipping. */
  configure(enabled: boolean, defaultMode: LeeMode): void {
    if (state.configured && enabled === state.enabled) return;
    const first = !state.configured;
    const d = nextMode(state, { kind: 'load', enabled, defaultMode });
    if (!d) return;
    emit({ enabled, configured: true });
    if (first || !enabled) {
      if (d.mode !== state.mode) {
        const from = state.mode;
        if (d.mode === 'cockpit') blurActive();
        emit({ mode: d.mode, reason: 'default', since: Date.now() });
        logMode(from, d.mode, 'default');
      }
    }
    cockpitModeStore.hold(4000);
  },
  setRuntimeAgents(ptys: ReadonlySet<number>): void {
    if (setsEqual(ptys, state.runtimeAgents)) return;
    emit({ runtimeAgents: ptys });
  },
  setTabDisplay(next: ReadonlyMap<number, TabDisplayInfo>): void {
    if (displayEqual(next, state.tabDisplay)) return;
    emit({ tabDisplay: next });
  },
  setNeedsCount(n: number): void {
    if (n !== state.needsCount) emit({ needsCount: n });
  },
  /** Ignore tab activations for a while (session restore, tabs the create-tab bridge opens). */
  hold(ms: number): void {
    holdUntil = Math.max(holdUntil, Date.now() + ms);
    if (holdTimer != null) clearTimeout(holdTimer);
    const fire = () => {
      holdTimer = null;
      const left = holdUntil - Date.now();
      if (left > 0) {
        holdTimer = setTimeout(fire, left + 10);
        return;
      }
      emit({ holdEpoch: state.holdEpoch + 1 });
    };
    holdTimer = setTimeout(fire, holdUntil - Date.now() + 10);
  },
  holding(): boolean {
    return Date.now() < holdUntil;
  },
  /** The next activation of this tab is Lee's doing (a fallback after a close), not a go-into or an open. */
  quiet(tabId: number): void {
    quietTabs.set(tabId, Date.now() + 1000);
  },
  /** Consume a quiet() mark. */
  takeQuiet(tabId: number): boolean {
    const until = quietTabs.get(tabId);
    quietTabs.delete(tabId);
    return until != null && Date.now() < until;
  },
  /** Apply a nextMode() decision: mode, entered set, tile selection, go_into log. */
  apply(d: ModeDecision | null, goIntoInfo?: { agentState: AgentState | TabRunState; from: GoIntoFrom }): void {
    if (!d) return;
    if (d.enter != null) {
      cockpitModeStore.enter(d.enter);
      if (d.goInto && goIntoInfo) logGoInto(d.enter, goIntoInfo.agentState, goIntoInfo.from);
    }
    if (d.selectTile != null) cockpitModeStore.select({ kind: 'tile', id: String(d.selectTile) });
    if (d.reason) cockpitModeStore.set(d.mode, d.reason);
  },
  decide(trigger: ModeTrigger): ModeDecision | null {
    return nextMode(state, trigger);
  },
  /** Remember the exploration and show it in Deep (reason 'hop' when a Deep session is already active). */
  openDeep(exploration_id: string, title: string): void {
    const d = state.deep;
    if (d.exploration_id !== exploration_id || d.title !== title) {
      emit({ deep: { exploration_id, title, view: d.exploration_id === exploration_id ? d.view : 'page' } });
    }
    if (!state.enabled) return;
    cockpitModeStore.set('deep', deepSessionActive ? 'hop' : 'deep_start');
  },
  /** This window's Deep memory. */
  getDeep(): DeepNav {
    return state.deep;
  },
  /** The mode chip's "End session": the Deep surface opens the ending ritual. */
  requestEndSession(): void {
    for (const fn of endSessionListeners) fn();
  },
  onEndSessionRequest(cb: () => void): () => void {
    endSessionListeners.add(cb);
    return () => {
      endSessionListeners.delete(cb);
    };
  },
  /** Show the Cockpit on Copilot and focus the opener's field (Go deep with nothing open). */
  focusOpener(): void {
    if (!state.enabled) return;
    if (state.mode !== 'cockpit') cockpitModeStore.set('cockpit', 'manual');
    cockpitModeStore.setSection('copilot');
    for (const fn of focusOpenerListeners) fn();
  },
  onFocusOpener(cb: () => void): () => void {
    focusOpenerListeners.add(cb);
    return () => {
      focusOpenerListeners.delete(cb);
    };
  },
};

function getTabDisplay(): ReadonlyMap<number, TabDisplayInfo> {
  return state.tabDisplay;
}

/** Agent ptys' provider and session name (a new Map only when one changes). */
export function useCockpitTabDisplay(): ReadonlyMap<number, TabDisplayInfo> {
  return useSyncExternalStore(cockpitModeStore.subscribe, getTabDisplay, getTabDisplay);
}

export function useCockpitModeState(): CockpitModeState {
  return useSyncExternalStore(cockpitModeStore.subscribe, cockpitModeStore.get, cockpitModeStore.get);
}

export type Dock = 'center' | 'left' | 'right' | 'bottom';

export interface UseCockpitModeOptions {
  workspace: string;
  snapshot: AttentionSnapshot | null;
  activeTabId: number | null;
  /** Active tabs of the side panels: agents docked there are behind the wall too (user decision 2026-09-25). */
  sideActiveTabIds?: { left: number | null; right: number | null; bottom: number | null };
  tabs: readonly ModelTab[];
  /** Make this tab active in its dock (used to move off a hidden agent after a restore). */
  activate?: (tabId: number) => void;
}

export interface CockpitModeHandle {
  state: CockpitWallState;
  sets: AgentSets;
  /** The tabs of one dock you can see in the workbench (center strip or a side panel). */
  stripTabs: <T extends ModelTab>(dockTabs: T[]) => T[];
  isAgentTab: (tab: ModelTab) => boolean;
}

function dockOf(tab: ModelTab): Dock {
  const d = tab.dockPosition;
  return d === 'left' || d === 'right' || d === 'bottom' ? d : 'center';
}

/** Subscribes to the store, wires the automatic transitions (§3.2) and returns the wall helpers. */
export function useCockpitMode(opts: UseCockpitModeOptions): CockpitModeHandle {
  const s = useSyncExternalStore(cockpitModeStore.subscribe, cockpitModeStore.getWall, cockpitModeStore.getWall);
  const { workspace, snapshot, activeTabId, tabs } = opts;
  const activeLeft = opts.sideActiveTabIds?.left ?? null;
  const activeRight = opts.sideActiveTabIds?.right ?? null;
  const activeBottom = opts.sideActiveTabIds?.bottom ?? null;
  const activateRef = useRef(opts.activate);
  activateRef.current = opts.activate;

  useEffect(() => {
    if (workspace) cockpitModeStore.useWorkspace(workspace);
  }, [workspace]);

  const agentKey = Array.from(agentPtysFromSnapshot(snapshot)).sort((a, b) => a - b).join(',');
  const snapshotAgents = useMemo(() => new Set(agentKey ? agentKey.split(',').map(Number) : []), [agentKey]);
  const sets = useMemo<AgentSets>(() => ({ snapshotAgents, runtimeAgents: s.runtimeAgents }), [snapshotAgents, s.runtimeAgents]);

  const deepActive = !!snapshot?.focus.active && snapshot.focus.source === 'deep';
  useEffect(() => {
    deepSessionActive = deepActive;
  }, [deepActive]);

  const focusActive = snapshot ? snapshot.focus.active : null;
  const prevFocus = useRef<boolean | null>(null);
  useEffect(() => {
    if (focusActive == null) return;
    const prev = prevFocus.current;
    prevFocus.current = focusActive;
    if (prev == null || prev === focusActive) return;
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'focus', active: focusActive }));
  }, [focusActive]);

  const awayActive = snapshot ? snapshot.away.active : null;
  const prevAway = useRef<boolean | null>(null);
  useEffect(() => {
    if (awayActive == null) return;
    const prev = prevAway.current;
    prevAway.current = awayActive;
    if (prev === false && awayActive) cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'handoff' }));
  }, [awayActive]);

  // "New" = the tab id did not exist 2 s earlier.
  const firstSeen = useRef(new Map<number, number>());
  const tabCount = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const ids = new Set<number>();
    for (const t of tabs) {
      ids.add(t.id);
      if (!firstSeen.current.has(t.id)) firstSeen.current.set(t.id, now);
    }
    for (const id of Array.from(firstSeen.current.keys())) if (!ids.has(id)) firstSeen.current.delete(id);
    // Session restore opens tabs one by one; keep holding while it does.
    if (tabs.length > tabCount.current && cockpitModeStore.holding()) cockpitModeStore.hold(1500);
    tabCount.current = tabs.length;
    const alive = new Set(tabs.map((t) => t.ptyId).filter((p): p is number => p != null));
    for (const p of cockpitModeStore.get().enteredPtys) if (!alive.has(p)) cockpitModeStore.forget(p);
  }, [tabs]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const setsRef = useRef(sets);
  setsRef.current = sets;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Whether each tab was an agent when last seen active (to spot a terminal that becomes one).
  const agentWhenSeen = useRef(new Map<number, boolean>());
  // The last own tab you had active per dock, where a wall redirect goes.
  const lastOwn = useRef(new Map<Dock, number>());

  const onActivated = (tabId: number | null, dock: Dock) => {
    if (tabId == null) return;
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab || dockOf(tab) !== dock) return;
    const isAgent = isAgentTabPure(tab, setsRef.current);
    agentWhenSeen.current.set(tab.id, isAgent);
    if (!isAgent) lastOwn.current.set(dock, tab.id);
    const quiet = cockpitModeStore.takeQuiet(tab.id);
    const st = cockpitModeStore.get();
    if (!st.enabled || quiet || cockpitModeStore.holding()) return;
    // Side panels never switched modes for own tabs; only their agents go through the wall.
    if (dock !== 'center' && !isAgent) return;
    const seen = firstSeen.current.get(tab.id) ?? Date.now();
    const isNew = Date.now() - seen < 2000;
    const d = nextMode(st, {
      kind: 'tab_activated',
      isAgent,
      isNew,
      ptyId: tab.ptyId,
      entered: tab.ptyId != null && st.enteredPtys.has(tab.ptyId),
    });
    const agent = snapshotRef.current?.agents?.find((x) => x.pty_id === tab.ptyId);
    cockpitModeStore.apply(d, { agentState: agent?.state ?? 'unknown', from: 'hotkey' });
  };
  const onActivatedRef = useRef(onActivated);
  onActivatedRef.current = onActivated;

  useEffect(() => onActivatedRef.current(activeTabId, 'center'), [activeTabId]);
  useEffect(() => onActivatedRef.current(activeLeft, 'left'), [activeLeft]);
  useEffect(() => onActivatedRef.current(activeRight, 'right'), [activeRight]);
  useEffect(() => onActivatedRef.current(activeBottom, 'bottom'), [activeBottom]);

  const activeIdsRef = useRef<Array<[number | null, Dock]>>([]);
  activeIdsRef.current = [
    [activeTabId, 'center'],
    [activeLeft, 'left'],
    [activeRight, 'right'],
    [activeBottom, 'bottom'],
  ];

  // Re-check the active tabs when the agent sets change (a terminal you are
  // in became an agent) or when a hold ends (session restore, background launch).
  const lastHoldEpoch = useRef(s.holdEpoch);
  useEffect(() => {
    const holdEnded = s.holdEpoch !== lastHoldEpoch.current;
    lastHoldEpoch.current = s.holdEpoch;
    const st = cockpitModeStore.get();
    for (const [id, dock] of activeIdsRef.current) {
      if (id == null) continue;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || dockOf(tab) !== dock) continue;
      const isAgent = isAgentTabPure(tab, sets);
      const was = agentWhenSeen.current.get(tab.id);
      if (cockpitModeStore.holding()) continue;
      agentWhenSeen.current.set(tab.id, isAgent);
      const action = wallRepair({
        enabled: st.enabled,
        mode: st.mode,
        isAgent,
        entered: tab.ptyId != null && st.enteredPtys.has(tab.ptyId),
        ptyId: tab.ptyId,
        becameAgent: was === false && isAgent,
        holdEnded,
      });
      if (action === 'enter' && tab.ptyId != null) {
        cockpitModeStore.enter(tab.ptyId);
      } else if (action === 'redirect') {
        const visible = stripTabsPure(
          tabsRef.current.filter((t) => dockOf(t) === dock),
          { enabled: st.enabled, enteredPtys: st.enteredPtys, sets },
        );
        const remembered = lastOwn.current.get(dock);
        const target = visible.find((t) => t.id === remembered) ?? visible[visible.length - 1];
        if (target && activateRef.current) {
          cockpitModeStore.quiet(target.id);
          activateRef.current(target.id);
        }
        // No visible tab in that dock: the agent stays hidden.
      }
    }
  }, [sets, s.holdEpoch]);

  return useMemo<CockpitModeHandle>(
    () => ({
      state: s,
      sets,
      stripTabs: <T extends ModelTab>(dockTabs: T[]) =>
        stripTabsPure(dockTabs, { enabled: s.enabled, enteredPtys: s.enteredPtys, sets }),
      isAgentTab: (tab: ModelTab) => isAgentTabPure(tab, sets),
    }),
    [s, sets],
  );
}
