/**
 * The user's first name, for Home's greeting ("What's on your mind, Ben?").
 *
 * Order: `app.user_name` in the merged config; else the first word of the
 * macOS full name (`id -F`, read once and cached); else null. Other
 * platforms get null without a config entry: a login name isn't a first name.
 *
 * Contract: docs/plans/2026-09-27-cockpit-design-contracts.md §7.2.
 */

import { execFile } from 'child_process';

const ID_TIMEOUT_MS = 2000;

/** The first whitespace-separated word, or null for an empty or non-string value. */
export function firstWord(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const word = name.trim().split(/\s+/)[0];
  return word || null;
}

/** `app.user_name` from a merged config, trimmed; null when unset or blank. */
export function configUserName(config: unknown): string | null {
  const app = (config as { app?: { user_name?: unknown } } | null | undefined)?.app;
  const v = app?.user_name;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The macOS account's full name (`id -F`); null elsewhere or on any failure. */
export function readMacFullName(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('id', ['-F'], { timeout: ID_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

export class UserNameResolver {
  private fullName: Promise<string | null> | null = null;

  constructor(private readFullName: () => Promise<string | null> = readMacFullName) {}

  /** The name for `config` (the merged config of the asking window's workspace). */
  async resolve(config: unknown): Promise<string | null> {
    const configured = configUserName(config);
    if (configured) return configured;
    if (!this.fullName) this.fullName = this.readFullName().catch(() => null);
    return firstWord(await this.fullName);
  }
}
