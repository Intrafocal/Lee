/**
 * Operations runtime (package B): the merged operation set per workspace,
 * suggestions, runs typed into terminal tabs, linking hand-typed commands,
 * status and health probes, proposals, and state persistence.
 *
 * Electron-free: everything outside the cockpit bus comes in through
 * OpsRuntimeDeps, so the smoke test drives it with plain node.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.1–§7.5, §7.8.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { Actor, Principal } from '../../shared/copilot';
import type {
  OpRunRequest,
  OpRunResult,
  OperationDef,
  OperationInfo,
  OperationProposal,
  OperationReading,
  OperationRun,
  OperationStatus,
  OperationSuggestion,
  OperationsSnapshot,
  RunBy,
} from '../../shared/cockpit';
import { logEvent } from '../copilot/bus';
import { cockpitBus, logCockpitEvent } from './cockpit-bus';
import type { TerminalCommandSignal } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import {
  commandArgv0,
  commandMatchesOperation,
  mergeOperations,
  shellQuote,
  substituteParams,
  validateOperation,
} from './ops-config';
import type { MergedOperation } from './ops-config';
import { detectFingerprint, detectOperations } from './ops-detect';
import type { ToolEnv } from './ops-detect';
import {
  addDismissedSuggestion,
  appendOperations,
  readConfigOperations,
  readOperationsFile,
  setOperationFlag,
  sourcesStamp,
  upsertOperation,
} from './ops-file';
import { parseReadings, readingLabel } from './ops-produces';

export const RUNS_KEPT = 20;
export const LOG_MAX = 256 * 1024;
export const PROPOSAL_TTL_MS = 30 * 60_000;
const OPEN_TAB_WAIT_MS = 10_000;
const PROBE_MS = 15_000;
const DETECT_RECHECK_MS = 5_000;
const HEALTH_FAILS = 3;
const PASSED_EVENT_TTL_MS = 60 * 60_000;
const METRIC_TTL_MS = 24 * 60 * 60_000;
export const LOG_TAIL_LINES = 200;

export type HealthResult = 'ok' | 'bad' | 'fail';

export interface OpsRuntimeDeps {
  /** Workspaces of open windows. Commands only run there. */
  workspaces: () => string[];
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
  /** status:push to every window. */
  pushStatus?: (type: 'success' | 'error', message: string) => void;
  /** A workspace's snapshot changed (debounced by the caller). */
  onChange?: (workspace: string) => void;
  /** Stop a run: raw write into the PTY. */
  writePty?: (ptyId: number, data: string) => void;
  toolEnv?: (workspace: string) => ToolEnv;
  inputsSig?: (cwd: string) => Promise<string | null>;
  probePort?: (port: number) => Promise<boolean>;
  probeHealth?: (url: string) => Promise<HealthResult>;
  home?: string;
  now?: () => number;
  pollMs?: number;
}

interface ActiveRun {
  run: OperationRun;
  def: OperationDef;
  workspace: string;
  pty: number;
  startCursor: number;
  handTyped: boolean;
  timer: NodeJS.Timeout | null;
  /** A hand-typed run's inputs signature while git still computes it (operation.result waits for it). */
  sigPending: Promise<unknown> | null;
}

interface StoredProposal extends OperationProposal {
  params: Record<string, string>;
  /** The adhoc/defined command as resolved when proposed. */
  line: string;
  /** Who proposed it (for a fresh proposal when the definition changed). */
  proposer: Principal;
  proposedBy: 'hester' | 'lint';
}

interface WsState {
  workspace: string;
  wsid: string;
  stamp: string | null;
  merged: MergedOperation[];
  dismissed: Set<string>;
  detected: OperationSuggestion[];
  fingerprint: string | null;
  detectCheckedAt: number;
  extra: OperationSuggestion[];
  announced: Set<string>;
  runs: Record<string, OperationRun[]>;
  links: Map<string, number>;
  lrEnd: Map<string, OperationStatus>;
  health: Map<string, { fails: number; bad: boolean }>;
  portOpen: Map<string, boolean>;
  lastStatus: Map<string, OperationStatus>;
  proposals: Map<string, StoredProposal>;
}

export function wsidFor(workspace: string): string {
  return crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12);
}

export function actorFor(p: Principal): Actor {
  if (p.kind === 'device') return { kind: 'user', surface: 'device', device_id: p.device_id, device_kind: p.device_kind };
  if (p.kind === 'shared') return { kind: 'hester' };
  return { kind: 'user', surface: 'lee' };
}

export function runByFor(p: Principal): RunBy {
  return p.kind === 'device' ? 'device' : p.kind === 'shared' ? 'hester' : 'user';
}

export function runStatusFor(exitCode: number | null): OperationRun['status'] {
  if (exitCode == null) return 'unknown';
  if (exitCode === 0) return 'passed';
  if (exitCode === 130 || exitCode === 143) return 'stopped';
  return 'failed';
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** First 12 hex of sha1(HEAD + porcelain status) in `cwd`; null outside git or after 2 s. */
export function gitInputsSig(cwd: string): Promise<string | null> {
  const git = (args: string[]) =>
    new Promise<string | null>((resolve) => {
      execFile('git', args, { cwd, timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    });
  return Promise.all([git(['rev-parse', 'HEAD']), git(['status', '--porcelain=v1', '-uno'])]).then(([head, status]) =>
    head == null ? null : crypto.createHash('sha1').update(head.trim() + (status ?? '')).digest('hex').slice(0, 12),
  );
}

export function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

export function probeLocalHealth(url: string): Promise<HealthResult> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      resolve(code >= 200 && code < 300 ? 'ok' : 'bad');
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve('fail'));
  });
}

function defaultToolEnv(workspace: string, home: string): ToolEnv {
  return {
    home,
    path: process.env.PATH ?? '',
    idfPath: process.env.IDF_PATH ?? null,
    toolPaths: getCockpitConfig(workspace).cockpit.detect.tool_paths,
  };
}

/** The line typed into the tab (§7.3 step 4). */
export function buildRunLine(opts: {
  command: string;
  cwd: string;
  tabCwd: string | null;
  env?: Record<string, string>;
  shellIntegration: boolean;
}): string {
  const env = Object.entries(opts.env ?? {});
  let line = env.length ? `(export ${env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ')}; ${opts.command})` : opts.command;
  if (!opts.tabCwd || path.resolve(opts.tabCwd) !== path.resolve(opts.cwd)) line = `cd ${shellQuote(opts.cwd)} && ${line}`;
  if (!opts.shellIntegration) line += `; printf '\\033]133;D;%s\\007' "$?"`;
  return line;
}

type Resolved =
  | { ok: true; def: OperationDef; command: string; cwd: string; adhoc: boolean; merged: MergedOperation | null }
  | { ok: false; result: OpRunResult; status: number };

export class OpsRuntime {
  private states = new Map<string, WsState>();
  private active = new Map<number, ActiveRun>();
  private probeTimer: NodeJS.Timeout | null = null;
  private persistTimers = new Map<string, NodeJS.Timeout>();
  private unsubTerminal: (() => void) | null = null;
  private readonly home: string;
  private readonly now: () => number;

  constructor(private readonly deps: OpsRuntimeDeps) {
    this.home = deps.home ?? os.homedir();
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.unsubTerminal = cockpitBus.onTerminal((s) => this.onTerminal(s));
    this.probeTimer = setInterval(() => void this.probeAll(), PROBE_MS);
    this.probeTimer.unref?.();
  }

  stop(): void {
    this.unsubTerminal?.();
    this.unsubTerminal = null;
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    for (const a of this.active.values()) if (a.timer) clearTimeout(a.timer);
    for (const [ws, t] of this.persistTimers) {
      clearTimeout(t);
      this.persistNow(ws);
    }
    this.persistTimers.clear();
  }

  // -------------------------------------------------------------------------
  // Workspace state
  // -------------------------------------------------------------------------

  private log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>): void {
    this.deps.log?.(level, message, details);
  }

  opsDir(workspace: string): string {
    return path.join(this.home, '.lee', 'ops', wsidFor(workspace));
  }

  logPath(workspace: string, name: string): string {
    return path.join(this.opsDir(workspace), `${safeFileName(name)}.last.log`);
  }

  private state(workspace: string): WsState {
    let s = this.states.get(workspace);
    if (!s) {
      s = {
        workspace,
        wsid: wsidFor(workspace),
        stamp: null,
        merged: [],
        dismissed: new Set(),
        detected: [],
        fingerprint: null,
        detectCheckedAt: 0,
        extra: [],
        announced: new Set(),
        runs: {},
        links: new Map(),
        lrEnd: new Map(),
        health: new Map(),
        portOpen: new Map(),
        lastStatus: new Map(),
        proposals: new Map(),
      };
      this.loadState(s);
      this.states.set(workspace, s);
    }
    this.refresh(s);
    return s;
  }

  private loadState(s: WsState): void {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(this.opsDir(s.workspace), 'state.json'), 'utf8'));
      if (doc && typeof doc.runs === 'object' && doc.runs) {
        for (const [op, runs] of Object.entries(doc.runs as Record<string, unknown>)) {
          if (Array.isArray(runs)) s.runs[op] = (runs as OperationRun[]).filter((r) => r && typeof r.run_id === 'string').slice(-RUNS_KEPT);
        }
      }
      if (Array.isArray(doc?.dismissed)) for (const n of doc.dismissed) if (typeof n === 'string') s.dismissed.add(n);
      if (Array.isArray(doc?.extra_suggestions)) {
        for (const sug of doc.extra_suggestions as OperationSuggestion[]) {
          const def = validateOperation(sug?.def, []);
          if (def) s.extra.push({ def, detected_from: String(sug.detected_from ?? 'lee') });
        }
      }
    } catch {
      // first run for this workspace
    }
  }

  private persist(workspace: string): void {
    if (this.persistTimers.has(workspace)) return;
    const t = setTimeout(() => {
      this.persistTimers.delete(workspace);
      this.persistNow(workspace);
    }, 500);
    t.unref?.();
    this.persistTimers.set(workspace, t);
  }

  private persistNow(workspace: string): void {
    const s = this.states.get(workspace);
    if (!s) return;
    try {
      const dir = this.opsDir(workspace);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'state.json');
      const doc = { version: 1, workspace, runs: s.runs, dismissed: [...s.dismissed], extra_suggestions: s.extra };
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log('WARN', 'Cockpit ops: could not save state', { workspace, error: String(err) });
    }
  }

  private refresh(s: WsState): void {
    const stamp = sourcesStamp(s.workspace, this.home);
    if (stamp === s.stamp) return;
    s.stamp = stamp;
    const cfg = readConfigOperations(s.workspace, this.home);
    const file = readOperationsFile(s.workspace);
    for (const w of [...cfg.warnings, ...file.warnings]) this.log('WARN', `Cockpit ops: ${w}`, { workspace: s.workspace });
    s.merged = mergeOperations(cfg.config, file.defs, cfg.services);
    for (const n of file.dismissed) s.dismissed.add(n);
  }

  private find(s: WsState, name: string): MergedOperation | null {
    return s.merged.find((m) => m.def.name === name) ?? null;
  }

  absCwd(workspace: string, cwd: string | null | undefined): string {
    return cwd ? path.resolve(workspace, cwd) : workspace;
  }

  getOperation(workspace: string, name: string): MergedOperation | null {
    return this.find(this.state(workspace), name);
  }

  getRun(workspace: string, runId: string): OperationRun | null {
    const s = this.state(workspace);
    for (const a of this.active.values()) if (a.run.run_id === runId) return a.run;
    for (const runs of Object.values(s.runs)) {
      const r = runs.find((x) => x.run_id === runId);
      if (r) return r;
    }
    return null;
  }

  lastRun(workspace: string, name: string): OperationRun | null {
    const runs = this.state(workspace).runs[name];
    return runs && runs.length ? runs[runs.length - 1] : null;
  }

  /** Last `lines` lines of an operation's last log. */
  logTail(workspace: string, name: string, lines: number): string | null {
    try {
      const text = fs.readFileSync(this.logPath(workspace, name), 'utf8');
      return text.split('\n').slice(-lines).join('\n');
    } catch {
      return null;
    }
  }

  isOpenWorkspace(workspace: unknown): workspace is string {
    return typeof workspace === 'string' && this.deps.workspaces().includes(workspace);
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  private detect(s: WsState): void {
    if (!getCockpitConfig(s.workspace).cockpit.detect.enabled) {
      s.detected = [];
      return;
    }
    const now = this.now();
    if (s.fingerprint !== null && now - s.detectCheckedAt < DETECT_RECHECK_MS) return;
    s.detectCheckedAt = now;
    if (s.fingerprint !== null && detectFingerprint(s.workspace) === s.fingerprint) return;
    const env = this.deps.toolEnv ? this.deps.toolEnv(s.workspace) : defaultToolEnv(s.workspace, this.home);
    const res = detectOperations(s.workspace, env);
    s.detected = res.suggestions;
    s.fingerprint = res.fingerprint;
  }

  suggestions(workspace: string): OperationSuggestion[] {
    const s = this.state(workspace);
    this.detect(s);
    const defined = new Set(s.merged.map((m) => m.def.name));
    const seen = new Set<string>();
    const out: OperationSuggestion[] = [];
    for (const sug of [...s.extra, ...s.detected]) {
      const n = sug.def.name;
      if (defined.has(n) || s.dismissed.has(n) || seen.has(n)) continue;
      seen.add(n);
      out.push(sug);
    }
    const fresh = out.filter((sug) => !s.announced.has(sug.def.name));
    if (fresh.length) {
      for (const sug of fresh) s.announced.add(sug.def.name);
      logCockpitEvent('operation.suggested', {
        workspace,
        data: { count: fresh.length, sources: [...new Set(fresh.map((f) => f.detected_from))] },
      });
    }
    return out;
  }

  suggest(workspace: string, def: OperationDef, detectedFrom: string): void {
    const s = this.state(workspace);
    const valid = validateOperation(def, []);
    if (!valid) return;
    s.extra = s.extra.filter((e) => e.def.name !== valid.name);
    s.extra.push({ def: valid, detected_from: detectedFrom });
    s.dismissed.delete(valid.name);
    this.persist(workspace);
    this.changed(workspace);
  }

  confirm(workspace: string, names: string[], principal: Principal = { kind: 'local-user' }): { success: boolean; error?: string; added?: string[] } {
    if (!this.isOpenWorkspace(workspace)) return { success: false, error: 'unknown_workspace' };
    const sugs = this.suggestions(workspace);
    const chosen = sugs.filter((sg) => names.includes(sg.def.name));
    if (!chosen.length) return { success: false, error: 'no_suggestions' };
    let added: string[];
    try {
      added = appendOperations(workspace, chosen.map((c) => ({ def: c.def, detected_from: c.detected_from })));
    } catch (err) {
      return { success: false, error: `write_failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const s = this.state(workspace);
    s.extra = s.extra.filter((e) => !added.includes(e.def.name));
    this.persist(workspace);
    logCockpitEvent('operation.confirmed', { workspace, actor: actorFor(principal), data: { names: added, count: added.length } });
    logEvent({ type: 'ui.ceremony', workspace, actor: actorFor(principal), data: { action: 'confirm', target: 'operations' } });
    this.changed(workspace);
    return { success: true, added };
  }

  dismissSuggestion(workspace: string, name: string, principal: Principal = { kind: 'local-user' }): { success: boolean } {
    if (!this.isOpenWorkspace(workspace)) return { success: false };
    const s = this.state(workspace);
    s.dismissed.add(name);
    s.extra = s.extra.filter((e) => e.def.name !== name);
    try {
      addDismissedSuggestion(workspace, name);
    } catch (err) {
      this.log('WARN', 'Cockpit ops: could not write operations.yaml', { workspace, error: String(err) });
    }
    this.persist(workspace);
    logEvent({ type: 'ui.ceremony', workspace, actor: actorFor(principal), data: { action: 'dismiss', target: 'operations' } });
    this.changed(workspace);
    return { success: true };
  }

  save(workspace: string, raw: OperationDef): { success: boolean; error?: string } {
    if (!this.isOpenWorkspace(workspace)) return { success: false, error: 'unknown_workspace' };
    const warnings: string[] = [];
    const def = validateOperation(raw, warnings);
    if (!def) return { success: false, error: warnings[0] ?? 'invalid' };
    const existing = this.find(this.state(workspace), def.name);
    if (existing?.source === 'config') return { success: false, error: 'defined_in_config' };
    if (existing?.source === 'service') return { success: false, error: 'read_only' };
    try {
      upsertOperation(workspace, def);
    } catch (err) {
      return { success: false, error: `write_failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const s = this.state(workspace);
    s.extra = s.extra.filter((e) => e.def.name !== def.name);
    this.persist(workspace);
    this.changed(workspace);
    return { success: true };
  }

  async setFlag(workspace: string, name: string, flag: 'notify_on_done' | 'confirm', value: boolean): Promise<boolean> {
    try {
      const ok = setOperationFlag(workspace, name, flag, value);
      if (ok) this.changed(workspace);
      return ok;
    } catch {
      return false;
    }
  }

  linkTab(ptyId: number, workspace: string, name: string | null): { success: boolean; error?: string } {
    const s = this.state(workspace);
    for (const [op, pty] of s.links) if (pty === ptyId) s.links.delete(op);
    if (name !== null) {
      const m = this.find(s, name);
      if (!m) return { success: false, error: 'not_found' };
      s.links.set(name, ptyId);
    }
    this.changed(workspace);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Snapshot and status
  // -------------------------------------------------------------------------

  private activeFor(workspace: string, name: string): ActiveRun | null {
    for (const a of this.active.values()) if (a.workspace === workspace && a.def.name === name) return a;
    return null;
  }

  private linkedAlive(s: WsState, name: string): number | null {
    const pty = s.links.get(name);
    if (pty == null) return null;
    const rt = cockpitBus.tabRuntime;
    if (rt) {
      const info = rt.get(pty);
      if (!info || info.state.state === 'exited') return null;
    }
    return pty;
  }

  /** Status before the health check (running / idle / last end). */
  private baseStatus(s: WsState, m: MergedOperation): OperationStatus {
    const name = m.def.name;
    const act = this.activeFor(s.workspace, name);
    if (m.def.kind === 'oneshot') {
      if (act) return 'running';
      const last = s.runs[name]?.[s.runs[name].length - 1];
      return last ? last.status : 'idle';
    }
    if (m.service && m.service.detect !== 'port' && m.service.detect !== 'flutter') return 'idle';
    if (act) return 'running';
    if (this.linkedAlive(s, name) == null && s.portOpen.get(name)) return 'running';
    return s.lrEnd.get(name) ?? 'idle';
  }

  private statusOf(s: WsState, m: MergedOperation): OperationStatus {
    const base = this.baseStatus(s, m);
    if (base !== 'running' || m.def.kind !== 'long-running' || !m.def.health) return base;
    const h = s.health.get(m.def.name);
    return h && (h.bad || h.fails >= HEALTH_FAILS) ? 'unhealthy' : base;
  }

  private info(s: WsState, m: MergedOperation): OperationInfo {
    const runs = s.runs[m.def.name] ?? [];
    const act = this.activeFor(s.workspace, m.def.name);
    return {
      def: m.def,
      source: m.source,
      status: this.statusOf(s, m),
      last_run: runs.length ? runs[runs.length - 1] : null,
      running: act ? act.run : null,
      linked_pty_id: act?.pty ?? this.linkedAlive(s, m.def.name),
      service: m.service,
    };
  }

  proposals(workspace: string): OperationProposal[] {
    const s = this.state(workspace);
    const now = this.now();
    for (const [id, p] of s.proposals) if (Date.parse(p.expires_at) <= now) s.proposals.delete(id);
    return [...s.proposals.values()].map(({ params: _params, line: _line, proposer: _proposer, proposedBy: _proposedBy, ...p }) => p);
  }

  snapshot(workspace: string): OperationsSnapshot {
    const s = this.state(workspace);
    return {
      workspace,
      operations: s.merged.map((m) => this.info(s, m)),
      suggestions: this.suggestions(workspace),
      proposals: this.proposals(workspace),
      agent: { ...getCockpitConfig(workspace).operation_agent },
      generated_at: new Date(this.now()).toISOString(),
    };
  }

  /** Log long-running transitions; a crash is a blocking Feed failure plus a status push. */
  private checkTransitions(s: WsState): void {
    for (const m of s.merged) {
      if (m.def.kind !== 'long-running') continue;
      const to = this.statusOf(s, m);
      const from = s.lastStatus.get(m.def.name) ?? 'idle';
      if (to === from) continue;
      s.lastStatus.set(m.def.name, to);
      logCockpitEvent('operation.status', { workspace: s.workspace, data: { op: m.def.name, from, to } });
      if (to === 'crashed') {
        const last = s.runs[m.def.name]?.[s.runs[m.def.name].length - 1] ?? null;
        cockpitBus.feed.post({
          workspace: s.workspace,
          kind: 'failure',
          severity: 'blocking',
          producer: 'ops',
          title: `${m.def.name} crashed${last?.exit_code != null ? ` (exit ${last.exit_code})` : ''}`,
          item_ref: `op:${s.workspace}:${m.def.name}`,
          ref: { op: m.def.name, ...(last ? { run_id: last.run_id } : {}), ...(last?.pty_id != null ? { pty_id: last.pty_id } : {}) },
          actions: [
            { id: 'open-tab', label: 'Open tab', style: 'primary' },
            { id: 'fix-with-agent', label: 'Fix with agent' },
            { id: 'create-task', label: 'Create task' },
          ],
          pinned: true,
          dedupe_key: `ops:fail:${s.workspace}:${m.def.name}`,
        });
        this.deps.pushStatus?.('error', `Operation ${m.def.name} crashed`);
      }
    }
  }

  private changed(workspace: string): void {
    const s = this.states.get(workspace);
    if (s) this.checkTransitions(s);
    this.deps.onChange?.(workspace);
  }

  async probeAll(): Promise<void> {
    const open = new Set(this.deps.workspaces());
    for (const s of this.states.values()) {
      if (!open.has(s.workspace)) continue;
      this.refresh(s);
      const before = s.merged.map((m) => this.statusOf(s, m)).join('|');
      for (const m of s.merged) {
        if (m.def.kind !== 'long-running') continue;
        const name = m.def.name;
        if (m.def.ports?.length && !this.activeFor(s.workspace, name) && this.linkedAlive(s, name) == null) {
          const probe = this.deps.probePort ?? probeLocalPort;
          const results = await Promise.all(m.def.ports.map((p) => probe(p).catch(() => false)));
          s.portOpen.set(name, results.some(Boolean));
        } else {
          s.portOpen.delete(name);
        }
        if (m.def.health && this.baseStatus(s, m) === 'running') {
          const res = await (this.deps.probeHealth ?? probeLocalHealth)(m.def.health).catch((): HealthResult => 'fail');
          const h = s.health.get(name) ?? { fails: 0, bad: false };
          if (res === 'ok') s.health.set(name, { fails: 0, bad: false });
          else if (res === 'bad') s.health.set(name, { fails: 0, bad: true });
          else s.health.set(name, { fails: h.fails + 1, bad: false });
        } else {
          s.health.delete(name);
        }
      }
      if (s.merged.map((m) => this.statusOf(s, m)).join('|') !== before) this.changed(s.workspace);
    }
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  /** `strict`: param values from a caller other than the local user carry no shell metacharacters. */
  private resolve(req: OpRunRequest, opts: { strict?: boolean } = {}): Resolved {
    if (!this.isOpenWorkspace(req.workspace)) return { ok: false, status: 400, result: { success: false, error: 'unknown_workspace' } };
    const s = this.state(req.workspace);
    if (req.name) {
      const m = this.find(s, req.name);
      if (!m) return { ok: false, status: 404, result: { success: false, error: 'not_found' } };
      if (!m.runnable) return { ok: false, status: 400, result: { success: false, error: 'not_runnable' } };
      const sub = substituteParams(m.def.command, m.def.params, req.params, { strict: opts.strict });
      if (sub.missing.length) return { ok: false, status: 400, result: { success: false, error: 'missing_params', missing_params: sub.missing } };
      if (sub.invalid.length) return { ok: false, status: 400, result: { success: false, error: 'invalid_params' } };
      return { ok: true, def: m.def, command: sub.line, cwd: this.absCwd(req.workspace, m.def.cwd), adhoc: false, merged: m };
    }
    const command = typeof req.command === 'string' ? req.command.trim() : '';
    if (!command || /[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) return { ok: false, status: 400, result: { success: false, error: 'invalid' } };
    const cwd = this.absCwd(req.workspace, req.cwd ?? null);
    const rel = path.relative(req.workspace, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, status: 400, result: { success: false, error: 'cwd_outside_workspace' } };
    const argv0 = commandArgv0(command) || 'command';
    const def: OperationDef = { name: `adhoc:${path.basename(argv0)}`.slice(0, 64), kind: 'oneshot', command, cwd: rel || null };
    return { ok: true, def, command, cwd, adhoc: true, merged: null };
  }

  /**
   * Run for a principal (§7.3 steps 1–2, §7.8). Returns an HTTP-ish status for
   * the command domain; IPC callers use `result`.
   */
  async run(req: OpRunRequest, principal: Principal | undefined): Promise<{ status: number; result: OpRunResult }> {
    if (!principal || (principal.kind === 'shared' && !principal.loopback)) return { status: 403, result: { success: false, error: 'forbidden' } };
    const r = this.resolve(req, { strict: principal.kind === 'device' });
    if (!r.ok) return { status: r.status, result: r.result };
    // Hester's params are model output: a run with substituted values goes
    // through a proposal that shows the exact line (C3).
    if (!r.adhoc && principal.kind === 'shared' && r.command !== r.def.command) return this.proposeResolved(req, r, principal, null);
    if (r.adhoc) {
      if (principal.kind !== 'local-user') return this.proposeResolved(req, r, principal, null);
      if (req.confirmed !== true) return { status: 409, result: { success: false, error: 'needs_confirm', needs_confirm: true } };
    } else if (r.def.confirm) {
      if (principal.kind === 'shared') return this.proposeResolved(req, r, principal, null);
      if (req.confirmed !== true) return { status: 409, result: { success: false, error: 'needs_confirm', needs_confirm: true } };
      logEvent({ type: 'ui.ceremony', workspace: req.workspace, actor: actorFor(principal), data: { action: 'confirm', target: 'operation-confirm' } });
    }
    const result = await this.execute(req, r, principal);
    return { status: result.success ? 200 : errorStatus(result.error), result };
  }

  /** Hester (or a device) asks for a run it may not start itself. */
  async propose(req: OpRunRequest & { reason?: string | null }, principal: Principal | undefined, by: 'hester' | 'lint' = 'hester'): Promise<{ status: number; result: OpRunResult }> {
    if (!principal || (principal.kind === 'shared' && !principal.loopback)) return { status: 403, result: { success: false, error: 'forbidden' } };
    const r = this.resolve(req);
    if (!r.ok) return { status: r.status, result: r.result };
    return this.proposeResolved(req, r, principal, req.reason ?? null, by);
  }

  private proposeResolved(
    req: OpRunRequest,
    r: Extract<Resolved, { ok: true }>,
    principal: Principal,
    reason: string | null,
    by: 'hester' | 'lint' = 'hester',
  ): { status: number; result: OpRunResult } {
    const s = this.state(req.workspace);
    const now = this.now();
    const id = newId('prop');
    const who = principal.kind === 'device' ? principal.name : by === 'lint' ? 'Lint' : 'Hester';
    const proposalBy = (principal.kind === 'device' ? 'device' : by) as OperationProposal['by'];
    const line = buildRunLine({ command: r.command, cwd: r.cwd, tabCwd: null, env: r.def.env, shellIntegration: true });
    const linked = r.adhoc ? null : this.linkedAlive(s, r.def.name);
    const linkedLabel = linked != null ? cockpitBus.tabRuntime?.get(linked)?.label ?? null : null;
    const target = linkedLabel ? `in ${linkedLabel}` : 'in a new terminal tab';
    const proposal: StoredProposal = {
      id,
      workspace: req.workspace,
      op: r.adhoc ? null : r.def.name,
      command: r.command,
      cwd: r.def.cwd ?? null,
      by: proposalBy,
      reason,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PROPOSAL_TTL_MS).toISOString(),
      params: { ...(req.params ?? {}) },
      line,
      proposer: principal,
      proposedBy: by,
    };
    s.proposals.set(id, proposal);
    cockpitBus.feed.post({
      workspace: req.workspace,
      kind: 'proposal',
      severity: 'needs-you',
      producer: 'ops',
      title: r.adhoc ? `${who} proposes running a command` : `${who} proposes running ${r.def.name}`,
      text: `${target}${reason ? `: ${reason}` : ''}`,
      item_ref: r.adhoc ? null : `op:${req.workspace}:${r.def.name}`,
      ref: { proposal_id: id, ...(r.adhoc ? {} : { op: r.def.name }) },
      actions: [
        { id: 'approve', label: 'Run', style: 'primary', confirm_text: line },
        { id: 'reject', label: 'Reject', style: 'plain' },
      ],
      ttl_ms: PROPOSAL_TTL_MS,
      dedupe_key: `ops:proposal:${id}`,
    });
    logCockpitEvent('operation.proposal', {
      workspace: req.workspace,
      actor: actorFor(principal),
      data: { proposal_id: id, op: proposal.op, adhoc: r.adhoc, by: proposalBy },
    });
    this.changed(req.workspace);
    return { status: 202, result: { success: true, proposal_id: id } };
  }

  hasProposal(id: string): boolean {
    for (const s of this.states.values()) if (s.proposals.has(id)) return true;
    return false;
  }

  /** A human approved or rejected a proposal (Feed action). */
  async resolveProposal(id: string, approved: boolean, principal: Principal): Promise<OpRunResult> {
    let s: WsState | null = null;
    for (const st of this.states.values()) if (st.proposals.has(id)) s = st;
    const p = s?.proposals.get(id);
    if (!s || !p) return { success: false, error: 'not_found' };
    if (Date.parse(p.expires_at) <= this.now()) {
      s.proposals.delete(id);
      cockpitBus.feed.closeByKey(`ops:proposal:${id}`, 'expired');
      return { success: false, error: 'expired' };
    }
    let fresh: Extract<Resolved, { ok: true }> | null = null;
    let freshReq: OpRunRequest | null = null;
    if (approved) {
      // Run exactly what the human confirmed: re-resolve and compare with the
      // line shown. If the definition changed since (a hand edit, a git pull,
      // an agent), the old proposal can't be approved; a fresh one is posted.
      freshReq = p.op
        ? { workspace: s.workspace, name: p.op, params: p.params, confirmed: true }
        : { workspace: s.workspace, command: p.command, cwd: p.cwd, confirmed: true };
      const r = this.resolve(freshReq);
      if (!r.ok) {
        s.proposals.delete(id);
        cockpitBus.feed.closeByKey(`ops:proposal:${id}`, 'expired');
        this.changed(s.workspace);
        return r.result;
      }
      const line = buildRunLine({ command: r.command, cwd: r.cwd, tabCwd: null, env: r.def.env, shellIntegration: true });
      if (line !== p.line) {
        s.proposals.delete(id);
        cockpitBus.feed.closeByKey(`ops:proposal:${id}`, 'expired');
        const again = this.proposeResolved(freshReq, r, p.proposer, p.reason ?? null, p.proposedBy);
        return { success: false, error: 'changed', ...(again.result.proposal_id ? { proposal_id: again.result.proposal_id } : {}) };
      }
      fresh = r;
    }
    s.proposals.delete(id);
    logCockpitEvent('operation.proposal_resolved', {
      workspace: s.workspace,
      actor: actorFor(principal),
      data: { proposal_id: id, approved, latency_ms: this.now() - Date.parse(p.created_at) },
    });
    logEvent({ type: 'ui.ceremony', workspace: s.workspace, actor: actorFor(principal), data: { action: approved ? 'confirm' : 'dismiss', target: 'proposal' } });
    cockpitBus.feed.closeByKey(`ops:proposal:${id}`, approved ? 'done' : 'dismissed');
    if (!approved) {
      this.changed(s.workspace);
      return { success: true };
    }
    return this.execute(freshReq!, fresh!, principal.kind === 'device' ? principal : { kind: 'local-user' });
  }

  private async pickTab(
    req: OpRunRequest,
    r: Extract<Resolved, { ok: true }>,
  ): Promise<{ pty: number; reused: boolean } | { error: string }> {
    const rt = cockpitBus.tabRuntime;
    if (!rt) return { error: 'tab_runtime_unavailable' };
    if (req.pty_id != null) {
      const info = rt.get(req.pty_id);
      if (!info) return { error: 'not_found' };
      if (info.kind !== 'shell') return { error: 'not_shell' };
      const st = rt.state(req.pty_id).state;
      if (st !== 'idle-at-prompt') return { error: stateError(st) };
      return { pty: req.pty_id, reused: true };
    }
    if (!r.adhoc) {
      const linked = this.linkedAlive(this.state(req.workspace), r.def.name);
      if (linked != null && !this.active.has(linked)) {
        const info = rt.get(linked);
        if (info && info.kind === 'shell' && rt.state(linked).state === 'idle-at-prompt') return { pty: linked, reused: true };
      }
    }
    // Never the command text: labels reach lee.log (PTY name) and saved sessions.
    const label = `▶ ${r.def.name}`;
    const opened = await rt.openTab({ workspace: req.workspace, type: 'terminal', label, activate: false });
    if (opened.pty_id == null) return { error: opened.error ?? 'open_tab_failed' };
    const deadline = this.now() + OPEN_TAB_WAIT_MS;
    const poll = this.deps.pollMs ?? 200;
    for (;;) {
      if (rt.state(opened.pty_id).state === 'idle-at-prompt') return { pty: opened.pty_id, reused: false };
      if (this.now() >= deadline) return { error: 'tab_not_ready' };
      await new Promise((res) => setTimeout(res, poll));
    }
  }

  /** §7.3 steps 3–5 after the principal rules passed. */
  private async execute(req: OpRunRequest, r: Extract<Resolved, { ok: true }>, principal: Principal): Promise<OpRunResult> {
    const rt = cockpitBus.tabRuntime;
    if (!rt) return { success: false, error: 'tab_runtime_unavailable' };
    if (!r.adhoc && this.activeFor(req.workspace, r.def.name)) return { success: false, error: 'already_running' };
    const tab = await this.pickTab(req, r);
    if ('error' in tab) return { success: false, error: tab.error };
    if (this.active.has(tab.pty)) return { success: false, error: 'busy' };
    const info = rt.get(tab.pty);
    const line = buildRunLine({
      command: r.command,
      cwd: r.cwd,
      tabCwd: info?.cwd ?? null,
      env: r.def.env,
      shellIntegration: info?.shell_integration ?? false,
    });
    const by = runByFor(principal);
    const now = this.now();
    const run: OperationRun = {
      run_id: newId('run'),
      op: r.def.name,
      workspace: req.workspace,
      pty_id: tab.pty,
      tab_id: info?.tab_id ?? null,
      by,
      started_at: new Date(now).toISOString(),
      ended_at: null,
      status: 'running',
      exit_code: null,
      duration_ms: null,
      readings: [],
      inputs_sig: null,
    };
    // The inputs signature is computed before typing: once the line is sent
    // the run can end at any moment (exit 127 in a few ms), and everything
    // below must be in place before its end signal can arrive.
    run.inputs_sig = await (this.deps.inputsSig ?? gitInputsSig)(r.cwd).catch(() => null);
    if (!r.adhoc && this.activeFor(req.workspace, r.def.name)) return { success: false, error: 'already_running' };
    if (this.active.has(tab.pty)) return { success: false, error: 'busy' };
    const act: ActiveRun = {
      run,
      def: r.def,
      workspace: req.workspace,
      pty: tab.pty,
      startCursor: rt.cursor(tab.pty),
      handTyped: false,
      timer: null,
      sigPending: null,
    };
    this.active.set(tab.pty, act);
    // Hester's runs are typed by Lee: C3 forbids the shared token from typing, so Lee sends as itself.
    const sender: Principal = principal.kind === 'device' ? principal : { kind: 'local-user' };
    // rt.send writes synchronously for a shell tab, so nothing below races the run's end signal.
    const sent = await rt.send(tab.pty, { text: line, submit: true, purpose: 'operation' }, sender, { askedBy: principal });
    if (!sent.success) {
      this.active.delete(tab.pty);
      return { success: false, error: sent.error ?? 'send_failed' };
    }
    const s = this.state(req.workspace);
    if (!r.adhoc) {
      for (const [op, pty] of s.links) if (pty === tab.pty) s.links.delete(op);
      s.links.set(r.def.name, tab.pty);
      s.lrEnd.delete(r.def.name);
      s.health.delete(r.def.name);
    }
    if (r.def.timeout_min && this.active.get(tab.pty) === act) {
      act.timer = setTimeout(() => this.finish(act, null, true), r.def.timeout_min * 60_000);
      act.timer.unref?.();
    }
    logCockpitEvent('operation.run', {
      workspace: req.workspace,
      actor: actorFor(principal),
      data: {
        run_id: run.run_id,
        op: run.op,
        kind: r.def.kind,
        by,
        pty_id: tab.pty,
        reused_tab: tab.reused,
        confirm_required: r.adhoc || r.def.confirm === true,
        inputs_sig: run.inputs_sig,
      },
    });
    if (by === 'hester') {
      cockpitBus.feed.post({
        workspace: req.workspace,
        kind: 'event',
        severity: 'ambient',
        producer: 'ops',
        title: `Hester ran ${r.def.name} in ${info?.label ?? `tab ${tab.pty}`}`,
        text: line,
        ref: { op: r.def.name, run_id: run.run_id, pty_id: tab.pty },
        ttl_ms: PASSED_EVENT_TTL_MS,
      });
    }
    this.changed(req.workspace);
    return { success: true, run };
  }

  /** Stop the operation's running command: Ctrl-C into its tab. */
  stopOp(workspace: string, name: string): { success: boolean; error?: string } {
    const act = this.activeFor(workspace, name);
    if (!act) return { success: false, error: 'not_running' };
    const pty = act.pty;
    if (!this.deps.writePty) return { success: false, error: 'unavailable' };
    this.deps.writePty(pty, '\x03');
    logCockpitEvent('tab.input', {
      workspace,
      actor: { kind: 'system' },
      data: { pty_id: pty, target_kind: 'shell', purpose: 'operation', chars: 1, submit: false },
    });
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Terminal signals (package A)
  // -------------------------------------------------------------------------

  onTerminal(sig: TerminalCommandSignal): void {
    try {
      if (sig.phase === 'end') {
        const act = this.active.get(sig.pty_id);
        if (act) this.finish(act, sig.exit_code, false, sig.duration_ms);
        return;
      }
      if (sig.by === 'lee' || this.active.has(sig.pty_id)) return;
      const workspace = sig.workspace ?? cockpitBus.tabRuntime?.get(sig.pty_id)?.workspace ?? null;
      if (!workspace || !this.isOpenWorkspace(workspace)) return;
      const s = this.state(workspace);
      for (const m of s.merged) {
        if (!m.runnable) continue;
        if (sig.cwd && path.resolve(sig.cwd) !== this.absCwd(workspace, m.def.cwd)) continue;
        if (!commandMatchesOperation(m.def, sig.text)) continue;
        this.startHandTyped(s, m.def, sig);
        return;
      }
    } catch (err) {
      this.log('ERROR', 'Cockpit ops: terminal signal failed', { error: String(err) });
    }
  }

  private startHandTyped(s: WsState, def: OperationDef, sig: TerminalCommandSignal): void {
    const rt = cockpitBus.tabRuntime;
    for (const [op, pty] of s.links) if (pty === sig.pty_id) s.links.delete(op);
    s.links.set(def.name, sig.pty_id);
    s.lrEnd.delete(def.name);
    s.health.delete(def.name);
    const info = rt?.get(sig.pty_id) ?? null;
    const run: OperationRun = {
      run_id: newId('run'),
      op: def.name,
      workspace: s.workspace,
      pty_id: sig.pty_id,
      tab_id: info?.tab_id ?? null,
      by: 'user',
      started_at: sig.started_at || new Date(this.now()).toISOString(),
      ended_at: null,
      status: 'running',
      exit_code: null,
      duration_ms: null,
      readings: [],
      inputs_sig: null,
    };
    const act: ActiveRun = {
      run,
      def,
      workspace: s.workspace,
      pty: sig.pty_id,
      startCursor: rt ? rt.cursor(sig.pty_id) : 0,
      handTyped: true,
      timer: null,
      sigPending: null,
    };
    this.active.set(sig.pty_id, act);
    const cwd = this.absCwd(s.workspace, def.cwd);
    // The command is already running: operation.run is logged once git
    // answers, and finish() holds operation.result until then (order + inputs_sig).
    act.sigPending = (this.deps.inputsSig ?? gitInputsSig)(cwd)
      .catch(() => null)
      .then((sigHex) => {
        act.sigPending = null;
        run.inputs_sig = sigHex;
        logCockpitEvent('operation.run', {
          workspace: s.workspace,
          actor: { kind: 'user', surface: 'lee' },
          data: { run_id: run.run_id, op: def.name, kind: def.kind, by: 'user', pty_id: sig.pty_id, reused_tab: true, confirm_required: false, inputs_sig: sigHex },
        });
      });
    this.changed(s.workspace);
  }

  onPtyExit(ptyId: number): void {
    const act = this.active.get(ptyId);
    if (act) this.finish(act, null, false);
    for (const s of this.states.values()) {
      for (const [op, pty] of s.links) {
        if (pty === ptyId) {
          s.links.delete(op);
          this.changed(s.workspace);
        }
      }
    }
  }

  /** §7.3 step 6–8: a run ended (or timed out: status unknown, never killed). */
  finish(act: ActiveRun, exitCode: number | null, timedOut: boolean, durationMs?: number | null): void {
    if (this.active.get(act.pty) !== act) return;
    this.active.delete(act.pty);
    if (act.timer) clearTimeout(act.timer);
    const s = this.state(act.workspace);
    const now = this.now();
    const run = act.run;
    run.ended_at = new Date(now).toISOString();
    run.exit_code = timedOut ? null : exitCode;
    run.status = timedOut ? 'unknown' : runStatusFor(exitCode);
    run.duration_ms = durationMs ?? Math.max(0, now - Date.parse(run.started_at));
    let output = '';
    let truncated = false;
    try {
      const got = cockpitBus.tabRuntime?.read(act.pty, { since: act.startCursor, max_chars: LOG_MAX });
      output = got?.text ?? '';
      truncated = !!got?.truncated;
    } catch {
      output = '';
    }
    const previous = new Map<string, number>();
    for (const r of s.runs[run.op] ?? []) for (const rd of r.readings) previous.set(rd.metric, rd.value);
    // A truncated read starts after the echo already.
    if (!act.handTyped && !truncated) output = dropEchoedLine(output);
    run.readings = parseReadings(output, act.def.produces);
    // An ad-hoc command's output isn't kept on disk: it has no operation to show it under.
    if (!run.op.startsWith('adhoc:')) this.saveLog(act.workspace, run.op, output);
    s.runs[run.op] = [...(s.runs[run.op] ?? []), run].slice(-RUNS_KEPT);
    if (act.def.kind === 'long-running') {
      if (exitCode == null || exitCode === 0 || exitCode === 130 || exitCode === 143) s.lrEnd.set(run.op, 'stopped');
      else s.lrEnd.set(run.op, 'crashed');
      s.health.delete(run.op);
    }
    this.persist(act.workspace);
    const logResult = () =>
      logCockpitEvent('operation.result', {
        workspace: act.workspace,
        data: {
          run_id: run.run_id,
          op: run.op,
          status: run.status,
          exit_code: run.exit_code,
          duration_ms: run.duration_ms,
          inputs_sig: run.inputs_sig,
          by: run.by,
          readings: run.readings,
        },
      });
    if (act.sigPending) void act.sigPending.then(logResult, logResult);
    else logResult();
    this.postResult(act, previous);
    this.changed(act.workspace);
  }

  private saveLog(workspace: string, name: string, output: string): void {
    try {
      const dir = this.opsDir(workspace);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = this.logPath(workspace, name);
      fs.writeFileSync(file, output.length > LOG_MAX ? output.slice(-LOG_MAX) : output, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch (err) {
      this.log('WARN', 'Cockpit ops: could not save run log', { op: name, error: String(err) });
    }
  }

  private postResult(act: ActiveRun, previous: Map<string, number>): void {
    const { run, def, workspace } = act;
    const feed = cockpitBus.feed;
    const label = cockpitBus.tabRuntime?.get(act.pty)?.label ?? null;
    if (run.status === 'failed' && def.kind === 'oneshot' && !act.handTyped) {
      feed.post({
        workspace,
        kind: 'failure',
        severity: 'needs-you',
        producer: 'ops',
        title: `${def.name} failed (exit ${run.exit_code})`,
        text: label ? `in ${label}` : null,
        item_ref: `op:${workspace}:${def.name}`,
        ref: { op: def.name, run_id: run.run_id, pty_id: act.pty },
        actions: [
          { id: 'create-task', label: 'Create task' },
          { id: 'fix-with-agent', label: 'Fix with agent', style: 'primary' },
          { id: 'open-tab', label: 'Open tab' },
        ],
        dedupe_key: `ops:fail:${workspace}:${def.name}`,
      });
    } else if (run.status === 'passed') {
      feed.closeByKey(`ops:fail:${workspace}:${def.name}`, 'done');
      if (run.by === 'hester' || def.notify_on_done) {
        feed.post({
          workspace,
          kind: 'event',
          severity: 'ambient',
          producer: 'ops',
          title: `${def.name} passed${run.duration_ms != null ? ` in ${Math.round(run.duration_ms / 1000)}s` : ''}`,
          ref: { op: def.name, run_id: run.run_id, pty_id: act.pty },
          ttl_ms: PASSED_EVENT_TTL_MS,
        });
      }
    }
    if (def.notify_on_done && (run.status === 'passed' || run.status === 'failed')) {
      this.deps.pushStatus?.(run.status === 'passed' ? 'success' : 'error', `${def.name} ${run.status}`);
    }
    for (const rd of run.readings) this.postReading(workspace, def.name, run.run_id, rd, previous.get(rd.metric) ?? null);
  }

  private postReading(workspace: string, op: string, runId: string, rd: OperationReading, previous: number | null): void {
    cockpitBus.feed.post({
      workspace,
      kind: 'metric',
      severity: 'ambient',
      producer: 'ops',
      title: readingLabel(rd, previous),
      ref: { op, run_id: runId },
      ttl_ms: METRIC_TTL_MS,
      dedupe_key: `ops:metric:${workspace}:${op}:${rd.metric}:${runId}`,
    });
  }

  /** Workspaces with state (for pushes). */
  knownWorkspaces(): string[] {
    return [...this.states.keys()];
  }
}

/**
 * Drop the shell's echo of the line Lee typed (the first output line of a
 * Lee-typed run): run logs never hold command text (contract §0).
 */
export function dropEchoedLine(output: string): string {
  const nl = output.indexOf('\n');
  return nl < 0 ? '' : output.slice(nl + 1);
}

function stateError(state: string): string {
  if (state === 'busy') return 'busy';
  if (state === 'awaiting-input') return 'awaiting_input';
  if (state === 'exited') return 'not_found';
  return 'state_unknown';
}

export function errorStatus(error: string | undefined): number {
  switch (error) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'busy':
    case 'awaiting_input':
    case 'state_unknown':
    case 'tab_not_ready':
    case 'already_running':
    case 'needs_confirm':
    case 'not_running':
      return 409;
    case 'tab_runtime_unavailable':
    case 'launcher_unavailable':
    case 'unavailable':
      return 503;
    default:
      return 400;
  }
}
