/**
 * Per-device tokens: ~/.lee/devices/<device_id>.json, one file per device.
 *
 * The raw token (a UUID) is returned once at issuance and never stored; only
 * its sha256 is. Revocation keeps the file for attribution history. QR
 * pairing tickets live in memory only.
 *
 * Pure (no Electron) so it can be smoke-tested with plain node.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DeviceInfo } from '../../shared/copilot';

export interface DeviceRecord extends DeviceInfo {
  token_sha256: string;
}

const DEVICE_ID_RE = /^dev_[0-9a-f]{12}$/;
const TOUCH_FLUSH_MS = 5 * 60_000;
const DEFAULT_TICKET_TTL_MS = 600_000;

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function toInfo(r: DeviceRecord): DeviceInfo {
  return {
    device_id: r.device_id,
    name: r.name,
    kind: r.kind,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
    last_ip: r.last_ip,
    paired_via: r.paired_via,
    revoked_at: r.revoked_at,
  };
}

function isRecord(v: any): v is DeviceRecord {
  return (
    v &&
    typeof v === 'object' &&
    typeof v.device_id === 'string' &&
    DEVICE_ID_RE.test(v.device_id) &&
    typeof v.token_sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.token_sha256)
  );
}

export class DeviceTokenStore {
  private readonly dir: string;
  private records = new Map<string, DeviceRecord>();
  private dirty = new Set<string>();
  private lastWritten = new Map<string, number>();
  private tickets = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // issue() will surface the error; verification of existing devices still works
    }
    this.load();
  }

  private load(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (isRecord(rec)) {
          this.records.set(rec.device_id, {
            device_id: rec.device_id,
            name: String(rec.name ?? ''),
            kind: String(rec.kind ?? ''),
            token_sha256: rec.token_sha256,
            created_at: String(rec.created_at ?? ''),
            last_seen_at: rec.last_seen_at ?? null,
            last_ip: rec.last_ip ?? null,
            paired_via: rec.paired_via === 'code' || rec.paired_via === 'qr' ? rec.paired_via : 'manual',
            revoked_at: rec.revoked_at ?? null,
          });
        }
      } catch {
        // unreadable device file: ignored, never fatal
      }
    }
  }

  private writeRecord(rec: DeviceRecord): void {
    const file = path.join(this.dir, `${rec.device_id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.dirty.delete(rec.device_id);
    this.lastWritten.set(rec.device_id, Date.now());
  }

  private newDeviceId(): string {
    for (;;) {
      const id = `dev_${crypto.randomBytes(6).toString('hex')}`;
      if (!this.records.has(id)) return id;
    }
  }

  issue(opts: { name: string; kind: string; via: 'code' | 'qr' | 'manual'; ip?: string }): {
    record: DeviceRecord;
    token: string;
  } {
    const token = crypto.randomUUID();
    const record: DeviceRecord = {
      device_id: this.newDeviceId(),
      name: opts.name,
      kind: opts.kind,
      token_sha256: sha256(token),
      created_at: new Date().toISOString(),
      last_seen_at: null,
      last_ip: opts.ip ?? null,
      paired_via: opts.via,
      revoked_at: null,
    };
    this.records.set(record.device_id, record);
    this.writeRecord(record);
    return { record: { ...record }, token };
  }

  verify(token: string): DeviceRecord | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
    const hash = Buffer.from(sha256(token), 'hex');
    let match: DeviceRecord | null = null;
    for (const rec of this.records.values()) {
      const other = Buffer.from(rec.token_sha256, 'hex');
      if (other.length === hash.length && crypto.timingSafeEqual(hash, other)) match = rec;
    }
    if (!match || match.revoked_at) return null;
    return { ...match };
  }

  get(deviceId: string): DeviceInfo | null {
    const rec = this.records.get(deviceId);
    return rec ? toInfo(rec) : null;
  }

  revoke(deviceId: string): boolean {
    const rec = this.records.get(deviceId);
    if (!rec || rec.revoked_at) return false;
    rec.revoked_at = new Date().toISOString();
    this.writeRecord(rec);
    return true;
  }

  list(): DeviceInfo[] {
    return [...this.records.values()]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .map(toInfo);
  }

  touch(deviceId: string, ip: string): void {
    const rec = this.records.get(deviceId);
    if (!rec) return;
    rec.last_seen_at = new Date().toISOString();
    rec.last_ip = ip;
    this.dirty.add(deviceId);
    const last = this.lastWritten.get(deviceId) ?? 0;
    if (Date.now() - last >= TOUCH_FLUSH_MS) {
      try {
        this.writeRecord(rec);
      } catch {
        // retried on the next touch or flush
      }
    }
  }

  flush(): void {
    for (const id of [...this.dirty]) {
      const rec = this.records.get(id);
      if (!rec) {
        this.dirty.delete(id);
        continue;
      }
      try {
        this.writeRecord(rec);
      } catch {
        // keep it dirty
      }
    }
  }

  createTicket(ttlMs: number = DEFAULT_TICKET_TTL_MS): { ticket: string; expiresIn: number } {
    this.sweepTickets();
    const ticket = crypto.randomBytes(16).toString('hex');
    this.tickets.set(ticket, Date.now() + ttlMs);
    return { ticket, expiresIn: Math.floor(ttlMs / 1000) };
  }

  redeemTicket(ticket: string): boolean {
    this.sweepTickets();
    if (typeof ticket !== 'string') return false;
    const key = ticket.trim().toLowerCase();
    const expires = this.tickets.get(key);
    if (expires === undefined) return false;
    this.tickets.delete(key);
    return expires > Date.now();
  }

  private sweepTickets(): void {
    const now = Date.now();
    for (const [t, exp] of this.tickets) if (exp <= now) this.tickets.delete(t);
  }
}
