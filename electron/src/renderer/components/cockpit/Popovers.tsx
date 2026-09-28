/**
 * Popovers - the Reply, Check-in and Rename popovers the Cockpit keymap and
 * Work open (moved from AgentTile when the tile dock went, cockpit-design
 * §2.1). Reply sends exactly what you type; Check in shows the exact fixed
 * prompt before anything is typed (C3); Rename types nothing into the agent.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import type { AttentionItem, CopilotAPI } from '../../../shared/copilot';
import { CHECKIN_PROMPT, type CheckinError, type CockpitAPI } from '../../../shared/cockpit';
import { isControlTarget } from './dom';
import { MicButton } from '../voice/MicButton';


// ---------------------------------------------------------------------------
// Reply popover (r): the text you type is exactly what is sent.
// ---------------------------------------------------------------------------

interface ReplyPopoverProps {
  api: CopilotAPI;
  /** For the mic (Hester's voice routes are per workspace). */
  workspace: string;
  item: AttentionItem;
  label: string;
  onClose: () => void;
  onError: (message: string) => void;
}

export const ReplyPopover: React.FC<ReplyPopoverProps> = ({ api, workspace, item, label, onClose, onError }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  /** The text came from the mic (§5.3): the reply is tagged `input: 'voice'`. */
  const [viaVoice, setViaVoice] = useState(false);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    api
      .reply(item.id, { action: 'text', text: trimmed, version: item.version, ...(viaVoice ? { input: 'voice' as const } : {}) })
      .then((r) => {
        if (r.success) onClose();
        else onError(r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'failed');
      })
      .catch(() => onError('failed'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div className="cockpit-popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Reply to ${label}`}>
        <div className="cockpit-popover-title">Reply to {label}</div>
        {item.text && (
          <div className="cockpit-agent-words">
            <span className="cockpit-agent-label">Agent:</span> {item.text}
          </div>
        )}
        <textarea
          ref={fieldRef}
          autoFocus
          className="cockpit-textarea"
          value={text}
          placeholder="Your reply (Enter sends, Shift+Enter newline, Esc cancels)"
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setViaVoice(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="cockpit-popover-actions">
          <button className="cockpit-btn is-primary" disabled={busy || !text.trim()} onClick={send}>
            <Icon name="send" size={11} /> Send
          </button>
          <MicButton workspace={workspace} purpose="reply" itemId={item.id} value={text} onChange={(t) => setText(t)} onVoice={() => setViaVoice(true)} fieldRef={fieldRef} disabled={busy} />
          <button className="cockpit-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Check-in confirm (c): shows the fixed prompt and the target first.
// ---------------------------------------------------------------------------

const CHECKIN_ERRORS: Record<CheckinError, string> = {
  not_found: 'That tab is gone',
  not_agent: 'Not an agent tab',
  busy: 'It is busy',
  awaiting_input: 'It is waiting on a prompt; answer that first',
  state_unknown: "Lee can't tell whether it is at its prompt",
  timeout: 'No reply in time',
  forbidden: 'Not allowed',
  in_progress: 'A check-in is already pending',
  cancelled: 'Cancelled',
};

interface CheckinPopoverProps {
  api: CockpitAPI;
  ptyId: number;
  label: string;
  onClose: () => void;
  notify: (message: string, level?: 'info' | 'error') => void;
}

export const CheckinPopover: React.FC<CheckinPopoverProps> = ({ api, ptyId, label, onClose, notify }) => {
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // The request returns at once: queued behind the agent's turn, or typed now.
  // The result arrives later (tile chip, Feed entry and a toast).
  const send = (force: boolean) => {
    if (busy) return;
    setBusy(true);
    api
      .checkin(ptyId, force ? { force: true } : undefined)
      .then((r) => {
        if (r.success) {
          notify(r.state === 'queued' ? `Check-in on ${label} queued: Lee types it when this turn ends` : `Checking in on ${label}…`);
          onClose();
        } else if (r.error === 'state_unknown' && !force) {
          setUnknown(true);
        } else {
          notify(r.error ? CHECKIN_ERRORS[r.error] ?? r.error : 'Check-in failed', 'error');
          onClose();
        }
      })
      .catch(() => {
        notify('Check-in failed', 'error');
        onClose();
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className="cockpit-popover"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter on a focused button is that button's click (Cancel must cancel, C3).
          if (e.key === 'Enter' && !isControlTarget(e.target)) {
            e.preventDefault();
            e.stopPropagation();
            send(unknown);
          }
        }}
        role="dialog"
        aria-label={`Check in on ${label}`}
      >
        <div className="cockpit-popover-title">Check in on {label}?</div>
        <div className="cockpit-muted">
          Lee will type exactly this into that agent, then Enter (if it is busy or waiting on a prompt, when its turn ends):
        </div>
        <pre className="cockpit-confirm-text">{CHECKIN_PROMPT}</pre>
        {unknown && <div className="cockpit-warn">{CHECKIN_ERRORS.state_unknown}. Send it anyway?</div>}
        <div className="cockpit-popover-actions">
          <button className="cockpit-btn is-primary" disabled={busy} onClick={() => send(unknown)}>
            <Icon name="send" size={11} /> {unknown ? 'Send anyway' : 'Check in'} <kbd>⏎</kbd>
          </button>
          <button className="cockpit-btn" onClick={onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Rename popover (e): your name for an agent / task. Nothing is typed into the agent.
// ---------------------------------------------------------------------------

export interface RenameTarget {
  ptyId?: number | null;
  taskId?: string | null;
  current: string;
  provider?: string | null;
}

interface RenamePopoverProps {
  target: RenameTarget;
  onSave: (target: RenameTarget, name: string | null) => Promise<string | null>;
  onClose: () => void;
  notify: (message: string, level?: 'info' | 'error') => void;
}

export const RenamePopover: React.FC<RenamePopoverProps> = ({ target, onSave, onClose, notify }) => {
  const [text, setText] = useState(target.current);
  const [busy, setBusy] = useState(false);

  const save = () => {
    if (busy) return;
    const name = text.trim() || null;
    setBusy(true);
    onSave(target, name)
      .then((err) => {
        if (err) notify(err, 'error');
        else {
          notify(name ? `Renamed to ${name}` : 'Name cleared');
          onClose();
        }
      })
      .catch(() => notify('Rename failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div className="cockpit-popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rename">
        <div className="cockpit-popover-title">Rename {target.current}</div>
        <input
          autoFocus
          className="cockpit-input"
          value={text}
          maxLength={120}
          placeholder="Name (empty clears it)"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="cockpit-muted">
          Your name wins over Claude&apos;s own title.
          {target.provider === 'claude' && ' /rename inside the session also works (and a later /rename replaces this).'}
        </div>
        <div className="cockpit-popover-actions">
          <button className="cockpit-btn is-primary" disabled={busy} onClick={save}>
            Save <kbd>⏎</kbd>
          </button>
          <button className="cockpit-btn" onClick={onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};
