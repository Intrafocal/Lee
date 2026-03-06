/**
 * BridgePicker - Select a machine, workspace, and TUI to run remotely via SSH.
 *
 * Flow:
 * 1. Select machine (or pre-selected from status bar right-click)
 * 2. Fetch remote context to discover workspace + TUIs
 * 3. Pick a TUI to run
 * 4. Parent spawns local PTY with: ssh -t user@host "cd /workspace && command args..."
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

export interface TUIOption {
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

  useEffect(() => {
    if (!preselectedMachine && lee?.machines) {
      lee.machines.getAll().then((states: MachineState[]) => setMachines(states));
    }
  }, [preselectedMachine]);

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

      const remoteTuis = ctx.workspaceConfig?.tuis || {};
      const tuiOptions: TUIOption[] = Object.entries(remoteTuis).map(([key, tui]: [string, any]) => ({
        key,
        name: tui.name || key,
        command: tui.command,
        args: tui.args,
      }));

      tuiOptions.unshift({
        key: 'terminal',
        name: 'Terminal',
        command: '$SHELL',
        args: ['-l'],
      });

      setTuis(tuiOptions);
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
      // Always offer Terminal even if remote context fetch fails
      setTuis([{
        key: 'terminal',
        name: 'Terminal',
        command: '$SHELL',
        args: ['-l'],
      }]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (selectedMachine?.online) {
      fetchRemoteTUIs(selectedMachine);
    }
  }, [selectedMachine, fetchRemoteTUIs]);

  const handleSpawn = (tui: TUIOption) => {
    if (selectedMachine) {
      onSpawn(selectedMachine.config, remoteWorkspace || '~', tui);
    }
  };

  return (
    <div className="bridge-picker-overlay" onClick={onCancel}>
      <div className="bridge-picker" onClick={(e) => e.stopPropagation()}>
        <div className="bridge-picker-header">
          <span className="bridge-picker-title">🌉 Bridge</span>
          <button className="bridge-picker-close" onClick={onCancel}>×</button>
        </div>

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
                  {m.online ? '●' : '○'}
                </span>
              </button>
            ))}
          </div>
        )}

        {selectedMachine && (
          <div className="bridge-section">
            <div className="bridge-section-label">
              {selectedMachine.config.emoji} {selectedMachine.config.name}
              {remoteWorkspace && (
                <span className="bridge-workspace"> — {remoteWorkspace.split('/').pop()}</span>
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
