/**
 * PTY Event Manager - Single global listener for PTY events
 *
 * Problem: Each TerminalPane was adding its own ipcRenderer.on('pty:data') listener,
 * causing listener accumulation and event routing issues.
 *
 * Solution: Single global listener that routes events to registered handlers by PTY ID.
 * Data is buffered per-PTY until a handler is registered, then flushed.
 */

type DataHandler = (data: string) => void;
type ExitHandler = (code: number) => void;

class PtyEventManager {
  private dataHandlers: Map<number, DataHandler> = new Map();
  private exitHandlers: Map<number, ExitHandler> = new Map();
  private initialized = false;

  // Buffer data for PTYs that don't have handlers yet
  // Only buffer for PTYs that have been "expected" (will have a handler soon)
  private dataBuffer: Map<number, string[]> = new Map();
  private exitBuffer: Map<number, number> = new Map();
  private expectedPtyIds: Set<number> = new Set();

  constructor() {
    // Initialize immediately when the module loads
    // Use setTimeout to ensure window.lee is available
    if (typeof window !== 'undefined') {
      setTimeout(() => this.init(), 0);
    }
  }

  /**
   * Initialize the global listeners. Called automatically.
   */
  private init(): void {
    if (this.initialized) return;

    const lee = (window as any).lee;
    if (!lee?.pty) {
      console.error('[PtyEventManager] lee.pty not available, retrying...');
      setTimeout(() => this.init(), 100);
      return;
    }

    // Single global listener for data events
    lee.pty.onData((id: number, data: string) => {
      const handler = this.dataHandlers.get(id);
      if (handler) {
        handler(data);
      } else if (this.expectedPtyIds.has(id)) {
        // Only buffer if this PTY is expected to have a handler soon
        if (!this.dataBuffer.has(id)) {
          this.dataBuffer.set(id, []);
        }
        this.dataBuffer.get(id)!.push(data);
      }
      // Ignore data for unexpected PTYs (prewarmed editor/daemon)
    });

    // Single global listener for exit events
    lee.pty.onExit((id: number, code: number) => {
      const handler = this.exitHandlers.get(id);
      if (handler) {
        handler(code);
      } else if (this.expectedPtyIds.has(id)) {
        // Only buffer if this PTY is expected to have a handler soon
        this.exitBuffer.set(id, code);
      }
      // Ignore exits for unexpected PTYs (prewarmed editor/daemon)
    });

    this.initialized = true;
    console.log('[PtyEventManager] Initialized global PTY event listeners');
  }

  /**
   * Mark a PTY ID as expected (will have a handler registered soon).
   * Call this when spawning a PTY to enable buffering before handler is ready.
   */
  expect(ptyId: number): void {
    this.expectedPtyIds.add(ptyId);
  }

  /**
   * Register handlers for a specific PTY ID.
   * Returns a cleanup function to unregister.
   */
  register(
    ptyId: number,
    onData: DataHandler,
    onExit: ExitHandler
  ): () => void {
    // Mark as expected in case it wasn't already
    this.expectedPtyIds.add(ptyId);

    // Store handlers
    this.dataHandlers.set(ptyId, onData);
    this.exitHandlers.set(ptyId, onExit);

    // Flush any buffered data
    const bufferedData = this.dataBuffer.get(ptyId);
    if (bufferedData && bufferedData.length > 0) {
      console.log(`[PtyEventManager] Flushing ${bufferedData.length} buffered data chunks for ptyId=${ptyId}`);
      for (const data of bufferedData) {
        onData(data);
      }
      this.dataBuffer.delete(ptyId);
    }

    // Flush any buffered exit
    const bufferedExit = this.exitBuffer.get(ptyId);
    if (bufferedExit !== undefined) {
      console.log(`[PtyEventManager] Flushing buffered exit for ptyId=${ptyId}`);
      onExit(bufferedExit);
      this.exitBuffer.delete(ptyId);
    }

    // Return cleanup function
    return () => {
      this.dataHandlers.delete(ptyId);
      this.exitHandlers.delete(ptyId);
      this.expectedPtyIds.delete(ptyId);
      this.dataBuffer.delete(ptyId);
      this.exitBuffer.delete(ptyId);
    };
  }

  /**
   * Check if a PTY ID has registered handlers.
   */
  hasHandlers(ptyId: number): boolean {
    return this.dataHandlers.has(ptyId);
  }

  /**
   * Clear all handlers and buffers. Used during workspace transitions
   * to reset state before restoring a new session.
   */
  clearAll(): void {
    this.dataHandlers.clear();
    this.exitHandlers.clear();
    this.expectedPtyIds.clear();
    this.dataBuffer.clear();
    this.exitBuffer.clear();
  }
}

// Singleton instance - initializes on module load
export const ptyEventManager = new PtyEventManager();
