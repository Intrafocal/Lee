/**
 * Agent usage (docs/15-Usage.md §3.1-§3.3, §4): the Claude status line relay's
 * state (limits, session cost), the transcript reader that sums tokens per
 * turn, Pi's reported usage, and each session's running total for snapshots.
 * Pure: no Electron. The queue owns one UsageTracker and logs its events.
 *
 * Tokens: `thinking` is a subset of `output`. Fields a source never reported
 * are omitted, never zero-filled. Subscription usage carries a list-price
 * cost in the event log, but AgentUsage.cost_usd is only set for billed and
 * estimated spend (§2, §9.1).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { AgentUsage, CostBasis, UsageLimits, UsageTokens } from '../../shared/cockpit';

export type UsageProvider = 'anthropic' | 'google' | 'ollama' | 'openai' | 'other';

/** §4.1: one model's usage in an event. */
export interface UsageEntry {
  provider: UsageProvider;
  model: string;
  tokens: UsageTokens;
  cost_usd?: number;
  cost_basis: CostBasis;
  duration_ms?: number;
}

/** §4.2 `agent.usage` data (session_id and pty_id are added by the queue). */
export interface TurnUsage {
  provider: UsageProvider;
  by_model: UsageEntry[];
}

/** §4.2 `limits.snapshot` data. */
export interface LimitsSnapshotData {
  source: 'claude';
  five_hour?: { used_pct: number; resets_at: string | null };
  seven_day?: { used_pct: number; resets_at: string | null };
  session_id: string | null;
}

const TOKEN_KEYS: Array<keyof UsageTokens> = ['input', 'output', 'cache_read', 'cache_write', 'thinking'];

// ---------------------------------------------------------------------------
// Price table (§8): the fallback for Claude sessions without a status line.
// Per million tokens. Unknown models get tokens but no cost, never a guess.
// ---------------------------------------------------------------------------

export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  /** 5-minute cache writes; 1-hour writes cost 2x input. */
  cache_write: number;
}

function price(input: number, output: number, cacheRead?: number): ModelPrice {
  return { input, output, cache_read: cacheRead ?? input * 0.1, cache_write: input * 1.25 };
}

/** Anthropic first-party list prices (checked 2026-09-27). */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': price(10, 50, 0.25),
  'claude-fable-5': price(10, 50),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-haiku-4-5': price(1, 5),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `usage.prices` from ~/.lee/config.yaml (and ~/.config/lee/config.yaml): { model: {input, output, cache_read?, cache_write?} }. */
export function loadPriceOverrides(home: string = os.homedir()): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  for (const file of [path.join(home, '.config', 'lee', 'config.yaml'), path.join(home, '.lee', 'config.yaml')]) {
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      const prices = isRecord(doc) && isRecord(doc.usage) ? doc.usage.prices : undefined;
      if (!isRecord(prices)) continue;
      for (const [model, p] of Object.entries(prices)) {
        if (!isRecord(p)) continue;
        const input = num(p.input);
        const output = num(p.output);
        if (input == null || output == null) continue;
        const base = price(input, output, num(p.cache_read) ?? undefined);
        const cw = num(p.cache_write);
        out[model] = cw == null ? base : { ...base, cache_write: cw };
      }
    } catch {
      // missing or unreadable file
    }
  }
  return out;
}

/**
 * The price for a model id: an exact key, or a key followed only by a date
 * snapshot (`-20260401`) and/or a context tag (`[1m]`). Never a family guess.
 */
export function priceFor(model: string, table: Record<string, ModelPrice>): ModelPrice | null {
  if (table[model]) return table[model];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (!model.startsWith(k)) continue;
    if (/^(-\d{8})?(\[[^\]]*\])?$/.test(model.slice(k.length))) return table[k];
  }
  return null;
}

interface CacheSplit {
  w1h: number;
  w5m: number;
}

/** Cost of one model's tokens at list price; null for an unknown model. */
export function estimateCost(model: string, tokens: UsageTokens, table: Record<string, ModelPrice>, split?: CacheSplit): number | null {
  const p = priceFor(model, table);
  if (!p) return null;
  const cw = tokens.cache_write ?? 0;
  const w1h = split ? Math.min(split.w1h, cw) : 0;
  const w5m = cw - w1h;
  const usd =
    ((tokens.input ?? 0) * p.input +
      (tokens.output ?? 0) * p.output +
      (tokens.cache_read ?? 0) * p.cache_read +
      w5m * p.cache_write +
      w1h * p.input * 2) /
    1_000_000;
  return roundUsd(usd);
}

function roundUsd(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Token arithmetic
// ---------------------------------------------------------------------------

function addTokens(into: UsageTokens, add: UsageTokens, sign = 1): void {
  for (const k of TOKEN_KEYS) {
    const v = add[k];
    if (v === undefined) continue;
    into[k] = Math.max(0, (into[k] ?? 0) + sign * v);
  }
}

function anyTokens(t: UsageTokens): boolean {
  return TOKEN_KEYS.some((k) => (t[k] ?? 0) !== 0);
}

export function shownTokens(t: UsageTokens): number {
  return (t.input ?? 0) + (t.output ?? 0) + (t.cache_write ?? 0);
}

/** Claude transcript `message.usage` -> §4.1 tokens (plus the 1h/5m cache-write split for pricing). */
export function claudeTokens(u: unknown): { tokens: UsageTokens; split: CacheSplit } | null {
  if (!isRecord(u)) return null;
  const tokens: UsageTokens = {};
  const set = (k: keyof UsageTokens, v: unknown) => {
    const n = num(v);
    if (n != null && n >= 0) tokens[k] = n;
  };
  set('input', u.input_tokens);
  set('output', u.output_tokens);
  set('cache_read', u.cache_read_input_tokens);
  set('cache_write', u.cache_creation_input_tokens);
  if (isRecord(u.output_tokens_details)) set('thinking', u.output_tokens_details.thinking_tokens);
  const cc = isRecord(u.cache_creation) ? u.cache_creation : {};
  const split = { w1h: num(cc.ephemeral_1h_input_tokens) ?? 0, w5m: num(cc.ephemeral_5m_input_tokens) ?? 0 };
  return Object.keys(tokens).length ? { tokens, split } : null;
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

const CHUNK = 1024 * 1024;
/** A usage line longer than this (a huge tool input) is skipped. */
const MAX_LINE = 32 * 1024 * 1024;
const USAGE_MARK = Buffer.from('"usage"');
const ASSISTANT_MARK = Buffer.from('"assistant"');

interface MessageUsage {
  model: string;
  tokens: UsageTokens;
  split: CacheSplit;
}

/** One transcript file's read position and the usage counted per message id (last line wins). */
interface FileState {
  offset: number;
  size: number;
  ids: Map<string, MessageUsage>;
}

/** Per-model token deltas since the last read, with the cache split for pricing. */
type ModelDelta = Map<string, { tokens: UsageTokens; split: CacheSplit }>;

function addDelta(delta: ModelDelta, model: string, tokens: UsageTokens, split: CacheSplit, sign: number): void {
  let d = delta.get(model);
  if (!d) {
    d = { tokens: {}, split: { w1h: 0, w5m: 0 } };
    delta.set(model, d);
  }
  addTokensSigned(d.tokens, tokens, sign);
  d.split.w1h += sign * split.w1h;
  d.split.w5m += sign * split.w5m;
}

/** Signed add that keeps the key once a source reported it (a delta may be negative or zero). */
function addTokensSigned(into: UsageTokens, add: UsageTokens, sign: number): void {
  for (const k of TOKEN_KEYS) {
    const v = add[k];
    if (v === undefined) continue;
    into[k] = (into[k] ?? 0) + sign * v;
  }
}

/**
 * Read a transcript from its last offset and fold new assistant usage lines
 * into `st.ids`, adding each message's change (new line minus what was
 * counted for its id) to `delta`. Returns false when the file can't be read.
 */
function readTranscriptUsage(file: string, st: FileState, delta: ModelDelta): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    // Truncated or replaced: read again from the start; ids keep dedupe right.
    if (size < st.size) st.offset = 0;
    let pos = st.offset;
    let pending: Buffer = Buffer.alloc(0);
    let skipping = false;
    const buf = Buffer.alloc(CHUNK);
    const latest = new Map<string, MessageUsage>();
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let data = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let nl = data.indexOf(10);
      while (nl >= 0) {
        if (!skipping) takeLine(data.subarray(0, nl), latest);
        skipping = false;
        data = data.subarray(nl + 1);
        nl = data.indexOf(10);
      }
      if (data.length > MAX_LINE) {
        skipping = true;
        pending = Buffer.alloc(0);
      } else {
        pending = data;
      }
    }
    // An unterminated last line is re-read next time (the writer may be mid-line).
    st.offset = skipping ? pos : pos - pending.length;
    st.size = size;
    for (const [id, m] of latest) {
      const prev = st.ids.get(id);
      if (prev) addDelta(delta, prev.model, prev.tokens, prev.split, -1);
      addDelta(delta, m.model, m.tokens, m.split, 1);
      st.ids.set(id, m);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function takeLine(line: Buffer, latest: Map<string, MessageUsage>): void {
  if (!line.includes(USAGE_MARK) || !line.includes(ASSISTANT_MARK)) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (!isRecord(entry) || entry.type !== 'assistant' || !isRecord(entry.message)) return;
  const m = entry.message;
  const model = typeof m.model === 'string' && m.model ? m.model : null;
  if (!model || model === '<synthetic>') return;
  const id = typeof m.id === 'string' && m.id ? m.id : typeof entry.uuid === 'string' ? `uuid:${entry.uuid}` : null;
  if (!id) return;
  const u = claudeTokens(m.usage);
  if (!u) return;
  latest.set(id, { model, tokens: u.tokens, split: u.split });
}

/** `<dir>/<session>.jsonl` -> `<dir>/<session>/subagents` (verified on 2.1.283). */
export function subagentDir(transcript: string): string {
  return path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
}

function subagentFiles(transcript: string): string[] {
  const dir = subagentDir(transcript);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Status line (§3.1)
// ---------------------------------------------------------------------------

export interface StatusWindow {
  used_pct: number;
  resets_at: string | null;
}

export interface ParsedStatus {
  session_id: string | null;
  model: string | null;
  cost_usd: number | null;
  five_hour: StatusWindow | null;
  seven_day: StatusWindow | null;
}

/** resets_at as ISO: epoch seconds or ms, or a parseable date string; anything else is kept as given. */
function resetsAt(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? v.trim().slice(0, 64) : new Date(t).toISOString();
  }
  return null;
}

function statusWindow(v: unknown): StatusWindow | null {
  if (!isRecord(v)) return null;
  const pct = num(v.used_percentage);
  if (pct == null) return null;
  return { used_pct: pct, resets_at: resetsAt(v.resets_at) };
}

/** Claude Code's status line input, tolerantly (§11: fields may change or disappear). */
export function parseStatusPayload(body: unknown): ParsedStatus {
  const b = isRecord(body) ? body : {};
  const model = isRecord(b.model) ? b.model : {};
  const cost = isRecord(b.cost) ? b.cost : {};
  const rl = isRecord(b.rate_limits) ? b.rate_limits : {};
  return {
    session_id: typeof b.session_id === 'string' && b.session_id ? b.session_id : null,
    model: typeof model.id === 'string' ? model.id : typeof model.display_name === 'string' ? model.display_name : null,
    cost_usd: num(cost.total_cost_usd),
    five_hour: statusWindow(rl.five_hour),
    seven_day: statusWindow(rl.seven_day),
  };
}

/**
 * The payload's shape for the one-time log line (U0.1): keys and value types
 * only, except the rate_limits subtree, whose values show the units.
 */
export function payloadShape(v: unknown, depth = 0, keepValues = false): unknown {
  if (Array.isArray(v)) return depth > 4 ? 'array' : v.slice(0, 1).map((x) => payloadShape(x, depth + 1, keepValues));
  if (isRecord(v)) {
    if (depth > 4) return 'object';
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = payloadShape(x, depth + 1, keepValues || k === 'rate_limits');
    return out;
  }
  if (keepValues && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null)) return v;
  return v === null ? 'null' : typeof v;
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

interface SessionState {
  files: Map<string, FileState>;
  /** Latest status line cost.total_cost_usd, and its value at the last turn end. */
  status_cost: number | null;
  cost_at_turn: number | null;
  /** The session reported rate_limits: it runs on a subscription. */
  subscription: boolean;
  last_seen: number;
  total: { tokens: UsageTokens; cost_usd: number; basis: CostBasis | null; by_model: Map<string, { tokens: UsageTokens; cost_usd: number }> };
}

export interface UsageTrackerOptions {
  prices?: () => Record<string, ModelPrice>;
  /** Only transcripts this accepts are read (Lee main: under ~/.claude/projects). */
  safePath?: (p: string) => string | null;
}

export class UsageTracker {
  private sessions = new Map<string, SessionState>();
  private latest: UsageLimits | null = null;
  private limitsSig: string | null = null;
  private readonly prices: () => Record<string, ModelPrice>;
  private readonly safePath: (p: string) => string | null;

  constructor(opts: UsageTrackerOptions = {}) {
    let cache: Record<string, ModelPrice> | null = null;
    this.prices = opts.prices ?? (() => (cache ??= { ...DEFAULT_PRICES, ...loadPriceOverrides() }));
    this.safePath = opts.safePath ?? ((p) => p);
  }

  private state(sessionId: string, now: number): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        files: new Map(),
        status_cost: null,
        cost_at_turn: null,
        subscription: false,
        last_seen: now,
        total: { tokens: {}, cost_usd: 0, basis: null, by_model: new Map() },
      };
      this.sessions.set(sessionId, s);
    }
    s.last_seen = now;
    return s;
  }

  /**
   * SessionStart: anything already in the transcript (a resumed session's
   * earlier turns) and its existing subagent files predate this Lee session,
   * so start reading at their ends.
   */
  primeTranscript(sessionId: string, transcriptPath: string, now: number = Date.now()): void {
    const file = this.safePath(transcriptPath);
    if (!file) return;
    const s = this.state(sessionId, now);
    for (const f of [file, ...subagentFiles(file)]) {
      if (s.files.has(f)) continue;
      try {
        const size = fs.statSync(f).size;
        s.files.set(f, { offset: size, size, ids: new Map() });
      } catch {
        // not there yet: read from the start when it appears
      }
    }
  }

  /**
   * A status line render. Returns limits.snapshot data when a whole-number
   * percentage or a resets_at changed (else null).
   */
  noteStatus(body: unknown, now: number = Date.now()): { status: ParsedStatus; snapshot: LimitsSnapshotData | null } {
    const st = parseStatusPayload(body);
    if (st.session_id) {
      const s = this.state(st.session_id, now);
      if (st.cost_usd != null) s.status_cost = st.cost_usd;
      if (st.five_hour || st.seven_day) s.subscription = true;
    }
    if (!st.five_hour && !st.seven_day) return { status: st, snapshot: null };
    this.latest = {
      ...(st.five_hour ? { five_hour: { ...st.five_hour } } : {}),
      ...(st.seven_day ? { seven_day: { ...st.seven_day } } : {}),
      as_of: new Date(now).toISOString(),
    };
    const w = (x: StatusWindow | null) => (x ? `${Math.floor(x.used_pct)}@${x.resets_at ?? ''}` : '-');
    const sig = `${w(st.five_hour)}|${w(st.seven_day)}`;
    if (sig === this.limitsSig) return { status: st, snapshot: null };
    this.limitsSig = sig;
    return {
      status: st,
      snapshot: {
        source: 'claude',
        ...(st.five_hour ? { five_hour: st.five_hour } : {}),
        ...(st.seven_day ? { seven_day: st.seven_day } : {}),
        session_id: st.session_id,
      },
    };
  }

  limits(): UsageLimits | null {
    if (!this.latest) return null;
    return {
      ...(this.latest.five_hour ? { five_hour: { ...this.latest.five_hour } } : {}),
      ...(this.latest.seven_day ? { seven_day: { ...this.latest.seven_day } } : {}),
      as_of: this.latest.as_of,
    };
  }

  /**
   * A Claude turn ended: read new transcript usage (main and subagent files),
   * price it and add it to the session total. Null when nothing new was used.
   */
  claudeTurn(sessionId: string, transcriptPath: string | null, now: number = Date.now()): TurnUsage | null {
    const file = transcriptPath ? this.safePath(transcriptPath) : null;
    if (!file) return null;
    const s = this.state(sessionId, now);
    const delta: ModelDelta = new Map();
    for (const f of [file, ...subagentFiles(file)]) {
      let fst = s.files.get(f);
      if (!fst) {
        fst = { offset: 0, size: 0, ids: new Map() };
        s.files.set(f, fst);
      }
      readTranscriptUsage(f, fst, delta);
    }
    const models = [...delta.entries()].filter(([, d]) => anyTokens(d.tokens));
    // Nothing new: keep the cost baseline, so a late status render counts next turn.
    if (models.length === 0) return null;

    // Cost: Claude's own figure (the status line's session total, since the
    // last turn end) when the session has one, else list-price estimate.
    let basis: CostBasis;
    let costs: Array<number | undefined>;
    if (s.status_cost != null) {
      basis = s.subscription ? 'subscription' : 'billed';
      const turnCost = roundUsd(Math.max(0, s.status_cost - (s.cost_at_turn ?? 0)));
      s.cost_at_turn = s.status_cost;
      costs = this.apportion(turnCost, models);
    } else {
      basis = 'estimate';
      costs = models.map(([model, d]) => estimateCost(model, d.tokens, this.prices(), d.split) ?? undefined);
    }
    const by_model: UsageEntry[] = models.map(([model, d], i) => ({
      provider: 'anthropic',
      model,
      tokens: cleanTokens(d.tokens),
      ...(costs[i] !== undefined ? { cost_usd: costs[i] } : {}),
      cost_basis: basis,
    }));
    this.addToTotal(s, by_model);
    return { provider: 'anthropic', by_model };
  }

  /** Split a turn's cost across its models by their list-price share (else all on the largest). */
  private apportion(cost: number, models: Array<[string, { tokens: UsageTokens; split: CacheSplit }]>): Array<number | undefined> {
    if (models.length === 0) return [];
    if (models.length === 1) return [cost];
    const est = models.map(([m, d]) => estimateCost(m, d.tokens, this.prices(), d.split));
    const sum = est.reduce<number>((a, e) => a + (e ?? 0), 0);
    if (est.every((e) => e != null) && sum > 0) return est.map((e) => roundUsd((cost * (e as number)) / sum));
    let big = 0;
    models.forEach(([, d], i) => {
      if (shownTokens(d.tokens) > shownTokens(models[big][1].tokens)) big = i;
    });
    return models.map((_, i) => (i === big ? cost : undefined));
  }

  /** Usage a provider reported itself (Pi's Stop post, §3.3). Null when empty. */
  reportedTurn(sessionId: string, raw: unknown, provider: UsageProvider, basis: CostBasis, now: number = Date.now()): TurnUsage | null {
    const entries = normalizeReportedUsage(raw, provider, basis);
    if (entries.length === 0) return null;
    this.addToTotal(this.state(sessionId, now), entries);
    return { provider, by_model: entries };
  }

  private addToTotal(s: SessionState, entries: UsageEntry[]): void {
    const t = s.total;
    for (const e of entries) {
      addTokens(t.tokens, e.tokens);
      let m = t.by_model.get(e.model);
      if (!m) {
        m = { tokens: {}, cost_usd: 0 };
        t.by_model.set(e.model, m);
      }
      addTokens(m.tokens, e.tokens);
      if (e.cost_usd !== undefined && e.cost_basis !== 'subscription') {
        t.cost_usd += e.cost_usd;
        m.cost_usd += e.cost_usd;
      }
      // Subscription wins: once a session is on one, its numbers are tokens.
      if (t.basis !== 'subscription') t.basis = e.cost_basis;
    }
  }

  /** A session's running usage (§6.2), or null before its first counted turn. */
  agentUsage(sessionId: string): AgentUsage | null {
    const s = this.sessions.get(sessionId);
    if (!s || !s.total.basis) return null;
    const t = s.total;
    const money = t.basis !== 'subscription' && t.basis !== 'local';
    const out: AgentUsage = {
      tokens: { ...t.tokens },
      shown_tokens: shownTokens(t.tokens),
      cost_basis: t.basis as CostBasis,
      ...(money && t.cost_usd > 0 ? { cost_usd: roundUsd(t.cost_usd) } : {}),
    };
    if (t.by_model.size > 1) {
      out.by_model = [...t.by_model.entries()].map(([model, m]) => ({
        model,
        tokens: { ...m.tokens },
        ...(money && m.cost_usd > 0 ? { cost_usd: roundUsd(m.cost_usd) } : {}),
      }));
    }
    return out;
  }

  /** Drop sessions `keep` rejects and not seen for `maxAgeMs`. */
  prune(keep: (sessionId: string) => boolean, now: number, maxAgeMs: number): void {
    for (const [id, s] of this.sessions) if (!keep(id) && now - s.last_seen > maxAgeMs) this.sessions.delete(id);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function cleanTokens(t: UsageTokens): UsageTokens {
  const out: UsageTokens = {};
  for (const k of TOKEN_KEYS) if (t[k] !== undefined) out[k] = Math.max(0, t[k] as number);
  return out;
}

const PROVIDERS = new Set<UsageProvider>(['anthropic', 'google', 'ollama', 'openai', 'other']);
const REPORTED_MAX = 20;

function reportedProvider(v: unknown, fallback: UsageProvider): UsageProvider {
  if (typeof v !== 'string') return fallback;
  const p = v.toLowerCase();
  if (PROVIDERS.has(p as UsageProvider)) return p as UsageProvider;
  if (p === 'gemini' || p.startsWith('google')) return 'google';
  if (p.startsWith('openai')) return 'openai';
  return 'other';
}

/**
 * A reported `usage` object (Pi): `{ by_model: [{ provider?, model, tokens, cost_usd? }] }`
 * or a single entry. Numbers only; anything malformed is dropped.
 */
export function normalizeReportedUsage(raw: unknown, provider: UsageProvider, basis: CostBasis): UsageEntry[] {
  const list = isRecord(raw) && Array.isArray(raw.by_model) ? raw.by_model : isRecord(raw) ? [raw] : [];
  const out: UsageEntry[] = [];
  for (const e of list.slice(0, REPORTED_MAX)) {
    if (!isRecord(e) || !isRecord(e.tokens)) continue;
    const model = typeof e.model === 'string' && e.model.trim() ? e.model.trim().slice(0, 128) : 'unknown';
    const tokens: UsageTokens = {};
    for (const k of TOKEN_KEYS) {
      const n = num(e.tokens[k]);
      if (n != null && n >= 0) tokens[k] = Math.round(n);
    }
    if (!anyTokens(tokens)) continue;
    const cost = num(e.cost_usd);
    const duration = num(e.duration_ms);
    out.push({
      provider: reportedProvider(e.provider, provider),
      model,
      tokens,
      ...(cost != null && cost >= 0 && basis !== 'local' ? { cost_usd: roundUsd(cost) } : {}),
      cost_basis: basis,
      ...(duration != null && duration >= 0 ? { duration_ms: Math.round(duration) } : {}),
    });
  }
  return out;
}
