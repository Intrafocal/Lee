/**
 * Lee Electron Main Process
 *
 * The "Meta-IDE" - a terminal multiplexer that spawns specialized CLI tools.
 */

import { app, BrowserWindow, ipcMain, globalShortcut, Menu, dialog, clipboard, nativeImage, session } from 'electron';
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

// File entry type for directory listing
interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

import { windowRegistry } from './window-registry';

// Global singletons (shared across all windows)
let ptyManager: PTYManager;
let apiServer: APIServer;
let browserManager: BrowserManager;
let machineManager: MachineManager;

// Check if we're in development mode (explicitly set or running with vite dev server)
const isDev = process.env.NODE_ENV === 'development';

// Track if quit has been confirmed to avoid showing dialog twice
let quitConfirmed = false;

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
      if (forceReload) {
        bw.webContents.reloadIgnoringCache();
      } else {
        bw.webContents.reload();
      }
      setTimeout(() => { reloadConfirmedWindows.delete(bw.id); }, 100);
    }
  } else {
    // No active terminals, just reload
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
  const bw = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Lee',
    titleBarStyle: 'hiddenInset', // macOS native title bar
    trafficLightPosition: { x: 15, y: 10 },
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
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; " +
          "font-src 'self' data:; " +
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
  });

  bw.on('closed', () => {
    // Remove event listeners
    ptyManager.removeListener('state', onPtyState);
    browserManager.removeListener('state', onBrowserState);

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

  // Intercept Cmd+R / Cmd+Shift+R to show reload confirmation
  bw.webContents.on('before-input-event', async (event, input) => {
    const isReloadKey = (input.meta || input.control) && input.key.toLowerCase() === 'r';

    if (isReloadKey && !reloadConfirmedWindows.has(bw.id)) {
      event.preventDefault();
      await confirmAndReload(bw, input.shift);
    }
  });

  return bw;
}

function setupGlobalShortcuts(): void {
  // These shortcuts work even when the app doesn't have focus
  // For in-app shortcuts, we use IPC from the renderer

  // Ctrl/Cmd+Shift+L to focus Lee from anywhere
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    const ws = windowRegistry.getFocused() || windowRegistry.getAny();
    if (ws) {
      if (ws.browserWindow.isMinimized()) ws.browserWindow.restore();
      ws.browserWindow.focus();
    }
  });
}

function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          label: 'Edit Workspace Config...',
          accelerator: 'CmdOrCtrl+,' as string,
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
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('file:new');
          },
        },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            createWindow();
          },
        },
        { type: 'separator' },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
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
          accelerator: 'CmdOrCtrl+Shift+O',
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
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('file:save');
          },
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
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
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
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
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: async () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) await confirmAndReload(focused, false);
          },
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
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
          label: 'Aeronaut Pairing...',
          accelerator: 'CmdOrCtrl+Shift+A',
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
          label: 'Ask Hester...',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('command-palette:open');
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
      throw new Error(`Unknown TUI type: ${tuiType}. Available: ${ptyManager.getAvailableTUITypes().join(', ')}`);
    }

    // Handle TUIs with connection config (SQL clients like pgcli)
    if (def.connection) {
      return ptyManager.spawnConnectionTUI(tuiType, def, cwd);
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
    return process.cwd();
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

  // Prewarm with workspace
  ipcMain.handle('pty:prewarm', async (event, workspace: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    console.log('Prewarming with workspace:', workspace, 'windowId:', windowId);

    // Get this window's context bridge
    const winState = windowId != null ? windowRegistry.get(windowId) : undefined;
    const contextBridge = winState?.contextBridge;

    // Load workspace config and set on PTY manager
    try {
      const configPaths = [
        path.join(workspace, '.lee', 'config.yaml'),
        path.join(app.getPath('home'), '.lee', 'config.yaml'),
        path.join(app.getPath('home'), '.config', 'lee', 'config.yaml'),
      ];

      for (const configPath of configPaths) {
        try {
          const content = await fs.promises.readFile(configPath, 'utf-8');
          const config = parseYamlConfig(content);
          console.log('Setting workspace config from:', configPath);
          console.log('  source files:', config.source || []);
          ptyManager.setWorkspaceConfig(workspace, config, windowId);
          contextBridge?.setWorkspaceConfig(config);
          contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
          break;
        } catch {
          // Try next path
        }
      }

      // Even if no config was found, broadcast default TUI definitions
      if (!contextBridge?.getContext().availableTuis) {
        contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
      }
    } catch (error) {
      console.error('Failed to load workspace config:', error);
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
    ptyManager.prewarmDaemon().catch((err) => {
      console.error('Failed to start Hester daemon:', err);
    });
  });

  // Config operations - load .lee/config.yaml
  ipcMain.handle('config:load', async (event, workspace: string) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const windowId = bw?.id;
    const winState = windowId != null ? windowRegistry.get(windowId) : undefined;
    const contextBridge = winState?.contextBridge;

    try {
      // Try workspace-local config first, then global
      const configPaths = [
        path.join(workspace, '.lee', 'config.yaml'),
        path.join(app.getPath('home'), '.lee', 'config.yaml'),
        path.join(app.getPath('home'), '.config', 'lee', 'config.yaml'),
      ];

      for (const configPath of configPaths) {
        try {
          const content = await fs.promises.readFile(configPath, 'utf-8');
          const config = parseYamlConfig(content);
          console.log('Loaded config from:', configPath);
          console.log('  sql.default:', config.sql?.default);
          console.log('  sql.connections:', config.sql?.connections?.length, config.sql?.connections?.map((c: any) => c.name));
          // Also update pty-manager and context-bridge with the config
          ptyManager.setWorkspaceConfig(workspace, config, windowId);
          contextBridge?.setWorkspaceConfig(config);
          contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));
          return config;
        } catch {
          // Try next path
        }
      }

      console.log('No config file found');
      return null;
    } catch (error) {
      console.error('Failed to load config:', error);
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
      console.error('Failed to read raw config:', error);
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

      // Reload config into pty-manager and context-bridge
      const config = parseYamlConfig(content);
      ptyManager.setWorkspaceConfig(workspace, config, windowId);
      contextBridge?.setWorkspaceConfig(config);
      contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));

      return { success: true };
    } catch (error: any) {
      console.error('Failed to save raw config:', error);
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

      // Reload config into pty-manager and context-bridge
      ptyManager.setWorkspaceConfig(workspace, config, windowId);
      contextBridge?.setWorkspaceConfig(config);
      contextBridge?.setAvailableTuis(ptyManager.getAllTUIDefinitions(windowId));

      return { success: true };
    } catch (error: any) {
      console.error('Failed to save config:', error);
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
      return { success: true };
    } catch (error: any) {
      console.error('Failed to save raw global config:', error);
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
      return { success: true };
    } catch (error: any) {
      console.error('Failed to save global config:', error);
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

  ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (error: any) {
      console.error('Failed to write file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('fs:exists', async (_event, filePath: string): Promise<boolean> => {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
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
    file: string | null;
    language: string | null;
    cursor: { line: number; column: number };
    selection: string | null;
    modified: boolean;
  }) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    const winState = bw ? windowRegistry.get(bw.id) : undefined;
    winState?.contextBridge.updateEditorContext(ctx);
  });

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
        headers: { 'Accept': 'application/json' },
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

    const pairingInfo = {
      name: os.hostname(),
      host: localIp,
      hostPort: 9001,
      hesterPort: 9000,
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
  apiServer.start();

  // Initialize machine manager for Lee-to-Lee connectivity
  machineManager = new MachineManager();
  machineManager.init().catch(err => console.error('[Lee] MachineManager init failed:', err));

  machineManager.on('change', (states: any[]) => {
    for (const ws of windowRegistry.getAll().values()) {
      ws.browserWindow.webContents.send('machines:change', states);
    }
  });

  // Setup application menu
  setupApplicationMenu();

  // Setup IPC handlers
  setupIPC();

  // Setup global shortcuts (once, not per-window)
  setupGlobalShortcuts();

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

  // Aggregate active terminals across ALL windows
  const activeCount = ptyManager.getActiveTerminalCount();

  if (activeCount > 0) {
    // Prevent quit until user confirms
    event.preventDefault();

    const terminalNames = ptyManager.getActiveTerminalNames();
    const terminalList = terminalNames.length <= 5
      ? terminalNames.join(', ')
      : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

    // Use any available window as dialog parent
    const parentWindow = windowRegistry.getAny()?.browserWindow || BrowserWindow.getAllWindows()[0] || null;

    const result = await dialog.showMessageBox(parentWindow!, {
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit Lee?',
      message: `You have ${activeCount} active terminal${activeCount > 1 ? 's' : ''} open`,
      detail: `Running: ${terminalList}\n\nAre you sure you want to quit? All terminal sessions will be closed.`,
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
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ptyManager.killAll();
  apiServer.stop();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
