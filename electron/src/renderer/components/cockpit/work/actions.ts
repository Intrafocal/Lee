/**
 * Work's actions on attention items (cockpit-design §4): the existing v0
 * queue paths (window.lee.copilot reply / snooze / dismiss), with the
 * Cockpit's error toasts. Each resolves true when the queue took it.
 */

import type { AttentionItem, ActionResult } from '../../../../shared/copilot';
import type { CockpitCtx } from '../CockpitHost';

type Notify = CockpitCtx['notify'];

async function run(notify: Notify, fn: () => Promise<ActionResult>): Promise<boolean> {
  try {
    const r = await fn();
    if (!r.success) notify(r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'failed', 'error');
    return r.success;
  } catch {
    notify('failed', 'error');
    return false;
  }
}

/** Allow or deny an approval. Never a gesture (§4.3). */
export function decide(ctx: CockpitCtx, item: AttentionItem, action: 'approve' | 'deny'): Promise<boolean> {
  const api = ctx.copilotApi;
  if (!api) return Promise.resolve(false);
  return run(ctx.notify, () => api.reply(item.id, { action, version: item.version }));
}

/** Send text exactly as written (C3): a quick-reply chip or the reply box. */
export function sendText(ctx: CockpitCtx, item: AttentionItem, text: string): Promise<boolean> {
  const api = ctx.copilotApi;
  const body = text.trim();
  if (!api || !body) return Promise.resolve(false);
  return run(ctx.notify, () => api.reply(item.id, { action: 'text', text: body, version: item.version }));
}

/** Answer a single-select question with one of its options. */
export function choose(ctx: CockpitCtx, item: AttentionItem, choice: number): Promise<boolean> {
  const api = ctx.copilotApi;
  if (!api) return Promise.resolve(false);
  return run(ctx.notify, () => api.reply(item.id, { action: 'choose', choice, version: item.version }));
}

/** Snooze until the item changes (§4.3's leftward swipe). */
export function snooze(ctx: CockpitCtx, item: AttentionItem): Promise<boolean> {
  const api = ctx.copilotApi;
  if (!api) return Promise.resolve(false);
  return run(ctx.notify, () => api.snooze(item.id, { until: 'change' }));
}

export function dismiss(ctx: CockpitCtx, item: AttentionItem): Promise<boolean> {
  const api = ctx.copilotApi;
  if (!api) return Promise.resolve(false);
  return run(ctx.notify, () => api.dismiss(item.id));
}

/** A question item a single option pick can answer here. */
export function choosable(item: AttentionItem): boolean {
  return item.kind === 'question' && item.actions.includes('choose') && (item.question?.questions.length ?? 0) === 1;
}
