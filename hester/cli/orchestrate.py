"""
Orchestration telemetry CLI commands for Workstream Architecture.

Provides commands for agents (Hester, Claude Code) to send telemetry data
to the Hester daemon for real-time status updates and orchestration.
"""

import asyncio
import sys
from typing import Optional

import click
from rich.console import Console

from ..daemon.tools.orchestrate_tools import send_telemetry

console = Console()


@click.group()
def orchestrate():
    """Send orchestration telemetry to Hester daemon.

    Used by agents (Claude Code, Hester) to report status updates
    for real-time workstream orchestration and visibility.
    """
    pass


@orchestrate.command("register")
@click.argument("session_id", required=True)
@click.argument("agent_type", type=click.Choice(["claude_code", "hester", "custom"]), required=True)
@click.option("--focus", "-f", help="Current agent focus/task description")
@click.option("--active-file", "-a", help="Currently active file path")
@click.option("--workstream-id", "-w", help="Associated workstream ID")
@click.option("--metadata", "-m", help="Additional metadata as JSON string")
def register_agent(
    session_id: str,
    agent_type: str,
    focus: Optional[str] = None,
    active_file: Optional[str] = None,
    workstream_id: Optional[str] = None,
    metadata: Optional[str] = None
):
    """Register an agent session with the orchestration system.

    SESSION_ID: Unique identifier for this agent session
    AGENT_TYPE: Type of agent (claude_code, hester, custom)

    Examples:
        hester orchestrate register cc-session-123 claude_code --focus "Implementing auth system"
        hester orchestrate register hester-001 hester --workstream-id ws-auth-migration
    """
    try:
        # Parse metadata if provided
        metadata_dict = None
        if metadata:
            import json
            try:
                metadata_dict = json.loads(metadata)
            except json.JSONDecodeError:
                console.print(f"[red]Error: Invalid JSON in metadata: {metadata}[/red]")
                sys.exit(1)

        result = asyncio.run(send_telemetry(
            action="register",
            session_id=session_id,
            agent_type=agent_type,
            status="starting",
            focus=focus,
            active_file=active_file,
            workstream_id=workstream_id,
            metadata=metadata_dict
        ))

        if result.get("success"):
            console.print(f"[green]✓[/green] Registered agent session: [bold]{session_id}[/bold]")
            if focus:
                console.print(f"  Focus: [dim]{focus}[/dim]")
        else:
            console.print(f"[red]✗ Failed to register: {result.get('error', 'Unknown error')}[/red]")
            sys.exit(1)

    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/dim]")
        sys.exit(130)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@orchestrate.command("update")
@click.argument("session_id", required=True)
@click.option("--status", "-s", type=click.Choice(["active", "idle", "working", "blocked", "error"]), help="Agent status")
@click.option("--focus", "-f", help="Current agent focus/task description")
@click.option("--active-file", "-a", help="Currently active file path")
@click.option("--tool", "-t", help="Currently active tool name")
@click.option("--progress", "-p", type=int, help="Progress percentage (0-100)")
@click.option("--workstream-id", "-w", help="Associated workstream ID")
@click.option("--metadata", "-m", help="Additional metadata as JSON string")
def update_agent(
    session_id: str,
    status: Optional[str] = None,
    focus: Optional[str] = None,
    active_file: Optional[str] = None,
    tool: Optional[str] = None,
    progress: Optional[int] = None,
    workstream_id: Optional[str] = None,
    metadata: Optional[str] = None
):
    """Update agent session status and telemetry.

    SESSION_ID: Agent session identifier (from register command)

    Examples:
        hester orchestrate update cc-session-123 --status working --focus "Reading auth.py"
        hester orchestrate update cc-session-123 --tool read_file --active-file src/auth.py
        hester orchestrate update hester-001 --status blocked --focus "Waiting for user input"
    """
    try:
        # Validate progress range
        if progress is not None and (progress < 0 or progress > 100):
            console.print("[red]Error: Progress must be between 0 and 100[/red]")
            sys.exit(1)

        # Parse metadata if provided
        metadata_dict = None
        if metadata:
            import json
            try:
                metadata_dict = json.loads(metadata)
            except json.JSONDecodeError:
                console.print(f"[red]Error: Invalid JSON in metadata: {metadata}[/red]")
                sys.exit(1)

        result = asyncio.run(send_telemetry(
            action="update",
            session_id=session_id,
            status=status,
            focus=focus,
            active_file=active_file,
            tool=tool,
            progress=progress,
            workstream_id=workstream_id,
            metadata=metadata_dict
        ))

        if result.get("success"):
            console.print(f"[green]✓[/green] Updated agent session: [bold]{session_id}[/bold]")
            if status:
                console.print(f"  Status: [cyan]{status}[/cyan]")
            if focus:
                console.print(f"  Focus: [dim]{focus}[/dim]")
        else:
            console.print(f"[red]✗ Failed to update: {result.get('error', 'Unknown error')}[/red]")
            sys.exit(1)

    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/dim]")
        sys.exit(130)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@orchestrate.command("complete")
@click.argument("session_id", required=True)
@click.option("--status", "-s", type=click.Choice(["completed", "failed", "cancelled"]), default="completed", help="Final status")
@click.option("--result", "-r", help="Final result or error message")
@click.option("--workstream-id", "-w", help="Associated workstream ID")
@click.option("--metadata", "-m", help="Additional metadata as JSON string")
def complete_agent(
    session_id: str,
    status: str = "completed",
    result: Optional[str] = None,
    workstream_id: Optional[str] = None,
    metadata: Optional[str] = None
):
    """Complete an agent session and unregister.

    SESSION_ID: Agent session identifier (from register command)

    Examples:
        hester orchestrate complete cc-session-123 --status completed --result "Auth system implemented"
        hester orchestrate complete cc-session-123 --status failed --result "TypeScript errors in auth.ts"
        hester orchestrate complete hester-001 --status cancelled
    """
    try:
        # Parse metadata if provided
        metadata_dict = None
        if metadata:
            import json
            try:
                metadata_dict = json.loads(metadata)
            except json.JSONDecodeError:
                console.print(f"[red]Error: Invalid JSON in metadata: {metadata}[/red]")
                sys.exit(1)

        result_data = asyncio.run(send_telemetry(
            action="complete",
            session_id=session_id,
            status=status,
            result=result,
            workstream_id=workstream_id,
            metadata=metadata_dict
        ))

        if result_data.get("success"):
            console.print(f"[green]✓[/green] Completed agent session: [bold]{session_id}[/bold]")
            console.print(f"  Final status: [cyan]{status}[/cyan]")
            if result:
                console.print(f"  Result: [dim]{result}[/dim]")
        else:
            console.print(f"[red]✗ Failed to complete: {result_data.get('error', 'Unknown error')}[/red]")
            sys.exit(1)

    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/dim]")
        sys.exit(130)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


# Additional utility commands

@orchestrate.command("status")
@click.argument("session_id", required=True)
def get_status(session_id: str):
    """Get current status of an agent session.

    SESSION_ID: Agent session identifier

    Examples:
        hester orchestrate status cc-session-123
    """
    try:
        from ..daemon.tools.orchestrate_tools import get_agent_status

        result = asyncio.run(get_agent_status(session_id))

        if result.get("success"):
            agent_data = result.get("data", {})
            console.print(f"[bold]Agent Session:[/bold] {session_id}")
            console.print(f"  Type: [cyan]{agent_data.get('agent_type', 'unknown')}[/cyan]")
            console.print(f"  Status: [cyan]{agent_data.get('status', 'unknown')}[/cyan]")

            if agent_data.get('focus'):
                console.print(f"  Focus: [dim]{agent_data.get('focus')}[/dim]")
            if agent_data.get('active_file'):
                console.print(f"  Active file: [dim]{agent_data.get('active_file')}[/dim]")
            if agent_data.get('tool'):
                console.print(f"  Current tool: [dim]{agent_data.get('tool')}[/dim]")
            if agent_data.get('workstream_id'):
                console.print(f"  Workstream: [dim]{agent_data.get('workstream_id')}[/dim]")

            progress = agent_data.get('progress')
            if progress is not None:
                console.print(f"  Progress: [cyan]{progress}%[/cyan]")

            console.print(f"  Last updated: [dim]{agent_data.get('last_updated', 'unknown')}[/dim]")
        else:
            console.print(f"[red]✗ Session not found or error: {result.get('error', 'Unknown error')}[/red]")
            sys.exit(1)

    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/dim]")
        sys.exit(130)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@orchestrate.command("list")
@click.option("--workstream-id", "-w", help="Filter by workstream ID")
@click.option("--agent-type", "-t", type=click.Choice(["claude_code", "hester", "custom"]), help="Filter by agent type")
def list_sessions(workstream_id: Optional[str] = None, agent_type: Optional[str] = None):
    """List active agent sessions.

    Examples:
        hester orchestrate list
        hester orchestrate list --workstream-id ws-auth-migration
        hester orchestrate list --agent-type claude_code
    """
    try:
        from ..daemon.tools.orchestrate_tools import list_agent_sessions

        result = asyncio.run(list_agent_sessions(
            workstream_id=workstream_id,
            agent_type=agent_type
        ))

        if result.get("success"):
            sessions = result.get("data", [])
            if not sessions:
                console.print("[dim]No active agent sessions found.[/dim]")
                return

            console.print(f"[bold]Active Agent Sessions ({len(sessions)}):[/bold]\n")

            for session in sessions:
                console.print(f"[bold]{session['session_id']}[/bold]")
                console.print(f"  Type: [cyan]{session.get('agent_type', 'unknown')}[/cyan]")
                console.print(f"  Status: [cyan]{session.get('status', 'unknown')}[/cyan]")

                if session.get('focus'):
                    console.print(f"  Focus: [dim]{session.get('focus')}[/dim]")
                if session.get('workstream_id'):
                    console.print(f"  Workstream: [dim]{session.get('workstream_id')}[/dim]")
                if session.get('active_file'):
                    console.print(f"  File: [dim]{session.get('active_file')}[/dim]")

                console.print(f"  Updated: [dim]{session.get('last_updated', 'unknown')}[/dim]")
                console.print()  # Empty line between sessions
        else:
            console.print(f"[red]✗ Failed to list sessions: {result.get('error', 'Unknown error')}[/red]")
            sys.exit(1)

    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/dim]")
        sys.exit(130)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)