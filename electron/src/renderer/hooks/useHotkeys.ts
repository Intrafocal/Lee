/**
 * useHotkeys Hook - Global keyboard shortcut handling
 */

import { useEffect } from 'react';

type HotkeyHandler = () => void;
type HotkeyMap = Record<string, HotkeyHandler>;

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (navigator.platform?.toUpperCase().includes('MAC') || navigator.userAgent?.includes('Mac'));

/** The parts of a keydown a chord is built from. */
export interface ChordKey {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Physical keys spelled the way the registry writes them. ⇧ and ⌥ change
 * `key` for digits and punctuation (⇧⌘0 is `)`, ⌥⌘0 is `º` on a US Mac), so
 * these chords also match on `code` (Deep D1 §1.3).
 */
const CODE_KEYS: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
};

function codeKey(code: string | undefined): string | null {
  if (!code) return null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_KEYS[code] ?? null;
}

/**
 * The chords one keydown may mean, most specific first: the `key`-based
 * spelling (what existing chords use), then the `code`-based one for digits
 * and punctuation, each with the meta/ctrl fallbacks below.
 */
export function hotkeyCombos(e: ChordKey, isMac: boolean = IS_MAC): string[] {
  const hasCtrl = e.ctrlKey;
  const hasMeta = e.metaKey;
  const mods: string[] = [];
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');

  // Normalize key name
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  const keys: string[] = [];
  // Don't add modifier keys themselves
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) keys.push(key);
  const physical = codeKey(e.code);
  if (physical && !keys.includes(physical)) keys.push(physical);
  if (!keys.length) keys.push('');

  const combos: string[] = [];
  for (const k of keys) {
    // parts: [shift?], [alt?], [key]; combos prefix meta/ctrl
    const parts = k ? [...mods, k] : mods;
    if (hasMeta && hasCtrl) {
      // Both pressed - try meta+ctrl, ctrl, meta
      combos.push(['meta', 'ctrl', ...parts].join('+'));
      combos.push(['ctrl', ...parts].join('+'));
      combos.push(['meta', ...parts].join('+'));
    } else if (hasMeta) {
      combos.push(['meta', ...parts].join('+'));
      // Cross-platform fallback: non-mac hotkey maps may only define 'ctrl+...'
      if (!isMac) combos.push(['ctrl', ...parts].join('+'));
    } else if (hasCtrl) {
      combos.push(['ctrl', ...parts].join('+'));
      // Cross-platform fallback: non-mac hotkey maps may only define 'meta+...'
      if (!isMac) combos.push(['meta', ...parts].join('+'));
    } else {
      // No modifier - just use parts as-is
      combos.push(parts.join('+'));
    }
  }
  return combos;
}

export interface HotkeyOptions {
  /**
   * Sees every keydown first (the ⌘0 switcher while its overlay is up).
   * Returning true consumes the event.
   */
  intercept?: (e: KeyboardEvent) => boolean;
}

export function useHotkeys(hotkeys: HotkeyMap, options?: HotkeyOptions) {
  const intercept = options?.intercept;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (intercept && intercept(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // On macOS, Ctrl is a distinct chord from Cmd (terminals/shells rely on Ctrl
      // for their own bindings - Ctrl+R reverse-search, Ctrl+W delete-word, etc).
      // Don't let a bare Ctrl chord fall back to a Cmd-bound hotkey or vice versa.
      // Also never intercept a Ctrl-only chord inside a terminal or code editor -
      // let it reach the shell/editor untouched.
      if (IS_MAC && e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('.xterm, .cm-editor')) {
          return;
        }
      }

      // Check if any combo matches a hotkey
      for (const combo of hotkeyCombos(e)) {
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
  }, [hotkeys, intercept]);
}
