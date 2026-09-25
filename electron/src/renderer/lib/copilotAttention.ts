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
