/**
 * Lee App - Main React component
 *
 * The "Meta-IDE" interface with tab management, dockable panels, and terminal rendering.
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { TabBar, Tab, DockPosition, NewTabOption, getFileTabIcon } from './components/TabBar';
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
import { BridgePicker } from './components/BridgePicker';
import { GlobalConfigEditorModal } from './components/GlobalConfigEditorModal';
import { useHotkeys } from './hooks/useHotkeys';
import { focusManager } from './hooks/useFocusManager';
import { ptyEventManager } from './hooks/usePtyEvents';

// Get the Lee API from preload
const lee = (window as any).lee;

// Check if we're running inside Electron
const isElectron = !!lee;

// Editor daemon port (set when editor reports ready via state)
const EDITOR_DAEMON_PORT = 9002;

export interface TabData extends Tab {
  ptyId: number | null;
  dockPosition: DockPosition;
  // File-specific data (for type='file')
  fileContent?: string;
  fileOriginalContent?: string;
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

  // Workstream picker modal
  const [showWorkstreamPicker, setShowWorkstreamPicker] = useState<boolean>(false);

  // Bridge picker modal
  const [showBridgePicker, setShowBridgePicker] = useState(false);
  const [bridgePreselectedMachine, setBridgePreselectedMachine] = useState<any>(null);

  // Helper to convert config keybinding format to useHotkeys format
  // Config uses: cmd+shift+t, useHotkeys uses: meta+shift+t
  const normalizeKeybinding = useCallback((binding: string): string => {
    return binding
      .replace(/cmd/gi, 'meta')
      .replace(/command/gi, 'meta')
      .toLowerCase();
  }, []);

  // Get keybinding from config or use default
  const getKeybinding = useCallback((action: string, defaultBinding: string): string => {
    const configBinding = config?.keybindings?.[action];
    return configBinding ? normalizeKeybinding(configBinding) : defaultBinding;
  }, [config, normalizeKeybinding]);

  // Format keybinding for display (e.g., meta+shift+t → ⇧⌘T)
  const formatKeybinding = useCallback((binding: string): string => {
    const parts = binding.toLowerCase().split('+');
    let result = '';

    // Order: ctrl, alt, shift, meta, then key
    if (parts.includes('ctrl') || parts.includes('control')) result += '⌃';
    if (parts.includes('alt') || parts.includes('option')) result += '⌥';
    if (parts.includes('shift')) result += '⇧';
    if (parts.includes('meta') || parts.includes('cmd') || parts.includes('command')) result += '⌘';

    // Get the main key (last non-modifier)
    const key = parts.find(p => !['ctrl', 'control', 'alt', 'option', 'shift', 'meta', 'cmd', 'command'].includes(p));
    if (key) {
      // Special key mappings
      const keyMap: Record<string, string> = {
        'tab': 'Tab',
        'esc': 'Esc',
        'escape': 'Esc',
        'enter': '↵',
        'return': '↵',
        'arrowup': '↑',
        'arrowdown': '↓',
        'arrowleft': '←',
        'arrowright': '→',
        '/': '/',
      };
      result += keyMap[key] || key.toUpperCase();
    }

    return result;
  }, []);

  // Get formatted keybinding for display
  const getDisplayKeybinding = useCallback((action: string, defaultBinding: string): string => {
    const binding = getKeybinding(action, defaultBinding);
    return formatKeybinding(binding);
  }, [getKeybinding, formatKeybinding]);

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
  }

  // Save session (open tabs and their positions) to localStorage
  const saveSession = useCallback((currentTabs: TabData[], ws: string) => {
    if (!ws) return;
    const sessionTabs: SessionTab[] = currentTabs.map(t => ({
      type: t.type,
      label: t.label,
      dockPosition: t.dockPosition,
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

  // Send a command to the editor daemon via HTTP
  const sendEditorCommand = useCallback(async (
    endpoint: string,
    body: Record<string, unknown> = {}
  ): Promise<boolean> => {
    const port = editorDaemonPort || EDITOR_DAEMON_PORT;

    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      console.log(`Editor command ${endpoint}:`, result);
      return result.success;
    } catch (error) {
      console.error(`Failed to send editor command ${endpoint}:`, error);
      return false;
    }
  }, [editorDaemonPort]);

  // Create a new tab - defined BEFORE useEffects that depend on it
  const createTab = useCallback(async (type: Tab['type'], dockPosition?: DockPosition, label?: string) => {
    // Bridge type opens the picker instead of creating a tab directly
    if (type === 'bridge' as any) {
      setBridgePreselectedMachine(null);
      setShowBridgePicker(true);
      return null;
    }

    // Non-PTY tabs that don't need Electron
    const nonPtyTabs: Tab['type'][] = ['files', 'editor-panel', 'browser', 'library', 'workstream', 'spyglass'];

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
            ptyId = await lee.pty.spawn(undefined, [], workspace, tabLabel);
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
        }
        // Mark this PTY as expected so data is buffered until handler registers
        if (ptyId !== null) {
          ptyEventManager.expect(ptyId);
        }
      } catch (error) {
        console.error(`Failed to spawn ${type}:`, error);
        return null;
      }
    }

    // Use provided dock position or default to center
    const finalDockPosition = dockPosition ?? 'center';

    const newTab: TabData = {
      id: tabId,
      type,
      label: tabLabel,
      closable: true, // All tabs are closable
      ptyId,
      dockPosition: finalDockPosition,
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
  }, [workspace]);

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

  // Close a tab
  const closeTab = useCallback((tabId: number) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !tab.closable) return;

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
  }, [tabs, centerTabs, leftTabs, rightTabs, bottomTabs, activeTabId, activeLeftTabId, activeRightTabId, activeBottomTabId, workspace, saveSession]);

  // Keep closeTabRef in sync for use in event handlers (avoids stale closures)
  useEffect(() => {
    closeTabRef.current = closeTab;
  }, [closeTab]);

  // Close all tabs and kill their PTY processes (used during workspace switch)
  const closeAllTabs = useCallback(() => {
    for (const tab of tabsRef.current) {
      if (tab.ptyId !== null && isElectron) {
        lee.pty.kill(tab.ptyId);
      }
    }
    ptyEventManager.clearAll();
    setTabs([]);
    setActiveTabId(null);
    setActiveLeftTabId(null);
    setActiveRightTabId(null);
    setActiveBottomTabId(null);
  }, []);

  // Switch to a new workspace: save old session, close tabs, restore new session
  const switchWorkspace = useCallback((newWorkspace: string) => {
    if (newWorkspace === workspace) return;

    isSwitchingRef.current = true;

    // Save current tabs to the OLD workspace's session before switching
    saveSession(tabsRef.current, workspace);

    closeAllTabs();

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

  // Toggle watch state for a tab (idle detection)
  const toggleWatch = useCallback((tabId: number) => {
    setTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, watched: !tab.watched, isIdle: false } : tab
    ));
  }, []);

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
  const handleFileOpen = useCallback(async (filePath: string) => {
    console.log('Opening file:', filePath);

    // Check if file is already open
    const existingTab = tabs.find((t) => t.type === 'file' && t.filePath === filePath);
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
      const content = await lee.fs.readFile(filePath);
      const fileName = filePath.split('/').pop() || filePath;
      const language = getLanguageName(filePath);

      const tabId = nextTabIdRef.current++;
      const newTab: TabData = {
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
      };

      lee.context.recordAction('file_open', filePath);
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      setFocusedPanel('center');
      return tabId;
    } catch (error) {
      console.error('Failed to open file:', error);
      return null;
    }
  }, [tabs, getLanguageName]);

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

    try {
      const result = await lee.fs.writeFile(tab.filePath, tab.fileContent || '');
      if (result.success) {
        setTabs((prev) => prev.map((t) =>
          t.id === targetTabId
            ? { ...t, fileModified: false, fileOriginalContent: t.fileContent }
            : t
        ));
        lee.context.recordAction('file_save', tab.filePath);
      } else {
        console.error('Failed to save file:', result.error);
      }
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  }, [tabs, activeTabId]);

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
  const handleFrameSnapshotCaptured = useCallback((tabId: number, dir: string) => {
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
          type: 'hester',
          label: 'Hester',
          closable: true,
          ptyId,
          dockPosition: 'center',
        };

        lee.context.recordAction('tab_create', `${tabId}:hester:${sessionId}`);
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(tabId);
        setFocusedPanel('center');
      }
    } catch (error) {
      console.error('Failed to spawn Hester with session:', error);
    }
  }, [workspace]);

  // Handle Ask Hester from file tree context menu
  // autoSubmit defaults to true - set false to pre-populate without sending
  const handleAskHester = useCallback((prompt: string, autoSubmit: boolean = true) => {
    setPendingPrompt(prompt);
    setAutoSubmitPrompt(autoSubmit);
    setShowCommandPalette(true);
  }, []);

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
          active={active}
        />
      );
    }

    if (tab.type === 'file') {
      return (
        <EditorPanel
          key={tab.id}
          workspace={workspace}
          active={active}
          filePath={tabData.filePath}
          fileContent={tabData.fileContent}
          fileLanguage={tabData.fileLanguage}
          fileModified={tabData.fileModified}
          onContentChange={(content) => handleFileContentChange(tab.id, content)}
          onSave={() => handleFileSave(tab.id)}
          onAskHester={handleAskHester}
          onOpenFile={handleFileOpen}
        />
      );
    }

    if (tab.type === 'editor-panel') {
      return (
        <EditorPanel
          key={tab.id}
          workspace={workspace}
          active={active}
          onAskHester={handleAskHester}
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
      return (
        <SpyglassPane
          key={tab.id}
          active={active}
          machineConfig={tabData.machineConfig!}
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
      switchWorkspace(selectedWorkspace);
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
        switchWorkspace(cwd);
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
    const cleanupState = lee.pty.onState((id: number, state: any) => {
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
    }
  }, []);

  // Refetch TUI options whenever config changes
  useEffect(() => {
    fetchTuiOptions();
  }, [config, fetchTuiOptions]);

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
      // Re-check health after action
      setTimeout(checkDaemonHealth, 1500);
    } catch (error) {
      console.error(`Daemon ${action} error:`, error);
      setDaemonStatus('unhealthy');
    }
  }, [checkDaemonHealth]);

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
    const remoteCmd = tui.key === 'terminal'
      ? `cd ${workspace} && exec $SHELL -l`
      : `cd ${workspace} && ${tui.command}${tui.args ? ' ' + tui.args.join(' ') : ''}`;

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
        for (const sessionTab of savedSession) {
          // Files tabs should always use workspace name as label
          const label = sessionTab.type === 'files' ? workspaceName : sessionTab.label;
          await createTab(sessionTab.type, sessionTab.dockPosition, label);
        }
        setSessionRestored(true);
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
        })),
        activeTabId,
        activeLeftTabId,
        activeRightTabId,
        activeBottomTabId,
        focusedPanel,
        workspace,
        editorDaemonPort,
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
      switchWorkspace(folderPath);
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
          setTabs((prev) => prev.map((t) =>
            t.id === activeTabId
              ? {
                  ...t,
                  filePath,
                  label: fileName,
                  fileModified: false,
                  fileOriginalContent: t.fileContent,
                  fileLanguage: getLanguageName(filePath),
                }
              : t
          ));
          lee.context.recordAction('file_save_as', filePath);
        } else {
          console.error('Failed to save file as:', result.error);
        }
      } catch (error) {
        console.error('Failed to save file as:', error);
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

    return () => {
      lee.file.removeAllListeners();
      lee.menu.removeAllListeners();
    };
  }, [handleNewFile, handleFileOpen, handleFileSave, switchWorkspace, tabs, activeTabId, getLanguageName]);

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
    const cleanupCreateTab = lee.system.onCreateTab(async (params: { type: string; label?: string; cwd?: string }) => {
      console.log('[System] Create tab requested:', params);
      await createTab(params.type as Tab['type'], 'center', params.label);
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

  // Build hotkey map from config (with defaults)
  const hotkeyMap = useMemo(() => {
    const map: Record<string, () => void> = {};

    // Command Palette
    map[getKeybinding('command_palette', 'meta+/')] = () => {
      const currentMessage = statusMessages.length > 0 ? statusMessages[statusMessages.length - 1] : null;
      if (currentMessage?.prompt) {
        setPendingPrompt(currentMessage.prompt);
        setShowCommandPalette(true);
        setStatusMessages((prev) => prev.filter((m) => m.id !== currentMessage.id));
      } else {
        setShowCommandPalette(true);
      }
    };
    map['meta+shift+/'] = () => {
      setPendingPrompt(null);
      setShowCommandPalette(true);
    };

    // TUI launchers (from config or defaults)
    map[getKeybinding('terminal', 'meta+shift+t')] = () => createTab('terminal');
    map[getKeybinding('browser', 'meta+shift+b')] = () => createTab('browser');
    map[getKeybinding('files', 'meta+shift+e')] = () => getOrCreateTab('files', undefined, workspace.split('/').pop() || 'Files');
    map[getKeybinding('hester', 'meta+shift+h')] = () => createTab('hester');
    map[getKeybinding('claude', 'meta+shift+c')] = () => createTab('claude');
    map[getKeybinding('git', 'meta+shift+g')] = () => createTab('git');
    map[getKeybinding('docker', 'meta+shift+d')] = () => createTab('docker');
    map[getKeybinding('flutter', 'meta+shift+f')] = () => createTab('flutter');
    map[getKeybinding('k8s', 'meta+shift+k')] = () => createTab('k8s');
    map[getKeybinding('sql', 'meta+shift+p')] = () => createTab('sql');
    map[getKeybinding('hester_qa', 'meta+shift+q')] = () => createTab('hester-qa');
    map[getKeybinding('library', 'meta+shift+y')] = () => getOrCreateTab('library');
    map[getKeybinding('devops', 'meta+shift+o')] = () => getOrCreateTab('devops');
    map[getKeybinding('system', 'meta+shift+m')] = () => getOrCreateTab('system');
    map[getKeybinding('workstream', 'meta+shift+w')] = () => setShowWorkstreamPicker(true);

    // Tab switching (Cmd+1-9)
    map[getKeybinding('tab_1', 'meta+1')] = () => { activateTab(centerTabs[0]); setFocusedPanel('center'); };
    map[getKeybinding('tab_2', 'meta+2')] = () => { activateTab(centerTabs[1]); setFocusedPanel('center'); };
    map[getKeybinding('tab_3', 'meta+3')] = () => { activateTab(centerTabs[2]); setFocusedPanel('center'); };
    map[getKeybinding('tab_4', 'meta+4')] = () => { activateTab(centerTabs[3]); setFocusedPanel('center'); };
    map[getKeybinding('tab_5', 'meta+5')] = () => { activateTab(centerTabs[4]); setFocusedPanel('center'); };
    map[getKeybinding('tab_6', 'meta+6')] = () => { activateTab(centerTabs[5]); setFocusedPanel('center'); };
    map[getKeybinding('tab_7', 'meta+7')] = () => { activateTab(centerTabs[6]); setFocusedPanel('center'); };
    map[getKeybinding('tab_8', 'meta+8')] = () => { activateTab(centerTabs[7]); setFocusedPanel('center'); };
    map[getKeybinding('tab_9', 'meta+9')] = () => { activateTab(centerTabs[8]); setFocusedPanel('center'); };

    // Tab navigation
    map[getKeybinding('next_tab', 'ctrl+tab')] = () => {
      if (centerTabs.length > 1 && activeTabId) {
        const currentIndex = centerTabs.findIndex((t) => t.id === activeTabId);
        const nextIndex = (currentIndex + 1) % centerTabs.length;
        setActiveTabId(centerTabs[nextIndex].id);
        setFocusedPanel('center');
      }
    };
    map[getKeybinding('prev_tab', 'ctrl+shift+tab')] = () => {
      if (centerTabs.length > 1 && activeTabId) {
        const currentIndex = centerTabs.findIndex((t) => t.id === activeTabId);
        const prevIndex = currentIndex === 0 ? centerTabs.length - 1 : currentIndex - 1;
        setActiveTabId(centerTabs[prevIndex].id);
        setFocusedPanel('center');
      }
    };

    // Watch/Idle system
    map[getKeybinding('toggle_watch', 'meta+w')] = () => activeTabId && toggleWatch(activeTabId);
    map[getKeybinding('cycle_idle', 'meta+i')] = () => {
      const idleTabs = tabs.filter(t => t.watched && t.isIdle);
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
    map[getKeybinding('close_tab', 'meta+esc')] = () => activeTabId && closeTab(activeTabId);

    // Scroll to bottom
    map['meta+arrowdown'] = () => focusManager.scrollToBottom();

    return map;
  }, [config, getKeybinding, statusMessages, workspace, centerTabs, activeTabId, activeLeftTabId, activeRightTabId, activeBottomTabId, tabs, createTab, getOrCreateTab, activateTab, toggleWatch, closeTab]);

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
        onNewTab={(type, dockPosition) => createTab(type, dockPosition)}
        onDockTab={dockTab}
        onRenameTab={renameTab}
        onToggleWatch={toggleWatch}
        onRefocus={() => focusManager.refocus()}
        onConfigureTUIs={() => {
          setConfigEditorInitialSection('tuis');
          setShowConfigEditor(true);
        }}
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
          {/* Render all center tabs directly to prevent remounting on tab switch */}
          {centerTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            if (tab.type === 'files') {
              return (
                <FileTreePane
                  key={tab.id}
                  workspace={workspace}
                  onFileOpen={handleFileOpen}
                  onNewFile={handleNewFile}
                  onAskHester={handleAskHester}
                  active={isActive}
                />
              );
            }
            if (tab.type === 'file') {
              // File tabs render EditorPanel with single file
              return (
                <EditorPanel
                  key={tab.id}
                  workspace={workspace}
                  active={isActive}
                  filePath={tab.filePath}
                  fileContent={tab.fileContent}
                  fileLanguage={tab.fileLanguage}
                  fileModified={tab.fileModified}
                  onContentChange={(content) => handleFileContentChange(tab.id, content)}
                  onSave={() => handleFileSave(tab.id)}
                  onAskHester={handleAskHester}
                  onOpenFile={handleFileOpen}
                />
              );
            }
            if (tab.type === 'editor-panel') {
              // Legacy editor-panel type - redirect to empty state
              return (
                <EditorPanel
                  key={tab.id}
                  workspace={workspace}
                  active={isActive}
                  onAskHester={handleAskHester}
                />
              );
            }
            if (tab.type === 'browser') {
              return (
                <BrowserPane
                  key={tab.id}
                  active={isActive}
                  tabId={tab.id}
                  initialUrl={tab.browserUrl}
                  watched={tab.watched}
                  onTitleChange={(title) => handleBrowserTitleChange(tab.id, title)}
                  onUrlChange={(url) => handleBrowserUrlChange(tab.id, url)}
                  onLoadingChange={(loading) => handleBrowserLoadingChange(tab.id, loading)}
                  onAskHester={handleAskHester}
                  onErrorCountChange={(count) => handleBrowserErrorCountChange(tab.id, count)}
                  onFrameSnapshotCaptured={(dir) => handleFrameSnapshotCaptured(tab.id, dir)}
                />
              );
            }
            if (tab.type === 'library') {
              return (
                <LibraryPane
                  key={tab.id}
                  active={isActive}
                  workspace={workspace}
                  onOpenFile={handleFileOpen}
                />
              );
            }
            if (tab.type === 'workstream') {
              return (
                <WorkstreamPane
                  key={tab.id}
                  active={isActive}
                  workspace={workspace}
                  workstreamId={tab.workstreamId || ''}
                />
              );
            }
            return (
              <TerminalPane
                key={tab.id}
                ptyId={tab.ptyId}
                active={isActive}
                label={tab.label}
                watched={tab.watched}
                onIdleChange={handleIdleChange}
              />
            );
          })}
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
                    <span className="workspace-icon">📁</span>
                    <span className="workspace-path">{workspace || 'No workspace selected'}</span>
                    <span className="workspace-change">Change</span>
                  </button>
                  <button
                    className="edit-config-btn"
                    onClick={() => setShowConfigEditor(true)}
                    title="Edit configuration"
                  >
                    <span>⚙️</span>
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
                    <span className="shortcut-icon">📂</span>
                    <span className="shortcut-name">Files</span>
                    <kbd>{getDisplayKeybinding('files', 'meta+shift+e')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => createTab('terminal')}>
                    <span className="shortcut-icon">💻</span>
                    <span className="shortcut-name">Terminal</span>
                    <kbd>{getDisplayKeybinding('terminal', 'meta+shift+t')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => createTab('browser')}>
                    <span className="shortcut-icon">🌐</span>
                    <span className="shortcut-name">Browser</span>
                    <kbd>{getDisplayKeybinding('browser', 'meta+shift+b')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => getOrCreateTab('library')}>
                    <span className="shortcut-icon">📚</span>
                    <span className="shortcut-name">Library</span>
                    <kbd>{getDisplayKeybinding('library', 'meta+shift+y')}</kbd>
                  </div>
                  <div className="shortcut-chip" onClick={() => handleBridge()}>
                    <span className="shortcut-icon">🌉</span>
                    <span className="shortcut-name">Bridge</span>
                  </div>
                  {/* Dynamic TUI items from config */}
                  {Object.entries(config?.tuis || {}).map(([key, tui]: [string, any]) => {
                    const keybinding = config?.keybindings?.[key];
                    if (!keybinding) return null;  // Skip TUIs without keybindings
                    return (
                      <div key={key} className="shortcut-chip" onClick={() => createTab(key as any)}>
                        <span className="shortcut-icon">{tui.icon || '🔧'}</span>
                        <span className="shortcut-name">{tui.name}</span>
                        <kbd>{formatKeybinding(keybinding)}</kbd>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Splash image at bottom */}
              <div className="splash-fixed">
                <img src="../splash.png" alt="Lee" />
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
    </div>
  );
};

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
    default:
      return 'Tab';
  }
}

export default App;
