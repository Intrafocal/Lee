/**
 * The `window.lee` surface, as actually exposed by
 * `contextBridge.exposeInMainWorld` in `src/main/preload.ts`.
 *
 * Both sides are checked against this one interface: preload declares its
 * object as `const api: LeeAPI`, so an IPC wrapper that's renamed or given a
 * different arity fails to compile there, and the renderer reaches the same
 * type through `declare global { interface Window { lee: LeeAPI } }`
 * (see `src/renderer/lee-global.d.ts`) instead of `(window as any).lee`.
 *
 * Payload shapes that would need a large refactor to nail down stay `unknown`
 * or a loose record - the point is that method names and arities can't drift.
 */

import type { LeeContext, TUIDefinition, AgentDefinition, MachineConfig } from './context';

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  /** Modification time in epoch milliseconds. */
  mtime: number;
}

export interface ClipboardImageData {
  hasImage: boolean;
  base64?: string;
  width?: number;
  height?: number;
  format?: string;
  tempFilePath?: string;
}

export interface EditorContextUpdate {
  tabId?: number | null;
  file: string | null;
  language: string | null;
  cursor: { line: number; column: number };
  selection: string | null;
  selectedRange: { from: { line: number; column: number }; to: { line: number; column: number } } | null;
  modified: boolean;
}

export interface EditorRange {
  fromLine: number;
  fromCol: number;
  toLine: number;
  toCol: number;
}

export interface StatusMessagePayload {
  id: string;
  message: string;
  type: 'hint' | 'info' | 'success' | 'warning' | 'error';
  prompt?: string;
  ttl?: number;
}

export interface WriteResult {
  success: boolean;
  error?: string;
}

/** Options for the native message box exposed as `lee.dialog.confirm`. */
export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  /** Button labels, left to right. Defaults to ['OK', 'Cancel']. */
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
}

/** Emitted for a watched file: `mtimeMs: null` means the file was deleted. */
export interface FileChangedEvent {
  path: string;
  mtimeMs: number | null;
}

export interface DirChangedEvent {
  path: string;
}

/** Where each top-level config key came from (C20). */
export interface ConfigSources {
  /** Config files that exist, lowest to highest precedence. */
  sources: string[];
  /** Top-level key -> absolute path of the file that set the winning value. */
  keySources: Record<string, string>;
  paths: { workspace: string; global: string; xdg: string };
}

/** Unsubscribe function returned by the `on*` listeners. */
export type Unsubscribe = () => void;

export interface LeeAPI {
  pty: {
    spawn: (command?: string, args?: string[], cwd?: string, name?: string) => Promise<number>;
    spawnTUI: (tuiType: string, cwd?: string, options?: Record<string, unknown>) => Promise<number>;
    spawnAgent: (provider: string, cwd?: string) => Promise<number>;
    getAvailableTUIs: () => Promise<Array<{ key: string; name: string; icon: string; shortcut?: string }>>;
    getAgentProviders: () => Promise<Record<string, AgentDefinition>>;
    prewarm: (workspace: string) => Promise<void>;
    write: (id: number, data: string) => Promise<void>;
    resize: (id: number, cols: number, rows: number) => Promise<void>;
    kill: (id: number) => Promise<void>;
    onData: (callback: (id: number, data: string) => void) => Unsubscribe;
    onExit: (callback: (id: number, code: number) => void) => Unsubscribe;
    onState: (callback: (id: number, state: Record<string, unknown>) => void) => Unsubscribe;
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
    /** Native message box; resolves to the index of the button pressed. */
    confirm: (options: ConfirmOptions) => Promise<number>;
  };
  fs: {
    readdir: (path: string) => Promise<FileEntry[]>;
    readFile: (path: string) => Promise<string>;
    readFileBase64: (path: string) => Promise<string>;
    readFileChunkBase64: (path: string, maxBytes: number) => Promise<{ base64: string; size: number }>;
    parseCad: (path: string, kind: 'step' | 'iges' | 'brep') => Promise<any>;
    writeFile: (path: string, content: string) => Promise<WriteResult>;
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<FileStat | null>;
    watchFile: (path: string) => Promise<void>;
    unwatchFile: (path: string) => Promise<void>;
    watchDir: (path: string) => Promise<void>;
    unwatchDir: (path: string) => Promise<void>;
    onFileChanged: (callback: (event: FileChangedEvent) => void) => Unsubscribe;
    onDirChanged: (callback: (event: DirChangedEvent) => void) => Unsubscribe;
  };
  shell: {
    openPath: (path: string) => Promise<string>;
  };
  config: {
    load: (workspace: string) => Promise<Record<string, any> | null>;
    sources: (workspace: string) => Promise<ConfigSources | null>;
    getRaw: (workspace: string) => Promise<string | null>;
    saveRaw: (workspace: string, content: string) => Promise<WriteResult>;
    save: (workspace: string, config: Record<string, any>) => Promise<WriteResult>;
  };
  globalConfig: {
    load: () => Promise<Record<string, any> | null>;
    getRaw: () => Promise<string | null>;
    saveRaw: (content: string) => Promise<WriteResult>;
    save: (config: Record<string, any>) => Promise<WriteResult>;
  };
  file: {
    onNew: (callback: () => void) => void;
    onOpen: (callback: (filePath: string) => void) => void;
    onFolderOpen: (callback: (folderPath: string) => void) => void;
    onSave: (callback: () => void) => void;
    onSaveAs: (callback: (filePath: string) => void) => void;
    removeAllListeners: () => void;
  };
  menu: {
    onCommandPalette: (callback: () => void) => void;
    onEditConfig: (callback: () => void) => void;
    onEditGlobalConfig: (callback: () => void) => void;
    onSwitchWorkspace: (callback: () => void) => void;
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
    update: (update: Record<string, unknown>) => void;
    recordAction: (actionType: string, target: string) => void;
    get: () => Promise<LeeContext | null>;
    updateEditor: (ctx: EditorContextUpdate) => void;
  };
  editor: {
    open: (filePath: string) => void;
    save: () => void;
    close: () => void;
    gotoLine: (line: number, column?: number) => void;
    select: (fromLine: number, fromCol: number, toLine: number, toCol: number) => void;
    highlight: (ranges: EditorRange[], durationMs?: number) => void;
    insert: (line: number, column: number, text: string) => void;
    replace: (fromLine: number, fromCol: number, toLine: number, toCol: number, text: string) => void;
    reportOpenResult: (requestId: string, tabId: number | null) => void;
    onOpen: (callback: (filePath: string, tabId: number | undefined, requestId: string | undefined) => void) => Unsubscribe;
    onSave: (callback: (tabId: number | undefined) => void) => Unsubscribe;
    onClose: (callback: (tabId: number | undefined) => void) => Unsubscribe;
    onGotoLine: (callback: (line: number, column: number | undefined, tabId: number | undefined) => void) => Unsubscribe;
    onSelect: (callback: (fromLine: number, fromCol: number, toLine: number, toCol: number, tabId: number | undefined) => void) => Unsubscribe;
    onHighlight: (callback: (ranges: EditorRange[], durationMs: number | undefined, tabId: number | undefined) => void) => Unsubscribe;
    onInsert: (callback: (line: number, column: number, text: string, tabId: number | undefined) => void) => Unsubscribe;
    onReplace: (callback: (fromLine: number, fromCol: number, toLine: number, toCol: number, text: string, tabId: number | undefined) => void) => Unsubscribe;
    removeAllListeners: () => void;
  };
  system: {
    onFocusTab: (callback: (tabId: string) => void) => Unsubscribe;
    onCloseTab: (callback: (tabId: string) => void) => Unsubscribe;
    onCreateTab: (callback: (params: { type: string; label?: string; cwd?: string; command?: string; args?: string[] }) => void) => Unsubscribe;
    onCastActive: (callback: (info: { tabId?: number; ptyId?: number }) => void) => Unsubscribe;
    onCastInactive: (callback: (info: { tabId?: number; ptyId?: number }) => void) => Unsubscribe;
    removeAllListeners: () => void;
  };
  panel: {
    onToggle: (callback: (panel: string) => void) => Unsubscribe;
    onShow: (callback: (panel: string) => void) => Unsubscribe;
    onHide: (callback: (panel: string) => void) => Unsubscribe;
    onResize: (callback: (panel: string, size: number) => void) => Unsubscribe;
    onFocus: (callback: (panel: string) => void) => Unsubscribe;
    removeAllListeners: () => void;
  };
  status: {
    onPush: (callback: (message: StatusMessagePayload) => void) => Unsubscribe;
    onClear: (callback: (id: string) => void) => Unsubscribe;
    onClearAll: (callback: () => void) => Unsubscribe;
    removeAllListeners: () => void;
  };
  daemon: {
    start: () => Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    restart: () => Promise<{ success: boolean; error?: string }>;
  };
  browser: {
    register: (tabId: number, webContentsId: number) => Promise<unknown>;
    unregister: (tabId: number) => Promise<void>;
    updateState: (webContentsId: number, update: Record<string, unknown>) => void;
    requestNavigation: (tabId: number, url: string, requireApproval?: boolean) => Promise<{ approved: boolean; requestId?: string }>;
    resolveNavigation: (requestId: string, approved: boolean) => Promise<void>;
    isDomainApproved: (domain: string) => Promise<boolean>;
    approveDomain: (domain: string) => Promise<void>;
    screenshot: (tabId: number) => Promise<{ success: boolean; data?: any; error?: string }>;
    dom: (tabId: number) => Promise<{ success: boolean; data?: any; error?: string }>;
    click: (tabId: number, selector: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    type: (tabId: number, selector: string, text: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    fillForm: (tabId: number, fields: Array<{ selector: string; value: string }>) => Promise<{ success: boolean; data?: any; error?: string }>;
    getAll: () => Promise<any[]>;
    get: (tabId: number) => Promise<any | undefined>;
    captureSnapshot: (tabId: number, options: {
      screenshot: boolean;
      consoleLogs: string[];
      dom: boolean;
      url: string;
      title: string;
      sessionState?: object;
    }) => Promise<{ success: boolean; dir?: string; timestamp?: string; files?: string[]; error?: string }>;
    onCastResize: (callback: (tabId: number, width: number, height: number) => void) => Unsubscribe;
    onCastRestore: (callback: (tabId: number) => void) => Unsubscribe;
  };
  hester: {
    getSession: (sessionId: string, userId: string) => Promise<{ success: boolean; data?: any; error?: string }>;
  };
  /** Shared Lee/Hester API bearer token (contents of ~/.lee/api-token). */
  getApiToken: () => Promise<string | null>;
  machines: {
    getAll: () => Promise<any[]>;
    reload: () => Promise<any[]>;
    fetchContext: (machineConfig: MachineConfig) => Promise<any>;
    getToken: (machineName: string) => Promise<string | null>;
    onChange: (callback: (machines: any[]) => void) => Unsubscribe;
  };
  aeronaut: {
    getPairingQR: () => Promise<{ qrDataUrl: string; pairingInfo: any }>;
    onShowPairing: (callback: () => void) => Unsubscribe;
  };
}

/** Re-exported so components can annotate TUI lists without a deep import. */
export type { TUIDefinition, AgentDefinition };
