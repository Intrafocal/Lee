#!/usr/bin/env node
/**
 * Pi adapter check (contract §5.6b): loads ~/.lee/hooks/pi-lee.ts with Pi's
 * own extension loader (jiti, no session, no model), fires its lifecycle
 * handlers with fake events, and checks the Claude-shaped hook posts a fake
 * Lee API receives. HOME is a temp dir; the fake API listens on a random
 * loopback port. Skips when Pi isn't installed.
 *
 *   cd electron && npm run build:main && node scripts/cockpit-pi-smoke.mjs
 *   PI_DIR=/path/to/pi-coding-agent node scripts/cockpit-pi-smoke.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const piDir = process.env.PI_DIR || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const loaderPath = path.join(piDir, 'dist', 'core', 'extensions', 'loader.js');
if (!fs.existsSync(loaderPath)) {
  console.log(`skip - Pi not found at ${piDir}`);
  process.exit(0);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-pi-smoke-'));
process.env.HOME = tmpHome;
const { installPiExtension } = require(path.join(here, '..', 'dist', 'main', 'cockpit', 'pi-extension.js'));
const file = installPiExtension(tmpHome);
fs.writeFileSync(path.join(tmpHome, '.lee', 'hooks', 'auth-header'), 'Authorization: Bearer test-token\n');

const posts = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    posts.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(204);
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.LEE_API_URL = `http://127.0.0.1:${server.address().port}`;
process.env.LEE_PTY_ID = '42';
process.env.LEE_WINDOW_ID = '3';

const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
const loaded = await loadExtensions([file], tmpHome);
assert.deepStrictEqual(loaded.errors, [], JSON.stringify(loaded.errors));
assert.strictEqual(loaded.extensions.length, 1);
const handlers = loaded.extensions[0].handlers;
for (const ev of ['session_start', 'before_agent_start', 'tool_call', 'tool_result', 'message_end', 'agent_settled', 'session_shutdown']) {
  assert.ok(handlers.get(ev)?.length === 1, `handler for ${ev}`);
}
console.log('ok - Pi loads pi-lee.ts and registers its lifecycle handlers');

const ctx = { cwd: '/work/app', sessionManager: { getSessionId: () => 'pi-session-1' } };
const fire = async (name, event) => {
  for (const h of handlers.get(name)) await h(event, ctx);
};
await fire('session_start', { type: 'session_start', reason: 'startup' });
await fire('before_agent_start', { type: 'before_agent_start', prompt: 'SECRET prompt text', systemPrompt: '' });
await fire('tool_call', { type: 'tool_call', toolCallId: 't1', toolName: 'edit', input: { path: 'src/a.ts', oldText: 'SECRET', newText: 'x' } });
await fire('tool_result', { type: 'tool_result', toolCallId: 't1', toolName: 'edit', input: {}, content: [], isError: false });
await fire('tool_call', { type: 'tool_call', toolCallId: 't2', toolName: 'bash', input: { command: 'rm SECRET' } });
await fire('tool_result', { type: 'tool_result', toolCallId: 't2', toolName: 'bash', input: {}, content: [], isError: true });
await fire('message_end', { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'SECRET user' }] } });
await fire('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. ' + 'y'.repeat(2500) }] } });
await fire('agent_settled', { type: 'agent_settled' });
await fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

const deadline = Date.now() + 5000;
while (posts.length < 8 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
server.close();

const byEvent = posts.map((p) => p.headers['x-lee-hook-event']);
assert.deepStrictEqual(byEvent.sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort());
for (const p of posts) {
  assert.strictEqual(p.url, '/agent/hook');
  assert.strictEqual(p.headers.authorization, 'Bearer test-token');
  assert.strictEqual(p.headers['x-lee-pty-id'], '42');
  assert.strictEqual(p.headers['x-lee-window-id'], '3');
  assert.strictEqual(p.body.provider, 'pi');
  assert.strictEqual(p.body.session_id, 'pi-session-1');
  assert.strictEqual(p.body.hook_event_name, p.headers['x-lee-hook-event']);
}
const get = (ev) => posts.find((p) => p.body.hook_event_name === ev).body;
assert.strictEqual(get('SessionStart').cwd, '/work/app');
assert.strictEqual(get('UserPromptSubmit').prompt, undefined);
const edit = posts.find((p) => p.body.hook_event_name === 'PreToolUse' && p.body.tool_use_id === 't1').body;
assert.deepStrictEqual(edit.tool_input, { file_path: 'src/a.ts' });
assert.strictEqual(edit.tool_name, 'Edit');
assert.strictEqual(get('PostToolUseFailure').tool_name, 'Bash');
assert.strictEqual(get('Stop').last_assistant_message.length, 2000);
assert.ok(get('Stop').last_assistant_message.startsWith('Done. '), 'a long message keeps its beginning');
assert.ok(!JSON.stringify(posts).includes('SECRET'), 'no prompt, tool input or user text leaves Pi');
console.log('ok - hook posts are Claude-shaped, loopback-only, with no prompt or tool input');

// The v0 queue takes these posts unchanged for a Pi PTY (isClaudePty covers hooked Pi).
{
  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { on() {}, getPath: () => tmpHome, isPackaged: false },
        ipcMain: { handle() {}, on() {} },
        BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  const dist = path.join(here, '..', 'dist', 'main');
  const { CopilotQueue } = require(path.join(dist, 'copilot', 'queue.js'));
  const { copilotBus } = require(path.join(dist, 'copilot', 'bus.js'));
  const fakePty = {
    procs: new Map([[42, { id: 42, name: 'Pi', windowId: null, pi: true }]]),
    writes: [],
    get(id) { return this.procs.get(id); },
    write(id, d) { this.writes.push([id, d]); },
    isClaudePty(id) { return this.procs.get(id)?.pi === true; },
    isWarmPty() { return false; },
    log() {},
    on() {},
  };
  const q = new CopilotQueue(fakePty);
  const seen = [];
  copilotBus.on('event', (e) => seen.push(e));
  const order = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUseFailure', 'Stop'];
  const sorted = [...posts].sort((a, b) => order.indexOf(a.body.hook_event_name) - order.indexOf(b.body.hook_event_name));
  for (const p of sorted) {
    if (p.body.hook_event_name === 'SessionEnd') continue;
    q.handleHook({ event: p.headers['x-lee-hook-event'], ptyId: p.headers['x-lee-pty-id'], windowId: null }, p.body);
  }
  const types = seen.map((e) => e.type);
  for (const t of ['agent.session_start', 'agent.prompt', 'agent.tool', 'agent.turn_end']) assert.ok(types.includes(t), t);
  const end = seen.find((e) => e.type === 'agent.turn_end');
  assert.strictEqual(end.data.pty_id, 42);
  assert.ok(end.data.summary.startsWith('Done. '));
  const snap = q.snapshot({ all: true });
  assert.ok(snap.items.some((i) => i.kind === 'review' && i.source.pty_id === 42), 'a review item after the turn');
  console.log('ok - the v0 queue turns Pi posts into agent.prompt / agent.tool / agent.turn_end and a review item');
}

// A long message that ends with a lee-status block keeps its head and the block.
{
  const before = posts.length;
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.LEE_API_URL = `http://127.0.0.1:${server.address().port}`;
  const block = '```lee-status\nstatus: done\nsummary: tests pass\n```';
  const long = 'Fixed the parser.\n\n```ts\n' + 'const x = 1;\n'.repeat(400) + '```\n\nAll good.\n\n' + block;
  await fire('message_end', { type: 'message_end', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'SECRET thought' },
    { type: 'text', text: long },
  ] } });
  await fire('agent_settled', { type: 'agent_settled' });
  const until = Date.now() + 5000;
  while (posts.length <= before && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  server.close();
  const msg = posts[posts.length - 1].body.last_assistant_message;
  assert.ok(msg.length <= 2000, `clipped to the cap (${msg.length})`);
  assert.ok(msg.startsWith('Fixed the parser.'), 'head kept');
  assert.ok(msg.endsWith(block), 'trailing lee-status block kept');
  assert.ok(msg.includes('\n\u2026\n```lee-status'), 'ellipsis between head and block');
  assert.ok(!msg.includes('SECRET'), 'thinking parts are not sent');
  const { parseLeeStatus } = require(path.join(here, '..', 'dist', 'main', 'copilot', 'hook-payload.js'));
  const st = parseLeeStatus(msg);
  assert.ok(st && st.status === 'done', 'the queue still parses the lee-status block: ' + JSON.stringify(st));
  // A short message passes through unchanged.
  const before2 = posts.length;
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.LEE_API_URL = `http://127.0.0.1:${server.address().port}`;
  await fire('message_end', { type: 'message_end', message: { role: 'assistant', content: 'Short.\n\n' + block } });
  await fire('agent_settled', { type: 'agent_settled' });
  const until2 = Date.now() + 5000;
  while (posts.length <= before2 && Date.now() < until2) await new Promise((r) => setTimeout(r, 25));
  server.close();
  assert.strictEqual(posts[posts.length - 1].body.last_assistant_message, 'Short.\n\n' + block);
  console.log('ok - long messages keep their beginning plus a trailing lee-status block; thinking is dropped');
}

// A dead Lee API must not throw into Pi. (Non-loopback URLs fall back to
// Lee's default port, which is not exercised here: the real Lee may be on it.)
process.env.LEE_API_URL = 'http://127.0.0.1:1';
await fire('before_agent_start', { type: 'before_agent_start', prompt: 'x', systemPrompt: '' });
await new Promise((r) => setTimeout(r, 300));
console.log('ok - an unreachable API is swallowed');

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log('\n5 checks passed');
