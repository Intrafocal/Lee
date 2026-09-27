/**
 * DeskSurface - the Desk below a zoomed card (docs/16-Desk.md §2, §3; D2
 * contract §7.2): the overview (every Area on the Desk), an Area (it fills
 * the view), the Goals card in every Area's corner, and the Drawers.
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
 * - The Goals card sits in every Area's top-right corner; with none yet it
 *   asks "What is this project for?", and typing there creates it.
 * - Drawers are a strip along the bottom of the overview: Ideas (Someday)
 *   and Put away (Areas). Each opens a one-column panel at the side, so an
 *   idea can be dragged onto an Area.
 * - Esc: closes the innermost thing (a Drawer, the preview), then from an
 *   Area goes to the overview. From a zoomed card it's DeepHost's.
 * - No `next` button anywhere here: the Desk is a place, not a flow.
 * - A Hester without the Desk (404) gets one quiet line asking for a
 *   reinstall and nothing else (§10).
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DeskArea, DeskCard } from '../../../shared/desk';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import type { LeeMode } from '../../../shared/cockpit';
import { cockpitModeStore, openDesk, useCockpitModeState, zoomIntoCard, zoomOut, zoomToArea } from '../cockpit/cockpitMode';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { Btn, IconAction } from '../cockpit/ui';
import { listSomeday, triageSomeday, type SomedayItem } from '../../lib/hesterCockpit';
import { createArea, ideaToPage, patchArea, putAwayArea, takeOutArea } from '../../lib/hesterDesk';
import { newDraft } from '../../lib/hesterDeep';
import { untitledTitle, wokenItem } from '../../lib/deepModel';
import {
  AREA_HEAD,
  IDENTITY,
  areaAt,
  areasOnDesk,
  cameraTransform,
  cardCountLine,
  cardsIn,
  drawerCounts,
  escapeStep,
  fitRect,
  focusRect,
  goalsCorner,
  isEmptySpot,
  panBy,
  placeNewCard,
  putAwayAreas,
  screenToDesk,
  zoomAt,
  type Camera,
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
const IDEA_MIME = 'application/x-lee-idea';
type Drawer = 'ideas' | 'put-away';

export function DeskSurface({ workspace, visible, copilot, onHop }: DeskSurfaceProps): JSX.Element {
  const ctx = useDeskContext();
  const desk = ctx?.desk ?? null;
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

  // A drag on bare Desk pans; a click (no drag) on an empty spot starts a Page.
  const drag = useRef<{ x: number; y: number; cam: Camera; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('.desk-card, .desk-goals, button, input, textarea, .desk-area-menu')) return;
    drag.current = { x: e.clientX, y: e.clientY, cam, moved: false, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setOwn(panBy(d.cam, dx, dy));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || d.moved) return;
    onBareClick(localPoint(e.clientX, e.clientY));
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

  // ---- Areas: new, rename, put away ----
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
  const putAway = async (a: DeskArea) => {
    setMenuFor(null);
    const r = await putAwayArea(workspace, a.id);
    if (!r.ok) return say(r.error);
    if (nav.area_id === a.id) zoomOut('overview', 'click');
    say(`Put away: ${a.name}`);
    void ctx?.refresh();
  };

  // ---- Drawers ----
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [ideas, setIdeas] = useState<SomedayItem[] | null>(null);
  const loadIdeas = useCallback(async () => {
    const r = await listSomeday(workspace, 'open');
    setIdeas(r.ok && Array.isArray(r.data) ? r.data : []);
  }, [workspace]);
  useEffect(() => {
    if (drawer === 'ideas') void loadIdeas();
  }, [drawer, loadIdeas]);
  const ideaPage = async (id: string, where?: { area: DeskArea; rel: Point }) => {
    const at = where && desk ? placeNewCard(where.area, cardsIn(desk, where.area.id), where.rel) : null;
    const r = await ideaToPage(workspace, id, where && at ? { area_id: where.area.id, x: at.x, y: at.y } : {});
    if (!r.ok) return say(r.status === 409 ? 'That idea isn’t open any more' : r.error);
    setIdeas((l) => (l ? l.filter((i) => i.id !== id) : l));
    await ctx?.refresh();
    setDrawer(null);
    void zoomIntoCard({ card_id: r.data.card.id, title: r.data.card.title, area_id: r.data.area.id }, 'click');
  };
  const triage = async (id: string, action: 'keep' | 'drop') => {
    const r = await triageSomeday(workspace, id, { action });
    if (!r.ok) return say(r.error);
    setIdeas((l) => (l ? l.filter((i) => i.id !== id) : l));
    void ctx?.refresh();
  };
  const takeOut = async (a: DeskArea) => {
    const r = await takeOutArea(workspace, a.id);
    if (!r.ok) return say(r.error);
    await ctx?.refresh();
    zoomToArea(a.id, 'click');
  };
  const onAreaDrop = (e: React.DragEvent, area: DeskArea) => {
    const id = e.dataTransfer.getData(IDEA_MIME);
    if (!id) return;
    e.preventDefault();
    const at = screenToDesk(cam, localPoint(e.clientX, e.clientY));
    void ideaPage(id, { area, rel: { x: at.x - area.x, y: at.y - area.y } });
  };

  // ---- Esc: the innermost thing, then from an Area to the overview ----
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (document.querySelector('.deep-sheet-scrim')) return;
      const open: EscLayer[] = [];
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) open.push('input');
      if (preview) open.push('preview');
      if (drawer || menuFor) open.push('drawer');
      const step = escapeStep(open, zoom === 'card' ? 'overview' : zoom);
      if (step.kind === 'none') return;
      e.preventDefault();
      if (step.kind === 'zoom') zoomOut('overview', 'key');
      else if (step.layer === 'input') {
        setNewArea(null);
        setRenaming(null);
        t?.blur();
      } else if (step.layer === 'preview') setPreview(null);
      else {
        setDrawer(null);
        setMenuFor(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, preview, drawer, menuFor, zoom]);

  // Keys land somewhere when the Desk shows (not on a hidden Page).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }));
  }, [visible]);

  const woken = wokenItem(copilot.snapshot);
  const counts = desk ? drawerCounts(desk) : { ideas: 0, putAway: 0 };
  const areaInView = zoom !== 'overview' ? onDesk.find((a) => a.id === nav.area_id) ?? null : null;
  const goalsCard = desk?.goals_card_id ? desk.cards.find((c) => c.id === desk.goals_card_id) ?? null : null;

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
        {status === 'ok' &&
          zoom === 'overview' &&
          (newArea != null ? (
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
            <button className="deep-quiet" onClick={() => setNewArea('')}>
              New Area
            </button>
          ))}
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
          className="desk-viewport"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
        >
          <div
            className={`desk-world${own ? '' : ' is-fitting'}`}
            style={{ transform: cameraTransform(cam), ['--desk-scale' as string]: String(cam.scale) }}
          >
            {onDesk.map((area) => {
              const g = goalsCorner(area);
              return (
                <section
                  key={area.id}
                  className={`desk-area${area.id === nav.area_id && zoom !== 'overview' ? ' is-current' : ''}`}
                  style={{ left: area.x, top: area.y, width: area.w, height: area.h }}
                  aria-label={area.name}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(IDEA_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => onAreaDrop(e, area)}
                >
                  <div className="desk-area-head" style={{ height: AREA_HEAD }}>
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
                          <button className="deep-pop-row" role="menuitem" onClick={() => void putAway(area)}>
                            Put away
                          </button>
                        </div>
                      )}
                    </span>
                  </div>

                  {cardsIn(desk, area.id).map((c) => (
                    <DeskCardView
                      key={c.id}
                      card={c}
                      style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
                      waiting={ctx?.waiting.has(c.id) ?? false}
                      onZoom={(via) => zoomCard(c, area, via)}
                      onHover={(el) => hoverIn(c, el)}
                      onLeave={hoverOut}
                    />
                  ))}

                  <GoalsCorner
                    workspace={workspace}
                    card={goalsCard}
                    style={{ left: g.x, top: g.y, width: g.w, height: g.h }}
                    onZoom={() => goalsCard && zoomCard(goalsCard, area, 'click')}
                    onHover={(el) => goalsCard && hoverIn(goalsCard, el)}
                    onLeave={hoverOut}
                  />
                </section>
              );
            })}
          </div>

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

      {desk && status !== 'old' && zoom === 'overview' && (
        <footer className="desk-drawers" aria-label="Drawers">
          <button className={`desk-drawer-btn${drawer === 'ideas' ? ' is-open' : ''}`} onClick={() => setDrawer((d) => (d === 'ideas' ? null : 'ideas'))} aria-expanded={drawer === 'ideas'}>
            Ideas <span className="deep-muted">{counts.ideas}</span>
          </button>
          <button className={`desk-drawer-btn${drawer === 'put-away' ? ' is-open' : ''}`} onClick={() => setDrawer((d) => (d === 'put-away' ? null : 'put-away'))} aria-expanded={drawer === 'put-away'}>
            Put away <span className="deep-muted">{counts.putAway}</span>
          </button>
          <span className="deep-spacer" />
          <span className="deep-muted desk-hint">Click an empty spot in an Area to start a Page</span>
        </footer>
      )}

      {drawer && desk && (
        <aside className="desk-drawer" aria-label={drawer === 'ideas' ? 'Ideas' : 'Put away'}>
          <header className="desk-drawer-head">
            <span>{drawer === 'ideas' ? 'Ideas' : 'Put away'}</span>
            <span className="deep-spacer" />
            <button className="deep-icon-btn" onClick={() => setDrawer(null)} aria-label="Close (Esc)" title="Close (Esc)">
              ×
            </button>
          </header>
          {drawer === 'ideas' ? (
            <div className="desk-drawer-list">
              {ideas == null && <div className="deep-muted">Opening…</div>}
              {ideas != null && ideas.length === 0 && <div className="deep-muted">No ideas waiting. Captures from the phone and the T-Deck land here.</div>}
              {ideas?.map((i) => (
                <div
                  key={i.id}
                  className="desk-idea"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(IDEA_MIME, i.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title="Drag onto an Area to start a Page there"
                >
                  <div className="desk-idea-text">{i.text}</div>
                  <div className="desk-idea-actions">
                    <Btn kind="quiet" onClick={() => void ideaPage(i.id)}>
                      Start a Page
                    </Btn>
                    <Btn kind="quiet" onClick={() => void triage(i.id, 'keep')}>
                      Keep
                    </Btn>
                    <Btn kind="quiet" onClick={() => void triage(i.id, 'drop')}>
                      Drop
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="desk-drawer-list">
              {putAwayAreas(desk).length === 0 && <div className="deep-muted">Nothing put away. An Area’s ⋯ has Put away.</div>}
              {putAwayAreas(desk).map((a) => (
                <div key={a.id} className="desk-idea">
                  <div className="desk-idea-text">{a.name}</div>
                  <div className="deep-muted">{cardsIn(desk, a.id).length} cards</div>
                  <div className="desk-idea-actions">
                    <Btn kind="quiet" onClick={() => void takeOut(a)}>
                      Take out
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
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
  waiting,
  onZoom,
  onHover,
  onLeave,
}: {
  card: DeskCard;
  style: React.CSSProperties;
  waiting: boolean;
  onZoom: (via: 'click' | 'key') => void;
  onHover: (el: HTMLElement) => void;
  onLeave: () => void;
}): JSX.Element {
  const line = cardCountLine(card.summary);
  return (
    <div
      className="desk-card"
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

/** The pinned Goals card in an Area's corner; with none yet, the question that starts it. */
function GoalsCorner({
  workspace,
  card,
  style,
  onZoom,
  onHover,
  onLeave,
}: {
  workspace: string;
  card: DeskCard | null;
  style: React.CSSProperties;
  onZoom: () => void;
  onHover: (el: HTMLElement) => void;
  onLeave: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  if (card) {
    const first = card.summary.excerpt.split('\n').find((l) => l.trim() && !/^\s*#/.test(l)) ?? '';
    return (
      <div
        className="desk-goals"
        style={style}
        tabIndex={0}
        role="button"
        aria-label="Goals"
        onClick={onZoom}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onZoom();
          }
        }}
        onMouseEnter={(e) => onHover(e.currentTarget)}
        onMouseLeave={onLeave}
      >
        <div className="desk-goals-label">Goals</div>
        {first && <div className="desk-goals-line">{first.trim()}</div>}
      </div>
    );
  }
  return (
    <div className="desk-goals is-empty" style={style}>
      <button className="desk-goals-label" onClick={() => void openDesk(null, workspace, { kind: 'goals' })} title="Open the Goals card">
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
