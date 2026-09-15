/**
 * FsWatcher - one `fs.watch` per directory, shared by file watches (C4) and
 * file-tree directory watches (C17).
 *
 * Why watch the *directory* even for a single file: editors and agents often
 * replace a file with an atomic rename (write temp, rename over the target).
 * A watcher bound to the inode of the original file goes deaf after that,
 * while a directory watcher still reports the rename. So every subscription -
 * file or directory - resolves to a watcher on a directory, and file
 * subscriptions filter events by basename.
 *
 * Events are debounced (fs.watch fires several times for one save on macOS)
 * and delivered to the renderer of the subscribing window only:
 *   - `fs:fileChanged`  { path, mtimeMs | null }   (null = deleted)
 *   - `fs:dirChanged`   { path }
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';

/** Directories never worth watching - they churn constantly and aren't edited. */
export const WATCH_IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  '.next',
  '.cache',
]);

const FILE_DEBOUNCE_MS = 200;
const DIR_DEBOUNCE_MS = 300;

/** Hard cap on concurrently open `fs.watch` handles (LRU-evicted). */
const MAX_WATCHED_DIRS = 200;

interface DirEntry {
  dir: string;
  watcher: fs.FSWatcher;
  /** basename -> window ids interested in that exact file */
  fileSubs: Map<string, Set<number>>;
  /** window ids interested in the directory listing itself */
  dirSubs: Set<number>;
  /** Pending debounce timers, keyed by basename ('' = the directory itself) */
  timers: Map<string, NodeJS.Timeout>;
  /** Monotonic counter for LRU eviction */
  lastUsed: number;
}

export class FsWatcher {
  private dirs = new Map<string, DirEntry>();
  private clock = 0;

  /** Watch a single file for content changes / deletion. */
  watchFile(filePath: string, windowId: number): void {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const entry = this.ensureDir(dir);
    if (!entry) return;
    let subs = entry.fileSubs.get(base);
    if (!subs) {
      subs = new Set();
      entry.fileSubs.set(base, subs);
    }
    subs.add(windowId);
  }

  unwatchFile(filePath: string, windowId: number): void {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const entry = this.dirs.get(dir);
    if (!entry) return;
    const subs = entry.fileSubs.get(base);
    if (!subs) return;
    subs.delete(windowId);
    if (subs.size === 0) entry.fileSubs.delete(base);
    this.closeIfUnused(entry);
  }

  /** Watch a directory listing (non-recursive) for added/removed entries. */
  watchDir(dirPath: string, windowId: number): void {
    if (WATCH_IGNORED_DIR_NAMES.has(path.basename(dirPath))) return;
    const entry = this.ensureDir(dirPath);
    if (!entry) return;
    entry.dirSubs.add(windowId);
  }

  unwatchDir(dirPath: string, windowId: number): void {
    const entry = this.dirs.get(dirPath);
    if (!entry) return;
    entry.dirSubs.delete(windowId);
    this.closeIfUnused(entry);
  }

  /** Drop every subscription belonging to a window (on close or reload). */
  releaseWindow(windowId: number): void {
    for (const entry of [...this.dirs.values()]) {
      entry.dirSubs.delete(windowId);
      for (const [base, subs] of [...entry.fileSubs]) {
        subs.delete(windowId);
        if (subs.size === 0) entry.fileSubs.delete(base);
      }
      this.closeIfUnused(entry);
    }
  }

  /** Close every watcher (app quit). */
  closeAll(): void {
    for (const entry of this.dirs.values()) {
      for (const timer of entry.timers.values()) clearTimeout(timer);
      try {
        entry.watcher.close();
      } catch {
        // Already closed by the OS - nothing to release.
      }
    }
    this.dirs.clear();
  }

  /** Number of open watchers - exposed for logging/tests. */
  get size(): number {
    return this.dirs.size;
  }

  private ensureDir(dir: string): DirEntry | null {
    const existing = this.dirs.get(dir);
    if (existing) {
      existing.lastUsed = ++this.clock;
      return existing;
    }

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false });
    } catch (error) {
      // Directory gone, or the OS refused another watch handle. Not fatal:
      // the tree/editor simply won't auto-refresh for this path.
      console.warn('[FsWatcher] cannot watch', dir, error);
      return null;
    }

    const entry: DirEntry = {
      dir,
      watcher,
      fileSubs: new Map(),
      dirSubs: new Set(),
      timers: new Map(),
      lastUsed: ++this.clock,
    };

    watcher.on('error', () => {
      // A watch dies when its directory is removed or a volume unmounts.
      this.dropEntry(entry);
    });
    watcher.on('change', (_eventType, filename) => {
      const name = typeof filename === 'string' ? filename : filename?.toString();
      this.onDirEvent(entry, name ?? null);
    });

    this.dirs.set(dir, entry);
    this.evictIfOverCapacity();
    return entry;
  }

  /**
   * LRU-evict directory-only watches once we're over the cap. Entries with
   * file subscriptions are never evicted: an open editor tab losing its
   * watcher would silently reintroduce the stale-buffer bug C4 fixes.
   */
  private evictIfOverCapacity(): void {
    if (this.dirs.size <= MAX_WATCHED_DIRS) return;
    const evictable = [...this.dirs.values()]
      .filter((e) => e.fileSubs.size === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of evictable) {
      if (this.dirs.size <= MAX_WATCHED_DIRS) break;
      this.dropEntry(entry);
    }
  }

  private dropEntry(entry: DirEntry): void {
    for (const timer of entry.timers.values()) clearTimeout(timer);
    entry.timers.clear();
    try {
      entry.watcher.close();
    } catch {
      // Already closed - nothing to release.
    }
    this.dirs.delete(entry.dir);
  }

  private closeIfUnused(entry: DirEntry): void {
    if (entry.fileSubs.size === 0 && entry.dirSubs.size === 0) {
      this.dropEntry(entry);
    }
  }

  private onDirEvent(entry: DirEntry, filename: string | null): void {
    entry.lastUsed = ++this.clock;

    if (filename && entry.fileSubs.has(filename)) {
      this.debounce(entry, filename, FILE_DEBOUNCE_MS, () => {
        const full = path.join(entry.dir, filename);
        const subs = entry.fileSubs.get(filename);
        if (!subs || subs.size === 0) return;
        let mtimeMs: number | null = null;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          // File is gone - report a deletion (mtimeMs: null).
        }
        this.send(subs, 'fs:fileChanged', { path: full, mtimeMs });
      });
    }

    if (entry.dirSubs.size > 0) {
      // The directory listing changed whenever any child is added/removed or
      // renamed, so this fires regardless of which basename was reported.
      this.debounce(entry, '', DIR_DEBOUNCE_MS, () => {
        this.send(entry.dirSubs, 'fs:dirChanged', { path: entry.dir });
      });
    }
  }

  private debounce(entry: DirEntry, key: string, ms: number, fn: () => void): void {
    const existing = entry.timers.get(key);
    if (existing) clearTimeout(existing);
    entry.timers.set(
      key,
      setTimeout(() => {
        entry.timers.delete(key);
        fn();
      }, ms),
    );
  }

  private send(windowIds: Set<number>, channel: string, payload: unknown): void {
    for (const windowId of windowIds) {
      const bw = BrowserWindow.fromId(windowId);
      if (bw && !bw.isDestroyed()) {
        bw.webContents.send(channel, payload);
      }
    }
  }
}

export const fsWatcher = new FsWatcher();
