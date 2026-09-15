/**
 * MachineManager - Loads machine configs and tracks health status.
 *
 * Reads `machines:` from ~/.lee/config.yaml.
 * Pings each machine's lee_port/health every 15 seconds.
 * Exposes machine state via IPC for the renderer.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as http from 'http';
import { execFile } from 'child_process';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { MachineConfig } from '../shared/context';

export interface MachineState {
  config: MachineConfig;
  online: boolean;
  lastPing: number;
}

export class MachineManager extends EventEmitter {
  private machines: MachineState[] = [];
  private healthTimer: NodeJS.Timeout | null = null;
  private static PING_INTERVAL = 15000;
  private static CONFIG_WATCH_DEBOUNCE_MS = 500;
  private configPath: string;
  private tokenCache: Map<string, string> = new Map(); // host -> auth token
  private configWatcher: fs.FSWatcher | null = null;
  private configReloadTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.configPath = path.join(app.getPath('home'), '.lee', 'config.yaml');
  }

  async init(): Promise<void> {
    await this.loadConfig();
    await this.pingAll();
    this.healthTimer = setInterval(() => this.pingAll(), MachineManager.PING_INTERVAL);
    this.watchConfig();
  }

  /**
   * F3: auto-reload `machines:` when ~/.lee/config.yaml changes on disk
   * (e.g. hand-edited, or rewritten by Lee's own config editor).
   *
   * Watches the *directory*, not the file: editors commonly replace a file
   * via an atomic rename (write temp, rename over the target), which a
   * watcher bound to the original file's inode would go deaf after. A
   * directory watch keeps working across that and just gets filtered by
   * basename. Events are debounced 500ms since fs.watch can fire several
   * times for a single save.
   */
  private watchConfig(): void {
    const dir = path.dirname(this.configPath);
    const base = path.basename(this.configPath);
    try {
      this.configWatcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        // Some platforms (notably certain network/virtual filesystems)
        // don't report a filename - fall through and reload anyway rather
        // than going silent.
        if (filename && filename.toString() !== base) return;
        if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
        this.configReloadTimer = setTimeout(() => {
          this.configReloadTimer = null;
          this.reloadFromWatch();
        }, MachineManager.CONFIG_WATCH_DEBOUNCE_MS);
      });
      this.configWatcher.on('error', (err) => {
        console.error('[MachineManager] Config watch error:', err);
      });
    } catch (err) {
      // ~/.lee may not exist yet on a fresh install - nothing to watch until
      // it's created; the explicit `machines:reload` IPC still works.
      console.warn('[MachineManager] Could not watch', dir, err);
    }
  }

  private async reloadFromWatch(): Promise<void> {
    try {
      await this.loadConfig();
      await this.pingAll();
      this.emit('config-reloaded', { count: this.machines.length });
    } catch (err) {
      console.error('[MachineManager] Reload from config watch failed:', err);
    }
  }

  async loadConfig(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.configPath, 'utf-8');
      const config = yaml.load(content) as any;
      const rawMachines: any[] = config?.machines || [];
      // Filter out malformed entries (null, missing required fields)
      const machineConfigs: MachineConfig[] = rawMachines.filter(
        (cfg): cfg is MachineConfig => cfg != null && typeof cfg === 'object' && typeof cfg.host === 'string' && typeof cfg.name === 'string'
      );

      const oldStatus = new Map(this.machines.map(m => [`${m.config.host}:${m.config.lee_port || 9001}`, m.online]));

      this.machines = machineConfigs.map(cfg => ({
        config: {
          ...cfg,
          emoji: cfg.emoji || '🖥️',
          ssh_port: cfg.ssh_port ?? 22,
          lee_port: cfg.lee_port ?? 9001,
          hester_port: cfg.hester_port ?? 9000,
        },
        online: oldStatus.get(`${cfg.host}:${cfg.lee_port || 9001}`) ?? false,
        lastPing: 0,
      }));

      this.emit('change', this.getStates());
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[MachineManager] Failed to load config:', err);
      }
      this.machines = [];
      this.emit('change', this.getStates());
    }
  }

  async pingAll(): Promise<void> {
    await Promise.all(this.machines.map(m => this.pingMachine(m)));
    this.emit('change', this.getStates());
  }

  /**
   * Fetch the auth token from a remote machine via SSH.
   * Caches the token per host to avoid repeated SSH calls.
   */
  private fetchToken(host: string, sshPort: number = 22): Promise<string | null> {
    const cacheKey = `${host}:${sshPort}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve) => {
      const args = ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new'];
      if (sshPort !== 22) {
        args.push('-p', String(sshPort));
      }
      args.push(host, 'cat', '~/.lee/api-token');

      execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
        if (err) {
          console.error(`[MachineManager] SSH token fetch failed for ${host}:`, err.message);
          resolve(null);
          return;
        }
        const token = stdout.trim();
        if (token) {
          this.tokenCache.set(cacheKey, token);
        }
        resolve(token || null);
      });
    });
  }

  /** Clear cached token for a host (e.g., after auth failure). */
  clearTokenCache(host: string, sshPort: number = 22): void {
    this.tokenCache.delete(`${host}:${sshPort}`);
  }

  private async pingMachine(machine: MachineState): Promise<void> {
    const port = machine.config.lee_port || 9001;
    const token = await this.fetchToken(machine.config.host, machine.config.ssh_port);
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return new Promise((resolve) => {
      const req = http.request({
        hostname: machine.config.host,
        port,
        path: '/health',
        method: 'GET',
        headers,
        timeout: 3000,
      }, (res) => {
        machine.online = res.statusCode === 200;
        machine.lastPing = Date.now();
        // If we get 401, clear cached token so next ping re-fetches
        if (res.statusCode === 401) {
          this.clearTokenCache(machine.config.host, machine.config.ssh_port);
        }
        resolve();
      });
      req.on('error', () => {
        machine.online = false;
        machine.lastPing = Date.now();
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        machine.online = false;
        machine.lastPing = Date.now();
        resolve();
      });
      req.end();
    });
  }

  async fetchRemoteContext(machine: MachineConfig): Promise<any> {
    const port = machine.lee_port || 9001;
    const token = await this.fetchToken(machine.host, machine.ssh_port);
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: machine.host,
        port,
        path: '/context',
        method: 'GET',
        headers,
        timeout: 5000,
      }, (res) => {
        if (res.statusCode === 401) {
          this.clearTokenCache(machine.host, machine.ssh_port);
          reject(new Error('Unauthorized: invalid or expired token'));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // API returns {success, data} wrapper — unwrap it
            resolve(parsed.data ?? parsed);
          } catch {
            reject(new Error('Invalid JSON from remote context'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout fetching remote context'));
      });
      req.end();
    });
  }

  getStates(): MachineState[] {
    return this.machines.map(m => ({ ...m, config: { ...m.config } }));
  }

  /**
   * Fetch (and cache) the API auth token for a configured machine by name.
   * Used by SpyglassPane to authenticate WS/HTTP calls to a remote Lee.
   */
  async getTokenForMachine(machineName: string): Promise<string | null> {
    const machine = this.machines.find(m => m.config.name === machineName);
    if (!machine) return null;
    return this.fetchToken(machine.config.host, machine.config.ssh_port);
  }

  dispose(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.configReloadTimer) {
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = null;
    }
    if (this.configWatcher) {
      try {
        this.configWatcher.close();
      } catch {
        // Already closed.
      }
      this.configWatcher = null;
    }
  }
}
