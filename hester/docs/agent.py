"""
HesterDocsAgent - Orchestrates documentation operations for CLI.

Uses the same tools as the daemon but provides batch operations
for CLI usage (check all docs, generate reports, etc.)
"""

import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .models import DocClaim, DriftReport, DocSearchResult, DocsCheckResult

logger = logging.getLogger("hester.docs.agent")


class HesterDocsAgent:
    """
    Agent for documentation validation and search.

    Provides batch operations that use the daemon's doc tools.
    """

    def __init__(self, working_dir: Optional[str] = None):
        """
        Initialize the docs agent.

        Args:
            working_dir: Working directory for file operations
        """
        self.working_dir = working_dir or str(Path.cwd())

    async def check_file(
        self,
        doc_path: str,
        threshold: float = 0.7,
    ) -> DriftReport:
        """
        Check a single documentation file for drift.

        Args:
            doc_path: Path to documentation file
            threshold: Confidence threshold for valid claims

        Returns:
            DriftReport with validation results
        """
        from ..daemon.tools.doc_tools import find_doc_drift

        result = await find_doc_drift(
            doc_path=doc_path,
            working_dir=self.working_dir,
            threshold=threshold,
        )

        if not result.get("success"):
            return DriftReport(
                file_path=doc_path,
                total_claims=0,
                valid_claims=0,
                threshold=threshold,
            )

        # Convert to model
        drifted = []
        for claim_data in result.get("drifted_claims", []):
            drifted.append(DocClaim(
                claim=claim_data.get("claim", ""),
                claim_type=claim_data.get("type", "unknown"),
                location=claim_data.get("location", ""),
                source_file=doc_path,
                valid=False,
                confidence=claim_data.get("confidence", 0),
                reason=claim_data.get("reason", ""),
                evidence_location=claim_data.get("evidence"),
            ))

        unverifiable = []
        for claim_data in result.get("unverifiable_claims", []):
            unverifiable.append(DocClaim(
                claim=claim_data.get("claim", ""),
                claim_type=claim_data.get("type", "unknown"),
                location=claim_data.get("location", ""),
                source_file=doc_path,
                valid=None,
                confidence=claim_data.get("confidence", 0),
                reason=claim_data.get("reason", ""),
            ))

        return DriftReport(
            file_path=result.get("file_path", doc_path),
            total_claims=result.get("total_claims", 0),
            valid_claims=result.get("valid_claims", 0),
            drifted_claims=drifted,
            unverifiable_claims=unverifiable,
            threshold=threshold,
        )

    async def check_all(
        self,
        doc_patterns: Optional[List[str]] = None,
        threshold: float = 0.7,
    ) -> DocsCheckResult:
        """
        Check all documentation files for drift.

        Args:
            doc_patterns: Glob patterns for doc files
            threshold: Confidence threshold

        Returns:
            DocsCheckResult with all reports
        """
        from ..daemon.tools.file_search import search_files

        doc_patterns = doc_patterns or ["docs/**/*.md", "**/*.md", "**/README*"]

        # Find all doc files
        all_docs = []
        for pattern in doc_patterns:
            result = await search_files(
                pattern=pattern,
                working_dir=self.working_dir,
                max_results=100,
            )
            if result.get("success"):
                all_docs.extend(result.get("files", []))

        # Deduplicate
        all_docs = list(set(all_docs))

        if not all_docs:
            return DocsCheckResult(
                success=True,
                reports=[],
                error="No documentation files found",
            )

        # Check each doc file
        reports = []
        for doc_path in all_docs:
            try:
                report = await self.check_file(doc_path, threshold)
                reports.append(report)
            except Exception as e:
                logger.warning(f"Failed to check {doc_path}: {e}")

        return DocsCheckResult(
            success=True,
            reports=reports,
        )

    async def search(
        self,
        query: str,
        doc_patterns: Optional[List[str]] = None,
        limit: int = 5,
    ) -> List[DocSearchResult]:
        """
        Semantic search over documentation.

        Args:
            query: Natural language query
            doc_patterns: Glob patterns for doc files
            limit: Maximum results

        Returns:
            List of matching documentation sections
        """
        from ..daemon.tools.doc_tools import semantic_doc_search

        result = await semantic_doc_search(
            query=query,
            working_dir=self.working_dir,
            doc_patterns=doc_patterns,
            limit=limit,
        )

        if not result.get("success"):
            return []

        results = []
        for item in result.get("results", []):
            results.append(DocSearchResult(
                path=item.get("path", ""),
                relevance=item.get("relevance", 0),
                excerpt=item.get("excerpt", ""),
                reason=item.get("reason", ""),
            ))

        return results

    async def extract_claims(
        self,
        doc_path: str,
        claim_types: Optional[List[str]] = None,
    ) -> List[DocClaim]:
        """
        Extract claims from a documentation file.

        Args:
            doc_path: Path to documentation file
            claim_types: Types of claims to extract

        Returns:
            List of extracted claims
        """
        from ..daemon.tools.doc_tools import extract_doc_claims

        result = await extract_doc_claims(
            doc_path=doc_path,
            working_dir=self.working_dir,
            claim_types=claim_types,
        )

        if not result.get("success"):
            return []

        claims = []
        for claim_data in result.get("claims", []):
            claims.append(DocClaim(
                claim=claim_data.get("claim", ""),
                claim_type=claim_data.get("type", "unknown"),
                location=claim_data.get("location", ""),
                references=claim_data.get("references", []),
                source_file=doc_path,
            ))

        return claims
