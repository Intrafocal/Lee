/**
 * Typed wrappers for Hester's Cockpit endpoints (contracts §6.3, §4.4, §4.6).
 * Every call names its workspace twice, as `?workspace=` and
 * `X-Lee-Workspace` (§9.3), so a window's Cockpit follows its own workspace
 * even while another window is focused. Accepts both the `{success, data}`
 * envelope and a bare body.
 */

import { getApiToken } from './hesterAuth';
import {
  encodeWorkspaceHeader,
  type AboutRef,
  type Quadrant,
  type StewardAnswer,
  type CockpitTask,
  type LaunchRequest,
  type LaunchResult,
  type TaskKind,
  type TaskLead,
  type TaskOrigin,
  type TaskStatus,
  type TaskWorktree,
} from '../../shared/cockpit';
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

/** A Hester context bundle (GET /cockpit/context/bundles): references only, never content. */
export interface ContextBundleRef {
  id: string;
  title: string;
  updated: string;
  stale: boolean;
  source_count: number;
  tags: string[];
  /** Absolute path of the bundle's content file. */
  path: string;
  relative_path: string;
}

export function fetchBundles(workspace: string): Promise<HesterResult<ContextBundleRef[]>> {
  return call<ContextBundleRef[]>(workspace, 'GET', '/cockpit/context/bundles');
}

export interface HistoryResponse {
  wins: DigestWin[];
  /** v4 §6: closed tasks carry `goal_impact` (the goals they served). */
  tasks: Array<CockpitTask & { goal_impact?: string[] | null }>;
  /** v4 §6: readings of a GOALS metric carry `goal_id` and `delta` (value − previous). */
  readings: Array<Reading & { goal_id?: string | null; delta?: number | null }>;
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

export const HESTER_DAEMON_URL = HESTER_DAEMON;

/**
 * Headers naming the workspace (percent-encoded `X-Lee-Workspace`) plus the
 * bearer token when there is one. Shared with raw fetches (Library SSE).
 */
export async function hesterHeaders(workspace: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'X-Lee-Workspace': encodeWorkspaceHeader(workspace), ...extra };
  try {
    const token = await getApiToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* no token: the request fails with 401 and shows offline */
  }
  return headers;
}

async function call<T>(workspace: string, method: string, path: string, body?: unknown): Promise<HesterResult<T>> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${HESTER_DAEMON}${path}${sep}workspace=${encodeURIComponent(workspace)}`;
  const headers = await hesterHeaders(workspace);
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

/**
 * `name` is your session name for the task (null clears it; addendum 2026-09-26b).
 * `important` / `urgent` set (bool) or clear (null) the quadrant overrides (v4 §4);
 * `lead` is a steward set_lead proposal (v4 §8.3).
 */
export function patchTask(
  workspace: string,
  id: string,
  body: Partial<Pick<CockpitTask, 'serves' | 'workstream' | 'title' | 'lead'>> & {
    name?: string | null;
    important?: boolean | null;
    urgent?: boolean | null;
  },
): Promise<HesterResult<CockpitTask>> {
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

export type SomedayTriage =
  | { action: 'explore'; to?: 'explore' }
  | { action: 'keep' }
  | { action: 'drop' }
  | { action: 'promote'; to?: 'task' };

export function triageSomeday(
  workspace: string,
  id: string,
  triage: SomedayTriage,
): Promise<HesterResult<SomedayItem | { item: SomedayItem; task: CockpitTask } | { item: SomedayItem; exploration: Exploration }>> {
  return call(workspace, 'POST', `/someday/${encodeURIComponent(id)}/triage`, { ...triage, workspace });
}

// ---------------------------------------------------------------------------
// Copilot v4: goals and steward (v4 contract §2, §5.2). Every steward call is
// a user action (C2); each returns a StewardAnswer (§9) and never acts.
// ---------------------------------------------------------------------------

export interface GoalTarget {
  direction: 'falling' | 'rising' | null;
  op: '>=' | '<=' | '>' | '<' | null;
  value: number | null;
  unit: '%' | null;
}

export interface GoalMetricStatus {
  name: string;
  kind: string | null;
  target_text: string | null;
  target: GoalTarget | null;
  value: number | null;
  previous: number | null;
  trend: 'down' | 'up' | 'flat' | null;
  ok: boolean | null;
  source: 'metrics' | 'reading' | 'judged' | null;
  at: string | null;
  available: string | null;
}

export interface GoalServing {
  tasks: Array<{ id: string; title: string; status: string; quadrant: Quadrant | null }>;
  workstreams: Array<{ id: string; title: string; phase: string }>;
  explorations: Array<{ id: string; title: string }>;
}

export interface GoalStatus {
  id: string;
  title: string;
  priority: number;
  prose: string;
  metrics: GoalMetricStatus[];
  serving: GoalServing;
  /** Nothing serving and at least one metric failing or trending the wrong way. */
  flagged: boolean;
  last_evaluated_at: string | null;
  focus_ms_7d: number;
}

export interface HumanBalance {
  share: number | null;
  ms: { Q1: number; Q2: number; Q3: number; Q4: number; play: number; unclassified: number };
  by_goal: Record<string, number>;
  line: string;
}

export interface GoalsStatusResponse {
  generated_at: string;
  days: number;
  goals: GoalStatus[];
  constraints: Array<{ id: string; title: string; violations: number | null }>;
  tensions: Array<{ a: string; b: string; label: string; default: string; arbiter: string }>;
  human_balance: HumanBalance;
}

/** Digest Q2 candidates (v4 §6), deterministic. */
export interface Q2Candidate {
  kind: 'goal-unserved' | 'exploration-quiet' | 'evaluation-due';
  goal_id?: string | null;
  ref: string;
  title: string;
  detail: string;
}

export interface StewardState {
  /** hester.steward in the workspace config. */
  enabled: boolean;
  not_today_until: string | null;
  active: boolean;
}

export type EvaluateAnswer = StewardAnswer & { stale_measure?: string | null };
/** `draft_id` and `diff` are null when Hester's reply held no GOALS.md draft. */
export type GoalDraftAnswer = StewardAnswer & { draft_id: string | null; diff: string | null };

export function fetchGoalsStatus(workspace: string, days = 7): Promise<HesterResult<GoalsStatusResponse>> {
  return call<GoalsStatusResponse>(workspace, 'GET', `/cockpit/goals/status?days=${days}`);
}

export function evaluateGoal(workspace: string, goalId: string): Promise<HesterResult<EvaluateAnswer>> {
  return call<EvaluateAnswer>(workspace, 'POST', `/cockpit/goals/${encodeURIComponent(goalId)}/evaluate`, {});
}

export function whatNext(workspace: string): Promise<HesterResult<StewardAnswer>> {
  return call<StewardAnswer>(workspace, 'POST', '/cockpit/what-next', {});
}

/** Hester's view of a task: goals it might serve, a better lead, starting branches. */
export function suggestTask(workspace: string, taskId: string): Promise<HesterResult<StewardAnswer>> {
  return call<StewardAnswer>(workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(taskId)}/suggest`, {});
}

/** Rail ask/steer. `record` is sent for lint and feed items (they live in Lee main). */
export function askSteward(workspace: string, question: string, about?: AboutRef | null): Promise<HesterResult<StewardAnswer>> {
  const body: { question: string; about?: { kind: string; id: string; record?: unknown } } = { question };
  if (about) body.about = { kind: about.kind, id: about.id, ...(about.record !== undefined ? { record: about.record } : {}) };
  return call<StewardAnswer>(workspace, 'POST', '/cockpit/ask', body);
}

export function draftGoals(workspace: string, instruction: string, goalId?: string | null): Promise<HesterResult<GoalDraftAnswer>> {
  return call<GoalDraftAnswer>(workspace, 'POST', '/cockpit/goals/draft', { instruction, ...(goalId ? { goal_id: goalId } : {}) });
}

/** Writes GOALS.md from the draft (409 when the file changed since). Never commits. */
export function applyGoalDraft(workspace: string, draftId: string): Promise<HesterResult<unknown>> {
  return call(workspace, 'POST', `/cockpit/goals/draft/${encodeURIComponent(draftId)}/apply`, {});
}

export function buildTowardGoal(
  workspace: string,
  goalId: string,
  title?: string,
): Promise<HesterResult<{ workstream_id: string; title: string; phase: string }>> {
  return call(workspace, 'POST', `/cockpit/goals/${encodeURIComponent(goalId)}/workstream`, title ? { title } : {});
}

export function fetchSteward(workspace: string): Promise<HesterResult<StewardState>> {
  return call<StewardState>(workspace, 'GET', '/cockpit/steward');
}

export function setStewardNotToday(workspace: string, notToday: boolean): Promise<HesterResult<StewardState>> {
  return call<StewardState>(workspace, 'POST', '/cockpit/steward', { not_today: notToday });
}

export function proposalOutcome(workspace: string, proposalId: string, outcome: 'accepted' | 'dismissed'): Promise<HesterResult<unknown>> {
  return call(workspace, 'POST', `/cockpit/proposals/${encodeURIComponent(proposalId)}/outcome`, { outcome });
}

// ---------------------------------------------------------------------------
// Explore (spec §7.5; v3 contract: Explore absorbs the Library). Files live
// in the workspace's .hester/explore/; a deep dive is the Hester chat session
// `explore-<id>`, seeded by /open and written back after every turn. An
// exploration is a node tree: the root (Seed + Log), thought/source branches,
// and deterministic decision, spike and evidence nodes.
// ---------------------------------------------------------------------------

export type ExplorationStatus = 'active' | 'archived';
export type ExplorationOriginKind = 'cockpit' | 'someday' | 'hester' | 'library' | 'task';

export type ExploreNodeKind = 'thought' | 'source_file' | 'source_web' | 'source_db' | 'decision' | 'spike' | 'evidence';
export type SpikeStatus = 'pending' | 'running' | 'review' | 'done' | 'discarded' | 'failed';

export interface ExploreMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ExploreDecision {
  text: string;
  chosen: string[];
  pruned: string[];
  reason: string | null;
}

export interface ExploreSpike {
  prompt: string;
  task_id: string | null;
  status: SpikeStatus;
  /** null: no timebox. */
  timebox_min: number | null;
  worktree: TaskWorktree | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface ExploreEvidence {
  task_id: string | null;
  /** The agent's words: always shown as its claim. */
  summary: string | null;
  lee_status: Record<string, unknown> | null;
  files: string[];
  diffstat: string | null;
  /** Workspace-relative: .hester/explore/evidence/<exp>-<node>.diff */
  diff_path: string | null;
  commits: string[];
  captured_at: string;
  claim: boolean;
}

export interface ExploreNode {
  id: string;
  parent: string | null;
  label: string;
  kind: ExploreNodeKind;
  mode?: string | null;
  collapsed?: boolean;
  pruned?: boolean;
  created_at: string;
  turns?: number;
  decision?: ExploreDecision;
  spike?: ExploreSpike;
  evidence?: ExploreEvidence;
  /** On GET /cockpit/explorations/{id}, for thought/source nodes. */
  conversation?: ExploreMessage[];
}

export interface ExplorationPromotion {
  to: 'task' | 'workstream' | 'goal';
  ref: string;
  at: string;
  node_ids?: string[] | null;
}

export interface Exploration {
  id: string;
  workspace: string;
  title: string;
  status: ExplorationStatus;
  seed: string | null;
  origin: { kind: ExplorationOriginKind; ref: string | null };
  session_id: string;
  turns: number;
  created_at: string;
  updated_at: string;
  last_touched_at: string | null;
  archived_at: string | null;
  version: number;
  /** Only on GET /cockpit/explorations/{id}: the file's markdown body (Seed + Log). */
  body?: string;
  /** Ordered; the root is first. Older daemons omit it. */
  nodes?: ExploreNode[];
  active_node?: string;
  serves?: string[];
  promoted?: ExplorationPromotion[];
  knowledge_path?: string | null;
}

export interface ExplorationCreate {
  title?: string;
  seed?: string;
  origin?: { kind: ExplorationOriginKind; ref?: string | null };
}

export function listExplorations(workspace: string, status: ExplorationStatus | 'all' = 'active'): Promise<HesterResult<Exploration[]>> {
  return call<Exploration[]>(workspace, 'GET', `/cockpit/explorations?status=${status}`);
}

export function createExploration(workspace: string, input: ExplorationCreate): Promise<HesterResult<Exploration>> {
  return call<Exploration>(workspace, 'POST', '/cockpit/explorations', { ...input, workspace });
}

export function getExploration(workspace: string, id: string): Promise<HesterResult<Exploration>> {
  return call<Exploration>(workspace, 'GET', `/cockpit/explorations/${encodeURIComponent(id)}`);
}

export function patchExploration(
  workspace: string,
  id: string,
  body: { title?: string; status?: ExplorationStatus; serves?: string[] },
): Promise<HesterResult<Exploration>> {
  return call<Exploration>(workspace, 'PATCH', `/cockpit/explorations/${encodeURIComponent(id)}`, { ...body, workspace });
}

export function openExploration(
  workspace: string,
  id: string,
): Promise<HesterResult<{ exploration: Exploration; session_id: string; seeded: boolean }>> {
  return call(workspace, 'POST', `/cockpit/explorations/${encodeURIComponent(id)}/open`, { workspace });
}

const expPath = (id: string, rest = '') => `/cockpit/explorations/${encodeURIComponent(id)}${rest}`;

export function addExploreNode(
  workspace: string,
  expId: string,
  body: { parent: string; label: string; kind?: ExploreNodeKind; mode?: string },
): Promise<HesterResult<ExploreNode>> {
  return call<ExploreNode>(workspace, 'POST', expPath(expId, '/nodes'), body);
}

/** `reason` applies to decision nodes only. */
export function patchExploreNode(
  workspace: string,
  expId: string,
  nodeId: string,
  body: { label?: string; collapsed?: boolean; reason?: string | null },
): Promise<HesterResult<ExploreNode>> {
  return call<ExploreNode>(workspace, 'PATCH', expPath(expId, `/nodes/${encodeURIComponent(nodeId)}`), body);
}

/** Prune a branch; a reason is optional (and can be added later on the decision). */
export function pruneExploreNode(
  workspace: string,
  expId: string,
  nodeId: string,
  reason?: string | null,
): Promise<HesterResult<{ node: ExploreNode; decision: ExploreNode }>> {
  return call(workspace, 'POST', expPath(expId, `/nodes/${encodeURIComponent(nodeId)}/prune`), reason ? { reason } : {});
}

export function decideExploration(
  workspace: string,
  expId: string,
  body: { text: string; parent?: string; chosen?: string[]; pruned?: string[]; reason?: string | null },
): Promise<HesterResult<ExploreNode>> {
  return call<ExploreNode>(workspace, 'POST', expPath(expId, '/decisions'), body);
}

export function addSpike(
  workspace: string,
  expId: string,
  body: { parent?: string; prompt: string; title?: string; timebox_min?: number },
): Promise<HesterResult<ExploreNode>> {
  return call<ExploreNode>(workspace, 'POST', expPath(expId, '/spikes'), body);
}

export function patchSpike(
  workspace: string,
  expId: string,
  nodeId: string,
  body: { task_id?: string; status?: SpikeStatus; worktree?: TaskWorktree | null },
): Promise<HesterResult<ExploreNode>> {
  return call<ExploreNode>(workspace, 'PATCH', expPath(expId, `/spikes/${encodeURIComponent(nodeId)}`), body);
}

export type ExplorationPromoteTo = 'task' | 'workstream' | 'goal';

export interface ExplorationPromoteResult {
  exploration: Exploration;
  task?: CockpitTask;
  workstream_id?: string;
  title?: string;
  phase?: string;
  /** Workspace-relative (or absolute) path of the goal draft. */
  draft_path?: string;
}

export function promoteExploration(
  workspace: string,
  expId: string,
  body: { to: ExplorationPromoteTo; node_ids?: string[]; title?: string },
): Promise<HesterResult<ExplorationPromoteResult>> {
  return call<ExplorationPromoteResult>(workspace, 'POST', expPath(expId, '/promote'), body);
}

export function archiveExploration(
  workspace: string,
  expId: string,
  asKnowledge = false,
): Promise<HesterResult<{ exploration: Exploration; knowledge_path?: string | null }>> {
  return call(workspace, 'POST', expPath(expId, '/archive'), asKnowledge ? { as_knowledge: true } : {});
}

/** Escalate a task to an exploration (the task stays open). */
export function escalateTask(workspace: string, taskId: string): Promise<HesterResult<{ task: CockpitTask; exploration: Exploration }>> {
  return call(workspace, 'POST', `/cockpit/tasks/${encodeURIComponent(taskId)}/escalate`, {});
}

/** Absolute path for a workspace-relative path Hester returns (absolute paths pass through). */
export function workspacePath(workspace: string, rel: string): string {
  if (rel.startsWith('/')) return rel;
  return `${workspace.replace(/\/+$/, '')}/${rel.replace(/^\.\//, '')}`;
}

/**
 * Start a spike (v3 §4): create the spike node, launch a delegate agent in a
 * worktree with origin explore `<exp>/<node>`, then mark the spike running
 * with its task id. A failed launch marks the spike `failed`.
 */
export async function startSpike(
  workspace: string,
  expId: string,
  opts: { parent?: string; prompt: string; title: string; timebox_min?: number },
  launch: (req: LaunchRequest) => Promise<LaunchResult>,
): Promise<HesterResult<{ node: ExploreNode; launch: LaunchResult }>> {
  const title = opts.title.trim().slice(0, 60) || 'Spike';
  const made = await addSpike(workspace, expId, {
    ...(opts.parent ? { parent: opts.parent } : {}),
    prompt: opts.prompt,
    title,
    ...(opts.timebox_min ? { timebox_min: opts.timebox_min } : {}),
  });
  if (!made.ok) return made;
  const node = made.data;
  let res: LaunchResult;
  try {
    res = await launch({
      workspace,
      lead: 'delegate',
      kind: 'prototype',
      // A spike is a claude worktree run, whatever the workspace's default provider.
      provider: 'claude',
      worktree: true,
      prompt: opts.prompt,
      title,
      name: `Spike: ${title}`.slice(0, 80),
      origin: { kind: 'explore', ref: `${expId}/${node.id}` },
    });
  } catch {
    res = { success: false, error: 'Launch failed' };
  }
  if (!res.success || !res.task_id) {
    await patchSpike(workspace, expId, node.id, { status: 'failed' });
    return { ok: false, error: res.error || 'Launch failed' };
  }
  // Forward only: this PATCH never carries a status other than 'running' (Hester
  // may already have synced the spike further; it refuses to regress one).
  const marked = await patchSpike(workspace, expId, node.id, { task_id: res.task_id, status: 'running' });
  return { ok: true, data: { node: marked.ok ? marked.data : node, launch: res } };
}
