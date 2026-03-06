# Global Config Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a GUI editor for `~/.lee/config.yaml` (global config) with a Machines tab, mirroring the existing workspace `ConfigEditorModal` pattern.

**Architecture:** New `GlobalConfigEditorModal` component reuses all existing `.config-*` CSS classes and the same tabbed modal pattern. New IPC channels (`globalConfig:*`) target `~/.lee/config.yaml` instead of workspace config. Menu gets two items: "Edit Workspace Config..." and "Edit Lee Config...".

**Tech Stack:** React, Electron IPC, js-yaml, existing CSS classes

---

### Task 1: Add Global Config IPC Channels (Main Process)

**Files:**
- Modify: `electron/src/main/main.ts` (near existing `config:*` handlers, ~line 672-786)

**Step 1: Add `globalConfig:load` handler**

Add after the existing `config:save` handler block (after ~line 786):

```typescript
  // Global config operations - load ~/.lee/config.yaml
  ipcMain.handle('globalConfig:load', async () => {
    try {
      const configPath = path.join(app.getPath('home'), '.lee', 'config.yaml');
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return parseYamlConfig(content);
    } catch (error) {
      console.error('Failed to load global config:', error);
      return null;
    }
  });
```

**Step 2: Add `globalConfig:getRaw` handler**

```typescript
  ipcMain.handle('globalConfig:getRaw', async () => {
    try {
      const configPath = path.join(app.getPath('home'), '.lee', 'config.yaml');
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return content;
    } catch (error) {
      console.error('Failed to read raw global config:', error);
      return null;
    }
  });
```

**Step 3: Add `globalConfig:saveRaw` handler**

```typescript
  ipcMain.handle('globalConfig:saveRaw', async (_event, content: string) => {
    try {
      const configDir = path.join(app.getPath('home'), '.lee');
      const configPath = path.join(configDir, 'config.yaml');
      await fs.promises.mkdir(configDir, { recursive: true });
      await fs.promises.writeFile(configPath, content, 'utf-8');
      console.log('Saved raw global config to:', configPath);
      // Reload machines after global config change
      await machineManager.loadConfig();
      return { success: true };
    } catch (error: any) {
      console.error('Failed to save raw global config:', error);
      return { success: false, error: error.message };
    }
  });
```

**Step 4: Add `globalConfig:save` handler**

```typescript
  ipcMain.handle('globalConfig:save', async (_event, config: any) => {
    try {
      const configDir = path.join(app.getPath('home'), '.lee');
      const configPath = path.join(configDir, 'config.yaml');
      await fs.promises.mkdir(configDir, { recursive: true });
      const content = yaml.dump(config, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      });
      await fs.promises.writeFile(configPath, content, 'utf-8');
      console.log('Saved global config to:', configPath);
      // Reload machines after global config change
      await machineManager.loadConfig();
      return { success: true };
    } catch (error: any) {
      console.error('Failed to save global config:', error);
      return { success: false, error: error.message };
    }
  });
```

**Step 5: Commit**

```bash
git add electron/src/main/main.ts
git commit -m "feat: add globalConfig IPC handlers for ~/.lee/config.yaml"
```

---

### Task 2: Add Preload Bridge for Global Config

**Files:**
- Modify: `electron/src/main/preload.ts` (~line 77-82 for types, ~line 273-278 for implementation)

**Step 1: Add type declaration**

In the `LeeAPI` interface (after the existing `config:` block around line 82), add:

```typescript
  globalConfig: {
    load: () => Promise<any>;
    getRaw: () => Promise<string | null>;
    saveRaw: (content: string) => Promise<{ success: boolean; error?: string }>;
    save: (config: any) => Promise<{ success: boolean; error?: string }>;
  };
```

**Step 2: Add implementation**

In the `contextBridge.exposeInMainWorld('lee', {` block (after existing `config:` implementation around line 278), add:

```typescript
  globalConfig: {
    load: () => ipcRenderer.invoke('globalConfig:load'),
    getRaw: () => ipcRenderer.invoke('globalConfig:getRaw'),
    saveRaw: (content: string) => ipcRenderer.invoke('globalConfig:saveRaw', content),
    save: (config: any) => ipcRenderer.invoke('globalConfig:save', config),
  },
```

**Step 3: Commit**

```bash
git add electron/src/main/preload.ts
git commit -m "feat: add globalConfig preload bridge"
```

---

### Task 3: Add Menu Item for "Edit Lee Config..."

**Files:**
- Modify: `electron/src/main/main.ts` (~line 251-257, the menu setup)
- Modify: `electron/src/main/preload.ts` (~line 309-311, menu listeners)

**Step 1: Rename existing menu item and add new one**

In `setupApplicationMenu()`, replace the existing "Edit Config..." menu item:

```typescript
        {
          label: 'Edit Workspace Config...',
          accelerator: 'CmdOrCtrl+,' as string,
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:edit-config');
          },
        },
        {
          label: 'Edit Lee Config...',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send('menu:edit-global-config');
          },
        },
```

**Step 2: Add preload listener for the new menu event**

In the `menu:` section of the preload type declaration, add:

```typescript
    onEditGlobalConfig: (callback: () => void) => void;
```

In the `menu:` implementation section, add:

```typescript
    onEditGlobalConfig: (callback: () => void) => {
      ipcRenderer.on('menu:edit-global-config', () => callback());
    },
```

In `removeAllListeners`, add:

```typescript
      ipcRenderer.removeAllListeners('menu:edit-global-config');
```

**Step 3: Commit**

```bash
git add electron/src/main/main.ts electron/src/main/preload.ts
git commit -m "feat: rename Edit Config to Edit Workspace Config, add Edit Lee Config menu item"
```

---

### Task 4: Create GlobalConfigEditorModal Component

**Files:**
- Create: `electron/src/renderer/components/GlobalConfigEditorModal.tsx`

**Step 1: Create the component file**

This mirrors `ConfigEditorModal.tsx` but:
- Adds a `machines` tab section (first tab)
- Uses `lee.globalConfig.*` IPC instead of `lee.config.*`
- Header shows `~/.lee/config.yaml` instead of workspace path
- Tab type includes `'machines'`

```typescript
/**
 * GlobalConfigEditorModal - GUI editor for ~/.lee/config.yaml
 *
 * Mirrors ConfigEditorModal but targets the global config file.
 * Adds a Machines tab for managing Lee-to-Lee machine definitions.
 */

import React, { useState, useEffect, useCallback } from 'react';

const lee = (window as any).lee;

interface MachineConfig {
  name: string;
  emoji: string;
  host: string;
  user: string;
  ssh_port?: number;
  lee_port?: number;
  hester_port?: number;
}

interface TUIConfig {
  command: string;
  name: string;
  icon?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd_aware?: boolean;
  cwd_from_config?: string;
  prewarm?: boolean;
  path_arg?: string;
  connection?: {
    host: string;
    port?: number;
    database: string;
    user: string;
    password?: string;
    ssl?: boolean;
  };
}

interface GlobalConfigEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  initialSection?: GlobalTabSection;
}

type GlobalTabSection = 'machines' | 'tuis' | 'keybindings' | 'terminal' | 'hester' | 'raw';

export const GlobalConfigEditorModal: React.FC<GlobalConfigEditorModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialSection,
}) => {
  const [activeSection, setActiveSection] = useState<GlobalTabSection>(initialSection || 'machines');
  const [editedConfig, setEditedConfig] = useState<any>(null);
  const [selectedMachine, setSelectedMachine] = useState<number | null>(null);
  const [selectedTui, setSelectedTui] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [rawYaml, setRawYaml] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load config when modal opens
  useEffect(() => {
    if (isOpen && lee?.globalConfig) {
      lee.globalConfig.load().then((config: any) => {
        const initial = config ? JSON.parse(JSON.stringify(config)) : {};
        if (!initial.machines) initial.machines = [];
        if (!initial.tuis) initial.tuis = {};
        if (!initial.keybindings) initial.keybindings = {};
        if (!initial.terminal) initial.terminal = {};
        if (!initial.hester) initial.hester = {};
        setEditedConfig(initial);
        setHasChanges(false);
        setError(null);
        setActiveSection(initialSection || 'machines');
        // Select first machine if available
        if (initial.machines.length > 0) {
          setSelectedMachine(0);
        } else {
          setSelectedMachine(null);
        }
        // Select first TUI if available
        const tuiKeys = Object.keys(initial.tuis || {});
        if (tuiKeys.length > 0) {
          setSelectedTui(tuiKeys[0]);
        }
      });
    }
  }, [isOpen, initialSection]);

  // Load raw YAML when switching to raw tab
  useEffect(() => {
    if (activeSection === 'raw' && lee?.globalConfig) {
      lee.globalConfig.getRaw().then((content: string | null) => {
        setRawYaml(content || '');
      }).catch(() => {
        setRawYaml('# Failed to load config file');
      });
    }
  }, [activeSection]);

  // --- Machine handlers ---
  const handleMachineChange = useCallback((index: number, field: string, value: any) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      updated.machines = [...(updated.machines || [])];
      updated.machines[index] = { ...updated.machines[index], [field]: value };
      return updated;
    });
    setHasChanges(true);
  }, []);

  const handleAddMachine = useCallback(() => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      updated.machines = [...(updated.machines || []), {
        name: 'New Machine',
        emoji: '🖥️',
        host: '',
        user: '',
        ssh_port: 22,
        lee_port: 9001,
        hester_port: 9000,
      }];
      return updated;
    });
    setSelectedMachine(editedConfig?.machines?.length || 0);
    setHasChanges(true);
  }, [editedConfig]);

  const handleDeleteMachine = useCallback((index: number) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      updated.machines = [...(updated.machines || [])];
      updated.machines.splice(index, 1);
      return updated;
    });
    setSelectedMachine(null);
    setHasChanges(true);
  }, []);

  // --- TUI handlers (same as ConfigEditorModal) ---
  const handleTuiChange = useCallback((tuiKey: string, field: string, value: any) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.tuis) updated.tuis = {};
      if (!updated.tuis[tuiKey]) updated.tuis[tuiKey] = {};
      updated.tuis[tuiKey][field] = value;
      return updated;
    });
    setHasChanges(true);
  }, []);

  const handleConnectionChange = useCallback((tuiKey: string, field: string, value: any) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.tuis) updated.tuis = {};
      if (!updated.tuis[tuiKey]) updated.tuis[tuiKey] = {};
      if (!updated.tuis[tuiKey].connection) updated.tuis[tuiKey].connection = {};
      updated.tuis[tuiKey].connection[field] = value;
      return updated;
    });
    setHasChanges(true);
  }, []);

  const handleKeybindingChange = useCallback((action: string, value: string) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.keybindings) updated.keybindings = {};
      updated.keybindings[action] = value;
      return updated;
    });
    setHasChanges(true);
  }, []);

  const handleTerminalChange = useCallback((field: string, value: any) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.terminal) updated.terminal = {};
      updated.terminal[field] = value;
      return updated;
    });
    setHasChanges(true);
  }, []);

  const handleHesterChange = useCallback((field: string, value: any) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.hester) updated.hester = {};
      updated.hester[field] = value;
      return updated;
    });
    setHasChanges(true);
  }, []);

  const handleAddTui = useCallback(() => {
    const newKey = `tui-${Date.now()}`;
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.tuis) updated.tuis = {};
      updated.tuis[newKey] = {
        command: '',
        name: 'New TUI',
        icon: '🔧',
      };
      return updated;
    });
    setSelectedTui(newKey);
    setHasChanges(true);
  }, []);

  const handleDeleteTui = useCallback((tuiKey: string) => {
    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (updated.tuis && updated.tuis[tuiKey]) {
        delete updated.tuis[tuiKey];
      }
      if (updated.keybindings && updated.keybindings[tuiKey]) {
        delete updated.keybindings[tuiKey];
      }
      return updated;
    });
    setSelectedTui(null);
    setHasChanges(true);
  }, []);

  const handleRenameTui = useCallback((oldKey: string, newKey: string) => {
    if (!newKey.trim() || newKey === oldKey) return;
    const sanitizedKey = newKey.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    if (!sanitizedKey) return;

    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.tuis || !updated.tuis[oldKey]) return prev;
      updated.tuis[sanitizedKey] = updated.tuis[oldKey];
      delete updated.tuis[oldKey];
      if (updated.keybindings && updated.keybindings[oldKey]) {
        updated.keybindings[sanitizedKey] = updated.keybindings[oldKey];
        delete updated.keybindings[oldKey];
      }
      return updated;
    });
    setSelectedTui(sanitizedKey);
    setHasChanges(true);
  }, []);

  // --- Save / Reload ---
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (activeSection === 'raw') {
        await lee.globalConfig.saveRaw(rawYaml);
      } else {
        await lee.globalConfig.save(editedConfig);
      }
      setHasChanges(false);
      onSave();
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    try {
      const config = await lee.globalConfig.load();
      const initial = config ? JSON.parse(JSON.stringify(config)) : {};
      if (!initial.machines) initial.machines = [];
      if (!initial.tuis) initial.tuis = {};
      if (!initial.keybindings) initial.keybindings = {};
      if (!initial.terminal) initial.terminal = {};
      if (!initial.hester) initial.hester = {};
      setEditedConfig(initial);
      setHasChanges(false);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to reload config');
    }
  };

  if (!isOpen) return null;

  const machines: MachineConfig[] = editedConfig?.machines || [];
  const selectedMachineConfig = selectedMachine !== null ? machines[selectedMachine] : null;
  const tuiKeys = Object.keys(editedConfig?.tuis || {});
  const selectedTuiConfig = selectedTui ? editedConfig?.tuis?.[selectedTui] : null;

  return (
    <div className="config-modal-overlay" onClick={onClose}>
      <div className="config-modal" onClick={(e) => e.stopPropagation()}>
        <div className="config-modal-header">
          <h2>Lee Configuration</h2>
          <p>~/.lee/config.yaml</p>
          <button className="config-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="config-tabs">
          {(['machines', 'tuis', 'keybindings', 'terminal', 'hester', 'raw'] as GlobalTabSection[]).map(tab => (
            <button
              key={tab}
              className={`config-tab ${activeSection === tab ? 'active' : ''}`}
              onClick={() => setActiveSection(tab)}
            >
              {tab === 'raw' ? 'Raw YAML' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        <div className="config-modal-content">
          {/* Machines Section */}
          {activeSection === 'machines' && (
            <div className="config-tuis-section">
              <div className="config-tuis-sidebar">
                <div className="config-tuis-list">
                  {machines.map((m, i) => (
                    <button
                      key={i}
                      className={`config-tui-item ${selectedMachine === i ? 'active' : ''}`}
                      onClick={() => setSelectedMachine(i)}
                    >
                      <span className="tui-icon">{m.emoji || '🖥️'}</span>
                      <span className="tui-name">{m.name || 'Unnamed'}</span>
                    </button>
                  ))}
                </div>
                <button className="config-add-tui" onClick={handleAddMachine}>
                  + Add Machine
                </button>
              </div>

              {selectedMachineConfig && selectedMachine !== null && (
                <div className="config-tui-editor">
                  <div className="config-form-row">
                    <div className="config-form-group">
                      <label>Name</label>
                      <input
                        type="text"
                        value={selectedMachineConfig.name || ''}
                        onChange={(e) => handleMachineChange(selectedMachine, 'name', e.target.value)}
                        className="config-input"
                        placeholder="Pi Dock"
                      />
                    </div>
                    <div className="config-form-group config-form-small">
                      <label>Emoji</label>
                      <input
                        type="text"
                        value={selectedMachineConfig.emoji || ''}
                        onChange={(e) => handleMachineChange(selectedMachine, 'emoji', e.target.value)}
                        className="config-input"
                        placeholder="🖥️"
                      />
                    </div>
                  </div>

                  <div className="config-form-row">
                    <div className="config-form-group">
                      <label>Host</label>
                      <input
                        type="text"
                        value={selectedMachineConfig.host || ''}
                        onChange={(e) => handleMachineChange(selectedMachine, 'host', e.target.value)}
                        className="config-input"
                        placeholder="192.168.1.100"
                      />
                    </div>
                    <div className="config-form-group">
                      <label>User</label>
                      <input
                        type="text"
                        value={selectedMachineConfig.user || ''}
                        onChange={(e) => handleMachineChange(selectedMachine, 'user', e.target.value)}
                        className="config-input"
                        placeholder="pi"
                      />
                    </div>
                  </div>

                  <div className="config-form-row">
                    <div className="config-form-group">
                      <label>SSH Port</label>
                      <input
                        type="number"
                        value={selectedMachineConfig.ssh_port ?? 22}
                        onChange={(e) => handleMachineChange(selectedMachine, 'ssh_port', parseInt(e.target.value) || 22)}
                        className="config-input"
                        placeholder="22"
                      />
                    </div>
                    <div className="config-form-group">
                      <label>Lee Port</label>
                      <input
                        type="number"
                        value={selectedMachineConfig.lee_port ?? 9001}
                        onChange={(e) => handleMachineChange(selectedMachine, 'lee_port', parseInt(e.target.value) || 9001)}
                        className="config-input"
                        placeholder="9001"
                      />
                    </div>
                    <div className="config-form-group">
                      <label>Hester Port</label>
                      <input
                        type="number"
                        value={selectedMachineConfig.hester_port ?? 9000}
                        onChange={(e) => handleMachineChange(selectedMachine, 'hester_port', parseInt(e.target.value) || 9000)}
                        className="config-input"
                        placeholder="9000"
                      />
                    </div>
                  </div>

                  <div className="config-tui-actions">
                    <button
                      className="config-delete-btn"
                      onClick={() => handleDeleteMachine(selectedMachine)}
                    >
                      Delete Machine
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TUIs Section - same as ConfigEditorModal */}
          {activeSection === 'tuis' && (
            <div className="config-tuis-section">
              <div className="config-tuis-sidebar">
                <div className="config-tuis-list">
                  {tuiKeys.map((key) => (
                    <button
                      key={key}
                      className={`config-tui-item ${selectedTui === key ? 'active' : ''}`}
                      onClick={() => setSelectedTui(key)}
                    >
                      <span className="tui-icon">{editedConfig?.tuis?.[key]?.icon || '🔧'}</span>
                      <span className="tui-name">{editedConfig?.tuis?.[key]?.name || key}</span>
                    </button>
                  ))}
                </div>
                <button className="config-add-tui" onClick={handleAddTui}>
                  + Add TUI
                </button>
              </div>

              {selectedTuiConfig && selectedTui && (
                <div className="config-tui-editor">
                  <div className="config-form-group">
                    <label>Key (ID)</label>
                    <input
                      type="text"
                      value={selectedTui}
                      onChange={(e) => handleRenameTui(selectedTui, e.target.value)}
                      className="config-input"
                      placeholder="e.g., git, docker, sql"
                    />
                    <span className="config-input-hint">Lowercase, no spaces</span>
                  </div>

                  <div className="config-form-row">
                    <div className="config-form-group">
                      <label>Name</label>
                      <input
                        type="text"
                        value={selectedTuiConfig.name || ''}
                        onChange={(e) => handleTuiChange(selectedTui, 'name', e.target.value)}
                        className="config-input"
                        placeholder="Display name"
                      />
                    </div>
                    <div className="config-form-group config-form-small">
                      <label>Icon</label>
                      <input
                        type="text"
                        value={selectedTuiConfig.icon || ''}
                        onChange={(e) => handleTuiChange(selectedTui, 'icon', e.target.value)}
                        className="config-input"
                        placeholder="Emoji"
                      />
                    </div>
                  </div>

                  <div className="config-form-group">
                    <label>Command</label>
                    <input
                      type="text"
                      value={selectedTuiConfig.command || ''}
                      onChange={(e) => handleTuiChange(selectedTui, 'command', e.target.value)}
                      className="config-input"
                      placeholder="e.g., lazygit, btop, pgcli"
                    />
                  </div>

                  <div className="config-form-row">
                    <div className="config-form-group">
                      <label>Path Argument</label>
                      <input
                        type="text"
                        value={selectedTuiConfig.path_arg || ''}
                        onChange={(e) => handleTuiChange(selectedTui, 'path_arg', e.target.value)}
                        className="config-input"
                        placeholder="e.g., -p, --dir, cwd"
                      />
                    </div>
                    <div className="config-form-group">
                      <label>Keybinding</label>
                      <input
                        type="text"
                        value={editedConfig?.keybindings?.[selectedTui] || ''}
                        onChange={(e) => handleKeybindingChange(selectedTui, e.target.value)}
                        className="config-input"
                        placeholder="e.g., cmd+shift+g"
                      />
                    </div>
                  </div>

                  <div className="config-form-checkboxes">
                    <label className="config-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedTuiConfig.cwd_aware || false}
                        onChange={(e) => handleTuiChange(selectedTui, 'cwd_aware', e.target.checked)}
                      />
                      <span>Workspace aware</span>
                    </label>
                    <label className="config-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedTuiConfig.prewarm || false}
                        onChange={(e) => handleTuiChange(selectedTui, 'prewarm', e.target.checked)}
                      />
                      <span>Prewarm</span>
                    </label>
                  </div>

                  {selectedTuiConfig.command === 'pgcli' && (
                    <div className="config-connection-section">
                      <h4>Database Connection</h4>
                      <div className="config-form-row">
                        <div className="config-form-group">
                          <label>Host</label>
                          <input
                            type="text"
                            value={selectedTuiConfig.connection?.host || ''}
                            onChange={(e) => handleConnectionChange(selectedTui, 'host', e.target.value)}
                            className="config-input"
                            placeholder="127.0.0.1"
                          />
                        </div>
                        <div className="config-form-group config-form-small">
                          <label>Port</label>
                          <input
                            type="number"
                            value={selectedTuiConfig.connection?.port || ''}
                            onChange={(e) => handleConnectionChange(selectedTui, 'port', parseInt(e.target.value) || undefined)}
                            className="config-input"
                            placeholder="5432"
                          />
                        </div>
                      </div>
                      <div className="config-form-group">
                        <label>Database</label>
                        <input
                          type="text"
                          value={selectedTuiConfig.connection?.database || ''}
                          onChange={(e) => handleConnectionChange(selectedTui, 'database', e.target.value)}
                          className="config-input"
                          placeholder="postgres"
                        />
                      </div>
                      <div className="config-form-row">
                        <div className="config-form-group">
                          <label>User</label>
                          <input
                            type="text"
                            value={selectedTuiConfig.connection?.user || ''}
                            onChange={(e) => handleConnectionChange(selectedTui, 'user', e.target.value)}
                            className="config-input"
                            placeholder="postgres"
                          />
                        </div>
                        <div className="config-form-group">
                          <label>Password</label>
                          <input
                            type="password"
                            value={selectedTuiConfig.connection?.password || ''}
                            onChange={(e) => handleConnectionChange(selectedTui, 'password', e.target.value)}
                            className="config-input"
                            placeholder="••••••"
                          />
                        </div>
                      </div>
                      <label className="config-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedTuiConfig.connection?.ssl || false}
                          onChange={(e) => handleConnectionChange(selectedTui, 'ssl', e.target.checked)}
                        />
                        <span>Use SSL</span>
                      </label>
                    </div>
                  )}

                  <div className="config-tui-actions">
                    <button
                      className="config-delete-btn"
                      onClick={() => handleDeleteTui(selectedTui)}
                    >
                      Delete TUI
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Keybindings Section */}
          {activeSection === 'keybindings' && (
            <div className="config-keybindings-section">
              <div className="config-keybindings-grid">
                {Object.entries(editedConfig?.keybindings || {}).map(([action, binding]) => (
                  <div key={action} className="config-keybinding-row">
                    <label>{action.replace(/_/g, ' ')}</label>
                    <input
                      type="text"
                      value={binding as string}
                      onChange={(e) => handleKeybindingChange(action, e.target.value)}
                      className="config-input"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Terminal Section */}
          {activeSection === 'terminal' && (
            <div className="config-terminal-section">
              <div className="config-form-group">
                <label>Shell</label>
                <input
                  type="text"
                  value={editedConfig?.terminal?.shell || '/bin/bash'}
                  onChange={(e) => handleTerminalChange('shell', e.target.value)}
                  className="config-input"
                />
              </div>
              <div className="config-form-row">
                <div className="config-form-group">
                  <label>Scrollback</label>
                  <input
                    type="number"
                    value={editedConfig?.terminal?.scrollback || 10000}
                    onChange={(e) => handleTerminalChange('scrollback', parseInt(e.target.value))}
                    className="config-input"
                  />
                </div>
                <div className="config-form-group">
                  <label>Font Size</label>
                  <input
                    type="number"
                    value={editedConfig?.terminal?.font_size || 14}
                    onChange={(e) => handleTerminalChange('font_size', parseInt(e.target.value))}
                    className="config-input"
                  />
                </div>
              </div>
              <label className="config-checkbox">
                <input
                  type="checkbox"
                  checked={editedConfig?.terminal?.copy_on_select || false}
                  onChange={(e) => handleTerminalChange('copy_on_select', e.target.checked)}
                />
                <span>Copy on select</span>
              </label>
            </div>
          )}

          {/* Hester Section */}
          {activeSection === 'hester' && (
            <div className="config-hester-section">
              <div className="config-form-group">
                <label>Google API Key</label>
                <div className="config-secret-input">
                  <input
                    type="password"
                    value={editedConfig?.hester?.google_api_key || ''}
                    onChange={(e) => handleHesterChange('google_api_key', e.target.value)}
                    className="config-input"
                    placeholder="Enter your Google API key"
                  />
                </div>
                <span className="config-input-hint">Required for Gemini models. Stored in ~/.lee/config.yaml</span>
              </div>

              <div className="config-form-row">
                <div className="config-form-group">
                  <label>Model</label>
                  <input
                    type="text"
                    value={editedConfig?.hester?.model || ''}
                    onChange={(e) => handleHesterChange('model', e.target.value)}
                    className="config-input"
                    placeholder="gemini-2.5-flash"
                  />
                </div>
                <div className="config-form-group">
                  <label>Ollama URL</label>
                  <input
                    type="text"
                    value={editedConfig?.hester?.ollama_url || ''}
                    onChange={(e) => handleHesterChange('ollama_url', e.target.value)}
                    className="config-input"
                    placeholder="http://localhost:11434"
                  />
                </div>
              </div>

              <div className="config-form-checkboxes">
                <label className="config-checkbox">
                  <input
                    type="checkbox"
                    checked={editedConfig?.hester?.thinking_depth || false}
                    onChange={(e) => handleHesterChange('thinking_depth', e.target.checked)}
                  />
                  <span>Enable thinking depth</span>
                </label>
              </div>
            </div>
          )}

          {/* Raw YAML Section */}
          {activeSection === 'raw' && (
            <div className="config-raw-section">
              <textarea
                value={rawYaml}
                onChange={(e) => {
                  setRawYaml(e.target.value);
                  setHasChanges(true);
                }}
                className="config-raw-editor"
                spellCheck={false}
              />
            </div>
          )}
        </div>

        {error && (
          <div className="config-error">
            {error}
          </div>
        )}

        <div className="config-modal-footer">
          <button className="config-reload-btn" onClick={handleReload}>
            Reload
          </button>
          <div className="config-footer-right">
            <button className="config-cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className={`config-save-btn ${!hasChanges ? 'disabled' : ''}`}
              onClick={handleSave}
              disabled={!hasChanges || saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GlobalConfigEditorModal;
```

**Step 2: Commit**

```bash
git add electron/src/renderer/components/GlobalConfigEditorModal.tsx
git commit -m "feat: add GlobalConfigEditorModal component with Machines tab"
```

---

### Task 5: Wire GlobalConfigEditorModal into App.tsx

**Files:**
- Modify: `electron/src/renderer/App.tsx`

**Step 1: Add import**

Add near existing ConfigEditorModal import (~line 14 area):

```typescript
import { GlobalConfigEditorModal } from './components/GlobalConfigEditorModal';
```

**Step 2: Add state**

Add near existing `showConfigEditor` state (~line 97):

```typescript
  const [showGlobalConfigEditor, setShowGlobalConfigEditor] = useState<boolean>(false);
```

**Step 3: Add menu listener**

In the `useEffect` that sets up menu listeners (near the `lee.menu.onEditConfig` call ~line 1473), add:

```typescript
    lee.menu.onEditGlobalConfig(() => {
      setShowGlobalConfigEditor(true);
    });
```

**Step 4: Add modal to render**

After the existing `<ConfigEditorModal />` block (~line 1820), add:

```tsx
      <GlobalConfigEditorModal
        isOpen={showGlobalConfigEditor}
        onClose={() => setShowGlobalConfigEditor(false)}
        onSave={() => {
          setShowGlobalConfigEditor(false);
          // Reload machines since they may have changed
          if (lee?.machines?.reload) {
            lee.machines.reload();
          }
        }}
      />
```

**Step 5: Commit**

```bash
git add electron/src/renderer/App.tsx
git commit -m "feat: wire GlobalConfigEditorModal into App.tsx with menu listener"
```
