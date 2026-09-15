/**
 * Config loader - deep-merges Lee's three config.yaml locations.
 *
 * Precedence (later wins, per key): ~/.config/lee/config.yaml
 * < ~/.lee/config.yaml < <workspace>/.lee/config.yaml
 *
 * Objects are merged recursively; arrays and scalars are replaced wholesale
 * (not concatenated) by whichever source defines them last.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { app } from 'electron';

export interface MergedConfigResult {
  config: any;
  /** Paths of the source files that were actually found, lowest to highest precedence. */
  sources: string[];
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `overlay` onto `base`. Objects merge key-by-key recursively;
 * arrays and scalars in `overlay` replace whatever is in `base`.
 */
export function deepMergeConfig(base: any, overlay: any): any {
  if (!isPlainObject(base)) return overlay;
  if (!isPlainObject(overlay)) return overlay;

  const result: Record<string, any> = { ...base };
  for (const key of Object.keys(overlay)) {
    const baseVal = base[key];
    const overlayVal = overlay[key];
    if (isPlainObject(baseVal) && isPlainObject(overlayVal)) {
      result[key] = deepMergeConfig(baseVal, overlayVal);
    } else {
      result[key] = overlayVal;
    }
  }
  return result;
}

async function readYamlConfig(configPath: string): Promise<any | null> {
  try {
    const content = await fs.promises.readFile(configPath, 'utf-8');
    const parsed = yaml.load(content) as any;
    return parsed || {};
  } catch {
    // Missing or unparseable file: it simply doesn't contribute to the
    // merge. (A syntax error in a config the user is editing surfaces
    // through the config editor's own save path.)
    return null;
  }
}

/**
 * Get the three candidate config paths, in ascending precedence order
 * (lowest precedence first).
 */
export function getConfigPaths(workspace: string): string[] {
  return [
    path.join(app.getPath('home'), '.config', 'lee', 'config.yaml'),
    path.join(app.getPath('home'), '.lee', 'config.yaml'),
    path.join(workspace, '.lee', 'config.yaml'),
  ];
}

/**
 * Load and deep-merge all three config.yaml locations for a workspace.
 * Later entries in `getConfigPaths` win per-key over earlier ones.
 */
export async function loadMergedConfig(workspace: string): Promise<MergedConfigResult> {
  const candidatePaths = getConfigPaths(workspace);

  let merged: any = {};
  const sources: string[] = [];

  for (const configPath of candidatePaths) {
    const parsed = await readYamlConfig(configPath);
    if (parsed !== null) {
      merged = deepMergeConfig(merged, parsed);
      sources.push(configPath);
    }
  }

  return { config: merged, sources };
}

/** Per-top-level-key provenance alongside the merged config. */
export interface ConfigProvenanceResult extends MergedConfigResult {
  /**
   * Top-level key -> absolute path of the highest-precedence file that set it.
   * A key merged from several files reports the last (winning) one; the
   * config editor uses it for the "from: ~/.lee/config.yaml" hints.
   */
  keySources: Record<string, string>;
  /** The workspace and global file paths, whether or not they exist. */
  paths: { workspace: string; global: string; xdg: string };
}

/**
 * Same merge as `loadMergedConfig`, plus which file each top-level key
 * ultimately came from. Cheap: it's the same single pass over three files.
 */
export async function loadConfigWithProvenance(workspace: string): Promise<ConfigProvenanceResult> {
  const candidatePaths = getConfigPaths(workspace);

  let merged: any = {};
  const sources: string[] = [];
  const keySources: Record<string, string> = {};

  for (const configPath of candidatePaths) {
    const parsed = await readYamlConfig(configPath);
    if (parsed === null) continue;
    merged = deepMergeConfig(merged, parsed);
    sources.push(configPath);
    if (isPlainObject(parsed)) {
      for (const key of Object.keys(parsed)) {
        keySources[key] = configPath;
      }
    }
  }

  return {
    config: merged,
    sources,
    keySources,
    paths: {
      xdg: candidatePaths[0],
      global: candidatePaths[1],
      workspace: candidatePaths[2],
    },
  };
}
