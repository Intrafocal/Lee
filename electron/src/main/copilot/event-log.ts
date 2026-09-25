/**
 * Machine-wide event log writer: ~/.lee/events/YYYY-MM-DD[.N].jsonl.
 *
 * Pure (no Electron) so it can be smoke-tested with plain node. Lines are
 * buffered and appended every flushIntervalMs or flushLines, whichever comes
 * first; flushSync() is for will-quit. Write failures go to onError at most
 * once a minute and never reach callers.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LeeEvent } from '../../shared/copilot';
import type { EventSink } from './bus';

export interface EventLogOptions {
  dir: string;
  maxFileBytes: number;
  retentionDays: number;
  flushIntervalMs?: number;
  flushLines?: number;
  onError?: (err: unknown) => void;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const ERROR_THROTTLE_MS = 60_000;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class EventLogWriter implements EventSink {
  private readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private readonly flushIntervalMs: number;
  private readonly flushLines: number;
  private readonly onError?: (err: unknown) => void;

  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastErrorAt = 0;

  /** Current target: local date key, suffix and bytes written so far. */
  private current: { key: string; suffix: number; size: number } | null = null;

  constructor(opts: EventLogOptions) {
    this.dir = opts.dir;
    this.maxFileBytes = Math.max(1024, opts.maxFileBytes);
    this.retentionDays = opts.retentionDays;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.flushLines = opts.flushLines ?? 200;
    this.onError = opts.onError;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.reportError(err);
    }
  }

  write(event: LeeEvent): void {
    let line: string;
    try {
      line = JSON.stringify(event) + '\n';
    } catch (err) {
      this.reportError(err);
      return;
    }
    this.buffer.push(line);
    if (this.buffer.length >= this.flushLines) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  flush(): Promise<void> {
    this.clearTimer();
    if (this.buffer.length === 0) return this.chain;
    const lines = this.buffer;
    this.buffer = [];
    this.chain = this.chain.then(
      () =>
        new Promise<void>((resolve) => {
          const data = lines.join('');
          const bytes = Buffer.byteLength(data);
          let file: string;
          try {
            file = this.target(new Date());
          } catch (err) {
            this.reportError(err);
            resolve();
            return;
          }
          fs.appendFile(file, data, { mode: 0o600 }, (err) => {
            if (err) {
              this.current = null;
              this.reportError(err);
            } else if (this.current) {
              this.current.size += bytes;
            }
            resolve();
          });
        }),
    );
    return this.chain;
  }

  flushSync(): void {
    this.clearTimer();
    if (this.buffer.length === 0) return;
    const data = this.buffer.join('');
    this.buffer = [];
    try {
      const file = this.target(new Date());
      fs.appendFileSync(file, data, { mode: 0o600 });
      if (this.current) this.current.size += Buffer.byteLength(data);
    } catch (err) {
      this.current = null;
      this.reportError(err);
    }
  }

  /** Delete day files older than retentionDays (by local date). Returns the number deleted. */
  prune(now: Date = new Date()): number {
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - this.retentionDays);
    const cutoffKey = localDateKey(cutoff);
    let removed = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      this.reportError(err);
      return 0;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m || m[1] >= cutoffKey) continue;
      try {
        fs.unlinkSync(path.join(this.dir, name));
        removed++;
      } catch (err) {
        this.reportError(err);
      }
    }
    return removed;
  }

  currentFile(now: Date = new Date()): string {
    return this.target(now);
  }

  private fileFor(key: string, suffix: number): string {
    return path.join(this.dir, suffix === 0 ? `${key}.jsonl` : `${key}.${suffix}.jsonl`);
  }

  /** Resolve the file to append to, rolling to the next suffix once the current one reaches the cap. */
  private target(now: Date): string {
    const key = localDateKey(now);
    if (!this.current || this.current.key !== key) {
      let suffix = 0;
      try {
        for (const name of fs.readdirSync(this.dir)) {
          const m = FILE_RE.exec(name);
          if (m && m[1] === key) suffix = Math.max(suffix, m[2] ? Number(m[2]) : 0);
        }
      } catch {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      }
      let size = 0;
      try {
        size = fs.statSync(this.fileFor(key, suffix)).size;
      } catch {
        size = 0;
      }
      this.current = { key, suffix, size };
    }
    if (this.current.size >= this.maxFileBytes) {
      this.current = { key, suffix: this.current.suffix + 1, size: 0 };
    }
    return this.fileFor(key, this.current.suffix);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private reportError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorAt < ERROR_THROTTLE_MS) return;
    this.lastErrorAt = now;
    try {
      this.onError?.(err);
    } catch {
      // never throw into callers
    }
  }
}
