/**
 * voiceModel - the mic's state machine (§5.3 rules), pure so the smoke can
 * walk it: idle → arming (asking for the mic) → recording → transcribing →
 * idle, or error (shown inline, then idle). Tap toggles; a hold longer than
 * VOICE_HOLD_MS stops on release; the cap stops and still transcribes; cancel
 * discards from anywhere.
 */

import { VOICE_HOLD_MS, VOICE_MAX_MS, type VoiceState } from '../../../shared/voice';

export type VoiceEvent =
  | { kind: 'press' }
  | { kind: 'release'; heldMs: number; startedByThisPress: boolean }
  | { kind: 'armed' }
  | { kind: 'cap' }
  | { kind: 'transcribed' }
  | { kind: 'failed' }
  | { kind: 'cancel' }
  | { kind: 'clear' };

/** What the hook should do after an event. */
export type VoiceEffect = 'start' | 'stop' | 'discard' | null;

export function voiceStep(state: VoiceState, ev: VoiceEvent): { state: VoiceState; effect: VoiceEffect } {
  switch (ev.kind) {
    case 'press':
      if (state === 'idle' || state === 'error') return { state: 'arming', effect: 'start' };
      // A second tap while recording stops it.
      if (state === 'recording') return { state: 'transcribing', effect: 'stop' };
      return { state, effect: null };
    case 'release':
      // A hold (the press that started it, held past the threshold) stops on release.
      if (state === 'recording' && ev.startedByThisPress && ev.heldMs > VOICE_HOLD_MS) return { state: 'transcribing', effect: 'stop' };
      return { state, effect: null };
    case 'armed':
      return state === 'arming' ? { state: 'recording', effect: null } : { state, effect: null };
    case 'cap':
      return state === 'recording' ? { state: 'transcribing', effect: 'stop' } : { state, effect: null };
    case 'transcribed':
      return { state: 'idle', effect: null };
    case 'failed':
      return { state: 'error', effect: null };
    case 'cancel':
      return state === 'idle' ? { state, effect: null } : { state: 'idle', effect: 'discard' };
    case 'clear':
      return state === 'error' ? { state: 'idle', effect: null } : { state, effect: null };
  }
}

/** The client cap: the lower of ours and the daemon's max_seconds. */
export function recordCapMs(maxSeconds: number | null | undefined): number {
  return maxSeconds && maxSeconds > 0 ? Math.min(VOICE_MAX_MS, maxSeconds * 1000) : VOICE_MAX_MS;
}

/** "0:07" for the elapsed time. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
