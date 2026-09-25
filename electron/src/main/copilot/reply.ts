/**
 * What a Reply writes into an agent's PTY.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §5.5.
 * Keys read from the Claude Code 2.1.282 bundle (not yet confirmed live): the
 * permission prompt is a select whose default focus is the first option
 * ("Yes"), so Enter accepts it; its onCancel (Esc) declines.
 *
 * AskUserQuestion (read from the Claude Code 2.1.283 bundle, not yet
 * confirmed live): see chooseKeys().
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

/**
 * Keys that pick option `index` (0-based) of Claude Code's AskUserQuestion
 * picker, for a single question, single-select, without option previews.
 *
 * Evidence (Claude Code 2.1.283 bundle, `strings` of the binary):
 * - The single-select question renders the shared Select with the options
 *   first, then "Other" (free text), then "Chat about this".
 * - Select's key handler: `/^[0-9]$/.test(key)` -> `options[parseInt(key)-1]`
 *   -> `onChange(value)` for a plain option, i.e. a digit picks directly.
 * - The dialog's onAnswer: when `questions.length === 1` and the answer is not
 *   multi-select it submits at once (no Review/Submit tab).
 * So one digit (index + 1) answers it; no Enter (an Enter afterwards would land
 * in Claude's input). With option previews the side-by-side layout only
 * moves the cursor on a digit, so those questions are not choosable.
 */
export function chooseKeys(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 8) throw new RangeError('choice out of range');
  return String(index + 1);
}

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
  | { ok: true; action: ReplyRequest['action']; text: string | null; choice: number | null }
  | { ok: false; error: string };

/** What checkReply needs to know about a question item. */
export interface QuestionReplyInfo {
  /** The item's actions include 'choose' (see AttentionItem.actions). */
  choosable: boolean;
  /** Options of its (only) question. */
  optionCount: number;
}

/**
 * Which actions a kind accepts, and the text and choice rules. Questions take
 * only 'choose' (Claude's "Other" free-text entry can't be reached reliably
 * with keys, so 'text' is not offered for them).
 */
export function checkReply(
  kind: AttentionKind,
  req: Partial<ReplyRequest> | null | undefined,
  question?: QuestionReplyInfo,
): ReplyCheck {
  const action = req?.action;
  if (action === 'approve' || action === 'deny') {
    if (kind !== 'approval') return { ok: false, error: `${action} is only valid for approvals` };
    return { ok: true, action, text: null, choice: null };
  }
  if (action === 'choose') {
    if (kind !== 'question') return { ok: false, error: 'choose is only valid for questions' };
    if (!question?.choosable) return { ok: false, error: 'this question needs the tab (several questions, multi-select or previews)' };
    const choice = req?.choice;
    if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= question.optionCount) {
      return { ok: false, error: `choice must be an option index 0-${question.optionCount - 1}` };
    }
    return { ok: true, action, text: null, choice };
  }
  if (action === 'text') {
    if (!['waiting', 'blocker', 'decision', 'review'].includes(kind)) {
      return { ok: false, error: `text replies are not valid for ${kind} items` };
    }
    const text = sanitizeReplyText(req?.text);
    if (text === null) return { ok: false, error: `text must be 1-${REPLY_TEXT_MAX} characters` };
    return { ok: true, action, text, choice: null };
  }
  return { ok: false, error: 'action must be approve, deny, choose or text' };
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

export function writeReply(write: PtyWrite, action: ReplyRequest['action'], text: string | null, choice: number | null = null): void {
  if (action === 'approve') write(APPROVE_KEYS);
  else if (action === 'deny') write(DENY_KEYS);
  else if (action === 'choose') {
    if (choice !== null) write(chooseKeys(choice));
  }
  else if (text !== null) writeText(write, text);
}
