/**
 * Desk session records Lee main writes (Desk D2 §5.2): a Deep session ended
 * from a device (End and rate, reason 'device') or by an ignored idle-end
 * push (reason 'away'). Posted to Hester's POST /desk/sessions; when Hester
 * is unreachable the record is appended to ~/.lee/spool/desk-sessions.jsonl
 * (0600) and retried every 60 s while the spool is non-empty, like captures.
 *
 * Contract: docs/plans/2026-09-27-desk-foundation-contract.md §5.2, §9.2.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DeskSessionCreate } from '../../shared/desk';
import { hesterCall, type HesterCall } from './tether';

const RETRY_MS = 60_000;
/** Hester keeps 1000 characters of stopped_at. */
export const DESK_STOPPED_AT_MAX = 1000;

interface Spooled {
  workspace: string;
  record: DeskSessionCreate;
}

type PostOutcome = { ok: true } | { ok: false; retry: boolean; error: string };

export interface DeskSessionRelayOptions {
  spoolFile?: string;
  /** Tests inject a fake; defaults to the real Hester. */
  hester?: HesterCall;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
  retryMs?: number;
}

export function defaultDeskSessionSpool(home: string = os.homedir()): string {
  return path.join(home, '.lee', 'spool', 'desk-sessions.jsonl');
}

export class DeskSessionRelay {
  private readonly spoolFile: string;
  private readonly hester: HesterCall;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(private readonly opts: DeskSessionRelayOptions = {}) {
    this.spoolFile = opts.spoolFile ?? defaultDeskSessionSpool();
    this.hester = opts.hester ?? hesterCall;
    if (this.pending() > 0) this.ensureRetry();
  }

  /** Deliver now, or spool for retry. Resolves 'sent', 'spooled' or 'rejected'. */
  async relay(workspace: string, record: DeskSessionCreate): Promise<'sent' | 'spooled' | 'rejected'> {
    const outcome = await this.post({ workspace, record });
    if (outcome.ok) return 'sent';
    if (!outcome.retry) {
      this.opts.log?.('WARN', 'Hester rejected a Desk session record', { error: outcome.error });
      return 'rejected';
    }
    try {
      fs.mkdirSync(path.dirname(this.spoolFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.spoolFile, JSON.stringify({ workspace, record }) + '\n', { mode: 0o600 });
      fs.chmodSync(this.spoolFile, 0o600);
    } catch (err) {
      this.opts.log?.('ERROR', 'Desk session spool write failed', { error: String(err) });
    }
    this.ensureRetry();
    return 'spooled';
  }

  /** Retry spooled records in order; stops at the first Hester still can't take. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let delivered = 0;
    try {
      const lines = this.lines();
      const remaining: string[] = [];
      let blocked = false;
      for (const line of lines) {
        if (blocked) {
          remaining.push(line);
          continue;
        }
        let entry: Spooled;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const outcome = await this.post(entry);
        if (outcome.ok) delivered++;
        else if (outcome.retry) {
          blocked = true;
          remaining.push(line);
        } else {
          this.opts.log?.('WARN', 'Dropped a spooled Desk session record Hester rejected', { error: outcome.error });
        }
      }
      if (delivered > 0 || remaining.length !== lines.length) this.rewrite(remaining, lines.length);
      if (delivered > 0) this.opts.log?.('INFO', 'Delivered spooled Desk session records', { delivered, remaining: remaining.length });
      if (this.pending() === 0) this.stop();
    } finally {
      this.draining = false;
    }
    return delivered;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pending(): number {
    return this.lines().length;
  }

  private lines(): string[] {
    try {
      return fs.readFileSync(this.spoolFile, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  /**
   * 400/422 is a record Hester will never take. 404 is a daemon older than
   * the Desk: kept for after the reinstall, like an offline one.
   */
  private async post(entry: Spooled): Promise<PostOutcome> {
    const r = await this.hester('POST', '/desk/sessions', entry.workspace, entry.record);
    if (r.offline) return { ok: false, retry: true, error: 'offline' };
    if (r.status >= 200 && r.status < 300) return { ok: true };
    if (r.status === 400 || r.status === 422) return { ok: false, retry: false, error: `Hester returned ${r.status}` };
    return { ok: false, retry: true, error: `Hester returned ${r.status}` };
  }

  private rewrite(lines: string[], consumed: number): void {
    try {
      const all = [...lines, ...this.lines().slice(consumed)];
      if (all.length === 0) {
        fs.rmSync(this.spoolFile, { force: true });
        return;
      }
      const tmp = `${this.spoolFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, all.join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.spoolFile);
    } catch (err) {
      this.opts.log?.('ERROR', 'Desk session spool rewrite failed', { error: String(err) });
    }
  }

  private ensureRetry(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain();
    }, this.opts.retryMs ?? RETRY_MS);
    this.timer.unref?.();
  }
}

let relay: DeskSessionRelay | null = null;

/** The process-wide relay, created on first use. */
export function getDeskSessionRelay(): DeskSessionRelay {
  if (!relay) relay = new DeskSessionRelay();
  return relay;
}
