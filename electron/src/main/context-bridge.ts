/**
 * Context Bridge - Aggregates and exposes full Lee context state.
 *
 * Acts as the central hub for context awareness:
 * - Receives state from renderer (tabs, panels, focus) via IPC
 * - Receives editor state from PTY OSC sequences
 * - Tracks user actions for activity monitoring
 * - Emits 'change' events for WebSocket clients
 */

import { EventEmitter } from 'events';
import { LeeState } from './pty-manager';
import {
  LeeContext,
  PanelContext,
  TabContext,
  EditorContext,
  ActivityContext,
  UserAction,
  UserActionType,
  RendererContextUpdate,
  WorkspaceConfig,
  DockPosition,
} from '../shared/context';

// Language detection from file extension
const LANGUAGE_MAP: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  dart: 'dart',
  rs: 'rust',
  go: 'go',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  sql: 'sql',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  swift: 'swift',
  kt: 'kotlin',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

/**
 * Context Bridge manages the full Lee context state.
 *
 * Events:
 * - 'change': Emitted whenever context changes (debounced)
 */
export class ContextBridge extends EventEmitter {
  private context: LeeContext;
  private actionHistory: UserAction[] = [];
  private sessionStart: number;
  private lastInteraction: number;
  private changeDebounceTimer: NodeJS.Timeout | null = null;
  private static readonly MAX_ACTION_HISTORY = 50;
  private static readonly CHANGE_DEBOUNCE_MS = 50;

  constructor(workspace: string) {
    super();
    this.sessionStart = Date.now();
    this.lastInteraction = Date.now();
    this.context = this.createInitialContext(workspace);
  }

  /**
   * Create initial empty context.
   */
  private createInitialContext(workspace: string): LeeContext {
    return {
      workspace,
      workspaceConfig: null,
      panels: {
        center: { activeTabId: null, visible: true, size: 100 },
        left: null,
        right: null,
        bottom: null,
      },
      focusedPanel: 'center',
      tabs: [],
      editor: null,
      activity: {
        lastInteraction: Date.now(),
        idleSeconds: 0,
        recentActions: [],
        sessionDuration: 0,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Update context from renderer state via IPC.
   * Called when React state changes (tabs, panels, focus).
   */
  updateFromRenderer(update: RendererContextUpdate): void {
    // Update tabs
    if (update.tabs !== undefined) {
      this.context.tabs = update.tabs;
    }

    // Update panel active tabs
    if (update.activeTabId !== undefined) {
      this.ensurePanel('center').activeTabId = update.activeTabId;
    }
    if (update.activeLeftTabId !== undefined) {
      this.ensurePanel('left').activeTabId = update.activeLeftTabId;
    }
    if (update.activeRightTabId !== undefined) {
      this.ensurePanel('right').activeTabId = update.activeRightTabId;
    }
    if (update.activeBottomTabId !== undefined) {
      this.ensurePanel('bottom').activeTabId = update.activeBottomTabId;
    }

    // Update focused panel
    if (update.focusedPanel !== undefined) {
      this.context.focusedPanel = update.focusedPanel;
    }

    // Update workspace
    if (update.workspace !== undefined) {
      this.context.workspace = update.workspace;
    }

    // Update editor daemon port
    if (update.editorDaemonPort !== undefined) {
      if (this.context.editor) {
        this.context.editor.daemonPort = update.editorDaemonPort;
      }
    }

    this.emitChange();
  }

  /**
   * Update editor context directly from EditorPanel (React component).
   * This replaces the OSC sequence path for the new CodeMirror-based editor.
   */
  updateEditorContext(ctx: {
    file: string | null;
    language: string | null;
    cursor: { line: number; column: number };
    selection: string | null;
    modified: boolean;
  }): void {
    this.context.editor = {
      file: ctx.file,
      language: ctx.language || this.detectLanguage(ctx.file || undefined),
      cursor: ctx.cursor,
      selection: ctx.selection,
      modified: ctx.modified,
      daemonPort: null, // Not applicable for React-based editor
    };

    this.lastInteraction = Date.now();
    this.emitChange();
  }

  /**
   * Update editor state from PTY OSC sequences.
   * @deprecated Use updateEditorContext for the new React-based editor
   */
  updateFromPty(ptyId: number, state: LeeState): void {
    // Only update if we have meaningful editor state
    if (state.file || state.line || state.column || state.selection || state.modified !== undefined) {
      this.context.editor = {
        file: state.file || this.context.editor?.file || null,
        language: this.detectLanguage(state.file),
        cursor: {
          line: state.line || this.context.editor?.cursor.line || 1,
          column: state.column || this.context.editor?.cursor.column || 1,
        },
        selection: state.selection || null,
        modified: state.modified ?? this.context.editor?.modified ?? false,
        daemonPort: state.daemonPort || this.context.editor?.daemonPort || null,
      };

      this.emitChange();
    }

    // Track daemon port separately (it may come without other state)
    if (state.daemonPort && this.context.editor) {
      this.context.editor.daemonPort = state.daemonPort;
      this.emitChange();
    }
  }

  /**
   * Record a user action for activity tracking.
   */
  recordAction(type: UserActionType, target: string): void {
    const action: UserAction = {
      type,
      target,
      timestamp: Date.now(),
    };

    this.lastInteraction = Date.now();
    this.actionHistory.push(action);

    // Keep only last N actions
    if (this.actionHistory.length > ContextBridge.MAX_ACTION_HISTORY) {
      this.actionHistory = this.actionHistory.slice(-ContextBridge.MAX_ACTION_HISTORY);
    }

    this.emitChange();
  }

  /**
   * Update workspace config.
   */
  setWorkspaceConfig(config: WorkspaceConfig | null): void {
    this.context.workspaceConfig = config;
    this.emitChange();
  }

  /**
   * Get current context snapshot with computed activity.
   */
  getContext(): LeeContext {
    const now = Date.now();

    // Compute activity
    this.context.activity = {
      lastInteraction: this.lastInteraction,
      idleSeconds: (now - this.lastInteraction) / 1000,
      recentActions: this.actionHistory.slice(-10),
      sessionDuration: (now - this.sessionStart) / 1000,
    };

    // Update timestamp
    this.context.timestamp = now;

    return { ...this.context };
  }

  /**
   * Emit change event (debounced).
   */
  private emitChange(): void {
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
    }

    this.changeDebounceTimer = setTimeout(() => {
      this.changeDebounceTimer = null;
      this.emit('change', this.getContext());
    }, ContextBridge.CHANGE_DEBOUNCE_MS);
  }

  /**
   * Ensure a panel exists and return it.
   */
  private ensurePanel(position: DockPosition): PanelContext {
    if (!this.context.panels[position]) {
      this.context.panels[position] = {
        activeTabId: null,
        visible: true,
        size: position === 'center' ? 100 : 50,
      };
    }
    return this.context.panels[position]!;
  }

  /**
   * Detect language from file extension.
   */
  private detectLanguage(file: string | undefined): string | null {
    if (!file) return null;

    const ext = file.split('.').pop()?.toLowerCase();
    if (!ext) return null;

    return LANGUAGE_MAP[ext] || null;
  }

  /**
   * Reset context for a new workspace.
   */
  resetForWorkspace(workspace: string): void {
    this.sessionStart = Date.now();
    this.lastInteraction = Date.now();
    this.actionHistory = [];
    this.context = this.createInitialContext(workspace);
    this.emitChange();
  }

  /**
   * Update browser context from BrowserManager state updates.
   */
  updateBrowserContext(browserState: {
    tabId: number;
    url: string;
    title: string;
    loading: boolean;
  }): void {
    // Store browser context in a way that Hester can access
    if (!this.context.browsers) {
      this.context.browsers = {};
    }

    this.context.browsers[browserState.tabId] = {
      url: browserState.url,
      title: browserState.title,
      loading: browserState.loading,
    };

    this.emitChange();
  }
}
