/**
 * Run ▾ (o): defined operations, "Run a command…" (ad-hoc, shows the exact
 * command) and "Ask an agent to run…" (operation agent) (contracts §4.3).
 *
 * RunOpDialog is shared with the Operations section: it collects params
 * (serial ports suggested for `port`) and, for `confirm: true` operations,
 * shows the exact command and where it runs before anything is typed.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import type { OperationInfo } from '../../../shared/cockpit';
import type { CockpitCtx } from './CockpitHost';
import { isControlTarget } from './dom';

export function fillCommand(command: string, params: Record<string, string>): string {
  return command.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] != null && params[name] !== '' ? params[name] : m));
}

export function opTarget(op: OperationInfo, workspace: string): string {
  const cwd = op.def.cwd || '.';
  const where = op.linked_pty_id != null ? 'its linked tab' : 'a terminal tab';
  return `${where}, in ${cwd === '.' ? workspace.split('/').pop() : cwd}`;
}

interface RunOpDialogProps {
  ctx: CockpitCtx;
  op: OperationInfo;
  onClose: () => void;
}

export const RunOpDialog: React.FC<RunOpDialogProps> = ({ ctx, op, onClose }) => {
  const names = op.def.params ?? [];
  const [params, setParams] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsConfirm = !!op.def.confirm;
  const wantsPort = names.includes('port');

  useEffect(() => {
    if (!wantsPort || !ctx.api) return;
    ctx.api.ops
      .serialPorts()
      .then((p) => setPorts(Array.isArray(p) ? p : []))
      .catch(() => setPorts([]));
  }, [ctx.api, wantsPort]);

  const missing = names.filter((n) => !params[n]);
  const command = fillCommand(op.def.command, params);

  const run = () => {
    if (!ctx.api || busy || missing.length) return;
    if (needsConfirm) ctx.copilotApi?.logCeremony('confirm', 'operation-confirm');
    setBusy(true);
    setError(null);
    ctx.api.ops
      .run({ workspace: ctx.workspace, name: op.def.name, params, confirmed: needsConfirm ? true : undefined })
      .then((r) => {
        if (r.success) {
          ctx.notify(`Running ${op.def.name}`);
          onClose();
        } else if (r.missing_params?.length) setError(`Missing: ${r.missing_params.join(', ')}`);
        else setError(r.error || 'Run failed');
      })
      .catch(() => setError('Run failed'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div
        className="cockpit-popover"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter on a focused button is that button's click: Cancel must never run (C3).
          if (e.key === 'Enter' && !e.shiftKey && !isControlTarget(e.target)) {
            e.preventDefault();
            e.stopPropagation();
            run();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        role="dialog"
        aria-label={`Run ${op.def.name}`}
      >
        <div className="cockpit-popover-title">
          <Icon name="play" size={13} /> Run {op.def.name}
        </div>
        {names.map((n, i) => (
          <label key={n} className="cockpit-field">
            <span>{n}</span>
            <input
              autoFocus={i === 0}
              className="cockpit-input"
              list={n === 'port' ? 'cockpit-serial-ports' : undefined}
              value={params[n] ?? ''}
              onChange={(e) => setParams((p) => ({ ...p, [n]: e.target.value }))}
            />
          </label>
        ))}
        {ports.length > 0 && (
          <datalist id="cockpit-serial-ports">
            {ports.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        )}
        <div className="cockpit-muted">{needsConfirm ? 'Lee will type exactly this into ' : 'Runs in '}{opTarget(op, ctx.workspace)}:</div>
        <pre className="cockpit-confirm-text">{command}</pre>
        {error && <div className="cockpit-error">{error}</div>}
        <div className="cockpit-popover-actions">
          <button className="cockpit-btn is-primary" disabled={busy || missing.length > 0} onClick={run} autoFocus={!names.length}>
            {needsConfirm ? 'Confirm and run' : 'Run'} <kbd>⏎</kbd>
          </button>
          <button className="cockpit-btn" onClick={onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};

type Step = { kind: 'menu' } | { kind: 'op'; op: OperationInfo } | { kind: 'adhoc' } | { kind: 'agent' };

export const RunMenu: React.FC<{ ctx: CockpitCtx; onClose: () => void }> = ({ ctx, onClose }) => {
  const [step, setStep] = useState<Step>({ kind: 'menu' });
  const [text, setText] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const ops = useMemo(() => ctx.ops?.operations ?? [], [ctx.ops]);
  const entries = ops.length + 2;

  if (step.kind === 'op') return <RunOpDialog ctx={ctx} op={step.op} onClose={onClose} />;

  const pick = (i: number) => {
    if (i < ops.length) {
      const op = ops[i];
      if (!op.def.confirm && !(op.def.params ?? []).length && ctx.api) {
        setBusy(true);
        ctx.api.ops
          .run({ workspace: ctx.workspace, name: op.def.name })
          .then((r) => {
            if (r.success) {
              ctx.notify(`Running ${op.def.name}`);
              onClose();
            } else if (r.needs_confirm || r.missing_params?.length) setStep({ kind: 'op', op });
            else setError(r.error || 'Run failed');
          })
          .catch(() => setError('Run failed'))
          .finally(() => setBusy(false));
      } else setStep({ kind: 'op', op });
    } else if (i === ops.length) setStep({ kind: 'adhoc' });
    else setStep({ kind: 'agent' });
    setText('');
  };

  const submit = () => {
    const body = text.trim();
    if (!body || !ctx.api || busy) return;
    setBusy(true);
    setError(null);
    const p =
      step.kind === 'adhoc'
        ? ctx.api.ops.run({ workspace: ctx.workspace, command: body, cwd: cwd.trim() || null, confirmed: true }).then((r) => ({ ok: r.success, error: r.error }))
        : ctx.api.ops.startAgent({ workspace: ctx.workspace, purpose: 'adhoc', request: body }).then((r) => ({ ok: r.success, error: r.error }));
    p.then((r) => {
      if (r.ok) {
        ctx.notify(step.kind === 'adhoc' ? 'Running your command' : 'Operation agent started');
        onClose();
      } else setError(r.error || 'failed');
    })
      .catch(() => setError('failed'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div
        className="cockpit-popover cockpit-run-menu"
        tabIndex={-1}
        ref={(el) => {
          if (el && step.kind === 'menu' && !el.contains(document.activeElement)) el.focus();
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (step.kind !== 'menu') return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            setIndex((i) => Math.min(entries - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && !isControlTarget(e.target)) {
            e.preventDefault();
            e.stopPropagation();
            pick(index);
          }
        }}
        role="dialog"
        aria-label="Run"
      >
        {step.kind === 'menu' && (
          <>
            <div className="cockpit-popover-title">
              <Icon name="play" size={13} /> Run
            </div>
            {ops.length === 0 && <div className="cockpit-muted">No operations defined yet. Confirm suggestions in Ops.</div>}
            {ops.map((op, i) => (
              <button key={op.def.name} className={`cockpit-menu-item${index === i ? ' is-selected' : ''}`} disabled={busy} onClick={() => pick(i)}>
                <span>{op.def.name}</span>
                <span className="cockpit-muted">
                  {op.def.kind === 'long-running' ? 'long-running' : 'one-shot'}
                  {op.def.confirm ? ' · asks first' : ''} · {op.status}
                </span>
              </button>
            ))}
            <button className={`cockpit-menu-item${index === ops.length ? ' is-selected' : ''}`} onClick={() => pick(ops.length)}>
              <span>Run a command…</span>
              <span className="cockpit-muted">new terminal tab</span>
            </button>
            <button className={`cockpit-menu-item${index === ops.length + 1 ? ' is-selected' : ''}`} onClick={() => pick(ops.length + 1)}>
              <span>Ask an agent to run…</span>
              <span className="cockpit-muted">operation agent ({ctx.ops?.agent.model ?? 'small model'})</span>
            </button>
          </>
        )}
        {(step.kind === 'adhoc' || step.kind === 'agent') && (
          <>
            <div className="cockpit-popover-title">{step.kind === 'adhoc' ? 'Run a command' : 'Ask an agent to run…'}</div>
            <input
              autoFocus
              className="cockpit-input is-mono"
              value={text}
              placeholder={step.kind === 'adhoc' ? 'e.g. npm run build' : 'What should it run or fix?'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {step.kind === 'adhoc' && (
              <>
                <input className="cockpit-input is-mono" value={cwd} placeholder="cwd (relative to the workspace; optional)" onChange={(e) => setCwd(e.target.value)} />
                {text.trim() && (
                  <>
                    <div className="cockpit-muted">Lee will type exactly this into a new terminal tab{cwd.trim() ? ` in ${cwd.trim()}` : ''}:</div>
                    <pre className="cockpit-confirm-text">{text.trim()}</pre>
                  </>
                )}
              </>
            )}
            {step.kind === 'agent' && <div className="cockpit-muted">Starts a {ctx.ops?.agent.model ?? 'small-model'} Claude with a narrow tool set; it asks before editing.</div>}
            <div className="cockpit-popover-actions">
              <button className="cockpit-btn is-primary" disabled={busy || !text.trim()} onClick={submit}>
                {step.kind === 'adhoc' ? 'Run' : 'Start agent'} <kbd>⏎</kbd>
              </button>
              <button className="cockpit-btn" onClick={() => setStep({ kind: 'menu' })}>
                Back
              </button>
            </div>
          </>
        )}
        {error && <div className="cockpit-error">{error}</div>}
      </div>
    </div>
  );
};

export default RunMenu;
