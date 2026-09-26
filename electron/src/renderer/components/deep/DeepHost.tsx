/**
 * DeepHost - the Deep mode overlay (Deep D1 §4.1): a portal like CockpitHost,
 * shown when this window's mode is 'deep' and an exploration is open.
 *
 * Scaffold stub (D1 §14): the final props, rendering nothing. Package R2
 * builds the Page, margin, header and ending ritual here.
 */

import type { LeeMode } from '../../../shared/cockpit';
import type { UseCopilotResult } from '../../hooks/useCopilot';

export interface DeepHostProps {
  workspace: string;
  visible: boolean;                 // this window's mode is 'deep'
  explorationId: string | null;
  copilot: UseCopilotResult;        // snapshot for the wake line and "N waiting"
  onHop: (to: LeeMode) => void;     // header hint and the wake line
}

export function DeepHost(_props: DeepHostProps): JSX.Element | null {
  return null;
}
