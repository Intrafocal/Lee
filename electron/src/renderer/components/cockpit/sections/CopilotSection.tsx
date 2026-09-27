/**
 * CopilotSection - Hester's home in the Cockpit (spec §6.0, §8), first in the
 * nav. Replaces the old right rail so the center keeps the width.
 *
 * Holds what exists today, nothing invented:
 * - The opener (Deep D1 §8.2) first: "What's on your mind?", Pick up, Or
 *   start from. Deterministic; see deep/OpenerCard.
 * - The steward line (v4 §8.2): "Steward on · Not today" (a toggle), or
 *   "Steward off (config)".
 * - Ask Hester (v4): POST /cockpit/ask with `about` (the last item you
 *   selected, as an item ref); the answer renders inline with proposals and,
 *   for a steer, the steer card. "Open in palette" keeps the old behaviour.
 * - What next? (POST /cockpit/what-next), and the digest's Q2 candidates
 *   when nothing needs you.
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
import type { AboutRef, LintSnapshot, StewardAnswer } from '../../../../shared/cockpit';
import { feedNeedsCount } from '../../../lib/cockpitModel';
import { askSteward, fetchSteward, setStewardNotToday, whatNext, type StewardState } from '../../../lib/hesterCockpit';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import { openItem } from '../Proposals';
import { RetroCard } from '../../copilot/RetroCard';
import { OpenerCard } from '../../deep/OpenerCard';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

interface CopilotSectionProps {
  ctx: CockpitCtx;
  /** The last row or tile you selected anywhere in the Cockpit, for "about:" (an item ref). */
  about: AboutRef | null;
  onClearAbout: () => void;
  /** Opens the palette pre-filled (not submitted): the old Ask behaviour, kept as a link. */
  onAsk: (prompt: string) => void;
  returnNonce: number;
}

const ASK_ROW = 'copilot:ask';
const NEXT_ROW = 'copilot:next';
const DIGEST_ROW = 'copilot:digest';
/** Default question when a lint item's Ask Hester asks without one. */
const DEFAULT_QUESTION = 'What should I do about this?';

/** Steward requests already handled (per window), so a remount never replays one. */
let handledNonce = 0;

type AskState = { phase: 'idle' } | { phase: 'loading'; label: string } | { phase: 'done'; answer: StewardAnswer; label: string } | { phase: 'error'; error: string };

export const CopilotSection: React.FC<CopilotSectionProps> = ({ ctx, about, onClearAbout, onAsk, returnNonce }) => {
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState('');
  const [lint, setLint] = useState<LintSnapshot | null>(null);
  const [ask, setAsk] = useState<AskState>({ phase: 'idle' });
  const [next, setNext] = useState<AskState>({ phase: 'idle' });
  const [steward, setSteward] = useState<StewardState | null>(null);
  const [stewardBusy, setStewardBusy] = useState(false);
  const askRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const workspace = ctx.workspace;
  // Request sequences: only the latest Ask / What next? answer lands; a
  // workspace switch bumps both so an answer about the old one is dropped.
  const askSeq = useRef(0);
  const nextSeq = useRef(0);
  const [answersFor, setAnswersFor] = useState(workspace);
  if (answersFor !== workspace) {
    setAnswersFor(workspace);
    askSeq.current++;
    nextSeq.current++;
    setAsk({ phase: 'idle' });
    setNext({ phase: 'idle' });
  }

  // On open (mount), workspace change and return, so "Not today" clears after midnight.
  useEffect(() => {
    let cancelled = false;
    fetchSteward(workspace).then((r) => {
      if (!cancelled) setSteward(r.ok ? r.data : null);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, returnNonce]);

  const toggleNotToday = () => {
    if (!steward || stewardBusy) return;
    setStewardBusy(true);
    const quiet = !steward.not_today_until;
    setStewardNotToday(workspace, quiet).then((r) => {
      if (!alive.current) return;
      setStewardBusy(false);
      if (r.ok) setSteward(r.data);
      else ctx.notify(r.error, 'error');
    });
  };

  const runAsk = useCallback(
    (q: string, ref: AboutRef | null) => {
      const text = q.trim();
      if (!text) return;
      const seq = ++askSeq.current;
      setAsk({ phase: 'loading', label: text });
      askSteward(workspace, text, ref).then((r) => {
        if (!alive.current || seq !== askSeq.current) return;
        setAsk(r.ok ? { phase: 'done', answer: r.data, label: text } : { phase: 'error', error: r.error });
      });
    },
    [workspace],
  );

  const runNext = useCallback(() => {
    const seq = ++nextSeq.current;
    setNext({ phase: 'loading', label: 'What next?' });
    whatNext(workspace).then((r) => {
      if (!alive.current || seq !== nextSeq.current) return;
      setNext(r.ok ? { phase: 'done', answer: r.data, label: 'What next?' } : { phase: 'error', error: r.error });
    });
  }, [workspace]);

  // Requests from outside (lint Ask Hester, a lint fix's what-next).
  const pending = ctx.pendingSteward;
  useEffect(() => {
    if (!pending || pending.nonce <= handledNonce) return;
    if (pending.req.kind === 'ask') {
      handledNonce = pending.nonce;
      runAsk(pending.req.question || DEFAULT_QUESTION, pending.req.about);
    } else if (pending.req.kind === 'what-next') {
      handledNonce = pending.nonce;
      runNext();
    }
  }, [pending, runAsk, runNext]);

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

  const submit = () => {
    const q = question.trim();
    // Enter bypasses the disabled button: no second ask while one is loading.
    if (!q || ask.phase === 'loading') return;
    runAsk(q, about);
    setQuestion('');
  };
  const openInPalette = () => {
    const q = question.trim() || (ask.phase === 'done' || ask.phase === 'loading' ? ask.label : '');
    onAsk(`${about ? `About ${about.label}: ` : ''}${q}`);
  };

  const rows: RowHandle[] = [
    { id: ASK_ROW, title: 'Ask Hester', open: () => askRef.current?.focus() },
    {
      id: NEXT_ROW,
      title: 'What next?',
      open: () => {
        if (next.phase !== 'loading') runNext();
      },
    },
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
  const q2 = (digest?.q2_candidates ?? []).slice(0, 5);

  return (
    <section className="cockpit-sec cockpit-copilot">
      <header className="cockpit-sec-head">
        <h2>Copilot</h2>
        <span className="cockpit-muted">Hester, in steward mode: what happened, and what to ask</span>
        <span className="cockpit-header-spacer" />
        {steward && !steward.enabled && <span className="cockpit-muted">Steward off (config)</span>}
        {steward && steward.enabled && (
          <span className="cockpit-steward-line">
            {steward.not_today_until ? 'Steward quiet today' : 'Steward on'} ·{' '}
            <button
              className={`cockpit-chip-btn${steward.not_today_until ? ' is-on' : ''}`}
              disabled={stewardBusy}
              aria-pressed={!!steward.not_today_until}
              title={steward.not_today_until ? 'Turn the steward back on now' : 'No pushback until midnight; answers stay plain'}
              onClick={toggleNotToday}
            >
              Not today
            </button>
          </span>
        )}
      </header>

      <OpenerCard
        workspace={workspace}
        returnNonce={returnNonce}
        onQ2={(c) => {
          if (c.kind === 'exploration-quiet') void openItem(ctx, 'exploration', c.ref);
          else void openItem(ctx, 'goal', c.goal_id || c.ref);
        }}
      />

      <div
        className={`cockpit-brief-card${selected(ASK_ROW)}`}
        data-cockpit-row={ASK_ROW}
        onClick={() => ctx.selectRow(ASK_ROW)}
      >
        <div className="cockpit-brief-head">
          Ask Hester
          <span className="cockpit-header-spacer" />
          <button className="cockpit-link" onClick={openInPalette} title="The old behaviour: the palette, pre-filled">
            Open in palette
          </button>
        </div>
        {about && (
          <div className="cockpit-brief-about" title={about.label}>
            about: <span className="cockpit-tag">{about.kind}</span> {about.label}
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
            placeholder={about ? `Ask about ${about.label}…` : 'Ask Hester…'}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="cockpit-btn is-primary" disabled={ask.phase === 'loading' || !question.trim()} onClick={submit}>
            <Icon name="chat" size={12} /> Ask
          </button>
        </div>
        {ask.phase === 'loading' && (
          <div className="cockpit-muted cockpit-spinner-line">
            <span className="cockpit-spinner" /> Asking: {ask.label}
          </div>
        )}
        {ask.phase === 'error' && <div className="cockpit-error">{ask.error}</div>}
        {ask.phase === 'done' && (
          <>
            <div className="cockpit-brief-label">You asked: {ask.label}</div>
            <StewardAnswerView key={ask.answer.request_id} ctx={ctx} answer={ask.answer} onClose={() => setAsk({ phase: 'idle' })} />
          </>
        )}
      </div>

      <div
        className={`cockpit-brief-card${selected(NEXT_ROW)}`}
        data-cockpit-row={NEXT_ROW}
        onClick={() => ctx.selectRow(NEXT_ROW)}
      >
        <div className="cockpit-brief-head">
          What next?
          <span className="cockpit-header-spacer" />
          <button
            className="cockpit-btn"
            disabled={next.phase === 'loading'}
            title="Hester weighs your goals, open tasks and where your time went, and suggests what to do next"
            onClick={(e) => {
              e.stopPropagation();
              runNext();
            }}
          >
            {next.phase === 'loading' ? (
              <>
                <span className="cockpit-spinner" /> Thinking…
              </>
            ) : (
              'What next?'
            )}
          </button>
        </div>
        {next.phase === 'error' && <div className="cockpit-error">{next.error}</div>}
        {next.phase === 'done' && (
          <StewardAnswerView key={next.answer.request_id} ctx={ctx} answer={next.answer} onClose={() => setNext({ phase: 'idle' })} />
        )}
        {next.phase === 'idle' && q2.length > 0 && feedNeedsCount(ctx.feedRows) === 0 && (
          <div className="cockpit-brief-group">
            <div className="cockpit-brief-label">Nothing needs you. Important, not urgent:</div>
            {q2.map((c) => (
              <div key={`${c.kind}:${c.ref}`} className="cockpit-brief-line">
                <button
                  className="cockpit-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (c.kind === 'exploration-quiet') void openItem(ctx, 'exploration', c.ref);
                    else void openItem(ctx, 'goal', c.goal_id || c.ref);
                  }}
                >
                  {c.goal_id && <span className="cockpit-tag">{c.goal_id}</span>} {c.title}
                </button>
                {c.detail && <span className="cockpit-muted"> · {c.detail}</span>}
              </div>
            ))}
          </div>
        )}
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
