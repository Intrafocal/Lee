/**
 * Per-PTY output ring (contract §5.1): the last N characters a PTY printed,
 * with a monotonic cursor (total characters appended since spawn). Text is
 * ANSI-stripped at read time.
 *
 * Pure: no electron imports.
 */

export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 2000;
export const DEFAULT_MAX_CHARS = 65_536;
export const MAX_MAX_CHARS = 262_144;

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CHARSET_RE = /\x1b[()*+\-./#%][\x20-\x7e]/g;
const ESC2_RE = /\x1b[\x20-\x7e]?/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Apply backspaces to one line: each \b removes the character before it. */
function applyBackspaces(line: string): string {
  if (!line.includes('\b')) return line;
  const out: string[] = [];
  for (const ch of line) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

/**
 * Strip terminal control sequences: OSC, CSI, other escapes, carriage-return
 * overwrites (keep text after the last \r of each line), backspaces, and any
 * remaining control characters except \n and \t.
 */
export function stripAnsi(text: string): string {
  let s = text.replace(OSC_RE, '').replace(CSI_RE, '').replace(CHARSET_RE, '').replace(ESC2_RE, '');
  s = s.replace(/\r+\n/g, '\n');
  const lines = s.split('\n').map((line) => {
    const cr = line.lastIndexOf('\r');
    let kept = cr >= 0 ? line.slice(cr + 1) : line;
    // A \r at the very end (cursor back, nothing after yet) keeps the line.
    if (cr >= 0 && cr === line.length - 1) {
      const prev = line.slice(0, cr);
      const prevCr = prev.lastIndexOf('\r');
      kept = prevCr >= 0 ? prev.slice(prevCr + 1) : prev;
    }
    return applyBackspaces(kept).replace(CONTROL_RE, '');
  });
  return lines.join('\n');
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

export interface RingRead {
  text: string;
  cursor: number;
  truncated: boolean;
}

export class OutputRing {
  private buf = '';
  private total = 0;
  private readonly maxChars: number;
  lastAppendAt = 0;

  constructor(maxChars: number = 256 * 1024) {
    this.maxChars = Math.max(1024, Math.floor(maxChars));
  }

  append(chunk: string, now: number = Date.now()): void {
    if (!chunk) return;
    this.total += chunk.length;
    this.lastAppendAt = now;
    if (chunk.length >= this.maxChars) {
      this.buf = chunk.slice(chunk.length - this.maxChars);
      return;
    }
    this.buf += chunk;
    if (this.buf.length > this.maxChars * 1.25) this.buf = this.buf.slice(this.buf.length - this.maxChars);
  }

  /** Total characters appended since spawn. */
  get cursor(): number {
    return this.total;
  }

  /** Cursor of the oldest character still kept. */
  get start(): number {
    return this.total - this.buf.length;
  }

  /**
   * `since`: raw text after that cursor (up to max_chars of raw text, so the
   * returned cursor pages forward). Otherwise the last `lines` stripped lines.
   */
  read(req: { since?: number; lines?: number; max_chars?: number } = {}): RingRead {
    const maxChars = clampInt(req.max_chars, DEFAULT_MAX_CHARS, 1, MAX_MAX_CHARS);
    if (typeof req.since === 'number' && Number.isFinite(req.since)) {
      const since = Math.max(0, Math.floor(req.since));
      if (since >= this.total) return { text: '', cursor: this.total, truncated: false };
      const start = this.start;
      const truncated = since < start;
      const from = truncated ? 0 : since - start;
      const raw = this.buf.slice(from, from + maxChars);
      return { text: stripAnsi(raw), cursor: start + from + raw.length, truncated };
    }
    const n = clampInt(req.lines, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
    const lines = this.tailLines(n);
    let text = lines.join('\n');
    if (text.length > maxChars) text = text.slice(text.length - maxChars);
    return { text, cursor: this.total, truncated: false };
  }

  /** Last n stripped lines, trailing blank lines dropped. */
  tailLines(n: number): string[] {
    if (n <= 0 || !this.buf) return [];
    // Strip only as much as the last n lines need (plus slack for escapes).
    let window = Math.min(this.buf.length, Math.max(4096, n * 400));
    for (;;) {
      const lines = stripAnsi(this.buf.slice(this.buf.length - window)).split('\n');
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      if (lines.length > n || window >= this.buf.length) return lines.slice(Math.max(0, lines.length - n));
      window = Math.min(this.buf.length, window * 4);
    }
  }
}
