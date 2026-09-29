/**
 * pasteImage - a screenshot pasted into a reply field goes to the agent as a
 * file path: main saves it to ~/.lee/inbox/ (0600, pruned after 7 days; the
 * same place Send to Lee puts images for a tab) and the path is inserted at
 * the caret. Claude Code reads an image path in a prompt. Nothing is sent
 * until you send the reply.
 */

import type React from 'react';
import { saveInboxImage } from './tetherIpc';

const DIRECT = new Set(['image/png', 'image/jpeg']);

/** The first image on the clipboard, or null. */
export function clipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** PNG or JPEG as they are; anything else (TIFF, HEIC, WebP) redrawn as PNG. */
async function asPngOrJpeg(file: File): Promise<{ mime: string; data_b64: string } | null> {
  if (DIRECT.has(file.type)) return { mime: file.type, data_b64: toBase64(await file.arrayBuffer()) };
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const url = canvas.toDataURL('image/png');
    return { mime: 'image/png', data_b64: url.slice(url.indexOf(',') + 1) };
  } catch {
    return null;
  }
}

/** Save a pasted image; its absolute path, or null when it can't be saved. */
export async function saveFromPaste(file: File): Promise<string | null> {
  const img = await asPngOrJpeg(file);
  if (!img) return null;
  return saveInboxImage({ send_id: `paste_${Date.now().toString(36)}`, n: 0, ...img });
}

/** `text` with `insert` at the selection, spaced from its neighbours; and where the caret goes. */
export function insertAt(text: string, from: number, to: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const next = `${before}${lead}${insert}${trail}${after}`;
  return { text: next, caret: (before + lead + insert).length };
}

/**
 * The onPaste for a reply field: an image becomes its saved path at the
 * caret; text pastes as usual. `onError` gets one line when it can't be saved.
 */
export function pasteImageHandler(
  getText: () => string,
  setText: (t: string) => void,
  onError?: (msg: string) => void,
): (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void {
  return (e) => {
    const file = clipboardImage(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    const el = e.currentTarget;
    const from = el.selectionStart ?? getText().length;
    const to = el.selectionEnd ?? from;
    void saveFromPaste(file).then((path) => {
      if (!path) {
        onError?.("Couldn't attach the image");
        return;
      }
      const { text, caret } = insertAt(getText(), from, to, path);
      setText(text);
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    });
  };
}
