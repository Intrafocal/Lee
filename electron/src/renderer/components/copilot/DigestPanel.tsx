/**
 * DigestPanel - session-start digest: wins, agent claims, waiting items,
 * Someday counts, retro (contracts §8.4, §9.1). Opens on return, and on a
 * manual focus start; "Hester offline" if the fetch fails.
 */

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { AttentionItemRow } from './AttentionItemRow';
import { RetroCard } from './RetroCard';
import { fetchDigest, type DigestResponse } from '../../lib/hesterCopilot';
import type { CopilotAPI, FocusItem } from '../../../shared/copilot';

interface DigestPanelProps {
  api: CopilotAPI;
  workspace: string;
  since?: string | null;
  focus?: FocusItem | null;
  /** Called once the retro card is saved or skipped, so the caller can clear its "due" chip right away. */
  onRetroDone?: () => void;
  onClose: () => void;
}

export const DigestPanel: React.FC<DigestPanelProps> = ({ api, workspace, since, focus, onRetroDone, onClose }) => {
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDigest({ workspace, since: since ?? undefined, focus: focus ?? null }).then((res) => {
      if (cancelled) return;
      if (res.ok) setDigest(res.data);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, since, focus]);

  return ReactDOM.createPortal(
    <div className="copilot-modal-overlay" onClick={onClose}>
      <div className="copilot-modal copilot-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="copilot-modal-header">
          <span className="copilot-modal-title">While you were away</span>
          <button className="copilot-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="copilot-modal-body">
          {error && <div className="copilot-digest-offline">{error}</div>}
          {!digest && !error && <div className="copilot-digest-empty">Loading…</div>}
          {digest && (
            <>
              <div className="copilot-digest-topline">{digest.top_line}</div>

              {digest.wins.length > 0 && (
                <div className="copilot-digest-section">
                  <div className="copilot-digest-section-title">Progress</div>
                  {digest.wins.map((w, i) => (
                    <div className="copilot-digest-win" key={`${w.kind}-${w.ref ?? i}`}>
                      <span className="copilot-digest-win-title">{w.title}</span>
                      {w.ref && <span className="copilot-digest-win-ref">{w.ref}</span>}
                      {w.related && <span className="copilot-digest-badge is-related">related</span>}
                    </div>
                  ))}
                </div>
              )}

              {digest.waiting.length > 0 && (
                <div className="copilot-digest-section">
                  <div className="copilot-digest-section-title">Waiting</div>
                  {digest.waiting.map((item) => (
                    <AttentionItemRow key={item.id} item={item} api={api} compact />
                  ))}
                </div>
              )}

              {digest.agent_claims.length > 0 && (
                <div className="copilot-digest-section">
                  <div className="copilot-digest-section-title">Agent claims</div>
                  {digest.agent_claims.map((c) => (
                    <div className="copilot-digest-claim" key={c.session_id + c.at}>
                      <span className="copilot-digest-claim-label">Claude says:</span>
                      {c.summary}
                      <span className="copilot-digest-badge is-unverified" style={{ marginLeft: 6 }}>
                        unverified
                      </span>
                      {c.related && <span className="copilot-digest-badge is-related" style={{ marginLeft: 4 }}>related</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="copilot-digest-section">
                <div className="copilot-digest-section-title">Someday</div>
                <div className="copilot-digest-someday">
                  {digest.someday.open} open
                  {digest.someday.untriaged_over_7d > 0 && `, ${digest.someday.untriaged_over_7d} untriaged over 7 days`}
                </div>
              </div>

              {digest.retro.due && (
                <div className="copilot-digest-section">
                  <div className="copilot-digest-section-title">Weekly retro</div>
                  <RetroCard onDone={onRetroDone} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default DigestPanel;
