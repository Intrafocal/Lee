/**
 * CockpitModeChip - status-bar chip: "Cockpit" / "Workbench ⌘0", with an ember
 * count of needs-you Feed entries while in the Workbench. Click toggles.
 * Renders nothing when the Cockpit is off.
 */

import React from 'react';
import { cockpitModeStore, useCockpitModeState } from './cockpitMode';
import './cockpit.css';

export const CockpitModeChip: React.FC = () => {
  const s = useCockpitModeState();
  if (!s.enabled) return null;
  const workbench = s.mode === 'manual';
  return (
    <button
      className={`cockpit-mode-chip${workbench ? ' is-workbench' : ''}`}
      onClick={() => cockpitModeStore.toggle('manual')}
      title={workbench ? 'Back to the Cockpit (⌘0)' : 'Go to the Workbench (⌘0)'}
    >
      {workbench ? 'Workbench' : 'Cockpit'}
      <kbd>⌘0</kbd>
      {workbench && s.needsCount > 0 && <span className="cockpit-badge is-ember">{s.needsCount}</span>}
    </button>
  );
};

export default CockpitModeChip;
