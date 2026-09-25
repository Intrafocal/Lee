/**
 * FocusControl - the "Focus" toggle in the attention flyout footer
 * (contracts §9.1, §5.3).
 */

import React from 'react';
import { Icon } from '../Icon';
import type { CopilotAPI, FocusState } from '../../../shared/copilot';

interface FocusControlProps {
  focus: FocusState;
  api: CopilotAPI;
  onStopAndHandoff: () => void;
}

export const FocusControl: React.FC<FocusControlProps> = ({ focus, api, onStopAndHandoff }) => {
  if (!focus.active) {
    return (
      <button className="copilot-flyout-footer-btn" onClick={() => void api.focusStart()}>
        <Icon name="eye" size={12} /> Focus
      </button>
    );
  }

  return (
    <button className="copilot-flyout-footer-btn is-active" onClick={() => void api.focusStop()} title="Stop focus">
      <Icon name="eye" size={12} /> Stop focus
      <span style={{ marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); onStopAndHandoff(); }}>
        · Hand off…
      </span>
    </button>
  );
};

export default FocusControl;
