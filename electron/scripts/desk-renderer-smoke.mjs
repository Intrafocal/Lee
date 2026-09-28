#!/usr/bin/env node
/**
 * Smoke test for the Desk surface's pure logic and client (D2 contract §7.3):
 *
 * - lib/deskModel.ts: the zoom maths (fit an Area, fit a card, screen ↔ Desk,
 *   zoom about a point), the landing target (DeskLast × saved cursor × null
 *   line), the Esc rule, touched-card accumulation and order, the empty-spot
 *   hit test and new-card placement, the Goals corner, the drawer counts,
 *   the card count line and waiting cards, and the exp → pg key migration;
 *   the tools: their keys and Esc, the pointer's shape, drag-to-move maths
 *   and which Area a card lands in, edits shown before Hester answers, and
 *   strokes (simplification, the cap, Area-relative coordinates, the path).
 * - lib/hesterDesk.ts: every route's method, path, workspace (query and
 *   percent-encoded header), token and envelope, with a stub fetch; a Page
 *   card's own routes (hesterDeep by card id) go to /desk/pages/{id}/….
 * - hesterDeep's card forms: the hand-off origin 'page', the brief's "From
 *   the Page" line, an in-memory card's create body.
 * - paletteAbout.deskAboutFor: `about: page` only from a zoomed card.
 * - The cockpitMode store's Desk seam: zoomIntoCard (session, desk.zoom,
 *   touched cards, PUT /desk/last), zoomOut, openDesk targets.
 *
 * Bundles the real sources with esbuild; no Hester, React or DOM needed.
 *
 * Run: node scripts/desk-renderer-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bundle(rel, name, platform = 'neutral') {
  const built = await esbuild.build({ entryPoints: [join(__dirname, rel)], bundle: true, format: 'esm', platform, write: false, external: ['react'] });
  // Next to this script, so an external `react` resolves from node_modules.
  const dir = mkdtempSync(join(__dirname, `.desk-smoke-${name}-`));
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
const logged = [];
const started = [];
globalThis.window = {
  lee: {
    getApiToken: () => 'tok-1',
    cockpit: { logEvent: (e) => logged.push(e) },
    copilot: { deepStart: async (req) => (started.push(req), { active: true, session_id: 'fs-1' }) },
  },
};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const { status, body } = (replyFor && replyFor(String(url), init)) || reply;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const model = await bundle('../src/renderer/lib/deskModel.ts', 'deskModel');
const desk = await bundle('../src/renderer/lib/hesterDesk.ts', 'hesterDesk');
const deep = await bundle('../src/renderer/lib/hesterDeep.ts', 'hesterDeep');
const palette = await bundle('../src/renderer/components/paletteAbout.ts', 'paletteAbout');

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

// ---------------------------------------------------------------------------
// deskModel: camera
// ---------------------------------------------------------------------------

await test('zoom maths: fit an Area centres it with padding; fit a card fills the view', () => {
  const view = { w: 1000, h: 800 };
  const area = { x: 1400, y: 0, w: 1200, h: 800 };
  const cam = model.fitRect(view, area, 50);
  near(cam.scale, Math.min(900 / 1200, 700 / 800));
  const c = model.deskToScreen(cam, { x: area.x + area.w / 2, y: area.y + area.h / 2 });
  near(c.x, 500);
  near(c.y, 400);
  const card = { x: 1448, y: 96, w: 360, h: 240 };
  const cc = model.fitRect(view, card, 0, 10);
  near(cc.scale, Math.min(1000 / 360, 800 / 240));
  const tl = model.deskToScreen(cc, { x: card.x, y: card.y });
  const br = model.deskToScreen(cc, { x: card.x + card.w, y: card.y + card.h });
  assert.ok(tl.x >= -1e-6 && tl.y >= -1e-6 && br.x <= 1000 + 1e-6 && br.y <= 800 + 1e-6, 'the card is whole');
  assert.equal(model.fitRect(view, card, 0).scale, model.MAX_SCALE, 'capped at the max scale');
});

await test('zoom maths: screen → Desk → screen round-trips; zoomAt keeps the point under the pointer; pan', () => {
  const cam = { scale: 0.4, x: -120, y: 35 };
  const p = { x: 333, y: 222 };
  const d = model.screenToDesk(cam, p);
  const back = model.deskToScreen(cam, d);
  near(back.x, p.x);
  near(back.y, p.y);
  const z = model.zoomAt(cam, p, 2);
  near(z.scale, 0.8);
  const still = model.deskToScreen(z, d);
  near(still.x, p.x);
  near(still.y, p.y);
  assert.equal(model.zoomAt(cam, p, 1000).scale, model.MAX_SCALE);
  assert.equal(model.zoomAt(cam, p, 0.00001).scale, model.MIN_SCALE);
  assert.deepEqual(model.panBy(cam, 10, -5), { scale: 0.4, x: -110, y: 30 });
  assert.equal(model.cameraTransform({ scale: 0.5, x: 10.123, y: -4 }), 'translate(10.12px, -4px) scale(0.5)');
});

const A1 = { id: 'area-1a2b3c4d', name: 'Mesh sync', x: 0, y: 0, w: 1200, h: 800, drawer_id: null, created_at: '', updated_at: '2026-09-27T10:00:00Z', migrated_from: null };
const A2 = { ...A1, id: 'area-00000002', name: 'Board', x: 1400, y: 0 };
const A3 = { ...A1, id: 'area-00000003', name: 'Old', x: 2800, y: 0, drawer_id: 'stashed', updated_at: '2026-09-20T10:00:00Z' };
const A4 = { ...A1, id: 'area-00000004', name: 'Older', x: 0, y: 1000, drawer_id: 'stashed', updated_at: '2026-09-21T10:00:00Z' };
const summary = { page_chars: 10, page_updated_at: null, excerpt: '', answers_unread: 0, answers_pending: 0, handoffs_in_flight: 0, open_questions: 0 };
const card = (id, area_id, x, y, extra = {}) => ({ id, kind: 'page', area_id, x, y, w: 360, h: 240, title: id, purpose: null, pinned: false, created_at: '', updated_at: '', last_touched_at: null, migrated_from: null, summary, ...extra });
const C1 = card('pg-1a2b3c4d', A1.id, 48, 96);
const C2 = card('pg-00000002', A2.id, 48, 96);
const G = card('pg-9f8e7d6c', null, 0, 0, { purpose: 'goals', pinned: true, w: 0, h: 0 });
const DESK = {
  version: 1,
  workspace: WS,
  areas: [A1, A2, A3, A4],
  cards: [C1, C2, G],
  drawers: [
    { id: 'ideas', name: 'Ideas', kind: 'ideas', area_ids: [], count: 3 },
    { id: 'stashed', name: 'Put away', kind: 'areas', area_ids: [A4.id, A3.id], count: 2 },
  ],
  goals_card_id: G.id,
  last: null,
  migration: null,
};

await test('focusRect: the overview fits the Areas on the Desk; an Area; a card; the Goals card in the Area you are in', () => {
  assert.deepEqual(model.focusRect(DESK, 'overview', null, null), { x: 0, y: 0, w: 2600, h: 800 }, 'stashed Areas are not on the Desk');
  assert.deepEqual(model.focusRect(DESK, 'area', A2.id, null), A2);
  assert.deepEqual(model.focusRect(DESK, 'card', A1.id, C2.id), { x: 1448, y: 96, w: 360, h: 240 }, "a card's own Area, whatever is in view");
  const g = model.goalsCorner(A2);
  assert.deepEqual(model.focusRect(DESK, 'card', A2.id, G.id), { x: A2.x + g.x, y: A2.y + g.y, w: g.w, h: g.h });
  assert.equal(model.focusRect({ areas: [], cards: [] }, 'overview', null, null), null);
  assert.equal(model.areaForCard(DESK, C2.id, A1.id), A2.id);
  assert.equal(model.areaForCard(DESK, G.id, A1.id), A1.id, 'the Goals card has no Area of its own');
});

await test('the Goals corner: top-right of every Area, inset; never off the left edge', () => {
  const g = model.goalsCorner({ w: 1200 });
  assert.deepEqual(g, { x: 1200 - model.GOALS_W - model.GOALS_INSET, y: model.GOALS_INSET, w: model.GOALS_W, h: model.GOALS_H });
  assert.equal(model.goalsCorner({ w: 100 }).x, model.GOALS_INSET);
  assert.deepEqual(model.cardRectOnDesk(G, A2), { x: A2.x + g.x, y: g.y, w: g.w, h: g.h });
  assert.equal(model.cardRectOnDesk(C1, null), null);
});

await test('hit test: the Area under a point; an empty spot is below the head, off cards and off the Goals corner', () => {
  const on = model.areasOnDesk(DESK);
  assert.equal(model.areaAt(on, { x: 1500, y: 300 }).id, A2.id);
  assert.equal(model.areaAt(on, { x: 1300, y: 300 }), null, 'the gap between Areas');
  const cards = model.cardsIn(DESK, A1.id);
  assert.deepEqual(cards.map((c) => c.id), [C1.id], 'the pinned Goals card is no Area’s own');
  assert.equal(model.isEmptySpot(A1, cards, { x: 600, y: 500 }), true);
  assert.equal(model.isEmptySpot(A1, cards, { x: 100, y: 150 }), false, 'on a card');
  assert.equal(model.isEmptySpot(A1, cards, { x: 600, y: 20 }), false, 'the name strip');
  assert.equal(model.isEmptySpot(A1, cards, { x: 1100, y: 60 }), false, 'the Goals corner');
  assert.equal(model.isEmptySpot(A1, cards, { x: 1300, y: 500 }), false, 'outside');
});

await test('placement: at the click, inside the Area, nudged clear of cards and the Goals corner', () => {
  const cards = model.cardsIn(DESK, A1.id);
  assert.deepEqual(model.placeNewCard(A1, cards, { x: 500, y: 400 }), { x: 500, y: 400, w: 360, h: 240 });
  const clamped = model.placeNewCard(A1, cards, { x: 1190, y: 790 });
  assert.ok(clamped.x + clamped.w <= A1.w && clamped.y + clamped.h <= A1.h, 'kept inside');
  const onCard = model.placeNewCard(A1, cards, { x: 60, y: 100 });
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!overlaps(onCard, C1), 'not on the card');
  assert.ok(!overlaps(onCard, model.goalsCorner(A1)), 'not on the Goals corner');
  const beside = model.placeBeside(A1, cards, C1);
  assert.ok(beside.x >= C1.x + C1.w, 'to the right of the card it came from');
  // A full Area: below everything.
  const full = [];
  for (let x = 24; x < 1200; x += 190) for (let y = 56; y < 800; y += 130) full.push({ x, y, w: 180, h: 120 });
  const last = model.placeNewCard(A1, full, { x: 100, y: 100 });
  assert.ok(last.y >= Math.max(...full.map((f) => f.y + f.h)), 'below everything');
});

// ---------------------------------------------------------------------------
// deskModel: tools (Cursor, Move, Draw)
// ---------------------------------------------------------------------------

await test('the Drawer: folders (Ideas, Stashed, your own), newest first, by date, and search', () => {
  const now = new Date(2026, 8, 28, 12, 0);
  const at = (d, h = 9) => new Date(2026, 8, d, h, 0).toISOString();
  assert.equal(model.dateBucket(at(28, 1), now), 'today');
  assert.equal(model.dateBucket(at(22), now), 'week', 'six days back is this week');
  assert.equal(model.dateBucket(at(21), now), 'older');
  assert.equal(model.dateBucket(null, now), 'older');
  const area = (id, name, drawer_id, stashed_at) => ({ id, name, drawer_id, stashed_at, x: 0, y: 0, w: 1, h: 1, created_at: at(1), updated_at: at(1), migrated_from: null });
  const desk = {
    drawers: [
      { id: 'ideas', name: 'Ideas', kind: 'ideas', area_ids: [], count: 2 },
      { id: 'stashed', name: 'Put away', kind: 'areas', area_ids: [], count: 2 },
      { id: 'drw-00000001', name: 'Archive', kind: 'areas', area_ids: [], count: 0 },
    ],
    areas: [area('area-1', 'Mesh sync', 'stashed', at(20)), area('area-2', 'Taxonomy', 'stashed', at(28)), area('area-3', 'On the Desk', null, null)],
    cards: [{ id: 'pg-1', area_id: 'area-2' }, { id: 'pg-2', area_id: 'area-2' }],
  };
  const ideas = [
    { id: 'sd_1', text: 'Try a CRDT', created_at: at(27), source: { surface: 'aeronaut' } },
    { id: 'sd_2', text: 'Voice notes on a walk', created_at: at(28), source: { surface: 'lee' } },
  ];
  const f = model.drawerFolders(desk, ideas);
  assert.deepEqual(f.map((x) => x.name), ['Ideas', 'Stashed', 'Archive'], 'Put away reads Stashed; an empty folder of your own still shows');
  assert.deepEqual(f[0].entries.map((e) => [e.id, e.meta]), [['sd_2', ''], ['sd_1', 'from aeronaut']]);
  assert.deepEqual(f[1].entries.map((e) => [e.text, e.meta]), [['Taxonomy', '2 cards'], ['Mesh sync', '0 cards']]);
  assert.deepEqual(model.byDate(f[1].entries, now).map((g) => [g.label, g.entries.length]), [['Today', 1], ['Older', 1]]);
  const hits = model.searchDrawer(f, 'crdt TRY');
  assert.deepEqual(hits.map((x) => [x.name, x.entries.map((e) => e.id)]), [['Ideas', ['sd_1']]], 'every word, any order, any case');
  assert.deepEqual(model.searchDrawer(f, 'aeronaut').map((x) => x.entries[0].id), ['sd_1'], 'where it came from counts');
  assert.equal(model.searchDrawer(f, '  ').length, 3, 'no query: everything');
  assert.deepEqual(model.searchDrawer(f, 'nothing like this'), []);
});

await test('Rectangle: a drag outlines the Area whichever way it went; a click or a small drag grows to the smallest Area', () => {
  assert.deepEqual(model.rectFromDrag({ x: 900, y: 700 }, { x: 100, y: 200 }), { x: 100, y: 200, w: 800, h: 500 });
  assert.deepEqual(model.rectFromDrag({ x: 10.4, y: 20.6 }, { x: 10.4, y: 20.6 }), { x: 10, y: 21, ...model.MIN_DRAWN_AREA });
  assert.deepEqual(model.rectFromDrag({ x: 0, y: 0 }, { x: 1000, y: 50 }), { x: 0, y: 0, w: 1000, h: model.MIN_DRAWN_AREA.h });
});

await test('tools: V, M, D, R pick one; never with a modifier or while typing; Esc goes back to Cursor after closing things', () => {
  assert.deepEqual(model.DESK_TOOLS.map((t) => [t.tool, t.key, t.icon]), [['cursor', 'V', 'pointer'], ['move', 'M', 'move'], ['draw', 'D', 'draw'], ['area', 'R', 'area']]);
  assert.equal(model.toolForKey({ key: 'r' }, false), 'area');
  assert.equal(model.toolCursor('area', false), 'crosshair');
  assert.equal(model.toolForKey({ key: 'v' }, false), 'cursor');
  assert.equal(model.toolForKey({ key: 'M' }, false), 'move');
  assert.equal(model.toolForKey({ key: 'd' }, false), 'draw');
  assert.equal(model.toolForKey({ key: 'd' }, true), null, 'typing into something');
  assert.equal(model.toolForKey({ key: 'd', metaKey: true }, false), null);
  assert.equal(model.toolForKey({ key: 'v', ctrlKey: true }, false), null);
  assert.equal(model.toolForKey({ key: 'm', altKey: true }, false), null);
  assert.equal(model.toolForKey({ key: 'x' }, false), null);
  assert.deepEqual(model.deskEscapeStep(['selection'], 'area', 'draw'), { kind: 'close', layer: 'selection' }, 'the innermost thing first');
  assert.deepEqual(model.deskEscapeStep([], 'area', 'draw'), { kind: 'tool', to: 'cursor' });
  assert.deepEqual(model.deskEscapeStep([], 'overview', 'move'), { kind: 'tool', to: 'cursor' });
  assert.deepEqual(model.deskEscapeStep([], 'area', 'cursor'), { kind: 'zoom', to: 'overview' }, 'then zoom out, as before');
  assert.deepEqual(model.deskEscapeStep([], 'overview', 'cursor'), { kind: 'none' });
  assert.equal(model.toolCursor('cursor', false), 'default');
  assert.equal(model.toolCursor('move', false), 'grab');
  assert.equal(model.toolCursor('move', true), 'grabbing');
  assert.equal(model.toolCursor('draw', false), 'crosshair');
});

await test('move: a drag in screen px is Desk px; a card lands in the Area under the pointer, kept inside it', () => {
  assert.deepEqual(model.dragDelta({ x: 10, y: 10 }, { x: 60, y: -10 }, 0.5), { x: 100, y: -40 });
  assert.equal(model.movedEnough({ x: 0, y: 0 }, { x: 2, y: 2 }), false, 'a click');
  assert.equal(model.movedEnough({ x: 0, y: 0 }, { x: 4, y: 0 }), true);
  const on = model.areasOnDesk(DESK);
  // Within its Area.
  assert.deepEqual(model.dropCard(C1, A1, { x: 100, y: 50 }, on, { x: 300, y: 300 }), { area_id: A1.id, x: 148, y: 146 });
  // Into A2 (x 1400): the same Desk spot, now relative to A2.
  const into = model.dropCard(C1, A1, { x: 1500, y: 100 }, on, { x: 1600, y: 300 });
  assert.deepEqual(into, { area_id: A2.id, x: 48 + 1500 - 1400, y: 196 });
  // Past the edge: clamped inside, below the name strip.
  assert.deepEqual(model.dropCard(C1, A1, { x: 5000, y: -500 }, on, { x: 700, y: 10 }), { area_id: A1.id, x: A1.w - 360, y: model.AREA_HEAD });
  // Dropped on bare Desk: back in its own Area.
  assert.equal(model.dropCard(C1, A1, { x: 1200, y: 0 }, on, { x: 1300, y: 300 }).area_id, A1.id, 'the gap between Areas');
  // Onto a stashed Area's old spot: not on the Desk, so its own.
  assert.equal(model.dropCard(C1, A1, { x: 0, y: 1000 }, on, { x: 100, y: 1200 }).area_id, A1.id);
  assert.deepEqual(model.dropArea(A2, { x: -100.4, y: 30.6 }), { x: 1300, y: 31 });
});

await test('edits: shown over the Desk until Hester has them, then dropped one by one', () => {
  assert.equal(model.withEdits(DESK, model.NO_EDITS), DESK, 'the same object with none');
  const S = { id: 'stk-0000000a', area_id: A1.id, points: [[0, 0], [5, 5]], width: 2, created_at: '' };
  const base = { ...DESK, strokes: [S] };
  const tmp = { ...S, id: 'tmp-1', area_id: null };
  const e = { cards: { [C1.id]: { area_id: A2.id, x: 10, y: 60 } }, areas: { [A2.id]: { x: 5, y: 6 } }, added: [tmp], removed: [S.id] };
  const shown = model.withEdits(base, e);
  const c1 = shown.cards.find((c) => c.id === C1.id);
  assert.deepEqual([c1.area_id, c1.x, c1.y, c1.title], [A2.id, 10, 60, C1.title]);
  assert.deepEqual([shown.areas[1].x, shown.areas[1].y, shown.areas[1].name], [5, 6, 'Board']);
  assert.deepEqual(shown.strokes.map((s) => s.id), ['tmp-1'], 'drawn in, deleted out');
  assert.equal(base.cards.find((c) => c.id === C1.id).area_id, A1.id, 'the Desk itself untouched');
  assert.deepEqual(model.withEdits({ ...DESK, strokes: undefined }, { ...model.NO_EDITS, added: [tmp] }).strokes, [tmp], 'an older Hester: no strokes yet');
  let left = model.dropEdit(e, { card: C1.id });
  assert.deepEqual(Object.keys(left.cards), []);
  left = model.dropEdit(left, { area: A2.id, added: 'tmp-1', removed: S.id });
  assert.deepEqual(left, model.NO_EDITS);
  assert.equal(model.dropEdit(e, { card: 'pg-00000000' }).cards, e.cards, 'nothing to drop');
});

await test('strokes: simplified within a screen pixel, capped, in the Area they start in, relative to it', () => {
  // A straight line of 100 points is its two ends.
  const straight = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 2 * i }));
  assert.deepEqual(model.simplifyPoints(straight, 0.5), [straight[0], straight[99]]);
  // A corner keeps its corner.
  const corner = [...Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: 0 })), ...Array.from({ length: 10 }, (_, i) => ({ x: 90, y: (i + 1) * 10 }))];
  assert.deepEqual(model.simplifyPoints(corner, 0.5), [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 100 }]);
  near(model.segmentDistance({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  near(model.segmentDistance({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 10);
  // Tolerance is a screen px: zoomed out (scale 0.1), a 5-Desk-px wobble goes.
  const wobble = Array.from({ length: 50 }, (_, i) => ({ x: 200 + i * 10, y: 300 + (i % 2) * 5 }));
  const far = model.strokeFromDrag(wobble, 0.1, model.areasOnDesk(DESK));
  const close = model.strokeFromDrag(wobble, 2, model.areasOnDesk(DESK));
  assert.equal(far.points.length, 2);
  assert.equal(close.points.length, 50, 'zoomed in, every wobble is kept');
  assert.equal(far.area_id, A1.id);
  assert.deepEqual(far.points[0], [200, 300], 'relative to A1 (at 0,0)');
  assert.equal(far.width, model.STROKE_WIDTH);
  // In A2: relative to its corner; on bare Desk: Desk-level, as drawn.
  const inA2 = model.strokeFromDrag([{ x: 1450.123, y: 100 }, { x: 1500, y: 150 }], 1, model.areasOnDesk(DESK));
  assert.deepEqual(inA2, { area_id: A2.id, points: [[50.12, 100], [100, 150]], width: model.STROKE_WIDTH });
  const bare = model.strokeFromDrag([{ x: 1300, y: 100 }, { x: 1500, y: 150 }], 1, model.areasOnDesk(DESK));
  assert.deepEqual(bare.area_id, null, 'starts in the gap: on the Desk, even if it crosses an Area');
  assert.deepEqual(bare.points, [[1300, 100], [1500, 150]]);
  // A click isn't a line.
  assert.equal(model.strokeFromDrag([{ x: 1, y: 1 }], 1, []), null);
  assert.equal(model.strokeFromDrag([{ x: 1, y: 1 }, { x: 1, y: 1 }], 1, []), null);
  // Hester's cap: a long, busy line is simplified until it fits.
  const busy = Array.from({ length: 6000 }, (_, i) => ({ x: i, y: (i % 2) * 3 }));
  assert.ok(model.strokeFromDrag(busy, 4, []).points.length <= 2000);
});

await test('strokes: back on the Desk from their Area, hidden when it is put away; a smoothed path', () => {
  const on = model.areasOnDesk(DESK);
  assert.deepEqual(model.strokeOnDesk({ area_id: A2.id, points: [[10, 20], [30, 40]] }, on), [{ x: 1410, y: 20 }, { x: 1430, y: 40 }]);
  assert.deepEqual(model.strokeOnDesk({ area_id: null, points: [[10, 20]] }, on), [{ x: 10, y: 20 }]);
  assert.equal(model.strokeOnDesk({ area_id: A3.id, points: [[10, 20]] }, on), null, 'put away');
  // Round trip: drawn in A2, back where it was drawn.
  const drawn = [{ x: 1450, y: 100 }, { x: 1600, y: 180 }];
  assert.deepEqual(model.strokeOnDesk(model.strokeFromDrag(drawn, 1, on), on), drawn);
  assert.equal(model.strokePath([]), '');
  assert.equal(model.strokePath([{ x: 0, y: 0 }, { x: 10.126, y: 5 }]), 'M0 0L10.13 5');
  assert.equal(model.strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), 'M0 0Q10 0 10 5L10 10');
});

// ---------------------------------------------------------------------------
// deskModel: landing, Esc, touched cards
// ---------------------------------------------------------------------------

const brief = { id: C1.id, kind: 'page', title: 'Mesh sync', area_id: A1.id, area_name: 'Mesh sync', purpose: null, last_touched_at: null };
const LAST = { card: brief, source: 'last', stopped_at: '…the clock', stopped_line: 3, arrived: { answers: 0, handoffs: 0, open_questions: 0, captured: 0 }, last_session: null };

await test('landing: DeskLast → the card and its line; no card → the overview; a bad line is null', () => {
  assert.deepEqual(model.landingFor(LAST), { kind: 'card', card_id: C1.id, area_id: A1.id, title: 'Mesh sync', line: 3 });
  assert.deepEqual(model.landingFor({ ...LAST, stopped_line: null }), { kind: 'card', card_id: C1.id, area_id: A1.id, title: 'Mesh sync', line: null });
  assert.deepEqual(model.landingFor({ ...LAST, stopped_line: 0 }).line, null);
  assert.deepEqual(model.landingFor({ ...LAST, card: null }), { kind: 'overview' });
  assert.deepEqual(model.landingFor(null), { kind: 'overview' });
});

await test('landing cursor: the end of the stopped-at line × a saved cursor × no line', () => {
  const text = '# Mesh\n\nVector clocks drift.\nLast line';
  assert.equal(model.lineEnd(text, 3), '# Mesh\n\nVector clocks drift.'.length);
  assert.equal(model.lineEnd(text, 99), text.length, 'past the end → the last line');
  assert.equal(model.lineEnd(text, 1), 6);
  const saved = { anchor: 2, head: 4, scroll: 120 };
  const withLine = model.landingCursor(text, 3, saved);
  const end3 = '# Mesh\n\nVector clocks drift.'.length;
  assert.deepEqual(withLine, { cursor: { anchor: end3, head: end3, scroll: 0 }, reveal: true }, 'the line wins over the saved cursor');
  assert.deepEqual(model.landingCursor(text, null, saved), { cursor: saved, reveal: false });
  assert.deepEqual(model.landingCursor('ab', null, { anchor: 9, head: 9, scroll: 0 }).cursor, { anchor: 2, head: 2, scroll: 0 }, 'clamped to the text');
  assert.deepEqual(model.landingCursor(text, null, null), { cursor: { anchor: text.length, head: text.length, scroll: 0 }, reveal: true }, 'else the end of the Page');
});

await test('Esc: the innermost open thing first, then zoom out; handled Escs do nothing', () => {
  assert.deepEqual(model.escapeStep([], 'card'), { kind: 'zoom', to: 'overview' });
  assert.deepEqual(model.escapeStep([], 'area'), { kind: 'zoom', to: 'overview' });
  assert.deepEqual(model.escapeStep([], 'overview'), { kind: 'none' });
  assert.deepEqual(model.escapeStep(['popover', 'row', 'picker'], 'card'), { kind: 'close', layer: 'picker' });
  assert.deepEqual(model.escapeStep(new Set(['selection', 'source']), 'card'), { kind: 'close', layer: 'source' });
  assert.deepEqual(model.escapeStep(['drawer', 'sheet'], 'overview'), { kind: 'close', layer: 'sheet' });
  assert.deepEqual(model.escapeStep(['drawer'], 'overview'), { kind: 'close', layer: 'drawer' });
  assert.deepEqual(model.escapeStep([], 'card', true), { kind: 'none' }, 'CodeMirror or a field already took it');
});

await test('touched cards: first-touched order, no repeats, a new session starts fresh, drafts renamed in place', () => {
  let t = model.NO_TOUCHED;
  t = model.touchCard(t, 's1', 'pg-00000001');
  t = model.touchCard(t, 's1', 'pg-00000002');
  const same = model.touchCard(t, 's1', 'pg-00000001');
  assert.equal(same, t, 'a repeat changes nothing');
  t = model.touchCard(t, 's1', 'draft-x');
  assert.deepEqual(t, { session_id: 's1', cards: ['pg-00000001', 'pg-00000002'] }, 'drafts are not cards');
  t = model.touchCard(t, 's1', 'pg-00000003');
  assert.deepEqual(t.cards, ['pg-00000001', 'pg-00000002', 'pg-00000003']);
  assert.deepEqual(model.touchCard(t, 's2', 'pg-00000009'), { session_id: 's2', cards: ['pg-00000009'] });
  assert.deepEqual(model.touchCard(t, 's2', null), { session_id: 's2', cards: [] });
  const r = model.renameTouched({ session_id: 's1', cards: ['pg-00000001', 'draft-1', 'pg-00000002'] }, 'draft-1', 'pg-00000005');
  assert.deepEqual(r.cards, ['pg-00000001', 'pg-00000005', 'pg-00000002']);
  assert.deepEqual(model.parseTouched({ session_id: 's', cards: ['pg-00000001', 'nope', 'pg-00000001', 3] }), { session_id: 's', cards: ['pg-00000001'] });
  assert.deepEqual(model.parseTouched('x'), model.NO_TOUCHED);
});

// ---------------------------------------------------------------------------
// deskModel: drawers, cards, local memory
// ---------------------------------------------------------------------------

await test('drawer counts and the Stashed order', () => {
  assert.deepEqual(model.drawerCounts(DESK), { ideas: 3, stashed: 2 });
  assert.deepEqual(model.drawerCounts({ drawers: [], areas: [A1, A3] }), { ideas: 0, stashed: 1 }, 'no Drawer rows: counted from the Areas');
  assert.deepEqual(model.stashedAreas(DESK).map((a) => a.id), [A4.id, A3.id], "the Drawer's order");
  assert.deepEqual(
    model.stashedAreas({ drawers: [], areas: [A3, A4, A1] }).map((a) => a.id),
    [A4.id, A3.id],
    'unlisted: most recently changed first',
  );
});

await test('a card: the quiet count line, and the ember only for a waiting hand-off', () => {
  assert.equal(model.cardCountLine(summary), '');
  assert.equal(
    model.cardCountLine({ answers_unread: 2, answers_pending: 1, handoffs_in_flight: 1, open_questions: 3 }),
    '1 ask running · 2 answers new · 1 hand-off · 3 questions',
  );
  const ids = model.waitingCardIds([
    { status: 'waiting', origin: { kind: 'page', ref: 'pg-00000002#ans-1' } },
    { status: 'waiting', origin: { kind: 'exploration', ref: 'exp-1a2b3c4d#ans-2' } },
    { status: 'running', origin: { kind: 'page', ref: 'pg-00000003#ans-3' } },
    { status: 'waiting', origin: { kind: 'launcher', ref: null } },
    { status: 'waiting', origin: null },
  ]);
  assert.deepEqual([...ids].sort(), ['pg-00000002', 'pg-1a2b3c4d']);
});

await test('local memory: exp-<hex> → pg-<hex> for the Deep record, its cursors and the Page mirrors', () => {
  const m = model.migrateDeepMemory({ exploration_id: 'exp-1a2b3c4d', title: 'Mesh', view: 'page', cursors: { 'exp-1a2b3c4d': { anchor: 1 }, 'draft-1': { anchor: 2 } } });
  assert.equal(m.changed, true);
  assert.deepEqual(m.next, { exploration_id: 'pg-1a2b3c4d', card_id: 'pg-1a2b3c4d', title: 'Mesh', view: 'page', cursors: { 'pg-1a2b3c4d': { anchor: 1 }, 'draft-1': { anchor: 2 } } });
  assert.equal(model.migrateDeepMemory(m.next).changed, false, 'running it again changes nothing');
  assert.equal(model.migrateDeepMemory({ exploration_id: 'exp-legacy', title: '' }).changed, false, 'not a hex id: left alone');
  assert.deepEqual(model.migrateDeepMemory(null), { changed: false, next: {} });
  const keys = [`lee:deep:page:${WS}:exp-1a2b3c4d`, `lee:deep:page:${WS}:exp-00000002`, `lee:deep:page:${WS}:pg-00000002`, `lee:deep:page:/other:exp-00000003`, 'lee:deep:x'];
  assert.deepEqual(model.mirrorKeyMoves(keys, WS), [{ from: `lee:deep:page:${WS}:exp-1a2b3c4d`, to: `lee:deep:page:${WS}:pg-1a2b3c4d` }], 'an existing card mirror is not overwritten; other workspaces untouched');
  assert.equal(model.asCardId('exp-1a2b3c4d'), 'pg-1a2b3c4d');
  assert.equal(model.asCardId('pg-1a2b3c4d'), 'pg-1a2b3c4d');
  assert.equal(model.asCardId('draft-x'), 'draft-x');
});

// ---------------------------------------------------------------------------
// hesterDesk: every route
// ---------------------------------------------------------------------------

function scoped(call) {
  const u = new URL(call.url);
  assert.equal(u.origin, 'http://127.0.0.1:9000');
  assert.equal(u.searchParams.get('workspace'), WS);
  assert.equal(call.headers['X-Lee-Workspace'], '/Users/ben/D%C3%A9veloppement/my proj', 'non-ASCII percent-encoded');
  assert.equal(call.headers.Authorization, 'Bearer tok-1');
  return u;
}

await test('hesterDesk: every route, method, path, body; workspace and token on each', async () => {
  const P = 'pg-1a2b3c4d';
  const A = 'area-1a2b3c4d';
  const cases = [
    [() => desk.getDesk(WS), 'GET', '/desk', undefined],
    [() => desk.migrateDesk(WS), 'POST', '/desk/migrate', {}],
    [() => desk.getDeskLast(WS), 'GET', '/desk/last', undefined],
    [() => desk.putDeskLast(WS, P), 'PUT', '/desk/last', { card_id: P }],
    [() => desk.createArea(WS, { name: 'Mesh' }), 'POST', '/desk/areas', { name: 'Mesh' }],
    [() => desk.patchArea(WS, A, { name: 'Mesh 2', x: 10 }), 'PATCH', `/desk/areas/${A}`, { name: 'Mesh 2', x: 10 }],
    [() => desk.deleteArea(WS, A), 'DELETE', `/desk/areas/${A}`, undefined],
    [() => desk.stashArea(WS, A), 'POST', `/desk/areas/${A}/stash`, {}],
    [() => desk.stashArea(WS, A, 'drw-00000001'), 'POST', `/desk/areas/${A}/stash`, { drawer_id: 'drw-00000001' }],
    [() => desk.unstashArea(WS, A), 'POST', `/desk/areas/${A}/unstash`, {}],
    [() => desk.unstashArea(WS, A, { x: 1, y: 2 }), 'POST', `/desk/areas/${A}/unstash`, { x: 1, y: 2 }],
    [() => desk.createDrawer(WS, 'Later'), 'POST', '/desk/drawers', { name: 'Later' }],
    [() => desk.patchDrawer(WS, 'drw-00000001', 'Soon'), 'PATCH', '/desk/drawers/drw-00000001', { name: 'Soon' }],
    [() => desk.patchCard(WS, P, { x: 5, y: 6 }), 'PATCH', `/desk/cards/${P}`, { x: 5, y: 6 }],
    [() => desk.patchCard(WS, P, { area_id: A, x: 5, y: 60 }), 'PATCH', `/desk/cards/${P}`, { area_id: A, x: 5, y: 60 }],
    [() => desk.createStroke(WS, { area_id: A, points: [[0, 0], [1, 2]], width: 2 }), 'POST', '/desk/strokes', { area_id: A, points: [[0, 0], [1, 2]], width: 2 }],
    [() => desk.createStroke(WS, { area_id: null, points: [[0, 0], [1, 2]] }), 'POST', '/desk/strokes', { area_id: null, points: [[0, 0], [1, 2]] }],
    [() => desk.deleteStroke(WS, 'stk-0000000a'), 'DELETE', '/desk/strokes/stk-0000000a', undefined],
    [() => desk.createDeskPage(WS, { area_id: A, x: 1, y: 2, text: 'hi' }), 'POST', '/desk/pages', { area_id: A, x: 1, y: 2, text: 'hi' }],
    [() => desk.getDeskPage(WS, P), 'GET', `/desk/pages/${P}`, undefined],
    [() => desk.patchDeskPage(WS, P, { title: 'T' }), 'PATCH', `/desk/pages/${P}`, { title: 'T' }],
    [() => desk.deleteDeskPage(WS, P), 'DELETE', `/desk/pages/${P}`, undefined],
    [() => desk.listDeskSessions(WS), 'GET', '/desk/sessions', undefined],
    [() => desk.listDeskSessions(WS, 5), 'GET', '/desk/sessions', undefined, { limit: '5' }],
    [() => desk.ideaToPage(WS, 'sd-1'), 'POST', '/desk/ideas/sd-1/page', {}],
    [() => desk.ideaToPage(WS, 'sd-1', { area_id: A, x: 3, y: 4 }), 'POST', '/desk/ideas/sd-1/page', { area_id: A, x: 3, y: 4 }],
    // A Page card's own routes, through hesterDeep by card id.
    [() => desk.getCardPage(WS, P), 'GET', `/desk/pages/${P}/page`, undefined],
    [() => desk.putCardPage(WS, P, 'x', 'v1'), 'PUT', `/desk/pages/${P}/page`, { text: 'x', base_version: 'v1' }],
    [() => desk.listCardReferences(WS, P), 'GET', `/desk/pages/${P}/references`, undefined],
    [() => desk.addCardReference(WS, P, { kind: 'quote', quote: 'q' }), 'POST', `/desk/pages/${P}/references`, { kind: 'quote', quote: 'q' }],
    [() => desk.patchCardReference(WS, P, 'ref-1', { opened: true }), 'PATCH', `/desk/pages/${P}/references/ref-1`, { opened: true }],
    [() => desk.listCardAnswers(WS, P), 'GET', `/desk/pages/${P}/answers`, undefined],
    [() => desk.patchCardAnswer(WS, P, 'ans-1', { read: true }), 'PATCH', `/desk/pages/${P}/answers/ans-1`, { read: true }],
    [() => desk.retryCardAnswer(WS, P, 'ans-1'), 'POST', `/desk/pages/${P}/answers/ans-1/retry`, {}],
    [() => desk.askCard(WS, P, { question: 'Why?', anchor: { kind: 'none' }, section_text: 'S' }), 'POST', `/desk/pages/${P}/asks`, { question: 'Why?', anchor: { kind: 'none' }, section_text: 'S' }],
    [() => desk.createCardHandoff(WS, P, { kind: 'spike', provider: 'claude', brief: 'b', anchor: { kind: 'none' } }), 'POST', `/desk/pages/${P}/handoffs`, { kind: 'spike', provider: 'claude', brief: 'b', anchor: { kind: 'none' } }],
    [() => desk.listCardQuestions(WS, P), 'GET', `/desk/pages/${P}/questions`, undefined],
    [() => desk.addCardQuestion(WS, P, { text: 'Q?', source: 'page' }), 'POST', `/desk/pages/${P}/questions`, { text: 'Q?', source: 'page' }],
    [() => desk.patchCardQuestion(WS, P, 'q-1', 'closed'), 'PATCH', `/desk/pages/${P}/questions/q-1`, { status: 'closed' }],
    [() => desk.draftCardFromReadme(WS, P), 'POST', `/desk/pages/${P}/draft-from-readme`, {}],
    [() => deep.deleteExploration(WS, P), 'DELETE', `/desk/pages/${P}`, undefined],
  ];
  replyFor = (_url, init) => (init.method === 'PUT' ? { status: 200, body: { success: true, data: { version: 'v2' } } } : null);
  for (const [run, method, path, body, query] of cases) {
    calls.length = 0;
    await run();
    assert.equal(calls.length, 1, path);
    const u = scoped(calls[0]);
    assert.equal(calls[0].method, method, path);
    assert.equal(u.pathname, path);
    assert.deepEqual(calls[0].body, body, path);
    if (body !== undefined) assert.equal(calls[0].headers['Content-Type'], 'application/json');
    for (const [k, v] of Object.entries(query ?? {})) assert.equal(u.searchParams.get(k), v);
  }
});

await test('hesterDesk: the envelope unwrapped; 404 from an old Hester; 409s keep their body; offline', async () => {
  reply = { status: 200, body: { success: true, data: DESK, workspace: WS, workspace_id: 'w1' } };
  assert.deepEqual(await desk.getDesk(WS), { ok: true, data: DESK });
  reply = { status: 404, body: { success: false, error: 'not found' } };
  const old = await desk.getDesk(WS);
  assert.equal(old.ok, false);
  assert.equal(old.status, 404);
  reply = { status: 409, body: { success: false, error: 'not_empty' } };
  const busy = await desk.deleteArea(WS, 'area-1a2b3c4d');
  assert.equal(busy.status, 409);
  assert.equal(busy.error, 'not_empty');
  reply = { status: 409, body: { success: false, error: 'version_conflict', data: { version: 'v9', text: 'theirs' } } };
  assert.deepEqual(await deep.putPage(WS, 'pg-1a2b3c4d', 'mine', 'v1'), { ok: false, conflict: { version: 'v9', text: 'theirs' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const off = await desk.getDeskLast(WS);
    assert.equal(off.ok, false);
    assert.equal(off.status, undefined, 'offline has no status');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// hesterDeep: card forms
// ---------------------------------------------------------------------------

await test('pageRoute: pg ids go to /desk/pages, exploration ids stay on their routes', () => {
  assert.equal(deep.pageRoute('pg-1a2b3c4d', '/page'), '/desk/pages/pg-1a2b3c4d/page');
  assert.equal(deep.pageRoute('exp-1a2b3c4d', '/page'), '/cockpit/explorations/exp-1a2b3c4d/page');
  assert.equal(deep.isCardId('pg-1a2b3c4d'), true);
  assert.equal(deep.isCardId('pg-xyz'), false);
});

await test('hand-offs from a card: origin page, "From the Page" in the brief; explorations unchanged', () => {
  const req = deep.handoffLaunchRequest({ workspace: WS, kind: 'spike', provider: 'claude', brief: 'b', explorationId: 'pg-1a2b3c4d', answerId: 'ans-2', title: 'Board' });
  assert.deepEqual(req.origin, { kind: 'page', ref: 'pg-1a2b3c4d#ans-2' });
  const old = deep.handoffLaunchRequest({ workspace: WS, kind: 'spike', provider: 'claude', brief: 'b', explorationId: 'exp-1a2b3c4d', answerId: 'ans-2', title: 'Board' });
  assert.deepEqual(old.origin, { kind: 'exploration', ref: 'exp-1a2b3c4d#ans-2' });
  assert.equal(deep.handoffFromLine('Board', 'pg-1a2b3c4d'), "From the Page 'Board' (pg-1a2b3c4d)");
  assert.equal(deep.handoffFromLine('Board', 'exp-1a2b3c4d'), "From the exploration 'Board' (exp-1a2b3c4d)");
});

await test('an in-memory card: its create body places it (or makes the Goals card), with the Page as written', () => {
  const d = { workspace: WS, title: 'Untitled · Sep 27', page: '', sendTitle: true, origin: { kind: 'cockpit' }, desk: { area_id: 'area-1a2b3c4d', x: 48, y: 96 } };
  assert.deepEqual(deep.deskCreateBody(d, 'Hello'), { area_id: 'area-1a2b3c4d', x: 48, y: 96, title: 'Untitled · Sep 27', text: 'Hello' });
  const goals = { ...d, title: 'Goals', purpose: 'goals', desk: { area_id: null } };
  assert.deepEqual(deep.deskCreateBody(goals, 'For me'), { purpose: 'goals', title: 'Goals', text: 'For me' });
  const from = { ...d, sendTitle: false, desk: { area_id: null, from: { card_id: 'pg-1a2b3c4d' } } };
  assert.deepEqual(deep.deskCreateBody(from, 'x'), { from: { card_id: 'pg-1a2b3c4d' }, text: 'x' });
});

await test('palette: about page from a zoomed card only', () => {
  const at = (zoom, card_id) => ({ mode: 'deep', deep: { zoom, card_id, title: 'Mesh sync' } });
  assert.deepEqual(palette.deskAboutFor(at('card', 'pg-1a2b3c4d')), { kind: 'page', id: 'pg-1a2b3c4d', label: 'Mesh sync' });
  assert.equal(palette.deskAboutFor(at('overview', 'pg-1a2b3c4d')), null);
  assert.equal(palette.deskAboutFor(at('card', 'draft-1')), null, 'an in-memory Page has no card yet');
  assert.equal(palette.deskAboutFor({ mode: 'cockpit', deep: { zoom: 'card', card_id: 'pg-1a2b3c4d', title: '' } }), null);
  assert.equal(palette.aboutLine({ kind: 'page', label: 'Mesh sync' }).kind, 'Page');
});

// ---------------------------------------------------------------------------
// The cockpitMode store's Desk seam
// ---------------------------------------------------------------------------

{
  const mode = await bundle('../src/renderer/components/cockpit/cockpitMode.ts', 'cockpitMode', 'node');
  const store = mode.cockpitModeStore;
  store.configure(true);
  store.useWorkspace(WS);

  await test('zoomIntoCard: nav, desk.zoom, the session on the card, the touched list; zoomOut keeps the session', async () => {
    logged.length = 0;
    started.length = 0;
    await mode.zoomIntoCard({ card_id: 'pg-00000001', title: 'One', area_id: 'area-00000001' }, 'click');
    assert.deepEqual(store.getDeep(), { exploration_id: 'pg-00000001', card_id: 'pg-00000001', title: 'One', view: 'page', zoom: 'card', area_id: 'area-00000001' });
    assert.deepEqual(logged.at(-1), { type: 'desk.zoom', data: { card_id: 'pg-00000001', card_kind: 'page', via: 'click' } });
    assert.deepEqual(started.at(-1), { workspace: WS, exploration_id: null, card_id: 'pg-00000001', card_kind: 'page', title: 'One', surface: 'lee' });
    await mode.zoomIntoCard({ card_id: 'pg-00000001', title: 'One' }, 'key');
    assert.equal(started.length, 1, 'the same card: no new deepStart');
    mode.zoomOut('overview', 'key');
    assert.equal(store.getDeep().zoom, 'overview');
    assert.equal(store.getDeep().card_id, 'pg-00000001', 'the card stays this window’s');
    assert.deepEqual(logged.at(-1), { type: 'desk.zoom', data: { card_id: null, card_kind: null, via: 'key' } });
    assert.equal(started.length, 1, 'zooming out starts nothing');
    await mode.zoomIntoCard({ card_id: 'pg-00000002', title: 'Two' }, 'click');
    assert.equal(started.length, 2);
    assert.deepEqual(mode.touchedCards('fs-1'), ['pg-00000001', 'pg-00000002']);
    mode.zoomToArea('area-00000002');
    assert.deepEqual([store.getDeep().zoom, store.getDeep().area_id], ['area', 'area-00000002']);
  });

  await test('an in-memory Page promoted: nav and the touched list follow it', async () => {
    await mode.zoomIntoCard({ card_id: 'draft-zz', title: 'Untitled' }, 'click');
    assert.equal(started.at(-1).card_id, null, 'an in-memory Page starts the session with no card');
    mode.promoteCard('draft-zz', 'pg-00000003', 'Three', 'area-00000002');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(store.getDeep().card_id, 'pg-00000003');
    assert.deepEqual(mode.touchedCards('fs-1'), ['pg-00000001', 'pg-00000002', 'pg-00000003']);
  });

  await test('openDesk: last (with its line) → a landing for the surface; overview; a card; goals creates the card', async () => {
    replyFor = (url) => (url.includes('/desk/last') ? { status: 200, body: { success: true, data: LAST } } : null);
    await mode.openDesk(null, WS, { kind: 'last' });
    assert.equal(store.get().mode, 'deep');
    assert.equal(store.getDeep().card_id, C1.id);
    assert.equal(store.getDeep().zoom, 'card');
    assert.deepEqual({ ...store.get().deskLand, nonce: 0 }, { card_id: C1.id, line: 3, nonce: 0 });
    store.clearDeskLand(store.get().deskLand.nonce);
    assert.equal(store.get().deskLand, null);
    await mode.openDesk(null, WS, { kind: 'overview' });
    assert.equal(store.getDeep().zoom, 'overview');
    await mode.openDesk(null, WS, { kind: 'card', card_id: 'exp-00000002', line: 7 });
    assert.equal(store.getDeep().card_id, 'pg-00000002', 'an exploration id maps to its card');
    assert.equal(store.get().deskLand.line, 7);
    calls.length = 0;
    replyFor = (url, init) =>
      url.includes('/desk/pages') && init.method === 'POST'
        ? { status: 201, body: { success: true, data: { card: { ...G, title: 'Goals' }, page: { text: 'For me\n\n', version: 'v1' }, created: true } } }
        : { status: 200, body: { success: true, data: { ...DESK, goals_card_id: null } } };
    await mode.openDesk(null, WS, { kind: 'goals', first_line: 'For me' });
    const post = calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.body, { purpose: 'goals', text: 'For me\n\n' });
    assert.equal(store.getDeep().card_id, G.id);
  });

  await test('landing on an old Hester (404): the overview', async () => {
    store.set('cockpit', 'hop');
    replyFor = () => ({ status: 404, body: { success: false, error: 'not found' } });
    await mode.openDesk(null, WS, { kind: 'last' });
    assert.equal(store.getDeep().zoom, 'overview');
    store.set('cockpit', 'hop');
  });
}

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
