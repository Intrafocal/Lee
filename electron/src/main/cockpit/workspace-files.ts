/**
 * Workspace files for the Launcher's context picker (addendum 2026-09-26b),
 * and the deterministic context references a launch appends to the agent's
 * initial prompt. No model, no network: works offline (C1).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const FILES_CAP = 20_000;
export const CONTEXT_FILES_MAX = 50;
export const CONTEXT_BUNDLES_MAX = 10;
const CACHE_MS = 10_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.next', '.dart_tool']);
const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

const cache = new Map<string, { at: number; files: string[]; truncated: boolean }>();

function gitFiles(workspace: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', workspace, 'ls-files', '-co', '--exclude-standard', '-z'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(String(stdout).split('\0').filter(Boolean));
      },
    );
  });
}

function walk(workspace: string, cap: number): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length && out.length <= cap) {
    const rel = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(workspace, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.name.startsWith('.') && d.name !== '.github') continue;
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) stack.push(child);
      } else if (d.isFile()) {
        out.push(child);
        if (out.length > cap) break;
      }
    }
  }
  return out;
}

/** Relative paths of the workspace's files: git's view (tracked + untracked, not ignored), else a bounded walk. */
export async function listWorkspaceFiles(workspace: string, cap: number = FILES_CAP): Promise<{ files: string[]; truncated: boolean }> {
  const hit = cache.get(workspace);
  if (hit && Date.now() - hit.at < CACHE_MS) return { files: hit.files, truncated: hit.truncated };
  let files = await gitFiles(workspace);
  if (!files) files = walk(workspace, cap);
  files.sort();
  const truncated = files.length > cap;
  const kept = truncated ? files.slice(0, cap) : files;
  cache.set(workspace, { at: Date.now(), files: kept, truncated });
  return { files: kept, truncated };
}

/** A workspace-relative path for `p` (relative or absolute), or null outside the workspace. */
export function workspaceRelative(workspace: string, p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  const root = path.resolve(workspace);
  const abs = path.resolve(root, p.trim());
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function bundlePath(workspace: string, id: string): string {
  return path.join(path.resolve(workspace), '.hester', 'context', 'bundles', `${id}.md`);
}

export interface ContextRefs {
  /** Workspace-relative files kept (existing, inside the workspace). */
  files: string[];
  /** Bundle ids kept (their content file exists). */
  bundles: string[];
  /** The `@path` references, in order: files, then bundle content files. */
  refs: string[];
}

/**
 * Validate a launch's context (deterministic): files must be inside the
 * workspace and exist; bundles must be `.hester/context/bundles/<id>.md` in
 * the workspace. Files are referenced relative to the workspace (Claude runs
 * there, or in a worktree with the same layout); bundle files live under the
 * gitignored .hester/, which a worktree doesn't have, so they are referenced
 * by absolute path.
 */
export function contextRefs(workspace: string, context: unknown, exists: (p: string) => boolean = fs.existsSync): ContextRefs {
  const out: ContextRefs = { files: [], bundles: [], refs: [] };
  if (!context || typeof context !== 'object') return out;
  const c = context as { files?: unknown; bundles?: unknown };
  const files = Array.isArray(c.files) ? c.files : [];
  for (const f of files) {
    const rel = workspaceRelative(workspace, f);
    if (!rel || out.files.includes(rel) || !exists(path.join(workspace, rel))) continue;
    out.files.push(rel);
    if (out.files.length >= CONTEXT_FILES_MAX) break;
  }
  const bundles = Array.isArray(c.bundles) ? c.bundles : [];
  for (const b of bundles) {
    if (typeof b !== 'string' || !BUNDLE_ID_RE.test(b) || out.bundles.includes(b)) continue;
    if (!exists(bundlePath(workspace, b))) continue;
    out.bundles.push(b);
    if (out.bundles.length >= CONTEXT_BUNDLES_MAX) break;
  }
  out.refs = [...out.files.map((f) => `@${f}`), ...out.bundles.map((b) => `@${bundlePath(workspace, b)}`)];
  return out;
}

/** The initial prompt with the context references appended (Claude resolves `@path`). */
export function withContext(prompt: string, refs: readonly string[]): string {
  if (!refs.length) return prompt;
  const line = refs.join(' ');
  return prompt ? `${prompt}\n\nContext: ${line}` : `Context: ${line}`;
}
