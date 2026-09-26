"""
Workstream tool executors for Hester ReAct agents.

These functions execute workstream management tools by calling
the WorkstreamOrchestrator directly (same process, no HTTP).
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hester.tools.workstream")

# Resolves the WorkstreamStore at call time, set by init_workstream_tools()
_store_provider = None


def init_workstream_tools(ws_store_or_provider):
    """Initialize workstream tools with a store, or a callable returning one.

    The daemon passes a provider that resolves the current request's
    workspace through the registry, so tools follow the workspace being
    served instead of the one the daemon booted in.
    """
    global _store_provider
    if ws_store_or_provider is None:
        logger.warning("WorkstreamStore not available, workstream tools disabled")
        _store_provider = None
        return
    if callable(ws_store_or_provider):
        _store_provider = ws_store_or_provider
    else:
        _store_provider = lambda: ws_store_or_provider  # noqa: E731
    logger.info("Workstream tools initialized")


def _get_orchestrator():
    if _store_provider is None:
        return None
    try:
        store = _store_provider()
    except Exception as e:
        logger.warning(f"Workstream store unavailable: {e}")
        return None
    if store is None:
        return None
    from ..workstream.orchestrator import WorkstreamOrchestrator
    return WorkstreamOrchestrator(ws_store=store)


async def execute_workstream_create(
    title: str,
    objective: str = "",
    rationale: str = "",
) -> Dict[str, Any]:
    """Create a new workstream in EXPLORATION phase."""
    _orchestrator = _get_orchestrator()
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
    _orchestrator = _get_orchestrator()
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
    _orchestrator = _get_orchestrator()
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
    _orchestrator = _get_orchestrator()
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
