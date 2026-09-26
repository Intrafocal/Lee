/**
 * TasksSection - Hester's task records for this workspace (contracts §4.2,
 * §6.3): running, waiting, idle, review, queued, then closed in the last 7
 * days. Confirm, Link…, Accept/Discard, Promote…, Escalate → Explore, Peek,
 * Check in.
 *
 * v4 §8.5: open tasks order by status, then quadrant (Q1, Q2, Q3,
 * unclassified, Q4), then importance. Each row has a quadrant chip (click:
 * Important / Urgent on/off/auto overrides), Hester's view (/suggest, shown
 * inline with proposals) and Focus on this (a task focus item).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../Icon';
import type { CockpitTask, StewardAnswer, TaskStatus } from '../../../../shared/cockpit';
import {
  formatAge,
  formatDuration,
  overrideChoice,
  overridePatch,
  plainPreview,
  quadrantChip,
  quadrantRank,
  taskNeedsYou,
  taskTitle,
  type OverrideChoice,
} from '../../../lib/cockpitModel';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import {
  closeTask,
  confirmTask,
  escalateTask,
  fetchGoals,
  fetchWorkstreams,
  patchTask,
  promoteTask,
  suggestTask,
  type GoalRef,
  type HesterResult,
  type WorkstreamRef,
} from '../../../lib/hesterCockpit';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

/** link-goal requests already handled (per window), so a remount never replays one. */
let handledLinkNonce = 0;

const ORDER: TaskStatus[] = ['running', 'waiting', 'idle', 'review', 'queued', 'done', 'discarded'];

function sortTasks(tasks: CockpitTask[]): CockpitTask[] {
  return [...tasks].sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      quadrantRank(a.quadrant) - quadrantRank(b.quadrant) ||
      (a.importance_rank ?? 99) - (b.importance_rank ?? 99) ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
}

const LinkPicker: React.FC<{ ctx: CockpitCtx; task: CockpitTask; onDone: () => void }> = ({ ctx, task, onDone }) => {
  const [goals, setGoals] = useState<GoalRef[] | null>(null);
  const [streams, setStreams] = useState<WorkstreamRef[]>([]);
  const [serves, setServes] = useState<string[]>(task.serves);
  const [workstream, setWorkstream] = useState<string>(task.workstream ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGoals(ctx.workspace).then((r) => {
      if (!cancelled) setGoals(r.ok ? r.data : []);
    });
    fetchWorkstreams(ctx.workspace).then((r) => {
      if (!cancelled && r.ok) setStreams(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.workspace]);

  const save = () => {
    ctx.copilotApi?.logCeremony('assign', 'task-link');
    confirmTask(ctx.workspace, task.id, { serves, workstream: workstream || null }).then((r) => {
      if (r.ok) {
        ctx.hester.refresh();
        onDone();
      } else setError(r.error);
    });
  };

  return (
    <div className="cockpit-confirm" onClick={(e) => e.stopPropagation()}>
      {goals === null && <div className="cockpit-muted">Loading goals…</div>}
      {goals && goals.length === 0 && <div className="cockpit-muted">No goals in GOALS.md.</div>}
      <div className="cockpit-chips">
        {(goals ?? []).map((g) => (
          <button
            key={g.id}
            className={`cockpit-chip-btn${serves.includes(g.id) ? ' is-on' : ''}`}
            title={g.title}
            onClick={() => setServes((s) => (s.includes(g.id) ? s.filter((x) => x !== g.id) : [...s, g.id]))}
          >
            {g.id} {g.title}
          </button>
        ))}
      </div>
      {streams.length > 0 && (
        <select className="cockpit-input" value={workstream} onChange={(e) => setWorkstream(e.target.value)}>
          <option value="">No workstream</option>
          {streams.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
      )}
      {error && <div className="cockpit-error">{error}</div>}
      <div className="cockpit-row-actions">
        <button className="cockpit-btn is-primary" onClick={save}>
          Save links
        </button>
        <button className="cockpit-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
};

const OVERRIDE_CHOICES: OverrideChoice[] = ['on', 'off', 'auto'];

/** The quadrant chip's menu: Important and Urgent, each on/off/auto (auto clears the override). */
const QuadrantMenu: React.FC<{ ctx: CockpitCtx; task: CockpitTask; onDone: () => void }> = ({ ctx, task, onDone }) => {
  const [busy, setBusy] = useState(false);
  const pick = (axis: 'important' | 'urgent', choice: OverrideChoice) => {
    if (busy || overrideChoice(task.overrides, axis) === choice) return;
    setBusy(true);
    patchTask(ctx.workspace, task.id, overridePatch(axis, choice)).then((r) => {
      setBusy(false);
      if (r.ok) {
        ctx.hester.refresh();
        onDone();
      } else ctx.notify(r.error, 'error');
    });
  };
  const derived = [
    task.serves.length ? `serves ${task.serves.join(', ')}` : 'serves no goal',
    task.urgency ? `urgent: ${task.urgency.signal}${task.urgency.ref ? ` (${task.urgency.ref})` : ''}` : 'no urgency signal',
  ].join(' · ');
  return (
    <div className="cockpit-quadrant-menu" role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="cockpit-muted">{derived}</div>
      {(['important', 'urgent'] as const).map((axis) => {
        const cur = overrideChoice(task.overrides, axis);
        return (
          <div key={axis} className="cockpit-quadrant-axis">
            <span className="cockpit-quadrant-axis-label">{axis === 'important' ? 'Important' : 'Urgent'}</span>
            {OVERRIDE_CHOICES.map((c) => (
              <button
                key={c}
                role="menuitemradio"
                aria-checked={cur === c}
                className={`cockpit-chip-btn${cur === c ? ' is-on' : ''}`}
                disabled={busy}
                title={c === 'auto' ? 'Derived from goals and urgency signals' : undefined}
                onClick={() => pick(axis, c)}
              >
                {c}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
};

type ViewState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; answer: StewardAnswer } | { phase: 'error'; error: string };

const TaskRow: React.FC<{ ctx: CockpitCtx; task: CockpitTask; selected: boolean; handle: RowHandle }> = ({ ctx, task, selected, handle }) => {
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quadMenu, setQuadMenu] = useState(false);
  const [view, setView] = useState<ViewState>({ phase: 'idle' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A lint fix's renderer_action 'link-goal' opens this task's goal picker.
  const pending = ctx.pendingSteward;
  useEffect(() => {
    if (!pending || pending.nonce <= handledLinkNonce) return;
    if (pending.req.kind !== 'link-goal' || pending.req.taskId !== task.id) return;
    handledLinkNonce = pending.nonce;
    setLinking(true);
    ctx.selectRow(handle.id);
    document.querySelector(`[data-cockpit-row="${CSS.escape(handle.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [pending, task.id, handle.id, ctx]);

  const viewSeq = useRef(0);
  const hesterView = () => {
    if (view.phase === 'loading') return;
    const seq = ++viewSeq.current;
    setView({ phase: 'loading' });
    suggestTask(ctx.workspace, task.id).then((r) => {
      if (!alive.current || seq !== viewSeq.current) return;
      setView(r.ok ? { phase: 'done', answer: r.data } : { phase: 'error', error: r.error });
    });
  };

  const focusOn = () => {
    const api = ctx.copilotApi;
    if (!api) {
      ctx.notify('Focus is not available here', 'error');
      return;
    }
    const label = taskTitle(task) || task.title;
    api
      .focusStart({ kind: 'task', workspace: ctx.workspace, task_id: task.id, label })
      .then(() => ctx.notify(`Focusing on ${label}`))
      .catch(() => ctx.notify('Could not start focus', 'error'));
  };
  const chip = quadrantChip(task);
  const tile = task.agent?.pty_id != null ? ctx.tiles.find((t) => t.ptyId === task.agent?.pty_id) ?? null : null;
  const closed = task.status === 'done' || task.status === 'discarded';

  const run = <T,>(fn: () => Promise<HesterResult<T>>, ok?: string) => {
    setBusy(true);
    fn()
      .then((r) => {
        if (r.ok) {
          ctx.hester.refresh();
          if (ok) ctx.notify(ok);
        } else ctx.notify(r.error, 'error');
      })
      .finally(() => setBusy(false));
  };

  const meta = [
    task.lead === 'human' ? 'you lead' : task.lead,
    task.kind !== 'unknown' ? task.kind : null,
    task.play ? 'play' : null,
    task.busy_ms > 0 ? `${formatDuration(task.busy_ms)} busy` : null,
    task.files_count ? `${task.files_count} files` : null,
    task.serves.length ? `serves ${task.serves.join(', ')}` : null,
    task.workstream ? `workstream ${task.workstream}` : null,
    task.origin && task.origin.kind !== 'launcher' ? `from ${task.origin.kind}` : null,
    closed ? formatAge(task.closed_at, ctx.now) : formatAge(task.updated_at, ctx.now),
  ].filter(Boolean);

  return (
    <div
      data-cockpit-row={handle.id}
      className={`cockpit-row${selected ? ' is-selected' : ''}${closed ? ' is-closed' : ''}`}
      onClick={() => ctx.selectRow(handle.id)}
      onDoubleClick={() => handle.open?.()}
    >
      <div className="cockpit-row-head">
        <span className={`cockpit-status st-${task.status}`}>{task.status}</span>
        {closed ? (
          <span className={`cockpit-quadrant q-${chip.tone}`}>{chip.label}</span>
        ) : (
          <button
            className={`cockpit-quadrant q-${chip.tone}${task.overrides && (task.overrides.important != null || task.overrides.urgent != null) ? ' is-overridden' : ''}`}
            title="Important / urgent (click to override)"
            aria-haspopup="menu"
            aria-expanded={quadMenu}
            onClick={(e) => {
              e.stopPropagation();
              setQuadMenu((m) => !m);
            }}
          >
            {chip.label}
          </button>
        )}
        <span className="cockpit-row-title" title={task.title}>
          {taskTitle(task) || task.title}
        </span>
        {!task.confirmed && <span className="cockpit-tag">unconfirmed</span>}
        {task.accepted === true && <span className="cockpit-tag is-ok">accepted</span>}
      </div>
      {quadMenu && !closed && <QuadrantMenu ctx={ctx} task={task} onDone={() => setQuadMenu(false)} />}
      <div className="cockpit-row-meta">{meta.join(' · ')}</div>
      {task.summary && !closed &&
        (selected ? (
          <div className="cockpit-agent-words is-expanded">
            <span className="cockpit-agent-label">Agent says:</span>
            <AgentMarkdown text={task.summary} />
          </div>
        ) : (
          <div className="cockpit-agent-words">
            <span className="cockpit-agent-label">Agent says:</span> {plainPreview(task.summary) || '(code)'}
          </div>
        ))}
      {closed && task.outcome && <div className="cockpit-row-text">{task.outcome}</div>}
      {linking ? (
        <LinkPicker ctx={ctx} task={task} onDone={() => setLinking(false)} />
      ) : (
        !closed && (
          <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
            {!task.confirmed && (
              <button
                className="cockpit-btn is-primary"
                disabled={busy}
                onClick={() => {
                  ctx.copilotApi?.logCeremony('confirm', 'task-confirm');
                  run(() => confirmTask(ctx.workspace, task.id));
                }}
              >
                Confirm
              </button>
            )}
            <button className="cockpit-btn" disabled={busy} onClick={() => setLinking(true)}>
              Link…
            </button>
            {task.status === 'review' && (
              <>
                <button className="cockpit-btn" disabled={busy} onClick={() => run(() => closeTask(ctx.workspace, task.id, { status: 'done', accepted: true }), 'Accepted')}>
                  Accept
                </button>
                <button className="cockpit-btn" disabled={busy} onClick={() => run(() => closeTask(ctx.workspace, task.id, { status: 'discarded' }), 'Discarded')}>
                  Discard
                </button>
              </>
            )}
            <button
              className="cockpit-btn"
              disabled={busy || !!task.workstream}
              onClick={() => run(() => promoteTask(ctx.workspace, task.id, task.name || undefined), 'Promoted to a workstream')}
            >
              Promote…
            </button>
            <button
              className="cockpit-btn"
              disabled={busy}
              title="Open an exploration seeded from this task (the task stays open)"
              onClick={() => {
                setBusy(true);
                escalateTask(ctx.workspace, task.id)
                  .then((r) => {
                    if (!r.ok) {
                      ctx.notify(r.error, 'error');
                      return;
                    }
                    ctx.hester.refresh();
                    ctx.notify(`Exploration started: ${r.data.exploration.title}`);
                    ctx.setSection('explore');
                    ctx.selectRow(`explore:${r.data.exploration.id}`);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Escalate → Explore
            </button>
            {tile && (
              <button className="cockpit-btn" onClick={() => ctx.goInto(tile.ptyId, 'tabs')}>
                <Icon name="arrow-right" size={11} /> Peek
              </button>
            )}
            {tile?.canCheckin && (
              <button className="cockpit-btn" onClick={() => ctx.openCheckin(tile.ptyId, taskTitle(task) || tile.title)}>
                Check in
              </button>
            )}
            <button className="cockpit-btn" title="Rename (⌘E)" onClick={() => handle.rename?.()}>
              Rename
            </button>
            <button
              className="cockpit-btn"
              disabled={view.phase === 'loading'}
              title="Which goals this might serve, a better lead, where to start"
              onClick={hesterView}
            >
              {view.phase === 'loading' ? 'Asking…' : "Hester's view"}
            </button>
            <button className="cockpit-btn" title="Start focus on this task: its agent's items count as related" onClick={focusOn}>
              Focus on this
            </button>
          </div>
        )
      )}
      {view.phase === 'error' && <div className="cockpit-error">{view.error}</div>}
      {view.phase === 'done' && (
        <div onClick={(e) => e.stopPropagation()}>
          <StewardAnswerView key={view.answer.request_id} ctx={ctx} answer={view.answer} onClose={() => setView({ phase: 'idle' })} />
        </div>
      )}
    </div>
  );
};

export const TasksSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const snap = ctx.hester.snapshot;
  const open = sortTasks(snap?.tasks.open ?? []);
  const closed = sortTasks(snap?.tasks.recent_closed ?? []);
  const all = [...open, ...closed];
  const handles: RowHandle[] = all.map((t) => {
    const pty = t.agent?.pty_id ?? null;
    const tile = pty != null ? ctx.tiles.find((x) => x.ptyId === pty) : undefined;
    return {
      id: `task:${t.id}`,
      title: taskTitle(t) || t.title,
      ptyId: pty,
      open: tile ? () => ctx.goInto(tile.ptyId, 'tabs') : undefined,
      approval: tile?.approval ?? null,
      replyItem: tile?.replyItem ?? null,
      about: { kind: 'task', id: t.id, label: taskTitle(t) || t.title },
      rename: () =>
        ctx.openRename({
          ptyId: tile?.ptyId ?? null,
          taskId: t.id,
          current: tile?.title || taskTitle(t) || t.title,
          provider: t.agent?.provider ?? null,
        }),
    };
  });
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const waiting = open.filter(taskNeedsYou).length;

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Tasks</h2>
        <span className="cockpit-muted">
          {open.length} open{waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''} · {closed.length} closed this week
        </span>
        <span className="cockpit-header-spacer" />
        <button className="cockpit-btn" onClick={() => ctx.openLauncher()}>
          <Icon name="plus" size={11} /> Task
        </button>
      </header>
      {ctx.hester.offline && !snap && <div className="cockpit-offline">{ctx.hester.offline}: tasks need Hester. Launching still works.</div>}
      {snap && all.length === 0 && <div className="cockpit-empty">No tasks yet. n launches one; agents you start become tasks when they get a prompt.</div>}
      <div className="cockpit-rows">
        {all.map((t, i) => (
          <TaskRow key={t.id} ctx={ctx} task={t} handle={handles[i]} selected={sel?.kind === 'row' && sel.id === handles[i].id} />
        ))}
      </div>
    </section>
  );
};

export default TasksSection;
