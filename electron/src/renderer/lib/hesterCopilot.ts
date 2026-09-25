/**
 * Typed wrappers for the Hester-side Copilot HTTP endpoints (contracts §8.4,
 * §8.6) that the Lee renderer calls directly: the session-start digest and
 * the weekly retro. Everything else (attention queue, focus, capture,
 * devices, presence) goes through `window.lee.copilot` instead.
 *
 * Auth: `installHesterAuth()` (src/renderer/lib/hesterAuth.ts, installed once
 * in main.tsx) attaches the shared bearer token to every fetch aimed at the
 * daemon origin, so plain `fetch(...)` here is enough.
 */

import type { AttentionItem, FocusItem } from '../../shared/copilot';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

export interface DigestWin {
  kind: 'commit' | 'merge' | 'decision' | 'someday_decided' | string;
  title: string;
  ref?: string;
  at: string;
  verified: boolean;
  related: boolean;
}

export interface DigestAgentClaim {
  session_id: string;
  pty_id: number | null;
  summary: string;
  lee_status?: unknown;
  at: string;
  verified: boolean;
  related: boolean;
}

export interface DigestResponse {
  generated_at: string;
  workspace: string;
  since: string;
  focus: FocusItem | null;
  top_line: string;
  wins: DigestWin[];
  agent_claims: DigestAgentClaim[];
  changed: { agent_files: string[]; commits: number };
  /** Compact AttentionItems, filtered to this workspace. */
  waiting: AttentionItem[];
  someday: { open: number; untriaged_over_7d: number };
  retro: { due: boolean; week: string };
}

export interface RetroQuestion {
  id: string;
  text: string;
}

export interface RetroWin {
  kind: string;
  title: string;
  ref?: string;
  at: string;
}

export interface RetroResponse {
  week: string;
  due: boolean;
  answered: boolean;
  skipped: boolean;
  questions: RetroQuestion[];
  wins: RetroWin[];
}

export type HesterResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function getJson<T>(path: string): Promise<HesterResult<T>> {
  try {
    const res = await fetch(`${HESTER_DAEMON}${path}`);
    if (!res.ok) return { ok: false, error: `Hester offline (${res.status})` };
    const body = await res.json();
    if (!body || body.success !== true) {
      return { ok: false, error: (body && body.error) || 'Hester offline' };
    }
    return { ok: true, data: body.data as T };
  } catch {
    return { ok: false, error: 'Hester offline' };
  }
}

async function postJson<T>(path: string, payload: unknown): Promise<HesterResult<T>> {
  try {
    const res = await fetch(`${HESTER_DAEMON}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `Hester offline (${res.status})` };
    const body = await res.json();
    if (!body || body.success !== true) {
      return { ok: false, error: (body && body.error) || 'Hester offline' };
    }
    return { ok: true, data: body.data as T };
  } catch {
    return { ok: false, error: 'Hester offline' };
  }
}

export interface DigestQuery {
  workspace: string;
  since?: string;
  focus?: FocusItem | null;
  onlyRelated?: boolean;
}

export function fetchDigest(query: DigestQuery): Promise<HesterResult<DigestResponse>> {
  const params = new URLSearchParams({ workspace: query.workspace });
  if (query.since) params.set('since', query.since);
  if (query.focus) params.set('focus', JSON.stringify(query.focus));
  if (query.onlyRelated) params.set('only_related', '1');
  return getJson<DigestResponse>(`/copilot/digest?${params.toString()}`);
}

/**
 * `peek` asks Hester for retro status without the side effect of marking the
 * week's retro "shown" (use it for background polling; the RetroCard, which
 * actually displays the retro, fetches without it).
 */
export function fetchRetro(opts: { peek?: boolean } = {}): Promise<HesterResult<RetroResponse>> {
  return getJson<RetroResponse>(opts.peek ? '/copilot/retro?peek=1' : '/copilot/retro');
}

export interface RetroSaveRequest {
  week: string;
  answers?: Record<string, string>;
  skipped?: boolean;
}

export function saveRetro(req: RetroSaveRequest): Promise<HesterResult<{ week: string }>> {
  return postJson<{ week: string }>('/copilot/retro', req);
}
