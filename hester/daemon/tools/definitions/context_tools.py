"""
Context bundle tool definitions - create, get, list, refresh bundles.
"""

from .models import ToolDefinition

# Context bundles require codebase/filesystem access - not available in slack
_CONTEXT_ENVIRONMENTS = {"daemon", "cli", "subagent"}


CREATE_CONTEXT_BUNDLE_TOOL = ToolDefinition(
    name="create_context_bundle",
    description="""Create a reusable context bundle from multiple sources.
A context bundle aggregates information from files, grep patterns, semantic search,
and database schemas into an AI-synthesized markdown document.

Use this when you want to create reusable documentation about a codebase area
that can be quickly injected into future conversations.

Examples:
- create_context_bundle(bundle_id="auth-system", title="Authentication System",
    sources=[{"type": "file", "path": "services/api/src/auth.py"},
             {"type": "grep", "pattern": "jwt|token"}])
- create_context_bundle(bundle_id="matching-algo", title="Matching Algorithm",
    sources=[{"type": "glob", "pattern": "services/matching/**/*.py"},
             {"type": "db_schema", "tables": ["profiles", "matches"]}])""",
    parameters={
        "type": "object",
        "properties": {
            "bundle_id": {
                "type": "string",
                "description": "Unique identifier (hyphenated, e.g., 'auth-system')",
            },
            "title": {
                "type": "string",
                "description": "Human-readable title",
            },
            "sources": {
                "type": "array",
                "description": "List of source specifications",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["file", "glob", "grep", "semantic", "db_schema"],
                        },
                        "path": {"type": "string"},
                        "pattern": {"type": "string"},
                        "query": {"type": "string"},
                        "tables": {"type": "array", "items": {"type": "string"}},
                    },
                },
            },
            "ttl_hours": {
                "type": "integer",
                "description": "Time-to-live in hours (0=manual, default: 24)",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Tags for categorization",
            },
        },
        "required": ["bundle_id", "title", "sources"],
    },
    environments=_CONTEXT_ENVIRONMENTS,
)

GET_CONTEXT_BUNDLE_TOOL = ToolDefinition(
    name="get_context_bundle",
    description="""Get the content of a context bundle.
Use this to inject bundle knowledge into the current conversation.

Examples:
- get_context_bundle(bundle_id="auth-system") - get auth system context
- get_context_bundle(bundle_id="matching-algo") - get matching algorithm context""",
    parameters={
        "type": "object",
        "properties": {
            "bundle_id": {
                "type": "string",
                "description": "The bundle identifier",
            },
        },
        "required": ["bundle_id"],
    },
    environments=_CONTEXT_ENVIRONMENTS,
)

LIST_CONTEXT_BUNDLES_TOOL = ToolDefinition(
    name="list_context_bundles",
    description="""List all available context bundles.
Shows bundle name, title, age, staleness status, and source count.

Examples:
- list_context_bundles() - list all bundles
- list_context_bundles(stale_only=True) - list only stale bundles""",
    parameters={
        "type": "object",
        "properties": {
            "stale_only": {
                "type": "boolean",
                "description": "Only show stale bundles (default: false)",
            },
        },
        "required": [],
    },
    environments=_CONTEXT_ENVIRONMENTS,
)

REFRESH_CONTEXT_BUNDLE_TOOL = ToolDefinition(
    name="refresh_context_bundle",
    description="""Refresh a context bundle by re-evaluating sources.
If sources have changed, the bundle is re-synthesized.

Examples:
- refresh_context_bundle(bundle_id="auth-system") - refresh if sources changed
- refresh_context_bundle(bundle_id="auth-system", force=True) - force refresh""",
    parameters={
        "type": "object",
        "properties": {
            "bundle_id": {
                "type": "string",
                "description": "The bundle identifier",
            },
            "force": {
                "type": "boolean",
                "description": "Force refresh even if unchanged (default: false)",
            },
        },
        "required": ["bundle_id"],
    },
    environments=_CONTEXT_ENVIRONMENTS,
)

ADD_BUNDLE_SOURCE_TOOL = ToolDefinition(
    name="add_bundle_source",
    description="""Add a source to an existing context bundle.
The bundle will be refreshed after adding the source.

Examples:
- add_bundle_source(bundle_id="auth-system", source={"type": "file", "path": "middleware.py"})
- add_bundle_source(bundle_id="matching-algo", source={"type": "grep", "pattern": "embedding"})""",
    parameters={
        "type": "object",
        "properties": {
            "bundle_id": {
                "type": "string",
                "description": "The bundle identifier",
            },
            "source": {
                "type": "object",
                "description": "Source specification (type + path/pattern/query/tables)",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["file", "glob", "grep", "semantic", "db_schema"],
                    },
                    "path": {"type": "string"},
                    "pattern": {"type": "string"},
                    "query": {"type": "string"},
                    "tables": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "required": ["bundle_id", "source"],
    },
    environments=_CONTEXT_ENVIRONMENTS,
)


# All context bundle tools
CONTEXT_TOOLS = [
    CREATE_CONTEXT_BUNDLE_TOOL,
    GET_CONTEXT_BUNDLE_TOOL,
    LIST_CONTEXT_BUNDLES_TOOL,
    REFRESH_CONTEXT_BUNDLE_TOOL,
    ADD_BUNDLE_SOURCE_TOOL,
]
