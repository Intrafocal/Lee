# Lee keyboard shortcuts

Generated from `electron/src/shared/shortcuts.ts`, which is also what builds the
application menu accelerators and the renderer hotkey map. Regenerate after
editing the registry (see the note at the bottom).

Chords are shown in macOS notation: ⌘ Command, ⇧ Shift, ⌃ Control, ⌥ Option.
On Linux/Windows ⌘ is Ctrl.

**Owner** says which surface fires the action, so nothing is bound twice:
`menu` = the application menu carries the accelerator; `renderer` = the in-app
hotkey map; `both` = a menu item exists for discoverability but the renderer
owns the chord; `editor` = implemented by the editor panel / CodeMirror.

Override any chord with a `keybindings:` block in `config.yaml`, keyed by the
action name, e.g.:

```yaml
keybindings:
  devops: cmd+shift+j
  terminal: cmd+shift+t
```

## Application

| Chord | Action | Owner | What it does |
|---|---|---|---|
| `⌘,` | `edit_workspace_config` | menu | Edit the workspace config (<ws>/.lee/config.yaml) |
| `⌘/` | `command_palette` | both | Ask Hester (command palette); reuses the current status-bar prompt if there is one |
| `⇧⌘/` | `command_palette_blank` | renderer | Ask Hester with an empty prompt |
| `⇧⌘A` | `aeronaut_pairing` | both | Show the Aeronaut pairing QR code |

## File

| Chord | Action | Owner | What it does |
|---|---|---|---|
| `⌘N` | `new_file` | menu | New untitled file |
| `⇧⌘N` | `new_window` | menu | New Lee window |
| `⌘O` | `open_file` | menu | Open a file |
| `⇧⌘O` | `open_folder` | menu | Open a folder as the workspace |
| `⌘S` | `save_file` | menu | Save the active file |
| `⇧⌘S` | `save_file_as` | menu | Save the active file to a new path |

## Tabs

| Chord | Action | Owner | What it does |
|---|---|---|---|
| `⌘Esc` | `close_tab` | renderer | Close the focused tab |
| `⌃Tab` | `next_tab` | renderer | Next center tab |
| `⌃⇧Tab` | `prev_tab` | renderer | Previous center tab |
| `⌘W` | `toggle_watch` | renderer | Toggle idle-watching on the focused agent tab |
| `⌘I` | `cycle_idle` | renderer | Cycle through watched agent tabs that have gone idle |
| `⌘1` | `tab_1` | renderer | Switch to center tab 1 |
| `⌘2` | `tab_2` | renderer | Switch to center tab 2 |
| `⌘3` | `tab_3` | renderer | Switch to center tab 3 |
| `⌘4` | `tab_4` | renderer | Switch to center tab 4 |
| `⌘5` | `tab_5` | renderer | Switch to center tab 5 |
| `⌘6` | `tab_6` | renderer | Switch to center tab 6 |
| `⌘7` | `tab_7` | renderer | Switch to center tab 7 |
| `⌘8` | `tab_8` | renderer | Switch to center tab 8 |
| `⌘9` | `tab_9` | renderer | Switch to center tab 9 |

## Tools

| Chord | Action | Owner | What it does |
|---|---|---|---|
| `⇧⌘T` | `terminal` | renderer | New terminal tab |
| `⇧⌘B` | `browser` | renderer | New browser tab |
| `⇧⌘E` | `files` | renderer | File tree |
| `⇧⌘H` | `hester` | renderer | Hester agent tab |
| `⇧⌘C` | `claude` | renderer | Claude Code agent tab |
| `⇧⌘I` | `pi` | renderer | Pi agent tab |
| `⇧⌘J` | `devops` | renderer | DevOps dashboard |
| `⇧⌘G` | `git` | renderer | Git TUI (lazygit) |
| `⇧⌘D` | `docker` | renderer | Docker TUI (lazydocker) |
| `⇧⌘F` | `flutter` | renderer | Flutter dev tools (flx) |
| `⇧⌘K` | `k8s` | renderer | Kubernetes TUI (k9s) |
| `⇧⌘P` | `sql` | renderer | SQL client (pgcli) |
| `⇧⌘Q` | `hester_qa` | renderer | Hester QA scene runner |
| `⇧⌘Y` | `library` | renderer | Library pane |
| `⇧⌘M` | `system` | renderer | System monitor (btop) |
| `⇧⌘W` | `workstream` | renderer | Workstream picker |

## View

| Chord | Action | Owner | What it does |
|---|---|---|---|
| `⌘0` | `mode_switcher` | renderer | Mode switcher: tap for the last mode, hold for Cockpit / Deep / Manual |
| `⇧⌘0` | `mode_deep` | renderer | Cockpit ↔ Deep |
| `⌥⌘0` | `mode_manual` | renderer | Cockpit ↔ Manual |
| `⌥⌘1` | `deep_view_page` | renderer | Deep: the exploration's Page |
| `⇧⌘R` | `force_reload` | menu | Reload the Lee UI, discarding caches (prompts if terminals are open) |
| `⌘↓` | `scroll_bottom` | renderer | Scroll the focused terminal to the bottom (ignored while a code editor has focus, where it means go-to-end) |
| — | View ▸ Reset Zoom | menu | Reset the zoom level. Menu only, no chord: `⌘0` is the mode switcher and `⇧⌘0` is Deep |

`mode_switcher` replaced `cockpit_toggle`; a `keybindings:` entry for
`cockpit_toggle` still applies to it.

## Editor

| Chord | Action | Owner | What it does |
|---|---|---|---|
| `⌘E` | `editor_markdown_preview` | editor | Toggle markdown preview (markdown files only; handled inside the editor panel) |
| `⌘F` | `editor_find` | editor | Find in file (CodeMirror's search keymap) |
| `⌘.` | `deep_actions` | renderer | Deep only: the selection's action row (Capture, Keep, Ask, Explore), or the visible typing affordance |

## Cockpit

Active only while the Cockpit is showing, and ignored while you type in a
field. Implemented by `keyAction` in `electron/src/renderer/lib/cockpitModel.ts`
(`COCKPIT_KEYS` is the list the in-Cockpit key help shows), not by the
registry, so these can't be overridden in `keybindings:`. Actions follow the
⌘-chord convention; only navigation is a bare key, so a stray keystroke can't
approve, deny or send anything. Every global chord above keeps working,
including `⌘1`–`⌘9` (tabs). Sections have no keys; click them.

| Chord | What it does |
|---|---|
| `⌘N` | New task (the Launcher). The File ▸ New File accelerator, which App routes to the Launcher while the Cockpit is showing |
| `↓` / `↑` | Next / previous row |
| `←` / `→` | Previous / next agent tile (within the drawer once it has focus) |
| `Enter` | Peek at the selected agent, or open the row |
| `⌘⏎` / `⌘D` | Approve / deny the selected approval |
| `⌘<` (`⇧⌘,`) | Reply to the selected item |
| `⌘>` (`⇧⌘.`) | Check in on the selected agent |
| `⌘E` | Rename the selected agent or task |
| `⌘{` (`⇧⌘[`) | Run ▾ operations |
| `⌘⌫` | Dismiss the selected Feed entry |
| `⌘T` | Focus your tabs (the drawer) |
| `Esc` | Close popovers, clear selection |

`⌘R` is deliberately unused: the main process's `before-input-event` hook
treats it as Reload everywhere except terminal, agent and browser tabs.

## Global (system-wide) shortcut

Lee can register one chord that works from any application, to bring its window
forward. It is **off by default** — a `globalShortcut` takes the chord away from
every other app on the machine, which Lee should not do uninvited. (It used to
claim `Cmd+Shift+L` unconditionally.)

```yaml
keybindings:
  global_focus_lee: cmd+shift+l   # or omit / set to false to leave it off
```

## Conflicts resolved in this pass (C15)

| Was | Now | Why |
|---|---|---|
| `⇧⌘O` bound to both File ▸ Open Folder… and the DevOps tab | Open Folder… keeps `⇧⌘O`; DevOps moved to `⇧⌘J` | The menu accelerator won every time, so the DevOps hotkey never fired |
| `⌘/` bound in both the Help menu and the hotkey map | Renderer owns it; the menu item has no accelerator | It fired the palette twice |
| `⇧⌘A` bound in both the View menu and the hotkey map | Renderer owns it; the menu item has no accelerator | It opened the pairing dialog twice |
| `⌘W` taken by the File ▸ Close menu role | The Close Window item keeps its place but loses the accelerator; `⌘W` is Watch, as documented | Menu accelerators resolve before the renderer sees the key, so Watch never fired. Close the window with the red button, the menu item, or `⌘Q` to quit |
| `⌘↓` always scrolled the terminal to the bottom | Ignored while a CodeMirror editor has focus | It shadowed the editor's go-to-end |
| `CommandOrControl+Shift+L` registered system-wide at startup | Opt-in via `keybindings.global_focus_lee` | It stole the chord from every other app |
| `⇧⌘0` bound to View ▸ Reset Zoom | Reset Zoom has no chord (menu only); `⇧⌘0` is Cockpit ↔ Deep (Deep D1) | The menu accelerator would have taken the Deep chord |

## Regenerating

There is no build step wired up for this file. After editing
`electron/src/shared/shortcuts.ts`, regenerate the tables above from
`SHORTCUTS` (the registry carries the chord, owner, group and description for
every row) and keep the two hand-written sections below the tables.
