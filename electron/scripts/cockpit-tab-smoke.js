#!/usr/bin/env node
/**
 * Smoke test for package A (lee-tab), contract §13 A: output ring, OSC
 * parser, the §5.1 state table, send rules per principal and state, command
 * capture without text in the event log, buildClaudeArgs, a hook-path
 * check-in, the `tab` domain's C3 table and the task relay spool.
 *
 *   cd electron && npm run build:main && node scripts/cockpit-tab-smoke.js
 *
 * `electron` is stubbed and HOME points at a temp dir, so nothing under the
 * real ~/.lee is read or written. No real PTYs, agents or Lee ports.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-cockpit-tab-smoke-'));
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
const cockpit = (m) => require(path.join(dist, 'cockpit', m));
const { OutputRing, stripAnsi } = cockpit('output-ring.js');
const { ShellOscParser, escapeCommandLine } = cockpit('shell-osc.js');
const { decideTabState, HOOK_STALE_MS } = cockpit('tab-state.js');
const { commandSig, commandArgv0, normalizeCommand } = cockpit('command-history.js');
const { withShellIntegration } = cockpit('shell-integration.js');
const { TabRuntimeImpl } = cockpit('tab-runtime.js');
const { CheckinManager } = cockpit('checkin.js');
const { buildClaudeArgs, launchPlan, TaskLauncherImpl } = cockpit('launcher.js');
const { TaskRelay } = cockpit('task-relay.js');
const { createTabDomain } = cockpit('tab-domain.js');
const { validRendererEvent } = cockpit('tabs-main.js');
const { withPiExtension, installPiExtension, PI_EXTENSION } = cockpit('pi-extension.js');
const { cockpitBus } = cockpit('cockpit-bus.js');
const { copilotBus, logEvent } = require(path.join(dist, 'copilot', 'bus.js'));
const { windowRegistry } = require(path.join(dist, 'window-registry.js'));
const { CHECKIN_PROMPT } = require(path.join(dist, '..', 'shared', 'cockpit.js'));

const events = [];
copilotBus.on('event', (e) => events.push(e));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('ok -', name);
}

const LOCAL = { kind: 'local-user' };
const HESTER = { kind: 'shared', loopback: true, ip: '127.0.0.1' };
const LAN = { kind: 'shared', loopback: false, ip: '192.168.1.9' };
const DEVICE = { kind: 'device', device_id: 'd1', name: 'Phone', device_kind: 'aeronaut', ip: '192.168.1.8' };
const WS = path.join(tmpHome, 'work');
fs.mkdirSync(WS, { recursive: true });

class FakePty {
  constructor() {
    this.procs = new Map();
    this.writes = [];
    this.listeners = { data: [], exit: [] };
  }
  add(id, opts = {}) {
    this.procs.set(id, { id, name: opts.name ?? `PTY ${id}`, windowId: opts.windowId ?? 1, claude: !!opts.claude, pty: { process: opts.fg ?? null } });
  }
  on(ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  emit(ev, ...args) {
    for (const fn of this.listeners[ev] || []) fn(...args);
  }
  get(id) {
    return this.procs.get(id);
  }
  getAll() {
    return [...this.procs.values()];
  }
  write(id, data) {
    this.writes.push([id, data]);
  }
  isClaudePty(id) {
    return this.procs.get(id)?.claude === true;
  }
  isWarmPty() {
    return false;
  }
  getAgentDefinition(provider) {
    return provider === 'screenbot' ? { command: 'sb', name: 'SB', prompt_pattern: '^> $', awaiting_pattern: 'Allow\\?' } : null;
  }
  getTUIDefinition() {
    return null;
  }
  log() {}
}

const sentToWindow = [];
const tabs = [];
const bw = {
  id: 1,
  isDestroyed: () => false,
  isMinimized: () => false,
  restore() {},
  focus() {},
  webContents: { send: (channel, payload) => sentToWindow.push([channel, payload]) },
};
windowRegistry.register(bw, WS, { getContext: () => ({ workspace: WS, tabs, panels: {}, focusedPanel: 'center' }) });

function hook(type, ptyId, data = {}) {
  logEvent({ type, source: 'hook', workspace: WS, data: { pty_id: ptyId, session_id: `s-${ptyId}`, ...data } });
}

async function main() {
  // -------------------------------------------------------------------------
  await check('ring: cursor, since, truncated, lines', () => {
    const r = new OutputRing(1024);
    r.append('hello\nworld\n');
    assert.strictEqual(r.cursor, 12);
    assert.deepStrictEqual(r.read({ since: 6 }), { text: 'world\n', cursor: 12, truncated: false });
    assert.deepStrictEqual(r.read({ since: 12 }), { text: '', cursor: 12, truncated: false });
    const big = 'x'.repeat(2000) + '\nlast line\n';
    r.append(big);
    const t = r.read({ since: 0 });
    assert.strictEqual(t.truncated, true);
    assert.ok(t.text.endsWith('last line\n'));
    assert.strictEqual(r.cursor, 12 + big.length);
    assert.deepStrictEqual(r.read({ lines: 1 }).text, 'last line');
    const paged = r.read({ since: r.cursor - 10, max_chars: 4 });
    assert.strictEqual(paged.cursor, r.cursor - 6);
  });

  await check('ring: ANSI, OSC, \\r and backspace stripping', () => {
    assert.strictEqual(stripAnsi('\x1b[1;31mred\x1b[0m plain'), 'red plain');
    assert.strictEqual(stripAnsi('a\x1b]133;A\x07b\x1b]7;file://h/x\x1b\\c'), 'abc');
    assert.strictEqual(stripAnsi('progress 10%\rprogress 99%\r\ndone'), 'progress 99%\ndone');
    assert.strictEqual(stripAnsi('abx\bc'), 'abc');
    assert.strictEqual(stripAnsi('\x1b(Bok\x1b=\x07'), 'ok');
    const r = new OutputRing(4096);
    r.append('\x1b[32m$ \x1b[0mls\r\nfile1\r\nfile2\r\n');
    assert.deepStrictEqual(r.tailLines(2), ['file1', 'file2']);
  });

  // -------------------------------------------------------------------------
  await check('OSC parser: sequences split across chunks', () => {
    const p = new ShellOscParser();
    const stream =
      'prompt$ \x1b]633;E;' + escapeCommandLine('echo "a;b" \\ c\tx') + '\x07\x1b]133;C\x07output\n' +
      '\x1b]133;D;3\x07\x1b]133;A\x07\x1b]7;file://host/Users/me/my%20dir\x1b\\\x1b]133;B\x07\x1b]1337;Other\x07';
    const out = [];
    for (let i = 0; i < stream.length; i += 3) out.push(...p.feed(stream.slice(i, i + 3)));
    assert.deepStrictEqual(out, [
      { type: 'command-line', text: 'echo "a;b" \\ c\tx' },
      { type: 'command-start' },
      { type: 'command-end', exit_code: 3 },
      { type: 'prompt-start' },
      { type: 'cwd', path: '/Users/me/my dir', host: 'host' },
      { type: 'prompt-end' },
    ]);
    assert.deepStrictEqual(new ShellOscParser().feed('\x1b]133;D\x07'), [{ type: 'command-end', exit_code: null }]);
  });

  // -------------------------------------------------------------------------
  await check('state table: every row of §5.1', () => {
    const base = {
      exists: true, kind: 'agent', hook: null, integration: false, inCommand: false, lastLines: [],
      promptPattern: null, awaitingPattern: null, quietMs: 10_000, quietThreshold: 1500, foreground: null, shellName: null,
    };
    const d = (o) => decideTabState({ ...base, ...o });
    assert.deepStrictEqual(d({ exists: false }), { state: 'exited', source: 'none' });
    assert.deepStrictEqual(d({ hook: 'prompt', quietMs: 10 }), { state: 'busy', source: 'hooks' });
    assert.deepStrictEqual(d({ hook: 'tool', quietMs: 10 }), { state: 'busy', source: 'hooks' });
    assert.deepStrictEqual(d({ hook: 'tool', quietMs: HOOK_STALE_MS }), { state: 'unknown', source: 'hooks' });
    assert.deepStrictEqual(d({ hook: 'waiting' }), { state: 'awaiting-input', source: 'hooks' });
    assert.deepStrictEqual(d({ hook: 'turn_end' }), { state: 'idle-at-prompt', source: 'hooks' });
    assert.deepStrictEqual(d({ hook: 'session_start' }), { state: 'idle-at-prompt', source: 'hooks' });
    assert.deepStrictEqual(d({ kind: 'shell', integration: true, inCommand: true, quietMs: 0 }), { state: 'busy', source: 'shell-integration' });
    assert.deepStrictEqual(d({ kind: 'shell', integration: true }), { state: 'idle-at-prompt', source: 'shell-integration' });
    const pat = { promptPattern: /^> $/m, awaitingPattern: /Allow\?/m };
    assert.deepStrictEqual(d({ ...pat, lastLines: ['Allow? (y/n)'] }), { state: 'awaiting-input', source: 'pattern' });
    assert.deepStrictEqual(d({ ...pat, lastLines: ['> '] }), { state: 'idle-at-prompt', source: 'pattern' });
    assert.deepStrictEqual(d({ ...pat, kind: 'tui', lastLines: ['> '] }), { state: 'idle-at-prompt', source: 'pattern' });
    assert.deepStrictEqual(d({ ...pat, lastLines: ['> '], quietMs: 100 }), { state: 'busy', source: 'quiet' });
    const sh = { kind: 'shell', shellName: 'zsh' };
    assert.deepStrictEqual(d({ ...sh, foreground: 'zsh' }), { state: 'idle-at-prompt', source: 'foreground' });
    assert.deepStrictEqual(d({ ...sh, foreground: 'npm' }), { state: 'busy', source: 'foreground' });
    assert.deepStrictEqual(d({ ...sh, foreground: 'zsh', quietMs: 100 }), { state: 'busy', source: 'foreground' });
    assert.deepStrictEqual(d({ kind: 'tui', quietMs: 100 }), { state: 'busy', source: 'quiet' });
    assert.deepStrictEqual(d({ kind: 'tui' }), { state: 'unknown', source: 'quiet' });
  });

  // -------------------------------------------------------------------------
  const host = new FakePty();
  let clock = Date.now();
  const rt = new TabRuntimeImpl(host, { now: () => clock });
  // 1: Claude with hooks; 2: login shell with integration; 3: hook-less "screen" agent.
  host.add(1, { claude: true, name: 'Claude' });
  tabs.push({ id: 11, type: 'terminal', label: 'Fix the bug', ptyId: 1, dockPosition: 'center', state: 'active' });
  host.add(2, { name: 'Terminal', fg: 'zsh' });
  withShellIntegration('/bin/zsh', ['-l'], { LEE_PTY_ID: '2' }, true);
  tabs.push({ id: 12, type: 'terminal', label: 'Terminal 1', ptyId: 2, dockPosition: 'center', state: 'active' });
  host.add(3, { name: 'SB' });
  tabs.push({ id: 13, type: 'agent', provider: 'screenbot', label: 'Screenbot', ptyId: 3, dockPosition: 'center', state: 'active' });

  await check('runtime: kinds, fidelity, list by workspace', () => {
    const list = rt.list(WS);
    assert.deepStrictEqual(list.map((t) => [t.pty_id, t.kind, t.fidelity]), [
      [1, 'agent', 'structured'],
      [2, 'shell', 'activity'],
      [3, 'agent', 'screen'],
    ]);
    assert.strictEqual(list[0].label, 'Fix the bug');
    assert.strictEqual(list[2].provider, 'screenbot');
    assert.deepStrictEqual(rt.list('/elsewhere'), []);
  });

  await check('runtime: Hester chat and DevOps tabs are own tabs, not agents', () => {
    const h2 = new FakePty();
    const rt2 = new TabRuntimeImpl(h2, { now: () => clock });
    h2.add(91, { name: 'Hester' });
    h2.add(92, { name: 'DevOps' });
    const loc = (tab) => ({ window_id: 1, tab, workspace: WS });
    assert.strictEqual(rt2.kindOf(91, loc({ id: 91, type: 'agent', provider: 'hester', label: 'Hester', ptyId: 91, dockPosition: 'center', state: 'active' })), 'tui');
    assert.strictEqual(rt2.kindOf(92, loc({ id: 92, type: 'devops', label: 'DevOps', ptyId: 92, dockPosition: 'center', state: 'active' })), 'tui');
    assert.strictEqual(rt2.kindOf(3, loc({ id: 13, type: 'agent', provider: 'screenbot', label: 'Screenbot', ptyId: 3, dockPosition: 'center', state: 'active' })), 'agent');
  });

  await check('runtime: pattern state for a hook-less agent', () => {
    host.emit('data', 3, 'thinking...\r\n> ');
    clock += 2000;
    assert.strictEqual(rt.state(3).state, 'idle-at-prompt');
    assert.strictEqual(rt.state(3).source, 'pattern');
    assert.deepStrictEqual(rt.get(3).tail, ['thinking...', '> ']);
    host.emit('data', 3, '\r\nAllow? (y/n)');
    clock += 2000;
    assert.strictEqual(rt.state(3).state, 'awaiting-input');
  });

  await check('send: agent states and principals', async () => {
    host.writes.length = 0;
    hook('agent.session_start', 1, { provider: 'claude' });
    hook('agent.prompt', 1);
    assert.strictEqual(rt.state(1).state, 'busy');
    assert.deepStrictEqual(await rt.send(1, { text: 'hi', submit: true }, LOCAL), { success: false, error: 'busy', state: 'busy' });
    hook('agent.waiting', 1, { kind: 'approval' });
    assert.strictEqual((await rt.send(1, { text: 'hi' }, DEVICE)).error, 'awaiting_input');
    assert.strictEqual((await rt.send(1, { text: 'hi' }, HESTER)).error, 'forbidden');
    assert.strictEqual((await rt.send(1, { text: 'hi', purpose: 'operation' }, HESTER)).error, 'forbidden');
    hook('agent.turn_end', 1, { busy_ms: 5 });
    hook('agent.waiting', 1, { kind: 'waiting' });
    assert.strictEqual(rt.state(1).state, 'idle-at-prompt', 'idle notice after a turn stays idle');
    assert.strictEqual((await rt.send(1, { text: '   ' }, LOCAL)).error, 'invalid');
    assert.strictEqual((await rt.send(1, { text: 'x'.repeat(4001) }, LOCAL)).error, 'invalid');
    assert.strictEqual(host.writes.length, 0, 'nothing typed while refused');
    const ok = await rt.send(1, { text: 'line one\nline two\x07', submit: true, purpose: 'reply' }, LOCAL);
    assert.deepStrictEqual(ok, { success: true, state: 'idle-at-prompt', chars: 17 });
    assert.deepStrictEqual(host.writes, [[1, '\x1b[200~line one\nline two\x1b[201~'], [1, '\r']]);
    const ev = events.filter((e) => e.type === 'tab.input').pop();
    assert.deepStrictEqual(ev.data, { pty_id: 1, tab_id: 11, target_kind: 'agent', purpose: 'reply', chars: 17, submit: true });
    assert.ok(!JSON.stringify(ev).includes('line one'));
    // unknown: refused unless forced by the local user
    hook('agent.session_end', 1);
    host.emit('data', 1, 'x');
    clock += 5000;
    assert.strictEqual(rt.state(1).state, 'unknown');
    assert.strictEqual((await rt.send(1, { text: 'hi' }, DEVICE)).error, 'state_unknown');
    assert.strictEqual((await rt.send(1, { text: 'hi', force: true }, DEVICE)).error, 'state_unknown');
    assert.strictEqual((await rt.send(1, { text: 'hi', force: true }, LOCAL)).success, true);
  });

  const sig = commandSig('echo   done');
  await check('shell: integration state, send rules, command capture without text', async () => {
    host.writes.length = 0;
    const signals = [];
    const off = cockpitBus.onTerminal((s) => signals.push(s));
    host.emit('data', 2, `\x1b]133;A\x07\x1b]7;file://h${WS}/sub\x07$ `);
    assert.strictEqual(rt.state(2).state, 'idle-at-prompt');
    assert.strictEqual(rt.state(2).source, 'shell-integration');
    assert.strictEqual((await rt.send(2, { text: 'ls\nrm -rf /' }, LOCAL)).error, 'invalid');
    assert.strictEqual((await rt.send(2, { text: 'ls' }, HESTER)).error, 'forbidden');
    assert.strictEqual((await rt.send(2, { text: 'ls' }, LAN)).error, 'forbidden');
    assert.strictEqual((await rt.send(2, { text: 'npm run build', submit: true, purpose: 'operation' }, HESTER)).success, true);
    host.emit('data', 2, `\x1b]633;E;${escapeCommandLine('npm run build')}\x07\x1b]133;C\x07building\n`);
    assert.strictEqual(rt.state(2).state, 'busy');
    assert.strictEqual((await rt.send(2, { text: 'ls', purpose: 'operation' }, LOCAL)).error, 'busy');
    assert.strictEqual((await rt.send(2, { text: 'q', purpose: 'manual' }, LOCAL)).success, true, 'a human may type into a busy shell');
    clock += 1234;
    host.emit('data', 2, '\x1b]133;D;0\x07\x1b]133;A\x07$ ');
    assert.strictEqual(signals.length, 2);
    assert.strictEqual(signals[0].phase, 'start');
    assert.strictEqual(signals[1].by, 'lee');
    assert.strictEqual(signals[1].exit_code, 0);
    assert.strictEqual(signals[1].duration_ms, 1234);
    // A hand-typed command.
    host.emit('data', 2, `\x1b]633;E;${escapeCommandLine('FOO=1 sudo echo   done')}\x07\x1b]133;C\x07done\n\x1b]133;D;2\x07`);
    off();
    const cmds = events.filter((e) => e.type === 'terminal.command');
    assert.strictEqual(cmds.length, 2);
    const last = cmds[1];
    assert.strictEqual(last.data.argv0, 'echo');
    assert.strictEqual(last.data.by, 'user');
    assert.strictEqual(last.data.exit_code, 2);
    assert.strictEqual(last.data.cwd_rel, 'sub');
    assert.strictEqual(last.data.sig, commandSig('FOO=1 sudo echo done'));
    assert.strictEqual(cmds[0].data.by, 'lee');
    assert.deepStrictEqual(cmds[0].actor, { kind: 'system' });
    assert.ok(!JSON.stringify(events).includes('npm run build'), 'no command text in any event');
    assert.ok(!JSON.stringify(events).includes('sudo echo'), 'no command text in any event');
    assert.strictEqual(rt.commandText(WS, last.data.sig), 'FOO=1 sudo echo   done');
    const info = rt.get(2);
    assert.strictEqual(info.last_command.text, 'FOO=1 sudo echo   done');
    assert.strictEqual(rt.get(2, { withText: false }).last_command.text, null);
    assert.strictEqual(info.cwd, `${WS}/sub`);
    assert.strictEqual(normalizeCommand('  a   b '), 'a b');
    assert.strictEqual(commandArgv0('A=1 B=2 env time /usr/bin/python3 x.py'), 'python3');
    assert.strictEqual(sig.length, 12);
  });

  // -------------------------------------------------------------------------
  await check('buildClaudeArgs: prompt after --, session id, mode per lead, tools joined', () => {
    const a = buildClaudeArgs(
      { workspace: WS, prompt: '- fix it', title: 'Fix', tools: ['Bash', 'Read'], allowed_tools: ['Read', 'Bash(ls:*)'], model: 'haiku' },
      { session_id: 'uuid-1', slug: 'fix-abcd' },
    );
    assert.deepStrictEqual(a, [
      '--permission-mode', 'acceptEdits', '--worktree', 'fix-abcd', '--session-id', 'uuid-1', '-n', 'Fix',
      '--model', 'haiku', '--tools', 'Bash,Read', '--allowedTools', 'Read,Bash(ls:*)', '--', '- fix it',
    ]);
    const plan = buildClaudeArgs({ workspace: WS, lead: 'plan', prompt: 'think about x' }, { session_id: 's' });
    assert.deepStrictEqual(plan, ['--permission-mode', 'plan', '--session-id', 's', '-n', 'think about x', '--', 'think about x']);
    const manual = buildClaudeArgs({ workspace: WS, permission_mode: 'manual', worktree: false }, { session_id: 's' });
    assert.deepStrictEqual(manual, ['--permission-mode', 'manual', '--session-id', 's', '-n', 'Task']);
    assert.strictEqual(launchPlan({ workspace: WS }, { worktree_for_delegate: false }).worktree, false);
  });

  // -------------------------------------------------------------------------
  const checkins = new CheckinManager(rt, { pollMs: 20, screenPollMs: 20 });
  await check('check-in: hook path resolved by agent.turn_end', async () => {
    hook('agent.session_start', 1, { provider: 'claude' });
    host.writes.length = 0;
    const lee = { status: 'in-progress', summary: 'Halfway through', blockers: null, files: [], next: 'tests' };
    setTimeout(() => hook('agent.turn_end', 1, { busy_ms: 10, summary: 'Working on it', lee_status: lee }), 60);
    const res = await checkins.checkin(1, { by: LOCAL });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.source, 'hook');
    assert.deepStrictEqual(res.lee_status, lee);
    assert.strictEqual(res.summary, 'Halfway through');
    assert.strictEqual(host.writes[0][1], `\x1b[200~${CHECKIN_PROMPT}\x1b[201~`);
    const start = events.filter((e) => e.type === 'checkin.start').pop();
    const result = events.filter((e) => e.type === 'checkin.result').pop();
    assert.strictEqual(start.data.source, 'hook');
    assert.strictEqual(result.data.ok, true);
    assert.deepStrictEqual(result.data.lee_status, lee);
    const feed = cockpitBus.feed.list(WS).find((e) => e.producer === 'checkin' && e.title.startsWith('Checked in'));
    assert.ok(feed && feed.text_is_agent);
  });

  await check('check-in: awaiting input refuses and types nothing', async () => {
    hook('agent.waiting', 1, { kind: 'approval' });
    host.writes.length = 0;
    const res = await checkins.checkin(1, { by: LOCAL });
    assert.strictEqual(res.error, 'awaiting_input');
    assert.strictEqual(host.writes.length, 0);
    assert.strictEqual((await checkins.checkin(2, { by: LOCAL })).error, 'not_agent');
    assert.strictEqual((await checkins.checkin(1, { by: HESTER })).error, 'forbidden');
  });

  // -------------------------------------------------------------------------
  const domain = createTabDomain(rt, checkins);
  await check('tab domain: C3 table', async () => {
    hook('agent.turn_end', 1, { busy_ms: 1 });
    const before = events.filter((e) => e.type === 'tab.read').length;
    const read = await domain('read_output', { pty_id: 2, lines: 20 }, HESTER);
    assert.strictEqual(read.status, 200);
    assert.ok(typeof read.body.data.cursor === 'number' && read.body.data.text.includes('done'));
    assert.strictEqual(events.filter((e) => e.type === 'tab.read').length, before + 1);
    await domain('read_output', { pty_id: 2, lines: 5 }, HESTER);
    const reads = cockpitBus.feed.list(WS).filter((e) => e.title.startsWith('Hester read Terminal 1'));
    assert.strictEqual(reads.length, 1, 'deduped per PTY');
    assert.strictEqual((await domain('send_input', { pty_id: 1, text: 'hi' }, HESTER)).status, 403);
    assert.strictEqual((await domain('send_input', { pty_id: 2, text: 'ls' }, HESTER)).status, 403);
    assert.strictEqual((await domain('list', {}, LAN)).status, 403);
    const list = await domain('list', { workspace: WS }, HESTER);
    assert.strictEqual(list.body.data.find((t) => t.pty_id === 2).last_command.text, null);
    host.writes.length = 0;
    const ci = await domain('checkin', { pty_id: 1 }, HESTER);
    assert.strictEqual(ci.status, 202);
    assert.strictEqual(ci.body.data.proposed, true);
    assert.strictEqual(host.writes.length, 0, 'Hester never types');
    const prop = cockpitBus.feed.get(ci.body.data.entry_id);
    assert.strictEqual(prop.kind, 'proposal');
    assert.strictEqual(prop.actions[0].confirm_text, CHECKIN_PROMPT);
    assert.strictEqual((await cockpitBus.actOnFeed(prop.id, 'checkin', {}, HESTER)).error, 'forbidden');
    assert.strictEqual((await domain('state', { tab_id: 12 }, HESTER)).body.data.pty_id, 2);
    assert.strictEqual((await domain('state', { pty_id: 99 }, HESTER)).status, 404);
    assert.strictEqual((await domain('send_input', { pty_id: 2, text: 'ls' }, DEVICE)).status, 200);
    const proposed = events.filter((e) => e.type === 'checkin.proposed').pop();
    assert.deepStrictEqual(proposed.data, { pty_id: 1, reason: 'hester', entry_id: prop.id });
  });

  await check('renderer events: valid shapes only', () => {
    assert.ok(validRendererEvent({ type: 'cockpit.mode', data: { from: 'cockpit', to: 'workbench', reason: 'go_into' } }));
    assert.ok(validRendererEvent({ type: 'cockpit.go_into', data: { pty_id: 3, agent_state: 'busy', from: 'tile' } }));
    assert.strictEqual(validRendererEvent({ type: 'cockpit.mode', data: { from: 'x', to: 'workbench', reason: 'manual' } }), null);
    assert.strictEqual(validRendererEvent({ type: 'agent.prompt', data: {} }), null);
  });

  // -------------------------------------------------------------------------
  const closedPort = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  let hesterPort = closedPort;
  const spool = path.join(tmpHome, '.lee', 'spool', 'tasks.jsonl');
  const relay = new TaskRelay({ getHesterPort: () => hesterPort, getSharedToken: () => 'tok' });
  const launcher = new TaskLauncherImpl(rt, relay);

  const LONG_PROMPT = 'Fix the login redirect loop on the settings page after a session expires. SECRET-TAIL';
  await check('launch: Claude tab via the create-tab bridge, record spooled without the prompt', async () => {
    sentToWindow.length = 0;
    const origSend = bw.webContents.send;
    bw.webContents.send = (channel, payload) => {
      sentToWindow.push([channel, payload]);
      if (channel === 'cockpit:create-tab') {
        setTimeout(() => {
          host.add(7, { claude: true, name: payload.label });
          tabs.push({ id: 17, type: 'terminal', label: payload.label, ptyId: 7, dockPosition: 'center', state: 'idle' });
          rt.resolveCreateTab({ request_id: payload.request_id, tab_id: 17, pty_id: 7 });
        }, 10);
      }
    };
    const res = await launcher.launch({ workspace: WS, prompt: LONG_PROMPT, kind: 'bug' }, LOCAL, 1);
    bw.webContents.send = origSend;
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.pty_id, 7);
    assert.strictEqual(res.relayed, false);
    assert.ok(/^task-[0-9a-f]{8}$/.test(res.task_id));
    const req = sentToWindow.find(([c]) => c === 'cockpit:create-tab')[1];
    assert.strictEqual(req.command, 'claude');
    assert.strictEqual(req.activate, false);
    assert.ok(req.args.includes('--session-id') && req.args.includes(res.session_id));
    assert.deepStrictEqual(req.args.slice(-2), ['--', LONG_PROMPT]);
    const lines = fs.readFileSync(spool, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.id, res.task_id);
    assert.strictEqual(rec.status, 'running');
    assert.strictEqual(rec.confirmed, true);
    assert.deepStrictEqual(rec.agent, { provider: 'claude', pty_id: 7, session_id: res.session_id, tab_label: rec.title, model: null });
    assert.strictEqual(rec.title, LONG_PROMPT.slice(0, 60).trim(), 'title defaults to the first 60 characters');
    assert.ok(!fs.readFileSync(spool, 'utf8').includes('SECRET-TAIL'), 'prompt never spooled');
    assert.strictEqual(fs.statSync(spool).mode & 0o777, 0o600);
    const ev = events.filter((e) => e.type === 'task.launch').pop();
    assert.strictEqual(ev.data.task_id, res.task_id);
    assert.ok(!JSON.stringify(events).includes('Fix the login'), 'prompt and title never logged');
    assert.strictEqual(rt.get(7).task_id, res.task_id);
    assert.strictEqual((await launcher.launch({ workspace: WS, prompt: 'x' }, HESTER, 1)).error, 'forbidden');
    assert.strictEqual((await launcher.launch({ workspace: '/not/open', prompt: 'x' }, LOCAL, 1)).success, false);
  });

  await check('launch: human lead relays a queued task; spool drains when Hester is up', async () => {
    const res = await launcher.launch({ workspace: WS, title: 'Write the doc', lead: 'human' }, LOCAL, 1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.pty_id, null);
    assert.strictEqual(relay.pending(), 2);
    const got = [];
    const server = http.createServer((req, res2) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ url: req.url, auth: req.headers.authorization, ws: req.headers['x-lee-workspace'], body: JSON.parse(body) });
        res2.writeHead(201, { 'Content-Type': 'application/json' });
        res2.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    hesterPort = server.address().port;
    assert.strictEqual(await relay.drain(), 2);
    server.close();
    assert.strictEqual(relay.pending(), 0);
    assert.ok(!fs.existsSync(spool));
    assert.strictEqual(got[0].url, '/cockpit/tasks');
    assert.strictEqual(got[0].auth, 'Bearer tok');
    assert.strictEqual(got[0].ws, WS);
    assert.strictEqual(got[1].body.status, 'queued');
    assert.strictEqual(got[1].body.agent, null);
    relay.stop();
  });

  await check('create-tab fallback: v0 system:create-tab when no bridge answers', async () => {
    const origSend = bw.webContents.send;
    const seen = [];
    bw.webContents.send = (channel, payload) => {
      seen.push(channel);
      if (channel === 'system:create-tab') setTimeout(() => host.add(8, { name: payload.label }), 20);
    };
    const r = await rt.openTab(
      { workspace: WS, type: 'terminal', label: '▶ build', command: 'npm', args: ['run', 'build'] },
      { timeouts: { result: 50, fallback: 2000 } },
    );
    bw.webContents.send = origSend;
    assert.deepStrictEqual(seen, ['cockpit:create-tab', 'system:create-tab']);
    assert.strictEqual(r.pty_id, 8);
  });

  await check('Pi: extension file written; --extension prepended for pi only', () => {
    const file = installPiExtension(tmpHome);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), PI_EXTENSION);
    assert.deepStrictEqual(withPiExtension('/opt/homebrew/bin/pi', ['--model', 'x']), ['--extension', file, '--model', 'x']);
    assert.deepStrictEqual(withPiExtension('/opt/homebrew/bin/pi', ['--extension', file]), ['--extension', file]);
    assert.deepStrictEqual(withPiExtension('claude', ['a']), ['a']);
    fs.writeFileSync(path.join(tmpHome, '.lee', 'config.yaml'), 'copilot:\n  hooks:\n    pi: false\n');
    assert.strictEqual(installPiExtension(tmpHome), null);
    assert.deepStrictEqual(withPiExtension('/opt/homebrew/bin/pi', []), []);
    fs.rmSync(path.join(tmpHome, '.lee', 'config.yaml'));
  });

  rt.stop();
  checkins.stop();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
