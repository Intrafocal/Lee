/**
 * Git facts for the v4 lint rules (contract v4 §7.3): a GitSnapshot per
 * workspace, the added lines project rules match against, and the docs text
 * new-files-undocumented searches. Everything runs `git` through execFile
 * (never a shell), asynchronously, and is cached: 30 s per workspace for git,
 * invalidated by `operation.result` / `agent.turn_end` for that workspace.
 *
 * Readers get the cached value (null until the first read finishes) and a
 * refresh starts in the background; `onUpdate` fires when new facts land.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { GitSnapshot } from '../../../shared/cockpit';
import type { AddedLine } from './types';

const GIT_TTL_MS = 30_000;
const DOCS_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_ADDED_LINES = 50_000;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_DOC_FILES = 2000;

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function gitOr(cwd: string, args: string[], fallback: string | null): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return fallback;
  }
}

/** Parse `git status --porcelain=v1 -z`: changed (tracked) and untracked paths. Ignored entries are skipped. */
export function parsePorcelainZ(out: string): { changed: Array<{ path: string; status: string }>; untracked: string[] } {
  const changed: Array<{ path: string; status: string }> = [];
  const untracked: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const p = rec.slice(3);
    if (status === '??') untracked.push(p);
    else if (status === '!!') continue;
    else changed.push({ path: p, status: status.trim() || status });
    // Renames and copies carry the original path as the next field.
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') i++;
    if (changed.length + untracked.length >= MAX_ENTRIES) break;
  }
  return { changed, untracked };
}

/** Parse `git stash list --format=%gd%x09%ct%x09%gs`. */
export function parseStashes(out: string): GitSnapshot['stashes'] {
  const res: GitSnapshot['stashes'] = [];
  for (const line of out.split('\n')) {
    const [ref, ct, ...msg] = line.split('\t');
    const s = Number(ct);
    if (!ref || !Number.isFinite(s)) continue;
    res.push({ ref, ms: s * 1000, message: msg.join('\t') });
  }
  return res;
}

/** Parse the added lines out of `git diff HEAD --unified=0` output. */
export function parseAddedLines(diff: string, limit = MAX_ADDED_LINES): AddedLine[] {
  const out: AddedLine[] = [];
  let file: string | null = null;
  let line = 0;
  // ---/+++ are headers only between `diff --git` and the file's first hunk; after
  // that an added line whose text starts with "++ " is content.
  let inHeader = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader && raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      file = p === '/dev/null' ? null : p.startsWith('b/') ? p.slice(2) : p;
      continue;
    }
    if (inHeader && raw.startsWith('--- ')) continue;
    if (raw.startsWith('@@')) {
      inHeader = false;
      const m = /\+(\d+)(?:,\d+)?/.exec(raw);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file || inHeader) continue;
    if (raw.startsWith('+')) {
      out.push({ path: file, line, text: raw.slice(1) });
      line++;
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Throws when a call whose answer matters fails (timeout, index.lock...), so
 * the caller keeps its last good snapshot instead of seeing a clean tree.
 * Null: not a git work tree.
 */
export async function readGitSnapshot(ws: string, now: number = Date.now()): Promise<GitSnapshot | null> {
  let inside: string;
  try {
    inside = await git(ws, ['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    // Killed (timeout) or couldn't spawn: unknown, not "outside git".
    const e = err as { killed?: boolean; signal?: unknown; code?: unknown };
    if (e.killed || e.signal || typeof e.code === 'string') throw err;
    return null;
  }
  if (inside.trim() !== 'true') return null;
  const [branchOut, statusOut, refsOut, stashOut, originHead] = await Promise.all([
    // Lenient: fails on an unborn branch.
    gitOr(ws, ['rev-parse', '--abbrev-ref', 'HEAD'], ''),
    git(ws, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(ws, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(committerdate:unix)']),
    git(ws, ['stash', 'list', '--format=%gd%x09%ct%x09%gs']),
    gitOr(ws, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], null),
  ]);
  const branch = (branchOut ?? '').trim() || null;
  const heads = new Map<string, number>();
  for (const line of refsOut.split('\n')) {
    const [name, ct] = line.split('\t');
    const s = Number(ct);
    if (name && Number.isFinite(s)) heads.set(name, s * 1000);
  }
  let def: string | null = originHead ? originHead.trim().replace(/^origin\//, '') || null : null;
  if (!def || !heads.has(def)) def = heads.has('main') ? 'main' : heads.has('master') ? 'master' : def && heads.has(def) ? def : null;
  const merged = new Set<string>();
  if (def) {
    const m = await git(ws, ['for-each-ref', 'refs/heads', '--merged', def, '--format=%(refname:short)']);
    for (const n of m.split('\n')) if (n.trim()) merged.add(n.trim());
  }
  const { changed, untracked } = parsePorcelainZ(statusOut);
  return {
    workspace: ws,
    at: now,
    branch: branch === 'HEAD' ? null : branch,
    default_branch: def,
    changed,
    untracked,
    branches: [...heads.entries()].map(([name, ms]) => ({ name, last_commit_ms: ms, merged: merged.has(name) })),
    stashes: parseStashes(stashOut),
  };
}

/** Throws when the diff fails, so the caller keeps its last good lines. */
export async function readAddedLines(ws: string, untracked: string[]): Promise<AddedLine[]> {
  const diff = await git(ws, ['diff', 'HEAD', '--unified=0', '--no-color', '--no-ext-diff']);
  const out = parseAddedLines(diff);
  for (const rel of untracked) {
    if (out.length >= MAX_ADDED_LINES) break;
    const abs = path.join(ws, rel);
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
      const text = await fs.promises.readFile(abs, 'utf8');
      if (text.includes('\0')) continue;
      text.split('\n').forEach((t, i) => {
        if (out.length < MAX_ADDED_LINES) out.push({ path: rel, line: i + 1, text: t });
      });
    } catch {
      // vanished or unreadable
    }
  }
  return out;
}

/** Lower-cased Markdown under docs/ plus the root README(s). */
export async function readDocText(ws: string): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  let files = 0;
  const add = async (file: string) => {
    if (bytes >= MAX_DOC_BYTES || files >= MAX_DOC_FILES) return;
    try {
      const t = await fs.promises.readFile(file, 'utf8');
      chunks.push(t.toLowerCase());
      bytes += t.length;
      files++;
    } catch {
      // unreadable
    }
  };
  try {
    for (const name of await fs.promises.readdir(ws)) if (/^readme(\.md|\.markdown)?$/i.test(name)) await add(path.join(ws, name));
  } catch {
    // no workspace
  }
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) await add(p);
    }
  };
  await walk(path.join(ws, 'docs'), 0);
  return chunks.join('\n');
}

interface Entry<T> {
  value: T | null;
  at: number;
  stale: boolean;
  inflight: boolean;
}

export interface GitFactsOptions {
  now?: () => number;
  /** Whether added lines are needed for a workspace (it has project rules). */
  wantsAddedLines?: (ws: string) => boolean;
  onUpdate?: (ws: string) => void;
  readGit?: typeof readGitSnapshot;
  readAdded?: typeof readAddedLines;
  readDocs?: typeof readDocText;
}

export class GitFacts {
  private snaps = new Map<string, Entry<GitSnapshot>>();
  private added = new Map<string, Entry<AddedLine[]>>();
  private docs = new Map<string, Entry<string>>();
  private readonly now: () => number;

  constructor(private opts: GitFactsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private entry<T>(m: Map<string, Entry<T>>, ws: string): Entry<T> {
    let e = m.get(ws);
    if (!e) {
      e = { value: null, at: 0, stale: true, inflight: false };
      m.set(ws, e);
    }
    return e;
  }

  /** Drop the 30 s cache for a workspace (operation.result, agent.turn_end). */
  invalidate(ws: string): void {
    const s = this.snaps.get(ws);
    if (s) s.stale = true;
    const a = this.added.get(ws);
    if (a) a.stale = true;
  }

  forget(keep: Set<string>): void {
    for (const m of [this.snaps, this.added, this.docs] as Array<Map<string, unknown>>) for (const k of [...m.keys()]) if (!keep.has(k)) m.delete(k);
  }

  snapshot(ws: string): GitSnapshot | null {
    const e = this.entry(this.snaps, ws);
    if (!e.inflight && (e.stale || this.now() - e.at >= GIT_TTL_MS)) {
      e.inflight = true;
      (this.opts.readGit ?? readGitSnapshot)(ws, this.now())
        .then((v) => {
          const changed = JSON.stringify(v && { ...v, at: 0 }) !== JSON.stringify(e.value && { ...e.value, at: 0 });
          e.value = v;
          e.at = this.now();
          e.stale = false;
          if (changed) this.opts.onUpdate?.(ws);
        })
        // A failed read (timeout, index.lock) keeps the last good snapshot; still stale, so the next read retries.
        .catch(() => undefined)
        .finally(() => {
          e.inflight = false;
        });
    }
    return e.value;
  }

  addedLines(ws: string): AddedLine[] | null {
    if (this.opts.wantsAddedLines && !this.opts.wantsAddedLines(ws)) return null;
    const snap = this.snapshot(ws);
    const e = this.entry(this.added, ws);
    if (snap && !e.inflight && (e.stale || this.now() - e.at >= GIT_TTL_MS)) {
      e.inflight = true;
      (this.opts.readAdded ?? readAddedLines)(ws, snap.untracked)
        .then((v) => {
          const changed = JSON.stringify(v) !== JSON.stringify(e.value);
          e.value = v;
          e.at = this.now();
          e.stale = false;
          if (changed) this.opts.onUpdate?.(ws);
        })
        .catch(() => undefined)
        .finally(() => {
          e.inflight = false;
        });
    }
    return e.value;
  }

  docText(ws: string): string | null {
    const e = this.entry(this.docs, ws);
    if (!e.inflight && this.now() - e.at >= DOCS_TTL_MS) {
      e.inflight = true;
      (this.opts.readDocs ?? readDocText)(ws)
        .then((v) => {
          const changed = v !== e.value;
          e.value = v;
          e.at = this.now();
          if (changed) this.opts.onUpdate?.(ws);
        })
        .catch(() => undefined)
        .finally(() => {
          e.inflight = false;
        });
    }
    return e.value;
  }
}
