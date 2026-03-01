"""
Orchestration telemetry tools for agent communication with daemon.

Provides functions for CLI commands to send telemetry data to the
Hester daemon for real-time workstream orchestration.
"""

import json
import logging
import os
from typing import Dict, Any, Optional, List

import aiohttp

from ..settings import HesterDaemonSettings

logger = logging.getLogger("hester.daemon.tools.orchestrate")


def _get_daemon_url() -> str:
    """Get the daemon URL from settings."""
    settings = HesterDaemonSettings()
    return f"http://{settings.host}:{settings.port}"


async def send_telemetry(
    action: str,
    session_id: str,
    agent_type: Optional[str] = None,
    status: Optional[str] = None,
    focus: Optional[str] = None,
    active_file: Optional[str] = None,
    tool: Optional[str] = None,
    progress: Optional[int] = None,
    workstream_id: Optional[str] = None,
    result: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Send telemetry data to the Hester daemon.

    Args:
        action: Telemetry action (register, update, complete)
        session_id: Agent session identifier
        agent_type: Type of agent (required for register)
        status: Agent status
        focus: Current focus/task description
        active_file: Currently active file path
        tool: Current tool name
        progress: Progress percentage (0-100)
        workstream_id: Associated workstream ID
        result: Final result message (for complete)
        metadata: Additional metadata dict

    Returns:
        Dict with success status and any response data
    """
    daemon_url = _get_daemon_url()
    endpoint = f"{daemon_url}/orchestrate/telemetry"

    # Build request payload
    payload = {
        "action": action,
        "session_id": session_id,
    }

    # Add optional fields if provided
    if agent_type is not None:
        payload["agent_type"] = agent_type
    if status is not None:
        payload["status"] = status
    if focus is not None:
        payload["focus"] = focus
    if active_file is not None:
        payload["active_file"] = active_file
    if tool is not None:
        payload["tool"] = tool
    if progress is not None:
        payload["progress"] = progress
    if workstream_id is not None:
        payload["workstream_id"] = workstream_id
    if result is not None:
        payload["result"] = result
    if metadata is not None:
        payload["metadata"] = metadata

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                endpoint,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    return data
                else:
                    error_text = await response.text()
                    logger.error(f"Daemon telemetry error {response.status}: {error_text}")
                    return {
                        "success": False,
                        "error": f"HTTP {response.status}: {error_text}",
                        "session_id": session_id
                    }

    except aiohttp.ClientError as e:
        logger.error(f"Failed to connect to daemon at {endpoint}: {e}")
        return {
            "success": False,
            "error": f"Connection failed: {e}",
            "session_id": session_id
        }
    except Exception as e:
        logger.error(f"Unexpected error sending telemetry: {e}")
        return {
            "success": False,
            "error": f"Unexpected error: {e}",
            "session_id": session_id
        }


async def get_agent_status(session_id: str) -> Dict[str, Any]:
    """
    Get status of an agent session from the daemon.

    Args:
        session_id: Agent session identifier

    Returns:
        Dict with success status and agent data
    """
    daemon_url = _get_daemon_url()
    endpoint = f"{daemon_url}/orchestrate/sessions/{session_id}"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                endpoint,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    return {
                        "success": True,
                        "data": data,
                        "session_id": session_id
                    }
                elif response.status == 404:
                    return {
                        "success": False,
                        "error": "Session not found",
                        "session_id": session_id
                    }
                else:
                    error_text = await response.text()
                    logger.error(f"Daemon status error {response.status}: {error_text}")
                    return {
                        "success": False,
                        "error": f"HTTP {response.status}: {error_text}",
                        "session_id": session_id
                    }

    except aiohttp.ClientError as e:
        logger.error(f"Failed to connect to daemon at {endpoint}: {e}")
        return {
            "success": False,
            "error": f"Connection failed: {e}",
            "session_id": session_id
        }
    except Exception as e:
        logger.error(f"Unexpected error getting agent status: {e}")
        return {
            "success": False,
            "error": f"Unexpected error: {e}",
            "session_id": session_id
        }


async def list_agent_sessions(
    workstream_id: Optional[str] = None,
    agent_type: Optional[str] = None,
    status: Optional[str] = None
) -> Dict[str, Any]:
    """
    List active agent sessions from the daemon.

    Args:
        workstream_id: Filter by workstream ID
        agent_type: Filter by agent type
        status: Filter by agent status

    Returns:
        Dict with success status and list of session data
    """
    daemon_url = _get_daemon_url()
    endpoint = f"{daemon_url}/orchestrate/sessions"

    # Build query parameters
    params = {}
    if workstream_id is not None:
        params["workstream_id"] = workstream_id
    if agent_type is not None:
        params["agent_type"] = agent_type
    if status is not None:
        params["status"] = status

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                endpoint,
                params=params,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    return {
                        "success": True,
                        "data": data.get("sessions", []),
                        "count": data.get("count", 0)
                    }
                else:
                    error_text = await response.text()
                    logger.error(f"Daemon list error {response.status}: {error_text}")
                    return {
                        "success": False,
                        "error": f"HTTP {response.status}: {error_text}",
                        "data": []
                    }

    except aiohttp.ClientError as e:
        logger.error(f"Failed to connect to daemon at {endpoint}: {e}")
        return {
            "success": False,
            "error": f"Connection failed: {e}",
            "data": []
        }
    except Exception as e:
        logger.error(f"Unexpected error listing agent sessions: {e}")
        return {
            "success": False,
            "error": f"Unexpected error: {e}",
            "data": []
        }


# Utility functions for integration testing

async def health_check() -> Dict[str, Any]:
    """
    Check if the daemon orchestration endpoints are available.

    Returns:
        Dict with health status information
    """
    daemon_url = _get_daemon_url()
    endpoint = f"{daemon_url}/health"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                endpoint,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    return {
                        "daemon_available": True,
                        "daemon_health": data,
                        "orchestration_ready": True  # Assume ready if daemon is healthy
                    }
                else:
                    return {
                        "daemon_available": False,
                        "daemon_health": None,
                        "orchestration_ready": False,
                        "error": f"HTTP {response.status}"
                    }

    except aiohttp.ClientError as e:
        return {
            "daemon_available": False,
            "daemon_health": None,
            "orchestration_ready": False,
            "error": f"Connection failed: {e}"
        }
    except Exception as e:
        return {
            "daemon_available": False,
            "daemon_health": None,
            "orchestration_ready": False,
            "error": f"Unexpected error: {e}"
        }


async def clear_all_sessions() -> Dict[str, Any]:
    """
    Clear all agent sessions (useful for testing/cleanup).

    This is a convenience function that lists all sessions and
    sends complete commands for each one.

    Returns:
        Dict with cleanup results
    """
    # First, get all active sessions
    sessions_result = await list_agent_sessions()
    if not sessions_result["success"]:
        return sessions_result

    sessions = sessions_result["data"]
    if not sessions:
        return {
            "success": True,
            "message": "No active sessions to clear",
            "cleared_count": 0
        }

    # Complete each active session
    cleared_count = 0
    errors = []

    for session in sessions:
        session_id = session["session_id"]
        result = await send_telemetry(
            action="complete",
            session_id=session_id,
            status="cancelled",
            result="Cleared by cleanup"
        )

        if result["success"]:
            cleared_count += 1
        else:
            errors.append(f"Failed to clear {session_id}: {result.get('error')}")

    return {
        "success": len(errors) == 0,
        "message": f"Cleared {cleared_count} sessions",
        "cleared_count": cleared_count,
        "errors": errors if errors else None
    }