/**
 * SomedaySection - captures with deterministic triage (contracts §4.4).
 * Capture goes through the v0 path (window.lee.copilot.capture, spooled when
 * Hester is down). Triage is the capture's own lifecycle, not ceremony.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../Icon';
import type { CockpitTask } from '../../../../shared/cockpit';
import { formatAge } from '../../../lib/cockpitModel';
import { createTask, listSomeday, triageSomeday, type SomedayItem, type SomedayTriage } from '../../../lib/hesterCockpit';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

function firstLine(text: string): string {
  return text.split('\n')[0].trim().slice(0, 80) || 'Someday item';
}

export const SomedaySection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const [items, setItems] = useState<SomedayItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [text, setText] = useState('');
  const [asExplore, setAsExplore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [explored, setExplored] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    listSomeday(ctx.workspace, showAll ? 'all' : 'open').then((r) => {
      if (r.ok) {
        setItems([...r.data].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
        setError(null);
      } else setError(r.error);
    });
  }, [ctx.workspace, showAll]);

  useEffect(() => {
    load();
  }, [load]);

  const capture = () => {
    const body = text.trim();
    if (!body || !ctx.copilotApi) return;
    setBusy('capture');
    ctx.copilotApi
      .capture({ text: body, workspace: ctx.workspace, as: asExplore ? 'explore' : 'someday' })
      .then((r) => {
        if (r.success) {
          setText('');
          ctx.notify(r.spooled ? 'Captured (queued until Hester is back)' : 'Captured');
          load();
        } else ctx.notify(r.error || 'Capture failed', 'error');
      })
      .catch(() => ctx.notify('Capture failed', 'error'))
      .finally(() => setBusy(null));
  };

  const triage = async (item: SomedayItem, t: SomedayTriage, then?: () => Promise<void>) => {
    setBusy(item.id);
    try {
      const r = await triageSomeday(ctx.workspace, item.id, t);
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        return;
      }
      if (t.action === 'promote') {
        let task: CockpitTask | null = r.data && typeof r.data === 'object' && 'task' in r.data ? r.data.task : null;
        if (!task) {
          const made = await createTask(ctx.workspace, {
            workspace: ctx.workspace,
            title: firstLine(item.text),
            status: 'queued',
            lead: 'delegate',
            kind: 'unknown',
            confirmed: true,
            origin: { kind: 'someday', ref: item.id },
          });
          task = made.ok ? made.data : null;
        }
        if (task) {
          setLinks((l) => ({ ...l, [item.id]: task!.id }));
          ctx.notify(`Task queued: ${task.title}`);
          ctx.hester.refresh();
        }
      }
      if (t.action === 'explore' && 'to' in t && t.to === 'explore') {
        const exp = r.data && typeof r.data === 'object' && 'exploration' in r.data ? r.data.exploration : null;
        if (exp) {
          setExplored((l) => ({ ...l, [item.id]: exp.id }));
          ctx.notify(`Exploration started: ${exp.title}`);
        }
      }
      if (then) await then();
      load();
    } finally {
      setBusy(null);
    }
  };

  const planWithAgent = (item: SomedayItem) =>
    triage(item, { action: 'explore' }, async () => {
      if (!ctx.api) return;
      const r = await ctx.api.launch({
        workspace: ctx.workspace,
        lead: 'plan',
        prompt: item.text,
        title: firstLine(item.text),
        kind: 'question',
        origin: { kind: 'someday', ref: item.id },
      });
      ctx.notify(r.success ? 'Planning agent started' : r.error || 'Launch failed', r.success ? 'info' : 'error');
      if (r.success) ctx.hester.refresh();
    });

  const list = items ?? [];
  const handles: RowHandle[] = list.map((i) => ({ id: `someday:${i.id}`, title: firstLine(i.text) }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const stale = list.filter((i) => i.status === 'open' && Date.now() - Date.parse(i.created_at) > 7 * 86400000).length;

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Someday</h2>
        <span className="cockpit-muted">
          {items ? `${list.length} ${showAll ? 'total' : 'open'}` : ''}
          {stale ? ` · ${stale} older than a week` : ''}
        </span>
        <span className="cockpit-header-spacer" />
        <label className="cockpit-check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all
        </label>
      </header>
      <div className="cockpit-capture">
        <input
          className="cockpit-input"
          value={text}
          placeholder="Capture an idea for later… (Enter)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              capture();
            }
          }}
        />
        <button className={`cockpit-chip-btn${asExplore ? ' is-on' : ''}`} onClick={() => setAsExplore((v) => !v)}>
          explore
        </button>
        <button className="cockpit-btn is-primary" disabled={!text.trim() || busy === 'capture' || !ctx.copilotApi} onClick={capture}>
          Capture
        </button>
      </div>
      {error && <div className="cockpit-offline">{error}</div>}
      {items && list.length === 0 && <div className="cockpit-empty">Nothing waiting. Capture ideas here, from Aeronaut or from Dirigible.</div>}
      <div className="cockpit-rows">
        {list.map((item, i) => {
          const open = item.status === 'open';
          const linked = links[item.id] ?? (item.triage?.note?.startsWith('task:') ? item.triage.note.slice(5) : null);
          const exploration = explored[item.id] ?? (item.triage?.note?.startsWith('explore:') ? item.triage.note.slice(8) : null);
          return (
            <div
              key={item.id}
              data-cockpit-row={handles[i].id}
              className={`cockpit-row${sel?.kind === 'row' && sel.id === handles[i].id ? ' is-selected' : ''}${open ? '' : ' is-closed'}`}
              onClick={() => ctx.selectRow(handles[i].id)}
            >
              <div className="cockpit-row-head">
                <span className="cockpit-row-title cockpit-someday-text">{item.text}</span>
              </div>
              <div className="cockpit-row-meta">
                {formatAge(item.created_at, ctx.now)} · {String(item.source?.surface ?? 'lee')}
                {item.as === 'explore' && <span className="cockpit-tag">explore</span>}
                {!open && <span className="cockpit-tag">{item.status}</span>}
                {linked && (
                  <button
                    className="cockpit-link"
                    onClick={() => {
                      ctx.setSection('tasks');
                      ctx.selectRow(`task:${linked}`);
                    }}
                  >
                    → task
                  </button>
                )}
                {exploration && (
                  <button
                    className="cockpit-link"
                    onClick={() => {
                      ctx.setSection('explore');
                      ctx.selectRow(`explore:${exploration}`);
                    }}
                  >
                    → exploration
                  </button>
                )}
              </div>
              {open && (
                <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="cockpit-btn"
                    disabled={busy === item.id}
                    title="Start a durable exploration seeded from this idea (Explore section)"
                    onClick={() => void triage(item, { action: 'explore', to: 'explore' })}
                  >
                    Promote → Explore
                  </button>
                  <button className="cockpit-btn" disabled={busy === item.id || !ctx.api} onClick={() => void planWithAgent(item)}>
                    <Icon name="agent" size={11} /> Plan with agent
                  </button>
                  <button className="cockpit-btn is-primary" disabled={busy === item.id} onClick={() => void triage(item, { action: 'promote', to: 'task' })}>
                    Promote → task
                  </button>
                  <button className="cockpit-btn" disabled={busy === item.id} onClick={() => void triage(item, { action: 'keep' })}>
                    Keep
                  </button>
                  <button className="cockpit-btn is-danger" disabled={busy === item.id} onClick={() => void triage(item, { action: 'drop' })}>
                    Drop
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default SomedaySection;
