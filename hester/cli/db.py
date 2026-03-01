"""
Hester CLI - Database exploration commands (read-only).

Usage:
    hester db tables
    hester db describe profiles
    hester db query "SELECT * FROM profiles"
"""

import asyncio
import sys
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.group()
def db():
    """Database exploration commands (read-only)."""
    pass


@db.command("tables")
@click.option(
    "--schema", "-s",
    default=None,
    help="Filter by schema name"
)
def db_tables(schema: Optional[str]):
    """List all tables in the database.

    Examples:
        hester db tables
        hester db tables --schema public
    """
    from hester.daemon.tools.db_tools import list_tables

    console.print("[bold]Database Tables[/bold]")
    console.print()

    try:
        result = asyncio.run(list_tables())

        if not result.success:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        tables = result.data
        if schema:
            tables = [t for t in tables if t["schemaname"] == schema]

        if not tables:
            console.print("[yellow]No tables found.[/yellow]")
            return

        # Group by schema
        from collections import defaultdict
        by_schema = defaultdict(list)
        for t in tables:
            by_schema[t["schemaname"]].append(t["tablename"])

        for schema_name, table_names in sorted(by_schema.items()):
            console.print(f"[cyan]{schema_name}[/cyan]")
            for name in sorted(table_names):
                console.print(f"  {name}")
            console.print()

        console.print(f"[dim]Total: {len(tables)} tables[/dim]")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@db.command("describe")
@click.argument("table_name")
@click.option(
    "--schema", "-s",
    default="public",
    help="Schema name (default: public)"
)
def db_describe(table_name: str, schema: str):
    """Describe a table's structure.

    Shows columns, types, constraints, and indexes.

    Examples:
        hester db describe profiles
        hester db describe users --schema auth
    """
    from hester.daemon.tools.db_tools import describe_table

    console.print(f"[bold]Table: {schema}.{table_name}[/bold]")
    console.print()

    try:
        result = asyncio.run(describe_table(table_name, schema))

        if not result.success:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        data = result.data

        # Columns
        console.print("[cyan]Columns:[/cyan]")
        for col in data["columns"]:
            nullable = "" if col["is_nullable"] == "YES" else " NOT NULL"
            default = f" DEFAULT {col['column_default']}" if col["column_default"] else ""
            type_info = col["data_type"]
            if col["character_maximum_length"]:
                type_info += f"({col['character_maximum_length']})"
            console.print(f"  {col['column_name']}: {type_info}{nullable}{default}")

        # Indexes
        if data["indexes"]:
            console.print()
            console.print("[cyan]Indexes:[/cyan]")
            for idx in data["indexes"]:
                cols = ", ".join(idx["column_names"]) if idx["column_names"] else "?"
                console.print(f"  {idx['indexname']}: ({cols})")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@db.command("functions")
@click.option(
    "--schema", "-s",
    default="public",
    help="Schema name (default: public)"
)
@click.option(
    "--filter", "-f",
    "query",
    default="",
    help="Filter functions by name"
)
def db_functions(schema: str, query: str):
    """List database functions.

    Examples:
        hester db functions
        hester db functions --filter match
        hester db functions --schema analytics
    """
    from hester.daemon.tools.db_tools import list_functions

    console.print(f"[bold]Functions in {schema}[/bold]")
    if query:
        console.print(f"[dim]Filter: {query}[/dim]")
    console.print()

    try:
        result = asyncio.run(list_functions(schema, query))

        if not result.success:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        functions = result.data

        if not functions:
            console.print("[yellow]No functions found.[/yellow]")
            return

        for func in functions:
            ret_type = func.get("return_type", "void")
            console.print(f"  [green]{func['function_name']}[/green] -> {ret_type}")

        console.print()
        console.print(f"[dim]Total: {len(functions)} functions[/dim]")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@db.command("rls")
@click.argument("table_name")
@click.option(
    "--schema", "-s",
    default="public",
    help="Schema name (default: public)"
)
def db_rls(table_name: str, schema: str):
    """Show RLS policies for a table.

    Examples:
        hester db rls profiles
        hester db rls users --schema auth
    """
    from hester.daemon.tools.db_tools import list_rls_policies

    console.print(f"[bold]RLS Policies: {schema}.{table_name}[/bold]")
    console.print()

    try:
        result = asyncio.run(list_rls_policies(table_name, schema))

        if not result.success:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        data = result.data

        if data["rls_enabled"]:
            console.print("[green]RLS: ENABLED[/green]")
        else:
            console.print("[yellow]RLS: DISABLED[/yellow]")

        console.print()

        if not data["policies"]:
            console.print("[dim]No policies defined.[/dim]")
            return

        for policy in data["policies"]:
            console.print(f"[cyan]{policy['policy_name']}[/cyan]")
            console.print(f"  Command: {policy['command']}")
            console.print(f"  Roles: {policy['roles']}")
            if policy["using_expression"]:
                console.print(f"  USING: {policy['using_expression']}")
            if policy["with_check_expression"]:
                console.print(f"  WITH CHECK: {policy['with_check_expression']}")
            console.print()

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@db.command("constraints")
@click.argument("table_name")
@click.option(
    "--schema", "-s",
    default="public",
    help="Schema name (default: public)"
)
def db_constraints(table_name: str, schema: str):
    """Show constraints for a table.

    Examples:
        hester db constraints profiles
        hester db constraints orders --schema sales
    """
    from hester.daemon.tools.db_tools import list_column_constraints

    console.print(f"[bold]Constraints: {schema}.{table_name}[/bold]")
    console.print()

    try:
        result = asyncio.run(list_column_constraints(table_name, schema))

        if not result.success:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        data = result.data

        # Group by type
        from collections import defaultdict
        by_type = defaultdict(list)
        for c in data["constraints"]:
            by_type[c["constraint_type"]].append(c)

        for ctype, constraints in sorted(by_type.items()):
            console.print(f"[cyan]{ctype}:[/cyan]")
            for c in constraints:
                col = c.get("column_name", "?")
                if c.get("foreign_key_reference"):
                    console.print(f"  {c['constraint_name']}: {col} -> {c['foreign_key_reference']}")
                elif c.get("check_expression"):
                    console.print(f"  {c['constraint_name']}: {c['check_expression']}")
                else:
                    console.print(f"  {c['constraint_name']}: {col}")
            console.print()

        if data["not_null_columns"]:
            console.print("[cyan]NOT NULL:[/cyan]")
            console.print(f"  {', '.join(data['not_null_columns'])}")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@db.command("query")
@click.argument("sql")
@click.option(
    "--limit", "-l",
    default=10,
    type=int,
    help="Maximum rows to return (1-25, default: 10)"
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
    help="Decrypt encrypted_* fields (local Supabase only)"
)
@click.option(
    "--user-id", "-u",
    "user_id",
    default=None,
    help="User ID for decryption (required with --decrypt)"
)
def db_query(sql: str, limit: int, as_json: bool, decrypt: bool, user_id: Optional[str]):
    """Execute a SELECT query (read-only).

    Only SELECT statements are allowed. LIMIT is added automatically.

    Use --decrypt with --user-id to automatically decrypt encrypted_* fields
    when querying local Supabase. This only works in development mode.

    Examples:
        hester db query "SELECT * FROM profiles"
        hester db query "SELECT id, name FROM users WHERE active = true" --limit 5
        hester db query "SELECT COUNT(*) FROM opportunities" --json
        hester db query "SELECT * FROM genome_journal_entries" --decrypt --user-id UUID
    """
    from hester.daemon.tools.db_tools import execute_select, get_db

    # Validate decrypt options
    if decrypt and not user_id:
        console.print("[red]Error: --decrypt requires --user-id to be specified[/red]")
        console.print("[dim]Example: hester db query \"SELECT * FROM table\" --decrypt --user-id UUID[/dim]")
        sys.exit(1)

    if not as_json:
        console.print("[bold]Query Results[/bold]")
        console.print()

    try:
        # Run query and optional decryption in single async context
        async def _run_query_with_decrypt():
            from hester.daemon.tools.db_tools import execute_select as _exec_select
            result = await _exec_select(sql, limit)
            if not result.success:
                return result, None, 0

            rows = result.data["data"]
            fields_decrypted = 0

            if decrypt and rows:
                rows, fields_decrypted = await _decrypt_query_rows(rows, user_id)

            return result, rows, fields_decrypted

        result, rows, fields_decrypted = asyncio.run(_run_query_with_decrypt())

        if not result.success:
            if as_json:
                import json
                print(json.dumps({"error": result.error}))
            else:
                console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        data = result.data
        if rows is None:
            rows = data["data"]

        if as_json:
            import json
            print(json.dumps(rows, indent=2, default=str))
            return

        console.print(f"[dim]{data['query']}[/dim]")
        if decrypt:
            console.print(f"[dim]Decrypting for user: {user_id}[/dim]")
        console.print()

        if not rows:
            console.print("[yellow]No results.[/yellow]")
            return

        # Simple table output
        keys = list(rows[0].keys())
        console.print("  ".join(f"[cyan]{k}[/cyan]" for k in keys))
        console.print("-" * 60)
        for row in rows:
            values = [str(row.get(k, ""))[:50] for k in keys]  # Wider for decrypted content
            console.print("  ".join(values))

        console.print()
        row_info = f"{data['row_count']} rows"
        if fields_decrypted > 0:
            row_info += f" ({fields_decrypted} fields decrypted)"
        console.print(f"[dim]{row_info}[/dim]")

    except Exception as e:
        if as_json:
            import json
            print(json.dumps({"error": str(e)}))
        else:
            console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


async def _decrypt_query_rows(rows: list, user_id: str) -> tuple:
    """Helper to decrypt rows using local Supabase DEKs."""
    import os
    from hester.cli.crypto_utils import LocalDecryptor, LocalDecryptionError
    from hester.daemon.tools.db_tools import get_db

    # Get database URL from environment
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        # Construct from individual vars
        host = os.getenv("POSTGRES_HOST", "localhost")
        port = os.getenv("POSTGRES_PORT", "5432")
        database = os.getenv("POSTGRES_DATABASE", "postgres")
        user = os.getenv("POSTGRES_USER", "postgres")
        password = os.getenv("POSTGRES_PASSWORD", "postgres")
        database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"

    try:
        decryptor = LocalDecryptor(database_url)
    except LocalDecryptionError as e:
        from rich.console import Console
        Console().print(f"[red]Decryption error: {e}[/red]")
        return rows, 0

    # Get the connection pool
    db = await get_db()

    return await decryptor.decrypt_rows(rows, user_id, db.pool)


@db.command("count")
@click.argument("table_name")
@click.option(
    "--schema", "-s",
    default="public",
    help="Schema name (default: public)"
)
@click.option(
    "--where", "-w",
    "where_clause",
    default="",
    help="WHERE clause (without 'WHERE' keyword)"
)
def db_count(table_name: str, schema: str, where_clause: str):
    """Count rows in a table.

    Examples:
        hester db count profiles
        hester db count users --where "active = true"
        hester db count orders --schema sales --where "amount > 100"
    """
    from hester.daemon.tools.db_tools import count_rows

    try:
        result = asyncio.run(count_rows(table_name, schema, where_clause))

        if not result.success:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)

        data = result.data
        table_ref = data["table"]
        count = data["count"]

        if where_clause:
            console.print(f"{table_ref} WHERE {where_clause}: [bold]{count}[/bold] rows")
        else:
            console.print(f"{table_ref}: [bold]{count}[/bold] rows")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
