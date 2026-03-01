"""
Hester CLI - Redis inspection and management commands.

Usage:
    hester redis keys
    hester redis get hester:session:abc123
    hester redis stats
"""

import asyncio
import sys
from typing import Any, Dict, List, Optional

import click
from rich.console import Console

console = Console()


@click.group()
def redis():
    """Redis inspection and management commands."""
    pass


@redis.command("keys")
@click.option(
    "--pattern", "-p",
    default="*",
    help="Key pattern to match (default: * - all keys)"
)
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
def redis_keys(pattern: str, env: str):
    """List Redis keys matching a pattern.

    Examples:
        hester redis keys                           # All keys
        hester redis keys --pattern "hester:*"      # Hester keys only
        hester redis keys --pattern "session:*"    # Session keys
        hester redis keys --env production
    """
    from hester.daemon.tools.redis_tools import redis_list_keys

    console.print(f"[bold]Redis Keys[/bold] ({env})")
    console.print(f"[dim]Pattern: {pattern}[/dim]")
    console.print()

    result = asyncio.run(redis_list_keys(pattern, env))

    if not result.success:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    keys = result.data["keys"]
    if not keys:
        console.print("[yellow]No keys found.[/yellow]")
        return

    for key in keys:
        console.print(f"  {key}")

    console.print()
    console.print(f"[dim]Total: {len(keys)} keys[/dim]")


@redis.command("get")
@click.argument("key")
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
@click.option(
    "--json", "-j",
    "as_json",
    is_flag=True,
    help="Output as JSON"
)
@click.option(
    "--decrypt", "-d",
    is_flag=True,
    help="Decrypt encrypted fields (local Redis only)"
)
@click.option(
    "--user-id", "-u",
    "user_id",
    default=None,
    help="User ID for decryption (required with --decrypt)"
)
def redis_get(key: str, env: str, as_json: bool, decrypt: bool, user_id: Optional[str]):
    """Get the value of a Redis key.

    Use --decrypt with --user-id to automatically decrypt encrypted values
    when querying local Redis. This only works in development mode.

    Examples:
        hester redis get hester:session:abc123
        hester redis get hester:bundle:auth:content --env production
        hester redis get hester:session:xyz --json
        hester redis get hester:context:user123 --decrypt --user-id UUID
    """
    import json as json_module
    from hester.daemon.tools.redis_tools import redis_get_key

    # Validate decrypt options
    if decrypt and not user_id:
        console.print("[red]Error: --decrypt requires --user-id to be specified[/red]")
        console.print("[dim]Example: hester redis get key --decrypt --user-id UUID[/dim]")
        sys.exit(1)

    if decrypt and env == "production":
        console.print("[red]Error: --decrypt only works with local Redis[/red]")
        console.print("[dim]Decryption requires access to local Supabase DEKs.[/dim]")
        sys.exit(1)

    result = asyncio.run(redis_get_key(key, env))

    if not result.success:
        if as_json:
            print(json_module.dumps({"error": result.error}))
        else:
            console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    data = result.data
    value = data["value"]
    fields_decrypted = 0

    # Decrypt if requested
    if decrypt and value is not None:
        value, fields_decrypted = asyncio.run(
            _decrypt_redis_value(value, user_id)
        )

    if as_json:
        output = {**data, "value": value}
        if decrypt:
            output["fields_decrypted"] = fields_decrypted
        print(json_module.dumps(output, indent=2, default=str))
        return

    console.print(f"[bold]Key:[/bold] {data['key']}")
    console.print(f"[dim]Type: {data['type']}[/dim]")
    if decrypt:
        console.print(f"[dim]Decrypting for user: {user_id}[/dim]")
    console.print()
    console.print("[bold]Value:[/bold]")

    if isinstance(value, (dict, list)):
        console.print(json_module.dumps(value, indent=2, default=str))
    else:
        console.print(str(value))

    if fields_decrypted > 0:
        console.print()
        console.print(f"[dim]({fields_decrypted} fields decrypted)[/dim]")


@redis.command("type")
@click.argument("key")
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
def redis_type_cmd(key: str, env: str):
    """Get the type of a Redis key.

    Examples:
        hester redis type hester:session:abc123
    """
    from hester.daemon.tools.redis_tools import redis_key_info

    result = asyncio.run(redis_key_info(key, env))

    if not result.success:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    data = result.data
    console.print(f"{data['key']}: [cyan]{data['type']}[/cyan]")


@redis.command("ttl")
@click.argument("key")
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
def redis_ttl(key: str, env: str):
    """Get the TTL of a Redis key.

    Examples:
        hester redis ttl hester:session:abc123
    """
    from hester.daemon.tools.redis_tools import redis_key_info

    result = asyncio.run(redis_key_info(key, env))

    if not result.success:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    data = result.data
    console.print(f"{data['key']}: [cyan]{data['ttl_human']}[/cyan]")
    if data.get("memory_bytes"):
        console.print(f"[dim]Memory: {data['memory_bytes']} bytes[/dim]")


@redis.command("delete")
@click.argument("key")
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
@click.option(
    "--yes", "-y",
    is_flag=True,
    help="Skip confirmation"
)
def redis_delete(key: str, env: str, yes: bool):
    """Delete a Redis key.

    Only allows deleting keys with 'hester:' prefix.
    Wildcard patterns are not allowed.

    Examples:
        hester redis delete hester:session:abc123
        hester redis delete hester:session:xyz --yes
        hester redis delete hester:session:old --env production --yes
    """
    from hester.daemon.tools.redis_tools import redis_delete_key

    if not yes:
        if not click.confirm(f"Delete key '{key}' from {env} Redis?"):
            console.print("[dim]Cancelled.[/dim]")
            return

    result = asyncio.run(redis_delete_key(key, env))

    if not result.success:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    console.print(f"[green]Deleted:[/green] {key}")


@redis.command("info")
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
@click.option(
    "--section", "-s",
    default="server",
    help="Info section (server, clients, memory, stats, etc.)"
)
def redis_info_cmd(env: str, section: str):
    """Get Redis server info.

    Examples:
        hester redis info
        hester redis info --section memory
        hester redis info --env production --section clients
    """
    from hester.daemon.tools.redis_tools import redis_info

    result = asyncio.run(redis_info(env, section))

    if not result.success:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    console.print(f"[bold]Redis Info ({env})[/bold]")
    console.print(f"[dim]Section: {section}[/dim]")
    console.print()

    for key, value in result.data["info"].items():
        console.print(f"  {key}: {value}")


@redis.command("stats")
@click.option(
    "--env", "-e",
    type=click.Choice(["local", "production"]),
    default="local",
    help="Redis environment (default: local)"
)
def redis_stats_cmd(env: str):
    """Show summary statistics of Hester keys.

    Groups keys by prefix and shows counts.

    Examples:
        hester redis stats
        hester redis stats --env production
    """
    from hester.daemon.tools.redis_tools import redis_stats

    result = asyncio.run(redis_stats(env))

    if not result.success:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)

    console.print(f"[bold]Hester Redis Stats ({env})[/bold]")
    console.print()

    data = result.data
    console.print(f"[cyan]Total keys:[/cyan] {data['total_keys']}")
    console.print()

    if data["by_prefix"]:
        console.print("[cyan]By prefix:[/cyan]")
        for prefix, count in data["by_prefix"].items():
            console.print(f"  {prefix}: {count}")
    else:
        console.print("[yellow]No Hester keys found.[/yellow]")


# =============================================================================
# Decryption Helpers
# =============================================================================


async def _decrypt_redis_value(value: Any, user_id: str) -> tuple:
    """Helper to decrypt Redis values using local Supabase DEKs.

    Handles:
    - Simple string values (entire value is encrypted)
    - JSON dict values with encrypted_* keys
    - JSON list values containing dicts with encrypted_* keys

    Args:
        value: The Redis value (already parsed from JSON if applicable)
        user_id: User UUID for DEK lookup

    Returns:
        Tuple of (decrypted_value, fields_decrypted_count)
    """
    import base64
    import os

    from hester.cli.crypto_utils import LocalDecryptor, LocalDecryptionError
    from hester.daemon.tools.db_tools import get_db

    # Check environment gate
    environment = os.getenv("HESTER_ENVIRONMENT", "daemon")
    if environment in ("slack", "production"):
        console.print("[red]Decryption disabled in production environment[/red]")
        return value, 0

    # Get database URL from environment
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        host = os.getenv("POSTGRES_HOST", "127.0.0.1")
        port = os.getenv("POSTGRES_PORT", "54322")
        database = os.getenv("POSTGRES_DATABASE", "postgres")
        user = os.getenv("POSTGRES_USER", "postgres")
        password = os.getenv("POSTGRES_PASSWORD", "postgres")
        database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"

    try:
        decryptor = LocalDecryptor(database_url)
    except LocalDecryptionError as e:
        console.print(f"[red]Decryption error: {e}[/red]")
        return value, 0

    # Get database pool for DEK lookup
    db = await get_db()

    # Case 1: Value is a simple string - try to decrypt the whole thing
    if isinstance(value, str):
        # Check if it looks like a base64-encoded ciphertext
        if _looks_like_ciphertext(value):
            try:
                deks = await decryptor.get_user_deks(user_id, db.pool)
                if deks:
                    decrypted = decryptor.decrypt_value(value, deks)
                    if decrypted and not decrypted.startswith("[decrypt failed"):
                        return decrypted, 1
            except LocalDecryptionError:
                pass
        return value, 0

    # Case 2: Value is a dict - look for encrypted_* keys
    if isinstance(value, dict):
        return await _decrypt_dict(value, user_id, decryptor, db.pool)

    # Case 3: Value is a list - decrypt each dict item
    if isinstance(value, list):
        total_decrypted = 0
        decrypted_list = []
        for item in value:
            if isinstance(item, dict):
                decrypted_item, count = await _decrypt_dict(item, user_id, decryptor, db.pool)
                decrypted_list.append(decrypted_item)
                total_decrypted += count
            else:
                decrypted_list.append(item)
        return decrypted_list, total_decrypted

    # Other types: return as-is
    return value, 0


async def _decrypt_dict(
    data: Dict[str, Any],
    user_id: str,
    decryptor: "LocalDecryptor",
    pool
) -> tuple:
    """Decrypt encrypted_* fields in a dictionary.

    Args:
        data: Dictionary possibly containing encrypted_* keys
        user_id: User UUID for DEK lookup
        decryptor: LocalDecryptor instance
        pool: asyncpg connection pool

    Returns:
        Tuple of (decrypted_dict, fields_decrypted_count)
    """
    from hester.cli.crypto_utils import LocalDecryptionError

    # Find encrypted columns
    encrypted_cols = [k for k in data.keys() if k.startswith("encrypted_")]

    if not encrypted_cols:
        return data, 0

    # Get DEKs
    try:
        deks = await decryptor.get_user_deks(user_id, pool)
    except LocalDecryptionError as e:
        # Return with error markers
        new_data = dict(data)
        for col in encrypted_cols:
            plain_col = col.replace("encrypted_", "")
            new_data[plain_col] = f"[{e}]"
            del new_data[col]
        return new_data, 0

    if not deks:
        # No DEKs found - return with error markers
        new_data = dict(data)
        for col in encrypted_cols:
            plain_col = col.replace("encrypted_", "")
            new_data[plain_col] = "[no DEKs found for user]"
            del new_data[col]
        return new_data, 0

    # Decrypt each field
    new_data = dict(data)
    fields_decrypted = 0

    for col in encrypted_cols:
        ciphertext = new_data.get(col)
        if not ciphertext:
            plain_col = col.replace("encrypted_", "")
            new_data[plain_col] = None
            del new_data[col]
            continue

        # Get hash column if it exists (for verification)
        plain_col = col.replace("encrypted_", "")
        hash_col = f"{plain_col}_hash"
        expected_hash = new_data.get(hash_col)

        # Decrypt
        plaintext = decryptor.decrypt_value(ciphertext, deks, expected_hash)

        # Replace encrypted with decrypted
        new_data[plain_col] = plaintext
        del new_data[col]

        # Remove hash column from output
        if hash_col in new_data:
            del new_data[hash_col]

        fields_decrypted += 1

    return new_data, fields_decrypted


def _looks_like_ciphertext(value: str) -> bool:
    """Check if a string looks like base64-encoded ciphertext.

    AES-GCM ciphertext should be:
    - Base64 encoded
    - At least 28 bytes decoded (12 byte nonce + 16 byte tag minimum)
    """
    import base64

    try:
        decoded = base64.b64decode(value)
        return len(decoded) >= 28  # 12 (nonce) + 16 (tag) minimum
    except Exception:
        return False
