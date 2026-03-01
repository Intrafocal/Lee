/**
 * InputBar - Mode buttons, breadcrumb, and text input for exploration
 *
 * Five mode buttons (Ideate, Explore, Learn, Docs, Web) plus a text input.
 * After each conversation turn, shows quick action buttons:
 * Continue (default), Branch, New.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  AgentMode,
  ExplorationNode,
  ExplorationSession,
  AGENT_MODE_CONFIG,
  SendIntent,
} from './types';

interface InputBarProps {
  session: ExplorationSession | null;
  activeNode: ExplorationNode | null;
  mode: AgentMode;
  isStreaming: boolean;
  onModeChange: (mode: AgentMode) => void;
  onSend: (message: string, mode: AgentMode, intent: SendIntent) => void;
  disabled?: boolean;
}

export const InputBar: React.FC<InputBarProps> = ({
  session,
  activeNode,
  mode,
  isStreaming,
  onModeChange,
  onSend,
  disabled = false,
}) => {
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<SendIntent>('continue');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when mode or intent changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [mode, intent]);

  // Reset intent to 'continue' when active node changes
  useEffect(() => {
    setIntent('continue');
  }, [activeNode?.id]);

  // Build breadcrumb from active node
  const breadcrumb = useCallback(() => {
    if (!session || !activeNode) return [];
    const chain: ExplorationNode[] = [];
    let currentId: string | null = activeNode.id;
    while (currentId) {
      const node = session.nodes[currentId];
      if (!node) break;
      chain.unshift(node);
      currentId = node.parent_id;
    }
    return chain;
  }, [session, activeNode]);

  const crumbs = breadcrumb();

  const handleSend = useCallback(() => {
    if (!input.trim() || disabled) return;
    onSend(input.trim(), mode, intent);
    setInput('');
    setIntent('continue'); // Reset after send
  }, [input, mode, intent, disabled, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const modes: AgentMode[] = ['ideate', 'explore', 'learn', 'brainstorm', 'docs', 'web', 'visualize'];

  const placeholders: Record<AgentMode, string> = {
    ideate: 'Ideate: Type your thought...',
    explore: 'Explore: What to investigate...',
    learn: 'Learn: What to understand...',
    brainstorm: 'Scope an idea into a workstream...',
    docs: 'Search project docs...',
    web: 'Search the web...',
    visualize: 'Visualize: What to diagram...',
  };

  // Show quick actions when there's an active non-root node with conversation
  const isRootNode = session && activeNode && activeNode.id === session.root_id;
  const hasConversation = activeNode && activeNode.conversation_history.length > 0;
  const showQuickActions = !isStreaming && !isRootNode && hasConversation;

  return (
    <div className="library-input">
      {/* Breadcrumb */}
      <div className="library-input-breadcrumb">
        {crumbs.length === 0 && !session && (
          <span className="library-input-breadcrumb-empty">Start typing to begin an exploration</span>
        )}
        {crumbs.length === 0 && session && (
          <span className="library-input-breadcrumb-empty">Select a node in the tree</span>
        )}
        {crumbs.map((node, i) => (
          <React.Fragment key={node.id}>
            {i > 0 && <span className="library-input-breadcrumb-sep">&gt;</span>}
            <span
              className={`library-input-breadcrumb-item ${
                i === crumbs.length - 1 ? 'active' : ''
              }`}
            >
              {node.label.length > 30
                ? node.label.slice(0, 30) + '...'
                : node.label}
            </span>
          </React.Fragment>
        ))}

        {/* Quick action buttons — shown after conversation turns */}
        {showQuickActions && (
          <div className="library-input-quick-actions">
            <button
              className={`library-input-intent-btn ${intent === 'continue' ? 'active' : ''}`}
              onClick={() => setIntent('continue')}
              title="Continue in this node"
            >
              Continue
            </button>
            <button
              className={`library-input-intent-btn ${intent === 'branch' ? 'active' : ''}`}
              onClick={() => setIntent('branch')}
              title="Branch from this node"
            >
              Branch
            </button>
            <button
              className={`library-input-intent-btn ${intent === 'new' ? 'active' : ''}`}
              onClick={() => setIntent('new')}
              title="New thread from root"
            >
              New
            </button>
          </div>
        )}
      </div>

      {/* Mode buttons + input row */}
      <div className="library-input-row">
        <div className="library-input-modes">
          {modes.map((m) => {
            const config = AGENT_MODE_CONFIG[m];
            return (
              <button
                key={m}
                className={`library-input-mode-btn ${mode === m ? 'active' : ''}`}
                style={mode === m ? { borderColor: config.color, color: config.color } : {}}
                onClick={() => onModeChange(m)}
                title={config.label}
              >
                {config.icon} {config.label}
              </button>
            );
          })}
        </div>

        <input
          ref={inputRef}
          className="library-input-field"
          type="text"
          placeholder={placeholders[mode]}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
      </div>
    </div>
  );
};

export default InputBar;
