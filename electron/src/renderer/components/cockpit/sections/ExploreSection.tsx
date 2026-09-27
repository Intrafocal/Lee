/**
 * ExploreSection - Library's Explorations tab (cockpit-design §5; package
 * R2). One Card per active exploration, newest touched first: the title and
 * when you last touched it, where you stopped (the last session's
 * stopped_at, else the Page's last non-empty line) in your own words, and
 * "about n words · n answers · n open questions", plus "quiet" after 7 days.
 * Clicking a card opens it in Deep (D1 §8.3). The ⋯ menu: Open tree
 * (Manual), Open file, Archive, Archive as knowledge. Archived ones fold at
 * the bottom.
 *
 * The tree's own tools (spikes, decisions, promotes) live in the Library tab
 * in Manual ("Open tree").
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatAge } from '../../../lib/cockpitModel';
import {
  archiveExploration,
  createExploration,
  listExplorations,
  patchExploration,
  workspacePath,
  type Exploration,
} from '../../../lib/hesterCockpit';
import { getPage } from '../../../lib/hesterDeep';
import { explorationMeta, lastPageLine, matchesFind, sortByTouched, type ExplorationDeep } from '../../../lib/workModel';
import { Btn, Card, Eyebrow, WritingQuote } from '../ui';
import { MoreMenu } from '../work/MoreMenu';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

type LibExploration = Exploration & ExplorationDeep;

/** Pages fetched for their last line (cards with no stopped_at), at most this many per load. */
const PAGE_PEEK_LIMIT = 12;

interface ExploreSectionProps {
  ctx: CockpitCtx;
  /** Library's find text. */
  find: string;
  /** "New exploration" (or the Cockpit's + Explore) bumps this: show and focus the new field. */
  createNonce: number;
}

export const ExploreSection: React.FC<ExploreSectionProps> = ({ ctx, find, createNonce }) => {
  const workspace = ctx.workspace;
  const [items, setItems] = useState<LibExploration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastLines, setLastLines] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [seed, setSeed] = useState('');
  const createRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    void listExplorations(workspace, 'all').then((r) => {
      if (r.ok) {
        setItems(r.data as LibExploration[]);
        setError(null);
      } else setError(r.error);
    });
  }, [workspace]);

  useEffect(() => {
    setItems(null);
    setLastLines({});
    load();
  }, [load]);

  useEffect(() => {
    if (!createNonce) return;
    setCreating(true);
    window.setTimeout(() => createRef.current?.focus(), 0);
  }, [createNonce]);

  // Where you stopped, when no session recorded it: the Page's last line.
  const peeked = useRef(new Set<string>());
  useEffect(() => {
    if (!items) return;
    const want = sortByTouched(items.filter((e) => e.status !== 'archived'))
      .filter((e) => !e.last_session?.stopped_at && (e.page_chars ?? 0) > 0 && !peeked.current.has(e.id))
      .slice(0, PAGE_PEEK_LIMIT);
    for (const e of want) {
      peeked.current.add(e.id);
      void getPage(workspace, e.id).then((r) => {
        if (!r.ok) return;
        const line = lastPageLine(r.data.text);
        if (line) setLastLines((m) => ({ ...m, [e.id]: line }));
      });
    }
  }, [items, workspace]);

  const create = async () => {
    const body = seed.trim();
    if (!body || busy) return;
    setBusy('create');
    try {
      const r = await createExploration(workspace, { seed: body, origin: { kind: 'cockpit' } });
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        return;
      }
      setSeed('');
      setCreating(false);
      load();
      await ctx.openExploration(r.data);
    } finally {
      setBusy(null);
    }
  };

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const archive = (exp: Exploration, asKnowledge: boolean) =>
    withBusy(exp.id, async () => {
      const r = await archiveExploration(workspace, exp.id, asKnowledge);
      if (!r.ok) ctx.notify(r.error, 'error');
      else if (asKnowledge && r.data.knowledge_path) ctx.notify(`Archived as knowledge: ${r.data.knowledge_path}`);
      else ctx.notify('Archived');
      load();
    });

  const unarchive = (exp: Exploration) =>
    withBusy(exp.id, async () => {
      const r = await patchExploration(workspace, exp.id, { status: 'active' });
      if (!r.ok) ctx.notify(r.error, 'error');
      load();
    });

  const open = (exp: Exploration) => withBusy(exp.id, () => ctx.openExploration(exp));
  const pagePath = (id: string) => workspacePath(workspace, `.hester/explore/${id}/page.md`);
  const quoteOf = (e: LibExploration) => e.last_session?.stopped_at || lastLines[e.id] || '';

  const all = sortByTouched(items ?? []).filter((e) => matchesFind(find, [e.title, e.seed, quoteOf(e)]));
  const active = all.filter((e) => e.status !== 'archived');
  const archived = all.filter((e) => e.status === 'archived');
  const shown = showArchived ? [...active, ...archived] : active;

  const handles: RowHandle[] = shown.map((e) => ({
    id: `explore:${e.id}`,
    title: e.title,
    open: () => void open(e),
    about: { kind: 'exploration', id: e.id, label: e.title },
  }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected?.kind === 'row' ? ctx.mode.selected.id : null;

  const card = (e: LibExploration) => {
    const id = `explore:${e.id}`;
    const isArchived = e.status === 'archived';
    const quote = quoteOf(e);
    return (
      <div key={e.id} data-cockpit-row={id} className="library-card-slot">
        <Card onOpen={() => void open(e)} selected={sel === id} label={`Open ${e.title} in Deep`} className={isArchived ? 'is-archived' : undefined}>
          <div className="library-card-head">
            <span className="library-card-title">{e.title}</span>
            <span className="library-card-age">{formatAge(e.last_touched_at ?? e.updated_at, ctx.now)}</span>
            <MoreMenu
              label={`More for ${e.title}`}
              items={[
                { label: 'Open tree (Manual)', onClick: () => ctx.openLibrary(e.id) },
                { label: 'Open file', onClick: () => ctx.openFile(pagePath(e.id)) },
                ...(isArchived
                  ? [{ label: 'Unarchive', onClick: () => void unarchive(e), disabled: busy === e.id }]
                  : [
                      { label: 'Archive', onClick: () => void archive(e, false), disabled: busy === e.id },
                      { label: 'Archive as knowledge', onClick: () => void archive(e, true), disabled: busy === e.id },
                    ]),
              ]}
            />
          </div>
          {quote && <WritingQuote text={quote} size={17} />}
          <div className="library-card-meta">{explorationMeta(e, ctx.now)}</div>
        </Card>
      </div>
    );
  };

  return (
    <div className="library-tab">
      {creating && (
        <div className="library-create">
          <input
            ref={createRef}
            className="library-write-field"
            value={seed}
            placeholder="What do you want to dig into? Enter opens its Page."
            aria-label="New exploration"
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setCreating(false);
                setSeed('');
              }
            }}
          />
          <span className="library-hint">↵</span>
        </div>
      )}
      {error && <div className="library-hint">{error}</div>}
      {!items && !error && <div className="library-hint">Loading…</div>}
      {items && active.length === 0 && !find && (
        <p className="library-empty">No explorations yet. Start one from Home, or with New exploration.</p>
      )}
      {items && find && shown.length === 0 && <p className="library-hint">Nothing here matches “{find}”.</p>}
      <div className="library-cards">{active.map(card)}</div>
      {archived.length > 0 && (
        <>
          <Eyebrow>
            <Btn kind="quiet" className="library-fold" aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}>
              Archived ({archived.length})
            </Btn>
          </Eyebrow>
          {showArchived && <div className="library-cards">{archived.map(card)}</div>}
        </>
      )}
    </div>
  );
};

export default ExploreSection;
