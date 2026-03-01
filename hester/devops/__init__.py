"""
Hester DevOps - Service management TUI and tools.

Provides a terminal-based dashboard for managing local development services
defined in lee/config.yaml. Features:
- Real-time service status monitoring
- Start/stop services with live log streaming
- Health checks
- Docker container management
"""

from .tui import DevOpsTUI, run_devops_tui
from .manager import ServiceManager

__all__ = [
    "DevOpsTUI",
    "run_devops_tui",
    "ServiceManager",
]
