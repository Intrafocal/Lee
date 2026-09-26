#!/usr/bin/env node
/**
 * Smoke test for Copilot v2 work lint (package D, contracts §8 and §13 D):
 * the four toil rules at and just below their thresholds, the engine's diff,
 * outcomes and demotion, the nudge budget, the settings.local.json fix, and
 * lint-main's startup scan and IPC. No Electron, no ports, no real Claude.
 *
 *   cd electron && npm run build:main && node scripts/cockpit-lint-smoke.js
 *
 * `electron` is stubbed and HOME points at a temp dir, so nothing under the
 * real ~/.lee is read or written; workspaces are temp dirs too.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-lint-smoke-'));
process.env.HOME = tmpHome;

const ipcHandlers = new Map();
const ipcListeners = new Map();
const electronStub = {
  app: { on() {}, getPath: () => tmpHome, isPackaged: false },
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    removeHandler: (ch) => ipcHandlers.delete(ch),
    on: (ch, fn) => ipcListeners.set(ch, fn),
    removeAllListeners: (ch) => ipcListeners.delete(ch),
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const dist = path.join(__dirname, '..', 'dist', 'main', 'cockpit');
const { LintEngine, diagIdFor, demote } = require(path.join(dist, 'lint', 'engine.js'));
const { LintStore } = require(path.join(dist, 'lint', 'store.js'));
const { RepeatedSequenceRule, commandSig } = require(path.join(dist, 'lint', 'rules', 'repeated-sequence.js'));
const { FlakyOperationRule } = require(path.join(dist, 'lint', 'rules', 'flaky-operation.js'));
const { LongWaitRule } = require(path.join(dist, 'lint', 'rules', 'long-wait.js'));
const { RepeatApprovalRule, permissionRule } = require(path.join(dist, 'lint', 'rules', 'repeat-approval.js'));
const { writeClaudeAllow } = require(path.join(dist, 'lint', 'claude-allow.js'));
const { eventFiles } = require(path.join(dist, 'lint', 'event-scan.js'));
const { NudgeBudget, cockpitBus } = require(path.join(dist, 'cockpit-bus.js'));
const { COCKPIT_DEFAULTS } = require(path.join(dist, 'cockpit-config.js'));

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let seq = 0;

function ev(type, data, opts = {}) {
  return {
    v: 1,
    id: `e${seq++}`,
    ts: new Date(opts.ts ?? NOW).toISOString(),
    type,
    source: 'lee-main',
    workspace: opts.workspace === undefined ? WS : opts.workspace,
    window_id: null,
    actor: { kind: 'system' },
    ctx: { at_machine: opts.at_machine ?? true, engaged: true, focus_session_id: null, away: false },
    data,
  };
}

function mkWorkspace(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lee-lint-ws-${name}-`));
  return fs.realpathSync(dir);
}
const WS = mkWorkspace('a');

function baseCtx(overrides = {}) {
  const rules = JSON.parse(JSON.stringify(COCKPIT_DEFAULTS.lint.rules));
  return {
    now: NOW,
    config: (rule) => rules[rule] ?? { severity: 'off' },
    commandText: () => null,
    toolInfo: () => null,
    ops: null,
    ignoredCommands: () => new Set(),
    ...overrides,
  };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// toil/repeated-sequence
// ---------------------------------------------------------------------------

function cmd(text, at, opts = {}) {
  return ev('terminal.command', {
    pty_id: opts.pty ?? 1,
    tab_id: null,
    sig: commandSig(text),
    argv0: opts.argv0 ?? text.trim().split(/\s+/)[0],
    by: opts.by ?? 'user',
    op: opts.op ?? null,
    exit_code: 0,
    started_at: new Date(at).toISOString(),
    duration_ms: opts.duration ?? 5000,
    cwd_rel: opts.cwd ?? null,
  }, { ts: at + (opts.duration ?? 5000) });
}

/** Run a list of commands `times` times, one session per repeat (sessions 1 h apart). */
function repeatSeq(rule, texts, times, opts = {}) {
  for (let r = 0; r < times; r++) {
    const start = NOW - (times - r) * HOUR - (opts.offset ?? 0);
    texts.forEach((t, i) => rule.ingest(cmd(t, start + i * 30_000, opts)));
  }
}

const texts = new Map();
function textCtx(extra = {}) {
  return baseCtx({ commandText: (_ws, sig) => texts.get(sig) ?? null, ...extra });
}
for (const t of ['npm run build', 'npm run test:unit', 'make flash-device', 'git status', 'ls -la', 'echo hi', 'git status -s']) texts.set(commandSig(t), t);

async function main() {
  await test('repeated-sequence fires at 3 repeats, not at 2', () => {
    const r = new RepeatedSequenceRule();
    repeatSeq(r, ['npm run build', 'npm run test:unit'], 2);
    assert.strictEqual(r.evaluate(textCtx()).length, 0);
    const r3 = new RepeatedSequenceRule();
    repeatSeq(r3, ['npm run build', 'npm run test:unit'], 3);
    const f = r3.evaluate(textCtx());
    assert.strictEqual(f.length, 1, JSON.stringify(f));
    assert.strictEqual(f[0].subject, [commandSig('npm run build'), commandSig('npm run test:unit')].join(','));
    assert.match(f[0].evidence[0], /^`npm run build && npm run test:unit` run by hand 3 times since \w+day$/);
    assert.strictEqual(f[0].evidence[1], 'No operation matches it');
    assert.strictEqual(f[0].item_ref, `cmdseq:${WS}:${f[0].subject}`);
    assert.deepStrictEqual(f[0].fixes.map((x) => x.id), ['make-operation', 'ignore-command']);
  });

  await test('repeated-sequence: a longer sequence suppresses its sub-sequences', () => {
    const r = new RepeatedSequenceRule();
    repeatSeq(r, ['npm run build', 'npm run test:unit', 'make flash-device'], 4);
    const f = r.evaluate(textCtx());
    assert.strictEqual(f.length, 1, JSON.stringify(f.map((x) => x.subject)));
    assert.strictEqual(f[0].subject.split(',').length, 3);
    // Extra solo runs of one of them, beyond the long sequence, still count on their own.
    const r2 = new RepeatedSequenceRule();
    repeatSeq(r2, ['npm run build', 'npm run test:unit', 'make flash-device'], 3);
    repeatSeq(r2, ['npm run build'], 3, { offset: 2 * DAY, pty: 2 });
    const f2 = r2.evaluate(textCtx()).map((x) => x.subject).sort();
    assert.deepStrictEqual(f2, [commandSig('npm run build'), [commandSig('npm run build'), commandSig('npm run test:unit'), commandSig('make flash-device')].join(',')].sort());
  });

  await test('repeated-sequence: the ignore list, min_chars, op-linked and Lee-typed runs are skipped', () => {
    const r = new RepeatedSequenceRule();
    repeatSeq(r, ['git status'], 5, { pty: 1 });
    repeatSeq(r, ['git status -s'], 5, { pty: 2 });
    repeatSeq(r, ['ls -la'], 5, { pty: 3 });
    repeatSeq(r, ['echo hi'], 5, { pty: 4 }); // shorter than min_chars (8)
    repeatSeq(r, ['npm run build'], 5, { pty: 5, op: 'build' });
    repeatSeq(r, ['make flash-device'], 5, { pty: 6, by: 'lee' });
    assert.deepStrictEqual(r.evaluate(textCtx()), []);
    // Without the text (after a restart) the ignore list still matches by sig and argv0;
    // length and prefix checks need the text, so those two count.
    assert.deepStrictEqual(r.evaluate(baseCtx()).map((x) => x.subject).sort(), [commandSig('echo hi'), commandSig('git status -s')].sort());
    // ignore_commands from config and the ignore-command fix's list
    const cfgRules = JSON.parse(JSON.stringify(COCKPIT_DEFAULTS.lint.rules));
    cfgRules['toil/repeated-sequence'].ignore_commands = ['echo', 'git status -s'];
    assert.deepStrictEqual(r.evaluate(baseCtx({ config: (rule) => cfgRules[rule] })), []);
    assert.deepStrictEqual(r.evaluate(baseCtx({ ignoredCommands: () => new Set([commandSig('echo hi'), commandSig('git status -s')]) })), []);
  });

  await test('repeated-sequence: gaps over 10 min break a sequence; old runs fall out of the window', () => {
    const r = new RepeatedSequenceRule();
    for (let i = 0; i < 3; i++) {
      const start = NOW - (i + 1) * HOUR;
      r.ingest(cmd('npm run build', start));
      r.ingest(cmd('npm run test:unit', start + 11 * MIN));
    }
    const subjects = r.evaluate(textCtx()).map((x) => x.subject).sort();
    assert.deepStrictEqual(subjects, [commandSig('npm run build'), commandSig('npm run test:unit')].sort());
    const old = new RepeatedSequenceRule();
    repeatSeq(old, ['npm run build'], 3, { offset: 7 * DAY });
    assert.deepStrictEqual(old.evaluate(textCtx()), []);
  });

  await test('repeated-sequence fixes: make-operation suggests to ops; unavailable without ops', async () => {
    const r = new RepeatedSequenceRule();
    repeatSeq(r, ['npm run build', 'npm run test:unit'], 3, { cwd: 'electron' });
    const [f] = r.evaluate(textCtx());
    const suggested = [];
    const ops = {
      snapshot: () => ({ operations: [{ def: { name: 'npm-run' } }], suggestions: [] }),
      suggest: (ws, def, from) => suggested.push({ ws, def, from }),
      setFlag: async () => true,
    };
    const res = await r.fix(f, 'make-operation', { ...textCtx({ ops }), launcher: null });
    assert.deepStrictEqual(res, { success: true, message: 'Added to Operations suggestions: confirm it there' });
    assert.strictEqual(suggested.length, 1);
    assert.deepStrictEqual(suggested[0].def, { name: 'npm-run-2', kind: 'oneshot', command: 'npm run build && npm run test:unit', cwd: 'electron' });
    assert.strictEqual(suggested[0].from, 'lint:toil/repeated-sequence');
    // after a restart the command text is gone (memory only): no bare-argv0 suggestion
    const gone = await r.fix(f, 'make-operation', { ...baseCtx({ ops }), launcher: null });
    assert.strictEqual(gone.success, false);
    assert.strictEqual(gone.error, 'text_unavailable');
    assert.strictEqual(suggested.length, 1);
    const un = await r.fix(f, 'make-operation', { ...textCtx(), launcher: null });
    assert.deepStrictEqual(un, { success: false, error: 'unavailable' });
  });

  // -------------------------------------------------------------------------
  // toil/flaky-operation
  // -------------------------------------------------------------------------

  function result(op, status, i, sig = 'inp1', ws = WS) {
    return ev('operation.result', { run_id: `run${i}`, op, status, exit_code: status === 'passed' ? 0 : 1, duration_ms: 1000, inputs_sig: sig, by: 'user', readings: [] }, { ts: NOW - (20 - i) * MIN, workspace: ws });
  }

  await test('flaky-operation fires at 2 flips with the same inputs, not at 1', () => {
    const one = new FlakyOperationRule();
    ['passed', 'passed', 'failed', 'failed'].forEach((s, i) => one.ingest(result('test', s, i)));
    assert.deepStrictEqual(one.evaluate(baseCtx()), []);
    const two = new FlakyOperationRule();
    ['passed', 'failed', 'passed', 'passed'].forEach((s, i) => two.ingest(result('test', s, i)));
    const f = two.evaluate(baseCtx());
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].evidence[0], '1 of the last 4 runs failed with no change to HEAD or the working tree');
    assert.strictEqual(f[0].evidence[1], 'inputs inp1');
    assert.strictEqual(f[0].item_ref, `op:${WS}:test`);
  });

  await test('flaky-operation: flips across different inputs_sig do not count', () => {
    const r = new FlakyOperationRule();
    [['passed', 'a'], ['failed', 'b'], ['passed', 'c'], ['failed', 'd']].forEach(([s, sig], i) => r.ingest(result('test', s, i, sig)));
    assert.deepStrictEqual(r.evaluate(baseCtx()), []);
  });

  await test('flaky-operation fix: create-task through the launcher, unavailable without it', async () => {
    const r = new FlakyOperationRule();
    ['failed', 'passed', 'failed'].forEach((s, i) => r.ingest(result('e2e', s, i)));
    const [f] = r.evaluate(baseCtx());
    const created = [];
    const launcher = { launch: async () => ({ success: false }), createTask: async (input) => { created.push(input); return { task_id: 'task-0000beef', relayed: true }; } };
    const res = await r.fix(f, 'create-task', { ...baseCtx(), launcher });
    assert.strictEqual(res.success, true);
    assert.strictEqual(created[0].title, 'Investigate flaky e2e');
    assert.strictEqual(created[0].kind, 'bug');
    assert.strictEqual(created[0].lead, 'delegate');
    assert.strictEqual(created[0].status, 'queued');
    assert.deepStrictEqual(created[0].origin, { kind: 'lint', ref: 'toil/flaky-operation' });
    assert.match(created[0].note, /Last failing run: run2/);
    assert.deepStrictEqual(await r.fix(f, 'create-task', { ...baseCtx(), launcher: null }), { success: false, error: 'unavailable' });
  });

  // -------------------------------------------------------------------------
  // toil/long-wait
  // -------------------------------------------------------------------------

  function waitRun(rule, i, opts = {}) {
    const start = NOW - (i + 1) * 5 * HOUR;
    const dur = (opts.minutes ?? 4) * MIN;
    rule.ingest(ev('operation.run', { run_id: `w${i}`, op: opts.op ?? 'build', kind: 'oneshot', by: opts.by ?? 'user', pty_id: 1, reused_tab: false, confirm_required: false, inputs_sig: 'x' }, { ts: start }));
    if (opts.away) rule.ingest(ev('presence.change', { from: { at_machine: true }, to: { at_machine: false }, reason: 'os_idle' }, { ts: start + MIN }));
    if (opts.keys) rule.ingest(ev('input.counts', { tab_id: 1, tab_type: 'editor', keys: opts.keys, clicks: 0, wheels: 0, span_ms: 60000 }, { ts: start + MIN }));
    rule.ingest(ev('operation.result', { run_id: `w${i}`, op: opts.op ?? 'build', status: 'passed', exit_code: 0, duration_ms: dur, inputs_sig: 'x', by: opts.by ?? 'user', readings: [] }, { ts: start + dur }));
  }

  await test('long-wait fires at 3 idle waits of 3+ min, not at 2', () => {
    const two = new LongWaitRule();
    waitRun(two, 0);
    waitRun(two, 1);
    waitRun(two, 2, { minutes: 2 }); // too short
    assert.deepStrictEqual(two.evaluate(baseCtx()), []);
    const three = new LongWaitRule();
    [0, 1, 2].forEach((i) => waitRun(three, i, { minutes: 3 + i }));
    const f = three.evaluate(baseCtx());
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].evidence[0], 'You waited on build 3 times this week (median 4 min)');
    assert.deepStrictEqual(f[0].fixes.map((x) => x.id), ['notify-when-done']);
  });

  await test('long-wait: leaving the machine, typing, or Hester-started runs do not count', () => {
    const r = new LongWaitRule();
    waitRun(r, 0);
    waitRun(r, 1);
    waitRun(r, 2, { away: true });
    waitRun(r, 3, { keys: 21 });
    waitRun(r, 4, { by: 'hester' });
    assert.deepStrictEqual(r.evaluate(baseCtx()), []);
    waitRun(r, 5, { keys: 20 });
    assert.strictEqual(r.evaluate(baseCtx()).length, 1);
  });

  await test('long-wait fix sets notify_on_done; skipped once the op already notifies', async () => {
    const r = new LongWaitRule();
    [0, 1, 2].forEach((i) => waitRun(r, i));
    const flags = [];
    let notifies = false;
    const ops = {
      snapshot: () => ({ operations: [{ def: { name: 'build', notify_on_done: notifies } }], suggestions: [] }),
      suggest: () => {},
      setFlag: async (ws, name, flag, value) => { flags.push([ws, name, flag, value]); return true; },
    };
    const [f] = r.evaluate(baseCtx({ ops }));
    const res = await r.fix(f, 'notify-when-done', { ...baseCtx({ ops }), launcher: null });
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(flags, [[WS, 'build', 'notify_on_done', true]]);
    notifies = true;
    assert.deepStrictEqual(r.evaluate(baseCtx({ ops })), []);
  });

  // -------------------------------------------------------------------------
  // toil/repeat-approval
  // -------------------------------------------------------------------------

  function approve(rule, sig, i, opts = {}) {
    const where = opts.ws ? { workspace: opts.ws } : {};
    rule.ingest(ev('agent.tool', { session_id: 's', phase: 'pre', tool: opts.tool ?? 'Bash', files: [], writes: false, signature: sig }, { ts: NOW - (100 - i) * MIN, ...where }));
    rule.ingest(ev('attention.reply', { item_id: `i${i}`, kind: 'approval', action: opts.action ?? 'approve', text_chars: 0, tool_signature: sig, latency_ms: opts.latency ?? 30_000 }, { ts: NOW - (100 - i) * MIN + 1000, ...where }));
  }
  const learned = new Map([['sigA', { tool: 'Bash', preview: 'npm run build --watch' }], ['sigL', { tool: 'Bash', preview: 'ls -la /tmp' }]]);
  const learnedCtx = (extra = {}) => baseCtx({ toolInfo: (s) => learned.get(s) ?? null, ...extra });

  await test('permission rules: two words, the whole command after a flag, never interpreter- or rm-wide; others the bare name', () => {
    assert.strictEqual(permissionRule('Bash', 'npm run build --watch'), 'Bash(npm run:*)');
    assert.strictEqual(permissionRule('Bash', 'ls -la /tmp'), 'Bash(ls -la /tmp:*)');
    assert.strictEqual(permissionRule('Bash', 'rm -rf build'), 'Bash(rm -rf build:*)');
    assert.strictEqual(permissionRule('Bash', 'rm build'), 'Bash(rm build:*)');
    assert.strictEqual(permissionRule('Bash', 'python -m pytest'), 'Bash(python -m pytest:*)');
    assert.strictEqual(permissionRule('Bash', 'python -c "import os"'), null);
    assert.strictEqual(permissionRule('Bash', 'bash -c make'), null);
    assert.strictEqual(permissionRule('Bash', 'sh'), null);
    assert.strictEqual(permissionRule('Bash', 'uv run pytest'), 'Bash(uv run pytest:*)');
    assert.strictEqual(permissionRule('Bash', 'npx vitest'), 'Bash(npx vitest:*)');
    assert.strictEqual(permissionRule('Bash', null), null);
    assert.strictEqual(permissionRule('Edit', null), 'Edit');
  });

  await test('repeat-approval (a) fires at 10 approvals of one call, not at 9', () => {
    const nine = new RepeatApprovalRule();
    for (let i = 0; i < 9; i++) approve(nine, 'sigA', i);
    assert.deepStrictEqual(nine.evaluate(learnedCtx()), []);
    const ten = new RepeatApprovalRule();
    for (let i = 0; i < 10; i++) approve(ten, 'sigA', i);
    const f = ten.evaluate(learnedCtx());
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].evidence[0], 'Approved `Bash: npm run build --watch` 10 times this week');
    assert.strictEqual(f[0].item_ref, `approval:${WS}:sigA`);
    assert.strictEqual(f[0].fixes[0].confirm_text, `Add Bash(npm run:*) to permissions.allow in ${WS}/.claude/settings.local.json`);
  });

  await test('repeat-approval (a) without a learned preview is not emitted', () => {
    const r = new RepeatApprovalRule();
    for (let i = 0; i < 12; i++) approve(r, 'sigUnknown', i);
    assert.deepStrictEqual(r.evaluate(learnedCtx()), []);
  });

  await test('repeat-approval (b) fires at 10 fast approvals in a row, not at 9', () => {
    const nine = new RepeatApprovalRule();
    for (let i = 0; i < 9; i++) approve(nine, i % 2 ? 'sigA' : 'sigL', i, { latency: 500 });
    approve(nine, 'sigA', 9, { latency: 5000 });
    for (let i = 10; i < 19; i++) approve(nine, 'sigL', i, { latency: 500 });
    assert.deepStrictEqual(nine.evaluate(learnedCtx()).filter((f) => f.subject === 'streak'), []);
    const ten = new RepeatApprovalRule();
    for (let i = 0; i < 10; i++) approve(ten, i < 6 ? 'sigA' : i < 9 ? 'sigL' : 'sigE', i, { latency: 500, tool: i === 9 ? 'Edit' : 'Bash' });
    const f = ten.evaluate(learnedCtx());
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].subject, 'streak');
    assert.strictEqual(f[0].evidence[0], '10 approvals in a row, each in under 2 s');
    assert.strictEqual(f[0].fixes[0].confirm_text, `Add Bash(npm run:*), Bash(ls -la /tmp:*), Edit to permissions.allow in ${WS}/.claude/settings.local.json`);
  });

  await test('repeat-approval fix writes the exact rules to settings.local.json', async () => {
    const ws = mkWorkspace('allow');
    const r = new RepeatApprovalRule();
    for (let i = 0; i < 10; i++) approve(r, 'sigA', i, { latency: 30_000, ws });
    const [f] = r.evaluate(learnedCtx());
    assert.strictEqual(f.workspace, ws);
    // A finding whose confirm_text no longer matches what would be written is refused (C3).
    const edited = { ...f, fixes: f.fixes.map((x) => ({ ...x, confirm_text: `Add Bash(rm:*) to permissions.allow in ${ws}/.claude/settings.local.json` })) };
    assert.strictEqual((await r.fix(edited, 'allow-in-project', { ...learnedCtx(), launcher: null, writeClaudeAllow })).error, 'unavailable');
    // So is a finding from an earlier evaluation (another state_key).
    assert.strictEqual((await r.fix({ ...f, state_key: 'old' }, 'allow-in-project', { ...learnedCtx(), launcher: null, writeClaudeAllow })).error, 'unavailable');
    const res = await r.fix(f, 'allow-in-project', { ...learnedCtx(), launcher: null, writeClaudeAllow });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    const doc = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepStrictEqual(doc, { permissions: { allow: ['Bash(npm run:*)'] } });
  });

  // -------------------------------------------------------------------------
  // settings.local.json merge
  // -------------------------------------------------------------------------

  await test('settings.local.json: missing file, existing rules kept, invalid JSON refused', async () => {
    const ws = mkWorkspace('settings');
    const file = path.join(ws, '.claude', 'settings.local.json');
    assert.deepStrictEqual(await writeClaudeAllow(ws, ['Bash(npm test:*)']), ['Bash(npm test:*)']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(npm test:*)'] } });

    fs.writeFileSync(file, JSON.stringify({ model: 'x', permissions: { allow: ['Read', 'Bash(npm test:*)'], deny: ['WebFetch'] } }));
    fs.chmodSync(file, 0o600);
    assert.deepStrictEqual(await writeClaudeAllow(ws, ['Bash(npm test:*)', 'Edit', 'Edit']), ['Edit']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'x', permissions: { allow: ['Read', 'Bash(npm test:*)', 'Edit'], deny: ['WebFetch'] } });
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

    fs.writeFileSync(file, '{ "permissions": ');
    await assert.rejects(writeClaudeAllow(ws, ['Edit']), /settings\.local\.json isn't valid JSON; not changed/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "permissions": ');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['settings.local.json']);
  });

  // -------------------------------------------------------------------------
  // Nudge budget
  // -------------------------------------------------------------------------

  await test('nudge budget: same_state, overridden, focus and rate', () => {
    let t = NOW;
    const b = new NudgeBudget({ perHour: 2, now: () => t });
    const req = (ref, key) => ({ item_ref: ref, state_key: key, source: 'lint', workspace: WS });
    assert.deepStrictEqual(b.claim(req('a', '1'), true), { granted: false, reason: 'focus' });
    assert.deepStrictEqual(b.claim(req('a', '1'), false), { granted: true, reason: null });
    assert.deepStrictEqual(b.claim(req('a', '1'), false), { granted: false, reason: 'same_state' });
    b.override('a', '1');
    assert.deepStrictEqual(b.claim(req('a', '1'), false), { granted: false, reason: 'overridden' });
    assert.deepStrictEqual(b.claim(req('b', '1'), false), { granted: true, reason: null });
    assert.deepStrictEqual(b.claim(req('c', '1'), false), { granted: false, reason: 'rate' });
    t += HOUR;
    assert.deepStrictEqual(b.claim(req('c', '1'), false), { granted: true, reason: null });
  });

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  function makeEngine(opts = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-lint-store-'));
    const ws = mkWorkspace('engine');
    const store = new LintStore({ home });
    const logged = [];
    const feed = [];
    const ceremonies = [];
    const env = { now: opts.now ?? NOW, focus: false, branch: 'main' };
    const budget = new NudgeBudget({ perHour: opts.perHour ?? 6, now: () => env.now });
    const rules = JSON.parse(JSON.stringify(COCKPIT_DEFAULTS.lint.rules));
    const fake = { findings: [], id: 'fake/rule', family: 'toil', consumes: ['x.fake'], ingest() {}, evaluate: () => fake.findings, fix: async (f, id) => (id === 'fail' ? { success: false, error: 'unavailable' } : { success: true, message: `did ${id}` }) };
    rules['fake/rule'] = { severity: opts.severity ?? 'warn' };
    const engine = new LintEngine({
      rules: [fake],
      store,
      providers: { commandText: () => null, toolInfo: () => null, ops: () => null, launcher: () => null, writeClaudeAllow: async () => {} },
      config: (rule) => rules[rule] ?? { severity: 'off' },
      demotion: () => ({ ...COCKPIT_DEFAULTS.lint.demotion }),
      log: (type, workspace, data) => logged.push({ type, workspace, data }),
      ceremony: (workspace, target) => ceremonies.push(target),
      claimNudge: (req) => budget.claim(req, env.focus),
      overrideNudge: (ref, key) => budget.override(ref, key),
      feedPost: (d) => feed.push(['post', d.id, d.severity]),
      feedClose: (id, state) => feed.push(['close', id, state]),
      branch: () => env.branch,
      now: () => env.now,
    });
    const finding = (subject, state_key = 's1', extra = {}) => ({
      rule: 'fake/rule',
      workspace: ws,
      subject,
      message: `m ${subject}`,
      evidence: ['e'],
      fixes: [{ id: 'go', label: 'Go', confirm_text: 'exactly this' }, { id: 'fail', label: 'Fail' }],
      item_ref: null,
      state_key,
      ...extra,
    });
    return { engine, store, logged, feed, ceremonies, env, fake, finding, budget, rules, ws };
  }
  const types = (logged) => logged.map((l) => l.type);

  await test('engine: new -> lint.open and a nudge; update; resolve without being shown -> no outcome', () => {
    const t = makeEngine();
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    assert.match(id, /^lint_[0-9a-f]{12}$/);
    assert.deepStrictEqual(types(t.logged), ['lint.open']);
    assert.deepStrictEqual(t.feed, [['post', id, 'warn']]);
    let snap = t.engine.snapshot(t.ws);
    assert.strictEqual(snap.diagnostics.length, 1);
    assert.deepStrictEqual(snap.counts, { info: 0, warn: 1, needs_you: 0 });
    t.fake.findings = [{ ...t.finding('one'), evidence: ['e2'] }];
    t.engine.evaluate();
    assert.deepStrictEqual(t.engine.snapshot(t.ws).diagnostics[0].evidence, ['e2']);
    assert.deepStrictEqual(types(t.logged), ['lint.open']);
    t.fake.findings = [];
    t.engine.evaluate();
    assert.deepStrictEqual(types(t.logged), ['lint.open']);
    assert.deepStrictEqual(t.feed[t.feed.length - 1], ['close', id, 'done']);
    snap = t.engine.snapshot(t.ws);
    assert.strictEqual(snap.diagnostics.length, 0);
  });

  await test('engine: resolve after being shown -> ignored; shown logged once per state', () => {
    const t = makeEngine();
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    t.engine.shown([id, id], 'status');
    t.engine.shown([id], 'feed');
    assert.deepStrictEqual(types(t.logged), ['lint.open', 'lint.shown']);
    t.fake.findings = [];
    t.engine.evaluate();
    const out = t.logged.find((l) => l.type === 'lint.outcome');
    assert.deepStrictEqual(out.data, { diag_id: id, rule: 'fake/rule', outcome: 'ignored' });
    assert.strictEqual(t.store.outcomes(t.ws)[0].outcome, 'ignored');
  });

  await test('engine: shown and untouched for 7 days -> ignored once, still listed', () => {
    const t = makeEngine();
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    t.engine.shown([id], 'status');
    t.env.now += 7 * DAY;
    t.engine.evaluate();
    t.engine.evaluate();
    assert.strictEqual(t.logged.filter((l) => l.type === 'lint.outcome').length, 1);
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 1);
  });

  await test('engine: focus denies the nudge and it is retried; flyout-only shown reports are ignored', () => {
    const t = makeEngine();
    t.env.focus = true;
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    assert.deepStrictEqual(t.engine.snapshot(t.ws).counts, { info: 0, warn: 0, needs_you: 0 });
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 1);
    t.engine.shown([id], 'status');
    assert.ok(!types(t.logged).includes('lint.shown'));
    t.env.focus = false;
    t.engine.evaluate();
    assert.deepStrictEqual(t.engine.snapshot(t.ws).counts.warn, 1);
  });

  await test('engine: rate-limited nudges wait; same_state stays quiet until the state changes', () => {
    const t = makeEngine({ perHour: 1 });
    t.fake.findings = [t.finding('one'), t.finding('two')];
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).counts.warn, 1);
    t.env.now += HOUR;
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).counts.warn, 2);
    // A fresh engine (e.g. after a restart) sharing the budget: same_state -> quiet.
    const other = makeEngine();
    other.budget.claim({ item_ref: `lint:${other.ws}:fake/rule:one`, state_key: 's1', source: 'lint' }, false);
    const e2 = new LintEngine({ ...other.engine.deps });
    other.fake.findings = [other.finding('one')];
    e2.evaluate();
    assert.strictEqual(e2.snapshot(other.ws).counts.warn, 0);
    other.fake.findings = [other.finding('one', 's2')];
    e2.evaluate();
    assert.strictEqual(e2.snapshot(other.ws).counts.warn, 1);
  });

  await test('engine: fix -> fixed, closed until the state changes; failures keep it open', async () => {
    const t = makeEngine();
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    assert.deepStrictEqual(await t.engine.fix(id, 'fail'), { success: false, error: 'unavailable' });
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 1);
    assert.deepStrictEqual(await t.engine.fix(id, 'nope'), { success: false, error: 'unknown_fix' });
    assert.deepStrictEqual(await t.engine.fix(id, 'go'), { success: true, message: 'did go' });
    const out = t.logged.filter((l) => l.type === 'lint.outcome').map((l) => l.data);
    assert.deepStrictEqual(out, [{ diag_id: id, rule: 'fake/rule', outcome: 'fixed', fix_id: 'go' }]);
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 0);
    // Persisted: a new engine over the same store stays closed at that state.
    const e2 = new LintEngine({ ...t.engine.deps });
    e2.evaluate();
    assert.strictEqual(e2.snapshot(t.ws).diagnostics.length, 0);
    t.fake.findings = [t.finding('one', 's2')];
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 1);
  });

  await test('engine: dismiss -> dismissed + ceremony + nudge override, back only when facts change', () => {
    const t = makeEngine();
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    assert.deepStrictEqual(t.engine.dismiss(id), { success: true });
    assert.deepStrictEqual(t.ceremonies, ['lint-dismiss']);
    assert.deepStrictEqual(t.feed[t.feed.length - 1], ['close', id, 'dismissed']);
    assert.strictEqual(t.budget.claim({ item_ref: `lint:${t.ws}:fake/rule:one`, state_key: 's1', source: 'lint' }, false).reason, 'overridden');
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 0);
    t.fake.findings = [t.finding('one', 's2')];
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).counts.warn, 1);
    // From the Feed's own Dismiss: no second ceremony line.
    assert.deepStrictEqual(t.engine.dismiss(id, { fromFeed: true }), { success: true });
    assert.deepStrictEqual(t.ceremonies, ['lint-dismiss']);
  });

  await test('engine: suppress item / branch / workspace (and un-ignore)', () => {
    const t = makeEngine();
    const id = diagIdFor('fake/rule', t.ws, 'one');
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    t.engine.suppress(id, 'item');
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 0);
    t.fake.findings = [t.finding('one', 's2')];
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 1);

    t.engine.suppress(id, 'branch');
    t.fake.findings = [t.finding('one', 's3')];
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 0);
    t.env.branch = 'feature';
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics.length, 1);

    t.engine.suppress(id, 'workspace');
    t.fake.findings = [t.finding('one', 's4')];
    t.engine.evaluate();
    let snap = t.engine.snapshot(t.ws);
    assert.deepStrictEqual(snap.diagnostics.map((d) => d.severity), ['off']);
    assert.deepStrictEqual(snap.counts, { info: 0, warn: 0, needs_you: 0 });
    assert.deepStrictEqual(t.ceremonies, ['lint-suppress', 'lint-suppress', 'lint-suppress']);
    const outcomes = t.logged.filter((l) => l.type === 'lint.outcome').map((l) => l.data.outcome);
    assert.deepStrictEqual(outcomes, ['suppressed', 'suppressed', 'suppressed']);
    assert.deepStrictEqual(t.engine.suppress(id, 'workspace'), { success: true });
    t.engine.evaluate();
    snap = t.engine.snapshot(t.ws);
    assert.deepStrictEqual(snap.diagnostics.map((d) => d.severity), ['warn']);
    const file = JSON.parse(fs.readFileSync(path.join(t.ws, '.hester', 'lint', 'suppressions.json'), 'utf8'));
    assert.deepStrictEqual(file.items.map((e) => e.scope).sort(), ['branch', 'item']);
  });

  await test('engine: severity off and info; machine-wide diagnostics show in every workspace', () => {
    const off = makeEngine({ severity: 'off' });
    off.fake.findings = [off.finding('one')];
    off.engine.evaluate();
    assert.strictEqual(off.engine.snapshot(off.ws).diagnostics.length, 0);
    const info = makeEngine({ severity: 'info' });
    info.fake.findings = [info.finding('one'), { ...info.finding('two'), workspace: null }];
    info.engine.evaluate();
    assert.deepStrictEqual(info.engine.snapshot(info.ws).counts, { info: 2, warn: 0, needs_you: 0 });
    assert.strictEqual(info.engine.snapshot('/elsewhere').diagnostics.length, 1);
    assert.strictEqual(info.engine.snapshot(null).diagnostics.length, 1);
  });

  await test('demotion: 10 outcomes at 0.8 drop one level; 9, or 0.7, do not; info flags for rework; recovery', () => {
    const run = (n, bad, severity = 'warn') => {
      const t = makeEngine({ severity });
      for (let i = 0; i < n; i++) {
        t.store.appendOutcome(t.ws, { ts: new Date(NOW - DAY + i).toISOString(), diag_id: `d${i}`, rule: 'fake/rule', subject: `s${i}`, outcome: i < bad ? 'dismissed' : 'fixed' });
      }
      t.engine.recomputeDemotions(t.ws, true);
      return t;
    };
    const below = run(9, 9);
    assert.strictEqual(below.engine.snapshot(below.ws).rules[0].demoted, false);
    const mild = run(10, 7);
    assert.strictEqual(mild.engine.snapshot(mild.ws).rules[0].demoted, false);
    const t = run(10, 8);
    const rs = t.engine.snapshot(t.ws).rules[0];
    assert.deepStrictEqual([rs.severity, rs.base_severity, rs.demoted, rs.flagged_for_rework], ['info', 'warn', true, false]);
    assert.deepStrictEqual(rs.outcomes_30d, { fixed: 2, dismissed: 8, ignored: 0, suppressed: 0 });
    const demoteLog = t.logged.find((l) => l.type === 'lint.demote');
    assert.deepStrictEqual(demoteLog.data, { rule: 'fake/rule', from: 'warn', to: 'info', ratio: 0.8, n: 10 });
    assert.ok(fs.existsSync(path.join(t.ws, '.hester', 'lint', 'rules.json')));
    // Not recomputed within a day unless forced.
    t.engine.recomputeDemotions(t.ws);
    assert.strictEqual(t.logged.filter((l) => l.type === 'lint.demote').length, 1);
    // A diagnostic takes the demoted severity.
    t.fake.findings = [t.finding('one')];
    t.engine.evaluate();
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics[0].severity, 'info');
    assert.strictEqual(t.engine.snapshot(t.ws).diagnostics[0].demoted, true);

    const i = run(10, 10, 'info');
    const ri = i.engine.snapshot(i.ws).rules[0];
    assert.deepStrictEqual([ri.severity, ri.flagged_for_rework], ['info', true]);

    // Recovery: 10 more outcomes after the demotion, mostly fixed.
    t.env.now += 2 * DAY;
    for (let k = 0; k < 10; k++) {
      t.store.appendOutcome(t.ws, { ts: new Date(t.env.now - HOUR + k).toISOString(), diag_id: `r${k}`, rule: 'fake/rule', subject: `r${k}`, outcome: k < 4 ? 'ignored' : 'fixed' });
    }
    t.engine.recomputeDemotions(t.ws, true);
    assert.strictEqual(t.engine.snapshot(t.ws).rules[0].severity, 'warn');
    assert.strictEqual(demote('needs-you', 1), 'warn');
    assert.strictEqual(demote('info', 3), 'info');
  });

  // -------------------------------------------------------------------------
  // Real rules through the engine
  // -------------------------------------------------------------------------

  await test('engine with the real rules: repeat-approval appears once the preview is learned', () => {
    const t = makeEngine();
    const learnedTools = new Map();
    const store = new LintStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'lee-lint-store-')) });
    const rules = [new RepeatedSequenceRule(), new FlakyOperationRule(), new LongWaitRule(), new RepeatApprovalRule()];
    const engine = new LintEngine({
      ...t.engine.deps,
      rules,
      store,
      config: (rule) => COCKPIT_DEFAULTS.lint.rules[rule] ?? { severity: 'off' },
      providers: { ...t.engine.deps.providers, toolInfo: (s) => learnedTools.get(s) ?? null },
    });
    for (let i = 0; i < 10; i++) {
      engine.ingest(ev('agent.tool', { session_id: 's', phase: 'pre', tool: 'Bash', files: [], writes: false, signature: 'sigZ' }, { ts: NOW - (50 - i) * MIN }));
      engine.ingest(ev('attention.reply', { item_id: `z${i}`, kind: 'approval', action: 'approve', text_chars: 0, tool_signature: 'sigZ', latency_ms: 9000 }, { ts: NOW - (50 - i) * MIN }));
    }
    assert.strictEqual(engine.ingest(ev('app.start', {})), false);
    engine.evaluate();
    assert.strictEqual(engine.snapshot(WS).diagnostics.length, 0);
    learnedTools.set('sigZ', { tool: 'Bash', preview: 'pytest -q tests' });
    engine.evaluate();
    const snap = engine.snapshot(WS);
    assert.strictEqual(snap.diagnostics.length, 1);
    assert.strictEqual(snap.diagnostics[0].rule, 'toil/repeat-approval');
    assert.strictEqual(snap.diagnostics[0].fixes[0].confirm_text, `Add Bash(pytest -q tests:*) to permissions.allow in ${WS}/.claude/settings.local.json`);
    assert.deepStrictEqual(snap.rules.map((r) => r.rule), ['toil/repeated-sequence', 'toil/flaky-operation', 'toil/long-wait', 'toil/repeat-approval']);
  });

  // -------------------------------------------------------------------------
  // lint-main: history scan, IPC, feed producer, nudge persistence
  // -------------------------------------------------------------------------

  await test('event-scan picks the last 8 days of event files, oldest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-lint-events-'));
    for (const n of ['2026-09-10.jsonl', '2026-09-20.jsonl', '2026-09-20.1.jsonl', '2026-09-24.jsonl', 'junk.txt']) fs.writeFileSync(path.join(dir, n), '');
    assert.deepStrictEqual(eventFiles(dir, 8, NOW).map((f) => path.basename(f)), ['2026-09-20.jsonl', '2026-09-20.1.jsonl', '2026-09-24.jsonl']);
  });

  await test('lint-main: scans history, serves IPC, posts to the Feed, persists nudges', async () => {
    const { COCKPIT_IPC } = require(path.join(__dirname, '..', 'dist', 'shared', 'cockpit.js'));
    const eventsDir = path.join(tmpHome, '.lee', 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const now = Date.now();
    const lines = [];
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (let i = 0; i < 3; i++) {
      const start = now - (i + 1) * HOUR;
      ['npm run build', 'npm run test:unit'].forEach((t, k) => {
        const e = cmd(t, start + k * 30_000);
        e.ts = new Date(start + k * 30_000 + 5000).toISOString();
        e.data.started_at = new Date(start + k * 30_000).toISOString();
        lines.push(JSON.stringify(e));
      });
    }
    lines.push('{"type":"terminal.command", broken');
    lines.push(JSON.stringify(ev('app.start', {}, { ts: now - HOUR })));
    fs.writeFileSync(path.join(eventsDir, `${day(new Date(now))}.jsonl`), `${lines.join('\n')}\n`);

    const { initCockpitLint, shutdownCockpitLint } = require(path.join(dist, 'lint-main.js'));
    initCockpitLint();
    assert.ok(ipcHandlers.has(COCKPIT_IPC.lintList));
    assert.ok(ipcListeners.has(COCKPIT_IPC.lintShown));
    const list = () => ipcHandlers.get(COCKPIT_IPC.lintList)({ sender: {} }, WS);
    for (let i = 0; i < 50 && list().diagnostics.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const snap = list();
    assert.strictEqual(snap.diagnostics.length, 1, JSON.stringify(snap));
    const d = snap.diagnostics[0];
    assert.strictEqual(d.rule, 'toil/repeated-sequence');
    assert.strictEqual(snap.counts.warn, 1);
    // Without A's tab runtime the text is gone: argv0 fallback in the evidence.
    assert.match(d.evidence[0], /^`npm && npm` run by hand 3 times/);

    const entries = cockpitBus.feed.list(WS).filter((e) => e.producer === 'lint');
    assert.strictEqual(entries.length, 1);
    assert.deepStrictEqual(entries[0].actions.map((a) => a.id), ['make-operation', 'ignore-command', 'suppress-item']);
    assert.strictEqual(entries[0].severity, 'needs-you');

    // Fix through the Feed without B's ops provider: unavailable, stays open.
    const r1 = await cockpitBus.actOnFeed(entries[0].id, 'make-operation', {}, { kind: 'local-user' });
    assert.strictEqual(r1.success, false);
    assert.strictEqual(r1.error, 'unavailable');
    assert.strictEqual(list().diagnostics.length, 1);
    // Hester (shared) can't act on lint entries.
    assert.strictEqual((await cockpitBus.actOnFeed(entries[0].id, 'ignore-command', {}, { kind: 'shared', loopback: true, ip: '127.0.0.1' })).error, 'forbidden');

    // Learning a tool preview is memory only; shown is logged via IPC.
    ipcListeners.get(COCKPIT_IPC.lintShown)({}, { diag_ids: [d.id], surface: 'status' });
    assert.strictEqual(list().diagnostics[0].shown, true);

    // The Feed's built-in Dismiss records a lint dismissal.
    await cockpitBus.actOnFeed(entries[0].id, 'dismiss', {}, { kind: 'local-user' });
    assert.strictEqual(list().diagnostics.length, 0);
    const outcomes = fs.readFileSync(path.join(WS, '.hester', 'lint', 'outcomes.jsonl'), 'utf8');
    assert.match(outcomes, /"outcome":"dismissed"/);
    assert.doesNotMatch(outcomes, /npm run/);

    shutdownCockpitLint();
    assert.ok(!ipcHandlers.has(COCKPIT_IPC.lintList));
    const nudges = JSON.parse(fs.readFileSync(path.join(tmpHome, '.lee', 'cockpit', 'nudges.json'), 'utf8'));
    assert.ok(nudges.records.some((r) => r.item_ref.startsWith('cmdseq:')));
    assert.strictEqual(fs.statSync(path.join(tmpHome, '.lee', 'cockpit', 'nudges.json')).mode & 0o777, 0o600);
  });

  console.log(`\n${passed} passed`);
}

main()
  .then(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
