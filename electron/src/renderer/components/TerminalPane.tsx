/**
 * TerminalPane Component - xterm.js terminal wrapper
 *
 * Supports:
 * - Standard terminal I/O via node-pty
 * - Image paste: Cmd/Ctrl+V with image in clipboard saves to temp file
 *   and inserts path (useful for Claude CLI image inputs)
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { focusManager } from '../hooks/useFocusManager';
import { ptyEventManager } from '../hooks/usePtyEvents';
import '@xterm/xterm/css/xterm.css';

// Get the Lee API from preload
const lee = (window as any).lee;

// Clipboard image data type from preload
interface ClipboardImageData {
  hasImage: boolean;
  base64?: string;
  width?: number;
  height?: number;
  format?: string;
  tempFilePath?: string;
}

interface TerminalPaneProps {
  ptyId: number | null;
  active: boolean;
  label?: string; // Tab label for loading message
  watched?: boolean; // Whether this tab is being watched for idle state
  onIdleChange?: (ptyId: number, isIdle: boolean) => void; // Callback when idle state changes
}

const IDLE_THRESHOLD_MS = 10000; // 10 seconds without output = idle

export const TerminalPane: React.FC<TerminalPaneProps> = ({ ptyId, active, label, watched, onIdleChange }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(ptyId);
  const [terminalReady, setTerminalReady] = useState(false);
  const [hasReceivedData, setHasReceivedData] = useState(false);
  const hasReceivedDataRef = useRef(false);

  // Track if user has scrolled away from bottom (to avoid auto-scrolling when user is reading history)
  const isAtBottomRef = useRef(true);

  // Show scroll hint when user scrolls up
  const [showScrollHint, setShowScrollHint] = useState(false);
  const scrollHintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Idle detection for watched tabs
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isIdleRef = useRef(false);

  // Safe resize function that prevents row overflow
  // Key insight: The flex layout doesn't constrain height properly, so we calculate
  // from window.innerHeight minus fixed UI elements (tab bar ~36px, status bar ~24px)
  const safeResize = useCallback(() => {
    if (!fitAddonRef.current || !terminalRef.current || !containerRef.current) return;
    try {
      const terminal = terminalRef.current;
      const container = containerRef.current;

      // Get core dimensions from terminal
      const core = (terminal as any)._core;
      if (!core || !core._renderService) {
        fitAddonRef.current.fit();
        return;
      }

      const cellHeight = core._renderService.dimensions.css.cell.height;
      const cellWidth = core._renderService.dimensions.css.cell.width;

      if (!cellHeight || !cellWidth) {
        fitAddonRef.current.fit();
        return;
      }

      // Use window height minus fixed UI elements
      // Tab bar: ~36px, Status bar: ~24px, some buffer: ~5px
      const fixedUIHeight = 65;
      const availableHeight = window.innerHeight - fixedUIHeight;
      const availableWidth = container.clientWidth;

      // Calculate rows and cols with conservative rounding
      const cols = Math.floor(availableWidth / cellWidth);
      const rows = Math.floor(availableHeight / cellHeight);

      const safeCols = Math.max(1, cols);
      const safeRows = Math.max(1, rows - 3);

      terminal.resize(safeCols, safeRows);
      if (ptyIdRef.current !== null) {
        lee.pty.resize(ptyIdRef.current, safeCols, safeRows);
      }
    } catch (e) {
      console.error('[safeResize] Error:', e);
      // Fallback to FitAddon on any error
      try {
        fitAddonRef.current?.fit();
      } catch {}
    }
  }, []);

  // Keep ptyIdRef in sync with ptyId prop
  useEffect(() => {
    ptyIdRef.current = ptyId;
  }, [ptyId]);

  // Handle image paste - saves clipboard image to temp file and inserts path
  const handleImagePaste = useCallback(async (): Promise<boolean> => {
    if (!lee?.clipboard?.readImage) return false;

    try {
      const imageData: ClipboardImageData = await lee.clipboard.readImage();

      if (!imageData.hasImage) {
        return false; // No image in clipboard, let normal paste proceed
      }

      // Save image to temp file
      const filePath = await lee.clipboard.saveImageToTemp();

      if (filePath && ptyIdRef.current !== null) {
        // Insert the file path into the terminal
        // Quote the path in case it has spaces
        const quotedPath = filePath.includes(' ') ? `"${filePath}"` : filePath;
        lee.pty.write(ptyIdRef.current, quotedPath);

        // Show feedback in terminal (dim text)
        if (terminalRef.current) {
          terminalRef.current.write(`\x1b[90m [Image saved: ${imageData.width}x${imageData.height}]\x1b[0m`);
        }

        return true; // Image was handled
      }
    } catch (error) {
      console.error('Error handling image paste:', error);
    }

    return false;
  }, []);

  // Initialize terminal immediately on mount (not dependent on active state)
  // Terminal stays alive for the lifetime of the component
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Courier New, monospace',
      theme: {
        background: '#0d1a14',
        foreground: '#eee',
        cursor: '#4a9',
        cursorAccent: '#0d1a14',
        selectionBackground: '#1a3028',
        black: '#0d1a14',
        red: '#e55',
        green: '#4a9',
        yellow: '#da3',
        blue: '#5ad',
        magenta: '#a6d',
        cyan: '#5bc',
        white: '#ddd',
        brightBlack: '#456',
        brightRed: '#f66',
        brightGreen: '#5ca',
        brightYellow: '#eb4',
        brightBlue: '#6be',
        brightMagenta: '#b7e',
        brightCyan: '#6cd',
        brightWhite: '#fff',
      },
      allowTransparency: false,
      scrollback: 10000,
      // CRITICAL: Keep viewport at bottom when new data arrives
      // This prevents the "scroll to top" issue when TUIs send large responses
      scrollOnUserInput: true,
      // Ensure fast scroll doesn't cause viewport desync
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(containerRef.current);

    // Try to load WebGL addon for GPU acceleration
    try {
      const webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
    } catch (e) {
      console.warn('WebGL addon not available, falling back to canvas renderer');
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalReady(true);

    // Track scroll position to detect if user scrolled away from bottom
    // This allows us to auto-scroll on new output only when user is "following" output
    const scrollDisposable = terminal.onScroll(() => {
      // Check if we're at the bottom of the scrollback
      // buffer.ybase is the top of the scrollback, buffer.ydisp is the current viewport position
      // When ydisp >= ybase, we're at the bottom (showing the most recent content)
      const buffer = terminal.buffer.active;
      const isAtBottom = buffer.viewportY >= buffer.baseY;
      const wasAtBottom = isAtBottomRef.current;
      isAtBottomRef.current = isAtBottom;

      // Show scroll hint when user scrolls up from bottom
      if (wasAtBottom && !isAtBottom) {
        setShowScrollHint(true);
        // Clear any existing timeout
        if (scrollHintTimeoutRef.current) {
          clearTimeout(scrollHintTimeoutRef.current);
        }
        // Auto-hide after 3 seconds
        scrollHintTimeoutRef.current = setTimeout(() => {
          setShowScrollHint(false);
        }, 3000);
      } else if (isAtBottom) {
        // Hide hint when user scrolls back to bottom
        setShowScrollHint(false);
        if (scrollHintTimeoutRef.current) {
          clearTimeout(scrollHintTimeoutRef.current);
          scrollHintTimeoutRef.current = null;
        }
      }
    });

    // Initial fit after a short delay to ensure DOM is ready
    requestAnimationFrame(() => {
      safeResize();
      // Second attempt after layout settles
      requestAnimationFrame(safeResize);
    });

    // ResizeObserver catches panel resizes that don't trigger window resize
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      // Debounce rapid resize events
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(safeResize, 10);
    });
    resizeObserver.observe(containerRef.current);

    window.addEventListener('resize', safeResize);

    // Handle paste events - check for images first
    const handlePaste = async (e: ClipboardEvent) => {
      // Only handle if terminal is focused
      if (!containerRef.current?.contains(document.activeElement)) return;

      // Check if clipboard has an image
      const imageHandled = await handleImagePaste();

      if (imageHandled) {
        // Prevent default paste since we handled the image
        e.preventDefault();
      }
      // If no image, let normal paste proceed (text will be handled by xterm.js)
    };

    document.addEventListener('paste', handlePaste);

    return () => {
      // Cleanup only on unmount
      window.removeEventListener('resize', safeResize);
      document.removeEventListener('paste', handlePaste);
      resizeObserver.disconnect();
      scrollDisposable.dispose();
      if (scrollHintTimeoutRef.current) {
        clearTimeout(scrollHintTimeoutRef.current);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      setTerminalReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - only run on mount/unmount

  // Register/unregister terminal with FocusManager
  // Depends on terminalReady to ensure terminal is created before registering
  useEffect(() => {
    if (ptyId === null || !terminalReady || !terminalRef.current) return;

    focusManager.register(ptyId, terminalRef.current);

    return () => {
      focusManager.unregister(ptyId);
    };
  }, [ptyId, terminalReady]);

  // Connect terminal to PTY using the global event manager
  useEffect(() => {
    if (!terminalRef.current || ptyId === null) return;

    const terminal = terminalRef.current;
    console.log(`[TerminalPane] Setting up PTY connection for ptyId=${ptyId}`);

    // Handle data from PTY - routed through global event manager
    const handleData = (data: string) => {
      try {
        // Mark that we've received data (hides loading indicator)
        if (!hasReceivedDataRef.current) {
          hasReceivedDataRef.current = true;
          setHasReceivedData(true);
        }

        // Reset idle timer if watched - we got output, so not idle
        if (watched && onIdleChange && ptyId !== null) {
          // If we were idle, notify we're no longer idle
          if (isIdleRef.current) {
            isIdleRef.current = false;
            onIdleChange(ptyId, false);
          }
          // Clear existing timer and start new one
          if (idleTimerRef.current) {
            clearTimeout(idleTimerRef.current);
          }
          idleTimerRef.current = setTimeout(() => {
            isIdleRef.current = true;
            onIdleChange(ptyId, true);
          }, IDLE_THRESHOLD_MS);
        }

        // Check if we were at bottom BEFORE writing (write may change scroll position)
        const wasAtBottom = isAtBottomRef.current;

        terminal.write(data);

        // If user was following output (at bottom), keep them at bottom after new data
        // This fixes the "scroll to top" issue when large responses arrive
        // Note: TUIs using alternate screen buffer handle their own viewport,
        // so this mainly helps with normal shell output and non-fullscreen TUIs
        //
        // CRITICAL: Use requestAnimationFrame to defer scrollToBottom until AFTER
        // xterm.js has finished rendering. terminal.write() is synchronous but
        // xterm.js rendering is async - calling scrollToBottom immediately uses
        // outdated buffer dimensions, causing scroll position to be mid-buffer
        // instead of at the actual bottom for large outputs.
        //
        // For very large outputs, we use double-RAF to ensure buffer dimensions
        // have fully settled. The first RAF waits for layout, the second ensures
        // any deferred xterm.js rendering has completed.
        if (wasAtBottom) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              terminal.scrollToBottom();
            });
          });
        }
      } catch (e) {
        console.warn('Terminal write error (likely unsupported escape sequence):', e);
      }
    };

    // Handle PTY exit
    const handleExit = (code: number) => {
      terminal.write(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n`);
    };

    // Register with the global event manager (single listener, routes by ID)
    const unregister = ptyEventManager.register(ptyId, handleData, handleExit);

    // Send terminal input to PTY
    const disposable = terminal.onData((data) => {
      lee.pty.write(ptyId, data);
    });

    // Initial resize - delay to ensure container is fully laid out
    // Use setTimeout to let layout fully stabilize before fitting
    setTimeout(() => {
      safeResize();
    }, 50);

    return () => {
      console.log(`[TerminalPane] Cleaning up PTY connection for ptyId=${ptyId}`);
      disposable.dispose();
      unregister();
      // Clear idle timer on cleanup
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [ptyId, terminalReady, watched, onIdleChange]);

  // Handle watched state changes - start/stop idle timer
  useEffect(() => {
    if (watched && ptyId !== null && onIdleChange) {
      // Start idle timer when watching begins
      // Assume currently idle since we just started watching
      idleTimerRef.current = setTimeout(() => {
        isIdleRef.current = true;
        onIdleChange(ptyId, true);
      }, IDLE_THRESHOLD_MS);
    } else {
      // Stop watching - clear timer and reset state
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (isIdleRef.current && ptyId !== null && onIdleChange) {
        isIdleRef.current = false;
        onIdleChange(ptyId, false);
      }
    }

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [watched, ptyId, onIdleChange]);

  // Notify FocusManager when this terminal becomes active
  // Wait for terminalReady to ensure registration happened first
  useEffect(() => {
    if (active && ptyId !== null && terminalReady) {

      focusManager.setActive(ptyId);

      // Re-fit and refresh when becoming active
      // WebGL context may need refresh after being hidden
      if (fitAddonRef.current && terminalRef.current) {
        // Use setTimeout to let layout fully stabilize
        setTimeout(() => {
          const terminal = terminalRef.current;
          if (!terminal) return;

          // Use safe resize to prevent row overflow
          safeResize();

          // Reset character set to ASCII (G0 = US-ASCII)
          // This fixes corruption from TUIs like btop that use alternate character sets
          // for box drawing. Without this reset, switching tabs can leave the terminal
          // in a state where normal text renders as box drawing characters.
          // \x1b(B = Set G0 to US-ASCII (normal characters)
          // \x0f   = Shift In (select G0 character set)
          terminal.write('\x1b(B\x0f');

          // Force a full refresh to fix viewport alignment issues after tab switch
          terminal.refresh(0, terminal.rows - 1);

          // Scroll to bottom if user was following output before switching tabs
          // This ensures the user sees the most recent content when returning
          if (isAtBottomRef.current) {
            terminal.scrollToBottom();
          }
        }, 50);
      }
    }
  }, [active, ptyId, terminalReady, safeResize]);

  // Handle click on terminal container to focus
  const handleClick = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  }, []);

  // Show loading state until we receive first data from the TUI
  const isLoading = !hasReceivedData;

  return (
    <div
      ref={containerRef}
      className={`terminal-pane ${active ? 'active' : ''}`}
      style={{
        // Use visibility instead of display:none for better WebGL compatibility
        // display:none destroys the WebGL context in some browsers
        visibility: active ? 'visible' : 'hidden',
        position: active ? 'relative' : 'absolute',
        // When hidden, take it out of layout flow but keep size for WebGL
        width: active ? '100%' : '100%',
        height: active ? '100%' : '100%',
        pointerEvents: active ? 'auto' : 'none',
        zIndex: active ? 1 : -1,
      }}
      onClick={handleClick}
    >
      {isLoading && active && (
        <div className="terminal-loading">
          <span className="loading-text">Loading {label || 'terminal'}...</span>
        </div>
      )}
      {showScrollHint && active && (
        <div className="scroll-hint">
          <kbd>⌘↓</kbd> to scroll to bottom
        </div>
      )}
    </div>
  );
};
