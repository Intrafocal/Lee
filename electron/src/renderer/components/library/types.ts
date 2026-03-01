/**
 * Library Exploration Types
 *
 * Shared TypeScript types for the exploration workspace,
 * mirroring the backend ExplorationNode/ExplorationSession models.
 */

export type AgentMode = 'ideate' | 'explore' | 'learn' | 'brainstorm' | 'docs' | 'web' | 'visualize';

export type NodeType = 'thought' | 'source_file' | 'source_web' | 'source_db';

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

// Agent mode display configuration
export const AGENT_MODE_CONFIG: Record<AgentMode, { label: string; icon: string; color: string }> = {
  ideate: { label: 'Ideate', icon: '💡', color: '#e8b04a' },
  explore: { label: 'Explore', icon: '🔭', color: '#4a9' },
  learn: { label: 'Learn', icon: '📚', color: '#6a8fd8' },
  brainstorm: { label: 'Brainstorm', icon: '◎', color: '#e0882a' },
  docs: { label: 'Docs', icon: '📄', color: '#9a7db8' },
  web: { label: 'Web', icon: '🌐', color: '#c97db8' },
  visualize: { label: 'Visualize', icon: '📊', color: '#d4845a' },
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
export const NODE_TYPE_CONFIG: Record<NodeType, { icon: string }> = {
  thought: { icon: '💡' },
  source_file: { icon: '📄' },
  source_web: { icon: '🌐' },
  source_db: { icon: '🗄️' },
};
