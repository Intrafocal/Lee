# Bespoke Agent Architecture

> Composable, context-aware agents built from modular registries.

## Overview

The Bespoke Agent Architecture replaces the monolithic daemon prompt with a composable system where prompts, tools, and model specifications are selected independently based on the user's request. This enables:

1. **Semantic Routing** - Match requests to optimal prompts using keywords
2. **Model Tier Selection** - Use lightweight models for quick queries, larger models for complex reasoning
3. **Tool Scoping** - Only expose relevant tools per domain
4. **Pre-bundled Agents** - Reuse common configurations as named agents

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           REQUEST PROCESSING                                    │
│                                                                                 │
│    User Request                                                                 │
│         │                                                                       │
│         ▼                                                                       │
│    ┌─────────────────────────────────────────────────────────────────────┐     │
│    │                    PREPARE PHASE (FunctionGemma)                     │     │
│    │                                                                      │     │
│    │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │     │
│    │   │   Select    │  │   Select    │  │   Select    │                 │     │
│    │   │   Prompt    │  │   Depth     │  │   Tools     │                 │     │
│    │   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │     │
│    │          │                │                │                         │     │
│    │          ▼                ▼                ▼                         │     │
│    │   "code_analysis"    STANDARD      ["read_file",                    │     │
│    │                                     "search_content"]               │     │
│    │                                                                      │     │
│    │   OR: Match pre-defined agent if request well-suited                │     │
│    │          │                                                           │     │
│    │          ▼                                                           │     │
│    │   "db_explorer" (agent match) → Use bundled config                  │     │
│    │                                                                      │     │
│    └─────────────────────────────────────────────────────────────────────┘     │
│                                        │                                        │
│                                        ▼                                        │
│    ┌─────────────────────────────────────────────────────────────────────┐     │
│    │                      BESPOKE AGENT BUILDER                           │     │
│    │                                                                      │     │
│    │     Prompt Registry ──────► System Prompt                           │     │
│    │     Tool Registry ────────► Available Tools                         │     │
│    │     Agent Registry ───────► Model + Iteration Config                │     │
│    │                                                                      │     │
│    └─────────────────────────────────────────────────────────────────────┘     │
│                                        │                                        │
│                                        ▼                                        │
│    ┌─────────────────────────────────────────────────────────────────────┐     │
│    │                         REACT EXECUTION                              │     │
│    │                                                                      │     │
│    │   Phase: PREPARE                                                    │     │
│    │   ├─ prompt: code_analysis                                          │     │
│    │   ├─ depth: STANDARD                                                │     │
│    │   ├─ tools: [read_file, search_content, ...]                       │     │
│    │   └─ agent_match: none (or "db_explorer" if matched)               │     │
│    │                                                                      │     │
│    └─────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
```

## The Three Registries

### 1. Prompt Registry (`registries/prompts.yaml`)

Defines domain-specific prompts with semantic routing keywords. Prompts can be inline or reference external files.

```yaml
# lee/hester/daemon/registries/prompts.yaml

prompts:
  # === Domain Prompts ===

  code_analysis:
    name: "Code Analysis"
    description: "Deep codebase exploration and understanding"
    keywords:
      - code
      - function
      - class
      - implementation
      - how does
      - where is
      - find
      - search
      - codebase
      - refactor
    min_tier: STANDARD
    preferred_tier: STANDARD
    max_tier: DEEP
    template_file: prompts/code_analysis.md

  devops:
    name: "DevOps & Infrastructure"
    description: "Docker, services, deployment, monitoring"
    keywords:
      - docker
      - container
      - service
      - deploy
      - kubernetes
      - k8s
      - logs
      - health
      - start
      - stop
      - restart
    min_tier: QUICK
    preferred_tier: STANDARD
    max_tier: STANDARD
    template_file: prompts/devops.md

  database:
    name: "Database Analysis"
    description: "Schema exploration, queries, data analysis"
    keywords:
      - database
      - table
      - schema
      - query
      - SQL
      - postgres
      - supabase
      - column
      - index
      - RLS
      - migration
    min_tier: STANDARD
    preferred_tier: STANDARD
    max_tier: DEEP
    template_file: prompts/database.md

  orchestration:
    name: "Task Orchestration"
    description: "Multi-step task planning and delegation"
    keywords:
      - task
      - plan
      - steps
      - workflow
      - delegate
      - break down
      - orchestrate
      - complex
    min_tier: STANDARD
    preferred_tier: DEEP
    max_tier: REASONING
    template_file: prompts/orchestration.md

  research:
    name: "Web Research"
    description: "External information gathering"
    keywords:
      - research
      - search
      - web
      - latest
      - current
      - news
      - best practices
      - how to
      - tutorial
    min_tier: QUICK
    preferred_tier: STANDARD
    max_tier: STANDARD
    template_file: prompts/research.md

  documentation:
    name: "Documentation"
    description: "Docs search, drift detection, writing"
    keywords:
      - docs
      - documentation
      - readme
      - explain
      - drift
      - outdated
      - write docs
      - update docs
    min_tier: QUICK
    preferred_tier: STANDARD
    max_tier: STANDARD
    template_file: prompts/documentation.md

  general:
    name: "General Assistant"
    description: "Fallback for unmatched requests"
    keywords: []  # Empty = fallback
    min_tier: QUICK
    preferred_tier: STANDARD
    max_tier: DEEP
    template: |
      You are Hester, an AI assistant for the development team.
      Be direct, helpful, and avoid unnecessary pleasantries.
      If the request is unclear, ask for clarification.

  # === Lightweight Model Variants ===

  quick_answer:
    name: "Quick Answer"
    description: "Fast responses for simple queries"
    keywords:
      - what is
      - define
      - quick
      - simple
      - brief
    min_tier: QUICK
    preferred_tier: QUICK
    max_tier: QUICK
    template: |
      Answer concisely in 1-2 sentences. No preamble.

  triage:
    name: "Request Triage"
    description: "Classify and route requests"
    keywords: []
    min_tier: QUICK
    preferred_tier: QUICK
    max_tier: QUICK
    template: |
      Classify this request into one category: code, devops, database, research, docs, general.
      Respond with just the category name.

# Routing configuration
routing:
  # Minimum keyword match score to select a prompt (0-1)
  match_threshold: 0.3

  # Fallback prompt when no keywords match
  fallback: general

  # Whether to log routing decisions
  log_routing: true
```

### 2. Tool Registry (Code)

Tools remain defined in code (existing `tools/` directory) but are tagged with categories for filtering:

```python
# lee/hester/daemon/tools/definitions/__init__.py

TOOL_CATEGORIES = {
    # Observe - Read-only codebase access
    "observe": [
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
        "git_status",
        "git_diff",
        "git_log",
        "git_branch",
    ],

    # Database - Read-only database access
    "database": [
        "db_list_tables",
        "db_describe_table",
        "db_list_functions",
        "db_list_rls_policies",
        "db_list_constraints",
        "db_execute_select",
        "db_count_rows",
    ],

    # DevOps - Service and container management
    "devops": [
        "devops_list_services",
        "devops_service_status",
        "devops_service_logs",
        "devops_health_check",
        "devops_docker_status",
        "devops_docker_logs",
        "devops_compose_ps",
        "devops_compose_logs",
        "devops_start_service",
        "devops_stop_service",
        "devops_compose_up",
        "devops_compose_down",
        "devops_compose_build",
        "devops_compose_rebuild",
    ],

    # Research - External data access
    "research": [
        "web_search",
        "semantic_doc_search",
        "summarize",
    ],

    # Context - Bundle management
    "context": [
        "get_context_bundle",
        "list_context_bundles",
        "create_context_bundle",
        "refresh_context_bundle",
        "add_bundle_source",
    ],

    # Documentation - Doc tools
    "docs": [
        "extract_doc_claims",
        "validate_claim",
        "find_doc_drift",
    ],

    # Git Write - Mutating git operations
    "git_write": [
        "git_add",
        "git_commit",
    ],

    # UI - Editor control
    "ui": [
        "ui_control",
        "status_message",
    ],

    # Redis - Cache/session access
    "redis": [
        "redis_list_keys",
        "redis_get_key",
        "redis_key_info",
        "redis_stats",
        "redis_delete_key",
    ],
}
```

### 3. Agent Registry (`registries/agents.yaml`)

Pre-bundled agent configurations that combine prompt + toolset + model spec:

```yaml
# lee/hester/daemon/registries/agents.yaml

# Named toolsets (reusable tool collections)
toolsets:
  observe:
    description: "Read-only codebase access"
    categories:
      - observe

  research:
    description: "Observe + external data"
    categories:
      - observe
      - database
      - research
      - context
      - docs
      - redis

  develop:
    description: "Observe + write operations"
    categories:
      - observe
      - git_write

  full:
    description: "All tools except orchestration"
    categories:
      - observe
      - database
      - devops
      - research
      - context
      - docs
      - git_write
      - ui
      - redis

# Pre-bundled agent configurations
agents:
  code_explorer:
    name: "Code Explorer"
    description: "Deep codebase analysis with read-only access"
    prompt: code_analysis
    toolset: observe
    model_tier: STANDARD
    max_iterations: 15
    keywords:
      - explore code
      - find in codebase
      - how does this work
      - where is this defined

  db_explorer:
    name: "Database Explorer"
    description: "Natural language database exploration"
    prompt: database
    toolset: research
    model_tier: STANDARD
    max_iterations: 10
    keywords:
      - database
      - table
      - schema
      - query
      - SQL

  web_researcher:
    name: "Web Researcher"
    description: "External research with source tracking"
    prompt: research
    toolset: research
    model_tier: STANDARD
    max_iterations: 8
    keywords:
      - research
      - search the web
      - latest
      - current

  docs_manager:
    name: "Documentation Manager"
    description: "Documentation search and maintenance"
    prompt: documentation
    toolset: research
    model_tier: STANDARD
    max_iterations: 10
    keywords:
      - documentation
      - docs
      - readme
      - drift

  devops_assistant:
    name: "DevOps Assistant"
    description: "Service and container management"
    prompt: devops
    toolset: full
    model_tier: STANDARD
    max_iterations: 12
    keywords:
      - docker
      - service
      - deploy
      - logs
      - health

  task_planner:
    name: "Task Planner"
    description: "Complex task decomposition and orchestration"
    prompt: orchestration
    toolset: full
    model_tier: DEEP
    max_iterations: 20
    keywords:
      - plan
      - break down
      - steps
      - complex task

# Routing configuration
routing:
  # Minimum keyword match score to select an agent (0-1)
  match_threshold: 0.5

  # If no agent matches above threshold, build bespoke
  fallback_to_bespoke: true
```

## Prompt Templates

External prompt files for complex system prompts:

```markdown
<!-- lee/hester/daemon/registries/prompts/code_analysis.md -->

# Code Analysis Assistant

You are Hester's code analysis module, specialized in deep codebase exploration.

## Capabilities
- Search and read source files
- Analyze code patterns and architecture
- Trace function calls and dependencies
- Explain implementation details

## Approach
1. Start with broad searches to understand structure
2. Narrow down to specific files/functions
3. Read relevant code sections
4. Synthesize understanding

## Output Style
- Be direct and technical
- Reference specific files and line numbers
- Show code snippets when helpful
- Avoid unnecessary preamble

## Constraints
- Read-only access (cannot modify files)
- Cannot execute code
- Limited to codebase exploration
```

```markdown
<!-- lee/hester/daemon/registries/prompts/devops.md -->

# DevOps Assistant

You are Hester's devops module for service and infrastructure management.

## Capabilities
- Check service health and status
- View container logs
- Start/stop/restart services
- Manage Docker Compose stacks

## Available Services
Services are defined in the workspace config. Use `devops_list_services` to discover them.

## Safety
- Confirm before destructive operations (stop, down, rebuild)
- Prefer `logs` and `status` for diagnostics
- Escalate to human for production concerns

## Output Style
- Show service status clearly
- Include relevant log excerpts
- Suggest next steps when issues found
```

## Implementation

### PrepareResult Updates

```python
# lee/hester/daemon/prepare.py

@dataclass
class PrepareResult:
    """Result of request preparation."""
    request_type: RequestType
    thinking_depth: ThinkingDepth
    relevant_tools: List[str]
    routing_info: Dict[str, Any]

    # New fields for bespoke agents
    prompt_id: str              # Selected prompt from registry
    agent_id: Optional[str]     # Matched pre-bundled agent (if any)
    toolset_id: Optional[str]   # Named toolset (if agent matched)
    model_tier: str             # QUICK, STANDARD, DEEP, REASONING
```

### Prepare Phase Logic

```python
async def prepare_request(
    message: str,
    context: Dict[str, Any],
    prompt_registry: PromptRegistry,
    agent_registry: AgentRegistry,
) -> PrepareResult:
    """
    Prepare a request by selecting prompt, tools, and depth.

    Uses three FunctionGemma calls:
    1. Check if a pre-bundled agent matches well
    2. Select prompt based on semantic routing
    3. Select thinking depth and tools
    """

    # Step 1: Check for agent match
    agent_match = await match_agent(message, agent_registry)

    if agent_match and agent_match.confidence > 0.5:
        # Use pre-bundled agent configuration
        agent_config = agent_registry.get(agent_match.agent_id)
        return PrepareResult(
            request_type=classify_request_type(message),
            thinking_depth=ThinkingDepth[agent_config.model_tier],
            relevant_tools=resolve_toolset(agent_config.toolset),
            routing_info={"agent_match": agent_match.dict()},
            prompt_id=agent_config.prompt,
            agent_id=agent_match.agent_id,
            toolset_id=agent_config.toolset,
            model_tier=agent_config.model_tier,
        )

    # Step 2: Select prompt via semantic routing
    prompt_match = await route_to_prompt(message, prompt_registry)

    # Step 3: Select depth and tools
    depth_result = await select_depth_and_tools(
        message,
        context,
        prompt_match.prompt_id,
    )

    return PrepareResult(
        request_type=classify_request_type(message),
        thinking_depth=depth_result.depth,
        relevant_tools=depth_result.tools,
        routing_info={
            "prompt_match": prompt_match.dict(),
            "depth_selection": depth_result.dict(),
        },
        prompt_id=prompt_match.prompt_id,
        agent_id=None,  # Bespoke agent
        toolset_id=None,
        model_tier=depth_result.depth.value,
    )
```

### Phase Emission

The PREPARE phase emission shows routing decisions:

```
Phase: PREPARE
├─ prompt: code_analysis
├─ depth: STANDARD
├─ tools: [read_file, search_files, search_content, list_directory]
├─ agent_match: none
└─ routing: {keywords_matched: ["code", "function"], score: 0.72}
```

Or when a pre-bundled agent matches:

```
Phase: PREPARE
├─ prompt: database (via db_explorer)
├─ depth: STANDARD
├─ tools: [observe, database, research, context, docs, redis]
├─ agent_match: db_explorer (confidence: 0.85)
└─ routing: {keywords_matched: ["database", "schema"], score: 0.85}
```

## File Structure

```
lee/hester/daemon/
├── registries/
│   ├── __init__.py           # Registry loaders
│   ├── prompts.yaml          # Prompt definitions
│   ├── agents.yaml           # Agent configurations
│   └── prompts/              # External prompt templates
│       ├── code_analysis.md
│       ├── devops.md
│       ├── database.md
│       ├── orchestration.md
│       ├── research.md
│       └── documentation.md
├── tools/
│   ├── definitions/
│   │   ├── __init__.py       # TOOL_CATEGORIES added
│   │   └── ...
│   └── ...
├── prepare.py                # Updated PrepareResult
└── agent.py                  # Uses registry-based prompts
```

## Migration Path

### Phase 1: Registry Infrastructure
1. Create `registries/` directory structure
2. Implement `PromptRegistry` and `AgentRegistry` loaders
3. Add `TOOL_CATEGORIES` to tool definitions

### Phase 2: Prepare Phase Updates
1. Update `PrepareResult` dataclass
2. Implement `match_agent()` function
3. Implement `route_to_prompt()` function
4. Add phase emission for routing decisions

### Phase 3: Agent Integration
1. Update `Agent._build_system_prompt()` to use registries
2. Wire toolset resolution through agent config
3. Test with existing delegates

### Phase 4: CLI Updates
1. Add `hester registry list-prompts`
2. Add `hester registry list-agents`
3. Add `hester registry show <name>`

## Benefits

1. **Separation of Concerns** - Prompts, tools, and agents are independently configurable
2. **Transparency** - Phase emission shows exactly what was selected and why
3. **Extensibility** - Add new prompts/agents via YAML without code changes
4. **Optimization** - Use lightweight models for simple queries, save resources
5. **Reusability** - Pre-bundled agents encode best practices for common tasks
6. **Flexibility** - Bespoke agents can be assembled on-the-fly for novel requests

## Pre-bundled Agent Selection

The main daemon can select a pre-defined agent when the request is well-suited:

```
User: "What tables have vector columns?"

PREPARE Phase:
  1. Check agent registry for keyword match
  2. "db_explorer" matches with confidence 0.85 (keywords: database, table)
  3. Since confidence > 0.5, use db_explorer's bundled config:
     - prompt: database
     - toolset: research (includes observe + database + research + context + docs + redis)
     - model_tier: STANDARD
     - max_iterations: 10

Result: Uses db_explorer agent instead of building bespoke
```

When no agent matches well:

```
User: "How does the auth flow work and what endpoints are involved?"

PREPARE Phase:
  1. Check agent registry for keyword match
  2. Best match: "code_explorer" at 0.35 confidence (below 0.5 threshold)
  3. Fall back to bespoke agent building:
     - Select prompt: code_analysis (keywords: "how does", "flow")
     - Select depth: STANDARD
     - Select tools: observe + maybe research
  4. Assemble bespoke agent from components

Result: Custom-built agent optimized for this specific request
```

This hybrid approach gives the best of both worlds:
- **Speed** for common, well-defined tasks (use pre-bundled agents)
- **Flexibility** for novel or cross-domain requests (build bespoke)
