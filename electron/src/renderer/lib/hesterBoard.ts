/**
 * Typed client for Hester's Board routes (plan docs/plans/2026-09-28-boards.md
 * §3; contract shared/board.ts): create, read, rename and delete a Board,
 * its board.json (versioned, 409 on a stale version), its assets (raw PNG
 * or JPEG, an optional `source`) and its preview.png. Same `call` as
 * lib/hesterDesk.ts (workspace as `?workspace=` and `X-Lee-Workspace`, the
 * bearer token, the copilot envelope, the error body kept for 409s).
 *
 * Images come back as Blobs fetched with auth (an <img src> can't carry the
 * token); lib/boardAssets.ts keeps them as blob: URLs and bitmaps. A Board's
 * Asks and hand-offs are lib/hesterBoardAsks.ts.
 */

import { hesterCall as call, type DeepResult } from './hesterDeep';
import { HESTER_DAEMON_URL, hesterHeaders } from './hesterCockpit';
import type { DeskCard } from '../../shared/desk';
import type { AssetSource, BoardAsset, BoardCreate, BoardCreated, BoardDoc, BoardItem, BoardPut } from '../../shared/board';

export type { DeepResult as BoardResult };

const seg = (s: string) => encodeURIComponent(s);
const boardRoute = (id: string, rest = '') => `/desk/boards/${seg(id)}${rest}`;

// ---- the Board card ----

/** A Board in `area_id` at x/y (Board card placement is Hester's when absent). */
export function createBoard(workspace: string, body: BoardCreate): Promise<DeepResult<BoardCreated>> {
  return call<BoardCreated>(workspace, 'POST', '/desk/boards', body);
}

export function getBoard(workspace: string, id: string): Promise<DeepResult<DeskCard>> {
  return call<DeskCard>(workspace, 'GET', boardRoute(id));
}

export function patchBoard(workspace: string, id: string, body: { title: string }): Promise<DeepResult<DeskCard>> {
  return call<DeskCard>(workspace, 'PATCH', boardRoute(id), body);
}

/** Like a Page's: 409 `not_empty` unless `force` (the user confirmed). Not undoable. */
export function deleteBoard(workspace: string, id: string, force = false): Promise<DeepResult<{ deleted: true }>> {
  return call<{ deleted: true }>(workspace, 'DELETE', boardRoute(id), force ? { force: true } : undefined);
}

// ---- board.json ----

export function getBoardDoc(workspace: string, id: string): Promise<DeepResult<BoardDoc>> {
  return call<BoardDoc>(workspace, 'GET', boardRoute(id, '/board'));
}

export type PutBoardResult =
  | { ok: true; version: string }
  /** 409: the Board changed elsewhere. `conflict` is Hester's copy when the 409 carried it, else null (GET it). */
  | { ok: false; conflict: BoardDoc | null }
  | { ok: false; conflict?: undefined; error: string; status?: number };

/** PUT /board with the version it was read at; a 409 carries the current doc back when Hester sends it. */
export async function putBoardDoc(workspace: string, id: string, version: string | null, items: BoardItem[]): Promise<PutBoardResult> {
  const body: BoardPut = { version, items };
  const r = await call<{ version: string }>(workspace, 'PUT', boardRoute(id, '/board'), body);
  if (r.ok) return { ok: true, version: r.data.version };
  if (r.status === 409) {
    const b = (r.body ?? {}) as { version?: unknown; items?: unknown; data?: { version?: unknown; items?: unknown }; board?: { version?: unknown; items?: unknown } };
    const src = typeof b.version === 'string' ? b : b.board ?? b.data ?? {};
    return { ok: false, conflict: typeof src.version === 'string' && Array.isArray(src.items) ? { version: src.version, items: src.items as BoardItem[] } : null };
  }
  return { ok: false, error: r.error, status: r.status };
}

// ---- raw bodies: assets and the preview ----

async function rawSend<T>(workspace: string, method: string, path: string, bytes: Blob | Uint8Array, mime: string): Promise<DeepResult<T>> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${HESTER_DAEMON_URL}${path}${sep}workspace=${encodeURIComponent(workspace)}`;
  try {
    const body = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
    const res = await fetch(url, { method, headers: await hesterHeaders(workspace, { 'Content-Type': mime }), body });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const env = parsed && typeof parsed === 'object' && 'success' in parsed ? (parsed as { success: boolean; data?: unknown; error?: string }) : null;
    if (!res.ok || (env && env.success !== true)) {
      const detail = env?.error || (parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : null);
      return { ok: false, error: detail || (res.status === 404 ? 'Not available in this Hester' : `Hester error (${res.status})`), status: res.status };
    }
    return { ok: true, data: (env ? env.data : parsed) as T };
  } catch {
    return { ok: false, error: 'Hester offline' };
  }
}

async function rawGet(workspace: string, path: string): Promise<Blob | null> {
  const url = `${HESTER_DAEMON_URL}${path}?workspace=${encodeURIComponent(workspace)}`;
  try {
    const res = await fetch(url, { headers: await hesterHeaders(workspace) });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** Upload an image to a Board's assets (raw body, ≤ 10 MB), with where it came from: `{name, path: 'assets/<name>'}`. */
export async function uploadBoardAsset(
  workspace: string,
  id: string,
  bytes: Blob | Uint8Array,
  mime: 'image/png' | 'image/jpeg',
  source?: AssetSource | null,
): Promise<DeepResult<{ name: string; path: string }>> {
  const q = source ? `?source=${encodeURIComponent(JSON.stringify(source))}` : '';
  const r = await rawSend<{ name?: unknown; path?: unknown }>(workspace, 'POST', boardRoute(id, `/assets${q}`), bytes, mime);
  if (!r.ok) return r;
  if (!r.data || typeof r.data.name !== 'string') return { ok: false, error: 'Hester sent no asset name' };
  return { ok: true, data: { name: r.data.name, path: typeof r.data.path === 'string' ? r.data.path : `assets/${r.data.name}` } };
}

/** The rows of assets.jsonl (name, mime, bytes, when, source). */
export function listBoardAssets(workspace: string, id: string): Promise<DeepResult<BoardAsset[]>> {
  return call<BoardAsset[]>(workspace, 'GET', boardRoute(id, '/assets'));
}

/** A Board's image, fetched with auth: its bytes as a Blob, or null. */
export function fetchBoardAsset(workspace: string, id: string, name: string): Promise<Blob | null> {
  return rawGet(workspace, boardRoute(id, `/assets/${seg(name)}`));
}

/** The Board as a picture, drawn by Lee (lib/boardRender.ts). */
export function putBoardPreview(workspace: string, id: string, png: Blob | Uint8Array): Promise<DeepResult<unknown>> {
  return rawSend<unknown>(workspace, 'PUT', boardRoute(id, '/preview'), png, 'image/png');
}

/** preview.png, or null (none yet, or Hester offline). */
export function fetchBoardPreview(workspace: string, id: string): Promise<Blob | null> {
  return rawGet(workspace, boardRoute(id, '/preview'));
}
