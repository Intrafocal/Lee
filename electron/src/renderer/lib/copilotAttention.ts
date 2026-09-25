/**
 * Pure helpers for the Copilot renderer surfaces (AttentionFlyout,
 * HandoffDialog). Kept free of React so they can be unit-tested directly -
 * see scripts/copilot-renderer-smoke.mjs.
 */

import type { AttentionItem } from '../../shared/copilot';

/**
 * Groups open attention items into the flyout's three severity buckets.
 *
 * Snoozed items are excluded (contract §5.2): they already leave the counts
 * and the blocking set once snoozed, so the list must not go on showing them
 * as if they were still live (with Snooze still offered) - that makes
 * Snooze look like it did nothing.
 */
export function groupAttentionItems(items: AttentionItem[]): {
  blocking: AttentionItem[];
  needsYou: AttentionItem[];
  recent: AttentionItem[];
} {
  const open = items.filter((i) => i.state === 'open');
  return {
    blocking: open.filter((i) => i.severity === 'blocking'),
    needsYou: open.filter((i) => i.severity === 'needs-you'),
    recent: open.filter((i) => i.severity === 'ambient'),
  };
}

/**
 * Resolves an `<input type="time">` value ("HH:MM") to the next ISO
 * timestamp at that time - today if it hasn't passed yet, otherwise
 * tomorrow.
 *
 * `new Date("HH:MM")` throws `RangeError: Invalid time value`, so the caller
 * must not just hand the raw input value to `new Date()`.
 */
export function resolveSummaryAtTime(timeValue: string, now: Date = new Date()): string {
  const [hours, minutes] = timeValue.split(':').map(Number);
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

// Tab attention: map live items onto the tabs that own them (by PTY id), so an
// agent's state shows on its own tab and the status bar only mentions what the
// tab strip can't show.

/** `needs`: an approval, question, blocker or decision is waiting on you. `review`: the agent finished a turn. */
export type TabAttention = 'needs' | 'review';

const NEEDS_KINDS = new Set<AttentionItem['kind']>(['approval', 'waiting', 'blocker', 'decision']);

function isLive(item: AttentionItem): boolean {
  return item.state === 'open';
}

export function needsYou(item: AttentionItem): boolean {
  return isLive(item) && (NEEDS_KINDS.has(item.kind) || item.severity !== 'ambient');
}

export function attentionByPty(items: readonly AttentionItem[] | undefined): Map<number, TabAttention> {
  const byPty = new Map<number, TabAttention>();
  for (const item of items ?? []) {
    const pty = item.source.pty_id;
    if (pty == null || !isLive(item)) continue;
    if (needsYou(item)) byPty.set(pty, 'needs');
    else if (item.kind === 'review' && !byPty.has(pty)) byPty.set(pty, 'review');
  }
  return byPty;
}

/** Items that need you but aren't on a tab in this window (other windows, workspaces, failures, Lee-sourced). */
export function offscreenNeeds(items: readonly AttentionItem[] | undefined, visiblePtyIds: ReadonlySet<number>): AttentionItem[] {
  return (items ?? []).filter((i) => needsYou(i) && (i.source.pty_id == null || !visiblePtyIds.has(i.source.pty_id)));
}
