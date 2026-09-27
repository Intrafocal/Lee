/**
 * SomedaySection - Library's Ideas tab (cockpit-design §5; package R2):
 * today's Someday list as Rows, newest first. Each shows the text (in
 * Newsreader when it came from a device capture: your words), where it came
 * from and its age. Explore is a quiet inline action; the rest of triage
 * (Plan with agent, Promote to task, Keep, Drop) sits in the ⋯ menu. The
 * capture field sits at the top: borderless, Newsreader.
 *
 * Capture goes through the v0 path (window.lee.copilot.capture, spooled
 * when Hester is down). Triage is the capture's own lifecycle, not ceremony.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { CockpitTask } from '../../../../shared/cockpit';
import { formatAge } from '../../../lib/cockpitModel';
import { createTask, listSomeday, triageSomeday, type SomedayItem, type SomedayTriage } from '../../../lib/hesterCockpit';
import { isDeviceCapture, matchesFind } from '../../../lib/workModel';
import { Btn, Row } from '../ui';
import { MoreMenu } from '../work/MoreMenu';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

function firstLine(text: string): string {
  return text.split('\n')[0].trim().slice(0, 80) || 'Someday item';
}

const SURFACE_LABEL: Record<string, string> = {
  aeronaut: 'from your phone',
  dirigible: 'from the T-Deck',
  device: 'from a device',
  lee: 'from Lee',
  deep: 'from a Page',
};

export const SomedaySection: React.FC<{ ctx: CockpitCtx; find: string }> = ({ ctx, find }) => {
  const [items, setItems] = useState<SomedayItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void listSomeday(ctx.workspace, 'open').then((r) => {
      if (r.ok) {
        setItems([...r.data].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
        setError(null);
      } else setError(r.error);
    });
  }, [ctx.workspace]);

  useEffect(() => {
    load();
  }, [load]);

  const capture = () => {
    const body = text.trim();
    if (!body || !ctx.copilotApi) return;
    setBusy('capture');
    ctx.copilotApi
      .capture({ text: body, workspace: ctx.workspace, as: 'someday' })
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
          ctx.notify(`Task queued: ${task.title}`);
          ctx.hester.refresh();
        }
      }
      if (t.action === 'explore' && 'to' in t && t.to === 'explore') {
        const exp = r.data && typeof r.data === 'object' && 'exploration' in r.data ? r.data.exploration : null;
        if (exp) ctx.notify(`Exploration started: ${exp.title}`);
      }
      if (t.action === 'keep') ctx.notify('Kept');
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

  const surfaceOf = (i: SomedayItem) => String(i.source?.surface ?? 'lee');
  const list = (items ?? []).filter((i) => matchesFind(find, [i.text, surfaceOf(i)]));
  const handles: RowHandle[] = list.map((i) => ({ id: `someday:${i.id}`, title: firstLine(i.text) }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected?.kind === 'row' ? ctx.mode.selected.id : null;

  return (
    <div className="library-tab">
      <div className="library-create">
        <input
          className="library-write-field"
          value={text}
          placeholder="Capture an idea for later"
          aria-label="Capture an idea"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              capture();
            }
          }}
        />
        <span className="library-hint">{busy === 'capture' ? '…' : '↵'}</span>
      </div>
      {error && <div className="library-hint">{error}</div>}
      {!items && !error && <div className="library-hint">Loading…</div>}
      {items && items.length === 0 && <p className="library-empty">Nothing waiting. Capture ideas here, from your phone or the T-Deck.</p>}
      {items && items.length > 0 && find && list.length === 0 && <p className="library-hint">Nothing here matches “{find}”.</p>}
      <div className="library-ideas">
        {list.map((item) => {
          const id = `someday:${item.id}`;
          const surface = surfaceOf(item);
          const mine = isDeviceCapture(surface);
          return (
            <div
              key={item.id}
              data-cockpit-row={id}
              className={`library-idea${sel === id ? ' is-selected' : ''}`}
              onClick={() => ctx.selectRow(id)}
            >
              <Row
                title={<span className={mine ? 'library-idea-text is-yours' : 'library-idea-text'}>{item.text}</span>}
                sub={`${SURFACE_LABEL[surface] ?? `from ${surface}`} · ${formatAge(item.created_at, ctx.now)}${item.as === 'explore' ? ' · to explore' : ''}`}
              />
              <div className="library-idea-actions">
                <Btn kind="quiet" disabled={busy === item.id} onClick={() => void triage(item, { action: 'explore', to: 'explore' })}>
                  Explore
                </Btn>
                <MoreMenu
                  label="More for this idea"
                  items={[
                    { label: 'Plan with agent', onClick: () => void planWithAgent(item), disabled: busy === item.id || !ctx.api },
                    { label: 'Promote to task', onClick: () => void triage(item, { action: 'promote', to: 'task' }), disabled: busy === item.id },
                    { label: 'Keep', onClick: () => void triage(item, { action: 'keep' }), disabled: busy === item.id },
                    { label: 'Drop', onClick: () => void triage(item, { action: 'drop' }), disabled: busy === item.id },
                  ]}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SomedaySection;
