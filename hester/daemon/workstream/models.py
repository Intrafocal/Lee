"""
Workstream Models - Pydantic models with YAML/markdown serialization.

Follows the same patterns as lee.hester.daemon.tasks.models:
- YAML frontmatter for metadata
- Markdown for human-readable artifacts (brief, design doc)
- YAML for structured data (runbook, workstream metadata)
"""

import re
import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field


# ─────────────────────────────────────────────────────────────
# Enums
# ─────────────────────────────────────────────────────────────

class WorkstreamPhase(str, Enum):
    """Workstream lifecycle phases."""
    EXPLORATION = "exploration"
    DESIGN = "design"
    PLANNING = "planning"
    EXECUTION = "execution"
    REVIEW = "review"
    DONE = "done"
    PAUSED = "paused"


NEXT_PHASE = {
    WorkstreamPhase.EXPLORATION: WorkstreamPhase.DESIGN,
    WorkstreamPhase.DESIGN: WorkstreamPhase.PLANNING,
    WorkstreamPhase.PLANNING: WorkstreamPhase.EXECUTION,
    WorkstreamPhase.EXECUTION: WorkstreamPhase.REVIEW,
    WorkstreamPhase.REVIEW: WorkstreamPhase.DONE,
}


# ─────────────────────────────────────────────────────────────
# Phase Artifacts
# ─────────────────────────────────────────────────────────────

class WorkstreamBrief(BaseModel):
    """The high-level objective from Exploration phase."""
    objective: str = Field(description="What needs to be accomplished")
    rationale: str = Field(default="", description="Why this matters")
    constraints: List[str] = Field(default_factory=list)
    out_of_scope: List[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    conversation_id: Optional[str] = Field(None, description="Session ID of exploration chat")

    def to_markdown(self) -> str:
        """Serialize brief to markdown with YAML frontmatter."""
        frontmatter = {
            "created": self.created_at.isoformat(),
        }
        if self.conversation_id:
            frontmatter["conversation_id"] = self.conversation_id

        lines = ["---"]
        lines.append(yaml.dump(frontmatter, default_flow_style=False).strip())
        lines.append("---")
        lines.append("")
        lines.append("# Brief")
        lines.append("")
        lines.append("## Objective")
        lines.append(self.objective)
        lines.append("")
        if self.rationale:
            lines.append("## Rationale")
            lines.append(self.rationale)
            lines.append("")
        if self.constraints:
            lines.append("## Constraints")
            for c in self.constraints:
                lines.append(f"- {c}")
            lines.append("")
        if self.out_of_scope:
            lines.append("## Out of Scope")
            for o in self.out_of_scope:
                lines.append(f"- {o}")
            lines.append("")
        return "\n".join(lines)

    @classmethod
    def from_markdown(cls, content: str) -> "WorkstreamBrief":
        """Parse brief from markdown with YAML frontmatter."""
        frontmatter_match = re.match(r"^---\n(.*?)\n---\n(.*)$", content, re.DOTALL)
        if not frontmatter_match:
            raise ValueError("Invalid brief: missing YAML frontmatter")

        frontmatter_str, body = frontmatter_match.groups()
        frontmatter = yaml.safe_load(frontmatter_str) or {}

        objective = ""
        obj_match = re.search(r"## Objective\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if obj_match:
            objective = obj_match.group(1).strip()

        rationale = ""
        rat_match = re.search(r"## Rationale\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if rat_match:
            rationale = rat_match.group(1).strip()

        constraints = []
        con_match = re.search(r"## Constraints\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if con_match:
            constraints = [
                line.lstrip("- ").strip()
                for line in con_match.group(1).strip().split("\n")
                if line.strip().startswith("-")
            ]

        out_of_scope = []
        oos_match = re.search(r"## Out of Scope\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if oos_match:
            out_of_scope = [
                line.lstrip("- ").strip()
                for line in oos_match.group(1).strip().split("\n")
                if line.strip().startswith("-")
            ]

        created_at = datetime.fromisoformat(frontmatter["created"]) if "created" in frontmatter else datetime.utcnow()

        return cls(
            objective=objective,
            rationale=rationale,
            constraints=constraints,
            out_of_scope=out_of_scope,
            created_at=created_at,
            conversation_id=frontmatter.get("conversation_id"),
        )


class DesignDecision(BaseModel):
    """A key decision made during Design phase."""
    id: str = Field(default_factory=lambda: f"decision-{uuid.uuid4().hex[:8]}")
    question: str = Field(description="What was being decided")
    decision: str = Field(description="What was decided")
    rationale: str = Field(description="Why this approach")
    alternatives: List[str] = Field(default_factory=list)
    risks: List[str] = Field(default_factory=list)
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class DesignDoc(BaseModel):
    """The validated specification from Design phase."""
    summary: str = Field(description="Executive summary of approach")
    grounding: Dict[str, Any] = Field(default_factory=dict)
    research: List[Dict[str, str]] = Field(default_factory=list)
    decisions: List[DesignDecision] = Field(default_factory=list)
    architecture_notes: str = Field(default="")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    validated_at: Optional[datetime] = None
    bundle_id: Optional[str] = Field(None)

    def to_markdown(self) -> str:
        """Serialize design doc to markdown with YAML frontmatter."""
        frontmatter = {
            "created": self.created_at.isoformat(),
        }
        if self.validated_at:
            frontmatter["validated"] = self.validated_at.isoformat()
        if self.bundle_id:
            frontmatter["bundle_id"] = self.bundle_id
        if self.grounding:
            frontmatter["grounding"] = self.grounding

        lines = ["---"]
        lines.append(yaml.dump(frontmatter, default_flow_style=False).strip())
        lines.append("---")
        lines.append("")
        lines.append("# Design Document")
        lines.append("")
        lines.append("## Summary")
        lines.append(self.summary)
        lines.append("")

        if self.architecture_notes:
            lines.append("## Architecture")
            lines.append(self.architecture_notes)
            lines.append("")

        if self.decisions:
            lines.append("## Decisions")
            lines.append("")
            for d in self.decisions:
                lines.append(f"### {d.question}")
                lines.append(f"**Decision:** {d.decision}")
                lines.append(f"**Rationale:** {d.rationale}")
                if d.alternatives:
                    lines.append(f"**Alternatives:** {', '.join(d.alternatives)}")
                if d.risks:
                    lines.append(f"**Risks:** {', '.join(d.risks)}")
                lines.append("")

        if self.research:
            lines.append("## Research")
            lines.append("")
            for r in self.research:
                lines.append(f"### {r.get('title', 'Untitled')}")
                if r.get("source"):
                    lines.append(f"**Source:** {r['source']}")
                if r.get("summary"):
                    lines.append(r["summary"])
                lines.append("")

        return "\n".join(lines)

    @classmethod
    def from_markdown(cls, content: str) -> "DesignDoc":
        """Parse design doc from markdown with YAML frontmatter."""
        frontmatter_match = re.match(r"^---\n(.*?)\n---\n(.*)$", content, re.DOTALL)
        if not frontmatter_match:
            raise ValueError("Invalid design doc: missing YAML frontmatter")

        frontmatter_str, body = frontmatter_match.groups()
        frontmatter = yaml.safe_load(frontmatter_str) or {}

        summary = ""
        sum_match = re.search(r"## Summary\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if sum_match:
            summary = sum_match.group(1).strip()

        architecture_notes = ""
        arch_match = re.search(r"## Architecture\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
        if arch_match:
            architecture_notes = arch_match.group(1).strip()

        decisions = []
        decisions_match = re.search(r"## Decisions\n(.*?)(?=\n## (?!#)|\Z)", body, re.DOTALL)
        if decisions_match:
            decision_pattern = r"### (.+?)\n\*\*Decision:\*\* (.+?)\n\*\*Rationale:\*\* (.+?)(?:\n\*\*Alternatives:\*\* (.+?))?(?:\n\*\*Risks:\*\* (.+?))?(?=\n### |\n## |\Z)"
            for m in re.finditer(decision_pattern, decisions_match.group(1), re.DOTALL):
                decisions.append(DesignDecision(
                    question=m.group(1).strip(),
                    decision=m.group(2).strip(),
                    rationale=m.group(3).strip(),
                    alternatives=[a.strip() for a in m.group(4).split(",")] if m.group(4) else [],
                    risks=[r.strip() for r in m.group(5).split(",")] if m.group(5) else [],
                ))

        research = []
        research_match = re.search(r"## Research\n(.*?)(?=\n## (?!#)|\Z)", body, re.DOTALL)
        if research_match:
            res_pattern = r"### (.+?)(?:\n\*\*Source:\*\* (.+?))?(?:\n(.+?))?(?=\n### |\Z)"
            for m in re.finditer(res_pattern, research_match.group(1), re.DOTALL):
                entry = {"title": m.group(1).strip()}
                if m.group(2):
                    entry["source"] = m.group(2).strip()
                if m.group(3):
                    entry["summary"] = m.group(3).strip()
                research.append(entry)

        created_at = datetime.fromisoformat(frontmatter["created"]) if "created" in frontmatter else datetime.utcnow()
        validated_at = datetime.fromisoformat(frontmatter["validated"]) if "validated" in frontmatter else None

        return cls(
            summary=summary,
            grounding=frontmatter.get("grounding", {}),
            research=research,
            decisions=decisions,
            architecture_notes=architecture_notes,
            created_at=created_at,
            validated_at=validated_at,
            bundle_id=frontmatter.get("bundle_id"),
        )


# ─────────────────────────────────────────────────────────────
# Runbook
# ─────────────────────────────────────────────────────────────

class RunbookTask(BaseModel):
    """A task in the Runbook (wrapper around existing Task)."""
    task_id: str = Field(description="Reference to Task in TaskStore")
    title: str
    dependencies: List[str] = Field(default_factory=list)
    suggested_by: str = Field(default="user", description="'user' or 'hester'")
    context_slice: Optional[str] = Field(None)
    priority: int = Field(default=0)


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

    def to_yaml(self) -> str:
        """Serialize runbook to YAML."""
        data = {
            "created": self.created_at.isoformat(),
            "last_updated": self.last_updated.isoformat(),
            "tasks": [t.model_dump() for t in self.tasks],
        }
        return yaml.dump(data, default_flow_style=False, sort_keys=False)

    @classmethod
    def from_yaml(cls, content: str) -> "Runbook":
        """Parse runbook from YAML."""
        data = yaml.safe_load(content) or {}
        tasks = [RunbookTask(**t) for t in data.get("tasks", [])]
        return cls(
            tasks=tasks,
            created_at=datetime.fromisoformat(data["created"]) if "created" in data else datetime.utcnow(),
            last_updated=datetime.fromisoformat(data["last_updated"]) if "last_updated" in data else datetime.utcnow(),
        )


# ─────────────────────────────────────────────────────────────
# Agent Registration
# ─────────────────────────────────────────────────────────────

class AgentRegistration(BaseModel):
    """An agent contributing to this Workstream."""
    agent_id: str = Field(description="Unique agent identifier")
    agent_type: str = Field(description="claude_code, hester, etc.")
    registered_at: datetime = Field(default_factory=datetime.utcnow)
    last_heartbeat: datetime = Field(default_factory=datetime.utcnow)
    current_task_id: Optional[str] = None
    status: str = Field(default="idle")
    metadata: Dict[str, Any] = Field(default_factory=dict)


# ─────────────────────────────────────────────────────────────
# Top-Level Workstream
# ─────────────────────────────────────────────────────────────

class Workstream(BaseModel):
    """Top-level Workstream entity."""
    id: str = Field(default_factory=lambda: f"ws-{uuid.uuid4().hex[:8]}")
    title: str
    phase: WorkstreamPhase = WorkstreamPhase.EXPLORATION

    # Phase artifacts (loaded from separate files, not serialized in metadata)
    brief: Optional[WorkstreamBrief] = Field(None, exclude=True)
    design_doc: Optional[DesignDoc] = Field(None, exclude=True)
    runbook: Runbook = Field(default_factory=Runbook, exclude=True)

    # Context Warehouse references
    warehouse_bundle_ids: List[str] = Field(default_factory=list)
    warehouse_files: List[str] = Field(default_factory=list)
    warehouse_notes: str = Field(default="")

    # Agent registry
    agents: List[AgentRegistration] = Field(default_factory=list)

    # Metadata
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    completed_task_ids: List[str] = Field(default_factory=list)
    telemetry_enabled: bool = Field(default=True)

    def add_to_warehouse(self, bundle_id: str) -> None:
        """Add a context bundle to the warehouse."""
        if bundle_id not in self.warehouse_bundle_ids:
            self.warehouse_bundle_ids.append(bundle_id)
            self.updated_at = datetime.utcnow()

    def register_agent(self, agent: AgentRegistration) -> None:
        """Register or update an agent."""
        for i, existing in enumerate(self.agents):
            if existing.agent_id == agent.agent_id:
                self.agents[i] = agent
                return
        self.agents.append(agent)
        self.updated_at = datetime.utcnow()

    def get_active_agents(self) -> List[AgentRegistration]:
        """Get currently active agents."""
        return [a for a in self.agents if a.status == "active"]

    def to_metadata_yaml(self) -> str:
        """Serialize workstream metadata to YAML (excludes brief/design/runbook)."""
        data = {
            "id": self.id,
            "title": self.title,
            "phase": self.phase.value,
            "warehouse_bundle_ids": self.warehouse_bundle_ids,
            "warehouse_files": self.warehouse_files,
            "warehouse_notes": self.warehouse_notes,
            "agents": [a.model_dump() for a in self.agents],
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "completed_task_ids": self.completed_task_ids,
            "telemetry_enabled": self.telemetry_enabled,
        }
        return yaml.dump(data, default_flow_style=False, sort_keys=False)

    @classmethod
    def from_metadata_yaml(cls, content: str) -> "Workstream":
        """Parse workstream metadata from YAML."""
        data = yaml.safe_load(content) or {}
        agents = [AgentRegistration(**a) for a in data.get("agents", [])]
        return cls(
            id=data.get("id", f"ws-{uuid.uuid4().hex[:8]}"),
            title=data.get("title", "Untitled"),
            phase=WorkstreamPhase(data.get("phase", "exploration")),
            warehouse_bundle_ids=data.get("warehouse_bundle_ids", []),
            warehouse_files=data.get("warehouse_files", []),
            warehouse_notes=data.get("warehouse_notes", ""),
            agents=agents,
            created_at=datetime.fromisoformat(data["created_at"]) if "created_at" in data else datetime.utcnow(),
            updated_at=datetime.fromisoformat(data["updated_at"]) if "updated_at" in data else datetime.utcnow(),
            completed_task_ids=data.get("completed_task_ids", []),
            telemetry_enabled=data.get("telemetry_enabled", True),
        )
