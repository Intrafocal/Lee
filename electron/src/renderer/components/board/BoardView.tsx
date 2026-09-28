/**
 * BoardView - a zoomed Board with its Asks and hand-offs (Boards B3,
 * docs/16-Desk.md §3.1): BoardSurface, plus what DeepHost gives a Page.
 *
 * - The action row: with something selected, the Page's row (Ask about
 *   this… · Hand off) sits under the selection; ⌘. puts the keyboard in it,
 *   then the underlined letter. Esc goes back to the Board.
 * - Ask: the selection is drawn to a PNG (boardRender), uploaded as a
 *   selection asset (`sel-…`), and asked with a board anchor; a sticky note
 *   goes beside it (boardAskModel). Hester answers from the picture.
 * - Hand off: the same picture, then the Page's HandoffSheet (kind,
 *   provider, brief with the notes and the picture's path); a clipboard
 *   goes beside the selection once the record exists.
 * - Visualize (B6): a one-line brief, the same picture, POST /visualize;
 *   a frame goes beside the selection (VisualCard). When its row is done
 *   the result goes beside the frame once (boardVisualModel): Hester's
 *   image as an image item, a Mermaid diagram drawn to PNG here
 *   (mermaidPng) and uploaded with the answer as its source, markdown as a
 *   note; then the frame's `result_item_id` is set.
 * - The rows are kept fresh like the Page's: deep:answer events, and a poll
 *   while anything is pending (hesterBoardAsks.watchBoardAnswers).
 * - Send to Lee (B5): a device's images land as image items in the middle
 *   of the view and its text as a note, one undo step (tetherDelivery's
 *   Board sink).
 * - End session (B5): the ritual filled from the Board (lib/boardRitual),
 *   with the other touched cards' Asks and hand-offs; a still-open line is
 *   asked about with its note drawn, as a selection would be.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { BoardAnchor, BoardAsk, BoardHandoff, BoardItem, BoardTarget, BoardVisual } from '../../../shared/board';
import type { Anchor, DeepAnswer, LeeMode } from '../../../shared/cockpit';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import { cockpitModeStore, touchedCards, zoomIntoCard } from '../cockpit/cockpitMode';
import { logDeep, onDeepAnswer } from '../deep/deepBridge';
import { EndSessionSheet } from '../deep/EndSessionSheet';
import { HandoffSheet } from '../deep/HandoffSheet';
import { replyToHandoff } from '../deep/handoffReply';
import { useDeskContext } from '../desk/useDesk';
import { anchorFor, deepRowKey, isPending } from '../../lib/deepModel';
import { canAdd, itemsInRect } from '../../lib/boardModel';
import { boardRitual, boardStoppedAt, type BoardStillOpen } from '../../lib/boardRitual';
import { askDeep, gatherOthers, handoffInFlight, isHandoff, NO_OTHERS, type OtherCards, type StillOpen } from '../../lib/hesterDeep';
import { registerBoardSink } from '../../lib/tetherDelivery';
import { boardSendItems } from '../../lib/tetherModel';
import {
  boardAnchor,
  boardHandoffSection,
  clipboardText,
  followUpsOf,
  isAnswerCard,
  newAskItem,
  newItemId,
  newHandoffItem,
  selectionNotes,
  selectionTarget,
  snapshotFile,
  stickyText,
  toggleCard,
} from '../../lib/boardAskModel';
import { askBoard, patchBoardAnswer, retryBoardAnswer, upsertAnswer, visualize, watchBoardAnswers } from '../../lib/hesterBoardAsks';
import { listBoardAssets } from '../../lib/hesterBoard';
import { boardAssetBitmap } from '../../lib/boardAssets';
import { MERMAID_SCALE, assetsFromAnswer, findPlacedResult, frameLabel, needsResult, newVisualItem, resultImage, resultNote, toggleVisual, whatToPlace } from '../../lib/boardVisualModel';
import { renderMermaidPng } from '../../lib/mermaidPng';
import { AskCard, CardLeader } from './AskCard';
import { HandoffCard } from './HandoffCard';
import { VisualCard } from './VisualCard';
import { BoardSurface, type BoardApi, type BoardSelection } from './BoardSurface';

export interface BoardViewProps {
  workspace: string;
  boardId: string;
  title: string;
  visible: boolean;
  copilot: UseCopilotResult;
  onHop: (to: LeeMode) => void;
  /** Bumped by the mode chip's "End session": opens the ritual on this Board. */
  endNonce?: number;
}

/** A selection drawn and uploaded: what an Ask or hand-off carries. */
type Snapshot = { target: BoardTarget; anchor: BoardAnchor };

type RowAction = 'ask' | 'handoff' | 'visualize';
const ROW: ReadonlyArray<{ action: RowAction; label: string; mnemonic: string; title: string }> = [
  { action: 'ask', label: 'Ask about this…', mnemonic: 'a', title: 'Ask Hester about this part of the Board; the answer comes back on a sticky note' },
  { action: 'handoff', label: 'Hand off', mnemonic: 'h', title: 'Hand this to an agent: Spike, Docs or Research' },
  { action: 'visualize', label: 'Visualize', mnemonic: 'v', title: 'Have Hester make a diagram, picture or table of this; it lands beside the selection' },
];

/** The one-line field under the row: an Ask's question or a Visualize's brief. */
type FieldMode = 'ask' | 'visualize';

/** Underline the mnemonic letter (shown only while the row has keyboard focus, as on a Page). */
function mnemonicLabel(label: string, letter: string): React.ReactNode {
  const i = label.toLowerCase().indexOf(letter);
  if (i < 0) return label;
  return (
    <span className="deep-row-label">
      {label.slice(0, i)}
      <span className="deep-row-mn">{label[i]}</span>
      {label.slice(i + 1)}
    </span>
  );
}

export function BoardView({ workspace, boardId, title, visible, copilot, onHop, endNonce = 0 }: BoardViewProps): JSX.Element {
  const board = useRef<BoardApi | null>(null);
  const say = (t: string) => board.current?.say(t);

  // ---- the Board's answers.jsonl rows ----
  const [rows, setRows] = useState<DeepAnswer[]>([]);
  const rowsRef = useRef<DeepAnswer[]>([]);
  rowsRef.current = rows;
  const watch = useRef<{ refresh: () => Promise<void> } | null>(null);
  useEffect(() => {
    const w = watchBoardAnswers(workspace, boardId, setRows, { subscribe: onDeepAnswer });
    watch.current = w;
    return () => {
      w.stop();
      watch.current = null;
    };
  }, [workspace, boardId]);
  const upsert = (row: DeepAnswer) => setRows((prev) => upsertAnswer(prev, row));
  const refreshSoon = () => void watch.current?.refresh();

  // ---- the action row ----
  // The field belongs to the selection it was opened on (`key`); another selection hides it.
  const [askingFor, setAskingFor] = useState<{ key: string; mode: FieldMode; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const selKey = () => board.current?.selection().item_ids.join(',') ?? '';

  /** The selection (or `only`, e.g. one note) drawn to a PNG and uploaded as `sel-…`: the anchor an Ask or hand-off carries. */
  const snapshot = async (only?: readonly string[]): Promise<Snapshot | null> => {
    const api = board.current;
    if (!api) return null;
    const items = api.items();
    const sel = only ? { item_ids: [...only] } : api.selection();
    const target = selectionTarget(items, sel.item_ids);
    if (!target) {
      say('Select something on the Board first');
      return null;
    }
    // Everything the rect touches, but not the stickies, clipboards and frames on it.
    const ids = itemsInRect(items, target.rect).filter((id) => {
      const it = items.find((x) => x.id === id);
      return it && !isAnswerCard(it);
    });
    const png = await api.flatten(target.rect, ids);
    if (!png) {
      say('Couldn’t draw the selection');
      return null;
    }
    const up = await api.uploadAsset(png, 'image/png', null, true);
    if ('error' in up) {
      say(up.error);
      return null;
    }
    return { target, anchor: boardAnchor(target, up.name, selectionNotes(items, sel.item_ids)) };
  };

  const ask = async (question: string, only?: readonly string[]) => {
    const q = question.trim() || 'Explain this.';
    setBusy(true);
    const snap = await snapshot(only);
    if (!snap) return setBusy(false);
    const r = await askBoard(workspace, boardId, { question: q, anchor: snap.anchor });
    setBusy(false);
    if (!r.ok) return say(r.error);
    const api = board.current;
    if (api) api.addItems([newAskItem(r.data.id, snap.target, api.items())]);
    upsert(r.data);
    setAskingFor(null);
    refreshSoon();
  };

  // ---- Visualize: the brief, the picture, a frame beside it ----
  const visualizeIt = async (brief: string) => {
    const b = brief.trim();
    if (!b) return;
    setBusy(true);
    const snap = await snapshot();
    if (!snap) return setBusy(false);
    const r = await visualize(workspace, boardId, { brief: b, anchor: snap.anchor });
    setBusy(false);
    if (!r.ok) return say(r.status === 404 || r.status === 405 ? 'Hester is older than this Lee. Reinstall it to Visualize.' : r.error);
    const api = board.current;
    if (api) api.addItems([newVisualItem(r.data.id, snap.target, api.items())]);
    upsert(r.data);
    setAskingFor(null);
    refreshSoon();
  };

  // ---- hand-offs: the Page's sheet, with the picture ----
  // `eid`: the card it's on (this Board, or a Page from the ritual); `target`: where this Board's clipboard goes.
  const [handoff, setHandoff] = useState<{ eid: string; title: string; sectionText: string; anchor: Anchor; target: BoardTarget | null } | null>(null);
  const handOff = async (only?: readonly string[]) => {
    setBusy(true);
    const snap = await snapshot(only);
    setBusy(false);
    if (!snap) return;
    setAskingFor(null);
    const file = snapshotFile(workspace, boardId, snap.anchor.snapshot);
    setHandoff({ eid: boardId, title, sectionText: boardHandoffSection(snap.anchor, file), anchor: snap.anchor, target: snap.target });
  };

  const run = (a: RowAction) => {
    if (busy) return;
    if (a === 'ask' || a === 'visualize') {
      setAskingFor({ key: selKey(), mode: a, text: '' });
      requestAnimationFrame(() => askRef.current?.focus());
    } else void handOff();
  };

  const backToBoard = () => (document.querySelector('.board') as HTMLElement | null)?.focus({ preventScroll: true });
  const onRowKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = deepRowKey(e.key, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey });
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.kind === 'escape') backToBoard();
    else if (k.kind === 'action') {
      if (k.action === 'ask' || k.action === 'handoff' || k.action === 'visualize') run(k.action);
    } else if (k.kind === 'move') {
      const btns = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + k.delta + btns.length) % btns.length]?.focus();
    }
  };

  const selectionSlot = (sel: BoardSelection) => {
    const field = askingFor && askingFor.key === sel.item_ids.join(',') ? askingFor : null;
    if (!sel.items.some((it) => !isAnswerCard(it))) return null;
    return (
      <>
        <div className="deep-row" ref={rowRef} role="toolbar" aria-label="Actions (⌘.)" onKeyDown={onRowKey}>
          {ROW.map((b) => (
            <button
              key={b.action}
              type="button"
              className="deep-row-btn"
              title={b.title}
              aria-keyshortcuts={b.mnemonic}
              tabIndex={-1}
              disabled={busy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(b.action)}
            >
              {mnemonicLabel(b.label, b.mnemonic)}
            </button>
          ))}
          <kbd className="deep-row-hint" title="⌘. puts the keyboard in this row; then press an underlined letter. Esc goes back to the Board">
            ⌘.
          </kbd>
        </div>
        {field && (
          <input
            ref={askRef}
            className="deep-ask-input"
            value={field.text}
            disabled={busy}
            placeholder={field.mode === 'visualize' ? 'What should it show?' : 'Ask about this… (Enter asks “Explain this.”)'}
            aria-label={field.mode === 'visualize' ? 'What should it show?' : 'Ask about this'}
            onChange={(e) => setAskingFor({ key: sel.item_ids.join(','), mode: field.mode, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (field.mode === 'visualize') void visualizeIt(field.text);
                else void ask(field.text);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setAskingFor(null);
                backToBoard();
              }
            }}
          />
        )}
      </>
    );
  };

  /** ⌘. with something selected: the keyboard goes into the row. */
  const onSelectionAction = () => {
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
  };

  // ---- the sticky and the clipboard ----
  const openInWork = (taskId: string) => {
    onHop('cockpit');
    cockpitModeStore.setSection('work');
    cockpitModeStore.select({ kind: 'row', id: `task:${taskId}` });
  };

  const toggle = (item: BoardAsk | BoardHandoff | BoardVisual, open: boolean, api: BoardApi) => {
    api.updateItem(item.id, item.kind === 'visual' ? toggleVisual(item, api.items(), open) : toggleCard(item, api.items(), open), false);
    const row = rowsRef.current.find((a) => a.id === item.answer_id);
    // Opening an answer or a result you haven't read marks it read.
    if (open && row && !row.read_at && (row.status === 'done' || row.handoff?.state === 'review')) {
      void patchBoardAnswer(workspace, boardId, row.id, { read: true }).then((r) => r.ok && upsert(r.data));
    }
  };

  const followUp = async (item: BoardAsk, question: string): Promise<boolean> => {
    const parent = rowsRef.current.find((a) => a.id === item.answer_id);
    if (!parent || parent.anchor?.kind !== 'board') return false;
    const r = await askBoard(workspace, boardId, { question, anchor: parent.anchor, follow_up_of: item.answer_id });
    if (!r.ok) {
      say(r.error);
      return false;
    }
    upsert(r.data);
    refreshSoon();
    return true;
  };

  const retry = async (aid: string) => {
    const r = await retryBoardAnswer(workspace, boardId, aid);
    if (!r.ok) return say(r.error);
    upsert(r.data);
    refreshSoon();
  };

  const reply = async (item: BoardHandoff, text: string): Promise<boolean> => {
    const row = rowsRef.current.find((a) => a.id === item.answer_id);
    const r = await replyToHandoff(workspace, copilot, row?.handoff?.task_id ?? null, text);
    if (!r.ok) {
      if (r.error) say(r.error);
      return false;
    }
    say('Replied');
    return true;
  };

  // ---- a Visualize's result, placed once beside its frame ----
  const placing = useRef(new Set<string>());
  const [placeErrors, setPlaceErrors] = useState<Record<string, string>>({});
  const placeResult = async (frameId: string) => {
    const api = board.current;
    const first = api?.items().find((it) => it.id === frameId);
    if (!api || !first || first.kind !== 'visual') return;
    const row = rowsRef.current.find((a) => a.id === first.answer_id);
    const v = row?.visual;
    if (!row || !v || !needsResult(first, row) || placing.current.has(row.id)) return;
    const plan = whatToPlace(v);
    if (!plan) return;
    placing.current.add(row.id);
    const failed = (msg: string) => setPlaceErrors((p) => ({ ...p, [row.id]: msg }));
    try {
      // Placed already (another window, or before a reload)? Then only point at it.
      const saved = plan.kind === 'note' ? [] : await listBoardAssets(workspace, boardId).then((r) => (r.ok && Array.isArray(r.data) ? assetsFromAnswer(r.data, row.id) : []));
      const there = findPlacedResult(first, api.items(), v, saved);
      if (there) return api.updateItem(frameId, { result_item_id: there }, false);

      let add: BoardItem;
      if (plan.kind === 'note') {
        add = resultNote(first, api.items(), plan.text);
      } else {
        // Hester's image, or a diagram drawn here (or by another window: its PNG is already saved).
        let asset = plan.kind === 'image' ? plan.asset : saved[0] ?? null;
        let natural: { w: number; h: number } | null = null;
        let dpr = 1;
        if (!asset && plan.kind === 'mermaid') {
          const png = await renderMermaidPng(plan.dsl);
          if ('error' in png) return failed(png.error);
          const up = await api.uploadAsset(png.blob, 'image/png', { kind: 'answer', card_id: boardId, answer_id: row.id, taken_at: new Date().toISOString() });
          if ('error' in up) return failed(up.error);
          asset = up.name;
          natural = { w: png.w, h: png.h };
          dpr = png.scale;
        }
        if (!asset) return;
        if (!natural) {
          const bmp = await boardAssetBitmap(workspace, boardId, asset);
          if (!bmp) return failed('Couldn’t load what it made');
          natural = { w: bmp.width, h: bmp.height };
          // A diagram another window drew is at 2x, like ours.
          dpr = plan.kind === 'mermaid' ? MERMAID_SCALE : 1;
        }
        add = resultImage(first, api.items(), asset, natural, dpr);
      }
      // The Board may have moved on while this drew or uploaded.
      const now = api.items().find((it) => it.id === frameId);
      if (!now || now.kind !== 'visual' || now.result_item_id) return;
      const id = newItemId();
      // Point the frame first (not undoable), so undoing the result doesn't place it again.
      api.updateItem(frameId, { result_item_id: id }, false);
      api.addItems([{ ...add, id }]);
      setPlaceErrors((p) => {
        if (!(row.id in p)) return p;
        const rest = { ...p };
        delete rest[row.id];
        return rest;
      });
    } finally {
      placing.current.delete(row.id);
    }
  };

  const renderAnswerItem = (item: BoardAsk | BoardHandoff | BoardVisual, api: BoardApi, selected: boolean) => {
    const row = rows.find((a) => a.id === item.answer_id) ?? null;
    if (item.kind === 'visual') {
      return (
        <>
          <CardLeader item={item} />
          <VisualCard
            item={item}
            answer={row}
            selected={selected}
            onToggle={(open) => toggle(item, open, api)}
            onRetry={(aid) => void retry(aid)}
            onPlace={() => void placeResult(item.id)}
            placeError={row ? placeErrors[row.id] ?? null : null}
          />
        </>
      );
    }
    return (
      <>
        <CardLeader item={item} />
        {item.kind === 'ask' ? (
          <AskCard
            item={item}
            answer={row}
            followUps={followUpsOf(item.answer_id, rows)}
            selected={selected}
            onToggle={(open) => toggle(item, open, api)}
            onFollowUp={(q) => followUp(item, q)}
            onRetry={(aid) => void retry(aid)}
          />
        ) : (
          <HandoffCard
            item={item}
            answer={row}
            selected={selected}
            onToggle={(open) => toggle(item, open, api)}
            onOpenInWork={openInWork}
            onReply={(t) => reply(item, t)}
          />
        )}
      </>
    );
  };

  // ---- Send to Lee (B5): a device's images and text, in the middle of the view ----
  useEffect(
    () =>
      registerBoardSink({
        cardId: boardId,
        place: (images, text) => {
          const api = board.current;
          if (!api || !api.ready()) return null;
          const add = boardSendItems(api.items(), images, text, api.viewCentre(), window.devicePixelRatio || 1);
          if (!add.length || !canAdd(api.items(), add.length)) return null;
          api.addItems(add, true);
          return add;
        },
        remove: (ids) => {
          const api = board.current;
          const here = api ? ids.filter((id) => api.items().some((it) => it.id === id)) : [];
          if (!api || !here.length) return false;
          api.removeItems(here);
          return true;
        },
      }),
    [boardId],
  );

  // ---- the ending ritual (B5): from the Board, plus the other touched cards ----
  const desk = useDeskContext();
  const startedAt = (copilot.focus ?? copilot.snapshot?.focus)?.started_at ?? null;
  const [sheet, setSheet] = useState<{ prefill: string } | null>(null);
  const [others, setOthers] = useState<OtherCards>(NO_OTHERS);
  const endSeen = useRef(endNonce);
  useEffect(() => {
    if (endNonce === endSeen.current) return;
    endSeen.current = endNonce;
    setAskingFor(null);
    setOthers(NO_OTHERS);
    setSheet({ prefill: boardStoppedAt(board.current?.items() ?? []) });
    const rest = touchedCards().filter((c) => c !== boardId);
    if (rest.length) {
      void gatherOthers(workspace, rest, startedAt, (cid) => desk?.titleOf(cid) ?? '').then((o) => setOthers(o));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endNonce]);

  const here = sheet ? boardRitual(board.current?.items() ?? [], rows, startedAt) : null;
  const session = here
    ? { asked: [...here.asked, ...others.asked], handedOff: [...here.handedOff, ...others.handedOff], stillOpen: [...here.stillOpen, ...others.stillOpen] }
    : undefined;
  const titleOf = (cid: string) => (cid === boardId ? title : desk?.titleOf(cid) ?? '');
  const ritualDesk = sheet
    ? (() => {
        const ids = touchedCards();
        const list = ids.includes(boardId) ? ids : [...ids, boardId];
        return {
          touched: list.map((cid) => ({ id: cid, title: titleOf(cid) })),
          stoppedCardId: boardId,
          onZoom: (cid: string) => {
            if (cid === boardId) backToBoard();
            else void zoomIntoCard({ card_id: cid, title: titleOf(cid) }, 'click');
          },
        };
      })()
    : undefined;
  const stillOpenQuestion = (o: StillOpen) => (o.kind === 'question' ? o.text : 'What is still open here, and what would settle it?');
  /** A still-open line here is asked with its note drawn; one on another touched Page is asked there. */
  const askStillOpen = (o: StillOpen & { card_id?: string; note_id?: string }) => {
    const note = (o as BoardStillOpen).note_id;
    if (!o.card_id || o.card_id === boardId) {
      if (note) void ask(stillOpenQuestion(o), [note]);
      return;
    }
    const t = others.texts[o.card_id] ?? '';
    void askDeep(workspace, o.card_id, { question: stillOpenQuestion(o), anchor: anchorFor(t, o.from, o.to), section_text: o.sectionText }).then((r) => {
      if (!r.ok) say(r.error);
    });
    logDeep({ type: 'deep.action', data: { action: 'ask', card_id: o.card_id, card_kind: 'page', chars: stillOpenQuestion(o).length } });
  };
  const handOffStillOpen = (o: StillOpen & { card_id?: string }) => {
    const note = (o as BoardStillOpen).note_id;
    if (!o.card_id || o.card_id === boardId) {
      if (note) void handOff([note]);
      return;
    }
    const t = others.texts[o.card_id] ?? '';
    setHandoff({ eid: o.card_id, title: titleOf(o.card_id) || 'Untitled', sectionText: o.sectionText, anchor: anchorFor(t, o.from, o.to), target: null });
  };

  /** What a sticky, clipboard or frame says in preview.png. */
  const answerLabel = (item: BoardItem) => {
    if (item.kind !== 'ask' && item.kind !== 'handoff' && item.kind !== 'visual') return '';
    const row = rowsRef.current.find((a) => a.id === item.answer_id) ?? null;
    if (item.kind === 'visual') return frameLabel(row);
    return item.kind === 'ask' ? stickyText(row).question || 'Ask' : clipboardText(row).label;
  };

  return (
    <>
      <BoardSurface
        ref={board}
        workspace={workspace}
        boardId={boardId}
        title={title}
        visible={visible}
        onSelectionAction={onSelectionAction}
        selectionSlot={selectionSlot}
        renderAnswerItem={renderAnswerItem}
        answerLabel={answerLabel}
      />
      {sheet && (
        <EndSessionSheet
          workspace={workspace}
          explorationId={boardId}
          prefill={sheet.prefill}
          questions={[]}
          focus={copilot.focus ?? copilot.snapshot?.focus ?? null}
          running={rows.filter((a) => !isHandoff(a) && a.kind !== 'visualize' && !a.dismissed_at && isPending(a)).length}
          runningHandoffs={rows.filter(handoffInFlight).length}
          session={session}
          onAsk={askStillOpen}
          onHandOff={handOffStillOpen}
          onBoard
          desk={ritualDesk}
          suspended={!!handoff}
          onClose={() => setSheet(null)}
        />
      )}
      {handoff && (
        <HandoffSheet
          workspace={workspace}
          explorationId={handoff.eid}
          explorationTitle={handoff.title}
          sectionText={handoff.sectionText}
          anchor={handoff.anchor}
          onRecord={(a) => {
            if (handoff.eid !== boardId || !handoff.target) return;
            upsert(a);
            // The clipboard goes on the Board the first time its record arrives.
            const api = board.current;
            if (api && !api.items().some((it) => it.kind === 'handoff' && it.answer_id === a.id)) {
              api.addItems([newHandoffItem(a.id, handoff.target, api.items())]);
            }
          }}
          onLaunched={() => {
            setHandoff(null);
            say('Handed off · it shows in Work');
            refreshSoon();
          }}
          onClose={() => {
            setHandoff(null);
            if (!sheet) backToBoard();
          }}
        />
      )}
    </>
  );
}

export default BoardView;
