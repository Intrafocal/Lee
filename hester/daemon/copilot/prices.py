"""
Lee's price table (docs/15-Usage.md §8).

``prices.yaml`` next to this file ships per-model prices (USD per million
tokens); ``usage.prices`` in Lee's config (``~/.lee/config.yaml``) overrides or
extends it by model id. Unknown models get tokens but no cost: ``cost_usd``
returns None rather than a guessed price.
"""

import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

logger = logging.getLogger("hester.daemon.copilot.prices")

PRICES_FILE = Path(__file__).with_name("prices.yaml")
PRICE_KEYS = ("input", "output", "cache_read", "cache_write")
RELOAD_S = 60.0
_DATE_SUFFIX = re.compile(r"-\d{8}$")

_lock = threading.Lock()
_cache: Dict[str, Any] = {"at": 0.0, "table": None}


def normalize_model(model: Any) -> str:
    """``models/gemini-2.5-flash`` -> ``gemini-2.5-flash``; ``claude-x-20251101`` -> ``claude-x``."""
    s = str(model or "").strip().lower()
    if s.startswith("models/"):
        s = s[len("models/"):]
    return _DATE_SUFFIX.sub("", s)


def _clean_entry(entry: Any) -> Optional[Dict[str, float]]:
    if not isinstance(entry, dict):
        return None
    out: Dict[str, float] = {}
    for key in PRICE_KEYS:
        value = entry.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            out[key] = float(value)
    if "input" not in out or "output" not in out:
        return None
    return out


def _flatten(raw: Any) -> Dict[str, Dict[str, float]]:
    """Accept both ``{provider: {model: prices}}`` and ``{model: prices}``."""
    table: Dict[str, Dict[str, float]] = {}
    if not isinstance(raw, dict):
        return table
    for key, value in raw.items():
        entry = _clean_entry(value)
        if entry is not None:
            table[normalize_model(key)] = entry
        elif isinstance(value, dict):
            for model, prices in value.items():
                entry = _clean_entry(prices)
                if entry is not None:
                    table[normalize_model(model)] = entry
    return table


def load_shipped(path: Path = PRICES_FILE) -> Dict[str, Dict[str, float]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return _flatten(yaml.safe_load(f) or {})
    except Exception as e:
        logger.warning(f"Cannot read price table {path}: {e}")
        return {}


def load_overrides() -> Dict[str, Dict[str, float]]:
    """``usage.prices`` from the user-level Lee config (never a workspace's)."""
    try:
        from ...shared.config import load_merged_config

        cfg = load_merged_config(None)
    except Exception as e:
        logger.debug(f"Lee config unreadable for prices: {e}")
        return {}
    usage = cfg.get("usage") if isinstance(cfg, dict) else None
    return _flatten((usage or {}).get("prices") if isinstance(usage, dict) else None)


def price_table(force: bool = False) -> Dict[str, Dict[str, float]]:
    """Shipped prices with config overrides on top; re-read at most once a minute."""
    now = time.monotonic()
    with _lock:
        if not force and _cache["table"] is not None and now - _cache["at"] < RELOAD_S:
            return _cache["table"]
    table = load_shipped()
    table.update(load_overrides())
    with _lock:
        _cache["table"] = table
        _cache["at"] = now
    return table


def set_table_for_tests(table: Optional[Dict[str, Dict[str, float]]]) -> None:
    with _lock:
        _cache["table"] = table
        _cache["at"] = time.monotonic() if table is not None else 0.0


def price_for(model: Any, table: Optional[Dict[str, Dict[str, float]]] = None) -> Optional[Dict[str, float]]:
    return (table if table is not None else price_table()).get(normalize_model(model))


def cost_usd(model: Any, tokens: Optional[Dict[str, Any]], table: Optional[Dict[str, Dict[str, float]]] = None) -> Optional[float]:
    """Tokens x price for one model; None when the model has no price or there are no tokens."""
    if not isinstance(tokens, dict):
        return None
    price = price_for(model, table)
    if price is None:
        return None
    total = 0.0
    counted = False
    for key in PRICE_KEYS:
        n = tokens.get(key)
        if not isinstance(n, (int, float)) or isinstance(n, bool) or n <= 0:
            continue
        rate = price.get(key, price["input"])
        total += float(n) * rate / 1_000_000.0
        counted = True
    return round(total, 9) if counted else None
