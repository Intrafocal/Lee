/**
 * Per-session state for Claude Code agents Lee launched: the
 * session_id <-> pty_id map, busy accounting, the pending tool and the files
 * the session wrote. Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §6.4.
 */

import type { AgentActivity as ActivityEntry, AgentNow } from '../../shared/cockpit';
import type { LeeStatusBlock } from '../../shared/copilot';
import { clip, type ParsedQuestion } from './hook-payload';

export const MAX_SESSION_FILES = 50;

/** Cockpit design §7.1: activity entries kept per session, and how many a snapshot shows. */
export const MAX_ACTIVITY = 20;
export const RECENT_ACTIVITY = 8;
/** A finished call still counts as "now" for this long after it ends. */
export const ACTIVITY_NOW_MS = 60_000;
/** Activity previews are toolPreview, capped shorter. */
export const ACTIVITY_PREVIEW_MAX = 160;

export interface PendingTool {
  name: string;
  preview: string;
  signature: string;
  tool_use_id: string | null;
  /** Subagent id from the hook input; null for the main agent. */
  agent_id: string | null;
  files: string[];
  /** AskUserQuestion calls: the parsed question (the agent's words; never logged). */
  question?: ParsedQuestion | null;
  /** When PreToolUse started it (ms); the activity ring's `now.since`. */
  started_at?: number;
}

/** Tool calls that have started (PreToolUse) and not finished yet, per session. */
export const MAX_OPEN_TOOLS = 32;

export type AgentActivity = 'busy' | 'idle' | 'waiting' | 'unknown';

export interface AgentSession {
  session_id: string;
  pty_id: number | null;
  provider: string;
  cwd: string | null;
  /**
   * The directory the session started in (its SessionStart cwd, else the
   * first seen): where Claude files it, so where `claude --resume` finds it.
   * `cwd` follows the agent if it moves.
   */
  start_cwd?: string | null;
  started_at: number;
  last_event_at: number;
  /** Set while the agent is working; null while idle or paused. */
  busy_since: number | null;
  /** Busy time accrued in the current turn before the latest pause. */
  busy_accum_ms: number;
  /** True between a turn start and its Stop, even while paused on a prompt. */
  in_turn: boolean;
  /** Start of the current turn (wall time, pauses included); null outside a turn. */
  turn_started_at: number | null;
  /** End of the last turn; null until one ends. */
  turn_ended_at: number | null;
  /** Name of the most recently started tool call (never its input). */
  last_tool: string | null;
  activity: AgentActivity;
  pending_tool: PendingTool | null;
  /** Started, unfinished tool calls (PreToolUse without PostToolUse[Failure]). */
  open_tools: PendingTool[];
  /**
   * True while the agent is actually sitting on a prompt that takes keys: a
   * permission prompt (PermissionRequest or an approval Notification) or an
   * AskUserQuestion picker, until it is answered in the tab, the tool
   * finishes, the turn ends or is interrupted. Device approve/deny/choose is
   * only written into the PTY while this is set.
   */
  awaiting_input: boolean;
  files_written: string[];
  last_summary: string | null;
  last_lee_status: LeeStatusBlock | null;
  /** Cockpit design §7.1: the last MAX_ACTIVITY tool calls (pre and post), oldest first. In memory only. */
  activity_log: ActivityEntry[];
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
        start_cwd: cwd,
        started_at: now,
        last_event_at: now,
        busy_since: null,
        busy_accum_ms: 0,
        in_turn: false,
        turn_started_at: null,
        turn_ended_at: null,
        last_tool: null,
        activity: 'unknown',
        pending_tool: null,
        open_tools: [],
        awaiting_input: false,
        files_written: [],
        last_summary: null,
        last_lee_status: null,
        activity_log: [],
        ended: false,
      };
      this.sessions.set(sessionId, s);
      if (ptyId != null) this.ptyBySession.set(sessionId, ptyId);
    }
    if (ptyId != null) s.pty_id = ptyId;
    if (cwd) s.cwd = cwd;
    if (cwd && !s.start_cwd) s.start_cwd = cwd;
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
      s.turn_started_at = now;
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
    s.turn_started_at = null;
    s.turn_ended_at = now;
    s.pending_tool = null;
    s.open_tools = [];
    s.awaiting_input = false;
    s.activity = 'idle';
    return busy;
  }

  /**
   * The turn ended without a Stop (Esc on a permission prompt interrupts the
   * turn; Claude's idle_prompt Notification means it is back at the input).
   */
  interrupt(s: AgentSession, now: number): void {
    this.endTurn(s, now);
  }

  /** PreToolUse: remember the started call. */
  openTool(s: AgentSession, tool: PendingTool): void {
    if (tool.tool_use_id) s.open_tools = s.open_tools.filter((t) => t.tool_use_id !== tool.tool_use_id);
    s.open_tools.push(tool);
    if (s.open_tools.length > MAX_OPEN_TOOLS) s.open_tools.shift();
    s.pending_tool = tool;
    s.last_tool = tool.name;
  }

  /**
   * PostToolUse[Failure]: forget the finished call, matched by tool_use_id,
   * else by signature. Clears pending_tool only when it is that call.
   */
  closeTool(s: AgentSession, toolUseId: string | null, signature: string): void {
    const same = (t: PendingTool) => (toolUseId && t.tool_use_id ? t.tool_use_id === toolUseId : t.signature === signature);
    const idx = s.open_tools.findIndex(same);
    if (idx >= 0) s.open_tools.splice(idx, 1);
    if (s.pending_tool && same(s.pending_tool)) s.pending_tool = s.open_tools[s.open_tools.length - 1] ?? null;
  }

  /** The started call a permission prompt is about: by tool_use_id, else the latest with this signature. */
  findOpenTool(s: AgentSession, toolUseId: string | null, signature: string | null): PendingTool | null {
    if (toolUseId) {
      const byId = s.open_tools.find((t) => t.tool_use_id === toolUseId);
      if (byId) return byId;
    }
    if (signature) {
      for (let i = s.open_tools.length - 1; i >= 0; i--) if (s.open_tools[i].signature === signature) return s.open_tools[i];
    }
    return null;
  }

  /** agent.tool pre or post: append to the session's activity ring. */
  noteActivity(s: AgentSession, entry: ActivityEntry): void {
    s.activity_log.push(entry);
    if (s.activity_log.length > MAX_ACTIVITY) s.activity_log.splice(0, s.activity_log.length - MAX_ACTIVITY);
  }

  /**
   * What the agent is doing now: the open tool if one is running, else the
   * last entry if it is within ACTIVITY_NOW_MS, else null.
   */
  activityNow(s: AgentSession, now: number): AgentNow | null {
    const open = s.pending_tool;
    if (open && !s.ended) {
      return {
        tool: open.name,
        preview: clip(open.preview, ACTIVITY_PREVIEW_MAX),
        files: [...open.files],
        since: new Date(open.started_at ?? s.last_event_at).toISOString(),
      };
    }
    const last = s.activity_log[s.activity_log.length - 1];
    if (!last || now - Date.parse(last.at) > ACTIVITY_NOW_MS) return null;
    return { tool: last.tool, preview: last.preview, files: [...last.files], since: last.at };
  }

  /** The last RECENT_ACTIVITY entries, newest last. */
  recentActivity(s: AgentSession): ActivityEntry[] {
    return s.activity_log.slice(-RECENT_ACTIVITY).map((e) => ({ ...e, files: [...e.files] }));
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
    s.turn_started_at = null;
    s.pending_tool = null;
    s.open_tools = [];
    s.awaiting_input = false;
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
