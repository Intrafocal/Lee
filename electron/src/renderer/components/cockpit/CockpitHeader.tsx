/**
 * CockpitHeader - workspace, the mode switch (Cockpit, Deep ⇧⌘0, Manual
 * ⌥⌘0), launch buttons and Go deep (contracts §3.4; Deep D1 §1.4, §14).
 */

import React from 'react';
import { Icon } from '../Icon';
import type { CopilotAPI } from '../../../shared/copilot';
import { cockpitModeStore, goDeep } from './cockpitMode';

interface CockpitHeaderProps {
  workspace: string;
  /** A Deep session is active in this workspace: Go deep hops back to it. */
  deepActive: boolean;
  copilotApi: CopilotAPI | null;
  toast: { message: string; level: 'info' | 'error' } | null;
  onLaunch: () => void;
  onExplore: () => void;
  onRun: () => void;
  onHelp: () => void;
}

export const CockpitHeader: React.FC<CockpitHeaderProps> = ({ workspace, deepActive, copilotApi, toast, onLaunch, onExplore, onRun, onHelp }) => {
  const name = workspace.split('/').filter(Boolean).pop() || workspace;

  return (
    <div className="cockpit-header">
      <span className="cockpit-header-ws" title={workspace}>
        <Icon name="folder" size={14} /> {name}
      </span>
      <div className="cockpit-mode-switch" role="group" aria-label="Mode">
        <button className="is-on" aria-pressed>
          Cockpit
        </button>
        <button onClick={() => cockpitModeStore.toggleDeep()} title="Deep: the Page you're thinking in (⇧⌘0)">
          Deep <kbd>⇧⌘0</kbd>
        </button>
        <button onClick={() => cockpitModeStore.toggleManual()} title="Manual: every tab, nothing hidden (⌥⌘0)">
          Manual <kbd>⌥⌘0</kbd>
        </button>
      </div>
      {toast && <span className={`cockpit-toast is-${toast.level}`}>{toast.message}</span>}
      <span className="cockpit-header-spacer" />
      <button className="cockpit-btn is-primary" onClick={onLaunch} title="New task (⌘N)">
        <Icon name="plus" size={12} /> Task <kbd>⌘N</kbd>
      </button>
      <button className="cockpit-btn" onClick={onExplore} title="New exploration (Explore section)">
        <Icon name="plus" size={12} /> Explore
      </button>
      <button className="cockpit-btn" onClick={onRun} title="Operations (⌘{)">
        <Icon name="play" size={12} /> Run <Icon name="chevron-down" size={10} /> <kbd>{'⌘{'}</kbd>
      </button>
      <button
        className={`cockpit-btn${deepActive ? ' is-active' : ''}`}
        onClick={() => goDeep(copilotApi, workspace)}
        title={deepActive ? 'Back to your Deep session' : 'Go deep: pick up your exploration, or start one'}
      >
        <Icon name="eye" size={12} /> {deepActive ? 'Back to Deep' : 'Go deep'}
      </button>
      <button className="cockpit-btn is-icon" onClick={onHelp} title="Keys" aria-label="Keyboard help">
        <Icon name="keyboard" size={14} />
      </button>
    </div>
  );
};

export default CockpitHeader;
