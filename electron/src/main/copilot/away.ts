/**
 * v1 away policy: the state a handoff puts the queue in, wake marks, and the
 * deterministic "While you were away" summary. Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §7.
 */

import * as crypto from 'crypto';
import type { AwayState, HandoffRequest, SummaryPolicy } from '../../shared/copilot';

export interface AwayEnd {
  handoff_id: string;
  started_at: string;
  away_ms: number;
}

export interface SummaryInput {
  waiting: number;
  parked: number;
  agentLines: Array<{ label: string; summary: string }>;
}

const MAX_SUMMARY_LINES = 5;

function inactive(): AwayState {
  return {
    active: false,
    handoff_id: null,
    started_at: null,
    summary: { mode: 'on_return' },
    summary_delivered: false,
    wake_item_ids: [],
    wake_pty_ids: [],
    parked_count: 0,
  };
}

/** Accepts an ISO time or a local "HH:MM" (the next occurrence). */
export function parseSummaryAt(at: string, now: number): number | null {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

export function normalizeSummaryPolicy(p: unknown): SummaryPolicy {
  if (p && typeof p === 'object') {
    const mode = (p as { mode?: unknown }).mode;
    if (mode === 'none') return { mode: 'none' };
    if (mode === 'at') {
      const at = (p as { at?: unknown }).at;
      if (typeof at === 'string' && at.trim()) return { mode: 'at', at: at.trim() };
    }
  }
  return { mode: 'on_return' };
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class AwayPolicy {
  private state: AwayState = inactive();
  private startedMs: number | null = null;
  private summaryAtMs: number | null = null;
  private turnsEnded = 0;
  private sessionsEnded = 0;

  get active(): boolean {
    return this.state.active;
  }

  get handoffId(): string | null {
    return this.state.handoff_id;
  }

  snapshot(parkedCount: number): AwayState {
    return {
      ...this.state,
      summary: { ...this.state.summary },
      wake_item_ids: [...this.state.wake_item_ids],
      wake_pty_ids: [...this.state.wake_pty_ids],
      parked_count: parkedCount,
    };
  }

  static newHandoffId(now: number): string {
    return `ho_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  }

  start(req: Pick<HandoffRequest, 'summary' | 'wake'>, now: number, handoffId: string = AwayPolicy.newHandoffId(now)): string {
    const summary = normalizeSummaryPolicy(req.summary);
    this.state = {
      active: true,
      handoff_id: handoffId,
      started_at: new Date(now).toISOString(),
      summary,
      summary_delivered: false,
      wake_item_ids: Array.from(new Set((req.wake?.item_ids ?? []).filter((x) => typeof x === 'string'))),
      wake_pty_ids: Array.from(new Set((req.wake?.pty_ids ?? []).filter((x) => Number.isInteger(x)))),
      parked_count: 0,
    };
    this.startedMs = now;
    this.summaryAtMs = summary.mode === 'at' ? parseSummaryAt(summary.at, now) : null;
    this.turnsEnded = 0;
    this.sessionsEnded = 0;
    return handoffId;
  }

  end(now: number): AwayEnd | null {
    if (!this.state.active || !this.state.handoff_id || this.startedMs === null) return null;
    const out: AwayEnd = {
      handoff_id: this.state.handoff_id,
      started_at: this.state.started_at ?? new Date(this.startedMs).toISOString(),
      away_ms: Math.max(0, now - this.startedMs),
    };
    this.state = inactive();
    this.startedMs = null;
    this.summaryAtMs = null;
    return out;
  }

  /** Items from woken PTYs, or woken themselves, follow normal severity while away. */
  isWoken(item: { id: string; wake: boolean; source: { pty_id: number | null } }): boolean {
    if (item.wake) return true;
    if (this.state.wake_item_ids.includes(item.id)) return true;
    return item.source.pty_id != null && this.state.wake_pty_ids.includes(item.source.pty_id);
  }

  setWakeItem(itemId: string, wake: boolean): void {
    if (!this.state.active) return;
    const ids = this.state.wake_item_ids.filter((id) => id !== itemId);
    if (wake) ids.push(itemId);
    this.state.wake_item_ids = ids;
  }

  noteTurnEnd(): void {
    if (this.state.active) this.turnsEnded++;
  }

  noteSessionEnd(): void {
    if (this.state.active) this.sessionsEnded++;
  }

  get counters(): { turns_ended: number; sessions_ended: number } {
    return { turns_ended: this.turnsEnded, sessions_ended: this.sessionsEnded };
  }

  summaryDue(now: number): boolean {
    return (
      this.state.active &&
      !this.state.summary_delivered &&
      this.state.summary.mode === 'at' &&
      this.summaryAtMs !== null &&
      now >= this.summaryAtMs
    );
  }

  markSummaryDelivered(): void {
    this.state.summary_delivered = true;
  }

  summaryText(input: SummaryInput): string {
    const since = this.startedMs !== null ? hhmm(this.startedMs) : '--:--';
    const head =
      `${input.waiting} waiting (${input.parked} parked) · ${this.turnsEnded} turns finished · ` +
      `${this.sessionsEnded} sessions ended since ${since}`;
    const lines = input.agentLines.slice(0, MAX_SUMMARY_LINES).map((a) => {
      const first = a.summary.split('\n').find((l) => l.trim()) ?? '';
      const oneLine = first.trim().length > 120 ? first.trim().slice(0, 119) + '…' : first.trim();
      return `• ${a.label}: ${oneLine}`;
    });
    return [head, ...lines].join('\n');
  }
}
