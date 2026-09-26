#!/usr/bin/env node
/**
 * Smoke test for the pure Deep renderer model (src/renderer/lib/deepModel.ts,
 * Deep D1 §4, §5, §7, §9): deepRowKey, affordanceFor over the pattern table
 * with negative cases, last-sentence extraction for "Where did you stop?",
 * anchor re-location (moved quote, missing quote → section, then top),
 * Insert's blockquote, the Answers tray and the wake line. Compiles the real
 * source with esbuild, no React, no DOM.
 *
 * Run: node scripts/deep-renderer-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/renderer/lib/deepModel.ts');

const result = await esbuild.build({ entryPoints: [srcPath], bundle: false, format: 'esm', platform: 'node', write: false });
const code = result.outputFiles[0].text;
assert.ok(!/^\s*import\s/m.test(code), 'deepModel.ts must have type-only imports (pure)');

const tmpDir = mkdtempSync(join(tmpdir(), 'lee-deep-smoke-'));
const tmpFile = join(tmpDir, 'deepModel.mjs');
writeFileSync(tmpFile, code);
let mod;
try {
  mod = await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const {
  deepRowKey,
  affordanceFor,
  urlsIn,
  markdownLinkTitle,
  isBareUrl,
  lastSentence,
  sectionAt,
  anchorFor,
  locateAnchor,
  contextAround,
  answerInsertion,
  attributionDate,
  answersTray,
  markerState,
  isPending,
  isUnread,
  pageMirrorKey,
  deepMemoryKey,
  matchExploration,
  untitledTitle,
  saveBackoffMs,
  wokenItem,
  waitingCount,
  AFFORDANCE_DELAY_MS,
  AFFORDANCE_FADE_MS,
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

// ---------------------------------------------------------------------------
// §5 the action row
// ---------------------------------------------------------------------------

test('deepRowKey: c k a e pick, Esc returns, arrows move, modifiers and other keys ignored', () => {
  assert.deepEqual(deepRowKey('c'), { kind: 'action', action: 'capture' });
  assert.deepEqual(deepRowKey('k'), { kind: 'action', action: 'keep' });
  assert.deepEqual(deepRowKey('a'), { kind: 'action', action: 'ask' });
  assert.deepEqual(deepRowKey('e'), { kind: 'action', action: 'explore' });
  assert.deepEqual(deepRowKey('C'), { kind: 'action', action: 'capture' }, 'caps lock still picks');
  assert.deepEqual(deepRowKey('Escape'), { kind: 'escape' });
  assert.deepEqual(deepRowKey('Escape', { meta: true }), { kind: 'escape' }, 'Esc always works');
  assert.deepEqual(deepRowKey('ArrowRight'), { kind: 'move', delta: 1 });
  assert.deepEqual(deepRowKey('ArrowLeft'), { kind: 'move', delta: -1 });
  assert.equal(deepRowKey('s'), null, 'Spin off is D2');
  assert.equal(deepRowKey('p'), null, 'Pin is D2');
  assert.equal(deepRowKey('x'), null);
  assert.equal(deepRowKey('Enter'), null, 'Enter falls through to the focused button');
  assert.equal(deepRowKey('c', { meta: true }), null, '⌘C copies, it does not capture');
  assert.equal(deepRowKey('k', { ctrl: true }), null);
  assert.equal(deepRowKey('a', { alt: true }), null);
});

// ---------------------------------------------------------------------------
// §7 affordances
// ---------------------------------------------------------------------------

test('affordanceFor: a question line (≥ 3 words, ends with ?) offers Ask and Mark open question', () => {
  const a = affordanceFor('Does the vector clock survive a partition?', false);
  assert.equal(a.pattern, 'question');
  assert.deepEqual(
    a.options.map((o) => o.kind),
    ['ask', 'mark_question'],
  );
  assert.equal(a.options[0].question, 'Does the vector clock survive a partition?');
  assert.equal(a.options[1].text, 'Does the vector clock survive a partition?');
  // Markdown decoration is not part of the question.
  assert.equal(affordanceFor('- why is this so slow?', false).options[0].question, 'why is this so slow?');
  assert.equal(affordanceFor('## What does it cost?', false).options[0].question, 'What does it cost?');
  assert.equal(affordanceFor('  what about   retries?  ', false).pattern, 'question', 'trimmed');
});

test('affordanceFor: question negatives', () => {
  assert.equal(affordanceFor('Why?', false), null, 'one word');
  assert.equal(affordanceFor('Really, why?', false), null, 'two words');
  assert.equal(affordanceFor('Is this a question? No it is not', false), null, 'must end with ?');
  assert.equal(affordanceFor('', false), null);
  assert.equal(affordanceFor('    ', true), null);
  assert.equal(affordanceFor('plain prose with no pattern', false), null);
});

test('affordanceFor: later: / someday: offers Capture of the rest (case-insensitive)', () => {
  const a = affordanceFor('later: try CRDTs for the outline', false);
  assert.deepEqual(a, { pattern: 'later', options: [{ kind: 'capture', label: 'Capture', text: 'try CRDTs for the outline' }] });
  assert.equal(affordanceFor('Someday: learn TLA+', false).options[0].text, 'learn TLA+');
  assert.equal(affordanceFor('LATER:read the paper', false).options[0].text, 'read the paper');
  assert.equal(affordanceFor('- later: a bullet', false).options[0].text, 'a bullet');
  assert.equal(affordanceFor('later: does this beat a question?', false).pattern, 'later', 'later: wins over ?');
  assert.equal(affordanceFor('later:', false), null, 'nothing to capture');
  assert.equal(affordanceFor('later:   ', false), null);
  assert.equal(affordanceFor('I will do it later: maybe', false), null, 'must start the line');
  assert.equal(affordanceFor('todo: write tests', false), null, 'todo: is D2');
  assert.equal(affordanceFor('agent: fix the build', false), null, 'agent: is D2');
  assert.equal(affordanceFor('render: home screen', false), null, 'render: is D2');
});

test('affordanceFor: a URL just typed (at the end) or pasted (anywhere) offers Keep as reference', () => {
  const typed = affordanceFor('see https://example.com/a/b', false);
  assert.deepEqual(typed, { pattern: 'url', options: [{ kind: 'keep_link', label: 'Keep as reference', url: 'https://example.com/a/b' }] });
  assert.equal(affordanceFor('see https://example.com/a/b.', false).options[0].url, 'https://example.com/a/b', 'trailing period dropped');
  assert.equal(affordanceFor('mid https://example.com and more text', false), null, 'typed, not finished at the end yet');
  assert.equal(affordanceFor('mid https://example.com and more text', true).options[0].url, 'https://example.com', 'pasted: anywhere');
  const md = affordanceFor('[Lamport clocks](https://lamport.org/time.pdf)', false);
  assert.equal(md.options[0].url, 'https://lamport.org/time.pdf');
  assert.equal(md.options[0].title, 'Lamport clocks', 'title = the markdown link text');
  assert.equal(affordanceFor('<http://a.dev/x>', false).options[0].url, 'http://a.dev/x');
  assert.equal(affordanceFor('ftp://files.example.com/x', false), null, 'http(s) only');
  assert.equal(affordanceFor('example.com/no-scheme', true), null, 'bare means with a scheme');
});

test('url helpers: urlsIn, markdownLinkTitle, isBareUrl', () => {
  assert.deepEqual(urlsIn('a https://x.dev b http://y.dev/z?q=1'), ['https://x.dev', 'http://y.dev/z?q=1']);
  assert.equal(markdownLinkTitle('[T](https://x.dev)', 'https://x.dev'), 'T');
  assert.equal(markdownLinkTitle('https://x.dev', 'https://x.dev'), undefined);
  assert.equal(isBareUrl(' https://x.dev/a '), true);
  assert.equal(isBareUrl('see https://x.dev'), false);
  assert.equal(isBareUrl('https://x.dev https://y.dev'), false);
  assert.equal(isBareUrl(''), false);
});

test('affordance timing constants follow §7 (400 ms to show, 5 s to fade)', () => {
  assert.equal(AFFORDANCE_DELAY_MS, 400);
  assert.equal(AFFORDANCE_FADE_MS, 5000);
});

// ---------------------------------------------------------------------------
// §9 "Where did you stop?"
// ---------------------------------------------------------------------------

test('lastSentence: the sentence around the last edit, closing punctuation kept', () => {
  const t = 'First idea. The vector clock only helps if every write carries it. Then more';
  assert.equal(lastSentence(t, t.indexOf('only')), 'The vector clock only helps if every write carries it.');
  assert.equal(lastSentence(t), 'Then more', 'mid-thought at the end');
  assert.equal(lastSentence(t, 3), 'First idea.');
  assert.equal(lastSentence('Is it slow? Maybe', 5), 'Is it slow?');
  assert.equal(lastSentence('Wow! ok', 1), 'Wow!');
});

test('lastSentence: just past a full stop or on a blank line → the sentence before', () => {
  const t = 'One. Two sentences here.';
  assert.equal(lastSentence(t, t.length), 'Two sentences here.');
  assert.equal(lastSentence('A line\n\n', 8), 'A line', 'newline boundaries');
  assert.equal(lastSentence('# Heading\nbody text\n', 12), 'body text');
  assert.equal(lastSentence('', 0), '');
  assert.equal(lastSentence('...', 3), '', 'punctuation alone is not a sentence');
  assert.equal(lastSentence('abc', 99), 'abc', 'pos clamped');
});

test('lastSentence: at most 1 000 chars, keeping the end', () => {
  const long = `${'x'.repeat(1500)} end`;
  const s = lastSentence(long);
  assert.ok(s.length <= 1000);
  assert.ok(s.endsWith(' end'));
});

// ---------------------------------------------------------------------------
// §3.3 / §4.2 anchors
// ---------------------------------------------------------------------------

const PAGE = '# Mesh sync\n\nWrites carry a clock.\n\n## Conflicts\n\nLast writer wins is lossy.\nWrites carry a clock.\n';

test('sectionAt: the nearest heading at or before a position', () => {
  assert.equal(sectionAt(PAGE, PAGE.indexOf('Writes')), 'Mesh sync');
  assert.equal(sectionAt(PAGE, PAGE.indexOf('lossy')), 'Conflicts');
  assert.equal(sectionAt(PAGE, PAGE.indexOf('## Conflicts') + 3), 'Conflicts', 'a heading line is its own section');
  assert.equal(sectionAt('no headings', 3), null);
  assert.equal(sectionAt('#hashtag is not a heading\ntext', 30), null);
});

test('anchorFor: quote (trimmed, ≤ 500), offset and section; empty selection → none', () => {
  const from = PAGE.indexOf('Last writer');
  const a = anchorFor(PAGE, from, from + 'Last writer wins'.length);
  assert.deepEqual(a, { kind: 'page', quote: 'Last writer wins', offset: from, section: 'Conflicts' });
  const padded = anchorFor(PAGE, from - 1, from + 4);
  assert.equal(padded.quote, 'Last');
  assert.equal(padded.offset, from, 'offset moves past trimmed whitespace');
  assert.deepEqual(anchorFor(PAGE, 5, 5), { kind: 'none' });
  assert.equal(anchorFor('y'.repeat(900), 0, 900).quote.length, 500);
  assert.deepEqual(anchorFor(PAGE, from + 4, from), anchorFor(PAGE, from, from + 4), 'backwards selection');
});

test('locateAnchor: the quote nearest the stored offset, even after it moved', () => {
  const second = PAGE.lastIndexOf('Writes carry a clock.');
  const first = PAGE.indexOf('Writes carry a clock.');
  const anchor = { kind: 'page', quote: 'Writes carry a clock.', offset: second, section: 'Conflicts' };
  assert.deepEqual(locateAnchor(PAGE, anchor), { pos: second, via: 'quote' });
  assert.deepEqual(locateAnchor(PAGE, { ...anchor, offset: first }), { pos: first, via: 'quote' });
  const moved = `Intro paragraph added on top.\n\n${PAGE}`;
  assert.deepEqual(locateAnchor(moved, anchor), { pos: moved.lastIndexOf('Writes carry a clock.'), via: 'quote' }, 'text above moved it');
});

test('locateAnchor: missing quote → its section heading, else the top', () => {
  const anchor = { kind: 'page', quote: 'a sentence since deleted', offset: 40, section: 'Conflicts' };
  assert.deepEqual(locateAnchor(PAGE, anchor), { pos: PAGE.indexOf('## Conflicts'), via: 'section' });
  assert.deepEqual(locateAnchor(PAGE, { ...anchor, section: 'Gone' }), { pos: 0, via: 'top' });
  assert.deepEqual(locateAnchor(PAGE, { ...anchor, section: null }), { pos: 0, via: 'top' });
  assert.deepEqual(locateAnchor(PAGE, { kind: 'none' }), { pos: 0, via: 'top' });
  assert.deepEqual(locateAnchor(PAGE, null), { pos: 0, via: 'top' });
});

test('contextAround: ≤ max chars around the selection', () => {
  const t = 'a'.repeat(500) + 'SEL' + 'b'.repeat(500);
  const c = contextAround(t, 500, 503, 300);
  assert.equal(c.length, 300);
  assert.ok(c.includes('SEL'));
  assert.equal(contextAround('short', 1, 2, 300), 'short');
});

// ---------------------------------------------------------------------------
// §4.2 Insert
// ---------------------------------------------------------------------------

test('answerInsertion: a blockquote with the attribution line, below the anchor paragraph', () => {
  const text = 'Para one line.\nstill para one.\n\nPara two.';
  const { from, insert } = answerInsertion(text, 3, 'Yes.\n\nBecause clocks.', '2026-09-26');
  assert.equal(from, text.indexOf('\n\nPara two'));
  const out = text.slice(0, from) + insert + text.slice(from);
  assert.equal(out, 'Para one line.\nstill para one.\n\n> Yes.\n>\n> Because clocks.\n>\n> — Hester, 2026-09-26\n\nPara two.');
  const end = answerInsertion('Only para', 2, 'A', '2026-09-26');
  assert.equal('Only para'.slice(0, end.from) + end.insert, 'Only para\n\n> A\n>\n> — Hester, 2026-09-26\n');
  const trailing = answerInsertion('Text\n', 1, 'A', 'd');
  assert.equal('Text\n' + trailing.insert, 'Text\n\n> A\n>\n> — Hester, d\n');
  assert.equal(attributionDate(new Date(2026, 8, 6)), '2026-09-06');
});

// ---------------------------------------------------------------------------
// Answers tray, markers, memory keys, opener helpers
// ---------------------------------------------------------------------------

test('answersTray / markerState: unread, pending, read, error; dismissed ignored', () => {
  const answers = [
    { status: 'done' },
    { status: 'done', read_at: 't' },
    { status: 'queued' },
    { status: 'running' },
    { status: 'done', dismissed_at: 't' },
    { status: 'error' },
  ];
  assert.deepEqual(answersTray(answers), { unread: 1, pending: 2, label: '1 answer · 2 asking…' });
  assert.equal(answersTray([{ status: 'done' }, { status: 'done' }]).label, '2 answers');
  assert.equal(answersTray([]).label, 'Answers');
  assert.equal(markerState({ status: 'queued' }), 'pending');
  assert.equal(markerState({ status: 'done' }), 'unread');
  assert.equal(markerState({ status: 'done', read_at: 't' }), 'read');
  assert.equal(markerState({ status: 'interrupted' }), 'error');
  assert.equal(isPending({ status: 'running' }), true);
  assert.equal(isUnread({ status: 'running' }), false);
});

test('storage keys (§4.3, §4.4)', () => {
  assert.equal(pageMirrorKey('/w', 'exp-1'), 'lee:deep:page:/w:exp-1');
  assert.equal(deepMemoryKey('/w'), 'lee:deep:/w');
});

test('opener helpers: case-insensitive title match, Untitled · <date>, save backoff', () => {
  const exps = [{ id: 'a', title: 'Mesh sync conflicts' }, { id: 'b', title: 'Other' }];
  assert.equal(matchExploration('  mesh SYNC conflicts ', exps).id, 'a');
  assert.equal(matchExploration('mesh sync', exps), null, 'equality, not prefix');
  assert.equal(matchExploration('', exps), null);
  assert.equal(untitledTitle(new Date(2026, 8, 26)), 'Untitled · Sep 26');
  assert.deepEqual([0, 1, 2, 10].map(saveBackoffMs), [2000, 4000, 8000, 60000]);
});

// ---------------------------------------------------------------------------
// §4.1 wake line and the neutral count
// ---------------------------------------------------------------------------

test('wokenItem / waitingCount: only woken open items make the wake line', () => {
  const item = (o) => ({ id: 'i', state: 'open', severity: 'needs-you', kind: 'approval', wake: false, title: 't', source: { pty_id: null }, ...o });
  const away = { wake_item_ids: [], wake_pty_ids: [] };
  assert.equal(wokenItem({ items: [item({})], away }), null, 'waiting but not woken');
  assert.equal(wokenItem({ items: [item({ wake: true, title: 'Deploy' })], away }).title, 'Deploy');
  assert.equal(wokenItem({ items: [item({ id: 'x' })], away: { ...away, wake_item_ids: ['x'] } }).id, 'x');
  assert.equal(wokenItem({ items: [item({ source: { pty_id: 4 } })], away: { ...away, wake_pty_ids: [4] } }).source.pty_id, 4);
  assert.equal(wokenItem({ items: [item({ wake: true, state: 'resolved' })], away }), null);
  assert.equal(wokenItem({ items: [item({ wake: true, severity: 'ambient' })], away }), null);
  assert.equal(wokenItem(null), null);
  const items = [item({}), item({ severity: 'blocking' }), item({ severity: 'ambient' }), item({ state: 'dismissed' }), item({ kind: 'summary' })];
  assert.equal(waitingCount({ items }), 2);
  assert.equal(waitingCount(null), 0);
});

console.log(process.exitCode ? '\nsome FAILED' : `\n${passed} passed`);
