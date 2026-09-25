#!/usr/bin/env node
/**
 * Smoke test for the pure Copilot renderer helpers
 * (src/renderer/lib/copilotAttention.ts). There is no test runner wired up
 * for this package yet, so this compiles the real source with esbuild (a
 * dependency already in node_modules via vite) and exercises it directly -
 * no React, no DOM.
 *
 * Run: node scripts/copilot-renderer-smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '../src/renderer/lib/copilotAttention.ts');

const result = await esbuild.build({
  entryPoints: [srcPath],
  bundle: false,
  format: 'esm',
  platform: 'node',
  write: false,
});
const code = result.outputFiles[0].text;

// Write the compiled JS next to a real file so Node's ESM loader is happy,
// then import it.
const tmpDir = mkdtempSync(join(tmpdir(), 'lee-copilot-smoke-'));
const tmpFile = join(tmpDir, 'copilotAttention.mjs');
writeFileSync(tmpFile, code);
let mod;
try {
  mod = await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { groupAttentionItems, resolveSummaryAtTime, attentionByPty, offscreenNeeds } = mod;

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

function item(overrides) {
  return {
    id: 'i1',
    state: 'open',
    severity: 'needs-you',
    title: 't',
    created_at: new Date().toISOString(),
    source: { tab_label: null, workspace: null },
    actions: [],
    text: null,
    version: 1,
    wake: false,
    ...overrides,
  };
}

test('groupAttentionItems excludes snoozed items (Lee flyout: snoozed items listed as live)', () => {
  const items = [
    item({ id: 'a', severity: 'needs-you', state: 'open' }),
    item({ id: 'b', severity: 'needs-you', state: 'snoozed' }),
    item({ id: 'c', severity: 'blocking', state: 'snoozed' }),
    item({ id: 'd', severity: 'ambient', state: 'open' }),
  ];
  const { blocking, needsYou, recent } = groupAttentionItems(items);
  assert.deepEqual(blocking.map((i) => i.id), []);
  assert.deepEqual(needsYou.map((i) => i.id), ['a']);
  assert.deepEqual(recent.map((i) => i.id), ['d']);
});

test('groupAttentionItems still groups plain open items by severity', () => {
  const items = [
    item({ id: 'a', severity: 'blocking' }),
    item({ id: 'b', severity: 'needs-you' }),
    item({ id: 'c', severity: 'ambient' }),
  ];
  const { blocking, needsYou, recent } = groupAttentionItems(items);
  assert.deepEqual(blocking.map((i) => i.id), ['a']);
  assert.deepEqual(needsYou.map((i) => i.id), ['b']);
  assert.deepEqual(recent.map((i) => i.id), ['c']);
});

test('resolveSummaryAtTime does not throw on an <input type="time"> value (Invalid Date bug)', () => {
  const now = new Date('2026-09-25T10:00:00');
  const iso = resolveSummaryAtTime('16:30', now);
  assert.equal(typeof iso, 'string');
  assert.ok(!Number.isNaN(new Date(iso).getTime()), 'must produce a valid Date');
});

test('resolveSummaryAtTime uses today when the time is still ahead', () => {
  const now = new Date('2026-09-25T10:00:00');
  const at = new Date(resolveSummaryAtTime('16:30', now));
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 8); // September (0-indexed)
  assert.equal(at.getDate(), 25);
  assert.equal(at.getHours(), 16);
  assert.equal(at.getMinutes(), 30);
});

test('resolveSummaryAtTime rolls to tomorrow when the time has already passed', () => {
  const now = new Date('2026-09-25T18:00:00');
  const at = new Date(resolveSummaryAtTime('16:30', now));
  assert.equal(at.getDate(), 26);
  assert.equal(at.getHours(), 16);
  assert.equal(at.getMinutes(), 30);
});

const tabItem = (id, kind, pty, extra = {}) => ({
  id, kind, state: 'open', severity: kind === 'review' ? 'ambient' : 'needs-you',
  source: { pty_id: pty }, ...extra,
});

test('attentionByPty: needs beats review on the same tab; snoozed and resolved are ignored', () => {
  const m = attentionByPty([
    tabItem('a', 'review', 1),
    tabItem('b', 'approval', 1),
    tabItem('c', 'review', 2),
    tabItem('d', 'approval', 3, { state: 'snoozed' }),
    tabItem('e', 'waiting', 4, { state: 'resolved' }),
    tabItem('f', 'failure', null),
  ]);
  assert.equal(m.get(1), 'needs');
  assert.equal(m.get(2), 'review');
  assert.equal(m.has(3), false);
  assert.equal(m.has(4), false);
  assert.equal(m.size, 2);
});

test('offscreenNeeds: only needs-you items not on a visible tab', () => {
  const items = [
    tabItem('a', 'approval', 1),
    tabItem('b', 'approval', 9),
    tabItem('c', 'review', 9),
    tabItem('d', 'failure', null, { severity: 'needs-you' }),
  ];
  const off = offscreenNeeds(items, new Set([1]));
  assert.deepEqual(off.map((i) => i.id), ['b', 'd']);
});

console.log(`\n${passed} test(s) passed`);
if (process.exitCode) {
  console.error('Some tests failed.');
  process.exit(process.exitCode);
}
