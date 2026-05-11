/**
 * EditorPanel - CodeMirror 6-based code editor
 *
 * A stateless editor component that receives file content via props.
 * Each file tab renders its own EditorPanel instance.
 *
 * Features:
 * - Syntax highlighting for 15+ languages
 * - Markdown preview (toggle mode)
 * - Context integration with Hester
 */

import React, { useEffect, useCallback, useRef, useMemo } from 'react';
import { EditorState, Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, rectangularSelection, crosshairCursor, highlightActiveLine, Decoration, DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { foldGutter, indentOnInput, bracketMatching, foldKeymap } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

// Language imports
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';

import { MarkdownPreview } from './MarkdownPreview';

const lee = (window as any).lee;

// --- Agent highlight decoration ---
const addHighlight = StateEffect.define<{ from: number; to: number }[]>();
const clearHighlights = StateEffect.define<null>();

const agentHighlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addHighlight)) {
        const marks = e.value.map(({ from, to }) =>
          Decoration.mark({ class: 'cm-agent-highlight' }).range(from, to)
        );
        deco = deco.update({ add: marks, sort: true });
      } else if (e.is(clearHighlights)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

interface AgentTabInfo {
  id: number;
  ptyId: number;
  label: string;
  provider?: string;
}

interface EditorPanelProps {
  workspace: string;
  active: boolean;
  /** ID of the tab hosting this panel — used so external IPC commands can
   *  route to a specific panel even when multiple are mounted (e.g. across
   *  docked panels). When absent the panel only acts on broadcast commands. */
  tabId?: number;
  // File-specific props (for file tabs)
  filePath?: string;
  fileContent?: string;
  fileLanguage?: string;
  fileModified?: boolean;
  onContentChange?: (content: string) => void;
  onSave?: () => void;
  onAskHester?: (prompt: string) => void;
  onOpenFile?: (filePath: string) => void;
  onSendToAgent?: (ptyId: number, text: string) => void;
  agentTabs?: AgentTabInfo[];
}

interface ContextMenuState {
  x: number;
  y: number;
  selectedText: string;
  lineNumber: number;
}

// Language detection from file extension
const LANGUAGE_MAP: Record<string, () => Extension> = {
  py: () => python(),
  pyw: () => python(),
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  md: () => markdown(),
  mdx: () => markdown(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  json: () => json(),
  yaml: () => yaml(),
  yml: () => yaml(),
  sql: () => sql(),
  rs: () => rust(),
  go: () => go(),
  java: () => java(),
  c: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  h: () => cpp(),
  hpp: () => cpp(),
  hxx: () => cpp(),
};

export const EditorPanel: React.FC<EditorPanelProps> = ({
  workspace,
  active,
  tabId,
  filePath,
  fileContent,
  fileLanguage,
  fileModified,
  onContentChange,
  onSave,
  onAskHester,
  onOpenFile,
  onSendToAgent,
  agentTabs,
}) => {
  // State for preview mode (markdown only)
  const [previewMode, setPreviewMode] = React.useState(false);
  // State for context menu
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);

  // Refs
  const editorRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const contextUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastExternalContentRef = useRef<string | undefined>(fileContent);
  const isInternalChangeRef = useRef<boolean>(false);

  // Check if current file is markdown
  const isMarkdown = useMemo(() => {
    return fileLanguage === 'markdown';
  }, [fileLanguage]);

  // Get filename from path
  const fileName = useMemo(() => {
    return filePath?.split('/').pop() || 'Untitled';
  }, [filePath]);

  // Get language extension for file
  const getLanguageExtension = useCallback((path: string): Extension => {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const langFactory = LANGUAGE_MAP[ext];
    return langFactory ? langFactory() : [];
  }, []);

  // Push editor context to Hester
  const pushEditorContext = useCallback(() => {
    if (!lee?.context?.updateEditor || !filePath) return;

    const view = editorViewRef.current;
    if (!view) {
      lee.context.updateEditor({
        tabId: tabId ?? null,
        file: filePath,
        language: fileLanguage || 'text',
        cursor: { line: 1, column: 1 },
        selection: null,
        selectedRange: null,
        modified: fileModified || false,
      });
      return;
    }

    const state = view.state;
    const sel = state.selection.main;
    const cursorLine = state.doc.lineAt(sel.head);

    let selectedRange = null;
    if (!sel.empty) {
      const fromLine = state.doc.lineAt(sel.from);
      const toLine = state.doc.lineAt(sel.to);
      selectedRange = {
        from: { line: fromLine.number, column: sel.from - fromLine.from + 1 },
        to: { line: toLine.number, column: sel.to - toLine.from + 1 },
      };
    }

    lee.context.updateEditor({
      tabId: tabId ?? null,
      file: filePath,
      language: fileLanguage || 'text',
      cursor: {
        line: cursorLine.number,
        column: sel.head - cursorLine.from + 1,
      },
      selection: sel.empty ? null : state.sliceDoc(sel.from, sel.to),
      selectedRange,
      modified: fileModified || false,
    });
  }, [tabId, filePath, fileLanguage, fileModified]);

  // Debounced context push
  const debouncedContextPush = useCallback(() => {
    if (contextUpdateTimerRef.current) {
      clearTimeout(contextUpdateTimerRef.current);
    }
    contextUpdateTimerRef.current = setTimeout(() => {
      pushEditorContext();
    }, 100);
  }, [pushEditorContext]);

  // Handle document change
  const handleDocChange = useCallback(() => {
    if (!editorViewRef.current || !onContentChange) return;
    const newContent = editorViewRef.current.state.doc.toString();
    // Mark this as an internal change so we don't recreate the editor
    isInternalChangeRef.current = true;
    onContentChange(newContent);
  }, [onContentChange]);

  // Create CodeMirror extensions
  const createExtensions = useCallback((path: string): Extension[] => {
    return [
      agentHighlightField,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      getLanguageExtension(path),
      oneDark,
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          handleDocChange();
        }
        if (update.selectionSet || update.docChanged) {
          debouncedContextPush();
        }
      }),
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '13px',
        },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: 'JetBrains Mono, Noto Color Emoji, Menlo, Monaco, monospace',
        },
        '.cm-content': {
          caretColor: '#528bff',
        },
        '.cm-gutters': {
          backgroundColor: '#1e1e1e',
          borderRight: '1px solid #333',
        },
      }),
    ];
  }, [getLanguageExtension, handleDocChange, debouncedContextPush]);

  // Create/recreate editor when file changes or preview mode toggles
  useEffect(() => {
    if (!editorRef.current || !filePath || previewMode) {
      // Destroy editor if exists
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
      return;
    }

    // If this is an internal change (user typing), don't recreate the editor
    if (isInternalChangeRef.current) {
      isInternalChangeRef.current = false;
      return;
    }

    // Check if content changed from external source (e.g., initial load, file reload, or switching files)
    const externalContentChanged = lastExternalContentRef.current !== fileContent;
    lastExternalContentRef.current = fileContent;

    // If editor exists and external content hasn't changed, don't recreate
    if (editorViewRef.current && !externalContentChanged) {
      return;
    }

    // Destroy existing editor
    if (editorViewRef.current) {
      editorViewRef.current.destroy();
    }

    // Create new editor
    const state = EditorState.create({
      doc: fileContent || '',
      extensions: createExtensions(filePath),
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    editorViewRef.current = view;

    // Focus editor if tab is active
    if (active) {
      view.focus();
    }

    // Push initial context
    debouncedContextPush();

    return () => {
      // Don't destroy on cleanup - let the explicit destroy handle it
    };
  }, [filePath, fileContent, previewMode, active, createExtensions, debouncedContextPush]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
    };
  }, []);

  // Wire IPC editor commands from Hester / agents.
  //
  // Listeners are registered unconditionally — gating them on `active` meant
  // editor commands silently no-op'd whenever the editor tab wasn't the
  // currently selected tab in its panel (e.g. when Hester is in a side panel
  // and the editor is in center). Routing is by `tabId` instead: each panel
  // ignores messages whose `tabId` doesn't match its own. Messages sent
  // without a `tabId` (broadcast) are handled only by the active panel so
  // there's still a sane fallback for callers that don't pass one.
  useEffect(() => {
    if (!lee?.editor) return;

    const isForMe = (msgTabId: number | undefined) => {
      if (msgTabId == null) return active; // broadcast → only active panel responds
      return tabId != null && msgTabId === tabId;
    };

    // Helper: convert 1-based line/col to a document offset, clamped to valid range
    const toPos = (view: EditorView, line: number, col: number): number => {
      const lineObj = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      return Math.min(lineObj.from + Math.max(0, col - 1), lineObj.to);
    };

    const cleanupGotoLine = lee.editor.onGotoLine((line: number, column: number | undefined, msgTabId: number | undefined) => {
      if (!isForMe(msgTabId)) return;
      const view = editorViewRef.current;
      if (!view) return;
      const pos = toPos(view, line, column ?? 1);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    });

    const cleanupSelect = lee.editor.onSelect((fromLine: number, fromCol: number, toLine: number, toCol: number, msgTabId: number | undefined) => {
      if (!isForMe(msgTabId)) return;
      const view = editorViewRef.current;
      if (!view) return;
      const from = toPos(view, fromLine, fromCol);
      const to = toPos(view, toLine, toCol);
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      view.focus();
    });

    const cleanupHighlight = lee.editor.onHighlight((ranges: any[], durationMs: number | undefined, msgTabId: number | undefined) => {
      if (!isForMe(msgTabId)) return;
      const view = editorViewRef.current;
      if (!view) return;
      const positions = (ranges as Array<{ fromLine: number; fromCol: number; toLine: number; toCol: number }>).map(r => ({
        from: toPos(view, r.fromLine, r.fromCol),
        to: toPos(view, r.toLine, r.toCol),
      }));
      view.dispatch({ effects: addHighlight.of(positions) });
      if (durationMs && durationMs > 0) {
        setTimeout(() => {
          editorViewRef.current?.dispatch({ effects: clearHighlights.of(null) });
        }, durationMs);
      }
    });

    const cleanupInsert = lee.editor.onInsert((line: number, column: number, text: string, msgTabId: number | undefined) => {
      if (!isForMe(msgTabId)) return;
      const view = editorViewRef.current;
      if (!view) return;
      const pos = toPos(view, line, column);
      view.dispatch({ changes: { from: pos, insert: text } });
    });

    const cleanupReplace = lee.editor.onReplace((fromLine: number, fromCol: number, toLine: number, toCol: number, text: string, msgTabId: number | undefined) => {
      if (!isForMe(msgTabId)) return;
      const view = editorViewRef.current;
      if (!view) return;
      const from = toPos(view, fromLine, fromCol);
      const to = toPos(view, toLine, toCol);
      view.dispatch({ changes: { from, to, insert: text } });
    });

    return () => {
      cleanupGotoLine();
      cleanupSelect();
      cleanupHighlight();
      cleanupInsert();
      cleanupReplace();
    };
  }, [tabId, active]);

  // Handle keyboard shortcuts
  useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+S to save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave?.();
      }

      // Cmd+E to toggle preview (markdown only)
      if ((e.metaKey || e.ctrlKey) && e.key === 'e' && isMarkdown) {
        e.preventDefault();
        setPreviewMode(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onSave, isMarkdown]);

  // Push context when preview mode changes
  useEffect(() => {
    debouncedContextPush();
  }, [previewMode, debouncedContextPush]);

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    const view = editorViewRef.current;
    if (!view) return;

    const state = view.state;
    const selection = state.selection.main;
    const selectedText = selection.empty ? '' : state.sliceDoc(selection.from, selection.to);
    const line = state.doc.lineAt(selection.head);

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      selectedText: selectedText.trim(),
      lineNumber: line.number,
    });
  }, []);

  // Close context menu when clicking elsewhere
  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };

    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  // Context menu actions
  const handleSendToHester = useCallback(() => {
    if (!contextMenu || !onAskHester) return;

    const { selectedText, lineNumber } = contextMenu;
    const prompt = selectedText
      ? `Review ${fileName} line ${lineNumber}:\n\`\`\`\n${selectedText}\n\`\`\``
      : `Review ${fileName} at line ${lineNumber}`;

    onAskHester(prompt);
    setContextMenu(null);
  }, [contextMenu, fileName, onAskHester]);

  const handleSendToAgentTab = useCallback((ptyId: number) => {
    if (!contextMenu || !onSendToAgent) return;

    const { selectedText, lineNumber } = contextMenu;
    const text = selectedText
      ? `Review ${fileName} line ${lineNumber}:\n\`\`\`\n${selectedText}\n\`\`\``
      : `Review ${fileName} at line ${lineNumber}`;

    onSendToAgent(ptyId, text);
    setContextMenu(null);
  }, [contextMenu, fileName, onSendToAgent]);

  const handleSearchDocs = useCallback(() => {
    if (!contextMenu?.selectedText || !onAskHester) return;

    const prompt = `Search docs for "${contextMenu.selectedText}"`;
    onAskHester(prompt);
    setContextMenu(null);
  }, [contextMenu, onAskHester]);

  const handleOpenAsFile = useCallback(() => {
    if (!contextMenu?.selectedText || !onOpenFile) return;

    let targetPath = contextMenu.selectedText;

    // If it's a relative path, resolve it relative to current file's directory
    if (!targetPath.startsWith('/') && filePath) {
      const currentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      targetPath = `${currentDir}/${targetPath}`;
    }

    // Normalize path (handle ../ and ./)
    const parts = targetPath.split('/');
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        normalized.pop();
      } else if (part !== '.' && part !== '') {
        normalized.push(part);
      }
    }
    targetPath = '/' + normalized.join('/');

    onOpenFile(targetPath);
    setContextMenu(null);
  }, [contextMenu, filePath, onOpenFile]);

  // Check if selected text looks like a file path
  const looksLikeFilePath = useMemo(() => {
    if (!contextMenu?.selectedText) return false;
    const text = contextMenu.selectedText;
    // Has file extension or contains path separators
    return /\.\w+$/.test(text) || text.includes('/');
  }, [contextMenu]);

  // Empty state when no file is open
  if (!filePath) {
    return (
      <div className={`editor-panel ${active ? 'active' : ''}`}>
        <div className="editor-content">
          <div className="editor-empty">
            <div className="editor-empty-icon">📝</div>
            <div className="editor-empty-text">No file open</div>
            <div className="editor-empty-hint">
              Open a file from the file tree or use Cmd+O
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`editor-panel ${active ? 'active' : ''}`}>
      {/* Toolbar for markdown */}
      {isMarkdown && (
        <div className="editor-toolbar">
          <button
            className={`toolbar-button ${previewMode ? 'active' : ''}`}
            onClick={() => setPreviewMode(!previewMode)}
            title={previewMode ? 'Edit (Cmd+E)' : 'Preview (Cmd+E)'}
          >
            {previewMode ? '✏️ Edit' : '👁️ Preview'}
          </button>
        </div>
      )}

      {/* Editor or preview */}
      <div className="editor-content" onContextMenu={handleContextMenu}>
        {previewMode && isMarkdown ? (
          <MarkdownPreview content={fileContent || ''} />
        ) : (
          <div ref={editorRef} className="codemirror-container" />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="editor-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {onSendToAgent && agentTabs && agentTabs.length > 0 ? (
            <>
              <div className="context-menu-section-label">Send to Agent</div>
              {agentTabs.map(tab => (
                <button key={tab.id} onClick={() => handleSendToAgentTab(tab.ptyId)}>
                  <span className="context-menu-label context-menu-label-indented">{tab.label}</span>
                </button>
              ))}
            </>
          ) : (
            <button onClick={handleSendToHester}>
              <span className="context-menu-icon">🐇</span>
              <span className="context-menu-label">
                {contextMenu.selectedText
                  ? `Send to Hester`
                  : `Ask Hester about line ${contextMenu.lineNumber}`}
              </span>
            </button>
          )}
          {contextMenu.selectedText && (
            <button onClick={handleSearchDocs}>
              <span className="context-menu-icon">📚</span>
              <span className="context-menu-label">
                Search docs for "{contextMenu.selectedText.slice(0, 20)}{contextMenu.selectedText.length > 20 ? '...' : ''}"
              </span>
            </button>
          )}
          {looksLikeFilePath && (
            <>
              <hr />
              <button onClick={handleOpenAsFile}>
                <span className="context-menu-icon">📄</span>
                <span className="context-menu-label">
                  Open "{contextMenu.selectedText.slice(0, 30)}{contextMenu.selectedText.length > 30 ? '...' : ''}"
                </span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="editor-status">
        <span className="status-language">{fileLanguage || 'text'}</span>
        <span className="status-path" title={filePath}>
          {filePath.replace(workspace + '/', '')}
        </span>
        {fileModified && <span className="status-modified">Modified</span>}
      </div>
    </div>
  );
};

export default EditorPanel;
