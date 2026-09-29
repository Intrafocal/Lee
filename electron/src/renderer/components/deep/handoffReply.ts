/**
 * Reply to a hand-off's agent (R11 / R5), Work's way: its open attention item
 * that takes text, else typed into its idle terminal. Shared by the Page's
 * margin (DeepHost) and a Board's clipboard (BoardView).
 */

import type { UseCopilotResult } from '../../hooks/useCopilot';
import { listTasks } from '../../lib/hesterCockpit';
import { canTextReply, tabSendError } from '../../lib/workModel';

export type HandoffReply = { ok: true } | { ok: false; error: string | null };

/** `error` is one line to show, or null when there's nothing to say. */
export async function replyToHandoff(workspace: string, copilot: UseCopilotResult, taskId: string | null, body: string): Promise<HandoffReply> {
  const typed = body.trim();
  if (!typed) return { ok: false, error: null };
  if (!taskId) return { ok: false, error: 'That hand-off has no agent yet' };
  const tasks = await listTasks(workspace, 'open');
  const task = tasks.ok ? tasks.data.find((t) => t.id === taskId) ?? null : null;
  const pty = task?.agent?.pty_id ?? null;
  const item =
    pty != null ? (copilot.snapshot?.items ?? []).find((i) => i.state === 'open' && i.source.pty_id === pty && canTextReply(i)) ?? null : null;
  if (item && copilot.api) {
    try {
      const r = await copilot.api.reply(item.id, { action: 'text', text: typed, version: item.version });
      if (!r.success) return { ok: false, error: r.error === 'stale' ? 'Already handled elsewhere' : r.error || 'Reply failed' };
    } catch {
      return { ok: false, error: 'Reply failed' };
    }
    return { ok: true };
  }
  if (pty == null) return { ok: false, error: 'That agent isn’t running. Open it in Work to resume it.' };
  const api = window.lee?.cockpit;
  if (!api) return { ok: false, error: null };
  try {
    const r = await api.tabs.send(pty, { text: typed, submit: true, purpose: 'reply' });
    if (!r.success) return { ok: false, error: tabSendError(r.error) };
  } catch {
    return { ok: false, error: 'Reply failed' };
  }
  return { ok: true };
}
