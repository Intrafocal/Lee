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
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Tab, DockPosition } from '../TabBar';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import { useCockpit, type HesterCockpitState } from '../../hooks/useCockpit';
import { focusManager } from '../../hooks/useFocusManager';
import type { AttentionItem, AttentionSnapshot, CopilotAPI } from '../../../shared/copilot';
import type { CockpitAPI, GoIntoFrom, OperationsSnapshot, TabRuntimeInfo } from '../../../shared/cockpit';
import {
  copilotBadge,
  feedNeedsCount,
  keyAction,
  mergeFeed,
  runtimeAgentPtys,
  opsBadge,
  tasksBadge,
  tileModel,
  type FeedRow,
  type ModelTab,
  type SectionId,
  type TileModel,
} from '../../lib/cockpitModel';
import { cockpitModeStore, useCockpitModeState, type CockpitModeHandle, type CockpitModeState } from './cockpitMode';
import { CockpitHeader } from './CockpitHeader';
import { CockpitNav, type NavBadges } from './CockpitNav';
import { AgentTiles } from './AgentTiles';
import { TabDrawer } from './TabDrawer';
import { Launcher, type LauncherPrefill } from './Launcher';
import { RunMenu } from './RunMenu';
import { KeyHelp } from './KeyHelp';
import { ReplyPopover, CheckinPopover } from './AgentTile';
import { CopilotSection } from './sections/CopilotSection';
import { FeedSection } from './sections/FeedSection';
import { FilesSection } from './sections/FilesSection';
import { TasksSection } from './sections/TasksSection';
import { OperationsSection } from './sections/OperationsSection';
import { SomedaySection } from './sections/SomedaySection';
import { TabsSection } from './sections/TabsSection';
import { HistorySection } from './sections/HistorySection';
import { isControlTarget, isTypingTarget } from './dom';
import './cockpit.css';

export type CockpitTab = Tab & { ptyId: number | null; dockPosition: DockPosition };

export type CreateTabFn = (
  type: Tab['type'],
  dockPosition?: DockPosition,
  label?: string,
  spawnOptions?: { command?: string; args?: string[] },
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
  /** Open a file the way the Workbench does, then switch to the Workbench. */
  openFile: (path: string) => void;
  focusPty: (ptyId: number) => void;
  notify: (message: string, level?: 'info' | 'error') => void;
  openLauncher: (prefill?: LauncherPrefill) => void;
  openReply: (item: AttentionItem, label: string) => void;
  openCheckin: (ptyId: number, label: string) => void;
  registerRows: (rows: RowHandle[]) => void;
  selectRow: (id: string) => void;
  setSection: (section: SectionId) => void;
}

interface CockpitHostProps {
  mode: CockpitModeHandle;
  workspace: string;
  config: { enabled?: boolean; default_mode?: string } | null;
  tabs: CockpitTab[];
  activeTabId: number | null;
  copilot: UseCopilotResult;
  onCreateTab: CreateTabFn;
  onOpenTab: (tabId: number) => void;
  /** The Workbench's open-file path (App.handleFileOpen). */
  onOpenFile?: (path: string) => Promise<number | null | undefined> | void;
  onAskHester: (prompt: string) => void;
}

type Popover =
  | { kind: 'launcher'; prefill?: LauncherPrefill }
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'reply'; item: AttentionItem; label: string }
  | { kind: 'checkin'; ptyId: number; label: string }
  | null;

/** The parts of a keydown the Cockpit keymap reads (React's synthetic event or a native one). */
interface KeyLike {
  key: string;
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
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
  onOpenFile,
  onAskHester,
}) => {
  const state = useCockpitModeState();
  const snapshot = copilot.snapshot;
  const agentsKey = (snapshot?.agents ?? []).map((a) => `${a.pty_id}:${a.state}`).join(',');
  const shown = state.enabled && state.mode === 'cockpit';
  const cockpit = useCockpit({ workspace, visible: shown, agentsKey });
  const { api, available, runtime, ops, hester } = cockpit;
  const now = useNow(30000, shown);

  // Configure once the cockpit API was probed and the workspace is known; config may lag.
  const enabledCfg = config?.enabled !== false;
  const defaultMode = config?.default_mode === 'workbench' ? 'workbench' : 'cockpit';
  useEffect(() => {
    if (!workspace || available == null) return;
    if (!available) {
      cockpitModeStore.configure(false, 'workbench');
      return;
    }
    if (config) {
      cockpitModeStore.configure(enabledCfg, defaultMode);
      return;
    }
    const id = window.setTimeout(() => cockpitModeStore.configure(enabledCfg, defaultMode), 1500);
    return () => window.clearTimeout(id);
  }, [workspace, available, config, enabledCfg, defaultMode]);

  useEffect(() => {
    cockpitModeStore.setRuntimeAgents(runtimeAgentPtys(runtime));
  }, [runtime]);

  const returnNonce = copilot.lastReturn?.nonce ?? 0;
  useEffect(() => {
    if (returnNonce) cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'return' }));
  }, [returnNonce]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeTabId);
  activeRef.current = activeTabId;
  const createRef = useRef(onCreateTab);
  createRef.current = onCreateTab;
  const openRef = useRef(onOpenTab);
  openRef.current = onOpenTab;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;

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
  const ownTabs = useMemo(() => tabs.filter((t) => !mode.isAgentTab(t)), [tabs, mode]);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;

  // Remember the last own center tab, so entering the workbench other than by
  // going into an agent never lands on an agent terminal you didn't enter.
  const lastOwnTab = useRef<number | null>(null);
  useEffect(() => {
    const t = tabsRef.current.find((x) => x.id === activeTabId);
    if (t && t.dockPosition === 'center' && !mode.isAgentTab(t)) lastOwnTab.current = t.id;
  }, [activeTabId, mode]);

  const prevMode = useRef(state.mode);
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = state.mode;
    if (!state.enabled || was !== 'cockpit' || state.mode !== 'workbench') return;
    const active = tabsRef.current.find((x) => x.id === activeRef.current);
    if (state.reason !== 'go_into' && active && mode.isAgentTab(active) && (active.ptyId == null || !state.enteredPtys.has(active.ptyId))) {
      const fallback = tabsRef.current.find((x) => x.id === lastOwnTab.current) ?? ownTabs.find((x) => x.dockPosition === 'center');
      if (fallback) openRef.current(fallback.id);
    }
    window.setTimeout(() => focusManager.refocus(), 0);
  }, [state.mode, state.enabled, state.enteredPtys, state.reason, mode, ownTabs]);

  const feedRows = useMemo(
    () =>
      mergeFeed({
        workspace,
        items: snapshot?.items,
        entries: cockpit.feed,
        events: hester.snapshot?.tasks.recent_events,
      }),
    [workspace, snapshot, cockpit.feed, hester.snapshot],
  );

  const needsCount = feedNeedsCount(feedRows);
  useEffect(() => {
    cockpitModeStore.setNeedsCount(needsCount);
  }, [needsCount]);

  const [toast, setToast] = useState<{ message: string; level: 'info' | 'error' } | null>(null);
  const notify = useCallback((message: string, level: 'info' | 'error' = 'info') => {
    setToast({ message, level });
  }, []);
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
      // Open first, then leave: the tab is active before the mode switch
      // checks what the Workbench lands on.
      Promise.resolve(open(path))
        .then(() => cockpitModeStore.apply(cockpitModeStore.decide({ kind: 'open_tab' })))
        .catch(() => notify('Could not open that file', 'error'));
    },
    [notify],
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
        if (!req.activate) cockpitModeStore.hold(3500);
        let tabId: number | null = null;
        try {
          tabId = await createRef.current(
            req.type === 'agent' ? 'agent' : 'terminal',
            'center',
            req.type === 'agent' ? req.provider || 'claude' : req.label,
            req.type === 'terminal' && req.command ? { command: req.command, args: req.args } : undefined,
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
  const [drawerFocus, setDrawerFocus] = useState(false);
  const rowsRef = useRef<RowHandle[]>([]);
  const registerRows = useCallback((rows: RowHandle[]) => {
    rowsRef.current = rows;
  }, []);
  const selectRow = useCallback((id: string) => cockpitModeStore.select({ kind: 'row', id }), []);
  const setSection = useCallback((section: SectionId) => cockpitModeStore.setSection(section), []);
  const openLauncher = useCallback((prefill?: LauncherPrefill) => setPopover({ kind: 'launcher', prefill }), []);
  const openReply = useCallback((item: AttentionItem, label: string) => setPopover({ kind: 'reply', item, label }), []);
  const openCheckin = useCallback((ptyId: number, label: string) => setPopover({ kind: 'checkin', ptyId, label }), []);

  useEffect(() => {
    if (!shown) setPopover(null);
  }, [shown]);

  // A popover that closes (Send, Launch, a click) unmounts the focused element and
  // focus falls to <body>, where the overlay's keymap never sees keys. Take it back.
  useEffect(() => {
    if (!shown || popover) return;
    const active = document.activeElement;
    if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true });
  }, [popover, shown]);

  const selectedTile = state.selected?.kind === 'tile' ? tiles.find((t) => String(t.ptyId) === state.selected?.id) ?? null : null;
  const selectedRow = state.selected?.kind === 'row' ? rowsRef.current.find((r) => r.id === state.selected?.id) ?? null : null;
  const aboutTitle = selectedTile?.title ?? selectedRow?.title ?? null;
  // "about:" for Ask Hester survives switching to the Copilot section (which
  // clears the selection): the last tile or non-Copilot row you selected.
  const [lastAbout, setLastAbout] = useState<string | null>(null);
  const selectedIsCopilotRow = state.selected?.kind === 'row' && state.selected.id.startsWith('copilot:');
  useEffect(() => {
    if (aboutTitle && !selectedIsCopilotRow) setLastAbout(aboutTitle);
  }, [aboutTitle, selectedIsCopilotRow]);
  // A fresh brief after an absence: a neutral dot on Copilot until you look.
  const [seenNonce, setSeenNonce] = useState(0);
  useEffect(() => {
    if (shown && state.section === 'copilot') setSeenNonce(returnNonce);
  }, [shown, state.section, returnNonce]);

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
      drawer: drawerFocus,
    });
    if (!act) return;
    e.preventDefault();
    const sel = state.selected;
    const tile = selectedTile;
    const row = selectedRow;
    switch (act.kind) {
      case 'section':
        setDrawerFocus(false);
        setSection(act.section);
        break;
      case 'row': {
        setDrawerFocus(false);
        const rows = rowsRef.current;
        if (!rows.length) break;
        const idx = sel?.kind === 'row' ? rows.findIndex((r) => r.id === sel.id) : -1;
        const next = idx < 0 ? (act.delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + act.delta));
        selectRow(rows[next].id);
        document.querySelector(`[data-cockpit-row="${CSS.escape(rows[next].id)}"]`)?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'tile': {
        setDrawerFocus(false);
        if (!tiles.length) break;
        const idx = tile ? tiles.indexOf(tile) : -1;
        const next = idx < 0 ? (act.delta > 0 ? 0 : tiles.length - 1) : Math.min(tiles.length - 1, Math.max(0, idx + act.delta));
        cockpitModeStore.select({ kind: 'tile', id: String(tiles[next].ptyId) });
        break;
      }
      case 'enter':
        if (tile) goInto(tile.ptyId, 'tile');
        else if (row?.open) row.open();
        else if (sel?.kind === 'drawer') openOwnTab(Number(sel.id));
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
      case 'launcher':
        openLauncher();
        break;
      case 'run':
        setPopover({ kind: 'run' });
        break;
      case 'dismiss':
        row?.dismiss?.();
        break;
      case 'drawer':
        setDrawerFocus(true);
        if (sel?.kind !== 'drawer' && ownTabs.length) cockpitModeStore.select({ kind: 'drawer', id: String(ownTabs[0].id) });
        break;
      case 'drawer-move': {
        if (!ownTabs.length) break;
        const idx = sel?.kind === 'drawer' ? ownTabs.findIndex((t) => t.id === Number(sel.id)) : -1;
        const next = idx < 0 ? 0 : Math.min(ownTabs.length - 1, Math.max(0, idx + act.delta));
        cockpitModeStore.select({ kind: 'drawer', id: String(ownTabs[next].id) });
        break;
      }
      case 'help':
        setPopover({ kind: 'help' });
        break;
      case 'escape':
        setDrawerFocus(false);
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
    focusPty,
    notify,
    openLauncher,
    openReply,
    openCheckin,
    registerRows,
    selectRow,
    setSection,
  };

  if (!state.enabled || !available || state.mode !== 'cockpit') return null;

  const badges: NavBadges = {
    copilot: copilotBadge({ returnNonce, seenNonce }),
    feed: { count: needsCount, ember: needsCount > 0 },
    tasks: tasksBadge(hester.snapshot?.tasks.open ?? []),
    ops: opsBadge({
      failing: (ops?.operations ?? []).filter((o) => o.status === 'failed' || o.status === 'crashed' || o.status === 'unhealthy').length,
      proposals: ops?.proposals.length ?? 0,
      suggestions: ops?.suggestions.length ?? 0,
    }),
    files: { count: 0, ember: false },
    someday: { count: hester.snapshot?.someday.open ?? 0, ember: (hester.snapshot?.someday.untriaged_over_7d ?? 0) > 0 },
    tabs: { count: tabs.length, ember: false },
    history: { count: 0, ember: false },
  };

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
      <CockpitHeader
        workspace={workspace}
        focusActive={!!snapshot?.focus.active}
        copilotApi={copilotApi}
        toast={toast}
        onLaunch={() => openLauncher()}
        onRun={() => setPopover({ kind: 'run' })}
        onHelp={() => setPopover({ kind: 'help' })}
      />
      <div className="cockpit-body">
        <CockpitNav section={section} badges={badges} onSelect={setSection} />
        <div className="cockpit-center">
          <AgentTiles ctx={ctx} />
          <div className="cockpit-section">
            {section === 'copilot' && (
              <CopilotSection
                ctx={ctx}
                about={lastAbout}
                onClearAbout={() => setLastAbout(null)}
                onAsk={onAskHester}
                returnNonce={returnNonce}
              />
            )}
            {section === 'feed' && <FeedSection ctx={ctx} />}
            {section === 'tasks' && <TasksSection ctx={ctx} />}
            {section === 'ops' && <OperationsSection ctx={ctx} />}
            {section === 'files' && <FilesSection ctx={ctx} />}
            {section === 'someday' && <SomedaySection ctx={ctx} />}
            {section === 'tabs' && <TabsSection ctx={ctx} />}
            {section === 'history' && <HistorySection ctx={ctx} />}
          </div>
        </div>
      </div>
      <TabDrawer
        tabs={ownTabs}
        focused={drawerFocus}
        selectedId={state.selected?.kind === 'drawer' ? Number(state.selected.id) : null}
        onFocusChange={setDrawerFocus}
        onSelect={(id) => cockpitModeStore.select({ kind: 'drawer', id: String(id) })}
        onOpen={openOwnTab}
      />
      {popover?.kind === 'launcher' && (
        <Launcher ctx={ctx} prefill={popover.prefill} onClose={() => setPopover(null)} />
      )}
      {popover?.kind === 'run' && <RunMenu ctx={ctx} onClose={() => setPopover(null)} />}
      {popover?.kind === 'help' && <KeyHelp onClose={() => setPopover(null)} />}
      {popover?.kind === 'reply' && copilotApi && (
        <ReplyPopover api={copilotApi} item={popover.item} label={popover.label} onClose={() => setPopover(null)} onError={(m) => notify(m, 'error')} />
      )}
      {popover?.kind === 'checkin' && api && (
        <CheckinPopover api={api} ptyId={popover.ptyId} label={popover.label} onClose={() => setPopover(null)} notify={notify} />
      )}
    </div>,
    document.body,
  );
};

export default CockpitHost;
