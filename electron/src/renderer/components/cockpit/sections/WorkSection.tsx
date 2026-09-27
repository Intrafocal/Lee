/**
 * WorkSection - Work: what needs you and what's in flight, in one column
 * (cockpit-design §4; package R2). Replaces Feed, Tasks and the agent tiles.
 *
 * The list: a line ("Two things need you.") over the waiting cards in the queue's order (the first raised,
 * its Allow the view's one next step), then "In flight" rows (busy agents
 * with what they're doing now, then ready to review, then idle; idle over
 * 2h folds into "n earlier today"; running and failed operations), else
 * "All clear." (or "Working on it." while agents are busy) with Continue. Clicking a card or row replaces the
 * list with its detail view (WorkDetail) in place.
 *
 * Keys ride the Cockpit keymap (CockpitHost): ↑/↓ move the selection over
 * the rows this registers, ⏎ opens, ⌘⏎ / ⌘D allow / deny, ⌘E renames, ⌘⌫
 * dismisses (with Undo). In the detail view ↑/↓ step to the previous or
 * next item and Esc returns to the list with the item selected.
 *
 * Swipes and ⌘⌫ wait out their 5s Undo row before the queue hears of them;
 * leaving Work sends them at once.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttentionItem } from '../../../../shared/copilot';
import type { AboutRef } from '../../../../shared/cockpit';
import { taskTitle, workLine, type TileModel } from '../../../lib/cockpitModel';
import {
  SWIPE_UNDO_MS,
  agentTimes,
  canTextReply,
  doneToday,
  earlierLabel,
  inFlight,
  swipedLabel,
  waitingItems,
  workSummary,
  type FlightRow,
  type SwipeAction,
  type WaitingItem,
} from '../../../lib/workModel';
import { Btn, Card, Eyebrow, Row, SectionHead } from '../ui';
import { goDeep } from '../cockpitMode';
import type { CockpitCtx, RowHandle } from '../CockpitHost';
import { SwipedRow, WaitingCard } from '../work/WaitingCard';
import { WorkDetail, taskName, type DetailSubject } from '../work/WorkDetail';
import { dismiss as dismissItem, snooze as snoozeItem } from '../work/actions';

/** link-goal requests already handled (per window), so a remount never replays one. */
let handledLinkNonce = 0;

const EARLIER_ID = 'work:earlier';

interface DetailState {
  id: string;
  /** The agent behind it, so an answered item's detail falls back to its agent. */
  pty: number | null;
  reply: boolean;
  link: boolean;
}

interface Swiped {
  item: AttentionItem;
  name: string;
  action: SwipeAction;
}

function aboutTile(tile: TileModel): AboutRef {
  return tile.task
    ? { kind: 'task', id: tile.task.id, label: tile.title }
    : { kind: 'tile', id: String(tile.ptyId), label: tile.title, record: { pty_id: tile.ptyId, title: tile.title, provider: tile.provider } };
}

export const WorkSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const snapshot = ctx.snapshot;
  const open = ctx.hester.snapshot?.tasks.open;
  const closed = ctx.hester.snapshot?.tasks.recent_closed;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // ---- swipes and their Undo window ----
  const [swiped, setSwiped] = useState<Record<string, Swiped>>({});
  // Sent to the queue: hidden until the snapshot drops them (or the send fails).
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, { timer: number; s: Swiped }>());

  const commit = useCallback((itemId: string) => {
    const pending = timers.current.get(itemId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    timers.current.delete(itemId);
    const { s } = pending;
    setSwiped(({ [itemId]: _done, ...rest }) => rest);
    // Handled elsewhere during the Undo window: nothing left to send.
    const still = ctxRef.current.snapshot?.items.some((i) => i.id === itemId && i.state === 'open');
    if (!still) return;
    setGone((g) => new Set(g).add(itemId));
    const send = s.action === 'snooze' ? snoozeItem : dismissItem;
    void send(ctxRef.current, s.item).then((ok) => {
      if (!ok)
        setGone((g) => {
          const next = new Set(g);
          next.delete(itemId);
          return next;
        });
    });
  }, []);

  const fireSwipe = useCallback(
    (w: WaitingItem, action: SwipeAction) => {
      const allowed = w.item.actions.includes(action);
      if (!allowed) {
        ctxRef.current.notify(action === 'snooze' ? 'This one can’t be snoozed' : 'This one can’t be dismissed', 'error');
        return;
      }
      if (timers.current.has(w.item.id)) return;
      const s: Swiped = { item: w.item, name: w.name, action };
      const timer = window.setTimeout(() => commit(w.item.id), SWIPE_UNDO_MS);
      timers.current.set(w.item.id, { timer, s });
      setSwiped((m) => ({ ...m, [w.item.id]: s }));
    },
    [commit],
  );

  const undo = useCallback((itemId: string) => {
    const pending = timers.current.get(itemId);
    if (pending) window.clearTimeout(pending.timer);
    timers.current.delete(itemId);
    setSwiped(({ [itemId]: _undone, ...rest }) => rest);
  }, []);

  // Forget sent items once the queue no longer has them open.
  const openKey = (snapshot?.items ?? []).filter((i) => i.state === 'open').map((i) => i.id).join('\n');
  useEffect(() => {
    const openIds = new Set(openKey.split('\n'));
    setGone((g) => {
      const next = new Set([...g].filter((id) => openIds.has(id)));
      return next.size === g.size ? g : next;
    });
  }, [openKey]);

  // Leaving Work sends what's still in its Undo window.
  useEffect(
    () => () => {
      for (const id of [...timers.current.keys()]) commit(id);
    },
    [commit],
  );

  // ---- the model ----
  const allWaiting = useMemo(
    () => waitingItems({ items: snapshot?.items, workspace: ctx.workspace, tiles: ctx.tiles, hidden: gone }),
    [snapshot, ctx.workspace, ctx.tiles, gone],
  );
  const waiting = allWaiting.filter((w) => !swiped[w.item.id]);
  const times = useMemo(() => agentTimes(snapshot, ctx.runtime), [snapshot, ctx.runtime]);
  const flight = useMemo(() => {
    const reviewPtys = new Set<number>();
    for (const i of snapshot?.items ?? []) if (i.state === 'open' && i.kind === 'review' && i.source.pty_id != null) reviewPtys.add(i.source.pty_id);
    const waitingPtys = new Set<number>();
    for (const w of waiting) if (w.ptyId != null) waitingPtys.add(w.ptyId);
    return inFlight({
      tiles: ctx.tiles,
      agents: snapshot?.agents,
      times,
      tasks: open,
      ops: ctx.ops?.operations,
      reviewPtys,
      waitingPtys,
      now: ctx.now,
    });
    // `waiting` is derived from these; its identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.tiles, snapshot, times, open, ctx.ops, ctx.now, allWaiting, swiped]);
  const [showEarlier, setShowEarlier] = useState(false);
  const flightRows = showEarlier ? [...flight.rows, ...flight.earlier] : flight.rows;

  const summary = workSummary({
    waiting: waiting.length,
    working: flight.rows.filter((r) => r.group === 'busy').length,
    done: doneToday(closed, ctx.now) + flight.rows.filter((r) => r.group === 'review').length,
  });

  // ---- selection and the detail view ----
  const sel = ctx.mode.selected?.kind === 'row' ? ctx.mode.selected.id : null;
  const [detail, setDetail] = useState<DetailState | null>(null);
  const detailIds = useMemo(
    () => [...waiting.map((w) => w.id), ...flightRows.filter((r) => r.kind !== 'op').map((r) => r.id)],
    [waiting, flightRows],
  );

  const ptyOf = (id: string): number | null => {
    const w = allWaiting.find((x) => x.id === id);
    if (w) return w.ptyId;
    const r = [...flight.rows, ...flight.earlier].find((x) => x.id === id);
    return r?.ptyId ?? null;
  };

  const openDetail = (id: string, reply = false, link = false) => {
    ctx.selectRow(id);
    setDetail({ id, pty: ptyOf(id), reply, link });
  };

  const closeDetail = () => {
    if (!detail) return;
    const id = detail.id;
    setDetail(null);
    ctx.selectRow(id);
    window.setTimeout(() => document.querySelector(`[data-cockpit-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
  };

  // The detail follows the selection (↑/↓ in the Cockpit keymap); the
  // keymap's Esc (focus outside Work) clears it: back to the list, selected.
  // Null at mount, so a task link that switched to Work opens its detail.
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const was = prevSel.current;
    prevSel.current = sel;
    if (was === sel) return;
    // A task link from elsewhere (Feed's older ids): open its detail.
    if (sel?.startsWith('task:')) {
      const taskId = sel.slice(5);
      const tile = ctx.tiles.find((t) => t.task?.id === taskId);
      openDetail(tile ? `work:agent:${tile.ptyId}` : `work:task:${taskId}`);
      return;
    }
    // Home's Reply (feed row id `att:<item id>`): that item's detail, reply field focused.
    if (sel?.startsWith('att:')) {
      openDetail(`work:item:${sel.slice(4)}`, true);
      return;
    }
    if (!detail) return;
    if (sel == null) {
      if (was === detail.id) closeDetail();
      return;
    }
    if (sel !== detail.id && detailIds.includes(sel)) setDetail({ id: sel, pty: ptyOf(sel), reply: false, link: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // A lint fix's link-goal request (§2.2 routes it here): that task's detail with the goal picker.
  const pending = ctx.pendingSteward;
  useEffect(() => {
    if (!pending || pending.nonce <= handledLinkNonce || pending.req.kind !== 'link-goal') return;
    handledLinkNonce = pending.nonce;
    const taskId = pending.req.taskId;
    const tile = ctx.tiles.find((t) => t.task?.id === taskId);
    openDetail(tile ? `work:agent:${tile.ptyId}` : `work:task:${taskId}`, false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const subject = detail ? resolveSubject(ctx, detail, allWaiting, times) : null;

  // An answered item's detail becomes its agent's.
  const subjectId = subject?.id ?? null;
  useEffect(() => {
    if (detail && subjectId && subjectId !== detail.id) {
      setDetail({ ...detail, id: subjectId, reply: false, link: false });
      ctx.selectRow(subjectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId]);

  // ---- rows for the Cockpit keymap ----
  const handleFor = (id: string): RowHandle | null => {
    const w = waiting.find((x) => x.id === id);
    if (w) {
      const tile = w.ptyId != null ? ctx.tiles.find((t) => t.ptyId === w.ptyId) ?? null : null;
      return {
        id,
        title: w.name,
        ptyId: w.ptyId,
        open: () => openDetail(id),
        approval: w.kind === 'approval' && w.item.actions.includes('approve') ? w.item : null,
        replyItem: canTextReply(w.item) ? w.item : null,
        dismiss: w.item.actions.includes('dismiss') ? () => fireSwipe(w, 'dismiss') : undefined,
        rename: tile ? () => ctx.openRename({ ptyId: tile.ptyId, taskId: tile.task?.id ?? null, current: tile.title, provider: tile.provider }) : undefined,
        checkin: tile?.canCheckin && !tile.checkin ? () => ctx.openCheckin(tile.ptyId, w.name) : undefined,
        about: tile ? aboutTile(tile) : { kind: 'feed', id: w.item.id, label: w.item.title, record: w.item },
      };
    }
    if (id === EARLIER_ID) return { id, title: earlierLabel(flight.earlier.length), open: () => setShowEarlier((s) => !s) };
    const r = flightRows.find((x) => x.id === id);
    if (!r) return null;
    if (r.kind === 'op') {
      return { id, title: r.title, open: () => ctx.setSection('ops'), about: { kind: 'operation', id: r.opName ?? r.title, label: r.title } };
    }
    const tile = r.ptyId != null ? ctx.tiles.find((t) => t.ptyId === r.ptyId) ?? null : null;
    const task = tile?.task ?? (r.taskId ? [...(open ?? []), ...(closed ?? [])].find((t) => t.id === r.taskId) ?? null : null);
    return {
      id,
      title: r.title,
      ptyId: r.ptyId,
      open: () => openDetail(id),
      approval: tile?.approval ?? null,
      replyItem: tile?.replyItem ?? null,
      rename: () => ctx.openRename({ ptyId: r.ptyId, taskId: task?.id ?? null, current: r.title, provider: tile?.provider ?? task?.agent?.provider ?? null }),
      checkin: tile?.canCheckin && !tile.checkin ? () => ctx.openCheckin(tile.ptyId, r.title) : undefined,
      about: tile ? aboutTile(tile) : task ? { kind: 'task', id: task.id, label: r.title } : null,
    };
  };
  const listIds = [
    ...waiting.map((w) => w.id),
    ...flight.rows.map((r) => r.id),
    ...(flight.earlier.length ? [EARLIER_ID] : []),
    ...(showEarlier ? flight.earlier.map((r) => r.id) : []),
  ];
  const handles = (detail ? detailIds : listIds).map(handleFor).filter((h): h is RowHandle => !!h);
  useEffect(() => {
    ctx.registerRows(handles);
  });

  // Esc in the detail view (focus inside Work) goes back to the list.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!detail || e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    closeDetail();
  };

  // ---- render ----
  if (detail && subject) {
    return (
      <div className="work" onKeyDown={onKeyDown}>
        <WorkDetail key={subject.id} ctx={ctx} subject={subject} focusReply={detail.reply} openLink={detail.link} onBack={closeDetail} />
      </div>
    );
  }
  if (detail && !subject) {
    return (
      <div className="work" onKeyDown={onKeyDown}>
        <nav className="work-detail-nav">
          <Btn kind="quiet" onClick={() => setDetail(null)}>
            ‹ Work
          </Btn>
        </nav>
        <p className="work-gone">That one is no longer here.</p>
      </div>
    );
  }

  const swipedList = allWaiting.filter((w) => swiped[w.item.id]);
  const hasWaiting = waiting.length > 0 || swipedList.length > 0;
  const renderFlight = (r: FlightRow) => (
    <div key={r.id} data-cockpit-row={r.id} className="work-row-slot">
      <Row
        dot={r.dot}
        title={r.title}
        sub={r.sub}
        meta={r.meta || undefined}
        selected={sel === r.id}
        onOpen={() => (r.kind === 'op' ? ctx.setSection('ops') : openDetail(r.id))}
      />
    </div>
  );

  return (
    <div className="work" onKeyDown={onKeyDown}>
      <SectionHead title="Work" summary={summary || undefined} />
      {ctx.hester.offline && !ctx.hester.snapshot && <div className="work-hint">{ctx.hester.offline}: tasks need Hester. Agents and approvals still work.</div>}

      {hasWaiting ? (
        <>
          <p className="work-line">{workLine({ waiting: waiting.length })}</p>
          <div className="work-waiting">
            {allWaiting.map((w) => {
              const s = swiped[w.item.id];
              if (s) return <SwipedRow key={w.id} label={swipedLabel(s.action)} name={s.name} onUndo={() => undo(w.item.id)} />;
              return (
                <div key={w.id} data-cockpit-row={w.id} className="work-card-slot">
                  <WaitingCard
                    ctx={ctx}
                    w={w}
                    raised={w === waiting[0]}
                    selected={sel === w.id}
                    onOpen={(reply) => openDetail(w.id, !!reply)}
                    onSwipe={(action) => fireSwipe(w, action)}
                  />
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="work-empty">
          <p className="work-line">{workLine({ waiting: 0, working: flight.rows.filter((r) => r.group === 'busy').length })}</p>
          <Btn kind="next" kbd="⇧⌘0" onClick={() => goDeep(ctx.copilotApi, ctx.workspace)}>
            Continue
          </Btn>
        </div>
      )}

      {(flight.rows.length > 0 || flight.earlier.length > 0) && (
        <>
          <Eyebrow>In flight</Eyebrow>
          <Card className="work-flight">
            {flight.rows.map(renderFlight)}
            {flight.earlier.length > 0 && (
              <div data-cockpit-row={EARLIER_ID} className="work-row-slot">
                <Row
                  dot="idle"
                  title={showEarlier ? 'Hide earlier' : earlierLabel(flight.earlier.length)}
                  selected={sel === EARLIER_ID}
                  onOpen={() => setShowEarlier((s) => !s)}
                />
              </div>
            )}
            {showEarlier && flight.earlier.map(renderFlight)}
          </Card>
        </>
      )}
    </div>
  );
};

/** The detail view's subject: an item (and its agent), an agent, or a task. */
function resolveSubject(
  ctx: CockpitCtx,
  d: DetailState,
  waiting: readonly WaitingItem[],
  times: ReturnType<typeof agentTimes>,
): DetailSubject | null {
  const tasks = [...(ctx.hester.snapshot?.tasks.open ?? []), ...(ctx.hester.snapshot?.tasks.recent_closed ?? [])];
  let item: AttentionItem | null = null;
  let pty: number | null = d.pty;
  let task = null as (typeof tasks)[number] | null;
  let id = d.id;
  if (d.id.startsWith('work:item:')) {
    const itemId = d.id.slice('work:item:'.length);
    item = waiting.find((w) => w.item.id === itemId)?.item ?? null;
    if (item) pty = item.source.pty_id ?? pty;
    else if (pty != null) id = `work:agent:${pty}`;
  } else if (d.id.startsWith('work:agent:')) {
    pty = Number(d.id.slice('work:agent:'.length));
  } else if (d.id.startsWith('work:task:')) {
    const taskId = d.id.slice('work:task:'.length);
    task = tasks.find((t) => t.id === taskId) ?? null;
    const p = task?.agent?.pty_id ?? null;
    pty = p != null && ctx.tiles.some((t) => t.ptyId === p) ? p : null;
  }
  const tile = pty != null ? ctx.tiles.find((t) => t.ptyId === pty) ?? null : null;
  task = task ?? tile?.task ?? null;
  if (!item && pty != null) item = waiting.find((w) => w.ptyId === pty)?.item ?? null;
  if (!item && !tile && !task) return null;
  const agent = pty != null ? ctx.snapshot?.agents?.find((a) => a.pty_id === pty) ?? null : null;
  const rt = pty != null ? ctx.runtime.find((r) => r.pty_id === pty) ?? null : null;
  const name = tile?.title || (task ? taskName(task) : '') || item?.source.tab_label || (task ? taskTitle(task) : '') || 'Agent';
  return {
    id,
    name,
    item,
    tile,
    task,
    agent,
    ptyId: pty,
    provider: tile?.provider ?? item?.source.provider ?? task?.agent?.provider ?? null,
    workspace: item?.source.workspace ?? agent?.workspace ?? ctx.workspace,
    busySince: pty != null ? times.get(pty)?.busySince ?? null : null,
    sessionId: rt?.session_id ?? null,
  };
}

export default WorkSection;
