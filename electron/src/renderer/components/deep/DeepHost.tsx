/**
 * DeepHost - the Deep mode overlay (Deep D1 §4.1): a portal like CockpitHost,
 * between the title bar and the status bar, shown when this window's mode is
 * 'deep' and an exploration is open. Nothing underneath unmounts.
 *
 * Leaving Deep keeps it mounted (hidden, not display:none), so scroll,
 * cursor, selection and undo history survive hops exactly (§4.4); switching
 * exploration remounts the surface.
 *
 * Header: the title (click to rename), the Page view tab, the Answers tray,
 * the wake line (§2.3), open questions, End session and a dim ⇧⌘0 hint.
 * No chat panel, no feed, no toasts; a one-line status in the header is the
 * only feedback. The Page saves through PUT /page with a version check
 * (§4.3); Hester offline, it keeps writing locally and saves when Hester is
 * back. Input is counted while visible (§4.5), counts only.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Anchor, DeepAnswer, DeepQuestion, LeeMode } from '../../../shared/cockpit';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import { cockpitModeStore, useCockpitModeState } from '../cockpit/cockpitMode';
import { AgentMarkdown } from '../cockpit/AgentMarkdown';
import { getExploration, patchExploration } from '../../lib/hesterCockpit';
import {
  addQuestion,
  addReference,
  askDeep,
  captureSomeday,
  exploreFrom,
  getPage,
  listAnswers,
  listQuestions,
  patchAnswer,
  putPage,
  retryAnswer,
  type PageDoc,
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
  waitingCount,
  wokenItem,
  type Affordance,
  type AffordanceOption,
  type DeepRowAction,
} from '../../lib/deepModel';
import { PageEditor, type PageEditorHandle, type PageMarker, type PageSelection } from './PageEditor';
import { EndSessionSheet, type RitualQuestion } from './EndSessionSheet';
import {
  logDeep,
  onDeepAnswer,
  readMirror,
  rememberCursor,
  rememberDeep,
  savedCursor,
  writeMirror,
  type DeepCursor,
} from './deepBridge';
import './deep.css';

export interface DeepHostProps {
  workspace: string;
  visible: boolean;                 // this window's mode is 'deep'
  explorationId: string | null;
  copilot: UseCopilotResult;        // snapshot for the wake line and "N waiting"
  onHop: (to: LeeMode) => void;     // header hint and the wake line
}

const SAVE_DEBOUNCE_MS = 800;
const ANSWER_POLL_MS = 20000;
const INPUT_FLUSH_MS = 60000;
const FLASH_MS = 6000;

export function DeepHost(props: DeepHostProps): JSX.Element | null {
  const { workspace, visible, explorationId, copilot } = props;
  const mode = useCockpitModeState();
  const title = mode.deep.exploration_id === explorationId ? mode.deep.title : '';

  // The mode chip's "End session" opens the ritual here (showing Deep first if needed).
  const [endNonce, setEndNonce] = useState(0);
  const [bareSheet, setBareSheet] = useState(false);
  useEffect(
    () =>
      cockpitModeStore.onEndSessionRequest(() => {
        if (explorationId) {
          if (!visible) cockpitModeStore.openDeep(explorationId, cockpitModeStore.getDeep().title || title);
          setEndNonce((n) => n + 1);
        } else setBareSheet(true);
      }),
    [explorationId, visible, title],
  );

  // Remember what Deep shows, for restarts (§4.4).
  useEffect(() => {
    if (workspace && explorationId) rememberDeep(workspace, { exploration_id: explorationId, title, view: 'page' });
  }, [workspace, explorationId, title]);

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
  }, [visible, explorationId]);

  // ---- focus trap (C3, like CockpitHost's) ----
  // With the wall gone, a tab activated under the overlay (Hester's focus_tab,
  // a create-tab, ⌘1–9) focuses a hidden terminal; keys must stay on the Page.
  useEffect(() => {
    if (!visible || !explorationId) return;
    let last: HTMLElement | null = null;
    const inside = (el: EventTarget | null) => el instanceof Node && !!rootRef.current?.contains(el);
    const underneath = (el: EventTarget | null) =>
      el instanceof Element && !!el.closest('.main-content, .tab-bar') && !inside(el);
    const refocus = () => {
      const target =
        last && last.isConnected && inside(last)
          ? last
          : (rootRef.current?.querySelector('.cm-content') as HTMLElement | null) ?? rootRef.current;
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
  }, [visible, explorationId]);

  const focus = copilot.focus ?? copilot.snapshot?.focus ?? null;

  if (!workspace) return null;
  if (!explorationId) {
    return bareSheet ? (
      <EndSessionSheet
        workspace={workspace}
        explorationId={null}
        prefill=""
        questions={[]}
        focus={focus}
        copilotApi={copilot.api}
        onClose={() => setBareSheet(false)}
      />
    ) : null;
  }

  return ReactDOM.createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`deep-overlay${visible ? '' : ' is-hidden'}`}
      style={{ top: box.top, bottom: box.bottom }}
      aria-hidden={!visible}
      role="region"
      aria-label="Deep"
    >
      <DeepSurface key={explorationId} {...props} explorationId={explorationId} title={title} endNonce={endNonce} />
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// One exploration's surface
// ---------------------------------------------------------------------------

interface DeepSurfaceProps extends DeepHostProps {
  explorationId: string;
  title: string;
  endNonce: number;
}

/** An Ask made while Hester was offline, waiting to be sent (§4.1 degraded). */
interface LocalAsk {
  id: string;
  question: string;
  anchor: Anchor;
  follow_up_of?: string;
}

type SaveState = 'saved' | 'saving' | 'retrying' | 'conflict';
type Popover = 'answers' | 'questions' | null;

function DeepSurface({ workspace, visible, explorationId: id, title, copilot, onHop, endNonce }: DeepSurfaceProps): JSX.Element {
  const editor = useRef<PageEditorHandle | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- the Page: load, mirror, save (§4.3) ----
  const [initial, setInitial] = useState<{ text: string; cursor: DeepCursor | null } | null>(null);
  const [offline, setOffline] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [conflict, setConflict] = useState<PageDoc | null>(null);
  const version = useRef<string | null>(null);
  const text = useRef('');
  const lastEdit = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const attempt = useRef(0);
  const lastSent = useRef<string | null>(null);
  const conflictRef = useRef<PageDoc | null>(null);
  conflictRef.current = conflict;

  useEffect(() => {
    let cancelled = false;
    const mirror = readMirror(workspace, id);
    getPage(workspace, id).then((r) => {
      if (cancelled) return;
      const cursor = savedCursor(workspace, id);
      if (r.ok) {
        version.current = r.data.version;
        if (mirror?.dirty && mirror.text !== r.data.text) {
          // Unsaved writing from before a crash or an offline stretch.
          text.current = mirror.text;
          setInitial({ text: mirror.text, cursor });
          setDirty(true);
          if (mirror.base === r.data.version) scheduleSave(0);
          else {
            setConflict(r.data);
            setSaveState('conflict');
          }
        } else {
          text.current = r.data.text;
          setInitial({ text: r.data.text, cursor });
          writeMirror(workspace, id, { text: r.data.text, base: r.data.version, dirty: false });
        }
      } else {
        // Hester offline (or the page isn't there yet): write locally, save later.
        setOffline(true);
        version.current = mirror?.base ?? null;
        text.current = mirror?.text ?? '';
        setInitial({ text: text.current, cursor });
        if (mirror?.dirty) {
          setDirty(true);
          scheduleSave(saveBackoffMs(0));
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, id]);

  const save = useCallback(async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (conflictRef.current) return;
    if (inFlight.current) {
      await inFlight.current;
      if (text.current === lastSent.current) return;
    }
    const sent = text.current;
    lastSent.current = sent;
    setSaveState('saving');
    const run = (async () => {
      const r = await putPage(workspace, id, sent, version.current);
      if (r.ok) {
        version.current = r.version;
        attempt.current = 0;
        setOffline(false);
        if (text.current === sent) {
          setDirty(false);
          setSaveState('saved');
          writeMirror(workspace, id, { text: sent, base: r.version, dirty: false });
        } else scheduleSave(SAVE_DEBOUNCE_MS);
      } else if (r.conflict) {
        setConflict(r.conflict);
        setSaveState('conflict');
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
  }, [workspace, id]);

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
      writeMirror(workspace, id, { text: next, base: version.current, dirty: true });
      if (!conflictRef.current) scheduleSave(SAVE_DEBOUNCE_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, id],
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
    writeMirror(workspace, id, { text: conflict.text, base: conflict.version, dirty: false });
    setConflict(null);
    setDirty(false);
    setSaveState('saved');
  };

  // Save now when leaving Deep or this exploration; remember the cursor.
  useEffect(() => {
    if (visible) return;
    if (saveTimer.current) void save();
  }, [visible, save]);
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        void saveRef.current();
      }
      const c = editor.current?.cursor();
      if (c) rememberCursor(workspace, id, c);
    },
    [workspace, id],
  );
  const onCursor = useCallback((c: DeepCursor) => rememberCursor(workspace, id, c), [workspace, id]);
  useEffect(() => {
    // Remember the cursor now and then while writing (a restart restores it).
    if (!visible) return;
    const t = window.setInterval(() => {
      const c = editor.current?.cursor();
      if (c) rememberCursor(workspace, id, c);
    }, 15000);
    return () => window.clearInterval(t);
  }, [visible, workspace, id]);

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

  // ---- answers (§4.2, §6) ----
  const [answers, setAnswers] = useState<DeepAnswer[]>([]);
  const [localAsks, setLocalAsks] = useState<LocalAsk[]>([]);
  const [openMarker, setOpenMarker] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<{ id: string; text: string } | null>(null);

  const refreshAnswers = useCallback(async () => {
    const r = await listAnswers(workspace, id);
    if (r.ok && alive.current) setAnswers(Array.isArray(r.data) ? r.data : []);
  }, [workspace, id]);

  useEffect(() => {
    void refreshAnswers();
    return onDeepAnswer((e) => {
      if (e.exploration_id === id && (!e.workspace || e.workspace === workspace)) void refreshAnswers();
    });
  }, [refreshAnswers, id, workspace]);

  const sendAsk = useCallback(
    async (ask: { question: string; anchor: Anchor; follow_up_of?: string }, queuedId?: string): Promise<boolean> => {
      const r = await askDeep(workspace, id, ask);
      if (!alive.current) return r.ok;
      if (r.ok) {
        setAnswers((prev) => [r.data, ...prev.filter((a) => a.id !== r.data.id)]);
        if (queuedId) setLocalAsks((l) => l.filter((x) => x.id !== queuedId));
        setOffline(false);
        return true;
      }
      if (!r.status) {
        setOffline(true);
        if (!queuedId) {
          setLocalAsks((l) => [...l, { id: `local-${Date.now().toString(36)}`, ...ask }]);
          say('Hester offline · queued', 'warn');
        }
      } else say(r.error, 'warn');
      return false;
    },
    [workspace, id, say],
  );

  // Poll while something is pending (a missed deep:answer isn't fatal), and send queued asks.
  const pending = answers.some(isPending) || localAsks.length > 0;
  const localRef = useRef(localAsks);
  localRef.current = localAsks;
  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => {
      void refreshAnswers();
      for (const q of localRef.current) void sendAsk({ question: q.question, anchor: q.anchor, ...(q.follow_up_of ? { follow_up_of: q.follow_up_of } : {}) }, q.id);
    }, ANSWER_POLL_MS);
    return () => window.clearInterval(t);
  }, [pending, refreshAnswers, sendAsk]);

  const ask = (question: string, anchor: Anchor, follow_up_of?: string) => {
    void sendAsk({ question, anchor, ...(follow_up_of ? { follow_up_of } : {}) });
    logDeep({ type: 'deep.action', data: { action: follow_up_of ? 'follow_up' : 'ask', exploration_id: id, chars: question.length } });
  };

  const patchLocal = (aid: string, patch: Partial<DeepAnswer>) => setAnswers((prev) => prev.map((a) => (a.id === aid ? { ...a, ...patch } : a)));

  const openCard = (aid: string, force = false) => {
    setFollowUp(null);
    if (openMarker === aid && !force) {
      setOpenMarker(null);
      return;
    }
    setOpenMarker(aid);
    const a = answers.find((x) => x.id === aid);
    if (a && isUnread(a)) {
      patchLocal(aid, { read_at: new Date().toISOString() });
      void patchAnswer(workspace, id, aid, { read: true });
    }
  };

  const insertAnswer = (a: DeepAnswer) => {
    const ed = editor.current;
    if (!ed || !a.answer) return;
    const doc = ed.getText();
    const at = locateAnchor(doc, a.anchor).pos;
    const change = answerInsertion(doc, at, a.answer, attributionDate(new Date()));
    ed.insert(change.from, change.insert);
    patchLocal(a.id, { inserted_at: new Date().toISOString() });
    void patchAnswer(workspace, id, a.id, { inserted: true });
    logDeep({ type: 'deep.action', data: { action: 'insert', exploration_id: id, chars: a.answer.length } });
  };

  const keepAnswer = async (a: DeepAnswer) => {
    if (!a.answer) return;
    const section = a.anchor.kind === 'page' ? a.anchor.section : null;
    const r = await addReference(workspace, id, { kind: 'quote', quote: a.answer, section, source: { kind: 'answer', ref: a.id } });
    if (!r.ok) return say(r.error, 'warn');
    patchLocal(a.id, { kept_at: new Date().toISOString() });
    void patchAnswer(workspace, id, a.id, { kept: true });
    logDeep({ type: 'deep.action', data: { action: 'keep', exploration_id: id, chars: a.answer.length } });
    say('Kept as a reference');
  };

  const dismissAnswer = (a: DeepAnswer) => {
    patchLocal(a.id, { dismissed_at: new Date().toISOString() });
    setOpenMarker(null);
    void patchAnswer(workspace, id, a.id, { dismissed: true });
    logDeep({ type: 'deep.action', data: { action: 'dismiss', exploration_id: id } });
  };

  const retry = async (a: DeepAnswer) => {
    const r = await retryAnswer(workspace, id, a.id);
    if (r.ok) setAnswers((prev) => prev.map((x) => (x.id === a.id ? r.data : x)));
    else say(r.error, 'warn');
  };

  const markers: PageMarker[] = useMemo(
    () => [
      ...answers.filter((a) => !a.dismissed_at).map((a) => ({ id: a.id, anchor: a.anchor, state: markerState(a) })),
      ...localAsks.map((q) => ({ id: q.id, anchor: q.anchor, state: 'pending' as const })),
    ],
    [answers, localAsks],
  );

  const renderCard = (mid: string): React.ReactNode => {
    const local = localAsks.find((q) => q.id === mid);
    if (local) {
      return (
        <>
          <div className="deep-card-q">{local.question}</div>
          <div className="deep-muted">Hester offline · queued</div>
        </>
      );
    }
    const a = answers.find((x) => x.id === mid);
    if (!a) return null;
    return (
      <>
        <div className="deep-card-q">{a.question}</div>
        {isPending(a) && <div className="deep-muted">Asking…</div>}
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
            <div className="deep-card-a">
              <AgentMarkdown text={a.answer} />
            </div>
            <div className="deep-card-actions">
              <button className="deep-btn" onClick={() => insertAnswer(a)} disabled={!!a.inserted_at} title="Insert into the Page as a quote">
                {a.inserted_at ? 'Inserted' : 'Insert'}
              </button>
              <button className="deep-btn" onClick={() => void keepAnswer(a)} disabled={!!a.kept_at} title="Keep as a reference">
                {a.kept_at ? 'Kept' : 'Keep'}
              </button>
              <button className="deep-btn" onClick={() => setFollowUp({ id: a.id, text: '' })}>
                Follow up
              </button>
              <button className="deep-btn" onClick={() => dismissAnswer(a)}>
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
    let cancelled = false;
    listQuestions(workspace, id).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data)) setQuestions(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, id]);
  const openQuestions = questions.filter((q) => q.status === 'open');

  // ---- selection actions (§5) and affordances (§7) ----
  const captureText = async (t: string, from: number, to: number) => {
    const doc = text.current;
    const r = await captureSomeday(workspace, t, {
      surface: 'lee',
      exploration_id: id,
      section: sectionAt(doc, from),
      context: contextAround(doc, from, to, 300),
    });
    if (r.ok) say('Captured to Someday');
    else say(r.error, 'warn');
    logDeep({ type: 'deep.action', data: { action: 'capture', exploration_id: id, chars: t.length } });
  };

  const onAction = async (action: DeepRowAction, sel: PageSelection, question?: string) => {
    const doc = text.current;
    const chars = sel.text.length;
    if (action === 'capture') return captureText(sel.text, sel.from, sel.to);
    if (action === 'keep') {
      const t = sel.text.trim();
      const body = isBareUrl(t)
        ? { kind: 'link' as const, url: t, section: sectionAt(doc, sel.from), source: { kind: 'page' as const } }
        : { kind: 'quote' as const, quote: sel.text, section: sectionAt(doc, sel.from), source: { kind: 'page' as const } };
      const r = await addReference(workspace, id, body);
      say(r.ok ? 'Kept as a reference' : r.error, r.ok ? 'ok' : 'warn');
      logDeep({ type: 'deep.action', data: { action: 'keep', exploration_id: id, chars } });
      return;
    }
    if (action === 'ask') {
      ask(question || 'Explain this.', anchorFor(doc, sel.from, sel.to));
      return;
    }
    if (action === 'explore') {
      const r = await exploreFrom(workspace, id, { seed: sel.text, anchor: anchorFor(doc, sel.from, sel.to) });
      say(r.ok ? `Explored: ${r.data.title}` : r.error, r.ok ? 'ok' : 'warn');
      logDeep({ type: 'deep.action', data: { action: 'explore', exploration_id: id, chars } });
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
        const r = await addQuestion(workspace, id, { text: opt.text.slice(0, 500), source: 'page', anchor });
        if (!r.ok) return say(r.error, 'warn');
        setQuestions((qs) => [r.data, ...qs.filter((q) => q.id !== r.data.id)]);
        setMarkedThisSession((s) => new Set(s).add(r.data.id));
        say('Marked as an open question');
        return;
      }
      case 'keep_link': {
        const r = await addReference(workspace, id, {
          kind: 'link',
          url: opt.url,
          ...(opt.title ? { title: opt.title } : {}),
          section: sectionAt(doc, line.from),
          source: { kind: 'page' },
        });
        say(r.ok ? 'Kept as a reference' : r.error, r.ok ? 'ok' : 'warn');
        logDeep({ type: 'deep.action', data: { action: 'keep', exploration_id: id, chars: opt.url.length } });
        return;
      }
      case 'capture':
        return captureText(opt.text, line.from, line.to);
    }
  };

  const onAffordanceShown = (aff: Affordance, outcome: 'accepted' | 'ignored') =>
    logDeep({ type: 'deep.affordance', data: { pattern: aff.pattern, outcome } });

  // ---- input counting (§4.5) and deep.view ----
  const counts = useRef({ keys: 0, clicks: 0, wheels: 0, since: Date.now() });
  const flushInput = useCallback(() => {
    const c = counts.current;
    const now = Date.now();
    if (c.keys + c.clicks + c.wheels > 0) {
      logDeep({ type: 'deep.input', data: { exploration_id: id, view: 'page', keys: c.keys, clicks: c.clicks, wheels: c.wheels, span_ms: now - c.since } });
    }
    counts.current = { keys: 0, clicks: 0, wheels: 0, since: now };
  }, [id]);
  useEffect(() => {
    if (!visible) return;
    counts.current = { keys: 0, clicks: 0, wheels: 0, since: Date.now() };
    logDeep({ type: 'deep.view', data: { exploration_id: id, view: 'page' } });
    const t = window.setInterval(flushInput, INPUT_FLUSH_MS);
    return () => {
      window.clearInterval(t);
      flushInput();
    };
  }, [visible, id, flushInput]);

  // ---- header: rename, popovers, the ritual ----
  const [renaming, setRenaming] = useState<string | null>(null);
  const [shownTitle, setShownTitle] = useState(title);
  useEffect(() => {
    if (title) setShownTitle(title);
  }, [title]);
  useEffect(() => {
    if (title) return;
    let cancelled = false;
    getExploration(workspace, id).then((r) => {
      if (!cancelled && r.ok) setShownTitle(r.data.title);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, id, title]);
  const commitRename = async () => {
    const next = (renaming ?? '').trim();
    setRenaming(null);
    if (!next || next === shownTitle) return;
    const r = await patchExploration(workspace, id, { title: next });
    if (!r.ok) return say(r.error, 'warn');
    setShownTitle(r.data.title);
    rememberDeep(workspace, { exploration_id: id, title: r.data.title, view: 'page' });
    cockpitModeStore.openDeep(id, r.data.title);
  };

  const [popover, setPopover] = useState<Popover>(null);
  const jumpTo = (anchor: Anchor | undefined, markerId?: string) => {
    setPopover(null);
    const ed = editor.current;
    if (!ed) return;
    if (anchor) ed.reveal(locateAnchor(ed.getText(), anchor).pos);
    if (markerId) openCard(markerId, true);
    ed.focus();
  };

  const [sheet, setSheet] = useState<{ prefill: string; questions: RitualQuestion[] } | null>(null);
  const openSheet = useCallback(() => {
    const doc = text.current;
    const startedAt = (copilot.focus ?? copilot.snapshot?.focus)?.started_at ?? null;
    const qs: RitualQuestion[] = questions
      .filter((q) => q.status === 'open' && (markedThisSession.has(q.id) || (q.source === 'page' && !!startedAt && q.at >= startedAt)))
      .map((q) => ({ id: q.id, kind: 'question' as const, text: q.text }));
    for (const a of answers) if (isUnread(a)) qs.push({ id: a.id, kind: 'answer', text: a.question });
    setPopover(null);
    setSheet({ prefill: lastSentence(doc, lastEdit.current ?? doc.length), questions: qs });
  }, [answers, questions, markedThisSession, copilot.focus, copilot.snapshot]);
  const endSeen = useRef(endNonce);
  useEffect(() => {
    if (endNonce === endSeen.current) return;
    endSeen.current = endNonce;
    openSheet();
  }, [endNonce, openSheet]);

  const tray = answersTray([...answers, ...localAsks.map(() => ({ status: 'queued' as const }))]);
  const woken = wokenItem(copilot.snapshot);
  const waiting = waitingCount(copilot.snapshot);

  return (
    <div
      className="deep-surface"
      onKeyDownCapture={() => {
        if (visible && !sheet) counts.current.keys++;
      }}
      onMouseDownCapture={() => {
        if (visible && !sheet) counts.current.clicks++;
      }}
      onWheelCapture={() => {
        if (visible && !sheet) counts.current.wheels++;
      }}
    >
      <header className="deep-header">
        {renaming != null ? (
          <input
            className="deep-title-input"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitRename();
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
        <nav className="deep-views" aria-label="Views">
          <button className="deep-view is-active" title="Page (⌥⌘1)" aria-current="page">
            Page
          </button>
        </nav>
        <span className="deep-spacer" />
        {flash && <span className={`deep-flash is-${flash.tone}`}>{flash.text}</span>}
        {offline && !flash && <span className="deep-muted">Hester offline · writing locally</span>}
        {woken && (
          <button className="deep-wake" onClick={() => onHop('cockpit')} title="You asked to be woken for this. Opens the Cockpit">
            {woken.title}
          </button>
        )}
        <div className="deep-pop-anchor">
          <button
            className={`deep-chip${tray.unread ? ' is-unread' : ''}`}
            onClick={() => setPopover((p) => (p === 'answers' ? null : 'answers'))}
            title="Answers"
          >
            {tray.pending > 0 && <span className="deep-marker-spin" />}
            {tray.label}
          </button>
          {popover === 'answers' && (
            <div className="deep-popover" role="menu">
              {answers.filter((a) => !a.dismissed_at).length === 0 && localAsks.length === 0 && <div className="deep-muted">No answers yet. Select text and Ask (⌘. a).</div>}
              {localAsks.map((q) => (
                <button key={q.id} className="deep-pop-row" onClick={() => jumpTo(q.anchor, q.id)}>
                  <span className="deep-marker is-pending" /> {q.question}
                  <span className="deep-muted"> · queued</span>
                </button>
              ))}
              {answers
                .filter((a) => !a.dismissed_at)
                .map((a) => (
                  <button key={a.id} className="deep-pop-row" onClick={() => jumpTo(a.anchor, a.id)}>
                    <span className={`deep-marker is-${markerState(a)}`} /> {a.question}
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className="deep-pop-anchor">
          <button className="deep-chip" onClick={() => setPopover((p) => (p === 'questions' ? null : 'questions'))} title="Open questions">
            ? {openQuestions.length}
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
        <button className="deep-btn" onClick={openSheet}>
          End session
        </button>
        <button className="deep-hint" onClick={() => onHop('cockpit')} title={waiting ? `${waiting} waiting in the Cockpit` : 'Cockpit'}>
          <kbd>⇧⌘0</kbd> Cockpit{waiting ? ` · ${waiting} waiting` : ''}
        </button>
      </header>

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
          visible={visible && !sheet}
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
        />
      ) : (
        <div className="deep-loading deep-muted">Opening the Page…</div>
      )}

      {sheet && (
        <EndSessionSheet
          workspace={workspace}
          explorationId={id}
          prefill={sheet.prefill}
          questions={sheet.questions}
          focus={copilot.focus ?? copilot.snapshot?.focus ?? null}
          copilotApi={copilot.api}
          running={answers.filter(isPending).length + localAsks.length}
          beforeEnd={async () => {
            if (saveTimer.current || inFlight.current) await save();
            const c = editor.current?.cursor();
            if (c) rememberCursor(workspace, id, c);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}
