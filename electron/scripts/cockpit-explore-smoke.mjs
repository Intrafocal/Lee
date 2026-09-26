#!/usr/bin/env node
/**
 * Smoke test for the Explore client (src/renderer/lib/hesterCockpit.ts):
 * every exploration call names its workspace as ?workspace= and as the
 * percent-encoded X-Lee-Workspace header, carries the bearer token, uses the
 * route/method of the contracts addendum, and unwraps the copilot envelope.
 * Also Someday "Promote → Explore" (triage with to: 'explore'). Bundles the
 * real source with esbuild; fetch and window.lee are stubs. No Hester needed.
 *
 * Run: node scripts/cockpit-explore-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/renderer/lib/hesterCockpit.ts');
const result = await esbuild.build({ entryPoints: [srcPath], bundle: true, format: 'esm', platform: 'neutral', write: false });
const tmpDir = mkdtempSync(join(tmpdir(), 'lee-explore-smoke-'));
const tmpFile = join(tmpDir, 'hesterCockpit.mjs');
writeFileSync(tmpFile, result.outputFiles[0].text);

const calls = [];
let reply = { status: 200, body: { success: true, data: null } };
globalThis.window = { lee: { getApiToken: () => 'tok-1' } };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const { status, body } = reply;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

let mod;
try {
  mod = await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { listExplorations, createExploration, getExploration, patchExploration, openExploration, triageSomeday } = mod;

let passed = 0;
async function test(name, fn) {
  calls.length = 0;
  reply = { status: 200, body: { success: true, data: null } };
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const WS = '/Users/ben/Développement/my proj';
const exp = { id: 'exp-1a2b3c4d', title: 'Files vs Redis', status: 'active', turns: 0, session_id: 'explore-exp-1a2b3c4d' };

function scoped(call) {
  const u = new URL(call.url);
  assert.equal(u.origin, 'http://127.0.0.1:9000');
  assert.equal(u.searchParams.get('workspace'), WS);
  assert.equal(call.headers['X-Lee-Workspace'], '/Users/ben/D%C3%A9veloppement/my proj', 'non-ASCII percent-encoded');
  assert.equal(call.headers.Authorization, 'Bearer tok-1');
  return u;
}

await test('list: GET /cockpit/explorations?status=…, envelope unwrapped', async () => {
  reply = { status: 200, body: { success: true, data: [exp] } };
  const r = await listExplorations(WS);
  assert.deepEqual(r, { ok: true, data: [exp] });
  const u = scoped(calls[0]);
  assert.equal(calls[0].method, 'GET');
  assert.equal(u.pathname, '/cockpit/explorations');
  assert.equal(u.searchParams.get('status'), 'active');
  await listExplorations(WS, 'all');
  assert.equal(new URL(calls[1].url).searchParams.get('status'), 'all');
});

await test('create: POST with seed, origin and the workspace in the body', async () => {
  reply = { status: 201, body: { success: true, data: exp } };
  const r = await createExploration(WS, { seed: 'Why not files?', origin: { kind: 'cockpit' } });
  assert.equal(r.ok, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(scoped(calls[0]).pathname, '/cockpit/explorations');
  assert.deepEqual(calls[0].body, { seed: 'Why not files?', origin: { kind: 'cockpit' }, workspace: WS });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

await test('get / patch (archive) / open use the id path', async () => {
  reply = { status: 200, body: { success: true, data: { ...exp, body: '## Seed' } } };
  await getExploration(WS, exp.id);
  await patchExploration(WS, exp.id, { status: 'archived' });
  await openExploration(WS, exp.id);
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['GET', '/cockpit/explorations/exp-1a2b3c4d'],
    ['PATCH', '/cockpit/explorations/exp-1a2b3c4d'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/open'],
  ]);
  assert.deepEqual(calls[1].body, { status: 'archived', workspace: WS });
});

await test('errors: Hester error text, 404 and offline', async () => {
  reply = { status: 400, body: { success: false, error: 'title or seed is required' } };
  assert.deepEqual(await createExploration(WS, {}), { ok: false, error: 'title or seed is required', status: 400 });
  reply = { status: 404, body: { detail: 'Not Found' } };
  const r = await listExplorations(WS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.deepEqual(await openExploration(WS, exp.id), { ok: false, error: 'Hester offline' });
  globalThis.fetch = saved;
});

await test('Someday Promote → Explore: triage explore with to: explore', async () => {
  reply = { status: 200, body: { success: true, data: { item: { id: 'sd_1', status: 'explored' }, exploration: exp } } };
  const r = await triageSomeday(WS, 'sd_1', { action: 'explore', to: 'explore' });
  assert.equal(r.ok, true);
  assert.equal(r.data.exploration.id, exp.id);
  assert.equal(scoped(calls[0]).pathname, '/someday/sd_1/triage');
  assert.deepEqual(calls[0].body, { action: 'explore', to: 'explore', workspace: WS });
});

console.log(process.exitCode ? '\nsome FAILED' : `\n${passed} passed`);
