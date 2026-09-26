/**
 * HistorySection - the last 7 days from Hester (contracts §4.6): verified
 * wins, closed tasks with outcome and acceptance, and operation readings.
 * Goal-impact wording is v4.
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../../Icon';
import { formatAge } from '../../../lib/cockpitModel';
import { fetchHistory, type HistoryResponse } from '../../../lib/hesterCockpit';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

export const HistorySection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHistory(ctx.workspace, 7).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.workspace, ctx.hester.snapshot?.version]);

  const tasks = data?.tasks ?? [];
  const wins = data?.wins ?? [];
  const readings = data?.readings ?? [];
  const handles: RowHandle[] = [
    ...wins.map((w, i) => ({ id: `win:${w.ref ?? i}`, title: w.title })),
    ...tasks.map((t) => ({ id: `closed:${t.id}`, title: t.title })),
  ];
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const isSel = (id: string) => sel?.kind === 'row' && sel.id === id;

  const readingFor = (metric: string) => {
    const same = readings.filter((r) => r.metric === metric);
    if (same.length < 2) return null;
    return same[1];
  };

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>History</h2>
        <span className="cockpit-muted">Last 7 days</span>
      </header>
      {error && <div className="cockpit-offline">{error}</div>}
      {data && wins.length === 0 && tasks.length === 0 && readings.length === 0 && <div className="cockpit-empty">Nothing verified this week yet.</div>}
      {wins.length > 0 && (
        <div className="cockpit-group">
          <div className="cockpit-group-title">Wins</div>
          {wins.map((w, i) => {
            const id = `win:${w.ref ?? i}`;
            return (
              <div key={id} data-cockpit-row={id} className={`cockpit-row${isSel(id) ? ' is-selected' : ''}`} onClick={() => ctx.selectRow(id)}>
                <div className="cockpit-row-head">
                  {w.verified ? <Icon name="check" size={12} /> : <Icon name="dot" size={12} />}
                  <span className="cockpit-row-title">{w.title}</span>
                  <span className="cockpit-tag">{w.kind}</span>
                  {w.ref && <code className="cockpit-muted">{w.ref}</code>}
                  <span className="cockpit-muted">{formatAge(w.at, ctx.now)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tasks.length > 0 && (
        <div className="cockpit-group">
          <div className="cockpit-group-title">Closed tasks</div>
          {tasks.map((t) => {
            const id = `closed:${t.id}`;
            return (
              <div key={id} data-cockpit-row={id} className={`cockpit-row${isSel(id) ? ' is-selected' : ''}`} onClick={() => ctx.selectRow(id)}>
                <div className="cockpit-row-head">
                  <span className={`cockpit-status st-${t.status}`}>{t.status}</span>
                  <span className="cockpit-row-title">{t.title}</span>
                  {t.accepted === true && <span className="cockpit-tag is-ok">accepted</span>}
                  {t.accepted === false && <span className="cockpit-tag">not accepted</span>}
                  <span className="cockpit-muted">{formatAge(t.closed_at, ctx.now)}</span>
                </div>
                {t.outcome && <div className="cockpit-row-text">{t.outcome}</div>}
                {t.commits.length > 0 && <div className="cockpit-row-meta">{t.commits.map((c) => c.slice(0, 7)).join(' · ')}</div>}
              </div>
            );
          })}
        </div>
      )}
      {readings.length > 0 && (
        <div className="cockpit-group">
          <div className="cockpit-group-title">Readings</div>
          {Array.from(new Set(readings.map((r) => r.metric))).map((metric) => {
            const latest = readings.find((r) => r.metric === metric)!;
            const prev = readingFor(metric);
            return (
              <div key={metric} className="cockpit-row">
                <div className="cockpit-row-head">
                  <span className="cockpit-row-title">
                    {metric} {latest.value}
                    {latest.unit ? ` ${latest.unit}` : ''}
                    {prev ? ` (was ${prev.value})` : ''}
                  </span>
                  <span className="cockpit-muted">
                    {latest.source.op} · {formatAge(latest.ts, ctx.now)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default HistorySection;
