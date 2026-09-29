/**
 * CockpitModeChip - status-bar chip naming the mode (Cockpit / Deep /
 * Manual), with an ember count of needs-you Feed entries while in Manual.
 * Click (or right-click) opens the ⌘0 switcher's cards (Deep D1 §1.3); while
 * a Deep session is active they also offer End session. Renders nothing when
 * the Cockpit is off.
 */

import React from 'react';
import { MODE_LABELS } from '../../lib/cockpitModel';
import { cockpitModeStore, useCockpitModeState } from './cockpitMode';
import './cockpit-shell.css';

export const CockpitModeChip: React.FC = () => {
  const s = useCockpitModeState();
  if (!s.enabled) return null;
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    cockpitModeStore.switcher({ kind: 'chip', lastMode: s.lastMode });
  };
  return (
    <button
      className={`cockpit-mode-chip${s.mode === 'cockpit' ? '' : ` is-${s.mode}`}`}
      onClick={open}
      onContextMenu={open}
      title={s.deepActive ? 'Switch mode, or end the Deep session (⌘0)' : 'Switch mode (⌘0)'}
    >
      {MODE_LABELS[s.mode]}
      <kbd>⌘0</kbd>
      {s.mode === 'manual' && s.needsCount > 0 && <span className="cockpit-badge is-ember">{s.needsCount}</span>}
    </button>
  );
};

export default CockpitModeChip;
