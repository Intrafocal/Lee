/**
 * HandoffSheet - Hand off a section to an agent (Deep next R3; contract §5).
 *
 * One sheet: the kind (Spike, Docs or Research), the provider (Claude by
 * default, or the one an @mention named), and the brief: the kind's
 * template, then the section word for word, then "From the exploration
 * '<title>' (<id>)". The brief is an ordinary text field, shown exactly as
 * it will be sent (C3); changing the kind swaps only the template, and only
 * while you haven't rewritten it. Launch is the sheet's one next step (⌘⏎).
 *
 * Launch: POST /handoffs (the answer record, state 'launching') →
 * window.lee.cockpit.launch (lead delegate, origin exploration, the kind's
 * worktree, tools and timebox) → PATCH the record with the task id. If the
 * launch fails the record is marked error and the sheet says why. Esc or ×
 * closes without sending anything.
 */

import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Anchor, DeepAnswer, HandoffKind, LaunchResult } from '../../../shared/cockpit';
import { Btn } from '../cockpit/ui';
import {
  HANDOFF_KINDS,
  HANDOFF_LAUNCH,
  HANDOFF_PROVIDERS,
  HANDOFF_TEMPLATES,
  createHandoff,
  fetchHandoffTemplate,
  handoffBrief,
  handoffLaunchRequest,
  patchAnswer,
  swapTemplate,
} from '../../lib/hesterDeep';
import './deep.css';
import './HandoffSheet.css';

export interface HandoffSheetProps {
  workspace: string;
  explorationId: string;
  explorationTitle: string;
  /** The selection, or the section the cursor is in, word for word. */
  sectionText: string;
  anchor: Anchor;
  /** Preselected by an @mention (claude, pi). */
  provider?: string;
  /** The record as it changes (created, launched, failed), for the margin. */
  onRecord: (a: DeepAnswer) => void;
  onLaunched: (a: DeepAnswer) => void;
  onClose: () => void;
}

function launchError(error: string | undefined): string {
  if (error === 'prompt_unsupported') return 'That provider can’t take a brief; pick Claude.';
  return error || 'Launch failed';
}

export const HandoffSheet: React.FC<HandoffSheetProps> = ({
  workspace,
  explorationId,
  explorationTitle,
  sectionText,
  anchor,
  provider: initialProvider,
  onRecord,
  onLaunched,
  onClose,
}) => {
  const [kind, setKind] = useState<HandoffKind>('spike');
  const [provider, setProvider] = useState(() => (HANDOFF_PROVIDERS.some((p) => p.id === initialProvider) ? (initialProvider as string) : 'claude'));
  const [templates, setTemplates] = useState<Record<HandoffKind, string>>({ ...HANDOFF_TEMPLATES });
  const [brief, setBrief] = useState(() => handoffBrief(HANDOFF_TEMPLATES.spike, sectionText, explorationTitle, explorationId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Hester's own templates (the same text the daemon renders), when it has them.
  const briefRef = useRef(brief);
  briefRef.current = brief;
  const kindRef = useRef(kind);
  kindRef.current = kind;
  useEffect(() => {
    let cancelled = false;
    for (const k of HANDOFF_KINDS.map((x) => x.kind)) {
      void fetchHandoffTemplate(workspace, k).then((r) => {
        if (cancelled || !r.ok || typeof r.data?.template !== 'string' || !r.data.template.trim()) return;
        const next = r.data.template;
        setTemplates((t) => {
          if (k === kindRef.current) setBrief((b) => swapTemplate(b, t[k], next));
          return { ...t, [k]: next };
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, 0);
    el.scrollTop = 0;
  }, []);

  const pickKind = (k: HandoffKind) => {
    if (k === kind) return;
    setBrief((b) => swapTemplate(b, templates[kind], templates[k]));
    setKind(k);
  };

  const launch = async () => {
    if (busy || !brief.trim()) return;
    setBusy(true);
    setError(null);
    const created = await createHandoff(workspace, explorationId, { kind, provider, brief, anchor });
    if (!alive.current) return;
    if (!created.ok) {
      setBusy(false);
      setError(created.status === 404 ? 'This Hester can’t take hand-offs yet. Update Hester, then try again.' : created.error);
      return;
    }
    const rec = created.data;
    onRecord(rec);
    const api = typeof window !== 'undefined' ? window.lee?.cockpit : undefined;
    let res: LaunchResult | null = null;
    let failed: string | null = null;
    if (!api) failed = 'Launching needs Lee';
    else {
      try {
        res = await api.launch(handoffLaunchRequest({ workspace, kind, provider, brief, explorationId, answerId: rec.id, title: explorationTitle }));
        if (!res.success) failed = launchError(res.error);
      } catch {
        failed = 'Launch failed';
      }
    }
    if (failed) {
      const p = await patchAnswer(workspace, explorationId, rec.id, { status: 'error', error: failed });
      onRecord(p.ok ? p.data : { ...rec, status: 'error', error: failed, ...(rec.handoff ? { handoff: { ...rec.handoff, state: 'error' as const } } : {}) });
      if (!alive.current) return;
      setBusy(false);
      setError(failed);
      return;
    }
    const taskId = res?.task_id ?? null;
    let final: DeepAnswer = { ...rec, ...(rec.handoff ? { handoff: { ...rec.handoff, task_id: taskId, state: 'running' as const } } : {}) };
    if (taskId) {
      const p = await patchAnswer(workspace, explorationId, rec.id, { task_id: taskId });
      if (p.ok) final = p.data;
    }
    onRecord(final);
    onLaunched(final);
  };

  const how = HANDOFF_LAUNCH[kind];
  const providerLabel = HANDOFF_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  const meta = [
    `${providerLabel} runs it on its own`,
    how.worktree ? 'in a git worktree' : 'read-only (Read, Grep, Glob, WebFetch, WebSearch)',
    `${how.timebox_min} min timebox`,
  ].join(' · ');

  return ReactDOM.createPortal(
    <div
      className="deep-sheet-scrim handoff-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onClose();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          void launch();
        }
      }}
    >
      <div className="deep-sheet handoff-sheet" role="dialog" aria-modal="true" aria-label="Hand off" tabIndex={-1} data-view-root="">
        <div className="deep-sheet-head">
          <span>Hand off</span>
          <span className="deep-spacer" />
          <button className="deep-icon-btn" onClick={onClose} disabled={busy} title="Close without sending (Esc)" aria-label="Close">
            ×
          </button>
        </div>

        <div className="deep-sheet-label">Kind</div>
        <div className="deep-sheet-ratings" role="radiogroup" aria-label="Kind">
          {HANDOFF_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              className={`deep-rating${kind === k.kind ? ' is-on' : ''}`}
              disabled={busy}
              onClick={() => pickKind(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="deep-muted handoff-kind-line">{HANDOFF_KINDS.find((k) => k.kind === kind)?.line}</div>

        <div className="deep-sheet-label">Agent</div>
        <div className="deep-sheet-ratings" role="radiogroup" aria-label="Agent">
          {HANDOFF_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={provider === p.id}
              className={`deep-rating${provider === p.id ? ' is-on' : ''}`}
              disabled={busy}
              onClick={() => setProvider(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="deep-sheet-label" htmlFor="handoff-brief">
          The brief, exactly as it will be sent
        </label>
        <textarea
          id="handoff-brief"
          ref={fieldRef}
          className="handoff-brief"
          rows={12}
          value={brief}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setBrief(e.target.value)}
        />
        <div className="deep-muted handoff-meta">{meta}. It shows in Work, and its result comes back to this section.</div>

        {error && (
          <div className="handoff-error" role="alert">
            {error}
          </div>
        )}

        <div className="deep-sheet-actions">
          <span className="deep-muted">Esc closes without sending</span>
          <span className="deep-spacer" />
          <Btn kind="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
          <Btn kind="next" kbd="⌘↵" disabled={busy || !brief.trim()} onClick={() => void launch()}>
            {busy ? 'Launching…' : 'Launch'}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default HandoffSheet;
