/**
 * Focus sessions: manual start/stop, deterministic inference from one-minute
 * input buckets, Deep sessions, and the end rules. Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §5.3;
 * Deep sessions: docs/plans/2026-09-26-deep-d1-contracts.md §2.2;
 * card items at the Desk: docs/plans/2026-09-27-desk-foundation-contract.md §9.1.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type { DepthRating } from '../../shared/cockpit';
import type { Actor, FocusEndReason, FocusItem, FocusSource, FocusState, LeeEventInput } from '../../shared/copilot';
import { cardKindOf } from '../../shared/desk';
import { COPILOT_DEFAULTS, type CopilotConfig } from './config';

export const MAX_FOCUS_PATHS = 50;
const MINUTE = 60_000;
const BUCKET_KEEP_MINUTES = 60;

export type { FocusEndReason };
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
  source: FocusSource;
  started_at: number;
  item: FocusItem;
  interruptions: number;
  /** Desk D2: card ids this Deep session zoomed into, in first-touched order. */
  cards: string[];
  /** Desk D2 §9.2: when a device last extended the session; the idle end counts from here, not away_since. */
  extended_at: number | null;
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

/** What only a Deep session's end carries (Deep D1 §2.2): the rating and the stopped-at length, never text. */
export interface DeepEndInfo {
  deep_rating?: DepthRating | null;
  stopped_at_chars?: number;
  /** Desk D2 §9.2: a device ended it (End and rate from the idle-end push). */
  ended_via?: 'device';
}

export interface TickOptions {
  deep?: CopilotConfig['deep'];
  /** Some window is in Deep mode: no inference (Deep D1 §2.2). */
  inferBlocked?: boolean;
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
  if (item.kind === 'exploration') return `exploration:${item.workspace}:${item.exploration_id ?? ''}`;
  if (item.kind === 'card') return `card:${item.workspace}:${item.card_id ?? ''}`;
  return null;
}

/** A Desk card id (a Page's `pg-` or a Board's `bd-`); null/absent is null, anything else undefined. */
export function parseCardId(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && cardKindOf(v) ? v : undefined;
}

/** The card id a focus item names, or null. */
function cardOf(item: FocusItem | null | undefined): string | null {
  return item && item.kind === 'card' ? item.card_id : null;
}

/** An exploration id as Hester writes them; anything else is dropped. */
const EXPLORATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function parseExplorationId(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && EXPLORATION_ID_RE.test(v) ? v : undefined;
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
  if (o.kind === 'exploration' && typeof o.workspace === 'string' && o.workspace) {
    const id = parseExplorationId(o.exploration_id);
    if (id === undefined) return null;
    return {
      kind: 'exploration',
      workspace: o.workspace,
      exploration_id: id,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : 'Deep',
    };
  }
  if (o.kind === 'card' && typeof o.workspace === 'string' && o.workspace) {
    const id = parseCardId(o.card_id);
    if (id === undefined) return null;
    if (o.card_kind !== undefined && o.card_kind !== null && o.card_kind !== 'page' && o.card_kind !== 'board') return null;
    return {
      kind: 'card',
      workspace: o.workspace,
      card_id: id,
      card_kind: id ? cardKindOf(id) : o.card_kind === 'page' || o.card_kind === 'board' ? o.card_kind : null,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : 'Deep',
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

  get source(): FocusSource | null {
    return this.session?.source ?? null;
  }

  /** Attention policy (Deep D1 §2.3): 'none' iff a Deep session is active. */
  get policy(): 'normal' | 'none' {
    return this.session?.source === 'deep' ? 'none' : 'normal';
  }

  /**
   * The Deep session's card (or D1 exploration), or null outside Deep. For a
   * card, exploration_id repeats card_id for device builds before the Desk.
   */
  get deep(): FocusState['deep'] {
    const item = this.session?.source === 'deep' ? this.session.item : null;
    if (item?.kind === 'card') {
      return { exploration_id: item.card_id, title: item.title, workspace: item.workspace, card_id: item.card_id, card_kind: item.card_kind };
    }
    if (!item || item.kind !== 'exploration') return null;
    return { exploration_id: item.exploration_id, title: item.title, workspace: item.workspace };
  }

  /** Desk D2: the Deep session's touched cards, in first-touched order (the last card zoomed into is `last`). */
  get deepCards(): { touched: string[]; last: string | null } {
    const s = this.session?.source === 'deep' ? this.session : null;
    return { touched: s ? [...s.cards] : [], last: s ? cardOf(s.item) ?? s.cards[s.cards.length - 1] ?? null : null };
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
      policy: this.policy,
      deep: this.deep,
    };
  }

  /** Whether an item from this agent (pty, files it wrote) relates to the focus item. */
  isRelated(ptyId: number | null, filesWritten: string[]): boolean {
    const item = this.session?.item;
    if (!item) return false;
    // No agent is related to a Deep session.
    if (item.kind === 'exploration' || item.kind === 'card') return false;
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

  /**
   * When a Deep session ends for being away (Desk D2 §9.2): idle_end_minutes
   * after away_since, or after the last Extend when that is later. Null
   * outside Deep or while at the machine.
   */
  deepIdleEndsAt(presence: PresenceLike | null, deepCfg: CopilotConfig['deep'] = COPILOT_DEFAULTS.deep): number | null {
    const s = this.session;
    if (!s || s.source !== 'deep' || !presence || presence.at_machine || !presence.away_since) return null;
    const awaySince = Date.parse(presence.away_since);
    if (!Number.isFinite(awaySince)) return null;
    const base = s.extended_at !== null ? Math.max(awaySince, s.extended_at) : awaySince;
    return base + deepCfg.idle_end_minutes * MINUTE;
  }

  /** Extend from a device: the idle end moves to now + idle_end_minutes. False outside Deep. */
  extendDeep(now: number): boolean {
    if (!this.session || this.session.source !== 'deep') return false;
    this.session.extended_at = now;
    return true;
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
   * session to manual, keeping its session_id. A Deep start ends a manual or
   * inferred session (reason 'switch') and starts a Deep one; during Deep it
   * only updates the item. Neither manual nor inferred starts touch a Deep
   * session. Returns true on any change.
   */
  start(item: FocusItem, source: FocusSource, surface: FocusSurface, actor: Actor, now: number): boolean {
    let s = this.session;
    if (s && source === 'deep') {
      if (s.source === 'deep') {
        const changedItem = JSON.stringify(s.item) !== JSON.stringify(item);
        if (!changedItem) return false;
        const prevCard = cardOf(s.item);
        s.item = cloneItem(item);
        // Desk D2 §5.1: at the Desk, focus.item only when zooming into a
        // different card (a retitle or a null card is not a new item).
        const card = cardOf(item);
        if (item.kind === 'card') {
          if (card && !s.cards.includes(card)) s.cards.push(card);
          if (!card || card === prevCard) return true;
        }
        this.deps.log({ type: 'focus.item', actor, data: { session_id: s.session_id, item: cloneItem(item) } });
        return true;
      }
      this.stop('switch', now, actor);
      s = null;
    }
    if (s) {
      if (source === 'inferred' || s.source === 'deep') return false;
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
      cards: cardOf(item) ? [cardOf(item) as string] : [],
      extended_at: null,
    };
    this.deps.log({
      type: 'focus.start',
      actor,
      data: { session_id: this.session.session_id, source, item: cloneItem(item), surface, policy: this.policy },
    });
    return true;
  }

  /** End the session. `deep` is recorded only for Deep sessions (rating null when not given). */
  stop(reason: FocusEndReason, now: number, actor?: Actor, deep?: DeepEndInfo): boolean {
    const s = this.session;
    if (!s) return false;
    this.session = null;
    this.lastEndMinute = Math.floor(now / MINUTE);
    const stoppedAt = deep?.stopped_at_chars;
    this.deps.log({
      type: 'focus.end',
      actor,
      data: {
        session_id: s.session_id,
        source: s.source,
        reason,
        duration_ms: Math.max(0, now - s.started_at),
        interruptions: s.interruptions,
        ...(s.source === 'deep'
          ? {
              deep_rating: deep?.deep_rating ?? null,
              ...(typeof stoppedAt === 'number' && Number.isInteger(stoppedAt) && stoppedAt >= 0 ? { stopped_at_chars: stoppedAt } : {}),
              ...(deep?.ended_via ? { ended_via: deep.ended_via } : {}),
            }
          : {}),
      },
    });
    return true;
  }

  /** End rules and inference; call every ~15 s. Returns true on any change. */
  tick(now: number, presence: PresenceLike | null, cfg: CopilotConfig['focus'], opts: TickOptions = {}): boolean {
    const cur = Math.floor(now / MINUTE);
    const s = this.session;
    if (s) {
      if (s.source === 'deep') {
        const endsAt = this.deepIdleEndsAt(presence, opts.deep ?? COPILOT_DEFAULTS.deep);
        if (endsAt !== null && now >= endsAt) return this.stop('away', now);
      } else if (presence && !presence.at_machine && presence.away_since) {
        const awayMs = now - Date.parse(presence.away_since);
        const minutes = s.source === 'manual' ? cfg.manual_end_away_minutes : cfg.inferred_end_away_minutes;
        if (Number.isFinite(awayMs) && awayMs >= minutes * MINUTE) return this.stop('away', now);
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

    if (!cfg.infer_enabled || opts.inferBlocked) return false;
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
