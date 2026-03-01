"""
Service Manager - Core logic for managing services.

Handles:
- Parsing lee/config.yaml
- Starting/stopping services
- Collecting logs
- Health checks
- External service status detection (Docker, Supabase, ports)
"""

import asyncio
import json
import os
import re
import signal
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
import yaml


@dataclass
class ServiceAction:
    """An action/state for a service (e.g., up, down, rebuild)."""
    name: str
    command: str
    shortcut: Optional[str] = None  # e.g., "ctrl+f", "ctrl+u"

    def get_shortcut_key(self) -> Optional[str]:
        """Get the key character for this shortcut (e.g., 'f' from 'ctrl+f')."""
        if not self.shortcut:
            return None
        parts = self.shortcut.lower().split('+')
        if len(parts) == 2 and parts[0] == 'ctrl':
            return parts[1]
        return None


@dataclass
class ServiceConfig:
    """Service configuration from config.yaml."""
    name: str
    description: str = ""
    cwd: Optional[str] = None
    actions: List[ServiceAction] = field(default_factory=list)
    detect: str = "port"  # "docker", "supabase", "port", "flutter"
    ports: List[int] = field(default_factory=list)
    health_checks: List[str] = field(default_factory=list)

    def is_flutter(self) -> bool:
        """Check if this service is a Flutter service."""
        # Check if any action contains flutter command
        return any("flutter" in action.command.lower() for action in self.actions)

    def is_docker(self) -> bool:
        """Check if this service uses Docker detection."""
        return self.detect == "docker"

    def is_supabase(self) -> bool:
        """Check if this service uses Supabase detection."""
        return self.detect == "supabase"

    def get_action(self, name: str) -> Optional[ServiceAction]:
        """Get an action by name."""
        for action in self.actions:
            if action.name == name:
                return action
        return None

    def get_default_action(self) -> Optional[ServiceAction]:
        """Get the default (first) action."""
        return self.actions[0] if self.actions else None


@dataclass
class ServiceStatus:
    """Runtime status of a service."""
    running: bool
    source: str  # "docker", "supabase", "port", "health_check", "managed"
    details: Optional[str] = None  # Container name, PID, etc.
    active_action: Optional[str] = None  # Which action is running (e.g., "web", "up")


@dataclass
class RunningService:
    """State of a running service."""
    config: ServiceConfig
    environment: str
    pid: int
    process: subprocess.Popen
    started_at: float
    logs: List[str] = field(default_factory=list)
    status: str = "running"  # running, stopped, error


class ServiceManager:
    """
    Manages services defined in lee/config.yaml.

    Provides methods to start/stop services and track their state.
    Services are categories (Docker, Supabase, Frame, etc.) with multiple
    actions (up, down, rebuild, web, simulator, etc.).
    """

    def __init__(self, working_dir: str):
        self.working_dir = Path(working_dir)
        self.running_services: Dict[str, RunningService] = {}
        self.config: Dict[str, Any] = {}
        self.services: List[ServiceConfig] = []
        # Track which action is currently active for each service
        self.active_actions: Dict[str, str] = {}  # service_name -> action_name
        self._log_callbacks: Dict[str, Callable[[str, str], None]] = {}
        self._status_callbacks: Dict[str, Callable[[str, str], None]] = {}

        # Load config
        self._load_config()

    def _load_config(self):
        """Load configuration from .lee/config.yaml."""
        config_paths = [
            self.working_dir / ".lee" / "config.yaml",
            Path.home() / ".config" / "lee" / "config.yaml",
        ]

        for config_path in config_paths:
            if config_path.exists():
                try:
                    with open(config_path) as f:
                        self.config = yaml.safe_load(f) or {}
                    self._parse_services()
                    return
                except Exception as e:
                    self.config = {"error": str(e)}
                    return

        self.config = {"error": "No config file found"}

    def _parse_services(self):
        """Parse services from config.yaml.

        Each service is a category (Docker, Supabase, Frame, etc.) with:
        - Multiple actions (up, down, rebuild, web, simulator, etc.)
        - Detection method (docker, supabase, port)
        - Ports to check
        - Health check URLs
        """
        self.services = []

        for svc_data in self.config.get("services", []):
            # Parse actions for this service
            actions = []
            for action_data in svc_data.get("actions", []):
                actions.append(ServiceAction(
                    name=action_data.get("name", ""),
                    command=action_data.get("command", ""),
                    shortcut=action_data.get("shortcut"),
                ))

            self.services.append(ServiceConfig(
                name=svc_data.get("name", "Unknown"),
                description=svc_data.get("description", ""),
                cwd=svc_data.get("cwd"),
                actions=actions,
                detect=svc_data.get("detect", "port"),
                ports=svc_data.get("ports", []),
                health_checks=svc_data.get("health_checks", []),
            ))

    def _get_service_key(self, service_name: str) -> str:
        """Generate unique key for service tracking."""
        return service_name

    def get_service(self, service_name: str) -> Optional[ServiceConfig]:
        """Find a service by name."""
        for service in self.services:
            if service.name == service_name:
                return service
        return None

    def get_all_services(self) -> List[tuple[ServiceConfig, Optional[RunningService]]]:
        """Get all services with their running state."""
        result = []

        for service in self.services:
            key = self._get_service_key(service.name)
            running = self.running_services.get(key)

            # Verify process is still alive
            if running and running.process.poll() is not None:
                # Process died
                running.status = "stopped"
                del self.running_services[key]
                # Clear active action
                if service.name in self.active_actions:
                    del self.active_actions[service.name]
                running = None

            result.append((service, running))

        return result

    def get_action_shortcuts(self) -> Dict[str, tuple[ServiceConfig, ServiceAction]]:
        """Get all actions that have keyboard shortcuts.

        Returns:
            Dict mapping shortcut key (e.g., 'u', 'f') to (service, action) tuple
        """
        shortcuts = {}
        for service in self.services:
            for action in service.actions:
                key = action.get_shortcut_key()
                if key:
                    shortcuts[key] = (service, action)
        return shortcuts

    def on_log(self, service_key: str, callback: Callable[[str, str], None]):
        """Register a log callback for a service."""
        self._log_callbacks[service_key] = callback

    def on_status(self, service_key: str, callback: Callable[[str, str], None]):
        """Register a status callback for a service."""
        self._status_callbacks[service_key] = callback

    async def start_service(
        self,
        service_name: str,
        action_name: Optional[str] = None,
    ) -> tuple[bool, str]:
        """
        Start a service with a specific action.

        Args:
            service_name: Name of the service (e.g., "Docker", "Frame")
            action_name: Name of the action (e.g., "up", "web"). Uses default if not specified.

        Returns:
            Tuple of (success, message)
        """
        service = self.get_service(service_name)
        if not service:
            return False, f"Service '{service_name}' not found"

        # Get the action to run
        if action_name:
            action = service.get_action(action_name)
            if not action:
                return False, f"Action '{action_name}' not found for service '{service_name}'"
        else:
            action = service.get_default_action()
            if not action:
                return False, f"Service '{service_name}' has no actions configured"

        service_key = self._get_service_key(service_name)

        # Check if already running
        if service_key in self.running_services:
            running = self.running_services[service_key]
            if running.process.poll() is None:
                current_action = self.active_actions.get(service_name, "unknown")
                return False, f"Service '{service_name}' is already running action '{current_action}' (PID: {running.pid})"
            else:
                # Process died, clean up
                del self.running_services[service_key]
                if service_name in self.active_actions:
                    del self.active_actions[service_name]

        # Resolve working directory
        cwd = str(self.working_dir / service.cwd) if service.cwd else str(self.working_dir)

        try:
            # Start process
            process = subprocess.Popen(
                action.command,
                shell=True,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env=os.environ.copy(),
            )

            # Track service
            running = RunningService(
                config=service,
                environment=action.name,  # Store action name in environment field
                pid=process.pid,
                process=process,
                started_at=time.time(),
                logs=[],
                status="running",
            )
            self.running_services[service_key] = running
            self.active_actions[service_name] = action.name

            # Start log collection
            asyncio.create_task(self._collect_logs(service_key, process))

            return True, f"Started '{service_name}' action '{action.name}' (PID: {process.pid})"

        except Exception as e:
            return False, f"Failed to start: {e}"

    async def _collect_logs(self, service_key: str, process: subprocess.Popen):
        """Collect logs from a running process."""
        try:
            while True:
                if process.poll() is not None:
                    # Process ended
                    if service_key in self.running_services:
                        self.running_services[service_key].status = "stopped"
                        # Notify status callback
                        if service_key in self._status_callbacks:
                            self._status_callbacks[service_key](service_key, "stopped")
                    break

                line = process.stdout.readline()
                if line:
                    log_line = line.decode("utf-8", errors="replace").rstrip()

                    if service_key in self.running_services:
                        logs = self.running_services[service_key].logs
                        logs.append(log_line)
                        # Keep last 500 lines
                        self.running_services[service_key].logs = logs[-500:]

                        # Notify log callback
                        if service_key in self._log_callbacks:
                            self._log_callbacks[service_key](service_key, log_line)
                else:
                    await asyncio.sleep(0.1)
        except Exception:
            pass

    async def stop_service(self, service_name: str) -> tuple[bool, str]:
        """
        Stop a running service.

        Returns:
            Tuple of (success, message)
        """
        service = self.get_service(service_name)
        if not service:
            return False, f"Service '{service_name}' not found"

        service_key = self._get_service_key(service_name)

        if service_key not in self.running_services:
            return False, f"Service '{service_name}' is not running"

        running = self.running_services[service_key]
        pid = running.pid
        action_name = self.active_actions.get(service_name, "unknown")

        try:
            # Send SIGTERM
            os.killpg(os.getpgid(pid), signal.SIGTERM)

            # Wait for graceful shutdown
            try:
                running.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Force kill
                os.killpg(os.getpgid(pid), signal.SIGKILL)

            del self.running_services[service_key]
            if service_name in self.active_actions:
                del self.active_actions[service_name]

            return True, f"Stopped '{service_name}' action '{action_name}' (PID: {pid})"

        except ProcessLookupError:
            # Already dead
            del self.running_services[service_key]
            if service_name in self.active_actions:
                del self.active_actions[service_name]
            return True, f"Service '{service_name}' was already stopped"
        except Exception as e:
            return False, f"Failed to stop: {e}"

    async def health_check(
        self,
        service_name: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Run health checks on services.

        Returns:
            List of health check results
        """
        results = []

        async with httpx.AsyncClient(timeout=5.0) as client:
            for service in self.services:
                if service_name and service.name != service_name:
                    continue

                # Check all health_checks for this service
                for health_url in service.health_checks:
                    result = {
                        "service": service.name,
                        "url": health_url,
                        "status": "unknown",
                        "response_time_ms": None,
                        "error": None,
                    }

                    try:
                        start = time.time()
                        response = await client.get(health_url)
                        elapsed = (time.time() - start) * 1000

                        result["status"] = "healthy" if response.status_code == 200 else "unhealthy"
                        result["response_time_ms"] = round(elapsed, 2)
                        result["http_status"] = response.status_code

                    except httpx.ConnectError:
                        result["status"] = "unreachable"
                        result["error"] = "Connection refused"
                    except httpx.TimeoutException:
                        result["status"] = "timeout"
                        result["error"] = "Request timed out"
                    except Exception as e:
                        result["status"] = "error"
                        result["error"] = str(e)

                    results.append(result)

        return results

    def get_logs(
        self,
        service_name: str,
        lines: int = 50,
    ) -> Optional[List[str]]:
        """Get logs from a running service."""
        service = self.get_service(service_name)
        if not service:
            return None

        service_key = self._get_service_key(service_name)

        if service_key not in self.running_services:
            return None

        return self.running_services[service_key].logs[-lines:]

    def stop_all(self):
        """Stop all running services."""
        for service_key in list(self.running_services.keys()):
            running = self.running_services[service_key]
            try:
                os.killpg(os.getpgid(running.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception:
                pass

        self.running_services.clear()
        self.active_actions.clear()

    # =========================================================================
    # External Service Status Detection
    # =========================================================================

    def _get_docker_containers(self) -> Dict[str, Dict[str, Any]]:
        """
        Get running Docker containers with their info.

        Returns:
            Dict mapping container name/service to container info
        """
        try:
            result = subprocess.run(
                ["docker", "ps", "--format", "{{json .}}"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                return {}

            containers = {}
            for line in result.stdout.strip().split("\n"):
                if not line:
                    continue
                try:
                    container = json.loads(line)
                    # Index by multiple keys for flexible lookup
                    name = container.get("Names", "")
                    # Docker Compose uses project_service_1 naming
                    containers[name] = container
                    # Also index by service name extracted from compose naming
                    # e.g., "myapp-api-1" -> "api"
                    if "-" in name:
                        parts = name.split("-")
                        if len(parts) >= 2:
                            service_name = parts[-2]  # Second to last part
                            containers[service_name] = container
                except json.JSONDecodeError:
                    continue

            return containers
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
            return {}

    def _get_supabase_status(self) -> Dict[str, bool]:
        """
        Get Local Supabase service status via CLI.

        Returns:
            Dict with service statuses (db, api, studio, etc.)
        """
        try:
            result = subprocess.run(
                ["npx", "supabase", "status"],
                capture_output=True,
                text=True,
                timeout=10,
                cwd=str(self.working_dir),
            )

            status = {
                "running": False,
                "db": False,
                "api": False,
                "studio": False,
            }

            if result.returncode != 0:
                return status

            output = result.stdout.lower()
            # Check for running indicators in output
            # Supabase status shows "supabase local development setup is running" when active
            if "is running" in output or "setup is running" in output:
                status["running"] = True
            # Also check for URL indicators (Project URL, Studio, Database URL)
            if "project url" in output or "127.0.0.1:54321" in output:
                status["running"] = True
                status["api"] = True
            if "studio" in output and "127.0.0.1:54323" in output:
                status["studio"] = True
            if "database" in output or "127.0.0.1:54322" in output:
                status["db"] = True

            return status
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
            return {"running": False, "db": False, "api": False, "studio": False}

    def _is_port_in_use(self, port: int) -> bool:
        """Check if a port is in use (something is listening)."""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                result = s.connect_ex(("127.0.0.1", port))
                return result == 0
        except Exception:
            return False

    def get_service_status(
        self,
        service: ServiceConfig,
        docker_containers: Optional[Dict[str, Dict[str, Any]]] = None,
        supabase_status: Optional[Dict[str, bool]] = None,
        health_results: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> ServiceStatus:
        """
        Determine the status of a service using multiple detection methods.

        Priority:
        1. If managed by ServiceManager, check process status
        2. For Docker services (detect="docker"), check docker ps
        3. For Supabase (detect="supabase"), check npx supabase status
        4. For port-based services (detect="port"), check port availability
        5. Fall back to health check results

        Args:
            service: The service configuration
            docker_containers: Pre-fetched docker container info (optional)
            supabase_status: Pre-fetched supabase status (optional)
            health_results: Pre-fetched health check results (optional)

        Returns:
            ServiceStatus with running state, source, and active action
        """
        service_key = self._get_service_key(service.name)

        # 1. Check if we're managing this process directly
        running = self.running_services.get(service_key)
        if running and running.process.poll() is None:
            return ServiceStatus(
                running=True,
                source="managed",
                details=f"PID {running.pid}",
                active_action=self.active_actions.get(service.name),
            )

        # 2. Check Docker containers for docker services
        if service.is_docker():
            if docker_containers is None:
                docker_containers = self._get_docker_containers()

            # Check if any container from our project is running
            if docker_containers:
                container_count = 0
                for name, container in docker_containers.items():
                    container_name = container.get("Names", "")
                    if container_name:  # Count running containers
                        container_count += 1

                if container_count > 0:
                    return ServiceStatus(
                        running=True,
                        source="docker",
                        details=f"{container_count} containers",
                        active_action=None,  # External, not managed
                    )

        # 3. Check Supabase status
        if service.is_supabase():
            if supabase_status is None:
                supabase_status = self._get_supabase_status()

            if supabase_status.get("running", False):
                return ServiceStatus(
                    running=True,
                    source="supabase",
                    details="Local Supabase running",
                    active_action=None,
                )

        # 4. Check port availability for port-based services (including Flutter)
        if service.ports:
            for port in service.ports:
                if self._is_port_in_use(port):
                    return ServiceStatus(
                        running=True,
                        source="port",
                        details=f"Port {port} in use",
                        active_action=self.active_actions.get(service.name),
                    )

        # 5. Fall back to health check results
        if health_results and service.name in health_results:
            health = health_results[service.name]
            if health.get("status") == "healthy":
                return ServiceStatus(
                    running=True,
                    source="health_check",
                    details="Health check passed",
                    active_action=None,
                )

        # Service appears to be stopped
        return ServiceStatus(
            running=False,
            source="none",
            details=None,
            active_action=None,
        )

    def get_all_service_statuses(
        self,
        health_results: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, ServiceStatus]:
        """
        Get status for all configured services.

        Fetches Docker and Supabase status once and reuses for all services.

        Args:
            health_results: Optional pre-fetched health check results

        Returns:
            Dict mapping service name to ServiceStatus
        """
        # Fetch external status info once
        docker_containers = self._get_docker_containers()
        supabase_status = self._get_supabase_status()

        statuses = {}
        for service in self.services:
            statuses[service.name] = self.get_service_status(
                service=service,
                docker_containers=docker_containers,
                supabase_status=supabase_status,
                health_results=health_results,
            )

        return statuses
