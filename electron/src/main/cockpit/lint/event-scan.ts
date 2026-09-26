/**
 * Startup history for the lint rules (contracts §8.2): stream the last N days
 * of ~/.lee/events/*.jsonl and hand consumed events to a callback. Lines that
 * don't mention a consumed type are skipped before JSON.parse.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { LeeEvent } from '../../../shared/copilot';
import { DAY_MS } from './types';

const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.jsonl$/;

/** Event-log files whose local date is within `days` of `now`, oldest first. */
export function eventFiles(dir: string, days: number, now: number = Date.now()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const cutoff = new Date(now - days * DAY_MS);
  cutoff.setHours(0, 0, 0, 0);
  const files: Array<{ name: string; t: number; n: number }> = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff.getTime()) continue;
    files.push({ name, t, n: m[4] ? Number(m[4]) : 0 });
  }
  files.sort((a, b) => a.t - b.t || a.n - b.n);
  return files.map((f) => path.join(dir, f.name));
}

/**
 * Feed every consumed event from the last `days` days to `onEvent`. Events at
 * or after `until` (ms) are skipped: the caller receives those live.
 */
export async function scanEvents(opts: {
  dir: string;
  days: number;
  types: string[];
  onEvent: (ev: LeeEvent) => void;
  until?: number;
  now?: number;
}): Promise<number> {
  const needles = opts.types.map((t) => `"type":"${t}"`);
  const since = (opts.now ?? Date.now()) - opts.days * DAY_MS;
  let count = 0;
  for (const file of eventFiles(opts.dir, opts.days, opts.now)) {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch {
      continue;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!needles.some((n) => line.includes(n))) continue;
        let ev: LeeEvent;
        try {
          ev = JSON.parse(line) as LeeEvent;
        } catch {
          continue;
        }
        if (!ev || typeof ev.type !== 'string' || !opts.types.includes(ev.type)) continue;
        const ts = Date.parse(ev.ts);
        if (!Number.isFinite(ts) || ts < since) continue;
        if (opts.until !== undefined && ts >= opts.until) continue;
        opts.onEvent(ev);
        count++;
      }
    } catch {
      // unreadable file: skip it
    } finally {
      rl.close();
      stream.destroy();
    }
  }
  return count;
}
