/**
 * CopilotSection - Hester's home in the Cockpit (spec §6.0, §8), first in the
 * nav. Replaces the old right rail so the center keeps the width.
 *
 * Holds what exists today, nothing invented:
 * - Ask Hester (steward): opens the command palette pre-filled, never
 *   auto-submitted, optionally "about" the last thing you selected.
 * - Since you left… (the v1 digest from /copilot/digest): top line,
 *   Progress, Agents said, Changed. Agent words render as markdown.
 * - While you were away: the away summary the attention queue opened, if any.
 * - Work lint: counts and the top diagnostics (read only; the status bar's
 *   ⚠ flyout is where they are fixed).
 * - Weekly retro when due (the existing RetroCard).
 * - Copilot mode (spec Part IV) is not built yet: a labelled empty state.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../Icon';
import { fetchDigest, type DigestResponse } from '../../../lib/hesterCopilot';
import type { LintSnapshot } from '../../../../shared/cockpit';
import { AgentMarkdown } from '../AgentMarkdown';
import { RetroCard } from '../../copilot/RetroCard';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

interface CopilotSectionProps {
  ctx: CockpitCtx;
  /** The last row or tile you selected anywhere in the Cockpit, for "about:". */
  about: string | null;
  onClearAbout: () => void;
  /** Opens the palette pre-filled (not submitted). */
  onAsk: (prompt: string) => void;
  returnNonce: number;
}

const ASK_ROW = 'copilot:ask';
const DIGEST_ROW = 'copilot:digest';

export const CopilotSection: React.FC<CopilotSectionProps> = ({ ctx, about, onClearAbout, onAsk, returnNonce }) => {
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState('');
  const [lint, setLint] = useState<LintSnapshot | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const workspace = ctx.workspace;

  const load = useCallback(() => {
    if (!workspace) return () => undefined;
    let cancelled = false;
    setLoading(true);
    fetchDigest({ workspace }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        setDigest(res.data);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    const cancel = load();
    const id = window.setInterval(() => load(), 10 * 60000);
    return () => {
      cancel();
      window.clearInterval(id);
    };
  }, [load, returnNonce]);

  useEffect(() => {
    const api = ctx.api?.lint;
    if (!api) return;
    let alive = true;
    api
      .list(workspace)
      .then((s) => alive && setLint(s))
      .catch(() => alive && setLint(null));
    const off = api.onChange((s) => {
      if (s.workspace === workspace) setLint(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, [ctx.api, workspace]);

  const ask = () => {
    const q = question.trim();
    onAsk(`${about ? `About ${about}: ` : ''}${q}`);
    setQuestion('');
  };

  const rows: RowHandle[] = [
    { id: ASK_ROW, title: 'Ask Hester', open: () => askRef.current?.focus() },
    { id: DIGEST_ROW, title: 'Since you left', open: () => load() },
  ];
  useEffect(() => {
    ctx.registerRows(rows);
  });
  const sel = ctx.mode.selected;
  const selected = (id: string) => (sel?.kind === 'row' && sel.id === id ? ' is-selected' : '');

  const awaySummary = (ctx.snapshot?.items ?? []).find((i) => i.kind === 'summary' && i.state === 'open') ?? null;
  const diags = (lint?.diagnostics ?? []).filter((d) => d.severity !== 'off' && (!d.workspace || d.workspace === workspace));
  const lintCount = diags.length;

  return (
    <section className="cockpit-sec cockpit-copilot">
      <header className="cockpit-sec-head">
        <h2>Copilot</h2>
        <span className="cockpit-muted">Hester, in steward mode: what happened, and what to ask</span>
      </header>

      <div
        className={`cockpit-brief-card${selected(ASK_ROW)}`}
        data-cockpit-row={ASK_ROW}
        onClick={() => ctx.selectRow(ASK_ROW)}
      >
        <div className="cockpit-brief-head">Ask Hester</div>
        {about && (
          <div className="cockpit-brief-about" title={about}>
            about: {about}
            <button className="cockpit-link" onClick={onClearAbout} aria-label="Clear about">
              ×
            </button>
          </div>
        )}
        <div className="cockpit-capture">
          <input
            ref={askRef}
            className="cockpit-input"
            value={question}
            placeholder="Ask Hester… (Enter opens the palette with it)"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="cockpit-btn is-primary" onClick={ask}>
            <Icon name="chat" size={12} /> Ask
          </button>
        </div>
      </div>

      <div
        className={`cockpit-brief-card${selected(DIGEST_ROW)}`}
        data-cockpit-row={DIGEST_ROW}
        onClick={() => ctx.selectRow(DIGEST_ROW)}
      >
        <div className="cockpit-brief-head">
          Since you left…
          <span className="cockpit-header-spacer" />
          <button className="cockpit-btn is-icon" onClick={() => load()} disabled={loading} title="Refresh" aria-label="Refresh the brief">
            <Icon name="refresh" size={12} />
          </button>
        </div>
        {error && <div className="cockpit-offline">{error}</div>}
        {!digest && !error && <div className="cockpit-muted">Loading…</div>}
        {digest && (
          <div className="cockpit-brief-body">
            <AgentMarkdown className="cockpit-brief-topline" text={digest.top_line} />
            {digest.wins.length > 0 && (
              <div className="cockpit-brief-group">
                <div className="cockpit-brief-label">Progress</div>
                {digest.wins.slice(0, 8).map((w, i) => (
                  <div key={`${w.kind}-${w.ref ?? i}`} className="cockpit-brief-line">
                    {w.verified && <Icon name="check" size={10} />} <AgentMarkdown inline text={w.title} />
                  </div>
                ))}
              </div>
            )}
            {digest.agent_claims.length > 0 && (
              <div className="cockpit-brief-group">
                <div className="cockpit-brief-label">Agents said</div>
                {digest.agent_claims.slice(0, 5).map((c, i) => (
                  <div key={`${c.session_id}-${i}`} className="cockpit-brief-line">
                    <span className="cockpit-agent-label">Agent:</span> <AgentMarkdown inline text={c.summary} />
                  </div>
                ))}
              </div>
            )}
            <div className="cockpit-brief-group">
              <div className="cockpit-brief-label">Changed</div>
              <div className="cockpit-brief-line">
                {digest.changed.commits} commit{digest.changed.commits === 1 ? '' : 's'} · {digest.changed.agent_files.length} agent file
                {digest.changed.agent_files.length === 1 ? '' : 's'}
              </div>
              {digest.waiting.length > 0 && (
                <div className="cockpit-brief-line">
                  {digest.waiting.length} waiting on you{' '}
                  <button className="cockpit-link" onClick={() => ctx.setSection('feed')}>
                    → Feed
                  </button>
                </div>
              )}
              <div className="cockpit-brief-line">
                Someday: {digest.someday.open} open
                {digest.someday.untriaged_over_7d ? ` · ${digest.someday.untriaged_over_7d} older than a week` : ''}
              </div>
            </div>
            {digest.retro.due && (
              <div className="cockpit-brief-group">
                <div className="cockpit-brief-label">Weekly retro</div>
                <RetroCard onDone={() => load()} />
              </div>
            )}
          </div>
        )}
      </div>

      {awaySummary && (
        <div className="cockpit-brief-card">
          <div className="cockpit-brief-head">While you were away</div>
          <AgentMarkdown text={awaySummary.text} />
        </div>
      )}

      <div className="cockpit-brief-card">
        <div className="cockpit-brief-head">Work lint</div>
        {!ctx.api?.lint && <div className="cockpit-muted">Lint isn't available in this window.</div>}
        {ctx.api?.lint && lintCount === 0 && <div className="cockpit-muted">No problems.</div>}
        {lintCount > 0 && (
          <>
            <div className="cockpit-brief-line">
              {lint!.counts.needs_you > 0 ? `${lint!.counts.needs_you} need you · ` : ''}
              {lint!.counts.warn} warning{lint!.counts.warn === 1 ? '' : 's'} · {lint!.counts.info} info. Fix them from ⚠ in the status bar.
            </div>
            {diags.slice(0, 3).map((d) => (
              <div key={d.id} className="cockpit-brief-line">
                <span className="cockpit-tag">{d.rule}</span> {d.message}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="cockpit-brief-card">
        <div className="cockpit-brief-head">Copilot mode</div>
        <div className="cockpit-muted">
          Not built yet (spec Part IV). When it is, what Hester prepared while you were idle shows here. Nothing prepared.
        </div>
      </div>
    </section>
  );
};

export default CopilotSection;
