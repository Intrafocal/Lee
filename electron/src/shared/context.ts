/**
 * Lee Context Types
 *
 * Shared type definitions for the full Lee context state.
 * Used by ContextBridge (main process) and consumed by Hester (daemon).
 */

// Tab types match the Tab['type'] in App.tsx
export type TabType =
  | 'editor'
  | 'terminal'
  | 'git'
  | 'docker'
  | 'k8s'
  | 'flutter'
  | 'hester'
  | 'claude'
  | 'files'
  | 'browser'
  | 'hester-qa'
  | 'devops'
  | 'system'
  | 'sql'
  | 'library'
  | 'workstream'
  | 'spyglass'
  | 'bridge';

// Dock positions for multi-panel layout
export type DockPosition = 'center' | 'left' | 'right' | 'bottom';

// Tab state for activity tracking
export type TabState = 'active' | 'background' | 'idle';

// User action types for activity tracking
export type UserActionType =
  | 'tab_switch'
  | 'tab_create'
  | 'tab_close'
  | 'file_open'
  | 'file_save'
  | 'command'
  | 'edit'
  | 'terminal_input'
  | 'focus_change';

/**
 * Panel context - state of a dockable panel (left, right, bottom, center)
 */
export interface PanelContext {
  activeTabId: number | null;
  visible: boolean;
  size: number; // Percentage of parent container
}

/**
 * Tab context - state of a single tab
 */
export interface TabContext {
  id: number;
  type: TabType;
  label: string;
  ptyId: number | null;
  dockPosition: DockPosition;
  state: TabState;
}

/**
 * Cursor position in editor
 */
export interface CursorPosition {
  line: number;
  column: number;
}

/**
 * Editor context - state from the Lee editor TUI (via OSC sequences)
 */
export interface EditorContext {
  file: string | null;
  language: string | null;
  cursor: CursorPosition;
  selection: string | null;
  modified: boolean;
  daemonPort: number | null;
}

/**
 * User action for activity tracking
 */
export interface UserAction {
  type: UserActionType;
  target: string; // Tab ID, file path, command, etc.
  timestamp: number;
}

/**
 * Activity context - user activity tracking
 */
export interface ActivityContext {
  lastInteraction: number; // Timestamp of last user action
  idleSeconds: number; // Computed: seconds since last interaction
  recentActions: UserAction[]; // Last N actions (max 50)
  sessionDuration: number; // Seconds since workspace opened
}

/**
 * Browser context - state of a browser tab
 */
export interface BrowserContext {
  url: string;
  title: string;
  loading: boolean;
}

/**
 * Console log entry from browser
 */
export interface ConsoleLogEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  source: string;
  line: number;
  timestamp: number;
}

/**
 * AgentGraph event types for Frame session debugging
 */
export type AgentGraphEventType = 'connected' | 'streamEnd' | 'userIdDetected';

/**
 * AgentGraph event from Frame console logs
 */
export interface AgentGraphEvent {
  type: AgentGraphEventType;
  sessionId?: string;
  userId?: string;
  timestamp: number;
}

/**
 * Frame session tracking state
 */
export interface FrameSession {
  sessionId: string;
  userId: string | null;
  startTime: number;
  errorCount: number;
}

/**
 * Browser watch state for a tab
 */
export interface BrowserWatchState {
  watched: boolean;
  errorCount: number;
  consoleLogs: ConsoleLogEntry[];
  frameSession?: FrameSession;
}

/**
 * Snapshot capture options
 */
export interface SnapshotOptions {
  screenshot: boolean;
  consoleLogs: string[];
  dom: boolean;
  url: string;
  title: string;
  sessionState?: object; // For Frame sessions
}

/**
 * Snapshot result
 */
export interface SnapshotResult {
  dir: string;
  timestamp: string;
  files: string[];
}

/**
 * TUI definition for config-driven TUI spawning
 *
 * TUIs are CLI tools that run in a PTY tab. They can be configured
 * in .lee/config.yaml under the `tuis:` section.
 */
export interface TUIDefinition {
  /** Command to execute (e.g., 'lazygit', 'btop') */
  command: string;
  /** Display name for the tab */
  name: string;
  /** Default arguments to pass to the command */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** If true, use workspace directory as cwd */
  cwd_aware?: boolean;
  /** Config path to read cwd from (e.g., 'flutter.path') */
  cwd_from_config?: string;
  /** If true, prewarm this TUI for instant startup */
  prewarm?: boolean;
  /** Keyboard shortcut (e.g., 'Cmd+Shift+G') - for documentation */
  shortcut?: string;
  /** Argument name for passing path (e.g., '-p' for lazygit, '--dir' for hester). If 'cwd', sets working directory instead of arg. */
  path_arg?: string;
  /** SQL connection config (for pgcli TUIs) */
  connection?: {
    host: string;
    port?: number;
    database: string;
    user: string;
    password?: string;
    ssl?: boolean;
  };
  /** Icon for splash screen display */
  icon?: string;
}

/**
 * Workspace config from .lee/config.yaml
 */
export interface WorkspaceConfig {
  name?: string;
  environments?: Array<{
    name: string;
    type: string;
    path?: string;
    command?: string;
    hot_key?: string;
  }>;
  /** Config-driven TUI definitions */
  tuis?: Record<string, TUIDefinition>;
  [key: string]: unknown;
}

/**
 * Machine configuration for Lee-to-Lee connectivity.
 * Configured in ~/.lee/config.yaml under `machines:`.
 */
export interface MachineConfig {
  name: string;
  emoji: string;
  host: string;
  user: string;
  ssh_port?: number;   // default 22
  lee_port?: number;    // default 9001
  hester_port?: number; // default 9000
}

/**
 * Full Lee context - complete state exposed to Hester
 */
export interface LeeContext {
  // Workspace
  workspace: string;
  workspaceConfig: WorkspaceConfig | null;

  // Layout - panel states
  panels: {
    center: PanelContext;
    left: PanelContext | null;
    right: PanelContext | null;
    bottom: PanelContext | null;
  };
  focusedPanel: DockPosition;

  // All tabs
  tabs: TabContext[];

  // Editor state (from OSC)
  editor: EditorContext | null;

  // Browser tabs (by tab ID)
  browsers?: Record<number, BrowserContext>;

  // Activity
  activity: ActivityContext;

  // Timestamp of this context snapshot
  timestamp: number;
}

/**
 * Partial context update from renderer
 * Used for IPC updates that don't include computed fields
 */
export interface RendererContextUpdate {
  tabs?: TabContext[];
  activeTabId?: number | null;
  activeLeftTabId?: number | null;
  activeRightTabId?: number | null;
  activeBottomTabId?: number | null;
  focusedPanel?: DockPosition;
  workspace?: string;
  editorDaemonPort?: number | null;
}

/**
 * WebSocket message types for context stream
 */
export interface ContextUpdateMessage {
  type: 'context_update';
  data: LeeContext;
}

export interface ActionMessage {
  type: 'action';
  data: UserAction;
}

export interface CommandMessage {
  type: 'command';
  domain: 'system' | 'editor' | 'tui' | 'panel';
  action: string;
  params: Record<string, unknown>;
}

export type WebSocketMessage = ContextUpdateMessage | ActionMessage | CommandMessage;
