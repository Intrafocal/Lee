"""docs/15-Usage.md §5: aggregation, /cockpit/usage, per-task usage and the accepted-spend guard."""

from datetime import datetime, timedelta, timezone

import re
import pytest

from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.copilot import metrics, usage

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import make_event, write_events
from .test_follower import env, tick  # noqa: F401

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def claude_turn(ts, sid, *items, provider="claude", ws=None):
    return make_event("agent.usage", ts, {"session_id": sid, "pty_id": 3, "provider": provider, "by_model": list(items)},
                      workspace=ws)


def u(model, basis, cost=None, **tokens):
    out = {"provider": "anthropic", "model": model, "tokens": tokens, "cost_basis": basis}
    if cost is not None:
        out["cost_usd"] = cost
    return out


def hester_call(ts, kind, location, usage_obj=None):
    d = {"provider": "gemini" if location == "cloud" else "ollama", "model": "m", "op": "generate",
         "location": location, "trigger": {"kind": kind}, "ok": True}
    if usage_obj is not None:
        d["usage"] = usage_obj
    return make_event("model.call", ts, d, actor={"kind": "hester"})


def limits(ts, five, seven, resets="2026-09-27T19:40:00Z"):
    return make_event("limits.snapshot", ts, {
        "source": "claude", "session_id": "s1",
        "five_hour": {"used_pct": five, "resets_at": resets}, "seven_day": {"used_pct": seven, "resets_at": None},
    })


# ---------------------------------------------------------------- accumulate


def test_accumulate_sums_models_and_keeps_bases_apart():
    acc = usage.accumulate(None, [u("claude-opus-5", "subscription", 1.5, input=2, output=300, cache_read=9000, cache_write=700)])
    assert acc["shown_tokens"] == 1002 and acc["cost_basis"] == "subscription"
    assert "cost_usd" not in acc  # never shown as dollars
    acc = usage.accumulate(acc, [u("claude-haiku-4-5", "subscription", 0.1, input=10, output=10),
                                 u("claude-opus-5", "subscription", 0.5, output=100, thinking=40)])
    assert acc["tokens"] == {"input": 12, "output": 410, "cache_read": 9000, "cache_write": 700, "thinking": 40}
    assert acc["shown_tokens"] == 1122
    assert [m["model"] for m in acc["by_model"]] == ["claude-haiku-4-5", "claude-opus-5"]
    assert usage.accumulate(acc, []) is acc and usage.accumulate(acc, "junk") is acc

    billed = usage.accumulate(None, [u("pi-model", "billed", 0.25, input=100, output=50)])
    billed = usage.accumulate(billed, [u("pi-model", "billed", 0.5, input=100)])
    assert billed["cost_basis"] == "billed" and billed["cost_usd"] == 0.75 and billed["shown_tokens"] == 250
    assert billed["by_model"] == [{"model": "pi-model", "tokens": {"input": 200, "output": 50}, "cost_usd": 0.75}]

    # an early estimate turn (before the status line) in a subscription session
    mixed = usage.accumulate(None, [u("claude-opus-5", "estimate", 0.2, input=1)])
    mixed = usage.accumulate(mixed, [u("claude-opus-5", "subscription", 9.0, input=1)])
    assert mixed["cost_basis"] == "subscription" and mixed["bases"] == ["estimate", "subscription"]
    assert mixed["spend_usd"] == 0.2 and "cost_usd" not in mixed


def test_merge_usage():
    a = usage.accumulate(None, [u("m", "billed", 1.0, input=10)])
    b = usage.accumulate(None, [u("m", "billed", 2.0, output=5)])
    merged = usage.merge_usage(a, b)
    assert merged["cost_usd"] == 3.0 and merged["tokens"] == {"input": 10, "output": 5}
    assert usage.merge_usage(None, b) is b and usage.merge_usage(a, None) is a


# ---------------------------------------------------------------- compute_usage


def test_totals_split_by_basis_and_source(events_dir):
    today = NOW - timedelta(minutes=30)
    write_events(events_dir, [
        claude_turn(today, "s-sub", u("claude-opus-5", "subscription", 4.0, input=100, output=900, cache_read=50000)),
        claude_turn(today, "s-sub", u("claude-opus-5", "subscription", 2.0, output=100, cache_write=1000)),
        claude_turn(today, "s-pi", u("gpt-x", "billed", 0.30, input=1000, output=500), provider="pi"),
        claude_turn(today, "s-key", u("claude-sonnet-4-6", "billed", 0.10, input=10, output=10)),
        hester_call(today, "user", "cloud", {"provider": "google", "model": "gemini-2.5-flash", "tokens": {"input": 400, "output": 100},
                                             "cost_usd": 0.02, "cost_basis": "estimate"}),
        hester_call(today, "automatic", "cloud", {"provider": "google", "model": "gemini-next", "tokens": {"input": 50, "output": 5},
                                                  "cost_basis": "estimate"}),
        hester_call(today, "unknown", "local", {"provider": "ollama", "model": "gemma", "tokens": {"input": 30, "output": 3},
                                                "cost_basis": "local", "duration_ms": 900.0}),
        hester_call(today, "automatic", "cloud"),  # no usage: counted as a call, no tokens
        claude_turn(NOW - timedelta(days=3), "s-old", u("claude-opus-5", "billed", 5.0, input=1)),
    ])
    data = usage.run("today", events_dir=events_dir, now=NOW)
    t = data["totals"]
    assert t["spend_usd"] == pytest.approx(0.30 + 0.10 + 0.02)
    assert t["subscription_tokens"] == 100 + 900 + 100 + 1000
    assert t["local_tokens"] == 33 and t["local_ms"] == 900.0
    assert t["unpriced_tokens"] == 55
    src = t["by_source"]
    assert src["claude"]["spend_usd"] == pytest.approx(0.10) and src["claude"]["subscription_tokens"] == 2100
    assert src["claude"]["count"] == 3 and src["pi"]["spend_usd"] == pytest.approx(0.30)
    assert src["hester_cloud"]["count"] == 3 and src["hester_cloud"]["spend_usd"] == pytest.approx(0.02)
    assert src["hester_local"]["local_tokens"] == 33
    # subscription dollars never appear anywhere in the response
    # (timestamps left out: "…:56.000Z" would match)
    r = re.sub(r"\d{4}-\d\d-\d\dT[\d:.]+Z", "", repr(data))
    assert "6.0" not in r and "4.0" not in r
    h = data["hester"]
    assert h["user"]["calls"] == 1 and h["user"]["spend_usd"] == pytest.approx(0.02)
    assert h["automatic"]["calls"] == 3 and h["automatic"]["cloud_calls"] == 2 and h["automatic"]["local_calls"] == 1
    assert h["unknown_trigger_calls"] == 1
    assert len(data["by_day"]) == 1 and data["by_day"][0]["day"] == NOW.astimezone().strftime("%Y-%m-%d")

    week = usage.run("week", events_dir=events_dir, now=NOW)
    assert len(week["by_day"]) == 7
    assert week["totals"]["spend_usd"] == pytest.approx(5.42)
    old_day = (NOW - timedelta(days=3)).astimezone().strftime("%Y-%m-%d")
    assert next(d for d in week["by_day"] if d["day"] == old_day)["spend_usd"] == pytest.approx(5.0)
    with pytest.raises(ValueError):
        usage.run("year", events_dir=events_dir, now=NOW)


def test_today_carries_a_seven_day_baseline(events_dir):
    midnight = NOW.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    write_events(events_dir, [
        claude_turn(NOW, "s-today", u("claude-opus-5", "subscription", input=10)),
        # two of the previous seven days
        claude_turn(midnight - timedelta(hours=2), "s-a", u("claude-opus-5", "subscription", output=700)),
        claude_turn(midnight - timedelta(days=6, hours=-1), "s-b", u("claude-opus-5", "billed", 0.7, output=700)),
        hester_call(midnight - timedelta(days=3), "user", "cloud"),
        # outside the baseline
        claude_turn(midnight - timedelta(days=8), "s-old", u("claude-opus-5", "subscription", output=9999)),
    ])
    b = usage.run("today", events_dir=events_dir, now=NOW)["baseline"]
    # tokens first seen 6 days back; the one call 3 days back
    assert b["days"] == 7 and b["days_with_data"] == 3
    assert b["token_days"] == 6 and b["call_days"] == 6
    assert b["totals"]["shown_tokens"] == pytest.approx(1400 / 6, abs=0.1)
    assert b["totals"]["by_source"]["claude"]["subscription_tokens"] == pytest.approx(700 / 6, abs=0.1)
    assert b["totals"]["spend_usd"] == pytest.approx(0.7 / 6, abs=1e-5)
    assert b["hester"]["user"]["calls"] == pytest.approx(1 / 6, abs=0.05)
    assert "baseline" not in usage.run("week", events_dir=events_dir, now=NOW)


def test_baseline_averages_only_since_tokens_were_recorded(events_dir):
    midnight = NOW.astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    write_events(events_dir, [
        hester_call(midnight - timedelta(days=5), "user", "cloud"),  # the call log predates usage capture
        claude_turn(midnight - timedelta(hours=3), "s", u("claude-opus-5", "subscription", output=500)),
        claude_turn(midnight - timedelta(hours=2), "p", u("gemma", "billed", 0, input=90), provider="pi"),
    ])
    b = usage.run("today", events_dir=events_dir, now=NOW)["baseline"]
    assert b["token_days"] == 1 and b["call_days"] == 5
    assert b["totals"]["by_source"]["claude"]["shown_tokens"] == 500.0
    assert b["hester"]["user"]["calls"] == pytest.approx(0.2)


def test_ollama_usage_is_local_whatever_its_basis(events_dir):
    local = {**u("gemma4:e4b", "billed", 0, input=900, output=100), "provider": "ollama"}
    write_events(events_dir, [claude_turn(NOW, "p", local, provider="pi")])
    pi = usage.run("today", events_dir=events_dir, now=NOW)["totals"]["by_source"]["pi"]
    assert pi["local_tokens"] == 1000 and pi["spend_usd"] == 0 and pi["unpriced_tokens"] == 0


def test_limits_latest_with_age(events_dir):
    write_events(events_dir, [
        limits(NOW - timedelta(hours=3), 40, 10),
        limits(NOW - timedelta(minutes=20), 62, 18),
        make_event("limits.snapshot", NOW - timedelta(minutes=1), {"source": "claude"}),  # no windows: ignored
    ])
    got = usage.run("today", events_dir=events_dir, now=NOW)["limits"]
    # the newest event lacks windows, so the one before it is the latest
    assert got["five_hour"]["used_pct"] == 62 and got["age_s"] == 1200
    write_events(events_dir, [limits(NOW - timedelta(seconds=30), 63, 18)])
    got = usage.run("today", events_dir=events_dir, now=NOW)["limits"]
    assert got["five_hour"] == {"used_pct": 63, "resets_at": "2026-09-27T19:40:00Z"}
    assert got["seven_day"] == {"used_pct": 18, "resets_at": None}
    assert got["age_s"] == 30 and got["as_of"].endswith("Z")
    assert usage.run("today", events_dir=events_dir / "none", now=NOW)["limits"] is None


def test_top_tasks_by_cost(tmp_path, events_dir):
    ws = tmp_path / "ws"
    ws.mkdir()
    store = CockpitTaskStore(ws)
    store.upsert({"id": "task-000000a1", "title": "Cheap", "agent": {"session_id": "s1"}})
    store.upsert({"id": "task-000000a2", "title": "Dear", "agent": {"session_id": "s2"}})
    write_events(events_dir, [
        claude_turn(NOW - timedelta(minutes=5), "s1", u("m", "subscription", 3.0, input=5000), ws=str(ws)),
        claude_turn(NOW - timedelta(minutes=4), "s2", u("m", "billed", 1.0, input=10), ws=str(ws)),
        claude_turn(NOW - timedelta(minutes=3), "s-nobody", u("m", "billed", 9.0, input=10), ws=str(ws)),
    ])
    top = usage.run("today", workspace=str(ws), events_dir=events_dir, now=NOW)["top_tasks"]
    assert [r["task_id"] for r in top] == ["task-000000a2", "task-000000a1"]
    assert top[0]["spend_usd"] == 1.0 and top[1]["subscription_tokens"] == 5000 and top[1]["spend_usd"] == 0


def test_route(cockpit_env, events_dir):  # noqa: F811
    write_events(events_dir, [
        claude_turn(NOW - timedelta(minutes=5), "s1", u("m", "billed", 1.25, input=10), ws=str(cockpit_env.a)),
        limits(NOW - timedelta(minutes=1), 70, 20),
    ])
    c = cockpit_env.client
    r = c.get("/cockpit/usage?range=week", headers=hdr())
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["range"] == "week" and data["totals"]["spend_usd"] == 1.25
    assert data["limits"]["five_hour"]["used_pct"] == 70
    assert c.get("/cockpit/usage?range=forever", headers=hdr()).status_code == 400
    r = c.get(f"/cockpit/usage?workspace={cockpit_env.b}", headers=hdr(device=True))
    assert r.status_code == 200
    assert r.json()["data"]["totals"]["spend_usd"] == 0 and r.json()["data"]["limits"]["five_hour"]["used_pct"] == 70


# ---------------------------------------------------------------- follower


def test_follower_accumulates_usage_onto_tasks(env):  # noqa: F811
    E = env.ev
    env.write(
        E("task.launch", 0, {"task_id": "task-22222222", "pty_id": 5, "session_id": "s1", "provider": "claude",
                             "lead": "delegate", "kind": "bug", "confirmed": True, "origin_kind": "launcher"}),
        E("agent.turn_end", 1, {"session_id": "s1", "pty_id": 5, "busy_ms": 1000}),
        E("agent.usage", 1.01, {"session_id": "s1", "pty_id": 5, "provider": "claude",
                                "by_model": [u("claude-opus-5", "subscription", 1.0, input=2, output=300, cache_write=100)]}),
        E("agent.usage", 2, {"session_id": "s1", "pty_id": 5, "provider": "claude",
                             "by_model": [u("claude-opus-5", "subscription", 0.5, output=100)]}),
        E("agent.usage", 3, {"session_id": "s-unknown", "pty_id": 9, "provider": "claude",
                             "by_model": [u("claude-opus-5", "subscription", 0.5, output=100)]}),
    )
    f = env.follower()
    tick(f)
    t = env.tasks()["task-22222222"]
    assert t["usage"]["shown_tokens"] == 502 and t["usage"]["cost_basis"] == "subscription"
    assert t["usage"]["tokens"] == {"input": 2, "output": 400, "cache_write": 100}
    assert "cost_usd" not in t["usage"]
    # replaying the log never double counts
    f.reset_cursor()
    tick(f)
    assert env.tasks()["task-22222222"]["usage"]["shown_tokens"] == 502


def test_tasks_route_returns_usage(cockpit_env):  # noqa: F811
    store = CockpitTaskStore(cockpit_env.a)
    task, _ = store.upsert({"id": "task-33333333", "title": "With usage"})
    task["usage"] = usage.accumulate(None, [u("m", "billed", 0.5, input=10, output=20)])
    store.save(task)
    r = cockpit_env.client.get("/cockpit/tasks", headers=hdr(cockpit_env.a))
    assert r.status_code == 200
    rows = r.json()["data"]
    rows = rows["tasks"] if isinstance(rows, dict) else rows
    row = next(t for t in rows if t["id"] == "task-33333333")
    assert row["usage"]["cost_usd"] == 0.5 and row["usage"]["shown_tokens"] == 30
    # a caller can't write usage: the follower owns it
    r = cockpit_env.client.patch("/cockpit/tasks/task-33333333", json={"usage": {"shown_tokens": 1}}, headers=hdr(cockpit_env.a))
    got = CockpitTaskStore(cockpit_env.a).get("task-33333333")
    assert got["usage"]["shown_tokens"] == 30


# ---------------------------------------------------------------- metrics guard


def test_accepted_spend_gains_tokens_and_cost(tmp_path, events_dir):
    from .test_metrics_v3 import T0, active_hour, at, make_tasks

    ws = tmp_path / "ws"
    ws.mkdir()
    make_tasks(ws)
    W = str(ws)
    E = make_event
    write_events(events_dir, [
        active_hour(E, W, 1),
        E("agent.turn_end", at(7), {"session_id": "s-acc", "pty_id": 3, "busy_ms": 30000}, workspace=W),
        E("agent.usage", at(7.01), {"session_id": "s-acc", "pty_id": 3, "provider": "claude", "by_model": [
            u("sonnet", "subscription", 1.5, input=100, output=400, cache_read=5000),
            u("sonnet", "estimate", 0.25, input=10),
        ]}, workspace=W),
        E("agent.usage", at(8), {"session_id": "s-rej", "pty_id": 4, "provider": "claude", "by_model": [
            u("x", "billed", 9.0, input=1)]}, workspace=W),
        E("focus.end", at(50), {"session_id": "f", "reason": "manual", "duration_ms": 3_600_000, "interruptions": 0}, workspace=W),
    ])
    m = metrics.run(T0, at(hours=1), workspace=W, events_dir=events_dir, now=at(hours=2))["metrics"]
    assert m["accepted_task_spend"] == [{
        "task_id": "task-00000003", "model": "sonnet", "busy_ms": 30000.0,
        "tokens": 510, "cost_usd": 0.25, "subscription_value_usd": 1.5,
    }]
    assert m["accepted_spend_per_result"] == {
        "results": 1, "busy_ms": 30000.0, "tokens": 510, "cost_usd": 0.25, "subscription_value_usd": 1.5,
    }
    empty = metrics.run(T0, at(hours=1), workspace=str(tmp_path), events_dir=events_dir / "none", now=at(hours=2))
    assert empty["metrics"]["accepted_spend_per_result"] is None
