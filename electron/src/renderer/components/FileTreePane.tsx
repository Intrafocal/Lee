/**
 * FileTreePane - File tree browser component
 *
 * A non-PTY tab that renders a collapsible file tree for the workspace.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

const lee = (window as any).lee;

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

interface FileTreePaneProps {
  workspace: string;
  onFileOpen: (filePath: string) => void;
  onNewFile?: (directory?: string) => void;
  onAskHester?: (prompt: string) => void;
  active: boolean;
}

export const FileTreePane: React.FC<FileTreePaneProps> = ({
  workspace,
  onFileOpen,
  onNewFile,
  onAskHester,
  active,
}) => {
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
    onFileOpen(contextMenu.entry.path);
    closeContextMenu();
  }, [contextMenu.entry, onFileOpen, closeContextMenu]);

  // Ask Hester to summarize
  const askHester = useCallback(() => {
    if (!contextMenu.entry || !onAskHester) return;
    const relativePath = getRelativePath(contextMenu.entry.path);
    onAskHester(`Summarize: ${relativePath}`);
    closeContextMenu();
  }, [contextMenu.entry, getRelativePath, onAskHester, closeContextMenu]);

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

  // Handle keyboard shortcut to focus filter
  useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F to focus filter
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        filterInputRef.current?.focus();
        filterInputRef.current?.select();
      }
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
        <span className="filter-icon">🔍</span>
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
            ×
          </button>
        )}
        <button
          className="filter-refresh"
          onClick={loadRoot}
          title="Refresh file tree"
        >
          ↻
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
  onToggle,
  onFileClick,
  onContextMenu,
  entryMatchesFilter,
}) => {
  const isDir = entry.type === 'directory';
  const isExpanded = expanded.has(entry.path);
  const isLoading = loading.has(entry.path);
  const children = childrenCache.get(entry.path) || [];
  const icon = getFileIcon(entry);

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
        className={`file-tree-item ${isDir ? 'directory' : 'file'}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        {isDir && (
          <span className={`expand-icon ${isLoading ? 'loading' : ''}`}>
            {isLoading ? '⋯' : isExpanded ? '▼' : '▶'}
          </span>
        )}
        {!isDir && <span className="expand-icon-spacer" />}
        <span className="file-icon">{icon}</span>
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
function getFileIcon(entry: FileEntry): string {
  if (entry.type === 'directory') return '📁';

  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, string> = {
    // Code files
    ts: '📘',
    tsx: '📘',
    js: '📒',
    jsx: '📒',
    py: '🐍',
    dart: '🎯',
    rs: '🦀',
    go: '🐹',
    java: '☕',

    // Config/data
    json: '📋',
    yaml: '📋',
    yml: '📋',
    toml: '📋',
    xml: '📋',

    // Markdown/docs
    md: '📝',
    txt: '📄',

    // Styles
    css: '🎨',
    scss: '🎨',
    less: '🎨',

    // Images
    png: '🖼️',
    jpg: '🖼️',
    jpeg: '🖼️',
    gif: '🖼️',
    svg: '🖼️',

    // Others
    html: '🌐',
    sh: '💻',
    bash: '💻',
  };

  return iconMap[ext] || '📄';
}

export default FileTreePane;
