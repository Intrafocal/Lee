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
import type { CopilotAPI, DeepAPI, FocusEndReason } from './copilot';
import type { CockpitAPI } from './cockpit';
import type { SendItem, SendTarget } from './tether';

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

// ---------------------------------------------------------------------------
// Send to Lee (docs/plans/2026-09-28-tether-review-voice.md §4.2, §4.3)
// ---------------------------------------------------------------------------

export const TETHER_IPC = {
  /** main to renderer: TetherSendDelivery, to the window whose workspace the send is for. */
  send: 'tether:send',
  /** send, renderer to main: TetherSendOutcome, once per delivery (main waits 10 s, then answers 504). */
  sendResult: 'tether:send-result',
  /** send, renderer to main: { open: boolean } when the Command Palette opens or closes (the `hester` focus target). */
  palette: 'tether:palette',
  /** invoke, renderer to main: TetherInboxImage -> absolute path | null. */
  inboxImage: 'tether:inbox-image',
} as const;

/** Where a send came from, for the status bar chip ("From your phone", "From the T-Deck"). */
export interface TetherSendFrom {
  /** 'aeronaut' | 'dirigible' | 'device' (another paired device) | 'lee' (loopback: the renderer or a script). */
  surface: string;
  /** The paired device's name, when it is one. */
  device_name?: string;
}

/** What main hands the renderer: already validated (§4.2), the target resolved (never 'focus'). */
export interface TetherSendDelivery {
  send_id: string;
  target: SendTarget;
  items: SendItem[];
  /** Send (true: Enter in a tab, ask in Hester) or Deliver (false). Never true for a page. */
  submit: boolean;
  from: TetherSendFrom;
  /** From a device's compose in that tab's view: no chip. */
  compose: boolean;
}

/** An image for a tab target, saved by main to ~/.lee/inbox/<send_id>-<n>.<ext> (0600) so its path can be typed. */
export interface TetherInboxImage {
  send_id: string;
  n: number;
  mime: string;
  data_b64: string;
}

/** The renderer's answer on TETHER_IPC.sendResult. `error` is a short code, e.g. 'no_target', 'tab_gone', 'upload_failed'. */
export interface TetherSendOutcome {
  send_id: string;
  ok: boolean;
  error?: string;
}

/** window.lee.tether */
export interface TetherAPI {
  onSend: (cb: (delivery: TetherSendDelivery) => void) => Unsubscribe;
  sendResult: (outcome: TetherSendOutcome) => void;
  /** Tell main whether the Command Palette is open, so it counts as the focus target. */
  setPaletteOpen: (open: boolean) => void;
  /** Save an image for a tab target; resolves to its absolute path, or null. */
  saveInboxImage: (image: TetherInboxImage) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Voice: the mic permission (§5.3). Transcription is Hester's HTTP API.
// ---------------------------------------------------------------------------

export const VOICE_IPC = {
  /** invoke: resolves to MicStatus. */
  micStatus: 'voice:mic-status',
  /** invoke: asks macOS for the mic (the TCC prompt, once); resolves to whether it's granted. */
  micRequest: 'voice:mic-request',
} as const;

/** systemPreferences.getMediaAccessStatus('microphone'); 'granted' where the OS has no such gate. */
export type MicStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

/** window.lee.voice */
export interface VoiceAPI {
  micStatus: () => Promise<MicStatus>;
  requestMic: () => Promise<boolean>;
}

export interface LeeAPI {
  pty: {
    spawn: (command?: string, args?: string[], cwd?: string, name?: string) => Promise<number>;
    spawnTUI: (tuiType: string, cwd?: string, options?: Record<string, unknown>) => Promise<number>;
    spawnAgent: (provider: string, cwd?: string, args?: string[]) => Promise<number>;
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
    /**
     * Deep D1 §2.4: quit Lee, first ending any Deep session with `reason`
     * (default 'quit'). The ending ritual has normally sent deepEnd already.
     */
    quit: (reason?: FocusEndReason) => void;
    /**
     * Cockpit design §7.2: the user's first name for Home's greeting
     * (app.user_name, else the macOS full name's first word), or null.
     */
    userName: () => Promise<string | null>;
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
  /** Copilot v0/v1 (docs/plans/2026-09-25-copilot-v0-v1-contracts.md). */
  copilot: CopilotAPI;
  /** Copilot v2 Cockpit (docs/plans/2026-09-25-copilot-v2-contracts.md). */
  cockpit: CockpitAPI;
  /** Deep D1 (docs/plans/2026-09-26-deep-d1-contracts.md §6). */
  deep: DeepAPI;
  /** Send to Lee (docs/plans/2026-09-28-tether-review-voice.md §4.2). */
  tether: TetherAPI;
  /** Voice: the mic permission (§5.3). */
  voice: VoiceAPI;
}

/** Re-exported so components can annotate TUI lists without a deep import. */
export type { TUIDefinition, AgentDefinition };
