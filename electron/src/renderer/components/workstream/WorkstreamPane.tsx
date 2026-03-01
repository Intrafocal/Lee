/**
 * WorkstreamPane - Main dashboard for a single workstream
 *
 * Composes PhaseBar, RunbookPanel, AgentPanel, and WarehouseBar.
 * Fetches workstream data on mount and polls for agent sessions.
 *
 * Layout:
 * ┌──────────────────────────────────────────────┐
 * │  PhaseBar (title, phase badge, actions)       │
 * ├──────────────────┬───────────────────────────┤
 * │  RunbookPanel     │  AgentPanel               │
 * │  (320px fixed)    │  (flex fill)              │
 * ├──────────────────┴───────────────────────────┤
 * │  WarehouseBar (bundles, file count)           │
 * └──────────────────────────────────────────────┘
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { PhaseBar } from './PhaseBar';
import { RunbookPanel } from './RunbookPanel';
import { AgentPanel } from './AgentPanel';
import { WarehouseBar } from './WarehouseBar';
import {
  WorkstreamResponse,
  WarehouseResponse,
  AgentSession,
  ResolvedTask,
  resolveTasks,
} from './types';

const HESTER_DAEMON = 'http://127.0.0.1:9000';
const AGENT_POLL_MS = 3000;

interface WorkstreamPaneProps {
  active: boolean;
  workspace: string;
  workstreamId: string;
}

export const WorkstreamPane: React.FC<WorkstreamPaneProps> = ({
  active,
  workspace,
  workstreamId,
}) => {
  const [workstream, setWorkstream] = useState<WorkstreamResponse | null>(null);
  const [warehouse, setWarehouse] = useState<WarehouseResponse | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [resolvedTasks, setResolvedTasks] = useState<ResolvedTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<number | null>(null);

  // Fetch workstream data
  const fetchWorkstream = useCallback(async () => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${workstreamId}`);
      if (!res.ok) { setError('Workstream not found'); return; }
      const data: WorkstreamResponse = await res.json();
      setWorkstream(data);
      setError(null);
      return data;
    } catch {
      setError('Daemon unavailable');
      return null;
    }
  }, [workstreamId]);

  // Fetch warehouse
  const fetchWarehouse = useCallback(async () => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${workstreamId}/warehouse`);
      if (res.ok) setWarehouse(await res.json());
    } catch {
      // silent
    }
  }, [workstreamId]);

  // Fetch agent sessions
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/orchestrate/sessions?workstream_id=${workstreamId}`);
      if (res.ok) {
        const data = await res.json();
        setAgentSessions(data.sessions || data || []);
      }
    } catch {
      // silent
    }
  }, [workstreamId]);

  // Resolve tasks when workstream or agents change
  useEffect(() => {
    if (!workstream) { setResolvedTasks([]); return; }
    const tasks = workstream.runbook?.tasks || (workstream as any).runbook_tasks || [];
    setResolvedTasks(
      resolveTasks(
        tasks,
        workstream.completed_task_ids || [],
        agentSessions,
      ),
    );
  }, [workstream, agentSessions]);

  // Initial fetch and polling
  useEffect(() => {
    if (!active) {
      // Stop polling when tab is inactive
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    // Fetch everything on activate
    fetchWorkstream();
    fetchWarehouse();
    fetchAgents();

    // Poll agents every 3s
    pollRef.current = window.setInterval(fetchAgents, AGENT_POLL_MS);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [active, workstreamId, fetchWorkstream, fetchWarehouse, fetchAgents]);

  // Re-fetch all after mutations
  const handleRefreshAll = useCallback(async () => {
    await Promise.all([fetchWorkstream(), fetchWarehouse(), fetchAgents()]);
  }, [fetchWorkstream, fetchWarehouse, fetchAgents]);

  const handleTasksChanged = useCallback(async () => {
    await Promise.all([fetchWorkstream(), fetchAgents()]);
  }, [fetchWorkstream, fetchAgents]);

  if (error && !workstream) {
    return (
      <div className={`workstream-pane ${active ? 'active' : ''}`}>
        <div className="ws-error">{error}</div>
      </div>
    );
  }

  if (!workstream) {
    return (
      <div className={`workstream-pane ${active ? 'active' : ''}`}>
        <div className="ws-loading">Loading workstream...</div>
      </div>
    );
  }

  return (
    <div className={`workstream-pane ${active ? 'active' : ''}`}>
      <PhaseBar
        wsId={workstreamId}
        title={workstream.title}
        phase={workstream.phase}
        tasks={resolvedTasks}
        onPhaseChanged={handleRefreshAll}
      />
      <div className="ws-body">
        <RunbookPanel
          wsId={workstreamId}
          phase={workstream.phase}
          tasks={resolvedTasks}
          onTasksChanged={handleTasksChanged}
        />
        <AgentPanel sessions={agentSessions} />
      </div>
      <WarehouseBar
        wsId={workstreamId}
        warehouse={warehouse}
        onWarehouseChanged={fetchWarehouse}
      />
    </div>
  );
};
