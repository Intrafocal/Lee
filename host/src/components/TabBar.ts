/**
 * TabBar Component - Tab management for Mosaic.
 *
 * Displays tabs for switching between terminals/editors.
 */

import * as blessed from 'neo-blessed';
import { EventEmitter } from 'events';

export interface Tab {
  id: number;
  label: string;
  type: 'lee' | 'terminal' | 'git' | 'docker' | 'k8s' | 'flutter' | 'custom';
  closable: boolean;
}

export interface TabBarOptions {
  parent: blessed.Widgets.Node;
  top?: number | string;
  left?: number | string;
  width?: number | string;
  height?: number;
}

/**
 * Tab bar for switching between terminals.
 *
 * Events:
 * - 'select': (tabId: number) - Tab selected
 * - 'close': (tabId: number) - Tab close requested
 * - 'new': (type: string) - New tab requested
 */
export class TabBar extends EventEmitter {
  private box: blessed.Widgets.BoxElement;
  private tabs: Tab[] = [];
  private activeTabId: number | null = null;
  private nextTabId = 1;

  constructor(options: TabBarOptions) {
    super();

    this.box = blessed.box({
      parent: options.parent,
      top: options.top ?? 0,
      left: options.left ?? 0,
      width: options.width ?? '100%',
      height: options.height ?? 1,
      style: {
        fg: 'white',
        bg: '#1a1a2e',
      },
      tags: true,
    });

    // Handle mouse clicks
    this.box.on('click', (mouse) => {
      this.handleClick(mouse);
    });

    // Handle keyboard
    this.box.on('keypress', (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
      if (key.ctrl && key.name === 't') {
        this.emit('new', 'terminal');
      } else if (key.ctrl && key.name === 'w') {
        if (this.activeTabId !== null) {
          const tab = this.tabs.find((t) => t.id === this.activeTabId);
          if (tab?.closable) {
            this.emit('close', this.activeTabId);
          }
        }
      } else if (key.name === 'tab' && key.shift) {
        this.selectPrevious();
      } else if (key.name === 'tab') {
        this.selectNext();
      }
    });
  }

  /** Get the blessed element */
  get element(): blessed.Widgets.BoxElement {
    return this.box;
  }

  /** Get active tab ID */
  get activeId(): number | null {
    return this.activeTabId;
  }

  /** Get all tabs */
  get allTabs(): Tab[] {
    return [...this.tabs];
  }

  /**
   * Add a new tab.
   *
   * @param label - Tab label
   * @param type - Tab type
   * @param closable - Whether tab can be closed
   * @returns Tab ID
   */
  addTab(label: string, type: Tab['type'] = 'terminal', closable = true): number {
    const id = this.nextTabId++;
    const tab: Tab = { id, label, type, closable };
    this.tabs.push(tab);

    // Auto-select if first tab
    if (this.activeTabId === null) {
      this.activeTabId = id;
    }

    this.render();
    return id;
  }

  /**
   * Remove a tab.
   *
   * @param tabId - Tab ID to remove
   */
  removeTab(tabId: number): void {
    const index = this.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    this.tabs.splice(index, 1);

    // If removing active tab, select adjacent
    if (this.activeTabId === tabId) {
      if (this.tabs.length > 0) {
        const newIndex = Math.min(index, this.tabs.length - 1);
        this.activeTabId = this.tabs[newIndex].id;
        this.emit('select', this.activeTabId);
      } else {
        this.activeTabId = null;
      }
    }

    this.render();
  }

  /**
   * Select a tab by ID.
   *
   * @param tabId - Tab ID to select
   */
  selectTab(tabId: number): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    this.activeTabId = tabId;
    this.emit('select', tabId);
    this.render();
  }

  /**
   * Select next tab.
   */
  selectNext(): void {
    if (this.tabs.length === 0) return;

    const currentIndex = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const nextIndex = (currentIndex + 1) % this.tabs.length;
    this.selectTab(this.tabs[nextIndex].id);
  }

  /**
   * Select previous tab.
   */
  selectPrevious(): void {
    if (this.tabs.length === 0) return;

    const currentIndex = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const prevIndex = currentIndex === 0 ? this.tabs.length - 1 : currentIndex - 1;
    this.selectTab(this.tabs[prevIndex].id);
  }

  /**
   * Update a tab's label.
   *
   * @param tabId - Tab ID
   * @param label - New label
   */
  setTabLabel(tabId: number, label: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.label = label;
      this.render();
    }
  }

  /**
   * Focus the tab bar.
   */
  focus(): void {
    this.box.focus();
  }

  /**
   * Handle mouse click.
   */
  private handleClick(mouse: blessed.Widgets.Events.IMouseEventArg): void {
    const x = mouse.x - (this.box.left as number);

    // Find which tab was clicked
    let pos = 0;
    for (const tab of this.tabs) {
      const tabWidth = this.getTabWidth(tab);
      if (x >= pos && x < pos + tabWidth) {
        // Check if close button clicked
        if (tab.closable && x >= pos + tabWidth - 3) {
          this.emit('close', tab.id);
        } else {
          this.selectTab(tab.id);
        }
        return;
      }
      pos += tabWidth + 1; // +1 for separator
    }

    // Check if "+" button clicked
    const plusPos = pos;
    if (x >= plusPos && x < plusPos + 3) {
      this.emit('new', 'terminal');
    }
  }

  /**
   * Get rendered width of a tab.
   */
  private getTabWidth(tab: Tab): number {
    // Icon (2) + label + close button (3 if closable)
    return 2 + tab.label.length + (tab.closable ? 3 : 0);
  }

  /**
   * Get icon for tab type.
   */
  private getTabIcon(type: Tab['type']): string {
    switch (type) {
      case 'lee':
        return '';      // Editor icon
      case 'terminal':
        return '';      // Terminal icon
      case 'git':
        return '';      // Git branch icon
      case 'docker':
        return '';      // Docker whale icon
      case 'k8s':
        return '☸';       // Kubernetes wheel
      case 'flutter':
        return '';      // Flutter/mobile icon
      case 'custom':
      default:
        return '';      // Generic window
    }
  }

  /**
   * Render the tab bar.
   */
  private render(): void {
    const parts: string[] = [];

    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeTabId;
      const icon = this.getTabIcon(tab.type);

      const style = isActive
        ? '{bold}{#16213e-bg}{#e94560-fg}'
        : '{#1a1a2e-bg}{#666-fg}';
      const endStyle = '{/}';

      const closeBtn = tab.closable ? ' {#888-fg}×{/}' : '';
      parts.push(`${style} ${icon} ${tab.label}${closeBtn} ${endStyle}`);
    }

    // Add "+" button
    parts.push('{#1a1a2e-bg}{#0f3460-fg} + {/}');

    this.box.setContent(parts.join('{#333-fg}│{/}'));
    this.box.screen.render();
  }
}
