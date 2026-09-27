/**
 * deepBridge - the Deep surface's runtime glue (Deep D1 §4, §8.2, §9, §14):
 *
 * - The main-process calls (`copilot.deepStart`/`deepEnd`, `deep.onAnswer`,
 *   `app.quit`), wrapped so a failure (or no Electron) degrades to a no-op.
 * - openInDeep: deepStart, then cockpitModeStore.openDeep (the §14 seam).
 * - Deep event logging (counts and ids only, never text; §10.1).
 * - The per-workspace Deep memory in localStorage (§4.4) and the Page's crash
 *   mirror (§4.3); every access is wrapped, storage may be unavailable.
 * - A tiny bus for ⌘. so the app-level hotkey (R1's `deep_actions`) can reach
 *   the Page when the key doesn't land in CodeMirror.
 */

import type { DeepAnswerEvent, DeepRendererEvent, DeepView } from '../../../shared/cockpit';
import type { DeepEndRequest, DeepStartRequest, FocusState } from '../../../shared/copilot';
import { cockpitModeStore } from '../cockpit/cockpitMode';
import { deepMemoryKey, pageMirrorKey } from '../../lib/deepModel';

/** Start (or retarget) the machine-wide Deep session. Null outside Electron or when the call fails. */
export async function deepStart(req: DeepStartRequest): Promise<FocusState | null> {
  const api = typeof window !== 'undefined' ? window.lee?.copilot : undefined;
  if (!api) return null;
  try {
    return await api.deepStart(req);
  } catch {
    return null;
  }
}

export async function deepEnd(req: DeepEndRequest): Promise<FocusState | null> {
  const api = typeof window !== 'undefined' ? window.lee?.copilot : undefined;
  if (!api) return null;
  try {
    return await api.deepEnd(req);
  } catch {
    return null;
  }
}

/** `deep:answer` from main (§6): an answer finished somewhere. Returns an unsubscribe. */
export function onDeepAnswer(cb: (e: DeepAnswerEvent) => void): () => void {
  const deep = typeof window !== 'undefined' ? window.lee?.deep : undefined;
  if (!deep) return () => undefined;
  try {
    return deep.onAnswer(cb);
  } catch {
    return () => undefined;
  }
}

/** Close Lee (the ritual's default button). False outside Electron. */
export function quitLee(): boolean {
  const app = typeof window !== 'undefined' ? window.lee?.app : undefined;
  if (!app) return false;
  app.quit();
  return true;
}

/** Open a URL in the system browser (reading list, §8.2). */
export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const shell = (window.lee as unknown as { shell?: { openExternal?: (u: string) => unknown } })?.shell;
  if (shell?.openExternal) {
    void shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

export function logDeep(event: DeepRendererEvent): void {
  try {
    window.lee?.cockpit?.logEvent(event);
  } catch {
    /* cockpit IPC not available */
  }
}

/**
 * Open an exploration in Deep in this window: start (or retarget) the Deep
 * session, then show it. The session call failing doesn't block writing.
 */
export async function openInDeep(workspace: string, id: string, title: string): Promise<void> {
  await deepStart({ workspace, exploration_id: id, title, surface: 'lee' });
  rememberDeep(workspace, { exploration_id: id, title, view: 'page' });
  cockpitModeStore.openDeep(id, title);
}

// ---------------------------------------------------------------------------
// Memory (§4.4)
// ---------------------------------------------------------------------------

export interface DeepCursor {
  anchor: number;
  head: number;
  scroll: number;
}

export interface DeepMemory {
  exploration_id: string | null;
  title: string;
  view: DeepView;
  /** The last cursor and scroll per exploration, for Pick up and restarts. */
  cursors: Record<string, DeepCursor>;
}

const CURSORS_MAX = 50;

export function readDeepMemory(workspace: string): DeepMemory {
  const empty: DeepMemory = { exploration_id: null, title: '', view: 'page', cursors: {} };
  try {
    const raw = window.localStorage.getItem(deepMemoryKey(workspace));
    if (!raw) return empty;
    const v = JSON.parse(raw) as Partial<DeepMemory>;
    return {
      exploration_id: typeof v.exploration_id === 'string' ? v.exploration_id : null,
      title: typeof v.title === 'string' ? v.title : '',
      view: 'page',
      cursors: v.cursors && typeof v.cursors === 'object' ? v.cursors : {},
    };
  } catch {
    return empty;
  }
}

function writeDeepMemory(workspace: string, m: DeepMemory): void {
  try {
    const ids = Object.keys(m.cursors);
    if (ids.length > CURSORS_MAX) for (const id of ids.slice(0, ids.length - CURSORS_MAX)) delete m.cursors[id];
    // The record also holds the Desk's nav (cockpitMode's card_id, zoom, area_id): keep what else is there.
    const raw = window.localStorage.getItem(deepMemoryKey(workspace));
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(deepMemoryKey(workspace), JSON.stringify({ ...prev, ...m }));
  } catch {
    /* storage unavailable */
  }
}

export function rememberDeep(workspace: string, nav: { exploration_id: string | null; title: string; view: DeepView }): void {
  const m = readDeepMemory(workspace);
  writeDeepMemory(workspace, { ...m, ...nav });
}

export function rememberCursor(workspace: string, id: string, cursor: DeepCursor): void {
  const m = readDeepMemory(workspace);
  delete m.cursors[id];
  m.cursors[id] = cursor;
  writeDeepMemory(workspace, m);
}

export function savedCursor(workspace: string, id: string): DeepCursor | null {
  return readDeepMemory(workspace).cursors[id] ?? null;
}

// ---------------------------------------------------------------------------
// Page crash mirror (§4.3)
// ---------------------------------------------------------------------------

export interface PageMirror {
  text: string;
  /** The server version this text was based on. */
  base: string | null;
  /** Changes not yet saved to Hester. */
  dirty: boolean;
}

export function readMirror(workspace: string, id: string): PageMirror | null {
  try {
    const raw = window.localStorage.getItem(pageMirrorKey(workspace, id));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PageMirror>;
    if (typeof v.text !== 'string') return null;
    return { text: v.text, base: typeof v.base === 'string' ? v.base : null, dirty: !!v.dirty };
  } catch {
    return null;
  }
}

export function writeMirror(workspace: string, id: string, m: PageMirror): void {
  try {
    window.localStorage.setItem(pageMirrorKey(workspace, id), JSON.stringify(m));
  } catch {
    /* storage unavailable or full: the Page still saves to Hester */
  }
}

// ---------------------------------------------------------------------------
// ⌘. bus
// ---------------------------------------------------------------------------

const actionListeners = new Set<() => void>();

/** For the app-level `deep_actions` hotkey: move focus into the action row, or take the visible affordance. */
export function requestDeepActions(): void {
  for (const fn of actionListeners) fn();
}

export function onDeepActions(fn: () => void): () => void {
  actionListeners.add(fn);
  return () => {
    actionListeners.delete(fn);
  };
}
