/**
 * PaneContainer Component - Split pane layout management.
 *
 * Supports horizontal and vertical splits with resizable panes.
 */

import * as blessed from 'neo-blessed';
import { EventEmitter } from 'events';

export type SplitDirection = 'horizontal' | 'vertical';

export interface Pane {
  id: number;
  element: blessed.Widgets.BoxElement;
  size: number; // Percentage (0-100)
}

export interface PaneContainerOptions {
  parent: blessed.Widgets.Node;
  top?: number | string;
  left?: number | string;
  width?: number | string;
  height?: number | string;
}

/**
 * Container for managing split panes.
 *
 * Events:
 * - 'split': (paneId: number, direction: SplitDirection) - Pane split
 * - 'close': (paneId: number) - Pane closed
 * - 'focus': (paneId: number) - Pane focused
 * - 'resize': () - Layout changed
 */
export class PaneContainer extends EventEmitter {
  private box: blessed.Widgets.BoxElement;
  private panes: Pane[] = [];
  private direction: SplitDirection = 'horizontal';
  private activePaneId: number | null = null;
  private nextPaneId = 1;

  constructor(options: PaneContainerOptions) {
    super();

    this.box = blessed.box({
      parent: options.parent,
      top: options.top ?? 0,
      left: options.left ?? 0,
      width: options.width ?? '100%',
      height: options.height ?? '100%',
      style: {
        fg: 'white',
        bg: 'black',
      },
    });

    // Handle resize
    this.box.on('resize', () => {
      this.layout();
    });
  }

  /** Get the blessed element */
  get element(): blessed.Widgets.BoxElement {
    return this.box;
  }

  /** Get active pane ID */
  get activeId(): number | null {
    return this.activePaneId;
  }

  /** Get all panes */
  get allPanes(): Pane[] {
    return [...this.panes];
  }

  /** Get the split direction */
  get splitDirection(): SplitDirection {
    return this.direction;
  }

  /**
   * Create a new pane.
   *
   * @param size - Initial size percentage
   * @returns Pane ID and element
   */
  createPane(size?: number): { id: number; element: blessed.Widgets.BoxElement } {
    const id = this.nextPaneId++;

    // Calculate size
    const paneSize = size ?? (100 / (this.panes.length + 1));

    // Adjust existing panes
    if (this.panes.length > 0) {
      const reduction = paneSize / this.panes.length;
      for (const pane of this.panes) {
        pane.size = Math.max(10, pane.size - reduction);
      }
    }

    // Create pane element
    const element = blessed.box({
      parent: this.box,
      style: {
        fg: 'white',
        bg: 'black',
      },
    });

    const pane: Pane = { id, element, size: paneSize };
    this.panes.push(pane);

    // Auto-focus first pane
    if (this.activePaneId === null) {
      this.activePaneId = id;
    }

    this.layout();
    return { id, element };
  }

  /**
   * Remove a pane.
   *
   * @param paneId - Pane ID to remove
   */
  removePane(paneId: number): void {
    const index = this.panes.findIndex((p) => p.id === paneId);
    if (index === -1) return;

    const pane = this.panes[index];
    pane.element.destroy();
    this.panes.splice(index, 1);

    // Redistribute space
    if (this.panes.length > 0) {
      const extra = pane.size / this.panes.length;
      for (const p of this.panes) {
        p.size += extra;
      }
    }

    // Update active pane
    if (this.activePaneId === paneId) {
      if (this.panes.length > 0) {
        const newIndex = Math.min(index, this.panes.length - 1);
        this.activePaneId = this.panes[newIndex].id;
        this.emit('focus', this.activePaneId);
      } else {
        this.activePaneId = null;
      }
    }

    this.layout();
    this.emit('close', paneId);
  }

  /**
   * Split a pane.
   *
   * @param paneId - Pane ID to split (or active pane)
   * @param direction - Split direction
   * @returns New pane ID and element
   */
  split(
    paneId?: number,
    direction?: SplitDirection
  ): { id: number; element: blessed.Widgets.BoxElement } | null {
    const targetId = paneId ?? this.activePaneId;
    if (targetId === null) return null;

    // Set direction if specified
    if (direction && this.panes.length <= 1) {
      this.direction = direction;
    }

    // Get current pane
    const currentPane = this.panes.find((p) => p.id === targetId);
    if (!currentPane) return null;

    // Split current pane's size
    const newSize = currentPane.size / 2;
    currentPane.size = newSize;

    // Create new pane
    const result = this.createPane(newSize);

    this.emit('split', targetId, this.direction);
    return result;
  }

  /**
   * Focus a pane.
   *
   * @param paneId - Pane ID to focus
   */
  focusPane(paneId: number): void {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane) return;

    this.activePaneId = paneId;
    pane.element.focus();
    this.emit('focus', paneId);
  }

  /**
   * Focus next pane.
   */
  focusNext(): void {
    if (this.panes.length === 0) return;

    const currentIndex = this.panes.findIndex((p) => p.id === this.activePaneId);
    const nextIndex = (currentIndex + 1) % this.panes.length;
    this.focusPane(this.panes[nextIndex].id);
  }

  /**
   * Focus previous pane.
   */
  focusPrevious(): void {
    if (this.panes.length === 0) return;

    const currentIndex = this.panes.findIndex((p) => p.id === this.activePaneId);
    const prevIndex = currentIndex === 0 ? this.panes.length - 1 : currentIndex - 1;
    this.focusPane(this.panes[prevIndex].id);
  }

  /**
   * Set split direction.
   *
   * @param direction - New split direction
   */
  setDirection(direction: SplitDirection): void {
    if (this.direction !== direction) {
      this.direction = direction;
      this.layout();
    }
  }

  /**
   * Resize a pane.
   *
   * @param paneId - Pane ID
   * @param size - New size percentage
   */
  resizePane(paneId: number, size: number): void {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane) return;

    // Clamp size
    const newSize = Math.max(10, Math.min(90, size));
    const diff = newSize - pane.size;

    // Adjust other panes proportionally
    const others = this.panes.filter((p) => p.id !== paneId);
    const totalOtherSize = others.reduce((sum, p) => sum + p.size, 0);

    for (const other of others) {
      other.size -= (diff * other.size) / totalOtherSize;
    }

    pane.size = newSize;
    this.layout();
    this.emit('resize');
  }

  /**
   * Get pane by ID.
   */
  getPane(paneId: number): Pane | undefined {
    return this.panes.find((p) => p.id === paneId);
  }

  /**
   * Layout all panes.
   */
  private layout(): void {
    if (this.panes.length === 0) return;

    const width = this.box.width as number;
    const height = this.box.height as number;

    let pos = 0;
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      const isLast = i === this.panes.length - 1;

      if (this.direction === 'horizontal') {
        // Horizontal split (side by side)
        const paneWidth = isLast
          ? width - pos
          : Math.floor((pane.size / 100) * width);

        pane.element.left = pos;
        pane.element.top = 0;
        pane.element.width = paneWidth;
        pane.element.height = height;

        pos += paneWidth;
      } else {
        // Vertical split (stacked)
        const paneHeight = isLast
          ? height - pos
          : Math.floor((pane.size / 100) * height);

        pane.element.left = 0;
        pane.element.top = pos;
        pane.element.width = width;
        pane.element.height = paneHeight;

        pos += paneHeight;
      }
    }

    this.box.screen.render();
  }
}
