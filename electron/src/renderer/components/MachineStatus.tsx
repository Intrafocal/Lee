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

    lee.machines.getAll().then((states: MachineState[]) => setMachines(states));

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
