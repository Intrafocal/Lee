"""
GOALS.md metrics computed from Lee's event log alone (contract section 2.5).

Deterministic; no model. Every metric covers the window ``[from, to)``.
Lookbacks (repeated approvals: previous 24 h) and lookaheads (capture
pickup: 14 days) read outside the window where the formula needs it.
"""

import json
import os
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .event_reader import iso, read_events

FORMULA_VERSION = 1

UNAVAILABLE = ["background_leverage.accepted", "toil_load.command_repeats"]

LOOKBACK = timedelta(hours=24)
PICKUP_WINDOW = timedelta(days=14)
RETURN_MIN_AWAY_MS = 30 * 60 * 1000
PEEK_MIN_MS = 2000

CREATIVE_TAB_TYPES = {"editor", "files"}
TERMINAL_TAB_TYPES = {"terminal", "claude", "agent", "hester"}
DEVICE_CREATIVE = {"capture", "decide", "reply", "launch", "start_work"}
LATENCY_KINDS = {"approval", "waiting", "decision", "blocker"}
LATENCY_RESOLUTIONS = {"reply", "answered_in_tab"}


def _ms(delta: timedelta) -> float:
    return delta.total_seconds() * 1000.0


def _median(values: List[float]) -> Optional[float]:
    return float(statistics.median(values)) if values else None


def _round(value: Optional[float], digits: int = 3) -> Optional[float]:
    return None if value is None else round(value, digits)


def _ctx(ev: Dict[str, Any]) -> Dict[str, Any]:
    c = ev.get("ctx")
    return c if isinstance(c, dict) else {}


def _data(ev: Dict[str, Any]) -> Dict[str, Any]:
    d = ev.get("data")
    return d if isinstance(d, dict) else {}


def _in(ev: Dict[str, Any], start: datetime, end: datetime) -> bool:
    return start <= ev["_ts"] < end


def _is_creative_tab(d: Dict[str, Any]) -> bool:
    return d.get("tab_type") in CREATIVE_TAB_TYPES or bool(d.get("file_path"))


def _is_terminal_tab(d: Dict[str, Any]) -> bool:
    return not _is_creative_tab(d) and (d.get("tab_type") in TERMINAL_TAB_TYPES or d.get("pty_id") is not None)


# ---------------------------------------------------------------------------
# Derived structures
# ---------------------------------------------------------------------------


def active_hours(events: List[Dict[str, Any]], start: datetime, end: datetime) -> Set[datetime]:
    """Hour buckets in which some event had ctx.at_machine and some input.counts occurred."""
    at_machine: Set[datetime] = set()
    inputs: Set[datetime] = set()
    for ev in events:
        if not _in(ev, start, end):
            continue
        bucket = ev["_ts"].replace(minute=0, second=0, microsecond=0)
        if _ctx(ev).get("at_machine") is True:
            at_machine.add(bucket)
        if ev.get("type") == "input.counts":
            inputs.add(bucket)
    return at_machine & inputs


class BusyIndex:
    """Agent busy intervals per pty: prompt (or first tool pre) until waiting/turn_end."""

    def __init__(self, events: List[Dict[str, Any]], end: datetime):
        self.intervals: Dict[int, List[Tuple[datetime, datetime]]] = defaultdict(list)
        session_pty: Dict[str, int] = {}
        busy_since: Dict[int, datetime] = {}
        for ev in events:
            t = ev.get("type") or ""
            if not t.startswith("agent."):
                continue
            d = _data(ev)
            sid = d.get("session_id")
            pty = d.get("pty_id")
            if isinstance(pty, int) and sid:
                session_pty[sid] = pty
            elif sid in session_pty:
                pty = session_pty[sid]
            if not isinstance(pty, int):
                continue
            ts = ev["_ts"]
            if t == "agent.prompt" or (t == "agent.tool" and d.get("phase") == "pre"):
                busy_since.setdefault(pty, ts)
            elif t in ("agent.waiting", "agent.turn_end", "agent.session_end", "agent.exit"):
                started = busy_since.pop(pty, None)
                if started is not None:
                    self.intervals[pty].append((started, ts))
            elif t == "agent.tool" and d.get("phase") == "post":
                busy_since.setdefault(pty, ts)
        for pty, started in busy_since.items():
            self.intervals[pty].append((started, end))

    def busy_at(self, pty: Optional[int], ts: datetime) -> bool:
        if not isinstance(pty, int):
            return False
        return any(a <= ts < b for a, b in self.intervals.get(pty, ()))

    @property
    def ptys(self) -> Set[int]:
        return set(self.intervals)


def focus_intervals(events: List[Dict[str, Any]], end: datetime) -> List[Dict[str, Any]]:
    """tab.focus intervals per window: until the next tab.focus or window.focus false."""
    out: List[Dict[str, Any]] = []
    open_by_window: Dict[Any, Dict[str, Any]] = {}

    def close(window: Any, ts: datetime) -> None:
        cur = open_by_window.pop(window, None)
        if cur is not None:
            cur["end"] = ts
            out.append(cur)

    for ev in events:
        t = ev.get("type")
        window = ev.get("window_id")
        if t == "tab.focus":
            close(window, ev["_ts"])
            d = _data(ev)
            open_by_window[window] = {
                "window_id": window, "tab_id": d.get("tab_id"), "pty_id": d.get("pty_id"),
                "tab_type": d.get("tab_type"), "file_path": d.get("file_path"), "start": ev["_ts"],
            }
        elif t == "window.focus" and _data(ev).get("focused") is False:
            close(window, ev["_ts"])
        elif t == "app.quit":
            for w in list(open_by_window):
                close(w, ev["_ts"])
    for w in list(open_by_window):
        close(w, end)
    return out


def _keys_during(inputs: List[Dict[str, Any]], window: Any, tab_id: Any, start: datetime, end: datetime) -> int:
    total = 0
    for ev in inputs:
        if ev.get("window_id") != window:
            continue
        d = _data(ev)
        if d.get("tab_id") != tab_id:
            continue
        ts = ev["_ts"]
        span = timedelta(milliseconds=d.get("span_ms") or 0)
        if ts > start and ts - span < end:
            total += int(d.get("keys") or 0)
    return total


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def peeks(events, start, end, busy: BusyIndex) -> List[Dict[str, Any]]:
    inputs = [e for e in events if e.get("type") == "input.counts"]
    found = []
    for iv in focus_intervals(events, end):
        if not (start <= iv["start"] < end):
            continue
        if _ms(iv["end"] - iv["start"]) < PEEK_MIN_MS:
            continue
        if not busy.busy_at(iv["pty_id"], iv["start"]):
            continue
        if _keys_during(inputs, iv["window_id"], iv["tab_id"], iv["start"], iv["end"]) > 0:
            continue
        found.append(iv)
    return found


def repeated_approvals(events, start, end) -> int:
    approved: Dict[str, List[datetime]] = defaultdict(list)
    count = 0
    for ev in events:
        if ev.get("type") != "attention.reply":
            continue
        d = _data(ev)
        sig = d.get("tool_signature")
        if d.get("action") != "approve" or not sig:
            continue
        ts = ev["_ts"]
        if _in(ev, start, end) and any(ts - LOOKBACK <= prev < ts for prev in approved[sig]):
            count += 1
        approved[sig].append(ts)
    return count


def compute_metrics(
    events: List[Dict[str, Any]],
    start: datetime,
    end: datetime,
) -> Dict[str, Any]:
    """All section 2.5 metrics over ``[start, end)``.

    ``events`` must be sorted by ts and may extend before ``start`` (24 h
    lookback) and after ``end`` (14-day capture pickup lookahead).
    """
    window = [e for e in events if _in(e, start, end)]
    hours = active_hours(window, start, end)
    n_hours = len(hours)
    busy = BusyIndex([e for e in events if e["_ts"] < end], end)

    def per_hour(n: float) -> Optional[float]:
        return _round(n / n_hours) if n_hours else None

    # peek_rate
    peek_list = peeks(events, start, end, busy)

    # toil_load
    counts = defaultdict(int)
    for ev in window:
        counts[ev.get("type")] += 1
    repeats = repeated_approvals(events, start, end)
    toil_parts = {
        "ui_ceremony": counts["ui.ceremony"],
        "snooze": counts["attention.snooze"],
        "dismiss": counts["attention.dismiss"],
        "handoff_start": counts["handoff.start"],
        "repeated_approvals": repeats,
    }
    toil_total = sum(toil_parts.values())

    # creative_share (proxy)
    creative = 0.0
    managing = 0.0
    for ev in window:
        t = ev.get("type")
        d = _data(ev)
        if t == "input.counts":
            if _is_creative_tab(d):
                creative += int(d.get("keys") or 0) + int(d.get("clicks") or 0)
            elif _is_terminal_tab(d) and busy.busy_at(d.get("pty_id"), ev["_ts"]):
                managing += int(d.get("keys") or 0)
        elif t == "attention.reply":
            if d.get("action") == "text":
                creative += 1
            elif d.get("action") in ("approve", "deny"):
                managing += 1
        elif t == "capture":
            creative += 1
    managing += len(peek_list)
    creative_share = _round(creative / (creative + managing)) if (creative + managing) else None

    # catch_up_time
    steering = []
    for ev in window:
        t = ev.get("type")
        d = _data(ev)
        if t in ("attention.reply", "agent.prompt", "focus.start", "capture"):
            steering.append(ev["_ts"])
        elif t == "input.counts" and int(d.get("keys") or 0) > 0 and _is_creative_tab(d):
            steering.append(ev["_ts"])
    catch_ups = []
    for ev in window:
        if ev.get("type") != "presence.change":
            continue
        d = _data(ev)
        if (d.get("from") or {}).get("at_machine") is False and (d.get("to") or {}).get("at_machine") is True:
            if (d.get("away_ms") or 0) >= RETURN_MIN_AWAY_MS:
                nxt = next((s for s in steering if s >= ev["_ts"]), None)
                if nxt is not None:
                    catch_ups.append(_ms(nxt - ev["_ts"]))

    # focus_interruptions
    focus_ends = [e for e in window if e.get("type") == "focus.end"]
    interruptions = [int(_data(e).get("interruptions") or 0) for e in focus_ends]
    surfaced_by_session: Dict[str, int] = defaultdict(int)
    for ev in window:
        d = _data(ev)
        if ev.get("type") == "attention.escalate" and d.get("surfaced") and d.get("during_focus"):
            sid = _ctx(ev).get("focus_session_id")
            if sid:
                surfaced_by_session[sid] += 1
    mismatches = sum(
        1 for e in focus_ends
        if surfaced_by_session.get(_data(e).get("session_id"), 0) != int(_data(e).get("interruptions") or 0)
    )

    # background_leverage (busy time only)
    busy_ms = sum(float(_data(e).get("busy_ms") or 0) for e in window if e.get("type") == "agent.turn_end")
    focus_ms = sum(float(_data(e).get("duration_ms") or 0) for e in focus_ends)
    focus_hours = focus_ms / 3_600_000.0

    # device_creative_share
    per_device: Dict[str, Dict[str, float]] = defaultdict(lambda: {"creative": 0, "managing": 0})
    for ev in window:
        d = _data(ev)
        if ev.get("type") == "device.request":
            key = str(d.get("device_id") or "unknown")
            bucket = "creative" if d.get("category") in DEVICE_CREATIVE else "managing"
            per_device[key][bucket] += 1
        elif ev.get("type") == "device.views":
            key = str(d.get("device_id") or "unknown")
            per_device[key]["managing"] += 1
    device_share: Dict[str, Any] = {}
    tot_c = tot_m = 0.0
    for dev, c in sorted(per_device.items()):
        tot_c += c["creative"]
        tot_m += c["managing"]
        total = c["creative"] + c["managing"]
        device_share[dev] = _round(c["creative"] / total) if total else None
    overall_device = _round(tot_c / (tot_c + tot_m)) if (tot_c + tot_m) else None

    # capture_pickup
    triaged: Dict[str, List[datetime]] = defaultdict(list)
    for ev in events:
        if ev.get("type") == "someday.triage":
            sid = _data(ev).get("someday_id")
            if sid:
                triaged[sid].append(ev["_ts"])
    eligible = picked = 0
    for ev in window:
        if ev.get("type") != "capture":
            continue
        actor = ev.get("actor") or {}
        away = _ctx(ev).get("at_machine") is False or actor.get("surface") == "device"
        if not away or ev["_ts"] > end - PICKUP_WINDOW:
            continue
        eligible += 1
        sid = _data(ev).get("someday_id")
        if sid and any(ev["_ts"] <= t <= ev["_ts"] + PICKUP_WINDOW for t in triaged.get(sid, ())):
            picked += 1

    # attention_latency
    latencies = [
        float(_data(e).get("latency_ms"))
        for e in window
        if e.get("type") == "attention.resolve"
        and _data(e).get("kind") in LATENCY_KINDS
        and _data(e).get("resolution") in LATENCY_RESOLUTIONS
        and isinstance(_data(e).get("latency_ms"), (int, float))
    ]

    # C1, C2, C3
    c1 = c2 = c3 = 0
    for ev in window:
        t = ev.get("type")
        d = _data(ev)
        if t == "model.call":
            automatic = (d.get("trigger") or {}).get("kind") != "user"
            if automatic and d.get("location") == "cloud":
                c1 += 1
            if automatic and _ctx(ev).get("at_machine") is True:
                c2 += 1
        elif t == "attention.reply" and (ev.get("actor") or {}).get("kind") != "user":
            c3 += 1

    metrics = {
        "active_hours": n_hours,
        "peek_rate": per_hour(len(peek_list)),
        "peeks": len(peek_list),
        "toil_load": per_hour(toil_total),
        "toil_load_parts": toil_parts,
        "creative_share": creative_share,
        "catch_up_time_ms": _round(_median(catch_ups), 0),
        "catch_up_returns": len(catch_ups),
        "focus_interruptions_avg": _round(sum(interruptions) / len(interruptions)) if interruptions else None,
        "focus_interruptions_max": max(interruptions) if interruptions else None,
        "focus_sessions": len(focus_ends),
        "focus_interruptions_crosscheck_mismatches": mismatches,
        "background_leverage_busy_ms_per_focus_hour": _round(busy_ms / focus_hours, 0) if focus_hours else None,
        "agent_busy_ms": busy_ms,
        "focus_ms": focus_ms,
        "device_creative_share": overall_device,
        "device_creative_share_by_device": device_share,
        "capture_pickup": _round(picked / eligible) if eligible else None,
        "capture_pickup_eligible": eligible,
        "attention_latency_ms": _round(_median(latencies), 0),
        "attention_resolved": len(latencies),
        "c1_violations": c1,
        "c2_violations": c2,
        "c3_violations": c3,
    }
    return metrics


def _filter_workspace(events: List[Dict[str, Any]], workspace: Optional[str]) -> List[Dict[str, Any]]:
    if not workspace:
        return events
    ws = os.path.normpath(workspace)
    return [e for e in events if not e.get("workspace") or os.path.normpath(e["workspace"]) == ws]


def run(
    start: datetime,
    end: datetime,
    workspace: Optional[str] = None,
    events_dir: Optional[Path] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Read the log and compute. Returns the metrics.jsonl record."""
    now = now or datetime.now(timezone.utc)
    read_until = max(end, min(now, end + PICKUP_WINDOW) + timedelta(seconds=1))
    events = read_events(since=start - LOOKBACK, until=read_until, directory=events_dir)
    events = _filter_workspace(events, workspace)
    return {
        "ts": iso(now),
        "from": iso(start),
        "to": iso(end),
        "formula_version": FORMULA_VERSION,
        "workspace": os.path.normpath(workspace) if workspace else None,
        "metrics": compute_metrics(events, start, end),
        "unavailable": list(UNAVAILABLE),
    }


def append_record(record: Dict[str, Any], base: Path) -> Path:
    out = Path(base) / ".hester" / "goals" / "metrics.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")
    return out
