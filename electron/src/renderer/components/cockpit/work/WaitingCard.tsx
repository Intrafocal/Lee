/**
 * WaitingCard - one "Waiting on you" item in Work's list (cockpit-design
 * §4.1, §4.3): a meta line (needs dot, the agent, provider · workspace, age),
 * the body by kind (an approval's exact command, a question's options, else
 * the agent's words clipped at six lines), and its actions (Allow / Deny, or
 * the first three quick replies and "Write a reply…"). The whole card opens
 * the detail view, except on its controls.
 *
 * A horizontal trackpad scroll past 120px snoozes (leftward) or dismisses
 * (rightward); the ⋯ menu offers the same to mouse users. Approving is never
 * a gesture.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Btn, Card, Chip, Dot } from '../ui';
import { stripMarkdown } from '../../../lib/cockpitModel';
import {
  SWIPE_IDLE,
  SWIPE_IDLE_MS,
  approvalLine,
  canTextReply,
  providerLabel,
  quickReplies,
  shortAge,
  swipeRelease,
  swipeStep,
  workspaceName,
  type SwipeAction,
  type SwipeState,
  type WaitingItem,
} from '../../../lib/workModel';
import type { CockpitCtx } from '../CockpitHost';
import { choosable, choose, decide, sendText } from './actions';
import { MoreMenu } from './MoreMenu';

/** Lines of the agent's words a card shows before "More". */
const CLIP_LINES = 6;

interface WaitingCardProps {
  ctx: CockpitCtx;
  w: WaitingItem;
  /** The first card: the one that needs you most (its Allow is the view's next step). */
  raised: boolean;
  selected: boolean;
  /** Open the detail view; `reply` focuses its reply field. */
  onOpen: (reply?: boolean) => void;
  onSwipe: (action: SwipeAction) => void;
}

export const WaitingCard: React.FC<WaitingCardProps> = ({ ctx, w, raised, selected, onOpen, onSwipe }) => {
  const { item } = w;
  const [busy, setBusy] = useState(false);
  const [swipe, setSwipe] = useState<SwipeState>(SWIPE_IDLE);
  const swipeRef = useRef<SwipeState>(SWIPE_IDLE);
  const idleTimer = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
    },
    [],
  );

  const act = (fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => {
      if (alive.current) setBusy(false);
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    const { state, fire } = swipeStep(swipeRef.current, { deltaX: e.deltaX, deltaY: e.deltaY });
    if (state !== swipeRef.current) {
      swipeRef.current = state;
      setSwipe(state);
    }
    if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      swipeRef.current = swipeRelease(swipeRef.current);
      if (alive.current) setSwipe(swipeRef.current);
    }, SWIPE_IDLE_MS);
    if (fire) onSwipe(fire);
  };

  const where = [providerLabel(w.provider), workspaceName(w.workspace)].filter(Boolean).join(' · ');
  const text = canTextReply(item);
  const lines = w.kind === 'text' ? stripMarkdown(item.text) : [];
  const clipped = lines.length > CLIP_LINES || item.text.length > 600;
  const question = w.kind === 'question' ? item.question?.questions[0] ?? null : null;
  const canChoose = choosable(item);

  return (
    <div className="work-swipe" onWheel={onWheel}>
      <Card
        tone={raised ? 'raised' : 'needs'}
        selected={selected}
        onOpen={() => onOpen(false)}
        label={`${w.name}: ${item.title}`}
        className={`work-card${swipe.dx ? ' is-swiping' : ''}`}
        style={swipe.dx ? { transform: `translateX(${swipe.dx}px)` } : undefined}
      >
        <div className="work-card-meta">
          <Dot kind="needs" />
          <span className="work-card-name">{w.name}</span>
          {where && <span className="work-card-where">· {where}</span>}
          <span className="work-card-age">{shortAge(w.since, ctx.now)}</span>
          <MoreMenu
            label={`More for ${w.name}`}
            items={[
              { label: 'Snooze until it changes', onClick: () => onSwipe('snooze') },
              ...(item.actions.includes('dismiss') ? [{ label: 'Dismiss', onClick: () => onSwipe('dismiss') }] : []),
              ...(w.ptyId != null ? [{ label: 'Open terminal in Manual', onClick: () => ctx.goInto(w.ptyId as number, 'feed') }] : []),
            ]}
          />
        </div>

        {w.kind === 'approval' && (
          <>
            <div className="work-card-line">{approvalLine(item)}</div>
            {item.tool?.preview && <pre className="work-command">{item.tool.preview}</pre>}
          </>
        )}
        {question && (
          <>
            <div className="work-card-line">{question.question}</div>
            {question.options.length > 0 && (
              <div className="work-chips">
                {question.options.map((o, i) => (
                  <Chip
                    key={`${i}:${o.label}`}
                    label={o.label}
                    title={canChoose ? o.description ?? undefined : 'Answer this one in its terminal'}
                    disabled={!canChoose || busy}
                    onClick={() => act(() => choose(ctx, item, i))}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {w.kind === 'text' && (
          <>
            <div className="work-words">{lines.join('\n') || item.title}</div>
            {clipped && (
              <Btn kind="quiet" className="work-more-link" onClick={() => onOpen(false)}>
                More
              </Btn>
            )}
          </>
        )}

        {w.kind === 'approval' && (
          <div className="work-card-actions">
            <Btn kind={raised ? 'next' : 'plain'} kbd={selected ? '⌘⏎' : undefined} disabled={busy} onClick={() => act(() => decide(ctx, item, 'approve'))}>
              Allow
            </Btn>
            <Btn kind="plain" disabled={busy} onClick={() => act(() => decide(ctx, item, 'deny'))}>
              Deny
            </Btn>
            <Btn kind="quiet" onClick={() => onOpen(true)}>
              Reply
            </Btn>
          </div>
        )}
        {w.kind !== 'approval' && text && (
          <div className="work-card-actions">
            <div className="work-chips">
              {quickReplies('list').map((q) => (
                <Chip key={q} label={q} disabled={busy} onClick={() => act(() => sendText(ctx, item, q))} />
              ))}
            </div>
            <Btn kind="quiet" onClick={() => onOpen(true)}>
              Write a reply…
            </Btn>
          </div>
        )}
      </Card>
    </div>
  );
};

/** A swiped card, collapsed for its Undo window (§4.3). */
export const SwipedRow: React.FC<{ label: string; name: string; onUndo: () => void }> = ({ label, name, onUndo }) => (
  <div className="work-swiped" role="status">
    <span>
      {label} · <span className="work-swiped-name">{name}</span>
    </span>
    <Btn kind="quiet" onClick={onUndo}>
      Undo
    </Btn>
  </div>
);

export default WaitingCard;
