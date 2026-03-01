"""
Workstream management tools for Hester ReAct agents.

These tools allow agents to create and manage workstreams,
calling the WorkstreamOrchestrator directly (same process).
"""

from .models import ToolDefinition


WORKSTREAM_CREATE_TOOL = ToolDefinition(
    name="workstream_create",
    description="Create a new workstream from a brainstormed idea. Creates it in the EXPLORATION phase with a brief. Only call this when the user explicitly agrees to create a workstream.",
    parameters={
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the workstream (e.g. 'Migrate Auth to Clerk')"
            },
            "objective": {
                "type": "string",
                "description": "What needs to be accomplished — the North Star goal"
            },
            "rationale": {
                "type": "string",
                "description": "Why this matters — business justification"
            }
        },
        "required": ["title"]
    }
)

WORKSTREAM_SET_BRIEF_TOOL = ToolDefinition(
    name="workstream_set_brief",
    description="Update the brief on an existing workstream. Use to iteratively refine objective, rationale, constraints, or out-of-scope items as the brainstorm conversation progresses.",
    parameters={
        "type": "object",
        "properties": {
            "workstream_id": {
                "type": "string",
                "description": "The workstream ID (e.g. 'ws-abc12345')"
            },
            "objective": {
                "type": "string",
                "description": "Updated objective (replaces existing)"
            },
            "rationale": {
                "type": "string",
                "description": "Updated rationale (replaces existing)"
            },
            "constraints": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Known constraints (replaces existing list)"
            },
            "out_of_scope": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Explicitly excluded items (replaces existing list)"
            }
        },
        "required": ["workstream_id"]
    }
)

WORKSTREAM_ADVANCE_TO_DESIGN_TOOL = ToolDefinition(
    name="workstream_advance_to_design",
    description="Finalize the brief and advance the workstream from EXPLORATION to DESIGN phase. Only call when the brief is solid and the user confirms they're ready to move forward.",
    parameters={
        "type": "object",
        "properties": {
            "workstream_id": {
                "type": "string",
                "description": "The workstream ID to advance"
            }
        },
        "required": ["workstream_id"]
    }
)

WORKSTREAM_LIST_TOOL = ToolDefinition(
    name="workstream_list",
    description="List existing workstreams. Use to check what workstreams already exist before creating a new one.",
    parameters={
        "type": "object",
        "properties": {
            "phase": {
                "type": "string",
                "enum": ["exploration", "design", "planning", "execution", "review", "done", "paused"],
                "description": "Filter by phase (optional)"
            }
        }
    }
)

WORKSTREAM_TOOLS = [
    WORKSTREAM_CREATE_TOOL,
    WORKSTREAM_SET_BRIEF_TOOL,
    WORKSTREAM_ADVANCE_TO_DESIGN_TOOL,
    WORKSTREAM_LIST_TOOL,
]

__all__ = [
    "WORKSTREAM_CREATE_TOOL",
    "WORKSTREAM_SET_BRIEF_TOOL",
    "WORKSTREAM_ADVANCE_TO_DESIGN_TOOL",
    "WORKSTREAM_LIST_TOOL",
    "WORKSTREAM_TOOLS",
]
