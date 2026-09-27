/**
 * HistorySection - the last 7 days from Hester (contracts §4.6): verified
 * wins, closed tasks with outcome and acceptance, and operation readings.
 * v4 §6: closed tasks show the goals they served, readings of a GOALS
 * metric show their change as a chip ("G1 +180 ms").
 *
 * Cockpit design §6.3: built from the primitives. Nothing here needs you,
 * so there is no ember and no next step; goal links are quiet text.
 *
 * docs/15-Usage.md §6.3: a Usage tab beside Activity ("what happened" and
 * "what it cost" together), pulled when opened (UsagePanel).
 */

import React, { useEffect, useState } from 'react';
import { formatAge, goalDeltaChip } from '../../../lib/cockpitModel';
import { fetchHistory, type HistoryResponse } from '../../../lib/hesterCockpit';
import { Btn, Card, Eyebrow, Row, SectionHead } from '../ui';
import type { CockpitCtx, RowHandle } from '../CockpitHost';
import { UsagePanel } from './UsagePanel';

export type HistoryTab = 'activity' | 'usage';

const TABS: ReadonlyArray<{ id: HistoryTab; label: string }> = [
  { id: 'activity', label: 'Activity' },
  { id: 'usage', label: 'Usage' },
];

/** Row takes no data attributes: tag it for the keyboard's scrollIntoView through its ref. */
const rowAttr = (id: string) => (el: HTMLElement | null) => el?.setAttribute('data-cockpit-row', id);

interface HistorySectionProps {
  ctx: CockpitCtx;
  /** The tab to open on (smokes); Activity by default. */
  initialTab?: HistoryTab;
  /** Fixture usage for the Usage tab (smokes). */
  usageSeed?: unknown;
}

export const HistorySection: React.FC<HistorySectionProps> = ({ ctx, initialTab = 'activity', usageSeed }) => {
  const [tab, setTab] = useState<HistoryTab>(initialTab);
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
  const handles: RowHandle[] = tab !== 'activity' ? [] : [
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

  const openGoal = (g: string) => {
    ctx.setSection('goals');
    ctx.selectRow(`goal:${g}`);
  };

  return (
    <section className="cockpit-sec cockpit-history">
      <SectionHead title="History" summary={tab === 'activity' ? 'Last 7 days' : 'What it cost'} />
      <div className="library-tabs cockpit-history-tabs" role="tablist" aria-label="History">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`library-tabs-item${tab === t.id ? ' is-on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'usage' && <UsagePanel ctx={ctx} seed={usageSeed} />}
      {tab === 'activity' && error && <div className="cockpit-offline">{error}</div>}
      {tab === 'activity' && (
        <>
          {data && wins.length === 0 && tasks.length === 0 && readings.length === 0 && <div className="cockpit-empty">Nothing verified this week yet.</div>}
          {wins.length > 0 && (
            <>
              <Eyebrow>Wins</Eyebrow>
              <Card>
                {wins.map((w, i) => {
                  const id = `win:${w.ref ?? i}`;
                  return (
                    <Row
                      key={id}
                      ref={rowAttr(id)}
                      dot={w.verified ? 'done' : 'idle'}
                      selected={isSel(id)}
                      title={w.title}
                      sub={[w.kind, w.ref].filter(Boolean).join(' · ')}
                      meta={formatAge(w.at, ctx.now)}
                    />
                  );
                })}
              </Card>
        </>
      )}
      {tasks.length > 0 && (
        <>
          <Eyebrow>Closed tasks</Eyebrow>
          <Card>
            {tasks.map((t) => {
              const id = `closed:${t.id}`;
              const accepted = t.accepted === true ? 'accepted' : t.accepted === false ? 'not accepted' : null;
              return (
                <div key={id} data-cockpit-row={id} className={`cockpit-history-task${isSel(id) ? ' is-selected' : ''}`} onClick={() => ctx.selectRow(id)}>
                  <div className="cockpit-op-head">
                    <span className="cockpit-op-name">{t.title}</span>
                    <span className="cockpit-op-meta">{formatAge(t.closed_at, ctx.now)}</span>
                  </div>
                  <div className="cockpit-op-sub">
                    {[t.status, accepted, t.commits.length ? t.commits.map((c) => c.slice(0, 7)).join(' · ') : null].filter(Boolean).join(' · ')}
                    {(t.goal_impact ?? []).map((g) => (
                      <Btn
                        key={g}
                        kind="quiet"
                        className="cockpit-history-goal"
                        title={`Served ${g}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openGoal(g);
                        }}
                      >
                        {g}
                      </Btn>
                    ))}
                  </div>
                  {t.outcome && <div className="cockpit-op-text">{t.outcome}</div>}
                </div>
              );
            })}
          </Card>
        </>
      )}
      {readings.length > 0 && (
        <>
          <Eyebrow>Readings</Eyebrow>
          <Card>
            {Array.from(new Set(readings.map((r) => r.metric))).map((metric) => {
              const latest = readings.find((r) => r.metric === metric)!;
              const prev = readingFor(metric);
              return (
                <Row
                  key={metric}
                  title={`${metric} ${latest.value}${latest.unit ? ` ${latest.unit}` : ''}${prev ? ` (was ${prev.value})` : ''}`}
                  sub={latest.goal_id ? goalDeltaChip(latest.goal_id, latest.delta, latest.unit) : undefined}
                  meta={`${latest.source.op} · ${formatAge(latest.ts, ctx.now)}`}
                />
              );
            })}
          </Card>
        </>
      )}
        </>
      )}
    </section>
  );
};

export default HistorySection;
