/**
 * Per-window Cockpit/Workbench mode store (contracts §3.1, §3.2), shared by
 * the overlay, the status-bar chip and App.tsx without prop drilling.
 * Transition rules live in the pure nextMode() (lib/cockpitModel.ts).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AgentState, AttentionSnapshot } from '../../../shared/copilot';
import type { GoIntoFrom, LeeMode, ModeReason, TabRunState } from '../../../shared/cockpit';
import {
  agentPtysFromSnapshot,
  isAgentTab as isAgentTabPure,
  nextMode,
  SECTIONS,
  stripTabs as stripTabsPure,
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
  /** Needs-you Feed count, for the workbench chip. */
  needsCount: number;
}

type Listener = () => void;

let state: CockpitModeState = {
  enabled: false,
  configured: false,
  mode: 'workbench',
  reason: 'default',
  since: Date.now(),
  section: 'feed',
  enteredPtys: new Set(),
  selected: null,
  runtimeAgents: new Set(),
  needsCount: 0,
};

const listeners = new Set<Listener>();
let holdUntil = 0;
let sectionWorkspace = '';

/** The part of the state App.tsx depends on; a new object only when one of these changes. */
export type CockpitWallState = Pick<CockpitModeState, 'enabled' | 'configured' | 'mode' | 'reason' | 'since' | 'enteredPtys' | 'runtimeAgents'>;

function wallOf(s: CockpitModeState): CockpitWallState {
  return {
    enabled: s.enabled,
    configured: s.configured,
    mode: s.mode,
    reason: s.reason,
    since: s.since,
    enteredPtys: s.enteredPtys,
    runtimeAgents: s.runtimeAgents,
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
    w.runtimeAgents !== state.runtimeAgents
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
  return 'feed';
}

function blurActive(): void {
  if (typeof document === 'undefined') return;
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
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

export const cockpitModeStore = {
  get(): CockpitModeState {
    return state;
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
  setNeedsCount(n: number): void {
    if (n !== state.needsCount) emit({ needsCount: n });
  },
  /** Ignore tab activations for a while (session restore, tabs the create-tab bridge opens). */
  hold(ms: number): void {
    holdUntil = Math.max(holdUntil, Date.now() + ms);
  },
  holding(): boolean {
    return Date.now() < holdUntil;
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
};

export function useCockpitModeState(): CockpitModeState {
  return useSyncExternalStore(cockpitModeStore.subscribe, cockpitModeStore.get, cockpitModeStore.get);
}

export interface UseCockpitModeOptions {
  workspace: string;
  snapshot: AttentionSnapshot | null;
  activeTabId: number | null;
  tabs: readonly ModelTab[];
}

export interface CockpitModeHandle {
  state: CockpitWallState;
  sets: AgentSets;
  stripTabs: <T extends ModelTab>(centerTabs: T[]) => T[];
  isAgentTab: (tab: ModelTab) => boolean;
}

/** Subscribes to the store, wires the automatic transitions (§3.2) and returns the wall helpers. */
export function useCockpitMode(opts: UseCockpitModeOptions): CockpitModeHandle {
  const s = useSyncExternalStore(cockpitModeStore.subscribe, cockpitModeStore.getWall, cockpitModeStore.getWall);
  const { workspace, snapshot, activeTabId, tabs } = opts;

  useEffect(() => {
    if (workspace) cockpitModeStore.useWorkspace(workspace);
  }, [workspace]);

  const agentKey = Array.from(agentPtysFromSnapshot(snapshot)).sort((a, b) => a - b).join(',');
  const snapshotAgents = useMemo(() => new Set(agentKey ? agentKey.split(',').map(Number) : []), [agentKey]);
  const sets = useMemo<AgentSets>(() => ({ snapshotAgents, runtimeAgents: s.runtimeAgents }), [snapshotAgents, s.runtimeAgents]);

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

  useEffect(() => {
    if (activeTabId == null) return;
    const st = cockpitModeStore.get();
    if (!st.enabled || cockpitModeStore.holding()) return;
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (!tab || (tab.dockPosition && tab.dockPosition !== 'center')) return;
    const isAgent = isAgentTabPure(tab, setsRef.current);
    const seen = firstSeen.current.get(tab.id) ?? Date.now();
    const isNew = Date.now() - seen < 2000;
    const d = nextMode(st, {
      kind: 'tab_activated',
      isAgent,
      isNew,
      ptyId: tab.ptyId,
      entered: tab.ptyId != null && st.enteredPtys.has(tab.ptyId),
    });
    const agent = snapshotRef.current?.agents?.find((a) => a.pty_id === tab.ptyId);
    cockpitModeStore.apply(d, { agentState: agent?.state ?? 'unknown', from: 'hotkey' });
  }, [activeTabId]);

  return useMemo<CockpitModeHandle>(
    () => ({
      state: s,
      sets,
      stripTabs: <T extends ModelTab>(centerTabs: T[]) =>
        stripTabsPure(centerTabs, { enabled: s.enabled, enteredPtys: s.enteredPtys, sets }),
      isAgentTab: (tab: ModelTab) => isAgentTabPure(tab, sets),
    }),
    [s, sets],
  );
}
