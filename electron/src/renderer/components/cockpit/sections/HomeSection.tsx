/**
 * HomeSection - Home (cockpit-design §3; Desk D2 §8, docs/16-Desk.md §6).
 * The Cockpit's job is reassurance: you check it, then go back to your Desk.
 * One centred column of --col-home, top to bottom:
 *
 * 1. The greeting, "<weekday> <part of day>" (greeting()), and one
 *    reassuring sentence (meanwhileSentence(): "Everything's handled." when
 *    nothing waits).
 * 2. The one or two things that need you, answerable here with Work's
 *    waiting card (Allow / Deny, quick replies; never the phosphor step
 *    here), then "n more in Work". Lee Feed entries that need you and live
 *    nowhere else follow (homeFeedNeeds(): a check-in proposal, an escalate
 *    proposal; the entry's first action, shown verbatim first when it types
 *    or runs something, C3, and Dismiss ⌘⌫).
 * 3. Shipped this week: History's wins strip (GET /cockpit/history?days=7),
 *    then quiet links: This week's retro when due, Ask Hester what to do
 *    next (answered inline), and work lint as ⚠ N (to Ops).
 * 4. Back to your Desk, the view's one next step: a big door with your last
 *    card's title (Newsreader) and its stopped-at line (Newsreader italic),
 *    from GET /desk/last. With no card, or an older Hester without the
 *    route, it reads "Go to your Desk". Either way it's
 *    openDesk({ kind: 'last' }).
 *
 * The opener ("What's on your mind?", Or start from) left Home for the Desk,
 * where typing on an empty Area starts a Page. The digest, the wins and the
 * door refresh on load, on return and every 10 minutes while shown. Steward
 * requests from outside (a lint item's Ask Hester, a lint fix's what-next)
 * still land here and answer inline. Asking anything else is ⌘/.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AboutRef, FeedAction, LintSnapshot, StewardAnswer } from '../../../../shared/cockpit';
import type { DeskLast } from '../../../../shared/desk';
import { fetchDigest, type DigestResponse } from '../../../lib/hesterCopilot';
import { askSteward, fetchDeskLast, fetchHistory, whatNext, type HistoryResponse } from '../../../lib/hesterCockpit';
import {
  HOME_NEEDS_MAX,
  deskDoor,
  formatAge,
  greeting,
  homeFeedNeeds,
  homeMoreLine,
  meanwhileSentence,
  plainLine,
  rendererAction,
  type LeeFeedRow,
} from '../../../lib/cockpitModel';
import { waitingItems, type SwipeAction, type WaitingItem } from '../../../lib/workModel';
import { openDesk } from '../cockpitMode';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import { RetroCard } from '../../copilot/RetroCard';
import { WaitingCard } from '../work/WaitingCard';
import { dismiss as dismissItem, snooze as snoozeItem } from '../work/actions';
import { Btn, Card, Dot, Eyebrow, QuietLinks, Row, WritingQuote, type QuietLink } from '../ui';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

interface HomeSectionProps {
  ctx: CockpitCtx;
  returnNonce: number;
  /**
   * First-render data before the fetches land (the renderer smoke renders
   * Home from fixtures; the app passes none). `deskLast: null` is an older
   * Hester (or Hester offline).
   */
  seed?: { digest?: DigestResponse | null; deskLast?: DeskLast | null; shipped?: HistoryResponse | null };
}

const REFRESH_MS = 10 * 60000;
const DOOR_ROW = 'home:door';
/** Wins shown in the strip; the rest are in Hester's history. */
const SHIPPED_MAX = 6;
/** Default question when a lint item's Ask Hester asks without one. */
const DEFAULT_QUESTION = 'What should I do about this?';

/** Steward requests already handled (per window), so a remount never replays one. */
let handledNonce = 0;

type AskState = { phase: 'idle' } | { phase: 'loading'; label: string } | { phase: 'done'; answer: StewardAnswer; label: string } | { phase: 'error'; error: string };

export const HomeSection: React.FC<HomeSectionProps> = ({ ctx, returnNonce, seed }) => {
  const workspace = ctx.workspace;
  const [digest, setDigest] = useState<DigestResponse | null>(seed?.digest ?? null);
  const [shipped, setShipped] = useState<HistoryResponse | null>(seed?.shipped ?? null);
  const [shippedError, setShippedError] = useState<string | null>(null);
  const [deskLast, setDeskLast] = useState<DeskLast | null>(seed?.deskLast ?? null);
  const [busy, setBusy] = useState(false);
  const [retroOpen, setRetroOpen] = useState(false);
  const [lint, setLint] = useState<LintSnapshot | null>(null);
  const [ask, setAsk] = useState<AskState>({ phase: 'idle' });
  const [next, setNext] = useState<AskState>({ phase: 'idle' });
  // Items swiped away here: hidden at once, the queue hears of them right away.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
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
    setDeskLast(null);
  }

  // ---- the digest, the week's wins and the door: on load, on return, every 10 minutes ----
  const load = useCallback(() => {
    if (!workspace) return () => undefined;
    let cancelled = false;
    fetchDigest({ workspace }).then((r) => {
      if (!cancelled && r.ok) setDigest(r.data);
    });
    fetchHistory(workspace, 7).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setShipped(r.data);
        setShippedError(null);
      } else setShippedError(r.error);
    });
    // A 404 (an older Hester) or no Hester: the door reads "Go to your Desk" (§10).
    fetchDeskLast(workspace).then((r) => {
      if (!cancelled) setDeskLast(r.ok ? r.data : null);
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

  // ---- the door ----
  const door = deskDoor(deskLast);
  const goToDesk = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openDesk(ctx.copilotApi, workspace, { kind: 'last' });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // ---- needs you: Work's waiting cards, at most two here ----
  const snapshot = ctx.snapshot;
  const waiting = useMemo(
    () => waitingItems({ items: snapshot?.items, workspace, tiles: ctx.tiles, hidden: gone, agents: snapshot?.agents }),
    [snapshot, workspace, ctx.tiles, gone],
  );
  const shownWaiting = waiting.slice(0, HOME_NEEDS_MAX);
  const more = homeMoreLine(waiting.length, shownWaiting.length);
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
  /** A card's detail (and its reply box) is Work's. */
  const openInWork = (w: WaitingItem) => {
    ctx.setSection('work');
    ctx.selectRow(w.id);
  };
  const swipe = (w: WaitingItem, action: SwipeAction) => {
    setGone((g) => new Set(g).add(w.item.id));
    const done = action === 'dismiss' ? dismissItem(ctx, w.item) : snoozeItem(ctx, w.item);
    void done.then((ok) => {
      if (ok || !alive.current) return;
      setGone((g) => {
        const n = new Set(g);
        n.delete(w.item.id);
        return n;
      });
    });
  };

  const rows: RowHandle[] = [
    ...shownWaiting.map((w) => ({
      id: w.id,
      title: w.name,
      open: () => openInWork(w),
      approval: w.kind === 'approval' ? w.item : null,
      replyItem: w.item,
      ptyId: w.ptyId,
    })),
    ...feedNeeds.map((r) => ({
      id: `home:${r.id}`,
      title: r.title,
      ptyId: r.entry.ref.pty_id ?? null,
      open: () => openEntry(r),
      dismiss: () => dismissEntry(r),
      about: { kind: 'feed' as const, id: r.entry.id, label: r.title, record: r.entry },
    })),
    { id: DOOR_ROW, title: door.title ?? door.label, open: () => void goToDesk() },
  ];
  useEffect(() => {
    ctx.registerRows(rows);
  });
  const sel = ctx.mode.selected;
  const isSel = (id: string) => sel?.kind === 'row' && sel.id === id;

  // ---- shipped this week, and the quiet links under it ----
  const wins = shipped?.wins ?? [];
  const diags = (lint?.diagnostics ?? []).filter((d) => d.severity !== 'off' && (!d.workspace || d.workspace === workspace));
  const links: QuietLink[] = [
    ...(digest?.retro.due ? [{ label: "This week's retro", onClick: () => setRetroOpen((x) => !x) }] : []),
    {
      label: next.phase === 'loading' ? 'Asking Hester…' : 'Ask Hester what to do next',
      onClick: () => {
        if (next.phase !== 'loading') runNext();
      },
    },
    ...(diags.length ? [{ label: `⚠ ${diags.length}`, onClick: () => ctx.setSection('ops') }] : []),
  ];

  const working = ctx.tiles.filter((t) => t.working).length;

  return (
    <section className="home">
      <div className="home-greeting">{greeting(new Date(ctx.now))}</div>
      <p className="home-lead">{meanwhileSentence(digest, { waiting: waiting.length + feedNeeds.length, working })}</p>

      {(shownWaiting.length > 0 || feedNeeds.length > 0) && (
        <div className="home-block home-needs-block">
          {shownWaiting.length > 0 && (
            <div className="work-waiting">
              {shownWaiting.map((w) => (
                <div key={w.id} data-cockpit-row={w.id}>
                  <WaitingCard
                    ctx={ctx}
                    w={w}
                    raised={false}
                    selected={isSel(w.id)}
                    onOpen={() => openInWork(w)}
                    onSwipe={(action) => swipe(w, action)}
                  />
                </div>
              ))}
            </div>
          )}
          {more && (
            <button type="button" className="home-more" onClick={() => ctx.setSection('work')}>
              {more}
            </button>
          )}
          {feedNeeds.length > 0 && (
            <div className="home-needs">
              {feedNeeds.map((r) => (
                <HomeFeedNeed key={r.id} ctx={ctx} row={r} selected={isSel(`home:${r.id}`)} onDismiss={() => dismissEntry(r)} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="home-block">
        <Eyebrow>Shipped this week</Eyebrow>
        {shippedError && !shipped && <div className="home-muted">{shippedError}</div>}
        {!shipped && !shippedError && <div className="home-muted">Loading…</div>}
        {shipped && wins.length === 0 && <div className="home-muted">Nothing verified this week yet.</div>}
        {wins.length > 0 && (
          <Card className="home-shipped-list">
            {wins.slice(0, SHIPPED_MAX).map((w, i) => (
              <Row key={`${w.kind}-${w.ref ?? i}`} dot={w.verified ? 'done' : 'idle'} title={<AgentMarkdown inline text={w.title} />} meta={formatAge(w.at, ctx.now)} />
            ))}
          </Card>
        )}
        <QuietLinks items={links} />

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
      </div>

      <div className="home-block">
        <Card className="home-door" onOpen={() => void goToDesk()} selected={isSel(DOOR_ROW)} label={door.title ? `${door.label}: ${door.title}` : door.label}>
          <div data-cockpit-row={DOOR_ROW}>
            <Eyebrow right={deskLast?.card?.last_touched_at ? formatAge(deskLast.card.last_touched_at, ctx.now) : undefined}>Your Desk</Eyebrow>
            {door.title && <div className="home-door-title">{door.title}</div>}
            {door.stopped && <WritingQuote text={door.stopped} size={19} />}
            <div className="home-door-actions">
              <Btn kind="next" kbd="⇧⌘0" disabled={busy} onClick={() => void goToDesk()}>
                {door.label}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
};

/**
 * One Lee Feed entry as a needs-you row: its first action as the plain
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
