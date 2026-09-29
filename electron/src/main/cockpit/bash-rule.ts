/**
 * The Claude Code `Bash(<prefix>:*)` permission rule Lee writes for a command
 * (operation agents, contract §7.7; lint toil/repeat-approval, §8.3).
 *
 * The contract's rule is `<first word> <second word unless it starts with ->`.
 * That turns `python -m pytest` into `Bash(python:*)`, an allow for any
 * Python. So a generic launcher (interpreter, `npx`, `uv run`, ...) keeps
 * the whole command as the prefix, or gets no rule at all when the command
 * has quoting or expansions (it then prompts); so does a destructive program
 * (`rm -rf build` never becomes `Bash(rm:*)`), and a shell never gets a rule.
 * A flag as the second word also keeps the whole command when it can, else
 * the bare name.
 *
 * Pure: no electron imports.
 */

/** Programs that run whatever their arguments say. */
const LAUNCHERS = new Set([
  'python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'deno', 'bun', 'bunx', 'ts-node', 'tsx',
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'exec', 'eval', 'command', 'builtin',
  'sudo', 'doas', 'su', 'xargs', 'nohup', 'nice', 'time', 'timeout', 'watch', 'find',
  'npx', 'uvx', 'pipx', 'ruby', 'perl', 'php', 'lua', 'osascript', 'awk', 'gawk', 'sed', 'ssh', 'docker', 'kubectl',
]);

/** `<tool> <sub>` pairs that also run arbitrary commands. */
const LAUNCHER_SUBS: Record<string, string[]> = {
  uv: ['run', 'tool'],
  pdm: ['run', 'exec'],
  poetry: ['run'],
  pipenv: ['run'],
  hatch: ['run'],
  rye: ['run'],
  conda: ['run'],
  npm: ['exec', 'x'],
  pnpm: ['exec', 'dlx', 'x'],
  yarn: ['exec', 'dlx', 'node'],
  bundle: ['exec'],
  cargo: ['exec'],
  go: ['run'],
};

/** Shells and shell builtins that evaluate their arguments. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'eval', 'exec', 'source', '.']);

/** Programs whose bare-name rule would allow destroying or sending data. */
const DESTRUCTIVE = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'shred', 'tee', 'install',
  'kill', 'pkill', 'killall', 'curl', 'wget', 'rsync', 'scp', 'sftp', 'nc', 'git', 'open',
]);

/** Characters that make a prefix mean something other than its words. */
const UNSAFE = /[`$'"\\{}()<>|;&*?[\]!~#\n\r\t]/;

/** The last `&&` segment without leading VAR=value words; null when empty. */
function lastSegmentWords(command: string): string[] {
  const segs = command.split(/\s*&&\s*/);
  return segs[segs.length - 1]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => !(all.slice(0, i + 1).every((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))));
}

/**
 * `Bash(<prefix>:*)` for a command, or null when no safe prefix exists.
 * `npm run build` -> `Bash(npm run:*)`; `python -m pytest` -> `Bash(python -m pytest:*)`;
 * `sh -c "make"` -> null.
 */
export function bashPrefixRule(command: string): string | null {
  const words = lastSegmentWords(command);
  if (words.length === 0) return null;
  const first = words[0];
  const second = words[1];
  if (UNSAFE.test(first)) return null;
  const base = first.split('/').pop() ?? first;
  // A shell's arguments are code: any prefix of `bash -c ...` runs whatever follows.
  if (SHELLS.has(base)) return null;
  // The whole command as the prefix: re-running it (with more arguments) is allowed, nothing else.
  const full = words.length >= 2 && !UNSAFE.test(words.join(' ')) ? `Bash(${words.join(' ')}:*)` : null;
  if (LAUNCHERS.has(base) || DESTRUCTIVE.has(base) || (second != null && (LAUNCHER_SUBS[base] ?? []).includes(second))) return full;
  if (second != null && second.startsWith('-')) return full ?? `Bash(${first}:*)`;
  if (second != null && !UNSAFE.test(second)) return `Bash(${first} ${second}:*)`;
  return `Bash(${first}:*)`;
}
