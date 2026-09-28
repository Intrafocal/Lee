/**
 * Lee's Claude Code plugin: skills for reading the Desk and the Drawer
 * (docs/16-Desk.md). Like the hooks (hook-install.ts), Lee writes it to
 * ~/.lee/claude-plugin/ at startup and every Claude it launches gets
 * `--plugin-dir <it>`; the project's .claude/ is never touched, and Claude
 * sessions Lee didn't launch don't see it. The skills are read-only: they
 * call `hester desk …`, which reads .hester/desk/ and .hester/ideas/.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const PLUGIN_MANIFEST = {
  name: 'lee',
  version: '0.1.0',
  author: { name: 'Lee' },
  description: "Lee's Desk and Drawer, read-only: Areas, Page cards and their margins, your last card, stashed Areas and ideas.",
};

const HESTER_NOTE = `If \`hester\` isn't on PATH, use \`~/.lee/venv/bin/hester\`. Every command takes \`--dir <path>\` (any directory inside the workspace; it looks upward for \`.hester/desk/\`, so a worktree inside the repo finds the repo's Desk) and \`--json\`.`;

export const DESK_SKILL = `---
name: desk
description: Read the Operator's Desk in Lee (Deep mode): Areas, Page cards, a Page's text with its answers, hand-offs, open questions and references, and their last card and where they stopped. Use when they mention a Page, the Desk, an Area, "my notes", "what I was writing", "the Goals card", or ask you to build on or review something they wrote in Lee.
---

# Reading the Desk

The Desk is where the Operator does deep work in Lee: one per workspace, in \`.hester/desk/\`. **Areas** are named regions; each holds **Page** cards (markdown writing). A Page's margin holds **answers** (Hester's replies to their Asks), **hand-offs** (Spike, Docs or Research tasks given to an agent, with results), **open questions** and **references** (quotes, files, links). The pinned **Goals** card is their thinking about GOALS.md; GOALS.md itself is the source of truth.

## Commands (read-only)

- \`hester desk overview\`: the Areas on the Desk and their cards (id, title, size, last change), the Goals card, the Drawer's counts and the last card. Start here.
- \`hester desk page <id or title>\`: one Page's text, then its answers, hand-offs, open questions and references. A title can be part of one; if several match it lists them, so rerun with the id (\`pg-…\`). \`--text-only\` gives just the Page.
- \`hester desk last\`: the card they were last in and the last line they wrote ("where they stopped").

${HESTER_NOTE}

## How to use what you read

- Quote the Page when you rely on it, and say which Page (title and id).
- A Page is the Operator's own words and still in progress: treat it as their intent and open thinking, not as a spec, unless they say it is.
- Answers and hand-off results are Hester's or an agent's words, not the Operator's.
- **Don't write to \`.hester/desk/\`.** Lee and Hester own those files (versions, the migration, what's open in a window). If they want something on a Page, give them the text to paste, or ask them to use Lee.
- Stashed Areas and ideas are in the Drawer: see the \`lee:drawer\` skill.
`;

export const DRAWER_SKILL = `---
name: drawer
description: Read the Drawer on the Operator's Desk in Lee: Stashed Areas (Areas they stashed, with their Page cards) and Ideas (captures from Lee, the phone or the T-Deck; older builds said Someday), newest first, with search. Use when they mention the Drawer, something they stashed or parked, an idea they captured, "Ideas" or "Someday", or ask you to find an old Page that isn't on the Desk.
---

# Reading the Drawer

The Drawer holds what's off the Desk:
- **Stashed**: whole Areas the Operator stashed, with their Page cards (older Lee builds called this "Put away"). The Drawer's id is \`stashed\`. Their own Drawers can hold Areas too.
- **Ideas**: open captures, from Lee, Aeronaut (phone) or Dirigible (T-Deck), voice notes included. Stored in \`.hester/ideas/\` (ids \`idea_…\`).

## Commands (read-only)

- \`hester desk drawer\`: every Stashed Area (with its cards) and every open idea, newest first.
- \`hester desk drawer <words…>\`: only what matches every word, in any order, ignoring case (Area names, card titles, idea text, where an idea came from).
- \`hester desk page <id>\`: read a stashed Area's Page (the id from the drawer listing). See the \`lee:desk\` skill.

${HESTER_NOTE}

## Notes

- A stashed Area is parked, not deleted or finished: mention it if it bears on the work, but don't assume it's current.
- Ideas are raw one-liners, often typed on a phone: read generously, and ask before treating one as a decision.
- **Don't write to \`.hester/\`.** To act on an idea (start a Page, keep, drop) or unstash an Area, the Operator does it from the Drawer in Lee.
`;

export interface PluginPaths {
  dir: string;
  manifest: string;
  skills: Record<string, string>;
}

export function pluginPaths(home: string = os.homedir()): PluginPaths {
  const dir = path.join(home, '.lee', 'claude-plugin');
  return {
    dir,
    manifest: path.join(dir, '.claude-plugin', 'plugin.json'),
    skills: {
      desk: path.join(dir, 'skills', 'desk', 'SKILL.md'),
      drawer: path.join(dir, 'skills', 'drawer', 'SKILL.md'),
    },
  };
}

let activeDir: string | null = null;

function writeIfChanged(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== content) fs.writeFileSync(file, content, { mode: 0o644 });
}

/** Write ~/.lee/claude-plugin/ (with hooks enabled); remove it when they're off, so no flag is added. */
export function installClaudePlugin(enabled: boolean, home?: string): PluginPaths {
  const p = pluginPaths(home);
  if (!enabled) {
    fs.rmSync(p.dir, { recursive: true, force: true });
    activeDir = null;
    return p;
  }
  writeIfChanged(p.manifest, JSON.stringify(PLUGIN_MANIFEST, null, 2) + '\n');
  writeIfChanged(p.skills.desk, DESK_SKILL);
  writeIfChanged(p.skills.drawer, DRAWER_SKILL);
  activeDir = p.dir;
  return p;
}

/** The plugin directory to pass as `--plugin-dir`, when it's installed. */
export function claudePluginDir(): string | null {
  return activeDir && fs.existsSync(path.join(activeDir, '.claude-plugin', 'plugin.json')) ? activeDir : null;
}
