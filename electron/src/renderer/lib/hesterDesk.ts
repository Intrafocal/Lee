/**
 * Typed client for Hester's Desk routes (D2 contract §4): the Desk, its
 * Areas, Drawers and cards, strokes, Page cards, sessions, `/desk/last` and
 * Ideas to a Page. Same `call` as lib/hesterDeep.ts (workspace as `?workspace=` and
 * `X-Lee-Workspace`, the bearer token, the copilot envelope, the error body
 * kept for 409s).
 *
 * A Page card's own routes (page, references, answers, asks, hand-offs,
 * questions, draft from README) are hesterDeep's functions: they take a card
 * id and go to `/desk/pages/{id}/…` (pageRoute), so the Page editor's code
 * is unchanged. They are re-exported here under Desk names.
 *
 * An old Hester has none of these: GET /desk answers 404 and the Desk shows
 * one line asking for a reinstall (§10); nothing falls back to explorations.
 */

import { hesterCall as call, type DeepResult } from './hesterDeep';
import type {
  Desk,
  DeskArea,
  DeskAreaCreate,
  DeskAreaPatch,
  DeskCard,
  DeskCardPatch,
  DeskDrawer,
  DeskLast,
  DeskMigrationReport,
  DeskPageCreate,
  DeskPageCreated,
  DeskSessionCreate,
  DeskSessionRecord,
  DeskStroke,
  DeskStrokeCreate,
  IdeaToPage,
  IdeaToPageResult,
} from '../../shared/desk';

export type { DeepResult as DeskResult };

const seg = (s: string) => encodeURIComponent(s);

// ---- the Desk ----

export function getDesk(workspace: string): Promise<DeepResult<Desk>> {
  return call<Desk>(workspace, 'GET', '/desk');
}

export function migrateDesk(workspace: string): Promise<DeepResult<DeskMigrationReport>> {
  return call<DeskMigrationReport>(workspace, 'POST', '/desk/migrate', {});
}

export function getDeskLast(workspace: string): Promise<DeepResult<DeskLast>> {
  return call<DeskLast>(workspace, 'GET', '/desk/last');
}

export function putDeskLast(workspace: string, cardId: string): Promise<DeepResult<{ card_id: string; at: string }>> {
  return call<{ card_id: string; at: string }>(workspace, 'PUT', '/desk/last', { card_id: cardId });
}

// ---- Areas ----

export function createArea(workspace: string, body: DeskAreaCreate): Promise<DeepResult<DeskArea>> {
  return call<DeskArea>(workspace, 'POST', '/desk/areas', body);
}

export function patchArea(workspace: string, id: string, body: DeskAreaPatch): Promise<DeepResult<DeskArea>> {
  return call<DeskArea>(workspace, 'PATCH', `/desk/areas/${seg(id)}`, body);
}

/** An empty Area, else 409 `not_empty`; `withCards` (the user confirmed) deletes its cards too. Not undoable. */
export function deleteArea(workspace: string, id: string, withCards = false): Promise<DeepResult<{ deleted: true; cards: number }>> {
  return call<{ deleted: true; cards: number }>(workspace, 'DELETE', `/desk/areas/${seg(id)}`, withCards ? { with_cards: true } : undefined);
}

export function putAwayArea(workspace: string, id: string, drawerId?: string): Promise<DeepResult<DeskArea>> {
  return call<DeskArea>(workspace, 'POST', `/desk/areas/${seg(id)}/put-away`, drawerId ? { drawer_id: drawerId } : {});
}

export function takeOutArea(workspace: string, id: string, at?: { x: number; y: number }): Promise<DeepResult<DeskArea>> {
  return call<DeskArea>(workspace, 'POST', `/desk/areas/${seg(id)}/take-out`, at ?? {});
}

// ---- Drawers ----

export function createDrawer(workspace: string, name: string): Promise<DeepResult<DeskDrawer>> {
  return call<DeskDrawer>(workspace, 'POST', '/desk/drawers', { name });
}

export function patchDrawer(workspace: string, id: string, name: string): Promise<DeepResult<DeskDrawer>> {
  return call<DeskDrawer>(workspace, 'PATCH', `/desk/drawers/${seg(id)}`, { name });
}

// ---- cards and Page cards ----

export function patchCard(workspace: string, id: string, body: DeskCardPatch): Promise<DeepResult<DeskCard>> {
  return call<DeskCard>(workspace, 'PATCH', `/desk/cards/${seg(id)}`, body);
}

// ---- strokes (lines that mean nothing) ----

export function createStroke(workspace: string, body: DeskStrokeCreate): Promise<DeepResult<DeskStroke>> {
  return call<DeskStroke>(workspace, 'POST', '/desk/strokes', body);
}

export function deleteStroke(workspace: string, id: string): Promise<DeepResult<{ deleted: true }>> {
  return call<{ deleted: true }>(workspace, 'DELETE', `/desk/strokes/${seg(id)}`);
}

/** 201 created; 200 with created: false for an existing Goals card. */
export function createDeskPage(workspace: string, body: DeskPageCreate): Promise<DeepResult<DeskPageCreated>> {
  return call<DeskPageCreated>(workspace, 'POST', '/desk/pages', body);
}

export function getDeskPage(workspace: string, id: string): Promise<DeepResult<DeskCard>> {
  return call<DeskCard>(workspace, 'GET', `/desk/pages/${seg(id)}`);
}

export function patchDeskPage(workspace: string, id: string, body: { title: string }): Promise<DeepResult<DeskCard>> {
  return call<DeskCard>(workspace, 'PATCH', `/desk/pages/${seg(id)}`, body);
}

/** Only an empty Untitled Page (Deep next R8's guard), else 409 `not_empty`; `force` (the user confirmed) deletes it anyway. Not undoable. */
export function deleteDeskPage(workspace: string, id: string, force = false): Promise<DeepResult<{ deleted: true }>> {
  return call<{ deleted: true }>(workspace, 'DELETE', `/desk/pages/${seg(id)}`, force ? { force: true } : undefined);
}

// ---- sessions ----

export function listDeskSessions(workspace: string, limit?: number): Promise<DeepResult<DeskSessionRecord[]>> {
  return call<DeskSessionRecord[]>(workspace, 'GET', `/desk/sessions${limit ? `?limit=${limit}` : ''}`);
}

export function postDeskSession(workspace: string, record: DeskSessionCreate): Promise<DeepResult<DeskSessionRecord>> {
  return call<DeskSessionRecord>(workspace, 'POST', '/desk/sessions', record);
}

// ---- the Ideas Drawer ----

/** A Page from an idea: in `area_id` at x/y, or without one in a new Area named after it. 409 `not_open`. */
export function ideaToPage(workspace: string, somedayId: string, body: IdeaToPage = {}): Promise<DeepResult<IdeaToPageResult>> {
  return call<IdeaToPageResult>(workspace, 'POST', `/desk/ideas/${seg(somedayId)}/page`, body);
}

// ---- a Page card's own routes (hesterDeep's, by card id) ----

export {
  getPage as getCardPage,
  putPage as putCardPage,
  listReferences as listCardReferences,
  addReference as addCardReference,
  patchReference as patchCardReference,
  listAnswers as listCardAnswers,
  patchAnswer as patchCardAnswer,
  retryAnswer as retryCardAnswer,
  askDeep as askCard,
  createHandoff as createCardHandoff,
  listQuestions as listCardQuestions,
  addQuestion as addCardQuestion,
  patchQuestion as patchCardQuestion,
  draftFromReadme as draftCardFromReadme,
} from './hesterDeep';
