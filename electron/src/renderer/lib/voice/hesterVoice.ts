/**
 * hesterVoice - Hester's voice routes (§5.2), same origin and auth as
 * lib/hesterCopilot.ts (installHesterAuth adds the bearer token to every
 * daemon fetch; the workspace goes as `?workspace=` and `X-Lee-Workspace`).
 *
 * - GET /voice: capabilities, cached 5 minutes and dropped after any 503, so
 *   the mic hides when voice goes off and comes back when it's on again.
 * - POST /voice/transcribe?purpose=…: the raw WAV body; the transcript or a
 *   VoiceErrorCode. Nothing here keeps the audio or the text.
 */

import {
  VOICE_CAPABILITIES_TTL_MS,
  type TranscribeResult,
  type VoiceCapabilities,
  type VoiceErrorCode,
  type VoicePurpose,
} from '../../../shared/voice';
import { encodeWorkspaceHeader } from '../../../shared/cockpit';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

export type TranscribeOutcome = { ok: true; data: TranscribeResult } | { ok: false; error: VoiceErrorCode };

const SERVER_CODES: VoiceErrorCode[] = ['voice_disabled', 'voice_unavailable', 'unsupported_media_type', 'too_large', 'too_long', 'too_short', 'provider_error', 'timeout'];

/**
 * A failed transcribe as a VoiceErrorCode: the body's code when it names one
 * (`voice_unavailable:<reason>` keeps its prefix), else by status.
 */
export function voiceErrorFrom(status: number, body: unknown): VoiceErrorCode {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const detail = b.detail && typeof b.detail === 'object' ? (b.detail as Record<string, unknown>) : null;
  const raw = [b.error, b.detail, detail?.error, b.code].find((x) => typeof x === 'string') as string | undefined;
  if (raw) {
    const code = raw.split(':')[0].trim() as VoiceErrorCode;
    if (SERVER_CODES.includes(code)) return code;
  }
  switch (status) {
    case 503:
      return 'voice_unavailable';
    case 415:
      return 'unsupported_media_type';
    case 413:
      return 'too_large';
    case 422:
      return 'too_short';
    case 504:
      return 'timeout';
    default:
      return 'provider_error';
  }
}

/** One line for the inline error under a field: short, and says what to do when there's something to do. */
export function voiceErrorText(code: VoiceErrorCode): string {
  switch (code) {
    case 'permission_denied':
      return 'Lee can’t use the mic: allow it in System Settings › Privacy › Microphone';
    case 'silence':
      return 'Didn’t hear anything';
    case 'too_short':
      return 'Too short to transcribe';
    case 'too_long':
    case 'too_large':
      return 'Too long: keep it under a minute';
    case 'voice_disabled':
    case 'voice_unavailable':
      return 'Voice is off in Hester';
    case 'timeout':
      return 'Transcription took too long; try again';
    case 'network':
      return 'Hester offline';
    case 'cancelled':
      return '';
    default:
      return 'Couldn’t transcribe that; try again';
  }
}

let cache: { at: number; caps: VoiceCapabilities | null } | null = null;
let inflight: Promise<VoiceCapabilities | null> | null = null;

/** Drop the cached capabilities (after a 503, or when config changes). */
export function forgetVoiceCapabilities(): void {
  cache = null;
}

/** GET /voice, cached for VOICE_CAPABILITIES_TTL_MS. Null when Hester is offline or too old to know voice. */
export function voiceCapabilities(workspace: string, now = Date.now()): Promise<VoiceCapabilities | null> {
  if (cache && now - cache.at < VOICE_CAPABILITIES_TTL_MS) return Promise.resolve(cache.caps);
  if (inflight) return inflight;
  const url = `${HESTER_DAEMON}/voice?workspace=${encodeURIComponent(workspace)}`;
  inflight = fetch(url, { headers: { 'X-Lee-Workspace': encodeWorkspaceHeader(workspace) } })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      const env = body && typeof body === 'object' && 'success' in (body as object) ? (body as { data?: unknown }).data : body;
      return env && typeof env === 'object' && 'available' in (env as object) ? (env as VoiceCapabilities) : null;
    })
    .catch(() => null)
    .then((caps) => {
      // Offline isn't cached for long: a daemon starting up shows the mic within a minute.
      cache = { at: caps ? now : now - VOICE_CAPABILITIES_TTL_MS + 60_000, caps };
      inflight = null;
      return caps;
    });
  return inflight;
}

/** POST the clip; the transcript, or why not. */
export async function transcribe(
  workspace: string,
  wav: Uint8Array,
  purpose: VoicePurpose,
  opts: { itemId?: string; signal?: AbortSignal } = {},
): Promise<TranscribeOutcome> {
  const q = new URLSearchParams({ purpose, workspace });
  if (opts.itemId) q.set('item_id', opts.itemId);
  let res: Response;
  try {
    res = await fetch(`${HESTER_DAEMON}/voice/transcribe?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-Lee-Workspace': encodeWorkspaceHeader(workspace) },
      body: wav.slice().buffer,
      signal: opts.signal,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'cancelled' : 'network' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    if (res.status === 503) forgetVoiceCapabilities();
    return { ok: false, error: voiceErrorFrom(res.status, body) };
  }
  const env = body && typeof body === 'object' && 'success' in (body as object) ? (body as { data?: unknown }).data : body;
  const data = env as TranscribeResult | null;
  if (!data || typeof data.text !== 'string') return { ok: false, error: 'provider_error' };
  return { ok: true, data };
}
