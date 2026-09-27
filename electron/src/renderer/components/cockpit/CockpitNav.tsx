/**
 * CockpitNav - the icon rail (cockpit-design §2.1): a 56px column of 36px
 * icon buttons, one per section, each with an aria-label and a tooltip
 * carrying its name. The active one gets a --ground-3 fill. The only badge
 * is a 6px ember dot when the section holds something that needs you
 * (railDots); there are no counts.
 */

import React from 'react';
import { Icon, type IconName } from '../Icon';
import { SECTIONS, SECTION_LABELS, type SectionId } from '../../lib/cockpitModel';

/** Which sections hold something that needs you (the ember dot). */
export type NavDots = Record<SectionId, boolean>;

/**
 * Rail icons. §2.2 asks for house, tray, target, books, play and clock;
 * the icon set has no tray or target yet, so Work and Goals use the
 * closest existing glyphs until design/icons.json gains them.
 */
const SECTION_ICONS: Record<SectionId, IconName> = {
  home: 'home',
  work: 'list',
  goals: 'circle',
  library: 'book',
  ops: 'play',
  history: 'clock',
};

interface CockpitNavProps {
  section: SectionId;
  dots: NavDots;
  onSelect: (section: SectionId) => void;
}

export const CockpitNav: React.FC<CockpitNavProps> = ({ section, dots, onSelect }) => (
  <nav className="cockpit-rail" aria-label="Cockpit sections">
    {SECTIONS.map((id, i) => {
      const label = SECTION_LABELS[id];
      const active = section === id;
      return (
        <button
          key={id}
          type="button"
          className={`cockpit-rail-item${active ? ' is-active' : ''}`}
          onClick={() => onSelect(id)}
          aria-label={dots[id] ? `${label}, needs you` : label}
          aria-current={active ? 'page' : undefined}
          data-tip={`${label} ⌘${i + 1}`}
          aria-keyshortcuts={`Meta+${i + 1}`}
        >
          <Icon name={SECTION_ICONS[id]} size={18} />
          {dots[id] && <span className="cockpit-rail-dot" aria-hidden="true" />}
        </button>
      );
    })}
  </nav>
);

export default CockpitNav;
