# Hester ReAct Triage Architecture

## Overview

Hester uses a two-node triage system to decide **what** to do and **how** to do it. This separates orchestration decisions (Plan Node) from execution preparation (Prepare Node), enabling efficient routing at depth 0 while allowing subagents and task batches to reuse the preparation logic.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User Query                                                              │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  PLAN NODE (depth 0 only)                                           ││
│  │                                                                      ││
│  │  Decides WHAT to do:                                                ││
│  │  • DIRECT - Handle with ReAct loop                                  ││
│  │  • DELEGATE - Spawn specialized subagent                            ││
│  │  • TASK - Create multi-batch task                                   ││
│  │                                                                      ││
│  │  Uses: AgentRegistry → SemanticRouter → FunctionGemma               ││
│  │  Runs: hester chat, hester daemon (never in subagents)              ││
│  └─────────────────────────────────────────────────────────────────────┘│
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  PREPARE NODE (all execution contexts)                              ││
│  │                                                                      ││
│  │  Decides HOW to execute:                                            ││
│  │  • Thinking depth (Quick/Standard/Deep/Reasoning)                   ││
│  │  • Inference mode (Local/Cloud)                                     ││
│  │  • Tool selection (filtered from ToolRegistry)                      ││
│  │  • Model selection (which Gemma, which Gemini)                      ││
│  │                                                                      ││
│  │  Uses: ToolRegistry → SemanticRouter → FunctionGemma                ││
│  │  Runs: direct execution, subagents, AND task batches                ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Terminology

| Term | Meaning |
|------|---------|
| **Direct** | Hester handles the query herself (no subagent) |
| **Delegate** | Spawn a specialized subagent to handle the query |
| **Task** | Create a multi-batch task for complex work |
| **Local** | Use Ollama/Gemma models (fast, cheap, on-device) |
| **Cloud** | Use Gemini API (powerful, costs tokens) |

## Plan Node

The Plan Node runs **only at depth 0** (orchestrator level). Subagents never execute the Plan Node—they just execute what they're told.

### Flow

```
Query ──► Semantic Router ──► best_agent, confidence
               │
               ▼
          FunctionGemma #1: Strategy
          "DIRECT | DELEGATE | TASK"
               │
               ▼
          PlanResult { strategy, delegate_to }
```

### FunctionGemma Prompt: Strategy

Optimized for 270M model - terse, rigid structure, minimal tokens:

```
Role: Triage
Query: {query}
Agent: {agent_name} ({confidence:.0%})

Classify:
1. DIRECT (simple, 1-2 steps)
2. DELEGATE (deep search, needs {agent_name})
3. TASK (multi-step, implementation)

Output: [DIRECT|DELEGATE|TASK]
```

### Decision Guidelines

| Query Pattern | Strategy | Reason |
|---------------|----------|--------|
| "what is X" | DIRECT | Simple lookup |
| "read file.py" | DIRECT | Single tool call |
| "show me the schema" | DIRECT | Quick answer |
| "find all usages of X" | DELEGATE | Deep exploration |
| "how does auth work" | DELEGATE | Multi-file analysis |
| "research best practices" | DELEGATE | Specialized research |
| "implement feature X" | TASK | Multi-step work |
| "refactor the module" | TASK | Coordinated changes |
| "add tests and update docs" | TASK | Multiple batches |

### TASK Strategy: LLM-Based Planning

When FunctionGemma chooses TASK, the actual task planning is done by a more capable model (Gemini or cloud Gemma), not FunctionGemma itself. FunctionGemma only decides "this needs a task"—it doesn't plan the batches.

```
FunctionGemma: "TASK"
       │
       ▼
Gemini/Gemma Task Planner
       │
       ├─► Analyze the goal
       ├─► Identify required batches
       ├─► Assign delegates (code_explorer, claude_code, validator, etc.)
       └─► Structure context flow between batches
       │
       ▼
Task { batches: [...] }
```

**Task Planning Prompt (Gemini):**

```
Plan a task to accomplish this goal:

GOAL: {query}

AVAILABLE DELEGATES:
- code_explorer: Research codebase patterns
- web_researcher: Research external best practices
- claude_code: Implement code changes
- validator: Run tests and linting
- test_runner: Execute test suites
- docs_manager: Update documentation

Create a structured task with batches. Each batch should have:
- title: Short description
- delegate: Which delegate handles it
- prompt: What to do
- context_from: Which previous batches to pull context from (optional)

Respond in JSON:
{
  "title": "Task title",
  "batches": [
    {"title": "...", "delegate": "...", "prompt": "...", "context_from": []},
    ...
  ]
}
```

This separation ensures:
- **FunctionGemma**: Fast, focused decision (~100ms) - "Is this a task?"
- **Gemini**: Rich planning capability (~500ms) - "How should the task be structured?"

### PlanResult

```python
@dataclass
class PlanResult:
    strategy: ExecutionStrategy  # DIRECT, DELEGATE, TASK
    delegate_to: Optional[str] = None  # Agent name if DELEGATE
    delegate_confidence: float = 0.0
    plan_time_ms: float = 0.0
    reason: str = ""
```

### User Overrides

| Command | Effect |
|---------|--------|
| `/quick` | Forces DIRECT strategy |
| `/delegate` | Forces DELEGATE (uses best agent match) |
| `/task` | Forces TASK creation |

## Prepare Node

The Prepare Node runs in **all execution contexts**: direct execution, subagent execution, and task batch execution.

### Flow

```
Query ──► FunctionGemma #2: Depth
          "QUICK | STANDARD | DEEP | REASONING"
               │
               ▼
          Depth determines tool budget:
          QUICK=5, STANDARD=10, DEEP=15, REASONING=20
               │
               ▼
          Semantic Router ──► top N tools by score
               │
               ├─► N ≤ 1? ──► Use as-is (skip filter)
               │
               └─► N > 1? ──► FunctionGemma #3: Filter tools
                             "Which of these are relevant?"
                                   │
                                   ▼
          PrepareResult { depth, inference_mode, tools }
```

### FunctionGemma Prompt: Depth

Optimized for 270M model:

```
Role: Complexity
Query: {query}

Classify:
1. QUICK (trivial, single fact)
2. STANDARD (moderate, few steps)
3. DEEP (analysis, synthesis)
4. REASONING (architecture, trade-offs)

Output: [QUICK|STANDARD|DEEP|REASONING]
```

### FunctionGemma Prompt: Tool Filter

Optimized for 270M model:

```
Role: ToolFilter
Query: {query}

Tools:
- read_file
- search_content
- search_files
- web_search
- db_execute_select

Select relevant tools.
Output: [tool1,tool2,...]
```

### Tool Budget by Depth

| Depth | Tool Budget | Inference Mode |
|-------|-------------|----------------|
| QUICK | 5 | LOCAL |
| STANDARD | 10 | CLOUD |
| DEEP | 15 | CLOUD |
| REASONING | 20 | CLOUD |

### Model Selection by Depth

| Depth | Local Model | Cloud Model |
|-------|-------------|-------------|
| QUICK | gemma3n-e2b | gemini-2.0-flash-lite |
| STANDARD | gemma3n-e4b | gemini-2.5-flash |
| DEEP | gemma3n-e4b | gemini-2.5-pro |
| REASONING | gemma3n-e4b | gemini-2.5-pro |

### PrepareResult

```python
@dataclass
class PrepareResult:
    thinking_depth: ThinkingDepth
    inference_mode: InferenceMode  # LOCAL or CLOUD
    relevant_tools: List[str]
    local_model: Optional[str] = None
    cloud_model: Optional[str] = None
    prepare_time_ms: float = 0.0
    reason: str = ""
```

## Unified Registry

Both nodes use a unified registry that holds agents and tools. The semantic router operates on this registry.

### Registry Structure

```python
class HesterRegistry:
    _agents: Dict[str, AgentRegistration]
    _tools: Dict[str, ToolRegistration]

    @classmethod
    def get_router(cls) -> SemanticRouter:
        """Get router for semantic matching."""

    @classmethod
    def list_routable_agents(cls) -> List[AgentRegistration]:
        """Agents that can be spawned via delegation."""

    @classmethod
    def list_tools(cls, category: str = None) -> List[ToolRegistration]:
        """Tools available for execution."""
```

### Agent Registration

```python
@register_agent(
    name="code_explorer",
    description="Search and analyze source code files. Find patterns, usages, definitions, and implementations.",
    keywords=["code", "file", "function", "class", "usage", "definition"],
    category="core",
    default_toolset="research",
)
class CodeExplorerDelegate(BaseDelegate):
    ...
```

### Tool Registration

```python
@register_tool(
    name="read_file",
    description="Read the contents of a file from the filesystem.",
    keywords=["read", "file", "content", "cat"],
    category="observe",
)
async def read_file(path: str, ...) -> Dict[str, Any]:
    ...
```

## Semantic Router

The router uses embeddings to match queries to agents and tools.

### Agent Routing

```python
async def route_to_best_agent(
    self,
    query: str,
) -> Tuple[AgentRegistration, float]:
    """Find the best matching agent for a query."""

    # Compute query embedding
    query_embedding = await generate_embedding(query)

    # Compare to agent description embeddings
    similarities = np.dot(agent_embeddings, query_embedding)
    best_idx = np.argmax(similarities)

    return self.agents[best_idx], float(similarities[best_idx])
```

### Tool Routing

```python
async def route_to_tools(
    self,
    query: str,
    top_k: int = 10,
    min_score: float = 0.2,
) -> List[RouteCandidate]:
    """Find relevant tools for a query."""

    # Compute similarities
    query_embedding = await generate_embedding(query)
    similarities = np.dot(tool_embeddings, query_embedding)

    # Return top K above threshold
    top_indices = np.argsort(similarities)[::-1][:top_k]
    return [
        RouteCandidate(item=self.tools[i], score=similarities[i])
        for i in top_indices
        if similarities[i] >= min_score
    ]
```

### Fallback: Keyword Matching

If embeddings fail, fall back to keyword matching:

```python
def _keyword_route(self, query: str) -> Tuple[AgentRegistration, float]:
    query_lower = query.lower()

    for agent in self.agents:
        score = sum(1 for kw in agent.keywords if kw in query_lower)
        if score > best_score:
            best_agent, best_score = agent, score

    return best_agent, 0.3 + (best_score * 0.1)
```

## FunctionGemma Design Principles

Each FunctionGemma call is designed to be:

1. **Focused** - One question, one answer
2. **Fast** - ~100-200ms timeout
3. **Simple output** - Single enum value or comma-separated list
4. **Fallback-safe** - Heuristics if the call fails
5. **Skippable** - Some calls skipped when unnecessary

### Prompt Optimization for 270M Models

FunctionGemma (270M parameters) works best with **terse, rigid prompts**:

| Principle | Bad | Good |
|-----------|-----|------|
| **Minimal prose** | "Choose how to handle this query based on..." | "Role: Triage" |
| **Numbered options** | "DIRECT means simple lookup..." | "1. DIRECT (simple, 1-2 steps)" |
| **Explicit output format** | "Respond with only:" | "Output: [A\|B\|C]" |
| **No reasoning explanations** | "Use DEEP when you need detailed analysis because..." | "3. DEEP (analysis, synthesis)" |
| **Role prefix** | (none) | "Role: Complexity" |

**Why this matters:**
- Reduces input tokens → faster pre-fill
- Rigid structure → more reliable parsing
- No explanatory text → model doesn't waste capacity "understanding"
- Numbered lists → clearer classification boundaries

### Call Summary

| Call | Input | Output | When Skipped |
|------|-------|--------|--------------|
| #1 Strategy | query, best_agent | DIRECT/DELEGATE/TASK | User override |
| #2 Depth | query | QUICK/STANDARD/DEEP/REASONING | Explicit depth set |
| #3 Tool Filter | query, tool_candidates | Comma-separated names | ≤1 candidate |

### Fallback Heuristics

**Strategy Fallback:**
```python
def _fallback_strategy(query: str, confidence: float) -> ExecutionStrategy:
    q = query.lower()

    if any(p in q for p in ["implement", "create", "refactor"]):
        return ExecutionStrategy.TASK

    if confidence > 0.5 and any(p in q for p in ["find all", "how does"]):
        return ExecutionStrategy.DELEGATE

    return ExecutionStrategy.DIRECT
```

**Depth Fallback:**
```python
def _fallback_depth(query: str) -> ThinkingDepth:
    q = query.lower()

    if len(query) < 20 or any(p in q for p in ["cd ", "ls", "pwd"]):
        return ThinkingDepth.QUICK

    if any(p in q for p in ["design", "architect", "trade-off"]):
        return ThinkingDepth.REASONING

    if any(p in q for p in ["explain", "analyze", "how does"]):
        return ThinkingDepth.DEEP

    return ThinkingDepth.STANDARD
```

## Complete Flow Example

```
┌────────────────────────────────────────────────────────────────┐
│  Query: "How does authentication work in the API?"             │
│                                                                │
│  PLAN NODE (depth 0)                                           │
│  ├─ Semantic Router                                           │
│  │  └─ best_agent: code_explorer (0.72 confidence)            │
│  └─ FunctionGemma #1: Strategy                                │
│     └─ Result: DELEGATE                                       │
│                                                                │
│  → Spawn code_explorer subagent                               │
│                                                                │
│  PREPARE NODE (in code_explorer)                               │
│  ├─ FunctionGemma #2: Depth                                   │
│  │  └─ Result: DEEP                                           │
│  ├─ Tool budget: 15                                           │
│  ├─ Semantic Router                                           │
│  │  └─ 12 tool candidates above threshold                     │
│  └─ FunctionGemma #3: Tool Filter                             │
│     └─ Result: read_file, search_content, search_files,       │
│                semantic_doc_search                            │
│                                                                │
│  Execute ReAct loop:                                           │
│  • Depth: DEEP                                                │
│  • Inference: CLOUD (gemini-2.5-pro)                          │
│  • Tools: 4 filtered tools                                    │
└────────────────────────────────────────────────────────────────┘
```

## Depth Enforcement for Subagents

Subagents **never run the Plan Node**. This prevents recursive spawning:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Execution Context         │ Plan Node │ Prepare Node │ Can Spawn?     │
│────────────────────────────┼───────────┼──────────────┼────────────────│
│  hester chat               │    ✅     │      ✅      │     Yes        │
│  hester daemon             │    ✅     │      ✅      │     Yes        │
│  Subagent (delegated)      │    ❌     │      ✅      │     No         │
│  Task batch                │    ❌     │      ✅      │     No         │
│  hester agent (CLI)        │    ❌     │      ✅      │     No         │
└─────────────────────────────────────────────────────────────────────────┘
```

The `delegate` tool is in the `FORBIDDEN_FOR_SUBAGENTS` set, enforced at both registration and execution time.

## Integration with Existing Tools

### Scoping (from 04-Hester-Subagents.md)

The Prepare Node respects tool scoping:

```python
TOOL_SETS = {
    "observe": ["read_file", "search_files", "search_content", ...],
    "research": [*observe, "web_search", "db_*", "semantic_doc_search", ...],
    "develop": [*observe, "write_file", "edit_file", "bash"],
    "full": [*all except orchestration and spawn*],
}

FORBIDDEN_FOR_SUBAGENTS = {
    "create_task", "add_batch", "delegate", ...
}
```

### Shortcut Detection

Before Plan/Prepare, shortcuts bypass the full flow:

```python
# Detected before Plan Node
shortcut = detect_shortcut(query)
if shortcut.is_shortcut:
    return execute_shortcut(shortcut)  # cd, ls, cat, etc.
```

## Performance Budget

Target latencies:

| Component | Target | Notes |
|-----------|--------|-------|
| Semantic Router | 50-100ms | Embedding lookup |
| FunctionGemma call | 100-200ms | Small local model |
| Plan Node total | 150-300ms | Router + 1 FG call |
| Prepare Node total | 200-400ms | 1-2 FG calls + router |
| Full triage | 350-700ms | Plan + Prepare |

Shortcuts bypass triage entirely (~10ms).

## Configuration

```python
# lee/hester/daemon/settings.py

class PlanSettings(BaseSettings):
    # Strategy thresholds
    delegate_confidence_threshold: float = 0.5

    # FunctionGemma timeouts
    strategy_timeout_ms: int = 300
    depth_timeout_ms: int = 300
    tool_filter_timeout_ms: int = 300

    # Tool budgets
    tool_budget_quick: int = 5
    tool_budget_standard: int = 10
    tool_budget_deep: int = 15
    tool_budget_reasoning: int = 20

    # Model selection
    local_model_quick: str = "gemma3n-e2b"
    local_model_standard: str = "gemma3n-e4b"
    cloud_model_standard: str = "gemini-2.5-flash"
    cloud_model_deep: str = "gemini-2.5-pro"
```

## Related Documentation

- `lee/docs/04-Hester-Subagents.md` - Subagent architecture and tool scoping
- `lee/docs/02-Hester-Context-Bundles.md` - Context passing between executions
- `lee/hester/daemon/planning/` - Implementation directory
- `lee/hester/daemon/registry.py` - Unified agent/tool registry
