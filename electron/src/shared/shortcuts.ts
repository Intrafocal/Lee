/**
 * Shortcut registry - the single source of truth for Lee's key bindings.
 *
 * Both surfaces are generated from this list:
 *   - the application menu's accelerators (main process, `setupApplicationMenu`)
 *   - the renderer's hotkey map (`App.tsx`, fed to `useHotkeys`)
 *
 * Exactly one surface owns each chord, which is what `scope` encodes:
 *   - `menu`     : the menu item carries the accelerator; the renderer must not
 *                  bind the chord (otherwise it fires twice).
 *   - `renderer` : the renderer binds the chord; any menu item for the action
 *                  is built WITHOUT an accelerator.
 *   - `both`     : same ownership as `renderer` (the renderer binds it), but a
 *                  menu item also exists so the action is discoverable. The
 *                  menu item still gets no accelerator.
 *
 * Users override any chord via `keybindings:` in config.yaml, keyed by
 * `action`, in the familiar `cmd+shift+t` spelling. `normalizeChord` maps that
 * onto the renderer's `meta+shift+t` form; `toAccelerator` maps it onto
 * Electron's `CmdOrCtrl+Shift+T`.
 */

export type ShortcutScope = 'menu' | 'renderer' | 'both';

export interface ShortcutDef {
  /** Stable id; also the `keybindings:` key users override in config.yaml. */
  action: string;
  /** Default chord in renderer spelling (`meta+shift+t`). */
  defaultChord: string;
  scope: ShortcutScope;
  description: string;
  /** Grouping for docs/shortcuts.md. */
  group: 'Application' | 'File' | 'Tabs' | 'Tools' | 'View' | 'Editor';
  /**
   * Renderer-owned chords that must not fire while a CodeMirror editor has
   * focus (they'd shadow the editor's own binding).
   */
  notInEditor?: boolean;
  /**
   * Listed for documentation only - the chord is implemented by a component
   * (CodeMirror's own keymap, the editor panel) rather than by the generated
   * menu or the global hotkey map, so neither surface should bind it.
   */
  documentationOnly?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  // --- Application ---
  { action: 'edit_workspace_config', defaultChord: 'meta+,', scope: 'menu', group: 'Application', description: 'Edit the workspace config (<ws>/.lee/config.yaml)' },
  { action: 'command_palette', defaultChord: 'meta+/', scope: 'both', group: 'Application', description: 'Ask Hester (command palette); reuses the current status-bar prompt if there is one' },
  { action: 'command_palette_blank', defaultChord: 'meta+shift+/', scope: 'renderer', group: 'Application', description: 'Ask Hester with an empty prompt' },
  { action: 'aeronaut_pairing', defaultChord: 'meta+shift+a', scope: 'both', group: 'Application', description: 'Show the Aeronaut pairing QR code' },

  // --- File ---
  { action: 'new_file', defaultChord: 'meta+n', scope: 'menu', group: 'File', description: 'New untitled file' },
  { action: 'new_window', defaultChord: 'meta+shift+n', scope: 'menu', group: 'File', description: 'New Lee window' },
  { action: 'open_file', defaultChord: 'meta+o', scope: 'menu', group: 'File', description: 'Open a file' },
  { action: 'open_folder', defaultChord: 'meta+shift+o', scope: 'menu', group: 'File', description: 'Open a folder as the workspace' },
  { action: 'save_file', defaultChord: 'meta+s', scope: 'menu', group: 'File', description: 'Save the active file' },
  { action: 'save_file_as', defaultChord: 'meta+shift+s', scope: 'menu', group: 'File', description: 'Save the active file to a new path' },

  // --- Tabs ---
  { action: 'close_tab', defaultChord: 'meta+esc', scope: 'renderer', group: 'Tabs', description: 'Close the focused tab' },
  { action: 'next_tab', defaultChord: 'ctrl+tab', scope: 'renderer', group: 'Tabs', description: 'Next center tab' },
  { action: 'prev_tab', defaultChord: 'ctrl+shift+tab', scope: 'renderer', group: 'Tabs', description: 'Previous center tab' },
  { action: 'toggle_watch', defaultChord: 'meta+w', scope: 'renderer', group: 'Tabs', description: 'Toggle idle-watching on the focused agent tab' },
  { action: 'cycle_idle', defaultChord: 'meta+i', scope: 'renderer', group: 'Tabs', description: 'Cycle through watched agent tabs that have gone idle' },
  { action: 'tab_1', defaultChord: 'meta+1', scope: 'renderer', group: 'Tabs', description: '⌘1: tab 1 in Manual, rail section 1 in the Cockpit, nothing in Deep' },
  { action: 'tab_2', defaultChord: 'meta+2', scope: 'renderer', group: 'Tabs', description: '⌘2: tab 2 in Manual, rail section 2 in the Cockpit, nothing in Deep' },
  { action: 'tab_3', defaultChord: 'meta+3', scope: 'renderer', group: 'Tabs', description: '⌘3: tab 3 in Manual, rail section 3 in the Cockpit, nothing in Deep' },
  { action: 'tab_4', defaultChord: 'meta+4', scope: 'renderer', group: 'Tabs', description: '⌘4: tab 4 in Manual, rail section 4 in the Cockpit, nothing in Deep' },
  { action: 'tab_5', defaultChord: 'meta+5', scope: 'renderer', group: 'Tabs', description: '⌘5: tab 5 in Manual, nothing in the Cockpit (it has four sections), nothing in Deep' },
  { action: 'tab_6', defaultChord: 'meta+6', scope: 'renderer', group: 'Tabs', description: '⌘6: tab 6 in Manual, nothing in the Cockpit (it has four sections), nothing in Deep' },
  { action: 'tab_7', defaultChord: 'meta+7', scope: 'renderer', group: 'Tabs', description: '⌘7: tab 7 in Manual, nothing in the Cockpit (it has four sections), nothing in Deep' },
  { action: 'tab_8', defaultChord: 'meta+8', scope: 'renderer', group: 'Tabs', description: '⌘8: tab 8 in Manual, nothing in the Cockpit (it has four sections), nothing in Deep' },
  { action: 'tab_9', defaultChord: 'meta+9', scope: 'renderer', group: 'Tabs', description: '⌘9: tab 9 in Manual, nothing in the Cockpit (it has four sections), nothing in Deep' },

  // --- Tools (tab launchers) ---
  { action: 'terminal', defaultChord: 'meta+shift+t', scope: 'renderer', group: 'Tools', description: 'New terminal tab' },
  { action: 'browser', defaultChord: 'meta+shift+b', scope: 'renderer', group: 'Tools', description: 'New browser tab' },
  { action: 'files', defaultChord: 'meta+shift+e', scope: 'renderer', group: 'Tools', description: 'File tree' },
  { action: 'hester', defaultChord: 'meta+shift+h', scope: 'renderer', group: 'Tools', description: 'Hester agent tab' },
  { action: 'claude', defaultChord: 'meta+shift+c', scope: 'renderer', group: 'Tools', description: 'Claude Code agent tab' },
  { action: 'pi', defaultChord: 'meta+shift+i', scope: 'renderer', group: 'Tools', description: 'Pi agent tab' },
  // Moved off meta+shift+o, which the File > Open Folder... menu accelerator owns.
  { action: 'devops', defaultChord: 'meta+shift+j', scope: 'renderer', group: 'Tools', description: 'DevOps dashboard' },
  { action: 'git', defaultChord: 'meta+shift+g', scope: 'renderer', group: 'Tools', description: 'Git TUI (lazygit)' },
  { action: 'docker', defaultChord: 'meta+shift+d', scope: 'renderer', group: 'Tools', description: 'Docker TUI (lazydocker)' },
  { action: 'flutter', defaultChord: 'meta+shift+f', scope: 'renderer', group: 'Tools', description: 'Flutter dev tools (flx)' },
  { action: 'k8s', defaultChord: 'meta+shift+k', scope: 'renderer', group: 'Tools', description: 'Kubernetes TUI (k9s)' },
  { action: 'sql', defaultChord: 'meta+shift+p', scope: 'renderer', group: 'Tools', description: 'SQL client (pgcli)' },
  { action: 'hester_qa', defaultChord: 'meta+shift+q', scope: 'renderer', group: 'Tools', description: 'Hester QA scene runner' },
  { action: 'system', defaultChord: 'meta+shift+m', scope: 'renderer', group: 'Tools', description: 'System monitor (btop)' },
  { action: 'workstream', defaultChord: 'meta+shift+w', scope: 'renderer', group: 'Tools', description: 'Workstream picker' },

  // --- View ---
  // Modes (Deep D1 §1.3). mode_switcher replaced cockpit_toggle; resolveChord
  // still honours a `keybindings:` entry for the old name.
  { action: 'mode_switcher', defaultChord: 'meta+0', scope: 'renderer', group: 'View', description: 'Mode switcher: tap for the last mode, hold for Cockpit / Deep / Manual' },
  { action: 'mode_deep', defaultChord: 'meta+shift+0', scope: 'renderer', group: 'View', description: 'Cockpit ↔ Deep' },
  { action: 'mode_manual', defaultChord: 'meta+alt+0', scope: 'renderer', group: 'View', description: 'Cockpit ↔ Manual' },
  // Desk D2 §7.2: implemented by the Desk (components/desk), listed for docs only.
  { action: 'desk_overview', defaultChord: 'esc', scope: 'renderer', documentationOnly: true, group: 'View', description: 'Deep: from a zoomed card, back to the Desk overview (closes the innermost picker or popover first)' },
  { action: 'force_reload', defaultChord: 'meta+shift+r', scope: 'menu', group: 'View', description: 'Reload the Lee UI, discarding caches (prompts if terminals are open)' },
  {
    action: 'scroll_bottom',
    defaultChord: 'meta+arrowdown',
    scope: 'renderer',
    group: 'View',
    notInEditor: true,
    description: 'Scroll the focused terminal to the bottom (ignored while a code editor has focus, where it means go-to-end)',
  },

  // --- Editor (implemented inside EditorPanel / CodeMirror, listed for docs) ---
  { action: 'editor_markdown_preview', defaultChord: 'meta+e', scope: 'renderer', documentationOnly: true, group: 'Editor', description: 'Toggle markdown preview (markdown files only; handled inside the editor panel)' },
  { action: 'editor_find', defaultChord: 'meta+f', scope: 'renderer', documentationOnly: true, group: 'Editor', description: "Find in file (CodeMirror's search keymap)" },
  { action: 'deep_actions', defaultChord: 'meta+.', scope: 'renderer', group: 'Editor', description: "Deep only: the selection's action row (Capture, Keep, Ask, Explore), or the visible typing affordance" },
];

/**
 * Renamed actions: a `keybindings:` entry under the old name still applies to
 * the new action, unless the new name has its own entry.
 */
export const LEGACY_ACTIONS: Record<string, string> = {
  mode_switcher: 'cockpit_toggle',
};

/**
 * System-wide hotkey to bring Lee forward from any other app.
 *
 * Off by default: a `globalShortcut` steals the chord from every other
 * application on the machine, which is not something an editor should do
 * uninvited. Opt in with `keybindings.global_focus_lee: cmd+shift+l` in
 * config.yaml (any chord, or `false`/empty to keep it disabled).
 */
export const GLOBAL_FOCUS_ACTION = 'global_focus_lee';

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  option: 'alt',
  control: 'ctrl',
  escape: 'esc',
};

/** Map a user-written chord (`Cmd+Shift+T`) onto the renderer's spelling. */
export function normalizeChord(chord: string): string {
  return chord
    .toLowerCase()
    .split('+')
    .map((part) => MODIFIER_ALIASES[part.trim()] ?? part.trim())
    .filter(Boolean)
    .join('+');
}

/** Resolve an action's chord, honouring `keybindings:` overrides from config. */
export function resolveChord(
  action: string,
  keybindings?: Record<string, string> | null,
): string {
  const legacy = LEGACY_ACTIONS[action];
  const own = keybindings?.[action];
  const override = typeof own === 'string' && own.trim() ? own : legacy ? keybindings?.[legacy] : undefined;
  const def = SHORTCUTS.find((s) => s.action === action);
  if (typeof override === 'string' && override.trim()) return normalizeChord(override);
  return def ? def.defaultChord : '';
}

const ACCELERATOR_KEYS: Record<string, string> = {
  meta: 'CmdOrCtrl',
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  tab: 'Tab',
  enter: 'Return',
  space: 'Space',
};

/** Map a renderer chord onto an Electron accelerator string. */
export function toAccelerator(chord: string): string {
  return normalizeChord(chord)
    .split('+')
    .map((part) => ACCELERATOR_KEYS[part] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join('+');
}

/** Pretty-print a chord for UI display (`⇧⌘T`). */
export function formatChord(chord: string): string {
  const parts = normalizeChord(chord).split('+');
  let out = '';
  if (parts.includes('ctrl')) out += '⌃';
  if (parts.includes('alt')) out += '⌥';
  if (parts.includes('shift')) out += '⇧';
  if (parts.includes('meta')) out += '⌘';
  const key = parts.find((p) => !['ctrl', 'alt', 'shift', 'meta'].includes(p));
  if (key) {
    const keyMap: Record<string, string> = {
      tab: 'Tab',
      esc: 'Esc',
      enter: '↵',
      space: 'Space',
      arrowup: '↑',
      arrowdown: '↓',
      arrowleft: '←',
      arrowright: '→',
      ',': ',',
      '/': '/',
    };
    out += keyMap[key] ?? key.toUpperCase();
  }
  return out;
}

/** Every action the renderer is responsible for binding. */
export function rendererShortcuts(): ShortcutDef[] {
  return SHORTCUTS.filter((s) => !s.documentationOnly && (s.scope === 'renderer' || s.scope === 'both'));
}

/** Accelerator for a menu-owned action, or undefined when the renderer owns it. */
export function menuAccelerator(
  action: string,
  keybindings?: Record<string, string> | null,
): string | undefined {
  const def = SHORTCUTS.find((s) => s.action === action);
  if (!def || def.scope !== 'menu') return undefined;
  return toAccelerator(resolveChord(action, keybindings));
}
