/**
 * ConfigEditorModal - GUI editor for .lee/config.yaml
 *
 * Provides a visual interface for editing Lee configuration including:
 * - TUI definitions (command, name, icon, keybinding)
 * - Terminal settings
 * - Keybindings
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { ConfigSources } from '../../shared/lee-api';

const lee = window.lee;

/** `/Users/ben/.lee/config.yaml` -> `~/.lee/config.yaml` */
function prettyPath(p: string | undefined): string {
  if (!p) return '';
  const match = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)$/);
  return match ? `~${match[2]}` : p;
}

/**
 * C20: the structured view shows the MERGED config, so a value the user is
 * looking at may live in ~/.lee/config.yaml rather than in this workspace.
 * Label each section with the file its keys actually came from, so saving
 * (which writes the workspace file) isn't a surprise.
 */
const SourceHint: React.FC<{ path?: string; fallback?: string }> = ({ path, fallback }) => {
  const shown = path ?? fallback;
  if (!shown) return null;
  return (
    <div className="config-source-hint" title={shown}>
      from: {prettyPath(shown)}
    </div>
  );
};


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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // C20: provenance of each top-level key, plus the two editable raw files.
  const [sources, setSources] = useState<ConfigSources | null>(null);
  const [rawTarget, setRawTarget] = useState<'workspace' | 'global'>('workspace');
  const [rawWorkspaceYaml, setRawWorkspaceYaml] = useState('');
  const [rawGlobalYaml, setRawGlobalYaml] = useState('');
  /**
   * Which file a newly-entered Google API key should be written to.
   * Defaults to the global file: it's a machine-wide credential, and writing
   * it into <ws>/.lee/config.yaml is how it ended up in a git repo before.
   */
  const [apiKeyTarget, setApiKeyTarget] = useState<'global' | 'workspace'>('global');

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

  // Where each top-level key came from (for the section hints)
  useEffect(() => {
    if (!isOpen || !workspace || !lee) return;
    lee.config.sources(workspace)
      .then((result) => setSources(result))
      .catch((err) => {
        console.error('Failed to resolve config provenance:', err);
        setSources(null);
      });
  }, [isOpen, workspace]);

  // Load BOTH raw files when switching to the raw tab - the tab is a picker
  // between the workspace file and the global one, each saved to its own path.
  useEffect(() => {
    if (activeSection === 'raw' && workspace && lee) {
      loadRawYaml();
    }
  }, [activeSection, workspace]);

  const loadRawYaml = async () => {
    try {
      const [ws, global] = await Promise.all([
        lee.config.getRaw(workspace),
        lee.globalConfig.getRaw(),
      ]);
      setRawWorkspaceYaml(ws ?? '');
      setRawGlobalYaml(global ?? '');
    } catch (err) {
      console.error('Failed to load raw config:', err);
      setError(`Couldn't read the config files: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const rawYaml = rawTarget === 'global' ? rawGlobalYaml : rawWorkspaceYaml;
  const rawPath = rawTarget === 'global'
    ? sources?.paths.global
    : (sources?.paths.workspace ?? `${workspace}/.lee/config.yaml`);

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
        // Each raw buffer is saved to its own file, never merged into the other.
        const result = rawTarget === 'global'
          ? await lee.globalConfig.saveRaw(rawGlobalYaml)
          : await lee.config.saveRaw(workspace, rawWorkspaceYaml);
        if (!result.success) throw new Error(result.error || 'Failed to save config');
      } else {
        const toSave = JSON.parse(JSON.stringify(editedConfig ?? {}));

        // The API key is a machine-wide credential: unless the user
        // deliberately chose this workspace, it goes to ~/.lee/config.yaml
        // and is stripped from what we write into <ws>/.lee/config.yaml.
        if (apiKeyTarget === 'global') {
          const key: string | undefined = toSave?.hester?.google_api_key;
          if (toSave.hester) delete toSave.hester.google_api_key;
          const globalConfig = (await lee.globalConfig.load()) || {};
          const hester = { ...(globalConfig.hester || {}) };
          if (key) hester.google_api_key = key;
          else delete hester.google_api_key;
          globalConfig.hester = hester;
          const globalResult = await lee.globalConfig.save(globalConfig);
          if (!globalResult.success) {
            throw new Error(globalResult.error || 'Failed to save ~/.lee/config.yaml');
          }
        }

        const result = await lee.config.save(workspace, toSave);
        if (!result.success) throw new Error(result.error || 'Failed to save config');
      }
      setHasChanges(false);
      // Refresh provenance - a key may have moved between files.
      lee.config.sources(workspace).then(setSources).catch(() => {
        // Non-fatal: the hints just keep showing their previous values.
      });
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
          <p title={(sources?.sources || []).join('\n')}>
            merged from {(sources?.sources || [`${workspace}/.lee/config.yaml`]).map(prettyPath).join('  ←  ')}
          </p>
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
              <SourceHint path={sources?.keySources?.tuis} />
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
              <SourceHint path={sources?.keySources?.keybindings} />
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
              <SourceHint path={sources?.keySources?.terminal} />
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
              <SourceHint path={sources?.keySources?.hester} />
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
                <div className="config-radio-row">
                  <label className="config-checkbox">
                    <input
                      type="radio"
                      name="api-key-target"
                      checked={apiKeyTarget === 'global'}
                      onChange={() => { setApiKeyTarget('global'); setHasChanges(true); }}
                    />
                    <span>Save to {prettyPath(sources?.paths.global) || '~/.lee/config.yaml'} (all workspaces)</span>
                  </label>
                  <label className="config-checkbox">
                    <input
                      type="radio"
                      name="api-key-target"
                      checked={apiKeyTarget === 'workspace'}
                      onChange={() => { setApiKeyTarget('workspace'); setHasChanges(true); }}
                    />
                    <span>Save to this workspace only</span>
                  </label>
                </div>
                <span className="config-input-hint">
                  Required for Gemini models. The global file is the safer home for it -
                  a workspace config can end up committed to the project's repo.
                </span>
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
              <div className="config-raw-picker">
                <button
                  className={`config-raw-file ${rawTarget === 'workspace' ? 'active' : ''}`}
                  onClick={() => setRawTarget('workspace')}
                >
                  {prettyPath(sources?.paths.workspace) || `${workspace}/.lee/config.yaml`}
                </button>
                <button
                  className={`config-raw-file ${rawTarget === 'global' ? 'active' : ''}`}
                  onClick={() => setRawTarget('global')}
                >
                  {prettyPath(sources?.paths.global) || '~/.lee/config.yaml'}
                </button>
                <span className="config-raw-path-note">
                  Each file is edited and saved on its own; the structured tabs show them merged.
                </span>
              </div>
              <textarea
                value={rawYaml}
                onChange={(e) => {
                  if (rawTarget === 'global') setRawGlobalYaml(e.target.value);
                  else setRawWorkspaceYaml(e.target.value);
                  setHasChanges(true);
                }}
                className="config-raw-editor"
                spellCheck={false}
                placeholder={`# ${rawPath} (does not exist yet - saving creates it)`}
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
              {saving
                ? 'Saving...'
                : activeSection === 'raw'
                  ? `Save ${rawTarget === 'global' ? 'Lee config' : 'workspace config'}`
                  : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigEditorModal;
