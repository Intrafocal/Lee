/**
 * window.lee.cockpit: the renderer half of the Cockpit (v2) IPC contract.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v2-contracts.md (Appendix D).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * Compiled by tsconfig.main.json (no DOM lib).
 */

import { ipcRenderer } from 'electron';
import { COCKPIT_IPC } from '../shared/cockpit';
import type {
  CockpitAPI,
  CreateTabRequest,
  FeedSnapshot,
  GoIntoRequest,
  LintSnapshot,
  OperationsSnapshot,
  TabRuntimeInfo,
} from '../shared/cockpit';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export const cockpitApi: CockpitAPI = {
  tabs: {
    list: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.tabsList, workspace ?? null),
    onChange: (cb) => subscribe<TabRuntimeInfo[]>(COCKPIT_IPC.tabsPush, cb),
    read: (ptyId, req) => ipcRenderer.invoke(COCKPIT_IPC.tabRead, ptyId, req),
    state: (ptyId) => ipcRenderer.invoke(COCKPIT_IPC.tabState, ptyId),
    send: (ptyId, req) => ipcRenderer.invoke(COCKPIT_IPC.tabSend, ptyId, req),
    focus: (ptyId) => ipcRenderer.invoke(COCKPIT_IPC.tabFocus, ptyId),
    rename: (ptyId, name) => ipcRenderer.invoke(COCKPIT_IPC.tabRename, ptyId, name),
  },
  files: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.filesList, workspace),
  checkin: (ptyId, opts) => ipcRenderer.invoke(COCKPIT_IPC.checkin, ptyId, opts ?? {}),
  checkinCancel: (ptyId) => ipcRenderer.invoke(COCKPIT_IPC.checkinCancel, ptyId),
  launch: (req) => ipcRenderer.invoke(COCKPIT_IPC.launch, req),
  feed: {
    get: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.feedGet, workspace ?? null),
    onChange: (cb) => subscribe<FeedSnapshot>(COCKPIT_IPC.feedPush, cb),
    act: (entryId, actionId, payload) => ipcRenderer.invoke(COCKPIT_IPC.feedAct, entryId, actionId, payload ?? {}),
  },
  logEvent: (event) => ipcRenderer.send(COCKPIT_IPC.rendererEvent, event),
  onCreateTab: (cb) => subscribe<CreateTabRequest>(COCKPIT_IPC.createTab, cb),
  createTabResult: (res) => ipcRenderer.send(COCKPIT_IPC.createTabResult, res),
  onGoInto: (cb) => subscribe<GoIntoRequest>(COCKPIT_IPC.goInto, cb),
  ops: {
    list: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.opsList, workspace),
    onChange: (cb) => subscribe<OperationsSnapshot>(COCKPIT_IPC.opsPush, cb),
    run: (req) => ipcRenderer.invoke(COCKPIT_IPC.opsRun, req),
    stop: (workspace, name) => ipcRenderer.invoke(COCKPIT_IPC.opsStop, workspace, name),
    confirm: (workspace, names) => ipcRenderer.invoke(COCKPIT_IPC.opsConfirm, workspace, names),
    dismissSuggestion: (workspace, name) => ipcRenderer.invoke(COCKPIT_IPC.opsDismissSuggestion, workspace, name),
    save: (workspace, def) => ipcRenderer.invoke(COCKPIT_IPC.opsSave, workspace, def),
    linkTab: (ptyId, workspace, name) => ipcRenderer.invoke(COCKPIT_IPC.opsLinkTab, ptyId, workspace, name),
    startAgent: (req) => ipcRenderer.invoke(COCKPIT_IPC.opsAgent, req),
    serialPorts: () => ipcRenderer.invoke(COCKPIT_IPC.opsSerialPorts),
  },
  lint: {
    list: (workspace) => ipcRenderer.invoke(COCKPIT_IPC.lintList, workspace ?? null),
    onChange: (cb) => subscribe<LintSnapshot>(COCKPIT_IPC.lintPush, cb),
    fix: (diagId, fixId) => ipcRenderer.invoke(COCKPIT_IPC.lintFix, diagId, fixId),
    dismiss: (diagId) => ipcRenderer.invoke(COCKPIT_IPC.lintDismiss, diagId),
    suppress: (diagId, scope) => ipcRenderer.invoke(COCKPIT_IPC.lintSuppress, diagId, scope),
    shown: (diagIds, surface) => ipcRenderer.send(COCKPIT_IPC.lintShown, { diag_ids: diagIds, surface }),
    learnTool: (info) => ipcRenderer.send(COCKPIT_IPC.lintLearnTool, info),
  },
};
