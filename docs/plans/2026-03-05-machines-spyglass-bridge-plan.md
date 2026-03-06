# Machines (Spyglass & Bridge) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Lee-to-Lee connectivity — monitor remote instances (Spyglass tabs) and run TUIs on remote machines via SSH (Bridge tabs).

**Architecture:** Machines are configured in `~/.lee/config.yaml`. A `MachineManager` in the main process loads config and runs health pings. The renderer shows machine emojis in the StatusBar with click/right-click to open Spyglass or Bridge tabs. Spyglass connects via WebSocket to the remote Lee API. Bridge discovers remote TUIs via the API, then spawns a local PTY running `ssh -t`.

**Tech Stack:** TypeScript, React, Electron IPC, WebSocket (native browser API), Express (existing API server)

---

### Task 1: Add Machine Types

**Files:**
- Modify: `electron/src/shared/context.ts`
- Modify: `electron/src/renderer/components/TabBar.tsx`

**Step 1: Add MachineConfig interface and new tab types to shared types**

In `electron/src/shared/context.ts`, add after the `WorkspaceConfig` interface (around line 234):

```typescript
/**
 * Machine configuration for Lee-to-Lee connectivity.
 * Configured in ~/.lee/config.yaml under `machines:`.
 */
export interface MachineConfig {
  name: string;
  emoji: string;
  host: string;
  user: string;
  ssh_port?: number;   // default 22
  lee_port?: number;    // default 9001
  hester_port?: number; // default 9000
}
```

Add `'spyglass' | 'bridge'` to the `TabType` union (line 9).

**Step 2: Add new tab types to TabBar**

In `electron/src/renderer/components/TabBar.tsx`:

- Add `'spyglass' | 'bridge'` to the `Tab['type']` union (line 11)
- Add to `TAB_ICONS` (line 65): `spyglass: '🔭'` and `bridge: '🌉'`
- Add Bridge to `CORE_TAB_OPTIONS` array (line 37):
  ```typescript
  { type: 'bridge', label: 'Bridge', icon: '🌉' },
  ```

**Step 3: Commit**

```bash
git add electron/src/shared/context.ts electron/src/renderer/components/TabBar.tsx
git commit -m "feat: add MachineConfig type and spyglass/bridge tab types"
```

---

### Task 2: MachineManager (Main Process)

**Files:**
- Create: `electron/src/main/machine-manager.ts`

**Step 1: Create MachineManager**

This class loads machine configs from `~/.lee/config.yaml`, runs health pings, and exposes state.

```typescript
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

  /**
   * Load machines from ~/.lee/config.yaml and start health pinging.
   */
  async init(): Promise<void> {
    await this.loadConfig();
    await this.pingAll();
    this.healthTimer = setInterval(() => this.pingAll(), MachineManager.PING_INTERVAL);
  }

  /**
   * Load or reload machine configs from disk.
   */
  async loadConfig(): Promise<void> {
    try {
      const content = await fs.promises.readFile(this.configPath, 'utf-8');
      const config = yaml.load(content) as any;
      const machineConfigs: MachineConfig[] = config?.machines || [];

      // Preserve online status for machines that still exist
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

  /**
   * Ping all machines for health status.
   */
  async pingAll(): Promise<void> {
    await Promise.all(this.machines.map(m => this.pingMachine(m)));
    this.emit('change', this.getStates());
  }

  /**
   * Ping a single machine's /health endpoint.
   */
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

  /**
   * Fetch remote Lee context for Bridge discovery.
   */
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
            resolve(JSON.parse(data));
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
```

**Step 2: Commit**

```bash
git add electron/src/main/machine-manager.ts
git commit -m "feat: add MachineManager for config loading and health pings"
```

---

### Task 3: Wire MachineManager into Main Process + IPC

**Files:**
- Modify: `electron/src/main/main.ts`
- Modify: `electron/src/main/preload.ts`

**Step 1: Initialize MachineManager in main.ts**

Near the top of `main.ts` (around line 28, after `let browserManager`), add:

```typescript
import { MachineManager } from './machine-manager';

let machineManager: MachineManager;
```

In the `app.whenReady()` block (after PTYManager and APIServer initialization), add:

```typescript
// Initialize machine manager for Lee-to-Lee connectivity
machineManager = new MachineManager();
machineManager.init().catch(err => console.error('[Lee] MachineManager init failed:', err));
```

**Step 2: Add IPC handlers in main.ts**

After the existing IPC handlers (e.g., after the `daemon:` handlers), add:

```typescript
// Machine management for Spyglass/Bridge
ipcMain.handle('machines:getAll', async () => {
  return machineManager.getStates();
});

ipcMain.handle('machines:reload', async () => {
  await machineManager.loadConfig();
  await machineManager.pingAll();
  return machineManager.getStates();
});

ipcMain.handle('machines:fetchContext', async (_event, machineConfig: any) => {
  try {
    return await machineManager.fetchRemoteContext(machineConfig);
  } catch (err: any) {
    return { error: err.message };
  }
});
```

**Step 3: Add machines API to preload.ts**

In `preload.ts`, add a `machines` section to the exposed API (after the `hester` section, around line 546):

```typescript
machines: {
  getAll: () => ipcRenderer.invoke('machines:getAll'),
  reload: () => ipcRenderer.invoke('machines:reload'),
  fetchContext: (machineConfig: any) => ipcRenderer.invoke('machines:fetchContext', machineConfig),
  onChange: (callback: (machines: any[]) => void) => {
    const listener = (_event: any, machines: any[]) => callback(machines);
    ipcRenderer.on('machines:change', listener);
    return () => ipcRenderer.removeListener('machines:change', listener);
  },
},
```

Also add the `machines` property to the `LeeAPI` interface (around line 178):

```typescript
machines: {
  getAll: () => Promise<any[]>;
  reload: () => Promise<any[]>;
  fetchContext: (machineConfig: any) => Promise<any>;
  onChange: (callback: (machines: any[]) => void) => () => void;
};
```

**Step 4: Forward MachineManager change events to renderer**

In `main.ts`, after initializing `machineManager`, add:

```typescript
machineManager.on('change', (states: any[]) => {
  // Broadcast to all windows
  for (const ws of windowRegistry.getAll()) {
    ws.browserWindow.webContents.send('machines:change', states);
  }
});
```

**Step 5: Commit**

```bash
git add electron/src/main/main.ts electron/src/main/preload.ts
git commit -m "feat: wire MachineManager IPC and preload API"
```

---

### Task 4: MachineStatus Component (Status Bar)

**Files:**
- Create: `electron/src/renderer/components/MachineStatus.tsx`
- Modify: `electron/src/renderer/components/StatusBar.tsx`
- Modify: `electron/src/renderer/styles/index.css`

**Step 1: Create MachineStatus component**

```typescript
/**
 * MachineStatus - Renders machine emojis in the status bar.
 *
 * Each configured machine shows its emoji with:
 * - Full opacity when online, dimmed when offline
 * - Hover tooltip with machine name and status
 * - Left-click opens Spyglass tab
 * - Right-click opens Bridge picker
 */

import React, { useEffect, useState } from 'react';

const lee = (window as any).lee;

interface MachineState {
  config: {
    name: string;
    emoji: string;
    host: string;
    user: string;
    ssh_port: number;
    lee_port: number;
    hester_port: number;
  };
  online: boolean;
  lastPing: number;
}

interface MachineStatusProps {
  onSpyglass: (machine: MachineState) => void;
  onBridge: (machine: MachineState) => void;
}

export const MachineStatus: React.FC<MachineStatusProps> = ({ onSpyglass, onBridge }) => {
  const [machines, setMachines] = useState<MachineState[]>([]);

  useEffect(() => {
    if (!lee?.machines) return;

    // Load initial state
    lee.machines.getAll().then((states: MachineState[]) => setMachines(states));

    // Listen for changes
    const cleanup = lee.machines.onChange((states: MachineState[]) => setMachines(states));
    return cleanup;
  }, []);

  if (machines.length === 0) return null;

  return (
    <div className="machine-status">
      {machines.map((m, i) => (
        <span
          key={`${m.config.host}:${m.config.lee_port}-${i}`}
          className={`machine-emoji ${m.online ? 'online' : 'offline'}`}
          title={`${m.config.name} \u2014 ${m.online ? 'online' : 'offline'}`}
          onClick={() => onSpyglass(m)}
          onContextMenu={(e) => {
            e.preventDefault();
            onBridge(m);
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {m.config.emoji}
        </span>
      ))}
    </div>
  );
};
```

**Step 2: Add MachineStatus to StatusBar**

In `StatusBar.tsx`, add props and render the component.

Add to `StatusBarProps` interface:

```typescript
onSpyglass?: (machine: any) => void;
onBridge?: (machine: any) => void;
```

Import and render `MachineStatus` in the `status-bar-right` div (before the time display, around line 357):

```tsx
{onSpyglass && onBridge && (
  <MachineStatus onSpyglass={onSpyglass} onBridge={onBridge} />
)}
```

**Step 3: Add CSS for machine status**

Add to `electron/src/renderer/styles/index.css`:

```css
/* Machine status indicators */
.machine-status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 8px;
}

.machine-emoji {
  cursor: pointer;
  font-size: 14px;
  user-select: none;
  transition: opacity 0.2s;
}

.machine-emoji.online {
  opacity: 1;
}

.machine-emoji.offline {
  opacity: 0.35;
  filter: grayscale(0.5);
}

.machine-emoji:hover {
  transform: scale(1.2);
}
```

**Step 4: Commit**

```bash
git add electron/src/renderer/components/MachineStatus.tsx electron/src/renderer/components/StatusBar.tsx electron/src/renderer/styles/index.css
git commit -m "feat: add MachineStatus emoji indicators in status bar"
```

---

### Task 5: SpyglassPane Component

**Files:**
- Create: `electron/src/renderer/components/SpyglassPane.tsx`

**Step 1: Create SpyglassPane**

This component connects to a remote Lee via WebSocket and renders its context.

```typescript
/**
 * SpyglassPane - View and control a remote Lee instance.
 *
 * Connects via WebSocket to remote Lee's /context/stream.
 * Renders remote tabs, editor state, and activity.
 * Click remote tabs to focus them on the remote machine.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';

interface RemoteContext {
  workspace: string;
  tabs: Array<{
    id: number;
    type: string;
    label: string;
    state: string;
  }>;
  focusedPanel: string;
  editor: {
    file: string | null;
    language: string | null;
    cursor: { line: number; column: number };
    modified: boolean;
  } | null;
  activity: {
    idleSeconds: number;
    sessionDuration: number;
    recentActions: Array<{ type: string; target: string; timestamp: number }>;
  };
  timestamp: number;
}

interface SpyglassPaneProps {
  active: boolean;
  machineConfig: {
    name: string;
    emoji: string;
    host: string;
    lee_port: number;
  };
}

const TAB_TYPE_ICONS: Record<string, string> = {
  terminal: '\uD83D\uDCBB',
  editor: '\uD83D\uDCDD',
  'editor-panel': '\uD83D\uDCDD',
  file: '\uD83D\uDCC4',
  files: '\uD83D\uDCC2',
  browser: '\uD83C\uDF10',
  hester: '\uD83D\uDC07',
  claude: '\uD83E\uDD16',
  git: '\uD83C\uDF3F',
  docker: '\uD83D\uDC33',
  library: '\uD83D\uDCDA',
  workstream: '\uD83D\uDCCB',
  spyglass: '\uD83D\uDD2D',
  bridge: '\uD83C\uDF09',
};

export const SpyglassPane: React.FC<SpyglassPaneProps> = ({ active, machineConfig }) => {
  const [context, setContext] = useState<RemoteContext | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    const url = `ws://${machineConfig.host}:${machineConfig.lee_port}/context/stream`;

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'context_update' && msg.data) {
            setContext(msg.data);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        // Auto-reconnect after 3 seconds
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setError(`Cannot reach ${machineConfig.name}`);
      };
    } catch {
      setError(`Failed to connect to ${machineConfig.name}`);
    }
  }, [machineConfig]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, [connect]);

  const sendCommand = useCallback(async (domain: string, action: string, params: any = {}) => {
    try {
      const url = `http://${machineConfig.host}:${machineConfig.lee_port}/command`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, action, params }),
      });
    } catch (err) {
      console.error('[Spyglass] Command failed:', err);
    }
  }, [machineConfig]);

  const focusRemoteTab = useCallback((tabId: number) => {
    sendCommand('system', 'focus_tab', { tab_id: tabId });
  }, [sendCommand]);

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const formatIdle = (seconds: number): string => {
    if (seconds < 10) return 'active';
    return `idle ${formatDuration(seconds)}`;
  };

  return (
    <div className="spyglass-pane" style={{ display: active ? 'flex' : 'none' }}>
      {/* Header */}
      <div className="spyglass-header">
        <span className="spyglass-machine-emoji">{machineConfig.emoji}</span>
        <span className="spyglass-machine-name">{machineConfig.name}</span>
        <span className={`spyglass-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? '\u25CF' : '\u25CB'}
        </span>
        {context && (
          <span className="spyglass-idle">{formatIdle(context.activity.idleSeconds)}</span>
        )}
      </div>

      {error && !connected && (
        <div className="spyglass-error">{error}</div>
      )}

      {context && (
        <>
          {/* Workspace */}
          <div className="spyglass-workspace">
            {context.workspace.split('/').pop()}
          </div>

          {/* Remote tabs */}
          <div className="spyglass-tabs">
            {context.tabs.map(tab => (
              <div
                key={tab.id}
                className={`spyglass-tab ${tab.state === 'active' ? 'active' : ''}`}
                onClick={() => focusRemoteTab(tab.id)}
                title={`Click to focus on ${machineConfig.name}`}
              >
                <span className="spyglass-tab-icon">
                  {TAB_TYPE_ICONS[tab.type] || '\uD83D\uDD27'}
                </span>
                <span className="spyglass-tab-label">{tab.label}</span>
              </div>
            ))}
          </div>

          {/* Editor state */}
          {context.editor?.file && (
            <div className="spyglass-editor">
              <div className="spyglass-editor-file">
                {context.editor.file.split('/').pop()}
                {context.editor.modified && <span className="spyglass-modified"> \u25CF</span>}
              </div>
              <div className="spyglass-editor-meta">
                {context.editor.language} \u2014 Ln {context.editor.cursor.line}, Col {context.editor.cursor.column}
              </div>
            </div>
          )}

          {/* Recent activity */}
          <div className="spyglass-activity">
            <div className="spyglass-section-label">Recent Activity</div>
            {context.activity.recentActions.slice(-5).reverse().map((action, i) => (
              <div key={i} className="spyglass-action">
                <span className="spyglass-action-type">{action.type}</span>
                <span className="spyglass-action-target">{action.target}</span>
              </div>
            ))}
            {context.activity.recentActions.length === 0 && (
              <div className="spyglass-action spyglass-no-activity">No recent activity</div>
            )}
          </div>

          {/* Session info */}
          <div className="spyglass-session">
            Session: {formatDuration(context.activity.sessionDuration)}
          </div>
        </>
      )}

      {!context && connected && (
        <div className="spyglass-loading">Waiting for context...</div>
      )}

      {!connected && !error && (
        <div className="spyglass-loading">Connecting...</div>
      )}
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add electron/src/renderer/components/SpyglassPane.tsx
git commit -m "feat: add SpyglassPane component for remote Lee monitoring"
```

---

### Task 6: BridgePicker Component

**Files:**
- Create: `electron/src/renderer/components/BridgePicker.tsx`

**Step 1: Create BridgePicker**

A modal that shows machine selection, then fetches remote TUI configs, and spawns SSH.

```typescript
/**
 * BridgePicker - Select a machine, workspace, and TUI to run remotely via SSH.
 *
 * Flow:
 * 1. Select machine (or pre-selected from status bar right-click)
 * 2. Fetch remote context to discover workspace + TUIs
 * 3. Pick a TUI to run
 * 4. Spawns local PTY with: ssh -t user@host "cd /workspace && command args..."
 */

import React, { useEffect, useState, useCallback } from 'react';

const lee = (window as any).lee;

interface MachineConfig {
  name: string;
  emoji: string;
  host: string;
  user: string;
  ssh_port: number;
  lee_port: number;
  hester_port: number;
}

interface MachineState {
  config: MachineConfig;
  online: boolean;
}

interface TUIOption {
  key: string;
  name: string;
  command: string;
  args?: string[];
}

interface BridgePickerProps {
  preselectedMachine?: MachineState | null;
  onSpawn: (machine: MachineConfig, workspace: string, tui: TUIOption) => void;
  onCancel: () => void;
}

export const BridgePicker: React.FC<BridgePickerProps> = ({
  preselectedMachine,
  onSpawn,
  onCancel,
}) => {
  const [machines, setMachines] = useState<MachineState[]>([]);
  const [selectedMachine, setSelectedMachine] = useState<MachineState | null>(preselectedMachine || null);
  const [remoteWorkspace, setRemoteWorkspace] = useState<string | null>(null);
  const [tuis, setTuis] = useState<TUIOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load machines if no preselection
  useEffect(() => {
    if (!preselectedMachine && lee?.machines) {
      lee.machines.getAll().then((states: MachineState[]) => setMachines(states));
    }
  }, [preselectedMachine]);

  // Fetch remote context when machine is selected
  const fetchRemoteTUIs = useCallback(async (machine: MachineState) => {
    setLoading(true);
    setError(null);
    setTuis([]);
    setRemoteWorkspace(null);

    try {
      const ctx = await lee.machines.fetchContext(machine.config);
      if (ctx.error) {
        setError(ctx.error);
        setLoading(false);
        return;
      }

      setRemoteWorkspace(ctx.workspace || null);

      // Extract TUI definitions from remote config
      const remoteTuis = ctx.workspaceConfig?.tuis || {};
      const tuiOptions: TUIOption[] = Object.entries(remoteTuis).map(([key, tui]: [string, any]) => ({
        key,
        name: tui.name || key,
        command: tui.command,
        args: tui.args,
      }));

      // Always include a plain terminal option
      tuiOptions.unshift({
        key: 'terminal',
        name: 'Terminal',
        command: '$SHELL',
        args: ['-l'],
      });

      setTuis(tuiOptions);
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (selectedMachine?.online) {
      fetchRemoteTUIs(selectedMachine);
    }
  }, [selectedMachine, fetchRemoteTUIs]);

  const handleSpawn = (tui: TUIOption) => {
    if (selectedMachine && remoteWorkspace) {
      onSpawn(selectedMachine.config, remoteWorkspace, tui);
    }
  };

  return (
    <div className="bridge-picker-overlay" onClick={onCancel}>
      <div className="bridge-picker" onClick={(e) => e.stopPropagation()}>
        <div className="bridge-picker-header">
          <span className="bridge-picker-title">{'\uD83C\uDF09'} Bridge</span>
          <button className="bridge-picker-close" onClick={onCancel}>{'\u00D7'}</button>
        </div>

        {/* Machine selection (if not preselected) */}
        {!selectedMachine && (
          <div className="bridge-section">
            <div className="bridge-section-label">Select Machine</div>
            {machines.length === 0 && (
              <div className="bridge-empty">No machines configured. Add machines to ~/.lee/config.yaml</div>
            )}
            {machines.map((m, i) => (
              <button
                key={i}
                className={`bridge-machine-btn ${m.online ? '' : 'offline'}`}
                onClick={() => m.online && setSelectedMachine(m)}
                disabled={!m.online}
              >
                <span>{m.config.emoji}</span>
                <span>{m.config.name}</span>
                <span className={`bridge-status-dot ${m.online ? 'online' : 'offline'}`}>
                  {m.online ? '\u25CF' : '\u25CB'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* TUI selection */}
        {selectedMachine && (
          <div className="bridge-section">
            <div className="bridge-section-label">
              {selectedMachine.config.emoji} {selectedMachine.config.name}
              {remoteWorkspace && (
                <span className="bridge-workspace"> \u2014 {remoteWorkspace.split('/').pop()}</span>
              )}
              {!preselectedMachine && (
                <button className="bridge-back-btn" onClick={() => {
                  setSelectedMachine(null);
                  setTuis([]);
                  setRemoteWorkspace(null);
                }}>
                  Back
                </button>
              )}
            </div>

            {loading && <div className="bridge-loading">Discovering TUIs...</div>}
            {error && <div className="bridge-error">{error}</div>}

            {tuis.map(tui => (
              <button
                key={tui.key}
                className="bridge-tui-btn"
                onClick={() => handleSpawn(tui)}
              >
                <span className="bridge-tui-name">{tui.name}</span>
                <span className="bridge-tui-command">{tui.command}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add electron/src/renderer/components/BridgePicker.tsx
git commit -m "feat: add BridgePicker component for remote TUI selection"
```

---

### Task 7: Wire Spyglass and Bridge into App.tsx

**Files:**
- Modify: `electron/src/renderer/App.tsx`

This is the integration task — connecting the new components to the existing tab system.

**Step 1: Import new components**

Add imports at the top of `App.tsx`:

```typescript
import { SpyglassPane } from './components/SpyglassPane';
import { BridgePicker } from './components/BridgePicker';
```

**Step 2: Add state for Bridge picker**

After the existing state declarations (around line 70):

```typescript
const [showBridgePicker, setShowBridgePicker] = useState(false);
const [bridgePreselectedMachine, setBridgePreselectedMachine] = useState<any>(null);
```

**Step 3: Add machineConfig to TabData**

Extend the `TabData` interface (around line 36):

```typescript
// Spyglass-specific data
machineConfig?: {
  name: string;
  emoji: string;
  host: string;
  user: string;
  ssh_port: number;
  lee_port: number;
  hester_port: number;
};
```

**Step 4: Add spyglass/bridge to nonPtyTabs and createTab**

In the `createTab` function (line 224), add `'spyglass'` to `nonPtyTabs`:

```typescript
const nonPtyTabs: Tab['type'][] = ['files', 'editor-panel', 'browser', 'library', 'workstream', 'spyglass'];
```

Add a `'bridge'` case in the switch statement (after `'sql'`, around line 276):

```typescript
case 'bridge':
  // Bridge spawns SSH — handled by handleBridgeSpawn, not here
  break;
```

**Step 5: Add handler functions for Spyglass and Bridge**

After the existing handler functions (e.g., after `handleDaemonAction`):

```typescript
// Spyglass: open/focus a spyglass tab for a machine
const handleSpyglass = useCallback((machine: any) => {
  const machineKey = `${machine.config.host}:${machine.config.lee_port}`;
  // Check if spyglass tab already exists for this machine
  const existing = tabs.find(t =>
    t.type === 'spyglass' &&
    (t as TabData).machineConfig?.host === machine.config.host &&
    (t as TabData).machineConfig?.lee_port === machine.config.lee_port
  );
  if (existing) {
    setActiveTabId(existing.id);
    return;
  }
  // Create new spyglass tab
  const tabId = nextTabIdRef.current++;
  const newTab: TabData = {
    id: tabId,
    type: 'spyglass' as any,
    label: `${machine.config.emoji} ${machine.config.name}`,
    closable: true,
    ptyId: null,
    dockPosition: 'center',
    machineConfig: machine.config,
  };
  setTabs(prev => [...prev, newTab]);
  setActiveTabId(tabId);
}, [tabs]);

// Bridge: open the picker for a machine
const handleBridge = useCallback((machine?: any) => {
  setBridgePreselectedMachine(machine || null);
  setShowBridgePicker(true);
}, []);

// Bridge: spawn SSH session after picker selection
const handleBridgeSpawn = useCallback(async (machineConfig: any, workspace: string, tui: any) => {
  setShowBridgePicker(false);
  setBridgePreselectedMachine(null);

  if (!isElectron) return;

  // Build SSH command
  const port = machineConfig.ssh_port || 22;
  const remoteCmd = tui.key === 'terminal'
    ? `cd ${workspace} && exec $SHELL -l`
    : `cd ${workspace} && ${tui.command}${tui.args ? ' ' + tui.args.join(' ') : ''}`;

  const sshArgs = ['-t'];
  if (port !== 22) {
    sshArgs.push('-p', String(port));
  }
  sshArgs.push(`${machineConfig.user}@${machineConfig.host}`, remoteCmd);

  try {
    const ptyId = await lee.pty.spawn('ssh', sshArgs, undefined, `${machineConfig.emoji} ${tui.name}`);
    if (ptyId !== null) {
      ptyEventManager.expect(ptyId);
    }

    const tabId = nextTabIdRef.current++;
    const newTab: TabData = {
      id: tabId,
      type: 'bridge' as any,
      label: `${machineConfig.emoji} ${tui.name}`,
      closable: true,
      ptyId,
      dockPosition: 'center',
      machineConfig,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    if (isElectron) {
      lee.context.recordAction('tab_create', `bridge:${machineConfig.name}:${tui.name}`);
    }
  } catch (error) {
    console.error('[Bridge] Failed to spawn SSH:', error);
  }
}, []);
```

**Step 6: Add Spyglass to renderTab**

In the `renderTab` function (around line 952, before the fallback terminal render):

```typescript
if (tab.type === 'spyglass') {
  const tabData = tab as TabData;
  return (
    <SpyglassPane
      key={tab.id}
      active={active}
      machineConfig={tabData.machineConfig!}
    />
  );
}
```

Note: Bridge tabs are PTY-based, so they fall through to the default `TerminalPane` render. No special case needed.

**Step 7: Add to getDefaultLabel**

In the `getDefaultLabel` function (around line 1995):

```typescript
case 'spyglass':
  return 'Spyglass';
case 'bridge':
  return 'Bridge';
```

**Step 8: Add Bridge to splash screen**

In the shortcuts bar section (around line 1914, after the Library chip):

```tsx
<div className="shortcut-chip" onClick={() => handleBridge()}>
  <span className="shortcut-icon">{'\uD83C\uDF09'}</span>
  <span className="shortcut-name">Bridge</span>
</div>
```

**Step 9: Wire StatusBar machine callbacks**

Update the `<StatusBar>` component (around line 1939) to pass the machine handlers:

```tsx
onSpyglass={handleSpyglass}
onBridge={handleBridge}
```

**Step 10: Render BridgePicker modal**

After the `StatusBar` component (around line 1950), add:

```tsx
{showBridgePicker && (
  <BridgePicker
    preselectedMachine={bridgePreselectedMachine}
    onSpawn={handleBridgeSpawn}
    onCancel={() => {
      setShowBridgePicker(false);
      setBridgePreselectedMachine(null);
    }}
  />
)}
```

**Step 11: Commit**

```bash
git add electron/src/renderer/App.tsx
git commit -m "feat: wire Spyglass and Bridge tabs into App.tsx"
```

---

### Task 8: CSS Styles for Spyglass and Bridge

**Files:**
- Modify: `electron/src/renderer/styles/index.css`

**Step 1: Add Spyglass styles**

```css
/* Spyglass pane */
.spyglass-pane {
  flex-direction: column;
  height: 100%;
  padding: 16px;
  overflow-y: auto;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
}

.spyglass-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid #30363d;
  margin-bottom: 16px;
}

.spyglass-machine-emoji {
  font-size: 20px;
}

.spyglass-machine-name {
  font-size: 16px;
  font-weight: 600;
}

.spyglass-status {
  font-size: 10px;
}

.spyglass-status.connected {
  color: #3fb950;
}

.spyglass-status.disconnected {
  color: #f85149;
}

.spyglass-idle {
  margin-left: auto;
  font-size: 12px;
  color: #8b949e;
}

.spyglass-workspace {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 12px;
}

.spyglass-error {
  color: #f85149;
  font-size: 13px;
  padding: 8px;
  background: rgba(248, 81, 73, 0.1);
  border-radius: 6px;
  margin-bottom: 12px;
}

.spyglass-loading {
  color: #8b949e;
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

/* Remote tabs */
.spyglass-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 16px;
}

.spyglass-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  background: #21262d;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
}

.spyglass-tab:hover {
  background: #30363d;
}

.spyglass-tab.active {
  background: #30363d;
  border: 1px solid #3fb950;
}

.spyglass-tab-icon {
  font-size: 12px;
}

.spyglass-tab-label {
  color: #e6edf3;
}

/* Editor state */
.spyglass-editor {
  padding: 10px;
  background: #161b22;
  border-radius: 6px;
  margin-bottom: 16px;
}

.spyglass-editor-file {
  font-family: 'JetBrainsMono', monospace;
  font-size: 13px;
  color: #e6edf3;
}

.spyglass-modified {
  color: #d29922;
}

.spyglass-editor-meta {
  font-size: 11px;
  color: #8b949e;
  margin-top: 4px;
}

/* Activity */
.spyglass-activity {
  margin-bottom: 16px;
}

.spyglass-section-label {
  font-size: 11px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.spyglass-action {
  display: flex;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}

.spyglass-action-type {
  color: #8b949e;
  min-width: 80px;
}

.spyglass-action-target {
  color: #e6edf3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spyglass-no-activity {
  color: #484f58;
  font-style: italic;
}

.spyglass-session {
  font-size: 11px;
  color: #484f58;
  padding-top: 8px;
  border-top: 1px solid #21262d;
}
```

**Step 2: Add Bridge picker styles**

```css
/* Bridge picker modal */
.bridge-picker-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.bridge-picker {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 10px;
  width: 360px;
  max-height: 500px;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.bridge-picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #30363d;
}

.bridge-picker-title {
  font-size: 14px;
  font-weight: 600;
  color: #e6edf3;
}

.bridge-picker-close {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
}

.bridge-picker-close:hover {
  color: #e6edf3;
}

.bridge-section {
  padding: 12px 16px;
}

.bridge-section-label {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.bridge-workspace {
  color: #484f58;
}

.bridge-back-btn {
  margin-left: auto;
  background: none;
  border: 1px solid #30363d;
  color: #8b949e;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.bridge-back-btn:hover {
  color: #e6edf3;
  border-color: #8b949e;
}

.bridge-machine-btn,
.bridge-tui-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: #21262d;
  border: 1px solid transparent;
  border-radius: 6px;
  color: #e6edf3;
  cursor: pointer;
  font-size: 13px;
  margin-bottom: 4px;
  transition: all 0.15s;
}

.bridge-machine-btn:hover:not(:disabled),
.bridge-tui-btn:hover {
  background: #30363d;
  border-color: #3fb950;
}

.bridge-machine-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.bridge-status-dot.online {
  color: #3fb950;
  margin-left: auto;
}

.bridge-status-dot.offline {
  color: #f85149;
  margin-left: auto;
}

.bridge-tui-name {
  font-weight: 500;
}

.bridge-tui-command {
  margin-left: auto;
  color: #484f58;
  font-family: 'JetBrainsMono', monospace;
  font-size: 11px;
}

.bridge-loading,
.bridge-empty {
  color: #8b949e;
  font-size: 13px;
  padding: 12px 0;
  text-align: center;
}

.bridge-error {
  color: #f85149;
  font-size: 13px;
  padding: 8px;
  background: rgba(248, 81, 73, 0.1);
  border-radius: 6px;
}
```

**Step 3: Commit**

```bash
git add electron/src/renderer/styles/index.css
git commit -m "feat: add CSS styles for Spyglass and Bridge components"
```

---

### Task 9: Add Bridge to Tab Menu Dropdown

**Files:**
- Modify: `electron/src/renderer/components/TabBar.tsx`

**Step 1: Add Bridge to CORE_TAB_OPTIONS**

This was mentioned in Task 1 but deserves its own verification. Ensure `CORE_TAB_OPTIONS` (line 37) includes:

```typescript
{ type: 'bridge', label: 'Bridge', icon: '\uD83C\uDF09' },
```

Note: Bridge in the tab menu needs special handling since it opens a picker, not a direct tab. In `App.tsx`, the `createTab('bridge')` call should trigger the Bridge picker instead. Add this logic at the top of `createTab`:

```typescript
if (type === 'bridge' as any) {
  handleBridge();
  return null;
}
```

**Step 2: Commit**

```bash
git add electron/src/renderer/App.tsx electron/src/renderer/components/TabBar.tsx
git commit -m "feat: add Bridge to tab menu with picker redirect"
```

---

### Task 10: Add Global Config Path to Config Loading

**Files:**
- Modify: `electron/src/main/main.ts`

**Step 1: Add `~/.lee/config.yaml` as a config source**

The current config loading (around line 623) checks:
1. `workspace/.lee/config.yaml`
2. `~/.config/lee/config.yaml`

Add `~/.lee/config.yaml` as a third fallback (or merge it with workspace config for machine-specific settings):

In the config paths array (line 623), add:

```typescript
const configPaths = [
  path.join(workspace, '.lee', 'config.yaml'),
  path.join(app.getPath('home'), '.lee', 'config.yaml'),
  path.join(app.getPath('home'), '.config', 'lee', 'config.yaml'),
];
```

Do the same for the `config:load` handler (line 677).

**Step 2: Commit**

```bash
git add electron/src/main/main.ts
git commit -m "feat: add ~/.lee/config.yaml as global config path"
```

---

### Task 11: Build and Test

**Step 1: Build the Electron app**

Run: `cd electron && npm run build`
Expected: No TypeScript errors

**Step 2: Manual test checklist**

1. Create `~/.lee/config.yaml` with a test machine:
   ```yaml
   machines:
     - name: Test
       emoji: "\U0001F5A5"
       host: 127.0.0.1
       user: ben
       lee_port: 9001
   ```
2. Start Lee — verify emoji appears in status bar
3. Hover emoji — verify tooltip shows name and status
4. Left-click emoji — verify Spyglass tab opens
5. Right-click emoji — verify Bridge picker opens
6. If you have a second machine, test Bridge SSH flow end-to-end

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: Machines - Spyglass & Bridge for Lee-to-Lee connectivity"
```
