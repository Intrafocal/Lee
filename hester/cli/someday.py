"""
Hester CLI - Someday: the single idea-capture store.

Writes ``<workspace>/.hester/someday/`` directly; no daemon needed.

Usage:
    hester someday capture "We should add dark mode"
    hester someday capture "Try a CRDT for the queue" --explore
    hester someday list [--all]
"""

import sys
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

console = Console()


def _workspace(directory: str) -> Path:
    return Path(directory).expanduser().resolve()


@click.group()
def someday():
    """Capture ideas for later (Someday store)."""
    pass


@someday.command("capture")
@click.argument("text", nargs=-1, required=True)
@click.option("--dir", "-d", "directory", default=".", type=click.Path(file_okay=False), help="Workspace directory")
@click.option("--explore", is_flag=True, help="Mark it as the seed of an exploration")
def someday_capture(text: tuple, directory: str, explore: bool):
    """Capture an idea into the Someday store."""
    from hester.daemon.copilot.someday import SomedayError, SomedayStore

    try:
        item = SomedayStore(_workspace(directory)).create(
            " ".join(text),
            as_="explore" if explore else "someday",
            source={"surface": "cli"},
        )
    except SomedayError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
    console.print(f"[green]Captured[/green] {item.id}")


@someday.command("list")
@click.option("--dir", "-d", "directory", default=".", type=click.Path(file_okay=False), help="Workspace directory")
@click.option("--all", "show_all", is_flag=True, help="Include triaged items")
def someday_list(directory: str, show_all: bool):
    """List Someday items, newest first."""
    from hester.daemon.copilot.someday import SomedayStore

    items = SomedayStore(_workspace(directory)).list("all" if show_all else "open")
    if not items:
        console.print("[dim]Nothing in Someday.[/dim]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("ID", style="dim", no_wrap=True)
    table.add_column("Captured", no_wrap=True)
    table.add_column("Status")
    table.add_column("As")
    table.add_column("From")
    table.add_column("Idea")
    for item in items:
        first = item.text.strip().splitlines()[0] if item.text.strip() else ""
        table.add_row(
            item.id, item.created_at, item.status, item.as_,
            item.source.get("surface", ""), first[:80],
        )
    console.print(table)
