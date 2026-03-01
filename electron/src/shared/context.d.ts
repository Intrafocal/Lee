/**
 * Lee Context Types
 *
 * Shared type definitions for the full Lee context state.
 * Used by ContextBridge (main process) and consumed by Hester (daemon).
 */
export type TabType = 'editor' | 'terminal' | 'git' | 'docker' | 'k8s' | 'flutter' | 'hester' | 'claude' | 'files' | 'hester-qa' | 'devops' | 'system';
export type DockPosition = 'center' | 'left' | 'right' | 'bottom';
export type TabState = 'active' | 'background' | 'idle';
export type UserActionType = 'tab_switch' | 'tab_create' | 'tab_close' | 'file_open' | 'file_save' | 'command' | 'edit' | 'terminal_input' | 'focus_change';
/**
 * Panel context - state of a dockable panel (left, right, bottom, center)
 */
export interface PanelContext {
    activeTabId: number | null;
    visible: boolean;
    size: number;
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
    target: string;
    timestamp: number;
}
/**
 * Activity context - user activity tracking
 */
export interface ActivityContext {
    lastInteraction: number;
    idleSeconds: number;
    recentActions: UserAction[];
    sessionDuration: number;
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
    [key: string]: unknown;
}
/**
 * Full Lee context - complete state exposed to Hester
 */
export interface LeeContext {
    workspace: string;
    workspaceConfig: WorkspaceConfig | null;
    panels: {
        center: PanelContext;
        left: PanelContext | null;
        right: PanelContext | null;
        bottom: PanelContext | null;
    };
    focusedPanel: DockPosition;
    tabs: TabContext[];
    editor: EditorContext | null;
    activity: ActivityContext;
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
//# sourceMappingURL=context.d.ts.map