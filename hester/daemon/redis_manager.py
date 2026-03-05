"""
Managed Redis - Auto-starts a redis-server when no external Redis is available.

Fallback chain:
1. Try connecting to configured redis_url (user's existing Redis)
2. Try reconnecting to an existing managed instance (port file at ~/.lee/redis/managed.port)
3. Start a new managed instance (system redis-server → bundled redis-server)
4. Return None → daemon falls back to in-memory sessions

The managed instance uses ~/.lee/redis/ for data persistence (RDB snapshots).
"""

import asyncio
import logging
import os
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger("hester.daemon.redis_manager")

# Ports to try for managed Redis (avoids conflict with user Redis on 6379)
MANAGED_PORTS = [6399, 6398, 6397]

# Data directory for managed Redis
DATA_DIR = Path.home() / ".lee" / "redis"


class ManagedRedis:
    """Manages a bundled redis-server process as a fallback when no external Redis is available."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.process: Optional[subprocess.Popen] = None
        self.managed_port: Optional[int] = None
        self.is_managed: bool = False
        self._port_file = DATA_DIR / "managed.port"
        self._pid_file = DATA_DIR / "managed.pid"

    async def acquire(self, redis_url: str) -> Optional[aioredis.Redis]:
        """
        Get a working Redis connection. Tries in order:
        1. External Redis at redis_url
        2. Existing managed instance
        3. New managed instance (system → bundled redis-server)

        Returns an aioredis.Redis client, or None (triggers in-memory fallback).
        """
        # 1. Try external Redis
        client = await self._try_connect(redis_url)
        if client:
            logger.info(f"Using existing Redis at {redis_url}")
            self.is_managed = False
            return client

        if not self.enabled:
            logger.info("Managed Redis disabled, no external Redis available")
            return None

        # 2. Try reconnecting to existing managed instance
        client = await self._try_existing_managed()
        if client:
            return client

        # 3. Start new managed instance
        return await self._start_managed()

    async def _try_connect(self, redis_url: str) -> Optional[aioredis.Redis]:
        """Try connecting to a Redis URL. Returns client if successful, None otherwise."""
        try:
            client = aioredis.from_url(
                redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
            await client.ping()
            return client
        except Exception:
            return None

    async def _try_existing_managed(self) -> Optional[aioredis.Redis]:
        """Try reconnecting to an existing managed Redis instance."""
        if not self._port_file.exists():
            return None

        try:
            port = int(self._port_file.read_text().strip())
            client = await self._try_connect(f"redis://127.0.0.1:{port}")
            if client:
                self.managed_port = port
                self.is_managed = True
                logger.info(f"Reconnected to existing managed Redis on port {port}")
                return client
        except (ValueError, OSError):
            pass

        return None

    async def _start_managed(self) -> Optional[aioredis.Redis]:
        """Start a new managed redis-server instance."""
        binary = self._find_redis_server()
        if not binary:
            logger.warning("No redis-server binary found (bundled or system)")
            return None

        # Ensure data directory exists
        DATA_DIR.mkdir(parents=True, exist_ok=True)

        # Find available port
        port = await self._find_available_port()
        if not port:
            logger.error("No available port for managed Redis")
            return None

        # Start redis-server with CLI args (no config file needed)
        cmd = [
            str(binary),
            "--bind", "127.0.0.1",
            "--port", str(port),
            "--dir", str(DATA_DIR),
            "--save", "60", "1",
            "--save", "300", "100",
            "--maxmemory", "128mb",
            "--maxmemory-policy", "allkeys-lru",
            "--daemonize", "no",
            "--logfile", str(DATA_DIR / "redis.log"),
            "--loglevel", "warning",
        ]

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,  # Don't die with parent
            )
        except OSError as e:
            logger.error(f"Failed to start redis-server: {e}")
            return None

        # Wait for Redis to become ready
        client = await self._wait_for_ready(port, timeout=5.0)
        if not client:
            logger.error("Managed redis-server failed to start")
            self._kill_process()
            return None

        self.managed_port = port
        self.is_managed = True

        # Write state files for reconnection
        self._port_file.write_text(str(port))
        self._pid_file.write_text(str(self.process.pid))

        logger.info(f"Started managed Redis on port {port} (pid {self.process.pid})")
        return client

    async def _wait_for_ready(self, port: int, timeout: float = 5.0) -> Optional[aioredis.Redis]:
        """Wait for redis-server to become ready."""
        url = f"redis://127.0.0.1:{port}"
        deadline = asyncio.get_event_loop().time() + timeout
        last_error = None

        while asyncio.get_event_loop().time() < deadline:
            # Check if process died
            if self.process and self.process.poll() is not None:
                logger.error(f"redis-server exited with code {self.process.returncode}")
                return None

            client = await self._try_connect(url)
            if client:
                return client

            await asyncio.sleep(0.1)

        logger.error(f"redis-server did not become ready within {timeout}s")
        return None

    async def _find_available_port(self) -> Optional[int]:
        """Find an available port from MANAGED_PORTS."""
        for port in MANAGED_PORTS:
            try:
                # Quick check: try to bind
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", port),
                    timeout=0.2,
                )
                # Port is in use
                writer.close()
                await writer.wait_closed()
            except (ConnectionRefusedError, asyncio.TimeoutError, OSError):
                # Port is free
                return port
        return None

    def _find_redis_server(self) -> Optional[Path]:
        """Find redis-server binary. Checks system PATH first, then bundled."""
        # 1. System redis-server
        system = shutil.which("redis-server")
        if system:
            logger.debug(f"Found system redis-server: {system}")
            return Path(system)

        # 2. Bundled binary
        resources_path = os.environ.get("HESTER_RESOURCES_PATH")
        if resources_path:
            # Dist mode: extraResources maps redis-standalone/ → redis/
            candidates = [
                Path(resources_path) / "redis" / "bin" / "redis-server",
                # Dev mode: use redis-standalone/ directly
                Path(resources_path) / "redis-standalone" / "bin" / "redis-server",
            ]
            for bundled in candidates:
                if bundled.is_file() and os.access(bundled, os.X_OK):
                    logger.debug(f"Found bundled redis-server: {bundled}")
                    return bundled

        return None

    def _kill_process(self):
        """Kill the managed redis-server process."""
        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None

    async def shutdown(self, client: Optional[aioredis.Redis]):
        """
        Clean shutdown. For managed instances, sends SHUTDOWN SAVE to persist data.
        For external Redis, just closes the connection.
        """
        if not client:
            return

        if self.is_managed:
            try:
                # SHUTDOWN SAVE ensures RDB persistence before exit
                await client.execute_command("SHUTDOWN", "SAVE")
            except Exception:
                # Connection drops on SHUTDOWN — that's expected
                pass

            # Wait for process to exit
            if self.process:
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    logger.warning("Managed Redis didn't exit cleanly, sending SIGTERM")
                    self._kill_process()

            # Clean up state files
            try:
                self._port_file.unlink(missing_ok=True)
                self._pid_file.unlink(missing_ok=True)
            except OSError:
                pass

            logger.info("Managed Redis shut down (data saved)")
        else:
            # External Redis — just close our connection
            try:
                await client.close()
            except Exception:
                pass
