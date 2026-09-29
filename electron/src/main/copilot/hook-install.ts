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
import { claudePluginDir, installClaudePlugin } from './claude-plugin';

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

/**
 * docs/15-Usage.md §3.1: Claude Code's status line. POSTs the render's JSON to
 * Lee in the background (never blocks the render, exits fast when Lee is
 * down), then prints the user's own status line when they have one (its
 * command is copied from ~/.claude/settings.json at install), else a small
 * default: \`model · 5h 42% · 7d 18%\`.
 */
export const STATUSLINE_SCRIPT = `#!/bin/sh
# Lee relay for Claude Code's status line. Written by Lee at startup; edits are overwritten.
IN=$(cat)
DIR="$HOME/.lee/hooks"
HDR="$DIR/auth-header"
BASE="\${LEE_API_URL:-http://127.0.0.1:9001}"
PORT="\${BASE#http://127.0.0.1:}"
case "$PORT" in ''|*[!0-9]*) BASE="http://127.0.0.1:9001" ;; esac
if [ -r "$HDR" ]; then
  printf '%s' "$IN" | curl -fsS --max-time 1 -X POST "$BASE/agent/status" \\
    -H @"$HDR" \\
    -H "Content-Type: application/json" \\
    -H "X-Lee-Pty-Id: \${LEE_PTY_ID:-}" \\
    -H "X-Lee-Window-Id: \${LEE_WINDOW_ID:-}" \\
    --data-binary @- >/dev/null 2>&1 &
fi
USER_LINE="$DIR/claude-statusline-user.sh"
if [ -s "$USER_LINE" ]; then
  printf '%s' "$IN" | /bin/sh "$USER_LINE"
  exit $?
fi
FLAT=$(printf '%s' "$IN" | tr -d '\\n')
MODEL=$(printf '%s' "$FLAT" | sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
pct() {
  V=$(printf '%s' "$FLAT" | sed -n "s/.*\\"$1\\"[[:space:]]*:[[:space:]]*{[^}]*\\"used_percentage\\"[[:space:]]*:[[:space:]]*\\([0-9.]*\\).*/\\1/p")
  [ -n "$V" ] && printf '%.0f' "$V" 2>/dev/null
}
H5=$(pct five_hour)
D7=$(pct seven_day)
LINE="\${MODEL:-Claude}"
[ -n "$H5" ] && LINE="$LINE · 5h $H5%"
[ -n "$D7" ] && LINE="$LINE · 7d $D7%"
printf '%s\\n' "$LINE"
exit 0
`;

const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

export interface HookPaths {
  dir: string;
  script: string;
  statusline: string;
  /** The user's own statusLine command, copied from ~/.claude/settings.json (absent when they have none). */
  userStatusline: string;
  userClaudeSettings: string;
  authHeader: string;
  settings: string;
  tokenFile: string;
}

export function hookPaths(home: string = os.homedir()): HookPaths {
  const dir = path.join(home, '.lee', 'hooks');
  return {
    dir,
    script: path.join(dir, 'claude-hook.sh'),
    statusline: path.join(dir, 'claude-statusline.sh'),
    userStatusline: path.join(dir, 'claude-statusline-user.sh'),
    userClaudeSettings: path.join(home, '.claude', 'settings.json'),
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

/** The user's own status line from ~/.claude/settings.json: its command and padding, or null. */
export function readUserStatusLine(file: string): { command: string; padding?: number } | null {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sl = doc && typeof doc === 'object' ? doc.statusLine : null;
    if (!sl || typeof sl !== 'object' || typeof sl.command !== 'string' || !sl.command.trim()) return null;
    if (sl.type !== undefined && sl.type !== 'command') return null;
    // Lee's own relay, if a user copied it in, would call itself.
    if (sl.command.includes('claude-statusline.sh')) return null;
    return { command: sl.command, ...(typeof sl.padding === 'number' ? { padding: sl.padding } : {}) };
  } catch {
    return null;
  }
}

export function buildClaudeSettings(
  scriptPath: string,
  permissionRequest: boolean,
  statusline?: { script: string; padding?: number },
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    if (event === 'PermissionRequest' && !permissionRequest) continue;
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command: `/bin/sh ${shQuote(scriptPath)} ${event}`, timeout: 5 }],
    };
    hooks[event] = [MATCHER_EVENTS.has(event) ? { matcher: '*', ...entry } : entry];
  }
  if (!statusline) return { hooks };
  return {
    hooks,
    statusLine: {
      type: 'command',
      command: `/bin/sh ${shQuote(statusline.script)}`,
      ...(statusline.padding !== undefined ? { padding: statusline.padding } : {}),
    },
  };
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
  /** docs/15-Usage.md §3.1 status line relay (default on with hooks). */
  statusLine?: boolean;
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
  const statusLine = enabled && (opts.statusLine ?? true);
  const user = statusLine ? readUserStatusLine(paths.userClaudeSettings) : null;
  if (statusLine) {
    writeIfChanged(paths.statusline, STATUSLINE_SCRIPT, 0o755);
    if (user) writeIfChanged(paths.userStatusline, `# Your statusLine command from ~/.claude/settings.json, copied by Lee at startup.\n${user.command}\n`, 0o700);
    else fs.rmSync(paths.userStatusline, { force: true });
  } else {
    fs.rmSync(paths.statusline, { force: true });
    fs.rmSync(paths.userStatusline, { force: true });
  }
  if (enabled) {
    const sl = statusLine ? { script: paths.statusline, ...(user?.padding !== undefined ? { padding: user.padding } : {}) } : undefined;
    const settings = JSON.stringify(buildClaudeSettings(paths.script, permissionRequest, sl), null, 2) + '\n';
    writeIfChanged(paths.settings, settings, 0o644);
  } else {
    fs.rmSync(paths.settings, { force: true });
  }
  // Lee's skills (the Desk and the Drawer) ride along with the hooks.
  try {
    installClaudePlugin(enabled, opts.home);
  } catch {
    // Never block the hooks on the skills.
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
 * already passes --settings or the settings file is absent; and
 * `--plugin-dir <Lee's plugin>` (the Desk and Drawer skills) unless it's
 * already there or not installed. Never throws.
 */
export function withClaudeHooks(cmd: string, args: string[]): string[] {
  try {
    if (!cmd || !isClaude(cmd)) return args;
    const end = args.indexOf('--');
    const opts = end >= 0 ? args.slice(0, end) : args;
    const pre: string[] = [];
    const settings = activePaths.settings;
    if (!opts.some((a) => a === '--settings' || a.startsWith('--settings=')) && fs.existsSync(settings)) pre.push('--settings', settings);
    const plugin = claudePluginDir();
    if (plugin && !opts.some((a, i) => (a === '--plugin-dir' && opts[i + 1] === plugin) || a === `--plugin-dir=${plugin}`)) pre.push('--plugin-dir', plugin);
    return pre.length ? [...pre, ...args] : args;
  } catch {
    return args;
  }
}
