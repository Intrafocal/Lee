/**
 * VisualCard - a Visualize on a Board (Boards B6, plan §5b): a small frame
 * beside what was selected. It shows the brief and, while Hester's diagram
 * agent works, its progress; an error with Retry; when done, a line saying
 * what it made. Open, the brief in full.
 *
 * When its row turns done and nothing is placed yet (`result_item_id`), it
 * asks BoardView to place the result beside it (`onPlace`) once per mount;
 * BoardView checks the Board first, so a reload or a second window doesn't
 * place it twice.
 *
 * Presentational, like AskCard: BoardView owns the item and the calls.
 */

import React, { useEffect } from 'react';
import type { BoardVisual } from '../../../shared/board';
import type { DeepAnswer } from '../../../shared/cockpit';
import { frameText, needsResult } from '../../lib/boardVisualModel';
import './askcards.css';

export interface VisualCardProps {
  item: BoardVisual;
  /** Its answers.jsonl row; null while loading or when it's gone. */
  answer: DeepAnswer | null;
  selected?: boolean;
  /** Open or close it. Opening a result you haven't seen is when to mark it read. */
  onToggle: (open: boolean) => void;
  onRetry: (answerId: string) => void;
  /** Put the result on the Board beside the frame (idempotent). */
  onPlace: () => void;
  /** Why the result couldn't be placed (a diagram with a mistake), if it couldn't. */
  placeError?: string | null;
}

const own = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
};

export function VisualCard({ item, answer, selected, onToggle, onRetry, onPlace, placeError }: VisualCardProps): JSX.Element {
  const t = frameText(answer);
  const open = !!item.open;
  const due = needsResult(item, answer);

  useEffect(() => {
    if (due) onPlace();
    // Once each time it becomes due; onPlace is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due]);

  const error = t.error ?? placeError ?? null;

  return (
    <div
      className={`bd-visual bd-card is-${t.state}${open ? ' is-open' : ''}${selected ? ' is-selected' : ''}`}
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      data-item-id={item.id}
      role="group"
      aria-label={`Visualize: ${t.brief || 'a picture of the selection'}`}
    >
      <button type="button" className="bd-card-head" aria-expanded={open} title={open ? 'Fold it back' : 'Open it'} onClick={() => onToggle(!open)}>
        <span className={`bd-card-dot is-${t.state === 'queued' ? 'asking' : t.state}`} aria-hidden="true" />
        <span className="bd-card-status">{t.status}</span>
      </button>
      <div className={`bd-visual-brief${open ? '' : ' is-clamped'}`}>{t.brief || (t.state === 'missing' ? 'This Visualize isn’t on the Board any more.' : '')}</div>
      {t.line && <div className="bd-visual-made">{t.line}</div>}
      {(t.state === 'queued' || t.state === 'running') && <span className="bd-visual-bar" aria-hidden="true" />}
      {error && (
        <div className="bd-card-err" {...own}>
          {error}{' '}
          {t.canRetry && answer && (
            <button type="button" className="bd-card-btn" onClick={() => onRetry(answer.id)}>
              Retry
            </button>
          )}
          {!t.error && placeError && due && (
            <button type="button" className="bd-card-btn" onClick={() => onPlace()}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default VisualCard;
