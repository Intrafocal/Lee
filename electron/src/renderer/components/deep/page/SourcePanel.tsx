/**
 * SourcePanel - a workspace file, read-only, beside the Page (Deep next R10).
 *
 * At most half the width; it never takes over the Page. Markdown renders
 * with the Page's live formatting (its marks show only where you select),
 * code files get their language when one is installed. Highlight text, then
 * Quote it (or ⌘⏎ / Enter); Enter with nothing highlighted inserts a link to
 * the file. Esc closes and returns to the Page.
 */

import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { lineRangeOf } from '../../../lib/deepModel';
import { languageForPath, liveFormatting, tableField } from './liveMarkdown';

export interface SourceSelection {
  from: number;
  to: number;
  text: string;
  lines: [number, number];
}

interface SourcePanelProps {
  path: string;
  /** undefined while loading, null when it couldn't be read. */
  text: string | null | undefined;
  /** Lines to show and select (from a clicked `[[path#La-Lb]]`). */
  lines: [number, number] | null;
  onQuote: (sel: SourceSelection) => void;
  onLink: () => void;
  onClose: () => void;
}

const panelTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-1)', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-write)', lineHeight: '1.6' },
  '.cm-content': { padding: 'var(--space-3) 0 30vh', fontSize: '16px', caretColor: 'transparent' },
  '.cm-line': { padding: '0 var(--space-4)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--selection)',
  },
});

export function SourcePanel({ path, text, lines, onQuote, onLink, onClose }: SourcePanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const cb = useRef({ onQuote, onLink, onClose });
  cb.current = { onQuote, onLink, onClose };
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path);

  const currentSel = (): SourceSelection | null => {
    const v = viewRef.current;
    if (!v) return null;
    const s = v.state.selection.main;
    if (s.empty) return null;
    const doc = v.state.doc.toString();
    return { from: s.from, to: s.to, text: v.state.sliceDoc(s.from, s.to), lines: lineRangeOf(doc, s.from, s.to) };
  };

  useEffect(() => {
    if (!hostRef.current || typeof text !== 'string') return;
    const lang = new Compartment();
    const doc = text;
    let selection: EditorSelection | undefined;
    if (lines) {
      const total = doc.split('\n').length;
      const a = Math.max(1, Math.min(lines[0], total));
      const b = Math.max(a, Math.min(lines[1], total));
      const starts = [0];
      for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') starts.push(i + 1);
      const from = starts[a - 1];
      const to = b < starts.length ? starts[b] - 1 : doc.length;
      selection = EditorSelection.single(from, Math.max(from, to));
    }
    const state = EditorState.create({
      doc,
      selection,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        drawSelection(),
        panelTheme,
        lang.of([]),
        ...(isMarkdown ? [liveFormatting(() => {}), tableField] : []),
        keymap.of([
          {
            key: 'Escape',
            run: () => {
              cb.current.onClose();
              return true;
            },
          },
          {
            key: 'Enter',
            run: () => {
              const s = currentSel();
              if (s) cb.current.onQuote(s);
              else cb.current.onLink();
              return true;
            },
          },
          {
            key: 'Mod-Enter',
            run: () => {
              const s = currentSel();
              if (s) cb.current.onQuote(s);
              return true;
            },
          },
        ]),
        EditorView.contentAttributes.of({ 'aria-label': `Source: ${path}`, tabindex: '0' }),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) setSel(currentSel());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    setSel(currentSel());
    let cancelled = false;
    languageForPath(path).then((ext) => {
      if (!cancelled && ext && viewRef.current === view) view.dispatch({ effects: lang.reconfigure(ext) });
    });
    requestAnimationFrame(() => {
      if (viewRef.current !== view) return;
      if (selection) view.dispatch({ effects: EditorView.scrollIntoView(selection.main.from, { y: 'start', yMargin: 48 }) });
      view.focus();
    });
    return () => {
      cancelled = true;
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // Rebuilt when the file or the requested lines change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, text, lines?.[0], lines?.[1]]);

  return (
    <aside
      className="deep-source"
      aria-label={`Source: ${path}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="deep-source-head">
        <span className="deep-source-path" title={path}>
          {path}
        </span>
        <span className="deep-spacer" />
        {sel ? (
          <button type="button" className="deep-quiet" onMouseDown={(e) => e.preventDefault()} onClick={() => onQuote(sel)} title="Insert it on the Page as a quote (⏎)">
            Quote it{sel.lines[0] === sel.lines[1] ? ` · L${sel.lines[0]}` : ` · L${sel.lines[0]}–${sel.lines[1]}`}
          </button>
        ) : (
          <button type="button" className="deep-quiet" onMouseDown={(e) => e.preventDefault()} onClick={onLink} title="Insert a link to this file (⏎)">
            Link it
          </button>
        )}
        <button type="button" className="deep-icon-btn" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      {text === undefined && <div className="deep-source-note deep-muted">Opening…</div>}
      {text === null && <div className="deep-source-note deep-muted">Couldn’t read {path}.</div>}
      <div ref={hostRef} className={`deep-source-cm${isMarkdown ? ' is-markdown' : ' is-code'}`} />
    </aside>
  );
}

export default SourcePanel;
