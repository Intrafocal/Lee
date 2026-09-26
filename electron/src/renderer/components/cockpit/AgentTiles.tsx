/**
 * AgentTiles - one live tile per agent PTY in this workspace, in any window
 * (contracts §3.5). Collapsible; the tiles are the wall around the agent
 * terminals, so going into one is a deliberate action.
 */

import React, { useState } from 'react';
import { Icon } from '../Icon';
import { AgentTile } from './AgentTile';
import { cockpitModeStore } from './cockpitMode';
import type { CockpitCtx } from './CockpitHost';

export const AgentTiles: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const [collapsed, setCollapsed] = useState(false);
  const { tiles } = ctx;
  const sel = ctx.mode.selected;
  const needs = tiles.filter((t) => t.needsYou).length;

  return (
    <div className={`cockpit-agents${collapsed ? ' is-collapsed' : ''}`}>
      <button className="cockpit-agents-head" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        <span>Agents</span>
        <span className="cockpit-muted">{tiles.length}</span>
        {needs > 0 && <span className="cockpit-badge is-ember">{needs} need you</span>}
        <span className="cockpit-agents-hint">h/l select · ⏎ peek · ⇧⌘C new</span>
      </button>
      {!collapsed && (
        <div className="cockpit-tiles">
          {tiles.length === 0 && (
            <div className="cockpit-empty">No agents running here. ⇧⌘C starts Claude as a tile; n launches a task.</div>
          )}
          {tiles.map((tile) => (
            <AgentTile
              key={tile.ptyId}
              ctx={ctx}
              tile={tile}
              selected={sel?.kind === 'tile' && sel.id === String(tile.ptyId)}
              onSelect={() => cockpitModeStore.select({ kind: 'tile', id: String(tile.ptyId) })}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentTiles;
