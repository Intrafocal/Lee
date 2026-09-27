#!/usr/bin/env node
/**
 * Smoke test for the pure Cockpit renderer model
 * (src/renderer/lib/cockpitModel.ts): mergeFeed order, tileModel with and
 * without snapshot.agents, every row of the Deep D1 §1.2 table through
 * nextMode, the ⌘0 switcher state machine (tap, hold, cycle, Esc, chip), and
 * keyAction ignoring keys while an input is focused. Compiles the real source
 * with esbuild, no React, no DOM. Also: Hester chat / DevOps are own tabs,
 * useHotkeys' chord builder matching ⇧⌘0 / ⌥⌘0 / ⌘. on e.code (D1 §1.3),
 * and the cockpitMode store's landing, Deep memory and switcher (bundled
 * with react external). Cockpit design scaffold: describeActivity's table
 * (both tenses, failures, several files), LEGACY_SECTION / readSection, the
 * six sections, QUICK_REPLIES and the nextGuard. Cockpit design R1:
 * greeting() and meanwhileSentence(), Home's needs rows and sentences, the
 * Launcher's three choices, the rail's dots, the status-bar counts, section
 * migration from every legacy id, and one next button at most per view
 * (Home, Goals, Ops, History and the Launcher rendered from fixtures with
 * react-dom/server, counted through nextGuard).
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

// Bundled so shared/cockpit.ts's pure values (LEGACY_SECTION) come along; any
// other runtime import (React, the DOM, IPC) would stay external and fail here.
const result = await esbuild.build({ entryPoints: [srcPath], bundle: true, format: 'esm', platform: 'node', write: false });
const code = result.outputFiles[0].text;
assert.ok(!/^\s*import\s/m.test(code), 'cockpitModel.ts must have type-only imports (pure)');
const sharedResult = await esbuild.build({ entryPoints: [join(__dirname, '../src/shared/cockpit.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
const sharedCode = sharedResult.outputFiles[0].text;
assert.ok(!/^\s*import\s/m.test(sharedCode), 'shared/cockpit.ts must have type-only imports (pure)');

const tmpDir = mkdtempSync(join(tmpdir(), 'lee-cockpit-smoke-'));
const tmpFile = join(tmpDir, 'cockpitModel.mjs');
writeFileSync(tmpFile, code);
const sharedFile = join(tmpDir, 'cockpitShared.mjs');
writeFileSync(sharedFile, sharedCode);
let mod;
let shared;
try {
  mod = await import(pathToFileURL(tmpFile).href);
  shared = await import(pathToFileURL(sharedFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const {
  mergeFeed,
  tileModel,
  isAgentTab,
  isOwnTab,
  runtimeAgentPtys,
  nextMode,
  deepSessionOf,
  switcherStep,
  SWITCHER_IDLE,
  SWITCHER_HOLD_MS,
  MODES,
  MODE_LABELS,
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
  somedayBadge,
  SECTIONS,
  SECTION_LABELS,
  DEFAULT_SECTION,
  readSection,
  flattenFileTree,
  tabDisplayFromRuntime,
  checkinToasts,
  checkinChipLabel,
  fuzzyScore,
  fuzzyFilter,
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

test('tileModel: notice is the dismissable item that needs you (else any other); working only while busy', () => {
  const mk = (items, state = 'idle-at-prompt') =>
    tileModel({
      workspace: WS,
      tabs: [agentTab],
      sets: noSets,
      snapshot: snapshot({ items }),
      runtime: [runtime({ pty_id: 12, kind: 'agent', provider: 'claude', fidelity: 'structured', label: 'Claude', state: { ...runtime({}).state, pty_id: 12, state } })],
      tasks: [],
      now: NOW,
    })[0];
  const sum = item({ id: 'sum', kind: 'summary', actions: ['open', 'dismiss'] });
  const ap = item({ id: 'ap', kind: 'approval', actions: ['approve', 'deny', 'open', 'snooze', 'dismiss'] });
  assert.equal(mk([sum, ap]).notice.id, 'ap', 'the item that needs you first');
  assert.equal(mk([sum]).notice.id, 'sum');
  assert.equal(mk([item({ id: 'nd', kind: 'summary', actions: ['open'] })]).notice, null, 'not dismissable: no notice');
  assert.equal(mk([]).notice, null);
  assert.equal(mk([], 'busy').working, true);
  assert.equal(mk([]).working, false);
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
  assert.deepEqual(somedayBadge({ open: 5, untriagedOver7d: 3 }), { count: 5, ember: false }, 'old ideas are not needs-you');
  assert.deepEqual(somedayBadge({ open: 0, untriagedOver7d: 0 }), { count: 0, ember: false });
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
// isAgentTab / own tabs
// ---------------------------------------------------------------------------

test('isAgentTab: type agent, snapshot agents, runtime agents; own tabs otherwise', () => {
  assert.equal(isAgentTab(agentTab, noSets), true);
  assert.equal(isAgentTab(shellTab, noSets), false);
  assert.equal(isAgentTab(shellTab, { snapshotAgents: new Set([13]), runtimeAgents: new Set() }), true);
  assert.equal(isAgentTab(shellTab, { snapshotAgents: new Set(), runtimeAgents: new Set([13]) }), true);
  assert.equal(isAgentTab({ id: 5, type: 'file', label: 'a.py', ptyId: null }, noSets), false);
});

test('tabDisplayFromRuntime: a terminal running a hand-started claude is an agent with its provider (icon) and name (label)', () => {
  const rts = [
    runtime({ pty_id: 13, tab_type: 'terminal', provider: 'claude', fidelity: 'screen', name: 'Fix login', name_source: 'ai-title' }),
    runtime({ pty_id: 14, tab_type: 'terminal', kind: 'shell', provider: null }),
    runtime({ pty_id: 15, provider: 'hester', kind: 'agent' }),
    runtime({ pty_id: 16, state: { pty_id: 16, state: 'exited', source: 'none', since: ago(1), quiet_ms: 0, foreground: null } }),
  ];
  const m = tabDisplayFromRuntime(rts);
  assert.deepEqual([...m.keys()], [13]);
  assert.deepEqual(m.get(13), { provider: 'claude', name: 'Fix login' });
  // The same runtime set makes the terminal an agent tab (A reports kind 'agent').
  assert.equal(isAgentTab(shellTab, { snapshotAgents: new Set(), runtimeAgents: runtimeAgentPtys(rts) }), true);
});

test('async check-ins: tile chip from the runtime; results toasted once, only for check-ins seen pending', () => {
  const rt = runtime({ pty_id: 30, checkin: { id: 'chk_1', state: 'queued', queued_at: ago(1), sent_at: null } });
  const [tile] = tileModel({ workspace: WS, tabs: [], sets: noSets, snapshot: null, runtime: [rt], tasks: [], now: NOW });
  assert.deepEqual(tile.checkin, { id: 'chk_1', state: 'queued', label: 'check-in pending' });
  assert.equal(checkinChipLabel('sent'), 'checking in…');
  const entries = [
    entry({ id: 'a', producer: 'checkin', title: 'Checked in on Pi: done', ref: { pty_id: 30, checkin_id: 'chk_1' } }),
    entry({ id: 'b', producer: 'checkin', title: 'Check-in on Pi failed: no reply in time', ref: { pty_id: 30, checkin_id: 'chk_2' } }),
    entry({ id: 'c', producer: 'checkin', title: 'Lee typed into Pi (asked by you)', ref: { pty_id: 30 } }),
    entry({ id: 'd', producer: 'checkin', title: 'Checked in on X: done', ref: { pty_id: 31, checkin_id: 'chk_other' } }),
  ];
  const out = checkinToasts(entries, new Set(['chk_1', 'chk_2']), new Set());
  assert.deepEqual(out.map((t) => [t.checkin_id, t.level]), [['chk_1', 'info'], ['chk_2', 'error']]);
  assert.deepEqual(checkinToasts(entries, new Set(['chk_1']), new Set(['chk_1'])), []);
});

test('names: the session name wins on tiles, task rows and attention sources', () => {
  assert.equal(taskTitle({ title: 'Fix it', title_source: 'user', name: 'Login fix' }), 'Login fix');
  assert.equal(taskTitle({ title: 'Fix it', title_source: 'user', name: null }), 'Fix it');
  const rt = runtime({ pty_id: 30, name: 'Live name', name_source: 'ai-title' });
  const task = { id: 't1', title: 'Old', title_source: 'agent', name: 'Task name', name_source: 'user', agent: { provider: 'pi', pty_id: 30 }, lead: 'delegate', confirmed: true, busy_ms: 0 };
  const [tile] = tileModel({ workspace: WS, tabs: [], sets: noSets, snapshot: null, runtime: [rt], tasks: [task], now: NOW });
  assert.equal(tile.title, 'Live name');
  assert.equal(tile.nameSource, 'ai-title');
  const [tile2] = tileModel({ workspace: WS, tabs: [], sets: noSets, snapshot: null, runtime: [runtime({ pty_id: 30 })], tasks: [task], now: NOW });
  assert.equal(tile2.title, 'Task name');
  const rows = mergeFeed({ workspace: WS, items: [item({ source: { ...item().source, pty_id: 12, tab_label: 'Claude' } })], names: new Map([[12, 'Auth review']]) });
  assert.equal(rows[0].item.source.tab_label, 'Auth review');
});

test('fuzzy: subsequence match, basename and boundary matches first, non-matches dropped', () => {
  const files = ['electron/src/main/cockpit/launcher.ts', 'docs/13-Copilot.md', 'electron/src/renderer/components/cockpit/Launcher.tsx', 'README.md'];
  assert.equal(fuzzyScore('zzz', 'README.md'), Number.NEGATIVE_INFINITY);
  const top = fuzzyFilter('launcher', files, (f) => f, 5);
  assert.equal(top.length, 2);
  assert.ok(top.every((f) => /launcher/i.test(f)));
  assert.equal(fuzzyFilter('rdme', files, (f) => f)[0], 'README.md');
  assert.deepEqual(fuzzyFilter('', files, (f) => f, 2), files.slice(0, 2));
  assert.ok(fuzzyScore('cop', 'docs/13-Copilot.md') > fuzzyScore('cop', 'electron/src/main/cockpit/launcher.ts'));
});

test('Hester chat and DevOps tabs are own tabs (user decision): never agents, never tiles', () => {
  const hester = { id: 7, type: 'agent', label: 'Hester', ptyId: 70, dockPosition: 'center', provider: 'hester' };
  const legacyHester = { id: 8, type: 'hester', label: 'Hester', ptyId: 80, dockPosition: 'center' };
  const devops = { id: 9, type: 'devops', label: 'DevOps', ptyId: 90, dockPosition: 'center' };
  const all = new Set([70, 80, 90]);
  const loud = { snapshotAgents: all, runtimeAgents: all };
  for (const t of [hester, legacyHester, devops]) {
    assert.equal(isOwnTab(t), true, t.type);
    assert.equal(isAgentTab(t, loud), false, `${t.type} is never an agent`);
  }
  assert.equal(isOwnTab(agentTab), false);
  const tabs = [agentTab, hester, legacyHester, devops];
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

test('D1 §1.4: the wall is gone (no strip, fallback or repair helpers left)', () => {
  for (const name of ['stripTabs', 'fallbackTab', 'stripNeighbor', 'wallRepair', 'isWallExempt']) {
    assert.equal(mod[name], undefined, name);
  }
});

// ---------------------------------------------------------------------------
// nextMode: every row of Deep D1 §1.2
// ---------------------------------------------------------------------------

const C = { enabled: true, mode: 'cockpit' };
const D = { enabled: true, mode: 'deep', hasExploration: true };
const M = { enabled: true, mode: 'manual' };
const OFF = { enabled: false, mode: 'manual' };
const withExp = (s, deepActive = false) => ({ ...s, hasExploration: true, deepActive });

test('D1 §1.2 load → cockpit always (Manual only when the Cockpit is off)', () => {
  assert.deepEqual(nextMode(M, { kind: 'load', enabled: true }), { mode: 'cockpit', reason: 'default' });
  assert.deepEqual(nextMode(C, { kind: 'load', enabled: false }), { mode: 'manual', reason: 'default' });
  assert.equal(MODES.length, 3);
  assert.deepEqual([...MODES], ['cockpit', 'deep', 'manual']);
  assert.equal(MODE_LABELS.manual, 'Manual');
  assert.equal(Object.values(MODE_LABELS).includes('Workbench'), false);
});

test('D1 §1.2 switcher {to} → to, reason switcher; Deep with nothing open → a blank Page', () => {
  assert.deepEqual(nextMode(C, { kind: 'switcher', to: 'manual' }), { mode: 'manual', reason: 'switcher' });
  assert.deepEqual(nextMode(M, { kind: 'switcher', to: 'cockpit' }), { mode: 'cockpit', reason: 'switcher' });
  assert.deepEqual(nextMode(withExp(C), { kind: 'switcher', to: 'deep' }), { mode: 'deep', reason: 'switcher' });
  assert.equal(nextMode(C, { kind: 'switcher', to: 'cockpit' }), null);
  assert.deepEqual(nextMode(M, { kind: 'switcher', to: 'deep' }), { mode: 'manual', reason: null, blank: true });
  assert.deepEqual(nextMode(C, { kind: 'switcher', to: 'deep' }), { mode: 'cockpit', reason: null, blank: true });
});

test('D1 §1.2 toggle_deep (⇧⌘0): cockpit ↔ deep, manual → deep; hop when a session is active', () => {
  assert.deepEqual(nextMode(withExp(C), { kind: 'toggle_deep' }), { mode: 'deep', reason: 'deep_start' });
  assert.deepEqual(nextMode(withExp(C, true), { kind: 'toggle_deep' }), { mode: 'deep', reason: 'hop' });
  assert.deepEqual(nextMode(withExp(M, true), { kind: 'toggle_deep' }), { mode: 'deep', reason: 'hop' });
  assert.deepEqual(nextMode(withExp(D, true), { kind: 'toggle_deep' }), { mode: 'cockpit', reason: 'hop' });
  assert.deepEqual(nextMode(M, { kind: 'toggle_deep' }), { mode: 'manual', reason: null, blank: true }, 'nothing open: a blank Page (the mode changes once it exists)');
});

test('D1 §1.2 toggle_manual (⌥⌘0): cockpit ↔ manual, deep → manual; reason hop', () => {
  assert.deepEqual(nextMode(C, { kind: 'toggle_manual' }), { mode: 'manual', reason: 'hop' });
  assert.deepEqual(nextMode(M, { kind: 'toggle_manual' }), { mode: 'cockpit', reason: 'hop' });
  assert.deepEqual(nextMode(D, { kind: 'toggle_manual' }), { mode: 'manual', reason: 'hop' });
});

test('D1 §1.2 deep_session: start → deep (deep_start); end → cockpit only from deep', () => {
  assert.deepEqual(nextMode(withExp(C, true), { kind: 'deep_session', active: true }), { mode: 'deep', reason: 'deep_start' });
  assert.deepEqual(nextMode({ ...C, deepActive: true }, { kind: 'deep_session', active: true }), { mode: 'cockpit', reason: null, opener: true }, 'a device Go deep with nothing open');
  assert.deepEqual(nextMode(D, { kind: 'deep_session', active: false }), { mode: 'cockpit', reason: 'deep_end' });
  assert.equal(nextMode(M, { kind: 'deep_session', active: false }), null);
  assert.equal(nextMode(C, { kind: 'deep_session', active: false }), null);
});

test('D1 §1.2 handoff / return → cockpit, unless deep in an active Deep session', () => {
  assert.deepEqual(nextMode(M, { kind: 'handoff' }), { mode: 'cockpit', reason: 'handoff' });
  assert.deepEqual(nextMode(M, { kind: 'return' }), { mode: 'cockpit', reason: 'return' });
  assert.equal(nextMode(C, { kind: 'return' }), null);
  assert.equal(nextMode(withExp(D, true), { kind: 'return' }), null, 'a short absence keeps you in Deep');
  assert.equal(nextMode(withExp(D, true), { kind: 'handoff' }), null);
  assert.deepEqual(nextMode(D, { kind: 'return' }), { mode: 'cockpit', reason: 'return' }, 'no session: back to the Cockpit');
});

test('D1 §1.2 go_into → manual (logged); open_tab → manual; tab_activated never moves', () => {
  assert.deepEqual(nextMode(C, { kind: 'go_into', ptyId: 12 }), { mode: 'manual', reason: 'go_into', goInto: 12 });
  assert.deepEqual(nextMode(D, { kind: 'go_into', ptyId: 12 }), { mode: 'manual', reason: 'go_into', goInto: 12 });
  assert.deepEqual(nextMode(M, { kind: 'go_into', ptyId: 12 }), { mode: 'manual', reason: null, goInto: 12 });
  assert.deepEqual(nextMode(C, { kind: 'open_tab' }), { mode: 'manual', reason: 'open_tab' });
  assert.deepEqual(nextMode(D, { kind: 'open_tab' }), { mode: 'manual', reason: 'open_tab' });
  assert.equal(nextMode(M, { kind: 'open_tab' }), null);
  for (const s of [C, D, M]) assert.equal(nextMode(s, { kind: 'tab_activated' }), null, s.mode);
});

test('D1 §1.2 nothing moves while the Cockpit is disabled', () => {
  for (const t of [
    { kind: 'switcher', to: 'cockpit' },
    { kind: 'toggle_deep' },
    { kind: 'toggle_manual' },
    { kind: 'deep_session', active: true },
    { kind: 'handoff' },
    { kind: 'return' },
    { kind: 'go_into', ptyId: 1 },
    { kind: 'open_tab' },
    { kind: 'tab_activated' },
  ]) {
    assert.equal(nextMode(OFF, t), null, JSON.stringify(t));
  }
});

test('deepSessionOf: an active source:deep focus in this workspace', () => {
  const focus = (o) => snapshot({ focus: { active: true, session_id: 'f1', source: 'deep', started_at: ago(3), item: null, quiet_count: 2, policy: 'none', deep: null, ...o } });
  assert.deepEqual(deepSessionOf(focus({ deep: { exploration_id: 'exp-1', title: 'Clocks', workspace: WS } }), WS), { exploration_id: 'exp-1', title: 'Clocks' });
  assert.deepEqual(
    deepSessionOf(focus({ item: { kind: 'exploration', workspace: WS, exploration_id: null, title: '' } }), WS),
    { exploration_id: null, title: '' },
    'from the focus item; nothing open yet',
  );
  assert.equal(deepSessionOf(focus({ deep: { exploration_id: 'exp-1', title: 'x', workspace: '/other' } }), WS), null, 'another workspace');
  assert.equal(deepSessionOf(focus({ source: 'inferred' }), WS), null);
  assert.equal(deepSessionOf(focus({ active: false }), WS), null);
  assert.equal(deepSessionOf(snapshot({}), WS), null);
  assert.deepEqual(deepSessionOf(focus({}), WS), { exploration_id: null, title: '' }, 'no workspace on record: machine-wide');
});

// ---------------------------------------------------------------------------
// The ⌘0 switcher (D1 §1.3)
// ---------------------------------------------------------------------------

test('switcher: a quick tap goes back to the last mode (via tap)', () => {
  let s = switcherStep(SWITCHER_IDLE, { kind: 'zero', now: 1000, lastMode: 'manual' }).state;
  assert.equal(s.phase, 'pending');
  assert.equal(switcherStep(s, { kind: 'tick', now: 1100 }).state, s, 'no overlay before 250 ms');
  const up = switcherStep(s, { kind: 'meta_up', now: 1000 + SWITCHER_HOLD_MS - 1 });
  assert.deepEqual(up.commit, { to: 'manual', via: 'tap' });
  assert.equal(up.state.phase, 'idle');
});

test('switcher: holding ⌘ shows the cards; each further 0 cycles; release commits (via overlay)', () => {
  let s = switcherStep(SWITCHER_IDLE, { kind: 'zero', now: 0, lastMode: 'cockpit' }).state;
  s = switcherStep(s, { kind: 'tick', now: SWITCHER_HOLD_MS }).state;
  assert.equal(s.phase, 'open');
  assert.equal(s.highlight, 'cockpit', 'the last mode is highlighted first');
  s = switcherStep(s, { kind: 'zero', now: 400, lastMode: 'cockpit' }).state;
  assert.equal(s.highlight, 'deep');
  s = switcherStep(s, { kind: 'zero', now: 500, lastMode: 'cockpit' }).state;
  assert.equal(s.highlight, 'manual');
  s = switcherStep(s, { kind: 'zero', now: 600, lastMode: 'cockpit' }).state;
  assert.equal(s.highlight, 'cockpit', 'wraps');
  s = switcherStep(s, { kind: 'move', delta: -1 }).state;
  assert.equal(s.highlight, 'manual');
  const up = switcherStep(s, { kind: 'meta_up', now: 700 });
  assert.deepEqual(up.commit, { to: 'manual', via: 'overlay' });
});

test('switcher: a second 0 while held opens at once', () => {
  let s = switcherStep(SWITCHER_IDLE, { kind: 'zero', now: 0, lastMode: 'deep' }).state;
  s = switcherStep(s, { kind: 'zero', now: 50, lastMode: 'deep' }).state;
  assert.equal(s.phase, 'open');
  assert.equal(s.highlight, 'deep');
});

test('switcher: a slow release with no tick still counts as the overlay', () => {
  const s = switcherStep(SWITCHER_IDLE, { kind: 'zero', now: 0, lastMode: 'deep' }).state;
  assert.deepEqual(switcherStep(s, { kind: 'meta_up', now: 600 }).commit, { to: 'deep', via: 'overlay' });
});

test('switcher: Esc cancels (pending or open), with no commit', () => {
  let s = switcherStep(SWITCHER_IDLE, { kind: 'zero', now: 0, lastMode: 'manual' }).state;
  let e = switcherStep(s, { kind: 'escape' });
  assert.equal(e.state.phase, 'idle');
  assert.equal(e.commit, undefined);
  s = switcherStep(switcherStep(s, { kind: 'tick', now: 300 }).state, { kind: 'zero', now: 310, lastMode: 'manual' }).state;
  e = switcherStep(s, { kind: 'escape' });
  assert.equal(e.state.phase, 'idle');
  assert.equal(e.commit, undefined);
  assert.equal(switcherStep(e.state, { kind: 'meta_up', now: 400 }).commit, undefined, 'the release after Esc does nothing');
});

test('switcher: the chip opens the same cards; ⌘ release does not commit; click or Enter does (via chip)', () => {
  let s = switcherStep(SWITCHER_IDLE, { kind: 'chip', lastMode: 'cockpit' }).state;
  assert.equal(s.phase, 'open');
  assert.equal(s.fromChip, true);
  assert.equal(switcherStep(s, { kind: 'meta_up', now: 0 }).commit, undefined);
  assert.deepEqual(switcherStep(s, { kind: 'click', to: 'deep' }).commit, { to: 'deep', via: 'chip' });
  s = switcherStep(s, { kind: 'highlight', to: 'manual' }).state;
  assert.deepEqual(switcherStep(s, { kind: 'enter' }).commit, { to: 'manual', via: 'chip' });
  assert.deepEqual(switcherStep(SWITCHER_IDLE, { kind: 'click', to: 'deep' }), { state: SWITCHER_IDLE }, 'nothing open: nothing to click');
});

// ---------------------------------------------------------------------------
// keyAction
// ---------------------------------------------------------------------------

test('nav: six sections, Home first, every section labelled, landing on Home (cockpit-design §2.2)', () => {
  assert.deepEqual([...SECTIONS], ['home', 'work', 'goals', 'library', 'ops', 'history']);
  for (const id of SECTIONS) assert.ok(SECTION_LABELS[id], id);
  assert.equal(DEFAULT_SECTION, 'home');
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

test('keyAction: map of §3.7 (⌘ chords for actions, bare keys only navigate)', () => {
  const k = (key, ctx = {}) => keyAction(key, { inInput: false, ...ctx });
  const cmd = (key, ctx = {}) => k(key, { meta: true, ...ctx });
  assert.deepEqual(k('ArrowDown'), { kind: 'row', delta: 1 });
  assert.deepEqual(k('ArrowUp'), { kind: 'row', delta: -1 });
  // The agent dock is gone from the Cockpit (cockpit-design §2.1): ←/→ do nothing.
  assert.equal(k('ArrowLeft'), null);
  assert.equal(k('ArrowRight'), null);
  assert.deepEqual(k('Enter'), { kind: 'enter' });
  assert.deepEqual(k('Escape'), { kind: 'escape' });
  for (const [key, kind] of [['Enter', 'approve'], ['d', 'deny'], ['e', 'rename'], ['Backspace', 'dismiss'], ['t', 'manual']]) {
    assert.deepEqual(cmd(key), { kind }, `⌘${key}`);
  }
  assert.deepEqual(cmd('D'), { kind: 'deny' }, 'caps lock does not matter');
  // Shifted punctuation matches the physical key; `key` is only a fallback.
  for (const [code, key, kind] of [['Comma', '<', 'reply'], ['Period', '>', 'checkin'], ['BracketLeft', '{', 'run']]) {
    assert.deepEqual(cmd(',', { shift: true, code }), { kind }, code);
    assert.deepEqual(cmd(key, { shift: true }), { kind }, key);
  }
});

test('keyAction: no bare letter, digit or symbol does anything', () => {
  const printable = 'abcdefghijklmnopqrstuvwxyz0123456789`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/? ';
  for (const key of printable) {
    assert.equal(keyAction(key, { inInput: false }), null, JSON.stringify(key));
    assert.equal(keyAction(key.toUpperCase(), { inInput: false, shift: true }), null, JSON.stringify(key));
  }
  assert.equal(keyAction('Backspace', { inInput: false }), null);
});

test('keyAction: ⌘ chords the Cockpit leaves to Lee and the OS', () => {
  const cmd = (key, ctx = {}) => keyAction(key, { inInput: false, meta: true, ...ctx });
  // ⌘1–9 switch tabs, ⌘0 toggles the Cockpit, ⌘N is the menu's (App routes it
  // to the Launcher), ⌘R reloads, ⌘A/C/X/V are the Edit menu, ⌘O opens a file.
  for (const key of ['0', '1', '9', 'n', 'r', 'a', 'c', 'x', 'v', 'o', 'w', 'i', 's', '/', ',', '[', ']', '`']) {
    assert.equal(cmd(key), null, `⌘${key}`);
  }
  assert.equal(cmd('Enter', { shift: true }), null, '⇧⌘⏎');
  assert.equal(cmd('/', { shift: true, code: 'Slash' }), null, '⇧⌘/ is Ask Hester');
});

test('keyAction: ignored while typing in an input, and for ⌃/⌥ chords', () => {
  for (const [key, ctx] of [['ArrowDown', {}], ['Enter', {}], ['Escape', {}], ['Enter', { meta: true }], ['Backspace', { meta: true }], ['d', { meta: true }], [',', { meta: true, shift: true, code: 'Comma' }]]) {
    assert.equal(keyAction(key, { inInput: true, ...ctx }), null, key);
  }
  assert.equal(keyAction('d', { inInput: false, meta: true, ctrl: true }), null);
  assert.equal(keyAction('Enter', { inInput: false, meta: true, alt: true }), null);
  assert.equal(keyAction('ArrowDown', { inInput: false, ctrl: true }), null);
});

test('keyAction: Enter and Space on a focused button belong to the button', () => {
  assert.equal(keyAction('Enter', { inInput: false, onControl: true }), null);
  assert.equal(keyAction(' ', { inInput: false, onControl: true }), null);
  assert.deepEqual(keyAction('ArrowDown', { inInput: false, onControl: true }), { kind: 'row', delta: 1 }, 'arrows still move from a button');
  assert.deepEqual(keyAction('Enter', { inInput: false, onControl: true, meta: true }), { kind: 'approve' }, '⌘⏎ still approves from a button');
  assert.deepEqual(keyAction('Enter', { inInput: false, onControl: false }), { kind: 'enter' });
});

test('formatDuration', () => {
  assert.equal(formatDuration(30000), '<1m');
  assert.equal(formatDuration(12 * 60000), '12m');
  assert.equal(formatDuration(90 * 60000), '1h 30m');
  assert.equal(formatDuration(3 * 86400000), '3d');
});

// ---------------------------------------------------------------------------
// cockpitMode store: landing, hops, Deep memory, the switcher, End session
// ---------------------------------------------------------------------------

async function bundle(rel, name) {
  const built = await esbuild.build({
    entryPoints: [join(__dirname, rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['react'],
  });
  const dir = mkdtempSync(join(__dirname, `.${name}-smoke-`));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, built.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { cockpitModeStore: store } = await bundle('../src/renderer/components/cockpit/cockpitMode.ts', 'cockpit-store');

  test('store: Lee opens in the Cockpit on Copilot (D1 §1.2, §8.3)', () => {
    assert.equal(store.get().mode, 'cockpit');
    store.configure(true);
    assert.equal(store.get().mode, 'cockpit');
    assert.equal(store.get().section, 'home');
    store.setSection('work');
    store.configure(true);
    assert.equal(store.get().section, 'work', 'the section is remembered within the session');
    store.setSection('home');
  });

  test('store: ⇧⌘0 with nothing open never shows an empty Deep (it opens a blank Page once one exists)', () => {
    store.setSection('work');
    store.toggleDeep();
    assert.equal(store.get().mode, 'cockpit', 'no Deep until the blank exploration exists');
    assert.equal(store.get().section, 'work', 'the opener is not forced');
    store.setSection('home');
  });

  test('store: openDeep remembers the exploration and shows Deep (deep_start, then hop)', () => {
    store.openDeep('exp-1', 'Vector clocks');
    assert.equal(store.get().mode, 'deep');
    assert.equal(store.get().reason, 'deep_start');
    assert.deepEqual(store.getDeep(), { exploration_id: 'exp-1', title: 'Vector clocks', view: 'page' });
    store.toggleDeep();
    assert.equal(store.get().mode, 'cockpit');
    assert.equal(store.get().reason, 'hop');
    assert.equal(store.get().lastMode, 'deep');
    store.toggleManual();
    assert.equal(store.get().mode, 'manual');
    store.toggleDeep();
    assert.equal(store.get().mode, 'deep', 'Manual → Deep keeps the open exploration');
    store.toggleManual();
    assert.equal(store.get().mode, 'manual');
    store.toggleManual();
    assert.equal(store.get().mode, 'cockpit');
  });

  test('store: a ⌘0 tap goes back to the last mode', () => {
    assert.equal(store.get().lastMode, 'manual');
    const now = Date.now();
    store.switcher({ kind: 'zero', now, lastMode: store.get().lastMode });
    assert.equal(store.get().switcher.phase, 'pending');
    store.switcher({ kind: 'meta_up', now: now + 10 });
    assert.equal(store.get().switcher.phase, 'idle');
    assert.equal(store.get().mode, 'manual');
    assert.equal(store.get().reason, 'switcher');
  });

  test('store: the chip opens the cards; a click commits; Esc cancels', () => {
    store.switcher({ kind: 'chip', lastMode: store.get().lastMode });
    assert.equal(store.get().switcher.phase, 'open');
    store.switcher({ kind: 'escape' });
    assert.equal(store.get().switcher.phase, 'idle');
    assert.equal(store.get().mode, 'manual');
    store.switcher({ kind: 'chip', lastMode: store.get().lastMode });
    store.switcher({ kind: 'click', to: 'deep' });
    assert.equal(store.get().mode, 'deep');
  });

  test('store: End session reaches the Deep surface', () => {
    let asked = 0;
    const off = store.onEndSessionRequest(() => (asked += 1));
    assert.equal(store.canRequestEndSession(), true);
    store.set('cockpit', 'hop');
    store.requestEndSession();
    assert.equal(asked, 1);
    assert.equal(store.get().mode, 'deep', 'Deep shows first: the sheet lives there');
    off();
    assert.equal(store.canRequestEndSession(), false);
  });

  let openerFocused = 0;
  const offOpener = store.onFocusOpener(() => (openerFocused += 1));
  store.focusOpener();
  await new Promise((r) => setTimeout(r, 80));
  test('store: focusOpener shows the Cockpit on Home and focuses the opener once', () => {
    assert.equal(store.get().mode, 'cockpit');
    assert.equal(store.get().section, 'home');
    assert.equal(openerFocused, 1);
  });
  offOpener();

  test('store: entering Deep on a remembered exploration with no session starts one', () => {
    const calls = [];
    globalThis.window = { lee: { copilot: { deepStart: (req) => (calls.push(req), Promise.resolve({})) } } };
    try {
      assert.equal(store.get().mode, 'cockpit');
      assert.equal(store.get().deepActive, false);
      store.toggleDeep();
      assert.equal(store.get().mode, 'deep');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].exploration_id, 'exp-1');
      assert.equal(calls[0].surface, 'lee');
      store.toggleDeep();
      assert.equal(store.get().mode, 'cockpit');
      assert.equal(calls.length, 1, 'leaving Deep starts nothing');
      store.switcher({ kind: 'chip', lastMode: store.get().lastMode });
      store.switcher({ kind: 'click', to: 'deep' });
      assert.equal(calls.length, 2, 'the switcher does the same');
      store.set('cockpit', 'hop');
    } finally {
      delete globalThis.window;
    }
  });

  test('store: with the Cockpit off, Manual only (Deep unavailable)', () => {
    store.configure(false);
    assert.equal(store.get().mode, 'manual');
    store.set('deep', 'switcher');
    store.set('cockpit', 'switcher');
    store.openDeep('exp-2', 'x');
    assert.equal(store.get().mode, 'manual');
  });
}

// ---------------------------------------------------------------------------
// useHotkeys' chord builder: e.code for digits and punctuation (D1 §1.3)
// ---------------------------------------------------------------------------

{
  const { hotkeyCombos } = await bundle('../src/renderer/hooks/useHotkeys.ts', 'hotkeys');
  const ev = (o) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

  test('hotkeys: ⇧⌘0 (key ")"), ⌥⌘0 (key "º") and ⌥⌘1 (key "¡") match on e.code', () => {
    assert.ok(hotkeyCombos(ev({ key: ')', code: 'Digit0', metaKey: true, shiftKey: true }), true).includes('meta+shift+0'));
    assert.ok(hotkeyCombos(ev({ key: 'º', code: 'Digit0', metaKey: true, altKey: true }), true).includes('meta+alt+0'));
    assert.ok(hotkeyCombos(ev({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), true).includes('meta+alt+1'));
  });

  test('hotkeys: ⌘. matches on e.code; ⇧⌘. keeps its own chord', () => {
    assert.ok(hotkeyCombos(ev({ key: '.', code: 'Period', metaKey: true }), true).includes('meta+.'));
    const shifted = hotkeyCombos(ev({ key: '>', code: 'Period', metaKey: true, shiftKey: true }), true);
    assert.ok(shifted.includes('meta+shift+.'));
    assert.equal(shifted.includes('meta+.'), false);
  });

  test('hotkeys: existing key-based chords are unchanged and tried first', () => {
    assert.deepEqual(hotkeyCombos(ev({ key: '0', code: 'Digit0', metaKey: true }), true), ['meta+0']);
    assert.deepEqual(hotkeyCombos(ev({ key: 'T', code: 'KeyT', metaKey: true, shiftKey: true }), true), ['meta+shift+t']);
    assert.deepEqual(hotkeyCombos(ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }), true), ['meta+shift+{', 'meta+shift+[']);
    assert.deepEqual(hotkeyCombos(ev({ key: 'Escape', code: 'Escape', metaKey: true }), true), ['meta+esc']);
    assert.deepEqual(hotkeyCombos(ev({ key: 'w', code: 'KeyW', metaKey: true }), false), ['meta+w', 'ctrl+w'], 'non-mac ctrl fallback');
    assert.deepEqual(hotkeyCombos(ev({ key: 'c', code: 'KeyC', ctrlKey: true }), true), ['ctrl+c'], 'mac: ⌃ is not ⌘');
    assert.deepEqual(hotkeyCombos(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true), ['meta'], 'a bare modifier');
  });
}

// v4: Goals, quadrants, proposals, the Q4 note (pure helpers in cockpitModel.ts).
test('v4: goals badge is ember only when a goal is flagged', () => {
  assert.deepEqual(mod.goalsBadge([{ flagged: true }, { flagged: false }]), { count: 1, ember: true });
  assert.deepEqual(mod.goalsBadge([]), { count: 0, ember: false });
});
test('v4: quadrant chip and rank (play beats Q4; unclassified sorts between Q3 and Q4)', () => {
  assert.equal(mod.quadrantChip({ quadrant: 'Q4', play: true }).label, 'play');
  assert.equal(mod.quadrantChip({ quadrant: null }).label, 'unclassified');
  const order = ['Q4', null, 'Q3', 'Q1', 'Q2'].sort((a, b) => mod.quadrantRank(a) - mod.quadrantRank(b));
  assert.deepEqual(order, ['Q1', 'Q2', 'Q3', null, 'Q4']);
});
test('v4: override auto maps to null', () => {
  assert.equal(mod.overrideChoice({ important: null, urgent: true, at: null }, 'important'), 'auto');
  assert.equal(mod.overrideChoice({ important: null, urgent: true, at: null }, 'urgent'), 'on');
  assert.deepEqual(mod.overridePatch('important', 'auto'), { important: null });
  assert.deepEqual(mod.overridePatch('urgent', 'off'), { urgent: false });
});
test('v4: the Q4 note shows only for unlinked, non-play, delegated prototypes', () => {
  const base = { kind: 'prototype', text: 'try x', serves: [], play: false, lead: 'delegate' };
  assert.equal(mod.q4NoteVisible(base), true);
  assert.equal(mod.q4NoteVisible({ ...base, kind: null, text: 'proto: try x' }), true);
  assert.equal(mod.q4NoteVisible({ ...base, serves: ['G1'] }), false);
  assert.equal(mod.q4NoteVisible({ ...base, play: true }), false);
  assert.equal(mod.q4NoteVisible({ ...base, lead: 'human' }), false);
  assert.equal(mod.q4NoteVisible({ ...base, kind: 'bug' }), false);
});
test('v4: balance strip always has six bands in order', () => {
  const segs = mod.balanceSegments({ Q2: 1000, play: 3000 });
  assert.deepEqual(segs.map((s) => s.band), ['Q1', 'Q2', 'Q3', 'Q4', 'play', 'unclassified']);
  assert.equal(segs[1].share, 0.25);
  assert.equal(mod.balanceSegments(null).every((s) => s.share === 0), true);
});
test('v4: chips and labels', () => {
  assert.equal(mod.goalDeltaChip('G1', 180, 'ms'), 'G1 +180 ms');
  assert.equal(mod.formatMetricValue(0.42, '%'), '42%');
  assert.equal(mod.steerSendLabel('busy'), 'Send now (agent is busy)');
});
test('v4: proposals: bad input plans nothing; task ids come from params', () => {
  assert.equal(mod.proposalPlan({ action: 'nope', params: {} }, '/ws'), null);
  assert.equal(mod.proposalPlan({ action: 'create_task', params: {} }, '/ws'), null);
  assert.equal(mod.proposalPlan({ action: 'set_lead', params: { task_id: 't1', lead: 'boss' } }, '/ws'), null);
  assert.notEqual(mod.proposalPlan({ action: 'create_task', params: { title: 'Spike' } }, '/ws'), null);
  assert.equal(mod.proposalTaskId({ action: 'set_lead', params: { task_id: 't1', lead: 'plan' } }), 't1');
  assert.equal(mod.proposalTaskId({ action: 'park', params: { text: 'x' } }), null);
});
test('v4: link_goal adds to the task\'s serves (PATCH replaces, so the current ones are merged in)', () => {
  const plan = mod.proposalPlan({ action: 'link_goal', params: { task_id: 't1', serves: ['G2', 'G1'] } }, '/ws');
  assert.deepEqual(plan, { kind: 'patch_task', taskId: 't1', body: { serves: ['G2', 'G1'] } });
  assert.deepEqual(mod.mergeServes(['G1', 'G3'], plan.body.serves), ['G1', 'G3', 'G2']);
  assert.deepEqual(mod.mergeServes(null, ['G2']), ['G2']);
});
test('v4: renderer_action is read from lint.fix and from feed.act (nested) results', () => {
  assert.deepEqual(mod.rendererAction({ success: true, data: { renderer_action: 'link-goal', task_id: 't1' } }), { action: 'link-goal', taskId: 't1' });
  assert.deepEqual(mod.rendererAction({ success: true, data: { success: true, data: { renderer_action: 'what-next' } } }), { action: 'what-next', taskId: null });
  assert.equal(mod.rendererAction({ success: true }), null);
});

// ---------------------------------------------------------------------------
// Cockpit design scaffold (cockpit-design §9, §10 S): describeActivity's
// §7.1 table in both tenses, and the section migration.
// ---------------------------------------------------------------------------

{
  const { describeActivity, LEGACY_SECTION, QUICK_REPLIES } = shared;
  const act = (tool, preview = '', files = [], extra = {}) => ({ tool, preview, files, ...extra });

  test('describeActivity: edits, one file and several (now and past)', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      assert.equal(describeActivity(act(tool, '/ws/src/main.ts', ['/ws/src/main.ts'])), 'Editing main.ts', tool);
      assert.equal(describeActivity(act(tool, '/ws/src/main.ts', ['/ws/src/main.ts']), 'past'), 'Edited main.ts', tool);
    }
    assert.equal(describeActivity(act('MultiEdit', '/ws/a.ts', ['/ws/a.ts', '/ws/b.ts', '/ws/c.ts'])), 'Editing 3 files');
    assert.equal(describeActivity(act('Edit', '', ['/ws/a.ts', '/ws/b.ts']), 'past'), 'Edited 2 files');
    assert.equal(describeActivity(act('Write', '/ws/notes/plan.md')), 'Editing plan.md', 'no files: the preview names it');
    assert.equal(describeActivity(act('Edit')), 'Editing', 'nothing names a file');
  });

  test('describeActivity: reads', () => {
    assert.equal(describeActivity(act('Read', '/ws/README.md', ['/ws/README.md'])), 'Reading README.md');
    assert.equal(describeActivity(act('Read', '', ['/a', '/b', '/c', '/d'])), 'Reading 4 files');
    assert.equal(describeActivity(act('Read', '/ws/README.md', ['/ws/README.md']), 'past'), 'Read README.md');
    assert.equal(describeActivity(act('Read', '', ['/a', '/b']), 'past'), 'Read 2 files');
  });

  test('describeActivity: searches, with the pattern only when the preview is one (≤ 30 chars)', () => {
    assert.equal(describeActivity(act('Grep', 'describeActivity')), 'Searching for describeActivity');
    assert.equal(describeActivity(act('Glob', 'src/**/*.tsx')), 'Searching for src/**/*.tsx');
    assert.equal(describeActivity(act('Grep', 'describeActivity'), 'past'), 'Searched for describeActivity');
    assert.equal(describeActivity(act('Grep', 'x'.repeat(31))), 'Searching', 'too long');
    assert.equal(describeActivity(act('Grep', '/Users/ben/Development/Lee')), 'Searching', 'a path is not a pattern');
    assert.equal(describeActivity(act('Glob', '')), 'Searching');
    assert.equal(describeActivity(act('Glob', ''), 'past'), 'Searched');
  });

  test('describeActivity: Bash as tests, builds, git, else its first word', () => {
    const now = (cmd) => describeActivity(act('Bash', cmd));
    const past = (cmd) => describeActivity(act('Bash', cmd), 'past');
    for (const cmd of ['npm test', 'pytest tests/copilot -q', 'npx jest', 'npx vitest run', 'node scripts/cockpit-renderer-smoke.mjs', 'PYTHONPATH=. python -m pytest']) {
      assert.equal(now(cmd), 'Running tests', cmd);
      assert.equal(past(cmd), 'Ran tests', cmd);
    }
    for (const cmd of ['npm run build', 'npm run build:main', 'npm run dist', 'npx tsc --noEmit', 'idf.py flash']) {
      assert.equal(now(cmd), 'Building', cmd);
      assert.equal(past(cmd), 'Built', cmd);
    }
    assert.equal(now('git status --short'), 'Using git');
    assert.equal(now('git commit -m "fix the test"'), 'Using git', 'git by its first word, whatever the message says');
    assert.equal(past('git push'), 'Used git');
    assert.equal(now('ls -la'), 'Running ls');
    assert.equal(now('/usr/bin/python3 x.py'), 'Running python3');
    assert.equal(past('curl -s localhost:9000/health'), 'Ran curl');
    assert.equal(now(''), 'Running a command');
  });

  test('describeActivity: web, subagents, questions, anything else', () => {
    assert.equal(describeActivity(act('WebFetch', 'https://example.com')), 'Reading the web');
    assert.equal(describeActivity(act('WebSearch', 'newsreader font')), 'Reading the web');
    assert.equal(describeActivity(act('WebFetch'), 'past'), 'Read the web');
    assert.equal(describeActivity(act('Task', 'explore the repo')), 'Working with a subagent');
    assert.equal(describeActivity(act('Agent')), 'Working with a subagent');
    assert.equal(describeActivity(act('Agent'), 'past'), 'Worked with a subagent');
    assert.equal(describeActivity(act('AskUserQuestion')), 'Asking you a question');
    assert.equal(describeActivity(act('AskUserQuestion'), 'past'), 'Asked you a question');
    assert.equal(describeActivity(act('mcp__linear__create_issue', '{"title":"x"}')), 'mcp__linear__create_issue');
    assert.equal(describeActivity(act('TodoWrite'), 'past'), 'TodoWrite');
  });

  test('describeActivity: a failed entry says so, in either tense', () => {
    assert.equal(describeActivity(act('Bash', 'npm test', [], { failed: true })), 'Running tests (failed)');
    assert.equal(describeActivity(act('Bash', 'npm test', [], { failed: true }), 'past'), 'Ran tests (failed)');
    assert.equal(describeActivity(act('Edit', '', ['/a', '/b'], { failed: true }), 'past'), 'Edited 2 files (failed)');
    assert.equal(describeActivity(act('Weird', '', [], { failed: true })), 'Weird (failed)');
    assert.equal(describeActivity(act('Read', '/x', ['/x'], { failed: false })), 'Reading x');
  });

  test('LEGACY_SECTION: every old id to its new section; new ids to themselves', () => {
    const expected = {
      copilot: 'home', tabs: 'home', feed: 'work', tasks: 'work', explore: 'library', someday: 'library', files: 'library',
      home: 'home', work: 'work', goals: 'goals', library: 'library', ops: 'ops', history: 'history',
    };
    assert.deepEqual({ ...LEGACY_SECTION }, expected);
    for (const id of SECTIONS) assert.equal(LEGACY_SECTION[id], id, id);
    for (const target of Object.values(LEGACY_SECTION)) assert.ok(SECTIONS.includes(target), target);
  });

  test('readSection: maps through LEGACY_SECTION; unknown, empty and prototype keys land on Home', () => {
    for (const [from, to] of Object.entries(LEGACY_SECTION)) assert.equal(readSection(from), to, from);
    assert.equal(readSection('nope'), 'home');
    assert.equal(readSection(''), 'home');
    assert.equal(readSection(null), 'home');
    assert.equal(readSection(undefined), 'home');
    assert.equal(readSection('toString'), 'home');
    assert.equal(readSection('__proto__'), 'home');
  });

  const guardBuilt = await esbuild.build({ entryPoints: [join(__dirname, '../src/renderer/components/cockpit/ui/nextGuard.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
  const g = await import(`data:text/javascript;base64,${Buffer.from(guardBuilt.outputFiles[0].text).toString('base64')}`);
  test('nextGuard: a second next button in one view root warns; other roots and unmounts do not', () => {
    assert.equal(g.nextGuard.enabled, false, 'off outside Vite development');
    const warnings = [];
    const guard = g.createNextGuard({ warn: (m) => warnings.push(m) });
    const home = {};
    const work = {};
    const offA = guard.register(home, 'Continue');
    guard.register(work, 'Allow');
    assert.equal(warnings.length, 0);
    const offB = guard.register(home, 'Send');
    assert.equal(guard.count(home), 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 next buttons.*"Continue", "Send"/);
    offB();
    offA();
    assert.equal(guard.count(home), 0);
    guard.register(home, 'Continue');
    assert.equal(warnings.length, 1, 'one again after the others unmounted');
  });

  test('QUICK_REPLIES: the four, in order (same list as Aeronaut quickReplyChips)', () => {
    assert.deepEqual([...QUICK_REPLIES], ['Yes, go ahead', 'Stop and wait for me', 'Explain first', 'Show me the diff']);
  });
}

// Lee Feed entries (§4.1): check-in and escalate proposals live in Home's
// Meanwhile; lint, operation failures and run proposals are Ops'.
const leeRow = (id, over = {}) => {
  const entry = {
    id,
    version: 1,
    workspace: WS,
    kind: 'proposal',
    severity: 'needs-you',
    producer: 'checkin',
    title: `Check in on ${id}?`,
    text: 'Busy for a while with no report.',
    text_is_agent: false,
    created_at: ago(5),
    updated_at: ago(5),
    state: 'open',
    item_ref: null,
    ref: { pty_id: 7 },
    actions: [{ id: 'checkin', label: 'Check in', style: 'primary', confirm_text: 'How is it going?' }],
    pinned: false,
    expires_at: null,
    ...over,
  };
  return { source: 'lee', id: `lee:${id}`, kind: entry.kind, severity: entry.severity, at: entry.updated_at, title: entry.title, entry };
};
const leeRows = [
  leeRow('ck'),
  leeRow('esc', { producer: 'ops', title: 'Escalate test to a task?', ref: { proposal_id: 'opesc_1', op: 'test' } }),
  leeRow('run', { producer: 'ops', ref: { proposal_id: 'p1', op: 'test' } }),
  leeRow('fail', { producer: 'ops', kind: 'failure', ref: { op: 'test', run_id: 'r1' } }),
  leeRow('lint', { producer: 'lint', kind: 'lint', ref: { diag_id: 'd1' } }),
  leeRow('save', { producer: 'ops', severity: 'ambient', ref: { proposal_id: 'opsave_1', op: 'x' } }),
];

// ---------------------------------------------------------------------------
// Cockpit design R1 (cockpit-design §2, §3, §6.3, §10 R1): greeting(),
// meanwhileSentence(), Home's needs rows and sentences, the Launcher's three
// choices, the rail's dots, the status-bar counts, section migration from
// every legacy id, and one next button at most per Cockpit view (sections
// rendered from fixtures with react-dom/server, counted through nextGuard).
// ---------------------------------------------------------------------------

{
  const {
    greeting,
    homeQuestion,
    meanwhileSentence,
    homeNeeds,
    homeFeedNeeds,
    workNeedsCount,
    q2Sentence,
    startSentence,
    arrivedLine,
    numberWord,
    LAUNCHER_CHOICES,
    evaluationDue,
    EVALUATION_DUE_DAYS,
    railDots,
    cockpitStatusCounts,
    cockpitStatusParts,
    COCKPIT_KEYS,
  } = mod;

  test('greeting: weekday and part of day at every boundary (local time)', () => {
    const at = (d, h, m) => greeting(new Date(2026, 8, d, h, m));
    // 2026-09-27 is a Sunday.
    assert.equal(at(27, 4, 59), 'Sunday night');
    assert.equal(at(27, 5, 0), 'Sunday morning');
    assert.equal(at(27, 11, 59), 'Sunday morning');
    assert.equal(at(27, 12, 0), 'Sunday afternoon');
    assert.equal(at(27, 16, 59), 'Sunday afternoon');
    assert.equal(at(27, 17, 0), 'Sunday evening');
    assert.equal(at(27, 21, 59), 'Sunday evening');
    assert.equal(at(27, 22, 0), 'Sunday night');
    assert.equal(at(28, 0, 30), 'Monday night', 'past midnight is the new day, still night');
    assert.equal(at(26, 9, 0), 'Saturday morning');
  });

  test('homeQuestion: with a name, and without one', () => {
    assert.equal(homeQuestion('Ben'), "What's on your mind, Ben?");
    assert.equal(homeQuestion('  Ben '), "What's on your mind, Ben?");
    assert.equal(homeQuestion(null), "What's on your mind?");
    assert.equal(homeQuestion(''), "What's on your mind?");
  });

  test('meanwhileSentence: nothing, only wins, waiting only, both', () => {
    const d = (wins, sessions) => ({ wins: Array.from({ length: wins }, (_, i) => ({ title: `w${i}` })), agent_claims: sessions.map((s) => ({ session_id: s })) });
    assert.equal(meanwhileSentence(null, { waiting: 0 }), 'Quiet while you were away. Nothing needs you.');
    assert.equal(meanwhileSentence(d(0, []), { waiting: 0 }), 'Quiet while you were away. Nothing needs you.');
    assert.equal(meanwhileSentence(d(3, []), { waiting: 0 }), 'Three things shipped while you were away. Nothing needs you.');
    assert.equal(meanwhileSentence(d(1, []), { waiting: 0 }), 'One thing shipped while you were away. Nothing needs you.');
    assert.equal(meanwhileSentence(d(0, []), { waiting: 1 }), 'One thing is waiting on you.');
    assert.equal(meanwhileSentence(null, { waiting: 2 }), 'Two things are waiting on you.');
    assert.equal(meanwhileSentence(d(2, []), { waiting: 1 }), 'Two things shipped while you were away. One thing is waiting on you.');
    // The contract's example: finished turns count once per agent session.
    assert.equal(meanwhileSentence(d(0, ['a', 'b', 'a']), { waiting: 1 }), 'Two agents finished while you were away. One is waiting on you.');
    assert.equal(meanwhileSentence(d(0, ['a']), { waiting: 0 }), 'One agent finished while you were away. Nothing needs you.');
    assert.equal(
      meanwhileSentence(d(4, ['a', 'b']), { waiting: 3 }),
      'Two agents finished while you were away, and four things shipped. Three are waiting on you.',
    );
    assert.ok(!/claim/i.test(meanwhileSentence(d(1, ['a']), { waiting: 1 })), 'no "claims"');
    assert.equal(numberWord(13), '13');
  });

  test('homeNeeds: attention rows that need you, blocking first then oldest, at most three', () => {
    const row = (id, severity, created, kind = 'waiting', source = 'attention') =>
      source === 'attention'
        ? { source, id: `att:${id}`, kind: 'decision', severity, at: created, title: id, item: item({ id, severity, kind, created_at: created, updated_at: created }) }
        : { source, id: `lee:${id}`, kind: 'failure', severity, at: created, title: id, entry: {} };
    const rows = [
      row('new', 'needs-you', ago(1)),
      row('amb', 'ambient', ago(50), 'review'),
      row('sum', 'needs-you', ago(60), 'summary'),
      row('old', 'needs-you', ago(30)),
      row('blk', 'blocking', ago(2), 'approval'),
      row('fail', 'needs-you', ago(90), 'waiting', 'lee'),
      row('mid', 'needs-you', ago(10)),
    ];
    assert.deepEqual(homeNeeds(rows).map((r) => r.item.id), ['blk', 'old', 'mid']);
    assert.deepEqual(homeNeeds(rows, 5).map((r) => r.item.id), ['blk', 'old', 'mid', 'new']);
    assert.deepEqual(homeNeeds([]), []);
  });

  test('homeFeedNeeds: Lee entries that need you and live nowhere else (not lint, op failures, Ops run proposals)', () => {
    assert.deepEqual(homeFeedNeeds(leeRows, ['p1']).map((r) => r.entry.id), ['ck', 'esc']);
    assert.deepEqual(homeFeedNeeds(leeRows).map((r) => r.entry.id), ['ck', 'esc', 'run'], 'a proposal Ops no longer holds comes here');
    assert.deepEqual(homeFeedNeeds([]), []);
  });

  test('workNeedsCount: only what Work shows (attention that needs you, no summaries, no Lee entries)', () => {
    const att = (id, severity, kind = 'waiting') => ({ source: 'attention', id: `att:${id}`, kind: 'decision', severity, at: ago(1), title: id, item: item({ id, severity, kind }) });
    assert.equal(workNeedsCount([att('a', 'needs-you'), att('b', 'blocking', 'approval'), att('c', 'ambient', 'review'), att('s', 'needs-you', 'summary'), ...leeRows]), 2);
    assert.equal(workNeedsCount(leeRows), 0, 'a check-in proposal alone lights no Work dot');
  });

  test('Or start from: sentences, not labels (phone vs devices, singulars, empties)', () => {
    assert.equal(startSentence({ kind: 'blank' }), 'A blank page');
    assert.equal(startSentence({ kind: 'open_questions', count: 2, items: [{}, {}] }), '2 open questions');
    assert.equal(startSentence({ kind: 'open_questions', count: 1, items: [{}] }), '1 open question');
    assert.equal(startSentence({ kind: 'captured_away', count: 3, items: [{ surface: 'aeronaut' }, { surface: 'aeronaut' }, { surface: 'aeronaut' }] }), '3 thoughts from your phone');
    assert.equal(startSentence({ kind: 'captured_away', count: 2, items: [{ surface: 'aeronaut' }, { surface: 'dirigible' }] }), '2 thoughts from your devices');
    assert.equal(startSentence({ kind: 'reading_list', count: 4, items: [{}] }), '4 things to read');
    assert.equal(startSentence({ kind: 'quiet', items: [{}, {}] }), '2 quiet explorations');
    assert.equal(startSentence({ kind: 'reading_list', count: 0, items: [] }), null);
    assert.equal(startSentence({ kind: 'q2', items: [{}] }), null, 'Q2 is written per item');
    assert.equal(q2Sentence({ kind: 'goal-unserved', goal_id: 'G1', title: 'Ship v6', detail: 'Nothing open serves G1.' }), 'G1 has nothing open serving it');
    assert.equal(q2Sentence({ kind: 'evaluation-due', goal_id: 'G2', title: 'Deep', detail: 'Never evaluated.' }), 'G2 has never been evaluated');
    assert.equal(q2Sentence({ kind: 'evaluation-due', goal_id: 'G2', title: 'Deep', detail: 'Last evaluated 20 days ago.' }), 'G2 was last evaluated 20 days ago');
    assert.equal(q2Sentence({ kind: 'exploration-quiet', goal_id: null, title: 'Vector clocks', detail: 'Untouched for 9 days.' }), 'Vector clocks: untouched for 9 days');
    assert.equal(arrivedLine({ answers: 2, open_questions: 1 }), '2 answers came back · 1 open question');
    assert.equal(arrivedLine({ answers: 1, open_questions: 0 }), '1 answer came back');
    assert.equal(arrivedLine({ answers: 0, open_questions: 0 }), '');
  });

  test('Launcher: New ⌘N offers Task, Explore and Run… at the top (Task first; Run keeps ⌘{)', () => {
    assert.deepEqual(
      LAUNCHER_CHOICES.map((c) => c.id),
      ['task', 'explore', 'run'],
    );
    assert.deepEqual(
      LAUNCHER_CHOICES.map((c) => c.label),
      ['Task', 'Explore', 'Run…'],
    );
    assert.equal(LAUNCHER_CHOICES.find((c) => c.id === 'run').kbd, '⌘{');
    assert.equal(LAUNCHER_CHOICES.find((c) => c.id === 'task').kbd, '⏎', 'Enter still launches a task');
    assert.ok(COCKPIT_KEYS.some(([k, v]) => k === '⌘N' && /task.*exploration.*run/i.test(v)));
    assert.ok(COCKPIT_KEYS.some(([k, v]) => k === '⌘T' && /Manual/.test(v)), '⌘T goes to Manual');
    assert.ok(!COCKPIT_KEYS.some(([k]) => k === '← / →'), 'no tile keys: the dock is gone');
  });

  test('rail: one ember dot per section that needs you, never a count', () => {
    const now = NOW;
    const fresh = new Date(now - 86400000).toISOString();
    const stale = new Date(now - (EVALUATION_DUE_DAYS + 1) * 86400000).toISOString();
    assert.equal(evaluationDue(null, now), true);
    assert.equal(evaluationDue(fresh, now), false);
    assert.equal(evaluationDue(stale, now), true);
    const quiet = railDots({ work: 0, goals: [{ flagged: false, last_evaluated_at: fresh }], opsFailing: 0, opsProposals: 0, now });
    assert.deepEqual(quiet, { home: false, work: false, goals: false, library: false, ops: false, history: false });
    const busy = railDots({ work: 2, goals: [{ flagged: false, last_evaluated_at: stale }], opsFailing: 0, opsProposals: 1, now });
    assert.deepEqual(busy, { home: false, work: true, goals: true, library: false, ops: true, history: false });
    assert.equal(railDots({ work: 0, goals: [{ flagged: true, last_evaluated_at: fresh }], opsFailing: 1, opsProposals: 0, now }).goals, true);
    const homeOnly = railDots({ home: 1, work: 0, goals: [], opsFailing: 0, opsProposals: 0, now });
    assert.deepEqual(homeOnly, { home: true, work: false, goals: false, library: false, ops: false, history: false }, 'Lee entries light Home, not Work');
    for (const v of Object.values(busy)) assert.equal(typeof v, 'boolean');
  });

  test('status bar in the Cockpit: agents working · waiting, for this workspace', () => {
    const agents = [
      { state: 'busy', workspace: WS },
      { state: 'busy', workspace: WS },
      { state: 'idle', workspace: WS },
      { state: 'busy', workspace: '/other' },
    ];
    const items = [
      item({ id: 'a', severity: 'needs-you' }),
      item({ id: 'b', severity: 'ambient', kind: 'review' }),
      item({ id: 'c', severity: 'blocking', kind: 'approval', source: { ...item({}).source, workspace: '/other' } }),
      item({ id: 'd', severity: 'needs-you', state: 'resolved' }),
    ];
    const c = cockpitStatusCounts({ workspace: WS, agents, items });
    assert.deepEqual(c, { working: 2, waiting: 1 });
    assert.deepEqual(cockpitStatusParts(c), { working: '2 agents working', waiting: '1 waiting' });
    assert.deepEqual(cockpitStatusParts({ working: 1, waiting: 0 }), { working: '1 agent working', waiting: null });
    assert.deepEqual(cockpitStatusParts({ working: 0, waiting: 0 }), { working: null, waiting: null });
  });

  test('sections: every legacy id migrates (localStorage and setSection callers)', () => {
    const legacy = { copilot: 'home', tabs: 'home', feed: 'work', tasks: 'work', explore: 'library', someday: 'library', files: 'library' };
    for (const [from, to] of Object.entries(legacy)) assert.equal(readSection(from), to, from);
    for (const id of SECTIONS) assert.equal(readSection(id), id, id);
    assert.deepEqual([...SECTIONS], ['home', 'work', 'goals', 'library', 'ops', 'history']);
    assert.equal(DEFAULT_SECTION, 'home');
  });
}

{
  // Render each R1 view with fixture data (react-dom/server) and count its
  // next buttons through nextGuard: at most one per view root (§0 rule 1).
  const entry = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { HomeSection } from './sections/HomeSection';
    import { GoalsSection } from './sections/GoalsSection';
    import { OperationsSection } from './sections/OperationsSection';
    import { HistorySection } from './sections/HistorySection';
    import { Launcher } from './Launcher';
    import { CockpitNav } from './CockpitNav';
    export { createNextGuard } from './ui/nextGuard';
    export const render = (el) => renderToStaticMarkup(el);
    export { React, HomeSection, GoalsSection, OperationsSection, HistorySection, Launcher, CockpitNav };
  `;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: join(__dirname, '../src/renderer/components/cockpit'), loader: 'tsx' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.woff2': 'empty', '.svg': 'text' },
    logLevel: 'silent',
  });
  const dir = mkdtempSync(join(__dirname, '.cockpit-views-smoke-'));
  const file = join(dir, 'views.mjs');
  writeFileSync(file, built.outputFiles[0].text);
  let v;
  try {
    v = await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const h = v.React.createElement;

  const noop = () => {};
  const due = new Date(NOW - 30 * 86400000).toISOString();
  const fresh = new Date(NOW - 86400000).toISOString();
  const attRow = (id, kind, severity) => ({
    source: 'attention',
    id: `att:${id}`,
    kind: 'decision',
    severity,
    at: ago(5),
    title: id,
    item: item({ id, kind, severity, tool: kind === 'approval' ? { name: 'Bash', preview: 'npm test', signature: 's' } : null, source: { ...item({}).source, tab_label: `Agent ${id}` } }),
  });
  const ctx = {
    workspace: WS,
    api: null,
    copilotApi: null,
    snapshot: { items: [], agents: [] },
    runtime: [],
    ops: {
      workspace: WS,
      operations: [
        { def: { name: 'test', command: 'npm test', kind: 'oneshot' }, status: 'failed', source: 'config', running: null, last_run: { run_id: 'r1', status: 'failed', exit_code: 1, started_at: ago(3), ended_at: ago(2), duration_ms: 60000, readings: [] }, linked_pty_id: null },
        { def: { name: 'dev', command: 'npm run dev', kind: 'long-running' }, status: 'running', source: 'config', running: { run_id: 'r2', status: 'running', started_at: ago(10), pty_id: null }, last_run: null, linked_pty_id: null },
      ],
      suggestions: [{ def: { name: 'lint', command: 'npm run lint', kind: 'oneshot' }, detected_from: 'package.json' }],
      proposals: [{ id: 'p1', by: 'hester', op: 'test', command: 'npm test', cwd: null, reason: 'Tests failed', created_at: ago(1) }],
    },
    hester: { snapshot: null, refresh: noop },
    tiles: [],
    feedRows: [attRow('a1', 'approval', 'blocking'), attRow('w1', 'waiting', 'needs-you'), attRow('q1', 'question', 'needs-you'), attRow('d1', 'decision', 'needs-you')],
    tabs: [],
    mode: { selected: null },
    isAgentTab: () => false,
    now: NOW,
    goInto: noop,
    openOwnTab: noop,
    openFile: noop,
    openExploration: async () => {},
    openLibrary: noop,
    openWorkstream: noop,
    focusPty: noop,
    notify: noop,
    openLauncher: noop,
    openReply: noop,
    openCheckin: noop,
    openRename: noop,
    closeAgent: noop,
    registerRows: noop,
    selectRow: noop,
    setSection: noop,
    goals: {
      data: {
        generated_at: ago(0),
        days: 7,
        goals: [
          { id: 'G0', title: 'Deep time', priority: 0, prose: '', metrics: [], serving: { tasks: [], workstreams: [], explorations: [] }, flagged: false, last_evaluated_at: fresh, focus_ms_7d: 0 },
          { id: 'G1', title: 'Less toil', priority: 1, prose: '', metrics: [{ name: 'toil_load', value: 3, ok: false, trend: 'up', source: 'op' }], serving: { tasks: [], workstreams: [], explorations: [] }, flagged: true, last_evaluated_at: due, focus_ms_7d: 0 },
          { id: 'G2', title: 'Faster answers', priority: 2, prose: '', metrics: [], serving: { tasks: [], workstreams: [], explorations: [] }, flagged: false, last_evaluated_at: null, focus_ms_7d: 0 },
        ],
        constraints: [{ id: 'C1', title: 'No runtime network for fonts', violations: 1 }],
        tensions: [{ a: 'G0', b: 'G1', label: 'time', default: 'G0 wins', arbiter: 'you' }],
        human_balance: { share: 0.5, ms: { Q1: 1, Q2: 1, Q3: 0, Q4: 0, play: 0, unclassified: 0 }, by_goal: {}, line: 'Half important.' },
      },
      error: null,
      loading: false,
      refresh: noop,
    },
    requestSteward: noop,
    pendingSteward: null,
  };
  const opener = {
    generated_at: ago(0),
    workspace: WS,
    pick_up: { exploration: { id: 'e1', title: 'Vector clocks', last_touched_at: ago(90) }, stopped_at: 'whether the merge needs a tiebreak', arrived: { answers: 2, open_questions: 1 } },
    surfaces: [
      { kind: 'blank' },
      { kind: 'open_questions', count: 1, items: [{ exploration_id: 'e1', exploration_title: 'Vector clocks', question_id: 'q', text: 'Is it causal?' }] },
      { kind: 'captured_away', count: 1, items: [{ someday_id: 's', text: 'Try CRDTs', surface: 'aeronaut', created_at: ago(20) }] },
      { kind: 'q2', items: [{ kind: 'goal-unserved', goal_id: 'G1', ref: 'G1', title: 'Less toil', detail: 'Nothing open serves G1.' }] },
    ],
  };
  const digest = { wins: [{ kind: 'commit', title: 'Fix merge', at: ago(30), verified: true, related: true }], agent_claims: [{ session_id: 's1', summary: 'done', at: ago(20) }], changed: { agent_files: ['a.ts'], commits: 1 }, waiting: [], someday: { open: 0, untriaged_over_7d: 0 }, retro: { due: true, week: '2026-W39' }, q2_candidates: [] };

  const nextCount = (html) => (html.match(/class="ui-btn is-next/g) ?? []).length;
  const warnings = [];
  const guard = v.createNextGuard({ warn: (m) => warnings.push(m) });
  const views = {
    home: h(v.HomeSection, { ctx, returnNonce: 0, seed: { opener, digest, name: 'Ben' } }),
    'home (Lee entries)': h(v.HomeSection, { ctx: { ...ctx, feedRows: [...ctx.feedRows, ...leeRows] }, returnNonce: 0, seed: { opener, digest, name: 'Ben' } }),
    'home (nothing to pick up)': h(v.HomeSection, { ctx: { ...ctx, feedRows: [] }, returnNonce: 0, seed: { opener: { ...opener, pick_up: null }, digest, name: null } }),
    goals: h(v.GoalsSection, { ctx }),
    ops: h(v.OperationsSection, { ctx }),
    history: h(v.HistorySection, { ctx }),
    launcher: h(v.Launcher, { ctx, onClose: noop, onExplore: noop, onRun: noop }),
  };
  const html = {};
  for (const [name, el] of Object.entries(views)) {
    html[name] = v.render(el);
    const root = {};
    for (let i = 0; i < nextCount(html[name]); i++) guard.register(root, name);
  }

  test('views: no Cockpit view mounts more than one next button (nextGuard)', () => {
    assert.deepEqual(warnings, []);
    assert.equal(nextCount(html.home), 1, 'Home: Continue');
    assert.match(html.home, /ui-btn is-next[^>]*>Continue<span class="ui-kbd">⇧⌘0</);
    assert.equal(nextCount(html['home (nothing to pick up)']), 0);
    assert.equal(nextCount(html['home (Lee entries)']), 1, 'Lee entries add no next step');
    assert.equal(nextCount(html.goals), 1, 'Goals: Evaluate on the first goal due');
    assert.equal(nextCount(html.ops), 0, 'Ops: none');
    assert.equal(nextCount(html.history), 0);
    assert.equal(nextCount(html.launcher), 1, 'Launcher: Launch');
  });

  test('Home: the desk from fixtures (greeting, Newsreader question, Pick up, sentences, Meanwhile)', () => {
    const s = html.home;
    assert.match(s, /class="home-greeting">[A-Z][a-z]+day (morning|afternoon|evening|night)</);
    assert.match(s, /class="home-question"[^>]*>What&#x27;s on your mind, Ben\?</);
    assert.match(s, /placeholder="Start writing\. Enter opens a Page\."/);
    assert.match(s, /Pick up where you left off/);
    assert.match(s, /“whether the merge needs a tiebreak”/);
    assert.match(s, /2 answers came back · 1 open question/);
    for (const t of ['A blank page', '1 open question', '1 thought from your phone', 'G1 has nothing open serving it']) assert.ok(s.includes(t), t);
    assert.ok(s.includes('One agent finished while you were away, and one thing shipped. Four are waiting on you.'), 'one sentence');
    assert.equal((s.match(/class="home-need[ "]/g) ?? []).length, 3, 'up to three needs-you rows');
    assert.ok(s.includes('1 more in Work'));
    assert.match(s, /ui-btn is-plain[^>]*>Allow</, 'Allow is plain on Home, not the phosphor step');
    for (const t of ['See what shipped', 'Ask Hester what to do next', 'This week&#x27;s retro']) assert.ok(s.includes(t), t);
    assert.ok(!/Ask Hester<\/div>|about:|Copilot mode/.test(s), 'the Ask card, about chips and the Copilot mode placeholder are gone');
    assert.ok(!/cockpit-badge/.test(s), 'no count badges');
    assert.match(html['home (nothing to pick up)'], />What&#x27;s on your mind\?</);
  });

  test('Home: Lee entries with no other place show in Meanwhile (first action plain, Dismiss quiet)', () => {
    const s = html['home (Lee entries)'];
    assert.ok(s.includes('Check in on ck?'), 'the check-in proposal');
    assert.ok(s.includes('Escalate test to a task?'), 'the escalate proposal');
    assert.ok(!s.includes('Check in on fail?') && !s.includes('Check in on lint?') && !s.includes('Check in on run?'), 'Ops keeps failures, lint and run proposals');
    assert.ok(!s.includes('Check in on save?'), 'ambient entries are not needs-you rows');
    assert.match(s, /ui-btn is-plain[^>]*>Check in</);
    assert.match(s, /ui-btn is-quiet[^>]*>Dismiss</);
    assert.match(s, /title="How is it going\?"[^>]*>Check in</, 'the text it types is on the button');
    assert.ok(!s.includes('home-need-confirm-text'), 'and shown verbatim after the first click, before it is sent (C3)');
    assert.ok(s.includes('Six are waiting on you.'), 'the sentence counts them');
  });

  test('rail: icons with labels and tooltips; the only badge is a dot', () => {
    const dots = { home: false, work: true, goals: false, library: false, ops: true, history: false };
    const s = v.render(h(v.CockpitNav, { section: 'home', dots, onSelect: noop }));
    assert.equal((s.match(/class="cockpit-rail-item/g) ?? []).length, 6);
    assert.equal((s.match(/class="cockpit-rail-dot"/g) ?? []).length, 2);
    assert.match(s, /aria-label="Work, needs you"/);
    assert.match(s, /data-tip="Library"/);
    assert.match(s, /class="cockpit-rail-item is-active"[^>]*aria-label="Home"/);
    assert.ok(!/\d<\/span>/.test(s.replace(/<svg[\s\S]*?<\/svg>/g, '')), 'no counts');
  });

  test('Goals, Ops: ember only as the needs-you Dot', () => {
    assert.equal((html.goals.match(/ui-dot is-needs/g) ?? []).length, 3, 'G1 flagged, G2 never evaluated, C1 violated');
    assert.ok(!/cockpit-tag is-ember|cockpit-badge/.test(html.goals));
    assert.match(html.ops, /ui-eyebrow is-needs/, 'the proposal is Waiting on you');
    assert.ok((html.ops.match(/ui-dot is-needs/g) ?? []).length >= 2, 'the failed op and the proposal');
    assert.match(html.ops, /Work lint/);
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
