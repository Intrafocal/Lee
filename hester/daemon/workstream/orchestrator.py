"""
Workstream Orchestrator - Business logic for phase transitions and task coordination.

The orchestrator mediates all state changes for a workstream, enforcing phase
guards, managing artifacts, and coordinating agent dispatch.
"""

import uuid
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from .models import (
    Workstream,
    WorkstreamPhase,
    WorkstreamBrief,
    DesignDecision,
    DesignDoc,
    Runbook,
    RunbookTask,
    AgentRegistration,
    NEXT_PHASE,
)
from .store import WorkstreamStore
from .telemetry import WorkstreamEvent

logger = logging.getLogger("hester.daemon.workstream.orchestrator")


class WorkstreamOrchestrator:
    """Coordinates workstream lifecycle, phase transitions, and task dispatch."""

    def __init__(
        self,
        ws_store: WorkstreamStore,
        task_store: Any = None,  # TaskStore from daemon.tasks
        bundle_service: Any = None,  # ContextBundleService
    ):
        self.ws_store = ws_store
        self.task_store = task_store
        self.bundle_service = bundle_service

    # ── Creation ──────────────────────────────────────────────

    async def create_workstream(
        self,
        title: str,
        objective: str = "",
        rationale: str = "",
    ) -> Workstream:
        """Create a new workstream in EXPLORATION phase."""
        brief = WorkstreamBrief(objective=objective, rationale=rationale)
        ws = Workstream(title=title, brief=brief)
        self.ws_store.create(ws)
        self.ws_store.save_brief(ws.id, brief)
        logger.info(f"Created workstream: {ws.id} - {title}")
        return ws

    async def promote_from_idea(
        self,
        session_id: str,
        title: str,
        objective: str = "",
    ) -> Workstream:
        """Create a workstream from a conversation session."""
        brief = WorkstreamBrief(
            objective=objective,
            conversation_id=session_id,
        )
        ws = Workstream(title=title, brief=brief)
        self.ws_store.create(ws)
        self.ws_store.save_brief(ws.id, brief)
        logger.info(f"Promoted idea to workstream: {ws.id} from session {session_id}")
        return ws

    # ── Brief Management ──────────────────────────────────────

    async def update_brief(
        self,
        ws_id: str,
        objective: Optional[str] = None,
        rationale: Optional[str] = None,
        constraints: Optional[List[str]] = None,
        out_of_scope: Optional[List[str]] = None,
    ) -> Workstream:
        """Update brief fields on an existing workstream."""
        ws = self._load(ws_id)
        if ws.brief is None:
            ws.brief = WorkstreamBrief(objective="")

        if objective is not None:
            ws.brief.objective = objective
        if rationale is not None:
            ws.brief.rationale = rationale
        if constraints is not None:
            ws.brief.constraints = constraints
        if out_of_scope is not None:
            ws.brief.out_of_scope = out_of_scope

        self.ws_store.save_brief(ws.id, ws.brief)
        self.ws_store.save(ws)
        logger.info(f"Updated brief for workstream: {ws_id}")
        return ws

    # ── Phase Transitions ─────────────────────────────────────

    def _load(self, ws_id: str) -> Workstream:
        """Load workstream or raise."""
        ws = self.ws_store.get(ws_id)
        if not ws:
            raise ValueError(f"Workstream not found: {ws_id}")
        return ws

    async def finalize_brief(
        self,
        ws_id: str,
        constraints: Optional[List[str]] = None,
        out_of_scope: Optional[List[str]] = None,
    ) -> Workstream:
        """Finalize exploration and advance to DESIGN phase."""
        ws = self._load(ws_id)
        if ws.phase != WorkstreamPhase.EXPLORATION:
            raise ValueError(f"Workstream must be in EXPLORATION to finalize brief, got {ws.phase}")

        if ws.brief:
            if constraints:
                ws.brief.constraints = constraints
            if out_of_scope:
                ws.brief.out_of_scope = out_of_scope
            self.ws_store.save_brief(ws.id, ws.brief)

        ws.phase = WorkstreamPhase.DESIGN
        self.ws_store.save(ws)
        logger.info(f"Workstream {ws_id} advanced to DESIGN")
        return ws

    async def finalize_design(
        self,
        ws_id: str,
        summary: str = "",
        architecture_notes: str = "",
    ) -> Workstream:
        """Finalize design and advance to PLANNING phase."""
        ws = self._load(ws_id)
        if ws.phase != WorkstreamPhase.DESIGN:
            raise ValueError(f"Workstream must be in DESIGN to finalize design, got {ws.phase}")

        design = DesignDoc(
            summary=summary,
            architecture_notes=architecture_notes,
        )
        ws.design_doc = design
        self.ws_store.save_design(ws.id, design)

        ws.phase = WorkstreamPhase.PLANNING
        self.ws_store.save(ws)
        logger.info(f"Workstream {ws_id} advanced to PLANNING")
        return ws

    async def finalize_planning(self, ws_id: str) -> Workstream:
        """Finalize planning and advance to EXECUTION phase."""
        ws = self._load(ws_id)
        if ws.phase != WorkstreamPhase.PLANNING:
            raise ValueError(f"Workstream must be in PLANNING to finalize planning, got {ws.phase}")
        if not ws.runbook.tasks:
            raise ValueError("Cannot finalize planning with empty runbook")

        ws.phase = WorkstreamPhase.EXECUTION
        self.ws_store.save(ws)
        logger.info(f"Workstream {ws_id} advanced to EXECUTION")
        return ws

    async def advance_phase(self, ws_id: str) -> Workstream:
        """Advance to the next phase (generic, for routes)."""
        ws = self._load(ws_id)
        if ws.phase not in NEXT_PHASE:
            raise ValueError(f"Cannot advance from {ws.phase}")
        ws.phase = NEXT_PHASE[ws.phase]
        self.ws_store.save(ws)
        return ws

    async def pause(self, ws_id: str) -> Workstream:
        """Pause a workstream."""
        ws = self._load(ws_id)
        ws._previous_phase = ws.phase  # Store for resume
        ws.phase = WorkstreamPhase.PAUSED
        self.ws_store.save(ws)
        return ws

    async def resume(self, ws_id: str) -> Workstream:
        """Resume a paused workstream."""
        ws = self._load(ws_id)
        if ws.phase != WorkstreamPhase.PAUSED:
            raise ValueError("Workstream is not paused")
        # Default to EXPLORATION if no previous phase stored
        ws.phase = WorkstreamPhase.EXPLORATION
        self.ws_store.save(ws)
        return ws

    # ── Design Phase ──────────────────────────────────────────

    async def add_research(
        self,
        ws_id: str,
        title: str,
        source: str,
        summary: str,
    ) -> Workstream:
        """Add a research finding to the design doc."""
        ws = self._load(ws_id)
        if not ws.design_doc:
            ws.design_doc = DesignDoc(summary="")
        ws.design_doc.research.append({
            "title": title,
            "source": source,
            "summary": summary,
        })
        self.ws_store.save_design(ws.id, ws.design_doc)
        return ws

    async def record_decision(
        self,
        ws_id: str,
        question: str,
        decision: str,
        rationale: str,
        alternatives: Optional[List[str]] = None,
    ) -> Workstream:
        """Record a design decision."""
        ws = self._load(ws_id)
        if not ws.design_doc:
            ws.design_doc = DesignDoc(summary="")
        ws.design_doc.decisions.append(DesignDecision(
            question=question,
            decision=decision,
            rationale=rationale,
            alternatives=alternatives or [],
        ))
        self.ws_store.save_design(ws.id, ws.design_doc)
        return ws

    # ── Runbook Management ────────────────────────────────────

    async def add_runbook_task(
        self,
        ws_id: str,
        title: str,
        goal: str = "",
        dependencies: Optional[List[str]] = None,
        priority: int = 0,
    ) -> RunbookTask:
        """Add a task to the workstream's runbook."""
        ws = self._load(ws_id)
        task_id = f"task-{uuid.uuid4().hex[:8]}"

        rt = RunbookTask(
            task_id=task_id,
            title=title,
            dependencies=dependencies or [],
            priority=priority,
        )
        ws.runbook.add_task(rt)
        self.ws_store.save_runbook(ws.id, ws.runbook)
        return rt

    async def get_next_task(self, ws_id: str) -> Optional[RunbookTask]:
        """Get the next ready task from the runbook."""
        ws = self._load(ws_id)
        ready = ws.runbook.get_ready_tasks(ws.completed_task_ids)
        if not ready:
            return None
        # Return highest priority, or first if tied
        ready.sort(key=lambda t: t.priority, reverse=True)
        return ready[0]

    # ── Task Completion ───────────────────────────────────────

    async def complete_task(
        self,
        ws_id: str,
        task_id: str,
        success: bool = True,
        output: str = "",
    ) -> Workstream:
        """Mark a task as completed and check for phase transition."""
        ws = self._load(ws_id)
        if task_id not in ws.completed_task_ids:
            ws.completed_task_ids.append(task_id)

        # Check if all runbook tasks are completed
        all_task_ids = {t.task_id for t in ws.runbook.tasks}
        completed_ids = set(ws.completed_task_ids)
        if all_task_ids and all_task_ids.issubset(completed_ids):
            ws.phase = WorkstreamPhase.REVIEW
            logger.info(f"Workstream {ws_id} auto-transitioned to REVIEW (all tasks complete)")

        self.ws_store.save(ws)

        # Push telemetry
        self.ws_store.push_telemetry(ws_id, {
            "event_type": "task_completed",
            "task_id": task_id,
            "success": success,
        })

        return ws

    # ── Gemini-Powered Methods ─────────────────────────────────

    RUNBOOK_GENERATION_PROMPT = """You are a Technical Product Manager decomposing a design document into actionable development tasks.

WORKSTREAM: {title}
OBJECTIVE: {objective}

DESIGN DOCUMENT:
{design_content}

Decompose this design into concrete, actionable tasks. Each task should be:
- Small enough for a single agent session (1-4 hours of work)
- Have a clear goal and definition of done
- List dependencies on other tasks by their index (0-based)
- Have a priority (higher = more important, 0-100)

Output JSON:
{{
    "tasks": [
        {{
            "title": "Short descriptive title",
            "goal": "What this task accomplishes and definition of done",
            "dependencies": [],
            "priority": 80
        }}
    ],
    "rationale": "Why this decomposition and ordering"
}}

Order tasks so that foundational work comes first. Aim for 3-15 tasks."""

    FOLLOW_UP_PROMPT = """You are a Technical Product Manager reviewing completed task output to identify follow-up work.

WORKSTREAM: {title}
COMPLETED TASK: {task_title}
TASK OUTPUT:
{task_output}

EXISTING RUNBOOK TASKS:
{existing_tasks}

Based on the task output, suggest follow-up tasks that:
- Address TODOs or incomplete items from the output
- Handle edge cases or testing not yet covered
- Fix issues discovered during the task
- Do NOT duplicate existing runbook tasks

Output JSON:
{{
    "suggestions": [
        {{
            "title": "Short descriptive title",
            "goal": "What this task accomplishes",
            "priority": 50,
            "reason": "Why this follow-up is needed"
        }}
    ]
}}

If no follow-ups are needed, return {{"suggestions": []}}."""

    async def generate_runbook_from_design(self, ws_id: str) -> List[RunbookTask]:
        """Use Gemini to decompose a design doc into runbook tasks.

        Requires the workstream to be in PLANNING phase with a design doc.
        Returns the list of generated RunbookTasks.
        """
        from .gemini import generate_json

        ws = self._load(ws_id)
        if ws.phase != WorkstreamPhase.PLANNING:
            raise ValueError(f"Workstream must be in PLANNING for runbook generation, got {ws.phase}")
        if not ws.design_doc:
            raise ValueError("No design doc available for runbook generation")

        design_content = ws.design_doc.to_markdown()
        objective = ws.brief.objective if ws.brief else ws.title

        prompt = self.RUNBOOK_GENERATION_PROMPT.format(
            title=ws.title,
            objective=objective,
            design_content=design_content,
        )

        result = await generate_json(prompt)

        # Convert Gemini output to RunbookTasks
        generated_tasks = []
        task_id_map = {}  # index -> task_id for dependency resolution

        for i, task_data in enumerate(result.get("tasks", [])):
            task_id = f"task-{uuid.uuid4().hex[:8]}"
            task_id_map[i] = task_id

            # Resolve dependency indices to task IDs
            dep_indices = task_data.get("dependencies", [])
            dep_ids = [task_id_map[idx] for idx in dep_indices if idx in task_id_map]

            rt = RunbookTask(
                task_id=task_id,
                title=task_data.get("title", f"Task {i+1}"),
                dependencies=dep_ids,
                suggested_by="hester",
                priority=task_data.get("priority", 0),
            )
            generated_tasks.append(rt)
            ws.runbook.add_task(rt)

        self.ws_store.save_runbook(ws.id, ws.runbook)

        logger.info(f"Generated {len(generated_tasks)} runbook tasks for {ws_id}")
        self.ws_store.push_telemetry(ws_id, {
            "event_type": "runbook_generated",
            "task_count": len(generated_tasks),
        })

        return generated_tasks

    async def suggest_follow_up_tasks(
        self,
        ws_id: str,
        task_id: str,
        task_output: str,
    ) -> List[Dict[str, Any]]:
        """Use Gemini to suggest follow-up tasks after a task completes.

        Returns list of suggestion dicts with title, goal, priority, reason.
        Does NOT auto-add them to the runbook (caller decides).
        """
        from .gemini import generate_json

        ws = self._load(ws_id)

        # Find the completed task
        completed_task = None
        for t in ws.runbook.tasks:
            if t.task_id == task_id:
                completed_task = t
                break

        task_title = completed_task.title if completed_task else task_id

        # Format existing tasks for context
        existing = "\n".join(
            f"- [{t.task_id}] {t.title}" for t in ws.runbook.tasks
        ) or "None"

        prompt = self.FOLLOW_UP_PROMPT.format(
            title=ws.title,
            task_title=task_title,
            task_output=task_output[:8000],  # Truncate very long outputs
            existing_tasks=existing,
        )

        result = await generate_json(prompt)
        suggestions = result.get("suggestions", [])

        if suggestions:
            logger.info(f"Gemini suggested {len(suggestions)} follow-up tasks for {task_id}")

        return suggestions

    async def slice_context_for_task(
        self,
        ws_id: str,
        task_id: str,
    ) -> Optional[Any]:
        """Generate a context slice for a specific runbook task.

        Requires a ContextWarehouse and ContextSlicer. Returns a ContextSlice
        or None if the warehouse/slicer isn't available.
        """
        ws = self._load(ws_id)

        # Find the task
        task = None
        for t in ws.runbook.tasks:
            if t.task_id == task_id:
                task = t
                break
        if not task:
            raise ValueError(f"Task {task_id} not found in runbook")

        if not self.bundle_service:
            logger.warning("No bundle_service configured, skipping context slice")
            return None

        from .warehouse import ContextWarehouse
        from .slicer import ContextSlicer

        warehouse = ContextWarehouse(ws_id, self.bundle_service, self.ws_store)
        slicer = ContextSlicer(warehouse)

        context_slice = await slicer.slice_for_task(
            task_id=task.task_id,
            task_title=task.title,
            task_goal="",  # RunbookTask doesn't store goal separately
            task_steps=[],
        )

        return context_slice

    async def dispatch_task(
        self,
        ws_id: str,
        task_id: str,
        agent_id: str,
        agent_type: str = "claude_code",
    ) -> Dict[str, Any]:
        """Prepare a task for agent dispatch with context slice.

        Returns a dispatch payload dict containing the task, context, and agent info.
        """
        ws = self._load(ws_id)

        if ws.phase != WorkstreamPhase.EXECUTION:
            raise ValueError(f"Workstream must be in EXECUTION for dispatch, got {ws.phase}")

        # Find the task
        task = None
        for t in ws.runbook.tasks:
            if t.task_id == task_id:
                task = t
                break
        if not task:
            raise ValueError(f"Task {task_id} not found in runbook")

        # Check dependencies are satisfied
        for dep_id in task.dependencies:
            if dep_id not in ws.completed_task_ids:
                raise ValueError(f"Dependency {dep_id} not yet completed")

        # Register the agent
        await self.register_agent(ws_id, agent_id, agent_type, task_id)

        # Generate context slice if possible
        context_slice = await self.slice_context_for_task(ws_id, task_id)

        payload = {
            "workstream_id": ws_id,
            "task_id": task.task_id,
            "task_title": task.title,
            "agent_id": agent_id,
            "agent_type": agent_type,
            "context": context_slice.content if context_slice else "",
            "context_token_estimate": context_slice.token_estimate if context_slice else 0,
        }

        self.ws_store.push_telemetry(ws_id, {
            "event_type": "task_dispatched",
            "task_id": task_id,
            "agent_id": agent_id,
        })

        logger.info(f"Dispatched task {task_id} to agent {agent_id}")
        return payload

    # ── Agent Registration ────────────────────────────────────

    async def register_agent(
        self,
        ws_id: str,
        agent_id: str,
        agent_type: str = "claude_code",
        task_id: Optional[str] = None,
    ) -> Workstream:
        """Register an agent working on this workstream."""
        ws = self._load(ws_id)
        reg = AgentRegistration(
            agent_id=agent_id,
            agent_type=agent_type,
            current_task_id=task_id,
            status="active",
        )
        ws.register_agent(reg)
        self.ws_store.save(ws)
        return ws
