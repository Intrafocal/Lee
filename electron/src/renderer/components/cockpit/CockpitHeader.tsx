/**
 * CockpitHeader - workspace, the mode switch, launch buttons and Focus
 * (contracts §3.4).
 */

import React, { useState } from 'react';
import { Icon } from '../Icon';
import type { CopilotAPI } from '../../../shared/copilot';
import { cockpitModeStore } from './cockpitMode';

interface CockpitHeaderProps {
  workspace: string;
  focusActive: boolean;
  copilotApi: CopilotAPI | null;
  toast: { message: string; level: 'info' | 'error' } | null;
  onLaunch: () => void;
  onRun: () => void;
  onHelp: () => void;
}

export const CockpitHeader: React.FC<CockpitHeaderProps> = ({ workspace, focusActive, copilotApi, toast, onLaunch, onRun, onHelp }) => {
  const [busy, setBusy] = useState(false);
  const name = workspace.split('/').filter(Boolean).pop() || workspace;

  const toggleFocus = () => {
    if (!copilotApi || busy) return;
    setBusy(true);
    const p = focusActive ? copilotApi.focusStop() : copilotApi.focusStart({ kind: 'workspace', workspace });
    p.catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <div className="cockpit-header">
      <span className="cockpit-header-ws" title={workspace}>
        <Icon name="folder" size={14} /> {name}
      </span>
      <div className="cockpit-mode-switch" role="group" aria-label="Mode">
        <button className="is-on" aria-pressed>
          Cockpit
        </button>
        <button onClick={() => cockpitModeStore.toggle('manual')} title="Switch to the Workbench (⌘0)">
          Workbench <kbd>⌘0</kbd>
        </button>
      </div>
      {toast && <span className={`cockpit-toast is-${toast.level}`}>{toast.message}</span>}
      <span className="cockpit-header-spacer" />
      <button className="cockpit-btn is-primary" onClick={onLaunch} title="New task (n)">
        <Icon name="plus" size={12} /> Task <kbd>n</kbd>
      </button>
      <button className="cockpit-btn" onClick={onRun} title="Operations (o)">
        <Icon name="play" size={12} /> Run <Icon name="chevron-down" size={10} /> <kbd>o</kbd>
      </button>
      {copilotApi && (
        <button className={`cockpit-btn${focusActive ? ' is-active' : ''}`} onClick={toggleFocus} disabled={busy}>
          <Icon name="eye" size={12} /> {focusActive ? 'Stop focus' : 'Focus'}
        </button>
      )}
      <button className="cockpit-btn is-icon" onClick={onHelp} title="Keys (?)" aria-label="Keyboard help">
        <Icon name="keyboard" size={14} />
      </button>
    </div>
  );
};

export default CockpitHeader;
