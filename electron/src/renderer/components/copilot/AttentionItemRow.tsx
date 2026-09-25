/**
 * AttentionItemRow - one row of the attention flyout or blocking banner.
 * Renders title, source, age, the agent's own words, and inline actions per
 * `item.actions` (contracts §5.1, §9.1).
 */

import React, { useState } from 'react';
import { Icon } from '../Icon';
import type { AttentionItem, CopilotAPI } from '../../../shared/copilot';

interface AttentionItemRowProps {
  item: AttentionItem;
  api: CopilotAPI;
  /** Collapses the row to a single line where the banner needs to stay compact. */
  compact?: boolean;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function workspaceBasename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const AttentionItemRow: React.FC<AttentionItemRowProps> = ({ item, api, compact }) => {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (!result.success) setError(result.error || 'failed');
    } catch {
      setError('failed');
    } finally {
      setBusy(false);
    }
  };

  const sendReply = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void run(() => api.reply(item.id, { action: 'text', text: trimmed, version: item.version })).then(() => {
      setReplying(false);
      setText('');
    });
  };

  const meta = [item.source.tab_label, workspaceBasename(item.source.workspace)].filter(Boolean).join(' · ');
  const hasWake = item.actions.includes('wake');

  return (
    <div className={`copilot-item severity-${item.severity}`}>
      <div className="copilot-item-head">
        <span className="copilot-item-title">{item.title}</span>
        <span className="copilot-item-age">{formatAge(item.created_at)}</span>
      </div>
      {meta && <div className="copilot-item-meta">{meta}</div>}
      {!compact && item.text && (
        <div className="copilot-item-text">
          <span className="copilot-item-text-label">Claude:</span>
          {item.text}
        </div>
      )}
      <div className="copilot-item-actions">
        {item.actions.includes('approve') && (
          <button
            className="copilot-item-btn copilot-item-btn-approve"
            disabled={busy}
            onClick={() => run(() => api.reply(item.id, { action: 'approve', version: item.version }))}
          >
            <Icon name="check" size={12} /> Approve
          </button>
        )}
        {item.actions.includes('deny') && (
          <button
            className="copilot-item-btn copilot-item-btn-deny"
            disabled={busy}
            onClick={() => run(() => api.reply(item.id, { action: 'deny', version: item.version }))}
          >
            <Icon name="close" size={12} /> Deny
          </button>
        )}
        {item.actions.includes('reply') && (
          <button
            className={`copilot-item-btn${replying ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => setReplying((v) => !v)}
          >
            <Icon name="send" size={12} /> Reply…
          </button>
        )}
        {item.actions.includes('open') && (
          <button className="copilot-item-btn" disabled={busy} onClick={() => run(() => api.openItem(item.id))}>
            <Icon name="external" size={12} /> Open
          </button>
        )}
        {item.actions.includes('snooze') && (
          <div style={{ position: 'relative' }}>
            <button className="copilot-item-btn" disabled={busy} onClick={() => setSnoozeOpen((v) => !v)}>
              <Icon name="clock" size={12} /> Snooze
            </button>
            {snoozeOpen && (
              <div className="copilot-item-snooze-menu">
                <button
                  onClick={() => {
                    setSnoozeOpen(false);
                    void run(() => api.snooze(item.id, { minutes: 15 }));
                  }}
                >
                  15 minutes
                </button>
                <button
                  onClick={() => {
                    setSnoozeOpen(false);
                    void run(() => api.snooze(item.id, { minutes: 60 }));
                  }}
                >
                  1 hour
                </button>
                <button
                  onClick={() => {
                    setSnoozeOpen(false);
                    void run(() => api.snooze(item.id, { until: 'change' }));
                  }}
                >
                  Until it changes
                </button>
              </div>
            )}
          </div>
        )}
        {item.actions.includes('dismiss') && (
          <button className="copilot-item-btn" disabled={busy} onClick={() => run(() => api.dismiss(item.id))}>
            <Icon name="trash" size={12} /> Dismiss
          </button>
        )}
        {hasWake && (
          <button
            className={`copilot-item-btn${item.wake ? ' is-active' : ''}`}
            disabled={busy}
            onClick={() => run(() => api.setWake(item.id, !item.wake))}
            title="Wake me for this while away"
          >
            <Icon name="bell" size={12} /> {item.wake ? 'Waking' : 'Wake me'}
          </button>
        )}
      </div>
      {replying && (
        <div className="copilot-item-reply">
          <textarea
            autoFocus
            value={text}
            placeholder="Reply to Claude…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendReply();
              }
            }}
          />
          <div className="copilot-item-actions">
            <button className="copilot-item-btn is-active" disabled={busy || !text.trim()} onClick={sendReply}>
              <Icon name="send" size={12} /> Send
            </button>
            <button
              className="copilot-item-btn"
              disabled={busy}
              onClick={() => {
                setReplying(false);
                setText('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="copilot-item-error">{error}</div>}
    </div>
  );
};

export default AttentionItemRow;
