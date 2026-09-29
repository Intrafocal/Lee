/**
 * The toil/repeat-approval fix (contracts §8.4): append permission rules to
 * `permissions.allow` in <ws>/.claude/settings.local.json. Called only after
 * the user clicked a fix whose confirm_text showed the exact rules (C3).
 */

import * as fs from 'fs';
import * as path from 'path';

export function claudeSettingsPath(workspace: string): string {
  return path.join(workspace, '.claude', 'settings.local.json');
}

/** Returns the rules that were added (already-present ones are skipped). */
export async function writeClaudeAllow(workspace: string, rules: string[]): Promise<string[]> {
  const file = claudeSettingsPath(workspace);
  let raw: string | null = null;
  let mode = 0o644;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
    mode = (await fs.promises.stat(file)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let doc: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("settings.local.json isn't valid JSON; not changed");
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.local.json isn't a JSON object; not changed");
    }
    doc = parsed as Record<string, unknown>;
  }
  const perms = typeof doc.permissions === 'object' && doc.permissions !== null && !Array.isArray(doc.permissions)
    ? (doc.permissions as Record<string, unknown>)
    : {};
  const allow = Array.isArray(perms.allow) ? [...perms.allow] : [];
  const added = rules.filter((r, i) => r && !allow.includes(r) && rules.indexOf(r) === i);
  if (added.length === 0 && Array.isArray(perms.allow)) return [];
  doc = { ...doc, permissions: { ...perms, allow: [...allow, ...added] } };

  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
  await fs.promises.chmod(tmp, mode);
  await fs.promises.rename(tmp, file);
  return added;
}
