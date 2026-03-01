"""
Workstream tool executors for Hester ReAct agents.

These functions execute workstream management tools by calling
the WorkstreamOrchestrator directly (same process, no HTTP).
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hester.tools.workstream")

# Module-level reference, set by init_workstream_tools()
_orchestrator = None


def init_workstream_tools(ws_store):
    """Initialize workstream tools with the store from app_state.

    Called once at daemon startup from main.py lifespan.
    """
    global _orchestrator
    if ws_store is None:
        logger.warning("WorkstreamStore not available, workstream tools disabled")
        return
    from ..workstream.orchestrator import WorkstreamOrchestrator
    _orchestrator = WorkstreamOrchestrator(ws_store=ws_store)
    logger.info("Workstream tools initialized")


async def execute_workstream_create(
    title: str,
    objective: str = "",
    rationale: str = "",
) -> Dict[str, Any]:
    """Create a new workstream in EXPLORATION phase."""
    if not _orchestrator:
        return {"success": False, "error": "Workstream system not initialized"}
    try:
        ws = await _orchestrator.create_workstream(
            title=title,
            objective=objective,
            rationale=rationale,
        )
        return {
            "success": True,
            "workstream_id": ws.id,
            "title": ws.title,
            "phase": ws.phase.value,
            "message": f"Workstream '{ws.title}' created ({ws.id}). Currently in EXPLORATION phase.",
        }
    except Exception as e:
        logger.error(f"Failed to create workstream: {e}")
        return {"success": False, "error": str(e)}


async def execute_workstream_set_brief(
    workstream_id: str,
    objective: Optional[str] = None,
    rationale: Optional[str] = None,
    constraints: Optional[List[str]] = None,
    out_of_scope: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Update the brief on an existing workstream."""
    if not _orchestrator:
        return {"success": False, "error": "Workstream system not initialized"}
    try:
        ws = await _orchestrator.update_brief(
            workstream_id,
            objective=objective,
            rationale=rationale,
            constraints=constraints,
            out_of_scope=out_of_scope,
        )
        return {
            "success": True,
            "workstream_id": ws.id,
            "brief": {
                "objective": ws.brief.objective,
                "rationale": ws.brief.rationale,
                "constraints": ws.brief.constraints,
                "out_of_scope": ws.brief.out_of_scope,
            },
            "message": "Brief updated.",
        }
    except Exception as e:
        logger.error(f"Failed to update brief: {e}")
        return {"success": False, "error": str(e)}


async def execute_workstream_advance_to_design(
    workstream_id: str,
) -> Dict[str, Any]:
    """Finalize brief and advance to DESIGN phase."""
    if not _orchestrator:
        return {"success": False, "error": "Workstream system not initialized"}
    try:
        ws = await _orchestrator.finalize_brief(workstream_id)
        return {
            "success": True,
            "workstream_id": ws.id,
            "phase": ws.phase.value,
            "message": f"Workstream advanced to {ws.phase.value.upper()}. Next: grounding, research, and design decisions.",
        }
    except Exception as e:
        logger.error(f"Failed to advance to design: {e}")
        return {"success": False, "error": str(e)}


async def execute_workstream_list(
    phase: Optional[str] = None,
) -> Dict[str, Any]:
    """List existing workstreams."""
    if not _orchestrator:
        return {"success": False, "error": "Workstream system not initialized"}
    try:
        all_ids = _orchestrator.ws_store.list_all()
        workstreams = []
        for ws_id in all_ids:
            ws = _orchestrator.ws_store.get(ws_id)
            if ws and (phase is None or ws.phase.value == phase):
                workstreams.append({
                    "id": ws.id,
                    "title": ws.title,
                    "phase": ws.phase.value,
                    "objective": ws.brief.objective if ws.brief else "",
                })
        return {
            "success": True,
            "count": len(workstreams),
            "workstreams": workstreams,
        }
    except Exception as e:
        logger.error(f"Failed to list workstreams: {e}")
        return {"success": False, "error": str(e)}
