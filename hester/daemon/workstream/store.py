"""
WorkstreamStore - File-based persistence for Workstreams.

Storage layout:
    .hester/workstreams/{ws-id}/
        workstream.yaml      # Metadata
        brief.md             # WorkstreamBrief (markdown + YAML frontmatter)
        design.md            # DesignDoc (markdown + YAML frontmatter)
        runbook.yaml         # Runbook tasks and dependencies
        telemetry.jsonl      # Append-only event log
"""

import json
import logging
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from .models import (
    DesignDoc,
    Runbook,
    Workstream,
    WorkstreamBrief,
    WorkstreamPhase,
)

logger = logging.getLogger("hester.daemon.workstream.store")

DEFAULT_WORKSTREAMS_DIR = ".hester/workstreams"


class WorkstreamStore:
    """File-based Workstream storage."""

    def __init__(
        self,
        base_dir: Optional[Path] = None,
        working_dir: Optional[Path] = None,
    ):
        self.working_dir = working_dir or Path.cwd()
        if base_dir:
            self.base_dir = Path(base_dir)
        else:
            self.base_dir = self.working_dir / DEFAULT_WORKSTREAMS_DIR
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _ws_dir(self, ws_id: str) -> Path:
        return self.base_dir / ws_id

    def create(self, workstream: Workstream) -> Workstream:
        """Create a new Workstream directory and write all artifacts."""
        ws_dir = self._ws_dir(workstream.id)
        ws_dir.mkdir(parents=True, exist_ok=True)

        # Write metadata
        (ws_dir / "workstream.yaml").write_text(workstream.to_metadata_yaml())

        # Write brief if present
        if workstream.brief:
            (ws_dir / "brief.md").write_text(workstream.brief.to_markdown())

        # Write runbook
        (ws_dir / "runbook.yaml").write_text(workstream.runbook.to_yaml())

        logger.info(f"Created workstream: {workstream.id} - {workstream.title}")
        return workstream

    def get(self, ws_id: str) -> Optional[Workstream]:
        """Load a Workstream from its directory."""
        ws_dir = self._ws_dir(ws_id)
        meta_path = ws_dir / "workstream.yaml"
        if not meta_path.exists():
            return None

        try:
            ws = Workstream.from_metadata_yaml(meta_path.read_text())

            # Load brief
            brief_path = ws_dir / "brief.md"
            if brief_path.exists():
                ws.brief = WorkstreamBrief.from_markdown(brief_path.read_text())

            # Load design doc
            design_path = ws_dir / "design.md"
            if design_path.exists():
                ws.design_doc = DesignDoc.from_markdown(design_path.read_text())

            # Load runbook
            runbook_path = ws_dir / "runbook.yaml"
            if runbook_path.exists():
                ws.runbook = Runbook.from_yaml(runbook_path.read_text())

            return ws
        except Exception as e:
            logger.error(f"Failed to load workstream {ws_id}: {e}")
            return None

    def save(self, workstream: Workstream) -> None:
        """Save workstream metadata (use save_brief/save_design/save_runbook for artifacts)."""
        workstream.updated_at = datetime.utcnow()
        ws_dir = self._ws_dir(workstream.id)
        ws_dir.mkdir(parents=True, exist_ok=True)
        (ws_dir / "workstream.yaml").write_text(workstream.to_metadata_yaml())

    def delete(self, ws_id: str) -> bool:
        """Delete a Workstream directory."""
        ws_dir = self._ws_dir(ws_id)
        if not ws_dir.exists():
            return False
        shutil.rmtree(ws_dir)
        logger.info(f"Deleted workstream: {ws_id}")
        return True

    def list_all(self) -> List[str]:
        """List all Workstream IDs."""
        if not self.base_dir.exists():
            return []
        return [
            d.name for d in self.base_dir.iterdir()
            if d.is_dir() and (d / "workstream.yaml").exists()
        ]

    def list_active(self) -> List[Workstream]:
        """List all non-done, non-paused Workstreams."""
        workstreams = []
        for ws_id in self.list_all():
            ws = self.get(ws_id)
            if ws and ws.phase not in (WorkstreamPhase.DONE, WorkstreamPhase.PAUSED):
                workstreams.append(ws)
        return workstreams

    def save_brief(self, ws_id: str, brief: WorkstreamBrief) -> None:
        """Write brief.md for a Workstream."""
        ws_dir = self._ws_dir(ws_id)
        (ws_dir / "brief.md").write_text(brief.to_markdown())

    def save_design(self, ws_id: str, design_doc: DesignDoc) -> None:
        """Write design.md for a Workstream."""
        ws_dir = self._ws_dir(ws_id)
        (ws_dir / "design.md").write_text(design_doc.to_markdown())

    def save_runbook(self, ws_id: str, runbook: Runbook) -> None:
        """Write runbook.yaml for a Workstream."""
        ws_dir = self._ws_dir(ws_id)
        (ws_dir / "runbook.yaml").write_text(runbook.to_yaml())

    def push_telemetry(self, ws_id: str, event: dict) -> None:
        """Append a telemetry event to telemetry.jsonl."""
        ws_dir = self._ws_dir(ws_id)
        if "timestamp" not in event:
            event["timestamp"] = datetime.utcnow().isoformat()
        with open(ws_dir / "telemetry.jsonl", "a") as f:
            f.write(json.dumps(event) + "\n")

    def get_telemetry(self, ws_id: str, limit: int = 100) -> List[dict]:
        """Read recent telemetry events."""
        path = self._ws_dir(ws_id) / "telemetry.jsonl"
        if not path.exists():
            return []
        lines = path.read_text().strip().split("\n")
        events = [json.loads(line) for line in lines if line.strip()]
        return events[-limit:]
