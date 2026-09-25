/**
 * Input counts per tab, tab focus and window focus (contracts §3.2).
 *
 * Keyboard: `before-input-event` on each window's webContents, counting
 * non-repeat keyDowns. Mouse: `copilot:input` batches from the preload. Only
 * counts are kept; nothing about which key or where is ever stored.
 *
 * Counts accumulate per (window, tab) and flush as `input.counts` every 60 s,
 * on a tab change and at quit.
 */

import type { BrowserWindow } from 'electron';
import type { InputBatch } from '../../shared/copilot';
import type { TabContext } from '../../shared/context';
import type { ContextBridge } from '../context-bridge';
import { logEvent } from './bus';

const FLUSH_MS = 60_000;
const MAX_BATCH = 10_000;

interface TabInfo {
  tab_id: number | null;
  tab_type: string | null;
  provider?: string;
  pty_id?: number;
  file_path?: string;
  label: string;
}

interface Counter {
  window_id: number;
  workspace: string | null;
  tab: TabInfo;
  keys: number;
  clicks: number;
  wheels: number;
  firstAt: number;
  lastAt: number;
}

interface WindowEntry {
  bw: BrowserWindow;
  bridge: ContextBridge;
  getWorkspace: () => string | null;
  activeTabId: number | null;
  dispose: () => void;
}

function tabInfo(tab: TabContext | undefined, fallbackId: number | null): TabInfo {
  if (!tab) return { tab_id: fallbackId, tab_type: null, label: '' };
  return {
    tab_id: tab.id,
    tab_type: tab.type,
    ...(tab.provider ? { provider: tab.provider } : {}),
    ...(tab.ptyId != null ? { pty_id: tab.ptyId } : {}),
    ...(tab.filePath ? { file_path: tab.filePath } : {}),
    label: tab.label,
  };
}

export class InputTracker {
  private windows = new Map<number, WindowEntry>();
  private counters = new Map<string, Counter>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onLeeInput: () => void;

  constructor(opts: { onLeeInput: () => void }) {
    this.onLeeInput = opts.onLeeInput;
    this.timer = setInterval(() => this.flushAll(), FLUSH_MS);
    this.timer.unref?.();
  }

  attach(bw: BrowserWindow, bridge: ContextBridge, getWorkspace: () => string | null): void {
    const id = bw.id;
    const wc = bw.webContents;

    const onInput = (_event: Electron.Event, input: Electron.Input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      this.count(id, 'keys', 1);
      this.onLeeInput();
    };
    const onChange = () => this.checkActiveTab(id);
    const onFocus = () => {
      const entry = this.windows.get(id);
      if (!entry) return;
      logEvent({ type: 'window.focus', window_id: id, workspace: entry.getWorkspace(), data: { focused: true } });
      const tab = this.resolveActiveTab(entry);
      entry.activeTabId = tab.tab_id;
      this.logTabFocus(id, entry, tab, undefined);
    };
    const onBlur = () => {
      const entry = this.windows.get(id);
      if (!entry) return;
      this.flushWindow(id);
      logEvent({ type: 'window.focus', window_id: id, workspace: entry.getWorkspace(), data: { focused: false } });
    };
    const onClosed = () => this.detach(id);

    wc.on('before-input-event', onInput);
    bridge.on('change', onChange);
    bw.on('focus', onFocus);
    bw.on('blur', onBlur);
    bw.once('closed', onClosed);

    const entry: WindowEntry = {
      bw,
      bridge,
      getWorkspace,
      activeTabId: null,
      dispose: () => {
        bridge.removeListener('change', onChange);
        if (!wc.isDestroyed()) wc.removeListener('before-input-event', onInput);
        if (!bw.isDestroyed()) {
          bw.removeListener('focus', onFocus);
          bw.removeListener('blur', onBlur);
        }
      },
    };
    entry.activeTabId = this.resolveActiveTab(entry).tab_id;
    this.windows.set(id, entry);
  }

  /** Mouse counts from the preload, attributed to the sender's window. */
  addMouse(windowId: number | null, batch: InputBatch): void {
    if (windowId == null || !this.windows.has(windowId) || !batch || typeof batch !== 'object') return;
    const clicks = Math.min(MAX_BATCH, Math.max(0, Math.floor(Number(batch.clicks) || 0)));
    const wheels = Math.min(MAX_BATCH, Math.max(0, Math.floor(Number(batch.wheels) || 0)));
    if (clicks === 0 && wheels === 0) return;
    const span = Math.min(60_000, Math.max(0, Number(batch.span_ms) || 0));
    if (clicks) this.count(windowId, 'clicks', clicks, span);
    if (wheels) this.count(windowId, 'wheels', wheels, span);
    this.onLeeInput();
  }

  flushAll(): void {
    for (const key of [...this.counters.keys()]) this.flushKey(key);
  }

  dispose(): void {
    this.flushAll();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.windows.keys()]) this.detach(id);
  }

  private detach(id: number): void {
    this.flushWindow(id);
    const entry = this.windows.get(id);
    if (!entry) return;
    entry.dispose();
    this.windows.delete(id);
  }

  private resolveActiveTab(entry: WindowEntry): TabInfo {
    try {
      const ctx = entry.bridge.getContext();
      const activeId = ctx.panels?.[ctx.focusedPanel]?.activeTabId ?? null;
      if (activeId == null) return tabInfo(undefined, null);
      return tabInfo(ctx.tabs.find((t) => t.id === activeId), activeId);
    } catch {
      return tabInfo(undefined, null);
    }
  }

  /** Detect a change of the focused panel's active tab; flush the old tab's counts and log `tab.focus`. */
  private checkActiveTab(id: number): TabInfo | null {
    const entry = this.windows.get(id);
    if (!entry) return null;
    const tab = this.resolveActiveTab(entry);
    if (tab.tab_id !== entry.activeTabId) {
      const prev = entry.activeTabId;
      this.flushWindow(id);
      entry.activeTabId = tab.tab_id;
      if (!entry.bw.isDestroyed() && entry.bw.isFocused()) this.logTabFocus(id, entry, tab, prev);
    }
    return tab;
  }

  private logTabFocus(id: number, entry: WindowEntry, tab: TabInfo, prev: number | null | undefined): void {
    if (tab.tab_id == null) return;
    logEvent({
      type: 'tab.focus',
      window_id: id,
      workspace: entry.getWorkspace(),
      actor: { kind: 'user', surface: 'lee' },
      data: { ...tab, ...(prev != null ? { prev_tab_id: prev } : {}) },
    });
  }

  private count(windowId: number, field: 'keys' | 'clicks' | 'wheels', n: number, spanMs = 0): void {
    const entry = this.windows.get(windowId);
    if (!entry) return;
    const tab = this.checkActiveTab(windowId) ?? tabInfo(undefined, null);
    const key = `${windowId}:${tab.tab_id ?? 'none'}`;
    const now = Date.now();
    let c = this.counters.get(key);
    if (!c) {
      c = {
        window_id: windowId,
        workspace: entry.getWorkspace(),
        tab,
        keys: 0,
        clicks: 0,
        wheels: 0,
        firstAt: now - spanMs,
        lastAt: now,
      };
      this.counters.set(key, c);
    }
    c.tab = tab;
    c[field] += n;
    c.firstAt = Math.min(c.firstAt, now - spanMs);
    c.lastAt = now;
  }

  private flushWindow(windowId: number): void {
    const prefix = `${windowId}:`;
    for (const key of [...this.counters.keys()]) if (key.startsWith(prefix)) this.flushKey(key);
  }

  private flushKey(key: string): void {
    const c = this.counters.get(key);
    this.counters.delete(key);
    if (!c || c.keys + c.clicks + c.wheels === 0) return;
    const { label: _label, ...tab } = c.tab;
    logEvent({
      type: 'input.counts',
      window_id: c.window_id,
      workspace: c.workspace,
      actor: { kind: 'user', surface: 'lee' },
      data: { ...tab, keys: c.keys, clicks: c.clicks, wheels: c.wheels, span_ms: Math.max(0, c.lastAt - c.firstAt) },
    });
  }
}
