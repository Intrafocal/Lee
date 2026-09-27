"""
Usage aggregation (docs/15-Usage.md §5): tokens, spend and limits from Lee's
event log, read the same way ``metrics.py`` reads it.

Sources:

- ``agent.usage`` (Lee main, per agent turn): Claude and Pi sessions;
- ``model.call`` with a ``usage`` object (Hester): cloud (Gemini, Claude
  delegates) and local (Ollama);
- ``limits.snapshot`` (Lee main, on change): the Claude subscription windows.

The §2 rule holds everywhere here: **spend** is ``billed`` + ``estimate`` in
dollars; ``subscription`` usage is reported as tokens only (its list-price
equivalent is never summed into spend, nor returned); ``local`` is tokens and
compute time. ``shown_tokens`` = input + output + cache_write (cache reads are
left out: they dwarf everything else and cost little).
"""

import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .event_reader import iso, parse_ts, read_events

RANGES = ("today", "week", "month")
RANGE_DAYS = {"today": 1, "week": 7, "month": 30}
SOURCES = ("claude", "pi", "hester_cloud", "hester_local")
BASES = ("billed", "subscription", "estimate", "local")
SPEND_BASES = ("billed", "estimate")
# A task's combined basis when turns differ: a subscription session's first
# turns can be priced as estimates before its status line arrives (§3.2).
BASIS_PRECEDENCE = ("subscription", "billed", "estimate", "local")
TOKEN_KEYS = ("input", "output", "cache_read", "cache_write", "thinking")
LIMITS_LOOKBACK = timedelta(days=8)
USAGE_TYPES = ("agent.usage", "model.call", "limits.snapshot")
MAX_TOP_TASKS = 10


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _num(v: Any) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 0.0


def shown_tokens(tokens: Optional[Dict[str, Any]]) -> int:
    t = tokens or {}
    return int(_num(t.get("input")) + _num(t.get("output")) + _num(t.get("cache_write")))


def add_tokens(dst: Dict[str, int], src: Optional[Dict[str, Any]]) -> Dict[str, int]:
    for key in TOKEN_KEYS:
        n = _num((src or {}).get(key))
        if n:
            dst[key] = int(dst.get(key, 0) + n)
    return dst


def _round_usd(v: float) -> float:
    return round(v, 6)


def usage_items(by_model: Any) -> List[Dict[str, Any]]:
    """The valid §4.1 usage objects of an ``agent.usage`` ``by_model`` list."""
    if not isinstance(by_model, list):
        return []
    return [u for u in by_model if isinstance(u, dict) and (isinstance(u.get("tokens"), dict) or "cost_usd" in u)]


def basis_of(usage: Dict[str, Any]) -> str:
    b = usage.get("cost_basis")
    return b if b in BASES else "estimate"


def spend_of(usage: Dict[str, Any]) -> float:
    """Dollars that count as spend (billed or estimate); 0 for subscription and local."""
    return _num(usage.get("cost_usd")) if basis_of(usage) in SPEND_BASES else 0.0


# ---------------------------------------------------------------------------
# Per agent session / task (AgentUsage, electron/src/shared/cockpit.ts)
# ---------------------------------------------------------------------------


def accumulate(acc: Optional[Dict[str, Any]], by_model: Any) -> Optional[Dict[str, Any]]:
    """
    Add an ``agent.usage`` event's ``by_model`` to a running ``AgentUsage``
    (``tokens``, ``shown_tokens``, ``cost_basis``, ``cost_usd`` for billed or
    estimate only, ``by_model``). Returns ``acc`` unchanged when there is
    nothing to add.
    """
    items = usage_items(by_model)
    if not items:
        return acc
    cur = dict(acc) if isinstance(acc, dict) else {}
    tokens = dict(cur.get("tokens") or {})
    bases = set(cur.get("bases") or ([cur["cost_basis"]] if cur.get("cost_basis") in BASES else []))
    spend = _num(cur.get("spend_usd") if "spend_usd" in cur else cur.get("cost_usd"))
    models: Dict[str, Dict[str, Any]] = {}
    for m in cur.get("by_model") or []:
        if isinstance(m, dict) and m.get("model"):
            models[str(m["model"])] = {"model": str(m["model"]), "tokens": dict(m.get("tokens") or {}),
                                       **({"cost_usd": m["cost_usd"]} if "cost_usd" in m else {})}
    for u in items:
        add_tokens(tokens, u.get("tokens"))
        basis = basis_of(u)
        bases.add(basis)
        spend += spend_of(u)
        name = str(u.get("model") or "unknown")
        entry = models.setdefault(name, {"model": name, "tokens": {}})
        add_tokens(entry["tokens"], u.get("tokens"))
        if basis in SPEND_BASES and "cost_usd" in u:
            entry["cost_usd"] = _round_usd(_num(entry.get("cost_usd")) + _num(u.get("cost_usd")))
    basis = next(b for b in BASIS_PRECEDENCE if b in bases) if bases else "estimate"
    out: Dict[str, Any] = {
        "tokens": tokens,
        "shown_tokens": shown_tokens(tokens),
        "cost_basis": basis,
        "bases": sorted(bases),
        "spend_usd": _round_usd(spend),
    }
    if basis in SPEND_BASES:
        out["cost_usd"] = _round_usd(spend)
    out["by_model"] = sorted(models.values(), key=lambda m: m["model"])
    return out


def merge_usage(a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Two running usages as one (the follower folding an automatic task into another)."""
    if not isinstance(b, dict):
        return a
    if not isinstance(a, dict):
        return b
    items = []
    for m in b.get("by_model") or []:
        if not isinstance(m, dict):
            continue
        item = {"model": m.get("model"), "tokens": m.get("tokens") or {}, "cost_basis": b.get("cost_basis")}
        if "cost_usd" in m:
            # a per-model cost only exists for spend bases
            spend_basis = next((x for x in b.get("bases") or [] if x in SPEND_BASES), "estimate")
            item["cost_usd"], item["cost_basis"] = m["cost_usd"], spend_basis
        items.append(item)
    merged = accumulate(a, items) or a
    merged["bases"] = sorted(set(merged.get("bases") or []) | set(b.get("bases") or []))
    return merged


# ---------------------------------------------------------------------------
# Range aggregation (GET /cockpit/usage)
# ---------------------------------------------------------------------------


def range_bounds(rng: str, now: datetime) -> tuple:
    """``(start, end)`` in UTC: from local midnight ``RANGE_DAYS - 1`` days ago to now."""
    local_now = now.astimezone()
    midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = midnight - timedelta(days=RANGE_DAYS[rng] - 1)
    return start.astimezone(timezone.utc), now


def _bucket() -> Dict[str, Any]:
    return {
        "tokens": {}, "shown_tokens": 0, "spend_usd": 0.0,
        "subscription_tokens": 0, "local_tokens": 0, "local_ms": 0.0, "count": 0,
        "unpriced_tokens": 0,
    }


def _add(bucket: Dict[str, Any], usage: Dict[str, Any]) -> None:
    tokens = usage.get("tokens") if isinstance(usage.get("tokens"), dict) else {}
    add_tokens(bucket["tokens"], tokens)
    shown = shown_tokens(tokens)
    bucket["shown_tokens"] += shown
    basis = basis_of(usage)
    if basis in SPEND_BASES:
        if "cost_usd" in usage:
            bucket["spend_usd"] += _num(usage.get("cost_usd"))
        else:
            bucket["unpriced_tokens"] += shown
    elif basis == "subscription":
        bucket["subscription_tokens"] += shown
    elif basis == "local":
        bucket["local_tokens"] += shown
        bucket["local_ms"] += _num(usage.get("duration_ms"))


def _finish(bucket: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(bucket)
    out["spend_usd"] = _round_usd(out["spend_usd"])
    out["local_ms"] = round(out["local_ms"], 1)
    return out


def _combine(buckets: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    total = _bucket()
    for b in buckets:
        add_tokens(total["tokens"], b["tokens"])
        for key in ("shown_tokens", "spend_usd", "subscription_tokens", "local_tokens", "local_ms", "count", "unpriced_tokens"):
            total[key] += b[key]
    return total


def agent_source(data: Dict[str, Any]) -> str:
    return "pi" if str(data.get("provider") or "").lower() == "pi" else "claude"


def latest_limits(events: List[Dict[str, Any]], now: datetime) -> Optional[Dict[str, Any]]:
    """The newest ``limits.snapshot`` as ``UsageLimits`` plus ``age_s``; None without one."""
    snaps = [e for e in events if e.get("type") == "limits.snapshot"]
    if not snaps:
        return None
    ev = max(snaps, key=lambda e: e["_ts"])
    d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
    out: Dict[str, Any] = {}
    for key in ("five_hour", "seven_day"):
        w = d.get(key)
        if isinstance(w, dict) and isinstance(w.get("used_pct"), (int, float)) and not isinstance(w.get("used_pct"), bool):
            out[key] = {"used_pct": w["used_pct"], "resets_at": w.get("resets_at") if isinstance(w.get("resets_at"), str) else None}
    if not out:
        return None
    out["as_of"] = iso(ev["_ts"])
    out["age_s"] = max(0, int((now - ev["_ts"]).total_seconds()))
    return out


def _filter_workspace(events: List[Dict[str, Any]], workspace: Optional[str]) -> List[Dict[str, Any]]:
    if not workspace:
        return events
    ws = os.path.normpath(workspace)
    return [e for e in events if not e.get("workspace") or os.path.normpath(e["workspace"]) == ws]


def compute_usage(
    events: List[Dict[str, Any]],
    rng: str,
    now: datetime,
    tasks: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    start, end = range_bounds(rng, now)
    by_source = {s: _bucket() for s in SOURCES}
    by_day: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(lambda: {s: _bucket() for s in SOURCES})
    hester = {k: {"calls": 0, "cloud_calls": 0, "local_calls": 0, **_bucket()} for k in ("user", "automatic")}
    unknown_trigger = 0
    session_totals: Dict[str, Dict[str, Any]] = defaultdict(_bucket)

    for ev in events:
        ts = ev["_ts"]
        if ts < start or ts >= end + timedelta(seconds=1):
            continue
        t = ev.get("type")
        d = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        day = ts.astimezone().strftime("%Y-%m-%d")
        if t == "agent.usage":
            src = agent_source(d)
            items = usage_items(d.get("by_model"))
            if not items:
                continue
            for u in items:
                _add(by_source[src], u)
                _add(by_day[day][src], u)
                sid = d.get("session_id")
                if isinstance(sid, str) and sid:
                    _add(session_totals[sid], u)
            by_source[src]["count"] += 1
            by_day[day][src]["count"] += 1
        elif t == "model.call":
            kind = (d.get("trigger") or {}).get("kind") if isinstance(d.get("trigger"), dict) else None
            if kind != "user":
                unknown_trigger += 1 if kind != "automatic" else 0
                kind = "automatic"  # unknown counts as automatic, as in C1/C2
            local = d.get("location") == "local"
            h = hester[kind]
            h["calls"] += 1
            h["local_calls" if local else "cloud_calls"] += 1
            usage = d.get("usage") if isinstance(d.get("usage"), dict) else None
            src = "hester_local" if local else "hester_cloud"
            by_source[src]["count"] += 1
            by_day[day][src]["count"] += 1
            if usage is None:
                continue
            _add(h, usage)
            _add(by_source[src], usage)
            _add(by_day[day][src], usage)

    totals = _finish(_combine(by_source.values()))
    totals["by_source"] = {s: _finish(b) for s, b in by_source.items()}

    days = []
    cursor = start.astimezone()
    while cursor <= end.astimezone():
        key = cursor.strftime("%Y-%m-%d")
        buckets = by_day.get(key) or {s: _bucket() for s in SOURCES}
        row = _finish(_combine(buckets.values()))
        row["day"] = key
        row["by_source"] = {s: _finish(b) for s, b in buckets.items()}
        days.append(row)
        cursor += timedelta(days=1)

    top: List[Dict[str, Any]] = []
    if tasks:
        from .metrics import _task_session_map

        per_task: Dict[str, Dict[str, Any]] = {}
        session_task = _task_session_map(tasks)
        for sid, bucket in session_totals.items():
            task = session_task.get(sid)
            if task is None:
                continue
            row = per_task.setdefault(task["id"], {
                "task_id": task["id"], "title": task.get("title"), "workspace": task.get("workspace"),
                "status": task.get("status"), **_bucket(),
            })
            for key in ("shown_tokens", "spend_usd", "subscription_tokens", "local_tokens", "unpriced_tokens"):
                row[key] += bucket[key]
            add_tokens(row["tokens"], bucket["tokens"])
        rows = sorted(per_task.values(), key=lambda r: (-r["spend_usd"], -r["shown_tokens"], r["task_id"]))
        for r in rows[:MAX_TOP_TASKS]:
            r = _finish(r)
            r.pop("count", None)
            r.pop("local_ms", None)
            top.append(r)

    return {
        "range": rng,
        "from": iso(start),
        "to": iso(end),
        "limits": latest_limits(events, now),
        "totals": totals,
        "by_day": days,
        "hester": {
            "user": _finish(hester["user"]),
            "automatic": _finish(hester["automatic"]),
            "unknown_trigger_calls": unknown_trigger,
        },
        "top_tasks": top,
    }


def run(
    rng: str = "today",
    workspace: Optional[str] = None,
    events_dir: Optional[Path] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Read the log and aggregate. Tasks come from ``workspace``, else every workspace named by an event."""
    if rng not in RANGES:
        raise ValueError(f"range must be one of {', '.join(RANGES)}")
    now = now or datetime.now(timezone.utc)
    start, _ = range_bounds(rng, now)
    since = min(start, now - LIMITS_LOOKBACK)
    events = read_events(since=since, until=now + timedelta(seconds=1), directory=events_dir, types=USAGE_TYPES)
    limits = latest_limits(events, now)  # account-wide: never filtered by workspace
    events = _filter_workspace(events, workspace)
    if workspace:
        task_ws = [workspace]
    else:
        task_ws = sorted({e["workspace"] for e in events if isinstance(e.get("workspace"), str) and e["workspace"]})
    from .metrics import load_tasks

    data = compute_usage(events, rng, now, tasks=load_tasks(task_ws))
    data["limits"] = limits
    data["workspace"] = os.path.normpath(workspace) if workspace else None
    return data
