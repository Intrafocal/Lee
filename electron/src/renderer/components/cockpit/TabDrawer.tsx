/**
 * TabDrawer - your own tabs (every dock), names and icons only (contracts
 * §3.6). ` focuses it, ←/→ select, Enter or a click opens (→ Manual).
 */

import React from 'react';
import { Icon, type IconName } from '../Icon';
import type { CockpitTab } from './CockpitHost';

const TYPE_ICONS: Partial<Record<string, IconName>> = {
  terminal: 'terminal',
  'editor-panel': 'editor',
  editor: 'editor',
  file: 'file-code',
  files: 'folder',
  browser: 'browser',
  git: 'git',
  docker: 'docker',
  k8s: 'kubernetes',
  sql: 'sql',
  devops: 'devops',
  system: 'system',
  library: 'book',
  workstream: 'list',
  spyglass: 'machine',
  bridge: 'link',
  kicad: 'chip',
  model: 'cube',
  pdf: 'document',
  binary: 'file-code',
};

interface TabDrawerProps {
  tabs: CockpitTab[];
  focused: boolean;
  selectedId: number | null;
  onFocusChange: (focused: boolean) => void;
  onSelect: (tabId: number) => void;
  onOpen: (tabId: number) => void;
}

export const TabDrawer: React.FC<TabDrawerProps> = ({ tabs, focused, selectedId, onFocusChange, onSelect, onOpen }) => (
  <div className={`cockpit-drawer${focused ? ' is-focused' : ''}`} aria-label="Your tabs">
    <span className="cockpit-drawer-label">Your tabs</span>
    <div className="cockpit-drawer-tabs">
      {tabs.length === 0 && <span className="cockpit-muted">None open</span>}
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`cockpit-drawer-tab${selectedId === t.id ? ' is-selected' : ''}`}
          onMouseEnter={() => focused && onSelect(t.id)}
          onClick={() => onOpen(t.id)}
          title={t.filePath ?? t.label}
        >
          <Icon name={TYPE_ICONS[t.type] ?? 'tabs'} size={12} />
          <span>{t.label}</span>
        </button>
      ))}
    </div>
    <button className="cockpit-drawer-key" onClick={() => onFocusChange(!focused)} title="Pick one of your tabs with the keyboard (⌘T)">
      <kbd>⌘T</kbd> select
    </button>
  </div>
);

export default TabDrawer;
