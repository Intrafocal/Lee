"""
Hester CLI - Daemon server commands.

Usage:
    hester daemon start
    hester daemon stop
    hester daemon status
"""

import os
import sys
from pathlib import Path

import click
from rich.console import Console

console = Console()


@click.group()
def daemon():
    """Hester daemon server commands (start, stop, status)."""
    pass


@daemon.command("start")
@click.option(
    "--port", "-p",
    default=9000,
    help="Port to run the daemon on (default: 9000)"
)
@click.option(
    "--host", "-h",
    default="127.0.0.1",
    help="Host to bind to (default: 127.0.0.1)"
)
@click.option(
    "--background", "-b",
    is_flag=True,
    help="Run in background (daemonize)"
)
@click.option(
    "--reload",
    is_flag=True,
    help="Enable auto-reload for development"
)
def daemon_start(port: int, host: str, background: bool, reload: bool):
    """Start the Hester daemon service.

    The daemon provides AI-powered code exploration for the Lee editor.
    It runs a ReAct loop with Gemini 3 Pro for intelligent responses.

    Examples:
        hester daemon start
        hester daemon start --port 9000 --reload
        hester daemon start --background
    """
    import subprocess

    console.print(f"[bold cyan]Starting Hester daemon...[/bold cyan]")
    console.print(f"[dim]Port: {port}[/dim]")
    console.print(f"[dim]Host: {host}[/dim]")
    console.print()

    # Set environment for port/host
    os.environ["HESTER_PORT"] = str(port)
    os.environ["HESTER_HOST"] = host

    if background:
        # Run in background using subprocess
        console.print("[yellow]Running in background mode...[/yellow]")

        cmd = [
            sys.executable, "-m", "uvicorn",
            "hester.daemon.main:app",
            "--host", host,
            "--port", str(port),
        ]
        if reload:
            cmd.append("--reload")

        # Start detached process
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        # Save PID for later
        pid_file = Path.home() / ".hester" / "daemon.pid"
        pid_file.parent.mkdir(parents=True, exist_ok=True)
        pid_file.write_text(str(process.pid))

        console.print(f"[green]Daemon started with PID: {process.pid}[/green]")
        console.print(f"[dim]PID file: {pid_file}[/dim]")
        console.print()
        console.print(f"[bold]Daemon running at:[/bold] http://{host}:{port}")
        console.print("[dim]Use 'hester daemon stop' to stop the daemon[/dim]")

    else:
        # Run in foreground
        console.print("[cyan]Running in foreground (Ctrl+C to stop)...[/cyan]")
        console.print()

        import uvicorn

        try:
            uvicorn.run(
                "hester.daemon.main:app",
                host=host,
                port=port,
                reload=reload,
                log_level="info",
            )
        except KeyboardInterrupt:
            console.print("\n[yellow]Daemon stopped.[/yellow]")


@daemon.command("stop")
def daemon_stop():
    """Stop the Hester daemon service.

    Stops a daemon running in the background.
    """
    import signal

    pid_file = Path.home() / ".hester" / "daemon.pid"

    if not pid_file.exists():
        console.print("[yellow]No daemon PID file found.[/yellow]")
        console.print("[dim]The daemon may not be running in background mode.[/dim]")
        return

    try:
        pid = int(pid_file.read_text().strip())
        console.print(f"[cyan]Stopping daemon (PID: {pid})...[/cyan]")

        # Send SIGTERM
        os.kill(pid, signal.SIGTERM)

        # Clean up PID file
        pid_file.unlink()

        console.print("[green]Daemon stopped.[/green]")

    except ProcessLookupError:
        console.print("[yellow]Daemon process not found (already stopped?).[/yellow]")
        pid_file.unlink()
    except PermissionError:
        console.print("[red]Permission denied. Cannot stop daemon.[/red]")
    except Exception as e:
        console.print(f"[red]Error stopping daemon: {e}[/red]")


@daemon.command("status")
def daemon_status():
    """Check the status of the Hester daemon.

    Shows whether the daemon is running and connection details.
    """
    import httpx

    pid_file = Path.home() / ".hester" / "daemon.pid"

    # Check for PID file (background mode)
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            # Check if process is running
            os.kill(pid, 0)  # Signal 0 = check if alive
            console.print(f"[green]Background daemon running (PID: {pid})[/green]")
        except ProcessLookupError:
            console.print("[yellow]Background daemon not running (stale PID file)[/yellow]")
            pid_file.unlink()
            return
        except ValueError:
            console.print("[yellow]Invalid PID file[/yellow]")
            return
    else:
        console.print("[dim]No background daemon PID file found[/dim]")

    # Try to connect to daemon
    port = int(os.environ.get("HESTER_PORT", 9000))
    host = os.environ.get("HESTER_HOST", "127.0.0.1")
    url = f"http://{host}:{port}/health"

    console.print(f"\n[cyan]Checking daemon at {url}...[/cyan]")

    try:
        response = httpx.get(url, timeout=5.0)
        if response.status_code == 200:
            health = response.json()
            console.print(f"[green]Daemon is healthy![/green]")
            console.print(f"[dim]Status: {health.get('status')}[/dim]")
            console.print(f"[dim]Port: {health.get('port')}[/dim]")

            components = health.get("components", {})
            if "redis" in components:
                console.print(f"[dim]Redis: {components['redis']}[/dim]")
            if "agent" in components:
                agent_health = components["agent"]
                console.print(f"[dim]Agent: {agent_health.get('status')}[/dim]")
                console.print(f"[dim]Model: {agent_health.get('model')}[/dim]")
                console.print(f"[dim]Tools: {agent_health.get('tools_registered')}[/dim]")
        else:
            console.print(f"[yellow]Daemon responded with status: {response.status_code}[/yellow]")

    except httpx.ConnectError:
        console.print("[red]Cannot connect to daemon (not running?)[/red]")
    except httpx.TimeoutException:
        console.print("[red]Daemon connection timed out[/red]")
    except Exception as e:
        console.print(f"[red]Error checking daemon: {e}[/red]")


@daemon.command("logs")
@click.option("--follow", "-f", is_flag=True, help="Follow log output")
@click.option("--lines", "-n", default=50, help="Number of lines to show")
def daemon_logs(follow: bool, lines: int):
    """View daemon logs.

    Shows logs from the daemon if running in background mode.
    """
    console.print("[yellow]Log viewing not yet implemented.[/yellow]")
    console.print("[dim]Use 'hester daemon start' (foreground) to see live logs.[/dim]")
