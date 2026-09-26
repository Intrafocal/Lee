/**
 * Relays explicit task records (launches, createTask) to Hester's
 * POST /cockpit/tasks (contract §5.6 step 6). When Hester is unreachable the
 * record is appended to ~/.lee/spool/tasks.jsonl (0600) and retried every
 * 60 s while the spool is non-empty. Records never carry a prompt.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeWorkspaceHeader,
  type AgentNameSource,
  type TaskAgentRef,
  type TaskContextRef,
  type TaskKind,
  type TaskLead,
  type TaskOrigin,
  type TaskStatus,
  type TaskWorktree,
} from '../../shared/cockpit';

const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;

export interface TaskRecord {
  id: string;
  workspace: string;
  title: string;
  title_source: 'user' | 'agent' | 'auto';
  kind: TaskKind;
  lead: TaskLead;
  play: boolean;
  status: TaskStatus;
  agent: TaskAgentRef | null;
  serves: string[];
  confirmed: boolean;
  origin: TaskOrigin;
  note?: string | null;
  /** Session name you typed (Launcher Name field); never derived from the prompt. */
  name?: string | null;
  name_source?: AgentNameSource | null;
  /** Context attached at launch: workspace-relative paths and bundle ids only. */
  context?: TaskContextRef | null;
  /** The launch's git worktree (contract v3 §4). */
  worktree?: TaskWorktree | null;
}

/** A name change for a task (by id) or an agent session (by session id). */
export interface NameRecord {
  workspace: string;
  task_id?: string | null;
  session_id?: string | null;
  name: string | null;
  source: AgentNameSource;
}

type PostOutcome = { ok: true } | { ok: false; retry: boolean; error: string };

export interface TaskRelayOptions {
  spoolFile?: string;
  getHesterPort: () => number;
  getSharedToken?: () => string;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>) => void;
  retryMs?: number;
}

export function defaultSpoolFile(home: string = os.homedir()): string {
  return path.join(home, '.lee', 'spool', 'tasks.jsonl');
}

function readSharedToken(): string {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.lee', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export class TaskRelay {
  private readonly spoolFile: string;
  private readonly opts: TaskRelayOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: TaskRelayOptions) {
    this.opts = opts;
    this.spoolFile = opts.spoolFile ?? defaultSpoolFile();
    if (this.spoolSize() > 0) this.ensureRetry();
  }

  /** Deliver now, or spool for retry. Returns true when Hester took it. */
  async relay(record: TaskRecord): Promise<boolean> {
    const outcome = await this.post(record);
    if (outcome.ok) return true;
    if (!outcome.retry) {
      this.opts.log?.('WARN', 'Hester rejected a task record', { task_id: record.id, error: outcome.error });
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(this.spoolFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.spoolFile, JSON.stringify(record) + '\n', { mode: 0o600 });
      fs.chmodSync(this.spoolFile, 0o600);
    } catch (err) {
      this.opts.log?.('ERROR', 'Task spool write failed', { error: String(err) });
    }
    this.ensureRetry();
    return false;
  }

  /**
   * Best effort: tell Hester a task's name changed (POST /cockpit/tasks/name).
   * Not spooled: detected names repeat on every turn end, and a name you
   * typed is also in the launch record or retried by the renderer.
   */
  async relayName(rec: NameRecord): Promise<boolean> {
    if (!rec.task_id && !rec.session_id) return false;
    const out = await this.postTo('/cockpit/tasks/name', rec.workspace, rec);
    return out.ok;
  }

  /** Retry spooled records in order; stops at the first Hester still can't take. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let delivered = 0;
    try {
      let lines: string[];
      try {
        lines = fs.readFileSync(this.spoolFile, 'utf8').split('\n').filter((l) => l.trim());
      } catch {
        lines = [];
      }
      const remaining: string[] = [];
      let blocked = false;
      for (const line of lines) {
        if (blocked) {
          remaining.push(line);
          continue;
        }
        let rec: TaskRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const outcome = await this.post(rec);
        if (outcome.ok) delivered++;
        else if (outcome.retry) {
          blocked = true;
          remaining.push(line);
        } else {
          this.opts.log?.('WARN', 'Dropped spooled task record rejected by Hester', { task_id: rec.id, error: outcome.error });
        }
      }
      if (delivered > 0 || remaining.length !== lines.length) this.rewrite(remaining, lines.length);
      if (delivered > 0) this.opts.log?.('INFO', 'Delivered spooled task records', { delivered, remaining: remaining.length });
      if (this.spoolSize() === 0) this.stop();
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
    try {
      return fs.readFileSync(this.spoolFile, 'utf8').split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  private post(rec: TaskRecord): Promise<PostOutcome> {
    return this.postTo('/cockpit/tasks', rec.workspace, rec);
  }

  private async postTo(route: string, workspace: string, body: unknown): Promise<PostOutcome> {
    const url = `http://127.0.0.1:${this.opts.getHesterPort()}${route}`;
    const token = (this.opts.getSharedToken ?? readSharedToken)();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Lee-Workspace': encodeWorkspaceHeader(workspace),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      try {
        await res.arrayBuffer();
      } catch {
        // body not needed
      }
      if (res.ok) return { ok: true };
      if (res.status === 400 || res.status === 422) return { ok: false, retry: false, error: `Hester returned ${res.status}` };
      return { ok: false, retry: true, error: `Hester returned ${res.status}` };
    } catch (err) {
      return { ok: false, retry: true, error: String(err) };
    }
  }

  private rewrite(lines: string[], consumed: number): void {
    try {
      let appended: string[] = [];
      try {
        appended = fs.readFileSync(this.spoolFile, 'utf8').split('\n').filter((l) => l.trim()).slice(consumed);
      } catch {
        appended = [];
      }
      const all = [...lines, ...appended];
      if (all.length === 0) {
        fs.rmSync(this.spoolFile, { force: true });
        return;
      }
      const tmp = `${this.spoolFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, all.join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.spoolFile);
    } catch (err) {
      this.opts.log?.('ERROR', 'Task spool rewrite failed', { error: String(err) });
    }
  }

  private spoolSize(): number {
    try {
      return fs.statSync(this.spoolFile).size;
    } catch {
      return 0;
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
