"""
Hester CLI - Context bundle commands (reusable knowledge packages).

Usage:
    hester context create auth-system --file services/api/src/auth.py
    hester context list
    hester context show auth-system
"""

import asyncio
import os
import sys
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.group()
def context():
    """Context bundle commands (reusable knowledge packages)."""
    pass


@context.command("create")
@click.argument("name")
@click.option(
    "--title", "-t",
    default=None,
    help="Human-readable title (default: derived from name)"
)
@click.option(
    "--file", "-f",
    multiple=True,
    help="Add a file source (can be repeated)"
)
@click.option(
    "--glob", "-g",
    multiple=True,
    help="Add a glob pattern source (can be repeated)"
)
@click.option(
    "--grep", "-r",
    multiple=True,
    help="Add a grep pattern source (can be repeated)"
)
@click.option(
    "--semantic", "-s",
    multiple=True,
    help="Add a semantic search query (can be repeated)"
)
@click.option(
    "--db-schema", "-d",
    multiple=True,
    help="Add a database table (can be repeated)"
)
@click.option(
    "--ttl",
    default=24,
    type=int,
    help="Time-to-live in hours (0=manual refresh, default: 24)"
)
@click.option(
    "--tag",
    multiple=True,
    help="Add a tag (can be repeated)"
)
def context_create(
    name: str,
    title: Optional[str],
    file: tuple,
    glob: tuple,
    grep: tuple,
    semantic: tuple,
    db_schema: tuple,
    ttl: int,
    tag: tuple,
):
    """Create a new context bundle.

    NAME is the bundle identifier (hyphenated, e.g., 'auth-system').

    Examples:

        hester context create auth-system --file services/api/src/auth.py --grep "jwt|token"

        hester context create matching-algo --glob "services/matching/**/*.py" --db-schema profiles

        hester context create api-overview --semantic "API endpoints" --ttl 48
    """
    from hester.context import (
        FileSource,
        GlobSource,
        GrepSource,
        SemanticSource,
        DbSchemaSource,
    )
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    bundle_title = title or name.replace("-", " ").title()

    # Build sources list
    sources = []

    for f in file:
        sources.append(FileSource(path=f))

    for g in glob:
        sources.append(GlobSource(pattern=g))

    for r in grep:
        sources.append(GrepSource(pattern=r))

    for s in semantic:
        sources.append(SemanticSource(query=s))

    for d in db_schema:
        # Parse table list (comma-separated)
        tables = [t.strip() for t in d.split(",")]
        sources.append(DbSchemaSource(tables=tables))

    if not sources:
        console.print("[yellow]Warning: No sources specified. Bundle will be empty.[/yellow]")
        console.print("[dim]Add sources with --file, --glob, --grep, --semantic, or --db-schema[/dim]")
        return

    console.print(f"[bold]Creating bundle:[/bold] {name}")
    console.print(f"[dim]Title: {bundle_title}[/dim]")
    console.print(f"[dim]Sources: {len(sources)}[/dim]")
    console.print(f"[dim]TTL: {ttl}h[/dim]")
    console.print()

    async def create_bundle():
        service = ContextBundleService(working_dir)
        bundle = await service.create(
            bundle_id=name,
            title=bundle_title,
            sources=sources,
            ttl_hours=ttl,
            tags=list(tag),
        )
        return bundle

    try:
        with console.status("[bold green]Evaluating sources and synthesizing..."):
            bundle = asyncio.run(create_bundle())

        console.print(f"\n[green]Created bundle: {name}[/green]")
        console.print(f"[dim]Location: .hester/context/bundles/{name}.md[/dim]")
        console.print(f"[dim]Sources: {len(bundle.metadata.sources)}[/dim]")

        # Show preview
        console.print("\n[bold]Preview:[/bold]")
        preview_lines = bundle.content.split("\n")[:10]
        for line in preview_lines:
            console.print(f"  {line}")
        if len(bundle.content.split("\n")) > 10:
            console.print("  [dim]...[/dim]")

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@context.command("list")
@click.option(
    "--stale-only",
    is_flag=True,
    help="Only show stale bundles"
)
def context_list(stale_only: bool):
    """List all context bundles.

    Shows bundle name, title, age, staleness status, and source count.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    service = ContextBundleService(working_dir)

    statuses = service.list_all()

    if stale_only:
        statuses = [s for s in statuses if s.is_stale]

    if not statuses:
        if stale_only:
            console.print("[dim]No stale bundles.[/dim]")
        else:
            console.print("[dim]No bundles found.[/dim]")
            console.print("[dim]Create one with: hester context create <name> --file ...[/dim]")
        return

    console.print("[bold]Context Bundles[/bold]")
    console.print()

    for status in statuses:
        # Format age
        if status.age_hours < 1:
            age_str = f"{int(status.age_hours * 60)}m"
        elif status.age_hours < 24:
            age_str = f"{int(status.age_hours)}h"
        else:
            age_str = f"{int(status.age_hours / 24)}d"

        # Status indicator
        if status.is_stale:
            indicator = "[red]STALE[/red]"
        else:
            indicator = "[green]OK[/green]"

        tags_str = ", ".join(status.tags) if status.tags else ""

        console.print(
            f"  {indicator} [bold]{status.id}[/bold] - {status.title}"
        )
        console.print(
            f"      [dim]{status.source_count} sources | {age_str} old | TTL {status.ttl_hours}h[/dim]"
            + (f" | {tags_str}" if tags_str else "")
        )


@context.command("show")
@click.argument("name")
@click.option(
    "--meta",
    is_flag=True,
    help="Show metadata (sources, hashes) instead of content"
)
def context_show(name: str, meta: bool):
    """Show a context bundle.

    NAME is the bundle identifier.

    By default shows the synthesized content. Use --meta to see source specs.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    service = ContextBundleService(working_dir)

    bundle = service.get(name)
    if not bundle:
        console.print(f"[red]Bundle not found: {name}[/red]")
        sys.exit(1)

    if meta:
        console.print(f"[bold]Bundle: {name}[/bold]")
        console.print()
        console.print(f"[dim]Title:[/dim] {bundle.metadata.title}")
        console.print(f"[dim]Created:[/dim] {bundle.metadata.created.isoformat()}")
        console.print(f"[dim]Updated:[/dim] {bundle.metadata.updated.isoformat()}")
        console.print(f"[dim]TTL:[/dim] {bundle.metadata.ttl_hours}h")
        console.print(f"[dim]Tags:[/dim] {', '.join(bundle.metadata.tags) or 'none'}")
        console.print()
        console.print("[bold]Sources:[/bold]")
        for i, source in enumerate(bundle.metadata.sources, 1):
            source_type = source.type.value
            if source_type == "file":
                console.print(f"  {i}. [cyan]file[/cyan] {source.path}")
            elif source_type == "glob":
                console.print(f"  {i}. [cyan]glob[/cyan] {source.pattern}")
            elif source_type == "grep":
                console.print(f"  {i}. [cyan]grep[/cyan] {source.pattern}")
            elif source_type == "semantic":
                console.print(f"  {i}. [cyan]semantic[/cyan] \"{source.query}\"")
            elif source_type == "db_schema":
                console.print(f"  {i}. [cyan]db_schema[/cyan] {', '.join(source.tables)}")
    else:
        # Print raw content (suitable for piping)
        print(bundle.content)


@context.command("refresh")
@click.argument("name", required=False)
@click.option(
    "--all", "refresh_all",
    is_flag=True,
    help="Refresh all stale bundles"
)
@click.option(
    "--force", "-f",
    is_flag=True,
    help="Force refresh even if unchanged"
)
def context_refresh(name: Optional[str], refresh_all: bool, force: bool):
    """Refresh context bundles.

    NAME is the bundle identifier. Use --all to refresh all stale bundles.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()

    if not name and not refresh_all:
        console.print("[red]Error: Specify a bundle name or use --all[/red]")
        sys.exit(1)

    async def do_refresh():
        service = ContextBundleService(working_dir)

        if refresh_all:
            results = await service.refresh_stale()
            return results
        else:
            result = await service.refresh(name, force=force)
            return [result]

    try:
        with console.status("[bold green]Refreshing..."):
            results = asyncio.run(do_refresh())

        if not results:
            console.print("[dim]No bundles to refresh.[/dim]")
            return

        for result in results:
            if result.success:
                if result.changed:
                    console.print(
                        f"[green]Refreshed:[/green] {result.bundle_id} "
                        f"({result.sources_changed}/{result.sources_evaluated} sources changed)"
                    )
                else:
                    console.print(
                        f"[dim]Unchanged:[/dim] {result.bundle_id}"
                    )
            else:
                console.print(
                    f"[red]Failed:[/red] {result.bundle_id} - {result.error}"
                )

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@context.command("add")
@click.argument("name")
@click.option(
    "--file", "-f",
    help="Add a file source"
)
@click.option(
    "--glob", "-g",
    help="Add a glob pattern source"
)
@click.option(
    "--grep", "-r",
    help="Add a grep pattern source"
)
@click.option(
    "--semantic", "-s",
    help="Add a semantic search query"
)
@click.option(
    "--db-schema", "-d",
    help="Add database tables (comma-separated)"
)
def context_add(
    name: str,
    file: Optional[str],
    glob: Optional[str],
    grep: Optional[str],
    semantic: Optional[str],
    db_schema: Optional[str],
):
    """Add a source to an existing bundle.

    NAME is the bundle identifier.

    Adds the source and refreshes the bundle.

    Examples:

        hester context add auth-system --file services/api/src/middleware.py

        hester context add matching-algo --grep "embedding"
    """
    from hester.context import (
        FileSource,
        GlobSource,
        GrepSource,
        SemanticSource,
        DbSchemaSource,
    )
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()

    # Build source
    source = None
    if file:
        source = FileSource(path=file)
    elif glob:
        source = GlobSource(pattern=glob)
    elif grep:
        source = GrepSource(pattern=grep)
    elif semantic:
        source = SemanticSource(query=semantic)
    elif db_schema:
        tables = [t.strip() for t in db_schema.split(",")]
        source = DbSchemaSource(tables=tables)
    else:
        console.print("[red]Error: Specify a source with --file, --glob, --grep, --semantic, or --db-schema[/red]")
        sys.exit(1)

    async def add_source():
        service = ContextBundleService(working_dir)
        bundle = await service.add_source(name, source)
        return bundle

    try:
        with console.status("[bold green]Adding source and refreshing..."):
            bundle = asyncio.run(add_source())

        if bundle:
            console.print(f"[green]Added source to:[/green] {name}")
            console.print(f"[dim]Total sources: {len(bundle.metadata.sources)}[/dim]")
        else:
            console.print(f"[red]Bundle not found: {name}[/red]")
            sys.exit(1)

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@context.command("copy")
@click.argument("name")
def context_copy(name: str):
    """Copy bundle content to clipboard.

    NAME is the bundle identifier.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    service = ContextBundleService(working_dir)

    if service.copy_to_clipboard(name):
        console.print(f"[green]Copied to clipboard:[/green] {name}")
    else:
        bundle = service.get(name)
        if not bundle:
            console.print(f"[red]Bundle not found: {name}[/red]")
        else:
            console.print("[red]Failed to copy to clipboard[/red]")
            console.print("[dim]Install pyperclip or ensure pbcopy is available[/dim]")
        sys.exit(1)


@context.command("delete")
@click.argument("name")
@click.option(
    "--yes", "-y",
    is_flag=True,
    help="Skip confirmation"
)
def context_delete(name: str, yes: bool):
    """Delete a context bundle.

    NAME is the bundle identifier.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    service = ContextBundleService(working_dir)

    bundle = service.get(name)
    if not bundle:
        console.print(f"[red]Bundle not found: {name}[/red]")
        sys.exit(1)

    if not yes:
        if not click.confirm(f"Delete bundle '{name}'?"):
            console.print("[dim]Cancelled.[/dim]")
            return

    if service.delete(name):
        console.print(f"[green]Deleted:[/green] {name}")
    else:
        console.print(f"[red]Failed to delete: {name}[/red]")
        sys.exit(1)


@context.command("prune")
@click.option(
    "--older-than",
    default=168,
    type=int,
    help="Delete bundles older than N hours (default: 168 = 1 week)"
)
@click.option(
    "--yes", "-y",
    is_flag=True,
    help="Skip confirmation"
)
def context_prune(older_than: int, yes: bool):
    """Delete old bundles.

    Removes bundles not updated in the specified time period.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    service = ContextBundleService(working_dir)

    # Find candidates
    statuses = service.list_all()
    candidates = [s for s in statuses if s.age_hours > older_than]

    if not candidates:
        console.print("[dim]No bundles older than specified threshold.[/dim]")
        return

    console.print(f"[bold]Bundles to prune ({len(candidates)}):[/bold]")
    for status in candidates:
        age_days = int(status.age_hours / 24)
        console.print(f"  {status.id} - {age_days}d old")

    if not yes:
        if not click.confirm(f"Delete {len(candidates)} bundles?"):
            console.print("[dim]Cancelled.[/dim]")
            return

    deleted = service.prune(older_than_hours=older_than)
    console.print(f"[green]Deleted {len(deleted)} bundles[/green]")


@context.command("status")
def context_status():
    """Show summary of context bundles.

    Shows counts of bundles by status.
    """
    from hester.context.service import ContextBundleService

    working_dir = os.getcwd()
    service = ContextBundleService(working_dir)

    statuses = service.list_all()

    if not statuses:
        console.print("[dim]No bundles found.[/dim]")
        return

    ok_count = sum(1 for s in statuses if not s.is_stale)
    stale_count = sum(1 for s in statuses if s.is_stale)
    total_sources = sum(s.source_count for s in statuses)

    console.print("[bold]Context Bundles Status[/bold]")
    console.print()
    console.print(f"  Total bundles: {len(statuses)}")
    console.print(f"  [green]OK:[/green] {ok_count}")
    console.print(f"  [red]Stale:[/red] {stale_count}")
    console.print(f"  Total sources: {total_sources}")

    if stale_count > 0:
        console.print()
        console.print("[dim]Run 'hester context refresh --all' to refresh stale bundles.[/dim]")
