/**
 * ConfigEditorModal - GUI editor for .lee/config.yaml
 *
 * Provides a visual interface for editing Lee configuration including:
 * - TUI definitions (command, name, icon, keybinding)
 * - Terminal settings
 * - Keybindings
 */

import React, { useState, useEffect, useCallback } from 'react';

const lee = (window as any).lee;

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

interface ConfigEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: any) => void;
  onReload: () => void;
  config: any;
  workspace: string;
  initialSection?: TabSection;
}

type TabSection = 'tuis' | 'keybindings' | 'terminal' | 'hester' | 'raw';

export const ConfigEditorModal: React.FC<ConfigEditorModalProps> = ({
  isOpen,
  onClose,
  onSave,
  onReload,
  config,
  workspace,
  initialSection,
}) => {
  const [activeSection, setActiveSection] = useState<TabSection>(initialSection || 'tuis');
  const [editedConfig, setEditedConfig] = useState<any>(null);
  const [selectedTui, setSelectedTui] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [rawYaml, setRawYaml] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize edited config when modal opens
  useEffect(() => {
    if (isOpen) {
      const defaultConfig = { tuis: {}, keybindings: {}, terminal: {}, hester: {} };
      const initial = config ? JSON.parse(JSON.stringify(config)) : defaultConfig;
      // Ensure all sections exist even if config is partial
      if (!initial.tuis) initial.tuis = {};
      if (!initial.keybindings) initial.keybindings = {};
      if (!initial.terminal) initial.terminal = {};
      if (!initial.hester) initial.hester = {};
      setEditedConfig(initial);
      setHasChanges(false);
      setError(null);
      setActiveSection(initialSection || 'tuis');
      // Select first TUI if available
      const tuiKeys = Object.keys(initial.tuis || {});
      if (tuiKeys.length > 0) {
        setSelectedTui(tuiKeys[0]);
      }
    }
  }, [isOpen, config, initialSection]);

  // Load raw YAML when switching to raw tab
  useEffect(() => {
    if (activeSection === 'raw' && workspace && lee) {
      loadRawYaml();
    }
  }, [activeSection, workspace]);

  const loadRawYaml = async () => {
    try {
      const content = await lee.config.getRaw(workspace);
      setRawYaml(content || '');
    } catch (err) {
      console.error('Failed to load raw config:', err);
      setRawYaml('# Failed to load config file');
    }
  };

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
      // Also remove keybinding
      if (updated.keybindings && updated.keybindings[tuiKey]) {
        delete updated.keybindings[tuiKey];
      }
      return updated;
    });
    setSelectedTui(null);
    setHasChanges(true);
  }, []);

  const handleRenameTui = useCallback((oldKey: string, newKey: string) => {
    // Don't rename if key is empty or same
    if (!newKey.trim() || newKey === oldKey) return;

    // Sanitize key: lowercase, replace spaces with underscores
    const sanitizedKey = newKey.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    if (!sanitizedKey) return;

    setEditedConfig((prev: any) => {
      const updated = { ...prev };
      if (!updated.tuis || !updated.tuis[oldKey]) return prev;

      // Copy TUI config to new key
      updated.tuis[sanitizedKey] = updated.tuis[oldKey];
      delete updated.tuis[oldKey];

      // Move keybinding if exists
      if (updated.keybindings && updated.keybindings[oldKey]) {
        updated.keybindings[sanitizedKey] = updated.keybindings[oldKey];
        delete updated.keybindings[oldKey];
      }

      return updated;
    });
    setSelectedTui(sanitizedKey);
    setHasChanges(true);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (activeSection === 'raw') {
        // Save raw YAML
        await lee.config.saveRaw(workspace, rawYaml);
      } else {
        // Save structured config
        await lee.config.save(workspace, editedConfig);
      }
      setHasChanges(false);
      onSave(editedConfig);
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    try {
      await onReload();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to reload config');
    }
  };

  if (!isOpen) return null;

  const tuiKeys = Object.keys(editedConfig?.tuis || {});
  const selectedTuiConfig = selectedTui ? editedConfig?.tuis?.[selectedTui] : null;

  return (
    <div className="config-modal-overlay" onClick={onClose}>
      <div className="config-modal" onClick={(e) => e.stopPropagation()}>
        <div className="config-modal-header">
          <h2>Configuration</h2>
          <p>{workspace}/.lee/config.yaml</p>
          <button className="config-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Section tabs */}
        <div className="config-tabs">
          <button
            className={`config-tab ${activeSection === 'tuis' ? 'active' : ''}`}
            onClick={() => setActiveSection('tuis')}
          >
            TUIs
          </button>
          <button
            className={`config-tab ${activeSection === 'keybindings' ? 'active' : ''}`}
            onClick={() => setActiveSection('keybindings')}
          >
            Keybindings
          </button>
          <button
            className={`config-tab ${activeSection === 'terminal' ? 'active' : ''}`}
            onClick={() => setActiveSection('terminal')}
          >
            Terminal
          </button>
          <button
            className={`config-tab ${activeSection === 'hester' ? 'active' : ''}`}
            onClick={() => setActiveSection('hester')}
          >
            Hester
          </button>
          <button
            className={`config-tab ${activeSection === 'raw' ? 'active' : ''}`}
            onClick={() => setActiveSection('raw')}
          >
            Raw YAML
          </button>
        </div>

        <div className="config-modal-content">
          {/* TUIs Section */}
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

                  {/* SQL Connection section (only show if command is pgcli) */}
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
                <span className="config-input-hint">Required for Gemini models. Stored in .lee/config.yaml</span>
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

export default ConfigEditorModal;
