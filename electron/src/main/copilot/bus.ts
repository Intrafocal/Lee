/**
 * Copilot bus: the in-process seam between work packages A (lee-core) and
 * B (lee-queue-hooks). Neither package imports the other's modules; both
 * import this file.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix B).
 * Copied VERBATIM. Do not edit inside a work package.
 *
 * - Package A registers the event sink (the JSONL writer), the presence
 *   provider and the WebSocket broadcaster.
 * - Package B registers the focus/away provider and stream-connect handlers.
 * - Anyone may call logEvent(); anyone may subscribe to 'event'.
 *
 * Electron-free on purpose, so modules built on it can be smoke-tested with
 * plain node.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type {
  Actor,
  CopilotStreamMessage,
  EventContext,
  LeeEvent,
  LeeEventInput,
  PresenceState,
} from '../../shared/copilot';

export interface EventSink {
  write(event: LeeEvent): void;
}

export interface FocusContextProvider {
  (): { focus_session_id: string | null; away: boolean };
}

type StreamSend = (msg: CopilotStreamMessage) => void;

const MAX_PENDING = 5000;

class CopilotBus extends EventEmitter {
  private sink: EventSink | null = null;
  private pending: LeeEvent[] = [];
  private presenceProvider: (() => PresenceState) | null = null;
  private focusProvider: FocusContextProvider | null = null;
  private broadcaster: StreamSend | null = null;
  private connectHandlers: Array<(send: StreamSend) => void> = [];
  private seq = 0;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Package A: install the event-log writer. Flushes anything logged earlier. */
  setEventSink(sink: EventSink | null): void {
    this.sink = sink;
    if (sink && this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const e of queued) sink.write(e);
    }
  }

  /** Package A: current presence. */
  setPresenceProvider(fn: (() => PresenceState) | null): void {
    this.presenceProvider = fn;
  }

  getPresence(): PresenceState | null {
    try {
      return this.presenceProvider ? this.presenceProvider() : null;
    } catch {
      return null;
    }
  }

  /** Package B: current focus session and away flag. */
  setFocusProvider(fn: FocusContextProvider | null): void {
    this.focusProvider = fn;
  }

  private context(): EventContext {
    const p = this.getPresence();
    let focus: { focus_session_id: string | null; away: boolean } = { focus_session_id: null, away: false };
    try {
      if (this.focusProvider) focus = this.focusProvider();
    } catch {
      // keep defaults
    }
    return {
      at_machine: p ? p.at_machine : true,
      engaged: p ? p.engaged : true,
      focus_session_id: focus.focus_session_id,
      away: focus.away,
    };
  }

  /**
   * Stamp and record an event. Emits 'event' synchronously (listeners must not
   * throw) and hands the line to the sink, or queues it until a sink exists.
   */
  logEvent<T = Record<string, unknown>>(input: LeeEventInput<T>): LeeEvent<T> {
    const now = Date.now();
    const actor: Actor = input.actor ?? { kind: 'system' };
    const event: LeeEvent<T> = {
      v: 1,
      id: `${now.toString(36)}-${(this.seq++).toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      ts: new Date(now).toISOString(),
      type: input.type,
      source: input.source ?? 'lee-main',
      workspace: input.workspace ?? null,
      window_id: input.window_id ?? null,
      actor,
      ctx: this.context(),
      data: input.data,
    };
    const generic = event as unknown as LeeEvent;
    if (this.sink) {
      try {
        this.sink.write(generic);
      } catch (err) {
        console.error('[copilot] event sink failed:', err);
      }
    } else {
      this.pending.push(generic);
      if (this.pending.length > MAX_PENDING) this.pending.shift();
    }
    try {
      this.emit('event', generic);
    } catch (err) {
      console.error('[copilot] event listener failed:', err);
    }
    return event;
  }

  /** Package A: how to push a message to every /context/stream client. */
  setBroadcaster(fn: StreamSend | null): void {
    this.broadcaster = fn;
  }

  /** Push a message to every /context/stream WebSocket client (devices, Hester). */
  broadcast(msg: CopilotStreamMessage): void {
    if (!this.broadcaster) return;
    try {
      this.broadcaster(msg);
    } catch (err) {
      console.error('[copilot] broadcast failed:', err);
    }
  }

  /** Package B (and A): send an initial message to each newly connected stream client. */
  onStreamConnect(handler: (send: StreamSend) => void): void {
    this.connectHandlers.push(handler);
  }

  /** Called by the API server for each new /context/stream connection. */
  runStreamConnect(send: StreamSend): void {
    for (const h of this.connectHandlers) {
      try {
        h(send);
      } catch (err) {
        console.error('[copilot] stream connect handler failed:', err);
      }
    }
  }
}

export const copilotBus = new CopilotBus();

export function logEvent<T = Record<string, unknown>>(input: LeeEventInput<T>): LeeEvent<T> {
  return copilotBus.logEvent(input);
}
