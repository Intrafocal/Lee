"""
Hester Context Bundles - Reusable, AI-synthesized context packages.

Context Bundles aggregate information from multiple sources (files, grep patterns,
semantic search, database schemas) into portable markdown files for rapid knowledge
injection into AI tools and conversations.
"""

from hester.context.models import (
    SourceType,
    FileSource,
    GlobSource,
    GrepSource,
    SemanticSource,
    DbSchemaSource,
    SourceSpec,
    BundleMetadata,
    BundleStatus,
    ContextBundle,
    RefreshResult,
)
from hester.context.service import ContextBundleService

__all__ = [
    # Source types
    "SourceType",
    "FileSource",
    "GlobSource",
    "GrepSource",
    "SemanticSource",
    "DbSchemaSource",
    "SourceSpec",
    # Bundle types
    "BundleMetadata",
    "BundleStatus",
    "ContextBundle",
    "RefreshResult",
    # Service
    "ContextBundleService",
]
