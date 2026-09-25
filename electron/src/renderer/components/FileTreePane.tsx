/**
 * FileTreePane - File tree browser component
 *
 * A non-PTY tab that renders a collapsible file tree for the workspace.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon, type IconName } from './Icon';

const lee = window.lee;

// Context menu state
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  entry: FileEntry | null;
}

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

interface AgentTabInfo {
  id: number;
  ptyId: number;
  label: string;
  provider?: string;
}

interface FileTreePaneProps {
  workspace: string;
  onFileOpen: (filePath: string, opts?: { forceText?: boolean }) => void;
  onNewFile?: (directory?: string) => void;
  onAskHester?: (prompt: string) => void;
  onSendToAgent?: (ptyId: number, text: string) => void;
  agentTabs?: AgentTabInfo[];
  active: boolean;
  /** Path of the file currently open/focused elsewhere in the app, if the
   *  host wants the tree to reflect it. Falls back to the last clicked row. */
  selectedPath?: string;
}

export const FileTreePane: React.FC<FileTreePaneProps> = ({
  workspace,
  onFileOpen,
  onNewFile,
  onAskHester,
  onSendToAgent,
  agentTabs,
  active,
  selectedPath: selectedPathProp,
}) => {
  const [clickedPath, setClickedPath] = useState<string | undefined>(undefined);
  const selectedPath = selectedPathProp ?? clickedPath;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenCache, setChildrenCache] = useState<Map<string, FileEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    entry: null,
  });
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Load root directory
  const loadRoot = useCallback(async () => {
    if (!workspace || !lee) return;
    try {
      const result = await lee.fs.readdir(workspace);
      setEntries(result);
      // Clear children cache to force reload of expanded dirs
      setChildrenCache(new Map());
    } catch (error) {
      console.error('Failed to load workspace:', error);
    }
  }, [workspace]);

  // Load root directory on mount or workspace change
  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  // ---------------------------------------------------------------------
  // C17: auto-refresh.
  //
  // The tree used to read a directory once, on expand, and never again -
  // files an agent or a build created stayed invisible until the manual
  // refresh button. The main process watches the root plus every expanded
  // directory (non-recursive, debounced, noisy dirs skipped) and this
  // re-reads just the directory that changed, so expansion, filter and
  // scroll position all survive.
  // ---------------------------------------------------------------------

  /** Re-read one directory in place, keeping the rest of the tree as it is. */
  const refreshDir = useCallback(async (dirPath: string) => {
    if (!lee) return;
    try {
      const children = await lee.fs.readdir(dirPath);
      if (dirPath === workspace) {
        setEntries(children);
      } else {
        setChildrenCache((prev) => {
          if (!prev.has(dirPath)) return prev; // not expanded any more
          return new Map(prev).set(dirPath, children);
        });
      }
    } catch {
      // The directory itself went away - forget it rather than showing a
      // listing that no longer exists.
      setChildrenCache((prev) => {
        if (!prev.has(dirPath)) return prev;
        const next = new Map(prev);
        next.delete(dirPath);
        return next;
      });
      setExpanded((prev) => {
        if (!prev.has(dirPath)) return prev;
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [workspace]);

  // Watch the workspace root
  useEffect(() => {
    if (!workspace || !lee) return;
    lee.fs.watchDir(workspace);
    return () => { lee.fs.unwatchDir(workspace); };
  }, [workspace]);

  // Watch exactly the directories that are currently expanded
  const watchedDirsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!lee) return;
    for (const dir of expanded) {
      if (!watchedDirsRef.current.has(dir)) {
        lee.fs.watchDir(dir);
        watchedDirsRef.current.add(dir);
      }
    }
    for (const dir of [...watchedDirsRef.current]) {
      if (!expanded.has(dir)) {
        lee.fs.unwatchDir(dir);
        watchedDirsRef.current.delete(dir);
      }
    }
  }, [expanded]);

  // Release every watch when the tab closes
  useEffect(() => {
    const watched = watchedDirsRef.current;
    return () => {
      if (!lee) return;
      for (const dir of watched) lee.fs.unwatchDir(dir);
      watched.clear();
    };
  }, []);

  useEffect(() => {
    if (!lee) return;
    return lee.fs.onDirChanged(({ path }) => { void refreshDir(path); });
  }, [refreshDir]);

  // Toggle directory expansion
  const toggleDir = useCallback(async (dirPath: string) => {
    if (expanded.has(dirPath)) {
      // Collapse
      setExpanded(prev => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    } else {
      // Expand - load children if not cached
      if (!childrenCache.has(dirPath)) {
        setLoading(prev => new Set(prev).add(dirPath));
        try {
          const children = await lee.fs.readdir(dirPath);
          setChildrenCache(prev => new Map(prev).set(dirPath, children));
        } catch (error) {
          console.error('Failed to load directory:', error);
        } finally {
          setLoading(prev => {
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        }
      }
      setExpanded(prev => new Set(prev).add(dirPath));
    }
  }, [expanded, childrenCache]);

  // Handle file click
  const handleFileClick = useCallback((filePath: string) => {
    setClickedPath(filePath);
    onFileOpen(filePath);
  }, [onFileOpen]);

  // Get relative path from workspace root
  const getRelativePath = useCallback((absolutePath: string): string => {
    if (!workspace) return absolutePath;
    // Normalize paths and remove workspace prefix
    const normalizedWorkspace = workspace.endsWith('/') ? workspace : workspace + '/';
    if (absolutePath.startsWith(normalizedWorkspace)) {
      return absolutePath.slice(normalizedWorkspace.length);
    }
    // If path doesn't start with workspace, return as-is
    return absolutePath;
  }, [workspace]);

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      entry,
    });
  }, []);

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  // Copy path to clipboard
  const copyPathToClipboard = useCallback(async () => {
    if (!contextMenu.entry || !lee) return;
    const relativePath = getRelativePath(contextMenu.entry.path);
    try {
      await lee.clipboard.writeText(relativePath);
    } catch (error) {
      // Clipboard writes only fail when the OS denies access; there's no
      // recovery beyond retrying the menu item.
      console.error('Failed to copy path to clipboard:', error);
    }
    closeContextMenu();
  }, [contextMenu.entry, getRelativePath, closeContextMenu]);

  // Copy absolute path to clipboard
  const copyAbsolutePathToClipboard = useCallback(async () => {
    if (!contextMenu.entry || !lee) return;
    try {
      await lee.clipboard.writeText(contextMenu.entry.path);
    } catch (error) {
      console.error('Failed to copy path to clipboard:', error);
    }
    closeContextMenu();
  }, [contextMenu.entry, closeContextMenu]);

  // Open file in editor
  const openInEditor = useCallback(() => {
    if (!contextMenu.entry) return;
    // Explicit "Open in Editor" always means the text editor, even for files
    // that normally route to a viewer or browser tab (HTML, SVG, KiCad, ...)
    onFileOpen(contextMenu.entry.path, { forceText: true });
    closeContextMenu();
  }, [contextMenu.entry, onFileOpen, closeContextMenu]);

  // Ask Hester to summarize
  const askHester = useCallback(() => {
    if (!contextMenu.entry || !onAskHester) return;
    const relativePath = getRelativePath(contextMenu.entry.path);
    onAskHester(`Summarize: ${relativePath}`);
    closeContextMenu();
  }, [contextMenu.entry, getRelativePath, onAskHester, closeContextMenu]);

  // Send file path to a specific agent tab PTY
  const sendToAgent = useCallback((ptyId: number) => {
    if (!contextMenu.entry || !onSendToAgent) return;
    const relativePath = getRelativePath(contextMenu.entry.path);
    onSendToAgent(ptyId, relativePath);
    closeContextMenu();
  }, [contextMenu.entry, getRelativePath, onSendToAgent, closeContextMenu]);

  // Index with Hester
  const indexWithHester = useCallback(() => {
    if (!contextMenu.entry || !onAskHester) return;
    const relativePath = getRelativePath(contextMenu.entry.path);
    onAskHester(`hester docs index ${relativePath}`);
    closeContextMenu();
  }, [contextMenu.entry, getRelativePath, onAskHester, closeContextMenu]);

  // Create new file in directory
  const createNewFile = useCallback(() => {
    if (!onNewFile) return;
    // If right-clicked on a directory, create in that directory
    // If right-clicked on a file, create in its parent directory
    // If no context (e.g., empty area), create in workspace root
    let directory: string | undefined;
    if (contextMenu.entry) {
      directory = contextMenu.entry.type === 'directory'
        ? contextMenu.entry.path
        : contextMenu.entry.path.substring(0, contextMenu.entry.path.lastIndexOf('/'));
    }
    onNewFile(directory);
    closeContextMenu();
  }, [contextMenu.entry, onNewFile, closeContextMenu]);

  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu.visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu.visible, closeContextMenu]);

  // Check if an entry or any of its cached descendants match the filter
  const entryMatchesFilter = useCallback((entry: FileEntry, lowerFilter: string): boolean => {
    // Check if this entry's name matches
    if (entry.name.toLowerCase().includes(lowerFilter)) {
      return true;
    }

    // For directories, recursively check cached children
    if (entry.type === 'directory') {
      const children = childrenCache.get(entry.path) || [];
      return children.some(child => entryMatchesFilter(child, lowerFilter));
    }

    return false;
  }, [childrenCache]);

  // Filter entries recursively
  const filterEntries = useCallback((items: FileEntry[], filterText: string): FileEntry[] => {
    if (!filterText.trim()) return items;
    const lowerFilter = filterText.toLowerCase();

    return items.filter(entry => entryMatchesFilter(entry, lowerFilter));
  }, [entryMatchesFilter]);

  // Handle keyboard shortcut to clear filter
  useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape to clear filter and blur
      if (e.key === 'Escape' && document.activeElement === filterInputRef.current) {
        setFilter('');
        filterInputRef.current?.blur();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  // Filter the entries
  const filteredEntries = filterEntries(entries, filter);

  return (
    <div
      className={`file-tree-pane ${active ? 'active' : ''}`}
    >
      <div className="file-tree-filter">
        <span className="filter-icon"><Icon name="search" size={14} /></span>
        <input
          ref={filterInputRef}
          type="text"
          className="filter-input"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button
            className="filter-clear"
            onClick={() => setFilter('')}
            title="Clear filter"
          >
            <Icon name="close" size={14} />
          </button>
        )}
        <button
          className="filter-refresh"
          onClick={loadRoot}
          title="Refresh file tree"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="file-tree-content">
        {entries.length === 0 && <div className="file-tree-empty">Loading...</div>}
        {filteredEntries.map(entry => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            childrenCache={childrenCache}
            loading={loading}
            filter={filter}
            selectedPath={selectedPath}
            onToggle={toggleDir}
            onFileClick={handleFileClick}
            onContextMenu={handleContextMenu}
            entryMatchesFilter={entryMatchesFilter}
          />
        ))}
        {entries.length > 0 && filteredEntries.length === 0 && (
          <div className="file-tree-empty">No matches for "{filter}"</div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && contextMenu.entry && (
        <div
          ref={contextMenuRef}
          className="file-tree-context-menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          {onNewFile && (
            <>
              <div className="context-menu-item" onClick={createNewFile}>
                New File
              </div>
              <div className="context-menu-divider" />
            </>
          )}
          <div className="context-menu-item" onClick={openInEditor}>
            Open in Editor
          </div>
          <div className="context-menu-item" onClick={copyPathToClipboard}>
            Copy Path
          </div>
          <div className="context-menu-item" onClick={copyAbsolutePathToClipboard}>
            Copy Absolute Path
          </div>
          {onAskHester && (
            <>
              <div className="context-menu-divider" />
              <div className="context-menu-item" onClick={askHester}>
                Ask Hester
              </div>
              <div className="context-menu-item" onClick={indexWithHester}>
                Index
              </div>
            </>
          )}
          {onSendToAgent && agentTabs && agentTabs.length > 0 && (
            <>
              <div className="context-menu-divider" />
              <div className="context-menu-label">Send to Agent</div>
              {agentTabs.map(tab => (
                <div
                  key={tab.id}
                  className="context-menu-item context-menu-item-indented"
                  onClick={() => sendToAgent(tab.ptyId)}
                >
                  {tab.label}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  childrenCache: Map<string, FileEntry[]>;
  loading: Set<string>;
  filter: string;
  selectedPath?: string;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  entryMatchesFilter: (entry: FileEntry, lowerFilter: string) => boolean;
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  entry,
  depth,
  expanded,
  childrenCache,
  loading,
  filter,
  selectedPath,
  onToggle,
  onFileClick,
  onContextMenu,
  entryMatchesFilter,
}) => {
  const isDir = entry.type === 'directory';
  const isExpanded = expanded.has(entry.path);
  const isLoading = loading.has(entry.path);
  const isSelected = !isDir && entry.path === selectedPath;
  const children = childrenCache.get(entry.path) || [];
  const icon: IconName = isDir
    ? (isExpanded ? 'folder-open' : 'folder')
    : getFileIcon(entry);

  // Filter children if there's a filter active
  const filteredChildren = filter.trim()
    ? children.filter(child => entryMatchesFilter(child, filter.toLowerCase()))
    : children;

  const handleClick = () => {
    if (isDir) {
      onToggle(entry.path);
    } else {
      onFileClick(entry.path);
    }
  };

  // Highlight matching text in file name
  const renderFileName = () => {
    if (!filter.trim()) return entry.name;

    const lowerName = entry.name.toLowerCase();
    const lowerFilter = filter.toLowerCase();
    const index = lowerName.indexOf(lowerFilter);

    if (index === -1) return entry.name;

    const before = entry.name.slice(0, index);
    const match = entry.name.slice(index, index + filter.length);
    const after = entry.name.slice(index + filter.length);

    return (
      <>
        {before}
        <span className="filter-match">{match}</span>
        {after}
      </>
    );
  };

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-item ${isDir ? 'directory' : 'file'} ${isSelected ? 'is-selected' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        {isDir && (
          <span className={`expand-icon ${isLoading ? 'loading' : ''}`}>
            {isLoading ? '⋯' : <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />}
          </span>
        )}
        {!isDir && <span className="expand-icon-spacer" />}
        <span className="file-icon"><Icon name={icon} size={14} /></span>
        <span className="file-name">{renderFileName()}</span>
      </div>

      {isDir && isExpanded && filteredChildren.length > 0 && (
        <div className="file-tree-children">
          {filteredChildren.map(child => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              childrenCache={childrenCache}
              loading={loading}
              filter={filter}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
              entryMatchesFilter={entryMatchesFilter}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// File icon mapper based on extension
function getFileIcon(entry: FileEntry): IconName {
  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, IconName> = {
    // Code files
    ts: 'file-code',
    tsx: 'file-code',
    js: 'file-code',
    jsx: 'file-code',
    py: 'file-code',
    dart: 'file-code',
    rs: 'file-code',
    go: 'file-code',
    java: 'file-code',

    // Config/data
    json: 'file-code',
    yaml: 'file-code',
    yml: 'file-code',
    toml: 'file-code',
    xml: 'file-code',

    // Markdown/docs
    md: 'book',
    txt: 'file-code',

    // Styles
    css: 'file-code',
    scss: 'file-code',
    less: 'file-code',

    // Images
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    svg: 'image',

    // Others
    html: 'file-code',
    sh: 'terminal',
    bash: 'terminal',
  };

  return iconMap[ext] || 'file-code';
}

export default FileTreePane;
