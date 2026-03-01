"""
Hester Context Bundle Service - Create, refresh, and manage context bundles.

Bundles are stored as:
- .hester/context/bundles/<id>.md - Synthesized markdown (portable)
- .hester/context/.meta/<id>.yaml - Source specs + hashes (machinery)
"""

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from hester.context.models import (
    BundleMetadata,
    BundleStatus,
    ContextBundle,
    DbSchemaSource,
    FileSource,
    GlobSource,
    GrepSource,
    RefreshResult,
    SemanticSource,
    SourceSpec,
)
from hester.context.prompts import (
    BUNDLE_SYNTHESIS_PROMPT,
    format_sources_for_synthesis,
)
from hester.context.sources import evaluate_all_sources

logger = logging.getLogger("hester.context.service")


class ContextBundleService:
    """
    Service for creating and managing context bundles.

    Context bundles aggregate information from multiple sources into
    AI-synthesized markdown documents for rapid knowledge injection.
    """

    def __init__(
        self,
        working_dir: str,
        synthesize_fn: Optional[Callable[[str], str]] = None,
        doc_embedding_service: Optional[Any] = None,
    ):
        """
        Initialize the context bundle service.

        Args:
            working_dir: Working directory (usually repo root)
            synthesize_fn: Optional custom AI synthesis function
            doc_embedding_service: Optional DocEmbeddingService for semantic search
        """
        self.working_dir = Path(working_dir).resolve()
        self._synthesize_fn = synthesize_fn
        self._doc_service = doc_embedding_service

        # Setup directories
        self.hester_dir = self.working_dir / ".hester"
        self.context_dir = self.hester_dir / "context"
        self.bundles_dir = self.context_dir / "bundles"
        self.meta_dir = self.context_dir / ".meta"

        # Lazy-loaded Gemini client
        self._gemini_client = None

    def _ensure_dirs(self) -> None:
        """Ensure required directories exist."""
        self.bundles_dir.mkdir(parents=True, exist_ok=True)
        self.meta_dir.mkdir(parents=True, exist_ok=True)

    def _get_bundle_path(self, bundle_id: str) -> Path:
        """Get path to bundle markdown file."""
        return self.bundles_dir / f"{bundle_id}.md"

    def _get_meta_path(self, bundle_id: str) -> Path:
        """Get path to bundle metadata file."""
        return self.meta_dir / f"{bundle_id}.yaml"

    def _get_gemini_client(self):
        """Get or create Gemini client."""
        if self._gemini_client is None:
            from google import genai
            self._gemini_client = genai.Client()
        return self._gemini_client

    async def _synthesize(self, title: str, sources_content: str) -> str:
        """
        Synthesize bundle content using AI.

        Args:
            title: Bundle title
            sources_content: Formatted source content

        Returns:
            Synthesized markdown content
        """
        # Use custom synthesis function if provided
        if self._synthesize_fn:
            prompt = BUNDLE_SYNTHESIS_PROMPT.format(
                title=title,
                sources_content=sources_content,
            )
            return await self._synthesize_fn(prompt)

        # Use Gemini
        try:
            client = self._get_gemini_client()
            prompt = BUNDLE_SYNTHESIS_PROMPT.format(
                title=title,
                sources_content=sources_content,
            )

            response = client.models.generate_content(
                model="gemini-2.0-flash",
                contents=prompt,
            )

            return response.text.strip() if response.text else f"# {title}\n\n*Synthesis failed*"

        except Exception as e:
            logger.error(f"Synthesis error: {e}")
            return f"# {title}\n\n*Synthesis error: {e}*\n\n## Raw Sources\n\n{sources_content}"

    async def create(
        self,
        bundle_id: str,
        title: str,
        sources: List[SourceSpec],
        ttl_hours: int = 24,
        tags: Optional[List[str]] = None,
    ) -> ContextBundle:
        """
        Create a new context bundle.

        Args:
            bundle_id: Unique identifier (hyphenated, e.g., "auth-system")
            title: Human-readable title
            sources: List of source specifications
            ttl_hours: Time-to-live in hours (0=manual refresh only)
            tags: Optional tags for categorization

        Returns:
            Created ContextBundle
        """
        self._ensure_dirs()

        # Evaluate all sources
        evaluated = await evaluate_all_sources(
            sources=sources,
            working_dir=str(self.working_dir),
            doc_service=self._doc_service,
        )

        # Collect content for synthesis
        sources_content = []
        for eval_result in evaluated:
            if eval_result["content"]:
                sources_content.append(eval_result["content"])

        # Synthesize bundle content
        content = await self._synthesize(
            title=title,
            sources_content="\n\n".join(sources_content),
        )

        # Update source hashes
        updated_sources = []
        for i, source in enumerate(sources):
            eval_result = evaluated[i]
            hash_value = eval_result["hash"]

            # Clone source with updated hash
            if isinstance(source, FileSource):
                updated = source.model_copy(update={"content_hash": hash_value})
            elif isinstance(source, GlobSource):
                updated = source.model_copy(update={"paths_hash": hash_value})
            elif isinstance(source, GrepSource):
                updated = source.model_copy(update={"matches_hash": hash_value})
            elif isinstance(source, SemanticSource):
                updated = source.model_copy(update={"results_hash": hash_value})
            elif isinstance(source, DbSchemaSource):
                updated = source.model_copy(update={"schema_hash": hash_value})
            else:
                updated = source

            updated_sources.append(updated)

        # Create metadata
        now = datetime.now(timezone.utc)
        metadata = BundleMetadata(
            id=bundle_id,
            title=title,
            created=now,
            updated=now,
            ttl_hours=ttl_hours,
            tags=tags or [],
            sources=updated_sources,
        )

        # Create bundle
        bundle = ContextBundle(metadata=metadata, content=content)

        # Save files
        bundle_path = self._get_bundle_path(bundle_id)
        meta_path = self._get_meta_path(bundle_id)

        bundle_path.write_text(bundle.to_markdown())
        meta_path.write_text(metadata.to_yaml())

        logger.info(f"Created bundle '{bundle_id}' with {len(sources)} sources")
        return bundle

    async def refresh(
        self,
        bundle_id: str,
        force: bool = False,
    ) -> RefreshResult:
        """
        Refresh a bundle if sources have changed.

        Args:
            bundle_id: Bundle identifier
            force: Force refresh even if sources unchanged

        Returns:
            RefreshResult with details
        """
        # Load existing bundle
        bundle = self.get(bundle_id)
        if not bundle:
            return RefreshResult(
                bundle_id=bundle_id,
                success=False,
                error=f"Bundle not found: {bundle_id}",
            )

        metadata = bundle.metadata

        # Evaluate all sources
        evaluated = await evaluate_all_sources(
            sources=metadata.sources,
            working_dir=str(self.working_dir),
            doc_service=self._doc_service,
        )

        # Check for changes
        sources_changed = sum(1 for e in evaluated if e["changed"])

        if not force and sources_changed == 0:
            return RefreshResult(
                bundle_id=bundle_id,
                success=True,
                changed=False,
                sources_evaluated=len(evaluated),
                sources_changed=0,
                message="No changes detected",
            )

        # Collect content for synthesis
        sources_content = [e["content"] for e in evaluated if e["content"]]

        # Re-synthesize
        content = await self._synthesize(
            title=metadata.title,
            sources_content="\n\n".join(sources_content),
        )

        # Update source hashes
        updated_sources = []
        for i, source in enumerate(metadata.sources):
            eval_result = evaluated[i]
            hash_value = eval_result["hash"]

            if isinstance(source, FileSource):
                updated = source.model_copy(update={"content_hash": hash_value})
            elif isinstance(source, GlobSource):
                updated = source.model_copy(update={"paths_hash": hash_value})
            elif isinstance(source, GrepSource):
                updated = source.model_copy(update={"matches_hash": hash_value})
            elif isinstance(source, SemanticSource):
                updated = source.model_copy(update={"results_hash": hash_value})
            elif isinstance(source, DbSchemaSource):
                updated = source.model_copy(update={"schema_hash": hash_value})
            else:
                updated = source

            updated_sources.append(updated)

        # Update metadata
        metadata.sources = updated_sources
        metadata.updated = datetime.now(timezone.utc)

        # Update bundle
        bundle.metadata = metadata
        bundle.content = content

        # Save files
        bundle_path = self._get_bundle_path(bundle_id)
        meta_path = self._get_meta_path(bundle_id)

        bundle_path.write_text(bundle.to_markdown())
        meta_path.write_text(metadata.to_yaml())

        logger.info(f"Refreshed bundle '{bundle_id}' ({sources_changed} sources changed)")

        return RefreshResult(
            bundle_id=bundle_id,
            success=True,
            changed=True,
            sources_evaluated=len(evaluated),
            sources_changed=sources_changed,
            message=f"Refreshed with {sources_changed} source changes",
        )

    async def refresh_stale(self) -> List[RefreshResult]:
        """
        Refresh all stale bundles.

        Returns:
            List of RefreshResult for each refreshed bundle
        """
        results = []
        statuses = self.list_all()

        for status in statuses:
            if status.is_stale:
                result = await self.refresh(status.id)
                results.append(result)

        return results

    def get(self, bundle_id: str) -> Optional[ContextBundle]:
        """
        Get a bundle by ID.

        Args:
            bundle_id: Bundle identifier

        Returns:
            ContextBundle if found, None otherwise
        """
        bundle_path = self._get_bundle_path(bundle_id)
        meta_path = self._get_meta_path(bundle_id)

        if not bundle_path.exists():
            return None

        # Load metadata
        metadata = None
        if meta_path.exists():
            try:
                metadata = BundleMetadata.from_yaml(meta_path.read_text())
            except Exception as e:
                logger.warning(f"Failed to load metadata for {bundle_id}: {e}")

        # Load bundle
        try:
            return ContextBundle.from_markdown(
                bundle_path.read_text(),
                meta=metadata,
            )
        except Exception as e:
            logger.error(f"Failed to load bundle {bundle_id}: {e}")
            return None

    def list_all(self) -> List[BundleStatus]:
        """
        List all bundles with their status.

        Returns:
            List of BundleStatus objects
        """
        if not self.bundles_dir.exists():
            return []

        statuses = []
        for bundle_file in self.bundles_dir.glob("*.md"):
            bundle_id = bundle_file.stem
            bundle = self.get(bundle_id)
            if bundle:
                statuses.append(bundle.get_status())

        # Sort by updated time (newest first)
        statuses.sort(key=lambda s: s.updated, reverse=True)
        return statuses

    def delete(self, bundle_id: str) -> bool:
        """
        Delete a bundle.

        Args:
            bundle_id: Bundle identifier

        Returns:
            True if deleted, False if not found
        """
        bundle_path = self._get_bundle_path(bundle_id)
        meta_path = self._get_meta_path(bundle_id)

        deleted = False

        if bundle_path.exists():
            bundle_path.unlink()
            deleted = True

        if meta_path.exists():
            meta_path.unlink()
            deleted = True

        if deleted:
            logger.info(f"Deleted bundle '{bundle_id}'")

        return deleted

    async def add_source(
        self,
        bundle_id: str,
        source: SourceSpec,
    ) -> Optional[ContextBundle]:
        """
        Add a source to an existing bundle and refresh.

        Args:
            bundle_id: Bundle identifier
            source: Source to add

        Returns:
            Updated ContextBundle if successful, None if bundle not found
        """
        bundle = self.get(bundle_id)
        if not bundle:
            return None

        # Add source
        bundle.metadata.sources.append(source)

        # Refresh to incorporate new source
        await self.refresh(bundle_id, force=True)

        return self.get(bundle_id)

    def get_content(self, bundle_id: str) -> Optional[str]:
        """
        Get just the content of a bundle (for injection).

        Args:
            bundle_id: Bundle identifier

        Returns:
            Bundle content string, or None if not found
        """
        bundle = self.get(bundle_id)
        return bundle.content if bundle else None

    def prune(self, older_than_hours: int = 168) -> List[str]:
        """
        Delete bundles older than specified hours.

        Args:
            older_than_hours: Delete bundles not updated in this many hours (default: 1 week)

        Returns:
            List of deleted bundle IDs
        """
        deleted = []
        statuses = self.list_all()

        for status in statuses:
            if status.age_hours > older_than_hours:
                if self.delete(status.id):
                    deleted.append(status.id)

        return deleted

    def copy_to_clipboard(self, bundle_id: str) -> bool:
        """
        Copy bundle content to clipboard.

        Args:
            bundle_id: Bundle identifier

        Returns:
            True if successful, False if bundle not found or clipboard failed
        """
        content = self.get_content(bundle_id)
        if not content:
            return False

        try:
            import subprocess
            process = subprocess.Popen(
                ["pbcopy"],
                stdin=subprocess.PIPE,
            )
            process.communicate(content.encode("utf-8"))
            return process.returncode == 0
        except Exception as e:
            logger.warning(f"Clipboard copy failed: {e}")
            # Try pyperclip as fallback
            try:
                import pyperclip
                pyperclip.copy(content)
                return True
            except ImportError:
                return False
            except Exception:
                return False
