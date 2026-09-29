/**
 * Voice: the one wire contract between Hester (which transcribes) and the
 * clients that record (docs/plans/2026-09-28-tether-review-voice.md §5).
 * Aeronaut (lib/models/voice.dart) and Dirigible (voice.hpp) mirror it by hand.
 */

/** GET /voice on Hester. The mic shows only when `available`. */
export interface VoiceCapabilities {
  enabled: boolean;
  available: boolean;
  reason?: 'disabled' | 'no_api_key' | 'whisper_not_installed' | 'whisper_model_missing';
  provider: string;
  model: string;
  location: string;
  /** Content types the daemon accepts ('audio/wav'). */
  accepts: string[];
  sample_rate: number;
  channels: number;
  max_seconds: number;
  max_bytes: number;
}

/** Where the transcript goes: `?purpose=` on POST /voice/transcribe. */
export type VoicePurpose = 'reply' | 'capture' | 'ask' | 'send';

/** POST /voice/transcribe (raw 16 kHz mono PCM16 WAV body). */
export interface TranscribeResult {
  text: string;
  provider: string;
  model: string;
  location: string;
  audio_ms: number;
  latency_ms: number;
}

/**
 * Server codes (503 voice_disabled / voice_unavailable:<reason>, 415, 413
 * too_large / too_long, 422 too_short, 502, 504) plus the client's own.
 */
export type VoiceErrorCode =
  | 'voice_disabled'
  | 'voice_unavailable'
  | 'unsupported_media_type'
  | 'too_large'
  | 'too_long'
  | 'too_short'
  | 'provider_error'
  | 'timeout'
  | 'permission_denied'
  | 'silence'
  | 'network'
  | 'cancelled';

export type VoiceState = 'idle' | 'arming' | 'recording' | 'transcribing' | 'error';

/** The wire format: 16 kHz, mono, 16-bit PCM WAV. */
export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_CHANNELS = 1;
export const VOICE_BITS_PER_SAMPLE = 16;
/** Shorter clips are never uploaded. */
export const VOICE_MIN_MS = 300;
/** A hold longer than this stops on release (Lee, Aeronaut). */
export const VOICE_HOLD_MS = 300;
/** The client cap: recording auto-stops here and still transcribes. */
export const VOICE_MAX_MS = 60_000;
export const VOICE_MAX_MS_DIRIGIBLE = 30_000;
/** Capabilities are cached this long, and refetched after a 503. */
export const VOICE_CAPABILITIES_TTL_MS = 5 * 60_000;

/**
 * Put a transcript into the field it belongs to: an empty draft becomes `t`;
 * else `draft + (a space if needed) + t`. The caret goes at the end.
 */
export function appendTranscript(draft: string, t: string): { text: string; caret: number } {
  const add = t.trim();
  if (!add) return { text: draft, caret: draft.length };
  if (!draft.trim()) return { text: add, caret: add.length };
  const text = /\s$/.test(draft) ? draft + add : `${draft} ${add}`;
  return { text, caret: text.length };
}
