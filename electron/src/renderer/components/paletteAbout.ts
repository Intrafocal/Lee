/**
 * paletteAbout - what the ⌘/ palette is "about" (cockpit-design §6.2), and
 * where it sends. Pure apart from a one-slot registry; type-only imports, so
 * scripts/deep-renderer-smoke.mjs runs it bundled with esbuild.
 *
 * When the Cockpit has a selected item (a Work card or row, a Library
 * exploration, a Goals row), the palette opens with a quiet line
 * "about: <kind> <title> ×" above the field. With an about it asks through
 * POST /cockpit/ask (the steward, as Home's old Ask Hester card did);
 * without one it streams through /context/stream as before.
 *
 * The selection lives in cockpitModeStore as {kind, id}, which has no title.
 * The Cockpit view that owns the selection resolves it to an AboutRef and
 * publishes it here (publishPaletteAbout). Without a published ref, an agent
 * tile is named from the store's tabDisplay; anything else is not guessed.
 */

import type { AboutKind, AboutRef } from '../../shared/cockpit';
import type { CockpitSelection, TabDisplayInfo } from './cockpit/cockpitMode';

export type PaletteRoute =
  | { kind: 'steward'; path: '/cockpit/ask'; about: AboutRef }
  | { kind: 'stream'; path: '/context/stream' };

/**
 * What a steward answer carries beyond its text (§6.2): its proposals and
 * any steer. The palette lists them and hands the answer to Home, where
 * StewardAnswerView can act on them; an answer with neither is just text.
 */
export function stewardExtras(answer: { proposals?: readonly { label: string }[] | null; steer?: { text: string } | null } | null | undefined): {
  proposals: string[];
  steer: string | null;
} | null {
  if (!answer) return null;
  const proposals = (answer.proposals ?? []).map((p) => p.label);
  const steer = answer.steer?.text?.trim() || null;
  return proposals.length || steer ? { proposals, steer } : null;
}

/** An about asks the steward; no about streams the general question. */
export function paletteRoute(about: AboutRef | null | undefined): PaletteRoute {
  return about ? { kind: 'steward', path: '/cockpit/ask', about } : { kind: 'stream', path: '/context/stream' };
}

const KIND_WORDS: Record<AboutKind, string> = {
  task: 'task',
  exploration: 'exploration',
  goal: 'goal',
  lint: 'lint',
  feed: 'item',
  tile: 'agent',
  operation: 'run',
  page: 'page',
};

/** The about line's words: "about: agent Fix the login flow". */
export function aboutLine(about: Pick<AboutRef, 'kind' | 'label'>): { kind: string; title: string } {
  return { kind: KIND_WORDS[about.kind] ?? about.kind, title: about.label.trim() || 'untitled' };
}

export function selectionKey(sel: CockpitSelection): string {
  return `${sel.kind}:${sel.id}`;
}

export interface PublishedAbout {
  key: string;
  ref: AboutRef | null;
}

/**
 * The palette's about for this Cockpit state: null outside the Cockpit or
 * with nothing selected; the published ref when it is for this selection;
 * else an agent tile named from tabDisplay; else null.
 */
export function paletteAboutFor(
  state: { mode: string; selected: CockpitSelection | null; tabDisplay?: ReadonlyMap<number, TabDisplayInfo> },
  published: PublishedAbout | null,
): AboutRef | null {
  const sel = state.selected;
  if (state.mode !== 'cockpit' || !sel) return null;
  if (published && published.key === selectionKey(sel)) return published.ref;
  if (sel.kind === 'tile') {
    const ptyId = Number(sel.id);
    if (!Number.isFinite(ptyId)) return null;
    const shown = state.tabDisplay?.get(ptyId);
    const title = shown?.name || (shown?.provider ? `${shown.provider} agent` : `Agent ${ptyId}`);
    return { kind: 'tile', id: sel.id, label: title, record: { pty_id: ptyId, title, provider: shown?.provider ?? null } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry: the Cockpit view that owns the selection publishes its ref.
// ---------------------------------------------------------------------------

let published: PublishedAbout | null = null;

/** Called by the Cockpit when its selection (or the selected item's title) changes. */
export function publishPaletteAbout(sel: CockpitSelection | null, ref: AboutRef | null): void {
  published = sel ? { key: selectionKey(sel), ref } : null;
}

export function publishedPaletteAbout(): PublishedAbout | null {
  return published;
}
