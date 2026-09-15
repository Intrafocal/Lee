"""
Lee config loading with a single, shared precedence rule.

This mirrors ``electron/src/main/config-loader.ts`` exactly:

    ~/.config/lee/config.yaml  <  ~/.lee/config.yaml  <  <workspace>/.lee/config.yaml

Later files win per key. Plain objects are deep-merged; arrays and scalars are
replaced wholesale by whichever source defines them last.

Every Python consumer of Lee config should use ``load_merged_config`` so the
daemon, the devops manager, and ``hester doctor`` all agree on what is in effect.
"""

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

logger = logging.getLogger("hester.shared.config")


def config_paths(workspace: Optional[Path] = None) -> List[Path]:
    """Candidate config paths in ascending precedence order (lowest first)."""
    home = Path.home()
    paths = [
        home / ".config" / "lee" / "config.yaml",
        home / ".lee" / "config.yaml",
    ]
    if workspace is not None:
        paths.append(Path(workspace).expanduser() / ".lee" / "config.yaml")
    return paths


def deep_merge(base: Any, overlay: Any) -> Any:
    """Deep-merge ``overlay`` onto ``base``; arrays/scalars replace, dicts merge."""
    if not isinstance(base, dict) or not isinstance(overlay, dict):
        return overlay
    result = dict(base)
    for key, overlay_val in overlay.items():
        base_val = base.get(key)
        if isinstance(base_val, dict) and isinstance(overlay_val, dict):
            result[key] = deep_merge(base_val, overlay_val)
        else:
            result[key] = overlay_val
    return result


def _read_yaml(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path) as handle:
            return yaml.safe_load(handle) or {}
    except FileNotFoundError:
        return None
    except Exception as exc:  # malformed YAML, permissions, ...
        logger.warning(f"Failed to read config {path}: {exc}")
        return None


def load_merged_config_with_sources(
    workspace: Optional[Path] = None,
) -> Tuple[Dict[str, Any], List[Path]]:
    """Load and merge all config files. Returns (config, sources_found_low_to_high)."""
    merged: Dict[str, Any] = {}
    sources: List[Path] = []
    for path in config_paths(workspace):
        parsed = _read_yaml(path)
        if parsed is not None:
            merged = deep_merge(merged, parsed)
            sources.append(path)
    return merged, sources


def load_merged_config(workspace: Optional[Path] = None) -> Dict[str, Any]:
    """Load and merge all config files for a workspace (workspace wins per key)."""
    config, _ = load_merged_config_with_sources(workspace)
    return config


def find_key_source(key_path: str, workspace: Optional[Path] = None) -> Optional[Path]:
    """
    Which config file supplies the effective value for a dotted key path
    (e.g. ``hester.google_api_key``)? Returns the highest-precedence file
    that defines it, or None.
    """
    parts = key_path.split(".")
    winner: Optional[Path] = None
    for path in config_paths(workspace):
        parsed = _read_yaml(path)
        if parsed is None:
            continue
        node: Any = parsed
        for part in parts:
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                node = None
                break
        if node is not None:
            winner = path
    return winner


def default_workspace() -> Path:
    """The workspace Hester should assume when none is passed explicitly."""
    env_dir = os.environ.get("HESTER_WORKING_DIRECTORY")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.cwd()
