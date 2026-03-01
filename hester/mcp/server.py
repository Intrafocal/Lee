"""
Hester MCP Server - Minimal tool exposure for Claude Code.

Provides structured access to:
- Database exploration (read-only)
- Documentation semantic search
- Context bundles

Usage:
    hester mcp-server  # Runs MCP server on stdio
    claude mcp add hester -- hester mcp-server
"""
import os
from typing import Any, Dict, List, Optional

from fastmcp import FastMCP

mcp = FastMCP("Hester")

# Working directory for tools (defaults to cwd)
WORKING_DIR = os.getcwd()


@mcp.tool()
async def db_tables() -> List[Dict[str, Any]]:
    """List all database tables with schema information.

    Returns tables from public schema (excludes system tables).
    Each table includes: schemaname, tablename, tableowner.
    """
    from hester.daemon.tools.db_tools import list_tables

    result = await list_tables()
    if result.success:
        return result.data or []
    return []


@mcp.tool()
async def db_describe(table: str, schema: str = "public") -> Dict[str, Any]:
    """Describe table structure including columns, types, and indexes.

    Args:
        table: Table name to describe
        schema: Schema name (default: public)

    Returns column definitions, types, constraints, and indexes.
    """
    from hester.daemon.tools.db_tools import describe_table

    result = await describe_table(table, schema_name=schema)
    if result.success:
        return {
            "success": True,
            "table_name": table,
            "schema_name": schema,
            "columns": result.data.get("columns", []) if result.data else [],
            "indexes": result.data.get("indexes", []) if result.data else [],
        }
    return {"success": False, "error": result.error}


@mcp.tool()
async def db_query(
    query: str,
    limit: int = 10,
    decrypt: bool = False,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Execute a SELECT query (read-only, auto-limited).

    Args:
        query: SELECT statement (no LIMIT clause - added automatically)
        limit: Max rows to return (1-25, default: 10)
        decrypt: If True, decrypt encrypted_* columns (local Supabase only)
        user_id: Required when decrypt=True. The user UUID whose DEK to use.

    Safety: Only SELECT statements allowed, LIMIT enforced.
    Decryption only works with local Supabase (dev mode).
    """
    from hester.daemon.tools.db_tools import execute_select, get_db

    # Validate decrypt options
    if decrypt and not user_id:
        return {"success": False, "error": "--decrypt requires user_id to be specified"}

    result = await execute_select(query, limit=min(limit, 25))
    if not result.success:
        return {"success": False, "error": result.error}

    rows = result.data.get("data", []) if result.data else []
    fields_decrypted = 0

    # Decrypt if requested
    if decrypt and rows:
        import os
        from hester.cli.crypto_utils import LocalDecryptor, LocalDecryptionError

        # Get database URL
        database_url = os.getenv("DATABASE_URL", "")
        if not database_url:
            host = os.getenv("POSTGRES_HOST", "localhost")
            port = os.getenv("POSTGRES_PORT", "5432")
            database = os.getenv("POSTGRES_DATABASE", "postgres")
            user = os.getenv("POSTGRES_USER", "postgres")
            password = os.getenv("POSTGRES_PASSWORD", "postgres")
            database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"

        try:
            decryptor = LocalDecryptor(database_url)
            db = await get_db()
            rows, fields_decrypted = await decryptor.decrypt_rows(rows, user_id, db.pool)
        except LocalDecryptionError as e:
            return {"success": False, "error": f"Decryption error: {e}"}

    return {
        "success": True,
        "query": query,
        "row_count": len(rows),
        "data": rows,
        "fields_decrypted": fields_decrypted,
    }


@mcp.tool()
async def docs_search(query: str, limit: int = 5) -> Dict[str, Any]:
    """Semantic search over project documentation.

    Uses vector embeddings for semantic matching.

    Args:
        query: Natural language query (e.g., "How does authentication work?")
        limit: Maximum results to return (default: 5)

    Returns matching documentation sections with relevance scores.
    """
    from hester.daemon.tools.doc_tools import semantic_doc_search

    return await semantic_doc_search(query, WORKING_DIR, limit=limit)


@mcp.tool()
async def context_get(bundle: str) -> str:
    """Get content from a context bundle.

    Context bundles are reusable knowledge packages aggregating code,
    patterns, and database schemas into portable markdown documents.

    Args:
        bundle: Bundle identifier (e.g., "auth-system", "matching-algo")

    Returns:
        Bundle content as markdown string, or empty string if not found.
    """
    from hester.context.service import ContextBundleService

    service = ContextBundleService(WORKING_DIR)
    content = service.get_content(bundle)
    return content or ""


def main():
    """Run the MCP server."""
    # show_banner=False is critical - MCP protocol requires only JSON-RPC on stdout
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
