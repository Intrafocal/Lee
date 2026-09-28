/**
 * AttentionItemRow - one row of the attention flyout or blocking banner.
 * Renders title, source, age, the agent's own words, and inline actions per
 * `item.actions` (contracts §5.1, §9.1). Question items show the question and
 * its options instead; a single-select single question can be answered here
 * (pick, see which option will be sent, then Send), anything else is read-only
 * with "Open tab".
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import type { AttentionItem, CopilotAPI } from '../../../shared/copilot';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { MicButton } from '../voice/MicButton';

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
  /** Question items: the option picked but not sent yet. */
  const [picked, setPicked] = useState<number | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  /** The reply came from the mic (§5.3): tag it `input: 'voice'`. */
  const [viaVoice, setViaVoice] = useState(false);

  const run = async (fn: () => Promise<{ success: boolean; error?: string }>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (!result.success) {
        // 409 'stale': the item changed underneath us (e.g. the prompt was
        // answered in the tab). The snapshot push brings back the resolved
        // item, so just say so instead of surfacing the raw code.
        setError(result.error === 'stale' ? 'Already handled elsewhere' : result.error || 'failed');
        return false;
      }
      return true;
    } catch {
      setError('failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendReply = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Only clear/close on success - on a failure (e.g. a stale 409 from a
    // version bump elsewhere) the user's typed reply must survive so they
    // don't have to retype it.
    void run(() => api.reply(item.id, { action: 'text', text: trimmed, version: item.version, ...(viaVoice ? { input: 'voice' as const } : {}) })).then((ok) => {
      if (ok) {
        setReplying(false);
        setText('');
        setViaVoice(false);
      }
    });
  };

  const meta = [item.source.tab_label, workspaceBasename(item.source.workspace)].filter(Boolean).join(' · ');
  const hasWake = item.actions.includes('wake');
  const question = item.kind === 'question' ? item.question ?? null : null;
  const canChoose = !!question && item.actions.includes('choose');
  // A different question (or options) under the same item: drop the pick so
  // an index never sends an option the person didn't see.
  const questionKey = question ? JSON.stringify(question) : '';
  useEffect(() => setPicked(null), [questionKey]);
  const pickedOption = canChoose && picked !== null ? question?.questions[0]?.options[picked] ?? null : null;

  const sendChoice = () => {
    if (picked === null) return;
    void run(() => api.reply(item.id, { action: 'choose', choice: picked, version: item.version })).then((ok) => {
      if (ok) setPicked(null);
    });
  };

  return (
    <div className={`copilot-item severity-${item.severity}`}>
      <div className="copilot-item-head">
        <span className="copilot-item-title">{item.title}</span>
        <span className="copilot-item-age">{formatAge(item.created_at)}</span>
      </div>
      {meta && <div className="copilot-item-meta">{meta}</div>}
      {question && (
        <div className="copilot-question">
          {question.questions.map((q, qi) => (
            <div className="copilot-question-block" key={qi}>
              <div className="copilot-question-text">
                {q.header && <span className="copilot-question-chip">{q.header}</span>}
                {q.question}
                {q.multi_select && <span className="copilot-question-note"> (pick any)</span>}
              </div>
              {!compact && q.options.length > 0 && (
                <div className="copilot-question-options">
                  {q.options.map((o, oi) =>
                    canChoose ? (
                      <button
                        key={oi}
                        className={`copilot-question-option is-choosable${picked === oi ? ' is-picked' : ''}`}
                        disabled={busy}
                        aria-pressed={picked === oi}
                        onClick={() => setPicked((p) => (p === oi ? null : oi))}
                      >
                        <span className="copilot-question-option-label">{o.label}</span>
                        {o.description && <span className="copilot-question-option-desc">{o.description}</span>}
                      </button>
                    ) : (
                      <div key={oi} className="copilot-question-option">
                        <span className="copilot-question-option-label">{o.label}</span>
                        {o.description && <span className="copilot-question-option-desc">{o.description}</span>}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
          {!canChoose && <div className="copilot-question-note">Answer this in the tab.</div>}
          {pickedOption && (
            <div className="copilot-question-confirm">
              <span>
                Send <strong>{pickedOption.label}</strong> to Claude?
              </span>
              <button className="copilot-item-btn copilot-item-btn-approve" disabled={busy} onClick={sendChoice}>
                <Icon name="send" size={12} /> Send
              </button>
              <button className="copilot-item-btn" disabled={busy} onClick={() => setPicked(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {!question && !compact && item.text && (
        <div className="copilot-item-text">
          <span className="copilot-item-text-label">{item.source.provider === 'pi' ? 'Pi' : 'Claude'}:</span>
          <AgentMarkdown text={item.text} />
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
            <Icon name="external" size={12} /> {item.kind === 'question' ? 'Open tab' : 'Open'}
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
            ref={replyRef}
            autoFocus
            value={text}
            placeholder="Reply to Claude…"
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value.trim()) setViaVoice(false);
            }}
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
            {item.source.workspace && (
              <MicButton
                workspace={item.source.workspace}
                purpose="reply"
                itemId={item.id}
                value={text}
                onChange={(t) => setText(t)}
                onVoice={() => setViaVoice(true)}
                fieldRef={replyRef}
                disabled={busy}
              />
            )}
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
