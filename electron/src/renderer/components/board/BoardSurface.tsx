/**
 * BoardSurface - a zoomed Board (docs/16-Desk.md §3.1; plan
 * docs/plans/2026-09-28-boards.md §4): images, annotations, highlights and
 * lines on Lee's own canvas, the Desk's camera and look.
 *
 * - The world is one CSS-transformed layer like the Desk's (lib/canvas/);
 *   hit testing, moving, resizing, pins and saving are pure in
 *   lib/boardModel.ts. Wheel or two fingers pan, pinch or ⌘ + wheel zooms
 *   about the pointer, Space-drag (or the middle button) pans.
 * - Tools, in a taskbar like the Desk's: Select (V: click selects, drag
 *   moves, a corner resizes, a drag on bare Board selects several; Shift
 *   adds), Annotate (A: a click drops a text box; on an image or highlight
 *   it's pinned there, with a leader), Highlight (H: drag a region on an
 *   image), Draw (D). ⌘V and drop add images at the pointer (uploaded to
 *   the Board's assets with their source); pasted text becomes a note.
 *   Delete deletes, ⌘Z / ⇧⌘Z undo and redo, ⌘A selects all.
 * - Notes are markdown; a click on a selected note, a double-click or Enter
 *   edits it in place.
 * - Esc: a drag, then the note being written, the selection, back to
 *   Select, then out to the Desk.
 * - board.json is PUT debounced with its version; a 409 reloads Hester's
 *   copy and says so. After a save the Board is drawn to preview.png (the
 *   Desk card's picture) at most every few seconds, and when you leave.
 * - Ask and Hand off (B3) come from BoardView: `onSelectionAction` runs on
 *   ⌘. with something selected; `selectionSlot` draws the action row under
 *   the selection; `renderAnswerItem` draws the sticky, the clipboard and
 *   (B6) the Visualize frame;
 *   the ref is a BoardApi (add items, flatten a rect to PNG, upload).
 * - Links (B4): `[[` in a note picks a Page or Board (lib/cardLinks); a
 *   note's links show under its text and open the card. Pasting a lone
 *   `[[pg-…|Title]]` adds a link box.
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CARD_LINK_RE, type AssetSource, type BoardAsk, type BoardHandoff, type BoardImage, type BoardItem, type BoardNote, type BoardVisual } from '../../../shared/board';
import { cockpitModeStore, zoomIntoCard, zoomOut } from '../cockpit/cockpitMode';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { IconAction } from '../cockpit/ui';
import { useDeskContext } from '../desk/useDesk';
import { cardLinkDisplay, cardLinkSub, cardLinkTitle, findCard, formatCardLink, linkableCards, parseCardLinks, rankCards, MISSING_CARD_MESSAGE, type LinkableCard } from '../../lib/cardLinks';
import { Icon } from '../Icon';
import { PagePicker } from '../deep/page/PagePicker';
import { getBoardDoc, patchBoard, putBoardDoc, putBoardPreview, uploadBoardAsset } from '../../lib/hesterBoard';
import { addImageAsset, boardAssetBitmap, boardAssetUrl, imagesIn, primeBoardAsset, setLocalPreview } from '../../lib/boardAssets';
import { renderBoardPng, type BoardColors } from '../../lib/boardRender';
import {
  BOARD_MAX_SCALE,
  BOARD_MIN_SCALE,
  BOARD_TOOLS,
  CONFLICT_NOTICE,
  SAVE_START,
  STROKE_HIT_PX,
  aspectFor,
  boardBounds,
  boardCursor,
  boardEscapeStep,
  boardToolForKey,
  canAdd,
  handleAt,
  imageAt,
  isResizable,
  itemAt,
  itemsInRect,
  leaderLine,
  linkQueryAt,
  loneCardLink,
  makeHighlight,
  makeImage,
  makeLink,
  makeNote,
  makeStroke,
  moveItems,
  parseItems,
  pinFor,
  pinPoint,
  pinTargetAt,
  previewDelay,
  previewRect,
  removeItems,
  resizeItem,
  resizeRect,
  saveDelay,
  saveStep,
  selectionRect,
  sortByZ,
  toggleSelected,
  updateItem,
  HANDLES,
  type BoardSave,
  type BoardSaveEvent,
  type BoardTool,
  type Handle,
} from '../../lib/boardModel';
import { cameraTransform, dragDelta, fitRect, movedEnough, panBy, rectBetween, screenToWorld, wheelCamera, worldToScreen, type Camera, type Point, type Rect } from '../../lib/canvas/camera';
import { STROKE_STEP_PX, strokePath } from '../../lib/canvas/stroke';
import { dropLast, emptyHistory, record, redo, undo, type History } from '../../lib/canvas/history';
import { useViewportSize } from '../../lib/canvas/useViewportSize';
import './board.css';

/** What's selected: the items, their rect (Board px), and the items themselves. */
export interface BoardSelection {
  item_ids: string[];
  rect: Rect | null;
  items: BoardItem[];
}

/** The Board, for Ask and Hand off (B3) and Send to Lee. Every call reads the latest state. */
export interface BoardApi {
  workspace: string;
  boardId: string;
  items(): BoardItem[];
  selection(): BoardSelection;
  /** Add items as one undo step; `select` selects them. */
  addItems(items: BoardItem[], select?: boolean): void;
  /** Change one item; `undoable` (default true) makes it an undo step. */
  updateItem(id: string, patch: Partial<BoardItem>, undoable?: boolean): void;
  removeItems(ids: readonly string[]): void;
  /** `rect` drawn to a PNG with only `ids` (default: everything it touches), for a flattened selection. */
  flatten(rect: Rect, ids?: readonly string[]): Promise<Blob | null>;
  /** A PNG or JPEG into the Board's assets: its name, or one line saying why not. `selection`: a flattened selection (`sel-…`). */
  uploadAsset(blob: Blob, mime: 'image/png' | 'image/jpeg', source?: AssetSource | null, selection?: boolean): Promise<{ name: string } | { error: string }>;
  /** Images as image items at `at` (default: the middle of the view), each with `source`. */
  addImages(files: readonly Blob[], at?: Point, source?: AssetSource | null): Promise<void>;
  /** The middle of the view, Board px. */
  viewCentre(): Point;
  /** One line in the header. */
  say(text: string): void;
}

export interface BoardSurfaceProps {
  workspace: string;
  boardId: string;
  title: string;
  /** Deep shows and this Board is zoomed in. */
  visible: boolean;
  /** ⌘. with something selected (the integrator's Ask / Hand off row). */
  onSelectionAction?: (sel: BoardSelection, api: BoardApi) => void;
  /** Drawn just below the selection, in screen space. */
  selectionSlot?: (sel: BoardSelection, api: BoardApi) => React.ReactNode;
  /** An ask, handoff or visual item's card, placed by its own box in Board px; a placeholder when absent. */
  renderAnswerItem?: (item: BoardAsk | BoardHandoff | BoardVisual, api: BoardApi, selected: boolean) => React.ReactNode;
  /** The words an ask, handoff or visual shows in preview.png. */
  answerLabel?: (item: BoardItem) => string;
}

type Load = 'loading' | 'ok' | 'offline' | 'missing';

/** A press on the Board, by what it started. */
type Gesture =
  | { kind: 'pan'; id: number; x: number; y: number; cam: Camera }
  | { kind: 'press'; id: number; x: number; y: number; moved: boolean; ids: string[]; hit: string; wasOnly: boolean }
  | { kind: 'resize'; id: number; x: number; y: number; moved: boolean; item: BoardItem; handle: Handle }
  | { kind: 'marquee'; id: number; a: Point; b: Point; base: string[] }
  | { kind: 'highlight'; id: number; a: Point; b: Point; on: BoardImage | null }
  | { kind: 'draw'; id: number; points: Point[]; last: Point };

/** What a gesture shows before it's committed. */
type Live =
  | { kind: 'move'; ids: string[]; dx: number; dy: number }
  | { kind: 'resize'; id: string; rect: Rect }
  | { kind: 'marquee'; rect: Rect }
  | { kind: 'highlight'; rect: Rect }
  | { kind: 'ink'; points: Point[] }
  | null;

const LOAD_RETRY_MS = 3000;
/** A flattened selection (an Ask's or hand-off's picture), longest side. */
const SNAPSHOT_MAX_PX = 2048;
const FLASH_MS = 6000;
/** Offset between images added together, Board px. */
const CASCADE = 24;
const TOOL_HINT: Record<BoardTool, string> = {
  select: 'Click to select, drag to move. Drag on the Board to select several',
  annotate: 'Click to add a note. On an image or highlight it’s pinned there',
  highlight: 'Drag a region on an image',
  draw: 'Draw anywhere',
};

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

/** `[[pg-…|Title]]` shows its title until links open cards (B4). */
const linkTitles = (md: string) => md.replace(CARD_LINK_RE, (_m, id: string, title?: string) => `**${(title && title.trim()) || id}**`);

/** The theme's colours for a picture (a canvas can't read CSS variables). */
function themeColors(el: Element | null): Partial<BoardColors> {
  if (!el || typeof getComputedStyle === 'undefined') return {};
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const alpha = (hex: string, a: number) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : '';
  };
  const out: Partial<BoardColors> = {};
  const set = (k: keyof BoardColors, val: string) => {
    if (val) out[k] = val;
  };
  set('ground', v('--ground-1'));
  set('card', v('--ground-2'));
  set('border', v('--ground-4'));
  set('text', v('--text-1'));
  set('muted', v('--text-3'));
  set('ink', v('--text-2'));
  set('highlight', alpha(v('--text-1'), 0.12));
  set('highlightEdge', alpha(v('--text-1'), 0.45));
  return out;
}

/** A note's card links, under its text: each opens its card (a gone one says so). */
function NoteLinks({ text, cards, onOpen }: { text: string; cards: readonly LinkableCard[]; onOpen: (cardId: string) => void }): JSX.Element | null {
  const links = parseCardLinks(text).filter((l, i, all) => all.findIndex((x) => x.card_id === l.card_id) === i);
  if (!links.length) return null;
  return (
    <div className="board-note-links">
      {links.map((l) => {
        const card = findCard(l.card_id, cards);
        return (
          <button key={l.card_id} type="button" className={`board-note-link${card ? '' : ' is-missing'}`} title={cardLinkTitle(l, card)} onClick={() => onOpen(l.card_id)}>
            <Icon name={l.card_id.startsWith('bd-') ? 'image' : 'document'} size={12} />
            {cardLinkDisplay(l, card)}
          </button>
        );
      })}
    </div>
  );
}

export const BoardSurface = forwardRef<BoardApi, BoardSurfaceProps>(function BoardSurface(
  { workspace, boardId, title, visible, onSelectionAction, selectionSlot, renderAnswerItem, answerLabel },
  ref,
) {
  const deskCtx = useDeskContext();
  const titleOf = useCallback((id: string) => deskCtx?.titleOf(id) ?? '', [deskCtx]);
  /** The Pages and Boards a note can link to (not this Board). */
  const linkCards = useMemo(() => linkableCards(deskCtx?.desk, boardId), [deskCtx?.desk, boardId]);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // ---- a one-line status (not a toast) ----
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((t: string) => {
    if (!alive.current) return;
    setFlash(t);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  // ---- the document: items, undo, saving ----
  const [items, setItemsState] = useState<BoardItem[]>([]);
  const itemsRef = useRef<BoardItem[]>([]);
  const history = useRef<History<BoardItem[]>>(emptyHistory());
  const [save, setSaveState] = useState<BoardSave>(SAVE_START);
  const saveRef = useRef<BoardSave>(SAVE_START);
  const [load, setLoad] = useState<Load>('loading');
  const loadRef = useRef<Load>('loading');
  loadRef.current = load;

  const setItems = (next: BoardItem[]) => {
    itemsRef.current = next;
    if (alive.current) setItemsState(next);
  };
  const saveEvent = (e: BoardSaveEvent) => {
    saveRef.current = saveStep(saveRef.current, e);
    if (alive.current) setSaveState(saveRef.current);
  };
  /** A change: `undoable` keeps what was there to undo to. */
  const commit = (next: BoardItem[], undoable = true) => {
    if (undoable) history.current = record(history.current, itemsRef.current);
    setItems(next);
    saveEvent({ type: 'edit' });
  };

  const [selected, setSelectedState] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  const setSelected = (ids: string[]) => {
    selectedRef.current = ids;
    setSelectedState(ids);
  };

  // Load, and again while Hester isn't answering.
  const [loadNonce, setLoadNonce] = useState(0);
  const [fitTo, setFitTo] = useState<Rect | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getBoardDoc(workspace, boardId).then((r) => {
      if (cancelled || !alive.current) return;
      if (r.ok) {
        const got = parseItems(r.data.items);
        history.current = emptyHistory();
        setItems(got);
        saveEvent({ type: 'loaded', version: r.data.version });
        setFitTo(boardBounds(got));
        setLoad('ok');
      } else setLoad(r.status === 404 ? 'missing' : 'offline');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, boardId, loadNonce]);
  useEffect(() => {
    if (load !== 'offline' || !visible) return;
    const t = setTimeout(() => setLoadNonce((n) => n + 1), LOAD_RETRY_MS);
    return () => clearTimeout(t);
  }, [load, visible]);

  // ---- the preview: drawn after a save, at most every few seconds ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastPreview = useRef<number | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewStale = useRef(false);
  const bitmapsFor = async (list: readonly BoardItem[]): Promise<Map<string, ImageBitmap>> => {
    const names = [...new Set(list.filter((it): it is BoardImage => it.kind === 'image').map((it) => it.asset))];
    const got = await Promise.all(names.map((n) => boardAssetBitmap(workspace, boardId, n)));
    const out = new Map<string, ImageBitmap>();
    names.forEach((n, i) => {
      const b = got[i];
      if (b) out.set(n, b);
    });
    return out;
  };
  const renderOpts = () => ({ colors: themeColors(rootRef.current), titleOf, answerLabel });
  const drawPreview = async () => {
    previewStale.current = false;
    lastPreview.current = Date.now();
    const list = itemsRef.current;
    const rect = previewRect(list);
    if (!rect) return;
    const png = await renderBoardPng(list, rect, await bitmapsFor(list), renderOpts());
    if (!png) return;
    setLocalPreview(workspace, boardId, png);
    await putBoardPreview(workspace, boardId, png);
  };
  const schedulePreview = () => {
    previewStale.current = true;
    if (previewTimer.current) return;
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      void drawPreview();
    }, previewDelay(lastPreview.current, Date.now()));
  };

  // ---- saving: debounced PUT with the version; a 409 reloads ----
  const flush = async () => {
    const s = saveRef.current;
    if (!s.dirty || s.saving || loadRef.current !== 'ok') return;
    saveEvent({ type: 'start' });
    const r = await putBoardDoc(workspace, boardId, s.version, itemsRef.current);
    if (r.ok) {
      saveEvent({ type: 'saved', version: r.version });
      schedulePreview();
      return;
    }
    if (r.conflict !== undefined) {
      let doc = r.conflict;
      if (!doc) {
        const g = await getBoardDoc(workspace, boardId);
        doc = g.ok ? g.data : null;
      }
      if (doc) {
        saveEvent({ type: 'conflict', version: doc.version });
        history.current = emptyHistory();
        setItems(parseItems(doc.items));
        if (alive.current) {
          setSelected([]);
          setEditing(null);
        }
        say(CONFLICT_NOTICE);
        schedulePreview();
        return;
      }
    }
    saveEvent({ type: 'failed' });
    if (r.conflict === undefined && r.status && r.status !== 409) say(r.status === 404 ? 'This Board isn’t in Hester any more' : r.error);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const d = saveDelay(save);
    if (d == null) return;
    const t = setTimeout(() => void flushRef.current(), d);
    return () => clearTimeout(t);
  }, [save]);
  // Leaving the Board (zooming out, another mode, another card) saves now and draws the preview.
  useEffect(() => {
    if (visible) return;
    void flushRef.current();
    if (previewStale.current) {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = null;
      void drawPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  // Gone (another card in this window): the last save and a preview due now go out anyway.
  const drawRef = useRef(drawPreview);
  drawRef.current = drawPreview;
  useEffect(
    () => () => {
      void flushRef.current();
      if (previewTimer.current) {
        clearTimeout(previewTimer.current);
        previewTimer.current = null;
        void drawRef.current();
      }
    },
    [],
  );

  // ---- image URLs for <img> ----
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  useEffect(() => {
    for (const it of items) {
      if (it.kind !== 'image' || it.asset in urls) continue;
      const name = it.asset;
      setUrls((m) => (name in m ? m : { ...m, [name]: null }));
      void boardAssetUrl(workspace, boardId, name).then((u) => {
        if (alive.current && u) setUrls((m) => ({ ...m, [name]: u }));
      });
    }
  }, [items, urls, workspace, boardId]);

  // ---- the camera ----
  const viewRef = useRef<HTMLDivElement | null>(null);
  const size = useViewportSize(viewRef, [visible, load]);
  const fitted = useMemo<Camera>(
    () => (fitTo ? fitRect(size, fitTo, 64, 1, BOARD_MIN_SCALE) : { scale: 1, x: size.w / 2, y: size.h / 3 }),
    [fitTo, size],
  );
  const [own, setOwn] = useState<Camera | null>(null);
  const cam = own ?? fitted;
  const camRef = useRef(cam);
  camRef.current = cam;
  const fitAll = () => {
    setOwn(null);
    setFitTo(boardBounds(itemsRef.current));
  };

  const localPoint = (clientX: number, clientY: number): Point => {
    const r = viewRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };
  const worldAt = (clientX: number, clientY: number) => screenToWorld(camRef.current, localPoint(clientX, clientY));
  const onWheel = (e: React.WheelEvent) => setOwn(wheelCamera(cam, e, localPoint(e.clientX, e.clientY), BOARD_MIN_SCALE, BOARD_MAX_SCALE));
  const viewCentre = () => screenToWorld(camRef.current, { x: size.w / 2, y: size.h / 2 });

  // ---- tools and editing ----
  const [tool, setTool] = useState<BoardTool>('select');
  const [editing, setEditingState] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  /** The note was made for this edit: empty when you finish, it goes (and so does its undo step). */
  const editFresh = useRef(false);
  const editBefore = useRef('');
  const setEditing = (id: string | null) => {
    editingRef.current = id;
    setEditingState(id);
  };
  const beginEdit = (id: string, fresh = false) => {
    finishEdit();
    const note = itemsRef.current.find((it) => it.id === id);
    if (!note || note.kind !== 'note') return;
    editFresh.current = fresh;
    editBefore.current = note.text;
    // One undo step for the whole edit, kept from before it.
    if (!fresh) history.current = record(history.current, itemsRef.current);
    setSelected([id]);
    setEditing(id);
  };
  function finishEdit() {
    const id = editingRef.current;
    if (!id) return;
    setEditing(null);
    if (linkPickRef.current) setLinkPick(null);
    const note = itemsRef.current.find((it) => it.id === id) as BoardNote | undefined;
    if (!note) return;
    if (!note.text.trim()) {
      // An empty note isn't kept; a fresh one leaves no undo step behind.
      setItems(removeItems(itemsRef.current, [id]));
      saveEvent({ type: 'edit' });
      if (editFresh.current) history.current = dropLast(history.current);
      setSelected([]);
    } else if (!editFresh.current && note.text === editBefore.current) history.current = dropLast(history.current);
  }
  const typeNote = (id: string, text: string, el: HTMLTextAreaElement) => {
    const note = itemsRef.current.find((it) => it.id === id);
    if (!note) return;
    const h = Math.max(note.h, Math.ceil(el.scrollHeight));
    commit(updateItem(itemsRef.current, id, { text, h }), false);
  };

  const pickTool = (t: BoardTool) => {
    cancelGesture();
    finishEdit();
    setTool(t);
  };

  // ---- links: open a card; `[[` in a note picks one ----
  const openCard = (cardId: string) => {
    const card = findCard(cardId, linkCards);
    if (!card) return say(MISSING_CARD_MESSAGE);
    void zoomIntoCard({ card_id: card.id, title: card.title, area_id: card.area_id }, 'link');
  };
  const [linkPick, setLinkPickState] = useState<{ note: string; from: number; query: string; index: number } | null>(null);
  const linkPickRef = useRef(linkPick);
  const setLinkPick = (p: typeof linkPick) => {
    linkPickRef.current = p;
    setLinkPickState(p);
  };
  const noteEl = useRef<HTMLTextAreaElement | null>(null);
  const linkMatches: LinkableCard[] = linkPick ? rankCards(linkPick.query, linkCards, 6) : [];
  const watchLinkQuery = (id: string, el: HTMLTextAreaElement) => {
    const q = linkCards.length ? linkQueryAt(el.value, el.selectionStart ?? el.value.length) : null;
    const was = linkPickRef.current;
    setLinkPick(q ? { note: id, from: q.from, query: q.query, index: was && was.note === id && was.query === q.query ? was.index : 0 } : null);
  };
  const pickLink = (card: LinkableCard) => {
    const p = linkPickRef.current;
    const el = noteEl.current;
    setLinkPick(null);
    if (!p || !el) return;
    const note = itemsRef.current.find((it) => it.id === p.note);
    if (!note || note.kind !== 'note') return;
    const caret = el.selectionStart ?? note.text.length;
    const link = formatCardLink(card.id, card.title);
    const text = note.text.slice(0, p.from) + link + note.text.slice(caret);
    commit(updateItem(itemsRef.current, note.id, { text }), false);
    const at = p.from + link.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };
  /** The picker's keys in the note: arrows move, Enter or Tab picks. True when it took the key. */
  const linkPickKey = (e: React.KeyboardEvent): boolean => {
    const p = linkPickRef.current;
    if (!p || !linkMatches.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = linkMatches.length;
      setLinkPick({ ...p, index: (p.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
    } else if (e.key === 'Enter' || e.key === 'Tab') pickLink(linkMatches[Math.min(p.index, linkMatches.length - 1)]);
    else return false;
    e.preventDefault();
    return true;
  };

  // ---- gestures ----
  const drag = useRef<Gesture | null>(null);
  const [live, setLive] = useState<Live>(null);
  const [space, setSpace] = useState(false);
  const [hoverHandle, setHoverHandle] = useState<Handle | null>(null);
  const lastPointer = useRef<Point | null>(null);

  const shown = useMemo(() => {
    if (live?.kind === 'move') return moveItems(items, live.ids, { x: live.dx, y: live.dy });
    if (live?.kind === 'resize') return resizeItem(items, live.id, live.rect);
    return items;
  }, [items, live]);
  const selRect = useMemo(() => selectionRect(shown, selected), [shown, selected]);
  const single = selected.length === 1 ? shown.find((it) => it.id === selected[0]) ?? null : null;
  const resizable = !!single && isResizable(single) && editing !== single.id;

  const cancelGesture = () => {
    drag.current = null;
    setLive(null);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as Element;
    if (t.closest('[data-board-ui], textarea, input, button, a')) return;
    const capture = () => (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    rootRef.current?.focus({ preventScroll: true });
    if (e.button === 1 || (e.button === 0 && space)) {
      e.preventDefault();
      drag.current = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, cam };
      setOwn(cam);
      return capture();
    }
    if (e.button !== 0 || load !== 'ok') return;
    finishEdit();
    const p = worldAt(e.clientX, e.clientY);
    const list = itemsRef.current;
    const tol = STROKE_HIT_PX / cam.scale;
    if (tool === 'select') {
      if (resizable && single && selRect) {
        const handle = handleAt(selRect, p, cam.scale);
        if (handle) {
          drag.current = { kind: 'resize', id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, item: single, handle };
          setOwn(cam);
          return capture();
        }
      }
      const hit = itemAt(list, p, tol);
      if (hit) {
        const sel = selectedRef.current;
        const wasOnly = sel.length === 1 && sel[0] === hit.id;
        const ids = e.shiftKey ? toggleSelected(sel, hit.id) : sel.includes(hit.id) ? sel : [hit.id];
        setSelected(ids);
        if (ids.includes(hit.id)) drag.current = { kind: 'press', id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, ids, hit: hit.id, wasOnly: wasOnly && !e.shiftKey };
        return capture();
      }
      const base = e.shiftKey ? selectedRef.current : [];
      if (!e.shiftKey) setSelected([]);
      drag.current = { kind: 'marquee', id: e.pointerId, a: p, b: p, base };
      setOwn(cam);
      return capture();
    }
    if (tool === 'annotate') {
      // No mousedown after this: its focus would land on the Board and blur the new note.
      e.preventDefault();
      const onNote = itemAt(list, p, 0, ['note']);
      if (onNote) return beginEdit(onNote.id);
      if (!canAdd(list)) return say('This Board is full');
      const target = pinTargetAt(list, p);
      const note = makeNote(list, p, target ? pinFor(target, p) : null);
      commit([...list, note]);
      beginEdit(note.id, true);
      return;
    }
    if (tool === 'highlight') {
      drag.current = { kind: 'highlight', id: e.pointerId, a: p, b: p, on: imageAt(list, p) };
      setOwn(cam);
      return capture();
    }
    if (tool === 'draw') {
      drag.current = { kind: 'draw', id: e.pointerId, points: [p], last: { x: e.clientX, y: e.clientY } };
      setOwn(cam);
      setLive({ kind: 'ink', points: [p] });
      return capture();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    lastPointer.current = localPoint(e.clientX, e.clientY);
    const d = drag.current;
    if (!d) {
      if (tool === 'select' && resizable && selRect) {
        const h = handleAt(selRect, worldAt(e.clientX, e.clientY), cam.scale);
        if (h !== hoverHandle) setHoverHandle(h);
      } else if (hoverHandle) setHoverHandle(null);
      return;
    }
    if (d.id !== e.pointerId) return;
    const now = { x: e.clientX, y: e.clientY };
    switch (d.kind) {
      case 'pan':
        return setOwn(panBy(d.cam, now.x - d.x, now.y - d.y));
      case 'press': {
        if (!d.moved && !movedEnough(d, now)) return;
        if (!d.moved) setOwn(cam);
        d.moved = true;
        const delta = dragDelta(d, now, cam.scale);
        return setLive({ kind: 'move', ids: d.ids, dx: delta.x, dy: delta.y });
      }
      case 'resize': {
        if (!d.moved && !movedEnough(d, now)) return;
        d.moved = true;
        return setLive({ kind: 'resize', id: d.item.id, rect: resizeRect(d.item, d.handle, dragDelta(d, now, cam.scale), aspectFor(d.item)) });
      }
      case 'marquee': {
        d.b = worldAt(now.x, now.y);
        const rect = rectBetween(d.a, d.b);
        setLive({ kind: 'marquee', rect });
        const inside = itemsInRect(itemsRef.current, rect);
        return setSelected([...d.base, ...inside.filter((id) => !d.base.includes(id))]);
      }
      case 'highlight': {
        d.b = worldAt(now.x, now.y);
        const h = makeHighlight(itemsRef.current, d.a, d.b, d.on, 'it-live');
        return setLive(h ? { kind: 'highlight', rect: { x: h.x, y: h.y, w: h.w, h: h.h } } : null);
      }
      case 'draw': {
        if (Math.hypot(now.x - d.last.x, now.y - d.last.y) < STROKE_STEP_PX) return;
        d.last = now;
        d.points.push(worldAt(now.x, now.y));
        return setLive({ kind: 'ink', points: d.points.slice() });
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setLive(null);
    if (!d || d.id !== e.pointerId) return;
    const now = { x: e.clientX, y: e.clientY };
    const list = itemsRef.current;
    switch (d.kind) {
      case 'press': {
        if (d.moved) {
          const delta = dragDelta(d, now, cam.scale);
          if (delta.x || delta.y) commit(moveItems(list, d.ids, delta));
          return;
        }
        // A click on the one selected note writes in it.
        const hit = list.find((it) => it.id === d.hit);
        if (d.wasOnly && hit?.kind === 'note') beginEdit(hit.id);
        return;
      }
      case 'resize':
        if (d.moved) commit(resizeItem(list, d.item.id, resizeRect(d.item, d.handle, dragDelta(d, now, cam.scale), aspectFor(d.item))));
        return;
      case 'highlight': {
        const h = makeHighlight(list, d.a, worldAt(now.x, now.y), d.on);
        if (!h) return;
        if (!canAdd(list)) return say('This Board is full');
        commit([...list, h]);
        return;
      }
      case 'draw': {
        const s = makeStroke(list, d.points, cam.scale);
        if (!s) return;
        if (!canAdd(list)) return say('This Board is full');
        commit([...list, s]);
        return;
      }
      default:
        return;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-board-ui], textarea')) return;
    const hit = itemAt(itemsRef.current, worldAt(e.clientX, e.clientY), STROKE_HIT_PX / cam.scale);
    if (hit?.kind === 'note') beginEdit(hit.id);
    else if (hit?.kind === 'link') openCard(hit.card_id);
  };

  // ---- images: paste, drop, a file ----
  const addImages = async (files: readonly Blob[], at?: Point, source: AssetSource | null = null) => {
    if (!files.length || loadRef.current !== 'ok') return;
    const centre = at ?? viewCentre();
    const added: BoardItem[] = [];
    say(files.length > 1 ? `Adding ${files.length} images…` : 'Adding the image…');
    for (const f of files) {
      if (!canAdd(itemsRef.current, added.length + 1)) {
        say('This Board is full');
        break;
      }
      const r = await addImageAsset(workspace, boardId, f, source);
      if ('error' in r) {
        say(r.error);
        continue;
      }
      const n = added.length;
      added.push(makeImage([...itemsRef.current, ...added], r.name, { w: r.w, h: r.h }, { x: centre.x + n * CASCADE, y: centre.y + n * CASCADE }, window.devicePixelRatio || 1));
    }
    if (!added.length || !alive.current) return;
    commit([...itemsRef.current, ...added]);
    setSelected(added.map((it) => it.id));
    setFlash(null);
  };
  const pointerOrCentre = (): Point => (lastPointer.current ? screenToWorld(camRef.current, lastPointer.current) : viewCentre());
  const fileRef = useRef<HTMLInputElement | null>(null);

  // ---- the API (B3's seam) ----
  // Its methods read refs, or call this render's helpers through `current`.
  const current = useRef({ addImages, viewCentre, renderOpts, bitmapsFor });
  current.current = { addImages, viewCentre, renderOpts, bitmapsFor };
  const api = useMemo<BoardApi>(
    () => ({
      workspace,
      boardId,
      items: () => itemsRef.current,
      selection: () => {
        const ids = selectedRef.current;
        const list = itemsRef.current;
        return { item_ids: ids.slice(), rect: selectionRect(list, ids), items: list.filter((it) => ids.includes(it.id)) };
      },
      addItems: (add, select = false) => {
        if (!add.length) return;
        commit([...itemsRef.current, ...add]);
        if (select) setSelected(add.map((it) => it.id));
      },
      updateItem: (id, patch, undoable = true) => commit(updateItem(itemsRef.current, id, patch), undoable),
      removeItems: (ids) => {
        commit(removeItems(itemsRef.current, ids));
        setSelected(selectedRef.current.filter((x) => !ids.includes(x)));
      },
      flatten: async (rect, ids) => {
        const list = itemsRef.current;
        const only = ids ?? itemsInRect(list, rect);
        const images = await current.current.bitmapsFor(list.filter((it) => only.includes(it.id)));
        // At the screen's density (a pasted screenshot keeps its pixels), the longest side at most SNAPSHOT_MAX_PX.
        const scale = Math.min(window.devicePixelRatio || 1, 2, SNAPSHOT_MAX_PX / Math.max(rect.w, rect.h, 1));
        return renderBoardPng(list, rect, images, { ...current.current.renderOpts(), only, scale });
      },
      uploadAsset: async (blob, mime, source = null, selection = false) => {
        const r = await uploadBoardAsset(workspace, boardId, blob, mime, source, selection);
        if (!r.ok) return { error: r.error };
        primeBoardAsset(workspace, boardId, r.data.name, blob);
        return { name: r.data.name };
      },
      addImages: (files, at, source) => current.current.addImages(files, at, source),
      viewCentre: () => current.current.viewCentre(),
      say,
    }),
    // commit, setItems and setSelected only touch refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, boardId],
  );
  useImperativeHandle(ref, () => api, [api]);

  const selection = (): BoardSelection => api.selection();

  // ---- keys: tools, Esc, Delete, undo, ⌘A, ⌘., Space to pan; paste ----
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    if (e.isComposing || document.querySelector('.deep-sheet-scrim')) return;
    const root = rootRef.current;
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!root || !(e.target === document.body || (e.target instanceof Node && root.contains(e.target)))) return;
    // The action row and its field (BoardView) take their own keys, Esc included.
    if (t?.closest('[data-board-ui]')) return;
    const inNote = !!t && t.classList.contains('board-note-edit');
    const typing = isTyping(t);
    if (e.key === 'Escape') {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // The title field has its own Esc.
      if (typing && !inNote) return;
      e.preventDefault();
      e.stopPropagation();
      if (linkPickRef.current) return setLinkPick(null);
      const step = boardEscapeStep({ dragging: !!drag.current, editing: !!editingRef.current, selected: selectedRef.current.length, tool });
      if (step === 'cancel') cancelGesture();
      else if (step === 'stop-editing') {
        finishEdit();
        root.focus({ preventScroll: true });
      } else if (step === 'deselect') setSelected([]);
      else if (step === 'select-tool') pickTool('select');
      else zoomOut('overview', 'key');
      return;
    }
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && k === 'z') {
      e.preventDefault();
      const step = e.shiftKey ? redo(history.current, itemsRef.current) : undo(history.current, itemsRef.current);
      if (!step) return;
      history.current = step.history;
      setItems(step.state);
      saveEvent({ type: 'edit' });
      setSelected(selectedRef.current.filter((id) => step.state.some((it) => it.id === id)));
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && k === 'a') {
      e.preventDefault();
      setSelected(itemsRef.current.map((it) => it.id));
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key === '.') {
      if (!selectedRef.current.length) return;
      e.preventDefault();
      if (onSelectionAction) onSelectionAction(selection(), api);
      else say('Ask and Hand off on a Board come soon');
      return;
    }
    if (mod || e.altKey) return;
    // Enter and Space on a focused button are the button's.
    if ((e.key === 'Enter' || e.key === ' ') && t?.closest('button')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.length) {
      e.preventDefault();
      commit(removeItems(itemsRef.current, selectedRef.current));
      setSelected([]);
      return;
    }
    if (e.key === 'Enter' && selectedRef.current.length === 1) {
      const it = itemsRef.current.find((x) => x.id === selectedRef.current[0]);
      if (it?.kind === 'note') {
        e.preventDefault();
        beginEdit(it.id);
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) setSpace(true);
      return;
    }
    const next = boardToolForKey(e, typing);
    if (next) {
      e.preventDefault();
      pickTool(next);
    }
  };
  const paste = useRef<(e: ClipboardEvent) => void>(() => undefined);
  paste.current = (e: ClipboardEvent) => {
    if (isTyping(e.target) || loadRef.current !== 'ok') return;
    const root = rootRef.current;
    if (!root || !(e.target === document.body || (e.target instanceof Node && root.contains(e.target)))) return;
    const files = imagesIn(e.clipboardData);
    const at = pointerOrCentre();
    if (files.length) {
      e.preventDefault();
      void addImages(files, at);
      return;
    }
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (!text) return;
    e.preventDefault();
    if (!canAdd(itemsRef.current)) return say('This Board is full');
    const linked = loneCardLink(text);
    if (linked) {
      const link = makeLink(itemsRef.current, linked, at);
      commit([...itemsRef.current, link]);
      setSelected([link.id]);
      return;
    }
    const note = makeNote(itemsRef.current, at, null, text);
    commit([...itemsRef.current, note]);
    setSelected([note.id]);
  };
  useEffect(() => {
    if (!visible) return;
    // Capture: a Board's Esc runs before DeepHost's, which would zoom out.
    const onKey = (e: KeyboardEvent) => keys.current(e);
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpace(false);
    };
    const onPaste = (e: ClipboardEvent) => paste.current(e);
    const onBlur = () => setSpace(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('paste', onPaste);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('blur', onBlur);
    };
  }, [visible]);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
    else {
      finishEdit();
      setSpace(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ---- the title ----
  const [renaming, setRenaming] = useState<string | null>(null);
  const [shownTitle, setShownTitle] = useState(title);
  useEffect(() => setShownTitle(title), [title]);
  const commitRename = async () => {
    const next = (renaming ?? '').trim();
    setRenaming(null);
    if (!next || next === shownTitle) return;
    setShownTitle(next);
    const r = await patchBoard(workspace, boardId, { title: next });
    if (!r.ok) {
      setShownTitle(shownTitle);
      return say(r.error);
    }
    if (cockpitModeStore.getDeep().card_id === boardId) cockpitModeStore.setDeskNav({ title: next });
    void deskCtx?.refresh();
  };

  // ---- drawing ----
  const sorted = sortByZ(shown);
  const order = new Map(sorted.map((it, i) => [it.id, i]));
  const cursor = boardCursor(tool, { panning: drag.current?.kind === 'pan', space, handle: hoverHandle });
  const dirty = save.dirty || save.saving;
  const sel = selected.length && selRect && !live ? { item_ids: selected, rect: selRect, items: shown.filter((it) => selected.includes(it.id)) } : null;
  const slotAt = sel?.rect ? worldToScreen(cam, { x: sel.rect.x, y: sel.rect.y + sel.rect.h }) : null;

  return (
    <div ref={rootRef} className="board" tabIndex={-1} aria-label="Board">
      <header className="deep-header">
        <button className="deep-quiet desk-back" onClick={() => zoomOut('overview', 'click')} title="Back to the Desk (Esc)">
          Desk
        </button>
        <span className="desk-crumb-sep" aria-hidden="true">
          /
        </span>
        {renaming != null ? (
          <input
            className="deep-title-input"
            autoFocus
            value={renaming}
            aria-label="Title"
            maxLength={200}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitRename();
                rootRef.current?.focus({ preventScroll: true });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setRenaming(null);
                rootRef.current?.focus({ preventScroll: true });
              }
            }}
          />
        ) : (
          <button className="deep-title" title="Rename" onClick={() => setRenaming(shownTitle)}>
            {shownTitle || 'Untitled'}
          </button>
        )}
        {dirty && <span className={`deep-dirty${save.failed ? ' is-retrying' : ''}`} title={save.failed ? 'Unsaved: Hester offline, saving when it’s back' : 'Unsaved changes'} />}
        <span className="deep-view-name" aria-current="page">
          Board
        </span>
        <span className="deep-spacer" />
        {flash && <span className="deep-flash is-ok">{flash}</span>}
        <span className="deep-window-actions">
          <IconAction icon="close" label="Close" kbd="Esc" onClick={() => zoomOut('overview', 'click')} />
        </span>
      </header>

      {load === 'loading' && <div className="desk-note deep-muted">Opening the Board…</div>}
      {load === 'offline' && <div className="desk-note">Hester is offline. The Board comes back when it does.</div>}
      {load === 'missing' && <div className="desk-note">This Board isn’t in Hester. It may have been deleted, or Hester is older than this Lee (reinstall it).</div>}

      {load === 'ok' && (
        <div
          ref={viewRef}
          className={`board-viewport is-tool-${tool}${space ? ' is-panning' : ''}`}
          style={{ cursor }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelGesture}
          onDoubleClick={onDoubleClick}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            const files = imagesIn(e.dataTransfer);
            if (!files.length) return;
            e.preventDefault();
            void addImages(files, worldAt(e.clientX, e.clientY));
          }}
        >
          <div className="board-world" style={{ transform: cameraTransform(cam), ['--board-scale' as string]: String(cam.scale) }}>
            {sorted.map((it) => {
              const z = (order.get(it.id) ?? 0) * 2 + 1;
              const box: React.CSSProperties = { left: it.x, top: it.y, width: it.w, height: it.h, zIndex: z };
              const isSel = selected.includes(it.id);
              switch (it.kind) {
                case 'image': {
                  const url = urls[it.asset];
                  return url ? (
                    <img key={it.id} className={`board-image${isSel ? ' is-selected' : ''}`} src={url} alt="" draggable={false} style={box} />
                  ) : (
                    <div key={it.id} className="board-image is-loading" style={box} />
                  );
                }
                case 'highlight':
                  return <div key={it.id} className={`board-highlight${isSel ? ' is-selected' : ''}`} style={box} />;
                case 'stroke':
                  return (
                    <svg key={it.id} className={`board-stroke${isSel ? ' is-selected' : ''}`} style={{ zIndex: z }} aria-hidden="true">
                      <path d={strokePath(it.points.map(([x, y]) => ({ x, y })))} strokeWidth={it.width} />
                    </svg>
                  );
                case 'note': {
                  const leader = leaderLine(it, shown);
                  const pin = pinPoint(shown, it.pin);
                  return (
                    <React.Fragment key={it.id}>
                      {pin && (
                        <svg className="board-leader" style={{ zIndex: z - 1 }} aria-hidden="true">
                          {leader && <line x1={leader.from.x} y1={leader.from.y} x2={leader.to.x} y2={leader.to.y} strokeWidth={1 / cam.scale} />}
                          <circle cx={pin.x} cy={pin.y} r={3.5 / cam.scale} />
                        </svg>
                      )}
                      <div className={`board-note${isSel ? ' is-selected' : ''}${editing === it.id ? ' is-editing' : ''}`} style={box}>
                        {editing === it.id ? (
                          <textarea
                            className="board-note-edit"
                            autoFocus
                            value={it.text}
                            aria-label="Note"
                            placeholder="Write a note…"
                            onChange={(e) => {
                              typeNote(it.id, e.target.value, e.currentTarget);
                              watchLinkQuery(it.id, e.currentTarget);
                            }}
                            onKeyDown={(e) => {
                              if (linkPickKey(e)) e.stopPropagation();
                            }}
                            onBlur={() => finishEdit()}
                            onFocus={(e) => {
                              const el = e.currentTarget;
                              noteEl.current = el;
                              el.setSelectionRange(el.value.length, el.value.length);
                            }}
                          />
                        ) : it.text.trim() ? (
                          <>
                            <AgentMarkdown text={linkTitles(it.text)} className="board-note-text" />
                            <NoteLinks text={it.text} cards={linkCards} onOpen={openCard} />
                          </>
                        ) : (
                          <span className="deep-muted">Empty note</span>
                        )}
                      </div>
                    </React.Fragment>
                  );
                }
                case 'ask':
                case 'handoff':
                case 'visual':
                  // The card places itself (Board px) in a layer at the world's origin, stacked like the rest.
                  return renderAnswerItem ? (
                    <div key={it.id} className="board-answer-layer" style={{ zIndex: z }}>
                      {renderAnswerItem(it, api, isSel)}
                    </div>
                  ) : (
                    <div key={it.id} className={`board-answer is-${it.kind}${isSel ? ' is-selected' : ''}`} style={box}>
                      <span className="board-answer-label">{it.kind === 'ask' ? 'Ask' : it.kind === 'visual' ? 'Visualize' : 'Hand-off'}</span>
                    </div>
                  );
                case 'link':
                  return (
                    <div key={it.id} className={`board-link${isSel ? ' is-selected' : ''}${findCard(it.card_id, linkCards) ? '' : ' is-missing'}`} style={box} title="Double-click to open">
                      <Icon name={it.card_id.startsWith('bd-') ? 'image' : 'document'} size={14} />
                      {cardLinkDisplay({ card_id: it.card_id, label: null }, findCard(it.card_id, linkCards))}
                    </div>
                  );
              }
            })}

            {/* What a gesture shows before it lands, then the selection over everything. */}
            {live?.kind === 'marquee' && <div className="board-marquee" style={{ left: live.rect.x, top: live.rect.y, width: live.rect.w, height: live.rect.h }} />}
            {live?.kind === 'highlight' && <div className="board-highlight is-drawing" style={{ left: live.rect.x, top: live.rect.y, width: live.rect.w, height: live.rect.h }} />}
            {live?.kind === 'ink' && live.points.length > 1 && (
              <svg className="board-stroke is-drawing" aria-hidden="true">
                <path d={strokePath(live.points)} strokeWidth={2 / cam.scale} />
              </svg>
            )}
            {selRect && live?.kind !== 'marquee' && (
              <div className="board-selection" style={{ left: selRect.x, top: selRect.y, width: selRect.w, height: selRect.h }} aria-hidden="true">
                {resizable && !live && HANDLES.map((h) => <span key={h} className={`board-handle is-${h}`} />)}
              </div>
            )}
          </div>

          {items.length === 0 && !live && (
            <div className="board-empty deep-muted">Paste or drop an image, or pick one below. A (Annotate) adds a note.</div>
          )}

          {linkPick && editing === linkPick.note && linkMatches.length > 0 && (() => {
            const note = shown.find((x) => x.id === linkPick.note);
            if (!note) return null;
            const at = worldToScreen(cam, { x: note.x, y: note.y + note.h });
            return (
              <div data-board-ui="">
                <PagePicker
                  items={linkMatches.map((c) => ({ key: c.id, label: c.title || 'Untitled', sub: cardLinkSub(c), icon: c.kind === 'board' ? 'image' : 'document' }))}
                  index={Math.min(linkPick.index, linkMatches.length - 1)}
                  top={Math.min(size.h - 40, at.y + 6)}
                  left={Math.max(8, at.x)}
                  label="Pages and Boards"
                  empty="No matching cards"
                  onPick={(i) => pickLink(linkMatches[i])}
                  onHover={(i) => setLinkPick({ ...linkPick, index: i })}
                />
              </div>
            );
          })()}

          {sel && slotAt && selectionSlot && (
            <div className="board-slot" data-board-ui="" style={{ left: Math.max(8, slotAt.x), top: Math.min(size.h - 40, slotAt.y + 8) }}>
              {selectionSlot(sel, api)}
            </div>
          )}
        </div>
      )}

      <footer className="desk-drawers desk-taskbar board-taskbar">
        <span />
        <span className="desk-taskbar-mid" role="toolbar" aria-label="Board tools">
          {BOARD_TOOLS.map((t) => (
            <IconAction
              key={t.tool}
              icon={t.icon}
              label={t.label}
              kbd={t.key}
              className={`desk-tool${tool === t.tool ? ' is-current' : ''}`}
              onClick={() => pickTool(t.tool)}
            />
          ))}
          <span className="desk-taskbar-sep" aria-hidden="true" />
          <IconAction icon="image" label="Add an image" onClick={() => fileRef.current?.click()} disabled={load !== 'ok'} />
          <IconAction icon="maximize" label="Fit the Board" onClick={fitAll} disabled={load !== 'ok'} />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void addImages(files);
            }}
          />
        </span>
        <span className="deep-muted desk-hint desk-taskbar-right">{TOOL_HINT[tool]}</span>
      </footer>
    </div>
  );
});
