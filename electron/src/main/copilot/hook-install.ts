/**
 * Per-session Claude Code hook install: Lee writes ~/.lee/hooks/ at startup
 * and every Claude it launches gets `--settings <claude-settings.json>`.
 * The project's .claude/ is never touched.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §6.2, §6.3.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCopilotConfig } from './config';
import { HOOK_EVENTS } from './hook-payload';

export const HOOK_SCRIPT = `#!/bin/sh
# Lee relay for Claude Code hooks. Written by Lee at startup; edits are overwritten.
# Usage (from --settings): /bin/sh claude-hook.sh <HookEventName>   (payload on stdin)
EVENT="\${1:-unknown}"
HDR="$HOME/.lee/hooks/auth-header"
# Lee sets LEE_API_URL for its own PTYs. The bearer token only ever goes to
# Lee's loopback API: anything but http://127.0.0.1:<port> falls back to the default.
BASE="\${LEE_API_URL:-http://127.0.0.1:9001}"
PORT="\${BASE#http://127.0.0.1:}"
case "$PORT" in ''|*[!0-9]*) BASE="http://127.0.0.1:9001" ;; esac
URL="$BASE/agent/hook"
if [ ! -r "$HDR" ]; then cat >/dev/null; exit 0; fi
# -f: an error status prints nothing, so an auth or server error body never
# reaches Claude's context through the SessionStart output below.
if RESP=$(curl -fsS --max-time 2 -X POST "$URL" \\
  -H @"$HDR" \\
  -H "Content-Type: application/json" \\
  -H "X-Lee-Hook-Event: $EVENT" \\
  -H "X-Lee-Pty-Id: \${LEE_PTY_ID:-}" \\
  -H "X-Lee-Window-Id: \${LEE_WINDOW_ID:-}" \\
  --data-binary @- 2>/dev/null); then
  if [ "$EVENT" = "SessionStart" ] && [ -n "$RESP" ]; then printf '%s\\n' "$RESP"; fi
fi
exit 0
`;

const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

export interface HookPaths {
  dir: string;
  script: string;
  authHeader: string;
  settings: string;
  tokenFile: string;
}

export function hookPaths(home: string = os.homedir()): HookPaths {
  const dir = path.join(home, '.lee', 'hooks');
  return {
    dir,
    script: path.join(dir, 'claude-hook.sh'),
    authHeader: path.join(dir, 'auth-header'),
    settings: path.join(dir, 'claude-settings.json'),
    tokenFile: path.join(home, '.lee', 'api-token'),
  };
}

let activePaths: HookPaths = hookPaths();

/** Quote a path for sh: single quotes, with embedded ' as '\''. */
export function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeSettings(scriptPath: string, permissionRequest: boolean): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    if (event === 'PermissionRequest' && !permissionRequest) continue;
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command: `/bin/sh ${shQuote(scriptPath)} ${event}`, timeout: 5 }],
    };
    hooks[event] = [MATCHER_EVENTS.has(event) ? { matcher: '*', ...entry } : entry];
  }
  return { hooks };
}

function writeIfChanged(file: string, content: string, mode: number): void {
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== content) fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

/** (Re)write auth-header from the token file. Returns false if there is no token. */
export function writeAuthHeader(paths: HookPaths = activePaths): boolean {
  let token = '';
  try {
    token = fs.readFileSync(paths.tokenFile, 'utf8').trim();
  } catch {
    token = '';
  }
  if (!token) {
    try {
      fs.rmSync(paths.authHeader, { force: true });
    } catch {
      // ignore
    }
    return false;
  }
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeIfChanged(paths.authHeader, `Authorization: Bearer ${token}\n`, 0o600);
  return true;
}

export interface InstallOptions {
  home?: string;
  enabled?: boolean;
  permissionRequest?: boolean;
}

/**
 * Write ~/.lee/hooks/{claude-hook.sh, auth-header, claude-settings.json}.
 * With hooks disabled, the settings file is removed so no flag is injected.
 */
export function installClaudeHooks(opts: InstallOptions = {}): HookPaths {
  const cfg = getCopilotConfig();
  const enabled = opts.enabled ?? (cfg.enabled && cfg.hooks.claude);
  const permissionRequest = opts.permissionRequest ?? cfg.hooks.permission_request;
  const paths = hookPaths(opts.home);
  activePaths = paths;

  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.dir, 0o700);
  writeIfChanged(paths.script, HOOK_SCRIPT, 0o755);
  writeAuthHeader(paths);
  if (enabled) {
    const settings = JSON.stringify(buildClaudeSettings(paths.script, permissionRequest), null, 2) + '\n';
    writeIfChanged(paths.settings, settings, 0o644);
  } else {
    fs.rmSync(paths.settings, { force: true });
  }
  return paths;
}

export function claudeSettingsPath(): string {
  return activePaths.settings;
}

export function isClaude(cmd: string): boolean {
  return path.basename(cmd) === 'claude';
}

/**
 * Prepend `--settings <abs path>` when launching Claude Code, unless the argv
 * already passes --settings or the settings file is absent. Never throws.
 */
export function withClaudeHooks(cmd: string, args: string[]): string[] {
  try {
    if (!cmd || !isClaude(cmd)) return args;
    const end = args.indexOf('--');
    const opts = end >= 0 ? args.slice(0, end) : args;
    if (opts.some((a) => a === '--settings' || a.startsWith('--settings='))) return args;
    const settings = activePaths.settings;
    if (!fs.existsSync(settings)) return args;
    return ['--settings', settings, ...args];
  } catch {
    return args;
  }
}
