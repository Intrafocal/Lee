/**
 * Per-window Cockpit / Deep / Manual mode store (contracts §3.1, §3.2; Deep
 * D1 §1.2), shared by the overlays, the status-bar chip, the ⌘0 switcher and
 * App.tsx without prop drilling. Transition rules live in the pure nextMode()
 * and switcherStep() (lib/cockpitModel.ts).
 *
 * Cockpit and Deep are overlays that never show an agent terminal; Manual is
 * the full tab layout with nothing hidden (D1 §1.4: the wall is gone).
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AgentState, AttentionSnapshot, CopilotAPI } from '../../../shared/copilot';
import type { AboutRef, DeepView, GoIntoFrom, LeeMode, ModeReason, StewardAnswer, TabRunState } from '../../../shared/cockpit';
import {
  agentPtysFromSnapshot,
  deepSessionOf,
  isAgentTab as isAgentTabPure,
  nextMode,
  switcherStep,
  DEFAULT_SECTION,
  SWITCHER_HOLD_MS,
  SWITCHER_IDLE,
  type AgentSets,
  type ModelTab,
  type ModeDecision,
  type ModeTrigger,
  type SectionId,
  type SwitcherEvent,
  type SwitcherState,
} from '../../lib/cockpitModel';
import { untitledTitle } from '../../lib/deepModel';
import { isDraftId, newDraft } from '../../lib/hesterDeep';

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
  /** The mode before this one: the switcher's quick tap goes back to it. */
  lastMode: LeeMode;
  /** Cockpit's memory: the section it shows. */
  section: SectionId;
  selected: CockpitSelection | null;
  /** pty ids A reports as agents (TabRuntimeInfo.kind), fed by CockpitHost. */
  runtimeAgents: ReadonlySet<number>;
  /** Per agent pty: what it runs and its session name (TabRuntimeInfo), for tab icons and labels. */
  tabDisplay: ReadonlyMap<number, TabDisplayInfo>;
  /** Needs-you Feed count, for the chip and the switcher's Cockpit card. */
  needsCount: number;
  /** Tabs open in this window, for the switcher's Manual card. */
  tabCount: number;
  /** A Deep focus session is active in this window's workspace (fed by useCockpitMode). */
  deepActive: boolean;
  /** The exploration that session is on (null: Deep with nothing open yet). */
  deepSessionExploration: string | null;
  /** This window's Deep memory (Deep D1 §14): the open exploration and view. */
  deep: DeepNav;
  /** The ⌘0 switcher (D1 §1.3). */
  switcher: SwitcherState;
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

const NO_DEEP: DeepNav = { exploration_id: null, title: '', view: 'page' };

let state: CockpitModeState = {
  enabled: false,
  configured: false,
  mode: 'cockpit',
  reason: 'default',
  since: Date.now(),
  lastMode: 'cockpit',
  section: DEFAULT_SECTION,
  selected: null,
  runtimeAgents: new Set(),
  tabDisplay: new Map(),
  needsCount: 0,
  tabCount: 0,
  deepActive: false,
  deepSessionExploration: null,
  deep: NO_DEEP,
  switcher: SWITCHER_IDLE,
};

const listeners = new Set<Listener>();
const endSessionListeners = new Set<() => void>();
const focusOpenerListeners = new Set<() => void>();
/** focusOpener() ran and no opener has taken the focus yet (it mounts after the switch). */
let openerPending = false;
let workspaceKey = '';
let switcherTimer: ReturnType<typeof setTimeout> | null = null;

/** The part of the state App.tsx depends on; a new object only when one of these changes. */
export type CockpitViewState = Pick<CockpitModeState, 'enabled' | 'configured' | 'mode' | 'reason' | 'since' | 'deep' | 'deepActive'>;

function viewOf(s: CockpitModeState): CockpitViewState {
  return {
    enabled: s.enabled,
    configured: s.configured,
    mode: s.mode,
    reason: s.reason,
    since: s.since,
    deep: s.deep,
    deepActive: s.deepActive,
  };
}

let view: CockpitViewState = viewOf(state);

function emit(next: Partial<CockpitModeState>): void {
  state = { ...state, ...next };
  const v = view;
  if (
    v.enabled !== state.enabled ||
    v.configured !== state.configured ||
    v.mode !== state.mode ||
    v.deep !== state.deep ||
    v.deepActive !== state.deepActive
  ) {
    view = viewOf(state);
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

function logSwitcher(from: LeeMode, to: LeeMode, via: 'tap' | 'overlay' | 'chip'): void {
  try {
    window.lee?.cockpit?.logEvent({ type: 'deep.switcher', data: { from, to, via } });
  } catch {
    /* cockpit IPC not available */
  }
}

function deepKey(workspace: string): string {
  return `lee:deep:${workspace}`;
}

/** This window's Deep memory for a workspace, restored on app restart (D1 §4.4). */
function readDeep(workspace: string): DeepNav {
  try {
    const raw = window.localStorage.getItem(deepKey(workspace));
    if (!raw) return NO_DEEP;
    const v = JSON.parse(raw) as Partial<DeepNav>;
    if (typeof v.exploration_id !== 'string' || !v.exploration_id) return NO_DEEP;
    return { exploration_id: v.exploration_id, title: typeof v.title === 'string' ? v.title : '', view: 'page' };
  } catch {
    return NO_DEEP;
  }
}

function writeDeep(workspace: string, deep: DeepNav): void {
  if (!workspace) return;
  try {
    // The Deep surface keeps its per-exploration cursors in the same record
    // (deepBridge.rememberCursor); keep whatever else is there.
    const raw = window.localStorage.getItem(deepKey(workspace));
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(deepKey(workspace), JSON.stringify({ ...prev, ...deep }));
  } catch {
    /* storage unavailable */
  }
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

/** Hand the opener its focus once one is mounted and the Cockpit shows. */
function flushOpener(): void {
  if (!openerPending) return;
  if (!state.enabled || state.mode !== 'cockpit') {
    openerPending = false;
    return;
  }
  if (!focusOpenerListeners.size) return;
  openerPending = false;
  for (const fn of focusOpenerListeners) fn();
}

/**
 * Deep was entered on the remembered exploration (⇧⌘0, the switcher, ⌘1)
 * with no Deep session running (after "Stay open" or a restart): start one,
 * so the Page never shows without attention policy 'none' behind it (D1 §0,
 * §2). A session started elsewhere arrives through the snapshot as usual.
 */
function startDeepIfNone(): void {
  const d = state.deep;
  if (state.deepActive || !d.exploration_id) return;
  let api: CopilotAPI | undefined;
  try {
    api = window.lee?.copilot;
  } catch {
    /* no Electron */
  }
  if (!api) return;
  void api
    .deepStart({ workspace: workspaceKey, exploration_id: d.exploration_id, title: d.title, surface: 'lee' })
    .catch(() => {});
}

const launcherListeners = new Set<() => void>();

/**
 * A steward request from outside the Cockpit's own sections (the status-bar
 * lint flyout, a lint fix's renderer_action): ask about an item, run What
 * next?, or open a task's goal picker (v4 §8.5).
 */
export type StewardRequest =
  | { kind: 'ask'; about: AboutRef; question?: string }
  /** An answer the palette already has (§6.2): Home shows it, proposals and all, without asking again. */
  | { kind: 'answer'; answer: StewardAnswer; question: string }
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
    cockpitModeStore.setSection(req.kind === 'link-goal' ? 'work' : 'home');
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
  getView(): CockpitViewState {
    return view;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  set(mode: LeeMode, reason: ModeReason): void {
    if (mode === state.mode) return;
    // No Cockpit means Manual only: Deep is unavailable too (D1 §1.1).
    if (mode !== 'manual' && !state.enabled) return;
    const from = state.mode;
    if (mode !== 'manual') blurActive();
    emit({ mode, reason, since: Date.now(), lastMode: from });
    logMode(from, mode, reason);
  },
  /** ⇧⌘0: Cockpit ↔ Deep (from Manual, to Deep). */
  toggleDeep(): void {
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'toggle_deep' }));
  },
  /** ⌥⌘0: Cockpit ↔ Manual (from Deep, to Manual). */
  toggleManual(): void {
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'toggle_manual' }));
  },
  select(sel: CockpitSelection | null): void {
    if (sel === state.selected || (sel && state.selected && sel.kind === state.selected.kind && sel.id === state.selected.id)) return;
    emit({ selected: sel });
  },
  /** Cockpit's section memory lasts the session; every app start lands on Home (D1 §8.3). */
  setSection(section: SectionId): void {
    if (section === state.section) return;
    emit({ section, selected: null });
  },
  /** Load this window's Deep memory for the workspace. */
  useWorkspace(workspace: string): void {
    if (workspace === workspaceKey) return;
    workspaceKey = workspace;
    emit({ deep: readDeep(workspace) });
  },
  /** First call lands the window (Cockpit, or Manual when the Cockpit is off); later calls react only to enabled flipping. */
  configure(enabled: boolean): void {
    if (state.configured && enabled === state.enabled) return;
    const first = !state.configured;
    const d = nextMode(state, { kind: 'load', enabled });
    if (!d) return;
    emit({ enabled, configured: true });
    if (first || !enabled) {
      if (d.mode !== state.mode) {
        const from = state.mode;
        if (d.mode === 'cockpit') blurActive();
        emit({ mode: d.mode, reason: 'default', since: Date.now(), lastMode: from });
        logMode(from, d.mode, 'default');
      }
      if (first && d.mode === 'cockpit') emit({ section: DEFAULT_SECTION });
    }
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
  setTabCount(n: number): void {
    if (n !== state.tabCount) emit({ tabCount: n });
  },
  /** Apply a nextMode() decision: mode, go_into log, the opener. */
  apply(d: ModeDecision | null, goIntoInfo?: { agentState: AgentState | TabRunState; from: GoIntoFrom }): void {
    if (!d) return;
    if (d.goInto != null && goIntoInfo) logGoInto(d.goInto, goIntoInfo.agentState, goIntoInfo.from);
    const from = state.mode;
    if (d.reason) cockpitModeStore.set(d.mode, d.reason);
    if (d.opener) cockpitModeStore.focusOpener();
    if (d.blank) void openBlankDeep();
    if (from !== 'deep' && state.mode === 'deep') startDeepIfNone();
  },
  decide(trigger: ModeTrigger): ModeDecision | null {
    return nextMode(
      { enabled: state.enabled, mode: state.mode, deepActive: state.deepActive, hasExploration: !!state.deep.exploration_id },
      trigger,
    );
  },
  /**
   * Feed the ⌘0 switcher (D1 §1.3). Keydown/keyup wiring lives in App and
   * ModeSwitcher; the rules live in switcherStep().
   */
  switcher(ev: SwitcherEvent): void {
    if (!state.enabled) return;
    const was = state.switcher;
    const step = switcherStep(was, ev);
    if (step.state !== was) emit({ switcher: step.state });
    if (step.state.phase === 'pending' && was.phase !== 'pending') {
      if (switcherTimer != null) clearTimeout(switcherTimer);
      switcherTimer = setTimeout(() => {
        switcherTimer = null;
        cockpitModeStore.switcher({ kind: 'tick', now: Date.now() });
      }, SWITCHER_HOLD_MS);
    } else if (step.state.phase !== 'pending' && switcherTimer != null) {
      clearTimeout(switcherTimer);
      switcherTimer = null;
    }
    if (step.commit) {
      const from = state.mode;
      cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'switcher', to: step.commit.to }));
      if (state.mode !== from) logSwitcher(from, state.mode, step.commit.via);
    }
  },
  /** Remember the exploration and show it in Deep (reason 'hop' when a Deep session is already active). */
  openDeep(exploration_id: string, title: string): void {
    const d = state.deep;
    if (d.exploration_id !== exploration_id || d.title !== title) {
      const next: DeepNav = { exploration_id, title, view: d.exploration_id === exploration_id ? d.view : 'page' };
      emit({ deep: next });
      writeDeep(workspaceKey, next);
    }
    if (!state.enabled) return;
    cockpitModeStore.set('deep', state.deepActive ? 'hop' : 'deep_start');
  },
  /** ⌘1 in Deep (D1: the Page is the only view): show Deep on that view. */
  showDeepView(v: DeepView): void {
    const d = state.deep;
    if (d.view !== v) emit({ deep: { ...d, view: v } });
    if (state.mode !== 'deep') cockpitModeStore.toggleDeep();
  },
  /** This window's Deep memory. */
  getDeep(): DeepNav {
    return state.deep;
  },
  /**
   * The mode chip's "End session": the Deep surface opens the ending ritual.
   * Deep shows first, since the ritual's sheet lives there.
   */
  requestEndSession(): void {
    if (state.mode !== 'deep' && state.deep.exploration_id) cockpitModeStore.set('deep', 'hop');
    for (const fn of endSessionListeners) fn();
  },
  onEndSessionRequest(cb: () => void): () => void {
    endSessionListeners.add(cb);
    return () => {
      endSessionListeners.delete(cb);
    };
  },
  /** Anyone listening for End session (the Deep surface is mounted). */
  canRequestEndSession(): boolean {
    return endSessionListeners.size > 0 && !!state.deep.exploration_id;
  },
  /** Show the Cockpit on Home and focus the opener's field (Go deep with nothing open). */
  focusOpener(): void {
    if (!state.enabled) return;
    if (state.mode !== 'cockpit') cockpitModeStore.set('cockpit', 'hop');
    cockpitModeStore.setSection('home');
    openerPending = true;
    // After the Cockpit (and its Home section) has rendered and taken focus.
    setTimeout(flushOpener, 50);
  },
  onFocusOpener(cb: () => void): () => void {
    focusOpenerListeners.add(cb);
    if (openerPending) setTimeout(flushOpener, 50);
    return () => {
      focusOpenerListeners.delete(cb);
    };
  },
};

// ---------------------------------------------------------------------------
// Go deep, Dive in, End session (Deep D1 §2.1, §8.3, §14)
// ---------------------------------------------------------------------------

/**
 * Open an exploration in Deep: start (or move) the Deep session on it, then
 * show it in this window. The Page opens even when the session call fails.
 */
export async function openExplorationInDeep(
  api: CopilotAPI | null | undefined,
  workspace: string,
  exploration_id: string,
  title: string,
): Promise<void> {
  const s = state;
  const onIt = s.deepActive && s.deepSessionExploration === exploration_id;
  if (api && !onIt) {
    try {
      // An in-memory Page (Deep next R8) has no exploration yet: start the session without one.
      await api.deepStart({ workspace, exploration_id: isDraftId(exploration_id) ? null : exploration_id, title, surface: 'lee' });
    } catch {
      /* the Page still opens; M logs the failure */
    }
  }
  cockpitModeStore.openDeep(exploration_id, title);
}

/**
 * Go deep (retired manual Focus): the exploration this window has open, else
 * the opener on Home.
 */
export function goDeep(api: CopilotAPI | null | undefined, workspace: string): void {
  if (!state.enabled) return;
  const d = state.deep;
  if (!d.exploration_id) {
    void openBlankDeep(api, workspace);
    return;
  }
  void openExplorationInDeep(api, workspace, d.exploration_id, d.title);
}

let blankPending = false;

/**
 * Deep with nothing open in this window: the Deep session's exploration if
 * one is running here, else a blank in-memory Page (Deep next R8): nothing
 * is created in Hester until its first save with content.
 */
export async function openBlankDeep(api?: CopilotAPI | null, workspace: string = workspaceKey): Promise<void> {
  if (!state.enabled || blankPending || !workspace) return;
  if (api === undefined) {
    try {
      api = window.lee?.copilot ?? null;
    } catch {
      api = null;
    }
  }
  if (state.deepActive && state.deepSessionExploration) {
    await openExplorationInDeep(api, workspace, state.deepSessionExploration, state.deep.title);
    return;
  }
  blankPending = true;
  try {
    const title = untitledTitle(new Date());
    const id = newDraft({ workspace, title, page: '', sendTitle: true, origin: { kind: 'opener' } });
    await openExplorationInDeep(api, workspace, id, title);
  } finally {
    blankPending = false;
  }
}

/**
 * End session from outside the Deep surface (the chip, the status bar):
 * the ritual when Deep can show it, else an unrated end (the same as Esc on
 * the sheet).
 */
export function endDeepSession(api: CopilotAPI | null | undefined): void {
  if (cockpitModeStore.canRequestEndSession()) {
    cockpitModeStore.requestEndSession();
    return;
  }
  if (api) void api.deepEnd({ reason: 'esc', rating: null }).catch(() => {});
  cockpitModeStore.set('cockpit', 'deep_end');
}

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

export interface UseCockpitModeOptions {
  workspace: string;
  snapshot: AttentionSnapshot | null;
  /** All tabs in this window (the switcher's Manual card counts them). */
  tabs: readonly ModelTab[];
}

export interface CockpitModeHandle {
  state: CockpitViewState;
  sets: AgentSets;
  isAgentTab: (tab: ModelTab) => boolean;
}

/** Subscribes to the store and wires the automatic transitions (D1 §1.2). */
export function useCockpitMode(opts: UseCockpitModeOptions): CockpitModeHandle {
  const s = useSyncExternalStore(cockpitModeStore.subscribe, cockpitModeStore.getView, cockpitModeStore.getView);
  const runtimeAgents = useSyncExternalStore(cockpitModeStore.subscribe, getRuntimeAgents, getRuntimeAgents);
  const { workspace, snapshot, tabs } = opts;

  useEffect(() => {
    if (workspace) cockpitModeStore.useWorkspace(workspace);
  }, [workspace]);

  useEffect(() => {
    cockpitModeStore.setTabCount(tabs.length);
  }, [tabs.length]);

  const agentKey = Array.from(agentPtysFromSnapshot(snapshot)).sort((a, b) => a - b).join(',');
  const snapshotAgents = useMemo(() => new Set(agentKey ? agentKey.split(',').map(Number) : []), [agentKey]);
  const sets = useMemo<AgentSets>(() => ({ snapshotAgents, runtimeAgents }), [snapshotAgents, runtimeAgents]);

  // A Deep session in this workspace: Deep when it starts, Cockpit when it ends.
  const session = snapshot ? deepSessionOf(snapshot, workspace) : undefined;
  const deepActive = session === undefined ? null : !!session;
  const sessionId = session?.exploration_id ?? null;
  const sessionTitle = session?.title ?? '';
  const prevDeep = useRef<boolean | null>(null);
  useEffect(() => {
    if (deepActive == null) return;
    const st = cockpitModeStore.get();
    if (st.deepActive !== deepActive || st.deepSessionExploration !== sessionId) {
      emit({ deepActive, deepSessionExploration: sessionId });
    }
    const prev = prevDeep.current;
    prevDeep.current = deepActive;
    if (prev == null || prev === deepActive) return;
    // Started elsewhere (a device, another window) on an exploration: show that one.
    if (deepActive && sessionId && st.deep.exploration_id !== sessionId) {
      const next: DeepNav = { exploration_id: sessionId, title: sessionTitle, view: 'page' };
      emit({ deep: next });
      writeDeep(workspaceKey, next);
    }
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'deep_session', active: deepActive }));
  }, [deepActive, sessionId, sessionTitle]);

  const awayActive = snapshot ? snapshot.away.active : null;
  const prevAway = useRef<boolean | null>(null);
  useEffect(() => {
    if (awayActive == null) return;
    const prev = prevAway.current;
    prevAway.current = awayActive;
    if (prev === false && awayActive) cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'handoff' }));
  }, [awayActive]);

  return useMemo<CockpitModeHandle>(
    () => ({
      state: s,
      sets,
      isAgentTab: (tab: ModelTab) => isAgentTabPure(tab, sets),
    }),
    [s, sets],
  );
}

function getRuntimeAgents(): ReadonlySet<number> {
  return state.runtimeAgents;
}
