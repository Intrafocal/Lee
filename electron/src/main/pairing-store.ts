/**
 * PairingStore — the state behind Lee's TV-style device pairing (E19).
 *
 * A device (Dirigible T-Deck, and later Aeronaut) shows a 6-digit code on its
 * own screen and POSTs it, with a random nonce, to Lee's unauthenticated
 * `POST /pair/request`. Lee pops a native dialog naming the device and the
 * code; if the user approves, the device's next `GET /pair/poll?nonce=…`
 * hands back the bearer token exactly once. Nobody types 36 characters on a
 * thumb keyboard.
 *
 * Everything here is pure, synchronous and free of Electron/Express imports so
 * it can be exercised by a plain node script (see the report for E19).
 *
 * Safety rules, all enforced here rather than in the route handlers:
 *   - an entry lives for TTL_MS (120 s) and is swept on every operation
 *   - at most MAX_PENDING (3) entries are awaiting a decision at once
 *   - at most MAX_PENDING_PER_IP (1) per remote address, so a device on a
 *     loop can't bury the user in dialogs
 *   - the token is released exactly once: reading an approved entry deletes it
 *   - a denied entry is also deleted when read, so "Retry" on the device works
 *     immediately instead of waiting out the TTL
 */

export type PairingDecision = 'pending' | 'approved' | 'denied';

/** What a poll can report. Deliberately the only four words that ever leave. */
export type PairingPollStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PairingEntry {
  nonce: string;
  code: string;
  device: string;
  kind: string;
  ip: string;
  createdAt: number;
  decision: PairingDecision;
  /** Set once the approval dialog has been raised, so we never show two. */
  dialogShown: boolean;
}

export interface PairingGrant {
  token: string;
  hester_port: number;
  name: string;
}

export type PairingPollResult =
  | { status: 'pending' | 'denied' | 'expired' }
  | ({ status: 'approved' } & PairingGrant);

export type PairingCreateResult =
  | { ok: true; entry: PairingEntry; expiresIn: number }
  | { ok: false; reason: 'rate_limited' | 'duplicate_nonce' };

/** How long a pairing request stays open, in ms. */
export const PAIRING_TTL_MS = 120_000;
/** Entries awaiting a decision, in total. */
export const PAIRING_MAX_PENDING = 3;
/** Entries awaiting a decision, per remote IP. */
export const PAIRING_MAX_PENDING_PER_IP = 1;

export interface PairingRequestBody {
  device: string;
  kind: string;
  code: string;
  nonce: string;
}

/**
 * Validate an untrusted `POST /pair/request` body. Returns the cleaned fields
 * or a short reason string; nothing here is ever echoed back to the caller
 * beyond the reason, and the cleaned `device`/`kind` are what the dialog shows.
 */
export function validatePairingBody(body: any): { ok: true; value: PairingRequestBody } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'Body must be a JSON object' };

  const device = typeof body.device === 'string' ? body.device.trim() : '';
  if (!device || device.length > 64) return { ok: false, reason: 'device must be 1-64 characters' };

  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  if (!kind || kind.length > 32) return { ok: false, reason: 'kind must be 1-32 characters' };

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'code must be exactly 6 digits' };

  const nonce = typeof body.nonce === 'string' ? body.nonce.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{16,128}$/.test(nonce)) return { ok: false, reason: 'nonce must be 16-128 hex characters' };

  // The device name and kind end up in a native dialog and in lee.log, so
  // strip anything that isn't printable ASCII rather than trusting the wire.
  const sanitize = (s: string) => s.replace(/[^\x20-\x7E]/g, '?');

  return { ok: true, value: { device: sanitize(device), kind: sanitize(kind), code, nonce } };
}

export class PairingStore {
  private entries = new Map<string, PairingEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? PAIRING_TTL_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Drop everything past its TTL. Called at the top of every public method. */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [nonce, entry] of this.entries) {
      if (entry.createdAt <= cutoff) this.entries.delete(nonce);
    }
  }

  private pendingCount(ip?: string): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.decision !== 'pending') continue;
      if (ip !== undefined && entry.ip !== ip) continue;
      n++;
    }
    return n;
  }

  create(req: PairingRequestBody, ip: string): PairingCreateResult {
    this.sweep();
    if (this.entries.has(req.nonce)) return { ok: false, reason: 'duplicate_nonce' };
    if (this.pendingCount() >= PAIRING_MAX_PENDING) return { ok: false, reason: 'rate_limited' };
    if (this.pendingCount(ip) >= PAIRING_MAX_PENDING_PER_IP) return { ok: false, reason: 'rate_limited' };

    const entry: PairingEntry = {
      nonce: req.nonce,
      code: req.code,
      device: req.device,
      kind: req.kind,
      ip,
      createdAt: this.now(),
      decision: 'pending',
      dialogShown: false,
    };
    this.entries.set(entry.nonce, entry);
    return { ok: true, entry, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  /**
   * Claim the right to show the approval dialog for this entry. Returns false
   * if the entry is gone or a dialog was already raised for it.
   */
  claimDialog(nonce: string): PairingEntry | null {
    this.sweep();
    const entry = this.entries.get(nonce);
    if (!entry || entry.dialogShown) return null;
    entry.dialogShown = true;
    return entry;
  }

  /** Record the user's answer. No-op if the entry expired while the dialog was up. */
  decide(nonce: string, approved: boolean): PairingEntry | null {
    this.sweep();
    const entry = this.entries.get(nonce);
    if (!entry || entry.decision !== 'pending') return null;
    entry.decision = approved ? 'approved' : 'denied';
    return entry;
  }

  /**
   * Answer a poll. An unknown, expired or already-claimed nonce all look the
   * same from outside ('expired'), so polling can't be used to enumerate.
   */
  poll(nonce: string, grant: () => PairingGrant): PairingPollResult {
    this.sweep();
    const entry = this.entries.get(nonce.trim().toLowerCase());
    if (!entry) return { status: 'expired' };
    if (entry.decision === 'pending') return { status: 'pending' };

    // Terminal states are delivered exactly once.
    this.entries.delete(entry.nonce);
    if (entry.decision === 'denied') return { status: 'denied' };
    return { status: 'approved', ...grant() };
  }

  /** Test/diagnostic helper. */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
