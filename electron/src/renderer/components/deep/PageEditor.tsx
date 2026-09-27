/**
 * PageEditor - the Page (Deep D1 §4.2): a prose CodeMirror for the
 * exploration's page.md, built from EditorPanel's pieces rather than
 * EditorPanel itself.
 *
 * - markdown(), line wrapping, history, drawSelection, highlightSpecialChars
 *   and the default/history/search keymaps. No line numbers, fold or
 *   active-line gutter, autocompletion or crosshair cursor.
 * - A centred column (~72ch) themed from the design tokens, and a margin
 *   column outside it with one marker per answer at its re-anchored line.
 *   Nothing in the margin moves the text or takes focus unless clicked.
 * - The selection action row (§5) beside a non-empty selection; ⌘. moves
 *   focus into it, c/k/a/e pick, Esc returns with the selection intact.
 * - Typing affordances (§7): a dim inline widget at the end of the cursor's
 *   line, after 400 ms on a matching line; fades after 5 s, on typing more on
 *   the line, or on leaving it. ⌘. with no selection takes its first option.
 * - ⌘E toggles a live preview (scoped to the Page); ⌘S saves now.
 *
 * The component owns the view; DeepHost owns the data and the calls.
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Annotation, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  drawSelection,
  highlightSpecialChars,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import type { Anchor } from '../../../shared/cockpit';
import {
  AFFORDANCE_DELAY_MS,
  AFFORDANCE_FADE_MS,
  affordanceFor,
  deepRowKey,
  locateAnchor,
  type Affordance,
  type AffordanceOption,
  type DeepRowAction,
} from '../../lib/deepModel';
import { MarkdownPreview } from '../MarkdownPreview';
import { onDeepActions } from './deepBridge';

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

// ---------------------------------------------------------------------------
// Headings and quotes get line classes (no highlight style: plain prose)
// ---------------------------------------------------------------------------

const lineClasses = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          const h = /^(#{1,6})\s/.exec(line.text);
          if (h) b.add(line.from, line.from, Decoration.line({ class: `deep-h deep-h${h[1].length}` }));
          else if (/^\s*>/.test(line.text)) b.add(line.from, line.from, Decoration.line({ class: 'deep-quote' }));
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const pageTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-1)', height: 'auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--font-ui)', lineHeight: '1.7' },
  '.cm-content': { padding: 'var(--space-5) 0 40vh', caretColor: 'var(--phosphor-hi)', fontSize: '15px' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--phosphor-hi)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(var(--phosphor-rgb), 0.28)',
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
}

const ROW_ACTIONS: Array<{ action: DeepRowAction; key: string; label: string; title: string }> = [
  { action: 'capture', key: 'c', label: 'Capture', title: 'Save to Someday with where it came from' },
  { action: 'keep', key: 'k', label: 'Keep', title: 'Add to this exploration’s references' },
  { action: 'ask', key: 'a', label: 'Ask', title: 'Ask Hester; the answer arrives quietly in the margin' },
  { action: 'explore', key: 'e', label: 'Explore', title: 'Start a linked exploration (doesn’t switch)' },
];

export const PageEditor = forwardRef<PageEditorHandle, PageEditorProps>(function PageEditor(props, ref) {
  const { initialText, initialCursor, visible, markers, openMarker, onMarkerClick, renderCard } = props;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const askRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const cb = useRef(props);
  cb.current = props;

  const [layout, setLayout] = useState(0);
  const [sel, setSel] = useState<PageSelection | null>(null);
  const [asking, setAsking] = useState<{ text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [anchorPos, setAnchorPos] = useState<Record<string, number>>({});
  const [docRev, setDocRev] = useState(0);

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
    [hideAffordance],
  );

  // ---- ⌘.: the row, else the affordance's first option ----
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
    return false;
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
        markdown(),
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        highlightSpecialChars(),
        lineClasses,
        affordanceField((opt) => pickAffordance(opt)),
        pageTheme,
        keymap.of([
          { key: 'Mod-.', run: () => deepActions() },
          {
            key: 'Mod-s',
            run: () => {
              cb.current.onSave();
              return true;
            },
            preventDefault: true,
          },
          {
            key: 'Mod-e',
            run: (v) => {
              setPreview(v.state.doc.toString());
              return true;
            },
            preventDefault: true,
          },
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
            setAnchorPos((m) => {
              const next: Record<string, number> = {};
              for (const k of Object.keys(m)) next[k] = u.changes.mapPos(m[k], 1);
              return next;
            });
          }
          if (u.selectionSet || u.docChanged) {
            const s = u.state.selection.main;
            setSel(s.empty ? null : { from: s.from, to: s.to, text: u.state.sliceDoc(s.from, s.to) });
            trackCursorLine(u);
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
      if (preview == null) requestAnimationFrame(() => viewRef.current?.focus());
    } else {
      const el = document.activeElement as HTMLElement | null;
      if (el && scrollerRef.current?.contains(el)) el.blur();
      cb.current.onCursor({ anchor: view.state.selection.main.anchor, head: view.state.selection.main.head, scroll: scrollerRef.current?.scrollTop ?? 0 });
    }
  }, [visible, preview]);

  // Re-anchor the markers (debounced; positions are mapped through edits in between).
  const markerKey = markers.map((m) => `${m.id}:${m.anchor.kind === 'page' ? m.anchor.offset : 'n'}`).join(',');
  useEffect(() => {
    const id = setTimeout(() => {
      const view = viewRef.current;
      if (!view) return;
      const text = view.state.doc.toString();
      const next: Record<string, number> = {};
      for (const m of cb.current.markers) next[m.id] = locateAnchor(text, m.anchor).pos;
      setAnchorPos(next);
    }, 250);
    return () => clearTimeout(id);
  }, [markerKey, docRev]);

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

  // Positions for the margin and the row, from the view's geometry.
  const [geo, setGeo] = useState<{ markers: Record<string, number>; row: { top: number; left: number } | null }>({ markers: {}, row: null });
  useLayoutEffect(() => {
    const v = viewRef.current;
    const inner = innerRef.current;
    if (!v || !inner) return;
    const editorTop = v.documentTop - inner.getBoundingClientRect().top;
    const tops: Record<string, number> = {};
    for (const m of markers) {
      const pos = anchorPos[m.id];
      if (pos == null) continue;
      const at = Math.min(pos, v.state.doc.length);
      tops[m.id] = Math.round(editorTop + v.lineBlockAt(at).top);
    }
    let row: { top: number; left: number } | null = null;
    if (sel) {
      const c = v.coordsAtPos(sel.to) ?? v.coordsAtPos(sel.from);
      const hostRect = hostRef.current?.getBoundingClientRect();
      const innerRect = inner.getBoundingClientRect();
      if (c && hostRect) {
        const maxLeft = hostRect.right - innerRect.left - 280;
        row = { top: Math.round(c.bottom - innerRect.top + 6), left: Math.round(Math.max(hostRect.left - innerRect.left, Math.min(c.left - innerRect.left, maxLeft))) };
      }
    }
    setGeo((g) => (JSON.stringify(g) === JSON.stringify({ markers: tops, row }) ? g : { markers: tops, row }));
  }, [layout, anchorPos, markers, sel, visible, preview]);

  // The row goes when the selection empties; so does its Ask field.
  useEffect(() => {
    if (!sel) setAsking(null);
  }, [sel]);

  const runAction = (action: DeepRowAction) => {
    const s = sel;
    if (!s) return;
    if (action === 'ask') {
      setAsking({ text: '' });
      requestAnimationFrame(() => askRef.current?.focus());
      return;
    }
    cb.current.onAction(action, s);
    viewRef.current?.focus();
  };

  const onRowKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = deepRowKey(e.key, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey });
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (k.kind === 'escape') viewRef.current?.focus();
    else if (k.kind === 'action') runAction(k.action);
    else {
      const btns = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + k.delta + btns.length) % btns.length]?.focus();
    }
  };

  const submitAsk = () => {
    if (!sel || !asking) return;
    cb.current.onAction('ask', sel, asking.text.trim());
    setAsking(null);
    viewRef.current?.focus();
  };

  const closePreview = () => {
    setPreview(null);
  };

  useEffect(() => {
    if (preview != null) requestAnimationFrame(() => previewRef.current?.focus());
  }, [preview]);

  return (
    <div className="deep-page-scroller" ref={scrollerRef}>
      <div className="deep-page-inner" ref={innerRef}>
        <div className="deep-page-column" style={preview != null ? { display: 'none' } : undefined}>
          <div ref={hostRef} className="deep-page-cm" />
        </div>
        {preview != null && (
          <div
            className="deep-page-column deep-page-preview"
            ref={previewRef}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.metaKey && (e.key === 'e' || e.key === 'E' || e.key === 'Escape')) {
                e.preventDefault();
                e.stopPropagation();
                closePreview();
              }
            }}
          >
            <div className="deep-preview-hint">Preview · ⌘E to write</div>
            <MarkdownPreview content={preview} />
          </div>
        )}
        <div className="deep-margin" aria-label="Answers in the margin">
          {preview == null &&
            markers.map((m) => {
              const top = geo.markers[m.id];
              if (top == null) return null;
              const open = openMarker === m.id;
              return (
                <div key={m.id} className={`deep-marker-slot${open ? ' is-open' : ''}`} style={{ top }}>
                  <button
                    type="button"
                    className={`deep-marker is-${m.state}`}
                    tabIndex={-1}
                    title={m.state === 'pending' ? 'Asking…' : m.state === 'unread' ? 'An answer arrived' : m.state === 'error' ? 'The ask failed' : 'Answer'}
                    aria-label="Answer"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onMarkerClick(m.id)}
                  >
                    {m.state === 'pending' && <span className="deep-marker-spin" />}
                  </button>
                  {open && <div className="deep-card">{renderCard(m.id)}</div>}
                </div>
              );
            })}
        </div>
        {preview == null && sel && geo.row && (
          <div className="deep-row-slot" style={{ top: geo.row.top, left: geo.row.left }}>
            <div className="deep-row" ref={rowRef} role="toolbar" aria-label="Selection actions (⌘.)" onKeyDown={onRowKey}>
              {ROW_ACTIONS.map((a) => (
                <button
                  key={a.action}
                  type="button"
                  className="deep-row-btn"
                  title={a.title}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAction(a.action)}
                >
                  <span className="deep-row-key">{a.key}</span>
                  {a.label}
                </button>
              ))}
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
          </div>
        )}
      </div>
    </div>
  );
});

export default PageEditor;
