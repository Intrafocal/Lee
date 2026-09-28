/**
 * PageEditor - the Page (Deep D1 §4.2, Deep next §4): a prose CodeMirror for
 * the exploration's page.md, built from EditorPanel's pieces rather than
 * EditorPanel itself.
 *
 * - GFM markdown with live formatting (R9, page/liveMarkdown): marks hidden
 *   off the cursor's lines, fenced code highlighted by its language, tables
 *   rendered while the cursor is outside them. A slim formatting toolbar
 *   (page/PageToolbar) sits sticky at the top of the column; each of its
 *   actions has a chord (page/format, which also keeps ⌘I and ⌘⇧K from the
 *   app's hotkeys). The D1 ⌘E preview is retired.
 * - A centred column (72ch) in Newsreader at 20/1.65 on --ground-0
 *   (cockpit-design §6.1), and a margin column outside it. With `answers`
 *   (R5): one mark per section at its first line, most urgent state plus a
 *   count, opening the section's cards (page/SectionMarks). Without it, D1's
 *   one note per answer. Notes that would overlap are pushed down; nothing in
 *   the margin moves the text or takes focus unless clicked. `marginPrompts`
 *   (R12) sit quietly at the top and fade once answered or dismissed.
 * - The action row (R1): Ask Hester · Hand off · Keep · Capture · Explore,
 *   words only; ⌘. moves focus into it and only then are the letters
 *   underlined. With nothing selected, ⌘. offers Hand off (this section) and
 *   Insert table. Esc returns with the selection intact.
 * - Ask (R2): a selection's question lines are asked as written, one Ask
 *   each with its section (`onAskMany`); a selection with no question shows
 *   "Ask about this…" and the D1 field. ⌘⏎ with a selection = Ask Hester.
 * - `[[` (R10): a fuzzy picker over `files.list()`; picking opens the file in
 *   a read-only source panel (≤ half width) where Quote it inserts the quote
 *   and calls `onQuote`, and Enter with no highlight inserts `[[path]]`.
 *   Clicking a `[[…]]` link opens the panel at its lines.
 * - `@` (R11): a list of `mentionTargets`; a line with a mention offers its
 *   line-end button, and only ⌘⏎ or a click sends it.
 * - Typing affordances (§7) as in D1; ⌘S saves now.
 *
 * Every Deep next prop is optional: without it, its feature doesn't show.
 * The component owns the view; DeepHost owns the data and the calls.
 */

import type { DeepAnswer } from '../../../shared/cockpit';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Annotation, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  highlightSpecialChars,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import type { Anchor } from '../../../shared/cockpit';
import {
  AFFORDANCE_DELAY_MS,
  AFFORDANCE_FADE_MS,
  affordanceFor,
  aggregateMarks,
  anchorFor,
  askPlan,
  deepRowKey,
  findMention,
  handoffLabel,
  lineParts,
  locateAnchor,
  markerState,
  mentionMatches,
  mentionQuery,
  mentionSlug,
  promptAnswered,
  quoteBlock,
  withTableHeader,
  quoteLabel,
  rankFiles,
  sectionAtPos,
  sectionMarkState,
  sectionsOf,
  sectionTextAt,
  SECTION_TEXT_MAX,
  wikiQuery,
  type Affordance,
  type AffordanceOption,
  type DeepRowAction,
  type PageSection,
  type WikiLink,
} from '../../lib/deepModel';
import { onDeepActions } from './deepBridge';
import { marginNoteLabel } from './deepView';
import { pageMarkdown, liveFormatting, tableField, type AssetUrl } from './page/liveMarkdown';
import { MicButton } from '../voice/MicButton';
import { formatCommand, formatKeymap, inTable, insertTable, type FormatId } from './page/format';
import { PageToolbar, type ToolbarState } from './page/PageToolbar';
import { mentionField, setMention, type ShownMention } from './page/mentionWidget';
import { PagePicker, type PickerItem } from './page/PagePicker';
import { SourcePanel, type SourceSelection } from './page/SourcePanel';
import { MarginPrompts, SectionMarkView, type MarkItem } from './page/SectionMarks';

/** Marks a transaction that replaces the buffer from outside (Load theirs): not your edit. */
const remote = Annotation.define<boolean>();

// ---------------------------------------------------------------------------
// Affordance widget
// ---------------------------------------------------------------------------

type ShownAffordance = { pos: number; line: number; aff: Affordance };
const setAffordance = StateEffect.define<ShownAffordance | null>();

class AffordanceWidget extends WidgetType {
  constructor(
    readonly aff: Affordance,
    readonly pick: (opt: AffordanceOption) => void,
  ) {
    super();
  }
  eq(other: AffordanceWidget): boolean {
    return JSON.stringify(other.aff) === JSON.stringify(this.aff);
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'deep-aff';
    wrap.setAttribute('contenteditable', 'false');
    this.aff.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deep-aff-btn';
      b.textContent = opt.label;
      if (i === 0) b.title = `${opt.label} (⌘.)`;
      // mousedown, not click: the cursor must not move off the line first.
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pick(opt);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function affordanceField(pick: (opt: AffordanceOption) => void) {
  return StateField.define<{ shown: ShownAffordance | null; deco: DecorationSet }>({
    create: () => ({ shown: null, deco: Decoration.none }),
    update(value, tr) {
      let shown = value.shown;
      for (const e of tr.effects) if (e.is(setAffordance)) shown = e.value;
      if (shown && tr.docChanged && !tr.effects.some((e) => e.is(setAffordance))) {
        shown = { ...shown, pos: tr.changes.mapPos(shown.pos, 1) };
      }
      if (shown === value.shown) return value;
      if (!shown) return { shown: null, deco: Decoration.none };
      const deco = Decoration.set([Decoration.widget({ widget: new AffordanceWidget(shown.aff, pick), side: 1 }).range(shown.pos)]);
      return { shown, deco };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}

const pageTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-1)', height: 'auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--font-write)', lineHeight: '1.65' },
  '.cm-content': { padding: 'var(--space-5) 0 40vh', caretColor: 'var(--caret)', fontSize: '20px' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--caret)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-panels': { backgroundColor: 'var(--ground-2)', color: 'var(--text-1)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(var(--ember-rgb), 0.25)' },
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type MarkerState = 'pending' | 'unread' | 'read' | 'error';

export interface PageMarker {
  id: string;
  anchor: Anchor;
  state: MarkerState;
  /** The question asked, shown under the note's label. */
  question: string;
  /** Made while Hester was offline, not sent yet. */
  queued?: boolean;
}

export interface PageSelection {
  from: number;
  to: number;
  text: string;
}

export interface PageEditorHandle {
  focus(): void;
  getText(): string;
  getSelection(): PageSelection | null;
  /** Replace the whole buffer from outside (Load theirs); not counted as an edit. */
  replaceAll(text: string): void;
  /** Your own insert (Insert from the margin): an ordinary edit. */
  insert(from: number, text: string): void;
  /** Delete a range as an ordinary edit (Send to Lee's Undo). */
  remove(from: number, to: number): void;
  /** Scroll to a position and put the cursor there. */
  reveal(pos: number): void;
  cursor(): { anchor: number; head: number; scroll: number };
}

interface PageEditorProps {
  initialText: string;
  /** Where the cursor starts: a saved cursor, or the end of the Page. */
  initialCursor: { anchor: number; head: number; scroll: number } | null;
  visible: boolean;
  markers: PageMarker[];
  openMarker: string | null;
  onMarkerClick: (id: string) => void;
  /** The expanded card for the open marker. */
  renderCard: (id: string) => React.ReactNode;
  onChange: (text: string, lastEditPos: number) => void;
  onSave: () => void;
  onCursor: (c: { anchor: number; head: number; scroll: number }) => void;
  /** A row action on the selection; `question` is the Ask field's text (may be empty). */
  onAction: (action: DeepRowAction, sel: PageSelection, question?: string) => void;
  onAffordance: (opt: AffordanceOption, aff: Affordance, line: { from: number; to: number; text: string }) => void;
  onAffordanceShown: (aff: Affordance, outcome: 'accepted' | 'ignored') => void;

  // ---- Deep next seam (docs/plans/2026-09-27-deep-next-contract.md §3). RA implements; RB passes. ----
  /** All answers and hand-offs, for the per-section margin marks (R5). */
  answers?: readonly DeepAnswer[];
  /** R2: Ask Hester on a selection that holds questions: one ask per question, each with its section. */
  onAskMany?: (asks: Array<{ question: string; anchor: Anchor; sectionText: string }>) => void;
  /** R3: Hand off the selection, or the section the cursor is in. `provider` from an @mention. */
  onHandOff?: (sel: PageSelection & { anchor: Anchor; sectionText: string }, provider?: string) => void;
  /** R11: a sent @mention to one of this exploration's hand-offs (reply with that text). */
  onReplyHandoff?: (answerId: string, text: string) => void;
  /** R11: who @ can reach: Hester, the providers, this exploration's hand-offs. */
  mentionTargets?: ReadonlyArray<{ id: string; label: string; kind: 'hester' | 'provider' | 'handoff' }>;
  /** R10: the workspace file list for [[ and a reader for the source panel. */
  files?: { list: () => Promise<string[]>; read: (path: string) => Promise<string | null> };
  /** R10: a quote was inserted from a file (record it as a reference). */
  onQuote?: (q: { file: string; lines: [number, number]; text: string; label: string }) => void;
  /** R12: quiet prompts in the margin (the Goals Page), faded once answered. */
  marginPrompts?: readonly string[];
  /** R5: a hand-off card's "Open in Work" (its task in the Cockpit). Hidden when absent. */
  onOpenInWork?: (answerId: string) => void;
  /** Tether §4.4: the Page's `assets/<name>` as a showable URL; without it images stay markdown. */
  assetUrl?: AssetUrl;
  /** Voice §5.3: the workspace for the Ask field's mic (purpose ask); without it no mic. */
  voiceWorkspace?: string;
}

/** The action row slot's width (deep.css .deep-row-slot). */
const ROW_WIDTH = 500;

type RowButton = { action: DeepRowAction; label: string; mnemonic: string; title: string };

/** Underline the mnemonic letter (shown only while the row has keyboard focus: R1). */
function mnemonicLabel(label: string, letter: string): React.ReactNode {
  const i = label.toLowerCase().indexOf(letter);
  if (i < 0) return label;
  // One span: the button is a flex box, and loose text nodes would each get its gap ("A sk").
  return (
    <span className="deep-row-label">
      {label.slice(0, i)}
      <span className="deep-row-mn">{label[i]}</span>
      {label.slice(i + 1)}
    </span>
  );
}

type Picker = { kind: 'wiki' | 'mention'; query: string; from: number; to: number };
type Source = { path: string; text: string | null | undefined; lines: [number, number] | null; insert: { from: number; to: number } | null };
type Placed = { anchors: Record<string, number>; sections: PageSection[]; answered: string[] };

const MENTION_VERB = { hester: 'Ask Hester', provider: 'Hand off to', handoff: 'Reply to' } as const;

export const PageEditor = forwardRef<PageEditorHandle, PageEditorProps>(function PageEditor(props, ref) {
  const { initialText, initialCursor, visible, markers, openMarker, onMarkerClick, renderCard } = props;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const cb = useRef(props);
  cb.current = props;

  const [layout, setLayout] = useState(0);
  const [sel, setSel] = useState<PageSelection | null>(null);
  const [cursorRow, setCursorRow] = useState(false);
  const [asking, setAsking] = useState<{ text: string } | null>(null);
  const [placed, setPlaced] = useState<Placed>({ anchors: {}, sections: [], answered: [] });
  const [docRev, setDocRev] = useState(0);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [dismissedPrompts, setDismissedPrompts] = useState<Set<string>>(() => new Set());

  // ---- [[ and @ pickers, the source panel ----
  const [picker, setPicker] = useState<Picker | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const [fileList, setFileList] = useState<string[] | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const pickerRef = useRef<Picker | null>(null);
  pickerRef.current = picker;
  const pickDismissed = useRef<number | null>(null);
  const filesLoadedAt = useRef(0);

  // ---- @ mention's line-end button ----
  const mentionRef = useRef<{ line: number; key: string } | null>(null);
  const sentMentions = useRef<Set<string>>(new Set());

  // ---- affordance timing (§7) ----
  const aff = useRef<{
    line: number;
    text: string;
    pasted: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    fade: ReturnType<typeof setTimeout> | null;
    shown: { aff: Affordance; line: number; text: string } | null;
    seen: Set<string>;
  }>({ line: -1, text: '', pasted: false, timer: null, fade: null, shown: null, seen: new Set() });
  const lastActions = useRef(0);

  const hideAffordance = useCallback((outcome: 'accepted' | 'ignored' | null) => {
    const a = aff.current;
    if (a.fade) clearTimeout(a.fade);
    a.fade = null;
    const shown = a.shown;
    a.shown = null;
    if (shown && outcome) cb.current.onAffordanceShown(shown.aff, outcome);
    const view = viewRef.current;
    if (shown && view) setTimeout(() => viewRef.current?.dispatch({ effects: setAffordance.of(null) }), 0);
  }, []);

  const pickAffordance = useCallback(
    (opt: AffordanceOption) => {
      const view = viewRef.current;
      const shown = aff.current.shown;
      if (!view || !shown) return;
      const line = view.state.doc.line(Math.min(shown.line, view.state.doc.lines));
      hideAffordance('accepted');
      cb.current.onAffordance(opt, shown.aff, { from: line.from, to: line.to, text: line.text });
    },
    [hideAffordance],
  );

  /** Mention targets whose action has a callback (a hand-off reply needs onReplyHandoff, …). */
  const usableTargets = () => {
    const p = cb.current;
    return (p.mentionTargets ?? []).filter((t) => (t.kind === 'provider' ? !!p.onHandOff : t.kind === 'handoff' ? !!p.onReplyHandoff : true));
  };

  const trackCursorLine = useCallback(
    (u: ViewUpdate) => {
      const a = aff.current;
      const s = u.state.selection.main;
      const pasted = u.transactions.some((tr) => tr.isUserEvent('input.paste'));
      const line = s.empty ? u.state.doc.lineAt(s.head) : null;
      const lineNo = line ? line.number : -1;
      const text = line ? line.text : '';

      // Leaving the line, or typing more on it, fades a shown affordance.
      if (a.shown && (lineNo !== a.shown.line || text !== a.shown.text)) hideAffordance('ignored');

      if (lineNo !== a.line || text !== a.text) {
        if (lineNo !== a.line) a.pasted = false;
        if (pasted) a.pasted = true;
        a.line = lineNo;
        a.text = text;
        if (a.timer) clearTimeout(a.timer);
        a.timer = null;
        if (!line) return;
        // A mention's own button is the line's affordance (R11).
        if (findMention(text, usableTargets())) return;
        const found = affordanceFor(text, a.pasted);
        if (!found) return;
        const key = `${found.pattern}|${text.trim()}`;
        if (a.seen.has(key)) return;
        a.timer = setTimeout(() => {
          a.timer = null;
          const view = viewRef.current;
          if (!view || a.line !== lineNo || a.text !== text || a.shown) return;
          const cur = view.state.selection.main;
          if (!cur.empty || view.state.doc.lineAt(cur.head).number !== lineNo) return;
          a.seen.add(key);
          const l = view.state.doc.line(lineNo);
          a.shown = { aff: found, line: lineNo, text };
          view.dispatch({ effects: setAffordance.of({ pos: l.to, line: lineNo, aff: found }) });
          a.fade = setTimeout(() => hideAffordance('ignored'), AFFORDANCE_FADE_MS);
        }, AFFORDANCE_DELAY_MS);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hideAffordance],
  );

  // ---- @ mentions (R11) ----
  const trackMention = useCallback((state: EditorState) => {
    const s = state.selection.main;
    let next: ShownMention | null = null;
    let key: string | null = null;
    let lineNo = -1;
    if (s.empty) {
      const line = state.doc.lineAt(s.head);
      const found = findMention(line.text, usableTargets());
      key = line.text.trim();
      if (found && !sentMentions.current.has(key)) {
        const verb = MENTION_VERB[found.target.kind];
        next = {
          pos: line.to,
          line: line.number,
          label: found.target.kind === 'hester' ? verb : `${verb} ${found.target.label}`,
          text: found.text,
        };
        lineNo = line.number;
      }
    }
    const cur = mentionRef.current;
    if (!next) {
      if (cur) {
        mentionRef.current = null;
        setTimeout(() => viewRef.current?.dispatch({ effects: setMention.of(null) }), 0);
      }
      return;
    }
    if (cur && cur.line === lineNo && cur.key === key) return;
    mentionRef.current = { line: lineNo, key: key! };
    const shown = next;
    setTimeout(() => viewRef.current?.dispatch({ effects: setMention.of(shown) }), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMention = useCallback((): boolean => {
    const view = viewRef.current;
    const m = mentionRef.current;
    if (!view || !m || m.line > view.state.doc.lines) return false;
    const p = cb.current;
    const line = view.state.doc.line(m.line);
    const found = findMention(line.text, usableTargets());
    if (!found) return false;
    const doc = view.state.doc.toString();
    const anchor = anchorFor(doc, line.from, line.to);
    const sectionText = sectionTextAt(doc, line.from);
    const text = found.text || line.text.trim();
    if (found.target.kind === 'hester') {
      if (p.onAskMany) p.onAskMany([{ question: text, anchor, sectionText }]);
      else p.onAction('ask', { from: line.from, to: line.to, text: line.text }, text);
    } else if (found.target.kind === 'provider') {
      p.onHandOff?.({ from: line.from, to: line.to, text, anchor, sectionText }, found.target.id);
    } else {
      p.onReplyHandoff?.(found.target.id, text);
    }
    sentMentions.current.add(line.text.trim());
    mentionRef.current = null;
    setTimeout(() => viewRef.current?.dispatch({ effects: setMention.of(null) }), 0);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- [[ and @ pickers (R10, R11) ----
  const trackPicker = useCallback((state: EditorState) => {
    const s = state.selection.main;
    let next: Picker | null = null;
    if (s.empty) {
      const line = state.doc.lineAt(s.head);
      const before = line.text.slice(0, s.head - line.from);
      const wq = cb.current.files ? wikiQuery(before) : null;
      const mq = !wq && usableTargets().length ? mentionQuery(before) : null;
      const q = wq ?? mq;
      if (q) {
        const from = line.from + q.start;
        if (pickDismissed.current !== from) next = { kind: wq ? 'wiki' : 'mention', query: q.query, from, to: s.head };
      } else pickDismissed.current = null;
    }
    const cur = pickerRef.current;
    if (!next) {
      if (cur) setPicker(null);
      return;
    }
    if (!cur || cur.kind !== next.kind || cur.from !== next.from) setPickIndex(0);
    else if (cur.query !== next.query) setPickIndex(0);
    setPicker(next);
    if (next.kind === 'wiki' && (!cur || cur.kind !== 'wiki') && Date.now() - filesLoadedAt.current > 30000) {
      filesLoadedAt.current = Date.now();
      cb.current.files
        ?.list()
        .then((l) => setFileList(Array.isArray(l) ? l : []))
        .catch(() => setFileList([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickerItems: Array<PickerItem & { value: string }> = useMemo(() => {
    if (!picker) return [];
    if (picker.kind === 'wiki') {
      return rankFiles(picker.query, fileList ?? [], 30).map((p) => {
        const i = p.lastIndexOf('/');
        return { key: p, value: p, label: i >= 0 ? p.slice(i + 1) : p, sub: i >= 0 ? p.slice(0, i) : undefined };
      });
    }
    return mentionMatches(picker.query, usableTargets()).map((t) => ({
      key: t.id,
      value: t.id,
      label: t.label,
      sub: t.kind === 'hester' ? 'Ask' : t.kind === 'provider' ? 'Hand off' : 'Reply',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, fileList, props.mentionTargets]);
  const pickerItemsRef = useRef(pickerItems);
  pickerItemsRef.current = pickerItems;

  const openSource = useCallback((path: string, lines: [number, number] | null, insert: { from: number; to: number } | null) => {
    const files = cb.current.files;
    if (!files) return;
    setSource({ path, text: undefined, lines, insert });
    files
      .read(path)
      .then((text) => setSource((s) => (s && s.path === path ? { ...s, text: typeof text === 'string' ? text : null } : s)))
      .catch(() => setSource((s) => (s && s.path === path ? { ...s, text: null } : s)));
  }, []);

  const pick = useCallback(
    (i: number) => {
      const view = viewRef.current;
      const p = pickerRef.current;
      const item = pickerItemsRef.current[i];
      if (!view || !p || !item) return;
      if (p.kind === 'mention') {
        const target = usableTargets().find((t) => t.id === item.value);
        if (!target) return;
        const insert = `@${mentionSlug(target.label) || target.id} `;
        view.dispatch({ changes: { from: p.from, to: p.to, insert }, selection: { anchor: p.from + insert.length }, userEvent: 'input.complete' });
        setPicker(null);
        return;
      }
      pickDismissed.current = p.from;
      setPicker(null);
      openSource(item.value, null, { from: p.from, to: p.to });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openSource],
  );

  const pickerKeys = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'ArrowDown',
            run: () => {
              if (!pickerRef.current) return false;
              const n = pickerItemsRef.current.length;
              if (n) setPickIndex((i) => (i + 1) % n);
              return true;
            },
          },
          {
            key: 'ArrowUp',
            run: () => {
              if (!pickerRef.current) return false;
              const n = pickerItemsRef.current.length;
              if (n) setPickIndex((i) => (i - 1 + n) % n);
              return true;
            },
          },
          ...['Enter', 'Tab'].map((key) => ({
            key,
            run: () => {
              if (!pickerRef.current || !pickerItemsRef.current.length) return false;
              pickRef.current(pickIndexRef.current);
              return true;
            },
          })),
          {
            key: 'Escape',
            run: () => {
              const p = pickerRef.current;
              if (!p) return false;
              pickDismissed.current = p.from;
              setPicker(null);
              return true;
            },
          },
        ]),
      ),
    [],
  );
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const pickIndexRef = useRef(pickIndex);
  pickIndexRef.current = pickIndex;

  // ---- the source panel's inserts (R10) ----
  const closeSource = useCallback(() => {
    setSource(null);
    requestAnimationFrame(() => viewRef.current?.focus());
  }, []);

  /** Replace the typed `[[query` (if still there), else insert at the cursor. */
  const insertFromSource = (text: string, block: boolean) => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    const range = source?.insert;
    let from = view.state.selection.main.head;
    let to = from;
    if (range && range.to <= doc.length && /^\[\[[^\]\n]*$/.test(doc.slice(range.from, range.to))) {
      from = range.from;
      to = range.to;
    }
    let insert = text;
    if (block) {
      if (from > 0 && doc[from - 1] !== '\n') insert = `\n${insert}`;
      if (to < doc.length && doc[to] !== '\n') insert = `${insert}\n`;
    }
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input', scrollIntoView: true });
  };

  const quoteFromSource = (s: SourceSelection) => {
    const src = source;
    if (!src || typeof src.text !== 'string') return;
    const label = quoteLabel(src.path, src.text, s.lines[0]);
    const text = withTableHeader(src.text, s.lines, s.text);
    insertFromSource(quoteBlock(text, src.path, s.lines, label), true);
    cb.current.onQuote?.({ file: src.path, lines: s.lines, text, label });
    closeSource();
  };

  const linkFromSource = () => {
    const src = source;
    if (!src) return;
    insertFromSource(`[[${src.path}]]`, false);
    closeSource();
  };

  const openWikiRef = useRef<(link: WikiLink) => void>(() => {});
  const assetUrlRef = useRef<AssetUrl | undefined>(props.assetUrl);
  assetUrlRef.current = props.assetUrl;
  openWikiRef.current = (link: WikiLink) => {
    if (!cb.current.files) return;
    openSource(link.path, link.lines, null);
  };

  // ---- the row's actions (R1, R2, R3, R9) ----
  const currentSel = (): PageSelection | null => {
    const v = viewRef.current;
    if (!v) return null;
    const s = v.state.selection.main;
    return s.empty ? null : { from: s.from, to: s.to, text: v.state.sliceDoc(s.from, s.to) };
  };

  const runAction = (action: DeepRowAction) => {
    const view = viewRef.current;
    if (!view) return;
    const p = cb.current;
    const doc = view.state.doc.toString();
    const s = currentSel();
    if (action === 'table') {
      if (s) return;
      setCursorRow(false);
      insertTable(view);
      view.focus();
      return;
    }
    if (action === 'handoff') {
      if (!p.onHandOff) return;
      if (s) {
        p.onHandOff({ ...s, anchor: anchorFor(doc, s.from, s.to), sectionText: sectionTextAt(doc, s.from) });
      } else {
        const sec = sectionAtPos(sectionsOf(doc), view.state.selection.main.head);
        if (!sec) return;
        setCursorRow(false);
        p.onHandOff({ from: sec.from, to: sec.to, text: sec.text, anchor: anchorFor(doc, sec.from, sec.to), sectionText: sec.text.slice(0, SECTION_TEXT_MAX) });
      }
      return;
    }
    if (!s) return;
    if (action === 'ask') {
      const plan = askPlan(doc, s.from, s.to);
      if (plan.length) {
        if (p.onAskMany) p.onAskMany(plan.map((a) => ({ question: a.question, anchor: a.anchor, sectionText: a.sectionText })));
        else {
          for (const a of plan) {
            const at = a.anchor.kind === 'page' ? a.anchor.offset : s.from;
            p.onAction('ask', { from: at, to: at + a.question.length, text: a.question }, a.question);
          }
        }
        view.focus();
        return;
      }
      setAsking({ text: '' });
      requestAnimationFrame(() => askRef.current?.focus());
      return;
    }
    p.onAction(action, s);
    view.focus();
  };
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  // ---- ⌘.: the row, else the affordance's first option, else the cursor row ----
  const deepActions = useCallback((): boolean => {
    const now = Date.now();
    if (now - lastActions.current < 80) return true; // the keymap and the app hotkey both fired
    lastActions.current = now;
    const view = viewRef.current;
    if (!view) return false;
    if (!view.state.selection.main.empty) {
      const first = rowRef.current?.querySelector<HTMLButtonElement>('button');
      if (first) first.focus();
      return true;
    }
    const shown = aff.current.shown;
    if (shown) {
      pickAffordance(shown.aff.options[0]);
      return true;
    }
    setCursorRow(true);
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    return true;
  }, [pickAffordance]);

  useEffect(() => {
    if (!visible) return;
    return onDeepActions(() => {
      deepActions();
    });
  }, [visible, deepActions]);

  // ---- the view ----
  useEffect(() => {
    if (!hostRef.current) return;
    const len = initialText.length;
    const clamp = (n: number) => Math.max(0, Math.min(n, len));
    const selection = initialCursor ? EditorSelection.single(clamp(initialCursor.anchor), clamp(initialCursor.head)) : EditorSelection.cursor(len);
    const state = EditorState.create({
      doc: initialText,
      selection,
      extensions: [
        pageMarkdown(),
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        highlightSpecialChars(),
        // Through a ref: an in-memory Page gets its resolver once it becomes a card.
        liveFormatting((link) => openWikiRef.current(link), (name) => assetUrlRef.current?.(name) ?? Promise.resolve(null)),
        tableField,
        affordanceField((opt) => pickAffordance(opt)),
        mentionField(() => void sendMention()),
        pickerKeys,
        pageTheme,
        // Scrolling the cursor into view keeps it clear of the sticky toolbar.
        EditorView.scrollMargins.of(() => ({ top: 44 })),
        keymap.of([
          { key: 'Mod-.', run: () => deepActions() },
          {
            key: 'Mod-Enter',
            run: (v) => {
              if (!v.state.selection.main.empty) {
                runActionRef.current('ask');
                return true;
              }
              return sendMention();
            },
          },
          {
            key: 'Mod-s',
            run: () => {
              cb.current.onSave();
              return true;
            },
            preventDefault: true,
          },
          ...formatKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': 'Page', spellcheck: 'true' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !u.transactions.some((tr) => tr.annotation(remote))) {
            let last = 0;
            u.changes.iterChanges((_fa, _ta, _fb, tb) => {
              last = tb;
            });
            cb.current.onChange(u.state.doc.toString(), last);
          }
          if (u.docChanged) {
            setDocRev((n) => n + 1);
            setPlaced((pl) => {
              const anchors: Record<string, number> = {};
              for (const k of Object.keys(pl.anchors)) anchors[k] = u.changes.mapPos(pl.anchors[k], 1);
              const sections = pl.sections.map((s) => ({ ...s, from: u.changes.mapPos(s.from, -1), to: u.changes.mapPos(s.to, 1) }));
              return { ...pl, anchors, sections };
            });
          }
          if (u.selectionSet || u.docChanged) {
            const s = u.state.selection.main;
            setSel(s.empty ? null : { from: s.from, to: s.to, text: u.state.sliceDoc(s.from, s.to) });
            setCursorRow(false);
            trackCursorLine(u);
            trackMention(u.state);
            trackPicker(u.state);
          }
          if (u.docChanged || u.geometryChanged || u.viewportChanged || u.selectionSet) setLayout((n) => n + 1);
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    const a = aff.current;
    requestAnimationFrame(() => {
      if (initialCursor && scrollerRef.current) scrollerRef.current.scrollTop = initialCursor.scroll;
      else view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) });
      if (visible) view.focus();
    });
    return () => {
      if (a.timer) clearTimeout(a.timer);
      if (a.fade) clearTimeout(a.fade);
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once per mount (DeepHost remounts per exploration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back from a hop: focus returns to the text with cursor and selection as they were.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (visible) {
      if (!source) requestAnimationFrame(() => viewRef.current?.focus());
    } else {
      const el = document.activeElement as HTMLElement | null;
      if (el && scrollerRef.current?.parentElement?.contains(el)) el.blur();
      cb.current.onCursor({ anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scroll: scrollerRef.current?.scrollTop ?? 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ---- the margin's items: answers and hand-offs (R5), or D1's markers ----
  const sectionMode = props.answers != null;
  const items: MarkItem[] = useMemo(() => {
    if (!props.answers) return [];
    const out: MarkItem[] = [];
    const seen = new Set<string>();
    for (const a of props.answers) {
      if (a.dismissed_at) continue;
      seen.add(a.id);
      const isHandoff = a.kind === 'handoff' || !!a.handoff;
      out.push({
        id: a.id,
        state: sectionMarkState(a),
        label: isHandoff ? handoffLabel(a.handoff) : marginNoteLabel(markerState(a)),
        question: a.question,
        answer: a,
      });
    }
    // Asks queued while Hester was offline aren't answers yet.
    for (const m of markers) if (!seen.has(m.id)) out.push({ id: m.id, state: m.state, label: marginNoteLabel(m.state, m.queued), question: m.question });
    return out;
  }, [props.answers, markers]);
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const anchorOf = useCallback(
    (id: string): Anchor | undefined => itemMap.get(id)?.answer?.anchor ?? markers.find((m) => m.id === id)?.anchor,
    [itemMap, markers],
  );
  const ids = sectionMode ? items.map((i) => i.id) : markers.map((m) => m.id);

  // Re-anchor (debounced; positions are mapped through edits in between).
  const anchorKey = ids
    .map((id) => {
      const an = anchorOf(id);
      return `${id}:${an && an.kind === 'page' ? an.offset : 'n'}`;
    })
    .join(',');
  const promptKey = (props.marginPrompts ?? []).join('\n');
  useEffect(() => {
    const t = setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      const text = view.state.doc.toString();
      const anchors: Record<string, number> = {};
      for (const id of ids) anchors[id] = locateAnchor(text, anchorOf(id)).pos;
      const sections = sectionsOf(text);
      const answered = (cb.current.marginPrompts ?? []).filter((p) => promptAnswered(p, sections));
      setPlaced({ anchors, sections, answered });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, docRev, promptKey]);

  const marks = useMemo(
    () =>
      sectionMode
        ? aggregateMarks(
            placed.sections,
            items.filter((i) => placed.anchors[i.id] != null).map((i) => ({ id: i.id, state: i.state, pos: placed.anchors[i.id] })),
          )
        : [],
    [sectionMode, placed, items],
  );

  const prompts = props.marginPrompts ?? [];
  const showPrompts = prompts.length > 0;
  const answeredSet = useMemo(() => new Set(placed.answered), [placed.answered]);

  // Slots in the margin: [key, doc position].
  const slots: Array<[string, number]> = [];
  if (showPrompts) slots.push(['prompts', 0]);
  if (sectionMode) for (const m of marks) slots.push([`mark:${m.key}`, m.from]);
  else for (const m of markers) if (placed.anchors[m.id] != null) slots.push([`note:${m.id}`, placed.anchors[m.id]]);
  const slotKey = slots.map(([k, p]) => `${k}@${p}`).join(',');

  useImperativeHandle(
    ref,
    (): PageEditorHandle => ({
      focus: () => viewRef.current?.focus(),
      getText: () => viewRef.current?.state.doc.toString() ?? '',
      getSelection: () => {
        const v = viewRef.current;
        if (!v) return null;
        const s = v.state.selection.main;
        return s.empty ? null : { from: s.from, to: s.to, text: v.state.sliceDoc(s.from, s.to) };
      },
      replaceAll: (text: string) => {
        const v = viewRef.current;
        if (!v) return;
        const head = Math.min(v.state.selection.main.head, text.length);
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: head }, annotations: remote.of(true) });
      },
      insert: (from: number, text: string) => {
        const v = viewRef.current;
        if (!v) return;
        const at = Math.max(0, Math.min(from, v.state.doc.length));
        v.dispatch({ changes: { from: at, insert: text }, userEvent: 'input' });
      },
      remove: (from: number, to: number) => {
        const v = viewRef.current;
        if (!v) return;
        const a = Math.max(0, Math.min(from, v.state.doc.length));
        const b = Math.max(a, Math.min(to, v.state.doc.length));
        v.dispatch({ changes: { from: a, to: b }, userEvent: 'delete' });
      },
      reveal: (pos: number) => {
        const v = viewRef.current;
        if (!v) return;
        const at = Math.max(0, Math.min(pos, v.state.doc.length));
        v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
      },
      cursor: () => {
        const v = viewRef.current;
        const s = v?.state.selection.main;
        return { anchor: s?.anchor ?? 0, head: s?.head ?? 0, scroll: scrollerRef.current?.scrollTop ?? 0 };
      },
    }),
    [],
  );

  // Positions for the margin, the row and the picker, from the view's geometry.
  type Geo = { slots: Record<string, number>; row: { top: number; left: number } | null; picker: { top: number; left: number } | null };
  const [geo, setGeo] = useState<Geo>({ slots: {}, row: null, picker: null });
  const rowShown = !!sel || cursorRow;
  useLayoutEffect(() => {
    const v = viewRef.current;
    const inner = innerRef.current;
    if (!v || !inner) return;
    const innerRect = inner.getBoundingClientRect();
    const editorTop = v.documentTop - innerRect.top;
    const tops: Record<string, number> = {};
    for (const [key, pos] of slots) {
      const at = Math.min(pos, v.state.doc.length);
      tops[key] = key === 'prompts' ? Math.round(editorTop) : Math.round(editorTop + v.lineBlockAt(at).top);
    }
    const hostRect = hostRef.current?.getBoundingClientRect();
    const place = (pos: number, width: number): { top: number; left: number } | null => {
      const c = v.coordsAtPos(pos);
      if (!c || !hostRect) return null;
      const maxLeft = hostRect.right - innerRect.left - width;
      return { top: Math.round(c.bottom - innerRect.top + 6), left: Math.round(Math.max(hostRect.left - innerRect.left, Math.min(c.left - innerRect.left, maxLeft))) };
    };
    let row: Geo['row'] = null;
    if (sel) row = place(sel.to, ROW_WIDTH) ?? place(sel.from, ROW_WIDTH);
    else if (cursorRow) row = place(v.state.selection.main.head, ROW_WIDTH);
    const pk = picker ? place(picker.from, 320) : null;
    const next: Geo = { slots: tops, row, picker: pk };
    setGeo((g) => (JSON.stringify(g) === JSON.stringify(next) ? g : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, slotKey, sel, cursorRow, visible, picker, source]);

  // Notes stack: one that would overlap the note above it moves down (the
  // open one is taller). Set on the DOM after layout, so it never loops.
  const slotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useLayoutEffect(() => {
    const placedSlots = Object.keys(geo.slots)
      .filter((k) => slotRefs.current.has(k))
      .sort((a, b) => geo.slots[a] - geo.slots[b] || (a === 'prompts' ? -1 : b === 'prompts' ? 1 : 0));
    let floor = -Infinity;
    for (const k of placedSlots) {
      const el = slotRefs.current.get(k)!;
      const top = Math.max(geo.slots[k], floor);
      el.style.top = `${top}px`;
      floor = top + el.offsetHeight + 8;
    }
  });
  const slotRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) slotRefs.current.set(key, el);
    else slotRefs.current.delete(key);
  };

  // The row goes when the selection empties; so does its Ask field.
  useEffect(() => {
    if (!sel) setAsking(null);
  }, [sel]);

  const onRowKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = deepRowKey(e.key, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey });
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.kind === 'escape') {
      setCursorRow(false);
      viewRef.current?.focus();
    } else if (k.kind === 'action') {
      if (rowButtons.some((b) => b.action === k.action)) runAction(k.action);
    } else {
      const btns = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + k.delta + btns.length) % btns.length]?.focus();
    }
  };

  const submitAsk = () => {
    const view = viewRef.current;
    const s = sel;
    if (!view || !s || !asking) return;
    const q = asking.text.trim();
    const p = cb.current;
    if (p.onAskMany) {
      const doc = view.state.doc.toString();
      p.onAskMany([{ question: q || 'Explain this.', anchor: anchorFor(doc, s.from, s.to), sectionText: sectionTextAt(doc, s.from) }]);
    } else p.onAction('ask', s, q);
    setAsking(null);
    view.focus();
  };

  // The row's buttons for this moment.
  const questions = useMemo(() => {
    const v = viewRef.current;
    return sel && v ? askPlan(v.state.doc.toString(), sel.from, sel.to).length : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  const rowButtons: RowButton[] = [];
  if (sel) {
    rowButtons.push(
      questions
        ? {
            action: 'ask',
            label: 'Ask Hester',
            mnemonic: 'a',
            title: questions > 1 ? `Ask the ${questions} questions, each on its own; answers arrive quietly in the margin (⌘⏎)` : 'Ask this, as written; the answer arrives quietly in the margin (⌘⏎)',
          }
        : { action: 'ask', label: 'Ask about this…', mnemonic: 'a', title: 'Ask Hester about this; the answer arrives quietly in the margin (⌘⏎)' },
    );
    if (props.onHandOff) rowButtons.push({ action: 'handoff', label: 'Hand off', mnemonic: 'h', title: 'Hand this to an agent: Spike, Docs or Research' });
    // Ask and Hand off only (2026-09-28): references come from [[ quotes, ideas are
    // captured from the Drawer, and a table is on the formatting toolbar.
  } else if (cursorRow) {
    if (props.onHandOff) rowButtons.push({ action: 'handoff', label: 'Hand off', mnemonic: 'h', title: 'Hand this section to an agent: Spike, Docs or Research' });
  }

  // The toolbar's state: the cursor line's kind and whether it's in a table
  // (read on every render; the view re-renders this on each selection change).
  const toolbar: ToolbarState = (() => {
    const v = viewRef.current;
    if (!v) return { kind: 'paragraph', quoted: false, inTable: false };
    const parts = lineParts(v.state.doc.lineAt(v.state.selection.main.head).text);
    return { kind: parts.kind, quoted: parts.quoted, inTable: inTable(v) };
  })();
  const runFormat = (id: FormatId) => {
    const v = viewRef.current;
    if (!v) return;
    formatCommand(id).run(v);
    v.focus();
  };

  return (
    <div className={`deep-page-wrap${source ? ' has-source' : ''}`}>
      <div className="deep-page-scroller" ref={scrollerRef}>
        <div className="deep-page-inner" ref={innerRef}>
          <div className="deep-page-column">
            <PageToolbar state={toolbar} run={runFormat} onExit={() => viewRef.current?.focus()} />
            <div ref={hostRef} className="deep-page-cm" />
          </div>
          <div className="deep-margin" aria-label="Answers in the margin">
            {showPrompts && (
              <div ref={slotRef('prompts')} className="deep-marker-slot deep-prompts-slot" style={{ top: geo.slots.prompts ?? 0 }}>
                <MarginPrompts prompts={prompts} answered={answeredSet} dismissed={dismissedPrompts} onDismiss={(p) => setDismissedPrompts((d) => new Set(d).add(p))} />
              </div>
            )}
            {sectionMode
              ? marks.map((m) => {
                  const key = `mark:${m.key}`;
                  const top = geo.slots[key];
                  if (top == null) return null;
                  const open = openSection === m.key || m.ids.includes(openMarker ?? '');
                  return (
                    <div key={key} ref={slotRef(key)} className={`deep-marker-slot${open ? ' is-open' : ''}`} style={{ top }}>
                      <SectionMarkView
                        mark={m}
                        items={itemMap}
                        listOpen={openSection === m.key}
                        onToggleList={() => setOpenSection((k) => (k === m.key ? null : m.key))}
                        openMarker={openMarker}
                        onItemClick={onMarkerClick}
                        renderCard={renderCard}
                        onOpenInWork={props.onOpenInWork}
                        onReplyHandoff={props.onReplyHandoff}
                      />
                    </div>
                  );
                })
              : markers.map((m) => {
                  const key = `note:${m.id}`;
                  const top = geo.slots[key];
                  if (top == null) return null;
                  const open = openMarker === m.id;
                  return (
                    <div key={key} ref={slotRef(key)} className={`deep-marker-slot${open ? ' is-open' : ''}`} style={{ top }}>
                      <button
                        type="button"
                        className={`deep-note is-${m.state}`}
                        tabIndex={-1}
                        aria-expanded={open}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onMarkerClick(m.id)}
                      >
                        <span className="deep-note-head">
                          <span className={`deep-marker is-${m.state}`} aria-hidden="true">
                            {m.state === 'pending' && <span className="deep-marker-spin" />}
                          </span>
                          {marginNoteLabel(m.state, m.queued)}
                        </span>
                        <span className="deep-note-q">{m.question}</span>
                      </button>
                      {open && <div className="deep-card">{renderCard(m.id)}</div>}
                    </div>
                  );
                })}
          </div>
          {rowShown && geo.row && rowButtons.length > 0 && (
            <div className="deep-row-slot" style={{ top: geo.row.top, left: geo.row.left }}>
              <div className="deep-row" ref={rowRef} role="toolbar" aria-label="Actions (⌘.)" onKeyDown={onRowKey}>
                {rowButtons.map((a) => (
                  <button
                    key={a.action}
                    type="button"
                    className="deep-row-btn"
                    title={a.title}
                    aria-keyshortcuts={a.mnemonic}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runAction(a.action)}
                  >
                    {mnemonicLabel(a.label, a.mnemonic)}
                  </button>
                ))}
                <kbd className="deep-row-hint" title="⌘. puts the keyboard in this row; then press an underlined letter. Esc goes back to the Page">
                  ⌘.
                </kbd>
              </div>
              {asking && (
                <input
                  ref={askRef}
                  className="deep-ask-input"
                  value={asking.text}
                  placeholder="Ask about this… (Enter asks “Explain this.”)"
                  onChange={(e) => setAsking({ text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitAsk();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setAsking(null);
                      viewRef.current?.focus();
                    }
                  }}
                />
              )}
              {asking && props.voiceWorkspace && (
                <MicButton
                  workspace={props.voiceWorkspace}
                  purpose="ask"
                  value={asking.text}
                  onChange={(t) => setAsking({ text: t })}
                  fieldRef={askRef}
                  className="deep-ask-mic"
                />
              )}
            </div>
          )}
          {picker && geo.picker && (
            <PagePicker
              items={pickerItems}
              index={Math.min(pickIndex, Math.max(0, pickerItems.length - 1))}
              top={geo.picker.top}
              left={geo.picker.left}
              label={picker.kind === 'wiki' ? 'Workspace files' : 'Mention'}
              empty={picker.kind === 'wiki' ? (fileList == null ? 'Loading files…' : 'No matching files') : 'No one by that name'}
              onPick={pick}
              onHover={setPickIndex}
            />
          )}
        </div>
      </div>
      {source && (
        <SourcePanel path={source.path} text={source.text} lines={source.lines} onQuote={quoteFromSource} onLink={linkFromSource} onClose={closeSource} />
      )}
    </div>
  );
});

export default PageEditor;
