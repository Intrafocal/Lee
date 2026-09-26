/**
 * Typed wrappers for Hester's Cockpit endpoints (contracts §6.3, §4.4, §4.6).
 * Every call names its workspace twice, as `?workspace=` and
 * `X-Lee-Workspace` (§9.3), so a window's Cockpit follows its own workspace
 * even while another window is focused. Accepts both the `{success, data}`
 * envelope and a bare body.
 */

import { getApiToken } from './hesterAuth';
import { encodeWorkspaceHeader, type CockpitTask, type TaskKind, type TaskLead, type TaskOrigin, type TaskStatus } from '../../shared/cockpit';
import type { HesterTaskEvent } from './cockpitModel';
import type { DigestWin } from './hesterCopilot';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

export type HesterResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export interface Reading {
  ts: string;
  metric: string;
  value: number;
  unit: string | null;
  source: { kind: 'operation'; op: string; run_id: string };
}

export interface CockpitSnapshot {
  workspace: string;
  workspace_id: string;
  version: number;
  tasks: {
    open: CockpitTask[];
    recent_closed: CockpitTask[];
    recent_events: HesterTaskEvent[];
  };
  workstreams: Array<{ id: string; title: string; phase: string; serves: string[]; task_ids: string[] }>;
  someday: { open: number; untriaged_over_7d: number };
  readings: { latest: Reading[] };
  generated_at: string;
}

export type SnapshotResponse = CockpitSnapshot | { unchanged: true; version: number };

export interface GoalRef {
  id: string;
  title: string;
  kind: 'goal' | 'constraint';
}

export interface WorkstreamRef {
  id: string;
  title: string;
  phase?: string;
}

export interface HistoryResponse {
  wins: DigestWin[];
  tasks: CockpitTask[];
  readings: Reading[];
}

export interface SomedayItem {
  id: string;
  created_at: string;
  text: string;
  status: string;
  as: 'someday' | 'explore' | string;
  source: { surface?: string; [k: string]: unknown };
  tags: string[];
  triage: { action: string; at?: string; note?: string | null } | null;
}

export interface TaskCreate {
  id?: string;
  workspace: string;
  title: string;
  title_source?: 'user' | 'agent' | 'auto';
  kind?: TaskKind;
  lead?: TaskLead;
  play?: boolean;
  status?: TaskStatus;
  agent?: { provider: string; pty_id: number | null; session_id: string | null; tab_label: string | null } | null;
  serves?: string[];
  workstream?: string | null;
  confirmed?: boolean;
  origin?: TaskOrigin;
  note?: string;
}

async function call<T>(workspace: string, method: string, path: string, body?: unknown): Promise<HesterResult<T>> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${HESTER_DAEMON}${path}${sep}workspace=${encodeURIComponent(workspace)}`;
  const headers: Record<string, string> = { 'X-Lee-Workspace': encodeWorkspaceHeader(workspace) };
  try {
    const token = await getApiToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* no token: the request fails with 401 and shows offline */
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const env = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in parsed ? (parsed as { success: boolean; data?: unknown; error?: string }) : null;
    if (!res.ok || (env && env.success !== true)) {
      const detail = env?.error || (parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : null);
      return { ok: false, error: detail || (res.status === 404 ? 'Not available in this Hester' : `Hester error (${res.status})`), status: res.status };
    }
    return { ok: true, data: (env ? env.data : parsed) as T };
  } catch {
    return { ok: false, error: 'Hester offline' };
  }
}

export function fetchCockpitSnapshot(workspace: string, sinceVersion?: number | null): Promise<HesterResult<SnapshotResponse>> {
  const q = sinceVersion != null ? `?since_version=${sinceVersion}` : '';
  return call<SnapshotResponse>(workspace, 'GET', `/cockpit/snapshot${q}`);
}

export function listTasks(workspace: string, status: 'open' | 'closed' | 'all' = 'open'): Promise<HesterResult<CockpitTask[]>> {
  return call<CockpitTask[]>(workspace, 'GET', `/cockpit/tasks?status=${status}&limit=100`);
}

export function createTask(workspace: string, input: TaskCreate): Promise<HesterResult<CockpitTask>> {
  return call<CockpitTask>(workspace, 'POST', '/cockpit/tasks', input);
}

export function confirmTask(
  workspace: string,
  id: string,
  body: { serves?: string[]; workstream?: string | null; title?: string } = {},
): Promise<HesterResult<CockpitTask>> {
  return call<CockpitTask>(workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(id)}/confirm`, body);
}

export function linkTask(
  workspace: string,
  id: string,
  body: { pty_id?: number; session_id?: string | null; provider?: string; tab_label?: string },
): Promise<HesterResult<CockpitTask>> {
  return call<CockpitTask>(workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(id)}/link`, body);
}

export function patchTask(workspace: string, id: string, body: Partial<Pick<CockpitTask, 'serves' | 'workstream' | 'title'>>): Promise<HesterResult<CockpitTask>> {
  return call<CockpitTask>(workspace, 'PATCH', `/cockpit/tasks/${encodeURIComponent(id)}`, body);
}

export function closeTask(
  workspace: string,
  id: string,
  body: { status: 'done' | 'discarded'; accepted?: boolean; note?: string },
): Promise<HesterResult<CockpitTask>> {
  return call<CockpitTask>(workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(id)}/close`, body);
}

export function promoteTask(workspace: string, id: string, title?: string): Promise<HesterResult<{ task: CockpitTask; workstream_id: string }>> {
  return call(workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(id)}/promote`, title ? { title } : {});
}

export function fetchGoals(workspace: string): Promise<HesterResult<GoalRef[]>> {
  return call<GoalRef[]>(workspace, 'GET', '/cockpit/goals');
}

export async function fetchWorkstreams(workspace: string): Promise<HesterResult<WorkstreamRef[]>> {
  const res = await call<unknown>(workspace, 'GET', '/workstream/');
  if (!res.ok) return res;
  const list = Array.isArray(res.data) ? res.data : [];
  return {
    ok: true,
    data: list
      .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
      .map((w) => ({ id: String(w.id), title: String(w.title ?? w.id), phase: typeof w.phase === 'string' ? w.phase : undefined })),
  };
}

export function fetchHistory(workspace: string, days = 7): Promise<HesterResult<HistoryResponse>> {
  return call<HistoryResponse>(workspace, 'GET', `/cockpit/history?days=${days}`);
}

export function listSomeday(workspace: string, status: 'open' | 'all'): Promise<HesterResult<SomedayItem[]>> {
  return call<SomedayItem[]>(workspace, 'GET', `/someday?status=${status}`);
}

export type SomedayTriage = { action: 'explore' } | { action: 'keep' } | { action: 'drop' } | { action: 'promote'; to?: 'task' };

export function triageSomeday(
  workspace: string,
  id: string,
  triage: SomedayTriage,
): Promise<HesterResult<SomedayItem | { item: SomedayItem; task: CockpitTask }>> {
  return call(workspace, 'POST', `/someday/${encodeURIComponent(id)}/triage`, { ...triage, workspace });
}
