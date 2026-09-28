/**
 * AskCard - an Ask on a Board (Boards B3, docs/16-Desk.md §3.1): a sticky
 * note beside what was selected. Collapsed it shows the question and a
 * small status; open it shows the answer, any follow-ups, and a follow-up
 * field (or Retry after an error).
 *
 * Presentational: BoardSurface owns the item (lib/boardAskModel toggleCard,
 * newAskItem) and the calls (lib/hesterBoardAsks). It sits in the Board's
 * transformed layer, positioned and sized from the item in Board px; its
 * text is counter-scaled a little with --board-scale (askcards.css).
 *
 * The card keeps its own pointer and key events off the canvas only where
 * they're its own: the buttons and the follow-up field. A drag on the rest
 * of it is the canvas's (Select moves it); a click without a drag toggles.
 */

import React, { useState } from 'react';
import type { BoardAsk } from '../../../shared/board';
import type { DeepAnswer } from '../../../shared/cockpit';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { leaderLine, rectOf, stickyText } from '../../lib/boardAskModel';
import './askcards.css';

export interface AskCardProps {
  item: BoardAsk;
  /** Its answers.jsonl row; null while loading or when it's gone. */
  answer: DeepAnswer | null;
  /** Follow-ups to it, oldest first (boardAskModel.followUpsOf). */
  followUps?: readonly DeepAnswer[];
  selected?: boolean;
  /** Open or close it. Opening an unread answer is when to mark it read. */
  onToggle: (open: boolean) => void;
  /** A follow-up, sent exactly as written with the same anchor; resolve false to keep the text. */
  onFollowUp: (question: string) => Promise<boolean> | boolean | void;
  /** Retry an errored Ask (this row or a follow-up's). */
  onRetry: (answerId: string) => void;
}

/** Stops a pointer or key event reaching the canvas (buttons and fields). */
const own = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
};

function Reply({ a, onRetry }: { a: DeepAnswer; onRetry: (id: string) => void }) {
  const t = stickyText(a);
  return (
    <div className="bd-ask-followup">
      <div className="bd-ask-q is-follow">{t.question}</div>
      {t.state === 'asking' && <div className="bd-card-status">Asking…</div>}
      {t.answer && (
        <div className="bd-card-md">
          <AgentMarkdown text={t.answer} />
        </div>
      )}
      {t.error && (
        <div className="bd-card-err">
          {t.error}{' '}
          <button type="button" className="bd-card-btn" {...own} onClick={() => onRetry(a.id)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export function AskCard({ item, answer, followUps = [], selected, onToggle, onFollowUp, onRetry }: AskCardProps): JSX.Element {
  const t = stickyText(answer);
  const open = !!item.open;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const q = draft.trim();
    if (!q || busy) return;
    setBusy(true);
    const ok = await onFollowUp(q);
    setBusy(false);
    if (ok !== false) setDraft('');
  };

  return (
    <div
      className={`bd-ask bd-card is-${t.state}${open ? ' is-open' : ''}${selected ? ' is-selected' : ''}`}
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      data-item-id={item.id}
      role="group"
      aria-label={`Ask: ${t.question || 'question'}`}
    >
      <button
        type="button"
        className="bd-card-head"
        aria-expanded={open}
        title={open ? 'Fold it back' : 'Open the answer'}
        onClick={() => onToggle(!open)}
      >
        <span className={`bd-card-dot is-${t.state}`} aria-hidden="true" />
        <span className="bd-card-status">{t.status}</span>
      </button>
      <div className={`bd-ask-q${open ? '' : ' is-clamped'}`}>{t.question || (t.state === 'missing' ? 'This Ask isn’t on the Board any more.' : '')}</div>
      {open && (
        <div className="bd-card-body" {...own} onWheel={(e) => e.stopPropagation()}>
          {t.answer && (
            <div className="bd-card-md">
              <AgentMarkdown text={t.answer} />
            </div>
          )}
          {t.error && (
            <div className="bd-card-err">
              {t.error}{' '}
              {answer && (
                <button type="button" className="bd-card-btn" onClick={() => onRetry(answer.id)}>
                  Retry
                </button>
              )}
            </div>
          )}
          {followUps.map((f) => (
            <Reply key={f.id} a={f} onRetry={onRetry} />
          ))}
          {t.canFollowUp && (
            <input
              className="bd-card-input"
              value={draft}
              disabled={busy}
              placeholder="Follow up…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void send();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  if (draft) setDraft('');
                  else onToggle(false);
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The thin leader from a sticky or clipboard to what it's about, in Board
 * px. Draw it in the same layer, under the cards. Nothing when they touch.
 */
export function CardLeader({ item }: { item: { x: number; y: number; w: number; h: number; target: BoardAsk['target'] } }): JSX.Element | null {
  const l = leaderLine(rectOf(item), item.target.rect);
  if (!l) return null;
  const [x1, y1, x2, y2] = l;
  const pad = 4;
  const left = Math.min(x1, x2) - pad;
  const top = Math.min(y1, y2) - pad;
  return (
    <svg
      className="bd-leader"
      style={{ left, top, width: Math.abs(x2 - x1) + pad * 2, height: Math.abs(y2 - y1) + pad * 2 }}
      aria-hidden="true"
    >
      <line x1={x1 - left} y1={y1 - top} x2={x2 - left} y2={y2 - top} />
      <circle cx={x2 - left} cy={y2 - top} r={2.5} />
    </svg>
  );
}

export default AskCard;
