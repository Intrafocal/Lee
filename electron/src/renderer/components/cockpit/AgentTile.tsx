/**
 * AgentTile - one agent: state chip, title, the agent's latest words (or its
 * screen tail), meta and actions (contracts §3.5). Approve/Deny and Reply use
 * the v0 queue; Check in shows the exact fixed prompt before anything is
 * typed (C3); Peek opens the terminal.
 *
 * Also exports the Reply and Check-in popovers the keyboard map opens.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import type { AttentionItem, CopilotAPI } from '../../../shared/copilot';
import { CHECKIN_PROMPT, type CheckinError, type CockpitAPI } from '../../../shared/cockpit';
import type { TileModel } from '../../lib/cockpitModel';
import { closeTask, confirmTask } from '../../lib/hesterCockpit';
import type { CockpitCtx } from './CockpitHost';
import { isControlTarget } from './dom';

interface AgentTileProps {
  ctx: CockpitCtx;
  tile: TileModel;
  selected: boolean;
  onSelect: () => void;
}

export const AgentTile: React.FC<AgentTileProps> = ({ ctx, tile, selected, onSelect }) => {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  const guard = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const err = await fn();
      if (err) ctx.notify(err, 'error');
    } catch {
      ctx.notify('failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const reply = (action: 'approve' | 'deny') => {
    const item = tile.approval;
    if (!item || !ctx.copilotApi) return;
    const api = ctx.copilotApi;
    void guard(async () => {
      const r = await api.reply(item.id, { action, version: item.version });
      return r.success ? null : r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'failed';
    });
  };

  const task = tile.task;
  const taskAct = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    guard(async () => {
      const r = await fn();
      if (r.ok) ctx.hester.refresh();
      return r.ok ? null : r.error || 'failed';
    });

  return (
    <div
      ref={ref}
      className={`cockpit-tile tone-${tile.chip.tone}${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={() => ctx.goInto(tile.ptyId, 'tile')}
      data-cockpit-tile={tile.ptyId}
    >
      <div className="cockpit-tile-head">
        <span className={`cockpit-chip tone-${tile.chip.tone}`}>{tile.chip.label}</span>
        <span className="cockpit-tile-title" title={tile.title}>
          {tile.title}
        </span>
      </div>
      {tile.approval?.tool && (
        <div className="cockpit-tile-tool">
          <Icon name="lock" size={11} /> {tile.approval.tool.name}: <code>{tile.approval.tool.preview}</code>
        </div>
      )}
      {tile.summary && (
        <div className="cockpit-tile-summary">
          <span className="cockpit-agent-label">{tile.summary.label}:</span> {tile.summary.text}
        </div>
      )}
      {tile.tail && <pre className="cockpit-tile-tail">{tile.tail.join('\n')}</pre>}
      {tile.meta.length > 0 && <div className="cockpit-tile-meta">{tile.meta.join(' · ')}</div>}
      <div className="cockpit-tile-actions" onClick={(e) => e.stopPropagation()}>
        {tile.approval && (
          <>
            <button className="cockpit-btn is-primary" disabled={busy} onClick={() => reply('approve')}>
              <Icon name="check" size={11} /> Approve
            </button>
            <button className="cockpit-btn is-danger" disabled={busy} onClick={() => reply('deny')}>
              <Icon name="close" size={11} /> Deny
            </button>
          </>
        )}
        {tile.replyItem && (
          <button className="cockpit-btn" disabled={busy} onClick={() => ctx.openReply(tile.replyItem as AttentionItem, tile.title)}>
            <Icon name="send" size={11} /> Reply
          </button>
        )}
        {tile.canCheckin && !tile.approval && (
          <button className="cockpit-btn" disabled={busy} title={`Types exactly: ${CHECKIN_PROMPT}`} onClick={() => ctx.openCheckin(tile.ptyId, tile.title)}>
            <Icon name="chat" size={11} /> Check in
          </button>
        )}
        {task && !task.confirmed && (
          <button
            className="cockpit-btn"
            disabled={busy}
            onClick={() => {
              ctx.copilotApi?.logCeremony('confirm', 'task-confirm');
              void taskAct(() => confirmTask(ctx.workspace, task.id));
            }}
          >
            Confirm
          </button>
        )}
        {task && task.status === 'review' && (
          <>
            <button className="cockpit-btn" disabled={busy} onClick={() => void taskAct(() => closeTask(ctx.workspace, task.id, { status: 'done', accepted: true }))}>
              Accept
            </button>
            <button className="cockpit-btn" disabled={busy} onClick={() => void taskAct(() => closeTask(ctx.workspace, task.id, { status: 'discarded' }))}>
              Discard
            </button>
          </>
        )}
        <button className="cockpit-btn is-go" disabled={busy} onClick={() => ctx.goInto(tile.ptyId, 'tile')} title="Peek at this agent's terminal (Enter)">
          <Icon name="arrow-right" size={11} /> Peek <kbd>⏎</kbd>
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Reply popover (r): the text you type is exactly what is sent.
// ---------------------------------------------------------------------------

interface ReplyPopoverProps {
  api: CopilotAPI;
  item: AttentionItem;
  label: string;
  onClose: () => void;
  onError: (message: string) => void;
}

export const ReplyPopover: React.FC<ReplyPopoverProps> = ({ api, item, label, onClose, onError }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    api
      .reply(item.id, { action: 'text', text: trimmed, version: item.version })
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
          autoFocus
          className="cockpit-textarea"
          value={text}
          placeholder="Your reply (Enter sends, Shift+Enter newline, Esc cancels)"
          onChange={(e) => setText(e.target.value)}
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
  busy: 'It stayed busy; try again when it is idle',
  awaiting_input: 'It is waiting on a prompt; answer that first',
  state_unknown: "Lee can't tell whether it is at its prompt",
  timeout: 'No reply in time',
  forbidden: 'Not allowed',
  in_progress: 'A check-in is already running',
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

  const send = (force: boolean) => {
    if (busy) return;
    setBusy(true);
    notify(`Checking in on ${label}…`);
    api
      .checkin(ptyId, force ? { force: true } : undefined)
      .then((r) => {
        if (r.success) {
          notify(`Checked in on ${label}: ${r.lee_status?.status ?? 'reply received'}`);
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
        <div className="cockpit-muted">Lee will type exactly this into that agent, then Enter:</div>
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

export default AgentTile;
