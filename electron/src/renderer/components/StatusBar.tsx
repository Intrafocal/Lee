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
import { MachineStatus } from './MachineStatus';
import { LintStatus } from './lint/LintStatus';
import { Icon, HesterGlyph, type IconName } from './Icon';
import { CopilotStatus } from './copilot/CopilotStatus';
import { HandoffDialog } from './copilot/HandoffDialog';
import type { UseCopilotResult } from '../hooks/useCopilot';
import { offscreenNeeds } from '../lib/copilotAttention';
import './copilot/copilot.css';
import { CockpitModeChip } from './cockpit/CockpitModeChip';


export interface StatusMessage {
  id: string;
  message: string;
  type: 'hint' | 'info' | 'success' | 'warning' | 'error';
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
  onSpyglass?: (machine: any) => void;
  onBridge?: (machine: any) => void;
  copilot: UseCopilotResult;
  /** PTYs with a tab in this window: their state shows on the tab, not here. */
  visiblePtyIds: ReadonlySet<number>;
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
  onSpyglass,
  onBridge,
  copilot,
  visiblePtyIds,
}) => {
  const [time, setTime] = useState(new Date());
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [daemonMenuOpen, setDaemonMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [focusMenuOpen, setFocusMenuOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const hesterButtonRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const daemonMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const isFocused = !!copilot.focus?.active;
  const offscreenCount = copilot.api ? offscreenNeeds(copilot.snapshot?.items, visiblePtyIds).length : 0;

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

  // Close daemon menu (and the focus menu, which shares the same container) when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (daemonMenuRef.current && !daemonMenuRef.current.contains(e.target as Node)) {
        setDaemonMenuOpen(false);
        setFocusMenuOpen(false);
      }
    };

    if (daemonMenuOpen || focusMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [daemonMenuOpen, focusMenuOpen]);

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

  const getTypeIcon = (type: StatusMessage['type']): IconName => {
    switch (type) {
      case 'hint':
        return 'send';
      case 'info':
        return 'info';
      case 'success':
        return 'check';
      case 'warning':
        return 'warning';
      case 'error':
        return 'close';
      default:
        return 'send';
    }
  };

  const getDaemonStatusIndicator = () => {
    switch (daemonStatus) {
      case 'healthy':
        return { dotClass: 'status-dot-running', className: 'daemon-healthy', title: 'Daemon running' };
      case 'unhealthy':
        return { dotClass: 'status-dot-error', className: 'daemon-unhealthy', title: 'Daemon stopped' };
      case 'checking':
        return { dotClass: 'status-dot-starting', className: 'daemon-checking', title: 'Checking daemon...' };
      default:
        return { dotClass: 'status-dot-error', className: 'daemon-unhealthy', title: 'Daemon status unknown' };
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
    if (isFocused) {
      setFocusMenuOpen((v) => !v);
      return;
    }
    if (offscreenCount > 0) {
      setAttentionOpen((v) => !v);
      return;
    }
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
    copilot.api?.logCeremony('status_dismiss');
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
        <CockpitModeChip />
        <div className="status-workspace-container" ref={workspaceMenuRef}>
          <button
            className="status-item status-workspace"
            onClick={onWorkspaceClick}
            onContextMenu={handleWorkspaceContextMenu}
          >
            <span className="status-icon"><Icon name="folder" size={14} /></span>
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
            ref={hesterButtonRef}
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
                  <span className={`status-dot ${indicator.dotClass}`} />
                </span>
              );
            })()}
            {isFocused ? (
              <>
                <span className="status-icon"><Icon name="eye" size={14} /></span>
                <span className="status-text">
                  Focus · {copilot.focus?.quiet_count ?? 0} queued
                  {copilot.focus?.source === 'inferred' ? ' (inferred)' : ''}
                </span>
              </>
            ) : offscreenCount > 0 ? (
              <>
                <span className="status-icon tab-attention-needs"><Icon name="bell" size={14} /></span>
                <span className="status-text status-needs-you">
                  {offscreenCount} {offscreenCount === 1 ? 'needs' : 'need'} you
                </span>
                <span className="status-shortcut status-shortcut-secondary" title="Ask something else">
                  ⌘? Ask Hester
                </span>
              </>
            ) : currentMessage ? (
              <>
                <span className="status-icon"><Icon name={getTypeIcon(currentMessage.type)} size={14} /></span>
                <span className="status-message-text">{currentMessage.message}</span>
                <span className="status-shortcut">⌘/</span>
                <span className="status-shortcut status-shortcut-secondary" title="Ask something else">
                  ⌘? Ask Hester
                </span>
              </>
            ) : (
              <>
                <span className="status-icon"><HesterGlyph size={14} /></span>
                <span className="status-text">Ask Hester</span>
                <span className="status-shortcut">⌘? or ⌘/</span>
              </>
            )}
          </button>

          {/* Daemon context menu */}
          {daemonMenuOpen && !isFocused && (
            <div className="daemon-context-menu">
              {copilot.api && (
                <>
                  <button onClick={() => { setDaemonMenuOpen(false); setAttentionOpen(true); }}>
                    Waiting items…
                  </button>
                  <button onClick={() => { setDaemonMenuOpen(false); void copilot.api?.focusStart(); }}>
                    Start focus
                  </button>
                  <button onClick={() => { setDaemonMenuOpen(false); setCaptureOpen(true); }}>
                    Capture idea…
                  </button>
                  <button onClick={() => { setDaemonMenuOpen(false); setHandoffOpen(true); }}>
                    Hand off…
                  </button>
                  <div className="context-menu-separator" />
                </>
              )}
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

          {/* Focus menu (replaces the daemon menu while focus is active) */}
          {focusMenuOpen && isFocused && (
            <div className="daemon-context-menu">
              <button
                onClick={() => {
                  setFocusMenuOpen(false);
                  void copilot.api?.focusStop();
                }}
              >
                Stop focus
              </button>
              <button
                onClick={() => {
                  setFocusMenuOpen(false);
                  setHandoffOpen(true);
                }}
              >
                Stop and hand off…
              </button>
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
              <span className="badge-arrow"><Icon name={flyoutOpen ? 'chevron-up' : 'chevron-down'} size={12} /></span>
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
        <LintStatus workspace={workspace} />
        <CopilotStatus
          workspace={workspace}
          copilot={copilot}
          onOpenHandoff={() => setHandoffOpen(true)}
          attentionOpen={attentionOpen}
          onAttentionClose={() => setAttentionOpen(false)}
          anchorRef={hesterButtonRef}
          captureOpen={captureOpen}
          onOpenCapture={() => setCaptureOpen(true)}
          onCaptureClose={() => setCaptureOpen(false)}
        />
        {onSpyglass && onBridge && (
          <MachineStatus onSpyglass={onSpyglass} onBridge={onBridge} />
        )}
        <span className="status-item">
          <span className="status-text">{formatTime(time)}</span>
        </span>
      </div>

      {handoffOpen && copilot.api && (
        <HandoffDialog
          api={copilot.api}
          workspace={workspace}
          onClose={() => setHandoffOpen(false)}
          onLaunched={() => setHandoffOpen(false)}
        />
      )}
    </div>
  );
};

export default StatusBar;
