/**
 * Check-ins (contract §5.5, async since addendum 2026-09-26b): a human asks an
 * agent for a lee-status report. Lee types the fixed CHECKIN_PROMPT only on a
 * human action; Hester's `tab.checkin` becomes a Feed proposal. A
 * deterministic rule proposes check-ins for hook-less agents busy for a long
 * time (nudge-budgeted).
 *
 * The request returns at once with `state: 'queued' | 'sent'`. A busy agent's
 * check-in waits in a per-PTY queue (one at a time) and is typed when its
 * turn ends (a hook turn end, or the tab state returning to idle-at-prompt);
 * an agent waiting on a permission prompt keeps it queued until the prompt is
 * resolved. The reply timeout starts when the prompt is typed. The result
 * arrives asynchronously: `checkin.result` in the event log, a Feed entry and
 * the tab runtime's `checkin` field (pushed to the renderer).
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type { LeeEvent, LeeStatusBlock, Principal } from '../../shared/copilot';
import { CHECKIN_PROMPT, type CheckinError, type CheckinResult, type FeedEntry, type TabCheckinInfo } from '../../shared/cockpit';
import { copilotBus } from '../copilot/bus';
import { parseLeeStatus } from '../copilot/hook-payload';
import { cockpitBus, logCockpitEvent } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import { actorFor, type TabRuntimeImpl } from './tab-runtime';

const SUMMARY_MAX = 2000;
const POLL_MS = 1000;
const PROPOSE_TICK_MS = 60_000;

export interface CheckinOptions {
  force?: boolean;
  by: Principal;
  window_id?: number | null;
}

export interface CheckinTimings {
  /** How often queued and sent check-ins are re-examined (default 1 s). */
  pollMs?: number;
  /** Kept for callers of the old API; the same tick drives screen replies. */
  screenPollMs?: number;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

const ERROR_TEXT: Record<CheckinError, string> = {
  not_found: 'the tab is gone',
  not_agent: 'not an agent tab',
  busy: 'it stayed busy',
  awaiting_input: 'it is waiting on a prompt',
  state_unknown: "Lee can't tell whether it is at its prompt; check in again to send anyway",
  timeout: 'no reply in time',
  forbidden: 'not allowed',
  in_progress: 'a check-in is already running',
  cancelled: 'cancelled',
};

interface Pending {
  id: string;
  ptyId: number;
  by: Principal;
  force: boolean;
  state: 'queued' | 'sent' | 'sending';
  queuedAt: number;
  sentAt: number | null;
  /** 'hook': the reply is the next agent.turn_end; 'screen': the tab state. */
  source: 'hook' | 'screen';
  /** Sent while the state was unknown (forced): "worked, then went quiet" ends it. */
  fromUnknown: boolean;
  startCursor: number;
  left: boolean;
  sawBusy: boolean;
  turnEnd: { lee_status: LeeStatusBlock | null; summary: string | null } | null;
  ws: string | null;
  windowId: number | null;
  sessionId: string | null;
  /** Still inside the request: a failure is returned, not announced in the Feed. */
  inRequest: boolean;
}

export class CheckinManager extends EventEmitter {
  private pending = new Map<number, Pending>();
  private lastCheckinAt = new Map<number, number>();
  private proposeTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly rt: TabRuntimeImpl;
  private readonly pollMs: number;
  private readonly onEvent = (e: LeeEvent) => this.onCopilotEvent(e);
  private readonly onChange = () => this.kick();
  private kicked = false;

  constructor(rt: TabRuntimeImpl, timings: CheckinTimings = {}) {
    super();
    this.rt = rt;
    this.pollMs = timings.pollMs ?? POLL_MS;
    copilotBus.on('event', this.onEvent);
    rt.on('change', this.onChange);
  }

  start(): void {
    if (this.proposeTimer) return;
    this.proposeTimer = setInterval(() => this.proposeTick(), PROPOSE_TICK_MS);
    this.proposeTimer.unref?.();
  }

  stop(): void {
    if (this.proposeTimer) clearInterval(this.proposeTimer);
    this.proposeTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    copilotBus.off('event', this.onEvent);
    this.rt.off('change', this.onChange);
  }

  /** The pending check-in on a PTY, if any (for the tab runtime and tiles). */
  pendingFor(ptyId: number): TabCheckinInfo | null {
    const p = this.pending.get(ptyId);
    if (!p) return null;
    return {
      id: p.id,
      state: p.state === 'sending' ? 'sent' : p.state,
      queued_at: new Date(p.queuedAt).toISOString(),
      sent_at: p.sentAt != null ? new Date(p.sentAt).toISOString() : null,
    };
  }

  /** Resolves with the final result of a check-in (tests; callers that want to wait). */
  waitFor(checkinId: string): Promise<CheckinResult> {
    return new Promise((resolve) => {
      const on = (res: CheckinResult) => {
        if (res.checkin_id !== checkinId) return;
        this.off('result', on);
        resolve(res);
      };
      this.on('result', on);
    });
  }

  /**
   * A human's check-in. Validates and returns at once: queued behind a busy
   * turn (or an open permission prompt), or sent now. Shared-token callers
   * must use propose() instead.
   */
  async checkin(ptyId: number, opts: CheckinOptions): Promise<CheckinResult> {
    if (opts.by.kind === 'shared') return { success: false, error: 'forbidden' };
    const info = this.rt.get(ptyId);
    if (!info || info.state.state === 'exited') return { success: false, error: 'not_found' };
    if (info.kind !== 'agent') return { success: false, error: 'not_agent' };
    const existing = this.pending.get(ptyId);
    if (existing) return { success: false, error: 'in_progress', checkin_id: existing.id, state: existing.state === 'queued' ? 'queued' : 'sent' };
    const force = !!opts.force && opts.by.kind === 'local-user';
    const state = info.state.state;
    if (state === 'unknown' && !force) return { success: false, error: 'state_unknown' };

    const now = Date.now();
    const p: Pending = {
      id: `chk_${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      ptyId,
      by: opts.by,
      force,
      state: 'queued',
      queuedAt: now,
      sentAt: null,
      source: this.rt.hasHooks(ptyId) ? 'hook' : 'screen',
      fromUnknown: false,
      startCursor: 0,
      left: false,
      sawBusy: false,
      turnEnd: null,
      ws: this.rt.workspaceOf(ptyId),
      windowId: this.rt.windowOf(ptyId),
      sessionId: this.rt.sessionOf(ptyId),
      inRequest: true,
    };
    this.pending.set(ptyId, p);
    logCockpitEvent('checkin.start', {
      workspace: p.ws,
      window_id: p.windowId,
      actor: actorFor(opts.by),
      data: {
        checkin_id: p.id,
        pty_id: ptyId,
        ...(p.sessionId ? { session_id: p.sessionId } : {}),
        source: p.source,
        queued: state !== 'idle-at-prompt' && !(state === 'unknown' && force),
      },
    });

    if (state === 'idle-at-prompt' || (state === 'unknown' && force)) {
      await this.send(p, state === 'unknown');
    } else {
      this.publish();
      this.ensurePoll();
    }
    p.inRequest = false;
    const cur = this.pending.get(ptyId);
    if (cur !== p) {
      // Sending failed and finished it synchronously: report that failure.
      return { success: false, checkin_id: p.id, error: this.lastError.get(p.id) ?? 'state_unknown' };
    }
    return { success: true, checkin_id: p.id, state: p.state === 'queued' ? 'queued' : 'sent', source: p.source, task_id: this.rt.taskOf(ptyId) };
  }

  /** Cancel a queued (or still-awaited) check-in. Nothing is typed after this. */
  cancel(ptyId: number, by: Principal): { success: boolean; error?: string } {
    if (by.kind === 'shared') return { success: false, error: 'forbidden' };
    const p = this.pending.get(ptyId);
    if (!p) return { success: false, error: 'not_found' };
    this.finish(p, { ok: false, error: 'cancelled' });
    return { success: true };
  }

  private lastError = new Map<string, CheckinError>();

  private publish(): void {
    this.rt.setCheckins((id) => this.pendingFor(id));
  }

  private ensurePoll(): void {
    if (this.pollTimer || this.pending.size === 0) return;
    this.pollTimer = setInterval(() => void this.tick(), this.pollMs);
    this.pollTimer.unref?.();
  }

  private stopPollIfIdle(): void {
    if (this.pending.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Re-examine pending check-ins soon (a runtime change or a hook event). */
  private kick(): void {
    if (this.kicked || this.pending.size === 0) return;
    this.kicked = true;
    setImmediate(() => {
      this.kicked = false;
      void this.tick();
    });
  }

  private onCopilotEvent(e: LeeEvent): void {
    if (e.type !== 'agent.turn_end' || this.pending.size === 0) return;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const ptyId = typeof d.pty_id === 'number' ? d.pty_id : null;
    if (ptyId == null) return;
    const p = this.pending.get(ptyId);
    if (!p) return;
    if (p.state === 'sent' && p.source === 'hook') {
      p.turnEnd = {
        lee_status: (d.lee_status as LeeStatusBlock | undefined) ?? null,
        summary: typeof d.summary === 'string' ? d.summary : null,
      };
    }
    this.kick();
  }

  /** One pass over pending check-ins: send queued ones whose agent is now idle; finish sent ones. */
  async tick(): Promise<void> {
    for (const p of [...this.pending.values()]) {
      if (this.pending.get(p.ptyId) !== p) continue;
      if (p.state === 'queued') await this.advanceQueued(p);
      else if (p.state === 'sent') this.advanceSent(p);
    }
    this.stopPollIfIdle();
  }

  private async advanceQueued(p: Pending): Promise<void> {
    if (!this.rt.exists(p.ptyId)) {
      this.finish(p, { ok: false, error: 'not_found' });
      return;
    }
    const s = this.rt.state(p.ptyId).state;
    if (s === 'exited') {
      this.finish(p, { ok: false, error: 'not_found' });
      return;
    }
    // Busy: wait for the turn to end. Awaiting input: never type over a
    // permission prompt; wait until it is resolved (approve, deny, in the tab).
    if (s === 'busy' || s === 'awaiting-input') return;
    if (s === 'idle-at-prompt') {
      await this.send(p, false);
      return;
    }
    // unknown: a hook-less agent with no prompt_pattern went quiet. Typing
    // into a screen Lee can't read is only done when you forced it.
    if (p.force) await this.send(p, true);
    else this.finish(p, { ok: false, error: 'state_unknown' });
  }

  private async send(p: Pending, fromUnknown: boolean): Promise<void> {
    p.state = 'sending';
    p.startCursor = this.rt.cursor(p.ptyId);
    p.fromUnknown = fromUnknown;
    p.turnEnd = null;
    const sent = await this.rt.send(p.ptyId, { text: CHECKIN_PROMPT, submit: true, purpose: 'checkin', force: p.force }, p.by);
    if (this.pending.get(p.ptyId) !== p) return; // cancelled meanwhile
    if (!sent.success) {
      // Raced a new turn (or a prompt): back to the queue; else a real failure.
      if (sent.error === 'busy' || sent.error === 'awaiting_input') {
        p.state = 'queued';
        this.publish();
        this.ensurePoll();
        return;
      }
      const error: CheckinError = !sent.error || sent.error === 'invalid' ? 'state_unknown' : sent.error;
      this.finish(p, { ok: false, error });
      return;
    }
    p.state = 'sent';
    p.sentAt = Date.now();
    this.publish();
    this.ensurePoll();
  }

  private advanceSent(p: Pending): void {
    const cfg = getCockpitConfig(p.ws).cockpit;
    const now = Date.now();
    const deadline = (p.sentAt ?? now) + cfg.checkin.timeout_s * 1000;
    const exists = this.rt.exists(p.ptyId);
    if (p.source === 'hook') {
      if (p.turnEnd) {
        const got = p.turnEnd;
        this.finish(p, { ok: true, lee: got.lee_status ?? parseLeeStatus(got.summary), summary: got.lee_status?.summary ?? got.summary });
        return;
      }
      if (!exists || this.rt.state(p.ptyId).state === 'exited' || now >= deadline) this.finish(p, { ok: false, error: 'timeout' });
      return;
    }
    // Screen: wait for the agent to leave idle and come back to it, quiet for
    // 2 x quiet_ms. A forced check-in on an agent with no prompt_pattern
    // never reads idle-at-prompt (only busy or unknown): there, "worked, then
    // went quiet" is the end of its turn.
    const s = this.rt.state(p.ptyId);
    if (s.state === 'exited') {
      this.finish(p, { ok: false, error: 'timeout' });
      return;
    }
    if (s.state !== 'idle-at-prompt') p.left = true;
    if (s.state === 'busy') p.sawBusy = true;
    const moved = this.rt.cursor(p.ptyId) > p.startCursor;
    const quiet = s.quiet_ms >= 2 * cfg.tab.quiet_ms;
    const atPrompt = (p.left || moved) && s.state === 'idle-at-prompt';
    const settled = p.fromUnknown && moved && p.sawBusy && s.state === 'unknown';
    if ((atPrompt || settled) && quiet) {
      const text = this.rt.read(p.ptyId, { since: p.startCursor, max_chars: 262_144 }).text;
      const lee = parseLeeStatus(text);
      const tail = text.split('\n').filter((l) => l.trim()).slice(-20).join('\n');
      this.finish(p, { ok: true, lee, summary: lee?.summary ?? null, screenTail: tail || null });
      return;
    }
    if (now >= deadline) this.finish(p, { ok: false, error: 'timeout' });
  }

  /**
   * `summary` is the agent's own words (lee-status or turn summary) and is
   * logged. `screenTail` is raw screen text for a hook-less agent that
   * printed no lee-status block: it can hold typed input, prompts and
   * commands, so it only goes to the in-memory Feed entry, never the event log.
   */
  private finish(
    p: Pending,
    res: { ok: boolean; error?: CheckinError; lee?: LeeStatusBlock | null; summary?: string | null; screenTail?: string | null },
  ): void {
    if (this.pending.get(p.ptyId) !== p) return;
    this.pending.delete(p.ptyId);
    const taskId = this.rt.taskOf(p.ptyId);
    const summary = res.summary ? clip(res.summary, SUMMARY_MAX) : null;
    const screenTail = !summary && res.screenTail ? clip(res.screenTail, SUMMARY_MAX) : null;
    const now = Date.now();
    logCockpitEvent('checkin.result', {
      workspace: p.ws,
      window_id: p.windowId,
      actor: actorFor(p.by),
      data: {
        checkin_id: p.id,
        pty_id: p.ptyId,
        ...(p.sessionId ? { session_id: p.sessionId } : {}),
        ...(taskId ? { task_id: taskId } : {}),
        ok: res.ok,
        ...(res.error ? { error: res.error } : {}),
        source: p.source,
        ...(res.lee ? { lee_status: res.lee } : {}),
        ...(summary ? { summary } : {}),
        queued_ms: (p.sentAt ?? now) - p.queuedAt,
        duration_ms: p.sentAt != null ? now - p.sentAt : 0,
      },
    });
    const label = this.rt.displayNameOf(p.ptyId);
    if (res.ok) {
      this.lastCheckinAt.set(p.ptyId, now);
      cockpitBus.feed.closeByKey(`checkin-proposal:${p.ptyId}`, 'done');
      cockpitBus.feed.post({
        workspace: p.ws,
        kind: 'event',
        severity: 'ambient',
        producer: 'checkin',
        title: `Checked in on ${label}: ${res.lee?.status ?? 'no status'}`,
        text: summary ?? screenTail,
        text_is_agent: !!summary,
        ref: { pty_id: p.ptyId, checkin_id: p.id, ...(taskId ? { task_id: taskId } : {}) },
      });
    } else if (res.error && res.error !== 'cancelled' && !p.inRequest) {
      cockpitBus.feed.post({
        workspace: p.ws,
        kind: 'event',
        severity: 'ambient',
        producer: 'checkin',
        title: `Check-in on ${label} failed: ${ERROR_TEXT[res.error] ?? res.error}`,
        text: null,
        ref: { pty_id: p.ptyId, checkin_id: p.id, ...(taskId ? { task_id: taskId } : {}) },
        ...(this.rt.exists(p.ptyId) ? { actions: [{ id: 'open-tab', label: 'Open tab' }] } : {}),
      });
    }
    if (res.error) {
      this.lastError.set(p.id, res.error);
      if (this.lastError.size > 50) this.lastError.delete(this.lastError.keys().next().value as string);
    }
    this.publish();
    this.stopPollIfIdle();
    const out: CheckinResult = {
      success: res.ok,
      checkin_id: p.id,
      ...(res.error ? { error: res.error } : {}),
      lee_status: res.lee ?? null,
      summary,
      source: p.source,
      task_id: taskId,
    };
    this.emit('result', out);
  }

  /** Post (or refresh) the Feed proposal "Check in on <label>?". */
  propose(ptyId: number, reason: 'hookless_busy' | 'hester'): FeedEntry | null {
    const info = this.rt.get(ptyId);
    if (!info || info.kind !== 'agent') return null;
    const entry = cockpitBus.feed.post({
      workspace: info.workspace,
      kind: 'proposal',
      severity: 'needs-you',
      producer: 'checkin',
      title: `Check in on ${info.name || info.label}?`,
      text: reason === 'hester' ? 'Hester asked for a check-in.' : `Busy for a while with no report.`,
      item_ref: `pty:${ptyId}`,
      ref: { pty_id: ptyId, ...(info.task_id ? { task_id: info.task_id } : {}) },
      actions: [{ id: 'checkin', label: 'Check in', style: 'primary', confirm_text: CHECKIN_PROMPT }],
      dedupe_key: `checkin-proposal:${ptyId}`,
    });
    logCockpitEvent('checkin.proposed', {
      workspace: info.workspace,
      window_id: info.window_id,
      actor: reason === 'hester' ? { kind: 'hester' } : { kind: 'system' },
      data: { pty_id: ptyId, reason, entry_id: entry.id },
    });
    return entry;
  }

  /** Deterministic proposal rule for screen-fidelity agents (every 60 s). */
  proposeTick(now: number = Date.now()): void {
    for (const info of this.rt.list()) {
      if (info.kind !== 'agent' || info.fidelity !== 'screen' || info.state.state !== 'busy') continue;
      if (this.pending.has(info.pty_id)) continue;
      const since = Date.parse(info.state.since);
      const minutes = getCockpitConfig(info.workspace).cockpit.checkin.propose_after_min;
      if (!Number.isFinite(since) || now - since < minutes * 60_000) continue;
      const last = this.lastCheckinAt.get(info.pty_id) ?? 0;
      if (last >= since) continue;
      const claim = cockpitBus.claimNudge({
        item_ref: `pty:${info.pty_id}`,
        state_key: `busy-since:${info.state.since}`,
        source: 'checkin',
        workspace: info.workspace,
      });
      if (claim.granted) this.propose(info.pty_id, 'hookless_busy');
    }
  }
}
