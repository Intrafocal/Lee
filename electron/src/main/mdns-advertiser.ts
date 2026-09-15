/**
 * MdnsAdvertiser - publishes Lee's API server as `_lee._tcp` on the LAN via
 * mDNS/Bonjour, so Dirigible (T-Deck) and other on-device clients can
 * discover a running Lee without typing in host/port by hand (E5).
 *
 * Service shape:
 *   name:  hostname, or a `machines:` entry's friendly `name` if one in the
 *          user's config resolves to this machine (matched by hostname or a
 *          local non-internal IPv4 address)
 *   type:  _lee._tcp
 *   port:  the API server's actual listening port (APIServer.getPort())
 *   txt:   { v: '1', hester: '<hester port>', ws: '<focused workspace basename>' }
 *
 * The auth token is deliberately never published in TXT records - mDNS
 * traffic is broadcast on the local segment and TXT records are the first
 * thing any LAN scanner reads.
 *
 * Opt-out: `hester.advertise_mdns: false` in the merged config (default on).
 */

import * as os from 'os';
import * as path from 'path';
import { Bonjour, Service } from 'bonjour-service';

const SERVICE_NAME = 'lee';
const SERVICE_PROTOCOL: 'tcp' = 'tcp';
/** The daemon is always spawned with `--port 9000` (see pty-manager.ts); no
 * config path changes it today, but `hester.listen_port` is read here too
 * so this doesn't silently go stale if that becomes configurable. */
const DEFAULT_HESTER_PORT = 9000;

export type LeeLogger = (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, any>) => void;

function isLocalHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host === os.hostname()) return true;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (!iface.internal && iface.address === host) return true;
    }
  }
  return false;
}

/** Resolve the friendly instance name: a `machines:` entry for this host, else os.hostname(). */
function resolveInstanceName(config: any): string {
  const machines: any[] = Array.isArray(config?.machines) ? config.machines : [];
  const self = machines.find((m) => m && typeof m === 'object' && typeof m.host === 'string' && isLocalHost(m.host));
  if (self && typeof self.name === 'string' && self.name.trim()) {
    return self.name.trim();
  }
  return os.hostname();
}

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private port: number | null = null;
  private hesterPort = DEFAULT_HESTER_PORT;
  private workspaceBasename = '';
  private instanceName = os.hostname();
  private enabled = true;
  private started = false;
  private readonly log: LeeLogger;

  constructor(log: LeeLogger) {
    this.log = log;
  }

  /**
   * Start advertising on the API server's actual port. Safe to call once;
   * `applyConfig` handles subsequent re-publishing.
   */
  start(port: number): void {
    this.port = port;
    if (this.started) return;
    this.started = true;
    if (this.enabled) this.publish();
  }

  /**
   * Apply a freshly loaded/saved config: honor `hester.advertise_mdns`,
   * pick up `hester.listen_port` (forward-compat; unused today), resolve
   * the friendly instance name, and re-publish the `ws` TXT record if the
   * workspace changed. Cheap and idempotent - safe to call on every config
   * load/save and on window focus.
   */
  applyConfig(config: any, workspace?: string): void {
    const wantEnabled = config?.hester?.advertise_mdns !== false;
    const hesterPort = Number(config?.hester?.listen_port) > 0 ? Number(config.hester.listen_port) : DEFAULT_HESTER_PORT;
    const instanceName = resolveInstanceName(config);
    const workspaceBasename = workspace ? path.basename(workspace) : this.workspaceBasename;

    if (!wantEnabled) {
      this.enabled = false;
      this.unpublish();
      return;
    }

    const changed =
      !this.enabled ||
      hesterPort !== this.hesterPort ||
      instanceName !== this.instanceName ||
      workspaceBasename !== this.workspaceBasename;

    this.enabled = true;
    this.hesterPort = hesterPort;
    this.instanceName = instanceName;
    this.workspaceBasename = workspaceBasename;

    if (!this.started) return; // start() hasn't run yet - applyConfig() just primed the fields.
    if (changed) this.publish();
  }

  /** Re-publish the `ws` TXT record when the focused workspace changes. */
  updateWorkspace(workspace: string): void {
    const basename = path.basename(workspace);
    if (basename === this.workspaceBasename) return;
    this.workspaceBasename = basename;
    if (this.started && this.enabled) this.publish();
  }

  /** Stop advertising and tear down the mDNS socket (app quit). */
  stop(): void {
    this.unpublish();
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        // Already torn down.
      }
      this.bonjour = null;
    }
    this.started = false;
  }

  private ensureBonjour(): Bonjour | null {
    if (this.bonjour) return this.bonjour;
    try {
      // The second constructor arg only covers errors from responding to
      // incoming queries. The underlying multicast-dns socket (e.g. no
      // multicast-capable interface - a VM, a sandboxed CI runner, a
      // network that blocks IGMP) reports bind failures by emitting
      // 'error' directly on itself; with zero listeners Node treats that
      // as an uncaught exception. bonjour-service doesn't wire that up
      // itself, so we reach into the instance (typed `private` but a
      // plain field at runtime) and attach one ourselves.
      const bonjour = new Bonjour({}, (err: Error) => {
        this.log('WARN', 'mDNS query-response error', { error: err?.message || String(err) });
      });
      const mdns = (bonjour as any)?.server?.mdns;
      if (mdns && typeof mdns.on === 'function') {
        mdns.on('error', (err: Error) => {
          this.log('WARN', 'mDNS advertisement disabled: no usable network interface', {
            error: err?.message || String(err),
          });
          this.bonjour = null;
          this.service = null;
        });
      }
      this.bonjour = bonjour;
      return bonjour;
    } catch (err: any) {
      this.log('WARN', 'mDNS advertisement unavailable', { error: err?.message || String(err) });
      return null;
    }
  }

  private publish(): void {
    if (this.port == null) return;
    const bonjour = this.ensureBonjour();
    if (!bonjour) return;

    this.unpublish();

    const txt = { v: '1', hester: String(this.hesterPort), ws: this.workspaceBasename };
    try {
      this.service = bonjour.publish({
        name: this.instanceName,
        type: SERVICE_NAME,
        protocol: SERVICE_PROTOCOL,
        port: this.port,
        txt,
      });
      this.log('INFO', 'Published mDNS service', {
        name: this.instanceName,
        type: `_${SERVICE_NAME}._${SERVICE_PROTOCOL}`,
        port: this.port,
        txt,
      });
    } catch (err: any) {
      this.log('WARN', 'Failed to publish mDNS service', { error: err?.message || String(err) });
    }
  }

  private unpublish(): void {
    if (!this.service) return;
    try {
      this.service.stop?.(() => {
        this.log('INFO', 'Unpublished mDNS service', { name: this.instanceName });
      });
    } catch {
      // Already torn down.
    }
    this.service = null;
  }
}
