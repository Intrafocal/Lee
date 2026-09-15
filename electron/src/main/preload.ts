/**
 * Preload Script - Exposes safe IPC APIs to the renderer.
 *
 * This script runs in a privileged context and creates a bridge
 * between the main process and the renderer.
 *
 * The exposed object is declared as `LeeAPI` (src/shared/lee-api.ts), the same
 * interface the renderer sees through `window.lee` - so a wrapper renamed or
 * given a different arity here fails to compile rather than surfacing as an
 * undefined-is-not-a-function at runtime (C23).
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  LeeAPI,
  ConfirmOptions,
  ClipboardImageData,
  DirChangedEvent,
  EditorContextUpdate,
  EditorRange,
  FileChangedEvent,
  StatusMessagePayload,
} from '../shared/lee-api';

export type {
  LeeAPI,
  ClipboardImageData,
  EditorContextUpdate,
  EditorRange,
  FileEntry,
  OpenDialogResult,
} from '../shared/lee-api';

/** Status message shape pushed from main / Hester (kept for older imports). */
export type StatusMessage = StatusMessagePayload;

// Expose protected methods to the renderer
const api: LeeAPI = {
  pty: {
    spawn: (command?: string, args?: string[], cwd?: string, name?: string) =>
      ipcRenderer.invoke('pty:spawn', command, args, cwd, name),

    spawnTUI: (tuiType: string, cwd?: string, options?: any) =>
      ipcRenderer.invoke('pty:spawn-tui', tuiType, cwd, options),

    spawnAgent: (provider: string, cwd?: string) =>
      ipcRenderer.invoke('pty:spawn-agent', provider, cwd),

    getAvailableTUIs: () =>
      ipcRenderer.invoke('pty:getAvailableTUIs'),

    getAgentProviders: () =>
      ipcRenderer.invoke('pty:get-agent-providers'),

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

    // Native message box (C25). Resolves to the index of the button pressed,
    // so a three-way Save / Discard / Cancel prompt is one call.
    confirm: (options: ConfirmOptions) =>
      ipcRenderer.invoke('dialog:showMessageBox', options),
  },

  fs: {
    readdir: (dirPath: string) => ipcRenderer.invoke('fs:readdir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('fs:readFileBase64', filePath),
    readFileChunkBase64: (filePath: string, maxBytes: number) => ipcRenderer.invoke('fs:readFileChunkBase64', filePath, maxBytes),
    parseCad: (filePath: string, kind: 'step' | 'iges' | 'brep') => ipcRenderer.invoke('cad:parse', filePath, kind),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),

    // Filesystem watching (C4 / C17). One fs.watch per directory lives in the
    // main process; these just subscribe this window to it.
    watchFile: (filePath: string) => ipcRenderer.invoke('fs:watchFile', filePath),
    unwatchFile: (filePath: string) => ipcRenderer.invoke('fs:unwatchFile', filePath),
    watchDir: (dirPath: string) => ipcRenderer.invoke('fs:watchDir', dirPath),
    unwatchDir: (dirPath: string) => ipcRenderer.invoke('fs:unwatchDir', dirPath),

    onFileChanged: (callback: (event: FileChangedEvent) => void) => {
      const listener = (_event: unknown, payload: FileChangedEvent) => callback(payload);
      ipcRenderer.on('fs:fileChanged', listener);
      return () => ipcRenderer.removeListener('fs:fileChanged', listener);
    },

    onDirChanged: (callback: (event: DirChangedEvent) => void) => {
      const listener = (_event: unknown, payload: DirChangedEvent) => callback(payload);
      ipcRenderer.on('fs:dirChanged', listener);
      return () => ipcRenderer.removeListener('fs:dirChanged', listener);
    },
  },

  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  },

  config: {
    load: (workspace: string) => ipcRenderer.invoke('config:load', workspace),
    sources: (workspace: string) => ipcRenderer.invoke('config:sources', workspace),
    getRaw: (workspace: string) => ipcRenderer.invoke('config:getRaw', workspace),
    saveRaw: (workspace: string, content: string) => ipcRenderer.invoke('config:saveRaw', workspace, content),
    save: (workspace: string, config: any) => ipcRenderer.invoke('config:save', workspace, config),
  },

  globalConfig: {
    load: () => ipcRenderer.invoke('globalConfig:load'),
    getRaw: () => ipcRenderer.invoke('globalConfig:getRaw'),
    saveRaw: (content: string) => ipcRenderer.invoke('globalConfig:saveRaw', content),
    save: (config: any) => ipcRenderer.invoke('globalConfig:save', config),
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

  menu: {
    onCommandPalette: (callback: () => void) => {
      ipcRenderer.on('command-palette:open', () => callback());
    },
    onEditConfig: (callback: () => void) => {
      ipcRenderer.on('menu:edit-config', () => callback());
    },
    onEditGlobalConfig: (callback: () => void) => {
      ipcRenderer.on('menu:edit-global-config', () => callback());
    },
    onSwitchWorkspace: (callback: () => void) => {
      ipcRenderer.on('menu:switch-workspace', () => callback());
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('command-palette:open');
      ipcRenderer.removeAllListeners('menu:edit-config');
      ipcRenderer.removeAllListeners('menu:edit-global-config');
      ipcRenderer.removeAllListeners('menu:switch-workspace');
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
    // Commands to send to EditorPanel (renderer → main)
    open: (filePath: string) => ipcRenderer.send('editor:open-file', filePath),
    save: () => ipcRenderer.send('editor:save-file'),
    close: () => ipcRenderer.send('editor:close-file'),
    gotoLine: (line: number, column?: number) => ipcRenderer.send('editor:goto-line', { line, column }),
    select: (fromLine: number, fromCol: number, toLine: number, toCol: number) =>
      ipcRenderer.send('editor:select', { fromLine, fromCol, toLine, toCol }),
    highlight: (ranges: any[], durationMs?: number) =>
      ipcRenderer.send('editor:highlight', { ranges, durationMs }),
    insert: (line: number, column: number, text: string) =>
      ipcRenderer.send('editor:insert', { line, column, text }),
    replace: (fromLine: number, fromCol: number, toLine: number, toCol: number, text: string) =>
      ipcRenderer.send('editor:replace', { fromLine, fromCol, toLine, toCol, text }),
    reportOpenResult: (requestId: string, tabId: number | null) =>
      ipcRenderer.send('editor:open-result', { requestId, tabId }),
    // Listeners (main → renderer). Each forwards an optional tabId so the
    // receiving panel can filter for messages targeted at it.
    onOpen: (callback: (filePath: string, tabId: number | undefined, requestId: string | undefined) => void) => {
      const listener = (_event: any, payload: any) => {
        // Backwards compat: old shape sent a bare string.
        if (typeof payload === 'string') {
          callback(payload, undefined, undefined);
        } else {
          callback(payload?.file, payload?.tabId, payload?.requestId);
        }
      };
      ipcRenderer.on('editor:open', listener);
      return () => ipcRenderer.removeListener('editor:open', listener);
    },
    onSave: (callback: (tabId: number | undefined) => void) => {
      const listener = (_event: any, payload?: { tabId?: number }) => callback(payload?.tabId);
      ipcRenderer.on('editor:save', listener);
      return () => ipcRenderer.removeListener('editor:save', listener);
    },
    onClose: (callback: (tabId: number | undefined) => void) => {
      const listener = (_event: any, payload?: { tabId?: number }) => callback(payload?.tabId);
      ipcRenderer.on('editor:close', listener);
      return () => ipcRenderer.removeListener('editor:close', listener);
    },
    onGotoLine: (callback: (line: number, column: number | undefined, tabId: number | undefined) => void) => {
      const listener = (_event: any, params: { line: number; column?: number; tabId?: number }) =>
        callback(params.line, params.column, params.tabId);
      ipcRenderer.on('editor:goto-line', listener);
      return () => ipcRenderer.removeListener('editor:goto-line', listener);
    },
    onSelect: (callback: (fromLine: number, fromCol: number, toLine: number, toCol: number, tabId: number | undefined) => void) => {
      const listener = (_event: any, p: { fromLine: number; fromCol: number; toLine: number; toCol: number; tabId?: number }) =>
        callback(p.fromLine, p.fromCol, p.toLine, p.toCol, p.tabId);
      ipcRenderer.on('editor:select', listener);
      return () => ipcRenderer.removeListener('editor:select', listener);
    },
    onHighlight: (callback: (ranges: any[], durationMs: number | undefined, tabId: number | undefined) => void) => {
      const listener = (_event: any, params: { ranges: any[]; durationMs?: number; tabId?: number }) =>
        callback(params.ranges, params.durationMs, params.tabId);
      ipcRenderer.on('editor:highlight', listener);
      return () => ipcRenderer.removeListener('editor:highlight', listener);
    },
    onInsert: (callback: (line: number, column: number, text: string, tabId: number | undefined) => void) => {
      const listener = (_event: any, p: { line: number; column: number; text: string; tabId?: number }) =>
        callback(p.line, p.column, p.text, p.tabId);
      ipcRenderer.on('editor:insert', listener);
      return () => ipcRenderer.removeListener('editor:insert', listener);
    },
    onReplace: (callback: (fromLine: number, fromCol: number, toLine: number, toCol: number, text: string, tabId: number | undefined) => void) => {
      const listener = (_event: any, p: { fromLine: number; fromCol: number; toLine: number; toCol: number; text: string; tabId?: number }) =>
        callback(p.fromLine, p.fromCol, p.toLine, p.toCol, p.text, p.tabId);
      ipcRenderer.on('editor:replace', listener);
      return () => ipcRenderer.removeListener('editor:replace', listener);
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('editor:open');
      ipcRenderer.removeAllListeners('editor:save');
      ipcRenderer.removeAllListeners('editor:close');
      ipcRenderer.removeAllListeners('editor:goto-line');
      ipcRenderer.removeAllListeners('editor:select');
      ipcRenderer.removeAllListeners('editor:highlight');
      ipcRenderer.removeAllListeners('editor:insert');
      ipcRenderer.removeAllListeners('editor:replace');
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
    onCreateTab: (callback: (params: { type: string; label?: string; cwd?: string; command?: string; args?: string[] }) => void) => {
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

  getApiToken: () => ipcRenderer.invoke('app:getApiToken'),

  machines: {
    getAll: () => ipcRenderer.invoke('machines:getAll'),
    reload: () => ipcRenderer.invoke('machines:reload'),
    fetchContext: (machineConfig: any) => ipcRenderer.invoke('machines:fetchContext', machineConfig),
    getToken: (machineName: string) => ipcRenderer.invoke('machines:getToken', machineName),
    onChange: (callback: (machines: any[]) => void) => {
      const listener = (_event: any, machines: any[]) => callback(machines);
      ipcRenderer.on('machines:change', listener);
      return () => ipcRenderer.removeListener('machines:change', listener);
    },
  },

  aeronaut: {
    getPairingQR: () => ipcRenderer.invoke('aeronaut:get-pairing-qr'),
    onShowPairing: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('aeronaut:show-pairing', listener);
      return () => ipcRenderer.removeListener('aeronaut:show-pairing', listener);
    },
  },
};

contextBridge.exposeInMainWorld('lee', api);
