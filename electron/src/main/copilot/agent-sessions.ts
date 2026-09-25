/**
 * Per-session state for Claude Code agents Lee launched: the
 * session_id <-> pty_id map, busy accounting, the pending tool and the files
 * the session wrote. Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §6.4.
 */

import type { LeeStatusBlock } from '../../shared/copilot';

export const MAX_SESSION_FILES = 50;

export interface PendingTool {
  name: string;
  preview: string;
  signature: string;
  tool_use_id: string | null;
  files: string[];
}

export type AgentActivity = 'busy' | 'idle' | 'waiting' | 'unknown';

export interface AgentSession {
  session_id: string;
  pty_id: number | null;
  provider: string;
  cwd: string | null;
  started_at: number;
  last_event_at: number;
  /** Set while the agent is working; null while idle or paused. */
  busy_since: number | null;
  /** Busy time accrued in the current turn before the latest pause. */
  busy_accum_ms: number;
  /** True between a turn start and its Stop, even while paused on a prompt. */
  in_turn: boolean;
  activity: AgentActivity;
  pending_tool: PendingTool | null;
  files_written: string[];
  last_summary: string | null;
  last_lee_status: LeeStatusBlock | null;
  ended: boolean;
}

export class AgentSessions {
  private sessions = new Map<string, AgentSession>();
  private ptyBySession = new Map<string, number>();

  /** Remember `session_id -> pty_id` if the header gave one; otherwise look it up. */
  resolvePty(sessionId: string | null, headerPty: number | null): number | null {
    if (sessionId && headerPty != null) {
      this.ptyBySession.set(sessionId, headerPty);
      const s = this.sessions.get(sessionId);
      if (s) s.pty_id = headerPty;
      return headerPty;
    }
    if (headerPty != null) return headerPty;
    if (sessionId) return this.ptyBySession.get(sessionId) ?? null;
    return null;
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  ensure(sessionId: string, ptyId: number | null, cwd: string | null, now: number): AgentSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        session_id: sessionId,
        pty_id: ptyId,
        provider: 'claude',
        cwd,
        started_at: now,
        last_event_at: now,
        busy_since: null,
        busy_accum_ms: 0,
        in_turn: false,
        activity: 'unknown',
        pending_tool: null,
        files_written: [],
        last_summary: null,
        last_lee_status: null,
        ended: false,
      };
      this.sessions.set(sessionId, s);
      if (ptyId != null) this.ptyBySession.set(sessionId, ptyId);
    }
    if (ptyId != null) s.pty_id = ptyId;
    if (cwd) s.cwd = cwd;
    s.last_event_at = now;
    s.ended = false;
    return s;
  }

  /** The most recently active, not-ended session on a PTY. */
  byPty(ptyId: number): AgentSession | undefined {
    let best: AgentSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.pty_id !== ptyId || s.ended) continue;
      if (!best || s.last_event_at > best.last_event_at) best = s;
    }
    return best;
  }

  /** The most recent session on a PTY, ended or not. */
  latestForPty(ptyId: number): AgentSession | undefined {
    let best: AgentSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.pty_id === ptyId && (!best || s.last_event_at > best.last_event_at)) best = s;
    }
    return best;
  }

  /** Every PTY with a live (not ended) session. */
  trackedPtys(): Set<number> {
    const out = new Set<number>();
    for (const s of this.sessions.values()) if (!s.ended && s.pty_id != null) out.add(s.pty_id);
    return out;
  }

  isTrackedPty(ptyId: number): boolean {
    for (const s of this.sessions.values()) if (s.pty_id === ptyId) return true;
    return false;
  }

  live(): AgentSession[] {
    return Array.from(this.sessions.values()).filter((s) => !s.ended);
  }

  /** Turn start (UserPromptSubmit) or the first PreToolUse of an unstarted turn. */
  startBusy(s: AgentSession, now: number, newTurn: boolean): void {
    if (newTurn || !s.in_turn) {
      s.in_turn = true;
      s.busy_accum_ms = 0;
      s.busy_since = now;
    } else if (s.busy_since === null) {
      s.busy_since = now;
    }
    s.activity = 'busy';
  }

  /** PermissionRequest / Notification: the agent is waiting on a human. */
  pauseBusy(s: AgentSession, now: number): void {
    if (s.busy_since !== null) {
      s.busy_accum_ms += Math.max(0, now - s.busy_since);
      s.busy_since = null;
    }
    s.activity = 'waiting';
  }

  /** PostToolUse: the tool ran, so the agent is working again. */
  resumeBusy(s: AgentSession, now: number): void {
    if (!s.in_turn) {
      this.startBusy(s, now, true);
      return;
    }
    if (s.busy_since === null) s.busy_since = now;
    s.activity = 'busy';
  }

  /** Stop: returns the busy time of the turn and resets. */
  endTurn(s: AgentSession, now: number): number {
    let busy = s.busy_accum_ms;
    if (s.busy_since !== null) busy += Math.max(0, now - s.busy_since);
    s.busy_since = null;
    s.busy_accum_ms = 0;
    s.in_turn = false;
    s.pending_tool = null;
    s.activity = 'idle';
    return busy;
  }

  addWritten(s: AgentSession, files: string[]): void {
    for (const f of files) {
      if (s.files_written.includes(f)) continue;
      s.files_written.push(f);
      if (s.files_written.length > MAX_SESSION_FILES) s.files_written.shift();
    }
  }

  end(s: AgentSession): void {
    s.ended = true;
    s.busy_since = null;
    s.in_turn = false;
    s.pending_tool = null;
    s.activity = 'unknown';
  }

  /** PTY exited: end its sessions and return them. */
  endPty(ptyId: number): AgentSession[] {
    const out: AgentSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.pty_id !== ptyId || s.ended) continue;
      this.end(s);
      out.push(s);
    }
    return out;
  }

  /** Drop ended sessions idle for longer than `maxAgeMs`. */
  prune(now: number, maxAgeMs: number): void {
    for (const [id, s] of this.sessions) {
      if (s.ended && now - s.last_event_at > maxAgeMs) {
        this.sessions.delete(id);
        this.ptyBySession.delete(id);
      }
    }
  }
}
