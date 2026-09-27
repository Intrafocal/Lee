/**
 * format - the Page's formatting commands and their chords (Deep next R9,
 * and the Page's toolbar). One table, FORMAT_COMMANDS, feeds the toolbar's
 * buttons and tooltips, CodeMirror's keymap and the key guard below.
 *
 *   ⌘B bold · ⌘I italic · ⌘⇧X strikethrough · ⌘⇧K inline code · ⌘K link
 *   ⌥⌘1 / ⌥⌘2 / ⌥⌘3 heading 1–3
 *   ⌥⌘U bullet list · ⌥⌘O numbered list · ⌥⌘X task list · ⌥⌘Q quote
 *   ⌥⌘C code block · ⌥⌘T table (in a table: add row) · ⇧⌥⌘T add column
 *   ⌥⌘- horizontal rule
 *
 * The ⌥⌘ family follows Typora (whose ⌥⌘C code block the Page already
 * had); headings take ⌥⌘1–3 because Lee owns ⌘1–⌘9. Checked against
 * CodeMirror's default and search keymaps (⌘I selectParentSyntax and ⌘⇧K
 * deleteLine are overridden on the Page; the rest are free), macOS's text
 * chords and the app's menu (⌘- zoom out, ⌥⌘I dev tools: not taken), and
 * Lee's registry (src/shared/shortcuts.ts): only ⌘I (idle tabs) and ⌘⇧K
 * (k9s) are Lee's, and only inside the Page's text. ⌘0–⌘9, ⌘., ⌘W, ⌘/ and
 * ⌥⌘0 are left alone.
 *
 * The app's hotkeys listen on window in the capture phase, so ⌘I and ⌘⇧K
 * would never reach CodeMirror. installPageKeyGuard adds one window capture
 * listener at module load, before App mounts, so it runs first: when the
 * Page's editor has focus it runs the command and stops the event there.
 * Nothing else in the app sees these chords from the Page.
 */

import { EditorView } from '@codemirror/view';
import {
  codeBlockToggle,
  linePrefixToggle,
  linkToggle,
  ruleInsertion,
  tableAddColumn,
  tableAddRow,
  tableAt,
  tableInsertion,
  wrapToggle,
  type PrefixKind,
  type TextEdit,
} from '../../../lib/deepModel';

export function applyEdit(view: EditorView, e: TextEdit): void {
  view.dispatch({
    changes: e.changes,
    selection: { anchor: e.selFrom, head: e.selTo },
    userEvent: 'input.format',
    scrollIntoView: true,
  });
}

type Command = (view: EditorView) => boolean;

const doc = (view: EditorView) => view.state.doc.toString();

const wrap =
  (marker: string): Command =>
  (view) => {
    const s = view.state.selection.main;
    applyEdit(view, wrapToggle(doc(view), s.from, s.to, marker));
    return true;
  };

const prefix =
  (kind: PrefixKind): Command =>
  (view) => {
    const s = view.state.selection.main;
    applyEdit(view, linePrefixToggle(doc(view), s.from, s.to, kind));
    return true;
  };

export const toggleBold = wrap('**');
export const toggleItalic = wrap('*');
export const toggleStrike = wrap('~~');
export const toggleInlineCode = wrap('`');

export function toggleLink(view: EditorView): boolean {
  const s = view.state.selection.main;
  applyEdit(view, linkToggle(doc(view), s.from, s.to));
  return true;
}

export function toggleCodeBlock(view: EditorView): boolean {
  const s = view.state.selection.main;
  applyEdit(view, codeBlockToggle(doc(view), s.from, s.to));
  return true;
}

export function insertTable(view: EditorView): boolean {
  applyEdit(view, tableInsertion(doc(view), view.state.selection.main.head));
  return true;
}

export function insertRule(view: EditorView): boolean {
  applyEdit(view, ruleInsertion(doc(view), view.state.selection.main.head));
  return true;
}

/** Whether the cursor is in a GFM table (the toolbar's table button then offers Add row / Add column). */
export function inTable(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!line.text.includes('|')) return false;
  return tableAt(doc(view), view.state.selection.main.head) != null;
}

export function addTableRow(view: EditorView): boolean {
  const e = tableAddRow(doc(view), view.state.selection.main.head);
  if (!e) return false;
  applyEdit(view, e);
  return true;
}

export function addTableColumn(view: EditorView): boolean {
  const e = tableAddColumn(doc(view), view.state.selection.main.head);
  if (!e) return false;
  applyEdit(view, e);
  return true;
}

/** ⌥⌘T: a new table, or in a table another row. */
export function tableKey(view: EditorView): boolean {
  return inTable(view) ? addTableRow(view) : insertTable(view);
}

/** A physical chord: `code` is KeyboardEvent.code, so ⌥C (ç) and ⌥1 (¡) still count. */
interface Chord {
  code: string;
  shift?: boolean;
  alt?: boolean;
}

export type FormatId =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'link'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'codeblock'
  | 'table'
  | 'column'
  | 'rule';

export interface FormatCommand {
  id: FormatId;
  label: string;
  /** CodeMirror spelling. */
  key: string;
  /** Shown in tooltips and menus (macOS order: ⇧ ⌥ ⌘). */
  kbd: string;
  chord: Chord;
  run: Command;
}

export const FORMAT_COMMANDS: readonly FormatCommand[] = [
  { id: 'bold', label: 'Bold', key: 'Mod-b', kbd: '⌘B', chord: { code: 'KeyB' }, run: toggleBold },
  { id: 'italic', label: 'Italic', key: 'Mod-i', kbd: '⌘I', chord: { code: 'KeyI' }, run: toggleItalic },
  { id: 'strike', label: 'Strikethrough', key: 'Mod-Shift-x', kbd: '⇧⌘X', chord: { code: 'KeyX', shift: true }, run: toggleStrike },
  { id: 'code', label: 'Inline code', key: 'Mod-Shift-k', kbd: '⇧⌘K', chord: { code: 'KeyK', shift: true }, run: toggleInlineCode },
  { id: 'link', label: 'Link', key: 'Mod-k', kbd: '⌘K', chord: { code: 'KeyK' }, run: toggleLink },
  { id: 'h1', label: 'Heading 1', key: 'Mod-Alt-1', kbd: '⌥⌘1', chord: { code: 'Digit1', alt: true }, run: prefix('h1') },
  { id: 'h2', label: 'Heading 2', key: 'Mod-Alt-2', kbd: '⌥⌘2', chord: { code: 'Digit2', alt: true }, run: prefix('h2') },
  { id: 'h3', label: 'Heading 3', key: 'Mod-Alt-3', kbd: '⌥⌘3', chord: { code: 'Digit3', alt: true }, run: prefix('h3') },
  { id: 'bullet', label: 'Bullet list', key: 'Mod-Alt-u', kbd: '⌥⌘U', chord: { code: 'KeyU', alt: true }, run: prefix('bullet') },
  { id: 'ordered', label: 'Numbered list', key: 'Mod-Alt-o', kbd: '⌥⌘O', chord: { code: 'KeyO', alt: true }, run: prefix('ordered') },
  { id: 'task', label: 'Task list', key: 'Mod-Alt-x', kbd: '⌥⌘X', chord: { code: 'KeyX', alt: true }, run: prefix('task') },
  { id: 'quote', label: 'Quote', key: 'Mod-Alt-q', kbd: '⌥⌘Q', chord: { code: 'KeyQ', alt: true }, run: prefix('quote') },
  { id: 'codeblock', label: 'Code block', key: 'Mod-Alt-c', kbd: '⌥⌘C', chord: { code: 'KeyC', alt: true }, run: toggleCodeBlock },
  { id: 'table', label: 'Table', key: 'Mod-Alt-t', kbd: '⌥⌘T', chord: { code: 'KeyT', alt: true }, run: tableKey },
  { id: 'column', label: 'Add column', key: 'Mod-Shift-Alt-t', kbd: '⇧⌥⌘T', chord: { code: 'KeyT', alt: true, shift: true }, run: addTableColumn },
  { id: 'rule', label: 'Horizontal rule', key: 'Mod-Alt--', kbd: '⌥⌘-', chord: { code: 'Minus', alt: true }, run: insertRule },
];

export const formatCommand = (id: FormatId): FormatCommand => FORMAT_COMMANDS.find((c) => c.id === id)!;

/** The Page's formatting keymap (the guard below usually runs them first). */
export const formatKeymap = FORMAT_COMMANDS.map((c) => ({ key: c.key, run: c.run, preventDefault: true }));

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** The command for a keydown on the Page, or null. */
function pageCommand(e: KeyboardEvent): Command | null {
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const hit = FORMAT_COMMANDS.find((c) => c.chord.code === e.code && !!c.chord.shift === e.shiftKey && !!c.chord.alt === e.altKey);
  return hit?.run ?? null;
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
