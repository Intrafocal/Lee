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
 * - The rows are kept fresh like the Page's: deep:answer events, and a poll
 *   while anything is pending (hesterBoardAsks.watchBoardAnswers).
 */

import React, { useEffect, useRef, useState } from 'react';
import type { BoardAnchor, BoardAsk, BoardHandoff, BoardItem, BoardTarget } from '../../../shared/board';
import type { DeepAnswer, LeeMode } from '../../../shared/cockpit';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import { cockpitModeStore } from '../cockpit/cockpitMode';
import { onDeepAnswer } from '../deep/deepBridge';
import { HandoffSheet } from '../deep/HandoffSheet';
import { replyToHandoff } from '../deep/handoffReply';
import { deepRowKey } from '../../lib/deepModel';
import { itemsInRect } from '../../lib/boardModel';
import {
  boardAnchor,
  boardHandoffSection,
  clipboardText,
  followUpsOf,
  newAskItem,
  newHandoffItem,
  selectionNotes,
  selectionTarget,
  snapshotFile,
  stickyText,
  toggleCard,
} from '../../lib/boardAskModel';
import { askBoard, patchBoardAnswer, retryBoardAnswer, upsertAnswer, watchBoardAnswers } from '../../lib/hesterBoardAsks';
import { AskCard, CardLeader } from './AskCard';
import { HandoffCard } from './HandoffCard';
import { BoardSurface, type BoardApi, type BoardSelection } from './BoardSurface';

export interface BoardViewProps {
  workspace: string;
  boardId: string;
  title: string;
  visible: boolean;
  copilot: UseCopilotResult;
  onHop: (to: LeeMode) => void;
}

/** A selection drawn and uploaded: what an Ask or hand-off carries. */
type Snapshot = { target: BoardTarget; anchor: BoardAnchor };

type RowAction = 'ask' | 'handoff';
const ROW: ReadonlyArray<{ action: RowAction; label: string; mnemonic: string; title: string }> = [
  { action: 'ask', label: 'Ask about this…', mnemonic: 'a', title: 'Ask Hester about this part of the Board; the answer comes back on a sticky note' },
  { action: 'handoff', label: 'Hand off', mnemonic: 'h', title: 'Hand this to an agent: Spike, Docs or Research' },
];

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

export function BoardView({ workspace, boardId, title, visible, copilot, onHop }: BoardViewProps): JSX.Element {
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
  // The Ask field belongs to the selection it was opened on (`key`); another selection hides it.
  const [askingFor, setAskingFor] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const selKey = () => board.current?.selection().item_ids.join(',') ?? '';

  /** The selection drawn to a PNG and uploaded as `sel-…`: the anchor an Ask or hand-off carries. */
  const snapshot = async (): Promise<Snapshot | null> => {
    const api = board.current;
    if (!api) return null;
    const items = api.items();
    const sel = api.selection();
    const target = selectionTarget(items, sel.item_ids);
    if (!target) {
      say('Select something on the Board first');
      return null;
    }
    // Everything the rect touches, but not the stickies and clipboards on it.
    const ids = itemsInRect(items, target.rect).filter((id) => {
      const it = items.find((x) => x.id === id);
      return it && it.kind !== 'ask' && it.kind !== 'handoff';
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

  const ask = async (question: string) => {
    const q = question.trim() || 'Explain this.';
    setBusy(true);
    const snap = await snapshot();
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

  // ---- hand-offs: the Page's sheet, with the picture ----
  const [handoff, setHandoff] = useState<{ sectionText: string; anchor: BoardAnchor; target: BoardTarget } | null>(null);
  const handOff = async () => {
    setBusy(true);
    const snap = await snapshot();
    setBusy(false);
    if (!snap) return;
    setAskingFor(null);
    const file = snapshotFile(workspace, boardId, snap.anchor.snapshot);
    setHandoff({ sectionText: boardHandoffSection(snap.anchor, file), anchor: snap.anchor, target: snap.target });
  };

  const run = (a: RowAction) => {
    if (busy) return;
    if (a === 'ask') {
      setAskingFor({ key: selKey(), text: '' });
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
      if (k.action === 'ask' || k.action === 'handoff') run(k.action);
    } else if (k.kind === 'move') {
      const btns = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + k.delta + btns.length) % btns.length]?.focus();
    }
  };

  const selectionSlot = (sel: BoardSelection) => {
    const asking = askingFor && askingFor.key === sel.item_ids.join(',') ? askingFor.text : null;
    if (!sel.items.some((it) => it.kind !== 'ask' && it.kind !== 'handoff')) return null;
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
        {asking != null && (
          <input
            ref={askRef}
            className="deep-ask-input"
            value={asking}
            disabled={busy}
            placeholder="Ask about this… (Enter asks “Explain this.”)"
            onChange={(e) => setAskingFor({ key: sel.item_ids.join(','), text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void ask(asking);
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

  const toggle = (item: BoardAsk | BoardHandoff, open: boolean, api: BoardApi) => {
    api.updateItem(item.id, toggleCard(item, api.items(), open), false);
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

  const renderAnswerItem = (item: BoardAsk | BoardHandoff, api: BoardApi, selected: boolean) => {
    const row = rows.find((a) => a.id === item.answer_id) ?? null;
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

  /** What a sticky or clipboard says in preview.png. */
  const answerLabel = (item: BoardItem) => {
    if (item.kind !== 'ask' && item.kind !== 'handoff') return '';
    const row = rowsRef.current.find((a) => a.id === item.answer_id) ?? null;
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
      {handoff && (
        <HandoffSheet
          workspace={workspace}
          explorationId={boardId}
          explorationTitle={title}
          sectionText={handoff.sectionText}
          anchor={handoff.anchor}
          onRecord={(a) => {
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
            backToBoard();
          }}
        />
      )}
    </>
  );
}

export default BoardView;
