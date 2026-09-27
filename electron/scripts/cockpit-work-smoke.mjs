#!/usr/bin/env node
/**
 * Smoke test for Work and Library's pure model (cockpit-design §4, §5, §10 R2):
 * src/renderer/lib/workModel.ts. The waiting order, In flight's order and the
 * "earlier" fold at 2h, the swipe accumulator (threshold, direction, snap
 * back, ignoring vertical), the quick replies shown (3 in the list, 4 in the
 * detail), stepping to the next and previous item in the detail view, and
 * Library's word estimate and "quiet". Compiles the real source with
 * esbuild, no React, no DOM. Then renders WorkSection, WorkDetail and
 * LibrarySection to static HTML with fixture data (react-dom/server) and
 * checks the one-next-step rule and the chips each place shows.
 *
 * Run: node scripts/cockpit-work-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/renderer/lib/workModel.ts');

const result = await esbuild.build({ entryPoints: [srcPath], bundle: true, format: 'esm', platform: 'node', write: false });
const code = result.outputFiles[0].text;
assert.ok(!/^\s*import\s/m.test(code), 'workModel.ts must have type-only imports apart from pure modules (pure)');

const tmpDir = mkdtempSync(join(tmpdir(), 'lee-work-smoke-'));
const tmpFile = join(tmpDir, 'workModel.mjs');
writeFileSync(tmpFile, code);
let m;
try {
  m = await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
};

const WS = '/work/lee';
const NOW = Date.parse('2026-09-27T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

function item(id, over = {}) {
  return {
    id,
    version: 1,
    kind: 'waiting',
    severity: 'needs-you',
    state: 'open',
    parked: false,
    wake: false,
    notify: false,
    related_to_focus: false,
    created_at: ago(10),
    updated_at: ago(10),
    active_wait_ms: 0,
    title: `item ${id}`,
    text: 'words',
    source: { kind: 'agent', provider: 'claude', session_id: null, pty_id: null, window_id: 1, tab_id: null, tab_label: `Tab ${id}`, workspace: WS, cwd: WS },
    actions: ['reply', 'snooze', 'dismiss'],
    ...over,
  };
}

function tile(ptyId, over = {}) {
  return {
    ptyId,
    nameSource: null,
    tabId: ptyId,
    windowId: 1,
    provider: 'claude',
    title: `Agent ${ptyId}`,
    chip: { label: 'idle', tone: 'idle' },
    agentState: 'idle',
    summary: null,
    tail: null,
    meta: [],
    fidelity: 'structured',
    approval: null,
    replyItem: null,
    notice: null,
    working: false,
    task: null,
    canCheckin: true,
    checkin: null,
    needsYou: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Waiting order
// ---------------------------------------------------------------------------

test('waiting: blocking, then needs-you, oldest first; ambient, closed and other workspaces out', () => {
  const items = [
    item('new-needs', { created_at: ago(2) }),
    item('old-needs', { created_at: ago(30) }),
    item('blocking', { severity: 'blocking', kind: 'blocker', created_at: ago(1) }),
    item('ambient', { severity: 'ambient', kind: 'review' }),
    item('resolved', { state: 'resolved' }),
    item('elsewhere', { source: { ...item('x').source, workspace: '/other' } }),
    item('approval', { kind: 'approval', created_at: ago(5), actions: ['approve', 'deny'], source: { ...item('x').source, pty_id: 7, tab_label: 'old label' } }),
  ];
  const w = m.waitingItems({ items, workspace: WS, tiles: [tile(7, { title: 'Renamed agent' })] });
  assert.deepEqual(w.map((x) => x.item.id), ['blocking', 'old-needs', 'approval', 'new-needs']);
  assert.equal(w[0].id, 'work:item:blocking');
  assert.equal(w[2].kind, 'approval');
  assert.equal(w[2].name, 'Renamed agent', 'the agent’s current name wins over the tab label');
  assert.equal(w[1].kind, 'text');
});

test('waiting: hidden items (a swipe in its Undo window) drop out', () => {
  const w = m.waitingItems({ items: [item('a'), item('b')], workspace: WS, hidden: new Set(['a']) });
  assert.deepEqual(w.map((x) => x.item.id), ['b']);
});

test('waiting: question kind, text reply and the approval line', () => {
  assert.equal(m.waitingKind({ kind: 'question' }), 'question');
  assert.equal(m.canTextReply({ kind: 'waiting', actions: ['reply'] }), true);
  assert.equal(m.canTextReply({ kind: 'approval', actions: ['reply', 'approve'] }), false);
  assert.equal(m.canTextReply({ kind: 'failure', actions: ['dismiss'] }), false);
  assert.equal(m.approvalLine({ tool: { name: 'Bash', preview: 'ls', signature: '' } }), 'Wants to run a command');
  assert.equal(m.approvalLine({ tool: null }), 'Wants to run a command');
  assert.equal(m.approvalLine({ tool: { name: 'Edit', preview: 'a.ts', signature: '' } }), 'Wants to change a file');
});

// ---------------------------------------------------------------------------
// Quick replies
// ---------------------------------------------------------------------------

test('quick replies: 3 on the list card, all 4 in the detail', () => {
  assert.deepEqual(m.quickReplies('list'), ['Yes, go ahead', 'Stop and wait for me', 'Explain first']);
  assert.deepEqual(m.quickReplies('detail'), ['Yes, go ahead', 'Stop and wait for me', 'Explain first', 'Show me the diff']);
});

// ---------------------------------------------------------------------------
// In flight
// ---------------------------------------------------------------------------

test('in flight: busy longest first, then waiting, review, idle newest first; >2h idle folds into earlier', () => {
  const tiles = [
    tile(1, { working: true, title: 'short busy' }),
    tile(2, { working: true, title: 'long busy', summary: { text: 'Refactoring the parser', preview: 'Refactoring the parser', label: 'Claude says' } }),
    tile(3, { title: 'review', task: { id: 't3', status: 'review' } }),
    tile(4, { title: 'idle recent', chip: { label: 'finished 5m ago', tone: 'idle' } }),
    tile(5, { title: 'idle old' }),
    tile(6, { title: 'idle older' }),
    tile(8, { title: 'in waiting' }),
    tile(9, { title: 'needs, no item', needsYou: true }),
    tile(10, { title: 'review item' }),
    tile(11, { title: 'idle less recent', chip: { label: 'finished 40m ago', tone: 'idle' } }),
  ];
  const times = new Map([
    [1, { busySince: ago(3), idleSince: null }],
    [2, { busySince: ago(25), idleSince: null }],
    [3, { busySince: null, idleSince: ago(10) }],
    [4, { busySince: null, idleSince: ago(5) }],
    [5, { busySince: null, idleSince: ago(121) }],
    [6, { busySince: null, idleSince: ago(300) }],
    [10, { busySince: null, idleSince: ago(2) }],
    [11, { busySince: null, idleSince: ago(40) }],
  ]);
  const agents = [{ pty_id: 1, now: { tool: 'Edit', preview: 'src/main.ts', files: ['src/main.ts'], since: ago(0) } }];
  const g = m.inFlight({ tiles, agents, times, now: NOW, waitingPtys: new Set([8]), reviewPtys: new Set([10]) });
  assert.deepEqual(
    g.rows.map((r) => r.title),
    ['long busy', 'short busy', 'needs, no item', 'review item', 'review', 'idle recent', 'idle less recent'],
  );
  assert.deepEqual(g.earlier.map((r) => r.title), ['idle old', 'idle older']);
  const [longBusy, shortBusy] = g.rows;
  assert.equal(shortBusy.sub, 'Editing main.ts', 'the sub-line is what it is doing now (§7.1)');
  assert.equal(longBusy.sub, 'Refactoring the parser', 'without now, the tile summary');
  assert.equal(longBusy.dot, 'working');
  assert.equal(longBusy.meta, '25m');
  const review = g.rows.find((r) => r.title === 'review');
  assert.equal(review.dot, 'done');
  assert.equal(review.sub, 'done · ready to review');
  assert.equal(review.taskId, 't3');
  assert.equal(g.rows.find((r) => r.title === 'idle recent').sub, 'finished 5m ago');
  assert.equal(m.earlierLabel(g.earlier.length), '2 earlier today');
});

test('in flight: the fold is at exactly 2h', () => {
  const tiles = [tile(1), tile(2)];
  const times = new Map([
    [1, { busySince: null, idleSince: new Date(NOW - m.EARLIER_AFTER_MS).toISOString() }],
    [2, { busySince: null, idleSince: new Date(NOW - m.EARLIER_AFTER_MS - 1000).toISOString() }],
  ]);
  const g = m.inFlight({ tiles, times, now: NOW });
  assert.deepEqual(g.rows.map((r) => r.ptyId), [1]);
  assert.deepEqual(g.earlier.map((r) => r.ptyId), [2]);
});

test('in flight: failed ops lead, running ops follow the busy agents; tasks without an agent show', () => {
  const ops = [
    { def: { name: 'build' }, status: 'running', running: { started_at: ago(3), ended_at: null }, last_run: null },
    { def: { name: 'test' }, status: 'failed', running: null, last_run: { started_at: ago(5), ended_at: ago(2) } },
    { def: { name: 'lint' }, status: 'passed', running: null, last_run: null },
  ];
  const tasks = [
    { id: 'q', name: null, title: 'Queued thing', status: 'queued', agent: null, updated_at: ago(1) },
    { id: 'r', name: 'Named review', title: 'raw', status: 'review', agent: { pty_id: 99 }, updated_at: ago(4) },
    { id: 'linked', title: 'has a tile', status: 'running', agent: { pty_id: 1 }, updated_at: ago(1) },
    { id: 'd', title: 'done', status: 'done', agent: null, updated_at: ago(1) },
  ];
  const g = m.inFlight({ tiles: [tile(1, { working: true })], tasks, ops, now: NOW });
  assert.deepEqual(g.rows.map((r) => r.id), ['work:op:test', 'work:agent:1', 'work:op:build', 'work:task:r', 'work:task:q']);
  const failed = g.rows[0];
  assert.equal(failed.dot, 'needs');
  assert.equal(failed.sub, 'failed · 2m');
  assert.equal(g.rows[2].sub, 'running · 3m');
  assert.equal(g.rows[3].title, 'Named review');
  assert.equal(g.rows[4].sub, 'queued');
});

test('in flight: agent times from the snapshot, else the tab runtime', () => {
  const t = m.agentTimes(
    { agents: [{ pty_id: 1, busy_since: ago(4), idle_since: null }] },
    [
      { pty_id: 1, state: { state: 'busy', since: ago(9) } },
      { pty_id: 2, state: { state: 'idle-at-prompt', since: ago(7) } },
    ],
  );
  assert.equal(t.get(1).busySince, ago(4));
  assert.equal(t.get(2).idleSince, ago(7));
});

test('summary: counts in words, zero parts left out', () => {
  assert.equal(m.workSummary({ waiting: 2, working: 3, done: 1 }), '2 waiting on you · 3 working · 1 done today');
  assert.equal(m.workSummary({ waiting: 0, working: 1, done: 0 }), '1 working');
  assert.equal(m.workSummary({ waiting: 0, working: 0, done: 0 }), '');
  const today = new Date(NOW);
  today.setHours(0, 30, 0, 0);
  const yesterday = new Date(today.getTime() - 86400000);
  assert.equal(
    m.doneToday(
      [
        { status: 'done', closed_at: today.toISOString() },
        { status: 'discarded', closed_at: today.toISOString() },
        { status: 'done', closed_at: yesterday.toISOString() },
      ],
      Math.max(NOW, today.getTime() + 60000),
    ),
    1,
  );
});

// ---------------------------------------------------------------------------
// Detail next and previous
// ---------------------------------------------------------------------------

test('detail: next and previous without going back, clamped at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(m.stepItem(ids, 'a', 1), 'b');
  assert.equal(m.stepItem(ids, 'b', -1), 'a');
  assert.equal(m.stepItem(ids, 'c', 1), 'c');
  assert.equal(m.stepItem(ids, 'a', -1), 'a');
  assert.equal(m.stepItem(ids, 'gone', 1), 'a');
  assert.equal(m.stepItem(ids, null, -1), 'c');
  assert.equal(m.stepItem([], 'a', 1), null);
});

test('detail: along the way pairs pre and post, past tense for post, last 8', () => {
  const e = (i, over) => ({ at: ago(20 - i), tool: 'Bash', preview: `cmd${i}`, files: [], writes: false, phase: 'post', ...over });
  const recent = [
    e(0, { tool: 'Edit', preview: 'a.ts', files: ['src/a.ts'], phase: 'pre' }),
    e(1, { tool: 'Edit', preview: 'a.ts', files: ['src/a.ts'], phase: 'post' }),
    e(2, { tool: 'Bash', preview: 'npm test', failed: true }),
    e(3, { tool: 'Read', preview: 'b.ts', files: ['b.ts'], phase: 'pre' }),
  ];
  const along = m.alongTheWay(recent);
  assert.deepEqual(along.map((x) => x.text), ['Edited a.ts', 'Ran tests (failed)', 'Reading b.ts']);
  assert.equal(along[1].failed, true);
  const many = Array.from({ length: 12 }, (_, i) => e(i, { preview: `echo ${i}` }));
  const last = m.alongTheWay(many);
  assert.equal(last.length, 8);
  assert.equal(last[7].text, 'Ran echo');
  assert.match(m.clockTime(ago(0)), /^\d\d:\d\d$/);
});

// ---------------------------------------------------------------------------
// Swipe
// ---------------------------------------------------------------------------

test('swipe: accumulates past 120px; leftward snoozes, rightward dismisses', () => {
  let s = m.SWIPE_IDLE;
  let fire = null;
  for (const d of [40, 40, 30]) ({ state: s, fire } = m.swipeStep(s, { deltaX: d, deltaY: 2 }));
  assert.equal(fire, null);
  assert.equal(s.dx, -110, 'the card follows the gesture (fingers left, card left)');
  ({ state: s, fire } = m.swipeStep(s, { deltaX: 15, deltaY: 0 }));
  assert.equal(fire, 'snooze');
  assert.equal(s.fired, 'snooze');
  ({ state: s, fire } = m.swipeStep(s, { deltaX: 200, deltaY: 0 }));
  assert.equal(fire, null, 'momentum after firing is ignored');
  s = m.swipeRelease(s);

  let r = m.SWIPE_IDLE;
  ({ state: r, fire } = m.swipeStep(r, { deltaX: -80, deltaY: 0 }));
  ({ state: r, fire } = m.swipeStep(r, { deltaX: -41, deltaY: 0 }));
  assert.equal(fire, 'dismiss');
  assert.equal(m.swipedLabel('snooze'), 'Snoozed');
  assert.equal(m.swipedLabel('dismiss'), 'Dismissed');
});

test('swipe: vertical-dominant events are ignored; below the threshold it snaps back', () => {
  let s = m.SWIPE_IDLE;
  let fire;
  ({ state: s, fire } = m.swipeStep(s, { deltaX: 50, deltaY: 60 }));
  assert.equal(s.dx, 0);
  ({ state: s, fire } = m.swipeStep(s, { deltaX: 30, deltaY: 30 }));
  assert.equal(s.dx, 0, 'a diagonal tie is not a swipe');
  ({ state: s, fire } = m.swipeStep(s, { deltaX: 100, deltaY: 10 }));
  assert.equal(s.dx, -100);
  assert.equal(fire, null);
  s = m.swipeRelease(s);
  assert.deepEqual(s, { dx: 0, fired: null });
  assert.equal(m.SWIPE_THRESHOLD, 120);
  assert.equal(m.SWIPE_UNDO_MS, 5000);
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

test('library: words are chars / 5.7, rounded; "about" under 1,000', () => {
  assert.equal(m.wordEstimate(570), 100);
  assert.equal(m.wordEstimate(572), 100);
  assert.equal(m.wordEstimate(0), 0);
  assert.equal(m.wordEstimate(null), 0);
  assert.equal(m.wordsLabel(570), 'about 100 words');
  assert.equal(m.wordsLabel(6), 'about 1 word');
  assert.equal(m.wordsLabel(0), 'empty page');
  assert.equal(m.wordsLabel(5697), 'about 999 words');
  assert.equal(m.wordsLabel(5700), '1,000 words');
  assert.equal(m.wordsLabel(12000), '2,105 words');
});

test('library: quiet after 7 days; the meta line', () => {
  const day = 86400000;
  assert.equal(m.isQuiet(new Date(NOW - 7 * day + 1000).toISOString(), NOW), false);
  assert.equal(m.isQuiet(new Date(NOW - 7 * day - 1000).toISOString(), NOW), true);
  assert.equal(m.isQuiet(null, NOW), false);
  assert.equal(
    m.explorationMeta({ page_chars: 570, answers_unread: 1, answers_pending: 1, open_questions: 1, last_touched_at: new Date(NOW - 8 * day).toISOString() }, NOW),
    'about 100 words · 2 answers · 1 open question · quiet',
  );
  assert.equal(m.explorationMeta({ page_chars: 0, last_touched_at: ago(5) }, NOW), 'empty page');
});

test('library: the Page’s last line, newest touched first, find', () => {
  assert.equal(m.lastPageLine('# Title\n\nFirst thought.\n- the last idea\n\n'), 'the last idea');
  assert.equal(m.lastPageLine('Something\n---\n'), 'Something');
  assert.equal(m.lastPageLine(''), '');
  const sorted = m.sortByTouched([
    { id: 'a', last_touched_at: ago(30) },
    { id: 'b', last_touched_at: null, updated_at: ago(5) },
    { id: 'c', last_touched_at: ago(1) },
  ]);
  assert.deepEqual(sorted.map((x) => x.id), ['c', 'b', 'a']);
  assert.equal(m.matchesFind('', ['x']), true);
  assert.equal(m.matchesFind('Parser idea', ['A new parser', 'the idea']), true);
  assert.equal(m.matchesFind('parser zebra', ['A new parser']), false);
  assert.equal(m.isDeviceCapture('aeronaut'), true);
  assert.equal(m.isDeviceCapture('lee'), false);
});

// ---------------------------------------------------------------------------
// Rendered sections (static HTML, fixture data): the one next step (§0 rule 1)
// ---------------------------------------------------------------------------

const renderEntry = `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkSection } from './components/cockpit/sections/WorkSection';
import { WorkDetail } from './components/cockpit/work/WorkDetail';
import { LibrarySection } from './components/cockpit/sections/LibrarySection';
export const render = {
  work: (ctx) => renderToStaticMarkup(React.createElement(WorkSection, { ctx })),
  detail: (ctx, subject) => renderToStaticMarkup(React.createElement(WorkDetail, { ctx, subject, focusReply: false, openLink: false, onBack: () => {} })),
  library: (ctx) => renderToStaticMarkup(React.createElement(LibrarySection, { ctx, focusCreateNonce: 0 })),
};
`;
const rendered = await esbuild.build({
  stdin: { contents: renderEntry, resolveDir: join(__dirname, '../src/renderer'), loader: 'tsx' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  define: { 'import.meta.env': '{"DEV":false}', 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const renderDir = mkdtempSync(join(tmpdir(), 'lee-work-render-'));
const renderFile = join(renderDir, 'render.mjs');
// Bundled CommonJS (react) inside ESM needs a require for node built-ins.
writeFileSync(renderFile, `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${rendered.outputFiles[0].text}`);
let render;
try {
  ({ render } = await import(pathToFileURL(renderFile).href));
} finally {
  rmSync(renderDir, { recursive: true, force: true });
}

const noop = () => {};
function fixtureCtx(over = {}) {
  return {
    workspace: WS,
    api: null,
    copilotApi: null,
    snapshot: { items: [], agents: [], counts: {}, focus: {}, away: {}, generated_at: ago(0) },
    runtime: [],
    ops: { operations: [], suggestions: [], proposals: [] },
    hester: { snapshot: { tasks: { open: [], recent_closed: [] } }, offline: null, refresh: noop },
    tiles: [],
    feedRows: [],
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
    goals: { data: null, error: null, loading: false, refresh: noop },
    requestSteward: noop,
    pendingSteward: null,
    ...over,
  };
}
const nextCount = (html) => (html.match(/ui-btn is-next/g) ?? []).length;
const chipCount = (html) => (html.match(/class="ui-chip/g) ?? []).length;
const approvalItem = item('ap', {
  kind: 'approval',
  created_at: ago(20),
  actions: ['approve', 'deny'],
  tool: { name: 'Bash', preview: 'rm -rf build', signature: 's' },
  source: { ...item('x').source, pty_id: 3 },
});
const textItem = item('tx', { created_at: ago(5), text: 'Should I also update the docs?', source: { ...item('x').source, pty_id: 4 } });
const withItems = (items, over = {}) => fixtureCtx({ snapshot: { ...fixtureCtx().snapshot, items }, ...over });

test('render: the raised approval’s Allow is the list’s one next step; a list card shows 3 quick replies', () => {
  const html = render.work(withItems([textItem, approvalItem], { tiles: [tile(3), tile(4), tile(5, { working: true })] }));
  assert.equal(nextCount(html), 1);
  assert.match(html, /Waiting on you/);
  assert.match(html, /rm -rf build/);
  assert.match(html, /In flight/);
  assert.equal(chipCount(html), 3);
  assert.ok(html.indexOf('rm -rf build') < html.indexOf('Should I also update'), 'the older approval comes first');
});

test('render: a raised text card has no next step; an approval below it is plain', () => {
  const html = render.work(withItems([{ ...textItem, created_at: ago(40) }, approvalItem]));
  assert.match(html, /rm -rf build/);
  assert.match(html, /ui-btn is-plain[^>]*>Allow/);
  assert.equal(nextCount(html), 0);
});

test('render: nothing waiting and an agent busy shows "Working on it." with Continue as the next step', () => {
  const html = render.work(fixtureCtx({ tiles: [tile(5, { working: true })] }));
  assert.match(html, /Working on it\./);
  assert.equal(nextCount(html), 1);
  assert.match(html, /Continue/);
});

const subject = (over) => ({
  id: 'work:item:x',
  name: 'Agent 3',
  item: null,
  tile: tile(3),
  task: null,
  agent: null,
  ptyId: 3,
  provider: 'claude',
  workspace: WS,
  busySince: ago(18),
  sessionId: null,
  ...over,
});

test('render: the detail’s Allow is its next step while an approval is pending (Send is plain)', () => {
  const html = render.detail(fixtureCtx(), subject({ item: approvalItem, tile: tile(3, { approval: approvalItem, replyItem: textItem }) }));
  assert.equal(nextCount(html), 1);
  assert.match(html, /is-next[^>]*>Allow/);
  assert.match(html, /started 18m ago/);
});

test('render: a text item’s detail shows all four quick replies, the reply box and Send as the next step', () => {
  const recent = [{ at: ago(3), tool: 'Edit', preview: 'a.ts', files: ['src/a.ts'], writes: true, phase: 'post' }];
  const html = render.detail(
    fixtureCtx(),
    subject({ id: 'work:item:tx', item: textItem, tile: tile(4, { replyItem: textItem }), ptyId: 4, agent: { pty_id: 4, recent } }),
  );
  assert.equal(chipCount(html), 4);
  assert.equal(nextCount(html), 1);
  assert.match(html, /Sent exactly as written/);
  assert.match(html, /It asked/);
  assert.match(html, /Along the way/);
  assert.match(html, /Edited a\.ts/);
  assert.match(html, /Assign…/, 'an agent with no task offers Assign…');
});

test('render: an open task’s detail keeps Tasks’ actions as quiet links (Promote…, Escalate → Explore, Hester’s view, Priority…)', () => {
  const task = { id: 't1', title: 'Fix login', name: null, status: 'running', confirmed: true, serves: [], workstream: null, created_at: ago(30), overrides: null, urgency: null };
  const html = render.detail(fixtureCtx(), subject({ id: 'work:task:t1', task, tile: tile(3, { task }) }));
  for (const label of ['Promote…', 'Escalate → Explore', 'Hester&#x27;s view', 'Priority…', 'Link to a goal…']) assert.ok(html.includes(label), label);
  const inStream = render.detail(fixtureCtx(), subject({ id: 'work:task:t1', task: { ...task, workstream: 'ws1' }, tile: tile(3) }));
  assert.ok(!inStream.includes('Promote…'), 'no Promote… once it is in a workstream');
  const closed = render.detail(fixtureCtx(), subject({ id: 'work:task:t1', task: { ...task, status: 'done' }, tile: null, ptyId: null }));
  for (const label of ['Promote…', 'Escalate → Explore', 'Priority…']) assert.ok(!closed.includes(label), `closed: no ${label}`);
});

test('render: Library has no next step', () => {
  const html = render.library(fixtureCtx());
  assert.equal(nextCount(html), 0);
  assert.match(html, /Explorations/);
  assert.match(html, /New exploration/);
});

console.log(`cockpit-work-smoke: ${passed} tests passed`);
