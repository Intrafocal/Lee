/**
 * StatusBar Component - Bottom status bar with workspace, Hester hints, and time.
 *
 * Features:
 * - Shows current Hester hint/message when available
 * - Badge showing message queue count with flyout drawer
 * - Click or ⌘/ to send prompt immediately (if message has prompt)
 * - ⌘? (⌘⇧/) to open blank palette
 * - Daemon status indicator with context menu for start/stop/restart
 */

import React, { useEffect, useState, useRef } from 'react';

const lee = (window as any).lee;

export interface StatusMessage {
  id: string;
  message: string;
  type: 'hint' | 'info' | 'success' | 'warning';
  prompt?: string;
  ttl?: number;
  timestamp: number;
}

export type DaemonStatus = 'healthy' | 'unhealthy' | 'checking';

interface StatusBarProps {
  workspace: string;
  messages: StatusMessage[];
  daemonStatus: DaemonStatus;
  onWorkspaceClick?: () => void;
  onEditConfig?: () => void;
  onReloadConfig?: () => void;
  onHesterClick?: () => void;
  onMessageClick?: (message: StatusMessage) => void;
  onClearMessage?: (id: string) => void;
  onDaemonAction?: (action: 'start' | 'stop' | 'restart') => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  workspace,
  messages,
  daemonStatus,
  onWorkspaceClick,
  onEditConfig,
  onReloadConfig,
  onHesterClick,
  onMessageClick,
  onClearMessage,
  onDaemonAction,
}) => {
  const [time, setTime] = useState(new Date());
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [daemonMenuOpen, setDaemonMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const daemonMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  // Get the most recent message
  const currentMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  // Update time every minute
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Close flyout when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (flyoutRef.current && !flyoutRef.current.contains(e.target as Node)) {
        setFlyoutOpen(false);
      }
    };

    if (flyoutOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [flyoutOpen]);

  // Close daemon menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (daemonMenuRef.current && !daemonMenuRef.current.contains(e.target as Node)) {
        setDaemonMenuOpen(false);
      }
    };

    if (daemonMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [daemonMenuOpen]);

  // Close workspace menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };

    if (workspaceMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [workspaceMenuOpen]);

  const handleWorkspaceContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setWorkspaceMenuOpen(true);
  };

  const handleEditConfig = () => {
    setWorkspaceMenuOpen(false);
    if (onEditConfig) {
      onEditConfig();
    }
  };

  const handleReloadConfig = () => {
    setWorkspaceMenuOpen(false);
    if (onReloadConfig) {
      onReloadConfig();
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatWorkspace = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  const getTypeIcon = (type: StatusMessage['type']) => {
    switch (type) {
      case 'hint':
        return '💬';
      case 'info':
        return 'ℹ️';
      case 'success':
        return '✓';
      case 'warning':
        return '⚠️';
      default:
        return '💬';
    }
  };

  const getDaemonStatusIndicator = () => {
    switch (daemonStatus) {
      case 'healthy':
        return { symbol: '●', className: 'daemon-healthy', title: 'Daemon running' };
      case 'unhealthy':
        return { symbol: '○', className: 'daemon-unhealthy', title: 'Daemon stopped' };
      case 'checking':
        return { symbol: '◐', className: 'daemon-checking', title: 'Checking daemon...' };
      default:
        return { symbol: '○', className: 'daemon-unhealthy', title: 'Daemon status unknown' };
    }
  };

  const handleDaemonContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDaemonMenuOpen(true);
  };

  const handleDaemonMenuAction = (action: 'start' | 'stop' | 'restart') => {
    setDaemonMenuOpen(false);
    if (onDaemonAction) {
      onDaemonAction(action);
    }
  };

  const handleHesterClick = () => {
    if (currentMessage && onMessageClick) {
      onMessageClick(currentMessage);
    } else if (onHesterClick) {
      onHesterClick();
    }
  };

  const handleBadgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFlyoutOpen(!flyoutOpen);
  };

  const handleFlyoutMessageClick = (message: StatusMessage) => {
    setFlyoutOpen(false);
    if (onMessageClick) {
      onMessageClick(message);
    }
  };

  const handleDismiss = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (onClearMessage) {
      onClearMessage(id);
    }
  };

  const handleClearAll = () => {
    if (onClearMessage) {
      messages.forEach((m) => onClearMessage(m.id));
    }
    setFlyoutOpen(false);
  };

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <div className="status-workspace-container" ref={workspaceMenuRef}>
          <button
            className="status-item status-workspace"
            onClick={onWorkspaceClick}
            onContextMenu={handleWorkspaceContextMenu}
          >
            <span className="status-icon">📁</span>
            <span className="status-text">{formatWorkspace(workspace)}</span>
          </button>

          {/* Workspace context menu */}
          {workspaceMenuOpen && (
            <div className="workspace-context-menu">
              <button onClick={onWorkspaceClick}>
                Change Workspace
              </button>
              <button onClick={handleEditConfig}>
                Edit Config
              </button>
              <button onClick={handleReloadConfig}>
                Reload Config
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="status-bar-center">
        <div className="status-hester-container" ref={daemonMenuRef}>
          <button
            className="status-item status-hester"
            onClick={handleHesterClick}
            onContextMenu={handleDaemonContextMenu}
          >
            {(() => {
              const indicator = getDaemonStatusIndicator();
              return (
                <span
                  className={`daemon-indicator ${indicator.className}`}
                  title={indicator.title}
                >
                  {indicator.symbol}
                </span>
              );
            })()}
            {currentMessage ? (
              <>
                <span className="status-icon">{getTypeIcon(currentMessage.type)}</span>
                <span className="status-message-text">{currentMessage.message}</span>
                <span className="status-shortcut">⌘/</span>
                <span className="status-shortcut status-shortcut-secondary" title="Ask something else">
                  ⌘? Ask Hester
                </span>
              </>
            ) : (
              <>
                <span className="status-icon">🐇</span>
                <span className="status-text">Ask Hester</span>
                <span className="status-shortcut">⌘? or ⌘/</span>
              </>
            )}
          </button>

          {/* Daemon context menu */}
          {daemonMenuOpen && (
            <div className="daemon-context-menu">
              {daemonStatus === 'unhealthy' ? (
                <button onClick={() => handleDaemonMenuAction('start')}>
                  Start Daemon
                </button>
              ) : (
                <>
                  <button onClick={() => handleDaemonMenuAction('restart')}>
                    Restart Daemon
                  </button>
                  <button onClick={() => handleDaemonMenuAction('stop')}>
                    Stop Daemon
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {messages.length > 0 && (
          <div className="status-badge-container" ref={flyoutRef}>
            <button
              className="status-badge"
              onClick={handleBadgeClick}
              title={`${messages.length} message${messages.length > 1 ? 's' : ''}`}
            >
              {messages.length}
              <span className="badge-arrow">{flyoutOpen ? '▲' : '▼'}</span>
            </button>

            {flyoutOpen && (
              <div className="status-flyout">
                <div className="flyout-header">
                  <span>Messages</span>
                  <button className="flyout-clear-all" onClick={handleClearAll}>
                    Clear all
                  </button>
                </div>
                <div className="flyout-messages">
                  {[...messages].reverse().map((msg) => (
                    <div
                      key={msg.id}
                      className={`flyout-message flyout-message-${msg.type}`}
                      onClick={() => handleFlyoutMessageClick(msg)}
                    >
                      <span className="flyout-message-icon">{getTypeIcon(msg.type)}</span>
                      <span className="flyout-message-text">{msg.message}</span>
                      <button
                        className="flyout-message-dismiss"
                        onClick={(e) => handleDismiss(e, msg.id)}
                        title="Dismiss"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="status-bar-right">
        <span className="status-item">
          <span className="status-text">{formatTime(time)}</span>
        </span>
      </div>
    </div>
  );
};

export default StatusBar;
