/**
 * Operations config (package B, pure): parse and validate `operations:`,
 * `<ws>/.lee/operations.yaml` and the read-only `services:` mapping, and merge
 * them by name (config.yaml, then operations.yaml, then services).
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.1.
 */

import type { OperationDef, OperationKind, OperationProduces, OperationSource } from '../../shared/cockpit';

export const OP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface MergedOperation {
  def: OperationDef;
  source: OperationSource;
  service: { name: string; detect: string | null } | null;
  /** Service status rows can't be run. */
  runnable: boolean;
}

export interface ParseResult {
  defs: OperationDef[];
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

/** True when `url` is an http(s) URL on 127.0.0.1 or localhost (C1). */
export function isLocalHealthUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

/** A JS regex source with at least one capture group, or null. */
export function compileProducesRegex(src: string): RegExp | null {
  try {
    const re = new RegExp(src, 'g');
    const groups = new RegExp(`${src}|`).exec('');
    if (!groups || groups.length < 2) return null;
    return re;
  } catch {
    return null;
  }
}

/** `{name}` placeholders in a command, in order, without duplicates. */
export function commandParams(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function validateProduces(raw: unknown, opName: string, warnings: string[]): OperationProduces[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: OperationProduces[] = [];
  for (const p of list) {
    if (!isPlainObject(p) || typeof p.metric !== 'string' || !p.metric.trim() || typeof p.parse !== 'string') {
      warnings.push(`operation ${opName}: invalid produces entry skipped`);
      continue;
    }
    if (!compileProducesRegex(p.parse)) {
      warnings.push(`operation ${opName}: produces.parse for ${p.metric} is not a regex with a capture group; skipped`);
      continue;
    }
    out.push({ metric: p.metric.trim(), parse: p.parse, unit: typeof p.unit === 'string' ? p.unit : null });
  }
  return out;
}

/** Validate one raw operation. Returns null (with a warning) when it can't be used. */
export function validateOperation(raw: unknown, warnings: string[]): OperationDef | null {
  if (!isPlainObject(raw)) {
    warnings.push('operation entry is not a mapping; skipped');
    return null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!OP_NAME_RE.test(name)) {
    warnings.push(`operation name ${JSON.stringify(raw.name)} is invalid; skipped`);
    return null;
  }
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command || /[\r\n]/.test(command)) {
    warnings.push(`operation ${name}: command must be one non-empty line; skipped`);
    return null;
  }
  const kind: OperationKind = raw.kind === 'long-running' ? 'long-running' : 'oneshot';
  if (raw.kind != null && raw.kind !== 'oneshot' && raw.kind !== 'long-running') {
    warnings.push(`operation ${name}: unknown kind ${JSON.stringify(raw.kind)}, using oneshot`);
  }
  const def: OperationDef = { name, kind, command };
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) def.cwd = raw.cwd.trim();
  const params = [...strList(raw.params).filter((p) => PARAM_RE.test(p))];
  for (const p of commandParams(command)) if (!params.includes(p)) params.push(p);
  if (params.length) def.params = params;
  if (raw.confirm === true) def.confirm = true;
  const produces = validateProduces(raw.produces, name, warnings);
  if (produces.length) def.produces = produces;
  if (raw.idle_ok === true) def.idle_ok = true;
  const allowed = strList(raw.allowed_tools);
  if (allowed.length) def.allowed_tools = allowed;
  if (isPlainObject(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) env[k] = String(v);
    }
    if (Object.keys(env).length) def.env = env;
  }
  if (Array.isArray(raw.ports)) {
    const ports = raw.ports.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (ports.length) def.ports = ports;
  }
  if (raw.health != null) {
    if (isLocalHealthUrl(raw.health)) def.health = raw.health;
    else warnings.push(`operation ${name}: health must be a 127.0.0.1/localhost URL; ignored`);
  }
  if (raw.notify_on_done === true) def.notify_on_done = true;
  const match = strList(raw.match);
  if (match.length) def.match = match;
  if (typeof raw.description === 'string' && raw.description.trim()) def.description = raw.description.trim();
  const timeout = Number(raw.timeout_min);
  if (raw.timeout_min != null && Number.isFinite(timeout) && timeout > 0) def.timeout_min = timeout;
  return def;
}

export function parseOperationsList(raw: unknown): ParseResult {
  const warnings: string[] = [];
  const defs: OperationDef[] = [];
  if (raw == null) return { defs, warnings };
  if (!Array.isArray(raw)) return { defs, warnings: ['operations: must be a list; ignored'] };
  const seen = new Set<string>();
  for (const item of raw) {
    const def = validateOperation(item, warnings);
    if (!def) continue;
    if (seen.has(def.name)) {
      warnings.push(`operation ${def.name} defined twice; the first wins`);
      continue;
    }
    seen.add(def.name);
    defs.push(def);
  }
  return { defs, warnings };
}

function slug(name: string): string {
  const s = name.trim().replace(/[^A-Za-z0-9:._/-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '');
  return s.slice(0, 48) || 'service';
}

/**
 * Services (`services:` and `environments.<active>.services`) as read-only
 * status rows `service:<name>` plus one-shot operations `<name>/<action>`.
 * Service names are slugged to fit the operation-name rule.
 */
export function mapServices(config: unknown): MergedOperation[] {
  if (!isPlainObject(config)) return [];
  const groups: Array<{ services: unknown; confirm: boolean }> = [];
  if (Array.isArray(config.services)) groups.push({ services: config.services, confirm: false });
  if (isPlainObject(config.environments)) {
    const envs = config.environments;
    const names = Object.keys(envs);
    const active = typeof config.active_environment === 'string' && config.active_environment in envs ? config.active_environment : names[0];
    const env = active ? envs[active] : undefined;
    if (isPlainObject(env) && Array.isArray(env.services)) groups.push({ services: env.services, confirm: env.confirm_actions === true });
  }
  const out: MergedOperation[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const svc of g.services as unknown[]) {
      if (!isPlainObject(svc) || typeof svc.name !== 'string' || !svc.name.trim()) continue;
      const base = slug(svc.name);
      const rowName = `service:${base}`;
      if (seen.has(rowName)) continue;
      seen.add(rowName);
      const cwd = typeof svc.cwd === 'string' && svc.cwd.trim() ? svc.cwd.trim() : null;
      const actions = Array.isArray(svc.actions) ? svc.actions.filter(isPlainObject) : [];
      const firstCmd = actions.map((a) => (typeof a.command === 'string' ? a.command.trim() : '')).find((c) => c && !/[\r\n]/.test(c)) ?? '';
      const detect = typeof svc.detect === 'string' ? svc.detect : 'port';
      const health = Array.isArray(svc.health_checks) ? svc.health_checks.find(isLocalHealthUrl) ?? null : null;
      const ports = Array.isArray(svc.ports) ? svc.ports.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536) : [];
      const row: OperationDef = { name: rowName, kind: 'long-running', command: firstCmd, cwd, health };
      if (ports.length) row.ports = ports;
      if (typeof svc.description === 'string' && svc.description) row.description = svc.description;
      out.push({ def: row, source: 'service', service: { name: svc.name, detect }, runnable: false });
      for (const a of actions) {
        const an = typeof a.name === 'string' ? slug(a.name) : '';
        const cmd = typeof a.command === 'string' ? a.command.trim() : '';
        const name = `${base}/${an}`;
        if (!an || !cmd || /[\r\n]/.test(cmd) || !OP_NAME_RE.test(name) || seen.has(name)) continue;
        seen.add(name);
        const def: OperationDef = { name, kind: 'oneshot', command: cmd, cwd };
        const params = commandParams(cmd);
        if (params.length) def.params = params;
        if (g.confirm) def.confirm = true;
        out.push({ def, source: 'service', service: { name: svc.name, detect }, runnable: true });
      }
    }
  }
  return out;
}

/** First wins: config.yaml `operations:`, then operations.yaml, then services. */
export function mergeOperations(config: OperationDef[], file: OperationDef[], services: MergedOperation[]): MergedOperation[] {
  const out: MergedOperation[] = [];
  const seen = new Set<string>();
  const add = (m: MergedOperation) => {
    if (seen.has(m.def.name)) return;
    seen.add(m.def.name);
    out.push(m);
  };
  for (const def of config) add({ def, source: 'config', service: null, runnable: true });
  for (const def of file) add({ def, source: 'operations-file', service: null, runnable: true });
  for (const m of services) add(m);
  return out;
}

// ---------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Characters a param value may not carry inside "..." or from callers other than the local user. */
const PARAM_META_RE = /[$`\\"'\r\n\x00-\x1f\x7f;&|<>()!]/;
/** Inside '...' the substituted value ends up bare: only plain words pass. */
const PARAM_BARE_RE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * `{param}` placeholders written inside a quoted region of the command
 * (`"{msg}"`, `'{x}'`), with the quote kind (a `'` occurrence wins). Single-
 * quoting the value there does not quote it: inside "..." the quotes are
 * literal, and inside '...' they close and reopen, leaving the value bare.
 */
export function quotedPlaceholders(command: string): Map<string, '"' | "'"> {
  const out = new Map<string, '"' | "'">();
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== "'" && ch === '\\') {
      i++;
      continue;
    }
    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      continue;
    }
    if (quote !== null && ch === '{') {
      const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(command.slice(i));
      if (m && out.get(m[1]) !== "'") out.set(m[1], quote);
    }
  }
  return out;
}

/**
 * Replace `{param}` with single-quoted values.
 *
 * `invalid` lists params whose value is refused because it could run as
 * shell code: inside '...' anything but a plain word, inside "..." any shell
 * metacharacter, and with `strict` (callers other than the local user:
 * Hester, devices) any shell metacharacter wherever the placeholder is.
 */
export function substituteParams(
  command: string,
  params: string[] | undefined,
  values: Record<string, string> | undefined,
  opts: { strict?: boolean } = {},
): { line: string; missing: string[]; invalid: string[] } {
  const wanted = new Set([...(params ?? []), ...commandParams(command)]);
  const missing = [...wanted].filter((p) => values?.[p] == null || String(values[p]) === '');
  if (missing.length) return { line: command, missing, invalid: [] };
  const quoted = quotedPlaceholders(command);
  const invalid = [...wanted].filter((p) => {
    const v = String(values![p]);
    const q = quoted.get(p);
    if (q === "'") return !PARAM_BARE_RE.test(v);
    return (opts.strict || q === '"') && PARAM_META_RE.test(v);
  });
  if (invalid.length) return { line: command, missing: [], invalid };
  const line = command.replace(PLACEHOLDER_RE, (whole, p: string) => (wanted.has(p) ? shellQuote(String(values![p])) : whole));
  return { line, missing: [], invalid: [] };
}

/** Trimmed, whitespace runs collapsed (same normalisation as the command signature). */
export function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function literal(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.split('?').map(literal).join('.')).join('.*')}$`);
}

/** Does a hand-typed command line belong to this operation (its command with params as `*`, or a `match` glob)? */
export function commandMatchesOperation(def: OperationDef, text: string): boolean {
  const cmd = normalizeCommand(text);
  if (!cmd || !def.command) return false;
  const own = normalizeCommand(def.command).replace(PLACEHOLDER_RE, '\u0000').split('\u0000').map(literal).join('.*');
  if (new RegExp(`^${own}$`).test(cmd)) return true;
  return (def.match ?? []).some((g) => globToRegExp(normalizeCommand(g)).test(cmd));
}

/** Program name: first word after VAR=value assignments and sudo/env/time. */
export function commandArgv0(text: string): string {
  const words = normalizeCommand(text).split(' ');
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ['sudo', 'env', 'time'].includes(words[i]))) i++;
  return words[i] ?? '';
}
