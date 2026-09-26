#!/usr/bin/env node
/**
 * Smoke test for the pure Cockpit renderer model
 * (src/renderer/lib/cockpitModel.ts): mergeFeed order, tileModel with and
 * without snapshot.agents, stripTabs, every row of contracts §3.2 through
 * nextMode, and keyAction ignoring keys while an input is focused. Compiles
 * the real source with esbuild, no React, no DOM.
 *
 * Run: node scripts/cockpit-renderer-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/renderer/lib/cockpitModel.ts');

const result = await esbuild.build({ entryPoints: [srcPath], bundle: false, format: 'esm', platform: 'node', write: false });
const code = result.outputFiles[0].text;
assert.ok(!/^\s*import\s/m.test(code), 'cockpitModel.ts must have type-only imports (pure)');

const tmpDir = mkdtempSync(join(tmpdir(), 'lee-cockpit-smoke-'));
const tmpFile = join(tmpDir, 'cockpitModel.mjs');
writeFileSync(tmpFile, code);
let mod;
try {
  mod = await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { mergeFeed, tileModel, stripTabs, isAgentTab, nextMode, keyAction, feedNeedsCount, formatDuration } = mod;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const WS = '/work/lee';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const ago = (m) => new Date(NOW - m * 60000).toISOString();

function item(o) {
  return {
    id: 'i1',
    version: 1,
    kind: 'waiting',
    severity: 'needs-you',
    state: 'open',
    parked: false,
    wake: false,
    notify: false,
    related_to_focus: false,
    created_at: ago(5),
    updated_at: ago(5),
    active_wait_ms: 0,
    title: 'Claude is waiting',
    text: 'words',
    source: { kind: 'agent', provider: 'claude', session_id: 's', pty_id: 12, window_id: 1, tab_id: 3, tab_label: 'Claude', workspace: WS, cwd: WS },
    actions: ['reply', 'open', 'dismiss'],
    ...o,
  };
}

function entry(o) {
  return {
    id: 'e1',
    version: 1,
    workspace: WS,
    kind: 'event',
    severity: 'ambient',
    producer: 'ops',
    title: 'entry',
    text: null,
    text_is_agent: false,
    created_at: ago(1),
    updated_at: ago(1),
    state: 'open',
    item_ref: null,
    ref: {},
    actions: [],
    pinned: false,
    expires_at: null,
    ...o,
  };
}

function snapshot(o = {}) {
  return {
    items: [],
    counts: { blocking: 0, needs_you: 0, ambient: 0, parked: 0 },
    focus: { active: false, session_id: null, source: null, started_at: null, item: null, quiet_count: 0 },
    away: { active: false, handoff_id: null, started_at: null, summary: { mode: 'none' }, summary_delivered: false, wake_item_ids: [], wake_pty_ids: [], parked_count: 0 },
    generated_at: ago(0),
    ...o,
  };
}

function runtime(o) {
  return {
    pty_id: 30,
    tab_id: null,
    window_id: 2,
    workspace: WS,
    label: 'Pi',
    tab_type: 'agent',
    kind: 'agent',
    provider: 'pi',
    fidelity: 'screen',
    state: { pty_id: 30, state: 'busy', source: 'pattern', since: ago(12), quiet_ms: 0, foreground: null },
    shell_integration: false,
    cwd: WS,
    last_command: null,
    operation: null,
    task_id: null,
    session_id: null,
    tail: ['working…', '> '],
    ...o,
  };
}

const noSets = { snapshotAgents: new Set(), runtimeAgents: new Set() };

// ---------------------------------------------------------------------------
// mergeFeed
// ---------------------------------------------------------------------------

test('mergeFeed: blocking first, then needs-you (incl. pinned), then newest first', () => {
  const rows = mergeFeed({
    workspace: WS,
    items: [
      item({ id: 'old-needs', severity: 'needs-you', updated_at: ago(30) }),
      item({ id: 'amb', kind: 'review', severity: 'ambient', updated_at: ago(0.5) }),
      item({ id: 'block', kind: 'approval', severity: 'blocking', updated_at: ago(60), actions: ['approve', 'deny'] }),
    ],
    entries: [
      entry({ id: 'new-event', updated_at: ago(0.1) }),
      entry({ id: 'pinned', pinned: true, updated_at: ago(90) }),
      entry({ id: 'fail', kind: 'failure', severity: 'needs-you', updated_at: ago(2) }),
    ],
    events: [{ at: ago(10), task_id: 't1', kind: 'created', text: 'Task created' }],
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ['att:block', 'lee:fail', 'att:old-needs', 'lee:pinned', 'lee:new-event', 'att:amb', 'hester:t1:' + ago(10) + ':0'],
  );
  assert.equal(rows[0].kind, 'approval');
  assert.equal(rows[5].kind, 'event', 'review maps to event');
  assert.equal(feedNeedsCount(rows), 3);
});

test('mergeFeed: drops closed items/entries and other workspaces, keeps machine-wide', () => {
  const rows = mergeFeed({
    workspace: WS,
    items: [item({ id: 'x', state: 'resolved' }), item({ id: 'other', source: { ...item({}).source, workspace: '/other' } })],
    entries: [entry({ id: 'done', state: 'done' }), entry({ id: 'mw', workspace: null }), entry({ id: 'ow', workspace: '/other' })],
  });
  assert.deepEqual(rows.map((r) => r.id), ['lee:mw']);
});

test('mergeFeed: question/waiting/decision map to decision', () => {
  const rows = mergeFeed({ workspace: WS, items: [item({ id: 'q', kind: 'question' }), item({ id: 'w', kind: 'waiting', updated_at: ago(6) })] });
  assert.deepEqual(rows.map((r) => r.kind), ['decision', 'decision']);
});

// ---------------------------------------------------------------------------
// tileModel
// ---------------------------------------------------------------------------

const agentTab = { id: 3, type: 'agent', label: 'Claude', ptyId: 12, dockPosition: 'center', provider: 'claude' };
const shellTab = { id: 4, type: 'terminal', label: 'Terminal 1', ptyId: 13, dockPosition: 'center' };

test('tileModel without snapshot.agents: tiles from tabs + items + tasks + runtime', () => {
  const tiles = tileModel({
    workspace: WS,
    tabs: [agentTab, shellTab],
    sets: noSets,
    snapshot: snapshot({ items: [item({ id: 'ap', kind: 'approval', actions: ['approve', 'deny', 'open'], tool: { name: 'Bash', preview: 'npm test', signature: 'x' } })] }),
    runtime: [runtime({}), runtime({ pty_id: 31, workspace: '/other' }), runtime({ pty_id: 32, state: { ...runtime({}).state, state: 'exited' } })],
    tasks: [{ id: 't1', title: 'Fix /fs 404', agent: { provider: 'claude', pty_id: 12, session_id: 's', tab_label: 'Claude' }, busy_ms: 12 * 60000, lead: 'delegate', confirmed: false, summary: 'Added requireAuth', status: 'running' }],
    now: NOW,
  });
  assert.deepEqual(tiles.map((t) => t.ptyId), [12, 30]);
  const claude = tiles[0];
  assert.equal(claude.title, 'Fix /fs 404');
  assert.deepEqual(claude.chip, { label: 'needs approval', tone: 'needs' });
  assert.equal(claude.approval.id, 'ap');
  assert.equal(claude.tabId, 3);
  assert.deepEqual(claude.summary, { text: 'Added requireAuth', label: 'Claude says' });
  assert.ok(claude.meta.includes('unconfirmed'));
  assert.ok(claude.meta.includes('12m busy'));
  assert.equal(claude.canCheckin, false);
  const pi = tiles[1];
  assert.equal(pi.title, 'Pi');
  assert.equal(pi.chip.label, 'busy 12m');
  assert.equal(pi.summary, null, 'screen tier shows the tail, not a summary');
  assert.deepEqual(pi.tail, ['working…', '> ']);
  assert.equal(pi.canCheckin, true);
  assert.equal(pi.tabId, null, 'agent in another window');
});

test('tileModel with snapshot.agents: state, last_summary, last_tool; other workspaces skipped', () => {
  const tiles = tileModel({
    workspace: WS,
    tabs: [],
    sets: noSets,
    snapshot: snapshot({
      agents: [
        { pty_id: 12, window_id: 1, tab_id: 3, label: 'Claude', provider: 'claude', workspace: WS, state: 'busy', busy_since: ago(7), idle_since: null, last_tool: 'Edit', last_summary: 'Working on it', files_touched_count: 2 },
        { pty_id: 40, window_id: 1, tab_id: 9, label: 'Claude 2', provider: 'claude', workspace: WS, state: 'idle', busy_since: null, idle_since: ago(1), last_tool: null, last_summary: null, files_touched_count: 0 },
        { pty_id: 50, window_id: 2, tab_id: 1, label: 'Elsewhere', provider: 'claude', workspace: '/other', state: 'idle', busy_since: null, idle_since: null, last_tool: null, last_summary: null, files_touched_count: 0 },
      ],
    }),
    runtime: [],
    tasks: [],
    now: NOW,
  });
  assert.deepEqual(tiles.map((t) => t.ptyId), [12, 40]);
  assert.equal(tiles[0].chip.label, 'busy 7m');
  assert.equal(tiles[0].agentState, 'busy');
  assert.deepEqual(tiles[0].summary, { text: 'Working on it', label: 'Claude says' });
  assert.deepEqual(tiles[0].meta, ['Edit', '2 files']);
  assert.equal(tiles[1].chip.label, 'idle');
  assert.equal(tiles[1].title, 'Claude 2');
});

// ---------------------------------------------------------------------------
// isAgentTab / stripTabs
// ---------------------------------------------------------------------------

test('isAgentTab: type agent, snapshot agents, runtime agents; own tabs otherwise', () => {
  assert.equal(isAgentTab(agentTab, noSets), true);
  assert.equal(isAgentTab(shellTab, noSets), false);
  assert.equal(isAgentTab(shellTab, { snapshotAgents: new Set([13]), runtimeAgents: new Set() }), true);
  assert.equal(isAgentTab(shellTab, { snapshotAgents: new Set(), runtimeAgents: new Set([13]) }), true);
  assert.equal(isAgentTab({ id: 5, type: 'file', label: 'a.py', ptyId: null }, noSets), false);
});

test('stripTabs: hides agents you did not go into; identity when disabled or nothing hidden', () => {
  const other = { ...agentTab, id: 6, ptyId: 20 };
  const tabs = [agentTab, shellTab, other];
  assert.deepEqual(stripTabs(tabs, { enabled: true, enteredPtys: new Set([12]), sets: noSets }).map((t) => t.id), [3, 4]);
  assert.deepEqual(stripTabs(tabs, { enabled: true, enteredPtys: new Set(), sets: noSets }).map((t) => t.id), [4]);
  assert.equal(stripTabs(tabs, { enabled: false, enteredPtys: new Set(), sets: noSets }), tabs);
  const own = [shellTab];
  assert.equal(stripTabs(own, { enabled: true, enteredPtys: new Set(), sets: noSets }), own);
});

// ---------------------------------------------------------------------------
// nextMode: every row of §3.2
// ---------------------------------------------------------------------------

const C = { enabled: true, mode: 'cockpit' };
const W = { enabled: true, mode: 'workbench' };
const OFF = { enabled: false, mode: 'workbench' };

test('§3.2 window load → default_mode (workbench when disabled)', () => {
  assert.deepEqual(nextMode(W, { kind: 'load', enabled: true, defaultMode: 'cockpit' }), { mode: 'cockpit', reason: 'default' });
  assert.deepEqual(nextMode(W, { kind: 'load', enabled: true, defaultMode: 'workbench' }), { mode: 'workbench', reason: 'default' });
  assert.deepEqual(nextMode(C, { kind: 'load', enabled: false, defaultMode: 'cockpit' }), { mode: 'workbench', reason: 'default' });
});

test('§3.2 ⌘0 / mode chip toggles (manual); nothing when disabled', () => {
  assert.deepEqual(nextMode(C, { kind: 'toggle' }), { mode: 'workbench', reason: 'manual' });
  assert.deepEqual(nextMode(W, { kind: 'toggle' }), { mode: 'cockpit', reason: 'manual' });
  assert.equal(nextMode(OFF, { kind: 'toggle' }), null);
});

test('§3.2 focus start → workbench, focus end → cockpit', () => {
  assert.deepEqual(nextMode(C, { kind: 'focus', active: true }), { mode: 'workbench', reason: 'focus_start' });
  assert.deepEqual(nextMode(W, { kind: 'focus', active: false }), { mode: 'cockpit', reason: 'focus_end' });
  assert.equal(nextMode(W, { kind: 'focus', active: true }), null);
  assert.equal(nextMode(OFF, { kind: 'focus', active: false }), null);
});

test('§3.2 handoff → cockpit; return → cockpit', () => {
  assert.deepEqual(nextMode(W, { kind: 'handoff' }), { mode: 'cockpit', reason: 'handoff' });
  assert.deepEqual(nextMode(W, { kind: 'return' }), { mode: 'cockpit', reason: 'return' });
  assert.equal(nextMode(C, { kind: 'return' }), null);
});

test('§3.2 go into an agent → workbench, enter(pty), logged', () => {
  assert.deepEqual(nextMode(C, { kind: 'go_into', ptyId: 12 }), { mode: 'workbench', reason: 'go_into', enter: 12, goInto: true });
  assert.deepEqual(nextMode(W, { kind: 'go_into', ptyId: 12 }), { mode: 'workbench', reason: null, enter: 12, goInto: true });
});

test('§3.2 open an own tab from the drawer → workbench (open_tab)', () => {
  assert.deepEqual(nextMode(C, { kind: 'open_tab' }), { mode: 'workbench', reason: 'open_tab' });
  assert.equal(nextMode(W, { kind: 'open_tab' }), null);
});

test('§3.2 own tab becomes active in cockpit (⌘1–9, Hester opens a file) → workbench', () => {
  assert.deepEqual(nextMode(C, { kind: 'tab_activated', isAgent: false, isNew: false, ptyId: 13, entered: false }), { mode: 'workbench', reason: 'open_tab' });
  assert.deepEqual(nextMode(C, { kind: 'tab_activated', isAgent: false, isNew: true, ptyId: null, entered: false }), { mode: 'workbench', reason: 'open_tab' });
});

test('§3.2 new agent tab active in cockpit (⇧⌘C) → stay, select its tile', () => {
  assert.deepEqual(nextMode(C, { kind: 'tab_activated', isAgent: true, isNew: true, ptyId: 12, entered: false }), { mode: 'cockpit', reason: null, selectTile: 12 });
});

test('§3.2 existing agent tab active in cockpit by another path → workbench, enter, go_into', () => {
  assert.deepEqual(nextMode(C, { kind: 'tab_activated', isAgent: true, isNew: false, ptyId: 12, entered: false }), { mode: 'workbench', reason: 'go_into', enter: 12, goInto: true });
});

test('§3.2 workbench: ⇧⌘C agent is entered (not a peek); ⌘N onto a hidden agent counts as going in', () => {
  assert.deepEqual(nextMode(W, { kind: 'tab_activated', isAgent: true, isNew: true, ptyId: 12, entered: false }), { mode: 'workbench', reason: null, enter: 12, goInto: false });
  assert.deepEqual(nextMode(W, { kind: 'tab_activated', isAgent: true, isNew: false, ptyId: 12, entered: false }), { mode: 'workbench', reason: null, enter: 12, goInto: true });
  assert.equal(nextMode(W, { kind: 'tab_activated', isAgent: true, isNew: false, ptyId: 12, entered: true }), null);
  assert.equal(nextMode(W, { kind: 'tab_activated', isAgent: false, isNew: false, ptyId: 13, entered: false }), null);
});

test('§3.2 nothing moves while the Cockpit is disabled', () => {
  for (const t of [{ kind: 'handoff' }, { kind: 'return' }, { kind: 'go_into', ptyId: 1 }, { kind: 'open_tab' }, { kind: 'tab_activated', isAgent: true, isNew: false, ptyId: 1, entered: false }]) {
    assert.equal(nextMode(OFF, t), null, JSON.stringify(t));
  }
});

// ---------------------------------------------------------------------------
// keyAction
// ---------------------------------------------------------------------------

test('keyAction: map of §3.7', () => {
  const k = (key, ctx = {}) => keyAction(key, { inInput: false, ...ctx });
  assert.deepEqual(k('1'), { kind: 'section', section: 'feed' });
  assert.deepEqual(k('6'), { kind: 'section', section: 'history' });
  assert.equal(k('7'), null);
  assert.deepEqual(k('j'), { kind: 'row', delta: 1 });
  assert.deepEqual(k('ArrowUp'), { kind: 'row', delta: -1 });
  assert.deepEqual(k('h'), { kind: 'tile', delta: -1 });
  assert.deepEqual(k('ArrowRight'), { kind: 'tile', delta: 1 });
  assert.deepEqual(k('Enter'), { kind: 'enter' });
  for (const [key, kind] of [['a', 'approve'], ['d', 'deny'], ['r', 'reply'], ['c', 'checkin'], ['n', 'launcher'], ['o', 'run'], ['x', 'dismiss'], ['`', 'drawer'], ['?', 'help'], ['Escape', 'escape']]) {
    assert.deepEqual(k(key), { kind }, key);
  }
  assert.deepEqual(k('ArrowLeft', { drawer: true }), { kind: 'drawer-move', delta: -1 });
  assert.deepEqual(k('l', { drawer: true }), { kind: 'drawer-move', delta: 1 });
  assert.equal(k('z'), null);
});

test('keyAction: ignored while typing in an input, and for modifier chords', () => {
  for (const key of ['j', 'k', 'r', 'x', 'a', 'd', 'c', 'n', 'o', '1', 'Enter', 'Escape', '`', '?']) {
    assert.equal(keyAction(key, { inInput: true }), null, key);
  }
  assert.equal(keyAction('0', { inInput: false, meta: true }), null);
  assert.equal(keyAction('1', { inInput: false, meta: true }), null);
  assert.equal(keyAction('c', { inInput: false, ctrl: true }), null);
  assert.equal(keyAction('r', { inInput: false, alt: true }), null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(30000), '<1m');
  assert.equal(formatDuration(12 * 60000), '12m');
  assert.equal(formatDuration(90 * 60000), '1h 30m');
  assert.equal(formatDuration(3 * 86400000), '3d');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
