/**
 * Presence and engagement (contracts §3).
 *
 *   at_machine  OS idle < presence.at_machine_idle_seconds, screen unlocked, not suspended
 *   lee_active  keyboard/mouse input in a Lee window within presence.lee_active_seconds
 *   engaged     any human action (Lee input or a device request) within presence.engaged_seconds
 *
 * Electron-free: the OS idle time is injected (powerMonitor in core.ts), as
 * are lock/suspend transitions, so this can be exercised with plain node.
 */

import type { PresenceState } from '../../shared/copilot';
import type { CopilotConfig } from './config';

export type PresenceReason =
  | 'os_idle'
  | 'os_active'
  | 'lock'
  | 'unlock'
  | 'suspend'
  | 'resume'
  | 'lee_input'
  | 'lee_idle'
  | 'device'
  | 'engaged_timeout';

export interface PresenceFlags {
  at_machine: boolean;
  lee_active: boolean;
  engaged: boolean;
}

export interface PresenceChange {
  from: PresenceFlags;
  to: PresenceFlags;
  reason: PresenceReason;
  away_ms?: number;
  state: PresenceState;
}

export interface PresenceTrackerOptions {
  /** Seconds since the last OS-level keyboard/mouse input. */
  getSystemIdleSeconds: () => number;
  getConfig: () => CopilotConfig;
  onChange: (change: PresenceChange) => void;
  pollMs?: number;
  now?: () => number;
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export class PresenceTracker {
  private readonly opts: PresenceTrackerOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private locked = false;
  private suspended = false;
  private osIdleSeconds = 0;
  private lastLeeInputAt: number | null = null;
  private lastEngagedAt: number | null = null;
  private engagedVia: 'lee' | 'device' | null = null;
  private engagedDeviceId: string | null = null;

  private flags: PresenceFlags;
  private since: number;
  private awaySince: number | null = null;

  constructor(opts: PresenceTrackerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.osIdleSeconds = this.readIdle();
    this.flags = this.compute();
    this.since = this.now();
    if (!this.flags.at_machine) this.awaySince = this.since;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 5000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): PresenceState {
    return {
      at_machine: this.flags.at_machine,
      lee_active: this.flags.lee_active,
      engaged: this.flags.engaged,
      engaged_via: this.flags.engaged ? this.engagedVia : null,
      engaged_device_id: this.flags.engaged && this.engagedVia === 'device' ? this.engagedDeviceId : null,
      locked: this.locked,
      last_lee_input_at: iso(this.lastLeeInputAt),
      last_engaged_at: iso(this.lastEngagedAt),
      away_since: this.flags.at_machine ? null : iso(this.awaySince),
      since: new Date(this.since).toISOString(),
    };
  }

  /** Periodic OS idle poll; also expires lee_active and engaged. */
  poll(): void {
    this.osIdleSeconds = this.readIdle();
    const prev = this.flags;
    const next = this.compute();
    let reason: PresenceReason;
    if (prev.at_machine !== next.at_machine) reason = next.at_machine ? 'os_active' : 'os_idle';
    else if (prev.lee_active !== next.lee_active) reason = next.lee_active ? 'lee_input' : 'lee_idle';
    else if (prev.engaged !== next.engaged) reason = next.engaged ? 'lee_input' : 'engaged_timeout';
    else return;
    this.apply(next, reason);
  }

  /** Keyboard or mouse input in a Lee window. */
  noteLeeInput(): void {
    const now = this.now();
    this.lastLeeInputAt = now;
    this.lastEngagedAt = now;
    this.engagedVia = 'lee';
    this.engagedDeviceId = null;
    this.locked = false;
    this.suspended = false;
    this.osIdleSeconds = 0;
    this.update('lee_input');
  }

  /** Any authenticated request from a paired device. */
  noteDevice(deviceId: string): void {
    this.lastEngagedAt = this.now();
    this.engagedVia = 'device';
    this.engagedDeviceId = deviceId;
    this.update('device');
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    if (!locked) this.osIdleSeconds = this.readIdle();
    this.update(locked ? 'lock' : 'unlock');
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (!suspended) this.osIdleSeconds = this.readIdle();
    this.update(suspended ? 'suspend' : 'resume');
  }

  private update(reason: PresenceReason): void {
    const next = this.compute();
    const prev = this.flags;
    if (prev.at_machine === next.at_machine && prev.lee_active === next.lee_active && prev.engaged === next.engaged) {
      return;
    }
    this.apply(next, reason);
  }

  private apply(next: PresenceFlags, reason: PresenceReason): void {
    const now = this.now();
    const prev = this.flags;
    let awayMs: number | undefined;
    if (prev.at_machine !== next.at_machine) {
      if (next.at_machine) {
        awayMs = this.awaySince != null ? now - this.awaySince : undefined;
        this.awaySince = null;
      } else {
        this.awaySince = now;
      }
      this.since = now;
    }
    this.flags = next;
    try {
      this.opts.onChange({ from: prev, to: next, reason, away_ms: awayMs, state: this.get() });
    } catch {
      // listeners must not break presence tracking
    }
  }

  private compute(): PresenceFlags {
    const cfg = this.opts.getConfig().presence;
    const now = this.now();
    const at_machine = !this.locked && !this.suspended && this.osIdleSeconds < cfg.at_machine_idle_seconds;
    const lee_active = this.lastLeeInputAt != null && now - this.lastLeeInputAt < cfg.lee_active_seconds * 1000;
    const engaged = this.lastEngagedAt != null && now - this.lastEngagedAt < cfg.engaged_seconds * 1000;
    return { at_machine, lee_active, engaged };
  }

  private readIdle(): number {
    try {
      const v = this.opts.getSystemIdleSeconds();
      return Number.isFinite(v) && v >= 0 ? v : 0;
    } catch {
      return 0;
    }
  }
}
