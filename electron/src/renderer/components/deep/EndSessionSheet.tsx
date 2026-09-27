/**
 * EndSessionSheet - the ending ritual (Deep D1 §9). One small sheet, no
 * chord, nothing required:
 *
 * 1. Where did you stop? (pre-filled with the last sentence written)
 * 2. Open questions: this session's marked `?` lines, checked ("keep
 *    open") by default. Unchecked questions are closed.
 * 3. This session (Deep next R6, replacing D1's hand-off step):
 *    - Asked: this session's Asks with their state; unread and pending ones
 *      are checked (kept open), and an unchecked unread one is marked read;
 *    - Handed off: each hand-off with its kind and state;
 *    - Still open on the Page: unanswered question lines and
 *      requirement-style sections, each one click from Ask or Hand off.
 *    The v1 hand-off dialog lives in Work's ⋯ menu now.
 * 4. How deep was that? Deep / mixed / shallow, none selected.
 * 5. Close Lee (the default, Enter) or Stay open. While Asks or hand-offs
 *    are still running, a line says so and Stay open becomes the default:
 *    closing Lee stops them, and Enter must never quietly stop work.
 *
 * Either button writes the SessionRecord, ends the Deep session and returns
 * this window to the Cockpit; Close Lee then quits. Esc ends the session
 * unrated (reason 'esc'). The × means "never mind" and keeps the session.
 * No timers, no reminders.
 *
 * Desk D2 (contract §7.2): at the Desk the sheet first lists the cards you
 * touched this session (titles in Newsreader, one click zooms back), and the
 * Asked, Handed off and Still open lists span them (each item carries its
 * card). The record goes to POST /desk/sessions with cards_touched,
 * stopped_card_id and questions_kept as card-and-question pairs.
 *
 * Look (cockpit-design §6.1): the Cockpit primitives. "Where did you stop?"
 * and the questions are your words, in Newsreader; the default action is the
 * sheet's one `Btn next`, the other `plain`.
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { DepthRating } from '../../../shared/cockpit';
import type { CopilotAPI, FocusState } from '../../../shared/copilot';
import { cockpitModeStore } from '../cockpit/cockpitMode';
import { Btn } from '../cockpit/ui';
import {
  handoffKindLabel,
  patchAnswer,
  patchQuestion,
  postSession,
  type SessionAsk,
  type SessionHandoff,
  type StillOpen,
} from '../../lib/hesterDeep';
import { postDeskSession } from '../../lib/hesterDesk';
import { deepEnd, quitLee } from './deepBridge';
import './deep.css';
import './HandoffSheet.css';

export interface RitualQuestion {
  id: string;
  kind: 'question' | 'answer';
  text: string;
  /** The card it's on (Desk); absent = the stopped-at card. */
  card_id?: string;
}

/** A ritual item from one of the touched cards (Desk). */
type OnCard = { card_id?: string; card_title?: string };

/** The Desk's part of the ritual: the touched cards and where you stopped. */
export interface RitualDesk {
  touched: Array<{ id: string; title: string }>;
  /** The card the stopped-at line is in (the last card zoomed into). */
  stoppedCardId: string | null;
  /** Zoom back into a touched card (the sheet closes; the session goes on). */
  onZoom?: (cardId: string) => void;
}

interface EndSessionSheetProps {
  workspace: string;
  explorationId: string | null;
  /** The last sentence written on the Page. */
  prefill: string;
  questions: RitualQuestion[];
  focus: FocusState | null;
  /** Unused since the hand-off step moved to Work (kept so older callers still type). */
  copilotApi?: CopilotAPI | null;
  /** Asks still queued or running; closing Lee stops them (they come back as Retry). */
  running?: number;
  /** Hand-offs still launching, running or waiting; closing Lee stops their agents. */
  runningHandoffs?: number;
  /** R6 "This session": what was asked and handed off, and what's still open on the Page (or the touched cards). */
  session?: { asked: Array<SessionAsk & OnCard>; handedOff: Array<SessionHandoff & OnCard>; stillOpen: Array<StillOpen & OnCard> };
  /** Ask about a still-open item (its line, with its section). */
  onAsk?: (item: StillOpen & OnCard) => void;
  /** Hand off a still-open item (opens the Hand off sheet over this one). */
  onHandOff?: (item: StillOpen & OnCard) => void;
  /** At the Desk: the touched cards; the record goes to /desk/sessions. */
  desk?: RitualDesk;
  /** Another sheet is open over this one: its keys aren't ours. */
  suspended?: boolean;
  /** Called before anything is written, so the Page can flush its last save. */
  beforeEnd?: () => Promise<void>;
  /** After the session record is written and the session ended (not on ×): the Page may clean up after itself. */
  onEnded?: () => void;
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
  running = 0,
  runningHandoffs = 0,
  session,
  onAsk,
  onHandOff,
  suspended = false,
  beforeEnd,
  onEnded,
  onClose,
  desk,
}) => {
  const closeByDefault = running + runningHandoffs === 0;
  const asked = session?.asked ?? [];
  const handedOff = session?.handedOff ?? [];
  const stillOpen = session?.stillOpen ?? [];
  const [stoppedAt, setStoppedAt] = useState(prefill);
  const [kept, setKept] = useState<Set<string>>(() => new Set(questions.map((q) => q.id)));
  // Asks you marked resolved (the rest stay open); the list is live, so new Asks start open.
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const [rating, setRating] = useState<DepthRating | null>(null);
  const [actedOn, setActedOn] = useState<Record<string, 'asked'>>({});
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
    const openAsks = asked.filter((a) => a.state === 'unread' || a.state === 'pending');
    const keptIds = ritual
      ? [...questions.filter((q) => kept.has(q.id)).map((q) => q.id), ...openAsks.filter((a) => !resolved.has(a.id)).map((a) => a.id)]
      : [...questions.map((q) => q.id), ...openAsks.map((a) => a.id)];
    const writes: Array<Promise<unknown>> = [];
    if (desk) {
      // Desk D2 §5.2: one record for the session, across the touched cards.
      const home = desk.stoppedCardId ?? explorationId;
      const cardOf = (id: string): string | null =>
        questions.find((q) => q.id === id)?.card_id ?? asked.find((a) => a.id === id)?.card_id ?? home ?? null;
      const refs = keptIds.map((id) => ({ card_id: cardOf(id), question_id: id })).filter((r): r is { card_id: string; question_id: string } => !!r.card_id);
      writes.push(
        postDeskSession(workspace, {
          focus_session_id: focus?.session_id ?? '',
          started_at: focus?.started_at ?? ended,
          ended_at: ended,
          reason,
          stopped_at: stopped,
          stopped_card_id: desk.stoppedCardId,
          rating: ritual ? rating : null,
          questions_kept: refs,
          cards_touched: desk.touched.map((c) => c.id),
        }),
      );
      if (ritual) {
        for (const q of questions) {
          const cid = q.card_id ?? home;
          if (kept.has(q.id) || !cid) continue;
          writes.push(q.kind === 'question' ? patchQuestion(workspace, cid, q.id, 'closed') : patchAnswer(workspace, cid, q.id, { read: true }));
        }
        for (const a of asked) {
          const cid = a.card_id ?? home;
          if (a.state === 'unread' && resolved.has(a.id) && cid) writes.push(patchAnswer(workspace, cid, a.id, { read: true }));
        }
      }
    } else if (explorationId) {
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
        // An Ask you marked resolved: read (a pending one is left to finish).
        for (const a of asked) if (a.state === 'unread' && resolved.has(a.id)) writes.push(patchAnswer(workspace, explorationId, a.id, { read: true }));
      }
    }
    await Promise.allSettled(writes);
    await deepEnd(ritual ? { reason: 'ritual', rating, stopped_at_chars: stopped ? stopped.length : 0 } : { reason: 'esc', rating: null, ...(stopped ? { stopped_at_chars: stopped.length } : {}) });
    cockpitModeStore.set('cockpit', 'deep_end');
    onEnded?.();
    onClose();
    if (close) quitLee();
  };

  // Esc and Enter on window, in the capture phase: they work wherever focus
  // has gone (body after a click on bare sheet space, or after Hand off…
  // closes), not only inside the sheet (§0: Esc always works).
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if (suspended || e.isComposing) return;
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

  // Back from the Hand off sheet: focus returns to this one so the keys keep a home.
  const wasSuspended = useRef(false);
  useEffect(() => {
    if (wasSuspended.current && !suspended) sheetRef.current?.focus({ preventScroll: true });
    wasSuspended.current = suspended;
  }, [suspended]);

  const toggleKept = (id: string, on: boolean) =>
    setKept((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return ReactDOM.createPortal(
    <div className="deep-sheet-scrim">
      <div ref={sheetRef} className="deep-sheet" role="dialog" aria-modal="true" aria-label="End session" tabIndex={-1} data-view-root="">
        <div className="deep-sheet-head">
          <span>End session</span>
          <span className="deep-spacer" />
          <button className="deep-icon-btn" onClick={onClose} title="Never mind: keep the session" aria-label="Keep the session">
            ×
          </button>
        </div>

        {desk && desk.touched.length > 0 && (
          <>
            <div className="deep-sheet-label">{desk.touched.length === 1 ? 'The card you worked on' : 'The cards you worked on'}</div>
            <div className="desk-touched" role="list">
              {desk.touched.map((c) => (
                <button
                  key={c.id}
                  role="listitem"
                  className={`desk-touched-card${c.id === desk.stoppedCardId ? ' is-last' : ''}`}
                  disabled={!desk.onZoom}
                  onClick={() => {
                    onClose();
                    desk.onZoom?.(c.id);
                  }}
                  title="Back to this card"
                >
                  {c.title || 'Untitled'}
                </button>
              ))}
            </div>
          </>
        )}

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
          placeholder="Optional. A sentence to pick up from."
          onChange={(e) => setStoppedAt(e.target.value)}
        />

        {questions.length > 0 && (
          <>
            <div className="deep-sheet-label">Open questions</div>
            <div className="deep-sheet-questions">
              {questions.map((q) => (
                <label key={q.id} className="deep-sheet-q">
                  <input type="checkbox" checked={kept.has(q.id)} onChange={(e) => toggleKept(q.id, e.target.checked)} />
                  <span className="deep-sheet-q-text">{q.text}</span>
                  {q.kind === 'answer' && <span className="deep-muted"> · unread answer</span>}
                </label>
              ))}
            </div>
            <div className="deep-muted deep-sheet-note">Checked ones stay open.</div>
          </>
        )}

        <div className="deep-sheet-label">This session</div>
        {asked.length === 0 && handedOff.length === 0 && stillOpen.length === 0 && (
          <div className="deep-muted">Nothing asked or handed off, and nothing left open on the Page.</div>
        )}
        {asked.length > 0 && (
          <div className="session-group" role="group" aria-label="Asked">
            <div className="session-group-label">Asked</div>
            {asked.map((a) => {
              const open = a.state === 'unread' || a.state === 'pending';
              return (
                <label key={a.id} className="session-row" title={open ? 'Checked stays open; unchecked is resolved' : undefined}>
                  {open ? (
                    <input
                      type="checkbox"
                      checked={!resolved.has(a.id)}
                      onChange={(e) =>
                        setResolved((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.delete(a.id);
                          else n.add(a.id);
                          return n;
                        })
                      }
                    />
                  ) : (
                    <span className="session-row-state">✓</span>
                  )}
                  <span className="session-row-text">{a.question}</span>
                  <span className="session-row-state">
                    {a.card_title ? `${a.card_title} · ` : ''}
                    {a.label}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {handedOff.length > 0 && (
          <div className="session-group" role="group" aria-label="Handed off">
            <div className="session-group-label">Handed off</div>
            {handedOff.map((h) => (
              <div key={h.id} className="session-row">
                <span className="session-row-text">{h.question}</span>
                <span className="session-row-state">
                  {h.card_title ? `${h.card_title} · ` : ''}
                  {handoffKindLabel(h.kind)} · {h.label}
                </span>
              </div>
            ))}
          </div>
        )}
        {stillOpen.length > 0 && (
          <div className="session-group" role="group" aria-label="Still open on the Page">
            <div className="session-group-label">{desk && desk.touched.length > 1 ? 'Still open on these Pages' : 'Still open on the Page'}</div>
            {stillOpen.map((o) => (
              <div key={`${o.card_id ?? ''}:${o.kind}:${o.text}`} className="session-row">
                <span className={`session-row-text${o.kind === 'requirements' ? ' is-block' : ''}`}>{o.text}</span>
                {actedOn[`${o.kind}:${o.text}`] ? (
                  <span className="session-row-state">asked</span>
                ) : (
                  <span className="session-row-actions">
                    {onAsk && (
                      <Btn
                        kind="quiet"
                        onClick={() => {
                          onAsk(o);
                          setActedOn((m) => ({ ...m, [`${o.kind}:${o.text}`]: 'asked' }));
                        }}
                      >
                        Ask
                      </Btn>
                    )}
                    {onHandOff && (
                      <Btn kind="quiet" onClick={() => onHandOff(o)}>
                        Hand off
                      </Btn>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="deep-sheet-label">How deep was that?</div>
        <div className="deep-sheet-ratings" role="group" aria-label="How deep was that?">
          {RATINGS.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`deep-rating${rating === r.value ? ' is-on' : ''}`}
              aria-pressed={rating === r.value}
              onClick={() => setRating((cur) => (cur === r.value ? null : r.value))}
            >
              {r.label}
            </button>
          ))}
        </div>

        {running > 0 && (
          <div className="deep-muted">
            {running} {running === 1 ? 'Ask' : 'Asks'} still running. Closing Lee stops {running === 1 ? 'it' : 'them'}; {running === 1 ? "it'll" : "they'll"} come back as Retry.
          </div>
        )}
        {runningHandoffs > 0 && (
          <div className="deep-muted">
            {runningHandoffs} {runningHandoffs === 1 ? 'hand-off is' : 'hand-offs are'} still out with an agent. Closing Lee stops {runningHandoffs === 1 ? 'it' : 'them'}; {runningHandoffs === 1 ? "it'll" : "they'll"} come back as Retry.
          </div>
        )}

        <div className="deep-sheet-actions">
          <span className="deep-muted">Esc ends without the sheet</span>
          <span className="deep-spacer" />
          <Btn kind={closeByDefault ? 'plain' : 'next'} kbd={closeByDefault ? undefined : '↵'} disabled={busy} onClick={() => void finish('ritual', false)}>
            Stay open
          </Btn>
          <Btn kind={closeByDefault ? 'next' : 'plain'} kbd={closeByDefault ? '↵' : undefined} disabled={busy} onClick={() => void finish('ritual', true)}>
            Close Lee
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default EndSessionSheet;
