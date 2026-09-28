#!/usr/bin/env node
/**
 * Smoke test for Visualize on a Board (plan docs/plans/2026-09-28-boards.md
 * §5b, B6 renderer half):
 *
 * - lib/boardVisualModel.ts: a new frame beside the selection (covering
 *   nothing), open and closed sizes, what it says (queued, running, error
 *   with Retry, done with what it made), what to place for each kind of
 *   result, when placing is due, finding a result already placed (by
 *   result_item_id, asset, an asset saved for the answer, a note's text),
 *   result sizes (capped) and placement beside the frame, the Mermaid
 *   fence, SVG size, the sized SVG and the raster size.
 * - lib/hesterBoardAsks.ts: visualize() posts to /visualize with the
 *   workspace, token and body; errors keep their status.
 * - The action row's `v`, frames kept out of a selection's target, and a
 *   frame drawn in preview.png.
 *
 * Bundles the real sources with esbuild; no Hester, React or DOM needed.
 *
 * Run: node scripts/board-visual-smoke.mjs
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

const model = await bundle('../src/renderer/lib/boardVisualModel.ts', 'boardVisualModel');
const asks = await bundle('../src/renderer/lib/boardAskModel.ts', 'boardAskModel');
const client = await bundle('../src/renderer/lib/hesterBoardAsks.ts', 'hesterBoardAsks');
const deep = await bundle('../src/renderer/lib/deepModel.ts', 'deepModel');
const render = await bundle('../src/renderer/lib/boardRender.ts', 'boardRender');

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
const BD = 'bd-00000002';
const q = (u) => new URL(u).searchParams.get('workspace');
const path = (u) => new URL(u).pathname;
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const IMG = { id: 'it-0000img1', kind: 'image', asset: 'img-0000abcd.png', x: 0, y: 0, w: 400, h: 300, z: 1 };
const NOTE = { id: 'it-0000note', kind: 'note', text: 'Login', x: 424, y: 0, w: 220, h: 72, z: 2 };
const TARGET = { item_ids: [IMG.id], rect: { x: 0, y: 0, w: 400, h: 300 } };

const row = (over) => ({
  id: 'ans-1',
  anchor: { kind: 'board', item_ids: [IMG.id], rect: TARGET.rect, snapshot: 'assets/sel-0badf00d.png', notes: [] },
  question: 'The login flow as a diagram',
  status: 'done',
  surface: 'deep-visualize',
  kind: 'visualize',
  visual: null,
  asked_at: '2026-09-28T10:00:00Z',
  ...over,
});

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

await test('frame: beside the selection, covering nothing, on top; open and closed sizes', () => {
  const items = [IMG, NOTE];
  const f = model.newVisualItem('ans-1', TARGET, items, 'it-0000vis1');
  assert.equal(f.kind, 'visual');
  assert.equal(f.answer_id, 'ans-1');
  assert.equal(f.result_item_id, null);
  assert.equal(f.open, false);
  assert.deepEqual([f.w, f.h], [model.FRAME_SIZE.collapsed.w, model.FRAME_SIZE.collapsed.h]);
  assert.equal(f.z, 3);
  for (const it of items) assert.ok(!overlap(f, it), `clear of ${it.id}`);
  const open = model.toggleVisual(f, [...items, f]);
  assert.deepEqual([open.open, open.w, open.h, open.x, open.y], [true, model.FRAME_SIZE.open.w, model.FRAME_SIZE.open.h, f.x, f.y]);
  const shut = model.toggleVisual(open, [...items, open], false);
  assert.deepEqual([shut.open, shut.w, shut.h], [false, model.FRAME_SIZE.collapsed.w, model.FRAME_SIZE.collapsed.h]);
  const low = model.toggleVisual({ ...f, z: 0 }, [...items, f], true);
  assert.equal(low.z, 4, 'opened, it comes to the top');
});

await test('frame: what it says while queued, running, failed, done', () => {
  assert.deepEqual(model.frameText(null), { state: 'missing', brief: '', status: 'Not found', line: null, error: null, canRetry: false });
  const queued = model.frameText(row({ status: 'queued' }));
  assert.deepEqual([queued.state, queued.status, queued.brief, queued.canRetry], ['queued', 'Waiting to start…', 'The login flow as a diagram', false]);
  assert.equal(model.frameText(row({ status: 'running' })).status, 'Making it…');
  assert.equal(model.frameText(row({ status: 'queued', question: 'Login flow', brief: 'Login flow\nas a sequence diagram' })).brief, 'Login flow\nas a sequence diagram', 'the whole brief when Hester keeps it');
  const err = model.frameText(row({ status: 'error', error: 'No model for images' }));
  assert.deepEqual([err.state, err.status, err.error, err.canRetry], ['error', 'Couldn’t make it', 'No model for images', true]);
  assert.equal(model.frameText(row({ status: 'interrupted' })).error, 'Interrupted before it finished.');
  const empty = model.frameText(row({ status: 'done', visual: null }));
  assert.deepEqual([empty.state, empty.canRetry], ['error', true], 'done without a result is an error you can retry');
  const made = model.frameText(row({ visual: { type: 'mermaid', dsl: 'graph TD; A-->B', title: 'Login flow' } }));
  assert.deepEqual([made.state, made.status, made.line], ['new', 'Diagram', 'Made a diagram: Login flow']);
  assert.equal(model.frameText(row({ read_at: 'x', visual: { type: 'image', asset: 'img-00000001.png', title: '' } })).line, 'Made an image');
  assert.equal(model.frameText(row({ read_at: 'x', visual: { type: 'markdown', text: '| a |', title: 'Options' } })).state, 'done');
  assert.equal(model.madeLine({ type: 'markdown', text: 'x', title: 'Options' }), 'Made a note: Options');
  assert.equal(model.frameLabel(row({ status: 'running' })), 'The login flow as a diagram');
  assert.equal(model.frameLabel(row({ visual: { type: 'image', asset: 'img-00000001.png', title: 'Sketch' } })), 'Made an image: Sketch');
  assert.equal(model.frameLabel(null), 'Visualize');
});

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

await test('result: what to place for each kind; empty results place nothing', () => {
  assert.deepEqual(model.whatToPlace({ type: 'image', asset: 'img-00000001.png', title: 't' }), { kind: 'image', asset: 'img-00000001.png' });
  assert.deepEqual(model.whatToPlace({ type: 'mermaid', dsl: '```mermaid\ngraph TD\n  A-->B\n```', title: 't' }), { kind: 'mermaid', dsl: 'graph TD\n  A-->B' });
  assert.deepEqual(model.whatToPlace({ type: 'markdown', text: '  | a | b |\n  ', title: 't' }), { kind: 'note', text: '| a | b |' });
  assert.equal(model.whatToPlace({ type: 'image', asset: '', title: 't' }), null);
  assert.equal(model.whatToPlace({ type: 'mermaid', dsl: '```\n```', title: 't' }), null);
  assert.equal(model.whatToPlace({ type: 'markdown', text: ' ', title: 't' }), null);
  assert.equal(model.mermaidSource('graph LR; A-->B'), 'graph LR; A-->B');
  assert.equal(model.mermaidSource('```\nsequenceDiagram\nA->>B: hi\n```'), 'sequenceDiagram\nA->>B: hi');
});

await test('result: due once the row is done with a result and nothing is placed', () => {
  const v = { type: 'image', asset: 'img-00000001.png', title: 't' };
  assert.equal(model.needsResult({ result_item_id: null }, row({ visual: v })), true);
  assert.equal(model.needsResult({}, row({ visual: v })), true);
  assert.equal(model.needsResult({ result_item_id: 'it-00000001' }, row({ visual: v })), false);
  assert.equal(model.needsResult({ result_item_id: null }, row({ status: 'running', visual: null })), false);
  assert.equal(model.needsResult({ result_item_id: null }, row({ visual: null })), false);
  assert.equal(model.needsResult({ result_item_id: null }, null), false);
});

await test('result: already placed? by result_item_id, the asset, an asset saved for the answer, a note’s text', () => {
  const frame = { id: 'it-0000vis1', result_item_id: null };
  const img = { type: 'image', asset: 'img-00000001.png', title: 't' };
  const dia = { type: 'mermaid', dsl: 'graph TD; A-->B', title: 't' };
  const md = { type: 'markdown', text: '| a |', title: 't' };
  const placedImg = { ...IMG, id: 'it-0000res1', asset: 'img-00000001.png' };
  const placedDia = { ...IMG, id: 'it-0000res2', asset: 'img-000000d1.png' };
  const placedNote = { ...NOTE, id: 'it-0000res3', text: '| a |\n' };
  assert.equal(model.findPlacedResult({ ...frame, result_item_id: 'it-0000res1' }, [placedImg], img), 'it-0000res1');
  assert.equal(model.findPlacedResult({ ...frame, result_item_id: 'it-gone0000' }, [IMG], img), null, 'a result that was deleted is not found');
  assert.equal(model.findPlacedResult(frame, [IMG, placedImg], img), 'it-0000res1');
  assert.equal(model.findPlacedResult(frame, [IMG, placedDia], dia), null, 'no saved asset: not placed');
  assert.equal(model.findPlacedResult(frame, [IMG, placedDia], dia, ['img-000000d1.png']), 'it-0000res2');
  assert.equal(model.findPlacedResult(frame, [IMG, NOTE, placedNote], md), 'it-0000res3');
  assert.equal(model.findPlacedResult(frame, [IMG, NOTE], md), null);

  const assets = [
    { name: 'img-000000d1.png', mime: 'image/png', bytes: 10, created_at: 'x', source: { kind: 'answer', card_id: BD, answer_id: 'ans-1' } },
    { name: 'img-000000d2.png', mime: 'image/png', bytes: 10, created_at: 'x', source: { kind: 'answer', card_id: BD, answer_id: 'ans-2' } },
    { name: 'img-000000d3.png', mime: 'image/png', bytes: 10, created_at: 'x', source: { kind: 'file', path: '/a.png' } },
    { name: 'img-000000d4.png', mime: 'image/png', bytes: 10, created_at: 'x' },
  ];
  assert.deepEqual(model.assetsFromAnswer(assets, 'ans-1'), ['img-000000d1.png']);
  assert.deepEqual(model.assetsFromAnswer(assets, 'ans-9'), []);
});

await test('result: sizes (an image capped, a diagram at its density, a note by its text) and placed beside the frame', () => {
  assert.deepEqual(model.resultImageSize({ w: 1024, h: 1024 }), { w: model.RESULT_MAX, h: model.RESULT_MAX });
  assert.deepEqual(model.resultImageSize({ w: 600, h: 300 }, 2), { w: 300, h: 150 });
  assert.deepEqual(model.resultImageSize({ w: 4000, h: 1000 }, 2), { w: 640, h: 160 });
  assert.deepEqual(model.resultNoteSize('one line'), { w: model.RESULT_NOTE_W, h: 72 });
  assert.equal(model.resultNoteSize(Array(60).fill('a row of the table').join('\n')).h, model.RESULT_NOTE_MAX_H);
  const mid = model.resultNoteSize(Array(6).fill('x'.repeat(80)).join('\n')).h;
  assert.ok(mid > 72 && mid < model.RESULT_NOTE_MAX_H);

  const frame = model.newVisualItem('ans-1', TARGET, [IMG, NOTE], 'it-0000vis1');
  const items = [IMG, NOTE, frame];
  const im = model.resultImage(frame, items, 'img-00000001.png', { w: 1024, h: 768 }, 1, 'it-0000res1');
  assert.deepEqual([im.kind, im.asset, im.w, im.h, im.z], ['image', 'img-00000001.png', 640, 480, 4]);
  for (const it of items) assert.ok(!overlap(im, it), `the image clear of ${it.id}`);
  const n = model.resultNote(frame, items, '| a | b |', 'it-0000res2');
  assert.deepEqual([n.kind, n.text, n.w], ['note', '| a | b |', model.RESULT_NOTE_W]);
  for (const it of items) assert.ok(!overlap(n, it), `the note clear of ${it.id}`);
});

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

await test('mermaid: the SVG’s size, a sized copy, the raster size', () => {
  const svg = '<svg aria-roledescription="flowchart-v2" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 420.5px;" viewBox="-8 -8 420.5 210"><g><rect stroke-width="2" width="10" height="10"/></g></svg>';
  assert.deepEqual(model.svgSize(svg), { w: 420.5, h: 210 });
  assert.deepEqual(model.svgSize('<svg width="300px" height="120"></svg>'), { w: 300, h: 120 });
  assert.equal(model.svgSize('<svg width="100%"></svg>'), null);
  assert.equal(model.svgSize('not svg'), null);
  const sized = model.sizedSvg(svg, { w: 420.5, h: 210 });
  const root = sized.slice(0, sized.indexOf('>') + 1);
  assert.ok(root.includes('width="421"') && root.includes('height="210"'), root);
  assert.ok(!root.includes('100%') && !root.includes('max-width'), root);
  assert.equal((root.match(/xmlns=/g) ?? []).length, 1);
  assert.ok(sized.includes('<rect stroke-width="2" width="10" height="10"/>'), 'the inside is untouched');
  assert.ok(model.sizedSvg('<svg viewBox="0 0 10 10"></svg>', { w: 10, h: 10 }).includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.deepEqual(model.rasterSize({ w: 400, h: 200 }), { w: 800, h: 400, scale: 2 });
  const big = model.rasterSize({ w: 2400, h: 600 });
  assert.deepEqual([big.w, big.h, big.scale], [2400, 600, 1]);
  assert.equal(model.MERMAID_CONFIG.htmlLabels, false, 'plain SVG labels, so it rasterises');
  assert.equal(model.MERMAID_CONFIG.securityLevel, 'strict');
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

await test('client: visualize posts the brief and anchor to /visualize', async () => {
  const anchor = asks.boardAnchor(TARGET, 'sel-0badf00d.png', ['Login']);
  replyFor = () => ({ status: 202, body: { success: true, data: row({ status: 'queued' }) } });
  const r = await client.visualize(WS, BD, { brief: 'The login flow', anchor });
  assert.equal(r.ok, true);
  assert.equal(r.data.kind, 'visualize');
  assert.deepEqual([calls[0].method, path(calls[0].url)], ['POST', `/desk/boards/${BD}/visualize`]);
  assert.equal(q(calls[0].url), WS);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(calls[0].body, { brief: 'The login flow', anchor });
  replyFor = () => ({ status: 404, body: { success: false, error: 'Not found' } });
  const old = await client.visualize(WS, BD, { brief: 'x', anchor });
  assert.deepEqual([old.ok, old.status], [false, 404]);
  assert.equal(client.answersPending([row({ status: 'running' })]), true, 'a Visualize being made keeps the poll on');
});

// ---------------------------------------------------------------------------
// The row, the selection, the preview
// ---------------------------------------------------------------------------

await test('row: v is Visualize; frames stay out of a selection and count as on the Board', () => {
  assert.deepEqual(deep.deepRowKey('v'), { kind: 'action', action: 'visualize' });
  assert.deepEqual(deep.deepRowKey('V'), { kind: 'action', action: 'visualize' });
  assert.equal(deep.deepRowKey('v', { meta: true }), null, '⌘V pastes');
  const frame = model.newVisualItem('ans-1', TARGET, [IMG], 'it-0000vis1');
  const t = asks.selectionTarget([IMG, frame], [IMG.id, frame.id]);
  assert.deepEqual(t.item_ids, [IMG.id]);
  assert.equal(asks.selectionTarget([frame], [frame.id]), null);
  assert.equal(asks.isAnswerCard(frame), true);
  assert.equal(asks.isAnswerCard(IMG), false);
  assert.ok(asks.answerIdsOnBoard([frame]).has('ans-1'));
});

await test('preview: a frame draws its edge, its mat and its label', () => {
  const log = [];
  const ctx = new Proxy(
    {},
    {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'measureText') return (s) => ({ width: s.length * 7 });
        return (...args) => log.push([k, ...args]);
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    },
  );
  const frame = model.newVisualItem('ans-1', TARGET, [IMG], 'it-0000vis1');
  render.drawBoard(ctx, [frame], { x: 0, y: 0, w: 1000, h: 400 }, new Map(), 1, { answerLabel: () => 'Made a diagram' });
  assert.ok(log.some((l) => l[0] === 'rect'), 'the mat');
  assert.ok(log.some((l) => l[0] === 'fillText' && String(l[1]).includes('Made a diagram')));
  const bare = [];
  render.drawBoard(
    new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? (s) => ({ width: s.length * 7 }) : (...a) => bare.push([k, ...a])), set: (t, k, v) => ((t[k] = v), true) }),
    [frame],
    { x: 0, y: 0, w: 1000, h: 400 },
    new Map(),
    1,
  );
  assert.ok(bare.some((l) => l[0] === 'fillText' && l[1] === 'Visualize'), 'no label: "Visualize"');
});

console.log(`\n${passed} passed`);
