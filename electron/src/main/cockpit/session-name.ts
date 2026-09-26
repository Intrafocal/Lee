/**
 * Agent session names (addendum 2026-09-26b).
 *
 * A name comes from you (the Launcher's Name field, Rename on a tile or task,
 * renaming the tab) or from Claude Code itself, which writes title lines into
 * the session transcript:
 *   {"type":"custom-title","customTitle":"..."}  (/rename, or --name)
 *   {"type":"ai-title","aiTitle":"..."}          (Claude's own title)
 *
 * Precedence: user > custom-title > ai-title > the derived task title. A name
 * you typed is replaced only by a later /rename, i.e. a custom-title that
 * differs from the last one Lee saw. An ai-title never replaces a user or
 * custom name. Pi has no transcript titles: its name is yours or derived.
 *
 * Only title lines are read from a transcript: every other line is skipped
 * without being parsed or kept, and titles never go to the event log.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentNameSource } from '../../shared/cockpit';

export const NAME_MAX = 120;

export interface NameState {
  name: string | null;
  source: AgentNameSource | null;
  /** The last custom-title seen (so an unchanged /rename doesn't beat your name). */
  seenCustom: string | null;
}

/** Trim, collapse whitespace, drop control characters, clip. '' -> null. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
}

/**
 * Apply one name observation (pure). Returns the new state, or null when
 * nothing changes. `name: null` from the user clears the name (detection can
 * then fill it again).
 */
export function applyName(cur: NameState, incoming: { name: string | null; source: AgentNameSource }): NameState | null {
  const name = cleanName(incoming.name);
  switch (incoming.source) {
    case 'user': {
      if (name === cur.name && (name == null || cur.source === 'user')) return null;
      return { name, source: name ? 'user' : null, seenCustom: cur.seenCustom };
    }
    case 'custom-title': {
      if (!name) return null;
      if (name === cur.seenCustom) return null; // not a new /rename
      if (name === cur.name) return { ...cur, seenCustom: name }; // e.g. --name echoing your name
      return { name, source: 'custom-title', seenCustom: name };
    }
    case 'ai-title': {
      if (!name || name === cur.name) return null;
      if (cur.source === 'user' || cur.source === 'custom-title') return null;
      return { name, source: 'ai-title', seenCustom: cur.seenCustom };
    }
    default:
      return null;
  }
}

/** Claude's projects dir, where session transcripts live. */
export function claudeProjectsDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'projects');
}

/**
 * The transcript path if it is a .jsonl file under ~/.claude/projects (after
 * resolving symlinks), else null. A hook body is only as trusted as the local
 * process that sent it: never read anything else.
 */
export function safeTranscriptPath(p: unknown, projectsDir: string = claudeProjectsDir()): string | null {
  if (typeof p !== 'string' || !p || !p.endsWith('.jsonl') || !path.isAbsolute(p)) return null;
  let real: string;
  let root: string;
  try {
    real = fs.realpathSync(p);
    root = fs.realpathSync(projectsDir);
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}

export interface TranscriptTitles {
  customTitle: string | null;
  aiTitle: string | null;
}

interface ScanState extends TranscriptTitles {
  offset: number;
  size: number;
}

const CHUNK = 256 * 1024;
const MAX_LINE = 64 * 1024;
const CUSTOM_MARK = '"type":"custom-title"';
const AI_MARK = '"type":"ai-title"';

/**
 * Incremental scanner for title lines. Keeps a byte offset per transcript, so
 * each hook reads only what was appended since the last one. Only lines that
 * contain a title marker are parsed; only the title strings are kept.
 */
export class TranscriptTitleReader {
  private state = new Map<string, ScanState>();

  forget(file: string): void {
    this.state.delete(file);
  }

  /** The last custom-title and ai-title in the transcript (so far). Null on any failure. */
  read(file: string): TranscriptTitles | null {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      let st = this.state.get(file);
      if (!st || size < st.size) st = { offset: 0, size: 0, customTitle: null, aiTitle: null };
      let pos = st.offset;
      let pending: Buffer = Buffer.alloc(0);
      const buf = Buffer.alloc(CHUNK);
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        pos += n;
        // Split on newline bytes, so a multi-byte character across a chunk
        // boundary is never decoded in halves.
        let data = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        let nl = data.indexOf(10);
        while (nl >= 0) {
          this.take(data.subarray(0, nl), st);
          data = data.subarray(nl + 1);
          nl = data.indexOf(10);
        }
        // A partial line longer than any title line can't be one: skip it.
        pending = data.length > MAX_LINE ? Buffer.alloc(0) : data;
      }
      // An unterminated last line is re-read next time (the writer may be mid-line).
      st.offset = pos - pending.length;
      st.size = size;
      this.state.set(file, st);
      return { customTitle: st.customTitle, aiTitle: st.aiTitle };
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  private take(line: Buffer, st: ScanState): void {
    const custom = line.includes(CUSTOM_MARK);
    const ai = !custom && line.includes(AI_MARK);
    if (!custom && !ai) return;
    if (line.length > MAX_LINE) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, unknown>;
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') st.customTitle = cleanName(o.customTitle);
    else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') st.aiTitle = cleanName(o.aiTitle);
  }
}
