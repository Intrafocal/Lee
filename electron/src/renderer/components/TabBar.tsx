/**
 * TabBar Component - Tab management strip with docking support
 */

import React, { useState, useRef, useEffect } from 'react';

export type DockPosition = 'center' | 'left' | 'right' | 'bottom';

export interface Tab {
  id: number;
  type: 'terminal' | 'editor' | 'editor-panel' | 'file' | 'files' | 'browser' | 'hester' | 'claude' | 'git' | 'docker' | 'flutter' | 'k8s' | 'hester-qa' | 'devops' | 'system' | 'sql' | 'library' | 'workstream' | 'custom';
  label: string;
  closable: boolean;
  watched?: boolean; // Whether this tab is being watched for idle state
  isIdle?: boolean; // Whether this tab is currently idle (no output for 10s)
  remoteCast?: boolean; // Whether this tab is being cast to a remote client (Aeronaut)
  // File-specific metadata (only for type='file')
  filePath?: string;
  fileModified?: boolean;
  fileLanguage?: string;
  // Browser-specific metadata (only for type='browser')
  browserUrl?: string;
  browserTitle?: string;
  browserLoading?: boolean;
  browserCheckpointReady?: boolean; // True when session+email captured for Frame checkpoint
}

export interface NewTabOption {
  type: Tab['type'];
  label: string;
  icon: string;
  shortcut?: string;
  defaultDock?: DockPosition;
}

export const NEW_TAB_OPTIONS: NewTabOption[] = [
  { type: 'files', label: 'Files', icon: '📂', shortcut: '⇧⌘E' },  // No default dock - starts in center
  { type: 'terminal', label: 'Terminal', icon: '💻', shortcut: '⇧⌘T' },
  { type: 'browser', label: 'Browser', icon: '🌐', shortcut: '⇧⌘B' },
  { type: 'hester', label: 'Hester', icon: '🐇', shortcut: '⇧⌘H' },
  { type: 'claude', label: 'Claude', icon: '🤖', shortcut: '⇧⌘C' },
  { type: 'git', label: 'Git (lazygit)', icon: '🌿', shortcut: '⇧⌘G' },
  { type: 'docker', label: 'Docker (lazydocker)', icon: '🐳', shortcut: '⇧⌘D' },
  { type: 'flutter', label: 'Flutter (flx)', icon: '📱', shortcut: '⇧⌘F' },
  { type: 'k8s', label: 'Kubernetes (k9s)', icon: '☸️', shortcut: '⇧⌘K' },
  { type: 'sql', label: 'SQL (pgcli)', icon: '🗄️', shortcut: '⇧⌘P' },
  { type: 'devops', label: 'DevOps', icon: '🚀', shortcut: '⇧⌘O' },
  { type: 'system', label: 'System Monitor (btop)', icon: '📊', shortcut: '⇧⌘M' },
  { type: 'library', label: 'Library', icon: '📚', shortcut: '⇧⌘L' },
  { type: 'hester-qa', label: 'Hester QA', icon: '🧪', shortcut: '⇧⌘Q' },
  { type: 'workstream', label: 'Workstream', icon: '📋', shortcut: '⇧⌘W' },
];

interface TabBarProps {
  tabs: Tab[];
  activeTabId: number | null;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onNewTab: (type: Tab['type'], dockPosition?: DockPosition) => void;
  onDockTab?: (id: number, position: DockPosition) => void;
  onRenameTab?: (id: number, newLabel: string) => void;
  onToggleWatch?: (id: number) => void; // Toggle watch state for idle detection
  onRefocus?: () => void; // Called when clicking empty area to refocus terminal
}

export const TAB_ICONS: Record<Tab['type'], string> = {
  terminal: '💻',
  editor: '📝',
  'editor-panel': '📝',
  file: '📄', // Default file icon, actual icon determined by getFileTabIcon
  files: '📂',
  browser: '🌐',
  hester: '🐇',
  claude: '🤖',
  git: '🌿',
  docker: '🐳',
  flutter: '📱',
  k8s: '☸️',
  sql: '🗄️',
  devops: '🚀',
  system: '📊',
  'hester-qa': '🧪',
  library: '📚',
  workstream: '📋',
  custom: '🔧',
};

// File icon mapper based on extension (for file tabs)
export function getFileTabIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
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
    c: '©️',
    cpp: '©️',
    h: '©️',
    hpp: '©️',
    // Config/data
    json: '📋',
    yaml: '📋',
    yml: '📋',
    toml: '📋',
    xml: '📋',
    sql: '🗄️',
    // Markdown/docs
    md: '📝',
    txt: '📄',
    // Styles
    css: '🎨',
    scss: '🎨',
    less: '🎨',
    html: '🌐',
    // Shell
    sh: '💻',
    bash: '💻',
    zsh: '💻',
  };
  return iconMap[ext] || '📄';
}

// Get the display icon for a tab (handles cast state, idle state, watched state, checkpoint state, and file types)
function getTabDisplayIcon(tab: Tab): string {
  // If being cast to a remote client (Aeronaut), show mobile phone
  if (tab.remoteCast) {
    return '📲';
  }
  // If watched and idle, show moon emoji
  if (tab.watched && tab.isIdle) {
    return '🌙';
  }
  // Browser tab states: checkpoint ready (📸) > watched (👁) > default (🌐)
  if (tab.type === 'browser') {
    if (tab.browserCheckpointReady) {
      return '📸'; // Session+email captured, ready for checkpoint
    }
    if (tab.watched) {
      return '👁'; // Watching but not yet ready for checkpoint
    }
  }
  // For file tabs, use file-specific icon based on extension
  if (tab.type === 'file' && tab.label) {
    return getFileTabIcon(tab.label);
  }
  return TAB_ICONS[tab.type];
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onDockTab,
  onRenameTab,
  onToggleWatch,
  onRefocus,
}) => {
  const [showDropdown, setShowDropdown] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    tabId: number;
    x: number;
    y: number;
  } | null>(null);
  const [editingTabId, setEditingTabId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Scroll active tab into view when it changes (e.g., via keyboard shortcuts)
  useEffect(() => {
    if (activeTabId === null) return;

    const tabElement = tabRefs.current.get(activeTabId);
    if (tabElement && tabsContainerRef.current) {
      // Use scrollIntoView with inline: 'nearest' to minimize scrolling
      // Only scrolls if the tab is outside the visible area
      tabElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeTabId]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showDropdown]);

  // Close context menu when clicking anywhere
  useEffect(() => {
    if (contextMenu) {
      const handleClick = () => setContextMenu(null);
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingTabId !== null && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  // Start renaming a tab
  const handleStartRename = (tabId: number) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      setEditValue(tab.label);
      setEditingTabId(tabId);
    }
    setContextMenu(null);
  };

  // Finish renaming
  const handleFinishRename = () => {
    if (editingTabId !== null && editValue.trim() && onRenameTab) {
      onRenameTab(editingTabId, editValue.trim());
    }
    setEditingTabId(null);
    setEditValue('');
  };

  // Cancel renaming
  const handleCancelRename = () => {
    setEditingTabId(null);
    setEditValue('');
  };

  const handleNewTab = (option: NewTabOption) => {
    onNewTab(option.type, option.defaultDock);
    setShowDropdown(false);
  };

  const handleContextMenu = (e: React.MouseEvent, tabId: number) => {
    e.preventDefault();
    setContextMenu({ tabId, x: e.clientX, y: e.clientY });
  };

  const handleDock = (position: DockPosition) => {
    if (contextMenu && onDockTab) {
      onDockTab(contextMenu.tabId, position);
    }
    setContextMenu(null);
  };

  // Handle click on tab bar background to refocus terminal
  const handleBackgroundClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && onRefocus) {
      onRefocus();
    }
  };

  return (
    <div className="tab-bar" onClick={handleBackgroundClick}>
      <div className="tabs" ref={tabsContainerRef} onClick={handleBackgroundClick}>
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            ref={(el) => {
              if (el) {
                tabRefs.current.set(tab.id, el);
              } else {
                tabRefs.current.delete(tab.id);
              }
            }}
            className={`tab ${tab.id === activeTabId ? 'active' : ''} ${tab.type === 'file' && tab.fileModified ? 'modified' : ''}`}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            onMouseDown={(e) => e.preventDefault()} // Prevent focus stealing from terminal
          >
            <span className="tab-icon">{getTabDisplayIcon(tab)}</span>
            {editingTabId === tab.id ? (
              <input
                ref={editInputRef}
                type="text"
                className="tab-label-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleFinishRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleFinishRename();
                  } else if (e.key === 'Escape') {
                    handleCancelRename();
                  }
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tab-label" onDoubleClick={() => handleStartRename(tab.id)}>{tab.label}</span>
            )}
            {tab.type === 'file' && tab.fileModified && <span className="tab-modified">●</span>}
            {index < 9 && editingTabId !== tab.id && <span className="tab-shortcut">⌘{index + 1}</span>}
            {tab.closable && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="new-tab-container" ref={dropdownRef}>
        <button
          className="new-tab-btn"
          onClick={() => setShowDropdown(!showDropdown)}
          title="New Tab"
        >
          +
        </button>
        {showDropdown && (
          <div className="new-tab-dropdown">
            {NEW_TAB_OPTIONS.map((option) => (
              <button
                key={option.type}
                className="dropdown-item"
                onClick={() => handleNewTab(option)}
              >
                <span className="dropdown-icon">{option.icon}</span>
                <span className="dropdown-label">{option.label}</span>
                {option.shortcut && (
                  <span className="dropdown-shortcut">{option.shortcut}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Context menu for docking and renaming */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          {onRenameTab && (
            <>
              <button onClick={() => handleStartRename(contextMenu.tabId)}>Rename</button>
              <hr />
            </>
          )}
          {onDockTab && (
            <>
              <button onClick={() => handleDock('left')}>Dock Left</button>
              <button onClick={() => handleDock('right')}>Dock Right</button>
              <button onClick={() => handleDock('bottom')}>Dock Bottom</button>
              <hr />
            </>
          )}
          {onToggleWatch && (() => {
            const tab = tabs.find(t => t.id === contextMenu.tabId);
            // Only show Watch option for PTY-based tabs (not files)
            if (tab && tab.type !== 'files') {
              return (
                <>
                  <button onClick={() => {
                    onToggleWatch(contextMenu.tabId);
                    setContextMenu(null);
                  }}>
                    {tab.watched ? '✓ Watching' : 'Watch'}
                  </button>
                  <hr />
                </>
              );
            }
            return null;
          })()}
          <button onClick={() => {
            onCloseTab(contextMenu.tabId);
            setContextMenu(null);
          }}>
            Close Tab
          </button>
        </div>
      )}
    </div>
  );
};
