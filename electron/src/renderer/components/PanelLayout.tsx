/**
 * PanelLayout - Resizable panel infrastructure
 *
 * Provides left, right, and bottom panels that can contain docked tabs.
 * Uses react-resizable-panels for smooth resizing with persistence.
 */

import React from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Tab } from './TabBar';

// Extended tab data with dock position
export interface DockableTab extends Tab {
  ptyId: number | null;
  dockPosition: 'center' | 'left' | 'right' | 'bottom';
}

// Get icon for tab type
function getTabIcon(type: Tab['type']): string {
  switch (type) {
    case 'terminal': return '💻';
    case 'editor': return '📝';
    case 'files': return '📂';
    case 'hester': return '🐇';
    case 'claude': return '🤖';
    case 'git': return '🌿';
    case 'docker': return '🐳';
    case 'flutter': return '📱';
    case 'k8s': return '☸️';
    case 'devops': return '🚀';
    case 'system': return '📊';
    case 'hester-qa': return '🧪';
    default: return '📋';
  }
}

interface PanelLayoutProps {
  leftTabs: DockableTab[];
  rightTabs: DockableTab[];
  bottomTabs: DockableTab[];
  activeLeftTabId: number | null;
  activeRightTabId: number | null;
  activeBottomTabId: number | null;
  onSelectTab: (id: number, position: 'left' | 'right' | 'bottom') => void;
  onCloseTab: (id: number) => void;
  onDockTab: (id: number, position: DockableTab['dockPosition']) => void;
  onRenameTab?: (id: number, newLabel: string) => void;
  onToggleWatch?: (id: number) => void;
  renderTab: (tab: DockableTab, active: boolean) => React.ReactNode;
  children: React.ReactNode;
}

export const PanelLayout: React.FC<PanelLayoutProps> = ({
  leftTabs,
  rightTabs,
  bottomTabs,
  activeLeftTabId,
  activeRightTabId,
  activeBottomTabId,
  onSelectTab,
  onCloseTab,
  onDockTab,
  onRenameTab,
  onToggleWatch,
  renderTab,
  children,
}) => {
  const hasLeft = leftTabs.length > 0;
  const hasRight = rightTabs.length > 0;
  const hasBottom = bottomTabs.length > 0;

  return (
    <PanelGroup orientation="horizontal" id="lee-h-layout" style={{ height: '100%' }}>
      {hasLeft && (
        <>
          <Panel
            id="left"
            defaultSize="20%"
            minSize="10%"
            maxSize="40%"
            collapsible
          >
            <PanelTabs
              tabs={leftTabs}
              position="left"
              activeTabId={activeLeftTabId}
              onSelectTab={(id) => onSelectTab(id, 'left')}
              onCloseTab={onCloseTab}
              onDockTab={onDockTab}
              onRenameTab={onRenameTab}
              onToggleWatch={onToggleWatch}
              renderTab={renderTab}
            />
          </Panel>
          <PanelResizeHandle className="resize-handle-h" />
        </>
      )}

      <Panel id="center" minSize="30%">
        {hasBottom ? (
          <PanelGroup orientation="vertical" id="lee-v-layout" style={{ height: '100%' }}>
            <Panel id="main" minSize="20%">
              {children}
            </Panel>
            <PanelResizeHandle className="resize-handle-v" />
            <Panel
              id="bottom"
              defaultSize="30%"
              minSize="10%"
              collapsible
            >
              <PanelTabs
                tabs={bottomTabs}
                position="bottom"
                activeTabId={activeBottomTabId}
                onSelectTab={(id) => onSelectTab(id, 'bottom')}
                onCloseTab={onCloseTab}
                onDockTab={onDockTab}
                onRenameTab={onRenameTab}
                onToggleWatch={onToggleWatch}
                renderTab={renderTab}
              />
            </Panel>
          </PanelGroup>
        ) : (
          children
        )}
      </Panel>

      {hasRight && (
        <>
          <PanelResizeHandle className="resize-handle-h" />
          <Panel
            id="right"
            defaultSize="25%"
            minSize="10%"
            maxSize="40%"
            collapsible
          >
            <PanelTabs
              tabs={rightTabs}
              position="right"
              activeTabId={activeRightTabId}
              onSelectTab={(id) => onSelectTab(id, 'right')}
              onCloseTab={onCloseTab}
              onDockTab={onDockTab}
              onRenameTab={onRenameTab}
              onToggleWatch={onToggleWatch}
              renderTab={renderTab}
            />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
};

// Get the display icon for a tab (handles idle state)
function getTabDisplayIcon(tab: DockableTab): string {
  // If watched and idle, show moon emoji
  if (tab.watched && tab.isIdle) {
    return '🌙';
  }
  return getTabIcon(tab.type);
}

// Mini tab bar for docked panels
interface PanelTabsProps {
  tabs: DockableTab[];
  position: 'left' | 'right' | 'bottom';
  activeTabId: number | null;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onDockTab: (id: number, position: DockableTab['dockPosition']) => void;
  onRenameTab?: (id: number, newLabel: string) => void;
  onToggleWatch?: (id: number) => void;
  renderTab: (tab: DockableTab, active: boolean) => React.ReactNode;
}

const PanelTabs: React.FC<PanelTabsProps> = ({
  tabs,
  position,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onDockTab,
  onRenameTab,
  onToggleWatch,
  renderTab,
}) => {
  const [contextMenu, setContextMenu] = React.useState<{
    tabId: number;
    x: number;
    y: number;
  } | null>(null);
  const [editingTabId, setEditingTabId] = React.useState<number | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const editInputRef = React.useRef<HTMLInputElement>(null);

  const handleContextMenu = (e: React.MouseEvent, tabId: number) => {
    e.preventDefault();
    setContextMenu({ tabId, x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => setContextMenu(null);

  // Close context menu on click outside
  React.useEffect(() => {
    if (contextMenu) {
      const handleClick = () => closeContextMenu();
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  // Focus edit input when editing starts
  React.useEffect(() => {
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
    closeContextMenu();
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

  return (
    <div className="panel-container">
      <div className="panel-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`panel-tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            onMouseDown={(e) => e.preventDefault()} // Prevent focus stealing from terminal
          >
            <span className="panel-tab-icon">{getTabDisplayIcon(tab)}</span>
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
              <span className="panel-tab-label" onDoubleClick={() => handleStartRename(tab.id)}>{tab.label}</span>
            )}
            {tab.closable && (
              <span
                className="panel-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="panel-content">
        {tabs.map(tab => renderTab(tab, tab.id === activeTabId))}
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
          {position !== 'left' && (
            <button onClick={() => { onDockTab(contextMenu.tabId, 'left'); closeContextMenu(); }}>
              Dock Left
            </button>
          )}
          {position !== 'right' && (
            <button onClick={() => { onDockTab(contextMenu.tabId, 'right'); closeContextMenu(); }}>
              Dock Right
            </button>
          )}
          {position !== 'bottom' && (
            <button onClick={() => { onDockTab(contextMenu.tabId, 'bottom'); closeContextMenu(); }}>
              Dock Bottom
            </button>
          )}
          <button onClick={() => { onDockTab(contextMenu.tabId, 'center'); closeContextMenu(); }}>
            Move to Center
          </button>
          {onToggleWatch && (() => {
            const tab = tabs.find(t => t.id === contextMenu.tabId);
            // Only show Watch option for PTY-based tabs (not files)
            if (tab && tab.type !== 'files') {
              return (
                <>
                  <hr />
                  <button onClick={() => {
                    onToggleWatch(contextMenu.tabId);
                    closeContextMenu();
                  }}>
                    {tab.watched ? '✓ Watching' : 'Watch'}
                  </button>
                </>
              );
            }
            return null;
          })()}
          <hr />
          <button onClick={() => { onCloseTab(contextMenu.tabId); closeContextMenu(); }}>
            Close Tab
          </button>
        </div>
      )}
    </div>
  );
};

export default PanelLayout;
