"""
Hester Context Bundle Prompts - AI synthesis prompt templates.

These prompts are used by the ContextBundleService to synthesize
source content into concise, scannable reference documents.
"""

from typing import Dict, List, Any


BUNDLE_SYNTHESIS_PROMPT = """You are creating a Context Bundle—a concise reference document for developers.

**Bundle Title:** {title}

**Sources Collected:**

{sources_content}

---

**Instructions:**

Create a markdown document optimized for:
1. Quick scanning (busy developers)
2. Copy-paste into AI tools (Claude, ChatGPT, Cursor)
3. Understanding unfamiliar code areas

**Required Sections:**

## Summary
2-3 sentences. What is this? Why does it matter?

## Key Files
Bullet list of most important files with one-line descriptions.
Format: `path/to/file.py` - What it does

## Architecture
How do the components connect? Include a simple ASCII diagram if helpful.

## Patterns
Common patterns, conventions, or idioms found in this code.

## Gotchas
Non-obvious things. Edge cases. "I wish someone told me this."

---

**Style Guidelines:**
- Be concise. This is reference material, not documentation.
- Use code formatting for paths, functions, classes.
- Prefer bullet points over paragraphs.
- Include actual code snippets only if they're essential patterns.
- Skip sections if not applicable (e.g., no Gotchas found).
- Start with the title as an H1 heading: # {title}
"""


def format_file_source(path: str, content: str, max_chars: int = 2000) -> str:
    """Format a file source for the synthesis prompt."""
    truncated = content[:max_chars]
    suffix = "..." if len(content) > max_chars else ""
    return f"""### File: `{path}`

```
{truncated}{suffix}
```
"""


def format_glob_source(pattern: str, files: List[Dict[str, Any]], max_files: int = 10) -> str:
    """Format a glob source for the synthesis prompt."""
    formatted = f"### Glob: `{pattern}`\n\n"
    formatted += f"Matched {len(files)} files:\n\n"

    for file_info in files[:max_files]:
        path = file_info.get("path", "")
        preview = file_info.get("preview", "")[:200]
        formatted += f"**`{path}`**\n"
        if preview:
            formatted += f"```\n{preview}...\n```\n\n"
        else:
            formatted += "\n"

    if len(files) > max_files:
        formatted += f"\n*...and {len(files) - max_files} more files*\n"

    return formatted


def format_grep_source(
    pattern: str, matches: List[Dict[str, Any]], max_matches: int = 20
) -> str:
    """Format a grep source for the synthesis prompt."""
    formatted = f"### Grep: `{pattern}`\n\n"
    formatted += f"Found {len(matches)} matches:\n\n"

    for match in matches[:max_matches]:
        file_path = match.get("file", "")
        line_num = match.get("line", 0)
        context = match.get("context", match.get("text", ""))
        formatted += f"**{file_path}:{line_num}**\n```\n{context}\n```\n\n"

    if len(matches) > max_matches:
        formatted += f"\n*...and {len(matches) - max_matches} more matches*\n"

    return formatted


def format_semantic_source(
    query: str, results: List[Dict[str, Any]], max_results: int = 5
) -> str:
    """Format a semantic search source for the synthesis prompt."""
    formatted = f'### Semantic Search: "{query}"\n\n'

    if not results:
        formatted += "*No results found. Docs may not be indexed.*\n"
        return formatted

    for result in results[:max_results]:
        file_path = result.get("file_path", "")
        similarity = result.get("similarity", 0)
        chunk_text = result.get("chunk_text", "")[:500]

        formatted += f"**{file_path}** (similarity: {similarity:.2f})\n"
        formatted += f"> {chunk_text}...\n\n"

    return formatted


def format_db_schema_source(
    tables: List[str], schema_info: Dict[str, Any]
) -> str:
    """Format a database schema source for the synthesis prompt."""
    formatted = "### Database Schema\n\n"

    for table in tables:
        table_info = schema_info.get(table, {})
        formatted += f"**{table}**\n"

        # Columns
        columns = table_info.get("columns", [])
        if columns:
            formatted += "```sql\n"
            for col in columns:
                col_name = col.get("column_name", "")
                col_type = col.get("data_type", "")
                nullable = "NULL" if col.get("is_nullable") == "YES" else "NOT NULL"
                formatted += f"  {col_name} {col_type} {nullable}\n"
            formatted += "```\n"

        # Indexes
        indexes = table_info.get("indexes", [])
        if indexes:
            formatted += f"Indexes: {', '.join(indexes)}\n"

        # RLS policies
        policies = table_info.get("policies", [])
        if policies:
            formatted += f"RLS Policies: {len(policies)}\n"

        formatted += "\n"

    return formatted


def format_sources_for_synthesis(
    evaluated_sources: List[Dict[str, Any]]
) -> str:
    """
    Format all evaluated sources into a single string for the synthesis prompt.

    Args:
        evaluated_sources: List of dicts with 'type', 'spec', and 'content' keys

    Returns:
        Formatted string ready for the synthesis prompt
    """
    parts = []

    for source in evaluated_sources:
        source_type = source.get("type", "")
        content = source.get("content", "")

        if content:
            parts.append(content)

    return "\n\n".join(parts)
