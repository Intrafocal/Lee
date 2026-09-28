/**
 * HandoffCard - a hand-off on a Board (Boards B3, docs/16-Desk.md §3.1): a
 * clipboard beside what was selected. Collapsed it shows the kind and state
 * ("Spike · working") and one line (the result's first line once it's in,
 * else what was handed off); open it shows the result, with Open in Work
 * and, while the agent waits on you, Reply. The Page margin's hand-off card
 * (DeepHost renderHandoffCard), on the canvas.
 *
 * Presentational, like AskCard: BoardSurface owns the item and the calls.
 */

import React, { useState } from 'react';
import type { BoardHandoff } from '../../../shared/board';
import type { DeepAnswer } from '../../../shared/cockpit';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { clipboardText } from '../../lib/boardAskModel';
import './askcards.css';

export interface HandoffCardProps {
  item: BoardHandoff;
  /** Its answers.jsonl row; null while loading or when it's gone. */
  answer: DeepAnswer | null;
  selected?: boolean;
  /** Open or close it. Opening a result you haven't seen is when to mark it read. */
  onToggle: (open: boolean) => void;
  /** Its task in Work (the Cockpit's detail view). Hidden until the hand-off has a task. */
  onOpenInWork: (taskId: string) => void;
  /** Reply to the agent while it waits on you (DeepHost replyHandoff); resolve false to keep the text. Hidden when absent. */
  onReply?: (text: string) => Promise<boolean> | boolean | void;
}

const own = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
};

export function HandoffCard({ item, answer, selected, onToggle, onOpenInWork, onReply }: HandoffCardProps): JSX.Element {
  const t = clipboardText(answer);
  const open = !!item.open;
  const [replying, setReplying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unseen = t.state === 'review' && !!answer && !answer.read_at;

  const reply = async () => {
    const body = (replying ?? '').trim();
    if (!body || busy || !onReply) return;
    setBusy(true);
    const ok = await onReply(body);
    setBusy(false);
    if (ok !== false) setReplying(null);
  };

  return (
    <div
      className={`bd-handoff bd-card is-${t.state}${unseen ? ' is-unseen' : ''}${open ? ' is-open' : ''}${selected ? ' is-selected' : ''}`}
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      data-item-id={item.id}
      role="group"
      aria-label={`Hand-off: ${t.label}`}
    >
      <span className="bd-clip" aria-hidden="true" />
      <button
        type="button"
        className="bd-card-head"
        aria-expanded={open}
        title={open ? 'Fold it back' : 'Open the result'}
        onClick={() => onToggle(!open)}
      >
        <span className={`bd-card-dot is-${unseen ? 'new' : t.state}`} aria-hidden="true" />
        <span className="bd-card-status">{t.label}</span>
      </button>
      <div className={`bd-handoff-line${open ? '' : ' is-clamped'}`}>{t.line}</div>
      {open && (
        <div className="bd-card-body" {...own} onWheel={(e) => e.stopPropagation()}>
          {t.error && <div className="bd-card-err">{t.error}</div>}
          {t.result ? (
            <div className="bd-card-md">
              <AgentMarkdown text={t.result} />
            </div>
          ) : (
            !t.error && <div className="bd-card-status">{t.state === 'waiting' ? 'The agent is waiting on you.' : 'No result yet.'}</div>
          )}
          <div className="bd-card-actions">
            {t.taskId && (
              <button type="button" className="bd-card-btn" onClick={() => onOpenInWork(t.taskId as string)}>
                Open in Work
              </button>
            )}
            {t.state === 'waiting' && t.taskId && onReply && replying == null && (
              <button type="button" className="bd-card-btn" onClick={() => setReplying('')}>
                Reply
              </button>
            )}
          </div>
          {replying != null && (
            <input
              className="bd-card-input"
              autoFocus
              value={replying}
              disabled={busy}
              placeholder="Reply to the agent (sent exactly as written)…"
              onChange={(e) => setReplying(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void reply();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setReplying(null);
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default HandoffCard;
