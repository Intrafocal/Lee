"""
Hester Redis Tools - Redis inspection and management tools.

Supports both local Redis and production Redis via kubectl exec.
"""

import asyncio
import json
import os
import subprocess
from typing import Any, Dict, List, Optional

try:
    import redis.asyncio as aioredis
except ImportError:
    aioredis = None

from .base import ToolResult


# =============================================================================
# Configuration
# =============================================================================

PRODUCTION_REDIS_NAMESPACE = "coefficiency"
PRODUCTION_REDIS_LABEL = "app=redis"
LOCAL_REDIS_URL = "redis://localhost:6379"


# =============================================================================
# Production Redis via kubectl
# =============================================================================


def _get_redis_pod(namespace: str = PRODUCTION_REDIS_NAMESPACE) -> str:
    """
    Auto-discover Redis pod via kubectl.

    Uses label selector to find the pod dynamically, so it works even after
    pod restarts or deployments.
    """
    cmd = [
        "kubectl", "get", "pods",
        "-n", namespace,
        "-l", PRODUCTION_REDIS_LABEL,
        "-o", "jsonpath={.items[0].metadata.name}",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            raise RuntimeError(f"kubectl failed: {result.stderr.strip()}")
        pod_name = result.stdout.strip()
        if not pod_name:
            raise RuntimeError(f"No Redis pod found with label '{PRODUCTION_REDIS_LABEL}'")
        return pod_name
    except subprocess.TimeoutExpired:
        raise RuntimeError("kubectl timed out while discovering Redis pod")


def _kubectl_redis_exec(
    command: List[str],
    namespace: str = PRODUCTION_REDIS_NAMESPACE,
    timeout: int = 30,
) -> str:
    """
    Execute redis-cli command on production via kubectl exec.

    Args:
        command: Redis command as list of strings (e.g., ["KEYS", "hester:*"])
        namespace: Kubernetes namespace
        timeout: Command timeout in seconds

    Returns:
        Command output as string
    """
    pod_name = _get_redis_pod(namespace)

    cmd = [
        "kubectl", "exec", "-n", namespace,
        pod_name, "--",
        "redis-cli", *command,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            raise RuntimeError(f"redis-cli failed: {result.stderr.strip()}")
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"kubectl exec timed out after {timeout}s")


# =============================================================================
# Local Redis Connection
# =============================================================================


async def _get_local_redis() -> "aioredis.Redis":
    """Get a local Redis client."""
    if aioredis is None:
        raise ImportError("redis package required. Install: pip install redis")

    url = os.environ.get("REDIS_URL", LOCAL_REDIS_URL)
    return aioredis.from_url(url, decode_responses=True)


# =============================================================================
# Redis Tools
# =============================================================================


async def redis_list_keys(
    pattern: str = "*",
    env: str = "local",
    **kwargs,
) -> ToolResult:
    """
    List Redis keys matching a pattern.

    Args:
        pattern: Key pattern to match (default: hester:*)
        env: Environment - 'local' or 'production'

    Returns:
        ToolResult with list of matching keys
    """
    try:
        if env == "production":
            output = _kubectl_redis_exec(["KEYS", pattern])
            keys = [k for k in output.split("\n") if k] if output else []
        else:
            client = await _get_local_redis()
            try:
                keys = await client.keys(pattern)
            finally:
                await client.aclose()

        return ToolResult(
            success=True,
            data={"keys": sorted(keys), "count": len(keys), "pattern": pattern, "env": env},
            message=f"Found {len(keys)} keys matching '{pattern}' ({env})",
        )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def redis_get_key(
    key: str,
    env: str = "local",
    **kwargs,
) -> ToolResult:
    """
    Get the value of a Redis key.

    Handles different Redis data types (string, list, set, hash, zset).
    Automatically parses JSON values.

    Args:
        key: The Redis key to retrieve
        env: Environment - 'local' or 'production'

    Returns:
        ToolResult with key value and type
    """
    try:
        if env == "production":
            # Get type first
            key_type = _kubectl_redis_exec(["TYPE", key])

            if key_type == "none":
                return ToolResult(success=False, error=f"Key not found: {key}")
            elif key_type == "string":
                value = _kubectl_redis_exec(["GET", key])
            elif key_type == "list":
                value = _kubectl_redis_exec(["LRANGE", key, "0", "-1"])
                value = value.split("\n") if value else []
            elif key_type == "set":
                value = _kubectl_redis_exec(["SMEMBERS", key])
                value = value.split("\n") if value else []
            elif key_type == "hash":
                raw = _kubectl_redis_exec(["HGETALL", key])
                lines = raw.split("\n") if raw else []
                value = dict(zip(lines[::2], lines[1::2])) if lines else {}
            elif key_type == "zset":
                raw = _kubectl_redis_exec(["ZRANGE", key, "0", "-1", "WITHSCORES"])
                lines = raw.split("\n") if raw else []
                value = list(zip(lines[::2], lines[1::2])) if lines else []
            else:
                value = f"<{key_type}>"
        else:
            client = await _get_local_redis()
            try:
                key_type = await client.type(key)

                if key_type == "none":
                    return ToolResult(success=False, error=f"Key not found: {key}")
                elif key_type == "string":
                    value = await client.get(key)
                elif key_type == "list":
                    value = await client.lrange(key, 0, -1)
                elif key_type == "set":
                    value = list(await client.smembers(key))
                elif key_type == "hash":
                    value = await client.hgetall(key)
                elif key_type == "zset":
                    value = await client.zrange(key, 0, -1, withscores=True)
                else:
                    value = f"<{key_type}>"
            finally:
                await client.aclose()

        # Try to parse JSON if it's a string
        parsed_value = value
        if isinstance(value, str):
            try:
                parsed_value = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                pass

        return ToolResult(
            success=True,
            data={"key": key, "type": key_type, "value": parsed_value, "env": env},
            message=f"Retrieved {key_type} key: {key} ({env})",
        )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def redis_key_info(
    key: str,
    env: str = "local",
    **kwargs,
) -> ToolResult:
    """
    Get type and TTL information for a Redis key.

    Args:
        key: The Redis key to inspect
        env: Environment - 'local' or 'production'

    Returns:
        ToolResult with key type, TTL, and memory usage
    """
    try:
        if env == "production":
            key_type = _kubectl_redis_exec(["TYPE", key])
            if key_type == "none":
                return ToolResult(success=False, error=f"Key not found: {key}")

            ttl = int(_kubectl_redis_exec(["TTL", key]))
            memory = None  # MEMORY USAGE may not be available
        else:
            client = await _get_local_redis()
            try:
                key_type = await client.type(key)
                if key_type == "none":
                    return ToolResult(success=False, error=f"Key not found: {key}")

                ttl = await client.ttl(key)
                try:
                    memory = await client.memory_usage(key)
                except Exception:
                    memory = None
            finally:
                await client.aclose()

        # Human-readable TTL
        if ttl == -1:
            ttl_human = "no expiry"
        elif ttl == -2:
            ttl_human = "not found"
        elif ttl < 60:
            ttl_human = f"{ttl}s"
        elif ttl < 3600:
            ttl_human = f"{ttl // 60}m {ttl % 60}s"
        else:
            hours = ttl // 3600
            mins = (ttl % 3600) // 60
            ttl_human = f"{hours}h {mins}m"

        return ToolResult(
            success=True,
            data={
                "key": key,
                "type": key_type,
                "ttl": ttl,
                "ttl_human": ttl_human,
                "memory_bytes": memory,
                "env": env,
            },
            message=f"{key}: {key_type}, TTL={ttl_human} ({env})",
        )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def redis_delete_key(
    key: str,
    env: str = "local",
    **kwargs,
) -> ToolResult:
    """
    Delete a Redis key.

    Safety checks:
    - Only allows deleting keys with 'hester:' prefix
    - No wildcard patterns allowed

    Args:
        key: The Redis key to delete (must start with 'hester:')
        env: Environment - 'local' or 'production'

    Returns:
        ToolResult indicating success/failure
    """
    # Safety: block wildcard deletion
    if "*" in key or "?" in key or "[" in key:
        return ToolResult(
            success=False,
            error="Wildcard deletion not allowed. Delete keys individually.",
        )

    # Safety: block non-hester keys
    if not key.startswith("hester:"):
        return ToolResult(
            success=False,
            error="Can only delete keys with 'hester:' prefix for safety.",
        )

    try:
        if env == "production":
            result = int(_kubectl_redis_exec(["DEL", key]))
        else:
            client = await _get_local_redis()
            try:
                result = await client.delete(key)
            finally:
                await client.aclose()

        if result == 0:
            return ToolResult(success=False, error=f"Key not found: {key}")

        return ToolResult(
            success=True,
            data={"key": key, "deleted": True, "env": env},
            message=f"Deleted key: {key} ({env})",
        )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def redis_info(
    env: str = "local",
    section: str = "server",
    **kwargs,
) -> ToolResult:
    """
    Get Redis server info.

    Args:
        env: Environment - 'local' or 'production'
        section: Info section (server, clients, memory, stats, replication, etc.)

    Returns:
        ToolResult with server info dictionary
    """
    try:
        if env == "production":
            output = _kubectl_redis_exec(["INFO", section])
            info = {}
            for line in output.split("\n"):
                line = line.strip()
                if ":" in line and not line.startswith("#"):
                    k, v = line.split(":", 1)
                    info[k] = v
        else:
            client = await _get_local_redis()
            try:
                info = await client.info(section)
            finally:
                await client.aclose()

        return ToolResult(
            success=True,
            data={"section": section, "info": info, "env": env},
            message=f"Redis {section} info retrieved ({env})",
        )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def redis_stats(
    env: str = "local",
    **kwargs,
) -> ToolResult:
    """
    Get summary statistics of Hester keys in Redis.

    Groups keys by prefix (first two segments) and shows counts.

    Args:
        env: Environment - 'local' or 'production'

    Returns:
        ToolResult with key counts by prefix
    """
    try:
        # Get all hester keys
        result = await redis_list_keys("hester:*", env)
        if not result.success:
            return result

        keys = result.data["keys"]

        # Count by prefix (first two segments: hester:session, hester:bundle, etc.)
        prefixes: Dict[str, int] = {}
        for key in keys:
            parts = key.split(":")
            if len(parts) >= 2:
                prefix = f"{parts[0]}:{parts[1]}"
            else:
                prefix = key
            prefixes[prefix] = prefixes.get(prefix, 0) + 1

        # Sort by count descending
        sorted_prefixes = dict(sorted(prefixes.items(), key=lambda x: -x[1]))

        return ToolResult(
            success=True,
            data={
                "total_keys": len(keys),
                "by_prefix": sorted_prefixes,
                "env": env,
            },
            message=f"Found {len(keys)} Hester keys across {len(prefixes)} prefixes ({env})",
        )
    except Exception as e:
        return ToolResult(success=False, error=str(e))
