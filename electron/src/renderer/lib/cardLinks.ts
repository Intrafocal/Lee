/**
 * Card links (Boards B4, docs/16-Desk.md §3.1): `[[pg-…|Title]]` and
 * `[[bd-…|Title]]` (CARD_LINK_RE in shared/board.ts), a link from a Page or
 * a Board's annotation to another Desk card. Links, not embeds: a link shows
 * as its label and opens the card.
 *
 * Pure: parse and format, the cards a link can point at (from GET /desk),
 * ranking them for the `[[` picker, and resolving a link against them. A
 * `[[path]]` file link is not a card link and is left to deepModel's
 * parseWikiLinks as before.
 */

import { CARD_LINK_RE } from '../../shared/board';
import type { Desk, DeskCardKind } from '../../shared/desk';

/** A card id a link can name: a Page or a Board. */
export const CARD_LINK_ID_RE = /^(?:pg|bd)-[0-9a-f]{8}$/;

export function isCardLinkId(id: string | null | undefined): boolean {
  return !!id && CARD_LINK_ID_RE.test(id.trim());
}

export interface CardLink {
  /** Offsets within the text. */
  from: number;
  to: number;
  card_id: string;
  /** The label as written, else null. */
  label: string | null;
}

/** Every card link in `text`, in order. */
export function parseCardLinks(text: string): CardLink[] {
  const out: CardLink[] = [];
  const re = new RegExp(CARD_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ from: m.index, to: m.index + m[0].length, card_id: m[1], label: m[2]?.trim() || null });
  }
  return out;
}

/** The card ids a text links to, first mention first, each once. */
export function cardLinkIds(text: string): string[] {
  return Array.from(new Set(parseCardLinks(text).map((l) => l.card_id)));
}

/** A title made safe for a link's label: one line, no `]` or `|`. */
export function linkLabel(title: string): string {
  return title
    .replace(/[\]|[]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `[[pg-…|Title]]`; the bare `[[pg-…]]` when the title is empty. */
export function formatCardLink(cardId: string, title: string): string {
  const label = linkLabel(title);
  return label ? `[[${cardId}|${label}]]` : `[[${cardId}]]`;
}

// ---------------------------------------------------------------------------
// The cards a link can point at
// ---------------------------------------------------------------------------

export interface LinkableCard {
  id: string;
  kind: DeskCardKind;
  title: string;
  area_id: string | null;
  /** The Area's name; null for the Goals card (it's in every Area). */
  area_name: string | null;
  /** In a stashed Area (in a Drawer), not on the Desk. */
  stashed: boolean;
  last_touched_at: string | null;
}

/** The Desk's Pages and Boards as link targets, on the Desk first, then by last touched. `except`: the card you're in. */
export function linkableCards(desk: Pick<Desk, 'cards' | 'areas'> | null | undefined, except?: string | null): LinkableCard[] {
  if (!desk) return [];
  const areas = new Map(desk.areas.map((a) => [a.id, a]));
  return desk.cards
    .filter((c) => c.id !== except && isCardLinkId(c.id))
    .map((c) => {
      const area = c.area_id ? areas.get(c.area_id) : undefined;
      return {
        id: c.id,
        kind: c.kind,
        title: c.title,
        area_id: c.area_id,
        area_name: area?.name ?? null,
        stashed: !!area?.drawer_id,
        last_touched_at: c.last_touched_at ?? c.updated_at ?? null,
      };
    })
    .sort((a, b) => Number(a.stashed) - Number(b.stashed) || (b.last_touched_at ?? '').localeCompare(a.last_touched_at ?? ''));
}

export function cardKindLabel(kind: DeskCardKind): string {
  return kind === 'board' ? 'Board' : 'Page';
}

/** The picker's small line: "Board · Desk Items", "Page · stashed". */
export function cardLinkSub(card: LinkableCard): string {
  const where = card.stashed ? `${card.area_name ?? 'Area'} (stashed)` : card.area_name;
  return where ? `${cardKindLabel(card.kind)} · ${where}` : cardKindLabel(card.kind);
}

/** Lower is better; null when `q` doesn't match the title (or the id). */
function titleScore(q: string, card: LinkableCard): number | null {
  if (!q) return 0;
  const t = card.title.toLowerCase();
  if (t.startsWith(q)) return 0;
  const words = t.split(/[^a-z0-9]+/);
  if (words.some((w) => w.startsWith(q))) return 1;
  const i = t.indexOf(q);
  if (i >= 0) return 10 + i;
  if (card.id.startsWith(q)) return 50;
  return null;
}

/** The `[[` picker's cards: matching titles (starts first), keeping the Desk's order within a score. */
export function rankCards(query: string, cards: readonly LinkableCard[], limit = 8): LinkableCard[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ c: LinkableCard; s: number; i: number }> = [];
  cards.forEach((c, i) => {
    const s = titleScore(q, c);
    if (s != null) scored.push({ c, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.c);
}

// ---------------------------------------------------------------------------
// Resolving a link
// ---------------------------------------------------------------------------

export function findCard(cardId: string, cards: readonly LinkableCard[]): LinkableCard | null {
  return cards.find((c) => c.id === cardId) ?? null;
}

/** What a link shows: its label as written, else the card's title, else a word for what it was. */
export function cardLinkDisplay(link: Pick<CardLink, 'card_id' | 'label'>, card: LinkableCard | null): string {
  if (link.label) return link.label;
  if (card?.title) return card.title;
  return link.card_id.startsWith('bd-') ? 'Board' : 'Page';
}

/** A link's hover line: where the card is, or that it's gone. */
export function cardLinkTitle(link: Pick<CardLink, 'card_id'>, card: LinkableCard | null): string {
  if (!card) return `Not on the Desk (${link.card_id})`;
  return `${card.title || 'Untitled'} · ${cardLinkSub(card)}`;
}

/** What clicking a missing card's link says. */
export const MISSING_CARD_MESSAGE = 'That card isn’t on the Desk any more';
