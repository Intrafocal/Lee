/**
 * CockpitRail - the v1 digest, unchanged, with Progress first, and
 * "Ask Hester…" about the selected item (contracts §4.7). The palette opens
 * pre-filled and is not auto-submitted. No "What next?" (v4).
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { fetchDigest, type DigestResponse } from '../../lib/hesterCopilot';
import { AgentMarkdown } from './AgentMarkdown';

interface CockpitRailProps {
  workspace: string;
  about: string | null;
  returnNonce: number;
  onAsk: () => void;
}

export const CockpitRail: React.FC<CockpitRailProps> = ({ workspace, about, returnNonce, onAsk }) => {
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    const load = () =>
      fetchDigest({ workspace }).then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setDigest(res.data);
          setError(null);
        } else setError(res.error);
      });
    void load();
    const id = window.setInterval(() => void load(), 10 * 60000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [workspace, returnNonce]);

  return (
    <aside className="cockpit-rail" aria-label="Hester">
      <div className="cockpit-rail-title">Since you left…</div>
      {error && <div className="cockpit-offline">{error}</div>}
      {!digest && !error && <div className="cockpit-muted">Loading…</div>}
      {digest && (
        <div className="cockpit-rail-body">
          <AgentMarkdown className="cockpit-rail-topline" text={digest.top_line} />
          {digest.wins.length > 0 && (
            <div className="cockpit-rail-group">
              <div className="cockpit-rail-head">Progress</div>
              {digest.wins.slice(0, 8).map((w, i) => (
                <div key={`${w.kind}-${w.ref ?? i}`} className="cockpit-rail-line">
                  {w.verified && <Icon name="check" size={10} />} <AgentMarkdown inline text={w.title} />
                </div>
              ))}
            </div>
          )}
          {digest.agent_claims.length > 0 && (
            <div className="cockpit-rail-group">
              <div className="cockpit-rail-head">Agents said</div>
              {digest.agent_claims.slice(0, 5).map((c, i) => (
                <div key={`${c.session_id}-${i}`} className="cockpit-rail-line">
                  <span className="cockpit-agent-label">Agent:</span> <AgentMarkdown inline text={c.summary} />
                </div>
              ))}
            </div>
          )}
          <div className="cockpit-rail-group">
            <div className="cockpit-rail-head">Changed</div>
            <div className="cockpit-rail-line">
              {digest.changed.commits} commit{digest.changed.commits === 1 ? '' : 's'} · {digest.changed.agent_files.length} agent file
              {digest.changed.agent_files.length === 1 ? '' : 's'}
            </div>
            {digest.waiting.length > 0 && <div className="cockpit-rail-line">{digest.waiting.length} waiting on you</div>}
            <div className="cockpit-rail-line">
              Someday: {digest.someday.open} open
              {digest.someday.untriaged_over_7d ? ` · ${digest.someday.untriaged_over_7d} untriaged > 7d` : ''}
            </div>
          </div>
        </div>
      )}
      <div className="cockpit-rail-ask">
        {about && (
          <div className="cockpit-rail-about" title={about}>
            about: {about}
          </div>
        )}
        <button className="cockpit-btn" onClick={onAsk}>
          <Icon name="chat" size={12} /> Ask Hester…
        </button>
      </div>
    </aside>
  );
};

export default CockpitRail;
