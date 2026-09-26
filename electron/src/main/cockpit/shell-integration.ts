/**
 * Shell integration for Lee's default login-shell PTYs (contract §5.2).
 *
 * zsh: ZDOTDIR points at ~/.lee/shell/zsh, whose startup files source the
 * user's own files first and restore ZDOTDIR afterwards. bash: --init-file
 * ~/.lee/shell/bash/lee.bashrc, which emulates a login shell. Both install
 * hooks that print only OSC 133/633/7 sequences; the prompt is not touched.
 * Other shells are left alone.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCockpitConfig } from './cockpit-config';

const HEADER = '# Lee shell integration. Written by Lee at startup; edits are overwritten.\n';

/** Point ZDOTDIR at the user's own directory (unset when they had none). */
const ZSH_USER_ZDOTDIR = `if [[ -n "\${LEE_ORIG_ZDOTDIR-}" ]]; then ZDOTDIR="$LEE_ORIG_ZDOTDIR"; else unset ZDOTDIR; fi
`;

/** Remember a ZDOTDIR the user's file set, then point zsh back at Lee's directory. */
const ZSH_BACK_TO_LEE = `if [[ "\${ZDOTDIR-}" != "\${LEE_ORIG_ZDOTDIR-}" ]]; then export LEE_ORIG_ZDOTDIR="\${ZDOTDIR-}"; fi
export ZDOTDIR="$LEE_ZDOTDIR"
`;

function zshSource(file: string): string {
  return `if [[ -r "\${ZDOTDIR:-$HOME}/${file}" ]]; then source "\${ZDOTDIR:-$HOME}/${file}"; fi\n`;
}

export const ZSHENV =
  HEADER +
  `LEE_ZDOTDIR="$ZDOTDIR"\n` +
  `if [[ "\${LEE_ORIG_ZDOTDIR-}" == "$LEE_ZDOTDIR" ]]; then LEE_ORIG_ZDOTDIR=; fi\n` +
  ZSH_USER_ZDOTDIR +
  zshSource('.zshenv') +
  ZSH_BACK_TO_LEE;

export const ZPROFILE = HEADER + ZSH_USER_ZDOTDIR + zshSource('.zprofile') + ZSH_BACK_TO_LEE;

const ZSH_HOOKS = `if [[ -z "\${LEE_SHELL_INTEGRATION-}" ]]; then
  LEE_SHELL_INTEGRATION=1
  __lee_cmd_ran=
  __lee_precmd() {
    local __lee_st=$?
    if [[ -n "$__lee_cmd_ran" ]]; then
      builtin printf '\\033]133;D;%s\\007' "$__lee_st"
      __lee_cmd_ran=
    fi
    builtin printf '\\033]133;A\\007'
    builtin printf '\\033]7;file://%s%s\\007' "$HOST" "$PWD"
    return $__lee_st
  }
  __lee_preexec() {
    emulate -L zsh
    local s="$1" out="" c i
    s=\${s//\\\\/\\\\\\\\}
    s=\${s//;/\\\\x3b}
    if [[ $s == *[[:cntrl:]]* ]]; then
      for (( i = 1; i <= \${#s}; i++ )); do
        c=\${s[i]}
        if [[ $c == [[:cntrl:]] ]]; then out+=$(builtin printf '\\\\x%02x' "'$c"); else out+=$c; fi
      done
      s=$out
    fi
    builtin printf '\\033]633;E;%s\\007' "$s"
    builtin printf '\\033]133;C\\007'
    __lee_cmd_ran=1
  }
  precmd_functions=(__lee_precmd \${precmd_functions[@]})
  preexec_functions=(__lee_preexec \${preexec_functions[@]})
fi
`;

export const ZSHRC =
  HEADER +
  ZSH_USER_ZDOTDIR +
  // macOS /etc/zshrc sets HISTFILE from ZDOTDIR before this file runs.
  `if [[ "\${HISTFILE-}" == "$LEE_ZDOTDIR/.zsh_history" ]]; then HISTFILE="\${ZDOTDIR:-$HOME}/.zsh_history"; fi\n` +
  zshSource('.zshrc') +
  ZSH_HOOKS +
  // ZDOTDIR is now the user's own value again (or whatever their .zshrc set);
  // zsh reads the user's .zlogin itself, and child shells are untouched.
  `unset LEE_ORIG_ZDOTDIR LEE_ZDOTDIR\n`;

/** Only read by non-interactive login shells (interactive ones restored ZDOTDIR in .zshrc). */
export const ZLOGIN = HEADER + ZSH_USER_ZDOTDIR + zshSource('.zlogin') + `unset LEE_ORIG_ZDOTDIR LEE_ZDOTDIR\n`;

export const BASHRC =
  HEADER +
  `# Emulates a login shell: /etc/profile, then the first of ~/.bash_profile, ~/.bash_login, ~/.profile.
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
fi
if [ -z "\${LEE_SHELL_INTEGRATION-}" ]; then
  LEE_SHELL_INTEGRATION=1
  __lee_at_prompt=0
  __lee_cmd_ran=
  __lee_status=0
  __lee_last_hist=
  __lee_user_debug=
  __lee_escape() {
    local s="$1" out="" c i
    s=\${s//\\\\/\\\\\\\\}
    s=\${s//;/\\\\x3b}
    if [[ $s == *[[:cntrl:]]* ]]; then
      for (( i = 0; i < \${#s}; i++ )); do
        c=\${s:i:1}
        if [[ $c == [[:cntrl:]] ]]; then out+=$(builtin printf '\\\\x%02x' "'$c"); else out+=$c; fi
      done
      s=$out
    fi
    builtin printf '%s' "$s"
  }
  __lee_prompt_start() {
    __lee_status=$?
    __lee_at_prompt=0
    if [ -n "$__lee_cmd_ran" ]; then
      builtin printf '\\033]133;D;%s\\007' "$__lee_status"
      __lee_cmd_ran=
    fi
    return $__lee_status
  }
  __lee_prompt_end() {
    local st=$?
    builtin printf '\\033]133;A\\007'
    builtin printf '\\033]7;file://%s%s\\007' "$HOSTNAME" "$PWD"
    __lee_at_prompt=1
    return $st
  }
  __lee_preexec() {
    [ "$__lee_at_prompt" = 1 ] || return 0
    [ -n "\${COMP_LINE-}" ] && return 0
    case "$BASH_COMMAND" in __lee_prompt_start*|__lee_prompt_end*) return 0 ;; esac
    __lee_at_prompt=0
    local hist line=
    hist=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $hist =~ ^[[:space:]]*([0-9]+)[*]?[[:space:]]+(.*)$ ]]; then
      if [ "\${BASH_REMATCH[1]}" != "$__lee_last_hist" ]; then
        __lee_last_hist=\${BASH_REMATCH[1]}
        line=\${BASH_REMATCH[2]}
      fi
    fi
    [ -n "$line" ] || line=$BASH_COMMAND
    builtin printf '\\033]633;E;%s\\007' "$(__lee_escape "$line")"
    builtin printf '\\033]133;C\\007'
    __lee_cmd_ran=1
  }
  __lee_get_debug_trap() { eval "set -- $(trap -p DEBUG)"; __lee_user_debug=\${3-}; }
  __lee_get_debug_trap
  unset -f __lee_get_debug_trap
  trap '__lee_preexec; if [ -n "$__lee_user_debug" ]; then eval "$__lee_user_debug"; fi' DEBUG
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__lee_prompt_start "\${PROMPT_COMMAND[@]}" __lee_prompt_end)
  else
    __lee_pc=\${PROMPT_COMMAND-}
    while [[ $__lee_pc == *[[:space:]\\;] ]]; do __lee_pc=\${__lee_pc%?}; done
    PROMPT_COMMAND="__lee_prompt_start\${__lee_pc:+; $__lee_pc}; __lee_prompt_end"
    unset __lee_pc
  fi
fi
`;

export interface ShellPaths {
  dir: string;
  zshDir: string;
  bashRc: string;
}

export function shellPaths(home: string = os.homedir()): ShellPaths {
  const dir = path.join(home, '.lee', 'shell');
  return { dir, zshDir: path.join(dir, 'zsh'), bashRc: path.join(dir, 'bash', 'lee.bashrc') };
}

let installed: ShellPaths | null = null;

function writeFile(file: string, content: string): void {
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== content) fs.writeFileSync(file, content, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
}

/** Write ~/.lee/shell/** (dir 0700, files 0644). Called at Lee start; overwrites. */
export function installShellIntegration(home: string = os.homedir()): ShellPaths {
  const p = shellPaths(home);
  for (const d of [p.dir, p.zshDir, path.dirname(p.bashRc)]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  writeFile(path.join(p.zshDir, '.zshenv'), ZSHENV);
  writeFile(path.join(p.zshDir, '.zprofile'), ZPROFILE);
  writeFile(path.join(p.zshDir, '.zshrc'), ZSHRC);
  writeFile(path.join(p.zshDir, '.zlogin'), ZLOGIN);
  writeFile(p.bashRc, BASHRC);
  installed = p;
  return p;
}

/** How a PTY was spawned, for tab kind and state detection (keyed by LEE_PTY_ID). */
export interface SpawnInfo {
  default_shell: boolean;
  /** Basename of the shell for a default-shell PTY. */
  shell: string | null;
  integration: 'zsh' | 'bash' | null;
}

const spawns = new Map<number, SpawnInfo>();

export function spawnInfo(ptyId: number): SpawnInfo | null {
  return spawns.get(ptyId) ?? null;
}

export function forgetSpawn(ptyId: number): void {
  spawns.delete(ptyId);
}

let workspaceResolver: (windowId: number | null) => string | null = () => null;

/** tabs-main hands over the window -> workspace lookup (for per-workspace config). */
export function setShellIntegrationWorkspaceResolver(fn: (windowId: number | null) => string | null): void {
  workspaceResolver = fn;
}

function enabledFor(env: Record<string, string>): boolean {
  let ws: string | null = null;
  try {
    const win = env.LEE_WINDOW_ID ? Number(env.LEE_WINDOW_ID) : null;
    ws = workspaceResolver(Number.isInteger(win) ? win : null);
  } catch {
    ws = null;
  }
  return getCockpitConfig(ws).cockpit.shell_integration;
}

/**
 * Called once from PTYManager.spawn(). For Lee's default login shell (zsh or
 * bash), sets up the integration: mutates `env`, returns the args. Never
 * throws; anything unexpected leaves the spawn unchanged.
 */
export function withShellIntegration(cmd: string, args: string[], env: Record<string, string>, isDefaultShell: boolean): string[] {
  const ptyId = Number(env.LEE_PTY_ID);
  const shell = path.basename(cmd || '');
  const info: SpawnInfo = { default_shell: isDefaultShell, shell: isDefaultShell ? shell : null, integration: null };
  if (Number.isInteger(ptyId)) spawns.set(ptyId, info);
  try {
    if (!isDefaultShell || !enabledFor(env)) return args;
    const p = installed ?? shellPaths();
    if (shell === 'zsh') {
      const zshrc = path.join(p.zshDir, '.zshrc');
      if (!fs.existsSync(zshrc)) return args;
      // Never point back at Lee's own directory (a shell started from one whose .zshrc didn't run).
      const orig = env.ZDOTDIR && path.resolve(env.ZDOTDIR) !== path.resolve(p.zshDir) ? env.ZDOTDIR : '';
      env.LEE_ORIG_ZDOTDIR = orig;
      env.ZDOTDIR = p.zshDir;
      info.integration = 'zsh';
      return args;
    }
    if (shell === 'bash') {
      const loginOnly = args.length === 0 || (args.length === 1 && (args[0] === '-l' || args[0] === '--login'));
      if (!loginOnly || !fs.existsSync(p.bashRc)) return args;
      info.integration = 'bash';
      return ['--init-file', p.bashRc];
    }
    return args;
  } catch {
    return args;
  }
}
