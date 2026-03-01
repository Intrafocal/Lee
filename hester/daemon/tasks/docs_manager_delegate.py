"""
Docs Manager Delegate - Comprehensive documentation management subagent.

This delegate handles all documentation operations:
- Search: Semantic search over documentation
- Check: Check docs for drift against code
- Claims: Extract verifiable claims from docs
- Index: Index files for vector search
- Status: Get index status
- Write: Create new markdown files
- Update: Update existing markdown files
"""

import logging
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hester.daemon.tasks.docs_manager_delegate")


class DocsAction(str, Enum):
    """Actions supported by the docs manager delegate."""

    SEARCH = "search"      # Semantic search over docs
    CHECK = "check"        # Check drift against code
    CLAIMS = "claims"      # Extract claims from a file
    INDEX = "index"        # Index files for search
    STATUS = "status"      # Get index status
    WRITE = "write"        # Create new markdown file
    UPDATE = "update"      # Update existing markdown file


class DocsManagerDelegate:
    """
    Comprehensive documentation management delegate.

    Wraps HesterDocsAgent and DocEmbeddingService to provide:
    - Read operations: search, check, claims, index, status
    - Write operations: write, update

    Used as a batch delegate for task execution.
    """

    def __init__(self, working_dir: Path):
        """
        Initialize the docs manager delegate.

        Args:
            working_dir: Working directory for file operations
        """
        self.working_dir = Path(working_dir)
        logger.info(f"DocsManagerDelegate initialized: working_dir={working_dir}")

    async def execute(
        self,
        action: DocsAction,
        query: Optional[str] = None,
        doc_path: Optional[str] = None,
        content: Optional[str] = None,
        section: Optional[str] = None,
        append: bool = False,
        overwrite: bool = False,
        limit: int = 5,
        threshold: float = 0.7,
        claim_types: Optional[List[str]] = None,
        patterns: Optional[List[str]] = None,
        clear: bool = False,
    ) -> Dict[str, Any]:
        """
        Execute a documentation action.

        Args:
            action: The action to perform (search, check, claims, index, status, write, update)
            query: Search query (for search action)
            doc_path: Document path (for check, claims, index, write, update)
            content: Content to write (for write, update)
            section: Section heading to update (for update)
            append: Append to file instead of replace (for update)
            overwrite: Overwrite existing file (for write)
            limit: Max results (for search)
            threshold: Confidence threshold (for check)
            claim_types: Types of claims to extract (for claims)
            patterns: Glob patterns for indexing (for index)
            clear: Clear index before re-indexing (for index)

        Returns:
            Dict with operation results
        """
        action = DocsAction(action) if isinstance(action, str) else action

        if action == DocsAction.SEARCH:
            return await self._search(query, limit, patterns)
        elif action == DocsAction.CHECK:
            return await self._check(doc_path, threshold)
        elif action == DocsAction.CLAIMS:
            return await self._claims(doc_path, claim_types)
        elif action == DocsAction.INDEX:
            return await self._index(doc_path, patterns, clear)
        elif action == DocsAction.STATUS:
            return await self._status()
        elif action == DocsAction.WRITE:
            return await self._write(doc_path, content, overwrite)
        elif action == DocsAction.UPDATE:
            return await self._update(doc_path, content, section, append)
        else:
            return {"success": False, "error": f"Unknown action: {action}"}

    async def _search(
        self,
        query: Optional[str],
        limit: int,
        patterns: Optional[List[str]],
    ) -> Dict[str, Any]:
        """Semantic search over documentation."""
        if not query:
            return {"success": False, "error": "Query is required for search action"}

        from ...docs.agent import HesterDocsAgent

        agent = HesterDocsAgent(working_dir=str(self.working_dir))
        results = await agent.search(query=query, doc_patterns=patterns, limit=limit)

        return {
            "success": True,
            "action": "search",
            "query": query,
            "results": [
                {
                    "path": r.path,
                    "relevance": r.relevance,
                    "excerpt": r.excerpt,
                    "reason": r.reason,
                }
                for r in results
            ],
            "count": len(results),
        }

    async def _check(
        self,
        doc_path: Optional[str],
        threshold: float,
    ) -> Dict[str, Any]:
        """Check documentation for drift against code."""
        from ...docs.agent import HesterDocsAgent

        agent = HesterDocsAgent(working_dir=str(self.working_dir))

        if doc_path:
            # Check single file
            report = await agent.check_file(doc_path=doc_path, threshold=threshold)
            return {
                "success": True,
                "action": "check",
                "file_path": report.file_path,
                "total_claims": report.total_claims,
                "valid_claims": report.valid_claims,
                "drifted_count": len(report.drifted_claims),
                "unverifiable_count": len(report.unverifiable_claims),
                "drifted_claims": [
                    {
                        "claim": c.claim,
                        "type": c.claim_type,
                        "confidence": c.confidence,
                        "reason": c.reason,
                    }
                    for c in report.drifted_claims
                ],
                "threshold": threshold,
            }
        else:
            # Check all docs
            result = await agent.check_all(threshold=threshold)
            total_drifted = sum(len(r.drifted_claims) for r in result.reports)
            return {
                "success": result.success,
                "action": "check_all",
                "files_checked": len(result.reports),
                "total_drifted_claims": total_drifted,
                "reports": [
                    {
                        "file_path": r.file_path,
                        "total_claims": r.total_claims,
                        "valid_claims": r.valid_claims,
                        "drifted_count": len(r.drifted_claims),
                    }
                    for r in result.reports
                    if r.drifted_claims  # Only include files with drift
                ],
                "threshold": threshold,
            }

    async def _claims(
        self,
        doc_path: Optional[str],
        claim_types: Optional[List[str]],
    ) -> Dict[str, Any]:
        """Extract claims from a documentation file."""
        if not doc_path:
            return {"success": False, "error": "doc_path is required for claims action"}

        from ...docs.agent import HesterDocsAgent

        agent = HesterDocsAgent(working_dir=str(self.working_dir))
        claims = await agent.extract_claims(doc_path=doc_path, claim_types=claim_types)

        return {
            "success": True,
            "action": "claims",
            "doc_path": doc_path,
            "claims": [
                {
                    "claim": c.claim,
                    "type": c.claim_type,
                    "location": c.location,
                    "references": c.references,
                }
                for c in claims
            ],
            "count": len(claims),
        }

    async def _index(
        self,
        doc_path: Optional[str],
        patterns: Optional[List[str]],
        clear: bool,
    ) -> Dict[str, Any]:
        """Index documentation files for vector search."""
        from ...docs.embeddings import DocEmbeddingService

        try:
            service = DocEmbeddingService(working_dir=str(self.working_dir))
        except ValueError as e:
            return {"success": False, "error": str(e)}

        if clear:
            cleared = await service.clear_index()
            logger.info(f"Cleared {cleared} embeddings from index")

        if doc_path:
            # Index single file
            result = await service.index_file(doc_path)
            return {
                "success": result.get("success", False),
                "action": "index",
                "file_path": result.get("file_path"),
                "chunks_indexed": result.get("chunks_indexed", 0),
                "chunks_skipped": result.get("chunks_skipped", 0),
                "total_chunks": result.get("total_chunks", 0),
                "error": result.get("error"),
            }
        else:
            # Index all matching files
            result = await service.index_directory(patterns=patterns)
            return {
                "success": result.get("success", False),
                "action": "index_all",
                "files_processed": result.get("files_processed", 0),
                "files_skipped": result.get("files_skipped", 0),
                "total_chunks": result.get("total_chunks", 0),
                "chunks_indexed": result.get("chunks_indexed", 0),
            }

    async def _status(self) -> Dict[str, Any]:
        """Get documentation index status."""
        from ...docs.embeddings import DocEmbeddingService

        try:
            service = DocEmbeddingService(working_dir=str(self.working_dir))
        except ValueError as e:
            return {"success": False, "error": str(e)}

        indexed_files = await service.get_indexed_files()

        return {
            "success": True,
            "action": "status",
            "repo_name": service.repo_name,
            "indexed_files": indexed_files,
            "file_count": len(indexed_files),
        }

    async def _write(
        self,
        doc_path: Optional[str],
        content: Optional[str],
        overwrite: bool,
    ) -> Dict[str, Any]:
        """Create a new markdown file."""
        if not doc_path:
            return {"success": False, "error": "doc_path is required for write action"}
        if not content:
            return {"success": False, "error": "content is required for write action"}

        from ..tools.doc_tools import write_markdown

        result = await write_markdown(
            doc_path=doc_path,
            content=content,
            working_dir=str(self.working_dir),
            overwrite=overwrite,
        )

        return {
            "success": result.get("success", False),
            "action": "write",
            "path": result.get("path"),
            "created": result.get("created", False),
            "bytes_written": result.get("bytes_written", 0),
            "error": result.get("error"),
        }

    async def _update(
        self,
        doc_path: Optional[str],
        content: Optional[str],
        section: Optional[str],
        append: bool,
    ) -> Dict[str, Any]:
        """Update an existing markdown file."""
        if not doc_path:
            return {"success": False, "error": "doc_path is required for update action"}
        if not content:
            return {"success": False, "error": "content is required for update action"}

        from ..tools.doc_tools import update_markdown

        result = await update_markdown(
            doc_path=doc_path,
            content=content,
            working_dir=str(self.working_dir),
            section=section,
            append=append,
        )

        return {
            "success": result.get("success", False),
            "action": "update",
            "path": result.get("path"),
            "modified": result.get("modified", False),
            "section_found": result.get("section_found"),
            "bytes_written": result.get("bytes_written", 0),
            "error": result.get("error"),
        }

    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch using this delegate.

        This method is called by TaskExecutor for docs_manager batches.
        The batch params should contain the action and relevant parameters.

        Args:
            batch: The batch to execute
            context: Context from previous batches (not typically used for docs)

        Returns:
            Dict with success, output, and optional summary
        """
        from .models import TaskBatch

        params = batch.params or {}
        # Use batch.action field first, fall back to params, then default to search
        action = batch.action or params.get("action", "search")

        # For write/update actions, content can come from:
        # 1. params["content"] (explicit)
        # 2. context (from previous batch output via context_from)
        # 3. batch.prompt (as a fallback)
        content = params.get("content")
        if not content and action in ("write", "update") and context:
            content = context
        if not content and action in ("write", "update") and batch.prompt:
            content = batch.prompt

        # doc_path can come from params or batch.prompt (for simple cases)
        doc_path = params.get("doc_path")
        if not doc_path and action in ("write", "update"):
            # Check if prompt looks like a file path
            if batch.prompt and batch.prompt.strip().endswith(".md"):
                doc_path = batch.prompt.strip()

        # Execute the action
        result = await self.execute(
            action=action,
            query=batch.prompt if action == "search" else params.get("query"),
            doc_path=doc_path,
            content=content,
            section=params.get("section"),
            append=params.get("append", False),
            overwrite=params.get("overwrite", False),
            limit=params.get("limit", 5),
            threshold=params.get("threshold", 0.7),
            claim_types=params.get("claim_types"),
            patterns=params.get("patterns"),
            clear=params.get("clear", False),
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
        lines = [f"# Documentation {action.title()} Results\n"]

        if not result.get("success"):
            lines.append(f"**Error:** {result.get('error', 'Unknown error')}")
            return "\n".join(lines)

        if action == "search":
            lines.append(f"**Query:** {result.get('query')}")
            lines.append(f"**Results:** {result.get('count', 0)}\n")
            for r in result.get("results", []):
                lines.append(f"## {r['path']}")
                lines.append(f"*Relevance: {r['relevance']:.2f}*\n")
                lines.append(f"> {r['excerpt'][:200]}...")
                if r.get("reason"):
                    lines.append(f"\n*Why relevant:* {r['reason']}")
                lines.append("")

        elif action == "check":
            lines.append(f"**File:** {result.get('file_path')}")
            lines.append(f"**Total Claims:** {result.get('total_claims')}")
            lines.append(f"**Valid:** {result.get('valid_claims')}")
            lines.append(f"**Drifted:** {result.get('drifted_count')}\n")
            for c in result.get("drifted_claims", []):
                lines.append(f"- **{c['type']}** (confidence: {c['confidence']:.2f})")
                lines.append(f"  > {c['claim']}")
                if c.get("reason"):
                    lines.append(f"  *Reason:* {c['reason']}")

        elif action == "check_all":
            lines.append(f"**Files Checked:** {result.get('files_checked')}")
            lines.append(f"**Total Drifted Claims:** {result.get('total_drifted_claims')}\n")
            for r in result.get("reports", []):
                lines.append(f"- **{r['file_path']}**: {r['drifted_count']} drifted")

        elif action == "claims":
            lines.append(f"**File:** {result.get('doc_path')}")
            lines.append(f"**Claims Found:** {result.get('count')}\n")
            for c in result.get("claims", []):
                lines.append(f"- **{c['type']}** @ {c['location']}")
                lines.append(f"  > {c['claim']}")

        elif action in ("index", "index_all"):
            if action == "index":
                lines.append(f"**File:** {result.get('file_path')}")
                lines.append(f"**Chunks Indexed:** {result.get('chunks_indexed')}")
                lines.append(f"**Chunks Skipped:** {result.get('chunks_skipped')}")
            else:
                lines.append(f"**Files Processed:** {result.get('files_processed')}")
                lines.append(f"**Files Skipped:** {result.get('files_skipped')}")
                lines.append(f"**Total Chunks:** {result.get('total_chunks')}")
                lines.append(f"**Chunks Indexed:** {result.get('chunks_indexed')}")

        elif action == "status":
            lines.append(f"**Repository:** {result.get('repo_name')}")
            lines.append(f"**Indexed Files:** {result.get('file_count')}\n")
            for f in result.get("indexed_files", [])[:20]:  # Limit display
                lines.append(f"- {f}")
            if result.get("file_count", 0) > 20:
                lines.append(f"... and {result['file_count'] - 20} more")

        elif action == "write":
            lines.append(f"**Created:** {result.get('path')}")
            lines.append(f"**Bytes Written:** {result.get('bytes_written')}")

        elif action == "update":
            lines.append(f"**Updated:** {result.get('path')}")
            if result.get("section_found") is not None:
                lines.append(f"**Section Found:** {result.get('section_found')}")
            lines.append(f"**Bytes Written:** {result.get('bytes_written')}")

        return "\n".join(lines)

    def _generate_summary(self, result: Dict[str, Any]) -> str:
        """Generate a concise summary for context chaining."""
        action = result.get("action", "unknown")

        if not result.get("success"):
            return f"Documentation {action} failed: {result.get('error', 'Unknown error')}"

        if action == "search":
            count = result.get("count", 0)
            return f"Found {count} relevant documentation sections for query"

        elif action == "check":
            drifted = result.get("drifted_count", 0)
            total = result.get("total_claims", 0)
            return f"Checked {total} claims, found {drifted} drifted"

        elif action == "check_all":
            files = result.get("files_checked", 0)
            drifted = result.get("total_drifted_claims", 0)
            return f"Checked {files} files, found {drifted} total drifted claims"

        elif action == "claims":
            count = result.get("count", 0)
            return f"Extracted {count} verifiable claims from documentation"

        elif action in ("index", "index_all"):
            indexed = result.get("chunks_indexed", 0)
            return f"Indexed {indexed} documentation chunks"

        elif action == "status":
            count = result.get("file_count", 0)
            return f"Index contains {count} files for {result.get('repo_name')}"

        elif action == "write":
            return f"Created new document: {result.get('path')}"

        elif action == "update":
            return f"Updated document: {result.get('path')}"

        return f"Documentation {action} completed"
