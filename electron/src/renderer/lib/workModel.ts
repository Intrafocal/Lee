/**
 * workModel - the pure logic behind Work and Library (cockpit-design §4, §5;
 * package R2): the waiting order, In flight's order and its "earlier" fold,
 * the swipe accumulator, the quick replies each place shows, stepping
 * through items in the detail view, and Library's word estimate and "quiet".
 *
 * Pure (type-only imports apart from shared/cockpit and cockpitModel's pure
 * helpers), so scripts/cockpit-work-smoke.mjs compiles and runs it without
 * React or a DOM.
 */

import type { AgentSummary, AttentionItem, AttentionSnapshot } from '../../shared/copilot';
import type { CockpitTask, OperationInfo, TabRuntimeInfo } from '../../shared/cockpit';
import { QUICK_REPLIES, describeActivity, type AgentActivity, type AgentUpdate } from '../../shared/cockpit';
import { formatDuration, plainLine, taskTitle, type TileModel } from './cockpitModel';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

function sameWorkspace(a: string | null | undefined, ws: string): boolean {
  return !!a && a.replace(/\/+$/, '') === ws.replace(/\/+$/, '');
}

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return 'Agent';
  if (provider === 'claude') return 'Claude';
  if (provider === 'pi') return 'Pi';
  if (provider === 'hester') return 'Hester';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function workspaceName(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/** "2m", "1h 5m": an age without "ago", for meta lines. */
export function shortAge(iso: string | null | undefined, now: number): string {
  const t = at(iso);
  return Number.isNaN(t) ? '' : formatDuration(now - t);
}

// ---------------------------------------------------------------------------
// Waiting on you (§4.1)
// ---------------------------------------------------------------------------

export type WaitingKind = 'approval' | 'question' | 'text';

export interface WaitingItem {
  /** The list id (`work:item:<item id>`). */
  id: string;
  item: AttentionItem;
  kind: WaitingKind;
  /** The agent's current name (runtime / tile), else the item's tab label. */
  name: string;
  provider: string | null;
  workspace: string | null;
  ptyId: number | null;
  /** When it started waiting on you. */
  since: string;
}

export interface WaitingInput {
  items: readonly AttentionItem[] | null | undefined;
  workspace: string;
  /** Tiles by pty, for the agent's current name. */
  tiles?: readonly Pick<TileModel, 'ptyId' | 'title'>[] | null;
  /** Items hidden here for now (a swipe waiting out its Undo). */
  hidden?: ReadonlySet<string> | null;
}

const SEVERITY_RANK: Record<string, number> = { blocking: 0, 'needs-you': 1 };

export function waitingKind(item: Pick<AttentionItem, 'kind'>): WaitingKind {
  if (item.kind === 'approval') return 'approval';
  if (item.kind === 'question') return 'question';
  return 'text';
}

/**
 * The open items that need you in this workspace, in the queue's order:
 * blocking, then needs-you, oldest first. Ambient items (reviews, summaries)
 * are In flight's, not here.
 */
export function waitingItems(input: WaitingInput): WaitingItem[] {
  const names = new Map<number, string>();
  for (const t of input.tiles ?? []) names.set(t.ptyId, t.title);
  const out: Array<WaitingItem & { rank: number; t: number }> = [];
  for (const item of input.items ?? []) {
    if (item.state !== 'open' || item.severity === 'ambient') continue;
    if (item.source.workspace && !sameWorkspace(item.source.workspace, input.workspace)) continue;
    if (input.hidden?.has(item.id)) continue;
    const pty = item.source.pty_id;
    const since = item.created_at || item.updated_at;
    out.push({
      id: `work:item:${item.id}`,
      item,
      kind: waitingKind(item),
      name: (pty != null ? names.get(pty) : undefined) || item.source.tab_label || providerLabel(item.source.provider),
      provider: item.source.provider,
      workspace: item.source.workspace,
      ptyId: pty,
      since,
      rank: SEVERITY_RANK[item.severity] ?? 2,
      t: at(since),
    });
  }
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w.rank - b.w.rank || (a.w.t || 0) - (b.w.t || 0) || a.i - b.i)
    .map(({ w }) => {
      const { rank: _r, t: _t, ...rest } = w;
      return rest;
    });
}

/** An item that takes a text reply (quick replies, the reply box); approvals never do here. */
export function canTextReply(item: Pick<AttentionItem, 'kind' | 'actions'>): boolean {
  return item.kind !== 'approval' && item.actions.includes('reply');
}

/** The quick replies (§4.4): the list card shows the first three, the detail view all four. */
export function quickReplies(where: 'list' | 'detail'): string[] {
  return where === 'list' ? QUICK_REPLIES.slice(0, 3) : [...QUICK_REPLIES];
}

/** The approval's body line: the tool's plain description, else "Wants to run a command". */
export function approvalLine(item: Pick<AttentionItem, 'tool'>): string {
  const name = item.tool?.name ?? '';
  if (!name || name === 'Bash') return 'Wants to run a command';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'Wants to change a file';
  if (name === 'WebFetch' || name === 'WebSearch') return 'Wants to read the web';
  return `Wants to use ${name}`;
}

// ---------------------------------------------------------------------------
// In flight (§4.1)
// ---------------------------------------------------------------------------

/** Idle agents that finished longer ago than this fold into "n earlier today". */
export const EARLIER_AFTER_MS = 2 * 3600000;

export type FlightGroup = 'failed' | 'busy' | 'waiting' | 'running' | 'review' | 'idle';
export type FlightDot = 'needs' | 'working' | 'done' | 'idle';

export interface FlightRow {
  /** The list id: `work:agent:<pty>`, `work:task:<id>` or `work:op:<name>`. */
  id: string;
  kind: 'agent' | 'task' | 'op';
  group: FlightGroup;
  dot: FlightDot;
  title: string;
  sub: string;
  meta: string;
  ptyId: number | null;
  taskId: string | null;
  opName: string | null;
  /** Sort key within the group (ms epoch). */
  t: number;
}

export interface AgentTimes {
  busySince: string | null;
  idleSince: string | null;
}

/** Busy/idle start per pty: the queue's agent summary, else the tab runtime's state change. */
export function agentTimes(
  snapshot: Pick<AttentionSnapshot, 'agents'> | null | undefined,
  runtime: readonly TabRuntimeInfo[] | null | undefined,
): Map<number, AgentTimes> {
  const out = new Map<number, AgentTimes>();
  for (const r of runtime ?? []) {
    const s = r.state?.state;
    out.set(r.pty_id, {
      busySince: s === 'busy' ? r.state.since ?? null : null,
      idleSince: s === 'idle-at-prompt' ? r.state.since ?? null : null,
    });
  }
  for (const a of snapshot?.agents ?? []) {
    const prev = out.get(a.pty_id);
    out.set(a.pty_id, {
      busySince: a.busy_since ?? prev?.busySince ?? null,
      idleSince: a.idle_since ?? prev?.idleSince ?? null,
    });
  }
  return out;
}

export interface FlightInput {
  tiles: readonly TileModel[];
  agents?: readonly AgentSummary[] | null;
  times?: ReadonlyMap<number, AgentTimes> | null;
  /** Open tasks (Hester's), for tasks with no live agent. */
  tasks?: readonly CockpitTask[] | null;
  ops?: readonly OperationInfo[] | null;
  /** Ptys with an open review item (the turn finished; ambient). */
  reviewPtys?: ReadonlySet<number> | null;
  /** Ptys already in Waiting on you: they aren't repeated here. */
  waitingPtys?: ReadonlySet<number> | null;
  now: number;
}

export interface FlightGroups {
  rows: FlightRow[];
  /** Idle agents folded into "n earlier today". */
  earlier: FlightRow[];
}

/** An agent's sub-line: what it's doing now (§7.1), else the first line of its summary. */
export function doingNow(agent: Pick<AgentSummary, 'now'> | null | undefined, tile: Pick<TileModel, 'summary'> | null): string {
  if (agent?.now) return describeActivity(agent.now, 'now');
  const words = tile?.summary?.preview ?? '';
  return plainLine(words, 90) || 'working';
}

const GROUP_RANK: Record<FlightGroup, number> = { failed: 0, busy: 1, waiting: 2, running: 3, review: 4, idle: 5 };

/**
 * In flight, ordered as Aeronaut's InFlightGroups: busy agents longest-running
 * first, then those ready to review, then idle (most recently finished first).
 * Failed operations lead (they need you); running ones follow the busy agents.
 * Idle agents finished more than EARLIER_AFTER_MS ago fold into `earlier`.
 */
export function inFlight(input: FlightInput): FlightGroups {
  const { now } = input;
  const agents = new Map<number, AgentSummary>();
  for (const a of input.agents ?? []) agents.set(a.pty_id, a);
  const rows: FlightRow[] = [];
  const earlier: FlightRow[] = [];
  const tilePtys = new Set<number>();

  for (const tile of input.tiles) {
    tilePtys.add(tile.ptyId);
    if (input.waitingPtys?.has(tile.ptyId)) continue;
    const agent = agents.get(tile.ptyId) ?? null;
    const times = input.times?.get(tile.ptyId) ?? null;
    const review = tile.task?.status === 'review' || !!input.reviewPtys?.has(tile.ptyId);
    const base = {
      id: `work:agent:${tile.ptyId}`,
      kind: 'agent' as const,
      title: tile.title,
      ptyId: tile.ptyId,
      taskId: tile.task?.id ?? null,
      opName: null,
    };
    if (tile.working) {
      const t = at(times?.busySince);
      rows.push({ ...base, group: 'busy', dot: 'working', sub: doingNow(agent, tile), meta: Number.isNaN(t) ? '' : formatDuration(now - t), t: Number.isNaN(t) ? now : t });
    } else if (tile.needsYou) {
      rows.push({ ...base, group: 'waiting', dot: 'needs', sub: 'waiting on you', meta: '', t: 0 });
    } else if (review) {
      const t = at(times?.idleSince);
      rows.push({ ...base, group: 'review', dot: 'done', sub: 'done · ready to review', meta: Number.isNaN(t) ? '' : formatDuration(now - t), t: Number.isNaN(t) ? 0 : t });
    } else {
      const t = at(times?.idleSince);
      const row: FlightRow = { ...base, group: 'idle', dot: 'idle', sub: tile.chip.label, meta: '', t: Number.isNaN(t) ? 0 : t };
      if (!Number.isNaN(t) && now - t > EARLIER_AFTER_MS) earlier.push(row);
      else rows.push(row);
    }
  }

  // Open tasks with no live agent here: review ones to review, the rest idle.
  for (const task of input.tasks ?? []) {
    if (task.status === 'done' || task.status === 'discarded') continue;
    const pty = task.agent?.pty_id;
    if (pty != null && tilePtys.has(pty)) continue;
    const review = task.status === 'review';
    const t = at(task.updated_at);
    rows.push({
      id: `work:task:${task.id}`,
      kind: 'task',
      group: review ? 'review' : 'idle',
      dot: review ? 'done' : 'idle',
      title: taskTitle(task) || task.title,
      sub: review ? 'done · ready to review' : task.status === 'queued' ? 'queued' : `${task.status} · no agent`,
      meta: Number.isNaN(t) ? '' : formatDuration(now - t),
      ptyId: null,
      taskId: task.id,
      opName: null,
      t: Number.isNaN(t) ? 0 : t,
    });
  }

  for (const op of input.ops ?? []) {
    const failed = op.status === 'failed' || op.status === 'crashed' || op.status === 'unhealthy';
    if (!failed && op.status !== 'running') continue;
    const run = op.running ?? op.last_run;
    const t = at(failed ? run?.ended_at ?? run?.started_at : run?.started_at);
    const age = Number.isNaN(t) ? '' : formatDuration(now - t);
    rows.push({
      id: `work:op:${op.def.name}`,
      kind: 'op',
      group: failed ? 'failed' : 'running',
      dot: failed ? 'needs' : 'working',
      title: op.def.name,
      sub: failed ? `${op.status}${age ? ` · ${age}` : ''}` : `running${age ? ` · ${age}` : ''}`,
      meta: '',
      ptyId: null,
      taskId: null,
      opName: op.def.name,
      t: Number.isNaN(t) ? now : t,
    });
  }

  const byGroup = (a: FlightRow, b: FlightRow) => {
    const g = GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (g) return g;
    // Busy and running: longest first (oldest start). Review, idle, failed: most recent first.
    if (a.group === 'busy' || a.group === 'running') return a.t - b.t;
    return b.t - a.t;
  };
  return { rows: rows.sort(byGroup), earlier: earlier.sort(byGroup) };
}

/** "3 earlier today" (the fold's label). */
export function earlierLabel(n: number): string {
  return `${n} earlier today`;
}

// ---------------------------------------------------------------------------
// The section summary
// ---------------------------------------------------------------------------

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Tasks done today (closed as done since local midnight). */
export function doneToday(closed: readonly Pick<CockpitTask, 'status' | 'closed_at'>[] | null | undefined, now: number): number {
  return (closed ?? []).filter((t) => {
    const c = at(t.closed_at);
    return t.status === 'done' && !Number.isNaN(c) && sameDay(c, now);
  }).length;
}

/** "2 waiting on you · 3 working · 1 done today"; zero parts are left out. */
export function workSummary(counts: { waiting: number; working: number; done: number }): string {
  const parts: string[] = [];
  if (counts.waiting) parts.push(`${counts.waiting} waiting on you`);
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.done) parts.push(`${counts.done} done today`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// The detail view (§4.2)
// ---------------------------------------------------------------------------

/** The id `delta` steps from `current` in `ids`, clamped at the ends; the first (or last) when current isn't there. */
export function stepItem(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = current == null ? -1 : ids.indexOf(current);
  if (i < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))];
}

export interface AlongEntry {
  at: string;
  /** The phrase, with " ×n" when n identical lines in a row were merged. */
  text: string;
  failed: boolean;
  /** How many identical consecutive lines this one stands for (1 when alone). */
  count: number;
}

/**
 * "Along the way" (§4.2): the last `limit` activity lines, oldest first. A
 * pre entry whose post came later reads once, in the past tense; identical
 * consecutive lines merge into one ("Ran grep ×3", at the latest's time).
 */
export function alongTheWay(recent: readonly AgentActivity[] | null | undefined, limit = 8): AlongEntry[] {
  const list = recent ?? [];
  const out: Array<AlongEntry & { phrase: string }> = [];
  list.forEach((e, i) => {
    if (e.phase === 'pre' && list.slice(i + 1).some((p) => p.phase === 'post' && p.tool === e.tool && p.preview === e.preview)) return;
    const phrase = describeActivity(e, e.phase === 'post' ? 'past' : 'now');
    const prev = out[out.length - 1];
    if (prev && prev.phrase === phrase) {
      prev.count++;
      prev.at = e.at;
      prev.text = `${phrase} ×${prev.count}`;
      return;
    }
    out.push({ at: e.at, text: phrase, phrase, failed: !!e.failed, count: 1 });
  });
  return out.slice(-limit).map(({ phrase: _p, ...rest }) => rest);
}

/** The fold's label: "Along the way (n)", n the lines it holds. */
export function alongLabel(n: number): string {
  return `Along the way (${n})`;
}

// ---------------------------------------------------------------------------
// The detail's reply box (§4.2): always there while the agent is
// ---------------------------------------------------------------------------

/**
 * Which reply box the detail shows: 'item' answers the attention item that
 * takes text; 'pty' types into the idle agent's terminal (purpose 'reply');
 * 'busy' shows the box disabled until its turn ends; 'none' when there is
 * no item and no live terminal.
 */
export type ReplyMode = 'item' | 'pty' | 'busy' | 'none';

export function replyMode(input: { replyItem: unknown; ptyId: number | null | undefined; working: boolean | null | undefined }): ReplyMode {
  if (input.replyItem) return 'item';
  if (input.ptyId == null) return 'none';
  return input.working ? 'busy' : 'pty';
}

/** Send is the view's one next step unless an approval's Allow is shown (Allow wins, §0 rule 1). */
export function sendIsNext(mode: ReplyMode, approvalShown: boolean): boolean {
  return !approvalShown && (mode === 'item' || mode === 'pty');
}

/** The quiet line under a disabled (busy) reply box. */
export const REPLY_BUSY_LINE = "It's working; reply when it finishes.";

/** A tabs.send refusal in words. */
export function tabSendError(error: string | null | undefined): string {
  switch (error) {
    case 'busy':
      return REPLY_BUSY_LINE;
    case 'awaiting_input':
      return 'It is waiting on a prompt in its terminal; answer that first.';
    case 'state_unknown':
      return "Can't tell whether it's ready for input; reply in its terminal.";
    case 'not_found':
      return 'That agent is gone.';
    case 'forbidden':
      return 'Not allowed to type into that terminal.';
    case 'invalid':
      return 'That reply is empty or too long.';
    default:
      return error || 'failed';
  }
}

// ---------------------------------------------------------------------------
// The detail's Updates feed (§4.2): the agent's recent turn summaries
// ---------------------------------------------------------------------------

export interface UpdateEntry {
  at: string;
  /** "14:05". */
  time: string;
  /** done / in progress / blocked / waiting; null without a lee-status. */
  status: string | null;
  /** Blocked or waiting: the one ember dot. */
  needsYou: boolean;
  text: string;
  /** lee_status.next, shown as "next: …". */
  next: string | null;
}

const STATUS_WORDS: Record<string, string> = { done: 'done', 'in-progress': 'in progress', blocked: 'blocked', waiting: 'waiting' };

const LEE_STATUS_FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*lee-status[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(LEE_STATUS_FENCE, '$1').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The first sentence of an agent's message, plain (markdown and code dropped). */
export function firstSentence(text: string | null | undefined, max = 200): string {
  const line = plainLine((text ?? '').replace(LEE_STATUS_FENCE, '$1'), 2000);
  if (!line) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  const sentence = m ? m[1] : line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * The Updates list: newest first, up to `limit`. Each shows its time, a
 * status word, lee_status.summary (else the message's first sentence) and
 * lee_status.next. The newest is left out when "It said" above already
 * shows the same words.
 */
export function updatesFeed(updates: readonly AgentUpdate[] | null | undefined, said?: string | null, limit = 10): UpdateEntry[] {
  const list = [...(updates ?? [])].reverse();
  const saidKey = squash(said);
  if (saidKey && list.length) {
    const newest = list[0];
    if (squash(newest.summary) === saidKey || squash(newest.lee_status?.summary) === saidKey) list.shift();
  }
  const out: UpdateEntry[] = [];
  for (const u of list) {
    const lee = u.lee_status;
    const text = lee?.summary?.trim() || firstSentence(u.summary);
    if (!text && !lee?.next) continue;
    const status = lee?.status ? STATUS_WORDS[lee.status] ?? null : null;
    out.push({
      at: u.at,
      time: clockTime(u.at),
      status,
      needsYou: lee?.status === 'blocked' || lee?.status === 'waiting',
      text,
      next: lee?.next?.trim() || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The detail's actions (§4.2): icons for the common ones, ⋯ for the rest
// ---------------------------------------------------------------------------

export type DetailActionId =
  | 'checkin'
  | 'cancel-checkin'
  | 'rename'
  | 'terminal'
  | 'confirm'
  | 'accept'
  | 'discard'
  | 'close'
  | 'link'
  | 'priority'
  | 'promote'
  | 'escalate'
  | 'hester-view'
  | 'assign';

export interface DetailActionsInput {
  /** A tile (a live agent) is shown. */
  tile: { checkin: unknown; canCheckin: boolean; task: unknown } | null;
  ptyId: number | null;
  task: { confirmed: boolean; status: string; workstream: string | null } | null;
}

/**
 * Which actions the detail offers, in order: `icons` as IconActions, `more`
 * in the ⋯ menu. Check in (or Cancel check-in), Rename, Open terminal,
 * Confirm, Accept / Discard, Close agent; then Link to a goal…, Priority…,
 * Promote…, Escalate → Explore, Hester's view (an open task) and Assign…
 * (an agent with no task).
 */
export function detailActions(input: DetailActionsInput): { icons: DetailActionId[]; more: DetailActionId[] } {
  const { tile, ptyId, task } = input;
  const icons: DetailActionId[] = [];
  const more: DetailActionId[] = [];
  if (tile?.checkin) icons.push('cancel-checkin');
  else if (tile?.canCheckin) icons.push('checkin');
  if (ptyId != null || task) icons.push('rename');
  if (ptyId != null) icons.push('terminal');
  if (task && !task.confirmed) icons.push('confirm');
  if (task?.status === 'review') icons.push('accept', 'discard');
  if (tile) icons.push('close');
  if (task && task.status !== 'done' && task.status !== 'discarded') {
    more.push('link', 'priority');
    if (!task.workstream) more.push('promote');
    more.push('escalate', 'hester-view');
  }
  if (tile && !tile.task && ptyId != null) more.push('assign');
  return { icons, more };
}

/** A time of day for the timeline ("14:05"). */
export function clockTime(iso: string): string {
  const t = at(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Swipe (§4.3): a horizontal trackpad scroll on a waiting card
// ---------------------------------------------------------------------------

export const SWIPE_THRESHOLD = 120;
/** No wheel events for this long ends the gesture (snap back below the threshold). */
export const SWIPE_IDLE_MS = 160;
/** The "Snoozed · Undo" row's life. */
export const SWIPE_UNDO_MS = 5000;

export type SwipeAction = 'snooze' | 'dismiss';

export interface SwipeState {
  /** The card's offset: negative is leftward. */
  dx: number;
  /** Fired this gesture: later events (momentum) are ignored until release. */
  fired: SwipeAction | null;
}

export const SWIPE_IDLE: SwipeState = { dx: 0, fired: null };

/**
 * One wheel event. Vertical-dominant events are ignored (the list scrolls).
 * Fingers moving left scroll content right (deltaX > 0), so the card moves
 * left: dx accumulates -deltaX. Past the threshold leftward snoozes and
 * rightward dismisses, once per gesture.
 */
export function swipeStep(s: SwipeState, ev: { deltaX: number; deltaY: number }): { state: SwipeState; fire: SwipeAction | null } {
  if (s.fired || Math.abs(ev.deltaX) <= Math.abs(ev.deltaY)) return { state: s, fire: null };
  const dx = s.dx - ev.deltaX;
  if (dx <= -SWIPE_THRESHOLD) return { state: { dx: 0, fired: 'snooze' }, fire: 'snooze' };
  if (dx >= SWIPE_THRESHOLD) return { state: { dx: 0, fired: 'dismiss' }, fire: 'dismiss' };
  return { state: { dx, fired: null }, fire: null };
}

/** The gesture ended (no events for SWIPE_IDLE_MS): below the threshold the card snaps back. */
export function swipeRelease(_s: SwipeState): SwipeState {
  return SWIPE_IDLE;
}

export function swipedLabel(action: SwipeAction): string {
  return action === 'snooze' ? 'Snoozed' : 'Dismissed';
}

// ---------------------------------------------------------------------------
// Library (§5)
// ---------------------------------------------------------------------------

/** Library goes quiet on an exploration untouched for this long. */
export const QUIET_AFTER_MS = 7 * 86400000;

/** Words from a Page's characters (chars / 5.7, rounded; no daemon change). */
export function wordEstimate(chars: number | null | undefined): number {
  return Math.round(Math.max(0, chars ?? 0) / 5.7);
}

/** "about 120 words" under 1,000; "1,240 words" from there; "empty page" at none. */
export function wordsLabel(chars: number | null | undefined): string {
  const n = wordEstimate(chars);
  if (n === 0) return 'empty page';
  if (n < 1000) return `about ${n} word${n === 1 ? '' : 's'}`;
  return `${n.toLocaleString('en-US')} words`;
}

export function isQuiet(lastTouched: string | null | undefined, now: number): boolean {
  const t = at(lastTouched);
  return !Number.isNaN(t) && now - t > QUIET_AFTER_MS;
}

/** The Deep fields the daemon's to_api adds to an exploration (older daemons omit them). */
export interface ExplorationDeep {
  page_chars?: number | null;
  answers_unread?: number | null;
  answers_pending?: number | null;
  open_questions?: number | null;
  last_session?: { stopped_at?: string | null; ended_at?: string | null } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "about 120 words · 2 answers · 1 open question · quiet". */
export function explorationMeta(
  exp: ExplorationDeep & { last_touched_at?: string | null; updated_at?: string | null },
  now: number,
): string {
  const parts = [wordsLabel(exp.page_chars)];
  const answers = (exp.answers_unread ?? 0) + (exp.answers_pending ?? 0);
  if (answers) parts.push(plural(answers, 'answer'));
  if (exp.open_questions) parts.push(plural(exp.open_questions, 'open question'));
  if (isQuiet(exp.last_touched_at ?? exp.updated_at, now)) parts.push('quiet');
  return parts.join(' · ');
}

/** A Page's last non-empty line, without markdown's heading, list or quote markers. */
export function lastPageLine(text: string | null | undefined): string {
  const lines = (text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').trim();
    if (line && !/^(-{3,}|\*{3,}|`{3,}.*)$/.test(line)) return line;
  }
  return '';
}

/** Newest touched first. */
export function sortByTouched<T extends { last_touched_at?: string | null; updated_at?: string | null }>(items: readonly T[]): T[] {
  const t = (x: T) => at(x.last_touched_at ?? x.updated_at) || 0;
  return [...items].sort((a, b) => t(b) - t(a));
}

/** Library's find: every word of the query appears in one of the fields (case-insensitive). */
export function matchesFind(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Surfaces whose captures are your own words from a device (Newsreader in Ideas); as the opener's AWAY_SURFACES. */
export function isDeviceCapture(surface: string | null | undefined): boolean {
  return surface === 'aeronaut' || surface === 'dirigible' || surface === 'device';
}
