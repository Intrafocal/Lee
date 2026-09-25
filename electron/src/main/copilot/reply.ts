/**
 * What a Reply writes into an agent's PTY.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §5.5.
 * Keys read from the Claude Code 2.1.282 bundle (not yet confirmed live): the
 * permission prompt is a select whose default focus is the first option
 * ("Yes"), so Enter accepts it; its onCancel (Esc) declines.
 */

import type { AttentionKind, ReplyRequest } from '../../shared/copilot';

/** Enter: accept the highlighted default option ("Yes") of the permission prompt. */
export const APPROVE_KEYS = '\r';
/** Esc: decline the permission prompt and return control to the input. */
export const DENY_KEYS = '\x1b';
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const SUBMIT_KEYS = '\r';
export const SUBMIT_DELAY_MS = 30;
export const REPLY_TEXT_MAX = 4000;

export type PtyWrite = (data: string) => void;

/** Strip control characters other than \n and \t; normalise CRLF. */
export function sanitizeReplyText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  if (clean.trim().length === 0 || clean.length > REPLY_TEXT_MAX) return null;
  return clean;
}

export type ReplyCheck =
  | { ok: true; action: ReplyRequest['action']; text: string | null }
  | { ok: false; error: string };

/** Which actions a kind accepts, and the text rule. */
export function checkReply(kind: AttentionKind, req: Partial<ReplyRequest> | null | undefined): ReplyCheck {
  const action = req?.action;
  if (action === 'approve' || action === 'deny') {
    if (kind !== 'approval') return { ok: false, error: `${action} is only valid for approvals` };
    return { ok: true, action, text: null };
  }
  if (action === 'text') {
    if (!['waiting', 'blocker', 'decision', 'review'].includes(kind)) {
      return { ok: false, error: `text replies are not valid for ${kind} items` };
    }
    const text = sanitizeReplyText(req?.text);
    if (text === null) return { ok: false, error: `text must be 1-${REPLY_TEXT_MAX} characters` };
    return { ok: true, action, text };
  }
  return { ok: false, error: 'action must be approve, deny or text' };
}

/** Send text as a bracketed paste, then Enter after a short delay. */
export function writeText(write: PtyWrite, text: string): void {
  write(PASTE_START + text + PASTE_END);
  setTimeout(() => {
    try {
      write(SUBMIT_KEYS);
    } catch {
      // PTY gone between paste and submit
    }
  }, SUBMIT_DELAY_MS);
}

export function writeReply(write: PtyWrite, action: ReplyRequest['action'], text: string | null): void {
  if (action === 'approve') write(APPROVE_KEYS);
  else if (action === 'deny') write(DENY_KEYS);
  else if (text !== null) writeText(write, text);
}
