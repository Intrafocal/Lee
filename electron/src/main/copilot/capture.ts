/**
 * Idea capture relay (contracts §10.A, decision 12).
 *
 * Renderer and devices → Lee → Hester `POST /someday` with the shared token.
 * If Hester is unreachable the capture is appended to ~/.lee/spool/someday.jsonl
 * and retried every 60 s while the spool is non-empty. Logs a `capture` event
 * with counts only (never the text).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Actor, CaptureRequest, CaptureResult } from '../../shared/copilot';
import { windowRegistry } from '../window-registry';
import { logEvent } from './bus';

export const CAPTURE_MAX_CHARS = 10_000;
const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;

export interface CaptureSource {
  surface: string;
  device_id?: string;
}

interface SomedayPayload {
  text: string;
  workspace?: string;
  as: 'someday' | 'explore';
  source: CaptureSource;
}

type PostOutcome = { ok: true; id: string | null } | { ok: false; retry: boolean; error: string };

export interface CaptureRelayOptions {
  spoolFile: string;
  getHesterPort: () => number;
  getSharedToken: () => string;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, any>) => void;
}

export class CaptureRelay {
  private readonly opts: CaptureRelayOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: CaptureRelayOptions) {
    this.opts = opts;
    if (this.spoolSize() > 0) this.ensureRetry();
  }

  async capture(
    req: CaptureRequest,
    meta: { actor: Actor; source: CaptureSource; workspace: string | null; window_id?: number | null },
  ): Promise<CaptureResult> {
    const text = typeof req?.text === 'string' ? req.text.trim() : '';
    if (!text) return { success: false, error: 'text is required' };
    if (text.length > CAPTURE_MAX_CHARS) return { success: false, error: `text must be at most ${CAPTURE_MAX_CHARS} characters` };
    const as: 'someday' | 'explore' = req.as === 'explore' ? 'explore' : 'someday';
    const payload: SomedayPayload = {
      text,
      as,
      source: meta.source,
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
    };

    const outcome = await this.post(payload);
    let result: CaptureResult;
    if (outcome.ok) {
      result = { success: true, someday_id: outcome.id, spooled: false };
    } else if (!outcome.retry) {
      return { success: false, error: outcome.error };
    } else {
      try {
        this.appendSpool(payload);
      } catch (err) {
        this.opts.log?.('ERROR', 'Capture spool write failed', { error: String(err) });
        return { success: false, error: 'Hester is unreachable and the spool could not be written' };
      }
      this.ensureRetry();
      result = { success: true, someday_id: null, spooled: true };
    }

    logEvent({
      type: 'capture',
      workspace: meta.workspace,
      window_id: meta.window_id ?? null,
      actor: meta.actor,
      data: {
        ...(result.someday_id ? { someday_id: result.someday_id } : {}),
        text_chars: text.length,
        as,
        spooled: !!result.spooled,
      },
    });
    return result;
  }

  /** Retry spooled captures in order; stops at the first one Hester still can't take. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let delivered = 0;
    try {
      let lines: string[];
      try {
        lines = fs.readFileSync(this.opts.spoolFile, 'utf8').split('\n').filter((l) => l.trim());
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
        let payload: SomedayPayload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        const outcome = await this.post(payload);
        if (outcome.ok) delivered++;
        else if (outcome.retry) {
          blocked = true;
          remaining.push(line);
        } else {
          this.opts.log?.('WARN', 'Dropped spooled capture rejected by Hester', { error: outcome.error });
        }
      }
      if (delivered > 0 || remaining.length !== lines.length) this.rewriteSpool(remaining, lines.length);
      if (delivered > 0) this.opts.log?.('INFO', 'Delivered spooled captures', { delivered, remaining: remaining.length });
      if (this.spoolSize() === 0) this.stopRetry();
    } finally {
      this.draining = false;
    }
    return delivered;
  }

  stop(): void {
    this.stopRetry();
  }

  private async post(payload: SomedayPayload): Promise<PostOutcome> {
    const url = `http://127.0.0.1:${this.opts.getHesterPort()}/someday`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.getSharedToken()}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        let id: string | null = null;
        try {
          const body: any = await res.json();
          const data = body?.data ?? body;
          if (typeof data?.id === 'string') id = data.id;
        } catch {
          // a success without a parseable body still counts as delivered
        }
        return { ok: true, id };
      }
      if (res.status === 400 || res.status === 422) {
        let error = `Hester rejected the capture (${res.status})`;
        try {
          const body: any = await res.json();
          if (typeof body?.error === 'string') error = body.error;
          else if (typeof body?.detail === 'string') error = body.detail;
        } catch {
          // keep the generic message
        }
        return { ok: false, retry: false, error };
      }
      return { ok: false, retry: true, error: `Hester returned ${res.status}` };
    } catch (err) {
      return { ok: false, retry: true, error: String(err) };
    }
  }

  private appendSpool(payload: SomedayPayload): void {
    fs.mkdirSync(path.dirname(this.opts.spoolFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.opts.spoolFile, JSON.stringify(payload) + '\n', { mode: 0o600 });
  }

  /** Replace the first `consumed` lines with `lines`, keeping anything appended while draining. */
  private rewriteSpool(lines: string[], consumed: number): void {
    try {
      let appended: string[] = [];
      try {
        appended = fs.readFileSync(this.opts.spoolFile, 'utf8').split('\n').filter((l) => l.trim()).slice(consumed);
      } catch {
        appended = [];
      }
      lines = [...lines, ...appended];
      if (lines.length === 0) {
        fs.rmSync(this.opts.spoolFile, { force: true });
        return;
      }
      const tmp = `${this.opts.spoolFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.opts.spoolFile);
    } catch (err) {
      this.opts.log?.('ERROR', 'Capture spool rewrite failed', { error: String(err) });
    }
  }

  private spoolSize(): number {
    try {
      return fs.statSync(this.opts.spoolFile).size;
    } catch {
      return 0;
    }
  }

  private ensureRetry(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain();
    }, RETRY_MS);
    this.timer.unref?.();
  }

  private stopRetry(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

let relay: CaptureRelay | null = null;
let hesterPort: () => number = () => 9000;

export function setCaptureRelay(r: CaptureRelay | null): void {
  relay = r;
}

export function getCaptureRelay(): CaptureRelay | null {
  return relay;
}

/** The API server knows Hester's port (hester.listen_port); registerCoreRoutes hands it over. */
export function setHesterPortProvider(fn: () => number): void {
  hesterPort = fn;
}

export function getHesterPort(): number {
  try {
    const p = hesterPort();
    return p > 0 ? p : 9000;
  } catch {
    return 9000;
  }
}

/**
 * A capture's workspace must be an open window's workspace. Without one, use
 * the sender's window (IPC), else the focused window, else any window.
 */
export function resolveCaptureWorkspace(
  requested: unknown,
  senderWindowId: number | null,
): { ok: true; workspace: string | null; window_id: number | null } | { ok: false; error: string } {
  if (typeof requested === 'string' && requested.trim()) {
    const want = path.resolve(requested.trim());
    for (const [id, ws] of windowRegistry.getAll()) {
      if (ws.workspace && path.resolve(ws.workspace) === want) return { ok: true, workspace: ws.workspace, window_id: id };
    }
    return { ok: false, error: "workspace must be an open window's workspace" };
  }
  const state =
    (senderWindowId != null ? windowRegistry.get(senderWindowId) : undefined) ||
    windowRegistry.getFocused() ||
    windowRegistry.getAny();
  if (!state) return { ok: true, workspace: null, window_id: null };
  return { ok: true, workspace: state.workspace, window_id: state.browserWindow.id };
}
