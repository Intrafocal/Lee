/**
 * TabRuntime (contract §5.1–§5.3): per-PTY output ring, shell-integration
 * state, agent hook state, tab state, C3-checked input, the create-tab bridge
 * and the in-memory command history.
 *
 * Subscribes to ptyManager 'data'/'exit' and copilotBus events; never edits
 * api-server's own buffers or the v0 queue.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { Actor, LeeEvent, Principal } from '../../shared/copilot';
import type {
  CreateTabRequest,
  CreateTabResult,
  TabInputPurpose,
  TabKind,
  TabLastCommand,
  TabReadRequest,
  TabReadResult,
  TabRunState,
  TabRuntimeInfo,
  TabSendRequest,
  TabSendResult,
  TabStateInfo,
  TabStateSource,
} from '../../shared/cockpit';
import { COCKPIT_IPC } from '../../shared/cockpit';
import type { TabContext } from '../../shared/context';
import { copilotBus } from '../copilot/bus';
import { windowRegistry } from '../window-registry';
import { cockpitBus, logCockpitEvent, type TabRuntime as TabRuntimeContract } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import { CommandHistory, commandArgv0, commandSig } from './command-history';
import { OutputRing } from './output-ring';
import { ShellOscParser, type ShellOscEvent } from './shell-osc';
import { forgetSpawn, spawnInfo } from './shell-integration';
import { compilePattern, decideTabState, type HookPhase } from './tab-state';

/** The slice of PTYManager the runtime uses (a fake in the smoke test). */
export interface PtyHost {
  on(event: 'data', fn: (id: number, data: string) => void): unknown;
  on(event: 'exit', fn: (id: number, code: number) => void): unknown;
  get(id: number): { id: number; name: string; windowId: number | null; pty?: { process?: string } } | undefined;
  getAll(): Array<{ id: number; name: string; windowId: number | null }>;
  write(id: number, data: string): void;
  isClaudePty(id: number): boolean;
  isWarmPty(id: number): boolean;
  getAgentDefinition(provider: string, windowId?: number): unknown;
  getTUIDefinition(tuiType: string, windowId?: number): unknown;
  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, details?: Record<string, unknown>): void;
}

export const AGENT_TEXT_MAX = 4000;
/**
 * Whole create-tab round trip (IPC, PTY spawn, render, reply). Kept well above
 * the renderer's own 3 s ptyId wait: falling back after the renderer accepted
 * the request would open a second tab (a second agent with the same prompt).
 */
const CREATE_TAB_TIMEOUT_MS = 8000;
const FALLBACK_TIMEOUT_MS = 10_000;
const EXITED_KEEP_MS = 60_000;
const PASTE_ENTER_DELAY_MS = 30;
const TYPED_FEED_TTL_MS = 3_600_000;

interface RunningCommand {
  text: string;
  started_at: number;
  cwd: string | null;
  by: 'user' | 'lee';
}

interface PtyEntry {
  id: number;
  ring: OutputRing;
  osc: ShellOscParser;
  createdAt: number;
  integration: boolean;
  inCommand: boolean;
  cwd: string | null;
  pendingLine: string | null;
  command: RunningCommand | null;
  leeNext: boolean;
  /** When Lee typed the pending operation line, and the line itself (memory only). */
  leeSentAt: number | null;
  leeText: string | null;
  /** A prompt (133;A/B) or command-start (133;C) mark was seen: real shell integration. */
  sawMarks: boolean;
  lastCommand: TabLastCommand | null;
  hook: HookPhase | null;
  hookSeen: boolean;
  /** Approval/question items the agent is waiting on (from agent.waiting). */
  waitItems: Set<string>;
  sessionId: string | null;
  provider: string | null;
  taskId: string | null;
  state: TabRunState;
  source: TabStateSource;
  since: number;
  exitedAt: number | null;
  sig: string;
}

interface TabLocation {
  window_id: number;
  tab: TabContext;
  workspace: string | null;
}

/** Tab types and providers that are the user's own, never agents (user decision; see renderer cockpitModel.isWallExempt). */
const OWN_TAB_TYPES = new Set(['hester', 'hester-qa', 'devops']);
const OWN_PROVIDERS = new Set(['hester', 'devops']);

function isOwnTab(tab: Pick<TabContext, 'type' | 'provider'>): boolean {
  return OWN_TAB_TYPES.has(tab.type) || (!!tab.provider && OWN_PROVIDERS.has(tab.provider));
}

function isoNow(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

function isHuman(by: Principal): boolean {
  return by.kind === 'local-user' || by.kind === 'device';
}

export function actorFor(by: Principal): Actor {
  if (by.kind === 'device') return { kind: 'user', surface: 'device', device_id: by.device_id, device_kind: by.device_kind };
  if (by.kind === 'shared') return by.loopback ? { kind: 'hester' } : { kind: 'user', surface: 'device', device_id: `legacy:${by.ip}`, device_kind: 'legacy' };
  return { kind: 'user', surface: 'lee' };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** Relative to the workspace; null outside it (or unknown). */
export function relativeCwd(cwd: string | null, workspace: string | null): string | null {
  if (!cwd || !workspace) return null;
  const rel = path.relative(path.resolve(workspace), path.resolve(cwd));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel === '' ? '.' : rel;
}

export class TabRuntimeImpl extends EventEmitter implements TabRuntimeContract {
  private entries = new Map<number, PtyEntry>();
  private patterns = new Map<string, RegExp | null>();
  private pendingCreates = new Map<string, (res: CreateTabResult) => void>();
  /** Attention item id -> PTY, for the prompts an agent is waiting on. */
  private waitItemPty = new Map<string, number>();
  readonly history = new CommandHistory();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly host: PtyHost;
  private readonly now: () => number;

  constructor(host: PtyHost, opts: { now?: () => number } = {}) {
    super();
    this.setMaxListeners(50);
    this.host = host;
    this.now = opts.now ?? Date.now;
    host.on('data', (id: number, data: string) => this.onData(id, data));
    host.on('exit', (id: number, code: number) => this.onExit(id, code));
    copilotBus.on('event', (e: LeeEvent) => this.onCopilotEvent(e));
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  private entry(id: number): PtyEntry {
    let e = this.entries.get(id);
    if (!e) {
      const ws = this.workspaceOf(id);
      const kb = getCockpitConfig(ws).cockpit.tab.output_buffer_kb;
      const now = this.now();
      e = {
        id,
        ring: new OutputRing(Math.max(1, kb) * 1024),
        osc: new ShellOscParser(),
        createdAt: now,
        integration: false,
        inCommand: false,
        cwd: null,
        pendingLine: null,
        command: null,
        leeNext: false,
        leeSentAt: null,
        leeText: null,
        sawMarks: false,
        lastCommand: null,
        hook: null,
        hookSeen: false,
        waitItems: new Set(),
        sessionId: null,
        provider: null,
        taskId: null,
        state: 'unknown',
        source: 'quiet',
        since: now,
        exitedAt: null,
        sig: '',
      };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Feed PTY output (also used by the smoke test). */
  onData(id: number, data: string): void {
    const e = this.entry(id);
    const now = this.now();
    e.ring.append(data, now);
    let events: ShellOscEvent[] = [];
    try {
      events = e.osc.feed(data);
    } catch {
      events = [];
    }
    for (const ev of events) this.onOsc(e, ev, now);
  }

  private onOsc(e: PtyEntry, ev: ShellOscEvent, now: number): void {
    switch (ev.type) {
      case 'command-line':
        e.pendingLine = ev.text;
        break;
      case 'command-start': {
        // Lee's hooks always print 633;E before 133;C. A bare 133;C is some
        // other integration (the user's iTerm2/VS Code script, a remote host
        // over ssh): it must not start or overwrite a command.
        if (e.pendingLine == null) break;
        e.integration = true;
        e.sawMarks = true;
        e.inCommand = true;
        const text = e.pendingLine;
        e.pendingLine = null;
        e.command = { text, started_at: now, cwd: e.cwd, by: e.leeNext ? 'lee' : 'user' };
        this.clearLee(e);
        this.signal(e, 'start', null);
        this.refresh(e, now);
        break;
      }
      case 'command-end':
        // A lone 133;D is the end marker Lee appends to an operation line in
        // a shell without integration (ops-runtime buildRunLine). It ends
        // Lee's run but doesn't turn integration on: the tab state keeps
        // following the foreground process.
        if (e.sawMarks) e.integration = true;
        if (!e.command && e.leeNext) {
          e.command = { text: e.leeText ?? '', started_at: e.leeSentAt ?? now, cwd: e.cwd, by: 'lee' };
          this.clearLee(e);
        }
        this.endCommand(e, ev.exit_code, now);
        break;
      case 'prompt-start':
      case 'prompt-end':
        e.integration = true;
        e.sawMarks = true;
        if (e.command) this.endCommand(e, null, now);
        e.inCommand = false;
        this.refresh(e, now);
        break;
      case 'cwd':
        e.cwd = ev.path;
        break;
    }
  }

  private clearLee(e: PtyEntry): void {
    e.leeNext = false;
    e.leeSentAt = null;
    e.leeText = null;
  }

  /** The operation (package B) whose run is active in this PTY, for terminal.command `op`. */
  private runningOp(ws: string | null, ptyId: number): string | null {
    if (!ws) return null;
    try {
      return cockpitBus.ops?.snapshot(ws).operations.find((o) => o.running?.pty_id === ptyId)?.def.name ?? null;
    } catch {
      return null;
    }
  }

  private endCommand(e: PtyEntry, exitCode: number | null, now: number): void {
    e.inCommand = false;
    const cmd = e.command;
    e.command = null;
    if (!cmd) {
      this.refresh(e, now);
      return;
    }
    const ws = this.workspaceOf(e.id);
    const loc = this.locate(e.id);
    const sig = commandSig(cmd.text);
    const argv0 = commandArgv0(cmd.text);
    const duration = Math.max(0, now - cmd.started_at);
    e.lastCommand = { sig, argv0, text: cmd.text, exit_code: exitCode, at: isoNow(now) };
    this.history.append(ws, {
      ts: isoNow(now),
      sig,
      text: cmd.text,
      cwd: cmd.cwd,
      pty_id: e.id,
      exit_code: exitCode,
      by: cmd.by,
    });
    logCockpitEvent('terminal.command', {
      workspace: ws,
      window_id: loc?.window_id ?? this.host.get(e.id)?.windowId ?? null,
      actor: cmd.by === 'lee' ? { kind: 'system' } : { kind: 'user', surface: 'lee' },
      data: {
        pty_id: e.id,
        ...(loc ? { tab_id: loc.tab.id } : {}),
        sig,
        argv0,
        by: cmd.by,
        op: this.runningOp(ws, e.id),
        exit_code: exitCode,
        started_at: isoNow(cmd.started_at),
        duration_ms: duration,
        cwd_rel: relativeCwd(cmd.cwd, ws),
      },
    });
    this.signal(e, 'end', { ...cmd, exit_code: exitCode, duration });
    this.refresh(e, now);
  }

  private signal(
    e: PtyEntry,
    phase: 'start' | 'end',
    ended: (RunningCommand & { exit_code: number | null; duration: number }) | null,
  ): void {
    const cmd = ended ?? e.command;
    if (!cmd) return;
    cockpitBus.emitTerminal({
      pty_id: e.id,
      workspace: this.workspaceOf(e.id),
      phase,
      sig: commandSig(cmd.text),
      argv0: commandArgv0(cmd.text),
      text: cmd.text,
      cwd: cmd.cwd,
      by: cmd.by,
      exit_code: ended ? ended.exit_code : null,
      started_at: isoNow(cmd.started_at),
      duration_ms: ended ? ended.duration : null,
    });
  }

  private onExit(id: number, _code: number): void {
    const e = this.entries.get(id);
    const now = this.now();
    if (e) {
      if (e.command) this.endCommand(e, null, now);
      e.exitedAt = now;
      e.hook = null;
      this.clearWaits(e);
      this.refresh(e, now);
    }
    forgetSpawn(id);
    const t = setTimeout(() => {
      const cur = this.entries.get(id);
      if (cur && cur.exitedAt != null) this.entries.delete(id);
      this.emit('change');
    }, EXITED_KEEP_MS);
    t.unref?.();
  }

  private clearWaits(e: PtyEntry): void {
    for (const id of e.waitItems) this.waitItemPty.delete(id);
    e.waitItems.clear();
  }

  /**
   * A prompt the agent waited on was answered (queue reply, in the tab, or
   * superseded): once none is left the agent is working again, not waiting
   * on you. A deny (Esc) interrupts the turn, so the agent is back at input.
   */
  private onAttentionEvent(ev: LeeEvent): void {
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const itemId = typeof data.item_id === 'string' ? data.item_id : null;
    if (!itemId) return;
    const ptyId = this.waitItemPty.get(itemId);
    if (ptyId == null) return;
    this.waitItemPty.delete(itemId);
    const e = this.entries.get(ptyId);
    if (!e) return;
    e.waitItems.delete(itemId);
    if (e.hook !== 'waiting') return;
    if (ev.type === 'attention.reply' && data.action === 'deny') {
      this.clearWaits(e);
      e.hook = 'turn_end';
    } else if (e.waitItems.size === 0) {
      e.hook = 'tool';
    } else {
      return;
    }
    this.refresh(e, this.now());
  }

  private onCopilotEvent(ev: LeeEvent): void {
    const t = ev.type as string;
    if (t === 'attention.reply' || t === 'attention.resolve' || t === 'attention.dismiss') {
      this.onAttentionEvent(ev);
      return;
    }
    if (!ev.type.startsWith('agent.')) return;
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const ptyId = typeof data.pty_id === 'number' ? data.pty_id : null;
    if (ptyId == null) return;
    if (!this.entries.has(ptyId) && !this.host.get(ptyId)) return;
    const e = this.entry(ptyId);
    const prev = e.hook;
    switch (ev.type) {
      case 'agent.session_start':
        e.hook = 'session_start';
        e.hookSeen = true;
        if (typeof data.session_id === 'string') e.sessionId = data.session_id;
        if (typeof data.provider === 'string') e.provider = data.provider;
        this.emit('session', ptyId, e.sessionId);
        break;
      case 'agent.prompt':
      case 'agent.tool':
        e.hook = ev.type === 'agent.prompt' ? 'prompt' : 'tool';
        e.hookSeen = true;
        break;
      case 'agent.waiting':
        // A plain "waiting" notice after a finished turn: the agent is at its input.
        if (data.kind === 'waiting' && (prev === 'turn_end' || prev === 'session_start')) break;
        e.hook = 'waiting';
        e.hookSeen = true;
        if ((data.kind === 'approval' || data.kind === 'question') && typeof data.item_id === 'string') {
          e.waitItems.add(data.item_id);
          this.waitItemPty.set(data.item_id, ptyId);
        }
        break;
      case 'agent.turn_end':
        e.hook = 'turn_end';
        e.hookSeen = true;
        this.clearWaits(e);
        break;
      case 'agent.session_end':
      case 'agent.exit':
        e.hook = null;
        this.clearWaits(e);
        break;
      default:
        return;
    }
    if (typeof data.session_id === 'string' && !e.sessionId) e.sessionId = data.session_id;
    this.refresh(e, this.now());
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  locate(ptyId: number): TabLocation | null {
    for (const [windowId, ws] of windowRegistry.getAll()) {
      let ctx;
      try {
        ctx = ws.contextBridge.getContext();
      } catch {
        continue;
      }
      const tab = ctx?.tabs?.find((t: TabContext) => t.ptyId === ptyId);
      if (tab) return { window_id: windowId, tab, workspace: ws.workspace ?? ctx.workspace ?? null };
    }
    return null;
  }

  workspaceOf(ptyId: number): string | null {
    const loc = this.locate(ptyId);
    if (loc) return loc.workspace;
    const win = this.host.get(ptyId)?.windowId;
    return win != null ? windowRegistry.get(win)?.workspace ?? null : null;
  }

  windowOf(ptyId: number): number | null {
    return this.locate(ptyId)?.window_id ?? this.host.get(ptyId)?.windowId ?? null;
  }

  labelOf(ptyId: number): string {
    return this.locate(ptyId)?.tab.label ?? this.host.get(ptyId)?.name ?? `PTY ${ptyId}`;
  }

  sessionOf(ptyId: number): string | null {
    return this.entries.get(ptyId)?.sessionId ?? null;
  }

  taskOf(ptyId: number): string | null {
    return this.entries.get(ptyId)?.taskId ?? null;
  }

  /** True once agent hook events were seen for this PTY (or it was spawned hooked). */
  hasHooks(ptyId: number): boolean {
    return this.host.isClaudePty(ptyId) || !!this.entries.get(ptyId)?.hookSeen;
  }

  setTask(ptyId: number, taskId: string, sessionId: string | null): void {
    const e = this.entry(ptyId);
    e.taskId = taskId;
    if (sessionId) e.sessionId = sessionId;
    this.emit('change');
  }

  kindOf(ptyId: number, loc: TabLocation | null = this.locate(ptyId)): TabKind {
    const proc = this.host.get(ptyId);
    // Hester chat and DevOps are the user's own tabs (never walled, never
    // agents), matching the renderer's isWallExempt().
    if (loc && isOwnTab(loc.tab)) return proc ? 'tui' : 'other';
    if (this.host.isClaudePty(ptyId) || loc?.tab.type === 'agent' || !!loc?.tab.provider || this.entries.get(ptyId)?.hookSeen) {
      return 'agent';
    }
    if (spawnInfo(ptyId)?.default_shell) return 'shell';
    if (proc) return 'tui';
    return 'other';
  }

  private providerOf(ptyId: number, loc: TabLocation | null): string | null {
    const proc = this.host.get(ptyId) as { claude?: boolean; pi?: boolean } | undefined;
    return loc?.tab.provider ?? this.entries.get(ptyId)?.provider ?? (proc?.claude ? 'claude' : proc?.pi ? 'pi' : null);
  }

  private pattern(src: unknown): RegExp | null {
    if (typeof src !== 'string' || !src) return null;
    if (!this.patterns.has(src)) this.patterns.set(src, compilePattern(src));
    return this.patterns.get(src) ?? null;
  }

  private patternsFor(ptyId: number, kind: TabKind, loc: TabLocation | null): { prompt: RegExp | null; awaiting: RegExp | null } {
    const none = { prompt: null, awaiting: null };
    const windowId = loc?.window_id ?? this.host.get(ptyId)?.windowId ?? undefined;
    let def: unknown = null;
    try {
      if (kind === 'agent') {
        const provider = this.providerOf(ptyId, loc);
        if (provider) def = this.host.getAgentDefinition(provider, windowId ?? undefined);
      } else if (kind === 'tui' && loc?.tab.type) {
        def = this.host.getTUIDefinition(loc.tab.type, windowId ?? undefined);
      }
    } catch {
      def = null;
    }
    if (!def || typeof def !== 'object') return none;
    const d = def as Record<string, unknown>;
    return { prompt: this.pattern(d.prompt_pattern), awaiting: this.pattern(d.awaiting_pattern) };
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private compute(e: PtyEntry, now: number): { state: TabRunState; source: TabStateSource } {
    const proc = this.host.get(e.id);
    const exists = !!proc && e.exitedAt == null;
    const loc = exists ? this.locate(e.id) : null;
    const kind = exists ? this.kindOf(e.id, loc) : 'other';
    const pats = exists && (kind === 'agent' || kind === 'tui') ? this.patternsFor(e.id, kind, loc) : { prompt: null, awaiting: null };
    const quietThreshold = getCockpitConfig(loc?.workspace ?? null).cockpit.tab.quiet_ms;
    const last = e.ring.lastAppendAt || e.createdAt;
    const info = spawnInfo(e.id);
    let foreground: string | null = null;
    try {
      foreground = proc?.pty?.process ?? null;
    } catch {
      foreground = null;
    }
    return decideTabState({
      exists,
      kind,
      hook: e.hook,
      integration: e.integration,
      inCommand: e.inCommand,
      lastLines: pats.prompt || pats.awaiting ? e.ring.tailLines(5) : [],
      promptPattern: pats.prompt,
      awaitingPattern: pats.awaiting,
      quietMs: now - last,
      quietThreshold,
      foreground,
      shellName: info?.default_shell ? info.shell : null,
    });
  }

  private refresh(e: PtyEntry, now: number): void {
    const d = this.compute(e, now);
    if (d.state !== e.state) {
      e.state = d.state;
      e.since = now;
    }
    e.source = d.source;
    const sig = `${e.state}|${this.labelOf(e.id)}|${e.lastCommand?.at ?? ''}|${e.cwd ?? ''}|${e.taskId ?? ''}`;
    if (sig !== e.sig) {
      e.sig = sig;
      this.emit('change');
    }
  }

  /** Recompute every PTY's state (1 s timer). */
  tick(): void {
    const now = this.now();
    for (const p of this.host.getAll()) this.entry(p.id);
    for (const e of this.entries.values()) this.refresh(e, now);
  }

  state(ptyId: number): TabStateInfo {
    const now = this.now();
    // Never create an entry (and its ring) for an id no PTY ever had.
    if (!this.entries.has(ptyId) && !this.host.get(ptyId)) {
      return { pty_id: ptyId, state: 'exited', source: 'none', since: isoNow(now), quiet_ms: 0, foreground: null };
    }
    const e = this.entry(ptyId);
    this.refresh(e, now);
    let foreground: string | null = null;
    try {
      foreground = this.host.get(ptyId)?.pty?.process ?? null;
    } catch {
      foreground = null;
    }
    return {
      pty_id: ptyId,
      state: e.state,
      source: e.source,
      since: isoNow(e.since),
      quiet_ms: Math.max(0, now - (e.ring.lastAppendAt || e.createdAt)),
      foreground,
    };
  }

  /** True when a PTY exists or recently exited and is still known. */
  exists(ptyId: number): boolean {
    return !!this.host.get(ptyId) || this.entries.has(ptyId);
  }

  get(ptyId: number, opts: { withText?: boolean } = {}): TabRuntimeInfo | null {
    const proc = this.host.get(ptyId);
    if (!proc && !this.entries.has(ptyId)) return null;
    const loc = this.locate(ptyId);
    const e = this.entry(ptyId);
    const kind = this.kindOf(ptyId, loc);
    const state = this.state(ptyId);
    const fidelity = kind === 'agent' ? (this.hasHooks(ptyId) ? 'structured' : 'screen') : 'activity';
    const last = e.lastCommand ? { ...e.lastCommand, text: opts.withText === false ? null : e.lastCommand.text } : null;
    const windowId = loc?.window_id ?? proc?.windowId ?? null;
    return {
      pty_id: ptyId,
      tab_id: loc?.tab.id ?? null,
      window_id: windowId,
      workspace: loc?.workspace ?? (windowId != null ? windowRegistry.get(windowId)?.workspace ?? null : null),
      label: loc?.tab.label ?? proc?.name ?? `PTY ${ptyId}`,
      tab_type: loc?.tab.type ?? null,
      kind,
      provider: this.providerOf(ptyId, loc),
      fidelity,
      state,
      shell_integration: e.integration,
      cwd: e.cwd,
      last_command: last,
      operation: null,
      task_id: e.taskId,
      session_id: e.sessionId,
      tail: fidelity === 'screen' ? e.ring.tailLines(5) : [],
    };
  }

  /** Every PTY shown in a tab (or owned by a window), optionally for one workspace. */
  list(workspace?: string | null, opts: { withText?: boolean } = {}): TabRuntimeInfo[] {
    const ids = new Set<number>();
    for (const p of this.host.getAll()) {
      if (this.host.isWarmPty(p.id)) continue;
      if (p.windowId != null || this.locate(p.id)) ids.add(p.id);
    }
    for (const [id, e] of this.entries) if (e.exitedAt != null && this.locate(id)) ids.add(id);
    const out: TabRuntimeInfo[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      const info = this.get(id, opts);
      if (!info) continue;
      if (workspace && (!info.workspace || !samePath(info.workspace, workspace))) continue;
      out.push(info);
    }
    return out;
  }

  read(ptyId: number, req: TabReadRequest = {}): TabReadResult {
    const e = this.entries.get(ptyId);
    if (!e) return { pty_id: ptyId, text: '', cursor: 0, truncated: false, state: this.host.get(ptyId) ? 'unknown' : 'exited' };
    const r = e.ring.read(req);
    return { pty_id: ptyId, text: r.text, cursor: r.cursor, truncated: r.truncated, state: this.state(ptyId).state };
  }

  cursor(ptyId: number): number {
    return this.entries.get(ptyId)?.ring.cursor ?? 0;
  }

  /** Mark the PTY's next command as typed by Lee (an operation run). The text stays in memory only. */
  markLeeCommand(ptyId: number, text: string | null = null): void {
    const e = this.entry(ptyId);
    e.leeNext = true;
    e.leeSentAt = this.now();
    e.leeText = text;
  }

  commandText(workspace: string, sig: string): string | null {
    return this.history.lookup(workspace, sig);
  }

  // -------------------------------------------------------------------------
  // Input (C3, contract §5.3)
  // -------------------------------------------------------------------------

  /**
   * `opts.askedBy`: who asked Lee to type, when that differs from the
   * principal whose rights gate the input (Hester's operation runs are typed
   * by Lee as the local user, but the Feed must say Hester asked).
   */
  async send(ptyId: number, req: TabSendRequest, by: Principal, opts: { askedBy?: Principal } = {}): Promise<TabSendResult> {
    const purpose: TabInputPurpose = req?.purpose ?? 'manual';
    if (!this.host.get(ptyId)) return { success: false, error: 'not_found' };
    if (by.kind === 'shared') {
      // The shared token never types through the tab domain. The one
      // in-process exception is Lee's own operation typing (package B), which
      // runs a defined, confirmed operation Hester may run (§7.8).
      if (!(by.loopback && purpose === 'operation')) return { success: false, error: 'forbidden' };
    }
    const kind = this.kindOf(ptyId);
    if (kind === 'agent' && by.kind === 'shared') return { success: false, error: 'forbidden' };
    const raw = typeof req?.text === 'string' ? req.text : '';
    const st = this.state(ptyId).state;
    const human = isHuman(by);
    const gate = (): TabSendResult | null => {
      if (st === 'idle-at-prompt') return null;
      if (st === 'exited') return { success: false, error: 'not_found', state: st };
      if (st === 'busy') return { success: false, error: 'busy', state: st };
      if (st === 'awaiting-input') return { success: false, error: 'awaiting_input', state: st };
      if (req.force && by.kind === 'local-user') return null;
      return { success: false, error: 'state_unknown', state: st };
    };

    let payload: string;
    let enter = false;
    let chars: number;
    if (kind === 'agent') {
      const text = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text.trim().length === 0 || text.length > AGENT_TEXT_MAX) return { success: false, error: 'invalid', state: st };
      const blocked = gate();
      if (blocked) return blocked;
      payload = `\x1b[200~${text}\x1b[201~`;
      enter = !!req.submit;
      chars = text.length;
    } else {
      if (!raw || raw.length > AGENT_TEXT_MAX || /[\x00-\x08\x0a-\x1f\x7f]/.test(raw)) return { success: false, error: 'invalid', state: st };
      if (!(purpose === 'manual' && human)) {
        const blocked = gate();
        if (blocked) return blocked;
      } else if (st === 'exited') {
        return { success: false, error: 'not_found', state: st };
      }
      payload = raw + (req.submit ? '\r' : '');
      chars = raw.length;
      if (purpose === 'operation') this.markLeeCommand(ptyId, raw);
    }

    this.host.write(ptyId, payload);
    if (enter) {
      await new Promise((r) => setTimeout(r, PASTE_ENTER_DELAY_MS));
      this.host.write(ptyId, '\r');
    }

    const loc = this.locate(ptyId);
    const ws = loc?.workspace ?? this.workspaceOf(ptyId);
    logCockpitEvent('tab.input', {
      workspace: ws,
      window_id: loc?.window_id ?? this.host.get(ptyId)?.windowId ?? null,
      actor: purpose === 'operation' ? { kind: 'system' } : actorFor(by),
      data: {
        pty_id: ptyId,
        ...(loc ? { tab_id: loc.tab.id } : {}),
        target_kind: kind === 'agent' ? 'agent' : kind === 'shell' ? 'shell' : 'tui',
        purpose,
        chars,
        submit: !!req.submit,
      },
    });
    if (purpose === 'checkin' || purpose === 'operation') {
      const asker = opts.askedBy ?? by;
      const who = asker.kind === 'device' ? `your ${asker.device_kind} (${asker.name})` : asker.kind === 'shared' ? 'Hester' : 'you';
      cockpitBus.feed.post({
        workspace: ws,
        kind: 'event',
        severity: 'ambient',
        producer: purpose === 'checkin' ? 'checkin' : 'tabs',
        title: `Lee typed into ${this.labelOf(ptyId)} (asked by ${who})`,
        text: purpose === 'checkin' ? raw : payload.replace(/\r$/, ''),
        ref: { pty_id: ptyId },
        ttl_ms: TYPED_FEED_TTL_MS,
      });
    }
    return { success: true, state: st, chars };
  }

  // -------------------------------------------------------------------------
  // Create-tab bridge (contract §5.6 step 5, §3.8)
  // -------------------------------------------------------------------------

  /** Window for a workspace: the requested one if it shows that workspace, else the focused one, else any. */
  pickWindow(workspace: string, windowId?: number | null): number | null {
    const matches = (id: number) => {
      const w = windowRegistry.get(id);
      return !!w && !!w.workspace && samePath(w.workspace, workspace) && !w.browserWindow.isDestroyed?.();
    };
    if (windowId != null && matches(windowId)) return windowId;
    const focused = windowRegistry.getFocused();
    if (focused && matches(focused.browserWindow.id)) return focused.browserWindow.id;
    for (const [id] of windowRegistry.getAll()) if (matches(id)) return id;
    return null;
  }

  resolveCreateTab(res: CreateTabResult): void {
    if (!res || typeof res.request_id !== 'string') return;
    const fn = this.pendingCreates.get(res.request_id);
    if (fn) fn(res);
  }

  private waitForResult(requestId: string, timeoutMs: number): Promise<CreateTabResult | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingCreates.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pendingCreates.set(requestId, (res) => {
        clearTimeout(t);
        this.pendingCreates.delete(requestId);
        resolve(res);
      });
    });
  }

  async openTab(
    opts: {
      workspace: string;
      window_id?: number | null;
      type: 'terminal' | 'agent';
      label: string;
      command?: string;
      args?: string[];
      provider?: string;
      activate?: boolean;
    },
    extra: { session_id?: string | null; timeouts?: { result?: number; fallback?: number } } = {},
  ): Promise<{ pty_id: number | null; tab_id: number | null; error?: string }> {
    const windowId = this.pickWindow(opts.workspace, opts.window_id);
    if (windowId == null) return { pty_id: null, tab_id: null, error: 'no_window' };
    const win = windowRegistry.get(windowId);
    if (!win) return { pty_id: null, tab_id: null, error: 'no_window' };
    const maxBefore = Math.max(0, ...this.host.getAll().map((p) => p.id));
    const request: CreateTabRequest = {
      request_id: crypto.randomUUID(),
      type: opts.type,
      label: opts.label,
      ...(opts.command ? { command: opts.command, args: opts.args ?? [] } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      activate: !!opts.activate,
    };
    const pending = this.waitForResult(request.request_id, extra.timeouts?.result ?? CREATE_TAB_TIMEOUT_MS);
    try {
      win.browserWindow.webContents.send(COCKPIT_IPC.createTab, request);
    } catch {
      // fall back below
    }
    const res = await pending;
    if (res && (res.pty_id != null || res.error)) {
      return { pty_id: res.pty_id ?? null, tab_id: res.tab_id ?? null, ...(res.error ? { error: res.error } : {}) };
    }
    const sessionId = extra.session_id ?? null;
    // The renderer may have opened the tab without answering in time: never
    // open a second one (a second agent with the same prompt and session id).
    const already = this.findFresh(maxBefore, windowId, opts, sessionId);
    if (already != null) return { pty_id: already, tab_id: this.locate(already)?.tab.id ?? null };

    // Fallback: the v0 create-tab channel, then find the PTY it spawned.
    try {
      win.browserWindow.webContents.send(
        'system:create-tab',
        opts.type === 'agent'
          ? { type: 'agent', label: opts.provider ?? opts.label }
          : { type: 'terminal', label: opts.label, ...(opts.command ? { command: opts.command, args: opts.args ?? [] } : {}) },
      );
    } catch {
      return { pty_id: null, tab_id: null, error: 'window_unavailable' };
    }
    const deadline = this.now() + (extra.timeouts?.fallback ?? FALLBACK_TIMEOUT_MS);
    while (this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const found = this.findFresh(maxBefore, windowId, opts, sessionId);
      if (found != null) return { pty_id: found, tab_id: this.locate(found)?.tab.id ?? null };
    }
    return { pty_id: null, tab_id: null, error: 'timeout' };
  }

  /** A PTY spawned after `maxBefore` that matches this create request, else null. */
  private findFresh(maxBefore: number, windowId: number, opts: { label: string; type: 'terminal' | 'agent' }, sessionId: string | null): number | null {
    let found: number | null = null;
    if (sessionId) {
      for (const [id, e] of this.entries) if (e.sessionId === sessionId && id > maxBefore) found = id;
    }
    if (found == null) {
      const fresh = this.host.getAll().filter((p) => p.id > maxBefore && (p.windowId == null || p.windowId === windowId));
      const byName = fresh.find((p) => p.name === opts.label);
      const byAgent = opts.type === 'agent' ? fresh.find((p) => this.host.isClaudePty(p.id)) : undefined;
      found = byName?.id ?? byAgent?.id ?? null;
    }
    return found;
  }
}
