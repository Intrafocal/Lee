/**
 * tetherIpc - the renderer's one seam with Lee main for Send to Lee and the
 * mic (docs/plans/2026-09-28-tether-review-voice.md §4.2, §5.3). Main owns
 * the channels and `window.lee.tether` / `window.lee.voice` (preload,
 * shared/lee-api.ts); this file is the only place the renderer names them,
 * so a rename on main's side is a change here and nowhere else.
 *
 * Expected shape (every method optional: an older main, or no Electron,
 * degrades to "not available"):
 *
 *   lee.tether.onSend(cb)            ← IPC `tether:send` {send_id, target, items, submit?, source_device?, compose?}
 *   lee.tether.sendResult(r)         → IPC `tether:send-result` {send_id, ok, error?}
 *   lee.tether.saveInboxImage(p)     → ~/.lee/inbox/<send_id>-<n>.<ext> (0600), resolves to its absolute path
 *   lee.tether.setPaletteOpen(open)  → whether the palette is open (main builds GET /tether/targets itself)
 *   lee.voice.micStatus()            → systemPreferences.getMediaAccessStatus('microphone')
 *   lee.voice.requestMic()           → askForMediaAccess('microphone')
 *
 * Main's delivery names the device as `from.surface`; onTetherSend maps it to `source_device`.
 */

import type { SendItem, SendTarget, SendTargets } from '../../shared/tether';

/** One `tether:send` from main, after it validated the request. */
export interface TetherSendIpc {
  send_id: string;
  /** Resolved by main: never 'focus' here. */
  target: SendTarget;
  items: SendItem[];
  submit?: boolean;
  /** Which device sent it, for the chip ("From your phone"). */
  source_device?: 'aeronaut' | 'dirigible' | string;
  /** A compose send from a device's tab view: no chip (you're watching that tab). */
  compose?: boolean;
}

export interface TetherSendResultIpc {
  send_id: string;
  ok: boolean;
  error?: string;
}

type Unsubscribe = () => void;

/** Main's delivery (shared/lee-api.ts TetherSendDelivery): the device is `from.surface`. */
type MainDelivery = TetherSendIpc & { from?: { surface?: string; device_name?: string } };

interface TetherBridgeApi {
  onSend?: (cb: (req: MainDelivery) => void) => Unsubscribe;
  sendResult?: (r: TetherSendResultIpc) => void;
  saveInboxImage?: (p: { send_id: string; n: number; mime: string; data_b64: string }) => Promise<string | null>;
  /** Main works out the focus itself; it only needs to know whether the palette is open. */
  setPaletteOpen?: (open: boolean) => void;
}

export type MicStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

interface VoiceBridgeApi {
  micStatus?: () => Promise<MicStatus | string>;
  /** Main's name (shared/lee-api.ts VoiceAPI). */
  requestMic?: () => Promise<boolean>;
}

function lee(): Record<string, unknown> | null {
  return typeof window !== 'undefined' && window.lee ? (window.lee as unknown as Record<string, unknown>) : null;
}
const tether = (): TetherBridgeApi | null => (lee()?.tether as TetherBridgeApi | undefined) ?? null;
const voice = (): VoiceBridgeApi | null => (lee()?.voice as VoiceBridgeApi | undefined) ?? null;

/** Listen for sends from main; a no-op outside Electron or on an older main. */
export function onTetherSend(cb: (req: TetherSendIpc) => void): Unsubscribe {
  const t = tether();
  if (!t?.onSend) return () => undefined;
  try {
    return t.onSend((d) => cb({ ...d, source_device: d.source_device ?? d.from?.surface, compose: d.compose === true }));
  } catch {
    return () => undefined;
  }
}

export function answerTetherSend(r: TetherSendResultIpc): void {
  try {
    tether()?.sendResult?.(r);
  } catch {
    /* main went away: its 10 s timeout answers the device */
  }
}

/** Save an image for a tab to the inbox; its absolute path, or null when main can't. */
export async function saveInboxImage(p: { send_id: string; n: number; mime: string; data_b64: string }): Promise<string | null> {
  const t = tether();
  if (!t?.saveInboxImage) return null;
  try {
    return await t.saveInboxImage(p);
  } catch {
    return null;
  }
}

export function publishSendTargets(targets: SendTargets): void {
  try {
    // Main builds GET /tether/targets from its own context; the palette is the one thing it can't see.
    tether()?.setPaletteOpen?.(targets.focus?.kind === 'hester');
  } catch {
    /* an older main: GET /tether/targets builds from its own context */
  }
}

/** The mic's OS permission; 'unknown' outside Electron (getUserMedia then asks for itself). */
export async function micStatus(): Promise<MicStatus> {
  const v = voice();
  if (!v?.micStatus) return 'unknown';
  try {
    const s = await v.micStatus();
    return (['granted', 'denied', 'not-determined', 'restricted'] as const).includes(s as never) ? (s as MicStatus) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Ask macOS for the mic (the first time); true when granted or when there's nothing to ask. */
export async function micRequest(): Promise<boolean> {
  const v = voice();
  if (!v?.requestMic) return true;
  try {
    return await v.requestMic();
  } catch {
    return false;
  }
}
