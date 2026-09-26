#!/usr/bin/env node
/**
 * Smoke test for the pure Cockpit renderer model
 * (src/renderer/lib/cockpitModel.ts): mergeFeed order, tileModel with and
 * without snapshot.agents, stripTabs, every row of contracts §3.2 through
 * nextMode, and keyAction ignoring keys while an input is focused. Compiles
 * the real source with esbuild, no React, no DOM. Also: Hester chat / DevOps
 * outside the wall, side-dock strips, close fallbacks, strip navigation,
 * wallRepair, and the cockpitMode store's quiet()/hold-end (bundled with
 * react external).
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
const {
  mergeFeed,
  tileModel,
  stripTabs,
  isAgentTab,
  isWallExempt,
  runtimeAgentPtys,
  fallbackTab,
  stripNeighbor,
  wallRepair,
  nextMode,
  keyAction,
  feedNeedsCount,
  formatDuration,
  stripMarkdown,
  plainTitle,
  plainPreview,
  plainLine,
  looksLikeCode,
  taskTitle,
  taskNeedsYou,
  tasksBadge,
  opsBadge,
  copilotBadge,
  SECTIONS,
  SECTION_LABELS,
  DEFAULT_SECTION,
  flattenFileTree,
} = mod;

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
  assert.deepEqual(claude.summary, { text: 'Added requireAuth', preview: 'Added requireAuth', label: 'Claude says' });
  assert.ok(claude.meta.includes('unconfirmed'));
  assert.ok(!claude.meta.some((m) => /busy/.test(m)), 'no busy time while not busy');
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
  assert.deepEqual(tiles[0].summary, { text: 'Working on it', preview: 'Working on it', label: 'Claude says' });
  assert.deepEqual(tiles[0].meta, ['Edit', '2 files']);
  assert.equal(tiles[1].chip.label, 'finished 1m ago');
  assert.equal(tiles[1].title, 'Claude 2');
});

test('tileModel: the tab runtime state wins over an unknown agent summary (same source as the Tabs list)', () => {
  const idleRt = runtime({ pty_id: 12, kind: 'agent', provider: 'claude', fidelity: 'structured', label: 'Claude', state: { ...runtime({}).state, pty_id: 12, state: 'idle-at-prompt', source: 'hooks', since: ago(3), quiet_ms: 60000 } });
  const task = { id: 't1', title: 'Fix it', title_source: 'user', agent: { provider: 'claude', pty_id: 12 }, busy_ms: 91 * 60000, lead: 'delegate', confirmed: true, summary: null, status: 'running' };
  const agents = [{ pty_id: 12, window_id: 1, tab_id: 3, label: 'Claude', provider: 'claude', workspace: WS, state: 'unknown', busy_since: null, idle_since: null, last_tool: null, last_summary: null, files_touched_count: 0 }];
  const [t] = tileModel({ workspace: WS, tabs: [agentTab], sets: noSets, snapshot: snapshot({ agents }), runtime: [idleRt], tasks: [task], now: NOW });
  assert.equal(t.chip.label, 'idle 3m');
  assert.equal(t.chip.tone, 'idle');
  assert.equal(t.agentState, 'idle-at-prompt');
  assert.ok(!t.meta.some((m) => /busy/.test(m)), `no busy time while idle: ${t.meta}`);
  // Busy: the chip shows the current turn, the meta the total.
  const busyRt = { ...idleRt, state: { ...idleRt.state, state: 'busy', since: ago(5) } };
  const [b] = tileModel({ workspace: WS, tabs: [agentTab], sets: noSets, snapshot: snapshot({ agents }), runtime: [busyRt], tasks: [task], now: NOW });
  assert.equal(b.chip.label, 'busy 5m');
  assert.ok(b.meta.includes('1h 31m busy in total'));
  // Only an unknown runtime state and an unknown agent: no "unknown" chip, a quiet time instead.
  const unkRt = { ...idleRt, state: { ...idleRt.state, state: 'unknown', quiet_ms: 4 * 60000 } };
  const [u] = tileModel({ workspace: WS, tabs: [agentTab], sets: noSets, snapshot: snapshot({ agents }), runtime: [unkRt], tasks: [], now: NOW });
  assert.equal(u.chip.label, 'quiet 4m');
});

test('tileModel: agent/auto task titles are made plain; user titles kept', () => {
  const mk = (title, title_source) =>
    tileModel({ workspace: WS, tabs: [agentTab], sets: noSets, snapshot: snapshot({}), runtime: [], now: NOW,
      tasks: [{ id: 't', title, title_source, agent: { provider: 'claude', pty_id: 12 }, busy_ms: 0, lead: 'delegate', confirmed: true, summary: '## Done\n\nFixed **the** `parser`.\n\n```ts\nconst x = 1;\n```', status: 'review' }] })[0];
  assert.equal(mk("u: ${item.title}. ${item.text}',", 'agent').title, 'Claude', 'code-looking agent title falls back to the tab label');
  assert.equal(mk('**Fixed** the `/fs/list` 404 in [api](http://x). Also more.', 'agent').title, 'Fixed the /fs/list 404 in api.');
  assert.equal(mk('*my* title', 'user').title, '*my* title');
  assert.equal(mk('(untitled)', 'auto').title, 'Claude');
  const t = mk('x', 'user');
  assert.equal(t.summary.preview, 'Done Fixed the parser.');
  assert.ok(t.summary.text.includes('```ts'), 'the raw text is kept for the markdown view');
});

test('badges: suggestions and unconfirmed tasks are ambient; failures, proposals, waiting agents are ember', () => {
  assert.deepEqual(opsBadge({ failing: 0, proposals: 0, suggestions: 30 }), { count: 30, ember: false });
  assert.deepEqual(copilotBadge({ returnNonce: 0, seenNonce: 0 }), { count: 0, ember: false, dot: false });
  assert.deepEqual(copilotBadge({ returnNonce: 2, seenNonce: 1 }), { count: 0, ember: false, dot: true }, 'fresh brief: neutral dot, never ember');
  assert.deepEqual(copilotBadge({ returnNonce: 2, seenNonce: 2 }), { count: 0, ember: false, dot: false });
  assert.deepEqual(opsBadge({ failing: 1, proposals: 1, suggestions: 30 }), { count: 2, ember: true });
  assert.deepEqual(opsBadge({ failing: 0, proposals: 0, suggestions: 0 }), { count: 0, ember: false });
  const t = (status, confirmed) => ({ status, confirmed });
  assert.equal(taskNeedsYou(t('review', false)), false, 'an unconfirmed auto task in review is ambient');
  assert.equal(taskNeedsYou(t('review', true)), true);
  assert.equal(taskNeedsYou(t('waiting', false)), true, 'a waiting agent needs you');
  assert.equal(taskNeedsYou(t('running', true)), false);
  assert.deepEqual(tasksBadge([t('review', false), t('running', true), t('review', false), t('idle', false)]), { count: 4, ember: false });
  assert.deepEqual(tasksBadge([t('review', true), t('running', true), t('waiting', false)]), { count: 2, ember: true });
});

test('stripMarkdown / plainTitle / plainPreview / looksLikeCode', () => {
  assert.deepEqual(
    stripMarkdown('# Title\n\n- **bold** item\n1. _em_ and snake_case_name\n> quote with [link](http://a.b) and ![alt](x.png)\n\n```lee-status\nstatus: done\n```\n---\n| a | b |\n|---|---|\n<b>html</b> ~~gone~~'),
    ['Title', '', 'bold item', 'em and snake_case_name', 'quote with link and alt', '', 'a · b', 'html gone'],
  );
  assert.deepEqual(stripMarkdown('Head\n```ts\nconst unclosed = 1;'), ['Head'], 'an unclosed (clipped) fence drops the rest');
  assert.deepEqual(stripMarkdown(null), []);
  for (const code of ["u: ${item.title}. ${item.text}',", 'const x = foo(bar);', '});', 'x = 1', 'if (a) {', '// comment', 'return { a: 1 };', "'hello',"]) {
    assert.ok(looksLikeCode(code), `code: ${code}`);
  }
  for (const prose of ['Fixed the parser (see below).', 'Summary: tests pass', 'Import the file and run it.', 'I renamed foo() to bar() in two places.', 'The build is green.', 'Need a decision: A or B?']) {
    assert.ok(!looksLikeCode(prose), `prose: ${prose}`);
  }
  // Starts mid-code (the old Pi tail clip): the first prose line wins.
  assert.equal(plainTitle("  title: item.title,\n});\n```\n\nAll tests pass now. Next I will clean up."), 'All tests pass now.');
  assert.equal(plainTitle('Done. Fixed the flaky test in the queue.'), 'Done. Fixed the flaky test in the queue.', 'a very short first sentence keeps the line');
  const long = plainTitle('This is a very long first sentence that goes on and on well past the eighty character limit for titles');
  assert.ok(long.length <= 80 && long.endsWith('…'), long);
  assert.equal(plainTitle('```\nonly code\n```'), '');
  assert.equal(plainPreview('Line one.\n\n```\ncode\n```\n- two\n- three\n- four', 3), 'Line one. two three');
  assert.equal(plainLine('**Fixed** it: review'), 'Fixed it: review');
  assert.equal(taskTitle({ title: '`x`', title_source: 'user' }), '`x`');
  assert.equal(taskTitle({ title: '# Heading', title_source: 'auto' }), 'Heading');
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

test('Hester chat and DevOps tabs stay outside the wall (user decision): never agents, never tiles', () => {
  const hester = { id: 7, type: 'agent', label: 'Hester', ptyId: 70, dockPosition: 'center', provider: 'hester' };
  const legacyHester = { id: 8, type: 'hester', label: 'Hester', ptyId: 80, dockPosition: 'center' };
  const devops = { id: 9, type: 'devops', label: 'DevOps', ptyId: 90, dockPosition: 'center' };
  const all = new Set([70, 80, 90]);
  const loud = { snapshotAgents: all, runtimeAgents: all };
  for (const t of [hester, legacyHester, devops]) {
    assert.equal(isWallExempt(t), true, t.type);
    assert.equal(isAgentTab(t, loud), false, `${t.type} is never an agent`);
  }
  assert.equal(isWallExempt(agentTab), false);
  const tabs = [agentTab, hester, legacyHester, devops];
  assert.deepEqual(stripTabs(tabs, { enabled: true, enteredPtys: new Set(), sets: loud }).map((t) => t.id), [7, 8, 9]);
  assert.deepEqual(
    [...runtimeAgentPtys([runtime({ pty_id: 70, provider: 'hester' }), runtime({ pty_id: 30 })])],
    [30],
    'A-reported Hester chats are not runtime agents',
  );
  const tiles = tileModel({
    workspace: WS,
    tabs,
    sets: loud,
    snapshot: snapshot({
      agents: [
        { pty_id: 70, window_id: 1, tab_id: 7, label: 'Hester', provider: 'hester', workspace: WS, state: 'idle', busy_since: null, idle_since: null, last_tool: null, last_summary: null, files_touched_count: 0 },
        { pty_id: 90, window_id: 1, tab_id: 9, label: 'DevOps', provider: 'claude', workspace: WS, state: 'idle', busy_since: null, idle_since: null, last_tool: null, last_summary: null, files_touched_count: 0 },
      ],
    }),
    runtime: [runtime({ pty_id: 80, provider: null }), runtime({ pty_id: 71, provider: 'hester' })],
    tasks: [],
    now: NOW,
  });
  assert.deepEqual(tiles.map((t) => t.ptyId), [12], 'only the real agent is a tile');
});

test('stripTabs works per dock: side-panel agents are walled too', () => {
  const right = [
    { id: 20, type: 'agent', label: 'Claude', ptyId: 200, dockPosition: 'right', provider: 'claude' },
    { id: 21, type: 'files', label: 'Files', ptyId: null, dockPosition: 'right' },
  ];
  assert.deepEqual(stripTabs(right, { enabled: true, enteredPtys: new Set(), sets: noSets }).map((t) => t.id), [21]);
  assert.deepEqual(stripTabs(right, { enabled: true, enteredPtys: new Set([200]), sets: noSets }).map((t) => t.id), [20, 21]);
});

test('fallbackTab: a closing tab falls back to a visible tab, never a hidden agent', () => {
  const file = { id: 1, type: 'file', label: 'main.py', ptyId: null, dockPosition: 'center' };
  const center = [file, shellTab, agentTab]; // agent created last
  const strip = stripTabs(center, { enabled: true, enteredPtys: new Set(), sets: noSets });
  assert.equal(fallbackTab(strip, 1, 'last').id, 4, 'not the hidden agent 3');
  assert.equal(fallbackTab(strip, 4, 'first').id, 1);
  assert.equal(fallbackTab([file], 1), null, 'nothing visible left: no active tab');
});

test('stripNeighbor: next/prev cycle the visible strip only', () => {
  const file = { id: 1, type: 'file', label: 'main.py', ptyId: null, dockPosition: 'center' };
  const center = [file, agentTab, shellTab];
  const strip = stripTabs(center, { enabled: true, enteredPtys: new Set(), sets: noSets });
  assert.deepEqual(strip.map((t) => t.id), [1, 4], 'strip badges: main.py ⌘1, Terminal ⌘2');
  assert.equal(strip[1].id, 4, '⌘2 opens Terminal, not the hidden Claude');
  assert.equal(stripNeighbor(strip, 1, 1).id, 4);
  assert.equal(stripNeighbor(strip, 4, 1).id, 1);
  assert.equal(stripNeighbor(strip, 1, -1).id, 4);
  assert.equal(stripNeighbor(strip, 3, 1).id, 1, 'from a hidden active tab, start of the strip');
  assert.equal(stripNeighbor([file], 1, 1), null);
  assert.equal(stripNeighbor(strip, null, 1), null);
});

test('wallRepair: enter a terminal that became an agent; redirect off a restored hidden agent', () => {
  const base = { enabled: true, mode: 'workbench', isAgent: true, entered: false, ptyId: 13, becameAgent: false, holdEnded: false };
  assert.equal(wallRepair({ ...base, becameAgent: true }), 'enter', 'you ran claude where you work');
  assert.equal(wallRepair({ ...base, becameAgent: true, mode: 'cockpit' }), 'enter');
  assert.equal(wallRepair({ ...base, holdEnded: true }), 'redirect', 'restore left a hidden agent active');
  assert.equal(wallRepair({ ...base, holdEnded: true, mode: 'cockpit' }), null, 'the cockpit→workbench repair handles that');
  assert.equal(wallRepair({ ...base, holdEnded: true, entered: true }), null);
  assert.equal(wallRepair({ ...base, holdEnded: true, isAgent: false }), null);
  assert.equal(wallRepair({ ...base, holdEnded: true, enabled: false }), null);
  assert.equal(wallRepair({ ...base, becameAgent: true, ptyId: null }), null);
  assert.equal(wallRepair(base), null, 'nothing changed');
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

test('nav: Copilot first, every section labelled, at most 9 (number keys), landing stays Feed', () => {
  assert.equal(SECTIONS[0], 'copilot');
  assert.ok(SECTIONS.length <= 9);
  assert.equal(new Set(SECTIONS).size, SECTIONS.length);
  for (const id of SECTIONS) assert.ok(SECTION_LABELS[id], id);
  assert.equal(DEFAULT_SECTION, 'feed');
});

test('nav: Files sits between Ops and Someday', () => {
  assert.equal(SECTIONS.indexOf('files'), SECTIONS.indexOf('ops') + 1);
  assert.equal(SECTIONS.indexOf('someday'), SECTIONS.indexOf('files') + 1);
});

test('nav: Explore comes right after Someday; the full order', () => {
  assert.equal(SECTIONS.indexOf('explore'), SECTIONS.indexOf('someday') + 1);
  assert.deepEqual([...SECTIONS], ['copilot', 'feed', 'tasks', 'ops', 'files', 'someday', 'explore', 'tabs', 'history']);
  assert.equal(SECTIONS.length, 9, 'exactly fills the 1–9 number keys');
});

test('flattenFileTree: expanded dirs inline their children; a filter keeps matches and their folders', () => {
  const d = (path) => ({ name: path.split('/').pop(), path, type: 'directory' });
  const f = (path) => ({ name: path.split('/').pop(), path, type: 'file' });
  const root = [d('/w/src'), d('/w/docs'), f('/w/README.md')];
  const kids = new Map([
    ['/w/src', [d('/w/src/lib'), f('/w/src/main.ts')]],
    ['/w/src/lib', [f('/w/src/lib/util.ts')]],
  ]);
  const names = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.entry.name}`);
  assert.deepEqual(names(flattenFileTree(root, kids, new Set())), ['src', 'docs', 'README.md']);
  assert.deepEqual(names(flattenFileTree(root, kids, new Set(['/w/src']))), ['src', '  lib', '  main.ts', 'docs', 'README.md']);
  assert.deepEqual(names(flattenFileTree(root, kids, new Set(), 'util')), ['src', '  lib', '    util.ts'], 'filter opens folders holding a loaded match');
  assert.deepEqual(flattenFileTree(root, kids, new Set(), 'zzz'), []);
});

test('keyAction: map of §3.7', () => {
  const k = (key, ctx = {}) => keyAction(key, { inInput: false, ...ctx });
  assert.deepEqual(k('1'), { kind: 'section', section: 'copilot' });
  assert.deepEqual(k('2'), { kind: 'section', section: 'feed' });
  assert.deepEqual(k(String(SECTIONS.length)), { kind: 'section', section: 'history' });
  if (SECTIONS.length < 9) assert.equal(k(String(SECTIONS.length + 1)), null, 'no section past the end');
  assert.equal(k('0'), null);
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

test('keyAction: Enter and Space on a focused button belong to the button', () => {
  assert.equal(keyAction('Enter', { inInput: false, onControl: true }), null);
  assert.equal(keyAction(' ', { inInput: false, onControl: true }), null);
  assert.deepEqual(keyAction('j', { inInput: false, onControl: true }), { kind: 'row', delta: 1 }, 'j/k still move from a button');
  assert.deepEqual(keyAction('Enter', { inInput: false, onControl: false }), { kind: 'enter' });
});

test('formatDuration', () => {
  assert.equal(formatDuration(30000), '<1m');
  assert.equal(formatDuration(12 * 60000), '12m');
  assert.equal(formatDuration(90 * 60000), '1h 30m');
  assert.equal(formatDuration(3 * 86400000), '3d');
});

// ---------------------------------------------------------------------------
// cockpitMode store: quiet() fallbacks and hold-end re-checks
// ---------------------------------------------------------------------------

{
  const storePath = join(__dirname, '../src/renderer/components/cockpit/cockpitMode.ts');
  const built = await esbuild.build({
    entryPoints: [storePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['react'],
  });
  const dir = mkdtempSync(join(__dirname, '.cockpit-store-smoke-'));
  const file = join(dir, 'cockpitMode.mjs');
  writeFileSync(file, built.outputFiles[0].text);
  let store;
  try {
    ({ cockpitModeStore: store } = await import(pathToFileURL(file).href));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  test('store: quiet() marks one activation of one tab as not yours', () => {
    store.quiet(5);
    assert.equal(store.takeQuiet(6), false);
    assert.equal(store.takeQuiet(5), true);
    assert.equal(store.takeQuiet(5), false, 'consumed');
  });

  const before = store.getWall().holdEpoch;
  store.hold(30);
  assert.equal(store.holding(), true);
  await new Promise((r) => setTimeout(r, 120));
  test('store: a hold that ends bumps holdEpoch so the wall re-checks active tabs', () => {
    assert.equal(store.holding(), false);
    assert.equal(store.getWall().holdEpoch, before + 1);
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
