/**
 * OperationsSection - defined operations, services as status rows,
 * auto-detected Suggestions (confirm/dismiss) and Hester/lint Proposals
 * (exact command and target shown; approved through their Feed entry)
 * (contracts §4.3).
 *
 * Cockpit design §6.3: built from the primitives, with no next step (Ops
 * has no phosphor). Ember only as the Dot on what needs you: a failed
 * operation, a proposal awaiting approval, a lint finding that needs you.
 * Work lint lives here as its own group (it was in Copilot): each finding
 * with its fixes (the exact change shown first; a second click applies),
 * Dismiss and Ask Hester. The status bar's ⚠ flyout keeps the scoped ignores.
 *
 * Desk D2 §8: Usage (UsagePanel, moved from History, docs/15-Usage.md §6.3)
 * sits at the end, pulled when Ops opens, never on a timer.
 */

import React, { useEffect, useState } from 'react';
import type { LintDiagnostic, LintSnapshot, OperationDef, OperationInfo, OperationKind } from '../../../../shared/cockpit';
import { formatAge, formatDuration, lintFamilyLabel, rendererAction } from '../../../lib/cockpitModel';
import { RunOpDialog, fillCommand } from '../RunMenu';
import { Btn, Card, Dot, Eyebrow, Row, SectionHead, type DotKind } from '../ui';
import type { CockpitCtx, RowHandle } from '../CockpitHost';
import { UsagePanel } from './UsagePanel';

const BAD = new Set(['failed', 'crashed', 'unhealthy']);

function opDot(status: string): DotKind {
  if (BAD.has(status)) return 'needs';
  if (status === 'running') return 'working';
  if (status === 'passed') return 'done';
  return 'idle';
}

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
        <Btn kind="plain" onClick={save}>
          Save
        </Btn>
        <Btn kind="quiet" onClick={onDone}>
          Cancel
        </Btn>
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
    <Card className="cockpit-op" selected={selected}>
      <div data-cockpit-row={handle.id} onClick={() => ctx.selectRow(handle.id)} onDoubleClick={() => handle.open?.()}>
        <div className="cockpit-op-head">
          <Dot kind={opDot(op.status)} label={op.status} />
          <span className="cockpit-op-name">{op.def.name}</span>
          <span className="cockpit-op-meta">
            {op.status === 'running' ? 'running · ' : failed ? `${op.status} · ` : ''}
            {op.source === 'service' ? 'service' : op.def.kind === 'long-running' ? 'long-running' : 'one-shot'}
            {op.def.confirm ? ' · asks first' : ''}
          </span>
        </div>
        <div className="cockpit-op-sub">
          <code>{op.def.command}</code>
          {run && run.duration_ms != null && ` · ${formatDuration(run.duration_ms)}`}
          {run && ` · ${formatAge(run.ended_at ?? run.started_at, ctx.now)}`}
          {run?.exit_code != null && run.exit_code !== 0 && ` · exit ${run.exit_code}`}
          {pty != null && ' · in a tab'}
        </div>
        {readings.length > 0 && <div className="cockpit-op-sub">{readings.map((r) => `${r.metric} ${r.value}${r.unit ? ` ${r.unit}` : ''}`).join(' · ')}</div>}
        {editing ? (
          <EditForm ctx={ctx} op={op} onDone={() => setEditing(false)} />
        ) : (
          <div className="cockpit-op-actions" onClick={(e) => e.stopPropagation()}>
            {op.status !== 'running' && op.source !== 'service' && (
              <Btn kind="plain" disabled={busy} onClick={onRun}>
                Run
              </Btn>
            )}
            {op.status === 'running' && (
              <Btn kind="plain" disabled={busy} onClick={() => ctx.api && call(() => ctx.api!.ops.stop(ctx.workspace, op.def.name), `Stopping ${op.def.name}`)}>
                Stop
              </Btn>
            )}
            {pty != null && (
              <Btn kind="quiet" onClick={() => ctx.focusPty(pty)}>
                Open tab
              </Btn>
            )}
            {failed && (
              <>
                <Btn
                  kind="quiet"
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
                </Btn>
                <Btn
                  kind="quiet"
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
                </Btn>
              </>
            )}
            {op.source !== 'service' && (
              <Btn kind="quiet" onClick={() => setEditing(true)}>
                Edit
              </Btn>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

/** The task a diagnostic is about, from its item ref ("task:<ws>:<id>" or "task:<id>"). */
function taskIdOf(diag: LintDiagnostic): string | null {
  const ref = diag.item_ref ?? '';
  if (!ref.startsWith('task:')) return null;
  const rest = ref.slice(5);
  const i = rest.lastIndexOf(':');
  return (i >= 0 ? rest.slice(i + 1) : rest) || null;
}

/** One lint finding: its words and evidence, fixes (shown, then applied on a second click), Dismiss, Ask Hester. */
const LintFinding: React.FC<{ ctx: CockpitCtx; diag: LintDiagnostic }> = ({ ctx, diag }) => {
  const api = ctx.api?.lint ?? null;
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyFix = async (fixId: string) => {
    if (!api) return;
    if (armed !== fixId) {
      setArmed(fixId);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      const res = await api.fix(diag.id, fixId);
      // v4 §7.3: some fixes are the renderer's to perform (link-goal, what-next).
      const ra = res.success ? rendererAction(res) : null;
      if (ra?.action === 'what-next') ctx.requestSteward({ kind: 'what-next' });
      else if (ra?.action === 'link-goal') {
        const taskId = ra.taskId ?? taskIdOf(diag);
        if (taskId) ctx.requestSteward({ kind: 'link-goal', taskId });
        else ctx.notify('Open the task in Work to link a goal');
      } else if (res.success) ctx.notify(res.message ?? 'Fixed');
      else setError(res.error === 'unavailable' ? 'Not available right now' : res.error ?? 'Failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  const dismiss = async () => {
    if (!api) return;
    setBusy(true);
    try {
      await api.dismiss(diag.id);
    } finally {
      setBusy(false);
    }
  };

  const armedFix = diag.fixes.find((f) => f.id === armed) ?? null;

  return (
    <div className="cockpit-lint">
      <div className="cockpit-op-head">
        <Dot kind={diag.severity === 'needs-you' ? 'needs' : 'idle'} label={diag.severity === 'needs-you' ? 'Needs you' : diag.severity} />
        <span className="cockpit-op-name">{diag.message}</span>
        <span className="cockpit-op-meta">
          {lintFamilyLabel(diag.family)} · {diag.rule}
        </span>
      </div>
      {diag.evidence.length > 0 && (
        <ul className="cockpit-lint-evidence">
          {diag.evidence.slice(0, 4).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {armedFix && (
        <div className="cockpit-op-sub">
          <code>{armedFix.confirm_text ?? armedFix.label}</code> · click again to apply
        </div>
      )}
      {error && <div className="cockpit-error">{error}</div>}
      <div className="cockpit-op-actions">
        {diag.fixes.map((f) => (
          <Btn key={f.id} kind={armed === f.id ? 'plain' : 'quiet'} disabled={busy || !api} onClick={() => void applyFix(f.id)}>
            {armed === f.id ? 'Apply' : f.label}
          </Btn>
        ))}
        <Btn kind="quiet" disabled={busy || !api} onClick={() => void dismiss()}>
          Dismiss
        </Btn>
        <Btn
          kind="quiet"
          onClick={() => ctx.requestSteward({ kind: 'ask', about: { kind: 'lint', id: diag.id, label: diag.message, record: diag } })}
          title="Ask Hester about this on Home"
        >
          Ask Hester
        </Btn>
      </div>
    </div>
  );
};

const LintGroup: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const [lint, setLint] = useState<LintSnapshot | null>(null);
  const workspace = ctx.workspace;
  useEffect(() => {
    const api = ctx.api?.lint;
    if (!api) return;
    let on = true;
    api
      .list(workspace)
      .then((s) => on && setLint(s))
      .catch(() => on && setLint(null));
    const off = api.onChange((s) => {
      if (s.workspace === workspace) setLint(s);
    });
    return () => {
      on = false;
      off();
    };
  }, [ctx.api, workspace]);

  const diags = (lint?.diagnostics ?? [])
    .filter((d) => d.severity !== 'off' && (!d.workspace || d.workspace === workspace))
    .sort((a, b) => (a.severity === 'needs-you' ? 0 : 1) - (b.severity === 'needs-you' ? 0 : 1));

  return (
    <>
      <Eyebrow>Work lint</Eyebrow>
      {!ctx.api?.lint && <div className="cockpit-muted">Lint isn't available in this window.</div>}
      {ctx.api?.lint && diags.length === 0 && <div className="cockpit-muted">No problems.</div>}
      {diags.length > 0 && (
        <Card>
          {diags.map((d) => (
            <LintFinding key={d.id} ctx={ctx} diag={d} />
          ))}
        </Card>
      )}
    </>
  );
};

/** usageSeed: fixture usage for the Usage panel (smokes). */
export const OperationsSection: React.FC<{ ctx: CockpitCtx; usageSeed?: unknown }> = ({ ctx, usageSeed }) => {
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
    <section className="cockpit-sec cockpit-ops">
      <SectionHead title="Ops" summary={`${ops.length} defined${bad ? ` · ${bad} failing` : ''}`} />
      {!snap && <div className="cockpit-empty">No operations data from Lee yet.</div>}

      {proposals.length > 0 && (
        <>
          <Eyebrow tone="needs">Waiting on you</Eyebrow>
          {proposals.map((p) => {
            const row = ctx.feedRows.find((r) => r.source === 'lee' && r.entry.ref.proposal_id === p.id);
            const entry = row?.source === 'lee' ? row.entry : null;
            return (
              <Card key={p.id} className="cockpit-op">
                <div className="cockpit-op-head">
                  <Dot kind="needs" />
                  <span className="cockpit-op-name">
                    {p.by === 'hester' ? 'Hester' : 'Lint'} proposes {p.op ? p.op : 'a command'}
                  </span>
                  <span className="cockpit-op-meta">{formatAge(p.created_at, ctx.now)}</span>
                </div>
                {p.reason && <div className="cockpit-op-text">{p.reason}</div>}
                <div className="cockpit-op-sub">Runs exactly this{p.cwd ? ` in ${p.cwd}` : ''}:</div>
                <pre className="cockpit-confirm-text">{p.command}</pre>
                <div className="cockpit-op-actions">
                  {entry ? (
                    entry.actions.slice(0, 3).map((a) => (
                      <Btn
                        key={a.id}
                        kind={a.style === 'primary' ? 'plain' : 'quiet'}
                        onClick={() => {
                          ctx.copilotApi?.logCeremony('confirm', 'proposal');
                          ctx.api?.feed
                            .act(entry.id, a.id)
                            .then((r) => !r.success && ctx.notify(r.error || 'failed', 'error'))
                            .catch(() => ctx.notify('failed', 'error'));
                        }}
                      >
                        {a.label}
                      </Btn>
                    ))
                  ) : (
                    <span className="cockpit-muted">Approve it in Work.</span>
                  )}
                </div>
              </Card>
            );
          })}
        </>
      )}

      {ops.length > 0 && (
        <>
          <Eyebrow>Operations</Eyebrow>
          <div className="cockpit-op-list">
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
        </>
      )}

      {suggestions.length > 0 && !reviewing && (
        <Card className="cockpit-op-suggested">
          <Row
            title={`${suggestions.length} suggested operation${suggestions.length === 1 ? '' : 's'}`}
            sub="detected from project files, not saved yet"
            meta="Review"
            onOpen={() => setReviewing(true)}
          />
        </Card>
      )}

      {suggestions.length > 0 && reviewing && (
        <>
          <Eyebrow
            right={
              <Btn kind="quiet" onClick={() => setReviewing(false)}>
                Hide
              </Btn>
            }
          >
            Suggested (detected, not saved yet)
          </Eyebrow>
          <Card>
            {suggestions.map((s) => (
              <div key={s.def.name} className="cockpit-lint">
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
                  <span className="cockpit-op-name">{s.def.name}</span>
                  <span className="cockpit-op-meta">
                    {s.def.kind === 'long-running' ? 'long-running' : 'one-shot'}
                    {s.def.confirm ? ' · asks first' : ''} · from {s.detected_from}
                  </span>
                </label>
                <div className="cockpit-op-sub">
                  <code>{fillCommand(s.def.command, {})}</code>
                  {s.def.cwd ? ` · in ${s.def.cwd}` : ''}
                </div>
                <div className="cockpit-op-actions">
                  <Btn kind="quiet" onClick={() => void ctx.api?.ops.dismissSuggestion(ctx.workspace, s.def.name).catch(() => {})}>
                    Dismiss
                  </Btn>
                </div>
              </div>
            ))}
          </Card>
          <div className="cockpit-op-actions">
            <Btn kind="plain" disabled={busy || picked.size === 0} onClick={confirmSelected}>
              Confirm selected ({picked.size})
            </Btn>
            <Btn kind="quiet" onClick={() => setPicked(new Set(suggestions.map((s) => s.def.name)))}>
              Select all
            </Btn>
          </div>
        </>
      )}

      <LintGroup ctx={ctx} />

      <SectionHead title="Usage" summary="What today's work cost" className="cockpit-ops-usage" />
      <UsagePanel ctx={ctx} seed={usageSeed} />
      {running && <RunOpDialog ctx={ctx} op={running} onClose={() => setRunning(null)} />}
    </section>
  );
};

export default OperationsSection;
