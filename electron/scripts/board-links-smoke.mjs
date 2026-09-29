#!/usr/bin/env node
/**
 * Smoke test for Boards' links and Asks (plan docs/plans/2026-09-28-boards.md
 * B3 renderer half, B4):
 *
 * - lib/cardLinks.ts: parse and format `[[pg-…|Title]]` / `[[bd-…|Title]]`,
 *   file links left alone, the Desk's cards as link targets (this card out,
 *   stashed last), ranking for the `[[` picker, resolving and a missing card.
 * - lib/boardAskModel.ts: the target and anchor from a selection, the notes
 *   it sends, placing a sticky or clipboard beside it without covering
 *   anything, open/closed sizes, the leader, what a sticky and a clipboard
 *   say, follow-up threads, a Board hand-off's section with the image path.
 * - lib/hesterBoardAsks.ts: every route's method, path, workspace and body
 *   with a stub fetch; askAboutSelection end to end; the watcher (loads,
 *   refreshes on its deep:answer, polls only while pending, stops).
 * - hesterDeep: a Board id routes to /desk/boards and launches with origin
 *   'board'; cardIdForOrigin maps it back.
 *
 * Bundles the real sources with esbuild; no Hester, React or DOM needed.
 *
 * Run: node scripts/board-links-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bundle(rel, name) {
  const built = await esbuild.build({ entryPoints: [join(__dirname, rel)], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const dir = mkdtempSync(join(__dirname, `.board-smoke-${name}-`));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, built.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- stubs: fetch and window.lee ----
const calls = [];
let replyFor = null;
globalThis.window = { lee: { getApiToken: () => 'tok-1' } };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const { status, body } = (replyFor && replyFor(String(url), init)) || { status: 200, body: { success: true, data: null } };
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const links = await bundle('../src/renderer/lib/cardLinks.ts', 'cardLinks');
const model = await bundle('../src/renderer/lib/boardAskModel.ts', 'boardAskModel');
const client = await bundle('../src/renderer/lib/hesterBoardAsks.ts', 'hesterBoardAsks');
const deep = await bundle('../src/renderer/lib/hesterDeep.ts', 'hesterDeep');
const shared = await bundle('../src/shared/desk.ts', 'desk');

let passed = 0;
async function test(name, fn) {
  calls.length = 0;
  replyFor = null;
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    throw err;
  }
}

const WS = '/Users/me/My Project';
const q = (u) => new URL(u).searchParams.get('workspace');
const path = (u) => new URL(u).pathname;

// ---------------------------------------------------------------------------
// cardLinks
// ---------------------------------------------------------------------------

await test('card links: parse, ids once, file links are not card links', () => {
  const text = 'See [[pg-1a2b3c4d|Boards]] and [[bd-00ff00ff]] and [[docs/16-Desk.md|the doc]] and [[pg-1a2b3c4d|again]].';
  const got = links.parseCardLinks(text);
  assert.deepEqual(
    got.map((l) => [l.card_id, l.label]),
    [
      ['pg-1a2b3c4d', 'Boards'],
      ['bd-00ff00ff', null],
      ['pg-1a2b3c4d', 'again'],
    ],
  );
  assert.equal(text.slice(got[0].from, got[0].to), '[[pg-1a2b3c4d|Boards]]');
  assert.deepEqual(links.cardLinkIds(text), ['pg-1a2b3c4d', 'bd-00ff00ff']);
  assert.equal(links.isCardLinkId('bd-00ff00ff'), true);
  assert.equal(links.isCardLinkId('exp-00ff00ff'), false);
  assert.equal(links.isCardLinkId('pg-XYZ'), false);
  // Parsing twice (the global regex's lastIndex) gives the same answer.
  assert.equal(links.parseCardLinks(text).length, 3);
});

await test('card links: format keeps the label to one safe line', () => {
  assert.equal(links.formatCardLink('bd-00ff00ff', 'Layouts'), '[[bd-00ff00ff|Layouts]]');
  assert.equal(links.formatCardLink('pg-1a2b3c4d', ' A [draft] | v2\nnext '), '[[pg-1a2b3c4d|A draft v2 next]]');
  assert.equal(links.formatCardLink('pg-1a2b3c4d', '  '), '[[pg-1a2b3c4d]]');
  // What it formats parses back.
  const back = links.parseCardLinks(links.formatCardLink('pg-1a2b3c4d', 'A ] tricky | one'))[0];
  assert.deepEqual([back.card_id, back.label], ['pg-1a2b3c4d', 'A tricky one']);
});

const desk = {
  areas: [
    { id: 'area-00000001', name: 'Desk Items', drawer_id: null },
    { id: 'area-00000002', name: 'Old', drawer_id: 'stashed' },
  ],
  cards: [
    { id: 'pg-00000001', kind: 'page', title: 'Boards', area_id: 'area-00000001', last_touched_at: '2026-09-28T10:00:00Z', updated_at: '2026-09-28T10:00:00Z' },
    { id: 'bd-00000002', kind: 'board', title: 'Layout ideas', area_id: 'area-00000001', last_touched_at: '2026-09-28T12:00:00Z', updated_at: '2026-09-28T12:00:00Z' },
    { id: 'pg-00000003', kind: 'page', title: 'Old board notes', area_id: 'area-00000002', last_touched_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z' },
    { id: 'pg-00000004', kind: 'page', title: 'Goals', area_id: null, last_touched_at: null, updated_at: '2026-09-01T00:00:00Z' },
  ],
};

await test('linkable cards: this card out, on the Desk by last touched, stashed last', () => {
  const cards = links.linkableCards(desk, 'pg-00000001');
  assert.deepEqual(
    cards.map((c) => c.id),
    ['bd-00000002', 'pg-00000004', 'pg-00000003'],
  );
  assert.equal(cards[0].area_name, 'Desk Items');
  assert.equal(cards[2].stashed, true);
  assert.equal(links.cardLinkSub(cards[0]), 'Board · Desk Items');
  assert.equal(links.cardLinkSub(cards[1]), 'Page');
  assert.equal(links.cardLinkSub(cards[2]), 'Page · Old (stashed)');
  assert.deepEqual(links.linkableCards(null), []);
});

await test('rank cards: title starts, then word starts, then inside; empty keeps order', () => {
  const cards = links.linkableCards(desk);
  assert.deepEqual(
    links.rankCards('', cards).map((c) => c.id),
    cards.map((c) => c.id),
  );
  assert.deepEqual(
    links.rankCards('bo', cards).map((c) => c.title),
    ['Boards', 'Old board notes'],
  );
  assert.deepEqual(
    links.rankCards('ideas', cards).map((c) => c.id),
    ['bd-00000002'],
  );
  assert.deepEqual(links.rankCards('zzz', cards), []);
  assert.equal(links.rankCards('', cards, 2).length, 2);
});

await test('resolve: label as written, else the title; a missing card says so', () => {
  const cards = links.linkableCards(desk);
  const card = links.findCard('bd-00000002', cards);
  assert.equal(links.cardLinkDisplay({ card_id: 'bd-00000002', label: 'the layouts' }, card), 'the layouts');
  assert.equal(links.cardLinkDisplay({ card_id: 'bd-00000002', label: null }, card), 'Layout ideas');
  assert.equal(links.cardLinkTitle({ card_id: 'bd-00000002' }, card), 'Layout ideas · Board · Desk Items');
  assert.equal(links.findCard('bd-deadbeef', cards), null);
  assert.equal(links.cardLinkDisplay({ card_id: 'bd-deadbeef', label: null }, null), 'Board');
  assert.match(links.cardLinkTitle({ card_id: 'bd-deadbeef' }, null), /Not on the Desk/);
  assert.equal(typeof links.MISSING_CARD_MESSAGE, 'string');
});

// ---------------------------------------------------------------------------
// boardAskModel
// ---------------------------------------------------------------------------

const img = (id, x, y, w, h, z = 1) => ({ id, kind: 'image', asset: 'img-00000001.png', x, y, w, h, z });
const note = (id, x, y, text, pin) => ({ id, kind: 'note', text, x, y, w: 120, h: 40, z: 2, ...(pin ? { pin } : {}) });

await test('selection: target from items or the marquee; stickies never part of it', () => {
  const items = [img('it-a', 0, 0, 200, 100), img('it-b', 300, 50, 100, 100), { id: 'it-s', kind: 'ask', answer_id: 'ans-1', target: { item_ids: [], rect: { x: 0, y: 0, w: 1, h: 1 } }, x: 500, y: 0, w: 200, h: 132, z: 3 }];
  assert.deepEqual(model.selectionTarget(items, ['it-a', 'it-b', 'it-s']), { item_ids: ['it-a', 'it-b'], rect: { x: 0, y: 0, w: 400, h: 150 } });
  assert.deepEqual(model.selectionTarget(items, ['it-a'], { x: 10.4, y: 10.6, w: 50, h: 20 }).rect, { x: 10, y: 11, w: 50, h: 20 });
  assert.equal(model.selectionTarget(items, []), null);
  // A marquee over bare canvas is still something to ask about.
  assert.deepEqual(model.selectionTarget(items, [], { x: 1, y: 2, w: 3, h: 4 }), { item_ids: [], rect: { x: 1, y: 2, w: 3, h: 4 } });
});

await test('selection notes: selected and pinned to a selected item, top to bottom, once, no blanks', () => {
  const items = [
    img('it-a', 0, 0, 200, 100),
    note('it-n1', 0, 200, 'Lower note'),
    note('it-n2', 0, 120, 'Pinned to the image', { item_id: 'it-a', u: 0.5, v: 0.5 }),
    note('it-n3', 0, 300, '   '),
    note('it-n4', 0, 400, 'Not selected'),
    note('it-n5', 0, 500, 'Lower note'),
  ];
  assert.deepEqual(model.selectionNotes(items, ['it-a', 'it-n1', 'it-n3', 'it-n5']), ['Pinned to the image', 'Lower note']);
  const anchor = model.boardAnchor({ item_ids: ['it-a'], rect: { x: 0, y: 0, w: 200, h: 100 } }, 'sel-0badf00d.png', ['n']);
  assert.deepEqual(anchor, { kind: 'board', item_ids: ['it-a'], rect: { x: 0, y: 0, w: 200, h: 100 }, snapshot: 'assets/sel-0badf00d.png', notes: ['n'] });
  assert.equal(model.snapshotPath('assets/sel-0badf00d.png'), 'assets/sel-0badf00d.png');
});

await test('placing: right of the target, sliding past what is there, then other sides', () => {
  const size = model.STICKY_SIZE.collapsed;
  const target = { x: 0, y: 0, w: 200, h: 100 };
  const gap = model.PLACE_GAP;
  // Empty board: right, top-aligned.
  assert.deepEqual(model.placeBeside(target, size, []), { x: 200 + gap, y: 0 });
  // Something to the right at the top: it slides down past it (or picks another side), never overlapping.
  const blocker = img('it-x', 220, -20, 300, 120);
  const at = model.placeBeside(target, size, [blocker]);
  const placed = { ...at, ...size };
  assert.equal(model.overlaps(placed, blocker, 0), false);
  assert.equal(model.overlaps(placed, target, 0), false);
  // Boxed in on every side nearby: still somewhere free.
  const many = [];
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) if (i || j) many.push(img(`it-${i}-${j}`, i * 260, j * 160, 200, 100));
  const far = { ...model.placeBeside(target, size, many), ...size };
  assert.ok(!many.some((m) => model.overlaps(far, m, 0)));
  // `ignore`: the card itself doesn't block its own spot.
  assert.deepEqual(model.placeBeside(target, size, [{ id: 'self', x: 224, y: 0, w: 200, h: 132 }], ['self']), { x: 224, y: 0 });
});

await test('new sticky and clipboard: collapsed, beside, on top; toggle keeps the corner', () => {
  const items = [img('it-a', 0, 0, 200, 100, 4)];
  const target = { item_ids: ['it-a'], rect: { x: 0, y: 0, w: 200, h: 100 } };
  const s = model.newAskItem('ans-1', target, items, 'it-00000001');
  assert.deepEqual(s, { id: 'it-00000001', kind: 'ask', answer_id: 'ans-1', target, open: false, x: 224, y: 0, w: 200, h: 132, z: 5 });
  const h = model.newHandoffItem('ans-2', target, [...items, s], 'it-00000002');
  assert.equal(h.kind, 'handoff');
  assert.equal(h.z, 6);
  assert.equal(model.overlaps(h, s, 0), false);
  const opened = model.toggleCard(s, [...items, s, h]);
  assert.deepEqual([opened.open, opened.x, opened.y, opened.w, opened.h, opened.z], [true, 224, 0, 340, 320, 7]);
  const closed = model.toggleCard(opened, [...items, opened, h]);
  assert.deepEqual([closed.open, closed.w, closed.h, closed.z], [false, 200, 132, 7]);
  assert.match(model.newItemId(() => 0.5), /^it-8{8}$/);
  assert.deepEqual([...model.answerIdsOnBoard([...items, s, h])], ['ans-1', 'ans-2']);
});

await test('leader: nearest edges; none when touching', () => {
  assert.deepEqual(model.leaderLine({ x: 224, y: 0, w: 200, h: 132 }, { x: 0, y: 0, w: 200, h: 100 }), [224, 66, 200, 66]);
  assert.deepEqual(model.leaderLine({ x: 0, y: 200, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 100 }), [50, 200, 50, 100]);
  assert.equal(model.leaderLine({ x: 50, y: 50, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 }), null);
});

const row = (over) => ({ id: 'ans-1', question: 'Why is this cramped?', status: 'done', surface: 'deep-ask', anchor: { kind: 'board', item_ids: [], rect: { x: 0, y: 0, w: 1, h: 1 }, snapshot: 'assets/sel-00000001.png', notes: ['Header too tall'] }, asked_at: '2026-09-28T10:00:00Z', ...over });

await test('sticky words: asking, new, read, error (retry), missing', () => {
  assert.deepEqual(
    (({ state, status, canFollowUp }) => ({ state, status, canFollowUp }))(model.stickyText(row({ status: 'running' }))),
    { state: 'asking', status: 'Asking…', canFollowUp: false },
  );
  const fresh = model.stickyText(row({ answer: ' The header takes a third. ' }));
  assert.deepEqual([fresh.state, fresh.status, fresh.answer, fresh.canFollowUp], ['new', 'New answer', 'The header takes a third.', true]);
  assert.equal(model.stickyText(row({ answer: 'x', read_at: '2026-09-28T11:00:00Z' })).status, 'Answered');
  const err = model.stickyText(row({ status: 'error', error: 'No model that reads images is set up' }));
  assert.deepEqual([err.state, err.error, err.canRetry], ['error', 'No model that reads images is set up', true]);
  assert.match(model.stickyText(row({ status: 'interrupted' })).error, /Interrupted/);
  assert.equal(model.stickyText(null).state, 'missing');
});

await test('follow-ups: the thread under an Ask, oldest first, nested too', () => {
  const rows = [
    row({ id: 'ans-3', follow_up_of: 'ans-2', asked_at: '2026-09-28T10:03:00Z' }),
    row({ id: 'ans-2', follow_up_of: 'ans-1', asked_at: '2026-09-28T10:02:00Z' }),
    row({ id: 'ans-9', follow_up_of: 'ans-8', asked_at: '2026-09-28T10:01:00Z' }),
    row({ id: 'ans-1' }),
  ];
  assert.deepEqual(model.followUpsOf('ans-1', rows).map((r) => r.id), ['ans-2', 'ans-3']);
});

await test('clipboard words: kind and state, the line, the result, Open in Work', () => {
  const h = (state, over = {}) => row({ id: 'ans-5', kind: 'handoff', surface: 'deep-handoff', status: state === 'done' ? 'done' : 'running', handoff: { kind: 'spike', provider: 'claude', brief: 'b', task_id: 'task-1', state }, ...over });
  const run = model.clipboardText(h('running'));
  assert.deepEqual([run.state, run.label, run.line, run.taskId], ['running', 'Spike · working', 'Why is this cramped?', 'task-1']);
  assert.equal(model.clipboardText(h('launching')).state, 'starting');
  assert.equal(model.clipboardText(h('waiting')).label, 'Spike · waiting on you');
  const done = model.clipboardText(h('review', { answer: '# Findings\nThe grid wraps at 900px.' }));
  assert.deepEqual([done.state, done.line, done.result], ['review', 'The grid wraps at 900px.', '# Findings\nThe grid wraps at 900px.']);
  // No question and no result: the first note.
  assert.equal(model.clipboardText(h('running', { question: '' })).line, 'Header too tall');
  const failed = model.clipboardText(h('error', { status: 'error', error: 'discarded' }));
  assert.deepEqual([failed.state, failed.error], ['error', 'discarded']);
  assert.equal(model.clipboardText(null).state, 'missing');
});

await test('hand-off section: what you wrote, the notes, the image path', () => {
  const anchor = model.boardAnchor({ item_ids: ['it-a'], rect: { x: 0, y: 0, w: 1, h: 1 } }, 'sel-0badf00d.png', ['Header too tall', 'Two\nlines']);
  const file = model.snapshotFile('/Users/me/proj/', 'bd-00000002', anchor.snapshot);
  assert.equal(file, '/Users/me/proj/.hester/desk/boards/bd-00000002/assets/sel-0badf00d.png');
  assert.equal(
    model.boardHandoffSection(anchor, file, 'Try a denser header'),
    `Try a denser header\n\nNotes on the selection:\n- Header too tall\n- Two lines\n\nThe selection as an image: ${file}`,
  );
  assert.equal(model.boardHandoffSection({ ...anchor, notes: [] }, file), `The selection as an image: ${file}`);
});

// ---------------------------------------------------------------------------
// hesterBoardAsks
// ---------------------------------------------------------------------------

const BD = 'bd-00000002';
const anchor = model.boardAnchor({ item_ids: ['it-a'], rect: { x: 0, y: 0, w: 200, h: 100 } }, 'sel-0badf00d.png', []);

await test('client: routes, methods, workspace, token, envelope', async () => {
  replyFor = () => ({ status: 200, body: { success: true, data: [row({})] } });
  const list = await client.listBoardAnswers(WS, BD);
  assert.equal(list.ok, true);
  assert.equal(list.data.length, 1);
  await client.askBoard(WS, BD, { question: 'Why?', anchor, follow_up_of: 'ans-1' });
  await client.createBoardHandoff(WS, BD, { kind: 'research', provider: 'claude', brief: 'b', anchor });
  await client.patchBoardAnswer(WS, BD, 'ans-1', { read: true });
  await client.retryBoardAnswer(WS, BD, 'ans-1');
  assert.deepEqual(
    calls.map((c) => [c.method, path(c.url)]),
    [
      ['GET', `/desk/boards/${BD}/answers`],
      ['POST', `/desk/boards/${BD}/asks`],
      ['POST', `/desk/boards/${BD}/handoffs`],
      ['PATCH', `/desk/boards/${BD}/answers/ans-1`],
      ['POST', `/desk/boards/${BD}/answers/ans-1/retry`],
    ],
  );
  for (const c of calls) {
    assert.equal(q(c.url), WS);
    assert.equal(c.headers.Authorization, 'Bearer tok-1');
  }
  assert.deepEqual(calls[1].body, { question: 'Why?', anchor, follow_up_of: 'ans-1' });
  assert.deepEqual(calls[2].body, { kind: 'research', provider: 'claude', brief: 'b', anchor });
  assert.deepEqual(calls[4].body, {});
});

await test('client: errors keep the status and message; offline says so', async () => {
  replyFor = () => ({ status: 400, body: { success: false, error: 'No model that reads images is set up' } });
  const r = await client.askBoard(WS, BD, { question: 'Why?', anchor });
  assert.deepEqual([r.ok, r.status, r.error], [false, 400, 'No model that reads images is set up']);
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const off = await client.listBoardAnswers(WS, BD);
    assert.deepEqual(off, { ok: false, error: 'Hester offline' });
  } finally {
    globalThis.fetch = saved;
  }
});

await test('askAboutSelection: anchor with notes, POST /asks, a sticky beside the selection', async () => {
  replyFor = (u, init) => (init.method === 'POST' ? { status: 202, body: { success: true, data: row({ id: 'ans-7', status: 'queued' }) } } : null);
  const items = [img('it-a', 0, 0, 200, 100), note('it-n', 0, 120, 'Header too tall', { item_id: 'it-a', u: 0.1, v: 0.1 })];
  const r = await client.askAboutSelection(WS, BD, { question: '  Why is this cramped? ', items, ids: ['it-a'], snapshot: 'sel-0badf00d.png' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].body, {
    question: 'Why is this cramped?',
    anchor: { kind: 'board', item_ids: ['it-a'], rect: { x: 0, y: 0, w: 200, h: 100 }, snapshot: 'assets/sel-0badf00d.png', notes: ['Header too tall'] },
  });
  assert.equal(r.data.item.kind, 'ask');
  assert.equal(r.data.item.answer_id, 'ans-7');
  assert.ok(!items.some((it) => model.overlaps(r.data.item, it, 0)));
  calls.length = 0;
  assert.equal((await client.askAboutSelection(WS, BD, { question: ' ', items, ids: ['it-a'], snapshot: 's' })).ok, false);
  assert.equal((await client.askAboutSelection(WS, BD, { question: 'Why?', items, ids: [], snapshot: 's' })).ok, false);
  assert.equal(calls.length, 0);
});

await test('watcher: loads, refreshes on its event, polls only while pending, stops', async () => {
  let rows = [row({ status: 'running' })];
  replyFor = () => ({ status: 200, body: { success: true, data: rows } });
  const timers = [];
  const cleared = [];
  let listener = null;
  let unsubscribed = false;
  const seen = [];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const w = client.watchBoardAnswers(WS, BD, (a) => seen.push(a.map((x) => x.status).join(',')), {
    subscribe: (cb) => ((listener = cb), () => (unsubscribed = true)),
    pollMs: 5,
    setInterval: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearInterval: (t) => cleared.push(t),
  });
  await tick();
  assert.deepEqual(seen, ['running']);
  assert.equal(timers.length, 1, 'polls while an Ask is pending');
  // Another card's event is ignored; this Board's refreshes.
  listener({ workspace: WS, exploration_id: 'pg-00000001', card_id: 'pg-00000001', answer_id: 'x', status: 'done' });
  await tick();
  assert.equal(seen.length, 1);
  rows = [row({ status: 'done', answer: 'a' })];
  listener({ workspace: WS, exploration_id: BD, card_id: BD, answer_id: 'ans-1', status: 'done' });
  await tick();
  assert.deepEqual(seen, ['running', 'done']);
  assert.deepEqual(cleared, [1], 'nothing pending: polling stops');
  // A poll tick after a new pending row starts it again.
  rows = [row({ status: 'queued' })];
  await w.refresh();
  assert.equal(timers.length, 2);
  w.stop();
  assert.equal(unsubscribed, true);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(client.answersPending([row({ status: 'done', kind: 'handoff', handoff: { kind: 'spike', provider: 'claude', brief: '', task_id: null, state: 'waiting' } })]), true);
  assert.equal(client.answersPending([row({ status: 'running', dismissed_at: 'x' })]), false);
  assert.deepEqual(client.upsertAnswer([row({ id: 'a' }), row({ id: 'b' })], row({ id: 'b', status: 'error' })).map((r) => r.status), ['done', 'error']);
});

await test('hesterDeep and desk: a Board id routes to /desk/boards and launches with origin board', () => {
  assert.equal(deep.pageRoute(BD, '/handoffs'), `/desk/boards/${BD}/handoffs`);
  assert.equal(deep.pageRoute('pg-1a2b3c4d', '/page'), '/desk/pages/pg-1a2b3c4d/page');
  const req = client.boardHandoffLaunchRequest({ workspace: WS, kind: 'research', provider: 'claude', brief: 'b', boardId: BD, answerId: 'ans-5', title: 'Layouts' });
  assert.deepEqual(req.origin, { kind: 'board', ref: `${BD}#ans-5` });
  assert.equal(deep.handoffFromLine('Layouts', BD), `From the Board 'Layouts' (${BD})`);
  assert.equal(shared.cardIdForOrigin({ kind: 'board', ref: `${BD}#ans-5` }), BD);
  assert.equal(shared.cardIdForOrigin({ kind: 'board', ref: 'pg-1a2b3c4d#ans-5' }), null);
  assert.equal(shared.cardIdForOrigin({ kind: 'page', ref: 'pg-1a2b3c4d#ans-5' }), 'pg-1a2b3c4d');
});

console.log(`\n${passed} passed`);
