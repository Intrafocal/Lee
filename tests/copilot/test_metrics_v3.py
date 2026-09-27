from datetime import datetime, timedelta, timezone

from click.testing import CliRunner

from hester.daemon.cockpit.tasks import CockpitTaskStore, iso_s
from hester.daemon.copilot import metrics

from .conftest import make_event, write_events

T0 = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)
USER = {"kind": "user", "surface": "lee"}


def at(minutes=0.0, hours=0.0, days=0.0):
    return T0 + timedelta(minutes=minutes, hours=hours, days=days)


def active_hour(E, ws, minute=0):
    """An hour bucket counts as active with at_machine plus some input."""
    return E("input.counts", at(minute), {"tab_id": 1, "tab_type": "editor", "keys": 1, "clicks": 0, "wheels": 0, "span_ms": 1000},
             window_id=1, workspace=ws)


def make_tasks(ws):
    store = CockpitTaskStore(ws)
    confirmed, _ = store.upsert({"id": "task-00000001", "title": "Confirmed", "confirmed": True,
                                 "agent": {"session_id": "s-confirmed", "model": "opus"}})
    unconfirmed, _ = store.upsert({"id": "task-00000002", "title": "Auto", "confirmed": False,
                                   "agent": {"session_id": "s-auto"}})
    accepted, _ = store.upsert({"id": "task-00000003", "title": "Accepted", "confirmed": True, "play": True,
                                "agent": {"session_id": "s-acc", "model": "sonnet"}})
    store.close("task-00000003", {"status": "done"})
    rejected, _ = store.upsert({"id": "task-00000004", "title": "Rejected", "confirmed": True,
                                "agent": {"session_id": "s-rej"}})
    store.close("task-00000004", {"status": "done", "accepted": False})
    stale, _ = store.upsert({"id": "task-00000005", "title": "Stale", "status": "running"})
    stale["sessions"] = ["s-stale"]
    store.save(stale, now=at(days=-10))


def test_attributed_accepted_and_lost_threads(tmp_path, events_dir):
    ws = tmp_path / "ws"
    ws.mkdir()
    make_tasks(ws)
    E = make_event
    W = str(ws)
    write_events(events_dir, [
        active_hour(E, W, 1),
        E("agent.turn_end", at(5), {"session_id": "s-confirmed", "pty_id": 1, "busy_ms": 60000}, workspace=W),
        E("agent.turn_end", at(6), {"session_id": "s-auto", "pty_id": 2, "busy_ms": 20000}, workspace=W),
        E("agent.turn_end", at(7), {"session_id": "s-acc", "pty_id": 3, "busy_ms": 30000}, workspace=W),
        E("agent.turn_end", at(8), {"session_id": "s-rej", "pty_id": 4, "busy_ms": 10000}, workspace=W),
        E("agent.turn_end", at(9), {"session_id": "s-nobody", "pty_id": 5, "busy_ms": 80000}, workspace=W),
        E("focus.end", at(50), {"session_id": "f", "reason": "manual", "duration_ms": 3_600_000, "interruptions": 0}, workspace=W),
    ])
    rec = metrics.run(T0, at(hours=1), workspace=W, events_dir=events_dir, now=at(hours=2))
    m = rec["metrics"]
    assert rec["formula_version"] == 6
    assert m["agent_busy_ms"] == 200000
    assert m["attributed_busy_ms"] == 100000  # confirmed + accepted (play counts) + rejected
    assert m["attributed_agent_time"] == 0.5
    assert m["accepted_busy_ms"] == 30000 and m["accepted_tasks"] == 1
    assert m["accepted_task_spend"] == [{"task_id": "task-00000003", "model": "sonnet", "busy_ms": 30000.0,
                                         "tokens": 0, "cost_usd": 0.0, "subscription_value_usd": 0.0}]
    assert m["background_leverage_accepted_ms_per_focus_hour"] == 30000
    assert m["lost_threads"] == 1

    # machine-wide: task files found through the workspaces named by events
    rec = metrics.run(T0, at(hours=1), events_dir=events_dir, now=at(hours=2))
    assert rec["metrics"]["attributed_agent_time"] == 0.5


def test_toil_command_repeats_and_flaky_reruns(tmp_path, events_dir):
    E = make_event
    cmd = lambda ts, sig, by="user", op=None: E("terminal.command", ts, {  # noqa: E731
        "pty_id": 1, "sig": sig, "argv0": "npm", "by": by, "op": op, "exit_code": 0,
        "started_at": "x", "duration_ms": 10, "cwd_rel": None,
    }, workspace="/ws")
    run = lambda ts, rid, op="build", sig="i1": E("operation.run", ts, {  # noqa: E731
        "run_id": rid, "op": op, "kind": "oneshot", "by": "user", "pty_id": 1, "reused_tab": False,
        "confirm_required": False, "inputs_sig": sig,
    }, workspace="/ws")
    res = lambda ts, rid, status, op="build": E("operation.result", ts, {  # noqa: E731
        "run_id": rid, "op": op, "status": status, "exit_code": 0, "duration_ms": 1, "inputs_sig": "i1", "by": "user", "readings": [],
    }, workspace="/ws")
    write_events(events_dir, [
        # 7-day lookback: two earlier hand runs of sig aaa
        cmd(at(days=-6), "aaa"),
        cmd(at(days=-1), "aaa"),
        cmd(at(days=-8), "bbb"),  # too old to count
        cmd(at(days=-1), "bbb"),
        cmd(at(1), "aaa"),  # repeat (2 prior)
        cmd(at(2), "aaa"),  # repeat (3 prior)
        cmd(at(3), "bbb"),  # only 1 prior within 7 days
        cmd(at(4), "ccc", by="lee", op="build"),
        cmd(at(5), "aaa", op="build"),  # typed by an operation: not manual
        run(at(10), "r1"), res(at(11), "r1", "failed"),
        run(at(12), "r2"), res(at(13), "r2", "passed"),  # flaky rerun (previous failed)
        run(at(14), "r3"), res(at(15), "r3", "passed"),  # previous passed: not flaky
        run(at(16), "r4", sig="i2"),  # different inputs: not flaky
        E("ui.ceremony", at(20), {"action": "confirm", "target": "task-confirm"}, actor=USER),
        E("ui.ceremony", at(21), {"action": "confirm", "target": "operations"}, actor=USER),
    ])
    rec = metrics.run(T0, at(hours=1), events_dir=events_dir, now=at(hours=2))
    parts = rec["metrics"]["toil_load_parts"]
    assert parts["command_repeats"] == 2
    assert parts["flaky_reruns"] == 1
    assert parts["ui_ceremony"] == 2
    assert "toil_load.command_repeats" not in rec["unavailable"]


def test_peek_rate_with_cockpit_modes(tmp_path, events_dir):
    E = make_event
    agent = {"tab_id": 3, "tab_type": "terminal", "pty_id": 7, "label": "Claude"}
    editor = {"tab_id": 1, "tab_type": "editor", "file_path": "/ws/a.py", "label": "a.py"}
    write_events(events_dir, [
        E("input.counts", at(0.5), {**editor, "keys": 3, "clicks": 0, "wheels": 0, "span_ms": 1000}, window_id=1),
        E("agent.prompt", at(1), {"session_id": "s1", "pty_id": 7}),
        # focus on the busy agent tab, then the Cockpit covers it after 1 s: not a peek
        E("tab.focus", at(2), agent, window_id=1),
        E("cockpit.mode", at(2) + timedelta(seconds=1), {"from": "workbench", "to": "cockpit", "reason": "hotkey"}, window_id=1),
        # tab.focus events while in the cockpit don't open intervals
        E("tab.focus", at(3), agent, window_id=1),
        E("cockpit.mode", at(4), {"from": "cockpit", "to": "workbench", "reason": "hotkey"}, window_id=1),
        E("tab.focus", at(4.5), editor, window_id=1),
        # go into a busy agent from a tile and just watch: a peek (counted once)
        E("cockpit.go_into", at(5), {"pty_id": 7, "agent_state": "busy", "from": "tile"}, window_id=1),
        E("tab.focus", at(5) + timedelta(seconds=1), agent, window_id=1),
        E("tab.focus", at(5.5), editor, window_id=1),
        # go into a busy agent without a tab.focus: counted from go_into itself
        E("cockpit.go_into", at(6), {"pty_id": 7, "agent_state": "busy", "from": "feed"}, window_id=2),
        E("cockpit.mode", at(6.5), {"from": "workbench", "to": "cockpit", "reason": "hotkey"}, window_id=2),
        # go into a busy agent and type: steering, not a peek
        E("cockpit.go_into", at(7), {"pty_id": 7, "agent_state": "busy", "from": "tile"}, window_id=3),
        E("input.counts", at(7.2), {"tab_id": 3, "pty_id": 7, "tab_type": "terminal", "keys": 4, "clicks": 0, "wheels": 0, "span_ms": 10000}, window_id=3),
        E("cockpit.mode", at(7.5), {"from": "workbench", "to": "cockpit", "reason": "hotkey"}, window_id=3),
        # go into an idle agent: a review, not a peek
        E("cockpit.go_into", at(8), {"pty_id": 7, "agent_state": "idle", "from": "tile"}, window_id=4),
        E("agent.turn_end", at(20), {"session_id": "s1", "pty_id": 7, "busy_ms": 1140000}),
    ])
    rec = metrics.run(T0, at(hours=1), events_dir=events_dir, now=at(hours=2))
    assert rec["metrics"]["peeks"] == 2


def test_nudge_acceptance(events_dir):
    E = make_event
    out = lambda ts, rule, outcome: E("lint.outcome", ts, {"diag_id": "d", "rule": rule, "outcome": outcome})  # noqa: E731
    write_events(events_dir, [
        out(at(1), "toil/repeated-sequence", "fixed"),
        out(at(2), "toil/repeated-sequence", "dismissed"),
        out(at(3), "toil/repeated-sequence", "fixed"),
        out(at(4), "toil/repeat-approval", "ignored"),
        out(at(5), "toil/repeat-approval", "suppressed"),
        out(at(6), "toil/repeat-approval", "resolved"),  # not an outcome of a shown nudge
    ])
    m = metrics.run(T0, at(hours=1), events_dir=events_dir, now=at(hours=2))["metrics"]
    assert m["nudge_acceptance"] == 0.4
    by = m["nudge_acceptance_by_rule"]
    assert by["toil/repeated-sequence"]["acceptance"] == round(2 / 3, 3) and by["toil/repeated-sequence"]["n"] == 3
    assert by["toil/repeat-approval"] == {"acceptance": 0.0, "n": 2, "fixed": 0, "dismissed": 0, "suppressed": 1, "ignored": 1}


def test_cli_prints_v3_metrics(tmp_path, events_dir):
    from hester.cli.goals import goals

    E = make_event
    write_events(events_dir, [
        E("lint.outcome", at(1), {"diag_id": "d", "rule": "r", "outcome": "fixed"}),
        E("agent.turn_end", at(2), {"session_id": "s", "pty_id": 1, "busy_ms": 10}),
    ])
    result = CliRunner().invoke(goals, [
        "metrics", "--since", "2026-09-21T10:00:00Z", "--until", "2026-09-21T11:00:00Z", "--events-dir", str(events_dir),
    ])
    assert result.exit_code == 0, result.output
    assert "attributed_agent_time" in result.output and "nudge_acceptance" in result.output
    assert "formula v6" in result.output


def test_peek_counted_when_tab_focus_is_logged_before_leaving_the_cockpit(tmp_path, events_dir):
    E = make_event
    agent = {"tab_id": 3, "tab_type": "terminal", "pty_id": 7, "label": "Claude"}
    editor = {"tab_id": 1, "tab_type": "editor", "file_path": "/ws/a.py", "label": "a.py"}
    write_events(events_dir, [
        E("agent.prompt", at(1), {"session_id": "s1", "pty_id": 7}),
        E("cockpit.mode", at(2), {"from": "workbench", "to": "cockpit", "reason": "hotkey"}, window_id=1),
        # ⌘3 from the Cockpit: main logs tab.focus a moment before the renderer logs workbench
        E("tab.focus", at(3), agent, window_id=1),
        E("cockpit.mode", at(3) + timedelta(milliseconds=150), {"from": "cockpit", "to": "workbench", "reason": "open_tab"}, window_id=1),
        E("tab.focus", at(3.5), editor, window_id=1),
        E("agent.turn_end", at(20), {"session_id": "s1", "pty_id": 7, "busy_ms": 1140000}),
    ])
    rec = metrics.run(T0, at(hours=1), events_dir=events_dir, now=at(hours=2))
    assert rec["metrics"]["peeks"] == 1
    iv = metrics.focus_intervals([
        {**e, "_ts": datetime.fromisoformat(e["ts"].replace("Z", "+00:00"))} for e in [
            E("cockpit.mode", at(2), {"to": "cockpit"}, window_id=1),
            E("tab.focus", at(3), agent, window_id=1),
            E("cockpit.mode", at(4), {"to": "workbench"}, window_id=1),
        ]
    ], at(5))
    assert iv == [], "a tab.focus long before leaving the Cockpit is not an interval"
