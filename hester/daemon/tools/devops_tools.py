"""
DevOps Tools - Service management for local development environments.

These tools allow Hester to manage services defined in lee/config.yaml,
check Docker container status, and run health checks.
"""

import asyncio
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import yaml

from .base import ToolResult


# Global service registry - tracks running services
_running_services: Dict[str, Dict[str, Any]] = {}


def _get_shell_env() -> Dict[str, str]:
    """
    Get environment with extended PATH for shell commands.

    Ensures common tool locations are in PATH, similar to how Lee's
    PTY manager handles environment setup for interactive shells.
    """
    env = {**os.environ}

    # Common paths where tools like docker-compose might be installed
    extra_paths = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / "bin"),
    ]

    current_path = env.get("PATH", "")
    path_parts = current_path.split(":") if current_path else []

    # Add extra paths that aren't already present
    for extra in extra_paths:
        if extra not in path_parts:
            path_parts.insert(0, extra)

    env["PATH"] = ":".join(path_parts)
    return env


def _run_shell_command(
    cmd: List[str],
    cwd: Optional[str] = None,
    timeout: int = 120,
    capture_output: bool = True,
) -> subprocess.CompletedProcess:
    """
    Run a shell command with proper environment setup.

    Uses login shell to ensure PATH and other environment variables
    are properly set from .bashrc/.bash_profile.
    """
    # Build command string for shell execution
    cmd_str = " ".join(cmd)

    # Get shell (prefer user's shell, fall back to bash)
    shell = os.environ.get("SHELL", "/bin/bash")

    # Run through interactive login shell to source .bashrc/.bash_profile
    # This ensures tools like docker-compose are found even when running
    # from environments with minimal PATH
    shell_cmd = [shell, "-ilc", cmd_str]

    return subprocess.run(
        shell_cmd,
        cwd=cwd,
        capture_output=capture_output,
        text=True,
        timeout=timeout,
        env=_get_shell_env(),
    )


def _parse_config(working_dir: str) -> Dict[str, Any]:
    """Parse .lee/config.yaml from the working directory."""
    config_paths = [
        Path(working_dir) / ".lee" / "config.yaml",
        Path.home() / ".config" / "lee" / "config.yaml",
    ]

    for config_path in config_paths:
        if config_path.exists():
            try:
                with open(config_path) as f:
                    return yaml.safe_load(f) or {}
            except Exception as e:
                return {"error": f"Failed to parse config: {e}"}

    return {"error": "No config file found (.lee/config.yaml or ~/.config/lee/config.yaml)"}


def _get_service_key(env_name: str, service_name: str) -> str:
    """Generate unique key for service tracking."""
    return f"{env_name}:{service_name}"


def _find_service(
    config: Dict[str, Any],
    service_name: str,
    environment: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Find a service in the config by name."""
    environments = config.get("environments", [])

    for env in environments:
        if environment and env.get("name") != environment:
            continue

        for service in env.get("services", []):
            if service.get("name") == service_name:
                return {
                    "environment": env.get("name"),
                    "service": service,
                }

    return None


async def devops_list_services(
    environment: Optional[str] = None,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """List all configured services with their status."""
    working_dir = working_dir or os.getcwd()
    config = _parse_config(working_dir)

    if "error" in config:
        return ToolResult(success=False, error=config["error"])

    environments = config.get("environments", [])
    result = []

    for env in environments:
        if environment and env.get("name") != environment:
            continue

        env_info = {
            "name": env.get("name"),
            "description": env.get("description", ""),
            "services": [],
        }

        for service in env.get("services", []):
            service_key = _get_service_key(env.get("name"), service.get("name"))
            running_info = _running_services.get(service_key, {})

            service_info = {
                "name": service.get("name"),
                "command": service.get("command"),
                "port": service.get("port"),
                "health_check": service.get("health_check"),
                "status": "running" if running_info.get("pid") else "stopped",
                "pid": running_info.get("pid"),
            }
            env_info["services"].append(service_info)

        result.append(env_info)

    return ToolResult(
        success=True,
        data=result,
        message=f"Found {sum(len(e['services']) for e in result)} services in {len(result)} environments",
    )


async def devops_start_service(
    service_name: str,
    environment: Optional[str] = None,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Start a configured service."""
    working_dir = working_dir or os.getcwd()
    config = _parse_config(working_dir)

    if "error" in config:
        return ToolResult(success=False, error=config["error"])

    found = _find_service(config, service_name, environment)
    if not found:
        return ToolResult(
            success=False,
            error=f"Service '{service_name}' not found in config",
        )

    env_name = found["environment"]
    service = found["service"]
    service_key = _get_service_key(env_name, service_name)

    # Check if already running
    if service_key in _running_services and _running_services[service_key].get("pid"):
        pid = _running_services[service_key]["pid"]
        try:
            os.kill(pid, 0)  # Check if process exists
            return ToolResult(
                success=False,
                error=f"Service '{service_name}' is already running (PID: {pid})",
            )
        except ProcessLookupError:
            # Process died, clean up
            del _running_services[service_key]

    # Build command
    command = service.get("command")
    cwd = service.get("cwd")
    if cwd:
        cwd = str(Path(working_dir) / cwd)
    else:
        cwd = working_dir

    try:
        # Start process in background through login shell
        # This ensures PATH and environment are properly set
        shell = os.environ.get("SHELL", "/bin/bash")
        shell_cmd = [shell, "-ilc", command]

        process = subprocess.Popen(
            shell_cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=_get_shell_env(),
        )

        # Track the service
        _running_services[service_key] = {
            "pid": process.pid,
            "process": process,
            "command": command,
            "cwd": cwd,
            "started_at": time.time(),
            "logs": [],
        }

        # Start log collection thread
        asyncio.create_task(_collect_logs(service_key, process))

        return ToolResult(
            success=True,
            data={
                "service": service_name,
                "environment": env_name,
                "pid": process.pid,
                "command": command,
                "cwd": cwd,
            },
            message=f"Started '{service_name}' (PID: {process.pid})",
        )

    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Failed to start service: {e}",
        )


async def _collect_logs(service_key: str, process: subprocess.Popen):
    """Collect logs from a running process."""
    try:
        while True:
            if process.poll() is not None:
                break

            line = process.stdout.readline()
            if line:
                if service_key in _running_services:
                    logs = _running_services[service_key].get("logs", [])
                    logs.append(line.decode("utf-8", errors="replace").rstrip())
                    # Keep last 500 lines
                    _running_services[service_key]["logs"] = logs[-500:]
            else:
                await asyncio.sleep(0.1)
    except Exception:
        pass


async def devops_stop_service(
    service_name: str,
    environment: Optional[str] = None,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Stop a running service."""
    working_dir = working_dir or os.getcwd()
    config = _parse_config(working_dir)

    if "error" in config:
        return ToolResult(success=False, error=config["error"])

    found = _find_service(config, service_name, environment)
    if not found:
        return ToolResult(
            success=False,
            error=f"Service '{service_name}' not found in config",
        )

    env_name = found["environment"]
    service_key = _get_service_key(env_name, service_name)

    if service_key not in _running_services:
        return ToolResult(
            success=False,
            error=f"Service '{service_name}' is not running",
        )

    running_info = _running_services[service_key]
    pid = running_info.get("pid")

    try:
        # Send SIGTERM
        os.killpg(os.getpgid(pid), signal.SIGTERM)

        # Wait briefly for graceful shutdown
        process = running_info.get("process")
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Force kill
                os.killpg(os.getpgid(pid), signal.SIGKILL)

        del _running_services[service_key]

        return ToolResult(
            success=True,
            data={"service": service_name, "pid": pid},
            message=f"Stopped '{service_name}' (PID: {pid})",
        )

    except ProcessLookupError:
        # Already dead
        del _running_services[service_key]
        return ToolResult(
            success=True,
            message=f"Service '{service_name}' was already stopped",
        )
    except Exception as e:
        return ToolResult(
            success=False,
            error=f"Failed to stop service: {e}",
        )


async def devops_service_status(
    service_name: str,
    environment: Optional[str] = None,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Get detailed status of a service."""
    working_dir = working_dir or os.getcwd()
    config = _parse_config(working_dir)

    if "error" in config:
        return ToolResult(success=False, error=config["error"])

    found = _find_service(config, service_name, environment)
    if not found:
        return ToolResult(
            success=False,
            error=f"Service '{service_name}' not found in config",
        )

    env_name = found["environment"]
    service = found["service"]
    service_key = _get_service_key(env_name, service_name)

    running_info = _running_services.get(service_key, {})
    pid = running_info.get("pid")
    is_running = False

    if pid:
        try:
            os.kill(pid, 0)
            is_running = True
        except ProcessLookupError:
            # Process died
            if service_key in _running_services:
                del _running_services[service_key]

    uptime = None
    if is_running and running_info.get("started_at"):
        uptime = int(time.time() - running_info["started_at"])

    status = {
        "service": service_name,
        "environment": env_name,
        "status": "running" if is_running else "stopped",
        "pid": pid if is_running else None,
        "command": service.get("command"),
        "cwd": service.get("cwd"),
        "port": service.get("port"),
        "health_check": service.get("health_check"),
        "uptime_seconds": uptime,
        "recent_logs": running_info.get("logs", [])[-10:] if is_running else [],
    }

    return ToolResult(
        success=True,
        data=status,
        message=f"Service '{service_name}' is {'running' if is_running else 'stopped'}",
    )


async def devops_service_logs(
    service_name: str,
    environment: Optional[str] = None,
    lines: int = 50,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Get logs from a running service."""
    working_dir = working_dir or os.getcwd()
    config = _parse_config(working_dir)

    if "error" in config:
        return ToolResult(success=False, error=config["error"])

    found = _find_service(config, service_name, environment)
    if not found:
        return ToolResult(
            success=False,
            error=f"Service '{service_name}' not found in config",
        )

    env_name = found["environment"]
    service_key = _get_service_key(env_name, service_name)

    if service_key not in _running_services:
        return ToolResult(
            success=False,
            error=f"Service '{service_name}' is not running (no logs available)",
        )

    running_info = _running_services[service_key]
    logs = running_info.get("logs", [])

    return ToolResult(
        success=True,
        data={
            "service": service_name,
            "environment": env_name,
            "lines": logs[-lines:],
            "total_lines": len(logs),
        },
        message=f"Retrieved {min(lines, len(logs))} log lines for '{service_name}'",
    )


async def devops_health_check(
    service_name: Optional[str] = None,
    environment: Optional[str] = None,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Run health checks on services."""
    working_dir = working_dir or os.getcwd()
    config = _parse_config(working_dir)

    if "error" in config:
        return ToolResult(success=False, error=config["error"])

    environments = config.get("environments", [])
    results = []

    async with httpx.AsyncClient(timeout=5.0) as client:
        for env in environments:
            if environment and env.get("name") != environment:
                continue

            for service in env.get("services", []):
                if service_name and service.get("name") != service_name:
                    continue

                health_url = service.get("health_check")
                if not health_url:
                    continue

                check_result = {
                    "service": service.get("name"),
                    "environment": env.get("name"),
                    "url": health_url,
                    "status": "unknown",
                    "response_time_ms": None,
                    "error": None,
                }

                try:
                    start = time.time()
                    response = await client.get(health_url)
                    elapsed = (time.time() - start) * 1000

                    check_result["status"] = "healthy" if response.status_code == 200 else "unhealthy"
                    check_result["response_time_ms"] = round(elapsed, 2)
                    check_result["http_status"] = response.status_code

                except httpx.ConnectError:
                    check_result["status"] = "unreachable"
                    check_result["error"] = "Connection refused"
                except httpx.TimeoutException:
                    check_result["status"] = "timeout"
                    check_result["error"] = "Request timed out"
                except Exception as e:
                    check_result["status"] = "error"
                    check_result["error"] = str(e)

                results.append(check_result)

    healthy = sum(1 for r in results if r["status"] == "healthy")

    return ToolResult(
        success=True,
        data=results,
        message=f"Health check: {healthy}/{len(results)} services healthy",
    )


async def devops_docker_status(
    filter: Optional[str] = None,
    all: bool = False,
    **kwargs,
) -> ToolResult:
    """Get Docker container status."""
    try:
        cmd = ["docker", "ps", "--format", "json"]
        if all:
            cmd.append("-a")

        result = _run_shell_command(cmd, timeout=10)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Docker command failed: {result.stderr}",
            )

        import json
        containers = []
        for line in result.stdout.strip().split("\n"):
            if line:
                try:
                    container = json.loads(line)
                    if filter and filter.lower() not in container.get("Names", "").lower():
                        continue
                    containers.append({
                        "id": container.get("ID", "")[:12],
                        "name": container.get("Names"),
                        "image": container.get("Image"),
                        "status": container.get("Status"),
                        "ports": container.get("Ports"),
                        "state": container.get("State"),
                    })
                except json.JSONDecodeError:
                    continue

        return ToolResult(
            success=True,
            data=containers,
            message=f"Found {len(containers)} containers",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Docker command timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="Docker not found - is it installed?")
    except Exception as e:
        return ToolResult(success=False, error=f"Docker error: {e}")


async def devops_docker_logs(
    container: str,
    lines: int = 50,
    **kwargs,
) -> ToolResult:
    """Get logs from a Docker container."""
    try:
        result = _run_shell_command(
            ["docker", "logs", "--tail", str(lines), container],
            timeout=10,
        )

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Docker logs failed: {result.stderr}",
            )

        # Combine stdout and stderr
        logs = result.stdout + result.stderr
        log_lines = logs.strip().split("\n") if logs.strip() else []

        return ToolResult(
            success=True,
            data={
                "container": container,
                "lines": log_lines,
                "total_lines": len(log_lines),
            },
            message=f"Retrieved {len(log_lines)} log lines from '{container}'",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Docker logs command timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="Docker not found - is it installed?")
    except Exception as e:
        return ToolResult(success=False, error=f"Docker logs error: {e}")


# =============================================================================
# Docker Compose tools
# =============================================================================

async def devops_compose_up(
    services: Optional[List[str]] = None,
    build: bool = False,
    no_cache: bool = False,
    detach: bool = True,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Start Docker Compose services."""
    working_dir = working_dir or os.getcwd()

    try:
        # If no_cache, build first
        if no_cache:
            build_cmd = ["docker-compose", "build", "--no-cache"]
            if services:
                build_cmd.extend(services)

            result = _run_shell_command(build_cmd, cwd=working_dir, timeout=600)

            if result.returncode != 0:
                return ToolResult(
                    success=False,
                    error=f"Build failed: {result.stderr}",
                )

        # Build the up command
        cmd = ["docker-compose", "up"]

        if build and not no_cache:
            cmd.append("--build")

        if detach:
            cmd.append("-d")

        if services:
            cmd.extend(services)

        result = _run_shell_command(cmd, cwd=working_dir, timeout=300)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"docker-compose up failed: {result.stderr}",
            )

        return ToolResult(
            success=True,
            data={
                "services": services or ["all"],
                "build": build or no_cache,
                "no_cache": no_cache,
                "detach": detach,
                "output": result.stdout[-2000:] if result.stdout else "",
            },
            message=f"Started services: {', '.join(services) if services else 'all'}",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="docker-compose up timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="docker-compose not found")
    except Exception as e:
        return ToolResult(success=False, error=f"docker-compose up error: {e}")


async def devops_compose_down(
    volumes: bool = False,
    rmi: Optional[str] = None,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Stop and remove Docker Compose services."""
    working_dir = working_dir or os.getcwd()

    try:
        cmd = ["docker-compose", "down"]

        if volumes:
            cmd.append("-v")

        if rmi:
            cmd.extend(["--rmi", rmi])

        result = _run_shell_command(cmd, cwd=working_dir, timeout=120)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"docker-compose down failed: {result.stderr}",
            )

        return ToolResult(
            success=True,
            data={
                "volumes_removed": volumes,
                "images_removed": rmi,
                "output": result.stdout[-2000:] if result.stdout else "",
            },
            message="Services stopped and removed",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="docker-compose down timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="docker-compose not found")
    except Exception as e:
        return ToolResult(success=False, error=f"docker-compose down error: {e}")


async def devops_compose_build(
    services: Optional[List[str]] = None,
    no_cache: bool = False,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Build Docker Compose images."""
    working_dir = working_dir or os.getcwd()

    try:
        cmd = ["docker-compose", "build"]

        if no_cache:
            cmd.append("--no-cache")

        if services:
            cmd.extend(services)

        result = _run_shell_command(cmd, cwd=working_dir, timeout=600)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"docker-compose build failed: {result.stderr}",
            )

        return ToolResult(
            success=True,
            data={
                "services": services or ["all"],
                "no_cache": no_cache,
                "output": result.stdout[-2000:] if result.stdout else "",
            },
            message=f"Built images: {', '.join(services) if services else 'all'}",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="docker-compose build timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="docker-compose not found")
    except Exception as e:
        return ToolResult(success=False, error=f"docker-compose build error: {e}")


async def devops_compose_rebuild(
    services: Optional[List[str]] = None,
    no_cache: bool = False,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Rebuild and restart Docker Compose services (down + build + up)."""
    working_dir = working_dir or os.getcwd()

    try:
        # Step 1: Down
        _run_shell_command(["docker-compose", "down"], cwd=working_dir, timeout=60)

        # Step 2: Build
        build_cmd = ["docker-compose", "build"]
        if no_cache:
            build_cmd.append("--no-cache")
        if services:
            build_cmd.extend(services)

        build_result = _run_shell_command(build_cmd, cwd=working_dir, timeout=600)

        if build_result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Build failed: {build_result.stderr}",
            )

        # Step 3: Up
        up_cmd = ["docker-compose", "up", "-d"]
        if services:
            up_cmd.extend(services)

        up_result = _run_shell_command(up_cmd, cwd=working_dir, timeout=120)

        if up_result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Failed to start services: {up_result.stderr}",
            )

        return ToolResult(
            success=True,
            data={
                "services": services or ["all"],
                "no_cache": no_cache,
            },
            message=f"Rebuilt and restarted: {', '.join(services) if services else 'all services'}",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="docker-compose rebuild timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="docker-compose not found")
    except Exception as e:
        return ToolResult(success=False, error=f"docker-compose rebuild error: {e}")


async def devops_compose_ps(
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Show Docker Compose service status."""
    working_dir = working_dir or os.getcwd()

    try:
        result = _run_shell_command(
            ["docker-compose", "ps", "--format", "json"],
            cwd=working_dir,
            timeout=30,
        )

        if result.returncode != 0:
            # Try without --format json for older docker-compose
            result = _run_shell_command(
                ["docker-compose", "ps"],
                cwd=working_dir,
                timeout=30,
            )

            if result.returncode != 0:
                return ToolResult(
                    success=False,
                    error=f"docker-compose ps failed: {result.stderr}",
                )

            return ToolResult(
                success=True,
                data={"output": result.stdout},
                message="Service status retrieved",
            )

        import json
        services = []
        for line in result.stdout.strip().split("\n"):
            if line:
                try:
                    svc = json.loads(line)
                    services.append({
                        "name": svc.get("Name") or svc.get("Service"),
                        "status": svc.get("Status") or svc.get("State"),
                        "ports": svc.get("Ports") or svc.get("Publishers"),
                    })
                except json.JSONDecodeError:
                    continue

        return ToolResult(
            success=True,
            data={"services": services},
            message=f"Found {len(services)} services",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="docker-compose ps timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="docker-compose not found")
    except Exception as e:
        return ToolResult(success=False, error=f"docker-compose ps error: {e}")


async def devops_compose_logs(
    services: Optional[List[str]] = None,
    lines: int = 50,
    working_dir: str = None,
    **kwargs,
) -> ToolResult:
    """Get logs from Docker Compose services."""
    working_dir = working_dir or os.getcwd()

    try:
        cmd = ["docker-compose", "logs", "--tail", str(lines)]

        if services:
            cmd.extend(services)

        result = _run_shell_command(cmd, cwd=working_dir, timeout=60)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"docker-compose logs failed: {result.stderr}",
            )

        # Combine stdout and stderr
        logs = result.stdout + result.stderr
        log_lines = logs.strip().split("\n") if logs.strip() else []

        return ToolResult(
            success=True,
            data={
                "services": services or ["all"],
                "lines": log_lines[-lines:],
                "total_lines": len(log_lines),
            },
            message=f"Retrieved {min(lines, len(log_lines))} log lines",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="docker-compose logs timed out")
    except FileNotFoundError:
        return ToolResult(success=False, error="docker-compose not found")
    except Exception as e:
        return ToolResult(success=False, error=f"docker-compose logs error: {e}")
