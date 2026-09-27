/**
 * liveMarkdown - the Page's live formatting (Deep next R9), as CodeMirror
 * extensions. The file stays plain markdown; everything here is decoration.
 *
 * - pageMarkdown(): GFM markdown with fenced-code languages (loaded on first
 *   use from the @codemirror/lang-* packages already installed; a fence in any
 *   other language is left unhighlighted) and a quiet highlight style (no
 *   phosphor: rule 1 keeps it for the caret, selection and new-answer dot).
 * - liveFormatting(onWiki): line classes (headings, quotes, code blocks,
 *   rules, done tasks), task checkboxes (click to toggle) and rules drawn off
 *   the cursor's line, the
 *   markdown marks hidden off the cursor's lines (deepModel.liveHidden), and
 *   `[[…]]` links shown as their label off the cursor's line, opening the
 *   source panel when clicked (R10).
 * - tableField: GFM tables rendered as tables while the cursor is outside
 *   them (block widgets must come from a state field).
 * - languageForPath: the same languages, by file extension, for the source panel.
 */

import { type Extension, type EditorState, RangeSetBuilder, StateField, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags as t } from '@lezer/highlight';
import { liveHidden, parseTable, parseWikiLinks, touchesActive, wikiDisplay, type WikiLink } from '../../../lib/deepModel';

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Fenced-code languages: only packages already in node_modules. Missing
 * (no highlighting, by design: no new dependencies): shell/bash, dart,
 * toml, swift, kotlin, ruby, php, xml.
 */
export const CODE_LANGUAGES: LanguageDescription[] = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx', 'mjs', 'cjs', 'node'], extensions: ['js', 'jsx', 'mjs', 'cjs'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], extensions: ['ts', 'tsx', 'mts', 'cts'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })) }),
  LanguageDescription.of({ name: 'python', alias: ['py'], extensions: ['py'], load: () => import('@codemirror/lang-python').then((m) => m.python()) }),
  LanguageDescription.of({ name: 'json', alias: ['jsonc'], extensions: ['json'], load: () => import('@codemirror/lang-json').then((m) => m.json()) }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], extensions: ['yaml', 'yml'], load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) }),
  LanguageDescription.of({ name: 'html', alias: ['htm'], extensions: ['html', 'htm'], load: () => import('@codemirror/lang-html').then((m) => m.html()) }),
  LanguageDescription.of({ name: 'css', alias: ['scss'], extensions: ['css'], load: () => import('@codemirror/lang-css').then((m) => m.css()) }),
  LanguageDescription.of({ name: 'sql', alias: ['psql', 'postgres'], extensions: ['sql'], load: () => import('@codemirror/lang-sql').then((m) => m.sql()) }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], extensions: ['rs'], load: () => import('@codemirror/lang-rust').then((m) => m.rust()) }),
  LanguageDescription.of({ name: 'go', alias: ['golang'], extensions: ['go'], load: () => import('@codemirror/lang-go').then((m) => m.go()) }),
  LanguageDescription.of({ name: 'java', extensions: ['java'], load: () => import('@codemirror/lang-java').then((m) => m.java()) }),
  LanguageDescription.of({ name: 'cpp', alias: ['c', 'c++', 'h', 'hpp', 'cc', 'objc'], extensions: ['c', 'cc', 'cpp', 'h', 'hpp'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) }),
];

/** The code highlight: quiet, token roles only (no phosphor, no ember). */
const pageHighlight = HighlightStyle.define([
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-2)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.82em' },
  { tag: t.link, color: 'var(--text-1)', textDecoration: 'underline', textDecorationColor: 'var(--text-3)' },
  { tag: t.url, color: 'var(--text-2)' },
  { tag: t.processingInstruction, color: 'var(--text-3)' },
  { tag: t.labelName, color: 'var(--text-3)' },
  // Fenced code tokens.
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--info)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--text-2)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'rgba(var(--info-rgb), 0.8)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.definition(t.function(t.variableName))], color: 'var(--text-1)', fontWeight: '500' },
  { tag: [t.typeName, t.className, t.namespace], color: 'rgba(var(--info-rgb), 0.85)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--text-1)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.meta], color: 'var(--text-3)' },
]);

/** GFM markdown with fenced-code languages and the quiet highlight. */
export function pageMarkdown(): Extension {
  return [markdown({ base: markdownLanguage, codeLanguages: CODE_LANGUAGES }), syntaxHighlighting(pageHighlight)];
}

/** A language for the source panel, by extension (markdown for .md). */
export function languageForPath(path: string): Promise<Extension | null> {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return Promise.resolve(pageMarkdown());
  const desc = CODE_LANGUAGES.find((d) => d.extensions.includes(ext));
  if (!desc) return Promise.resolve(null);
  return desc.load().then((support) => [support, syntaxHighlighting(pageHighlight)] as Extension, () => null);
}

// ---------------------------------------------------------------------------
// Active lines: the ones the cursor or selection touches
// ---------------------------------------------------------------------------

export function activeLines(state: EditorState): Array<[number, number]> {
  return state.selection.ranges.map((r) => [state.doc.lineAt(r.from).from, state.doc.lineAt(r.to).to]);
}

// ---------------------------------------------------------------------------
// [[…]] links
// ---------------------------------------------------------------------------

class WikiWidget extends WidgetType {
  constructor(
    readonly link: WikiLink,
    readonly open: (link: WikiLink) => void,
  ) {
    super();
  }
  eq(other: WikiWidget): boolean {
    return other.link.path === this.link.path && other.link.label === this.link.label && String(other.link.lines) === String(this.link.lines);
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'deep-wiki';
    el.textContent = wikiDisplay(this.link);
    el.title = this.link.lines ? `${this.link.path} · lines ${this.link.lines[0]}–${this.link.lines[1]}` : this.link.path;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.open(this.link);
    });
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Task checkboxes and horizontal rules
// ---------------------------------------------------------------------------

/** A task's `[ ]` / `[x]` off the cursor's line: a quiet checkbox; clicking it toggles the mark. */
class TaskWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly at: number,
  ) {
    super();
  }
  eq(other: TaskWidget): boolean {
    return other.done === this.done && other.at === this.at;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = `deep-task-box${this.done ? ' is-done' : ''}`;
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(this.done));
    el.title = this.done ? 'Done: click to reopen' : 'Click to mark done';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.at + 1;
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: this.done ? ' ' : 'x' }, userEvent: 'input.format' });
    });
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** `---` off the cursor's line: a thin rule across the column. */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'deep-hr';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

const ruleWidget = new RuleWidget();

// ---------------------------------------------------------------------------
// Line classes, hidden marks and link labels
// ---------------------------------------------------------------------------

const hide = Decoration.replace({});

function buildLive(view: EditorView, openWiki: (link: WikiLink) => void): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  const lineClass = new Map<number, string[]>();
  const addLine = (from: number, cls: string) => {
    const l = lineClass.get(from) ?? [];
    if (!l.includes(cls)) l.push(cls);
    lineClass.set(from, l);
  };
  const wikiRanges: Array<[number, number]> = [];

  for (const { from, to } of view.visibleRanges) {
    // [[links]] first, so marks inside them are left alone.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      if (line.text.includes('[[')) {
        for (const link of parseWikiLinks(line.text)) {
          const a = line.from + link.from;
          const b = line.from + link.to;
          wikiRanges.push([a, b]);
          if (touchesActive(a, b, active)) decos.push(Decoration.mark({ class: 'deep-wiki-src' }).range(a, b));
          else decos.push(Decoration.replace({ widget: new WikiWidget(link, openWiki) }).range(a, b));
        }
      }
      pos = line.to + 1;
    }

    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          addLine(state.doc.lineAt(node.from).from, `deep-h deep-h${heading[1]}`);
          return;
        }
        if (name === 'Blockquote') {
          for (let p = node.from; p <= node.to; ) {
            const l = state.doc.lineAt(p);
            addLine(l.from, 'deep-quote');
            p = l.to + 1;
          }
          return;
        }
        if (name === 'FencedCode') {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          for (let p = first.from; p <= last.to; ) {
            const l = state.doc.lineAt(p);
            addLine(l.from, l.number === first.number ? 'deep-code deep-code-open' : l.number === last.number ? 'deep-code deep-code-close' : 'deep-code');
            p = l.to + 1;
          }
          return;
        }
        if (name === 'Table') return false; // the table field renders it
        if (name === 'HorizontalRule') {
          const l = state.doc.lineAt(node.from);
          addLine(l.from, 'deep-hr-line');
          if (!touchesActive(node.from, node.to, active)) decos.push(Decoration.replace({ widget: ruleWidget }).range(node.from, node.to));
          return;
        }
        if (name === 'TaskMarker') {
          const done = /x/i.test(state.doc.sliceString(node.from, node.to));
          if (done) addLine(state.doc.lineAt(node.from).from, 'deep-task-done');
          if (!touchesActive(node.from, node.to, active)) decos.push(Decoration.replace({ widget: new TaskWidget(done, node.from) }).range(node.from, node.to));
          return;
        }
        // A task's bullet goes with its checkbox off the cursor's line.
        if (name === 'ListMark' && node.node.parent?.getChild('Task') && !touchesActive(node.from, node.to, active)) {
          let end = node.to;
          if (state.doc.sliceString(end, end + 1) === ' ') end += 1;
          decos.push(hide.range(node.from, end));
          return;
        }
        const parent = node.node.parent?.name ?? null;
        if (!liveHidden(name, parent, node.from, node.to, active)) return;
        if (wikiRanges.some(([a, b]) => node.from < b && node.to > a)) return;
        let end = node.to;
        // A heading's `#` and a quote's `>` take the space after them.
        if ((name === 'HeaderMark' || name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end += 1;
        if (end > node.from) decos.push(hide.range(node.from, end));
      },
    });
  }
  for (const [from, classes] of lineClass) decos.push(Decoration.line({ class: classes.join(' ') }).range(from));
  return Decoration.set(decos, true);
}

/** Line classes, hidden marks and `[[…]]` labels; `openWiki` opens the source panel. */
export function liveFormatting(openWiki: (link: WikiLink) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildLive(view, openWiki);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = buildLive(u.view, openWiki);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Inline marks off a table cell's text (the widget shows it plainly). */
const plainCell = (s: string) => s.replace(/\*\*|__|`|~~/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly at: number,
  ) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'deep-table-wrap';
    const parsed = parseTable(this.source);
    if (!parsed) {
      wrap.textContent = this.source;
      return wrap;
    }
    const table = document.createElement('table');
    table.className = 'deep-table';
    const thead = table.createTHead().insertRow();
    parsed.head.forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = plainCell(h);
      if (parsed.align[i]) th.style.textAlign = parsed.align[i]!;
      thead.appendChild(th);
    });
    const body = table.createTBody();
    for (const row of parsed.rows) {
      const tr = body.insertRow();
      row.forEach((c, i) => {
        const td = tr.insertCell();
        td.textContent = plainCell(c);
        if (parsed.align[i]) td.style.textAlign = parsed.align[i]!;
      });
    }
    wrap.appendChild(table);
    // Clicking a rendered table puts the cursor in it: it shows as its text.
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.at } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildTables(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const b = new RangeSetBuilder<Decoration>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      if (touchesActive(first.from, last.to, active)) return false;
      const source = state.doc.sliceString(first.from, last.to);
      b.add(first.from, last.to, Decoration.replace({ widget: new TableWidget(source, first.from), block: true }));
      return false;
    },
  });
  return b.finish();
}

/** GFM tables as tables while the cursor is outside them (R9). */
export const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTables(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return buildTables(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
