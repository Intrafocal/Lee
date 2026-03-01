/**
 * Focus Manager - Centralized terminal focus management
 *
 * The problem: xterm.js terminals need explicit .focus() calls, but:
 * 1. Elements with display:none can't receive focus
 * 2. React re-renders can steal focus
 * 3. Multiple setTimeout calls are unreliable
 *
 * The solution: A singleton focus manager that:
 * 1. Tracks all terminal refs by ID
 * 2. Knows which terminal should be focused
 * 3. Uses requestAnimationFrame for reliable timing
 * 4. Retries focus until it succeeds
 */

import { Terminal } from '@xterm/xterm';

class FocusManager {
  private terminals: Map<number, Terminal> = new Map();
  private activeId: number | null = null;
  private focusTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private maxRetries = 20;
  private retryDelayMs = 50; // 50ms between retries

  /**
   * Register a terminal instance
   */
  register(id: number, terminal: Terminal): void {
    this.terminals.set(id, terminal);
  }

  /**
   * Unregister a terminal instance
   */
  unregister(id: number): void {
    this.terminals.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
    }
  }

  /**
   * Set which terminal should be focused.
   * This will attempt to focus it after waiting for React to render.
   */
  setActive(id: number | null): void {
    this.activeId = id;

    // Cancel any pending focus attempt
    if (this.focusTimeoutId !== null) {
      clearTimeout(this.focusTimeoutId);
      this.focusTimeoutId = null;
    }

    if (id !== null) {
      // Use double requestAnimationFrame to ensure React has finished rendering
      // First rAF schedules after current frame, second ensures paint is complete
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.activeId === id) {
            this.attemptFocus(0);
          }
        });
      });
    }
  }

  /**
   * Force refocus the currently active terminal.
   * Useful when focus is lost (e.g., clicking UI elements).
   */
  refocus(): void {
    if (this.activeId !== null) {
      this.attemptFocus(0);
    }
  }

  /**
   * Attempt to focus the active terminal.
   * Uses setTimeout with delays to wait for display:none -> display:flex transition.
   * Retries if the terminal isn't ready yet.
   */
  private attemptFocus(attempt: number): void {
    if (this.activeId === null) return;

    const terminal = this.terminals.get(this.activeId);
    if (!terminal) {
      // Terminal not registered yet, retry
      if (attempt < this.maxRetries) {
        this.focusTimeoutId = setTimeout(() => {
          this.attemptFocus(attempt + 1);
        }, this.retryDelayMs);
      } else {
        console.warn(`[FocusManager] Terminal ${this.activeId} not registered after ${this.maxRetries} attempts`);
      }
      return;
    }

    // Check if the terminal's textarea exists
    const textarea = terminal.textarea;
    if (!textarea) {
      if (attempt < this.maxRetries) {
        this.focusTimeoutId = setTimeout(() => {
          this.attemptFocus(attempt + 1);
        }, this.retryDelayMs);
      }
      return;
    }

    // Check if the terminal container is visible (not display:none)
    // Note: xterm.js textarea is intentionally off-screen for accessibility,
    // so we check the terminal's parent container instead
    const terminalContainer = textarea.closest('.terminal-pane');
    if (terminalContainer) {
      const containerStyle = window.getComputedStyle(terminalContainer);
      const isContainerVisible = containerStyle.display !== 'none';

      if (!isContainerVisible) {
        if (attempt < this.maxRetries) {
          this.focusTimeoutId = setTimeout(() => {
            this.attemptFocus(attempt + 1);
          }, this.retryDelayMs);
        } else {
          console.warn(`[FocusManager] Terminal ${this.activeId} container not visible after ${this.maxRetries} attempts`);
        }
        return;
      }
    }

    // Terminal is ready, focus it
    terminal.focus();

    // Also try focusing the textarea directly as backup
    textarea.focus();
  }

  /**
   * Get the currently active terminal ID
   */
  getActiveId(): number | null {
    return this.activeId;
  }

  /**
   * Scroll the active terminal to the bottom.
   * Useful when the viewport gets out of sync after large outputs.
   */
  scrollToBottom(): void {
    if (this.activeId === null) return;

    const terminal = this.terminals.get(this.activeId);
    if (terminal) {
      terminal.scrollToBottom();
    }
  }
}

// Singleton instance
export const focusManager = new FocusManager();

/**
 * Hook to access the focus manager
 */
export function useFocusManager() {
  return focusManager;
}
