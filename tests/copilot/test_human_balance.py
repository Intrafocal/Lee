"""Copilot v4: human_balance (formula v4) attribution and bands."""

from datetime import datetime, timedelta, timezone

from hester.daemon.copilot import metrics

from .conftest import make_event

T0 = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)
WS = "/ws"
GOALS = {WS: [{"id": "G1", "priority": 0}, {"id": "G2", "priority": 1}]}
MIN = 60_000


def at(m: float) -> datetime:
    return T0 + timedelta(minutes=m)


def E(type, m, data=None, window_id=1):
    ev = make_event(type, at(m), data or {}, workspace=WS, window_id=window_id)
    ev["_ts"] = at(m)
    return ev


def task(tid, **kw):
    t = {
        "id": tid, "workspace": WS, "title": tid, "status": "running", "play": False, "serves": [], "files": [],
        "sessions": [], "agent": None, "overrides": None, "urgency_cleared_at": None, "origin": None, "due": None,
        "created_at": "2026-09-20T00:00:00Z", "updated_at": "2026-09-20T00:00:00Z", "closed_at": None,
    }
    t.update(kw)
    return t


def scenario():
    tasks = [
        task("task-a", serves=["G1"], sessions=["s1"]),                               # Q2 via its agent pty
        task("task-b", play=True),                                                    # play via focus item
        task("task-c", status="waiting", files=["/ws/src/x.py"], updated_at="2026-09-21T09:00:00Z"),  # Q3
        task("task-d", serves=["G2"], files=["/ws/src/x.py"], updated_at="2026-09-20T09:00:00Z"),     # older
        task("task-e", serves=["G2"], files=["/ws/other.py"], status="done", closed_at="2026-09-21T09:00:00Z"),
    ]
    events = [E("agent.session_start", -1, {"session_id": "s1", "pty_id": 5})]
    events.append(E("tab.focus", 0, {"tab_id": 1, "pty_id": 5, "tab_type": "claude"}))
    events.append(E("focus.start", 10, {"session_id": "f1", "source": "manual", "surface": "lee",
                                        "item": {"kind": "task", "workspace": WS, "task_id": "task-b", "label": "B"}}))
    events.append(E("focus.end", 20, {"session_id": "f1", "duration_ms": 600000, "interruptions": 0}))
    events.append(E("tab.focus", 20, {"tab_id": 2, "tab_type": "editor", "file_path": "/ws/src/x.py"}))
    events.append(E("tab.focus", 30, {"tab_id": 3, "tab_type": "editor", "file_path": "/ws/other.py"}))
    # input in every minute 0..39, none after (the last 20 minutes are idle)
    for m in range(40):
        events.append(E("input.counts", m + 0.5, {"tab_id": 1, "keys": 3, "clicks": 0, "span_ms": 1000}))
    # another window's input doesn't make window 1 active
    events.append(E("input.counts", 45.5, {"tab_id": 9, "keys": 3}, window_id=2))
    events.sort(key=lambda e: e["_ts"])
    return events, tasks


def test_attribution_precedence_and_bands():
    events, tasks = scenario()
    out = metrics.human_balance(events, T0, at(60), tasks, GOALS)
    assert out["human_balance_ms"] == {"Q1": 0, "Q2": 10 * MIN, "Q3": 10 * MIN, "Q4": 0, "play": 10 * MIN,
                                       "unclassified": 10 * MIN}
    assert out["human_balance"] == round(10 / 30, 3)
    assert out["human_balance_by_goal"] == {"G1": 10 * MIN}


def test_task_serving_two_goals_counts_for_both():
    events, tasks = scenario()
    tasks[0]["serves"] = ["G1", "G2"]
    out = metrics.human_balance(events, T0, at(60), tasks, GOALS)
    assert out["human_balance_by_goal"] == {"G1": 10 * MIN, "G2": 10 * MIN}


def test_focus_time_clipped_to_input_minutes():
    events = [E("tab.focus", 0, {"tab_id": 2, "tab_type": "editor", "file_path": "/ws/a.py"}),
              E("input.counts", 5.2, {"tab_id": 2, "keys": 0, "clicks": 2})]
    out = metrics.human_balance(events, T0, at(60), [], GOALS)
    assert out["human_balance_ms"]["unclassified"] == MIN
    assert out["human_balance"] is None  # unclassified is excluded; no denominator


def test_no_focus_time():
    out = metrics.human_balance([], T0, at(60), [], GOALS)
    assert out["human_balance"] is None and sum(out["human_balance_ms"].values()) == 0
    assert out["human_balance_by_goal"] == {}


def test_compute_metrics_includes_human_balance():
    events, tasks = scenario()
    m = metrics.compute_metrics(events, T0, at(60), tasks=tasks, goals=GOALS)
    assert m["human_balance"] == round(10 / 30, 3)
    assert "human_balance_ms" in m and "human_balance_by_goal" in m
    assert metrics.FORMULA_VERSION == 5 and "human_balance.goal_linked" not in metrics.UNAVAILABLE
