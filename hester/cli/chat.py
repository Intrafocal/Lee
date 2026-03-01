"""
Hester CLI - Interactive chat command.

Usage:
    hester chat
    hester chat --dir /path/to/project
    hester chat --daemon-url http://localhost:9000
"""

import asyncio
import os
import sys
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.command("chat")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory (default: current directory)"
)
@click.option(
    "--tasks-dir",
    default=None,
    help="Directory for task files (default: .hester/tasks/ in working dir)"
)
@click.option(
    "--daemon-url",
    default=None,
    help="URL of running daemon (default: direct mode without HTTP)"
)
@click.option(
    "--session", "-s",
    "session_id",
    default=None,
    help="Resume an existing session by ID (e.g., from Command Palette)"
)
def chat(working_dir: Optional[str], tasks_dir: Optional[str], daemon_url: Optional[str], session_id: Optional[str]):
    """Start an interactive chat session with Hester.

    This provides a Claude Code-style TUI for chatting with Hester about
    your codebase. Hester can read files, search code, and answer questions.

    In direct mode (default), Hester runs locally without needing the daemon
    server. Use --daemon-url to connect to a running daemon instead.

    Examples:
        hester chat
        hester chat --dir /path/to/project
        hester chat --daemon-url http://localhost:9000
    """
    # Check for required API key in direct mode
    if not daemon_url:
        api_key = os.environ.get("GOOGLE_API_KEY")
        # Debug: print first few chars if present
        if api_key:
            console.print(f"[dim]API key found: {api_key[:10]}...[/dim]")
        if not api_key:
            console.print("[red]Error: GOOGLE_API_KEY environment variable is required.[/red]")
            console.print()
            console.print("[dim]Set it with:[/dim]")
            console.print("  export GOOGLE_API_KEY=your_key")
            console.print()
            console.print("[dim]Or add to .env.local and source it:[/dim]")
            console.print("  source .env.local")
            sys.exit(1)

    from hester.daemon.tui import run_chat_tui

    working_dir = working_dir or os.getcwd()

    # Set tasks dir from env or option
    if not tasks_dir:
        tasks_dir = os.environ.get("HESTER_TASKS_DIR")

    console.print(f"[bold green]Hester Chat[/bold green]")
    console.print(f"[dim]Working directory: {working_dir}[/dim]")
    if tasks_dir:
        console.print(f"[dim]Tasks directory: {tasks_dir}[/dim]")
    if daemon_url:
        console.print(f"[dim]Daemon URL: {daemon_url}[/dim]")
    else:
        console.print(f"[dim]Mode: Direct (no daemon server)[/dim]")
    if session_id:
        console.print(f"[dim]Resuming session: {session_id}[/dim]")
    console.print()

    try:
        asyncio.run(run_chat_tui(
            working_directory=working_dir,
            tasks_dir=tasks_dir,
            daemon_url=daemon_url,
            session_id=session_id,
        ))
    except KeyboardInterrupt:
        console.print("\n[dim]Chat ended.[/dim]")
    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        sys.exit(1)
