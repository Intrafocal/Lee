/**
 * Mosaic App - Main application orchestrating all components.
 *
 * Manages tabs, terminals, Lee editor, and API communication.
 */

import * as blessed from 'neo-blessed';
import { EventEmitter } from 'events';
import { PTYManager, LeeState } from './pty/manager';
import { Terminal } from './components/Terminal';
import { TabBar, Tab } from './components/TabBar';
import { PaneContainer, SplitDirection } from './components/PaneContainer';

export interface MosaicConfig {
  workspace?: string;
  hesterPort?: number;
  apiPort?: number;
}

interface TabData {
  tab: Tab;
  terminal: Terminal;
  paneId: number;
}

/**
 * Main Mosaic application.
 *
 * Events:
 * - 'state': (state: LeeState) - Lee state update
 * - 'ready': () - App ready
 * - 'exit': () - App exiting
 */
export class MosaicApp extends EventEmitter {
  private screen: blessed.Widgets.Screen;
  private tabBar: TabBar;
  private paneContainer: PaneContainer;
  private ptyManager: PTYManager;
  private config: MosaicConfig;
  private tabData: Map<number, TabData> = new Map();
  private leeState: LeeState = {};

  constructor(config: MosaicConfig = {}) {
    super();
    this.config = {
      workspace: config.workspace || process.cwd(),
      hesterPort: config.hesterPort || 9000,
      apiPort: config.apiPort || 9001,
    };

    // Create PTY manager
    this.ptyManager = new PTYManager();

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Mosaic - Lee Editor',
      fullUnicode: true,
      autoPadding: true,
    });

    // Create tab bar
    this.tabBar = new TabBar({
      parent: this.screen,
      top: 0,
      height: 1,
    });

    // Create pane container
    this.paneContainer = new PaneContainer({
      parent: this.screen,
      top: 1,
      height: '100%-1',
    });

    this.setupEventHandlers();
    this.setupKeybindings();
  }

  /**
   * Initialize the app.
   */
  async init(): Promise<void> {
    // Create initial Lee tab
    this.createLeeTab();

    this.screen.render();
    this.emit('ready');
  }

  /**
   * Create a Lee editor tab.
   */
  createLeeTab(): number {
    const { id: paneId, element: paneElement } = this.paneContainer.createPane();

    const terminal = new Terminal({
      parent: paneElement,
      ptyManager: this.ptyManager,
      label: 'Lee Editor',
    });

    const ptyId = terminal.spawnLee(this.config.workspace);

    const tabId = this.tabBar.addTab('Lee', 'lee', false);

    this.tabData.set(tabId, {
      tab: { id: tabId, label: 'Lee', type: 'lee', closable: false },
      terminal,
      paneId,
    });

    // Listen for state updates
    terminal.on('state', (state: LeeState) => {
      this.leeState = { ...this.leeState, ...state };
      this.emit('state', this.leeState);
    });

    this.tabBar.selectTab(tabId);
    terminal.focus();

    return tabId;
  }

  /**
   * Create a terminal tab.
   *
   * @param command - Command to run (default: shell)
   * @param label - Tab label
   */
  createTerminalTab(command?: string, label?: string): number {
    const { id: paneId, element: paneElement } = this.paneContainer.createPane();

    const terminal = new Terminal({
      parent: paneElement,
      ptyManager: this.ptyManager,
      label: label || 'Terminal',
    });

    terminal.spawn(command, [], this.config.workspace);

    const tabId = this.tabBar.addTab(label || 'Terminal', 'terminal', true);

    this.tabData.set(tabId, {
      tab: { id: tabId, label: label || 'Terminal', type: 'terminal', closable: true },
      terminal,
      paneId,
    });

    // Handle terminal exit
    terminal.on('exit', () => {
      this.closeTab(tabId);
    });

    this.tabBar.selectTab(tabId);
    terminal.focus();

    return tabId;
  }

  /**
   * Create a TUI tab for external applications (lazygit, lazydocker, k9s, flx).
   *
   * @param tuiType - Type of TUI: 'git', 'docker', 'k8s', 'flutter', or 'custom'
   * @param command - Custom command (only for 'custom' type)
   * @param label - Tab label (optional for built-in TUIs)
   * @returns Tab ID, or null if TUI already open (for singletons)
   */
  createTUITab(
    tuiType: 'git' | 'docker' | 'k8s' | 'flutter' | 'custom',
    command?: string,
    label?: string
  ): number | null {
    // Check if this TUI type already has a tab open (singleton behavior for built-in TUIs)
    const existingTab = Array.from(this.tabData.values()).find(
      (d) => d.tab.type === tuiType
    );
    if (existingTab && tuiType !== 'custom') {
      // Focus existing tab instead of creating duplicate
      this.tabBar.selectTab(existingTab.tab.id);
      this.focusTab(existingTab.tab.id);
      return existingTab.tab.id;
    }

    const { id: paneId, element: paneElement } = this.paneContainer.createPane();

    const terminal = new Terminal({
      parent: paneElement,
      ptyManager: this.ptyManager,
      label: label || this.getTUILabel(tuiType),
    });

    // Spawn appropriate TUI
    let ptyId: number;
    switch (tuiType) {
      case 'git':
        ptyId = this.ptyManager.spawnLazygit(this.config.workspace);
        break;
      case 'docker':
        ptyId = this.ptyManager.spawnLazydocker();
        break;
      case 'k8s':
        ptyId = this.ptyManager.spawnK9s();
        break;
      case 'flutter':
        ptyId = this.ptyManager.spawnFlx(this.config.workspace);
        break;
      case 'custom':
        if (!command) {
          this.paneContainer.removePane(paneId);
          return null;
        }
        ptyId = this.ptyManager.spawnTUI(command, [], this.config.workspace, label);
        break;
    }

    terminal.attach(ptyId);

    const tabLabel = label || this.getTUILabel(tuiType);
    const tabId = this.tabBar.addTab(tabLabel, tuiType, true);

    this.tabData.set(tabId, {
      tab: { id: tabId, label: tabLabel, type: tuiType, closable: true },
      terminal,
      paneId,
    });

    // Handle TUI exit
    terminal.on('exit', () => {
      this.closeTab(tabId);
    });

    this.tabBar.selectTab(tabId);
    terminal.focus();

    return tabId;
  }

  /**
   * Create Git tab (lazygit).
   */
  createGitTab(): number | null {
    return this.createTUITab('git');
  }

  /**
   * Create Docker tab (lazydocker).
   */
  createDockerTab(): number | null {
    return this.createTUITab('docker');
  }

  /**
   * Create K8s tab (k9s).
   */
  createK8sTab(): number | null {
    return this.createTUITab('k8s');
  }

  /**
   * Create Flutter tab (flx).
   */
  createFlutterTab(): number | null {
    return this.createTUITab('flutter');
  }

  /**
   * Get the display label for a TUI type.
   */
  private getTUILabel(tuiType: string): string {
    const labels: Record<string, string> = {
      git: 'Git',
      docker: 'Docker',
      k8s: 'K8s',
      flutter: 'Flutter',
      custom: 'TUI',
    };
    return labels[tuiType] || 'TUI';
  }

  /**
   * Close a tab.
   *
   * @param tabId - Tab ID to close
   */
  closeTab(tabId: number): void {
    const data = this.tabData.get(tabId);
    if (!data) return;

    // Don't close Lee tab
    if (data.tab.type === 'lee') return;

    data.terminal.destroy();
    this.paneContainer.removePane(data.paneId);
    this.tabBar.removeTab(tabId);
    this.tabData.delete(tabId);

    this.screen.render();
  }

  /**
   * Focus a tab.
   *
   * @param tabId - Tab ID to focus
   */
  focusTab(tabId: number): void {
    const data = this.tabData.get(tabId);
    if (!data) return;

    this.paneContainer.focusPane(data.paneId);
    data.terminal.focus();
  }

  /**
   * Split the current pane.
   *
   * @param direction - Split direction
   */
  splitPane(direction: SplitDirection): number | null {
    const activeTabId = this.tabBar.activeId;
    if (activeTabId === null) return null;

    const activeData = this.tabData.get(activeTabId);
    if (!activeData) return null;

    const result = this.paneContainer.split(activeData.paneId, direction);
    if (!result) return null;

    // Create new terminal in split
    const terminal = new Terminal({
      parent: result.element,
      ptyManager: this.ptyManager,
      label: 'Terminal',
    });

    terminal.spawn(undefined, [], this.config.workspace);

    const tabId = this.tabBar.addTab('Terminal', 'terminal', true);

    this.tabData.set(tabId, {
      tab: { id: tabId, label: 'Terminal', type: 'terminal', closable: true },
      terminal,
      paneId: result.id,
    });

    terminal.on('exit', () => {
      this.closeTab(tabId);
    });

    this.tabBar.selectTab(tabId);
    terminal.focus();

    return tabId;
  }

  /**
   * Get the current Lee state.
   */
  getLeeState(): LeeState {
    return { ...this.leeState };
  }

  /**
   * Send a command to Lee via PTY.
   *
   * @param action - Action to perform
   * @param params - Action parameters
   */
  sendToLee(action: string, params: Record<string, unknown> = {}): void {
    // Find Lee terminal
    const leeTab = Array.from(this.tabData.values()).find(
      (d) => d.tab.type === 'lee'
    );
    if (!leeTab || leeTab.terminal.ptyId === null) return;

    // Map actions to key sequences
    const keyMap: Record<string, string> = {
      open_file: 'C-o',
      save_file: 'C-s',
      quit: 'C-q',
      new_terminal: 'C-t',
      focus_editor: 'C-e',
      focus_git: 'C-g',
      focus_devops: 'C-d',
      send_to_hester: 'C-h',
    };

    const key = keyMap[action];
    if (key) {
      this.ptyManager.sendKey(leeTab.terminal.ptyId, key);
    }

    // For open_file with path, type the path after Ctrl+O
    if (action === 'open_file' && params.path) {
      setTimeout(() => {
        if (leeTab.terminal.ptyId !== null) {
          this.ptyManager.write(leeTab.terminal.ptyId, String(params.path));
          this.ptyManager.sendKey(leeTab.terminal.ptyId, 'enter');
        }
      }, 100);
    }
  }

  /**
   * Destroy the app.
   */
  destroy(): void {
    this.ptyManager.killAll();
    this.screen.destroy();
    this.emit('exit');
  }

  /**
   * Get the blessed screen.
   */
  getScreen(): blessed.Widgets.Screen {
    return this.screen;
  }

  /**
   * Setup event handlers.
   */
  private setupEventHandlers(): void {
    // Tab selection
    this.tabBar.on('select', (tabId: number) => {
      this.focusTab(tabId);
    });

    // Tab close
    this.tabBar.on('close', (tabId: number) => {
      this.closeTab(tabId);
    });

    // New tab request
    this.tabBar.on('new', (type: string) => {
      if (type === 'terminal') {
        this.createTerminalTab();
      }
    });
  }

  /**
   * Setup keybindings.
   */
  private setupKeybindings(): void {
    // Quit
    this.screen.key(['C-q'], () => {
      this.destroy();
      process.exit(0);
    });

    // New terminal
    this.screen.key(['C-S-t'], () => {
      this.createTerminalTab();
    });

    // Close tab
    this.screen.key(['C-w'], () => {
      const activeId = this.tabBar.activeId;
      if (activeId !== null) {
        this.closeTab(activeId);
      }
    });

    // Next tab
    this.screen.key(['C-tab', 'C-pagedown'], () => {
      this.tabBar.selectNext();
    });

    // Previous tab
    this.screen.key(['C-S-tab', 'C-pageup'], () => {
      this.tabBar.selectPrevious();
    });

    // Split horizontal
    this.screen.key(['C-\\'], () => {
      this.splitPane('horizontal');
    });

    // Split vertical
    this.screen.key(['C--'], () => {
      this.splitPane('vertical');
    });

    // Focus next pane
    this.screen.key(['C-]'], () => {
      this.paneContainer.focusNext();
    });

    // Focus previous pane
    this.screen.key(['C-['], () => {
      this.paneContainer.focusPrevious();
    });

    // Git tab (lazygit)
    this.screen.key(['C-g'], () => {
      this.createGitTab();
    });

    // Docker tab (lazydocker)
    this.screen.key(['C-d'], () => {
      this.createDockerTab();
    });

    // K8s tab (k9s)
    this.screen.key(['C-k'], () => {
      this.createK8sTab();
    });

    // Flutter tab (flx)
    this.screen.key(['C-f'], () => {
      this.createFlutterTab();
    });
  }
}
