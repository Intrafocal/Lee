/**
 * Machine-wide Copilot settings: the `copilot:` block of ~/.config/lee/config.yaml
 * and ~/.lee/config.yaml (later wins), deep-merged over COPILOT_DEFAULTS.
 * Workspace .lee/config.yaml files are NOT consulted: the queue, presence and
 * event log are machine-wide.
 *
 * Source of truth: docs/plans/2026-09-25-copilot-v0-v1-contracts.md (Appendix C),
 * plus the `deep:` block from docs/plans/2026-09-26-deep-d1-contracts.md §2.2.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface CopilotConfig {
  enabled: boolean;
  presence: {
    at_machine_idle_seconds: number;
    lee_active_seconds: number;
    engaged_seconds: number;
  };
  attention: {
    waiting_limit_minutes: number;
    /** "HH:MM-HH:MM" local time, may wrap midnight; null = none. */
    quiet_hours: string | null;
    review_expiry_hours: number;
  };
  focus: {
    infer_enabled: boolean;
    infer_window_minutes: number;
    infer_min_active_minutes: number;
    switch_minutes: number;
    manual_end_away_minutes: number;
    inferred_end_away_minutes: number;
  };
  hooks: {
    claude: boolean;
    permission_request: boolean;
    lee_status_hint: boolean;
  };
  event_log: {
    retention_days: number;
    max_file_mb: number;
  };
  away: {
    return_min_away_minutes: number;
  };
  /** Deep D1 §2.2. */
  deep: {
    /** A Deep session ends (reason 'away') after this long not at the machine. */
    idle_end_minutes: number;
  };
}

export const COPILOT_DEFAULTS: CopilotConfig = {
  enabled: true,
  presence: {
    at_machine_idle_seconds: 300,
    lee_active_seconds: 120,
    engaged_seconds: 300,
  },
  attention: {
    waiting_limit_minutes: 20,
    quiet_hours: null,
    review_expiry_hours: 12,
  },
  focus: {
    infer_enabled: true,
    infer_window_minutes: 10,
    infer_min_active_minutes: 7,
    switch_minutes: 3,
    manual_end_away_minutes: 15,
    inferred_end_away_minutes: 5,
  },
  hooks: {
    claude: true,
    permission_request: true,
    lee_status_hint: true,
  },
  event_log: {
    retention_days: 180,
    max_file_mb: 50,
  },
  away: {
    return_min_away_minutes: 30,
  },
  deep: {
    idle_end_minutes: 45,
  },
};

const CACHE_MS = 30_000;
let cached: { at: number; value: CopilotConfig } | null = null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (!(k in out)) continue; // unknown keys are ignored
    const cur = out[k];
    if (isPlainObject(cur)) out[k] = merge(cur, v);
    else if (v === null || typeof v === typeof cur || cur === null) out[k] = v;
  }
  return out as T;
}

function readBlock(file: string): unknown {
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    return isPlainObject(doc) ? doc.copilot : undefined;
  } catch {
    return undefined;
  }
}

/** Current machine-wide copilot config (cached for 30 s). */
export function getCopilotConfig(): CopilotConfig {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const home = os.homedir();
  let value: CopilotConfig = COPILOT_DEFAULTS;
  for (const file of [
    path.join(home, '.config', 'lee', 'config.yaml'),
    path.join(home, '.lee', 'config.yaml'),
  ]) {
    const block = readBlock(file);
    if (block !== undefined) value = merge(value, block);
  }
  cached = { at: now, value };
  return value;
}

/** Drop the cache (e.g. after the global config is saved). */
export function invalidateCopilotConfig(): void {
  cached = null;
}

/** True if `date` falls inside quiet hours ("22:00-08:00", local time). */
export function inQuietHours(date: Date = new Date(), cfg: CopilotConfig = getCopilotConfig()): boolean {
  const spec = cfg.attention.quiet_hours;
  if (!spec) return false;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const cur = date.getHours() * 60 + date.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
