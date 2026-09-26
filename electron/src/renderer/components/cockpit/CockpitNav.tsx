/**
 * CockpitNav - section list with badges (contracts §3.4). Ember when the
 * section has something that needs you; a neutral dot when there is only
 * something new to read (Copilot's fresh brief).
 */

import React from 'react';
import { SECTIONS, SECTION_LABELS, type SectionBadge, type SectionId } from '../../lib/cockpitModel';

export type NavBadges = Record<SectionId, SectionBadge>;

interface CockpitNavProps {
  section: SectionId;
  badges: NavBadges;
  onSelect: (section: SectionId) => void;
}

export const CockpitNav: React.FC<CockpitNavProps> = ({ section, badges, onSelect }) => (
  <nav className="cockpit-nav" aria-label="Cockpit sections">
    {SECTIONS.map((id, i) => {
      const b = badges[id];
      return (
        <button
          key={id}
          className={`cockpit-nav-item${section === id ? ' is-active' : ''}`}
          onClick={() => onSelect(id)}
          aria-current={section === id ? 'page' : undefined}
        >
          <span className="cockpit-nav-label">{SECTION_LABELS[id]}</span>
          {b.count > 0 && <span className={`cockpit-badge${b.ember ? ' is-ember' : ''}`}>{b.count}</span>}
          {b.count === 0 && b.dot && <span className="cockpit-badge-dot" aria-label="new" />}
          <kbd className="cockpit-nav-key">{i + 1}</kbd>
        </button>
      );
    })}
  </nav>
);

export default CockpitNav;
