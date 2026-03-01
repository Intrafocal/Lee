# Hester Subagents Architecture

## Overview

Hester operates as an **orchestrator** that decomposes complex tasks into batches and delegates execution to specialized subagents. This inverts the traditional pattern where each agent defines its own workflow—instead, Hester plans the workflow and agents simply execute their scoped piece.

```
┌─────────────────────────────────────────────────────────────────┐
│                    HESTER (Orchestrator)                         │
│                                                                  │
│  • Understands user intent                                       │
│  • Gathers context (files, docs, web)                           │
│  • Decomposes into batches                                       │
│  • Assigns batches to appropriate delegates                      │
│  • Observes results, adjusts plan                                │
│  • Chains context between batches                                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ dispatches batches to
                              ▼
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ claude_code  │code_explorer │web_researcher│ test_runner  │ ...
│              │              │              │              │
│ Implement    │ Explore      │ Research     │ Validate     │
│ Edit code    │ Query code   │ Synthesize   │ Run tests    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

## Execution Contexts

### Three Modes

| Command | Mode | Can Orchestrate? | Can Spawn Subagents? |
|---------|------|------------------|---------------------|
| `hester chat` | Interactive TUI | Yes (tasks) | No |
| `hester daemon start` | HTTP server | Yes (full) | Yes |
| `hester agent` | Headless execution | No | No |

### Rules

1. **Only `hester daemon start` can spawn subagents** - prevents accidental recursion from interactive chat
2. **Subagents cannot spawn further subagents** - enforced via depth limit and tool restrictions
3. **Subagents cannot orchestrate** - no access to task creation or delegation tools

## Delegate Types

### Core Delegates (Priority 1) - All Implemented

#### `claude_code`
**Purpose**: Code implementation, editing, refactoring
**Implementation**: Claude Code Agent SDK
**Status**: ✅ Implemented

```python
batch = TaskBatch(
    title="Implement vector search",
    delegate=BatchDelegate.CLAUDE_CODE,
    prompt="Add pgvector search to the matching service...",
)
```

#### `code_explorer`
**Purpose**: Scoped codebase exploration and focused queries
**Implementation**: `hester agent code_explorer` CLI command
**Status**: ✅ Implemented

```bash
# CLI usage
hester agent code_explorer "Find all usages of EncryptionService"
hester agent code_explorer "What does this function do?" -t observe
hester agent code_explorer --context bundle.md "Explain this service"
```

```python
batch = TaskBatch(
    title="Research existing patterns",
    delegate=BatchDelegate.CODE_EXPLORER,
    prompt="How does authentication work in the API service?",
    toolset="observe",
)
```

#### `web_researcher`
**Purpose**: Web research with synthesis and citations
**Implementation**: Gemini with Google Search grounding
**Status**: ✅ Implemented

```bash
# CLI usage
hester agent web_researcher "Best practices for pgvector indexes"
```

```python
batch = TaskBatch(
    title="Research LangGraph streaming",
    delegate=BatchDelegate.WEB_RESEARCHER,
    prompt="How does LangGraph handle streaming in production?",
)
# Returns: Synthesized answer + sources list
```

#### `validator`
**Purpose**: Run linting, type checks, and basic tests
**Implementation**: Subprocess wrapper for ruff/pytest
**Status**: ✅ Implemented

```python
batch = TaskBatch(
    title="Validate implementation",
    delegate=BatchDelegate.VALIDATOR,
    action="validate",  # or "test"
)
```

#### `manual`
**Purpose**: Human must complete
**Implementation**: Log steps, mark complete when confirmed
**Status**: ✅ Implemented

```python
batch = TaskBatch(
    title="Deploy to production",
    delegate=BatchDelegate.MANUAL,
    steps=["Run deploy script", "Verify health checks", "Monitor logs"],
)
```

### Analysis Delegates (Priority 2) - All Implemented

#### `docs_manager`
**Purpose**: Comprehensive documentation management - search, drift check, write, update
**Implementation**: Wraps `HesterDocsAgent` and `DocEmbeddingService`
**Status**: ✅ Implemented

```bash
# CLI usage
hester agent docs_manager "How does authentication work?"
hester agent docs_manager --action check --doc-path docs/API.md
hester agent docs_manager --action write --doc-path docs/new.md --content "# Title"
```

```python
batch = TaskBatch(
    title="Find authentication docs",
    delegate=BatchDelegate.DOCS_MANAGER,
    prompt="JWT authentication and RLS policies",
    params={"action": "search", "limit": 5},
)
```

**Actions:**
- `search` - Semantic search over indexed docs
- `check` - Check docs for drift against code
- `claims` - Extract verifiable claims from a doc
- `index` - Index files for vector search
- `status` - Show index status
- `write` - Create new markdown file
- `update` - Update existing markdown file (full or section-based)

#### `db_explorer`
**Purpose**: Natural language database exploration and queries
**Implementation**: Gemini-planned database operations via db_tools
**Status**: ✅ Implemented

```bash
# CLI usage
hester agent db_explorer "What vector columns exist in profiles?"
hester agent db_explorer "Show me the schema for matching tables"
```

```python
batch = TaskBatch(
    title="Analyze profile schema",
    delegate=BatchDelegate.DB_EXPLORER,
    prompt="What columns in profiles table store vector embeddings?",
)
```

### Testing Delegates (Priority 2) - Implemented

#### `test_runner`
**Purpose**: Run test suites and report structured results
**Implementation**: Multi-framework test execution (pytest, flutter, jest)
**Status**: ✅ Implemented

```bash
# CLI usage
hester agent test_runner "Run tests" --test-path services/api/tests/
hester agent test_runner "Run tests" --test-path tests/ --framework pytest --test-args "-v"
```

```python
batch = TaskBatch(
    title="Run API tests",
    delegate=BatchDelegate.TEST_RUNNER,
    params={
        "path": "services/api/tests/",
        "framework": "pytest",
        "args": ["-v", "--tb=short"],
    },
)
```

**Frameworks:** Auto-detects from path, or specify explicitly:
- `pytest` - Python tests
- `flutter` - Flutter/Dart tests
- `jest` - JavaScript/TypeScript tests

### Synthesis Delegates (Priority 3)

#### `summarizer`
**Purpose**: Condense long outputs for context passing
**Implementation**: Local Gemma model
**Status**: 🔜 To implement

```python
batch = TaskBatch(
    title="Summarize research",
    delegate=BatchDelegate.SUMMARIZER,
    context_from=["batch-research-1", "batch-research-2"],
    params={"max_tokens": 500},
)
```

### External Delegates (Priority 3)

#### `github_ops`
**Purpose**: PR creation, issue management
**Implementation**: Wrap `gh` CLI
**Status**: 🔜 To implement

```python
batch = TaskBatch(
    title="Create PR",
    delegate=BatchDelegate.GITHUB_OPS,
    action="create_pr",
    params={
        "title": "Add vector search to matching",
        "body_from": "batch-summary",
        "branch": "feature/vector-search",
    },
)
```

#### `slack_notify`
**Purpose**: Send notifications
**Implementation**: Wrap existing HesterSlack
**Status**: 🔜 To implement

### Meta Delegates

#### `checkpoint`
**Purpose**: Human approval gates
**Implementation**: Pause execution, wait for confirmation
**Status**: 🔜 To implement

```python
batch = TaskBatch(
    title="Approve before PR",
    delegate=BatchDelegate.CHECKPOINT,
    prompt="Review the implementation and test results before creating PR",
    context_from=["batch-implement", "batch-test"],
)
```

## Tool Scoping

### Tool Categories

```python
class ToolCategory(str, Enum):
    OBSERVE = "observe"      # Read-only codebase access
    RESEARCH = "research"    # Observe + web/docs
    DEVELOP = "develop"      # Write files, run commands
    FULL = "full"            # All tools except orchestration
```

### Predefined Tool Sets

```python
TOOL_SETS = {
    "observe": [
        "read_file",
        "search_files",
        "search_content",
        "list_directory",
        "change_directory",
    ],

    "research": [
        # Observe +
        "web_search",
        "db_list_tables",
        "db_describe_table",
        "db_execute_select",
        "semantic_doc_search",
        "get_context_bundle",
        "summarize",
    ],

    "develop": [
        # Observe +
        "write_file",
        "edit_file",
        "bash",
    ],

    "full": [
        # All tools except orchestration
    ],
}
```

### Forbidden Tools for Subagents

```python
FORBIDDEN_FOR_SUBAGENTS = {
    "create_task",
    "get_task",
    "update_task",
    "list_tasks",
    "add_batch",
    "add_context",
    "mark_task_ready",
    "delete_task",
}
```

## Context Flow

### Between Batches

```python
class TaskBatch(BaseModel):
    # ... existing fields ...

    # Context input
    context_from: List[str] = []      # Batch IDs to pull context from
    context_bundle: Optional[str] = None  # Pre-built context file

    # Context output
    output_as_context: bool = True    # Pass output to subsequent batches
    output_summary: Optional[str] = None  # Summarized for next batch
```

### Automatic Context Chain

```
Batch 1 (research)     Batch 2 (implement)    Batch 3 (test)
     │                       │                      │
     │ output_summary ──────►│                      │
     │                       │ output ─────────────►│
     │                       │                      │
```

### Context Bundle Integration

```python
batch = TaskBatch(
    title="Implement with context",
    delegate=BatchDelegate.CLAUDE_CODE,
    context_bundle=".hester/contexts/matching-service.md",
    context_from=["batch-research"],
    prompt="Add vector search using the patterns from research...",
)
```

## CLI Reference

### Agent Command

```bash
# Run code_explorer agent
hester agent code_explorer "Find all usages of EncryptionService"
hester agent code_explorer "Check database schema" -t research
hester agent code_explorer --plan .hester/plans/research.md
hester agent code_explorer "Explain this" -c .hester/contexts/api.md

# Run web_researcher agent
hester agent web_researcher "Best practices for pgvector indexes"

# Options
-c, --context PATH    # Path to context bundle file
-p, --plan PATH       # Path to plan file (markdown prompt)
-t, --toolset SCOPE   # observe|research|develop|full (code_explorer only)
--tools LIST          # Comma-separated tool list
-o, --output FORMAT   # text|json|markdown
-m, --max-steps N     # Max ReAct iterations
-q, --quiet           # Suppress progress output
-d, --dir PATH        # Working directory
```

## Example Task Plan

```markdown
---
id: add-vector-search
status: ready
---

# Add Vector Search to Profile Matching

## Goal
Implement pgvector-based semantic search for matching profiles to opportunities.

## Batches

### Batch 1: Research codebase patterns [code_explorer]
**Toolset**: observe

> Find existing vector search patterns in the matching service.
> Look at embedding generation, pgvector usage, similarity queries.

### Batch 2: Research pgvector best practices [web_researcher]

> What are best practices for pgvector similarity search at scale?
> Indexing strategies, query optimization, dimension selection.

### Batch 3: Check existing schema [db_explorer]

> What vector columns exist in profiles and opportunities tables?
> What indexes are defined?

### Batch 4: Implement vector search [claude_code]
**Context from**: batch-1, batch-2, batch-3

> Add semantic matching using pgvector:
> - Generate embeddings for profile skills
> - Store in profiles.skills_embedding
> - Create similarity search function
> - Add index for performance

### Batch 5: Write tests [claude_code]
**Context from**: batch-4

> Write tests for the new vector search:
> - Unit tests for embedding generation
> - Integration tests for similarity queries
> - Edge cases (empty profiles, no matches)

### Batch 6: Run tests [test_runner]
**Params**: {"path": "services/matching/tests/test_vector_search.py", "framework": "pytest"}

### Batch 7: Validate [validator]
**Action**: validate

### Batch 8: Approval gate [checkpoint]
**Context from**: batch-4, batch-6, batch-7

> Review implementation and test results before creating PR.

### Batch 9: Create PR [github_ops]
**Context from**: batch-4, batch-7

> Create PR with implementation summary and test results.

## Success Criteria
- [ ] Vector search returns semantically similar profiles
- [ ] All tests pass
- [ ] No security issues identified
- [ ] PR created and ready for review
```

## Delegate Summary

| Delegate | Purpose | Status | Priority |
|----------|---------|--------|----------|
| `claude_code` | Code implementation | ✅ Implemented | P1 |
| `code_explorer` | Scoped codebase queries | ✅ Implemented | P1 |
| `web_researcher` | Web research synthesis | ✅ Implemented | P1 |
| `validator` | Linting and basic tests | ✅ Implemented | P1 |
| `manual` | Human completion | ✅ Implemented | P1 |
| `docs_manager` | Doc search, drift, write/update | ✅ Implemented | P2 |
| `db_explorer` | Natural language DB queries | ✅ Implemented | P2 |
| `test_runner` | Run test suites | ✅ Implemented | P2 |
| `summarizer` | Condense outputs | 🔜 To implement | P3 |
| `github_ops` | PR/issue management | 🔜 To implement | P3 |
| `slack_notify` | Notifications | 🔜 To implement | P3 |
| `checkpoint` | Human approval | 🔜 To implement | P3 |
