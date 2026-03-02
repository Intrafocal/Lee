/**
 * Lee Electron Main Process
 *
 * The "Meta-IDE" - a terminal multiplexer that spawns specialized CLI tools.
 */

import { app, BrowserWindow, ipcMain, globalShortcut, Menu, dialog, clipboard, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { PTYManager } from './pty-manager';
import { APIServer } from './api-server';
import { ContextBridge } from './context-bridge';
import { BrowserManager } from './browser-manager';
import { RendererContextUpdate, UserActionType } from '../shared/context';
import { saveDebugTrace, DebugTrace } from './debug-trace';

// File entry type for directory listing
interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

// Keep a global reference to prevent garbage collection
let mainWindow: BrowserWindow | null = null;
let ptyManager: PTYManager;
let apiServer: APIServer;
let contextBridge: ContextBridge;
let browserManager: BrowserManager;

// Check if we're in development mode (explicitly set or running with vite dev server)
const isDev = process.env.NODE_ENV === 'development';

// Track if quit has been confirmed to avoid showing dialog twice
let quitConfirmed = false;

// Track if reload has been confirmed to avoid showing dialog twice
let reloadConfirmed = false;

// Helper function to confirm and reload (shared by menu and keyboard shortcut)
async function confirmAndReload(forceReload: boolean): Promise<void> {
  if (!mainWindow) return;

  const activeCount = ptyManager?.getActiveTerminalCount() ?? 0;

  if (activeCount > 0) {
    const terminalNames = ptyManager.getActiveTerminalNames();
    const terminalList = terminalNames.length <= 5
      ? terminalNames.join(', ')
      : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

    const result = await dialog.showMessageBox(mainWindow, {
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
      reloadConfirmed = true;
      if (forceReload) {
        mainWindow.webContents.reloadIgnoringCache();
      } else {
        mainWindow.webContents.reload();
      }
      setTimeout(() => { reloadConfirmed = false; }, 100);
    }
  } else {
    // No active terminals, just reload
    if (forceReload) {
      mainWindow.webContents.reloadIgnoringCache();
    } else {
      mainWindow.webContents.reload();
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
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

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/public/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle window close with confirmation dialog
  mainWindow.on('close', async (event) => {
    // Skip if quit already confirmed or no active terminals
    if (quitConfirmed) return;

    const activeCount = ptyManager?.getActiveTerminalCount() ?? 0;

    if (activeCount > 0) {
      // Prevent close until user confirms
      event.preventDefault();

      const terminalNames = ptyManager.getActiveTerminalNames();
      const terminalList = terminalNames.length <= 5
        ? terminalNames.join(', ')
        : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

      const result = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Quit Lee?',
        message: `You have ${activeCount} active terminal${activeCount > 1 ? 's' : ''} open`,
        detail: `Running: ${terminalList}\n\nAre you sure you want to quit? All terminal sessions will be closed.`,
      });

      if (result.response === 0) {
        // User clicked "Quit" - set flag and close
        quitConfirmed = true;
        mainWindow?.close();
      }
      // If user clicked "Cancel", do nothing - close is already prevented
    }
  });

  // Intercept Cmd+R / Cmd+Shift+R to show reload confirmation
  // Note: The menu also handles these via confirmAndReload, but we intercept
  // keyboard input here to prevent the default browser reload behavior
  mainWindow.webContents.on('before-input-event', async (event, input) => {
    // Check for Cmd+R (macOS) or Ctrl+R (Windows/Linux)
    const isReloadKey = (input.meta || input.control) && input.key.toLowerCase() === 'r';

    if (isReloadKey && !reloadConfirmed) {
      // Prevent the default reload - menu will handle via confirmAndReload
      event.preventDefault();
      // The menu accelerator will trigger confirmAndReload
      await confirmAndReload(input.shift);
    }
  });

  // Setup global shortcuts
  setupGlobalShortcuts();
}

function setupGlobalShortcuts(): void {
  // These shortcuts work even when the app doesn't have focus
  // For in-app shortcuts, we use IPC from the renderer

  // Ctrl/Cmd+Shift+L to focus Lee from anywhere
  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
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
            mainWindow?.webContents.send('file:new');
          },
        },
        { type: 'separator' },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              // Send file path to renderer to open in editor
              mainWindow?.webContents.send('file:open', result.filePaths[0]);
            }
          },
        },
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow!, {
              properties: ['openDirectory'],
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow?.webContents.send('folder:open', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow?.webContents.send('file:save');
          },
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: async () => {
            const result = await dialog.showSaveDialog(mainWindow!, {});
            if (!result.canceled && result.filePath) {
              mainWindow?.webContents.send('file:save-as', result.filePath);
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
            await confirmAndReload(false);
          },
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: async () => {
            await confirmAndReload(true);
          },
        },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
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
          { type: 'separator' as const },
          { role: 'window' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },

    // Help menu
    {
      role: 'help' as const,
      submenu: [
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
  ipcMain.handle('pty:spawn', (_event, command?: string, args?: string[], cwd?: string, name?: string) => {
    // For terminal spawns, use prewarm pool
    if (!command) {
      return ptyManager.getOrSpawnTUI(
        'terminal',
        () => ptyManager.spawn(command, args, cwd, name || 'Terminal'),
        cwd
      );
    }
    return ptyManager.spawn(command, args, cwd, name);
  });

  ipcMain.handle('pty:spawn-tui', async (_event, tuiType: string, cwd?: string, options?: any) => {
    // Check if TUI definition exists
    const def = ptyManager.getTUIDefinition(tuiType);
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
        () => ptyManager.spawnConfiguredTUI(tuiType, cwd, options),
        cwd
      );
    }

    // Spawn configured TUI
    return ptyManager.spawnConfiguredTUI(tuiType, cwd, options);
  });

  ipcMain.handle('pty:getAvailableTUIs', () => {
    return ptyManager.getAvailableTUIsWithMeta();
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

  // Forward PTY events to renderer
  ptyManager.on('data', (id: number, data: string) => {
    mainWindow?.webContents.send('pty:data', id, data);
  });

  ptyManager.on('exit', (id: number, code: number) => {
    mainWindow?.webContents.send('pty:exit', id, code);
  });

  ptyManager.on('state', (id: number, state: any) => {
    mainWindow?.webContents.send('pty:state', id, state);
  });

  // Window operations
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });

  // Get workspace (current working directory)
  ipcMain.handle('app:get-workspace', () => {
    return process.cwd();
  });

  // Dialog operations
  ipcMain.handle('dialog:open', async (_event, options: { properties?: string[]; title?: string }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: options.properties as any || ['openDirectory'],
      title: options.title || 'Select Folder',
    });
    return {
      canceled: result.canceled,
      filePaths: result.filePaths,
    };
  });

  // Prewarm with workspace
  ipcMain.handle('pty:prewarm', async (_event, workspace: string) => {
    console.log('Prewarming with workspace:', workspace);

    // Load workspace config and set on PTY manager
    try {
      const configPaths = [
        path.join(workspace, '.lee', 'config.yaml'),
        path.join(app.getPath('home'), '.config', 'lee', 'config.yaml'),
      ];

      for (const configPath of configPaths) {
        try {
          const content = await fs.promises.readFile(configPath, 'utf-8');
          const config = parseYamlConfig(content);
          console.log('Setting workspace config from:', configPath);
          console.log('  source files:', config.source || []);
          ptyManager.setWorkspaceConfig(workspace, config);
          contextBridge.setWorkspaceConfig(config);
          break;
        } catch {
          // Try next path
        }
      }
    } catch (error) {
      console.error('Failed to load workspace config:', error);
    }

    // Bootstrap hester venv before starting TUIs/daemon that depend on it
    try {
      await ptyManager.ensureHesterVenv();
    } catch (err) {
      console.error('Hester venv bootstrap failed (non-fatal):', err);
    }

    // Prewarm commonly used TUIs (terminal, hester, claude) for instant startup
    ptyManager.prewarmAllTUIs(workspace);

    // Also start Hester daemon in background for command palette
    // (async - checks if port 9000 is available first)
    ptyManager.prewarmDaemon().catch((err) => {
      console.error('Failed to start Hester daemon:', err);
    });
  });

  // Config operations - load .lee/config.yaml
  ipcMain.handle('config:load', async (_event, workspace: string) => {
    try {
      // Try workspace-local config first, then global
      const configPaths = [
        path.join(workspace, '.lee', 'config.yaml'),
        path.join(app.getPath('home'), '.config', 'lee', 'config.yaml'),
      ];

      for (const configPath of configPaths) {
        try {
          const content = await fs.promises.readFile(configPath, 'utf-8');
          // Simple YAML parsing for environments section
          // For a full implementation, use a proper YAML parser
          const config = parseYamlConfig(content);
          console.log('Loaded config from:', configPath);
          console.log('  sql.default:', config.sql?.default);
          console.log('  sql.connections:', config.sql?.connections?.length, config.sql?.connections?.map((c: any) => c.name));
          // Also update pty-manager and context-bridge with the config
          ptyManager.setWorkspaceConfig(workspace, config);
          contextBridge.setWorkspaceConfig(config);
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
  ipcMain.handle('config:saveRaw', async (_event, workspace: string, content: string) => {
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
      ptyManager.setWorkspaceConfig(workspace, config);
      contextBridge.setWorkspaceConfig(config);

      return { success: true };
    } catch (error: any) {
      console.error('Failed to save raw config:', error);
      return { success: false, error: error.message };
    }
  });

  // Config operations - save structured config as YAML
  ipcMain.handle('config:save', async (_event, workspace: string, config: any) => {
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
      ptyManager.setWorkspaceConfig(workspace, config);
      contextBridge.setWorkspaceConfig(config);

      return { success: true };
    } catch (error: any) {
      console.error('Failed to save config:', error);
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

  // Context bridge operations
  ipcMain.on('context:update', (_event, update: RendererContextUpdate) => {
    contextBridge.updateFromRenderer(update);
  });

  ipcMain.on('context:action', (_event, actionType: UserActionType, target: string) => {
    contextBridge.recordAction(actionType, target);
  });

  ipcMain.handle('context:get', () => {
    return contextBridge.getContext();
  });

  // Editor context from new React-based EditorPanel
  ipcMain.on('context:editor', (_event, ctx: {
    file: string | null;
    language: string | null;
    cursor: { line: number; column: number };
    selection: string | null;
    modified: boolean;
  }) => {
    contextBridge.updateEditorContext(ctx);
  });

  // Editor commands - relay from App.tsx to EditorPanel
  ipcMain.on('editor:open-file', (_event, filePath: string) => {
    if (mainWindow) {
      mainWindow.webContents.send('editor:open', filePath);
    }
  });

  ipcMain.on('editor:save-file', () => {
    if (mainWindow) {
      mainWindow.webContents.send('editor:save');
    }
  });

  ipcMain.on('editor:close-file', () => {
    if (mainWindow) {
      mainWindow.webContents.send('editor:close');
    }
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
  ipcMain.handle('browser:register', (_event, tabId: number, webContentsId: number) => {
    return browserManager.registerBrowser(tabId, webContentsId);
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

  ipcMain.handle('browser:capture-snapshot', async (_event, tabId: number, options: {
    screenshot: boolean;
    consoleLogs: string[];
    dom: boolean;
    url: string;
    title: string;
    sessionState?: object;
  }) => {
    try {
      // Get workspace from context bridge (not process.cwd() which may be wrong when launched from Finder)
      const workspacePath = contextBridge.getContext().workspace || process.cwd();
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
}

// App lifecycle
app.whenReady().then(() => {
  // Set app name for macOS menu bar
  app.name = 'Lee';

  // Initialize PTY manager
  ptyManager = new PTYManager();

  // Initialize context bridge with initial workspace (cwd)
  contextBridge = new ContextBridge(process.cwd());

  // Initialize browser manager for embedded browser tabs
  browserManager = new BrowserManager(() => mainWindow);

  // Wire browser state updates to context bridge
  browserManager.on('state', (state: any) => {
    contextBridge.updateBrowserContext(state);
  });

  // Wire PTY state updates to context bridge
  ptyManager.on('state', (id: number, state: any) => {
    contextBridge.updateFromPty(id, state);
  });

  // Forward hester-setup events to renderer for UI feedback
  ptyManager.on('hester-setup', (info: { phase: string; message: string }) => {
    mainWindow?.webContents.send('hester-setup', info);
  });

  // Note: We no longer prewarm on startup - we wait for workspace selection
  // The renderer will trigger prewarm after workspace is known via the IPC handler

  // Initialize API server with context bridge and browser manager
  apiServer = new APIServer({
    port: 9001,
    ptyManager,
    contextBridge,
    browserManager,
    getMainWindow: () => mainWindow,
  });
  apiServer.start();

  // Setup application menu
  setupApplicationMenu();

  // Setup IPC handlers
  setupIPC();

  // Create window
  createWindow();

  // macOS: Re-create window when dock icon clicked
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

  const activeCount = ptyManager.getActiveTerminalCount();

  if (activeCount > 0) {
    // Prevent quit until user confirms
    event.preventDefault();

    const terminalNames = ptyManager.getActiveTerminalNames();
    const terminalList = terminalNames.length <= 5
      ? terminalNames.join(', ')
      : `${terminalNames.slice(0, 5).join(', ')} and ${terminalNames.length - 5} more`;

    const result = await dialog.showMessageBox(mainWindow!, {
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
