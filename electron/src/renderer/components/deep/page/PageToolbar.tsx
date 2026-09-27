/**
 * PageToolbar - one slim row of formatting at the top of the Page's text
 * column, sticky while the Page scrolls. Quiet: --text-3 glyphs at low
 * opacity, fuller on hover or keyboard focus; never phosphor (there is no
 * next step here). Every button's tooltip names its chord (page/format).
 *
 * The buttons never take focus from the text on click (mousedown is
 * prevented), so the selection they act on stays put. From the keyboard
 * it's one tab stop (⇧Tab from the text); ←/→ move along it, Esc goes back
 * to the text. In a table, the table button opens Add row / Add column.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../Icon';
import type { LineKind } from '../../../lib/deepModel';
import { formatCommand, type FormatId } from './format';

export interface ToolbarState {
  /** The cursor line's block kind. */
  kind: LineKind;
  quoted: boolean;
  inTable: boolean;
}

interface PageToolbarProps {
  state: ToolbarState;
  run: (id: FormatId) => void;
  /** Back to the text (Esc). */
  onExit: () => void;
}

type Item = { id: FormatId; glyph: React.ReactNode; glyphClass?: string };

const GROUPS: Item[][] = [
  [
    { id: 'h1', glyph: 'H1' },
    { id: 'h2', glyph: 'H2' },
    { id: 'h3', glyph: 'H3' },
  ],
  [
    { id: 'bold', glyph: 'B', glyphClass: 'is-bold' },
    { id: 'italic', glyph: 'I', glyphClass: 'is-italic' },
    { id: 'strike', glyph: 'S', glyphClass: 'is-strike' },
    { id: 'code', glyph: '</>', glyphClass: 'is-mono' },
    { id: 'link', glyph: <Icon name="link" size={14} /> },
  ],
  [
    { id: 'bullet', glyph: '•' },
    { id: 'ordered', glyph: '1.' },
    { id: 'task', glyph: '☐' },
    { id: 'quote', glyph: '❝' },
  ],
  [
    { id: 'codeblock', glyph: '{ }', glyphClass: 'is-mono' },
    { id: 'table', glyph: '⊞' },
    { id: 'rule', glyph: '—' },
  ],
];

/** aria-keyshortcuts spelling of a ⇧⌥⌘ hint. */
function ariaKeys(kbd: string): string {
  const mods: string[] = [];
  if (kbd.includes('⇧')) mods.push('Shift');
  if (kbd.includes('⌥')) mods.push('Alt');
  if (kbd.includes('⌘')) mods.push('Meta');
  return [...mods, kbd.replace(/[⇧⌥⌘]/g, '')].join('+');
}

function pressed(id: FormatId, s: ToolbarState): boolean | undefined {
  switch (id) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'bullet':
    case 'ordered':
    case 'task':
      return s.kind === id;
    case 'quote':
      return s.quoted;
    default:
      return undefined;
  }
}

export const PageToolbar: React.FC<PageToolbarProps> = ({ state, run, onExit }) => {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);

  // The table menu goes when the cursor leaves the table or a click lands elsewhere.
  useEffect(() => {
    if (!state.inTable) setMenu(false);
  }, [state.inTable]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [menu]);

  const buttons = () => Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('.deep-tb-btn') ?? []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = buttons();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (menu) {
        setMenu(false);
        return;
      }
      onExit();
      return;
    }
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = Array.from(rowRef.current?.querySelectorAll<HTMLButtonElement>('.deep-tb-menu-item') ?? []);
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    if (at < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setFocusIndex(next);
    list[next].focus();
  };

  const onPick = (id: FormatId) => {
    if (id === 'table' && state.inTable) {
      setMenu((m) => !m);
      return;
    }
    setMenu(false);
    run(id);
  };

  let index = -1;
  return (
    <div className="deep-tb-slot">
      <div ref={rowRef} className={`deep-tb${menu ? ' has-menu' : ''}`} role="toolbar" aria-label="Formatting" onKeyDown={onKeyDown}>
        {GROUPS.map((group, g) => (
          <div key={g} className="deep-tb-group">
            {group.map((item) => {
              index += 1;
              const i = index;
              const cmd = formatCommand(item.id);
              const tableMenu = item.id === 'table' && state.inTable;
              const label = tableMenu ? 'Table: add row or column' : cmd.label;
              const title = tableMenu ? `Table: add row (${cmd.kbd}) or column (${formatCommand('column').kbd})` : `${cmd.label} (${cmd.kbd})`;
              const on = pressed(item.id, state);
              return (
                <span key={item.id} className="deep-tb-item">
                  <button
                    type="button"
                    className="deep-tb-btn"
                    title={title}
                    aria-label={label}
                    aria-keyshortcuts={ariaKeys(cmd.kbd)}
                    {...(on !== undefined ? { 'aria-pressed': on } : {})}
                    {...(tableMenu ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': menu } : {})}
                    tabIndex={i === focusIndex ? 0 : -1}
                    onMouseDown={(e) => e.preventDefault()}
                    onFocus={() => setFocusIndex(i)}
                    onClick={() => onPick(item.id)}
                  >
                    <span className={`deep-tb-glyph${item.glyphClass ? ` ${item.glyphClass}` : ''}`} aria-hidden="true">
                      {item.glyph}
                    </span>
                  </button>
                  {tableMenu && menu && (
                    <div className="deep-tb-menu" role="menu" aria-label="Table">
                      {(['table', 'column'] as const).map((id) => {
                        const c = formatCommand(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            role="menuitem"
                            className="deep-tb-menu-item"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setMenu(false);
                              run(id);
                            }}
                          >
                            <span>{id === 'table' ? 'Add row' : 'Add column'}</span>
                            <span className="deep-tb-kbd">{c.kbd}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
