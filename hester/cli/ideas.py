"""
Hester CLI - Idea capture commands.

Usage:
    hester ideas capture "We should add dark mode"
    hester ideas list
    hester ideas search "authentication"
"""

import asyncio
import sys
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.group()
def ideas():
    """Idea capture commands (HesterIdeas)."""
    pass


@ideas.command("capture")
@click.argument("text", nargs=-1, required=True)
@click.option(
    "--tags", "-t",
    multiple=True,
    help="Add tags to the idea"
)
def ideas_capture(text: tuple, tags: tuple):
    """Capture a new idea from text.

    Examples:
        hester ideas capture "We should add dark mode to the app"
        hester ideas capture "API rate limiting" -t feature -t api
    """
    from hester.ideas import IdeasAgent
    from hester.ideas.models import IdeaInput, IdeaSource

    idea_text = " ".join(text)

    if not idea_text:
        console.print("[red]Error: Please provide idea text[/red]")
        sys.exit(1)

    console.print("[cyan]Capturing idea...[/cyan]")

    try:
        agent = IdeasAgent()
        idea_input = IdeaInput(
            content=idea_text,
            source=IdeaSource.CLI,
            user_id="cli_user",
            tags=list(tags) if tags else None,
        )

        result = asyncio.run(agent.process(idea_input))

        console.print()
        console.print("[green]Idea captured![/green]")
        console.print(f"[bold]{result.title}[/bold]")
        console.print(f"[dim]{result.summary}[/dim]")
        if result.tags:
            console.print(f"Tags: {', '.join(result.tags)}")
        console.print(f"[dim]ID: {result.idea_id}[/dim]")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@ideas.command("list")
@click.option(
    "--status", "-s",
    type=click.Choice(["captured", "reviewed", "archived", "promoted"]),
    default=None,
    help="Filter by status"
)
@click.option(
    "--limit", "-l",
    default=10,
    help="Maximum ideas to show (default: 10)"
)
@click.option(
    "--tag", "-t",
    default=None,
    help="Filter by tag"
)
@click.option(
    "--json", "output_json",
    is_flag=True,
    help="Output as JSON (for programmatic use)"
)
def ideas_list(status: Optional[str], limit: int, tag: Optional[str], output_json: bool):
    """List captured ideas.

    Examples:
        hester ideas list
        hester ideas list --status captured
        hester ideas list --tag feature --limit 20
        hester ideas list --status captured --json
    """
    import json as json_module
    from hester.ideas import IdeasAgent

    try:
        agent = IdeasAgent()
        ideas_result = asyncio.run(agent.list_ideas(
            status=status,
            tag=tag,
            limit=limit,
        ))

        # JSON output for programmatic use (e.g., ProactiveWatcher)
        if output_json:
            output = []
            for idea in ideas_result:
                output.append({
                    "id": str(idea.id),
                    "title": idea.title,
                    "content": idea.content[:200] if idea.content else "",
                    "status": idea.status.value if hasattr(idea.status, 'value') else str(idea.status),
                    "tags": idea.tags or [],
                    "related_entities": idea.related_entities or {},
                    "source_type": idea.source_type.value if hasattr(idea.source_type, 'value') else str(idea.source_type),
                    "created_at": idea.created_at.isoformat() if idea.created_at else None,
                })
            click.echo(json_module.dumps(output))
            return

        # Human-readable output
        console.print("[bold]Ideas[/bold]")
        console.print()

        if not ideas_result:
            console.print("[yellow]No ideas found.[/yellow]")
            return

        for idea in ideas_result:
            status_color = {
                "captured": "cyan",
                "reviewed": "green",
                "archived": "dim",
                "promoted": "magenta",
            }.get(str(idea.status), "white")

            console.print(f"[bold]{idea.title}[/bold]")
            console.print(f"  [{status_color}]{idea.status}[/{status_color}] | {idea.created_at.strftime('%Y-%m-%d')}")
            if idea.tags:
                console.print(f"  [dim]Tags: {', '.join(idea.tags)}[/dim]")
            console.print()

        console.print(f"[dim]Showing {len(ideas_result)} ideas[/dim]")

    except Exception as e:
        if output_json:
            # Output error as JSON for programmatic consumers
            click.echo(json_module.dumps({"error": str(e)}))
            sys.exit(1)
        console.print(f"[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@ideas.command("search")
@click.argument("query")
@click.option(
    "--limit", "-l",
    default=10,
    help="Maximum results (default: 10)"
)
def ideas_search(query: str, limit: int):
    """Search ideas by text.

    Examples:
        hester ideas search "authentication"
        hester ideas search "API" --limit 20
    """
    from hester.ideas import IdeasAgent

    console.print(f"[cyan]Searching for: {query}[/cyan]")
    console.print()

    try:
        agent = IdeasAgent()
        results = asyncio.run(agent.search(query=query, limit=limit))

        if not results:
            console.print("[yellow]No matching ideas found.[/yellow]")
            return

        for idea in results:
            console.print(f"[bold]{idea.title}[/bold]")
            console.print(f"  [dim]{idea.summary[:100]}...[/dim]" if len(idea.summary) > 100 else f"  [dim]{idea.summary}[/dim]")
            if idea.tags:
                console.print(f"  Tags: {', '.join(idea.tags)}")
            console.print()

        console.print(f"[dim]Found {len(results)} results[/dim]")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
