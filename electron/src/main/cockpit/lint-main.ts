/**
 * Package D (lee-lint) wiring in Lee main (contracts §8): the lint engine fed
 * from the event log, IPC and HTTP, the Feed producer 'lint', and the nudge
 * budget's persistence.
 */

import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Request, Response } from 'express';
import type { Actor, LeeEvent, Principal } from '../../shared/copilot';
import { COCKPIT_IPC } from '../../shared/cockpit';
import type {
  FeedAction,
  FeedSeverity,
  LintDiagnostic,
  LintFixResult,
  LintSnapshot,
  LintSuppressScope,
  NudgeClaimRequest,
  NudgeSource,
} from '../../shared/cockpit';
import { copilotBus, logEvent } from '../copilot/bus';
import { actorForPrincipal } from '../copilot/auth';
import { windowRegistry } from '../window-registry';
import { cockpitBus, logCockpitEvent } from './cockpit-bus';
import type { NudgeRecord } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import { LintEngine } from './lint/engine';
import { LintStore } from './lint/store';
import { scanEvents } from './lint/event-scan';
import { writeClaudeAllow } from './lint/claude-allow';
import { RepeatedSequenceRule } from './lint/rules/repeated-sequence';
import { FlakyOperationRule } from './lint/rules/flaky-operation';
import { LongWaitRule } from './lint/rules/long-wait';
import { RepeatApprovalRule } from './lint/rules/repeat-approval';

const HISTORY_DAYS = 8;
const EVALUATE_DEBOUNCE_MS = 2000;
const EVALUATE_EVERY_MS = 60_000;
const PUSH_DEBOUNCE_MS = 500;
const NUDGE_SAVE_DEBOUNCE_MS = 1000;
const NUDGE_KEEP_MS = 30 * 86_400_000;
const BRANCH_CACHE_MS = 30_000;
const MAX_LEARNED_TOOLS = 2000;
const NUDGE_SOURCES: NudgeSource[] = ['lint', 'checkin', 'ops', 'steward'];
const SUPPRESS_SCOPES: LintSuppressScope[] = ['item', 'branch', 'workspace'];

interface LintState {
  engine: LintEngine;
  timers: Array<ReturnType<typeof setInterval>>;
  evalTimer: ReturnType<typeof setTimeout> | null;
  pushTimer: ReturnType<typeof setTimeout> | null;
  nudgeTimer: ReturnType<typeof setTimeout> | null;
  offEvent: () => void;
  offFeed: () => void;
  offNudges: () => void;
}

let state: LintState | null = null;
const learnedTools = new Map<string, { tool: string; preview: string }>();
const branchCache = new Map<string, { at: number; branch: string | null }>();
/** Who is acting during a synchronous engine call (for the ceremony line). */
let currentActor: Actor = { kind: 'user', surface: 'lee' };

function nudgesFile(): string {
  return path.join(os.homedir(), '.lee', 'cockpit', 'nudges.json');
}

function loadNudges(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(nudgesFile(), 'utf8')) as { records?: NudgeRecord[] } | NudgeRecord[];
    const records = Array.isArray(raw) ? raw : Array.isArray(raw.records) ? raw.records : [];
    const cutoff = Date.now() - NUDGE_KEEP_MS;
    cockpitBus.nudges.load(records.filter((r) => r && typeof r.granted_at === 'number' && r.granted_at >= cutoff));
  } catch {
    // first run
  }
}

function saveNudges(): void {
  const cutoff = Date.now() - NUDGE_KEEP_MS;
  const records = cockpitBus.nudges.export().filter((r) => r.granted_at >= cutoff);
  try {
    const file = nudgesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ records }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[lint] could not save nudge budget:', err);
  }
}

function gitBranch(workspace: string): string | null {
  const hit = branchCache.get(workspace);
  const now = Date.now();
  if (hit && now - hit.at < BRANCH_CACHE_MS) return hit.branch;
  let branch: string | null = null;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    branch = null;
  }
  branchCache.set(workspace, { at: now, branch });
  return branch;
}

const FEED_SEVERITY: Record<string, FeedSeverity> = { info: 'ambient', warn: 'needs-you', 'needs-you': 'needs-you' };

function feedActions(d: LintDiagnostic): FeedAction[] {
  return [
    ...d.fixes.slice(0, 2).map((f, i): FeedAction => ({ id: f.id, label: f.label, style: i === 0 ? 'primary' : 'plain', confirm_text: f.confirm_text ?? null })),
    { id: 'suppress-item', label: 'Ignore for this item', style: 'plain' },
  ];
}

function createEngine(store: LintStore): LintEngine {
  return new LintEngine({
    rules: [new RepeatedSequenceRule(), new FlakyOperationRule(), new LongWaitRule(), new RepeatApprovalRule()],
    store,
    providers: {
      commandText: (ws, sig) => cockpitBus.tabRuntime?.commandText(ws, sig) ?? null,
      toolInfo: (sig) => learnedTools.get(sig) ?? null,
      ops: () => cockpitBus.ops,
      launcher: () => cockpitBus.launcher,
      writeClaudeAllow: async (ws, rules) => {
        await writeClaudeAllow(ws, rules);
      },
    },
    config: (rule, ws) => getCockpitConfig(ws).lint.rules[rule] ?? { severity: 'off' },
    demotion: (ws) => getCockpitConfig(ws).lint.demotion,
    log: (type, workspace, data) => {
      logCockpitEvent(type, { workspace, data });
    },
    ceremony: (workspace, target) => {
      logEvent({ type: 'ui.ceremony', workspace, actor: currentActor, data: { action: 'dismiss', target } });
    },
    claimNudge: (req) => cockpitBus.claimNudge(req),
    overrideNudge: (itemRef, stateKey) => cockpitBus.nudges.override(itemRef, stateKey),
    feedPost: (d) => {
      cockpitBus.feed.post({
        workspace: d.workspace,
        kind: 'lint',
        severity: FEED_SEVERITY[d.severity] ?? 'ambient',
        producer: 'lint',
        title: d.message,
        text: d.evidence.join('\n'),
        item_ref: d.item_ref,
        ref: { diag_id: d.id },
        actions: feedActions(d),
        dedupe_key: d.id,
      });
    },
    feedClose: (diagId, feedState) => cockpitBus.feed.closeByKey(diagId, feedState),
    branch: gitBranch,
  });
}

function withActor<T>(by: Principal | undefined, fn: () => T): T {
  const prev = currentActor;
  currentActor = actorForPrincipal(by);
  try {
    return fn();
  } finally {
    currentActor = prev;
  }
}

function scheduleEvaluate(): void {
  if (!state || state.evalTimer) return;
  state.evalTimer = setTimeout(() => {
    if (!state) return;
    state.evalTimer = null;
    state.engine.evaluate();
  }, EVALUATE_DEBOUNCE_MS);
}

function schedulePush(): void {
  if (!state || state.pushTimer) return;
  state.pushTimer = setTimeout(() => {
    if (!state) return;
    state.pushTimer = null;
    pushAll();
  }, PUSH_DEBOUNCE_MS);
}

function pushAll(): void {
  if (!state) return;
  for (const ws of windowRegistry.getAll().values()) {
    if (ws.browserWindow.isDestroyed()) continue;
    ws.browserWindow.webContents.send(COCKPIT_IPC.lintPush, state.engine.snapshot(ws.workspace));
  }
}

function windowWorkspace(e: IpcMainInvokeEvent): string | null {
  const id = BrowserWindow.fromWebContents(e.sender)?.id;
  return id != null ? windowRegistry.get(id)?.workspace ?? null : null;
}

function registerIpc(): void {
  ipcMain.handle(COCKPIT_IPC.lintList, (e, workspace: unknown): LintSnapshot | null => {
    if (!state) return null;
    return state.engine.snapshot(typeof workspace === 'string' && workspace ? workspace : windowWorkspace(e));
  });
  ipcMain.handle(COCKPIT_IPC.lintFix, async (_e, diagId: unknown, fixId: unknown): Promise<LintFixResult> => {
    if (!state) return { success: false, error: 'unavailable' };
    if (typeof diagId !== 'string' || typeof fixId !== 'string') return { success: false, error: 'invalid' };
    return state.engine.fix(diagId, fixId);
  });
  ipcMain.handle(COCKPIT_IPC.lintDismiss, (_e, diagId: unknown): { success: boolean } => {
    if (!state || typeof diagId !== 'string') return { success: false };
    return withActor({ kind: 'local-user' }, () => state!.engine.dismiss(diagId));
  });
  ipcMain.handle(COCKPIT_IPC.lintSuppress, (_e, diagId: unknown, scope: unknown): { success: boolean } => {
    if (!state || typeof diagId !== 'string' || !SUPPRESS_SCOPES.includes(scope as LintSuppressScope)) return { success: false };
    return withActor({ kind: 'local-user' }, () => state!.engine.suppress(diagId, scope as LintSuppressScope));
  });
  ipcMain.on(COCKPIT_IPC.lintShown, (_e, payload: { diag_ids?: unknown; surface?: unknown }) => {
    if (!state || !payload || !Array.isArray(payload.diag_ids)) return;
    const surface = payload.surface === 'feed' ? 'feed' : 'status';
    const ids = payload.diag_ids.filter((x): x is string => typeof x === 'string').slice(0, 200);
    state.engine.shown(ids, surface);
  });
  ipcMain.on(COCKPIT_IPC.lintLearnTool, (_e, info: { signature?: unknown; tool?: unknown; preview?: unknown }) => {
    if (!info || typeof info.signature !== 'string' || typeof info.tool !== 'string' || typeof info.preview !== 'string') return;
    const sig = info.signature.slice(0, 64);
    const prev = learnedTools.get(sig);
    if (prev && prev.tool === info.tool && prev.preview === info.preview) return;
    learnedTools.delete(sig);
    learnedTools.set(sig, { tool: info.tool.slice(0, 128), preview: info.preview.slice(0, 500) });
    if (learnedTools.size > MAX_LEARNED_TOOLS) learnedTools.delete(learnedTools.keys().next().value as string);
    scheduleEvaluate();
  });
}

function unregisterIpc(): void {
  for (const ch of [COCKPIT_IPC.lintList, COCKPIT_IPC.lintFix, COCKPIT_IPC.lintDismiss, COCKPIT_IPC.lintSuppress]) {
    ipcMain.removeHandler(ch);
  }
  ipcMain.removeAllListeners(COCKPIT_IPC.lintShown);
  ipcMain.removeAllListeners(COCKPIT_IPC.lintLearnTool);
}

function principalOf(res: Response): Principal | undefined {
  return res.locals.principal as Principal | undefined;
}

function registerHttp(): void {
  cockpitBus.withExpressApp((app) => {
    app.get('/cockpit/lint', (req: Request, res: Response) => {
      const p = principalOf(res);
      if (!p || (p.kind === 'shared' && !p.loopback)) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
      if (!state) {
        res.status(503).json({ success: false, error: 'unavailable' });
        return;
      }
      const q = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null;
      res.json(state.engine.snapshot(q ?? windowRegistry.getFocused()?.workspace ?? null));
    });

    app.post('/nudges/claim', (req: Request, res: Response) => {
      const p = principalOf(res);
      if (!p || p.kind !== 'shared' || !p.loopback) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
      const b = (req.body ?? {}) as Partial<NudgeClaimRequest>;
      if (typeof b.item_ref !== 'string' || !b.item_ref || typeof b.state_key !== 'string' || !NUDGE_SOURCES.includes(b.source as NudgeSource)) {
        res.status(400).json({ success: false, error: 'invalid' });
        return;
      }
      res.json(
        cockpitBus.claimNudge({
          item_ref: b.item_ref.slice(0, 512),
          state_key: b.state_key.slice(0, 512),
          source: b.source as NudgeSource,
          workspace: typeof b.workspace === 'string' ? b.workspace : null,
          blocking: b.blocking === true,
        }),
      );
    });

    app.post('/nudges/override', (req: Request, res: Response) => {
      const p = principalOf(res);
      if (!p || !((p.kind === 'shared' && p.loopback) || p.kind === 'device')) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
      const b = (req.body ?? {}) as { item_ref?: unknown; state_key?: unknown };
      if (typeof b.item_ref !== 'string' || !b.item_ref || typeof b.state_key !== 'string') {
        res.status(400).json({ success: false, error: 'invalid' });
        return;
      }
      cockpitBus.nudges.override(b.item_ref.slice(0, 512), b.state_key.slice(0, 512));
      res.json({ success: true });
    });
  });
}

function registerFeed(engine: LintEngine): () => void {
  cockpitBus.registerFeedActionHandler('lint', async (entry, actionId, _payload, by) => {
    const diagId = entry.ref.diag_id;
    if (!diagId || !engine.get(diagId)) return { success: false, error: 'not_found', entry };
    if (actionId === 'suppress-item') {
      const r = withActor(by, () => engine.suppress(diagId, 'item'));
      return { success: r.success, entry: cockpitBus.feed.get(entry.id) ?? entry };
    }
    const r = await engine.fix(diagId, actionId);
    return { success: r.success, error: r.error, data: r, entry: cockpitBus.feed.get(entry.id) ?? entry };
  });
  // The Feed's built-in Dismiss (bus-side) closes the entry; record it as a lint dismissal.
  const onFeed = (entry: { producer: string; state: string; ref: { diag_id?: string } }) => {
    if (entry.producer !== 'lint' || entry.state !== 'dismissed' || !entry.ref.diag_id) return;
    if (engine.get(entry.ref.diag_id)) engine.dismiss(entry.ref.diag_id, { fromFeed: true });
  };
  cockpitBus.feed.on('change', onFeed);
  return () => cockpitBus.feed.off('change', onFeed);
}

export function initCockpitLint(): void {
  if (state) return;
  cockpitBus.nudges.perHour = getCockpitConfig().cockpit.nudges.max_per_hour;
  loadNudges();

  const engine = createEngine(new LintStore());
  const consumed = new Set(engine.consumedTypes());
  const startedAt = Date.now();
  let backlog: LeeEvent[] | null = [];
  const onEvent = (ev: LeeEvent) => {
    if (!consumed.has(ev.type)) return;
    if (backlog) {
      backlog.push(ev);
      return;
    }
    engine.ingest(ev);
    scheduleEvaluate();
  };
  copilotBus.on('event', onEvent);

  const onNudges = () => {
    if (!state || state.nudgeTimer) return;
    state.nudgeTimer = setTimeout(() => {
      if (!state) return;
      state.nudgeTimer = null;
      saveNudges();
    }, NUDGE_SAVE_DEBOUNCE_MS);
  };
  cockpitBus.nudges.on('change', onNudges);

  engine.on('change', schedulePush);

  state = {
    engine,
    timers: [],
    evalTimer: null,
    pushTimer: null,
    nudgeTimer: null,
    offEvent: () => copilotBus.off('event', onEvent),
    offFeed: registerFeed(engine),
    offNudges: () => cockpitBus.nudges.off('change', onNudges),
  };
  const tick = setInterval(() => {
    cockpitBus.nudges.perHour = getCockpitConfig().cockpit.nudges.max_per_hour;
    state?.engine.evaluate();
  }, EVALUATE_EVERY_MS);
  tick.unref?.();
  state.timers.push(tick);

  registerIpc();
  registerHttp();

  void scanEvents({
    dir: path.join(os.homedir(), '.lee', 'events'),
    days: HISTORY_DAYS,
    types: [...consumed],
    until: startedAt,
    onEvent: (ev) => engine.ingest(ev),
  })
    .catch((err) => console.error('[lint] history scan failed:', err))
    .finally(() => {
      const queued = backlog ?? [];
      backlog = null;
      for (const ev of queued) engine.ingest(ev);
      scheduleEvaluate();
    });
}

export function shutdownCockpitLint(): void {
  if (!state) return;
  const s = state;
  state = null;
  for (const t of s.timers) clearInterval(t);
  if (s.evalTimer) clearTimeout(s.evalTimer);
  if (s.pushTimer) clearTimeout(s.pushTimer);
  if (s.nudgeTimer) clearTimeout(s.nudgeTimer);
  s.offEvent();
  s.offFeed();
  s.offNudges();
  unregisterIpc();
  saveNudges();
}
