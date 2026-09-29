/**
 * Tether and Send to Lee: what Lee main serves devices on :9001 under
 * /tether/* (docs/plans/2026-09-28-tether-review-voice.md §3.3, §4.2).
 * Copied verbatim from that plan; Aeronaut and Dirigible mirror it by hand.
 */
import type { DeskCardKind } from './desk';

// ---------------------------------------------------------------------------
// Devices: Work (Pick up) and Review (§3.3)
// ---------------------------------------------------------------------------

export interface Tether {
  workspace: string;
  pick_up: {
    card_id: string; card_kind: DeskCardKind; title: string; area_name: string | null;
    stopped_at: string | null; stopped_line: number | null; last_touched_at: string | null;
  } | null;
  open_questions: Array<{ card_id: string; question_id: string; text: string }>; // ≤ 5
  captured_count: number;   // ideas captured away since the last Desk session
  spooled: number;          // captures waiting in Lee's spool for Hester
}
export interface TetherCard {
  id: string; kind: DeskCardKind; title: string; area_id: string | null; area_name: string | null;
  stashed: boolean; updated_at: string | null; chars: number; answers: number; open_questions: number;
}
export interface TetherDesk { workspace: string; areas: Array<{ id: string; name: string; cards: TetherCard[] }>; goals_card: TetherCard | null; last_card_id: string | null }
export interface TetherPage {
  card: TetherCard;
  text: string;                                   // ≤ 200 KB, cut at a line with "…" when longer
  answers: Array<{ id: string; question: string; answer: string | null; status: string }>;
  handoffs: Array<{ id: string; kind: string; provider: string | null; status: string; result: string | null }>;
  open_questions: Array<{ id: string; text: string }>;
  references: Array<{ title: string; where: string | null; quote: string | null }>;
}
/** GET /tether/boards/:id (B5): a Board, read-only, for Review; its picture is GET /tether/boards/:id/preview (PNG, 404 when none). */
export interface TetherBoard {
  card: TetherCard;
  has_preview: boolean;
  notes: string[];                                 // annotation text, top to bottom
  links: Array<{ card_id: string; title: string }>;
  asks: Array<{ id: string; question: string; answer: string | null; status: string }>;
  handoffs: Array<{ id: string; kind: string; status: string; result: string | null }>;
}
export interface TetherDrawer {
  stashed: Array<{ id: string; name: string; stashed_at: string | null; cards: TetherCard[] }>;
  ideas: Array<{ id: string; text: string; created_at: string; surface: string | null }>;
}

// ---------------------------------------------------------------------------
// Send to Lee (§4.2): POST /tether/send, GET /tether/targets
// ---------------------------------------------------------------------------

export type SendTarget =
  | { kind: 'page'; card_id: string; title: string }
  | { kind: 'hester' }
  | { kind: 'tab'; pty_id: number; label: string; tab_kind: 'agent' | 'terminal' | 'tui'; provider: string | null }
  | { kind: 'board'; card_id: string; title: string }; // B5: images land as image items mid-view, text as a note
export interface SendTargets {
  /** What Lee's focused window has in front of it now, when it's a target: the zoomed Page or Board, the palette, or the focused agent tab. */
  focus: SendTarget | null;
  /** Every other target: the Pages and Boards this window has touched this session, Hester, each PTY tab (agents, terminals, TUIs). */
  targets: SendTarget[];
}
export type SendItem =
  | { kind: 'text'; text: string; input?: 'voice' }                        // a voice note arrives as its reviewed transcript (§5)
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; data_b64: string; caption?: string; source: 'photo' | 'screenshot' | 'scribble' };
export interface SendRequest {
  workspace?: string;
  target: SendTarget | 'focus';
  items: SendItem[];
  /** Send (true) or Deliver (false, the default). Tabs: Enter after the text; Hester: ask the question. Refused for Pages and Boards. Only from an explicit Send tap, never from voice. */
  submit?: boolean;
  /** A compose send from a device's view of that same tab: Lee shows no chip (you're watching it). */
  compose?: boolean;
}
export interface SendResult { send_id: string; delivered_to: SendTarget }
