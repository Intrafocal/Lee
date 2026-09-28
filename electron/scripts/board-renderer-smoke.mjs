#!/usr/bin/env node
/**
 * Smoke test for Boards in the renderer (plan docs/plans/2026-09-28-boards.md
 * §4, phase B2):
 *
 * - lib/canvas/: the camera (fit, screen ↔ world, zoom about a point with
 *   limits, the wheel gesture), stroke simplification and the path, and
 *   undo/redo history.
 * - lib/boardModel.ts: making items (image size, a pinned note's place, a
 *   highlight kept on its image, a line's width and bounds), hit testing, the
 *   handles and resizing (an image keeps its shape, its highlights scale),
 *   moving (highlights go with their image), marquee and the selection's
 *   target and notes, deleting (highlights go, pins drop), z order, pins and
 *   the leader line, the tools' keys and Esc, the save state machine and the
 *   preview's pace.
 * - lib/boardRender.ts: plain text from markdown, wrapping, and drawBoard
 *   and renderBoardPng against a stub 2D context.
 * - lib/hesterBoard.ts: every route's method, path, workspace (query and
 *   percent-encoded header), token and envelope with a stub fetch; the 409
 *   on PUT /board; raw uploads with `?source=` and `?kind=selection`.
 * - Links on a Board: a link box, a pasted lone `[[card]]`, the `[[` query.
 *
 * Bundles the real sources with esbuild; no Hester, React or DOM needed.
 *
 * Run: node scripts/board-renderer-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bundle(rel, name, platform = 'neutral') {
  const built = await esbuild.build({ entryPoints: [join(__dirname, rel)], bundle: true, format: 'esm', platform, write: false, external: ['react'] });
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
let reply = { status: 200, body: { success: true, data: null } };
let replyFor = null;
globalThis.window = { lee: { getApiToken: () => 'tok-1' } };
globalThis.fetch = async (url, init = {}) => {
  let body = init.body;
  if (typeof body === 'string') body = JSON.parse(body);
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body });
  const { status, body: out } = (replyFor && replyFor(String(url), init)) || reply;
  return { ok: status >= 200 && status < 300, status, json: async () => out, blob: async () => new Blob(['png'], { type: 'image/png' }) };
};

const camera = await bundle('../src/renderer/lib/canvas/camera.ts', 'camera');
const stroke = await bundle('../src/renderer/lib/canvas/stroke.ts', 'stroke');
const history = await bundle('../src/renderer/lib/canvas/history.ts', 'history');
const model = await bundle('../src/renderer/lib/boardModel.ts', 'boardModel');
const render = await bundle('../src/renderer/lib/boardRender.ts', 'boardRender');
const client = await bundle('../src/renderer/lib/hesterBoard.ts', 'hesterBoard');
const desk = await bundle('../src/renderer/lib/deskModel.ts', 'deskModel');

let passed = 0;
async function test(name, fn) {
  calls.length = 0;
  reply = { status: 200, body: { success: true, data: null } };
  replyFor = null;
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const WS = '/Users/ben/Développement/my proj';
const BD = 'bd-1a2b3c4d';

// ---------------------------------------------------------------------------
// lib/canvas
// ---------------------------------------------------------------------------

await test('canvas camera: fit, round trip, zoom about a point within limits, wheel pans or zooms', () => {
  const cam = camera.fitRect({ w: 1000, h: 800 }, { x: 100, y: 50, w: 400, h: 300 }, 50, 8);
  near(cam.scale, Math.min(900 / 400, 700 / 300));
  const c = camera.worldToScreen(cam, { x: 300, y: 200 });
  near(c.x, 500);
  near(c.y, 400);
  const p = { x: 123, y: 456 };
  const w = camera.screenToWorld(cam, p);
  const z = camera.zoomAt(cam, p, 3, 0.05, 8);
  const still = camera.worldToScreen(z, w);
  near(still.x, p.x);
  near(still.y, p.y);
  assert.equal(camera.zoomAt(cam, p, 100, 0.05, 8).scale, 8, 'a Board zooms to its own max');
  assert.equal(camera.zoomAt({ scale: 1, x: 0, y: 0 }, p, 100).scale, camera.MAX_SCALE, 'the Desk keeps its max');
  assert.deepEqual(camera.wheelCamera({ scale: 1, x: 0, y: 0 }, { deltaX: 5, deltaY: 10 }, p), { scale: 1, x: -5, y: -10 });
  near(camera.wheelCamera({ scale: 1, x: 0, y: 0 }, { deltaX: 0, deltaY: -100, ctrlKey: true }, p).scale, Math.min(camera.MAX_SCALE, Math.exp(1)));
  assert.deepEqual(camera.rectBetween({ x: 10, y: 20 }, { x: 0, y: 5 }), { x: 0, y: 5, w: 10, h: 15 });
  assert.ok(!camera.movedEnough({ x: 0, y: 0 }, { x: 2, y: 2 }));
  assert.ok(camera.movedEnough({ x: 0, y: 0 }, { x: 4, y: 0 }));
});

await test('the Desk still uses the same camera and strokes (re-exported under its names)', () => {
  // Separate bundles, so compare by name and behaviour.
  assert.equal(desk.screenToDesk.name, 'screenToWorld');
  assert.equal(desk.deskToScreen.name, 'worldToScreen');
  const cam = { scale: 0.5, x: 10, y: 20 };
  assert.deepEqual(desk.screenToDesk(cam, { x: 60, y: 70 }), camera.screenToWorld(cam, { x: 60, y: 70 }));
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 9, y: 1 }];
  assert.equal(desk.strokePath(pts), stroke.strokePath(pts));
  assert.equal(desk.simplifyPoints.name, 'simplifyPoints');
  assert.equal(desk.movedEnough.name, 'movedEnough');
});

await test('canvas strokes: simplify keeps the ends, polyline distance, the path and traceStroke agree', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i % 2 ? 0.1 : 0 }));
  const s = stroke.simplifyPoints(pts, 0.5);
  assert.deepEqual(s, [pts[0], pts[49]]);
  near(stroke.polylineDistance({ x: 5, y: 3 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 3);
  assert.equal(stroke.polylineDistance({ x: 0, y: 0 }, []), Infinity);
  assert.ok(!stroke.isLine([{ x: 1, y: 1 }, { x: 1, y: 1 }]));
  assert.ok(stroke.isLine([{ x: 1, y: 1 }, { x: 2, y: 1 }]));
  const many = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: Math.sin(i) * 50 }));
  assert.ok(stroke.simplifyStroke(many, 1, 2000).length <= 2000);
  const three = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  assert.equal(stroke.strokePath(three), 'M0 0Q10 0 10 5L10 10');
  const log = [];
  stroke.traceStroke({ moveTo: (...a) => log.push(['M', ...a]), lineTo: (...a) => log.push(['L', ...a]), quadraticCurveTo: (...a) => log.push(['Q', ...a]) }, three);
  assert.deepEqual(log, [['M', 0, 0], ['Q', 10, 0, 10, 5], ['L', 10, 10]]);
});

await test('canvas history: record, undo, redo, a new change clears redo, the cap', () => {
  let h = history.emptyHistory();
  h = history.record(h, 'a');
  h = history.record(h, 'b');
  const u = history.undo(h, 'c');
  assert.equal(u.state, 'b');
  const r = history.redo(u.history, 'b');
  assert.equal(r.state, 'c');
  const u2 = history.undo(u.history, 'b');
  assert.equal(u2.state, 'a');
  assert.equal(history.undo(u2.history, 'a'), null);
  const cleared = history.record(u.history, 'b2');
  assert.equal(cleared.future.length, 0, 'a change after undo drops redo');
  assert.equal(history.redo(cleared, 'x'), null);
  let capped = history.emptyHistory();
  for (let i = 0; i < 80; i++) capped = history.record(capped, i);
  assert.equal(capped.past.length, history.UNDO_MAX);
  assert.equal(capped.past[0], 30);
  assert.deepEqual(history.pushCapped([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.equal(history.dropLast(history.record(history.emptyHistory(), 'x')).past.length, 0);
});

// ---------------------------------------------------------------------------
// boardModel: items
// ---------------------------------------------------------------------------

let n = 0;
const id = () => `it-${String(++n).padStart(8, '0')}`;
const IMG = { id: 'it-00000img', kind: 'image', asset: 'img-0000abcd.png', x: 0, y: 0, w: 400, h: 200, z: 1 };

await test('ids: it- and 8 hex', () => {
  assert.match(model.newItemId(), /^it-[0-9a-f]{8}$/);
  assert.equal(model.newItemId(() => 0.999), 'it-ffffffff');
});

await test('images: a Retina screenshot at half its pixels, capped, centred where it was pasted, on top', () => {
  assert.deepEqual(model.imageSize({ w: 1600, h: 1000 }, 2), { w: 800, h: 500 });
  assert.deepEqual(model.imageSize({ w: 4000, h: 1000 }, 1), { w: 960, h: 240 });
  const im = model.makeImage([IMG], 'img-00000001.png', { w: 200, h: 100 }, { x: 500, y: 500 }, 1, 'it-00000002');
  assert.deepEqual(im, { id: 'it-00000002', kind: 'image', asset: 'img-00000001.png', x: 400, y: 450, w: 200, h: 100, z: 2 });
});

await test('notes: a loose note where you clicked; a pinned one up and right of its pin', () => {
  const loose = model.makeNote([], { x: 10, y: 20 }, null, '', 'it-0000000a');
  assert.deepEqual(loose, { id: 'it-0000000a', kind: 'note', text: '', x: 10, y: 20, w: model.NOTE_W, h: model.NOTE_H, z: 1 });
  const pin = model.pinFor(IMG, { x: 100, y: 50 });
  assert.deepEqual(pin, { item_id: IMG.id, u: 0.25, v: 0.25 });
  const pinned = model.makeNote([IMG], { x: 100, y: 50 }, pin, 'Why this gap?', 'it-0000000b');
  assert.equal(pinned.x, 100 + model.PIN_OFFSET);
  assert.equal(pinned.y, 50 - model.NOTE_H - model.PIN_OFFSET);
  assert.deepEqual(pinned.pin, pin);
  assert.deepEqual(model.pinPoint([IMG], pin), { x: 100, y: 50 });
  assert.deepEqual(model.pinFor(IMG, { x: -50, y: 900 }), { item_id: IMG.id, u: 0, v: 1 }, 'clamped to the item');
});

await test('highlights: kept inside their image; a click is not a region', () => {
  const h = model.makeHighlight([IMG], { x: 350, y: 150 }, { x: 500, y: 300 }, IMG, 'it-0000000c');
  assert.deepEqual(h, { id: 'it-0000000c', kind: 'highlight', x: 350, y: 150, w: 50, h: 50, z: 2, item_id: IMG.id });
  assert.equal(model.makeHighlight([IMG], { x: 10, y: 10 }, { x: 12, y: 40 }, IMG), null);
  const free = model.makeHighlight([], { x: 10, y: 10 }, { x: 0, y: 0 }, null, 'it-0000000d');
  assert.equal(free.item_id, undefined);
  assert.deepEqual([free.x, free.y, free.w, free.h], [0, 0, 10, 10]);
});

await test('lines: a click is none; bounds and a width that is the Desk’s on screen at that zoom', () => {
  assert.equal(model.makeStroke([], [{ x: 1, y: 1 }], 1), null);
  const s = model.makeStroke([IMG], [{ x: 10, y: 10 }, { x: 30, y: 5 }, { x: 50, y: 40 }], 0.5, 'it-0000000e');
  assert.equal(s.kind, 'stroke');
  assert.equal(s.width, 4);
  assert.deepEqual([s.x, s.y, s.w, s.h], [10, 5, 40, 35]);
  assert.equal(s.z, 2);
});

// ---------------------------------------------------------------------------
// boardModel: hit testing, selection, move, resize, delete, z
// ---------------------------------------------------------------------------

const HL = { id: 'it-000000hl', kind: 'highlight', x: 50, y: 50, w: 100, h: 50, z: 2, item_id: IMG.id };
const NOTE = { id: 'it-00000n01', kind: 'note', text: '**Gap** here, see [[pg-1a2b3c4d|Mesh]]', x: 500, y: 0, w: 200, h: 80, z: 3, pin: { item_id: HL.id, u: 0.5, v: 0.5 } };
const LINE = { id: 'it-00000s01', kind: 'stroke', points: [[0, 300], [100, 300]], width: 2, x: 0, y: 300, w: 100, h: 1, z: 4 };
const ITEMS = [IMG, HL, NOTE, LINE];

await test('hit testing: topmost first, lines within a few screen px, kinds filter', () => {
  assert.equal(model.itemAt(ITEMS, { x: 60, y: 60 }).id, HL.id, 'the highlight is over the image');
  assert.equal(model.itemAt(ITEMS, { x: 10, y: 10 }).id, IMG.id);
  assert.equal(model.itemAt(ITEMS, { x: 50, y: 305 }, 6).id, LINE.id);
  assert.equal(model.itemAt(ITEMS, { x: 50, y: 320 }, 6), null);
  assert.equal(model.pinTargetAt(ITEMS, { x: 60, y: 60 }).id, HL.id);
  assert.equal(model.imageAt(ITEMS, { x: 60, y: 60 }).id, IMG.id);
  assert.equal(model.pinTargetAt(ITEMS, { x: 600, y: 40 }), null, 'a note is not a pin target');
});

await test('marquee and selection: touches, rect, target, the notes it carries', () => {
  assert.deepEqual(model.itemsInRect(ITEMS, { x: 120, y: 60, w: 20, h: 20 }), [IMG.id, HL.id]);
  assert.deepEqual(model.selectionRect(ITEMS, [IMG.id, NOTE.id]), { x: 0, y: 0, w: 700, h: 200 });
  assert.deepEqual(model.selectionTarget(ITEMS, [HL.id, 'it-gone0000']), { item_ids: [HL.id], rect: { x: 50, y: 50, w: 100, h: 50 } });
  assert.equal(model.selectionTarget(ITEMS, []), null);
  assert.deepEqual(model.selectionNotes(ITEMS, [HL.id]), [NOTE.text], 'a note pinned to the selection comes along');
  assert.deepEqual(model.selectionNotes(ITEMS, [IMG.id]), []);
  assert.deepEqual(model.toggleSelected([IMG.id], HL.id), [IMG.id, HL.id]);
  assert.deepEqual(model.toggleSelected([IMG.id, HL.id], IMG.id), [HL.id]);
});

await test('move: highlights go with their image; a line’s points move; the pinned leader follows', () => {
  const moved = model.moveItems(ITEMS, [IMG.id, LINE.id], { x: 10, y: -5 });
  const by = (id) => moved.find((i) => i.id === id);
  assert.deepEqual([by(IMG.id).x, by(IMG.id).y], [10, -5]);
  assert.deepEqual([by(HL.id).x, by(HL.id).y], [60, 45], 'the highlight came along');
  assert.deepEqual([by(NOTE.id).x, by(NOTE.id).y], [500, 0], 'the note stays');
  assert.deepEqual(by(LINE.id).points, [[10, 295], [110, 295]]);
  assert.deepEqual(model.pinPoint(moved, NOTE.pin), { x: 110, y: 70 });
  const leader = model.leaderLine(by(NOTE.id), moved);
  assert.deepEqual(leader.to, { x: 110, y: 70 });
  assert.equal(leader.from.x, 500, 'it leaves the note by its left edge');
  assert.ok(leader.from.y >= 0 && leader.from.y <= 80);
  assert.equal(model.leaderLine({ ...NOTE, pin: null }, ITEMS), null);
  assert.equal(model.leaderLine({ ...NOTE, x: 50, y: 50, w: 200, h: 200 }, ITEMS), null, 'no leader when the pin is under the note');
});

await test('resize: corners, the opposite one stays, images keep their shape, highlights scale, lines scale', () => {
  assert.equal(model.handleAt({ x: 0, y: 0, w: 100, h: 50 }, { x: 103, y: 52 }, 1), 'se');
  assert.equal(model.handleAt({ x: 0, y: 0, w: 100, h: 50 }, { x: 50, y: 25 }, 1), null);
  assert.equal(model.handleAt({ x: 0, y: 0, w: 100, h: 50 }, { x: -12, y: -12 }, 0.5), 'nw', 'handles are screen px');
  assert.deepEqual(model.resizeRect({ x: 0, y: 0, w: 100, h: 50 }, 'se', { x: 20, y: 5 }), { x: 0, y: 0, w: 120, h: 55 });
  assert.deepEqual(model.resizeRect({ x: 0, y: 0, w: 100, h: 50 }, 'nw', { x: 20, y: 10 }), { x: 20, y: 10, w: 80, h: 40 });
  assert.deepEqual(model.resizeRect({ x: 0, y: 0, w: 400, h: 200 }, 'se', { x: 400, y: 0 }, 2), { x: 0, y: 0, w: 800, h: 400 });
  const tiny = model.resizeRect({ x: 0, y: 0, w: 100, h: 50 }, 'se', { x: -500, y: -500 });
  assert.deepEqual([tiny.w, tiny.h], [model.MIN_ITEM, model.MIN_ITEM]);
  const big = model.resizeItem(ITEMS, IMG.id, { x: 0, y: 0, w: 800, h: 400 });
  const hl = big.find((i) => i.id === HL.id);
  assert.deepEqual([hl.x, hl.y, hl.w, hl.h], [100, 100, 200, 100]);
  const line = model.resizeItem(ITEMS, LINE.id, { x: 0, y: 300, w: 200, h: 1 }).find((i) => i.id === LINE.id);
  assert.deepEqual(line.points, [[0, 300], [200, 300]]);
  assert.equal(model.aspectFor(IMG), 2);
  assert.equal(model.aspectFor(NOTE), null);
  assert.ok(model.isResizable(IMG) && !model.isResizable({ ...NOTE, kind: 'ask' }));
});

await test('delete: an image takes its highlights; a note pinned to what went keeps its words, unpinned', () => {
  const left = model.removeItems(ITEMS, [IMG.id]);
  assert.deepEqual(left.map((i) => i.id), [NOTE.id, LINE.id]);
  assert.equal(left[0].pin, null);
  assert.equal(left[0].text, NOTE.text);
});

await test('z order: front and back keep order among the moved; nextZ; sortByZ is stable', () => {
  const front = model.bringToFront(ITEMS, [IMG.id, HL.id]);
  const z = (list, id) => list.find((i) => i.id === id).z;
  assert.ok(z(front, IMG.id) > z(front, LINE.id) && z(front, HL.id) > z(front, IMG.id));
  const back = model.sendToBack(ITEMS, [LINE.id]);
  assert.ok(z(back, LINE.id) < z(back, IMG.id));
  assert.equal(model.nextZ(ITEMS), 5);
  assert.deepEqual(model.sortByZ([{ id: 'a', z: 1 }, { id: 'b', z: 0 }, { id: 'c', z: 1 }]).map((i) => i.id), ['b', 'a', 'c']);
  assert.deepEqual(model.boardBounds(ITEMS), { x: 0, y: 0, w: 700, h: 301 });
});

await test('parseItems: drops what isn’t an item, gives a missing z', () => {
  const got = model.parseItems([IMG, null, { id: 'x', kind: 'note', x: 'a' }, { ...LINE, points: undefined }, { ...NOTE, z: undefined }]);
  assert.deepEqual(got.map((i) => i.id), [IMG.id, NOTE.id]);
  assert.equal(got[1].z, 0);
  assert.deepEqual(model.parseItems('nope'), []);
});

// ---------------------------------------------------------------------------
// boardModel: tools, Esc, saving, the preview
// ---------------------------------------------------------------------------

await test('tools: V A H D, never with a modifier or while typing; the pointer', () => {
  assert.deepEqual(model.BOARD_TOOLS.map((t) => t.key), ['V', 'A', 'H', 'D']);
  assert.equal(model.boardToolForKey({ key: 'a' }, false), 'annotate');
  assert.equal(model.boardToolForKey({ key: 'H' }, false), 'highlight');
  assert.equal(model.boardToolForKey({ key: 'd', metaKey: true }, false), null);
  assert.equal(model.boardToolForKey({ key: 'v', shiftKey: true }, false), null);
  assert.equal(model.boardToolForKey({ key: 'v' }, true), null);
  assert.equal(model.boardCursor('draw'), 'crosshair');
  assert.equal(model.boardCursor('select', { space: true }), 'grab');
  assert.equal(model.boardCursor('select', { panning: true }), 'grabbing');
  assert.equal(model.boardCursor('select', { handle: 'ne' }), 'nesw-resize');
});

await test('Esc: a drag, then the note being written, the selection, back to Select, then out to the Desk', () => {
  const s = { dragging: false, editing: false, selected: 0, tool: 'select' };
  assert.equal(model.boardEscapeStep({ ...s, dragging: true, editing: true }), 'cancel');
  assert.equal(model.boardEscapeStep({ ...s, editing: true, selected: 2 }), 'stop-editing');
  assert.equal(model.boardEscapeStep({ ...s, selected: 2, tool: 'draw' }), 'deselect');
  assert.equal(model.boardEscapeStep({ ...s, tool: 'draw' }), 'select-tool');
  assert.equal(model.boardEscapeStep(s), 'zoom-out');
});

await test('saving: debounced after an edit, one in flight, edits meanwhile go next, a failure retries, a 409 takes the new version', () => {
  let s = model.saveStep(model.SAVE_START, { type: 'loaded', version: 'v1' });
  assert.equal(model.saveDelay(s), null, 'nothing to save');
  s = model.saveStep(s, { type: 'edit' });
  assert.equal(model.saveDelay(s), model.BOARD_SAVE_MS);
  s = model.saveStep(s, { type: 'start' });
  assert.equal(model.saveDelay(s), null, 'one PUT at a time');
  s = model.saveStep(s, { type: 'edit' });
  s = model.saveStep(s, { type: 'saved', version: 'v2' });
  assert.equal(s.version, 'v2');
  assert.equal(model.saveDelay(s), model.BOARD_SAVE_MS, 'the edit made in flight goes next');
  s = model.saveStep(model.saveStep(s, { type: 'start' }), { type: 'failed' });
  assert.equal(model.saveDelay(s), model.BOARD_RETRY_MS);
  assert.equal(s.version, 'v2');
  s = model.saveStep(s, { type: 'conflict', version: 'v9' });
  assert.deepEqual(s, { version: 'v9', dirty: false, saving: false, failed: false });
});

await test('the preview: at most every few seconds; its rect and scale', () => {
  assert.equal(model.previewDelay(null, 1000), 0);
  assert.equal(model.previewDelay(1000, 2000), model.PREVIEW_EVERY_MS - 1000);
  assert.equal(model.previewDelay(1000, 1000 + model.PREVIEW_EVERY_MS + 1), 0);
  assert.deepEqual(model.previewRect([IMG], 10), { x: -10, y: -10, w: 420, h: 220 });
  assert.equal(model.previewRect([]), null);
  assert.equal(model.previewScale({ w: 2400, h: 100 }), 0.5);
  assert.equal(model.previewScale({ w: 100, h: 100 }), 1);
});

// ---------------------------------------------------------------------------
// boardRender
// ---------------------------------------------------------------------------

function stubCtx() {
  const log = [];
  const props = {};
  const ctx = new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: s.length * 7 });
      return (...args) => log.push([k, ...args]);
    },
    set(t, k, v) {
      t[k] = v;
      log.push([`=${String(k)}`, v]);
      return true;
    },
  });
  return { ctx, log };
}

await test('render: plain text from markdown, wrapping by width', () => {
  assert.equal(render.plainText('# Title\n**Gap** see [[pg-1a2b3c4d|Mesh]] and [x](http://y)'), 'Title\nGap see Mesh and x');
  assert.equal(render.plainText('[[bd-00000001]]'), 'bd-00000001');
  const lines = render.wrapLines('one two three four', 70, (s) => s.length * 7);
  assert.deepEqual(lines, ['one two', 'three four']);
  assert.deepEqual(render.wrapLines('abcdefghijkl', 35, (s) => s.length * 7), ['abcde', 'fghij', 'kl']);
});

await test('render: drawBoard draws in z order, images from bitmaps, only the selection when asked', () => {
  const { ctx, log } = stubCtx();
  const bmp = { tag: 'bitmap' };
  const items = [{ ...NOTE, z: 9 }, IMG, HL, LINE, { id: 'it-000000as', kind: 'ask', answer_id: 'ans-1', target: { item_ids: [], rect: { x: 0, y: 0, w: 1, h: 1 } }, x: 800, y: 0, w: 120, h: 90, z: 5 }];
  render.drawBoard(ctx, items, { x: -10, y: -10, w: 1000, h: 500 }, new Map([[IMG.asset, bmp]]), 0.5, { answerLabel: (it) => (it.kind === 'ask' ? 'Why?' : '') });
  const draws = log.filter((l) => l[0] === 'drawImage');
  assert.deepEqual(draws, [['drawImage', bmp, 0, 0, 400, 200]]);
  assert.deepEqual(log.find((l) => l[0] === 'scale'), ['scale', 0.5, 0.5]);
  assert.deepEqual(log.find((l) => l[0] === 'translate'), ['translate', 10, 10]);
  const texts = log.filter((l) => l[0] === 'fillText').map((l) => l[1]);
  assert.ok(texts.includes('Why?'), 'the ask shows its label');
  assert.ok(texts.some((t) => t.includes('Gap')), 'the note shows its words');
  const order = log.filter((l) => l[0] === 'drawImage' || l[0] === 'fillText').map((l) => (l[0] === 'drawImage' ? 'img' : l[1]));
  assert.equal(order[0], 'img', 'the image (z 1) before the note (z 9)');
  assert.equal(order[order.length - 1].includes('Gap') || order.includes('Why?'), true);

  const only = stubCtx();
  render.drawBoard(only.ctx, items, { x: 0, y: 0, w: 400, h: 200 }, new Map(), 1, { only: [IMG.id], background: false });
  assert.ok(!only.log.some((l) => l[0] === 'fillText'), 'only the image');
  assert.ok(only.log.some((l) => l[0] === 'fillRect'), 'an image not loaded yet draws as a card');
});

await test('render: renderBoardPng sizes the canvas to the rect and encodes PNG', async () => {
  let made = null;
  const blob = await render.renderBoardPng([IMG], { x: 0, y: 0, w: 2400, h: 1200 }, new Map(), {
    createCanvas: (w, h) => {
      made = { w, h };
      const { ctx } = stubCtx();
      return { getContext: () => ctx, convertToBlob: async (o) => new Blob(['x'], { type: o.type }) };
    },
  });
  assert.deepEqual(made, { w: 1200, h: 600 });
  assert.equal(blob.type, 'image/png');
  assert.equal(await render.renderBoardPng([IMG], { x: 0, y: 0, w: 0, h: 10 }, new Map()), null);
});

// ---------------------------------------------------------------------------
// hesterBoard: routes
// ---------------------------------------------------------------------------

const Q = `workspace=${encodeURIComponent(WS)}`;
const H = 'http://127.0.0.1:9000';

await test('client: board card routes (create, get, rename, delete with force)', async () => {
  await client.createBoard(WS, { area_id: 'area-1a2b3c4d', x: 24, y: 56 });
  await client.getBoard(WS, BD);
  await client.patchBoard(WS, BD, { title: 'Layouts' });
  await client.deleteBoard(WS, BD);
  await client.deleteBoard(WS, BD, true);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ['POST', `${H}/desk/boards?${Q}`, { area_id: 'area-1a2b3c4d', x: 24, y: 56 }],
      ['GET', `${H}/desk/boards/${BD}?${Q}`, undefined],
      ['PATCH', `${H}/desk/boards/${BD}?${Q}`, { title: 'Layouts' }],
      ['DELETE', `${H}/desk/boards/${BD}?${Q}`, undefined],
      ['DELETE', `${H}/desk/boards/${BD}?${Q}`, { force: true }],
    ],
  );
  const c = calls[0];
  assert.equal(c.headers['X-Lee-Workspace'], '/Users/ben/D%C3%A9veloppement/my proj');
  assert.equal(c.headers.Authorization, 'Bearer tok-1');
  assert.equal(c.headers['Content-Type'], 'application/json');
});

await test('client: board.json get and put with the version; the envelope', async () => {
  reply = { status: 200, body: { success: true, data: { version: 'v1', items: [IMG] } } };
  const got = await client.getBoardDoc(WS, BD);
  assert.deepEqual(got, { ok: true, data: { version: 'v1', items: [IMG] } });
  reply = { status: 200, body: { success: true, data: { version: 'v2' } } };
  const put = await client.putBoardDoc(WS, BD, 'v1', [IMG]);
  assert.deepEqual(put, { ok: true, version: 'v2' });
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, `${H}/desk/boards/${BD}/board?${Q}`);
  assert.deepEqual(calls[1].body, { version: 'v1', items: [IMG] });
  reply = { status: 200, body: { version: 'v3' } };
  assert.deepEqual(await client.putBoardDoc(WS, BD, null, []), { ok: true, version: 'v3' }, 'a bare body too');
});

await test('client: a 409 on PUT /board carries Hester’s copy when it has one, else null (GET it)', async () => {
  reply = { status: 409, body: { success: false, error: 'stale', data: { version: 'v7', items: [LINE] } } };
  assert.deepEqual(await client.putBoardDoc(WS, BD, 'v1', []), { ok: false, conflict: { version: 'v7', items: [LINE] } });
  reply = { status: 409, body: { success: false, error: 'stale' } };
  assert.deepEqual(await client.putBoardDoc(WS, BD, 'v1', []), { ok: false, conflict: null });
  reply = { status: 500, body: { success: false, error: 'boom' } };
  const bad = await client.putBoardDoc(WS, BD, 'v1', []);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'boom');
  assert.equal(bad.status, 500);
});

await test('client: assets upload raw with ?source=, list, fetch; the preview put and get', async () => {
  reply = { status: 201, body: { success: true, data: { name: 'img-0000abcd.png', path: 'assets/img-0000abcd.png' } } };
  const src = { kind: 'url', url: 'https://example.com/a.png', taken_at: '2026-09-28T10:00:00Z' };
  const up = await client.uploadBoardAsset(WS, BD, new Uint8Array([1, 2, 3]), 'image/png', src);
  assert.deepEqual(up, { ok: true, data: { name: 'img-0000abcd.png', path: 'assets/img-0000abcd.png' } });
  const u = calls[0];
  assert.equal(u.method, 'POST');
  assert.equal(u.url, `${H}/desk/boards/${BD}/assets?source=${encodeURIComponent(JSON.stringify(src))}&${Q}`);
  assert.equal(u.headers['Content-Type'], 'image/png');
  assert.equal(u.headers.Authorization, 'Bearer tok-1');
  assert.ok(u.body instanceof ArrayBuffer);
  await client.uploadBoardAsset(WS, BD, new Uint8Array([1]), 'image/jpeg');
  assert.equal(calls[1].url, `${H}/desk/boards/${BD}/assets?${Q}`, 'no source, no ?source=');
  await client.uploadBoardAsset(WS, BD, new Uint8Array([1]), 'image/png', null, true);
  assert.equal(calls[2].url, `${H}/desk/boards/${BD}/assets?kind=selection&${Q}`, 'a flattened selection: ?kind=selection');
  await client.uploadBoardAsset(WS, BD, new Uint8Array([1]), 'image/png', src, true);
  assert.equal(calls[3].url, `${H}/desk/boards/${BD}/assets?kind=selection&source=${encodeURIComponent(JSON.stringify(src))}&${Q}`);
  reply = { status: 404, body: { error: 'nope' } };
  const old = await client.uploadBoardAsset(WS, BD, new Uint8Array([1]), 'image/png');
  assert.deepEqual(old, { ok: false, error: 'nope', status: 404 });

  calls.length = 0;
  reply = { status: 200, body: { success: true, data: [] } };
  await client.listBoardAssets(WS, BD);
  const blob = await client.fetchBoardAsset(WS, BD, 'img-0000abcd.png');
  assert.ok(blob instanceof Blob);
  await client.putBoardPreview(WS, BD, new Blob(['png'], { type: 'image/png' }));
  await client.fetchBoardPreview(WS, BD);
  assert.deepEqual(
    calls.map((c) => [c.method ?? 'GET', c.url]),
    [
      ['GET', `${H}/desk/boards/${BD}/assets?${Q}`],
      ['GET', `${H}/desk/boards/${BD}/assets/img-0000abcd.png?${Q}`],
      ['PUT', `${H}/desk/boards/${BD}/preview?${Q}`],
      ['GET', `${H}/desk/boards/${BD}/preview?${Q}`],
    ],
  );
  assert.equal(calls[2].headers['Content-Type'], 'image/png');
  reply = { status: 404, body: null };
  assert.equal(await client.fetchBoardPreview(WS, BD), null);
});

await test('links on a Board: a link box, a pasted lone link, the [[ being typed in a note', () => {
  const link = model.makeLink([{ id: 'it-00000001', kind: 'note', text: '', x: 0, y: 0, w: 10, h: 10, z: 4 }], 'pg-0000abcd', { x: 100, y: 50 }, 'it-0000000a');
  assert.deepEqual(link, { id: 'it-0000000a', kind: 'link', card_id: 'pg-0000abcd', x: 100 - model.LINK_W / 2, y: 50 - model.LINK_H / 2, w: model.LINK_W, h: model.LINK_H, z: 5 });
  assert.equal(model.loneCardLink('  [[bd-0000beef|Sketches]] '), 'bd-0000beef');
  assert.equal(model.loneCardLink('[[pg-0000abcd]]'), 'pg-0000abcd');
  assert.equal(model.loneCardLink('see [[pg-0000abcd]]'), null, 'text around it: a note');
  assert.equal(model.loneCardLink('[[notes/today.md]]'), null, 'a file link is not a card');
  assert.deepEqual(model.linkQueryAt('See [[Tax', 9), { from: 4, query: 'Tax' });
  assert.deepEqual(model.linkQueryAt('[[', 2), { from: 0, query: '' });
  assert.equal(model.linkQueryAt('[[pg-0000abcd|T]] and', 21), null, 'a closed link');
  assert.equal(model.linkQueryAt('[[a\nb', 5), null, 'not across lines');
});

await test('client: Hester offline is one line, not a throw', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    assert.deepEqual(await client.getBoardDoc(WS, BD), { ok: false, error: 'Hester offline' });
    assert.deepEqual(await client.uploadBoardAsset(WS, BD, new Uint8Array([1]), 'image/png'), { ok: false, error: 'Hester offline' });
    assert.equal(await client.fetchBoardAsset(WS, BD, 'x'), null);
  } finally {
    globalThis.fetch = real;
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
