/**
 * SectionMarks - the margin's per-section marks (Deep next R5) and the
 * Goals Page's quiet prompts (R12).
 *
 * One mark per section with asks or hand-offs, at the section's first line:
 * the most urgent state's mark, a count when there are several, the top
 * item's small label and its question. Clicking a one-item mark opens its
 * card; clicking a several-item mark lists the section's cards (answers, and
 * hand-offs with their state, "Open in Work", and Reply when one waits on
 * you). Cards are DeepHost's renderCard. Marks never take focus.
 *
 * Marks (deep.css): pending a small spinner; unread the phosphor dot (the
 * new-answer dot); read a hollow dot; running a small phosphor agent mark;
 * waiting an ember dot (the one ember in Deep); done a hollow agent mark.
 */

import React from 'react';
import type { DeepAnswer } from '../../../../shared/cockpit';
import type { SectionMark, SectionMarkState } from '../../../lib/deepModel';

export interface MarkItem {
  id: string;
  state: SectionMarkState;
  /** "Hester answered", "asking…", "Spike · working". */
  label: string;
  question: string;
  /** The record, when it came from `answers` (absent for a queued offline ask). */
  answer?: DeepAnswer;
}

export function MarkGlyph({ state }: { state: SectionMarkState }) {
  return (
    <span className={`deep-mark is-${state}`} aria-hidden="true">
      {state === 'pending' && <span className="deep-marker-spin" />}
    </span>
  );
}

interface SectionMarkViewProps {
  mark: SectionMark;
  items: ReadonlyMap<string, MarkItem>;
  /** The several-item list is open. */
  listOpen: boolean;
  onToggleList: () => void;
  /** DeepHost's open card (it toggles, and marks read). */
  openMarker: string | null;
  onItemClick: (id: string) => void;
  renderCard: (id: string) => React.ReactNode;
  onOpenInWork?: (answerId: string) => void;
  onReplyHandoff?: (answerId: string, text: string) => void;
}


function Note({ item, count, open, onClick }: { item: MarkItem; count?: number; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`deep-note is-${item.state}`}
      tabIndex={-1}
      aria-expanded={open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span className="deep-note-head">
        <MarkGlyph state={item.state} />
        {count != null && count > 1 && <span className="deep-mark-count">{count}</span>}
        {item.label}
      </span>
      <span className="deep-note-q">{item.question}</span>
    </button>
  );
}

export function SectionMarkView({ mark, items, listOpen, onToggleList, openMarker, onItemClick, renderCard }: SectionMarkViewProps) {
  const list = mark.ids.map((id) => items.get(id)).filter((x): x is MarkItem => !!x);
  if (!list.length) return null;
  const top = list[0];
  const card = (it: MarkItem) => (
    <div className="deep-card">
      {renderCard(it.id)}
    </div>
  );
  if (list.length === 1) {
    const open = openMarker === top.id;
    return (
      <>
        <Note item={top} open={open} onClick={() => onItemClick(top.id)} />
        {open && card(top)}
      </>
    );
  }
  return (
    <>
      <Note item={{ ...top, state: mark.state }} count={list.length} open={listOpen} onClick={onToggleList} />
      {listOpen && (
        <div className="deep-mark-list">
          {list.map((it) => (
            <div key={it.id} className="deep-mark-list-item">
              <Note item={it} open={openMarker === it.id} onClick={() => onItemClick(it.id)} />
              {openMarker === it.id && card(it)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// R12: quiet prompts at the top of the margin
// ---------------------------------------------------------------------------

export function MarginPrompts({ prompts, answered, dismissed, onDismiss }: { prompts: readonly string[]; answered: ReadonlySet<string>; dismissed: ReadonlySet<string>; onDismiss: (p: string) => void }) {
  return (
    <div className="deep-prompts" aria-label="Prompts">
      {prompts.map((p) => {
        const faded = answered.has(p) || dismissed.has(p);
        return (
          <div key={p} className={`deep-prompt${faded ? ' is-faded' : ''}`} aria-hidden={faded}>
            <span className="deep-prompt-text">{p}</span>
            {!faded && (
              <button type="button" className="deep-prompt-x" tabIndex={-1} aria-label="Dismiss" title="Dismiss" onMouseDown={(e) => e.preventDefault()} onClick={() => onDismiss(p)}>
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
