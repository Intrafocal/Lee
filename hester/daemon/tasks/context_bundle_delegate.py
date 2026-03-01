"""
Context Bundle Delegate - Comprehensive context bundle management subagent.

This delegate handles all context bundle operations:
- Create: Create new bundles with sources
- List: List all bundles
- Show: Show bundle content
- Refresh: Refresh stale bundles
- Delete: Delete bundles
- Status: Get status summary

Follows the DocsManagerDelegate pattern.
"""

import logging
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from ..semantic.base import BaseDelegate, register_delegate

if TYPE_CHECKING:
    from .models import TaskBatch

logger = logging.getLogger("hester.daemon.tasks.context_bundle_delegate")


class ContextBundleAction(str, Enum):
    """Actions supported by the context bundle delegate."""

    CREATE = "create"
    LIST = "list"
    SHOW = "show"
    REFRESH = "refresh"
    DELETE = "delete"
    STATUS = "status"


@register_delegate(
    name="context_bundle",
    description="Create and manage reusable context bundles that aggregate information from multiple sources.",
    keywords=["context", "bundle", "package", "aggregate", "knowledge"],
    category="core",
    default_toolset="observe",
)
class ContextBundleDelegate(BaseDelegate):
    """
    Comprehensive context bundle management delegate.

    Wraps BundleService to provide:
    - Create bundles with multiple source types
    - List, show, refresh, delete bundles
    - Status summaries

    Used as a batch delegate for task execution.
    """

    def __init__(self, working_dir: Path, **kwargs):
        """
        Initialize the context bundle delegate.

        Args:
            working_dir: Working directory for file operations
        """
        super().__init__(working_dir, **kwargs)
        logger.info(f"ContextBundleDelegate initialized: working_dir={working_dir}")

    async def execute(
        self,
        action: ContextBundleAction,
        bundle_id: Optional[str] = None,
        title: Optional[str] = None,
        sources: Optional[List[dict]] = None,
        ttl_hours: int = 24,
        tags: Optional[List[str]] = None,
        force: bool = False,
        stale_only: bool = False,
    ) -> Dict[str, Any]:
        """
        Execute a context bundle action.

        Args:
            action: The action to perform (create, list, show, refresh, delete, status)
            bundle_id: Bundle identifier (for show, refresh, delete)
            title: Bundle title (for create)
            sources: List of source definitions (for create)
            ttl_hours: TTL in hours (for create)
            tags: Tags to apply (for create)
            force: Force refresh even if unchanged (for refresh)
            stale_only: Only list stale bundles (for list)

        Returns:
            Dict with operation results
        """
        action = ContextBundleAction(action) if isinstance(action, str) else action

        if action == ContextBundleAction.CREATE:
            return await self._create(title, sources, ttl_hours, tags)
        elif action == ContextBundleAction.LIST:
            return await self._list(stale_only)
        elif action == ContextBundleAction.SHOW:
            return await self._show(bundle_id)
        elif action == ContextBundleAction.REFRESH:
            if bundle_id:
                return await self._refresh_one(bundle_id, force)
            else:
                return await self._refresh_all()
        elif action == ContextBundleAction.DELETE:
            return await self._delete(bundle_id)
        elif action == ContextBundleAction.STATUS:
            return await self._status()
        else:
            return {"success": False, "error": f"Unknown action: {action}"}

    async def _create(
        self,
        title: Optional[str],
        sources: Optional[List[dict]],
        ttl_hours: int,
        tags: Optional[List[str]],
    ) -> Dict[str, Any]:
        """Create a new context bundle."""
        if not title:
            return {"success": False, "error": "Title is required for create action"}
        if not sources:
            return {"success": False, "error": "At least one source is required"}

        from ...context.service import BundleService
        from ...context.models import SourceConfig, SourceType

        try:
            service = BundleService(working_dir=self.working_dir)

            # Convert source dicts to SourceConfig objects
            source_configs = []
            for src in sources:
                src_type = src.get("type", "file")
                config = SourceConfig(
                    type=SourceType(src_type),
                    path=src.get("path"),
                    pattern=src.get("pattern"),
                    query=src.get("query"),
                    tables=src.get("tables"),
                    description=src.get("description"),
                )
                source_configs.append(config)

            # Create bundle
            bundle = await service.create_bundle(
                name=title,
                sources=source_configs,
                ttl_hours=ttl_hours,
                tags=set(tags) if tags else None,
            )

            return {
                "success": True,
                "action": "create",
                "bundle_id": bundle.name,
                "content_preview": (bundle.content or "")[:500],
                "source_count": len(source_configs),
                "tags": list(bundle.tags) if bundle.tags else [],
                "ttl_hours": ttl_hours,
            }

        except Exception as e:
            logger.error(f"Failed to create bundle: {e}")
            return {"success": False, "error": str(e)}

    async def _list(self, stale_only: bool) -> Dict[str, Any]:
        """List all bundles."""
        from ...context.service import BundleService

        try:
            service = BundleService(working_dir=self.working_dir)
            bundles = await service.list_bundles()

            if stale_only:
                bundles = [b for b in bundles if b.is_stale]

            return {
                "success": True,
                "action": "list",
                "bundles": [
                    {
                        "name": b.name,
                        "tags": list(b.tags) if b.tags else [],
                        "is_stale": b.is_stale,
                        "ttl_hours": b.ttl_hours,
                        "updated_at": b.updated_at.isoformat() if b.updated_at else None,
                    }
                    for b in bundles
                ],
                "count": len(bundles),
                "stale_only": stale_only,
            }

        except Exception as e:
            logger.error(f"Failed to list bundles: {e}")
            return {"success": False, "error": str(e)}

    async def _show(self, bundle_id: Optional[str]) -> Dict[str, Any]:
        """Show bundle content and metadata."""
        if not bundle_id:
            return {"success": False, "error": "bundle_id is required for show action"}

        from ...context.service import BundleService

        try:
            service = BundleService(working_dir=self.working_dir)
            bundle = await service.get_bundle(bundle_id)

            if not bundle:
                return {"success": False, "error": f"Bundle not found: {bundle_id}"}

            return {
                "success": True,
                "action": "show",
                "bundle_id": bundle.name,
                "content": bundle.content,
                "tags": list(bundle.tags) if bundle.tags else [],
                "is_stale": bundle.is_stale,
                "ttl_hours": bundle.ttl_hours,
                "sources": [
                    {"type": s.type.value, "description": s.description}
                    for s in (bundle.sources or [])
                ],
                "updated_at": bundle.updated_at.isoformat() if bundle.updated_at else None,
            }

        except Exception as e:
            logger.error(f"Failed to show bundle: {e}")
            return {"success": False, "error": str(e)}

    async def _refresh_one(self, bundle_id: str, force: bool) -> Dict[str, Any]:
        """Refresh a single bundle."""
        from ...context.service import BundleService

        try:
            service = BundleService(working_dir=self.working_dir)
            result = await service.refresh_bundle(bundle_id, force=force)

            return {
                "success": True,
                "action": "refresh",
                "bundle_id": bundle_id,
                "changes_detected": result.get("changed", False),
                "content_preview": result.get("content", "")[:500] if result.get("content") else "",
            }

        except Exception as e:
            logger.error(f"Failed to refresh bundle: {e}")
            return {"success": False, "error": str(e)}

    async def _refresh_all(self) -> Dict[str, Any]:
        """Refresh all stale bundles."""
        from ...context.service import BundleService

        try:
            service = BundleService(working_dir=self.working_dir)
            bundles = await service.list_bundles()
            stale_bundles = [b for b in bundles if b.is_stale]

            refreshed = 0
            errors = []
            for bundle in stale_bundles:
                try:
                    await service.refresh_bundle(bundle.name)
                    refreshed += 1
                except Exception as e:
                    errors.append(f"{bundle.name}: {e}")

            return {
                "success": len(errors) == 0,
                "action": "refresh_all",
                "stale_count": len(stale_bundles),
                "refreshed": refreshed,
                "errors": errors,
            }

        except Exception as e:
            logger.error(f"Failed to refresh bundles: {e}")
            return {"success": False, "error": str(e)}

    async def _delete(self, bundle_id: Optional[str]) -> Dict[str, Any]:
        """Delete a bundle."""
        if not bundle_id:
            return {"success": False, "error": "bundle_id is required for delete action"}

        from ...context.service import BundleService

        try:
            service = BundleService(working_dir=self.working_dir)
            success = await service.delete_bundle(bundle_id)

            return {
                "success": success,
                "action": "delete",
                "bundle_id": bundle_id,
            }

        except Exception as e:
            logger.error(f"Failed to delete bundle: {e}")
            return {"success": False, "error": str(e)}

    async def _status(self) -> Dict[str, Any]:
        """Get status summary of all bundles."""
        from ...context.service import BundleService

        try:
            service = BundleService(working_dir=self.working_dir)
            bundles = await service.list_bundles()

            total = len(bundles)
            stale = sum(1 for b in bundles if b.is_stale)

            # Count by tag
            tag_counts: Dict[str, int] = {}
            for bundle in bundles:
                if bundle.tags:
                    for tag in bundle.tags:
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1

            return {
                "success": True,
                "action": "status",
                "total": total,
                "stale_count": stale,
                "fresh_count": total - stale,
                "by_tag": tag_counts,
            }

        except Exception as e:
            logger.error(f"Failed to get status: {e}")
            return {"success": False, "error": str(e)}

    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch using this delegate.

        This method is called by TaskExecutor for context_bundle batches.
        The batch params should contain the action and relevant parameters.

        Args:
            batch: The batch to execute
            context: Context from previous batches

        Returns:
            Dict with success, output, and optional summary
        """
        params = batch.params or {}
        action = params.get("action", "list")

        # Execute the action
        result = await self.execute(
            action=action,
            bundle_id=params.get("bundle_id") or params.get("name"),
            title=params.get("title") or params.get("name"),
            sources=params.get("sources"),
            ttl_hours=params.get("ttl_hours", 24),
            tags=params.get("tags"),
            force=params.get("force", False),
            stale_only=params.get("stale_only", False),
        )

        # Format output for batch
        output = self._format_output(result)
        summary = self._generate_summary(result)

        return {
            "success": result.get("success", False),
            "output": output,
            "summary": summary,
        }

    def _format_output(self, result: Dict[str, Any]) -> str:
        """Format result as markdown output."""
        action = result.get("action", "unknown")
        lines = [f"# Context Bundle {action.title()} Results\n"]

        if not result.get("success"):
            lines.append(f"**Error:** {result.get('error', 'Unknown error')}")
            return "\n".join(lines)

        if action == "create":
            lines.append(f"**Bundle Created:** {result.get('bundle_id')}")
            lines.append(f"**Sources:** {result.get('source_count', 0)}")
            lines.append(f"**TTL:** {result.get('ttl_hours')} hours")
            if result.get("tags"):
                lines.append(f"**Tags:** {', '.join(result['tags'])}")
            if result.get("content_preview"):
                lines.append("\n**Preview:**")
                lines.append(f"```\n{result['content_preview']}\n```")

        elif action == "list":
            lines.append(f"**Bundles:** {result.get('count', 0)}")
            if result.get("stale_only"):
                lines.append("*(showing stale only)*")
            lines.append("")
            for b in result.get("bundles", []):
                status = "STALE" if b.get("is_stale") else "fresh"
                tags = f" [{', '.join(b['tags'])}]" if b.get("tags") else ""
                lines.append(f"- **{b['name']}** ({status}){tags}")

        elif action == "show":
            lines.append(f"**Bundle:** {result.get('bundle_id')}")
            lines.append(f"**Status:** {'STALE' if result.get('is_stale') else 'Fresh'}")
            lines.append(f"**TTL:** {result.get('ttl_hours')} hours")
            if result.get("tags"):
                lines.append(f"**Tags:** {', '.join(result['tags'])}")
            if result.get("sources"):
                lines.append("\n**Sources:**")
                for s in result["sources"]:
                    lines.append(f"- {s['type']}: {s.get('description', 'N/A')}")
            if result.get("content"):
                lines.append("\n**Content:**")
                lines.append(f"```\n{result['content'][:2000]}\n```")
                if len(result.get("content", "")) > 2000:
                    lines.append("...[truncated]...")

        elif action == "refresh":
            lines.append(f"**Bundle:** {result.get('bundle_id')}")
            lines.append(f"**Changes Detected:** {'Yes' if result.get('changes_detected') else 'No'}")
            if result.get("content_preview"):
                lines.append("\n**Preview:**")
                lines.append(f"```\n{result['content_preview']}\n```")

        elif action == "refresh_all":
            lines.append(f"**Stale Bundles:** {result.get('stale_count', 0)}")
            lines.append(f"**Refreshed:** {result.get('refreshed', 0)}")
            if result.get("errors"):
                lines.append("\n**Errors:**")
                for err in result["errors"]:
                    lines.append(f"- {err}")

        elif action == "delete":
            lines.append(f"**Deleted:** {result.get('bundle_id')}")

        elif action == "status":
            lines.append(f"**Total Bundles:** {result.get('total', 0)}")
            lines.append(f"**Fresh:** {result.get('fresh_count', 0)}")
            lines.append(f"**Stale:** {result.get('stale_count', 0)}")
            if result.get("by_tag"):
                lines.append("\n**By Tag:**")
                for tag, count in result["by_tag"].items():
                    lines.append(f"- {tag}: {count}")

        return "\n".join(lines)

    def _generate_summary(self, result: Dict[str, Any]) -> str:
        """Generate a concise summary for context chaining."""
        action = result.get("action", "unknown")

        if not result.get("success"):
            return f"Context bundle {action} failed: {result.get('error', 'Unknown error')}"

        if action == "create":
            return f"Created bundle: {result.get('bundle_id')} with {result.get('source_count', 0)} sources"

        elif action == "list":
            return f"Found {result.get('count', 0)} bundles"

        elif action == "show":
            status = "stale" if result.get("is_stale") else "fresh"
            return f"Bundle {result.get('bundle_id')} is {status}"

        elif action == "refresh":
            changed = "changed" if result.get("changes_detected") else "unchanged"
            return f"Refreshed {result.get('bundle_id')} ({changed})"

        elif action == "refresh_all":
            return f"Refreshed {result.get('refreshed', 0)} of {result.get('stale_count', 0)} stale bundles"

        elif action == "delete":
            return f"Deleted bundle: {result.get('bundle_id')}"

        elif action == "status":
            return f"{result.get('total', 0)} bundles ({result.get('stale_count', 0)} stale)"

        return f"Context bundle {action} completed"
