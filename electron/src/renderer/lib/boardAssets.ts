/**
 * boardAssets - a Board's images in the renderer, like lib/pageAssets.ts:
 * Hester serves them behind the bearer token, so each is fetched with auth
 * once and kept for the window's life, as a blob: URL for an <img> and a
 * decoded bitmap for boardRender. An image you just added is primed from
 * your own bytes (no round trip).
 *
 * Also the Board card's picture: preview.png by the card's updated_at, or
 * the one this window drew a moment ago (a Board you just left shows its
 * latest at once); and getting a pasted or dropped file ready to upload
 * (PNG or JPEG under the cap, and its size).
 */

import { MAX_ASSET_BYTES, type AssetSource } from '../../shared/board';
import { fetchBoardAsset, fetchBoardPreview, uploadBoardAsset } from './hesterBoard';

const key = (workspace: string, id: string, name: string) => `${workspace}\u0000${id}\u0000${name}`;

const blobs = new Map<string, Promise<Blob | null>>();
const urls = new Map<string, Promise<string | null>>();
const bitmaps = new Map<string, Promise<ImageBitmap | null>>();

export function boardAssetBlob(workspace: string, id: string, name: string): Promise<Blob | null> {
  const k = key(workspace, id, name);
  const hit = blobs.get(k);
  if (hit) return hit;
  const p = fetchBoardAsset(workspace, id, name).then((b) => {
    if (!b) blobs.delete(k);
    return b;
  });
  blobs.set(k, p);
  return p;
}

export function boardAssetUrl(workspace: string, id: string, name: string): Promise<string | null> {
  const k = key(workspace, id, name);
  const hit = urls.get(k);
  if (hit) return hit;
  const p = boardAssetBlob(workspace, id, name).then((b) => {
    if (!b) {
      urls.delete(k);
      return null;
    }
    return URL.createObjectURL(b);
  });
  urls.set(k, p);
  return p;
}

export function boardAssetBitmap(workspace: string, id: string, name: string): Promise<ImageBitmap | null> {
  const k = key(workspace, id, name);
  const hit = bitmaps.get(k);
  if (hit) return hit;
  const p = boardAssetBlob(workspace, id, name).then(async (b) => {
    try {
      if (b) return await createImageBitmap(b);
    } catch {
      /* not an image we can decode */
    }
    bitmaps.delete(k);
    return null;
  });
  bitmaps.set(k, p);
  return p;
}

/** An image just uploaded: its bytes are already here. */
export function primeBoardAsset(workspace: string, id: string, name: string, blob: Blob): void {
  blobs.set(key(workspace, id, name), Promise.resolve(blob));
}

// ---- the card's picture ----

const previews = new Map<string, Promise<string | null>>();
const local = new Map<string, { url: string; at: number }>();
const listeners = new Set<() => void>();

/** preview.png for the card as of `stamp` (its updated_at): a blob: URL, or null. */
export function boardPreviewUrl(workspace: string, id: string, stamp: string): Promise<string | null> {
  const k = key(workspace, id, stamp);
  const hit = previews.get(k);
  if (hit) return hit;
  const p = fetchBoardPreview(workspace, id).then((b) => {
    if (!b) {
      previews.delete(k);
      return null;
    }
    return URL.createObjectURL(b);
  });
  previews.set(k, p);
  return p;
}

/** The preview this window just drew for a Board (shown until the Desk has a newer one). */
export function setLocalPreview(workspace: string, id: string, png: Blob): void {
  const k = key(workspace, id, '');
  const old = local.get(k);
  local.set(k, { url: URL.createObjectURL(png), at: Date.now() });
  if (old) URL.revokeObjectURL(old.url);
  listeners.forEach((f) => f());
}

/** The preview this window drew last, and when (ms). */
export function localPreview(workspace: string, id: string): { url: string; at: number } | null {
  return local.get(key(workspace, id, '')) ?? null;
}

export function onPreviewChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- files you paste or drop ----

export interface ReadyImage {
  blob: Blob;
  mime: 'image/png' | 'image/jpeg';
  /** Its own pixels. */
  w: number;
  h: number;
}

/** The images in a paste or a drop, in order. */
export function imagesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  const items = Array.from(data.items ?? []);
  if (items.length) {
    for (const it of items) {
      if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
    return out;
  }
  return Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'));
}

/** Where a dropped or chosen file is on disk (Electron's File.path), for its `source`. */
export function filePath(file: File): string | null {
  const p = (file as File & { path?: unknown }).path;
  return typeof p === 'string' && p ? p : null;
}

/**
 * An image ready to upload: PNG or JPEG as it is; anything else (TIFF,
 * HEIC, WebP, GIF) redrawn as PNG; over the cap, redrawn as JPEG. An
 * error line when it can't be read or is still too big.
 */
export async function readyImage(file: Blob): Promise<ReadyImage | { error: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: 'That image couldn’t be read' };
  }
  const w = bitmap.width;
  const h = bitmap.height;
  const direct = file.type === 'image/png' || file.type === 'image/jpeg';
  if (direct && file.size <= MAX_ASSET_BYTES) {
    bitmap.close?.();
    return { blob: file, mime: file.type as ReadyImage['mime'], w, h };
  }
  const redraw = async (type: ReadyImage['mime']): Promise<Blob | null> => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, 0.9));
  };
  let blob = direct ? null : await redraw('image/png');
  let mime: ReadyImage['mime'] = 'image/png';
  if (!blob || blob.size > MAX_ASSET_BYTES) {
    blob = await redraw('image/jpeg');
    mime = 'image/jpeg';
  }
  bitmap.close?.();
  if (!blob) return { error: 'That image couldn’t be read' };
  if (blob.size > MAX_ASSET_BYTES) return { error: 'That image is over 10 MB' };
  return { blob, mime, w, h };
}

/**
 * A file onto a Board's assets: made ready, uploaded with its source (a
 * dropped or chosen file's path, stamped now) and primed here. Its asset
 * name and pixel size, or one line saying why not.
 */
export async function addImageAsset(
  workspace: string,
  boardId: string,
  file: Blob,
  source: AssetSource | null = null,
): Promise<{ name: string; w: number; h: number } | { error: string }> {
  const img = await readyImage(file);
  if ('error' in img) return img;
  const path = file instanceof File ? filePath(file) : null;
  const src = source ?? (path ? { kind: 'file' as const, path, taken_at: new Date().toISOString() } : null);
  const r = await uploadBoardAsset(workspace, boardId, img.blob, img.mime, src);
  if (!r.ok) return { error: r.status === 404 || r.status === 405 ? 'Hester is older than this Lee. Reinstall it to add images.' : r.error };
  primeBoardAsset(workspace, boardId, r.data.name, img.blob);
  return { name: r.data.name, w: img.w, h: img.h };
}
