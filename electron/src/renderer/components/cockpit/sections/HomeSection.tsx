/**
 * HomeSection - Home, the desk (cockpit-design §3; package R1).
 *
 * Scaffold stub: renders today's Copilot section unchanged so the app keeps
 * working until R1 rewrites it (greeting, question, Pick up, Meanwhile).
 */

import React from 'react';
import type { AboutRef } from '../../../../shared/cockpit';
import type { CockpitCtx } from '../CockpitHost';
import { CopilotSection } from './CopilotSection';

interface HomeSectionProps {
  ctx: CockpitCtx;
  about: AboutRef | null;
  onClearAbout: () => void;
  onAsk: (prompt: string) => void;
  returnNonce: number;
}

export const HomeSection: React.FC<HomeSectionProps> = (props) => <CopilotSection {...props} />;

export default HomeSection;
