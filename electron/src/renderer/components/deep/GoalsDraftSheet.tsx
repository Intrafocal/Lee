/**
 * GoalsDraftSheet - Draft goals from the Goals Page (Deep next R12; contract
 * §5). Runs the goal-edit steward (POST /cockpit/goals/draft) with the Page
 * as the instruction, then shows Hester's note and the proposed GOALS.md as
 * a diff against the current file. Apply (the sheet's one next step) writes
 * GOALS.md and doesn't commit; a 409 means the file changed since, so draft
 * again. Nothing is written until Apply. Esc or × closes.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { applyGoalDraft, draftGoals, type GoalDraftAnswer } from '../../lib/hesterCockpit';
import { goalsDraftInstruction } from '../../lib/hesterDeep';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { Btn } from '../cockpit/ui';
import './deep.css';
import './HandoffSheet.css';

type Phase =
  | { phase: 'loading' }
  | { phase: 'ready'; draft: GoalDraftAnswer }
  | { phase: 'applying'; draft: GoalDraftAnswer }
  | { phase: 'applied' }
  | { phase: 'error'; error: string; draft?: GoalDraftAnswer };

/** A unified diff, line by line: + and − tinted, headers dim. */
const Diff: React.FC<{ diff: string }> = ({ diff }) => (
  <pre className="goals-draft-diff">
    {diff.split('\n').map((line, i) => {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'is-file' : line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-del' : line.startsWith('@@') ? 'is-hunk' : '';
      return (
        <div key={i} className={cls}>
          {line || ' '}
        </div>
      );
    })}
  </pre>
);

export const GoalsDraftSheet: React.FC<{ workspace: string; page: string; onApplied?: () => void; onClose: () => void }> = ({ workspace, page, onApplied, onClose }) => {
  const [state, setState] = useState<Phase>({ phase: 'loading' });
  const seq = useRef(0);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    sheetRef.current?.focus({ preventScroll: true });
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const n = ++seq.current;
    setState({ phase: 'loading' });
    const r = await draftGoals(workspace, goalsDraftInstruction(page));
    if (!alive.current || n !== seq.current) return;
    setState(r.ok ? { phase: 'ready', draft: r.data } : { phase: 'error', error: r.error });
  }, [workspace, page]);

  useEffect(() => {
    void run();
  }, [run]);

  const apply = async (d: GoalDraftAnswer) => {
    if (!d.draft_id) return;
    const n = ++seq.current;
    setState({ phase: 'applying', draft: d });
    const r = await applyGoalDraft(workspace, d.draft_id);
    if (!alive.current || n !== seq.current) return;
    if (r.ok) {
      setState({ phase: 'applied' });
      onApplied?.();
    } else setState({ phase: 'error', draft: d, error: r.status === 409 ? 'GOALS.md changed since this draft. Draft again.' : r.error });
  };

  const draft = state.phase === 'ready' || state.phase === 'applying' ? state.draft : state.phase === 'error' ? state.draft ?? null : null;

  return ReactDOM.createPortal(
    <div
      className="deep-sheet-scrim handoff-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="deep-sheet goals-draft-sheet" role="dialog" aria-modal="true" aria-label="Draft goals" tabIndex={-1} data-view-root="" ref={sheetRef}>
        <div className="deep-sheet-head">
          <span>Draft goals</span>
          <span className="deep-spacer" />
          <button className="deep-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ×
          </button>
        </div>
        <div className="deep-muted">Hester drafts GOALS.md from this Page. Nothing is written until Apply, and nothing is committed.</div>

        {state.phase === 'loading' && <div className="deep-muted goals-draft-text">Drafting from your Page…</div>}
        {state.phase === 'applied' && <div className="goals-draft-text">GOALS.md written (not committed). Draft again as the Page changes.</div>}
        {draft?.text && (
          <div className="goals-draft-text">
            <AgentMarkdown text={draft.text} />
          </div>
        )}
        {draft && (draft.diff ? <Diff diff={draft.diff} /> : <div className="deep-muted goals-draft-text">No changes proposed.</div>)}
        {state.phase === 'error' && (
          <div className="handoff-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="deep-sheet-actions">
          <span className="deep-spacer" />
          {(state.phase === 'error' || state.phase === 'applied') && (
            <Btn kind="plain" onClick={() => void run()}>
              Draft again
            </Btn>
          )}
          <Btn kind="quiet" onClick={onClose}>
            {state.phase === 'applied' ? 'Close' : 'Discard'}
          </Btn>
          {state.phase !== 'applied' && (
            <Btn
              kind="next"
              disabled={!draft?.draft_id || !draft.diff || state.phase === 'applying' || state.phase === 'loading'}
              title="Write GOALS.md from this draft (not committed)"
              onClick={() => draft && void apply(draft)}
            >
              {state.phase === 'applying' ? 'Applying…' : 'Apply'}
            </Btn>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default GoalsDraftSheet;
