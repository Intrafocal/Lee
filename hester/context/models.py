"""
Hester Context Bundle Models - Data structures for context bundles.

Bundles are stored as:
- .hester/context/bundles/<id>.md - Synthesized markdown (portable)
- .hester/context/.meta/<id>.yaml - Source specs + hashes (machinery)
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml
from pydantic import BaseModel, Field


class SourceType(str, Enum):
    """Types of sources that can be included in a context bundle."""

    FILE = "file"
    GLOB = "glob"
    GREP = "grep"
    SEMANTIC = "semantic"
    DB_SCHEMA = "db_schema"


class FileSource(BaseModel):
    """A single file source."""

    type: SourceType = SourceType.FILE
    path: str = Field(description="Path to the file (relative to working directory)")
    content_hash: str = Field(default="", description="SHA256 hash of file content")


class GlobSource(BaseModel):
    """A glob pattern source that matches multiple files."""

    type: SourceType = SourceType.GLOB
    pattern: str = Field(description="Glob pattern (e.g., '**/*.py')")
    exclude: List[str] = Field(
        default_factory=list, description="Patterns to exclude"
    )
    paths_hash: str = Field(
        default="", description="Hash of sorted matched paths + contents"
    )


class GrepSource(BaseModel):
    """A grep/regex pattern source that searches file contents."""

    type: SourceType = SourceType.GREP
    pattern: str = Field(description="Regex pattern to search for")
    paths: List[str] = Field(
        default_factory=lambda: ["."], description="Paths to search in"
    )
    context_lines: int = Field(default=2, description="Lines of context around matches")
    matches_hash: str = Field(default="", description="Hash of match results")


class SemanticSource(BaseModel):
    """A semantic search source using doc embeddings."""

    type: SourceType = SourceType.SEMANTIC
    query: str = Field(description="Natural language query")
    limit: int = Field(default=5, description="Maximum results to include")
    min_similarity: float = Field(
        default=0.6, description="Minimum similarity threshold"
    )
    results_hash: str = Field(default="", description="Hash of search results")


class DbSchemaSource(BaseModel):
    """A database schema source."""

    type: SourceType = SourceType.DB_SCHEMA
    tables: List[str] = Field(description="Table names to include")
    include_rls: bool = Field(default=False, description="Include RLS policies")
    schema_hash: str = Field(default="", description="Hash of schema definition")


# Union type for all source specs
SourceSpec = Union[FileSource, GlobSource, GrepSource, SemanticSource, DbSchemaSource]


class BundleMetadata(BaseModel):
    """Metadata for a context bundle, stored in .meta/<id>.yaml."""

    id: str = Field(description="Bundle identifier (hyphenated)")
    title: str = Field(description="Human-readable title")
    created: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    ttl_hours: int = Field(default=24, description="Time-to-live in hours (0=manual)")
    tags: List[str] = Field(default_factory=list, description="Tags for categorization")
    sources: List[SourceSpec] = Field(
        default_factory=list, description="Source specifications"
    )
    bundle_content_hash: str = Field(
        default="", description="Hash of synthesized content"
    )

    def to_yaml(self) -> str:
        """Serialize to YAML for .meta file."""
        data = self.model_dump()
        # Convert datetimes to ISO format strings
        data["created"] = self.created.isoformat()
        data["updated"] = self.updated.isoformat()
        # Convert source types to strings
        for source in data["sources"]:
            source["type"] = source["type"].value if hasattr(source["type"], "value") else source["type"]
        return yaml.dump(data, default_flow_style=False, sort_keys=False)

    @classmethod
    def from_yaml(cls, yaml_str: str) -> "BundleMetadata":
        """Parse from YAML string."""
        data = yaml.safe_load(yaml_str)
        # Parse datetimes
        if isinstance(data.get("created"), str):
            data["created"] = datetime.fromisoformat(data["created"].replace("Z", "+00:00"))
        if isinstance(data.get("updated"), str):
            data["updated"] = datetime.fromisoformat(data["updated"].replace("Z", "+00:00"))
        # Parse sources
        sources = []
        for source_data in data.get("sources", []):
            source_type = source_data.get("type", "file")
            if source_type == "file":
                sources.append(FileSource(**source_data))
            elif source_type == "glob":
                sources.append(GlobSource(**source_data))
            elif source_type == "grep":
                sources.append(GrepSource(**source_data))
            elif source_type == "semantic":
                sources.append(SemanticSource(**source_data))
            elif source_type == "db_schema":
                sources.append(DbSchemaSource(**source_data))
        data["sources"] = sources
        return cls(**data)


@dataclass
class BundleStatus:
    """Status information for a bundle, including staleness."""

    id: str
    title: str
    updated: datetime
    ttl_hours: int
    source_count: int = 0
    tags: List[str] = field(default_factory=list)

    @property
    def age_hours(self) -> float:
        """Hours since last update."""
        now = datetime.now(timezone.utc)
        # Ensure updated has timezone info
        updated = self.updated
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        delta = now - updated
        return delta.total_seconds() / 3600

    @property
    def is_stale(self) -> bool:
        """Whether the bundle is stale based on TTL."""
        if self.ttl_hours == 0:
            return False
        return self.age_hours > self.ttl_hours

    @property
    def staleness_label(self) -> str:
        """Human-readable staleness label."""
        if not self.is_stale:
            return "OK"
        age = self.age_hours
        if age < 48:
            return f"STALE {int(age)}h"
        return f"STALE {int(age / 24)}d"


class ContextBundle(BaseModel):
    """A complete context bundle with metadata and synthesized content."""

    metadata: BundleMetadata
    content: str = Field(default="", description="Synthesized markdown content")

    def to_markdown(self) -> str:
        """
        Render bundle as markdown with YAML frontmatter.

        Format:
        ---
        id: bundle-id
        title: Bundle Title
        created: 2026-01-03T10:00:00Z
        updated: 2026-01-03T12:30:00Z
        ttl_hours: 24
        tags: [tag1, tag2]
        ---

        # Bundle Title

        [Synthesized content]
        """
        frontmatter = {
            "id": self.metadata.id,
            "title": self.metadata.title,
            "created": self.metadata.created.isoformat(),
            "updated": self.metadata.updated.isoformat(),
            "ttl_hours": self.metadata.ttl_hours,
            "tags": self.metadata.tags,
        }
        yaml_str = yaml.dump(frontmatter, default_flow_style=False, sort_keys=False)
        return f"---\n{yaml_str}---\n\n{self.content}"

    @classmethod
    def from_markdown(
        cls, markdown_str: str, meta: Optional[BundleMetadata] = None
    ) -> "ContextBundle":
        """
        Parse bundle from markdown string.

        Args:
            markdown_str: Markdown with YAML frontmatter
            meta: Optional pre-loaded metadata (from .meta file)
        """
        # Parse frontmatter
        frontmatter_match = re.match(
            r"^---\n(.*?)\n---\n\n?(.*)", markdown_str, re.DOTALL
        )

        if not frontmatter_match:
            # No frontmatter, treat entire content as body
            if meta:
                return cls(metadata=meta, content=markdown_str)
            raise ValueError("No frontmatter found and no metadata provided")

        frontmatter_str, content = frontmatter_match.groups()
        frontmatter = yaml.safe_load(frontmatter_str)

        if meta:
            # Use provided metadata but update from frontmatter
            metadata = meta
        else:
            # Build metadata from frontmatter
            metadata = BundleMetadata(
                id=frontmatter.get("id", "unknown"),
                title=frontmatter.get("title", "Untitled"),
                created=datetime.fromisoformat(
                    frontmatter.get("created", datetime.now(timezone.utc).isoformat()).replace("Z", "+00:00")
                ),
                updated=datetime.fromisoformat(
                    frontmatter.get("updated", datetime.now(timezone.utc).isoformat()).replace("Z", "+00:00")
                ),
                ttl_hours=frontmatter.get("ttl_hours", 24),
                tags=frontmatter.get("tags", []),
            )

        return cls(metadata=metadata, content=content.strip())

    def get_status(self) -> BundleStatus:
        """Get status object for this bundle."""
        return BundleStatus(
            id=self.metadata.id,
            title=self.metadata.title,
            updated=self.metadata.updated,
            ttl_hours=self.metadata.ttl_hours,
            source_count=len(self.metadata.sources),
            tags=self.metadata.tags,
        )


@dataclass
class RefreshResult:
    """Result of refreshing a bundle."""

    bundle_id: str
    success: bool
    changed: bool = False
    error: Optional[str] = None
    sources_evaluated: int = 0
    sources_changed: int = 0
    message: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "bundle_id": self.bundle_id,
            "success": self.success,
            "changed": self.changed,
            "error": self.error,
            "sources_evaluated": self.sources_evaluated,
            "sources_changed": self.sources_changed,
            "message": self.message,
        }
