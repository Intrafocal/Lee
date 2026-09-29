/**
 * Cockpit bus: the in-process seam between the v2 Lee main packages
 * A (lee-tab), B (lee-ops) and D (lee-lint). No package imports another's
 * modules; all of them import this file.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix B).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * - A registers the tab runtime, the task launcher, the command history and
 *   the '/command' domain 'tab'; A's api-server.ts edit calls setExpressApp()
 *   and getCommandDomain().
 * - B registers the ops provider and the '/command' domain 'ops'.
 * - D persists the nudge budget and registers its HTTP routes.
 * - Everyone posts Feed entries and registers a Feed action handler for their
 *   producer name.
 *
 * Electron-free on purpose (smoke-testable with plain node).
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { Application } from 'express';
import type { LeeEvent, LeeEventInput, LeeEventType, Principal } from '../../shared/copilot';
import { copilotBus, logEvent } from '../copilot/bus';
import type {
  CockpitEventType,
  FeedAction,
  FeedActionResult,
  FeedEntry,
  FeedEntryState,
  FeedKind,
  FeedProducer,
  FeedRef,
  FeedSeverity,
  FeedSnapshot,
  LaunchRequest,
  LaunchResult,
  NudgeClaim,
  NudgeClaimRequest,
  OperationDef,
  OperationsSnapshot,
  TabReadRequest,
  TabReadResult,
  TabRuntimeInfo,
  TabSendRequest,
  TabSendResult,
  TabStateInfo,
  TaskOrigin,
} from '../../shared/cockpit';

// ---------------------------------------------------------------------------
// Event log helper
// ---------------------------------------------------------------------------

/** Log a v2 event type through the v0 bus (same envelope, same sink). */
export function logCockpitEvent<T = Record<string, unknown>>(
  type: CockpitEventType,
  input: Omit<LeeEventInput<T>, 'type'>,
): LeeEvent<T> {
  return logEvent<T>({ ...input, type: type as unknown as LeeEventType });
}

function isoNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Feed store
// ---------------------------------------------------------------------------

export interface FeedPostInput {
  workspace: string | null;
  kind: FeedKind;
  severity: FeedSeverity;
  producer: FeedProducer;
  title: string;
  text?: string | null;
  text_is_agent?: boolean;
  item_ref?: string | null;
  ref?: FeedRef;
  actions?: FeedAction[];
  pinned?: boolean;
  /** Milliseconds until the entry expires (default: never). */
  ttl_ms?: number | null;
  /** An open entry with the same key is updated instead of duplicated. */
  dedupe_key?: string | null;
}

const SEVERITY_ORDER: Record<FeedSeverity, number> = { blocking: 0, 'needs-you': 1, ambient: 2 };
const MAX_ENTRIES = 500;

export class FeedStore extends EventEmitter {
  private entries = new Map<string, FeedEntry>();
  private dedupe = new Map<string, string>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    super();
    this.now = opts.now ?? Date.now;
  }

  post(input: FeedPostInput): FeedEntry {
    const now = this.now();
    const key = input.dedupe_key ?? null;
    const existingId = key ? this.dedupe.get(key) : undefined;
    const existing = existingId ? this.entries.get(existingId) : undefined;
    if (existing && existing.state === 'open') {
      const updated: FeedEntry = {
        ...existing,
        version: existing.version + 1,
        severity: input.severity,
        title: input.title,
        text: input.text ?? null,
        text_is_agent: input.text_is_agent ?? false,
        ref: input.ref ?? existing.ref,
        actions: input.actions ?? existing.actions,
        pinned: input.pinned ?? existing.pinned,
        updated_at: isoNow(now),
        expires_at: input.ttl_ms != null ? isoNow(now + input.ttl_ms) : existing.expires_at,
      };
      this.entries.set(updated.id, updated);
      this.emit('change', updated);
      return updated;
    }
    const entry: FeedEntry = {
      id: newId('feed'),
      version: 1,
      workspace: input.workspace,
      kind: input.kind,
      severity: input.severity,
      producer: input.producer,
      title: input.title,
      text: input.text ?? null,
      text_is_agent: input.text_is_agent ?? false,
      created_at: isoNow(now),
      updated_at: isoNow(now),
      state: 'open',
      item_ref: input.item_ref ?? null,
      ref: input.ref ?? {},
      actions: input.actions ?? [],
      pinned: input.pinned ?? false,
      expires_at: input.ttl_ms != null ? isoNow(now + input.ttl_ms) : null,
    };
    this.entries.set(entry.id, entry);
    if (key) this.dedupe.set(key, entry.id);
    this.trim();
    this.emit('change', entry);
    return entry;
  }

  get(id: string): FeedEntry | null {
    this.sweep();
    return this.entries.get(id) ?? null;
  }

  /** Close an entry. Returns the updated entry, or null if unknown. */
  setState(id: string, state: FeedEntryState): FeedEntry | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.state === state) return e;
    const updated: FeedEntry = { ...e, state, version: e.version + 1, updated_at: isoNow(this.now()) };
    this.entries.set(id, updated);
    this.emit('change', updated);
    return updated;
  }

  /** Close every open entry with this dedupe key (e.g. a proposal that was answered elsewhere). */
  closeByKey(key: string, state: FeedEntryState = 'done'): void {
    const id = this.dedupe.get(key);
    if (id) this.setState(id, state);
  }

  /**
   * Entries for one workspace plus machine-wide (workspace null) ones. Pass
   * undefined for all. Order: open before closed; pinned; severity; newest.
   */
  list(workspace?: string | null, opts: { includeClosed?: boolean; limit?: number } = {}): FeedEntry[] {
    this.sweep();
    const out: FeedEntry[] = [];
    for (const e of this.entries.values()) {
      if (workspace !== undefined && e.workspace !== null && e.workspace !== workspace) continue;
      if (!opts.includeClosed && e.state !== 'open') continue;
      out.push(e);
    }
    out.sort((a, b) => {
      const ao = a.state === 'open' ? 0 : 1;
      const bo = b.state === 'open' ? 0 : 1;
      if (ao !== bo) return ao - bo;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (s !== 0) return s;
      return b.created_at.localeCompare(a.created_at);
    });
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  snapshot(workspace?: string | null): FeedSnapshot {
    return {
      workspace: workspace ?? null,
      entries: this.list(workspace, { includeClosed: true, limit: 200 }),
      generated_at: isoNow(this.now()),
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.state === 'open' && e.expires_at && Date.parse(e.expires_at) <= now) {
        this.setState(e.id, 'expired');
      }
    }
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const closed = [...this.entries.values()]
      .filter((e) => e.state !== 'open')
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    for (const e of closed) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(e.id);
    }
    // Keys like ops:metric:...:<run id> are unique per run: drop those whose entry is gone.
    for (const [key, id] of this.dedupe) if (!this.entries.has(id)) this.dedupe.delete(key);
  }
}

export type FeedActionHandler = (
  entry: FeedEntry,
  actionId: string,
  payload: Record<string, string>,
  by: Principal,
) => Promise<FeedActionResult>;

// ---------------------------------------------------------------------------
// Nudge budget
// ---------------------------------------------------------------------------

export interface NudgeRecord {
  item_ref: string;
  state_key: string;
  granted_at: number;
  overridden: boolean;
}

export class NudgeBudget extends EventEmitter {
  private records = new Map<string, NudgeRecord>();
  private grants: number[] = [];
  private readonly now: () => number;
  perHour: number;

  constructor(opts: { perHour?: number; now?: () => number } = {}) {
    super();
    this.perHour = opts.perHour ?? 6;
    this.now = opts.now ?? Date.now;
  }

  /**
   * At most one nudge per item per state, none during focus unless blocking,
   * none at all during Deep (Deep D1 §2.3), and a machine-wide hourly cap.
   */
  claim(req: NudgeClaimRequest, focusActive: boolean, deepActive = false): NudgeClaim {
    if (deepActive) return { granted: false, reason: 'deep' };
    const now = this.now();
    const rec = this.records.get(req.item_ref);
    if (rec && rec.state_key === req.state_key) {
      return { granted: false, reason: rec.overridden ? 'overridden' : 'same_state' };
    }
    if (focusActive && !req.blocking) return { granted: false, reason: 'focus' };
    this.grants = this.grants.filter((t) => now - t < 3_600_000);
    if (this.grants.length >= this.perHour && !req.blocking) return { granted: false, reason: 'rate' };
    this.grants.push(now);
    const next: NudgeRecord = { item_ref: req.item_ref, state_key: req.state_key, granted_at: now, overridden: false };
    this.records.set(req.item_ref, next);
    this.emit('change');
    return { granted: true, reason: null };
  }

  /** The user dismissed or overrode a nudge: stay quiet on the item until its state changes. */
  override(itemRef: string, stateKey: string): void {
    this.records.set(itemRef, { item_ref: itemRef, state_key: stateKey, granted_at: this.now(), overridden: true });
    this.emit('change');
  }

  export(): NudgeRecord[] {
    return [...this.records.values()];
  }

  load(records: NudgeRecord[]): void {
    for (const r of records) {
      if (r && typeof r.item_ref === 'string' && typeof r.state_key === 'string') this.records.set(r.item_ref, r);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider interfaces (implemented by one package, used by others)
// ---------------------------------------------------------------------------

/** Package A. */
export interface TabRuntime {
  list(workspace?: string | null): TabRuntimeInfo[];
  get(ptyId: number): TabRuntimeInfo | null;
  state(ptyId: number): TabStateInfo;
  read(ptyId: number, req: TabReadRequest): TabReadResult;
  /** Total bytes seen so far on this PTY (a read cursor for "from now on"). */
  cursor(ptyId: number): number;
  /**
   * Enforces the C3 rules of the contract's section 5.3 for `by`.
   * `opts.askedBy` names who asked, for the Feed notice, when Lee types on
   * someone else's behalf (Hester's operation runs).
   */
  send(ptyId: number, req: TabSendRequest, by: Principal, opts?: { askedBy?: Principal }): Promise<TabSendResult>;
  /** Ask a window (default: the focused window of `workspace`) to open a tab. */
  openTab(opts: {
    workspace: string;
    window_id?: number | null;
    type: 'terminal' | 'agent';
    label: string;
    command?: string;
    args?: string[];
    provider?: string;
    activate?: boolean;
  }): Promise<{ pty_id: number | null; tab_id: number | null; error?: string }>;
  /** Full text of a recent hand-typed command, by signature (in-memory only; null after a restart). */
  commandText(workspace: string, sig: string): string | null;
}

export interface TaskCreateInput {
  workspace: string;
  title: string;
  kind?: LaunchRequest['kind'];
  lead?: LaunchRequest['lead'];
  status?: 'queued' | 'review';
  origin?: TaskOrigin;
  note?: string | null;
  confirmed?: boolean;
}

/** Package A. */
export interface TaskLauncher {
  launch(req: LaunchRequest, by: Principal, windowId?: number | null): Promise<LaunchResult>;
  /** A task with no agent (queued), relayed to Hester with spool-on-failure. */
  createTask(input: TaskCreateInput): Promise<{ task_id: string; relayed: boolean }>;
}

/** Package B. */
export interface OpsProvider {
  snapshot(workspace: string): OperationsSnapshot;
  /** Add an unconfirmed suggestion (e.g. from the toil/repeated-sequence fix). */
  suggest(workspace: string, def: OperationDef, detectedFrom: string): void;
  /** Set a boolean flag on a defined operation in .lee/operations.yaml. */
  setFlag(workspace: string, name: string, flag: 'notify_on_done' | 'confirm', value: boolean): Promise<boolean>;
}

/**
 * In-process only, never logged: a command started or ended in a shell that
 * has Lee's shell integration (package A emits; B links runs, D may listen).
 */
export interface TerminalCommandSignal {
  pty_id: number;
  workspace: string | null;
  phase: 'start' | 'end';
  /** First 12 hex of sha1(normalized command line). */
  sig: string;
  argv0: string;
  /** Full command line. Never write it to the event log. */
  text: string;
  cwd: string | null;
  /** 'lee' when Lee typed it (an operation run), else 'user'. */
  by: 'user' | 'lee';
  exit_code: number | null;
  started_at: string;
  duration_ms: number | null;
}

export interface CommandDomainResult {
  status: number;
  body: unknown;
}

export type CommandDomainHandler = (
  action: string,
  params: Record<string, unknown>,
  principal: Principal | undefined,
) => Promise<CommandDomainResult>;

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

class CockpitBus extends EventEmitter {
  readonly feed = new FeedStore();
  readonly nudges = new NudgeBudget();
  private app: Application | null = null;
  private appWaiters: Array<(app: Application) => void> = [];
  private domains = new Map<string, CommandDomainHandler>();
  private feedHandlers = new Map<FeedProducer, FeedActionHandler>();
  private focusActive = false;
  /** A Deep session (focus.start with source 'deep') is active. */
  private deepActive = false;
  tabRuntime: TabRuntime | null = null;
  launcher: TaskLauncher | null = null;
  ops: OpsProvider | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
    copilotBus.on('event', (e: LeeEvent) => {
      if (e.type === 'focus.start') {
        this.focusActive = true;
        this.deepActive = (e.data as { source?: unknown } | null)?.source === 'deep';
      } else if (e.type === 'focus.end') {
        this.focusActive = false;
        this.deepActive = false;
      }
    });
  }

  /** api-server.ts (package A's edit) hands over the Express app once routes are set up. */
  setExpressApp(app: Application): void {
    this.app = app;
    const waiting = this.appWaiters;
    this.appWaiters = [];
    for (const fn of waiting) {
      try {
        fn(app);
      } catch (err) {
        console.error('[cockpit] route registration failed:', err);
      }
    }
  }

  /** Register HTTP routes now, or as soon as the app exists. Routes sit behind the auth middleware. */
  withExpressApp(fn: (app: Application) => void): void {
    if (this.app) {
      try {
        fn(this.app);
      } catch (err) {
        console.error('[cockpit] route registration failed:', err);
      }
    } else {
      this.appWaiters.push(fn);
    }
  }

  registerCommandDomain(domain: string, handler: CommandDomainHandler): void {
    this.domains.set(domain, handler);
  }

  getCommandDomain(domain: string): CommandDomainHandler | undefined {
    return this.domains.get(domain);
  }

  setTabRuntime(rt: TabRuntime | null): void {
    this.tabRuntime = rt;
  }

  setLauncher(l: TaskLauncher | null): void {
    this.launcher = l;
  }

  setOps(p: OpsProvider | null): void {
    this.ops = p;
  }

  emitTerminal(signal: TerminalCommandSignal): void {
    try {
      this.emit('terminal', signal);
    } catch (err) {
      console.error('[cockpit] terminal listener failed:', err);
    }
  }

  onTerminal(fn: (signal: TerminalCommandSignal) => void): () => void {
    this.on('terminal', fn);
    return () => {
      this.off('terminal', fn);
    };
  }

  isFocusActive(): boolean {
    return this.focusActive;
  }

  isDeepActive(): boolean {
    return this.deepActive;
  }

  claimNudge(req: NudgeClaimRequest): NudgeClaim {
    const res = this.nudges.claim(req, this.focusActive, this.deepActive);
    logCockpitEvent('nudge.claim', {
      workspace: req.workspace ?? null,
      data: { item_ref: req.item_ref, source: req.source, granted: res.granted, reason: res.reason },
    });
    return res;
  }

  registerFeedActionHandler(producer: FeedProducer, handler: FeedActionHandler): void {
    this.feedHandlers.set(producer, handler);
  }

  /** Run a Feed action. 'dismiss' is built in: closes the entry and quiets its item until it changes. */
  async actOnFeed(entryId: string, actionId: string, payload: Record<string, string>, by: Principal): Promise<FeedActionResult> {
    // Feed actions approve proposals and type into tabs: humans only (C3).
    if (by.kind === 'shared') return { success: false, error: 'forbidden' };
    const entry = this.feed.get(entryId);
    if (!entry) return { success: false, error: 'not_found' };
    if (entry.state !== 'open') return { success: false, error: 'closed', entry };
    if (actionId === 'dismiss') {
      const updated = this.feed.setState(entryId, 'dismissed') ?? undefined;
      if (entry.item_ref) this.nudges.override(entry.item_ref, `dismissed:${entry.version}`);
      logEvent({
        type: 'ui.ceremony',
        workspace: entry.workspace,
        actor: by.kind === 'device'
          ? { kind: 'user', surface: 'device', device_id: by.device_id, device_kind: by.device_kind }
          : { kind: 'user', surface: 'lee' },
        data: { action: 'dismiss', target: `feed:${entry.kind}` },
      });
      return { success: true, entry: updated };
    }
    if (!entry.actions.some((a) => a.id === actionId)) return { success: false, error: 'unknown_action', entry };
    const handler = this.feedHandlers.get(entry.producer);
    if (!handler) return { success: false, error: 'producer_unavailable', entry };
    logCockpitEvent('feed.action', {
      workspace: entry.workspace,
      data: { entry_kind: entry.kind, producer: entry.producer, action: actionId, principal: by.kind },
    });
    try {
      return await handler(entry, actionId, payload, by);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), entry };
    }
  }
}

export const cockpitBus = new CockpitBus();
