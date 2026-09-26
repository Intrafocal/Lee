"""
GOALS.md metrics computed from Lee's event log alone (contract section 2.5).

Deterministic; no model. Every metric covers the window ``[from, to)``.
Lookbacks (repeated approvals: previous 24 h; manual command repeats:
previous 7 days) and lookaheads (capture pickup: 14 days) read outside the
window where the formula needs it. v3 also reads Cockpit task files
(``<workspace>/.hester/cockpit/tasks/``) for attributed and accepted agent time.
"""

import bisect
import json
import os
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from .event_reader import iso, parse_ts, read_events

# v2: capture_pickup counts only acting triages (explore/promote/drop, not
# keep) and leaves out spooled captures that never got a someday_id.
# v3: attributed_agent_time, background_leverage accepted part, toil_load
# command repeats and flaky reruns, peek_rate with Cockpit modes,
# nudge_acceptance, lost_threads.
# v4: human_balance (your focus time by the quadrant of the task it went to).
# v5: pull_usage (user-triggered steward requests per week).
FORMULA_VERSION = 5

UNAVAILABLE = ["background_leverage.reverted"]
BALANCE_BANDS = ("Q1", "Q2", "Q3", "Q4", "play", "unclassified")

LOOKBACK = timedelta(hours=24)
COMMAND_LOOKBACK = timedelta(days=7)
COMMAND_REPEAT_MIN = 2
LOST_THREAD_AGE = timedelta(days=7)
NUDGE_OUTCOMES = ("fixed", "dismissed", "suppressed", "ignored")
PICKUP_WINDOW = timedelta(days=14)
RETURN_MIN_AWAY_MS = 30 * 60 * 1000
PEEK_MIN_MS = 2000

CREATIVE_TAB_TYPES = {"editor", "files"}
TERMINAL_TAB_TYPES = {"terminal", "claude", "agent", "hester"}
DEVICE_CREATIVE = {"capture", "decide", "reply", "launch", "start_work"}
# GOALS.md: captures "reviewed and acted on (explored, promoted, or explicitly
# dropped)". A 'keep' triage defers the idea, so it is not a pickup.
PICKUP_ACTIONS = {"explore", "promote", "drop"}
LATENCY_KINDS = {"approval", "waiting", "decision", "blocker"}
LATENCY_RESOLUTIONS = {"reply", "answered_in_tab"}
# steward.request surfaces that are you asking Hester for judgment (G3 pull_usage).
PULL_SURFACES = ("what-next", "evaluate", "rail-ask", "rail-steer", "lint-ask", "launch-suggest", "goal-edit")
WEEK = timedelta(days=7)


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


FOCUS_MODE_RACE = timedelta(seconds=2)


def focus_intervals(events: List[Dict[str, Any]], end: datetime) -> List[Dict[str, Any]]:
    """tab.focus intervals per window: until the next tab.focus or window.focus false.

    ``cockpit.mode`` to ``cockpit`` also ends the interval (the overlay covers
    the tabs); the next one starts at the first tab.focus after ``workbench``.
    Lee logs tab.focus and cockpit.mode in either order when one action both
    activates a tab and leaves the Cockpit (⌘1-9, Hester opening a file), so a
    tab.focus seen inside the Cockpit at most ``FOCUS_MODE_RACE`` before
    ``workbench`` opens its interval there.
    """
    out: List[Dict[str, Any]] = []
    open_by_window: Dict[Any, Dict[str, Any]] = {}
    in_cockpit: Set[Any] = set()
    skipped: Dict[Any, Dict[str, Any]] = {}

    def interval(window: Any, d: Dict[str, Any], ts: datetime) -> Dict[str, Any]:
        return {
            "window_id": window, "tab_id": d.get("tab_id"), "pty_id": d.get("pty_id"),
            "tab_type": d.get("tab_type"), "file_path": d.get("file_path"), "start": ts,
        }

    def close(window: Any, ts: datetime) -> None:
        cur = open_by_window.pop(window, None)
        if cur is not None:
            cur["end"] = ts
            out.append(cur)

    for ev in events:
        t = ev.get("type")
        window = ev.get("window_id")
        if t == "cockpit.mode":
            to = _data(ev).get("to")
            if to == "cockpit":
                close(window, ev["_ts"])
                in_cockpit.add(window)
                skipped.pop(window, None)
            elif to == "workbench":
                in_cockpit.discard(window)
                last = skipped.pop(window, None)
                if last is not None and window not in open_by_window and ev["_ts"] - last["_ts"] <= FOCUS_MODE_RACE:
                    open_by_window[window] = interval(window, last, ev["_ts"])
            continue
        if t == "tab.focus":
            close(window, ev["_ts"])
            if window in in_cockpit:
                skipped[window] = {**_data(ev), "_ts": ev["_ts"]}
                continue
            skipped.pop(window, None)
            open_by_window[window] = interval(window, _data(ev), ev["_ts"])
        elif t == "window.focus" and _data(ev).get("focused") is False:
            close(window, ev["_ts"])
            skipped.pop(window, None)
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


def _pty_keys_during(inputs: List[Dict[str, Any]], window: Any, pty: Any, start: datetime, end: datetime) -> int:
    total = 0
    for ev in inputs:
        if ev.get("window_id") != window or _data(ev).get("pty_id") != pty:
            continue
        d = _data(ev)
        ts = ev["_ts"]
        span = timedelta(milliseconds=d.get("span_ms") or 0)
        if ts > start and ts - span < end:
            total += int(d.get("keys") or 0)
    return total


def go_into_peeks(events, start, end, focus_peeks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``cockpit.go_into`` a busy agent with no keys before the window's next focus change.

    Going into an idle or waiting agent is a review, not a peek. A go-into
    that a tab.focus peek already counted (same window and pty, within 5 s)
    is not counted twice.
    """
    inputs = [e for e in events if e.get("type") == "input.counts"]
    found = []
    for i, ev in enumerate(events):
        if ev.get("type") != "cockpit.go_into" or not _in(ev, start, end):
            continue
        d = _data(ev)
        if d.get("agent_state") != "busy":
            continue
        window, pty = ev.get("window_id"), d.get("pty_id")
        stop = end
        for nxt in events[i + 1:]:
            if nxt.get("window_id") != window:
                continue
            nt = nxt.get("type")
            if nt == "cockpit.go_into" or (nt == "cockpit.mode" and _data(nxt).get("to") == "cockpit") or (
                nt == "window.focus" and _data(nxt).get("focused") is False
            ) or (nt == "tab.focus" and _data(nxt).get("pty_id") != pty):
                stop = nxt["_ts"]
                break
        if any(
            p["window_id"] == window and p["pty_id"] == pty and abs(_ms(p["start"] - ev["_ts"])) <= 5000
            for p in focus_peeks
        ):
            continue
        if _pty_keys_during(inputs, window, pty, ev["_ts"], stop) > 0:
            continue
        found.append({"window_id": window, "pty_id": pty, "start": ev["_ts"], "end": stop})
    return found


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
    return found + go_into_peeks(events, start, end, found)


def command_repeats(events, start, end) -> int:
    """Commands typed by hand (no operation) whose sig was run by hand >= 2 times in the previous 7 days."""
    seen: Dict[str, List[datetime]] = defaultdict(list)
    count = 0
    for ev in events:
        if ev.get("type") != "terminal.command":
            continue
        d = _data(ev)
        sig = d.get("sig")
        if d.get("by") != "user" or d.get("op") is not None or not sig:
            continue
        ts = ev["_ts"]
        if _in(ev, start, end):
            prior = sum(1 for t in seen[sig] if ts - COMMAND_LOOKBACK <= t < ts)
            if prior >= COMMAND_REPEAT_MIN:
                count += 1
        seen[sig].append(ts)
    return count


def flaky_reruns(events, start, end) -> int:
    """``operation.run`` whose previous run of the same op and inputs failed."""
    status: Dict[str, str] = {}
    for ev in events:
        if ev.get("type") == "operation.result":
            d = _data(ev)
            if d.get("run_id"):
                status[d["run_id"]] = d.get("status")
    last_run: Dict[Tuple[Any, Any, Any], str] = {}
    count = 0
    for ev in events:
        if ev.get("type") != "operation.run":
            continue
        d = _data(ev)
        key = (ev.get("workspace"), d.get("op"), d.get("inputs_sig"))
        prev = last_run.get(key)
        if prev is not None and _in(ev, start, end) and status.get(prev) == "failed":
            count += 1
        if d.get("run_id"):
            last_run[key] = d["run_id"]
    return count


def nudge_acceptance(window: List[Dict[str, Any]]) -> Tuple[Optional[float], Dict[str, Any]]:
    per_rule: Dict[str, Dict[str, int]] = defaultdict(lambda: {o: 0 for o in NUDGE_OUTCOMES})
    for ev in window:
        if ev.get("type") != "lint.outcome":
            continue
        d = _data(ev)
        outcome = d.get("outcome")
        if outcome not in NUDGE_OUTCOMES:
            continue
        per_rule[str(d.get("rule") or "unknown")][outcome] += 1
    by_rule: Dict[str, Any] = {}
    fixed = total = 0
    for rule, c in sorted(per_rule.items()):
        n = sum(c.values())
        fixed += c["fixed"]
        total += n
        by_rule[rule] = {"acceptance": _round(c["fixed"] / n) if n else None, "n": n, **c}
    return (_round(fixed / total) if total else None), by_rule


def load_tasks(workspaces: Iterable[str]) -> List[Dict[str, Any]]:
    """Cockpit task records of these workspaces (read-only)."""
    from ..cockpit.tasks import CockpitTaskStore

    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for ws in workspaces:
        if not ws:
            continue
        key = os.path.normpath(str(ws))
        if key in seen or not os.path.isdir(key):
            continue
        seen.add(key)
        out.extend(CockpitTaskStore(Path(key)).load_all())
    return out


def load_goals_by_workspace(workspaces: Iterable[str]) -> Dict[str, List[Dict[str, Any]]]:
    """``{normpath(ws): goals}`` from each workspace's GOALS.md (for human_balance quadrants)."""
    from ..cockpit.goals import load_goals_full

    out: Dict[str, List[Dict[str, Any]]] = {}
    for ws in workspaces:
        if not ws:
            continue
        key = os.path.normpath(str(ws))
        if key not in out and os.path.isdir(key):
            out[key] = load_goals_full(Path(key))["goals"]
    return out


def _task_session_map(tasks: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    from ..cockpit.tasks import task_sessions

    out: Dict[str, Dict[str, Any]] = {}
    for t in tasks:
        for sid in task_sessions(t):
            out[sid] = t
    return out


def _input_minutes(events: List[Dict[str, Any]], start: datetime, end: datetime) -> Dict[Any, Set[datetime]]:
    """Per window, the minutes that had input (keys + clicks > 0 in an ``input.counts``)."""
    out: Dict[Any, Set[datetime]] = defaultdict(set)
    for ev in events:
        if ev.get("type") != "input.counts":
            continue
        d = _data(ev)
        if int(d.get("keys") or 0) + int(d.get("clicks") or 0) <= 0:
            continue
        ts = ev["_ts"]
        if ts < start - timedelta(minutes=1) or ts > end + timedelta(minutes=1):
            continue
        span = timedelta(milliseconds=float(d.get("span_ms") or 0))
        m = (ts - span).replace(second=0, microsecond=0)
        last = ts.replace(second=0, microsecond=0)
        while m <= last:
            out[ev.get("window_id")].add(m)
            m += timedelta(minutes=1)
    return out


def active_focus_pieces(events: List[Dict[str, Any]], start: datetime, end: datetime) -> List[Dict[str, Any]]:
    """``focus_intervals`` clipped to ``[start, end)`` and to minutes of that window that had input."""
    minutes = _input_minutes(events, start, end)
    pieces: List[Dict[str, Any]] = []
    for iv in focus_intervals([e for e in events if e["_ts"] < end], end):
        a, b = max(iv["start"], start), min(iv["end"], end)
        if a >= b:
            continue
        active = minutes.get(iv["window_id"])
        if not active:
            continue
        m = a.replace(second=0, microsecond=0)
        while m < b:
            if m in active:
                pa, pb = max(a, m), min(b, m + timedelta(minutes=1))
                if pa < pb:
                    pieces.append({**iv, "start": pa, "end": pb})
            m += timedelta(minutes=1)
    return pieces


class _Timeline:
    """The latest value set at or before a time."""

    def __init__(self) -> None:
        self.times: List[datetime] = []
        self.values: List[Any] = []

    def set(self, ts: datetime, value: Any) -> None:
        # Events arrive sorted by ts.
        self.times.append(ts)
        self.values.append(value)

    def at(self, ts: datetime) -> Any:
        i = bisect.bisect_right(self.times, ts)
        return self.values[i - 1] if i else None


def _task_open_at(task: Dict[str, Any], ts: datetime) -> bool:
    created = parse_ts(task.get("created_at"))
    closed = parse_ts(task.get("closed_at")) if task.get("status") in ("done", "discarded") else None
    return (created is None or created <= ts) and (closed is None or ts < closed)


def _goals_for(task: Dict[str, Any], goals: Optional[Dict[str, List[Dict[str, Any]]]]) -> List[Dict[str, Any]]:
    if not goals:
        return []
    ws = task.get("workspace")
    if isinstance(ws, str) and ws:
        hit = goals.get(os.path.normpath(ws))
        if hit is not None:
            return hit
    return next(iter(goals.values())) if len(goals) == 1 else []


def human_balance(
    events: List[Dict[str, Any]],
    start: datetime,
    end: datetime,
    tasks: List[Dict[str, Any]],
    goals: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Your focus time (never agent time) by the quadrant of the task it went to.

    Attribution, first rule that matches: the focus session's item is the
    task; the focused tab is the task's agent pty (session join); the focused
    file is in the task's files while it was open (newest update wins);
    otherwise unclassified. ``human_balance = (Q1+Q2) / (Q1+Q2+Q3+Q4+play)``.
    """
    from ..cockpit.tasks import derive

    now = now or end
    by_id = {t["id"]: t for t in tasks if isinstance(t, dict) and t.get("id")}
    session_task = _task_session_map(tasks)

    focus_item = _Timeline()
    pty_session: Dict[int, _Timeline] = defaultdict(_Timeline)
    for ev in events:
        if ev["_ts"] >= end:
            break
        t = ev.get("type") or ""
        d = _data(ev)
        if t in ("focus.start", "focus.item"):
            item = d.get("item")
            focus_item.set(ev["_ts"], item if isinstance(item, dict) else None)
        elif t == "focus.end":
            focus_item.set(ev["_ts"], None)
        elif t.startswith("agent.") and isinstance(d.get("pty_id"), int) and d.get("session_id"):
            pty_session[d["pty_id"]].set(ev["_ts"], d["session_id"])

    file_tasks: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for task in tasks:
        base = task.get("workspace") if isinstance(task.get("workspace"), str) else None
        for f in task.get("files") or []:
            if isinstance(f, str) and f:
                p = os.path.normpath(f if os.path.isabs(f) or not base else os.path.join(base, f))
                file_tasks[p].append(task)

    def attribute(piece: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        mid = piece["start"] + (piece["end"] - piece["start"]) / 2
        item = focus_item.at(mid)
        if isinstance(item, dict) and item.get("kind") == "task" and item.get("task_id") in by_id:
            return by_id[item["task_id"]]
        pty = piece.get("pty_id")
        if isinstance(pty, int) and pty in pty_session:
            task = session_task.get(pty_session[pty].at(mid))
            if task is not None:
                return task
        fp = piece.get("file_path")
        if isinstance(fp, str) and fp:
            hits = [t for t in file_tasks.get(os.path.normpath(fp), []) if _task_open_at(t, mid)]
            if hits:
                hits.sort(key=lambda t: str(t.get("updated_at") or ""), reverse=True)
                return hits[0]
        return None

    bands = {b: 0.0 for b in BALANCE_BANDS}
    by_goal: Dict[str, float] = defaultdict(float)
    band_cache: Dict[str, Tuple[str, List[str]]] = {}
    for piece in active_focus_pieces(events, start, end):
        ms = _ms(piece["end"] - piece["start"])
        task = attribute(piece)
        if task is None:
            bands["unclassified"] += ms
            continue
        if task["id"] not in band_cache:
            goal_list = _goals_for(task, goals)
            q = derive(task, goal_list, now)["quadrant"]
            band = "unclassified" if q is None else ("play" if q == "Q4" and task.get("play") else q)
            known = {g["id"] for g in goal_list}
            served = [g for g in task.get("serves") or [] if isinstance(g, str) and (g in known if known else g.startswith("G"))]
            band_cache[task["id"]] = (band, served)
        band, served = band_cache[task["id"]]
        bands[band] += ms
        for gid in served:
            by_goal[gid] += ms
    classified = sum(bands[b] for b in ("Q1", "Q2", "Q3", "Q4", "play"))
    return {
        "human_balance": _round((bands["Q1"] + bands["Q2"]) / classified) if classified else None,
        "human_balance_ms": {b: int(round(v)) for b, v in bands.items()},
        "human_balance_by_goal": {g: int(round(v)) for g, v in sorted(by_goal.items())},
    }


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
    tasks: Optional[List[Dict[str, Any]]] = None,
    goals: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Dict[str, Any]:
    """All section 2.5 metrics (formula v5) over ``[start, end)``.

    ``events`` must be sorted by ts and may extend before ``start`` (7-day
    lookback) and after ``end`` (14-day capture pickup lookahead). ``tasks``
    are Cockpit task records (any workspace), read at computation time.
    """
    tasks = tasks or []
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
        "command_repeats": command_repeats(events, start, end),
        "flaky_reruns": flaky_reruns(events, start, end),
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

    # background_leverage (busy time; v3 adds the accepted part)
    busy_ms = sum(float(_data(e).get("busy_ms") or 0) for e in window if e.get("type") == "agent.turn_end")
    focus_ms = sum(float(_data(e).get("duration_ms") or 0) for e in focus_ends)
    focus_hours = focus_ms / 3_600_000.0

    # attributed_agent_time and the accepted part (Cockpit task files)
    session_task = _task_session_map(tasks)
    attributed_ms = 0.0
    accepted_ms = 0.0
    accepted_spend: Dict[str, Dict[str, Any]] = {}
    for ev in window:
        if ev.get("type") != "agent.turn_end":
            continue
        d = _data(ev)
        task = session_task.get(d.get("session_id"))
        if task is None:
            continue
        ms = float(d.get("busy_ms") or 0)
        if task.get("confirmed"):
            attributed_ms += ms
        if task.get("accepted") is True and task.get("status") == "done":
            accepted_ms += ms
            spend = accepted_spend.setdefault(task["id"], {
                "task_id": task["id"], "model": (task.get("agent") or {}).get("model"), "busy_ms": 0.0,
            })
            spend["busy_ms"] += ms
    lost = 0
    for task in tasks:
        if task.get("status") in ("done", "discarded"):
            continue
        updated = parse_ts(task.get("updated_at"))
        if updated is not None and updated < end - LOST_THREAD_AGE:
            lost += 1
    nudge_rate, nudge_by_rule = nudge_acceptance(window)

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
            if sid and _data(ev).get("action") in PICKUP_ACTIONS:
                triaged[sid].append(ev["_ts"])
    eligible = picked = 0
    for ev in window:
        if ev.get("type") != "capture":
            continue
        actor = ev.get("actor") or {}
        away = _ctx(ev).get("at_machine") is False or actor.get("surface") == "device"
        if not away or ev["_ts"] > end - PICKUP_WINDOW:
            continue
        sid = _data(ev).get("someday_id")
        if not sid and _data(ev).get("spooled"):
            # Spooled while Hester was down: Lee delivers it later but logs no
            # event linking it to its Someday id, so it can never be joined to a
            # triage. Leave it out rather than count it as never picked up.
            continue
        eligible += 1
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
        "background_leverage_accepted_ms_per_focus_hour": _round(accepted_ms / focus_hours, 0) if focus_hours else None,
        "agent_busy_ms": busy_ms,
        "accepted_busy_ms": accepted_ms,
        "accepted_tasks": len(accepted_spend),
        "accepted_task_spend": sorted(accepted_spend.values(), key=lambda r: r["task_id"]),
        "attributed_agent_time": _round(attributed_ms / busy_ms) if busy_ms else None,
        "attributed_busy_ms": attributed_ms,
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
        "nudge_acceptance": nudge_rate,
        "nudge_acceptance_by_rule": nudge_by_rule,
        "lost_threads": lost,
    }
    metrics.update(human_balance(events, start, end, tasks, goals))
    metrics.update(pull_usage(window, start, end))
    return metrics


def pull_usage(window: List[Dict[str, Any]], start: datetime, end: datetime) -> Dict[str, Any]:
    """``steward.request`` events from pull surfaces in the window, as a per-week rate and by surface."""
    by_surface: Dict[str, int] = {}
    for ev in window:
        if ev.get("type") != "steward.request":
            continue
        surface = _data(ev).get("surface")
        if surface in PULL_SURFACES:
            by_surface[surface] = by_surface.get(surface, 0) + 1
    total = sum(by_surface.values())
    weeks = (end - start) / WEEK
    return {
        "pull_usage": _round(total / weeks) if weeks > 0 else None,
        "pull_requests": total,
        "pull_usage_by_surface": dict(sorted(by_surface.items())),
    }


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
    task_workspaces: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """Read the log and compute. Returns the metrics.jsonl record.

    Task files are read from ``task_workspaces`` if given, else from
    ``workspace``, else from every workspace named by an event in range.
    """
    now = now or datetime.now(timezone.utc)
    read_until = max(end, min(now, end + PICKUP_WINDOW) + timedelta(seconds=1))
    events = read_events(since=start - COMMAND_LOOKBACK, until=read_until, directory=events_dir)
    events = _filter_workspace(events, workspace)
    if task_workspaces is None:
        if workspace:
            task_workspaces = [workspace]
        else:
            task_workspaces = sorted({e["workspace"] for e in events if isinstance(e.get("workspace"), str) and e["workspace"]})
    task_workspaces = list(task_workspaces)
    return {
        "ts": iso(now),
        "from": iso(start),
        "to": iso(end),
        "formula_version": FORMULA_VERSION,
        "workspace": os.path.normpath(workspace) if workspace else None,
        "metrics": compute_metrics(
            events, start, end, tasks=load_tasks(task_workspaces), goals=load_goals_by_workspace(task_workspaces),
        ),
        "unavailable": list(UNAVAILABLE),
    }


def append_record(record: Dict[str, Any], base: Path) -> Path:
    out = Path(base) / ".hester" / "goals" / "metrics.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")
    return out
