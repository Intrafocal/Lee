/**
 * Recent shell commands per workspace, in memory only (contract §5.2, user
 * decision 2026-09-25): never written to disk, lost on restart.
 *
 * Pure: no electron imports.
 */

import * as crypto from 'crypto';
import * as path from 'path';

export const HISTORY_MAX = 200;

export interface CommandRecord {
  ts: string;
  sig: string;
  text: string;
  cwd: string | null;
  pty_id: number;
  exit_code: number | null;
  by: 'user' | 'lee';
}

/** Trimmed, runs of whitespace collapsed to one space. */
export function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** First 12 hex of sha1(normalized command line). */
export function commandSig(text: string): string {
  return crypto.createHash('sha1').update(normalizeCommand(text)).digest('hex').slice(0, 12);
}

const PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'command', 'exec', 'nohup']);

/** Program name: first word after leading VAR=value assignments and sudo/env/time. */
export function commandArgv0(text: string): string {
  const words = normalizeCommand(text).split(' ').filter(Boolean);
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (PREFIX_WORDS.has(w)) continue;
    if (w.startsWith('-')) continue;
    const bare = w.replace(/^['"]|['"]$/g, '');
    return path.basename(bare) || bare;
  }
  return '';
}

export class CommandHistory {
  private byWorkspace = new Map<string, CommandRecord[]>();
  private readonly max: number;

  constructor(max: number = HISTORY_MAX) {
    this.max = max;
  }

  append(workspace: string | null, rec: CommandRecord): void {
    const key = workspace ?? '';
    const list = this.byWorkspace.get(key) ?? [];
    list.push(rec);
    if (list.length > this.max) list.splice(0, list.length - this.max);
    this.byWorkspace.set(key, list);
  }

  /** Full text of the most recent command with this signature, or null. */
  lookup(workspace: string | null, sig: string): string | null {
    const list = this.byWorkspace.get(workspace ?? '');
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].sig === sig) return list[i].text;
    return null;
  }

  recent(workspace: string | null): CommandRecord[] {
    return [...(this.byWorkspace.get(workspace ?? '') ?? [])];
  }
}
