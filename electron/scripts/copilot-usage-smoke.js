#!/usr/bin/env node
/**
 * Smoke test for usage capture (docs/15-Usage.md §3.1-§3.3) and the Tether
 * routes (docs/plans/2026-09-28-tether-review-voice.md §3.3, §4.2): transcript
 * dedupe, model switches, subagent files, cost deltas, basis, status line
 * throttling, the status line script, snapshot usage/limits; /tether/*
 * forwarding to a fake Hester (and 503 offline), the ideas spool, Send to Lee
 * validation and its IPC round trip with a fake window.
 * No Electron, no real Claude, no real Hester.
 *
 *   cd electron && npm run build:main && node scripts/copilot-usage-smoke.js
 *
 * HOME points at a temp dir so nothing under the real ~/.lee or ~/.claude is touched.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lee-usage-smoke-')));
process.env.HOME = tmpHome;

const electronStub = {
  app: { on() {}, getPath: () => tmpHome, isPackaged: false },
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const dist = path.join(__dirname, '..', 'dist', 'main');
const { UsageTracker, DEFAULT_PRICES, estimateCost, priceFor, payloadShape } = require(path.join(dist, 'copilot', 'usage.js'));
const { CopilotQueue } = require(path.join(dist, 'copilot', 'queue.js'));
const { copilotBus } = require(path.join(dist, 'copilot', 'bus.js'));
const { windowRegistry } = require(path.join(dist, 'window-registry.js'));
const { installClaudeHooks, STATUSLINE_SCRIPT } = require(path.join(dist, 'copilot', 'hook-install.js'));
const { registerTetherRoutes, buildTether, buildTargets, checkSendRequest, cutText, tetherSendBroker, TETHER_SEND_MAX_BYTES } = require(path.join(dist, 'copilot', 'tether.js'));
const { getHesterPort, setHesterPortProvider } = require(path.join(dist, 'copilot', 'capture.js'));
const express = require('express');

const projects = path.join(tmpHome, '.claude', 'projects', '-work-api');
fs.mkdirSync(projects, { recursive: true });
let fileN = 0;
function newTranscript() {
  const id = `sess-${++fileN}`;
  return { id, file: path.join(projects, `${id}.jsonl`) };
}

function line(id, model, usage, extra = {}) {
  return JSON.stringify({ type: 'assistant', uuid: `u-${Math.random()}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage }, ...extra }) + '\n';
}
const u = (input, output, cacheRead, cacheWrite, thinking) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  ...(thinking !== undefined ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cacheWrite },
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('resume guard: --resume is dropped when Claude has no transcript for that session and directory', () => {
  const { claudeProjectKey, claudeTranscriptPath, dropStaleResume } = require(path.join(dist, 'copilot', 'claude-resume.js'));
  assert.equal(claudeProjectKey('/Users/ben/Development/Lee/.claude/worktrees/task-b615'), '-Users-ben-Development-Lee--claude-worktrees-task-b615');
  const home = '/h';
  const want = claudeTranscriptPath('/w/proj', 'abc-123', home);
  assert.equal(want, '/h/.claude/projects/-w-proj/abc-123.jsonl');
  const args = ['--resume', 'abc-123'];
  assert.deepEqual(dropStaleResume(args, '/w/proj', (p) => p === want, home), { args, dropped: null }, 'transcript exists: resume');
  assert.deepEqual(dropStaleResume(args, '/w/proj', () => false, home), { args: [], dropped: 'abc-123' }, 'never used: fresh');
  assert.deepEqual(dropStaleResume(['--name', 'x'], '/w/proj', () => false, home), { args: ['--name', 'x'], dropped: null }, 'no resume: unchanged');
});

test('reported usage from a model on this machine (Pi on Ollama) is local, never billed', () => {
  const t = new UsageTracker();
  const turn = t.reportedTurn('pi-1', { by_model: [
    { provider: 'ollama', model: 'gemma4:e4b', tokens: { input: 9553, output: 1340 }, cost_usd: 0 },
    { provider: 'openai', model: 'gpt-x', tokens: { input: 10 }, cost_usd: 0.01 },
  ] }, 'other', 'billed');
  assert.deepStrictEqual(turn.by_model.map((e) => [e.provider, e.cost_basis, e.cost_usd]), [['ollama', 'local', undefined], ['openai', 'billed', 0.01]]);
});

test('dedupe by message.id: repeated streaming lines count once, last wins', () => {
  const t = new UsageTracker();
  const { id, file } = newTranscript();
  fs.writeFileSync(
    file,
    line('m1', 'claude-opus-5-5', u(2, 10, 100, 50)) +
      line('m1', 'claude-opus-5-5', u(2, 300, 100, 50, 40)) +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n' +
      line('m2', 'claude-opus-5-5', u(1, 20, 200, 0)) +
      line('s1', '<synthetic>', u(0, 999, 0, 0)),
  );
  const turn = t.claudeTurn(id, file);
  assert.strictEqual(turn.by_model.length, 1);
  assert.deepStrictEqual(turn.by_model[0].tokens, { input: 3, output: 320, cache_read: 300, cache_write: 50, thinking: 40 });
  // A later line for m2 (still streaming at the last turn end) corrects it, not doubles it.
  fs.appendFileSync(file, line('m2', 'claude-opus-5-5', u(1, 25, 200, 0)));
  const next = t.claudeTurn(id, file);
  assert.deepStrictEqual(next.by_model[0].tokens, { input: 0, output: 5, cache_read: 0, cache_write: 0 });
  const total = t.agentUsage(id);
  assert.strictEqual(total.tokens.output, 325);
  assert.strictEqual(total.shown_tokens, 3 + 325 + 50);
  // Nothing new: no event.
  assert.strictEqual(t.claudeTurn(id, file), null);
});

test('an unterminated last line is read on the next turn', () => {
  const t = new UsageTracker();
  const { id, file } = newTranscript();
  const full = line('m1', 'claude-opus-5-5', u(1, 10, 0, 0));
  fs.writeFileSync(file, full.slice(0, 40));
  assert.strictEqual(t.claudeTurn(id, file), null);
  fs.appendFileSync(file, full.slice(40));
  assert.strictEqual(t.claudeTurn(id, file).by_model[0].tokens.output, 10);
});

test('model switch mid-session groups by model; by_model in the running total', () => {
  const t = new UsageTracker();
  const { id, file } = newTranscript();
  fs.writeFileSync(file, line('a1', 'claude-opus-5-5', u(1, 100, 0, 10)) + line('a2', 'claude-sonnet-5', u(2, 200, 0, 20)));
  const turn = t.claudeTurn(id, file);
  assert.deepStrictEqual(turn.by_model.map((m) => m.model).sort(), ['claude-opus-5-5', 'claude-sonnet-5']);
  const total = t.agentUsage(id);
  assert.strictEqual(total.by_model.length, 2);
  assert.strictEqual(total.cost_basis, 'estimate');
  const sonnet = total.by_model.find((m) => m.model === 'claude-sonnet-5');
  assert.strictEqual(sonnet.tokens.output, 200);
});

test('subagent transcripts are read with their own offsets and attributed to the parent', () => {
  const t = new UsageTracker();
  const { id, file } = newTranscript();
  fs.writeFileSync(file, line('p1', 'claude-opus-5-5', u(1, 10, 0, 0)));
  const sub = path.join(projects, id, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), line('x1', 'claude-haiku-4-5', u(5, 50, 0, 0)));
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), '{}');
  const turn = t.claudeTurn(id, file);
  assert.strictEqual(turn.by_model.find((m) => m.model === 'claude-haiku-4-5').tokens.output, 50);
  fs.appendFileSync(path.join(sub, 'agent-a1.jsonl'), line('x2', 'claude-haiku-4-5', u(1, 7, 0, 0)));
  fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), line('y1', 'claude-haiku-4-5', u(1, 3, 0, 0)));
  const next = t.claudeTurn(id, file);
  assert.deepStrictEqual(next.by_model.map((m) => [m.model, m.tokens.output]), [['claude-haiku-4-5', 10]]);
  assert.strictEqual(t.agentUsage(id).tokens.output, 70);
});

test('SessionStart primes a resumed transcript: earlier turns are not counted', () => {
  const t = new UsageTracker();
  const { id, file } = newTranscript();
  fs.writeFileSync(file, line('old', 'claude-opus-5-5', u(1, 1000, 0, 0)));
  t.primeTranscript(id, file);
  fs.appendFileSync(file, line('new', 'claude-opus-5-5', u(1, 10, 0, 0)));
  assert.strictEqual(t.claudeTurn(id, file).by_model[0].tokens.output, 10);
});

test('transcripts outside ~/.claude/projects are never read (queue path check)', () => {
  const { safeTranscriptPath } = require(path.join(dist, 'cockpit', 'session-name.js'));
  const t = new UsageTracker({ safePath: (p) => safeTranscriptPath(p) });
  const outside = path.join(tmpHome, 'elsewhere.jsonl');
  fs.writeFileSync(outside, line('m', 'claude-opus-5-5', u(1, 1, 0, 0)));
  assert.strictEqual(t.claudeTurn('s', outside), null);
});

test('cost per turn: status line total_cost_usd delta; basis subscription vs billed', () => {
  const t = new UsageTracker();
  const { id, file } = newTranscript();
  const status = (cost, limits) => ({ session_id: id, model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: cost }, ...(limits ? { rate_limits: limits } : {}) });
  t.noteStatus(status(0.5));
  fs.writeFileSync(file, line('m1', 'claude-opus-5-5', u(1, 10, 0, 0)));
  let turn = t.claudeTurn(id, file);
  assert.strictEqual(turn.by_model[0].cost_usd, 0.5);
  assert.strictEqual(turn.by_model[0].cost_basis, 'billed');
  t.noteStatus(status(1.25));
  fs.appendFileSync(file, line('m2', 'claude-opus-5-5', u(1, 10, 0, 0)));
  turn = t.claudeTurn(id, file);
  assert.strictEqual(turn.by_model[0].cost_usd, 0.75);
  assert.strictEqual(t.agentUsage(id).cost_usd, 1.25);
  assert.strictEqual(t.agentUsage(id).cost_basis, 'billed');

  // A subscription session: cost is recorded on the event but never shown as dollars.
  const s2 = newTranscript();
  t.noteStatus({ session_id: s2.id, cost: { total_cost_usd: 2 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1790000000 } } });
  fs.writeFileSync(s2.file, line('k1', 'claude-opus-5-5', u(1, 10, 0, 0)));
  const sub = t.claudeTurn(s2.id, s2.file);
  assert.strictEqual(sub.by_model[0].cost_basis, 'subscription');
  assert.strictEqual(sub.by_model[0].cost_usd, 2);
  const shown = t.agentUsage(s2.id);
  assert.strictEqual(shown.cost_basis, 'subscription');
  assert.strictEqual(shown.cost_usd, undefined, 'subscription usage has no dollars (§9.1)');
});

test('no status line: list-price estimate; unknown model gets tokens but no cost', () => {
  const t = new UsageTracker({ prices: () => DEFAULT_PRICES });
  const { id, file } = newTranscript();
  fs.writeFileSync(file, line('m1', 'claude-opus-5-5', u(1_000_000, 1_000_000, 0, 0)) + line('m2', 'mystery-model-9', u(10, 10, 0, 0)));
  const turn = t.claudeTurn(id, file);
  const opus = turn.by_model.find((m) => m.model === 'claude-opus-5-5');
  assert.strictEqual(opus.cost_basis, 'estimate');
  assert.strictEqual(opus.cost_usd, 24);
  const mystery = turn.by_model.find((m) => m.model === 'mystery-model-9');
  assert.strictEqual(mystery.cost_usd, undefined);
  assert.ok(priceFor('claude-opus-5-5[1m]', DEFAULT_PRICES));
  assert.strictEqual(priceFor('claude-opus-5-1', DEFAULT_PRICES), null, 'never a family guess');
  assert.strictEqual(estimateCost('claude-sonnet-5', { cache_read: 1_000_000 }, DEFAULT_PRICES), 0.2);
});

test('status line throttling: limits.snapshot only on a whole-percent or reset change', () => {
  const t = new UsageTracker();
  const s = (five, seven, reset = 1790000000) => ({
    session_id: 'x',
    rate_limits: { five_hour: { used_percentage: five, resets_at: reset }, seven_day: { used_percentage: seven, resets_at: 1790500000 } },
  });
  assert.ok(t.noteStatus(s(42.1, 18)).snapshot, 'first');
  assert.strictEqual(t.noteStatus(s(42.1, 18)).snapshot, null, 'same');
  assert.strictEqual(t.noteStatus(s(42.9, 18.4)).snapshot, null, 'same whole percent');
  const snap = t.noteStatus(s(43.0, 18.4)).snapshot;
  assert.ok(snap, 'percent changed');
  assert.strictEqual(snap.source, 'claude');
  assert.strictEqual(snap.five_hour.used_pct, 43);
  assert.strictEqual(snap.five_hour.resets_at, new Date(1790000000 * 1000).toISOString());
  assert.ok(t.noteStatus(s(43.2, 18.4, 1790003600)).snapshot, 'reset changed');
  // No rate_limits (API key, or before the first response): limits untouched, no event.
  assert.strictEqual(t.noteStatus({ session_id: 'y', cost: { total_cost_usd: 1 } }).snapshot, null);
  assert.strictEqual(t.limits().five_hour.used_pct, 43.2);
  assert.ok(t.limits().as_of);
  const shape = payloadShape({ session_id: 'abc', cwd: '/secret', rate_limits: { five_hour: { used_percentage: 5 } } });
  assert.deepStrictEqual(shape, { session_id: 'string', cwd: 'string', rate_limits: { five_hour: { used_percentage: 5 } } });
});

// ---------------------------------------------------------------------------
// The queue: agent.usage on Stop, /agent/status, snapshot usage and limits
// ---------------------------------------------------------------------------

class FakePty {
  constructor() {
    this.procs = new Map();
    this.logs = [];
  }
  add(id) {
    this.procs.set(id, { id, name: 'Claude', windowId: null, claude: true, pi: false });
  }
  get(id) {
    return this.procs.get(id);
  }
  write() {}
  isClaudePty(id) {
    return this.procs.get(id)?.claude === true;
  }
  isWarmPty() {
    return false;
  }
  log(level, message, details) {
    this.logs.push({ level, message, details });
  }
  on() {}
}

function withWindow(tabs, id = 1, workspace = '/work/api') {
  const bw = { id, isDestroyed: () => false, webContents: { send() {} } };
  windowRegistry.register(bw, workspace, {
    getContext: () => ({ workspace, tabs, panels: {}, focusedPanel: 'center' }),
  });
  return () => windowRegistry.unregister(id);
}

test('queue: Stop emits agent.usage; snapshots carry usage and limits; status logs once', () => {
  const pty = new FakePty();
  pty.add(7);
  const unregister = withWindow([{ id: 3, ptyId: 7, label: 'Claude', type: 'claude' }]);
  const seen = [];
  const onEvent = (e) => seen.push(e);
  copilotBus.on('event', onEvent);
  try {
    const q = new CopilotQueue(pty);
    const { id, file } = newTranscript();
    fs.writeFileSync(file, '');
    const hook = (event, body = {}) => q.handleHook({ event, ptyId: '7', windowId: null }, { session_id: id, hook_event_name: event, transcript_path: file, ...body });
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'x' });
    const headers = { event: null, ptyId: '7', windowId: null };
    const status = { session_id: id, model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 0.3 }, rate_limits: { five_hour: { used_percentage: 61.2, resets_at: 1790000000 }, seven_day: { used_percentage: 18, resets_at: 1790500000 } } };
    assert.strictEqual(q.handleStatus(headers, status).status, 204);
    q.handleStatus(headers, status);
    assert.strictEqual(seen.filter((e) => e.type === 'limits.snapshot').length, 1, 'throttled');
    assert.strictEqual(pty.logs.filter((l) => /status line payload/.test(l.message)).length, 1, 'shape logged once');
    assert.ok(!JSON.stringify(pty.logs).includes(id), 'the shape log has no values outside rate_limits');
    fs.appendFileSync(file, line('m1', 'claude-opus-5-5', u(2, 318, 26740, 21251, 139)));
    hook('Stop', { last_assistant_message: 'Done.' });
    const ev = seen.find((e) => e.type === 'agent.usage');
    assert.ok(ev, 'agent.usage');
    assert.strictEqual(ev.data.session_id, id);
    assert.strictEqual(ev.data.pty_id, 7);
    assert.strictEqual(ev.data.provider, 'claude');
    assert.strictEqual(ev.data.by_model[0].cost_basis, 'subscription');
    assert.strictEqual(ev.data.by_model[0].cost_usd, 0.3);
    assert.deepStrictEqual(ev.data.by_model[0].tokens, { input: 2, output: 318, cache_read: 26740, cache_write: 21251, thinking: 139 });
    for (const compact of [false, true]) {
      const snap = q.snapshot({ compact });
      const agent = snap.agents.find((a) => a.pty_id === 7);
      assert.ok(agent, 'agent in snapshot');
      assert.strictEqual(agent.usage.shown_tokens, 2 + 318 + 21251);
      assert.strictEqual(agent.usage.cost_basis, 'subscription');
      assert.strictEqual(agent.usage.cost_usd, undefined);
      assert.strictEqual(snap.limits.five_hour.used_pct, 61.2);
      assert.strictEqual(snap.limits.seven_day.used_pct, 18);
    }
    // A second Stop with nothing new emits no agent.usage.
    hook('UserPromptSubmit', { prompt: 'y' });
    hook('Stop', { last_assistant_message: 'Again.' });
    assert.strictEqual(seen.filter((e) => e.type === 'agent.usage').length, 1);
  } finally {
    copilotBus.off?.('event', onEvent);
    unregister();
  }
});

// log() pushes (changed()), so a limits.snapshot reaches the renderer and devices at once.
test('queue: a status line that changes the limits schedules a push', () => {
  const q = new CopilotQueue(new FakePty());
  let pushes = 0;
  q.changed = () => pushes++;
  const status = (pct) => ({ session_id: 'push-x', rate_limits: { five_hour: { used_percentage: pct, resets_at: 1790000000 } } });
  q.handleStatus({ event: null, ptyId: null, windowId: null }, status(49));
  const first = pushes;
  assert.ok(first >= 1, 'first limits push');
  q.handleStatus({ event: null, ptyId: null, windowId: null }, status(49.4));
  assert.strictEqual(pushes, first, 'same whole percent: no push');
  q.handleStatus({ event: null, ptyId: null, windowId: null }, status(52));
  assert.ok(pushes > first, 'limits moved: push');
});

test('queue: snapshot limits are null before any status line', () => {
  const q = new CopilotQueue(new FakePty());
  assert.strictEqual(q.snapshot().limits, null);
});

// ---------------------------------------------------------------------------
// hook-install: statusLine entry, the user's own line, the script itself
// ---------------------------------------------------------------------------

function runScript(input, env) {
  return spawnSync('/bin/sh', [path.join(tmpHome, '.lee', 'hooks', 'claude-statusline.sh')], {
    input,
    env: { PATH: process.env.PATH, HOME: tmpHome, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
}

test('statusLine: settings point at the relay; default line; the user line is kept', async () => {
  fs.mkdirSync(path.join(tmpHome, '.lee'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.lee', 'api-token'), 'tok-123\n');
  let paths = installClaudeHooks({ home: tmpHome, enabled: true, permissionRequest: false });
  let settings = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.strictEqual(settings.statusLine.type, 'command');
  assert.ok(settings.statusLine.command.includes('claude-statusline.sh'));
  assert.strictEqual(fs.readFileSync(paths.statusline, 'utf8'), STATUSLINE_SCRIPT);
  assert.ok(!fs.existsSync(paths.userStatusline));

  // A fake Lee API receives the background POST.
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization, pty: req.headers['x-lee-pty-id'], body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const payload = JSON.stringify({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, rate_limits: { five_hour: { used_percentage: 42.4, resets_at: 1790000000 }, seven_day: { used_percentage: 18, resets_at: 1790500000 } } });
  let r = runScript(payload, { LEE_API_URL: api, LEE_PTY_ID: '9' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'Opus 5.5 · 5h 42% · 7d 18%\n');
  const until = Date.now() + 3000;
  while (got.length === 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 25));
  server.close();
  assert.strictEqual(got.length, 1, 'posted once');
  assert.strictEqual(got[0].url, '/agent/status');
  assert.strictEqual(got[0].auth, 'Bearer tok-123');
  assert.strictEqual(got[0].pty, '9');
  assert.strictEqual(got[0].body, payload);

  // No rate limits (API key): just the model. Lee down: still prints, fast.
  const t0 = Date.now();
  r = runScript(JSON.stringify({ model: { display_name: 'Sonnet 5' } }), { LEE_API_URL: 'http://127.0.0.1:1' });
  assert.strictEqual(r.stdout, 'Sonnet 5\n');
  assert.ok(Date.now() - t0 < 2000, 'never blocks on Lee');

  // The user's own statusLine is copied and gets the same stdin.
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'printf "mine:"; cat', padding: 1 } }));
  paths = installClaudeHooks({ home: tmpHome, enabled: true, permissionRequest: false });
  settings = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  assert.strictEqual(settings.statusLine.padding, 1);
  r = runScript('{"a":1}', { LEE_API_URL: 'http://127.0.0.1:1' });
  assert.strictEqual(r.stdout, 'mine:{"a":1}');
  fs.rmSync(path.join(tmpHome, '.claude', 'settings.json'));
  paths = installClaudeHooks({ home: tmpHome, enabled: true, permissionRequest: false });
  assert.ok(!fs.existsSync(paths.userStatusline), 'removed with the user line');

  // Hooks disabled: no settings, no status line script.
  paths = installClaudeHooks({ home: tmpHome, enabled: false });
  assert.ok(!fs.existsSync(paths.settings));
  assert.ok(!fs.existsSync(paths.statusline));
});

// ---------------------------------------------------------------------------
// Tether routes with a fake Hester (docs/plans/2026-09-28-tether-review-voice.md §3.3, §4.2)
// ---------------------------------------------------------------------------

const CARD = { id: 'pg-0000abcd', kind: 'page', title: 'Mesh sync', area_id: 'area-0000abcd', area_name: 'Mesh', purpose: null, last_touched_at: '2026-09-27T08:00:00Z' };
const OPENER = {
  generated_at: '2026-09-27T10:00:00Z',
  workspace: '/work/api',
  pick_up: {
    card: CARD,
    exploration: { id: 'pg-0000abcd', title: 'Mesh sync', last_touched_at: '2026-09-27T08:00:00Z' },
    stopped_at: '…where the clocks disagree',
    stopped_line: 12,
    arrived: { answers: 0, open_questions: 1 },
  },
  surfaces: [
    { kind: 'blank' },
    {
      kind: 'open_questions',
      count: 7,
      items: [
        { card_id: 'pg-00000001', card_title: 'A', exploration_id: 'pg-00000001', exploration_title: 'A', question_id: 'q1', text: 'one?' },
        { card_id: 'pg-0000abcd', card_title: 'Mesh sync', question_id: 'q2', text: 'two?' },
        { card_id: 'pg-00000001', question_id: 'q3', text: 'three?' },
        { card_id: 'pg-00000001', question_id: 'q4', text: 'four?' },
        { card_id: 'pg-0000abcd', question_id: 'q5', text: 'five?' },
        { card_id: 'pg-00000001', question_id: 'q6', text: 'six?' },
      ],
    },
    { kind: 'captured_away', count: 3, items: [] },
    { kind: 'reading_list', count: 2, items: [] },
  ],
};

const summary = (chars, at, unread = 0, open = 0) => ({ page_chars: chars, page_updated_at: at, excerpt: 'x', answers_unread: unread, answers_pending: 0, handoffs_in_flight: 0, open_questions: open });
const card = (id, area_id, title, at, extra = {}) => ({
  id, kind: 'page', area_id, title, purpose: null, pinned: false, x: 0, y: 0, w: 1, h: 1,
  created_at: '2026-09-01T00:00:00Z', updated_at: at, last_touched_at: at, migrated_from: null, summary: summary(100, at), ...extra,
});
const area = (id, name, drawer_id = null, stashed_at = null) => ({ id, name, drawer_id, stashed_at, x: 0, y: 0, w: 1, h: 1, created_at: 't', updated_at: 't', migrated_from: null });
const DESK = {
  version: 1,
  workspace: '/work/api',
  areas: [area('area-0000abcd', 'Mesh'), area('area-00000002', 'Old', 'stashed', '2026-09-20T00:00:00Z'), area('area-00000003', 'Older', 'stashed', '2026-09-10T00:00:00Z')],
  cards: [
    card('pg-00000002', 'area-0000abcd', 'Older page', '2026-09-26T00:00:00Z'),
    card('pg-0000abcd', 'area-0000abcd', 'Mesh sync', '2026-09-27T00:00:00Z', { summary: summary(4321, '2026-09-27T00:00:00Z', 2, 1) }),
    card('pg-00000003', 'area-00000002', 'Parked', '2026-09-25T00:00:00Z'),
    card('pg-0000000a', null, 'Goals', '2026-09-24T00:00:00Z', { purpose: 'goals', pinned: true }),
  ],
  drawers: [],
  goals_card_id: 'pg-0000000a',
  last: { card_id: 'pg-0000abcd', at: '2026-09-27T09:00:00Z' },
  migration: null,
};
const IDEAS = [
  { id: 'idea_1', text: 'try CRDTs', created_at: '2026-09-26T00:00:00Z', status: 'open', source: { surface: 'aeronaut' } },
  { id: 'idea_2', text: 'newer', created_at: '2026-09-27T00:00:00Z', status: 'open', source: { surface: 'lee' } },
  { id: 'idea_3', text: 'dropped', created_at: '2026-09-28T00:00:00Z', status: 'dropped', source: {} },
];
const ANSWERS = [
  { id: 'ans-1', question: 'why?', status: 'done', answer: 'because', kind: 'ask', asked_at: 't' },
  { id: 'ans-2', question: 'gone', status: 'done', answer: 'x', dismissed_at: 't', asked_at: 't' },
  { id: 'ans-3', question: 'spike it', status: 'done', answer: 'result', kind: 'handoff', handoff: { kind: 'spike', provider: 'claude', brief: 'b', task_id: null, state: 'review' }, asked_at: 't' },
];
const QUESTIONS = [{ id: 'q-1', text: 'open one?', status: 'open', source: 'page', at: 't' }, { id: 'q-2', text: 'closed', status: 'closed', source: 'page', at: 't' }];
const REFERENCES = [
  { id: 'r-1', kind: 'link', url: 'https://example.com/crdt', title: 'CRDTs', at: 't' },
  { id: 'r-2', kind: 'quote', quote: 'Writes carry a clock.', file: 'docs/sync.md', lines: [3, 4], at: 't' },
];

/** A fake Hester that serves the Desk; everything else 404. */
function deskHester(c, extra = {}) {
  const u = c.url.split('?')[0];
  if (extra[u]) return extra[u](c);
  if (u === '/copilot/opener') return [200, { success: true, data: OPENER }];
  if (u === '/desk') return [200, { success: true, data: DESK }];
  if (u === '/ideas' && c.method === 'GET') return [200, { success: true, data: IDEAS }];
  if (u === '/desk/pages/pg-0000abcd/page') return [200, { success: true, data: { text: '# Mesh sync\n\nWrites carry a clock.\n', version: 'v1' } }];
  if (u === '/desk/pages/pg-0000abcd/answers') return [200, { success: true, data: ANSWERS }];
  if (u === '/desk/pages/pg-0000abcd/questions') return [200, { success: true, data: QUESTIONS }];
  if (u === '/desk/pages/pg-0000abcd/references') return [200, { success: true, data: REFERENCES }];
  return [404, { success: false, error: 'not found' }];
}

async function withTetherApp(principal, fn, deps = {}) {
  const app = express();
  app.use('/tether/send', express.json({ limit: TETHER_SEND_MAX_BYTES }));
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.principal = principal;
    next();
  });
  registerTetherRoutes(app, deps);
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

async function withFakeHester(handler, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      calls.push(call);
      const [status, out] = handler(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  setHesterPortProvider(() => server.address().port);
  try {
    await fn(calls);
  } finally {
    server.close();
  }
}

/** A port nothing listens on. */
async function deadPort() {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  return port;
}

const device = { kind: 'device', device_id: 'dev-1', device_kind: 'aeronaut', name: 'Phone' };
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('buildTether: the Desk opener picks up your last card, its area and stopped-at line; its questions first, at most 5', () => {
  const t = buildTether(OPENER, null, 2);
  assert.deepStrictEqual(t.pick_up, {
    card_id: 'pg-0000abcd', card_kind: 'page', title: 'Mesh sync', area_name: 'Mesh',
    stopped_at: '…where the clocks disagree', stopped_line: 12, last_touched_at: '2026-09-27T08:00:00Z',
  });
  assert.deepStrictEqual(t.open_questions.map((q) => q.question_id), ['q2', 'q5', 'q1', 'q3', 'q4']);
  assert.deepStrictEqual(t.open_questions[2], { card_id: 'pg-00000001', question_id: 'q1', text: 'one?' });
  assert.strictEqual(t.captured_count, 3);
  assert.strictEqual(t.spooled, 2);
  assert.deepStrictEqual(Object.keys(t).sort(), ['captured_count', 'open_questions', 'pick_up', 'spooled', 'workspace'], 'no open_next, no reading_count');
  assert.strictEqual(buildTether({ ...OPENER, pick_up: null, surfaces: [] }, '/w').pick_up, null);
  assert.strictEqual(buildTether({ ...OPENER, pick_up: { ...OPENER.pick_up, card: undefined } }, null).pick_up, null, 'no card, no pick-up');
  assert.strictEqual(buildTether({ ...OPENER, pick_up: { ...OPENER.pick_up, stopped_line: 0 } }, null).pick_up.stopped_line, null, 'lines are 1-based');
});

test('GET /tether forwards to the opener with the workspace header; /carry is gone', async () => {
  fs.mkdirSync(path.join(tmpHome, '.lee'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.lee', 'api-token'), 'tok-123\n');
  const unregister = withWindow([], 5, '/work/api');
  try {
    await withFakeHester((c) => deskHester(c), async (calls) => {
      await withTetherApp(device, async (base) => {
        const res = await fetch(`${base}/tether?workspace=${encodeURIComponent('/work/api')}`);
        assert.strictEqual(res.status, 200);
        const { data } = await res.json();
        assert.strictEqual(data.workspace, '/work/api');
        assert.strictEqual(data.pick_up.card_id, 'pg-0000abcd');
        assert.strictEqual(data.open_questions.length, 5);
        assert.strictEqual(calls.length, 1, 'the opener only (Open next is gone)');
        assert.strictEqual(calls[0].headers.authorization, 'Bearer tok-123');
        assert.ok(calls[0].headers['x-lee-workspace'], 'workspace header');
        assert.ok(calls[0].url.includes('workspace=%2Fwork%2Fapi'));
        // Default: the focused (else any) window's workspace.
        assert.strictEqual((await (await fetch(`${base}/tether`)).json()).data.workspace, '/work/api');
        assert.strictEqual((await fetch(`${base}/tether?workspace=/nope`)).status, 400);
        for (const route of ['/carry', '/carry/capture', '/carry/open-next']) {
          assert.strictEqual((await fetch(`${base}${route}`, { method: route === '/carry' ? 'GET' : 'POST' })).status, 404, route);
        }
      });
    });
  } finally {
    unregister();
  }
});

test('POST /tether/capture forwards to Hester /ideas with the device surface, the card and input: voice', async () => {
  const unregister = withWindow([], 6, '/work/api');
  const events = [];
  const onEv = (e) => events.push(e);
  copilotBus.on('event', onEv);
  try {
    await withFakeHester(
      (c) => (c.url === '/ideas' ? [201, { success: true, data: { id: 'idea_9', text: c.body.text } }] : [404, {}]),
      async (calls) => {
        await withTetherApp(device, async (base) => {
          let res = await post(base, '/tether/capture', { text: '  a thought on the walk ', card_id: 'pg-0000abcd', input: 'voice' });
          assert.strictEqual(res.status, 200);
          assert.deepStrictEqual((await res.json()).data, { id: 'idea_9', spooled: false });
          const cap = calls.pop();
          assert.strictEqual(cap.body.text, 'a thought on the walk');
          assert.strictEqual(cap.body.as, 'someday', 'the wire value stays');
          assert.strictEqual(cap.body.input, 'voice');
          assert.deepStrictEqual(cap.body.source, { surface: 'aeronaut', device_id: 'dev-1', card_id: 'pg-0000abcd' });
          assert.strictEqual(cap.body.workspace, '/work/api');
          assert.ok(cap.headers['x-lee-workspace']);
          const ev = events.find((e) => e.type === 'capture');
          assert.strictEqual(ev.data.input, 'voice');
          assert.strictEqual(ev.data.via, 'tether');
          assert.ok(!JSON.stringify(ev).includes('walk'), 'never the text');
          res = await post(base, '/tether/capture', { text: 'typed' });
          assert.strictEqual(calls.pop().body.input, undefined);
          assert.strictEqual((await post(base, '/tether/capture', { text: '' })).status, 400);
          assert.strictEqual((await post(base, '/tether/capture', { text: 'x', card_id: '../etc' })).status, 400);
          assert.strictEqual((await post(base, '/tether/capture', { text: 'x', card_id: 'exp-2' })).status, 400, 'a card id only');
          assert.strictEqual((await post(base, '/tether/capture', { text: 'x', input: 'typing' })).status, 400);
        });
        // The renderer (shared loopback) is 'lee'.
        await withTetherApp({ kind: 'shared', loopback: true, ip: '127.0.0.1' }, async (base) => {
          await post(base, '/tether/capture', { text: 'from Lee' });
          assert.deepStrictEqual(calls.pop().body.source, { surface: 'lee' });
        });
      },
    );
  } finally {
    copilotBus.off('event', onEv);
    unregister();
  }
});

test('Hester offline: the reads answer 503 hester_offline; a capture spools to ideas.jsonl (200 spooled: true)', async () => {
  const unregister = withWindow([], 8, '/work/api');
  try {
    const port = await deadPort();
    setHesterPortProvider(() => port);
    const spooled = [];
    await withTetherApp(device, async (base) => {
      for (const route of ['/tether', '/tether/desk', '/tether/pages', '/tether/pages/pg-0000abcd', '/tether/drawer']) {
        const res = await fetch(`${base}${route}`);
        assert.strictEqual(res.status, 503, route);
        assert.strictEqual((await res.json()).error, 'hester_offline');
      }
      const res = await post(base, '/tether/capture', { text: ' on the train ', card_id: 'pg-0000abcd' });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual((await res.json()).data, { id: null, spooled: true });
      assert.deepStrictEqual(spooled, [
        { text: 'on the train', as: 'someday', source: { surface: 'aeronaut', device_id: 'dev-1', card_id: 'pg-0000abcd' }, workspace: '/work/api' },
      ]);
    }, { spool: (p) => (spooled.push(p), true), spooledCount: () => spooled.length });
    // No spool to write to: 503 rather than losing the thought silently.
    await withTetherApp(device, async (base) => {
      assert.strictEqual((await post(base, '/tether/capture', { text: 'x' })).status, 503);
    }, { spool: () => false });

    // The real relay: its spool keeps the source (card) and posts to /ideas.
    const { CaptureRelay, migrateSpool } = require(path.join(dist, 'copilot', 'capture.js'));
    const dir = path.join(tmpHome, '.lee', 'spool');
    const spoolFile = path.join(dir, 'ideas.jsonl');
    const relay = new CaptureRelay({ spoolFile, getHesterPort: () => port, getSharedToken: () => 't' });
    assert.strictEqual(relay.spool({ text: 'y', as: 'someday', source: { surface: 'dirigible', card_id: 'pg-0000abcd' } }), true);
    assert.strictEqual(relay.pending(), 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(spoolFile, 'utf8')).source, { surface: 'dirigible', card_id: 'pg-0000abcd' });
    relay.stop();
    // The spool rename: someday.jsonl's waiting captures move to ideas.jsonl, once.
    const old = path.join(dir, 'someday.jsonl');
    fs.writeFileSync(old, JSON.stringify({ text: 'old one', as: 'someday', source: { surface: 'lee' } }) + '\n\n');
    assert.strictEqual(migrateSpool(old, spoolFile), 1);
    assert.ok(!fs.existsSync(old));
    assert.deepStrictEqual(fs.readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text), ['y', 'old one']);
    assert.strictEqual(migrateSpool(old, spoolFile), 0, 'nothing left to move');
    await withFakeHester((c) => (c.url === '/ideas' ? [201, { success: true, data: { id: 'idea_x' } }] : [404, {}]), async (calls) => {
      const r2 = new CaptureRelay({ spoolFile, getHesterPort, getSharedToken: () => 't' });
      assert.strictEqual(await r2.drain(), 2);
      assert.deepStrictEqual(calls.map((c) => [c.method, c.url]), [['POST', '/ideas'], ['POST', '/ideas']]);
      r2.stop();
    });
  } finally {
    unregister();
  }
});

test('Review: /tether/desk, /tether/pages, a Page (full and text_only) and the Drawer, trimmed for devices', async () => {
  const unregister = withWindow([], 9, '/work/api');
  try {
    await withFakeHester((c) => deskHester(c), async () => {
      await withTetherApp(device, async (base) => {
        const desk = (await (await fetch(`${base}/tether/desk`)).json()).data;
        assert.deepStrictEqual(desk.areas.map((a) => [a.name, a.cards.map((c) => c.id)]), [['Mesh', ['pg-0000abcd', 'pg-00000002']]], 'on the Desk only, newest first');
        assert.deepStrictEqual(desk.areas[0].cards[0], {
          id: 'pg-0000abcd', kind: 'page', title: 'Mesh sync', area_id: 'area-0000abcd', area_name: 'Mesh',
          stashed: false, updated_at: '2026-09-27T00:00:00Z', chars: 4321, answers: 2, open_questions: 1,
        });
        assert.strictEqual(desk.goals_card.id, 'pg-0000000a');
        assert.strictEqual(desk.last_card_id, 'pg-0000abcd');

        const pages = (await (await fetch(`${base}/tether/pages`)).json()).data;
        assert.deepStrictEqual(pages.map((c) => c.id), ['pg-0000abcd', 'pg-00000002', 'pg-00000003', 'pg-0000000a'], 'every Page, stashed too, newest first');
        assert.strictEqual(pages[2].stashed, true);
        assert.strictEqual((await (await fetch(`${base}/tether/pages?limit=2`)).json()).data.length, 2);
        assert.strictEqual((await fetch(`${base}/tether/pages?limit=0`)).status, 400);

        const page = (await (await fetch(`${base}/tether/pages/pg-0000abcd`)).json()).data;
        assert.strictEqual(page.card.id, 'pg-0000abcd');
        assert.strictEqual(page.text, '# Mesh sync\n\nWrites carry a clock.\n');
        assert.deepStrictEqual(page.answers, [{ id: 'ans-1', question: 'why?', answer: 'because', status: 'done' }], 'dismissed and hand-offs left out');
        assert.deepStrictEqual(page.handoffs, [{ id: 'ans-3', kind: 'spike', provider: 'claude', status: 'review', result: 'result' }]);
        assert.deepStrictEqual(page.open_questions, [{ id: 'q-1', text: 'open one?' }]);
        assert.deepStrictEqual(page.references, [
          { title: 'CRDTs', where: 'https://example.com/crdt', quote: null },
          { title: 'docs/sync.md', where: 'docs/sync.md:3-4', quote: 'Writes carry a clock.' },
        ]);
        const textOnly = (await (await fetch(`${base}/tether/pages/pg-0000abcd?text_only=1`)).json()).data;
        assert.deepStrictEqual(Object.keys(textOnly).sort(), ['card', 'text']);
        assert.strictEqual((await fetch(`${base}/tether/pages/pg-00000009`)).status, 404, 'Hester has no such Page');
        assert.strictEqual((await fetch(`${base}/tether/pages/nope`)).status, 400);

        const drawer = (await (await fetch(`${base}/tether/drawer`)).json()).data;
        assert.deepStrictEqual(drawer.stashed.map((a) => [a.name, a.stashed_at, a.cards.map((c) => c.id)]), [
          ['Old', '2026-09-20T00:00:00Z', ['pg-00000003']],
          ['Older', '2026-09-10T00:00:00Z', []],
        ]);
        assert.deepStrictEqual(drawer.ideas, [
          { id: 'idea_2', text: 'newer', created_at: '2026-09-27T00:00:00Z', surface: 'lee' },
          { id: 'idea_1', text: 'try CRDTs', created_at: '2026-09-26T00:00:00Z', surface: 'aeronaut' },
        ], 'open only, newest first');
      });
    });
  } finally {
    unregister();
  }
});

test('Review: a long Page is cut at a line with …; Page images are proxied with auth, images only', async () => {
  assert.strictEqual(cutText('short'), 'short');
  const long = Array.from({ length: 100 }, (_, i) => `line ${i} ${'é'.repeat(20)}`).join('\n');
  const cut = cutText(long, 500);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 500 + 4);
  assert.ok(cut.endsWith('\n…'));
  assert.ok(long.startsWith(cut.slice(0, -2)), 'whole lines only');

  const unregister = withWindow([], 10, '/work/api');
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const seen = [];
    const hesterRaw = async (route, ws) => {
      seen.push([route, ws]);
      if (route.startsWith('/desk/pages/pg-0000abcd/assets/a1.png')) return { offline: false, status: 200, contentType: 'image/png', body: png };
      if (route.startsWith('/desk/pages/pg-0000abcd/assets/evil.png')) return { offline: false, status: 200, contentType: 'text/html', body: Buffer.from('<x>') };
      return { offline: false, status: 404, contentType: 'application/json', body: Buffer.from('{}') };
    };
    await withTetherApp(device, async (base) => {
      const res = await fetch(`${base}/tether/pages/pg-0000abcd/assets/a1.png`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/png');
      assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), png);
      assert.deepStrictEqual(seen[0], ['/desk/pages/pg-0000abcd/assets/a1.png?workspace=%2Fwork%2Fapi', '/work/api']);
      assert.strictEqual((await fetch(`${base}/tether/pages/pg-0000abcd/assets/evil.png`)).status, 502, 'images only');
      assert.strictEqual((await fetch(`${base}/tether/pages/pg-0000abcd/assets/none.jpg`)).status, 404);
      assert.strictEqual((await fetch(`${base}/tether/pages/pg-0000abcd/assets/..%2Fpage.md`)).status, 400);
      assert.strictEqual((await fetch(`${base}/tether/pages/pg-0000abcd/assets/x.svg`)).status, 400);
    }, { hesterRaw });
    await withTetherApp(device, async (base) => {
      assert.strictEqual((await fetch(`${base}/tether/pages/pg-0000abcd/assets/a1.png`)).status, 503);
    }, { hesterRaw: async () => ({ offline: true }) });
  } finally {
    unregister();
  }
});

// ---------------------------------------------------------------------------
// Send to Lee (§4.2): targets, validation, the IPC round trip with a fake window
// ---------------------------------------------------------------------------

const TABS = [
  { id: 1, type: 'agent', label: 'Claude', ptyId: 11, provider: 'claude', dockPosition: 'center', state: 'active' },
  { id: 2, type: 'terminal', label: 'zsh', ptyId: 12, dockPosition: 'center', state: 'background' },
  { id: 3, type: 'git', label: 'lazygit', ptyId: 13, dockPosition: 'center', state: 'background' },
  { id: 4, type: 'files', label: 'Files', ptyId: null, dockPosition: 'left', state: 'background' },
];
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]).toString('base64');
const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 1)]).toString('base64');

/** A window whose renderer answers tether:send with `answer(delivery)` (or never, when it returns undefined). */
function withSendWindow(id, workspace, { tabs = TABS, activeTabId = 1, answer = () => ({ ok: true }) } = {}) {
  const sent = [];
  const bw = {
    id,
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        sent.push([channel, payload]);
        const out = answer(payload);
        if (out) setImmediate(() => tetherSendBroker.settle({ send_id: payload.send_id, ...out }));
      },
    },
  };
  windowRegistry.register(bw, workspace, {
    getContext: () => ({ workspace, tabs, panels: { center: { activeTabId, visible: true, size: 100 }, left: null, right: null, bottom: null }, focusedPanel: 'center' }),
  });
  return { sent, unregister: () => windowRegistry.unregister(id) };
}

test('buildTargets: the palette, else the zoomed Page, else the focused agent tab; the rest follow', () => {
  const deep = { workspace: '/w', card: { card_id: 'pg-0000abcd', title: 'Mesh sync' }, touched: ['pg-00000001', 'pg-0000abcd', 'pg-00000002'] };
  const titles = new Map([['pg-00000001', 'A'], ['pg-00000002', 'B']]);
  let t = buildTargets({ tabs: TABS, activeTabId: 1, paletteOpen: false, deep, titles });
  assert.deepStrictEqual(t.focus, { kind: 'page', card_id: 'pg-0000abcd', title: 'Mesh sync' });
  assert.deepStrictEqual(t.targets.map((x) => x.kind === 'page' ? x.card_id : x.kind === 'tab' ? `${x.tab_kind}:${x.pty_id}` : x.kind), [
    'pg-00000002', 'pg-00000001', 'hester', 'agent:11', 'terminal:12', 'tui:13',
  ], 'touched Pages most recent first, Hester, then every PTY tab');
  assert.deepStrictEqual(t.targets[3], { kind: 'tab', pty_id: 11, label: 'Claude', tab_kind: 'agent', provider: 'claude' });
  t = buildTargets({ tabs: TABS, activeTabId: 1, paletteOpen: true, deep, titles });
  assert.deepStrictEqual(t.focus, { kind: 'hester' });
  assert.ok(!t.targets.some((x) => x.kind === 'hester'), 'focus is not repeated');
  t = buildTargets({ tabs: TABS, activeTabId: 1, paletteOpen: false, deep: null, titles: new Map() });
  assert.strictEqual(t.focus.pty_id, 11);
  t = buildTargets({ tabs: TABS, activeTabId: 2, paletteOpen: false, deep: null, titles: new Map() });
  assert.strictEqual(t.focus, null, 'a terminal in front is not the focus');
});

test('checkSendRequest: §4.2 limits, submit only with text and never for a Page', () => {
  const ok = (body) => { const r = checkSendRequest(body); assert.ok(r.ok, JSON.stringify(r)); return r; };
  const no = (body, re) => { const r = checkSendRequest(body); assert.ok(!r.ok && r.status === 400, JSON.stringify(body).slice(0, 80)); if (re) assert.ok(re.test(r.error), r.error); };
  let r = ok({ target: 'focus', items: [{ kind: 'text', text: 'héllo', input: 'voice' }] });
  assert.deepStrictEqual(r.bytes, [6]);
  assert.strictEqual(r.submit, false, 'Deliver by default');
  r = ok({ target: { kind: 'tab', pty_id: 11 }, items: [{ kind: 'image', mime: 'image/png', data_b64: PNG_B64, source: 'scribble', caption: ' a sketch ' }, { kind: 'text', text: 'see' }], submit: true });
  assert.strictEqual(r.items[0].caption, 'a sketch');
  assert.strictEqual(r.bytes[0], 32);
  ok({ target: { kind: 'page', card_id: 'pg-0000abcd', title: 'Mesh' }, items: [{ kind: 'image', mime: 'image/jpeg', data_b64: JPEG_B64, source: 'photo' }] });
  ok({ target: { kind: 'hester' }, items: [{ kind: 'text', text: 'why?' }], submit: true });
  no({ target: 'focus', items: [] }, /non-empty/);
  no({ target: 'focus', items: Array(5).fill({ kind: 'text', text: 'x' }) }, /at most 4/);
  no({ target: 'focus', items: [{ kind: 'text', text: 'x'.repeat(20_001) }] }, /20000/);
  no({ target: 'focus', items: [{ kind: 'text', text: '   ' }] });
  no({ target: 'focus', items: [{ kind: 'text', text: 'x', input: 'keys' }] });
  no({ target: 'focus', items: [{ kind: 'image', mime: 'image/gif', data_b64: PNG_B64, source: 'photo' }] });
  no({ target: 'focus', items: [{ kind: 'image', mime: 'image/png', data_b64: JPEG_B64, source: 'photo' }] }, /not a PNG/);
  no({ target: 'focus', items: [{ kind: 'image', mime: 'image/png', data_b64: 'not base64!', source: 'photo' }] }, /base64/);
  no({ target: 'focus', items: [{ kind: 'image', mime: 'image/png', data_b64: PNG_B64, source: 'webcam' }] });
  // Over 10 MB decoded is refused from the length alone.
  no({ target: 'focus', items: [{ kind: 'image', mime: 'image/png', data_b64: Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.alloc(10 * 1024 * 1024)]).toString('base64'), source: 'photo' }] }, /10 MB/);
  no({ target: { kind: 'page', card_id: 'pg-0000abcd' }, items: [{ kind: 'text', text: 'x' }], submit: true }, /Page/);
  no({ target: { kind: 'hester' }, items: [{ kind: 'image', mime: 'image/png', data_b64: PNG_B64, source: 'photo' }], submit: true }, /text/);
  no({ target: { kind: 'hester' }, items: [{ kind: 'text', text: 'x' }], submit: 'yes' });
  no({ target: { kind: 'board', card_id: 'pg-0000abcd', title: 'B' }, items: [{ kind: 'text', text: 'x' }] }, /Board/);
  no({ target: { kind: 'page', card_id: '../x' }, items: [{ kind: 'text', text: 'x' }] });
  no({ target: { kind: 'tab', pty_id: 1.5 }, items: [{ kind: 'text', text: 'x' }] });
  no({ target: 'there', items: [{ kind: 'text', text: 'x' }] });
});

test('POST /tether/send: IPC tether:send to the window, answered by tether:send-result; the event has sizes, never content', async () => {
  const win = withSendWindow(21, '/work/send');
  const events = [];
  const onEv = (e) => events.push(e);
  copilotBus.on('event', onEv);
  try {
    await withFakeHester((c) => deskHester(c), async () => {
      await withTetherApp(device, async (base) => {
        // Targets: the focused agent tab is in front (no Deep session here).
        const targets = (await (await fetch(`${base}/tether/targets?workspace=${encodeURIComponent('/work/send')}`)).json()).data;
        assert.deepStrictEqual(targets.focus, { kind: 'tab', pty_id: 11, label: 'Claude', tab_kind: 'agent', provider: 'claude' });
        assert.strictEqual(targets.targets[0].kind, 'hester');

        let res = await post(base, '/tether/send', { workspace: '/work/send', target: 'focus', items: [{ kind: 'text', text: 'run the tests\nthen push', input: 'voice' }], submit: true });
        assert.strictEqual(res.status, 200);
        const { data } = await res.json();
        assert.match(data.send_id, /^snd_/);
        assert.deepStrictEqual(data.delivered_to, targets.focus);
        const [channel, delivery] = win.sent.pop();
        assert.strictEqual(channel, 'tether:send');
        assert.deepStrictEqual(delivery, {
          send_id: data.send_id,
          target: targets.focus,
          items: [{ kind: 'text', text: 'run the tests\nthen push', input: 'voice' }],
          submit: true,
          from: { surface: 'aeronaut', device_name: 'Phone' },
        });
        const ev = events.filter((e) => e.type === 'tether.send').pop();
        assert.deepStrictEqual(ev.data, {
          source_device: 'aeronaut', target_kind: 'tab', submit: true,
          items: [{ kind: 'text', input: 'voice', bytes: 23 }], ok: true,
        });
        assert.ok(!JSON.stringify(ev).includes('tests'), 'never the text');

        // A tab by pty id: the window's own label and kind, whatever the device sent.
        res = await post(base, '/tether/send', { workspace: '/work/send', target: { kind: 'tab', pty_id: 13, label: 'lies', tab_kind: 'agent' }, items: [{ kind: 'image', mime: 'image/png', data_b64: PNG_B64, source: 'screenshot' }] });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(win.sent.pop()[1].target, { kind: 'tab', pty_id: 13, label: 'lazygit', tab_kind: 'tui', provider: null });
        assert.deepStrictEqual(events.filter((e) => e.type === 'tether.send').pop().data.items, [{ kind: 'image', source: 'screenshot', bytes: 32 }]);
        assert.strictEqual((await post(base, '/tether/send', { workspace: '/work/send', target: { kind: 'tab', pty_id: 99 }, items: [{ kind: 'text', text: 'x' }] })).status, 400, 'not a tab there');
        // A Page and Hester go as given.
        res = await post(base, '/tether/send', { workspace: '/work/send', target: { kind: 'page', card_id: 'pg-0000abcd', title: 'Mesh sync' }, items: [{ kind: 'text', text: 'a thought' }] });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(win.sent.pop()[1].submit, false);
        // No Lee window has that workspace.
        const none = await post(base, '/tether/send', { workspace: '/elsewhere', target: { kind: 'hester' }, items: [{ kind: 'text', text: 'x' }] });
        assert.strictEqual(none.status, 503);
        assert.strictEqual((await none.json()).error, 'no_window');
        assert.strictEqual((await fetch(`${base}/tether/targets?workspace=/elsewhere`)).status, 503);
      });
    });
  } finally {
    copilotBus.off('event', onEv);
    win.unregister();
  }
});

test('POST /tether/send: 409 no_target, a renderer error (502), and 504 when the renderer never answers', async () => {
  const quiet = withSendWindow(22, '/work/quiet', { activeTabId: 2, answer: (d) => (d.target.kind === 'hester' ? { ok: false, error: 'palette_busy' } : d.target.kind === 'tab' ? undefined : { ok: true }) });
  const events = [];
  const onEv = (e) => events.push(e);
  copilotBus.on('event', onEv);
  try {
    await withTetherApp({ kind: 'shared', loopback: true, ip: '127.0.0.1' }, async (base) => {
      const ws = '/work/quiet';
      // A terminal is in front and there's no Deep session or palette: nothing to aim 'focus' at.
      let res = await post(base, '/tether/send', { workspace: ws, target: 'focus', items: [{ kind: 'text', text: 'x' }] });
      assert.strictEqual(res.status, 409);
      assert.strictEqual((await res.json()).error, 'no_target');
      res = await post(base, '/tether/send', { workspace: ws, target: { kind: 'hester' }, items: [{ kind: 'text', text: 'x' }] });
      assert.strictEqual(res.status, 502);
      assert.strictEqual((await res.json()).error, 'palette_busy');
      const t0 = Date.now();
      res = await post(base, '/tether/send', { workspace: ws, target: { kind: 'tab', pty_id: 12 }, items: [{ kind: 'text', text: 'x' }] });
      assert.strictEqual(res.status, 504);
      assert.ok(Date.now() - t0 < 2000);
      const evs = events.filter((e) => e.type === 'tether.send');
      assert.deepStrictEqual(evs.map((e) => [e.data.ok, e.data.error, e.data.source_device]), [[false, 'palette_busy', 'lee'], [false, 'timeout', 'lee']]);
      // A late answer for a timed-out send is ignored.
      assert.strictEqual(tetherSendBroker.settle({ send_id: 'snd_gone', ok: true }), false);
    }, { sendTimeoutMs: 100 });
    // The Deep session's zoomed Page is the focus in its workspace.
    await withFakeHester((c) => deskHester(c), async () => {
      await withTetherApp(device, async (base) => {
        const res = await post(base, '/tether/send', { workspace: '/work/quiet', target: 'focus', items: [{ kind: 'text', text: 'x' }] });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual((await res.json()).data.delivered_to, { kind: 'page', card_id: 'pg-0000abcd', title: 'Mesh sync' });
        const targets = (await (await fetch(`${base}/tether/targets?workspace=/work/quiet`)).json()).data;
        assert.deepStrictEqual(targets.targets.filter((t) => t.kind === 'page'), [{ kind: 'page', card_id: 'pg-00000002', title: 'Older page' }], 'titles from the Desk');
        const refused = await post(base, '/tether/send', { workspace: '/work/quiet', target: 'focus', items: [{ kind: 'text', text: 'x' }], submit: true });
        assert.strictEqual(refused.status, 400, 'submit to a Page, via focus');
      }, { deep: () => ({ workspace: '/work/quiet', card: { card_id: 'pg-0000abcd', title: 'Mesh sync' }, touched: ['pg-00000002', 'pg-0000abcd'] }) });
    });
  } finally {
    copilotBus.off('event', onEv);
    quiet.unregister();
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failed++;
      console.log(`not ok - ${name}`);
      console.log(err && err.stack ? err.stack : err);
    }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
