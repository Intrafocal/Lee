#!/usr/bin/env node
/**
 * Smoke test for usage capture (docs/15-Usage.md §3.1-§3.3) and the Carry
 * routes (14 §8.1): transcript dedupe, model switches, subagent files, cost
 * deltas, basis, status line throttling, the status line script, snapshot
 * usage/limits, and /carry forwarding to a fake Hester (and 503 offline).
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
const { registerCarryRoutes, buildCarry, parseOpenNext } = require(path.join(dist, 'copilot', 'carry.js'));
const { setHesterPortProvider } = require(path.join(dist, 'copilot', 'capture.js'));
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
// Carry routes with a fake Hester
// ---------------------------------------------------------------------------

const OPENER = {
  generated_at: '2026-09-27T10:00:00Z',
  workspace: '/work/api',
  pick_up: {
    exploration: { id: 'exp-2', title: 'Sync engine', last_touched_at: '2026-09-26T18:00:00Z' },
    stopped_at: 'Was weighing CRDT vs OT',
    arrived: { answers: 1, open_questions: 2 },
  },
  surfaces: [
    { kind: 'blank' },
    {
      kind: 'open_questions',
      count: 7,
      items: [
        { exploration_id: 'exp-1', exploration_title: 'A', question_id: 'q1', text: 'one?' },
        { exploration_id: 'exp-2', exploration_title: 'B', question_id: 'q2', text: 'two?' },
        { exploration_id: 'exp-1', exploration_title: 'A', question_id: 'q3', text: 'three?' },
        { exploration_id: 'exp-1', exploration_title: 'A', question_id: 'q4', text: 'four?' },
        { exploration_id: 'exp-2', exploration_title: 'B', question_id: 'q5', text: 'five?' },
        { exploration_id: 'exp-1', exploration_title: 'A', question_id: 'q6', text: 'six?' },
      ],
    },
    { kind: 'captured_away', count: 3, items: [] },
    { kind: 'reading_list', count: 2, items: [] },
  ],
};

async function withCarryApp(principal, fn, deps = {}) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.principal = principal;
    next();
  });
  registerCarryRoutes(app, deps);
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

const device = { kind: 'device', device_id: 'dev-1', device_kind: 'aeronaut', name: 'Phone' };

test('buildCarry: a pre-Desk opener (no card): its exploration stands in as the card; its questions first, at most 5', () => {
  const c = buildCarry(OPENER, null, null);
  assert.deepStrictEqual(c.pick_up, {
    card_id: 'exp-2', card_kind: 'page', title: 'Sync engine', area_name: null,
    stopped_at: 'Was weighing CRDT vs OT', stopped_line: null, last_touched_at: '2026-09-26T18:00:00Z', exploration_id: 'exp-2',
  });
  assert.deepStrictEqual(c.open_questions.map((q) => q.question_id), ['q2', 'q5', 'q1', 'q3', 'q4']);
  assert.deepStrictEqual(c.open_questions[0], { card_id: 'exp-2', exploration_id: 'exp-2', question_id: 'q2', text: 'two?' });
  assert.strictEqual(c.captured_count, 3);
  assert.strictEqual(c.reading_count, 2);
  assert.strictEqual(c.spooled, 0);
  assert.strictEqual(buildCarry({ ...OPENER, pick_up: null, surfaces: [] }, null, '/w').pick_up, null);
});

test('buildCarry: the Desk opener picks up your last card, its area and stopped-at line; spooled counts', () => {
  const card = { id: 'pg-0000abcd', kind: 'page', title: 'Mesh sync', area_id: 'area-0000abcd', area_name: 'Mesh', purpose: null, last_touched_at: '2026-09-27T08:00:00Z' };
  const desk = {
    ...OPENER,
    pick_up: {
      card,
      exploration: { id: 'pg-0000abcd', title: 'Mesh sync', last_touched_at: '2026-09-27T08:00:00Z' },
      open_next: null,
      stopped_at: '…where the clocks disagree',
      stopped_line: 12,
      arrived: { answers: 0, open_questions: 1 },
    },
    surfaces: [
      { kind: 'open_questions', count: 2, items: [
        { exploration_id: 'pg-00000001', exploration_title: 'A', card_id: 'pg-00000001', card_title: 'A', question_id: 'q1', text: 'one?' },
        { exploration_id: 'pg-0000abcd', exploration_title: 'Mesh sync', card_id: 'pg-0000abcd', card_title: 'Mesh sync', question_id: 'q2', text: 'two?' },
      ] },
    ],
  };
  const c = buildCarry(desk, { card_id: 'pg-0000abcd', exploration_id: 'pg-0000abcd', set_at: '2026-09-27T09:00:00Z' }, null, 2);
  assert.deepStrictEqual(c.pick_up, {
    card_id: 'pg-0000abcd', card_kind: 'page', title: 'Mesh sync', area_name: 'Mesh',
    stopped_at: '…where the clocks disagree', stopped_line: 12, last_touched_at: '2026-09-27T08:00:00Z', exploration_id: 'pg-0000abcd',
  });
  assert.deepStrictEqual(c.open_questions.map((q) => q.card_id), ['pg-0000abcd', 'pg-00000001']);
  assert.strictEqual(c.spooled, 2);
  assert.strictEqual(buildCarry({ ...desk, pick_up: { ...desk.pick_up, stopped_line: 0 } }, null, null).pick_up.stopped_line, null, 'lines are 1-based');
  // Open next: card_id with exploration_id as its alias; a legacy record keeps its exploration_id.
  assert.deepStrictEqual(parseOpenNext({ card_id: 'pg-0000abcd', set_at: 't' }), { card_id: 'pg-0000abcd', exploration_id: 'pg-0000abcd', set_at: 't' });
  assert.deepStrictEqual(parseOpenNext({ exploration_id: 'exp-1', set_at: 't' }), { exploration_id: 'exp-1', set_at: 't' });
});

test('GET /carry forwards to opener + open-next with the workspace header', async () => {
  fs.mkdirSync(path.join(tmpHome, '.lee'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.lee', 'api-token'), 'tok-123\n');
  const unregister = withWindow([], 5, '/work/api');
  try {
    await withFakeHester(
      (c) => {
        if (c.url.startsWith('/copilot/opener')) return [200, { success: true, data: OPENER }];
        if (c.url.startsWith('/copilot/open-next')) return [200, { success: true, data: { exploration_id: 'exp-1', set_at: '2026-09-27T09:00:00Z', surface: 'aeronaut' } }];
        return [404, { success: false, error: 'nope' }];
      },
      async (calls) => {
        await withCarryApp(device, async (base) => {
          const res = await fetch(`${base}/carry?workspace=${encodeURIComponent('/work/api')}`);
          assert.strictEqual(res.status, 200);
          const { data } = await res.json();
          assert.strictEqual(data.workspace, '/work/api');
          assert.strictEqual(data.pick_up.exploration_id, 'exp-2');
          assert.strictEqual(data.open_questions.length, 5);
          assert.deepStrictEqual(data.open_next, { exploration_id: 'exp-1', set_at: '2026-09-27T09:00:00Z' });
          assert.strictEqual(calls.length, 2);
          for (const c of calls) {
            assert.strictEqual(c.headers.authorization, 'Bearer tok-123');
            assert.ok(c.headers['x-lee-workspace'], 'workspace header');
            assert.ok(c.url.includes('workspace=%2Fwork%2Fapi'));
          }
          // Default: the focused (else any) window's workspace.
          const d = await fetch(`${base}/carry`);
          assert.strictEqual((await d.json()).data.workspace, '/work/api');
          // Not an open window's workspace.
          assert.strictEqual((await fetch(`${base}/carry?workspace=/nope`)).status, 400);
        });
      },
    );
    // An older Hester without open-next still gives a Carry view.
    await withFakeHester(
      (c) => (c.url.startsWith('/copilot/opener') ? [200, { success: true, data: OPENER }] : [404, { detail: 'Not Found' }]),
      async () => {
        await withCarryApp(device, async (base) => {
          const { data } = await (await fetch(`${base}/carry`)).json();
          assert.strictEqual(data.open_next, null);
        });
      },
    );
  } finally {
    unregister();
  }
});

test('POST /carry/capture and /carry/open-next forward with the device surface', async () => {
  const unregister = withWindow([], 6, '/work/api');
  try {
    await withFakeHester(
      (c) => {
        if (c.url === '/someday') return [201, { success: true, data: { id: 'sd-9', text: c.body.text } }];
        if (c.url === '/copilot/open-next') return [200, { success: true, data: { someday_id: 'sd-9', set_at: '2026-09-27T11:00:00Z', surface: c.body.surface } }];
        return [404, {}];
      },
      async (calls) => {
        await withCarryApp(device, async (base) => {
          const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          let res = await post('/carry/capture', { text: '  a thought on the walk ', exploration_id: 'exp-2' });
          assert.strictEqual(res.status, 200);
          assert.strictEqual((await res.json()).data.someday_id, 'sd-9');
          const cap = calls.find((c) => c.url === '/someday');
          assert.strictEqual(cap.body.as, 'someday');
          assert.strictEqual(cap.body.text, 'a thought on the walk');
          assert.deepStrictEqual(cap.body.source, { surface: 'aeronaut', device_id: 'dev-1', exploration_id: 'exp-2' });
          assert.strictEqual(cap.body.workspace, '/work/api');
          assert.ok(cap.headers['x-lee-workspace']);
          assert.strictEqual((await post('/carry/capture', { text: '' })).status, 400);
          assert.strictEqual((await post('/carry/capture', { text: 'x', exploration_id: '../etc' })).status, 400);

          res = await post('/carry/open-next', { someday_id: 'sd-9' });
          assert.strictEqual(res.status, 200);
          assert.deepStrictEqual((await res.json()).data.open_next, { someday_id: 'sd-9', set_at: '2026-09-27T11:00:00Z' });
          const on = calls.find((c) => c.url === '/copilot/open-next');
          assert.deepStrictEqual(on.body, { someday_id: 'sd-9', surface: 'aeronaut', workspace: '/work/api' });
          assert.strictEqual((await post('/carry/open-next', {})).status, 400, 'one of the three');
          assert.strictEqual((await post('/carry/open-next', { someday_id: 'a', exploration_id: 'b' })).status, 400, 'not both');
          assert.strictEqual((await post('/carry/open-next', { someday_id: 'a', card_id: 'pg-00000001' })).status, 400, 'not both');

          // Desk D2 §9.3: a card id goes to Hester as card_id; a pre-Desk id as exploration_id.
          calls.length = 0;
          assert.strictEqual((await post('/carry/open-next', { card_id: 'pg-0000abcd' })).status, 200);
          assert.deepStrictEqual(calls.pop().body, { card_id: 'pg-0000abcd', surface: 'aeronaut', workspace: '/work/api' });
          assert.strictEqual((await post('/carry/open-next', { card_id: 'exp-2' })).status, 200);
          assert.deepStrictEqual(calls.pop().body, { exploration_id: 'exp-2', surface: 'aeronaut', workspace: '/work/api' });
          assert.strictEqual((await post('/carry/open-next', { exploration_id: 'exp-2' })).status, 200);
          assert.deepStrictEqual(calls.pop().body, { exploration_id: 'exp-2', surface: 'aeronaut', workspace: '/work/api' });
          assert.strictEqual((await post('/carry/capture', { text: 'into the card', card_id: 'pg-0000abcd' })).status, 200);
          assert.deepStrictEqual(calls.pop().body.source, { surface: 'aeronaut', device_id: 'dev-1', card_id: 'pg-0000abcd' });
          assert.strictEqual((await post('/carry/capture', { text: 'x', card_id: '../etc' })).status, 400);
        });
        // The renderer (shared loopback) is 'lee'.
        await withCarryApp({ kind: 'shared', loopback: true, ip: '127.0.0.1' }, async (base) => {
          await fetch(`${base}/carry/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'from Lee' }) });
          assert.deepStrictEqual(calls.filter((c) => c.url === '/someday').pop().body.source, { surface: 'lee' });
        });
      },
    );
  } finally {
    unregister();
  }
});

test('Hester offline: GET /carry and open-next answer 503 hester_offline; a capture spools (200 spooled: true)', async () => {
  const unregister = withWindow([], 8, '/work/api');
  try {
    // A port nothing listens on.
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    setHesterPortProvider(() => port);
    const spooled = [];
    await withCarryApp(device, async (base) => {
      for (const [method, route, body] of [
        ['GET', '/carry', null],
        ['POST', '/carry/open-next', { exploration_id: 'exp-1' }],
      ]) {
        const res = await fetch(`${base}${route}`, {
          method,
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        assert.strictEqual(res.status, 503, route);
        assert.strictEqual((await res.json()).error, 'hester_offline');
      }
      const events = [];
      const onEv = (e) => events.push(e);
      copilotBus.on('event', onEv);
      const res = await fetch(`${base}/carry/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ' on the train ', card_id: 'pg-0000abcd' }),
      });
      copilotBus.off('event', onEv);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual((await res.json()).data, { success: true, someday_id: null, spooled: true });
      assert.deepStrictEqual(spooled, [
        { text: 'on the train', as: 'someday', source: { surface: 'aeronaut', device_id: 'dev-1', card_id: 'pg-0000abcd' }, workspace: '/work/api' },
      ]);
      const cap = events.find((e) => e.type === 'capture');
      assert.strictEqual(cap.data.spooled, true);
      assert.ok(!JSON.stringify(cap).includes('train'), 'never the text');
    }, { spool: (p) => (spooled.push(p), true), spooledCount: () => spooled.length });
    // No spool to write to: 503 rather than losing the thought silently.
    await withCarryApp(device, async (base) => {
      const res = await fetch(`${base}/carry/capture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
      assert.strictEqual(res.status, 503);
    }, { spool: () => false });
    // The real capture relay's spool: the source (card) is kept for the retry.
    const { CaptureRelay } = require(path.join(dist, 'copilot', 'capture.js'));
    const spoolFile = path.join(tmpHome, '.lee', 'spool', 'carry-test.jsonl');
    const relay = new CaptureRelay({ spoolFile, getHesterPort: () => port, getSharedToken: () => 't' });
    assert.strictEqual(relay.spool({ text: 'y', as: 'someday', source: { surface: 'tdeck', card_id: 'pg-0000abcd' } }), true);
    assert.strictEqual(relay.pending(), 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(spoolFile, 'utf8')).source, { surface: 'tdeck', card_id: 'pg-0000abcd' });
    relay.stop();
  } finally {
    unregister();
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
