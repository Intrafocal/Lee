#!/usr/bin/env node
/**
 * Shell-integration startup test (contract §5.2): runs real interactive zsh
 * and bash in a pseudo-terminal (python3's pty module) with HOME pointing at
 * a temp dir holding fake user dotfiles, once plain and once with Lee's
 * integration, and checks that markers, aliases, the prompt, PATH and
 * ZDOTDIR are unchanged and that the OSC 133/633/7 sequences come out.
 * Never touches the real dotfiles or ~/.lee.
 *
 *   cd electron && npm run build:main && node scripts/cockpit-shell-smoke.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lee-shell-smoke-'));
process.env.HOME = tmpHome;

const dist = path.join(__dirname, '..', 'dist', 'main', 'cockpit');
const { installShellIntegration, withShellIntegration, spawnInfo } = require(path.join(dist, 'shell-integration.js'));
const { ShellOscParser } = require(path.join(dist, 'shell-osc.js'));
const { stripAnsi } = require(path.join(dist, 'output-ring.js'));

const PY = `
import os, pty, sys, time, select, json
cfg = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg['cwd'])
    os.execve(cfg['argv'][0], cfg['argv'], cfg['env'])
out = b''
def pump(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d:
                return
            out += d
pump(cfg['startup'])
for line in cfg['input']:
    os.write(fd, (line + '\\r').encode())
    pump(cfg['wait'])
os.write(fd, b'exit\\r')
pump(0.8)
try:
    os.kill(pid, 9)
except Exception:
    pass
sys.stdout.write(out.decode('utf-8', 'replace'))
`;

function runShell(argv, env, input) {
  const r = spawnSync('python3', ['-c', PY, JSON.stringify({ argv, env, input, cwd: tmpHome, startup: 2.5, wait: 0.8 })], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return r.stdout;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function baseEnv(extra = {}) {
  return {
    HOME: tmpHome,
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    ...extra,
  };
}

/** The value lines our probe prints, e.g. "Z=[..]" -> { Z: '..' }. */
function probe(out) {
  const text = stripAnsi(out);
  const vals = {};
  for (const m of text.matchAll(/^(\w+)=\[(.*)\]\s*$/gm)) vals[m[1]] = m[2];
  return { text, vals };
}

const PROBE = [
  'echo "Z=[${ZDOTDIR-unset}]"',
  'echo "O=[${LEE_ORIG_ZDOTDIR-unset}]"',
  'echo "M=[$LEE_TEST_MARK/$ENV_MARK/$PROFILE_MARK/$LOGIN_MARK]"',
  'echo "P=[$PATH]"',
  'echo "H=[$HISTFILE]"',
  "echo \"I=[$(sh -c 'echo ${LEE_SHELL_INTEGRATION-unset}')]\"",
  'echo "A=[$(alias ll)]"',
  'false',
  'echo "semi;colon \\\\ back"',
];

function oscEvents(out) {
  const p = new ShellOscParser();
  // Feed in small chunks so sequences split across chunk boundaries too.
  const evs = [];
  for (let i = 0; i < out.length; i += 7) evs.push(...p.feed(out.slice(i, i + 7)));
  return evs;
}

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log('ok -', name);
}

function hasShell(bin) {
  return fs.existsSync(bin);
}

installShellIntegration(tmpHome);

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

function zshCase(label, envExtra, userDir) {
  const d = userDir;
  write(path.join(d, '.zshenv'), 'export ENV_MARK=zshenv\nexport PATH="$HOME/zbin:$PATH"\n');
  write(path.join(d, '.zprofile'), 'export PROFILE_MARK=zprofile\n');
  write(path.join(d, '.zshrc'), "export LEE_TEST_MARK=zshrc\nalias ll='ls -l'\nPROMPT='MYPROMPT> '\n");
  write(path.join(d, '.zlogin'), 'export LOGIN_MARK=zlogin\n');

  const plain = probe(runShell(['/bin/zsh', '-l'], baseEnv(envExtra), PROBE));
  const env = { ...baseEnv(envExtra), LEE_PTY_ID: '101' };
  const args = withShellIntegration('/bin/zsh', ['-l'], env, true);
  const rawLee = runShell(['/bin/zsh', ...args], env, PROBE);
  const lee = probe(rawLee);
  if (process.env.SMOKE_VERBOSE) console.log(label, plain.vals, lee.vals);

  check(`zsh ${label}: integration env set for the spawn only`, () => {
    assert.deepStrictEqual(args, ['-l']);
    assert.strictEqual(env.ZDOTDIR, path.join(tmpHome, '.lee', 'shell', 'zsh'));
    assert.strictEqual(env.LEE_ORIG_ZDOTDIR, envExtra.ZDOTDIR ?? '');
    assert.strictEqual(spawnInfo(101).integration, 'zsh');
  });
  check(`zsh ${label}: ZDOTDIR, markers, alias, PATH, HISTFILE unchanged`, () => {
    for (const k of ['Z', 'M', 'P', 'H', 'A']) assert.strictEqual(lee.vals[k], plain.vals[k], `${k}: ${lee.vals[k]} vs ${plain.vals[k]}`);
    assert.strictEqual(lee.vals.M, 'zshrc/zshenv/zprofile/zlogin');
    assert.strictEqual(lee.vals.O, 'unset');
    assert.strictEqual(lee.vals.I, 'unset', 'LEE_SHELL_INTEGRATION is not exported');
    assert.ok(lee.vals.A.includes('ls -l'));
    assert.ok(lee.vals.P.includes(path.join(tmpHome, 'zbin')));
  });
  check(`zsh ${label}: the prompt is the user's`, () => {
    assert.ok(lee.text.includes('MYPROMPT> '));
  });
  check(`zsh ${label}: OSC 133/633/7 sequences with command lines and exit codes`, () => {
    const evs = oscEvents(rawLee);
    const lines = evs.filter((e) => e.type === 'command-line').map((e) => e.text);
    assert.deepStrictEqual(lines.slice(0, PROBE.length), PROBE);
    const ends = evs.filter((e) => e.type === 'command-end').map((e) => e.exit_code);
    assert.strictEqual(ends.length >= PROBE.length, true);
    assert.strictEqual(ends[PROBE.indexOf('false')], 1);
    assert.strictEqual(ends[0], 0);
    assert.ok(evs.some((e) => e.type === 'prompt-start'));
    assert.ok(evs.some((e) => e.type === 'cwd' && e.path === fs.realpathSync(tmpHome)) || evs.some((e) => e.type === 'cwd' && e.path === tmpHome));
    assert.strictEqual(evs.filter((e) => e.type === 'command-start').length, lines.length);
    const plainEvs = oscEvents(runShell(['/bin/zsh', '-l'], baseEnv(envExtra), ['true']));
    assert.strictEqual(plainEvs.filter((e) => e.type === 'command-start').length, 0);
  });
}

if (hasShell('/bin/zsh')) {
  zshCase('(no ZDOTDIR)', {}, tmpHome);
  const zdot = path.join(tmpHome, 'zdot');
  zshCase('(ZDOTDIR set)', { ZDOTDIR: zdot }, zdot);

  // ~/.zshenv moves ZDOTDIR (the XDG pattern): the rest must come from there.
  const home2 = path.join(tmpHome, 'h2');
  const xdg = path.join(home2, 'xdg');
  write(path.join(home2, '.zshenv'), 'export ZDOTDIR="$HOME/xdg"\nexport ENV_MARK=home-zshenv\n');
  write(path.join(xdg, '.zprofile'), 'export PROFILE_MARK=xdg-zprofile\n');
  write(path.join(xdg, '.zshrc'), "export LEE_TEST_MARK=xdg-zshrc\nalias ll='ls -l'\n");
  write(path.join(xdg, '.zlogin'), 'export LOGIN_MARK=xdg-zlogin\n');
  const plain2 = probe(runShell(['/bin/zsh', '-l'], baseEnv({ HOME: home2 }), PROBE));
  const env2 = { ...baseEnv({ HOME: home2 }), LEE_PTY_ID: '107' };
  const args2 = withShellIntegration('/bin/zsh', ['-l'], env2, true);
  const lee2 = probe(runShell(['/bin/zsh', ...args2], env2, PROBE));
  check('zsh (~/.zshenv sets ZDOTDIR): startup files read from the new ZDOTDIR, as without Lee', () => {
    assert.strictEqual(plain2.vals.M, 'xdg-zshrc/home-zshenv/xdg-zprofile/xdg-zlogin');
    for (const k of ['Z', 'M', 'P', 'H', 'A', 'O']) assert.strictEqual(lee2.vals[k], plain2.vals[k], `${k}: ${lee2.vals[k]} vs ${plain2.vals[k]}`);
  });
} else {
  console.log('skip - /bin/zsh not found');
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function bashCase(bin) {
  write(path.join(tmpHome, '.bash_profile'), 'export PROFILE_MARK=bash_profile\nexport PATH="$HOME/bbin:$PATH"\n[ -r ~/.bashrc ] && . ~/.bashrc\n');
  write(path.join(tmpHome, '.bashrc'), "export LEE_TEST_MARK=bashrc\nalias ll='ls -l'\nPS1='BPROMPT> '\nPROMPT_COMMAND='export LOGIN_MARK=pc'\n");
  const plain = probe(runShell([bin, '-l'], baseEnv(), PROBE));
  const env = { ...baseEnv(), LEE_PTY_ID: '102' };
  const args = withShellIntegration(bin, ['-l'], env, true);
  const rawLee = runShell([bin, ...args], env, PROBE);
  const lee = probe(rawLee);
  if (process.env.SMOKE_VERBOSE) console.log(bin, plain.vals, lee.vals);
  check(`bash ${bin}: --init-file replaces -l`, () => {
    assert.deepStrictEqual(args, ['--init-file', path.join(tmpHome, '.lee', 'shell', 'bash', 'lee.bashrc')]);
    assert.strictEqual(env.ZDOTDIR, undefined);
  });
  check(`bash ${bin}: markers, alias, PATH unchanged; user PROMPT_COMMAND still runs`, () => {
    for (const k of ['M', 'P', 'A', 'Z']) assert.strictEqual(lee.vals[k], plain.vals[k], `${k}: ${lee.vals[k]} vs ${plain.vals[k]}`);
    assert.strictEqual(lee.vals.M, 'bashrc//bash_profile/pc');
    assert.strictEqual(lee.vals.I, 'unset');
    assert.ok(lee.text.includes('BPROMPT> '));
  });
  check(`bash ${bin}: OSC sequences with command lines and exit codes`, () => {
    const evs = oscEvents(rawLee);
    const lines = evs.filter((e) => e.type === 'command-line').map((e) => e.text);
    assert.deepStrictEqual(lines.slice(0, PROBE.length), PROBE);
    const ends = evs.filter((e) => e.type === 'command-end').map((e) => e.exit_code);
    assert.strictEqual(ends[PROBE.indexOf('false')], 1);
    assert.strictEqual(ends[0], 0);
    assert.strictEqual(evs.filter((e) => e.type === 'command-start').length, lines.length);
  });
}

for (const bin of ['/bin/bash', '/opt/homebrew/bin/bash']) {
  if (hasShell(bin)) bashCase(bin);
}

check('other shells are left alone', () => {
  const env = { LEE_PTY_ID: '103' };
  assert.deepStrictEqual(withShellIntegration('/opt/homebrew/bin/fish', ['-l'], env, true), ['-l']);
  assert.strictEqual(env.ZDOTDIR, undefined);
  const env2 = { LEE_PTY_ID: '104' };
  assert.deepStrictEqual(withShellIntegration('/bin/zsh', ['-il', '-c', 'x'], env2, false), ['-il', '-c', 'x']);
  assert.strictEqual(env2.ZDOTDIR, undefined);
});

check('cockpit.shell_integration: false stops injection', () => {
  write(path.join(tmpHome, '.lee', 'config.yaml'), 'cockpit:\n  shell_integration: false\n');
  require(path.join(dist, 'cockpit-config.js')).invalidateCockpitConfig();
  const env = { LEE_PTY_ID: '105' };
  assert.deepStrictEqual(withShellIntegration('/bin/bash', ['-l'], env, true), ['-l']);
  const env2 = { LEE_PTY_ID: '106' };
  withShellIntegration('/bin/zsh', ['-l'], env2, true);
  assert.strictEqual(env2.ZDOTDIR, undefined);
  fs.rmSync(path.join(tmpHome, '.lee', 'config.yaml'));
});

check('files: dir 0700, scripts 0644', () => {
  const dir = path.join(tmpHome, '.lee', 'shell');
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(dir, 'zsh', '.zshrc')).mode & 0o777, 0o644);
  assert.strictEqual(fs.statSync(path.join(dir, 'bash', 'lee.bashrc')).mode & 0o777, 0o644);
});

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${checks} checks passed`);
