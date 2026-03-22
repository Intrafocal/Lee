/**
 * SpyglassPane - View and control a remote Lee instance.
 *
 * Connects via WebSocket to remote Lee's /context/stream.
 * Renders remote tabs as a tab row; clicking a tab shows its PTY output
 * via /pty/:id/stream WebSocket. Dashboard shown when no tab is selected.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

interface AvailableTui {
  command: string;
  name: string;
  icon?: string;
  shortcut?: string;
}

interface RemoteTab {
  id: number;
  type: string;
  label: string;
  ptyId: number | null;
  state: string;
}

interface RemoteContext {
  workspace: string;
  tabs: RemoteTab[];
  focusedPanel: string;
  editor: {
    file: string | null;
    language: string | null;
    cursor: { line: number; column: number };
    modified: boolean;
  } | null;
  activity: {
    idleSeconds: number;
    sessionDuration: number;
    recentActions: Array<{ type: string; target: string; timestamp: number }>;
  };
  availableTuis?: Record<string, AvailableTui>;
  timestamp: number;
}

interface SpyglassPaneProps {
  active: boolean;
  machineConfig: {
    name: string;
    emoji: string;
    host: string;
    lee_port: number;
  };
}

const TAB_TYPE_ICONS: Record<string, string> = {
  terminal: '💻',
  editor: '📝',
  'editor-panel': '📝',
  file: '📄',
  files: '📂',
  browser: '🌐',
  hester: '🐇',
  claude: '🤖',
  git: '🌿',
  docker: '🐳',
  library: '📚',
  workstream: '📋',
  spyglass: '🔭',
  bridge: '🌉',
};

/**
 * Inline terminal component that connects to a remote PTY via WebSocket.
 */
const SpyglassTerminal: React.FC<{
  host: string;
  port: number;
  ptyId: number;
  active: boolean;
}> = ({ host, port, ptyId, active }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initialize terminal and WebSocket
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Noto Color Emoji, Menlo, Monaco, Courier New, monospace',
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
      scrollOnUserInput: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    try {
      const webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => webglAddon.dispose());
    } catch {
      // WebGL not available, canvas fallback
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket to remote PTY
    const url = `ws://${host}:${port}/pty/${ptyId}/stream`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Fit after connection so we can send initial resize
      requestAnimationFrame(() => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        }
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'data') {
          terminal.write(msg.data);
        } else if (msg.type === 'exit') {
          terminal.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      terminal.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
    };

    // Forward terminal input to remote PTY
    const inputDisposable = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resizes
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!fitAddonRef.current || !terminalRef.current) return;
        fitAddonRef.current.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'resize',
            cols: terminalRef.current.cols,
            rows: terminalRef.current.rows,
          }));
        }
      }, 50);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      clearTimeout(resizeTimeout);
      inputDisposable.dispose();
      ws.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  }, [host, port, ptyId]);

  // Focus terminal when active
  useEffect(() => {
    if (active && terminalRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      }, 50);
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="spyglass-terminal"
    />
  );
};

/** Tab types that have no PTY and no special viewer — show a summary instead. */
const NON_RENDERABLE_TABS = new Set(['files', 'editor-panel', 'library', 'workstream']);

/**
 * Inline browser viewer that connects to a remote browser tab's CDP screencast
 * via /browser/:tabId/cast WebSocket (same protocol Aeronaut uses).
 */
const SpyglassBrowserViewer: React.FC<{
  host: string;
  port: number;
  tabId: number;
}> = ({ host, port, tabId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [browserMeta, setBrowserMeta] = useState<{ url?: string; title?: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const viewportRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    const url = `ws://${host}:${port}/browser/${tabId}/cast`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setConnected(true);
      // Send init with container dimensions
      const rect = containerRef.current!.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      viewportRef.current = { width, height };
      ws.send(JSON.stringify({
        type: 'init',
        width,
        height,
        pixelRatio: window.devicePixelRatio || 2,
      }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary JPEG frame
        const blob = new Blob([event.data], { type: 'image/jpeg' });
        const newUrl = URL.createObjectURL(blob);
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = newUrl;
        if (imgRef.current) {
          imgRef.current.src = newUrl;
        }
      } else {
        // JSON metadata
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'metadata') {
            setBrowserMeta({ url: msg.url, title: msg.title });
            if (msg.viewportWidth && msg.viewportHeight) {
              viewportRef.current = { width: msg.viewportWidth, height: msg.viewportHeight };
            }
          }
        } catch {
          // ignore
        }
      }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const rect = containerRef.current.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      viewportRef.current = { width, height };
      wsRef.current.send(JSON.stringify({
        type: 'resize',
        width,
        height,
        pixelRatio: window.devicePixelRatio || 2,
      }));
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      wsRef.current = null;
    };
  }, [host, port, tabId]);

  // Click handler — normalize to 0-1 coords
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!imgRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    wsRef.current.send(JSON.stringify({ type: 'tap', x, y }));
  }, []);

  // Scroll handler
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!imgRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    wsRef.current.send(JSON.stringify({
      type: 'scroll',
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    }));
  }, []);

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    e.preventDefault();
    if (e.key.length === 1) {
      wsRef.current.send(JSON.stringify({ type: 'key', text: e.key }));
    } else {
      wsRef.current.send(JSON.stringify({ type: 'key', key: e.key, code: e.code }));
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="spyglass-browser-viewer"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {browserMeta?.url && (
        <div className="spyglass-browser-url-bar">
          <span className={`spyglass-browser-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? '●' : '○'}
          </span>
          <span className="spyglass-browser-url">{browserMeta.url}</span>
        </div>
      )}
      <img
        ref={imgRef}
        className="spyglass-browser-frame"
        onClick={handleClick}
        onWheel={handleWheel}
        draggable={false}
        alt={browserMeta?.title || 'Remote browser'}
      />
      {!connected && (
        <div className="spyglass-browser-disconnected">
          Browser tab not available for casting
        </div>
      )}
    </div>
  );
};

/**
 * Summary view for tabs that can't be rendered remotely
 * (files, editor-panel, spyglass-of-spyglass, etc.)
 */
const SpyglassTabSummary: React.FC<{
  tab: RemoteTab;
  context: RemoteContext;
}> = ({ tab, context }) => {
  if (tab.type === 'spyglass') {
    return (
      <div className="spyglass-tab-summary">
        <div className="spyglass-tab-summary-icon">🔭</div>
        <div className="spyglass-tab-summary-title">Spyglass: {tab.label}</div>
        <div className="spyglass-tab-summary-desc">
          This tab is viewing another machine. Open a direct Spyglass tab to view that machine.
        </div>
      </div>
    );
  }

  if (tab.type === 'editor-panel' && context.editor?.file) {
    return (
      <div className="spyglass-tab-summary">
        <div className="spyglass-tab-summary-icon">📝</div>
        <div className="spyglass-tab-summary-title">
          {context.editor.file.split('/').pop()}
          {context.editor.modified && <span className="spyglass-modified"> ●</span>}
        </div>
        <div className="spyglass-tab-summary-desc">
          {context.editor.language} — Ln {context.editor.cursor.line}, Col {context.editor.cursor.column}
        </div>
      </div>
    );
  }

  return (
    <div className="spyglass-tab-summary">
      <div className="spyglass-tab-summary-icon">{TAB_TYPE_ICONS[tab.type] || '🔧'}</div>
      <div className="spyglass-tab-summary-title">{tab.label}</div>
      <div className="spyglass-tab-summary-desc">
        This tab type cannot be viewed remotely.
      </div>
    </div>
  );
};

export const SpyglassPane: React.FC<SpyglassPaneProps> = ({ active, machineConfig }) => {
  const [context, setContext] = useState<RemoteContext | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTuiPicker, setShowTuiPicker] = useState(false);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    const url = `ws://${machineConfig.host}:${machineConfig.lee_port}/context/stream`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'context_update' && msg.data) {
            setContext(msg.data);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setError(`Cannot reach ${machineConfig.name}`);
      };
    } catch {
      setError(`Failed to connect to ${machineConfig.name}`);
    }
  }, [machineConfig]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect]);

  const sendCommand = useCallback(async (domain: string, action: string, params: any = {}) => {
    try {
      const url = `http://${machineConfig.host}:${machineConfig.lee_port}/command`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, action, params }),
      });
    } catch (err) {
      console.error('[Spyglass] Command failed:', err);
    }
  }, [machineConfig]);

  const handleTabClick = useCallback((tabId: number) => {
    // Toggle: click active tab again to deselect
    setSelectedTabId(prev => prev === tabId ? null : tabId);
    setShowTuiPicker(false);
  }, []);

  const spawnRemoteTui = useCallback((tuiKey: string) => {
    sendCommand('tui', tuiKey, {});
    setShowTuiPicker(false);
    // Auto-select will happen when the new tab appears in the next context update
    // We track the current tab count to detect the new tab
  }, [sendCommand]);

  // Auto-select newly spawned tabs
  const prevTabCountRef = useRef<number>(0);
  useEffect(() => {
    if (!context) return;
    const currentCount = context.tabs.length;
    if (currentCount > prevTabCountRef.current && prevTabCountRef.current > 0) {
      // A new tab appeared — select it
      const newTab = context.tabs[context.tabs.length - 1];
      if (newTab) {
        setSelectedTabId(newTab.id);
      }
    }
    prevTabCountRef.current = currentCount;
  }, [context?.tabs.length]);

  // Clear selection if the selected tab disappears
  useEffect(() => {
    if (selectedTabId !== null && context) {
      const exists = context.tabs.some(t => t.id === selectedTabId);
      if (!exists) {
        setSelectedTabId(null);
      }
    }
  }, [context, selectedTabId]);

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const formatIdle = (seconds: number): string => {
    if (seconds < 10) return 'active';
    return `idle ${formatDuration(seconds)}`;
  };

  const selectedTab = context?.tabs.find(t => t.id === selectedTabId) || null;

  return (
    <div className="spyglass-pane" style={{ display: active ? 'flex' : 'none' }}>
      {/* Header row: machine info + tabs */}
      <div className="spyglass-header">
        <span className="spyglass-machine-emoji">{machineConfig.emoji}</span>
        <span className="spyglass-machine-name">{machineConfig.name}</span>
        <span className={`spyglass-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? '●' : '○'}
        </span>
        {context && (
          <span className="spyglass-idle">{formatIdle(context.activity.idleSeconds)}</span>
        )}
      </div>

      {error && !connected && (
        <div className="spyglass-error">{error}</div>
      )}

      {context && (
        <>
          <div className="spyglass-workspace">
            {context.workspace.split('/').pop()}
          </div>

          {/* Tab row - always visible */}
          <div className="spyglass-tabs">
            {context.tabs.map(tab => (
              <div
                key={tab.id}
                className={`spyglass-tab ${selectedTabId === tab.id ? 'selected' : ''} ${tab.state === 'active' ? 'active' : ''}`}
                onClick={() => handleTabClick(tab.id)}
                title={tab.label}
              >
                <span className="spyglass-tab-icon">
                  {TAB_TYPE_ICONS[tab.type] || '🔧'}
                </span>
                <span className="spyglass-tab-label">{tab.label}</span>
              </div>
            ))}
            <div
              className="spyglass-tab spyglass-tab-add"
              onClick={() => setShowTuiPicker(!showTuiPicker)}
              title="Spawn new tab"
            >
              <span className="spyglass-tab-icon">+</span>
            </div>
          </div>

          {showTuiPicker && context.availableTuis && (
            <div className="spyglass-tui-picker">
              <div
                className="spyglass-tui-option"
                onClick={() => spawnRemoteTui('terminal')}
              >
                <span className="spyglass-tui-icon">💻</span>
                <span className="spyglass-tui-name">Terminal</span>
              </div>
              {Object.entries(context.availableTuis).map(([key, tui]) => (
                <div
                  key={key}
                  className="spyglass-tui-option"
                  onClick={() => spawnRemoteTui(key)}
                >
                  <span className="spyglass-tui-icon">{tui.icon || TAB_TYPE_ICONS[key] || '🔧'}</span>
                  <span className="spyglass-tui-name">{tui.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Content area: terminal, browser, summary, or dashboard */}
          {selectedTab && selectedTab.type === 'browser' ? (
            <SpyglassBrowserViewer
              key={selectedTabId}
              host={machineConfig.host}
              port={machineConfig.lee_port}
              tabId={selectedTab.id}
            />
          ) : selectedTab && (selectedTab.type === 'spyglass' || NON_RENDERABLE_TABS.has(selectedTab.type)) ? (
            <SpyglassTabSummary
              key={selectedTabId}
              tab={selectedTab}
              context={context}
            />
          ) : selectedTab && selectedTab.ptyId != null ? (
            <SpyglassTerminal
              key={selectedTabId}
              host={machineConfig.host}
              port={machineConfig.lee_port}
              ptyId={selectedTab.ptyId}
              active={active}
            />
          ) : selectedTab ? (
            <SpyglassTabSummary
              key={selectedTabId}
              tab={selectedTab}
              context={context}
            />
          ) : (
            <div className="spyglass-dashboard">
              {context.editor?.file && (
                <div className="spyglass-editor">
                  <div className="spyglass-editor-file">
                    {context.editor.file.split('/').pop()}
                    {context.editor.modified && <span className="spyglass-modified"> ●</span>}
                  </div>
                  <div className="spyglass-editor-meta">
                    {context.editor.language} — Ln {context.editor.cursor.line}, Col {context.editor.cursor.column}
                  </div>
                </div>
              )}

              <div className="spyglass-activity">
                <div className="spyglass-section-label">Recent Activity</div>
                {context.activity.recentActions.slice(-5).reverse().map((action, i) => (
                  <div key={i} className="spyglass-action">
                    <span className="spyglass-action-type">{action.type}</span>
                    <span className="spyglass-action-target">{action.target}</span>
                  </div>
                ))}
                {context.activity.recentActions.length === 0 && (
                  <div className="spyglass-action spyglass-no-activity">No recent activity</div>
                )}
              </div>

              <div className="spyglass-session">
                Session: {formatDuration(context.activity.sessionDuration)}
              </div>
            </div>
          )}
        </>
      )}

      {!context && connected && (
        <div className="spyglass-loading">Waiting for context...</div>
      )}

      {!connected && !error && (
        <div className="spyglass-loading">Connecting...</div>
      )}
    </div>
  );
};
