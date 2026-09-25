/**
 * window.lee.copilot: the renderer half of the Copilot IPC contract, plus the
 * mouse-input reporter (counts only, never targets or content).
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix D).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * Compiled by tsconfig.main.json (no DOM lib), so DOM access goes through a
 * minimal structural type on globalThis.
 */

import { ipcRenderer } from 'electron';
import { COPILOT_IPC } from '../shared/copilot';
import type {
  AttentionSnapshot,
  CeremonyAction,
  CopilotAPI,
  InputBatch,
  PresenceState,
  ReturnInfo,
} from '../shared/copilot';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

type ListenerTarget = {
  addEventListener?: (type: string, cb: () => void, opts?: { capture?: boolean; passive?: boolean }) => void;
};

/** Batch mouse clicks and wheel events; send at most one IPC per second while active. */
function installInputReporter(): void {
  const target = globalThis as unknown as ListenerTarget;
  if (typeof target.addEventListener !== 'function') return;
  let clicks = 0;
  let wheels = 0;
  let first = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (clicks === 0 && wheels === 0) return;
    const batch: InputBatch = { clicks, wheels, span_ms: Date.now() - first };
    clicks = 0;
    wheels = 0;
    ipcRenderer.send(COPILOT_IPC.input, batch);
  };
  const bump = (kind: 'click' | 'wheel') => {
    if (clicks === 0 && wheels === 0) first = Date.now();
    if (kind === 'click') clicks++;
    else wheels++;
    if (!timer) timer = setTimeout(flush, 1000);
  };
  const opts = { capture: true, passive: true };
  target.addEventListener('mousedown', () => bump('click'), opts);
  target.addEventListener('wheel', () => bump('wheel'), opts);
}

installInputReporter();

export const copilotApi: CopilotAPI = {
  getPresence: () => ipcRenderer.invoke(COPILOT_IPC.presenceGet),
  onPresence: (cb) => subscribe<PresenceState>(COPILOT_IPC.presencePush, cb),
  logCeremony: (action: CeremonyAction, target?: string) =>
    ipcRenderer.send(COPILOT_IPC.ceremony, { action, target }),
  capture: (req) => ipcRenderer.invoke(COPILOT_IPC.capture, req),
  devices: {
    list: () => ipcRenderer.invoke(COPILOT_IPC.devicesList),
    revoke: (deviceId) => ipcRenderer.invoke(COPILOT_IPC.devicesRevoke, deviceId),
    create: (name, kind) => ipcRenderer.invoke(COPILOT_IPC.devicesCreate, name, kind),
  },
  getSnapshot: () => ipcRenderer.invoke(COPILOT_IPC.snapshotGet),
  onSnapshot: (cb) => subscribe<AttentionSnapshot>(COPILOT_IPC.snapshotPush, cb),
  reply: (itemId, req) => ipcRenderer.invoke(COPILOT_IPC.reply, itemId, req),
  snooze: (itemId, req) => ipcRenderer.invoke(COPILOT_IPC.snooze, itemId, req),
  dismiss: (itemId) => ipcRenderer.invoke(COPILOT_IPC.dismiss, itemId),
  setWake: (itemId, wake) => ipcRenderer.invoke(COPILOT_IPC.wake, itemId, wake),
  openItem: (itemId) => ipcRenderer.invoke(COPILOT_IPC.open, itemId),
  focusStart: (item) => ipcRenderer.invoke(COPILOT_IPC.focusStart, item ?? null),
  focusStop: () => ipcRenderer.invoke(COPILOT_IPC.focusStop),
  handoffProposals: () => ipcRenderer.invoke(COPILOT_IPC.handoffProposals),
  handoffStart: (req) => ipcRenderer.invoke(COPILOT_IPC.handoffStart, req),
  handoffEnd: () => ipcRenderer.invoke(COPILOT_IPC.handoffEnd),
  onReturn: (cb) => subscribe<ReturnInfo>(COPILOT_IPC.returnPush, cb),
};
