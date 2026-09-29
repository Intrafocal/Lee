/**
 * wav - the voice wire format (docs/plans/2026-09-28-tether-review-voice.md
 * §5.2): 16 kHz, mono, 16-bit PCM WAV, sent as the raw request body. Pure:
 * no DOM, no audio APIs, so the smoke can check the header byte for byte.
 */

import { VOICE_BITS_PER_SAMPLE, VOICE_CHANNELS, VOICE_SAMPLE_RATE } from '../../../shared/voice';

/** The canonical 44-byte RIFF header. */
export const WAV_HEADER_BYTES = 44;

/** Float samples in [-1, 1] as little-endian PCM16 (clipped, not wrapped). */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** A mono PCM16 WAV of `samples` at `sampleRate` (default 16 kHz). */
export function encodeWav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const pcm = floatToPcm16(samples);
  const channels = VOICE_CHANNELS;
  const bytesPerSample = VOICE_BITS_PER_SAMPLE / 8;
  const dataBytes = pcm.length * bytesPerSample * channels;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  v.setUint16(32, channels * bytesPerSample, true); // block align
  v.setUint16(34, VOICE_BITS_PER_SAMPLE, true);
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i], true);
  return new Uint8Array(buf);
}

/** A WAV's length in ms from its sample count (mono PCM16). */
export function wavDurationMs(sampleCount: number, sampleRate = VOICE_SAMPLE_RATE): number {
  return Math.round((sampleCount / sampleRate) * 1000);
}

/** RMS level of the samples, 0..1 (the silence gate). */
export function rmsLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Below this RMS, a whole clip counts as silence and is never uploaded (Gemini
 * hallucinates on silence, §5.7). About -46 dBFS: a quiet room, not a voice.
 */
export const SILENCE_RMS = 0.005;

/** Why a clip isn't worth uploading, else null (too short, or silence). */
export function clipRejection(samples: Float32Array, sampleRate: number, minMs: number): 'too_short' | 'silence' | null {
  if (wavDurationMs(samples.length, sampleRate) < minMs) return 'too_short';
  if (rmsLevel(samples) < SILENCE_RMS) return 'silence';
  return null;
}
