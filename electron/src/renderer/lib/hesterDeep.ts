/**
 * Typed wrappers for Hester's Deep endpoints (Deep D1 §3.2, §8.1): the Page,
 * references, asks and answers, questions, sessions, explore and the opener.
 * Same shape as lib/hesterCockpit.ts: every call names its workspace as
 * `?workspace=` and `X-Lee-Workspace`, carries the bearer token, and accepts
 * both the `{success, data}` envelope and a bare body. A failure keeps the
 * parsed error body (`body`) so the Page's 409 can show both sides (§4.3).
 *
 * Also the Someday capture (POST /someday with a Deep source, §5), the opener
 * (GET /copilot/opener, §8.2) and an exploration create that takes `page` and
 * origin `opener` (§3.2).
 *
 * Every call here is data only; the one model call (POST /asks) runs only
 * because the user asked (C2).
 */

import { hesterHeaders, HESTER_DAEMON_URL, type Exploration } from './hesterCockpit';
import type { Anchor, DeepAnswer, DeepQuestion, DeepReference, DeepSessionRecord, Opener } from '../../shared/cockpit';

export type DeepResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number; body?: unknown };

async function call<T>(workspace: string, method: string, path: string, body?: unknown): Promise<DeepResult<T>> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${HESTER_DAEMON_URL}${path}${sep}workspace=${encodeURIComponent(workspace)}`;
  const headers = await hesterHeaders(workspace);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const env = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in parsed ? (parsed as { success: boolean; data?: unknown; error?: string }) : null;
    if (!res.ok || (env && env.success !== true)) {
      const detail = env?.error || (parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : null);
      return {
        ok: false,
        error: detail || (res.status === 404 ? 'Not available in this Hester' : `Hester error (${res.status})`),
        status: res.status,
        body: env && env.data !== undefined ? env.data : parsed,
      };
    }
    return { ok: true, data: (env ? env.data : parsed) as T };
  } catch {
    return { ok: false, error: 'Hester offline' };
  }
}

const expPath = (id: string, rest = '') => `/cockpit/explorations/${encodeURIComponent(id)}${rest}`;

// ---------------------------------------------------------------------------
// Page (§3.2, §4.3)
// ---------------------------------------------------------------------------

export interface PageDoc {
  text: string;
  version: string;
}

export function getPage(workspace: string, id: string): Promise<DeepResult<PageDoc>> {
  return call<PageDoc>(workspace, 'GET', expPath(id, '/page'));
}

export type PutPageResult =
  | { ok: true; version: string }
  | { ok: false; conflict: PageDoc }
  | { ok: false; conflict?: undefined; error: string; status?: number };

/** PUT /page with base_version; a 409 carries the current text and version back. */
export async function putPage(workspace: string, id: string, text: string, baseVersion: string | null): Promise<PutPageResult> {
  const r = await call<{ version: string }>(workspace, 'PUT', expPath(id, '/page'), { text, base_version: baseVersion });
  if (r.ok) return { ok: true, version: r.data.version };
  if (r.status === 409) {
    const b = (r.body ?? {}) as { version?: unknown; text?: unknown; data?: { version?: unknown; text?: unknown } };
    const src = typeof b.version === 'string' ? b : b.data ?? {};
    if (typeof src.version === 'string') return { ok: false, conflict: { version: src.version, text: typeof src.text === 'string' ? src.text : '' } };
  }
  return { ok: false, error: r.error, status: r.status };
}

// ---------------------------------------------------------------------------
// References (§3.4)
// ---------------------------------------------------------------------------

export interface ReferenceCreate {
  kind: 'quote' | 'link';
  quote?: string;
  url?: string;
  title?: string;
  note?: string;
  section?: string | null;
  source?: { kind: 'page' | 'palette' | 'answer'; ref?: string };
}

export function listReferences(workspace: string, id: string): Promise<DeepResult<DeepReference[]>> {
  return call<DeepReference[]>(workspace, 'GET', expPath(id, '/references'));
}

export function addReference(workspace: string, id: string, body: ReferenceCreate): Promise<DeepResult<DeepReference>> {
  return call<DeepReference>(workspace, 'POST', expPath(id, '/references'), body);
}

export function patchReference(workspace: string, id: string, rid: string, body: { note?: string; opened?: true }): Promise<DeepResult<DeepReference>> {
  return call<DeepReference>(workspace, 'PATCH', expPath(id, `/references/${encodeURIComponent(rid)}`), body);
}

// ---------------------------------------------------------------------------
// Asks and answers (§3.5, §6)
// ---------------------------------------------------------------------------

export function listAnswers(workspace: string, id: string): Promise<DeepResult<DeepAnswer[]>> {
  return call<DeepAnswer[]>(workspace, 'GET', expPath(id, '/answers'));
}

/** Queues a deep-ask (202). Only ever called from a user's Ask, Follow up or affordance click (C2). */
export function askDeep(
  workspace: string,
  id: string,
  body: { question: string; anchor: Anchor; follow_up_of?: string },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', expPath(id, '/asks'), body);
}

export function patchAnswer(
  workspace: string,
  id: string,
  aid: string,
  body: { read?: true; dismissed?: true; inserted?: true; kept?: true },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'PATCH', expPath(id, `/answers/${encodeURIComponent(aid)}`), body);
}

/** Re-queues an errored or interrupted answer (a user's Retry click). */
export function retryAnswer(workspace: string, id: string, aid: string): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', expPath(id, `/answers/${encodeURIComponent(aid)}/retry`), {});
}

// ---------------------------------------------------------------------------
// Questions (§3.7), sessions (§3.6), explore (§3.2)
// ---------------------------------------------------------------------------

export function listQuestions(workspace: string, id: string): Promise<DeepResult<DeepQuestion[]>> {
  return call<DeepQuestion[]>(workspace, 'GET', expPath(id, '/questions'));
}

export function addQuestion(
  workspace: string,
  id: string,
  body: { text: string; source: 'page' | 'ask'; anchor?: Anchor },
): Promise<DeepResult<DeepQuestion>> {
  return call<DeepQuestion>(workspace, 'POST', expPath(id, '/questions'), body);
}

export function patchQuestion(workspace: string, id: string, qid: string, status: 'open' | 'closed'): Promise<DeepResult<DeepQuestion>> {
  return call<DeepQuestion>(workspace, 'PATCH', expPath(id, `/questions/${encodeURIComponent(qid)}`), { status });
}

export function postSession(workspace: string, id: string, record: Omit<DeepSessionRecord, 'id'>): Promise<DeepResult<DeepSessionRecord>> {
  return call<DeepSessionRecord>(workspace, 'POST', expPath(id, '/sessions'), record);
}

/** A child exploration seeded from a selection, linked both ways; doesn't switch. */
export function exploreFrom(workspace: string, id: string, body: { seed: string; anchor?: Anchor }): Promise<DeepResult<Exploration>> {
  return call<Exploration>(workspace, 'POST', expPath(id, '/explore'), body);
}

// ---------------------------------------------------------------------------
// Explorations with a Page, Someday capture, the opener
// ---------------------------------------------------------------------------

export interface DeepExplorationCreate {
  title?: string;
  seed?: string;
  /** The initial page.md (the opener writes your text into it). */
  page?: string;
  origin?: { kind: 'opener' | 'cockpit' | 'exploration'; ref?: string | null };
}

export function createDeepExploration(workspace: string, input: DeepExplorationCreate): Promise<DeepResult<Exploration>> {
  return call<Exploration>(workspace, 'POST', '/cockpit/explorations', { ...input, workspace });
}

export interface DeepCaptureSource {
  surface: 'lee';
  exploration_id: string;
  section?: string | null;
  url?: string;
  context?: string;
}

/** Capture to Someday with where it came from (§5). */
export function captureSomeday(workspace: string, text: string, source: DeepCaptureSource): Promise<DeepResult<{ id: string }>> {
  return call<{ id: string }>(workspace, 'POST', '/someday', { workspace, text, as: 'someday', source });
}

export function fetchOpener(workspace: string): Promise<DeepResult<Opener>> {
  return call<Opener>(workspace, 'GET', '/copilot/opener');
}
