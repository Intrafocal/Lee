/**
 * MoreMenu - the quiet `⋯` menu on Work's waiting cards and Library's cards
 * (cockpit-design §4.3, §5): the mouse way to what a swipe or a key does, and
 * the less common actions; Work's detail keeps its rarer actions here too,
 * behind the `more` icon (`icon`). Text-only items; Esc or a click outside
 * closes it.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { IconName } from '../../Icon';
import { Btn, IconAction } from '../ui';

export interface MoreItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export const MoreMenu: React.FC<{ items: MoreItem[]; label?: string; icon?: IconName }> = ({ items, label = 'More', icon }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  if (!items.length) return null;
  return (
    <div
      ref={ref}
      className="work-more"
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {icon ? (
        <IconAction icon={icon} label={label} open={open} expanded={open} onClick={() => setOpen((o) => !o)} />
      ) : (
        <Btn kind="quiet" aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={() => setOpen((o) => !o)}>
          ⋯
        </Btn>
      )}
      {open && (
        <div className="work-more-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="work-more-item"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default MoreMenu;
