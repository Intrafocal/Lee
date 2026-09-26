"""
Workstream HTTP Routes - FastAPI router for workstream management.

Mounted on the Hester daemon as /workstream/.
"""

import logging
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .models import WorkstreamPhase
from .orchestrator import WorkstreamOrchestrator
from .store import WorkstreamStore

logger = logging.getLogger("hester.daemon.workstream.routes")


# ── Request/Response Models ───────────────────────────────────

class CreateWorkstreamRequest(BaseModel):
    title: str
    objective: str = ""
    rationale: str = ""
    serves: List[str] = []


class PhaseDesignRequest(BaseModel):
    constraints: List[str] = []
    out_of_scope: List[str] = []


class PhasePlanningRequest(BaseModel):
    summary: str = ""
    architecture_notes: str = ""


class AddTaskRequest(BaseModel):
    title: str
    goal: str = ""
    dependencies: List[str] = []


class CompleteTaskRequest(BaseModel):
    success: bool = True
    output: str = ""


class AddBundleRequest(BaseModel):
    bundle_id: str


class ResearchRequest(BaseModel):
    title: str
    source: str
    summary: str


class TradeoffRequest(BaseModel):
    favoured: List[str] = []
    over: List[str] = []
    note: Optional[str] = None


class DecisionRequest(BaseModel):
    question: str
    decision: str
    rationale: str
    alternatives: List[str] = []
    tradeoff: Optional[TradeoffRequest] = None


class DispatchRequest(BaseModel):
    agent_id: str
    agent_type: str = "claude_code"


class FollowUpRequest(BaseModel):
    task_output: str


# ── Router Factory ────────────────────────────────────────────

def create_workstream_router(
    ws_store: Optional[WorkstreamStore] = None,
    task_store: Any = None,
    bundle_service: Any = None,
    ws_store_provider: Optional[Callable[[], WorkstreamStore]] = None,
    bundle_service_provider: Optional[Callable[[], Any]] = None,
) -> APIRouter:
    """Create the workstream router with injected dependencies.

    ``ws_store_provider`` resolves the store per request (the daemon passes the
    request's workspace from the registry); a fixed ``ws_store`` still works.
    The orchestrator holds no state beyond its stores, so it is built per request.
    """
    if ws_store_provider is None:
        if ws_store is None:
            raise ValueError("ws_store or ws_store_provider is required")
        ws_store_provider = lambda: ws_store  # noqa: E731
    if bundle_service_provider is None:
        bundle_service_provider = lambda: bundle_service  # noqa: E731

    router = APIRouter(prefix="/workstream", tags=["workstream"])

    def _store() -> WorkstreamStore:
        return ws_store_provider()

    def _orch() -> WorkstreamOrchestrator:
        return WorkstreamOrchestrator(
            ws_store=_store(),
            task_store=task_store,
            bundle_service=bundle_service_provider(),
        )

    # ── CRUD ──────────────────────────────────────────────

    @router.post("/")
    async def create_workstream(req: CreateWorkstreamRequest):
        ws = await _orch().create_workstream(
            title=req.title,
            objective=req.objective,
            rationale=req.rationale,
            serves=req.serves,
        )
        return _ws_response(ws)

    @router.get("/")
    async def list_workstreams(phase: Optional[str] = None):
        ws_ids = _store().list_all()
        result = []
        for ws_id in ws_ids:
            ws = _store().get(ws_id)
            if ws and (phase is None or ws.phase.value == phase):
                result.append(_ws_response(ws))
        return result

    @router.get("/{ws_id}")
    async def get_workstream(ws_id: str):
        ws = _store().get(ws_id)
        if not ws:
            raise HTTPException(status_code=404, detail=f"Workstream not found: {ws_id}")
        return _ws_response(ws)

    @router.delete("/{ws_id}")
    async def delete_workstream(ws_id: str):
        if not _store().delete(ws_id):
            raise HTTPException(status_code=404, detail=f"Workstream not found: {ws_id}")
        return {"status": "deleted", "id": ws_id}

    # ── Phase Transitions ─────────────────────────────────

    @router.post("/{ws_id}/phase/design")
    async def advance_to_design(ws_id: str, req: Optional[PhaseDesignRequest] = None):
        try:
            ws = await _orch().finalize_brief(
                ws_id,
                constraints=req.constraints if req else None,
                out_of_scope=req.out_of_scope if req else None,
            )
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/phase/planning")
    async def advance_to_planning(ws_id: str, req: Optional[PhasePlanningRequest] = None):
        try:
            ws = await _orch().finalize_design(
                ws_id,
                summary=req.summary if req else "",
                architecture_notes=req.architecture_notes if req else "",
            )
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/phase/execution")
    async def advance_to_execution(ws_id: str):
        try:
            ws = await _orch().finalize_planning(ws_id)
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/phase/advance")
    async def advance_phase(ws_id: str):
        try:
            ws = await _orch().advance_phase(ws_id)
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/phase/paused")
    async def pause_workstream(ws_id: str):
        try:
            ws = await _orch().pause(ws_id)
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/phase/resume")
    async def resume_workstream(ws_id: str):
        try:
            ws = await _orch().resume(ws_id)
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/phase/{phase}")
    async def set_phase(ws_id: str, phase: str):
        """Soft phases: any WorkstreamPhase, backwards included (exploration, review, done, ...)."""
        try:
            target = WorkstreamPhase(phase)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown phase: {phase}")
        try:
            ws = await _orch().set_phase(ws_id, target)
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

    # ── Runbook ───────────────────────────────────────────

    @router.post("/{ws_id}/runbook/tasks")
    async def add_runbook_task(ws_id: str, req: AddTaskRequest):
        try:
            task = await _orch().add_runbook_task(
                ws_id,
                title=req.title,
                goal=req.goal,
                dependencies=req.dependencies,
            )
            return task.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.get("/{ws_id}/runbook")
    async def get_runbook(ws_id: str):
        ws = _store().get(ws_id)
        if not ws:
            raise HTTPException(status_code=404, detail=f"Workstream not found: {ws_id}")
        return {
            "tasks": [t.model_dump() for t in ws.runbook.tasks],
            "completed_task_ids": ws.completed_task_ids,
        }

    @router.get("/{ws_id}/next-task")
    async def get_next_task(ws_id: str):
        try:
            task = await _orch().get_next_task(ws_id)
            if not task:
                return None
            return task.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # ── Task Completion ───────────────────────────────────

    @router.post("/{ws_id}/complete/{task_id}")
    async def complete_task(ws_id: str, task_id: str, req: CompleteTaskRequest):
        try:
            ws = await _orch().complete_task(ws_id, task_id, success=req.success, output=req.output)
            return _ws_response(ws)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # ── Design ────────────────────────────────────────────

    @router.post("/{ws_id}/design/research")
    async def add_research(ws_id: str, req: ResearchRequest):
        try:
            ws = await _orch().add_research(ws_id, req.title, req.source, req.summary)
            return {"status": "added"}
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/design/decision")
    async def record_decision(ws_id: str, req: DecisionRequest):
        try:
            ws = await _orch().record_decision(
                ws_id, req.question, req.decision, req.rationale, req.alternatives,
                tradeoff=req.tradeoff.model_dump() if req.tradeoff else None,
            )
            return {"status": "recorded"}
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # ── Warehouse ─────────────────────────────────────────

    @router.post("/{ws_id}/warehouse/bundle")
    async def add_warehouse_bundle(ws_id: str, req: AddBundleRequest):
        ws = _store().get(ws_id)
        if not ws:
            raise HTTPException(status_code=404, detail=f"Workstream not found: {ws_id}")
        ws.add_to_warehouse(req.bundle_id)
        _store().save(ws)
        return {"status": "added", "bundle_id": req.bundle_id}

    @router.get("/{ws_id}/warehouse")
    async def get_warehouse(ws_id: str):
        ws = _store().get(ws_id)
        if not ws:
            raise HTTPException(status_code=404, detail=f"Workstream not found: {ws_id}")
        return {
            "bundles": ws.warehouse_bundle_ids,
            "files": ws.warehouse_files,
            "notes": ws.warehouse_notes,
        }

    # ── Gemini-Powered Endpoints ──────────────────────────

    @router.post("/{ws_id}/runbook/generate")
    async def generate_runbook(ws_id: str):
        """Generate runbook tasks from the design doc using Gemini."""
        try:
            tasks = await _orch().generate_runbook_from_design(ws_id)
            return {
                "status": "generated",
                "task_count": len(tasks),
                "tasks": [t.model_dump() for t in tasks],
            }
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.error(f"Runbook generation failed: {e}")
            raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

    @router.post("/{ws_id}/dispatch/{task_id}")
    async def dispatch_task(ws_id: str, task_id: str, req: DispatchRequest):
        """Dispatch a task to an agent with context slice."""
        try:
            payload = await _orch().dispatch_task(
                ws_id, task_id, req.agent_id, req.agent_type,
            )
            return payload
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @router.post("/{ws_id}/suggest-follow-ups/{task_id}")
    async def suggest_follow_ups(ws_id: str, task_id: str, req: FollowUpRequest):
        """Get Gemini-suggested follow-up tasks after task completion."""
        try:
            suggestions = await _orch().suggest_follow_up_tasks(
                ws_id, task_id, req.task_output,
            )
            return {
                "task_id": task_id,
                "suggestion_count": len(suggestions),
                "suggestions": suggestions,
            }
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.error(f"Follow-up suggestion failed: {e}")
            raise HTTPException(status_code=500, detail=f"Suggestion failed: {str(e)}")

    @router.get("/{ws_id}/telemetry")
    async def get_workstream_telemetry(ws_id: str, limit: int = 50):
        """Get recent telemetry events for a workstream."""
        ws = _store().get(ws_id)
        if not ws:
            raise HTTPException(status_code=404, detail=f"Workstream not found: {ws_id}")
        events = _store().get_telemetry(ws_id, limit=limit)
        return {"workstream_id": ws_id, "events": events}

    return router


def _ws_response(ws) -> Dict[str, Any]:
    """Build a workstream response dict."""
    resp = {
        "id": ws.id,
        "title": ws.title,
        "phase": ws.phase.value,
        "serves": list(getattr(ws, "serves", []) or []),
        "created_at": ws.created_at.isoformat(),
        "updated_at": ws.updated_at.isoformat(),
        "completed_task_ids": ws.completed_task_ids,
        "task_count": len(ws.runbook.tasks) if ws.runbook else 0,
    }
    if ws.brief:
        resp["brief"] = {
            "objective": ws.brief.objective,
            "rationale": ws.brief.rationale,
            "constraints": ws.brief.constraints,
            "out_of_scope": ws.brief.out_of_scope,
        }
    if ws.runbook and ws.runbook.tasks:
        resp["runbook_tasks"] = [t.model_dump() for t in ws.runbook.tasks]
    return resp
