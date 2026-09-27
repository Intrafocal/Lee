/**
 * LibrarySection - Library: explorations, ideas and files (cockpit-design §5;
 * package R2).
 *
 * Scaffold stub: today's Explore, Someday and Files sections behind a small
 * switch, so the app keeps working until R2 builds the one-column Library. A
 * selected exploration row, or "New exploration", shows Explore.
 */

import React, { useEffect, useState } from 'react';
import type { CockpitCtx } from '../CockpitHost';
import { ExploreSection } from './ExploreSection';
import { SomedaySection } from './SomedaySection';
import { FilesSection } from './FilesSection';

type LibraryPart = 'explore' | 'someday' | 'files';

const PARTS: { id: LibraryPart; label: string }[] = [
  { id: 'explore', label: 'Explorations' },
  { id: 'someday', label: 'Ideas' },
  { id: 'files', label: 'Files' },
];

interface LibrarySectionProps {
  ctx: CockpitCtx;
  /** Bumped by "+ Explore": show Explore and focus its new-exploration field. */
  focusCreateNonce: number;
}

export const LibrarySection: React.FC<LibrarySectionProps> = ({ ctx, focusCreateNonce }) => {
  const selectedId = ctx.mode.selected?.kind === 'row' ? ctx.mode.selected.id : null;
  const [part, setPart] = useState<LibraryPart>('explore');
  useEffect(() => {
    if (selectedId?.startsWith('explore:')) setPart('explore');
  }, [selectedId]);
  useEffect(() => {
    if (focusCreateNonce) setPart('explore');
  }, [focusCreateNonce]);

  return (
    <>
      <div className="cockpit-chips" role="tablist" aria-label="Library">
        {PARTS.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={part === p.id}
            className={`cockpit-chip-btn${part === p.id ? ' is-on' : ''}`}
            onClick={() => setPart(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {part === 'explore' && <ExploreSection ctx={ctx} focusCreateNonce={focusCreateNonce} />}
      {part === 'someday' && <SomedaySection ctx={ctx} />}
      {part === 'files' && <FilesSection ctx={ctx} />}
    </>
  );
};

export default LibrarySection;
