/**
 * Streaming parser for the shell-integration OSC sequences (contract §5.1):
 * OSC 133;A/B (prompt), 133;C (command starts), 133;D[;<exit>] (command
 * ended), OSC 633;E;<escaped cmdline> and OSC 7;file://<host><path>.
 * Sequences may be split across chunks. The data itself is never modified
 * (xterm.js, Aeronaut and Dirigible ignore unknown OSCs).
 *
 * Pure: no electron imports.
 */

export type ShellOscEvent =
  | { type: 'prompt-start' }
  | { type: 'prompt-end' }
  | { type: 'command-start' }
  | { type: 'command-end'; exit_code: number | null }
  | { type: 'command-line'; text: string }
  | { type: 'cwd'; path: string; host: string };

/** Longest OSC payload kept while waiting for its terminator. */
const MAX_PENDING = 16 * 1024;

/** Undo the 633;E escaping: `\\` -> `\`, `\xHH` -> char. */
export function unescapeCommandLine(s: string): string {
  return s.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, a: string, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : a,
  );
}

/** The escaping the shell hooks apply (for tests and symmetry). */
export function escapeCommandLine(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === ';') out += '\\x3b';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

function parseFileUrl(rest: string): { host: string; path: string } | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/.exec(rest);
  if (!m) return null;
  let p = m[2] || '/';
  try {
    p = decodeURIComponent(p);
  } catch {
    // raw path (the hooks print $PWD unencoded)
  }
  return { host: m[1], path: p };
}

export function parseOscPayload(payload: string): ShellOscEvent | null {
  if (payload.startsWith('133;')) {
    const parts = payload.slice(4).split(';');
    switch (parts[0]) {
      case 'A':
        return { type: 'prompt-start' };
      case 'B':
        return { type: 'prompt-end' };
      case 'C':
        return { type: 'command-start' };
      case 'D': {
        const n = parts.length > 1 && /^-?\d+$/.test(parts[1]) ? Number(parts[1]) : null;
        return { type: 'command-end', exit_code: n };
      }
      default:
        return null;
    }
  }
  if (payload.startsWith('633;E;') || payload === '633;E') {
    const raw = payload.length > 6 ? payload.slice(6).split(';')[0] : '';
    return { type: 'command-line', text: unescapeCommandLine(raw) };
  }
  if (payload.startsWith('7;')) {
    const f = parseFileUrl(payload.slice(2));
    return f ? { type: 'cwd', path: f.path, host: f.host } : null;
  }
  return null;
}

export class ShellOscParser {
  private pending = '';

  /** Feed a chunk; returns the recognised events in order. */
  feed(chunk: string): ShellOscEvent[] {
    const events: ShellOscEvent[] = [];
    let s = this.pending + chunk;
    this.pending = '';
    let i = 0;
    for (;;) {
      const start = s.indexOf('\x1b]', i);
      if (start < 0) {
        // Keep a trailing lone ESC: it may start an OSC in the next chunk.
        if (s.endsWith('\x1b')) this.pending = '\x1b';
        break;
      }
      const bel = s.indexOf('\x07', start + 2);
      const st = s.indexOf('\x1b\\', start + 2);
      // Another ESC before a terminator ends this sequence unterminated.
      const nextEsc = s.indexOf('\x1b', start + 2);
      let end = -1;
      let termLen = 0;
      if (bel >= 0 && (st < 0 || bel < st)) {
        end = bel;
        termLen = 1;
      } else if (st >= 0) {
        end = st;
        termLen = 2;
      }
      if (end < 0) {
        if (nextEsc >= 0 && nextEsc !== s.length - 1) {
          i = nextEsc;
          continue;
        }
        const rest = s.slice(start);
        if (rest.length <= MAX_PENDING) this.pending = rest;
        break;
      }
      if (nextEsc >= 0 && nextEsc < end) {
        i = nextEsc;
        continue;
      }
      const ev = parseOscPayload(s.slice(start + 2, end));
      if (ev) events.push(ev);
      i = end + termLen;
    }
    return events;
  }
}
