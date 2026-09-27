/**
 * WorkSection - Work: what needs you and what's in flight (cockpit-design §4;
 * package R2).
 *
 * Scaffold stub: today's Feed, Tasks and Tabs sections behind a small switch,
 * so the app keeps working until R2 builds the one-column list. A selected
 * task row (from Feed, Someday or a proposal) or a link-goal request shows
 * Tasks.
 */

import React, { useEffect, useState } from 'react';
import type { CockpitCtx } from '../CockpitHost';
import { FeedSection } from './FeedSection';
import { TasksSection } from './TasksSection';
import { TabsSection } from './TabsSection';

type WorkPart = 'feed' | 'tasks' | 'tabs';

const PARTS: { id: WorkPart; label: string }[] = [
  { id: 'feed', label: 'Feed' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'tabs', label: 'Tabs' },
];

export const WorkSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const selectedId = ctx.mode.selected?.kind === 'row' ? ctx.mode.selected.id : null;
  const [part, setPart] = useState<WorkPart>(() => (selectedId?.startsWith('task:') ? 'tasks' : 'feed'));
  useEffect(() => {
    if (selectedId?.startsWith('task:')) setPart('tasks');
  }, [selectedId]);
  const stewardNonce = ctx.pendingSteward?.req.kind === 'link-goal' ? ctx.pendingSteward.nonce : 0;
  useEffect(() => {
    if (stewardNonce) setPart('tasks');
  }, [stewardNonce]);

  return (
    <>
      <div className="cockpit-chips" role="tablist" aria-label="Work">
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
      {part === 'feed' && <FeedSection ctx={ctx} />}
      {part === 'tasks' && <TasksSection ctx={ctx} />}
      {part === 'tabs' && <TabsSection ctx={ctx} />}
    </>
  );
};

export default WorkSection;
