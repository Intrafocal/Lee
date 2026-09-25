/**
 * The `ops` command domain (package B) on Lee's `POST /command`, with its C3
 * table: Hester may run defined operations without `confirm: true`; anything
 * else it asks for becomes a Feed proposal a human approves.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.8.
 */

import type { Principal } from '../../shared/copilot';
import type { OpRunRequest } from '../../shared/cockpit';
import type { CommandDomainHandler, CommandDomainResult } from './cockpit-bus';
import { LOG_TAIL_LINES, errorStatus } from './ops-runtime';
import type { OpsRuntime } from './ops-runtime';

function ok(data: unknown, status = 200): CommandDomainResult {
  return { status, body: { success: true, data } };
}

function fail(error: string, status = errorStatus(error), extra: Record<string, unknown> = {}): CommandDomainResult {
  return { status, body: { success: false, error, ...extra } };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function params(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string' || typeof x === 'number') out[k] = String(x);
  return out;
}

export function createOpsDomain(runtime: OpsRuntime, defaultWorkspace: () => string | null): CommandDomainHandler {
  return async (action: string, p: Record<string, unknown>, principal: Principal | undefined): Promise<CommandDomainResult> => {
    if (!principal || (principal.kind === 'shared' && !principal.loopback)) return fail('forbidden', 403);
    p = p ?? {};
    if (action === 'agent') return fail('forbidden', 403);
    const workspace = str(p.workspace) ?? defaultWorkspace() ?? '';
    const needsWs = action !== 'result';
    if (needsWs && !runtime.isOpenWorkspace(workspace)) return fail('unknown_workspace', 400);

    switch (action) {
      case 'list':
        return ok(runtime.snapshot(workspace));

      case 'status': {
        const name = str(p.name);
        if (!name) return fail('invalid', 400);
        const op = runtime.snapshot(workspace).operations.find((o) => o.def.name === name);
        return op ? ok(op) : fail('not_found', 404);
      }

      case 'result': {
        const runId = str(p.run_id);
        if (!runId) return fail('invalid', 400);
        const spaces = runtime.isOpenWorkspace(workspace) ? [workspace] : runtime.knownWorkspaces();
        for (const ws of spaces) {
          const run = runtime.getRun(ws, runId);
          if (!run) continue;
          const tail = principal.kind === 'local-user' ? runtime.logTail(ws, run.op, LOG_TAIL_LINES) : undefined;
          return ok(tail !== undefined ? { run, log_tail: tail } : { run });
        }
        return fail('not_found', 404);
      }

      case 'run': {
        const req: OpRunRequest = {
          workspace,
          name: str(p.name),
          command: typeof p.command === 'string' ? p.command : undefined,
          cwd: str(p.cwd) ?? null,
          params: params(p.params),
          confirmed: p.confirmed === true,
          ...(typeof p.pty_id === 'number' ? { pty_id: p.pty_id } : {}),
        };
        if (!!req.name === (req.command !== undefined)) return fail('invalid', 400);
        const out = await runtime.run(req, principal);
        return { status: out.status, body: out.result.success ? { ...out.result, ...(out.status === 202 ? { proposed: true } : {}) } : out.result };
      }

      case 'propose': {
        const req = {
          workspace,
          name: str(p.name),
          command: typeof p.command === 'string' ? p.command : undefined,
          cwd: str(p.cwd) ?? null,
          params: params(p.params),
          reason: str(p.reason) ?? null,
        };
        if (!!req.name === (req.command !== undefined)) return fail('invalid', 400);
        const out = await runtime.propose(req, principal);
        return { status: out.status, body: out.result.success ? { ...out.result, proposed: true } : out.result };
      }

      case 'stop': {
        const name = str(p.name);
        if (!name) return fail('invalid', 400);
        const m = runtime.getOperation(workspace, name);
        if (!m) return fail('not_found', 404);
        if (principal.kind === 'shared' && (m.def.confirm || !m.runnable)) return fail('forbidden', 403);
        const res = runtime.stopOp(workspace, name);
        return res.success ? ok({ stopped: name }) : fail(res.error ?? 'not_running');
      }

      default:
        return fail(`unknown_action: ${action}. Use: list, status, result, run, propose, stop`, 400);
    }
  };
}
