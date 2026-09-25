/**
 * Lee App - Main React component
 *
 * The "Meta-IDE" interface with tab management, dockable panels, and terminal rendering.
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { TabBar, Tab, DockPosition, NewTabOption } from './components/TabBar';
import { TerminalPane } from './components/TerminalPane';
import { TitleBar } from './components/TitleBar';
import { WorkspaceModal } from './components/WorkspaceModal';
import { ConfigEditorModal } from './components/ConfigEditorModal';
import { CommandPalette } from './components/CommandPalette';
import { PanelLayout, DockableTab } from './components/PanelLayout';
import { FileTreePane } from './components/FileTreePane';
import { EditorPanel } from './components/EditorPanel';
import { BrowserPane } from './components/BrowserPane';
import { StatusBar, StatusMessage, DaemonStatus } from './components/StatusBar';
import { LibraryPane } from './components/LibraryPane';
import { WorkstreamPane } from './components/workstream/WorkstreamPane';
import { WorkstreamPickerModal } from './components/WorkstreamPickerModal';
import { SpyglassPane } from './components/SpyglassPane';
import { KiCadPane } from './components/KiCadPane';
import { ModelViewerPane } from './components/ModelViewerPane';
import { BinaryFilePane } from './components/BinaryFilePane';
import { PdfPane } from './components/PdfPane';
import { BridgePicker } from './components/BridgePicker';
import { PairingDialog } from './components/PairingDialog';
import { GlobalConfigEditorModal } from './components/GlobalConfigEditorModal';
import { Icon } from './components/Icon';
import { useHotkeys } from './hooks/useHotkeys';
import { rendererShortcuts, resolveChord, formatChord } from '../shared/shortcuts';
import { focusManager } from './hooks/useFocusManager';
import { ptyEventManager } from './hooks/usePtyEvents';

// Get the Lee API from preload
const lee = window.lee;

// File extensions routed to dedicated viewer tabs instead of the text editor
const KICAD_EXTENSIONS = ['kicad_sch', 'kicad_pcb'];
const MODEL_EXTENSIONS = ['step', 'stp', 'stl', 'obj', '3mf', 'gltf', 'glb', 'iges', 'igs', 'brep', 'f3d', 'f3z'];
const PDF_EXTENSIONS = ['pdf'];
// Tab types whose whole content is a file on disk — restored by reopening it
const FILE_BACKED_TAB_TYPES: Tab['type'][] = ['file', 'kicad', 'model', 'pdf', 'binary', 'browser'];
// Extensions Chromium renders natively — opened in a browser tab at a file:// URL
const BROWSER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'html', 'htm'];

// Check if we're running inside Electron
const isElectron = !!lee;


export interface TabData extends Tab {
  ptyId: number | null;
  dockPosition: DockPosition;
  // File-specific data (for type='file')
  fileContent?: string;
  fileOriginalContent?: string;
  /**
   * mtime (epoch ms) of the bytes currently in the buffer - set on open and
   * after every successful save. A different mtime on disk means someone
   * else (an agent, a build step, git) wrote the file (C4).
   */
  fileMtime?: number | null;
  /** True once the watched file disappears from disk; the buffer stays open. */
  fileDeleted?: boolean;
  // Browser-specific data (for type='browser')
  browserWebviewId?: number; // WebContents ID for IPC
  browserErrorCount?: number; // Console error count for watched browser tabs
  browserCheckpointReady?: boolean; // True when session+email captured for Frame checkpoint
  // Workstream-specific data (for type='workstream')
  workstreamId?: string;
  // Machine-specific data (for type='spyglass' or 'bridge')
  machineConfig?: {
    name: string;
    emoji: string;
    host: string;
    user: string;
    ssh_port: number;
    lee_port: number;
    hester_port: number;
  };
}

const App: React.FC = () => {
  const [tabs, setTabs] = useState<TabData[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeLeftTabId, setActiveLeftTabId] = useState<number | null>(null);
  const [activeRightTabId, setActiveRightTabId] = useState<number | null>(null);
  const [activeBottomTabId, setActiveBottomTabId] = useState<number | null>(null);
  const [focusedPanel, setFocusedPanel] = useState<'center' | 'left' | 'right' | 'bottom'>('center');
  const [workspace, setWorkspace] = useState<string>('');
  const [showWorkspaceModal, setShowWorkspaceModal] = useState<boolean>(false);
  const [showCommandPalette, setShowCommandPalette] = useState<boolean>(false);
  const [workspaceInitialized, setWorkspaceInitialized] = useState<boolean>(false);
  const [sessionRestored, setSessionRestored] = useState(false);
  const nextTabIdRef = useRef(1);
  const tabsRef = useRef<TabData[]>([]);
  const closeTabRef = useRef<((tabId: number) => void) | null>(null);
  const isSwitchingRef = useRef(false);

  // Track editor daemon port from state updates
  const [editorDaemonPort, setEditorDaemonPort] = useState<number | null>(null);

  // Status message queue from Hester
  const [statusMessages, setStatusMessages] = useState<StatusMessage[]>([]);

  /**
   * C22: one place that turns "something went wrong" into something the user
   * can actually see. Everything in the renderer that used to `console.error`
   * on a user-initiated path now calls this.
   *
   * `error` messages stick around until dismissed; everything else expires.
   */
  const notify = useCallback((
    level: 'info' | 'success' | 'warn' | 'error',
    message: string,
    opts?: { ttl?: number; prompt?: string; id?: string },
  ) => {
    const type = level === 'warn' ? 'warning' : level;
    const id = opts?.id ?? `${level}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ttl = opts?.ttl ?? (level === 'error' ? 0 : 8);
    setStatusMessages((prev) => [
      ...prev.filter((m) => m.id !== id),
      {
        id,
        message,
        type,
        timestamp: Date.now(),
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        ...(ttl ? { ttl } : {}),
      },
    ]);
    if (ttl) {
      setTimeout(() => {
        setStatusMessages((prev) => prev.filter((m) => m.id !== id));
      }, ttl * 1000);
    }
  }, []);

  // Stable handle for use inside effects and IPC callbacks without dragging
  // `notify` through every dependency array.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // Prompt to send immediately when opening command palette
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  // Whether to auto-submit the pending prompt (default true for most cases)
  const [autoSubmitPrompt, setAutoSubmitPrompt] = useState<boolean>(true);

  // Hester daemon health status
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>('checking');
  const HESTER_DAEMON_PORT = 9000;

  // Workspace config (keybindings, tuis, etc.)
  const [config, setConfig] = useState<any>(null);

  // Config editor modal
  const [showConfigEditor, setShowConfigEditor] = useState<boolean>(false);
  const [configEditorInitialSection, setConfigEditorInitialSection] = useState<'tuis' | 'keybindings' | 'terminal' | 'hester' | 'raw' | undefined>(undefined);

  // Global config editor modal
  const [showGlobalConfigEditor, setShowGlobalConfigEditor] = useState<boolean>(false);

  // TUI options for the new-tab dropdown (fetched from main process)
  const [tuiOptions, setTuiOptions] = useState<NewTabOption[]>([]);

  // Agent providers (fetched from main process, includes config-defined providers)
  const [agentProviders, setAgentProviders] = useState<Record<string, { name: string; icon?: string; command: string }>>({});

  // Provider switcher dialog for agent tabs
  const [switchProviderDialog, setSwitchProviderDialog] = useState<{
    tabId: number;
    newProvider: string;
  } | null>(null);

  // Workstream picker modal
  const [showWorkstreamPicker, setShowWorkstreamPicker] = useState<boolean>(false);

  // Bridge picker modal
  const [showBridgePicker, setShowBridgePicker] = useState(false);

  // Aeronaut pairing dialog
  const [showPairingDialog, setShowPairingDialog] = useState(false);
  const [bridgePreselectedMachine, setBridgePreselectedMachine] = useState<any>(null);

  // Chords come from the shared registry (src/shared/shortcuts.ts), which also
  // generates the application menu's accelerators and docs/shortcuts.md, so a
  // chord can't be owned by two surfaces at once (C15). `keybindings:` in
  // config.yaml still overrides any of them by action name.
  const getKeybinding = useCallback((action: string, defaultBinding: string): string => {
    return resolveChord(action, config?.keybindings) || defaultBinding;
  }, [config]);

  const formatKeybinding = useCallback((binding: string): string => formatChord(binding), []);

  // Get formatted keybinding for display
  const getDisplayKeybinding = useCallback((action: string, defaultBinding: string): string => {
    return formatChord(getKeybinding(action, defaultBinding));
  }, [getKeybinding]);

  // Keep refs in sync for use in event handlers (avoids stale closures)
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Filter tabs by dock position - memoize to prevent unnecessary re-renders
  const centerTabs = useMemo(() => tabs.filter(t => t.dockPosition === 'center'), [tabs]);
  const leftTabs = useMemo(() => tabs.filter(t => t.dockPosition === 'left'), [tabs]);
  const rightTabs = useMemo(() => tabs.filter(t => t.dockPosition === 'right'), [tabs]);
  const bottomTabs = useMemo(() => tabs.filter(t => t.dockPosition === 'bottom'), [tabs]);

  // Get localStorage key for workspace session
  const getSessionStorageKey = useCallback((ws: string) => `lee:session:${ws}`, []);

  // Session data structure for persistence
  interface SessionTab {
    type: Tab['type'];
    label: string;
    dockPosition: DockPosition;
    // File-backed tabs (editor and viewers) are restored by reopening this path
    filePath?: string;
    // Agent tabs: the actual provider key (e.g. 'claude', 'hester', or a
    // custom key from config) — label is only the display name and may not
    // match the key, so restoring via label breaks non-default providers.
    // Older sessions won't have this; restore falls back to the label.
    provider?: string;
  }

  // Save session (open tabs and their positions) to localStorage
  const saveSession = useCallback((currentTabs: TabData[], ws: string) => {
    if (!ws) return;
    const sessionTabs: SessionTab[] = currentTabs.map(t => ({
      type: t.type,
      label: t.label,
      dockPosition: t.dockPosition,
      ...(t.filePath ? { filePath: t.filePath } : {}),
      ...(t.type === 'agent' && t.provider ? { provider: t.provider } : {}),
    }));
    const storageKey = getSessionStorageKey(ws);
    console.log('[Lee] Saving session:', storageKey, sessionTabs);
    localStorage.setItem(storageKey, JSON.stringify(sessionTabs));
  }, [getSessionStorageKey]);

  // Load session from localStorage
  const loadSession = useCallback((ws: string): SessionTab[] | null => {
    if (!ws) return null;
    try {
      const storageKey = getSessionStorageKey(ws);
      const stored = localStorage.getItem(storageKey);
      console.log('[Lee] Loading session:', storageKey, stored);
      if (stored) {
        return JSON.parse(stored) as SessionTab[];
      }
    } catch (e) {
      console.error('Failed to load session:', e);
    }
    return null;
  }, [getSessionStorageKey]);

  // Create a new tab - defined BEFORE useEffects that depend on it
  // spawnOptions: only consulted for type === 'terminal' — lets a caller (the
  // ui_control `tui custom` command) run a specific command/args instead of
  // the default login shell, while still going through normal tab creation.
  const createTab = useCallback(async (type: Tab['type'], dockPosition?: DockPosition, label?: string, spawnOptions?: { command?: string; args?: string[] }) => {
    // Bridge type opens the picker instead of creating a tab directly
    if (type === 'bridge' as any) {
      setBridgePreselectedMachine(null);
      setShowBridgePicker(true);
      return null;
    }

    // Non-PTY tabs that don't need Electron
    const nonPtyTabs: Tab['type'][] = ['files', 'editor-panel', 'browser', 'library', 'workstream', 'spyglass', 'kicad', 'model', 'pdf', 'binary'];

    if (!isElectron && !nonPtyTabs.includes(type)) {
      console.warn('Cannot create tab - not running in Electron');
      return null;
    }

    const tabId = nextTabIdRef.current++;
    let ptyId: number | null = null;
    const tabLabel = label || getDefaultLabel(type);

    // Non-PTY tabs don't spawn a process
    if (!nonPtyTabs.includes(type)) {
      try {
        switch (type) {
          case 'editor':
            // Legacy: Convert old Python editor to new editor-panel
            // This ensures saved sessions with 'editor' type still work
            console.log('[Lee] Converting legacy editor tab to editor-panel');
            return createTab('editor-panel', dockPosition, label || 'Editor');
          case 'terminal':
            ptyId = await lee.pty.spawn(spawnOptions?.command, spawnOptions?.args, workspace, tabLabel);
            break;
          case 'git':
            ptyId = await lee.pty.spawnTUI('git', workspace);
            break;
          case 'docker':
            ptyId = await lee.pty.spawnTUI('docker');
            break;
          case 'k8s':
            ptyId = await lee.pty.spawnTUI('k8s');
            break;
          case 'flutter':
            ptyId = await lee.pty.spawnTUI('flutter', workspace);
            break;
          case 'hester':
            ptyId = await lee.pty.spawnTUI('hester', workspace);
            break;
          case 'claude':
            ptyId = await lee.pty.spawnTUI('claude', workspace);
            break;
          case 'hester-qa':
            ptyId = await lee.pty.spawnTUI('hester-qa', workspace);
            break;
          case 'devops':
            ptyId = await lee.pty.spawnTUI('devops', workspace);
            break;
          case 'system':
            ptyId = await lee.pty.spawnTUI('system');
            break;
          case 'sql':
            ptyId = await lee.pty.spawnTUI('sql', workspace);
            break;
          case 'agent': {
            // label is used as the provider key when creating agent tabs
            const provider = label || 'hester';
            ptyId = await lee.pty.spawnAgent(provider, workspace);
            break;
          }
        }
        // Mark this PTY as expected so data is buffered until handler registers
        if (ptyId !== null) {
          ptyEventManager.expect(ptyId);
        }
      } catch (error) {
        console.error(`Failed to spawn ${type}:`, error);
        notify('warn', `Couldn't open ${label || type}: ${error instanceof Error ? error.message : String(error)}`, {
          id: `spawn-fail-${type}`,
        });
        return null;
      }
    }

    // Use provided dock position or default to center
    const finalDockPosition = dockPosition ?? 'center';

    // For agent tabs, use the provider key as label during creation, then set display label
    const agentProvider = type === 'agent' ? (label || 'hester') : undefined;
    const displayLabel = type === 'agent'
      ? (agentProviders[agentProvider!]?.name ?? agentProvider!)
      : tabLabel;

    const newTab: TabData = {
      id: tabId,
      type,
      label: displayLabel,
      closable: true, // All tabs are closable
      ptyId,
      dockPosition: finalDockPosition,
      ...(agentProvider ? { provider: agentProvider } : {}),
    };

    // Record action for activity tracking
    if (isElectron) {
      lee.context.recordAction('tab_create', `${tabId}:${type}`);
    }

    setTabs((prev) => [...prev, newTab]);

    // Set active tab for the appropriate panel and track focus
    switch (finalDockPosition) {
      case 'left':
        setActiveLeftTabId(tabId);
        setFocusedPanel('left');
        break;
      case 'right':
        setActiveRightTabId(tabId);
        setFocusedPanel('right');
        break;
      case 'bottom':
        setActiveBottomTabId(tabId);
        setFocusedPanel('bottom');
        break;
      default:
        setActiveTabId(tabId);
        setFocusedPanel('center');
    }

    return tabId;
  }, [workspace, agentProviders, notify]);

  // Move a tab to a different dock position
  const dockTab = useCallback((tabId: number, newPosition: DockPosition) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const oldPosition = tab.dockPosition;

    // Update the tab's dock position
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, dockPosition: newPosition } : t))
    );

    // Clear active state from old position
    switch (oldPosition) {
      case 'left':
        if (activeLeftTabId === tabId) {
          const remaining = leftTabs.filter((t) => t.id !== tabId);
          setActiveLeftTabId(remaining.length > 0 ? remaining[0].id : null);
        }
        break;
      case 'right':
        if (activeRightTabId === tabId) {
          const remaining = rightTabs.filter((t) => t.id !== tabId);
          setActiveRightTabId(remaining.length > 0 ? remaining[0].id : null);
        }
        break;
      case 'bottom':
        if (activeBottomTabId === tabId) {
          const remaining = bottomTabs.filter((t) => t.id !== tabId);
          setActiveBottomTabId(remaining.length > 0 ? remaining[0].id : null);
        }
        break;
      default:
        if (activeTabId === tabId) {
          const remaining = centerTabs.filter((t) => t.id !== tabId);
          setActiveTabId(remaining.length > 0 ? remaining[0].id : null);
        }
    }

    // Set active state for new position
    switch (newPosition) {
      case 'left':
        setActiveLeftTabId(tabId);
        break;
      case 'right':
        setActiveRightTabId(tabId);
        break;
      case 'bottom':
        setActiveBottomTabId(tabId);
        break;
      default:
        setActiveTabId(tabId);
    }

    // Save session to localStorage
    const updatedTabs = tabs.map((t) => (t.id === tabId ? { ...t, dockPosition: newPosition } : t));
    saveSession(updatedTabs, workspace);
  }, [tabs, centerTabs, leftTabs, rightTabs, bottomTabs, activeTabId, activeLeftTabId, activeRightTabId, activeBottomTabId, workspace, saveSession]);

  // ---------------------------------------------------------------------
  // C4: external-change detection
  //
  // The editor is not the only writer of an open file - agents, builds and
  // git all are. Every file tab records the mtime of the bytes in its buffer
  // (`fileMtime`), the main process watches the file (fs:watchFile), and the
  // two are compared on change, on focus, and immediately before a save so
  // Cmd+S can't silently clobber someone else's work.
  // ---------------------------------------------------------------------

  /** mtimes only ever differ by whole milliseconds; treat sub-ms as equal. */
  const mtimeMatches = (a: number | null | undefined, b: number | null): boolean =>
    a != null && b != null && Math.abs(a - b) < 1;

  /** Paths with an external-change prompt already on screen. */
  const externalPromptsRef = useRef<Set<string>>(new Set());

  /** Reload a file tab's buffer from disk, discarding whatever it held. */
  const reloadFileTab = useCallback(async (tabId: number, filePath: string) => {
    const content = await lee.fs.readFile(filePath);
    const stat = await lee.fs.stat(filePath);
    setTabs((prev) => prev.map((t) => (t.id === tabId
      ? {
          ...t,
          fileContent: content,
          fileOriginalContent: content,
          fileModified: false,
          fileMtime: stat?.mtime ?? null,
          fileDeleted: false,
        }
      : t)));
  }, []);

  /**
   * Write a file tab to disk, asking first if the file changed underneath us.
   * Returns true when the bytes actually landed.
   */
  const saveTabToDisk = useCallback(async (tab: TabData): Promise<boolean> => {
    if (!isElectron || !tab.filePath) return false;

    try {
      const before = await lee.fs.stat(tab.filePath);
      const diskMtime = before?.mtime ?? null;
      const changedUnderUs = diskMtime !== null && !mtimeMatches(tab.fileMtime, diskMtime);

      if (changedUnderUs) {
        const choice = await lee.dialog.confirm({
          type: 'warning',
          title: 'File changed on disk',
          message: `"${tab.label}" has changed on disk since you opened it.`,
          detail: 'Saving now replaces those changes with your version of the file.',
          buttons: ['Overwrite', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        });
        if (choice !== 0) {
          notify('info', `Save cancelled — "${tab.label}" changed on disk`, { ttl: 6 });
          return false;
        }
      }

      const result = await lee.fs.writeFile(tab.filePath, tab.fileContent || '');
      if (!result.success) {
        notify('error', `Couldn't save "${tab.label}": ${result.error || 'unknown error'}`);
        return false;
      }

      const after = await lee.fs.stat(tab.filePath);
      setTabs((prev) => prev.map((t) => (t.id === tab.id
        ? {
            ...t,
            fileModified: false,
            fileOriginalContent: t.fileContent,
            fileMtime: after?.mtime ?? null,
            fileDeleted: false,
          }
        : t)));
      lee.context.recordAction('file_save', tab.filePath);
      return true;
    } catch (error) {
      notify('error', `Couldn't save "${tab.label}": ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }, [notify]);

  /** React to a watched file changing (or disappearing) on disk. */
  const handleExternalFileChange = useCallback(async (filePath: string, diskMtime: number | null) => {
    const affected = tabsRef.current.filter((t) => t.type === 'file' && t.filePath === filePath);

    for (const tab of affected) {
      if (diskMtime === null) {
        if (!tab.fileDeleted) {
          setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, fileDeleted: true } : t)));
          notifyRef.current('warn', `"${tab.label}" was deleted on disk — the buffer is still open`);
        }
        continue;
      }

      // Our own save, echoed back by the watcher.
      if (mtimeMatches(tab.fileMtime, diskMtime)) continue;

      if (!tab.fileModified) {
        try {
          await reloadFileTab(tab.id, filePath);
          notifyRef.current('info', `Reloaded ${tab.label} (changed on disk)`, { ttl: 5, id: `reload-${tab.id}` });
        } catch (error) {
          notifyRef.current('error', `Couldn't reload "${tab.label}": ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      // Dirty buffer: let the user decide. One prompt per path at a time.
      if (externalPromptsRef.current.has(filePath)) continue;
      externalPromptsRef.current.add(filePath);
      try {
        const choice = await lee.dialog.confirm({
          type: 'warning',
          title: 'File changed on disk',
          message: `"${tab.label}" changed on disk while you were editing it.`,
          detail:
            'Reload discards your unsaved edits and loads the version on disk.\n' +
            'Keep mine leaves your buffer untouched; saving it will ask before overwriting.',
          buttons: ['Reload (discard my edits)', 'Keep mine'],
          defaultId: 1,
          cancelId: 1,
        });
        if (choice === 0) {
          await reloadFileTab(tab.id, filePath);
        } else {
          setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, fileDeleted: false } : t)));
        }
      } finally {
        externalPromptsRef.current.delete(filePath);
      }
    }
  }, [reloadFileTab]);

  /**
   * Backstop for the watcher: fs.watch misses events on some filesystems
   * (network mounts, containers), so re-check every open file whenever the
   * window regains focus.
   */
  const checkOpenFilesForExternalChanges = useCallback(async () => {
    if (!isElectron) return;
    for (const tab of tabsRef.current) {
      if (tab.type !== 'file' || !tab.filePath) continue;
      const stat = await lee.fs.stat(tab.filePath);
      const diskMtime = stat?.mtime ?? null;
      if (mtimeMatches(tab.fileMtime, diskMtime)) continue;
      if (diskMtime === null && tab.fileDeleted) continue;
      await handleExternalFileChange(tab.filePath, diskMtime);
    }
  }, [handleExternalFileChange]);

  // Close a tab
  const closeTab = useCallback(async (tabId: number) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !tab.closable) return;

    // Unsaved-changes guard: only 'file' tabs (the code editor) track
    // fileModified. A real three-button native dialog (C25) replaces the two
    // chained window.confirm() prompts this used to need.
    if (tab.type === 'file' && tab.fileModified && isElectron) {
      const choice = await lee.dialog.confirm({
        type: 'warning',
        title: 'Unsaved changes',
        message: `"${tab.label}" has unsaved changes.`,
        detail: 'Save them before closing the tab?',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice === 2) return; // Cancel - leave the tab open
      if (choice === 0) {
        const saved = await saveTabToDisk(tab);
        if (!saved) return; // Save failed or was cancelled - keep the tab
      }
    }

    // Stop watching the file unless another tab still has it open (C4)
    if (isElectron && tab.type === 'file' && tab.filePath) {
      const stillOpen = tabsRef.current.some(
        (t) => t.id !== tabId && t.type === 'file' && t.filePath === tab.filePath,
      );
      if (!stillOpen) lee.fs.unwatchFile(tab.filePath);
    }

    // Record action for activity tracking
    if (isElectron) {
      lee.context.recordAction('tab_close', `${tabId}:${tab.type}`);
    }

    // Kill the PTY process if it exists
    if (tab.ptyId !== null && isElectron) {
      lee.pty.kill(tab.ptyId);
    }

    setTabs((prev) => prev.filter((t) => t.id !== tabId));

    // Clear active tab for the appropriate panel
    switch (tab.dockPosition) {
      case 'left':
        if (activeLeftTabId === tabId) {
          const remaining = leftTabs.filter((t) => t.id !== tabId);
          setActiveLeftTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
        }
        break;
      case 'right':
        if (activeRightTabId === tabId) {
          const remaining = rightTabs.filter((t) => t.id !== tabId);
          setActiveRightTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
        }
        break;
      case 'bottom':
        if (activeBottomTabId === tabId) {
          const remaining = bottomTabs.filter((t) => t.id !== tabId);
          setActiveBottomTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
        }
        break;
      default:
        if (activeTabId === tabId) {
          const remaining = centerTabs.filter((t) => t.id !== tabId);
          setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
        }
    }

    // Save session to localStorage (without the closed tab)
    const remainingTabs = tabs.filter((t) => t.id !== tabId);
    saveSession(remainingTabs, workspace);
  }, [tabs, centerTabs, leftTabs, rightTabs, bottomTabs, activeTabId, activeLeftTabId, activeRightTabId, activeBottomTabId, workspace, saveSession, saveTabToDisk]);

  // Keep closeTabRef in sync for use in event handlers (avoids stale closures)
  useEffect(() => {
    closeTabRef.current = closeTab;
  }, [closeTab]);

  // Close all tabs and kill their PTY processes (used during workspace switch).
  // Returns false (and leaves everything open) if the user cancels a
  // dirty-files prompt.
  const closeAllTabs = useCallback(async (): Promise<boolean> => {
    const dirtyCount = tabsRef.current.filter((t) => t.type === 'file' && t.fileModified).length;
    if (dirtyCount > 0 && isElectron) {
      const choice = await lee.dialog.confirm({
        type: 'warning',
        title: 'Unsaved changes',
        message: `${dirtyCount} file${dirtyCount > 1 ? 's have' : ' has'} unsaved changes.`,
        detail: 'Closing them now discards those changes.',
        buttons: ['Discard and Close', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice !== 0) return false;
    }

    for (const tab of tabsRef.current) {
      if (tab.ptyId !== null && isElectron) {
        lee.pty.kill(tab.ptyId);
      }
      if (isElectron && tab.type === 'file' && tab.filePath) {
        lee.fs.unwatchFile(tab.filePath);
      }
    }
    ptyEventManager.clearAll();
    setTabs([]);
    setActiveTabId(null);
    setActiveLeftTabId(null);
    setActiveRightTabId(null);
    setActiveBottomTabId(null);
    return true;
  }, []);

  // Switch to a new workspace: save old session, close tabs, restore new session
  const switchWorkspace = useCallback(async (newWorkspace: string) => {
    if (newWorkspace === workspace) return;

    isSwitchingRef.current = true;

    // Save current tabs to the OLD workspace's session before switching
    saveSession(tabsRef.current, workspace);

    if (!(await closeAllTabs())) {
      // User cancelled the unsaved-changes prompt - abort the switch.
      isSwitchingRef.current = false;
      return;
    }

    // Reset session restore gate so the restore effect re-triggers for the new workspace
    setSessionRestored(false);

    // Set new workspace
    setWorkspace(newWorkspace);
    setWorkspaceInitialized(true);

    // Update localStorage
    localStorage.setItem('lee:lastWorkspace', newWorkspace);

    // Update recent workspaces list
    const stored = localStorage.getItem('lee:recentWorkspaces');
    let workspaces: { path: string; lastOpened: string }[] = stored ? JSON.parse(stored) : [];
    workspaces = workspaces.filter(w => w.path !== newWorkspace);
    workspaces.unshift({ path: newWorkspace, lastOpened: new Date().toISOString() });
    workspaces = workspaces.slice(0, 10);
    localStorage.setItem('lee:recentWorkspaces', JSON.stringify(workspaces));

    // Prewarm PTYs for the new workspace
    if (isElectron) {
      lee.pty.prewarm(newWorkspace);
    }

    // Clear the switching guard after current React batch completes
    setTimeout(() => { isSwitchingRef.current = false; }, 0);
  }, [workspace, saveSession, closeAllTabs]);

  // Rename a tab
  const renameTab = useCallback((tabId: number, newLabel: string) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, label: newLabel } : tab
    ));
  }, []);

  // Toggle watch state for agent tabs only
  const toggleWatch = useCallback((tabId: number) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId && tab.type === 'agent' ? { ...tab, watched: !tab.watched, isIdle: false } : tab
    ));
  }, []);

  // Handle provider switch request from tab context menu
  const handleSwitchAgentProvider = useCallback((tabId: number, newProvider: string) => {
    setSwitchProviderDialog({ tabId, newProvider });
  }, []);

  // Confirm provider switch — either respawn in-place or open new tab
  const confirmSwitchProvider = useCallback(async (mode: 'reload' | 'new-tab') => {
    if (!switchProviderDialog) return;
    const { tabId, newProvider } = switchProviderDialog;
    setSwitchProviderDialog(null);

    if (mode === 'new-tab') {
      createTab('agent' as Tab['type'], undefined, newProvider);
      return;
    }

    // Reload in-place: kill old PTY and respawn with new provider
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;

    if (tab.ptyId !== null && isElectron) {
      // Best-effort: the old PTY is being replaced either way, and it may
      // already have exited on its own.
      try { await lee.pty.kill(tab.ptyId); } catch { /* already gone */ }
    }

    try {
      const ptyId = await lee.pty.spawnAgent(newProvider, workspace);
      ptyEventManager.expect(ptyId);
      const providerDef = agentProviders[newProvider];
      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, ptyId, provider: newProvider, label: providerDef?.name ?? newProvider }
          : t
      ));
    } catch (error) {
      console.error('Failed to switch agent provider:', error);
      notify('error', `Couldn't start ${newProvider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [switchProviderDialog, workspace, agentProviders, notify]);

  // Handle idle state change from TerminalPane
  const handleIdleChange = useCallback((ptyId: number, isIdle: boolean) => {
    setTabs(prev => prev.map(tab =>
      tab.ptyId === ptyId ? { ...tab, isIdle } : tab
    ));
  }, []);

  // Get or create singleton tab (for TUIs that should only have one instance)
  const getOrCreateTab = useCallback((type: Tab['type'], dockPosition?: DockPosition, label?: string) => {
    const existing = tabs.find((t) => t.type === type);
    if (existing) {
      // Set active for the correct panel
      switch (existing.dockPosition) {
        case 'left':
          setActiveLeftTabId(existing.id);
          break;
        case 'right':
          setActiveRightTabId(existing.id);
          break;
        case 'bottom':
          setActiveBottomTabId(existing.id);
          break;
        default:
          setActiveTabId(existing.id);
      }
      return existing.id;
    }
    return createTab(type, dockPosition, label);
  }, [tabs, createTab]);

  // Get language name for file
  const getLanguageName = useCallback((filePath: string): string => {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      py: 'python', pyw: 'python',
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      md: 'markdown', mdx: 'markdown',
      html: 'html', htm: 'html',
      css: 'css', scss: 'scss', less: 'less',
      json: 'json', yaml: 'yaml', yml: 'yaml',
      sql: 'sql', rs: 'rust', go: 'go', java: 'java',
      c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'c', hpp: 'cpp',
      sh: 'bash', bash: 'bash', zsh: 'zsh',
    };
    return langMap[ext] || 'text';
  }, []);

  // Handle file selection from file tree - opens as new tab
  // Routes KiCad and 3D model files to dedicated viewer tabs; everything else
  // opens in the text editor. Pass forceText to open a viewer-routed file as text.
  const handleFileOpen = useCallback(async (filePath: string, opts?: { forceText?: boolean }) => {
    console.log('Opening file:', filePath);

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    let type: Tab['type'] = 'file';
    if (!opts?.forceText) {
      if (KICAD_EXTENSIONS.includes(ext)) type = 'kicad';
      else if (MODEL_EXTENSIONS.includes(ext)) type = 'model';
      else if (PDF_EXTENSIONS.includes(ext)) type = 'pdf';
      else if (BROWSER_EXTENSIONS.includes(ext)) type = 'browser';
    }

    // Check if file is already open. An unknown file may have landed in a
    // 'binary' tab — clicking it again should refocus that tab, but an
    // explicit forceText open should still create the text tab.
    const existingTab = tabs.find(
      (t) =>
        t.filePath === filePath &&
        (t.type === type || (type === 'file' && !opts?.forceText && t.type === 'binary'))
    );
    if (existingTab) {
      setActiveTabId(existingTab.id);
      setFocusedPanel('center');
      return existingTab.id;
    }

    if (!isElectron) {
      console.warn('Cannot open file - not running in Electron');
      return null;
    }

    try {
      const fileName = filePath.split('/').pop() || filePath;
      const tabId = nextTabIdRef.current++;
      let newTab: TabData;

      if (type === 'browser') {
        // Images, HTML, PDFs — Chromium renders these natively in a browser tab
        const fileUrl = `file://${filePath.split('/').map(encodeURIComponent).join('/')}`;
        newTab = {
          id: tabId,
          type,
          label: fileName,
          closable: true,
          ptyId: null,
          dockPosition: 'center',
          filePath,
          browserUrl: fileUrl,
        };
      } else if (type === 'kicad' || type === 'model' || type === 'pdf') {
        // Viewer tabs load their own content (model files can be large binaries)
        newTab = {
          id: tabId,
          type,
          label: fileName,
          closable: true,
          ptyId: null,
          dockPosition: 'center',
          filePath,
        };
      } else {
        // Binary guard (git's heuristic): a NUL byte in the first 8KB means
        // this isn't text — show the hex interstitial instead of mojibake.
        // forceText skips the guard; sniff failures fall through to text.
        let isBinary = false;
        if (!opts?.forceText) {
          try {
            const chunk = await lee.fs.readFileChunkBase64(filePath, 8192);
            const bytes = Uint8Array.from(atob(chunk.base64), (c) => c.charCodeAt(0));
            isBinary = bytes.includes(0);
          } catch {
            // unreadable for sniffing — let the text path surface the error
          }
        }

        if (isBinary) {
          newTab = {
            id: tabId,
            type: 'binary',
            label: fileName,
            closable: true,
            ptyId: null,
            dockPosition: 'center',
            filePath,
          };
        } else {
          const content = await lee.fs.readFile(filePath);
          const language = getLanguageName(filePath);
          // Record the mtime of exactly these bytes and start watching the
          // file, so an agent editing it underneath us is detected (C4).
          const stat = await lee.fs.stat(filePath);
          newTab = {
            id: tabId,
            type: 'file',
            label: fileName,
            closable: true,
            ptyId: null,
            dockPosition: 'center',
            filePath,
            fileLanguage: language,
            fileModified: false,
            fileContent: content,
            fileOriginalContent: content,
            fileMtime: stat?.mtime ?? null,
          };
          lee.fs.watchFile(filePath);
        }
      }

      lee.context.recordAction('file_open', filePath);
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      setFocusedPanel('center');
      return tabId;
    } catch (error) {
      console.error('Failed to open file:', error);
      notify('error', `Couldn't open ${filePath.split('/').pop()}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, [tabs, getLanguageName, notify]);

  // Session restore reaches for this without taking it as an effect dependency —
  // handleFileOpen changes identity on every tab change, which would re-run the
  // restore effect (and duplicate tabs) before it finishes.
  const handleFileOpenRef = useRef(handleFileOpen);
  handleFileOpenRef.current = handleFileOpen;

  // Save file content for a file tab
  const handleFileSave = useCallback(async (tabId?: number) => {
    const targetTabId = tabId ?? activeTabId;
    if (!targetTabId) return;

    const tab = tabs.find((t) => t.id === targetTabId);
    if (!tab || tab.type !== 'file' || !tab.filePath || !tab.fileModified) return;

    if (!isElectron) {
      console.warn('Cannot save file - not running in Electron');
      return;
    }

    // saveTabToDisk compares the recorded mtime with what's on disk first and
    // asks before overwriting somebody else's edits (C4).
    await saveTabToDisk(tab);
  }, [tabs, activeTabId, saveTabToDisk]);

  // Create a new untitled file
  const handleNewFile = useCallback((directory?: string) => {
    // Find next untitled number
    const untitledPattern = /^Untitled-(\d+)$/;
    let maxNum = 0;
    tabs.forEach((t) => {
      if (t.type === 'file' && t.label) {
        const match = t.label.match(untitledPattern);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      }
    });
    const fileName = `Untitled-${maxNum + 1}`;

    // If directory provided, create path in that directory, otherwise workspace root
    const filePath = directory
      ? `${directory}/${fileName}`
      : `${workspace}/${fileName}`;

    const tabId = nextTabIdRef.current++;
    const newTab: TabData = {
      id: tabId,
      type: 'file',
      label: fileName,
      closable: true,
      ptyId: null,
      dockPosition: 'center',
      filePath,
      fileLanguage: 'text',
      fileModified: true, // New file is unsaved
      fileContent: '',
      fileOriginalContent: '', // Empty original means new file
      // Nothing on disk yet; the first save records a real mtime, and if the
      // path appeared in the meantime saveTabToDisk asks before overwriting.
      fileMtime: null,
    };

    if (isElectron) {
      lee.context.recordAction('file_new', filePath);
    }
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(tabId);
    setFocusedPanel('center');
    return tabId;
  }, [tabs, workspace]);

  // Update file content when editor changes
  const handleFileContentChange = useCallback((tabId: number, newContent: string) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== tabId || t.type !== 'file') return t;
      const modified = newContent !== t.fileOriginalContent;
      return { ...t, fileContent: newContent, fileModified: modified };
    }));
  }, []);

  // Browser tab state handlers
  const handleBrowserTitleChange = useCallback((tabId: number, title: string) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId && t.type === 'browser'
        ? { ...t, label: title, browserTitle: title }
        : t
    ));
  }, []);

  const handleBrowserUrlChange = useCallback((tabId: number, url: string) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId && t.type === 'browser'
        ? { ...t, browserUrl: url }
        : t
    ));
  }, []);

  const handleBrowserLoadingChange = useCallback((tabId: number, loading: boolean) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId && t.type === 'browser'
        ? { ...t, browserLoading: loading }
        : t
    ));
  }, []);

  // Handle browser error count changes (for watched tabs)
  const handleBrowserErrorCountChange = useCallback((tabId: number, errorCount: number) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId && t.type === 'browser'
        ? { ...t, browserErrorCount: errorCount }
        : t
    ));

    // Push status notification when errors increase
    if (errorCount > 0) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.watched) {
        // Only push if not already a pending message for this tab
        const messageId = `browser-error-${tabId}`;
        const existingMsg = statusMessages.find((m) => m.id === messageId);
        if (!existingMsg) {
          const ttl = 30; // Auto-dismiss after 30 seconds
          setStatusMessages((prev) => [
            ...prev,
            {
              id: messageId,
              type: 'warning',
              message: `🌐 ${errorCount} console error${errorCount > 1 ? 's' : ''} in ${tab.label}`,
              prompt: `Analyze browser tab "${tab.label}" - there are ${errorCount} console error(s). Check the page at ${tab.browserUrl || 'the current URL'}.`,
              timestamp: Date.now(),
              ttl,
            },
          ]);

          // Auto-remove after TTL
          setTimeout(() => {
            setStatusMessages((prev) => prev.filter((m) => m.id !== messageId));
          }, ttl * 1000);
        }
      }
    }
  }, [tabs, statusMessages]);

  // Handle Frame snapshot captured (stream end auto-capture)
  const handleFrameSnapshotCaptured = useCallback((_tabId: number, dir: string) => {
    const messageId = `frame-snapshot-${Date.now()}`;
    const ttl = 15; // Auto-dismiss after 15 seconds

    // Push info notification for Frame stream snapshot
    setStatusMessages((prev) => [
      ...prev,
      {
        id: messageId,
        type: 'info',
        message: `📸 Frame snapshot captured`,
        prompt: `#browser_snapshot Folder: ${dir}`,
        timestamp: Date.now(),
        ttl,
      },
    ]);

    // Auto-remove after TTL
    setTimeout(() => {
      setStatusMessages((prev) => prev.filter((m) => m.id !== messageId));
    }, ttl * 1000);
  }, []);

  // Handle browser checkpoint ready state change
  const handleBrowserCheckpointReadyChange = useCallback((tabId: number, ready: boolean) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId && t.type === 'browser'
        ? { ...t, browserCheckpointReady: ready }
        : t
    ));
  }, []);

  // Handle opening a Hester session from the command palette as a full tab
  const handleOpenHesterTab = useCallback(async (sessionId: string) => {
    console.log('Opening Hester session as tab:', sessionId);

    // Spawn a new Hester TUI with the session ID to resume the conversation
    // This always creates a new tab (doesn't reuse existing) since it's resuming a specific session
    if (!isElectron) {
      console.warn('Cannot create tab - not running in Electron');
      return;
    }

    try {
      const ptyId = await lee.pty.spawnTUI('hester', workspace, { sessionId });

      if (ptyId !== null) {
        ptyEventManager.expect(ptyId);

        const tabId = nextTabIdRef.current++;
        const newTab: TabData = {
          id: tabId,
          type: 'agent',
          label: 'Hester',
          closable: true,
          ptyId,
          dockPosition: 'center',
          provider: 'hester',
        };

        lee.context.recordAction('tab_create', `${tabId}:hester:${sessionId}`);
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(tabId);
        setFocusedPanel('center');
      }
    } catch (error) {
      console.error('Failed to spawn Hester with session:', error);
      notify('error', `Couldn't resume that Hester session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [workspace, notify]);

  // Handle Ask Hester from file tree context menu
  // autoSubmit defaults to true - set false to pre-populate without sending
  const handleAskHester = useCallback((prompt: string, autoSubmit: boolean = true) => {
    setPendingPrompt(prompt);
    setAutoSubmitPrompt(autoSubmit);
    setShowCommandPalette(true);
  }, []);

  // Paste text into an agent tab's PTY without sending (no newline)
  const handleSendToAgent = useCallback(async (ptyId: number, text: string) => {
    if (!isElectron) return;
    try {
      // Switch to the agent tab first so the user sees the pasted text
      const agentTab = tabsRef.current.find(t => t.ptyId === ptyId);
      if (agentTab) {
        switch (agentTab.dockPosition) {
          case 'left': setActiveLeftTabId(agentTab.id); setFocusedPanel('left'); break;
          case 'right': setActiveRightTabId(agentTab.id); setFocusedPanel('right'); break;
          case 'bottom': setActiveBottomTabId(agentTab.id); setFocusedPanel('bottom'); break;
          default: setActiveTabId(agentTab.id); setFocusedPanel('center');
        }
      }
      // Small delay to let the tab render before writing
      await new Promise(r => setTimeout(r, 50));
      await lee.pty.write(ptyId, text);
    } catch (error) {
      console.error('Failed to send to agent:', error);
      notifyRef.current('warn', `Couldn't send that to the agent tab: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // Derived list of open agent tabs for "Send to Agent" menus
  const agentTabsForUI = useMemo(() =>
    tabs
      .filter(t => t.type === 'agent' && t.ptyId !== null)
      .map(t => ({ id: t.id, ptyId: t.ptyId!, label: t.label, provider: t.provider })),
    [tabs]
  );

  // Handle status message click - if has prompt, send immediately
  const handleStatusMessageClick = useCallback((message: StatusMessage) => {
    if (message.prompt) {
      // Set pending prompt and open palette - it will auto-submit
      setPendingPrompt(message.prompt);
      setShowCommandPalette(true);
    } else {
      // No prompt, just open blank palette
      setShowCommandPalette(true);
    }
    // Remove the message from queue after clicking
    setStatusMessages((prev) => prev.filter((m) => m.id !== message.id));
  }, []);

  // Handle clearing a status message
  const handleClearStatusMessage = useCallback((id: string) => {
    setStatusMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Handle panel tab selection
  const handlePanelTabSelect = useCallback((tabId: number, position: 'left' | 'right' | 'bottom') => {
    switch (position) {
      case 'left':
        setActiveLeftTabId(tabId);
        setFocusedPanel('left');
        break;
      case 'right':
        setActiveRightTabId(tabId);
        setFocusedPanel('right');
        break;
      case 'bottom':
        setActiveBottomTabId(tabId);
        setFocusedPanel('bottom');
        break;
    }
  }, []);

  // Render any tab type - unified renderer for both center and panel tabs
  const renderTab = useCallback((tab: DockableTab, active: boolean) => {
    // Cast to TabData to access file-specific properties
    const tabData = tab as TabData;

    if (tab.type === 'files') {
      return (
        <FileTreePane
          key={tab.id}
          workspace={workspace}
          onFileOpen={handleFileOpen}
          onNewFile={handleNewFile}
          onAskHester={handleAskHester}
          onSendToAgent={agentTabsForUI.length > 0 ? handleSendToAgent : undefined}
          agentTabs={agentTabsForUI}
          active={active}
        />
      );
    }

    if (tab.type === 'file') {
      return (
        <EditorPanel
          key={tab.id}
          tabId={tab.id}
          workspace={workspace}
          active={active}
          filePath={tabData.filePath}
          fileContent={tabData.fileContent}
          fileLanguage={tabData.fileLanguage}
          fileModified={tabData.fileModified}
          fileDeleted={tabData.fileDeleted}
          onContentChange={(content) => handleFileContentChange(tab.id, content)}
          onSave={() => handleFileSave(tab.id)}
          onAskHester={handleAskHester}
          onOpenFile={handleFileOpen}
          onSendToAgent={agentTabsForUI.length > 0 ? handleSendToAgent : undefined}
          agentTabs={agentTabsForUI}
        />
      );
    }

    if (tab.type === 'editor-panel') {
      return (
        <EditorPanel
          key={tab.id}
          tabId={tab.id}
          workspace={workspace}
          active={active}
          onAskHester={handleAskHester}
          onSendToAgent={agentTabsForUI.length > 0 ? handleSendToAgent : undefined}
          agentTabs={agentTabsForUI}
        />
      );
    }

    if (tab.type === 'browser') {
      return (
        <BrowserPane
          key={tab.id}
          active={active}
          tabId={tab.id}
          initialUrl={tabData.browserUrl}
          watched={tabData.watched}
          onTitleChange={(title) => handleBrowserTitleChange(tab.id, title)}
          onUrlChange={(url) => handleBrowserUrlChange(tab.id, url)}
          onLoadingChange={(loading) => handleBrowserLoadingChange(tab.id, loading)}
          onAskHester={handleAskHester}
          onSendToAgent={agentTabsForUI.length > 0 ? handleSendToAgent : undefined}
          agentTabs={agentTabsForUI}
          onErrorCountChange={(count) => handleBrowserErrorCountChange(tab.id, count)}
          onFrameSnapshotCaptured={(dir) => handleFrameSnapshotCaptured(tab.id, dir)}
          onCheckpointReadyChange={(ready) => handleBrowserCheckpointReadyChange(tab.id, ready)}
        />
      );
    }

    if (tab.type === 'library') {
      return (
        <LibraryPane
          key={tab.id}
          active={active}
          workspace={workspace}
          onOpenFile={handleFileOpen}
        />
      );
    }

    if (tab.type === 'workstream') {
      return (
        <WorkstreamPane
          key={tab.id}
          active={active}
          workspace={workspace}
          workstreamId={tabData.workstreamId || ''}
        />
      );
    }

    if (tab.type === 'spyglass') {
      const tabData = tab as TabData;
      if (!tabData.machineConfig) {
        return <div key={tab.id} className="spyglass-error">Missing machine config — close and reopen this tab.</div>;
      }
      return (
        <SpyglassPane
          key={tab.id}
          active={active}
          machineConfig={tabData.machineConfig}
        />
      );
    }

    if (tab.type === 'kicad') {
      return (
        <KiCadPane
          key={tab.id}
          active={active}
          filePath={tabData.filePath}
          onOpenAsText={(fp) => handleFileOpen(fp, { forceText: true })}
        />
      );
    }

    if (tab.type === 'model') {
      return (
        <ModelViewerPane
          key={tab.id}
          active={active}
          filePath={tabData.filePath}
        />
      );
    }

    if (tab.type === 'pdf') {
      return (
        <PdfPane
          key={tab.id}
          active={active}
          filePath={tabData.filePath}
        />
      );
    }

    if (tab.type === 'binary') {
      return (
        <BinaryFilePane
          key={tab.id}
          active={active}
          filePath={tabData.filePath}
          onOpenAsText={(fp) => handleFileOpen(fp, { forceText: true })}
        />
      );
    }

    // All other tabs are PTY-based terminals (including bridge tabs which have a PTY)
    return (
      <TerminalPane
        key={tab.id}
        ptyId={tab.ptyId}
        active={active}
        label={tab.label}
        watched={tab.watched}
        onIdleChange={handleIdleChange}
      />
    );
  }, [workspace, handleFileOpen, handleNewFile, handleAskHester, handleIdleChange, handleFileContentChange, handleFileSave, handleBrowserTitleChange, handleBrowserUrlChange, handleBrowserLoadingChange, handleBrowserErrorCountChange, handleFrameSnapshotCaptured, handleBrowserCheckpointReadyChange]);

  // Handle workspace selection from modal
  const handleWorkspaceSelect = useCallback((selectedWorkspace: string) => {
    setShowWorkspaceModal(false);

    if (workspace && workspaceInitialized) {
      // Already have a workspace — do a full switch (close old tabs, restore new session)
      void switchWorkspace(selectedWorkspace);
    } else {
      // First-time init — no tabs to clean up
      setWorkspace(selectedWorkspace);
      setWorkspaceInitialized(true);
      localStorage.setItem('lee:lastWorkspace', selectedWorkspace);
      if (isElectron) {
        lee.pty.prewarm(selectedWorkspace);
      }
    }
  }, [workspace, workspaceInitialized, switchWorkspace]);

  const handleWorkspaceSkip = useCallback(async () => {
    setShowWorkspaceModal(false);

    if (isElectron) {
      const cwd = await lee.app.getWorkspace();

      if (workspace && workspaceInitialized) {
        await switchWorkspace(cwd);
      } else {
        setWorkspace(cwd);
        setWorkspaceInitialized(true);
        localStorage.setItem('lee:lastWorkspace', cwd);
        lee.pty.prewarm(cwd);
      }
    } else {
      setWorkspaceInitialized(true);
    }
  }, [workspace, workspaceInitialized, switchWorkspace]);

  // Handle workstream selection from picker modal
  const handleWorkstreamSelect = useCallback((wsId: string, wsTitle: string) => {
    setShowWorkstreamPicker(false);
    // Check if there's already a tab for this workstream
    const existing = tabsRef.current.find(t => t.type === 'workstream' && t.workstreamId === wsId);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    // Create new workstream tab
    const tabId = nextTabIdRef.current++;
    const newTab: TabData = {
      id: tabId,
      type: 'workstream',
      label: wsTitle,
      closable: true,
      ptyId: null,
      dockPosition: 'center',
      workstreamId: wsId,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);
    setFocusedPanel('center');
  }, []);

  // Initialize app
  useEffect(() => {
    if (!isElectron) {
      console.warn('Not running in Electron - Lee API not available');
      setWorkspaceInitialized(true);
      return;
    }

    const init = async () => {
      // Check URL hash for window init signals from main process
      // #new → new window, show workspace modal
      // #workspace=<path> → use this workspace directly
      // (no hash) → first window, use localStorage lastWorkspace
      const hash = window.location.hash;

      if (hash === '#new') {
        // New window without pre-selected workspace — show modal
        const cwd = await lee.app.getWorkspace();
        setWorkspace(cwd);
        setShowWorkspaceModal(true);
        setWorkspaceInitialized(true);
        // Clear hash so reload behaves normally
        window.location.hash = '';
        return;
      }

      if (hash.startsWith('#workspace=')) {
        // New window with pre-selected workspace — use it directly
        const preselected = decodeURIComponent(hash.replace('#workspace=', ''));
        setWorkspace(preselected);
        setWorkspaceInitialized(true);
        localStorage.setItem('lee:lastWorkspace', preselected);
        lee.pty.prewarm(preselected);
        // Clear hash so reload behaves normally
        window.location.hash = '';
        return;
      }

      // Default: first window, check localStorage
      const lastWorkspace = localStorage.getItem('lee:lastWorkspace');

      if (lastWorkspace) {
        // Use last workspace
        setWorkspace(lastWorkspace);
        setWorkspaceInitialized(true);

        // Trigger prewarm with stored workspace
        lee.pty.prewarm(lastWorkspace);
      } else {
        // No stored workspace - show modal
        const cwd = await lee.app.getWorkspace();
        setWorkspace(cwd); // Set cwd as default
        setShowWorkspaceModal(true);
        setWorkspaceInitialized(true);
      }
    };

    init();

    // Listen for state updates (including daemon port)
    const cleanupState = lee.pty.onState((_id: number, state: any) => {
      if (state.daemonPort) {
        console.log(`Editor daemon ready on port ${state.daemonPort}`);
        setEditorDaemonPort(state.daemonPort);
      }
    });

    // Listen for PTY exits - auto-close tab only on clean exit (code 0)
    // Use refs to avoid stale closures - this effect should only run once on mount
    const cleanupExit = lee.pty.onExit((ptyId: number, code: number) => {
      console.log(`[Lee] PTY ${ptyId} exited with code ${code}`);

      // Only auto-close on clean exit, not on errors
      if (code !== 0) return;

      // Find the tab with this ptyId (use ref to avoid stale closure)
      const tabToClose = tabsRef.current.find((t) => t.ptyId === ptyId);
      if (tabToClose && closeTabRef.current) {
        // Delay closure by 1 second so user can see exit message
        setTimeout(() => {
          closeTabRef.current?.(tabToClose.id);
        }, 1000);
      }
    });

    // Cleanup only our specific listeners on unmount
    // DO NOT call removeAllListeners - it kills the global PtyEventManager listener!
    return () => {
      cleanupState();
      cleanupExit();
      lee.file.removeAllListeners();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - init should only run once on mount

  // Load workspace config function
  const loadWorkspaceConfig = useCallback(async () => {
    if (!workspace || !isElectron) return;
    try {
      const loadedConfig = await lee.config.load(workspace);
      if (loadedConfig) {
        console.log('Loaded workspace config:', Object.keys(loadedConfig));
        setConfig(loadedConfig);
      }
    } catch (error) {
      console.error('Failed to load workspace config:', error);
      notifyRef.current('error', `Couldn't load the workspace config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [workspace]);

  // Load workspace config when workspace changes
  useEffect(() => {
    loadWorkspaceConfig();
  }, [loadWorkspaceConfig]);

  // Fetch available TUI options from main process (after config loads)
  const fetchTuiOptions = useCallback(async () => {
    if (!isElectron) return;
    try {
      const tuis = await lee.pty.getAvailableTUIs();
      const options: NewTabOption[] = tuis.map((tui: { key: string; name: string; icon: string; shortcut?: string }) => ({
        type: tui.key as Tab['type'],
        label: tui.name,
        icon: tui.icon,
        shortcut: tui.shortcut,
      }));
      setTuiOptions(options);
    } catch (error) {
      console.error('Failed to fetch TUI options:', error);
      notifyRef.current('warn', 'Couldn\'t read the TUI list — the new-tab menu may be incomplete');
    }
  }, []);

  // Fetch agent providers from main process (after config loads)
  const fetchAgentProviders = useCallback(async () => {
    if (!isElectron) return;
    try {
      const providers = await lee.pty.getAgentProviders();
      setAgentProviders(providers);
    } catch (error) {
      console.error('Failed to fetch agent providers:', error);
      notifyRef.current('warn', 'Couldn\'t read the agent provider list — agent tabs may be unavailable');
    }
  }, []);

  // Refetch TUI options and agent providers whenever config changes
  useEffect(() => {
    fetchTuiOptions();
    fetchAgentProviders();
  }, [config, fetchTuiOptions, fetchAgentProviders]);

  // Handle config save from editor
  const handleConfigSave = useCallback((newConfig: any) => {
    setConfig(newConfig);
    setShowConfigEditor(false);
  }, []);

  // Handle config reload
  const handleConfigReload = useCallback(async () => {
    await loadWorkspaceConfig();
  }, [loadWorkspaceConfig]);

  // Check daemon health
  const checkDaemonHealth = useCallback(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${HESTER_DAEMON_PORT}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      const data = await response.json();
      setDaemonStatus(data.status === 'healthy' ? 'healthy' : 'unhealthy');
    } catch {
      // Best-effort poll every 10s: a down daemon is already reported by the
      // status-bar indicator, and a toast per poll would be unusable.
      setDaemonStatus('unhealthy');
    }
  }, []);

  // Poll daemon health every 10 seconds
  useEffect(() => {
    checkDaemonHealth();
    const interval = setInterval(checkDaemonHealth, 10000);
    return () => clearInterval(interval);
  }, [checkDaemonHealth]);

  // Handle daemon control actions
  const handleDaemonAction = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (!isElectron) return;

    setDaemonStatus('checking');
    try {
      let result;
      switch (action) {
        case 'start':
          result = await lee.daemon.start();
          break;
        case 'stop':
          result = await lee.daemon.stop();
          break;
        case 'restart':
          result = await lee.daemon.restart();
          break;
      }
      console.log(`Daemon ${action} result:`, result);
      if (result && !result.success) {
        notify('error', `Hester daemon ${action} failed: ${result.error || 'unknown error'}`);
      }
      // Re-check health after action
      setTimeout(checkDaemonHealth, 1500);
    } catch (error) {
      console.error(`Daemon ${action} error:`, error);
      notify('error', `Hester daemon ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
      setDaemonStatus('unhealthy');
    }
  }, [checkDaemonHealth, notify]);

  const handleSpyglass = useCallback((machine: any) => {
    const existing = tabs.find(t =>
      t.type === 'spyglass' &&
      (t as TabData).machineConfig?.host === machine.config.host &&
      (t as TabData).machineConfig?.lee_port === machine.config.lee_port
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const tabId = nextTabIdRef.current++;
    const newTab: TabData = {
      id: tabId,
      type: 'spyglass' as any,
      label: `${machine.config.emoji} ${machine.config.name}`,
      closable: true,
      ptyId: null,
      dockPosition: 'center',
      machineConfig: machine.config,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);
  }, [tabs]);

  const handleBridge = useCallback((machine?: any) => {
    setBridgePreselectedMachine(machine || null);
    setShowBridgePicker(true);
  }, []);

  const handleBridgeSpawn = useCallback(async (machineConfig: any, workspace: string, tui: any) => {
    setShowBridgePicker(false);
    setBridgePreselectedMachine(null);

    if (!isElectron) return;

    const port = machineConfig.ssh_port || 22;
    const tuiCmd = `${tui.command}${tui.args ? ' ' + tui.args.join(' ') : ''}`;
    const remoteCmd = tui.key === 'terminal'
      ? `cd ${workspace} && exec $SHELL -l`
      : `$SHELL -lc 'cd ${workspace} && exec ${tuiCmd.replace(/'/g, "'\\''")}'`;

    const sshArgs = ['-t'];
    if (port !== 22) {
      sshArgs.push('-p', String(port));
    }
    sshArgs.push(`${machineConfig.user}@${machineConfig.host}`, remoteCmd);

    try {
      const ptyId = await lee.pty.spawn('ssh', sshArgs, undefined, `${machineConfig.emoji} ${tui.name}`);
      if (ptyId !== null) {
        ptyEventManager.expect(ptyId);
      }

      const tabId = nextTabIdRef.current++;
      const newTab: TabData = {
        id: tabId,
        type: 'bridge' as any,
        label: `${machineConfig.emoji} ${tui.name}`,
        closable: true,
        ptyId,
        dockPosition: 'center',
        machineConfig,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);

      if (isElectron) {
        lee.context.recordAction('tab_create', `bridge:${machineConfig.name}:${tui.name}`);
      }
    } catch (error) {
      console.error('[Bridge] Failed to spawn SSH:', error);
      notifyRef.current('error', `Couldn't open a bridge to ${machineConfig.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  // Restore session when workspace is set
  useEffect(() => {
    if (!workspace || !workspaceInitialized || sessionRestored || !isElectron) return;

    const savedSession = loadSession(workspace);
    if (savedSession && savedSession.length > 0) {
      console.log('[Lee] Restoring session:', savedSession);
      // Restore tabs sequentially to avoid overwhelming the system
      // Each createTab spawns a PTY process, so stagger them
      const workspaceName = workspace.split('/').pop() || 'Files';
      (async () => {
        // One rejected tab restore used to abort the whole loop and skip
        // setSessionRestored(true) below, silently disabling autosave for
        // the rest of the session. Isolate each tab and always flip the gate.
        try {
          for (const sessionTab of savedSession) {
            try {
              // Skip tabs that require runtime state not persisted in sessions
              if (sessionTab.type === ('spyglass' as any) || sessionTab.type === ('bridge' as any)) continue;

              // File-backed tabs (editor and every viewer) are restored by
              // reopening the path, which re-runs the normal routing: viewers get
              // their content back, and a file that changed on disk — or stopped
              // being binary — lands in whichever tab type now fits it.
              if (FILE_BACKED_TAB_TYPES.includes(sessionTab.type)) {
                // Legacy sessions predate persisted paths; browser tabs only carry
                // one when they were opened for a local file
                if (!sessionTab.filePath) continue;
                // Silently drop files that were moved or deleted since last run
                if (!(await lee.fs.exists(sessionTab.filePath))) continue;
                // A 'file' tab was text at save time — keep it text, even for an
                // extension that would otherwise route to a viewer
                await handleFileOpenRef.current(
                  sessionTab.filePath,
                  sessionTab.type === 'file' ? { forceText: true } : undefined
                );
                continue;
              }
              // Migrate legacy agent tab types to the unified 'agent' type
              if (sessionTab.type === ('hester' as any)) {
                await createTab('agent' as Tab['type'], sessionTab.dockPosition, 'hester');
                continue;
              }
              if (sessionTab.type === ('claude' as any)) {
                await createTab('agent' as Tab['type'], sessionTab.dockPosition, 'claude');
                continue;
              }
              if (sessionTab.type === ('pi' as any)) {
                await createTab('agent' as Tab['type'], sessionTab.dockPosition, 'pi');
                continue;
              }
              // Agent tabs: restore via the persisted provider key, not the
              // display label (which may be capitalized or not match the key at
              // all for custom providers). Fall back to a lowercased label for
              // sessions saved before `provider` was persisted.
              if (sessionTab.type === 'agent') {
                const provider = sessionTab.provider || sessionTab.label.toLowerCase();
                await createTab('agent' as Tab['type'], sessionTab.dockPosition, provider);
                continue;
              }
              // Files tabs should always use workspace name as label
              const label = sessionTab.type === 'files' ? workspaceName : sessionTab.label;
              await createTab(sessionTab.type, sessionTab.dockPosition, label);
            } catch (err) {
              console.error('[Lee] Failed to restore session tab:', sessionTab, err);
              notifyRef.current('warn', `Couldn't restore "${sessionTab.label}" tab: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } finally {
          setSessionRestored(true);
        }
      })();
    } else {
      setSessionRestored(true);
    }
  }, [workspace, workspaceInitialized, sessionRestored, loadSession, createTab]);

  // Save session when tabs change (debounced via useEffect)
  useEffect(() => {
    if (!workspace || !sessionRestored || tabs.length === 0) return;
    // Don't save during a workspace switch — old tabs haven't been fully cleared yet
    if (isSwitchingRef.current) return;
    saveSession(tabs, workspace);
  }, [tabs, workspace, sessionRestored, saveSession]);

  // Report context to main process for Hester integration
  // This enables bidirectional context awareness between Lee and Hester
  useEffect(() => {
    if (!isElectron || !workspace) return;

    // Debounce context updates to avoid flooding
    const timeoutId = setTimeout(() => {
      lee.context.update({
        tabs: tabs.map((t) => ({
          id: t.id,
          type: t.type,
          label: t.label,
          ptyId: t.ptyId,
          dockPosition: t.dockPosition,
          state: getTabState(t),
          // Extra per-type fields so remote clients (Aeronaut, Dirigible,
          // Hester) can render viewer/agent/machine tabs without guessing.
          ...(t.provider ? { provider: t.provider } : {}),
          ...(t.filePath ? { filePath: t.filePath } : {}),
          ...(t.workstreamId ? { workstreamId: t.workstreamId } : {}),
          ...(t.machineConfig ? { machineName: t.machineConfig.name, machineHost: t.machineConfig.host } : {}),
        })),
        activeTabId,
        activeLeftTabId,
        activeRightTabId,
        activeBottomTabId,
        focusedPanel,
        workspace,
        editorDaemonPort,
        dirtyFileCount: tabs.filter((t) => t.type === 'file' && t.fileModified).length,
      });
    }, 100);

    return () => clearTimeout(timeoutId);

    // Helper to determine tab state
    function getTabState(tab: TabData): 'active' | 'background' | 'idle' {
      const isActiveInPanel = (
        (tab.dockPosition === 'center' && tab.id === activeTabId) ||
        (tab.dockPosition === 'left' && tab.id === activeLeftTabId) ||
        (tab.dockPosition === 'right' && tab.id === activeRightTabId) ||
        (tab.dockPosition === 'bottom' && tab.id === activeBottomTabId)
      );
      if (isActiveInPanel && tab.dockPosition === focusedPanel) {
        return 'active';
      }
      if (isActiveInPanel) {
        return 'background';
      }
      return 'idle';
    }
  }, [tabs, activeTabId, activeLeftTabId, activeRightTabId, activeBottomTabId, focusedPanel, workspace, editorDaemonPort]);

  // Handle file events from the main process (menu actions)
  useEffect(() => {
    if (!isElectron) return;

    // File > New - creates new untitled file tab
    lee.file.onNew(() => {
      console.log('New file requested');
      handleNewFile();
    });

    // File > Open - creates new file tab
    lee.file.onOpen(async (filePath: string) => {
      console.log('File open requested:', filePath);
      handleFileOpen(filePath);
    });

    // File > Open Folder
    lee.file.onFolderOpen((folderPath: string) => {
      console.log('Folder open requested:', folderPath);
      void switchWorkspace(folderPath);
    });

    // File > Save - saves current active file tab
    lee.file.onSave(async () => {
      console.log('Save requested');
      handleFileSave();
    });

    // File > Save As - save current file tab to a new path
    lee.file.onSaveAs(async (filePath: string) => {
      if (!activeTabId) return;
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab || tab.type !== 'file') return;

      try {
        const result = await lee.fs.writeFile(filePath, tab.fileContent || '');
        if (result.success) {
          const fileName = filePath.split('/').pop() || filePath;
          // The watch follows the tab to its new path (C4).
          if (tab.filePath) lee.fs.unwatchFile(tab.filePath);
          lee.fs.watchFile(filePath);
          const stat = await lee.fs.stat(filePath);
          setTabs((prev) => prev.map((t) =>
            t.id === activeTabId
              ? {
                  ...t,
                  filePath,
                  label: fileName,
                  fileModified: false,
                  fileOriginalContent: t.fileContent,
                  fileLanguage: getLanguageName(filePath),
                  fileMtime: stat?.mtime ?? null,
                  fileDeleted: false,
                }
              : t
          ));
          lee.context.recordAction('file_save_as', filePath);
        } else {
          notifyRef.current('error', `Couldn't save "${fileNameOf(filePath)}": ${result.error || 'unknown error'}`);
        }
      } catch (error) {
        notifyRef.current('error', `Couldn't save "${fileNameOf(filePath)}": ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    // Help > Ask Hester - opens command palette
    lee.menu.onCommandPalette(() => {
      setShowCommandPalette(true);
    });

    // Lee > Edit Workspace Config
    lee.menu.onEditConfig(() => {
      setShowConfigEditor(true);
    });

    // Lee > Edit Lee Config
    lee.menu.onEditGlobalConfig(() => {
      setShowGlobalConfigEditor(true);
    });

    // Lee > Switch Workspace
    lee.menu.onSwitchWorkspace(() => {
      setShowWorkspaceModal(true);
    });

    // View > Aeronaut Pairing (Cmd+Shift+A)
    const cleanupPairing = lee.aeronaut?.onShowPairing?.(() => {
      setShowPairingDialog(true);
    });

    // Editor commands from Hester / API server (open, save, close).
    //
    // Open returns the resolved tab_id via reportOpenResult so the HTTP
    // /command response can include it — Hester needs that to address the
    // newly-opened editor on subsequent commands. Save/close honor the
    // optional tab_id, falling back to the active tab when omitted.
    const cleanupEditorOpen = lee.editor?.onOpen?.(async (filePath: string, _msgTabId: number | undefined, requestId: string | undefined) => {
      const newTabId = await handleFileOpen(filePath);
      if (requestId) {
        lee.editor.reportOpenResult(requestId, newTabId ?? null);
      }
    });
    const cleanupEditorSave = lee.editor?.onSave?.((msgTabId: number | undefined) => {
      handleFileSave(msgTabId);
    });
    const cleanupEditorClose = lee.editor?.onClose?.((msgTabId: number | undefined) => {
      const targetId = msgTabId ?? activeTabId;
      if (!targetId) return;
      const tab = tabsRef.current.find(t => t.id === targetId);
      if (tab && (tab.type === 'file' || tab.type === 'editor-panel')) {
        closeTab(targetId);
      }
    });

    return () => {
      cleanupEditorOpen?.();
      cleanupEditorSave?.();
      cleanupEditorClose?.();
      cleanupPairing?.();
      lee.file.removeAllListeners();
      lee.menu.removeAllListeners();
    };
  }, [handleNewFile, handleFileOpen, handleFileSave, switchWorkspace, tabs, activeTabId, getLanguageName, closeTab]);

  // Handle system commands from API server (via IPC from main process)
  useEffect(() => {
    if (!isElectron) return;

    // Focus a specific tab
    const cleanupFocusTab = lee.system.onFocusTab((tabId: string) => {
      console.log('[System] Focus tab requested:', tabId);
      const id = parseInt(tabId, 10);
      if (isNaN(id)) return;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab) {
        switch (tab.dockPosition) {
          case 'left':
            setActiveLeftTabId(tab.id);
            setFocusedPanel('left');
            break;
          case 'right':
            setActiveRightTabId(tab.id);
            setFocusedPanel('right');
            break;
          case 'bottom':
            setActiveBottomTabId(tab.id);
            setFocusedPanel('bottom');
            break;
          default:
            setActiveTabId(tab.id);
            setFocusedPanel('center');
        }
      }
    });

    // Close a specific tab
    const cleanupCloseTab = lee.system.onCloseTab((tabId: string) => {
      console.log('[System] Close tab requested:', tabId);
      const id = parseInt(tabId, 10);
      if (!isNaN(id)) {
        closeTab(id);
      }
    });

    // Create a new tab
    const cleanupCreateTab = lee.system.onCreateTab(async (params: { type: string; label?: string; cwd?: string; command?: string; args?: string[] }) => {
      console.log('[System] Create tab requested:', params);
      if (params.command) {
        // ui_control `tui custom` — run a specific command in a terminal tab
        // rather than the default login shell.
        await createTab('terminal' as Tab['type'], 'center', params.label || params.command, {
          command: params.command,
          args: params.args,
        });
      } else {
        await createTab(params.type as Tab['type'], 'center', params.label);
      }
    });

    // Remote cast active (Aeronaut connected)
    const cleanupCastActive = lee.system.onCastActive((info: { tabId?: number; ptyId?: number }) => {
      console.log('[System] Cast active:', info);
      setTabs((prev) =>
        prev.map((tab) => {
          if (info.tabId !== undefined && tab.id === info.tabId) {
            return { ...tab, remoteCast: true };
          }
          if (info.ptyId !== undefined && tab.ptyId === info.ptyId) {
            return { ...tab, remoteCast: true };
          }
          return tab;
        })
      );
    });

    // Remote cast inactive (Aeronaut disconnected)
    const cleanupCastInactive = lee.system.onCastInactive((info: { tabId?: number; ptyId?: number }) => {
      console.log('[System] Cast inactive:', info);
      setTabs((prev) =>
        prev.map((tab) => {
          if (info.tabId !== undefined && tab.id === info.tabId) {
            return { ...tab, remoteCast: false };
          }
          if (info.ptyId !== undefined && tab.ptyId === info.ptyId) {
            return { ...tab, remoteCast: false };
          }
          return tab;
        })
      );
    });

    return () => {
      cleanupFocusTab();
      cleanupCloseTab();
      cleanupCreateTab();
      cleanupCastActive();
      cleanupCastInactive();
    };
  }, [closeTab, createTab]);

  // Handle panel commands from API server (via IPC from main process)
  // Note: Full panel visibility/resize would require additional state management
  // For now, we handle focus requests
  useEffect(() => {
    if (!isElectron) return;

    const cleanupFocus = lee.panel.onFocus((panel: string) => {
      console.log('[Panel] Focus requested:', panel);
      if (panel === 'center' || panel === 'left' || panel === 'right' || panel === 'bottom') {
        setFocusedPanel(panel);
      }
    });

    // Toggle/show/hide/resize would require exposing panel visibility state
    // which isn't currently part of the App state. Log for now.
    const cleanupToggle = lee.panel.onToggle((panel: string) => {
      console.log('[Panel] Toggle requested (not yet implemented):', panel);
    });

    const cleanupShow = lee.panel.onShow((panel: string) => {
      console.log('[Panel] Show requested (not yet implemented):', panel);
    });

    const cleanupHide = lee.panel.onHide((panel: string) => {
      console.log('[Panel] Hide requested (not yet implemented):', panel);
    });

    const cleanupResize = lee.panel.onResize((panel: string, size: number) => {
      console.log('[Panel] Resize requested (not yet implemented):', panel, size);
    });

    return () => {
      cleanupFocus();
      cleanupToggle();
      cleanupShow();
      cleanupHide();
      cleanupResize();
    };
  }, []);

  // C4: react to watched files changing on disk, and re-check every open file
  // whenever the window regains focus (fs.watch misses events on some mounts).
  useEffect(() => {
    if (!isElectron) return;

    const cleanupFileChanged = lee.fs.onFileChanged(({ path, mtimeMs }) => {
      void handleExternalFileChange(path, mtimeMs);
    });

    const onFocus = () => { void checkOpenFilesForExternalChanges(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cleanupFileChanged();
      window.removeEventListener('focus', onFocus);
    };
  }, [handleExternalFileChange, checkOpenFilesForExternalChanges]);

  // Switching to a different tab is also a good moment to notice a file
  // that moved underneath us while it wasn't visible.
  useEffect(() => {
    if (!isElectron || activeTabId === null) return;
    void checkOpenFilesForExternalChanges();
  }, [activeTabId, checkOpenFilesForExternalChanges]);

  // Handle status messages from Hester (via IPC from main process)
  useEffect(() => {
    if (!isElectron) return;

    // Handle new message pushed
    const cleanupPush = lee.status.onPush((message: Omit<StatusMessage, 'timestamp'>) => {
      console.log('[Status] Push:', message);
      setStatusMessages((prev) => [
        ...prev,
        { ...message, timestamp: Date.now() },
      ]);

      // Auto-remove after TTL if specified
      if (message.ttl) {
        setTimeout(() => {
          setStatusMessages((prev) => prev.filter((m) => m.id !== message.id));
        }, message.ttl * 1000);
      }
    });

    // Handle message clear by ID
    const cleanupClear = lee.status.onClear((id: string) => {
      console.log('[Status] Clear:', id);
      setStatusMessages((prev) => prev.filter((m) => m.id !== id));
    });

    // Handle clear all
    const cleanupClearAll = lee.status.onClearAll(() => {
      console.log('[Status] Clear all');
      setStatusMessages([]);
    });

    return () => {
      cleanupPush();
      cleanupClear();
      cleanupClearAll();
    };
  }, []);

  // Helper to activate a tab in its correct panel
  const activateTab = useCallback((tab: TabData | undefined) => {
    if (!tab) return;
    switch (tab.dockPosition) {
      case 'left':
        setActiveLeftTabId(tab.id);
        break;
      case 'right':
        setActiveRightTabId(tab.id);
        break;
      case 'bottom':
        setActiveBottomTabId(tab.id);
        break;
      default:
        setActiveTabId(tab.id);
    }
  }, []);

  // Build the hotkey map from the shared registry (C15).
  //
  // Every renderer-owned action in src/shared/shortcuts.ts gets a handler
  // here; the chord itself comes from the registry (or the user's
  // `keybindings:` override). Actions the application menu owns - Cmd+S,
  // Cmd+O, Cmd+Shift+O, Cmd+, ... - deliberately have no handler, so they
  // can't double-fire.
  const hotkeyMap = useMemo(() => {
    const handlers: Record<string, () => void> = {};

    // Resolve the active tab id of whichever panel currently has focus, not
    // always the center panel's — otherwise Cmd+Esc/Cmd+W acted on the
    // center tab even while a side panel (left/right/bottom) was focused.
    const getFocusedTabId = (): number | null => {
      switch (focusedPanel) {
        case 'left': return activeLeftTabId;
        case 'right': return activeRightTabId;
        case 'bottom': return activeBottomTabId;
        default: return activeTabId;
      }
    };

    // Command Palette
    handlers['command_palette'] = () => {
      const currentMessage = statusMessages.length > 0 ? statusMessages[statusMessages.length - 1] : null;
      if (currentMessage?.prompt) {
        setPendingPrompt(currentMessage.prompt);
        setShowCommandPalette(true);
        setStatusMessages((prev) => prev.filter((m) => m.id !== currentMessage.id));
      } else {
        setShowCommandPalette(true);
      }
    };
    handlers['command_palette_blank'] = () => {
      setPendingPrompt(null);
      setShowCommandPalette(true);
    };

    // TUI launchers (from config or defaults)
    handlers['terminal'] = () => createTab('terminal');
    handlers['browser'] = () => createTab('browser');
    handlers['files'] = () => getOrCreateTab('files', undefined, workspace.split('/').pop() || 'Files');
    // Agent tab launchers
    handlers['hester'] = () => createTab('agent' as Tab['type'], undefined, 'hester');
    handlers['claude'] = () => createTab('agent' as Tab['type'], undefined, 'claude');
    handlers['pi'] = () => createTab('agent' as Tab['type'], undefined, 'pi');
    handlers['devops'] = () => getOrCreateTab('devops');
    // Config-only TUI launchers (work when user has configured these in .lee/config.yaml)
    handlers['git'] = () => createTab('git');
    handlers['docker'] = () => createTab('docker');
    handlers['flutter'] = () => createTab('flutter');
    handlers['k8s'] = () => createTab('k8s');
    handlers['sql'] = () => createTab('sql');
    handlers['hester_qa'] = () => createTab('hester-qa');
    handlers['library'] = () => getOrCreateTab('library');
    handlers['system'] = () => getOrCreateTab('system');
    handlers['workstream'] = () => setShowWorkstreamPicker(true);
    handlers['aeronaut_pairing'] = () => setShowPairingDialog(true);

    // Tab switching (Cmd+1-9)
    handlers['tab_1'] = () => { activateTab(centerTabs[0]); setFocusedPanel('center'); };
    handlers['tab_2'] = () => { activateTab(centerTabs[1]); setFocusedPanel('center'); };
    handlers['tab_3'] = () => { activateTab(centerTabs[2]); setFocusedPanel('center'); };
    handlers['tab_4'] = () => { activateTab(centerTabs[3]); setFocusedPanel('center'); };
    handlers['tab_5'] = () => { activateTab(centerTabs[4]); setFocusedPanel('center'); };
    handlers['tab_6'] = () => { activateTab(centerTabs[5]); setFocusedPanel('center'); };
    handlers['tab_7'] = () => { activateTab(centerTabs[6]); setFocusedPanel('center'); };
    handlers['tab_8'] = () => { activateTab(centerTabs[7]); setFocusedPanel('center'); };
    handlers['tab_9'] = () => { activateTab(centerTabs[8]); setFocusedPanel('center'); };

    // Tab navigation
    handlers['next_tab'] = () => {
      if (centerTabs.length > 1 && activeTabId) {
        const currentIndex = centerTabs.findIndex((t) => t.id === activeTabId);
        const nextIndex = (currentIndex + 1) % centerTabs.length;
        setActiveTabId(centerTabs[nextIndex].id);
        setFocusedPanel('center');
      }
    };
    handlers['prev_tab'] = () => {
      if (centerTabs.length > 1 && activeTabId) {
        const currentIndex = centerTabs.findIndex((t) => t.id === activeTabId);
        const prevIndex = currentIndex === 0 ? centerTabs.length - 1 : currentIndex - 1;
        setActiveTabId(centerTabs[prevIndex].id);
        setFocusedPanel('center');
      }
    };

    // Watch/Idle system (agent tabs only)
    handlers['toggle_watch'] = () => {
      const focusedTabId = getFocusedTabId();
      const focusedTab = tabs.find(t => t.id === focusedTabId);
      if (focusedTab?.type === 'agent') toggleWatch(focusedTabId!);
    };
    handlers['cycle_idle'] = () => {
      const idleTabs = tabs.filter(t => t.type === 'agent' && t.watched && t.isIdle);
      if (idleTabs.length === 0) return;

      const currentTab = tabs.find(t => {
        switch (t.dockPosition) {
          case 'left': return t.id === activeLeftTabId;
          case 'right': return t.id === activeRightTabId;
          case 'bottom': return t.id === activeBottomTabId;
          default: return t.id === activeTabId;
        }
      });

      const currentIdleIndex = currentTab && currentTab.isIdle
        ? idleTabs.findIndex(t => t.id === currentTab.id)
        : -1;

      const nextIndex = (currentIdleIndex + 1) % idleTabs.length;
      const nextIdleTab = idleTabs[nextIndex];

      switch (nextIdleTab.dockPosition) {
        case 'left':
          setActiveLeftTabId(nextIdleTab.id);
          setFocusedPanel('left');
          break;
        case 'right':
          setActiveRightTabId(nextIdleTab.id);
          setFocusedPanel('right');
          break;
        case 'bottom':
          setActiveBottomTabId(nextIdleTab.id);
          setFocusedPanel('bottom');
          break;
        default:
          setActiveTabId(nextIdleTab.id);
          setFocusedPanel('center');
      }
    };

    // Close tab
    handlers['close_tab'] = () => {
      const focusedTabId = getFocusedTabId();
      if (focusedTabId) closeTab(focusedTabId);
    };

    // Scroll to bottom. `notInEditor` in the registry keeps this from
    // shadowing CodeMirror's own go-to-end binding (C15).
    handlers['scroll_bottom'] = () => focusManager.scrollToBottom();

    // Resolve each action to its chord. A chord bound to two actions is a
    // registry bug, so warn rather than silently letting one win.
    const map: Record<string, () => void> = {};
    for (const shortcut of rendererShortcuts()) {
      const handler = handlers[shortcut.action];
      if (!handler) continue;
      const chord = resolveChord(shortcut.action, config?.keybindings);
      if (!chord) continue;
      if (map[chord]) {
        console.warn(`[Lee] Shortcut conflict: ${chord} is bound to more than one action (${shortcut.action})`);
      }
      map[chord] = shortcut.notInEditor
        ? () => {
            // Let the code editor keep chords it owns (Cmd+Down = go to end).
            const active = document.activeElement as HTMLElement | null;
            if (active?.closest?.('.cm-editor')) return;
            handler();
          }
        : handler;
    }

    return map;
  }, [config, getKeybinding, statusMessages, workspace, centerTabs, activeTabId, activeLeftTabId, activeRightTabId, activeBottomTabId, focusedPanel, tabs, createTab, getOrCreateTab, activateTab, toggleWatch, closeTab]);

  // Setup hotkeys
  useHotkeys(hotkeyMap);

  return (
    <div className="app">
      {showWorkspaceModal && (
        <WorkspaceModal
          onSelect={handleWorkspaceSelect}
          onSkip={handleWorkspaceSkip}
          onOpenInNewWindow={(selectedWorkspace) => {
            setShowWorkspaceModal(false);
            lee.window.new(selectedWorkspace);
          }}
        />
      )}
      {showWorkstreamPicker && (
        <WorkstreamPickerModal
          onSelect={handleWorkstreamSelect}
          onClose={() => setShowWorkstreamPicker(false)}
        />
      )}
      <ConfigEditorModal
        isOpen={showConfigEditor}
        onClose={() => {
          setShowConfigEditor(false);
          setConfigEditorInitialSection(undefined);
        }}
        onSave={handleConfigSave}
        onReload={handleConfigReload}
        config={config}
        workspace={workspace}
        initialSection={configEditorInitialSection}
      />
      <GlobalConfigEditorModal
        isOpen={showGlobalConfigEditor}
        onClose={() => setShowGlobalConfigEditor(false)}
        onSave={() => {
          setShowGlobalConfigEditor(false);
          if (lee?.machines?.reload) {
            lee.machines.reload();
          }
        }}
      />
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onOpenAsTab={handleOpenHesterTab}
        workspace={workspace}
        tabs={tabs.map(t => ({
          id: t.id,
          type: t.type,
          label: t.label,
          dockPosition: t.dockPosition,
        }))}
        activeTabId={activeTabId}
        focusedPanel={focusedPanel}
        initialPrompt={pendingPrompt}
        autoSubmit={autoSubmitPrompt}
        onPromptConsumed={() => {
          setPendingPrompt(null);
          setAutoSubmitPrompt(true); // Reset to default
        }}
      />
      <TitleBar />
      <TabBar
        tabs={centerTabs}
        activeTabId={activeTabId}
        tuiOptions={tuiOptions}
        onSelectTab={(tabId) => {
          setActiveTabId(tabId);
          setFocusedPanel('center');
        }}
        onCloseTab={closeTab}
        onNewTab={(type, dockPosition, provider) => createTab(type, dockPosition, provider)}
        onDockTab={dockTab}
        onRenameTab={renameTab}
        onToggleWatch={toggleWatch}
        onRefocus={() => focusManager.refocus()}
        onConfigureTUIs={() => {
          setConfigEditorInitialSection('tuis');
          setShowConfigEditor(true);
        }}
        onSwitchAgentProvider={handleSwitchAgentProvider}
        agentProviders={agentProviders}
      />
      <div className="main-content">
        <PanelLayout
          leftTabs={leftTabs as DockableTab[]}
          rightTabs={rightTabs as DockableTab[]}
          bottomTabs={bottomTabs as DockableTab[]}
          activeLeftTabId={activeLeftTabId}
          activeRightTabId={activeRightTabId}
          activeBottomTabId={activeBottomTabId}
          onSelectTab={handlePanelTabSelect}
          onCloseTab={closeTab}
          onDockTab={dockTab}
          onRenameTab={renameTab}
          onToggleWatch={toggleWatch}
          renderTab={renderTab}
        >
        <div className="terminal-container">
          {/* Render all center tabs directly to prevent remounting on tab switch.
              Uses the same renderTab() the side panels use (see the "dual tab-render
              dispatch" note) so both chains stay in sync automatically - this chain
              used to hand-duplicate renderTab's switch and had drifted (missing
              onSendToAgent for file/editor-panel, onCheckpointReadyChange for
              browser, and the missing-machineConfig guard for spyglass). */}
          {centerTabs.map((tab) => renderTab(tab as DockableTab, tab.id === activeTabId))}
          {centerTabs.length === 0 && (
            <div className="empty-state">
              {/* Content at top */}
              <div className="welcome-content">
                {/* Workspace selector and config editor at top */}
                <div className="workspace-actions-row">
                  <button
                    className="workspace-selector-btn"
                    onClick={() => setShowWorkspaceModal(true)}
                  >
                    <span className="workspace-icon"><Icon name="folder" size={14} /></span>
                    <span className="workspace-path">{workspace || 'No workspace selected'}</span>
                    <span className="workspace-change">Change</span>
                  </button>
                  <button
                    className="edit-config-btn"
                    onClick={() => setShowConfigEditor(true)}
                    title="Edit configuration"
                  >
                    <span><Icon name="settings" size={14} /></span>
                    <span>Config</span>
                  </button>
                </div>

                {/* Keyboard hints first */}
                <div className="keyboard-hints">
                  <div className="hint-item" onClick={() => setShowCommandPalette(true)} style={{ cursor: 'pointer' }}>
                    <span>Ask Hester</span>
                    <kbd>{getDisplayKeybinding('command_palette', 'meta+/')}</kbd>
                  </div>
                  <div className="hint-item">
                    <span>Switch Tab</span>
                    <kbd>⌘1-9</kbd>
                  </div>
                  <div className="hint-item">
                    <span>Next Tab</span>
                    <kbd>{getDisplayKeybinding('next_tab', 'ctrl+tab')}</kbd>
                  </div>
                  <div className="hint-item">
                    <span>Watch Tab</span>
                    <kbd>{getDisplayKeybinding('toggle_watch', 'meta+w')}</kbd>
                  </div>
                  <div className="hint-item">
                    <span>Idle Tabs</span>
                    <kbd>{getDisplayKeybinding('cycle_idle', 'meta+i')}</kbd>
                  </div>
                  <div className="hint-item">
                    <span>Open File</span>
                    <kbd>{getDisplayKeybinding('open_file', 'meta+o')}</kbd>
                  </div>
                  <div className="hint-item">
                    <span>Save</span>
                    <kbd>{getDisplayKeybinding('save_file', 'meta+s')}</kbd>
                  </div>
                </div>

                {/* Tool shortcuts bar - dynamic based on config */}
                <div className="shortcuts-bar">
                  {/* Hardcoded items */}
                  <div className="shortcut-chip" onClick={() => getOrCreateTab('files', undefined, workspace.split('/').pop() || 'Files')}>
                    <span className="shortcut-icon"><Icon name="folder" size={14} /></span>
                    <span className="shortcut-name">Files</span>
                    <kbd>{getDisplayKeybinding('files', 'meta+shift+e')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => createTab('terminal')}>
                    <span className="shortcut-icon"><Icon name="terminal" size={14} /></span>
                    <span className="shortcut-name">Terminal</span>
                    <kbd>{getDisplayKeybinding('terminal', 'meta+shift+t')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => createTab('browser')}>
                    <span className="shortcut-icon"><Icon name="browser" size={14} /></span>
                    <span className="shortcut-name">Browser</span>
                    <kbd>{getDisplayKeybinding('browser', 'meta+shift+b')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => getOrCreateTab('library')}>
                    <span className="shortcut-icon"><Icon name="book" size={14} /></span>
                    <span className="shortcut-name">Library</span>
                    <kbd>{getDisplayKeybinding('library', 'meta+shift+y')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => handleBridge()}>
                    <span className="shortcut-icon"><Icon name="link" size={14} /></span>
                    <span className="shortcut-name">Bridge</span>
                  </div>
                  {/* Dynamic TUI items from config */}
                  {Object.entries(config?.tuis || {}).map(([key, tui]: [string, any]) => {
                    const keybinding = config?.keybindings?.[key];
                    if (!keybinding) return null;  // Skip TUIs without keybindings
                    return (
                      <div key={key} className="shortcut-chip" onClick={() => createTab(key as any)}>
                        <span className="shortcut-icon">{tui.icon || <Icon name="settings" size={14} />}</span>
                        <span className="shortcut-name">{tui.name}</span>
                        <kbd>{formatKeybinding(keybinding)}</kbd>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Lee mark + wordmark at bottom */}
              <div className="splash-fixed">
                <img className="splash-mark" src="../lee-mark.svg" alt="" />
                <div className="splash-wordmark">Lee</div>
                <div className="splash-tagline">Lightweight Editing Environment</div>
              </div>
            </div>
          )}
        </div>
        </PanelLayout>
      </div>
      <StatusBar
        workspace={workspace}
        messages={statusMessages}
        daemonStatus={daemonStatus}
        onWorkspaceClick={() => setShowWorkspaceModal(true)}
        onEditConfig={() => setShowConfigEditor(true)}
        onReloadConfig={handleConfigReload}
        onHesterClick={() => setShowCommandPalette(true)}
        onMessageClick={handleStatusMessageClick}
        onClearMessage={handleClearStatusMessage}
        onDaemonAction={handleDaemonAction}
        onSpyglass={handleSpyglass}
        onBridge={handleBridge}
      />
      {showPairingDialog && (
        <PairingDialog onClose={() => setShowPairingDialog(false)} />
      )}
      {showBridgePicker && (
        <BridgePicker
          preselectedMachine={bridgePreselectedMachine}
          onSpawn={handleBridgeSpawn}
          onCancel={() => {
            setShowBridgePicker(false);
            setBridgePreselectedMachine(null);
          }}
        />
      )}
      {switchProviderDialog && (
        <div className="workspace-modal-overlay" onClick={() => setSwitchProviderDialog(null)}>
          <div className="switch-provider-modal" onClick={e => e.stopPropagation()}>
            <div className="switch-provider-modal-header">
              <div className="switch-provider-modal-title">Switch Agent Provider</div>
              <div className="switch-provider-modal-subtitle">
                Switch to <strong>{agentProviders[switchProviderDialog.newProvider]?.name ?? switchProviderDialog.newProvider}</strong>?
              </div>
            </div>
            <div className="switch-provider-modal-actions">
              <button className="switch-provider-btn switch-provider-btn-primary" onClick={() => confirmSwitchProvider('reload')}>
                Reload Tab
              </button>
              <button className="switch-provider-btn" onClick={() => confirmSwitchProvider('new-tab')}>
                New Tab
              </button>
              <button className="switch-provider-btn switch-provider-btn-cancel" onClick={() => setSwitchProviderDialog(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** Basename of a path, for user-facing messages. */
function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function getDefaultLabel(type: Tab['type']): string {
  switch (type) {
    case 'terminal':
      return 'Terminal';
    case 'editor':
      return 'Editor';
    case 'editor-panel':
      return 'Editor';
    case 'file':
      // Note: File tabs should always be created with filename as label
      return 'File';
    case 'files':
      // Note: This is a fallback - files tabs should always be created with workspace name as label
      return 'Files';
    case 'browser':
      return 'Browser';
    case 'hester':
      return 'Hester';
    case 'claude':
      return 'Claude';
    case 'git':
      return 'Git';
    case 'docker':
      return 'Docker';
    case 'flutter':
      return 'Flutter';
    case 'k8s':
      return 'K8s';
    case 'hester-qa':
      return 'Hester QA';
    case 'devops':
      return 'DevOps';
    case 'system':
      return 'System Monitor';
    case 'sql':
      return 'SQL';
    case 'library':
      return 'Library';
    case 'workstream':
      return 'Workstream';
    case 'custom':
      return 'TUI';
    case 'spyglass':
      return 'Spyglass';
    case 'bridge':
      return 'Bridge';
    case 'agent':
      return 'Agent';
    default:
      return 'Tab';
  }
}

export default App;
