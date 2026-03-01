"""
Hester Context Bundle Tools - Tool handlers for context bundle operations.

These handlers are called by the ReAct agent to manage context bundles.
"""

import logging
from typing import Any, Dict, List, Optional

from hester.context import (
    FileSource,
    GlobSource,
    GrepSource,
    SemanticSource,
    DbSchemaSource,
)
from hester.context.service import ContextBundleService

logger = logging.getLogger("hester.daemon.tools.context_tools")


def _parse_source(source_dict: Dict[str, Any]):
    """Parse a source dictionary into the appropriate SourceSpec type."""
    source_type = source_dict.get("type", "")

    if source_type == "file":
        return FileSource(path=source_dict.get("path", ""))
    elif source_type == "glob":
        return GlobSource(
            pattern=source_dict.get("pattern", ""),
            exclude=source_dict.get("exclude", []),
        )
    elif source_type == "grep":
        return GrepSource(
            pattern=source_dict.get("pattern", ""),
            paths=source_dict.get("paths", ["."]),
            context_lines=source_dict.get("context_lines", 2),
        )
    elif source_type == "semantic":
        return SemanticSource(
            query=source_dict.get("query", ""),
            limit=source_dict.get("limit", 5),
            min_similarity=source_dict.get("min_similarity", 0.6),
        )
    elif source_type == "db_schema":
        return DbSchemaSource(
            tables=source_dict.get("tables", []),
            include_rls=source_dict.get("include_rls", False),
        )
    else:
        raise ValueError(f"Unknown source type: {source_type}")


async def create_context_bundle(
    bundle_id: str,
    title: str,
    sources: List[Dict[str, Any]],
    working_dir: str,
    ttl_hours: int = 24,
    tags: Optional[List[str]] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Create a new context bundle.

    Args:
        bundle_id: Unique identifier (hyphenated)
        title: Human-readable title
        sources: List of source specifications
        working_dir: Working directory
        ttl_hours: Time-to-live in hours
        tags: Optional tags

    Returns:
        Dict with bundle info or error
    """
    if kwargs:
        logger.debug(f"create_context_bundle ignoring extra kwargs: {list(kwargs.keys())}")

    try:
        # Parse sources
        parsed_sources = []
        for source_dict in sources:
            try:
                parsed_sources.append(_parse_source(source_dict))
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Invalid source: {e}",
                }

        if not parsed_sources:
            return {
                "success": False,
                "error": "No valid sources provided",
            }

        # Create bundle
        service = ContextBundleService(working_dir)
        bundle = await service.create(
            bundle_id=bundle_id,
            title=title,
            sources=parsed_sources,
            ttl_hours=ttl_hours,
            tags=tags or [],
        )

        return {
            "success": True,
            "bundle_id": bundle.metadata.id,
            "title": bundle.metadata.title,
            "sources_count": len(bundle.metadata.sources),
            "content_preview": bundle.content[:500] + "..." if len(bundle.content) > 500 else bundle.content,
            "location": f".hester/context/bundles/{bundle_id}.md",
        }

    except Exception as e:
        logger.error(f"Error creating context bundle: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def get_context_bundle(
    bundle_id: str,
    working_dir: str,
    **kwargs,
) -> Dict[str, Any]:
    """
    Get the content of a context bundle.

    Args:
        bundle_id: Bundle identifier
        working_dir: Working directory

    Returns:
        Dict with bundle content or error
    """
    if kwargs:
        logger.debug(f"get_context_bundle ignoring extra kwargs: {list(kwargs.keys())}")

    try:
        service = ContextBundleService(working_dir)
        bundle = service.get(bundle_id)

        if not bundle:
            return {
                "success": False,
                "error": f"Bundle not found: {bundle_id}",
            }

        status = bundle.get_status()

        return {
            "success": True,
            "bundle_id": bundle.metadata.id,
            "title": bundle.metadata.title,
            "content": bundle.content,
            "is_stale": status.is_stale,
            "age_hours": round(status.age_hours, 1),
            "sources_count": len(bundle.metadata.sources),
            "tags": bundle.metadata.tags,
        }

    except Exception as e:
        logger.error(f"Error getting context bundle: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def list_context_bundles(
    working_dir: str,
    stale_only: bool = False,
    **kwargs,
) -> Dict[str, Any]:
    """
    List all available context bundles.

    Args:
        working_dir: Working directory
        stale_only: Only show stale bundles

    Returns:
        Dict with list of bundles
    """
    if kwargs:
        logger.debug(f"list_context_bundles ignoring extra kwargs: {list(kwargs.keys())}")

    try:
        service = ContextBundleService(working_dir)
        statuses = service.list_all()

        if stale_only:
            statuses = [s for s in statuses if s.is_stale]

        bundles = []
        for status in statuses:
            bundles.append({
                "id": status.id,
                "title": status.title,
                "is_stale": status.is_stale,
                "staleness_label": status.staleness_label,
                "age_hours": round(status.age_hours, 1),
                "ttl_hours": status.ttl_hours,
                "source_count": status.source_count,
                "tags": status.tags,
            })

        return {
            "success": True,
            "count": len(bundles),
            "bundles": bundles,
        }

    except Exception as e:
        logger.error(f"Error listing context bundles: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def refresh_context_bundle(
    bundle_id: str,
    working_dir: str,
    force: bool = False,
    **kwargs,
) -> Dict[str, Any]:
    """
    Refresh a context bundle.

    Args:
        bundle_id: Bundle identifier
        working_dir: Working directory
        force: Force refresh even if unchanged

    Returns:
        Dict with refresh result
    """
    if kwargs:
        logger.debug(f"refresh_context_bundle ignoring extra kwargs: {list(kwargs.keys())}")

    try:
        service = ContextBundleService(working_dir)
        result = await service.refresh(bundle_id, force=force)

        return {
            "success": result.success,
            "bundle_id": result.bundle_id,
            "changed": result.changed,
            "sources_evaluated": result.sources_evaluated,
            "sources_changed": result.sources_changed,
            "message": result.message,
            "error": result.error,
        }

    except Exception as e:
        logger.error(f"Error refreshing context bundle: {e}")
        return {
            "success": False,
            "error": str(e),
        }


async def add_bundle_source(
    bundle_id: str,
    source: Dict[str, Any],
    working_dir: str,
    **kwargs,
) -> Dict[str, Any]:
    """
    Add a source to an existing bundle.

    Args:
        bundle_id: Bundle identifier
        source: Source specification
        working_dir: Working directory

    Returns:
        Dict with updated bundle info
    """
    if kwargs:
        logger.debug(f"add_bundle_source ignoring extra kwargs: {list(kwargs.keys())}")

    try:
        # Parse source
        try:
            parsed_source = _parse_source(source)
        except Exception as e:
            return {
                "success": False,
                "error": f"Invalid source: {e}",
            }

        service = ContextBundleService(working_dir)
        bundle = await service.add_source(bundle_id, parsed_source)

        if not bundle:
            return {
                "success": False,
                "error": f"Bundle not found: {bundle_id}",
            }

        return {
            "success": True,
            "bundle_id": bundle.metadata.id,
            "title": bundle.metadata.title,
            "sources_count": len(bundle.metadata.sources),
            "message": f"Added source and refreshed bundle",
        }

    except Exception as e:
        logger.error(f"Error adding bundle source: {e}")
        return {
            "success": False,
            "error": str(e),
        }
