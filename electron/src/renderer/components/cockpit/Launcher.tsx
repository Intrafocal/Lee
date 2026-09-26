/**
 * Launcher (+ Task / n): one text field and Enter launches with defaults
 * (contracts §4.2). Optional chips: kind, lead, play, worktree, provider.
 * Zero required fields beyond the text; works with Hester down (A spools the
 * task record). No Q4 note, no suggestion chip (v4).
 */

import React, { useState } from 'react';
import { Icon } from '../Icon';
import type { LaunchRequest, TaskKind, TaskLead, TaskOrigin } from '../../../shared/cockpit';
import type { CockpitCtx } from './CockpitHost';

export interface LauncherPrefill {
  text?: string;
  kind?: TaskKind;
  lead?: TaskLead;
  origin?: TaskOrigin;
}

const KINDS: TaskKind[] = ['bug', 'question', 'prototype', 'chore'];
const LEADS: Array<{ id: TaskLead; label: string }> = [
  { id: 'delegate', label: 'Delegate' },
  { id: 'human', label: "I'll do this myself" },
  { id: 'plan', label: 'Plan' },
];
const PROVIDERS = ['claude', 'pi'];

interface LauncherProps {
  ctx: CockpitCtx;
  prefill?: LauncherPrefill;
  onClose: () => void;
}

export const Launcher: React.FC<LauncherProps> = ({ ctx, prefill, onClose }) => {
  const [text, setText] = useState(prefill?.text ?? '');
  const [kind, setKind] = useState<TaskKind | null>(prefill?.kind ?? null);
  const [lead, setLead] = useState<TaskLead>(prefill?.lead ?? 'delegate');
  const [play, setPlay] = useState(false);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveWorktree = worktree ?? lead === 'delegate';

  const launch = () => {
    const body = text.trim();
    if (!body || busy) return;
    if (!ctx.api) {
      setError('Launching needs the Cockpit runtime');
      return;
    }
    const firstLine = body.split('\n')[0].slice(0, 80);
    const req: LaunchRequest = {
      workspace: ctx.workspace,
      lead,
      play,
      origin: prefill?.origin ?? { kind: 'launcher' },
      ...(kind ? { kind } : {}),
      ...(lead === 'human' ? { title: firstLine } : { prompt: body }),
      ...(worktree != null ? { worktree } : {}),
      ...(provider ? { provider } : {}),
    };
    setBusy(true);
    setError(null);
    ctx.api
      .launch(req)
      .then((r) => {
        if (!r.success) {
          setError(r.error === 'prompt_unsupported' ? 'That provider can’t take a prompt; start it and type there' : r.error || 'Launch failed');
          return;
        }
        ctx.notify(lead === 'human' ? 'Task added' : r.relayed === false ? 'Launched (task record queued for Hester)' : 'Launched');
        ctx.hester.refresh();
        if (r.pty_id != null) ctx.selectRow(`task:${r.task_id}`);
        onClose();
      })
      .catch(() => setError('Launch failed'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div className="cockpit-popover is-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New task">
        <div className="cockpit-popover-title">
          <Icon name="plus" size={14} /> New task
        </div>
        <textarea
          autoFocus
          className="cockpit-textarea is-launcher"
          value={text}
          placeholder={lead === 'human' ? 'What will you do?' : 'What should the agent do? Enter launches'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              launch();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="cockpit-chips">
          {KINDS.map((k) => (
            <button key={k} className={`cockpit-chip-btn${kind === k ? ' is-on' : ''}`} onClick={() => setKind(kind === k ? null : k)}>
              {k}
            </button>
          ))}
          <span className="cockpit-chip-sep" />
          {LEADS.map((l) => (
            <button key={l.id} className={`cockpit-chip-btn${lead === l.id ? ' is-on' : ''}`} onClick={() => setLead(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="cockpit-chips">
          <button className={`cockpit-chip-btn${play ? ' is-on' : ''}`} onClick={() => setPlay((p) => !p)}>
            play
          </button>
          {lead !== 'human' && (
            <>
              <button className={`cockpit-chip-btn${effectiveWorktree ? ' is-on' : ''}`} onClick={() => setWorktree(!effectiveWorktree)}>
                worktree
              </button>
              <span className="cockpit-chip-sep" />
              {PROVIDERS.map((p) => (
                <button key={p} className={`cockpit-chip-btn${(provider ?? 'claude') === p ? ' is-on' : ''}`} onClick={() => setProvider(p)}>
                  {p}
                </button>
              ))}
            </>
          )}
        </div>
        {error && <div className="cockpit-error">{error}</div>}
        <div className="cockpit-popover-actions">
          <button className="cockpit-btn is-primary" disabled={busy || !text.trim()} onClick={launch}>
            {lead === 'human' ? 'Add task' : 'Launch'} <kbd>⏎</kbd>
          </button>
          <button className="cockpit-btn" onClick={onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};

export default Launcher;
