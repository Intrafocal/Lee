# Hester - The AI Daemon

> Watchful, practical, no BS.

## Overview

**Hester** is the AI daemon that accompanies the Lee editor. Named after Lee Scoresby's daemon in Philip Pullman's *His Dark Materials*--an arctic hare who speaks truth, watches what Lee can't see, and keeps him grounded.

Hester serves the developer the way a daemon serves their human: always present, always watching, deeply contextual.

## Core Principle

**Hester is built to solve real problems for developers working in complex codebases.**

- Code exploration and understanding via ReAct-loop agents
- Documentation validation and drift detection
- Context management across long-running development sessions
- Service orchestration and DevOps automation
- Extensible via plugins for project-specific tools

## Hard Boundaries

Hester will **never**:
- Touch production user data
- Make direct code changes (suggest only)
- Send external communications
- Modify production database
- Be exposed to end users

## Architecture

### Directory Structure

```
hester/
├── cli.py                  # CLI entry point (hester command)
├── __init__.py
├── daemon/                 # FastAPI daemon service
│   ├── main.py             # HTTP server on port 9000
│   ├── agent.py            # ReAct loop agent
│   ├── session.py          # Redis session management (chat sessions)
│   ├── cockpit/            # Cockpit tasks, follower, the Desk (desk.py, board.py, desk_routes.py); explorations.py is the Desk migration's source
│   ├── copilot/            # Ideas store, digest, opener, retro, usage, metrics, model-call logging
│   ├── voice/              # Transcription for the mic (config, audio, hints, routes, providers/)
│   ├── settings.py         # Configuration
│   ├── models.py           # Pydantic models
│   ├── thinking_depth.py   # Response depth control
│   ├── plugins/            # Plugin system
│   │   ├── loader.py       # Plugin discovery and loading
│   │   └── models.py       # PluginManifest, LoadedPlugin
│   ├── tasks/              # Background task system
│   │   ├── planner.py      # Task planning
│   │   ├── store.py        # Task persistence
│   │   ├── executor.py     # Task execution
│   │   ├── models.py       # Task/Batch models with serialization
│   │   ├── claude_delegate.py      # Claude Code delegation
│   │   ├── hester_agent_delegate.py # Scoped codebase exploration
│   │   └── gemini_grounded_delegate.py # Web research with sources
│   ├── tools/              # Available tools
│   │   ├── file_read.py    # File reading
│   │   ├── db_tools.py     # Database queries
│   │   ├── doc_tools.py    # Documentation tools
│   │   ├── web_search.py   # Web search
│   │   ├── devops_tools.py # Docker/service management
│   │   ├── summarize.py    # Text summarization
│   │   ├── ui_control.py   # Lee IDE + browser control
│   │   └── scoping.py      # Tool scoping for subagents
│   └── registries/         # Prompt and agent registries
├── docs/                   # HesterDocs - Documentation validation
│   ├── agent.py            # Docs agent
│   ├── models.py           # Drift reports, claims
│   └── embeddings.py       # Vector embeddings
├── devops/                 # HesterDevOps - Service management
│   ├── manager.py          # Service orchestration
│   └── tui.py              # DevOps dashboard TUI
├── shared/                 # Shared utilities
│   ├── surfaces.py         # Output formatting
│   └── gemini_tools.py     # Gemini API integration
└── logs/                   # Test logs output
```

### Technology Stack

| Component | Technology |
|-----------|------------|
| CLI Framework | Click |
| HTTP Server | FastAPI + Uvicorn |
| AI Model | Gemini 2.5 Flash (ReAct loop) |
| Sessions | Redis |
| Browser Automation | Chrome DevTools Protocol (MCP) |
| Database | Supabase (local/production) |
| Output | Rich Console |
| Lee Integration | WebSocket client for live context |

## Core Capabilities

1. **Chat** - Interactive AI-powered code exploration with ReAct loop
2. **Agents** - Scoped headless agents (code explorer, web researcher, docs manager, db explorer, test runner)
3. **Context Bundles** - Reusable knowledge packages aggregating code, docs, and schemas
4. **DevOps** - Service management, Docker Compose, health checks
5. **Documentation** - Drift detection, semantic search, claim validation
6. **Plugin System** - Project-specific tools, commands, prompts, and agents via `.hester/plugins/`

## Plugin System

Hester supports workspace plugins for project-specific extensions. Plugins are declared in `.lee/config.yaml` and loaded at daemon startup.

**Plugin structure:**
```
.hester/plugins/my-project/
├── plugin.yaml          # Manifest (name, version, tools, commands, etc.)
├── tools/               # MCP-style tool modules (TOOLS + HANDLERS exports)
├── commands/            # Click CLI command groups
├── modules/             # Full Python modules (added to sys.path)
├── prompts/             # Markdown prompt templates
├── prompts.yaml         # Prompt configurations
└── agents.yaml          # Agent and toolset configurations
```

**plugin.yaml example:**
```yaml
name: my-project
version: 0.1.0
description: "Project-specific tools for my-project"

python_paths:
  - modules/

tools:
  - my_tools
commands:
  - my_command
prompts:
  - my_prompt
agents:
  - my_agent
```

Plugins can add tools, CLI commands, prompts, agents, and full Python modules. The `python_paths` field injects directories into `sys.path` at load time for complex module dependencies.

## CLI Reference

### Installation

```bash
pip install -e .
```

### Global Commands

```bash
hester --version           # Show version
hester --help              # Show help
```

### Chat Command

AI-powered code exploration assistant using Gemini with ReAct loop.

```bash
# Interactive chat session (no server needed)
hester chat [options]
  --dir, -d PATH           # Working directory
  --tasks-dir PATH         # Task files directory
  --daemon-url URL         # Connect to running daemon

# Examples
hester chat                           # Direct mode (local)
hester chat --dir /path/to/project    # Specify working directory
hester chat --daemon-url http://localhost:9000  # Connect to daemon
```

### Agent Command

Headless agent for scoped queries. Available agent types:

| Type | Purpose |
|------|---------|
| `code_explorer` | Search and analyze codebase files |
| `web_researcher` | Research topics using Google Search |
| `docs_manager` | Documentation search, drift check, write/update |
| `db_explorer` | Natural language database exploration |
| `test_runner` | Run test suites (pytest, flutter, jest) |

```bash
# Run a scoped agent query
hester agent <TYPE> [PROMPT] [options]
  --toolset, -t SCOPE      # Tool scope: observe|research|develop|full (default: observe)
  --tools TEXT             # Comma-separated tool list (overrides --toolset)
  --context, -c PATH       # Path to context bundle file
  --output, -o FORMAT      # Output format: text|json|markdown (default: text)
  --max-steps, -m N        # Max ReAct iterations (default: 10)
  --quiet, -q              # Suppress progress, only print result
  --dir, -d PATH           # Working directory

# Examples
hester agent code_explorer "Find all usages of AuthService"
hester agent web_researcher "Best practices for pgvector indexes"
hester agent docs_manager "How does authentication work?"
hester agent db_explorer "What tables store user data?"
hester agent test_runner --path tests/
hester agent code_explorer "What does auth.py do?" --output json --quiet
```

**Tool Scopes:**

| Scope | Tools Available |
|-------|-----------------|
| `observe` | read_file, search_files, search_content, list_directory, change_directory |
| `research` | observe + web_search, db_*, semantic_doc_search, summarize, context bundles |
| `develop` | observe + write_file, edit_file, bash |
| `full` | All tools except orchestration |

**Subagent Restrictions:**

The agent command runs with `is_subagent=True`, which **hard blocks** orchestration tools:
- `create_task`, `get_task`, `update_task`, `list_tasks`
- `add_batch`, `add_context`, `mark_task_ready`, `delete_task`

Attempting to use these tools raises `ForbiddenToolError`.

### Daemon Commands

Server mode for persistent sessions and sub-task orchestration.

```bash
# Start daemon server
hester daemon start [options]
  --port, -p PORT          # Port (default: 9000)
  --host, -h HOST          # Host (default: 127.0.0.1)
  --background, -b         # Run in background
  --reload                 # Enable auto-reload

# Manage daemon
hester daemon stop         # Stop background daemon
hester daemon status       # Check daemon status
hester daemon logs         # View logs

# Examples
hester daemon start --reload          # Development mode
hester daemon start -b -p 9000        # Background daemon
```

### Database Commands

Read-only database exploration using Supabase MCP.

```bash
# List tables
hester db tables
hester db tables --schema public

# Describe table structure
hester db describe <table_name>
hester db describe users --schema auth

# List functions
hester db functions
hester db functions --filter match

# View RLS policies
hester db rls <table_name>

# View constraints
hester db constraints <table_name>

# Execute SELECT queries (read-only)
hester db query "SELECT * FROM users" --limit 10
hester db query "SELECT id, name FROM users" --json

# Count rows
hester db count <table_name>
hester db count users --where "active = true"
```

### Context Bundle Commands

Create and manage reusable context packages that aggregate information from multiple sources.

```bash
# Create a bundle with sources
hester context create <name> [options]
  --file, -f PATH          # Add file source
  --glob, -g PATTERN       # Add glob pattern source
  --grep, -r PATTERN       # Add grep search source
  --semantic, -s QUERY     # Add semantic search source
  --db-schema, -d TABLES   # Add database schema source
  --ttl, -t HOURS          # TTL in hours (default: 24, 0=manual only)
  --tag TAG                # Add tag (can repeat)

# List bundles
hester context list
hester context list --stale-only

# Show bundle content
hester context show <name>
hester context show <name> --meta    # Show source metadata

# Refresh bundles
hester context refresh <name>        # Refresh specific bundle
hester context refresh --all         # Refresh all stale bundles
hester context refresh <name> --force # Force refresh even if unchanged

# Add source to existing bundle
hester context add <name> [source options]

# Copy bundle to clipboard
hester context copy <name>

# Delete bundle
hester context delete <name>
hester context delete <name> --yes   # Skip confirmation

# Prune old bundles
hester context prune --older-than 30  # Delete bundles older than N days

# Show status summary
hester context status

# Examples
hester context create auth-system \
  --file src/auth.py \
  --grep "jwt|token" \
  --db-schema users \
  --ttl 48

hester context show auth-system
hester context copy auth-system
```

### Documentation Commands (HesterDocs)

Documentation validation and semantic search.

```bash
# Check docs for drift
hester docs check <doc_path>
hester docs check --all
hester docs check README.md --threshold 0.8 --verbose

# Semantic search
hester docs query "How does authentication work?"
hester docs query "What is the matching algorithm?" --limit 10

# Generate drift report
hester docs drift
hester docs drift --output drift-report.json

# Extract claims from a doc
hester docs claims README.md
hester docs claims docs/api.md --types function --types api

# Index documentation for search
hester docs index README.md
hester docs index docs/ src/
hester docs index --all
hester docs index --all --clear

# Check index status
hester docs index-status
```

### Ideas, Goals, Desk and Voice Commands

```bash
# Capture an idea (writes <dir>/.hester/ideas/idea_*.md; no daemon needed). Was `hester someday`.
hester ideas capture "Try a CRDT for the queue" [--dir PATH] [--explore]
hester ideas list [--dir PATH] [--all]

# GOALS.md metrics from Lee's event log (~/.lee/events/), deterministic
hester goals metrics [--since 14d] [--until now] [--workspace PATH] [--write] [--json]

# The Desk and the Drawer, read-only from .hester/desk/ and .hester/ideas/ (no daemon; never writes).
# --dir is any directory inside the workspace (it looks upward); --json for machines.
# Claude Code sessions Lee launches get these as the lee:desk and lee:drawer skills
# (electron/src/main/copilot/claude-plugin.ts, passed with --plugin-dir).
hester desk overview              # Areas and their cards (Pages and Boards, with kind), the Goals card, the Drawer's counts, the last card
hester desk page <id or title>    # a Page's text, answers, hand-offs, open questions, references, images (as paths) [--text-only]
hester desk board <id or title>   # a Board's images (absolute paths, with source), annotations, highlights, links, asks, hand-offs and visualizes (the image's path, or "mermaid diagram"/"markdown" and the title)
hester desk last                  # the last card and where you stopped
hester desk drawer [words...]     # Stashed Areas and Ideas, newest first; words filter

# Voice (docs/plans/2026-09-28-tether-review-voice.md §5): off unless hester.voice.enabled: true
hester voice status [--json]      # what GET /voice says: provider, model, available or why not
hester voice setup                # provider whisper: download the model (the only network fetch; needs lee-tools[voice-local])
hester voice test FILE.wav        # transcribe a 16 kHz mono 16-bit WAV with the configured provider
```

### Ask Commands

Ask questions using Gemini with web search.

```bash
# Ask Gemini (with Google Search grounding)
hester ask gemini "Current Bitcoin price"
hester ask gemini "Latest AI news" --verbose
hester ask gemini "Explain photosynthesis" --no-search
```

### DevOps Commands (HesterDevOps)

Service management for local development.

```bash
# TUI Dashboard
hester devops tui
hester devops tui --dir /path/to/project

# Service management
hester devops status                  # Show all services
hester devops start <service>         # Start a service
hester devops stop <service>          # Stop a service
hester devops logs <service> -f       # Follow logs
hester devops health                  # Run health checks

# Docker Compose integration
hester devops docker                  # Container status
hester devops docker --logs redis     # Container logs
hester devops up                      # docker-compose up
hester devops up api --build          # Build and start
hester devops up --no-cache           # Force rebuild
hester devops down                    # Stop all
hester devops down -v                 # Remove volumes
hester devops rebuild                 # Full rebuild
hester devops rebuild api --no-cache  # Rebuild specific
hester devops build                   # Build images
hester devops ps                      # docker-compose ps
```

## Live Context from Lee

When the daemon runs alongside Lee, it receives **real-time IDE context** via WebSocket. This means Hester automatically knows what you're working on without you having to explain.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Lee (Electron)                                                          │
│                                                                          │
│  ContextBridge ──WebSocket──► Hester Daemon (port 9000)                 │
│       │                            │                                     │
│       │                       LeeContextClient                          │
│       │                            │                                     │
│       │                       Agent._build_system_prompt()              │
│       │                            │                                     │
│       │                       "You have lazygit open..."                │
└─────────────────────────────────────────────────────────────────────────┘
```

### What Hester Sees

When you ask a question, the system prompt automatically includes:

```
Current file open in editor: /path/to/main.py
Language: python
Cursor at line 42, column 5
Selected text: [if any]

Focused panel: center
Open tabs:
  → [editor] main.py
    [git] lazygit
    [terminal] Terminal 1

Recent actions:
  - file_open: main.py
  - tab_switch: 2

User idle for 120s
```

### Context-Aware Examples

| You Ask | Hester Understands |
|---------|-------------------|
| "What does this do?" | Reads the file currently open in editor |
| "Help me push this branch" | Sees lazygit is open, knows you're doing git work |
| "What's failing?" | Checks recent actions, terminal output context |
| "Explain this error" | Uses cursor position to find relevant code |

### LeeContextClient

The daemon uses `LeeContextClient` (`daemon/lee_client.py`) to:
- Connect to Lee's WebSocket at `ws://localhost:9001/context/stream`
- Auto-reconnect with exponential backoff (5s to 60s)
- Cache latest context for instant access
- Provide convenience methods: `current_file`, `focused_panel`, `idle_seconds`

### UI Control Tool

Hester can control Lee via the `ui_control` tool with these domains:

| Domain | Actions | Description |
|--------|---------|-------------|
| `system` | focus_tab, close_tab, create_tab, focus_window | Tab/window management |
| `editor` | open, save, close | File operations |
| `tui` | git, docker, k8s, flutter, terminal, custom | Spawn TUI apps |
| `panel` | focus, toggle, show, hide, resize | Panel control |
| `browser` | navigate, screenshot, dom, click, type, fill_form | Browser automation |

**Browser automation examples:**
```python
# Navigate (requires user approval for new domains)
{"domain": "browser", "action": "navigate", "params": {"tab_id": 1, "url": "https://github.com"}}

# Screenshot (returns base64 PNG)
{"domain": "browser", "action": "screenshot", "params": {"tab_id": 1}}

# Get DOM for element discovery
{"domain": "browser", "action": "dom", "params": {"tab_id": 1}}

# Click element
{"domain": "browser", "action": "click", "params": {"tab_id": 1, "selector": "#login-btn"}}

# Type into input
{"domain": "browser", "action": "type", "params": {"tab_id": 1, "selector": "input[name=email]", "text": "user@example.com"}}

# Fill form
{"domain": "browser", "action": "fill_form", "params": {"tab_id": 1, "fields": [{"selector": "#email", "value": "a@b.com"}]}}
```

**Security:** Navigation to new domains requires user approval. Pre-approved: google.com, github.com, stackoverflow.com, duckduckgo.com.

### Hester TUI in Lee

When spawned from Lee (`Cmd+Shift+H`), Hester TUI automatically connects to the daemon:
```bash
hester chat --daemon-url http://localhost:9000 --dir /workspace
```

This ensures the TUI session shares context with Command Palette queries.

## Daemon API

When running as a server (`hester daemon start`), exposes REST API:

### Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/health` | Health check |
| POST | `/context` | Process context from Lee |
| POST | `/context/stream` | SSE streaming context (for Command Palette) |
| GET | `/session/{id}` | Get session info |
| DELETE | `/session/{id}` | Delete session |
| GET | `/sessions` | List active sessions |
| POST | `/ideas` | Capture an idea into `<workspace>/.hester/ideas/` (was `/someday`; the old directory is never read) |
| GET | `/ideas` | List ideas (`?workspace=&status=open\|all`) |
| POST | `/ideas/{id}/triage` | Triage an idea (`explore`, `promote`, `drop`, `keep`; `to: task` makes a task, `to: explore` a Page card); logs `idea.triage {idea_id}` (metrics also count the old `someday.triage`) |
| GET | `/copilot/digest` | Deterministic session-start digest: verified wins, agent claims, waiting items |
| GET/POST | `/copilot/retro` | Weekly retro questions / answers (`~/.hester/retro/`) |
| GET/POST/PUT | `/desk`, `/desk/migrate`, `/desk/last` | The Desk (`docs/16-Desk.md`; contract `docs/plans/2026-09-27-desk-foundation-contract.md` §3–§6) in `<ws>/.hester/desk/`: `desk.json` (Areas, card layout, Drawers, the Goals card, strokes, `last`, the migration map), `sessions.jsonl`, and `pages/<pg-id>/` (`card.json`, `page.md`, `answers.jsonl`, `references.jsonl`, `questions.jsonl`, `assets/`). Every Desk read first migrates `.hester/explore/` when it's due: copies (never writes there), idempotent through `migration.map`, `exp-<hex>` → `pg-<hex>` / `area-<hex>`, empty Untitled ones skipped, archived ones stashed, node trees and chats dropped; a `desk.json` from before 2026-09-28 has its `put-away` Drawer and `put_away_at` rewritten to `stashed` / `stashed_at` once. `GET /desk/last` is the last card and its stopped-at line (`last`, the last session's card, the most recently written) with what arrived since |
| POST/PATCH/DELETE | `/desk/areas[/{id}]`, `/desk/areas/{id}/stash`, `/unstash`, `/desk/drawers[/{id}]`, `/desk/cards/{id}` | Areas (an empty Desk gets `Main`; DELETE only when empty, else 409 `not_empty`, unless `{with_cards: true}`: the user confirmed, and its cards go too; its strokes always go), the Stashed Drawer (`stashed`; unstash of an Area on the Desk is 409 `not_stashed`) and your own (`drw-`; `ideas` is the Ideas store's), card layout (`{x, y, w, h, area_id}`: a card moves within its Area or into another on the Desk, 400 for a malformed or stashed Area; the pinned Goals card doesn't move) |
| POST/DELETE | `/desk/strokes[/{id}]` | Freehand lines you draw on the Desk; they mean nothing, so Hester never reads, places or connects them. `{area_id: str\|null, points: [[x, y], …], width?}` → `{id: 'stk-<hex>', area_id, points, width, created_at}`; points are relative to the Area (or the Desk when `area_id` is null), 2–2000 per stroke, at most 2000 strokes per Desk, width above 0 and at most 64 (default 2), 400 otherwise. An Area's strokes move with it, stay with it when stashed, and go when it's deleted. `GET /desk` returns `strokes` |
| * | `/desk/pages[/{id}[/page\|/references\|/answers\|/asks\|/handoffs\|/questions\|/draft-from-readme]]` | Page cards: the Page's routes (deep.py's functions, the rules the pre-Desk exploration Page had: 1 MB, 409 `version_conflict`, anchors, file references, DELETE only an empty Untitled card, unless `{force: true}`: the user confirmed). `POST /desk/pages {purpose: 'goals'}` returns the existing Goals card with 200. Hand-offs launch with origin `{kind: 'page', ref: '<pg>#<ans>'}`; `deep.answer` carries `card_id` and `exploration_id` (the same id) |
| POST/GET | `/desk/pages/{id}/assets`, `/desk/pages/{id}/assets/{name}` | Images on a Page: the raw body with `Content-Type: image/png\|image/jpeg` (checked against the bytes), up to 10 MB (413; 415 for another type), optional `?source=` JSON (`AssetSource` in `shared/board.ts`: card, answer, file or url, plus `taken_at`; recorded only) → 201 `{name: 'img-<hex>.png', path: 'assets/<name>'}`, stored 0600 in `pages/<id>/assets/` with a row in `assets.jsonl`; GET serves it. Deleting the card deletes them |
| * | `/desk/boards[/{id}[/board\|/assets[/{name}]\|/preview\|/answers\|/asks\|/handoffs\|/visualize]]` | Board cards (`docs/16-Desk.md` §3.1, plan `docs/plans/2026-09-28-boards.md`; `cockpit/board.py`, contract `electron/src/shared/board.ts`) in `boards/<bd-id>/`: `card.json`, `board.json` (`{version, items}`, the whole document: PUT with a stale `version` is 409 `version_conflict` with the current `items`, `null` only for an empty Board; 1 MB, 2000 items; items checked by kind: image, note, highlight, stroke, ask, handoff, link, visual), `assets.jsonl` + `assets/` (`img-<hex>` images, `sel-<hex>.png` selections with `?kind=selection`; `?source=`), `preview.png` (PUT by Lee, GET `no-cache`), `answers.jsonl`. `POST /desk/boards {area_id?, title?, x?, y?}` → `{card, board}`; DELETE like a Page's (`{force}`). In `desk.json` a Board is a card with `kind: 'board'`, so Areas, Move, Stash, Delete, the Drawer, `GET /desk` (its `summary.board` has counts, `asks_open`, `preview_at`), `last` and sessions take it. An Ask's or hand-off's anchor is `{kind: 'board', item_ids, rect, snapshot: 'assets/sel-<hex>.png', notes}` (the snapshot must be that Board's). **A Board Ask** goes straight to Gemini with the snapshot as an image part and the annotations (`hester.google_api_key`, `hester.voice.gemini_model`), never to a local model; with no key it ends in `error` saying so. A Board hand-off's brief gets the snapshot's absolute path and the annotations; Lee launches it with origin `{kind: 'board', ref: '<bd>#<ans>'}`. **Visualize** (B6, `cockpit/visualize.py`): `POST /desk/boards/{id}/visualize {brief, anchor}` → 201 a `kind: 'visualize'` row (`visual: null`), run by the Ask runner (queue, trigger, `deep.answer`, Retry, interrupted on restart) through the registry's `diagram` agent (prompt `visualize`, its tier and steps) in its own Gemini ReAct loop with the snapshot as an image part and only the visualization tools; never the prepare step or a local model. The last visual tool result becomes `visual` (`VisualResult`): an image is saved as a Board asset (`img-<hex>`, source `{kind: 'answer', card_id, answer_id}`), a Mermaid diagram or markdown is kept as text; Lee places it. `generate_image` reads the key like the rest of Hester (`voice/config.google_api_key`) |
| GET/POST | `/desk/sessions`, `/desk/ideas/{idea_id}/page` | Desk session records (`cards_touched`, `stopped_card_id`, `questions_kept` as card-and-question pairs, reason `device` too; away/quit sessions with no record are written from the event log by the opener). An idea as a Page card in a new Area (or `area_id`), marking it explored; 409 `not_open` |
| GET | `/voice` | Voice capabilities (`shared/voice.ts` `VoiceCapabilities`): `{enabled, available, reason?, provider, model, location, accepts, sample_rate, channels, max_seconds, max_bytes}`; `reason` is `disabled`, `no_api_key`, `whisper_not_installed` or `whisper_model_missing`. Config `hester.voice: {enabled, provider: gemini\|whisper, gemini_model, whisper_model, max_seconds, timeout_s}` (merged config, `HESTER_VOICE_*` overrides) |
| POST | `/voice/transcribe?purpose=reply\|capture\|ask\|send&item_id=&workspace=` | A 16 kHz mono 16-bit PCM WAV as the raw body (`Content-Type: audio/wav`) → `{text, provider, model, location, audio_ms, latency_ms}`. Errors: 503 `voice_disabled` / `voice_unavailable` (+ `reason`), 415 `unsupported_media_type`, 413 `too_large` (Content-Length, before reading) or `too_long`, 422 `too_short`, 502 `provider_error`, 504 `timeout`. The vocabulary hint (≤ 40 terms) comes from the attention item (`reply`) a Page card (`item_id` = `pg-…`: title and headings) or a Board card (`bd-…`: title and annotation text), Lee's tab labels and open files, and the workspace name. Single pass, no session; audio, hint and text are never stored or logged. Each attempt logs `voice.transcribe` (sizes and timings only) |
| GET | `/cockpit/usage?range=today\|week\|month` | Usage (`docs/15-Usage.md` §5): latest `limits` with age, `totals` and `by_day` by source (claude, pi, hester_cloud, hester_local) with spend (billed + estimate, dollars) apart from subscription (tokens only) and local, `hester` split by trigger, `top_tasks`. Pull-only. Tasks carry `usage` from `agent.usage` (follower) |
| GET/POST | `/workspace` | The active workspace (focused Lee window's); POST sets it and re-points plugins, knowledge and watchers |
| GET | `/workspaces` | Workspaces the daemon is serving (`POST /workspaces/open`, `/workspaces/close`) |
| GET | `/cockpit/snapshot` | Cockpit model for a workspace (`?since_version=` returns `{unchanged}`) |
| GET/POST/PATCH | `/cockpit/tasks[/{id}]` | Task records in `<ws>/.hester/cockpit/tasks/`; `/{id}/confirm`, `/link`, `/close`, `/promote`. Each save derives `quadrant`, `urgency` and `importance_rank` from GOALS.md; PATCH `{important?, urgent?}` sets or clears overrides (logged as `task.override`) |
| GET | `/cockpit/goals`, `/cockpit/history`, `/cockpit/readings` | GOALS.md ids, verified wins + closed tasks (with `goal_impact`) + readings (with `goal_id`, `delta`), operation readings |
| GET | `/cockpit/goals/status?days=7` | Per goal: metric values, trend and ok against targets, what serves it, `flagged`, `last_evaluated_at`, focus time; constraints, tensions and the `human_balance` strip. Deterministic (computes a metrics record when the newest one of that window length is over an hour old; `previous` is a record at least half a window older) |
| POST | `/cockpit/what-next`, `/cockpit/goals/{gid}/evaluate`, `/cockpit/tasks/{id}/suggest`, `/cockpit/ask` | Steward answers (user-triggered model calls): `{text, proposals, steer, surface, request_id}`. Evaluate adds the deterministic `packet`, `stale_measure` and saves `.hester/goals/evaluations/<gid>-<stamp>.md` (`{packet_only: true}` returns the packet without a model call). Ask classifies steer vs ask deterministically; a steer returns the exact text to type and sends nothing |
| POST | `/cockpit/goals/draft`, `/cockpit/goals/draft/{id}/apply` | Guided GOALS.md edit: a draft in `.hester/goals/drafts/` with a unified diff; apply writes GOALS.md only on that call and only if the file is unchanged since the draft (409 otherwise). Never commits |
| POST | `/cockpit/goals/{gid}/workstream` | Build toward: a workstream with `serves: [gid]` |
| GET/POST | `/cockpit/steward` | `{enabled, not_today_until, active}`; POST `{not_today: bool}` quiets the steward until local midnight. `hester.steward: on\|off` in `.lee/config.yaml` |
| POST | `/cockpit/proposals/{id}/outcome` | `{outcome: accepted\|dismissed}` for a proposal from a steward answer (`.hester/cockpit/proposals.jsonl`) |
| POST | `/cockpit/tasks/{id}/escalate` | A Page card from the task (its title, the agent's last report, its files), origin `{kind: 'task', ref}`, in the Desk's first Area → 201 `{card, area}`; the task stays open with the note `page:<card id>`. The pre-Desk `/cockpit/explorations/*` and `/library/sessions/*` routes are gone (2026-09-28); `.hester/explore/` is only the Desk migration's source |
| POST/PATCH | `/desk/pages/{id}/handoffs`, `/answers/{aid}` | Deep hand-offs (`docs/plans/2026-09-27-deep-next-contract.md` §2): a `kind: 'handoff'` record in `answers.jsonl`; PATCH `{task_id}` links Lee's launched task (origin `{kind: 'page', ref: '<pg>#<aid>'}`; an old `exploration` origin still syncs) and `handoffs.sync` (follower, task routes) keeps its state and result in step. `GET /cockpit/handoff-template?kind=` returns the brief template |

Every endpoint except `/health` needs `Authorization: Bearer <token>`: the shared `~/.lee/api-token`, or a paired device's own token (checked against `~/.lee/devices/*.json`).

**Which workspace a request is about:** `?workspace=<abs>` or the `X-Lee-Workspace` header (the auth middleware validates it, 400 otherwise, and scopes `get_current_workspace()` to it for the request), else the active workspace. Copilot endpoints also accept a JSON-body `workspace`. One daemon serves every Lee window: Cockpit tasks, readings and workstreams are per workspace (`hester/daemon/workspaces/`), while plugins, knowledge, watchers and the bundle service follow the active workspace. **`.hester/` stays out of git:** the first time Hester writes to a workspace's `.hester/` (opening it, the Desk, an idea), it adds `.hester/.gitignore` (`*`, `!plugins/`, `!plugins/**`; `hester/daemon/hester_dir.py`), so the Desk, Ideas and tasks are never committed while a project's own Hester plugins can be. The project's `.gitignore` is never touched, and an existing `.hester/.gitignore` is left alone. The Cockpit event follower (`hester/daemon/cockpit/follower.py`) tails `~/.lee/events/` (cursor in `~/.hester/cockpit/follower.json`) and keeps task records current; it is deterministic and runs no model.

### Copilot: C1/C2 gating and model-call logging

- Every Gemini call in the daemon (class-level wrap of `google.genai` `Models`/`AsyncModels`) and every Ollama call in `prepare.py` is sent to Lee's event log (`POST :9001/events/ingest`) as `model.call` with its trigger: `user` inside an authenticated request (surface: the `ContextRequest.surface`, else `X-Lee-Trigger` (the palette sends `palette`, the Hester TUI `tui`), else `http`), `automatic` for background loops, `unknown` otherwise.
- Each `model.call` carries a `usage` object when tokens are known (`docs/15-Usage.md` §4.1): Gemini `usage_metadata` (streams: the last chunk's; embeddings: per-embedding token counts), Ollama eval counts (basis `local`), Claude delegates (`provider: anthropic`, basis `billed` with `ANTHROPIC_API_KEY`, else `subscription`). Gemini dollars are estimates from `hester/daemon/copilot/prices.yaml`, overridable under `usage.prices` in `~/.lee/config.yaml`; unknown models get tokens, no cost.
- Knowledge auto-match (`hester.proactive.knowledge_auto_match`) is off by default. The model-using proactive tasks (`docs_index`, `drift_check`, `bundles`) are off by default and, when enabled, run only while you're away from the machine (Lee's `GET /presence`) unless `hester.proactive.run_while_present` is true.

### Health Check Response

```json
{
  "status": "healthy",
  "service": "hester-daemon",
  "port": 9000,
  "components": {
    "redis": "healthy",
    "agent": {
      "status": "healthy",
      "model": "gemini-2.5-flash",
      "tools_registered": 12
    }
  }
}
```

### Context Request

```json
{
  "session_id": "optional-session-id",
  "message": "What does this function do?",
  "editor_state": {
    "working_directory": "/path/to/project",
    "open_files": ["/path/to/file.py"],
    "active_file": "/path/to/file.py"
  }
}
```

### SSE Streaming (Command Palette)

The `/context/stream` endpoint returns Server-Sent Events for real-time ReAct updates:

```
event: phase
data: {"phase": "thinking", "iteration": 1}

event: phase
data: {"phase": "acting", "tool_name": "read_file", "tool_context": "main.py"}

event: phase
data: {"phase": "observing", "iteration": 1}

event: response
data: {"session_id": "abc123", "text": "The function...", "iterations": 2}

event: done
data: {"session_id": "abc123"}
```

**Event Types:**
- `phase` - ReAct phase updates (preparing, thinking, acting, observing, responding)
- `response` - Final response with metadata
- `error` - Error information
- `done` - Processing complete

## Documentation Validation

HesterDocs detects drift between documentation and code:

1. **Extract Claims** - Parse docs for verifiable statements
2. **Validate** - Check claims against actual code
3. **Report Drift** - Surface mismatches by severity

### Claim Types

- `function` - Function/method names and signatures
- `api` - API endpoints and parameters
- `config` - Configuration options
- `flow` - Process/workflow descriptions
- `schema` - Database schema references

## Subagent System

Hester uses a **delegate pattern** for task execution. The daemon orchestrates work by decomposing tasks into batches, each handled by a specialized delegate.

### Batch Delegates

| Delegate | Purpose | When to Use |
|----------|---------|-------------|
| `claude_code` | Full IDE capabilities via Claude Code | Complex multi-file changes, refactoring |
| `code_explorer` | Scoped codebase exploration | Research queries with tool restrictions |
| `web_researcher` | Web research with sources | Questions requiring current web data |
| `docs_manager` | Documentation management | Search, drift check, write/update docs |
| `db_explorer` | Natural language database queries | Schema exploration, data analysis |
| `test_runner` | Multi-framework test execution | pytest, flutter, jest test suites |
| `validator` | Internal validation actions | Linting, type checking |
| `manual` | Human intervention required | Approval gates, manual steps |

### CodeExplorerDelegate

Runs a standalone ReAct loop with tool scoping. Cannot orchestrate tasks or spawn other agents.

```python
# Used internally by TaskExecutor
delegate = CodeExplorerDelegate(
    working_dir=Path("."),
    toolset="observe",      # or "research", "develop", "full"
    scoped_tools=None,      # Override with specific tool list
    max_steps=10,
)
result = await delegate.execute(prompt="Find auth patterns", context="...")
```

**Key behaviors:**
- Hard enforcement of forbidden tools (raises `ForbiddenToolError`)
- Returns structured output with findings
- Summarizes output for context chaining

### WebResearcherDelegate

Executes web research using Gemini with Google Search grounding.

```python
delegate = WebResearcherDelegate(
    model="gemini-2.5-flash",
    max_sources=10,
)
result = await delegate.execute(prompt="Best practices for pgvector indexes")
# Returns: {success, answer, sources: [{title, uri}], search_queries, confidence}
```

### DocsManagerDelegate

Comprehensive documentation management - search, drift check, write, update.

```python
delegate = DocsManagerDelegate(working_dir=Path("."))

# Semantic search over docs
result = await delegate.execute(action="search", query="authentication")

# Check docs for drift
result = await delegate.execute(action="check", doc_path="docs/API.md")

# Write new markdown file
result = await delegate.execute(action="write", doc_path="docs/new.md", content="# Title")

# Update section in markdown file
result = await delegate.execute(action="update", doc_path="README.md", section="## Installation", content="New content")
```

### DbExplorerDelegate

Natural language database exploration using Gemini.

```python
delegate = DbExplorerDelegate()
result = await delegate.execute(prompt="What tables store user data?")
# Returns: {success, answer, operations: [...], operation_count: N}
```

### TestRunnerDelegate

Multi-framework test execution (pytest, flutter, jest).

```python
delegate = TestRunnerDelegate(working_dir=Path("."))
result = await delegate.execute(path="tests/", framework="pytest", args=["-v"])
# Returns: TestSuiteResult with passed, failed, skipped counts
```

### Context Chaining

Batches can reference outputs from previous batches for multi-step workflows:

```python
batch = TaskBatch(
    title="Analyze patterns",
    delegate=BatchDelegate.HESTER_AGENT,
    prompt="What patterns do you see?",
    context_from=["batch-1", "batch-2"],  # Pull from these batches
    context_bundle=".hester/contexts/api.md",  # Also include this bundle
    toolset="research",
    output_as_context=True,  # Pass output to next batch
)
```

**Context Flow:**
1. `context_bundle` loaded first (if specified)
2. `output_summary` from each `context_from` batch appended
3. Combined context passed to delegate
4. Delegate output stored in `output` and summarized to `output_summary`

### Tool Scoping

Tools are organized into categories with progressive access levels:

```python
# hester/daemon/tools/scoping.py

TOOL_SETS = {
    "observe": ["read_file", "search_files", "search_content", "list_directory", "change_directory"],
    "research": [*observe, "web_search", "db_*", "semantic_doc_search", "summarize", "get_context_bundle", ...],
    "develop": [*observe, "write_file", "edit_file", "bash"],
    "full": [*all tools except orchestration*],
}

FORBIDDEN_FOR_SUBAGENTS = {
    "create_task", "get_task", "update_task", "list_tasks",
    "add_batch", "add_context", "mark_task_ready", "delete_task",
}
```

**Enforcement:**
- Soft: Tools not in scope are simply unavailable
- Hard: Forbidden tools raise `ForbiddenToolError` (subagents only)

## Environment Variables

```bash
# Required
GOOGLE_API_KEY=xxx           # For Gemini API

# Optional
HESTER_PORT=9000             # Daemon port
HESTER_HOST=127.0.0.1        # Daemon host
HESTER_TASKS_DIR=.hester/tasks/  # Task storage
REDIS_URL=redis://localhost:6379
```

## Personality

Like Hester in the books:

- **Loyal but no BS** - Tells you what you need to hear, not what you want to hear
- **Not pushy** - Surfaces information, doesn't nag
- **Blunt with humor** - Direct communication, but not robotic

### Voice Examples

```
# Good: Blunt, slight humor
"Upload tests failing again. Third time this week. The 5MB boundary
is cursed--want me to dig into it?"

# Good: Direct, actionable
"PR #312 touches the auth module but no tests updated. Last three PRs
to this file introduced regressions."

# Good: Observational, not naggy
"Four people have asked about the scoring algorithm in Slack this month.
We might have a doc gap."

# Bad: Too warm/corporate
"Hey team! Just wanted to flag a small issue I noticed..."

# Bad: Too robotic
"ERROR: Test failure detected. Count: 3. Module: upload."
```

## Related Documentation

- `CLAUDE.md` - Lee editor documentation
- `docs/00-Hester-Initial.md` - Full specification
- `docs/02-Hester-Context-Bundles.md` - Context bundle design
- `docs/04-Hester-Subagents.md` - Subagent architecture spec
