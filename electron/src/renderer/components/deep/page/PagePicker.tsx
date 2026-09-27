/**
 * PagePicker - the inline list under the caret for `[[` (workspace files,
 * markdown first) and `@` (Hester, the providers, this exploration's
 * hand-offs). Deep next R10, R11.
 *
 * The Page keeps focus: arrows, Enter/Tab and Esc are handled by the Page's
 * keymap while the list shows; a click picks (mousedown, so the caret stays).
 */

import { useEffect, useRef } from 'react';

export interface PickerItem {
  key: string;
  label: string;
  sub?: string;
}

interface PagePickerProps {
  items: readonly PickerItem[];
  index: number;
  top: number;
  left: number;
  /** Shown when there are no items (or while loading). */
  empty: string;
  label: string;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
}

export function PagePicker({ items, index, top, left, empty, label, onPick, onHover }: PagePickerProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <div className="deep-picker" style={{ top, left }} role="listbox" aria-label={label} ref={listRef}>
      {items.length === 0 && <div className="deep-picker-empty">{empty}</div>}
      {items.map((it, i) => (
        <div
          key={it.key}
          data-i={i}
          role="option"
          aria-selected={i === index}
          className={`deep-picker-row${i === index ? ' is-on' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(i);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="deep-picker-label">{it.label}</span>
          {it.sub && <span className="deep-picker-sub">{it.sub}</span>}
        </div>
      ))}
    </div>
  );
}

export default PagePicker;
