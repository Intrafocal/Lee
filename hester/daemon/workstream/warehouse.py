"""
Context Warehouse - Unified knowledge base for a Workstream.

Integrates with the existing Context Bundle system to manage
per-workstream context for intelligent slicing.
"""

import logging
from typing import List, Optional

from .store import WorkstreamStore

logger = logging.getLogger("hester.daemon.workstream.warehouse")


class ContextWarehouse:
    """Manages the Context Warehouse for a Workstream."""

    def __init__(
        self,
        workstream_id: str,
        bundle_service,  # ContextBundleService
        store: WorkstreamStore,
    ):
        self.ws_id = workstream_id
        self.bundles = bundle_service
        self.store = store

    def _get_workstream(self):
        """Get the associated Workstream."""
        return self.store.get(self.ws_id)

    async def add_bundle(self, bundle_id: str) -> None:
        """Add an existing bundle to the warehouse."""
        ws = self._get_workstream()
        if not ws:
            raise ValueError(f"Workstream not found: {self.ws_id}")
        ws.add_to_warehouse(bundle_id)
        self.store.save(ws)

    async def add_file(self, file_path: str) -> None:
        """Add a file to the warehouse."""
        ws = self._get_workstream()
        if not ws:
            raise ValueError(f"Workstream not found: {self.ws_id}")
        if file_path not in ws.warehouse_files:
            ws.warehouse_files.append(file_path)
            self.store.save(ws)

    async def add_notes(self, notes: str) -> None:
        """Append research notes."""
        ws = self._get_workstream()
        if not ws:
            raise ValueError(f"Workstream not found: {self.ws_id}")
        if ws.warehouse_notes:
            ws.warehouse_notes += f"\n\n{notes}"
        else:
            ws.warehouse_notes = notes
        self.store.save(ws)

    async def create_grounding_bundle(
        self,
        name: str,
        file_patterns: List[str],
        grep_patterns: List[str],
        db_tables: List[str],
    ) -> str:
        """Create a context bundle from grounding analysis."""
        try:
            from lee.hester.context.models import (
                GlobSource, GrepSource, DbSchemaSource, SourceType,
            )
        except ImportError:
            logger.warning("Context bundle models not available, skipping grounding bundle creation")
            return ""

        sources = []
        for pattern in file_patterns:
            sources.append(GlobSource(type=SourceType.GLOB, pattern=pattern))
        for pattern in grep_patterns:
            sources.append(GrepSource(type=SourceType.GREP, pattern=pattern, context_lines=3))
        if db_tables:
            sources.append(DbSchemaSource(type=SourceType.DB_SCHEMA, tables=db_tables, include_rls=True))

        bundle_id = f"{self.ws_id}-{name}"
        bundle = await self.bundles.create(
            bundle_id=bundle_id,
            title=f"Grounding: {name}",
            sources=sources,
            ttl_hours=168,
            tags=["workstream", self.ws_id, "grounding"],
        )

        await self.add_bundle(bundle.metadata.id if hasattr(bundle, "metadata") else bundle_id)
        return bundle_id

    async def get_full_context(self) -> str:
        """Get concatenated warehouse content."""
        ws = self._get_workstream()
        if not ws:
            return ""

        parts = []

        # Design doc summary
        if ws.design_doc:
            parts.append(f"# Design Summary\n\n{ws.design_doc.summary}")
            if ws.design_doc.architecture_notes:
                parts.append(f"\n## Architecture\n\n{ws.design_doc.architecture_notes}")

        # Bundle contents
        for bundle_id in ws.warehouse_bundle_ids:
            try:
                content = self.bundles.get_content(bundle_id)
                if content:
                    parts.append(f"\n# Context: {bundle_id}\n\n{content}")
            except Exception:
                continue

        # Notes
        if ws.warehouse_notes:
            parts.append(f"\n# Research Notes\n\n{ws.warehouse_notes}")

        return "\n\n---\n\n".join(parts) if parts else ""
