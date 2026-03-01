/**
 * NodeChat - Live chat panel for an exploration node
 *
 * Renders conversation history, streams new responses via SSE,
 * displays search results (docs/web), and shows a session overview
 * when the root/session node is selected.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MarkdownPreview } from '../MarkdownPreview';
import {
  ExplorationNode,
  ExplorationSession,
  ConversationMessage,
  PhaseEvent,
  AGENT_MODE_CONFIG,
  AgentMode,
  SearchResults,
  NodeType,
  SynthesisAction,
} from './types';

// Phase display
const PHASE_DISPLAY: Record<string, { icon: string; label: string }> = {
  preparing: { icon: '🔧', label: 'Preparing' },
  thinking: { icon: '🤔', label: 'Thinking' },
  acting: { icon: '⚡', label: 'Acting' },
  observing: { icon: '👁️', label: 'Observing' },
  responding: { icon: '💬', label: 'Responding' },
};

interface NodeChatProps {
  session: ExplorationSession | null;
  sessionId: string | null;
  node: ExplorationNode | null;
  isRootNode: boolean;
  isStreaming: boolean;
  streamingText: string | null;
  phases: PhaseEvent[];
  canContinue?: boolean;
  onContinue?: () => void;
  onSelectNode?: (nodeId: string) => void;
  searchResults?: SearchResults | null;
  onPromoteSource?: (label: string, nodeType: NodeType, content: string) => void;
  // Selection mode props
  selectionMode: boolean;
  selectedNodeIds: Set<string>;
  onToggleSelectNode: (nodeId: string) => void;
  onEnterSelectionMode: (nodeId?: string) => void;
  onExitSelectionMode: () => void;
  onSynthesize?: (action: SynthesisAction, nodeIds: string[]) => void;
  onCopyToMarkdown?: (nodeIds: string[]) => void;
  onVisualize?: (nodeIds: string[]) => void;
}

export const NodeChat: React.FC<NodeChatProps> = ({
  session,
  sessionId,
  node,
  isRootNode,
  isStreaming,
  streamingText,
  phases,
  canContinue,
  onContinue,
  onSelectNode,
  searchResults,
  onPromoteSource,
  selectionMode,
  selectedNodeIds,
  onToggleSelectNode,
  onEnterSelectionMode,
  onExitSelectionMode,
  onSynthesize,
  onCopyToMarkdown,
  onVisualize,
}) => {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [focusedMsgIndex, setFocusedMsgIndex] = useState<number | null>(null);
  const prevHistoryLenRef = useRef<number>(0);
  const userHasScrolledRef = useRef(false);

  // Count visible (non-system) messages
  const visibleMessages = node?.conversation_history?.filter(m => m.role !== 'system') || [];
  const msgCount = visibleMessages.length;

  // When a new response arrives (history length grows), scroll to the last user message
  useEffect(() => {
    const currentLen = node?.conversation_history?.length || 0;
    if (currentLen > prevHistoryLenRef.current && messagesRef.current) {
      // Find the last user message element
      const msgElements = messagesRef.current.querySelectorAll('[data-msg-index]');
      let lastUserEl: Element | null = null;
      msgElements.forEach(el => {
        if (el.classList.contains('user')) lastUserEl = el;
      });
      if (lastUserEl) {
        (lastUserEl as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
        userHasScrolledRef.current = false;
      }
    }
    prevHistoryLenRef.current = currentLen;
  }, [node?.conversation_history?.length]);

  // Track user scroll — once they scroll manually, stop auto-scrolling
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const handleScroll = () => { userHasScrolledRef.current = true; };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Reset scroll tracking when node changes
  useEffect(() => {
    userHasScrolledRef.current = false;
    setFocusedMsgIndex(null);
    prevHistoryLenRef.current = node?.conversation_history?.length || 0;
  }, [node?.id]);

  // Navigate between messages (all visible messages, not just user)
  const scrollToMessage = useCallback((index: number) => {
    if (!messagesRef.current) return;
    const el = messagesRef.current.querySelector(`[data-msg-index="${index}"]`);
    if (el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
      setFocusedMsgIndex(index);
    }
  }, []);

  const handlePrevMessage = useCallback(() => {
    if (msgCount === 0) return;
    const current = focusedMsgIndex ?? msgCount;
    const next = Math.max(0, current - 1);
    scrollToMessage(next);
  }, [focusedMsgIndex, msgCount, scrollToMessage]);

  const handleNextMessage = useCallback(() => {
    if (msgCount === 0) return;
    const current = focusedMsgIndex ?? -1;
    const next = Math.min(msgCount - 1, current + 1);
    scrollToMessage(next);
  }, [focusedMsgIndex, msgCount, scrollToMessage]);

  // Search results view — takes over the panel when active
  if (searchResults) {
    return (
      <div className="library-chat">
        <div className="library-chat-header">
          <span
            className="library-chat-mode-badge"
            style={{ background: searchResults.docs.length > 0 || searchResults.docError
              ? AGENT_MODE_CONFIG.docs.color
              : AGENT_MODE_CONFIG.web.color
            }}
          >
            {searchResults.web ? '🌐 Web' : '📄 Docs'} Search
          </span>
          <span className="library-chat-node-label">{searchResults.query}</span>
        </div>
        <div className="library-chat-messages">
          {searchResults.isSearching && (
            <div className="library-chat-phase">
              <span className="library-chat-phase-icon">🔍</span>
              <span className="library-chat-phase-label">Searching...</span>
            </div>
          )}

          {searchResults.docError && (
            <div className="library-search-error">
              Doc search: {searchResults.docError}
            </div>
          )}

          {searchResults.docs.map((result, i) => (
            <div key={i} className="library-search-item">
              <div className="library-search-item-header">
                <span className="library-search-item-icon">📄</span>
                <span className="library-search-item-path">{result.file_path}</span>
                <span className="library-search-item-score">
                  {Math.round(result.similarity * 100)}%
                </span>
                {onPromoteSource && (
                  <button
                    className="library-search-promote-btn"
                    onClick={() => onPromoteSource(
                      result.file_path.split('/').pop() || result.file_path,
                      'source_file',
                      result.chunk_text,
                    )}
                    title="Add as source node"
                  >
                    + Node
                  </button>
                )}
              </div>
              <div className="library-search-item-excerpt">
                {result.chunk_text.slice(0, 300)}
                {result.chunk_text.length > 300 ? '...' : ''}
              </div>
            </div>
          ))}

          {!searchResults.isSearching && searchResults.docs.length === 0 && !searchResults.web && !searchResults.docError && (
            <div className="library-search-empty">No results found.</div>
          )}

          {searchResults.web && (
            <div className="library-search-web">
              <div className="library-search-item-header">
                <span className="library-search-item-icon">🌐</span>
                <span className="library-search-item-path">Web Research</span>
                {onPromoteSource && (
                  <button
                    className="library-search-promote-btn"
                    onClick={() => onPromoteSource(
                      searchResults.query.slice(0, 50),
                      'source_web',
                      searchResults.web!.answer,
                    )}
                    title="Add as source node"
                  >
                    + Node
                  </button>
                )}
              </div>
              <div className="library-search-web-answer">
                <MarkdownPreview content={searchResults.web.answer} />
              </div>
              {searchResults.web.sources.length > 0 && (
                <div className="library-search-web-sources">
                  {searchResults.web.sources.slice(0, 5).map((src, i) => (
                    <a
                      key={i}
                      className="library-search-source-link"
                      href={src.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {src.title || src.uri}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>
    );
  }

  // Empty state
  if (!node) {
    return (
      <div className="library-chat">
        <div className="library-chat-empty">
          <div className="library-chat-empty-icon">📚</div>
          <div className="library-chat-empty-text">
            Select a node to view its conversation,
            or type below to start exploring.
          </div>
        </div>
      </div>
    );
  }

  // Session overview — when the root node is selected
  if (isRootNode && session) {
    return (
      <SessionOverview
        session={session}
        onSelectNode={onSelectNode}
        selectionMode={selectionMode}
        selectedNodeIds={selectedNodeIds}
        onToggleSelectNode={onToggleSelectNode}
        onEnterSelectionMode={onEnterSelectionMode}
        onExitSelectionMode={onExitSelectionMode}
        onSynthesize={onSynthesize}
        onCopyToMarkdown={onCopyToMarkdown}
        onVisualize={onVisualize}
      />
    );
  }

  // Normal conversation view
  const modeConfig = AGENT_MODE_CONFIG[node.agent_mode as AgentMode];
  const currentPhase = phases.length > 0 ? phases[phases.length - 1] : null;

  return (
    <div className="library-chat">
      {/* Node header */}
      <div className="library-chat-header">
        <span
          className="library-chat-mode-badge"
          style={{ background: modeConfig?.color || 'var(--accent)' }}
        >
          {modeConfig?.icon} {modeConfig?.label}
        </span>
        <span className="library-chat-node-label">{node.label}</span>
      </div>

      {/* Messages */}
      <div className="library-chat-messages" ref={messagesRef}>
        {(() => {
          let visibleIndex = 0;
          return node.conversation_history.map((msg, i) => {
            if (msg.role === 'system') return null;
            const idx = visibleIndex++;
            return (
              <ChatMessage
                key={i}
                message={msg}
                index={idx}
                isFocused={focusedMsgIndex === idx}
              />
            );
          });
        })()}

        {/* Streaming phase indicator */}
        {isStreaming && currentPhase && (
          <div className="library-chat-phase">
            <span className="library-chat-phase-icon">
              {PHASE_DISPLAY[currentPhase.phase]?.icon || '•'}
            </span>
            <span className="library-chat-phase-label">
              {PHASE_DISPLAY[currentPhase.phase]?.label || currentPhase.phase}
            </span>
            {currentPhase.tool_name && (
              <span className="library-chat-phase-tool">{currentPhase.tool_name}</span>
            )}
            {currentPhase.iteration > 1 && (
              <span className="library-chat-phase-iter">iter {currentPhase.iteration}</span>
            )}
          </div>
        )}

        {/* Typing indicator */}
        {isStreaming && !streamingText && (
          <div className="library-chat-typing">
            <span className="library-chat-typing-dot" />
            <span className="library-chat-typing-dot" />
            <span className="library-chat-typing-dot" />
          </div>
        )}

        {/* Continue button when max_iterations was reached */}
        {canContinue && !isStreaming && onContinue && (
          <div className="library-chat-continue">
            <button
              className="library-chat-continue-btn"
              onClick={onContinue}
            >
              Continue exploring...
            </button>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Message navigation */}
      {msgCount > 1 && (
        <div className="library-chat-nav">
          <button
            className="library-chat-nav-btn"
            onClick={handlePrevMessage}
            disabled={focusedMsgIndex === 0}
            title="Previous message"
          >
            ▲
          </button>
          <span className="library-chat-nav-pos">
            {focusedMsgIndex != null ? focusedMsgIndex + 1 : '–'}/{msgCount}
          </span>
          <button
            className="library-chat-nav-btn"
            onClick={handleNextMessage}
            disabled={focusedMsgIndex === msgCount - 1}
            title="Next message"
          >
            ▼
          </button>
        </div>
      )}
    </div>
  );
};

// Session overview — shows all nodes grouped by mode with selection support
const SessionOverview: React.FC<{
  session: ExplorationSession;
  onSelectNode?: (nodeId: string) => void;
  selectionMode: boolean;
  selectedNodeIds: Set<string>;
  onToggleSelectNode: (nodeId: string) => void;
  onEnterSelectionMode: (nodeId?: string) => void;
  onExitSelectionMode: () => void;
  onSynthesize?: (action: SynthesisAction, nodeIds: string[]) => void;
  onCopyToMarkdown?: (nodeIds: string[]) => void;
  onVisualize?: (nodeIds: string[]) => void;
}> = ({
  session,
  onSelectNode,
  selectionMode,
  selectedNodeIds,
  onToggleSelectNode,
  onEnterSelectionMode,
  onExitSelectionMode,
  onSynthesize,
  onCopyToMarkdown,
  onVisualize,
}) => {
  const [contextMenu, setContextMenu] = useState<{ visible: boolean; x: number; y: number; nodeId: string | null }>({
    visible: false, x: 0, y: 0, nodeId: null,
  });
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(prev => ({ ...prev, visible: false }));
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(prev => ({ ...prev, visible: false }));
        if (selectionMode) onExitSelectionMode();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu.visible, selectionMode, onExitSelectionMode]);

  const nodes = Object.values(session.nodes).filter(n => n.id !== session.root_id);

  // Group by agent mode
  const grouped: Record<string, ExplorationNode[]> = {};
  for (const node of nodes) {
    const mode = node.agent_mode || 'ideate';
    if (!grouped[mode]) grouped[mode] = [];
    grouped[mode].push(node);
  }

  const totalMessages = nodes.reduce(
    (sum, n) => sum + n.conversation_history.length, 0
  );

  const selectedCount = selectedNodeIds.size;
  const selectedArray = Array.from(selectedNodeIds);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (selectionMode) {
      onToggleSelectNode(nodeId);
    } else {
      onSelectNode?.(nodeId);
    }
  }, [selectionMode, onToggleSelectNode, onSelectNode]);

  const handleContextMenu = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, nodeId });
  }, []);

  return (
    <div className="library-chat">
      <div className="library-chat-header">
        <span className="library-chat-mode-badge" style={{ background: 'var(--text-muted)' }}>
          Session
        </span>
        <span className="library-chat-node-label">{session.title}</span>
      </div>
      <div className="library-chat-messages">
        {/* Summary stats */}
        <div className="library-overview-stats">
          <div className="library-overview-stat">
            <span className="library-overview-stat-value">{nodes.length}</span>
            <span className="library-overview-stat-label">nodes</span>
          </div>
          <div className="library-overview-stat">
            <span className="library-overview-stat-value">{totalMessages}</span>
            <span className="library-overview-stat-label">messages</span>
          </div>
          <div className="library-overview-stat">
            <span className="library-overview-stat-value">{Object.keys(grouped).length}</span>
            <span className="library-overview-stat-label">modes</span>
          </div>
        </div>

        {/* Selection action bar */}
        {selectionMode && (
          <div className="library-overview-action-bar">
            <span className="library-overview-action-count">
              {selectedCount} selected
            </span>
            <div className="library-overview-action-buttons">
              {selectedCount >= 1 && (
                <button
                  className="library-overview-action-btn"
                  onClick={() => onSynthesize?.('summarize', selectedArray)}
                >
                  Summarize
                </button>
              )}
              {selectedCount >= 2 && (
                <>
                  <button
                    className="library-overview-action-btn"
                    onClick={() => onSynthesize?.('compare', selectedArray)}
                  >
                    Compare
                  </button>
                  <button
                    className="library-overview-action-btn"
                    onClick={() => onSynthesize?.('combine', selectedArray)}
                  >
                    Combine
                  </button>
                </>
              )}
              {selectedCount >= 1 && (
                <button
                  className="library-overview-action-btn"
                  onClick={() => onVisualize?.(selectedArray)}
                >
                  Visualize
                </button>
              )}
              {selectedCount >= 1 && (
                <button
                  className="library-overview-action-btn"
                  onClick={() => onCopyToMarkdown?.(selectedArray)}
                >
                  Copy MD
                </button>
              )}
              <button
                className="library-overview-action-btn cancel"
                onClick={onExitSelectionMode}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Nodes grouped by mode */}
        {Object.entries(grouped).map(([mode, modeNodes]) => {
          const config = AGENT_MODE_CONFIG[mode as AgentMode];
          return (
            <div key={mode} className="library-overview-group">
              <div className="library-overview-group-header">
                <span
                  className="library-overview-group-dot"
                  style={{ background: config?.color || 'var(--text-muted)' }}
                />
                <span className="library-overview-group-label">
                  {config?.icon} {config?.label || mode}
                </span>
                <span className="library-overview-group-count">{modeNodes.length}</span>
              </div>
              {modeNodes.map(node => {
                const assistantCount = node.conversation_history.filter(m => m.role === 'assistant').length;
                const isSelected = selectedNodeIds.has(node.id);
                return (
                  <div
                    key={node.id}
                    className={`library-overview-node ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleNodeClick(node.id)}
                    onContextMenu={(e) => handleContextMenu(e, node.id)}
                  >
                    {selectionMode && (
                      <input
                        type="checkbox"
                        className="library-overview-node-checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelectNode(node.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                    <span className="library-overview-node-label">{node.label}</span>
                    <span className="library-overview-node-meta">
                      {assistantCount} {assistantCount === 1 ? 'reply' : 'replies'}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Empty state */}
        {nodes.length === 0 && (
          <div className="library-overview-empty">
            No nodes yet. Type below to start exploring.
          </div>
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
              onSelectNode?.(contextMenu.nodeId!);
              setContextMenu(prev => ({ ...prev, visible: false }));
            }}
          >
            Open
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onSynthesize?.('summarize', [contextMenu.nodeId!]);
              setContextMenu(prev => ({ ...prev, visible: false }));
            }}
          >
            Summarize
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onVisualize?.([contextMenu.nodeId!]);
              setContextMenu(prev => ({ ...prev, visible: false }));
            }}
          >
            Visualize
          </div>
          <div
            className="context-menu-item"
            onClick={() => {
              onCopyToMarkdown?.([contextMenu.nodeId!]);
              setContextMenu(prev => ({ ...prev, visible: false }));
            }}
          >
            Copy to Markdown
          </div>
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
        </div>
      )}
    </div>
  );
};

// Individual chat message
const ChatMessage: React.FC<{
  message: ConversationMessage;
  index: number;
  isFocused: boolean;
}> = ({ message, index, isFocused }) => {
  const isUser = message.role === 'user';

  return (
    <div
      className={`library-chat-msg ${isUser ? 'user' : 'assistant'} ${isFocused ? 'focused' : ''}`}
      data-msg-index={index}
    >
      {isUser ? (
        <div className="library-chat-msg-text">{message.content}</div>
      ) : (
        <div className="library-chat-msg-markdown">
          <MarkdownPreview content={message.content} />
        </div>
      )}
    </div>
  );
};

export default NodeChat;
