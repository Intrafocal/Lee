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
    // OSC 133 from ssh/a nested shell: at-prompt only while the shell itself is in the foreground.
    assert.deepStrictEqual(d({ kind: 'shell', integration: true, shellName: 'zsh', foreground: 'ssh' }), { state: 'busy', source: 'foreground' });
    assert.deepStrictEqual(d({ kind: 'shell', integration: true, shellName: 'zsh', foreground: '-zsh' }), { state: 'idle-at-prompt', source: 'shell-integration' });
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

  await check('X-Lee-Workspace: only % and non-ASCII are percent-encoded (matches Hester)', () => {
    const { encodeWorkspaceHeader } = require(path.join(dist, '..', 'shared', 'cockpit.js'));
    assert.strictEqual(encodeWorkspaceHeader('/Users/me/My Project'), '/Users/me/My Project');
    assert.strictEqual(encodeWorkspaceHeader('/tmp/caf\u00e9 100%'), '/tmp/caf%C3%A9 100%25');
    assert.strictEqual(encodeWorkspaceHeader('/w/\u30d7\ud83d\ude00'), '/w/%E3%83%97%F0%9F%98%80');
  });

  await check('runtime: a shell running a hand-started claude/pi is an agent (tab type terminal)', () => {
    const { agentFromProcess } = cockpit('tab-runtime.js');
    assert.strictEqual(agentFromProcess('claude'), 'claude');
    assert.strictEqual(agentFromProcess('/usr/local/bin/pi'), 'pi');
    assert.strictEqual(agentFromProcess('zsh'), null);
    assert.strictEqual(agentFromProcess(null), null);
    host.add(40, { name: 'Terminal', fg: 'zsh' });
    withShellIntegration('/bin/zsh', ['-l'], { LEE_PTY_ID: '40' }, true);
    tabs.push({ id: 140, type: 'terminal', label: 'Terminal 4', ptyId: 40, dockPosition: 'center', state: 'active' });
    assert.deepStrictEqual([rt.get(40).kind, rt.get(40).provider], ['shell', null]);
    host.get(40).pty.process = 'claude';
    assert.deepStrictEqual([rt.get(40).kind, rt.get(40).provider, rt.get(40).tab_type], ['agent', 'claude', 'terminal']);
    host.get(40).pty.process = 'pi';
    assert.strictEqual(rt.get(40).provider, 'pi');
    // Quitting the agent makes it a shell again (the renderer's wall follows A's kind).
    host.get(40).pty.process = 'zsh';
    assert.strictEqual(rt.get(40).kind, 'shell');
    let pushed = 0;
    const onChange = () => pushed++;
    rt.on('change', onChange);
    host.get(40).pty.process = 'claude';
    rt.tick();
    rt.off('change', onChange);
    assert.ok(pushed >= 1, 'a kind change is pushed to the renderer');
    host.procs.delete(40);
    tabs.splice(tabs.findIndex((t) => t.id === 140), 1);
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
    // force means "state unknown" only; while_busy is local-user only.
    assert.strictEqual((await rt.send(1, { text: 'hi', force: true }, LOCAL)).error, 'busy', 'force never types into a busy agent');
    assert.strictEqual((await rt.send(1, { text: 'hi', while_busy: true }, DEVICE)).error, 'busy', 'a device never types while busy');
    host.writes.length = 0;
    assert.strictEqual((await rt.send(1, { text: 'hi', while_busy: true }, LOCAL)).success, true, 'you, in Lee, may type while busy');
    host.writes.length = 0;
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
      '--permission-mode', 'auto', '--worktree', 'fix-abcd', '--session-id', 'uuid-1', '--name', 'Fix',
      '--model', 'haiku', '--tools', 'Bash,Read', '--allowedTools', 'Read,Bash(ls:*)', '--', '- fix it',
    ]);
    const plan = buildClaudeArgs({ workspace: WS, lead: 'plan', prompt: 'think about x' }, { session_id: 's' });
    // No name from the prompt: Claude would write it to the transcript as a custom-title.
    assert.deepStrictEqual(plan, ['--permission-mode', 'plan', '--session-id', 's', '--', 'think about x']);
    const manual = buildClaudeArgs({ workspace: WS, permission_mode: 'manual', worktree: false }, { session_id: 's' });
    assert.deepStrictEqual(manual, ['--permission-mode', 'manual', '--session-id', 's']);
    const named = buildClaudeArgs(
      { workspace: WS, name: '  Login  fix ', title: 'T', prompt: 'go', worktree: false },
      { session_id: 's', refs: ['@src/a.ts', '@/abs/.hester/context/bundles/auth.md'] },
    );
    assert.deepStrictEqual(named, ['--permission-mode', 'auto', '--session-id', 's', '--name', 'Login fix', '--', 'go\n\nContext: @src/a.ts @/abs/.hester/context/bundles/auth.md']);
    const { buildPiArgs } = cockpit('launcher.js');
    assert.deepStrictEqual(buildPiArgs({ workspace: WS, name: 'Pi job', prompt: 'do it' }, ['@a.md']), ['--name', 'Pi job', '--', '@a.md', 'do it']);
    assert.deepStrictEqual(buildPiArgs({ workspace: WS }), []);
    assert.strictEqual(launchPlan({ workspace: WS }, { worktree_for_delegate: false }).worktree, false);
  });

  await check('launch permission mode: auto by default, plan lead wins, toggle off / config default -> acceptEdits', () => {
    const mode = (req, permission_default) => launchPlan({ workspace: WS, ...req }, { worktree_for_delegate: true, permission_default }).permission_mode;
    assert.strictEqual(mode({}), 'auto', 'default is auto');
    assert.strictEqual(mode({}, 'auto'), 'auto');
    assert.strictEqual(mode({}, 'default'), 'acceptEdits', "permission_default 'default' keeps the old delegate mode");
    assert.strictEqual(mode({ lead: 'plan' }), 'plan', 'plan lead wins over the auto default');
    assert.strictEqual(mode({ lead: 'plan', permission_mode: 'auto' }), 'plan', 'plan lead wins over an explicit auto');
    assert.strictEqual(mode({ permission_mode: 'acceptEdits' }), 'acceptEdits', 'the Launcher toggle off');
    assert.strictEqual(mode({ permission_mode: 'auto' }, 'default'), 'auto', 'the Launcher toggle on over a default config');
    assert.strictEqual(mode({ permission_mode: 'manual' }), 'manual', 'ops agents keep their explicit mode');
    const { withClaudePermissionDefault, permissionDefault, COCKPIT_DEFAULTS } = cockpit('cockpit-config.js');
    assert.strictEqual(COCKPIT_DEFAULTS.cockpit.launch.permission_default, 'auto');
    assert.strictEqual(permissionDefault('default'), 'default');
    assert.strictEqual(permissionDefault('bogus'), 'auto');
    // Plain agent starts (⇧⌘C, agent tabs, prewarm): auto unless the argv picks a mode.
    assert.deepStrictEqual(withClaudePermissionDefault('/usr/local/bin/claude', [], WS), ['--permission-mode', 'auto']);
    assert.deepStrictEqual(withClaudePermissionDefault('claude', ['--resume', 'x'], WS), ['--permission-mode', 'auto', '--resume', 'x']);
    assert.deepStrictEqual(withClaudePermissionDefault('claude', ['--permission-mode', 'plan'], WS), ['--permission-mode', 'plan']);
    assert.deepStrictEqual(withClaudePermissionDefault('claude', ['--dangerously-skip-permissions'], WS), ['--dangerously-skip-permissions']);
    assert.deepStrictEqual(withClaudePermissionDefault('claude', ['--', '--permission-mode'], WS), ['--permission-mode', 'auto', '--', '--permission-mode'], 'prompt text is not a flag');
    assert.deepStrictEqual(withClaudePermissionDefault('pi', [], WS), []);
    // A workspace that opts out.
    const optOut = path.join(tmpHome, 'optout');
    fs.mkdirSync(path.join(optOut, '.lee'), { recursive: true });
    fs.writeFileSync(path.join(optOut, '.lee', 'config.yaml'), 'cockpit:\n  launch:\n    permission_default: default\n');
    assert.deepStrictEqual(withClaudePermissionDefault('claude', [], optOut), []);
  });

  await check('worktreeFor: under the git top level, not a subdirectory workspace', () => {
    const { worktreeFor } = cockpit('launcher.js');
    const { execFileSync } = require('child_process');
    const repo = path.join(tmpHome, 'repo');
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const top = fs.realpathSync(repo);
    assert.strictEqual(worktreeFor(sub, 'x-1234').path, path.join(top, '.claude', 'worktrees', 'x-1234'));
    assert.strictEqual(worktreeFor(sub, 'x-1234').branch, 'worktree-x-1234');
    // Not a repo: the workspace itself.
    const plain = path.join(tmpHome, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    assert.strictEqual(worktreeFor(plain, 'y').path, path.join(plain, '.claude', 'worktrees', 'y'));
  });

  // -------------------------------------------------------------------------
  await check('names: precedence (user > /rename > AI title), transcript title lines only, path under ~/.claude/projects', () => {
    const { applyName, cleanName, safeTranscriptPath, TranscriptTitleReader } = cockpit('session-name.js');
    let st = { name: null, source: null, seenCustom: null };
    st = applyName(st, { name: 'AI one', source: 'ai-title' });
    assert.deepStrictEqual([st.name, st.source], ['AI one', 'ai-title']);
    st = applyName(st, { name: 'Mine', source: 'user' });
    assert.strictEqual(applyName(st, { name: 'AI two', source: 'ai-title' }), null, 'AI never beats yours');
    st = applyName(st, { name: 'Renamed', source: 'custom-title' });
    assert.deepStrictEqual([st.name, st.source], ['Renamed', 'custom-title']);
    st = applyName(st, { name: 'Mine again', source: 'user' });
    assert.strictEqual(applyName(st, { name: 'Renamed', source: 'custom-title' }), null, 'the same /rename seen again does not beat yours');
    assert.strictEqual(cleanName(' a\n  b\x07 '), 'a b');
    assert.strictEqual(cleanName('   '), null);

    const projects = path.join(tmpHome, '.claude', 'projects', '-work');
    fs.mkdirSync(projects, { recursive: true });
    const file = path.join(projects, 'sess.jsonl');
    const secret = 'PROMPT-SECRET-CONTENT';
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: secret } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login loop', sessionId: 's' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'mentions "type":"custom-title" in text ' + secret }] } }),
      '',
    ].join('\n'));
    assert.strictEqual(safeTranscriptPath(file), fs.realpathSync(file));
    assert.strictEqual(safeTranscriptPath(path.join(tmpHome, 'elsewhere.jsonl')), null);
    assert.strictEqual(safeTranscriptPath(path.join(projects, '..', '..', 'x.jsonl')), null);
    assert.strictEqual(safeTranscriptPath('relative.jsonl'), null);
    const reader = new TranscriptTitleReader();
    assert.deepStrictEqual(reader.read(file), { customTitle: null, aiTitle: 'Fix login loop' });
    // Appended later (read incrementally): a /rename, then a line still being written.
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Login \u2728 fix', sessionId: 's' }) + '\n{"type":"custom-ti');
    assert.deepStrictEqual(reader.read(file), { customTitle: 'Login \u2728 fix', aiTitle: 'Fix login loop' });
    fs.appendFileSync(file, 'tle","customTitle":"Final"}\n');
    assert.strictEqual(reader.read(file).customTitle, 'Final');

    // The runtime applies the rule and emits a 'name' change; your launch name is not relayed twice.
    const seen = [];
    rt.on('name', (id, n, src, relayIt) => seen.push([id, n, src, relayIt]));
    assert.strictEqual(rt.setName(1, 'Fix login loop', 'ai-title'), true);
    assert.strictEqual(rt.get(1).name, 'Fix login loop');
    assert.strictEqual(rt.setName(1, 'My name', 'user', { relay: false }), true);
    assert.strictEqual(rt.setName(1, 'Other AI', 'ai-title'), false);
    assert.strictEqual(rt.displayNameOf(1), 'My name');
    assert.deepStrictEqual(seen.map((x) => [x[2], x[3]]), [['ai-title', true], ['user', false]]);
    assert.strictEqual(rt.get(1).name_source, 'user');
    rt.setName(1, null, 'user');
    rt.removeAllListeners('name');
  });

  await check('context: files inside the workspace and existing bundles become @references (deterministic)', () => {
    const { contextRefs, withContext, workspaceRelative } = cockpit('workspace-files.js');
    fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'src', 'a.ts'), 'x');
    fs.mkdirSync(path.join(WS, '.hester', 'context', 'bundles'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.hester', 'context', 'bundles', 'auth.md'), '---\nid: auth\n---\n');
    const r = contextRefs(WS, { files: ['src/a.ts', path.join(WS, 'src', 'a.ts'), '../outside.txt', 'missing.ts'], bundles: ['auth', 'nope', '../x'] });
    assert.deepStrictEqual(r.files, ['src/a.ts']);
    assert.deepStrictEqual(r.bundles, ['auth']);
    assert.deepStrictEqual(r.refs, ['@src/a.ts', `@${path.join(path.resolve(WS), '.hester', 'context', 'bundles', 'auth.md')}`]);
    assert.strictEqual(workspaceRelative(WS, '/etc/passwd'), null);
    assert.strictEqual(withContext('', ['@a']), 'Context: @a');
    assert.strictEqual(withContext('p', []), 'p');
  });

  // -------------------------------------------------------------------------
  const checkins = new CheckinManager(rt, { pollMs: 20, screenPollMs: 20 });
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  // The check-in poll timer is unref'd (it never keeps Lee alive): hold the loop while awaiting a result.
  const until = async (p) => {
    const keep = setInterval(() => {}, 50);
    try {
      return await p;
    } finally {
      clearInterval(keep);
    }
  };
  await check('check-in: hook path resolved by agent.turn_end', async () => {
    hook('agent.session_start', 1, { provider: 'claude' });
    host.writes.length = 0;
    const lee = { status: 'in-progress', summary: 'Halfway through', blockers: null, files: [], next: 'tests' };
    setTimeout(() => hook('agent.turn_end', 1, { busy_ms: 10, summary: 'Working on it', lee_status: lee }), 60);
    const ack = await checkins.checkin(1, { by: LOCAL });
    // The request answers at once: it was at its prompt, so the prompt was typed.
    assert.deepStrictEqual([ack.success, ack.state, ack.source], [true, 'sent', 'hook']);
    assert.strictEqual(rt.get(1).checkin.state, 'sent');
    const res = await until(checkins.waitFor(ack.checkin_id));
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.source, 'hook');
    assert.deepStrictEqual(res.lee_status, lee);
    assert.strictEqual(res.summary, 'Halfway through');
    assert.strictEqual(rt.get(1).checkin, null);
    assert.strictEqual(host.writes[0][1], `\x1b[200~${CHECKIN_PROMPT}\x1b[201~`);
    const start = events.filter((e) => e.type === 'checkin.start').pop();
    const result = events.filter((e) => e.type === 'checkin.result').pop();
    assert.strictEqual(start.data.source, 'hook');
    assert.strictEqual(result.data.ok, true);
    assert.deepStrictEqual(result.data.lee_status, lee);
    const feed = cockpitBus.feed.list(WS).find((e) => e.producer === 'checkin' && e.title.startsWith('Checked in'));
    assert.ok(feed && feed.text_is_agent);
  });


  await check('check-in: awaiting input queues it; nothing typed until the prompt is resolved and the turn ends', async () => {
    hook('agent.waiting', 1, { kind: 'approval', item_id: 'item-q' });
    host.writes.length = 0;
    const ack = await checkins.checkin(1, { by: LOCAL });
    assert.deepStrictEqual([ack.success, ack.state], [true, 'queued']);
    assert.strictEqual(rt.get(1).checkin.state, 'queued');
    assert.strictEqual((await checkins.checkin(1, { by: LOCAL })).error, 'in_progress');
    await settle();
    assert.strictEqual(host.writes.length, 0, 'never types over a permission prompt');
    // Approved: working again (busy), still queued.
    logEvent({ type: 'attention.reply', source: 'lee-main', workspace: WS, data: { item_id: 'item-q', kind: 'approval', action: 'approve' } });
    host.emit('data', 1, 'x');
    await settle();
    assert.strictEqual(host.writes.length, 0, 'never interrupts a running turn');
    // The turn ends (Stop hook): the prompt is typed now and the reply awaited.
    const done = checkins.waitFor(ack.checkin_id);
    hook('agent.turn_end', 1, { busy_ms: 5, summary: 'Finished the tool' });
    await settle();
    assert.strictEqual(host.writes[0][1], `\x1b[200~${CHECKIN_PROMPT}\x1b[201~`);
    assert.strictEqual(rt.get(1).checkin.state, 'sent');
    const lee = { status: 'done', summary: 'All done', blockers: null, files: [], next: null };
    hook('agent.turn_end', 1, { busy_ms: 5, summary: 'All done', lee_status: lee });
    const res = await until(done);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.lee_status, lee);
    const result = events.filter((e) => e.type === 'checkin.result').pop();
    assert.strictEqual(result.data.checkin_id, ack.checkin_id);
    assert.ok(result.data.queued_ms >= 0);
    assert.strictEqual((await checkins.checkin(2, { by: LOCAL })).error, 'not_agent');
    assert.strictEqual((await checkins.checkin(1, { by: HESTER })).error, 'forbidden');
  });

  await check('check-in: a queued check-in can be cancelled (nothing typed, no Feed failure)', async () => {
    hook('agent.prompt', 1);
    host.writes.length = 0;
    const ack = await checkins.checkin(1, { by: LOCAL });
    assert.strictEqual(ack.state, 'queued');
    const done = checkins.waitFor(ack.checkin_id);
    assert.strictEqual(checkins.cancel(1, HESTER).error, 'forbidden');
    assert.strictEqual(checkins.cancel(1, LOCAL).success, true);
    const res = await until(done);
    assert.strictEqual(res.error, 'cancelled');
    hook('agent.turn_end', 1, { busy_ms: 5 });
    await settle();
    assert.strictEqual(host.writes.length, 0);
    assert.strictEqual(rt.get(1).checkin, null);
    assert.ok(!cockpitBus.feed.list(WS).some((e) => e.ref.checkin_id === ack.checkin_id));
    assert.strictEqual(checkins.cancel(1, LOCAL).error, 'not_found');
  });

  await check('check-in: a busy screen agent is queued and typed once it is back at its prompt (no busy failure)', async () => {
    host.emit('data', 3, '\r\nworking hard');
    host.writes.length = 0;
    assert.strictEqual(rt.state(3).state, 'busy');
    const ack = await checkins.checkin(3, { by: LOCAL });
    assert.deepStrictEqual([ack.success, ack.state, ack.source], [true, 'queued', 'screen']);
    await settle();
    assert.strictEqual(host.writes.length, 0);
    host.emit('data', 3, '\r\nstep 1\r\nstep 2\r\nstep 3\r\nstep 4\r\n> ');
    clock += 2000;
    await settle();
    assert.strictEqual(rt.state(3).state, 'idle-at-prompt');
    assert.strictEqual(host.writes.length, 2, 'bracketed paste, then Enter');
    const done = checkins.waitFor(ack.checkin_id);
    host.emit('data', 3, '\r\n```lee-status\nstatus: in-progress\nsummary: Screen report\n```\r\n> ');
    clock += 5000;
    const res = await until(done);
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(res.summary, 'Screen report');
    const feed = cockpitBus.feed.list(WS).find((e) => e.ref.checkin_id === ack.checkin_id);
    assert.ok(feed && feed.title.startsWith('Checked in on Screenbot'));
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
    // Screen text reaches Hester only through read_output (with its Feed notice), never the list.
    assert.ok(list.body.data.every((t) => Array.isArray(t.tail) && t.tail.length === 0));
    const local = await domain('list', { workspace: WS }, LOCAL);
    assert.strictEqual(local.body.data.length, list.body.data.length);
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

  // -------------------------------------------------------------------------
  await check('shell: foreign OSC 133 (ssh, nested shells) never makes a busy tab idle; bare 133;C is ignored', async () => {
    host.add(20, { name: 'Terminal', fg: 'ssh' });
    withShellIntegration('/bin/zsh', ['-l'], { LEE_PTY_ID: '20' }, true);
    tabs.push({ id: 120, type: 'terminal', label: 'Remote', ptyId: 20, dockPosition: 'center', state: 'active' });
    const signals = [];
    const off = cockpitBus.onTerminal((s) => signals.push(s));
    // The remote host's own integration prints prompt marks while ssh holds the foreground.
    host.emit('data', 20, '\x1b]133;D;0\x07\x1b]133;A\x07prod$ \x1b]133;B\x07');
    assert.deepStrictEqual([rt.state(20).state, rt.state(20).source], ['busy', 'foreground']);
    host.writes.length = 0;
    assert.strictEqual((await rt.send(20, { text: 'npm test', submit: true, purpose: 'operation' }, LOCAL)).error, 'busy');
    assert.strictEqual(host.writes.length, 0, 'nothing typed into the remote shell');
    // Back at the local shell.
    host.get(20).pty.process = 'zsh';
    assert.strictEqual(rt.state(20).state, 'idle-at-prompt');
    // A bare 133;C (another integration) neither starts nor overwrites a command.
    host.emit('data', 20, '\x1b]133;C\x07');
    assert.strictEqual(rt.state(20).state, 'idle-at-prompt');
    assert.strictEqual(signals.length, 0);
    host.emit('data', 20, `\x1b]633;E;${escapeCommandLine('make lint')}\x07\x1b]133;C\x07\x1b]133;C\x07linting\n\x1b]133;D;0\x07`);
    off();
    assert.deepStrictEqual(signals.map((s) => [s.phase, s.text]), [['start', 'make lint'], ['end', 'make lint']]);
  });

  await check('shell without integration: the lone 133;D Lee appends ends Lee\'s run and keeps foreground state', async () => {
    host.add(21, { name: 'Terminal', fg: 'fish' });
    withShellIntegration('/opt/homebrew/bin/fish', ['-l'], { LEE_PTY_ID: '21' }, true);
    tabs.push({ id: 121, type: 'terminal', label: 'Fish', ptyId: 21, dockPosition: 'center', state: 'active' });
    rt.tick();
    clock += 5000;
    assert.deepStrictEqual([rt.state(21).state, rt.state(21).source], ['idle-at-prompt', 'foreground']);
    const signals = [];
    const off = cockpitBus.onTerminal((s) => signals.push(s));
    const line = `npm test; printf '\\033]133;D;%s\\007' "$?"`;
    const sentAt = clock;
    assert.strictEqual((await rt.send(21, { text: line, submit: true, purpose: 'operation' }, LOCAL)).success, true);
    host.get(21).pty.process = 'node';
    host.emit('data', 21, `${line}\r\nrunning tests\r\n`);
    assert.strictEqual(rt.state(21).state, 'busy');
    clock += 3000;
    host.emit('data', 21, '\x1b]133;D;1\x07');
    off();
    assert.strictEqual(signals.length, 1);
    assert.deepStrictEqual([signals[0].phase, signals[0].by, signals[0].exit_code, signals[0].duration_ms], ['end', 'lee', 1, clock - sentAt]);
    assert.strictEqual(rt.get(21).shell_integration, false, 'a lone 133;D is not integration');
    clock += 5000;
    assert.deepStrictEqual([rt.state(21).state, rt.state(21).source], ['busy', 'foreground'], 'node still in the foreground');
    host.get(21).pty.process = 'fish';
    assert.strictEqual(rt.state(21).state, 'idle-at-prompt');
  });

  await check('Hester chat and DevOps tabs are not agents (no wall, no check-in)', async () => {
    host.add(22, { name: 'Hester' });
    tabs.push({ id: 122, type: 'agent', provider: 'hester', label: 'Hester', ptyId: 22, dockPosition: 'right', state: 'active' });
    host.add(23, { name: 'DevOps' });
    tabs.push({ id: 123, type: 'agent', provider: 'devops', label: 'DevOps', ptyId: 23, dockPosition: 'center', state: 'active' });
    assert.strictEqual(rt.get(22).kind, 'tui');
    assert.strictEqual(rt.get(23).kind, 'tui');
    assert.strictEqual((await checkins.checkin(22, { by: LOCAL, force: true })).error, 'not_agent');
    assert.ok(!rt.list(WS).some((t) => t.kind === 'agent' && (t.pty_id === 22 || t.pty_id === 23)));
  });

  await check('hooked agent: approving (queue or tab) ends awaiting-input; deny returns it to its prompt', () => {
    hook('agent.session_start', 1, { provider: 'claude' });
    hook('agent.prompt', 1);
    hook('agent.waiting', 1, { kind: 'approval', item_id: 'item-a' });
    assert.strictEqual(rt.state(1).state, 'awaiting-input');
    host.emit('data', 1, 'x');
    logEvent({ type: 'attention.reply', source: 'lee-main', workspace: WS, data: { item_id: 'item-a', kind: 'approval', action: 'approve' } });
    assert.strictEqual(rt.state(1).state, 'busy', 'working on the approved tool');
    // Two parallel prompts: still waiting until both are answered.
    hook('agent.waiting', 1, { kind: 'approval', item_id: 'item-b' });
    hook('agent.waiting', 1, { kind: 'approval', item_id: 'item-c' });
    logEvent({ type: 'attention.resolve', source: 'lee-main', workspace: WS, data: { item_id: 'item-b', kind: 'approval', resolution: 'answered_in_tab' } });
    assert.strictEqual(rt.state(1).state, 'awaiting-input');
    logEvent({ type: 'attention.resolve', source: 'lee-main', workspace: WS, data: { item_id: 'item-c', kind: 'approval', resolution: 'answered_in_tab' } });
    assert.strictEqual(rt.state(1).state, 'busy');
    hook('agent.waiting', 1, { kind: 'approval', item_id: 'item-d' });
    logEvent({ type: 'attention.reply', source: 'lee-main', workspace: WS, data: { item_id: 'item-d', kind: 'approval', action: 'deny' } });
    assert.strictEqual(rt.state(1).state, 'idle-at-prompt');
    // An unrelated item changes nothing.
    hook('agent.waiting', 1, { kind: 'approval', item_id: 'item-e' });
    logEvent({ type: 'attention.reply', source: 'lee-main', workspace: WS, data: { item_id: 'other', action: 'approve' } });
    assert.strictEqual(rt.state(1).state, 'awaiting-input');
    hook('agent.turn_end', 1, { busy_ms: 1 });
  });

  await check('state() of an unknown PTY id creates nothing', () => {
    assert.strictEqual(rt.state(4242).state, 'exited');
    assert.strictEqual(rt.exists(4242), false);
    assert.strictEqual(rt.get(4242), null);
  });

  await check('operation typing on Hester\'s behalf: the Feed says Hester asked', async () => {
    host.get(20).pty.process = 'zsh';
    host.emit('data', 20, '\x1b]133;A\x07$ ');
    const r = await rt.send(20, { text: 'make lint', submit: true, purpose: 'operation' }, LOCAL, { askedBy: HESTER });
    assert.strictEqual(r.success, true);
    const typed = cockpitBus.feed.list(WS).filter((e) => e.title.startsWith('Lee typed into Remote')).pop();
    assert.strictEqual(typed.title, 'Lee typed into Remote (asked by Hester)');
    host.emit('data', 20, `\x1b]633;E;${escapeCommandLine('make lint')}\x07\x1b]133;C\x07\x1b]133;D;0\x07\x1b]133;A\x07`);
  });

  await check('check-in on a hook-less agent: forced from unknown finishes; the screen tail never reaches the event log', async () => {
    host.add(24, { name: 'Plain' });
    tabs.push({ id: 124, type: 'agent', provider: 'plainbot', label: 'Plainbot', ptyId: 24, dockPosition: 'center', state: 'active' });
    rt.tick();
    clock += 10_000;
    assert.strictEqual(rt.state(24).state, 'unknown');
    assert.strictEqual((await checkins.checkin(24, { by: LOCAL })).error, 'state_unknown');
    const timers = [
      setTimeout(() => host.emit('data', 24, 'reading files\r\n$ export TOKEN=hunter2-SCREEN\r\nno status block here\r\n'), 30),
      setTimeout(() => (clock += 10_000), 120),
    ];
    const ack = await checkins.checkin(24, { by: LOCAL, force: true });
    assert.strictEqual(ack.state, 'sent');
    const res = await until(checkins.waitFor(ack.checkin_id));
    timers.forEach(clearTimeout);
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(res.source, 'screen');
    assert.strictEqual(res.summary, null);
    const result = events.filter((e) => e.type === 'checkin.result').pop();
    assert.strictEqual(result.data.ok, true);
    assert.strictEqual(result.data.summary, undefined);
    assert.ok(!JSON.stringify(events).includes('hunter2-SCREEN'), 'screen text never logged');
    const feed = cockpitBus.feed.list(WS).find((e) => e.producer === 'checkin' && e.title.startsWith('Checked in on Plainbot'));
    assert.ok(feed.text.includes('no status block here'));
    assert.strictEqual(feed.text_is_agent, false);
  });

  await check('create-tab: a late renderer answer never opens a second tab', async () => {
    const origSend = bw.webContents.send;
    const channels = [];
    bw.webContents.send = (channel, payload) => {
      channels.push(channel);
      if (channel === 'cockpit:create-tab') host.add(30, { name: payload.label });
    };
    const res = await rt.openTab({ workspace: WS, type: 'terminal', label: 'Slow tab', command: 'claude', args: [] }, { timeouts: { result: 50, fallback: 500 } });
    bw.webContents.send = origSend;
    assert.strictEqual(res.pty_id, 30);
    assert.deepStrictEqual(channels, ['cockpit:create-tab'], 'no v0 fallback create-tab');
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
    // An agent tab (walled, iconed and restored like ⇧⌘C), argv as extra args.
    assert.strictEqual(req.type, 'agent');
    assert.strictEqual(req.provider, 'claude');
    assert.strictEqual(req.command, undefined);
    assert.strictEqual(req.activate, false);
    assert.ok(req.args.includes('--session-id') && req.args.includes(res.session_id));
    assert.deepStrictEqual(req.args.slice(-2), ['--', LONG_PROMPT]);
    const lines = fs.readFileSync(spool, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.id, res.task_id);
    assert.strictEqual(rec.status, 'running');
    assert.strictEqual(rec.confirmed, true);
    // The tab label reaches lee.log and saved sessions: never prompt-derived.
    assert.deepStrictEqual(rec.agent, { provider: 'claude', pty_id: 7, session_id: res.session_id, tab_label: 'Claude task', model: null });
    assert.strictEqual(req.label, 'Claude task');
    // No title given: the record is untitled (Hester names it from the agent's summary).
    assert.strictEqual(rec.title, '(untitled)');
    assert.strictEqual(rec.title_source, 'auto');
    assert.ok(!fs.readFileSync(spool, 'utf8').includes('Fix the login'), 'prompt never spooled');
    assert.strictEqual(fs.statSync(spool).mode & 0o777, 0o600);
    const ev = events.filter((e) => e.type === 'task.launch').pop();
    assert.strictEqual(ev.data.task_id, res.task_id);
    assert.ok(!JSON.stringify(events).includes('Fix the login'), 'prompt and title never logged');
    assert.strictEqual(rt.get(7).task_id, res.task_id);
    assert.strictEqual((await launcher.launch({ workspace: WS, prompt: 'x' }, HESTER, 1)).error, 'forbidden');
    assert.strictEqual((await launcher.launch({ workspace: '/not/open', prompt: 'x' }, LOCAL, 1)).success, false);
  });

  await check('launch: a name and context reach argv and the task record (paths only), a Pi launch takes its prompt', async () => {
    sentToWindow.length = 0;
    const origSend = bw.webContents.send;
    let nextPty = 70;
    bw.webContents.send = (channel, payload) => {
      sentToWindow.push([channel, payload]);
      if (channel === 'cockpit:create-tab') {
        const id = nextPty++;
        setTimeout(() => {
          host.add(id, { claude: payload.provider === 'claude', name: payload.label });
          tabs.push({ id: 100 + id, type: 'agent', provider: payload.provider, label: payload.label, ptyId: id, dockPosition: 'center', state: 'idle' });
          rt.resolveCreateTab({ request_id: payload.request_id, tab_id: 100 + id, pty_id: id });
        }, 10);
      }
    };
    const before = relay.pending();
    const res = await launcher.launch(
      { workspace: WS, prompt: 'Look at auth', name: 'Auth review', worktree: false, context: { files: ['src/a.ts', '../etc'], bundles: ['auth'] } },
      LOCAL,
      1,
    );
    const pi = await launcher.launch({ workspace: WS, provider: 'pi', prompt: 'Summarise', name: 'Pi sum', context: { files: ['src/a.ts'] } }, LOCAL, 1);
    const bot = await launcher.launch({ workspace: WS, provider: 'screenbot', prompt: 'x' }, LOCAL, 1);
    bw.webContents.send = origSend;
    assert.strictEqual(res.success, true, JSON.stringify(res));
    const [req, piReq] = sentToWindow.filter(([c]) => c === 'cockpit:create-tab').map(([, p]) => p);
    assert.strictEqual(req.label, 'Auth review', 'the name is the tab label');
    assert.deepStrictEqual(req.args.slice(-4), ['--name', 'Auth review', '--', `Look at auth\n\nContext: @src/a.ts @${path.join(path.resolve(WS), '.hester', 'context', 'bundles', 'auth.md')}`]);
    assert.strictEqual(rt.get(res.pty_id).name, 'Auth review');
    assert.strictEqual(rt.get(res.pty_id).name_source, 'user');
    assert.deepStrictEqual([piReq.type, piReq.provider], ['agent', 'pi']);
    assert.deepStrictEqual(piReq.args, ['--name', 'Pi sum', '--', '@src/a.ts', 'Summarise']);
    assert.strictEqual(pi.success, true);
    assert.strictEqual(bot.error, 'prompt_unsupported');
    const recs = fs.readFileSync(spool, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = recs.find((r) => r.id === res.task_id);
    assert.deepStrictEqual([rec.name, rec.name_source], ['Auth review', 'user']);
    assert.deepStrictEqual(rec.context, { files: ['src/a.ts'], bundles: ['auth'] });
    assert.ok(!fs.readFileSync(spool, 'utf8').includes('Look at auth'), 'prompt never spooled');
    const ev = events.filter((e) => e.type === 'task.launch').find((e) => e.data.task_id === res.task_id);
    assert.deepStrictEqual([ev.data.named, ev.data.context_files, ev.data.context_bundles], [true, 1, 1]);
    assert.ok(!JSON.stringify(ev).includes('src/a.ts') && !JSON.stringify(ev).includes('Auth review'), 'no paths or names in the event log');
    assert.strictEqual(relay.pending(), before + 2);
  });

  await check('launch: human lead relays a queued task; spool drains when Hester is up', async () => {
    const res = await launcher.launch({ workspace: WS, title: 'Write the doc', lead: 'human' }, LOCAL, 1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.pty_id, null);
    assert.strictEqual(relay.pending(), 4);
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
    assert.strictEqual(await relay.drain(), 4);
    server.close();
    assert.strictEqual(relay.pending(), 0);
    assert.ok(!fs.existsSync(spool));
    assert.strictEqual(got[0].url, '/cockpit/tasks');
    assert.strictEqual(got[0].auth, 'Bearer tok');
    assert.strictEqual(got[0].ws, WS);
    assert.strictEqual(got[3].body.status, 'queued');
    assert.strictEqual(got[3].body.agent, null);
    assert.strictEqual(got[1].body.name, 'Auth review');
    relay.stop();
  });

  await check('launch (v3 §4): a spike carries its worktree on task.launch and the relayed record; origin explore validates', async () => {
    const { validOrigin, worktreeFor } = cockpit('launcher.js');
    assert.deepStrictEqual(validOrigin({ kind: 'explore', ref: 'exp-1/n-0000abcd' }), { kind: 'explore', ref: 'exp-1/n-0000abcd' });
    assert.strictEqual(validOrigin({ kind: 'nope' }), null);
    const relayed = [];
    const stubRelay = { relay: async (r) => (relayed.push(r), true) };
    const l2 = new TaskLauncherImpl(rt, stubRelay);
    sentToWindow.length = 0;
    const origSend = bw.webContents.send;
    bw.webContents.send = (channel, payload) => {
      sentToWindow.push([channel, payload]);
      if (channel === 'cockpit:create-tab') {
        setTimeout(() => {
          host.add(88, { claude: true, name: payload.label });
          tabs.push({ id: 188, type: 'agent', provider: 'claude', label: payload.label, ptyId: 88, dockPosition: 'center', state: 'idle' });
          rt.resolveCreateTab({ request_id: payload.request_id, tab_id: 188, pty_id: 88 });
        }, 10);
      }
    };
    const res = await l2.launch(
      {
        workspace: WS,
        lead: 'delegate',
        kind: 'prototype',
        worktree: true,
        prompt: 'Try a file-first store',
        title: 'File store',
        name: 'Spike: File store',
        origin: { kind: 'explore', ref: 'exp-1/n-0000abcd' },
      },
      LOCAL,
      1,
    );
    const noWt = await l2.launch({ workspace: WS, prompt: 'x', worktree: false }, LOCAL, 1);
    bw.webContents.send = origSend;
    assert.strictEqual(res.success, true, JSON.stringify(res));
    const req = sentToWindow.find(([c]) => c === 'cockpit:create-tab')[1];
    const slug = req.args[req.args.indexOf('--worktree') + 1];
    assert.ok(/^file-store-[0-9a-f]{4}$/.test(slug), slug);
    const expected = { slug, path: path.join(WS, '.claude', 'worktrees', slug), branch: `worktree-${slug}` };
    assert.deepStrictEqual(worktreeFor(WS, slug), expected);
    const rec = relayed.find((r) => r.id === res.task_id);
    assert.deepStrictEqual(rec.worktree, expected);
    assert.deepStrictEqual(rec.origin, { kind: 'explore', ref: 'exp-1/n-0000abcd' });
    const ev = events.filter((e) => e.type === 'task.launch').find((e) => e.data.task_id === res.task_id);
    assert.deepStrictEqual(ev.data.worktree, expected);
    assert.strictEqual(ev.data.origin_kind, 'explore');
    const ev2 = events.filter((e) => e.type === 'task.launch').find((e) => e.data.task_id === noWt.task_id);
    assert.strictEqual(ev2.data.worktree, false);
    assert.strictEqual(relayed.find((r) => r.id === noWt.task_id).worktree, undefined);
  });

  await check('relay: a non-ASCII workspace path is percent-encoded in X-Lee-Workspace (a raw header would throw and block the spool)', async () => {
    const got = [];
    const server = http.createServer((req, res2) => {
      got.push({ url: req.url, ws: req.headers['x-lee-workspace'] });
      req.resume();
      req.on('end', () => {
        res2.writeHead(201, { 'Content-Type': 'application/json' });
        res2.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const r2 = new TaskRelay({ getHesterPort: () => port, getSharedToken: () => 'tok' });
    const uni = '/tmp/项目/app';
    const out = await r2.post({ id: 'task-0000beef', workspace: uni, title: 't', status: 'queued' });
    server.close();
    r2.stop();
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(got.length, 1, JSON.stringify(out));
    assert.strictEqual(got[0].ws, encodeURI(uni));
    assert.strictEqual(got[0].url, '/cockpit/tasks');
  });

  await check('create-tab fallback: v0 system:create-tab when no bridge answers', async () => {
    const origSend = bw.webContents.send;
    const seen = [];
    bw.webContents.send = (channel, payload) => {
      seen.push(channel);
      if (channel === 'system:create-tab') setTimeout(() => host.add(131, { name: payload.label }), 20);
    };
    const r = await rt.openTab(
      { workspace: WS, type: 'terminal', label: '▶ build', command: 'npm', args: ['run', 'build'] },
      { timeouts: { result: 50, fallback: 2000 } },
    );
    bw.webContents.send = origSend;
    assert.deepStrictEqual(seen, ['cockpit:create-tab', 'system:create-tab']);
    assert.strictEqual(r.pty_id, 131);
  });

  await check('create-tab fallback: an agent launch with argv falls back to a terminal running its command', async () => {
    const origSend = bw.webContents.send;
    const seen = [];
    bw.webContents.send = (channel, payload) => {
      seen.push([channel, payload]);
      if (channel === 'system:create-tab') setTimeout(() => host.add(132, { name: payload.label, claude: true }), 20);
    };
    const r = await rt.openTab(
      { workspace: WS, type: 'agent', provider: 'claude', label: 'Named task', command: 'claude', args: ['--session-id', 'sx'] },
      { timeouts: { result: 50, fallback: 2000 } },
    );
    bw.webContents.send = origSend;
    assert.deepStrictEqual(seen[0][1].args, ['--session-id', 'sx']);
    assert.strictEqual(seen[0][1].type, 'agent');
    assert.deepStrictEqual(seen[1], ['system:create-tab', { type: 'terminal', label: 'Named task', command: 'claude', args: ['--session-id', 'sx'] }]);
    assert.strictEqual(r.pty_id, 132);
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
