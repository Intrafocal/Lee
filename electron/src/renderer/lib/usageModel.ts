/**
 * usageModel - the pure logic behind usage in the Cockpit (docs/15-Usage.md
 * §6; package UR): the subscription limits in Work's summary line (§6.1),
 * the Launcher's note at 85%, the token label next to every agent (§6.2),
 * and History's Usage tab (§6.3), normalised from GET /cockpit/usage.
 *
 * The rules it carries: subscription usage is tokens only, dollars only for
 * billed or estimated spend (§2, §9.1); the limits are hidden until the
 * 5-hour window passes 50%, and carry their age past 10 minutes. Nothing
 * here is shown in Deep.
 *
 * Pure (type-only imports apart from shared/cockpit's formatTokens), so
 * the smokes compile and run it without React or a DOM.
 */

import type { AgentUsage, CostBasis, UsageLimits, UsageTokens } from '../../shared/cockpit';
import { formatTokens } from '../../shared/cockpit';

function at(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Money and time labels
// ---------------------------------------------------------------------------

/** "$3.10", "$0.04", "<$0.01", "$120". */
export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

/** Dollars are shown only for money actually spent or estimated (§2). */
export function showsDollars(basis: CostBasis | null | undefined): boolean {
  return basis === 'billed' || basis === 'estimate';
}

/** "3:40pm". */
export function clock12(iso: string | null | undefined): string {
  const t = at(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "3:40pm" today, else "Thu 9:00am". */
export function resetLabel(iso: string | null | undefined, now: number): string {
  const t = at(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? clock12(iso) : `${WEEKDAYS[d.getDay()]} ${clock12(iso)}`;
}

/** "2h ago" / "15m ago" (no "just now": only used past 10 minutes). */
function agoLabel(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Next to each agent (§6.2)
// ---------------------------------------------------------------------------

/** Work's list rows and waiting cards: "412k tok"; '' before the first turn ends. */
export function agentTokensLabel(usage: Pick<AgentUsage, 'shown_tokens'> | null | undefined): string {
  const n = num(usage?.shown_tokens);
  return n != null && n > 0 ? formatTokens(n) : '';
}

/** The detail's meta item: "412k tokens", "412k tokens · $3.10" for billed or estimated runs. */
export function agentUsageDetail(usage: Pick<AgentUsage, 'shown_tokens' | 'cost_basis' | 'cost_usd'> | null | undefined): string {
  const tok = agentTokensLabel(usage);
  if (!tok || !usage) return '';
  const tokens = tok.replace(/ tok$/, ' tokens');
  const cost = showsDollars(usage.cost_basis) ? formatUsd(usage.cost_usd) : '';
  return cost ? `${tokens} · ${cost}` : tokens;
}

// ---------------------------------------------------------------------------
// Limits (§6.1)
// ---------------------------------------------------------------------------

/** The limits are hidden until the 5-hour window passes this. */
export const LIMITS_SHOW_ABOVE_PCT = 50;
/** Past this age the label says "as of …". */
export const LIMITS_STALE_MS = 10 * 60000;
/** The Launcher notes the 5-hour window from this. */
export const LAUNCH_NOTE_PCT = 85;

type Window = { used_pct: number; resets_at: string | null };

/** A window that has already reset says nothing about now. */
function liveWindow(w: Window | null | undefined, now: number): Window | null {
  if (!w || num(w.used_pct) == null) return null;
  const r = at(w.resets_at);
  if (!Number.isNaN(r) && r <= now) return null;
  return w;
}

export interface LimitsSummary {
  /** "5h 62% · 7d 18%", with " as of 2h ago" past 10 minutes. */
  text: string;
  /** The tooltip: "5h resets 3:40pm · 7d resets Thu 9:00am". */
  title: string;
}

/**
 * The limits part of Work's summary line, or null while the 5-hour window
 * is at or under 50% (or has reset since the snapshot, or there is none).
 */
export function limitsSummary(limits: UsageLimits | null | undefined, now: number): LimitsSummary | null {
  if (!limits) return null;
  const five = liveWindow(limits.five_hour, now);
  if (!five || five.used_pct <= LIMITS_SHOW_ABOVE_PCT) return null;
  const week = liveWindow(limits.seven_day, now);
  const parts = [`5h ${Math.round(five.used_pct)}%`];
  if (week) parts.push(`7d ${Math.round(week.used_pct)}%`);
  const age = now - at(limits.as_of);
  const asOf = !Number.isNaN(age) && age > LIMITS_STALE_MS ? ` as of ${agoLabel(age)}` : '';
  const resets = [
    five.resets_at ? `5h resets ${resetLabel(five.resets_at, now)}` : '',
    week?.resets_at ? `7d resets ${resetLabel(week.resets_at, now)}` : '',
  ].filter(Boolean);
  return { text: parts.join(' · ') + asOf, title: resets.join(' · ') };
}

/** The Launcher's one note as you start a Claude run: "5h window at 91%, resets 3:40pm"; null under 85%. */
export function launcherLimitNote(limits: UsageLimits | null | undefined, now: number): string | null {
  const five = liveWindow(limits?.five_hour, now);
  if (!five || five.used_pct < LAUNCH_NOTE_PCT) return null;
  const resets = five.resets_at ? `, resets ${resetLabel(five.resets_at, now)}` : '';
  return `5h window at ${Math.round(five.used_pct)}%${resets}`;
}

// ---------------------------------------------------------------------------
// History's Usage tab (§6.3): GET /cockpit/usage?range=today|week|month
// ---------------------------------------------------------------------------

export type UsageRange = 'today' | 'week' | 'month';

export const USAGE_RANGES: ReadonlyArray<{ id: UsageRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

/** The sources §5 totals by, in display order. */
export const USAGE_SOURCES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'pi', label: 'Pi' },
  { id: 'hester_cloud', label: 'Hester cloud' },
  { id: 'hester_local', label: 'Hester local' },
];

export interface UsageBucket {
  /** billed + estimate, in dollars (§2). */
  spend_usd: number;
  /** Tokens covered by a subscription: shown as tokens only. */
  subscription_tokens: number;
  /** Tokens with no money (local models). */
  local_tokens: number;
  /** All shown tokens (input + output + cache_write). */
  tokens: number;
  calls: number | null;
}

export interface UsageSourceRow extends UsageBucket {
  id: string;
  label: string;
}

export interface UsageItemRow {
  id: string;
  title: string;
  tokens: number;
  cost_basis: CostBasis | null;
  cost_usd: number | null;
}

export interface UsageViewModel {
  sources: UsageSourceRow[];
  totals: UsageBucket;
  hester: Array<{ id: string; label: string } & UsageBucket>;
  top: UsageItemRow[];
  limits: UsageLimits | null;
}

/** input + output + cache_write (as AgentUsage.shown_tokens). */
export function shownTokens(t: UsageTokens | null | undefined): number {
  if (!t) return 0;
  return (num(t.input) ?? 0) + (num(t.output) ?? 0) + (num(t.cache_write) ?? 0);
}

function tokensOf(v: unknown): number {
  const n = num(v);
  if (n != null) return n;
  const o = obj(v);
  return o ? shownTokens(o as UsageTokens) : 0;
}

const EMPTY: UsageBucket = { spend_usd: 0, subscription_tokens: 0, local_tokens: 0, tokens: 0, calls: null };

/**
 * One bucket from the daemon, tolerant of its spelling: flat
 * (`spend_usd`, `subscription_tokens`, `local_tokens`, `shown_tokens`) or
 * split by basis (`by_basis: {billed, estimate, subscription, local}` each
 * with `cost_usd` and `tokens` / `shown_tokens`). Subscription dollars are
 * never read.
 */
export function usageBucket(raw: unknown): UsageBucket {
  const o = obj(raw);
  if (!o) return { ...EMPTY };
  const byBasis = obj(o.by_basis);
  let spend = num(o.spend_usd) ?? num(o.spend) ?? null;
  let sub = num(o.subscription_tokens) ?? null;
  let local = num(o.local_tokens) ?? null;
  let tokens = num(o.shown_tokens) ?? (o.tokens !== undefined ? tokensOf(o.tokens) : null);
  if (byBasis) {
    const part = (k: string) => obj(byBasis[k]);
    const tok = (p: Record<string, unknown> | null) => (p ? num(p.shown_tokens) ?? tokensOf(p.tokens) : 0);
    const usd = (p: Record<string, unknown> | null) => (p ? num(p.cost_usd) ?? num(p.spend_usd) ?? 0 : 0);
    spend = spend ?? usd(part('billed')) + usd(part('estimate'));
    sub = sub ?? tok(part('subscription'));
    local = local ?? tok(part('local'));
    tokens = tokens ?? ['billed', 'estimate', 'subscription', 'local'].reduce((s, k) => s + tok(part(k)), 0);
  }
  if (spend == null) {
    const basis = typeof o.cost_basis === 'string' ? (o.cost_basis as CostBasis) : null;
    // A bare cost_usd counts only with a billed / estimate basis (a subscription's list price is never spend).
    spend = showsDollars(basis) ? num(o.cost_usd) ?? 0 : 0;
  }
  return {
    spend_usd: spend,
    subscription_tokens: sub ?? 0,
    local_tokens: local ?? 0,
    tokens: tokens ?? (sub ?? 0) + (local ?? 0),
    calls: num(o.calls),
  };
}

function sum(buckets: readonly UsageBucket[]): UsageBucket {
  let calls: number | null = null;
  const out = { ...EMPTY };
  for (const b of buckets) {
    out.spend_usd += b.spend_usd;
    out.subscription_tokens += b.subscription_tokens;
    out.local_tokens += b.local_tokens;
    out.tokens += b.tokens;
    if (b.calls != null) calls = (calls ?? 0) + b.calls;
  }
  return { ...out, calls };
}

function sourceMap(raw: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const o = obj(r);
      if (o && typeof o.source === 'string') out.set(o.source, o);
    }
  } else {
    const o = obj(raw);
    if (o) for (const [k, v] of Object.entries(o)) out.set(k, v);
  }
  return out;
}

const HESTER_SLICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'cloud', label: 'Cloud' },
  { id: 'local', label: 'Local' },
  { id: 'user', label: 'You asked' },
  { id: 'automatic', label: 'On its own' },
];

/** GET /cockpit/usage's response, as the Usage tab shows it. */
export function usageView(raw: unknown): UsageViewModel {
  const o = obj(raw) ?? {};
  const totals = sourceMap(o.totals);
  const sources: UsageSourceRow[] = [];
  for (const s of USAGE_SOURCES) {
    if (!totals.has(s.id)) continue;
    sources.push({ ...s, ...usageBucket(totals.get(s.id)) });
  }
  for (const [id, v] of totals) {
    if (USAGE_SOURCES.some((s) => s.id === id)) continue;
    sources.push({ id, label: id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), ...usageBucket(v) });
  }

  const hesterRaw = obj(o.hester) ?? {};
  const hester: UsageViewModel['hester'] = [];
  for (const s of HESTER_SLICES) {
    const v = hesterRaw[s.id] ?? obj(hesterRaw.by_location)?.[s.id] ?? obj(hesterRaw.by_trigger)?.[s.id];
    if (v === undefined) continue;
    hester.push({ ...s, ...usageBucket(v) });
  }

  const itemsRaw = [o.top_items, o.top, o.top_tasks, o.tasks].find(Array.isArray) as unknown[] | undefined;
  const top: UsageItemRow[] = [];
  for (const r of itemsRaw ?? []) {
    const it = obj(r);
    if (!it) continue;
    const usage = obj(it.usage);
    const basis = (typeof it.cost_basis === 'string' ? it.cost_basis : typeof usage?.cost_basis === 'string' ? usage.cost_basis : null) as CostBasis | null;
    const cost = num(it.cost_usd) ?? num(it.spend_usd) ?? num(usage?.cost_usd);
    const tokens = num(it.shown_tokens) ?? num(usage?.shown_tokens) ?? tokensOf(it.tokens ?? usage?.tokens);
    const id = String(it.task_id ?? it.id ?? it.session_id ?? top.length);
    top.push({ id, title: String(it.title ?? it.name ?? id), tokens, cost_basis: basis, cost_usd: cost });
  }
  // By cost: dollars first where there are any, then tokens.
  top.sort((a, b) => (showsDollars(b.cost_basis) ? b.cost_usd ?? 0 : 0) - (showsDollars(a.cost_basis) ? a.cost_usd ?? 0 : 0) || b.tokens - a.tokens);

  const lim = obj(o.limits);
  const limits = lim && typeof lim.as_of === 'string' ? (lim as unknown as UsageLimits) : null;
  return { sources, totals: sum(sources), hester, top: top.slice(0, 10), limits };
}

/** "$4.20 spent · 3.1M tok on the subscription · 240k tok local"; parts at zero are left out. */
export function bucketLine(b: UsageBucket): string {
  const parts: string[] = [];
  if (b.spend_usd > 0) parts.push(`${formatUsd(b.spend_usd)} spent`);
  if (b.subscription_tokens > 0) parts.push(`${formatTokens(b.subscription_tokens)} on the subscription`);
  if (b.local_tokens > 0) parts.push(`${formatTokens(b.local_tokens)} local`);
  return parts.join(' · ');
}

/** A work item's cost label: dollars for billed / estimated, else tokens. */
export function itemCostLabel(r: Pick<UsageItemRow, 'tokens' | 'cost_basis' | 'cost_usd'>): string {
  const tok = r.tokens > 0 ? formatTokens(r.tokens) : '';
  const usd = showsDollars(r.cost_basis) ? formatUsd(r.cost_usd) : '';
  return [tok, usd].filter(Boolean).join(' · ');
}
