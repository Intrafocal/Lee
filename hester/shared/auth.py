"""
Shared auth helpers for the Lee/Hester API token.

Lee's Electron api-server persists a token at ``~/.lee/api-token`` (see
``electron/src/main/api-server.ts``). Both directions of the Lee <-> Hester link
use that same token as an HTTP bearer, so every client in this repo reads it
from here.
"""

import os
from pathlib import Path
from typing import Dict, Optional

LEE_TOKEN_PATH = Path.home() / ".lee" / "api-token"


def lee_api_token() -> Optional[str]:
    """Read the shared Lee/Hester API token, or None if it doesn't exist yet."""
    env_token = os.environ.get("LEE_API_TOKEN")
    if env_token:
        return env_token.strip() or None
    try:
        if LEE_TOKEN_PATH.exists():
            token = LEE_TOKEN_PATH.read_text().strip()
            return token or None
    except OSError:
        pass
    return None


def auth_headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Build request headers carrying the bearer token (if one is available)."""
    headers: Dict[str, str] = dict(extra or {})
    token = lee_api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def auth_disabled() -> bool:
    """True when HESTER_AUTH_DISABLED is set to a truthy value (debugging escape hatch)."""
    return os.environ.get("HESTER_AUTH_DISABLED", "").strip().lower() in ("1", "true", "yes", "on")
