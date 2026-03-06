/**
 * SpyglassPane - View and control a remote Lee instance.
 *
 * Connects via WebSocket to remote Lee's /context/stream.
 * Renders remote tabs, editor state, and activity.
 * Click remote tabs to focus them on the remote machine.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';

interface AvailableTui {
  command: string;
  name: string;
  icon?: string;
  shortcut?: string;
}

interface RemoteContext {
  workspace: string;
  tabs: Array<{
    id: number;
    type: string;
    label: string;
    state: string;
  }>;
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

export const SpyglassPane: React.FC<SpyglassPaneProps> = ({ active, machineConfig }) => {
  const [context, setContext] = useState<RemoteContext | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTuiPicker, setShowTuiPicker] = useState(false);
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

  const focusRemoteTab = useCallback((tabId: number) => {
    sendCommand('system', 'focus_tab', { tab_id: tabId });
  }, [sendCommand]);

  const spawnRemoteTui = useCallback((tuiKey: string) => {
    sendCommand('tui', tuiKey, {});
    setShowTuiPicker(false);
  }, [sendCommand]);

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const formatIdle = (seconds: number): string => {
    if (seconds < 10) return 'active';
    return `idle ${formatDuration(seconds)}`;
  };

  return (
    <div className="spyglass-pane" style={{ display: active ? 'flex' : 'none' }}>
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

          <div className="spyglass-tabs">
            {context.tabs.map(tab => (
              <div
                key={tab.id}
                className={`spyglass-tab ${tab.state === 'active' ? 'active' : ''}`}
                onClick={() => focusRemoteTab(tab.id)}
                title={`Click to focus on ${machineConfig.name}`}
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
