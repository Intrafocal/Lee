"""
Goal status, the human_balance strip, Q2 candidates and the evaluation
evidence packet (copilot v4, contract sections 2, 3, 5.2 and 6).

Everything here is deterministic: no model. Values come from
``<workspace>/.hester/goals/metrics.jsonl`` (metrics records and operation
readings); when the newest metrics record for the requested window length is missing or over an hour old,
``metrics.run`` computes one from Lee's event log and appends it.
"""

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..copilot import retro as retro_mod
from ..copilot.event_reader import iso, parse_ts
from .goals import GOAL_ID_RE, load_goals_full, target_ok
from .readings import ReadingsStore
from .tasks import CockpitTaskStore, is_open, parse_time

logger = logging.getLogger("hester.daemon.cockpit.goal_status")

# GOALS name -> metrics record key (contract section 2); others map to themselves.
METRIC_KEY = {
    "catch_up_time": "catch_up_time_ms",
    "attention_latency": "attention_latency_ms",
    "focus_interruptions": "focus_interruptions_avg",
    "background_leverage": "background_leverage_accepted_ms_per_focus_hour",
    "human_balance": "human_balance",
}
# Judged metrics and the retro questions that answer them.
JUDGED = {"weekly_retro": ("ideas_or_plumbing", "stuck_good_bad"), "surprise": ("surprise",)}

RECORD_MAX_AGE = timedelta(hours=1)
WINDOW_SLACK = timedelta(hours=1)
# ``previous`` is a record at least this share of ``days`` older than the current one.
PREVIOUS_MIN_GAP = 0.5
CACHE_S = 600.0
FLAT = 0.02
SERVING_CLOSED_DAYS = 14
QUIET_DAYS = 7
EVALUATION_DUE_DAYS = 14
MAX_Q2 = 5
HISTORY_N = 5
MEASURE_FRESH = timedelta(hours=24)
MAX_PACKET_COMMITS = 20

EVALUATIONS_DIR = Path(".hester") / "goals" / "evaluations"
_EVAL_RE = re.compile(r"^(G\d+)-(\d{8}T\d{6})\.md$")
BANDS = ("Q1", "Q2", "Q3", "Q4", "play", "unclassified")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _norm_ws(workspace: Any) -> str:
    return os.path.normpath(str(workspace))


def _number(value: Any) -> Optional[float]:
    if isinstance(value, dict):
        # v6 G0 metrics are records: {value, ...}, time_to_deep {value_s, n}, session_depth {share_deep, ...}.
        value = next((value[k] for k in ("value", "value_s", "share_deep") if k in value), None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


# ---------------------------------------------------------------------------
# metrics.jsonl
# ---------------------------------------------------------------------------


def _lines(workspace: Path) -> List[Dict[str, Any]]:
    return ReadingsStore(workspace)._lines()


def metrics_records(workspace: Path) -> List[Dict[str, Any]]:
    """Metrics records (lines without ``kind``) for this workspace, oldest first."""
    ws = _norm_ws(workspace)
    out = []
    for line in _lines(workspace):
        if line.get("kind") or not isinstance(line.get("metrics"), dict):
            continue
        rws = line.get("workspace")
        if rws and _norm_ws(rws) != ws:
            continue
        if not rws:
            continue
        out.append(line)
    out.sort(key=lambda r: str(r.get("ts") or ""))
    return out


def readings(workspace: Path) -> List[Dict[str, Any]]:
    rows = [line for line in _lines(workspace) if line.get("kind") == "reading"]
    rows.sort(key=lambda r: str(r.get("ts") or ""))
    return rows


def run_metrics(start: datetime, end: datetime, workspace: str) -> Dict[str, Any]:
    """``metrics.run`` for this workspace (tests replace this)."""
    from ..copilot import metrics

    return metrics.run(start, end, workspace=workspace, now=end)


_cache_lock = threading.Lock()
_ensured: Dict[str, float] = {}


def invalidate(workspace: Optional[Path] = None) -> None:
    with _cache_lock:
        if workspace is None:
            _ensured.clear()
        else:
            ws = _norm_ws(workspace)
            for k in [k for k in _ensured if k.split("|", 1)[0] == ws]:
                _ensured.pop(k, None)


def window_matches(record: Dict[str, Any], days: int) -> bool:
    """The record covers a ``days``-long window (``to - from``, within an hour)."""
    start, end = parse_ts(record.get("from")), parse_ts(record.get("to"))
    if start is None or end is None:
        return False
    return abs((end - start) - timedelta(days=days)) <= WINDOW_SLACK


def window_records(records: List[Dict[str, Any]], days: int) -> List[Dict[str, Any]]:
    """Records whose window is ``days`` long, oldest first."""
    return [r for r in records if window_matches(r, days)]


def ensure_record(workspace: Path, days: int, now: datetime) -> List[Dict[str, Any]]:
    """
    The workspace's ``days``-window metrics records (oldest first), computing
    and appending a fresh one first when the newest of that window is missing
    or more than an hour old (at most every 10 min per workspace and window).
    """
    from ..copilot import metrics

    records = window_records(metrics_records(workspace), days)
    newest = parse_ts(records[-1].get("ts")) if records else None
    stale = newest is None or now - newest > RECORD_MAX_AGE
    key = _norm_ws(workspace)
    if stale:
        with _cache_lock:
            recent = _ensured.get(f"{key}|{days}")
            if recent is not None and time.monotonic() - recent < CACHE_S:
                return records
            _ensured[f"{key}|{days}"] = time.monotonic()
        try:
            record = run_metrics(now - timedelta(days=days), now, str(workspace))
            if isinstance(record, dict) and isinstance(record.get("metrics"), dict):
                record.setdefault("workspace", key)
                metrics.append_record(record, Path(workspace))
                records = window_records(metrics_records(workspace), days)
        except Exception as e:
            logger.warning(f"Goal status: metrics run failed for {workspace}: {e}")
    return records


# ---------------------------------------------------------------------------
# Evaluations and retro
# ---------------------------------------------------------------------------


def evaluations_dir(workspace: Path) -> Path:
    return Path(workspace) / EVALUATIONS_DIR


def last_evaluations(workspace: Path) -> Dict[str, str]:
    """Goal id -> ISO time of its newest ``.hester/goals/evaluations/<gid>-<stamp>.md``."""
    out: Dict[str, str] = {}
    try:
        names = os.listdir(evaluations_dir(workspace))
    except OSError:
        return out
    for name in names:
        m = _EVAL_RE.match(name)
        if not m:
            continue
        try:
            at = datetime.strptime(m.group(2), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        stamp = iso(at)
        if m.group(1) not in out or stamp > out[m.group(1)]:
            out[m.group(1)] = stamp
    return out


def judged_at(metric: str, directory: Optional[Path] = None) -> Optional[str]:
    """The newest retro answer time that answers this judged metric's question(s)."""
    questions = JUDGED.get(metric)
    if not questions:
        return None
    best: Optional[datetime] = None
    base = Path(directory) if directory else retro_mod.retro_dir()
    try:
        paths = list(base.glob("*.json"))
    except OSError:
        return None
    for p in paths:
        try:
            rec = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict) or not rec.get("answered_at"):
            continue
        answers = rec.get("answers") if isinstance(rec.get("answers"), dict) else {}
        if not any(answers.get(q) for q in questions):
            continue
        at = parse_ts(rec["answered_at"])
        if at is not None and (best is None or at > best):
            best = at
    return iso(best) if best else None


# ---------------------------------------------------------------------------
# Serving items
# ---------------------------------------------------------------------------


def _workstreams(workspace: Path) -> List[Dict[str, Any]]:
    try:
        from ..workstream.store import WorkstreamStore

        store = WorkstreamStore(working_dir=Path(workspace))
        out = []
        for wid in store.list_all():
            w = store.get(wid)
            if w is not None:
                out.append({"id": w.id, "title": w.title, "phase": w.phase.value, "serves": list(w.serves or [])})
        return out
    except Exception as e:
        logger.debug(f"workstreams unavailable for {workspace}: {e}")
        return []


def _explorations(workspace: Path) -> List[Dict[str, Any]]:
    try:
        from .explorations import ExplorationStore

        return [e for e in ExplorationStore(Path(workspace)).load_all() if e.get("status") == "active"]
    except Exception as e:
        logger.debug(f"explorations unavailable for {workspace}: {e}")
        return []


class Items:
    """Tasks, workstreams and active explorations of one workspace, loaded once."""

    def __init__(self, workspace: Path, tasks=None, workstreams=None, explorations=None):
        self.workspace = Path(workspace)
        self.tasks = tasks if tasks is not None else CockpitTaskStore(self.workspace).load_all()
        self.workstreams = workstreams if workstreams is not None else _workstreams(self.workspace)
        self.explorations = explorations if explorations is not None else _explorations(self.workspace)

    def serving(self, gid: str, now: datetime) -> Dict[str, List[Dict[str, Any]]]:
        cutoff = now - timedelta(days=SERVING_CLOSED_DAYS)
        tasks = []
        for t in self.tasks:
            if gid not in (t.get("serves") or []):
                continue
            closed = parse_time(t.get("closed_at"))
            if is_open(t) or (closed is not None and closed >= cutoff):
                tasks.append({"id": t["id"], "title": t.get("title"), "status": t.get("status"), "quadrant": t.get("quadrant")})
        return {
            "tasks": tasks,
            "workstreams": [
                {"id": w["id"], "title": w["title"], "phase": w["phase"]} for w in self.workstreams if gid in w["serves"]
            ],
            "explorations": [
                {"id": e["id"], "title": e.get("title")} for e in self.explorations if gid in (e.get("serves") or [])
            ],
        }

    def open_serving(self, gid: str) -> bool:
        """Anything live serving the goal: an open task, a workstream not done, an active exploration."""
        return (
            any(is_open(t) and gid in (t.get("serves") or []) for t in self.tasks)
            or any(gid in w["serves"] and w["phase"] != "done" for w in self.workstreams)
            or any(gid in (e.get("serves") or []) for e in self.explorations)
        )


# ---------------------------------------------------------------------------
# Metric status
# ---------------------------------------------------------------------------


def _trend(value: Optional[float], previous: Optional[float]) -> Optional[str]:
    if value is None or previous is None:
        return None
    if previous == 0:
        if value == 0:
            return "flat"
        return "up" if value > 0 else "down"
    if abs(value - previous) <= FLAT * abs(previous):
        return "flat"
    return "up" if value > previous else "down"


def _ok(value: Optional[float], previous: Optional[float], target: Dict[str, Any], trend: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    if target.get("op") is not None and target.get("value") is not None:
        return target_ok(value, target)
    direction = target.get("direction")
    if direction is None or previous is None or trend in (None, "flat"):
        return None
    return value < previous if direction == "falling" else value > previous


def wrong_way(target: Dict[str, Any], trend: Optional[str]) -> bool:
    if trend not in ("up", "down"):
        return False
    direction = target.get("direction")
    if direction == "falling":
        return trend == "up"
    if direction == "rising":
        return trend == "down"
    op = target.get("op")
    if op in (">=", ">"):
        return trend == "down"
    if op in ("<=", "<"):
        return trend == "up"
    return False


def _closest(rows: List[Dict[str, Any]], when: datetime, value_of: Callable[[Dict[str, Any]], Any]) -> Optional[Dict[str, Any]]:
    best, best_d = None, None
    for r in rows:
        at = parse_ts(r.get("ts"))
        if at is None or _number(value_of(r)) is None:
            continue
        d = abs((at - when).total_seconds())
        if best_d is None or d < best_d:
            best, best_d = r, d
    return best


def _metric_readings(rows: List[Dict[str, Any]], metric: Dict[str, Any]) -> List[Dict[str, Any]]:
    name, op = metric["name"], metric.get("measure")
    return [
        r for r in rows
        if _number(r.get("value")) is not None
        and (r.get("metric") == name or (op and (r.get("source") or {}).get("op") == op))
    ]


def _older(row: Dict[str, Any], than: datetime, days: int) -> bool:
    at = parse_ts(row.get("ts"))
    return at is not None and at <= than - timedelta(days=days) * PREVIOUS_MIN_GAP


def metric_status(
    metric: Dict[str, Any],
    records: List[Dict[str, Any]],
    reading_rows: List[Dict[str, Any]],
    generated: datetime,
    days: int,
    retro_directory: Optional[Path] = None,
) -> Dict[str, Any]:
    name = metric["name"]
    out: Dict[str, Any] = {
        "name": name, "kind": metric.get("kind"), "target_text": metric.get("target_text"),
        "target": metric.get("target"), "value": None, "previous": None, "trend": None, "ok": None,
        "source": None, "at": None, "available": metric.get("available"), "measure": metric.get("measure"),
    }
    if metric.get("kind") == "judged" or name in JUDGED:
        out.update({"source": "judged", "at": judged_at(name, retro_directory)})
        return out
    key = METRIC_KEY.get(name, name)
    value_of = lambda r: (r.get("metrics") or {}).get(key)  # noqa: E731
    # ``records`` are this window's records; previous is one at least half a
    # window older than the current one (else no trend).
    newest = records[-1] if records else None
    value = _number(value_of(newest)) if newest else None
    at = newest.get("ts") if newest and value is not None else None
    newest_at = parse_ts(newest.get("ts")) if newest else None
    prev = None
    if newest_at is not None:
        previous_rows = [r for r in records[:-1] if _older(r, newest_at, days)]
        prev = _closest(previous_rows, newest_at - timedelta(days=days), value_of)
    previous = _number(value_of(prev)) if prev else None
    source = "metrics" if value is not None else None

    mine = _metric_readings(reading_rows, metric)
    if mine and (value is None or str(mine[-1].get("ts") or "") > str(at or "")):
        # operation readings: the previous reading closest to a window ago
        last = mine[-1]
        value, at, source = _number(last.get("value")), last.get("ts"), "reading"
        prev_r = _closest(mine[:-1], generated - timedelta(days=days), lambda r: r.get("value"))
        previous = _number(prev_r.get("value")) if prev_r else previous
    trend = _trend(value, previous)
    out.update({
        "value": value, "previous": previous, "trend": trend, "source": source, "at": at,
        "ok": _ok(value, previous, metric.get("target") or {}, trend),
    })
    return out


def metric_history(metric: Dict[str, Any], records: List[Dict[str, Any]], reading_rows: List[Dict[str, Any]], n: int = HISTORY_N) -> List[Dict[str, Any]]:
    """The last ``n`` values, from metrics records and readings, oldest first."""
    if metric.get("kind") == "judged" or metric["name"] in JUDGED:
        return []
    key = METRIC_KEY.get(metric["name"], metric["name"])
    rows = []
    for r in records:
        v = _number((r.get("metrics") or {}).get(key))
        if v is not None:
            rows.append({"at": r.get("ts"), "value": v, "source": "metrics"})
    for r in _metric_readings(reading_rows, metric):
        rows.append({"at": r.get("ts"), "value": r.get("value"), "source": "reading"})
    rows.sort(key=lambda r: str(r.get("at") or ""))
    return rows[-n:]


# ---------------------------------------------------------------------------
# human_balance strip
# ---------------------------------------------------------------------------


def strip_line(ms: Dict[str, Any], by_goal: Dict[str, Any], goals: List[Dict[str, Any]]) -> str:
    total = sum(float(ms.get(b) or 0) for b in BANDS)
    if total <= 0:
        return "No focus time recorded this week."
    classified = sum(float(ms.get(b) or 0) for b in ("Q1", "Q2", "Q3", "Q4", "play"))
    q2 = round(100 * float(ms.get("Q2") or 0) / classified) if classified else 0
    line = f"{q2}% Q2"
    for g in sorted(goals, key=lambda g: g.get("priority", 0)):
        if float((by_goal or {}).get(g["id"]) or 0) <= 0:
            line += f"; {g['id']} got none of your time this week"
            break
    return line + "."


def balance_block(record: Optional[Dict[str, Any]], goals: List[Dict[str, Any]]) -> Dict[str, Any]:
    m = (record or {}).get("metrics") or {}
    raw_ms = m.get("human_balance_ms") if isinstance(m.get("human_balance_ms"), dict) else {}
    ms = {b: int(raw_ms.get(b) or 0) for b in BANDS}
    by_goal = {k: int(v or 0) for k, v in (m.get("human_balance_by_goal") or {}).items()} if isinstance(m.get("human_balance_by_goal"), dict) else {}
    return {
        "share": _number(m.get("human_balance")),
        "ms": ms,
        "by_goal": by_goal,
        "line": strip_line(ms, by_goal, goals),
    }


# ---------------------------------------------------------------------------
# Q2 candidates
# ---------------------------------------------------------------------------


def q2_candidates(
    workspace: Path,
    now: Optional[datetime] = None,
    items: Optional[Items] = None,
    goals: Optional[List[Dict[str, Any]]] = None,
    evaluated: Optional[Dict[str, str]] = None,
    goal_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Deterministic Q2 (important, not urgent) candidates, in goal priority
    order, at most 5: goals nothing live serves, active explorations
    untouched for 7 days, goals not evaluated in 14 days.
    """
    now = now or utc_now()
    goals = goals if goals is not None else load_goals_full(Path(workspace))["goals"]
    items = items or Items(workspace)
    evaluated = evaluated if evaluated is not None else last_evaluations(Path(workspace))
    goal_ids = {g["id"] for g in goals}

    quiet: List[Tuple[Dict[str, Any], int]] = []
    for e in items.explorations:
        touched = parse_time(e.get("last_touched_at") or e.get("updated_at"))
        if touched is None:
            continue
        age = (now - touched).days
        if age >= QUIET_DAYS:
            quiet.append((e, age))

    out: List[Dict[str, Any]] = []
    placed = set()
    for g in sorted(goals, key=lambda g: g.get("priority", 0)):
        gid = g["id"]
        if goal_id and gid != goal_id:
            continue
        if not items.open_serving(gid):
            out.append({"kind": "goal-unserved", "goal_id": gid, "ref": gid, "title": g["title"],
                        "detail": f"Nothing open serves {gid}."})
        for e, age in quiet:
            if e["id"] not in placed and gid in (e.get("serves") or []):
                placed.add(e["id"])
                out.append({"kind": "exploration-quiet", "goal_id": gid, "ref": e["id"], "title": e.get("title"),
                            "detail": f"Untouched for {age} days."})
        last = parse_ts(evaluated.get(gid)) if evaluated.get(gid) else None
        if last is None or now - last > timedelta(days=EVALUATION_DUE_DAYS):
            detail = "Never evaluated." if last is None else f"Last evaluated {(now - last).days} days ago."
            out.append({"kind": "evaluation-due", "goal_id": gid, "ref": gid, "title": g["title"], "detail": detail})
    if not goal_id:
        for e, age in quiet:
            if e["id"] not in placed and not (set(e.get("serves") or []) & goal_ids):
                out.append({"kind": "exploration-quiet", "goal_id": None, "ref": e["id"], "title": e.get("title"),
                            "detail": f"Untouched for {age} days."})
    return out[:MAX_Q2]


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


def build_status(
    workspace: Path,
    days: int = 7,
    now: Optional[datetime] = None,
    items: Optional[Items] = None,
    retro_directory: Optional[Path] = None,
) -> Dict[str, Any]:
    """``GET /cockpit/goals/status`` (contract section 2)."""
    now = now or utc_now()
    workspace = Path(workspace)
    parsed = load_goals_full(workspace)
    goals = parsed["goals"]
    # only records of this window length: a 30-day status never shows a 7-day record
    records = (
        ensure_record(workspace, days, now) if goals or parsed["constraints"]
        else window_records(metrics_records(workspace), days)
    )
    reading_rows = readings(workspace)
    newest = records[-1] if records else None
    items = items or Items(workspace)
    evaluated = last_evaluations(workspace)
    balance = balance_block(newest, goals)

    out_goals = []
    for g in goals:
        metrics_out = [metric_status(m, records, reading_rows, now, days, retro_directory) for m in g["metrics"]]
        serving = items.serving(g["id"], now)
        nothing = not (serving["tasks"] or serving["workstreams"] or serving["explorations"])
        bad = any(m["ok"] is False or wrong_way(m.get("target") or {}, m.get("trend")) for m in metrics_out)
        # Deep next R12: a goal with no metrics is "not measured yet", never a problem.
        measured = bool(metrics_out)
        out_goals.append({
            "id": g["id"], "title": g["title"], "priority": g["priority"], "prose": g["prose"],
            "metrics": metrics_out,
            "measured": measured,
            "serving": serving,
            "flagged": bool(measured and nothing and bad),
            "last_evaluated_at": evaluated.get(g["id"]),
            "focus_ms_7d": int(balance["by_goal"].get(g["id"]) or 0),
        })

    record_metrics = (newest or {}).get("metrics") or {}
    constraints = []
    for c in parsed["constraints"]:
        n = re.match(r"^C(\d+)$", c["id"])
        violations = _number(record_metrics.get(f"c{n.group(1)}_violations")) if n else None
        constraints.append({
            "id": c["id"], "title": c["title"], "text": c.get("text"), "telemetry": c.get("telemetry"),
            "available": c.get("available"), "target_text": c.get("target_text"), "target": c.get("target"),
            "violations": violations,
        })
    tensions = [
        {"a": t["a"], "b": t["b"], "label": t.get("label"), "text": t.get("text"), "default": t.get("default"),
         "arbiter": t.get("arbiter"), "arbiter_metrics": t.get("arbiter_metrics") or [], "ids": t.get("ids") or []}
        for t in parsed["tensions"]
    ]
    return {
        "generated_at": iso(now),
        "days": days,
        "record_at": (newest or {}).get("ts"),
        "goals": out_goals,
        "constraints": constraints,
        "tensions": tensions,
        "human_balance": balance,
    }


# ---------------------------------------------------------------------------
# Evidence packet (Evaluate)
# ---------------------------------------------------------------------------


def _commits_for(workspace: Path, tasks: List[Dict[str, Any]], since: datetime, now: datetime) -> List[Dict[str, Any]]:
    """Commits on the default branch since ``since`` touching a serving task's files."""
    from ..copilot.digest import _norm, git_wins

    files: Dict[str, str] = {}
    for t in tasks:
        for f in t.get("files") or []:
            if isinstance(f, str) and f:
                files.setdefault(_norm(f, str(workspace)), t["id"])
    out = []
    if files:
        for win in git_wins(Path(workspace), since, now + timedelta(seconds=1)):
            hit = next((files[f] for f in win.get("_files") or [] if f in files), None)
            if hit:
                out.append({"ref": win["ref"], "title": win["title"], "at": win["at"], "task_id": hit})
    known = {c["ref"] for c in out}
    for t in tasks:
        closed = parse_time(t.get("closed_at"))
        if closed is None or closed < since:
            continue
        for ref in t.get("commits") or []:
            if ref not in known:
                known.add(ref)
                out.append({"ref": ref, "title": None, "at": t.get("closed_at"), "task_id": t["id"]})
    out.sort(key=lambda c: str(c.get("at") or ""), reverse=True)
    return out[:MAX_PACKET_COMMITS]


def stale_measure(metrics: List[Dict[str, Any]], reading_rows: List[Dict[str, Any]], now: datetime) -> Optional[str]:
    """The first ``measure: op:<name>`` with no reading in the last 24 h."""
    for m in metrics:
        op = m.get("measure")
        if not op:
            continue
        fresh = any(
            (r.get("source") or {}).get("op") == op and (parse_ts(r.get("ts")) or datetime.min.replace(tzinfo=timezone.utc)) >= now - MEASURE_FRESH
            for r in reading_rows
        )
        if not fresh:
            return op
    return None


def evidence_packet(workspace: Path, gid: str, days: int = 7, now: Optional[datetime] = None, items: Optional[Items] = None) -> Optional[Dict[str, Any]]:
    """Everything Evaluate shows the model about one goal; None if the goal is unknown."""
    now = now or utc_now()
    workspace = Path(workspace)
    goals = load_goals_full(workspace)["goals"]
    goal = next((g for g in goals if g["id"] == gid), None)
    if goal is None:
        return None
    items = items or Items(workspace)
    status = build_status(workspace, days, now, items=items)
    gs = next(g for g in status["goals"] if g["id"] == gid)
    records = window_records(metrics_records(workspace), days)
    reading_rows = readings(workspace)
    for m_status, m_def in zip(gs["metrics"], goal["metrics"]):
        m_status["history"] = metric_history(m_def, records, reading_rows)
    since = parse_ts(gs["last_evaluated_at"]) if gs["last_evaluated_at"] else now - timedelta(days=SERVING_CLOSED_DAYS)
    serving_ids = {t["id"] for t in gs["serving"]["tasks"]}
    serving_tasks = [t for t in items.tasks if t["id"] in serving_ids]
    goal_readings = []
    for m in goal["metrics"]:
        for r in _metric_readings(reading_rows, m)[-HISTORY_N:]:
            goal_readings.append({
                "ts": r.get("ts"), "metric": r.get("metric"), "goal_metric": m["name"], "value": r.get("value"),
                "unit": r.get("unit"), "op": (r.get("source") or {}).get("op"),
            })
    return {
        "generated_at": iso(now),
        "goal": {
            "id": goal["id"], "title": goal["title"], "priority": goal["priority"], "prose": goal["prose"],
            "metrics": [
                {k: m.get(k) for k in ("name", "description", "kind", "signal", "available", "target_text", "guard", "measure")}
                for m in goal["metrics"]
            ],
        },
        "metrics": gs["metrics"],
        "flagged": gs["flagged"],
        "measured": gs["measured"],
        "serving": gs["serving"],
        "commits_since": iso(since) if since else None,
        "commits": _commits_for(workspace, serving_tasks, since, now),
        "readings": goal_readings,
        "focus_ms_7d": gs["focus_ms_7d"],
        "human_balance": {"share": status["human_balance"]["share"], "line": status["human_balance"]["line"]},
        "last_evaluated_at": gs["last_evaluated_at"],
        "q2_candidates": q2_candidates(workspace, now, items=items, goals=goals, goal_id=gid),
        "stale_measure": stale_measure(goal["metrics"], reading_rows, now),
    }


def is_goal_id(value: Any) -> bool:
    return isinstance(value, str) and bool(GOAL_ID_RE.match(value))
