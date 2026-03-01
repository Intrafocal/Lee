"""
HesterDocs Models - Data models for documentation operations.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class DocClaim:
    """A verifiable claim extracted from documentation."""

    claim: str
    claim_type: str  # function, api, config, flow, schema
    location: str  # Section or line reference
    references: List[str] = field(default_factory=list)  # Code entities referenced
    source_file: str = ""

    # Validation results (filled in after validation)
    valid: Optional[bool] = None
    confidence: float = 0.0
    reason: str = ""
    evidence_location: Optional[str] = None


@dataclass
class DriftReport:
    """Report of documentation drift for a file or project."""

    file_path: str
    checked_at: datetime = field(default_factory=datetime.now)
    total_claims: int = 0
    valid_claims: int = 0
    drifted_claims: List[DocClaim] = field(default_factory=list)
    unverifiable_claims: List[DocClaim] = field(default_factory=list)
    threshold: float = 0.7

    @property
    def drift_percentage(self) -> float:
        """Percentage of claims that have drifted."""
        if self.total_claims == 0:
            return 0.0
        return len(self.drifted_claims) / self.total_claims * 100

    @property
    def is_healthy(self) -> bool:
        """Whether the doc is considered healthy (low drift)."""
        return self.drift_percentage < 20.0


@dataclass
class DocSearchResult:
    """Result from semantic documentation search."""

    path: str
    relevance: float
    excerpt: str
    reason: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "relevance": self.relevance,
            "excerpt": self.excerpt,
            "reason": self.reason,
        }


@dataclass
class DocsCheckResult:
    """Result from checking documentation."""

    success: bool
    reports: List[DriftReport] = field(default_factory=list)
    error: Optional[str] = None
    checked_at: datetime = field(default_factory=datetime.now)

    @property
    def total_files(self) -> int:
        return len(self.reports)

    @property
    def healthy_files(self) -> int:
        return sum(1 for r in self.reports if r.is_healthy)

    @property
    def drifted_files(self) -> int:
        return sum(1 for r in self.reports if not r.is_healthy)
