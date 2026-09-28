/**
 * Proposals - the steward's one-click proposals (v4 contract §8.3): at most
 * five buttons. A click executes the action with the existing client calls
 * (proposalPlan maps it), then records `accepted`; ✕ records `dismissed`
 * and, when the proposal is about a task, a nudge override on Lee so the
 * steward stays quiet on it. Nothing ever asks for a reason.
 *
 * Two proposals only open something you then confirm: `launch` opens the
 * Launcher prefilled with the model-written prompt (you press Enter; it is
 * recorded `accepted` when the Launcher opens), and an op with params or a
 * confirm opens the Ops dialog (recorded `accepted` only when it runs; Cancel
 * leaves the proposal clickable).
 */

import React, { useState } from 'react';
import { Icon } from '../Icon';
import type { OperationInfo, Proposal } from '../../../shared/cockpit';
import { PAGE_ID_RE, pageIdForExploration } from '../../../shared/desk';
import { mergeServes, proposalPlan, proposalTaskId, type ProposalPlan } from '../../lib/cockpitModel';
import { openDesk } from './cockpitMode';
import {
  createExploration,
  createTask,
  fetchWorkstreams,
  patchTask,
  proposalOutcome,
} from '../../lib/hesterCockpit';
import { RunOpDialog } from './RunMenu';
import type { CockpitCtx } from './CockpitHost';

/** A Page card id from a card id or a pre-Desk exploration id (Desk D2 §2.1: migration keeps the hex). */
export function deskCardId(id: string): string | null {
  return PAGE_ID_RE.test(id) ? id : pageIdForExploration(id);
}

/** Open a Page card at the Desk; the overview when the id is neither a card nor an exploration. */
export function openCard(ctx: Pick<CockpitCtx, 'copilotApi' | 'workspace'>, id: string): Promise<void> {
  const card_id = deskCardId(id);
  return openDesk(ctx.copilotApi, ctx.workspace, card_id ? { kind: 'card', card_id } : { kind: 'overview' });
}

/** Select or open what an `open` proposal (or a Goals row) points at. Pages (and old explorations) open at the Desk. */
export async function openItem(ctx: CockpitCtx, target: 'task' | 'exploration' | 'page' | 'goal' | 'workstream', id: string): Promise<void> {
  if (target === 'task') {
    ctx.setSection('work');
    ctx.selectRow(`task:${id}`);
  } else if (target === 'exploration' || target === 'page') {
    await openCard(ctx, id);
  } else if (target === 'goal') {
    ctx.setSection('goals');
    ctx.selectRow(`goal:${id}`);
  } else {
    const r = await fetchWorkstreams(ctx.workspace);
    const title = r.ok ? r.data.find((w) => w.id === id)?.title ?? id : id;
    ctx.openWorkstream(id, title);
  }
}

type ExecResult = { ok: true; message?: string } | { ok: false; error: string } | { ok: 'dialog'; op: OperationInfo };

async function execute(ctx: CockpitCtx, plan: ProposalPlan): Promise<ExecResult> {
  const ws = ctx.workspace;
  switch (plan.kind) {
    case 'create_task': {
      const r = await createTask(ws, plan.body);
      if (!r.ok) return { ok: false, error: r.error };
      ctx.hester.refresh();
      return { ok: true, message: 'Task added' };
    }
    case 'launch': {
      // The prompt is model-written: show it in the Launcher, you press Enter (C3).
      const req = plan.req;
      const text = req.prompt ?? req.title ?? '';
      ctx.openLauncher({
        text,
        ...(req.lead ? { lead: req.lead } : {}),
        ...(req.kind ? { kind: req.kind } : {}),
        ...(req.serves?.length ? { serves: req.serves } : {}),
        origin: req.origin ?? { kind: 'hester' },
      });
      return { ok: true };
    }
    case 'patch_task': {
      let body = plan.body;
      if ('serves' in body) {
        // link_goal adds a goal; PATCH replaces serves, so send the task's current ones too.
        const snap = ctx.hester.snapshot?.tasks;
        const task = [...(snap?.open ?? []), ...(snap?.recent_closed ?? [])].find((t) => t.id === plan.taskId);
        body = { serves: mergeServes(task?.serves, body.serves) };
      }
      const r = await patchTask(ws, plan.taskId, body);
      if (!r.ok) return { ok: false, error: r.error };
      ctx.hester.refresh();
      return { ok: true, message: 'serves' in plan.body ? `Linked to ${plan.body.serves.join(', ')}` : `Lead: ${plan.body.lead}` };
    }
    case 'park': {
      if (!ctx.copilotApi) return { ok: false, error: 'Ideas is not available here' };
      const r = await ctx.copilotApi.capture({ text: plan.text, workspace: ws, as: 'someday' });
      if (!r.success) return { ok: false, error: 'Could not park it' };
      ctx.hester.refresh();
      return { ok: true, message: r.spooled ? 'Parked (queued for Hester)' : 'Parked in Ideas' };
    }
    case 'open':
      await openItem(ctx, plan.target, plan.id);
      return { ok: true };
    case 'run_op': {
      if (!ctx.api) return { ok: false, error: 'Operations need the Cockpit runtime' };
      const op = ctx.ops?.operations.find((o) => o.def.name === plan.name) ?? null;
      // Params or an outward-facing op: show the exact command first (the Ops dialog).
      if (op && (op.def.confirm || (op.def.params ?? []).length)) return { ok: 'dialog', op };
      const r = await ctx.api.ops.run({ workspace: ws, name: plan.name });
      if (r.success) return { ok: true, message: `Running ${plan.name}` };
      if (r.needs_confirm || r.missing_params?.length) {
        ctx.setSection('ops');
        return { ok: false, error: `${plan.name} needs confirming in Ops` };
      }
      return { ok: false, error: r.error || 'Run failed' };
    }
    case 'explore': {
      // Hester's migration puts it on the Desk as a Page on the next read (Desk D2 §6.1).
      const r = await createExploration(ws, { seed: plan.seed, origin: { kind: 'hester' } });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, message: `On your Desk: ${r.data.title}` };
    }
  }
}

export const Proposals: React.FC<{ ctx: CockpitCtx; proposals: readonly Proposal[] | null | undefined }> = ({ ctx, proposals }) => {
  const [state, setState] = useState<Record<string, 'busy' | 'accepted' | 'dismissed'>>({});
  const [dialog, setDialog] = useState<{ op: OperationInfo; p: Proposal } | null>(null);
  const items = (proposals ?? [])
    .map((p) => ({ p, plan: proposalPlan(p, ctx.workspace) }))
    .filter((x): x is { p: Proposal; plan: ProposalPlan } => !!x.plan)
    .slice(0, 5);
  if (!items.length) return null;

  const accept = async (p: Proposal, plan: ProposalPlan) => {
    if (state[p.id]) return;
    setState((s) => ({ ...s, [p.id]: 'busy' }));
    let res: ExecResult;
    try {
      res = await execute(ctx, plan);
    } catch {
      res = { ok: false, error: 'Failed' };
    }
    if (res.ok === false) {
      ctx.notify(res.error, 'error');
      setState((s) => {
        const n = { ...s };
        delete n[p.id];
        return n;
      });
      return;
    }
    if (res.ok === 'dialog') {
      // Accepted only when the op runs (the dialog's onRan); Cancel leaves it pending.
      setDialog({ op: res.op, p });
      return;
    }
    if (res.message) ctx.notify(res.message);
    accepted(p);
  };

  const accepted = (p: Proposal) => {
    ctx.copilotApi?.logCeremony('confirm', 'proposal');
    setState((s) => ({ ...s, [p.id]: 'accepted' }));
    void proposalOutcome(ctx.workspace, p.id, 'accepted');
  };

  const closeDialog = () => {
    const p = dialog?.p;
    setDialog(null);
    if (!p) return;
    setState((s) => {
      if (s[p.id] !== 'busy') return s;
      const n = { ...s };
      delete n[p.id];
      return n;
    });
  };

  const dismiss = (p: Proposal) => {
    if (state[p.id]) return;
    setState((s) => ({ ...s, [p.id]: 'dismissed' }));
    void proposalOutcome(ctx.workspace, p.id, 'dismissed');
    const taskId = proposalTaskId(p);
    // Over IPC (local user): a direct fetch of Lee's API fails CORS in packaged builds.
    if (taskId) void ctx.api?.lint.overrideNudge(`task:${ctx.workspace}:${taskId}`, `steward:${p.id}`).catch(() => undefined);
  };

  return (
    <div className="cockpit-proposals" onClick={(e) => e.stopPropagation()}>
      {items.map(({ p, plan }) => {
        const st = state[p.id];
        if (st === 'dismissed') return null;
        return (
          <span key={p.id} className={`cockpit-proposal${st === 'accepted' ? ' is-done' : ''}`}>
            <button className="cockpit-btn" disabled={!!st} title={p.action.replace('_', ' ')} onClick={() => void accept(p, plan)}>
              {st === 'accepted' && <Icon name="check" size={11} />} {p.label}
            </button>
            {!st && (
              <button className="cockpit-chip-x" aria-label={`Dismiss: ${p.label}`} title="Not this" onClick={() => dismiss(p)}>
                ×
              </button>
            )}
          </span>
        );
      })}
      {dialog && <RunOpDialog ctx={ctx} op={dialog.op} onRan={() => accepted(dialog.p)} onClose={closeDialog} />}
    </div>
  );
};

export default Proposals;
