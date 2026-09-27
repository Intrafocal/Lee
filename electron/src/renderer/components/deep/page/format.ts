/**
 * format - the Page's formatting keys and Insert table (Deep next R9).
 *
 * ⌘B bold, ⌘I italic, ⌘⇧K inline code, ⌘⌥C code block, on the Page only.
 * Checked against CodeMirror's defaults: ⌘I (selectParentSyntax) and ⌘⇧K
 * (deleteLine) are overridden on the Page; ⌘B and ⌘⌥C are free.
 *
 * The app's hotkeys listen on window in the capture phase, so ⌘I (idle tabs)
 * and ⌘⇧K (k9s) would never reach CodeMirror. installPageKeyGuard adds one
 * window capture listener at module load, before App mounts, so it runs
 * first: when the Page's editor has focus it runs the command and stops the
 * event there. Nothing else in the app sees these four chords from the Page.
 */

import { EditorView } from '@codemirror/view';
import { codeBlockToggle, tableInsertion, wrapToggle, type TextEdit } from '../../../lib/deepModel';

export function applyEdit(view: EditorView, e: TextEdit): void {
  view.dispatch({
    changes: e.changes,
    selection: { anchor: e.selFrom, head: e.selTo },
    userEvent: 'input.format',
    scrollIntoView: true,
  });
}

const wrap = (marker: string) => (view: EditorView): boolean => {
  const s = view.state.selection.main;
  applyEdit(view, wrapToggle(view.state.doc.toString(), s.from, s.to, marker));
  return true;
};

export const toggleBold = wrap('**');
export const toggleItalic = wrap('*');
export const toggleInlineCode = wrap('`');

export function toggleCodeBlock(view: EditorView): boolean {
  const s = view.state.selection.main;
  applyEdit(view, codeBlockToggle(view.state.doc.toString(), s.from, s.to));
  return true;
}

export function insertTable(view: EditorView): boolean {
  applyEdit(view, tableInsertion(view.state.doc.toString(), view.state.selection.main.head));
  return true;
}

/** The Page's formatting keymap (also run by the guard below). */
export const formatKeymap = [
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-Shift-k', run: toggleInlineCode, preventDefault: true },
  { key: 'Mod-Alt-c', run: toggleCodeBlock, preventDefault: true },
];

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** The command for a keydown on the Page, or null. Physical keys, so ⌥C (ç) still counts. */
function pageCommand(e: KeyboardEvent): ((view: EditorView) => boolean) | null {
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const code = e.code;
  if (!e.shiftKey && !e.altKey && code === 'KeyB') return toggleBold;
  if (!e.shiftKey && !e.altKey && code === 'KeyI') return toggleItalic;
  if (e.shiftKey && !e.altKey && code === 'KeyK') return toggleInlineCode;
  if (!e.shiftKey && e.altKey && code === 'KeyC') return toggleCodeBlock;
  return null;
}

let installed = false;

/** Once per renderer: see the Page's formatting chords before the app's hotkeys do. */
export function installPageKeyGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'keydown',
    (e) => {
      const cmd = pageCommand(e);
      if (!cmd) return;
      const el = document.activeElement as HTMLElement | null;
      const content = el?.closest?.('.deep-page-cm .cm-content') as HTMLElement | null;
      if (!content) return;
      const view = EditorView.findFromDOM(content);
      if (!view) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cmd(view);
    },
    true,
  );
}

// At module load: PageEditor imports this before App's hotkeys register.
installPageKeyGuard();
