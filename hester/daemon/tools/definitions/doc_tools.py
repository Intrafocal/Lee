"""
Documentation tool definitions - claims extraction, validation, drift detection.
"""

from .models import ToolDefinition

# All doc tools require codebase access - not available in slack
_DOC_ENVIRONMENTS = {"daemon", "cli", "subagent"}


EXTRACT_DOC_CLAIMS_TOOL = ToolDefinition(
    name="extract_doc_claims",
    description="""Extract verifiable claims from documentation files.
Use this to find concrete assertions that can be validated against code.

A claim is a specific statement like:
- "The upload endpoint accepts files up to 5MB"
- "Authentication uses JWT with ES256"
- "The match_profiles function returns top 10 matches"

Examples:
- Extract from markdown: extract_doc_claims(doc_path="docs/API.md")
- Filter by type: extract_doc_claims(doc_path="README.md", claim_types=["api", "config"])""",
    parameters={
        "type": "object",
        "properties": {
            "doc_path": {
                "type": "string",
                "description": "Path to documentation file (markdown, rst, txt)",
            },
            "claim_types": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Types to extract: function, api, config, flow, schema (default: all)",
            },
        },
        "required": ["doc_path"],
    },
    environments=_DOC_ENVIRONMENTS,
)

VALIDATE_CLAIM_TOOL = ToolDefinition(
    name="validate_claim",
    description="""Validate a documentation claim against actual code.
Use this to check if a specific statement in docs matches the implementation.

Returns whether the claim is valid, a confidence score, and evidence.

Examples:
- validate_claim(claim="Upload accepts max 5MB", source_file="docs/API.md")
- validate_claim(claim="Uses ES256 for JWT", source_file="README.md", search_paths=["services/auth/**/*.py"])""",
    parameters={
        "type": "object",
        "properties": {
            "claim": {
                "type": "string",
                "description": "The claim text to validate",
            },
            "source_file": {
                "type": "string",
                "description": "Documentation file where claim was found",
            },
            "search_paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Specific paths to search for validation (glob patterns)",
            },
        },
        "required": ["claim", "source_file"],
    },
    environments=_DOC_ENVIRONMENTS,
)

FIND_DOC_DRIFT_TOOL = ToolDefinition(
    name="find_doc_drift",
    description="""Find documentation drift by validating all claims in a doc.
Use this to check if a documentation file is up-to-date with the code.

Extracts all claims, validates each one, and reports:
- Valid claims (confirmed by code)
- Drifted claims (contradicted by code or low confidence)
- Unverifiable claims (not enough evidence)

Examples:
- find_doc_drift(doc_path="docs/Architecture.md")
- find_doc_drift(doc_path="CLAUDE.md", threshold=0.8)""",
    parameters={
        "type": "object",
        "properties": {
            "doc_path": {
                "type": "string",
                "description": "Path to documentation file to check",
            },
            "threshold": {
                "type": "number",
                "description": "Confidence threshold (0-1) - claims below are drifted (default: 0.7)",
            },
        },
        "required": ["doc_path"],
    },
    environments=_DOC_ENVIRONMENTS,
)

SEMANTIC_DOC_SEARCH_TOOL = ToolDefinition(
    name="semantic_doc_search",
    description="""Semantic search over documentation files.
Use this to find relevant docs that answer a question, not just keyword matching.

Good for questions like:
- "How does authentication work?"
- "What is the deployment process?"
- "Where is the database schema documented?"

Examples:
- semantic_doc_search(query="How does JWT authentication work?")
- semantic_doc_search(query="deployment process", doc_patterns=["docs/**/*.md"], limit=3)""",
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural language question or topic",
            },
            "doc_patterns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Glob patterns for docs (default: ['**/*.md', '**/README*'])",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum results (default: 5)",
            },
        },
        "required": ["query"],
    },
    environments=_DOC_ENVIRONMENTS,
)

WRITE_MARKDOWN_TOOL = ToolDefinition(
    name="write_markdown",
    description="""Create a new markdown documentation file.
Use this ONLY for creating NEW files that don't exist yet.

IMPORTANT: This tool fails by default if the file exists. To modify existing files:
- Use update_markdown with section parameter to update a specific section (preserves other content)
- Use update_markdown with append=true to add content at the end (preserves all content)
- Only use overwrite=true here if you intentionally want to replace the entire file

Security: File path must be within the working directory or home directory.
Parent directories are created automatically if they don't exist.

Examples:
- write_markdown(doc_path="docs/new-feature.md", content="# New Feature\\n\\n## Overview\\n...")
- write_markdown(doc_path="README.md", content="# Project\\n...", overwrite=true)  # Replaces entire file!""",
    parameters={
        "type": "object",
        "properties": {
            "doc_path": {
                "type": "string",
                "description": "Path to the markdown file to create (relative or absolute)",
            },
            "content": {
                "type": "string",
                "description": "Markdown content to write to the file",
            },
            "overwrite": {
                "type": "boolean",
                "description": "If true, overwrite existing file (default: false - fails if exists)",
            },
        },
        "required": ["doc_path", "content"],
    },
    environments=_DOC_ENVIRONMENTS,
)

UPDATE_MARKDOWN_TOOL = ToolDefinition(
    name="update_markdown",
    description="""Update an existing markdown documentation file.
Supports section-based updates, appending content, or full replacement.

BEST PRACTICES (preserve existing content):
1. PREFERRED: Use section parameter to update only a specific heading (preserves all other content)
2. SAFE: Use append=true to add content at the end (preserves all existing content)
3. CAUTION: Full replace (no section, no append) wipes the entire file - read first!

Before doing a full replace, ALWAYS read_file first to understand what content exists
and ensure you're not losing valuable information.

Modes:
- Section update: Replace content under a specific heading (section="## Installation")
- Append: Add content to end of file (append=true)
- Full replace: Replace entire file content (section=null, append=false) - USE WITH CAUTION

For section updates, the heading must match exactly (e.g., "## Installation" or "### Usage").
The section is replaced from that heading until the next heading of same or higher level.
If the section doesn't exist, it will be appended to the end of the file.

Examples:
- update_markdown(doc_path="README.md", section="## Installation", content="## Installation\\n\\nNew steps...")
- update_markdown(doc_path="CHANGELOG.md", content="\\n## v1.2.0\\n- New feature", append=true)
- update_markdown(doc_path="README.md", content="New content") - FULL REPLACE, wipes existing!""",
    parameters={
        "type": "object",
        "properties": {
            "doc_path": {
                "type": "string",
                "description": "Path to the markdown file to update",
            },
            "content": {
                "type": "string",
                "description": "New content (for full replace/append) or section content (for section update)",
            },
            "section": {
                "type": "string",
                "description": "Heading to update (e.g., '## Installation'). If null, replaces entire file.",
            },
            "append": {
                "type": "boolean",
                "description": "If true, append content to end of file instead of replacing (default: false)",
            },
        },
        "required": ["doc_path", "content"],
    },
    environments=_DOC_ENVIRONMENTS,
)


# All documentation tools
DOC_TOOLS = [
    EXTRACT_DOC_CLAIMS_TOOL,
    VALIDATE_CLAIM_TOOL,
    FIND_DOC_DRIFT_TOOL,
    SEMANTIC_DOC_SEARCH_TOOL,
    WRITE_MARKDOWN_TOOL,
    UPDATE_MARKDOWN_TOOL,
]
