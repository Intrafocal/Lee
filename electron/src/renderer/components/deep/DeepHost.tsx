/**
 * DeepHost - the Deep mode overlay (Deep D1 §4.1): a portal like CockpitHost,
 * between the title bar and the status bar, shown when this window's mode is
 * 'deep' and an exploration is open. Nothing underneath unmounts.
 *
 * Leaving Deep keeps it mounted (hidden, not display:none), so scroll,
 * cursor, selection and undo history survive hops exactly (§4.4); switching
 * exploration remounts the surface.
 *
 * Header (cockpit-design §6.1): one quiet 44px line with no fill: the title
 * (click to rename inline; Enter saves, Esc cancels), the view name "Page",
 * the wake line (§2.3), then "n answers" and "n questions" as quiet buttons
 * and End session as a plain outline button. On the Goals Page it also shows
 * Draft goals. The way back (⇧⌘0 Cockpit, n waiting) is the status bar's
 * (deepStatusLine).
 * No chat panel, no feed, no toasts; a one-line status in the header is the
 * only feedback. The Page saves through PUT /page with a version check
 * (§4.3); Hester offline, it keeps writing locally and saves when Hester is
 * back. Input is counted while visible (§4.5), counts only.
 *
 * Deep next (docs/plans/2026-09-27-deep-next-contract.md §3, §5; package RB):
 * - The seam: DeepHost passes PageEditor the answers (asks and hand-offs),
 *   onAskMany (one POST /asks each, with its section), onHandOff (the Hand
 *   off sheet), onReplyHandoff (Work's reply path: the agent's attention
 *   item, else tabs.send to its pty), mentionTargets, files ([[ and the
 *   source panel), onQuote (a file reference) and, on the Goals Page, the
 *   four margin prompts.
 * - R7: while the title is still "Untitled · …", the first Ask, the first
 *   Hand off or the ritual names it from the Page (autoTitle).
 * - R8: an in-memory Page (a `draft-` id from the opener) creates its
 *   exploration on the first save with content; switching away from, or
 *   ending the session on, an Untitled empty Page deletes it (409 ignored).
 * - R12: Draft goals and Draft from README on the Goals Page.
 *
 * Desk D2 (docs/plans/2026-09-27-desk-foundation-contract.md §7; package D):
 * DeepHost renders the Desk. The overlay always holds DeskSurface (the
 * overview, an Area, the Drawers) and, over it, the card this window has, in
 * the Page editor below, unchanged: zoomed in it's full screen and editable;
 * zoomed out it stays mounted and hidden, so coming back is exact. The Page's
 * calls take a card id (hesterDeep routes `pg-` ids to /desk/pages), an
 * in-memory Page is created with POST /desk/pages where it was started, the
 * palette and events carry card_id, and the ritual lists the cards touched
 * this session. `explorationId` is unused (the store's DeepNav says which
 * card); App.tsx still passes it until the merge step.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Anchor, DeepAnswer, DeepQuestion, LeeMode } from '../../../shared/cockpit';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import { cockpitModeStore, useCockpitModeState } from '../cockpit/cockpitMode';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { IconAction } from '../cockpit/ui';
import { listTasks, workspacePath } from '../../lib/hesterCockpit';
import {
  GOALS_PROMPTS,
  HANDOFF_PROVIDERS,
  addQuestion,
  addReference,
  askDeep,
  autoTitle,
  captureIdea,
  deleteExploration,
  deskCreateBody,
  draftFromReadme,
  dropDraft,
  firstLineInsertion,
  getDraft,
  getPage,
  handoffInFlight,
  handoffKindLabel,
  handoffStateLabel,
  isDraftId,
  getPage as getPageText,
  isCardId,
  isHandoff,
  isUntitled,
  listAnswers,
  listQuestions,
  mentionTargetsFor,
  pageNearlyEmpty,
  patchAnswer,
  putPage,
  readmeInsertion,
  retryAnswer,
  sessionLists,
  stillOpenOnPage,
  takePendingFirstLine,
  type DraftPage,
  type PageDoc,
  type ReferenceCreate,
  type SessionAsk,
  type SessionHandoff,
  type StillOpen,
} from '../../lib/hesterDeep';
import {
  anchorFor,
  answerInsertion,
  answersTray,
  attributionDate,
  contextAround,
  isBareUrl,
  isPending,
  isUnread,
  lastSentence,
  locateAnchor,
  markerState,
  saveBackoffMs,
  sectionAt,
  untitledTitle,
  wokenItem,
  type Affordance,
  type AffordanceOption,
  type DeepRowAction,
} from '../../lib/deepModel';
import { canTextReply, tabSendError } from '../../lib/workModel';
import { PageEditor, type PageEditorHandle, type PageMarker, type PageSelection } from './PageEditor';
import { EndSessionSheet, type RitualQuestion } from './EndSessionSheet';
import { HandoffSheet } from './HandoffSheet';
import { GoalsDraftSheet } from './GoalsDraftSheet';
import { countLabel } from './deepView';
import {
  logDeep,
  onDeepAnswer,
  readMirror,
  rememberCursor,
  savedCursor,
  writeMirror,
  type DeepCursor,
} from './deepBridge';
import { createDeskPage, getDeskPage, patchDeskPage } from '../../lib/hesterDesk';
import { landingCursor, lineEnd, type EscLayer, escapeStep } from '../../lib/deskModel';
import type { DeskCardKind } from '../../../shared/desk';
import { promoteCard, touchedCards, zoomIntoCard, zoomOut, type DeskLand } from '../cockpit/cockpitMode';
import { DeskSurface } from '../desk/DeskSurface';
import { DeskContext, useDesk, useDeskContext } from '../desk/useDesk';
import './deep.css';
import './HandoffSheet.css';


/** Long enough to read in the panel rather than the margin: a table, many lines, or ~600+ chars. */
export function isLongAnswer(text: string): boolean {
  if (!text) return false;
  if (/^\s*\|.*\|\s*$/m.test(text)) return true;
  return text.length > 600 || text.split('\n').length > 12;
}

export interface DeepHostProps {
  workspace: string;
  visible: boolean;                 // this window's mode is 'deep'
  explorationId: string | null;
  copilot: UseCopilotResult;        // snapshot for the wake line and "N waiting"
  onHop: (to: LeeMode) => void;     // header hint and the wake line
}

const SAVE_DEBOUNCE_MS = 800;
/** Deep opened before Hester was up: how soon to ask for the Page again (doubling, capped). */
const LOAD_RETRY_MS = 2000;
const LOAD_RETRY_MAX_MS = 15000;
const ANSWER_POLL_MS = 20000;
const INPUT_FLUSH_MS = 60000;
const FLASH_MS = 6000;

export function DeepHost(props: DeepHostProps): JSX.Element | null {
  const { workspace, visible, copilot } = props;
  const mode = useCockpitModeState();
  const nav = mode.deep;
  const cardId = nav.card_id;
  const zoomed = nav.zoom === 'card' && !!cardId;
  const desk = useDesk(workspace, visible && mode.enabled);

  // The mode chip's "End session" opens the ritual: on the card this window has, else a bare sheet.
  const [endNonce, setEndNonce] = useState(0);
  const [bareSheet, setBareSheet] = useState(false);
  useEffect(
    () =>
      cockpitModeStore.onEndSessionRequest(() => {
        if (cardId) setEndNonce((n) => n + 1);
        else setBareSheet(true);
      }),
    [cardId],
  );

  // An in-memory Page that became a card keeps its surface (and undo history): real id → surface key.
  const aliases = useRef(new Map<string, string>());
  const surfaceKey = cardId ? aliases.current.get(cardId) ?? cardId : null;
  const onPromoted = useCallback(
    (key: string, realId: string, realTitle: string, areaId: string | null) => {
      aliases.current.set(realId, key);
      promoteCard(key, realId, realTitle, areaId);
      void desk.refresh();
    },
    [desk],
  );

  // ---- overlay geometry: between the title bar and the status bar ----
  const [box, setBox] = useState<{ top: number; bottom: number }>({ top: 0, bottom: 0 });
  useEffect(() => {
    if (!visible) return;
    const measure = () => {
      const t = document.querySelector('.title-bar');
      const s = document.querySelector('.status-bar');
      const top = t ? t.getBoundingClientRect().bottom : 0;
      const bottom = s ? Math.max(0, window.innerHeight - s.getBoundingClientRect().top) : 0;
      setBox((b) => (b.top === top && b.bottom === bottom ? b : { top, bottom }));
    };
    measure();
    window.addEventListener('resize', measure);
    const id = window.setTimeout(measure, 300);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(id);
    };
  }, [visible]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (el) el.inert = !visible;
  }, [visible]);

  // ---- focus trap (C3, like CockpitHost's) ----
  // With the wall gone, a tab activated under the overlay (Hester's focus_tab,
  // a create-tab, ⌘1–9) focuses a hidden terminal; keys must stay on the Desk.
  useEffect(() => {
    if (!visible) return;
    let last: HTMLElement | null = null;
    const inside = (el: EventTarget | null) => el instanceof Node && !!rootRef.current?.contains(el);
    const underneath = (el: EventTarget | null) =>
      el instanceof Element && !!el.closest('.main-content, .tab-bar') && !inside(el);
    const refocus = () => {
      const target =
        last && last.isConnected && inside(last)
          ? last
          : (rootRef.current?.querySelector('.desk-card-layer.is-zoomed .cm-content') as HTMLElement | null) ?? rootRef.current;
      target?.focus({ preventScroll: true });
    };
    const onFocusIn = (e: FocusEvent) => {
      if (inside(e.target)) {
        last = e.target as HTMLElement;
        return;
      }
      if (!underneath(e.target)) return;
      (e.target as HTMLElement).blur?.();
      refocus();
    };
    const onKey = (e: Event) => {
      if (!underneath(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keypress', onKey, true);
    window.addEventListener('paste', onKey, true);
    const active = document.activeElement;
    if (active && underneath(active)) {
      (active as HTMLElement).blur?.();
      refocus();
    }
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keypress', onKey, true);
      window.removeEventListener('paste', onKey, true);
    };
  }, [visible]);

  // ---- Esc from a zoomed card: back to the overview (decision 2), innermost thing first ----
  useEffect(() => {
    if (!visible || !zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      const root = rootRef.current;
      if (!root || !(e.target instanceof Node) || !(root.contains(e.target) || e.target === document.body)) return;
      const open = new Set<EscLayer>();
      if (document.querySelector('.deep-sheet-scrim')) open.add('sheet');
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) open.add('input');
      if (root.querySelector('.desk-card-layer .deep-popover')) open.add('popover');
      if (root.querySelector('.desk-card-layer .deep-source')) open.add('source');
      if (root.querySelector('.desk-card-layer .deep-reader')) open.add('reading');
      const step = escapeStep(open, 'card', e.defaultPrevented);
      if (step.kind !== 'zoom') return;
      e.preventDefault();
      zoomOut('overview', 'key');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, zoomed]);

  const focus = copilot.focus ?? copilot.snapshot?.focus ?? null;

  if (!workspace) return null;
  const land = mode.deskLand && mode.deskLand.card_id === cardId ? mode.deskLand : null;

  return ReactDOM.createPortal(
    <DeskContext.Provider value={desk}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className={`deep-overlay${visible ? '' : ' is-hidden'}`}
        style={{ top: box.top, bottom: box.bottom }}
        aria-hidden={!visible}
        role="region"
        aria-label="Desk"
      >
        <DeskSurface workspace={workspace} visible={visible && !zoomed} copilot={copilot} onHop={props.onHop} />
        {cardId && surfaceKey && (
          <div className={`desk-card-layer${zoomed ? ' is-zoomed' : ''}`} aria-hidden={!zoomed}>
            <DeepSurface
              key={surfaceKey}
              {...props}
              visible={visible && zoomed}
              explorationId={cardId}
              title={nav.title}
              endNonce={endNonce}
              land={land}
              areaInView={nav.area_id}
              onPromoted={(realId, t, areaId) => onPromoted(surfaceKey, realId, t, areaId)}
            />
          </div>
        )}
        {bareSheet && (
          <EndSessionSheet
            workspace={workspace}
            explorationId={null}
            prefill=""
            questions={[]}
            focus={focus}
            desk={{ touched: touchedCards().map((id) => ({ id, title: desk.titleOf(id) })), stoppedCardId: touchedCards().slice(-1)[0] ?? null }}
            onClose={() => setBareSheet(false)}
          />
        )}
      </div>
    </DeskContext.Provider>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// One exploration's surface
// ---------------------------------------------------------------------------

interface DeepSurfaceProps extends DeepHostProps {
  /** The card (a `pg-` id), or a `draft-` id for an in-memory Page. Named for D1. */
  explorationId: string;
  title: string;
  endNonce: number;
  /** A landing to carry out on this card (the cursor at the end of its stopped-at line). */
  land: DeskLand | null;
  /** The Area in view: where an in-memory Page with no place of its own is created. */
  areaInView: string | null;
  /** An in-memory Page just became a card. */
  onPromoted: (realId: string, title: string, areaId: string | null) => void;
}

type OnCard = { card_id: string; card_title: string };
interface OtherCards {
  asked: Array<SessionAsk & OnCard>;
  handedOff: Array<SessionHandoff & OnCard>;
  stillOpen: Array<StillOpen & OnCard>;
  /** Each card's Page text, for anchors. */
  texts: Record<string, string>;
}
const NO_OTHERS: OtherCards = { asked: [], handedOff: [], stillOpen: [], texts: {} };

/** The ritual's lists from the other cards touched this session (each item names its card). */
async function gatherOthers(workspace: string, ids: string[], since: string | null, titleOf: (id: string) => string): Promise<OtherCards> {
  const out: OtherCards = { asked: [], handedOff: [], stillOpen: [], texts: {} };
  await Promise.all(
    ids.map(async (cid) => {
      const [ans, pg] = await Promise.all([listAnswers(workspace, cid), getPageText(workspace, cid)]);
      const answers = ans.ok && Array.isArray(ans.data) ? ans.data : [];
      const text = pg.ok ? pg.data.text : '';
      const on = { card_id: cid, card_title: titleOf(cid) || 'Untitled' };
      out.texts[cid] = text;
      const lists = sessionLists(answers, since);
      out.asked.push(...lists.asked.map((a) => ({ ...a, ...on })));
      out.handedOff.push(...lists.handedOff.map((h) => ({ ...h, ...on })));
      if (text) out.stillOpen.push(...stillOpenOnPage(text, answers, 4).map((o) => ({ ...o, ...on })));
    }),
  );
  return out;
}

/** The id fields of a Deep event for this card (legacy explorations keep exploration_id). */
function eventIds(id: string): { card_id?: string; card_kind?: DeskCardKind; exploration_id?: string } {
  if (isCardId(id)) return { card_id: id, card_kind: 'page' };
  if (isDraftId(id)) return { card_kind: 'page' };
  return { exploration_id: id };
}

/** An Ask made while Hester was offline, waiting to be sent (§4.1 degraded). */
interface LocalAsk {
  id: string;
  question: string;
  anchor: Anchor;
  follow_up_of?: string;
  section_text?: string;
}

type SaveState = 'saved' | 'saving' | 'retrying' | 'conflict';
type Popover = 'answers' | 'questions' | null;

/** A blank in-memory Page (a remembered draft id after a restart, or a Page whose exploration was deleted). */
function blankDraft(workspace: string, title: string): DraftPage {
  return { workspace, title: title || untitledTitle(new Date()), page: '', sendTitle: true, origin: { kind: 'opener' } };
}

function DeepSurface({ workspace, visible, explorationId: propId, title, copilot, onHop, endNonce, land, areaInView, onPromoted }: DeepSurfaceProps): JSX.Element {
  const deskCtx = useDeskContext();
  const deskRef = useRef(deskCtx);
  deskRef.current = deskCtx;
  const areaRef = useRef(areaInView);
  areaRef.current = areaInView;
  const editor = useRef<PageEditorHandle | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- which exploration: a real one, or in memory until the Page has text (R8) ----
  const [draft0] = useState<DraftPage | null>(() => (isDraftId(propId) ? getDraft(propId) ?? blankDraft(workspace, title) : null));
  const draftRef = useRef<DraftPage | null>(draft0);
  const [realId, setRealId] = useState<string | null>(draft0 ? null : propId);
  const realIdRef = useRef<string | null>(realId);
  const id = realId ?? propId;
  const promotedTo = useRef<string | null>(null);
  const creating = useRef<Promise<string | null> | null>(null);
  const onPromotedRef = useRef(onPromoted);
  onPromotedRef.current = onPromoted;
  const draftKey = useRef(propId);

  // ---- the Page: load, mirror, save (§4.3) ----
  const [initial, setInitial] = useState<{ text: string; cursor: DeepCursor | null } | null>(null);
  const [offline, setOffline] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [conflict, setConflict] = useState<PageDoc | null>(null);
  const [nearlyEmpty, setNearlyEmpty] = useState(true);
  const version = useRef<string | null>(null);
  const text = useRef('');
  const lastEdit = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const attempt = useRef(0);
  const lastSent = useRef<string | null>(null);
  const conflictRef = useRef<PageDoc | null>(null);
  conflictRef.current = conflict;
  /** The Page's text came from Hester (so "empty" means empty there too). */
  const loaded = useRef(false);

  // ---- header status line (not a toast) ----
  const [flash, setFlash] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((t: string, tone: 'ok' | 'warn' = 'ok') => {
    if (!alive.current) return;
    setFlash({ text: t, tone });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // ---- title and purpose ----
  const [shownTitle, setShownTitle] = useState(title || draft0?.title || '');
  const shownTitleRef = useRef(shownTitle);
  shownTitleRef.current = shownTitle;
  const [purpose, setPurpose] = useState<'goals' | null>(draft0?.purpose ?? null);
  useEffect(() => {
    if (title) setShownTitle(title);
  }, [title]);
  useEffect(() => {
    if (!realId) return;
    let cancelled = false;
    getDeskPage(workspace, realId).then((r) => {
      if (cancelled || !r.ok) return;
      if (!shownTitleRef.current || !title) setShownTitle(r.data.title);
      setPurpose(r.data.purpose === 'goals' ? 'goals' : null);
      if (!title && r.data.title) cockpitModeStore.setDeskNav({ title: r.data.title });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, realId]);

  /** Back to an in-memory Page (its exploration is gone): the next save with content creates a new one. */
  const becomeDraft = useCallback(() => {
    draftRef.current = blankDraft(workspace, shownTitleRef.current);
    realIdRef.current = null;
    creating.current = null;
    promotedTo.current = null;
    version.current = null;
    if (alive.current) setRealId(null);
  }, [workspace]);

  /**
   * The card id, creating the card from the in-memory Page first (with the
   * Page as written now, where it was started: POST /desk/pages). Null when
   * Hester can't create it.
   */
  const ensureId = useCallback(async (): Promise<string | null> => {
    if (realIdRef.current) return realIdRef.current;
    if (creating.current) return creating.current;
    const d = draftRef.current;
    if (!d) return null;
    const run = (async (): Promise<string | null> => {
      const page = text.current;
      const at = d.purpose === 'goals' ? { area_id: null } : { ...(d.desk ?? {}), area_id: d.desk?.area_id ?? deskRef.current?.defaultArea(areaRef.current) ?? null };
      const r = await createDeskPage(workspace, deskCreateBody({ ...d, desk: at, title: shownTitleRef.current || d.title }, page));
      if (!r.ok) {
        if (!r.status) setOffline(true);
        else say(r.error, 'warn');
        return null;
      }
      const newId = r.data.card.id;
      version.current = r.data.page.version;
      lastSent.current = page;
      if (!r.data.created) {
        // The Goals card already existed (another window got there first): keep its text, then yours.
        const theirs = r.data.page.text;
        const mine = text.current.trim();
        const merged = mine && !theirs.includes(mine) ? `${theirs.replace(/\s*$/, '')}${theirs.trim() ? '\n\n' : ''}${text.current}` : theirs;
        lastSent.current = theirs;
        text.current = merged;
        editor.current?.replaceAll(merged);
      }
      draftRef.current = null;
      loaded.current = true;
      promotedTo.current = newId;
      realIdRef.current = newId;
      dropDraft(draftKey.current);
      writeMirror(workspace, newId, { text: text.current, base: version.current, dirty: text.current !== lastSent.current });
      if (alive.current) {
        setOffline(false);
        setShownTitle(r.data.card.title);
        if (r.data.card.purpose === 'goals' || d.purpose === 'goals') setPurpose('goals');
        setRealId(newId);
        if (text.current === lastSent.current) {
          setDirty(false);
          setSaveState('saved');
        } else scheduleSave(r.data.created ? SAVE_DEBOUNCE_MS : 0);
      }
      onPromotedRef.current(newId, r.data.card.title, r.data.card.area_id);
      return newId;
    })();
    creating.current = run;
    const out = await run;
    if (!out) creating.current = null;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, say]);

  useEffect(() => {
    if (promotedTo.current && promotedTo.current === id) return; // just created from this buffer
    let cancelled = false;
    const d = draftRef.current;
    if (d) {
      text.current = d.page;
      setNearlyEmpty(pageNearlyEmpty(d.page));
      setInitial({ text: d.page, cursor: null });
      if (d.page.trim()) setDirty(true); // saved (and created) on leaving, or on the first edit
      return;
    }
    const mirror = readMirror(workspace, id);
    const firstLine = takePendingFirstLine(id);
    getPage(workspace, id).then(async (r) => {
      if (cancelled) return;
      const saved = savedCursor(workspace, id);
      // Landing (§7.2): the end of the stopped-at line, else the saved cursor, else the end of the Page.
      const landing = landRef.current && landRef.current.card_id === id ? landRef.current : null;
      const landAt = (t: string): DeepCursor | null => {
        if (!landing) return saved;
        const l = landingCursor(t, landing.line, saved);
        if (l.reveal) revealOnMount.current = l.cursor.head;
        cockpitModeStore.clearDeskLand(landing.nonce);
        landDone.current = landing.nonce;
        return l.cursor;
      };
      if (r.ok) {
        version.current = r.data.version;
        loaded.current = true;
        if (mirror?.dirty && mirror.text !== r.data.text) {
          // Unsaved writing from before a crash or an offline stretch.
          text.current = mirror.text;
          setInitial({ text: mirror.text, cursor: landAt(mirror.text) });
          setDirty(true);
          if (mirror.base === r.data.version) scheduleSave(0);
          else {
            setConflict(r.data);
            setSaveState('conflict');
          }
        } else {
          // The Goals entry points' typed line goes first (unless the Page already says it).
          const ins = firstLine ? firstLineInsertion(r.data.text, firstLine) : null;
          const t = ins ? ins.insert + r.data.text : r.data.text;
          text.current = t;
          setInitial({ text: t, cursor: ins ? { anchor: ins.insert.length, head: ins.insert.length, scroll: 0 } : landAt(t) });
          if (ins) {
            setDirty(true);
            scheduleSave(0);
          } else writeMirror(workspace, id, { text: r.data.text, base: r.data.version, dirty: false });
        }
        setNearlyEmpty(pageNearlyEmpty(text.current));
      } else {
        if (r.status === 404) {
          // Deleted (an empty Untitled Page) or never made: write on an in-memory Page instead.
          const exp = await getDeskPage(workspace, id);
          if (cancelled) return;
          if (!exp.ok && exp.status === 404) {
            becomeDraft();
            text.current = mirror?.dirty ? mirror.text : '';
            setInitial({ text: text.current, cursor: null });
            if (text.current.trim()) setDirty(true);
            return;
          }
        }
        // Hester offline (or the page isn't there yet): write locally, save later.
        setOffline(true);
        version.current = mirror?.base ?? null;
        text.current = mirror?.text ?? '';
        setNearlyEmpty(pageNearlyEmpty(text.current));
        setInitial({ text: text.current, cursor: landAt(text.current) });
        if (mirror?.dirty) {
          setDirty(true);
          scheduleSave(saveBackoffMs(0));
        } else retryLoad(text.current, landing?.line ?? null, 0);
      }
    });

    /**
     * Deep opened before Hester was up: keep asking for the Page until it
     * answers (a save only retries once you've typed), then show Hester's text
     * if you haven't written since, or the conflict sheet if you have.
     */
    const retryLoad = (shown: string, line: number | null, n: number) => {
      retryTimer = setTimeout(async () => {
        if (cancelled) return;
        const r = await getPage(workspace, id);
        if (cancelled || realIdRef.current !== id) return;
        if (!r.ok) {
          if (!r.status) retryLoad(shown, line, n + 1);
          return;
        }
        version.current = r.data.version;
        loaded.current = true;
        setOffline(false);
        if (text.current === shown) {
          text.current = r.data.text;
          lastSent.current = r.data.text;
          editor.current?.replaceAll(r.data.text);
          if (line != null) editor.current?.reveal(lineEnd(r.data.text, line));
          writeMirror(workspace, id, { text: r.data.text, base: r.data.version, dirty: false });
          setNearlyEmpty(pageNearlyEmpty(r.data.text));
          setDirty(false);
          setSaveState('saved');
        } else if (shown.trim() || !r.data.text.trim()) {
          scheduleSave(0);
        } else {
          setConflict(r.data);
          setSaveState('conflict');
        }
      }, Math.min(LOAD_RETRY_MS * 2 ** n, LOAD_RETRY_MAX_MS));
    };
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, id]);

  const landRef = useRef(land);
  landRef.current = land;
  const landDone = useRef<number | null>(null);
  const revealOnMount = useRef<number | null>(null);
  useEffect(() => {
    if (!initial || revealOnMount.current == null) return;
    const at = revealOnMount.current;
    revealOnMount.current = null;
    // After the editor's own first scroll (its rAF).
    const t = window.setTimeout(() => editor.current?.reveal(Math.min(at, editor.current.getText().length)), 60);
    return () => window.clearTimeout(t);
  }, [initial]);
  useEffect(() => {
    // Landing again on this card while it's open (a hop back from the Cockpit's door).
    if (!land || !initial || landDone.current === land.nonce) return;
    landDone.current = land.nonce;
    cockpitModeStore.clearDeskLand(land.nonce);
    const ed = editor.current;
    if (!ed || land.line == null) return;
    ed.reveal(lineEnd(ed.getText(), land.line));
  }, [land, initial]);

  const save = useCallback(async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (conflictRef.current) return;
    if (!realIdRef.current) {
      // In memory: nothing is written until the Page has text (R8).
      if (!text.current.trim()) {
        setDirty(false);
        setSaveState('saved');
        return;
      }
      setSaveState('saving');
      const made = await ensureId();
      if (!made && alive.current) {
        setSaveState('retrying');
        scheduleSave(saveBackoffMs(attempt.current++));
      }
      return;
    }
    if (inFlight.current) {
      await inFlight.current;
      if (text.current === lastSent.current) return;
    }
    const sid = realIdRef.current;
    const sent = text.current;
    lastSent.current = sent;
    setSaveState('saving');
    const run = (async () => {
      const r = await putPage(workspace, sid, sent, version.current);
      if (r.ok) {
        version.current = r.version;
        attempt.current = 0;
        setOffline(false);
        if (text.current === sent) {
          setDirty(false);
          setSaveState('saved');
          writeMirror(workspace, sid, { text: sent, base: r.version, dirty: false });
        } else scheduleSave(SAVE_DEBOUNCE_MS);
      } else if (r.conflict) {
        setConflict(r.conflict);
        setSaveState('conflict');
      } else if (r.status === 404) {
        // The exploration went away under us (an empty Page deleted): make a new one from this text.
        becomeDraft();
        scheduleSave(0);
      } else {
        if (!r.status) setOffline(true);
        setSaveState('retrying');
        scheduleSave(saveBackoffMs(attempt.current++));
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      if (inFlight.current === run) inFlight.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, ensureId, becomeDraft]);

  function scheduleSave(ms: number) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveRef.current();
    }, ms);
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  const onChange = useCallback(
    (next: string, pos: number) => {
      text.current = next;
      lastEdit.current = pos;
      setDirty(true);
      setNearlyEmpty(pageNearlyEmpty(next));
      if (realIdRef.current) writeMirror(workspace, realIdRef.current, { text: next, base: version.current, dirty: true });
      if (!conflictRef.current) scheduleSave(SAVE_DEBOUNCE_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace],
  );

  const keepMine = () => {
    if (!conflict) return;
    version.current = conflict.version;
    setConflict(null);
    conflictRef.current = null;
    void save();
  };
  const loadTheirs = () => {
    if (!conflict) return;
    editor.current?.replaceAll(conflict.text);
    text.current = conflict.text;
    version.current = conflict.version;
    if (realIdRef.current) writeMirror(workspace, realIdRef.current, { text: conflict.text, base: conflict.version, dirty: false });
    setConflict(null);
    setDirty(false);
    setSaveState('saved');
  };

  /** A write is waiting: a timer, or an in-memory Page with text that hasn't been created yet. */
  const unsaved = () => !!saveTimer.current || (!realIdRef.current && !!draftRef.current && !!text.current.trim());

  // Save now when leaving Deep or this exploration; remember the cursor.
  useEffect(() => {
    if (visible) return;
    if (unsaved()) void save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, save]);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (unsaved()) void saveRef.current();
      const c = editor.current?.cursor();
      if (c && realIdRef.current) rememberCursor(workspace, realIdRef.current, c);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, id],
  );
  const onCursor = useCallback((c: DeepCursor) => {
    if (realIdRef.current) rememberCursor(workspace, realIdRef.current, c);
  }, [workspace]);
  useEffect(() => {
    // Remember the cursor now and then while writing (a restart restores it).
    if (!visible) return;
    const t = window.setInterval(() => {
      const c = editor.current?.cursor();
      if (c && realIdRef.current) rememberCursor(workspace, realIdRef.current, c);
    }, 15000);
    return () => window.clearInterval(t);
  }, [visible, workspace]);

  // ---- answers and hand-offs (§4.2, §6; R3) ----
  const [answers, setAnswers] = useState<DeepAnswer[]>([]);
  const [localAsks, setLocalAsks] = useState<LocalAsk[]>([]);
  const [openMarker, setOpenMarker] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<{ id: string; text: string } | null>(null);
  const [replying, setReplying] = useState<{ id: string; text: string; busy?: boolean } | null>(null);
  /** The answer open in the reading panel (a long answer or hand-off result). */
  const [reading, setReading] = useState<string | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const localAsksRef = useRef(localAsks);
  localAsksRef.current = localAsks;
  /** Asks and hand-offs made from this Page while it was open (the ritual's "This session"). */
  const madeHere = useRef(new Set<string>());

  const upsertAnswer = useCallback((a: DeepAnswer) => {
    madeHere.current.add(a.id);
    setAnswers((prev) => (prev.some((x) => x.id === a.id) ? prev.map((x) => (x.id === a.id ? a : x)) : [a, ...prev]));
  }, []);

  const refreshAnswers = useCallback(async () => {
    if (!realIdRef.current) return;
    const r = await listAnswers(workspace, realIdRef.current);
    if (r.ok && alive.current) setAnswers(Array.isArray(r.data) ? r.data : []);
  }, [workspace]);

  useEffect(() => {
    if (!realId) return;
    void refreshAnswers();
    return onDeepAnswer((e) => {
      if ((e.card_id ?? e.exploration_id) === realId && (!e.workspace || e.workspace === workspace)) void refreshAnswers();
    });
  }, [refreshAnswers, realId, workspace]);

  // ---- titles (R7) ----
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameTo = useCallback(
    async (next: string): Promise<void> => {
      const t = next.trim();
      if (!t || t === shownTitleRef.current) return;
      if (!realIdRef.current) {
        // In memory: the title goes with the create.
        if (draftRef.current) draftRef.current = { ...draftRef.current, title: t, sendTitle: true };
        setShownTitle(t);
        return;
      }
      const rid = realIdRef.current;
      const r = await patchDeskPage(workspace, rid, { title: t });
      if (!r.ok) return say(r.error, 'warn');
      if (!alive.current) return;
      setShownTitle(r.data.title);
      if (cockpitModeStore.getDeep().card_id === rid) cockpitModeStore.setDeskNav({ title: r.data.title });
      void deskRef.current?.refresh();
    },
    [workspace, say],
  );
  const commitRename = () => {
    const next = renaming ?? '';
    setRenaming(null);
    void renameTo(next);
  };
  /** R7: while the title is still "Untitled · …", name it from the Page; returns the title to use now. */
  const autoTitled = useRef(false);
  const maybeAutoTitle = useCallback((): string => {
    const current = shownTitleRef.current;
    if (autoTitled.current || !isUntitled(current)) return current;
    const t = autoTitle(text.current);
    if (!t) return current;
    autoTitled.current = true;
    shownTitleRef.current = t;
    void renameTo(t);
    return t;
  }, [renameTo]);

  const sendAsk = useCallback(
    async (ask: { question: string; anchor: Anchor; follow_up_of?: string; section_text?: string }, queuedId?: string): Promise<boolean> => {
      const eid = await ensureId();
      const r = eid ? await askDeep(workspace, eid, ask) : ({ ok: false, error: 'Hester offline' } as const);
      if (!alive.current) return r.ok;
      if (r.ok) {
        upsertAnswer(r.data);
        if (queuedId) setLocalAsks((l) => l.filter((x) => x.id !== queuedId));
        setOffline(false);
        return true;
      }
      if (!('status' in r) || !r.status) {
        setOffline(true);
        if (!queuedId) {
          setLocalAsks((l) => [...l, { id: `local-${Date.now().toString(36)}-${l.length}`, ...ask }]);
          say('Hester offline · queued', 'warn');
        }
      } else say(r.error, 'warn');
      return false;
    },
    [workspace, say, ensureId, upsertAnswer],
  );

  // Poll while something is pending (a missed deep:answer isn't fatal), and send queued asks.
  const pending = answers.some((a) => isPending(a) || handoffInFlight(a)) || localAsks.length > 0;
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => {
      void refreshAnswers();
      for (const q of localAsksRef.current) {
        void sendAsk(
          { question: q.question, anchor: q.anchor, ...(q.follow_up_of ? { follow_up_of: q.follow_up_of } : {}), ...(q.section_text ? { section_text: q.section_text } : {}) },
          q.id,
        );
      }
    }, ANSWER_POLL_MS);
    return () => window.clearInterval(t);
  }, [pending, refreshAnswers, sendAsk]);

  const ask = (question: string, anchor: Anchor, follow_up_of?: string, sectionText?: string) => {
    if (!follow_up_of) maybeAutoTitle();
    void sendAsk({ question, anchor, ...(follow_up_of ? { follow_up_of } : {}), ...(sectionText ? { section_text: sectionText } : {}) });
    logDeep({ type: 'deep.action', data: { action: follow_up_of ? 'follow_up' : 'ask', ...eventIds(id), chars: question.length } });
  };

  const patchLocal = (aid: string, patch: Partial<DeepAnswer>) => setAnswers((prev) => prev.map((a) => (a.id === aid ? { ...a, ...patch } : a)));

  const openCard = (aid: string, force = false) => {
    setFollowUp(null);
    setReplying(null);
    if (openMarker === aid && !force) {
      setOpenMarker(null);
      return;
    }
    setOpenMarker(aid);
    const a = answers.find((x) => x.id === aid);
    if (a && isUnread(a) && realIdRef.current) {
      patchLocal(aid, { read_at: new Date().toISOString() });
      void patchAnswer(workspace, realIdRef.current, aid, { read: true });
    }
  };

  const insertAnswer = (a: DeepAnswer) => {
    const ed = editor.current;
    if (!ed || !a.answer || !realIdRef.current) return;
    const doc = ed.getText();
    const at = locateAnchor(doc, a.anchor).pos;
    const change = answerInsertion(doc, at, a.answer, attributionDate(new Date()));
    ed.insert(change.from, change.insert);
    patchLocal(a.id, { inserted_at: new Date().toISOString() });
    void patchAnswer(workspace, realIdRef.current, a.id, { inserted: true });
    logDeep({ type: 'deep.action', data: { action: 'insert', ...eventIds(id), chars: a.answer.length } });
  };

  const keepAnswer = async (a: DeepAnswer) => {
    const rid = realIdRef.current;
    if (!a.answer || !rid) return;
    const section = a.anchor.kind === 'page' ? a.anchor.section : null;
    const r = await addReference(workspace, rid, { kind: 'quote', quote: a.answer, section, source: { kind: 'answer', ref: a.id } });
    if (!r.ok) return say(r.error, 'warn');
    patchLocal(a.id, { kept_at: new Date().toISOString() });
    void patchAnswer(workspace, rid, a.id, { kept: true });
    logDeep({ type: 'deep.action', data: { action: 'keep', ...eventIds(id), chars: a.answer.length } });
    say('Kept as a reference');
  };

  const dismissAnswer = (a: DeepAnswer) => {
    if (!realIdRef.current) return;
    patchLocal(a.id, { dismissed_at: new Date().toISOString() });
    setOpenMarker(null);
    void patchAnswer(workspace, realIdRef.current, a.id, { dismissed: true });
    logDeep({ type: 'deep.action', data: { action: 'dismiss', ...eventIds(id) } });
  };

  const retry = async (a: DeepAnswer) => {
    if (!realIdRef.current) return;
    const r = await retryAnswer(workspace, realIdRef.current, a.id);
    if (r.ok) setAnswers((prev) => prev.map((x) => (x.id === a.id ? r.data : x)));
    else say(r.error, 'warn');
  };

  // ---- hand-offs (R3) ----
  const [handoff, setHandoff] = useState<{ eid: string; title: string; sectionText: string; anchor: Anchor; provider?: string } | null>(null);
  const openHandoff = async (sectionText: string, anchor: Anchor, provider?: string) => {
    if (!sectionText.trim()) return say('Nothing to hand off: select text or write a section first', 'warn');
    const t = maybeAutoTitle();
    const eid = await ensureId();
    if (!eid) return say('Hester offline: hand-offs need Hester', 'warn');
    if (alive.current) setHandoff({ eid, title: shownTitleRef.current || t, sectionText, anchor, ...(provider ? { provider } : {}) });
  };

  /** Open a hand-off's task in Work (its detail view). */
  const openInWork = (taskId: string) => {
    onHop('cockpit');
    cockpitModeStore.setSection('work');
    cockpitModeStore.select({ kind: 'row', id: `task:${taskId}` });
  };

  /**
   * R11 / R5 Reply: through the hand-off's agent, Work's way: its open
   * attention item that takes text, else typed into its idle terminal.
   */
  const replyHandoff = async (aid: string, body: string): Promise<boolean> => {
    const typed = body.trim();
    const a = answersRef.current.find((x) => x.id === aid);
    const taskId = a?.handoff?.task_id ?? null;
    if (!typed) return false;
    if (!taskId) {
      say('That hand-off has no agent yet', 'warn');
      return false;
    }
    const tasks = await listTasks(workspace, 'open');
    const task = tasks.ok ? tasks.data.find((t) => t.id === taskId) ?? null : null;
    const pty = task?.agent?.pty_id ?? null;
    const item =
      pty != null ? (copilot.snapshot?.items ?? []).find((i) => i.state === 'open' && i.source.pty_id === pty && canTextReply(i)) ?? null : null;
    if (item && copilot.api) {
      try {
        const r = await copilot.api.reply(item.id, { action: 'text', text: typed, version: item.version });
        if (!r.success) {
          say(r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'Reply failed', 'warn');
          return false;
        }
      } catch {
        say('Reply failed', 'warn');
        return false;
      }
      say('Replied');
      return true;
    }
    if (pty == null) {
      say('That agent isn’t running. Open it in Work to resume it.', 'warn');
      return false;
    }
    const api = window.lee?.cockpit;
    if (!api) return false;
    try {
      const r = await api.tabs.send(pty, { text: typed, submit: true, purpose: 'reply' });
      if (!r.success) {
        say(tabSendError(r.error), 'warn');
        return false;
      }
    } catch {
      say('Reply failed', 'warn');
      return false;
    }
    say('Replied');
    return true;
  };

  const markers: PageMarker[] = useMemo(
    () => [
      ...answers.filter((a) => !a.dismissed_at).map((a) => ({ id: a.id, anchor: a.anchor, state: markerState(a), question: a.question })),
      ...localAsks.map((q) => ({ id: q.id, anchor: q.anchor, state: 'pending' as const, question: q.question, queued: true })),
    ],
    [answers, localAsks],
  );

  const answerActions = (a: DeepAnswer) =>
    a.answer ? (
      <>
        <button className="deep-quiet" onClick={() => insertAnswer(a)} disabled={!!a.inserted_at} title="Insert into the Page as a quote">
          {a.inserted_at ? 'Inserted' : 'Insert'}
        </button>
        <button className="deep-quiet" onClick={() => void keepAnswer(a)} disabled={!!a.kept_at} title="Keep as a reference">
          {a.kept_at ? 'Kept' : 'Keep'}
        </button>
      </>
    ) : null;

  /**
   * An answer in the margin: short ones in full; long ones (reports, tables)
   * as a clamped preview with Read, which opens the reading panel. The margin
   * is for notes, not reports.
   */
  const answerBody = (a: DeepAnswer): React.ReactNode => {
    const text = a.answer ?? '';
    if (!isLongAnswer(text)) {
      return (
        <div className="deep-card-a">
          <AgentMarkdown text={text} />
        </div>
      );
    }
    return (
      <>
        <div className="deep-card-a is-preview">
          <AgentMarkdown text={text} />
        </div>
        <button className="deep-quiet deep-read" onClick={() => setReading(a.id)}>
          Read
        </button>
      </>
    );
  };

  const renderHandoffCard = (a: DeepAnswer): React.ReactNode => {
    const h = a.handoff;
    const provider = HANDOFF_PROVIDERS.find((p) => p.id === h?.provider)?.label ?? h?.provider ?? '';
    const waiting = h?.state === 'waiting';
    return (
      <>
        <div className="deep-muted">
          {handoffKindLabel(h?.kind)}
          {provider ? ` · ${provider}` : ''} · {handoffStateLabel(h?.state)}
        </div>
        {(a.status === 'error' || h?.state === 'error') && <div className="deep-card-err">{a.error || 'The hand-off failed.'}</div>}
        {a.answer && answerBody(a)}
        <div className="deep-card-actions">
          {h?.task_id && (
            <button className="deep-quiet" onClick={() => openInWork(h.task_id as string)}>
              Open in Work
            </button>
          )}
          {waiting && h?.task_id && (
            <button className="deep-quiet" onClick={() => setReplying({ id: a.id, text: '' })}>
              Reply
            </button>
          )}
          {answerActions(a)}
          <button className="deep-quiet" onClick={() => dismissAnswer(a)}>
            Dismiss
          </button>
        </div>
        {replying?.id === a.id && (
          <input
            className="deep-ask-input"
            autoFocus
            value={replying.text}
            disabled={replying.busy}
            placeholder="Reply to the agent (sent exactly as written)…"
            onChange={(e) => setReplying({ id: a.id, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const body = replying.text;
                if (!body.trim()) return;
                setReplying({ ...replying, busy: true });
                void replyHandoff(a.id, body).then((ok) => {
                  if (!alive.current) return;
                  setReplying(ok ? null : { id: a.id, text: body });
                  if (ok) editor.current?.focus();
                });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setReplying(null);
              }
            }}
          />
        )}
        {h?.brief && (
          <details className="deep-muted">
            <summary>The brief as sent</summary>
            <div className="deep-card-a">
              <AgentMarkdown text={h.brief} />
            </div>
          </details>
        )}
      </>
    );
  };

  const renderCard = (mid: string): React.ReactNode => {
    const local = localAsks.find((q) => q.id === mid);
    if (local) {
      return (
        <div className="deep-muted">Hester offline · queued</div>
      );
    }
    const a = answers.find((x) => x.id === mid);
    if (!a) return null;
    if (isHandoff(a)) return renderHandoffCard(a);
    return (
      <>
        {(a.status === 'error' || a.status === 'interrupted') && (
          <div className="deep-card-err">
            {a.status === 'interrupted' ? 'Interrupted when Hester restarted.' : a.error || 'The ask failed.'}{' '}
            <button className="deep-link" onClick={() => void retry(a)}>
              Retry
            </button>
          </div>
        )}
        {a.status === 'done' && a.answer && (
          <>
            {answerBody(a)}
            <div className="deep-card-actions">
              {answerActions(a)}
              <button className="deep-quiet" onClick={() => setFollowUp({ id: a.id, text: '' })}>
                Follow up
              </button>
              <button className="deep-quiet" onClick={() => dismissAnswer(a)}>
                Dismiss
              </button>
            </div>
            {followUp?.id === a.id && (
              <input
                className="deep-ask-input"
                autoFocus
                value={followUp.text}
                placeholder="Follow up…"
                onChange={(e) => setFollowUp({ id: a.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const q = followUp.text.trim();
                    if (!q) return;
                    ask(q, a.anchor, a.id);
                    setFollowUp(null);
                    editor.current?.focus();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setFollowUp(null);
                  }
                }}
              />
            )}
          </>
        )}
        {a.model && <div className="deep-muted deep-card-model">{a.model.location === 'local' ? 'local' : 'cloud'} · {a.model.name}</div>}
      </>
    );
  };

  // ---- questions (§3.7) ----
  const [questions, setQuestions] = useState<DeepQuestion[]>([]);
  const [markedThisSession, setMarkedThisSession] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!realId) return;
    let cancelled = false;
    listQuestions(workspace, realId).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data)) setQuestions(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, realId]);
  const openQuestions = questions.filter((q) => q.status === 'open');

  // ---- selection actions (§5) and affordances (§7) ----
  const captureText = async (t: string, from: number, to: number) => {
    const doc = text.current;
    const eid = await ensureId();
    if (!eid) return say('Hester offline: capture needs Hester', 'warn');
    const r = await captureIdea(workspace, t, {
      surface: 'lee',
      ...(isCardId(eid) ? { card_id: eid } : { exploration_id: eid }),
      section: sectionAt(doc, from),
      context: contextAround(doc, from, to, 300),
    });
    if (r.ok) say('Captured to Ideas');
    else say(r.error, 'warn');
    logDeep({ type: 'deep.action', data: { action: 'capture', ...eventIds(eid), chars: t.length } });
  };

  const onAction = async (action: DeepRowAction, sel: PageSelection, question?: string) => {
    const doc = text.current;
    const chars = sel.text.length;
    if (action === 'capture') return captureText(sel.text, sel.from, sel.to);
    if (action === 'ask') {
      ask(question || 'Explain this.', anchorFor(doc, sel.from, sel.to));
      return;
    }
    const eid = await ensureId();
    if (!eid) return say('Hester offline', 'warn');
    if (action === 'keep') {
      const t = sel.text.trim();
      const body = isBareUrl(t)
        ? { kind: 'link' as const, url: t, section: sectionAt(doc, sel.from), source: { kind: 'page' as const } }
        : { kind: 'quote' as const, quote: sel.text, section: sectionAt(doc, sel.from), source: { kind: 'page' as const } };
      const r = await addReference(workspace, eid, body);
      say(r.ok ? 'Kept as a reference' : r.error, r.ok ? 'ok' : 'warn');
      logDeep({ type: 'deep.action', data: { action: 'keep', ...eventIds(eid), chars } });
      return;
    }
    if (action === 'explore') {
      // Desk D2 §7.2: "Explore" (the name isn't settled) makes a Page next to this card, seeded with the selection.
      const r = await createDeskPage(workspace, { from: { card_id: eid, anchor: anchorFor(doc, sel.from, sel.to) }, text: sel.text });
      say(r.ok ? `A new Page next to this one: ${r.data.card.title}` : r.error, r.ok ? 'ok' : 'warn');
      if (r.ok) void deskRef.current?.refresh();
      logDeep({ type: 'deep.action', data: { action: 'explore', ...eventIds(eid), chars } });
    }
  };

  const onAffordance = async (opt: AffordanceOption, _aff: Affordance, line: { from: number; to: number; text: string }) => {
    const doc = text.current;
    const anchor = anchorFor(doc, line.from, line.to);
    switch (opt.kind) {
      case 'ask':
        ask(opt.question, anchor);
        return;
      case 'mark_question': {
        const eid = await ensureId();
        if (!eid) return say('Hester offline', 'warn');
        const r = await addQuestion(workspace, eid, { text: opt.text.slice(0, 500), source: 'page', anchor });
        if (!r.ok) return say(r.error, 'warn');
        setQuestions((qs) => [r.data, ...qs.filter((q) => q.id !== r.data.id)]);
        setMarkedThisSession((s) => new Set(s).add(r.data.id));
        say('Marked as an open question');
        return;
      }
      case 'keep_link': {
        const eid = await ensureId();
        if (!eid) return say('Hester offline', 'warn');
        const r = await addReference(workspace, eid, {
          kind: 'link',
          url: opt.url,
          ...(opt.title ? { title: opt.title } : {}),
          section: sectionAt(doc, line.from),
          source: { kind: 'page' },
        });
        say(r.ok ? 'Kept as a reference' : r.error, r.ok ? 'ok' : 'warn');
        logDeep({ type: 'deep.action', data: { action: 'keep', ...eventIds(eid), chars: opt.url.length } });
        return;
      }
      case 'capture':
        return captureText(opt.text, line.from, line.to);
    }
  };

  const onAffordanceShown = (aff: Affordance, outcome: 'accepted' | 'ignored') =>
    logDeep({ type: 'deep.affordance', data: { pattern: aff.pattern, outcome } });

  // ---- the §3 seam: what the Page reaches through us ----
  const onAskMany = (asks: Array<{ question: string; anchor: Anchor; sectionText: string }>) => {
    for (const q of asks) if (q.question.trim()) ask(q.question.trim(), q.anchor, undefined, q.sectionText);
  };
  const onHandOff = (sel: PageSelection & { anchor: Anchor; sectionText: string }, provider?: string) =>
    void openHandoff(sel.sectionText || sel.text, sel.anchor, provider);
  const onReplyHandoff = (aid: string, body: string) => void replyHandoff(aid, body);
  // RA's margin cards: "Open in Work" for a hand-off.
  const onOpenInWork = (aid: string) => {
    const taskId = answersRef.current.find((a) => a.id === aid)?.handoff?.task_id;
    if (taskId) openInWork(taskId);
    else say('That hand-off has no task yet', 'warn');
  };
  const mentionTargets = useMemo(() => mentionTargetsFor(answers), [answers]);
  const files = useMemo(
    () => ({
      list: async (): Promise<string[]> => {
        try {
          const r = await window.lee?.cockpit?.files(workspace);
          return Array.isArray(r?.files) ? r.files : [];
        } catch {
          return [];
        }
      },
      read: async (path: string): Promise<string | null> => {
        try {
          const c: unknown = await window.lee?.fs?.readFile(workspacePath(workspace, path));
          return typeof c === 'string' ? c : null;
        } catch {
          return null;
        }
      },
    }),
    [workspace],
  );
  const onQuote = async (q: { file: string; lines: [number, number]; text: string; label: string }) => {
    const eid = await ensureId();
    if (!eid) return say('Hester offline: the reference wasn’t recorded', 'warn');
    const pos = editor.current?.cursor().head ?? 0;
    const body: ReferenceCreate = {
      kind: q.text.trim() ? 'quote' : 'link',
      ...(q.text.trim() ? { quote: q.text } : {}),
      file: q.file,
      lines: q.lines,
      ...(q.label ? { title: q.label } : {}),
      section: sectionAt(text.current, pos),
      source: { kind: 'file' },
    };
    const r = await addReference(workspace, eid, body);
    if (!r.ok) say(r.status === 400 ? `Not recorded: ${r.error}` : r.error, 'warn');
  };

  // ---- the Goals Page (R12) ----
  const isGoals = purpose === 'goals';
  const [goalsDraft, setGoalsDraft] = useState<string | null>(null);
  const [readme, setReadme] = useState<'idle' | 'busy' | 'none'>('idle');
  const draftReadme = async () => {
    if (readme !== 'idle') return;
    setReadme('busy');
    const eid = await ensureId();
    const r = eid ? await draftFromReadme(workspace, eid) : null;
    if (!alive.current) return;
    if (!r || !r.ok) {
      // 400: no README.md or CLAUDE.md here; 404: an older Hester. Either way, stop offering it.
      setReadme(r && !r.ok && (r.status === 400 || r.status === 404) ? 'none' : 'idle');
      if (r && !r.ok && r.status !== 400 && r.status !== 404) say(r.error, 'warn');
      else if (!r) say('Hester offline', 'warn');
      return;
    }
    setReadme('idle');
    const ed = editor.current;
    if (!ed || !r.data.text?.trim()) return;
    const ins = readmeInsertion(ed.getText(), r.data.text, attributionDate(new Date()));
    ed.insert(ins.from, ins.insert);
    say('Hester’s first guess is in. Rewrite it in your words.');
  };

  // ---- input counting (§4.5) and deep.view ----
  const counts = useRef({ keys: 0, clicks: 0, wheels: 0, since: Date.now() });
  const flushInput = useCallback(() => {
    const c = counts.current;
    const now = Date.now();
    if (c.keys + c.clicks + c.wheels > 0) {
      // Only ever from inside a card (§5.1): the Desk's overview doesn't count as deep work.
      logDeep({ type: 'deep.input', data: { ...eventIds(id), view: 'page', keys: c.keys, clicks: c.clicks, wheels: c.wheels, span_ms: now - c.since } });
    }
    counts.current = { keys: 0, clicks: 0, wheels: 0, since: now };
  }, [id]);
  useEffect(() => {
    if (!visible) return;
    counts.current = { keys: 0, clicks: 0, wheels: 0, since: Date.now() };
    logDeep({ type: 'deep.view', data: { ...eventIds(id), view: 'page' } });
    const t = window.setInterval(flushInput, INPUT_FLUSH_MS);
    return () => {
      window.clearInterval(t);
      flushInput();
    };
  }, [visible, id, flushInput]);

  // ---- R8: an Untitled Page left empty is deleted when it closes ----
  const deleteIfEmpty = useCallback(async (): Promise<boolean> => {
    const rid = realIdRef.current;
    if (!rid || !loaded.current || !isUntitled(shownTitleRef.current) || text.current.trim() || answersRef.current.length || localAsksRef.current.length) return false;
    const r = await deleteExploration(workspace, rid); // 409 not_empty / 404: leave it
    return r.ok;
  }, [workspace]);
  useEffect(
    () => () => {
      void deleteIfEmpty().then((gone) => {
        if (gone) void deskRef.current?.refresh();
      });
    },
    [deleteIfEmpty],
  );

  // ---- header popovers and the ritual ----
  const [popover, setPopover] = useState<Popover>(null);
  const jumpTo = (anchor: Anchor | undefined, markerId?: string) => {
    setPopover(null);
    const ed = editor.current;
    if (!ed) return;
    if (anchor) ed.reveal(locateAnchor(ed.getText(), anchor).pos);
    if (markerId) openCard(markerId, true);
    ed.focus();
  };

  const startedAt = (copilot.focus ?? copilot.snapshot?.focus)?.started_at ?? null;
  const [sheet, setSheet] = useState<{ prefill: string; questions: RitualQuestion[] } | null>(null);
  /** The ritual's lists from the other cards touched this session (Desk D2 §7.2), with their text for Ask and Hand off. */
  const [others, setOthers] = useState<OtherCards>(NO_OTHERS);
  const openSheet = useCallback(() => {
    maybeAutoTitle();
    const doc = text.current;
    const qs: RitualQuestion[] = questions
      .filter((q) => q.status === 'open' && (markedThisSession.has(q.id) || (q.source === 'page' && !!startedAt && q.at >= startedAt)))
      .map((q) => ({ id: q.id, kind: 'question' as const, text: q.text, ...(realIdRef.current ? { card_id: realIdRef.current } : {}) }));
    setPopover(null);
    setOthers(NO_OTHERS);
    setSheet({ prefill: lastSentence(doc, lastEdit.current ?? doc.length), questions: qs });
    const rest = touchedCards().filter((c) => c !== realIdRef.current);
    if (rest.length) {
      void gatherOthers(workspace, rest, startedAt, (cid) => deskRef.current?.titleOf(cid) ?? '').then((o) => {
        if (alive.current) setOthers(o);
      });
    }
  }, [questions, markedThisSession, startedAt, maybeAutoTitle, workspace]);
  const endSeen = useRef(endNonce);
  useEffect(() => {
    if (endNonce === endSeen.current) return;
    endSeen.current = endNonce;
    openSheet();
  }, [endNonce, openSheet]);

  const session = sheet
    ? (() => {
        const here = sessionLists(answers, startedAt, madeHere.current);
        return {
          asked: [...here.asked, ...others.asked],
          handedOff: [...here.handedOff, ...others.handedOff],
          stillOpen: [...stillOpenOnPage(text.current, answers), ...others.stillOpen],
        };
      })()
    : undefined;
  const stillOpenQuestion = (o: StillOpen) => (o.kind === 'question' ? o.text : 'What is still open here, and what would settle it?');
  const askStillOpen = (o: StillOpen & { card_id?: string }) => {
    const other = o.card_id && o.card_id !== realIdRef.current ? o.card_id : null;
    if (!other) {
      ask(stillOpenQuestion(o), anchorFor(text.current, o.from, o.to), undefined, o.sectionText);
      return;
    }
    // On another touched card: asked there, where the line is.
    const t = others.texts[other] ?? '';
    void askDeep(workspace, other, { question: stillOpenQuestion(o), anchor: anchorFor(t, o.from, o.to), section_text: o.sectionText }).then((r) => {
      if (!r.ok) say(r.error, 'warn');
    });
    logDeep({ type: 'deep.action', data: { action: 'ask', ...eventIds(other), chars: stillOpenQuestion(o).length } });
  };
  const handOffStillOpen = (o: StillOpen & { card_id?: string }) => {
    const other = o.card_id && o.card_id !== realIdRef.current ? o.card_id : null;
    if (!other) {
      void openHandoff(o.sectionText, anchorFor(text.current, o.from, o.to));
      return;
    }
    const t = others.texts[other] ?? '';
    setHandoff({ eid: other, title: deskRef.current?.titleOf(other) || 'Untitled', sectionText: o.sectionText, anchor: anchorFor(t, o.from, o.to) });
  };
  const ritualDesk = sheet
    ? (() => {
        const ids = touchedCards();
        const list = realIdRef.current && !ids.includes(realIdRef.current) ? [...ids, realIdRef.current] : ids;
        const titleOf = (cid: string) => (cid === realIdRef.current ? shownTitleRef.current : deskRef.current?.titleOf(cid) ?? '');
        return {
          touched: list.map((cid) => ({ id: cid, title: titleOf(cid) })),
          stoppedCardId: realIdRef.current ?? list[list.length - 1] ?? null,
          onZoom: (cid: string) => {
            if (cid === realIdRef.current) editor.current?.focus();
            else void zoomIntoCard({ card_id: cid, title: titleOf(cid) }, 'click');
          },
        };
      })()
    : undefined;

  const asks = answers.filter((a) => !isHandoff(a));
  const tray = answersTray([...asks, ...localAsks.map(() => ({ status: 'queued' as const }))]);
  const woken = wokenItem(copilot.snapshot);
  const liveAnswers = asks.filter((a) => !a.dismissed_at).length + localAsks.length;
  const liveAll = answers.filter((a) => !a.dismissed_at);
  const overlay = !!sheet || !!handoff || goalsDraft != null;

  return (
    <div
      className="deep-surface"
      onKeyDownCapture={() => {
        if (visible && !overlay) counts.current.keys++;
      }}
      onKeyDown={(e) => {
        // Esc closes a header popover before it takes you to the Desk.
        if (e.key === 'Escape' && popover && !e.defaultPrevented) {
          e.preventDefault();
          setPopover(null);
          editor.current?.focus();
        }
      }}
      onMouseDownCapture={() => {
        if (visible && !overlay) counts.current.clicks++;
      }}
      onWheelCapture={() => {
        if (visible && !overlay) counts.current.wheels++;
      }}
    >
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
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
                editor.current?.focus();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setRenaming(null);
                editor.current?.focus();
              }
            }}
          />
        ) : (
          <button className="deep-title" title="Rename" onClick={() => setRenaming(shownTitle)}>
            {shownTitle || 'Untitled'}
          </button>
        )}
        {dirty && <span className={`deep-dirty${saveState === 'retrying' ? ' is-retrying' : ''}`} title={offline ? 'Unsaved: Hester offline, saving when it’s back' : 'Unsaved changes'} />}
        <span className="deep-view-name" title="Page (⌘1)" aria-current="page">
          Page
        </span>
        <span className="deep-spacer" />
        {flash && <span className={`deep-flash is-${flash.tone}`}>{flash.text}</span>}
        {offline && !flash && <span className="deep-muted">Hester offline · writing locally</span>}
        {woken && (
          <button className="deep-wake" onClick={() => onHop('cockpit')} title="You asked to be woken for this. Opens the Cockpit">
            <span className="deep-wake-dot" aria-label="Needs you" />
            {woken.title}
          </button>
        )}
        {isGoals && (
          <button
            className="deep-quiet"
            onClick={() => setGoalsDraft(text.current)}
            disabled={!text.current.trim()}
            title="Hester drafts GOALS.md from this Page and shows the diff; nothing is written until Apply"
          >
            Draft goals
          </button>
        )}
        <div className="deep-pop-anchor">
          <button
            className="deep-quiet"
            onClick={() => setPopover((p) => (p === 'answers' ? null : 'answers'))}
            title={tray.label === 'Answers' ? 'Answers' : `Answers: ${tray.label}`}
            aria-expanded={popover === 'answers'}
          >
            {tray.pending > 0 ? <span className="deep-marker-spin" /> : tray.unread > 0 && <span className="deep-new-dot" aria-label="New answer" />}
            {countLabel(liveAnswers, 'answer')}
          </button>
          {popover === 'answers' && (
            <div className="deep-popover" role="menu">
              {liveAll.length === 0 && localAsks.length === 0 && <div className="deep-muted">No answers yet. Select text and Ask Hester (⌘.).</div>}
              {localAsks.map((q) => (
                <button key={q.id} className="deep-pop-row" onClick={() => jumpTo(q.anchor, q.id)}>
                  <span className="deep-marker is-pending" /> {q.question}
                  <span className="deep-muted"> · queued</span>
                </button>
              ))}
              {liveAll.map((a) => (
                <button key={a.id} className="deep-pop-row" onClick={() => jumpTo(a.anchor, a.id)}>
                  <span className={`deep-marker is-${markerState(a)}`} /> {a.question}
                  {isHandoff(a) && (
                    <span className="deep-muted">
                      {' '}
                      · {handoffKindLabel(a.handoff?.kind)} {handoffStateLabel(a.handoff?.state)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="deep-pop-anchor">
          <button
            className="deep-quiet"
            onClick={() => setPopover((p) => (p === 'questions' ? null : 'questions'))}
            title="Open questions"
            aria-expanded={popover === 'questions'}
          >
            {countLabel(openQuestions.length, 'question')}
          </button>
          {popover === 'questions' && (
            <div className="deep-popover" role="menu">
              {openQuestions.length === 0 && <div className="deep-muted">No open questions. A line ending in “?” offers “Mark open question”.</div>}
              {openQuestions.map((q) => (
                <button key={q.id} className="deep-pop-row" onClick={() => jumpTo(q.anchor)}>
                  {q.text}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Back to Cockpit and End session live on the Desk; a Page only closes back to it. */}
        <span className="deep-window-actions">
          <IconAction icon="close" label="Close" kbd="Esc" onClick={() => zoomOut('overview', 'click')} />
        </span>
      </header>

      {isGoals && nearlyEmpty && readme !== 'none' && (
        <div className="deep-goals-strip">
          <button
            className="deep-link"
            disabled={readme === 'busy'}
            onClick={() => void draftReadme()}
            title="Hester reads README.md and CLAUDE.md and inserts a first guess at the four prompts, attributed, for you to rewrite"
          >
            {readme === 'busy' ? 'Reading the README…' : 'Draft from README'}
          </button>
        </div>
      )}

      {conflict && (
        <div className="deep-conflict" role="alert">
          Changed elsewhere ·{' '}
          <button className="deep-link" onClick={keepMine}>
            Keep mine
          </button>{' '}
          /{' '}
          <button className="deep-link" onClick={loadTheirs}>
            Load theirs
          </button>
        </div>
      )}

      {initial ? (
        <PageEditor
          ref={editor}
          initialText={initial.text}
          initialCursor={initial.cursor}
          visible={visible && !overlay}
          markers={markers}
          openMarker={openMarker}
          onMarkerClick={openCard}
          renderCard={renderCard}
          onChange={onChange}
          onSave={() => void save()}
          onCursor={onCursor}
          onAction={(a, s, q) => void onAction(a, s, q)}
          onAffordance={(o, a, l) => void onAffordance(o, a, l)}
          onAffordanceShown={onAffordanceShown}
          answers={answers}
          onAskMany={onAskMany}
          onHandOff={onHandOff}
          onReplyHandoff={onReplyHandoff}
          mentionTargets={mentionTargets}
          files={files}
          onQuote={(q) => void onQuote(q)}
          marginPrompts={isGoals ? GOALS_PROMPTS : undefined}
          onOpenInWork={onOpenInWork}
        />
      ) : (
        <div className="deep-loading deep-muted">Opening the Page…</div>
      )}

      {(() => {
        const a = reading ? answers.find((x) => x.id === reading) : null;
        if (!a || !a.answer) return null;
        const h = a.handoff;
        const close = () => {
          setReading(null);
          editor.current?.focus();
        };
        return (
          <aside
            className="deep-reader"
            aria-label="Reading"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <header className="deep-reader-head">
              <span className="deep-muted">
                {isHandoff(a) ? `${handoffKindLabel(h?.kind)} · ${handoffStateLabel(h?.state)}` : 'Hester answered'}
              </span>
              <span className="deep-spacer" />
              <button className="deep-quiet" onClick={close} aria-label="Close (Esc)" title="Close (Esc)">
                ×
              </button>
            </header>
            {!isHandoff(a) && <div className="deep-reader-q">{a.question}</div>}
            <div className="deep-reader-body">
              <AgentMarkdown text={a.answer} />
            </div>
            <div className="deep-card-actions">
              {h?.task_id && (
                <button className="deep-quiet" onClick={() => openInWork(h.task_id as string)}>
                  Open in Work
                </button>
              )}
              {answerActions(a)}
              <button
                className="deep-quiet"
                onClick={() => {
                  dismissAnswer(a);
                  close();
                }}
              >
                Dismiss
              </button>
            </div>
            {h?.brief && (
              <details className="deep-muted">
                <summary>The brief as sent</summary>
                <div className="deep-card-a">
                  <AgentMarkdown text={h.brief} />
                </div>
              </details>
            )}
          </aside>
        );
      })()}

      {sheet && (
        <EndSessionSheet
          workspace={workspace}
          explorationId={realId}
          prefill={sheet.prefill}
          questions={sheet.questions}
          focus={copilot.focus ?? copilot.snapshot?.focus ?? null}
          running={asks.filter(isPending).length + localAsks.length}
          runningHandoffs={answers.filter(handoffInFlight).length}
          session={session}
          onAsk={askStillOpen}
          onHandOff={handOffStillOpen}
          desk={ritualDesk}
          suspended={!!handoff}
          beforeEnd={async () => {
            if (saveTimer.current || inFlight.current || unsaved()) await save();
            const c = editor.current?.cursor();
            if (c && realIdRef.current) rememberCursor(workspace, realIdRef.current, c);
          }}
          onEnded={() => {
            void deleteIfEmpty().then((gone) => {
              if (gone && alive.current) becomeDraft();
            });
          }}
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
          provider={handoff.provider}
          onRecord={(a) => {
            if (handoff.eid === realIdRef.current) upsertAnswer(a);
          }}
          onLaunched={() => {
            setHandoff(null);
            say('Handed off · it shows in Work');
            if (!sheet) editor.current?.focus();
          }}
          onClose={() => {
            setHandoff(null);
            if (!sheet) editor.current?.focus();
          }}
        />
      )}

      {goalsDraft != null && <GoalsDraftSheet workspace={workspace} page={goalsDraft} onClose={() => setGoalsDraft(null)} />}
    </div>
  );
}
