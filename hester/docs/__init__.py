"""
HesterDocs - Documentation validation and semantic search.

Provides CLI tools for:
- Checking documentation drift against code
- Semantic search over documentation
- Extracting and validating claims from docs
"""

from .agent import HesterDocsAgent
from .models import DocClaim, DriftReport, DocSearchResult

__all__ = [
    "HesterDocsAgent",
    "DocClaim",
    "DriftReport",
    "DocSearchResult",
]
