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
class EnvironmentConfig:
    """Environment configuration (local, staging, etc.)."""
    name: str
    description: str = ""
    docker_context: Optional[str] = None
    kubectl_context: Optional[str] = None
    confirm_actions: bool = False
    services: List[ServiceConfig] = field(default_factory=list)


@dataclass
class MacroStep:
    """A single step in a macro."""
    # Pattern 1: service action reference
    service: Optional[str] = None
    action: Optional[str] = None
    environment: Optional[str] = None
    # Pattern 2: raw shell command
    command: Optional[str] = None
    cwd: Optional[str] = None
    # Pattern 3: context switch
    context: Optional[str] = None


@dataclass
class MacroConfig:
    """Macro definition - a composable multi-step workflow."""
    name: str
    description: str = ""
    shortcut: Optional[str] = None
    confirm: bool = False
    steps: List[MacroStep] = field(default_factory=list)

    def get_shortcut_key(self) -> Optional[str]:
        """Get the key character for this shortcut (e.g., 'x' from 'ctrl+x')."""
        if not self.shortcut:
            return None
        parts = self.shortcut.lower().split('+')
        if len(parts) == 2 and parts[0] == 'ctrl':
            return parts[1]
        return None


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
        # Environment support
        self.environments: List[EnvironmentConfig] = []
        self.active_environment: str = "default"
        self.macros: List[MacroConfig] = []
        # Track which action is currently active for each service
        self.active_actions: Dict[str, str] = {}  # env:service_name -> action_name
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

        Supports two formats:
        1. environments: { local: { services: [...] }, staging: { ... } }
        2. services: [...] (bare list, wrapped in implicit "default" environment)
        """
        self.services = []
        self.environments = []
        self.macros = []

        if "environments" in self.config and isinstance(self.config["environments"], dict):
            # New format: named environments
            for env_name, env_data in self.config["environments"].items():
                if not isinstance(env_data, dict):
                    continue
                env = EnvironmentConfig(
                    name=env_name,
                    description=env_data.get("description", ""),
                    docker_context=env_data.get("docker_context"),
                    kubectl_context=env_data.get("kubectl_context"),
                    confirm_actions=env_data.get("confirm_actions", False),
                    services=self._parse_service_list(env_data.get("services", [])),
                )
                self.environments.append(env)

            # Set active environment
            self.active_environment = self.config.get(
                "active_environment",
                self.environments[0].name if self.environments else "default",
            )
        elif "services" in self.config:
            # Legacy format: bare services list -> implicit "default" environment
            env = EnvironmentConfig(
                name="default",
                services=self._parse_service_list(self.config.get("services", [])),
            )
            self.environments = [env]
            self.active_environment = "default"

        # Parse macros
        for macro_data in self.config.get("macros", []):
            steps = []
            for step_data in macro_data.get("steps", []):
                steps.append(MacroStep(
                    service=step_data.get("service"),
                    action=step_data.get("action"),
                    environment=step_data.get("environment"),
                    command=step_data.get("command"),
                    cwd=step_data.get("cwd"),
                    context=step_data.get("context"),
                ))
            self.macros.append(MacroConfig(
                name=macro_data.get("name", ""),
                description=macro_data.get("description", ""),
                shortcut=macro_data.get("shortcut"),
                confirm=macro_data.get("confirm", False),
                steps=steps,
            ))

        # Point self.services at active environment's services
        self._sync_active_services()

    def _parse_service_list(self, services_data: list) -> List[ServiceConfig]:
        """Parse a list of service dicts into ServiceConfig objects."""
        services = []
        for svc_data in services_data:
            actions = []
            for action_data in svc_data.get("actions", []):
                actions.append(ServiceAction(
                    name=action_data.get("name", ""),
                    command=action_data.get("command", ""),
                    shortcut=action_data.get("shortcut"),
                ))
            services.append(ServiceConfig(
                name=svc_data.get("name", "Unknown"),
                description=svc_data.get("description", ""),
                cwd=svc_data.get("cwd"),
                actions=actions,
                detect=svc_data.get("detect", "port"),
                ports=svc_data.get("ports", []),
                health_checks=svc_data.get("health_checks", []),
            ))
        return services

    def _sync_active_services(self):
        """Point self.services at the active environment's service list."""
        env = self.get_environment(self.active_environment)
        self.services = env.services if env else []

    def _get_service_key(self, service_name: str) -> str:
        """Generate unique key for service tracking."""
        return f"{self.active_environment}:{service_name}"

    # =========================================================================
    # Environment Management
    # =========================================================================

    def get_environment(self, name: str) -> Optional[EnvironmentConfig]:
        """Find an environment by name."""
        for env in self.environments:
            if env.name == name:
                return env
        return None

    def get_environment_names(self) -> List[str]:
        """Get list of all environment names."""
        return [env.name for env in self.environments]

    def switch_environment(self, name: str) -> tuple[bool, str]:
        """Switch to a different environment.

        Runs docker context use and kubectl config use-context if configured.
        Updates self.services to point at the new environment's services.

        Returns:
            Tuple of (success, message)
        """
        env = self.get_environment(name)
        if not env:
            return False, f"Environment '{name}' not found"

        if name == self.active_environment:
            return True, f"Already on environment '{name}'"

        messages = []

        # Switch Docker context
        if env.docker_context:
            try:
                result = subprocess.run(
                    ["docker", "context", "use", env.docker_context],
                    capture_output=True, text=True, timeout=10,
                )
                if result.returncode == 0:
                    messages.append(f"Docker context → {env.docker_context}")
                else:
                    return False, f"Failed to switch Docker context: {result.stderr.strip()}"
            except (subprocess.TimeoutExpired, FileNotFoundError) as e:
                return False, f"Docker context switch failed: {e}"

        # Switch kubectl context
        if env.kubectl_context:
            try:
                result = subprocess.run(
                    ["kubectl", "config", "use-context", env.kubectl_context],
                    capture_output=True, text=True, timeout=10,
                )
                if result.returncode == 0:
                    messages.append(f"kubectl context → {env.kubectl_context}")
                else:
                    return False, f"Failed to switch kubectl context: {result.stderr.strip()}"
            except (subprocess.TimeoutExpired, FileNotFoundError) as e:
                return False, f"kubectl context switch failed: {e}"

        self.active_environment = name
        self._sync_active_services()

        msg = f"Switched to '{name}'"
        if messages:
            msg += " (" + ", ".join(messages) + ")"
        return True, msg

    def get_service_in_env(self, service_name: str, env_name: str) -> Optional[ServiceConfig]:
        """Find a service in a specific environment."""
        env = self.get_environment(env_name)
        if not env:
            return None
        for service in env.services:
            if service.name == service_name:
                return service
        return None

    # =========================================================================
    # Macro Execution
    # =========================================================================

    async def run_macro(
        self,
        macro_name: str,
        on_step: Optional[Callable] = None,
    ) -> tuple[bool, str]:
        """Run a macro by name.

        Args:
            macro_name: Name of the macro to run
            on_step: Optional callback(step_index, total_steps, step) for progress

        Returns:
            Tuple of (success, message)
        """
        macro = None
        for m in self.macros:
            if m.name == macro_name:
                macro = m
                break
        if not macro:
            return False, f"Macro '{macro_name}' not found"

        total = len(macro.steps)
        for i, step in enumerate(macro.steps):
            if on_step:
                on_step(i, total, step)

            if step.context:
                # Context switch step
                success, msg = self.switch_environment(step.context)
                if not success:
                    return False, f"Step {i+1}/{total} failed: {msg}"

            elif step.service and step.action:
                # Service action step
                env_name = step.environment or self.active_environment
                service = self.get_service_in_env(step.service, env_name)
                if not service:
                    return False, f"Step {i+1}/{total}: service '{step.service}' not found in '{env_name}'"
                action = service.get_action(step.action)
                if not action:
                    return False, f"Step {i+1}/{total}: action '{step.action}' not found on '{step.service}'"

                # Temporarily switch if needed, run, switch back
                original_env = self.active_environment
                if env_name != self.active_environment:
                    success, msg = self.switch_environment(env_name)
                    if not success:
                        return False, f"Step {i+1}/{total}: {msg}"

                cwd = str(self.working_dir / service.cwd) if service.cwd else str(self.working_dir)
                try:
                    result = subprocess.run(
                        action.command, shell=True, cwd=cwd,
                        capture_output=True, text=True, timeout=300,
                        env=os.environ.copy(),
                    )
                    if result.returncode != 0:
                        # Restore environment before returning
                        if env_name != original_env:
                            self.switch_environment(original_env)
                        return False, f"Step {i+1}/{total} failed (exit {result.returncode}): {result.stderr.strip()}"
                except subprocess.TimeoutExpired:
                    if env_name != original_env:
                        self.switch_environment(original_env)
                    return False, f"Step {i+1}/{total} timed out"

                if env_name != original_env:
                    self.switch_environment(original_env)

            elif step.command:
                # Raw shell command step
                cwd = step.cwd or str(self.working_dir)
                try:
                    result = subprocess.run(
                        step.command, shell=True, cwd=cwd,
                        capture_output=True, text=True, timeout=300,
                        env=os.environ.copy(),
                    )
                    if result.returncode != 0:
                        return False, f"Step {i+1}/{total} failed (exit {result.returncode}): {result.stderr.strip()}"
                except subprocess.TimeoutExpired:
                    return False, f"Step {i+1}/{total} timed out"

        return True, f"Macro '{macro_name}' completed ({total} steps)"

    def get_macro(self, name: str) -> Optional[MacroConfig]:
        """Find a macro by name."""
        for macro in self.macros:
            if macro.name == name:
                return macro
        return None

    def get_macro_shortcuts(self) -> Dict[str, MacroConfig]:
        """Get macros that have keyboard shortcuts.

        Returns:
            Dict mapping shortcut key to MacroConfig
        """
        shortcuts = {}
        for macro in self.macros:
            key = macro.get_shortcut_key()
            if key:
                shortcuts[key] = macro
        return shortcuts

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
                if key in self.active_actions:
                    del self.active_actions[key]
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
        environment: Optional[str] = None,
    ) -> tuple[bool, str]:
        """
        Start a service with a specific action.

        Args:
            service_name: Name of the service (e.g., "Docker", "Frame")
            action_name: Name of the action (e.g., "up", "web"). Uses default if not specified.
            environment: Environment to find the service in. Uses active if not specified.

        Returns:
            Tuple of (success, message)
        """
        if environment:
            service = self.get_service_in_env(service_name, environment)
        else:
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
                current_action = self.active_actions.get(service_key, "unknown")
                return False, f"Service '{service_name}' is already running action '{current_action}' (PID: {running.pid})"
            else:
                # Process died, clean up
                del self.running_services[service_key]
                if service_key in self.active_actions:
                    del self.active_actions[service_key]

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
            self.active_actions[service_key] = action.name

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

    async def stop_service(self, service_name: str, environment: Optional[str] = None) -> tuple[bool, str]:
        """
        Stop a running service.

        Args:
            service_name: Name of the service to stop.
            environment: Environment to find the service in. Uses active if not specified.

        Returns:
            Tuple of (success, message)
        """
        if environment:
            service = self.get_service_in_env(service_name, environment)
        else:
            service = self.get_service(service_name)
        if not service:
            return False, f"Service '{service_name}' not found"

        service_key = self._get_service_key(service_name)

        if service_key not in self.running_services:
            return False, f"Service '{service_name}' is not running"

        running = self.running_services[service_key]
        pid = running.pid
        action_name = self.active_actions.get(service_key, "unknown")

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
            if service_key in self.active_actions:
                del self.active_actions[service_key]

            return True, f"Stopped '{service_name}' action '{action_name}' (PID: {pid})"

        except ProcessLookupError:
            # Already dead
            del self.running_services[service_key]
            if service_key in self.active_actions:
                del self.active_actions[service_key]
            return True, f"Service '{service_name}' was already stopped"
        except Exception as e:
            return False, f"Failed to stop: {e}"

    async def health_check(
        self,
        service_name: Optional[str] = None,
        environment: Optional[str] = None,
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
        environment: Optional[str] = None,
        lines: int = 50,
    ) -> Optional[List[str]]:
        """Get logs from a running service."""
        if environment:
            service = self.get_service_in_env(service_name, environment)
        else:
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
                active_action=self.active_actions.get(service_key),
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
                        active_action=self.active_actions.get(service_key),
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
