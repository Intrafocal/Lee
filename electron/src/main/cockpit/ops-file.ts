/**
 * Operation sources on disk (package B): `<ws>/.lee/operations.yaml` (written
 * by Lee when you confirm; hand edits and unknown fields are kept), plus the
 * `operations:` and `services:` read from config.yaml. Lee never writes
 * config.yaml.
 *
 * Contract: docs/plans/2026-09-25-copilot-v2-contracts.md §7.1, §7.2.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { OperationDef } from '../../shared/cockpit';
import { mapServices, parseOperationsList } from './ops-config';
import type { MergedOperation } from './ops-config';

const HEADER =
  '# Written by Lee when you confirm operations in the Cockpit. Hand edits are kept.\n' +
  '# Operations in .lee/config.yaml win on name clashes.\n';

/** Keys of OperationDef in the order they're written. */
const DEF_KEYS: Array<keyof OperationDef> = [
  'name', 'kind', 'command', 'cwd', 'params', 'confirm', 'produces', 'idle_ok', 'allowed_tools',
  'env', 'ports', 'health', 'notify_on_done', 'match', 'description', 'timeout_min',
];

type RawDoc = Record<string, unknown> & { operations: Array<Record<string, unknown>>; dismissed_suggestions: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function operationsFilePath(workspace: string): string {
  return path.join(workspace, '.lee', 'operations.yaml');
}

function loadYaml(file: string): unknown {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readRaw(workspace: string): RawDoc {
  const doc = loadYaml(operationsFilePath(workspace));
  const raw: RawDoc = isPlainObject(doc)
    ? ({ ...doc } as RawDoc)
    : ({ version: 1, operations: [], dismissed_suggestions: [] } as RawDoc);
  if (!Array.isArray(raw.operations)) raw.operations = [];
  raw.operations = raw.operations.filter(isPlainObject);
  if (!Array.isArray(raw.dismissed_suggestions)) raw.dismissed_suggestions = [];
  raw.dismissed_suggestions = raw.dismissed_suggestions.filter((s): s is string => typeof s === 'string');
  if (raw.version == null) raw.version = 1;
  return raw;
}

function writeRaw(workspace: string, raw: RawDoc): void {
  const file = operationsFilePath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { version, operations, dismissed_suggestions, ...rest } = raw;
  const ordered = { version: version ?? 1, operations, dismissed_suggestions, ...rest };
  const body = yaml.dump(ordered, { lineWidth: 160, noRefs: true, sortKeys: false });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, HEADER + body, 'utf8');
  fs.renameSync(tmp, file);
}

export interface OperationsFile {
  defs: OperationDef[];
  dismissed: string[];
  warnings: string[];
}

export function readOperationsFile(workspace: string): OperationsFile {
  const raw = readRaw(workspace);
  const { defs, warnings } = parseOperationsList(raw.operations);
  return { defs, dismissed: raw.dismissed_suggestions, warnings };
}

function defToRaw(def: OperationDef, base: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of DEF_KEYS) {
    const v = def[k];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    if (v === false && k !== 'confirm' && k !== 'notify_on_done') continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(base)) {
    if (!(DEF_KEYS as string[]).includes(k)) out[k] = v;
  }
  return out;
}

/** Append confirmed suggestions (skipping names already in the file). Returns the names added. */
export function appendOperations(
  workspace: string,
  entries: Array<{ def: OperationDef; detected_from: string | null }>,
  now: Date = new Date(),
): string[] {
  const raw = readRaw(workspace);
  const have = new Set(raw.operations.map((o) => o.name));
  const added: string[] = [];
  for (const e of entries) {
    if (have.has(e.def.name)) continue;
    have.add(e.def.name);
    raw.operations.push({
      ...defToRaw(e.def),
      ...(e.detected_from ? { detected_from: e.detected_from } : {}),
      confirmed_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    added.push(e.def.name);
  }
  raw.dismissed_suggestions = raw.dismissed_suggestions.filter((n) => !added.includes(n));
  if (added.length) writeRaw(workspace, raw);
  return added;
}

/** Add or replace one operation (the Edit form). Unknown hand-added fields of an existing entry are kept. */
export function upsertOperation(workspace: string, def: OperationDef, now: Date = new Date()): void {
  const raw = readRaw(workspace);
  const i = raw.operations.findIndex((o) => o.name === def.name);
  if (i >= 0) raw.operations[i] = defToRaw(def, raw.operations[i]);
  else raw.operations.push({ ...defToRaw(def), confirmed_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z') });
  writeRaw(workspace, raw);
}

/** Set a boolean flag on an operation defined in operations.yaml. False when it isn't there. */
export function setOperationFlag(workspace: string, name: string, flag: 'notify_on_done' | 'confirm', value: boolean): boolean {
  const raw = readRaw(workspace);
  const entry = raw.operations.find((o) => o.name === name);
  if (!entry) return false;
  entry[flag] = value;
  writeRaw(workspace, raw);
  return true;
}

export function addDismissedSuggestion(workspace: string, name: string): void {
  const raw = readRaw(workspace);
  if (raw.dismissed_suggestions.includes(name)) return;
  raw.dismissed_suggestions.push(name);
  writeRaw(workspace, raw);
}

// ---------------------------------------------------------------------------
// config.yaml (read only)
// ---------------------------------------------------------------------------

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  return out;
}

export interface ConfigOperations {
  /** `operations:` from <ws>/.lee/config.yaml only (per workspace). */
  config: OperationDef[];
  /** Services from the merged config (machine-wide files, then the workspace's). */
  services: MergedOperation[];
  warnings: string[];
}

export function configFilePaths(workspace: string, home: string = os.homedir()): string[] {
  return [
    path.join(home, '.config', 'lee', 'config.yaml'),
    path.join(home, '.lee', 'config.yaml'),
    path.join(workspace, '.lee', 'config.yaml'),
  ];
}

export function readConfigOperations(workspace: string, home: string = os.homedir()): ConfigOperations {
  const files = configFilePaths(workspace, home);
  let merged: unknown = {};
  let wsDoc: unknown;
  for (const f of files) {
    const doc = loadYaml(f);
    if (!isPlainObject(doc)) continue;
    merged = deepMerge(merged, doc);
    if (f === files[2]) wsDoc = doc;
  }
  const { defs, warnings } = parseOperationsList(isPlainObject(wsDoc) ? wsDoc.operations : undefined);
  return { config: defs, services: mapServices(merged), warnings };
}

/** mtimes of every file operations are read from, for cache invalidation. */
export function sourcesStamp(workspace: string, home: string = os.homedir()): string {
  return [...configFilePaths(workspace, home), operationsFilePath(workspace)]
    .map((f) => {
      try {
        return String(fs.statSync(f).mtimeMs);
      } catch {
        return '0';
      }
    })
    .join('|');
}
