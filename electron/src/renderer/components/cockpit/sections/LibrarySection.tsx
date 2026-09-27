/**
 * LibrarySection - Library: explorations, ideas and files in one column of
 * --col-library (cockpit-design §5; package R2). Replaces Explore, Someday
 * and Files.
 *
 * The head: "Library", the Explorations / Ideas / Files tabs (a segmented
 * control) and a quiet "New exploration". Below it, find: a borderless
 * field that filters the current tab by title and text, client-side. Each
 * tab is its own part (ExploreSection, SomedaySection, FilesSection).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Btn, SectionHead } from '../ui';
import type { CockpitCtx } from '../CockpitHost';
import { ExploreSection } from './ExploreSection';
import { SomedaySection } from './SomedaySection';
import { FilesSection } from './FilesSection';

type LibraryTab = 'explorations' | 'ideas' | 'files';

const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'explorations', label: 'Explorations' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'files', label: 'Files' },
];

const FIND_PLACEHOLDER: Record<LibraryTab, string> = {
  explorations: 'Find an exploration',
  ideas: 'Find an idea',
  files: 'Find a loaded file',
};

interface LibrarySectionProps {
  ctx: CockpitCtx;
  /** Bumped by the Cockpit's "Explore": show Explorations and focus the new-exploration field. */
  focusCreateNonce: number;
}

export const LibrarySection: React.FC<LibrarySectionProps> = ({ ctx, focusCreateNonce }) => {
  const selectedId = ctx.mode.selected?.kind === 'row' ? ctx.mode.selected.id : null;
  const [tab, setTab] = useState<LibraryTab>('explorations');
  const [find, setFind] = useState('');
  const [createNonce, setCreateNonce] = useState(0);
  const findRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selectedId?.startsWith('explore:')) setTab('explorations');
    else if (selectedId?.startsWith('someday:')) setTab('ideas');
  }, [selectedId]);

  const newExploration = () => {
    setTab('explorations');
    setCreateNonce((n) => n + 1);
  };
  useEffect(() => {
    if (focusCreateNonce) newExploration();
  }, [focusCreateNonce]);

  const pick = (next: LibraryTab) => {
    setTab(next);
    setFind('');
  };

  return (
    <div className="library">
      <SectionHead
        title="Library"
        right={
          <Btn kind="quiet" onClick={newExploration}>
            New exploration
          </Btn>
        }
      />
      <div className="library-tabs" role="tablist" aria-label="Library">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`library-tabs-item${tab === t.id ? ' is-on' : ''}`}
            onClick={() => pick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="library-find">
        <input
          ref={findRef}
          className="library-find-field"
          value={find}
          placeholder={FIND_PLACEHOLDER[tab]}
          aria-label={FIND_PLACEHOLDER[tab]}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && find) {
              e.preventDefault();
              e.stopPropagation();
              setFind('');
            }
          }}
        />
      </div>
      {tab === 'explorations' && <ExploreSection ctx={ctx} find={find} createNonce={createNonce} />}
      {tab === 'ideas' && <SomedaySection ctx={ctx} find={find} />}
      {tab === 'files' && <FilesSection ctx={ctx} filter={find} />}
    </div>
  );
};

export default LibrarySection;
