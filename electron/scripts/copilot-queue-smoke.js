#!/usr/bin/env node
/**
 * Smoke test for the Copilot queue's hook -> approval lifecycle, the handoff
 * launch argv and the hook script. No Electron, no ports, no real Claude.
 *
 *   cd electron && npm run build:main && node scripts/copilot-queue-smoke.js
 *
 * `electron` is stubbed, and HOME points at a temp dir so nothing under the
 * real ~/.lee is read or written.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-copilot-smoke-'));
process.env.HOME = tmpHome;

const sent = [];
const electronStub = {
  app: { on() {}, getPath: () => tmpHome, isPackaged: false },
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const dist = path.join(__dirname, '..', 'dist', 'main');
const { CopilotQueue } = require(path.join(dist, 'copilot', 'queue.js'));
const { withClaudeHooks, HOOK_SCRIPT } = require(path.join(dist, 'copilot', 'hook-install.js'));
const { HOOK_EVENTS } = require(path.join(dist, 'copilot', 'hook-payload.js'));

class FakePty {
  constructor() {
    this.procs = new Map();
    this.writes = [];
    this.listeners = {};
  }
  add(id, { claude = true, name = 'Claude' } = {}) {
    this.procs.set(id, { id, name, windowId: null, claude });
  }
  get(id) {
    return this.procs.get(id);
  }
  write(id, data) {
    this.writes.push([id, data]);
  }
  isClaudePty(id) {
    return this.procs.get(id)?.claude === true;
  }
  isWarmPty(id) {
    return !!this.procs.get(id)?.name.endsWith(' (warm)');
  }
  log() {}
  on(ev, fn) {
    this.listeners[ev] = fn;
  }
}

function setup() {
  const pty = new FakePty();
  pty.add(1);
  const q = new CopilotQueue(pty);
  const hook = (event, body = {}, ptyId = '1') =>
    q.handleHook({ event, ptyId, windowId: null }, { session_id: 's1', hook_event_name: event, ...body });
  const live = (kind) => q.snapshot({ all: false }).items.filter((i) => (i.state === 'open' || i.state === 'snoozed') && (!kind || i.kind === kind));
  return { pty, q, hook, live };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('in-tab approval makes a device approve/deny stale (no key written)', () => {
  const { pty, q, hook, live } = setup();
  hook('SessionStart');
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'a' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'a' });
  const [item] = live('approval');
  assert.ok(item, 'approval opened');
  q.onUserInput(1, '\r'); // the person pressed Enter in the tab
  assert.strictEqual(live('approval').length, 0, 'answered in tab');
  const r = q.reply(item.id, { action: 'deny', version: item.version }, { kind: 'user', surface: 'device' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(pty.writes.length, 0, 'no Esc written into the running tool');
});

test('approve while paused on the prompt writes Enter', () => {
  const { pty, q, hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' });
  const [item] = live('approval');
  const r = q.reply(item.id, { action: 'approve', version: item.version }, { kind: 'user', surface: 'device' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(pty.writes.map((w) => w[1]).join(''), '\r');
});

test('approval with no pause state is stale (409), even if still open', () => {
  const { pty, q, hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' });
  const [item] = live('approval');
  q.sessions.get('s1').awaiting_approval = false;
  const r = q.reply(item.id, { action: 'approve', version: item.version }, { kind: 'user', surface: 'device' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(pty.writes.length, 0);
});

test('PostToolUseFailure resolves the approval', () => {
  const { hook, live } = setup();
  assert.ok(HOOK_EVENTS.includes('PostToolUseFailure'));
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 'a' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 'a' });
  hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 'a' });
  assert.strictEqual(live('approval').length, 0);
});

test('idle_prompt after an Esc deny resolves the approval', () => {
  const { hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x' }, tool_use_id: 'a' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' }, tool_use_id: 'a' });
  hook('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.strictEqual(live('approval').length, 0);
});

test('parallel call to the same tool does not clear a prompt that is still showing', () => {
  const { hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a', agent_id: 'A' });
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'b', agent_id: 'B' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'b', agent_id: 'B' });
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a', agent_id: 'A' });
  assert.strictEqual(live('approval').length, 1, 'B still waiting');
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'b', agent_id: 'B' });
  assert.strictEqual(live('approval').length, 0);
});

test('lee-status block at the end of a long message is parsed', () => {
  const { hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  const msg = 'x'.repeat(3000) + '\n\n```lee-status\nstatus: blocked\nblockers: need API key\n```';
  hook('Stop', { last_assistant_message: msg });
  const [blocker] = live('blocker');
  assert.ok(blocker, 'blocker opened');
  assert.match(blocker.text, /need API key/);
});

test('idle agent takes a handoff follow-up once its idle item is dismissed', () => {
  const { pty, q, hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('Stop', { last_assistant_message: 'done' });
  hook('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  for (const i of live()) q.dismiss(i.id, { kind: 'user', surface: 'lee' });
  const r = q.handoffStart({ followups: [{ pty_id: 1, text: 'next: add tests' }] }, { kind: 'user', surface: 'lee' });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.body.error, `not skipped: ${r.body.error}`);
  assert.ok(pty.writes.length > 0, 'follow-up written');
  q.endHandoff('manual');
});

test('idle_prompt after a finished turn opens nothing unless Claude asked a question', () => {
  const { hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('Stop', { last_assistant_message: 'All tests pass.' });
  hook('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.strictEqual(live('waiting').length, 0, 'finished turn stays a review item');
  assert.strictEqual(live('review').length, 1);

  hook('UserPromptSubmit', { prompt: 'y' });
  hook('Stop', { last_assistant_message: 'Should I also update the docs?\n\n```lee-status\nstatus: in-progress\n```' });
  hook('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.strictEqual(live('waiting').length, 1, 'a question needs you');
});

test('text reply to an item that moved on still reaches an idle agent, but not a busy one', () => {
  const { pty, q, hook, live } = setup();
  const user = { kind: 'user', surface: 'lee' };
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('Stop', { last_assistant_message: 'done' });
  const [review] = live('review');
  q.dismiss(review.id, user); // e.g. resolved when the tab was focused on the Mac
  const ok = q.reply(review.id, { action: 'text', text: 'next: add tests', version: review.version }, user);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(pty.writes.some(([, d]) => d.includes('next: add tests')), 'text pasted into the agent');

  hook('UserPromptSubmit', { prompt: 'y' }); // agent busy again
  const busy = q.reply(review.id, { action: 'text', text: 'late', version: review.version }, user);
  assert.strictEqual(busy.status, 409, 'never typed into a running turn');
});

test('X-Lee-Pty-Id for a non-Claude PTY is ignored', () => {
  const { pty, q, live } = setup();
  pty.add(7, { claude: false, name: 'Terminal' });
  q.handleHook({ event: 'Notification', ptyId: '7', windowId: null }, { session_id: 'evil', message: 'Which branch?' });
  for (const i of live()) assert.notStrictEqual(i.source.pty_id, 7);
});

test('hidden prewarmed Claude opens no items', () => {
  const { pty, q, live } = setup();
  pty.add(9, { name: 'Claude (warm)' });
  q.handleHook({ event: 'SessionStart', ptyId: '9', windowId: null }, { session_id: 'warm' });
  q.handleHook({ event: 'Notification', ptyId: '9', windowId: null }, { session_id: 'warm', message: 'waiting' });
  assert.strictEqual(live().filter((i) => i.source.pty_id === 9).length, 0);
});

test('withClaudeHooks prepends --settings before a -- prompt', () => {
  const dir = path.join(tmpHome, '.lee', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-settings.json'), '{}');
  const args = withClaudeHooks('claude', ['-n', 't', '--', '--settings']);
  assert.strictEqual(args[0], '--settings');
  assert.deepStrictEqual(args.slice(-2), ['--', '--settings']);
});

test('hook script: loopback-only URL, and no error body on SessionStart', () => {
  const bin = fs.mkdtempSync(path.join(tmpHome, 'bin-'));
  const log = path.join(bin, 'args');
  // A curl that records its argv and fails like `curl -f` on a 401.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\ncat >/dev/null\nprintf '{"success":false}'\nexit 22\n`,
    { mode: 0o755 },
  );
  const script = path.join(bin, 'hook.sh');
  fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o755 });
  fs.mkdirSync(path.join(tmpHome, '.lee', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.lee', 'hooks', 'auth-header'), 'Authorization: Bearer x\n');
  const run = (url) =>
    execFileSync('/bin/sh', [script, 'SessionStart'], {
      input: '{}',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmpHome, LEE_API_URL: url },
    }).toString();
  assert.strictEqual(run('https://attacker.example'), '', 'error body not printed');
  assert.ok(fs.readFileSync(log, 'utf8').includes('http://127.0.0.1:9001/agent/hook'));
  run('http://127.0.0.1:9001@attacker.example');
  assert.ok(fs.readFileSync(log, 'utf8').includes('http://127.0.0.1:9001/agent/hook'));
  run('http://127.0.0.1:9123');
  assert.ok(fs.readFileSync(log, 'utf8').includes('http://127.0.0.1:9123/agent/hook'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
  }
}
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
