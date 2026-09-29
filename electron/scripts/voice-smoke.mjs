#!/usr/bin/env node
/**
 * Smoke test for the renderer's voice logic (docs/plans/2026-09-28-tether-review-voice.md §5.3):
 *
 * - lib/voice/wav.ts: the 44-byte header byte for byte (RIFF, fmt, 16 kHz,
 *   mono, PCM16, byte rate, block align, data size), the length, clipping,
 *   and the too-short / silence gate.
 * - shared/voice.ts appendTranscript: empty draft, a space when needed, the
 *   caret at the end, blank transcripts.
 * - lib/voice/voiceModel.ts: tap toggles, a hold stops on release, the cap
 *   stops and still transcribes, cancel discards, errors clear.
 * - lib/voice/hesterVoice.ts: server errors to VoiceErrorCode (body code,
 *   `voice_unavailable:<reason>`, by status), and the capabilities cache
 *   (5 minutes, dropped after a 503).
 *
 * Bundles the real sources with esbuild; no Hester, React, DOM or audio.
 *
 * Run: node scripts/voice-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bundle(rel, name) {
  const built = await esbuild.build({ entryPoints: [join(__dirname, rel)], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const dir = mkdtempSync(join(__dirname, `.voice-smoke-${name}-`));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, built.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`not ok - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// fetch stub for hesterVoice
const calls = [];
let reply = { status: 200, body: {} };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
};

const wav = await bundle('../src/renderer/lib/voice/wav.ts', 'wav');
const shared = await bundle('../src/shared/voice.ts', 'shared');
const model = await bundle('../src/renderer/lib/voice/voiceModel.ts', 'model');
const hv = await bundle('../src/renderer/lib/voice/hesterVoice.ts', 'hv');

const ascii = (u8, at, n) => String.fromCharCode(...u8.slice(at, at + n));

await test('wav: 44-byte header, 16 kHz mono PCM16, sizes', () => {
  const samples = new Float32Array(16000); // one second
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10) * 0.5;
  const out = wav.encodeWav(samples);
  assert.equal(out.length, 44 + 32000, 'header plus 2 bytes a sample');
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  assert.equal(ascii(out, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 32000, 'RIFF size');
  assert.equal(ascii(out, 8, 4), 'WAVE');
  assert.equal(ascii(out, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16, 'fmt chunk size');
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(v.getUint32(24, true), 16000, 'sample rate');
  assert.equal(v.getUint32(28, true), 32000, 'byte rate');
  assert.equal(v.getUint16(32, true), 2, 'block align');
  assert.equal(v.getUint16(34, true), 16, 'bits per sample');
  assert.equal(ascii(out, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 32000, 'data size');
  assert.equal(wav.wavDurationMs(samples.length), 1000);
  assert.equal(shared.VOICE_SAMPLE_RATE, 16000);
});

await test('wav: samples clip at ±1 and map to the PCM16 range', () => {
  const pcm = wav.floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.deepEqual(Array.from(pcm), [0, 32767, -32768, 32767, -32768, 16384]);
  const out = wav.encodeWav(new Float32Array([1, -1]));
  const v = new DataView(out.buffer);
  assert.equal(v.getInt16(44, true), 32767);
  assert.equal(v.getInt16(46, true), -32768);
});

await test('wav: too short and silent clips are never uploaded', () => {
  const loud = (n) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 8) * 0.3);
  assert.equal(wav.clipRejection(loud(16000 * 0.2), 16000, shared.VOICE_MIN_MS), 'too_short', '200 ms');
  assert.equal(wav.clipRejection(new Float32Array(16000), 16000, shared.VOICE_MIN_MS), 'silence', 'a second of nothing');
  assert.equal(wav.clipRejection(loud(16000), 16000, shared.VOICE_MIN_MS), null, 'a second of voice');
  assert.equal(wav.rmsLevel(new Float32Array(0)), 0);
});

await test('appendTranscript: empty draft, a space when needed, caret at the end', () => {
  assert.deepEqual(shared.appendTranscript('', 'hello there'), { text: 'hello there', caret: 11 });
  assert.deepEqual(shared.appendTranscript('   ', ' hi '), { text: 'hi', caret: 2 }, 'whitespace-only draft is empty');
  assert.deepEqual(shared.appendTranscript('Fix it', 'and test'), { text: 'Fix it and test', caret: 15 });
  assert.deepEqual(shared.appendTranscript('Fix it ', 'and test'), { text: 'Fix it and test', caret: 15 }, 'no double space');
  assert.deepEqual(shared.appendTranscript('line\n', 'next'), { text: 'line\nnext', caret: 9 }, 'a newline counts as space');
  assert.deepEqual(shared.appendTranscript('keep', '   '), { text: 'keep', caret: 4 }, 'a blank transcript changes nothing');
});

await test('voiceModel: tap to start, tap to stop; a hold stops on release', () => {
  let s = model.voiceStep('idle', { kind: 'press' });
  assert.deepEqual(s, { state: 'arming', effect: 'start' });
  s = model.voiceStep(s.state, { kind: 'armed' });
  assert.deepEqual(s, { state: 'recording', effect: null });
  // A quick tap's release does nothing: it keeps recording.
  assert.deepEqual(model.voiceStep('recording', { kind: 'release', heldMs: 120, startedByThisPress: true }), { state: 'recording', effect: null });
  // The second tap stops.
  assert.deepEqual(model.voiceStep('recording', { kind: 'press' }), { state: 'transcribing', effect: 'stop' });
  // A hold over 300 ms stops on release.
  assert.deepEqual(model.voiceStep('recording', { kind: 'release', heldMs: 900, startedByThisPress: true }), { state: 'transcribing', effect: 'stop' });
  // The release of the stopping tap doesn't count as a hold.
  assert.deepEqual(model.voiceStep('transcribing', { kind: 'release', heldMs: 900, startedByThisPress: false }), { state: 'transcribing', effect: null });
  assert.deepEqual(model.voiceStep('transcribing', { kind: 'press' }), { state: 'transcribing', effect: null }, 'no second recording while transcribing');
});

await test('voiceModel: the cap stops and transcribes; cancel discards; errors clear', () => {
  assert.deepEqual(model.voiceStep('recording', { kind: 'cap' }), { state: 'transcribing', effect: 'stop' });
  assert.deepEqual(model.voiceStep('idle', { kind: 'cap' }), { state: 'idle', effect: null });
  assert.deepEqual(model.voiceStep('recording', { kind: 'cancel' }), { state: 'idle', effect: 'discard' });
  assert.deepEqual(model.voiceStep('transcribing', { kind: 'cancel' }), { state: 'idle', effect: 'discard' });
  assert.deepEqual(model.voiceStep('idle', { kind: 'cancel' }), { state: 'idle', effect: null });
  assert.deepEqual(model.voiceStep('transcribing', { kind: 'failed' }), { state: 'error', effect: null });
  assert.deepEqual(model.voiceStep('error', { kind: 'clear' }), { state: 'idle', effect: null });
  assert.deepEqual(model.voiceStep('error', { kind: 'press' }), { state: 'arming', effect: 'start' }, 'press again from an error');
  assert.equal(model.recordCapMs(30), 30000, "the daemon's lower cap wins");
  assert.equal(model.recordCapMs(120), 60000, 'never over ours');
  assert.equal(model.recordCapMs(null), 60000);
  assert.equal(model.elapsedLabel(7400), '0:07');
  assert.equal(model.elapsedLabel(61000), '1:01');
});

await test('hesterVoice: error codes from the body, the prefix, or the status', () => {
  assert.equal(hv.voiceErrorFrom(503, { error: 'voice_disabled' }), 'voice_disabled');
  assert.equal(hv.voiceErrorFrom(503, { detail: 'voice_unavailable:no_api_key' }), 'voice_unavailable');
  assert.equal(hv.voiceErrorFrom(413, { detail: { error: 'too_long' } }), 'too_long');
  assert.equal(hv.voiceErrorFrom(413, null), 'too_large');
  assert.equal(hv.voiceErrorFrom(415, {}), 'unsupported_media_type');
  assert.equal(hv.voiceErrorFrom(422, {}), 'too_short');
  assert.equal(hv.voiceErrorFrom(502, { detail: 'something odd' }), 'provider_error');
  assert.equal(hv.voiceErrorFrom(504, {}), 'timeout');
  assert.equal(hv.voiceErrorText('cancelled'), '', 'cancel shows nothing');
  assert.ok(hv.voiceErrorText('permission_denied').includes('System Settings'));
});

await test('hesterVoice: capabilities cached 5 minutes; a 503 on transcribe drops the cache', async () => {
  const caps = { enabled: true, available: true, provider: 'gemini', model: 'm', location: 'cloud', accepts: ['audio/wav'], sample_rate: 16000, channels: 1, max_seconds: 60, max_bytes: 2000000 };
  calls.length = 0;
  reply = { status: 200, body: caps };
  const t0 = 1_000_000;
  assert.deepEqual(await hv.voiceCapabilities('/ws', t0), caps);
  assert.deepEqual(await hv.voiceCapabilities('/ws', t0 + 60_000), caps);
  assert.equal(calls.length, 1, 'cached');
  assert.ok(calls[0].url.startsWith('http://127.0.0.1:9000/voice?workspace=%2Fws'));
  await hv.voiceCapabilities('/ws', t0 + 5 * 60_000 + 1);
  assert.equal(calls.length, 2, 'refetched after 5 minutes');

  reply = { status: 503, body: { error: 'voice_disabled' } };
  const r = await hv.transcribe('/ws', new Uint8Array([1, 2, 3]), 'reply', { itemId: 'att_1' });
  assert.deepEqual(r, { ok: false, error: 'voice_disabled' });
  const post = calls[calls.length - 1];
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['Content-Type'], 'audio/wav');
  assert.ok(post.url.includes('/voice/transcribe?purpose=reply&workspace=%2Fws&item_id=att_1'), post.url);
  assert.ok(post.init.body instanceof ArrayBuffer && post.init.body.byteLength === 3, 'the raw WAV body, not JSON');
  reply = { status: 200, body: { ...caps, available: false } };
  const again = await hv.voiceCapabilities('/ws', t0 + 5 * 60_000 + 2);
  assert.equal(again.available, false, 'refetched after the 503');

  reply = { status: 200, body: { success: true, data: { text: 'hello', provider: 'gemini', model: 'm', location: 'cloud', audio_ms: 900, latency_ms: 800 } } };
  const ok = await hv.transcribe('/ws', new Uint8Array([1]), 'ask');
  assert.equal(ok.ok && ok.data.text, 'hello', 'the envelope is unwrapped');
});

console.log(`\n${passed} passed`);
