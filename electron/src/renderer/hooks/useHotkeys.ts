/**
 * useHotkeys Hook - Global keyboard shortcut handling
 */

import { useEffect } from 'react';

type HotkeyHandler = () => void;
type HotkeyMap = Record<string, HotkeyHandler>;

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (navigator.platform?.toUpperCase().includes('MAC') || navigator.userAgent?.includes('Mac'));

export function useHotkeys(hotkeys: HotkeyMap) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Build the key string - try both meta and ctrl variants for cross-platform
      const parts: string[] = [];

      // Track modifiers separately for cross-platform matching
      const hasCtrl = e.ctrlKey;
      const hasMeta = e.metaKey;
      if (e.shiftKey) parts.push('shift');
      if (e.altKey) parts.push('alt');

      // Normalize key name
      let key = e.key.toLowerCase();
      if (key === ' ') key = 'space';
      if (key === 'escape') key = 'esc';

      // Don't add modifier keys themselves
      if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
        parts.push(key);
      }

      // On macOS, Ctrl is a distinct chord from Cmd (terminals/shells rely on Ctrl
      // for their own bindings - Ctrl+R reverse-search, Ctrl+W delete-word, etc).
      // Don't let a bare Ctrl chord fall back to a Cmd-bound hotkey or vice versa.
      // Also never intercept a Ctrl-only chord inside a terminal or code editor -
      // let it reach the shell/editor untouched.
      if (IS_MAC && hasCtrl && !hasMeta) {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('.xterm, .cm-editor')) {
          return;
        }
      }

      // Build modifier prefixes and key suffix separately
      // parts currently contains: [shift?], [alt?], [key]
      // We need to build combos like: meta+shift+key or ctrl+shift+key
      const combosToTry: string[] = [];

      if (hasMeta && hasCtrl) {
        // Both pressed - try meta+ctrl, ctrl, meta
        combosToTry.push(['meta', 'ctrl', ...parts].join('+'));
        combosToTry.push(['ctrl', ...parts].join('+'));
        combosToTry.push(['meta', ...parts].join('+'));
      } else if (hasMeta) {
        combosToTry.push(['meta', ...parts].join('+'));
        if (!IS_MAC) {
          // Cross-platform fallback: non-mac hotkey maps may only define 'ctrl+...'
          combosToTry.push(['ctrl', ...parts].join('+'));
        }
      } else if (hasCtrl) {
        combosToTry.push(['ctrl', ...parts].join('+'));
        if (!IS_MAC) {
          // Cross-platform fallback: non-mac hotkey maps may only define 'meta+...'
          combosToTry.push(['meta', ...parts].join('+'));
        }
      } else {
        // No modifier - just use parts as-is
        combosToTry.push(parts.join('+'));
      }

      // Check if any combo matches a hotkey
      for (const combo of combosToTry) {
        if (hotkeys[combo]) {
          e.preventDefault();
          e.stopPropagation();
          hotkeys[combo]();
          return;
        }
      }
    };

    // Use capture phase to intercept events before xterm.js terminal captures them
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [hotkeys]);
}
