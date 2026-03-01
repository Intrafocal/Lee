"""
Context Slicer - Intelligent context extraction for task-specific slices.

Uses Gemini to analyze task requirements against the Context Warehouse
and select only relevant portions, with model-specific token limits
and automatic thinking depth escalation.
"""

import json
import logging
import re
import uuid
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

from ..thinking_depth import ThinkingDepth

logger = logging.getLogger("hester.daemon.workstream.slicer")


class AgentType(str, Enum):
    """Target agent for the context slice."""
    CLAUDE_CODE = "claude_code"
    HESTER = "hester"


# Token limits per agent/depth combination
CONTEXT_LIMITS = {
    (AgentType.CLAUDE_CODE, None): 100_000,
    (AgentType.HESTER, ThinkingDepth.LOCAL): 4_000,
    (AgentType.HESTER, ThinkingDepth.DEEPLOCAL): 6_000,
    (AgentType.HESTER, ThinkingDepth.QUICK): 20_000,
    (AgentType.HESTER, ThinkingDepth.STANDARD): 50_000,
    (AgentType.HESTER, ThinkingDepth.DEEP): 100_000,
    (AgentType.HESTER, ThinkingDepth.PRO): 150_000,
}

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
    agent_type: AgentType = AgentType.CLAUDE_CODE
    recommended_depth: Optional[ThinkingDepth] = None
    original_depth: Optional[ThinkingDepth] = None
    depth_escalated: bool = False
    included_bundles: List[str] = Field(default_factory=list)
    included_files: List[str] = Field(default_factory=list)
    included_sections: Dict[str, List[str]] = Field(default_factory=dict)
    content: str = ""
    rationale: str = ""
    token_estimate: int = 0
    token_limit: int = 0


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
    """Determine if thinking depth needs escalation based on context size."""
    requested_limit = CONTEXT_LIMITS.get(
        (AgentType.HESTER, requested_depth), 50_000
    )

    if token_count <= requested_limit:
        return requested_depth, False

    for depth in DEPTH_ESCALATION:
        limit = CONTEXT_LIMITS.get((AgentType.HESTER, depth), 50_000)
        if token_count <= limit:
            if DEPTH_ESCALATION.index(depth) > DEPTH_ESCALATION.index(requested_depth):
                return depth, True
            return requested_depth, False

    return ThinkingDepth.PRO, True


class ContextSlicer:
    """Intelligently slices the Context Warehouse for specific tasks."""

    SLICE_PROMPT = """You are a context curator for an AI development workflow.

Given a TASK and a WAREHOUSE of available context, select ONLY the portions
relevant to completing the task. Minimize context while ensuring the agent
has everything needed.

TASK:
Title: {task_title}
Goal: {task_goal}
Steps: {task_steps}

WAREHOUSE CONTENTS:
{warehouse_toc}

Target token limit: ~{token_limit:,} tokens.
Prioritize essential context and exclude nice-to-have information.

Output JSON:
{{
    "included_bundles": ["bundle-id-1"],
    "included_files": ["path/to/file.py"],
    "included_sections": {{"bundle-id-1": ["Section Title"]}},
    "excluded_reason": "Why excluded items aren't needed",
    "rationale": "Why included items are needed"
}}
"""

    def __init__(self, warehouse, model_name: Optional[str] = None):
        self.warehouse = warehouse
        self.model_name = model_name  # None = use settings default

    async def _generate_warehouse_toc(self) -> str:
        """Generate a table of contents for the warehouse."""
        ws = self.warehouse._get_workstream()
        if not ws:
            return ""

        toc_parts = []

        for bundle_id in ws.warehouse_bundle_ids:
            try:
                content = self.warehouse.bundles.get_content(bundle_id)
                if content:
                    sections = self._extract_sections(content)
                    toc_parts.append(f"## Bundle: {bundle_id}")
                    if sections:
                        toc_parts.append("Sections:")
                        for section in sections:
                            toc_parts.append(f"  - {section}")
                    toc_parts.append("")
            except Exception:
                continue

        if ws.warehouse_files:
            toc_parts.append("## Relevant Files")
            for f in ws.warehouse_files[:50]:
                toc_parts.append(f"  - {f}")

        return "\n".join(toc_parts)

    def _extract_sections(self, content: str) -> List[str]:
        """Extract markdown section headers from content."""
        headers = re.findall(r'^#{1,3}\s+(.+)$', content, re.MULTILINE)
        return headers[:20]

    async def slice_for_task(
        self,
        task_id: str,
        task_title: str,
        task_goal: str,
        task_steps: List[str],
        agent_type: AgentType = AgentType.CLAUDE_CODE,
        requested_depth: Optional[ThinkingDepth] = None,
    ) -> ContextSlice:
        """Generate a context slice for a specific task."""
        if agent_type == AgentType.HESTER and requested_depth:
            token_limit = get_context_limit(agent_type, requested_depth)
        else:
            token_limit = get_context_limit(agent_type)

        toc = await self._generate_warehouse_toc()

        # If warehouse is empty, return empty slice
        if not toc.strip():
            return ContextSlice(
                task_id=task_id,
                task_title=task_title,
                agent_type=agent_type,
                token_limit=token_limit,
                rationale="Warehouse is empty",
            )

        # Use Gemini for intelligent selection
        try:
            from .gemini import generate_json

            prompt = self.SLICE_PROMPT.format(
                task_title=task_title,
                task_goal=task_goal,
                task_steps="\n".join(f"- {s}" for s in task_steps),
                warehouse_toc=toc,
                token_limit=token_limit,
            )

            selection = await generate_json(prompt, model_name=self.model_name)
        except Exception as e:
            logger.warning(f"Gemini slicing failed, including all context: {e}")
            ws = self.warehouse._get_workstream()
            selection = {
                "included_bundles": ws.warehouse_bundle_ids if ws else [],
                "included_files": ws.warehouse_files if ws else [],
                "rationale": "Fallback: included all context due to slicing error",
            }

        # Build sliced content
        content_parts = []
        ws = self.warehouse._get_workstream()

        if ws:
            for bundle_id in selection.get("included_bundles", []):
                if bundle_id in ws.warehouse_bundle_ids:
                    try:
                        bundle_content = self.warehouse.bundles.get_content(bundle_id)
                        if bundle_content:
                            sections = selection.get("included_sections", {}).get(bundle_id)
                            if sections:
                                content_parts.append(
                                    self._extract_bundle_sections(bundle_content, sections)
                                )
                            else:
                                content_parts.append(bundle_content)
                    except Exception:
                        continue

        sliced_content = "\n\n---\n\n".join(content_parts)
        token_estimate = len(sliced_content) // 4

        # Check depth escalation
        recommended_depth = requested_depth
        depth_escalated = False

        if agent_type == AgentType.HESTER and requested_depth:
            recommended_depth, depth_escalated = escalate_depth_for_context(
                token_estimate, requested_depth
            )
            if depth_escalated:
                token_limit = get_context_limit(agent_type, recommended_depth)

        return ContextSlice(
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

    def _extract_bundle_sections(self, content: str, section_titles: List[str]) -> str:
        """Extract specific sections from bundle content."""
        parts = []
        for title in section_titles:
            escaped_title = re.escape(title)
            pattern = rf'^(#{1,3}\s+{escaped_title}.*?)(?=^#{1,3}\s|\Z)'
            match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
            if match:
                parts.append(match.group(1).strip())
        return "\n\n".join(parts)
