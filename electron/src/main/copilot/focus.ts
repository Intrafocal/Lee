/**
 * Focus sessions: manual start/stop, deterministic inference from one-minute
 * input buckets, and the end rules. Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §5.3.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type { Actor, FocusItem, FocusState, LeeEventInput } from '../../shared/copilot';
import type { CopilotConfig } from './config';

export const MAX_FOCUS_PATHS = 50;
const MINUTE = 60_000;
const BUCKET_KEEP_MINUTES = 60;

export type FocusEndReason = 'manual' | 'away' | 'switch' | 'handoff' | 'quit';
export type FocusSurface = 'lee' | 'device' | 'auto';

/** One `input.counts` line, as the focus tracker needs it. */
export interface FocusInput {
  window_id: number | null;
  tab_id: number | null;
  pty_id: number | null;
  file_path: string | null;
  workspace: string | null;
  label: string | null;
  keys: number;
  clicks: number;
}

interface TabCounts {
  n: number;
  keys: number;
  pty_id: number | null;
  file_path: string | null;
  workspace: string | null;
  window_id: number | null;
  label: string | null;
  files: Set<string>;
}

interface Session {
  session_id: string;
  source: 'manual' | 'inferred';
  started_at: number;
  item: FocusItem;
  interruptions: number;
}

export interface FocusDeps {
  /** True when the PTY runs a tracked agent session. */
  isAgentPty: (ptyId: number) => boolean;
  log: (input: LeeEventInput) => void;
  /**
   * v4 §7.4: the task an agent PTY works on ({workspace, task_id}), for
   * relating attention items to a task focus. Optional; set later with
   * setTaskResolver() once the cockpit is up.
   */
  taskOfPty?: (ptyId: number) => { workspace: string | null; task_id: string } | null;
}

export interface PresenceLike {
  at_machine: boolean;
  away_since: string | null;
}

function cloneItem(item: FocusItem): FocusItem {
  return JSON.parse(JSON.stringify(item));
}

function samePath(a: string, b: string): boolean {
  return a === b || path.resolve(a) === path.resolve(b);
}

export function focusItemKey(item: FocusItem | null): string | null {
  if (!item) return null;
  if (item.kind === 'agent') return `agent:${item.pty_id}`;
  if (item.kind === 'files') return `files:${item.workspace ?? ''}`;
  if (item.kind === 'task') return `task:${item.workspace}:${item.task_id}`;
  return null;
}

/** Validate a FocusItem from an untrusted body. */
export function parseFocusItem(v: unknown): FocusItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'agent' && Number.isInteger(o.pty_id)) {
    return {
      kind: 'agent',
      pty_id: o.pty_id as number,
      window_id: Number.isInteger(o.window_id) ? (o.window_id as number) : null,
      label: typeof o.label === 'string' ? o.label : 'Agent',
    };
  }
  if (o.kind === 'files' && Array.isArray(o.paths)) {
    const paths = o.paths.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_FOCUS_PATHS);
    return { kind: 'files', workspace: typeof o.workspace === 'string' ? o.workspace : null, paths };
  }
  if (o.kind === 'workspace' && typeof o.workspace === 'string' && o.workspace) {
    return { kind: 'workspace', workspace: o.workspace };
  }
  if (o.kind === 'task' && typeof o.workspace === 'string' && o.workspace && typeof o.task_id === 'string' && o.task_id) {
    return {
      kind: 'task',
      workspace: o.workspace,
      task_id: o.task_id.slice(0, 128),
      label: typeof o.label === 'string' && o.label ? o.label.slice(0, 200) : 'Task',
    };
  }
  return null;
}

export class FocusTracker {
  private buckets = new Map<number, Map<string, TabCounts>>();
  private session: Session | null = null;
  /** Buckets at or before this minute never feed inference (no instant re-start after an end). */
  private lastEndMinute = -Infinity;

  constructor(private deps: FocusDeps) {}

  /** v4 §7.4: how to find the task an agent PTY works on. */
  setTaskResolver(fn: FocusDeps['taskOfPty'] | null): void {
    this.deps.taskOfPty = fn ?? undefined;
  }

  get active(): boolean {
    return this.session !== null;
  }

  get sessionId(): string | null {
    return this.session?.session_id ?? null;
  }

  get item(): FocusItem | null {
    return this.session?.item ?? null;
  }

  get source(): 'manual' | 'inferred' | null {
    return this.session?.source ?? null;
  }

  state(quietCount: number): FocusState {
    const s = this.session;
    return {
      active: !!s,
      session_id: s?.session_id ?? null,
      source: s?.source ?? null,
      started_at: s ? new Date(s.started_at).toISOString() : null,
      item: s ? cloneItem(s.item) : null,
      quiet_count: s ? quietCount : 0,
    };
  }

  /** Whether an item from this agent (pty, files it wrote) relates to the focus item. */
  isRelated(ptyId: number | null, filesWritten: string[]): boolean {
    const item = this.session?.item;
    if (!item) return false;
    if (item.kind === 'agent') return ptyId != null && ptyId === item.pty_id;
    if (item.kind === 'files') {
      return filesWritten.some((f) => item.paths.some((p) => samePath(f, p)));
    }
    if (item.kind === 'task') {
      if (ptyId == null || !this.deps.taskOfPty) return false;
      let t: { workspace: string | null; task_id: string } | null = null;
      try {
        t = this.deps.taskOfPty(ptyId);
      } catch {
        t = null;
      }
      return !!t && t.task_id === item.task_id && (t.workspace == null || samePath(t.workspace, item.workspace));
    }
    return false;
  }

  noteInterruption(): void {
    if (this.session) this.session.interruptions++;
  }

  private bucketKey(c: TabCounts): string | null {
    if (c.pty_id != null && this.deps.isAgentPty(c.pty_id)) return `agent:${c.pty_id}`;
    if (c.file_path) return `files:${c.workspace ?? ''}`;
    return null;
  }

  /** Winner of a minute: the tab with the most keys+clicks. */
  private minuteWinner(minute: number): TabCounts | null {
    const tabs = this.buckets.get(minute);
    if (!tabs) return null;
    let best: TabCounts | null = null;
    for (const c of tabs.values()) if (c.n > 0 && (!best || c.n > best.n)) best = c;
    return best;
  }

  /** Record one input.counts line. Returns true when the focus item changed. */
  record(input: FocusInput, now: number): boolean {
    const n = Math.max(0, input.keys) + Math.max(0, input.clicks);
    if (n > 0) {
      const minute = Math.floor(now / MINUTE);
      let tabs = this.buckets.get(minute);
      if (!tabs) {
        tabs = new Map();
        this.buckets.set(minute, tabs);
      }
      const tabKey = `${input.window_id ?? '-'}:${input.tab_id ?? '-'}:${input.pty_id ?? '-'}:${input.file_path ?? '-'}`;
      let c = tabs.get(tabKey);
      if (!c) {
        c = {
          n: 0,
          keys: 0,
          pty_id: input.pty_id,
          file_path: input.file_path,
          workspace: input.workspace,
          window_id: input.window_id,
          label: input.label,
          files: new Set(),
        };
        tabs.set(tabKey, c);
      }
      c.n += n;
      c.keys += Math.max(0, input.keys);
      if (input.file_path) c.files.add(input.file_path);
      for (const m of this.buckets.keys()) if (m < minute - BUCKET_KEEP_MINUTES) this.buckets.delete(m);
    }

    const s = this.session;
    if (s && s.item.kind === 'files' && input.keys > 0 && input.file_path) {
      const item = s.item;
      if (!item.paths.some((p) => samePath(p, input.file_path as string)) && item.paths.length < MAX_FOCUS_PATHS) {
        item.paths.push(input.file_path);
        this.deps.log({ type: 'focus.item', data: { session_id: s.session_id, item: cloneItem(item) } });
        return true;
      }
    }
    return false;
  }

  /**
   * Start (or re-target) a session. A manual start converts an inferred
   * session to manual, keeping its session_id. Returns true on any change.
   */
  start(item: FocusItem, source: 'manual' | 'inferred', surface: FocusSurface, actor: Actor, now: number): boolean {
    const s = this.session;
    if (s) {
      if (source === 'inferred') return false;
      const changedItem = JSON.stringify(s.item) !== JSON.stringify(item);
      s.item = cloneItem(item);
      if (s.source === 'inferred') s.source = 'manual';
      if (changedItem) this.deps.log({ type: 'focus.item', actor, data: { session_id: s.session_id, item: cloneItem(item) } });
      return true;
    }
    this.session = {
      session_id: `fs_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      source,
      started_at: now,
      item: cloneItem(item),
      interruptions: 0,
    };
    this.deps.log({
      type: 'focus.start',
      actor,
      data: { session_id: this.session.session_id, source, item: cloneItem(item), surface },
    });
    return true;
  }

  stop(reason: FocusEndReason, now: number, actor?: Actor): boolean {
    const s = this.session;
    if (!s) return false;
    this.session = null;
    this.lastEndMinute = Math.floor(now / MINUTE);
    this.deps.log({
      type: 'focus.end',
      actor,
      data: {
        session_id: s.session_id,
        reason,
        duration_ms: Math.max(0, now - s.started_at),
        interruptions: s.interruptions,
      },
    });
    return true;
  }

  /** End rules and inference; call every ~15 s. Returns true on any change. */
  tick(now: number, presence: PresenceLike | null, cfg: CopilotConfig['focus']): boolean {
    const cur = Math.floor(now / MINUTE);
    const s = this.session;
    if (s) {
      if (presence && !presence.at_machine && presence.away_since) {
        const awayMs = now - Date.parse(presence.away_since);
        const limit = (s.source === 'manual' ? cfg.manual_end_away_minutes : cfg.inferred_end_away_minutes) * MINUTE;
        if (Number.isFinite(awayMs) && awayMs >= limit) return this.stop('away', now);
      }
      if (s.source === 'inferred' && cfg.switch_minutes > 0) {
        const key = focusItemKey(s.item);
        const startMinute = Math.floor(s.started_at / MINUTE);
        let run = 0;
        for (let m = cur - 1; m > startMinute && run < cfg.switch_minutes; m--) {
          const w = this.minuteWinner(m);
          if (!w || this.bucketKey(w) === key) break;
          run++;
        }
        if (run >= cfg.switch_minutes) return this.stop('switch', now);
      }
      return false;
    }

    if (!cfg.infer_enabled) return false;
    const winners: TabCounts[] = [];
    let key: string | null | undefined;
    for (let m = cur - cfg.infer_window_minutes; m < cur; m++) {
      if (m <= this.lastEndMinute) continue;
      const w = this.minuteWinner(m);
      if (!w) continue;
      const k = this.bucketKey(w);
      if (k === null) return false;
      if (key === undefined) key = k;
      else if (k !== key) return false;
      winners.push(w);
    }
    if (winners.length < cfg.infer_min_active_minutes || !key) return false;

    let item: FocusItem;
    const last = winners[winners.length - 1];
    if (key.startsWith('agent:')) {
      item = { kind: 'agent', pty_id: last.pty_id as number, window_id: last.window_id, label: last.label ?? 'Agent' };
    } else {
      const paths: string[] = [];
      for (let m = cur - cfg.infer_window_minutes; m < cur; m++) {
        if (m <= this.lastEndMinute) continue;
        for (const c of this.buckets.get(m)?.values() ?? []) {
          if (this.bucketKey(c) !== key) continue;
          for (const f of c.files) if (!paths.includes(f) && paths.length < MAX_FOCUS_PATHS) paths.push(f);
        }
      }
      item = { kind: 'files', workspace: last.workspace, paths };
    }
    return this.start(item, 'inferred', 'auto', { kind: 'system' }, now);
  }
}
