/**
 * ExploreSection - deeper dives (spec §7.5, v-now scope: section +
 * persistence). Someday is quick capture; Explore is where an idea gets a
 * durable, open-ended investigation with Hester.
 *
 * Each exploration is a file in the workspace's .hester/explore/ (Hester's
 * ExplorationStore). "Dive in" asks Hester to seed the chat session
 * explore-<id> from the file, then opens it as a Hester tab through the
 * existing session-tab path; every turn there is written back to the file.
 * Spikes, decision nodes and archive-as-knowledge are later (spec §7.5).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../Icon';
import { formatAge } from '../../../lib/cockpitModel';
import {
  createExploration,
  getExploration,
  listExplorations,
  patchExploration,
  type Exploration,
} from '../../../lib/hesterCockpit';
import { AgentMarkdown } from '../AgentMarkdown';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

interface ExploreSectionProps {
  ctx: CockpitCtx;
  /** Bumped by the header's "+ Explore": focus the new-exploration field. */
  focusCreateNonce: number;
}

export const ExploreSection: React.FC<ExploreSectionProps> = ({ ctx, focusCreateNonce }) => {
  const workspace = ctx.workspace;
  const [items, setItems] = useState<Exploration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string | null>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    listExplorations(workspace, showArchived ? 'all' : 'active').then((r) => {
      if (r.ok) {
        setItems(r.data);
        setError(null);
      } else setError(r.error);
    });
  }, [workspace, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (focusCreateNonce > 0) inputRef.current?.focus();
  }, [focusCreateNonce]);

  const create = async (dive: boolean) => {
    const body = text.trim();
    if (!body) return;
    setBusy('create');
    try {
      const r = await createExploration(workspace, { seed: body, origin: { kind: 'cockpit' } });
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        return;
      }
      setText('');
      load();
      ctx.selectRow(`explore:${r.data.id}`);
      if (dive) await ctx.openExploration(r.data);
      else ctx.notify(`Exploration started: ${r.data.title}`);
    } finally {
      setBusy(null);
    }
  };

  const setArchived = async (exp: Exploration, archived: boolean) => {
    setBusy(exp.id);
    try {
      const r = await patchExploration(workspace, exp.id, { status: archived ? 'archived' : 'active' });
      if (!r.ok) ctx.notify(r.error, 'error');
      load();
    } finally {
      setBusy(null);
    }
  };

  const toggleNotes = (exp: Exploration) => {
    if (exp.id in notes) {
      setNotes((n) => {
        const next = { ...n };
        delete next[exp.id];
        return next;
      });
      return;
    }
    setNotes((n) => ({ ...n, [exp.id]: null }));
    getExploration(workspace, exp.id).then((r) => setNotes((n) => (exp.id in n ? { ...n, [exp.id]: r.ok ? r.data.body ?? '' : r.error } : n)));
  };

  const dive = async (exp: Exploration) => {
    setBusy(exp.id);
    try {
      await ctx.openExploration(exp);
    } finally {
      setBusy(null);
    }
  };

  const list = items ?? [];
  const handles: RowHandle[] = list.map((e) => ({ id: `explore:${e.id}`, title: e.title, open: () => void dive(e) }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const filePath = (id: string) => `${workspace.replace(/\/+$/, '')}/.hester/explore/${id}.md`;

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Explore</h2>
        <span className="cockpit-muted">Deeper dives with Hester, kept in .hester/explore/</span>
        <span className="cockpit-header-spacer" />
        <label className="cockpit-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived
        </label>
      </header>
      <div className="cockpit-capture">
        <input
          ref={inputRef}
          className="cockpit-input"
          value={text}
          placeholder="What do you want to dig into? (Enter creates, ⇧Enter creates and dives in)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create(e.shiftKey);
            }
          }}
        />
        <button className="cockpit-btn" disabled={!text.trim() || busy === 'create'} onClick={() => void create(false)}>
          <Icon name="plus" size={12} /> Explore
        </button>
        <button className="cockpit-btn is-primary" disabled={!text.trim() || busy === 'create'} onClick={() => void create(true)}>
          <Icon name="chat" size={12} /> Create & dive in
        </button>
      </div>
      {error && <div className="cockpit-offline">{error}</div>}
      {!items && !error && <div className="cockpit-muted">Loading…</div>}
      {items && list.length === 0 && (
        <div className="cockpit-empty">
          No explorations yet. Start one here, or promote a Someday idea with "Promote → Explore".
        </div>
      )}
      <div className="cockpit-rows">
        {list.map((exp, i) => {
          const archived = exp.status === 'archived';
          const id = handles[i].id;
          return (
            <div
              key={exp.id}
              data-cockpit-row={id}
              className={`cockpit-row${sel?.kind === 'row' && sel.id === id ? ' is-selected' : ''}${archived ? ' is-closed' : ''}`}
              onClick={() => ctx.selectRow(id)}
            >
              <div className="cockpit-row-head">
                <span className="cockpit-row-title">{exp.title}</span>
              </div>
              <div className="cockpit-row-meta">
                {formatAge(exp.last_touched_at ?? exp.updated_at, ctx.now)} · {exp.turns} exchange{exp.turns === 1 ? '' : 's'}
                {exp.origin?.kind === 'someday' && <span className="cockpit-tag">from Someday</span>}
                {archived && <span className="cockpit-tag">archived</span>}
              </div>
              <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="cockpit-btn is-primary" disabled={busy === exp.id} onClick={() => void dive(exp)}>
                  <Icon name="chat" size={11} /> {exp.turns > 0 ? 'Continue' : 'Dive in'}
                </button>
                <button className="cockpit-btn" onClick={() => toggleNotes(exp)}>
                  {exp.id in notes ? 'Hide notes' : 'Notes'}
                </button>
                <button className="cockpit-btn" onClick={() => ctx.openFile(filePath(exp.id))} title="Open the exploration file in the Workbench">
                  <Icon name="file-code" size={11} /> File
                </button>
                <button className="cockpit-btn" disabled={busy === exp.id} onClick={() => void setArchived(exp, !archived)}>
                  {archived ? 'Unarchive' : 'Archive'}
                </button>
              </div>
              {exp.id in notes && (
                <div className="cockpit-explore-notes" onClick={(e) => e.stopPropagation()}>
                  {notes[exp.id] == null ? <span className="cockpit-muted">Loading…</span> : <AgentMarkdown text={notes[exp.id] as string} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default ExploreSection;
