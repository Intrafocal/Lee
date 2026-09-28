#!/usr/bin/env node
/**
 * Smoke test for Send to Lee's delivery logic in the renderer
 * (docs/plans/2026-09-28-tether-review-voice.md §4.3, §4.4), lib/tetherModel.ts:
 *
 * - checkSend: submit only for tabs and Hester, and only with text; Board
 *   isn't built.
 * - Target resolution (buildSendTargets): the zoomed Page, else the open
 *   palette, else the focused PTY tab; the rest without repeats; tab kinds.
 * - Insertion text (pageInsertion): its own paragraph after the cursor's
 *   line, blank lines only where needed, the end when the Page isn't open;
 *   Undo finds it while unchanged (findInsertion / removeInsertion).
 * - Images: `![caption](assets/…)` in (imageMarkdown) and out (parsePageImages).
 * - Inbox paths and what's pasted into a tab (tabPasteText), the palette's
 *   question, and the chip's line.
 *
 * Bundles the real source with esbuild; no Hester, React or DOM needed.
 *
 * Run: node scripts/tether-send-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function bundle(rel, name) {
  const built = await esbuild.build({ entryPoints: [join(__dirname, rel)], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const dir = mkdtempSync(join(__dirname, `.tether-smoke-${name}-`));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, built.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`not ok - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const m = await bundle('../src/renderer/lib/tetherModel.ts', 'model');

const PAGE = { kind: 'page', card_id: 'pg-0000abcd', title: 'Taxonomy' };
const HESTER = { kind: 'hester' };
const TAB = { kind: 'tab', pty_id: 7, label: 'Claude', tab_kind: 'agent', provider: 'claude' };
const BOARD = { kind: 'board', card_id: 'pg-0000beef', title: 'Board' };
const text = (t, extra = {}) => ({ kind: 'text', text: t, ...extra });
const photo = (extra = {}) => ({ kind: 'image', mime: 'image/png', data_b64: 'iVBORw0KGgo=', source: 'photo', ...extra });

test('checkSend: submit only for tabs and Hester; Hester needs text, a tab takes an image alone', () => {
  assert.deepEqual(m.checkSend(TAB, [text('ls')], true), { ok: true });
  assert.deepEqual(m.checkSend(HESTER, [text('why?')], true), { ok: true });
  assert.deepEqual(m.checkSend(PAGE, [text('note')], true), { ok: false, error: 'submit_not_allowed' }, 'a Page has only Deliver');
  assert.deepEqual(m.checkSend(TAB, [photo()], true), { ok: true }, 'a tab takes an image alone: its path, then Enter');
  assert.deepEqual(m.checkSend(HESTER, [photo()], true), { ok: false, error: 'submit_not_allowed' }, 'Hester needs a question');
  assert.deepEqual(m.checkSend(TAB, [text('   ')], true), { ok: false, error: 'submit_not_allowed' }, 'blank text is no text');
  assert.deepEqual(m.checkSend(PAGE, [text('note')], false), { ok: true });
  assert.deepEqual(m.checkSend(PAGE, [photo()], undefined), { ok: true });
  assert.deepEqual(m.checkSend(BOARD, [text('x')], false), { ok: false, error: 'board_not_built' });
  assert.deepEqual(m.checkSend(TAB, [], false), { ok: false, error: 'no_items' });
});

test('targets: the zoomed Page is the focus, then the palette, then the focused PTY tab', () => {
  const tabs = [
    { ptyId: 7, label: 'Claude', type: 'agent', provider: 'claude' },
    { ptyId: 9, label: 'zsh', type: 'terminal', provider: null },
    { ptyId: 11, label: 'lazygit', type: 'git' },
    { ptyId: null, label: 'main.py', type: 'file' },
    { ptyId: 12, label: 'claude (by hand)', type: 'terminal', provider: 'claude' },
  ];
  const touched = [{ card_id: 'pg-00000001', title: 'Old' }, { card_id: PAGE.card_id, title: 'Taxonomy' }];
  const a = m.buildSendTargets({ zoomedPage: { card_id: PAGE.card_id, title: 'Taxonomy' }, paletteOpen: true, focusedPtyId: 7, touchedPages: touched, tabs });
  assert.deepEqual(a.focus, PAGE);
  assert.deepEqual(a.targets.map((t) => t.kind + ':' + (t.card_id ?? t.pty_id ?? '')), ['page:pg-00000001', 'hester:', 'tab:7', 'tab:9', 'tab:11', 'tab:12'], 'the zoomed Page is not repeated');
  assert.deepEqual(a.targets.find((t) => t.pty_id === 11).tab_kind, 'tui');
  assert.deepEqual(a.targets.find((t) => t.pty_id === 9).tab_kind, 'terminal');
  assert.deepEqual(a.targets.find((t) => t.pty_id === 12).tab_kind, 'agent', 'a terminal running an agent is an agent');
  const b = m.buildSendTargets({ zoomedPage: null, paletteOpen: true, focusedPtyId: 7, touchedPages: [], tabs });
  assert.deepEqual(b.focus, HESTER);
  assert.ok(!b.targets.some((t) => t.kind === 'hester'), 'Hester once');
  const c = m.buildSendTargets({ zoomedPage: null, paletteOpen: false, focusedPtyId: 7, touchedPages: [], tabs });
  assert.deepEqual(c.focus, TAB);
  assert.ok(!c.targets.some((t) => t.kind === 'tab' && t.pty_id === 7), 'the focus tab once');
  const d = m.buildSendTargets({ zoomedPage: null, paletteOpen: false, focusedPtyId: null, touchedPages: [], tabs: [] });
  assert.deepEqual(d, { focus: null, targets: [HESTER] });
});

test('page insertion: its own paragraph after the cursor line, blank lines only where needed', () => {
  const doc = '# Mesh\n\nWrites carry a clock.\n\nLast writer wins.';
  // Cursor mid-way through "Writes carry…": after that line, never splitting it.
  const at = doc.indexOf('carry');
  const ins = m.pageInsertion(doc, at, 'From the phone');
  const out = doc.slice(0, ins.from) + ins.insert + doc.slice(ins.from);
  assert.equal(out, '# Mesh\n\nWrites carry a clock.\n\nFrom the phone\n\nLast writer wins.');
  assert.equal(out.slice(ins.textFrom, ins.textTo), 'From the phone');
  // No cursor: the end, with a blank line before and a newline after.
  const end = m.pageInsertion(doc, null, 'At the end\n\n');
  assert.equal(doc + end.insert, `${doc}\n\nAt the end\n`, 'trailing whitespace trimmed');
  // An empty Page: just the text.
  assert.deepEqual(m.pageInsertion('', null, 'First'), { from: 0, insert: 'First\n', textFrom: 0, textTo: 5 });
  // On a blank line between paragraphs: no extra blank lines.
  const gap = 'A\n\nB';
  const g = m.pageInsertion(gap, 2, 'mid');
  assert.equal(gap.slice(0, g.from) + g.insert + gap.slice(g.from), 'A\n\nmid\n\nB');
  // A doc ending in a newline.
  const nl = m.pageInsertion('Para\n', null, 'x');
  assert.equal('Para\n' + nl.insert, 'Para\n\nx\n');
});

test('undo: finds the insertion while unchanged, even moved; not once edited', () => {
  const doc = 'Top\n\nBottom';
  const ins = m.pageInsertion(doc, 0, 'Sent');
  const after = doc.slice(0, ins.from) + ins.insert + doc.slice(ins.from);
  assert.equal(m.removeInsertion(after, ins), doc, 'in place');
  const moved = 'New line above\n' + after;
  assert.equal(m.removeInsertion(moved, ins), 'New line above\n' + doc, 'edits above moved it');
  const edited = after.replace('Sent', 'Sent, then edited');
  assert.equal(m.removeInsertion(edited, ins), null, 'changed: no undo');
  const twice = after + ins.insert;
  assert.equal(m.findInsertion(twice.replace(ins.insert, 'X' + ins.insert), ins), null, 'ambiguous when it appears twice elsewhere');
});

test('images: markdown in, the Page’s own images out', () => {
  assert.equal(m.imageMarkdown('A [whiteboard]\nsketch', 'assets/ab12.png'), '![A whiteboard sketch](assets/ab12.png)');
  assert.equal(m.imageMarkdown(undefined, 'assets/x.jpg'), '![](assets/x.jpg)');
  const line = 'See ![board](assets/ab12.png) and ![](assets/c-3.jpeg) but not ![web](https://x.io/a.png) or ![bad](assets/../x.png)';
  const got = m.parsePageImages(line);
  assert.deepEqual(got.map((g) => [g.alt, g.path, g.name]), [['board', 'assets/ab12.png', 'ab12.png'], ['', 'assets/c-3.jpeg', 'c-3.jpeg']]);
  assert.equal(line.slice(got[0].from, got[0].to), '![board](assets/ab12.png)');
  assert.equal(m.extForMime('image/jpeg'), 'jpg');
  assert.equal(m.extForMime('image/png'), 'png');
});

test('tabs: inbox paths, the paste text, and the palette question', () => {
  assert.equal(m.inboxFileName('snd_01AB', 1, 'image/png'), 'snd_01AB-1.png');
  assert.equal(m.inboxFileName('../../etc', 2, 'image/jpeg'), 'etc-2.jpg', 'the id keeps to safe characters');
  assert.equal(m.inboxPath('/Users/ben/', 'snd_1', 1, 'image/png'), '/Users/ben/.lee/inbox/snd_1-1.png');
  const items = [text('Look at this:'), photo(), photo({ source: 'screenshot' })];
  assert.equal(m.tabPasteText(items, [null, '/Users/ben/.lee/inbox/s-1.png', '/tmp/with space/s-2.png']), 'Look at this: /Users/ben/.lee/inbox/s-1.png "/tmp/with space/s-2.png"');
  assert.equal(m.tabPasteText([text('line one\nline two\n')], [null]), 'line one\nline two', 'multi-line text as one piece, trailing newline dropped (Enter is only Send)');
  assert.equal(m.tabPasteText([photo()], [null]), '', 'an image that could not be saved adds nothing');
  assert.equal(m.paletteQuestion([text(' why is this slow? '), photo(), text('and this')]), 'why is this slow?\n\nand this');
});

test('the chip: device, what, where; none for compose', () => {
  assert.equal(m.chipLine('aeronaut', [photo()], PAGE), 'From your phone: photo → Taxonomy');
  assert.equal(m.chipLine('dirigible', [text('hi', { input: 'voice' })], HESTER), 'From the T-Deck: voice note → Hester');
  assert.equal(m.chipLine(null, [text('a'), photo({ source: 'scribble' }), text('b')], TAB), 'From a device: text + scribble → Claude');
  assert.equal(m.showsChip({ target: TAB, compose: true }), false);
  assert.equal(m.showsChip({ target: TAB }), true);
  assert.equal(m.CHIP_MS, 8000);
});

console.log(`\n${passed} passed`);
