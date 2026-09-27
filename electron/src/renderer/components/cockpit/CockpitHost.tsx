/**
 * CockpitHost - the Cockpit overlay (contracts §3.3-§3.8, §4).
 *
 * Rendered through a portal as a fixed layer from the bottom of the title
 * bar to the top of the status bar. It never changes the layout underneath:
 * terminals stay mounted and sized (TerminalPane.safeResize measures its
 * container, so hiding it would squash every agent PTY). While the Cockpit
 * shows, a capture-phase focus trap keeps keystrokes out of the terminals
 * and editors below (C3).
 *
 * Also owns the create-tab bridge (cockpit:create-tab) and cockpit:go-into.
 * Cockpit and Deep never show an agent terminal; Manual shows every tab
 * (Deep D1 §1.4).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Tab, DockPosition } from '../TabBar';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import { useCockpit, type HesterCockpitState } from '../../hooks/useCockpit';
import { focusManager } from '../../hooks/useFocusManager';
import type { AttentionItem, AttentionSnapshot, CopilotAPI } from '../../../shared/copilot';
import type { AboutRef, CockpitAPI, GoIntoFrom, OperationsSnapshot, TabRuntimeInfo } from '../../../shared/cockpit';
import {
  feedNeedsCount,
  keyAction,
  mergeFeed,
  railDots,
  runtimeAgentPtys,
  tabDisplayFromRuntime,
  checkinToasts,
  taskNeedsYou,
  tileModel,
  type FeedRow,
  type ModelTab,
  type SectionId,
  type TileModel,
} from '../../lib/cockpitModel';
import {
  cockpitModeStore,
  openExplorationInDeep,
  useCockpitModeState,
  type CockpitModeHandle,
  type CockpitModeState,
  type StewardRequest,
} from './cockpitMode';
import { CockpitNav, type NavDots } from './CockpitNav';
import { Launcher, type LauncherPrefill } from './Launcher';
import { Icon } from '../Icon';
import { RunMenu } from './RunMenu';
import { KeyHelp } from './KeyHelp';
import { ReplyPopover, CheckinPopover, RenamePopover, type RenameTarget } from './AgentTile';
import { fetchGoalsStatus, patchTask, type GoalsStatusResponse } from '../../lib/hesterCockpit';
import { HomeSection } from './sections/HomeSection';
import { WorkSection } from './sections/WorkSection';
import { GoalsSection } from './sections/GoalsSection';
import { LibrarySection } from './sections/LibrarySection';
import { OperationsSection } from './sections/OperationsSection';
import type { Exploration } from '../../lib/hesterCockpit';
import { HistorySection } from './sections/HistorySection';
import { isControlTarget, isTypingTarget } from './dom';
import './cockpit-shell.css';
import './work.css';
import './library.css';

export type CockpitTab = Tab & { ptyId: number | null; dockPosition: DockPosition };

export type CreateTabFn = (
  type: Tab['type'],
  dockPosition?: DockPosition,
  label?: string,
  spawnOptions?: { command?: string; args?: string[]; label?: string },
) => Promise<number | null>;

/** A section row the keyboard can act on (j/k, Enter, a/d/r/x). */
export interface RowHandle {
  id: string;
  title: string;
  open?: () => void;
  approval?: AttentionItem | null;
  replyItem?: AttentionItem | null;
  dismiss?: () => void;
  ptyId?: number | null;
  /** Rename this row's task or agent (e). */
  rename?: () => void;
  /** What Ask Hester is "about" when this row was the last one selected (v4 §8.2). */
  about?: AboutRef | null;
}

/** Goal status for the Goals section and its nav badge (GET /cockpit/goals/status). */
export interface GoalsState {
  data: GoalsStatusResponse | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** A steward request handed to a section, with a nonce so the same request can repeat. */
export interface PendingSteward {
  req: StewardRequest;
  nonce: number;
}

export interface CockpitCtx {
  workspace: string;
  api: CockpitAPI | null;
  copilotApi: CopilotAPI | null;
  snapshot: AttentionSnapshot | null;
  runtime: TabRuntimeInfo[];
  ops: OperationsSnapshot | null;
  hester: HesterCockpitState;
  tiles: TileModel[];
  feedRows: FeedRow[];
  tabs: CockpitTab[];
  mode: CockpitModeState;
  isAgentTab: (tab: ModelTab) => boolean;
  now: number;
  goInto: (ptyId: number, from: GoIntoFrom) => void;
  openOwnTab: (tabId: number) => void;
  /** Open a file the way Manual does, then switch to Manual. */
  openFile: (path: string) => void;
  /** Open an exploration in Deep: start the Deep session on it, then show its Page (D1 §8.3). */
  openExploration: (exp: Exploration) => Promise<void>;
  /** Open (or refocus) the Library tab on this exploration's tree, then switch to Manual. */
  openLibrary: (expId: string) => void;
  /** Open a workstream's tab, then switch to Manual. */
  openWorkstream: (id: string, title: string) => void;
  focusPty: (ptyId: number) => void;
  notify: (message: string, level?: 'info' | 'error') => void;
  openLauncher: (prefill?: LauncherPrefill) => void;
  openReply: (item: AttentionItem, label: string) => void;
  openCheckin: (ptyId: number, label: string) => void;
  /** Rename an agent (by pty) and/or its task: your name wins over Claude's titles. */
  openRename: (target: RenameTarget) => void;
  /** Close an agent: its tab here (Manual's close path, which kills the PTY), else just its PTY. */
  closeAgent: (ptyId: number, tabId: number | null) => void;
  registerRows: (rows: RowHandle[]) => void;
  selectRow: (id: string) => void;
  setSection: (section: SectionId) => void;
  /** v4 goal status (Goals section, badge). */
  goals: GoalsState;
  /** Ask Hester about an item / run What next? / open a task's goal picker (switches section). */
  requestSteward: (req: StewardRequest) => void;
  /** The latest steward request for a section to pick up (Copilot: ask, what-next; Tasks: link-goal). */
  pendingSteward: PendingSteward | null;
}

interface CockpitHostProps {
  mode: CockpitModeHandle;
  workspace: string;
  config: { enabled?: boolean } | null;
  tabs: CockpitTab[];
  activeTabId: number | null;
  copilot: UseCopilotResult;
  onCreateTab: CreateTabFn;
  onOpenTab: (tabId: number) => void;
  /** Close a tab in this window (App.closeTab: kills its PTY). */
  onCloseTab?: (tabId: number) => void | Promise<void>;
  /** Manual's open-file path (App.handleFileOpen). */
  onOpenFile?: (path: string) => Promise<number | null | undefined> | void;
  /** Open (or refocus) the Library tab on an exploration (App: librarySessionId on the tab's data). */
  onOpenLibrary?: (expId: string) => void;
  /** Open a workstream tab (App.handleWorkstreamSelect). */
  onOpenWorkstream?: (id: string, title: string) => void;
  /** Unused since Home dropped its Ask card (asking is ⌘/, cockpit-design §3.7); App still passes it. */
  onAskHester?: (prompt: string) => void;
  /** App-level toast, for results that arrive while the Cockpit is hidden (async check-ins). */
  onNotify?: (message: string, level: 'info' | 'error') => void;
}

type Popover =
  | { kind: 'launcher'; prefill?: LauncherPrefill }
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'reply'; item: AttentionItem; label: string }
  | { kind: 'checkin'; ptyId: number; label: string }
  | { kind: 'rename'; target: RenameTarget }
  | null;

/** The parts of a keydown the Cockpit keymap reads (React's synthetic event or a native one). */
interface KeyLike {
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code: string;
  preventDefault: () => void;
}

/** The selected Cockpit item as an item ref, while the Cockpit shows (null otherwise). */
let currentAbout: AboutRef | null = null;

/**
 * What the ⌘/ palette is "about" (cockpit-design §6.2): the Cockpit's
 * selected item (a Work card or row, a Library exploration, a Goals row),
 * else null. Read when the palette opens; it's not a subscription.
 */
export function currentCockpitAbout(): AboutRef | null {
  return currentAbout;
}

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

export const CockpitHost: React.FC<CockpitHostProps> = ({
  mode,
  workspace,
  config,
  tabs,
  activeTabId,
  copilot,
  onCreateTab,
  onOpenTab,
  onCloseTab,
  onOpenFile,
  onOpenLibrary,
  onOpenWorkstream,
  onNotify,
}) => {
  const state = useCockpitModeState();
  const snapshot = copilot.snapshot;
  const agentsKey = (snapshot?.agents ?? []).map((a) => `${a.pty_id}:${a.state}`).join(',');
  const shown = state.enabled && state.mode === 'cockpit';
  const cockpit = useCockpit({ workspace, visible: shown, agentsKey });
  const { api, available, runtime, ops, hester } = cockpit;
  const now = useNow(30000, shown);
  const notifyRef = useRef<(message: string, level?: 'info' | 'error') => void>(() => {});

  // Configure once the cockpit API was probed and the workspace is known; config may lag.
  // Lee always opens in the Cockpit on Copilot (D1 §1.1: default_mode is gone).
  const enabledCfg = config?.enabled !== false;
  useEffect(() => {
    if (!workspace || available == null) return;
    if (!available) {
      cockpitModeStore.configure(false);
      return;
    }
    if (config) {
      cockpitModeStore.configure(enabledCfg);
      return;
    }
    const id = window.setTimeout(() => cockpitModeStore.configure(enabledCfg), 1500);
    return () => window.clearTimeout(id);
  }, [workspace, available, config, enabledCfg]);

  useEffect(() => {
    cockpitModeStore.setRuntimeAgents(runtimeAgentPtys(runtime));
    cockpitModeStore.setTabDisplay(tabDisplayFromRuntime(runtime));
  }, [runtime]);

  // Back after an absence: the Cockpit on Home, unless you're deep in a
  // Deep session, which a short absence doesn't end (D1 §8.3).
  const returnNonce = copilot.lastReturn?.nonce ?? 0;
  useEffect(() => {
    if (!returnNonce) return;
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'return' }));
    const st = cockpitModeStore.get();
    if (!(st.deepActive && st.mode === 'deep')) cockpitModeStore.setSection('home');
  }, [returnNonce]);

  // Async check-ins: toast the result of a check-in this window saw pending.
  const checkinIds = useRef(new Set<string>());
  const toastedCheckins = useRef(new Set<string>());
  useEffect(() => {
    for (const r of runtime) if (r.checkin) checkinIds.current.add(r.checkin.id);
  }, [runtime]);
  useEffect(() => {
    for (const t of checkinToasts(cockpit.feed, checkinIds.current, toastedCheckins.current)) {
      toastedCheckins.current.add(t.checkin_id);
      checkinIds.current.delete(t.checkin_id);
      if (shownRef.current || !onNotifyRef.current) notifyRef.current(t.message, t.level);
      else onNotifyRef.current(t.message, t.level);
    }
  }, [cockpit.feed]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;

  // Session names by pty, for attention item sources in the Feed.
  const runtimeNames = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of runtime) if (r.name) m.set(r.pty_id, r.name);
    return m;
  }, [runtime]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;
  const createRef = useRef(onCreateTab);
  createRef.current = onCreateTab;
  const openRef = useRef(onOpenTab);
  openRef.current = onOpenTab;
  const closeRef = useRef(onCloseTab);
  closeRef.current = onCloseTab;
  const closeAgent = useCallback((ptyId: number, tabId: number | null) => {
    const close = closeRef.current;
    if (tabId != null && close) {
      void Promise.resolve(close(tabId)).catch(() => {});
      return;
    }
    // Another window's agent: end its PTY (that window's tab shows it exited).
    void window.lee?.pty?.kill(ptyId)?.catch?.(() => {});
  }, []);
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const openLibraryRef = useRef(onOpenLibrary);
  openLibraryRef.current = onOpenLibrary;
  const openWorkstreamRef = useRef(onOpenWorkstream);
  openWorkstreamRef.current = onOpenWorkstream;

  const hesterTasks = useMemo(
    () => [...(hester.snapshot?.tasks.open ?? []), ...(hester.snapshot?.tasks.recent_closed ?? [])],
    [hester.snapshot],
  );

  const tiles = useMemo(
    () =>
      tileModel({
        workspace,
        tabs,
        sets: mode.sets,
        snapshot,
        runtime,
        tasks: hesterTasks,
        now,
      }),
    [workspace, tabs, mode, snapshot, runtime, hesterTasks, now],
  );
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;

  // Into Manual: hand focus back to the tab you were in (Manual keeps its own
  // active tab; nothing is hidden, so there is nothing to fall back from).
  const prevMode = useRef(state.mode);
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = state.mode;
    if (!state.enabled || was === 'manual' || state.mode !== 'manual') return;
    window.setTimeout(() => focusManager.refocus(), 0);
  }, [state.mode, state.enabled]);

  const feedRows = useMemo(
    () =>
      mergeFeed({
        names: runtimeNames,
        workspace,
        items: snapshot?.items,
        entries: cockpit.feed,
        events: hester.snapshot?.tasks.recent_events,
      }),
    [workspace, snapshot, cockpit.feed, hester.snapshot, runtimeNames],
  );

  const needsCount = feedNeedsCount(feedRows);
  useEffect(() => {
    cockpitModeStore.setNeedsCount(needsCount);
  }, [needsCount]);

  const [toast, setToast] = useState<{ message: string; level: 'info' | 'error' } | null>(null);
  const notify = useCallback((message: string, level: 'info' | 'error' = 'info') => {
    setToast({ message, level });
  }, []);
  notifyRef.current = notify;
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), toast.level === 'error' ? 8000 : 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const goInto = useCallback(
    (ptyId: number, from: GoIntoFrom) => {
      const tab = tabsRef.current.find((t) => t.ptyId === ptyId);
      if (!tab) {
        if (api) {
          api.tabs
            .focus(ptyId)
            .then((r) => {
              if (!r.success) notify(r.error === 'not_found' ? 'That agent is gone' : 'Could not open that tab', 'error');
            })
            .catch(() => notify('Could not open that tab', 'error'));
        }
        return;
      }
      const tile = tilesRef.current.find((t) => t.ptyId === ptyId);
      cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'go_into', ptyId }), {
        agentState: tile?.agentState ?? 'unknown',
        from,
      });
      openRef.current(tab.id);
    },
    [api, notify],
  );

  const openOwnTab = useCallback((tabId: number) => {
    cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'open_tab' }));
    openRef.current(tabId);
  }, []);

  const openFile = useCallback(
    (path: string) => {
      const open = openFileRef.current;
      if (!open) {
        notify('Opening files is not available here', 'error');
        return;
      }
      // Open first, then leave: the tab is active before Manual shows.
      Promise.resolve(open(path))
        .then(() => cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'open_tab' })))
        .catch(() => notify('Could not open that file', 'error'));
    },
    [notify],
  );

  const openLibrary = useCallback(
    (expId: string) => {
      const open = openLibraryRef.current;
      if (!open) {
        notify('The Library is not available here', 'error');
        return;
      }
      open(expId);
      cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'open_tab' }));
    },
    [notify],
  );

  const openWorkstream = useCallback(
    (id: string, title: string) => {
      const open = openWorkstreamRef.current;
      if (!open) {
        notify('Workstream tabs are not available here', 'error');
        return;
      }
      open(id, title);
      cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'open_tab' }));
    },
    [notify],
  );

  // Dive in / Continue: the exploration's Page in Deep (D1 §8.3). The chat-tab
  // dive-in is gone from here; the Library's per-node chats are unchanged.
  const openExplorationDeep = useCallback(
    (exp: Exploration) => openExplorationInDeep(copilot.api, workspace, exp.id, exp.title),
    [copilot.api, workspace],
  );

  const focusPty = useCallback(
    (ptyId: number) => {
      const tab = tabsRef.current.find((t) => t.ptyId === ptyId);
      if (!tab) {
        goInto(ptyId, 'tabs');
        return;
      }
      if (mode.isAgentTab(tab)) goInto(ptyId, 'tabs');
      else openOwnTab(tab.id);
    },
    [goInto, openOwnTab, mode],
  );

  // Create-tab bridge (§3.8): main asks this window for a tab and learns its ids.
  useEffect(() => {
    if (!api) return;
    let unsub: (() => void) | null = null;
    try {
      unsub = api.onCreateTab(async (req) => {
        const prevActive = activeRef.current;
        let tabId: number | null = null;
        try {
          tabId = await createRef.current(
            req.type === 'agent' ? 'agent' : 'terminal',
            'center',
            req.type === 'agent' ? req.provider || 'claude' : req.label,
            req.type === 'terminal'
              ? req.command
                ? { command: req.command, args: req.args }
                : undefined
              : { args: req.args ?? [], label: req.label },
          );
        } catch {
          tabId = null;
        }
        if (tabId == null) {
          api.createTabResult({ request_id: req.request_id, tab_id: null, pty_id: null, error: 'create_failed' });
          return;
        }
        if (!req.activate && prevActive != null && prevActive !== tabId) openRef.current(prevActive);
        let ptyId: number | null = null;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          ptyId = tabsRef.current.find((t) => t.id === tabId)?.ptyId ?? null;
          if (ptyId != null) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (ptyId != null && !req.activate) cockpitModeStore.select({ kind: 'tile', id: String(ptyId) });
        api.createTabResult({ request_id: req.request_id, tab_id: tabId, pty_id: ptyId, ...(ptyId == null ? { error: 'no_pty' } : {}) });
      });
    } catch {
      unsub = null;
    }
    return () => unsub?.();
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let unsub: (() => void) | null = null;
    try {
      unsub = api.onGoInto((req) => goInto(req.pty_id, 'other-window'));
    } catch {
      unsub = null;
    }
    return () => unsub?.();
  }, [api, goInto]);

  // ---- overlay geometry ----
  const [box, setBox] = useState<{ top: number; bottom: number }>({ top: 0, bottom: 0 });
  useEffect(() => {
    if (!shown) return;
    const measure = () => {
      const title = document.querySelector('.title-bar');
      const status = document.querySelector('.status-bar');
      const top = title ? title.getBoundingClientRect().bottom : 0;
      const bottom = status ? Math.max(0, window.innerHeight - status.getBoundingClientRect().top) : 0;
      setBox((b) => (b.top === top && b.bottom === bottom ? b : { top, bottom }));
    };
    measure();
    window.addEventListener('resize', measure);
    const id = window.setTimeout(measure, 300);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(id);
    };
  }, [shown]);

  // ---- focus trap (C3) ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!shown) return;
    const underneath = (el: EventTarget | null) =>
      el instanceof Element && !!el.closest('.main-content, .tab-bar') && !(rootRef.current && rootRef.current.contains(el));
    const onFocusIn = (e: FocusEvent) => {
      if (!underneath(e.target)) return;
      (e.target as HTMLElement).blur?.();
      rootRef.current?.focus({ preventScroll: true });
    };
    const onKey = (e: Event) => {
      if (!underneath(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keypress', onKey, true);
    window.addEventListener('paste', onKey, true);
    const active = document.activeElement;
    if (active && underneath(active)) (active as HTMLElement).blur?.();
    if (!document.activeElement || document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keypress', onKey, true);
      window.removeEventListener('paste', onKey, true);
    };
  }, [shown]);

  // ---- popovers, rows, keyboard ----
  const [popover, setPopover] = useState<Popover>(null);
  // New ⌘N → Explore: go to the Library and focus its new-exploration field.
  const [exploreNonce, setExploreNonce] = useState(0);
  const startExplore = useCallback(() => {
    cockpitModeStore.setSection('library');
    setExploreNonce((n) => n + 1);
  }, []);
  const rowsRef = useRef<RowHandle[]>([]);
  const registerRows = useCallback((rows: RowHandle[]) => {
    rowsRef.current = rows;
  }, []);
  const selectRow = useCallback((id: string) => cockpitModeStore.select({ kind: 'row', id }), []);
  const setSection = useCallback((section: SectionId) => cockpitModeStore.setSection(section), []);
  const openLauncher = useCallback((prefill?: LauncherPrefill) => setPopover({ kind: 'launcher', prefill }), []);
  const openReply = useCallback((item: AttentionItem, label: string) => setPopover({ kind: 'reply', item, label }), []);
  const openRename = useCallback((target: RenameTarget) => setPopover({ kind: 'rename', target }), []);
  const saveName = useCallback(
    async (target: RenameTarget, name: string | null): Promise<string | null> => {
      // A live agent: Lee main records it as yours and relays it to its task
      // (by task id or session). A task with no agent: straight to Hester.
      if (target.ptyId != null && api) {
        const r = await api.tabs.rename(target.ptyId, name);
        if (!r.success) return r.error || 'Rename failed';
        if (target.taskId) void patchTask(workspace, target.taskId, { name });
      } else if (target.taskId) {
        const r = await patchTask(workspace, target.taskId, { name });
        if (!r.ok) return r.error || 'Rename failed';
      } else {
        return 'Nothing to rename';
      }
      hester.refresh();
      return null;
    },
    [api, workspace, hester],
  );
  const openCheckin = useCallback((ptyId: number, label: string) => setPopover({ kind: 'checkin', ptyId, label }), []);

  useEffect(() => {
    if (!shown) setPopover(null);
  }, [shown]);

  // ⌘N: the File > New File accelerator, routed here by App while we're showing.
  useEffect(() => cockpitModeStore.onLauncherRequest(() => openLauncher()), [openLauncher]);

  // A popover that closes (Send, Launch, a click) unmounts the focused element and
  // focus falls to <body>, where the overlay's keymap never sees keys. Take it back.
  useEffect(() => {
    if (!shown || popover) return;
    const active = document.activeElement;
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true });
  }, [popover, shown]);

  const selectedTile = state.selected?.kind === 'tile' ? tiles.find((t) => String(t.ptyId) === state.selected?.id) ?? null : null;
  const selectedRow = state.selected?.kind === 'row' ? rowsRef.current.find((r) => r.id === state.selected?.id) ?? null : null;
  // An item ref, not a title (v4 §8.2): a tile with a task is about that task.
  const aboutRef: AboutRef | null = selectedTile
    ? selectedTile.task
      ? { kind: 'task', id: selectedTile.task.id, label: selectedTile.title }
      : { kind: 'tile', id: String(selectedTile.ptyId), label: selectedTile.title, record: { pty_id: selectedTile.ptyId, title: selectedTile.title, provider: selectedTile.provider } }
    : selectedRow?.about ?? null;
  // The palette's "about" (§6.2) reads the Cockpit's selected item here.
  currentAbout = shown ? aboutRef : null;

  // ---- v4: goal status (badge + Goals section), steward requests ----
  const [goalsData, setGoalsData] = useState<GoalsStatusResponse | null>(null);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const goalsSeq = useRef(0);
  const refreshGoals = useCallback(() => {
    if (!workspace) return;
    const seq = ++goalsSeq.current;
    setGoalsLoading(true);
    fetchGoalsStatus(workspace).then((r) => {
      if (seq !== goalsSeq.current) return;
      setGoalsLoading(false);
      if (r.ok) {
        setGoalsData(r.data);
        setGoalsError(null);
      } else setGoalsError(r.error);
    });
  }, [workspace]);
  useEffect(() => {
    setGoalsData(null);
    setGoalsError(null);
  }, [workspace]);
  useEffect(() => {
    if (!shown || !workspace) return;
    refreshGoals();
    const id = window.setInterval(refreshGoals, 5 * 60000);
    return () => window.clearInterval(id);
  }, [shown, workspace, refreshGoals]);
  const goals = useMemo<GoalsState>(
    () => ({ data: goalsData, error: goalsError, loading: goalsLoading, refresh: refreshGoals }),
    [goalsData, goalsError, goalsLoading, refreshGoals],
  );

  const [pendingSteward, setPendingSteward] = useState<PendingSteward | null>(null);
  useEffect(
    () =>
      cockpitModeStore.onStewardRequest((req) => {
        setPendingSteward((p) => ({ req, nonce: (p?.nonce ?? 0) + 1 }));
      }),
    [],
  );
  const requestSteward = useCallback(
    (req: StewardRequest) => {
      if (!cockpitModeStore.requestSteward(req)) notify('The Cockpit is not available here', 'error');
    },
    [notify],
  );
  const copilotApi = copilot.api;
  const approve = (item: AttentionItem | null | undefined, action: 'approve' | 'deny') => {
    if (!item || !copilotApi) return;
    copilotApi
      .reply(item.id, { action, version: item.version })
      .then((r) => {
        if (!r.success) notify(r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'failed', 'error');
      })
      .catch(() => notify('failed', 'error'));
  };

  const onKey = (e: KeyLike) => {
    if (popover) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopover(null);
        rootRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    // A dialog a section opened itself (RunOpDialog from Ops) owns its keys:
    // nothing typed in it may approve, deny or switch sections behind it.
    if (e.target instanceof Element && e.target !== rootRef.current && e.target.closest('[role="dialog"]')) return;
    const act = keyAction(e.key, {
      inInput: isTypingTarget(e.target),
      onControl: e.target !== rootRef.current && isControlTarget(e.target),
      meta: e.metaKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      code: e.code,
    });
    if (!act) return;
    e.preventDefault();
    const sel = state.selected;
    const tile = selectedTile;
    const row = selectedRow;
    switch (act.kind) {
      case 'row': {
        const rows = rowsRef.current;
        if (!rows.length) break;
        const idx = sel?.kind === 'row' ? rows.findIndex((r) => r.id === sel.id) : -1;
        const next = idx < 0 ? (act.delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + act.delta));
        selectRow(rows[next].id);
        document.querySelector(`[data-cockpit-row="${CSS.escape(rows[next].id)}"]`)?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'enter':
        if (tile) goInto(tile.ptyId, 'tile');
        else if (row?.open) row.open();
        break;
      case 'approve':
        approve(tile?.approval ?? row?.approval, 'approve');
        break;
      case 'deny':
        approve(tile?.approval ?? row?.approval, 'deny');
        break;
      case 'reply': {
        const item = tile?.replyItem ?? row?.replyItem ?? null;
        if (item) openReply(item, tile?.title ?? item.source.tab_label ?? item.title);
        break;
      }
      case 'checkin':
        if (tile?.canCheckin) openCheckin(tile.ptyId, tile.title);
        break;
      case 'rename':
        if (tile) openRename({ ptyId: tile.ptyId, taskId: tile.task?.id ?? null, current: tile.title, provider: tile.provider });
        else row?.rename?.();
        break;
      case 'run':
        setPopover({ kind: 'run' });
        break;
      case 'dismiss':
        row?.dismiss?.();
        break;
      case 'manual':
        // ⌘T: your own tabs live in Manual, which keeps its last active tab (§2.1).
        cockpitModeStore.toggleManual();
        break;
      case 'escape':
        cockpitModeStore.select(null);
        break;
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => onKey(e);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  // Keys that arrive while focus sits on <body> (after something focused was
  // removed) still belong to the Cockpit: refocus the overlay and handle them.
  useEffect(() => {
    if (!shown) return;
    const onBodyKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.target !== document.body) return;
      rootRef.current?.focus({ preventScroll: true });
      onKeyRef.current(e);
    };
    window.addEventListener('keydown', onBodyKey);
    return () => window.removeEventListener('keydown', onBodyKey);
  }, [shown]);

  const ctx: CockpitCtx = {
    workspace,
    api,
    copilotApi,
    snapshot,
    runtime,
    ops,
    hester,
    tiles,
    feedRows,
    tabs,
    mode: state,
    isAgentTab: mode.isAgentTab,
    now,
    goInto,
    openOwnTab,
    openFile,
    openExploration: openExplorationDeep,
    openLibrary,
    openWorkstream,
    focusPty,
    notify,
    openLauncher,
    openReply,
    openCheckin,
    openRename,
    closeAgent,
    registerRows,
    selectRow,
    setSection,
    goals,
    requestSteward,
    pendingSteward,
  };

  if (!state.enabled || !available || state.mode !== 'cockpit') return null;

  // One ember dot per section that holds something needing you; no counts (§2.1).
  const dots: NavDots = railDots({
    work: needsCount + (hester.snapshot?.tasks.open ?? []).filter(taskNeedsYou).length,
    goals: goalsData?.goals,
    opsFailing: (ops?.operations ?? []).filter((o) => o.status === 'failed' || o.status === 'crashed' || o.status === 'unhealthy').length,
    opsProposals: ops?.proposals.length ?? 0,
    now,
  });

  const section = state.section;

  return ReactDOM.createPortal(
    <div
      ref={rootRef}
      className="cockpit-overlay"
      style={{ top: box.top, bottom: box.bottom }}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="region"
      aria-label="Cockpit"
    >
      <div className="cockpit-body">
        <div className="cockpit-rail-col">
          <CockpitNav section={section} dots={dots} onSelect={setSection} />
          <button
            type="button"
            className="cockpit-rail-item cockpit-rail-keys"
            onClick={() => setPopover({ kind: 'help' })}
            aria-label="Keys"
            title="Keys"
          >
            <Icon name="keyboard" size={16} />
          </button>
        </div>
        {/* A view root for nextGuard: one phosphor next step per section (cockpit-design §1.3). */}
        <div className="cockpit-section" data-view-root="section">
          {section === 'home' && <HomeSection ctx={ctx} returnNonce={returnNonce} />}
          {section === 'work' && <WorkSection ctx={ctx} />}
          {section === 'goals' && <GoalsSection ctx={ctx} />}
          {section === 'library' && <LibrarySection ctx={ctx} focusCreateNonce={exploreNonce} />}
          {section === 'ops' && <OperationsSection ctx={ctx} />}
          {section === 'history' && <HistorySection ctx={ctx} />}
        </div>
      </div>
      {toast && (
        <div className={`cockpit-toast is-${toast.level}`} role="status">
          {toast.message}
        </div>
      )}
      {popover?.kind === 'launcher' && (
        <Launcher
          ctx={ctx}
          prefill={popover.prefill}
          onClose={() => setPopover(null)}
          onExplore={() => {
            setPopover(null);
            startExplore();
          }}
          onRun={() => setPopover({ kind: 'run' })}
        />
      )}
      {popover?.kind === 'run' && <RunMenu ctx={ctx} onClose={() => setPopover(null)} />}
      {popover?.kind === 'help' && <KeyHelp onClose={() => setPopover(null)} />}
      {popover?.kind === 'reply' && copilotApi && (
        <ReplyPopover api={copilotApi} item={popover.item} label={popover.label} onClose={() => setPopover(null)} onError={(m) => notify(m, 'error')} />
      )}
      {popover?.kind === 'checkin' && api && (
        <CheckinPopover api={api} ptyId={popover.ptyId} label={popover.label} onClose={() => setPopover(null)} notify={notify} />
      )}
      {popover?.kind === 'rename' && (
        <RenamePopover target={popover.target} onSave={saveName} onClose={() => setPopover(null)} notify={notify} />
      )}
    </div>,
    document.body,
  );
};

export default CockpitHost;
