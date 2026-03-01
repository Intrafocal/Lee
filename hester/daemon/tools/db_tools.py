"""
Hester Database Tools - Read-only PostgreSQL database exploration tools.

Adapted from the PostgreSQL MCP server for CLI and ReAct usage.
"""

import os
import re
from typing import Any, Dict, List, Optional, Tuple

try:
    import asyncpg
except ImportError:
    asyncpg = None

from .base import ToolResult


# =============================================================================
# Decryption Support
# =============================================================================

_decryptor = None


async def get_decryptor():
    """Get LocalDecryptor for encrypted fields (lazy initialization).

    Returns None if:
    - Running in production environment (HESTER_ENVIRONMENT=slack/production)
    - Not running against local Supabase
    - Decryption dependencies not available
    """
    global _decryptor
    if _decryptor is not None:
        return _decryptor

    # Never decrypt in production environments
    environment = os.getenv("HESTER_ENVIRONMENT", "daemon")
    if environment in ("slack", "production"):
        return None

    try:
        from hester.cli.crypto_utils import LocalDecryptor, LocalDecryptionError

        database_url = os.getenv("DATABASE_URL", "")
        if not database_url:
            host = os.getenv("POSTGRES_HOST", "127.0.0.1")
            port = os.getenv("POSTGRES_PORT", "54322")
            database = os.getenv("POSTGRES_DATABASE", "postgres")
            user = os.getenv("POSTGRES_USER", "postgres")
            password = os.getenv("POSTGRES_PASSWORD", "postgres")
            database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"

        _decryptor = LocalDecryptor(database_url)
        return _decryptor
    except Exception:
        return None


async def decrypt_rows(
    rows: List[Dict[str, Any]],
    user_id: str,
    pool: "asyncpg.Pool"
) -> Tuple[List[Dict[str, Any]], int]:
    """Decrypt encrypted_* columns in rows.

    Args:
        rows: List of row dicts
        user_id: User UUID for DEK lookup
        pool: Database connection pool

    Returns:
        Tuple of (decrypted_rows, count_decrypted)
    """
    decryptor = await get_decryptor()
    if not decryptor or not rows:
        return rows, 0

    return await decryptor.decrypt_rows(rows, user_id, pool)


class DatabaseConnection:
    """Manages PostgreSQL connection pool with lazy initialization."""

    def __init__(self):
        self.pool: Optional["asyncpg.Pool"] = None

    async def initialize(
        self,
        host: str = None,
        port: int = None,
        database: str = None,
        user: str = None,
        password: str = None,
    ):
        """Initialize the database connection pool."""
        if asyncpg is None:
            raise ImportError("asyncpg is required for database tools. Install with: pip install asyncpg")

        # Try DATABASE_URL first (common in Supabase/Docker setups)
        database_url = os.getenv("DATABASE_URL")
        if database_url and not all([host, port, database, user]):
            # Parse postgresql://user:password@host:port/database
            import re
            match = re.match(
                r"postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)",
                database_url
            )
            if match:
                user = user or match.group(1)
                password = password or match.group(2)
                host = host or match.group(3)
                port = port or int(match.group(4))
                database = database or match.group(5)

        # Fall back to individual environment variables
        host = host or os.getenv("POSTGRES_HOST", "localhost")
        port = port or int(os.getenv("POSTGRES_PORT", "5432"))
        database = database or os.getenv("POSTGRES_DATABASE")
        user = user or os.getenv("POSTGRES_USER")
        password = password or os.getenv("POSTGRES_PASSWORD")

        if not all([database, user]):
            raise ValueError(
                "Database credentials required. Set DATABASE_URL or individual "
                "POSTGRES_DATABASE/POSTGRES_USER environment variables."
            )

        self.pool = await asyncpg.create_pool(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
            min_size=1,
            max_size=5,
        )

    async def close(self):
        """Close the database connection pool."""
        if self.pool:
            await self.pool.close()
            self.pool = None

    async def ensure_connected(self, **kwargs):
        """Ensure connection is established, initialize if needed."""
        if not self.pool:
            await self.initialize(**kwargs)


# Global connection instance
_db = DatabaseConnection()


async def get_db() -> DatabaseConnection:
    """Get the database connection, initializing if needed."""
    await _db.ensure_connected()
    return _db


def validate_select_query(query: str) -> bool:
    """Validate that the query is a safe SELECT statement."""
    query_clean = query.strip().lower()

    if not query_clean.startswith("select"):
        return False

    # Block modification operations using word boundaries
    forbidden_patterns = [
        r"\binsert\b",
        r"\bupdate\b",
        r"\bdelete\b",
        r"\bdrop\b",
        r"\bcreate\b",
        r"\balter\b",
        r"\btruncate\b",
        r"\bexec\b",
        r"\bexecute\b",
        r"\bcall\b",
        r"\blimit\b",  # We add LIMIT ourselves
    ]

    for pattern in forbidden_patterns:
        if re.search(pattern, query_clean):
            return False

    return True


async def list_tables() -> ToolResult:
    """
    List all tables in the database with their schema information.

    Returns all user-defined tables (excludes system tables) with schema, name, and owner.
    """
    try:
        db = await get_db()
        async with db.pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT schemaname, tablename, tableowner
                FROM pg_tables
                WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
                ORDER BY schemaname, tablename
            """)

            return ToolResult(
                success=True,
                data=[dict(row) for row in rows],
                message=f"Found {len(rows)} tables",
            )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def describe_table(table_name: str, schema_name: str = "public") -> ToolResult:
    """
    Describe the structure of a specific table.

    Args:
        table_name: Name of the table to describe
        schema_name: Schema containing the table (defaults to 'public')

    Returns column definitions, types, constraints, and indexes.
    """
    try:
        db = await get_db()
        async with db.pool.acquire() as conn:
            columns = await conn.fetch(
                """
                SELECT
                    column_name,
                    data_type,
                    is_nullable,
                    column_default,
                    character_maximum_length,
                    numeric_precision,
                    numeric_scale
                FROM information_schema.columns
                WHERE table_name = $1 AND table_schema = $2
                ORDER BY ordinal_position
            """,
                table_name,
                schema_name,
            )

            indexes = await conn.fetch(
                """
                SELECT
                    i.indexname,
                    i.indexdef,
                    array_agg(a.attname ORDER BY a.attnum) as column_names
                FROM pg_indexes i
                JOIN pg_class c ON c.relname = i.indexname
                JOIN pg_index idx ON idx.indexrelid = c.oid
                JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = ANY(idx.indkey)
                WHERE i.tablename = $1 AND i.schemaname = $2
                GROUP BY i.indexname, i.indexdef
            """,
                table_name,
                schema_name,
            )

            if not columns:
                return ToolResult(
                    success=False,
                    error=f"Table '{schema_name}.{table_name}' not found",
                )

            return ToolResult(
                success=True,
                data={
                    "table_name": table_name,
                    "schema_name": schema_name,
                    "columns": [dict(col) for col in columns],
                    "indexes": [dict(idx) for idx in indexes],
                },
                message=f"{len(columns)} columns, {len(indexes)} indexes",
            )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def list_functions(schema_name: str = "public", query: str = "") -> ToolResult:
    """
    List functions and procedures in the specified schema.

    Args:
        schema_name: Schema to search for functions (defaults to 'public')
        query: Optional string to filter function names (case-insensitive)
    """
    try:
        db = await get_db()
        async with db.pool.acquire() as conn:
            if query.strip():
                rows = await conn.fetch(
                    """
                    SELECT
                        routine_name as function_name,
                        routine_type,
                        data_type as return_type,
                        routine_definition
                    FROM information_schema.routines
                    WHERE routine_schema = $1 AND routine_name ILIKE $2
                    ORDER BY routine_name
                """,
                    schema_name,
                    f"%{query}%",
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT
                        routine_name as function_name,
                        routine_type,
                        data_type as return_type,
                        routine_definition
                    FROM information_schema.routines
                    WHERE routine_schema = $1
                    ORDER BY routine_name
                """,
                    schema_name,
                )

            return ToolResult(
                success=True,
                data=[dict(row) for row in rows],
                message=f"Found {len(rows)} functions",
            )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def list_rls_policies(table_name: str, schema_name: str = "public") -> ToolResult:
    """
    List Row Level Security (RLS) policies for a specific table.

    Args:
        table_name: Name of the table to check for RLS policies
        schema_name: Schema containing the table (defaults to 'public')
    """
    try:
        db = await get_db()
        async with db.pool.acquire() as conn:
            # Check if RLS is enabled on the table
            rls_status = await conn.fetchval(
                """
                SELECT relrowsecurity
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname = $1 AND n.nspname = $2
            """,
                table_name,
                schema_name,
            )

            # Get all policies for the table
            policies = await conn.fetch(
                """
                SELECT
                    pol.polname as policy_name,
                    pol.polcmd as command,
                    pg_get_expr(pol.polqual, pol.polrelid) as using_expression,
                    pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expression,
                    CASE
                        WHEN pol.polroles = '{0}' THEN 'PUBLIC'
                        ELSE array_to_string(ARRAY(
                            SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)
                        ), ', ')
                    END as roles
                FROM pg_policy pol
                JOIN pg_class c ON c.oid = pol.polrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relname = $1 AND n.nspname = $2
                ORDER BY pol.polname
            """,
                table_name,
                schema_name,
            )

            return ToolResult(
                success=True,
                data={
                    "table": f"{schema_name}.{table_name}",
                    "rls_enabled": bool(rls_status),
                    "policies": [dict(policy) for policy in policies],
                },
                message=f"RLS {'enabled' if rls_status else 'disabled'}, {len(policies)} policies",
            )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def list_column_constraints(
    table_name: str, schema_name: str = "public"
) -> ToolResult:
    """
    List all constraints on columns for a specific table.

    Args:
        table_name: Name of the table to check for column constraints
        schema_name: Schema containing the table (defaults to 'public')
    """
    try:
        db = await get_db()
        async with db.pool.acquire() as conn:
            constraints = await conn.fetch(
                """
                SELECT
                    tc.constraint_name,
                    tc.constraint_type,
                    kcu.column_name,
                    CASE
                        WHEN tc.constraint_type = 'FOREIGN KEY' THEN
                            ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name
                        ELSE NULL
                    END as foreign_key_reference,
                    CASE
                        WHEN tc.constraint_type = 'CHECK' THEN
                            cc.check_clause
                        ELSE NULL
                    END as check_expression
                FROM information_schema.table_constraints tc
                LEFT JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                LEFT JOIN information_schema.constraint_column_usage ccu
                    ON tc.constraint_name = ccu.constraint_name
                    AND tc.table_schema = ccu.constraint_schema
                LEFT JOIN information_schema.check_constraints cc
                    ON tc.constraint_name = cc.constraint_name
                    AND tc.table_schema = cc.constraint_schema
                WHERE tc.table_name = $1 AND tc.table_schema = $2
                ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position
            """,
                table_name,
                schema_name,
            )

            # Also get NOT NULL constraints from column info
            not_null_columns = await conn.fetch(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = $1 AND table_schema = $2 AND is_nullable = 'NO'
                ORDER BY ordinal_position
            """,
                table_name,
                schema_name,
            )

            return ToolResult(
                success=True,
                data={
                    "table": f"{schema_name}.{table_name}",
                    "constraints": [dict(c) for c in constraints],
                    "not_null_columns": [row["column_name"] for row in not_null_columns],
                },
                message=f"{len(constraints)} constraints, {len(not_null_columns)} NOT NULL columns",
            )
    except Exception as e:
        return ToolResult(success=False, error=str(e))


async def execute_select(query: str, limit: int = 10) -> ToolResult:
    """
    Execute a SELECT query with automatic row limiting.

    Args:
        query: SELECT statement (no LIMIT clause - added automatically)
        limit: Maximum rows to return (1-25, defaults to 10)

    Safety: Only SELECT statements allowed, LIMIT enforced.
    """
    if not validate_select_query(query):
        return ToolResult(
            success=False,
            error="Query must be a SELECT statement with no LIMIT clause and no modification operations",
        )

    # Validate limit parameter
    if not isinstance(limit, int) or limit < 1 or limit > 25:
        return ToolResult(
            success=False,
            error="Limit must be an integer between 1 and 25",
        )

    try:
        db = await get_db()
        async with db.pool.acquire() as conn:
            # Append LIMIT clause programmatically
            query_with_limit = f"{query.rstrip(';')} LIMIT {limit}"
            rows = await conn.fetch(query_with_limit)

            return ToolResult(
                success=True,
                data={
                    "query": query_with_limit,
                    "row_count": len(rows),
                    "data": [dict(row) for row in rows],
                },
                message=f"Returned {len(rows)} rows",
            )
    except Exception as e:
        return ToolResult(success=False, error=f"Query execution failed: {str(e)}")


async def count_rows(
    table_name: str, schema_name: str = "public", where_clause: str = ""
) -> ToolResult:
    """
    Count rows in a table with optional filtering.

    Args:
        table_name: Name of the table to count
        schema_name: Schema containing the table (defaults to 'public')
        where_clause: Optional WHERE conditions (without 'WHERE' keyword)
    """
    try:
        db = await get_db()
        base_query = f'SELECT COUNT(*) FROM "{schema_name}"."{table_name}"'

        if where_clause.strip():
            where_clean = where_clause.strip().lower()
            forbidden_keywords = [
                "insert",
                "update",
                "delete",
                "drop",
                "create",
                "alter",
                "truncate",
            ]
            if any(keyword in where_clean for keyword in forbidden_keywords):
                return ToolResult(
                    success=False,
                    error="WHERE clause contains forbidden operations",
                )

            base_query += f" WHERE {where_clause}"

        async with db.pool.acquire() as conn:
            result = await conn.fetchval(base_query)

            return ToolResult(
                success=True,
                data={
                    "table": f"{schema_name}.{table_name}",
                    "where_clause": where_clause if where_clause else None,
                    "count": result,
                },
                message=f"{result} rows",
            )
    except Exception as e:
        return ToolResult(success=False, error=f"Count query failed: {str(e)}")


async def close_db():
    """Close the database connection pool."""
    await _db.close()
