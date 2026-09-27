/**
 * EndSessionSheet - the ending ritual (Deep D1 §9). One small sheet, no
 * chord, nothing required:
 *
 * 1. Where did you stop? (pre-filled with the last sentence written)
 * 2. Open questions: this session's marked `?` lines and unread Asks,
 *    checked ("keep open") by default. Unchecked questions are closed;
 *    unchecked Asks are marked read.
 * 3. How deep was that? Deep / mixed / shallow, none selected.
 * 4. Anything for agents while you're away? "Hand off…" (the v1 dialog).
 * 5. Close Lee (the default, Enter) or Stay open. While Asks are still
 *    running, a line says so and Stay open becomes the default: closing Lee
 *    stops the daemon, and Enter must never quietly stop work.
 *
 * Either button writes the SessionRecord, ends the Deep session and returns
 * this window to the Cockpit; Close Lee then quits. Esc ends the session
 * unrated (reason 'esc'). The × means "never mind" and keeps the session.
 * No timers, no reminders.
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { DepthRating } from '../../../shared/cockpit';
import type { CopilotAPI, FocusState } from '../../../shared/copilot';
import { cockpitModeStore } from '../cockpit/cockpitMode';
import { HandoffDialog } from '../copilot/HandoffDialog';
import { patchAnswer, patchQuestion, postSession } from '../../lib/hesterDeep';
import { deepEnd, quitLee } from './deepBridge';
import './deep.css';

export interface RitualQuestion {
  id: string;
  kind: 'question' | 'answer';
  text: string;
}

interface EndSessionSheetProps {
  workspace: string;
  explorationId: string | null;
  /** The last sentence written on the Page. */
  prefill: string;
  questions: RitualQuestion[];
  focus: FocusState | null;
  copilotApi: CopilotAPI | null;
  /** Asks still queued or running; closing Lee stops them (they come back as Retry). */
  running?: number;
  /** Called before anything is written, so the Page can flush its last save. */
  beforeEnd?: () => Promise<void>;
  onClose: () => void;
}

const RATINGS: Array<{ value: DepthRating; label: string }> = [
  { value: 'deep', label: 'Deep' },
  { value: 'mixed', label: 'mixed' },
  { value: 'shallow', label: 'shallow' },
];

export const EndSessionSheet: React.FC<EndSessionSheetProps> = ({
  workspace,
  explorationId,
  prefill,
  questions,
  focus,
  copilotApi,
  running = 0,
  beforeEnd,
  onClose,
}) => {
  const closeByDefault = running === 0;
  const [stoppedAt, setStoppedAt] = useState(prefill);
  const [kept, setKept] = useState<Set<string>>(() => new Set(questions.map((q) => q.id)));
  const [rating, setRating] = useState<DepthRating | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const edited = stoppedAt !== prefill;

  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const finish = async (reason: 'ritual' | 'esc', close: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await beforeEnd?.();
    } catch {
      /* the Page keeps its mirror either way */
    }
    const ended = new Date().toISOString();
    const stopped = reason === 'esc' && !edited ? null : stoppedAt.trim().slice(0, 1000) || null;
    const ritual = reason === 'ritual';
    const keptIds = ritual ? questions.filter((q) => kept.has(q.id)).map((q) => q.id) : questions.map((q) => q.id);
    const writes: Array<Promise<unknown>> = [];
    if (explorationId) {
      writes.push(
        postSession(workspace, explorationId, {
          focus_session_id: focus?.session_id ?? '',
          started_at: focus?.started_at ?? ended,
          ended_at: ended,
          reason,
          stopped_at: stopped,
          rating: ritual ? rating : null,
          questions_kept: keptIds,
        }),
      );
      if (ritual) {
        for (const q of questions) {
          if (kept.has(q.id)) continue;
          writes.push(q.kind === 'question' ? patchQuestion(workspace, explorationId, q.id, 'closed') : patchAnswer(workspace, explorationId, q.id, { read: true }));
        }
      }
    }
    await Promise.allSettled(writes);
    await deepEnd(ritual ? { reason: 'ritual', rating, stopped_at_chars: stopped ? stopped.length : 0 } : { reason: 'esc', rating: null, ...(stopped ? { stopped_at_chars: stopped.length } : {}) });
    cockpitModeStore.set('cockpit', 'deep_end');
    onClose();
    if (close) quitLee();
  };

  // Esc and Enter on window, in the capture phase: they work wherever focus
  // has gone (body after a click on bare sheet space, or after Hand off…
  // closes), not only inside the sheet (§0: Esc always works).
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if (handoff || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void finish('esc', false);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Only from the sheet (or nowhere); a focused button, checkbox or link keeps its own Enter.
      const t = e.target;
      const onSheet = t === document.body || (t instanceof Node && !!sheetRef.current?.contains(t));
      const own = t instanceof HTMLElement && t !== sheetRef.current && !!t.closest('button, input, a, select');
      if (!onSheet || own) return;
      e.preventDefault();
      e.stopPropagation();
      void finish('ritual', closeByDefault);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Back from Hand off…: focus returns to the sheet so the keys keep a home.
  const hadHandoff = useRef(false);
  useEffect(() => {
    if (hadHandoff.current && !handoff) sheetRef.current?.focus({ preventScroll: true });
    hadHandoff.current = handoff;
  }, [handoff]);

  return ReactDOM.createPortal(
    <div className="deep-sheet-scrim">
      <div ref={sheetRef} className="deep-sheet" role="dialog" aria-modal="true" aria-label="End session" tabIndex={-1}>
        <div className="deep-sheet-head">
          <span>End session</span>
          <span className="deep-spacer" />
          <button className="deep-icon-btn" onClick={onClose} title="Never mind: keep the session" aria-label="Keep the session">
            ×
          </button>
        </div>

        <label className="deep-sheet-label" htmlFor="deep-stopped-at">
          Where did you stop?
        </label>
        <textarea
          id="deep-stopped-at"
          ref={fieldRef}
          className="deep-sheet-field"
          rows={2}
          maxLength={1000}
          value={stoppedAt}
          placeholder="Optional"
          onChange={(e) => setStoppedAt(e.target.value)}
        />

        {questions.length > 0 && (
          <>
            <div className="deep-sheet-label">Open questions</div>
            <div className="deep-sheet-questions">
              {questions.map((q) => (
                <label key={q.id} className="deep-sheet-q">
                  <input
                    type="checkbox"
                    checked={kept.has(q.id)}
                    onChange={(e) =>
                      setKept((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(q.id);
                        else n.delete(q.id);
                        return n;
                      })
                    }
                  />
                  <span>{q.text}</span>
                  {q.kind === 'answer' && <span className="deep-muted"> · unread answer</span>}
                </label>
              ))}
            </div>
            <div className="deep-muted deep-sheet-note">Checked ones stay open.</div>
          </>
        )}

        <div className="deep-sheet-label">How deep was that?</div>
        <div className="deep-sheet-ratings" role="group" aria-label="How deep was that?">
          {RATINGS.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`deep-toggle${rating === r.value ? ' is-on' : ''}`}
              aria-pressed={rating === r.value}
              onClick={() => setRating((cur) => (cur === r.value ? null : r.value))}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="deep-sheet-label">Anything for agents while you're away?</div>
        <button className="deep-link" type="button" disabled={!copilotApi} onClick={() => setHandoff(true)}>
          Hand off…
        </button>

        {running > 0 && (
          <div className="deep-muted">
            {running} {running === 1 ? 'Ask' : 'Asks'} still running. Closing Lee stops {running === 1 ? 'it' : 'them'}; {running === 1 ? "it'll" : "they'll"} come back as Retry.
          </div>
        )}

        <div className="deep-sheet-actions">
          <span className="deep-muted">Esc ends without the sheet</span>
          <span className="deep-spacer" />
          <button className={`deep-btn${closeByDefault ? '' : ' is-primary'}`} type="button" disabled={busy} onClick={() => void finish('ritual', false)}>
            Stay open{!closeByDefault && <kbd>↵</kbd>}
          </button>
          <button className={`deep-btn${closeByDefault ? ' is-primary' : ''}`} type="button" disabled={busy} onClick={() => void finish('ritual', true)}>
            Close Lee{closeByDefault && <kbd>↵</kbd>}
          </button>
        </div>
      </div>
      {handoff && copilotApi && (
        <HandoffDialog api={copilotApi} workspace={workspace} onClose={() => setHandoff(false)} onLaunched={() => setHandoff(false)} />
      )}
    </div>,
    document.body,
  );
};

export default EndSessionSheet;
