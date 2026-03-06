"""
Hester CLI - Service management commands (HesterDevOps).

Usage:
    hester devops tui
    hester devops status
    hester devops start api
    hester devops docker
"""

import asyncio
import os
import sys
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.group()
def devops():
    """Service management commands (HesterDevOps)."""
    pass


@devops.command("tui")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml (default: current directory)"
)
def devops_tui(working_dir: Optional[str]):
    """Launch the DevOps TUI dashboard.

    Provides a terminal-based dashboard for managing local development
    services defined in .lee/config.yaml. Features:
    - Real-time service status monitoring
    - Start/stop services with keyboard shortcuts
    - Live log streaming
    - Health checks

    Examples:
        hester devops tui
        hester devops tui --dir /path/to/project
    """
    from hester.devops import run_devops_tui

    working_dir = working_dir or os.getcwd()

    console.print("[bold cyan]Hester DevOps[/bold cyan]")
    console.print(f"[dim]Working directory: {working_dir}[/dim]")
    console.print()

    try:
        asyncio.run(run_devops_tui(working_dir))
    except KeyboardInterrupt:
        console.print("\n[dim]DevOps TUI closed.[/dim]")
    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@devops.command("status")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
@click.option(
    "--env", "-e",
    "environment",
    default=None,
    help="Filter by environment name"
)
def devops_status(working_dir: Optional[str], environment: Optional[str]):
    """Show status of all configured services.

    Lists all services from .lee/config.yaml with their current state.

    Examples:
        hester devops status
        hester devops status --env local
    """
    from hester.devops import ServiceManager

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    console.print("[bold]Service Status[/bold]")
    console.print(f"[dim]Working directory: {working_dir}[/dim]")
    console.print()

    services = manager.get_all_services()

    if not services:
        console.print("[yellow]No services configured.[/yellow]")
        console.print("[dim]Add services to .lee/config.yaml[/dim]")
        return

    # Show all services with their status
    for service, running in services:
        if running and running.process.poll() is None:
            status = "[green]RUNNING[/green]"
            pid_info = f"[dim](PID: {running.pid})[/dim]"
            action_info = f"[dim]({running.environment})[/dim] " if running.environment else ""
        else:
            status = "[dim]STOPPED[/dim]"
            pid_info = ""
            action_info = ""

        ports_info = f"[dim]:{','.join(str(p) for p in service.ports)}[/dim]" if service.ports else ""
        console.print(f"  {service.name}{ports_info} {action_info}{status} {pid_info}")


@devops.command("start")
@click.argument("service_name")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
@click.option(
    "--env", "-e",
    "environment",
    default=None,
    help="Environment name (if service exists in multiple)"
)
def devops_start(service_name: str, working_dir: Optional[str], environment: Optional[str]):
    """Start a service.

    Examples:
        hester devops start api
        hester devops start frontend --env local
    """
    from hester.devops import ServiceManager

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    console.print(f"[cyan]Starting {service_name}...[/cyan]")

    success, message = asyncio.run(manager.start_service(service_name, environment=environment))

    if success:
        console.print(f"[green]{message}[/green]")
    else:
        console.print(f"[red]{message}[/red]")
        sys.exit(1)


@devops.command("stop")
@click.argument("service_name")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
@click.option(
    "--env", "-e",
    "environment",
    default=None,
    help="Environment name (if service exists in multiple)"
)
def devops_stop(service_name: str, working_dir: Optional[str], environment: Optional[str]):
    """Stop a running service.

    Examples:
        hester devops stop api
        hester devops stop frontend --env local
    """
    from hester.devops import ServiceManager

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    console.print(f"[cyan]Stopping {service_name}...[/cyan]")

    success, message = asyncio.run(manager.stop_service(service_name, environment=environment))

    if success:
        console.print(f"[green]{message}[/green]")
    else:
        console.print(f"[red]{message}[/red]")
        sys.exit(1)


@devops.command("logs")
@click.argument("service_name")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
@click.option(
    "--env", "-e",
    "environment",
    default=None,
    help="Environment name"
)
@click.option(
    "--lines", "-n",
    default=50,
    help="Number of lines to show (default: 50)"
)
@click.option(
    "--follow", "-f",
    is_flag=True,
    help="Follow log output"
)
def devops_logs(
    service_name: str,
    working_dir: Optional[str],
    environment: Optional[str],
    lines: int,
    follow: bool,
):
    """View logs from a running service.

    Examples:
        hester devops logs api
        hester devops logs frontend --lines 100
        hester devops logs api --follow
    """
    from hester.devops import ServiceManager
    import time

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    log_lines = manager.get_logs(service_name, environment, lines)

    if log_lines is None:
        console.print(f"[yellow]Service '{service_name}' is not running.[/yellow]")
        sys.exit(1)

    console.print(f"[bold]Logs: {service_name}[/bold]")
    console.print()

    for line in log_lines:
        console.print(f"[dim]{line}[/dim]")

    if follow:
        console.print()
        console.print("[dim]Following logs... (Ctrl+C to stop)[/dim]")

        last_count = len(log_lines)
        try:
            while True:
                time.sleep(0.5)
                new_logs = manager.get_logs(service_name, environment, 500)
                if new_logs is None:
                    console.print("[yellow]Service stopped.[/yellow]")
                    break
                if len(new_logs) > last_count:
                    for line in new_logs[last_count:]:
                        console.print(f"[dim]{line}[/dim]")
                    last_count = len(new_logs)
        except KeyboardInterrupt:
            console.print("\n[dim]Stopped following logs.[/dim]")


@devops.command("health")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
@click.option(
    "--env", "-e",
    "environment",
    default=None,
    help="Filter by environment name"
)
@click.option(
    "--service", "-s",
    "service_name",
    default=None,
    help="Check specific service only"
)
def devops_health(working_dir: Optional[str], environment: Optional[str], service_name: Optional[str]):
    """Run health checks on services.

    Checks configured health endpoints for all services with health_check defined.

    Examples:
        hester devops health
        hester devops health --env local
        hester devops health --service api
    """
    from hester.devops import ServiceManager

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    console.print("[bold]Health Checks[/bold]")
    console.print()

    results = asyncio.run(manager.health_check(service_name, environment))

    if not results:
        console.print("[yellow]No services with health checks configured.[/yellow]")
        return

    for result in results:
        status = result["status"]
        if status == "healthy":
            status_str = "[green]HEALTHY[/green]"
        elif status == "unhealthy":
            status_str = "[red]UNHEALTHY[/red]"
        elif status == "unreachable":
            status_str = "[yellow]UNREACHABLE[/yellow]"
        else:
            status_str = f"[dim]{status}[/dim]"

        response_time = f"[dim]{result['response_time_ms']}ms[/dim]" if result.get("response_time_ms") else ""
        error = f" [red]({result['error']})[/red]" if result.get("error") else ""

        console.print(f"  {result['service']}: {status_str} {response_time}{error}")

    healthy = sum(1 for r in results if r["status"] == "healthy")
    console.print()
    console.print(f"[dim]{healthy}/{len(results)} healthy[/dim]")


@devops.command("docker")
@click.option(
    "--logs", "-l",
    "container_name",
    default=None,
    help="Show logs for a container"
)
@click.option(
    "--lines", "-n",
    default=50,
    help="Number of log lines (default: 50)"
)
def devops_docker(container_name: Optional[str], lines: int):
    """Show Docker container status or logs.

    Without arguments, shows status of all containers.
    With --logs, shows logs for a specific container.

    Examples:
        hester devops docker
        hester devops docker --logs redis
        hester devops docker --logs api --lines 100
    """
    from hester.daemon.tools.devops_tools import devops_docker_status, devops_docker_logs

    if container_name:
        # Show logs
        result = asyncio.run(devops_docker_logs(container_name, lines))
        if result.success:
            console.print(f"[bold]Docker Logs: {container_name}[/bold]")
            console.print()
            for line in result.data.get("logs", []):
                console.print(f"[dim]{line}[/dim]")
        else:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)
    else:
        # Show status
        result = asyncio.run(devops_docker_status())
        if result.success:
            console.print("[bold]Docker Containers[/bold]")
            console.print()
            containers = result.data.get("containers", [])
            if not containers:
                console.print("[yellow]No containers running.[/yellow]")
                return

            for c in containers:
                status = c.get("status", "unknown")
                if "Up" in status:
                    status_str = f"[green]{status}[/green]"
                else:
                    status_str = f"[dim]{status}[/dim]"

                ports = c.get("ports", "")
                port_str = f" [dim]{ports}[/dim]" if ports else ""

                console.print(f"  {c['name']}: {status_str}{port_str}")
        else:
            console.print(f"[red]Error: {result.error}[/red]")
            sys.exit(1)


@devops.command("up")
@click.argument("services", nargs=-1)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with docker-compose.yaml"
)
@click.option(
    "--build", "-b",
    is_flag=True,
    help="Build images before starting"
)
@click.option(
    "--no-cache",
    is_flag=True,
    help="Build without cache (implies --build)"
)
@click.option(
    "--detach", "-D",
    is_flag=True,
    help="Run in detached mode"
)
def devops_up(services: tuple, working_dir: Optional[str], build: bool, no_cache: bool, detach: bool):
    """Start Docker Compose services.

    Examples:
        hester devops up
        hester devops up api agentic
        hester devops up --build
        hester devops up --no-cache
        hester devops up -D  # detached
    """
    import subprocess

    working_dir = working_dir or os.getcwd()

    cmd = ["docker-compose", "up"]

    if no_cache:
        # no-cache implies build
        cmd.append("--build")
    elif build:
        cmd.append("--build")

    if detach:
        cmd.append("-d")

    if services:
        cmd.extend(services)

    console.print(f"[cyan]Running: {' '.join(cmd)}[/cyan]")
    if no_cache:
        console.print("[yellow]Building without cache...[/yellow]")
    console.print()

    # If no-cache, we need to build first
    if no_cache:
        build_cmd = ["docker-compose", "build", "--no-cache"]
        if services:
            build_cmd.extend(services)
        console.print(f"[dim]$ {' '.join(build_cmd)}[/dim]")
        result = subprocess.run(build_cmd, cwd=working_dir)
        if result.returncode != 0:
            console.print("[red]Build failed[/red]")
            sys.exit(result.returncode)
        console.print()

    # Run docker-compose up
    try:
        subprocess.run(cmd, cwd=working_dir, check=True)
    except subprocess.CalledProcessError as e:
        sys.exit(e.returncode)
    except KeyboardInterrupt:
        console.print("\n[yellow]Stopping...[/yellow]")


@devops.command("down")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with docker-compose.yaml"
)
@click.option(
    "--volumes", "-v",
    is_flag=True,
    help="Remove volumes"
)
@click.option(
    "--rmi",
    type=click.Choice(["all", "local"]),
    default=None,
    help="Remove images (all or local)"
)
def devops_down(working_dir: Optional[str], volumes: bool, rmi: Optional[str]):
    """Stop and remove Docker Compose services.

    Examples:
        hester devops down
        hester devops down -v  # remove volumes
        hester devops down --rmi all  # remove images too
    """
    import subprocess

    working_dir = working_dir or os.getcwd()

    cmd = ["docker-compose", "down"]

    if volumes:
        cmd.append("-v")

    if rmi:
        cmd.extend(["--rmi", rmi])

    console.print(f"[cyan]Running: {' '.join(cmd)}[/cyan]")
    console.print()

    try:
        subprocess.run(cmd, cwd=working_dir, check=True)
        console.print("[green]Services stopped.[/green]")
    except subprocess.CalledProcessError as e:
        console.print(f"[red]Failed with exit code {e.returncode}[/red]")
        sys.exit(e.returncode)


@devops.command("rebuild")
@click.argument("services", nargs=-1)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with docker-compose.yaml"
)
@click.option(
    "--no-cache",
    is_flag=True,
    help="Build without cache"
)
def devops_rebuild(services: tuple, working_dir: Optional[str], no_cache: bool):
    """Rebuild and restart Docker Compose services.

    Shortcut for: down + build + up

    Examples:
        hester devops rebuild
        hester devops rebuild api
        hester devops rebuild --no-cache
        hester devops rebuild api agentic --no-cache
    """
    import subprocess

    working_dir = working_dir or os.getcwd()

    # Step 1: Down
    console.print("[cyan]Stopping services...[/cyan]")
    down_cmd = ["docker-compose", "down"]
    subprocess.run(down_cmd, cwd=working_dir)
    console.print()

    # Step 2: Build
    console.print("[cyan]Building images...[/cyan]")
    build_cmd = ["docker-compose", "build"]
    if no_cache:
        build_cmd.append("--no-cache")
        console.print("[yellow]Building without cache (this may take a while)...[/yellow]")
    if services:
        build_cmd.extend(services)

    result = subprocess.run(build_cmd, cwd=working_dir)
    if result.returncode != 0:
        console.print("[red]Build failed[/red]")
        sys.exit(result.returncode)
    console.print()

    # Step 3: Up
    console.print("[cyan]Starting services...[/cyan]")
    up_cmd = ["docker-compose", "up", "-d"]
    if services:
        up_cmd.extend(services)

    result = subprocess.run(up_cmd, cwd=working_dir)
    if result.returncode != 0:
        console.print("[red]Failed to start services[/red]")
        sys.exit(result.returncode)

    console.print()
    console.print("[green]Rebuild complete![/green]")


@devops.command("build")
@click.argument("services", nargs=-1)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with docker-compose.yaml"
)
@click.option(
    "--no-cache",
    is_flag=True,
    help="Build without cache"
)
def devops_build(services: tuple, working_dir: Optional[str], no_cache: bool):
    """Build Docker Compose images.

    Examples:
        hester devops build
        hester devops build api
        hester devops build --no-cache
    """
    import subprocess

    working_dir = working_dir or os.getcwd()

    cmd = ["docker-compose", "build"]

    if no_cache:
        cmd.append("--no-cache")
        console.print("[yellow]Building without cache...[/yellow]")

    if services:
        cmd.extend(services)

    console.print(f"[cyan]Running: {' '.join(cmd)}[/cyan]")
    console.print()

    try:
        subprocess.run(cmd, cwd=working_dir, check=True)
        console.print("[green]Build complete![/green]")
    except subprocess.CalledProcessError as e:
        console.print(f"[red]Build failed with exit code {e.returncode}[/red]")
        sys.exit(e.returncode)


@devops.command("ps")
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with docker-compose.yaml"
)
def devops_ps(working_dir: Optional[str]):
    """Show Docker Compose service status.

    Examples:
        hester devops ps
    """
    import subprocess

    working_dir = working_dir or os.getcwd()

    cmd = ["docker-compose", "ps"]

    try:
        subprocess.run(cmd, cwd=working_dir, check=True)
    except subprocess.CalledProcessError as e:
        sys.exit(e.returncode)


@devops.command("env")
@click.argument("name", required=False)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
def devops_env(name: Optional[str], working_dir: Optional[str]):
    """Show or switch the active environment.

    Without arguments, shows the current environment and available contexts.
    With a name, switches to that environment.

    Examples:
        hester devops env
        hester devops env staging
        hester devops env local
    """
    from hester.devops import ServiceManager

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    if not name:
        # Show current environment
        console.print("[bold]Environments[/bold]")
        console.print()

        for env in manager.environments:
            is_active = env.name == manager.active_environment
            marker = "→" if is_active else " "
            style = "bold green" if is_active else "dim"

            console.print(f"  {marker} [bold]{env.name}[/bold]", style=style, end="")
            if env.description:
                console.print(f"  [dim]{env.description}[/dim]", end="")
            console.print()

            if env.docker_context:
                console.print(f"      docker context: [cyan]{env.docker_context}[/cyan]")
            if env.kubectl_context:
                console.print(f"      kubectl context: [cyan]{env.kubectl_context}[/cyan]")
            if env.confirm_actions:
                console.print(f"      [yellow]confirm_actions: true[/yellow]")

            svc_count = len(env.services)
            console.print(f"      {svc_count} service{'s' if svc_count != 1 else ''}")
            console.print()
    else:
        # Switch environment
        success, message = manager.switch_environment(name)
        if success:
            console.print(f"[green]{message}[/green]")
        else:
            console.print(f"[red]{message}[/red]")
            sys.exit(1)


@devops.command("macro")
@click.argument("name", required=False)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory with .lee/config.yaml"
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Show steps without executing"
)
def devops_macro(name: Optional[str], working_dir: Optional[str], dry_run: bool):
    """List or run macros.

    Without arguments, lists all available macros.
    With a name, runs the macro (or shows steps with --dry-run).

    Examples:
        hester devops macro
        hester devops macro flush-all-redis
        hester devops macro deploy-staging --dry-run
    """
    from hester.devops import ServiceManager

    working_dir = working_dir or os.getcwd()
    manager = ServiceManager(working_dir)

    if "error" in manager.config:
        console.print(f"[red]Error loading config: {manager.config['error']}[/red]")
        sys.exit(1)

    if not name:
        # List macros
        if not manager.macros:
            console.print("[yellow]No macros configured.[/yellow]")
            return

        console.print("[bold]Macros[/bold]")
        console.print()

        for macro in manager.macros:
            shortcut = f"  [cyan]{macro.shortcut}[/cyan]" if macro.shortcut else ""
            confirm = "  [yellow]⚠ confirm[/yellow]" if macro.confirm else ""
            console.print(f"  [bold]{macro.name}[/bold]{shortcut}{confirm}")
            if macro.description:
                console.print(f"    {macro.description}")
            console.print(f"    [dim]{len(macro.steps)} steps[/dim]")
            console.print()
    else:
        # Run or dry-run macro
        macro = manager.get_macro(name)
        if not macro:
            console.print(f"[red]Macro '{name}' not found[/red]")
            sys.exit(1)

        if dry_run:
            console.print(f"[bold]Macro: {macro.name}[/bold]")
            if macro.description:
                console.print(f"[dim]{macro.description}[/dim]")
            console.print()

            for i, step in enumerate(macro.steps):
                step_num = f"[dim]{i+1}.[/dim]"
                if step.context:
                    console.print(f"  {step_num} [cyan]Switch context → {step.context}[/cyan]")
                elif step.service and step.action:
                    env_info = f" [dim](in {step.environment})[/dim]" if step.environment else ""
                    console.print(f"  {step_num} [green]{step.service}[/green]:{step.action}{env_info}")
                elif step.command:
                    console.print(f"  {step_num} [yellow]$ {step.command}[/yellow]")
            return

        console.print(f"[cyan]Running macro: {macro.name}[/cyan]")
        if macro.description:
            console.print(f"[dim]{macro.description}[/dim]")
        console.print()

        def on_step(idx, total, step):
            if step.context:
                console.print(f"  [{idx+1}/{total}] Switching to {step.context}...")
            elif step.service and step.action:
                console.print(f"  [{idx+1}/{total}] {step.service}: {step.action}...")
            elif step.command:
                console.print(f"  [{idx+1}/{total}] $ {step.command}...")

        success, message = asyncio.run(manager.run_macro(name, on_step=on_step))

        if success:
            console.print(f"\n[green]{message}[/green]")
        else:
            console.print(f"\n[red]{message}[/red]")
            sys.exit(1)
