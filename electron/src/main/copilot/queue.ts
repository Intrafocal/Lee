/**
 * Copilot queue wiring (package B): hooks -> agent sessions -> attention
 * queue, focus sessions, the v1 away policy and handoff, Reply into PTYs,
 * IPC handlers, bus subscriptions and stream pushes.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §5, §6, §7.
 */

import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import { windowRegistry } from '../window-registry';
import type { PTYManager } from '../pty-manager';
import { COPILOT_IPC } from '../../shared/copilot';
import type {
  ActionResult,
  Actor,
  AttentionItem,
  AttentionSnapshot,
  AttentionSource,
  AwayState,
  FocusItem,
  FocusState,
  HandoffAgent,
  HandoffLaunch,
  HandoffProposals,
  HandoffRequest,
  HandoffResult,
  LeeEvent,
  LeeEventInput,
  LeeStatusBlock,
  PresenceState,
  ReplyRequest,
  ReturnInfo,
  SnoozeRequest,
} from '../../shared/copilot';
import { copilotBus, logEvent } from './bus';
import { getCopilotConfig, inQuietHours } from './config';
import {
  AGENT_TEXT_MAX,
  classifyNotification,
  clip,
  isWriteTool,
  normalizeHook,
  parseLeeStatus,
  readTranscriptTail,
  toolFiles,
  toolPreview,
  toolSignature,
} from './hook-payload';
import { AgentSession, AgentSessions } from './agent-sessions';
import { AttentionQueue, KIND_TITLES, sourceKey } from './attention-queue';
import { FocusTracker, parseFocusItem } from './focus';
import { AwayPolicy, normalizeSummaryPolicy } from './away';
import { checkReply, sanitizeReplyText, writeReply, writeText } from './reply';
import { claudeSettingsPath, hookPaths, installClaudeHooks, writeAuthHeader } from './hook-install';

export const LEE_STATUS_HINT =
  'When you finish a unit of work or need a decision, you may end your message with a fenced lee-status block ' +
  '(status: done / in-progress / blocked / waiting; summary; blockers; files; next). It is optional.';

const TICK_MS = 15_000;
const IPC_DEBOUNCE_MS = 100;
const WS_DEBOUNCE_MS = 250;
const SESSION_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_SNOOZE_MINUTES = 7 * 24 * 60;
const PERMISSION_MODES = new Set<HandoffLaunch['permission_mode']>(['acceptEdits', 'default', 'plan']);
/**
 * A PreToolUse from the same agent (main or one subagent) arriving this long
 * after an approval opened means the agent moved past that prompt. The grace
 * covers parallel calls of one message, which start together.
 */
const NEWER_TOOL_GRACE_MS = 2_000;
/** Keys that answer Claude Code's permission prompt when typed in the tab. */
const PROMPT_ACCEPT_INPUT = /^(\r|[1-9])$/;
const PROMPT_CANCEL_INPUT = '\x1b';

/** What an approval item was opened for, to match the call that finishes it. */
interface ApprovalMeta {
  tool_use_id: string | null;
  agent_id: string | null;
  opened_at: number;
}

/** An HTTP-shaped outcome, shared by the routes and the IPC handlers. */
export interface Outcome<T> {
  status: number;
  body: T;
  /** Device attribution category (§4.5), for the route to put on res.locals. */
  category?: string;
  error?: string;
}

export interface HookHeaders {
  event: string | null;
  ptyId: string | null;
  windowId: string | null;
}

interface TabInfo {
  window_id: number;
  tab_id: number;
  label: string;
  workspace: string | null;
}

const LEE_ACTOR: Actor = { kind: 'user', surface: 'lee' };

function parseId(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function slugify(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'agent'}-${suffix}`;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class CopilotQueue {
  readonly sessions = new AgentSessions();
  readonly away = new AwayPolicy();
  readonly focus: FocusTracker;
  readonly queue: AttentionQueue;

  private ipcTimer: ReturnType<typeof setTimeout> | null = null;
  private wsTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** Approval item id -> the tool call it is about. Pruned as items close. */
  private approvalMeta = new Map<string, ApprovalMeta>();

  constructor(private ptyManager: PTYManager) {
    this.focus = new FocusTracker({
      isAgentPty: (ptyId) => !!this.sessions.byPty(ptyId),
      log: (input) => this.log(input),
    });
    this.queue = new AttentionQueue({
      log: (input) => this.log(input),
      config: () => getCopilotConfig(),
      quietHours: (at) => inQuietHours(at),
      focus: this.focus,
      away: this.away,
      sessionFiles: (item) => {
        const s = item.source.session_id ? this.sessions.get(item.source.session_id) : undefined;
        return s ? s.files_written : item.files ?? [];
      },
      hasSurface: () => windowRegistry.getAll().size > 0,
    });
  }

  private log(input: LeeEventInput): void {
    logEvent(input);
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      installClaudeHooks();
    } catch (err) {
      this.ptyManager.log('WARN', 'Copilot: could not write Claude hook files', { error: String(err) });
    }
    try {
      const tokenFile = hookPaths().tokenFile;
      fs.watchFile(tokenFile, { interval: 10_000 }, () => {
        try {
          writeAuthHeader();
        } catch {
          // retried on the next change
        }
      }).unref();
    } catch {
      // token watch is best effort
    }

    copilotBus.setFocusProvider(() => ({ focus_session_id: this.focus.sessionId, away: this.away.active }));
    copilotBus.onStreamConnect((send) => send({ type: 'attention_snapshot', data: this.snapshot({ compact: true }) }));
    copilotBus.on('event', (e: LeeEvent) => {
      try {
        this.onBusEvent(e);
      } catch (err) {
        console.error('[copilot] queue bus handler failed:', err);
      }
    });

    this.ptyManager.on('user-input', (id: number, data: string) => {
      try {
        this.onUserInput(id, data);
      } catch (err) {
        console.error('[copilot] pty input handling failed:', err);
      }
    });

    this.ptyManager.on('exit', (id: number, code: number) => {
      try {
        this.onPtyExit(id, code);
      } catch (err) {
        console.error('[copilot] pty exit handling failed:', err);
      }
    });

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();

    app.on('before-quit', () => {
      if (this.focus.stop('quit', Date.now())) this.flushPushes();
    });

    this.registerIpc();
    this.ptyManager.log('INFO', 'Copilot queue started', { settings: claudeSettingsPath() });
  }

  private tick(): void {
    try {
      const now = Date.now();
      const cfg = getCopilotConfig();
      this.focus.tick(now, this.presence(), cfg.focus);
      if (this.away.summaryDue(now)) this.deliverSummary(now);
      this.queue.recompute(now);
      this.queue.prune(now);
      this.sessions.prune(now, SESSION_KEEP_MS);
      for (const id of Array.from(this.approvalMeta.keys())) {
        const item = this.queue.get(id);
        if (!item || (item.state !== 'open' && item.state !== 'snoozed')) this.approvalMeta.delete(id);
      }
    } catch (err) {
      console.error('[copilot] queue tick failed:', err);
    }
  }

  private presence(): PresenceState | null {
    return copilotBus.getPresence();
  }

  // ---------------------------------------------------------------------------
  // Pushes
  // ---------------------------------------------------------------------------

  private changed(): void {
    if (!this.started) return;
    if (!this.ipcTimer) {
      this.ipcTimer = setTimeout(() => {
        this.ipcTimer = null;
        this.pushIpc();
      }, IPC_DEBOUNCE_MS);
    }
    if (!this.wsTimer) {
      this.wsTimer = setTimeout(() => {
        this.wsTimer = null;
        copilotBus.broadcast({ type: 'attention_snapshot', data: this.snapshot({ compact: true }) });
      }, WS_DEBOUNCE_MS);
    }
  }

  private flushPushes(): void {
    if (this.ipcTimer) {
      clearTimeout(this.ipcTimer);
      this.ipcTimer = null;
    }
    this.pushIpc();
  }

  private pushIpc(): void {
    const snap = this.snapshot();
    for (const ws of windowRegistry.getAll().values()) {
      if (!ws.browserWindow.isDestroyed()) ws.browserWindow.webContents.send(COPILOT_IPC.snapshotPush, snap);
    }
  }

  private pushReturn(info: ReturnInfo): void {
    for (const ws of windowRegistry.getAll().values()) {
      if (!ws.browserWindow.isDestroyed()) ws.browserWindow.webContents.send(COPILOT_IPC.returnPush, info);
    }
    copilotBus.broadcast({ type: 'copilot_return', data: info });
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  focusState(): FocusState {
    return this.focus.state(this.queue.quietCount());
  }

  awayState(): AwayState {
    return this.away.snapshot(this.queue.parkedCount());
  }

  snapshot(opts: { compact?: boolean; all?: boolean } = {}): AttentionSnapshot {
    const now = Date.now();
    this.queue.recompute(now);
    return this.queue.snapshot(this.focusState(), this.awayState(), opts, now);
  }

  getItem(id: string): AttentionItem | undefined {
    this.queue.recompute(Date.now());
    return this.queue.get(id);
  }

  // ---------------------------------------------------------------------------
  // Tabs and sources
  // ---------------------------------------------------------------------------

  private findTab(ptyId: number): TabInfo | null {
    for (const [windowId, ws] of windowRegistry.getAll()) {
      let ctx;
      try {
        ctx = ws.contextBridge.getContext();
      } catch {
        continue;
      }
      const tab = ctx.tabs.find((t) => t.ptyId === ptyId);
      if (tab) return { window_id: windowId, tab_id: tab.id, label: tab.label, workspace: ws.workspace ?? ctx.workspace ?? null };
    }
    return null;
  }

  private sourceFor(s: AgentSession | null, ptyId: number | null, cwd: string | null, headerWindow: number | null): AttentionSource {
    const tab = ptyId != null ? this.findTab(ptyId) : null;
    const procWindow = ptyId != null ? this.ptyManager.get(ptyId)?.windowId ?? null : null;
    const windowId = tab?.window_id ?? procWindow ?? headerWindow;
    const winWorkspace = windowId != null ? windowRegistry.get(windowId)?.workspace ?? null : null;
    return {
      kind: 'agent',
      provider: s?.provider ?? 'claude',
      session_id: s?.session_id ?? null,
      pty_id: ptyId,
      window_id: windowId,
      tab_id: tab?.tab_id ?? null,
      tab_label: tab?.label ?? null,
      workspace: tab?.workspace ?? winWorkspace ?? cwd ?? s?.cwd ?? null,
      cwd: cwd ?? s?.cwd ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Hooks (§6.4)
  // ---------------------------------------------------------------------------

  handleHook(headers: HookHeaders, body: unknown): Outcome<string | null> {
    const now = Date.now();
    const h = normalizeHook(headers.event, body);
    // X-Lee-Pty-Id is only believed for a PTY Lee spawned as Claude Code, so a
    // hook POST can't point a Reply (paste + Enter) at a plain shell tab.
    const claimedPty = parseId(headers.ptyId);
    const headerPty = claimedPty != null && this.ptyManager.isClaudePty(claimedPty) ? claimedPty : null;
    const sessionId = h.session_id ?? (headerPty != null ? this.sessions.byPty(headerPty)?.session_id ?? null : null);
    if (!h.event || !sessionId) return { status: 204, body: null };

    const cfg = getCopilotConfig();
    const ptyId = this.sessions.resolvePty(sessionId, headerPty);
    const s = this.sessions.ensure(sessionId, ptyId, h.cwd, now);
    // A hidden prewarmed Claude has no tab: keep its session (a tab adopts it
    // later) and answer SessionStart, but open no items for it.
    if (ptyId != null && h.event !== 'SessionStart' && this.ptyManager.isWarmPty(ptyId)) return { status: 204, body: null };
    const src = this.sourceFor(s, ptyId, h.cwd, parseId(headers.windowId));
    const key = sourceKey(src);
    const agent: Actor = { kind: 'agent', provider: 'claude', session_id: s.session_id, pty_id: ptyId };
    const ev = (type: LeeEventInput['type'], data: Record<string, unknown>) =>
      this.log({
        type,
        source: 'hook',
        workspace: src.workspace,
        window_id: src.window_id,
        actor: agent,
        data: { session_id: s.session_id, ...(ptyId != null ? { pty_id: ptyId } : {}), ...data },
      });

    if (this.queue.touchKey(key, now)) this.changed();

    switch (h.event) {
      case 'SessionStart': {
        ev('agent.session_start', { provider: 'claude', ...(h.cwd ? { cwd: h.cwd } : {}), ...(h.source ? { source: h.source } : {}) });
        if (cfg.hooks.lee_status_hint) return { status: 200, body: LEE_STATUS_HINT };
        return { status: 204, body: null };
      }
      case 'UserPromptSubmit': {
        ev('agent.prompt', { prompt_chars: h.prompt_chars ?? 0 });
        this.sessions.startBusy(s, now, true);
        s.awaiting_approval = false;
        this.queue.resolveWhere(
          (i) => sourceKey(i.source) === key && ['approval', 'waiting', 'blocker', 'decision', 'review'].includes(i.kind),
          'answered_in_tab',
          now,
        );
        break;
      }
      case 'PreToolUse': {
        const tool = h.tool_name ?? 'unknown';
        const files = toolFiles(h.tool_input);
        const writes = isWriteTool(tool);
        const signature = toolSignature(tool, h.tool_input);
        ev('agent.tool', { phase: 'pre', tool, files, writes, signature });
        this.sessions.openTool(s, {
          name: tool,
          preview: toolPreview(tool, h.tool_input),
          signature,
          tool_use_id: h.tool_use_id,
          agent_id: h.agent_id,
          files,
        });
        if (writes) this.sessions.addWritten(s, files);
        // The same agent started a newer call, so it is past its prompt.
        const passed = this.queue.resolveWhere(
          (i) => {
            if (sourceKey(i.source) !== key || i.kind !== 'approval') return false;
            const m = this.approvalMeta.get(i.id);
            return (
              !!m && !!m.tool_use_id && !!h.tool_use_id && m.tool_use_id !== h.tool_use_id &&
              m.agent_id === h.agent_id && now - m.opened_at >= NEWER_TOOL_GRACE_MS
            );
          },
          'answered_in_tab',
          now,
        );
        if (passed > 0 && this.queue.findLive(key, ['approval']).length === 0) s.awaiting_approval = false;
        this.sessions.startBusy(s, now, false);
        break;
      }
      case 'PermissionRequest': {
        const sig = h.tool_name ? toolSignature(h.tool_name, h.tool_input) : null;
        const started = this.sessions.findOpenTool(s, h.tool_use_id, sig) ?? (h.tool_name ? null : s.pending_tool);
        const tool = h.tool_name
          ? { name: h.tool_name, preview: toolPreview(h.tool_name, h.tool_input), signature: sig as string }
          : started
            ? { name: started.name, preview: started.preview, signature: started.signature }
            : null;
        const item = this.queue.open(
          {
            kind: 'approval',
            title: `Claude wants to use ${tool?.name ?? 'a tool'}`,
            text: tool?.preview ?? '',
            source: src,
            tool,
            files: [...s.files_written],
          },
          now,
        );
        this.noteApproval(item.id, h.tool_use_id ?? started?.tool_use_id ?? null, h.agent_id ?? started?.agent_id ?? null, now);
        ev('agent.waiting', { item_id: item.id, kind: 'approval' });
        s.awaiting_approval = true;
        this.sessions.pauseBusy(s, now);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const failed = h.event === 'PostToolUseFailure';
        const tool = h.tool_name ?? s.pending_tool?.name ?? 'unknown';
        const files = toolFiles(h.tool_input);
        const writes = isWriteTool(tool);
        const sig = toolSignature(tool, h.tool_input);
        ev('agent.tool', { phase: 'post', tool, files, writes, signature: sig, ...(failed ? { failed: true } : {}) });
        if (writes && !failed) this.sessions.addWritten(s, files);
        // Only the approval for this call: parallel or subagent calls to the
        // same tool must not clear a prompt that is still showing.
        this.queue.resolveWhere(
          (i) => sourceKey(i.source) === key && i.kind === 'approval' && this.approvalMatches(i, h.tool_use_id, sig, tool),
          'answered_in_tab',
          now,
        );
        this.sessions.closeTool(s, h.tool_use_id, sig);
        if (this.queue.findLive(key, ['approval']).length === 0) {
          s.awaiting_approval = false;
          this.sessions.resumeBusy(s, now);
        }
        break;
      }
      case 'Notification': {
        const cls = classifyNotification(h.message, h.notification_type);
        if (cls === 'ignore') break;
        const nt = h.notification_type ? { notification_type: h.notification_type } : {};
        if (cls !== 'approval' && h.notification_type === 'idle_prompt') {
          // Claude is back at its input: any prompt is gone (Esc on a
          // permission prompt interrupts the turn and fires no Stop).
          this.queue.resolveWhere((i) => sourceKey(i.source) === key && i.kind === 'approval', 'answered_in_tab', now);
          if (s.in_turn || s.awaiting_approval) this.sessions.interrupt(s, now);
        }
        if (cls === 'approval') {
          const open = this.queue.findLive(key, ['approval'])[0];
          let item: AttentionItem | undefined;
          if (open) {
            item = this.queue.update(open.id, { text: h.message ?? open.text }, now);
          } else {
            const p = s.pending_tool;
            item = this.queue.open(
              {
                kind: 'approval',
                title: `Claude wants to use ${p?.name ?? 'a tool'}`,
                text: h.message ?? p?.preview ?? '',
                source: src,
                tool: p ? { name: p.name, preview: p.preview, signature: p.signature } : null,
                files: [...s.files_written],
              },
              now,
            );
          }
          if (item) {
            if (!open) this.noteApproval(item.id, s.pending_tool?.tool_use_id ?? null, s.pending_tool?.agent_id ?? null, now);
            ev('agent.waiting', { ...nt, item_id: item.id, kind: 'approval' });
          }
          s.awaiting_approval = true;
          this.sessions.pauseBusy(s, now);
        } else {
          const existing = this.queue.findLive(key, ['waiting', 'blocker', 'decision'])[0];
          const item =
            existing ??
            this.queue.open(
              {
                kind: 'waiting',
                title: KIND_TITLES.waiting,
                text: [h.message, s.last_summary].filter((x): x is string => !!x).join('\n\n'),
                source: src,
                lee_status: s.last_lee_status,
                files: [...s.files_written],
              },
              now,
            );
          ev('agent.waiting', { ...nt, item_id: item.id, kind: 'waiting' });
          // Outside a turn the agent is idle, not paused: a dismissed idle
          // item must not keep it from taking a handoff follow-up.
          if (s.in_turn) this.sessions.pauseBusy(s, now);
        }
        break;
      }
      case 'Stop': {
        const busyMs = this.sessions.endTurn(s, now);
        const full = (h.last_assistant_message ?? (h.transcript_path ? readTranscriptTail(h.transcript_path) : null))?.trim() || null;
        // The hint asks for the lee-status block at the END of the message, so
        // parse the full text before clipping the stored summary.
        const lee = parseLeeStatus(full);
        const summary = full ? clip(full, AGENT_TEXT_MAX) : null;
        s.last_summary = summary;
        s.last_lee_status = lee;
        ev('agent.turn_end', { busy_ms: busyMs, ...(summary ? { summary } : {}), ...(lee ? { lee_status: lee } : {}) });
        this.away.noteTurnEnd();
        this.queue.resolveWhere((i) => sourceKey(i.source) === key && i.kind === 'approval', 'answered_in_tab', now);
        this.openTurnItem(s, src, summary, lee, now);
        break;
      }
      case 'SessionEnd': {
        ev('agent.session_end', h.reason ? { reason: h.reason } : {});
        this.queue.resolveWhere(
          (i) => i.source.session_id === s.session_id && i.kind !== 'failure' && i.kind !== 'summary',
          'superseded',
          now,
        );
        this.sessions.end(s);
        this.away.noteSessionEnd();
        break;
      }
    }
    return { status: 204, body: null };
  }

  private openTurnItem(
    s: AgentSession,
    src: AttentionSource,
    summary: string | null,
    lee: LeeStatusBlock | null,
    now: number,
  ): void {
    const text = summary ?? '';
    const files = [...s.files_written];
    if (lee?.status === 'blocked') {
      this.queue.open({ kind: 'blocker', title: KIND_TITLES.blocker, text: lee.blockers ?? lee.summary ?? text, source: src, lee_status: lee, files }, now);
    } else if (lee?.status === 'waiting') {
      this.queue.open(
        { kind: 'decision', title: KIND_TITLES.decision, text: lee.blockers ?? lee.next ?? lee.summary ?? text, source: src, lee_status: lee, files },
        now,
      );
    } else {
      this.queue.open({ kind: 'review', title: KIND_TITLES.review, text, source: src, lee_status: lee, files }, now);
    }
  }

  private onPtyExit(ptyId: number, code: number): void {
    if (!this.sessions.isTrackedPty(ptyId)) return;
    const now = Date.now();
    const last = this.sessions.latestForPty(ptyId) ?? null;
    const src = this.sourceFor(last, ptyId, null, null);
    this.sessions.endPty(ptyId);
    this.log({
      type: 'agent.exit',
      source: 'lee-main',
      workspace: src.workspace,
      window_id: src.window_id,
      actor: { kind: 'agent', provider: 'claude', session_id: last?.session_id ?? null, pty_id: ptyId },
      data: { pty_id: ptyId, code, ...(last ? { session_id: last.session_id } : {}) },
    });
    this.queue.resolveWhere((i) => i.source.pty_id === ptyId && i.kind !== 'summary', 'agent_exit', now);
    if (code !== 0) {
      this.queue.open(
        { kind: 'failure', title: `Claude exited (code ${code})`, text: last?.last_summary ?? '', source: src, files: last ? [...last.files_written] : [] },
        now,
      );
    }
  }

  private noteApproval(itemId: string, toolUseId: string | null, agentId: string | null, now: number): void {
    const prev = this.approvalMeta.get(itemId);
    this.approvalMeta.set(itemId, {
      tool_use_id: toolUseId ?? prev?.tool_use_id ?? null,
      agent_id: toolUseId ? agentId : prev?.agent_id ?? agentId,
      opened_at: prev?.opened_at ?? now,
    });
  }

  /** Does a finished call (PostToolUse[Failure]) belong to this approval? */
  private approvalMatches(item: AttentionItem, toolUseId: string | null, signature: string, tool: string): boolean {
    const m = this.approvalMeta.get(item.id);
    if (m?.tool_use_id && toolUseId) return m.tool_use_id === toolUseId;
    if (item.tool?.signature) return item.tool.signature === signature;
    return !item.tool || item.tool.name === tool;
  }

  /**
   * A person typed into a PTY. Enter, a digit or Esc while the agent sits on
   * a permission prompt answers it in the tab: close the approval so a
   * device can't later send a stale approve/deny into the running agent.
   */
  private onUserInput(ptyId: number, data: string): void {
    const s = this.sessions.byPty(ptyId);
    if (!s || !s.awaiting_approval) return;
    const accept = PROMPT_ACCEPT_INPUT.test(data);
    const cancel = data === PROMPT_CANCEL_INPUT;
    if (!accept && !cancel) return;
    const now = Date.now();
    const key = `pty:${ptyId}`;
    const open = this.queue
      .findLive(key, ['approval'])
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    if (open) this.queue.resolve(open.id, 'answered_in_tab', now);
    if (cancel) {
      // Esc declines and interrupts the turn; Claude fires no Stop for it.
      this.queue.resolveWhere((i) => sourceKey(i.source) === key && i.kind === 'approval', 'answered_in_tab', now);
      this.sessions.interrupt(s, now);
    } else if (this.queue.findLive(key, ['approval']).length === 0) {
      s.awaiting_approval = false;
      this.sessions.resumeBusy(s, now);
    }
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Bus events (input.counts, tab.focus, presence.change)
  // ---------------------------------------------------------------------------

  private onBusEvent(e: LeeEvent): void {
    const d = obj(e.data);
    if (e.type === 'input.counts') {
      const changed = this.focus.record(
        {
          window_id: e.window_id,
          tab_id: typeof d.tab_id === 'number' ? d.tab_id : null,
          pty_id: typeof d.pty_id === 'number' ? d.pty_id : null,
          file_path: typeof d.file_path === 'string' ? d.file_path : null,
          workspace: e.workspace,
          label: typeof d.label === 'string' ? d.label : null,
          keys: typeof d.keys === 'number' ? d.keys : 0,
          clicks: typeof d.clicks === 'number' ? d.clicks : 0,
        },
        Date.parse(e.ts) || Date.now(),
      );
      if (changed) this.changed();
    } else if (e.type === 'tab.focus') {
      const ptyId = typeof d.pty_id === 'number' ? d.pty_id : null;
      if (ptyId != null) {
        this.queue.resolveWhere((i) => i.kind === 'review' && i.source.pty_id === ptyId, 'answered_in_tab', Date.now());
      }
    } else if (e.type === 'presence.change') {
      this.onPresenceChange(obj(d.from), obj(d.to), d.away_ms);
    }
  }

  private onPresenceChange(from: Record<string, unknown>, to: Record<string, unknown>, awayMsRaw: unknown): void {
    const now = Date.now();
    if (this.away.active) {
      if (from.lee_active === false && to.lee_active === true) this.endHandoff('return');
      return;
    }
    if (from.at_machine === false && to.at_machine === true) {
      const awayMs = typeof awayMsRaw === 'number' ? awayMsRaw : 0;
      if (awayMs >= getCopilotConfig().away.return_min_away_minutes * 60_000) {
        this.pushReturn({
          reason: 'presence',
          away_since: new Date(now - awayMs).toISOString(),
          returned_at: new Date(now).toISOString(),
          away_ms: awayMs,
          handoff_id: null,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Item actions (§5.5, §5.6)
  // ---------------------------------------------------------------------------

  reply(itemId: string, req: Partial<ReplyRequest> | null, actor: Actor): Outcome<ActionResult> {
    const now = Date.now();
    const item = this.getItem(itemId);
    if (!item) return { status: 404, body: { success: false, error: 'not found' } };
    const check = checkReply(item.kind, req);
    if (!check.ok) return { status: 400, body: { success: false, error: check.error } };
    const category = check.action === 'text' ? (item.kind === 'decision' || item.kind === 'blocker' ? 'decide' : 'reply') : 'approve';
    if (item.state !== 'open' && item.state !== 'snoozed') return { status: 409, body: { success: false, error: 'stale', item }, category };
    if (typeof req?.version !== 'number' || req.version !== item.version) {
      return { status: 409, body: { success: false, error: 'stale', item }, category };
    }
    const ptyId = item.source.pty_id;
    if (ptyId == null || !this.ptyManager.get(ptyId)) {
      return { status: 410, body: { success: false, error: 'agent is gone' }, category };
    }
    const s = item.source.session_id ? this.sessions.get(item.source.session_id) : this.sessions.byPty(ptyId);
    if (check.action === 'approve' || check.action === 'deny') {
      // Enter or Esc only mean approve/deny while the agent is actually on
      // the prompt. Otherwise Esc would interrupt a running tool and Enter
      // would submit whatever is in the input box (C3).
      if (!s || s.ended || !s.awaiting_approval) {
        this.queue.resolve(item.id, 'answered_in_tab', now);
        return { status: 409, body: { success: false, error: 'stale', item: this.queue.get(item.id) }, category };
      }
    }
    writeReply((data) => this.ptyManager.write(ptyId, data), check.action, check.text);
    if (s && check.action === 'deny') {
      // Esc declines and interrupts the turn (no Stop follows), so every
      // prompt of this agent is gone.
      const key = sourceKey(item.source);
      this.queue.resolveWhere((i) => i.id !== item.id && sourceKey(i.source) === key && i.kind === 'approval', 'answered_in_tab', now);
      this.sessions.interrupt(s, now);
    } else if (s && check.action === 'approve') {
      // Another queued prompt (a parallel call) shows next: stay paused on it.
      const others = this.queue.findLive(sourceKey(item.source), ['approval']).filter((i) => i.id !== item.id);
      if (others.length === 0) {
        s.awaiting_approval = false;
        this.sessions.resumeBusy(s, now);
      }
    }
    this.log({
      type: 'attention.reply',
      workspace: item.source.workspace,
      window_id: item.source.window_id,
      actor,
      data: {
        item_id: item.id,
        kind: item.kind,
        action: check.action,
        text_chars: check.text?.length ?? 0,
        ...(item.tool ? { tool_signature: item.tool.signature } : {}),
        latency_ms: Math.max(0, now - Date.parse(item.created_at)),
      },
    });
    this.queue.resolve(item.id, 'reply', now, actor);
    return { status: 200, body: { success: true, item: this.queue.get(item.id) }, category };
  }

  snooze(itemId: string, req: Partial<SnoozeRequest> | null, actor: Actor): Outcome<ActionResult> {
    const now = Date.now();
    const item = this.queue.get(itemId);
    if (!item) return { status: 404, body: { success: false, error: 'not found' } };
    const hasUntil = req?.until !== undefined && req?.until !== null;
    const hasMinutes = req?.minutes !== undefined && req?.minutes !== null;
    if (hasUntil === hasMinutes) return { status: 400, body: { success: false, error: 'pass exactly one of until or minutes' } };
    let until: number | 'change';
    if (hasMinutes) {
      const m = Number(req?.minutes);
      if (!Number.isFinite(m) || m <= 0 || m > MAX_SNOOZE_MINUTES) {
        return { status: 400, body: { success: false, error: 'minutes out of range' } };
      }
      until = now + m * 60_000;
    } else if (req?.until === 'change') {
      until = 'change';
    } else {
      const t = typeof req?.until === 'string' ? Date.parse(req.until) : NaN;
      if (!Number.isFinite(t) || t <= now) return { status: 400, body: { success: false, error: 'until must be a future ISO time or "change"' } };
      until = t;
    }
    if (!this.queue.snooze(itemId, until, now, actor)) return { status: 409, body: { success: false, error: 'stale', item } };
    return { status: 200, body: { success: true, item: this.queue.get(itemId) } };
  }

  dismiss(itemId: string, actor: Actor): Outcome<ActionResult> {
    const item = this.queue.get(itemId);
    if (!item) return { status: 404, body: { success: false, error: 'not found' } };
    if (!this.queue.dismiss(itemId, Date.now(), actor)) return { status: 409, body: { success: false, error: 'stale', item } };
    return { status: 200, body: { success: true, item: this.queue.get(itemId) } };
  }

  setWake(itemId: string, wake: unknown, actor: Actor): Outcome<ActionResult> {
    const item = this.queue.get(itemId);
    if (!item) return { status: 404, body: { success: false, error: 'not found' } };
    if (typeof wake !== 'boolean') return { status: 400, body: { success: false, error: 'wake must be a boolean' } };
    const now = Date.now();
    if (!this.queue.setWake(itemId, wake, now, actor)) return { status: 409, body: { success: false, error: 'stale', item } };
    this.away.setWakeItem(itemId, wake);
    this.queue.recompute(now);
    return { status: 200, body: { success: true, item: this.queue.get(itemId) } };
  }

  openItem(itemId: string): Outcome<ActionResult> {
    const item = this.queue.get(itemId);
    if (!item) return { status: 404, body: { success: false, error: 'not found' } };
    const tab = item.source.pty_id != null ? this.findTab(item.source.pty_id) : null;
    const windowId = tab?.window_id ?? item.source.window_id;
    const ws = (windowId != null ? windowRegistry.get(windowId) : undefined) ?? windowRegistry.getFocused() ?? windowRegistry.getAny();
    if (!ws || ws.browserWindow.isDestroyed()) return { status: 503, body: { success: false, error: 'No window available' } };
    const bw = ws.browserWindow;
    if (bw.isMinimized()) bw.restore();
    bw.show();
    bw.focus();
    const tabId = tab?.tab_id ?? item.source.tab_id;
    if (item.kind !== 'summary') {
      if (tabId == null) return { status: 404, body: { success: false, error: 'tab not found', item } };
      bw.webContents.send('system:focus-tab', String(tabId));
    }
    return { status: 200, body: { success: true, item } };
  }

  // ---------------------------------------------------------------------------
  // Focus (§5.3)
  // ---------------------------------------------------------------------------

  private defaultLeeFocusItem(windowId: number | null): FocusItem | null {
    const ws = (windowId != null ? windowRegistry.get(windowId) : undefined) ?? windowRegistry.getFocused() ?? windowRegistry.getAny();
    if (!ws) return null;
    let ctx;
    try {
      ctx = ws.contextBridge.getContext();
    } catch {
      return ws.workspace ? { kind: 'workspace', workspace: ws.workspace } : null;
    }
    const workspace = ws.workspace ?? ctx.workspace ?? null;
    const activeId = ctx.panels?.[ctx.focusedPanel]?.activeTabId ?? null;
    const tab = activeId != null ? ctx.tabs.find((t) => t.id === activeId) : undefined;
    if (tab?.ptyId != null && this.sessions.byPty(tab.ptyId)) {
      return { kind: 'agent', pty_id: tab.ptyId, window_id: ws.browserWindow.id, label: tab.label };
    }
    if (tab?.filePath) return { kind: 'files', workspace, paths: [tab.filePath] };
    return workspace ? { kind: 'workspace', workspace } : null;
  }

  focusStart(rawItem: unknown, actor: Actor, surface: 'lee' | 'device', windowId: number | null = null): Outcome<FocusState> {
    const now = Date.now();
    let item: FocusItem | null = rawItem == null ? null : parseFocusItem(rawItem);
    if (rawItem != null && !item) return { status: 400, body: this.focusState(), error: 'invalid focus item' };
    if (!item) {
      if (surface === 'lee') {
        item = this.defaultLeeFocusItem(windowId);
      } else {
        const ws = windowRegistry.getFocused() ?? windowRegistry.getAny();
        item = ws?.workspace ? { kind: 'workspace', workspace: ws.workspace } : null;
      }
    }
    if (!item) return { status: 409, body: this.focusState(), error: 'no window to focus on' };
    if (surface === 'lee' && this.away.active) this.endHandoff('return');
    this.focus.start(item, 'manual', surface, actor, now);
    this.queue.recompute(now);
    this.changed();
    return { status: 200, body: this.focusState() };
  }

  focusStop(actor: Actor): Outcome<FocusState> {
    const now = Date.now();
    this.focus.stop('manual', now, actor);
    this.queue.recompute(now);
    this.changed();
    return { status: 200, body: this.focusState() };
  }

  // ---------------------------------------------------------------------------
  // Handoff and away (§7)
  // ---------------------------------------------------------------------------

  private agentState(s: AgentSession): HandoffAgent['state'] {
    // 'waiting' comes from open items only (§7.1): once the item is
    // dismissed or snoozed away, an agent outside a turn is idle.
    if (s.pty_id != null && this.queue.findLive(`pty:${s.pty_id}`, ['approval', 'waiting']).length > 0) return 'waiting';
    if (s.activity === 'waiting') return s.in_turn ? 'busy' : 'idle';
    if (s.activity === 'busy' || s.in_turn) return 'busy';
    if (s.activity === 'idle') return 'idle';
    return 'unknown';
  }

  handoffProposals(): HandoffProposals {
    this.queue.recompute(Date.now());
    const agents: HandoffAgent[] = [];
    const seen = new Set<number>();
    const live = this.sessions.live().sort((a, b) => b.last_event_at - a.last_event_at);
    for (const s of live) {
      if (s.pty_id == null || seen.has(s.pty_id) || !this.ptyManager.get(s.pty_id)) continue;
      // Hidden prewarmed Claudes (and any PTY no tab shows) are not agents yet.
      const tab = this.findTab(s.pty_id);
      if (!tab || this.ptyManager.isWarmPty(s.pty_id)) continue;
      seen.add(s.pty_id);
      const src = this.sourceFor(s, s.pty_id, null, null);
      agents.push({
        pty_id: s.pty_id,
        window_id: src.window_id,
        tab_id: tab?.tab_id ?? null,
        label: tab?.label ?? 'Claude',
        provider: s.provider,
        workspace: src.workspace,
        state: this.agentState(s),
        last_summary: s.last_summary,
      });
    }
    const waiting = this.queue
      .snapshot(this.focusState(), this.awayState())
      .items.filter((i) => i.state === 'open' && i.severity !== 'ambient');
    const workspaces: string[] = [];
    for (const ws of windowRegistry.getAll().values()) {
      if (ws.workspace && !workspaces.includes(ws.workspace)) workspaces.push(ws.workspace);
    }
    return { agents, waiting, workspaces, default_summary: { mode: 'on_return' } };
  }

  handoffStart(rawReq: unknown, actor: Actor): Outcome<HandoffResult> {
    const now = Date.now();
    const req = obj(rawReq);
    const followups = Array.isArray(req.followups) ? req.followups.map(obj) : [];
    const launches = Array.isArray(req.launch) ? req.launch.map(obj) : [];
    const wakeReq = obj(req.wake);
    const wakeItems = Array.isArray(wakeReq.item_ids) ? wakeReq.item_ids.filter((x): x is string => typeof x === 'string') : [];
    const wakePtys = Array.isArray(wakeReq.pty_ids) ? wakeReq.pty_ids.filter((x): x is number => Number.isInteger(x)) : [];
    const summary = normalizeSummaryPolicy(req.summary);
    if (summary.mode === 'at' && !Number.isFinite(Date.parse(summary.at)) && !/^\d{1,2}:\d{2}$/.test(summary.at)) {
      return { status: 400, body: { success: false, error: 'summary.at must be an ISO time or HH:MM' } };
    }
    if (this.away.active) this.endHandoff('manual');

    const handoffId = AwayPolicy.newHandoffId(now);
    const skipped: string[] = [];

    this.focus.stop('handoff', now, actor);

    let sent = 0;
    for (const f of followups) {
      const ptyId = Number.isInteger(f.pty_id) ? (f.pty_id as number) : null;
      const text = sanitizeReplyText(f.text);
      const s = ptyId != null ? this.sessions.byPty(ptyId) : undefined;
      if (ptyId == null || !text || !s || !this.ptyManager.get(ptyId) || this.agentState(s) !== 'idle') {
        skipped.push(`follow-up to ${ptyId ?? '?'}`);
        continue;
      }
      writeText((data) => this.ptyManager.write(ptyId, data), text);
      sent++;
    }

    let launched = 0;
    for (const l of launches) {
      const workspace = typeof l.workspace === 'string' ? l.workspace : '';
      const prompt = typeof l.prompt === 'string' ? l.prompt.trim() : '';
      const mode = (PERMISSION_MODES.has(l.permission_mode as HandoffLaunch['permission_mode'])
        ? l.permission_mode
        : 'acceptEdits') as HandoffLaunch['permission_mode'];
      const worktree = l.worktree !== false;
      const target = Array.from(windowRegistry.getAll().values()).find((w) => w.workspace && workspace && samePath(w.workspace, workspace));
      if (!target || target.browserWindow.isDestroyed()) {
        skipped.push(`launch in ${workspace || '?'}`);
        continue;
      }
      const title = (typeof l.title === 'string' && l.title.trim() ? l.title.trim() : prompt.slice(0, 40).trim()) || 'Claude';
      const slug = worktree ? slugify(title, Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')) : null;
      // '--' ends the options, so a prompt starting with '-' (a markdown
      // bullet, say) stays the positional prompt instead of a CLI flag.
      const args = ['--permission-mode', mode, ...(slug ? ['--worktree', slug] : []), '-n', title, ...(prompt ? ['--', prompt] : [])];
      target.browserWindow.webContents.send('system:create-tab', { type: 'terminal', label: title, command: 'claude', args });
      this.log({
        type: 'handoff.launch',
        workspace: target.workspace,
        window_id: target.browserWindow.id,
        actor,
        data: { handoff_id: handoffId, provider: 'claude', workspace: target.workspace, worktree: slug, permission_mode: mode },
      });
      launched++;
    }

    this.away.start({ summary, wake: { item_ids: wakeItems, pty_ids: wakePtys } }, now, handoffId);
    for (const id of wakeItems) this.queue.setWake(id, true, now, actor);
    this.log({
      type: 'handoff.start',
      actor,
      data: {
        handoff_id: handoffId,
        summary,
        followups: sent,
        launches: launched,
        wake_items: wakeItems.length,
        wake_ptys: wakePtys.length,
      },
    });
    this.queue.recompute(now);
    if (skipped.length > 0) this.ptyManager.log('WARN', 'Copilot handoff: skipped steps', { handoff_id: handoffId, skipped });
    return {
      status: 200,
      body: {
        success: true,
        away: this.awayState(),
        launched,
        ...(skipped.length > 0 ? { error: `Skipped: ${skipped.join(', ')}` } : {}),
      },
    };
  }

  endHandoff(reason: 'return' | 'manual', actor?: Actor): AwayState {
    const now = Date.now();
    const ended = this.away.end(now);
    if (!ended) return this.awayState();
    this.log({ type: 'handoff.end', actor, data: { handoff_id: ended.handoff_id, reason, away_ms: ended.away_ms } });
    this.queue.recompute(now);
    this.pushReturn({
      reason: 'handoff_end',
      away_since: ended.started_at,
      returned_at: new Date(now).toISOString(),
      away_ms: ended.away_ms,
      handoff_id: ended.handoff_id,
    });
    return this.awayState();
  }

  private deliverSummary(now: number): void {
    this.queue.recompute(now);
    const live = this.queue.liveItems().filter((i) => i.state === 'open' && i.kind !== 'summary');
    const waiting = live.filter((i) => i.severity !== 'ambient').length;
    const parked = live.filter((i) => i.parked).length;
    const agentLines = this.sessions
      .live()
      .filter((s) => s.last_summary)
      .sort((a, b) => b.last_event_at - a.last_event_at)
      .map((s) => ({
        label: (s.pty_id != null ? this.findTab(s.pty_id)?.label : null) ?? 'Claude',
        summary: s.last_summary as string,
      }));
    this.queue.open(
      {
        kind: 'summary',
        title: KIND_TITLES.summary,
        text: this.away.summaryText({ waiting, parked, agentLines }),
        source: {
          kind: 'lee',
          provider: null,
          session_id: null,
          pty_id: null,
          window_id: null,
          tab_id: null,
          tab_label: null,
          workspace: null,
          cwd: null,
        },
        wake: true,
      },
      now,
    );
    this.away.markSummaryDelivered();
    this.log({
      type: 'away.summary',
      data: { handoff_id: this.away.handoffId, parked, waiting, turns_ended: this.away.counters.turns_ended },
    });
  }

  // ---------------------------------------------------------------------------
  // IPC (§5.7)
  // ---------------------------------------------------------------------------

  private registerIpc(): void {
    const win = (e: IpcMainInvokeEvent): number | null => BrowserWindow.fromWebContents(e.sender)?.id ?? null;
    ipcMain.handle(COPILOT_IPC.snapshotGet, () => this.snapshot());
    ipcMain.handle(COPILOT_IPC.reply, (_e, id: string, req: ReplyRequest) => this.reply(String(id), req, LEE_ACTOR).body);
    ipcMain.handle(COPILOT_IPC.snooze, (_e, id: string, req: SnoozeRequest) => this.snooze(String(id), req, LEE_ACTOR).body);
    ipcMain.handle(COPILOT_IPC.dismiss, (_e, id: string) => this.dismiss(String(id), LEE_ACTOR).body);
    ipcMain.handle(COPILOT_IPC.wake, (_e, id: string, wake: boolean) => this.setWake(String(id), wake, LEE_ACTOR).body);
    ipcMain.handle(COPILOT_IPC.open, (_e, id: string) => this.openItem(String(id)).body);
    ipcMain.handle(COPILOT_IPC.focusStart, (e, item: FocusItem | null) => this.focusStart(item, LEE_ACTOR, 'lee', win(e)).body);
    ipcMain.handle(COPILOT_IPC.focusStop, () => this.focusStop(LEE_ACTOR).body);
    ipcMain.handle(COPILOT_IPC.handoffProposals, () => this.handoffProposals());
    ipcMain.handle(COPILOT_IPC.handoffStart, (_e, req: HandoffRequest) => this.handoffStart(req, LEE_ACTOR).body);
    ipcMain.handle(COPILOT_IPC.handoffEnd, () => this.endHandoff('manual', LEE_ACTOR));
  }
}

let instance: CopilotQueue | null = null;

/** The queue singleton; created on first use (routes are registered before IPC setup). */
export function getCopilotQueue(ptyManager: PTYManager): CopilotQueue {
  if (!instance) instance = new CopilotQueue(ptyManager);
  return instance;
}

export function initCopilotQueue({ ptyManager }: { ptyManager: PTYManager }): CopilotQueue {
  const q = getCopilotQueue(ptyManager);
  q.start();
  return q;
}
