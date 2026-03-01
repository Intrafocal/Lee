/**
 * CommandPalette - Hester AI quick query modal
 *
 * Triggered by Cmd+/ anywhere in Lee. Connects to the Hester daemon
 * via SSE streaming to show real-time ReAct processing.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

const HESTER_DAEMON_PORT = 9000;

// Phase display names and icons
const PHASE_DISPLAY: Record<string, { icon: string; label: string }> = {
  preparing: { icon: '🔧', label: 'Preparing' },
  thinking: { icon: '🤔', label: 'Thinking' },
  acting: { icon: '⚡', label: 'Acting' },
  observing: { icon: '👁️', label: 'Observing' },
  responding: { icon: '💬', label: 'Responding' },
};

interface PhaseEvent {
  phase: string;
  iteration: number;
  tool_name?: string;
  tool_context?: string;
  model_used?: string;
  is_local?: boolean;
  tools_selected?: number;
  prepare_time_ms?: number;
}

interface ResponseEvent {
  session_id: string;
  status: string;
  text?: string;
  iterations?: number;
  tools_used?: string[];
  thinking_depth?: string;
  model_used?: string;
}

// Tab info for context awareness
interface TabInfo {
  id: number;
  type: string;
  label: string;
  dockPosition: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAsTab: (sessionId: string) => void;
  workspace: string;
  tabs?: TabInfo[];
  activeTabId?: number | null;
  focusedPanel?: string;
  initialPrompt?: string | null;
  autoSubmit?: boolean; // If true (default), auto-submit initialPrompt; if false, just pre-populate
  onPromptConsumed?: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onOpenAsTab,
  workspace,
  tabs = [],
  activeTabId = null,
  focusedPanel = 'center',
  initialPrompt = null,
  autoSubmit = true,
  onPromptConsumed,
}) => {
  const [query, setQuery] = useState('');
  const hasAutoSubmittedRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [phases, setPhases] = useState<PhaseEvent[]>([]);
  const [viewingIndex, setViewingIndex] = useState<number>(-1); // -1 means latest
  const [response, setResponse] = useState<ResponseEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDaemonHealthy, setIsDaemonHealthy] = useState<boolean | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string>(`palette-${Date.now()}`);

  // Check daemon health on mount
  useEffect(() => {
    if (isOpen) {
      checkDaemonHealth();
      // Focus input when opened
      setTimeout(() => inputRef.current?.focus(), 50);
      // Reset auto-submit flag when opened
      hasAutoSubmittedRef.current = false;
    }
  }, [isOpen]);

  // Handle initial prompt - auto-submit when provided (if autoSubmit is true)
  useEffect(() => {
    if (isOpen && initialPrompt && !hasAutoSubmittedRef.current && isDaemonHealthy !== false) {
      hasAutoSubmittedRef.current = true;
      setQuery(initialPrompt);
      // Notify that we consumed the prompt
      if (onPromptConsumed) {
        onPromptConsumed();
      }
      // Only auto-submit if autoSubmit is true
      if (autoSubmit) {
        setTimeout(() => {
          submitQuery(initialPrompt);
        }, 100);
      }
    }
  }, [isOpen, initialPrompt, isDaemonHealthy, onPromptConsumed, autoSubmit]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // Reset after animation
      setTimeout(() => {
        setQuery('');
        setPhases([]);
        setViewingIndex(-1);
        setResponse(null);
        setError(null);
        setIsProcessing(false);
        sessionIdRef.current = `palette-${Date.now()}`;
      }, 200);
    }
  }, [isOpen]);

  const checkDaemonHealth = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${HESTER_DAEMON_PORT}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      const data = await response.json();
      setIsDaemonHealthy(data.status === 'healthy');
    } catch {
      setIsDaemonHealthy(false);
    }
  };

  // Core submit logic - can be called with any query string
  const submitQuery = useCallback(async (queryText: string) => {
    if (!queryText.trim() || isProcessing) return;

    // Reset state for new query
    setPhases([]);
    setViewingIndex(-1);
    setResponse(null);
    setError(null);
    setIsProcessing(true);

    // Create new abort controller
    abortControllerRef.current = new AbortController();

    try {
      // Find the active tab to determine current context
      const activeTab = tabs.find(t => t.id === activeTabId);
      const openFiles = tabs
        .filter(t => t.type === 'editor')
        .map(t => t.label);

      const requestBody = {
        session_id: sessionIdRef.current,
        source: 'Lee' as const,
        message: queryText.trim(),
        editor_state: {
          working_directory: workspace || process.cwd?.() || '.',
          open_files: openFiles,
          active_file: activeTab?.type === 'editor' ? activeTab.label : null,
        },
        // Additional context for Hester
        lee_context: {
          focused_panel: focusedPanel,
          active_tab: activeTab ? {
            id: activeTab.id,
            type: activeTab.type,
            label: activeTab.label,
          } : null,
          tabs: tabs.map(t => ({
            id: t.id,
            type: t.type,
            label: t.label,
            dock_position: t.dockPosition,
          })),
        },
      };

      const fetchResponse = await fetch(
        `http://127.0.0.1:${HESTER_DAEMON_PORT}/context/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(requestBody),
          signal: abortControllerRef.current.signal,
        }
      );

      if (!fetchResponse.ok) {
        throw new Error(`HTTP ${fetchResponse.status}: ${fetchResponse.statusText}`);
      }

      // Read the SSE stream
      const reader = fetchResponse.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            // End of event, process it
            try {
              const data = JSON.parse(currentData);

              switch (currentEvent) {
                case 'phase':
                  setPhases((prev) => [...prev, data as PhaseEvent]);
                  setViewingIndex(-1); // Always show latest during processing
                  break;
                case 'response':
                  setResponse(data as ResponseEvent);
                  break;
                case 'error':
                  setError(data.error || 'Unknown error');
                  break;
                case 'done':
                  // Processing complete
                  break;
              }
            } catch (parseError) {
              console.error('Failed to parse SSE data:', parseError, currentData);
            }

            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Request was cancelled, don't show error
        return;
      }
      console.error('Command palette error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect to Hester');
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, workspace, tabs, activeTabId, focusedPanel]);

  // Form submit handler - uses current query state
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    await submitQuery(query);
  }, [query, submitQuery]);

  const handleOpenAsTab = useCallback(() => {
    if (response?.session_id) {
      onOpenAsTab(response.session_id);
      onClose();
    }
  }, [response, onOpenAsTab, onClose]);

  // Handle keyboard shortcuts (Escape to close, Cmd+Enter to open as tab)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // Cmd+Enter to open as Hester tab (when response is available)
      if (e.key === 'Enter' && e.metaKey && response && !error) {
        e.preventDefault();
        e.stopPropagation();
        handleOpenAsTab();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen, onClose, response, error, handleOpenAsTab]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        {/* Header with input */}
        <form onSubmit={handleSubmit} className="command-palette-header">
          <span className="command-palette-icon">🐇</span>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder={
              isDaemonHealthy === false
                ? 'Hester daemon not running...'
                : 'Ask Hester anything...'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={isProcessing || isDaemonHealthy === false}
          />
          <kbd className="command-palette-shortcut">⌘/</kbd>
        </form>

        {/* Daemon status warning */}
        {isDaemonHealthy === false && (
          <div className="command-palette-warning">
            <span>⚠️</span>
            <span>Hester daemon is not running. Start it with: <code>hester daemon start</code></span>
          </div>
        )}

        {/* Phase indicator with navigation */}
        {phases.length > 0 && (
          <div className="command-palette-phases">
            {(() => {
              const displayIndex = viewingIndex === -1 ? phases.length - 1 : viewingIndex;
              const currentPhase = phases[displayIndex];
              const canGoBack = displayIndex > 0;
              const canGoForward = displayIndex < phases.length - 1;
              const isViewingLatest = viewingIndex === -1 || viewingIndex === phases.length - 1;

              return (
                <>
                  <div className={`command-palette-phase ${currentPhase.phase}`}>
                    <span className="phase-icon">
                      {PHASE_DISPLAY[currentPhase.phase]?.icon || '•'}
                    </span>
                    <span className="phase-label">
                      {PHASE_DISPLAY[currentPhase.phase]?.label || currentPhase.phase}
                    </span>
                    {currentPhase.tool_name && (
                      <span className="phase-tool">{currentPhase.tool_name}</span>
                    )}
                    {currentPhase.tool_context && (
                      <span className="phase-context">{currentPhase.tool_context}</span>
                    )}
                    {currentPhase.is_local && (
                      <span className="phase-local">LOCAL</span>
                    )}
                    {currentPhase.iteration > 1 && (
                      <span className="phase-iteration">iter {currentPhase.iteration}</span>
                    )}
                  </div>
                  {phases.length > 1 && (
                    <div className="phase-nav">
                      <button
                        className="phase-nav-btn"
                        onClick={() => setViewingIndex(displayIndex - 1)}
                        disabled={!canGoBack}
                        title="Previous phase"
                      >
                        ‹
                      </button>
                      <span className="phase-nav-counter">
                        {displayIndex + 1}/{phases.length}
                      </span>
                      <button
                        className="phase-nav-btn"
                        onClick={() => setViewingIndex(isViewingLatest ? -1 : displayIndex + 1)}
                        disabled={!canGoForward}
                        title="Next phase"
                      >
                        ›
                      </button>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="command-palette-error">
            <span>❌</span>
            <span>{error}</span>
          </div>
        )}

        {/* Response display */}
        {response?.text && (
          <div className="command-palette-response">
            <div className="response-content">
              {response.text}
            </div>
            {response.iterations !== undefined && (
              <div className="response-meta">
                <span>{response.iterations} iterations</span>
                {response.tools_used && response.tools_used.length > 0 && (
                  <span>{response.tools_used.length} tools</span>
                )}
                {response.thinking_depth && (
                  <span className="response-depth">{response.thinking_depth}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer with actions */}
        {(response || error) && (
          <div className="command-palette-footer">
            <button className="command-palette-btn secondary" onClick={onClose}>
              Dismiss
              <kbd>Esc</kbd>
            </button>
            {response && !error && (
              <button className="command-palette-btn primary" onClick={handleOpenAsTab}>
                Open as Hester Tab
                <kbd>⌘⏎</kbd>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
