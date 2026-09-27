#!/usr/bin/env node
/**
 * Smoke test for Work and Library's pure model (cockpit-design §4, §5, §10 R2):
 * src/renderer/lib/workModel.ts. The waiting order, In flight's order and the
 * "earlier" fold at 2h, the swipe accumulator (threshold, direction, snap
 * back, ignoring vertical), the quick replies shown (3 in the list, 4 in the
 * detail), stepping to the next and previous item in the detail view, and
 * Library's word estimate and "quiet", the detail's reply box states (item,
 * idle PTY, busy, none), its Updates feed and dedupe, the merged "Along the
 * way" lines and which actions are icons and which sit in ⋯. Compiles the real source with
 * esbuild, no React, no DOM. Then renders WorkSection and WorkDetail to
 * static HTML with fixture data (react-dom/server) and checks the
 * one-next-step rule and the chips each place shows. Desk D2 §8: Library is
 * gone (its pure helpers stay tested until the merge step); deep_idle is
 * never a waiting card.
 * Usage (docs/15-Usage.md §6.1, §6.2; package UR): usageModel.ts's token and
 * dollar labels (dollars only for billed / estimate), the limits in Work's
 * summary (hidden to 50%, "as of" past 10 minutes, resets in the tooltip,
 * a reset window dropped), the Launcher's 85% note, and tokens on list
 * rows, waiting cards and the detail's meta line.
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

test('waiting (Desk D2 §9.2): the idle-end push is devices-only, never a waiting card', () => {
  const idle = item('idle', { kind: 'deep_idle', title: 'Still thinking?', actions: ['extend', 'end_rate', 'capture', 'dismiss'] });
  assert.deepEqual(m.waitingItems({ items: [idle, item('b')], workspace: WS }).map((x) => x.item.id), ['b']);
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

test('in flight: failed ops lead, running ops follow the busy agents; tasks without an agent fold into Not open', () => {
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
  assert.deepEqual(g.rows.map((r) => r.id), ['work:op:test', 'work:agent:1', 'work:op:build'], 'In flight shows only open agents (and ops)');
  const failed = g.rows[0];
  assert.equal(failed.dot, 'needs');
  assert.equal(failed.sub, 'failed · 2m');
  assert.equal(g.rows[2].sub, 'running · 3m');
  assert.deepEqual(g.notOpen.map((r) => r.id), ['work:task:r', 'work:task:q']);
  assert.equal(g.notOpen[0].title, 'Named review');
  assert.equal(g.notOpen[0].sub, 'ready to review', 'a review task keeps its sub-line');
  assert.equal(g.notOpen[0].dot, 'done');
  assert.equal(g.notOpen[1].sub, 'queued');
});

test('in flight: an open task whose agent is gone is not open, not an idle row', () => {
  const tasks = [
    { id: 'gone', title: 'Agent closed', status: 'running', agent: { pty_id: 42, session_id: 's1' }, updated_at: ago(30) },
    { id: 'w', title: 'Was waiting', status: 'waiting', agent: null, updated_at: ago(10) },
  ];
  const g = m.inFlight({ tiles: [], tasks, now: NOW });
  assert.deepEqual(g.rows, []);
  assert.deepEqual(g.earlier, []);
  assert.deepEqual(g.notOpen.map((r) => [r.id, r.sub, r.dot]), [
    ['work:task:w', 'not open', 'idle'],
    ['work:task:gone', 'not open', 'idle'],
  ]);
  assert.ok(!g.notOpen.some((r) => /no agent/.test(r.sub)));
  assert.equal(m.notOpenLabel(2), 'Not open (2)');
});

test('resume: a not-open task resumes its Claude session only when it has one', () => {
  assert.equal(m.resumableSession({ status: 'running', agent: { provider: 'claude', session_id: 'abc-1' }, sessions: ['old'] }), 'abc-1');
  assert.equal(m.resumableSession({ status: 'review', agent: { provider: 'claude', session_id: null }, sessions: ['s1', 's2'] }), 's2', 'else the latest session');
  assert.equal(m.resumableSession({ status: 'running', agent: { provider: 'pi', session_id: 'p1' }, sessions: [] }), null, 'Claude only');
  assert.equal(m.resumableSession({ status: 'queued', agent: null, sessions: [] }), null, 'no session, no Resume');
  assert.equal(m.resumableSession({ status: 'done', agent: { provider: 'claude', session_id: 'x' }, sessions: [] }), null, 'closed tasks do not resume');
  assert.equal(m.resumableSession({ status: 'running', agent: { provider: 'claude', session_id: '--settings' }, sessions: [] }), null, 'never a flag on argv');
  const t = { confirmed: true, status: 'running', workstream: null };
  assert.equal(m.detailActions({ tile: null, ptyId: null, task: t, resumable: true }).icons[0], 'resume');
  assert.ok(!m.detailActions({ tile: null, ptyId: null, task: t, resumable: false }).icons.includes('resume'));
  assert.ok(!m.detailActions({ tile: { checkin: null, canCheckin: true, task: {} }, ptyId: 3, task: t, resumable: true }).icons.includes('resume'), 'an open agent has no Resume');
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
  const many = Array.from({ length: 12 }, (_, i) => e(i, { preview: `cmd${i} x` }));
  const last = m.alongTheWay(many);
  assert.equal(last.length, 8);
  assert.equal(last[7].text, 'Ran cmd11');
  assert.match(m.clockTime(ago(0)), /^\d\d:\d\d$/);
});

test('detail: along the way merges identical consecutive lines ("Ran grep ×3"), not separated ones', () => {
  const e = (i, preview, over = {}) => ({ at: ago(20 - i), tool: 'Bash', preview, files: [], writes: false, phase: 'post', ...over });
  const along = m.alongTheWay([
    e(0, 'grep -rn foo src'),
    e(1, 'cd electron && grep bar'),
    e(2, 'grep baz'),
    e(3, 'npm test'),
    e(4, 'grep again'),
  ]);
  assert.deepEqual(along.map((x) => x.text), ['Ran grep ×3', 'Ran tests', 'Ran grep']);
  assert.deepEqual(along.map((x) => x.count), [3, 1, 1]);
  assert.equal(along[0].at, ago(18), 'a merged line carries its latest time');
  const failed = m.alongTheWay([e(0, 'grep a'), e(1, 'grep b', { failed: true })]);
  assert.deepEqual(failed.map((x) => x.text), ['Ran grep', 'Ran grep (failed)'], 'a failure never merges into a success');
  assert.equal(m.alongLabel(3), 'Along the way (3)');
});

// ---------------------------------------------------------------------------
// The reply box, Updates, actions
// ---------------------------------------------------------------------------

test('reply: item / idle PTY / busy / no PTY; Send is next unless Allow shows', () => {
  assert.equal(m.replyMode({ replyItem: {}, ptyId: 3, working: true }), 'item', 'an item that takes text wins, even mid-turn');
  assert.equal(m.replyMode({ replyItem: {}, ptyId: null, working: false }), 'item');
  assert.equal(m.replyMode({ replyItem: null, ptyId: 3, working: false }), 'pty');
  assert.equal(m.replyMode({ replyItem: null, ptyId: 3, working: true }), 'busy');
  assert.equal(m.replyMode({ replyItem: null, ptyId: null, working: false }), 'none');
  assert.equal(m.sendIsNext('item', false), true);
  assert.equal(m.sendIsNext('pty', false), true);
  assert.equal(m.sendIsNext('pty', true), false, 'Allow wins');
  assert.equal(m.sendIsNext('busy', false), false);
  assert.equal(m.sendIsNext('none', false), false);
  assert.equal(m.tabSendError('busy'), m.REPLY_BUSY_LINE);
  assert.match(m.tabSendError('awaiting_input'), /answer that first/);
  assert.equal(m.tabSendError('weird'), 'weird');
  assert.equal(m.tabSendError(undefined), 'failed');
});

const lee = (over = {}) => ({ status: 'done', summary: null, blockers: null, files: [], next: null, ...over });

test('updates: newest first, status words, lee summary else first sentence, next, cap 10', () => {
  const ups = [
    { at: ago(30), summary: 'Looked at the login flow. It uses cookies.', lee_status: null },
    { at: ago(20), summary: 'long text', lee_status: lee({ status: 'in-progress', summary: 'Halfway through the refactor', next: 'wire the tests' }) },
    { at: ago(10), summary: 'x', lee_status: lee({ status: 'blocked', summary: 'Need the API key' }) },
    { at: ago(5), summary: 'y', lee_status: lee({ status: 'waiting', summary: 'Which branch?' }) },
  ];
  const feed = m.updatesFeed(ups);
  assert.deepEqual(feed.map((u) => u.text), ['Which branch?', 'Need the API key', 'Halfway through the refactor', 'Looked at the login flow.']);
  assert.deepEqual(feed.map((u) => u.status), ['waiting', 'blocked', 'in progress', null]);
  assert.deepEqual(feed.map((u) => u.needsYou), [true, true, false, false], 'ember only for blocked or waiting');
  assert.equal(feed[2].next, 'wire the tests');
  assert.equal(feed[3].next, null);
  assert.match(feed[0].time, /^\d\d:\d\d$/);
  const many = Array.from({ length: 14 }, (_, i) => ({ at: ago(60 - i), summary: `Step ${i}.`, lee_status: null }));
  const capped = m.updatesFeed(many);
  assert.equal(capped.length, 10);
  assert.equal(capped[0].text, 'Step 13.');
  assert.equal(m.firstSentence('**Done.** Tests pass.\n\n```lee-status\nstatus: done\n```'), 'Done.');
  assert.equal(m.updatesFeed(null).length, 0);
});

test('updates: the newest is skipped when "It said" shows the same words', () => {
  const said = 'Fixed the bug.\n\nAll tests pass.';
  const ups = [
    { at: ago(20), summary: 'Earlier turn.', lee_status: null },
    { at: ago(5), summary: 'Fixed the bug.\n\nAll tests pass.\n\n```lee-status\nstatus: done\nsummary: Fixed it\n```', lee_status: lee({ summary: 'Fixed it' }) },
  ];
  assert.deepEqual(m.updatesFeed(ups, said).map((u) => u.text), ['Earlier turn.']);
  assert.deepEqual(m.updatesFeed(ups, 'Something else').map((u) => u.text), ['Fixed it', 'Earlier turn.']);
  assert.deepEqual(m.updatesFeed(ups, 'Fixed it').map((u) => u.text), ['Earlier turn.'], 'the same lee-status summary counts too');
  assert.deepEqual(m.updatesFeed([ups[0], ups[0]], 'Earlier turn.').map((u) => u.text), ['Earlier turn.'], 'only the newest is skipped');
});

test('actions: icons for the common ones, the rest in ⋯, per task state', () => {
  const t = (over = {}) => ({ confirmed: true, status: 'running', workstream: null, ...over });
  const agent = { checkin: null, canCheckin: true, task: null };
  let a = m.detailActions({ tile: agent, ptyId: 3, task: null });
  assert.deepEqual(a.icons, ['checkin', 'rename', 'terminal', 'close']);
  assert.deepEqual(a.more, ['assign']);
  a = m.detailActions({ tile: { ...agent, checkin: { state: 'queued' } }, ptyId: 3, task: null });
  assert.equal(a.icons[0], 'cancel-checkin');
  a = m.detailActions({ tile: { ...agent, task: {} }, ptyId: 3, task: t({ confirmed: false }) });
  assert.deepEqual(a.icons, ['checkin', 'rename', 'terminal', 'confirm', 'close']);
  assert.deepEqual(a.more, ['link', 'priority', 'promote', 'escalate', 'hester-view']);
  a = m.detailActions({ tile: { ...agent, task: {} }, ptyId: 3, task: t({ status: 'review', workstream: 'ws1' }) });
  assert.deepEqual(a.icons, ['checkin', 'rename', 'terminal', 'accept', 'discard', 'close']);
  assert.deepEqual(a.more, ['link', 'priority', 'escalate', 'hester-view'], 'no Promote… once in a workstream');
  a = m.detailActions({ tile: null, ptyId: null, task: t({ status: 'done' }) });
  assert.deepEqual(a.icons, ['rename']);
  assert.deepEqual(a.more, []);
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
export const render = {
  work: (ctx) => renderToStaticMarkup(React.createElement(WorkSection, { ctx })),
  detail: (ctx, subject) => renderToStaticMarkup(React.createElement(WorkDetail, { ctx, subject, focusReply: false, openLink: false, onBack: () => {} })),
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
  assert.match(html, /Two things need you\./);
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

const replyBox = (html) => /class="work-reply/.test(html);
const sendKind = (html) => (/ui-btn is-(next|plain)"[^>]*>Send/.exec(html) ?? [])[1] ?? null;

test('render: an idle agent with no item still gets the reply box, Send as the next step', () => {
  const html = render.detail(fixtureCtx(), subject({ tile: tile(3) }));
  assert.ok(replyBox(html));
  assert.equal(chipCount(html), 4);
  assert.equal(sendKind(html), 'next');
  assert.equal(nextCount(html), 1);
  assert.match(html, /Sent exactly as written/);
});

test('render: a busy agent’s reply box is disabled with the quiet line; no next step', () => {
  const html = render.detail(fixtureCtx(), subject({ tile: tile(3, { working: true }) }));
  assert.ok(replyBox(html));
  assert.match(html, /It&#x27;s working; reply when it finishes\./);
  assert.match(html, /<textarea[^>]*disabled/);
  assert.equal(sendKind(html), 'plain');
  assert.equal(nextCount(html), 0);
});

test('render: no PTY (agent gone) means no reply box', () => {
  const task = { id: 't9', title: 'Old', name: null, status: 'running', confirmed: true, serves: [], workstream: null, created_at: ago(30), overrides: null, urgency: null };
  const html = render.detail(fixtureCtx(), subject({ id: 'work:task:t9', task, tile: null, ptyId: null }));
  assert.ok(!replyBox(html));
  assert.equal(nextCount(html), 0);
});

test('render: an approval on an idle agent keeps Allow the one next step; Send is plain', () => {
  const html = render.detail(fixtureCtx(), subject({ item: approvalItem, tile: tile(3, { approval: approvalItem }) }));
  assert.equal(nextCount(html), 1);
  assert.match(html, /is-next[^>]*>Allow/);
  assert.equal(sendKind(html), 'plain');
});

test('render: Updates below the reply box, newest first; Along the way folded below it; icon actions with ⋯', () => {
  const recent = [
    { at: ago(4), tool: 'Bash', preview: 'grep a', files: [], writes: false, phase: 'post' },
    { at: ago(3), tool: 'Bash', preview: 'grep b', files: [], writes: false, phase: 'post' },
  ];
  const updates = [
    { at: ago(30), summary: 'Read the code.', lee_status: lee({ status: 'blocked', summary: 'Need a key', next: 'ask Ben' }) },
    { at: ago(10), summary: 'Summary words.', lee_status: null },
  ];
  const html = render.detail(fixtureCtx(), subject({ tile: tile(3), agent: { pty_id: 3, recent, updates } }));
  const at = (re) => html.search(re);
  assert.ok(at(/class="work-reply/) < at(/Updates/), 'Updates below the reply box');
  assert.ok(at(/Updates/) < at(/Along the way \(1\)/), 'Along the way below Updates');
  assert.ok(at(/Summary words\./) < at(/Need a key/), 'newest first');
  assert.match(html, /next: ask Ben/);
  assert.match(html, /aria-label="blocked"/, 'an ember dot for blocked');
  assert.match(html, /aria-expanded="false"[^>]*>.*Along the way \(1\)/, 'folded by default');
  assert.ok(!html.includes('Ran grep ×2'), 'the lines stay folded');
  for (const label of ['Check in', 'Rename', 'Open terminal in Manual', 'Close agent', 'More actions']) {
    assert.match(html, new RegExp(`class="ui-icon-action[^"]*"[^>]*aria-label="${label}"`), label);
  }
  assert.ok(!/ui-quiet-links/.test(html), 'no quiet links row');
  assert.equal(nextCount(html), 1);
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
  assert.match(html, /Along the way \(1\)/);
  assert.match(html, /aria-label="More actions"/, 'Assign… and the rest sit behind ⋯');
});

test('render: a task in review shows Accept and Discard as icons; its rarer actions stay behind ⋯ (closed menu)', () => {
  const task = { id: 't1', title: 'Fix login', name: null, status: 'review', confirmed: false, serves: [], workstream: null, created_at: ago(30), overrides: null, urgency: null };
  const html = render.detail(fixtureCtx(), subject({ id: 'work:task:t1', task, tile: tile(3, { task }) }));
  for (const label of ['Confirm task', 'Accept', 'Discard', 'More actions']) assert.match(html, new RegExp(`aria-label="${label}"`), label);
  for (const label of ['Promote…', 'Escalate → Explore', 'Priority…', 'Link to a goal…']) assert.ok(!html.includes(label), `${label} is in the closed menu`);
  const closed = render.detail(fixtureCtx(), subject({ id: 'work:task:t1', task: { ...task, status: 'done' }, tile: null, ptyId: null }));
  assert.ok(!closed.includes('More actions'), 'a closed task has no ⋯');
  assert.equal(nextCount(closed), 0);
});

test('render: Not open folds below In flight; Resume shows only with a Claude session id', () => {
  const tasks = [
    { id: 'n1', title: 'Old fix', name: null, status: 'running', confirmed: true, serves: [], workstream: null, created_at: ago(90), updated_at: ago(60), agent: { provider: 'claude', pty_id: 77, session_id: 'sess-1', tab_label: null }, sessions: ['sess-1'], overrides: null, urgency: null },
    { id: 'n2', title: 'Needs review', name: null, status: 'review', confirmed: true, serves: [], workstream: null, created_at: ago(90), updated_at: ago(30), agent: null, sessions: [], overrides: null, urgency: null },
  ];
  const hester = { snapshot: { tasks: { open: tasks, recent_closed: [] } }, offline: null, refresh: noop };
  const html = render.work(fixtureCtx({ hester, tiles: [tile(5, { working: true })] }));
  assert.match(html, /In flight/);
  assert.match(html, /Not open \(2\)/);
  assert.ok(!html.includes('Old fix') && !html.includes('Needs review'), 'the fold starts collapsed');
  assert.ok(html.indexOf('In flight') < html.indexOf('Not open (2)'), 'below In flight');
  const api = { resume: async () => ({ success: true, pty_id: 9 }) };
  const withSession = render.detail(fixtureCtx({ api }), subject({ id: 'work:task:n1', task: tasks[0], tile: null, ptyId: null }));
  assert.match(withSession, /aria-label="Resume"/);
  assert.equal(nextCount(withSession), 0, 'Resume is an icon, not a second next step');
  const without = render.detail(fixtureCtx({ api }), subject({ id: 'work:task:n2', task: tasks[1], tile: null, ptyId: null }));
  assert.ok(!/aria-label="Resume"/.test(without), 'no session id, no Resume');
  const open = render.detail(fixtureCtx({ api }), subject({ id: 'work:agent:3', task: tasks[0], tile: tile(3, { task: tasks[0] }) }));
  assert.ok(!/aria-label="Resume"/.test(open), 'an open agent has no Resume');
});

test('render (Desk D2 §8): a hand-off task from a Page, in either origin form, renders its detail with the ⋯ menu', () => {
  const base = { id: 't7', title: 'Spike the merge', name: null, title_source: 'user', status: 'running', confirmed: true, kind: 'prototype', lead: 'agent', serves: [], quadrant: null };
  const withPage = render.detail(fixtureCtx(), subject({ id: 'work:task:t7', task: { ...base, origin: { kind: 'page', ref: 'pg-1a2b3c4d#ans-01' } }, tile: null, ptyId: null }));
  const withOld = render.detail(fixtureCtx(), subject({ id: 'work:task:t7', task: { ...base, origin: { kind: 'exploration', ref: 'exp-1a2b3c4d#ans-01' } }, tile: null, ptyId: null }));
  // "Open its Page" sits in the ⋯ menu, which renders closed; cardIdForOrigin is covered by the renderer smoke.
  for (const html of [withPage, withOld]) {
    assert.match(html, /aria-label="More actions"/);
    assert.equal(nextCount(html), 0);
    assert.ok(!/Library/.test(html), 'no Library left');
  }
});

// ---------------------------------------------------------------------------
// Usage (docs/15-Usage.md §6.1, §6.2)
// ---------------------------------------------------------------------------

const usageBuilt = await esbuild.build({ entryPoints: [join(__dirname, '../src/renderer/lib/usageModel.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
assert.ok(!/^\s*import\s/m.test(usageBuilt.outputFiles[0].text), 'usageModel.ts must be pure');
const usageDir = mkdtempSync(join(tmpdir(), 'lee-usage-smoke-'));
let u;
try {
  const f = join(usageDir, 'usageModel.mjs');
  writeFileSync(f, usageBuilt.outputFiles[0].text);
  u = await import(pathToFileURL(f).href);
} finally {
  rmSync(usageDir, { recursive: true, force: true });
}

const later = (min) => new Date(NOW + min * 60000).toISOString();
const subUsage = { tokens: { input: 2000, output: 10000, cache_write: 400000, cache_read: 9000000 }, shown_tokens: 412000, cost_basis: 'subscription', cost_usd: 9.99 };
const billedUsage = { tokens: { input: 1000, output: 1500000 }, shown_tokens: 1501000, cost_basis: 'billed', cost_usd: 3.1 };

test('usage: tokens next to an agent; dollars only for billed or estimate', () => {
  assert.equal(u.agentTokensLabel(subUsage), '412k tok');
  assert.equal(u.agentTokensLabel(null), '');
  assert.equal(u.agentTokensLabel({ shown_tokens: 0 }), '', 'nothing before the first turn ends');
  assert.equal(u.agentUsageDetail(subUsage), '412k tokens', 'a subscription run never shows dollars');
  assert.equal(u.agentUsageDetail(billedUsage), '1.5M tokens · $3.10');
  assert.equal(u.agentUsageDetail({ ...billedUsage, cost_basis: 'estimate', cost_usd: 0.004 }), '1.5M tokens · <$0.01');
  assert.equal(u.agentUsageDetail({ ...billedUsage, cost_basis: 'local' }), '1.5M tokens');
  assert.equal(u.formatUsd(120.4), '$120');
  assert.equal(u.shownTokens({ input: 1, output: 2, cache_write: 3, cache_read: 1000, thinking: 1 }), 6, 'cache reads and thinking are not added');
});

test('usage: limits join the summary past 50%, with "as of" past 10 minutes and resets in the tooltip', () => {
  const limits = (pct, asOfMin = 1, over = {}) => ({
    five_hour: { used_pct: pct, resets_at: later(100) },
    seven_day: { used_pct: 18.2, resets_at: later(3 * 1440) },
    as_of: ago(asOfMin),
    ...over,
  });
  assert.equal(u.limitsSummary(limits(50), NOW), null, 'hidden at 50%');
  assert.equal(u.limitsSummary(null, NOW), null);
  const s = u.limitsSummary(limits(61.6), NOW);
  assert.equal(s.text, '5h 62% · 7d 18%');
  assert.match(s.title, /^5h resets \d{1,2}:\d{2}(am|pm) · 7d resets [A-Z][a-z]{2} \d{1,2}:\d{2}(am|pm)$/);
  assert.equal(u.limitsSummary(limits(62, 10), NOW).text, '5h 62% · 7d 18%', 'exactly 10 minutes is not stale');
  assert.equal(u.limitsSummary(limits(62, 125), NOW).text, '5h 62% · 7d 18% as of 2h ago');
  assert.equal(u.limitsSummary(limits(62, 1, { five_hour: { used_pct: 90, resets_at: ago(5) } }), NOW), null, 'a window that has reset says nothing');
  assert.equal(u.limitsSummary(limits(62, 1, { seven_day: undefined }), NOW).text, '5h 62%');
});

test('usage: the Launcher notes the 5-hour window from 85%', () => {
  const lim = (pct, resets_at = later(40)) => ({ five_hour: { used_pct: pct, resets_at }, as_of: ago(1) });
  assert.equal(u.launcherLimitNote(lim(84.4), NOW), null);
  assert.match(u.launcherLimitNote(lim(91), NOW), /^5h window at 91%, resets \d{1,2}:\d{2}(am|pm)$/);
  assert.equal(u.launcherLimitNote(lim(91, null), NOW), '5h window at 91%');
  assert.equal(u.launcherLimitNote(lim(91, ago(1)), NOW), null, 'already reset');
  assert.equal(u.launcherLimitNote(null, NOW), null);
});

test('usage: waiting items and In flight rows carry the agent’s tokens after the time', () => {
  const agents = [{ pty_id: 3, usage: subUsage }, { pty_id: 5, usage: billedUsage }];
  const w = m.waitingItems({ items: [item('a', { source: { ...item('x').source, pty_id: 3 } }), item('b')], workspace: WS, agents });
  assert.equal(w.find((x) => x.item.id === 'a').tokens, '412k tok');
  assert.equal(w.find((x) => x.item.id === 'b').tokens, '');
  const f = m.inFlight({ tiles: [tile(5, { working: true }), tile(6)], agents, times: new Map([[5, { busySince: ago(18), idleSince: null }]]), now: NOW });
  const busy = f.rows.find((r) => r.ptyId === 5);
  assert.equal(busy.meta, '18m · 1.5M tok', 'tokens only, even for billed runs, in the list');
  assert.equal(f.rows.find((r) => r.ptyId === 6).meta, '', 'no usage, no meta');
});

test('render: Work’s summary shows the limits (tooltip) past 50% only; waiting cards and rows show tokens', () => {
  const limits = { five_hour: { used_pct: 62, resets_at: later(100) }, seven_day: { used_pct: 18, resets_at: later(3000) }, as_of: ago(2) };
  const agents = [{ pty_id: 3, usage: subUsage }, { pty_id: 5, usage: billedUsage }];
  const base = fixtureCtx().snapshot;
  const html = render.work(fixtureCtx({ snapshot: { ...base, items: [approvalItem], agents, limits }, tiles: [tile(3), tile(5, { working: true })] }));
  assert.match(html, /ui-section-summary">1 waiting on you · 1 working · <span class="work-limits" title="5h resets [^"]+ · 7d resets [^"]+">5h 62% · 7d 18%<\/span>/);
  assert.match(html, /class="work-card-usage">· 412k tok</);
  assert.match(html, /1\.5M tok/);
  assert.ok(!/\$3\.10/.test(html), 'no dollars in the list');
  assert.equal(nextCount(html), 1, 'the limits add no next step');
  const low = render.work(fixtureCtx({ snapshot: { ...base, agents, limits: { ...limits, five_hour: { used_pct: 40, resets_at: later(100) } } }, tiles: [tile(5, { working: true })] }));
  assert.ok(!/work-limits|5h \d/.test(low), 'hidden under 50%');
  const onlyLimits = render.work(fixtureCtx({ snapshot: { ...base, limits } }));
  assert.match(onlyLimits, /ui-section-summary"><span class="work-limits"[^>]*>5h 62% · 7d 18%</, 'no leading separator');
});

test('render: the detail meta line has tokens after "started", dollars only for billed runs', () => {
  const sub = render.detail(fixtureCtx(), subject({ agent: { pty_id: 3, usage: subUsage } }));
  assert.match(sub, /work-detail-meta">Claude · lee · started 18m ago · 412k tokens</);
  const billed = render.detail(fixtureCtx(), subject({ agent: { pty_id: 3, usage: billedUsage } }));
  assert.match(billed, /started 18m ago · 1\.5M tokens · \$3\.10/);
  const none = render.detail(fixtureCtx(), subject({ agent: { pty_id: 3 } }));
  assert.ok(!/tokens/.test(none));
});

test('usage: the Usage tab reads Hester\'s GET /cockpit/usage shape (totals.by_source, hester user/automatic, top_tasks)', () => {
  const b = (o) => ({ tokens: {}, shown_tokens: 0, spend_usd: 0, subscription_tokens: 0, local_tokens: 0, local_ms: 0, count: 0, unpriced_tokens: 0, ...o });
  const view = u.usageView({
    range: 'today',
    limits: null,
    totals: {
      ...b({ shown_tokens: 3450000, spend_usd: 1.67, subscription_tokens: 3100000, local_tokens: 240000, count: 50 }),
      by_source: {
        claude: b({ shown_tokens: 3100000, subscription_tokens: 3100000, count: 4 }),
        pi: b({ shown_tokens: 90000, spend_usd: 1.25, count: 2 }),
        hester_cloud: b({ shown_tokens: 20000, spend_usd: 0.42, count: 14 }),
        hester_local: b({ shown_tokens: 240000, local_tokens: 240000, count: 30 }),
      },
    },
    by_day: [],
    hester: { user: { calls: 9, cloud_calls: 9, local_calls: 0, ...b({ spend_usd: 0.3 }) }, automatic: { calls: 35, cloud_calls: 5, local_calls: 30, ...b({ spend_usd: 0.12 }) }, unknown_trigger_calls: 0 },
    top_tasks: [
      { task_id: 't1', title: 'Fix the parser', ...b({ shown_tokens: 2400000, subscription_tokens: 2400000 }) },
      { task_id: 't2', title: 'Pi refactor', ...b({ shown_tokens: 90000, spend_usd: 1.25 }) },
    ],
  });
  assert.deepEqual(view.sources.map((s) => s.id), ['claude', 'pi', 'hester_cloud', 'hester_local']);
  assert.equal(view.totals.spend_usd.toFixed(2), '1.67');
  assert.equal(view.totals.subscription_tokens, 3100000);
  assert.deepEqual(view.hester.map((s) => [s.id, s.calls]), [['cloud', 14], ['local', 30], ['user', 9], ['automatic', 35]]);
  assert.equal(u.itemCostLabel(view.top[0]), '90k tok · $1.25', 'dollars first');
  assert.equal(u.itemCostLabel(view.top[1]), '2.4M tok', 'subscription work shows tokens only');
});

test('usage: today against the average', () => {
  const t = (n) => u.compare(n, 100, String);
  assert.deepEqual([t(130).delta, t(130).direction], ['30%', 'up']);
  assert.deepEqual([t(70).delta, t(70).direction], ['30%', 'down']);
  assert.equal(t(105).delta, 'about the same');
  assert.equal(t(240).delta, '2.4×');
  assert.equal(t(0).delta, 'none today');
  assert.equal(u.compare(5, 0, String).delta, 'new today');
  assert.equal(u.compare(0, 0, String).direction, 'none');
  assert.deepEqual([t(50).todayFrac, t(50).avgFrac], [0.5, 1]);
});

test('usage: a dial per window that empties as it is used; even-pace tick, reset since the reading', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const g = u.limitGauges({
    five_hour: { used_pct: 91, resets_at: '2026-09-27T13:00:00Z' },
    seven_day: { used_pct: 3, resets_at: null },
    as_of: '2026-09-27T11:58:00Z',
  }, now);
  assert.deepEqual(g.map((x) => [x.id, x.pct, x.left, x.lit, x.near]), [['five_hour', 91, 9, 1, true], ['seven_day', 3, 97, 10, false]]);
  assert.equal(g[0].elapsed, 0.8, '4 of 5 hours gone');
  assert.equal(g[1].elapsed, null);
  const reset = u.limitGauges({ five_hour: { used_pct: 60, resets_at: '2026-09-27T11:00:00Z' }, as_of: '2026-09-27T10:00:00Z' }, now);
  assert.deepEqual([reset[0].pct, reset[0].left, reset[0].lit, reset[0].resets], [0, 100, 10, 'reset since the last reading']);
  assert.equal(u.limitGauges({ five_hour: { used_pct: 100, resets_at: null }, as_of: '2026-09-27T11:58:00Z' }, now)[0].lit, 0, 'empty at the limit');
  assert.equal(u.limitsAge({ as_of: '2026-09-27T10:00:00Z' }, now), 'as of 2h ago');
  assert.deepEqual(u.limitGauges(null, now), []);
});

test('Deep next R6: the v1 hand-off dialog lives in Work’s header ⋯ menu', () => {
  const html = render.work(fixtureCtx());
  assert.match(html, /class="work-new"[\s\S]*aria-label="More" aria-haspopup="menu" aria-expanded="false"[^>]*>⋯/, 'a quiet ⋯ after New');
  assert.ok(!html.includes('Hand off to agents…'), 'the item shows only when the menu is open');
});

console.log(`cockpit-work-smoke: ${passed} tests passed`);
