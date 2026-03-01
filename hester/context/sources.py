"""
Hester Context Bundle Source Evaluators - Evaluate and hash source content.

These evaluators fetch content from various source types (files, globs, grep,
semantic search, database schemas) and compute content hashes for change detection.
"""

import hashlib
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hester.context.models import (
    DbSchemaSource,
    FileSource,
    GlobSource,
    GrepSource,
    SemanticSource,
    SourceSpec,
)
from hester.context.prompts import (
    format_db_schema_source,
    format_file_source,
    format_glob_source,
    format_grep_source,
    format_semantic_source,
)

logger = logging.getLogger("hester.context.sources")


def content_hash(text: str) -> str:
    """Generate SHA256 hash of content for change detection."""
    return hashlib.sha256(text.encode()).hexdigest()


async def evaluate_file_source(
    source: FileSource,
    working_dir: str,
) -> Tuple[str, str]:
    """
    Evaluate a file source.

    Args:
        source: FileSource specification
        working_dir: Working directory for relative paths

    Returns:
        Tuple of (formatted_content, content_hash)
    """
    from hester.daemon.tools.file_read import read_file

    result = await read_file(
        file_path=source.path,
        working_dir=working_dir,
        max_lines=1000,  # Allow more lines for context bundles
    )

    if not result.get("success"):
        error_msg = result.get("error", "Unknown error")
        logger.warning(f"Failed to read file {source.path}: {error_msg}")
        return f"### File: `{source.path}`\n\n*Error: {error_msg}*\n", ""

    # Extract raw content (without line numbers for hashing)
    raw_content = result.get("content", "")
    # Strip line numbers for raw content hash
    lines = raw_content.split("\n")
    content_lines = []
    for line in lines:
        # Line format is "  123 | content"
        if " | " in line:
            content_lines.append(line.split(" | ", 1)[1])
        else:
            content_lines.append(line)
    raw_text = "\n".join(content_lines)

    # Format for synthesis
    formatted = format_file_source(
        path=source.path,
        content=raw_text,
        max_chars=4000,  # Allow more content
    )

    return formatted, content_hash(raw_text)


async def evaluate_glob_source(
    source: GlobSource,
    working_dir: str,
) -> Tuple[str, str]:
    """
    Evaluate a glob pattern source.

    Args:
        source: GlobSource specification
        working_dir: Working directory for glob matching

    Returns:
        Tuple of (formatted_content, content_hash)
    """
    from hester.daemon.tools.file_search import search_files
    from hester.daemon.tools.file_read import read_file

    result = await search_files(
        pattern=source.pattern,
        working_dir=working_dir,
        max_results=50,
    )

    if not result.get("success"):
        error_msg = result.get("error", "Unknown error")
        logger.warning(f"Failed to glob {source.pattern}: {error_msg}")
        return f"### Glob: `{source.pattern}`\n\n*Error: {error_msg}*\n", ""

    matches = result.get("matches", [])

    # Filter out excluded patterns
    if source.exclude:
        filtered_matches = []
        for match in matches:
            path = match.get("path", "")
            excluded = False
            for exclude_pattern in source.exclude:
                if exclude_pattern in path:
                    excluded = True
                    break
            if not excluded:
                filtered_matches.append(match)
        matches = filtered_matches

    if not matches:
        return f"### Glob: `{source.pattern}`\n\n*No files matched*\n", ""

    # Read preview of each file
    files_with_preview = []
    all_content_for_hash = []

    for match in matches[:20]:  # Limit to 20 files
        file_path = match.get("path", "")
        file_result = await read_file(
            file_path=file_path,
            working_dir=working_dir,
            max_lines=50,  # Just get preview
        )

        preview = ""
        if file_result.get("success"):
            raw_content = file_result.get("content", "")
            # Strip line numbers
            lines = raw_content.split("\n")
            preview_lines = []
            for line in lines[:10]:  # First 10 lines
                if " | " in line:
                    preview_lines.append(line.split(" | ", 1)[1])
                else:
                    preview_lines.append(line)
            preview = "\n".join(preview_lines)
            all_content_for_hash.append(f"{file_path}:{raw_content}")

        files_with_preview.append({
            "path": file_path,
            "preview": preview,
        })

    # Format for synthesis
    formatted = format_glob_source(
        pattern=source.pattern,
        files=files_with_preview,
        max_files=15,
    )

    # Hash based on all matched paths + their content
    hash_content = "\n".join(sorted(all_content_for_hash))
    return formatted, content_hash(hash_content)


async def evaluate_grep_source(
    source: GrepSource,
    working_dir: str,
) -> Tuple[str, str]:
    """
    Evaluate a grep/regex pattern source.

    Args:
        source: GrepSource specification
        working_dir: Working directory for search

    Returns:
        Tuple of (formatted_content, content_hash)
    """
    from hester.daemon.tools.file_search import search_content

    # Determine file pattern from paths
    file_pattern = "**/*"
    if source.paths and source.paths != ["."]:
        # If specific paths given, search within them
        # For simplicity, we'll search the first path
        file_pattern = f"{source.paths[0]}/**/*" if source.paths[0] != "." else "**/*"

    result = await search_content(
        pattern=source.pattern,
        working_dir=working_dir,
        file_pattern=file_pattern,
        max_results=50,
        context_lines=source.context_lines,
    )

    if not result.get("success"):
        error_msg = result.get("error", "Unknown error")
        logger.warning(f"Failed to grep {source.pattern}: {error_msg}")
        return f"### Grep: `{source.pattern}`\n\n*Error: {error_msg}*\n", ""

    matches = result.get("matches", [])

    if not matches:
        return f"### Grep: `{source.pattern}`\n\n*No matches found*\n", ""

    # Format matches for the prompt
    formatted_matches = []
    for match in matches:
        # Combine context into single string
        context_parts = []
        if match.get("context_before"):
            context_parts.extend(match["context_before"])
        context_parts.append(f">>> {match.get('content', '')}")  # Highlight match line
        if match.get("context_after"):
            context_parts.extend(match["context_after"])

        formatted_matches.append({
            "file": match.get("file", ""),
            "line": match.get("line_number", 0),
            "context": "\n".join(context_parts),
        })

    # Format for synthesis
    formatted = format_grep_source(
        pattern=source.pattern,
        matches=formatted_matches,
        max_matches=30,
    )

    # Hash based on match locations and content
    hash_parts = [f"{m['file']}:{m['line']}:{m['context']}" for m in formatted_matches]
    return formatted, content_hash("\n".join(hash_parts))


async def evaluate_semantic_source(
    source: SemanticSource,
    working_dir: str,
    doc_service: Optional[Any] = None,
) -> Tuple[str, str]:
    """
    Evaluate a semantic search source.

    Args:
        source: SemanticSource specification
        working_dir: Working directory (used for repo detection)
        doc_service: Optional DocEmbeddingService instance

    Returns:
        Tuple of (formatted_content, content_hash)

    Note:
        If doc_service is None or docs aren't indexed, returns a warning
        message instead of results. Use `hester docs index` to index docs.
    """
    # Try to get doc service if not provided
    if doc_service is None:
        try:
            from hester.docs.embeddings import DocEmbeddingService
            doc_service = DocEmbeddingService(working_dir)
        except Exception as e:
            logger.warning(f"Could not initialize DocEmbeddingService: {e}")
            warning_msg = (
                f'### Semantic Search: "{source.query}"\n\n'
                f"*Warning: Semantic search unavailable. Error: {e}*\n\n"
                f"*Run `hester docs index` to index documentation for semantic search.*\n"
            )
            return warning_msg, ""

    # Check if any docs are indexed
    try:
        indexed_files = await doc_service.get_indexed_files()
        if not indexed_files:
            warning_msg = (
                f'### Semantic Search: "{source.query}"\n\n'
                f"*Warning: No documents indexed for this repository.*\n\n"
                f"*Run `hester docs index --all` to index documentation.*\n"
            )
            return warning_msg, ""
    except Exception as e:
        logger.warning(f"Could not check indexed files: {e}")
        warning_msg = (
            f'### Semantic Search: "{source.query}"\n\n'
            f"*Warning: Could not verify doc index. Error: {e}*\n\n"
            f"*Run `hester docs index` to index documentation.*\n"
        )
        return warning_msg, ""

    # Perform semantic search
    try:
        results = await doc_service.search(
            query=source.query,
            limit=source.limit,
            min_similarity=source.min_similarity,
        )
    except Exception as e:
        logger.warning(f"Semantic search failed: {e}")
        return (
            f'### Semantic Search: "{source.query}"\n\n*Error: {e}*\n',
            "",
        )

    if not results:
        return (
            f'### Semantic Search: "{source.query}"\n\n*No results found*\n',
            "",
        )

    # Format results
    formatted_results = []
    for result in results:
        formatted_results.append({
            "file_path": result.get("file_path", ""),
            "similarity": result.get("similarity", 0),
            "chunk_text": result.get("chunk_text", ""),
        })

    formatted = format_semantic_source(
        query=source.query,
        results=formatted_results,
        max_results=source.limit,
    )

    # Hash based on results
    hash_parts = [
        f"{r['file_path']}:{r['similarity']:.4f}:{r['chunk_text'][:100]}"
        for r in formatted_results
    ]
    return formatted, content_hash("\n".join(hash_parts))


async def evaluate_db_schema_source(
    source: DbSchemaSource,
) -> Tuple[str, str]:
    """
    Evaluate a database schema source.

    Args:
        source: DbSchemaSource specification

    Returns:
        Tuple of (formatted_content, content_hash)
    """
    from hester.daemon.tools.db_tools import (
        describe_table,
        list_rls_policies,
    )

    schema_info = {}
    all_schema_parts = []

    for table_name in source.tables:
        table_info = {}

        # Get table structure
        result = await describe_table(table_name)
        if result.success:
            table_info["columns"] = result.data.get("columns", [])
            indexes = result.data.get("indexes", [])
            table_info["indexes"] = [idx.get("indexname", "") for idx in indexes]

            # Add to hash content
            columns_str = ",".join(
                f"{c.get('column_name')}:{c.get('data_type')}"
                for c in table_info["columns"]
            )
            all_schema_parts.append(f"{table_name}:{columns_str}")
        else:
            logger.warning(f"Failed to describe table {table_name}: {result.error}")
            table_info["error"] = result.error

        # Get RLS policies if requested
        if source.include_rls:
            rls_result = await list_rls_policies(table_name)
            if rls_result.success:
                policies = rls_result.data.get("policies", [])
                table_info["policies"] = [p.get("policy_name", "") for p in policies]
            else:
                logger.warning(f"Failed to get RLS for {table_name}: {rls_result.error}")

        schema_info[table_name] = table_info

    formatted = format_db_schema_source(
        tables=source.tables,
        schema_info=schema_info,
    )

    return formatted, content_hash("\n".join(sorted(all_schema_parts)))


async def evaluate_source(
    source: SourceSpec,
    working_dir: str,
    doc_service: Optional[Any] = None,
) -> Tuple[str, str]:
    """
    Evaluate any source type and return formatted content with hash.

    Args:
        source: Source specification (any SourceSpec type)
        working_dir: Working directory
        doc_service: Optional DocEmbeddingService for semantic search

    Returns:
        Tuple of (formatted_content, content_hash)
    """
    if isinstance(source, FileSource):
        return await evaluate_file_source(source, working_dir)
    elif isinstance(source, GlobSource):
        return await evaluate_glob_source(source, working_dir)
    elif isinstance(source, GrepSource):
        return await evaluate_grep_source(source, working_dir)
    elif isinstance(source, SemanticSource):
        return await evaluate_semantic_source(source, working_dir, doc_service)
    elif isinstance(source, DbSchemaSource):
        return await evaluate_db_schema_source(source)
    else:
        logger.error(f"Unknown source type: {type(source)}")
        return f"*Unknown source type: {type(source).__name__}*\n", ""


async def evaluate_all_sources(
    sources: List[SourceSpec],
    working_dir: str,
    doc_service: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    """
    Evaluate all sources and return results with content and hashes.

    Args:
        sources: List of source specifications
        working_dir: Working directory
        doc_service: Optional DocEmbeddingService for semantic search

    Returns:
        List of dicts with 'source', 'content', 'hash', and 'changed' keys
    """
    results = []

    for source in sources:
        content, hash_value = await evaluate_source(
            source=source,
            working_dir=working_dir,
            doc_service=doc_service,
        )

        # Check if hash changed from stored value
        stored_hash = ""
        if isinstance(source, FileSource):
            stored_hash = source.content_hash
        elif isinstance(source, GlobSource):
            stored_hash = source.paths_hash
        elif isinstance(source, GrepSource):
            stored_hash = source.matches_hash
        elif isinstance(source, SemanticSource):
            stored_hash = source.results_hash
        elif isinstance(source, DbSchemaSource):
            stored_hash = source.schema_hash

        changed = stored_hash != hash_value if stored_hash else True

        results.append({
            "source": source,
            "content": content,
            "hash": hash_value,
            "changed": changed,
        })

    return results
