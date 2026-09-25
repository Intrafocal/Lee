/**
 * HandoffDialog - the v1 hand-off sheet: follow-ups for idle agents, new
 * background launches, summary policy, wake marks, one commit button
 * (contracts §7.1, §9.1).
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Icon } from '../Icon';
import type { CopilotAPI, HandoffLaunch, HandoffProposals, SummaryPolicy } from '../../../shared/copilot';

interface HandoffDialogProps {
  api: CopilotAPI;
  workspace: string;
  onClose: () => void;
  onLaunched: () => void;
}

interface LaunchDraft {
  key: number;
  workspace: string;
  prompt: string;
  title: string;
  worktree: boolean;
  permission_mode: HandoffLaunch['permission_mode'];
}

let launchKeySeq = 0;

export const HandoffDialog: React.FC<HandoffDialogProps> = ({ api, workspace, onClose, onLaunched }) => {
  const [proposals, setProposals] = useState<HandoffProposals | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [followups, setFollowups] = useState<Record<number, string>>({});
  const [agentWake, setAgentWake] = useState<Set<number>>(new Set());
  const [itemWake, setItemWake] = useState<Set<string>>(new Set());
  const [launches, setLaunches] = useState<LaunchDraft[]>([]);
  const [summary, setSummary] = useState<SummaryPolicy>({ mode: 'on_return' });
  const [summaryAt, setSummaryAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .handoffProposals()
      .then((p) => {
        setProposals(p);
        setSummary(p.default_summary);
      })
      .catch(() => setLoadError('Could not load handoff proposals'));
  }, [api]);

  const addLaunch = () => {
    launchKeySeq += 1;
    setLaunches((rows) => [
      ...rows,
      { key: launchKeySeq, workspace, prompt: '', title: '', worktree: true, permission_mode: 'acceptEdits' },
    ]);
  };

  const removeLaunch = (key: number) => setLaunches((rows) => rows.filter((r) => r.key !== key));

  const toggleAgentWake = (ptyId: number) =>
    setAgentWake((s) => {
      const next = new Set(s);
      if (next.has(ptyId)) next.delete(ptyId);
      else next.add(ptyId);
      return next;
    });

  const toggleItemWake = (itemId: string) =>
    setItemWake((s) => {
      const next = new Set(s);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const launch = async () => {
    if (!proposals) return;
    setBusy(true);
    setError(null);
    try {
      const finalSummary: SummaryPolicy =
        summary.mode === 'at' ? { mode: 'at', at: summaryAt ? new Date(summaryAt).toISOString() : new Date().toISOString() } : summary;
      const result = await api.handoffStart({
        followups: Object.entries(followups)
          .filter(([, text]) => text.trim())
          .map(([ptyId, text]) => ({ pty_id: Number(ptyId), text: text.trim() })),
        launch: launches
          .filter((l) => l.prompt.trim())
          .map<HandoffLaunch>((l) => ({
            workspace: l.workspace,
            prompt: l.prompt.trim(),
            title: l.title.trim() || undefined,
            worktree: l.worktree,
            permission_mode: l.permission_mode,
          })),
        summary: finalSummary,
        wake: { item_ids: Array.from(itemWake), pty_ids: Array.from(agentWake) },
      });
      if (!result.success) {
        setError(result.error || 'Hand off failed');
        return;
      }
      onLaunched();
    } catch {
      setError('Hand off failed');
    } finally {
      setBusy(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="copilot-modal-overlay" onClick={onClose}>
      <div className="copilot-modal copilot-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="copilot-modal-header">
          <span className="copilot-modal-title">Hand off…</span>
          <button className="copilot-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="copilot-modal-body">
          {loadError && <div className="copilot-capture-error">{loadError}</div>}
          {!proposals && !loadError && <div className="copilot-digest-empty">Loading…</div>}
          {proposals && (
            <>
              {proposals.agents.length > 0 && (
                <div className="copilot-handoff-section">
                  <div className="copilot-handoff-section-title">Agents</div>
                  {proposals.agents.map((agent) => (
                    <div className="copilot-handoff-row" key={agent.pty_id}>
                      <div className="copilot-handoff-row-main">
                        <div className="copilot-handoff-row-title">
                          {agent.label} · {agent.state}
                        </div>
                        {agent.last_summary && <div className="copilot-handoff-row-sub">{agent.last_summary}</div>}
                        {agent.state === 'idle' && (
                          <input
                            className="copilot-input"
                            style={{ marginTop: 6 }}
                            placeholder="Follow-up for this agent…"
                            value={followups[agent.pty_id] || ''}
                            onChange={(e) => setFollowups((f) => ({ ...f, [agent.pty_id]: e.target.value }))}
                          />
                        )}
                      </div>
                      <label className="copilot-checkbox-row" style={{ marginTop: 0 }}>
                        <input
                          type="checkbox"
                          checked={agentWake.has(agent.pty_id)}
                          onChange={() => toggleAgentWake(agent.pty_id)}
                        />
                        Wake me
                      </label>
                    </div>
                  ))}
                </div>
              )}

              <div className="copilot-handoff-section">
                <div className="copilot-handoff-section-title">New agents</div>
                {launches.map((l) => (
                  <div className="copilot-handoff-row" key={l.key}>
                    <div className="copilot-handoff-row-main copilot-handoff-launch-grid">
                      <label className="copilot-field-label">Prompt</label>
                      <textarea
                        className="copilot-textarea"
                        value={l.prompt}
                        onChange={(e) =>
                          setLaunches((rows) => rows.map((r) => (r.key === l.key ? { ...r, prompt: e.target.value } : r)))
                        }
                      />
                      <div>
                        <label className="copilot-field-label">Title</label>
                        <input
                          className="copilot-input"
                          value={l.title}
                          onChange={(e) =>
                            setLaunches((rows) => rows.map((r) => (r.key === l.key ? { ...r, title: e.target.value } : r)))
                          }
                        />
                      </div>
                      <div>
                        <label className="copilot-field-label">Permission mode</label>
                        <select
                          className="copilot-select"
                          value={l.permission_mode}
                          onChange={(e) =>
                            setLaunches((rows) =>
                              rows.map((r) =>
                                r.key === l.key
                                  ? { ...r, permission_mode: e.target.value as HandoffLaunch['permission_mode'] }
                                  : r,
                              ),
                            )
                          }
                        >
                          <option value="acceptEdits">acceptEdits</option>
                          <option value="default">default</option>
                          <option value="plan">plan</option>
                        </select>
                      </div>
                      <label className="copilot-checkbox-row">
                        <input
                          type="checkbox"
                          checked={l.worktree}
                          onChange={(e) =>
                            setLaunches((rows) =>
                              rows.map((r) => (r.key === l.key ? { ...r, worktree: e.target.checked } : r)),
                            )
                          }
                        />
                        Worktree
                      </label>
                    </div>
                    <button className="copilot-handoff-remove" onClick={() => removeLaunch(l.key)} title="Remove">
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
                <button className="copilot-btn copilot-handoff-add-launch" onClick={addLaunch}>
                  <Icon name="plus" size={12} /> Add agent
                </button>
              </div>

              <div className="copilot-handoff-section">
                <div className="copilot-handoff-section-title">Summary</div>
                <div className="copilot-handoff-radio-group">
                  <label className="copilot-handoff-radio-row">
                    <input type="radio" checked={summary.mode === 'none'} onChange={() => setSummary({ mode: 'none' })} />
                    None
                  </label>
                  <label className="copilot-handoff-radio-row">
                    <input
                      type="radio"
                      checked={summary.mode === 'on_return'}
                      onChange={() => setSummary({ mode: 'on_return' })}
                    />
                    When I'm back
                  </label>
                  <label className="copilot-handoff-radio-row">
                    <input
                      type="radio"
                      checked={summary.mode === 'at'}
                      onChange={() => setSummary({ mode: 'at', at: summaryAt || new Date().toISOString() })}
                    />
                    At
                    <input
                      className="copilot-input"
                      type="time"
                      style={{ width: 110 }}
                      value={summaryAt}
                      onChange={(e) => {
                        setSummaryAt(e.target.value);
                        setSummary({ mode: 'at', at: e.target.value || new Date().toISOString() });
                      }}
                    />
                  </label>
                </div>
              </div>

              {proposals.waiting.length > 0 && (
                <div className="copilot-handoff-section">
                  <div className="copilot-handoff-section-title">Waiting items</div>
                  {proposals.waiting.map((item) => (
                    <div className="copilot-handoff-row" key={item.id}>
                      <div className="copilot-handoff-row-main">
                        <div className="copilot-handoff-row-title">{item.title}</div>
                      </div>
                      <label className="copilot-checkbox-row" style={{ marginTop: 0 }}>
                        <input type="checkbox" checked={itemWake.has(item.id)} onChange={() => toggleItemWake(item.id)} />
                        Wake me
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="copilot-modal-footer">
          {error && <span className="copilot-handoff-error">{error}</span>}
          <button className="copilot-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="copilot-btn copilot-btn-primary" onClick={() => void launch()} disabled={busy || !proposals}>
            Launch
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default HandoffDialog;
