/**
 * TasksSection - Hester's task records for this workspace (contracts §4.2,
 * §6.3): running, waiting, idle, review, queued, then closed in the last 7
 * days. Confirm, Link…, Accept/Discard, Promote…, Peek, Check in.
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../../Icon';
import type { CockpitTask, TaskStatus } from '../../../../shared/cockpit';
import { formatAge, formatDuration, plainPreview, taskNeedsYou, taskTitle } from '../../../lib/cockpitModel';
import { AgentMarkdown } from '../AgentMarkdown';
import {
  closeTask,
  confirmTask,
  fetchGoals,
  fetchWorkstreams,
  promoteTask,
  type GoalRef,
  type HesterResult,
  type WorkstreamRef,
} from '../../../lib/hesterCockpit';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

const ORDER: TaskStatus[] = ['running', 'waiting', 'idle', 'review', 'queued', 'done', 'discarded'];

function sortTasks(tasks: CockpitTask[]): CockpitTask[] {
  return [...tasks].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Date.parse(b.updated_at) - Date.parse(a.updated_at),
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

const TaskRow: React.FC<{ ctx: CockpitCtx; task: CockpitTask; selected: boolean; handle: RowHandle }> = ({ ctx, task, selected, handle }) => {
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
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
        <span className="cockpit-row-title" title={task.title}>
          {taskTitle(task) || task.title}
        </span>
        {!task.confirmed && <span className="cockpit-tag">unconfirmed</span>}
        {task.accepted === true && <span className="cockpit-tag is-ok">accepted</span>}
      </div>
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
          </div>
        )
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
