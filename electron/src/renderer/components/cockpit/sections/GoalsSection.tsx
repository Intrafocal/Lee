/**
 * GoalsSection - GOALS.md as a working surface (v4 contract §8.1). Data is
 * GET /cockpit/goals/status (deterministic, no model), refreshed when the
 * section opens and every 5 minutes by CockpitHost.
 *
 * One row per goal in priority order: metric chips, what serves it (expand
 * to list, click to select), "Nothing serving" when flagged, and when it was
 * last evaluated. Actions: Evaluate (a steward answer with proposals; offers
 * to run a stale measure first), Build toward (a workstream serving it),
 * Edit (GOALS.md in Manual) and Guided edit… (a proposed diff; Apply
 * writes only on that click, never commits). Below: tensions, constraints
 * and the human_balance strip. Sections have no keys (click only).
 *
 * Cockpit design §6.3: built from the primitives. Ember (a Dot) only on a
 * goal that needs you: nothing serving it, or its evaluation due. At most
 * one next step: Evaluate on the first goal whose evaluation is due; every
 * other action is plain or quiet. No count badges.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { OperationInfo } from '../../../../shared/cockpit';
import {
  balanceSegments,
  evaluationDue,
  formatAge,
  formatHours,
  formatMetricValue,
  trendArrow,
  type BalanceBand,
} from '../../../lib/cockpitModel';
import {
  applyGoalDraft,
  buildTowardGoal,
  draftGoals,
  evaluateGoal,
  workspacePath,
  type EvaluateAnswer,
  type GoalDraftAnswer,
  type GoalMetricStatus,
  type GoalStatus,
  type GoalsStatusResponse,
} from '../../../lib/hesterCockpit';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import { openItem } from '../Proposals';
import { RunOpDialog } from '../RunMenu';
import type { CockpitCtx, RowHandle } from '../CockpitHost';
import { Btn, Card, Dot, Eyebrow, Row, SectionHead } from '../ui';

const BAND_LABELS: Record<BalanceBand, string> = {
  Q1: 'Q1 important + urgent',
  Q2: 'Q2 important',
  Q3: 'Q3 urgent',
  Q4: 'Q4 neither',
  play: 'play',
  unclassified: 'unclassified',
};

const MetricChip: React.FC<{ m: GoalMetricStatus }> = ({ m }) => {
  const tone = m.ok === true ? ' is-ok' : m.ok === false ? ' is-bad' : '';
  const unit = m.target?.unit ?? null;
  const value = m.source === 'judged' ? 'judged' : formatMetricValue(m.value, unit);
  const arrow = trendArrow(m.trend);
  const title = [
    m.available ? `Available: ${m.available}` : null,
    m.previous != null ? `Previous: ${formatMetricValue(m.previous, unit)}` : null,
    m.source ? `Source: ${m.source}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`cockpit-metric${tone}`} title={title || undefined}>
      <span className="cockpit-metric-name">{m.name}</span> {value}
      {arrow && <span className="cockpit-metric-trend"> {arrow}</span>}
      {m.target_text && <span className="cockpit-muted"> → {m.target_text}</span>}
    </span>
  );
};

/** Colour a unified diff: + green, − ember, @@ dim. */
const DiffView: React.FC<{ diff: string }> = ({ diff }) => (
  <pre className="cockpit-diff">
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

type EvalState =
  | { phase: 'idle' }
  | { phase: 'loading'; note?: string }
  | { phase: 'measuring'; name: string }
  | { phase: 'done'; answer: EvaluateAnswer }
  | { phase: 'error'; error: string };

type DraftState =
  | { phase: 'closed' }
  | { phase: 'input' }
  | { phase: 'loading' }
  | { phase: 'ready'; draft: GoalDraftAnswer }
  | { phase: 'applying'; draft: GoalDraftAnswer }
  | { phase: 'error'; error: string; draft?: GoalDraftAnswer };

const GoalRow: React.FC<{
  ctx: CockpitCtx;
  goal: GoalStatus;
  handle: RowHandle;
  selected: boolean;
  /** This goal's Evaluate is the view's one next step (the first goal due). */
  next: boolean;
  onChanged: () => void;
}> = ({ ctx, goal, handle, selected, next, onChanged }) => {
  const [expanded, setExpanded] = useState(false);
  const [evalState, setEvalState] = useState<EvalState>({ phase: 'idle' });
  const [staleDeclined, setStaleDeclined] = useState(false);
  const [opDialog, setOpDialog] = useState<OperationInfo | null>(null);
  const [draft, setDraft] = useState<DraftState>({ phase: 'closed' });
  const [instruction, setInstruction] = useState('');
  const [building, setBuilding] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Request sequences: only the latest answer lands (Enter and clicks can race a slow one).
  const evalSeq = useRef(0);
  const draftSeq = useRef(0);

  const s = goal.serving;
  const servingCount = s.tasks.length + s.workstreams.length + s.explorations.length;

  const evaluate = async (note?: string) => {
    if (evalState.phase === 'loading') return;
    const seq = ++evalSeq.current;
    setEvalState({ phase: 'loading', note });
    setStaleDeclined(false);
    const r = await evaluateGoal(ctx.workspace, goal.id);
    if (!alive.current || seq !== evalSeq.current) return;
    if (r.ok) {
      setEvalState({ phase: 'done', answer: r.data });
      onChanged();
    } else setEvalState({ phase: 'error', error: r.error });
  };

  /** Run the stale measure, wait for its run to end (max 15 min), then evaluate again. */
  const measureThenEvaluate = async (name: string) => {
    if (!ctx.api) return;
    const op = ctx.ops?.operations.find((o) => o.def.name === name) ?? null;
    if (op && (op.def.confirm || (op.def.params ?? []).length)) {
      // Show the exact command first; evaluate again by hand when it is done.
      setOpDialog(op);
      return;
    }
    const seq = ++evalSeq.current;
    setEvalState({ phase: 'measuring', name });
    const r = await ctx.api.ops.run({ workspace: ctx.workspace, name });
    if (!alive.current || seq !== evalSeq.current) return;
    if (!r.success || !r.run) {
      setEvalState({ phase: 'error', error: r.error || `Could not run ${name}` });
      return;
    }
    const runId = r.run.run_id;
    const deadline = Date.now() + 15 * 60000;
    while (alive.current && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 3000));
      try {
        const snap = await ctx.api.ops.list(ctx.workspace);
        const info = snap.operations.find((o) => o.def.name === name);
        const run = info?.running?.run_id === runId ? info.running : info?.last_run?.run_id === runId ? info.last_run : null;
        if (run && run.status !== 'running') break;
      } catch {
        break;
      }
    }
    if (alive.current && seq === evalSeq.current) void evaluate(`after running ${name}`);
  };

  const buildToward = async () => {
    setBuilding(true);
    const r = await buildTowardGoal(ctx.workspace, goal.id);
    if (alive.current) setBuilding(false);
    if (!r.ok) {
      ctx.notify(r.error, 'error');
      return;
    }
    onChanged();
    ctx.openWorkstream(r.data.workstream_id, r.data.title);
  };

  const requestDraft = async () => {
    const text = instruction.trim();
    if (!text || draft.phase === 'loading' || draft.phase === 'applying') return;
    const seq = ++draftSeq.current;
    setDraft({ phase: 'loading' });
    const r = await draftGoals(ctx.workspace, text, goal.id);
    if (!alive.current || seq !== draftSeq.current) return;
    setDraft(r.ok ? { phase: 'ready', draft: r.data } : { phase: 'error', error: r.error });
  };

  const applyDraft = async (d: GoalDraftAnswer) => {
    if (!d.draft_id || draft.phase === 'applying') return;
    const seq = ++draftSeq.current;
    setDraft({ phase: 'applying', draft: d });
    const r = await applyGoalDraft(ctx.workspace, d.draft_id);
    if (!alive.current || seq !== draftSeq.current) return;
    if (r.ok) {
      ctx.notify('GOALS.md updated (not committed)');
      setDraft({ phase: 'closed' });
      setInstruction('');
      onChanged();
    } else {
      setDraft({
        phase: 'error',
        draft: d,
        error: r.status === 409 ? 'GOALS.md changed since this draft. Draft again.' : r.error,
      });
    }
  };

  const due = evaluationDue(goal.last_evaluated_at, ctx.now);
  const stale = evalState.phase === 'done' ? evalState.answer.stale_measure ?? null : null;
  const draftObj = draft.phase === 'ready' || draft.phase === 'applying' ? draft.draft : draft.phase === 'error' ? draft.draft ?? null : null;

  return (
    <Card className="cockpit-goal" selected={selected}>
      <div data-cockpit-row={handle.id} onClick={() => ctx.selectRow(handle.id)}>
        <div className="cockpit-goal-head">
          {(goal.flagged || due) && <Dot kind="needs" label={goal.flagged ? 'Nothing serving' : 'Evaluation due'} />}
          <span className="cockpit-goal-id">{goal.id}</span>
          <span className="cockpit-goal-title" title={goal.prose || goal.title}>
            {goal.title}
          </span>
          <span className="cockpit-goal-when">
            {goal.flagged && <span title="Nothing serves this goal and a metric is failing or trending the wrong way">Nothing serving · </span>}
            {goal.last_evaluated_at ? `evaluated ${formatAge(goal.last_evaluated_at, ctx.now)}` : 'never evaluated'}
            {due && goal.last_evaluated_at ? ' · due' : ''}
          </span>
        </div>
        {goal.metrics.length > 0 && (
          <div className="cockpit-chips cockpit-metrics">
            {goal.metrics.map((m) => (
              <MetricChip key={m.name} m={m} />
            ))}
          </div>
        )}
        <div className="cockpit-goal-meta">
          {servingCount === 0 && !goal.flagged ? (
            'Nothing serving'
          ) : servingCount > 0 ? (
            <button
              className="cockpit-goal-link"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((x) => !x);
              }}
              aria-expanded={expanded}
            >
              {expanded ? '▾' : '▸'} {s.tasks.length} task{s.tasks.length === 1 ? '' : 's'} · {s.workstreams.length} workstream
              {s.workstreams.length === 1 ? '' : 's'} · {s.explorations.length} exploration{s.explorations.length === 1 ? '' : 's'}
            </button>
          ) : null}
          {goal.focus_ms_7d > 0 ? ` · ${formatHours(goal.focus_ms_7d)} of your focus this week` : ' · none of your focus this week'}
        </div>
        {expanded && servingCount > 0 && (
          <div className="cockpit-goal-serving" onClick={(e) => e.stopPropagation()}>
            {s.tasks.map((t) => (
              <Row key={`t:${t.id}`} title={t.title} sub={`task · ${t.status}${t.quadrant ? ` · ${t.quadrant}` : ''}`} onOpen={() => void openItem(ctx, 'task', t.id)} />
            ))}
            {s.workstreams.map((w) => (
              <Row key={`w:${w.id}`} title={w.title} sub={`workstream · ${w.phase}`} onOpen={() => ctx.openWorkstream(w.id, w.title)} />
            ))}
            {s.explorations.map((x) => (
              <Row key={`x:${x.id}`} title={x.title} sub="exploration" onOpen={() => void openItem(ctx, 'exploration', x.id)} />
            ))}
          </div>
        )}
        <div className="cockpit-goal-actions" onClick={(e) => e.stopPropagation()}>
          <Btn
            kind={next ? 'next' : 'plain'}
            disabled={evalState.phase === 'loading' || evalState.phase === 'measuring'}
            title="Hester reads the evidence (metrics, what serves it, commits, your focus time) and says what to do"
            onClick={() => void evaluate()}
          >
            {evalState.phase === 'loading' ? 'Evaluating…' : 'Evaluate'}
          </Btn>
          <Btn kind="quiet" disabled={building} title={`Start a workstream that serves ${goal.id}`} onClick={() => void buildToward()}>
            Build toward
          </Btn>
          <Btn kind="quiet" onClick={() => ctx.openFile(workspacePath(ctx.workspace, 'GOALS.md'))}>
            Edit
          </Btn>
          <Btn
            kind="quiet"
            onClick={() => {
              draftSeq.current++;
              setDraft(draft.phase === 'closed' ? { phase: 'input' } : { phase: 'closed' });
            }}
          >
            Guided edit…
          </Btn>
        </div>

        {evalState.phase === 'loading' && (
          <div className="cockpit-muted cockpit-spinner-line">
            <span className="cockpit-spinner" /> Evaluating {goal.id}
            {evalState.note ? ` ${evalState.note}` : ''}…
          </div>
        )}
        {evalState.phase === 'measuring' && (
          <div className="cockpit-muted cockpit-spinner-line">
            <span className="cockpit-spinner" /> Running {evalState.name}, then evaluating again…
          </div>
        )}
        {evalState.phase === 'error' && <div className="cockpit-error">{evalState.error}</div>}
        {evalState.phase === 'done' && (
          <div onClick={(e) => e.stopPropagation()}>
            {stale && !staleDeclined && (
              <div className="cockpit-confirm">
                <div className="cockpit-muted">
                  <code>{stale}</code> has no reading in the last 24 h. Run it first, then evaluate again?
                </div>
                <div className="cockpit-row-actions">
                  <Btn kind="plain" disabled={!ctx.api} onClick={() => void measureThenEvaluate(stale)}>
                    Run {stale} and re-evaluate
                  </Btn>
                  <Btn kind="quiet" onClick={() => setStaleDeclined(true)}>
                    No, keep this answer
                  </Btn>
                </div>
              </div>
            )}
            <StewardAnswerView key={evalState.answer.request_id} ctx={ctx} answer={evalState.answer} onClose={() => setEvalState({ phase: 'idle' })} />
          </div>
        )}
        {opDialog && <RunOpDialog ctx={ctx} op={opDialog} onClose={() => setOpDialog(null)} />}

        {draft.phase !== 'closed' && (
          <div className="cockpit-confirm" onClick={(e) => e.stopPropagation()}>
            {(draft.phase === 'input' || draft.phase === 'loading' || (draft.phase === 'error' && !draft.draft)) && (
              <div className="cockpit-capture">
                <input
                  autoFocus
                  className="cockpit-input"
                  value={instruction}
                  placeholder={`How should ${goal.id} change? (Hester drafts GOALS.md; nothing is written until Apply)`}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void requestDraft();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setDraft({ phase: 'closed' });
                    }
                  }}
                />
                <Btn kind="plain" disabled={draft.phase === 'loading' || !instruction.trim()} onClick={() => void requestDraft()}>
                  {draft.phase === 'loading' ? 'Drafting…' : 'Draft'}
                </Btn>
              </div>
            )}
            {draftObj && (
              <>
                {draftObj.text && <AgentMarkdown text={draftObj.text} />}
                {draftObj.diff ? <DiffView diff={draftObj.diff} /> : <div className="cockpit-muted">No changes proposed.</div>}
                <div className="cockpit-row-actions">
                  <Btn
                    kind="plain"
                    disabled={draft.phase === 'applying' || !draftObj.diff}
                    title="Write GOALS.md from this draft (not committed)"
                    onClick={() => void applyDraft(draftObj)}
                  >
                    {draft.phase === 'applying' ? 'Applying…' : 'Apply'}
                  </Btn>
                  <Btn kind="quiet" onClick={() => setDraft({ phase: 'closed' })}>
                    Discard
                  </Btn>
                </div>
              </>
            )}
            {draft.phase === 'error' && <div className="cockpit-error">{draft.error}</div>}
          </div>
        )}
      </div>
    </Card>
  );
};

const BalanceStrip: React.FC<{ balance: GoalsStatusResponse['human_balance'] }> = ({ balance }) => {
  const segs = balanceSegments(balance.ms);
  const total = segs.reduce((a, s) => a + s.ms, 0);
  return (
    <div className="cockpit-balance">
      <Eyebrow right={balance.share != null ? `${Math.round(balance.share * 100)}% important (Q1 + Q2)` : undefined}>Your time this week</Eyebrow>
      <div className="cockpit-balance-bar" role="img" aria-label={balance.line}>
        {total > 0 &&
          segs
            .filter((s) => s.ms > 0)
            .map((s) => <span key={s.band} className={`cockpit-balance-seg band-${s.band}`} style={{ width: `${s.share * 100}%` }} title={`${BAND_LABELS[s.band]}: ${formatHours(s.ms)}`} />)}
      </div>
      <div className="cockpit-balance-legend">
        {segs.map((s) => (
          <span key={s.band} className="cockpit-balance-key">
            <span className={`cockpit-balance-swatch band-${s.band}`} /> {s.band} {formatHours(s.ms)}
          </span>
        ))}
      </div>
      {balance.line && <div className="cockpit-goals-line">{balance.line}</div>}
    </div>
  );
};

export const GoalsSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const { data, error, loading, refresh } = ctx.goals;
  // Fresh on open (the host also refreshes every 5 minutes).
  useEffect(() => {
    refresh();
  }, [refresh]);

  const goals = [...(data?.goals ?? [])].sort((a, b) => a.priority - b.priority);
  const handles: RowHandle[] = goals.map((g) => ({
    id: `goal:${g.id}`,
    title: `${g.id} ${g.title}`,
    about: { kind: 'goal', id: g.id, label: `${g.id} ${g.title}` },
  }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const constraints = data?.constraints ?? [];
  // The one next step: Evaluate on the first goal (by priority) whose evaluation is due.
  const nextId = goals.find((g) => evaluationDue(g.last_evaluated_at, ctx.now))?.id ?? null;

  return (
    <section className="cockpit-sec cockpit-goals">
      <SectionHead
        title="Goals"
        summary={data ? `${goals.length} goal${goals.length === 1 ? '' : 's'} · from GOALS.md` : 'GOALS.md'}
        right={
          <Btn kind="quiet" onClick={refresh} disabled={loading} title="Refresh goal status">
            Refresh
          </Btn>
        }
      />
      {error && !data && <div className="cockpit-offline">{error}: goal status needs Hester.</div>}
      {!data && !error && <div className="cockpit-muted">Loading…</div>}
      {data && goals.length === 0 && (
        <div className="cockpit-empty">
          No goals in GOALS.md.{' '}
          <Btn kind="quiet" onClick={() => ctx.openFile(workspacePath(ctx.workspace, 'GOALS.md'))}>
            Open GOALS.md
          </Btn>
        </div>
      )}
      <div className="cockpit-goal-list">
        {goals.map((g, i) => (
          // Keyed by workspace too: a switch drops that goal's Evaluate/draft state.
          <GoalRow
            key={`${ctx.workspace}:${g.id}`}
            ctx={ctx}
            goal={g}
            handle={handles[i]}
            selected={sel?.kind === 'row' && sel.id === handles[i].id}
            next={g.id === nextId}
            onChanged={refresh}
          />
        ))}
      </div>
      {data && data.tensions.length > 0 && (
        <>
          <Eyebrow>Tensions</Eyebrow>
          <Card>
            {data.tensions.map((t) => (
              <Row
                key={`${t.a}-${t.b}-${t.label}`}
                title={`${t.a} → ${t.b} (${t.label})`}
                sub={t.default || undefined}
                meta={t.arbiter ? `arbiter ${t.arbiter}` : undefined}
              />
            ))}
          </Card>
        </>
      )}
      {constraints.length > 0 && (
        <>
          <Eyebrow>Constraints</Eyebrow>
          <Card>
            {constraints.map((c) => (
              <Row
                key={c.id}
                dot={c.violations ? 'needs' : undefined}
                title={`${c.id} ${c.title}`}
                meta={c.violations == null ? 'not measured' : `${c.violations} violation${c.violations === 1 ? '' : 's'}`}
              />
            ))}
          </Card>
        </>
      )}
      {data?.human_balance && <BalanceStrip balance={data.human_balance} />}
    </section>
  );
};

export default GoalsSection;
