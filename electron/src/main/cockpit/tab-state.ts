/**
 * The tab state table of contract §5.1 as a function of its inputs.
 *
 * Pure: no electron imports.
 */

import type { TabKind, TabRunState, TabStateSource } from '../../shared/cockpit';

/** Last agent hook event seen for a PTY (from copilotBus). */
export type HookPhase = 'session_start' | 'prompt' | 'tool' | 'waiting' | 'turn_end';

/** A hooked agent that says busy but has printed nothing for this long is not trusted as busy. */
export const HOOK_STALE_MS = 30_000;

export interface TabStateInputs {
  exists: boolean;
  kind: TabKind;
  /** Last hook phase while a hook session is live, else null. */
  hook: HookPhase | null;
  /** Shell integration seen on this PTY. */
  integration: boolean;
  /** Between OSC 133;C and 133;D. */
  inCommand: boolean;
  /** Stripped last lines (up to 5) for pattern matching. */
  lastLines: string[];
  promptPattern: RegExp | null;
  awaitingPattern: RegExp | null;
  quietMs: number;
  quietThreshold: number;
  /** node-pty foreground process title, when known. */
  foreground: string | null;
  /** Basename of the login shell for a default-shell PTY, else null. */
  shellName: string | null;
}

export interface TabStateDecision {
  state: TabRunState;
  source: TabStateSource;
}

function matches(re: RegExp | null, lines: string[]): boolean {
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(lines.join('\n'));
}

function sameProgram(a: string, b: string): boolean {
  const base = (s: string) => s.replace(/^-/, '').split('/').pop() || s;
  return base(a) === base(b);
}

export function decideTabState(i: TabStateInputs): TabStateDecision {
  // 1
  if (!i.exists) return { state: 'exited', source: 'none' };
  // 2
  if (i.hook) {
    switch (i.hook) {
      case 'prompt':
      case 'tool':
        if (i.quietMs >= HOOK_STALE_MS) return { state: 'unknown', source: 'hooks' };
        return { state: 'busy', source: 'hooks' };
      case 'waiting':
        return { state: 'awaiting-input', source: 'hooks' };
      case 'turn_end':
      case 'session_start':
        return { state: 'idle-at-prompt', source: 'hooks' };
    }
  }
  // 3
  if (i.kind === 'shell' && i.integration) {
    return { state: i.inCommand ? 'busy' : 'idle-at-prompt', source: 'shell-integration' };
  }
  const quiet = i.quietMs >= i.quietThreshold;
  // 4
  if ((i.kind === 'agent' || i.kind === 'tui') && quiet && (i.promptPattern || i.awaitingPattern)) {
    if (matches(i.awaitingPattern, i.lastLines)) return { state: 'awaiting-input', source: 'pattern' };
    if (matches(i.promptPattern, i.lastLines)) return { state: 'idle-at-prompt', source: 'pattern' };
  }
  // 5
  if (i.kind === 'shell' && !i.integration && i.foreground && i.shellName) {
    if (sameProgram(i.foreground, i.shellName) && quiet) return { state: 'idle-at-prompt', source: 'foreground' };
    return { state: 'busy', source: 'foreground' };
  }
  // 6
  if (!quiet) return { state: 'busy', source: 'quiet' };
  // 7
  return { state: 'unknown', source: 'quiet' };
}

/** Compile a config regex string; null when absent or invalid. */
export function compilePattern(src: unknown): RegExp | null {
  if (typeof src !== 'string' || !src) return null;
  try {
    return new RegExp(src, 'm');
  } catch {
    return null;
  }
}
