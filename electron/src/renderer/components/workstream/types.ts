/**
 * Workstream TypeScript types
 *
 * Mirrors the backend Pydantic models from hester/daemon/workstream/models.py
 */

// Phase lifecycle
export type WorkstreamPhase =
  | 'exploration'
  | 'design'
  | 'planning'
  | 'execution'
  | 'review'
  | 'done'
  | 'paused';

export interface PhaseConfig {
  label: string;
  color: string;
  icon: string;
  next?: WorkstreamPhase;
  nextLabel?: string;
}

export const PHASE_CONFIG: Record<WorkstreamPhase, PhaseConfig> = {
  exploration: { label: 'Exploration', color: '#7b68ee', icon: '🔍', next: 'design', nextLabel: 'Advance to Design' },
  design:      { label: 'Design',      color: '#4a9',    icon: '📐', next: 'planning', nextLabel: 'Advance to Planning' },
  planning:    { label: 'Planning',     color: '#e9a820', icon: '📋', next: 'execution', nextLabel: 'Advance to Execution' },
  execution:   { label: 'Execution',    color: '#20b2aa', icon: '⚡', next: 'review', nextLabel: 'Advance to Review' },
  review:      { label: 'Review',       color: '#da70d6', icon: '🔎', next: 'done', nextLabel: 'Mark Done' },
  done:        { label: 'Done',         color: '#666',    icon: '✅' },
  paused:      { label: 'Paused',       color: '#888',    icon: '⏸️' },
};

// Task status computed client-side
export type TaskStatus = 'completed' | 'ready' | 'blocked' | 'in_progress';

// Backend RunbookTask model
export interface RunbookTask {
  task_id: string;
  title: string;
  dependencies: string[];
  suggested_by: string;
  context_slice: string | null;
  priority: number;
}

// Extended with computed status
export interface ResolvedTask extends RunbookTask {
  status: TaskStatus;
}

// Backend WorkstreamBrief
export interface WorkstreamBrief {
  objective: string;
  rationale: string;
  constraints: string[];
  out_of_scope: string[];
  created_at: string;
  conversation_id: string | null;
}

// Backend Runbook
export interface Runbook {
  tasks: RunbookTask[];
  created_at: string;
  last_updated: string;
}

// Agent registration from backend
export interface AgentRegistration {
  agent_id: string;
  agent_type: string;
  registered_at: string;
  last_heartbeat: string;
  current_task_id: string | null;
  status: string;
  metadata: Record<string, any>;
}

// Full workstream response from GET /workstream/{ws_id}
export interface WorkstreamResponse {
  id: string;
  title: string;
  phase: WorkstreamPhase;
  brief: WorkstreamBrief | null;
  runbook: Runbook;
  warehouse_bundle_ids: string[];
  warehouse_files: string[];
  warehouse_notes: string;
  agents: AgentRegistration[];
  created_at: string;
  updated_at: string;
  completed_task_ids: string[];
  telemetry_enabled: boolean;
}

// Warehouse response from GET /workstream/{ws_id}/warehouse
export interface WarehouseResponse {
  bundle_ids: string[];
  files: string[];
  notes: string;
}

// Agent session from GET /orchestrate/sessions
export interface AgentSession {
  session_id: string;
  agent_type: string;
  status: string;
  current_tool: string | null;
  active_file: string | null;
  recent_tools: string[];
  last_update: string;
  workstream_id: string | null;
  task_id: string | null;
  metadata: Record<string, any>;
}

// Resolve task statuses from runbook + completed IDs + agent sessions
export function resolveTasks(
  tasks: RunbookTask[],
  completedIds: string[],
  agentSessions: AgentSession[],
): ResolvedTask[] {
  const inProgressIds = new Set(
    agentSessions
      .filter(s => s.status === 'active' && s.task_id)
      .map(s => s.task_id!),
  );
  const completedSet = new Set(completedIds);

  return tasks.map(task => {
    let status: TaskStatus;
    if (completedSet.has(task.task_id)) {
      status = 'completed';
    } else if (inProgressIds.has(task.task_id)) {
      status = 'in_progress';
    } else if (task.dependencies.every(dep => completedSet.has(dep))) {
      status = 'ready';
    } else {
      status = 'blocked';
    }
    return { ...task, status };
  });
}
