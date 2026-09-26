/**
 * LintFlyout - the problems flyout (contracts §8.5): every open diagnostic,
 * grouped by family and rule, with its evidence, fixes (the exact change is
 * shown first; a second click applies it), Dismiss and scoped ignores, then
 * the rule list with demotion flags. Pulled, so it is not a nudge.
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { CockpitAPI, LintDiagnostic, LintSnapshot, LintSuppressScope } from '../../../shared/cockpit';

interface LintFlyoutProps {
  api: CockpitAPI['lint'];
  snapshot: LintSnapshot;
  anchorRect: DOMRect;
  onClose: () => void;
  onChanged: () => void;
}

const SEVERITY_LABEL: Record<string, string> = { 'needs-you': 'Needs you', warn: 'Warning', info: 'Info', off: 'Off' };

function groupByRule(diags: LintDiagnostic[]): Array<{ family: string; rule: string; items: LintDiagnostic[] }> {
  const groups = new Map<string, { family: string; rule: string; items: LintDiagnostic[] }>();
  for (const d of diags) {
    const key = `${d.family}\0${d.rule}`;
    const g = groups.get(key) ?? { family: d.family, rule: d.rule, items: [] };
    g.items.push(d);
    groups.set(key, g);
  }
  return [...groups.values()];
}

const DiagnosticRow: React.FC<{
  diag: LintDiagnostic;
  api: CockpitAPI['lint'];
  onDone: (message: string | null) => void;
}> = ({ diag, api, onDone }) => {
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyFix = async (fixId: string) => {
    if (armed !== fixId) {
      setArmed(fixId);
      setError(null);
      return;
    }
    setBusy(true);
    try {
      const res = await api.fix(diag.id, fixId);
      if (res.success) onDone(res.message ?? 'Fixed');
      else setError(res.error === 'unavailable' ? 'Not available right now' : res.error ?? 'Failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  const suppress = async (scope: LintSuppressScope) => {
    setBusy(true);
    try {
      await api.suppress(diag.id, scope);
      onDone(null);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      await api.dismiss(diag.id);
      onDone(null);
    } finally {
      setBusy(false);
    }
  };

  const armedFix = diag.fixes.find((f) => f.id === armed) ?? null;

  return (
    <div className={`lint-diag lint-sev-${diag.severity}`}>
      <div className="lint-diag-head">
        <span className="lint-diag-sev">{SEVERITY_LABEL[diag.severity] ?? diag.severity}</span>
        <span className="lint-diag-message">{diag.message}</span>
      </div>
      {diag.evidence.length > 0 && (
        <ul className="lint-diag-evidence">
          {diag.evidence.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {armedFix && (
        <div className="lint-diag-confirm">
          {armedFix.confirm_text ?? armedFix.label}
          <span className="lint-diag-confirm-hint">Click again to apply</span>
        </div>
      )}
      {error && <div className="lint-diag-error">{error}</div>}
      <div className="lint-diag-actions">
        {diag.fixes.map((f, i) => (
          <button
            key={f.id}
            className={`lint-btn${i === 0 ? ' lint-btn-primary' : ''}${armed === f.id ? ' lint-btn-armed' : ''}`}
            disabled={busy}
            onClick={() => void applyFix(f.id)}
          >
            {armed === f.id ? 'Apply' : f.label}
          </button>
        ))}
        <button className="lint-btn" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </button>
      </div>
      <div className="lint-diag-ignore">
        Ignore:
        <button className="lint-link" disabled={busy} onClick={() => void suppress('item')}>
          for this item
        </button>
        <button className="lint-link" disabled={busy} onClick={() => void suppress('branch')}>
          until the branch changes
        </button>
        <button className="lint-link" disabled={busy} onClick={() => void suppress('workspace')}>
          in this workspace
        </button>
      </div>
    </div>
  );
};

export const LintFlyout: React.FC<LintFlyoutProps> = ({ api, snapshot, anchorRect, onClose, onChanged }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest('.lint-status')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const active = snapshot.diagnostics.filter((d) => d.severity !== 'off');
  const muted = snapshot.diagnostics.filter((d) => d.severity === 'off');
  const groups = groupByRule(active);

  const style: React.CSSProperties = {
    bottom: window.innerHeight - anchorRect.top + 8,
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 436)),
  };

  const done = (message: string | null) => {
    if (message) setToast(message);
    onChanged();
  };

  return ReactDOM.createPortal(
    <div className="lint-flyout" style={style} ref={ref}>
      <div className="lint-flyout-scroll">
        {toast && <div className="lint-toast">{toast}</div>}
        {active.length === 0 && <div className="lint-flyout-empty">No problems.</div>}
        {groups.map((g) => (
          <div className="lint-group" key={`${g.family}/${g.rule}`}>
            <div className="lint-group-title">{g.rule}</div>
            {g.items.map((d) => (
              <DiagnosticRow key={d.id} diag={d} api={api} onDone={done} />
            ))}
          </div>
        ))}
        {muted.length > 0 && (
          <div className="lint-group">
            <div className="lint-group-title">Ignored in this workspace</div>
            {muted.map((d) => (
              <div className="lint-muted" key={d.id}>
                <span className="lint-muted-text">
                  {d.rule}: {d.message}
                </span>
                <button className="lint-link" onClick={() => void api.suppress(d.id, 'workspace').then(() => onChanged())}>
                  Stop ignoring
                </button>
              </div>
            ))}
          </div>
        )}
        {snapshot.rules.length > 0 && (
          <div className="lint-group">
            <div className="lint-group-title">Rules</div>
            {snapshot.rules.map((r) => {
              const o = r.outcomes_30d;
              return (
                <div className="lint-rule" key={r.rule}>
                  <span className="lint-rule-name">{r.rule}</span>
                  <span className="lint-rule-sev">
                    {SEVERITY_LABEL[r.severity] ?? r.severity}
                    {r.demoted && <span className="lint-rule-flag"> (demoted from {SEVERITY_LABEL[r.base_severity] ?? r.base_severity})</span>}
                    {r.flagged_for_rework && <span className="lint-rule-flag"> needs rework</span>}
                  </span>
                  <span className="lint-rule-outcomes" title="Outcomes in the last 30 days">
                    {o.fixed} fixed · {o.dismissed} dismissed · {o.ignored} ignored · {o.suppressed} suppressed
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default LintFlyout;
