/**
 * TabsSection - every tab in this workspace (contracts §4.5): Lee main's
 * runtime view (all windows) joined with this window's tabs. Fidelity tier,
 * state and quiet time, linked task or operation, last command. Unlinked
 * rows offer Assign… (agent → task, shell → operation).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../Icon';
import type { TabRuntimeInfo } from '../../../../shared/cockpit';
import { formatDuration } from '../../../lib/cockpitModel';
import { createTask, linkTask } from '../../../lib/hesterCockpit';
import type { CockpitCtx, CockpitTab, RowHandle } from '../CockpitHost';

interface TabRow {
  id: string;
  label: string;
  kind: string;
  fidelity: string | null;
  runtime: TabRuntimeInfo | null;
  tab: CockpitTab | null;
  isAgent: boolean;
  local: boolean;
}

function sameWs(a: string | null, b: string): boolean {
  return !!a && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

const AssignPicker: React.FC<{ ctx: CockpitCtx; row: TabRow; onDone: () => void }> = ({ ctx, row, onDone }) => {
  const [error, setError] = useState<string | null>(null);
  const rt = row.runtime;
  const pty = rt?.pty_id ?? row.tab?.ptyId ?? null;
  const freeTasks = (ctx.hester.snapshot?.tasks.open ?? []).filter((t) => !t.agent || t.agent.pty_id == null);

  const done = (ok: boolean, err?: string) => {
    if (ok) {
      ctx.copilotApi?.logCeremony('assign', 'task-assign');
      ctx.hester.refresh();
      onDone();
    } else setError(err || 'failed');
  };

  if (!row.isAgent) {
    const ops = ctx.ops?.operations ?? [];
    return (
      <div className="cockpit-confirm" onClick={(e) => e.stopPropagation()}>
        {ops.length === 0 && <div className="cockpit-muted">No operations defined.</div>}
        <div className="cockpit-chips">
          {ops.map((o) => (
            <button
              key={o.def.name}
              className="cockpit-chip-btn"
              onClick={() =>
                pty != null &&
                ctx.api?.ops
                  .linkTab(pty, ctx.workspace, o.def.name)
                  .then((r) => done(r.success, r.error))
                  .catch(() => done(false))
              }
            >
              {o.def.name}
            </button>
          ))}
        </div>
        {error && <div className="cockpit-error">{error}</div>}
        <button className="cockpit-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    );
  }

  const agent = {
    provider: rt?.provider ?? row.tab?.provider ?? 'claude',
    pty_id: pty,
    session_id: rt?.session_id ?? null,
    tab_label: row.label,
  };
  return (
    <div className="cockpit-confirm" onClick={(e) => e.stopPropagation()}>
      {freeTasks.length > 0 && <div className="cockpit-muted">Attach to an open task:</div>}
      <div className="cockpit-chips">
        {freeTasks.map((t) => (
          <button
            key={t.id}
            className="cockpit-chip-btn"
            onClick={() =>
              linkTask(ctx.workspace, t.id, { pty_id: pty ?? undefined, session_id: agent.session_id, provider: agent.provider, tab_label: row.label }).then((r) =>
                done(r.ok, r.ok ? undefined : r.error),
              )
            }
          >
            {t.title}
          </button>
        ))}
      </div>
      <div className="cockpit-row-actions">
        <button
          className="cockpit-btn is-primary"
          onClick={() =>
            createTask(ctx.workspace, {
              workspace: ctx.workspace,
              title: row.label,
              title_source: 'user',
              status: 'running',
              agent,
              confirmed: true,
              origin: { kind: 'agent' },
            }).then((r) => done(r.ok, r.ok ? undefined : r.error))
          }
        >
          New task from this
        </button>
        <button className="cockpit-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <div className="cockpit-error">{error}</div>}
    </div>
  );
};

export const TabsSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const [assigning, setAssigning] = useState<string | null>(null);

  const rows = useMemo<TabRow[]>(() => {
    const out: TabRow[] = [];
    const seenPty = new Set<number>();
    for (const rt of ctx.runtime) {
      if (!sameWs(rt.workspace, ctx.workspace) || rt.state.state === 'exited') continue;
      const tab = ctx.tabs.find((t) => t.ptyId === rt.pty_id) ?? null;
      seenPty.add(rt.pty_id);
      out.push({
        id: `pty:${rt.pty_id}`,
        label: tab?.label ?? rt.label,
        kind: rt.kind,
        fidelity: rt.fidelity,
        runtime: rt,
        tab,
        isAgent: rt.kind === 'agent' || (tab ? ctx.isAgentTab(tab) : false),
        local: !!tab,
      });
    }
    for (const tab of ctx.tabs) {
      if (tab.ptyId != null && seenPty.has(tab.ptyId)) continue;
      const isAgent = ctx.isAgentTab(tab);
      out.push({
        id: `tab:${tab.id}`,
        label: tab.label,
        kind: isAgent ? 'agent' : tab.ptyId != null ? (tab.type === 'terminal' ? 'shell' : 'tui') : 'other',
        fidelity: null,
        runtime: null,
        tab,
        isAgent,
        local: true,
      });
    }
    return out;
  }, [ctx.runtime, ctx.tabs, ctx.workspace, ctx.isAgentTab]);

  const open = (row: TabRow) => {
    const pty = row.runtime?.pty_id ?? row.tab?.ptyId ?? null;
    if (row.isAgent && pty != null) ctx.goInto(pty, 'tabs');
    else if (row.tab) ctx.openOwnTab(row.tab.id);
    else if (pty != null) ctx.focusPty(pty);
  };

  const handles: RowHandle[] = rows.map((r) => ({ id: r.id, title: r.label, open: () => open(r) }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const tasks = ctx.hester.snapshot?.tasks.open ?? [];

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Tabs</h2>
        <span className="cockpit-muted">{rows.length} open in this workspace</span>
      </header>
      <div className="cockpit-rows">
        {rows.map((row, i) => {
          const rt = row.runtime;
          const task = rt?.task_id ? tasks.find((t) => t.id === rt.task_id) : tasks.find((t) => t.agent?.pty_id != null && t.agent.pty_id === (rt?.pty_id ?? row.tab?.ptyId));
          const linked = task ? `task: ${task.title}` : rt?.operation ? `op: ${rt.operation}` : null;
          const last = rt?.last_command ? `${rt.last_command.text ?? rt.last_command.argv0}${rt.last_command.exit_code ? ` (exit ${rt.last_command.exit_code})` : ''}` : null;
          const canAssign = !linked && (row.isAgent || row.kind === 'shell') && (rt?.pty_id ?? row.tab?.ptyId) != null;
          return (
            <div
              key={row.id}
              data-cockpit-row={row.id}
              className={`cockpit-row${sel?.kind === 'row' && sel.id === row.id ? ' is-selected' : ''}`}
              onClick={() => ctx.selectRow(row.id)}
              onDoubleClick={() => open(row)}
            >
              <div className="cockpit-row-head">
                <Icon name={row.isAgent ? 'agent' : row.kind === 'shell' ? 'terminal' : row.kind === 'tui' ? 'system' : 'tabs'} size={12} />
                <span className="cockpit-row-title">{row.label}</span>
                <span className="cockpit-tag">{row.kind}</span>
                {row.fidelity && <span className="cockpit-tag">{row.fidelity}</span>}
                {rt && (
                  <span className={`cockpit-status st-${rt.state.state}`}>
                    {rt.state.state}
                    {rt.state.quiet_ms > 60000 ? ` · quiet ${formatDuration(rt.state.quiet_ms)}` : ''}
                  </span>
                )}
                {!row.local && <span className="cockpit-muted">other window</span>}
              </div>
              {(linked || last) && (
                <div className="cockpit-row-meta">
                  {[linked, last && !linked && row.kind === 'shell' ? `Terminal: ${last}` : last].filter(Boolean).join(' · ')}
                </div>
              )}
              {assigning === row.id ? (
                <AssignPicker ctx={ctx} row={row} onDone={() => setAssigning(null)} />
              ) : (
                <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="cockpit-btn" onClick={() => handles[i].open?.()}>
                    {row.isAgent ? 'Peek' : 'Open'}
                  </button>
                  {canAssign && (
                    <button className="cockpit-btn" onClick={() => setAssigning(row.id)}>
                      Assign…
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default TabsSection;
