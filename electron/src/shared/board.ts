/**
 * Boards (docs/16-Desk.md §3.1; plan docs/plans/2026-09-28-boards.md): the
 * shared contract between Hester's store (hester/daemon/cockpit/board.py),
 * Lee's client (renderer/lib/hesterBoard.ts) and the canvas. Hester stores a
 * Board; Lee draws it. Coordinates are Board px (x right, y down), items
 * absolute on the Board; a pin's u and v are 0–1 within the item it's on.
 */

import type { DeskCard } from './desk';

export const BOARD_ITEM_KINDS = ['image', 'note', 'highlight', 'stroke', 'ask', 'handoff', 'link'] as const;
export type BoardItemKind = (typeof BOARD_ITEM_KINDS)[number];

/** The whole board.json is capped (like page.md); images live in assets/, not here. */
export const MAX_BOARD_BYTES = 1_000_000;
export const MAX_BOARD_ITEMS = 2000;
/** Per image, as for a Page's assets. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const ASSET_NAME_RE = /^(img|sel)-[0-9a-f]{8}\.(png|jpg)$/;

interface ItemBase {
  /** `it-<hex8>`, made by Lee. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order; higher draws on top. */
  z: number;
}

export interface BoardImage extends ItemBase { kind: 'image'; asset: string }
/** An annotation: a text box, optionally pinned (a leader line to the pin). Text is markdown; `[[` links allowed. */
export interface BoardNote extends ItemBase { kind: 'note'; text: string; pin?: BoardPin | null }
export interface BoardPin { item_id: string; u: number; v: number }
/** A selected region, usually on an image (`item_id`). */
export interface BoardHighlight extends ItemBase { kind: 'highlight'; item_id?: string | null }
/** Freehand, points in Board px; x/y/w/h are its bounds. */
export interface BoardStroke extends ItemBase { kind: 'stroke'; points: Array<[number, number]>; width: number }
/** What an Ask or hand-off was about: the items selected and the marquee (Board px). */
export interface BoardTarget { item_ids: string[]; rect: { x: number; y: number; w: number; h: number } }
/** A sticky note: collapsed shows the question, expanded the answer. */
export interface BoardAsk extends ItemBase { kind: 'ask'; answer_id: string; target: BoardTarget; open?: boolean }
/** A clipboard: its kind and state, expanded the result. */
export interface BoardHandoff extends ItemBase { kind: 'handoff'; answer_id: string; target: BoardTarget; open?: boolean }
/** A link to another Desk card (a Page or a Board). */
export interface BoardLink extends ItemBase { kind: 'link'; card_id: string }

export type BoardItem = BoardImage | BoardNote | BoardHighlight | BoardStroke | BoardAsk | BoardHandoff | BoardLink;

/** board.json as the routes carry it. `version` is opaque (like page.md's); PUT with a stale one is 409. */
export interface BoardDoc { version: string; items: BoardItem[] }
export interface BoardPut { version: string | null; items: BoardItem[] }

/** Where an asset came from (recorded only; refresh from source comes later). Page assets carry it too. */
export type AssetSource =
  | { kind: 'card'; card_id: string; item_id?: string; taken_at?: string }
  | { kind: 'answer'; card_id: string; answer_id: string; taken_at?: string }
  | { kind: 'file'; path: string; taken_at?: string }
  | { kind: 'url'; url: string; taken_at?: string };

/** One row of assets.jsonl. */
export interface BoardAsset { name: string; mime: 'image/png' | 'image/jpeg'; bytes: number; created_at: string; source?: AssetSource | null }

/** A Board's Ask or hand-off anchor (answers.jsonl), next to the Page's. */
export interface BoardAnchor {
  kind: 'board';
  item_ids: string[];
  rect: { x: number; y: number; w: number; h: number };
  /** `assets/sel-<hex8>.png`: the selection flattened by Lee. */
  snapshot: string;
  /** The text of the annotations in the selection. */
  notes: string[];
}

export interface BoardCreate { area_id?: string | null; title?: string; x?: number; y?: number }
export interface BoardCreated { card: DeskCard; board: BoardDoc }

/** `[[pg-…|Title]]` / `[[bd-…|Title]]`: a link to a Desk card, in a Page or an annotation. */
export const CARD_LINK_RE = /\[\[((?:pg|bd)-[0-9a-f]{8})(?:\|([^\]]*))?\]\]/g;
