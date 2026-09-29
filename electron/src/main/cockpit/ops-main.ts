/**
 * Operations wiring (package B): the runtime, operation agents, the ops
 * provider for lint, IPC, `GET /cockpit/ops`, the `ops` command domain and
 * the Feed action handler for producer 'ops'.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.
 */

import * as fs from 'fs';
import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import type { Request, Response } from 'express';
import type { Principal } from '../../shared/copilot';
import { COCKPIT_IPC } from '../../shared/cockpit';
import type { FeedActionResult, FeedEntry, OpAgentRequest, OpRunRequest, OperationDef } from '../../shared/cockpit';
import type { PTYManager } from '../pty-manager';
import { windowRegistry } from '../window-registry';
import { cockpitBus } from './cockpit-bus';
import { OpsAgents } from './ops-agent';
import { createOpsDomain } from './ops-domain';
import { OpsRuntime } from './ops-runtime';

const PUSH_DEBOUNCE_MS = 250;
const LOCAL_USER: Principal = { kind: 'local-user' };

let runtime: OpsRuntime | null = null;
let agents: OpsAgents | null = null;
let onPtyExit: ((id: number) => void) | null = null;
let ptyRef: PTYManager | null = null;
const pushTimers = new Map<string, NodeJS.Timeout>();
let initTimer: NodeJS.Timeout | null = null;

function openWorkspaces(): string[] {
  const out = new Set<string>();
  for (const ws of windowRegistry.getAll().values()) if (ws.workspace) out.add(ws.workspace);
  return [...out];
}

function sendAll(channel: string, payload: unknown): void {
  for (const ws of windowRegistry.getAll().values()) {
    if (!ws.browserWindow.isDestroyed()) ws.browserWindow.webContents.send(channel, payload);
  }
}

function schedulePush(workspace: string): void {
  if (pushTimers.has(workspace)) return;
  const t = setTimeout(() => {
    pushTimers.delete(workspace);
    if (!runtime) return;
    try {
      sendAll(COCKPIT_IPC.opsPush, runtime.snapshot(workspace));
    } catch (err) {
      ptyRef?.log('WARN', 'Cockpit ops: snapshot push failed', { workspace, error: String(err) });
    }
  }, PUSH_DEBOUNCE_MS);
  t.unref?.();
  pushTimers.set(workspace, t);
}

export function listSerialPorts(): string[] {
  try {
    const names = fs.readdirSync('/dev');
    const pick =
      process.platform === 'darwin'
        ? (n: string) => n.startsWith('cu.') && !/bluetooth|debug-console/i.test(n)
        : (n: string) => /^tty(USB|ACM)\d+$/.test(n);
    return names.filter(pick).sort().map((n) => `/dev/${n}`);
  } catch {
    return [];
  }
}

function goInto(ptyId: number): { success: boolean; error?: string } {
  const info = cockpitBus.tabRuntime?.get(ptyId) ?? null;
  const windowId = info?.window_id ?? null;
  const target = windowId != null ? windowRegistry.get(windowId) : undefined;
  if (!target || target.browserWindow.isDestroyed()) return { success: false, error: 'not_found' };
  const bw = target.browserWindow;
  if (bw.isMinimized()) bw.restore();
  bw.show();
  bw.focus();
  bw.webContents.send(COCKPIT_IPC.goInto, { pty_id: ptyId, tab_id: info?.tab_id ?? null });
  return { success: true };
}

function senderWindow(e: IpcMainInvokeEvent): number | null {
  return BrowserWindow.fromWebContents(e.sender)?.id ?? null;
}

async function handleFeedAction(entry: FeedEntry, actionId: string, _payload: Record<string, string>, by: Principal): Promise<FeedActionResult> {
  if (!runtime || !agents) return { success: false, error: 'unavailable', entry };
  const ws = entry.workspace;
  const pid = entry.ref.proposal_id;
  if ((actionId === 'approve' || actionId === 'reject') && pid) {
    const approved = actionId === 'approve';
    if (runtime.hasProposal(pid)) {
      const res = await runtime.resolveProposal(pid, approved, by);
      return { success: res.success, error: res.error, entry: cockpitBus.feed.get(entry.id) ?? entry, data: res };
    }
    if (agents.hasProposal(pid)) {
      const res = await agents.resolve(pid, approved, by);
      cockpitBus.feed.setState(entry.id, approved && res.success ? 'done' : 'dismissed');
      return { success: res.success, error: res.error, entry: cockpitBus.feed.get(entry.id) ?? entry, data: res.data };
    }
    cockpitBus.feed.setState(entry.id, 'expired');
    return { success: false, error: 'expired', entry };
  }
  const op = entry.ref.op;
  if (!ws || !op) return { success: false, error: 'invalid', entry };
  switch (actionId) {
    case 'fix-with-agent': {
      const res = await agents.startAgent({ workspace: ws, purpose: 'fix', op, run_id: entry.ref.run_id }, by);
      if (res.success) cockpitBus.feed.setState(entry.id, 'done');
      return { success: res.success, error: res.error, entry: cockpitBus.feed.get(entry.id) ?? entry, data: res };
    }
    case 'create-task': {
      const launcher = cockpitBus.launcher;
      if (!launcher) return { success: false, error: 'launcher_unavailable', entry };
      const run = entry.ref.run_id ? runtime.getRun(ws, entry.ref.run_id) : runtime.lastRun(ws, op);
      const created = await launcher.createTask({
        workspace: ws,
        title: `Fix failing operation ${op}`,
        kind: 'bug',
        lead: 'delegate',
        origin: { kind: 'operation', ref: op },
        note: `Last run ${run?.status ?? 'unknown'}${run?.exit_code != null ? ` (exit ${run.exit_code})` : ''}. Log: ${runtime.logPath(ws, op)}`,
        confirmed: true,
      });
      cockpitBus.feed.setState(entry.id, 'done');
      return { success: true, entry: cockpitBus.feed.get(entry.id) ?? entry, data: created };
    }
    case 'open-tab': {
      const pty = entry.ref.pty_id ?? runtime.snapshot(ws).operations.find((o) => o.def.name === op)?.linked_pty_id ?? null;
      if (pty == null) return { success: false, error: 'no_tab', entry };
      const res = goInto(pty);
      return { success: res.success, error: res.error, entry };
    }
    default:
      return { success: false, error: 'unknown_action', entry };
  }
}

export function initCockpitOps({ ptyManager }: { ptyManager: PTYManager }): void {
  if (runtime) return;
  ptyRef = ptyManager;
  runtime = new OpsRuntime({
    workspaces: openWorkspaces,
    log: (level, message, details) => ptyManager.log(level, message, details),
    pushStatus: (type, message) =>
      sendAll('status:push', { id: `ops-${type}-${Date.now()}`, message, type, ttl: type === 'error' ? 15_000 : 6_000 }),
    onChange: schedulePush,
    writePty: (id, data) => ptyManager.write(id, data),
  });
  agents = new OpsAgents(runtime);
  const rt = runtime;
  const ag = agents;
  rt.start();
  ag.start();

  cockpitBus.setOps({
    snapshot: (ws) => rt.snapshot(ws),
    suggest: (ws, def, from) => rt.suggest(ws, def, from),
    setFlag: (ws, name, flag, value) => rt.setFlag(ws, name, flag, value),
  });
  cockpitBus.registerCommandDomain('ops', createOpsDomain(rt, () => windowRegistry.getFocused()?.workspace ?? null));
  cockpitBus.registerFeedActionHandler('ops', handleFeedAction);

  cockpitBus.withExpressApp((app) => {
    app.get('/cockpit/ops', (req: Request, res: Response) => {
      const principal = res.locals.principal as Principal | undefined;
      if (!principal || (principal.kind === 'shared' && !principal.loopback)) {
        res.status(403).json({ success: false, error: 'forbidden' });
        return;
      }
      const ws = typeof req.query.workspace === 'string' ? req.query.workspace : windowRegistry.getFocused()?.workspace ?? '';
      if (!rt.isOpenWorkspace(ws)) {
        res.status(400).json({ success: false, error: 'unknown_workspace' });
        return;
      }
      res.json(rt.snapshot(ws));
    });
  });

  ipcMain.handle(COCKPIT_IPC.opsList, (_e, ws: string) => rt.snapshot(String(ws)));
  ipcMain.handle(COCKPIT_IPC.opsRun, async (_e, req: OpRunRequest) => (await rt.run(req, LOCAL_USER)).result);
  ipcMain.handle(COCKPIT_IPC.opsStop, (_e, ws: string, name: string) => rt.stopOp(String(ws), String(name)));
  ipcMain.handle(COCKPIT_IPC.opsConfirm, (_e, ws: string, names: string[]) =>
    rt.confirm(String(ws), Array.isArray(names) ? names.map(String) : [], LOCAL_USER),
  );
  ipcMain.handle(COCKPIT_IPC.opsDismissSuggestion, (_e, ws: string, name: string) => rt.dismissSuggestion(String(ws), String(name), LOCAL_USER));
  ipcMain.handle(COCKPIT_IPC.opsSave, (_e, ws: string, def: OperationDef) => rt.save(String(ws), def));
  ipcMain.handle(COCKPIT_IPC.opsLinkTab, (_e, ptyId: number, ws: string, name: string | null) =>
    rt.linkTab(Number(ptyId), String(ws), name == null ? null : String(name)),
  );
  ipcMain.handle(COCKPIT_IPC.opsAgent, (e, req: OpAgentRequest) => ag.startAgent(req, LOCAL_USER, senderWindow(e)));
  ipcMain.handle(COCKPIT_IPC.opsSerialPorts, () => listSerialPorts());

  onPtyExit = (id: number) => rt.onPtyExit(id);
  ptyManager.on('exit', onPtyExit);

  initTimer = setTimeout(() => {
    for (const ws of openWorkspaces()) {
      try {
        rt.snapshot(ws);
        schedulePush(ws);
      } catch (err) {
        ptyManager.log('WARN', 'Cockpit ops: initial detection failed', { workspace: ws, error: String(err) });
      }
    }
  }, 3_000);
  initTimer.unref?.();
}

export function shutdownCockpitOps(): void {
  if (initTimer) clearTimeout(initTimer);
  initTimer = null;
  for (const t of pushTimers.values()) clearTimeout(t);
  pushTimers.clear();
  if (onPtyExit && ptyRef) ptyRef.off('exit', onPtyExit);
  onPtyExit = null;
  agents?.stop();
  runtime?.stop();
  cockpitBus.setOps(null);
  agents = null;
  runtime = null;
}
