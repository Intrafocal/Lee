#!/usr/bin/env node
/**
 * Smoke test for the Explore client (src/renderer/lib/hesterCockpit.ts):
 * every exploration call names its workspace as ?workspace= and as the
 * percent-encoded X-Lee-Workspace header, carries the bearer token, uses the
 * route/method of the contracts addendum, and unwraps the copilot envelope.
 * Also Someday "Promote → Explore" (triage with to: 'explore'), the v3 tree
 * routes (nodes, prune, decisions, spikes, promote, archive, escalate) and
 * the spike launch flow (spike node, delegate launch in a worktree with
 * origin explore, PATCH running). Deep D1 (§3.2, §8.1): the Deep client
 * (src/renderer/lib/hesterDeep.ts): page GET/PUT and the 409 conflict,
 * references, asks, answers, questions, sessions, explore, the opener, the
 * Someday capture and a create with `page`. Bundles the real source with
 * esbuild; fetch and window.lee are stubs. No Hester needed.
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
const deepPath = join(__dirname, '../src/renderer/lib/hesterDeep.ts');
const result = await esbuild.build({ entryPoints: [srcPath], bundle: true, format: 'esm', platform: 'neutral', write: false });
const deepResult = await esbuild.build({ entryPoints: [deepPath], bundle: true, format: 'esm', platform: 'neutral', write: false });
const tmpDir = mkdtempSync(join(tmpdir(), 'lee-explore-smoke-'));
const tmpFile = join(tmpDir, 'hesterCockpit.mjs');
const deepFile = join(tmpDir, 'hesterDeep.mjs');
writeFileSync(tmpFile, result.outputFiles[0].text);
writeFileSync(deepFile, deepResult.outputFiles[0].text);

const calls = [];
let reply = { status: 200, body: { success: true, data: null } };
globalThis.window = { lee: { getApiToken: () => 'tok-1' } };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const { status, body } = reply;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

let mod;
let deep;
try {
  mod = await import(pathToFileURL(tmpFile).href);
  deep = await import(pathToFileURL(deepFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const {
  listExplorations,
  createExploration,
  getExploration,
  patchExploration,
  openExploration,
  triageSomeday,
  addExploreNode,
  patchExploreNode,
  pruneExploreNode,
  decideExploration,
  addSpike,
  patchSpike,
  promoteExploration,
  archiveExploration,
  escalateTask,
  startSpike,
  workspacePath,
} = mod;

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

await test('v3 tree: nodes / prune / decisions / spikes use the contract routes and bodies', async () => {
  reply = { status: 201, body: { success: true, data: { id: 'n-0000abcd', parent: 'root', label: 'x', kind: 'thought' } } };
  await addExploreNode(WS, exp.id, { parent: 'root', label: 'Try files' });
  await patchExploreNode(WS, exp.id, 'n-0000abcd', { label: 'Try a file-first store' });
  await patchExploreNode(WS, exp.id, 'n-1111abcd', { reason: 'too slow' });
  await pruneExploreNode(WS, exp.id, 'n-0000abcd');
  await pruneExploreNode(WS, exp.id, 'n-0000abcd', 'dead end');
  await decideExploration(WS, exp.id, { text: 'Use files' });
  await addSpike(WS, exp.id, { parent: 'n-0000abcd', prompt: 'Try it', title: 'Try it' });
  await patchSpike(WS, exp.id, 'n-2222abcd', { task_id: 'task-1', status: 'running' });
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/nodes'],
    ['PATCH', '/cockpit/explorations/exp-1a2b3c4d/nodes/n-0000abcd'],
    ['PATCH', '/cockpit/explorations/exp-1a2b3c4d/nodes/n-1111abcd'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/nodes/n-0000abcd/prune'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/nodes/n-0000abcd/prune'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/decisions'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/spikes'],
    ['PATCH', '/cockpit/explorations/exp-1a2b3c4d/spikes/n-2222abcd'],
  ]);
  assert.deepEqual(calls[0].body, { parent: 'root', label: 'Try files' });
  assert.deepEqual(calls[2].body, { reason: 'too slow' });
  assert.deepEqual(calls[3].body, {}, 'no reason required');
  assert.deepEqual(calls[4].body, { reason: 'dead end' });
  assert.deepEqual(calls[5].body, { text: 'Use files' });
  assert.deepEqual(calls[7].body, { task_id: 'task-1', status: 'running' });
});

await test('v3 promote / archive / escalate / serves', async () => {
  reply = { status: 200, body: { success: true, data: { exploration: exp, workstream_id: 'ws-1', title: 'T', phase: 'exploration' } } };
  const p = await promoteExploration(WS, exp.id, { to: 'workstream' });
  assert.equal(p.data.workstream_id, 'ws-1');
  await promoteExploration(WS, exp.id, { to: 'goal', node_ids: ['root'] });
  await archiveExploration(WS, exp.id);
  await archiveExploration(WS, exp.id, true);
  await escalateTask(WS, 'task-9');
  await patchExploration(WS, exp.id, { serves: ['G1'] });
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/promote'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/promote'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/archive'],
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/archive'],
    ['POST', '/cockpit/tasks/task-9/escalate'],
    ['PATCH', '/cockpit/explorations/exp-1a2b3c4d'],
  ]);
  assert.deepEqual(calls[0].body, { to: 'workstream' });
  assert.deepEqual(calls[1].body, { to: 'goal', node_ids: ['root'] });
  assert.deepEqual(calls[2].body, {});
  assert.deepEqual(calls[3].body, { as_knowledge: true });
  assert.deepEqual(calls[4].body, {});
  assert.deepEqual(calls[5].body, { serves: ['G1'], workspace: WS });
  assert.equal(workspacePath(WS, '.hester/explore/evidence/a.diff'), `${WS}/.hester/explore/evidence/a.diff`);
  assert.equal(workspacePath(WS, '/abs/x.md'), '/abs/x.md');
});

await test('spike launch flow: spike node, delegate worktree launch with origin explore, PATCH running', async () => {
  reply = { status: 201, body: { success: true, data: { id: 'n-3333abcd', parent: 'root', label: 'Spike', kind: 'spike' } } };
  const launches = [];
  const r = await startSpike(WS, exp.id, { parent: 'n-0000abcd', prompt: 'Try a file-first store', title: 'File store' }, async (req) => {
    launches.push(req);
    return { success: true, task_id: 'task-abcd1234', pty_id: 3 };
  });
  assert.equal(r.ok, true);
  assert.deepEqual(launches[0], {
    workspace: WS,
    lead: 'delegate',
    kind: 'prototype',
    provider: 'claude',
    worktree: true,
    prompt: 'Try a file-first store',
    title: 'File store',
    name: 'Spike: File store',
    origin: { kind: 'explore', ref: 'exp-1a2b3c4d/n-3333abcd' },
  });
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['POST', '/cockpit/explorations/exp-1a2b3c4d/spikes'],
    ['PATCH', '/cockpit/explorations/exp-1a2b3c4d/spikes/n-3333abcd'],
  ]);
  assert.deepEqual(calls[0].body, { parent: 'n-0000abcd', prompt: 'Try a file-first store', title: 'File store' });
  assert.deepEqual(calls[1].body, { task_id: 'task-abcd1234', status: 'running' });

  calls.length = 0;
  const bad = await startSpike(WS, exp.id, { prompt: 'x', title: 'x' }, async () => ({ success: false, error: 'no_window' }));
  assert.deepEqual(bad, { ok: false, error: 'no_window' });
  assert.deepEqual(calls[1].body, { status: 'failed' });

  calls.length = 0;
  reply = { status: 503, body: { success: false, error: 'down' } };
  let launched = false;
  const off = await startSpike(WS, exp.id, { prompt: 'x', title: 'x' }, async () => ((launched = true), { success: true, task_id: 't' }));
  assert.equal(off.ok, false);
  assert.equal(launched, false, 'no launch without a spike node');
});

// ---------------------------------------------------------------------------
// Deep D1: the Deep client (lib/hesterDeep.ts)
// ---------------------------------------------------------------------------

const EXP = '/cockpit/explorations/exp-1a2b3c4d';
const anchor = { kind: 'page', quote: 'the vector clock', offset: 12, section: 'Mesh' };

await test('deep page: GET /page, PUT with base_version, envelope unwrapped', async () => {
  reply = { status: 200, body: { success: true, data: { text: '# Mesh\n', version: 'abc123abc123' } } };
  assert.deepEqual(await deep.getPage(WS, exp.id), { ok: true, data: { text: '# Mesh\n', version: 'abc123abc123' } });
  reply = { status: 200, body: { success: true, data: { version: 'def456def456' } } };
  assert.deepEqual(await deep.putPage(WS, exp.id, '# Mesh\nmore', 'abc123abc123'), { ok: true, version: 'def456def456' });
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['GET', `${EXP}/page`],
    ['PUT', `${EXP}/page`],
  ]);
  assert.deepEqual(calls[1].body, { text: '# Mesh\nmore', base_version: 'abc123abc123' });
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
});

await test('deep page: 409 hands back their text and version (enveloped or bare); other errors pass through', async () => {
  reply = { status: 409, body: { success: false, error: 'version_conflict', data: { error: 'version_conflict', version: 'v2', text: 'theirs' } } };
  assert.deepEqual(await deep.putPage(WS, exp.id, 'mine', 'v1'), { ok: false, conflict: { version: 'v2', text: 'theirs' } });
  reply = { status: 409, body: { error: 'version_conflict', version: 'v3', text: 'bare' } };
  assert.deepEqual(await deep.putPage(WS, exp.id, 'mine', 'v1'), { ok: false, conflict: { version: 'v3', text: 'bare' } });
  reply = { status: 413, body: { success: false, error: 'page too large' } };
  assert.deepEqual(await deep.putPage(WS, exp.id, 'x', 'v1'), { ok: false, error: 'page too large', status: 413 });
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.deepEqual(await deep.putPage(WS, exp.id, 'x', null), { ok: false, error: 'Hester offline', status: undefined });
  assert.deepEqual(await deep.getPage(WS, exp.id), { ok: false, error: 'Hester offline' });
  globalThis.fetch = saved;
});

await test('deep references: list, add (quote and link), patch opened', async () => {
  reply = { status: 201, body: { success: true, data: { id: 'ref-00000001', kind: 'quote', at: 't' } } };
  await deep.listReferences(WS, exp.id);
  await deep.addReference(WS, exp.id, { kind: 'quote', quote: 'the vector clock', section: 'Mesh', source: { kind: 'page' } });
  await deep.addReference(WS, exp.id, { kind: 'link', url: 'https://x.dev', title: 'X' });
  await deep.patchReference(WS, exp.id, 'ref-00000001', { opened: true });
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['GET', `${EXP}/references`],
    ['POST', `${EXP}/references`],
    ['POST', `${EXP}/references`],
    ['PATCH', `${EXP}/references/ref-00000001`],
  ]);
  assert.deepEqual(calls[1].body, { kind: 'quote', quote: 'the vector clock', section: 'Mesh', source: { kind: 'page' } });
  assert.deepEqual(calls[2].body, { kind: 'link', url: 'https://x.dev', title: 'X' });
  assert.deepEqual(calls[3].body, { opened: true });
});

await test('deep asks and answers: POST /asks (202), list, patch, retry', async () => {
  reply = { status: 202, body: { success: true, data: { id: 'ans-00000001', status: 'queued', question: 'Why?', anchor } } };
  const r = await deep.askDeep(WS, exp.id, { question: 'Why?', anchor });
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'queued');
  await deep.askDeep(WS, exp.id, { question: 'And then?', anchor, follow_up_of: 'ans-00000001' });
  await deep.listAnswers(WS, exp.id);
  await deep.patchAnswer(WS, exp.id, 'ans-00000001', { read: true });
  await deep.patchAnswer(WS, exp.id, 'ans-00000001', { inserted: true });
  await deep.retryAnswer(WS, exp.id, 'ans-00000001');
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['POST', `${EXP}/asks`],
    ['POST', `${EXP}/asks`],
    ['GET', `${EXP}/answers`],
    ['PATCH', `${EXP}/answers/ans-00000001`],
    ['PATCH', `${EXP}/answers/ans-00000001`],
    ['POST', `${EXP}/answers/ans-00000001/retry`],
  ]);
  assert.deepEqual(calls[0].body, { question: 'Why?', anchor });
  assert.deepEqual(calls[1].body, { question: 'And then?', anchor, follow_up_of: 'ans-00000001' });
  assert.deepEqual(calls[3].body, { read: true });
  assert.deepEqual(calls[4].body, { inserted: true });
  assert.deepEqual(calls[5].body, {});
});

await test('deep questions and sessions', async () => {
  reply = { status: 201, body: { success: true, data: { id: 'q-00000001', status: 'open' } } };
  await deep.listQuestions(WS, exp.id);
  await deep.addQuestion(WS, exp.id, { text: 'Does it survive a partition?', source: 'page', anchor });
  await deep.patchQuestion(WS, exp.id, 'q-00000001', 'closed');
  const record = {
    focus_session_id: 'fs-1',
    started_at: '2026-09-26T09:00:00Z',
    ended_at: '2026-09-26T10:00:00Z',
    reason: 'ritual',
    stopped_at: '…the vector clock only helps if every write',
    rating: 'deep',
    questions_kept: ['q-00000002'],
  };
  await deep.postSession(WS, exp.id, record);
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['GET', `${EXP}/questions`],
    ['POST', `${EXP}/questions`],
    ['PATCH', `${EXP}/questions/q-00000001`],
    ['POST', `${EXP}/sessions`],
  ]);
  assert.deepEqual(calls[1].body, { text: 'Does it survive a partition?', source: 'page', anchor });
  assert.deepEqual(calls[2].body, { status: 'closed' });
  assert.deepEqual(calls[3].body, record);
});

await test('deep explore, create with page, Someday capture, opener', async () => {
  reply = { status: 201, body: { success: true, data: { ...exp, id: 'exp-99999999', title: 'Tangent' } } };
  const child = await deep.exploreFrom(WS, exp.id, { seed: 'a tangent', anchor });
  assert.equal(child.data.title, 'Tangent');
  await deep.createDeepExploration(WS, { seed: 'Mesh sync', page: 'Mesh sync\n\n', origin: { kind: 'opener' } });
  await deep.captureSomeday(WS, 'try CRDTs', { surface: 'lee', exploration_id: exp.id, section: 'Mesh', context: 'later: try CRDTs' });
  reply = { status: 200, body: { success: true, data: { generated_at: 't', workspace: WS, pick_up: null, surfaces: [{ kind: 'blank' }] } } };
  const op = await deep.fetchOpener(WS);
  assert.deepEqual(op.data.surfaces, [{ kind: 'blank' }]);
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['POST', `${EXP}/explore`],
    ['POST', '/cockpit/explorations'],
    ['POST', '/someday'],
    ['GET', '/copilot/opener'],
  ]);
  assert.deepEqual(calls[0].body, { seed: 'a tangent', anchor });
  assert.deepEqual(calls[1].body, { seed: 'Mesh sync', page: 'Mesh sync\n\n', origin: { kind: 'opener' }, workspace: WS });
  assert.deepEqual(calls[2].body, {
    workspace: WS,
    text: 'try CRDTs',
    as: 'someday',
    source: { surface: 'lee', exploration_id: exp.id, section: 'Mesh', context: 'later: try CRDTs' },
  });
});

console.log(process.exitCode ? '\nsome FAILED' : `\n${passed} passed`);
