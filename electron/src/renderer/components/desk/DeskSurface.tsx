/**
 * DeskSurface - the Desk below a zoomed card (docs/16-Desk.md §2, §3; D2
 * contract §7.2): the overview (every Area on the Desk), an Area (it fills
 * the view), the Goals card pinned once to its corner, and the Drawers.
 *
 * - Pan and zoom are CSS transforms on one layer; the maths is pure in
 *   lib/deskModel.ts. Wheel pans, pinch (or ⌘/ctrl + wheel) zooms about the
 *   pointer, a drag on bare Desk pans. Changing zoom level refits.
 * - Cards show their title in Newsreader (your words), a quiet count line,
 *   and an ember dot only when a hand-off in them is waiting on you. Hover
 *   (300 ms) shows the read-only preview; the zoom button, Enter on a
 *   focused card or a double-click zooms in. Nothing is editable here.
 * - A click on an empty spot in an Area starts a Page there: an in-memory
 *   Page, zoomed in, created only once it has text (Deep next R8).
 * - The Goals card is pinned once to the Desk's top-right corner, the same
 *   at every zoom: GOALS.md's goals, else the Goals Page's first line, else
 *   "What is this project for?", where typing creates it.
 * - An Area's ⋯ (or a right-click on it): Rename, New Page here, Stash.
 * - The Drawer is a button in the strip along the bottom of the overview: a
 *   menu of stashed Areas (click to unstash one) and Ideas (click
 *   to start a Page, or drag one onto an Area).
 * - Tools, in a small bar at the bottom: Cursor (V; all of the above),
 *   Move (M; drag a card within or between Areas, or an Area by its name
 *   strip, cards and lines with it) and Draw (D; freehand lines, in the
 *   Area where they start, else on the Desk). Lines mean nothing to Hester.
 *   In Cursor a click selects a line; Delete, or its right-click menu,
 *   deletes it, and ⌘Z undoes the last draw or delete. Moves and lines show
 *   at once and settle when Hester has them (deskModel's DeskEdits).
 * - Esc: closes the innermost thing (a Drawer, the preview, a selected
 *   line), then Move or Draw goes back to Cursor, then from an Area goes to
 *   the overview. From a zoomed card it's DeepHost's.
 * - No `next` button anywhere here: the Desk is a place, not a flow.
 * - A Hester without the Desk (404) gets one quiet line asking for a
 *   reinstall and nothing else (§10).
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IDEAS_DRAWER, type DeskArea, type DeskCard, type DeskRect, type DeskStroke, type DeskStrokeCreate } from '../../../shared/desk';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import type { LeeMode } from '../../../shared/cockpit';
import { cockpitModeStore, openDesk, useCockpitModeState, zoomIntoCard, zoomOut, zoomToArea } from '../cockpit/cockpitMode';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { IconAction } from '../cockpit/ui';
import { fetchGoalsStatus, listIdeas, triageIdea, type Idea } from '../../lib/hesterCockpit';
import {
  createArea,
  createStroke,
  deleteArea,
  deleteDeskPage,
  deleteStroke,
  ideaToPage,
  patchArea,
  patchCard,
  stashArea,
  unstashArea,
} from '../../lib/hesterDesk';
import { captureIdea as postIdea, newDraft } from '../../lib/hesterDeep';
import { MicButton } from '../voice/MicButton';
import { untitledTitle, wokenItem } from '../../lib/deepModel';
import {
  AREA_HEAD,
  DESK_TOOLS,
  IDENTITY,
  NO_EDITS,
  STROKE_STEP_PX,
  areaAt,
  areasOnDesk,
  cameraTransform,
  cardCountLine,
  cardsIn,
  deskEscapeStep,
  dragDelta,
  drawerCounts,
  dropArea,
  dropCard,
  dropEdit,
  fitRect,
  focusRect,
  isEmptySpot,
  movedEnough,
  panBy,
  placeNewCard,
  drawerFolders,
  searchDrawer,
  byDate,
  type DrawerEntry,
  rectFromDrag,
  screenToDesk,
  deskToScreen,
  strokeFromDrag,
  strokePath,
  toolCursor,
  toolForKey,
  withEdits,
  zoomAt,
  type Camera,
  type DeskEdits,
  type DeskTool,
  type EscLayer,
  type Point,
} from '../../lib/deskModel';
import { useDeskContext } from './useDesk';
import './desk.css';

interface DeskSurfaceProps {
  workspace: string;
  /** Deep shows and no card is zoomed in. */
  visible: boolean;
  copilot: UseCopilotResult;
  onHop: (to: LeeMode) => void;
}

const HOVER_MS = 300;
const GOALS_SHOWN = 5;
const IDEA_MIME = 'application/x-lee-idea';
const UNDO_MAX = 50;
/** Screen px either side of a line that still picks it. */
const STROKE_HIT_PX = 6;
const TOOL_HINT: Record<DeskTool, string> = {
  cursor: 'Click an empty spot in an Area to start a Page',
  move: 'Drag a Page, or an Area from anywhere inside it',
  draw: 'Draw anywhere. Lines are yours; Hester doesn’t read them',
  area: 'Drag out a new Area, then name it',
};

/** A press on the Desk, by what it started. */
type Gesture =
  | { kind: 'pan'; id: number; x: number; y: number; cam: Camera; moved: boolean }
  | { kind: 'card'; id: number; x: number; y: number; moved: boolean; card: DeskCard; from: DeskArea }
  | { kind: 'area'; id: number; x: number; y: number; moved: boolean; area: DeskArea }
  | { kind: 'draw'; id: number; points: Point[]; last: Point }
  | { kind: 'rect'; id: number; a: Point; b: Point };

/** ⌘Z: the last line drawn goes; the last one deleted comes back. */
type StrokeUndo = { kind: 'drew'; id: string } | { kind: 'deleted'; stroke: DeskStroke };

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

export function DeskSurface({ workspace, visible, copilot, onHop }: DeskSurfaceProps): JSX.Element {
  const ctx = useDeskContext();
  // Your moves and lines show at once, over what Hester last said (until it says so too).
  const [edits, setEdits] = useState<DeskEdits>(NO_EDITS);
  const desk = useMemo(() => (ctx?.desk ? withEdits(ctx.desk, edits) : null), [ctx?.desk, edits]);
  const deskRef = useRef(desk);
  deskRef.current = desk;
  const status = ctx?.status ?? 'loading';
  const nav = useCockpitModeState().deep;
  const zoom = nav.zoom;

  // ---- the viewport and the camera ----
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [visible]);

  const onDesk = useMemo(() => (desk ? areasOnDesk(desk) : []), [desk]);
  const fitted = useMemo<Camera>(() => {
    if (!desk) return IDENTITY;
    const r = focusRect(desk, zoom, nav.area_id, zoom === 'card' ? nav.card_id : null);
    return r ? fitRect(size, r, zoom === 'overview' ? 64 : zoom === 'area' ? 32 : 0, zoom === 'overview' ? 1 : 1.25) : IDENTITY;
  }, [desk, zoom, nav.area_id, nav.card_id, size]);
  // Your own pan and zoom, until the zoom level (or its Area) changes.
  const [own, setOwn] = useState<Camera | null>(null);
  useEffect(() => setOwn(null), [zoom, nav.area_id]);
  const cam = own ?? fitted;

  const localPoint = (clientX: number, clientY: number): Point => {
    const r = viewRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) setOwn(zoomAt(cam, localPoint(e.clientX, e.clientY), Math.exp(-e.deltaY * 0.01)));
    else setOwn(panBy(cam, -e.deltaX, -e.deltaY));
  };

  // ---- tools ----
  const [tool, setTool] = useState<DeskTool>('cursor');
  // A card or Area being dragged (Desk px), and the Area a card would land in.
  const [lift, setLift] = useState<{ kind: 'card' | 'area'; id: string; dx: number; dy: number; over: string | null } | null>(null);
  // The line being drawn, in Desk px.
  const [ink, setInk] = useState<Point[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [strokeMenu, setStrokeMenu] = useState<{ stroke: DeskStroke; x: number; y: number } | null>(null);
  const undoStack = useRef<StrokeUndo[]>([]);
  const remember = (u: StrokeUndo) => {
    undoStack.current = [...undoStack.current, u].slice(-UNDO_MAX);
  };

  // A press on bare Desk pans; a click (no drag) on an empty spot starts a Page. Move drags
  // cards and Areas instead; Draw draws. Nothing moves the pinned Goals card.
  const drag = useRef<Gesture | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('.desk-card-menu')) return; // a press on a card's or a line's menu is its own
    if ((menuFor && !t.closest('.desk-area-menu')) || drawer || cardMenu || strokeMenu) {
      setMenuFor(null);
      setDrawer(false);
      setCardMenu(null);
      setStrokeMenu(null);
      return;
    }
    if (t.closest('.desk-goals')) return;
    const capture = () => (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const base = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    if (tool === 'draw') {
      const p = screenToDesk(cam, localPoint(e.clientX, e.clientY));
      drag.current = { kind: 'draw', id: e.pointerId, points: [p], last: { x: e.clientX, y: e.clientY } };
      setOwn(cam);
      setInk([p]);
      return capture();
    }
    if (tool === 'area') {
      if (t.closest('button, input, textarea, .desk-area-menu')) return;
      const p = screenToDesk(cam, localPoint(e.clientX, e.clientY));
      drag.current = { kind: 'rect', id: e.pointerId, a: p, b: p };
      setOwn(cam);
      setPendingArea(null);
      return capture();
    }
    if (tool === 'move' && desk) {
      const cardId = (t.closest('.desk-card') as HTMLElement | null)?.dataset.cardId;
      const card = cardId ? desk.cards.find((c) => c.id === cardId && !c.pinned) : null;
      const from = card ? onDesk.find((a) => a.id === card.area_id) : null;
      if (card && from) {
        drag.current = { kind: 'card', ...base, card, from };
        return capture();
      }
      // An Area moves from anywhere inside it that isn't a card (a card moves itself).
      const areaId = !t.closest('.desk-area-menu, input') ? (t.closest('.desk-area') as HTMLElement | null)?.dataset.areaId : undefined;
      const area = areaId ? onDesk.find((a) => a.id === areaId) : null;
      if (area) {
        drag.current = { kind: 'area', ...base, area };
        return capture();
      }
    }
    if (tool === 'cursor') {
      const strokeId = (t.closest('[data-stroke-id]') as HTMLElement | null)?.dataset.strokeId;
      if (strokeId) {
        setSelected(strokeId);
        rootRef.current?.focus({ preventScroll: true });
        return;
      }
    }
    if (t.closest('.desk-card, button, input, textarea, .desk-area-menu')) return;
    setSelected(null);
    drag.current = { kind: 'pan', ...base, cam };
    capture();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const now = { x: e.clientX, y: e.clientY };
    if (d.kind === 'rect') {
      d.b = screenToDesk(cam, localPoint(now.x, now.y));
      setSketch(rectFromDrag(d.a, d.b));
      return;
    }
    if (d.kind === 'draw') {
      if (Math.hypot(now.x - d.last.x, now.y - d.last.y) < STROKE_STEP_PX) return;
      d.last = now;
      d.points.push(screenToDesk(cam, localPoint(now.x, now.y)));
      setInk(d.points.slice());
      return;
    }
    if (!d.moved && !movedEnough(d, now)) return;
    if (!d.moved) {
      d.moved = true;
      if (d.kind !== 'pan') {
        hoverOut();
        setOwn(cam);
      }
    }
    if (d.kind === 'pan') return setOwn(panBy(d.cam, now.x - d.x, now.y - d.y));
    const delta = dragDelta(d, now, cam.scale);
    const over = d.kind === 'card' ? areaAt(onDesk, screenToDesk(cam, localPoint(now.x, now.y)))?.id ?? d.from.id : null;
    setLift({ kind: d.kind, id: d.kind === 'card' ? d.card.id : d.area.id, dx: delta.x, dy: delta.y, over });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    const now = { x: e.clientX, y: e.clientY };
    if (d.kind === 'rect') {
      // A drag outlines the Area; a click places one of the smallest size there. Then it's named.
      setSketch(null);
      setPendingArea({ rect: rectFromDrag(d.a, screenToDesk(cam, localPoint(now.x, now.y))), name: '' });
      return;
    }
    if (d.kind === 'draw') {
      setInk(null);
      const body = strokeFromDrag(d.points, cam.scale, onDesk);
      if (body) void saveStroke(body, true);
      return;
    }
    setLift(null);
    if (d.kind === 'pan') {
      if (!d.moved && tool === 'cursor') onBareClick(localPoint(now.x, now.y));
      return;
    }
    if (!d.moved) return;
    const delta = dragDelta(d, now, cam.scale);
    if (d.kind === 'card') void moveCard(d.card, dropCard(d.card, d.from, delta, onDesk, screenToDesk(cam, localPoint(now.x, now.y))));
    else void moveArea(d.area, dropArea(d.area, delta));
  };
  const cancelGesture = () => {
    drag.current = null;
    setLift(null);
    setInk(null);
    setSketch(null);
  };

  // ---- Rectangle: outline an Area, then name it ----
  const [sketch, setSketch] = useState<DeskRect | null>(null);
  const [pendingArea, setPendingArea] = useState<{ rect: DeskRect; name: string } | null>(null);
  const makeDrawnArea = async () => {
    const p = pendingArea;
    setPendingArea(null);
    const name = (p?.name ?? '').trim();
    if (!p || !name) return;
    const r = await createArea(workspace, { name, ...p.rect });
    if (!r.ok) return say(oldHester(r.status) ?? r.error);
    pickTool('cursor');
    await ctx?.refresh();
  };

  // ---- moving and drawing: shown at once, settled when Hester has it ----
  const oldHester = (code?: number) => (code === 404 || code === 405 ? 'Hester is older than this Lee. Reinstall it to keep this.' : null);
  const moveCard = async (c: DeskCard, to: { area_id: string; x: number; y: number }) => {
    if (to.area_id === c.area_id && to.x === c.x && to.y === c.y) return;
    setEdits((e) => ({ ...e, cards: { ...e.cards, [c.id]: to } }));
    const r = await patchCard(workspace, c.id, to.area_id === c.area_id ? { x: to.x, y: to.y } : to);
    if (!r.ok) say(r.error);
    else await ctx?.refresh();
    setEdits((e) => dropEdit(e, { card: c.id }));
  };
  const moveArea = async (a: DeskArea, to: { x: number; y: number }) => {
    if (to.x === a.x && to.y === a.y) return;
    setEdits((e) => ({ ...e, areas: { ...e.areas, [a.id]: to } }));
    const r = await patchArea(workspace, a.id, to);
    if (!r.ok) say(r.error);
    else await ctx?.refresh();
    setEdits((e) => dropEdit(e, { area: a.id }));
  };
  const tempIds = useRef(0);
  const saveStroke = async (body: DeskStrokeCreate, undoable: boolean) => {
    const temp: DeskStroke = { id: `tmp-${++tempIds.current}`, area_id: body.area_id, points: body.points, width: body.width ?? 2, created_at: '' };
    setEdits((e) => ({ ...e, added: [...e.added, temp] }));
    const r = await createStroke(workspace, body);
    if (!r.ok) say(oldHester(r.status) ?? r.error);
    else {
      if (undoable) remember({ kind: 'drew', id: r.data.id });
      await ctx?.refresh();
    }
    setEdits((e) => dropEdit(e, { added: temp.id }));
  };
  const removeStroke = async (s: DeskStroke, undoable: boolean) => {
    setSelected((x) => (x === s.id ? null : x));
    setStrokeMenu(null);
    if (s.id.startsWith('tmp-')) return;
    setEdits((e) => ({ ...e, removed: [...e.removed, s.id] }));
    const r = await deleteStroke(workspace, s.id);
    if (!r.ok && r.status !== 404) say(oldHester(r.status) ?? r.error);
    else {
      if (undoable) remember({ kind: 'deleted', stroke: s });
      await ctx?.refresh();
    }
    setEdits((e) => dropEdit(e, { removed: s.id }));
  };
  const undo = async () => {
    const u = undoStack.current.pop();
    if (!u) return;
    if (u.kind === 'drew') {
      const s = deskRef.current?.strokes?.find((x) => x.id === u.id);
      if (s) await removeStroke(s, false);
    } else await saveStroke({ area_id: u.stroke.area_id, points: u.stroke.points, width: u.stroke.width }, false);
  };
  const pickTool = (t: DeskTool) => {
    cancelGesture();
    setTool(t);
    setPreview(null);
    setStrokeMenu(null);
    if (t !== 'cursor') setSelected(null);
  };

  // ---- starting things ----
  const onBareClick = (p: Point) => {
    if (!desk) return;
    const at = screenToDesk(cam, p);
    const area = areaAt(onDesk, at);
    if (!area) return;
    const rel = { x: at.x - area.x, y: at.y - area.y };
    if (rel.y < AREA_HEAD) {
      zoomToArea(area.id);
      return;
    }
    if (isEmptySpot(area, cardsIn(desk, area.id), rel)) startPage(area, rel);
  };

  const startPage = (area: DeskArea, rel: Point) => {
    if (!desk) return;
    const r = placeNewCard(area, cardsIn(desk, area.id), rel);
    const title = untitledTitle(new Date());
    const id = newDraft({ workspace, title, page: '', sendTitle: true, origin: { kind: 'cockpit' }, desk: { area_id: area.id, x: r.x, y: r.y } });
    void zoomIntoCard({ card_id: id, title, area_id: area.id }, 'click');
  };

  const zoomCard = (c: DeskCard, area: DeskArea | null, via: 'click' | 'key') => {
    setPreview(null);
    void zoomIntoCard({ card_id: c.id, title: c.title, area_id: c.pinned ? area?.id ?? nav.area_id : c.area_id }, via);
  };

  // ---- the hover preview (300 ms, read-only) ----
  const [preview, setPreview] = useState<{ card: DeskCard; x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIn = (c: DeskCard, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (tool !== 'cursor' || drag.current) return;
    hoverTimer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const v = viewRef.current?.getBoundingClientRect();
      const x = r.right - (v?.left ?? 0) + 12;
      setPreview({ card: c, x: x + 380 > size.w ? Math.max(8, r.left - (v?.left ?? 0) - 392) : x, y: Math.max(8, r.top - (v?.top ?? 0)) });
    }, HOVER_MS);
  };
  const hoverOut = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setPreview(null);
  };
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  useEffect(() => setPreview(null), [cam, zoom]);

  // ---- a one-line status (not a toast) ----
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((t: string) => {
    setFlash(t);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 6000);
  }, []);

  // ---- Areas: new, rename, stash ----
  const [newArea, setNewArea] = useState<string | null>(null);
  const makeArea = async () => {
    const name = (newArea ?? '').trim();
    setNewArea(null);
    if (!name) return;
    const r = await createArea(workspace, { name });
    if (!r.ok) return say(r.error);
    await ctx?.refresh();
    zoomToArea(r.data.id, 'click');
  };
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const rename = async () => {
    const r0 = renaming;
    setRenaming(null);
    if (!r0 || !r0.name.trim()) return;
    const r = await patchArea(workspace, r0.id, { name: r0.name.trim() });
    if (!r.ok) return say(r.error);
    void ctx?.refresh();
  };
  const stash = async (a: DeskArea) => {
    setMenuFor(null);
    const r = await stashArea(workspace, a.id);
    if (!r.ok) return say(r.error);
    if (nav.area_id === a.id) zoomOut('overview', 'click');
    say(`Stashed: ${a.name}`);
    void ctx?.refresh();
  };

  // ---- Drawers ----
  const [drawer, setDrawer] = useState(false);
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const loadIdeas = useCallback(async () => {
    const r = await listIdeas(workspace, 'open');
    setIdeas(r.ok && Array.isArray(r.data) ? r.data : []);
  }, [workspace]);
  useEffect(() => {
    if (drawer) void loadIdeas();
  }, [drawer, loadIdeas]);
  const ideaPage = async (id: string, where?: { area: DeskArea; rel: Point }) => {
    const at = where && desk ? placeNewCard(where.area, cardsIn(desk, where.area.id), where.rel) : null;
    const r = await ideaToPage(workspace, id, where && at ? { area_id: where.area.id, x: at.x, y: at.y } : {});
    if (!r.ok) return say(r.status === 409 ? 'That idea isn’t open any more' : r.error);
    setIdeas((l) => (l ? l.filter((i) => i.id !== id) : l));
    await ctx?.refresh();
    setDrawer(false);
    void zoomIntoCard({ card_id: r.data.card.id, title: r.data.card.title, area_id: r.data.area.id }, 'click');
  };
  const triage = async (id: string, action: 'keep' | 'drop') => {
    const r = await triageIdea(workspace, id, { action });
    if (!r.ok) return say(r.error);
    setIdeas((l) => (l ? l.filter((i) => i.id !== id) : l));
    void ctx?.refresh();
  };
  const unstash = async (a: DeskArea) => {
    setDrawer(false);
    const r = await unstashArea(workspace, a.id);
    if (!r.ok) return say(r.error);
    await ctx?.refresh();
    zoomToArea(a.id, 'click');
  };
  // ---- the Drawer as a start menu: folders, a fly-out by date, search ----
  const [drawerQuery, setDrawerQuery] = useState('');
  const [flyout, setFlyout] = useState<string | null>(null);
  /** The bottom field captures an idea instead of searching (＋ Capture an idea). */
  const [capturing, setCapturing] = useState(false);
  /** The capture's text came from the mic (§5.3): it goes to Ideas tagged `input: 'voice'`. */
  const [captureVoice, setCaptureVoice] = useState(false);
  const drawerFieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (drawer) return;
    setDrawerQuery('');
    setFlyout(null);
    setCapturing(false);
  }, [drawer]);
  useEffect(() => {
    if (!capturing) setCaptureVoice(false);
  }, [capturing]);
  const captureIdea = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const r = await postIdea(workspace, text, { surface: 'lee' }, captureVoice ? 'voice' : undefined);
    if (!r.ok) return say(r.error);
    setDrawerQuery('');
    setCapturing(false);
    await loadIdeas();
    void ctx?.refresh();
    setFlyout(IDEAS_DRAWER);
    say('Captured to Ideas');
  };
  const folders = useMemo(() => (desk ? drawerFolders(desk, ideas ?? []) : []), [desk, ideas]);
  const found = useMemo(() => searchDrawer(folders, drawerQuery), [folders, drawerQuery]);
  const openFolder = folders.find((f) => f.id === flyout) ?? null;
  const drawerRow = (e: DrawerEntry) => {
    if (e.kind === 'area') {
      const a = desk?.areas.find((x) => x.id === e.id);
      if (!a) return null;
      return (
        <button key={e.id} className="deep-pop-row desk-drawer-row" role="menuitem" data-drawer-row="" onClick={() => void unstash(a)} title="Unstash it onto the Desk">
          <span className="desk-drawer-text">{e.text}</span>
          <span className="deep-muted">{e.meta}</span>
          <span className="desk-idea-actions" onClick={(ev) => ev.stopPropagation()}>
            <IconAction icon="trash" label="Delete…" tone="danger" onClick={() => askDeleteArea(a)} />
          </span>
        </button>
      );
    }
    return (
      <div
        key={e.id}
        className="deep-pop-row desk-drawer-row desk-idea"
        role="menuitem"
        tabIndex={0}
        data-drawer-row=""
        draggable
        onDragStart={(ev) => {
          ev.dataTransfer.setData(IDEA_MIME, e.id);
          ev.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => void ideaPage(e.id)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            void ideaPage(e.id);
          }
        }}
        title="Start a Page from it, or drag it onto an Area"
      >
        <span className="desk-drawer-text">{e.text}</span>
        {e.meta && <span className="deep-muted">{e.meta}</span>}
        <span className="desk-idea-actions" onClick={(ev) => ev.stopPropagation()}>
          <IconAction icon="check" label="Keep" onClick={() => void triage(e.id, 'keep')} />
          <IconAction icon="trash" label="Drop" onClick={() => void triage(e.id, 'drop')} />
        </span>
      </div>
    );
  };
  /** ↑↓ through the rows, → into a folder's fly-out, ← back to the folder, Enter from search opens the first match. */
  const onDrawerKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const pop = e.currentTarget;
    const target = e.target as HTMLElement;
    const inFly = !!target.closest('.desk-drawer-flyout');
    const rows = (scope: string) => Array.from(pop.querySelectorAll<HTMLElement>(`${scope} [data-drawer-row]`));
    const list = rows(inFly ? '.desk-drawer-flyout' : '.desk-drawer-menu');
    const i = list.indexOf(target);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      const next = i < 0 ? (e.key === 'ArrowUp' ? list.length - 1 : 0) : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next].focus();
    } else if (e.key === 'ArrowRight' && target.dataset.folder) {
      e.preventDefault();
      setFlyout(target.dataset.folder);
      requestAnimationFrame(() => rows('.desk-drawer-flyout')[0]?.focus());
    } else if (e.key === 'ArrowLeft' && inFly) {
      e.preventDefault();
      pop.querySelector<HTMLElement>(`[data-folder="${flyout}"]`)?.focus();
    } else if (e.key === 'Enter' && target.classList.contains('desk-drawer-search')) {
      e.preventDefault();
      pop.querySelector<HTMLElement>('.desk-drawer-body [data-drawer-row]')?.click();
    }
  };

  // ---- delete (confirmed; not undoable) ----
  const [confirm, setConfirm] = useState<{ kind: 'area'; area: DeskArea; cards: number } | { kind: 'page'; card: DeskCard } | null>(null);
  const [cardMenu, setCardMenu] = useState<{ card: DeskCard; x: number; y: number } | null>(null);
  const askDeleteArea = (a: DeskArea) => {
    setMenuFor(null);
    setDrawer(false);
    setConfirm({ kind: 'area', area: a, cards: desk ? cardsIn(desk, a.id).length : 0 });
  };
  const doDelete = async () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.kind === 'area') {
      const r = await deleteArea(workspace, c.area.id, true);
      if (!r.ok) return say(r.error);
      if (nav.area_id === c.area.id) zoomOut('overview', 'click');
      say(`Deleted: ${c.area.name}`);
    } else {
      const r = await deleteDeskPage(workspace, c.card.id, true);
      if (!r.ok) return say(r.error);
      say(`Deleted: ${c.card.title || 'Untitled'}`);
    }
    void ctx?.refresh();
  };

  const onAreaDrop = (e: React.DragEvent, area: DeskArea) => {
    const id = e.dataTransfer.getData(IDEA_MIME);
    if (!id) return;
    e.preventDefault();
    const at = screenToDesk(cam, localPoint(e.clientX, e.clientY));
    void ideaPage(id, { area, rel: { x: at.x - area.x, y: at.y - area.y } });
  };

  // ---- Esc: the innermost thing, then back to Cursor, then from an Area to the overview ----
  // ---- V, M, D pick a tool; Delete deletes the selected line; ⌘Z undoes a line ----
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (document.querySelector('.deep-sheet-scrim')) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    const typing = isTyping(t);
    if (e.key === 'Escape') {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (drag.current) {
        e.preventDefault();
        return cancelGesture();
      }
      const open: EscLayer[] = [];
      if (typing) open.push('input');
      if (strokeMenu) open.push('popover');
      if (selected) open.push('selection');
      if (preview) open.push('preview');
      if (drawer || menuFor || confirm || cardMenu) open.push('drawer');
      const step = deskEscapeStep(open, zoom === 'card' ? 'overview' : zoom, tool);
      if (step.kind === 'none') return;
      e.preventDefault();
      if (step.kind === 'tool') pickTool('cursor');
      else if (step.kind === 'zoom') zoomOut('overview', 'key');
      else if (step.layer === 'input') {
        setNewArea(null);
        setRenaming(null);
        t?.blur();
      } else if (step.layer === 'popover') setStrokeMenu(null);
      else if (step.layer === 'selection') setSelected(null);
      else if (step.layer === 'preview') setPreview(null);
      else {
        setDrawer(false);
        setMenuFor(null);
        setConfirm(null);
        setCardMenu(null);
      }
      return;
    }
    // The rest only when the Desk has focus and nothing is being typed into.
    const active = document.activeElement;
    if (typing || confirm || (active && active !== document.body && !rootRef.current?.contains(active))) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      if (!undoStack.current.length) return;
      e.preventDefault();
      void undo();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = desk?.strokes?.find((x) => x.id === selected);
      if (!s) return;
      e.preventDefault();
      void removeStroke(s, true);
      return;
    }
    const next = toolForKey(e, typing);
    if (next && !e.shiftKey) {
      e.preventDefault();
      pickTool(next);
    }
  };
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  // Keys land somewhere when the Desk shows (not on a hidden Page).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
  }, [visible]);

  const woken = wokenItem(copilot.snapshot);
  const counts = desk ? drawerCounts(desk) : { ideas: 0, stashed: 0 };
  const areaInView = zoom !== 'overview' ? onDesk.find((a) => a.id === nav.area_id) ?? null : null;
  const goalsCard = desk?.goals_card_id ? desk.cards.find((c) => c.id === desk.goals_card_id) ?? null : null;
  const strokes = desk?.strokes ?? [];
  const deskStrokes = strokes.filter((s) => !s.area_id);
  const strokeMenuAt = (s: DeskStroke, e: React.MouseEvent) => {
    hoverOut();
    setMenuFor(null);
    setCardMenu(null);
    setSelected(s.id);
    const p = localPoint(e.clientX, e.clientY);
    setStrokeMenu({ stroke: s, x: p.x, y: p.y });
  };

  // GOALS.md's goals, for the pinned Goals card (the Goals Page may not exist yet).
  const [goals, setGoals] = useState<Array<{ id: string; title: string }>>([]);
  useEffect(() => {
    if (!visible || !workspace) return;
    let cancelled = false;
    void fetchGoalsStatus(workspace).then((r) => {
      if (!cancelled && r.ok) setGoals([...r.data.goals].sort((a, b) => a.priority - b.priority).map((g) => ({ id: g.id, title: g.title })));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, workspace]);

  return (
    <div ref={rootRef} className={`desk${zoom === 'card' ? ' is-behind' : ''}`} tabIndex={-1} aria-hidden={!visible}>
      <header className="deep-header desk-header">
        <button className="deep-quiet desk-crumb" onClick={() => zoomOut('overview', 'click')} title="The whole Desk (Esc)" aria-current={zoom === 'overview' ? 'page' : undefined}>
          Desk
        </button>
        {areaInView && (
          <>
            <span className="desk-crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="desk-crumb-area">{areaInView.name}</span>
          </>
        )}
        <span className="deep-spacer" />
        {flash && <span className="deep-flash is-ok">{flash}</span>}
        {woken && (
          <button className="deep-wake" onClick={() => onHop('cockpit')} title="You asked to be woken for this. Opens the Cockpit">
            <span className="deep-wake-dot" aria-label="Needs you" />
            {woken.title}
          </button>
        )}
        <span className="deep-window-actions">
          <IconAction icon="minimize" label="Back to Cockpit" kbd="⇧⌘0" onClick={() => onHop('cockpit')} />
          <IconAction icon="close" label="End session…" onClick={() => cockpitModeStore.requestEndSession()} />
        </span>
      </header>

      {status === 'old' && <div className="desk-note">Hester is older than this Lee. Reinstall it to use the Desk.</div>}
      {status === 'offline' && <div className="desk-note">Hester is offline. The Desk comes back when it does; your last card still opens.</div>}
      {status === 'loading' && !desk && <div className="desk-note deep-muted">Opening the Desk…</div>}

      {desk && status !== 'old' && (
        <div
          ref={viewRef}
          className={`desk-viewport is-tool-${tool}`}
          style={{ cursor: toolCursor(tool, !!lift) }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelGesture}
        >
          <div
            className={`desk-world${own ? '' : ' is-fitting'}`}
            style={{ transform: cameraTransform(cam), ['--desk-scale' as string]: String(cam.scale) }}
          >
            {onDesk.map((area) => {
              const lifted = lift?.kind === 'area' && lift.id === area.id;
              const lifting = lift?.kind === 'card' && desk.cards.some((c) => c.id === lift.id && c.area_id === area.id);
              const dropHere = lift?.kind === 'card' && lift.over === area.id && !lifting;
              return (
                <section
                  key={area.id}
                  data-area-id={area.id}
                  className={`desk-area${area.id === nav.area_id && zoom !== 'overview' ? ' is-current' : ''}${lifted || lifting ? ' is-lifted' : ''}${dropHere ? ' is-drop' : ''}`}
                  style={{ left: area.x, top: area.y, width: area.w, height: area.h, transform: lifted ? `translate(${lift.dx}px, ${lift.dy}px)` : undefined }}
                  aria-label={area.name}
                  onContextMenu={(e) => {
                    if ((e.target as Element).closest('.desk-card, input, textarea')) return;
                    e.preventDefault();
                    setMenuFor(area.id);
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(IDEA_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => onAreaDrop(e, area)}
                >
                  <div className="desk-area-head" data-area-id={area.id} style={{ height: AREA_HEAD }}>
                    {renaming?.id === area.id ? (
                      <input
                        className="deep-title-input desk-area-rename"
                        autoFocus
                        value={renaming.name}
                        aria-label="Area name"
                        maxLength={120}
                        onChange={(e) => setRenaming({ id: area.id, name: e.target.value })}
                        onBlur={() => void rename()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void rename();
                          }
                        }}
                      />
                    ) : (
                      <button className="desk-area-name" onClick={() => zoomToArea(area.id)} title="Zoom to this Area">
                        {area.name}
                      </button>
                    )}
                    <span className="deep-spacer" />
                    <span className="desk-area-menu">
                      <IconAction icon="more" label="Area" expanded={menuFor === area.id} onClick={() => setMenuFor((m) => (m === area.id ? null : area.id))} />
                      {menuFor === area.id && (
                        <div className="deep-popover desk-area-pop" role="menu">
                          <button
                            className="deep-pop-row"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              setRenaming({ id: area.id, name: area.name });
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="deep-pop-row"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              startPage(area, { x: 0, y: AREA_HEAD });
                            }}
                          >
                            New Page here
                          </button>
                          <button className="deep-pop-row" role="menuitem" onClick={() => void stash(area)} title="Into the Drawer’s Stashed; unstash it from there">
                            Stash
                          </button>
                          <button className="deep-pop-row desk-danger" role="menuitem" onClick={() => askDeleteArea(area)}>
                            Delete…
                          </button>
                        </div>
                      )}
                    </span>
                  </div>

                  <StrokeLayer
                    strokes={strokes.filter((s) => s.area_id === area.id)}
                    scale={cam.scale}
                    selected={selected}
                    onMenu={strokeMenuAt}
                  />

                  {cardsIn(desk, area.id).map((c) => (
                    <DeskCardView
                      key={c.id}
                      card={c}
                      style={{
                        left: c.x,
                        top: c.y,
                        width: c.w,
                        height: c.h,
                        transform: lift?.kind === 'card' && lift.id === c.id ? `translate(${lift.dx}px, ${lift.dy}px)` : undefined,
                      }}
                      lifted={lift?.kind === 'card' && lift.id === c.id}
                      waiting={ctx?.waiting.has(c.id) ?? false}
                      onZoom={(via) => (via === 'key' || tool === 'cursor') && zoomCard(c, area, via)}
                      onHover={(el) => hoverIn(c, el)}
                      onLeave={hoverOut}
                      onMenu={(e) => {
                        hoverOut();
                        setMenuFor(null);
                        const p = localPoint(e.clientX, e.clientY);
                        setCardMenu({ card: c, x: p.x, y: p.y });
                      }}
                    />
                  ))}
                </section>
              );
            })}

            <StrokeLayer strokes={deskStrokes} scale={cam.scale} selected={selected} onMenu={strokeMenuAt} />
            {(sketch ?? pendingArea?.rect) && (
              <div className="desk-area-sketch" style={{ left: (sketch ?? pendingArea!.rect).x, top: (sketch ?? pendingArea!.rect).y, width: (sketch ?? pendingArea!.rect).w, height: (sketch ?? pendingArea!.rect).h }} aria-hidden="true" />
            )}
            {ink && ink.length > 1 && (
              <svg className="desk-strokes" aria-hidden="true">
                <path className="desk-stroke-line" d={strokePath(ink)} strokeWidth={2 / cam.scale} />
              </svg>
            )}
          </div>

          {pendingArea && (
            <input
              className="deep-title-input desk-new-area desk-drawn-name"
              autoFocus
              value={pendingArea.name}
              placeholder="Name the Area"
              aria-label="New Area name"
              maxLength={120}
              style={(() => {
                const at = deskToScreen(cam, { x: pendingArea.rect.x, y: pendingArea.rect.y });
                return { left: Math.max(8, at.x), top: Math.max(8, at.y) };
              })()}
              onChange={(e) => setPendingArea({ ...pendingArea, name: e.target.value })}
              onBlur={() => void makeDrawnArea()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void makeDrawnArea();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setPendingArea(null);
                }
              }}
            />
          )}

          {strokeMenu && (
            <div className="deep-popover desk-card-menu" role="menu" style={{ left: strokeMenu.x, top: strokeMenu.y }}>
              <button className="deep-pop-row desk-danger" role="menuitem" onClick={() => void removeStroke(strokeMenu.stroke, true)} title="⌘Z brings it back">
                Delete line
              </button>
            </div>
          )}

          <GoalsPin
            workspace={workspace}
            card={goalsCard}
            goals={goals}
            onZoom={() => goalsCard && zoomCard(goalsCard, areaInView, 'click')}
            onHover={(el) => goalsCard && hoverIn(goalsCard, el)}
            onLeave={hoverOut}
          />

          {cardMenu && (
            <div className="deep-popover desk-card-menu" role="menu" style={{ left: cardMenu.x, top: cardMenu.y }}>
              <button
                className="deep-pop-row"
                role="menuitem"
                onClick={() => {
                  const c = cardMenu.card;
                  setCardMenu(null);
                  zoomCard(c, onDesk.find((a) => a.id === c.area_id) ?? null, 'click');
                }}
              >
                Open
              </button>
              <button
                className="deep-pop-row desk-danger"
                role="menuitem"
                onClick={() => {
                  const c = cardMenu.card;
                  setCardMenu(null);
                  setConfirm({ kind: 'page', card: c });
                }}
              >
                Delete Page…
              </button>
            </div>
          )}

          {preview && (
            <div className="desk-preview" style={{ left: preview.x, top: preview.y }} role="tooltip">
              <div className="desk-preview-title">{preview.card.title || 'Untitled'}</div>
              {preview.card.summary.excerpt.trim() ? (
                <div className="desk-preview-body">
                  <AgentMarkdown text={preview.card.summary.excerpt} />
                </div>
              ) : (
                <div className="deep-muted">Nothing written yet.</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* The taskbar: the Drawer at the left (opening upward), the tools and New docked in the middle. */}
      {desk && status !== 'old' && (
        <footer className="desk-drawers desk-taskbar">
          <span className="desk-drawer-anchor">
            <button className={`desk-drawer-btn${drawer ? ' is-open' : ''}`} onClick={() => setDrawer((d) => !d)} aria-expanded={drawer} aria-haspopup="menu">
              Drawer {counts.ideas + counts.stashed > 0 && <span className="deep-muted">{counts.ideas + counts.stashed}</span>}
            </button>
            {drawer && desk && (
              // A start menu: folders fly out to the right, grouped by date; search sits by the button.
              <div className="desk-drawer-pop" onKeyDown={onDrawerKey}>
                <div className="deep-popover desk-drawer-menu" role="menu" aria-label="Drawer">
                  <div className="desk-drawer-body">
                    {!capturing && !drawerQuery.trim() && (
                      <button
                        className="deep-pop-row desk-drawer-row desk-drawer-capture"
                        role="menuitem"
                        data-drawer-row=""
                        onMouseEnter={() => setFlyout(null)}
                        onClick={() => {
                          setCapturing(true);
                          setFlyout(null);
                          requestAnimationFrame(() => (document.querySelector('.desk-drawer-search') as HTMLInputElement | null)?.focus());
                        }}
                      >
                        <span className="desk-drawer-text">＋ Capture an idea</span>
                      </button>
                    )}
                    {capturing ? (
                      <div className="desk-drawer-empty deep-muted">Type the idea below; Enter keeps it in Ideas, Esc goes back.</div>
                    ) : drawerQuery.trim() ? (
                      found.length === 0 ? (
                        <div className="desk-drawer-empty deep-muted">Nothing in the Drawer matches “{drawerQuery.trim()}”.</div>
                      ) : (
                        found.map((f) => (
                          <React.Fragment key={f.id}>
                            <div className="desk-drawer-group">{f.name}</div>
                            {f.entries.map(drawerRow)}
                          </React.Fragment>
                        ))
                      )
                    ) : null}
                    {!capturing && drawerQuery.trim() && (
                      <button className="deep-pop-row desk-drawer-row desk-drawer-capture" role="menuitem" data-drawer-row="" onClick={() => void captureIdea(drawerQuery)}>
                        <span className="desk-drawer-text">＋ Capture “{drawerQuery.trim()}” as an idea</span>
                      </button>
                    )}
                    {!capturing &&
                      !drawerQuery.trim() &&
                      folders.map((f) => (
                        <button
                          key={f.id}
                          className={`deep-pop-row desk-drawer-row desk-drawer-folder${flyout === f.id ? ' is-open' : ''}`}
                          role="menuitem"
                          aria-haspopup="menu"
                          aria-expanded={flyout === f.id}
                          data-drawer-row=""
                          data-folder={f.id}
                          onMouseEnter={() => setFlyout(f.id)}
                          onFocus={() => setFlyout(f.id)}
                          onClick={() => setFlyout(f.id)}
                        >
                          <span className="desk-drawer-text">{f.name}</span>
                          <span className="deep-muted">{f.id === IDEAS_DRAWER && ideas == null ? '…' : f.entries.length}</span>
                          <span className="desk-drawer-chevron" aria-hidden="true">›</span>
                        </button>
                      ))}
                  </div>
                  <div className="desk-drawer-field">
                    <input
                      ref={drawerFieldRef}
                      className="desk-drawer-search"
                      autoFocus
                      value={drawerQuery}
                      placeholder={capturing ? 'Capture an idea…' : 'Search the Drawer'}
                      aria-label={capturing ? 'Capture an idea' : 'Search the Drawer'}
                      onChange={(e) => {
                        setDrawerQuery(e.target.value);
                        setFlyout(null);
                      }}
                      onKeyDown={(e) => {
                        if (capturing && e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          void captureIdea(drawerQuery);
                          return;
                        }
                        if (e.key !== 'Escape') return;
                        // One Esc steps back: out of capturing, else clears the query, else closes the Drawer.
                        e.preventDefault();
                        e.stopPropagation();
                        if (capturing) {
                          setCapturing(false);
                          setDrawerQuery('');
                        } else if (drawerQuery) setDrawerQuery('');
                        else setDrawer(false);
                      }}
                    />
                    {capturing && (
                      <MicButton
                        workspace={workspace}
                        purpose="capture"
                        value={drawerQuery}
                        onChange={(t) => setDrawerQuery(t)}
                        onVoice={() => setCaptureVoice(true)}
                        fieldRef={drawerFieldRef}
                      />
                    )}
                  </div>
                </div>
                {!drawerQuery.trim() && openFolder && (
                  <div className="deep-popover desk-drawer-flyout" role="menu" aria-label={openFolder.name}>
                    {openFolder.entries.length === 0 && (
                      <div className="desk-drawer-empty deep-muted">
                        {openFolder.id === IDEAS_DRAWER
                          ? ideas == null
                            ? 'Opening…'
                            : 'No ideas waiting. Captures from the phone and the T-Deck land here.'
                          : 'Nothing stashed. An Area’s ⋯ has Stash.'}
                      </div>
                    )}
                    {byDate(openFolder.entries, new Date()).map((g) => (
                      <React.Fragment key={g.bucket}>
                        <div className="desk-drawer-group">{g.label}</div>
                        {g.entries.map(drawerRow)}
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            )}
          </span>
          <span className="desk-taskbar-mid" role="toolbar" aria-label="Desk tools">
            {DESK_TOOLS.map((t) => (
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
            {newArea != null ? (
              <input
                className="deep-title-input desk-new-area"
                autoFocus
                value={newArea}
                placeholder="Name the Area"
                aria-label="New Area name"
                maxLength={120}
                onChange={(e) => setNewArea(e.target.value)}
                onBlur={() => void makeArea()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void makeArea();
                  }
                }}
              />
            ) : (
              <IconAction icon="plus" label="New Area" onClick={() => setNewArea('')} disabled={status !== 'ok'} />
            )}
          </span>
          <span className="deep-muted desk-hint desk-taskbar-right">{TOOL_HINT[tool]}</span>
        </footer>
      )}

      {confirm && (
        <div className="deep-popover desk-confirm" role="alertdialog" aria-label="Delete">
          <div className="desk-confirm-text">
            {confirm.kind === 'area'
              ? `Delete ${confirm.area.name}${confirm.cards ? ` and its ${confirm.cards} ${confirm.cards === 1 ? 'card' : 'cards'}` : ''}?`
              : `Delete ${confirm.card.title || 'Untitled'}?`}
          </div>
          <div className="deep-muted">This can’t be undone. Stash keeps it instead.</div>
          <div className="desk-confirm-actions">
            <button className="deep-quiet" onClick={() => setConfirm(null)} autoFocus>
              Cancel
            </button>
            <button className="deep-quiet desk-danger" onClick={() => void doDelete()}>
              Delete
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// A card, and the Goals corner
// ---------------------------------------------------------------------------

function DeskCardView({
  card,
  style,
  lifted,
  waiting,
  onZoom,
  onHover,
  onLeave,
  onMenu,
}: {
  card: DeskCard;
  style: React.CSSProperties;
  /** Being dragged in Move. */
  lifted: boolean;
  waiting: boolean;
  onZoom: (via: 'click' | 'key') => void;
  onHover: (el: HTMLElement) => void;
  onLeave: () => void;
  onMenu: (e: React.MouseEvent) => void;
}): JSX.Element {
  const line = cardCountLine(card.summary);
  return (
    <div
      className={`desk-card${lifted ? ' is-lifted' : ''}`}
      data-card-id={card.id}
      style={style}
      tabIndex={0}
      role="button"
      aria-label={`${card.title || 'Untitled'}${waiting ? ', a hand-off is waiting on you' : ''}`}
      onDoubleClick={() => onZoom('click')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onZoom('key');
        }
      }}
      onMouseEnter={(e) => onHover(e.currentTarget)}
      onMouseLeave={onLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e);
      }}
    >
      <div className="desk-card-title">{card.title || 'Untitled'}</div>
      {line && <div className="desk-card-count">{line}</div>}
      {waiting && <span className="desk-card-dot" aria-hidden="true" />}
      <span className="desk-card-zoom">
        <IconAction icon="maximize" label="Zoom in" kbd="↵" onClick={() => onZoom('click')} />
      </span>
    </div>
  );
}

/**
 * Lines you drew, in one quiet colour at the same width on screen at any
 * zoom (`scale` divides it back out). Points are relative to the layer's
 * parent: an Area, or the Desk. A wider invisible path picks a line in
 * Cursor; Move and Draw turn that off (desk.css).
 */
function StrokeLayer({
  strokes,
  scale,
  selected,
  onMenu,
}: {
  strokes: readonly DeskStroke[];
  scale: number;
  selected: string | null;
  onMenu: (s: DeskStroke, e: React.MouseEvent) => void;
}): JSX.Element | null {
  if (!strokes.length) return null;
  return (
    <svg className="desk-strokes" aria-hidden="true">
      {strokes.map((s) => {
        const d = strokePath(s.points.map(([x, y]) => ({ x, y })));
        return (
          <g
            key={s.id}
            className={`desk-stroke${selected === s.id ? ' is-selected' : ''}`}
            data-stroke-id={s.id}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(s, e);
            }}
          >
            <path className="desk-stroke-hit" d={d} strokeWidth={(s.width + 2 * STROKE_HIT_PX) / scale} />
            <path className="desk-stroke-line" d={d} strokeWidth={s.width / scale} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The Goals card, pinned once to the Desk's corner whatever the zoom (one
 * card, not a copy per Area): GOALS.md's goals, else the Goals Page's first
 * line, else the question that starts it. Zooming it opens the Goals Page.
 */
function GoalsPin({
  workspace,
  card,
  goals,
  onZoom,
  onHover,
  onLeave,
}: {
  workspace: string;
  card: DeskCard | null;
  goals: Array<{ id: string; title: string }>;
  onZoom: () => void;
  onHover: (el: HTMLElement) => void;
  onLeave: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  const open = () => (card ? onZoom() : void openDesk(null, workspace, { kind: 'goals' }));
  const first = card ? card.summary.excerpt.split('\n').find((l) => l.trim() && !/^\s*#/.test(l)) ?? '' : '';
  if (goals.length || first) {
    return (
      <div
        className="desk-goals"
        tabIndex={0}
        role="button"
        aria-label="Goals"
        title="Open the Goals Page"
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            open();
          }
        }}
        onMouseEnter={(e) => card && onHover(e.currentTarget)}
        onMouseLeave={onLeave}
      >
        <div className="desk-goals-label">Goals</div>
        {goals.length ? (
          <ol className="desk-goals-list">
            {goals.slice(0, GOALS_SHOWN).map((g) => (
              <li key={g.id} className="desk-goals-line">
                <span className="desk-goals-id">{g.id}</span> {g.title}
              </li>
            ))}
            {goals.length > GOALS_SHOWN && <li className="deep-muted">{goals.length - GOALS_SHOWN} more</li>}
          </ol>
        ) : (
          <div className="desk-goals-line">{first.trim()}</div>
        )}
      </div>
    );
  }
  return (
    <div className="desk-goals is-empty">
      <button className="desk-goals-label" onClick={open} title="Open the Goals Page">
        What is this project for?
      </button>
      <input
        className="desk-goals-input"
        value={typed}
        placeholder="Start typing…"
        aria-label="What is this project for?"
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && typed.trim()) {
            e.preventDefault();
            const line = typed.trim();
            setTyped('');
            void openDesk(null, workspace, { kind: 'goals', first_line: line });
          }
        }}
      />
    </div>
  );
}
