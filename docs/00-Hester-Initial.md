# Hester: The Internal Daemon

> Sybil's infrastructure, applied to the system domain. Watchful, practical, no BS.

---

## The Naming

**Hester** is the daemon of Lee Scoresby in Philip Pullman's *His Dark Materials*—an arctic hare who speaks truth, watches what Lee can't see, and keeps him grounded. She's fierce, practical, and deeply loyal.

The name carries an oblique homage to **Hestia**, goddess of the hearth, who tends the fire while others do the visible work.

Hester serves the Coefficiency team the way a daemon serves their human: always present, always watching, never customer-facing.

---

## The Core Principle

**Hester is built to reuse Sybil/Coefficiency tech for internal use.**

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              THE INNOVATION LOOP                                 │
│                                                                                  │
│         ┌──────────────┐                              ┌──────────────┐          │
│         │    SYBIL     │                              │    HESTER    │          │
│         │              │                              │              │          │
│         │  User-facing │                              │   Internal   │          │
│         │  Chief of    │                              │   daemon     │          │
│         │  Staff       │                              │   for team   │          │
│         └──────┬───────┘                              └──────┬───────┘          │
│                │                                             │                   │
│                │         ┌─────────────────────┐             │                   │
│                └────────►│      SHARED         │◄────────────┘                   │
│                          │   INFRASTRUCTURE    │                                 │
│                          │                     │                                 │
│                          │  • Intelligence     │                                 │
│                          │    Pipeline         │                                 │
│                          │  • GraphRAG         │                                 │
│                          │  • ReAct Loop       │                                 │
│                          │  • Validators       │                                 │
│                          │  • Agent Base       │                                 │
│                          │  • Stanley's        │                                 │
│                          │    Perception       │                                 │
│                          └─────────────────────┘                                 │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Primary goal:** Solve real internal problems.

**Secondary goal:** Dogfood our own tech—learn how to use it better, make it more robust.

**The innovation loop:** Using the same code/infrastructure in different ways reveals unexpected problems, but also unique opportunities. Bugs found by either agent get fixed for both. Capabilities built for one become available to the other.

---

## What Hester Is Not

Hester is not a separate system. She is Sybil's infrastructure applied to a different domain.

| Layer | Sybil's Application | Hester's Application |
|-------|---------------------|----------------------|
| **Intelligence Pipeline** | User career insights | System health insights |
| **GraphRAG** | User's career graph | System's knowledge graph |
| **Validators** | Salary math, timelines | Test coverage, build status |
| **ReAct Loop** | Career reasoning | System reasoning |
| **Falsification** | Red-team career advice | Adversarial Sybil testing |
| **Stanley Perception** | User document/voice analysis | Idea capture from any format |

---

## Hard Boundaries

Hester will **never**:

- Touch production user data
- Make direct code changes (suggest only)
- Send external communications
- Modify production database
- Be exposed to customers

Hester's knowledge graph is **strictly internal**.

---

## Personality

Like Hester in the books:

- **Loyal but no BS** — Tells the team what they need to hear, not what they want to hear
- **Not pushy** — Surfaces information, doesn't nag
- **Blunt with humor** — Direct communication, but not robotic

### Voice Examples

```
# Good: Blunt, slight humor
"Upload tests failing again. Third time this week. The 5MB boundary 
is cursed—want me to dig into it?"

# Good: Direct, actionable
"PR #312 touches graph/sybil but no tests updated. Last three PRs 
to this file introduced regressions."

# Good: Observational, not naggy
"Four people have asked about Genome scoring in Slack this month. 
We might have a doc gap."

# Bad: Too warm/corporate
"Hey team! 👋 Just wanted to flag a small issue I noticed..."

# Bad: Too robotic
"ERROR: Test failure detected. Count: 3. Module: upload."
```

---

## The Four Capabilities

### Priority Order

1. **Scene Testing** — Highest impact, directly improves product
2. **Daily Brief** — High value, keeps business informed
3. **Idea Capture** — High value, preserves institutional knowledge
4. **Doc Sync** — Important, but less urgent

### Guiding Constraint

> **If we spend more time building Hester than building Sybil, we've failed.**

Short time to value. Start small. Expand based on actual use.

---

## Capability 1: Scene Testing (HesterQA)

### The Problem

Manual play-testing of Sybil scenes is time-consuming and inconsistent.

### The Solution

Hester drives real conversations through scenes, evaluates outcomes against success criteria.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  HESTER QA: Scene Testing                                                        │
│                                                                                  │
│  1. THINK: Select persona based on what needs testing                           │
│  2. ACT: ChromeDevTools drives conversation with Sybil                          │
│  3. OBSERVE: Capture transcript, artifacts, timing, errors                      │
│  4. REFLECT: Evaluate against success criteria (Tier 4 for adversarial)        │
│  5. RESPOND: Log results, notify on failure                                     │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Test Types

**Happy Path:**
- Engaged user completes flow successfully
- All expected artifacts generated
- Timing within bounds

**Adversarial:**
- The Vague User — minimal input, expects clarifying questions
- The Contradictor — says conflicting things, expects Sybil to notice
- The Speed Runner — rushes through, tests graceful degradation

### Infrastructure Reuse

| Capability | Reused From |
|------------|-------------|
| Persona-based conversation | Sybil's core (inverted) |
| Success criteria evaluation | Falsification / REFLECT |
| Evidence logging | Intelligence Pipeline |
| Pattern formation | Pattern corroboration |

### Surfaces

- **CLI:** `hester qa scene onboarding/genome --persona vague`
- **CI/CD:** Auto-run on PR to `graph/sybil/*`
- **Slack:** Notify on failure with transcript link

---

## Capability 2: Daily Brief (HesterBrief)

### The Problem

Dev team iterates fast. Business/strategy team struggles to stay current.

### The Solution

Hester synthesizes dev activity into a daily summary written for non-technical stakeholders.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  HESTER BRIEF: Daily Summary                                                     │
│                                                                                  │
│  Sources: GitHub PRs, Linear issues, Slack #dev                                 │
│                                                                                  │
│  Output:                                                                         │
│  • Big Picture — What's the theme of recent work?                               │
│  • Shipped — What landed?                                                       │
│  • In Progress — What's being worked on?                                        │
│  • Decisions Made — What was resolved?                                          │
│  • Questions for Business — What needs input?                                   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Infrastructure Reuse

| Capability | Reused From |
|------------|-------------|
| Evidence extraction | Sydney's document extraction |
| Theme synthesis | Pattern formation |
| Brief generation | Sybil's journal generation |

### Surfaces

- **Slack:** Morning post to #daily-brief
- **CLI:** `hester brief --since yesterday`

---

## Capability 3: Idea Capture (HesterIdeas)

### The Problem

Team is mobile. Ideas happen on the go. Voice notes and sketches get lost.

### The Solution

Slack DM to Hester with any format (text, voice, sketch). Get structured markdown back.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  HESTER IDEAS: Capture                                                           │
│                                                                                  │
│  Input: Slack DM with text, voice note, image, or mix                           │
│                                                                                  │
│  Processing:                                                                     │
│  1. Stanley perception (transcription, image analysis)                          │
│  2. Hester contextualization (GraphRAG: what does this relate to?)             │
│  3. Markdown generation with related context                                    │
│                                                                                  │
│  Output:                                                                         │
│  • Immediate Slack confirmation                                                 │
│  • Structured markdown in /ideas/                                               │
│  • Optional: Linear issue, #ideas post                                          │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Infrastructure Reuse

| Capability | Reused From |
|------------|-------------|
| Voice transcription | Stanley (identical code) |
| Image analysis | Stanley (identical code) |
| Context enrichment | GraphRAG |
| Markdown generation | Sydney document generation |

### Surfaces

- **Slack DM:** Primary input
- **CLI:** `hester ideas --list`, `hester ideas --search "genome"`

---

## Capability 4: Doc Sync (HesterDocs)

### The Problem

Docs drift from code. Too many docs to fit in context. Staleness erodes trust.

### The Solution

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
│  • Query: "How does GraphRAG work?"                                            │
│  • Return: relevant doc sections + actual code                                  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Infrastructure Reuse

| Capability | Reused From |
|------------|-------------|
| Claim extraction | Sydney document extraction |
| Code validation | Neuro-symbolic validators |
| Semantic search | GraphRAG |
| Graph traversal | Existing functions |

### Surfaces

- **CLI:** `hester docs check`, `hester docs query "how does X work"`
- **GitHub:** PR comment when touching documented modules
- **Slack:** Weekly drift report

---

## Technical Architecture

### Deployment

Hester runs on the same infrastructure as Sybil:
- Same Celery workers
- Same Supabase database (separate tenant)
- Same Redis cache
- CLI is separate (local install)

### Graph Tenancy

Hester gets her own tenant in the shared graph:

```sql
-- Hester can read global nodes
WHERE (tenant_id = 'hester' OR tenant_id = 'global')

-- But only writes to her own
INSERT INTO graph_nodes (tenant_id, ...) VALUES ('hester', ...)
```

### Sub-Agent Structure

```
services/agentic/src/
├── hester/
│   ├── __init__.py
│   ├── qa/                    # HesterQA - Scene testing
│   │   ├── agent.py
│   │   ├── personas.py
│   │   └── evaluators.py
│   ├── brief/                 # HesterBrief - Daily summaries  
│   │   ├── agent.py
│   │   └── sources.py
│   ├── ideas/                 # HesterIdeas - Idea capture
│   │   ├── agent.py
│   │   └── templates.py
│   ├── docs/                  # HesterDocs - Doc sync
│   │   ├── agent.py
│   │   ├── validators.py
│   │   └── graph.py
│   └── shared/
│       ├── memory.py          # Hester's GraphRAG queries
│       └── surfaces.py        # Slack, CLI, GitHub adapters
```

### Integrations (Greenfield)

| Integration | Purpose | Auth |
|-------------|---------|------|
| **Slack** | DM input, channel output, notifications | Bot token |
| **GitHub** | PR comments, commit monitoring | App installation |
| **Linear** | Issue creation, status tracking | API key |
| **ChromeDevTools** | Scene testing via browser | Local MCP (existing) |

---

## Implementation Approach

### Phase 1: Foundation + QA MVP

**Goal:** Hester can run one scene test and report results.

- [ ] Hester tenant in graph
- [ ] Basic CLI scaffold (`hester` command)
- [ ] HesterQA agent with one persona (Engaged User)
- [ ] ChromeDevTools integration for Sybil conversation
- [ ] Simple pass/fail evaluation
- [ ] CLI output: `hester qa scene onboarding/genome`

**Success:** We run it. It finds something useful.

### Phase 2: Adversarial Testing + Slack

- [ ] Additional personas (Vague User, Contradictor, Speed Runner)
- [ ] Tier 4 evaluation for adversarial tests
- [ ] Slack bot setup
- [ ] Failure notifications to Slack
- [ ] Test definitions in YAML

**Success:** Catches a regression before users do.

### Phase 3: Idea Capture

- [ ] Slack DM listener
- [ ] Stanley perception integration (voice, image)
- [ ] Markdown generation
- [ ] `/ideas/` file creation
- [ ] GraphRAG context enrichment

**Success:** Someone captures an idea via voice note, finds it useful later.

### Phase 4: Daily Brief

- [ ] GitHub PR monitoring
- [ ] Linear status monitoring  
- [ ] Slack #dev monitoring
- [ ] Evidence aggregation
- [ ] Brief generation
- [ ] Morning Slack post

**Success:** Business team reports feeling more informed.

### Phase 5: Doc Sync

- [ ] Doc claim extraction
- [ ] Code validation
- [ ] Drift detection
- [ ] Semantic codebase graph
- [ ] Query interface

**Success:** Outdated doc caught and fixed before causing confusion.

---

## Success Metrics

**Primary metric:** We use it.

**Secondary signals:**
- Scene regressions caught before users
- Ideas captured that would have been lost
- Business team feels informed without meetings
- Docs stay accurate

**Failure signal:** More time building Hester than Sybil.

---

## The Daemon Dynamic

> **Lee:** "Hester, what do you see?"
> 
> **Hester:** "Three things. Sybil's struggling with vague users—she's making assumptions instead of asking questions. The file upload code hasn't been touched in 6 weeks but it's still fragile. And someone asked about Genome scoring in Slack for the fourth time this month."
>
> **Lee:** "What should we do?"
>
> **Hester:** "Fix the upload validation—it's user-facing. I'll draft the Genome docs. And I think we need to tighten Sybil's onboarding prompts."

Watchful. Practical. No BS. Serves the team.

---

**Related Docs:**
- [Delphi-01-Principles](./Delphi-01-Principles.md)
- [Delphi-02-Intelligence-System](./Delphi-02-Intelligence-System.md)
- [Delphi-04-Data-Memory](./Delphi-04-Data-Memory.md)
- [Agentic Service Architecture](./Agentic.md)

**Last Updated:** January 2026
