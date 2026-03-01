"""
Redis tool definitions - key listing, getting, deletion, stats.
"""

from .models import ToolDefinition

# Redis tools require local Redis access - not available in slack (Cloud Run)
_REDIS_ENVIRONMENTS = {"daemon", "cli", "subagent"}


REDIS_LIST_KEYS_TOOL = ToolDefinition(
    name="redis_list_keys",
    description="""List Redis keys matching a pattern.
Use this to explore what Hester data is stored in Redis.

Supports both local and production Redis (via kubectl).

Examples:
- redis_list_keys(pattern="hester:*") - list all Hester keys
- redis_list_keys(pattern="hester:session:*") - list session keys
- redis_list_keys(pattern="hester:bundle:*", env="production") - production bundles""",
    parameters={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Key pattern to match (default: hester:*)",
            },
            "env": {
                "type": "string",
                "enum": ["local", "production"],
                "description": "Redis environment (default: local)",
            },
        },
        "required": [],
    },
    environments=_REDIS_ENVIRONMENTS,
)

REDIS_GET_KEY_TOOL = ToolDefinition(
    name="redis_get_key",
    description="""Get the value of a Redis key.
Handles different Redis data types (string, list, set, hash, zset).
Automatically parses JSON values.

Examples:
- redis_get_key(key="hester:session:abc123")
- redis_get_key(key="hester:bundle:auth:content", env="production")""",
    parameters={
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "The Redis key to retrieve",
            },
            "env": {
                "type": "string",
                "enum": ["local", "production"],
                "description": "Redis environment (default: local)",
            },
        },
        "required": ["key"],
    },
    environments=_REDIS_ENVIRONMENTS,
)

REDIS_KEY_INFO_TOOL = ToolDefinition(
    name="redis_key_info",
    description="""Get type and TTL information for a Redis key.
Useful for debugging session timeouts and cache behavior.

Examples:
- redis_key_info(key="hester:session:abc123")
- redis_key_info(key="hester:bundle:api:meta", env="production")""",
    parameters={
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "The Redis key to inspect",
            },
            "env": {
                "type": "string",
                "enum": ["local", "production"],
                "description": "Redis environment (default: local)",
            },
        },
        "required": ["key"],
    },
    environments=_REDIS_ENVIRONMENTS,
)

REDIS_DELETE_KEY_TOOL = ToolDefinition(
    name="redis_delete_key",
    description="""Delete a Redis key.
Safety: Only allows deleting keys with 'hester:' prefix. No wildcards.

Use with caution - this permanently removes data.

Examples:
- redis_delete_key(key="hester:session:expired123")
- redis_delete_key(key="hester:bundle:old:content", env="production")""",
    parameters={
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "The Redis key to delete (must start with 'hester:')",
            },
            "env": {
                "type": "string",
                "enum": ["local", "production"],
                "description": "Redis environment (default: local)",
            },
        },
        "required": ["key"],
    },
    environments=_REDIS_ENVIRONMENTS,
)

REDIS_STATS_TOOL = ToolDefinition(
    name="redis_stats",
    description="""Get summary statistics of Hester keys in Redis.
Groups keys by prefix (hester:session, hester:bundle, etc.) and shows counts.

Useful for understanding cache/session usage patterns.

Examples:
- redis_stats() - local stats
- redis_stats(env="production") - production stats""",
    parameters={
        "type": "object",
        "properties": {
            "env": {
                "type": "string",
                "enum": ["local", "production"],
                "description": "Redis environment (default: local)",
            },
        },
        "required": [],
    },
    environments=_REDIS_ENVIRONMENTS,
)


# All Redis tools
REDIS_TOOLS = [
    REDIS_LIST_KEYS_TOOL,
    REDIS_GET_KEY_TOOL,
    REDIS_KEY_INFO_TOOL,
    REDIS_DELETE_KEY_TOOL,
    REDIS_STATS_TOOL,
]
