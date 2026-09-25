import json
from datetime import datetime, timedelta, timezone

import pytest
from click.testing import CliRunner

from hester.daemon.copilot import metrics
from hester.daemon.copilot.event_reader import read_events

from .conftest import make_event, write_events

T0 = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)
WS = "/ws"


def at(minutes: float = 0, hours: float = 0) -> datetime:
    return T0 + timedelta(minutes=minutes, hours=hours)


def tab(tab_id, tab_type, pty=None, file_path=None):
    d = {"tab_id": tab_id, "tab_type": tab_type, "label": f"tab{tab_id}"}
    if pty is not None:
        d["pty_id"] = pty
    if file_path:
        d["file_path"] = file_path
    return d


def counts(tab_d, keys, clicks=0, span_ms=60000):
    return {**tab_d, "keys": keys, "clicks": clicks, "wheels": 0, "span_ms": span_ms}


EDITOR = tab(1, "editor", file_path="/ws/a.py")
AGENT = tab(3, "terminal", pty=7)
USER = {"kind": "user", "surface": "lee"}


def scenario():
    E = make_event
    return [
        # 24 h lookback: an earlier approval of the same tool signature
        E("attention.reply", at(hours=-2), {"item_id": "a0", "kind": "approval", "action": "approve", "tool_signature": "abc", "text_chars": 0, "latency_ms": 1}, actor=USER),
        # agent busy from +1m to +10m
        E("agent.prompt", at(1), {"session_id": "s1", "pty_id": 7, "prompt_chars": 12}),
        # peek: 30 s on the busy agent tab, no keys
        E("tab.focus", at(2), AGENT, window_id=1),
        E("tab.focus", at(2.5), EDITOR, window_id=1),
        # too short (1 s)
        E("tab.focus", at(3), AGENT, window_id=1),
        E("tab.focus", at(3, ) + timedelta(seconds=1), EDITOR, window_id=1),
        # typed into the agent tab: steering, not a peek
        E("tab.focus", at(4), AGENT, window_id=1),
        E("input.counts", at(4) + timedelta(seconds=50), counts(AGENT, 5, span_ms=50000), window_id=1),
        E("tab.focus", at(5), EDITOR, window_id=1),
        E("input.counts", at(6), counts(EDITOR, 100, 10), window_id=1),
        E("agent.turn_end", at(10), {"session_id": "s1", "pty_id": 7, "busy_ms": 540000, "summary": "done"}),
        # looking after the turn ended: not a peek
        E("tab.focus", at(11), AGENT, window_id=1),
        E("tab.focus", at(12), EDITOR, window_id=1),
        # toil
        E("ui.ceremony", at(15), {"action": "confirm", "target": "pairing"}, actor=USER),
        E("attention.snooze", at(16), {"item_id": "x1", "until": "change"}, actor=USER),
        E("attention.dismiss", at(17), {"item_id": "x2"}, actor=USER),
        E("handoff.start", at(18), {"handoff_id": "h1"}, actor=USER),
        E("attention.reply", at(20), {"item_id": "a1", "kind": "approval", "action": "approve", "tool_signature": "abc", "text_chars": 0, "latency_ms": 1000}, actor=USER),
        E("attention.reply", at(30), {"item_id": "a2", "kind": "approval", "action": "approve", "tool_signature": "abc", "text_chars": 0, "latency_ms": 1000}, actor=USER),
        E("attention.reply", at(40), {"item_id": "a3", "kind": "waiting", "action": "text", "text_chars": 20, "latency_ms": 3000}, actor=USER),
        E("capture", at(50), {"someday_id": "sd_1", "text_chars": 10, "as": "someday", "spooled": False}, actor=USER),
        # second active hour
        E("input.counts", at(70), counts(EDITOR, 20), window_id=1),
        # return after 45 min away, first steering action 5 min later
        E("presence.change", at(hours=2), {"from": {"at_machine": False}, "to": {"at_machine": True}, "reason": "os_active", "away_ms": 45 * 60000}),
        E("focus.start", at(125), {"session_id": "f1", "source": "manual", "item": {"kind": "workspace", "workspace": WS}, "surface": "lee"}, focus_session_id="f1", actor=USER),
        E("attention.escalate", at(130), {"item_id": "b1", "from": "needs-you", "to": "blocking", "reason": "focus", "surfaced": True, "during_focus": True}, focus_session_id="f1"),
        E("focus.end", at(155), {"session_id": "f1", "reason": "manual", "duration_ms": 1800000, "interruptions": 1}, focus_session_id="f1"),
        # attention latency
        E("attention.resolve", at(21), {"item_id": "a1", "kind": "approval", "resolution": "reply", "latency_ms": 1000}),
        E("attention.resolve", at(41), {"item_id": "a3", "kind": "waiting", "resolution": "answered_in_tab", "latency_ms": 3000}),
        E("attention.resolve", at(42), {"item_id": "r1", "kind": "review", "resolution": "reply", "latency_ms": 99999}),
        E("attention.resolve", at(43), {"item_id": "d1", "kind": "decision", "resolution": "superseded", "latency_ms": 5000}),
        # devices
        E("device.request", at(60), {"device_id": "dev_a", "device_kind": "aeronaut", "method": "POST", "route": "/capture", "status": 200, "category": "capture"}),
        E("device.request", at(61), {"device_id": "dev_a", "device_kind": "aeronaut", "method": "POST", "route": "/attention/:id/reply", "status": 200, "category": "approve"}),
        E("device.views", at(62), {"device_id": "dev_a", "device_kind": "aeronaut", "count": 3, "window_s": 60}),
        E("device.request", at(63), {"device_id": "legacy:1.2.3.4", "device_kind": "legacy", "method": "POST", "route": "/command", "status": 200, "category": "command"}),
        # model calls
        E("model.call", at(80), {"provider": "gemini", "model": "m", "op": "generate", "location": "cloud", "trigger": {"kind": "user"}, "ok": True}, source="hester"),
        E("model.call", at(81), {"provider": "gemini", "model": "m", "op": "embed", "location": "cloud", "trigger": {"kind": "automatic", "name": "x"}, "ok": True}, at_machine=False, source="hester"),
        E("model.call", at(82), {"provider": "ollama", "model": "g", "op": "generate", "location": "local", "trigger": {"kind": "unknown"}, "ok": True}, source="hester"),
        # a reply not caused by a human (structurally impossible, but counted)
        E("attention.reply", at(hours=3), {"item_id": "z", "kind": "approval", "action": "deny", "text_chars": 0, "latency_ms": 1}, actor={"kind": "hester"}),
        # outside the window
        E("capture", at(hours=5), {"someday_id": "sd_9", "text_chars": 1, "as": "someday", "spooled": False}, actor=USER),
    ]


@pytest.fixture
def record(events_dir):
    write_events(events_dir, scenario())
    return metrics.run(T0, T0 + timedelta(hours=4), events_dir=events_dir, now=T0 + timedelta(hours=6))


def test_reader_sorts_and_filters(events_dir):
    write_events(events_dir, scenario())
    (events_dir / "garbage.txt").write_text("x")
    with open(next(events_dir.glob("*.jsonl")), "a") as f:
        f.write("not json\n{\"type\": \"x\"}\n")
    evs = read_events(since=T0, until=T0 + timedelta(hours=4), directory=events_dir)
    assert all(T0 <= e["_ts"] < T0 + timedelta(hours=4) for e in evs)
    assert [e["_ts"] for e in evs] == sorted(e["_ts"] for e in evs)
    only = read_events(directory=events_dir, types={"focus.end"})
    assert [e["type"] for e in only] == ["focus.end"]


def test_record_shape(record):
    assert record["formula_version"] == 2
    assert record["workspace"] is None
    assert record["from"] == "2026-09-21T10:00:00.000Z"
    assert set(record["unavailable"]) == {"background_leverage.accepted", "toil_load.command_repeats"}


def test_active_hours_and_peek_rate(record):
    m = record["metrics"]
    assert m["active_hours"] == 2
    assert m["peeks"] == 1
    assert m["peek_rate"] == 0.5


def test_toil_load(record):
    m = record["metrics"]
    assert m["toil_load_parts"] == {"ui_ceremony": 1, "snooze": 1, "dismiss": 1, "handoff_start": 1, "repeated_approvals": 2}
    assert m["toil_load"] == 3.0


def test_creative_share(record):
    # creative: editor keys+clicks 110 + 20, text reply 1, capture 1 = 132
    # managing: agent-tab keys while busy 5, approvals 2, hester deny 1, peeks 1 = 9
    assert record["metrics"]["creative_share"] == round(132 / 141, 3)


def test_catch_up_time(record):
    assert record["metrics"]["catch_up_time_ms"] == 5 * 60000
    assert record["metrics"]["catch_up_returns"] == 1


def test_focus_interruptions(record):
    m = record["metrics"]
    assert m["focus_interruptions_avg"] == 1.0
    assert m["focus_sessions"] == 1
    assert m["focus_interruptions_crosscheck_mismatches"] == 0


def test_background_leverage(record):
    assert record["metrics"]["background_leverage_busy_ms_per_focus_hour"] == 1080000


def test_device_creative_share(record):
    m = record["metrics"]
    assert m["device_creative_share_by_device"] == {"dev_a": round(1 / 3, 3), "legacy:1.2.3.4": 0.0}
    assert m["device_creative_share"] == 0.25


def test_attention_latency(record):
    assert record["metrics"]["attention_latency_ms"] == 2000
    assert record["metrics"]["attention_resolved"] == 2


def test_constraints(record):
    m = record["metrics"]
    assert m["c1_violations"] == 1
    assert m["c2_violations"] == 1
    assert m["c3_violations"] == 1


def test_capture_pickup(events_dir):
    E = make_event
    device = {"kind": "user", "surface": "device", "device_id": "dev_a", "device_kind": "aeronaut"}
    evs = [
        E("capture", at(hours=-24 * 20), {"someday_id": "sd_a", "text_chars": 3, "as": "someday", "spooled": False}, actor=device, at_machine=False),
        E("someday.triage", at(hours=-24 * 15), {"someday_id": "sd_a", "action": "explore", "age_ms": 1}, source="hester"),
        E("capture", at(hours=-24 * 19), {"someday_id": "sd_b", "text_chars": 3, "as": "someday", "spooled": False}, actor=USER, at_machine=False),
        E("someday.triage", at(hours=-24 * 1), {"someday_id": "sd_b", "action": "drop", "age_ms": 1}, source="hester"),
        # at the machine, from Lee: not eligible
        E("capture", at(hours=-24 * 18), {"someday_id": "sd_c", "text_chars": 3, "as": "someday", "spooled": False}, actor=USER, at_machine=True),
        # too recent to judge
        E("capture", at(hours=-24 * 2), {"someday_id": "sd_d", "text_chars": 3, "as": "someday", "spooled": False}, actor=device, at_machine=False),
    ]
    write_events(events_dir, evs)
    rec = metrics.run(T0 - timedelta(days=30), T0, events_dir=events_dir, now=T0)
    assert rec["metrics"]["capture_pickup_eligible"] == 2
    assert rec["metrics"]["capture_pickup"] == 0.5


def test_workspace_filter(events_dir):
    E = make_event
    evs = [
        E("attention.resolve", at(1), {"item_id": "a", "kind": "approval", "resolution": "reply", "latency_ms": 100}, workspace="/ws"),
        E("attention.resolve", at(2), {"item_id": "b", "kind": "approval", "resolution": "reply", "latency_ms": 900}, workspace="/other"),
    ]
    write_events(events_dir, evs)
    rec = metrics.run(T0, T0 + timedelta(hours=1), workspace="/ws", events_dir=events_dir, now=T0 + timedelta(hours=1))
    assert rec["workspace"] == "/ws"
    assert rec["metrics"]["attention_latency_ms"] == 100


def test_empty_log_is_all_none(tmp_path):
    rec = metrics.run(T0, T0 + timedelta(hours=1), events_dir=tmp_path / "nothing", now=T0 + timedelta(hours=1))
    m = rec["metrics"]
    assert m["active_hours"] == 0
    assert m["peek_rate"] is None and m["attention_latency_ms"] is None and m["creative_share"] is None


def test_cli_write(events_dir, tmp_path):
    from hester.cli.goals import goals

    write_events(events_dir, scenario())
    ws = tmp_path / "proj"
    ws.mkdir()
    result = CliRunner().invoke(goals, [
        "metrics", "--since", "2026-09-21T10:00:00Z", "--until", "2026-09-21T14:00:00Z",
        "--events-dir", str(events_dir), "--workspace", str(ws), "--write",
    ])
    assert result.exit_code == 0, result.output
    lines = (ws / ".hester" / "goals" / "metrics.jsonl").read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["formula_version"] == 2
    assert rec["workspace"] == str(ws.resolve())
    assert "peek_rate" in rec["metrics"]


def test_capture_pickup_ignores_keep_and_unlinked_spool(events_dir):
    E = make_event
    device = {"kind": "user", "surface": "device", "device_id": "dev_a", "device_kind": "aeronaut"}
    evs = [
        # 'keep' defers the idea: reviewed, but not acted on
        E("capture", at(hours=-24 * 20), {"someday_id": "sd_k", "text_chars": 3, "as": "someday", "spooled": False}, actor=device, at_machine=False),
        E("someday.triage", at(hours=-24 * 19), {"someday_id": "sd_k", "action": "keep", "age_ms": 1}, source="hester"),
        # promoted within 14 days: picked up
        E("capture", at(hours=-24 * 20), {"someday_id": "sd_p", "text_chars": 3, "as": "someday", "spooled": False}, actor=device, at_machine=False),
        E("someday.triage", at(hours=-24 * 18), {"someday_id": "sd_p", "action": "promote", "age_ms": 1}, source="hester"),
        # spooled while Hester was down: no someday_id to join on, not eligible
        E("capture", at(hours=-24 * 20), {"text_chars": 3, "as": "someday", "spooled": True}, actor=device, at_machine=False),
    ]
    write_events(events_dir, evs)
    rec = metrics.run(T0 - timedelta(days=30), T0, events_dir=events_dir, now=T0)
    assert rec["metrics"]["capture_pickup_eligible"] == 2
    assert rec["metrics"]["capture_pickup"] == 0.5
