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
    hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/work/api/router.ts', old_string: 'SECRET_OLD', new_string: 'SECRET_NEW' }, tool_use_id: 'a' });
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
    // Cockpit design §7.1: now/recent carry the path and toolPreview, never the prompt or the edit itself.
    assert.ok(!JSON.stringify(snap.agents).includes('SECRET'), 'no prompt text or raw tool input');
    assert.strictEqual(a.now.tool, 'Edit');
    assert.deepStrictEqual(a.now.files, ['/work/api/router.ts']);

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

test('agents: full snapshots carry session_id and the cwd it started in (a restore resumes there); compact ones do not', () => {
  const { pty, q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude: api' }, { id: 12, ptyId: 2, label: 'Claude: resumed' }]);
  try {
    hook('SessionStart', { cwd: '/work/api/.claude/worktrees/fix-1' });
    hook('UserPromptSubmit', { prompt: 'x', cwd: '/work/api/.claude/worktrees/fix-1/src' });
    let [a] = q.snapshot().agents;
    assert.strictEqual(a.session_id, 's1');
    assert.strictEqual(a.cwd, '/work/api/.claude/worktrees/fix-1', 'where Claude filed it, not where it moved');
    const [c] = q.snapshot({ compact: true }).agents;
    assert.ok(!('session_id' in c) && !('cwd' in c), 'compact (device) snapshots leave them out');
    // A resumed session (same id) in a new PTY: SessionStart moves it there.
    pty.add(2);
    hook('SessionStart', { cwd: '/work/api/.claude/worktrees/fix-1', source: 'resume' }, '2');
    [a] = q.snapshot().agents;
    assert.strictEqual(a.pty_id, 2);
    assert.strictEqual(a.session_id, 's1');
  } finally {
    done();
  }
});

test('withClaudeHooks adds Lee hooks to a resumed Claude (argv --resume <id>, no --session-id)', () => {
  const dir = path.join(tmpHome, '.lee', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-settings.json'), '{}');
  const args = withClaudeHooks('claude', ['--resume', 'sess-1']);
  assert.strictEqual(args[0], '--settings');
  assert.deepStrictEqual(args.slice(-2), ['--resume', 'sess-1']);
  assert.ok(!args.includes('--session-id'));
});

test('agents: updates ring keeps the last 10 turns (summary clipped to 600, lee-status parsed), newest last', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude: api' }]);
  try {
    hook('SessionStart');
    assert.deepStrictEqual(q.snapshot().agents[0].updates, [], 'no turns yet');
    const logged = [];
    const onEv = (e) => logged.push(e);
    copilotBus.on('event', onEv);
    for (let i = 0; i < 12; i++) {
      hook('UserPromptSubmit', { prompt: `SECRET PROMPT ${i}` });
      hook('Stop', { last_assistant_message: `Turn ${i}.` });
    }
    hook('UserPromptSubmit', { prompt: 'long' });
    const long = 'Refactored the router. ' + 'z'.repeat(2000) + '\n\n```lee-status\nstatus: blocked\nsummary: Need the key\nnext: ask Ben\n```';
    hook('Stop', { last_assistant_message: long });
    copilotBus.off('event', onEv);
    const ups = q.snapshot().agents[0].updates;
    assert.strictEqual(ups.length, 10, 'capped at 10');
    assert.strictEqual(ups[0].summary, 'Turn 3.', 'oldest dropped first');
    const last = ups[ups.length - 1];
    assert.ok(last.summary.length <= 600, `clipped to 600 (${last.summary.length})`);
    assert.match(last.summary, /^Refactored the router\./);
    assert.ok(!last.summary.includes('lee-status'), 'the parsed block is not repeated in the summary');
    assert.strictEqual(last.lee_status.status, 'blocked');
    assert.strictEqual(last.lee_status.summary, 'Need the key');
    assert.strictEqual(last.lee_status.next, 'ask Ben');
    assert.ok(!Number.isNaN(Date.parse(last.at)), 'at is an ISO time');
    assert.strictEqual(ups[0].lee_status, null);
    assert.ok(Array.isArray(q.snapshot({ compact: true }).agents[0].updates), 'compact snapshots carry it too');
    ups[0].summary = 'mutated';
    assert.strictEqual(q.snapshot().agents[0].updates[0].summary, 'Turn 3.', 'snapshots get copies');
    const endEvents = logged.filter((e) => e.type === 'agent.turn_end');
    assert.strictEqual(endEvents.length, 13);
    assert.ok(endEvents.every((e) => !('updates' in (e.data ?? {}))), 'the ring itself is never logged');
    assert.ok(!JSON.stringify(logged).includes('SECRET'), 'no prompt text logged');
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

test("Lee's Claude plugin: the Desk and Drawer skills, --plugin-dir added once, gone when hooks are off", () => {
  const { installClaudePlugin, pluginPaths, DESK_SKILL, DRAWER_SKILL } = require(path.join(dist, 'copilot', 'claude-plugin.js'));
  const home = fs.mkdtempSync(path.join(tmpHome, 'plugin-'));
  const p = installClaudePlugin(true, home);
  assert.strictEqual(JSON.parse(fs.readFileSync(p.manifest, 'utf8')).name, 'lee');
  assert.strictEqual(fs.readFileSync(p.skills.desk, 'utf8'), DESK_SKILL);
  assert.strictEqual(fs.readFileSync(p.skills.drawer, 'utf8'), DRAWER_SKILL);
  for (const skill of [DESK_SKILL, DRAWER_SKILL]) {
    assert.ok(/^---\nname: \w+\ndescription: .+\n---\n/.test(skill), 'frontmatter: name and description');
    assert.ok(skill.includes('hester desk'), 'reads through hester desk');
    assert.ok(/Don't write to/.test(skill), 'read-only');
  }
  const args = withClaudeHooks('claude', ['--resume', 'sess-1']);
  const i = args.indexOf('--plugin-dir');
  assert.ok(i >= 0 && args[i + 1] === p.dir, 'the plugin rides along');
  assert.deepStrictEqual(args.slice(-2), ['--resume', 'sess-1']);
  assert.strictEqual(withClaudeHooks('claude', ['--plugin-dir', p.dir]).filter((a) => a === '--plugin-dir').length, 1, 'never twice');
  assert.ok(!withClaudeHooks('bash', ['-l']).includes('--plugin-dir'), 'only Claude');
  installClaudePlugin(false, home);
  assert.ok(!fs.existsSync(pluginPaths(home).dir));
  assert.ok(!withClaudeHooks('claude', []).includes('--plugin-dir'), 'off: no flag');
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

test('session names: title-bearing hooks signal the transcript path in memory only (never logged)', () => {
  const { hook } = setup();
  const signals = [];
  const logged = [];
  const onSig = (sig) => signals.push(sig);
  const onEv = (e) => logged.push(e);
  copilotBus.on('agent-transcript', onSig);
  copilotBus.on('event', onEv);
  hook('SessionStart', { transcript_path: '/home/me/.claude/projects/p/s1.jsonl' });
  hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, transcript_path: '/home/me/.claude/projects/p/s1.jsonl' });
  hook('Stop', { last_assistant_message: 'ok', transcript_path: '/home/me/.claude/projects/p/s1.jsonl' });
  copilotBus.off('agent-transcript', onSig);
  copilotBus.off('event', onEv);
  assert.deepStrictEqual(signals.map((x) => x.event), ['SessionStart', 'Stop']);
  assert.strictEqual(signals[0].session_id, 's1');
  assert.ok(!JSON.stringify(logged).includes('s1.jsonl'), 'transcript path never in the event log');
});

test('v4 ranker: same severity orders by quadrant (Q1 before unclassified before Q4), then wait; quadrant shown', () => {
  const { pty, q } = setup();
  pty.add(2);
  pty.add(3);
  const stop = (ptyId, sid) => {
    q.handleHook({ event: 'UserPromptSubmit', ptyId: String(ptyId), windowId: null }, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    q.handleHook({ event: 'Stop', ptyId: String(ptyId), windowId: null }, { session_id: sid, hook_event_name: 'Stop', last_assistant_message: `done ${sid}` });
  };
  stop(1, 'sa');
  stop(2, 'sb');
  stop(3, 'sc');
  const order = () => q.snapshot({ all: false }).items.filter((i) => i.kind === 'review').map((i) => i.source.pty_id);
  const before = q.snapshot({ all: false }).items;
  assert.strictEqual(before.length, 3);
  assert.ok(before.every((i) => i.quadrant === undefined), 'no quadrant without a ranker');
  const { quadrantRank } = require(path.join(dist, 'copilot', 'attention-queue.js'));
  assert.deepStrictEqual(['Q1', 'Q2', 'Q3', null, 'Q4'].map(quadrantRank), [0, 1, 2, 3, 4]);
  const quad = { 1: 'Q4', 2: 'Q1', 3: null };
  q.queue.setRanker((item) => ({ quadrant: quad[item.source.pty_id], rank: quadrantRank(quad[item.source.pty_id]) }));
  assert.deepStrictEqual(order(), [2, 3, 1]);
  const items = q.snapshot({ all: false }).items;
  assert.deepStrictEqual(items.map((i) => i.quadrant), ['Q1', null, 'Q4']);
  // Severity still wins over quadrant: an approval on the Q4 agent comes first.
  q.handleHook({ event: 'UserPromptSubmit', ptyId: '1', windowId: null }, { session_id: 'sa', hook_event_name: 'UserPromptSubmit', prompt: 'y' });
  q.handleHook({ event: 'PermissionRequest', ptyId: '1', windowId: null }, { session_id: 'sa', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'z' });
  const first = q.snapshot({ all: false }).items[0];
  assert.strictEqual(first.kind, 'approval');
  assert.strictEqual(first.quadrant, 'Q4');
  // A throwing ranker degrades to unclassified instead of breaking snapshots.
  q.queue.setRanker(() => {
    throw new Error('boom');
  });
  assert.ok(q.snapshot({ all: false }).items.every((i) => i.quadrant === null));
  q.queue.setRanker(null);
});

test('v4 focus on a task: parsed, logged, and related to items from its agent pty only', () => {
  const { pty, q } = setup();
  pty.add(2);
  const logged = [];
  const onEv = (e) => logged.push(e);
  copilotBus.on('event', onEv);
  const { parseFocusItem, focusItemKey } = require(path.join(dist, 'copilot', 'focus.js'));
  const item = { kind: 'task', workspace: '/work/api', task_id: 't1', label: 'Fix login' };
  assert.deepStrictEqual(parseFocusItem(item), item);
  assert.strictEqual(parseFocusItem({ kind: 'task', workspace: '/work/api' }), null);
  assert.strictEqual(focusItemKey(item), 'task:/work/api:t1');
  q.focus.setTaskResolver((ptyId) => (ptyId === 1 ? { workspace: '/work/api', task_id: 't1' } : { workspace: '/work/api', task_id: 't2' }));
  const r = q.focusStart(item, { kind: 'user', surface: 'lee' }, 'lee');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.item, item);
  for (const [ptyId, sid] of [[1, 'sa'], [2, 'sb']]) {
    q.handleHook({ event: 'UserPromptSubmit', ptyId: String(ptyId), windowId: null }, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    q.handleHook({ event: 'Stop', ptyId: String(ptyId), windowId: null }, { session_id: sid, hook_event_name: 'Stop', last_assistant_message: 'done?' });
  }
  const items = q.snapshot({ all: false }).items;
  const rel = Object.fromEntries(items.map((i) => [i.source.pty_id, i.related_to_focus]));
  assert.deepStrictEqual(rel, { 1: true, 2: false });
  copilotBus.off('event', onEv);
  const start = logged.find((e) => e.type === 'focus.start');
  assert.ok(start, 'focus.start logged');
  assert.deepStrictEqual(start.data.item, item);
  q.focusStop({ kind: 'user', surface: 'lee' });
});

// ---------------------------------------------------------------------------
// Deep D1 (docs/plans/2026-09-26-deep-d1-contracts.md §2, §6, §11 M)
// ---------------------------------------------------------------------------

const { COPILOT_DEFAULTS } = require(path.join(dist, 'copilot', 'config.js'));
const LEE = { kind: 'user', surface: 'lee' };
const DEV_ACTOR = { kind: 'user', surface: 'device', device_id: 'dev1', device_kind: 'aeronaut' };
const MIN = 60_000;

/** Collect bus events while fn runs. */
function logged(fn) {
  const out = [];
  const onEv = (e) => out.push(e);
  copilotBus.on('event', onEv);
  try {
    fn();
  } finally {
    copilotBus.off('event', onEv);
  }
  return out;
}

/** An open approval (needs-you) on PTY `ptyId`; returns the item. */
function openApproval(q, ptyId = 1, sid = 's1') {
  q.handleHook({ event: 'UserPromptSubmit', ptyId: String(ptyId), windowId: null }, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  q.handleHook({ event: 'PermissionRequest', ptyId: String(ptyId), windowId: null }, { session_id: sid, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `t${ptyId}` });
  return q.snapshot({ all: false }).items.find((i) => i.kind === 'approval' && i.source.pty_id === ptyId);
}

/** A fake express app that records each route's last handler. */
function fakeApp() {
  const routes = {};
  const reg = (m) => (p, ...hs) => {
    routes[`${m} ${p}`] = hs[hs.length - 1];
  };
  return { routes, get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use() {} };
}

function call(handler, { body = {}, principal } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    locals: { principal },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    type() {
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    end() {
      return this;
    },
  };
  handler({ body, query: {}, params: {}, socket: { remoteAddress: '127.0.0.1' }, header: () => undefined }, res);
  return res;
}

test('Deep: a Deep start replaces an inferred session (switch), then a second deepStart updates the item', () => {
  const unreg = withWindow([]);
  try {
    const { q } = setup();
    q.focus.start({ kind: 'files', workspace: '/work/api', paths: ['/work/api/a.py'] }, 'inferred', 'auto', { kind: 'system' }, Date.now());
    const inferredId = q.focus.sessionId;
    const ev = logged(() => {
      const r = q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: 'pg-00000001', card_kind: 'page', title: 'One' }, LEE, 'lee');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.source, 'deep');
      assert.strictEqual(r.body.policy, 'none');
      assert.deepStrictEqual(r.body.deep, { exploration_id: 'pg-00000001', title: 'One', workspace: '/work/api', card_id: 'pg-00000001', card_kind: 'page' });
    });
    const end = ev.find((e) => e.type === 'focus.end');
    assert.strictEqual(end.data.session_id, inferredId);
    assert.strictEqual(end.data.reason, 'switch');
    const start = ev.find((e) => e.type === 'focus.start');
    assert.strictEqual(start.data.source, 'deep');
    assert.strictEqual(start.data.policy, 'none');
    const deepId = q.focus.sessionId;

    const ev2 = logged(() => q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: 'pg-00000002', title: 'Two' }, LEE, 'lee'));
    assert.strictEqual(q.focus.sessionId, deepId, 'same session');
    assert.deepStrictEqual(ev2.map((e) => e.type), ['focus.item']);
    assert.strictEqual(q.focusState().deep.card_id, 'pg-00000002');
    // A manual (lee) focus start leaves the Deep session alone.
    q.focusStart({ kind: 'agent', pty_id: 1, window_id: null, label: 'x' }, LEE, 'lee');
    assert.strictEqual(q.focusState().source, 'deep');
    // deepEnd: the rating and length reach focus.end; never text.
    const ev3 = logged(() => q.deepEnd({ reason: 'ritual', rating: 'deep', stopped_at_chars: 42, stopped_at: 'secret' }, LEE));
    const end3 = ev3.find((e) => e.type === 'focus.end');
    assert.deepStrictEqual(
      { reason: end3.data.reason, source: end3.data.source, deep_rating: end3.data.deep_rating, stopped_at_chars: end3.data.stopped_at_chars },
      { reason: 'deep_end', source: 'deep', deep_rating: 'deep', stopped_at_chars: 42 },
    );
    assert.ok(!JSON.stringify(ev3).includes('secret'));
    assert.strictEqual(q.focusState().active, false);
    assert.strictEqual(q.deepEnd({ reason: 'later' }, LEE).status, 400);
    assert.strictEqual(q.deepEnd({ reason: 'esc', rating: 'great' }, LEE).status, 400);
    assert.strictEqual(q.deepStart({ exploration_id: '../x' }, LEE, 'lee').status, 400);
    assert.strictEqual(q.deepStart({ exploration_id: null, card_id: 'exp-1a2b3c4d' }, LEE, 'lee').status, 400, 'card ids are page ids');
    assert.strictEqual(q.deepStart({ exploration_id: null, card_id: 'pg-00000001', card_kind: 'board' }, LEE, 'lee').status, 400);
  } finally {
    unreg();
  }
});

test('Deep: idle end at 45 min away (reason away, unrated); not before', () => {
  const { q } = setup();
  const t0 = Date.now();
  q.deepStart({ workspace: '/work/api', exploration_id: 'exp-one' }, LEE, 'lee');
  const away = (m) => ({ at_machine: false, engaged: false, away_since: new Date(t0 - m * MIN).toISOString() });
  const cfg = COPILOT_DEFAULTS;
  assert.strictEqual(cfg.deep.idle_end_minutes, 45);
  // Past manual (15) and inferred (5) limits, a Deep session holds.
  assert.strictEqual(q.focus.tick(t0, away(44), cfg.focus, { deep: cfg.deep }), false);
  assert.strictEqual(q.focus.source, 'deep');
  const ev = logged(() => assert.strictEqual(q.focus.tick(t0, away(45), cfg.focus, { deep: cfg.deep }), true));
  const end = ev.find((e) => e.type === 'focus.end');
  assert.strictEqual(end.data.reason, 'away');
  assert.strictEqual(end.data.deep_rating, null);
  assert.strictEqual(q.focus.source, null);
});

test('Deep: no inference while any window is in Deep mode (from cockpit.mode events)', () => {
  const unreg1 = withWindow([], 1);
  const unreg2 = withWindow([], 2);
  try {
    const { q } = setup();
    const t0 = Math.floor(Date.now() / MIN) * MIN;
    for (let m = 9; m >= 1; m--) {
      q.focus.record({ window_id: 1, tab_id: 3, pty_id: null, file_path: '/work/api/a.py', workspace: '/work/api', label: 'a.py', keys: 20, clicks: 0 }, t0 - m * MIN);
    }
    const mode = (window_id, to) =>
      q.onBusEvent({ type: 'cockpit.mode', window_id, data: { from: 'cockpit', to, reason: 'hop' }, ts: new Date().toISOString() });
    assert.strictEqual(q.windowMode(2), 'cockpit', 'unreported windows are in the Cockpit');
    mode(2, 'deep');
    assert.strictEqual(q.anyWindowDeep(), true);
    const tick = () => q.focus.tick(t0, null, COPILOT_DEFAULTS.focus, { deep: COPILOT_DEFAULTS.deep, inferBlocked: q.anyWindowDeep() });
    assert.strictEqual(tick(), false);
    assert.strictEqual(q.focus.active, false, 'no inferred session while window 2 is Deep');
    mode(2, 'manual');
    assert.strictEqual(q.anyWindowDeep(), false);
    assert.strictEqual(tick(), true);
    assert.strictEqual(q.focus.source, 'inferred');
    // A closed window's stale Deep mode doesn't block.
    mode(2, 'deep');
    unreg2();
    assert.strictEqual(q.anyWindowDeep(), false);
  } finally {
    unreg1();
    unreg2();
  }
});

test('Deep policy none: neither age nor relatedness escalates, a woken item does; notify only when woken', () => {
  const { pty, q } = setup();
  pty.add(2);
  const t0 = Date.now();
  q.deepStart({ workspace: '/work/api', exploration_id: 'exp-one' }, LEE, 'lee');
  const a = openApproval(q, 1, 'sa');
  const b = openApproval(q, 2, 'sb');
  assert.strictEqual(q.focus.isRelated(1, []), false, 'nothing is related to a Deep session');
  const ev = logged(() => q.queue.recompute(t0 + 25 * MIN));
  const get = (id) => q.snapshot({ all: false }).items.find((i) => i.id === id);
  for (const id of [a.id, b.id]) {
    const it = get(id);
    assert.strictEqual(it.severity, 'needs-you', 'age does not escalate during Deep');
    assert.strictEqual(it.parked, true, 'would-have-escalated items are parked');
    assert.strictEqual(it.notify, false);
  }
  assert.ok(!ev.some((e) => e.type === 'attention.escalate'), 'no escalate during Deep');
  assert.strictEqual(q.focusState().quiet_count, 2, 'quietCount: every open needs-you item, parked or not');

  const ev2 = logged(() => q.queue.setWake(b.id, true, t0 + 26 * MIN, LEE));
  const woke = get(b.id);
  assert.strictEqual(woke.severity, 'blocking');
  assert.strictEqual(woke.parked, false);
  assert.strictEqual(woke.notify, true);
  const esc = ev2.find((e) => e.type === 'attention.escalate');
  assert.ok(esc, 'the woken item escalates');
  assert.strictEqual(esc.data.reason, 'wake');
  assert.strictEqual(get(a.id).severity, 'needs-you');
  assert.strictEqual(q.focusState().quiet_count, 2);

  // Deep ends: the parked item comes back and escalates by age as before.
  q.deepEnd({ reason: 'esc' }, LEE);
  q.queue.recompute(t0 + 27 * MIN);
  assert.strictEqual(get(a.id).parked, false);
  assert.strictEqual(get(a.id).severity, 'blocking');
});

test('Deep: NudgeBudget denies every claim (blocking too) with reason deep; cockpitBus tracks the Deep session', () => {
  const { NudgeBudget, cockpitBus } = require(path.join(dist, 'cockpit', 'cockpit-bus.js'));
  const nb = new NudgeBudget();
  const req = { item_ref: 'pty:1', state_key: 'a', source: 'tabs', blocking: true };
  assert.deepStrictEqual(nb.claim(req, true, true), { granted: false, reason: 'deep' });
  assert.strictEqual(nb.claim(req, false, false).granted, true);
  const { q } = setup();
  q.deepStart({ workspace: '/work/api', exploration_id: null }, LEE, 'lee');
  assert.strictEqual(cockpitBus.isDeepActive(), true);
  assert.strictEqual(cockpitBus.claimNudge({ item_ref: 'pty:9', state_key: 'x', source: 'tabs', blocking: true }).reason, 'deep');
  q.deepEnd({ reason: 'esc' }, LEE);
  assert.strictEqual(cockpitBus.isDeepActive(), false);
});

test('Deep: a device POST /focus/start is Go deep with exploration_id null; /focus/stop ends it deep_end, unrated', () => {
  const unreg = withWindow([]);
  try {
    const { registerQueueRoutes } = require(path.join(dist, 'copilot', 'queue-routes.js'));
    const { getCopilotQueue } = require(path.join(dist, 'copilot', 'queue.js'));
    const pty = new FakePty();
    pty.add(1);
    const app = fakeApp();
    registerQueueRoutes(app, { ptyManager: pty });
    const q = getCopilotQueue(pty);
    const dev = { kind: 'device', device_id: 'dev1', name: 'Aeronaut', device_kind: 'aeronaut', ip: '192.168.1.5' };
    // Only paired devices are people over HTTP.
    assert.strictEqual(call(app.routes['POST /focus/start'], { body: {}, principal: { kind: 'shared', loopback: true, ip: '127.0.0.1' } }).statusCode, 403);
    const ev = logged(() => {
      const r = call(app.routes['POST /focus/start'], { body: { item: { kind: 'agent', pty_id: 1, window_id: null, label: 'x' } }, principal: dev });
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r.body.data.source, 'deep');
      assert.deepStrictEqual(r.body.data.item, { kind: 'card', workspace: '/work/api', card_id: null, card_kind: null, title: 'Deep' });
    });
    const start = ev.find((e) => e.type === 'focus.start');
    assert.strictEqual(start.data.surface, 'device');
    assert.deepStrictEqual(start.actor, DEV_ACTOR);

    const snap = call(app.routes['GET /attention'], { principal: dev }).body.data;
    assert.strictEqual(snap.focus.active, true, 'devices still see focus active during Deep');
    assert.strictEqual(snap.mode, 'cockpit');
    assert.deepStrictEqual(snap.deep, { exploration_id: null, title: 'Deep', card_id: null, card_kind: null });
    q.onBusEvent({ type: 'cockpit.mode', window_id: 1, data: { from: 'cockpit', to: 'deep', reason: 'deep_start' }, ts: new Date().toISOString() });
    assert.strictEqual(q.snapshot({ compact: true }).mode, 'deep');

    // Zooming into a card from the renderer while the device session has none picks the card.
    q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: 'pg-00000001', title: 'One' }, LEE, 'lee', 1);
    // A second device Go deep keeps the open card.
    call(app.routes['POST /deep/start'], { body: { exploration_id: null }, principal: dev });
    assert.strictEqual(q.focusState().deep.card_id, 'pg-00000001');
    assert.strictEqual(q.focusState().deep.exploration_id, 'pg-00000001', 'exploration_id repeats card_id for older devices');

    const ev2 = logged(() => assert.strictEqual(call(app.routes['POST /focus/stop'], { principal: dev }).statusCode, 200));
    const end = ev2.find((e) => e.type === 'focus.end');
    assert.strictEqual(end.data.reason, 'deep_end');
    assert.strictEqual(end.data.deep_rating, null);
    const after = q.snapshot({ compact: true });
    assert.strictEqual(after.focus.active, false);
    assert.strictEqual(after.deep, null);

    assert.strictEqual(call(app.routes['POST /deep/end'], { body: { reason: 'esc' }, principal: dev }).statusCode, 200);
  } finally {
    unreg();
  }
});

test('Deep: ingest accepts deep.answer and opener.shown; deep.answer is forwarded to every window (ids only)', () => {
  const sentA = [];
  const sentB = [];
  const mk = (id, sink) => ({ id, isDestroyed: () => false, webContents: { send: (ch, p) => sink.push([ch, p]) } });
  windowRegistry.register(mk(11, sentA), '/work/api', { getContext: () => ({ workspace: '/work/api', tabs: [], panels: {}, focusedPanel: 'center' }) });
  windowRegistry.register(mk(12, sentB), '/work/web', { getContext: () => ({ workspace: '/work/web', tabs: [], panels: {}, focusedPanel: 'center' }) });
  try {
    const { registerCoreRoutes, deepAnswerEvent } = require(path.join(dist, 'copilot', 'core-routes.js'));
    const app = fakeApp();
    registerCoreRoutes(app, { getHesterPort: () => 9000, getPairingName: () => 'Lee', isPairingEnabled: () => false, log() {} });
    const ingest = app.routes['POST /events/ingest'];
    const answer = { workspace: '/work/api', exploration_id: 'exp-one', answer_id: 'ans-12345678', status: 'done' };
    const ev = logged(() => {
      const r = call(ingest, {
        body: {
          events: [
            { type: 'deep.answer', workspace: '/work/api', data: answer },
            { type: 'opener.shown', workspace: '/work/api', data: { workspace: '/work/api', pick_up: true, surfaces: ['blank', 'quiet'] } },
            { type: 'deep.input', data: {} },
          ],
        },
      });
      assert.deepStrictEqual(r.body.data.accepted, 2);
      assert.deepStrictEqual(r.body.data.rejected.map((x) => x.index), [2]);
    });
    assert.deepStrictEqual(ev.map((e) => e.type), ['deep.answer', 'opener.shown']);
    assert.ok(ev.every((e) => 'focus_session_id' in e.ctx));
    for (const sink of [sentA, sentB]) {
      assert.deepStrictEqual(sink, [['deep:answer', answer]]);
    }
    // No attention item is raised.
    const { q } = setup();
    assert.strictEqual(q.snapshot({ all: true }).items.length, 0);
    // Malformed: not forwarded.
    call(ingest, { body: { events: [{ type: 'deep.answer', data: { ...answer, status: 'mystery' } }] } });
    assert.strictEqual(sentA.length, 1);
    assert.strictEqual(deepAnswerEvent({ exploration_id: 'e', answer_id: 'a', status: 'error' }, '/ws').workspace, '/ws');
    assert.strictEqual(deepAnswerEvent({ exploration_id: 'e', answer_id: 'a', status: 'error' }), null);
  } finally {
    windowRegistry.unregister(11);
    windowRegistry.unregister(12);
  }
});

test('Deep: quitApp ends a Deep session with the given reason, then quits', () => {
  const { q } = setup();
  let quits = 0;
  electronStub.app.quit = () => quits++;
  q.deepStart({ workspace: '/work/api', exploration_id: 'exp-one' }, LEE, 'lee');
  const ev = logged(() => q.quitApp('bogus'));
  assert.strictEqual(ev.find((e) => e.type === 'focus.end').data.reason, 'quit');
  assert.strictEqual(quits, 1);
  q.quitApp('quit');
  assert.strictEqual(quits, 2, 'no session: just quits');
  delete electronStub.app.quit;
});

test('Deep: the ritual\'s Hand off leaves the Deep session to deepEnd, which carries the rating', () => {
  const { q } = setup();
  q.deepStart({ workspace: '/work/api', exploration_id: 'exp-one' }, LEE, 'lee');
  const ev = logged(() => q.handoffStart({}, LEE));
  assert.ok(!ev.some((e) => e.type === 'focus.end'), 'handoff does not end Deep');
  assert.strictEqual(q.focusState().source, 'deep');
  const ev2 = logged(() => q.deepEnd({ reason: 'ritual', rating: 'deep', stopped_at_chars: 7 }, LEE));
  const end = ev2.find((e) => e.type === 'focus.end');
  assert.deepStrictEqual(
    { reason: end.data.reason, source: end.data.source, deep_rating: end.data.deep_rating, stopped_at_chars: end.data.stopped_at_chars },
    { reason: 'deep_end', source: 'deep', deep_rating: 'deep', stopped_at_chars: 7 },
  );
  q.endHandoff('manual');
});

// ---------------------------------------------------------------------------
// Desk D2 (docs/plans/2026-09-27-desk-foundation-contract.md §5, §9.1, §9.2, §9.5)
// ---------------------------------------------------------------------------

const PG_A = 'pg-0000000a';
const PG_B = 'pg-0000000b';
const DEV = { kind: 'device', device_id: 'dev1', name: 'Aeronaut', device_kind: 'aeronaut', ip: '192.168.1.5' };

/** A queue whose Desk session records land in `records` instead of Hester. */
function deskSetup() {
  const ctx = setup();
  const records = [];
  ctx.q.deskSessionSink = (workspace, record) => records.push({ workspace, record });
  return { ...ctx, records };
}

const zoom = (q, card_id, title = card_id) => q.deepStart({ workspace: '/work/api', exploration_id: null, card_id, card_kind: 'page', title }, LEE, 'lee');
const awayFor = (now, minutes) => ({ at_machine: false, engaged: false, away_since: new Date(now - minutes * MIN).toISOString() });
const idleItem = (q) => q.snapshot({ all: false }).items.find((i) => i.kind === 'deep_idle' && i.state === 'open');

test('Desk: card focus items: focus.item only when zooming into a different card; touched cards in first-touched order', () => {
  const { q } = deskSetup();
  const ev = logged(() => q.deepStart({ workspace: '/work/api', exploration_id: null }, LEE, 'lee'));
  const start = ev.find((e) => e.type === 'focus.start');
  assert.deepStrictEqual(start.data.item, { kind: 'card', workspace: '/work/api', card_id: null, card_kind: null, title: 'Deep' });
  const types = (fn) => logged(fn).filter((e) => e.type.startsWith('focus.')).map((e) => e.type);
  assert.deepStrictEqual(types(() => zoom(q, PG_A, 'A')), ['focus.item'], 'into the first card');
  assert.deepStrictEqual(types(() => zoom(q, PG_A, 'A, retitled')), [], 'a retitle is not a new item');
  assert.strictEqual(q.focusState().deep.title, 'A, retitled');
  assert.deepStrictEqual(types(() => q.deepStart({ workspace: '/work/api', exploration_id: null }, DEV_ACTOR, 'device')), [], 'Go deep with null keeps the card');
  assert.strictEqual(q.focusState().deep.card_id, PG_A);
  assert.deepStrictEqual(types(() => zoom(q, PG_B, 'B')), ['focus.item']);
  const back = logged(() => zoom(q, PG_A, 'A'));
  assert.deepStrictEqual(back.map((e) => e.type), ['focus.item'], 'back into A is a different card from B');
  assert.deepStrictEqual(back[0].data.item, { kind: 'card', workspace: '/work/api', card_id: PG_A, card_kind: 'page', title: 'A' });
  assert.deepStrictEqual(q.focus.deepCards, { touched: [PG_A, PG_B], last: PG_A });
  // The compact snapshot's deep carries the card (and exploration_id = card_id for older devices).
  assert.deepStrictEqual(q.snapshot({ compact: true }).deep, { exploration_id: PG_A, title: 'A', card_id: PG_A, card_kind: 'page' });
  q.deepEnd({ reason: 'esc' }, LEE);
});

test('Desk: deepStart with a legacy exploration_id: a page id is the card, anything else is the Desk with no card', () => {
  const { q } = deskSetup();
  q.deepStart({ workspace: '/work/api', exploration_id: 'exp-1a2b3c4d', title: 'Old' }, LEE, 'lee');
  assert.deepStrictEqual(q.focusState().item, { kind: 'card', workspace: '/work/api', card_id: null, card_kind: null, title: 'Old' });
  q.deepStart({ workspace: '/work/api', exploration_id: 'pg-1a2b3c4d', title: 'Page' }, LEE, 'lee');
  assert.deepStrictEqual(q.focusState().item, { kind: 'card', workspace: '/work/api', card_id: 'pg-1a2b3c4d', card_kind: 'page', title: 'Page' });
  // card_id wins over exploration_id.
  q.deepStart({ workspace: '/work/api', exploration_id: 'pg-1a2b3c4d', card_id: PG_B, title: 'B' }, LEE, 'lee');
  assert.strictEqual(q.focusState().deep.card_id, PG_B);
  q.deepEnd({ reason: 'esc' }, LEE);
});

test('Desk: the idle-end push goes out at 40 of 45, once per session, as a devices-only needs-you item Deep does not park', () => {
  const { q } = deskSetup();
  const cfg = COPILOT_DEFAULTS;
  assert.strictEqual(cfg.deep.idle_warn_minutes, 5);
  const t0 = Date.now();
  zoom(q, PG_A, 'Mesh sync');
  const sid = q.focus.sessionId;
  q.tickFocus(t0, awayFor(t0, 39), cfg);
  assert.strictEqual(idleItem(q), undefined, 'not before 40');
  const ev = logged(() => q.tickFocus(t0, awayFor(t0, 40), cfg));
  const item = idleItem(q);
  assert.ok(item, 'pushed at 40');
  assert.strictEqual(item.title, 'Still thinking?');
  assert.strictEqual(item.text, 'Mesh sync');
  assert.strictEqual(item.severity, 'needs-you');
  assert.strictEqual(item.parked, false);
  assert.strictEqual(item.notify, true, 'the one exception to Deep\'s none policy');
  assert.strictEqual(item.source.kind, 'lee');
  assert.deepStrictEqual(item.actions, ['extend', 'end_rate', 'capture', 'dismiss']);
  assert.deepStrictEqual(item.deep_idle, { session_id: sid, ends_at: new Date(t0 + 5 * MIN).toISOString(), card: { card_id: PG_A, title: 'Mesh sync' } });
  const push = ev.find((e) => e.type === 'deep.idle_push');
  assert.deepStrictEqual(push.data, { session_id: sid, ends_at: item.deep_idle.ends_at });
  assert.strictEqual(q.focusState().quiet_count, 0, 'not an agent waiting');
  // An agent's approval opened now does not supersede it, and it survives the waiting limit.
  openApproval(q);
  q.queue.recompute(t0 + 30 * MIN);
  assert.ok(idleItem(q), 'still open');
  assert.strictEqual(idleItem(q).parked, false);
  // Once per session: still away, no second push.
  const again = logged(() => q.tickFocus(t0 + MIN, awayFor(t0 + MIN, 41), cfg));
  assert.ok(!again.some((e) => e.type === 'deep.idle_push'));
  assert.strictEqual(q.snapshot({ all: true }).items.filter((i) => i.kind === 'deep_idle').length, 1);
  // Back at the machine: resolved.
  q.tickFocus(t0 + 2 * MIN, { at_machine: true, engaged: true, away_since: null }, cfg);
  assert.strictEqual(idleItem(q), undefined, 'resolved on return');
  // Away again in the same session: still no second push.
  q.tickFocus(t0 + 3 * MIN, awayFor(t0 + 3 * MIN, 42), cfg);
  assert.strictEqual(idleItem(q), undefined, 'once per session');
  q.deepEnd({ reason: 'esc' }, LEE);
});

test('Desk: no idle-end push at the machine, in quiet hours, or outside Deep', () => {
  const { q } = deskSetup();
  const t0 = Date.now();
  q.tickFocus(t0, awayFor(t0, 42), COPILOT_DEFAULTS);
  assert.strictEqual(idleItem(q), undefined, 'no Deep session');
  zoom(q, PG_A);
  q.tickFocus(t0, { at_machine: true, engaged: true, away_since: null }, COPILOT_DEFAULTS);
  assert.strictEqual(idleItem(q), undefined, 'at the machine');
  const quiet = { ...COPILOT_DEFAULTS, attention: { ...COPILOT_DEFAULTS.attention, quiet_hours: '00:00-23:59' } };
  q.tickFocus(t0, awayFor(t0, 42), quiet);
  assert.strictEqual(idleItem(q), undefined, 'quiet hours');
  // Quiet hours didn't use up the one push.
  q.tickFocus(t0, awayFor(t0, 42), COPILOT_DEFAULTS);
  assert.ok(idleItem(q));
  // The session ends some other way: the push goes with it.
  q.deepEnd({ reason: 'esc' }, LEE);
  q.tickFocus(t0, awayFor(t0, 42), COPILOT_DEFAULTS);
  assert.strictEqual(idleItem(q), undefined, 'resolved at the session\'s end');
});

test('Desk: Extend moves the idle end to now + 45 from the extension; no second push; stale and unknown items refused', () => {
  const unreg = withWindow([]);
  try {
    const { registerQueueRoutes } = require(path.join(dist, 'copilot', 'queue-routes.js'));
    const { getCopilotQueue } = require(path.join(dist, 'copilot', 'queue.js'));
    const pty = new FakePty();
    const app = fakeApp();
    registerQueueRoutes(app, { ptyManager: pty });
    const q = getCopilotQueue(pty);
    const records = [];
    q.deskSessionSink = (workspace, record) => records.push(record);
    const now = Date.now();
    zoom(q, PG_A);
    const away = awayFor(now, 41);
    q.tickFocus(now, away, COPILOT_DEFAULTS);
    const item = idleItem(q);
    const route = app.routes['POST /deep/idle-end'];
    assert.strictEqual(call(route, { body: { item_id: item.id, version: item.version, action: 'extend' }, principal: { kind: 'shared', loopback: true, ip: '127.0.0.1' } }).statusCode, 403, 'a person only');
    assert.strictEqual(call(route, { body: { item_id: item.id, version: item.version, action: 'snooze' }, principal: DEV }).statusCode, 400);
    assert.strictEqual(call(route, { body: { item_id: 'att_nope', version: 1, action: 'extend' }, principal: DEV }).statusCode, 404);
    assert.strictEqual(call(route, { body: { item_id: item.id, version: item.version + 1, action: 'extend' }, principal: DEV }).statusCode, 409, 'stale version');
    const ev = logged(() => {
      const r = call(route, { body: { item_id: item.id, version: item.version, action: 'extend' }, principal: DEV });
      assert.strictEqual(r.statusCode, 200);
      assert.strictEqual(r.body.data.source, 'deep', 'the session goes on');
    });
    const ext = ev.find((e) => e.type === 'deep.extend');
    assert.deepStrictEqual(ext.data, { session_id: q.focus.sessionId, minutes: 45, surface: 'aeronaut' });
    assert.strictEqual(idleItem(q), undefined, 'the item resolves');
    assert.strictEqual(call(route, { body: { item_id: item.id, version: item.version, action: 'extend' }, principal: DEV }).statusCode, 409, 'answered already');
    // Measured from the extension, not from away_since (which was 41 min ago).
    const ends = q.focus.deepIdleEndsAt(away, COPILOT_DEFAULTS.deep);
    assert.ok(Math.abs(ends - (now + 45 * MIN)) < 5_000, 'now + 45');
    q.tickFocus(now + 44 * MIN, away, COPILOT_DEFAULTS);
    assert.strictEqual(q.focus.source, 'deep', 'still going at +44');
    assert.strictEqual(idleItem(q), undefined, 'no second push');
    q.tickFocus(now + 46 * MIN, away, COPILOT_DEFAULTS);
    assert.strictEqual(q.focus.source, null, 'ends away at the new deadline');
    assert.deepStrictEqual(records, [], 'an answered push leaves the away record to Hester');
  } finally {
    unreg();
  }
});

test('Desk: End and rate from a device ends the session (ended_via device) and writes the Desk session record', () => {
  const { q, records } = deskSetup();
  const now = Date.now();
  zoom(q, PG_A);
  zoom(q, PG_B);
  const sid = q.focus.sessionId;
  q.tickFocus(now, awayFor(now, 40), COPILOT_DEFAULTS);
  const item = idleItem(q);
  assert.strictEqual(q.deepIdleEnd({ item_id: item.id, version: item.version, action: 'end_rate', rating: 'great' }, DEV_ACTOR).status, 400);
  const ev = logged(() => {
    const r = q.deepIdleEnd({ item_id: item.id, version: item.version, action: 'end_rate', rating: 'deep', stopped_at: '  Where the clocks disagree  ' }, DEV_ACTOR);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.active, false);
  });
  const end = ev.find((e) => e.type === 'focus.end');
  assert.deepStrictEqual(
    { reason: end.data.reason, deep_rating: end.data.deep_rating, ended_via: end.data.ended_via, stopped_at_chars: end.data.stopped_at_chars },
    { reason: 'deep_end', deep_rating: 'deep', ended_via: 'device', stopped_at_chars: 25 },
  );
  assert.ok(!JSON.stringify(ev).includes('clocks'), 'the stopped-at text never reaches the event log');
  assert.strictEqual(records.length, 1);
  const { workspace, record } = records[0];
  assert.strictEqual(workspace, '/work/api');
  assert.deepStrictEqual(
    { ...record, started_at: typeof record.started_at, ended_at: typeof record.ended_at },
    {
      focus_session_id: sid, started_at: 'string', ended_at: 'string', reason: 'device', stopped_at: 'Where the clocks disagree',
      stopped_card_id: PG_B, rating: 'deep', questions_kept: [], cards_touched: [PG_A, PG_B],
    },
  );
  assert.strictEqual(idleItem(q), undefined);
});

test('Desk: an ignored push ends the session unrated at the deadline and writes an away record', () => {
  const { q, records } = deskSetup();
  const t0 = Date.now();
  zoom(q, PG_A);
  const sid = q.focus.sessionId;
  q.tickFocus(t0, awayFor(t0, 40), COPILOT_DEFAULTS);
  assert.ok(idleItem(q));
  const ev = logged(() => q.tickFocus(t0 + 5 * MIN, awayFor(t0 + 5 * MIN, 45), COPILOT_DEFAULTS));
  const end = ev.find((e) => e.type === 'focus.end');
  assert.deepStrictEqual({ reason: end.data.reason, deep_rating: end.data.deep_rating }, { reason: 'away', deep_rating: null });
  assert.strictEqual(idleItem(q), undefined, 'resolved with the session');
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(
    { reason: records[0].record.reason, rating: records[0].record.rating, stopped_at: records[0].record.stopped_at, fs: records[0].record.focus_session_id, cards: records[0].record.cards_touched },
    { reason: 'away', rating: null, stopped_at: null, fs: sid, cards: [PG_A] },
  );
});

test('Desk: DeskSessionRelay posts to /desk/sessions, spools while Hester is offline (or older), drains in order', async () => {
  const { DeskSessionRelay } = require(path.join(dist, 'copilot', 'desk-sessions.js'));
  const spoolFile = path.join(tmpHome, '.lee', 'spool', 'desk-sessions-test.jsonl');
  const calls = [];
  let mode = 'offline';
  const hester = async (method, route, workspace, body) => {
    calls.push({ method, route, workspace, body });
    if (mode === 'offline') return { offline: true };
    if (mode === 'old') return { offline: false, status: 404, body: { detail: 'Not Found' } };
    if (mode === 'bad') return { offline: false, status: 400, body: { error: 'bad' } };
    return { offline: false, status: 201, body: { success: true, data: { id: 'ses-1', ...body } } };
  };
  const relay = new DeskSessionRelay({ spoolFile, hester, retryMs: 3_600_000 });
  const rec = (n) => ({
    focus_session_id: `fs_${n}`, started_at: '2026-09-27T09:00:00Z', ended_at: '2026-09-27T10:00:00Z', reason: 'device',
    stopped_at: null, stopped_card_id: PG_A, rating: 'mixed', questions_kept: [], cards_touched: [PG_A],
  });
  try {
    assert.strictEqual(await relay.relay('/work/api', rec(1)), 'spooled');
    mode = 'old';
    assert.strictEqual(await relay.relay('/work/api', rec(2)), 'spooled', 'a pre-Desk Hester keeps it for after the reinstall');
    assert.strictEqual(relay.pending(), 2);
    const line = JSON.parse(fs.readFileSync(spoolFile, 'utf8').split('\n')[0]);
    assert.deepStrictEqual(line, { workspace: '/work/api', record: rec(1) });
    assert.strictEqual((fs.statSync(spoolFile).mode & 0o777).toString(8), '600');
    mode = 'ok';
    calls.length = 0;
    assert.strictEqual(await relay.drain(), 2);
    assert.deepStrictEqual(calls.map((c) => [c.method, c.route, c.workspace, c.body.focus_session_id]), [
      ['POST', '/desk/sessions', '/work/api', 'fs_1'],
      ['POST', '/desk/sessions', '/work/api', 'fs_2'],
    ]);
    assert.strictEqual(relay.pending(), 0);
    assert.ok(!fs.existsSync(spoolFile));
    assert.strictEqual(await relay.relay('/work/api', rec(3)), 'sent');
    mode = 'bad';
    assert.strictEqual(await relay.relay('/work/api', rec(4)), 'rejected', 'a 400 is never retried');
    assert.strictEqual(relay.pending(), 0);
  } finally {
    relay.stop();
  }
});

test('Desk: deepAnswerEvent takes card_id, exploration_id or both, and emits both', () => {
  const { deepAnswerEvent } = require(path.join(dist, 'copilot', 'core-routes.js'));
  const base = { workspace: '/ws', answer_id: 'ans-1', status: 'done' };
  assert.deepStrictEqual(deepAnswerEvent({ ...base, card_id: PG_A, exploration_id: PG_A }), { ...base, exploration_id: PG_A, card_id: PG_A });
  assert.deepStrictEqual(deepAnswerEvent({ ...base, card_id: PG_A }), { ...base, exploration_id: PG_A, card_id: PG_A });
  assert.deepStrictEqual(deepAnswerEvent({ ...base, exploration_id: PG_A }), { ...base, exploration_id: PG_A, card_id: PG_A }, 'a page id is the card');
  assert.deepStrictEqual(deepAnswerEvent({ ...base, exploration_id: 'exp-one' }), { ...base, exploration_id: 'exp-one' }, 'pre-Desk: no card');
  assert.strictEqual(deepAnswerEvent({ ...base }), null);
});

test('Desk: the deep.* validator takes card_id or the legacy exploration_id; desk.zoom; everything else is dropped', () => {
  const { validRendererEvent } = require(path.join(dist, 'cockpit', 'tabs-main.js'));
  const counts = { view: 'page', keys: 3, clicks: 1, wheels: 0, span_ms: 5000 };
  assert.deepStrictEqual(validRendererEvent({ type: 'deep.input', data: { card_id: PG_A, card_kind: 'page', ...counts, text: 'secret' } }).data,
    { card_id: PG_A, card_kind: 'page', ...counts });
  assert.deepStrictEqual(validRendererEvent({ type: 'deep.input', data: { exploration_id: PG_A, ...counts } }).data,
    { card_id: PG_A, card_kind: 'page', ...counts }, 'a page id under the legacy name is the card');
  assert.deepStrictEqual(validRendererEvent({ type: 'deep.input', data: { exploration_id: 'exp-1', ...counts } }).data,
    { exploration_id: 'exp-1', ...counts }, 'pre-Desk renderers keep their id');
  assert.strictEqual(validRendererEvent({ type: 'deep.input', data: { card_id: 'exp-1', ...counts } }), null, 'card ids are page ids');
  assert.strictEqual(validRendererEvent({ type: 'deep.input', data: { ...counts } }), null, 'no id');
  assert.deepStrictEqual(validRendererEvent({ type: 'deep.action', data: { action: 'ask', card_id: PG_B, chars: 12, quote: 'x' } }).data,
    { action: 'ask', card_id: PG_B, card_kind: 'page', chars: 12 });
  assert.deepStrictEqual(validRendererEvent({ type: 'deep.view', data: { card_id: PG_B, view: 'page' } }).data, { card_id: PG_B, card_kind: 'page', view: 'page' });
  assert.deepStrictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: PG_A, card_kind: 'page', via: 'key', title: 'x' } }),
    { type: 'desk.zoom', data: { card_id: PG_A, card_kind: 'page', via: 'key' } });
  assert.deepStrictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: null, card_kind: null, via: 'land' } }).data,
    { card_id: null, card_kind: null, via: 'land' }, 'zooming out to the overview');
  assert.strictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: PG_A, via: 'teleport' } }), null);
  assert.strictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: 'area-00000001', via: 'click' } }), null);
  assert.strictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: PG_A, card_kind: 'board', via: 'click' } }), null);
  // B5: a Board is a card too; its kind comes from its id.
  assert.deepStrictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: 'bd-0000beef', card_kind: 'board', via: 'click' } }).data,
    { card_id: 'bd-0000beef', card_kind: 'board', via: 'click' });
  assert.strictEqual(validRendererEvent({ type: 'desk.zoom', data: { card_id: 'bd-0000beef', card_kind: 'page', via: 'click' } }), null);
  assert.deepStrictEqual(validRendererEvent({ type: 'deep.action', data: { action: 'ask', card_id: 'bd-0000beef', card_kind: 'board', chars: 3 } }).data,
    { action: 'ask', card_id: 'bd-0000beef', card_kind: 'board', chars: 3 });
});

test('Desk (B5): a zoomed Board is the session\'s card, on the touched list, and its kind is checked', () => {
  const { q } = deskSetup();
  const BD = 'bd-0000beef';
  q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: PG_A, card_kind: 'page', title: 'A' }, LEE, 'lee');
  const ev = logged(() => q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: BD, card_kind: 'board', title: 'Renders' }, LEE, 'lee'));
  assert.deepStrictEqual(ev.find((e) => e.type === 'focus.item').data.item, { kind: 'card', workspace: '/work/api', card_id: BD, card_kind: 'board', title: 'Renders' });
  assert.deepStrictEqual(q.focus.deepCards, { touched: [PG_A, BD], last: BD });
  assert.deepStrictEqual(q.snapshot({ compact: true }).deep, { exploration_id: BD, title: 'Renders', card_id: BD, card_kind: 'board' });
  // Go deep with no card keeps the Board, and its kind.
  q.deepStart({ workspace: '/work/api', exploration_id: null }, DEV_ACTOR, 'device');
  assert.strictEqual(q.focusState().item.card_kind, 'board');
  assert.strictEqual(q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: BD, card_kind: 'page' }, LEE, 'lee').status, 400, 'the kind must match the id');
  assert.strictEqual(q.deepStart({ workspace: '/work/api', exploration_id: null, card_id: 'bd-xyz' }, LEE, 'lee').status, 400);
  q.deepEnd({ reason: 'esc' }, LEE);
});

test('Desk: the launcher accepts the page origin', () => {
  const { validOrigin } = require(path.join(dist, 'cockpit', 'launcher.js'));
  assert.deepStrictEqual(validOrigin({ kind: 'page', ref: `${PG_A}#ans-1` }), { kind: 'page', ref: `${PG_A}#ans-1` });
  assert.deepStrictEqual(validOrigin({ kind: 'exploration', ref: 'exp-1#ans-1' }), { kind: 'exploration', ref: 'exp-1#ans-1' });
});

// ---------------------------------------------------------------------------
// Cockpit design §7.1: agent activity; §7.2: the user's name
// ---------------------------------------------------------------------------

const { describeActivity } = require(path.join(dist, '..', 'shared', 'cockpit.js'));

/** Run fn with Date.now() returning `clock.t`, which fn may advance. */
function withClock(fn) {
  const real = Date.now;
  const clock = { t: real() };
  Date.now = () => clock.t;
  try {
    fn(clock);
  } finally {
    Date.now = real;
  }
}

test('activity: pre and post feed the ring; now is the open tool, then the last entry for 60s', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude' }]);
  try {
    withClock((clock) => {
      hook('SessionStart');
      hook('UserPromptSubmit', { prompt: 'x' });
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' });
      let [a] = q.snapshot({ compact: true }).agents;
      assert.strictEqual(a.now.tool, 'Bash');
      assert.strictEqual(a.now.preview, 'npm test');
      assert.strictEqual(a.now.since, new Date(clock.t).toISOString());
      assert.strictEqual(describeActivity(a.now), 'Running tests');
      assert.deepStrictEqual(a.recent.map((e) => e.phase), ['pre']);

      clock.t += 5 * MIN; // a long-running tool is still "now"
      assert.strictEqual(q.snapshot().agents[0].now.tool, 'Bash');

      hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' });
      const postAt = new Date(clock.t).toISOString();
      [a] = q.snapshot().agents;
      assert.deepStrictEqual(a.now, { tool: 'Bash', preview: 'npm test', files: [], since: postAt }, 'the last entry');
      assert.deepStrictEqual(a.recent.map((e) => e.phase), ['pre', 'post']);
      assert.strictEqual(describeActivity(a.recent[1], 'past'), 'Ran tests');

      clock.t += 60_000;
      assert.ok(q.snapshot().agents[0].now, 'still now at 60s');
      clock.t += 1;
      assert.strictEqual(q.snapshot().agents[0].now, null, 'null after 60s with nothing open');
      assert.strictEqual(q.snapshot().agents[0].recent.length, 2, 'recent outlives now');
    });
  } finally {
    done();
  }
});

test('activity: the ring keeps 20; the snapshot shows the last 8, newest last', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude' }]);
  try {
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'x' });
    for (let i = 0; i < 15; i++) {
      const tool_input = { file_path: `/work/api/f${i}.ts` };
      hook('PreToolUse', { tool_name: 'Read', tool_input, tool_use_id: `r${i}` });
      hook('PostToolUse', { tool_name: 'Read', tool_input, tool_use_id: `r${i}` });
    }
    const log = q.sessions.get('s1').activity_log;
    assert.strictEqual(log.length, 20, 'capped at 20');
    assert.deepStrictEqual(log[0].files, ['/work/api/f5.ts'], 'oldest dropped first');
    const { recent, now } = q.snapshot({ compact: true }).agents[0];
    assert.strictEqual(recent.length, 8);
    assert.deepStrictEqual(recent[7], { ...recent[7], phase: 'post', files: ['/work/api/f14.ts'], writes: false });
    assert.deepStrictEqual(recent[6].files, ['/work/api/f14.ts']);
    assert.strictEqual(recent[6].phase, 'pre');
    assert.strictEqual(describeActivity(now), 'Reading f14.ts');
  } finally {
    done();
  }
});

test('activity: failures, writes, preview cap, short MCP names; only agent.tool is logged', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude' }]);
  try {
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'x' });
    const events = captureEvents(() => {
      hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/work/api/a.ts', content: 'SECRET' }, tool_use_id: 'w' });
      hook('PostToolUseFailure', { tool_name: 'Write', tool_input: { file_path: '/work/api/a.ts', content: 'SECRET' }, tool_use_id: 'w' });
      const long = 'echo ' + 'x'.repeat(500);
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: long }, tool_use_id: 'b' });
      hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: long }, tool_use_id: 'b' });
      hook('PreToolUse', { tool_name: 'mcp__lee__open_file', tool_input: {}, tool_use_id: 'm' });
    });
    assert.deepStrictEqual([...new Set(events.map((e) => e.type))], ['agent.tool'], 'no new event types');
    assert.ok(events.every((e) => !('preview' in e.data)), 'previews are never logged');
    const { recent, now } = q.snapshot().agents[0];
    assert.strictEqual(recent[0].writes, true);
    assert.strictEqual(recent[0].failed, undefined, 'pre is not failed');
    assert.strictEqual(recent[1].failed, true);
    assert.strictEqual(describeActivity(recent[1], 'past'), 'Edited a.ts (failed)');
    assert.ok(recent[2].preview.length <= 160 && recent[3].preview.length <= 160, 'previews capped at 160');
    assert.strictEqual(now.tool, 'open_file', 'MCP names shortened as last_tool is');
    assert.ok(!JSON.stringify(recent).includes('SECRET'), 'no raw tool input');
  } finally {
    done();
  }
});

test('activity: an answered AskUserQuestion keeps its question as the preview', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude' }]);
  try {
    askFlow(hook);
    const answered = { ...ASK, answers: { [ASK.questions[0].question]: ASK.questions[0].options[0].label } };
    hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: answered, tool_use_id: 'q1' });
    const { recent } = q.snapshot().agents[0];
    const post = recent[recent.length - 1];
    assert.strictEqual(post.phase, 'post');
    assert.strictEqual(post.preview, ASK.questions[0].question);
    assert.strictEqual(describeActivity(post, 'past'), 'Asked you a question');
  } finally {
    done();
  }
});

test('activity: a tool event refreshes the renderer, not devices', () => {
  const { q, hook } = setup();
  const done = withWindow([{ id: 11, ptyId: 1, label: 'Claude' }]);
  const clearTimers = () => {
    for (const t of ['wsTimer', 'ipcTimer']) if (q[t]) { clearTimeout(q[t]); q[t] = null; }
  };
  const orig = copilotBus.broadcast;
  copilotBus.broadcast = () => {};
  try {
    q.started = true;
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'x' });
    clearTimers();
    q.broadcastSnapshot();
    hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: 't1' });
    assert.ok(q.ipcTimer, 'renderer push scheduled');
    clearTimers();
    assert.strictEqual(q.broadcastSnapshot(), false, 'devices are not pushed for a tool event');
    q.tick(); // nothing changed: no renderer push either
    assert.strictEqual(q.ipcTimer, null);
  } finally {
    copilotBus.broadcast = orig;
    clearTimers();
    q.started = false;
    done();
  }
});

test('userName: app.user_name, else the first word of id -F (read once), else null', async () => {
  const { UserNameResolver, firstWord, configUserName } = require(path.join(dist, 'user-name.js'));
  let reads = 0;
  const mac = new UserNameResolver(async () => { reads++; return '  Ben  Example '; });
  assert.strictEqual(await mac.resolve({ app: { user_name: ' Benjamin ' } }), 'Benjamin', 'config wins');
  assert.strictEqual(reads, 0, 'id -F not run when the config names you');
  assert.strictEqual(await mac.resolve({ app: { user_name: '  ' } }), 'Ben', 'blank config falls through');
  assert.strictEqual(await mac.resolve(null), 'Ben');
  assert.strictEqual(await mac.resolve({ app: {} }), 'Ben');
  assert.strictEqual(reads, 1, 'cached');
  assert.strictEqual(await new UserNameResolver(async () => null).resolve({}), null, 'nothing: null');
  assert.strictEqual(await new UserNameResolver(async () => { throw new Error('no id'); }).resolve({}), null, 'failure: null');
  assert.strictEqual(await new UserNameResolver(async () => '').resolve({ app: { user_name: 42 } }), null, 'non-string config ignored');
  assert.strictEqual(firstWord('Ada Lovelace'), 'Ada');
  assert.strictEqual(configUserName({ app: { user_name: 'Ada' } }), 'Ada');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
    }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
