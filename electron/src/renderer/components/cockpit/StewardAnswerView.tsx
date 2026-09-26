/**
 * StewardAnswerView - one steward answer inline (v4 contract §8.2-§8.4):
 * the markdown answer (AgentMarkdown), its proposal buttons and, for a
 * steer, the steer card. The steer card shows the target tab and the exact
 * text first; nothing is typed until you click Send (C3).
 */

import React, { useState } from 'react';
import { Icon } from '../Icon';
import type { StewardAnswer, StewardSteer } from '../../../shared/cockpit';
import { steerSendLabel } from '../../lib/cockpitModel';
import { AgentMarkdown } from './AgentMarkdown';
import { Proposals } from './Proposals';
import type { CockpitCtx } from './CockpitHost';

const SEND_ERRORS: Record<string, string> = {
  not_found: 'That agent is gone',
  forbidden: 'Lee refused to type into that tab',
  busy: 'The agent is busy and Lee would not type into it; try again when it stops',
  awaiting_input: 'The agent is waiting on a prompt of its own; answer it first',
  state_unknown: 'Could not tell whether the agent is ready',
  invalid: 'That text cannot be typed',
};

export const SteerCard: React.FC<{ ctx: CockpitCtx; steer: StewardSteer; onDone: () => void }> = ({ ctx, steer, onDone }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = [...(ctx.hester.snapshot?.tasks.open ?? []), ...(ctx.hester.snapshot?.tasks.recent_closed ?? [])].find((t) => t.id === steer.task_id);
  const ptyId = steer.pty_id ?? task?.agent?.pty_id ?? null;
  const rt = ptyId != null ? ctx.runtime.find((r) => r.pty_id === ptyId) ?? null : null;
  const tile = ptyId != null ? ctx.tiles.find((t) => t.ptyId === ptyId) ?? null : null;
  const label = tile?.title || rt?.name || rt?.label || task?.agent?.tab_label || task?.title || 'the agent';
  const state = rt?.state.state ?? null;

  const send = () => {
    if (!ctx.api || ptyId == null || busy) return;
    setBusy(true);
    setError(null);
    ctx.api.tabs
      .send(ptyId, { text: steer.text, submit: true, purpose: 'manual', force: true })
      .then((r) => {
        if (!r.success) {
          setError(SEND_ERRORS[r.error ?? ''] ?? 'Send failed');
          return;
        }
        ctx.copilotApi?.logCeremony('confirm', 'steward-steer');
        ctx.notify(`Sent to ${label}`);
        onDone();
      })
      .catch(() => setError('Send failed'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-confirm cockpit-steer" onClick={(e) => e.stopPropagation()}>
      <div className="cockpit-muted">
        Send to <strong>{label}</strong>:
      </div>
      <pre className="cockpit-confirm-text">{steer.text}</pre>
      {ptyId == null && <div className="cockpit-error">No live agent tab for this task.</div>}
      {error && <div className="cockpit-error">{error}</div>}
      <div className="cockpit-row-actions">
        <button className="cockpit-btn is-primary" disabled={busy || ptyId == null || !ctx.api} onClick={send}>
          <Icon name="arrow-right" size={11} /> {steerSendLabel(state)}
        </button>
        <button className="cockpit-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
};

export const StewardAnswerView: React.FC<{ ctx: CockpitCtx; answer: StewardAnswer; onClose?: () => void }> = ({ ctx, answer, onClose }) => {
  const [steerOpen, setSteerOpen] = useState(true);
  return (
    <div className="cockpit-steward-answer">
      {onClose && (
        <button className="cockpit-link cockpit-steward-close" onClick={onClose} aria-label="Close the answer" title="Close">
          ×
        </button>
      )}
      {answer.text ? <AgentMarkdown text={answer.text} /> : <div className="cockpit-muted">(no answer)</div>}
      <Proposals ctx={ctx} proposals={answer.proposals} />
      {answer.steer && steerOpen && <SteerCard ctx={ctx} steer={answer.steer} onDone={() => setSteerOpen(false)} />}
    </div>
  );
};

export default StewardAnswerView;
