/**
 * Resuming Claude sessions when a workspace's saved tabs are restored (pure).
 *
 * Claude files a session under the directory it ran in (the project root for
 * a plain tab, `.claude/worktrees/<slug>` for a Cockpit task launched with
 * `--worktree`), and `claude --resume <id>` only finds sessions filed under
 * its current directory. So a saved Claude tab keeps its session id and that
 * directory, and restores in it while it exists.
 */

/** What a saved Claude tab needs to resume: its session and where it ran. */
export interface ResumeRef {
  session_id: string;
  cwd: string;
}

/** The parts of a snapshot agent (AgentSummary) this reads. */
export interface AgentSessionInfo {
  pty_id: number;
  session_id?: string | null;
  cwd?: string | null;
  workspace?: string | null;
}

/** A Claude session id Lee will pass on argv: ids only, never flags or paths. */
export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/**
 * Fold the snapshot's agents into the known (pty → session, cwd) map. Entries
 * are kept after an agent leaves the snapshot (it ends as Lee quits), so a
 * save made then still carries them. Returns the same map when nothing
 * changed, else a new one.
 */
export function mergeResumeRefs(
  known: ReadonlyMap<number, ResumeRef>,
  agents: readonly AgentSessionInfo[] | null | undefined,
  workspace: string,
): ReadonlyMap<number, ResumeRef> {
  let next: Map<number, ResumeRef> | null = null;
  for (const a of agents ?? []) {
    if (!validSessionId(a.session_id)) continue;
    const cwd = a.cwd || a.workspace || workspace;
    if (!cwd) continue;
    const prev = (next ?? known).get(a.pty_id);
    if (prev && prev.session_id === a.session_id && prev.cwd === cwd) continue;
    next = next ?? new Map(known);
    next.set(a.pty_id, { session_id: a.session_id, cwd });
  }
  return next ?? known;
}

/** The resume ref to save for a tab: Claude agent tabs with a known session only. */
export function resumeForTab(
  tab: { type: string; provider?: string; ptyId?: number | null },
  known: ReadonlyMap<number, ResumeRef>,
): ResumeRef | null {
  if (tab.type !== 'agent' || tab.provider !== 'claude' || tab.ptyId == null) return null;
  return known.get(tab.ptyId) ?? null;
}

export type RestorePlan =
  /** `claude --resume <session_id>` in cwd. */
  | { kind: 'resume'; session_id: string; cwd: string }
  /** Its directory is gone: a new session in the workspace root, and say so. */
  | { kind: 'fallback'; message: string }
  /** No resume saved (older sessions, other providers): as before. */
  | { kind: 'fresh' };

/**
 * How to restore an agent tab. `cwdExists` answers whether the saved
 * directory still exists (lee.fs.exists); it is only asked for a Claude tab
 * with a valid saved resume.
 */
export async function restorePlan(
  tab: { label: string; resume?: Partial<ResumeRef> | null },
  provider: string,
  cwdExists: (dir: string) => Promise<boolean> | boolean,
): Promise<RestorePlan> {
  const r = tab.resume;
  if (provider !== 'claude' || !r || !validSessionId(r.session_id) || typeof r.cwd !== 'string' || !r.cwd) return { kind: 'fresh' };
  let exists = false;
  try {
    exists = await cwdExists(r.cwd);
  } catch {
    exists = false;
  }
  if (exists) return { kind: 'resume', session_id: r.session_id, cwd: r.cwd };
  return { kind: 'fallback', message: resumeFallbackMessage(tab.label) };
}

export function resumeFallbackMessage(label: string): string {
  return `Couldn't resume ${label || 'Claude'}: its worktree is gone; started a new session.`;
}

/** Argv for a resumed Claude tab (never with --session-id). */
export function resumeArgs(sessionId: string): string[] {
  return ['--resume', sessionId];
}
