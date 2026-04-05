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
  private configPath: string;
  private tokenCache: Map<string, string> = new Map(); // host -> auth token

  constructor() {
    super();
    this.configPath = path.join(app.getPath('home'), '.lee', 'config.yaml');
  }

  async init(): Promise<void> {
    await this.loadConfig();
    await this.pingAll();
    this.healthTimer = setInterval(() => this.pingAll(), MachineManager.PING_INTERVAL);
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

  dispose(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}
