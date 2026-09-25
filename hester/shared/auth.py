"""
Shared auth helpers for the Lee/Hester API token.

Lee's Electron api-server persists a token at ``~/.lee/api-token`` (see
``electron/src/main/api-server.ts``). Both directions of the Lee <-> Hester link
use that same token as an HTTP bearer, so every client in this repo reads it
from here.

Paired devices hold their own tokens instead. Lee stores only each token's
sha256 in ``~/.lee/devices/<device_id>.json``; ``device_for_token`` checks a
presented token against those records.
"""

import hashlib
import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LEE_TOKEN_PATH = Path.home() / ".lee" / "api-token"
LEE_DEVICES_DIR = Path.home() / ".lee" / "devices"


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


_device_cache_lock = threading.Lock()
_device_cache: Dict[str, Tuple[Any, List[Dict[str, Any]]]] = {}


def _devices_signature(directory: Path) -> Optional[Tuple]:
    """mtime/size fingerprint of the devices dir and every record in it."""
    try:
        dir_stat = directory.stat()
        entries = []
        for p in sorted(directory.glob("dev_*.json")):
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append((p.name, st.st_mtime_ns, st.st_size))
    except OSError:
        return None
    return (dir_stat.st_mtime_ns, tuple(entries))


def _load_device_records(directory: Path) -> List[Dict[str, Any]]:
    records = []
    for p in sorted(directory.glob("dev_*.json")):
        try:
            rec = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(rec, dict) and isinstance(rec.get("token_sha256"), str) and rec.get("device_id"):
            records.append(rec)
    return records


def device_records(devices_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    """All device records, re-read when the directory or any record changes."""
    directory = Path(devices_dir) if devices_dir else LEE_DEVICES_DIR
    signature = _devices_signature(directory)
    if signature is None:
        return []
    key = str(directory)
    with _device_cache_lock:
        cached = _device_cache.get(key)
        if cached and cached[0] == signature:
            return cached[1]
    records = _load_device_records(directory)
    with _device_cache_lock:
        _device_cache[key] = (signature, records)
    return records


def device_for_token(token: Optional[str], devices_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """The paired device a token belongs to (without ``token_sha256``), or None.

    Unknown and revoked tokens both return None.
    """
    if not token:
        return None
    digest = hashlib.sha256(token.strip().encode("utf-8")).hexdigest()
    match = None
    for rec in device_records(devices_dir):
        if secrets.compare_digest(rec["token_sha256"].lower().encode("utf-8"), digest.encode("ascii")):
            match = rec
    if match is None or match.get("revoked_at"):
        return None
    return {k: v for k, v in match.items() if k != "token_sha256"}
