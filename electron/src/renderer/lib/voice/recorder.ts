/**
 * recorder - one mic clip, as the voice wire format (§5.3 R): MediaRecorder
 * (webm/opus, what Chromium records) → decodeAudioData → an
 * OfflineAudioContext resample to 16 kHz mono → a PCM16 WAV (lib/voice/wav).
 *
 * An AnalyserNode on the live stream drives the level meter (`onLevel`, 0..1)
 * and the finished clip is checked for silence and length before anyone
 * uploads it. The stream's tracks are stopped as soon as recording ends, so
 * macOS's mic indicator goes out with it.
 */

import { VOICE_MIN_MS, VOICE_SAMPLE_RATE } from '../../../shared/voice';
import { clipRejection, encodeWav, wavDurationMs } from './wav';

export interface Clip {
  wav: Uint8Array;
  ms: number;
}

export type ClipOutcome = { ok: true; clip: Clip } | { ok: false; error: 'too_short' | 'silence' | 'cancelled' };

export interface Recording {
  /** Stop and encode. Resolves once; a second call gets the same result. */
  stop(): Promise<ClipOutcome>;
  /** Stop and throw the audio away. */
  cancel(): void;
}

function pickMime(): string | undefined {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR?.isTypeSupported) return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (MR.isTypeSupported(m)) return m;
  return undefined;
}

/** Decode whatever MediaRecorder made and resample it to 16 kHz mono floats. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } finally {
    void ctx.close();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
  const off = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  // A mono destination downmixes the channels (the speakers interpretation).
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Open the mic and start recording. Rejects with 'permission_denied' when the
 * mic can't be had (the OS said no, or there's no input device).
 */
export async function startRecording(onLevel?: (level: number) => void): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new Error('permission_denied');
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  // The level meter: RMS of the time-domain signal, eased, every frame.
  const meterCtx = new AudioContext();
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 1024;
  meterCtx.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  let raf = 0;
  let level = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    // Speech sits around 0.02–0.2 RMS; scale so a normal voice fills the ring.
    const now = Math.min(1, Math.sqrt(sum / frame.length) * 6);
    level = level * 0.6 + now * 0.4;
    onLevel?.(level);
    raf = requestAnimationFrame(tick);
  };
  if (onLevel) raf = requestAnimationFrame(tick);

  const release = () => {
    cancelAnimationFrame(raf);
    for (const t of stream.getTracks()) t.stop();
    void meterCtx.close().catch(() => undefined);
  };

  let cancelled = false;
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  rec.start(250);

  let result: Promise<ClipOutcome> | null = null;
  const stop = (): Promise<ClipOutcome> => {
    if (result) return result;
    result = (async (): Promise<ClipOutcome> => {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      release();
      if (cancelled) return { ok: false, error: 'cancelled' };
      try {
        const samples = await toMono16k(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }));
        const bad = clipRejection(samples, VOICE_SAMPLE_RATE, VOICE_MIN_MS);
        if (bad) return { ok: false, error: bad };
        return { ok: true, clip: { wav: encodeWav(samples), ms: wavDurationMs(samples.length) } };
      } catch {
        // Nothing decodable (a clip too short for a single opus frame).
        return { ok: false, error: 'too_short' };
      }
    })();
    return result;
  };
  return {
    stop,
    cancel() {
      cancelled = true;
      void stop();
    },
  };
}
