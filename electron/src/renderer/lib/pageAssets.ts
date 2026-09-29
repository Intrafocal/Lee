/**
 * pageAssets - a Page's images as blob: URLs (Tether §4.4). Hester serves
 * them behind the bearer token, which an <img src> can't carry, so each one
 * is fetched with auth once and kept as an object URL for the window's life
 * (a Page's images are few and small; a failed fetch is retried next time).
 */

import { fetchPageAsset } from './hesterDesk';

const urls = new Map<string, Promise<string | null>>();

export function pageAssetUrl(workspace: string, cardId: string, name: string): Promise<string | null> {
  const key = `${workspace}\u0000${cardId}\u0000${name}`;
  const hit = urls.get(key);
  if (hit) return hit;
  const p = fetchPageAsset(workspace, cardId, name).then((blob) => {
    if (!blob) {
      urls.delete(key);
      return null;
    }
    return URL.createObjectURL(blob);
  });
  urls.set(key, p);
  return p;
}
