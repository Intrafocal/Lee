/**
 * Package A (lee-core) wiring: event log, presence, input capture, device
 * tokens, capture relay and their IPC handlers. Called from main.ts.
 */

import * as os from 'os';
import * as path from 'path';
import { app, BrowserWindow, ipcMain, powerMonitor, WebContents } from 'electron';
import type { APIServer } from '../api-server';
import type { PTYManager } from '../pty-manager';
import type { ContextBridge } from '../context-bridge';
import { windowRegistry } from '../window-registry';
import { COPILOT_IPC } from '../../shared/copilot';
import type { CaptureRequest, CaptureResult, CeremonyAction, DeviceInfo, InputBatch, PresenceState } from '../../shared/copilot';
import { copilotBus, logEvent } from './bus';
import { getCopilotConfig } from './config';
import { EventLogWriter } from './event-log';
import { PresenceTracker } from './presence';
import { InputTracker } from './input-tracker';
import { DeviceTokenStore } from './device-tokens';
import { configureAuth, flushDeviceViews, getDeviceStore, issueDeviceToken, revokeDevice } from './auth';
import { CaptureRelay, getHesterPort, migrateSpool, resolveCaptureWorkspace, setCaptureRelay } from './capture';
import { validateDeviceNameKind } from './core-routes';
import { installTetherIpc } from './tether';

const CEREMONY_ACTIONS = new Set<CeremonyAction>([
  'confirm',
  'dismiss',
  'snooze',
  'assign',
  'required_field',
  'status_dismiss',
  'dialog',
]);

interface CoreState {
  writer: EventLogWriter;
  presence: PresenceTracker;
  input: InputTracker;
  store: DeviceTokenStore;
  capture: CaptureRelay;
  log: PTYManager['log'];
}

let core: CoreState | null = null;
let shutDown = false;

function leeDir(...parts: string[]): string {
  return path.join(os.homedir(), '.lee', ...parts);
}

function windowIdOf(sender: WebContents): number | null {
  return BrowserWindow.fromWebContents(sender)?.id ?? null;
}

function pushToWindows(channel: string, payload: unknown): void {
  for (const ws of windowRegistry.getAll().values()) {
    const bw = ws.browserWindow;
    if (!bw.isDestroyed() && !bw.webContents.isDestroyed()) bw.webContents.send(channel, payload);
  }
}

export function initCopilotCore(deps: { apiServer: APIServer; ptyManager: PTYManager }): void {
  if (core) return;
  const { apiServer, ptyManager } = deps;
  const log: PTYManager['log'] = (level, message, details) => ptyManager.log(level, message, details);
  const cfg = getCopilotConfig();

  const writer = new EventLogWriter({
    dir: leeDir('events'),
    maxFileBytes: cfg.event_log.max_file_mb * 1024 * 1024,
    retentionDays: cfg.event_log.retention_days,
    onError: (err) => log('ERROR', 'Event log write failed', { error: String(err) }),
  });
  const pruned = writer.prune();
  if (pruned > 0) log('INFO', 'Pruned old event log files', { count: pruned });
  copilotBus.setEventSink(writer);

  const presence = new PresenceTracker({
    getSystemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    getConfig: getCopilotConfig,
    onChange: (change) => {
      logEvent({
        type: 'presence.change',
        actor: change.reason === 'lee_input' ? { kind: 'user', surface: 'lee' } : { kind: 'system' },
        data: {
          from: change.from,
          to: change.to,
          reason: change.reason,
          ...(change.away_ms != null ? { away_ms: change.away_ms } : {}),
        },
      });
      pushToWindows(COPILOT_IPC.presencePush, change.state);
      copilotBus.broadcast({ type: 'presence', data: change.state });
    },
  });
  copilotBus.setPresenceProvider(() => presence.get());

  const store = new DeviceTokenStore(leeDir('devices'));
  configureAuth({ store, onDeviceActivity: (p) => presence.noteDevice(p.device_id) });

  // §2.1: captures still spooled under the old name go out from the new one.
  const spoolFile = leeDir('spool', 'ideas.jsonl');
  try {
    const moved = migrateSpool(leeDir('spool', 'someday.jsonl'), spoolFile);
    if (moved > 0) log('INFO', 'Moved spooled captures to ideas.jsonl', { count: moved });
  } catch (err) {
    log('WARN', 'Capture spool migration failed', { error: String(err) });
  }
  const capture = new CaptureRelay({
    spoolFile,
    getHesterPort,
    getSharedToken: () => apiServer.getAuthToken(),
    log,
  });
  setCaptureRelay(capture);

  const input = new InputTracker({ onLeeInput: () => presence.noteLeeInput() });

  core = { writer, presence, input, store, capture, log };

  powerMonitor.on('lock-screen', () => presence.setLocked(true));
  powerMonitor.on('unlock-screen', () => presence.setLocked(false));
  powerMonitor.on('suspend', () => presence.setSuspended(true));
  powerMonitor.on('resume', () => presence.setSuspended(false));
  presence.start();

  copilotBus.onStreamConnect((send) => send({ type: 'presence', data: presence.get() }));

  registerIpc();
  installTetherIpc();

  logEvent({ type: 'app.start', data: { version: app.getVersion(), pid: process.pid } });
}

function registerIpc(): void {
  ipcMain.handle(COPILOT_IPC.presenceGet, (): PresenceState | null => core?.presence.get() ?? null);

  ipcMain.on(COPILOT_IPC.input, (event, batch: InputBatch) => {
    core?.input.addMouse(windowIdOf(event.sender), batch);
  });

  ipcMain.on(COPILOT_IPC.ceremony, (event, payload: { action?: unknown; target?: unknown }) => {
    const action = payload?.action;
    if (typeof action !== 'string' || !CEREMONY_ACTIONS.has(action as CeremonyAction)) return;
    const windowId = windowIdOf(event.sender);
    const target = typeof payload.target === 'string' ? payload.target.slice(0, 64) : undefined;
    logEvent({
      type: 'ui.ceremony',
      window_id: windowId,
      workspace: windowId != null ? windowRegistry.get(windowId)?.workspace ?? null : null,
      actor: { kind: 'user', surface: 'lee' },
      data: { action, ...(target ? { target } : {}) },
    });
  });

  ipcMain.handle(COPILOT_IPC.capture, async (event, req: CaptureRequest): Promise<CaptureResult> => {
    if (!core) return { success: false, error: 'Capture not available' };
    const ws = resolveCaptureWorkspace(req?.workspace, windowIdOf(event.sender));
    if (!ws.ok) return { success: false, error: ws.error };
    return core.capture.capture(
      { text: req?.text, as: req?.as, ...(req?.input === 'voice' ? { input: 'voice' as const } : {}) },
      { actor: { kind: 'user', surface: 'lee' }, source: { surface: 'lee' }, workspace: ws.workspace, window_id: ws.window_id },
    );
  });

  ipcMain.handle(COPILOT_IPC.devicesList, (): DeviceInfo[] => getDeviceStore()?.list() ?? []);

  ipcMain.handle(COPILOT_IPC.devicesRevoke, (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') return { success: false, error: 'deviceId is required' };
    if (!revokeDevice(deviceId, { kind: 'user', surface: 'lee' })) {
      return { success: false, error: 'Unknown or already revoked device' };
    }
    core?.log('INFO', 'Device revoked', { device_id: deviceId });
    return { success: true };
  });

  ipcMain.handle(COPILOT_IPC.devicesCreate, (_event, name: unknown, kind: unknown) => {
    const nk = validateDeviceNameKind(name, kind);
    if (!nk.ok) return { success: false, error: nk.reason };
    try {
      const issued = issueDeviceToken({ name: nk.device, kind: nk.kind, via: 'manual' });
      core?.log('INFO', 'Device token created', { device_id: issued.device_id, device: nk.device, kind: nk.kind });
      return { success: true, device: getDeviceStore()?.get(issued.device_id) ?? undefined, token: issued.token };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}

/** Start counting input and tab focus for a new window. */
export function attachCopilotWindow(bw: BrowserWindow, contextBridge: ContextBridge): void {
  if (!core) return;
  const id = bw.id;
  core.input.attach(bw, contextBridge, () => windowRegistry.get(id)?.workspace ?? null);
}

/** A single-use QR pairing ticket for `aeronaut:get-pairing-qr` (pairVersion 2). */
export function issueQrTicket(): { ticket: string; ticketExpiresIn: number; pairVersion: 2 } {
  const store = getDeviceStore();
  if (!store) throw new Error('Device token store not initialized');
  const { ticket, expiresIn } = store.createTicket();
  return { ticket, ticketExpiresIn: expiresIn, pairVersion: 2 };
}

/** Flush everything synchronously at will-quit. Safe to call more than once. */
export function shutdownCopilotCore(): void {
  if (!core || shutDown) return;
  shutDown = true;
  const { writer, presence, input, store, capture } = core;
  try {
    input.dispose();
    flushDeviceViews();
    presence.stop();
    capture.stop();
    store.flush();
  } catch (err) {
    console.error('[copilot] shutdown flush failed:', err);
  }
  logEvent({ type: 'app.quit', data: {} });
  writer.flushSync();
}
