/**
 * ExplorationTree - Collapsible tree for exploration sessions
 *
 * Renders the idea exploration tree with expand/collapse, node selection,
 * selection mode (right-click → Select → checkboxes + action bar),
 * inline rename (double-click), and context menus.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  ExplorationNode,
  ExplorationSession,
  SessionSummary,
  AGENT_MODE_CONFIG,
  AgentMode,
  SynthesisAction,
} from './types';

interface ExplorationTreeProps {
  session: ExplorationSession | null;
  sessions: SessionSummary[];
  activeNodeId: string | null;
  selectionMode: boolean;
  selectedNodeIds: Set<string>;
  onSelectNode: (nodeId: string) => void;
  onToggleSelectNode: (nodeId: string) => void;
  onEnterSelectionMode: (nodeId?: string) => void;
  onExitSelectionMode: () => void;
  onCreateSession: (title: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onSaveAsIdea?: (nodeId: string) => void;
  onPromoteToWorkstream?: (nodeId: string) => void;
  onRenameNode?: (nodeId: string, newLabel: string) => void;
  onSynthesize?: (action: SynthesisAction, nodeIds: string[]) => void;
  onCopyToMarkdown?: (nodeIds: string[]) => void;
  onVisualize?: (nodeIds: string[]) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  nodeId: string | null;
}

export const ExplorationTree: React.FC<ExplorationTreeProps> = ({
  session,
  sessions,
  activeNodeId,
  selectionMode,
  selectedNodeIds,
  onSelectNode,
  onToggleSelectNode,
  onEnterSelectionMode,
  onExitSelectionMode,
  onCreateSession,
  onSwitchSession,
  onDeleteSession,
  onDeleteNode,
  onSaveAsIdea,
  onPromoteToWorkstream,
  onRenameNode,
  onSynthesize,
  onCopyToMarkdown,
  onVisualize,
}) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showNewSession, setShowNewSession] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [showSessionList, setShowSessionList] = useState(false);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, nodeId: null,
  });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  // Focus new session input when shown
  useEffect(() => {
    if (showNewSession && newInputRef.current) {
      newInputRef.current.focus();
    }
  }, [showNewSession]);

  // Close context menu on outside click; Escape exits selection mode
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu.visible) {
          setContextMenu(prev => ({ ...prev, visible: false }));
        } else if (selectionMode) {
          onExitSelectionMode();
        }
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [contextMenu.visible, selectionMode, onExitSelectionMode]);

  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(prev => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu.visible]);

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, nodeId });
  }, []);

  const handleNewSession = useCallback(() => {
    if (!newTitle.trim()) return;
    onCreateSession(newTitle.trim());
    setNewTitle('');
    setShowNewSession(false);
  }, [newTitle, onCreateSession]);

  const handleRenameCommit = useCallback((nodeId: string, newLabel: string) => {
    setRenamingNodeId(null);
    if (newLabel.trim() && onRenameNode) {
      onRenameNode(nodeId, newLabel.trim());
    }
  }, [onRenameNode]);

  const startRename = useCallback((nodeId: string) => {
    setRenamingNodeId(nodeId);
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  const selectedCount = selectedNodeIds.size;
  const selectedArray = Array.from(selectedNodeIds);

  return (
    <div className="library-tree">
      {/* Header */}
      <div className="library-tree-header">
        <span className="library-tree-title">
          {session ? session.title : 'Library'}
        </span>
        <div className="library-tree-actions">
          <button
            className="library-tree-btn"
            onClick={() => setShowSessionList(!showSessionList)}
            title="Switch session"
          >
            ☰
          </button>
          <button
            className="library-tree-btn"
            onClick={() => setShowNewSession(!showNewSession)}
            title="New exploration"
          >
            +
          </button>
        </div>
      </div>

      {/* Selection mode action bar */}
      {selectionMode && (
        <div className="library-tree-selection-bar">
          <span className="library-tree-selection-count">
            {selectedCount} selected
          </span>
          <div className="library-tree-selection-actions">
            {selectedCount >= 1 && (
              <button
                className="library-tree-selection-btn"
                onClick={() => onSynthesize?.('summarize', selectedArray)}
              >
                Summarize
              </button>
            )}
            {selectedCount >= 2 && (
              <>
                <button
                  className="library-tree-selection-btn"
                  onClick={() => onSynthesize?.('compare', selectedArray)}
                >
                  Compare
                </button>
                <button
                  className="library-tree-selection-btn"
                  onClick={() => onSynthesize?.('combine', selectedArray)}
                >
                  Combine
                </button>
              </>
            )}
            {selectedCount >= 1 && (
              <button
                className="library-tree-selection-btn"
                onClick={() => onVisualize?.(selectedArray)}
              >
                Visualize
              </button>
            )}
            {selectedCount >= 1 && (
              <button
                className="library-tree-selection-btn"
                onClick={() => onCopyToMarkdown?.(selectedArray)}
              >
                Copy MD
              </button>
            )}
            <button
              className="library-tree-selection-btn cancel"
              onClick={onExitSelectionMode}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* New session input */}
      {showNewSession && (
        <div className="library-tree-new">
          <input
            ref={newInputRef}
            className="library-tree-new-input"
            type="text"
            placeholder="Seed thought..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleNewSession();
              if (e.key === 'Escape') setShowNewSession(false);
            }}
          />
        </div>
      )}

      {/* Session list dropdown */}
      {showSessionList && (
        <div className="library-tree-sessions">
          {sessions.length === 0 && (
            <div className="library-tree-empty">No sessions yet</div>
          )}
          {sessions.map((s) => (
            <div
              key={s.session_id}
              className={`library-tree-session-item ${
                session?.session_id === s.session_id ? 'active' : ''
              }`}
              onClick={() => {
                onSwitchSession(s.session_id);
                setShowSessionList(false);
              }}
            >
              <span className="library-tree-session-title">{s.title}</span>
              <span className="library-tree-session-meta">
                {s.node_count} nodes
              </span>
              <button
                className="library-tree-session-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSession(s.session_id);
                }}
                title="Delete session"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tree content */}
      <div className="library-tree-content">
        {!session && (
          <div className="library-tree-empty">
            Create a new exploration to get started
          </div>
        )}
        {session && session.root_id && (
          <TreeNode
            node={session.nodes[session.root_id]}
            session={session}
            depth={0}
            collapsed={collapsed}
            activeNodeId={activeNodeId}
            selectionMode={selectionMode}
            selectedNodeIds={selectedNodeIds}
            renamingNodeId={renamingNodeId}
            onSelect={onSelectNode}
            onToggleSelect={onToggleSelectNode}
            onToggle={toggleCollapse}
            onContextMenu={handleContextMenu}
            onStartRename={startRename}
            onRenameCommit={handleRenameCommit}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu.visible && contextMenu.nodeId && (
        <div
          ref={contextMenuRef}
          className="library-tree-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={() => {
              onSelectNode(contextMenu.nodeId!);
              setContextMenu(prev => ({ ...prev, visible: false }));
            }}
          >
            Open
          </div>
          {onSynthesize && (
            <div
              className="context-menu-item"
              onClick={() => {
                onSynthesize('summarize', [contextMenu.nodeId!]);
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Summarize
            </div>
          )}
          {onVisualize && (
            <div
              className="context-menu-item"
              onClick={() => {
                onVisualize([contextMenu.nodeId!]);
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Visualize
            </div>
          )}
          {onCopyToMarkdown && (
            <div
              className="context-menu-item"
              onClick={() => {
                onCopyToMarkdown([contextMenu.nodeId!]);
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Copy to Markdown
            </div>
          )}
          <div className="context-menu-separator" />
          <div
            className="context-menu-item"
            onClick={() => {
              onEnterSelectionMode(contextMenu.nodeId!);
              setContextMenu(prev => ({ ...prev, visible: false }));
            }}
          >
            Select
          </div>
          {onRenameNode && (
            <div
              className="context-menu-item"
              onClick={() => startRename(contextMenu.nodeId!)}
            >
              Rename
            </div>
          )}
          {onSaveAsIdea && (
            <div
              className="context-menu-item"
              onClick={() => {
                onSaveAsIdea(contextMenu.nodeId!);
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Save as Idea
            </div>
          )}
          {onPromoteToWorkstream && (
            <div
              className="context-menu-item"
              onClick={(e) => {
                e.stopPropagation();
                onPromoteToWorkstream(contextMenu.nodeId!);
                setContextMenu({ visible: false, x: 0, y: 0, nodeId: null });
              }}
            >
              Create Workstream
            </div>
          )}
          {onDeleteNode && contextMenu.nodeId !== session?.root_id && (
            <div
              className="context-menu-item"
              onClick={() => {
                onDeleteNode(contextMenu.nodeId!);
                setContextMenu(prev => ({ ...prev, visible: false }));
              }}
            >
              Delete Node
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Recursive tree node component
interface TreeNodeProps {
  node: ExplorationNode;
  session: ExplorationSession;
  depth: number;
  collapsed: Set<string>;
  activeNodeId: string | null;
  selectionMode: boolean;
  selectedNodeIds: Set<string>;
  renamingNodeId: string | null;
  onSelect: (nodeId: string) => void;
  onToggleSelect: (nodeId: string) => void;
  onToggle: (nodeId: string) => void;
  onContextMenu: (e: React.MouseEvent, nodeId: string) => void;
  onStartRename: (nodeId: string) => void;
  onRenameCommit: (nodeId: string, newLabel: string) => void;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  session,
  depth,
  collapsed,
  activeNodeId,
  selectionMode,
  selectedNodeIds,
  renamingNodeId,
  onSelect,
  onToggleSelect,
  onToggle,
  onContextMenu,
  onStartRename,
  onRenameCommit,
}) => {
  if (!node) return null;

  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const isActive = activeNodeId === node.id;
  const isSelected = selectedNodeIds.has(node.id);
  const isRenaming = renamingNodeId === node.id;
  const modeConfig = AGENT_MODE_CONFIG[node.agent_mode as AgentMode];
  const hasConversation = node.conversation_history.length > 0;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isRenaming) return;
    if (selectionMode) {
      onToggleSelect(node.id);
    } else {
      onSelect(node.id);
    }
  }, [isRenaming, selectionMode, node.id, onSelect, onToggleSelect]);

  return (
    <div className="library-tree-node">
      <div
        className={`library-tree-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          borderLeftColor: modeConfig?.color || 'transparent',
        }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node.id)}
        onDoubleClick={(e) => {
          if (selectionMode) return;
          e.stopPropagation();
          onStartRename(node.id);
        }}
      >
        {selectionMode && (
          <input
            type="checkbox"
            className="library-tree-node-checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(node.id)}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {hasChildren && (
          <span
            className="library-tree-expand"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
        )}
        {!hasChildren && <span className="library-tree-expand-spacer" />}
        <span className="library-tree-icon">{modeConfig?.icon || '\uD83D\uDCA1'}</span>
        {isRenaming ? (
          <RenameInput
            initialValue={node.label}
            onCommit={(val) => onRenameCommit(node.id, val)}
            onCancel={() => onRenameCommit(node.id, node.label)}
          />
        ) : (
          <span className="library-tree-label">{node.label}</span>
        )}
        {!isRenaming && hasConversation && (
          <span className="library-tree-badge">
            {node.conversation_history.filter(m => m.role === 'assistant').length}
          </span>
        )}
      </div>

      {hasChildren && !isCollapsed && (
        <div className="library-tree-children">
          {node.children.map((childId) => {
            const child = session.nodes[childId];
            if (!child) return null;
            return (
              <TreeNode
                key={childId}
                node={child}
                session={session}
                depth={depth + 1}
                collapsed={collapsed}
                activeNodeId={activeNodeId}
                selectionMode={selectionMode}
                selectedNodeIds={selectedNodeIds}
                renamingNodeId={renamingNodeId}
                onSelect={onSelect}
                onToggleSelect={onToggleSelect}
                onToggle={onToggle}
                onContextMenu={onContextMenu}
                onStartRename={onStartRename}
                onRenameCommit={onRenameCommit}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

// Inline rename input — auto-focuses, commits on Enter/blur, cancels on Escape
const RenameInput: React.FC<{
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}> = ({ initialValue, onCommit, onCancel }) => {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, []);

  return (
    <input
      ref={ref}
      className="library-tree-rename-input"
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        e.stopPropagation();
      }}
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
};

export default ExplorationTree;
