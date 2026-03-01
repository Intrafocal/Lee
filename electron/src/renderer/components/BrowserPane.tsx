/**
 * BrowserPane - Embedded browser tab using Electron webview
 *
 * Features:
 * - Navigation bar (back, forward, refresh, URL input)
 * - URL autocomplete with history
 * - Loading indicator
 * - Console log watching with error tracking
 * - Hester button for manual snapshot capture
 * - AgentGraph event detection for Frame (localhost:8889)
 * - Title updates from page
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { ConsoleLogEntry, AgentGraphEvent, FrameSession } from '../../shared/context';

const lee = (window as any).lee;
const isElectron = typeof lee !== 'undefined';

// Maximum console logs to keep in buffer
const MAX_CONSOLE_LOGS = 500;

// ============================================
// URL History Management
// ============================================

interface UrlHistoryEntry {
  url: string;
  title: string;
  lastVisited: number;
  visitCount: number;
}

const URL_HISTORY_KEY = 'lee-browser-url-history';
const MAX_HISTORY_ENTRIES = 100;

function getUrlHistory(): UrlHistoryEntry[] {
  try {
    const stored = localStorage.getItem(URL_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveUrlToHistory(url: string, title: string): void {
  try {
    // Skip empty or about: URLs
    if (!url || url.startsWith('about:') || url === 'about:blank') return;

    const history = getUrlHistory();
    const existingIndex = history.findIndex((h) => h.url === url);

    if (existingIndex >= 0) {
      // Update existing entry
      history[existingIndex].title = title || history[existingIndex].title;
      history[existingIndex].lastVisited = Date.now();
      history[existingIndex].visitCount += 1;
    } else {
      // Add new entry
      history.unshift({
        url,
        title: title || url,
        lastVisited: Date.now(),
        visitCount: 1,
      });
    }

    // Sort by visit count (descending), then by last visited
    history.sort((a, b) => {
      if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
      return b.lastVisited - a.lastVisited;
    });

    // Trim to max entries
    const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);
    localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage errors
  }
}

function searchUrlHistory(query: string): UrlHistoryEntry[] {
  if (!query || query.length < 2) return [];

  const history = getUrlHistory();
  const lowerQuery = query.toLowerCase();

  return history
    .filter((h) =>
      h.url.toLowerCase().includes(lowerQuery) ||
      h.title.toLowerCase().includes(lowerQuery)
    )
    .slice(0, 8); // Max 8 suggestions
}

interface BrowserPaneProps {
  active: boolean;
  tabId: number;
  initialUrl?: string;
  watched?: boolean;
  onTitleChange?: (title: string) => void;
  onUrlChange?: (url: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  onAskHester?: (prompt: string, autoSubmit?: boolean) => void;
  onConsoleError?: (entry: ConsoleLogEntry) => void;
  onAgentGraphEvent?: (event: AgentGraphEvent) => void;
  onErrorCountChange?: (count: number) => void;
  onFrameSnapshotCaptured?: (dir: string) => void;
  onCheckpointReadyChange?: (ready: boolean) => void;
}

// Default start page
const DEFAULT_URL = 'https://www.google.com';

// Console log level mapping from webview
const CONSOLE_LEVELS: Record<number, ConsoleLogEntry['level']> = {
  0: 'log',
  1: 'info',
  2: 'error',
  3: 'warn',
};

export const BrowserPane: React.FC<BrowserPaneProps> = ({
  active,
  tabId,
  initialUrl,
  watched = false,
  onTitleChange,
  onUrlChange,
  onLoadingChange,
  onAskHester,
  onConsoleError,
  onAgentGraphEvent,
  onErrorCountChange,
  onFrameSnapshotCaptured,
  onCheckpointReadyChange,
}) => {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Console log buffer
  const consoleLogsRef = useRef<ConsoleLogEntry[]>([]);
  const [errorCount, setErrorCount] = useState(0);

  // Frame session tracking
  const frameSessionRef = useRef<FrameSession | null>(null);
  // Email captured from auth logs (more reliable than user_id for session lookup)
  const userEmailRef = useRef<string | null>(null);

  const [currentUrl, setCurrentUrl] = useState(initialUrl || DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(initialUrl || DEFAULT_URL);
  const [title, setTitle] = useState('New Tab');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);

  // URL autocomplete state
  const [suggestions, setSuggestions] = useState<UrlHistoryEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Cast resize state (from Aeronaut browsercast)
  const [castSize, setCastSize] = useState<{ width: number; height: number } | null>(null);

  // Console panel state
  const [showConsolePanel, setShowConsolePanel] = useState(false);
  const [logUpdateCounter, setLogUpdateCounter] = useState(0); // Triggers re-render when logs change
  const consolePanelRef = useRef<HTMLDivElement>(null);

  // Check if this is a Frame URL
  const isFrameUrl = useCallback((url: string) => {
    return url.includes('localhost:8889') || url.includes('127.0.0.1:8889');
  }, []);

  // Handle navigation
  const navigate = useCallback((url: string) => {
    if (!webviewRef.current) return;

    // Add protocol if missing
    let targetUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
      // Check if it looks like a search query
      if (!url.includes('.') || url.includes(' ')) {
        targetUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      } else {
        targetUrl = `https://${url}`;
      }
    }

    webviewRef.current.loadURL(targetUrl);
  }, []);

  const goBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const goForward = useCallback(() => {
    webviewRef.current?.goForward();
  }, []);

  const refresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const stop = useCallback(() => {
    webviewRef.current?.stop();
  }, []);

  // Handle URL input change with autocomplete
  const handleUrlInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputUrl(value);

    // Search history for suggestions
    const matches = searchUrlHistory(value);
    setSuggestions(matches);
    setShowSuggestions(matches.length > 0);
    setSelectedSuggestionIndex(-1);
  }, []);

  // Handle URL input focus
  const handleUrlInputFocus = useCallback(() => {
    // Show recent history on focus if input matches current URL
    if (inputUrl === currentUrl) {
      const recent = getUrlHistory().slice(0, 8);
      if (recent.length > 0) {
        setSuggestions(recent);
        setShowSuggestions(true);
      }
    } else if (inputUrl.length >= 2) {
      const matches = searchUrlHistory(inputUrl);
      setSuggestions(matches);
      setShowSuggestions(matches.length > 0);
    }
  }, [inputUrl, currentUrl]);

  // Handle URL input blur
  const handleUrlInputBlur = useCallback(() => {
    // Delay hiding to allow click on suggestion
    setTimeout(() => setShowSuggestions(false), 150);
  }, []);

  // Handle keyboard navigation in suggestions
  const handleUrlInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedSuggestionIndex((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedSuggestionIndex((prev) =>
        prev > 0 ? prev - 1 : suggestions.length - 1
      );
    } else if (e.key === 'Enter' && selectedSuggestionIndex >= 0) {
      e.preventDefault();
      const selected = suggestions[selectedSuggestionIndex];
      setInputUrl(selected.url);
      setShowSuggestions(false);
      navigate(selected.url);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  }, [showSuggestions, suggestions, selectedSuggestionIndex, navigate]);

  // Handle suggestion click
  const handleSuggestionClick = useCallback((entry: UrlHistoryEntry) => {
    setInputUrl(entry.url);
    setShowSuggestions(false);
    navigate(entry.url);
  }, [navigate]);

  // Handle URL input submission
  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setShowSuggestions(false);
    navigate(inputUrl);
  }, [inputUrl, navigate]);

  // Capture snapshot (returns result, doesn't trigger UI)
  const captureSnapshot = useCallback(async (): Promise<{ success: boolean; dir?: string; files?: string[]; error?: string } | null> => {
    if (!isElectron) return null;

    try {
      // Get console logs as strings
      const consoleLogs = consoleLogsRef.current.map(
        (entry) => `[${entry.level.toUpperCase()}] ${entry.message}`
      );

      // Get session state if this is a Frame URL with an active session
      let sessionState: object | undefined;
      const session = frameSessionRef.current;
      const email = userEmailRef.current;

      console.log(`[BrowserPane] captureSnapshot - session: ${JSON.stringify(session)}, email: ${email}`);

      // Use email (more reliable) or userId for session lookup
      if (session?.sessionId && email) {
        try {
          console.log(`[BrowserPane] Getting session state for ${session.sessionId} with email ${email}`);
          const result = await lee.hester.getSession(session.sessionId, email);
          if (result.success) {
            sessionState = result.data;
            console.log(`[BrowserPane] Got session state with ${Object.keys(result.data || {}).length} keys`);
          } else {
            console.warn(`[BrowserPane] Failed to get session: ${result.error}`);
          }
        } catch (err) {
          console.error('Failed to get session state:', err);
        }
      } else if (session?.sessionId && session?.userId) {
        // Fallback to userId if email not available
        try {
          const result = await lee.hester.getSession(session.sessionId, session.userId);
          if (result.success) {
            sessionState = result.data;
          }
        } catch (err) {
          console.error('Failed to get session state:', err);
        }
      }

      // Capture snapshot via IPC
      return await lee.browser.captureSnapshot(tabId, {
        screenshot: true,
        consoleLogs,
        dom: true,
        url: currentUrl,
        title,
        sessionState,
      });
    } catch (error) {
      console.error('Error capturing snapshot:', error);
      return { success: false, error: String(error) };
    }
  }, [tabId, currentUrl, title]);

  // Manual capture via Hester button - pre-populates palette but doesn't send
  const handleManualCapture = useCallback(async () => {
    if (!onAskHester) return;

    setIsCapturing(true);
    try {
      const result = await captureSnapshot();
      if (result?.success) {
        // Pre-populate palette with message but don't auto-send (autoSubmit=false)
        onAskHester(`#browser_snapshot Folder: ${result.dir} Files: ${result.files?.join(', ')}`, false);
      } else {
        onAskHester(`Failed to capture snapshot: ${result?.error || 'Unknown error'}`, false);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [captureSnapshot, onAskHester]);

  // Frame stream end - silently capture and notify via callback
  const handleFrameStreamEnd = useCallback(async () => {
    setIsCapturing(true);
    try {
      const result = await captureSnapshot();
      if (result?.success && result.dir) {
        console.log(`[BrowserPane] Frame stream snapshot saved to ${result.dir}`);
        onFrameSnapshotCaptured?.(result.dir);
      }
    } finally {
      setIsCapturing(false);
    }
  }, [captureSnapshot, onFrameSnapshotCaptured]);

  // Parse AgentGraph event from console message
  const parseAgentGraphEvent = useCallback((message: string): AgentGraphEvent | null => {
    // Helper to check and notify checkpoint readiness
    const notifyCheckpointReady = () => {
      const ready = !!(frameSessionRef.current?.sessionId && userEmailRef.current);
      console.log(`[BrowserPane] Checkpoint ready check: session=${!!frameSessionRef.current?.sessionId}, email=${!!userEmailRef.current}, ready=${ready}`);
      onCheckpointReadyChange?.(ready);
    };

    // Frame logs: "AppAuthState: User authenticated - email@example.com"
    const emailMatch = message.match(/User authenticated\s*-\s*([^\s]+@[^\s]+)/i);
    if (emailMatch) {
      // Store email for later use in session lookup
      console.log(`[BrowserPane] Captured email: ${emailMatch[1]}`);
      userEmailRef.current = emailMatch[1];
      // Check if we now have everything for checkpoint
      notifyCheckpointReady();
      return null; // Not an AgentGraph event, just storing email
    }

    // Frame logs: "graphConnectionProvider: Creating connection with sessionId: XXX"
    const frameSessionMatch = message.match(/Creating connection with sessionId:\s*([a-f0-9-]{36})/i);
    if (frameSessionMatch) {
      console.log(`[BrowserPane] Captured sessionId: ${frameSessionMatch[1]}`);
      return {
        type: 'connected',
        sessionId: frameSessionMatch[1],
        timestamp: Date.now(),
      };
    }

    // Frame logs: "ConnectionManager: Connected to AgentGraph"
    if (message.includes('Connected to AgentGraph')) {
      // If we already have a session, don't create a new event
      if (!frameSessionRef.current?.sessionId) {
        return {
          type: 'connected',
          timestamp: Date.now(),
        };
      }
    }

    // Legacy patterns: "AgentGraph connected: session_id=XXX, user_id=YYY"
    const connectedMatch = message.match(/AgentGraph connected:\s*session_id=([^,\s]+),?\s*user_id=([^\s,)]+)/i);
    if (connectedMatch) {
      return {
        type: 'connected',
        sessionId: connectedMatch[1],
        userId: connectedMatch[2],
        timestamp: Date.now(),
      };
    }

    // Detect user_id separately (from JWT or auth logs)
    const userMatch = message.match(/user_id[=:]\s*([a-f0-9-]{36})/i);
    if (userMatch && frameSessionRef.current?.sessionId) {
      return {
        type: 'userIdDetected',
        userId: userMatch[1],
        timestamp: Date.now(),
      };
    }

    // Detect stream end - Frame logs: "GraphConnection: Stream done", "Received done"
    if (
      message.includes('Stream done') ||
      message.includes('Received done') ||
      message.includes('[done]') ||
      message.includes('AgentGraph disconnected') ||
      message.includes('Stream ended')
    ) {
      return {
        type: 'streamEnd',
        timestamp: Date.now(),
      };
    }

    return null;
  }, [onCheckpointReadyChange]);

  // Handle console message
  const handleConsoleMessage = useCallback((entry: ConsoleLogEntry) => {
    // Add to buffer
    consoleLogsRef.current.push(entry);
    if (consoleLogsRef.current.length > MAX_CONSOLE_LOGS) {
      consoleLogsRef.current.shift();
    }

    // Trigger re-render if console panel is open
    if (showConsolePanel) {
      setLogUpdateCounter((c) => c + 1);
    }

    // Track errors
    if (entry.level === 'error') {
      setErrorCount((prev) => {
        const newCount = prev + 1;
        onErrorCountChange?.(newCount);
        return newCount;
      });
      onConsoleError?.(entry);
    }

    // Always parse for email/session on Frame URLs (needed for checkpoint capture)
    // but only trigger stream end events when watched
    if (isFrameUrl(currentUrl)) {
      const event = parseAgentGraphEvent(entry.message);
      if (event) {
        // Update local session tracking
        if (event.type === 'connected') {
          frameSessionRef.current = {
            sessionId: event.sessionId || '',
            userId: event.userId || null,
            startTime: Date.now(),
            errorCount: 0,
          };
          // Check if we now have everything for checkpoint (call directly to avoid stale closure)
          const ready = !!(frameSessionRef.current?.sessionId && userEmailRef.current);
          console.log(`[BrowserPane] Session connected - checkpoint ready: ${ready}`);
          onCheckpointReadyChange?.(ready);
        } else if (event.type === 'userIdDetected' && frameSessionRef.current) {
          frameSessionRef.current.userId = event.userId || null;
        } else if (event.type === 'streamEnd' && watched) {
          // For Frame: silently capture snapshot, App.tsx will show info notification
          // Only auto-capture on stream end if watch mode is enabled
          handleFrameStreamEnd();
        }

        // Only emit events if watched
        if (watched) {
          onAgentGraphEvent?.(event);
        }
      }
    }
  }, [watched, currentUrl, isFrameUrl, parseAgentGraphEvent, onConsoleError, onAgentGraphEvent, onErrorCountChange, handleFrameStreamEnd, onCheckpointReadyChange, showConsolePanel]);

  // Clear console logs and error count on navigation
  const clearConsoleLogs = useCallback(() => {
    consoleLogsRef.current = [];
    setErrorCount(0);
    onErrorCountChange?.(0);
    frameSessionRef.current = null;
    userEmailRef.current = null;
    // Notify that checkpoint is no longer ready
    onCheckpointReadyChange?.(false);
  }, [onErrorCountChange, onCheckpointReadyChange]);

  // Register webview with main process when DOM is ready
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !tabId) return;

    const handleDomReady = async () => {
      // Get the webContents ID and register with BrowserManager
      const webContentsId = (webview as any).getWebContentsId?.();
      if (webContentsId) {
        console.log(`[BrowserPane] Registering tab ${tabId} with webContentsId ${webContentsId}`);
        await lee.browser.register(tabId, webContentsId);
      }
    };

    webview.addEventListener('dom-ready', handleDomReady);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady);
      // Unregister when component unmounts
      lee.browser.unregister(tabId);
    };
  }, [tabId]);

  // Setup webview event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleDidStartLoading = () => {
      setIsLoading(true);
      onLoadingChange?.(true);
      clearConsoleLogs();
    };

    const handleDidStopLoading = () => {
      setIsLoading(false);
      onLoadingChange?.(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };

    const handleDidNavigate = (e: Electron.DidNavigateEvent) => {
      setCurrentUrl(e.url);
      setInputUrl(e.url);
      onUrlChange?.(e.url);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };

    const handleDidNavigateInPage = (e: Electron.DidNavigateInPageEvent) => {
      if (e.isMainFrame) {
        setCurrentUrl(e.url);
        setInputUrl(e.url);
        onUrlChange?.(e.url);
      }
    };

    const handlePageTitleUpdated = (e: Electron.PageTitleUpdatedEvent) => {
      setTitle(e.title);
      onTitleChange?.(e.title);
      // Save to URL history
      saveUrlToHistory(webview.getURL(), e.title);
    };

    const handleDidFailLoad = (e: Electron.DidFailLoadEvent) => {
      if (e.errorCode !== -3) { // -3 is aborted, which is normal when navigating away
        console.error('Page load failed:', e.errorDescription);
      }
      setIsLoading(false);
      onLoadingChange?.(false);
    };

    // Console message handler
    const handleConsoleMessageEvent = (e: any) => {
      const entry: ConsoleLogEntry = {
        level: CONSOLE_LEVELS[e.level] || 'log',
        message: e.message,
        source: e.sourceId || '',
        line: e.line || 0,
        timestamp: Date.now(),
      };
      handleConsoleMessage(entry);
    };

    // Add event listeners
    webview.addEventListener('did-start-loading', handleDidStartLoading);
    webview.addEventListener('did-stop-loading', handleDidStopLoading);
    webview.addEventListener('did-navigate', handleDidNavigate as any);
    webview.addEventListener('did-navigate-in-page', handleDidNavigateInPage as any);
    webview.addEventListener('page-title-updated', handlePageTitleUpdated as any);
    webview.addEventListener('did-fail-load', handleDidFailLoad as any);
    webview.addEventListener('console-message', handleConsoleMessageEvent);

    return () => {
      webview.removeEventListener('did-start-loading', handleDidStartLoading);
      webview.removeEventListener('did-stop-loading', handleDidStopLoading);
      webview.removeEventListener('did-navigate', handleDidNavigate as any);
      webview.removeEventListener('did-navigate-in-page', handleDidNavigateInPage as any);
      webview.removeEventListener('page-title-updated', handlePageTitleUpdated as any);
      webview.removeEventListener('did-fail-load', handleDidFailLoad as any);
      webview.removeEventListener('console-message', handleConsoleMessageEvent);
    };
  }, [onUrlChange, onTitleChange, onLoadingChange, handleConsoleMessage, clearConsoleLogs]);

  // Listen for cast-resize/restore from Aeronaut browsercast
  useEffect(() => {
    if (!isElectron || !tabId) return;

    const cleanupResize = lee.browser.onCastResize((resizeTabId: number, width: number, height: number) => {
      if (resizeTabId === tabId) {
        setCastSize({ width, height });
      }
    });

    const cleanupRestore = lee.browser.onCastRestore((restoreTabId: number) => {
      if (restoreTabId === tabId) {
        setCastSize(null);
      }
    });

    return () => {
      cleanupResize();
      cleanupRestore();
    };
  }, [tabId]);

  // Keyboard shortcuts when active
  useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+L to focus URL bar
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault();
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
      }
      // Cmd+R to refresh
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        refresh();
      }
      // Cmd+[ to go back
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        goBack();
      }
      // Cmd+] to go forward
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        goForward();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, refresh, goBack, goForward]);

  return (
    <div className={`browser-pane ${active ? 'active' : ''}`}>
      {/* Navigation bar */}
      <div className="browser-navbar">
        <div className="browser-nav-buttons">
          <button
            className="nav-btn"
            onClick={goBack}
            disabled={!canGoBack}
            title="Go Back (Cmd+[)"
          >
            ◀
          </button>
          <button
            className="nav-btn"
            onClick={goForward}
            disabled={!canGoForward}
            title="Go Forward (Cmd+])"
          >
            ▶
          </button>
          <button
            className="nav-btn"
            onClick={isLoading ? stop : refresh}
            title={isLoading ? 'Stop' : 'Refresh (Cmd+R)'}
          >
            {isLoading ? '✕' : '↻'}
          </button>
        </div>

        <form className="browser-url-form" onSubmit={handleUrlSubmit}>
          <div className="browser-url-wrapper">
            <input
              ref={urlInputRef}
              type="text"
              className="browser-url-input"
              value={inputUrl}
              onChange={handleUrlInputChange}
              onFocus={handleUrlInputFocus}
              onBlur={handleUrlInputBlur}
              onKeyDown={handleUrlInputKeyDown}
              placeholder="Enter URL or search..."
              title="Focus: Cmd+L"
              autoComplete="off"
            />
            {/* URL Autocomplete Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="browser-url-suggestions" ref={suggestionsRef}>
                {suggestions.map((entry, index) => (
                  <div
                    key={entry.url}
                    className={`browser-url-suggestion ${index === selectedSuggestionIndex ? 'selected' : ''}`}
                    onClick={() => handleSuggestionClick(entry)}
                  >
                    <span className="suggestion-title">{entry.title}</span>
                    <span className="suggestion-url">{entry.url}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </form>

        {/* Error count indicator */}
        {watched && errorCount > 0 && (
          <span className="browser-error-count" title={`${errorCount} console error${errorCount > 1 ? 's' : ''}`}>
            {errorCount}
          </span>
        )}

        {/* Console logs button */}
        <button
          className={`nav-btn console-btn ${showConsolePanel ? 'active' : ''} ${errorCount > 0 ? 'has-errors' : ''}`}
          onClick={() => setShowConsolePanel(!showConsolePanel)}
          title={`Console Logs (${consoleLogsRef.current.length})`}
        >
          {errorCount > 0 ? `⚠️${errorCount}` : '📋'}
        </button>

        {onAskHester && (
          <button
            className={`nav-btn hester-btn ${isCapturing ? 'capturing' : ''}`}
            onClick={handleManualCapture}
            disabled={isCapturing}
            title="Capture Snapshot"
          >
            {isCapturing ? '...' : '🐇'}
          </button>
        )}
      </div>

      {/* Loading indicator */}
      {isLoading && <div className="browser-loading-bar" />}

      {/* Console panel */}
      {showConsolePanel && (
        <div className="browser-console-panel" ref={consolePanelRef}>
          <div className="console-panel-header">
            <span className="console-panel-title">Console ({consoleLogsRef.current.length})</span>
            <button
              className="console-panel-clear"
              onClick={() => {
                consoleLogsRef.current = [];
                setErrorCount(0);
                onErrorCountChange?.(0);
                setLogUpdateCounter((c) => c + 1);
              }}
              title="Clear console"
            >
              Clear
            </button>
          </div>
          <div className="console-panel-logs">
            {consoleLogsRef.current.length === 0 ? (
              <div className="console-panel-empty">No console logs</div>
            ) : (
              consoleLogsRef.current.map((entry, index) => (
                <div key={index} className={`console-entry console-${entry.level}`}>
                  <span className="console-level">[{entry.level.toUpperCase()}]</span>
                  <span className="console-message">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Webview container */}
      <div className={`browser-content ${showConsolePanel ? 'with-console' : ''}`}>
        <div
          className="browser-webview-wrapper"
          style={castSize ? {
            width: `${castSize.width}px`,
            height: `${castSize.height}px`,
            margin: '0 auto',
            flex: 'none',
          } : {
            width: '100%',
            height: '100%',
            flex: '1',
          }}
        >
          <webview
            ref={webviewRef}
            src={initialUrl || DEFAULT_URL}
            className="browser-webview"
            // Security settings
            partition="persist:browser"
            webpreferences="contextIsolation=yes, sandbox=yes"
          />
        </div>
      </div>
    </div>
  );
};

export default BrowserPane;
