/**
 * UsagePanel - History's Usage tab (docs/15-Usage.md §6.3): what the work
 * cost, pulled from GET /cockpit/usage when the tab opens or the range
 * changes (today / week / month), never on a timer.
 *
 * Spend (billed + estimated dollars) and subscription usage (tokens only)
 * are never added together (§2): per source (Claude, Pi, Hester cloud,
 * Hester local), Hester split by cloud vs local and by who asked, and the
 * top work items by cost. Neutral throughout: nothing here needs you, so
 * no ember and no next step. Never shown in Deep.
 */

import React, { useEffect, useState } from 'react';
import { formatTokens } from '../../../../shared/cockpit';
import { fetchUsage } from '../../../lib/hesterCockpit';
import {
  USAGE_RANGES,
  bucketLine,
  itemCostLabel,
  resetLabel,
  usageView,
  type UsageBucket,
  type UsageRange,
} from '../../../lib/usageModel';
import { Card, Eyebrow, Row } from '../ui';
import type { CockpitCtx } from '../CockpitHost';

interface UsagePanelProps {
  ctx: CockpitCtx;
  /** Fixture data (smokes): shown without fetching. */
  seed?: unknown;
}

const tokensMeta = (b: UsageBucket) => (b.tokens > 0 ? formatTokens(b.tokens) : '');

function hesterSub(b: UsageBucket): string {
  const parts: string[] = [];
  if (b.calls != null) parts.push(`${b.calls} ${b.calls === 1 ? 'call' : 'calls'}`);
  const line = bucketLine(b);
  if (line) parts.push(line);
  return parts.join(' · ');
}

export const UsagePanel: React.FC<UsagePanelProps> = ({ ctx, seed }) => {
  const [range, setRange] = useState<UsageRange>('today');
  const [raw, setRaw] = useState<unknown>(seed ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(seed === undefined);

  useEffect(() => {
    if (seed !== undefined) return undefined;
    let cancelled = false;
    setLoading(true);
    fetchUsage(ctx.workspace, range).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok) {
        setRaw(r.data);
        setError(null);
      } else {
        setRaw(null);
        setError(r.status === 404 ? 'Usage needs a newer Hester.' : r.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ctx.workspace, range, seed]);

  const view = raw != null ? usageView(raw) : null;
  const rangeLabel = USAGE_RANGES.find((r) => r.id === range)?.label.toLowerCase() ?? range;
  const total = view ? bucketLine(view.totals) : '';
  const five = view?.limits?.five_hour;
  const week = view?.limits?.seven_day;
  const windows = [
    five ? `5h ${Math.round(five.used_pct)}%${five.resets_at ? `, resets ${resetLabel(five.resets_at, ctx.now)}` : ''}` : '',
    week ? `7d ${Math.round(week.used_pct)}%${week.resets_at ? `, resets ${resetLabel(week.resets_at, ctx.now)}` : ''}` : '',
  ].filter(Boolean);

  return (
    <div className="cockpit-usage">
      <div className="library-tabs cockpit-usage-range" role="tablist" aria-label="Range">
        {USAGE_RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={range === r.id}
            className={`library-tabs-item${range === r.id ? ' is-on' : ''}`}
            onClick={() => setRange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <div className="cockpit-offline">{error}</div>}
      {loading && !view && !error && <div className="cockpit-empty">Reading usage…</div>}
      {view && (
        <>
          <p className="cockpit-usage-total">{total ? `${total} ${range === 'today' ? 'today' : `this ${rangeLabel}`}.` : `Nothing recorded ${range === 'today' ? 'today' : `this ${rangeLabel}`}.`}</p>
          {windows.length > 0 && <p className="cockpit-usage-note">Claude subscription: {windows.join(' · ')}</p>}

          {view.sources.length > 0 && (
            <>
              <Eyebrow>By source</Eyebrow>
              <Card>
                {view.sources.map((s) => (
                  <Row key={s.id} title={s.label} sub={bucketLine(s) || 'nothing yet'} meta={tokensMeta(s) || undefined} />
                ))}
              </Card>
            </>
          )}

          {view.hester.length > 0 && (
            <>
              <Eyebrow>Hester</Eyebrow>
              <Card>
                {view.hester.map((s) => (
                  <Row key={s.id} title={s.label} sub={hesterSub(s) || 'nothing yet'} meta={tokensMeta(s) || undefined} />
                ))}
              </Card>
            </>
          )}

          {view.top.length > 0 && (
            <>
              <Eyebrow>Top work items</Eyebrow>
              <Card>
                {view.top.map((t) => (
                  <Row key={t.id} title={t.title} meta={itemCostLabel(t) || undefined} />
                ))}
              </Card>
            </>
          )}
          <p className="cockpit-usage-note">Spend is billed and estimated dollars; subscription usage is counted in tokens.</p>
        </>
      )}
    </div>
  );
};

export default UsagePanel;
