/**
 * HomeSection - Home, the desk (cockpit-design §3; package R1). Replaces the
 * Copilot section and absorbs D1's OpenerCard (Deep D1 §8.2, 14 §6). One
 * centred column of --col-home:
 *
 * 1. The greeting, "<weekday> <part of day>" (greeting()).
 * 2. The question, "What's on your mind, <name>?", in Newsreader; the name is
 *    window.lee.app.userName() (§7.2), else no name.
 * 3. The field: Enter opens an active exploration with that exact title
 *    (any case), else creates one with your text as its seed and Page, and
 *    opens it in Deep. One keystroke to writing (unchanged from D1).
 * 4. Pick up where you left off (when the opener has one): one Card, with
 *    your stopped_at sentence and Continue ⇧⌘0, the view's one phosphor.
 * 5. Or start from: each surface as a sentence; lists open inline and
 *    picking opens Deep. Q2 items are written out one by one.
 * 6. Meanwhile: one sentence (meanwhileSentence()), up to three needs-you
 *    rows (Allow or Reply, and a quiet second action), the Lee Feed entries
 *    that need you and live nowhere else (homeFeedNeeds(): a check-in
 *    proposal, an escalate proposal; the entry's first action, shown
 *    verbatim first when it types or runs something, C3, and Dismiss ⌘⌫),
 *    then quiet links:
 *    See what shipped (inline), Ask Hester what to do next (What next?,
 *    answered inline), This week's retro when due, and work lint as ⚠ N
 *    (to Ops, where the findings are).
 *
 * The opener is deterministic (GET /copilot/opener, no model call). It and
 * the digest refresh on load, on return and every 10 minutes while shown.
 * Steward requests from outside (a lint item's Ask Hester, a lint fix's
 * what-next) still land here and answer inline. Asking anything else is ⌘/.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AboutRef, FeedAction, LintSnapshot, Opener, StewardAnswer } from '../../../../shared/cockpit';
import { fetchDigest, type DigestResponse } from '../../../lib/hesterCopilot';
import {
  askSteward,
  listExplorations,
  triageSomeday,
  whatNext,
  type Exploration,
  type Q2Candidate,
} from '../../../lib/hesterCockpit';
import { createDeepExploration, fetchOpener, patchReference } from '../../../lib/hesterDeep';
import { matchExploration, untitledTitle } from '../../../lib/deepModel';
import {
  arrivedLine,
  formatAge,
  greeting,
  homeFeedNeeds,
  homeNeeds,
  homeQuestion,
  meanwhileSentence,
  plainLine,
  q2Sentence,
  rendererAction,
  startSentence,
  type AttentionFeedRow,
  type LeeFeedRow,
  type StartSurface,
} from '../../../lib/cockpitModel';
import { openInDeep, openUrl } from '../../deep/deepBridge';
import { cockpitModeStore } from '../cockpitMode';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import { openItem } from '../Proposals';
import { RetroCard } from '../../copilot/RetroCard';
import { Btn, Card, Dot, Eyebrow, QuietLinks, Row, WritingQuote, type QuietLink } from '../ui';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

interface HomeSectionProps {
  ctx: CockpitCtx;
  returnNonce: number;
  /** First-render data before the fetches land (the renderer smoke renders Home from fixtures; the app passes none). */
  seed?: { opener?: Opener | null; digest?: DigestResponse | null; name?: string | null };
}

const REFRESH_MS = 10 * 60000;
const PICKUP_ROW = 'home:pickup';
/** Default question when a lint item's Ask Hester asks without one. */
const DEFAULT_QUESTION = 'What should I do about this?';

/** Steward requests already handled (per window), so a remount never replays one. */
let handledNonce = 0;

// Go deep with nothing open may ask before Home has mounted; the request
// waits here until it does.
let focusPending = false;
let focusMounted: (() => void) | null = null;
cockpitModeStore.onFocusOpener(() => {
  if (focusMounted) focusMounted();
  else focusPending = true;
});

/** The user's first name, asked once per window (§7.2); null until known or when there is none. */
let userNameCache: Promise<string | null> | null = null;
function userName(): Promise<string | null> {
  if (!userNameCache) {
    userNameCache = (async () => {
      try {
        return (await window.lee?.app?.userName?.()) ?? null;
      } catch {
        return null;
      }
    })();
  }
  return userNameCache;
}

type Expanded = 'open_questions' | 'captured_away' | 'reading_list' | 'quiet' | null;
type AskState = { phase: 'idle' } | { phase: 'loading'; label: string } | { phase: 'done'; answer: StewardAnswer; label: string } | { phase: 'error'; error: string };

export const HomeSection: React.FC<HomeSectionProps> = ({ ctx, returnNonce, seed }) => {
  const workspace = ctx.workspace;
  const [name, setName] = useState<string | null>(seed?.name ?? null);
  const [opener, setOpener] = useState<Opener | null>(seed?.opener ?? null);
  const [openerError, setOpenerError] = useState<string | null>(null);
  const [digest, setDigest] = useState<DigestResponse | null>(seed?.digest ?? null);
  const [digestError, setDigestError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [shipped, setShipped] = useState(false);
  const [retroOpen, setRetroOpen] = useState(false);
  const [lint, setLint] = useState<LintSnapshot | null>(null);
  const [ask, setAsk] = useState<AskState>({ phase: 'idle' });
  const [next, setNext] = useState<AskState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const explorations = useRef<Exploration[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void userName().then((n) => {
      if (alive.current) setName(n);
    });
  }, []);

  useEffect(() => {
    const focus = () => requestAnimationFrame(() => inputRef.current?.focus());
    focusMounted = focus;
    if (focusPending) {
      focusPending = false;
      focus();
    }
    return () => {
      if (focusMounted === focus) focusMounted = null;
    };
  }, []);

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

  // ---- the opener and the digest: on load, on return, every 10 minutes ----
  const load = useCallback(() => {
    if (!workspace) return () => undefined;
    let cancelled = false;
    fetchOpener(workspace).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setOpener(r.data);
        setOpenerError(null);
      } else setOpenerError(r.error);
    });
    listExplorations(workspace).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data)) explorations.current = r.data;
    });
    fetchDigest({ workspace }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setDigest(r.data);
        setDigestError(null);
      } else setDigestError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    const cancel = load();
    const id = window.setInterval(() => load(), REFRESH_MS);
    return () => {
      cancel();
      window.clearInterval(id);
    };
  }, [load, returnNonce]);

  useEffect(() => {
    const api = ctx.api?.lint;
    if (!api) return;
    let on = true;
    api
      .list(workspace)
      .then((s) => on && setLint(s))
      .catch(() => on && setLint(null));
    const off = api.onChange((s) => {
      if (s.workspace === workspace) setLint(s);
    });
    return () => {
      on = false;
      off();
    };
  }, [ctx.api, workspace]);

  // ---- steward: What next? and asks handed over from outside ----
  const runAsk = useCallback(
    (q: string, ref: AboutRef | null) => {
      const t = q.trim();
      if (!t) return;
      const seq = ++askSeq.current;
      setAsk({ phase: 'loading', label: t });
      askSteward(workspace, t, ref).then((r) => {
        if (!alive.current || seq !== askSeq.current) return;
        setAsk(r.ok ? { phase: 'done', answer: r.data, label: t } : { phase: 'error', error: r.error });
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

  const pending = ctx.pendingSteward;
  useEffect(() => {
    if (!pending || pending.nonce <= handledNonce) return;
    if (pending.req.kind === 'ask') {
      handledNonce = pending.nonce;
      runAsk(pending.req.question || DEFAULT_QUESTION, pending.req.about);
    } else if (pending.req.kind === 'what-next') {
      handledNonce = pending.nonce;
      runNext();
    } else if (pending.req.kind === 'answer') {
      handledNonce = pending.nonce;
      askSeq.current++;
      setAsk({ phase: 'done', answer: pending.req.answer, label: pending.req.question });
    }
  }, [pending, runAsk, runNext]);

  // ---- the opener's actions (unchanged from D1 §8.2) ----
  const titleOf = (id: string, fallback?: string) => explorations.current.find((e) => e.id === id)?.title ?? fallback ?? id;

  const open = async (id: string, title: string) => {
    setBusy(true);
    try {
      await openInDeep(workspace, id, title);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const create = async (input: { seed?: string; title?: string; page?: string }) => {
    setBusy(true);
    const r = await createDeepExploration(workspace, { ...input, origin: { kind: 'opener' } });
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) {
      setOpenerError(r.error);
      return;
    }
    explorations.current = [r.data, ...explorations.current];
    setText('');
    await open(r.data.id, r.data.title);
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (!explorations.current.length) {
      const r = await listExplorations(workspace);
      if (r.ok && Array.isArray(r.data)) explorations.current = r.data;
    }
    const hit = matchExploration(t, explorations.current);
    if (hit) {
      setText('');
      await open(hit.id, hit.title);
      return;
    }
    await create({ seed: t, page: `${t}\n\n` });
  };

  const onQ2 = (c: Q2Candidate) => {
    if (c.kind === 'exploration-quiet') void openItem(ctx, 'exploration', c.ref);
    else void openItem(ctx, 'goal', c.goal_id || c.ref);
  };

  // ---- needs you (the attention queue, as Work orders it) ----
  const needs = homeNeeds(ctx.feedRows, 3);
  const waiting = ctx.feedRows.filter((r) => r.source === 'attention' && r.severity !== 'ambient' && r.item.kind !== 'summary').length;
  // Lee's own needs-you entries (check-in, escalate) have no other place (§4.1).
  const feedNeeds = homeFeedNeeds(ctx.feedRows, (ctx.ops?.proposals ?? []).map((p) => p.id));
  const openEntry = (row: LeeFeedRow) => {
    const ref = row.entry.ref;
    if (ref.pty_id != null) {
      ctx.setSection('work');
      ctx.selectRow(`work:agent:${ref.pty_id}`);
    } else if (ref.task_id) {
      ctx.setSection('work');
      ctx.selectRow(`work:task:${ref.task_id}`);
    } else if (ref.op || ref.proposal_id) ctx.setSection('ops');
  };
  const dismissEntry = (row: LeeFeedRow) => void ctx.api?.feed.act(row.entry.id, 'dismiss').catch(() => {});

  const act = (row: AttentionFeedRow, action: 'approve' | 'deny') => {
    const api = ctx.copilotApi;
    if (!api) return;
    api
      .reply(row.item.id, { action, version: row.item.version })
      .then((r) => {
        if (!r.success) ctx.notify(r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'failed', 'error');
      })
      .catch(() => ctx.notify('failed', 'error'));
  };
  const snooze = (row: AttentionFeedRow) => {
    const api = ctx.copilotApi;
    if (!api) return;
    api
      .snooze(row.item.id, { until: 'change' })
      .then((r) => {
        if (!r.success) ctx.notify(r.error || 'Could not snooze', 'error');
      })
      .catch(() => ctx.notify('Could not snooze', 'error'));
  };
  /** Reply opens Work's detail view on this item (§3.6). */
  const replyInWork = (row: AttentionFeedRow) => {
    ctx.setSection('work');
    ctx.selectRow(row.id);
  };

  const pickUp = opener?.pick_up ?? null;
  const rows: RowHandle[] = [
    ...(pickUp ? [{ id: PICKUP_ROW, title: pickUp.exploration.title, open: () => void open(pickUp.exploration.id, pickUp.exploration.title) }] : []),
    ...needs.map((r) => ({
      id: `home:${r.id}`,
      title: r.item.source.tab_label || r.title,
      open: () => replyInWork(r),
      approval: r.item.kind === 'approval' ? r.item : null,
      replyItem: r.item,
    })),
    ...feedNeeds.map((r) => ({
      id: `home:${r.id}`,
      title: r.title,
      ptyId: r.entry.ref.pty_id ?? null,
      open: () => openEntry(r),
      dismiss: () => dismissEntry(r),
      about: { kind: 'feed' as const, id: r.entry.id, label: r.title, record: r.entry },
    })),
  ];
  useEffect(() => {
    ctx.registerRows(rows);
  });
  const sel = ctx.mode.selected;
  const isSel = (id: string) => sel?.kind === 'row' && sel.id === id;

  // ---- Or start from ----
  const surfaces = (opener?.surfaces ?? []).filter((s) => s.kind !== 'blank');
  const q2 = (surfaces.find((s) => s.kind === 'q2')?.items ?? []) as Q2Candidate[];
  const starts = surfaces
    .filter((s) => s.kind !== 'q2')
    .map((s) => ({ kind: s.kind as Exclude<Expanded, null>, sentence: startSentence(s as StartSurface) }))
    .filter((s): s is { kind: Exclude<Expanded, null>; sentence: string } => !!s.sentence);
  const order: Array<Exclude<Expanded, null>> = ['open_questions', 'captured_away', 'reading_list', 'quiet'];
  starts.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const before = starts.filter((s) => s.kind !== 'quiet');
  const quiet = starts.filter((s) => s.kind === 'quiet');

  const expandedList = (() => {
    const s = opener?.surfaces.find((x) => x.kind === expanded);
    if (!s || s.kind === 'blank' || s.kind === 'q2') return null;
    switch (s.kind) {
      case 'open_questions':
        return s.items.map((q) => (
          <Row
            key={q.question_id}
            title={<span className="home-writing">{q.text}</span>}
            meta={q.exploration_title}
            onOpen={busy ? undefined : () => void open(q.exploration_id, q.exploration_title)}
          />
        ));
      case 'reading_list':
        return s.items.map((r) => (
          <Row
            key={r.reference_id}
            title={r.title || r.url}
            meta={titleOf(r.exploration_id)}
            onOpen={
              busy
                ? undefined
                : () => {
                    openUrl(r.url);
                    void patchReference(workspace, r.exploration_id, r.reference_id, { opened: true });
                    void open(r.exploration_id, titleOf(r.exploration_id));
                  }
            }
          />
        ));
      case 'captured_away':
        return s.items.map((c) => (
          <Row
            key={c.someday_id}
            title={<span className="home-writing">{c.text}</span>}
            meta={c.surface === 'aeronaut' ? 'phone' : c.surface}
            onOpen={
              busy
                ? undefined
                : async () => {
                    setBusy(true);
                    const r = await triageSomeday(workspace, c.someday_id, { action: 'explore' });
                    if (!alive.current) return;
                    setBusy(false);
                    if (r.ok && 'exploration' in r.data) void open(r.data.exploration.id, r.data.exploration.title);
                    else setOpenerError(r.ok ? 'Hester made no exploration' : r.error);
                  }
            }
          />
        ));
      case 'quiet':
        return s.items.map((e) => (
          <Row key={e.exploration_id} title={e.title} meta={formatAge(e.last_touched_at, ctx.now)} onOpen={busy ? undefined : () => void open(e.exploration_id, e.title)} />
        ));
    }
    return null;
  })();

  const startLink = (key: string, label: string, onClick: () => void, on = false) => (
    <button key={key} type="button" className={`home-start-link${on ? ' is-on' : ''}`} aria-expanded={on || undefined} disabled={busy} onClick={onClick}>
      {label}
    </button>
  );

  // ---- Meanwhile's quiet links ----
  const diags = (lint?.diagnostics ?? []).filter((d) => d.severity !== 'off' && (!d.workspace || d.workspace === workspace));
  const links: QuietLink[] = [
    { label: shipped ? 'Hide what shipped' : 'See what shipped', onClick: () => setShipped((x) => !x) },
    {
      label: next.phase === 'loading' ? 'Asking Hester…' : 'Ask Hester what to do next',
      onClick: () => {
        if (next.phase !== 'loading') runNext();
      },
    },
    ...(digest?.retro.due ? [{ label: "This week's retro", onClick: () => setRetroOpen((x) => !x) }] : []),
    ...(diags.length ? [{ label: `⚠ ${diags.length}`, onClick: () => ctx.setSection('ops') }] : []),
  ];

  const awaySummary = (ctx.snapshot?.items ?? []).find((i) => i.kind === 'summary' && i.state === 'open') ?? null;

  return (
    <section className="home">
      <div className="home-greeting">{greeting(new Date(ctx.now))}</div>
      <label htmlFor="home-field" className="home-question">
        {homeQuestion(name)}
      </label>
      <div className="home-field">
        <input
          id="home-field"
          ref={inputRef}
          className="home-input"
          value={text}
          disabled={busy}
          placeholder="Start writing. Enter opens a Page."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void submit();
            }
          }}
        />
        <span className="home-enter" aria-hidden="true">
          ↵
        </span>
      </div>
      {openerError && <div className="home-error">{openerError}</div>}

      {pickUp && (
        <div className="home-block">
          <Card
            className="home-pickup"
            onOpen={() => void open(pickUp.exploration.id, pickUp.exploration.title)}
            selected={isSel(PICKUP_ROW)}
            label={`Continue ${pickUp.exploration.title}`}
          >
            <div data-cockpit-row={PICKUP_ROW}>
              <Eyebrow right={formatAge(pickUp.exploration.last_touched_at, ctx.now)}>Pick up where you left off</Eyebrow>
              <div className="home-pickup-title">{pickUp.exploration.title}</div>
              {pickUp.stopped_at && <WritingQuote text={pickUp.stopped_at} size={19} />}
              {arrivedLine(pickUp.arrived) && <div className="home-pickup-arrived">{arrivedLine(pickUp.arrived)}</div>}
              <div className="home-pickup-actions">
                <Btn kind="next" kbd="⇧⌘0" disabled={busy} onClick={() => void open(pickUp.exploration.id, pickUp.exploration.title)}>
                  Continue
                </Btn>
              </div>
            </div>
          </Card>
        </div>
      )}

      <div className="home-block">
        <Eyebrow>Or start from</Eyebrow>
        <div className="home-starts">
          {startLink('blank', 'A blank page', () => void create({ title: untitledTitle(new Date()) }))}
          {before.map((s) => startLink(s.kind, s.sentence, () => setExpanded((cur) => (cur === s.kind ? null : s.kind)), expanded === s.kind))}
          {q2.map((c) => startLink(`q2:${c.kind}:${c.ref}`, q2Sentence(c), () => onQ2(c)))}
          {quiet.map((s) => startLink(s.kind, s.sentence, () => setExpanded((cur) => (cur === s.kind ? null : s.kind)), expanded === s.kind))}
        </div>
        {expandedList && <Card className="home-start-list">{expandedList}</Card>}
      </div>

      <div className="home-meanwhile">
        <Eyebrow>Meanwhile</Eyebrow>
        {digestError && !digest ? (
          <p className="home-sentence is-muted">{digestError}</p>
        ) : (
          <p className="home-sentence">{digest ? meanwhileSentence(digest, { waiting: waiting + feedNeeds.length, working: ctx.tiles.filter((t) => t.working).length }) : 'Loading…'}</p>
        )}

        {needs.length > 0 && (
          <div className="home-needs">
            {needs.map((r) => {
              const id = `home:${r.id}`;
              const who = r.item.source.tab_label || 'An agent';
              const approval = r.item.kind === 'approval';
              const askLine = approval
                ? r.item.tool
                  ? r.item.tool.preview || r.item.tool.name
                  : r.item.title
                : plainLine(r.item.text, 120) || plainLine(r.item.title, 120);
              return (
                <div key={r.id} data-cockpit-row={id} className={`home-need${isSel(id) ? ' is-selected' : ''}`} onClick={() => ctx.selectRow(id)}>
                  <Dot kind="needs" />
                  <div className="home-need-main">
                    <div className="home-need-name">{who}</div>
                    <div className={`home-need-ask${approval ? ' is-command' : ''}`} title={askLine}>
                      {approval && r.item.tool ? `${r.item.tool.name}: ` : ''}
                      {askLine}
                    </div>
                  </div>
                  <div className="home-need-actions">
                    {approval ? (
                      <>
                        <Btn kind="plain" disabled={!ctx.copilotApi} onClick={() => act(r, 'approve')}>
                          Allow
                        </Btn>
                        <Btn kind="quiet" disabled={!ctx.copilotApi} onClick={() => act(r, 'deny')}>
                          Deny
                        </Btn>
                      </>
                    ) : (
                      <>
                        <Btn kind="plain" onClick={() => replyInWork(r)}>
                          Reply
                        </Btn>
                        <Btn kind="quiet" disabled={!ctx.copilotApi} onClick={() => snooze(r)} title="Until it changes">
                          Snooze
                        </Btn>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {waiting > needs.length && (
              <button type="button" className="home-more" onClick={() => ctx.setSection('work')}>
                {waiting - needs.length} more in Work
              </button>
            )}
          </div>
        )}

        {feedNeeds.length > 0 && (
          <div className="home-needs">
            {feedNeeds.map((r) => (
              <HomeFeedNeed key={r.id} ctx={ctx} row={r} selected={isSel(`home:${r.id}`)} onDismiss={() => dismissEntry(r)} />
            ))}
          </div>
        )}

        <QuietLinks items={links} />

        {shipped && (
          <div className="home-shipped">
            {!digest && <div className="home-muted">Nothing yet.</div>}
            {digest && digest.wins.length === 0 && digest.changed.agent_files.length === 0 && digest.changed.commits === 0 && (
              <div className="home-muted">Nothing shipped since you left.</div>
            )}
            {digest && digest.wins.length > 0 && (
              <Card>
                {digest.wins.slice(0, 8).map((w, i) => (
                  <Row key={`${w.kind}-${w.ref ?? i}`} dot={w.verified ? 'done' : 'idle'} title={<AgentMarkdown inline text={w.title} />} meta={w.ref ?? undefined} />
                ))}
              </Card>
            )}
            {digest && (digest.changed.commits > 0 || digest.changed.agent_files.length > 0) && (
              <div className="home-changed">
                <div className="home-muted">
                  {digest.changed.commits} commit{digest.changed.commits === 1 ? '' : 's'} · {digest.changed.agent_files.length} file
                  {digest.changed.agent_files.length === 1 ? '' : 's'} agents changed
                </div>
                {digest.changed.agent_files.slice(0, 12).map((f) => (
                  <button key={f} type="button" className="home-file" onClick={() => ctx.openFile(f)}>
                    {f}
                  </button>
                ))}
              </div>
            )}
            {awaySummary && <AgentMarkdown className="home-away" text={awaySummary.text} />}
          </div>
        )}

        {next.phase === 'loading' && <div className="home-muted">Hester is weighing your goals and open work…</div>}
        {next.phase === 'error' && <div className="home-error">{next.error}</div>}
        {next.phase === 'done' && (
          <div className="home-answer">
            <StewardAnswerView key={next.answer.request_id} ctx={ctx} answer={next.answer} onClose={() => setNext({ phase: 'idle' })} />
          </div>
        )}

        {ask.phase === 'loading' && <div className="home-muted">Asking: {ask.label}</div>}
        {ask.phase === 'error' && <div className="home-error">{ask.error}</div>}
        {ask.phase === 'done' && (
          <div className="home-answer">
            <div className="home-muted">You asked: {ask.label}</div>
            <StewardAnswerView key={ask.answer.request_id} ctx={ctx} answer={ask.answer} onClose={() => setAsk({ phase: 'idle' })} />
          </div>
        )}

        {retroOpen && digest?.retro.due && (
          <div className="home-answer">
            <RetroCard
              onDone={() => {
                setRetroOpen(false);
                load();
              }}
            />
          </div>
        )}
      </div>
    </section>
  );
};

/**
 * One Lee Feed entry as a Meanwhile row: its first action as the plain
 * button, Dismiss as the quiet second. An action that types or runs text
 * (confirm_text) or takes an input shows it first, then asks again (C3).
 */
const HomeFeedNeed: React.FC<{ ctx: CockpitCtx; row: LeeFeedRow; selected: boolean; onDismiss: () => void }> = ({ ctx, row, selected, onDismiss }) => {
  const entry = row.entry;
  const id = `home:${row.id}`;
  const [pending, setPending] = useState<FeedAction | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = entry.actions[0] ?? null;

  const act = (action: FeedAction, payload?: Record<string, string>) => {
    if (!ctx.api || busy) return;
    if (entry.kind === 'proposal') ctx.copilotApi?.logCeremony('confirm', 'proposal');
    setBusy(true);
    setError(null);
    ctx.api.feed
      .act(entry.id, action.id, payload)
      .then((r) => {
        if (!r.success) {
          setError(r.error || 'failed');
          return;
        }
        setPending(null);
        const ra = rendererAction(r);
        if (ra?.action === 'what-next') ctx.requestSteward({ kind: 'what-next' });
        else if (ra?.action === 'link-goal') {
          const taskId = ra.taskId ?? entry.ref.task_id ?? null;
          if (taskId) ctx.requestSteward({ kind: 'link-goal', taskId });
        }
      })
      .catch(() => setError('failed'))
      .finally(() => setBusy(false));
  };
  const start = (a: FeedAction) => {
    if (a.confirm_text || a.input) {
      setPending(a);
      setValue(a.input?.kind === 'select' ? a.input.options?.[0] ?? '' : '');
    } else act(a);
  };
  const sub = plainLine(entry.text, 120);

  return (
    <div data-cockpit-row={id} className={`home-need is-feed${selected ? ' is-selected' : ''}`} onClick={() => ctx.selectRow(id)}>
      <Dot kind="needs" />
      <div className="home-need-main">
        <div className="home-need-name">{entry.title}</div>
        {sub && (
          <div className="home-need-ask" title={sub}>
            {entry.text_is_agent ? `Agent says: ${sub}` : sub}
          </div>
        )}
      </div>
      {!pending && (
        <div className="home-need-actions" onClick={(e) => e.stopPropagation()}>
          {primary && (
            <Btn kind="plain" disabled={busy || !ctx.api} title={primary.confirm_text ?? undefined} onClick={() => start(primary)}>
              {primary.label}
            </Btn>
          )}
          <Btn kind="quiet" disabled={busy || !ctx.api} title="Dismiss (⌘⌫)" onClick={onDismiss}>
            Dismiss
          </Btn>
        </div>
      )}
      {pending && (
        <div className="home-need-confirm" onClick={(e) => e.stopPropagation()}>
          {pending.confirm_text && (
            <>
              <div className="home-muted">{pending.label} will do exactly this:</div>
              <pre className="home-need-confirm-text">{pending.confirm_text}</pre>
            </>
          )}
          {pending.input?.kind === 'text' && (
            <input autoFocus className="home-need-input" value={value} placeholder={pending.input.placeholder} onChange={(e) => setValue(e.target.value)} />
          )}
          {pending.input?.kind === 'select' && (
            <select className="home-need-input" value={value} onChange={(e) => setValue(e.target.value)}>
              {(pending.input.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
          <div className="home-need-actions">
            <Btn
              kind="plain"
              disabled={busy || (!!pending.input && !value)}
              onClick={() => act(pending, pending.input ? { [pending.input.param]: value } : undefined)}
            >
              Confirm {pending.label}
            </Btn>
            <Btn kind="quiet" onClick={() => setPending(null)}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
      {error && <div className="home-error home-need-confirm">{error}</div>}
    </div>
  );
};

export default HomeSection;
