/**
 * Per-window Cockpit / Deep / Manual mode store (contracts §3.1, §3.2; Deep
 * D1 §1.2), shared by the overlays, the status-bar chip, the ⌘0 switcher and
 * App.tsx without prop drilling. Transition rules live in the pure nextMode()
 * and switcherStep() (lib/cockpitModel.ts).
 *
 * Cockpit and Deep are overlays that never show an agent terminal; Manual is
 * the full tab layout with nothing hidden (D1 §1.4: the wall is gone).
 *
 * Desk D2 (contract §7.2): Deep is the Desk. DeepNav says which card this
 * window has and at which zoom (overview, Area, card); `exploration_id`
 * stays as an alias of `card_id` until the merge step. openDesk lands a
 * target; entering Deep any other way lands your last card at its stopped-at
 * line, unless this window was already at the Desk (a hop back is exact).
 * zoomIntoCard / zoomOutOfCard are the one place a zoom starts or retargets
 * the Deep session, logs desk.zoom, records the touched card and PUTs
 * /desk/last.
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
import { isDraftId, newDraft, setPendingFirstLine } from '../../lib/hesterDeep';
import { createDeskPage, getDesk, getDeskLast, putDeskLast } from '../../lib/hesterDesk';
import { asCardId, isPageId, landingFor, migrateDeepMemory, mirrorKeyMoves, parseTouched, renameTouched, touchCard, NO_TOUCHED, type DeskZoom, type Touched } from '../../lib/deskModel';

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
  /** The card that session is on (null: at the Desk with no card yet). Named for D1; holds a card id. */
  deepSessionExploration: string | null;
  /** The running Deep session's focus session id (touched cards are kept per session). */
  deepSessionId: string | null;
  /** A landing for the Desk surface to carry out: zoom into the card and put the cursor at the end of `line`. */
  deskLand: DeskLand | null;
  /** This window's Deep memory (Deep D1 §14): the open exploration and view. */
  deep: DeepNav;
  /** The ⌘0 switcher (D1 §1.3). */
  switcher: SwitcherState;
}

/** What Deep shows in this window (Deep D1 §4.4; Desk D2 §7.2). */
export interface DeepNav {
  /** Alias of card_id until the merge step (App.tsx and older callers read it). */
  exploration_id: string | null;
  /** The card this window has (zoomed into, or last zoomed into when zoomed out); a `draft-` id for an in-memory Page. */
  card_id: string | null;
  title: string;
  view: DeepView;
  zoom: DeskZoom;
  /** The Area in view (or the one the card is in). */
  area_id: string | null;
}

/** A landing (openDesk): the card, and the 1-based line to put the cursor at the end of. */
export interface DeskLand {
  card_id: string;
  line: number | null;
  nonce: number;
}

/** What the tab strip shows for an agent pty: its provider (icon) and session name (label). */
export interface TabDisplayInfo {
  provider: string | null;
  name: string | null;
}

type Listener = () => void;

const NO_DEEP: DeepNav = { exploration_id: null, card_id: null, title: '', view: 'page', zoom: 'overview', area_id: null };

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
  deepSessionId: null,
  deskLand: null,
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

/**
 * The one-time exp-<hex> → pg-<hex> pass over this workspace's local Deep
 * memory (§7.2): the Deep record's ids and cursors, and the Page mirrors
 * (copied; the old keys are left as they were).
 */
function migrateLocalDeep(workspace: string): void {
  try {
    const ls = window.localStorage;
    const flag = `lee:desk:migrated:${workspace}`;
    if (ls.getItem(flag)) return;
    const raw = ls.getItem(deepKey(workspace));
    if (raw) {
      const m = migrateDeepMemory(JSON.parse(raw));
      if (m.changed) ls.setItem(deepKey(workspace), JSON.stringify(m.next));
    }
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k) keys.push(k);
    }
    for (const mv of mirrorKeyMoves(keys, workspace)) {
      const v = ls.getItem(mv.from);
      if (v != null) ls.setItem(mv.to, v);
    }
    ls.setItem(flag, new Date().toISOString());
  } catch {
    /* storage unavailable: nothing to migrate */
  }
}

const ZOOMS: readonly DeskZoom[] = ['overview', 'area', 'card'];

/** This window's Deep memory for a workspace, restored on app restart (D1 §4.4). */
function readDeep(workspace: string): DeepNav {
  migrateLocalDeep(workspace);
  try {
    const raw = window.localStorage.getItem(deepKey(workspace));
    if (!raw) return NO_DEEP;
    const v = JSON.parse(raw) as Partial<DeepNav>;
    const id = typeof v.card_id === 'string' && v.card_id ? v.card_id : typeof v.exploration_id === 'string' && v.exploration_id ? asCardId(v.exploration_id) : null;
    // A draft id doesn't outlive the window: back to the overview.
    const card = id && !isDraftId(id) ? id : null;
    const zoom = ZOOMS.includes(v.zoom as DeskZoom) ? (v.zoom as DeskZoom) : card ? 'card' : 'overview';
    return {
      exploration_id: card,
      card_id: card,
      title: card && typeof v.title === 'string' ? v.title : '',
      view: 'page',
      zoom: zoom === 'card' && !card ? 'overview' : zoom,
      area_id: typeof v.area_id === 'string' ? v.area_id : null,
    };
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

// ---------------------------------------------------------------------------
// The Desk's nav, landing and zooms (Desk D2 §7.2)
// ---------------------------------------------------------------------------

/** This window has been at the Desk since it last landed (a hop back is exact, not a new landing). */
let landedThisRun = false;
let landSeq = 0;
let touched: Touched = NO_TOUCHED;
let lastPutTimer: ReturnType<typeof setTimeout> | null = null;

function copilotApi(): CopilotAPI | null {
  try {
    return window.lee?.copilot ?? null;
  } catch {
    return null;
  }
}

function setNav(patch: Partial<Omit<DeepNav, 'exploration_id' | 'view'>>): void {
  const d = state.deep;
  const next: DeepNav = { ...d, ...patch, view: 'page' };
  next.exploration_id = next.card_id;
  if (next.card_id === d.card_id && next.title === d.title && next.zoom === d.zoom && next.area_id === d.area_id) return;
  emit({ deep: next });
  // A draft id isn't remembered (it doesn't outlive the window).
  if (!isDraftId(next.card_id)) writeDeep(workspaceKey, next);
}

function touchedKey(workspace: string): string {
  return `lee:desk:touched:${workspace}`;
}

function readTouched(workspace: string): Touched {
  try {
    const raw = window.localStorage.getItem(touchedKey(workspace));
    return raw ? parseTouched(JSON.parse(raw)) : NO_TOUCHED;
  } catch {
    return NO_TOUCHED;
  }
}

function saveTouched(t: Touched): void {
  if (t === touched) return;
  touched = t;
  try {
    window.localStorage.setItem(touchedKey(workspaceKey), JSON.stringify(t));
  } catch {
    /* in memory only */
  }
}

/** Cards zoomed into during the running (or `sessionId`'s) Deep session, first touched first. */
export function touchedCards(sessionId: string | null = state.deepSessionId): string[] {
  return touched.session_id === sessionId ? touched.cards : [];
}

function logZoom(cardId: string | null, via: 'land' | 'key' | 'click' | 'link'): void {
  const card = cardId && isPageId(cardId) ? cardId : null;
  try {
    window.lee?.cockpit?.logEvent({ type: 'desk.zoom', data: { card_id: card, card_kind: card ? 'page' : null, via } });
  } catch {
    /* cockpit IPC not available */
  }
}

/** PUT /desk/last, debounced 2 s (§7.2). */
function rememberLast(cardId: string): void {
  if (!isPageId(cardId)) return;
  if (lastPutTimer) clearTimeout(lastPutTimer);
  const ws = workspaceKey;
  lastPutTimer = setTimeout(() => {
    lastPutTimer = null;
    void putDeskLast(ws, cardId);
  }, 2000);
}

/**
 * Start or retarget the Deep session on a card (on landing, and on every
 * zoom into a different card; never on zooming out). An in-memory Page
 * starts it with no card yet. Resolves to the focus session id when known.
 */
async function startOnCard(cardId: string | null, title: string): Promise<string | null> {
  const card = cardId && isPageId(cardId) ? cardId : null;
  if (card && state.deepActive && state.deepSessionExploration === card) return state.deepSessionId;
  const api = copilotApi();
  if (!api) return state.deepSessionId;
  try {
    const f = await api.deepStart({ workspace: workspaceKey, exploration_id: null, card_id: card, card_kind: card ? 'page' : null, title, surface: 'lee' });
    if (f?.session_id) {
      emit({ deepSessionId: f.session_id, deepActive: !!f.active, deepSessionExploration: card });
      return f.session_id;
    }
  } catch {
    /* the Page still opens; main logs the failure */
  }
  return state.deepSessionId;
}

/**
 * Zoom into a card (the one place a zoom-in happens): nav, desk.zoom, the
 * session, the touched list and /desk/last. `line`: land with the cursor at
 * the end of that line.
 */
export async function zoomIntoCard(
  card: { card_id: string; title: string; area_id?: string | null },
  via: 'land' | 'key' | 'click' | 'link',
  line: number | null = null,
): Promise<void> {
  const prev = state.deep;
  setNav({ card_id: card.card_id, title: card.title || (prev.card_id === card.card_id ? prev.title : ''), zoom: 'card', area_id: card.area_id ?? prev.area_id });
  if (line != null || via === 'land') emit({ deskLand: { card_id: card.card_id, line, nonce: ++landSeq } });
  logZoom(card.card_id, via);
  const sid = await startOnCard(card.card_id, card.title);
  if (isPageId(card.card_id)) {
    saveTouched(touchCard(touched, sid, card.card_id));
    rememberLast(card.card_id);
  }
}

/** Esc (or the header's way out): to the overview (or the Area). Doesn't touch the session. */
export function zoomOut(to: 'overview' | 'area' = 'overview', via: 'key' | 'click' = 'key'): void {
  if (state.deep.zoom === to) return;
  setNav({ zoom: to });
  logZoom(null, via);
}

/** Zoom to an Area (it fills the view). Doesn't touch the session. */
export function zoomToArea(areaId: string, via: 'key' | 'click' = 'click'): void {
  const d = state.deep;
  if (d.zoom === 'area' && d.area_id === areaId) return;
  setNav({ zoom: 'area', area_id: areaId });
  logZoom(null, via);
}

/** An in-memory Page became a card: this window, the session and the touched list follow it. */
export function promoteCard(draftId: string, cardId: string, title: string, areaId: string | null): void {
  if (state.deep.card_id === draftId || state.deep.card_id === cardId) setNav({ card_id: cardId, title, area_id: areaId ?? state.deep.area_id });
  void startOnCard(cardId, title).then((sid) => {
    saveTouched(touchCard(renameTouched(touched, draftId, cardId), sid, cardId));
  });
  rememberLast(cardId);
}

/**
 * Entering Deep (⌘0, ⇧⌘0, Go deep, the switcher, a session started
 * elsewhere): the first time since this window last landed, your last card
 * at its stopped-at line; after that, exactly what the Desk had, with a
 * session started on it if none is running.
 */
function enteredDesk(): void {
  if (!landedThisRun) {
    landedThisRun = true;
    void landLast(workspaceKey);
    return;
  }
  if (!state.deepActive) {
    const d = state.deep;
    void startOnCard(d.zoom === 'card' ? d.card_id : null, d.title);
  }
}

async function landLast(workspace: string): Promise<void> {
  const r = await getDeskLast(workspace);
  if (workspace !== workspaceKey) return;
  const land = r.ok ? landingFor(r.data) : null;
  if (land && land.kind === 'card') {
    await zoomIntoCard({ card_id: land.card_id, title: land.title, area_id: land.area_id }, 'land', land.line);
    return;
  }
  if (!r.ok && !r.status && state.deep.card_id && state.deep.zoom === 'card') {
    // Hester offline: what this window had (the Page writes locally).
    void startOnCard(state.deep.card_id, state.deep.title);
    return;
  }
  setNav({ zoom: 'overview' });
  logZoom(null, 'land');
  void startOnCard(null, '');
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
    if (mode === 'deep') enteredDesk();
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
    landedThisRun = false;
    touched = readTouched(workspace);
    emit({ deep: readDeep(workspace), deskLand: null });
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
    void from;
  },
  decide(trigger: ModeTrigger): ModeDecision | null {
    // The Desk always has somewhere to land (your last card, else the overview): never the opener or a blank Page.
    return nextMode({ enabled: state.enabled, mode: state.mode, deepActive: state.deepActive, hasExploration: true }, trigger);
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
  /**
   * Remember the card and show it zoomed in, in Deep (reason 'hop' when a
   * Deep session is already active). Older callers pass exploration ids; they
   * map to their card (pg-<hex>).
   */
  openDeep(exploration_id: string, title: string): void {
    const id = asCardId(exploration_id);
    const d = state.deep;
    if (d.card_id !== id || d.title !== title || d.zoom !== 'card') {
      setNav({ card_id: id, title, zoom: 'card' });
    }
    if (!state.enabled) return;
    landedThisRun = true;
    cockpitModeStore.set('deep', state.deepActive ? 'hop' : 'deep_start');
  },
  /** Change what the Desk shows in this window (no session calls; see zoomIntoCard). */
  setDeskNav(patch: Partial<Omit<DeepNav, 'exploration_id' | 'view'>>): void {
    setNav(patch);
  },
  /** The Desk surface carried out a landing. */
  clearDeskLand(nonce: number): void {
    if (state.deskLand && state.deskLand.nonce === nonce) emit({ deskLand: null });
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
    if (state.mode !== 'deep') {
      landedThisRun = true; // the ritual shows over what the Desk had
      cockpitModeStore.set('deep', 'hop');
    }
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
    return endSessionListeners.size > 0 && state.enabled;
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
// Go deep, openDesk, End session (Deep D1 §2.1, §8.3, §14; Desk D2 §7.2)
// ---------------------------------------------------------------------------

/**
 * Open an exploration (or a card) in Deep, zoomed in. Older callers pass
 * exploration ids; they map to their card. The Page opens even when the
 * session call fails.
 */
export async function openExplorationInDeep(
  _api: CopilotAPI | null | undefined,
  workspace: string,
  exploration_id: string,
  title: string,
): Promise<void> {
  if (workspace && workspace !== workspaceKey) cockpitModeStore.useWorkspace(workspace);
  landedThisRun = true;
  await zoomIntoCard({ card_id: asCardId(exploration_id), title }, 'link');
  if (!state.enabled) return;
  if (state.mode !== 'deep') cockpitModeStore.set('deep', state.deepActive ? 'hop' : 'deep_start');
}

/** Go deep: the Desk, landing as entering Deep always does (your last card, or where this window was). */
export function goDeep(_api: CopilotAPI | null | undefined, workspace: string): void {
  if (!state.enabled) return;
  if (workspace && workspace !== workspaceKey) cockpitModeStore.useWorkspace(workspace);
  if (state.mode === 'deep') return;
  cockpitModeStore.set('deep', state.deepActive ? 'hop' : 'deep_start');
}

/** Where openDesk lands (Desk D2 §7.2). */
export type DeskTarget =
  | { kind: 'last' }                                            // your last card at its stopped-at line (GET /desk/last)
  | { kind: 'card'; card_id: string; line?: number | null }
  | { kind: 'goals'; first_line?: string }                      // the Goals card; creates it (POST /desk/pages purpose goals)
  | { kind: 'overview' };

/** Switch to Deep (the Desk) and land on `target`; starts or retargets the Deep session. */
export async function openDesk(_api: CopilotAPI | null | undefined, workspace: string, target: DeskTarget): Promise<void> {
  if (!state.enabled) return;
  if (workspace && workspace !== workspaceKey) cockpitModeStore.useWorkspace(workspace);
  landedThisRun = true;
  const show = () => {
    if (state.mode !== 'deep') cockpitModeStore.set('deep', state.deepActive ? 'hop' : 'deep_start');
  };
  switch (target.kind) {
    case 'last':
      show();
      await landLast(workspaceKey);
      return;
    case 'overview':
      setNav({ zoom: 'overview' });
      show();
      logZoom(null, 'link');
      if (!state.deepActive) void startOnCard(null, '');
      return;
    case 'card': {
      const id = asCardId(target.card_id);
      show();
      await zoomIntoCard({ card_id: id, title: '' }, 'link', target.line ?? null);
      return;
    }
    case 'goals': {
      show();
      const line = (target.first_line ?? '').trim();
      const desk = await getDesk(workspaceKey);
      let goalsId = desk.ok ? desk.data.goals_card_id : null;
      if (!goalsId && line) {
        // Typing at "What is this project for?" creates it (Hester returns an existing one).
        const made = await createDeskPage(workspaceKey, { purpose: 'goals', text: `${line}\n\n` });
        if (made.ok) goalsId = made.data.card.id;
      } else if (goalsId && line) setPendingFirstLine(goalsId, line);
      if (goalsId) {
        await zoomIntoCard({ card_id: goalsId, title: 'Goals' }, 'link');
        return;
      }
      // No Goals card and nothing typed: an in-memory one, created on its first save with content.
      const id = newDraft({ workspace: workspaceKey, title: 'Goals', page: '', sendTitle: true, origin: { kind: 'cockpit' }, purpose: 'goals', desk: { area_id: null } });
      await zoomIntoCard({ card_id: id, title: 'Goals' }, 'link');
      return;
    }
  }
}

/**
 * A blank Page at the Desk (older callers): an in-memory Page card in the
 * Area in view, created on its first save with content (Deep next R8).
 */
export async function openBlankDeep(api?: CopilotAPI | null, workspace: string = workspaceKey): Promise<void> {
  if (!state.enabled || !workspace) return;
  const title = untitledTitle(new Date());
  const id = newDraft({ workspace, title, page: '', sendTitle: true, origin: { kind: 'opener' }, desk: { area_id: state.deep.area_id } });
  await openExplorationInDeep(api, workspace, id, title);
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
  const focus = snapshot?.focus ?? null;
  const focusItem = focus?.item && focus.item.kind === 'card' ? focus.item : null;
  // The card the session is on: Lee main's card_id, else the item's, else the legacy exploration id mapped.
  const rawCard = session ? focus?.deep?.card_id ?? focusItem?.card_id ?? (session.exploration_id ? asCardId(session.exploration_id) : null) : null;
  const sessionCard = rawCard && isPageId(rawCard) ? rawCard : null;
  const sessionTitle = session?.title ?? '';
  const focusSessionId = session ? focus?.session_id ?? null : null;
  const prevDeep = useRef<boolean | null>(null);
  useEffect(() => {
    if (deepActive == null) return;
    const st = cockpitModeStore.get();
    if (st.deepActive !== deepActive || st.deepSessionExploration !== sessionCard || st.deepSessionId !== focusSessionId) {
      emit({ deepActive, deepSessionExploration: sessionCard, deepSessionId: focusSessionId });
    }
    const prev = prevDeep.current;
    prevDeep.current = deepActive;
    if (prev == null || prev === deepActive) return;
    if (deepActive) {
      // Started elsewhere (a device, another window) on a card: show that one.
      if (sessionCard && st.mode !== 'deep' && st.deep.card_id !== sessionCard) {
        setNav({ card_id: sessionCard, title: sessionTitle, zoom: 'card' });
        landedThisRun = true;
      }
    } else {
      // Ended while the Desk is showing (a device's End and rate, the idle end):
      // stay at the Desk, no sheet; the next zoom starts a new session (§7.2).
      if (st.mode === 'deep') return;
      landedThisRun = false;
    }
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'deep_session', active: deepActive }));
  }, [deepActive, sessionCard, sessionTitle, focusSessionId]);

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
