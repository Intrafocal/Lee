"""
Documentation Tools - Claim extraction, validation, drift detection, and markdown management.

Uses Gemini Flash Lite for fast, cheap document analysis.
"""

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiofiles
import aiofiles.os
from google import genai

logger = logging.getLogger("hester.daemon.tools.doc_tools")

# Gemini client (lazy initialized)
_client: Optional[genai.Client] = None


def _get_client() -> genai.Client:
    """Get or create Gemini client."""
    global _client
    if _client is None:
        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY not set")
        _client = genai.Client(api_key=api_key)
    return _client


async def extract_doc_claims(
    doc_path: str,
    working_dir: str,
    claim_types: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Extract verifiable claims from a documentation file.

    A "claim" is a concrete assertion that can be validated against code:
    - "The upload endpoint accepts files up to 5MB"
    - "Authentication uses JWT with ES256"
    - "The match_profiles function returns top 10 matches"

    Args:
        doc_path: Path to documentation file (markdown, rst, or docstring)
        working_dir: Working directory for relative paths
        claim_types: Types of claims to extract (default: all)
            Options: "function", "api", "config", "flow", "schema"

    Returns:
        Dictionary with extracted claims and metadata
    """
    claim_types = claim_types or ["function", "api", "config", "flow", "schema"]

    try:
        # Resolve path
        path = Path(doc_path)
        if not path.is_absolute():
            path = Path(working_dir) / path
        path = path.resolve()

        # Security check
        working_path = Path(working_dir).resolve()
        try:
            path.relative_to(working_path)
        except ValueError:
            if not str(path).startswith(str(Path.home())):
                return {
                    "success": False,
                    "error": f"Access denied: {path} is outside working directory",
                    "file_path": str(path),
                }

        if not path.exists():
            return {
                "success": False,
                "error": f"File not found: {path}",
                "file_path": str(path),
            }

        # Read file content
        async with aiofiles.open(path, "r", encoding="utf-8", errors="replace") as f:
            content = await f.read()

        # Use Gemini to extract claims
        client = _get_client()

        prompt = f"""Analyze this documentation and extract concrete, verifiable claims.

A claim is a specific assertion about code behavior that can be validated:
- Function behavior: "The calculate_score function returns a float between 0 and 1"
- API endpoints: "POST /api/upload accepts multipart/form-data with max 5MB"
- Configuration: "The default timeout is 30 seconds"
- Data flow: "User data is encrypted before storage"
- Schema: "The Profile table has a skills column of type ARRAY"

Focus on claims about: {', '.join(claim_types)}

For each claim, provide:
1. The exact claim text
2. The claim type (function/api/config/flow/schema)
3. Where in the doc it appears (line number or section)
4. What code entity it references (function name, endpoint, table, etc.)

Return as JSON array:
[
  {{
    "claim": "The upload endpoint accepts files up to 5MB",
    "type": "api",
    "location": "## API Endpoints section",
    "references": ["POST /api/upload", "MAX_UPLOAD_SIZE"]
  }}
]

If no verifiable claims found, return empty array [].

Documentation content:
```
{content[:8000]}
```

Extract claims (JSON only, no markdown):"""

        response = client.models.generate_content(
            model="gemini-2.0-flash-lite",
            contents=prompt,
        )

        # Parse response
        text = response.text.strip()
        # Handle markdown code blocks
        if "```" in text:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                text = match.group(1).strip()

        import json
        try:
            claims = json.loads(text)
        except json.JSONDecodeError:
            # Try to extract just the array
            match = re.search(r"\[[\s\S]*\]", text)
            if match:
                claims = json.loads(match.group(0))
            else:
                claims = []

        return {
            "success": True,
            "file_path": str(path),
            "claims": claims,
            "claim_count": len(claims),
            "claim_types_found": list(set(c.get("type", "unknown") for c in claims)),
        }

    except Exception as e:
        logger.error(f"Error extracting claims from {doc_path}: {e}")
        return {
            "success": False,
            "error": str(e),
            "file_path": doc_path,
        }


async def validate_claim(
    claim: str,
    source_file: str,
    working_dir: str,
    search_paths: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Validate a documentation claim against actual code.

    Uses search + LLM reasoning to check if the claim is accurate.

    Args:
        claim: The claim text to validate
        source_file: Doc file where claim was found (for context)
        working_dir: Working directory for file operations
        search_paths: Specific paths to search (default: search all)

    Returns:
        Dictionary with validation result, confidence, and evidence
    """
    from .file_search import search_content, search_files

    try:
        # Extract key terms from claim for searching
        client = _get_client()

        extract_prompt = f"""Extract search terms from this documentation claim:

Claim: "{claim}"

Return 2-4 specific terms to search for in code (function names, variable names, values, etc.)
Return as JSON array of strings. Example: ["upload_file", "5MB", "MAX_SIZE"]

Search terms (JSON only):"""

        response = client.models.generate_content(
            model="gemini-2.0-flash-lite",
            contents=extract_prompt,
        )

        text = response.text.strip()
        if "```" in text:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                text = match.group(1).strip()

        import json
        try:
            search_terms = json.loads(text)
        except json.JSONDecodeError:
            # Fallback: split claim into words
            search_terms = [w for w in claim.split() if len(w) > 3][:4]

        # Search for each term
        evidence_snippets = []
        for term in search_terms:
            if not term or len(term) < 2:
                continue

            result = await search_content(
                pattern=term,
                working_dir=working_dir,
                file_pattern=search_paths[0] if search_paths else "**/*.py",
                max_results=5,
            )

            if result.get("success") and result.get("matches"):
                for match in result["matches"][:3]:
                    evidence_snippets.append({
                        "term": term,
                        "file": match.get("file", ""),
                        "line": match.get("line", 0),
                        "content": match.get("content", "")[:200],
                    })

        # Use LLM to validate claim against evidence
        if evidence_snippets:
            evidence_text = "\n".join([
                f"- {e['file']}:{e['line']}: {e['content']}"
                for e in evidence_snippets[:10]
            ])
        else:
            evidence_text = "No matching code found."

        validate_prompt = f"""Validate this documentation claim against the code evidence.

CLAIM: "{claim}"
FROM: {source_file}

CODE EVIDENCE:
{evidence_text}

Analyze whether the claim is:
1. VALID - The code confirms the claim
2. INVALID - The code contradicts the claim
3. UNVERIFIABLE - Not enough evidence to confirm or deny

Return JSON:
{{
  "valid": true/false/null,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation",
  "evidence_location": "file:line if found"
}}

Validation result (JSON only):"""

        response = client.models.generate_content(
            model="gemini-2.0-flash-lite",
            contents=validate_prompt,
        )

        text = response.text.strip()
        if "```" in text:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                text = match.group(1).strip()

        try:
            validation = json.loads(text)
        except json.JSONDecodeError:
            validation = {
                "valid": None,
                "confidence": 0.3,
                "reason": "Could not parse validation result",
            }

        return {
            "success": True,
            "claim": claim,
            "source_file": source_file,
            "valid": validation.get("valid"),
            "confidence": validation.get("confidence", 0.5),
            "reason": validation.get("reason", ""),
            "evidence_location": validation.get("evidence_location"),
            "evidence_snippets": evidence_snippets[:5],
        }

    except Exception as e:
        logger.error(f"Error validating claim: {e}")
        return {
            "success": False,
            "error": str(e),
            "claim": claim,
        }


async def find_doc_drift(
    doc_path: str,
    working_dir: str,
    threshold: float = 0.7,
) -> Dict[str, Any]:
    """
    Find documentation drift by extracting and validating all claims.

    Args:
        doc_path: Path to documentation file
        working_dir: Working directory
        threshold: Confidence threshold - claims below this are "drifted"

    Returns:
        Dictionary with drift report
    """
    try:
        # Step 1: Extract claims
        extraction = await extract_doc_claims(doc_path, working_dir)

        if not extraction.get("success"):
            return extraction

        claims = extraction.get("claims", [])
        if not claims:
            return {
                "success": True,
                "file_path": extraction["file_path"],
                "total_claims": 0,
                "valid_claims": 0,
                "drifted_claims": [],
                "message": "No verifiable claims found in document",
            }

        # Step 2: Validate each claim
        valid_claims = []
        drifted_claims = []
        unverifiable_claims = []

        for claim_data in claims:
            claim_text = claim_data.get("claim", "")
            if not claim_text:
                continue

            validation = await validate_claim(
                claim=claim_text,
                source_file=doc_path,
                working_dir=working_dir,
            )

            result = {
                "claim": claim_text,
                "type": claim_data.get("type", "unknown"),
                "location": claim_data.get("location", ""),
                "valid": validation.get("valid"),
                "confidence": validation.get("confidence", 0),
                "reason": validation.get("reason", ""),
                "evidence": validation.get("evidence_location"),
            }

            if validation.get("valid") is True and validation.get("confidence", 0) >= threshold:
                valid_claims.append(result)
            elif validation.get("valid") is False:
                drifted_claims.append(result)
            elif validation.get("confidence", 0) < threshold:
                # Low confidence = potentially drifted
                drifted_claims.append(result)
            else:
                unverifiable_claims.append(result)

        return {
            "success": True,
            "file_path": extraction["file_path"],
            "total_claims": len(claims),
            "valid_claims": len(valid_claims),
            "drifted_count": len(drifted_claims),
            "unverifiable_count": len(unverifiable_claims),
            "threshold": threshold,
            "drifted_claims": drifted_claims,
            "valid_claim_details": valid_claims[:5],  # Limit output
            "unverifiable_claims": unverifiable_claims[:5],
        }

    except Exception as e:
        logger.error(f"Error finding drift in {doc_path}: {e}")
        return {
            "success": False,
            "error": str(e),
            "file_path": doc_path,
        }


async def semantic_doc_search(
    query: str,
    working_dir: str,
    doc_patterns: Optional[List[str]] = None,
    limit: int = 5,
    use_embeddings: bool = True,
) -> Dict[str, Any]:
    """
    Semantic search over documentation files.

    Uses vector embeddings for true semantic search when available,
    with fallback to LLM-based search.

    Args:
        query: Natural language query (e.g., "How does authentication work?")
        working_dir: Working directory
        doc_patterns: Glob patterns for doc files (default: ["**/*.md", "**/README*"])
        limit: Maximum results to return
        use_embeddings: Try vector search first (default: True)

    Returns:
        Dictionary with relevant documentation sections
    """
    from .file_search import search_files

    doc_patterns = doc_patterns or ["**/*.md", "**/README*"]

    # Try vector embedding search first
    if use_embeddings:
        try:
            from hester.docs.embeddings import DocEmbeddingService

            embed_service = DocEmbeddingService(working_dir)
            results = await embed_service.search(query, limit=limit)

            if results:
                return {
                    "success": True,
                    "query": query,
                    "results": [
                        {
                            "path": r["file_path"],
                            "relevance": r["similarity"],
                            "excerpt": r["chunk_text"][:500],
                            "reason": f"Semantic match (similarity: {r['similarity']:.2f})",
                        }
                        for r in results
                    ],
                    "search_method": "embeddings",
                    "docs_searched": "indexed",
                }
        except Exception as e:
            logger.debug(f"Embedding search unavailable, falling back to LLM: {e}")

    # Fallback: LLM-based search
    try:
        # Find all doc files
        all_docs = []
        for pattern in doc_patterns:
            result = await search_files(
                pattern=pattern,
                working_dir=working_dir,
                max_results=100,
            )
            if result.get("success"):
                all_docs.extend(result.get("files", []))

        # Deduplicate
        all_docs = list(set(all_docs))

        if not all_docs:
            return {
                "success": True,
                "query": query,
                "results": [],
                "message": "No documentation files found",
            }

        # Read doc summaries (first 500 chars each)
        doc_summaries = []
        for doc_path in all_docs[:50]:  # Limit to first 50 docs
            try:
                path = Path(working_dir) / doc_path
                async with aiofiles.open(path, "r", encoding="utf-8", errors="replace") as f:
                    content = await f.read(2000)
                    doc_summaries.append({
                        "path": doc_path,
                        "preview": content[:500],
                    })
            except Exception:
                continue

        # Use LLM to rank docs by relevance
        client = _get_client()

        docs_text = "\n\n".join([
            f"=== {d['path']} ===\n{d['preview']}"
            for d in doc_summaries
        ])

        search_prompt = f"""Find documentation sections that answer this query:

QUERY: "{query}"

AVAILABLE DOCS:
{docs_text[:12000]}

Return the {limit} most relevant docs with excerpts that answer the query.
Format as JSON array:
[
  {{
    "path": "docs/auth.md",
    "relevance": 0.95,
    "excerpt": "Relevant section text...",
    "reason": "Why this answers the query"
  }}
]

Results (JSON only):"""

        response = client.models.generate_content(
            model="gemini-2.0-flash-lite",
            contents=search_prompt,
        )

        text = response.text.strip()
        if "```" in text:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                text = match.group(1).strip()

        import json
        try:
            results = json.loads(text)
        except json.JSONDecodeError:
            results = []

        return {
            "success": True,
            "query": query,
            "results": results[:limit],
            "search_method": "llm",
            "docs_searched": len(doc_summaries),
        }

    except Exception as e:
        logger.error(f"Error in semantic search: {e}")
        return {
            "success": False,
            "error": str(e),
            "query": query,
        }


async def write_markdown(
    doc_path: str,
    content: str,
    working_dir: str,
    overwrite: bool = False,
) -> Dict[str, Any]:
    """
    Create a new markdown file.

    Args:
        doc_path: Path for the new file (relative to working_dir or absolute)
        content: Content to write to the file
        working_dir: Working directory for relative paths
        overwrite: If True, overwrite existing file. Default False.

    Returns:
        Dictionary with success status, path, and created flag
    """
    try:
        # Resolve path
        path = Path(doc_path)
        if not path.is_absolute():
            path = Path(working_dir) / path
        path = path.resolve()

        # Security check - must be within working_dir or home
        working_path = Path(working_dir).resolve()
        try:
            path.relative_to(working_path)
        except ValueError:
            if not str(path).startswith(str(Path.home())):
                return {
                    "success": False,
                    "error": f"Access denied: {path} is outside working directory",
                    "path": str(path),
                }

        # Check if file exists
        if path.exists() and not overwrite:
            return {
                "success": False,
                "error": f"File already exists: {path}. Use overwrite=True to replace.",
                "path": str(path),
                "exists": True,
            }

        # Create parent directories if needed
        path.parent.mkdir(parents=True, exist_ok=True)

        # Write file
        async with aiofiles.open(path, "w", encoding="utf-8") as f:
            await f.write(content)

        logger.info(f"Created markdown file: {path}")

        return {
            "success": True,
            "path": str(path),
            "created": True,
            "bytes_written": len(content.encode("utf-8")),
        }

    except Exception as e:
        logger.error(f"Error writing markdown to {doc_path}: {e}")
        return {
            "success": False,
            "error": str(e),
            "path": doc_path,
        }


async def update_markdown(
    doc_path: str,
    content: str,
    working_dir: str,
    section: Optional[str] = None,
    append: bool = False,
) -> Dict[str, Any]:
    """
    Update an existing markdown file.

    Args:
        doc_path: Path to the file (relative to working_dir or absolute)
        content: New content to write
        working_dir: Working directory for relative paths
        section: If provided, replace content under this heading (e.g., "## Installation")
        append: If True, append content to end of file instead of replacing

    Returns:
        Dictionary with success status, path, and modification details
    """
    try:
        # Resolve path
        path = Path(doc_path)
        if not path.is_absolute():
            path = Path(working_dir) / path
        path = path.resolve()

        # Security check
        working_path = Path(working_dir).resolve()
        try:
            path.relative_to(working_path)
        except ValueError:
            if not str(path).startswith(str(Path.home())):
                return {
                    "success": False,
                    "error": f"Access denied: {path} is outside working directory",
                    "path": str(path),
                }

        # Check file exists
        if not path.exists():
            return {
                "success": False,
                "error": f"File not found: {path}",
                "path": str(path),
            }

        # Read existing content
        async with aiofiles.open(path, "r", encoding="utf-8", errors="replace") as f:
            existing_content = await f.read()

        new_content = existing_content
        section_found = False

        if append:
            # Append to end of file
            new_content = existing_content.rstrip() + "\n\n" + content
            section_found = None  # Not applicable for append mode

        elif section:
            # Replace section content
            # Match section heading and everything until next same-level or higher heading
            # Example: "## Installation" matches ## but not ### or #
            heading_level = len(section) - len(section.lstrip("#"))
            heading_text = section.lstrip("#").strip()

            # Pattern: Match this heading and content until next heading of same/higher level
            pattern = rf"(^{'#' * heading_level}\s+{re.escape(heading_text)}\s*\n)([\s\S]*?)(?=^#{{1,{heading_level}}}\s|\Z)"

            match = re.search(pattern, existing_content, re.MULTILINE)

            if match:
                # Replace section content (keep heading, replace body)
                section_found = True
                # The content should include its own heading if user wants to change it
                # Or we preserve the heading and just update the body
                if content.lstrip().startswith("#"):
                    # User provided heading in content, replace whole section
                    new_content = (
                        existing_content[:match.start()] +
                        content +
                        existing_content[match.end():]
                    )
                else:
                    # User provided body only, keep original heading
                    new_content = (
                        existing_content[:match.end(1)] +
                        content + "\n\n" +
                        existing_content[match.end():]
                    )
            else:
                # Section not found - append as new section at end
                section_found = False
                new_content = existing_content.rstrip() + "\n\n" + section + "\n\n" + content

        else:
            # Replace entire file
            new_content = content

        # Write updated content
        async with aiofiles.open(path, "w", encoding="utf-8") as f:
            await f.write(new_content)

        logger.info(f"Updated markdown file: {path}")

        return {
            "success": True,
            "path": str(path),
            "modified": True,
            "section_found": section_found,
            "bytes_written": len(new_content.encode("utf-8")),
            "mode": "append" if append else ("section" if section else "replace"),
        }

    except Exception as e:
        logger.error(f"Error updating markdown {doc_path}: {e}")
        return {
            "success": False,
            "error": str(e),
            "path": doc_path,
        }
