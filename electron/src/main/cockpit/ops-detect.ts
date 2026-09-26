/**
 * Operation auto-detect (package B, pure): package.json scripts, Makefile
 * targets, pyproject tasks, ESP-IDF projects and Flutter packages, over the
 * workspace root and directories up to depth 2. Suggestions only; nothing
 * detected ever runs without the user confirming it.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.2.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OperationDef, OperationKind, OperationSuggestion } from '../../shared/cockpit';
import { OP_NAME_RE, shellQuote } from './ops-config';

export interface ToolEnv {
  home: string;
  /** PATH to search (':'-separated). */
  path: string;
  idfPath?: string | null;
  /** cockpit.detect.tool_paths */
  toolPaths?: string[];
}

export interface DetectResult {
  suggestions: OperationSuggestion[];
  /** Cheap change marker over every scanned directory and file (mtimes). */
  fingerprint: string;
}

const MAX_DEPTH = 2;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.venv', 'venv', 'Pods', '.dart_tool']);
const CONFIRM_RE = /(deploy|publish|release|install|flash|dist|upload)/i;
const LONG_NAME_RE = /^(dev|start|serve|watch)/;
const NPM_LIFECYCLE = new Set([
  'install', 'uninstall', 'publish', 'pack', 'prepare', 'prepublish', 'prepublishOnly',
  'version', 'shrinkwrap', 'test', 'start', 'stop', 'restart',
]);
const DETECT_FILES = ['package.json', 'Makefile', 'pyproject.toml', 'CMakeLists.txt', 'pubspec.yaml'];

function skipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('build') || name.startsWith('.');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Workspace-relative directories to scan ('' = root), depth <= 2, skipping build output and hidden dirs. */
export function scanDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    out.push(rel);
    if (depth >= MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !skipDir(e.name)) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

export function detectFingerprint(root: string): string {
  const parts: string[] = [];
  for (const rel of scanDirs(root)) {
    const dir = path.join(root, rel);
    parts.push(`${rel}@${mtime(dir)}`);
    for (const f of DETECT_FILES) {
      const m = mtime(path.join(dir, f));
      if (m) parts.push(`${rel}/${f}@${m}`);
    }
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Tools not on PATH (Flutter, ESP-IDF)
// ---------------------------------------------------------------------------

function onPath(name: string, env: ToolEnv): boolean {
  return env.path.split(path.delimiter).some((d) => d && isFile(path.join(d, name)));
}

function quoteIfNeeded(p: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(p) ? p : shellQuote(p);
}

/** `flutter`, or an absolute path when it's only found outside PATH. */
export function resolveFlutter(env: ToolEnv): string {
  if (onPath('flutter', env)) return 'flutter';
  const dirs = [...(env.toolPaths ?? []), path.join(env.home, 'Development', 'flutter', 'bin'), path.join(env.home, 'flutter', 'bin')];
  for (const d of dirs) {
    const p = path.join(d, 'flutter');
    if (isFile(p)) return quoteIfNeeded(p);
  }
  return 'flutter';
}

/** '' when idf.py is on PATH (or can't be found), else `. <export.sh> >/dev/null && `. */
export function resolveIdfPrefix(env: ToolEnv): string {
  if (onPath('idf.py', env)) return '';
  const candidates: string[] = [];
  for (const d of env.toolPaths ?? []) {
    candidates.push(path.join(d, 'export.sh'));
    if (isFile(path.join(d, 'idf.py'))) candidates.push(path.join(d, '..', '..', 'export.sh'), path.join(d, '..', 'export.sh'));
  }
  if (env.idfPath) candidates.push(path.join(env.idfPath, 'export.sh'));
  candidates.push(path.join(env.home, 'esp', 'esp-idf', 'export.sh'), path.join(env.home, 'Development', 'hardware', 'esp-idf', 'export.sh'));
  for (const c of candidates) {
    if (isFile(c)) return `. ${quoteIfNeeded(path.normalize(c))} >/dev/null && `;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

type Found = { def: OperationDef; from: string };

function opName(rel: string, suffix: string): string {
  return rel ? `${rel}:${suffix}` : suffix;
}

function make(rel: string, suffix: string, command: string, kind: OperationKind, from: string, extra: Partial<OperationDef> = {}): Found | null {
  const name = opName(rel, suffix);
  if (!OP_NAME_RE.test(name)) return null;
  const def: OperationDef = { name, kind, command, ...(rel ? { cwd: rel } : {}), ...extra };
  if (def.confirm === undefined && CONFIRM_RE.test(suffix)) def.confirm = true;
  return { def, from };
}

function relFile(rel: string, file: string): string {
  return rel ? `${rel}/${file}` : file;
}

export function detectPackageJson(root: string, rel: string): Found[] {
  const text = readText(path.join(root, rel, 'package.json'));
  if (!text) return [];
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const lockIn = (f: string) => isFile(path.join(root, rel, f)) || isFile(path.join(root, f));
  const runner = lockIn('pnpm-lock.yaml') ? 'pnpm run' : lockIn('yarn.lock') ? 'yarn' : 'npm run';
  const out: Found[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    const lc = /^(pre|post)(.+)$/.exec(name);
    if (lc && (lc[2] in scripts || NPM_LIFECYCLE.has(lc[2]))) continue;
    const long = LONG_NAME_RE.test(name) || /--watch\b/.test(body) || /\bvite\s*$/.test(body) || /\bnodemon\b/.test(body) || /\bnext dev\b/.test(body);
    const f = make(rel, name, `${runner} ${name}`, long ? 'long-running' : 'oneshot', relFile(rel, 'package.json'));
    if (f) out.push(f);
  }
  return out;
}

export function detectMakefile(root: string, rel: string): Found[] {
  const text = readText(path.join(root, rel, 'Makefile'));
  if (!text) return [];
  const out: Found[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (!m || m[1].startsWith('.') || seen.has(m[1])) continue;
    seen.add(m[1]);
    const f = make(rel, `make:${m[1]}`, `make ${m[1]}`, LONG_NAME_RE.test(m[1]) ? 'long-running' : 'oneshot', relFile(rel, 'Makefile'));
    if (f) out.push(f);
  }
  return out;
}

/** Simple `key = "cmd"` lines of one TOML table (line-based; no TOML dependency). */
function tomlTableKeys(text: string, table: string): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inTable = line === `[${table}]`;
      continue;
    }
    if (!inTable) continue;
    const m = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(".*"|'.*')\s*(#.*)?$/.exec(line);
    if (m) out.push(m[1].replace(/^"|"$/g, ''));
  }
  return out;
}

export function detectPyproject(root: string, rel: string): Found[] {
  const text = readText(path.join(root, rel, 'pyproject.toml'));
  if (!text) return [];
  const from = relFile(rel, 'pyproject.toml');
  const out: Found[] = [];
  const push = (f: Found | null) => {
    if (f) out.push(f);
  };
  if (/^\s*\[tool\.pytest\.ini_options\]\s*$/m.test(text) || isDir(path.join(root, rel, 'tests'))) {
    push(make(rel, 'pytest', 'pytest', 'oneshot', from));
  }
  const runners: Array<[string, string]> = [
    ['tool.taskipy.tasks', 'task'],
    ['tool.pdm.scripts', 'pdm run'],
    ['tool.poe.tasks', 'poe'],
  ];
  for (const [table, runner] of runners) {
    for (const key of tomlTableKeys(text, table)) {
      push(make(rel, key, `${runner} ${key}`, LONG_NAME_RE.test(key) ? 'long-running' : 'oneshot', from));
    }
  }
  return out;
}

export function detectIdf(root: string, rel: string, env: ToolEnv): Found[] {
  const text = readText(path.join(root, rel, 'CMakeLists.txt'));
  if (!text || !/\$ENV\{IDF_PATH\}\/tools\/cmake\/project\.cmake/.test(text)) return [];
  const prefix = resolveIdfPrefix(env);
  const from = `${rel || '.'} (idf.py)`;
  return [
    make(rel, 'build', `${prefix}idf.py build`, 'oneshot', from),
    make(rel, 'flash', `${prefix}idf.py -p {port} flash`, 'oneshot', from, { params: ['port'], confirm: true }),
    make(rel, 'monitor', `${prefix}idf.py -p {port} monitor`, 'long-running', from, { params: ['port'] }),
  ].filter((f): f is Found => f !== null);
}

export function detectPubspec(root: string, rel: string, env: ToolEnv): Found[] {
  if (!isFile(path.join(root, rel, 'pubspec.yaml'))) return [];
  const flutter = resolveFlutter(env);
  const from = relFile(rel, 'pubspec.yaml');
  return [
    make(rel, 'analyze', `${flutter} analyze`, 'oneshot', from),
    make(rel, 'test', `${flutter} test`, 'oneshot', from),
    make(rel, 'run', `${flutter} run`, 'long-running', from),
  ].filter((f): f is Found => f !== null);
}

/**
 * All suggestions for a workspace, minus names in `exclude` (defined or
 * dismissed). The first detector to claim a name wins.
 */
export function detectOperations(root: string, env: ToolEnv, exclude: Set<string> = new Set()): DetectResult {
  const suggestions: OperationSuggestion[] = [];
  const seen = new Set(exclude);
  for (const rel of scanDirs(root)) {
    const found = [
      ...detectPackageJson(root, rel),
      ...detectMakefile(root, rel),
      ...detectPyproject(root, rel),
      ...detectIdf(root, rel, env),
      ...detectPubspec(root, rel, env),
    ];
    for (const f of found) {
      if (seen.has(f.def.name)) continue;
      seen.add(f.def.name);
      suggestions.push({ def: f.def, detected_from: f.from });
    }
  }
  return { suggestions, fingerprint: detectFingerprint(root) };
}
