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
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [], getFocusedWindow: () => null },
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
const { kindTitle, providerLabel } = require(path.join(dist, 'copilot', 'attention-queue.js'));
const { copilotBus } = require(path.join(dist, 'copilot', 'bus.js'));
const { windowRegistry } = require(path.join(dist, 'window-registry.js'));

/** A fake Lee window whose tabs show the given PTYs; returns an unregister fn. */
function withWindow(tabs, id = 1) {
  const bw = { id, isDestroyed: () => false, webContents: { send() {} } };
  windowRegistry.register(bw, '/work/api', {
    getContext: () => ({ workspace: '/work/api', tabs, panels: {}, focusedPanel: 'center' }),
  });
  return () => windowRegistry.unregister(id);
}

class FakePty {
  constructor() {
    this.procs = new Map();
    this.writes = [];
    this.listeners = {};
  }
  add(id, { claude = true, pi = false, name = 'Claude' } = {}) {
    this.procs.set(id, { id, name, windowId: null, claude: claude && !pi, pi });
  }
  get(id) {
    return this.procs.get(id);
  }
  write(id, data) {
    this.writes.push([id, data]);
  }
  isClaudePty(id) {
    const p = this.procs.get(id);
    return p?.claude === true || p?.pi === true;
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
  q.sessions.get('s1').awaiting_input = false;
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

test('agents: busy with busy_since, idle with last_summary after Stop; no prompt or tool input', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude: api' }]);
  try {
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'SECRET PROMPT' });
    hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/work/api/SECRET.ts', old_string: 'a', new_string: 'b' }, tool_use_id: 'a' });
    let snap = q.snapshot({ compact: true });
    assert.strictEqual(snap.agents.length, 1);
    let [a] = snap.agents;
    assert.strictEqual(a.pty_id, 1);
    assert.strictEqual(a.tab_id, 11);
    assert.strictEqual(a.label, 'Claude: api');
    assert.strictEqual(a.state, 'busy');
    assert.ok(a.busy_since && Number.isFinite(Date.parse(a.busy_since)), 'busy_since is ISO');
    assert.strictEqual(a.idle_since, null);
    assert.strictEqual(a.last_tool, 'Edit');
    assert.strictEqual(a.files_touched_count, 1);
    assert.ok(!JSON.stringify(snap.agents).includes('SECRET'), 'no prompt text or tool input');

    hook('Stop', { last_assistant_message: 'Refactored the router. ' + 'y'.repeat(600) });
    snap = q.snapshot({ compact: true });
    [a] = snap.agents;
    assert.strictEqual(a.state, 'idle');
    assert.strictEqual(a.busy_since, null);
    assert.ok(a.idle_since, 'idle_since set');
    assert.match(a.last_summary, /^Refactored the router/);
    assert.ok(a.last_summary.length <= 280, 'clipped in compact');
    assert.ok(q.snapshot().agents[0].last_summary.length > 280, 'full snapshot keeps more');

    hook('SessionEnd', { reason: 'exit' });
    assert.strictEqual(q.snapshot({ compact: true }).agents.length, 0, 'ended sessions drop out');
  } finally {
    done();
  }
});

test('agents: warm and tab-less PTYs are not listed; exited PTY drops out', () => {
  const { pty, q, hook } = setup();
  pty.add(9, { name: 'Claude (warm)' });
  pty.add(5);
  const done = withWindow([
    { id: 11, ptyId: 1, label: 'Claude' },
    { id: 19, ptyId: 9, label: 'Claude (warm)' },
  ]);
  try {
    hook('SessionStart');
    q.handleHook({ event: 'SessionStart', ptyId: '9', windowId: null }, { session_id: 'warm' });
    q.handleHook({ event: 'SessionStart', ptyId: '5', windowId: null }, { session_id: 'notab' });
    assert.deepStrictEqual(q.snapshot({ compact: true }).agents.map((a) => a.pty_id), [1]);
    q.onPtyExit(1, 0);
    assert.strictEqual(q.snapshot({ compact: true }).agents.length, 0);
  } finally {
    done();
  }
});

test('agents: a state change schedules a device push; a tool event alone does not', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude' }]);
  const pushed = [];
  const orig = copilotBus.broadcast;
  copilotBus.broadcast = (msg) => pushed.push(msg);
  const clearTimers = () => {
    for (const t of ['wsTimer', 'ipcTimer']) if (q[t]) { clearTimeout(q[t]); q[t] = null; }
  };
  try {
    q.started = true; // pushes are only scheduled once started
    hook('SessionStart');
    clearTimers();
    q.broadcastSnapshot();
    pushed.length = 0;

    hook('UserPromptSubmit', { prompt: 'x' });
    assert.ok(q.wsTimer, 'turn start scheduled a push');
    clearTimers();
    assert.strictEqual(q.broadcastSnapshot(), true);
    assert.strictEqual(pushed[0].type, 'attention_snapshot');
    assert.strictEqual(pushed[0].data.agents[0].state, 'busy');

    hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: 't1' });
    hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: 't1' });
    clearTimers();
    assert.strictEqual(q.broadcastSnapshot(), false, 'tool events alone are not pushed');

    // A state change with no hook event (e.g. Enter answering a prompt in the tab) still schedules one.
    q.sessions.get('s1').activity = 'idle';
    q.sessions.get('s1').in_turn = false;
    q.sessions.get('s1').turn_started_at = null;
    q.noteAgents();
    assert.ok(q.wsTimer, 'state change scheduled a push');
    clearTimers();

    hook('UserPromptSubmit', { prompt: 'y' });
    hook('Stop', { last_assistant_message: 'done' });
    clearTimers();
    assert.strictEqual(q.broadcastSnapshot(), true);
    const last = pushed[pushed.length - 1].data.agents[0];
    assert.strictEqual(last.state, 'idle');
    assert.strictEqual(last.last_summary, 'done');
    assert.strictEqual(last.last_tool, 'Read', 'last_tool rides along');
  } finally {
    clearTimers();
    q.started = false;
    copilotBus.broadcast = orig;
    done();
  }
});

// AskUserQuestion's tool_input as Claude Code 2.1.283 sends it.
const ASK = {
  questions: [
    {
      question: 'Which auth method should the API use? SECRET-Q',
      header: 'Auth',
      multiSelect: false,
      options: [
        { label: 'JWT', description: 'Stateless tokens' },
        { label: 'Sessions', description: 'Server-side sessions, SECRET-OPT' },
        { label: 'OAuth' },
      ],
    },
  ],
};
const DEVICE = { kind: 'user', surface: 'device', device_id: 'd1', device_kind: 'phone' };

/** Capture every event-log line written during fn. */
function captureEvents(fn) {
  const lines = [];
  copilotBus.setEventSink({ write: (e) => lines.push(e) });
  lines.length = 0; // the bus flushes lines queued before a sink existed
  try {
    fn();
  } finally {
    copilotBus.setEventSink(null);
  }
  return lines;
}

function askFlow(hook, input = ASK, id = 'q1') {
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: id });
  hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: input, tool_use_id: id });
  hook('Notification', { message: 'Claude needs your permission to use AskUserQuestion', notification_type: 'permission_prompt' });
}

test('AskUserQuestion opens a question with its options, not an approval', () => {
  const { q, hook, live } = setup();
  const events = captureEvents(() => askFlow(hook));
  assert.strictEqual(live('approval').length, 0, 'no approval');
  const qs = live('question');
  assert.strictEqual(qs.length, 1, 'one question item');
  const [item] = qs;
  assert.strictEqual(item.severity, 'needs-you');
  assert.match(item.title, /^Claude asks: Which auth method/);
  assert.deepStrictEqual(item.question.questions[0].options.map((o) => o.label), ['JWT', 'Sessions', 'OAuth']);
  assert.strictEqual(item.question.questions[0].options[2].description, null);
  assert.strictEqual(item.question.questions[0].header, 'Auth');
  assert.strictEqual(item.question.questions[0].multi_select, false);
  assert.ok(item.actions.includes('choose'));
  assert.ok(!item.actions.includes('approve') && !item.actions.includes('deny') && !item.actions.includes('reply'));
  assert.ok(events.length > 0, 'events were logged');
  const leak = events.filter((e) => JSON.stringify(e).includes('SECRET')).map((e) => e.type);
  assert.deepStrictEqual(leak, [], 'question text and options never reach the event log');
  assert.strictEqual(q.sessions.get('s1').awaiting_input, true);
});

test('choose sends the option digit and resolves the question; the choice logs as an index', () => {
  const { pty, q, hook, live } = setup();
  askFlow(hook);
  const [item] = live('question');
  let r;
  const events = captureEvents(() => {
    r = q.reply(item.id, { action: 'choose', choice: 1, version: item.version }, DEVICE);
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(pty.writes.map((w) => w[1]).join(''), '2', 'digit 2 picks the second option');
  assert.strictEqual(live('question').length, 0);
  assert.strictEqual(q.sessions.get('s1').awaiting_input, false);
  const reply = events.find((e) => e.type === 'attention.reply');
  assert.strictEqual(reply.data.action, 'choose');
  assert.strictEqual(reply.data.choice, 1);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
});

test('choose after the question was answered in the tab is stale (409) and writes nothing', () => {
  const { pty, q, hook, live } = setup();
  askFlow(hook);
  const [item] = live('question');
  q.onUserInput(1, '1'); // the person picked in the tab
  assert.strictEqual(live('question').length, 0, 'answered in tab');
  const r = q.reply(item.id, { action: 'choose', choice: 0, version: item.version }, DEVICE);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(pty.writes.length, 0);
});

test('choose while the picker is not showing is stale (409), even if the item is still open', () => {
  const { pty, q, hook, live } = setup();
  askFlow(hook);
  const [item] = live('question');
  q.sessions.get('s1').awaiting_input = false;
  const r = q.reply(item.id, { action: 'choose', choice: 0, version: item.version }, DEVICE);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(pty.writes.length, 0);
});

test('choose with an old version is stale (409); bad choice or text is 400', () => {
  const { pty, q, hook, live } = setup();
  askFlow(hook);
  const [item] = live('question');
  assert.strictEqual(q.reply(item.id, { action: 'choose', choice: 0, version: item.version - 1 }, DEVICE).status, 409);
  assert.strictEqual(q.reply(item.id, { action: 'choose', choice: 3, version: item.version }, DEVICE).status, 400);
  assert.strictEqual(q.reply(item.id, { action: 'choose', choice: '1', version: item.version }, DEVICE).status, 400);
  assert.strictEqual(q.reply(item.id, { action: 'approve', version: item.version }, DEVICE).status, 400);
  assert.strictEqual(q.reply(item.id, { action: 'text', text: 'JWT', version: item.version }, DEVICE).status, 400);
  assert.strictEqual(pty.writes.length, 0);
});

test('question resolves on PostToolUse (answers change the input signature)', () => {
  const { q, hook, live } = setup();
  askFlow(hook);
  const answered = { ...ASK, answers: { [ASK.questions[0].question]: 'JWT' } };
  hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: answered, tool_use_id: 'q1' });
  assert.strictEqual(live('question').length, 0);
  assert.strictEqual(q.sessions.get('s1').awaiting_input, false);
});

test('question resolves on idle_prompt, Stop and Esc in the tab', () => {
  let { q, hook, live } = setup();
  askFlow(hook);
  hook('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.strictEqual(live('question').length, 0, 'idle_prompt');

  ({ q, hook, live } = setup());
  askFlow(hook);
  hook('Stop', { last_assistant_message: 'ok' });
  assert.strictEqual(live('question').length, 0, 'Stop');

  ({ q, hook, live } = setup());
  askFlow(hook);
  q.onUserInput(1, '\x1b');
  assert.strictEqual(live('question').length, 0, 'Esc');
  assert.strictEqual(q.sessions.get('s1').in_turn, false, 'Esc interrupts the turn');
});

test('multi-question or multi-select questions are read-only (no choose)', () => {
  const { q, hook, live } = setup();
  const multi = {
    questions: [
      { question: 'Pick features', header: 'Features', multi_select: true, options: [{ label: 'A' }, { label: 'B' }] },
    ],
  };
  askFlow(hook, multi);
  let [item] = live('question');
  assert.strictEqual(item.question.questions[0].multi_select, true, 'snake_case multi_select read');
  assert.ok(!item.actions.includes('choose'));
  assert.strictEqual(q.reply(item.id, { action: 'choose', choice: 0, version: item.version }, DEVICE).status, 400);
  hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: multi, tool_use_id: 'q1' });

  const two = { questions: [ASK.questions[0], { question: 'And the DB?', options: [{ label: 'PG' }, { label: 'SQLite' }] }] };
  askFlow(hook, two, 'q2');
  [item] = live('question');
  assert.strictEqual(item.question.questions.length, 2);
  assert.ok(!item.actions.includes('choose'));
});

test('question strings are capped, and clipped in compact snapshots', () => {
  const { q, hook } = setup();
  const long = 'L'.repeat(1000);
  const big = {
    questions: Array.from({ length: 6 }, () => ({
      question: long,
      header: long,
      options: Array.from({ length: 12 }, () => ({ label: long, description: long })),
    })),
  };
  askFlow(hook, big);
  const full = q.snapshot().items.find((i) => i.kind === 'question');
  assert.strictEqual(full.question.questions.length, 4);
  assert.strictEqual(full.question.questions[0].options.length, 8);
  assert.ok(full.question.questions[0].question.length <= 300);
  assert.ok(full.question.questions[0].options[0].description.length <= 300);
  const compact = q.snapshot({ compact: true }).items.find((i) => i.kind === 'question');
  for (const qq of compact.question.questions) {
    assert.ok(qq.question.length <= 120 && qq.header.length <= 120);
    for (const o of qq.options) assert.ok(o.label.length <= 120 && o.description.length <= 120);
  }
});

test('an approval Notification before the question hooks still becomes a question', () => {
  const { hook, live } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  // Only PreToolUse, then Claude's permission_prompt notification.
  hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK, tool_use_id: 'q1' });
  hook('Notification', { message: 'Claude needs your permission to use AskUserQuestion', notification_type: 'permission_prompt' });
  assert.strictEqual(live('approval').length, 0);
  assert.strictEqual(live('question').length, 1);
  assert.ok(live('question')[0].actions.includes('choose'));
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

test('item titles name the provider: Pi, not Claude', () => {
  const pty = new FakePty();
  pty.add(7, { pi: true, name: 'Pi' });
  const q = new CopilotQueue(pty);
  const hook = (event, body = {}, ptyId = '7') =>
    q.handleHook({ event, ptyId, windowId: null }, { session_id: 'pi1', hook_event_name: event, provider: 'pi', ...body });
  hook('SessionStart');
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('Stop', { last_assistant_message: 'Done.' });
  const review = q.snapshot({ all: true }).items.find((i) => i.kind === 'review');
  assert.ok(review, 'review item');
  assert.strictEqual(review.title, 'Pi finished a turn');
  assert.strictEqual(review.source.provider, 'pi');
  hook('UserPromptSubmit', { prompt: 'y' });
  hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b' });
  const appr = q.snapshot({ all: true }).items.find((i) => i.kind === 'approval' && i.state === 'open');
  assert.strictEqual(appr.title, 'Pi wants to use Bash');
});

test('a Pi post without a trusted PTY header is still labelled Pi', () => {
  const pty = new FakePty();
  const q = new CopilotQueue(pty);
  q.handleHook({ event: 'SessionStart', ptyId: null, windowId: null }, { session_id: 'pi2', hook_event_name: 'SessionStart', provider: 'pi' });
  q.handleHook({ event: 'Stop', ptyId: '', windowId: null }, { session_id: 'pi2', hook_event_name: 'Stop', provider: 'pi', last_assistant_message: 'ok' });
  const review = q.snapshot({ all: true }).items.find((i) => i.kind === 'review');
  assert.strictEqual(review.title, 'Pi finished a turn');
  assert.strictEqual(q.sessions.get('pi2').provider, 'pi');
});

test('Claude sessions keep Claude titles; unknown providers say Agent', () => {
  const { q, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'x' });
  hook('Stop', { last_assistant_message: 'Done.' });
  assert.strictEqual(q.snapshot({ all: true }).items.find((i) => i.kind === 'review').title, 'Claude finished a turn');
  assert.strictEqual(kindTitle('waiting', null), 'Agent is waiting for you');
  assert.strictEqual(kindTitle('blocker', 'codex'), 'Codex is blocked');
  assert.strictEqual(providerLabel(''), 'Agent');
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
