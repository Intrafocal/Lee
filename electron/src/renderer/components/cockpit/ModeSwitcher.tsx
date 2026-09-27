/**
 * ModeSwitcher - the ⌘0 switcher overlay (Deep D1 §1.3): three cards,
 * Cockpit "N waiting", Deep "<exploration> · Page" or "Nothing open", and
 * Manual "N tabs". A tap of ⌘0 goes back to the last mode without showing
 * it; holding ⌘ (or a second 0) shows it, each further 0 moves the
 * highlight, releasing ⌘ commits and Esc cancels. The status-bar chip opens
 * the same cards (click or Enter commits); while a Deep session is active it
 * also offers End session.
 *
 * The rules live in switcherStep() (lib/cockpitModel.ts); this file wires
 * keys and draws the cards. Mode changes are never counted or shown back.
 */

import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import type { LeeMode } from '../../../shared/cockpit';
import { MODES, MODE_LABELS } from '../../lib/cockpitModel';
import { cockpitModeStore, endDeepSession, useCockpitModeState, type CockpitModeState } from './cockpitMode';
import './cockpit.css';

/**
 * useHotkeys' intercept: while the switcher is pending or open it takes Esc,
 * further ⌘0s (key repeats swallowed), and arrows/Enter on the open cards.
 */
export function switcherIntercept(e: KeyboardEvent): boolean {
  const sw = cockpitModeStore.get().switcher;
  if (sw.phase === 'idle') return false;
  if (e.key === 'Escape') {
    cockpitModeStore.switcher({ kind: 'escape' });
    return true;
  }
  if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && (e.code === 'Digit0' || e.key === '0')) {
    if (!e.repeat) cockpitModeStore.switcher({ kind: 'zero', now: Date.now(), lastMode: cockpitModeStore.get().lastMode });
    return true;
  }
  if (sw.phase !== 'open') return false;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      cockpitModeStore.switcher({ kind: 'move', delta: -1 });
      return true;
    case 'ArrowRight':
    case 'ArrowDown':
      cockpitModeStore.switcher({ kind: 'move', delta: 1 });
      return true;
    case 'Enter':
      cockpitModeStore.switcher({ kind: 'enter' });
      return true;
    default:
      return false;
  }
}

function cardDetail(mode: LeeMode, s: CockpitModeState): string {
  switch (mode) {
    case 'cockpit':
      return `${s.needsCount} waiting`;
    case 'deep':
      return s.deep.exploration_id ? `${s.deep.title || 'Untitled'} · Page` : 'Nothing open';
    case 'manual':
      return `${s.tabCount} ${s.tabCount === 1 ? 'tab' : 'tabs'}`;
  }
}

const CARD_KEYS: Record<LeeMode, string> = {
  cockpit: '⌘0',
  deep: '⇧⌘0',
  manual: '⌥⌘0',
};

export const ModeSwitcher: React.FC = () => {
  const s = useCockpitModeState();
  const sw = s.switcher;

  // ⌘ released: a tap switches back, an open overlay commits. Losing the
  // window loses the keyup, so a blur cancels.
  useEffect(() => {
    if (sw.phase === 'idle') return;
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') cockpitModeStore.switcher({ kind: 'meta_up', now: Date.now() });
    };
    const onBlur = () => cockpitModeStore.switcher({ kind: 'escape' });
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [sw.phase]);

  if (!s.enabled || sw.phase !== 'open') return null;

  return ReactDOM.createPortal(
    <div className="mode-switcher-backdrop" onMouseDown={() => cockpitModeStore.switcher({ kind: 'escape' })}>
      <div
        className="mode-switcher"
        role="dialog"
        aria-label="Switch mode"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mode-switcher-cards">
          {MODES.map((m) => (
            <button
              key={m}
              className={`mode-switcher-card${sw.highlight === m ? ' is-highlight' : ''}${s.mode === m ? ' is-current' : ''}`}
              onMouseEnter={() => cockpitModeStore.switcher({ kind: 'highlight', to: m })}
              onClick={() => cockpitModeStore.switcher({ kind: 'click', to: m })}
            >
              <span className="mode-switcher-name">{MODE_LABELS[m]}</span>
              <span className="mode-switcher-detail">{cardDetail(m, s)}</span>
              <kbd>{CARD_KEYS[m]}</kbd>
            </button>
          ))}
        </div>
        {sw.fromChip && (
          <div className="mode-switcher-foot">
            <span className="mode-switcher-hint">Enter switches · Esc closes</span>
            {s.deepActive && (
              <button
                className="cockpit-btn"
                onClick={() => {
                  cockpitModeStore.switcher({ kind: 'escape' });
                  endDeepSession(window.lee?.copilot ?? null);
                }}
              >
                End session…
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default ModeSwitcher;
