/**
 * Typed client for a Board's Asks, hand-offs and Visualizes (Boards B3, B6,
 * plan §3, §5b): the Page's routes over the Board's store,
 * `/desk/boards/{id}/answers`, `/asks`, `/handoffs`, `/visualize`,
 * `/answers/{aid}` and `/answers/{aid}/retry`, with a `board` anchor. Same `call` as lib/hesterDeep.ts (workspace as
 * `?workspace=` and `X-Lee-Workspace`, the bearer token, the copilot
 * envelope, the error body kept) and the same rows (DeepAnswer).
 *
 * The one model call (POST /asks) runs only because the user asked (C2). A
 * Board Ask needs a model that reads images; without one Hester answers the
 * Ask with an error row, which the sticky shows.
 *
 * watchBoardAnswers keeps a Board's rows fresh the way the Page does: a
 * deep:answer event for this card refreshes at once, and while anything is
 * pending (an Ask, a hand-off out with an agent) it polls as a fallback.
 */

import { hesterCall as call, handoffLaunchRequest, handoffInFlight, type DeepResult } from './hesterDeep';
import { isPending } from './deepModel';
import { boardAnchor, newAskItem, selectionNotes, selectionTarget, type Rect } from './boardAskModel';
import type { BoardAnchor, BoardAsk, BoardItem, VisualizeCreate } from '../../shared/board';
import type { DeepAnswer, DeepAnswerEvent, HandoffKind } from '../../shared/cockpit';

export type { DeepResult as BoardAskResult };

/** A Board's calls: `/desk/boards/{id}…`. */
export function boardRoute(id: string, rest = ''): string {
  return `/desk/boards/${encodeURIComponent(id)}${rest}`;
}

const aidRoute = (aid: string, rest = '') => `/answers/${encodeURIComponent(aid)}${rest}`;

export function listBoardAnswers(workspace: string, id: string): Promise<DeepResult<DeepAnswer[]>> {
  return call<DeepAnswer[]>(workspace, 'GET', boardRoute(id, '/answers'));
}

/** Queues an Ask about a selection (202). `follow_up_of`: a follow-up in the sticky, same anchor. */
export function askBoard(
  workspace: string,
  id: string,
  body: { question: string; anchor: BoardAnchor; follow_up_of?: string },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', boardRoute(id, '/asks'), body);
}

/** Creates the hand-off's row (201, state 'launching'); the renderer then launches its task (boardHandoffLaunchRequest). */
export function createBoardHandoff(
  workspace: string,
  id: string,
  body: { kind: HandoffKind; provider: string; brief: string; anchor: BoardAnchor },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', boardRoute(id, '/handoffs'), body);
}

/**
 * Queues a Visualize (202): Hester's diagram agent makes a diagram, image
 * or table from the selection and the brief. The row is `kind: 'visualize'`
 * with `visual: null` until it's done (a model call the user asked for, C2).
 */
export function visualize(workspace: string, id: string, body: VisualizeCreate): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', boardRoute(id, '/visualize'), body);
}

export function patchBoardAnswer(
  workspace: string,
  id: string,
  aid: string,
  body: { read?: true; dismissed?: true; kept?: true; task_id?: string; status?: 'error'; error?: string },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'PATCH', boardRoute(id, aidRoute(aid)), body);
}

/** Re-queues an errored or interrupted Ask or Visualize (a user's Retry click). */
export function retryBoardAnswer(workspace: string, id: string, aid: string): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', boardRoute(id, aidRoute(aid, '/retry')), {});
}

/**
 * Ask about a selection, the whole flow after the snapshot is uploaded
 * (`snapshot`: its asset name): the target and notes from the items, the
 * anchor, POST /asks, and the sticky to add beside the selection. The
 * caller adds `item` to the Board (and saves) and `answer` to its rows.
 */
export async function askAboutSelection(
  workspace: string,
  boardId: string,
  input: { question: string; items: readonly BoardItem[]; ids: readonly string[]; marquee?: Rect | null; snapshot: string },
): Promise<DeepResult<{ answer: DeepAnswer; item: BoardAsk; anchor: BoardAnchor }>> {
  const question = input.question.trim();
  if (!question) return { ok: false, error: 'Nothing to ask' };
  const target = selectionTarget(input.items, input.ids, input.marquee);
  if (!target) return { ok: false, error: 'Select something on the Board first' };
  const anchor = boardAnchor(target, input.snapshot, selectionNotes(input.items, input.ids));
  const r = await askBoard(workspace, boardId, { question, anchor });
  if (!r.ok) return r;
  return { ok: true, data: { answer: r.data, item: newAskItem(r.data.id, target, input.items), anchor } };
}

/** The hand-off's launch, as the Page's (hesterDeep.handoffLaunchRequest), from a Board: origin `board`. */
export function boardHandoffLaunchRequest(input: {
  workspace: string;
  kind: HandoffKind;
  provider: string;
  brief: string;
  boardId: string;
  answerId: string;
  title: string;
}) {
  return handoffLaunchRequest({ ...input, explorationId: input.boardId });
}

// ---------------------------------------------------------------------------
// Keeping the rows fresh
// ---------------------------------------------------------------------------

/** As the Page's (DeepHost ANSWER_POLL_MS): a fallback for a missed deep:answer. */
export const BOARD_ANSWER_POLL_MS = 20000;

/** Anything still to come: an Ask being answered, a Visualize being made, or a hand-off out with an agent. */
export function answersPending(answers: readonly DeepAnswer[]): boolean {
  return answers.some((a) => !a.dismissed_at && (isPending(a) || handoffInFlight(a)));
}

/** Replace or add one row (a POST's or PATCH's reply) by id. */
export function upsertAnswer(answers: readonly DeepAnswer[], row: DeepAnswer): DeepAnswer[] {
  const i = answers.findIndex((a) => a.id === row.id);
  if (i < 0) return [...answers, row];
  const next = answers.slice();
  next[i] = row;
  return next;
}

export interface WatchOptions {
  /** deep:answer events (deepBridge.onDeepAnswer); without it, polling only. */
  subscribe?: (cb: (e: DeepAnswerEvent) => void) => () => void;
  pollMs?: number;
  /** For tests. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}

/**
 * Load a Board's rows now, again on each deep:answer for it, and every
 * `pollMs` while any is pending. Returns stop. `onAnswers` gets the whole
 * list each time; a failed load keeps the last one (nothing is called).
 */
export function watchBoardAnswers(
  workspace: string,
  boardId: string,
  onAnswers: (answers: DeepAnswer[]) => void,
  opts: WatchOptions = {},
): { stop: () => void; refresh: () => Promise<void> } {
  const every = opts.pollMs ?? BOARD_ANSWER_POLL_MS;
  const setI = opts.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clearI = opts.clearInterval ?? ((t: unknown) => globalThis.clearInterval(t as ReturnType<typeof globalThis.setInterval>));
  let stopped = false;
  let timer: unknown = null;
  let seq = 0;

  const poll = (on: boolean) => {
    if (on && timer == null && !stopped) timer = setI(() => void refresh(), every);
    else if (!on && timer != null) {
      clearI(timer);
      timer = null;
    }
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    const n = ++seq;
    const r = await listBoardAnswers(workspace, boardId);
    if (stopped || n !== seq || !r.ok) return;
    const rows = Array.isArray(r.data) ? r.data : [];
    onAnswers(rows);
    poll(answersPending(rows));
  };

  const unsubscribe =
    opts.subscribe?.((e) => {
      if ((e.card_id ?? e.exploration_id) === boardId && (!e.workspace || e.workspace === workspace)) void refresh();
    }) ?? (() => undefined);

  void refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      poll(false);
      unsubscribe();
    },
  };
}
