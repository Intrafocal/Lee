/**
 * Preload Script - Exposes safe IPC APIs to the renderer.
 *
 * This script runs in a privileged context and creates a bridge
 * between the main process and the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Dialog result type
export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

// File entry type for directory listing
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

// Clipboard image data
export interface ClipboardImageData {
  hasImage: boolean;
  base64?: string;
  width?: number;
  height?: number;
  format?: string;
  tempFilePath?: string;
}

// Editor context for Hester integration
export interface EditorContextUpdate {
  file: string | null;
  language: string | null;
  cursor: { line: number; column: number };
  selection: string | null;
  modified: boolean;
}

// Type definitions for the exposed API
export interface LeeAPI {
  pty: {
    spawn: (command?: string, args?: string[], cwd?: string, name?: string) => Promise<number>;
    spawnTUI: (tuiType: string, cwd?: string, options?: any) => Promise<number>;
    getAvailableTUIs: () => Promise<Array<{ key: string; name: string; icon: string; shortcut?: string }>>;
    prewarm: (workspace: string) => Promise<void>;
    write: (id: number, data: string) => Promise<void>;
    resize: (id: number, cols: number, rows: number) => Promise<void>;
    kill: (id: number) => Promise<void>;
    onData: (callback: (id: number, data: string) => void) => () => void;
    onExit: (callback: (id: number, code: number) => void) => () => void;
    onState: (callback: (id: number, state: any) => void) => () => void;
    removeAllListeners: () => void;
  };
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    new: (workspace?: string) => Promise<number>;
    getId: () => Promise<number | null>;
  };
  app: {
    getWorkspace: () => Promise<string>;
  };
  dialog: {
    showOpenDialog: (options: { properties?: string[]; title?: string }) => Promise<OpenDialogResult>;
  };
  fs: {
    readdir: (path: string) => Promise<FileEntry[]>;
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<{ success: boolean; error?: string }>;
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: number } | null>;
  };
  config: {
    load: (workspace: string) => Promise<any>;
    getRaw: (workspace: string) => Promise<string | null>;
    saveRaw: (workspace: string, content: string) => Promise<{ success: boolean; error?: string }>;
    save: (workspace: string, config: any) => Promise<{ success: boolean; error?: string }>;
  };
  file: {
    onNew: (callback: () => void) => void;
    onOpen: (callback: (filePath: string) => void) => void;
    onFolderOpen: (callback: (folderPath: string) => void) => void;
    onSave: (callback: () => void) => void;
    onSaveAs: (callback: (filePath: string) => void) => void;
    removeAllListeners: () => void;
  };
  clipboard: {
    readImage: () => Promise<ClipboardImageData>;
    saveImageToTemp: (filename?: string) => Promise<string | null>;
    writeText: (text: string) => Promise<void>;
    readText: () => Promise<string>;
    onImagePaste: (callback: (imageData: ClipboardImageData) => void) => void;
    removeAllListeners: () => void;
  };
  context: {
    update: (update: any) => void;
    recordAction: (actionType: string, target: string) => void;
    get: () => Promise<any>;
    updateEditor: (ctx: EditorContextUpdate) => void;
  };
  editor: {
    // Commands to send to EditorPanel
    open: (filePath: string) => void;
    save: () => void;
    close: () => void;
    // Listeners for EditorPanel to receive commands
    onOpen: (callback: (filePath: string) => void) => () => void;
    onSave: (callback: () => void) => () => void;
    onClose: (callback: () => void) => () => void;
    removeAllListeners: () => void;
  };
  system: {
    onFocusTab: (callback: (tabId: string) => void) => () => void;
    onCloseTab: (callback: (tabId: string) => void) => () => void;
    onCreateTab: (callback: (params: { type: string; label?: string; cwd?: string }) => void) => () => void;
    onCastActive: (callback: (info: { tabId?: number; ptyId?: number }) => void) => () => void;
    onCastInactive: (callback: (info: { tabId?: number; ptyId?: number }) => void) => () => void;
    removeAllListeners: () => void;
  };
  panel: {
    onToggle: (callback: (panel: string) => void) => () => void;
    onShow: (callback: (panel: string) => void) => () => void;
    onHide: (callback: (panel: string) => void) => () => void;
    onResize: (callback: (panel: string, size: number) => void) => () => void;
    onFocus: (callback: (panel: string) => void) => () => void;
    removeAllListeners: () => void;
  };
  status: {
    onPush: (callback: (message: StatusMessage) => void) => () => void;
    onClear: (callback: (id: string) => void) => () => void;
    onClearAll: (callback: () => void) => () => void;
    removeAllListeners: () => void;
  };
  daemon: {
    start: () => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    restart: () => Promise<{ success: boolean; error?: string }>;
  };
  browser: {
    // Registration
    register: (tabId: number, webContentsId: number) => Promise<any>;
    unregister: (tabId: number) => Promise<void>;
    updateState: (webContentsId: number, update: any) => void;
    // Navigation control
    requestNavigation: (tabId: number, url: string, requireApproval?: boolean) => Promise<{ approved: boolean; requestId?: string }>;
    resolveNavigation: (requestId: string, approved: boolean) => Promise<void>;
    isDomainApproved: (domain: string) => Promise<boolean>;
    approveDomain: (domain: string) => Promise<void>;
    // CDP operations
    screenshot: (tabId: number) => Promise<{ success: boolean; data?: any; error?: string }>;
    dom: (tabId: number) => Promise<{ success: boolean; data?: any; error?: string }>;
    click: (tabId: number, selector: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    type: (tabId: number, selector: string, text: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    fillForm: (tabId: number, fields: Array<{ selector: string; value: string }>) => Promise<{ success: boolean; data?: any; error?: string }>;
    // State queries
    getAll: () => Promise<any[]>;
    get: (tabId: number) => Promise<any | undefined>;
    // Snapshot capture
    captureSnapshot: (tabId: number, options: {
      screenshot: boolean;
      consoleLogs: string[];
      dom: boolean;
      url: string;
      title: string;
      sessionState?: object;
    }) => Promise<{ success: boolean; dir?: string; timestamp?: string; files?: string[]; error?: string }>;
    // Cast resize events (from Aeronaut browsercast)
    onCastResize: (callback: (tabId: number, width: number, height: number) => void) => () => void;
    onCastRestore: (callback: (tabId: number) => void) => () => void;
  };
  // Hester session integration
  hester: {
    getSession: (sessionId: string, userId: string) => Promise<{ success: boolean; data?: any; error?: string }>;
  };
}

// Status message from Hester
export interface StatusMessage {
  id: string;
  message: string;
  type: 'hint' | 'info' | 'success' | 'warning';
  prompt?: string;
  ttl?: number;
}

// Expose protected methods to the renderer
contextBridge.exposeInMainWorld('lee', {
  pty: {
    spawn: (command?: string, args?: string[], cwd?: string, name?: string) =>
      ipcRenderer.invoke('pty:spawn', command, args, cwd, name),

    spawnTUI: (tuiType: string, cwd?: string, options?: any) =>
      ipcRenderer.invoke('pty:spawn-tui', tuiType, cwd, options),

    getAvailableTUIs: () =>
      ipcRenderer.invoke('pty:getAvailableTUIs'),

    prewarm: (workspace: string) =>
      ipcRenderer.invoke('pty:prewarm', workspace),

    write: (id: number, data: string) =>
      ipcRenderer.invoke('pty:write', id, data),

    resize: (id: number, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),

    kill: (id: number) =>
      ipcRenderer.invoke('pty:kill', id),

    onData: (callback: (id: number, data: string) => void) => {
      const listener = (_event: any, id: number, data: string) => callback(id, data);
      ipcRenderer.on('pty:data', listener);
      // Return cleanup function
      return () => ipcRenderer.removeListener('pty:data', listener);
    },

    onExit: (callback: (id: number, code: number) => void) => {
      const listener = (_event: any, id: number, code: number) => callback(id, code);
      ipcRenderer.on('pty:exit', listener);
      // Return cleanup function
      return () => ipcRenderer.removeListener('pty:exit', listener);
    },

    onState: (callback: (id: number, state: any) => void) => {
      const listener = (_event: any, id: number, state: any) => callback(id, state);
      ipcRenderer.on('pty:state', listener);
      // Return cleanup function
      return () => ipcRenderer.removeListener('pty:state', listener);
    },

    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('pty:data');
      ipcRenderer.removeAllListeners('pty:exit');
      ipcRenderer.removeAllListeners('pty:state');
    },
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    new: (workspace?: string) => ipcRenderer.invoke('window:new', workspace),
    getId: () => ipcRenderer.invoke('window:get-id'),
  },

  app: {
    getWorkspace: () => ipcRenderer.invoke('app:get-workspace'),
  },

  dialog: {
    showOpenDialog: (options: { properties?: string[]; title?: string }) =>
      ipcRenderer.invoke('dialog:open', options),
  },

  fs: {
    readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
  },

  config: {
    load: (workspace: string) => ipcRenderer.invoke('config:load', workspace),
    getRaw: (workspace: string) => ipcRenderer.invoke('config:getRaw', workspace),
    saveRaw: (workspace: string, content: string) => ipcRenderer.invoke('config:saveRaw', workspace, content),
    save: (workspace: string, config: any) => ipcRenderer.invoke('config:save', workspace, config),
  },

  file: {
    onNew: (callback: () => void) => {
      ipcRenderer.on('file:new', () => callback());
    },
    onOpen: (callback: (filePath: string) => void) => {
      ipcRenderer.on('file:open', (_event, filePath) => callback(filePath));
    },
    onFolderOpen: (callback: (folderPath: string) => void) => {
      ipcRenderer.on('folder:open', (_event, folderPath) => callback(folderPath));
    },
    onSave: (callback: () => void) => {
      ipcRenderer.on('file:save', () => callback());
    },
    onSaveAs: (callback: (filePath: string) => void) => {
      ipcRenderer.on('file:save-as', (_event, filePath) => callback(filePath));
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('file:new');
      ipcRenderer.removeAllListeners('file:open');
      ipcRenderer.removeAllListeners('folder:open');
      ipcRenderer.removeAllListeners('file:save');
      ipcRenderer.removeAllListeners('file:save-as');
    },
  },

  clipboard: {
    readImage: () => ipcRenderer.invoke('clipboard:read-image'),

    saveImageToTemp: (filename?: string) =>
      ipcRenderer.invoke('clipboard:save-image-to-temp', filename),

    writeText: (text: string) =>
      ipcRenderer.invoke('clipboard:write-text', text),

    readText: () => ipcRenderer.invoke('clipboard:read-text'),

    onImagePaste: (callback: (imageData: any) => void) => {
      ipcRenderer.on('clipboard:image-paste', (_event, imageData) => callback(imageData));
    },

    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('clipboard:image-paste');
    },
  },

  context: {
    update: (update: any) => ipcRenderer.send('context:update', update),
    recordAction: (actionType: string, target: string) =>
      ipcRenderer.send('context:action', actionType, target),
    get: () => ipcRenderer.invoke('context:get'),
    updateEditor: (ctx: any) => ipcRenderer.send('context:editor', ctx),
  },

  editor: {
    // Commands to send to EditorPanel (renderer-to-renderer via main process)
    open: (filePath: string) => ipcRenderer.send('editor:open-file', filePath),
    save: () => ipcRenderer.send('editor:save-file'),
    close: () => ipcRenderer.send('editor:close-file'),
    // Listeners for EditorPanel to receive commands
    onOpen: (callback: (filePath: string) => void) => {
      const listener = (_event: any, filePath: string) => callback(filePath);
      ipcRenderer.on('editor:open', listener);
      return () => ipcRenderer.removeListener('editor:open', listener);
    },
    onSave: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('editor:save', listener);
      return () => ipcRenderer.removeListener('editor:save', listener);
    },
    onClose: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('editor:close', listener);
      return () => ipcRenderer.removeListener('editor:close', listener);
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('editor:open');
      ipcRenderer.removeAllListeners('editor:save');
      ipcRenderer.removeAllListeners('editor:close');
    },
  },

  system: {
    onFocusTab: (callback: (tabId: string) => void) => {
      const listener = (_event: any, tabId: string) => callback(tabId);
      ipcRenderer.on('system:focus-tab', listener);
      return () => ipcRenderer.removeListener('system:focus-tab', listener);
    },
    onCloseTab: (callback: (tabId: string) => void) => {
      const listener = (_event: any, tabId: string) => callback(tabId);
      ipcRenderer.on('system:close-tab', listener);
      return () => ipcRenderer.removeListener('system:close-tab', listener);
    },
    onCreateTab: (callback: (params: { type: string; label?: string; cwd?: string }) => void) => {
      const listener = (_event: any, params: any) => callback(params);
      ipcRenderer.on('system:create-tab', listener);
      return () => ipcRenderer.removeListener('system:create-tab', listener);
    },
    onCastActive: (callback: (info: { tabId?: number; ptyId?: number }) => void) => {
      const listener = (_event: any, info: any) => callback(info);
      ipcRenderer.on('cast:active', listener);
      return () => ipcRenderer.removeListener('cast:active', listener);
    },
    onCastInactive: (callback: (info: { tabId?: number; ptyId?: number }) => void) => {
      const listener = (_event: any, info: any) => callback(info);
      ipcRenderer.on('cast:inactive', listener);
      return () => ipcRenderer.removeListener('cast:inactive', listener);
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('system:focus-tab');
      ipcRenderer.removeAllListeners('system:close-tab');
      ipcRenderer.removeAllListeners('system:create-tab');
      ipcRenderer.removeAllListeners('cast:active');
      ipcRenderer.removeAllListeners('cast:inactive');
    },
  },

  panel: {
    onToggle: (callback: (panel: string) => void) => {
      const listener = (_event: any, panel: string) => callback(panel);
      ipcRenderer.on('panel:toggle', listener);
      return () => ipcRenderer.removeListener('panel:toggle', listener);
    },
    onShow: (callback: (panel: string) => void) => {
      const listener = (_event: any, panel: string) => callback(panel);
      ipcRenderer.on('panel:show', listener);
      return () => ipcRenderer.removeListener('panel:show', listener);
    },
    onHide: (callback: (panel: string) => void) => {
      const listener = (_event: any, panel: string) => callback(panel);
      ipcRenderer.on('panel:hide', listener);
      return () => ipcRenderer.removeListener('panel:hide', listener);
    },
    onResize: (callback: (panel: string, size: number) => void) => {
      const listener = (_event: any, panel: string, size: number) => callback(panel, size);
      ipcRenderer.on('panel:resize', listener);
      return () => ipcRenderer.removeListener('panel:resize', listener);
    },
    onFocus: (callback: (panel: string) => void) => {
      const listener = (_event: any, panel: string) => callback(panel);
      ipcRenderer.on('panel:focus', listener);
      return () => ipcRenderer.removeListener('panel:focus', listener);
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('panel:toggle');
      ipcRenderer.removeAllListeners('panel:show');
      ipcRenderer.removeAllListeners('panel:hide');
      ipcRenderer.removeAllListeners('panel:resize');
      ipcRenderer.removeAllListeners('panel:focus');
    },
  },

  status: {
    onPush: (callback: (message: any) => void) => {
      const listener = (_event: any, message: any) => callback(message);
      ipcRenderer.on('status:push', listener);
      return () => ipcRenderer.removeListener('status:push', listener);
    },
    onClear: (callback: (id: string) => void) => {
      const listener = (_event: any, id: string) => callback(id);
      ipcRenderer.on('status:clear', listener);
      return () => ipcRenderer.removeListener('status:clear', listener);
    },
    onClearAll: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('status:clear-all', listener);
      return () => ipcRenderer.removeListener('status:clear-all', listener);
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('status:push');
      ipcRenderer.removeAllListeners('status:clear');
      ipcRenderer.removeAllListeners('status:clear-all');
    },
  },

  daemon: {
    start: () => ipcRenderer.invoke('daemon:start'),
    stop: () => ipcRenderer.invoke('daemon:stop'),
    restart: () => ipcRenderer.invoke('daemon:restart'),
  },

  browser: {
    // Registration
    register: (tabId: number, webContentsId: number) =>
      ipcRenderer.invoke('browser:register', tabId, webContentsId),

    unregister: (tabId: number) =>
      ipcRenderer.invoke('browser:unregister', tabId),

    updateState: (webContentsId: number, update: any) =>
      ipcRenderer.send('browser:state', webContentsId, update),

    // Navigation control
    requestNavigation: (tabId: number, url: string, requireApproval: boolean = true) =>
      ipcRenderer.invoke('browser:request-navigation', tabId, url, requireApproval),

    resolveNavigation: (requestId: string, approved: boolean) =>
      ipcRenderer.invoke('browser:resolve-navigation', requestId, approved),

    isDomainApproved: (domain: string) =>
      ipcRenderer.invoke('browser:is-domain-approved', domain),

    approveDomain: (domain: string) =>
      ipcRenderer.invoke('browser:approve-domain', domain),

    // CDP operations
    screenshot: (tabId: number) =>
      ipcRenderer.invoke('browser:screenshot', tabId),

    dom: (tabId: number) =>
      ipcRenderer.invoke('browser:dom', tabId),

    click: (tabId: number, selector: string) =>
      ipcRenderer.invoke('browser:click', tabId, selector),

    type: (tabId: number, selector: string, text: string) =>
      ipcRenderer.invoke('browser:type', tabId, selector, text),

    fillForm: (tabId: number, fields: Array<{ selector: string; value: string }>) =>
      ipcRenderer.invoke('browser:fill-form', tabId, fields),

    // State queries
    getAll: () =>
      ipcRenderer.invoke('browser:get-all'),

    get: (tabId: number) =>
      ipcRenderer.invoke('browser:get', tabId),

    // Snapshot capture
    captureSnapshot: (tabId: number, options: {
      screenshot: boolean;
      consoleLogs: string[];
      dom: boolean;
      url: string;
      title: string;
      sessionState?: object;
    }) =>
      ipcRenderer.invoke('browser:capture-snapshot', tabId, options),

    // Cast resize events (from Aeronaut browsercast)
    onCastResize: (callback: (tabId: number, width: number, height: number) => void) => {
      const listener = (_event: any, tabId: number, width: number, height: number) => callback(tabId, width, height);
      ipcRenderer.on('browser:cast-resize', listener);
      return () => ipcRenderer.removeListener('browser:cast-resize', listener);
    },

    onCastRestore: (callback: (tabId: number) => void) => {
      const listener = (_event: any, tabId: number) => callback(tabId);
      ipcRenderer.on('browser:cast-restore', listener);
      return () => ipcRenderer.removeListener('browser:cast-restore', listener);
    },
  },

  hester: {
    getSession: (sessionId: string, userId: string) =>
      ipcRenderer.invoke('hester:get-session', sessionId, userId),
  },
} as LeeAPI);
