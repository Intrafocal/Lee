"""
MCP server CLI command for Hester.

Runs the Hester MCP server on stdio for Claude Code integration.

Usage:
    hester mcp-server

Setup in Claude Code:
    claude mcp add hester -- hester mcp-server
"""
import click


@click.command("mcp-server")
def mcp_server():
    """Run Hester MCP server on stdio for Claude Code integration.

    The MCP server provides structured access to:
    - Database exploration (db_tables, db_describe, db_query)
    - Documentation semantic search (docs_search)
    - Context bundles (context_get)

    The db_query tool supports decryption of encrypted columns for local
    Supabase development. Pass decrypt=True and user_id="UUID" to decrypt
    encrypted_* columns automatically.

    \b
    Setup:
        claude mcp add hester -- hester mcp-server

    \b
    Verify:
        claude mcp list
    """
    from hester.mcp.server import main

    main()
