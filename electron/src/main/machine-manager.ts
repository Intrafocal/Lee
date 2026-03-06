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
      const machineConfigs: MachineConfig[] = config?.machines || [];

      const oldStatus = new Map(this.machines.map(m => [`${m.config.host}:${m.config.lee_port || 9001}`, m.online]));

      this.machines = machineConfigs.map(cfg => ({
        config: {
          ...cfg,
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

  private pingMachine(machine: MachineState): Promise<void> {
    return new Promise((resolve) => {
      const port = machine.config.lee_port || 9001;
      const req = http.request({
        hostname: machine.config.host,
        port,
        path: '/health',
        method: 'GET',
        timeout: 3000,
      }, (res) => {
        machine.online = res.statusCode === 200;
        machine.lastPing = Date.now();
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
    return new Promise((resolve, reject) => {
      const port = machine.lee_port || 9001;
      const req = http.request({
        hostname: machine.host,
        port,
        path: '/context',
        method: 'GET',
        timeout: 5000,
      }, (res) => {
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
