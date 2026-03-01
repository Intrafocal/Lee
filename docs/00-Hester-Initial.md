# Hester: The AI Daemon

> Watchful, practical, no BS.

---

## The Naming

**Hester** is the daemon of Lee Scoresby in Philip Pullman's *His Dark Materials*--an arctic hare who speaks truth, watches what Lee can't see, and keeps him grounded. She's fierce, practical, and deeply loyal.

The name carries an oblique homage to **Hestia**, goddess of the hearth, who tends the fire while others do the visible work.

Hester serves the developer the way a daemon serves their human: always present, always watching, never in the way.

---

## The Core Principle

**Hester is built to give developers deep, contextual AI assistance while they work.**

She sits alongside the Lee editor, maintaining awareness of what you're working on, what tools you have open, and what your codebase looks like. When you ask a question, she already has context. When something breaks, she's already watching.

**Primary goal:** Solve real problems in the development workflow.

**Secondary goal:** Stay out of the way until needed.

---

## What Hester Does

| Capability | Description |
|------------|-------------|
| **Code Exploration** | ReAct-loop agents that search, read, and reason about codebases |
| **Documentation** | Detect drift between docs and code, semantic search across docs |
| **Context Management** | Reusable context bundles that aggregate code, schemas, and docs |
| **DevOps** | Service management, Docker Compose, health checks |
| **Web Research** | Gemini-powered search with source attribution |
| **Plugin Extensions** | Project-specific tools, commands, and agents via plugin system |

---

## Hard Boundaries

Hester will **never**:

- Touch production user data
- Make direct code changes (suggest only)
- Send external communications
- Modify production database
- Be exposed to end users

Hester's knowledge graph is **strictly internal**.

---

## Personality

Like Hester in the books:

- **Loyal but no BS** -- Tells you what you need to hear, not what you want to hear
- **Not pushy** -- Surfaces information, doesn't nag
- **Blunt with humor** -- Direct communication, but not robotic

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

---

## Core Capabilities

### 1. Documentation Validation (HesterDocs)

#### The Problem

Docs drift from code. Too many docs to fit in context. Staleness erodes trust.

#### The Solution

Hester detects drift between docs and code, builds semantic knowledge graph for queries.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  HESTER DOCS: Sync & Search                                                      │
│                                                                                  │
│  Doc Sync:                                                                       │
│  • Extract "claims" from docs (function names, flows, configs)                  │
│  • Validate against actual code (neuro-symbolic)                                │
│  • Surface drift by severity                                                    │
│                                                                                  │
│  Semantic Search:                                                               │
│  • Build graph: Concept → Module → Function → Doc                              │
│  • Query: "How does authentication work?"                                      │
│  • Return: relevant doc sections + actual code                                  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### Surfaces

- **CLI:** `hester docs check`, `hester docs query "how does X work"`
- **GitHub:** PR comment when touching documented modules
- **CI/CD:** Drift report on merge

### 2. Code Exploration (Agents)

Scoped agents with tool restrictions for safe codebase exploration:

- **code_explorer** -- Search and analyze codebase files
- **web_researcher** -- Research topics using Google Search grounding
- **docs_manager** -- Documentation search, drift check, write/update
- **db_explorer** -- Natural language database exploration
- **test_runner** -- Multi-framework test execution (pytest, flutter, jest)

### 3. Context Bundles

Reusable knowledge packages that aggregate code, docs, schemas, and search results into portable markdown documents. Bundles have TTL-based staleness and can be refreshed manually or automatically.

### 4. DevOps Management

Service orchestration for local development: Docker Compose management, service health checks, log tailing, and a TUI dashboard.

### 5. Plugin System

Project-specific extensions via `.hester/plugins/`. Plugins can add:
- **Tools** -- MCP-style tool modules with `TOOLS` and `HANDLERS` exports
- **Commands** -- Click CLI command groups
- **Modules** -- Full Python packages injected into `sys.path`
- **Prompts** -- Markdown templates and YAML configurations
- **Agents** -- Custom agent configurations and toolsets

---

## Technical Architecture

### Deployment

Hester runs locally alongside the Lee editor:
- FastAPI daemon on port 9000
- Redis for session persistence
- Supabase for database exploration
- CLI for direct interaction

### Sub-Agent Structure

```
hester/
├── daemon/                 # FastAPI daemon service
│   ├── agent.py            # ReAct loop agent
│   ├── session.py          # Redis session management
│   ├── plugins/            # Plugin loader
│   ├── tasks/              # Background task system
│   ├── tools/              # Core tools
│   └── registries/         # Prompt and agent registries
├── docs/                   # Documentation validation
├── devops/                 # Service management
└── shared/                 # Utilities
```

### Integrations

| Integration | Purpose | Auth |
|-------------|---------|------|
| **Lee IDE** | Live context via WebSocket | Local |
| **GitHub** | PR comments, commit monitoring | App installation |
| **ChromeDevTools** | Browser automation | Local MCP |
| **Supabase** | Database exploration | Local/cloud |

---

## Implementation Approach

### Phase 1: Foundation + Docs MVP

**Goal:** Hester can validate documentation and answer questions about the codebase.

- [ ] CLI scaffold (`hester` command)
- [ ] Daemon with ReAct loop agent
- [ ] Doc claim extraction and validation
- [ ] Semantic search over docs
- [ ] Context bundle system

**Success:** We use it daily for codebase questions.

### Phase 2: Code Exploration + Context

- [ ] Scoped agent types (code_explorer, web_researcher, db_explorer)
- [ ] Tool scoping with progressive access levels
- [ ] Context chaining between agent batches
- [ ] Lee IDE integration (live context)

**Success:** Faster onboarding for new team members.

### Phase 3: DevOps + Plugins

- [ ] DevOps TUI dashboard
- [ ] Docker Compose integration
- [ ] Plugin system for project-specific extensions
- [ ] Plugin loader with manifests

**Success:** Team builds project-specific plugins without modifying core.

---

## Success Metrics

**Primary metric:** We use it.

**Secondary signals:**
- Docs stay accurate
- Codebase questions answered without context switching
- New team members productive faster
- Project-specific tools built as plugins

**Failure signal:** More time configuring Hester than using her.

---

## The Daemon Dynamic

> **Lee:** "Hester, what do you see?"
>
> **Hester:** "Three things. The auth module has two tests failing -- looks like the token expiry change broke them. The API docs haven't been updated since the endpoint refactor last week. And someone pushed a migration without updating the schema docs."
>
> **Lee:** "What should we do?"
>
> **Hester:** "Fix the auth tests -- they're blocking CI. I'll draft the API doc update. And flag the migration PR for a docs review."

Watchful. Practical. No BS.

---

**Last Updated:** March 2026
