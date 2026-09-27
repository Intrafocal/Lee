/**
 * FocusControl - "Go deep" in the attention flyout footer (contracts §9.1;
 * Deep D1 §14: manual Focus is retired into Go deep). While a Deep session
 * is active it offers End session instead.
 */

import React from 'react';
import { Icon } from '../Icon';
import type { CopilotAPI, FocusState } from '../../../shared/copilot';
import { endDeepSession, goDeep } from '../cockpit/cockpitMode';

interface FocusControlProps {
  focus: FocusState;
  api: CopilotAPI;
  workspace: string;
  /** Close the flyout before the mode changes under it. */
  onDone: () => void;
}

export const FocusControl: React.FC<FocusControlProps> = ({ focus, api, workspace, onDone }) => {
  if (focus.active && focus.source === 'deep') {
    return (
      <button
        className="copilot-flyout-footer-btn"
        onClick={() => {
          onDone();
          endDeepSession(api);
        }}
        title="End the Deep session"
      >
        <Icon name="eye" size={12} /> End session…
      </button>
    );
  }

  return (
    <button
      className="copilot-flyout-footer-btn"
      onClick={() => {
        onDone();
        goDeep(api, workspace);
      }}
      title="Go deep: pick up your exploration, or start one"
    >
      <Icon name="eye" size={12} /> Go deep
    </button>
  );
};

export default FocusControl;
