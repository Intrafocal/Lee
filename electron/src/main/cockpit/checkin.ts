/**
 * Check-ins (contract §5.5): a human asks an agent for a lee-status report.
 * Lee types the fixed CHECKIN_PROMPT only on a human action; Hester's
 * `tab.checkin` becomes a Feed proposal. A deterministic rule proposes
 * check-ins for hook-less agents busy for a long time (nudge-budgeted).
 */

import * as crypto from 'crypto';
import type { LeeEvent, LeeStatusBlock, Principal } from '../../shared/copilot';
import { CHECKIN_PROMPT, type CheckinResult, type FeedEntry } from '../../shared/cockpit';
import { copilotBus } from '../copilot/bus';
import { parseLeeStatus } from '../copilot/hook-payload';
import { cockpitBus, logCockpitEvent } from './cockpit-bus';
import { getCockpitConfig } from './cockpit-config';
import { actorFor, type TabRuntimeImpl } from './tab-runtime';

const SUMMARY_MAX = 2000;
const POLL_MS = 1000;
const SCREEN_POLL_MS = 500;
const PROPOSE_TICK_MS = 60_000;

export interface CheckinOptions {
  force?: boolean;
  by: Principal;
  window_id?: number | null;
}

export interface CheckinTimings {
  pollMs?: number;
  screenPollMs?: number;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

export class CheckinManager {
  private inProgress = new Set<number>();
  private lastCheckinAt = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly rt: TabRuntimeImpl;
  private readonly timings: Required<CheckinTimings>;

  constructor(rt: TabRuntimeImpl, timings: CheckinTimings = {}) {
    this.rt = rt;
    this.timings = { pollMs: timings.pollMs ?? POLL_MS, screenPollMs: timings.screenPollMs ?? SCREEN_POLL_MS };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.proposeTick(), PROPOSE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** A human's check-in. Shared-token callers must use propose() instead. */
  async checkin(ptyId: number, opts: CheckinOptions): Promise<CheckinResult> {
    if (opts.by.kind === 'shared') return { success: false, error: 'forbidden' };
    const info = this.rt.get(ptyId);
    if (!info || info.state.state === 'exited') return { success: false, error: 'not_found' };
    if (info.kind !== 'agent') return { success: false, error: 'not_agent' };
    if (this.inProgress.has(ptyId)) return { success: false, error: 'in_progress' };
    this.inProgress.add(ptyId);
    try {
      return await this.run(ptyId, opts);
    } finally {
      this.inProgress.delete(ptyId);
    }
  }

  private async run(ptyId: number, opts: CheckinOptions): Promise<CheckinResult> {
    const ws = this.rt.workspaceOf(ptyId);
    const cfg = getCockpitConfig(ws).cockpit;
    const force = !!opts.force && opts.by.kind === 'local-user';

    // State gate.
    let state = this.rt.state(ptyId).state;
    const waitUntil = Date.now() + cfg.checkin.wait_idle_s * 1000;
    while (state === 'busy' && Date.now() < waitUntil) {
      await this.sleep(this.timings.pollMs);
      state = this.rt.state(ptyId).state;
    }
    if (state === 'busy') return { success: false, error: 'busy' };
    if (state === 'awaiting-input') return { success: false, error: 'awaiting_input' };
    if (state === 'exited') return { success: false, error: 'not_found' };
    if (state === 'unknown' && !force) return { success: false, error: 'state_unknown' };

    const checkinId = `chk_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const source: 'hook' | 'screen' = this.rt.hasHooks(ptyId) ? 'hook' : 'screen';
    const sessionId = this.rt.sessionOf(ptyId);
    const windowId = this.rt.windowOf(ptyId);
    const actor = actorFor(opts.by);
    const started = Date.now();
    logCockpitEvent('checkin.start', {
      workspace: ws,
      window_id: windowId,
      actor,
      data: { checkin_id: checkinId, pty_id: ptyId, ...(sessionId ? { session_id: sessionId } : {}), source },
    });
    const startCursor = this.rt.cursor(ptyId);

    // Subscribe before typing so a fast turn end isn't missed.
    let turnEnd: { lee_status: LeeStatusBlock | null; summary: string | null } | null = null;
    const onEvent = (e: LeeEvent) => {
      if (e.type !== 'agent.turn_end') return;
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (d.pty_id !== ptyId) return;
      turnEnd = {
        lee_status: (d.lee_status as LeeStatusBlock | undefined) ?? null,
        summary: typeof d.summary === 'string' ? d.summary : null,
      };
    };
    if (source === 'hook') copilotBus.on('event', onEvent);

    /**
     * `summary` is the agent's own words (lee-status or turn summary) and is
     * logged. `screenTail` is raw screen text for a hook-less agent that
     * printed no lee-status block: it can hold typed input, prompts and
     * commands, so it only goes to the in-memory Feed entry, never the event log.
     */
    const finish = (res: {
      ok: boolean;
      error?: CheckinResult['error'];
      lee?: LeeStatusBlock | null;
      summary?: string | null;
      screenTail?: string | null;
    }): CheckinResult => {
      const taskId = this.rt.taskOf(ptyId);
      const summary = res.summary ? clip(res.summary, SUMMARY_MAX) : null;
      const screenTail = !summary && res.screenTail ? clip(res.screenTail, SUMMARY_MAX) : null;
      logCockpitEvent('checkin.result', {
        workspace: ws,
        window_id: windowId,
        actor,
        data: {
          checkin_id: checkinId,
          pty_id: ptyId,
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(taskId ? { task_id: taskId } : {}),
          ok: res.ok,
          ...(res.error ? { error: res.error } : {}),
          source,
          ...(res.lee ? { lee_status: res.lee } : {}),
          ...(summary ? { summary } : {}),
          duration_ms: Date.now() - started,
        },
      });
      if (res.ok) {
        this.lastCheckinAt.set(ptyId, Date.now());
        cockpitBus.feed.closeByKey(`checkin-proposal:${ptyId}`, 'done');
        cockpitBus.feed.post({
          workspace: ws,
          kind: 'event',
          severity: 'ambient',
          producer: 'checkin',
          title: `Checked in on ${this.rt.labelOf(ptyId)}: ${res.lee?.status ?? 'no status'}`,
          text: summary ?? screenTail,
          text_is_agent: !!summary,
          ref: { pty_id: ptyId, checkin_id: checkinId, ...(taskId ? { task_id: taskId } : {}) },
        });
      }
      return {
        success: res.ok,
        checkin_id: checkinId,
        ...(res.error ? { error: res.error } : {}),
        lee_status: res.lee ?? null,
        summary,
        source,
        task_id: taskId,
      };
    };

    try {
      const sent = await this.rt.send(ptyId, { text: CHECKIN_PROMPT, submit: true, purpose: 'checkin', force }, opts.by);
      if (!sent.success) {
        const error: CheckinResult['error'] = !sent.error || sent.error === 'invalid' ? 'state_unknown' : sent.error;
        return finish({ ok: false, error });
      }
      const deadline = started + cfg.checkin.timeout_s * 1000;
      if (source === 'hook') {
        while (!turnEnd && Date.now() < deadline) {
          if (!this.rt.exists(ptyId) || this.rt.state(ptyId).state === 'exited') break;
          await this.sleep(this.timings.screenPollMs);
        }
        const got = turnEnd as { lee_status: LeeStatusBlock | null; summary: string | null } | null;
        if (!got) return finish({ ok: false, error: 'timeout' });
        return finish({ ok: true, lee: got.lee_status ?? parseLeeStatus(got.summary), summary: got.lee_status?.summary ?? got.summary });
      }
      // Screen: wait for the agent to leave idle and come back to it, quiet for 2 x quiet_ms.
      // A forced check-in on an agent with no prompt_pattern never reads
      // idle-at-prompt (only busy or unknown): there, "worked, then went
      // quiet" is the end of its turn.
      const fromUnknown = force && state === 'unknown';
      let left = false;
      let sawBusy = false;
      while (Date.now() < deadline) {
        await this.sleep(this.timings.screenPollMs);
        const s = this.rt.state(ptyId);
        if (s.state === 'exited') break;
        if (s.state !== 'idle-at-prompt') left = true;
        if (s.state === 'busy') sawBusy = true;
        const moved = this.rt.cursor(ptyId) > startCursor;
        const quiet = s.quiet_ms >= 2 * cfg.tab.quiet_ms;
        const atPrompt = (left || moved) && s.state === 'idle-at-prompt';
        const settled = fromUnknown && moved && sawBusy && s.state === 'unknown';
        if ((atPrompt || settled) && quiet) {
          const text = this.rt.read(ptyId, { since: startCursor, max_chars: 262_144 }).text;
          const lee = parseLeeStatus(text);
          const tail = text.split('\n').filter((l) => l.trim()).slice(-20).join('\n');
          return finish({ ok: true, lee, summary: lee?.summary ?? null, screenTail: tail || null });
        }
      }
      return finish({ ok: false, error: 'timeout' });
    } finally {
      if (source === 'hook') copilotBus.off('event', onEvent);
    }
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
      title: `Check in on ${info.label}?`,
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
