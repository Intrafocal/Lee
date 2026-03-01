# Hester - The Internal Daemon

> Sybil's infrastructure, applied to the system domain. Watchful, practical, no BS.

## Overview

**Hester** is the AI daemon that accompanies the Lee editor. Named after Lee Scoresby's daemon in Philip Pullman's *His Dark Materials*--an arctic hare who speaks truth, watches what Lee can't see, and keeps him grounded.

Hester serves the Coefficiency team the way a daemon serves their human: always present, always watching, never customer-facing.

## Core Principle

**Hester is built to reuse Sybil/Coefficiency tech for internal use.**

```
┌─────────────────────────────────────────────────────────────────┐
│                     THE INNOVATION LOOP                          │
│                                                                  │
│    ┌──────────────┐                    ┌──────────────┐         │
│    │    SYBIL     │                    │    HESTER    │         │
│    │  User-facing │                    │   Internal   │         │
│    │  Chief of    │                    │   daemon     │         │
│    │  Staff       │                    │   for team   │         │
│    └──────┬───────┘                    └──────┬───────┘         │
│           │      ┌─────────────────┐          │                 │
│           └─────►│     SHARED      │◄─────────┘                 │
│                  │  INFRASTRUCTURE │                            │
│                  │  • Intelligence │                            │
│                  │  • GraphRAG     │                            │
│                  │  • ReAct Loop   │                            │
│                  │  • Validators   │                            │
│                  └─────────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

**Primary goal:** Solve real internal problems.
**Secondary goal:** Dogfood our own tech--learn how to use it better, make it more robust.

## Hard Boundaries

Hester will **never**:
- Touch production user data
- Make direct code changes (suggest only)
- Send external communications
- Modify production database
- Be exposed to customers

## Architecture

### Directory Structure

```
lee/hester/
├── cli.py                  # CLI entry point (hester command)
├── __init__.py
├── daemon/                 # FastAPI daemon service
│   ├── main.py             # HTTP server on port 9000
│   ├── agent.py            # ReAct loop agent
│   ├── session.py          # Redis session management
│   ├── settings.py         # Configuration
│   ├── models.py           # Pydantic models
│   ├── thinking_depth.py   # Response depth control
│   ├── tasks/              # Background task system
│   │   ├── planner.py      # Task planning
│   │   ├── store.py        # Task persistence
│   │   ├── executor.py     # Task execution
│   │   ├── models.py       # Task/Batch models with serialization
│   │   ├── claude_delegate.py      # Claude Code delegation
│   │   ├── hester_agent_delegate.py # Scoped codebase exploration
│   │   └── gemini_grounded_delegate.py # Web research with sources
│   └── tools/              # Available tools
│       ├── file_read.py    # File reading
│       ├── db_tools.py     # Database queries
│       ├── doc_tools.py    # Documentation tools
│       ├── web_search.py   # Web search
│       ├── devops_tools.py # Docker/service management
│       ├── summarize.py    # Text summarization
│       ├── ui_control.py   # Lee IDE + browser control
│       └── scoping.py      # Tool scoping for subagents
├── qa/                     # HesterQA - Scene testing
│   ├── agent.py            # QA orchestration
│   ├── driver.py           # Chrome DevTools driver
│   ├── browser.py          # Browser management
│   ├── mcp_client.py       # MCP connection
│   ├── personas.py         # Test personas
│   ├── evaluators.py       # Result evaluation
│   ├── models.py           # QA data models
│   ├── components.py       # UI component handlers
│   ├── logger.py           # Test logging
│   └── tui.py              # Interactive TUI
├── docs/                   # HesterDocs - Documentation
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

## The Four Capabilities

### Priority Order

1. **HesterQA** (Phase 1) - Scene testing - Highest impact
2. **HesterDocs** (Implemented) - Documentation sync
3. **HesterIdeas** (Phase 3) - Idea capture
4. **HesterBrief** (Phase 4) - Daily summaries

## CLI Reference

### Installation

```bash
pip install -e ./lee
```

### Global Commands

```bash
hester --version           # Show version
hester --help              # Show help
```

### QA Commands (HesterQA)

Scene testing via simulated conversation using Chrome DevTools MCP.

```bash
# Run a scene test
hester qa scene <scene_slug> [options]
  --persona, -p NAME       # Test persona (default: engaged_user)
  --verbose, -v            # Show detailed output
  --frame-url URL          # Frame URL (default: http://localhost:8889)
  --screenshot-dir PATH    # Save screenshots
  --no-save                # Don't save to database
  --headless               # Run Chrome headless
  --no-browser             # Assume Chrome already running
  --max-turns, -t N        # Max conversation turns
  --tui                    # Interactive TUI mode

# Examples
hester qa scene welcome --verbose
hester qa scene onboarding --persona vague_user --headless
hester qa scene genome_discovery --tui

# Start Chrome for testing
hester qa start-browser
hester qa start-browser --headless --port 9222

# List resources
hester qa list-scenes
hester qa list-personas
```

**Available Personas:**

| Persona | Behavior |
|---------|----------|
| `engaged_user` | Cooperative, detailed answers, follows prompts |
| `vague_user` | Short answers, non-committal, expects clarification |
| `contradictor` | Says conflicting things, tests consistency detection |
| `speed_runner` | Rushes through, tests graceful degradation |

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
hester agent code_explorer "Find all usages of EncryptionService"
hester agent web_researcher "Best practices for pgvector indexes"
hester agent docs_manager "How does authentication work?"
hester agent db_explorer "What vector columns exist in profiles?"
hester agent test_runner --path services/api/tests/
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
hester db describe profiles --schema auth

# List functions
hester db functions
hester db functions --filter match

# View RLS policies
hester db rls <table_name>

# View constraints
hester db constraints <table_name>

# Execute SELECT queries (read-only)
hester db query "SELECT * FROM profiles" --limit 10
hester db query "SELECT id, name FROM users" --json

# Count rows
hester db count <table_name>
hester db count users --where "active = true"

# Decrypt encrypted columns (local Supabase only)
# Automatically decrypts encrypted_* columns using the user's DEKs
hester db query "SELECT user_id, encrypted_observation FROM evidence_with_decay" \
    --decrypt --user-id "cd10e3eb-eaef-4351-b40d-7c687fff1b59"

# JSON output with decryption
hester db query "SELECT * FROM sybil_conversations" \
    --decrypt -u "UUID" --json
```

**Decryption Notes:**
- Only works with local Supabase (127.0.0.1, localhost, host.docker.internal)
- Requires `--user-id` to specify whose DEKs to use
- Tries all active DEKs for the user (different data types use different keys)
- Automatically renames `encrypted_*` columns to plain names in output
- Removes hash columns from output for cleaner display

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
  --file services/api/src/auth.py \
  --grep "jwt|token" \
  --db-schema profiles \
  --ttl 48

hester context show auth-system
hester context copy matching-algo
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

### Ask Commands

Ask questions using Gemini with web search.

```bash
# Ask Gemini (with Google Search grounding)
hester ask gemini "Current Bitcoin price"
hester ask gemini "Latest AI news" --verbose
hester ask gemini "Explain photosynthesis" --no-search
```

### Audio Commands

TTS generation, de-essing, and playback tools.

```bash
# Generate TTS audio with ElevenLabs
hester audio generate <text> <storage_path>
hester audio generate "Hello world" hester/hello.mp3
hester audio generate "Welcome to Sybil" welcome.mp3 --de-ess
hester audio generate "Test" test.mp3 --voice-id abc123 --json

# De-ess existing audio (reduce sibilance)
hester audio de-ess <source> <output_path>
hester audio de-ess welcome/intro.mp3 de-essed/intro.mp3
hester audio de-ess asset://audio/scenes/step1.mp3 processed.mp3 --strength heavy

# Play audio (requires sox)
hester audio play <source>
hester audio play hester/hello.mp3
hester audio play asset://audio/scenes/welcome/intro.mp3 --volume 0.5

# List audio files in storage
hester audio list
hester audio list --prefix hester/ --limit 10
```

**Source types supported:**
- Local file: `./audio.mp3` or `/path/to/file.mp3`
- Supabase storage path: `scene/stage/0.mp3`
- Full Supabase URL: `http://127.0.0.1:54321/storage/v1/object/public/audio-assets/...`
- Frame asset path: `asset://audio/scenes/welcome/intro.mp3`

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

## QA Testing Flow

HesterQA tests Sybil scenes by simulating user conversations:

```
1. THINK: Select persona based on what needs testing
2. ACT: Chrome DevTools drives conversation with Sybil
3. OBSERVE: Capture transcript, artifacts, timing, errors
4. REFLECT: Evaluate against success criteria
5. RESPOND: Log results, notify on failure
```

### Test Types

**Happy Path (engaged_user):**
- Completes flow successfully
- All expected artifacts generated
- Timing within bounds

**Adversarial:**
- `vague_user` - Minimal input, expects clarifying questions
- `contradictor` - Conflicting info, expects Sybil to notice
- `speed_runner` - Rushes through, tests graceful degradation

### CI/CD Integration

```bash
# Run in CI pipeline
hester qa scene welcome --headless --no-save
exit_code=$?

# Exit codes
# 0 = Test passed
# 1 = Test failed
# 130 = Interrupted (Ctrl+C)
```

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
result = await delegate.execute(prompt="What vector columns exist in profiles?")
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
# lee/hester/daemon/tools/scoping.py

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

- **Loyal but no BS** - Tells the team what they need to hear, not what they want to hear
- **Not pushy** - Surfaces information, doesn't nag
- **Blunt with humor** - Direct communication, but not robotic

### Voice Examples

```
# Good: Blunt, slight humor
"Upload tests failing again. Third time this week. The 5MB boundary
is cursed--want me to dig into it?"

# Good: Direct, actionable
"PR #312 touches graph/sybil but no tests updated. Last three PRs
to this file introduced regressions."

# Good: Observational, not naggy
"Four people have asked about Genome scoring in Slack this month.
We might have a doc gap."

# Bad: Too warm/corporate
"Hey team! Just wanted to flag a small issue I noticed..."

# Bad: Too robotic
"ERROR: Test failure detected. Count: 3. Module: upload."
```

## Related Documentation

- `lee/CLAUDE.md` - Lee editor documentation
- `lee/docs/00-Hester-Initial.md` - Full specification
- `lee/docs/02-Hester-Context-Bundles.md` - Context bundle design
- `lee/docs/04-Hester-Subagents.md` - Subagent architecture spec
- `docs/Hester.md` - Quick reference
