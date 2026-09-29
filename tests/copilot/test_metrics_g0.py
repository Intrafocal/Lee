"""Deep D1 (contract section 10.2): the G0 metrics, formula v6."""

from datetime import datetime, timedelta, timezone

from hester.daemon.copilot import metrics

from .conftest import make_event, write_events

T0 = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)
E = make_event


def at(minutes=0.0, hours=0.0, days=0.0):
    return T0 + timedelta(minutes=minutes, hours=hours, days=days)


def active(minute=0.0, hours=0.0):
    return E("input.counts", at(minute, hours), {"tab_id": 1, "tab_type": "editor", "keys": 1, "clicks": 0, "wheels": 0, "span_ms": 1000})


def deep_input(t, sid, keys=10, span_ms=60000):
    return E("deep.input", t, {"exploration_id": "exp-0a0b0c0d", "view": "page", "keys": keys, "clicks": 0, "wheels": 0,
                               "span_ms": span_ms}, focus_session_id=sid)


def deep_start(t, sid):
    return E("focus.start", t, {"session_id": sid, "source": "deep", "policy": "none",
                                "item": {"kind": "exploration", "workspace": "/w", "exploration_id": "exp-0a0b0c0d", "title": "t"}})


def deep_end(t, sid, rating=None, interruptions=0):
    return E("focus.end", t, {"session_id": sid, "reason": "deep_end", "deep_rating": rating, "interruptions": interruptions,
                              "duration_ms": 1000})


def run(events_dir, events, start=T0, end=None):
    write_events(events_dir, events)
    end = end or at(hours=2)
    rec = metrics.run(start, end, events_dir=events_dir, now=end + timedelta(minutes=1))
    assert rec["formula_version"] == 6 == metrics.FORMULA_VERSION
    return rec["metrics"]


def test_turn_churn_with_session_fallback(events_dir):
    m = run(events_dir, [
        active(1),
        # session s1: a prompt 60 s after the turn ended is churn; the next one (no turn_end between) isn't
        E("agent.turn_end", at(10), {"session_id": "s1", "pty_id": 1}),
        E("agent.prompt", at(11), {"session_id": "s1", "pty_id": 1}),
        E("agent.prompt", at(11.5), {"session_id": "s1", "pty_id": 1}),
        # too late: 5 minutes after
        E("agent.turn_end", at(20), {"session_id": "s1", "pty_id": 1}),
        E("agent.prompt", at(25), {"session_id": "s1", "pty_id": 1}),
        # pty 2's prompt has no session_id: it joins s2 through the pty
        E("agent.turn_end", at(30), {"session_id": "s2", "pty_id": 2}),
        E("agent.prompt", at(31), {"pty_id": 2}),
        # a different session's turn_end doesn't make s3's prompt churn
        E("agent.turn_end", at(40), {"session_id": "s4", "pty_id": 4}),
        E("agent.prompt", at(40.5), {"session_id": "s3", "pty_id": 3}),
    ])
    assert m["turn_churn"] == {"value": 2.0, "count": 2, "active_hours": 1}


def test_deep_time_scaled_to_seven_days(events_dir):
    m = run(events_dir, [
        deep_input(at(5), "f1", span_ms=30 * 60000),
        deep_input(at(40), "f1", span_ms=30 * 60000),
        deep_input(at(70), "f2", keys=0, span_ms=30 * 60000),  # no input: not counted
    ], end=at(days=1))
    dt = m["deep_time"]
    assert dt["minutes"] == 60.0 and dt["sessions"] == 1
    assert dt["value"] == 420.0, "60 minutes in one day is 420 per 7 days"


def test_time_to_deep_uses_rated_sessions_and_the_stretch_start(events_dir):
    m = run(events_dir, [
        # Lee starts at 10:00 (nothing before it): the stretch starts here
        active(0),
        deep_start(at(5), "f1"),
        deep_input(at(8), "f1"),                       # 8 min after the stretch start
        deep_end(at(30), "f1", rating="deep"),
        # away for 40 minutes, back at 11:10
        E("presence.change", at(70), {"from": {"at_machine": False}, "to": {"at_machine": True}, "away_ms": 40 * 60000}),
        deep_start(at(71), "f2"),
        deep_input(at(72), "f2"),                      # 2 min after the return
        deep_end(at(90), "f2", rating="deep"),
        # rated mixed: not counted
        deep_start(at(95), "f3"),
        deep_input(at(96), "f3"),
        deep_end(at(100), "f3", rating="mixed"),
    ])
    assert m["time_to_deep"] == {"value_s": 300.0, "n": 2}, "median of 480 s and 120 s"


def test_time_to_deep_null_without_rated_sessions(events_dir):
    m = run(events_dir, [active(0), deep_start(at(1), "f1"), deep_input(at(2), "f1"), deep_end(at(3), "f1")])
    assert m["time_to_deep"] == {"value_s": None, "n": 0}


def test_session_depth_and_deep_interruptions(events_dir):
    m = run(events_dir, [
        active(0),
        deep_start(at(1), "a"), deep_end(at(2), "a", "deep"),
        deep_start(at(3), "b"), deep_end(at(4), "b", "deep"),
        deep_start(at(5), "c"), deep_end(at(6), "c", "shallow"),
        deep_start(at(7), "d"), deep_end(at(8), "d", None),
        # a manual focus session with interruptions: not Deep
        E("focus.start", at(10), {"session_id": "m", "source": "manual"}),
        E("focus.end", at(20), {"session_id": "m", "reason": "manual", "interruptions": 3, "duration_ms": 600000}),
    ])
    assert m["session_depth"] == {"deep": 2, "mixed": 0, "shallow": 1, "unrated": 1, "share_deep": 0.667}
    assert m["focus_interruptions_deep"] == 0 and m["focus_interruptions_max"] == 3
    assert m["focus_sessions"] == 5


def test_empty_window_reads_null(events_dir):
    m = run(events_dir, [])
    assert m["session_depth"]["share_deep"] is None and m["time_to_deep"]["value_s"] is None
    assert m["turn_churn"]["value"] is None and m["deep_time"]["minutes"] == 0.0
