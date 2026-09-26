/**
 * Package A (lee-tab) wiring: tab runtime, launcher, check-ins, the `tab`
 * command domain, IPC (contract §5.7), HTTP (§5.4), Feed pushes and the Feed
 * action handlers for producers `tabs`, `checkin` and `launch`.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Request, Response } from 'express';
import type { Principal } from '../../shared/copilot';
import {
  COCKPIT_IPC,
  type CheckinResult,
  type CockpitRendererEvent,
  type CreateTabResult,
  type FeedActionResult,
  type LaunchRequest,
  type TabReadRequest,
  type TabSendRequest,
  type AgentNameSource,
} from '../../shared/cockpit';
import { getHesterPort } from '../copilot/capture';
import type { PTYManager } from '../pty-manager';
import { windowRegistry } from '../window-registry';
import { cockpitBus, logCockpitEvent, type FeedActionHandler } from './cockpit-bus';
import { CheckinManager } from './checkin';
import { getCockpitConfig, permissionDefault } from './cockpit-config';
import { TaskLauncherImpl } from './launcher';
import { installPiExtension } from './pi-extension';
import { installShellIntegration, setShellIntegrationWorkspaceResolver } from './shell-integration';
import { createTabDomain } from './tab-domain';
import { TabRuntimeImpl, type PtyHost } from './tab-runtime';
import { TaskRelay } from './task-relay';
import { safeTranscriptPath, TranscriptTitleReader } from './session-name';
import { listWorkspaceFiles } from './workspace-files';
import { copilotBus } from '../copilot/bus';
import { getCopilotQueue } from '../copilot/queue';
import { quadrantRank } from '../copilot/attention-queue';
import type { LeeEvent } from '../../shared/copilot';
import { getHesterCache } from './hester-cache';
import { registerLintEffects } from './lint-main';
import * as path from 'path';

/** The open window workspace equal to `p`, else null (the file list is only served for open workspaces). */
function openWorkspacePath(p: string): string | null {
  for (const [, w] of windowRegistry.getAll()) {
    if (w.workspace && path.resolve(w.workspace) === path.resolve(p)) return w.workspace;
  }
  return null;
}

const LOCAL_USER: Principal = { kind: 'local-user' };
const TABS_PUSH_MS = 500;
const FEED_PUSH_MS = 250;

const MODES = new Set(['cockpit', 'workbench']);
const MODE_REASONS = new Set(['default', 'manual', 'focus_start', 'focus_end', 'handoff', 'return', 'go_into', 'open_tab']);
const GO_INTO_FROM = new Set(['tile', 'feed', 'drawer', 'hotkey', 'tabs', 'other-window']);
const AGENT_STATES = new Set(['busy', 'idle', 'waiting', 'unknown', 'idle-at-prompt', 'awaiting-input', 'exited']);

/** Validate a renderer event (contract §2.2); null drops it. */
export function validRendererEvent(ev: unknown): CockpitRendererEvent | null {
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as { type?: unknown; data?: unknown };
  const d = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : null;
  if (!d) return null;
  if (e.type === 'cockpit.mode') {
    if (!MODES.has(d.from as string) || !MODES.has(d.to as string) || !MODE_REASONS.has(d.reason as string)) return null;
    return { type: 'cockpit.mode', data: { from: d.from, to: d.to, reason: d.reason } } as CockpitRendererEvent;
  }
  if (e.type === 'cockpit.go_into') {
    if (!Number.isInteger(d.pty_id) || !AGENT_STATES.has(d.agent_state as string) || !GO_INTO_FROM.has(d.from as string)) return null;
    return { type: 'cockpit.go_into', data: { pty_id: d.pty_id, agent_state: d.agent_state, from: d.from } } as CockpitRendererEvent;
  }
  return null;
}

function senderWindow(e: { sender: Electron.WebContents }): number | null {
  try {
    return BrowserWindow.fromWebContents(e.sender)?.id ?? null;
  } catch {
    return null;
  }
}

function toAllWindows(channel: string, payload: unknown): void {
  for (const [, w] of windowRegistry.getAll()) {
    try {
      if (!w.browserWindow.isDestroyed()) w.browserWindow.webContents.send(channel, payload);
    } catch {
      // window closing
    }
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
    t.unref?.();
  };
}

function principalOf(res: Response): Principal | undefined {
  return res.locals?.principal as Principal | undefined;
}

function sharedLan(p: Principal | undefined): boolean {
  return !p || (p.kind === 'shared' && !p.loopback);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

let runtime: TabRuntimeImpl | null = null;

export function getTabRuntime(): TabRuntimeImpl | null {
  return runtime;
}

export function initCockpitTabs({ ptyManager }: { ptyManager: PTYManager }): TabRuntimeImpl {
  if (runtime) return runtime;
  const log = (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) =>
    ptyManager.log(level, message, details as Record<string, any> | undefined);

  setShellIntegrationWorkspaceResolver((windowId) => (windowId != null ? windowRegistry.get(windowId)?.workspace ?? null : null));
  try {
    installShellIntegration();
  } catch (err) {
    log('WARN', 'Cockpit: could not write shell integration files', { error: String(err) });
  }
  try {
    installPiExtension();
  } catch (err) {
    log('WARN', 'Cockpit: could not write the Pi hook extension', { error: String(err) });
  }

  const rt = new TabRuntimeImpl(ptyManager as unknown as PtyHost);
  runtime = rt;
  const relay = new TaskRelay({ getHesterPort, log });
  const launcher = new TaskLauncherImpl(rt, relay);
  const checkins = new CheckinManager(rt);

  // Session names (addendum 2026-09-26b): Claude's transcript title lines on
  // SessionStart / UserPromptSubmit / Stop, and names you type.
  const titles = new TranscriptTitleReader();
  copilotBus.on('agent-transcript', (sig: { pty_id: number | null; transcript_path: string }) => {
    if (sig?.pty_id == null || !rt.exists(sig.pty_id)) return;
    const file = safeTranscriptPath(sig.transcript_path);
    if (!file) return;
    const got = titles.read(file);
    if (!got) return;
    if (got.customTitle) rt.setName(sig.pty_id, got.customTitle, 'custom-title');
    if (got.aiTitle) rt.setName(sig.pty_id, got.aiTitle, 'ai-title');
  });
  rt.on('name', (ptyId: number, name: string | null, source: AgentNameSource | null, relayIt: boolean) => {
    if (!relayIt) return;
    const workspace = rt.workspaceOf(ptyId);
    if (!workspace) return;
    void relay.relayName({
      workspace,
      task_id: rt.taskOf(ptyId),
      session_id: rt.sessionOf(ptyId),
      name,
      source: source ?? 'user',
    });
  });
  cockpitBus.setTabRuntime(rt);
  cockpitBus.setLauncher(launcher);
  cockpitBus.registerCommandDomain('tab', createTabDomain(rt, checkins));
  rt.start();
  checkins.start();

  const focusPty = (ptyId: number): { success: boolean; error?: string } => {
    const windowId = rt.windowOf(ptyId);
    const w = windowId != null ? windowRegistry.get(windowId) : undefined;
    if (!w || w.browserWindow.isDestroyed()) return { success: false, error: 'not_found' };
    if (w.browserWindow.isMinimized()) w.browserWindow.restore();
    w.browserWindow.focus();
    w.browserWindow.webContents.send(COCKPIT_IPC.goInto, { pty_id: ptyId, tab_id: rt.locate(ptyId)?.tab.id ?? null });
    return { success: true };
  };

  // v4 (contract 2026-09-26 v4 section 7.1, 7.2, 7.4) ----------------------------
  // Hester cache: tasks with quadrants, the steward state and human_balance.
  const cache = getHesterCache({ getHesterPort });
  cache.start();
  copilotBus.on('event', (e: LeeEvent) => {
    // Hester changed a task's quadrant or the steward state: re-read now.
    if ((e.type === 'task.override' || e.type === 'steward.quiet') && e.workspace) void cache.refresh(e.workspace);
  });
  /** The cache task for a PTY: Lee's own pty -> task link first, then Hester's record of the agent. */
  const taskForPty = (ptyId: number) => {
    const id = rt.taskOf(ptyId);
    if (id) {
      const t = cache.task(rt.workspaceOf(ptyId), id) ?? cache.findTask(id);
      if (t) return t;
    }
    return cache.taskByPty(ptyId);
  };
  try {
    const cq = getCopilotQueue(ptyManager);
    // Quadrant ordering of the attention queue (section 7.2).
    cq.queue.setRanker((item) => {
      const t = item.source.pty_id != null ? taskForPty(item.source.pty_id) : null;
      const q = t?.quadrant ?? null;
      return { quadrant: q, rank: quadrantRank(q) };
    });
    // Focus on a task relates items from its agent (section 7.4).
    cq.focus.setTaskResolver((ptyId) => {
      const id = rt.taskOf(ptyId);
      if (id) return { workspace: rt.workspaceOf(ptyId), task_id: id };
      const t = cache.taskByPty(ptyId);
      return t ? { workspace: t.workspace, task_id: t.id } : null;
    });
    cache.on('change', () => cq.rankingChanged());
    registerLintEffects(
      {
        endFocus: async () => cq.focusStop({ kind: 'user', surface: 'lee' }).body.active === false,
      },
      log,
    );
  } catch (err) {
    log('WARN', 'Cockpit: could not install the quadrant ranker', { error: String(err) });
  }

  // Feed actions --------------------------------------------------------------
  const openTabAction: FeedActionHandler = async (entry, actionId) => {
    if (actionId !== 'open-tab' || entry.ref.pty_id == null) return { success: false, error: 'unknown_action', entry };
    const r = focusPty(entry.ref.pty_id);
    return { ...r, entry };
  };
  registerLintEffects({
    checkin: async (ptyId) => {
      const r = await checkins.checkin(ptyId, { by: LOCAL_USER });
      return r.success ? { success: true } : { success: false, error: r.error ?? 'checkin_failed' };
    },
    focusTab: async (ptyId) => focusPty(ptyId),
  });
  cockpitBus.registerFeedActionHandler('tabs', openTabAction);
  cockpitBus.registerFeedActionHandler('launch', openTabAction);
  cockpitBus.registerFeedActionHandler('checkin', async (entry, actionId, _payload, by): Promise<FeedActionResult> => {
    if (actionId === 'open-tab') return openTabAction(entry, actionId, _payload, by);
    if (actionId !== 'checkin' || entry.ref.pty_id == null) return { success: false, error: 'unknown_action', entry };
    const res: CheckinResult = await checkins.checkin(entry.ref.pty_id, { by });
    const updated = cockpitBus.feed.get(entry.id) ?? entry;
    return { success: res.success, ...(res.error ? { error: res.error } : {}), entry: updated, data: res };
  });

  // IPC (contract §5.7) --------------------------------------------------------
  const ptyArg = (v: unknown): number => {
    const n = num(v);
    if (n == null) throw new Error('pty_id must be an integer');
    return n;
  };
  ipcMain.handle(COCKPIT_IPC.tabsList, (_e: IpcMainInvokeEvent, workspace?: string | null) =>
    rt.list(typeof workspace === 'string' && workspace ? workspace : null, { withText: true }),
  );
  ipcMain.handle(COCKPIT_IPC.tabRead, (_e: IpcMainInvokeEvent, ptyId: number, req: TabReadRequest) => rt.read(ptyArg(ptyId), req ?? {}));
  ipcMain.handle(COCKPIT_IPC.tabState, (_e: IpcMainInvokeEvent, ptyId: number) => rt.state(ptyArg(ptyId)));
  ipcMain.handle(COCKPIT_IPC.tabSend, (_e: IpcMainInvokeEvent, ptyId: number, req: TabSendRequest) => rt.send(ptyArg(ptyId), req ?? { text: '' }, LOCAL_USER));
  ipcMain.handle(COCKPIT_IPC.tabFocus, (_e: IpcMainInvokeEvent, ptyId: number) => focusPty(ptyArg(ptyId)));
  ipcMain.handle(COCKPIT_IPC.tabRename, (_e: IpcMainInvokeEvent, ptyId: number, name: unknown) => {
    const id = ptyArg(ptyId);
    if (!rt.exists(id)) return { success: false, error: 'not_found' };
    if (name != null && typeof name !== 'string') return { success: false, error: 'invalid' };
    rt.setName(id, (name as string | null) ?? null, 'user');
    return { success: true };
  });
  ipcMain.handle(COCKPIT_IPC.filesList, async (_e: IpcMainInvokeEvent, workspace: unknown) => {
    const ws = typeof workspace === 'string' ? openWorkspacePath(workspace) : null;
    if (!ws) return { files: [], truncated: false };
    return listWorkspaceFiles(ws);
  });
  ipcMain.handle(COCKPIT_IPC.checkin, (_e: IpcMainInvokeEvent, ptyId: number, opts?: { force?: boolean }) =>
    checkins.checkin(ptyArg(ptyId), { by: LOCAL_USER, force: !!opts?.force }),
  );
  ipcMain.handle(COCKPIT_IPC.checkinCancel, (_e: IpcMainInvokeEvent, ptyId: number) => checkins.cancel(ptyArg(ptyId), LOCAL_USER));
  ipcMain.handle(COCKPIT_IPC.launch, (e: IpcMainInvokeEvent, req: LaunchRequest) => launcher.launch(req, LOCAL_USER, senderWindow(e)));
  ipcMain.handle(COCKPIT_IPC.launchDefaults, (_e: IpcMainInvokeEvent, workspace: unknown) => {
    const ws = typeof workspace === 'string' ? openWorkspacePath(workspace) : null;
    return { permission_default: permissionDefault(getCockpitConfig(ws).cockpit.launch.permission_default) };
  });
  ipcMain.handle(COCKPIT_IPC.feedGet, (_e: IpcMainInvokeEvent, workspace?: string | null) =>
    cockpitBus.feed.snapshot(typeof workspace === 'string' && workspace ? workspace : undefined),
  );
  ipcMain.handle(COCKPIT_IPC.feedAct, (_e: IpcMainInvokeEvent, entryId: string, actionId: string, payload?: Record<string, string>) =>
    cockpitBus.actOnFeed(String(entryId), String(actionId), payload && typeof payload === 'object' ? payload : {}, LOCAL_USER),
  );
  ipcMain.on(COCKPIT_IPC.rendererEvent, (e, raw: unknown) => {
    const ev = validRendererEvent(raw);
    if (!ev) return;
    const windowId = senderWindow(e);
    logCockpitEvent(ev.type, {
      source: 'renderer',
      workspace: windowId != null ? windowRegistry.get(windowId)?.workspace ?? null : null,
      window_id: windowId,
      actor: { kind: 'user', surface: 'lee' },
      data: ev.data as unknown as Record<string, unknown>,
    });
  });
  ipcMain.on(COCKPIT_IPC.createTabResult, (_e, res: CreateTabResult) => rt.resolveCreateTab(res));

  // Pushes ----------------------------------------------------------------------
  rt.on('change', debounce(() => toAllWindows(COCKPIT_IPC.tabsPush, rt.list(null, { withText: true })), TABS_PUSH_MS));
  cockpitBus.feed.on('change', debounce(() => toAllWindows(COCKPIT_IPC.feedPush, cockpitBus.feed.snapshot()), FEED_PUSH_MS));

  // HTTP (contract §5.4) ----------------------------------------------------------
  cockpitBus.withExpressApp((app) => {
    app.get('/cockpit/tabs', (req: Request, res: Response) => {
      if (sharedLan(principalOf(res))) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      const ws = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null;
      const list = rt.list(ws, { withText: false });
      // Screen text reaches the shared token only through tab.read_output,
      // which posts a "Hester read" notice; the list carries no tail for it.
      const shared = principalOf(res)?.kind === 'shared';
      res.json({ success: true, data: shared ? list.map((t) => ({ ...t, tail: [] })) : list });
    });
    app.get('/cockpit/feed', (req: Request, res: Response) => {
      if (sharedLan(principalOf(res))) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      const ws = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : undefined;
      res.json({ success: true, data: cockpitBus.feed.snapshot(ws) });
    });
    app.post('/cockpit/feed/:id/act', async (req: Request, res: Response) => {
      const p = principalOf(res);
      if (p?.kind !== 'device') {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      res.locals.deviceCategory = 'triage';
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const payload = body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, string>) : {};
      const out = await cockpitBus.actOnFeed(String(req.params.id), String(body.action ?? ''), payload, p);
      const status = out.success ? 200 : out.error === 'not_found' ? 404 : out.error === 'forbidden' ? 403 : 409;
      res.status(status).json(out.success ? { success: true, data: out } : { success: false, error: out.error, data: out });
    });
    app.post('/cockpit/launch', async (req: Request, res: Response) => {
      const p = principalOf(res);
      if (p?.kind !== 'device') {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      res.locals.deviceCategory = 'launch';
      const out = await launcher.launch((req.body ?? {}) as LaunchRequest, p, null);
      res.status(out.success ? 200 : 400).json(out.success ? { success: true, data: out } : { success: false, error: out.error, data: out });
    });
  });

  log('INFO', 'Cockpit tabs ready');
  return rt;
}
