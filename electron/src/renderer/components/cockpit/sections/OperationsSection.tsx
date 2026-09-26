/**
 * OperationsSection - defined operations, services as status rows,
 * auto-detected Suggestions (confirm/dismiss) and Hester/lint Proposals
 * (exact command and target shown; approved through their Feed entry)
 * (contracts §4.3).
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../../Icon';
import type { OperationDef, OperationInfo, OperationKind } from '../../../../shared/cockpit';
import { formatAge, formatDuration } from '../../../lib/cockpitModel';
import { RunOpDialog, fillCommand } from '../RunMenu';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

const BAD = new Set(['failed', 'crashed', 'unhealthy']);

const EditForm: React.FC<{ ctx: CockpitCtx; op: OperationInfo; onDone: () => void }> = ({ ctx, op, onDone }) => {
  const [def, setDef] = useState<OperationDef>({ ...op.def });
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!ctx.api) return;
    ctx.api.ops
      .save(ctx.workspace, def)
      .then((r) => (r.success ? onDone() : setError(r.error || 'Save failed')))
      .catch(() => setError('Save failed'));
  };
  return (
    <div className="cockpit-confirm" onClick={(e) => e.stopPropagation()}>
      <label className="cockpit-field">
        <span>command</span>
        <input className="cockpit-input is-mono" value={def.command} onChange={(e) => setDef({ ...def, command: e.target.value })} />
      </label>
      <label className="cockpit-field">
        <span>cwd</span>
        <input className="cockpit-input is-mono" value={def.cwd ?? ''} onChange={(e) => setDef({ ...def, cwd: e.target.value || null })} />
      </label>
      <label className="cockpit-field">
        <span>kind</span>
        <select className="cockpit-input" value={def.kind} onChange={(e) => setDef({ ...def, kind: e.target.value as OperationKind })}>
          <option value="oneshot">one-shot</option>
          <option value="long-running">long-running</option>
        </select>
      </label>
      <label className="cockpit-check">
        <input type="checkbox" checked={!!def.confirm} onChange={(e) => setDef({ ...def, confirm: e.target.checked })} /> Always ask before running
      </label>
      {error && <div className="cockpit-error">{error}</div>}
      <div className="cockpit-row-actions">
        <button className="cockpit-btn is-primary" onClick={save}>
          Save
        </button>
        <button className="cockpit-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
};

const OpRow: React.FC<{ ctx: CockpitCtx; op: OperationInfo; handle: RowHandle; selected: boolean; onRun: () => void }> = ({ ctx, op, handle, selected, onRun }) => {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = op.running ?? op.last_run;
  const pty = op.running?.pty_id ?? op.linked_pty_id ?? op.last_run?.pty_id ?? null;
  const failed = BAD.has(op.status);
  const readings = op.last_run?.readings ?? [];
  const failure = ctx.feedRows.find((r) => r.source === 'lee' && r.entry.kind === 'failure' && r.entry.ref.op === op.def.name);

  const call = (fn: () => Promise<{ success: boolean; error?: string }>, ok: string) => {
    setBusy(true);
    fn()
      .then((r) => (r.success ? ctx.notify(ok) : ctx.notify(r.error || 'failed', 'error')))
      .catch(() => ctx.notify('failed', 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div
      data-cockpit-row={handle.id}
      className={`cockpit-row${selected ? ' is-selected' : ''}${failed ? ' sev-needs-you' : ''}`}
      onClick={() => ctx.selectRow(handle.id)}
      onDoubleClick={() => handle.open?.()}
    >
      <div className="cockpit-row-head">
        <span className={`cockpit-status st-${op.status}`}>{op.status === 'running' ? '▶ running' : op.status}</span>
        <span className="cockpit-row-title">{op.def.name}</span>
        <span className="cockpit-muted">
          {op.source === 'service' ? 'service' : op.def.kind === 'long-running' ? 'long-running' : 'one-shot'}
          {op.def.confirm ? ' · asks first' : ''}
        </span>
      </div>
      <div className="cockpit-row-meta">
        <code>{op.def.command}</code>
        {run && run.duration_ms != null && ` · ${formatDuration(run.duration_ms)}`}
        {run && ` · ${formatAge(run.ended_at ?? run.started_at, ctx.now)}`}
        {run?.exit_code != null && run.exit_code !== 0 && ` · exit ${run.exit_code}`}
        {pty != null && ' · in a tab'}
      </div>
      {readings.length > 0 && (
        <div className="cockpit-row-meta">
          {readings.map((r) => `${r.metric} ${r.value}${r.unit ? ` ${r.unit}` : ''}`).join(' · ')}
        </div>
      )}
      {editing ? (
        <EditForm ctx={ctx} op={op} onDone={() => setEditing(false)} />
      ) : (
        <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
          {op.status !== 'running' && op.source !== 'service' && (
            <button className="cockpit-btn is-primary" disabled={busy} onClick={onRun}>
              <Icon name="play" size={11} /> Run
            </button>
          )}
          {op.status === 'running' && (
            <button className="cockpit-btn" disabled={busy} onClick={() => ctx.api && call(() => ctx.api!.ops.stop(ctx.workspace, op.def.name), `Stopping ${op.def.name}`)}>
              <Icon name="stop" size={11} /> Stop
            </button>
          )}
          {pty != null && (
            <button className="cockpit-btn" onClick={() => ctx.focusPty(pty)}>
              <Icon name="terminal" size={11} /> Open tab
            </button>
          )}
          {failed && (
            <>
              <button
                className="cockpit-btn"
                disabled={busy}
                onClick={() =>
                  ctx.api &&
                  call(
                    () => ctx.api!.ops.startAgent({ workspace: ctx.workspace, purpose: 'fix', op: op.def.name, run_id: op.last_run?.run_id }),
                    'Fix agent started',
                  )
                }
              >
                Fix with agent
              </button>
              <button
                className="cockpit-btn"
                onClick={() =>
                  ctx.openLauncher({
                    text: `Fix ${op.def.name}: it failed${op.last_run?.exit_code != null ? ` (exit ${op.last_run.exit_code})` : ''}.${
                      failure?.source === 'lee' && failure.entry.text ? `\n\n${failure.entry.text}` : ''
                    }`,
                    kind: 'bug',
                    origin: { kind: 'operation', ref: op.def.name },
                  })
                }
              >
                Create task
              </button>
            </>
          )}
          {op.source !== 'service' && (
            <button className="cockpit-btn" onClick={() => setEditing(true)}>
              <Icon name="edit" size={11} /> Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const OperationsSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const snap = ctx.ops;
  const ops = snap?.operations ?? [];
  const [running, setRunning] = useState<OperationInfo | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Suggestions are ambient: one collapsed row until you choose to review them.
  const [reviewing, setReviewing] = useState(false);

  const startRun = (op: OperationInfo) => {
    if (!ctx.api) return;
    if (op.def.confirm || (op.def.params ?? []).length) {
      setRunning(op);
      return;
    }
    ctx.api.ops
      .run({ workspace: ctx.workspace, name: op.def.name })
      .then((r) => {
        if (r.success) ctx.notify(`Running ${op.def.name}`);
        else if (r.needs_confirm || r.missing_params?.length) setRunning(op);
        else ctx.notify(r.error || 'Run failed', 'error');
      })
      .catch(() => ctx.notify('Run failed', 'error'));
  };

  const handles: RowHandle[] = ops.map((op) => ({
    id: `op:${op.def.name}`,
    title: op.def.name,
    about: { kind: 'operation', id: op.def.name, label: op.def.name },
    open: () => {
      const pty = op.running?.pty_id ?? op.linked_pty_id ?? null;
      if (pty != null) ctx.focusPty(pty);
      else startRun(op);
    },
  }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;

  const suggestions = snap?.suggestions ?? [];
  const proposals = snap?.proposals ?? [];

  const confirmSelected = () => {
    if (!ctx.api || !picked.size) return;
    setBusy(true);
    ctx.copilotApi?.logCeremony('confirm', 'operations');
    ctx.api.ops
      .confirm(ctx.workspace, Array.from(picked))
      .then((r) => {
        if (r.success) {
          ctx.notify(`Saved ${picked.size} operation${picked.size === 1 ? '' : 's'}`);
          setPicked(new Set());
        } else ctx.notify(r.error || 'failed', 'error');
      })
      .catch(() => ctx.notify('failed', 'error'))
      .finally(() => setBusy(false));
  };

  const bad = ops.filter((o) => BAD.has(o.status)).length;

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Operations</h2>
        <span className="cockpit-muted">
          {ops.length} defined{bad ? ` · ${bad} failing` : ''}
          {suggestions.length ? ` · ${suggestions.length} suggested` : ''}
          {proposals.length ? ` · ${proposals.length} proposed` : ''}
        </span>
      </header>
      {!snap && <div className="cockpit-empty">No operations data from Lee yet.</div>}

      {proposals.length > 0 && (
        <div className="cockpit-group">
          <div className="cockpit-group-title">Proposals</div>
          {proposals.map((p) => {
            const row = ctx.feedRows.find((r) => r.source === 'lee' && r.entry.ref.proposal_id === p.id);
            const entry = row?.source === 'lee' ? row.entry : null;
            return (
              <div key={p.id} className="cockpit-row sev-needs-you">
                <div className="cockpit-row-head">
                  <Icon name="bell" size={12} />
                  <span className="cockpit-row-title">
                    {p.by === 'hester' ? 'Hester' : 'Lint'} proposes {p.op ? p.op : 'a command'}
                  </span>
                  <span className="cockpit-muted">{formatAge(p.created_at, ctx.now)}</span>
                </div>
                {p.reason && <div className="cockpit-row-text">{p.reason}</div>}
                <div className="cockpit-muted">Runs exactly this{p.cwd ? ` in ${p.cwd}` : ''}:</div>
                <pre className="cockpit-confirm-text">{p.command}</pre>
                <div className="cockpit-row-actions">
                  {entry ? (
                    entry.actions.slice(0, 3).map((a) => (
                      <button
                        key={a.id}
                        className={`cockpit-btn${a.style === 'primary' ? ' is-primary' : a.style === 'danger' ? ' is-danger' : ''}`}
                        onClick={() => {
                          ctx.copilotApi?.logCeremony('confirm', 'proposal');
                          ctx.api?.feed
                            .act(entry.id, a.id)
                            .then((r) => !r.success && ctx.notify(r.error || 'failed', 'error'))
                            .catch(() => ctx.notify('failed', 'error'));
                        }}
                      >
                        {a.label}
                      </button>
                    ))
                  ) : (
                    <span className="cockpit-muted">Approve it in the Feed.</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {suggestions.length > 0 && !reviewing && (
        <div className="cockpit-row is-ambient" onClick={() => setReviewing(true)}>
          <div className="cockpit-row-head">
            <Icon name="info" size={12} />
            <span className="cockpit-row-title">
              {suggestions.length} suggested operation{suggestions.length === 1 ? '' : 's'}
            </span>
            <span className="cockpit-muted">detected from project files, not saved yet</span>
            <span className="cockpit-header-spacer" />
            <button
              className="cockpit-btn"
              onClick={(e) => {
                e.stopPropagation();
                setReviewing(true);
              }}
            >
              Review
            </button>
          </div>
        </div>
      )}

      {suggestions.length > 0 && reviewing && (
        <div className="cockpit-group">
          <div className="cockpit-group-title">
            Suggestions (detected, not saved yet){' '}
            <button className="cockpit-btn" onClick={() => setReviewing(false)}>
              Hide
            </button>
          </div>
          {suggestions.map((s) => (
            <div key={s.def.name} className="cockpit-row">
              <label className="cockpit-check">
                <input
                  type="checkbox"
                  checked={picked.has(s.def.name)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.def.name);
                      else next.delete(s.def.name);
                      return next;
                    })
                  }
                />
                <span className="cockpit-row-title">{s.def.name}</span>
                <span className="cockpit-muted">
                  {s.def.kind === 'long-running' ? 'long-running' : 'one-shot'}
                  {s.def.confirm ? ' · asks first' : ''} · from {s.detected_from}
                </span>
              </label>
              <div className="cockpit-row-meta">
                <code>{fillCommand(s.def.command, {})}</code>
                {s.def.cwd ? ` · in ${s.def.cwd}` : ''}
              </div>
              <div className="cockpit-row-actions">
                <button className="cockpit-btn" onClick={() => void ctx.api?.ops.dismissSuggestion(ctx.workspace, s.def.name).catch(() => {})}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
          <div className="cockpit-row-actions">
            <button className="cockpit-btn is-primary" disabled={busy || picked.size === 0} onClick={confirmSelected}>
              Confirm selected ({picked.size})
            </button>
            <button className="cockpit-btn" onClick={() => setPicked(new Set(suggestions.map((s) => s.def.name)))}>
              Select all
            </button>
          </div>
        </div>
      )}

      {ops.length > 0 && (
        <div className="cockpit-rows">
          {ops.map((op, i) => (
            <OpRow
              key={op.def.name}
              ctx={ctx}
              op={op}
              handle={handles[i]}
              selected={sel?.kind === 'row' && sel.id === handles[i].id}
              onRun={() => startRun(op)}
            />
          ))}
        </div>
      )}
      {running && <RunOpDialog ctx={ctx} op={running} onClose={() => setRunning(null)} />}
    </section>
  );
};

export default OperationsSection;
