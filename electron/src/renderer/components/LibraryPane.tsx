/**
 * LibraryPane - Idea exploration workspace
 *
 * Composes ExplorationTree, NodeChat, and InputBar into a split-panel
 * layout. Manages session state and SSE streaming to the Hester daemon.
 *
 * Layout:
 * ┌─────────────────────┬──────────────────────────┐
 * │  ExplorationTree     │  NodeChat                │
 * │  (collapsible tree)  │  (live SSE chat)         │
 * ├─────────────────────┴──────────────────────────┤
 * │  InputBar (mode buttons + breadcrumb + input)   │
 * └────────────────────────────────────────────────┘
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ExplorationTree } from './library/ExplorationTree';
import { NodeChat } from './library/NodeChat';
import { InputBar } from './library/InputBar';
import {
  ExplorationSession,
  ExplorationNode,
  SessionSummary,
  AgentMode,
  AGENT_MODE_CONFIG,
  PhaseEvent,
  NodeType,
  SearchResults,
  SendIntent,
  SynthesisAction,
} from './library/types';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

interface LibraryPaneProps {
  active: boolean;
  workspace: string;
  onOpenFile?: (path: string) => void;
}

export const LibraryPane: React.FC<LibraryPaneProps> = ({
  active,
  workspace,
  onOpenFile,
}) => {
  // Session state
  const [session, setSession] = useState<ExplorationSession | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [mode, setMode] = useState<AgentMode>('ideate');

  // Streaming state
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [phases, setPhases] = useState<PhaseEvent[]>([]);
  const [canContinue, setCanContinue] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Search state (shown in NodeChat area)
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);

  // Load sessions list on mount
  useEffect(() => {
    if (active) {
      fetchSessions();
    }
  }, [active]);

  // Fetch session list
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/library/sessions`);
      if (!res.ok) return;
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      // Daemon not available
    }
  }, []);

  // Fetch full session tree
  const fetchSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/library/sessions/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      setSession({
        session_id: data.session_id,
        title: data.title,
        nodes: data.nodes,
        root_id: data.root_id,
        active_node_id: data.active_node_id,
        created_at: data.created_at,
        last_activity: data.last_activity,
      });
      setActiveNodeId(data.active_node_id || data.root_id);
    } catch {
      // Daemon not available
    }
  }, []);

  // Create new session
  const handleCreateSession = useCallback(async (title: string) => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/library/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, working_directory: workspace }),
      });
      if (!res.ok) return;
      const data = await res.json();
      await fetchSession(data.session_id);
      await fetchSessions();
    } catch {
      // Daemon not available
    }
  }, [workspace, fetchSession, fetchSessions]);

  // Switch session
  const handleSwitchSession = useCallback(async (sessionId: string) => {
    await fetchSession(sessionId);
  }, [fetchSession]);

  // Delete session
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await fetch(`${HESTER_DAEMON}/library/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      if (session?.session_id === sessionId) {
        setSession(null);
        setActiveNodeId(null);
      }
      await fetchSessions();
    } catch {
      // Ignore
    }
  }, [session, fetchSessions]);

  // Select a node (clears multi-select and exits selection mode)
  const handleSelectNode = useCallback((nodeId: string) => {
    setActiveNodeId(nodeId);
    setSelectedNodeIds(new Set());
    setSelectionMode(false);
    setPhases([]);
    setStreamingText(null);
    setCanContinue(false);
    setSearchResults(null);
  }, []);

  // Toggle a node in multi-select
  const handleToggleSelectNode = useCallback((nodeId: string) => {
    setSelectedNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // Enter selection mode, optionally pre-selecting a node
  const handleEnterSelectionMode = useCallback((nodeId?: string) => {
    setSelectionMode(true);
    if (nodeId) {
      setSelectedNodeIds(new Set([nodeId]));
    }
  }, []);

  // Exit selection mode
  const handleExitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedNodeIds(new Set());
  }, []);

  // Copy selected nodes to clipboard as markdown
  const handleCopyToMarkdown = useCallback((nodeIds: string[]) => {
    if (!session) return;
    const parts: string[] = [];
    for (const id of nodeIds) {
      const node = session.nodes[id];
      if (!node) continue;
      const modeConfig = AGENT_MODE_CONFIG[node.agent_mode as AgentMode];
      parts.push(`## ${modeConfig?.icon || ''} ${node.label}\n`);
      parts.push(`**Mode:** ${modeConfig?.label || node.agent_mode} | **Messages:** ${node.conversation_history.length}\n`);
      for (const msg of node.conversation_history) {
        if (msg.role === 'user') {
          parts.push(`> **User:** ${msg.content}\n`);
        } else if (msg.role === 'assistant') {
          parts.push(`${msg.content}\n`);
        }
      }
      parts.push('---\n');
    }
    const markdown = parts.join('\n');
    navigator.clipboard.writeText(markdown).catch(() => {});
    // Exit selection mode after copy
    setSelectionMode(false);
    setSelectedNodeIds(new Set());
  }, [session]);

  // Shared SSE stream consumer for chat and continue endpoints
  const streamNodeSSE = useCallback(async (
    url: string,
    body: Record<string, any>,
    nodeId: string,
  ) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }

    setIsStreaming(true);
    setPhases([]);
    setStreamingText(null);
    setCanContinue(false);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              switch (currentEvent) {
                case 'phase':
                  setPhases(prev => [...prev, data as PhaseEvent]);
                  break;
                case 'response':
                  if (data.text) {
                    setSession(prev => {
                      if (!prev) return prev;
                      const node = prev.nodes[nodeId];
                      if (!node) return prev;
                      return {
                        ...prev,
                        nodes: {
                          ...prev.nodes,
                          [nodeId]: {
                            ...node,
                            conversation_history: [
                              ...node.conversation_history,
                              { role: 'assistant', content: data.text, timestamp: new Date().toISOString() },
                            ],
                          },
                        },
                      };
                    });
                  }
                  setCanContinue(!!data.can_continue);
                  break;
                case 'error':
                  console.error('Node chat error:', data.error);
                  break;
                case 'done':
                  break;
              }
            } catch {
              // Parse error, skip
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('Node chat stream error:', err);
    } finally {
      setIsStreaming(false);
      setPhases([]);
      setStreamingText(null);
    }
  }, []);

  // Start SSE streaming chat on a node
  const startNodeChat = useCallback(async (
    sessionId: string,
    nodeId: string,
    message: string,
  ) => {
    await streamNodeSSE(
      `${HESTER_DAEMON}/library/sessions/${sessionId}/nodes/${nodeId}/chat`,
      { message },
      nodeId,
    );
  }, [streamNodeSSE]);

  // Continue after max_iterations — escalate depth
  const handleContinue = useCallback(async () => {
    if (!session || !activeNodeId) return;
    await streamNodeSSE(
      `${HESTER_DAEMON}/library/sessions/${session.session_id}/nodes/${activeNodeId}/continue`,
      {},
      activeNodeId,
    );
  }, [session, activeNodeId, streamNodeSSE]);

  // Search modes — run doc or web search, show results in NodeChat area
  const handleSearch = useCallback(async (query: string, searchMode: 'docs' | 'web') => {
    setSearchResults({ query, docs: [], web: null, isSearching: true });

    try {
      if (searchMode === 'docs') {
        const docRes = await fetch(
          `${HESTER_DAEMON}/docs/search?q=${encodeURIComponent(query)}&limit=5`
        )
          .then(r => r.json())
          .catch(() => ({ results: [], error: 'Doc search unavailable' }));

        setSearchResults({
          query,
          docs: docRes.results || [],
          web: null,
          docError: docRes.error || undefined,
          isSearching: false,
        });
      } else {
        const webRes = await fetch(`${HESTER_DAEMON}/research/web`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, max_sources: 5 }),
        })
          .then(r => r.json())
          .catch(() => ({ success: false, answer: 'Web search unavailable', sources: [] }));

        setSearchResults({
          query,
          docs: [],
          web: webRes?.success ? webRes : null,
          isSearching: false,
        });
      }
    } catch {
      setSearchResults(prev => prev ? { ...prev, isSearching: false } : null);
    }
  }, []);

  // Ensure a session exists — auto-creates one if needed, returns { sessionId, parentNodeId }
  const ensureSession = useCallback(async (seedTitle: string): Promise<{ sessionId: string; parentNodeId: string } | null> => {
    if (session && activeNodeId) {
      return { sessionId: session.session_id, parentNodeId: activeNodeId };
    }

    // Auto-create session with timestamp name
    try {
      const now = new Date();
      const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const title = `Session (${time})`;
      const res = await fetch(`${HESTER_DAEMON}/library/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, working_directory: workspace }),
      });
      if (!res.ok) return null;
      const data = await res.json();

      // Fetch the full session to get root node
      const sessionRes = await fetch(`${HESTER_DAEMON}/library/sessions/${data.session_id}`);
      if (!sessionRes.ok) return null;
      const sessionData = await sessionRes.json();

      const newSession: ExplorationSession = {
        session_id: sessionData.session_id,
        title: sessionData.title,
        nodes: sessionData.nodes,
        root_id: sessionData.root_id,
        active_node_id: sessionData.active_node_id,
        created_at: sessionData.created_at,
        last_activity: sessionData.last_activity,
      };
      setSession(newSession);
      setActiveNodeId(newSession.root_id);
      fetchSessions();

      return { sessionId: newSession.session_id, parentNodeId: newSession.root_id };
    } catch {
      return null;
    }
  }, [session, activeNodeId, workspace, fetchSessions]);

  // Create a new child node under parentId, select it, and start chat
  const createNodeAndChat = useCallback(async (
    sessionId: string,
    parentId: string,
    message: string,
    agentMode: AgentMode,
  ) => {
    const res = await fetch(
      `${HESTER_DAEMON}/library/sessions/${sessionId}/nodes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_id: parentId,
          label: message,
          node_type: 'thought',
          agent_mode: agentMode,
        }),
      }
    );
    if (!res.ok) return;
    const nodeData = await res.json();
    const newNodeId = nodeData.node_id;

    const nodeWithMessage = {
      ...nodeData.node,
      conversation_history: [
        { role: 'user', content: message, timestamp: new Date().toISOString() },
      ],
    };
    setSession(prev => {
      if (!prev) return prev;
      const updated = { ...prev };
      updated.nodes = { ...updated.nodes };
      updated.nodes[newNodeId] = nodeWithMessage;
      const parent = { ...updated.nodes[parentId] };
      parent.children = [...parent.children, newNodeId];
      updated.nodes[parentId] = parent;
      return updated;
    });
    setActiveNodeId(newNodeId);

    await startNodeChat(sessionId, newNodeId, message);
  }, [startNodeChat]);

  // Send a message with intent: continue (same node), branch (new child), new (child of root)
  const handleSend = useCallback(async (message: string, agentMode: AgentMode, intent: SendIntent = 'continue') => {
    // Search modes: show results in NodeChat area
    if (agentMode === 'docs' || agentMode === 'web') {
      handleSearch(message, agentMode);
      return;
    }

    // Ensure we have a session
    const ctx = await ensureSession(message);
    if (!ctx) return;

    setSearchResults(null);

    const activeNode = session ? session.nodes[ctx.parentNodeId] : null;
    const isRootNode = session && ctx.parentNodeId === session.root_id;

    // Decide whether to continue in the current node or create a new one
    const shouldCreateNode =
      intent === 'branch' ||
      intent === 'new' ||
      isRootNode ||  // Always create a child when on the root node
      !activeNode ||
      activeNode.conversation_history.length === 0 || // Empty node — first message creates child
      agentMode !== activeNode.agent_mode; // Mode changed — new node

    if (shouldCreateNode) {
      try {
        // Determine parent for the new node:
        // - 'new': child of root (new top-level thread)
        // - 'branch': child of current node (subtopic)
        // - mode change: sibling of current node (same parent)
        // - root node / empty node: child of current node
        let parentId: string;
        if (intent === 'new' && session) {
          parentId = session.root_id;
        } else if (intent === 'branch' || isRootNode || !activeNode || activeNode.conversation_history.length === 0) {
          parentId = ctx.parentNodeId;
        } else {
          // Mode change → sibling (use current node's parent)
          parentId = activeNode.parent_id || ctx.parentNodeId;
        }
        await createNodeAndChat(ctx.sessionId, parentId, message, agentMode);
      } catch (e) {
        console.error('Failed to create node:', e);
      }
    } else {
      // Continue in the same node — add user message optimistically and chat
      setSession(prev => {
        if (!prev) return prev;
        const node = prev.nodes[ctx.parentNodeId];
        if (!node) return prev;
        return {
          ...prev,
          nodes: {
            ...prev.nodes,
            [ctx.parentNodeId]: {
              ...node,
              conversation_history: [
                ...node.conversation_history,
                { role: 'user', content: message, timestamp: new Date().toISOString() },
              ],
            },
          },
        };
      });

      await startNodeChat(ctx.sessionId, ctx.parentNodeId, message);
    }
  }, [ensureSession, handleSearch, startNodeChat, createNodeAndChat, session]);

  // Promote a search result to a source node
  const handlePromoteSource = useCallback(async (
    label: string,
    nodeType: NodeType,
    content: string,
  ) => {
    if (!session || !activeNodeId) return;

    try {
      const res = await fetch(
        `${HESTER_DAEMON}/library/sessions/${session.session_id}/nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_id: activeNodeId,
            label,
            node_type: nodeType,
            agent_mode: 'search',
          }),
        }
      );
      if (!res.ok) return;
      const nodeData = await res.json();

      // Add the content as a system message on the new node
      await fetch(
        `${HESTER_DAEMON}/library/sessions/${session.session_id}/nodes/${nodeData.node_id}/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Source content: ${content.slice(0, 500)}` }),
        }
      );

      // Refresh session
      await fetchSession(session.session_id);
    } catch {
      // Ignore
    }
  }, [session, activeNodeId, fetchSession]);

  // Promote node to workstream
  const handlePromoteToWorkstream = useCallback(async (nodeId: string) => {
    if (!session) return;
    try {
      const res = await fetch(
        `${HESTER_DAEMON}/library/sessions/${session.session_id}/promote-to-workstream`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_ids: [nodeId] }),
        }
      );
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = await res.json();
      // Open workstream tab via Lee API
      if (window.lee?.sendCommand) {
        window.lee.sendCommand({
          domain: 'system',
          action: 'create_tab',
          params: { type: 'workstream', id: data.workstream_id, title: data.title },
        });
      }
    } catch (err) {
      console.error('Failed to promote to workstream:', err);
    }
  }, [session]);

  // Save session as idea
  const handleSaveAsIdea = useCallback(async (nodeId: string) => {
    if (!session) return;
    try {
      const res = await fetch(
        `${HESTER_DAEMON}/library/sessions/${session.session_id}/save`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: nodeId, tags: ['exploration', 'library'] }),
        }
      );
      const data = await res.json();
      if (data.success) {
        // Could show a toast/notification here
        console.log('Saved as idea:', data.idea_id);
      }
    } catch {
      // Ignore
    }
  }, [session]);

  // Rename a node
  const handleRenameNode = useCallback(async (nodeId: string, newLabel: string) => {
    if (!session) return;
    try {
      const res = await fetch(
        `${HESTER_DAEMON}/library/sessions/${session.session_id}/nodes/${nodeId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel }),
        }
      );
      if (!res.ok) return;

      // Update local state optimistically
      setSession(prev => {
        if (!prev) return prev;
        const node = prev.nodes[nodeId];
        if (!node) return prev;
        const updated = {
          ...prev,
          nodes: { ...prev.nodes, [nodeId]: { ...node, label: newLabel } },
        };
        // Update session title if renaming root
        if (nodeId === prev.root_id) {
          updated.title = newLabel;
        }
        return updated;
      });
    } catch {
      // Ignore
    }
  }, [session]);

  // Synthesize nodes — summarize, compare, or combine
  const handleSynthesize = useCallback(async (action: SynthesisAction, nodeIds: string[]) => {
    if (!session) return;

    setSelectionMode(false);
    setSelectedNodeIds(new Set());
    setSearchResults(null);

    // Stream the synthesis SSE endpoint
    const url = `${HESTER_DAEMON}/library/sessions/${session.session_id}/synthesize`;
    const body = { action, node_ids: nodeIds, parent_id: session.root_id };

    if (abortRef.current) {
      abortRef.current.abort();
    }
    setIsStreaming(true);
    setPhases([]);
    setStreamingText(null);
    setCanContinue(false);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              switch (currentEvent) {
                case 'node_created': {
                  // Add the new synthesis node to the tree optimistically
                  const newNodeId = data.node_id;
                  setSession(prev => {
                    if (!prev) return prev;
                    const parentNode = prev.nodes[data.parent_id];
                    if (!parentNode) return prev;
                    return {
                      ...prev,
                      nodes: {
                        ...prev.nodes,
                        [newNodeId]: {
                          id: newNodeId,
                          parent_id: data.parent_id,
                          label: data.label,
                          node_type: 'thought' as const,
                          agent_mode: 'ideate' as const,
                          conversation_history: [],
                          children: [],
                          collapsed: false,
                          created_at: new Date().toISOString(),
                        },
                        [data.parent_id]: {
                          ...parentNode,
                          children: [...parentNode.children, newNodeId],
                        },
                      },
                    };
                  });
                  setActiveNodeId(newNodeId);
                  setSelectedNodeIds(new Set());
                  break;
                }
                case 'phase':
                  setPhases(prev => [...prev, data as PhaseEvent]);
                  break;
                case 'response': {
                  if (data.text && data.node_id) {
                    setSession(prev => {
                      if (!prev) return prev;
                      const node = prev.nodes[data.node_id];
                      if (!node) return prev;
                      return {
                        ...prev,
                        nodes: {
                          ...prev.nodes,
                          [data.node_id]: {
                            ...node,
                            conversation_history: [
                              ...node.conversation_history,
                              { role: 'assistant', content: data.text, timestamp: new Date().toISOString() },
                            ],
                          },
                        },
                      };
                    });
                  }
                  break;
                }
                case 'error':
                  console.error('Synthesis error:', data.error);
                  break;
                case 'done':
                  break;
              }
            } catch {
              // Parse error
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('Synthesis stream error:', err);
    } finally {
      setIsStreaming(false);
      setPhases([]);
      setStreamingText(null);
    }
  }, [session]);

  // Visualize nodes — create diagrams/images/markdown from selected nodes
  const handleVisualize = useCallback(async (nodeIds: string[]) => {
    if (!session) return;

    setSelectionMode(false);
    setSelectedNodeIds(new Set());
    setSearchResults(null);

    const url = `${HESTER_DAEMON}/library/sessions/${session.session_id}/visualize`;
    const body = { node_ids: nodeIds, parent_id: session.root_id };

    if (abortRef.current) {
      abortRef.current.abort();
    }
    setIsStreaming(true);
    setPhases([]);
    setStreamingText(null);
    setCanContinue(false);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            try {
              const data = JSON.parse(currentData);
              switch (currentEvent) {
                case 'node_created': {
                  const newNodeId = data.node_id;
                  setSession(prev => {
                    if (!prev) return prev;
                    const parentNode = prev.nodes[data.parent_id];
                    if (!parentNode) return prev;
                    return {
                      ...prev,
                      nodes: {
                        ...prev.nodes,
                        [newNodeId]: {
                          id: newNodeId,
                          parent_id: data.parent_id,
                          label: data.label,
                          node_type: 'thought' as const,
                          agent_mode: 'visualize' as const,
                          conversation_history: [],
                          children: [],
                          collapsed: false,
                          created_at: new Date().toISOString(),
                        },
                        [data.parent_id]: {
                          ...parentNode,
                          children: [...parentNode.children, newNodeId],
                        },
                      },
                    };
                  });
                  setActiveNodeId(newNodeId);
                  break;
                }
                case 'phase':
                  setPhases(prev => [...prev, data as PhaseEvent]);
                  break;
                case 'response': {
                  if (data.text && data.node_id) {
                    setSession(prev => {
                      if (!prev) return prev;
                      const node = prev.nodes[data.node_id];
                      if (!node) return prev;
                      return {
                        ...prev,
                        nodes: {
                          ...prev.nodes,
                          [data.node_id]: {
                            ...node,
                            conversation_history: [
                              ...node.conversation_history,
                              { role: 'assistant', content: data.text, timestamp: new Date().toISOString() },
                            ],
                          },
                        },
                      };
                    });
                  }
                  break;
                }
                case 'error':
                  console.error('Visualize error:', data.error);
                  break;
                case 'done':
                  break;
              }
            } catch {
              // Parse error
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('Visualize stream error:', err);
    } finally {
      setIsStreaming(false);
      setPhases([]);
      setStreamingText(null);
    }
  }, [session]);

  // Get the active node object
  const activeNode = session && activeNodeId ? session.nodes[activeNodeId] || null : null;

  return (
    <div className={`library-pane ${active ? 'active' : ''}`}>
      {/* Top: Tree + Chat side by side */}
      <div className="library-top">
        <div className="library-top-left">
          <ExplorationTree
            session={session}
            sessions={sessions}
            activeNodeId={activeNodeId}
            selectionMode={selectionMode}
            selectedNodeIds={selectedNodeIds}
            onSelectNode={handleSelectNode}
            onToggleSelectNode={handleToggleSelectNode}
            onEnterSelectionMode={handleEnterSelectionMode}
            onExitSelectionMode={handleExitSelectionMode}
            onCreateSession={handleCreateSession}
            onSwitchSession={handleSwitchSession}
            onDeleteSession={handleDeleteSession}
            onSaveAsIdea={handleSaveAsIdea}
            onPromoteToWorkstream={handlePromoteToWorkstream}
            onRenameNode={handleRenameNode}
            onSynthesize={handleSynthesize}
            onCopyToMarkdown={handleCopyToMarkdown}
            onVisualize={handleVisualize}
          />
        </div>
        <div className="library-top-right">
          <NodeChat
            session={session}
            sessionId={session?.session_id || null}
            node={activeNode}
            isRootNode={!!(session && activeNodeId && activeNodeId === session.root_id)}
            isStreaming={isStreaming}
            streamingText={streamingText}
            phases={phases}
            canContinue={canContinue}
            onContinue={handleContinue}
            onSelectNode={handleSelectNode}
            searchResults={searchResults}
            onPromoteSource={handlePromoteSource}
            selectionMode={selectionMode}
            selectedNodeIds={selectedNodeIds}
            onToggleSelectNode={handleToggleSelectNode}
            onEnterSelectionMode={handleEnterSelectionMode}
            onExitSelectionMode={handleExitSelectionMode}
            onSynthesize={handleSynthesize}
            onCopyToMarkdown={handleCopyToMarkdown}
            onVisualize={handleVisualize}
          />
        </div>
      </div>

      {/* Bottom: Input Bar */}
      <div className="library-bottom">
        <InputBar
          session={session}
          activeNode={activeNode}
          mode={mode}
          isStreaming={isStreaming}
          onModeChange={setMode}
          onSend={handleSend}
          disabled={isStreaming}
        />
      </div>
    </div>
  );
};
