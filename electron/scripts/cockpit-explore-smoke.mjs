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
 * Someday capture and a create with `page`. Deep next (package RB): asks
 * with section_text, hand-off create / PATCH / template, DELETE, draft from
 * README, the brief builder, the hand-off launch request and state labels,
 * the auto-title rule, the ritual's "This session" lists, the goals entry
 * rule, the opener's deferred create and the Goals Page lookup. Bundles the
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

// ---------------------------------------------------------------------------
// Deep next, package RB (docs/plans/2026-09-27-deep-next-contract.md §2, §5):
// the new client calls and the pure pieces around the Page.
// ---------------------------------------------------------------------------

await test('deep next: asks carry section_text (capped at 6 000, omitted when blank)', async () => {
  reply = { status: 202, body: { success: true, data: { id: 'ans-1', status: 'queued' } } };
  await deep.askDeep(WS, exp.id, { question: 'Why?', anchor, section_text: '## Mesh\nthe vector clock' });
  await deep.askDeep(WS, exp.id, { question: 'Why?', anchor, section_text: '   ' });
  await deep.askDeep(WS, exp.id, { question: 'Why?', anchor, section_text: 'x'.repeat(7000) });
  assert.deepEqual(calls[0].body, { question: 'Why?', anchor, section_text: '## Mesh\nthe vector clock' });
  assert.deepEqual(calls[1].body, { question: 'Why?', anchor }, 'no empty section_text');
  assert.equal(calls[2].body.section_text.length, deep.SECTION_TEXT_MAX);
});

await test('deep next: hand-off create, PATCH task_id / error, template, delete, draft-from-readme', async () => {
  reply = { status: 201, body: { success: true, data: { id: 'ans-9', kind: 'handoff', status: 'queued' } } };
  const r = await deep.createHandoff(WS, exp.id, { kind: 'spike', provider: 'claude', brief: 'Spike.\n\nx', anchor });
  assert.equal(r.ok, true);
  await deep.patchAnswer(WS, exp.id, 'ans-9', { task_id: 't-1' });
  await deep.patchAnswer(WS, exp.id, 'ans-9', { status: 'error', error: 'Launch failed' });
  reply = { status: 200, body: { success: true, data: { template: 'Spike. Server text.' } } };
  const t = await deep.fetchHandoffTemplate(WS, 'research');
  assert.equal(t.data.template, 'Spike. Server text.');
  await deep.deleteExploration(WS, exp.id);
  reply = { status: 200, body: { success: true, data: { text: '## What is this for?\nA thing.', sources: ['README.md'] } } };
  await deep.draftFromReadme(WS, exp.id);
  assert.deepEqual(calls.map((c) => [c.method, scoped(c).pathname]), [
    ['POST', `${EXP}/handoffs`],
    ['PATCH', `${EXP}/answers/ans-9`],
    ['PATCH', `${EXP}/answers/ans-9`],
    ['GET', '/cockpit/handoff-template'],
    ['DELETE', EXP],
    ['POST', `${EXP}/draft-from-readme`],
  ]);
  assert.deepEqual(calls[0].body, { kind: 'spike', provider: 'claude', brief: 'Spike.\n\nx', anchor });
  assert.deepEqual(calls[1].body, { task_id: 't-1' });
  assert.deepEqual(calls[2].body, { status: 'error', error: 'Launch failed' });
  assert.equal(new URL(calls[3].url).searchParams.get('kind'), 'research');
  assert.equal(calls[4].body, undefined);
});

await test('deep next: a 404 from an older Hester and a 409 not_empty come back as plain failures', async () => {
  reply = { status: 404, body: { error: 'Not Found' } };
  const t = await deep.fetchHandoffTemplate(WS, 'spike');
  assert.equal(t.ok, false);
  assert.equal(t.status, 404);
  reply = { status: 409, body: { success: false, error: 'not_empty' } };
  const d = await deep.deleteExploration(WS, exp.id);
  assert.deepEqual([d.ok, d.status, d.error], [false, 409, 'not_empty']);
  reply = { status: 400, body: { success: false, error: 'no README.md or CLAUDE.md' } };
  const rd = await deep.draftFromReadme(WS, exp.id);
  assert.deepEqual([rd.ok, rd.status], [false, 400]);
});

await test('deep next: the brief builder (template, the section word for word, where it came from)', () => {
  const brief = deep.handoffBrief(deep.HANDOFF_TEMPLATES.spike, '\n\nKey requirements:\n- pan and drag\n- arrows\n\n', 'Board', 'exp-30e56c7e');
  assert.equal(
    brief,
    `${deep.HANDOFF_TEMPLATES.spike}\n\nKey requirements:\n- pan and drag\n- arrows\n\nFrom the exploration 'Board' (exp-30e56c7e)`,
  );
  assert.ok(deep.HANDOFF_TEMPLATES.spike.includes('not a recommendation to merge'));
  assert.ok(deep.HANDOFF_TEMPLATES.docs.includes('docs/') && deep.HANDOFF_TEMPLATES.docs.includes('change nothing else'));
  assert.ok(/no code changes/i.test(deep.HANDOFF_TEMPLATES.research) && deep.HANDOFF_TEMPLATES.research.includes('sources'));
  // A kind change swaps only an unedited template.
  const research = deep.swapTemplate(brief, deep.HANDOFF_TEMPLATES.spike, deep.HANDOFF_TEMPLATES.research);
  assert.ok(research.startsWith(deep.HANDOFF_TEMPLATES.research));
  assert.ok(research.endsWith("From the exploration 'Board' (exp-30e56c7e)"));
  const edited = `Please look at this.\n\n${brief}`;
  assert.equal(deep.swapTemplate(edited, deep.HANDOFF_TEMPLATES.spike, deep.HANDOFF_TEMPLATES.docs), edited, 'an edited opening is kept');
});

await test('deep next: the hand-off launch request (§2: delegate, origin exploration, kind, worktree, tools, timebox)', () => {
  const base = { workspace: WS, provider: 'claude', brief: 'B', explorationId: 'exp-1', answerId: 'ans-2', title: 'Board' };
  const spike = deep.handoffLaunchRequest({ ...base, kind: 'spike' });
  assert.deepEqual(spike, {
    workspace: WS,
    title: 'Spike: Board',
    prompt: 'B',
    lead: 'delegate',
    kind: 'prototype',
    provider: 'claude',
    worktree: true,
    timebox_min: 45,
    origin: { kind: 'exploration', ref: 'exp-1#ans-2' },
  });
  const docs = deep.handoffLaunchRequest({ ...base, kind: 'docs', provider: 'pi' });
  assert.deepEqual([docs.kind, docs.worktree, docs.timebox_min, docs.provider, docs.tools], ['chore', true, 30, 'pi', undefined]);
  const research = deep.handoffLaunchRequest({ ...base, kind: 'research' });
  assert.deepEqual([research.kind, research.worktree, research.timebox_min], ['question', false, 20]);
  assert.deepEqual(research.tools, ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
});

await test('deep next: hand-off state labels, in flight, and mention targets', () => {
  const labels = ['launching', 'running', 'waiting', 'review', 'done', 'error', undefined].map((s) => deep.handoffStateLabel(s));
  assert.deepEqual(labels, ['launching…', 'running', 'waiting on you', 'ready to review', 'done', 'failed', 'queued']);
  assert.equal(deep.handoffKindLabel('research'), 'Research');
  const h = (state, extra = {}) => ({ id: `h-${state}`, kind: 'handoff', surface: 'deep-handoff', question: 'Spike. Build it', handoff: { kind: 'spike', provider: 'claude', brief: 'b', task_id: 't', state }, ...extra });
  assert.deepEqual(['launching', 'running', 'waiting', 'review', 'done', 'error'].map((s) => deep.handoffInFlight(h(s))), [true, true, true, false, false, false]);
  assert.equal(deep.handoffInFlight({ kind: 'ask', surface: 'deep-ask' }), false);
  const targets = deep.mentionTargetsFor([h('running'), h('waiting', { dismissed_at: 't' }), h('launching', { handoff: { kind: 'docs', task_id: null, state: 'launching' } }), { id: 'a1', kind: 'ask', surface: 'deep-ask', question: 'Why?' }]);
  assert.deepEqual(targets.map((t) => [t.id, t.kind]), [['hester', 'hester'], ['claude', 'provider'], ['pi', 'provider'], ['h-running', 'handoff']]);
  assert.equal(targets[3].label, 'Spike: Spike. Build it');
});

await test('deep next: the auto-title rule (first heading, else first line; ≤ 60 chars at a word)', () => {
  assert.equal(deep.isUntitled('Untitled · Sep 27'), true);
  assert.equal(deep.isUntitled('Goals'), false);
  assert.equal(deep.isUntitled(''), true);
  assert.equal(deep.autoTitle('Some intro line\n\n## Board: pan, drag, arrows\nmore'), 'Board: pan, drag, arrows', 'a heading wins over an earlier line');
  assert.equal(deep.autoTitle('\n\n- **Figma-like** pan and drag\n'), 'Figma-like pan and drag', 'markers off');
  assert.equal(deep.autoTitle('> — Hester, 2026-09-27\nMine'), 'Mine', 'quoted lines are not your first line');
  assert.equal(deep.autoTitle('```js\n# not a heading\n```\nAfter the fence'), 'After the fence');
  const long = 'What would it take to build our own board on an open-source drawing backend instead';
  const t = deep.autoTitle(long);
  assert.ok(t.length <= 60, t);
  assert.equal(t, 'What would it take to build our own board on an open-source');
  assert.equal(deep.autoTitle('   \n\n'), null);
  assert.equal(deep.cutAtWord('x'.repeat(80), 60).length, 60, 'one long word is cut hard');
});

await test('deep next: the ritual\'s "This session" lists', () => {
  const since = '2026-09-27T10:00:00Z';
  const answers = [
    { id: 'a1', question: 'Is it causal?', status: 'done', asked_at: '2026-09-27T10:05:00Z', surface: 'deep-ask' },
    { id: 'a2', question: 'Old one?', status: 'done', asked_at: '2026-09-26T10:05:00Z', surface: 'deep-ask', read_at: 't' },
    { id: 'a3', question: 'Pending?', status: 'running', asked_at: '2026-09-27T10:06:00Z', surface: 'deep-ask' },
    { id: 'a4', question: 'Read?', status: 'done', asked_at: '2026-09-27T10:07:00Z', surface: 'deep-ask', read_at: 't' },
    { id: 'a5', question: 'Dismissed?', status: 'done', asked_at: '2026-09-27T10:07:00Z', surface: 'deep-ask', dismissed_at: 't' },
    { id: 'h1', question: 'Spike. Build it', status: 'queued', asked_at: '2026-09-27T10:08:00Z', kind: 'handoff', surface: 'deep-handoff', handoff: { kind: 'spike', state: 'waiting' } },
    { id: 'a6', question: 'Made here before the session?', status: 'error', asked_at: '2026-09-27T09:00:00Z', surface: 'deep-ask' },
  ];
  const s = deep.sessionLists(answers, since, new Set(['a6']));
  assert.deepEqual(s.asked.map((a) => [a.id, a.state, a.label]), [
    ['a1', 'unread', 'answered, unread'],
    ['a3', 'pending', 'asking…'],
    ['a4', 'read', 'answered'],
    ['a6', 'error', 'failed'],
  ]);
  assert.deepEqual(s.handedOff.map((h) => [h.id, h.kind, h.label]), [['h1', 'spike', 'waiting on you']]);
  assert.deepEqual(deep.sessionLists(answers, null).asked, [], 'no session start and nothing made here: nothing');

  const page = [
    '# Board',
    '',
    'Should it be Figma-like?',
    'Is it causal?',
    '',
    'Key requirements:',
    '- pan and drag',
    '- arrows and flowcharts',
    '',
    '> Why quote this?',
    '```',
    'what about code?',
    '```',
    'Done.',
  ].join('\n');
  const open = deep.stillOpenOnPage(page, [{ question: 'Is it causal?', anchor: { kind: 'page', quote: 'Is it causal?', offset: 0, section: 'Board' } }]);
  assert.deepEqual(open.map((o) => [o.kind, o.text]), [
    ['question', 'Should it be Figma-like?'],
    ['requirements', 'Key requirements:\n- pan and drag\n- arrows and flowcharts'],
  ]);
  assert.equal(page.slice(open[0].from, open[0].to), 'Should it be Figma-like?');
  assert.equal(open[0].sectionText, 'Should it be Figma-like?\nIs it causal?', 'the block around the line');
  assert.equal(page.slice(open[1].from, open[1].to), open[1].text);
  const handed = deep.stillOpenOnPage(page, [{ question: 'Spike.', anchor: { kind: 'page', quote: 'Key requirements:\n- pan and drag\n- arrows and flowcharts', offset: 0, section: null } }]);
  assert.deepEqual(handed.map((o) => o.kind), ['question', 'question'], 'a handed-off section is no longer open');
});

await test('deep next: goals entry points show only without goals; metric-less goals read not measured yet', () => {
  assert.equal(deep.goalsEntryShown({ goals: [] }), true);
  assert.equal(deep.goalsEntryShown({ goals: [{ id: 'G1' }] }), false);
  assert.equal(deep.goalsEntryShown(null), false, 'not while loading or offline');
  assert.equal(deep.goalNotMeasured({ metrics: [], measured: false }), true);
  assert.equal(deep.goalNotMeasured({ metrics: [], measured: true }), false);
  assert.equal(deep.goalNotMeasured({ metrics: [] }), true, 'older daemons: no metrics');
  assert.equal(deep.goalNotMeasured({ metrics: [{ name: 'x' }] }), false);
  assert.equal(deep.GOALS_PROMPTS.length, 4);
  assert.equal(deep.pageNearlyEmpty('# Goals\n\nA line.'), true);
  assert.equal(deep.pageNearlyEmpty('x '.repeat(100)), false);
  const ins = deep.readmeInsertion('# Goals\n', '## What is this for?\nA thing.', '2026-09-27');
  assert.deepEqual(ins, { from: 8, insert: '\n## What is this for?\nA thing.\n\n> — Hester, a first guess from the README, 2026-09-27\n' });
  assert.ok(deep.goalsDraftInstruction('  my page  ').endsWith('\n\nmy page'));
});

await test('deep next: the opener defers the create (in-memory Page, created on the first save with content)', async () => {
  const id = deep.newDraft({ workspace: WS, title: 'Mesh sync', page: 'Mesh sync\n\n', seed: 'Mesh sync', sendTitle: false, origin: { kind: 'opener' } }, 1000);
  assert.equal(deep.isDraftId(id), true);
  assert.equal(deep.isDraftId(exp.id), false);
  assert.equal(calls.length, 0, 'opening an in-memory Page calls nothing');
  assert.equal(deep.getDraft(id).page, 'Mesh sync\n\n');
  assert.deepEqual(deep.draftCreateBody(deep.getDraft(id), 'Mesh sync\n\nmore'), { seed: 'Mesh sync', page: 'Mesh sync\n\nmore', origin: { kind: 'opener' } });
  const blank = deep.newDraft({ workspace: WS, title: 'Untitled · Sep 27', page: '', sendTitle: true, origin: { kind: 'opener' } });
  assert.deepEqual(deep.draftCreateBody(deep.getDraft(blank), 'x'), { title: 'Untitled · Sep 27', page: 'x', origin: { kind: 'opener' } });
  deep.dropDraft(id);
  assert.equal(deep.getDraft(id), null);
  reply = { status: 201, body: { success: true, data: { ...exp, id: 'exp-new' } } };
  await deep.createDeepExploration(WS, deep.draftCreateBody(deep.getDraft(blank), 'x'));
  assert.deepEqual(calls[0].body, { title: 'Untitled · Sep 27', page: 'x', origin: { kind: 'opener' }, workspace: WS });
});

await test('deep next: the Goals Page opens the existing one, else an in-memory one with purpose goals', async () => {
  reply = { status: 200, body: { success: true, data: [{ ...exp, id: 'exp-other' }, { ...exp, id: 'exp-goals', title: 'Goals', purpose: 'goals' }] } };
  const found = await deep.resolveGoalsPage(WS, 'A tool for deep work');
  assert.deepEqual(found, { id: 'exp-goals', title: 'Goals', draft: false });
  const u = scoped(calls[0]);
  assert.equal(u.searchParams.get('purpose'), 'goals');
  assert.equal(deep.takePendingFirstLine('exp-goals'), 'A tool for deep work');
  assert.equal(deep.takePendingFirstLine('exp-goals'), null, 'taken once');
  assert.deepEqual(deep.firstLineInsertion('## How will you know?\n', 'A tool'), { from: 0, insert: 'A tool\n\n' });
  assert.equal(deep.firstLineInsertion('A tool\n', 'A tool'), null, 'already there');

  reply = { status: 200, body: { success: true, data: [{ ...exp, id: 'exp-other' }] } }; // an older Hester ignores ?purpose
  const fresh = await deep.resolveGoalsPage(WS, 'A tool for deep work');
  assert.equal(fresh.draft, true);
  assert.equal(fresh.title, 'Goals');
  assert.deepEqual(deep.draftCreateBody(deep.getDraft(fresh.id), deep.getDraft(fresh.id).page), {
    title: 'Goals',
    page: 'A tool for deep work\n\n',
    origin: { kind: 'cockpit' },
    purpose: 'goals',
  });
  reply = { status: 404, body: {} };
  assert.equal((await deep.resolveGoalsPage(WS, '')).draft, true, 'offline or old: still a Page to write on');
});

console.log(process.exitCode ? '\nsome FAILED' : `\n${passed} passed`);
