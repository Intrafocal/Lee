/**
 * TabBar Component - Tab management strip with docking support
 */

import React, { useState, useRef, useEffect } from 'react';
import { Icon, HesterGlyph, type IconName } from './Icon';

export type DockPosition = 'center' | 'left' | 'right' | 'bottom';

export interface Tab {
  id: number;
  type: 'terminal' | 'editor' | 'editor-panel' | 'file' | 'files' | 'browser' | 'hester' | 'claude' | 'git' | 'docker' | 'flutter' | 'k8s' | 'hester-qa' | 'devops' | 'system' | 'sql' | 'library' | 'workstream' | 'spyglass' | 'bridge' | 'custom' | 'agent' | 'kicad' | 'model' | 'pdf' | 'binary';
  label: string;
  closable: boolean;
  watched?: boolean; // Whether this tab is being watched for idle state (agent tabs only)
  isIdle?: boolean; // Whether this tab is currently idle (no output for 10s)
  remoteCast?: boolean; // Whether this tab is being cast to a remote client (Aeronaut)
  // Agent-specific metadata (only for type='agent')
  provider?: string; // e.g. 'hester', 'claude', 'pi', 'codex'
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
  /** Our fixed options pass an <Icon>/<HesterGlyph> element; TUI options
   *  fetched from the user's config pass their own emoji string as-is. */
  icon: React.ReactNode;
  shortcut?: string;
  defaultDock?: DockPosition;
  provider?: string; // For agent tabs — which provider to spawn
}

/** Core tabs — always shown, fundamental IDE features */
export const CORE_TAB_OPTIONS: NewTabOption[] = [
  { type: 'files', label: 'Files', icon: <Icon name="folder" size={16} />, shortcut: '⇧⌘E' },
  { type: 'terminal', label: 'Terminal', icon: <Icon name="terminal" size={16} />, shortcut: '⇧⌘T' },
  { type: 'browser', label: 'Browser', icon: <Icon name="browser" size={16} />, shortcut: '⇧⌘B' },
  { type: 'agent', label: 'Hester', icon: <HesterGlyph size={16} />, shortcut: '⇧⌘H', provider: 'hester' },
  { type: 'agent', label: 'Claude', icon: <Icon name="agent" size={16} />, shortcut: '⇧⌘C', provider: 'claude' },
  { type: 'agent', label: 'Pi', icon: <Icon name="circle" size={16} />, shortcut: '⇧⌘I', provider: 'pi' },
  { type: 'bridge', label: 'Bridge', icon: <Icon name="link" size={16} /> },
];

/** Feature tabs — React components, always shown */
export const FEATURE_TAB_OPTIONS: NewTabOption[] = [
  { type: 'devops', label: 'DevOps', icon: <Icon name="devops" size={16} />, shortcut: '⇧⌘O' },
  { type: 'library', label: 'Library', icon: <Icon name="book" size={16} />, shortcut: '⇧⌘Y' },
  { type: 'workstream', label: 'Workstream', icon: <Icon name="list" size={16} />, shortcut: '⇧⌘W' },
];

interface TabBarProps {
  tabs: Tab[];
  activeTabId: number | null;
  tuiOptions?: NewTabOption[];
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onNewTab: (type: Tab['type'], dockPosition?: DockPosition, provider?: string) => void;
  onDockTab?: (id: number, position: DockPosition) => void;
  onRenameTab?: (id: number, newLabel: string) => void;
  onToggleWatch?: (id: number) => void; // Toggle watch state for agent tabs
  onRefocus?: () => void; // Called when clicking empty area to refocus terminal
  onConfigureTUIs?: () => void; // Open TUI config editor
  onSwitchAgentProvider?: (tabId: number, provider: string) => void; // Switch provider for agent tab
  agentProviders?: Record<string, { name: string; icon?: string }>; // Available providers for switcher
}

export const TAB_ICONS: Record<Tab['type'], IconName> = {
  terminal: 'terminal',
  editor: 'editor',
  'editor-panel': 'editor',
  file: 'file-code', // Default file icon, actual icon determined by getFileTabIcon
  files: 'folder',
  hester: 'agent', // rendered as HesterGlyph, see TabDisplayIcon
  browser: 'browser',
  claude: 'agent',
  git: 'git',
  docker: 'docker',
  flutter: 'mobile',
  k8s: 'kubernetes',
  sql: 'sql',
  devops: 'devops',
  system: 'system',
  'hester-qa': 'check',
  library: 'book',
  workstream: 'list',
  spyglass: 'search',
  bridge: 'link',
  custom: 'settings',
  agent: 'agent',
  kicad: 'machine',
  model: 'system',
  pdf: 'file-code',
  binary: 'download',
};

// Default icons per known agent provider key ('hester' is rendered as HesterGlyph)
const AGENT_PROVIDER_ICONS: Record<string, IconName> = {
  claude: 'agent',
  pi: 'circle',
  devops: 'devops',
  codex: 'agent',
  gemini: 'circle',
};

// File icon mapper based on extension (for file tabs)
export function getFileTabIcon(filename: string): IconName {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
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
    c: 'file-code',
    cpp: 'file-code',
    h: 'file-code',
    hpp: 'file-code',
    // Config/data
    json: 'file-code',
    yaml: 'file-code',
    yml: 'file-code',
    toml: 'file-code',
    xml: 'file-code',
    sql: 'sql',
    // Markdown/docs
    md: 'book',
    txt: 'file-code',
    // Styles
    css: 'file-code',
    scss: 'file-code',
    less: 'file-code',
    html: 'file-code',
    // Shell
    sh: 'terminal',
    bash: 'terminal',
    zsh: 'terminal',
  };
  return iconMap[ext] || 'file-code';
}

// Render the display icon for a tab (handles cast state, idle state, watched
// state, checkpoint state, file types, and Hester's glyph)
const TabDisplayIcon: React.FC<{ tab: Tab; size?: number }> = ({ tab, size = 16 }) => {
  // If being cast to a remote client (Aeronaut), show mobile phone
  if (tab.remoteCast) {
    return <Icon name="mobile" size={size} />;
  }
  // If watched and idle, show a clock
  if (tab.watched && tab.isIdle) {
    return <Icon name="clock" size={size} />;
  }
  // Browser tab states: checkpoint ready > watched (eye) > default
  if (tab.type === 'browser') {
    if (tab.browserCheckpointReady) {
      return <Icon name="download" size={size} />; // Session+email captured, ready for checkpoint
    }
    if (tab.watched) {
      return <Icon name="eye" size={size} />; // Watching but not yet ready for checkpoint
    }
  }
  // For file tabs, use file-specific icon based on extension
  if (tab.type === 'file' && tab.label) {
    return <Icon name={getFileTabIcon(tab.label)} size={size} />;
  }
  // For agent tabs, use provider-specific icon (Hester gets its own glyph)
  if (tab.type === 'agent') {
    if (tab.provider === 'hester' || !tab.provider) {
      return <HesterGlyph size={size} />;
    }
    return <Icon name={AGENT_PROVIDER_ICONS[tab.provider] ?? TAB_ICONS.agent} size={size} />;
  }
  if (tab.type === 'hester') {
    return <HesterGlyph size={size} />;
  }
  return <Icon name={TAB_ICONS[tab.type]} size={size} />;
};

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  tuiOptions,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onDockTab,
  onRenameTab,
  onToggleWatch,
  onRefocus,
  onConfigureTUIs,
  onSwitchAgentProvider,
  agentProviders,
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
    onNewTab(option.type, option.defaultDock, option.provider);
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
            <span className="tab-icon"><TabDisplayIcon tab={tab} /></span>
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
            {tab.type === 'file' && tab.fileModified && <span className="tab-modified status-dot status-dot-warning" />}
            {index < 9 && editingTabId !== tab.id && <span className="tab-shortcut">⌘{index + 1}</span>}
            {tab.closable && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <Icon name="close" size={12} />
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
          <Icon name="plus" size={14} />
        </button>
        {showDropdown && (
          <div className="new-tab-dropdown">
            {CORE_TAB_OPTIONS.map((option) => (
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
            {tuiOptions && tuiOptions.length > 0 && (
              <>
                <div className="dropdown-divider" />
                {tuiOptions.map((option) => (
                  <button
                    key={option.type + '-' + option.label}
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
              </>
            )}
            <div className="dropdown-divider" />
            {FEATURE_TAB_OPTIONS.map((option) => (
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
            {onConfigureTUIs && (
              <>
                <div className="dropdown-divider" />
                <button
                  className="dropdown-item dropdown-configure"
                  onClick={() => {
                    onConfigureTUIs();
                    setShowDropdown(false);
                  }}
                >
                  <span className="dropdown-icon"><Icon name="settings" size={16} /></span>
                  <span className="dropdown-label">Configure TUIs...</span>
                </button>
              </>
            )}
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
          {(() => {
            const tab = tabs.find(t => t.id === contextMenu.tabId);
            if (!tab) return null;

            return (
              <>
                {/* Watch — agent tabs only */}
                {onToggleWatch && tab.type === 'agent' && (
                  <>
                    <button onClick={() => {
                      onToggleWatch(contextMenu.tabId);
                      setContextMenu(null);
                    }}>
                      {tab.watched ? <><Icon name="check" size={12} className="icon-inline" /> Watching</> : 'Watch'}
                    </button>
                    <hr />
                  </>
                )}

                {/* Provider switcher — agent tabs only */}
                {tab.type === 'agent' && onSwitchAgentProvider && agentProviders && (
                  <>
                    <div className="context-menu-submenu-label">Switch Provider</div>
                    {Object.entries(agentProviders).map(([key, def]) => (
                      <button
                        key={key}
                        className={tab.provider === key ? 'context-menu-item-active' : ''}
                        onClick={() => {
                          onSwitchAgentProvider(contextMenu.tabId, key);
                          setContextMenu(null);
                        }}
                      >
                        {key === 'hester'
                          ? <HesterGlyph size={14} className="icon-inline" />
                          : AGENT_PROVIDER_ICONS[key]
                            ? <Icon name={AGENT_PROVIDER_ICONS[key]} size={14} className="icon-inline" />
                            : (def.icon || <Icon name="agent" size={14} className="icon-inline" />)} {def.name}
                        {tab.provider === key && <Icon name="check" size={12} className="icon-inline" />}
                      </button>
                    ))}
                    <hr />
                  </>
                )}
              </>
            );
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
