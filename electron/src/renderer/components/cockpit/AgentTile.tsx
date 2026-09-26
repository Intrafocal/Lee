/**
 * AgentTile - one agent: state chip, title, the agent's latest words (or its
 * screen tail), meta and actions (contracts §3.5). Approve/Deny and Reply use
 * the v0 queue; Check in shows the exact fixed prompt before anything is
 * typed (C3); Peek opens the terminal. × dismisses the tile's notification
 * (queue dismiss, as the flyout); Close ends the agent (a working agent asks
 * once more, inline).
 *
 * Also exports the Reply and Check-in popovers the keyboard map opens.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../Icon';
import type { AttentionItem, CopilotAPI } from '../../../shared/copilot';
import { CHECKIN_PROMPT, type CheckinError, type CockpitAPI } from '../../../shared/cockpit';
import type { TileModel } from '../../lib/cockpitModel';
import { closeTask, confirmTask } from '../../lib/hesterCockpit';
import type { CockpitCtx } from './CockpitHost';
import { isControlTarget } from './dom';
import { AgentMarkdown } from './AgentMarkdown';

interface AgentTileProps {
  ctx: CockpitCtx;
  tile: TileModel;
  selected: boolean;
  onSelect: () => void;
}

/**
 * Summaries you dismissed, by pty: the text hidden (a new summary shows again).
 * Module-level so it survives collapsing the tiles; renderer memory only.
 */
const hiddenSummaries = new Map<number, string>();

const NOTICE_LABEL: Record<string, string> = {
  approval: 'approval',
  question: 'question',
  waiting: 'waiting',
  blocker: 'blocker',
  decision: 'decision',
  failure: 'failure',
  review: 'review',
  summary: 'summary',
};

/**
 * An icon button whose label slides out on hover or keyboard focus (or while
 * `open`, e.g. Close's second-click confirmation). The label stays the
 * accessible name either way.
 */
const TileAction: React.FC<{
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  kbd?: string;
  open?: boolean;
}> = ({ icon, label, onClick, disabled, title, className, kbd, open }) => (
  <button
    className={`cockpit-btn is-reveal${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    disabled={disabled}
    title={title ?? label}
    aria-label={label}
    onClick={onClick}
  >
    <Icon name={icon} size={12} />
    <span className="cockpit-btn-label" aria-hidden="true">
      {label}
      {kbd && <kbd>{kbd}</kbd>}
    </span>
  </button>
);

export const AgentTile: React.FC<AgentTileProps> = ({ ctx, tile, selected, onSelect }) => {
  const [busy, setBusy] = useState(false);
  const [hiddenSummary, setHiddenSummary] = useState<string | null>(() => hiddenSummaries.get(tile.ptyId) ?? null);
  // Closing a working agent takes a second click (no modal).
  const [confirmClose, setConfirmClose] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  useEffect(() => {
    if (!confirmClose) return;
    const t = window.setTimeout(() => setConfirmClose(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirmClose]);
  // The confirmation is about a working agent: drop it once it stops.
  useEffect(() => {
    if (!tile.working) setConfirmClose(false);
  }, [tile.working]);

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

  const summaryShown = !!tile.summary && tile.summary.text !== hiddenSummary;
  const notice = tile.notice;
  const canDismiss = !!notice || summaryShown;

  // Dismiss the tile's notification: the attention item through the queue's
  // dismiss (as the flyout does; an approval's prompt stays open in the
  // terminal), and the agent's summary text locally when the item is a
  // summary/review or there is no item.
  const dismiss = () => {
    const hideSummary = () => {
      if (!tile.summary) return;
      hiddenSummaries.set(tile.ptyId, tile.summary.text);
      setHiddenSummary(tile.summary.text);
    };
    if (!notice || notice.kind === 'summary' || notice.kind === 'review') hideSummary();
    if (!notice || !ctx.copilotApi) return;
    const api = ctx.copilotApi;
    void guard(async () => {
      const r = await api.dismiss(notice.id);
      return r.success ? null : r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'failed';
    });
  };

  const close = () => {
    if (tile.working && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    setConfirmClose(false);
    ctx.closeAgent(tile.ptyId, tile.tabId);
    ctx.notify(`Closed ${tile.title}`);
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
        {tile.checkin && (
          <span
            className="cockpit-chip tone-muted"
            title={tile.checkin.state === 'queued' ? 'Lee types the check-in when this turn ends' : 'Typed; waiting for the reply'}
          >
            {tile.checkin.label}
          </span>
        )}
        <span className="cockpit-tile-title" title={tile.title}>
          {tile.title}
        </span>
        {canDismiss && (
          <button
            className="cockpit-tile-dismiss"
            disabled={busy}
            aria-label="Dismiss notification"
            title={
              notice
                ? `Dismiss this ${NOTICE_LABEL[notice.kind] ?? 'notification'}${notice.kind === 'approval' ? ' (the prompt stays open in the terminal)' : ''}`
                : 'Hide this summary'
            }
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
      {tile.approval?.tool && (
        <div className="cockpit-tile-tool">
          <Icon name="lock" size={11} /> {tile.approval.tool.name}: <code>{tile.approval.tool.preview}</code>
        </div>
      )}
      {tile.summary &&
        summaryShown &&
        (selected ? (
          <div className="cockpit-tile-summary is-expanded" onDoubleClick={(e) => e.stopPropagation()}>
            <span className="cockpit-agent-label">{tile.summary.label}:</span>
            <AgentMarkdown text={tile.summary.text} />
          </div>
        ) : (
          <div className="cockpit-tile-summary">
            <span className="cockpit-agent-label">{tile.summary.label}:</span> {tile.summary.preview || '(code)'}
          </div>
        ))}
      {tile.tail && <pre className="cockpit-tile-tail">{tile.tail.join('\n')}</pre>}
      {tile.meta.length > 0 && <div className="cockpit-tile-meta">{tile.meta.join(' · ')}</div>}
      <div className="cockpit-tile-actions" onClick={(e) => e.stopPropagation()}>
        {tile.approval && (
          <>
            <TileAction icon="check" label="Approve" className="is-primary" disabled={busy} onClick={() => reply('approve')} />
            <TileAction icon="close" label="Deny" className="is-danger" disabled={busy} onClick={() => reply('deny')} />
          </>
        )}
        {tile.replyItem && (
          <TileAction icon="send" label="Reply" disabled={busy} onClick={() => ctx.openReply(tile.replyItem as AttentionItem, tile.title)} />
        )}
        {tile.checkin ? (
          <TileAction
            icon="stop"
            label="Cancel check-in"
            disabled={busy}
            title={tile.checkin.state === 'queued' ? 'Cancel the queued check-in (nothing has been typed)' : 'Stop waiting for the reply'}
            onClick={() => {
              const api = ctx.api;
              if (!api) return;
              void guard(async () => {
                const r = await api.checkinCancel(tile.ptyId);
                return r.success ? null : r.error || 'failed';
              });
            }}
          />
        ) : (
          tile.canCheckin &&
          !tile.approval && (
            <TileAction
              icon="chat"
              label="Check in"
              disabled={busy}
              title={`Types exactly: ${CHECKIN_PROMPT}`}
              onClick={() => ctx.openCheckin(tile.ptyId, tile.title)}
            />
          )
        )}
        {task && !task.confirmed && (
          <TileAction
            icon="check"
            label="Confirm"
            disabled={busy}
            title="Confirm this task"
            onClick={() => {
              ctx.copilotApi?.logCeremony('confirm', 'task-confirm');
              void taskAct(() => confirmTask(ctx.workspace, task.id));
            }}
          />
        )}
        {task && task.status === 'review' && (
          <>
            <TileAction
              icon="check"
              label="Accept"
              disabled={busy}
              title="Accept this task's work"
              onClick={() => void taskAct(() => closeTask(ctx.workspace, task.id, { status: 'done', accepted: true }))}
            />
            <TileAction
              icon="trash"
              label="Discard"
              disabled={busy}
              title="Discard this task's work"
              onClick={() => void taskAct(() => closeTask(ctx.workspace, task.id, { status: 'discarded' }))}
            />
          </>
        )}
        <TileAction
          icon="edit"
          label="Rename"
          disabled={busy}
          title="Rename (⌘E)"
          onClick={() => ctx.openRename({ ptyId: tile.ptyId, taskId: task?.id ?? null, current: tile.title, provider: tile.provider })}
        />
        <TileAction
          icon="power"
          label={confirmClose ? 'Agent is working — close anyway?' : 'Close'}
          className={confirmClose ? 'is-danger' : undefined}
          open={confirmClose}
          disabled={busy}
          title={tile.working ? 'Close this agent (it is working: asks once more)' : 'Close this agent and its tab'}
          onClick={close}
        />
        <TileAction
          icon="eye"
          label="Peek"
          kbd="⏎"
          className="is-go"
          disabled={busy}
          title="Peek at this agent's terminal (Enter)"
          onClick={() => ctx.goInto(tile.ptyId, 'tile')}
        />
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

export default AgentTile;
