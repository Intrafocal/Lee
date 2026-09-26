/**
 * Library Exploration Types
 *
 * Shared TypeScript types for the exploration workspace. Since Copilot v3
 * the Library is a tree view onto Explore's files (.hester/explore/<id>.md):
 * a session id is an exploration id and node ids are `root` or `n-…`
 * (contract §8). Decision, spike and evidence nodes are read-only here.
 */

import type { ExploreDecision, ExploreEvidence, ExploreSpike } from '../../lib/hesterCockpit';

export type AgentMode = 'ideate' | 'explore' | 'learn' | 'brainstorm' | 'docs' | 'web' | 'visualize';

export type NodeType = 'thought' | 'source_file' | 'source_web' | 'source_db' | 'decision' | 'spike' | 'evidence';

/** Nodes with no chat: their text lives in the exploration's frontmatter. */
export const READ_ONLY_NODE_TYPES: readonly NodeType[] = ['decision', 'spike', 'evidence'];

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface ExplorationNode {
  id: string;
  parent_id: string | null;
  label: string;
  node_type: NodeType;
  agent_mode: AgentMode;
  conversation_history: ConversationMessage[];
  children: string[];
  collapsed: boolean;
  created_at: string;
  /** Set by a prune; a pruned node stays in the file. */
  pruned?: boolean;
  /** Explore's node kind (same values as node_type). */
  kind?: NodeType;
  decision?: ExploreDecision;
  spike?: ExploreSpike;
  evidence?: ExploreEvidence;
}

export function nodeKind(node: ExplorationNode | null | undefined): NodeType | null {
  if (!node) return null;
  return node.kind ?? node.node_type ?? null;
}

export function isReadOnlyNode(node: ExplorationNode | null | undefined): boolean {
  const k = nodeKind(node);
  return !!k && READ_ONLY_NODE_TYPES.includes(k);
}

export interface ExplorationSession {
  session_id: string;
  title: string;
  nodes: Record<string, ExplorationNode>;
  root_id: string;
  active_node_id: string;
  created_at: string;
  last_activity: string;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  node_count: number;
  created_at: string;
  last_activity: string;
}

// SSE event types for node chat streaming
export interface PhaseEvent {
  phase: string;
  iteration: number;
  tool_name?: string;
  tool_context?: string;
  agent_id?: string;
}

export interface ChatResponseEvent {
  session_id: string;
  node_id: string;
  status: string;
  text?: string;
  iterations?: number;
  tools_used?: string[];
}

import type { IconName } from '../Icon';

// Agent mode display configuration
export const AGENT_MODE_CONFIG: Record<AgentMode, { label: string; icon: IconName; color: string }> = {
  ideate: { label: 'Ideate', icon: 'edit', color: '#e8b04a' },
  explore: { label: 'Explore', icon: 'search', color: '#4a9' },
  learn: { label: 'Learn', icon: 'book', color: '#6a8fd8' },
  brainstorm: { label: 'Brainstorm', icon: 'circle', color: '#e0882a' },
  docs: { label: 'Docs', icon: 'file-code', color: '#9a7db8' },
  web: { label: 'Web', icon: 'browser', color: '#c97db8' },
  visualize: { label: 'Visualize', icon: 'system', color: '#d4845a' },
};

// Search result types
export interface DocResult {
  file_path: string;
  similarity: number;
  chunk_text: string;
}

export interface WebResult {
  success: boolean;
  answer: string;
  sources: { title: string; uri: string }[];
}

export interface SearchResults {
  query: string;
  docs: DocResult[];
  web: WebResult | null;
  docError?: string;
  isSearching: boolean;
}

// Send intent — what the user wants to do with their next message
export type SendIntent = 'continue' | 'branch' | 'new';

// Synthesis actions for node operations
export type SynthesisAction = 'summarize' | 'compare' | 'combine';

// Node type display configuration
export const NODE_TYPE_CONFIG: Record<NodeType, { icon: IconName }> = {
  thought: { icon: 'edit' },
  source_file: { icon: 'file-code' },
  source_web: { icon: 'browser' },
  source_db: { icon: 'sql' },
  decision: { icon: 'check' },
  spike: { icon: 'play' },
  evidence: { icon: 'document' },
};
