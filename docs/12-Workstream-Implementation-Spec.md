# Workstream Implementation Specification

## Overview

This document specifies the implementation of the Workstream Architecture, transforming Hester into a **Technical Product Manager (TPM)** that orchestrates multi-agent development workflows with intelligent context management.

**Design Principles:**
1. **Extend, don't replace** - Build on existing Task, Context Bundle, and Session systems
2. **~~Redis-first~~ File-first, Redis cache** - Workstreams stored as YAML/markdown in `.hester/workstreams/`, Redis for optional caching
3. **Context is king** - Context Slicing is the core innovation
4. **Observable by default** - Every agent action emits telemetry

---

## Implementation Status

> **Last updated:** 2026-02-25
> **Branch:** `feature/workstream-backend` (worktree at `~/.claude/worktrees/workstream-backend/`)
> **Tests:** 135 passing across 10 test files

### What's Built

| Component | File | Status | Phase | Notes |
|-----------|------|--------|-------|-------|
| Data Models | `daemon/workstream/models.py` | **DONE** | 1 | YAML/markdown serialization |
| Store | `daemon/workstream/store.py` | **DONE** | 1 | File-first, directory-per-workstream |
| Context Warehouse | `daemon/workstream/warehouse.py` | **DONE** | 1 | Bundles, files, notes |
| Context Slicer | `daemon/workstream/slicer.py` | **DONE** | 1+2 | Depth escalation + Gemini 3 Flash slicing |
| Telemetry Events | `daemon/workstream/telemetry.py` | **DONE** | 1 | WorkstreamEvent model |
| Claude Code Hooks | `daemon/workstream/hooks.py` | **DONE** | 1 | Hook generation + setup |
| Orchestrator | `daemon/workstream/orchestrator.py` | **DONE** | 1+2 | Phase transitions, runbook gen, dispatch, follow-ups |
| HTTP Routes | `daemon/workstream/routes.py` | **DONE** | 1+3+4 | CRUD, phases, runbook, dispatch, generate, telemetry |
| CLI Commands | `cli/workstream.py` | **DONE** | 1 | Full Click surface with Rich output |
| Module Exports | `daemon/workstream/__init__.py` | **DONE** | 1 | All public API exported |
| Gemini Helper | `daemon/workstream/gemini.py` | **DONE** | 2 | Modern SDK, JSON mode, ThinkingConfig for Gemini 3 |
| Daemon Mounting | `daemon/main.py` | **DONE** | 3 | Router mounted, WorkstreamStore in AppState |
| AgentTelemetry Extensions | `daemon/models.py` | **DONE** | 3 | task_id, batch_id, recent_tools, files_touched, record_tool_use() |
| Telemetry Bridging | `daemon/main.py` | **DONE** | 3 | Agent telemetry → workstream JSONL on update/complete |

### What's Deferred

| Feature | Spec Section | Why Deferred |
|---------|-------------|--------------|
| Redis-backed WorkstreamStore | §1 | **Replaced** with file-first store (user decision) |
| Redis TelemetryStore | §4.3 | JSONL file telemetry works; Redis for fast queries is P2 |
| SSE Telemetry Streaming | §4.5 | Needs `sse-starlette` dep |
| Internal Agent Telemetry helper | §4.7 | `InternalAgentTelemetry` class for Hester subagents |
| Event Bus | §8 | Local pub/sub for cross-component events |
| Grounding with real bundles | §2.1 | `create_grounding_bundle()` needs real ContextBundleService |
| Prompts directory | §8 | Prompt templates inline in orchestrator (works, just not externalized) |
| Lee UI | §6 | WorkstreamTab, WorkstreamPicker, AgentTelemetryPanel |

### Key Divergences from Spec

1. **Storage**: Spec uses Redis-first with TTL. Implementation uses **file-first** (`.hester/workstreams/{ws-id}/`) with YAML/markdown — more durable, no Redis dependency, follows existing task system patterns.

2. **Store API**: Spec's store is `async` (Redis). Implementation is **sync** (file I/O). Orchestrator wraps sync store calls in async methods for route compatibility.

3. **Telemetry**: Spec has `WorkstreamTelemetryStore` with Redis lists. Implementation has `WorkstreamEvent` model + JSONL file append via `WorkstreamStore.push_telemetry()`. Agent telemetry bridges to workstream JSONL.

4. **Gemini SDK**: Spec used legacy `google.generativeai` SDK. Implementation uses modern `google.genai` SDK with `gemini-3-flash-preview` model and `ThinkingConfig(thinking_level="low")`.

5. **Routes**: Spec uses direct `@app` decorators. Implementation uses `APIRouter` factory (`create_workstream_router()`) mounted via `app.include_router()` in lifespan.

6. **Prompts**: Spec has external `prompts/` directory. Implementation embeds prompts as class constants in orchestrator — simpler, no file I/O, easily testable.

---

## 1. Data Model

### 1.1 Workstream Entity

A Workstream wraps multiple Tasks and provides higher-level orchestration.

```python
# lee/hester/daemon/workstream/models.py

from enum import Enum
from typing import List, Dict, Optional, Any
from datetime import datetime
from pydantic import BaseModel, Field
import uuid


class WorkstreamPhase(str, Enum):
    """Workstream lifecycle phases."""
    EXPLORATION = "exploration"       # Ideation, brief creation
    DESIGN = "design"                 # Grounding, research, validation
    PLANNING = "planning"             # Runbook creation
    EXECUTION = "execution"           # Active development
    REVIEW = "review"                 # Final validation
    DONE = "done"                     # Completed
    PAUSED = "paused"                 # User-paused


class WorkstreamBrief(BaseModel):
    """The high-level objective from Exploration phase."""
    objective: str = Field(description="What needs to be accomplished")
    rationale: str = Field(default="", description="Why this matters")
    constraints: List[str] = Field(default_factory=list, description="Known constraints")
    out_of_scope: List[str] = Field(default_factory=list, description="Explicitly excluded")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    conversation_id: Optional[str] = Field(None, description="Session ID of exploration chat")


class DesignDecision(BaseModel):
    """A key decision made during Design phase."""
    id: str = Field(default_factory=lambda: f"decision-{uuid.uuid4().hex[:8]}")
    question: str = Field(description="What was being decided")
    decision: str = Field(description="What was decided")
    rationale: str = Field(description="Why this approach")
    alternatives: List[str] = Field(default_factory=list, description="Options considered")
    risks: List[str] = Field(default_factory=list, description="Identified risks")
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class DesignDoc(BaseModel):
    """The validated specification from Design phase."""
    summary: str = Field(description="Executive summary of approach")
    grounding: Dict[str, Any] = Field(default_factory=dict, description="Codebase analysis results")
    research: List[Dict[str, str]] = Field(default_factory=list, description="Web research findings")
    decisions: List[DesignDecision] = Field(default_factory=list)
    architecture_notes: str = Field(default="", description="Technical architecture")
    api_contracts: List[Dict[str, Any]] = Field(default_factory=list, description="API specs if applicable")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    validated_at: Optional[datetime] = None
    bundle_id: Optional[str] = Field(None, description="Associated context bundle ID")


class RunbookTask(BaseModel):
    """A task in the Runbook (wrapper around existing Task)."""
    task_id: str = Field(description="Reference to Task in TaskStore")
    title: str
    dependencies: List[str] = Field(default_factory=list, description="Task IDs this depends on")
    suggested_by: str = Field(default="user", description="'user' or 'hester'")
    context_slice: Optional[str] = Field(None, description="Context slice ID for this task")
    priority: int = Field(default=0, description="Execution priority (lower = higher priority)")


class Runbook(BaseModel):
    """The dynamic task graph for the Workstream."""
    tasks: List[RunbookTask] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_updated: datetime = Field(default_factory=datetime.utcnow)

    def get_ready_tasks(self, completed_ids: List[str]) -> List[RunbookTask]:
        """Get tasks whose dependencies are all completed."""
        return [
            t for t in self.tasks
            if t.task_id not in completed_ids
            and all(dep in completed_ids for dep in t.dependencies)
        ]

    def add_task(self, task: RunbookTask) -> None:
        """Add a task to the runbook."""
        self.tasks.append(task)
        self.last_updated = datetime.utcnow()


class AgentRegistration(BaseModel):
    """An agent contributing to this Workstream."""
    agent_id: str = Field(description="Unique agent identifier")
    agent_type: str = Field(description="claude_code, hester, code_explorer, etc.")
    registered_at: datetime = Field(default_factory=datetime.utcnow)
    last_heartbeat: datetime = Field(default_factory=datetime.utcnow)
    current_task_id: Optional[str] = None
    status: str = Field(default="idle", description="idle, active, completed, failed")
    metadata: Dict[str, Any] = Field(default_factory=dict)


class Workstream(BaseModel):
    """Top-level Workstream entity."""
    id: str = Field(default_factory=lambda: f"ws-{uuid.uuid4().hex[:8]}")
    title: str
    phase: WorkstreamPhase = WorkstreamPhase.EXPLORATION

    # Phase artifacts
    brief: Optional[WorkstreamBrief] = None
    design_doc: Optional[DesignDoc] = None
    runbook: Runbook = Field(default_factory=Runbook)

    # Context Warehouse
    warehouse_bundle_ids: List[str] = Field(default_factory=list, description="Context bundle IDs")
    warehouse_files: List[str] = Field(default_factory=list, description="Relevant file paths")
    warehouse_notes: str = Field(default="", description="Accumulated research notes")

    # Agent registry
    agents: List[AgentRegistration] = Field(default_factory=list)

    # Metadata
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    completed_task_ids: List[str] = Field(default_factory=list)

    # Telemetry tracking
    telemetry_enabled: bool = Field(default=True)

    def add_to_warehouse(self, bundle_id: str) -> None:
        """Add a context bundle to the warehouse."""
        if bundle_id not in self.warehouse_bundle_ids:
            self.warehouse_bundle_ids.append(bundle_id)
            self.updated_at = datetime.utcnow()

    def register_agent(self, agent: AgentRegistration) -> None:
        """Register an agent as contributing to this Workstream."""
        # Update existing or add new
        for i, existing in enumerate(self.agents):
            if existing.agent_id == agent.agent_id:
                self.agents[i] = agent
                return
        self.agents.append(agent)
        self.updated_at = datetime.utcnow()

    def get_active_agents(self) -> List[AgentRegistration]:
        """Get currently active agents."""
        return [a for a in self.agents if a.status == "active"]
```

### 1.2 Redis Schema

```python
# lee/hester/daemon/workstream/store.py

from typing import Optional, List
from datetime import timedelta
import json

# Key patterns:
# hester:workstream:{ws_id}              - Main Workstream JSON
# hester:workstream:{ws_id}:telemetry    - Telemetry event stream (list)
# hester:workstream:{ws_id}:slices       - Context slices (hash: slice_id -> content)
# hester:workstream:index                - Set of all Workstream IDs

DEFAULT_TTL = timedelta(days=7)


class WorkstreamStore:
    """Redis-backed Workstream persistence."""

    def __init__(self, redis_client, ttl: timedelta = DEFAULT_TTL):
        self.redis = redis_client
        self.ttl = ttl
        self._key_prefix = "hester:workstream:"

    def _ws_key(self, ws_id: str) -> str:
        return f"{self._key_prefix}{ws_id}"

    def _telemetry_key(self, ws_id: str) -> str:
        return f"{self._key_prefix}{ws_id}:telemetry"

    def _slices_key(self, ws_id: str) -> str:
        return f"{self._key_prefix}{ws_id}:slices"

    def _index_key(self) -> str:
        return f"{self._key_prefix}index"

    async def create(self, workstream: Workstream) -> Workstream:
        """Create a new Workstream."""
        key = self._ws_key(workstream.id)
        data = workstream.model_dump_json()

        async with self.redis.pipeline() as pipe:
            pipe.setex(key, int(self.ttl.total_seconds()), data)
            pipe.sadd(self._index_key(), workstream.id)
            await pipe.execute()

        return workstream

    async def get(self, ws_id: str) -> Optional[Workstream]:
        """Get a Workstream by ID."""
        key = self._ws_key(ws_id)
        data = await self.redis.get(key)
        if data is None:
            return None
        return Workstream.model_validate_json(data)

    async def save(self, workstream: Workstream) -> None:
        """Save/update a Workstream."""
        workstream.updated_at = datetime.utcnow()
        key = self._ws_key(workstream.id)
        data = workstream.model_dump_json()
        await self.redis.setex(key, int(self.ttl.total_seconds()), data)

    async def delete(self, ws_id: str) -> bool:
        """Delete a Workstream and associated data."""
        async with self.redis.pipeline() as pipe:
            pipe.delete(self._ws_key(ws_id))
            pipe.delete(self._telemetry_key(ws_id))
            pipe.delete(self._slices_key(ws_id))
            pipe.srem(self._index_key(), ws_id)
            results = await pipe.execute()
        return results[0] > 0

    async def list_all(self) -> List[str]:
        """List all Workstream IDs."""
        return [ws_id.decode() for ws_id in await self.redis.smembers(self._index_key())]

    async def list_active(self) -> List[Workstream]:
        """List all non-done Workstreams."""
        ws_ids = await self.list_all()
        workstreams = []
        for ws_id in ws_ids:
            ws = await self.get(ws_id)
            if ws and ws.phase not in (WorkstreamPhase.DONE, WorkstreamPhase.PAUSED):
                workstreams.append(ws)
        return workstreams

    # Telemetry operations
    async def push_telemetry(self, ws_id: str, event: dict) -> None:
        """Push a telemetry event to the stream."""
        key = self._telemetry_key(ws_id)
        await self.redis.rpush(key, json.dumps(event))
        await self.redis.expire(key, int(self.ttl.total_seconds()))
        # Trim to last 1000 events
        await self.redis.ltrim(key, -1000, -1)

    async def get_telemetry(self, ws_id: str, limit: int = 100) -> List[dict]:
        """Get recent telemetry events."""
        key = self._telemetry_key(ws_id)
        events = await self.redis.lrange(key, -limit, -1)
        return [json.loads(e) for e in events]

    # Context slice operations
    async def store_slice(self, ws_id: str, slice_id: str, content: str) -> None:
        """Store a context slice."""
        key = self._slices_key(ws_id)
        await self.redis.hset(key, slice_id, content)
        await self.redis.expire(key, int(self.ttl.total_seconds()))

    async def get_slice(self, ws_id: str, slice_id: str) -> Optional[str]:
        """Get a context slice."""
        key = self._slices_key(ws_id)
        content = await self.redis.hget(key, slice_id)
        return content.decode() if content else None
```

---

## 2. Context Warehouse

The Context Warehouse is the unified knowledge base for a Workstream. It extends the existing Context Bundle system.

### 2.1 Integration with Context Bundles

```python
# lee/hester/daemon/workstream/warehouse.py

from typing import List, Optional, Dict, Any
from pathlib import Path
from hester.context.service import ContextBundleService
from hester.context.models import ContextBundle


class ContextWarehouse:
    """
    Manages the Context Warehouse for a Workstream.

    The warehouse aggregates:
    - Pre-existing context bundles (referenced by ID)
    - Auto-generated bundles (created during grounding)
    - Relevant files discovered during research
    - Web research findings
    - Design decisions and architecture notes
    """

    def __init__(
        self,
        workstream_id: str,
        bundle_service: ContextBundleService,
        store: WorkstreamStore,
    ):
        self.ws_id = workstream_id
        self.bundles = bundle_service
        self.store = store

    async def get_workstream(self) -> Workstream:
        """Get the associated Workstream."""
        return await self.store.get(self.ws_id)

    async def add_bundle(self, bundle_id: str) -> None:
        """Add an existing bundle to the warehouse."""
        ws = await self.get_workstream()
        ws.add_to_warehouse(bundle_id)
        await self.store.save(ws)

    async def create_grounding_bundle(
        self,
        name: str,
        file_patterns: List[str],
        grep_patterns: List[str],
        db_tables: List[str],
    ) -> str:
        """
        Create a context bundle from grounding analysis.

        Used during Design phase to capture codebase analysis.
        """
        from hester.context.models import (
            GlobSource, GrepSource, DbSchemaSource, SourceType
        )

        sources = []

        # Add file patterns
        for pattern in file_patterns:
            sources.append(GlobSource(
                type=SourceType.GLOB,
                pattern=pattern,
            ))

        # Add grep patterns
        for pattern in grep_patterns:
            sources.append(GrepSource(
                type=SourceType.GREP,
                pattern=pattern,
                context_lines=3,
            ))

        # Add database schema
        if db_tables:
            sources.append(DbSchemaSource(
                type=SourceType.DB_SCHEMA,
                tables=db_tables,
                include_rls=True,
            ))

        # Create bundle via service
        bundle = await self.bundles.create(
            bundle_id=f"{self.ws_id}-{name}",
            title=f"Grounding: {name}",
            sources=sources,
            ttl_hours=168,  # 7 days to match Workstream TTL
            tags=["workstream", self.ws_id, "grounding"],
        )

        # Add to warehouse
        await self.add_bundle(bundle.metadata.id)

        return bundle.metadata.id

    async def get_full_context(self) -> str:
        """
        Get the full warehouse content.

        Returns concatenated content from all bundles + notes.
        """
        ws = await self.get_workstream()
        parts = []

        # Add design doc summary if exists
        if ws.design_doc:
            parts.append(f"# Design Summary\n\n{ws.design_doc.summary}")
            if ws.design_doc.architecture_notes:
                parts.append(f"\n## Architecture\n\n{ws.design_doc.architecture_notes}")

        # Add all bundle contents
        for bundle_id in ws.warehouse_bundle_ids:
            try:
                bundle = await self.bundles.get(bundle_id)
                if bundle:
                    parts.append(f"\n# Context: {bundle.metadata.title}\n\n{bundle.content}")
            except Exception:
                continue

        # Add notes
        if ws.warehouse_notes:
            parts.append(f"\n# Research Notes\n\n{ws.warehouse_notes}")

        return "\n\n---\n\n".join(parts)
```

---

## 3. Context Slicing

Context Slicing is the core innovation: intelligently extracting only relevant context for each task, with **model-specific limits** and **thinking depth adjustment** for Hester subagents.

### 3.1 Model-Specific Context Limits

Different agents have different context capacities:

| Agent Type | Model | Max Context | Recommended Slice |
|------------|-------|-------------|-------------------|
| Claude Code | claude-sonnet-4 | 200K tokens | 100K tokens |
| Claude Code | claude-opus-4 | 200K tokens | 100K tokens |
| Hester (QUICK) | gemini-2.5-flash | 1M tokens | 20K tokens |
| Hester (STANDARD) | gemini-2.5-flash | 1M tokens | 50K tokens |
| Hester (DEEP) | gemini-3-flash | 1M tokens | 100K tokens |
| Hester (PRO) | gemini-3-pro | 1M tokens | 150K tokens |
| Hester (LOCAL) | gemma3n | 8K tokens | 4K tokens |
| Hester (DEEPLOCAL) | gemma3 | 8K tokens | 6K tokens |

**Thinking Depth Escalation**: When context exceeds a tier's limit, automatically escalate:
- LOCAL (4K) → STANDARD (50K) → DEEP (100K) → PRO (150K)

### 3.2 Slice Generation

```python
# lee/hester/daemon/workstream/slicer.py

from typing import List, Dict, Any, Optional, Tuple
from pydantic import BaseModel, Field
from enum import Enum
import uuid
import google.generativeai as genai

from ..thinking_depth import ThinkingDepth


class AgentType(str, Enum):
    """Target agent for the context slice."""
    CLAUDE_CODE = "claude_code"
    HESTER = "hester"


# Token limits per agent/depth combination
CONTEXT_LIMITS = {
    # Claude Code - generous limits
    (AgentType.CLAUDE_CODE, None): 100_000,

    # Hester by thinking depth
    (AgentType.HESTER, ThinkingDepth.LOCAL): 4_000,
    (AgentType.HESTER, ThinkingDepth.DEEPLOCAL): 6_000,
    (AgentType.HESTER, ThinkingDepth.QUICK): 20_000,
    (AgentType.HESTER, ThinkingDepth.STANDARD): 50_000,
    (AgentType.HESTER, ThinkingDepth.DEEP): 100_000,
    (AgentType.HESTER, ThinkingDepth.PRO): 150_000,
}

# Escalation path for Hester when context exceeds limits
DEPTH_ESCALATION = [
    ThinkingDepth.LOCAL,
    ThinkingDepth.DEEPLOCAL,
    ThinkingDepth.QUICK,
    ThinkingDepth.STANDARD,
    ThinkingDepth.DEEP,
    ThinkingDepth.PRO,
]


class ContextSlice(BaseModel):
    """A task-specific subset of the Context Warehouse."""
    id: str = Field(default_factory=lambda: f"slice-{uuid.uuid4().hex[:8]}")
    task_id: str
    task_title: str

    # Target agent configuration
    agent_type: AgentType = AgentType.CLAUDE_CODE
    recommended_depth: Optional[ThinkingDepth] = Field(
        None, description="Recommended thinking depth based on context size"
    )
    original_depth: Optional[ThinkingDepth] = Field(
        None, description="Originally requested depth (before escalation)"
    )
    depth_escalated: bool = Field(
        default=False, description="Whether depth was escalated due to context size"
    )

    # What's included
    included_bundles: List[str] = Field(default_factory=list)
    included_files: List[str] = Field(default_factory=list)
    included_sections: Dict[str, List[str]] = Field(default_factory=dict)  # bundle_id -> section titles

    # The actual sliced content
    content: str = Field(default="")

    # Metadata
    rationale: str = Field(default="", description="Why this context was selected")
    token_estimate: int = Field(default=0)
    token_limit: int = Field(default=0, description="Max tokens for target agent")


def get_context_limit(
    agent_type: AgentType,
    depth: Optional[ThinkingDepth] = None,
) -> int:
    """Get the token limit for an agent/depth combination."""
    if agent_type == AgentType.CLAUDE_CODE:
        return CONTEXT_LIMITS[(AgentType.CLAUDE_CODE, None)]
    return CONTEXT_LIMITS.get((agent_type, depth), 50_000)


def escalate_depth_for_context(
    token_count: int,
    requested_depth: ThinkingDepth,
) -> Tuple[ThinkingDepth, bool]:
    """
    Determine if thinking depth needs escalation based on context size.

    Returns:
        (recommended_depth, was_escalated)
    """
    requested_limit = CONTEXT_LIMITS.get(
        (AgentType.HESTER, requested_depth), 50_000
    )

    # If within limit, no escalation needed
    if token_count <= requested_limit:
        return requested_depth, False

    # Find minimum depth that can handle this context
    for depth in DEPTH_ESCALATION:
        limit = CONTEXT_LIMITS.get((AgentType.HESTER, depth), 50_000)
        if token_count <= limit:
            # Only escalate if this depth is higher than requested
            if DEPTH_ESCALATION.index(depth) > DEPTH_ESCALATION.index(requested_depth):
                return depth, True
            return requested_depth, False

    # Context too large even for PRO, return PRO anyway
    return ThinkingDepth.PRO, True


class ContextSlicer:
    """
    Intelligently slices the Context Warehouse for specific tasks.

    Uses Gemini to analyze the task requirements and select relevant
    portions of the warehouse, avoiding context overload.

    Key features:
    - Model-specific token limits
    - Automatic thinking depth escalation for Hester subagents
    - Iterative slicing if initial slice exceeds limits
    """

    SLICE_PROMPT = """You are a context curator for an AI development workflow.

Given a TASK and a WAREHOUSE of available context, select ONLY the portions
relevant to completing the task. Your goal is to minimize context while
ensuring the agent has everything needed.

TASK:
Title: {task_title}
Goal: {task_goal}
Steps: {task_steps}

WAREHOUSE CONTENTS:
{warehouse_toc}

---

Instructions:
1. Analyze what information the task actually needs
2. Select specific sections/files from the warehouse
3. Explain your reasoning briefly

Output JSON:
{{
    "included_bundles": ["bundle-id-1", "bundle-id-2"],
    "included_files": ["path/to/file.py", "path/to/other.py"],
    "included_sections": {{
        "bundle-id-1": ["Section Title 1", "Section Title 2"]
    }},
    "excluded_reason": "Brief explanation of what was excluded and why",
    "rationale": "Brief explanation of what was included and why"
}}
"""

    def __init__(
        self,
        warehouse: ContextWarehouse,
        model: str = "gemini-2.0-flash",
    ):
        self.warehouse = warehouse
        self.model = genai.GenerativeModel(model)

    async def _generate_warehouse_toc(self) -> str:
        """Generate a table of contents for the warehouse."""
        ws = await self.warehouse.get_workstream()
        toc_parts = []

        for bundle_id in ws.warehouse_bundle_ids:
            bundle = await self.warehouse.bundles.get(bundle_id)
            if bundle:
                # Extract section headers from content
                sections = self._extract_sections(bundle.content)
                toc_parts.append(f"## Bundle: {bundle.metadata.title} ({bundle_id})")
                toc_parts.append(f"Tags: {', '.join(bundle.metadata.tags)}")
                if sections:
                    toc_parts.append("Sections:")
                    for section in sections:
                        toc_parts.append(f"  - {section}")
                toc_parts.append("")

        # Add file list
        if ws.warehouse_files:
            toc_parts.append("## Relevant Files")
            for f in ws.warehouse_files[:50]:  # Limit to 50 files
                toc_parts.append(f"  - {f}")

        return "\n".join(toc_parts)

    def _extract_sections(self, content: str) -> List[str]:
        """Extract markdown section headers from content."""
        import re
        headers = re.findall(r'^#{1,3}\s+(.+)$', content, re.MULTILINE)
        return headers[:20]  # Limit to 20 sections

    async def slice_for_task(
        self,
        task_id: str,
        task_title: str,
        task_goal: str,
        task_steps: List[str],
        agent_type: AgentType = AgentType.CLAUDE_CODE,
        requested_depth: Optional[ThinkingDepth] = None,
    ) -> ContextSlice:
        """
        Generate a context slice for a specific task.

        Args:
            task_id: Unique task identifier
            task_title: Human-readable task title
            task_goal: What the task should accomplish
            task_steps: List of steps/batches in the task
            agent_type: Target agent (claude_code or hester)
            requested_depth: For Hester agents, the initially requested thinking depth

        Returns:
            ContextSlice with only the relevant portions of the warehouse,
            plus recommended_depth if escalation was needed.
        """
        # Determine token limit based on agent/depth
        if agent_type == AgentType.HESTER and requested_depth:
            token_limit = get_context_limit(agent_type, requested_depth)
        else:
            token_limit = get_context_limit(agent_type)

        # Generate TOC
        toc = await self._generate_warehouse_toc()

        # Ask Gemini to select relevant context with token budget
        prompt = self.SLICE_PROMPT.format(
            task_title=task_title,
            task_goal=task_goal,
            task_steps="\n".join(f"- {s}" for s in task_steps),
            warehouse_toc=toc,
        )

        # Add token limit guidance
        prompt += f"\n\nIMPORTANT: The target agent has a context limit of ~{token_limit:,} tokens. "
        prompt += "Prioritize the most essential context and exclude nice-to-have information."

        response = await self.model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"},
        )

        import json
        selection = json.loads(response.text)

        # Build the actual sliced content
        content_parts = []
        ws = await self.warehouse.get_workstream()

        for bundle_id in selection.get("included_bundles", []):
            if bundle_id in ws.warehouse_bundle_ids:
                bundle = await self.warehouse.bundles.get(bundle_id)
                if bundle:
                    # If specific sections requested, extract them
                    sections = selection.get("included_sections", {}).get(bundle_id)
                    if sections:
                        content_parts.append(
                            self._extract_bundle_sections(bundle.content, sections)
                        )
                    else:
                        content_parts.append(bundle.content)

        # Combine content
        sliced_content = "\n\n---\n\n".join(content_parts)

        # Estimate tokens (rough: 1 token ≈ 4 chars)
        token_estimate = len(sliced_content) // 4

        # Check if depth escalation is needed for Hester agents
        recommended_depth = requested_depth
        depth_escalated = False

        if agent_type == AgentType.HESTER and requested_depth:
            recommended_depth, depth_escalated = escalate_depth_for_context(
                token_estimate, requested_depth
            )

            if depth_escalated:
                # Update token limit for the escalated depth
                token_limit = get_context_limit(agent_type, recommended_depth)

        # Create slice
        slice_obj = ContextSlice(
            task_id=task_id,
            task_title=task_title,
            agent_type=agent_type,
            original_depth=requested_depth,
            recommended_depth=recommended_depth,
            depth_escalated=depth_escalated,
            included_bundles=selection.get("included_bundles", []),
            included_files=selection.get("included_files", []),
            included_sections=selection.get("included_sections", {}),
            content=sliced_content,
            rationale=selection.get("rationale", ""),
            token_estimate=token_estimate,
            token_limit=token_limit,
        )

        return slice_obj

    def _extract_bundle_sections(
        self,
        content: str,
        section_titles: List[str],
    ) -> str:
        """Extract specific sections from bundle content."""
        import re

        parts = []
        for title in section_titles:
            # Find section by title (escaped for regex)
            escaped_title = re.escape(title)
            pattern = rf'^(#{1,3}\s+{escaped_title}.*?)(?=^#{1,3}\s|\Z)'
            match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
            if match:
                parts.append(match.group(1).strip())

        return "\n\n".join(parts)
```

---

## 4. Agent Telemetry

The telemetry system provides real-time visibility into agent activities. **This integrates with the existing Hester daemon infrastructure** on port 9000, reusing the established orchestration endpoints.

### 4.1 Existing Infrastructure (daemon/main.py)

The Hester daemon already has telemetry infrastructure we will extend:

**Existing Models** (`daemon/models.py`):
- `AgentStatus` - STARTING, ACTIVE, IDLE, WORKING, BLOCKED, ERROR, COMPLETED, FAILED, CANCELLED
- `AgentType` - CLAUDE_CODE, HESTER, CUSTOM
- `AgentTelemetry` - session_id, agent_type, status, focus, active_file, tool, progress, **workstream_id**
- `TelemetryRequest/Response` - register, update, complete actions

**Existing Endpoints** (`daemon/main.py`):
- `POST /orchestrate/telemetry` - Register/update/complete agent sessions
- `GET /orchestrate/sessions` - List active agent sessions (filterable by workstream_id)
- `GET /orchestrate/sessions/{session_id}` - Get specific agent session
- `DELETE /orchestrate/sessions/{session_id}` - Delete agent session

**Existing Storage**:
- `app_state.agent_sessions: Dict[str, AgentTelemetry]` - In-memory agent tracking

### 4.2 Extensions for Workstreams

We extend the existing infrastructure rather than creating parallel systems:

```python
# lee/hester/daemon/models.py - Extend existing AgentType enum

class AgentType(str, Enum):
    """Types of agents in the orchestration system."""
    CLAUDE_CODE = "claude_code"
    HESTER = "hester"
    CODE_EXPLORER = "code_explorer"      # NEW
    WEB_RESEARCHER = "web_researcher"    # NEW
    DOCS_MANAGER = "docs_manager"        # NEW
    DB_EXPLORER = "db_explorer"          # NEW
    TEST_RUNNER = "test_runner"          # NEW
    CUSTOM = "custom"


# lee/hester/daemon/models.py - Extend AgentTelemetry with task tracking

class AgentTelemetry(BaseModel):
    """Agent telemetry data for orchestration."""
    # ... existing fields ...

    # Workstream integration (existing)
    workstream_id: Optional[str] = Field(None, description="Associated workstream ID")

    # Task tracking (NEW)
    task_id: Optional[str] = Field(None, description="Current task ID from Runbook")
    batch_id: Optional[str] = Field(None, description="Current batch ID")

    # Tool history (NEW - for UI display)
    recent_tools: List[str] = Field(default_factory=list, description="Last 10 tools used")
    files_touched: List[str] = Field(default_factory=list, description="Files read/written")

    def record_tool_use(self, tool_name: str, file_path: Optional[str] = None):
        """Record a tool use for history tracking."""
        self.recent_tools.append(tool_name)
        self.recent_tools = self.recent_tools[-10:]  # Keep last 10
        if file_path and file_path not in self.files_touched:
            self.files_touched.append(file_path)
            self.files_touched = self.files_touched[-20:]  # Keep last 20
        self.last_updated = datetime.now()
```

### 4.3 Workstream-Specific Telemetry Storage

For detailed event history beyond the in-memory agent sessions, we use Redis:

```python
# lee/hester/daemon/workstream/telemetry.py

from typing import List, Dict, Any, Optional
from datetime import datetime
from pydantic import BaseModel, Field
import uuid

from ..models import AgentType, AgentStatus


class WorkstreamEvent(BaseModel):
    """A telemetry event within a Workstream context."""
    id: str = Field(default_factory=lambda: f"evt-{uuid.uuid4().hex[:8]}")
    timestamp: datetime = Field(default_factory=datetime.utcnow)

    # Context
    workstream_id: str
    agent_session_id: str
    task_id: Optional[str] = None
    batch_id: Optional[str] = None

    # Event type (tool_call, file_read, file_write, thinking, etc.)
    event_type: str

    # Payload
    tool_name: Optional[str] = None
    file_path: Optional[str] = None
    content_preview: Optional[str] = None
    duration_ms: Optional[int] = None
    success: Optional[bool] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class WorkstreamTelemetryStore:
    """
    Redis-backed telemetry storage for Workstreams.

    Extends the existing in-memory agent_sessions with persistent
    event history per Workstream.
    """

    def __init__(self, redis_client, ttl_days: int = 7):
        self.redis = redis_client
        self.ttl_seconds = ttl_days * 24 * 60 * 60

    def _events_key(self, ws_id: str) -> str:
        return f"hester:workstream:{ws_id}:events"

    async def record_event(self, event: WorkstreamEvent) -> None:
        """Record an event to the Workstream's event stream."""
        key = self._events_key(event.workstream_id)
        await self.redis.rpush(key, event.model_dump_json())
        await self.redis.expire(key, self.ttl_seconds)
        # Trim to last 1000 events
        await self.redis.ltrim(key, -1000, -1)

    async def get_events(
        self,
        workstream_id: str,
        limit: int = 100,
        event_types: Optional[List[str]] = None,
    ) -> List[WorkstreamEvent]:
        """Get recent events for a Workstream."""
        key = self._events_key(workstream_id)
        raw_events = await self.redis.lrange(key, -limit * 2, -1)

        events = [WorkstreamEvent.model_validate_json(e) for e in raw_events]

        if event_types:
            events = [e for e in events if e.event_type in event_types]

        return events[-limit:]

    async def get_task_events(
        self,
        workstream_id: str,
        task_id: str,
    ) -> List[WorkstreamEvent]:
        """Get all events for a specific task."""
        events = await self.get_events(workstream_id, limit=500)
        return [e for e in events if e.task_id == task_id]
```

### 4.4 Claude Code Hook Integration

Claude Code hooks receive JSON via stdin and can send telemetry to our daemon. Here's the verified hook format:

**Hook Input (stdin JSON):**
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.js", "content": "..." },
  "tool_use_id": "toolu_01ABC123..."
}
```

**Environment Variables:**
- `CLAUDE_PROJECT_DIR` - Absolute path to project root
- `CLAUDE_ENV_FILE` - File path for persisting env vars (SessionStart only)

```python
# lee/hester/daemon/workstream/hooks.py

"""
Claude Code Hook Configuration Generator.

Generates .claude/settings.json and hook scripts that send
telemetry to the existing Hester daemon endpoints.

Claude Code hooks receive JSON via stdin (not env vars), so we need
small scripts to parse the input and forward to Hester.
"""

from typing import Dict, Any
from pathlib import Path
import json


# Hook script that parses stdin JSON and sends telemetry
TELEMETRY_HOOK_SCRIPT = '''#!/usr/bin/env python3
"""Claude Code hook script for Workstream telemetry."""
import sys
import json
import urllib.request

HESTER_URL = "{hester_url}"
WORKSTREAM_ID = "{workstream_id}"
TASK_ID = "{task_id}"

def send_telemetry(action: str, data: dict):
    """Send telemetry to Hester daemon."""
    payload = json.dumps({{
        "action": action,
        **data,
        "workstream_id": WORKSTREAM_ID,
        "metadata": {{
            "task_id": TASK_ID,
            **(data.get("metadata") or {{}})
        }}
    }}).encode()

    req = urllib.request.Request(
        f"{{HESTER_URL}}/orchestrate/telemetry",
        data=payload,
        headers={{"Content-Type": "application/json"}},
        method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # Don't let telemetry failures break Claude Code

def main():
    # Read JSON from stdin
    input_data = json.load(sys.stdin)

    session_id = input_data.get("session_id", "unknown")
    event = input_data.get("hook_event_name", "unknown")
    tool_name = input_data.get("tool_name")
    tool_input = input_data.get("tool_input", {{}})

    if event == "SessionStart":
        send_telemetry("register", {{
            "session_id": session_id,
            "agent_type": "claude_code",
            "status": "starting",
            "focus": "Starting Claude Code session",
        }})

    elif event == "PreToolUse":
        # Extract file path if present
        file_path = None
        if isinstance(tool_input, dict):
            file_path = tool_input.get("file_path") or tool_input.get("path")

        send_telemetry("update", {{
            "session_id": session_id,
            "status": "working",
            "tool": tool_name,
            "active_file": file_path,
            "metadata": {{
                "tool_input_preview": str(tool_input)[:200] if tool_input else None
            }}
        }})

    elif event == "PostToolUse":
        send_telemetry("update", {{
            "session_id": session_id,
            "status": "active",
            "tool": None,
            "metadata": {{
                "last_tool": tool_name,
            }}
        }})

    elif event == "Stop":
        send_telemetry("complete", {{
            "session_id": session_id,
            "status": "completed",
        }})

    # Output empty JSON to continue normally
    print(json.dumps({{"continue": True}}))

if __name__ == "__main__":
    main()
'''


def generate_hook_script(
    workstream_id: str,
    task_id: str,
    hester_url: str = "http://localhost:9000",
) -> str:
    """Generate the telemetry hook script content."""
    return TELEMETRY_HOOK_SCRIPT.format(
        hester_url=hester_url,
        workstream_id=workstream_id,
        task_id=task_id,
    )


def generate_claude_code_hooks(
    workstream_id: str,
    task_id: str,
) -> Dict[str, Any]:
    """
    Generate Claude Code hook configuration for Workstream telemetry.

    The hooks call a Python script that parses stdin JSON and
    forwards telemetry to the existing /orchestrate/telemetry endpoint.

    Usage:
        hooks = generate_claude_code_hooks("ws-abc", "task-123")
        # Write to .claude/settings.json in task working directory
    """
    hook_script = "$CLAUDE_PROJECT_DIR/.claude/hooks/workstream_telemetry.py"

    return {
        "hooks": {
            # Session start - register agent
            "SessionStart": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"python3 \"{hook_script}\"",
                            "timeout": 5
                        }
                    ]
                }
            ],

            # Pre-tool hook - update agent with current tool
            "PreToolUse": [
                {
                    "matcher": "*",  # Match all tools
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"python3 \"{hook_script}\"",
                            "timeout": 5
                        }
                    ]
                }
            ],

            # Post-tool hook - record tool completion
            "PostToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"python3 \"{hook_script}\"",
                            "timeout": 5
                        }
                    ]
                }
            ],

            # Session end - complete agent
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"python3 \"{hook_script}\"",
                            "timeout": 5
                        }
                    ]
                }
            ],
        }
    }


def setup_workstream_hooks(
    project_dir: Path,
    workstream_id: str,
    task_id: str,
    hester_url: str = "http://localhost:9000",
) -> None:
    """
    Set up Claude Code hooks for a Workstream task.

    Creates:
    - .claude/settings.local.json with hook configuration
    - .claude/hooks/workstream_telemetry.py script

    Uses settings.local.json so it doesn't get committed.
    """
    claude_dir = project_dir / ".claude"
    hooks_dir = claude_dir / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)

    # Write hook script
    script_path = hooks_dir / "workstream_telemetry.py"
    script_content = generate_hook_script(workstream_id, task_id, hester_url)
    script_path.write_text(script_content)
    script_path.chmod(0o755)

    # Write settings (local only, not committed)
    settings_path = claude_dir / "settings.local.json"
    settings = generate_claude_code_hooks(workstream_id, task_id)
    settings_path.write_text(json.dumps(settings, indent=2))
```

### 4.5 SSE Streaming for Real-time UI

Add a streaming endpoint for the Lee UI to receive real-time telemetry:

```python
# lee/hester/daemon/workstream/routes.py (partial)

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
import asyncio

router = APIRouter(prefix="/workstream", tags=["workstream"])


@router.get("/{ws_id}/telemetry/stream")
async def stream_workstream_telemetry(ws_id: str):
    """
    SSE stream of telemetry events for a Workstream.

    Polls agent_sessions and event store, emitting updates
    when agents change status or new events occur.
    """
    async def event_generator():
        last_seen = {}  # agent_session_id -> last_updated

        while True:
            # Get all agent sessions for this workstream
            from ..main import app_state

            for session_id, telemetry in app_state.agent_sessions.items():
                if telemetry.workstream_id != ws_id:
                    continue

                # Check if updated since last seen
                last = last_seen.get(session_id)
                if last is None or telemetry.last_updated > last:
                    last_seen[session_id] = telemetry.last_updated

                    yield {
                        "event": "agent_update",
                        "data": {
                            "session_id": session_id,
                            "agent_type": telemetry.agent_type.value,
                            "status": telemetry.status.value,
                            "focus": telemetry.focus,
                            "tool": telemetry.tool,
                            "progress": telemetry.progress,
                            "active_file": telemetry.active_file,
                            "last_updated": telemetry.last_updated.isoformat(),
                        }
                    }

            await asyncio.sleep(0.5)  # Poll every 500ms

    return EventSourceResponse(event_generator())
```

### 4.6 Integration Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WORKSTREAM TELEMETRY FLOW                                              │
│                                                                         │
│  1. Task Dispatch                                                       │
│     Orchestrator generates .claude/settings.json with hooks             │
│     → Hooks point to existing /orchestrate/telemetry endpoint           │
│                                                                         │
│  2. Claude Code Execution                                               │
│     SessionStart hook → POST /orchestrate/telemetry (register)          │
│     PreToolUse hook   → POST /orchestrate/telemetry (update: working)   │
│     PostToolUse hook  → POST /orchestrate/telemetry (update: active)    │
│     Stop hook         → POST /orchestrate/telemetry (complete)          │
│                                                                         │
│  3. Daemon Processing                                                   │
│     /orchestrate/telemetry updates app_state.agent_sessions             │
│     If workstream_id present, also record to Redis event stream         │
│                                                                         │
│  4. Lee UI                                                              │
│     Subscribes to /workstream/{ws_id}/telemetry/stream (SSE)            │
│     Receives real-time agent updates                                    │
│     Displays in Agent Workspace panel                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.7 Internal Agent Telemetry

For Hester's internal agents (code_explorer, web_researcher, etc.), we emit telemetry directly:

```python
# lee/hester/daemon/workstream/internal_telemetry.py

from typing import Optional
from datetime import datetime
import httpx

from ..models import TelemetryRequest, TelemetryAction, AgentType, AgentStatus


class InternalAgentTelemetry:
    """
    Helper for internal Hester agents to emit telemetry.

    Used by delegates (CodeExplorerDelegate, WebResearcherDelegate, etc.)
    when operating within a Workstream context.
    """

    def __init__(
        self,
        session_id: str,
        agent_type: AgentType,
        workstream_id: str,
        task_id: Optional[str] = None,
        daemon_url: str = "http://localhost:9000",
    ):
        self.session_id = session_id
        self.agent_type = agent_type
        self.workstream_id = workstream_id
        self.task_id = task_id
        self.daemon_url = daemon_url
        self._client = httpx.AsyncClient()

    async def register(self, focus: str = "") -> None:
        """Register this agent session."""
        await self._send(TelemetryRequest(
            action=TelemetryAction.REGISTER,
            session_id=self.session_id,
            agent_type=self.agent_type,
            status=AgentStatus.STARTING,
            focus=focus,
            workstream_id=self.workstream_id,
            metadata={"task_id": self.task_id} if self.task_id else None,
        ))

    async def update(
        self,
        status: AgentStatus = AgentStatus.ACTIVE,
        focus: Optional[str] = None,
        tool: Optional[str] = None,
        active_file: Optional[str] = None,
        progress: Optional[int] = None,
    ) -> None:
        """Update agent status."""
        await self._send(TelemetryRequest(
            action=TelemetryAction.UPDATE,
            session_id=self.session_id,
            status=status,
            focus=focus,
            tool=tool,
            active_file=active_file,
            progress=progress,
            workstream_id=self.workstream_id,
        ))

    async def complete(
        self,
        success: bool = True,
        result: Optional[str] = None,
    ) -> None:
        """Mark agent as complete."""
        await self._send(TelemetryRequest(
            action=TelemetryAction.COMPLETE,
            session_id=self.session_id,
            status=AgentStatus.COMPLETED if success else AgentStatus.FAILED,
            result=result,
            workstream_id=self.workstream_id,
        ))

    async def _send(self, request: TelemetryRequest) -> None:
        """Send telemetry to daemon."""
        try:
            await self._client.post(
                f"{self.daemon_url}/orchestrate/telemetry",
                json=request.model_dump(exclude_none=True),
                timeout=2.0,
            )
        except Exception:
            pass  # Don't let telemetry failures break agent execution

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()
```

---

## 5. Workstream Orchestrator

The orchestrator manages the Workstream lifecycle and coordinates agents.

### 5.1 Phase Transitions

```python
# lee/hester/daemon/workstream/orchestrator.py

from typing import Optional, List, Dict, Any
from datetime import datetime
import logging

from .models import (
    Workstream, WorkstreamPhase, WorkstreamBrief, DesignDoc,
    RunbookTask, AgentRegistration,
)
from .store import WorkstreamStore
from .warehouse import ContextWarehouse
from .slicer import ContextSlicer, ContextSlice
from .telemetry import TelemetryCollector, TelemetryEvent, TelemetryEventType

from hester.daemon.tasks.store import TaskStore
from hester.daemon.tasks.models import Task, TaskStatus
from hester.context.service import ContextBundleService

logger = logging.getLogger("hester.workstream.orchestrator")


class WorkstreamOrchestrator:
    """
    Orchestrates Workstream lifecycle and agent coordination.

    Responsibilities:
    - Phase transitions
    - Task dispatching with context slicing
    - Agent management
    - Proactive suggestions
    """

    def __init__(
        self,
        ws_store: WorkstreamStore,
        task_store: TaskStore,
        bundle_service: ContextBundleService,
        telemetry: TelemetryCollector,
    ):
        self.ws_store = ws_store
        self.task_store = task_store
        self.bundles = bundle_service
        self.telemetry = telemetry

    # ─────────────────────────────────────────────────────────────
    # Workstream Creation
    # ─────────────────────────────────────────────────────────────

    async def create_workstream(
        self,
        title: str,
        objective: str,
        rationale: str = "",
    ) -> Workstream:
        """Create a new Workstream in Exploration phase."""
        ws = Workstream(
            title=title,
            phase=WorkstreamPhase.EXPLORATION,
            brief=WorkstreamBrief(
                objective=objective,
                rationale=rationale,
            ),
        )

        await self.ws_store.create(ws)
        logger.info(f"Created Workstream: {ws.id} - {title}")

        return ws

    async def promote_from_idea(
        self,
        session_id: str,
        title: str,
        objective: str,
    ) -> Workstream:
        """
        Promote an idea from a chat session to a Workstream.

        Links the conversation history for context.
        """
        ws = Workstream(
            title=title,
            phase=WorkstreamPhase.EXPLORATION,
            brief=WorkstreamBrief(
                objective=objective,
                conversation_id=session_id,
            ),
        )

        await self.ws_store.create(ws)
        logger.info(f"Promoted idea to Workstream: {ws.id}")

        return ws

    # ─────────────────────────────────────────────────────────────
    # Phase: Exploration → Design
    # ─────────────────────────────────────────────────────────────

    async def finalize_brief(
        self,
        workstream_id: str,
        constraints: List[str] = None,
        out_of_scope: List[str] = None,
    ) -> Workstream:
        """Finalize the brief and transition to Design phase."""
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        if ws.brief:
            if constraints:
                ws.brief.constraints = constraints
            if out_of_scope:
                ws.brief.out_of_scope = out_of_scope

        ws.phase = WorkstreamPhase.DESIGN
        ws.updated_at = datetime.utcnow()

        await self.ws_store.save(ws)
        logger.info(f"Workstream {workstream_id} transitioned to DESIGN phase")

        return ws

    # ─────────────────────────────────────────────────────────────
    # Phase: Design (Grounding & Validation)
    # ─────────────────────────────────────────────────────────────

    async def perform_grounding(
        self,
        workstream_id: str,
        file_patterns: List[str],
        grep_patterns: List[str],
        db_tables: List[str],
    ) -> str:
        """
        Perform codebase grounding for Design phase.

        Creates a context bundle with relevant code analysis.
        Returns the bundle ID.
        """
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        warehouse = ContextWarehouse(workstream_id, self.bundles, self.ws_store)
        bundle_id = await warehouse.create_grounding_bundle(
            name="grounding",
            file_patterns=file_patterns,
            grep_patterns=grep_patterns,
            db_tables=db_tables,
        )

        # Update design doc grounding
        if not ws.design_doc:
            ws.design_doc = DesignDoc(summary="")

        ws.design_doc.grounding = {
            "bundle_id": bundle_id,
            "file_patterns": file_patterns,
            "grep_patterns": grep_patterns,
            "db_tables": db_tables,
            "performed_at": datetime.utcnow().isoformat(),
        }

        await self.ws_store.save(ws)

        return bundle_id

    async def add_research(
        self,
        workstream_id: str,
        finding: Dict[str, str],
    ) -> None:
        """
        Add web research finding to Design phase.

        finding: {title, source, summary}
        """
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        if not ws.design_doc:
            ws.design_doc = DesignDoc(summary="")

        ws.design_doc.research.append(finding)
        ws.updated_at = datetime.utcnow()

        await self.ws_store.save(ws)

    async def record_decision(
        self,
        workstream_id: str,
        question: str,
        decision: str,
        rationale: str,
        alternatives: List[str] = None,
        risks: List[str] = None,
    ) -> None:
        """Record a design decision."""
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        if not ws.design_doc:
            ws.design_doc = DesignDoc(summary="")

        from .models import DesignDecision
        ws.design_doc.decisions.append(DesignDecision(
            question=question,
            decision=decision,
            rationale=rationale,
            alternatives=alternatives or [],
            risks=risks or [],
        ))

        await self.ws_store.save(ws)

    async def finalize_design(
        self,
        workstream_id: str,
        summary: str,
        architecture_notes: str = "",
    ) -> Workstream:
        """Finalize design and transition to Planning phase."""
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        if ws.design_doc:
            ws.design_doc.summary = summary
            ws.design_doc.architecture_notes = architecture_notes
            ws.design_doc.validated_at = datetime.utcnow()

        ws.phase = WorkstreamPhase.PLANNING
        await self.ws_store.save(ws)

        logger.info(f"Workstream {workstream_id} transitioned to PLANNING phase")
        return ws

    # ─────────────────────────────────────────────────────────────
    # Phase: Planning (Runbook Creation)
    # ─────────────────────────────────────────────────────────────

    async def add_runbook_task(
        self,
        workstream_id: str,
        title: str,
        goal: str,
        dependencies: List[str] = None,
        suggested_by: str = "user",
    ) -> RunbookTask:
        """
        Add a task to the Runbook.

        Creates the underlying Task and links it to the Workstream.
        """
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        # Create the actual Task
        task = Task(title=title, goal=goal)
        await self.task_store.save(task)

        # Create Runbook entry
        runbook_task = RunbookTask(
            task_id=task.id,
            title=title,
            dependencies=dependencies or [],
            suggested_by=suggested_by,
        )

        ws.runbook.add_task(runbook_task)
        await self.ws_store.save(ws)

        return runbook_task

    async def generate_runbook_from_design(
        self,
        workstream_id: str,
    ) -> List[RunbookTask]:
        """
        Auto-generate Runbook tasks from the Design Doc.

        Uses Gemini to decompose the design into actionable tasks.
        """
        ws = await self.ws_store.get(workstream_id)
        if not ws or not ws.design_doc:
            raise ValueError("Workstream or Design Doc not found")

        import google.generativeai as genai

        prompt = f"""Given this Design Doc, generate a list of implementation tasks.

Brief:
{ws.brief.objective if ws.brief else 'No brief'}

Design Summary:
{ws.design_doc.summary}

Architecture Notes:
{ws.design_doc.architecture_notes}

Decisions:
{chr(10).join(f"- {d.decision}" for d in ws.design_doc.decisions)}

---

Generate 5-15 concrete, actionable tasks in order of execution.
Consider dependencies between tasks.

Output JSON:
{{
    "tasks": [
        {{
            "title": "Short task title",
            "goal": "What this task accomplishes",
            "dependencies": []  // titles of tasks this depends on
        }},
        ...
    ]
}}
"""

        model = genai.GenerativeModel("gemini-2.0-flash")
        response = await model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"},
        )

        import json
        result = json.loads(response.text)

        # Create tasks and build dependency map
        task_id_map = {}  # title -> task_id
        runbook_tasks = []

        for task_def in result.get("tasks", []):
            # Create Task
            task = Task(
                title=task_def["title"],
                goal=task_def["goal"],
            )
            await self.task_store.save(task)
            task_id_map[task_def["title"]] = task.id

            runbook_tasks.append({
                "task": task,
                "title": task_def["title"],
                "dependencies": task_def.get("dependencies", []),
            })

        # Resolve dependencies and add to Runbook
        for rt in runbook_tasks:
            dep_ids = [
                task_id_map[dep_title]
                for dep_title in rt["dependencies"]
                if dep_title in task_id_map
            ]

            runbook_task = RunbookTask(
                task_id=rt["task"].id,
                title=rt["title"],
                dependencies=dep_ids,
                suggested_by="hester",
            )
            ws.runbook.add_task(runbook_task)

        await self.ws_store.save(ws)

        return ws.runbook.tasks

    async def finalize_planning(
        self,
        workstream_id: str,
    ) -> Workstream:
        """Finalize planning and transition to Execution phase."""
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            raise ValueError(f"Workstream not found: {workstream_id}")

        ws.phase = WorkstreamPhase.EXECUTION
        await self.ws_store.save(ws)

        logger.info(f"Workstream {workstream_id} transitioned to EXECUTION phase")
        return ws

    # ─────────────────────────────────────────────────────────────
    # Phase: Execution
    # ─────────────────────────────────────────────────────────────

    async def get_next_task(
        self,
        workstream_id: str,
    ) -> Optional[RunbookTask]:
        """Get the next ready task from the Runbook."""
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            return None

        ready_tasks = ws.runbook.get_ready_tasks(ws.completed_task_ids)
        if not ready_tasks:
            return None

        # Return highest priority (lowest number)
        return min(ready_tasks, key=lambda t: t.priority)

    async def slice_context_for_task(
        self,
        workstream_id: str,
        task_id: str,
    ) -> ContextSlice:
        """Generate a context slice for a specific task."""
        ws = await self.ws_store.get(workstream_id)
        task = await self.task_store.get(task_id)

        if not ws or not task:
            raise ValueError("Workstream or Task not found")

        warehouse = ContextWarehouse(workstream_id, self.bundles, self.ws_store)
        slicer = ContextSlicer(warehouse)

        slice_obj = await slicer.slice_for_task(
            task_id=task_id,
            task_title=task.title,
            task_goal=task.goal,
            task_steps=[b.title for b in task.batches],
        )

        # Store the slice
        await self.ws_store.store_slice(workstream_id, slice_obj.id, slice_obj.content)

        # Update runbook task with slice reference
        for rt in ws.runbook.tasks:
            if rt.task_id == task_id:
                rt.context_slice = slice_obj.id
                break

        await self.ws_store.save(ws)

        return slice_obj

    async def dispatch_task(
        self,
        workstream_id: str,
        task_id: str,
        agent_id: str,
        agent_type: str,
    ) -> Dict[str, Any]:
        """
        Dispatch a task to an agent with sliced context.

        Returns dispatch info including context slice and hook config.
        """
        ws = await self.ws_store.get(workstream_id)
        task = await self.task_store.get(task_id)

        if not ws or not task:
            raise ValueError("Workstream or Task not found")

        # Slice context
        context_slice = await self.slice_context_for_task(workstream_id, task_id)

        # Register agent
        agent = AgentRegistration(
            agent_id=agent_id,
            agent_type=agent_type,
            current_task_id=task_id,
            status="active",
        )
        ws.register_agent(agent)

        # Update task status
        task.status = TaskStatus.EXECUTING
        await self.task_store.save(task)

        # Record telemetry
        await self.telemetry.record(TelemetryEvent(
            workstream_id=workstream_id,
            agent_id=agent_id,
            agent_type=agent_type,
            task_id=task_id,
            event_type=TelemetryEventType.TASK_STARTED,
        ))

        await self.ws_store.save(ws)

        # Generate hook config for Claude Code
        from .hooks import generate_hook_config
        hook_config = generate_hook_config(workstream_id, agent_id)

        return {
            "task": task.model_dump(),
            "context": context_slice.content,
            "context_slice_id": context_slice.id,
            "hook_config": hook_config,
            "workstream_id": workstream_id,
        }

    async def complete_task(
        self,
        workstream_id: str,
        task_id: str,
        success: bool = True,
        output: str = "",
    ) -> None:
        """Mark a task as completed."""
        ws = await self.ws_store.get(workstream_id)
        task = await self.task_store.get(task_id)

        if not ws or not task:
            raise ValueError("Workstream or Task not found")

        task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
        await self.task_store.save(task)

        if success:
            ws.completed_task_ids.append(task_id)

        # Update agent status
        for agent in ws.agents:
            if agent.current_task_id == task_id:
                agent.status = "completed" if success else "failed"
                agent.current_task_id = None

        # Record telemetry
        await self.telemetry.record(TelemetryEvent(
            workstream_id=workstream_id,
            agent_id="",  # Will be filled from agent registry
            agent_type="",
            task_id=task_id,
            event_type=TelemetryEventType.TASK_COMPLETED if success else TelemetryEventType.TASK_FAILED,
        ))

        await self.ws_store.save(ws)

        # Check if all tasks complete
        await self._check_workstream_completion(workstream_id)

    async def _check_workstream_completion(
        self,
        workstream_id: str,
    ) -> None:
        """Check if Workstream is complete and transition to Review."""
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            return

        all_task_ids = [t.task_id for t in ws.runbook.tasks]
        if all(tid in ws.completed_task_ids for tid in all_task_ids):
            ws.phase = WorkstreamPhase.REVIEW
            await self.ws_store.save(ws)
            logger.info(f"Workstream {workstream_id} transitioned to REVIEW phase")

    # ─────────────────────────────────────────────────────────────
    # Proactive Suggestions
    # ─────────────────────────────────────────────────────────────

    async def suggest_follow_up_tasks(
        self,
        workstream_id: str,
        completed_task_id: str,
        task_output: str,
    ) -> List[Dict[str, str]]:
        """
        Analyze task output and suggest follow-up tasks.

        Called after each task completion to dynamically update the Runbook.
        """
        ws = await self.ws_store.get(workstream_id)
        if not ws:
            return []

        import google.generativeai as genai

        prompt = f"""A task in a development workflow just completed. Analyze the output and suggest follow-up tasks.

Workstream Objective:
{ws.brief.objective if ws.brief else 'Unknown'}

Completed Task:
{completed_task_id}

Task Output:
{task_output[:2000]}

Existing Runbook Tasks:
{chr(10).join(f"- {t.title}" for t in ws.runbook.tasks)}

---

Based on the output, suggest 0-3 follow-up tasks that should be added.
Consider:
- Tests that should be written
- Documentation that should be updated
- Edge cases that should be handled
- Integration points that need attention

Output JSON:
{{
    "suggestions": [
        {{
            "title": "Task title",
            "goal": "What this accomplishes",
            "rationale": "Why this is needed based on the output"
        }}
    ]
}}

Return empty suggestions array if no follow-up is needed.
"""

        model = genai.GenerativeModel("gemini-2.0-flash")
        response = await model.generate_content_async(
            prompt,
            generation_config={"response_mime_type": "application/json"},
        )

        import json
        result = json.loads(response.text)

        return result.get("suggestions", [])
```

---

## 6. Lee UI Integration

### 6.1 Workstream as Command Center

The Workstream UI is a **dedicated dashboard tab** that provides a centralized control point for complex work. Regular tabs (editors, terminals, etc.) remain in the normal tab bar—the Workstream doesn't try to own or reorganize them.

```
┌─────────────────────────────────────────────────────────────────────┐
│  WORKSTREAM: Authentication Refactor                    [EXECUTION] │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  BRIEF                                                              │
│  Implement token refresh with sliding window expiry.                │
│  Constraints: No breaking changes to existing JWT flow.             │
│                                                                     │
├───────────────────────────────────┬─────────────────────────────────┤
│  RUNBOOK                          │  AGENTS                         │
│  ┌─ [✓] Research auth patterns    │                                 │
│  ├─ [✓] Design token refresh      │  Claude: Writing tests... 🔨    │
│  ├─ [→] Implement refresh logic   │    └─ test_auth.py:42           │
│  │      ├─ Add refresh endpoint   │    └─ Tool: Edit                │
│  │      └─ Update token service   │                                 │
│  └─ [ ] Write integration tests   │  Hester: Idle                   │
│                                   │                                 │
├───────────────────────────────────┴─────────────────────────────────┤
│  CONTEXT WAREHOUSE                                                  │
│  [auth-system] [jwt-research] [token-schema]        [+ Add Bundle]  │
│                                                                     │
│  Files: services/api/src/auth.py, shared/auth/tokens.py (+3 more)   │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Principles:**
- One Workstream tab open at a time (or docked as side panel)
- Regular editor/terminal tabs stay in normal tab bar
- Workstream is a dashboard for visibility, not a container for tabs
- Spawning Claude/Hester while Workstream is visible auto-inherits context

### 6.2 Workstream Tab Components

```typescript
// lee/electron/src/renderer/components/WorkstreamTab.tsx

interface WorkstreamTabProps {
  workstreamId: string;
}

// Three-panel layout:
// 1. Header: Title, phase badge, phase transition controls
// 2. Main area (two columns):
//    - Left: Runbook with task tree and progress
//    - Right: Active agents with live telemetry
// 3. Footer: Context Warehouse (bundles, files, notes)
```

**Header Section:**
- Workstream title (editable)
- Phase badge: `[EXPLORATION]` `[DESIGN]` `[PLANNING]` `[EXECUTION]` `[REVIEW]` `[DONE]`
- Phase transition button (→ next phase)
- Pause/Resume toggle

**Runbook Panel (Left):**
- Tree view of tasks with dependencies
- Status icons: `[ ]` pending, `[→]` in progress, `[✓]` complete, `[✗]` failed
- Click task to see details, assign to agent
- "Add Task" button for manual additions
- Progress bar at top

**Agents Panel (Right):**
- List of registered agents (Claude Code, Hester subagents)
- Per-agent: status, current task, active file, current tool
- Live updates via SSE from `/workstream/{id}/telemetry/stream`
- Click agent to see recent activity log

**Context Warehouse (Footer):**
- Horizontal list of context bundle chips
- "Add Bundle" button opens bundle picker
- Expandable file list
- "View Full Context" to see concatenated warehouse

### 6.3 Context Inheritance for Agents

When Claude/Hester is spawned while a Workstream tab is focused (or from within the Workstream tab), context flows automatically:

```typescript
// lee/electron/src/renderer/components/WorkstreamTab.tsx

function handleSpawnAgent(agentType: 'claude' | 'hester') {
  // Dispatch task to get sliced context
  const dispatch = await fetch(`/workstream/${wsId}/dispatch/${taskId}`, {
    method: 'POST',
    body: JSON.stringify({ agent_type: agentType }),
  });

  const { context, hook_config } = await dispatch.json();

  // Spawn agent with context injected
  if (agentType === 'claude') {
    // Write hook config to .claude/settings.local.json
    // Write context to .claude/workstream-context.md
    spawnClaudeCode({
      env: { WORKSTREAM_ID: wsId },
      initialPrompt: `Context loaded from Workstream. Task: ${taskTitle}`,
    });
  } else {
    spawnHester({
      args: ['--workstream', wsId, '--task', taskId],
    });
  }
}
```

### 6.4 Workstream Picker

Access Workstreams via:
- Keyboard shortcut: `Cmd+Shift+W` opens Workstream picker
- Command Palette: "Open Workstream..."
- Tab bar: Workstream icon shows active count badge

```typescript
// lee/electron/src/renderer/components/WorkstreamPicker.tsx

// Modal with:
// - List of active Workstreams (sorted by last activity)
// - Phase indicators
// - "Create New Workstream" button
// - Quick filter/search
```

### 6.5 Real-time Telemetry Display

```typescript
// lee/electron/src/renderer/components/AgentTelemetryPanel.tsx

interface AgentTelemetryPanelProps {
  workstreamId: string;
}

// Subscribes to SSE: /workstream/{id}/telemetry/stream
// Displays:
// - Agent cards with live status
// - Current tool being called
// - Active file with line number
// - Mini activity log (last 5 actions)
// - Progress indicator if available
```

### 6.6 API Endpoints

All Workstream endpoints are added to the existing Hester daemon (port 9000):

```python
# lee/hester/daemon/workstream/routes.py
# Registered in daemon/main.py: app.include_router(workstream_router)

from fastapi import APIRouter, Depends
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/workstream", tags=["workstream"])

# ─────────────────────────────────────────────────────────────
# CRUD Operations
# ─────────────────────────────────────────────────────────────

@router.post("/")
async def create_workstream(title: str, objective: str): ...

@router.get("/{ws_id}")
async def get_workstream(ws_id: str): ...

@router.get("/")
async def list_workstreams(phase: Optional[str] = None): ...

@router.delete("/{ws_id}")
async def delete_workstream(ws_id: str): ...

# ─────────────────────────────────────────────────────────────
# Phase Transitions
# ─────────────────────────────────────────────────────────────

@router.post("/{ws_id}/phase/design")
async def transition_to_design(ws_id: str, constraints: List[str] = None): ...

@router.post("/{ws_id}/phase/planning")
async def transition_to_planning(ws_id: str, summary: str, architecture_notes: str = ""): ...

@router.post("/{ws_id}/phase/execution")
async def transition_to_execution(ws_id: str): ...

@router.post("/{ws_id}/phase/review")
async def transition_to_review(ws_id: str): ...

@router.post("/{ws_id}/phase/done")
async def transition_to_done(ws_id: str): ...

# ─────────────────────────────────────────────────────────────
# Design Phase Operations
# ─────────────────────────────────────────────────────────────

@router.post("/{ws_id}/design/grounding")
async def perform_grounding(
    ws_id: str,
    file_patterns: List[str],
    grep_patterns: List[str] = None,
    db_tables: List[str] = None,
): ...

@router.post("/{ws_id}/design/research")
async def add_research(ws_id: str, finding: Dict[str, str]): ...

@router.post("/{ws_id}/design/decision")
async def record_decision(
    ws_id: str,
    question: str,
    decision: str,
    rationale: str,
    alternatives: List[str] = None,
): ...

# ─────────────────────────────────────────────────────────────
# Runbook Management
# ─────────────────────────────────────────────────────────────

@router.post("/{ws_id}/runbook/tasks")
async def add_runbook_task(
    ws_id: str,
    title: str,
    goal: str,
    dependencies: List[str] = None,
): ...

@router.post("/{ws_id}/runbook/generate")
async def generate_runbook_from_design(ws_id: str): ...

@router.get("/{ws_id}/runbook")
async def get_runbook(ws_id: str): ...

@router.delete("/{ws_id}/runbook/tasks/{task_id}")
async def remove_runbook_task(ws_id: str, task_id: str): ...

# ─────────────────────────────────────────────────────────────
# Task Dispatch & Execution
# ─────────────────────────────────────────────────────────────

@router.get("/{ws_id}/next-task")
async def get_next_task(ws_id: str): ...

@router.post("/{ws_id}/dispatch/{task_id}")
async def dispatch_task(
    ws_id: str,
    task_id: str,
    agent_type: str = "claude_code",
): ...
"""Returns: task details, sliced context, hook configuration"""

@router.post("/{ws_id}/complete/{task_id}")
async def complete_task(
    ws_id: str,
    task_id: str,
    success: bool = True,
    output: str = "",
): ...

# ─────────────────────────────────────────────────────────────
# Telemetry (extends existing /orchestrate/* endpoints)
# ─────────────────────────────────────────────────────────────

@router.get("/{ws_id}/telemetry/stream")
async def stream_workstream_telemetry(ws_id: str):
    """SSE stream filtered to this Workstream's agents."""
    ...

@router.get("/{ws_id}/telemetry/events")
async def get_workstream_events(ws_id: str, limit: int = 100):
    """Get event history from Redis."""
    ...

@router.get("/{ws_id}/agents")
async def get_workstream_agents(ws_id: str):
    """Get active agents for this Workstream (wraps /orchestrate/sessions?workstream_id=)."""
    ...

# ─────────────────────────────────────────────────────────────
# Context Warehouse
# ─────────────────────────────────────────────────────────────

@router.get("/{ws_id}/warehouse")
async def get_warehouse(ws_id: str):
    """Get warehouse contents (bundles, files, notes)."""
    ...

@router.post("/{ws_id}/warehouse/bundle")
async def add_warehouse_bundle(ws_id: str, bundle_id: str): ...

@router.get("/{ws_id}/warehouse/full")
async def get_full_warehouse_context(ws_id: str):
    """Get concatenated warehouse content."""
    ...

# ─────────────────────────────────────────────────────────────
# Context Slicing
# ─────────────────────────────────────────────────────────────

@router.post("/{ws_id}/slice/{task_id}")
async def create_context_slice(ws_id: str, task_id: str):
    """Generate a context slice for a task."""
    ...

@router.get("/{ws_id}/slices/{slice_id}")
async def get_context_slice(ws_id: str, slice_id: str): ...
```

### 6.7 Integration with Existing Endpoints

The Workstream system integrates with existing Hester daemon endpoints:

| Existing Endpoint | Workstream Usage |
|-------------------|------------------|
| `POST /orchestrate/telemetry` | Agents report status with `workstream_id` in metadata |
| `GET /orchestrate/sessions` | Query with `?workstream_id=ws-xxx` filter |
| `POST /context/stream` | Hester chat for Exploration phase |
| `/session/*` | Track conversation sessions linked to Workstreams |

---

## 7. Implementation Phases

### Phase 1: Foundation ✅ COMPLETE
- [x] Data models (`models.py`) — all Pydantic models with YAML/markdown serialization
- [x] File-based store (`store.py`) — directory-per-workstream with separate artifact files
- [x] Context Warehouse (`warehouse.py`) — bundle/file/notes aggregation
- [x] Context Slicer (`slicer.py`) — models, limits, depth escalation (Gemini stubbed)
- [x] Telemetry events (`telemetry.py`) — WorkstreamEvent model
- [x] Claude Code hooks (`hooks.py`) — full hook generation and setup
- [x] Orchestrator (`orchestrator.py`) — phase transitions, runbook management, auto-review
- [x] HTTP routes (`routes.py`) — APIRouter with all CRUD/phase/runbook/warehouse endpoints
- [x] CLI commands (`cli/workstream.py`) — full Click surface with Rich output
- [x] Module exports (`__init__.py`) — all public API
- [x] 93 tests passing

### Phase 2: Gemini Integration ✅
- [x] Gemini helper module (`gemini.py`) — modern SDK, JSON mode, ThinkingConfig
- [x] Context Slicer: wire `slice_for_task()` to Gemini 3 Flash for intelligent extraction
- [x] Runbook auto-generation: `generate_runbook_from_design()` with Gemini
- [x] Proactive follow-up suggestions: `suggest_follow_up_tasks()` with Gemini
- [x] Prompt templates embedded as class constants in orchestrator
- [x] 25 new tests (118 total)

### Phase 3: Daemon Integration ✅
- [x] Mount workstream router in `daemon/main.py` via `app.include_router()` in lifespan
- [x] Wire WorkstreamStore from working directory + bundle_service from `app_state`
- [x] Extend `AgentTelemetry` model with `task_id`, `batch_id`, `recent_tools`, `files_touched`
- [x] Add `record_tool_use()` method with 20-tool rolling window
- [x] Workstream-filtered agent session queries (`?workstream_id=`) — already existed
- [x] Bridge agent telemetry to workstream JSONL on update/complete
- [ ] Redis TelemetryStore for fast event queries (deferred, JSONL works)

### Phase 4: End-to-End Dispatch ✅
- [x] Task dispatch with context slicing (`dispatch_task()` → `slice_context_for_task()`)
- [x] Route endpoints: `POST /runbook/generate`, `POST /dispatch/{task_id}`, `POST /suggest-follow-ups/{task_id}`
- [x] GET `/{ws_id}/telemetry` endpoint for workstream events
- [x] 17 new tests (135 total)
- [ ] Internal agent telemetry helper (`InternalAgentTelemetry`) — deferred
- [ ] Event bus for cross-component coordination — deferred
- [ ] SSE telemetry streaming endpoint — deferred

### Phase 5: Lee UI ✅ (core) / deferred (advanced)
- [x] WorkstreamPane component (command center dashboard)
  - [x] PhaseBar — title, phase badge (colored pill), task progress, contextual transition buttons
  - [x] RunbookPanel — task list with computed status (completed/ready/blocked/in_progress), dispatch inline, complete, add task, generate from design
  - [x] AgentPanel — live agent telemetry cards with status dot, tool/file info, recent tools chips, time-ago
  - [x] WarehouseBar — bundle chips (scrollable), add bundle inline, file count
- [x] WorkstreamPickerModal (`Cmd+Shift+W`)
  - [x] List workstreams with phase badge, title, task progress, relative time
  - [x] Create new Workstream (title + objective)
  - [x] Inline search/filter
- [x] Tab registration wiring
  - [x] `TabType` union, `NEW_TAB_OPTIONS`, `TAB_ICONS`, `nonPtyTabs`, `renderTab`, `getDefaultLabel`
  - [x] `workstreamId` on `TabData` — multiple workstream tabs supported, one per workstream
  - [x] Hotkey: `Cmd+Shift+W` opens picker (not tab directly)
- [x] TypeScript types (`workstream/types.ts`)
  - [x] All backend model interfaces mirrored
  - [x] `PHASE_CONFIG` with labels, colors, icons, next-phase mapping
  - [x] `resolveTasks()` — client-side status computation from completed IDs + agent sessions
- [x] CSS styles (~350 lines, `ws-` / `ws-picker-` prefixes, dark theme)
- [x] Build verification — TypeScript compiles cleanly

**Files created:**
```
src/renderer/components/workstream/types.ts          # TS interfaces + resolveTasks()
src/renderer/components/workstream/WorkstreamPane.tsx # Main composition (fetch + poll + compose)
src/renderer/components/workstream/PhaseBar.tsx       # Phase header + transitions
src/renderer/components/workstream/RunbookPanel.tsx   # Task list + dispatch/complete
src/renderer/components/workstream/AgentPanel.tsx     # Agent telemetry cards
src/renderer/components/workstream/WarehouseBar.tsx   # Bundle footer
src/renderer/components/WorkstreamPickerModal.tsx     # Picker overlay
```

**Files modified:** `context.ts`, `TabBar.tsx`, `App.tsx`, `styles/index.css`

**Data flow:**
- Polling: 3s for agent sessions (when tab active), re-fetch all on mutations
- All API calls target Hester daemon at `http://127.0.0.1:9000/workstream/`

**Deferred to Phase 5b:**
- [ ] Context inheritance for spawned agents
  - [ ] Detect active Workstream on PTY spawn
  - [ ] Inject context via dispatch API
  - [ ] Write hook config for Claude Code
- [ ] Real-time telemetry via SSE (currently polling; requires `sse-starlette` on backend)
- [ ] Session persistence — `workstreamId` on tab restore from localStorage

---

## 8. File Structure

### Backend (Hester daemon)
```
lee/hester/daemon/workstream/
├── __init__.py         # Public exports
├── models.py           # Workstream, Brief, DesignDoc, Runbook, AgentRegistration
├── store.py            # WorkstreamStore (file-based YAML/MD/JSONL)
├── warehouse.py        # ContextWarehouse (bundle + file aggregation)
├── slicer.py           # ContextSlicer (Gemini-powered context extraction)
├── gemini.py           # Shared Gemini SDK helper (generate_json, generate_text)
├── telemetry.py        # TelemetryEvent, TelemetryCollector
├── hooks.py            # Claude Code hook integration
├── orchestrator.py     # WorkstreamOrchestrator (lifecycle + Gemini endpoints)
└── routes.py           # FastAPI router factory (CRUD + phase + dispatch)

tests/unit/
├── test_workstream_models.py       # Model serialization, phase transitions
├── test_workstream_store.py        # File-based store CRUD, concurrency
├── test_workstream_warehouse.py    # Context aggregation, token counting
├── test_workstream_slicer.py       # Context slicing, depth escalation
├── test_workstream_telemetry.py    # Event collection, JSONL persistence
├── test_workstream_hooks.py        # Hook stdin/stdout protocol
├── test_workstream_orchestrator.py # Lifecycle, task management
├── test_workstream_routes.py       # HTTP endpoint behavior
├── test_workstream_gemini.py       # Gemini helper, runbook gen, dispatch
└── test_workstream_integration.py  # Telemetry bridging, router factory
```

### Frontend (Lee Electron)
```
lee/electron/src/renderer/components/
├── WorkstreamPickerModal.tsx           # Picker overlay (list/create/search)
└── workstream/
    ├── types.ts                        # TS interfaces, PHASE_CONFIG, resolveTasks()
    ├── WorkstreamPane.tsx              # Main composition + data fetching + polling
    ├── PhaseBar.tsx                    # Title, phase badge, transition buttons
    ├── RunbookPanel.tsx                # Task list, dispatch, complete, add, generate
    ├── AgentPanel.tsx                  # Agent telemetry cards
    └── WarehouseBar.tsx                # Bundle chips, file count
```

Modified: `context.ts` (TabType), `TabBar.tsx` (options/icons), `App.tsx` (routing/hotkeys/modal), `styles/index.css` (ws-* styles)

---

## 9. Open Questions

1. **~~Claude Code Hook Format~~** (RESOLVED): ✅ Hooks receive JSON via stdin, not env vars
   - Input: `{"session_id", "hook_event_name", "tool_name", "tool_input", ...}`
   - Output: `{"continue": true}` to proceed
   - Environment: `$CLAUDE_PROJECT_DIR` for project path
   - Solution: Python script parses stdin and forwards to `/orchestrate/telemetry`

2. **~~Context Size Limits~~** (RESOLVED): ✅ Implemented in `slicer.py`
   - Claude Code: 100K tokens
   - Hester LOCAL: 4K, DEEPLOCAL: 6K, QUICK: 20K, STANDARD: 50K, DEEP: 100K, PRO: 150K
   - Automatic depth escalation when context exceeds tier limits

3. **Multi-Agent Coordination**: If two Claude Code instances work on the same Workstream, how do we prevent conflicts?
   - Option A: Lock files at dispatch time
   - Option B: Use Runbook dependencies to serialize related tasks
   - Option C: Accept conflicts and let review phase catch issues

4. **~~Persistence vs. TTL~~** (RESOLVED): ✅ File-first storage, no TTL
   - Workstreams are persisted as files in `.hester/workstreams/`, no TTL concerns
   - Redis cache (when added) can use TTL for fast queries, files remain authoritative

5. **Design Phase Automation**: How much of the Design phase should be automated vs. user-driven?
   - Grounding could be fully automated (heuristic file pattern matching)
   - Decisions should require user confirmation
   - Research could be suggested but user-approved

6. **~~Telemetry Infrastructure~~** (RESOLVED): ✅ Using existing daemon infrastructure
   - Extends `/orchestrate/telemetry` endpoint
   - Adds `workstream_id` to existing `AgentTelemetry` model
   - JSONL for event history (file-first), Redis store deferred to Phase 3

7. **~~UI Paradigm~~** (RESOLVED + IMPLEMENTED): ✅ Workstream as Command Center
   - Workstream is a **dedicated non-PTY dashboard tab** (same pattern as LibraryPane)
   - Multiple workstream tabs can be open simultaneously, each tracking a different `workstreamId`
   - Dashboard layout: PhaseBar (top) → RunbookPanel (left 320px) + AgentPanel (right flex) → WarehouseBar (bottom)
   - `Cmd+Shift+W` opens WorkstreamPickerModal (list/create/search), not a tab directly
   - Picker checks for existing tab with matching workstreamId before creating new
   - Agent polling: 3s interval when tab active, stops when inactive
   - All mutations re-fetch relevant data after success
   - Deferred: context inheritance on PTY spawn, SSE telemetry, session persistence

8. **~~Storage Strategy~~** (RESOLVED): ✅ File-first, Redis cache
   - Spec originally proposed Redis-first with 7-day TTL
   - Implementation uses file-first (`.hester/workstreams/{ws-id}/`) with directory-per-workstream
   - Follows existing task system patterns (YAML/markdown serialization)
   - Redis serves as optional cache for fast daemon queries, not source of truth
