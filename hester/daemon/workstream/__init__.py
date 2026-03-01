"""
Hester Workstream System - Multi-agent workflow orchestration.
"""

from .models import (
    Workstream,
    WorkstreamPhase,
    WorkstreamBrief,
    DesignDecision,
    DesignDoc,
    RunbookTask,
    Runbook,
    AgentRegistration,
    NEXT_PHASE,
)
from .store import WorkstreamStore
from .warehouse import ContextWarehouse
from .slicer import ContextSlicer, ContextSlice, AgentType, get_context_limit, escalate_depth_for_context
from .telemetry import WorkstreamEvent
from .orchestrator import WorkstreamOrchestrator
from .hooks import setup_workstream_hooks, generate_claude_code_hooks

__all__ = [
    "Workstream", "WorkstreamPhase", "WorkstreamBrief",
    "DesignDecision", "DesignDoc", "RunbookTask", "Runbook",
    "AgentRegistration", "NEXT_PHASE",
    "WorkstreamStore",
    "ContextWarehouse",
    "ContextSlicer", "ContextSlice", "AgentType",
    "get_context_limit", "escalate_depth_for_context",
    "WorkstreamEvent",
    "WorkstreamOrchestrator",
    "setup_workstream_hooks", "generate_claude_code_hooks",
]
