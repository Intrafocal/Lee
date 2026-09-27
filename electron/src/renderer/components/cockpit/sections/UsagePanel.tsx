/**
 * UsagePanel - History's Usage tab (docs/15-Usage.md §6.3): what today's
 * work cost, pulled from GET /cockpit/usage?range=today when the tab opens,
 * never on a timer.
 *
 * The Claude subscription windows lead as two segmented dials that
 * empty like a fuel gauge (lit segments are what's left; a tick marks
 * where it would be at even pace through the window).
 * Below, every metric is today against the average of the 7 days before:
 * per source (Claude, Pi, Hester cloud, Hester local), Hester's calls split
 * by cloud vs local and by who asked, then the top work items. Spend
 * (billed + estimated dollars) and subscription usage (tokens only) are
 * never added together (§2). Neutral throughout: nothing here needs you,
 * so no next step. Never shown in Deep.
 */

import React, { useEffect, useState } from 'react';
import { formatTokens } from '../../../../shared/cockpit';
import { fetchUsage } from '../../../lib/hesterCockpit';
import {
  GAUGE_SEGMENTS,
  bucketLine,
  compare,
  formatCalls,
  formatUsd,
  itemCostLabel,
  limitGauges,
  limitsAge,
  usageView,
  type Comparison,
  type LimitGauge,
  type UsageBucket,
} from '../../../lib/usageModel';
import { Card, Eyebrow, Row } from '../ui';
import type { CockpitCtx } from '../CockpitHost';

interface UsagePanelProps {
  ctx: CockpitCtx;
  /** Fixture data (smokes): shown without fetching. */
  seed?: unknown;
}

// ---------------------------------------------------------------------------
// The dial
// ---------------------------------------------------------------------------

const SWEEP = 240; // degrees, centred on the top
const GAP = 4; // degrees between segments
const R = 46;
const C = 60;

/** A point on the dial, `deg` clockwise from the top. */
function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

function arc(from: number, to: number, r: number): string {
  const [x1, y1] = polar(from, r);
  const [x2, y2] = polar(to, r);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const Dial: React.FC<{ g: LimitGauge }> = ({ g }) => {
  const step = SWEEP / GAUGE_SEGMENTS;
  const start = -SWEEP / 2;
  // Even pace: the share of the window still to go, as fuel.
  const pace = g.elapsed != null ? start + (1 - g.elapsed) * SWEEP : null;
  const title = [`${g.label}: ${g.left}% left (${g.pct}% used)`, g.resets, g.elapsed != null ? `${Math.round(g.elapsed * 100)}% of the window gone` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`cockpit-usage-dial${g.near ? ' is-near' : ''}`} title={title}>
      <svg viewBox="0 0 120 100" role="img" aria-label={title}>
        {Array.from({ length: GAUGE_SEGMENTS }, (_, i) => (
          <path
            key={i}
            d={arc(start + i * step + GAP / 2, start + (i + 1) * step - GAP / 2, R)}
            className={i < g.lit ? 'cockpit-usage-seg is-lit' : 'cockpit-usage-seg'}
          />
        ))}
        {pace != null && (
          <line
            className="cockpit-usage-pace"
            x1={polar(pace, R + 8)[0]}
            y1={polar(pace, R + 8)[1]}
            x2={polar(pace, R + 13)[0]}
            y2={polar(pace, R + 13)[1]}
          />
        )}
        <text x={C} y={C + 2} className="cockpit-usage-dial-pct" textAnchor="middle">
          {g.left}%
        </text>
        <text x={C} y={C + 18} className="cockpit-usage-dial-unit" textAnchor="middle">
          left
        </text>
      </svg>
      <div className="cockpit-usage-dial-label">{g.label}</div>
      <div className="cockpit-usage-dial-sub">{g.near ? `Near the limit${g.resets ? ` · ${g.resets}` : ''}` : g.resets || ' '}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// A metric: today, a bullet bar against the average, the change
// ---------------------------------------------------------------------------

interface MetricProps {
  label: string;
  value: string;
  cmp: Comparison | null;
  /** A second, quieter line (spend under tokens). */
  note?: string;
}

const ARROW: Record<Comparison['direction'], string> = { up: '↑', down: '↓', flat: '≈', none: '' };

const Metric: React.FC<MetricProps> = ({ label, value, cmp, note }) => (
  <div className="cockpit-usage-metric">
    <div className="cockpit-usage-metric-name">
      {label}
      {note && <span className="cockpit-usage-metric-note">{note}</span>}
    </div>
    <div
      className="cockpit-usage-bullet"
      aria-hidden="true"
      title={cmp?.avg ? `Today ${value} · 7-day avg ${cmp.avg}` : undefined}
    >
      {cmp && cmp.direction !== 'none' && (
        <>
          <span className="cockpit-usage-bullet-fill" style={{ width: `${cmp.todayFrac * 100}%` }} />
          {cmp.avgFrac > 0 && <span className="cockpit-usage-bullet-avg" style={{ left: `${cmp.avgFrac * 100}%` }} />}
        </>
      )}
    </div>
    <div className="cockpit-usage-metric-value">{value}</div>
    <div className="cockpit-usage-metric-cmp">
      {cmp && cmp.delta ? (
        <>
          <span className="cockpit-usage-delta">
            {ARROW[cmp.direction]} {cmp.delta}
          </span>
          <span className="cockpit-usage-avg">avg {cmp.avg}</span>
        </>
      ) : (
        <>
          <span className="cockpit-usage-delta">—</span>
          <span className="cockpit-usage-avg" />
        </>
      )}
    </div>
  </div>
);

const tok = (n: number) => (n > 0 ? formatTokens(Math.round(n)) : '0 tok');
const usd = (n: number) => formatUsd(n) || '$0';
const calls = (n: number) => `${formatCalls(n)} ${n === 1 ? 'call' : 'calls'}`;

export const UsagePanel: React.FC<UsagePanelProps> = ({ ctx, seed }) => {
  const [raw, setRaw] = useState<unknown>(seed ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(seed === undefined);

  useEffect(() => {
    if (seed !== undefined) return undefined;
    let cancelled = false;
    setLoading(true);
    fetchUsage(ctx.workspace, 'today').then((r) => {
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
  }, [ctx.workspace, seed]);

  const view = raw != null ? usageView(raw) : null;
  const gauges = view ? limitGauges(view.limits, ctx.now) : [];
  const age = view ? limitsAge(view.limits, ctx.now) : '';
  const base = view?.baseline && view.baseline.daysWithData > 0 ? view.baseline : null;
  const total = view ? bucketLine(view.totals) : '';

  const cmpOf = (today: number, avg: UsageBucket | undefined, key: 'tokens' | 'spend_usd' | 'calls', fmt: (n: number) => string) =>
    base ? compare(today, avg?.[key] ?? 0, fmt) : null;

  return (
    <div className="cockpit-usage">
      {error && <div className="cockpit-offline">{error}</div>}
      {loading && !view && !error && <div className="cockpit-empty">Reading usage…</div>}
      {view && (
        <>
          <Eyebrow right={age || undefined}>Claude subscription</Eyebrow>
          {gauges.length > 0 ? (
            <Card className="cockpit-usage-dials">
              {gauges.map((g) => (
                <Dial key={g.id} g={g} />
              ))}
            </Card>
          ) : (
            <div className="cockpit-empty">No limits read yet: they arrive after a Claude session's first reply.</div>
          )}

          <Eyebrow right={base ? `vs ${base.days}-day avg` : 'no 7-day average yet'}>Today</Eyebrow>
          <p className="cockpit-usage-total">{total ? `${total}.` : 'Nothing recorded today.'}</p>

          {view.sources.length > 0 && (
            <Card className="cockpit-usage-metrics">
              {view.sources.map((s) => {
                const avg = base?.sources[s.id];
                const hasSpend = s.spend_usd > 0 || (avg?.spend_usd ?? 0) > 0;
                return (
                  <React.Fragment key={s.id}>
                    <Metric label={s.label} value={tok(s.tokens)} cmp={cmpOf(s.tokens, avg, 'tokens', tok)} />
                    {hasSpend && <Metric label="" note="spent" value={usd(s.spend_usd)} cmp={cmpOf(s.spend_usd, avg, 'spend_usd', usd)} />}
                  </React.Fragment>
                );
              })}
            </Card>
          )}

          {view.hester.length > 0 && (
            <>
              <Eyebrow>Hester calls</Eyebrow>
              <Card className="cockpit-usage-metrics">
                {view.hester.map((s) => (
                  <Metric key={s.id} label={s.label} value={calls(s.calls ?? 0)} cmp={cmpOf(s.calls ?? 0, base?.hester[s.id], 'calls', formatCalls)} />
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
          <p className="cockpit-usage-note">Spend is billed and estimated dollars; subscription usage is counted in tokens. The dials empty as you use them; the tick is where they would be at even pace.</p>
        </>
      )}
    </div>
  );
};

export default UsagePanel;
