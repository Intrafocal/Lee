/**
 * Lee Electron Main Process
 *
 * The "Meta-IDE" - a terminal multiplexer that spawns specialized CLI tools.
 */

import { app, BrowserWindow, ipcMain, globalShortcut, Menu, dialog, clipboard, nativeImage, session, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
import QRCode from 'qrcode';
import { PTYManager } from './pty-manager';
import { APIServer } from './api-server';
import { ContextBridge } from './context-bridge';
import { BrowserManager } from './browser-manager';
import { RendererContextUpdate, UserActionType } from '../shared/context';
import { saveDebugTrace, DebugTrace } from './debug-trace';
import { MachineManager } from './machine-manager';
import { MdnsAdvertiser } from './mdns-advertiser';
import { loadMergedConfig, loadConfigWithProvenance } from './config-loader';
import { fsWatcher } from './fs-watcher';
import {
  SHORTCUTS,
  GLOBAL_FOCUS_ACTION,
  formatChord,
  menuAccelerator,
  normalizeChord,
  resolveChord,
  toAccelerator,
} from '../shared/shortcuts';

// File entry type for directory listing
interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

import { windowRegistry } from './window-registry';

// Single-instance lock: a second `lee` launch used to get its own PTYManager
// and try (and fail) to bind the same :9000/:9001 ports, with the failure
// going nowhere visible - a dead API server, silently. Bail out immediately
// instead and hand off to the already-running instance.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // No CLI/workspace-path argument parsing exists in this app today (the
    // renderer's own workspace picker owns that flow), so there's no argv
    // to route to a new window here - just bring the existing one forward.
    const ws = windowRegistry.getFocused() || windowRegistry.getAny();
    if (ws) {
      if (ws.browserWindow.isMinimized()) ws.browserWindow.restore();
      ws.browserWindow.focus();
    }
  });
}

// Global singletons (shared across all windows)
let ptyManager: PTYManager;
let apiServer: APIServer;
let browserManager: BrowserManager;
let machineManager: MachineManager;
let mdnsAdvertiser: MdnsAdvertiser;

// Check if we're in development mode (explicitly set or running with vite dev server)
const isDev = process.env.NODE_ENV === 'development';

// Track if quit has been confirmed to avoid showing dialog twice
let quitConfirmed = false;
// Ensures the graceful-daemon-shutdown path in will-quit runs at most once
let daemonShutdownAttempted = false;

// Track which windows have reload confirmed (per-window)
const reloadConfirmedWindows = new Set<number>();

// Helper function to confirm and reload (shared by menu and keyboard shortcut)
async function confirmAndReload(bw: BrowserWindow, forceReload: boolean): Promise<void> {
  const activeCount = ptyManager?.getActiveCountForWindow(bw.id) ?? 0;

  if (activeCount > 0) {
    const terminalNames = ptyManager.getActiveNamesForWindow(bw.id);
    const terminalList = terminalNames.length <= 5
      ? terminalNames.join(', ')
      : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

    const result = await dialog.showMessageBox(bw, {
      type: 'question',
      buttons: ['Reload', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Reload Lee?',
      message: `You have ${activeCount} active terminal${activeCount > 1 ? 's' : ''} open`,
      detail: `Running: ${terminalList}\n\nAre you sure you want to reload? All terminal sessions will be closed.`,
    });

    if (result.response === 0) {
      // User clicked "Reload"
      reloadConfirmedWindows.add(bw.id);
      fsWatcher.releaseWindow(bw.id);
      ptyManager?.killForWindow(bw.id);
      if (forceReload) {
        bw.webContents.reloadIgnoringCache();
      } else {
        bw.webContents.reload();
      }
      setTimeout(() => { reloadConfirmedWindows.delete(bw.id); }, 100);
    }
  } else {
    // No active terminals, still kill any prewarmed/background PTYs (daemon, warm
    // pool entries) owned by this window so reload doesn't leak them.
    fsWatcher.releaseWindow(bw.id);
    ptyManager?.killForWindow(bw.id);
    if (forceReload) {
      bw.webContents.reloadIgnoringCache();
    } else {
      bw.webContents.reload();
    }
  }
}

// Track windows that have confirmed close (to avoid double-dialog)
const closeConfirmedWindows = new Set<number>();

function createWindow(workspace?: string): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const bw = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Lee',
    ...(isMac ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 15, y: 10 },
    } : {}),
    backgroundColor: '#0d1a14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for node-pty IPC
      webviewTag: true, // Enable <webview> tag for browser tabs
    },
  });

  // Set Content Security Policy headers for the renderer
  bw.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          // Google Fonts: KiCanvas (KiCad viewer) loads its toolbar icon font remotely
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "img-src 'self' data: blob:; " +
          "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; " +
          "font-src 'self' data: https://fonts.gstatic.com; " +
          "frame-src 'self'"
        ],
      },
    });
  });

  // Create per-window ContextBridge
  const contextBridge = new ContextBridge(workspace || process.cwd());

  // Register with WindowRegistry
  windowRegistry.register(bw, workspace || null, contextBridge);

  // Rebuild menu to show new window in workspace list
  setupApplicationMenu();

  // Wire context changes to API server broadcasting
  contextBridge.on('change', (ctx: any) => {
    apiServer?.broadcastContext(bw.id, ctx);
  });

  // Wire PTY state to this window's context bridge
  const onPtyState = (id: number, state: any) => {
    const ownerWindow = ptyManager.getWindowForPty(id);
    if (ownerWindow === bw.id) {
      contextBridge.updateFromPty(id, state);
    }
  };
  ptyManager.on('state', onPtyState);

  // Wire browser state to context bridge
  const onBrowserState = (state: any) => {
    contextBridge.updateBrowserContext(state);
  };
  browserManager.on('state', onBrowserState);

  // Prune closed browser tabs from context too, or Hester keeps "seeing" tabs
  // that no longer exist.
  const onBrowserUnregister = (tabId: number) => {
    contextBridge.removeBrowserContext(tabId);
  };
  browserManager.on('unregister', onBrowserUnregister);

  // Build URL hash to communicate window init state to renderer
  // - #new → show workspace modal (no pre-selected workspace)
  // - #workspace=<path> → use this workspace directly, skip modal
  // - (no hash) → first window, use localStorage lastWorkspace as usual
  const isFirstWindow = windowRegistry.getAll().size === 1;
  let urlHash = '';
  if (workspace) {
    urlHash = `#workspace=${encodeURIComponent(workspace)}`;
  } else if (!isFirstWindow) {
    // New window without workspace → show modal
    urlHash = '#new';
  }

  // Load the app
  if (isDev) {
    bw.loadURL(`http://localhost:5173${urlHash}`);
    bw.webContents.openDevTools();
  } else {
    bw.loadFile(path.join(__dirname, '../renderer/public/index.html'), {
      hash: urlHash.replace('#', ''),
    });
  }

  // Update menu checkmarks when this window gains focus
  bw.on('focus', () => {
    setupApplicationMenu();
    // One daemon serves every window, so re-point it at the focused window's
    // workspace (no-ops when it already matches).
    const focusedWorkspace = windowRegistry.get(bw.id)?.workspace;
    if (focusedWorkspace) {
      // The focused window's config is what the shared daemon runs with (C12):
      // its API key, model, listen host and working directory.
      ptyManager.setDaemonWindow(bw.id);
      ptyManager.setDaemonWorkspace(focusedWorkspace).catch(() => { /* daemon may be down */ });
    }
    // Menu accelerators follow the focused window's keybindings.
    const focusedConfig = ptyManager.getWindowConfig(bw.id)?.config;
    if (focusedConfig) applyConfigToMainProcess(focusedConfig, focusedWorkspace ?? undefined);
  });

  bw.on('closed', () => {
    // Drop this window's fs watches (editor file watches, file-tree dirs)
    fsWatcher.releaseWindow(bw.id);

    // Remove event listeners
    ptyManager.removeListener('state', onPtyState);
    browserManager.removeListener('state', onBrowserState);
    browserManager.removeListener('unregister', onBrowserUnregister);

    // Kill PTYs owned by this window
    ptyManager.killForWindow(bw.id);

    // Unregister from registry
    windowRegistry.unregister(bw.id);
    closeConfirmedWindows.delete(bw.id);
    reloadConfirmedWindows.delete(bw.id);

    // Rebuild menu to update workspace window list
    setupApplicationMenu();
  });

  // Handle window close with confirmation dialog
  bw.on('close', async (event) => {
    // Skip if quit already confirmed or this window's close already confirmed
    if (quitConfirmed || closeConfirmedWindows.has(bw.id)) return;

    const activeCount = ptyManager?.getActiveCountForWindow(bw.id) ?? 0;

    if (activeCount > 0) {
      // Prevent close until user confirms
      event.preventDefault();

      const terminalNames = ptyManager.getActiveNamesForWindow(bw.id);
      const terminalList = terminalNames.length <= 5
        ? terminalNames.join(', ')
        : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

      const result = await dialog.showMessageBox(bw, {
        type: 'question',
        buttons: ['Close Window', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Close Window?',
        message: `You have ${activeCount} active terminal${activeCount > 1 ? 's' : ''} open`,
        detail: `Running: ${terminalList}\n\nAre you sure you want to close this window? All terminal sessions will be closed.`,
      });

      if (result.response === 0) {
        // User clicked "Close Window" - set flag and close
        closeConfirmedWindows.add(bw.id);
        bw.close();
      }
      // If user clicked "Cancel", do nothing - close is already prevented
    }
  });

  // Intercept Cmd+R / Cmd+Shift+R to show reload confirmation.
  // Ctrl+R is deliberately NOT treated as reload here: it's bash's
  // reverse-search inside a terminal tab, and on non-mac platforms it's a
  // plain shell/editor chord too - only Cmd (meta) means "reload the IDE".
  // Also skip entirely when the focused tab is a terminal/agent/browser tab
  // so their own Cmd+R handling (or lack thereof) isn't preempted.
  bw.webContents.on('before-input-event', async (event, input) => {
    const isReloadKey = input.meta && input.key.toLowerCase() === 'r';
    if (!isReloadKey) return;

    const focusedTabType = windowRegistry.get(bw.id)?.contextBridge.getFocusedTabType();
    if (focusedTabType === 'terminal' || focusedTabType === 'agent' || focusedTabType === 'browser') {
      return;
    }

    if (!reloadConfirmedWindows.has(bw.id)) {
      event.preventDefault();
      await confirmAndReload(bw, input.shift);
    }
  });

  return bw;
}

/**
 * The focused window's `keybindings:` block, used to build menu accelerators.
 * Updated whenever a merged config is loaded (see applyConfigToMainProcess).
 */
let currentKeybindings: Record<string, string> = {};

/** The system-wide chord currently registered, if any. */
let registeredGlobalChord: string | null = null;

function focusLeeWindow(): void {
  const ws = windowRegistry.getFocused() || windowRegistry.getAny();
  if (!ws) return;
  if (ws.browserWindow.isMinimized()) ws.browserWindow.restore();
  ws.browserWindow.focus();
}

/**
 * Register (or clear) the system-wide "bring Lee forward" chord.
 *
 * This used to be an unconditional `CommandOrControl+Shift+L`, which took
 * that chord away from every other application on the machine whether or not
 * anyone wanted it. It's now opt-in: set
 * `keybindings.global_focus_lee: cmd+shift+l` in config.yaml. Any falsy or
 * empty value leaves the chord alone.
 */
function applyGlobalFocusShortcut(keybindings: Record<string, string> | null | undefined): void {
  const raw = keybindings?.[GLOBAL_FOCUS_ACTION];
  const wanted =
    typeof raw === 'string' && raw.trim() && !['false', 'off', 'none'].includes(raw.trim().toLowerCase())
      ? toAccelerator(normalizeChord(raw))
      : null;

  if (wanted === registeredGlobalChord) return;

  if (registeredGlobalChord) {
    globalShortcut.unregister(registeredGlobalChord);
    registeredGlobalChord = null;
  }
  if (!wanted) return;

  try {
    if (globalShortcut.register(wanted, focusLeeWindow)) {
      registeredGlobalChord = wanted;
      console.log('[Lee] Registered global focus shortcut:', wanted);
    } else {
      pushStatus('warn', `Couldn't register the system-wide shortcut ${wanted} - another app already owns it`);
    }
  } catch (error: any) {
    pushStatus('warn', `Couldn't register the system-wide shortcut ${wanted}: ${error?.message || error}`);
  }
}

/**
 * Apply the parts of a merged config the main process itself owns: menu
 * accelerators and the optional system-wide focus chord.
 */
function applyConfigToMainProcess(config: any, workspace?: string): void {
  const keybindings = (config?.keybindings && typeof config.keybindings === 'object')
    ? (config.keybindings as Record<string, string>)
    : {};
  currentKeybindings = keybindings;
  applyGlobalFocusShortcut(keybindings);
  setupApplicationMenu();
  // Same hook A3 uses to notify the daemon of the focused workspace - reused
  // here to keep the mDNS `ws` TXT record and advertise_mdns opt-out current.
  mdnsAdvertiser?.applyConfig(config, workspace);
}

/** Pretty chord for the Help > Keyboard Shortcuts listing. */
function formatChordForMenu(action: string): string {
  return formatChord(resolveChord(action, currentKeybindings)).padEnd(8, ' ');
}

function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  // Accelerators come from the shared registry (src/shared/shortcuts.ts).
  // `accel()` returns undefined for actions the renderer owns, so a menu item
  // can still exist for discoverability without double-firing the action.
  const accel = (action: string) => menuAccelerator(action, currentKeybindings);

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Edit Workspace Config...',
          accelerator: accel('edit_workspace_config'),
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:edit-config');
          },
        },
        {
          label: 'Edit Lee Config...',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:edit-global-config');
          },
        },
        {
          label: 'Switch Workspace...',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:switch-workspace');
          },
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),

    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New File',
          accelerator: accel('new_file'),
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('file:new');
          },
        },
        {
          label: 'New Window',
          accelerator: accel('new_window'),
          click: () => {
            createWindow();
          },
        },
        { type: 'separator' },
        {
          label: 'Open...',
          accelerator: accel('open_file'),
          click: async () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow) return;
            const result = await dialog.showOpenDialog(focusedWindow, {
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              focusedWindow.webContents.send('file:open', result.filePaths[0]);
            }
          },
        },
        {
          label: 'Open Folder...',
          accelerator: accel('open_folder'),
          click: async () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow) return;
            const result = await dialog.showOpenDialog(focusedWindow, {
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              focusedWindow.webContents.send('folder:open', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: accel('save_file'),
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('file:save');
          },
        },
        {
          label: 'Save As...',
          accelerator: accel('save_file_as'),
          click: async () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (!focusedWindow) return;
            const result = await dialog.showSaveDialog(focusedWindow, {});
            if (!result.canceled && result.filePath) {
              focusedWindow.webContents.send('file:save-as', result.filePath);
            }
          },
        },
        { type: 'separator' },
        // Deliberately NOT `role: 'close'`: that role carries an implicit
        // CmdOrCtrl+W accelerator, and the OS resolves menu accelerators
        // before the renderer sees the key - so Cmd+W closed the window
        // instead of toggling watch on the focused agent tab, which is what
        // it's documented to do. The item stays; only its chord is gone.
        isMac
          ? {
              label: 'Close Window',
              click: () => { BrowserWindow.getFocusedWindow()?.close(); },
            }
          : { role: 'quit' as const },
      ],
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' as const },
          { role: 'delete' as const },
          { role: 'selectAll' as const },
        ] : [
          { role: 'delete' as const },
          { type: 'separator' as const },
          { role: 'selectAll' as const },
        ]),
      ],
    },

    // View menu
    {
      label: 'View',
      submenu: [
        {
          // No accelerator: CmdOrCtrl+R used to double-bind this (menu +
          // before-input-event), and on mac Ctrl+R is bash's reverse-search,
          // not "reload the IDE". Reload is still reachable from this menu
          // item by click, or via Cmd+Shift+R (Force Reload) below.
          label: 'Reload',
          click: async () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) await confirmAndReload(focused, false);
          },
        },
        {
          label: 'Force Reload',
          accelerator: accel('force_reload'),
          click: async () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) await confirmAndReload(focused, true);
          },
        },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
        { type: 'separator' as const },
        {
          // No accelerator: the renderer owns Cmd+Shift+A (registry scope
          // 'both'); binding it here too fired the dialog twice.
          label: 'Aeronaut Pairing...',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('aeronaut:show-pairing');
          },
        },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
        // Dynamic workspace window list
        ...(() => {
          const windows = windowRegistry.getAll();
          if (windows.size < 2) return [];
          const items: Electron.MenuItemConstructorOptions[] = [
            { type: 'separator' as const },
          ];
          for (const [, state] of windows) {
            const workspace = state.workspace;
            const label = workspace ? path.basename(workspace) : 'Untitled';
            const isFocused = state.browserWindow === BrowserWindow.getFocusedWindow();
            items.push({
              label,
              type: 'checkbox' as const,
              checked: isFocused,
              click: () => {
                if (state.browserWindow.isMinimized()) state.browserWindow.restore();
                state.browserWindow.focus();
              },
            });
          }
          return items;
        })(),
      ],
    },

    // Help menu
    {
      role: 'help' as const,
      submenu: [
        {
          // No accelerator: the renderer owns Cmd+/ (registry scope 'both').
          label: 'Ask Hester...',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('command-palette:open');
          },
        },
        { type: 'separator' as const },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            const lines = SHORTCUTS.filter((sc) => !sc.documentationOnly)
              .map((sc) => `${formatChordForMenu(sc.action)}  —  ${sc.description}`);
            dialog.showMessageBox(focused!, {
              type: 'info',
              title: 'Keyboard Shortcuts',
              message: 'Lee keyboard shortcuts',
              detail: lines.join('\n'),
              buttons: ['OK'],
            });
          },
        },
        { type: 'separator' as const },
        {
          label: 'Learn More',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/Intrafocal/Lee');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Parse YAML config file using js-yaml
function parseYamlConfig(content: string): any {
  try {
    const config = yaml.load(content) as any;
    return config || {};
  } catch (error) {
    console.error('Failed to parse YAML config:', error);
    return {};
  }
}

/**
 * Strip secrets out of a workspace config before it reaches the ContextBridge
 * (and therefore GET /context, which is readable by any bearer-token holder
 * on the LAN, and by Hester's live-context WebSocket). PTYManager keeps the
 * full, unredacted config since it needs the real values to spawn tools
 * (pgcli, the daemon, etc).
 */
function redactWorkspaceConfigForContext(config: any): any {
  if (!config || typeof config !== 'object') return config;

  let redacted: any;
  try {
    redacted = JSON.parse(JSON.stringify(config));
  } catch {
    // Unclonable config (a cycle) - returning it unredacted is wrong, so
    // hand back the original and let the caller's own redaction apply.
    return config;
  }

  if (redacted.hester && typeof redacted.hester === 'object') {
    delete redacted.hester.google_api_key;
  }

  if (Array.isArray(redacted.sql?.connections)) {
    redacted.sql.connections = redacted.sql.connections.map((conn: any) => {
      if (conn && typeof conn === 'object') {
        const { password, ...rest } = conn;
        return rest;
      }
      return conn;
    });
  }

  if (redacted.tuis && typeof redacted.tuis === 'object') {
    for (const tui of Object.values(redacted.tuis) as any[]) {
      if (tui?.connection && typeof tui.connection === 'object') {
        delete tui.connection.password;
      }
    }
  }

  // The remote-machine list includes SSH usernames/hosts used to fetch other
  // machines' auth tokens - keep it out of the shared context entirely.
  delete redacted.machines;

  return redacted;
}


/**
 * Last-seen merged `hester:` config block, keyed by workspace. Used to decide
 * whether a config save actually changed anything the daemon cares about.
 */
const lastHesterConfig = new Map<string, string>();

function serializeHesterBlock(config: any): string {
  // Stable stringify: key order in YAML shouldn't count as a change.
  const normalize = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc: any, key) => {
        acc[key] = normalize(value[key]);
        return acc;
      }, {} as any);
    }
    return value;
  };
  return JSON.stringify(normalize(config?.hester ?? null));
}

export type StatusLevel = 'info' | 'success' | 'warn' | 'error';

/**
 * Surface a message in every window's status bar (C22).
 *
 * The main process has no UI of its own, so anything it only `console.error`s
 * is invisible to the user - this is the one place that turns a main-process
 * failure into something they can see.
 */
export function pushStatus(
  level: StatusLevel,
  message: string,
  opts?: { id?: string; ttl?: number; prompt?: string },
): void {
  // The status bar's vocabulary is hint/info/success/warning/error.
  const type = level === 'warn' ? 'warning' : level;
  const payload = {
    id: opts?.id ?? `main-${level}-${Date.now()}`,
    message,
    type,
    ...(opts?.ttl ? { ttl: opts.ttl } : {}),
    ...(opts?.prompt ? { prompt: opts.prompt } : {}),
  };
  const windows = windowRegistry.getAll();
  if (windows.size === 0) {
    // Nothing is listening yet (early boot / after the last window closed).
    console[level === 'error' ? 'error' : 'warn']('[Lee]', message);
    return;
  }
  for (const ws of windows.values()) {
    if (!ws.browserWindow.isDestroyed()) {
      ws.browserWindow.webContents.send('status:push', payload);
    }
  }
}

/**
 * Restart the Hester daemon when the effective `hester:` block changed on save.
 *
 * The daemon reads its settings from env at spawn time, so a config edit was
 * previously invisible until the user quit Lee.
 */
async function restartDaemonIfHesterConfigChanged(workspace: string, mergedConfig: any): Promise<void> {
  const next = serializeHesterBlock(mergedConfig);
  const previous = lastHesterConfig.get(workspace);
  lastHesterConfig.set(workspace, next);

  if (previous === undefined || previous === next) return;

  if (!ptyManager.isDaemonLeeManaged()) {
    pushStatus(
      'warn',
      'Hester config changed, but the daemon on :9000 was not started by Lee - restart it manually',
    );
    return;
  }

  pushStatus('info', 'Hester restarting: config changed');
  try {
    const result = await ptyManager.restartDaemon();
    if (!result.success) {
      pushStatus('error', `Hester restart failed: ${result.error || 'unknown error'}`);
      return;
    }
    await ptyManager.setDaemonWorkspace(workspace);
  } catch (error: any) {
    pushStatus('error', `Hester restart failed: ${error?.message || error}`);
  }
}



/**
 * A global-config save affects every workspace's merged config, so re-merge
 * for the focused window's workspace and restart the daemon if `hester:` moved.
 */
async function reloadAfterGlobalConfigSave(): Promise<void> {
  const workspace = windowRegistry.getFocused()?.workspace || windowRegistry.getAny()?.workspace;
  if (!workspace) return;
  try {
    const { config } = await loadMergedConfig(workspace);
    await restartDaemonIfHesterConfigChanged(workspace, config);
  } catch (error) {
    console.error('Failed to re-merge config after global save:', error);
  }
}


function setupIPC(): void {
  // PTY operations
  ipcMain.handle('pty:spawn', (event, command?: string, args?: string[], cwd?: string, name?: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;

    // For terminal spawns, use prewarm pool
    if (!command) {
      return ptyManager.getOrSpawnTUI(
        'terminal',
        () => ptyManager.spawn(command, args, cwd, name || 'Terminal', true, undefined, windowId),
        cwd,
        windowId
      );
    }
    return ptyManager.spawn(command, args, cwd, name, true, undefined, windowId);
  });

  ipcMain.handle('pty:spawn-tui', async (event, tuiType: string, cwd?: string, options?: any) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;

    // Check if TUI definition exists
    const def = ptyManager.getTUIDefinition(tuiType, windowId);
    if (!def) {
      throw new Error(`Unknown TUI type: ${tuiType}. Available: ${ptyManager.getAvailableTUITypes(windowId).join(', ')}`);
    }

    // Handle TUIs with connection config (SQL clients like pgcli)
    if (def.connection) {
      return ptyManager.spawnConnectionTUI(tuiType, def, cwd, windowId);
    }

    // For TUIs marked as prewarm-able, use the prewarm pool unless options are specified
    // (e.g., hester with sessionId should spawn fresh to resume that session)
    const hasSpecialOptions = options?.sessionId || options?.scene || options?.persona;

    if (def.prewarm && !hasSpecialOptions) {
      return ptyManager.getOrSpawnTUI(
        tuiType,
        () => ptyManager.spawnConfiguredTUI(tuiType, cwd, options, windowId),
        cwd,
        windowId
      );
    }

    // Spawn configured TUI
    return ptyManager.spawnConfiguredTUI(tuiType, cwd, options, windowId);
  });

  ipcMain.handle('pty:spawn-agent', async (event, provider: string, cwd?: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    const def = ptyManager.getAgentDefinition(provider, windowId);
    if (!def) {
      throw new Error(`Unknown agent provider: ${provider}`);
    }
    if (def.prewarm) {
      return ptyManager.getOrSpawnTUI(
        provider,
        () => ptyManager.spawnAgent(provider, cwd, windowId),
        cwd,
        windowId
      );
    }
    return ptyManager.spawnAgent(provider, cwd, windowId);
  });

  ipcMain.handle('pty:get-agent-providers', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    return ptyManager.getAllAgentProviders(windowId);
  });

  ipcMain.handle('pty:getAvailableTUIs', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    return ptyManager.getAvailableTUIsWithMeta(bw?.id);
  });

  ipcMain.handle('pty:write', (_event, id: number, data: string) => {
    ptyManager.write(id, data);
  });

  ipcMain.handle('pty:resize', (_event, id: number, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.handle('pty:kill', (_event, id: number) => {
    ptyManager.kill(id);
  });

  // Forward PTY events to the correct window's renderer
  ptyManager.on('data', (id: number, data: string) => {
    const windowId = ptyManager.getWindowForPty(id);
    if (windowId != null) {
      windowRegistry.get(windowId)?.browserWindow.webContents.send('pty:data', id, data);
    }
  });

  ptyManager.on('exit', (id: number, code: number) => {
    const windowId = ptyManager.getWindowForPty(id);
    if (windowId != null) {
      windowRegistry.get(windowId)?.browserWindow.webContents.send('pty:exit', id, code);
    }
  });

  ptyManager.on('state', (id: number, state: any) => {
    const windowId = ptyManager.getWindowForPty(id);
    if (windowId != null) {
      windowRegistry.get(windowId)?.browserWindow.webContents.send('pty:state', id, state);
    }
  });

  // Window operations
  ipcMain.handle('window:minimize', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    bw?.minimize();
  });

  ipcMain.handle('window:maximize', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    if (bw?.isMaximized()) {
      bw.unmaximize();
    } else {
      bw?.maximize();
    }
  });

  ipcMain.handle('window:close', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    bw?.close();
  });

  // New window IPC
  ipcMain.handle('window:new', (_event, workspace?: string) => {
    const bw = createWindow(workspace);
    return bw.id;
  });

  ipcMain.handle('window:get-id', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    return bw?.id ?? null;
  });

  // Get workspace (current working directory)
  ipcMain.handle('app:get-workspace', () => {
    const cwd = process.cwd();
    // Launched from the Dock/Finder (or as a packaged app generally), cwd is
    // "/" - not a sensible workspace to silently open. Fall back to home.
    if (cwd === '/' || cwd === path.parse(cwd).root) {
      return app.getPath('home');
    }
    return cwd;
  });

  // Dialog operations
  ipcMain.handle('dialog:open', async (event, options: { properties?: string[]; title?: string }) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(bw!, {
      properties: options.properties as any || ['openDirectory'],
      title: options.title || 'Select Folder',
    });
    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    };
  });

  /**
   * C25: a real native dialog for the renderer's confirm prompts.
   *
   * `window.confirm()` inside a BrowserWindow is a Chromium sheet with no
   * title, only OK/Cancel, and no way to express a three-way choice
   * (Save / Discard / Cancel). This returns the index of the button pressed;
   * cancelId is returned when the dialog is dismissed.
   */
  ipcMain.handle('dialog:showMessageBox', async (event, options: {
    title?: string;
    message: string;
    detail?: string;
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  }) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const buttons = Array.isArray(options.buttons) && options.buttons.length > 0
      ? options.buttons
      : ['OK', 'Cancel'];
    const result = await dialog.showMessageBox(bw!, {
      type: options.type ?? 'question',
      title: options.title ?? 'Lee',
      message: options.message,
      detail: options.detail,
      buttons,
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? buttons.length - 1,
      noLink: true,
    });
    return result.response;
  });

  // ---------- C4 / C17: filesystem watching ----------
  // One fs.watch per directory, shared by editor file watches and file-tree
  // directory watches (see fs-watcher.ts).
  ipcMain.handle('fs:watchFile', (event, filePath: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    if (bw) fsWatcher.watchFile(filePath, bw.id);
  });

  ipcMain.handle('fs:unwatchFile', (event, filePath: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    if (bw) fsWatcher.unwatchFile(filePath, bw.id);
  });

  ipcMain.handle('fs:watchDir', (event, dirPath: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    if (bw) fsWatcher.watchDir(dirPath, bw.id);
  });

  ipcMain.handle('fs:unwatchDir', (event, dirPath: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    if (bw) fsWatcher.unwatchDir(dirPath, bw.id);
  });

  // Prewarm with workspace
  ipcMain.handle('pty:prewarm', async (event, workspace: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    console.log('Prewarming with workspace:', workspace, 'windowId:', windowId);

    // Get this window's context bridge
    const winState = windowId != null ? windowRegistry.get(windowId) : undefined;
    const contextBridge = winState?.contextBridge;

    // Load workspace config (deep-merged across ~/.config/lee, ~/.lee, <ws>/.lee) and set on PTY manager
    try {
      const { config, sources } = await loadMergedConfig(workspace);
      console.log('Setting workspace config, merged from:', sources);
      if (windowId != null) {
        ptyManager.setWorkspaceConfig(workspace, config, windowId);
        // The window doing the prewarm is the one the user is looking at, so
        // its config is the one the shared daemon should run with (C12).
        ptyManager.setDaemonWindow(windowId);
      }
      applyConfigToMainProcess(config, workspace);
      contextBridge?.setWorkspaceConfig(redactWorkspaceConfigForContext(config));
      contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
      // Baseline for the "did hester: change?" comparison on later saves
      lastHesterConfig.set(workspace, serializeHesterBlock(config));

      // Even if no config was found, broadcast default TUI definitions
      if (!contextBridge?.getContext().availableTuis) {
        contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
      }
    } catch (error) {
      console.error('Failed to load workspace config:', error);
      pushStatus('error', `Couldn't load the config for ${workspace}: ${(error as Error).message}`);
    }

    // Update window workspace in registry
    if (windowId != null) {
      windowRegistry.setWorkspace(windowId, workspace);
      setupApplicationMenu(); // Rebuild menu to update workspace window list
    }

    // Bootstrap hester venv before starting TUIs/daemon that depend on it
    try {
      await ptyManager.ensureHesterVenv();
    } catch (err) {
      console.error('Hester venv bootstrap failed (non-fatal):', err);
    }

    // Prewarm commonly used TUIs (terminal, hester, claude) for instant startup
    ptyManager.prewarmAllTUIs(workspace, windowId);

    // Also start Hester daemon in background for command palette
    // (async - checks if port 9000 is available first)
    ptyManager.prewarmDaemon()
      .catch((err) => {
        console.error('Failed to start Hester daemon:', err);
      })
      .finally(() => {
        // Whether we just started it or it was already up (possibly pinned to
        // another window's workspace), tell it which workspace to serve.
        ptyManager.setDaemonWorkspace(workspace).catch(() => { /* daemon may be down */ });
      });
  });

  // Config operations - load .lee/config.yaml
  ipcMain.handle('config:load', async (event, workspace: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    const winState = windowId != null ? windowRegistry.get(windowId) : undefined;
    const contextBridge = winState?.contextBridge;

    try {
      // Deep-merge ~/.config/lee, ~/.lee, and <workspace>/.lee (workspace wins per key)
      const { config, sources } = await loadMergedConfig(workspace);
      if (sources.length === 0) {
        console.log('No config file found');
        return null;
      }
      console.log('Loaded config, merged from:', sources);
      console.log('  sql.default:', config.sql?.default);
      console.log('  sql.connections:', config.sql?.connections?.length, config.sql?.connections?.map((c: any) => c.name));
      // Also update pty-manager and context-bridge with the config
      if (windowId != null) ptyManager.setWorkspaceConfig(workspace, config, windowId);
      applyConfigToMainProcess(config, workspace);
      contextBridge?.setWorkspaceConfig(redactWorkspaceConfigForContext(config));
      contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
      return config;
    } catch (error) {
      console.error('Failed to load config:', error);
      pushStatus('error', `Couldn't load config for ${workspace}: ${(error as Error).message}`);
      return null;
    }
  });

  /**
   * C20: where each top-level config key actually came from.
   *
   * The config editor shows a merged view but used to save (and read raw
   * YAML) only against <ws>/.lee/config.yaml, so a value inherited from
   * ~/.lee/config.yaml looked workspace-local and got copied into the
   * workspace file on save - shadowing the global one. The editor now labels
   * each section with its source file and lets the Raw tab pick a file.
   */
  ipcMain.handle('config:sources', async (_event, workspace: string) => {
    try {
      const { sources, keySources, paths } = await loadConfigWithProvenance(workspace);
      return { sources, keySources, paths };
    } catch (error) {
      console.error('Failed to resolve config provenance:', error);
      return null;
    }
  });

  // Config operations - get raw YAML content
  ipcMain.handle('config:getRaw', async (_event, workspace: string) => {
    try {
      const configPath = path.join(workspace, '.lee', 'config.yaml');
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return content;
    } catch (error) {
      // ENOENT is the common case (no workspace config yet) - the editor
      // renders an empty buffer and creates the file on save.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('Failed to read raw config:', error);
        pushStatus('warn', `Couldn't read ${workspace}/.lee/config.yaml: ${(error as Error).message}`);
      }
      return null;
    }
  });

  // Config operations - save raw YAML content
  ipcMain.handle('config:saveRaw', async (event, workspace: string, content: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    const winState = windowId != null ? windowRegistry.get(windowId) : undefined;
    const contextBridge = winState?.contextBridge;

    try {
      const configDir = path.join(workspace, '.lee');
      const configPath = path.join(configDir, 'config.yaml');

      // Ensure directory exists
      await fs.promises.mkdir(configDir, { recursive: true });

      // Write the config file
      await fs.promises.writeFile(configPath, content, 'utf-8');
      console.log('Saved raw config to:', configPath);

      // Reload the deep-merged config (workspace + global) into pty-manager and context-bridge,
      // so the in-memory config isn't just the raw workspace file.
      const { config } = await loadMergedConfig(workspace);
      if (windowId != null) ptyManager.setWorkspaceConfig(workspace, config, windowId);
      contextBridge?.setWorkspaceConfig(redactWorkspaceConfigForContext(config));
      contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
      applyConfigToMainProcess(config, workspace);
      await restartDaemonIfHesterConfigChanged(workspace, config);

      return { success: true };
    } catch (error: any) {
      console.error('Failed to save raw config:', error);
      pushStatus('error', `Couldn't save ${workspace}/.lee/config.yaml: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // Config operations - save structured config as YAML
  ipcMain.handle('config:save', async (event, workspace: string, config: any) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    const winState = windowId != null ? windowRegistry.get(windowId) : undefined;
    const contextBridge = winState?.contextBridge;

    try {
      const configDir = path.join(workspace, '.lee');
      const configPath = path.join(configDir, 'config.yaml');

      // Ensure directory exists
      await fs.promises.mkdir(configDir, { recursive: true });

      // Convert config object to YAML
      const content = yaml.dump(config, {
        indent: 2,
        lineWidth: -1, // Don't wrap lines
        noRefs: true,
        sortKeys: false,
      });

      // Write the config file
      await fs.promises.writeFile(configPath, content, 'utf-8');
      console.log('Saved config to:', configPath);

      // Reload the deep-merged config (workspace + global) into pty-manager and context-bridge,
      // so the in-memory config isn't just the raw workspace object passed in.
      const { config: mergedConfig } = await loadMergedConfig(workspace);
      if (windowId != null) ptyManager.setWorkspaceConfig(workspace, mergedConfig, windowId);
      contextBridge?.setWorkspaceConfig(redactWorkspaceConfigForContext(mergedConfig));
      contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
      applyConfigToMainProcess(mergedConfig, workspace);
      await restartDaemonIfHesterConfigChanged(workspace, mergedConfig);

      return { success: true };
    } catch (error: any) {
      console.error('Failed to save config:', error);
      pushStatus('error', `Couldn't save ${workspace}/.lee/config.yaml: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // Global config operations - load ~/.lee/config.yaml
  ipcMain.handle('globalConfig:load', async () => {
    try {
      const configPath = path.join(app.getPath('home'), '.lee', 'config.yaml');
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return parseYamlConfig(content);
    } catch (error) {
      console.error('Failed to load global config:', error);
      return null;
    }
  });

  ipcMain.handle('globalConfig:getRaw', async () => {
    try {
      const configPath = path.join(app.getPath('home'), '.lee', 'config.yaml');
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return content;
    } catch (error) {
      console.error('Failed to read raw global config:', error);
      return null;
    }
  });

  ipcMain.handle('globalConfig:saveRaw', async (_event, content: string) => {
    try {
      const configDir = path.join(app.getPath('home'), '.lee');
      const configPath = path.join(configDir, 'config.yaml');
      await fs.promises.mkdir(configDir, { recursive: true });
      await fs.promises.writeFile(configPath, content, 'utf-8');
      console.log('Saved raw global config to:', configPath);
      await machineManager.loadConfig();
      await reloadAfterGlobalConfigSave();
      return { success: true };
    } catch (error: any) {
      console.error('Failed to save raw global config:', error);
      pushStatus('error', `Couldn't save ~/.lee/config.yaml: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('globalConfig:save', async (_event, config: any) => {
    try {
      const configDir = path.join(app.getPath('home'), '.lee');
      const configPath = path.join(configDir, 'config.yaml');
      await fs.promises.mkdir(configDir, { recursive: true });
      const content = yaml.dump(config, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      });
      await fs.promises.writeFile(configPath, content, 'utf-8');
      console.log('Saved global config to:', configPath);
      await machineManager.loadConfig();
      await reloadAfterGlobalConfigSave();
      return { success: true };
    } catch (error: any) {
      console.error('Failed to save global config:', error);
      pushStatus('error', `Couldn't save ~/.lee/config.yaml: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  // File system operations
  ipcMain.handle('fs:readdir', async (_event, dirPath: string): Promise<FileEntry[]> => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const result: FileEntry[] = entries
        .map(entry => ({
          name: entry.name,
          path: path.join(dirPath, entry.name),
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
        }))
        .sort((a, b) => {
          // Directories first, then alphabetically
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
      return result;
    } catch (error) {
      console.error('Failed to read directory:', error);
      // ENOENT is routine once the file tree started watching directories
      // (C17): a directory can vanish between the change event and the
      // re-read. Anything else - permissions, a broken mount - is worth
      // saying out loud, since the tree would otherwise just look empty.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        pushStatus('warn', `Couldn't read ${dirPath}: ${(error as Error).message}`, { ttl: 8 });
      }
      return [];
    }
  });

  // File read/write operations for EditorPanel
  ipcMain.handle('fs:readFile', async (_event, filePath: string): Promise<string> => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      console.error('Failed to read file:', error);
      throw error;
    }
  });

  // Hand a local file to the OS default application (e.g. a PDF to Preview).
  // Resolves to '' on success, or an error message from the shell.
  ipcMain.handle('shell:openPath', async (_event, filePath: string): Promise<string> => {
    return shell.openPath(filePath);
  });

  // Binary-safe read for viewers (3D models, etc.) — returns base64
  ipcMain.handle('fs:readFileBase64', async (_event, filePath: string): Promise<string> => {
    try {
      const buffer = await fs.promises.readFile(filePath);
      return buffer.toString('base64');
    } catch (error) {
      console.error('Failed to read file (binary):', error);
      throw error;
    }
  });

  // Read only the first maxBytes of a file — used for binary sniffing and
  // hex previews without pulling huge files into memory
  ipcMain.handle('fs:readFileChunkBase64', async (_event, filePath: string, maxBytes: number): Promise<{ base64: string; size: number }> => {
    const stat = await fs.promises.stat(filePath);
    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await fileHandle.read(buffer, 0, length, 0);
      return { base64: buffer.toString('base64'), size: stat.size };
    } finally {
      await fileHandle.close();
    }
  });

  // STEP/IGES/BREP tessellation via OpenCascade (occt-import-js).
  // Runs in the main process because embind generates invokers with
  // new Function(), which the renderer CSP rightly forbids.
  let occtInstance: Promise<any> | null = null;
  ipcMain.handle('cad:parse', async (_event, filePath: string, kind: 'step' | 'iges' | 'brep') => {
    if (!occtInstance) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const occtimportjs = require('occt-import-js');
      occtInstance = occtimportjs();
    }
    const occt = await occtInstance;
    const buffer = await fs.promises.readFile(filePath);
    const content = new Uint8Array(buffer);
    const result =
      kind === 'iges' ? occt.ReadIgesFile(content, null)
      : kind === 'brep' ? occt.ReadBrepFile(content, null)
      : occt.ReadStepFile(content, null);
    return result;
  });

  ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (error: any) {
      console.error('Failed to write file:', error);
      // The renderer surfaces the failed save itself (it needs to keep the
      // tab open), so don't double-report here.
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('fs:exists', async (_event, filePath: string): Promise<boolean> => {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      // "Doesn't exist" is the answer, not an error.
      return false;
    }
  });

  ipcMain.handle('fs:stat', async (_event, filePath: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number } | null> => {
    try {
      const stat = await fs.promises.stat(filePath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    } catch {
      // null means "no such file" - C4's change detection relies on that
      // rather than on an exception.
      return null;
    }
  });

  // Clipboard operations
  ipcMain.handle('clipboard:read-image', async () => {
    try {
      const image = clipboard.readImage();

      if (image.isEmpty()) {
        return { hasImage: false };
      }

      const size = image.getSize();
      const pngBuffer = image.toPNG();
      const base64 = pngBuffer.toString('base64');

      return {
        hasImage: true,
        base64,
        width: size.width,
        height: size.height,
        format: 'png',
      };
    } catch (error) {
      console.error('Failed to read clipboard image:', error);
      return { hasImage: false };
    }
  });

  ipcMain.handle('clipboard:save-image-to-temp', async (_event, filename?: string) => {
    try {
      const image = clipboard.readImage();

      if (image.isEmpty()) {
        return null;
      }

      // Create temp directory if it doesn't exist
      const tempDir = path.join(app.getPath('temp'), 'lee-clipboard');
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Generate filename with timestamp if not provided
      const timestamp = Date.now();
      const finalFilename = filename || `clipboard-${timestamp}.png`;
      const filePath = path.join(tempDir, finalFilename);

      // Write image to file
      const pngBuffer = image.toPNG();
      await fs.promises.writeFile(filePath, pngBuffer);

      console.log('Clipboard image saved to:', filePath);
      return filePath;
    } catch (error) {
      console.error('Failed to save clipboard image:', error);
      return null;
    }
  });

  ipcMain.handle('clipboard:write-text', async (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('clipboard:read-text', async () => {
    return clipboard.readText();
  });

  // Context bridge operations - route to correct window's ContextBridge
  ipcMain.on('context:update', (event, update: RendererContextUpdate) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const winState = bw ? windowRegistry.get(bw.id) : undefined;
    winState?.contextBridge.updateFromRenderer(update);
  });

  ipcMain.on('context:action', (event, actionType: UserActionType, target: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const winState = bw ? windowRegistry.get(bw.id) : undefined;
    winState?.contextBridge.recordAction(actionType, target);
  });

  ipcMain.handle('context:get', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const winState = bw ? windowRegistry.get(bw.id) : undefined;
    return winState?.contextBridge.getContext() ?? null;
  });

  // Editor context from new React-based EditorPanel
  ipcMain.on('context:editor', (event, ctx: {
    tabId?: number | null;
    file: string | null;
    language: string | null;
    cursor: { line: number; column: number };
    selection: string | null;
    selectedRange: { from: { line: number; column: number }; to: { line: number; column: number } } | null;
    modified: boolean;
  }) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const winState = bw ? windowRegistry.get(bw.id) : undefined;
    winState?.contextBridge.updateEditorContext(ctx);
  });

  // editor:open-result is handled directly in api-server.ts via ipcMain.on
  // so the request/response pattern can resolve there.

  // Editor commands - relay from App.tsx to EditorPanel (within same window)
  ipcMain.on('editor:open-file', (event, filePath: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    bw?.webContents.send('editor:open', filePath);
  });

  ipcMain.on('editor:save-file', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    bw?.webContents.send('editor:save');
  });

  ipcMain.on('editor:close-file', (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    bw?.webContents.send('editor:close');
  });

  // Hester daemon control - delegate to PTYManager for proper tracking
  ipcMain.handle('daemon:start', async () => {
    return ptyManager.startDaemon();
  });

  ipcMain.handle('daemon:stop', async () => {
    return ptyManager.stopDaemon();
  });

  ipcMain.handle('daemon:restart', async () => {
    return ptyManager.restartDaemon();
  });

  ipcMain.handle('daemon:status', async () => {
    const running = await ptyManager.isDaemonRunning();
    return { running };
  });

  // ============================================
  // Browser tab operations
  // ============================================

  // Register a browser tab with its webContents ID
  ipcMain.handle('browser:register', (event, tabId: number, webContentsId: number) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    return browserManager.registerBrowser(tabId, webContentsId, bw?.id);
  });

  // Unregister a browser tab
  ipcMain.handle('browser:unregister', (_event, tabId: number) => {
    browserManager.unregisterBrowser(tabId);
  });

  // Update browser state
  ipcMain.on('browser:state', (_event, webContentsId: number, update: any) => {
    browserManager.updateState(webContentsId, update);
  });

  // Request navigation (with domain approval check)
  ipcMain.handle('browser:request-navigation', async (_event, tabId: number, url: string, requireApproval: boolean) => {
    return browserManager.requestNavigation(tabId, url, requireApproval);
  });

  // Resolve navigation request (user approval)
  ipcMain.handle('browser:resolve-navigation', (_event, requestId: string, approved: boolean) => {
    browserManager.resolveNavigation(requestId, approved);
  });

  // Check if domain is approved
  ipcMain.handle('browser:is-domain-approved', (_event, domain: string) => {
    return browserManager.isDomainApproved(domain);
  });

  // Approve a domain
  ipcMain.handle('browser:approve-domain', (_event, domain: string) => {
    browserManager.approveDomain(domain);
  });

  // CDP operations for Hester automation
  ipcMain.handle('browser:screenshot', async (_event, tabId: number) => {
    return browserManager.screenshot(tabId);
  });

  ipcMain.handle('browser:dom', async (_event, tabId: number) => {
    return browserManager.getDOM(tabId);
  });

  ipcMain.handle('browser:click', async (_event, tabId: number, selector: string) => {
    return browserManager.click(tabId, selector);
  });

  ipcMain.handle('browser:type', async (_event, tabId: number, selector: string, text: string) => {
    return browserManager.type(tabId, selector, text);
  });

  ipcMain.handle('browser:fill-form', async (_event, tabId: number, fields: Array<{ selector: string; value: string }>) => {
    return browserManager.fillForm(tabId, fields);
  });

  // Get all active browsers
  ipcMain.handle('browser:get-all', () => {
    return browserManager.getAll();
  });

  // Get browser by tab ID
  ipcMain.handle('browser:get', (_event, tabId: number) => {
    return browserManager.getByTabId(tabId);
  });

  // ============================================
  // Browser snapshot capture
  // ============================================

  ipcMain.handle('browser:capture-snapshot', async (event, tabId: number, options: {
    screenshot: boolean;
    consoleLogs: string[];
    dom: boolean;
    url: string;
    title: string;
    sessionState?: object;
  }) => {
    try {
      // Get workspace from the window's context bridge
      const bw = BrowserWindow.fromWebContents(event.sender);
      const winState = bw ? windowRegistry.get(bw.id) : undefined;
      const workspacePath = winState?.contextBridge.getContext().workspace || process.cwd();
      const timestamp = Date.now();

      const trace: DebugTrace = {
        url: options.url,
        title: options.title,
        timestamp,
        consoleLogs: options.consoleLogs || [],
      };

      // Capture screenshot via CDP
      if (options.screenshot) {
        const screenshotResult = await browserManager.screenshot(tabId);
        if (screenshotResult.success && screenshotResult.data?.data) {
          trace.screenshot = screenshotResult.data.data;
        }
      }

      // Capture DOM/accessibility tree via CDP
      if (options.dom) {
        const domResult = await browserManager.getDOM(tabId);
        if (domResult.success && domResult.data) {
          trace.dom = domResult.data;
        }
      }

      // Add session state if provided (Frame sessions)
      if (options.sessionState) {
        trace.sessionState = options.sessionState;
      }

      // Save the trace
      const result = await saveDebugTrace(trace, workspacePath);

      console.log(`[Main] Snapshot captured for ${options.url}: ${result.files.length} files`);

      return {
        success: true,
        dir: result.dir,
        timestamp: result.timestamp,
        files: result.files,
      };
    } catch (error: any) {
      console.error('[Main] Failed to capture snapshot:', error);
      return {
        success: false,
        error: error.message || 'Unknown error',
      };
    }
  });

  // ============================================
  // Hester session integration
  // ============================================

  ipcMain.handle('hester:get-session', async (_event, sessionId: string, userIdOrEmail: string) => {
    try {
      // Determine if it's a UUID or email
      const isEmail = userIdOrEmail.includes('@');
      const queryParam = isEmail ? 'email' : 'user_id';

      // Call the Hester daemon API (already running on port 9000)
      // Use 127.0.0.1 instead of localhost to avoid DNS resolution issues in Electron
      const daemonUrl = `http://127.0.0.1:9000/agentgraph/scene/${encodeURIComponent(sessionId)}?${queryParam}=${encodeURIComponent(userIdOrEmail)}`;

      const response = await fetch(daemonUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          // Hester requires the shared bearer on everything but GET /health
          Authorization: `Bearer ${apiServer.getAuthToken()}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string };
        return {
          success: false,
          error: errorData.detail || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data,
      };
    } catch (error: any) {
      console.error('[Main] Failed to get hester session:', error);
      return {
        success: false,
        error: error.message || 'Failed to get session state',
      };
    }
  });

  // ============================================
  // Machine management for Spyglass/Bridge
  // ============================================

  ipcMain.handle('machines:getAll', async () => {
    return machineManager.getStates();
  });

  ipcMain.handle('machines:reload', async () => {
    await machineManager.loadConfig();
    await machineManager.pingAll();
    return machineManager.getStates();
  });

  ipcMain.handle('machines:fetchContext', async (_event, machineConfig: any) => {
    try {
      return await machineManager.fetchRemoteContext(machineConfig);
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // Shared Lee/Hester bearer token, for renderer fetches to the daemon on :9000
  ipcMain.handle('app:getApiToken', async () => {
    return apiServer.getAuthToken();
  });

  ipcMain.handle('machines:getToken', async (_event, machineName: string) => {
    try {
      return await machineManager.getTokenForMachine(machineName);
    } catch (err: any) {
      console.error('[Main] Failed to fetch machine token:', err);
      return null;
    }
  });

  // ============================================
  // Aeronaut pairing
  // ============================================

  ipcMain.handle('aeronaut:get-pairing-qr', async () => {
    // Find a non-internal IPv4 address
    const interfaces = os.networkInterfaces();
    let localIp = '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
      if (localIp !== '127.0.0.1') break;
    }

    // The daemon is always spawned on :9000 today (see pty-manager.ts), but
    // read `hester.listen_port` from the focused window's merged config so
    // this doesn't silently go stale if that becomes configurable.
    let hesterPort = 9000;
    const focusedWorkspace = windowRegistry.getFocused()?.workspace;
    if (focusedWorkspace) {
      try {
        const { config } = await loadMergedConfig(focusedWorkspace);
        const configured = Number(config?.hester?.listen_port);
        if (configured > 0) hesterPort = configured;
      } catch {
        // Fall back to the default below.
      }
    }

    const apiPort = apiServer.getPort();
    const pairingInfo = {
      name: os.hostname(),
      host: localIp,
      hostPort: apiPort,
      hesterPort,
      // Alias of hostPort for forward compatibility - keep hostPort too so
      // existing Aeronaut/Dirigible parsers that read that key keep working.
      apiPort,
      token: apiServer.getAuthToken(),
    };

    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairingInfo), {
      width: 280,
      margin: 2,
      color: { dark: '#e6edf3', light: '#0d1117' },
    });

    return { qrDataUrl, pairingInfo };
  });
}

// App lifecycle
app.whenReady().then(() => {
  // Set app name for macOS menu bar
  app.name = 'Lee';

  // Configure About panel with splash image
  const splashPath = path.join(__dirname, '..', 'renderer', 'splash.png');
  const aboutIcon = nativeImage.createFromPath(splashPath);
  app.setAboutPanelOptions({
    applicationName: 'Lee',
    applicationVersion: '0.1.0',
    copyright: 'Copyright © 2026 Intrafocal',
    iconPath: splashPath,
    ...(process.platform === 'darwin' ? {
      credits: 'A Lightweight IDE',
      version: '0.1.0',
      icon: aboutIcon,
    } : {}),
  });

  // Initialize PTY manager (global singleton)
  ptyManager = new PTYManager();

  // Initialize browser manager for embedded browser tabs
  // Uses windowRegistry to find the relevant window
  browserManager = new BrowserManager(() => {
    return windowRegistry.getFocused()?.browserWindow || windowRegistry.getAny()?.browserWindow || null;
  });

  // Forward daemon warnings (e.g. missing API key) to ALL windows as status messages
  ptyManager.on('daemon-warning', (info: { message: string; type: string }) => {
    for (const ws of windowRegistry.getAll().values()) {
      ws.browserWindow.webContents.send('status:push', {
        id: `daemon-warning-${Date.now()}`,
        message: info.message,
        type: info.type || 'warning',
      });
    }
  });

  // Forward hester-setup events to ALL windows (setup progress is global)
  ptyManager.on('hester-setup', (info: { phase: string; message: string }) => {
    for (const ws of windowRegistry.getAll().values()) {
      ws.browserWindow.webContents.send('hester-setup', info);
    }
  });

  // Initialize API server with windowRegistry for multi-window support
  apiServer = new APIServer({
    port: 9001,
    ptyManager,
    browserManager,
    windowRegistry,
  });
  // mDNS advertisement (_lee._tcp) - lets Dirigible/other on-device clients
  // discover Lee without manual host/port entry (E5). Logs through
  // ptyManager's existing lee.log writer.
  mdnsAdvertiser = new MdnsAdvertiser((level, message, details) => ptyManager.log(level, message, details));

  apiServer.start().then(() => {
    mdnsAdvertiser.start(apiServer.getPort());
  }).catch((err) => {
    // Already surfaced to the user via status:push inside start() when it's
    // EADDRINUSE; this just stops it becoming an unhandled rejection.
    console.error('[Lee] API server failed to start:', err);
  });

  // Initialize machine manager for Lee-to-Lee connectivity
  machineManager = new MachineManager();
  machineManager.init().catch(err => console.error('[Lee] MachineManager init failed:', err));

  machineManager.on('change', (states: any[]) => {
    for (const ws of windowRegistry.getAll().values()) {
      ws.browserWindow.webContents.send('machines:change', states);
    }
  });

  // F3: ~/.lee/config.yaml changed on disk and MachineManager auto-reloaded.
  machineManager.on('config-reloaded', ({ count }: { count: number }) => {
    pushStatus('info', `Machines config reloaded (${count} machine${count === 1 ? '' : 's'})`);
  });

  // Setup application menu
  setupApplicationMenu();

  // Setup IPC handlers
  setupIPC();

  // The system-wide focus chord is opt-in and comes from config, so it's
  // registered by applyConfigToMainProcess() once a workspace config loads.

  // Create first window
  createWindow();

  // macOS: Re-create window when dock icon clicked, or focus existing
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Show confirmation dialog before quitting if terminals are open
app.on('before-quit', async (event) => {
  // Skip if already confirmed
  if (quitConfirmed) return;

  // Aggregate active terminals and unsaved files across ALL windows
  const activeCount = ptyManager.getActiveTerminalCount();
  let dirtyFileCount = 0;
  for (const ws of windowRegistry.getAll().values()) {
    dirtyFileCount += ws.contextBridge.getDirtyFileCount();
  }

  if (activeCount > 0 || dirtyFileCount > 0) {
    // Prevent quit until user confirms
    event.preventDefault();

    const terminalNames = ptyManager.getActiveTerminalNames();
    const terminalList = terminalNames.length <= 5
      ? terminalNames.join(', ')
      : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

    const messageParts: string[] = [];
    if (activeCount > 0) messageParts.push(`${activeCount} active terminal${activeCount > 1 ? 's' : ''}`);
    if (dirtyFileCount > 0) messageParts.push(`${dirtyFileCount} unsaved file${dirtyFileCount > 1 ? 's' : ''}`);

    const detailParts: string[] = [];
    if (activeCount > 0) detailParts.push(`Running: ${terminalList}`);
    if (dirtyFileCount > 0) detailParts.push(`${dirtyFileCount} file${dirtyFileCount > 1 ? 's have' : ' has'} unsaved changes that will be lost.`);
    detailParts.push('Are you sure you want to quit?');

    // Use any available window as dialog parent
    const parentWindow = windowRegistry.getAny()?.browserWindow || BrowserWindow.getAllWindows()[0] || null;

    const result = await dialog.showMessageBox(parentWindow!, {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Lee?',
      message: `You have ${messageParts.join(' and ')} open`,
      detail: detailParts.join('\n\n'),
    });

    if (result.response === 0) {
      // User clicked "Quit" - set flag and quit
      quitConfirmed = true;
      app.quit();
    }
    // If user clicked "Cancel", do nothing - quit is already prevented
  }
});

// Cleanup on quit
app.on('will-quit', (event) => {
  globalShortcut.unregisterAll();
  fsWatcher.closeAll();
  mdnsAdvertiser?.stop();
  machineManager?.dispose();

  // If the daemon is ours, ask it to exit cleanly first so it shuts down the
  // managed redis it started (both used to outlive Lee). A restart takes the
  // kill-the-PTY path instead, which deliberately leaves redis running.
  if (ptyManager.isDaemonLeeManaged() && !daemonShutdownAttempted) {
    daemonShutdownAttempted = true;
    event.preventDefault();
    ptyManager
      .shutdownDaemonGracefully()
      .catch(() => { /* fall through to killAll */ })
      .finally(() => {
        ptyManager.killAll();
        apiServer.stop();
        app.quit();
      });
    return;
  }

  ptyManager.killAll();
  apiServer.stop();
});

// Handle uncaught exceptions / rejections.
//
// These used to only reach the console, which in a packaged app means
// nowhere the user will ever look. Surface them in the status bar too (C22)
// so a main-process failure is at least visible.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  pushStatus('error', `Lee hit an internal error: ${error?.message || error}`);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled promise rejection:', reason);
  pushStatus('error', `Lee hit an internal error: ${message}`);
});
