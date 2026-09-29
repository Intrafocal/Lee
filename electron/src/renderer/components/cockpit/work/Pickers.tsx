/**
 * Work detail's inline pickers (cockpit-design §4.2): Assign… for an agent
 * with no task (moved here from the retired Tabs section: attach it to an
 * open task, or make a task from it) and Link to a goal… for a task (moved
 * from Tasks; also what a lint fix's link-goal request opens, §2.2) and
 * Priority… for a task (the Important / Urgent override menu, moved from
 * Tasks' quadrant chip: each on, off or auto, where auto clears it).
 */

import React, { useEffect, useState } from 'react';
import type { CockpitTask } from '../../../../shared/cockpit';
import { overrideChoice, overridePatch, taskTitle, type OverrideChoice } from '../../../lib/cockpitModel';
import { confirmTask, createTask, fetchGoals, fetchWorkstreams, linkTask, patchTask, type GoalRef, type WorkstreamRef } from '../../../lib/hesterCockpit';
import { Btn, Chip } from '../ui';
import type { CockpitCtx } from '../CockpitHost';

export interface AssignTarget {
  ptyId: number;
  label: string;
  provider: string | null;
  sessionId: string | null;
}

export const AssignPicker: React.FC<{ ctx: CockpitCtx; target: AssignTarget; onDone: () => void }> = ({ ctx, target, onDone }) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const freeTasks = (ctx.hester.snapshot?.tasks.open ?? []).filter((t) => !t.agent || t.agent.pty_id == null);
  const agent = {
    provider: target.provider ?? 'claude',
    pty_id: target.ptyId,
    session_id: target.sessionId,
    tab_label: target.label,
  };

  const done = (ok: boolean, err?: string) => {
    setBusy(false);
    if (ok) {
      ctx.copilotApi?.logCeremony('assign', 'task-assign');
      ctx.hester.refresh();
      onDone();
    } else setError(err || 'failed');
  };

  return (
    <div className="work-picker">
      {freeTasks.length > 0 && <div className="work-picker-note">Attach to an open task:</div>}
      {freeTasks.length > 0 && (
        <div className="work-chips">
          {freeTasks.map((t) => (
            <Chip
              key={t.id}
              label={taskTitle(t) || t.title}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void linkTask(ctx.workspace, t.id, { pty_id: target.ptyId, session_id: target.sessionId, provider: agent.provider, tab_label: target.label }).then((r) =>
                  done(r.ok, r.ok ? undefined : r.error),
                );
              }}
            />
          ))}
        </div>
      )}
      <div className="work-picker-actions">
        <Btn
          kind="plain"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void createTask(ctx.workspace, {
              workspace: ctx.workspace,
              title: target.label,
              title_source: 'user',
              status: 'running',
              agent,
              confirmed: true,
              origin: { kind: 'agent' },
            }).then((r) => done(r.ok, r.ok ? undefined : r.error));
          }}
        >
          New task from this
        </Btn>
        <Btn kind="quiet" onClick={onDone}>
          Cancel
        </Btn>
      </div>
      {error && <div className="work-error">{error}</div>}
    </div>
  );
};

export const LinkPicker: React.FC<{ ctx: CockpitCtx; task: CockpitTask; onDone: () => void }> = ({ ctx, task, onDone }) => {
  const [goals, setGoals] = useState<GoalRef[] | null>(null);
  const [streams, setStreams] = useState<WorkstreamRef[]>([]);
  const [serves, setServes] = useState<string[]>(task.serves);
  const [workstream, setWorkstream] = useState<string>(task.workstream ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchGoals(ctx.workspace).then((r) => {
      if (!cancelled) setGoals(r.ok ? r.data : []);
    });
    void fetchWorkstreams(ctx.workspace).then((r) => {
      if (!cancelled && r.ok) setStreams(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.workspace]);

  const save = () => {
    ctx.copilotApi?.logCeremony('assign', 'task-link');
    void confirmTask(ctx.workspace, task.id, { serves, workstream: workstream || null }).then((r) => {
      if (r.ok) {
        ctx.hester.refresh();
        onDone();
      } else setError(r.error);
    });
  };

  return (
    <div className="work-picker">
      {goals === null && <div className="work-picker-note">Loading goals…</div>}
      {goals && goals.length === 0 && <div className="work-picker-note">No goals in GOALS.md.</div>}
      {goals && goals.length > 0 && (
        <div className="work-chips" role="group" aria-label="Goals this serves">
          {goals.map((g) => {
            const on = serves.includes(g.id);
            return (
              <Chip
                key={g.id}
                className={on ? 'is-on' : undefined}
                label={`${on ? '✓ ' : ''}${g.id} ${g.title}`}
                title={g.title}
                onClick={() => setServes((s) => (s.includes(g.id) ? s.filter((x) => x !== g.id) : [...s, g.id]))}
              />
            );
          })}
        </div>
      )}
      {streams.length > 0 && (
        <select className="work-select" value={workstream} onChange={(e) => setWorkstream(e.target.value)} aria-label="Workstream">
          <option value="">No workstream</option>
          {streams.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
      )}
      {error && <div className="work-error">{error}</div>}
      <div className="work-picker-actions">
        <Btn kind="plain" onClick={save}>
          Save links
        </Btn>
        <Btn kind="quiet" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </div>
  );
};

const OVERRIDE_CHOICES: OverrideChoice[] = ['on', 'off', 'auto'];

export const PriorityPicker: React.FC<{ ctx: CockpitCtx; task: CockpitTask; onDone: () => void }> = ({ ctx, task, onDone }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (axis: 'important' | 'urgent', choice: OverrideChoice) => {
    if (busy || overrideChoice(task.overrides, axis) === choice) return;
    setBusy(true);
    void patchTask(ctx.workspace, task.id, overridePatch(axis, choice)).then((r) => {
      setBusy(false);
      if (r.ok) {
        ctx.hester.refresh();
        onDone();
      } else setError(r.error);
    });
  };
  const derived = [
    task.serves.length ? `serves ${task.serves.join(', ')}` : 'serves no goal',
    task.urgency ? `urgent: ${task.urgency.signal}${task.urgency.ref ? ` (${task.urgency.ref})` : ''}` : 'no urgency signal',
  ].join(' · ');
  return (
    <div className="work-picker">
      <div className="work-picker-note">{derived}</div>
      {(['important', 'urgent'] as const).map((axis) => {
        const cur = overrideChoice(task.overrides, axis);
        return (
          <div key={axis} className="work-chips" role="group" aria-label={axis === 'important' ? 'Important' : 'Urgent'}>
            <span className="work-picker-axis">{axis === 'important' ? 'Important' : 'Urgent'}</span>
            {OVERRIDE_CHOICES.map((c) => (
              <Chip
                key={c}
                className={cur === c ? 'is-on' : undefined}
                label={`${cur === c ? '✓ ' : ''}${c}`}
                title={c === 'auto' ? 'Derived from goals and urgency signals' : undefined}
                disabled={busy}
                onClick={() => pick(axis, c)}
              />
            ))}
          </div>
        );
      })}
      {error && <div className="work-error">{error}</div>}
      <div className="work-picker-actions">
        <Btn kind="quiet" onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </div>
  );
};
