/**
 * Window Registry - Tracks all open BrowserWindows and their associated state.
 *
 * Each window has its own workspace, ContextBridge, and set of PTYs.
 * Exported as a singleton instance for use across the main process.
 */

import { BrowserWindow } from 'electron';
import { ContextBridge } from './context-bridge';

export interface WindowState {
  browserWindow: BrowserWindow;
  workspace: string | null;
  contextBridge: ContextBridge;
}

class WindowRegistry {
  private windows: Map<number, WindowState> = new Map();

  /**
   * Register a new window with its associated state.
   * Returns the BrowserWindow.id used as the key.
   */
  register(bw: BrowserWindow, workspace: string | null, contextBridge: ContextBridge): number {
    const id = bw.id;
    this.windows.set(id, { browserWindow: bw, workspace, contextBridge });
    return id;
  }

  /**
   * Unregister a window (called on window close).
   */
  unregister(id: number): void {
    this.windows.delete(id);
  }

  /**
   * Get window state by BrowserWindow.id.
   */
  get(id: number): WindowState | undefined {
    return this.windows.get(id);
  }

  /**
   * Get the currently focused window's state.
   */
  getFocused(): WindowState | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      return this.windows.get(focused.id);
    }
    return undefined;
  }

  /**
   * Get all registered windows.
   */
  getAll(): Map<number, WindowState> {
    return this.windows;
  }

  /**
   * Update the workspace for a window.
   */
  setWorkspace(id: number, workspace: string): void {
    const state = this.windows.get(id);
    if (state) {
      state.workspace = workspace;
    }
  }

  /**
   * Get any available window (focused first, then first in map).
   * Useful for dialogs that need a parent window.
   */
  getAny(): WindowState | undefined {
    return this.getFocused() || this.windows.values().next().value;
  }
}

/** Singleton instance */
export const windowRegistry = new WindowRegistry();
