/**
 * Guard for `claude --resume <id>`: Claude only writes a session's transcript
 * once the session has had a message, so a tab that was opened but never used
 * has a session id and nothing to resume. Resuming it fails ("No conversation
 * found") and leaves a dead tab. Before spawning, drop the resume when Claude
 * has no transcript for that session under the directory it will run in.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Claude's per-directory project key: every non-alphanumeric character becomes '-'. */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Where Claude keeps a session's transcript for a given working directory. */
export function claudeTranscriptPath(cwd: string, sessionId: string, home: string = os.homedir()): string {
  return path.join(home, '.claude', 'projects', claudeProjectKey(cwd), `${sessionId}.jsonl`);
}

/**
 * `args` without `--resume <id>` when that session has no transcript under
 * `cwd`; otherwise `args` unchanged. `exists` is injectable for tests.
 */
export function dropStaleResume(
  args: readonly string[],
  cwd: string | undefined,
  exists: (p: string) => boolean = fs.existsSync,
  home?: string,
): { args: string[]; dropped: string | null } {
  const i = args.indexOf('--resume');
  const id = i >= 0 ? args[i + 1] : undefined;
  if (i < 0 || !id || !cwd) return { args: [...args], dropped: null };
  if (exists(claudeTranscriptPath(cwd, id, home))) return { args: [...args], dropped: null };
  return { args: [...args.slice(0, i), ...args.slice(i + 2)], dropped: id };
}
