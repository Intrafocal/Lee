import json
from datetime import datetime, timedelta, timezone

from hester.daemon.cockpit.readings import ReadingsStore
from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.copilot import digest

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import iso, make_event, write_events


def test_append_dedupe_list_latest(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    goals = ws / ".hester" / "goals"
    goals.mkdir(parents=True)
    # an existing `hester goals metrics --write` record has no kind
    (goals / "metrics.jsonl").write_text(json.dumps({"ts": "2026-09-20T00:00:00.000Z", "metrics": {"peek_rate": 1}}) + "\n")
    store = ReadingsStore(ws)
    wrote = store.append("2026-09-25T10:00:00.000Z", "bench", "run_1", [
        {"metric": "cold_start_ms", "value": 1590, "unit": "ms"},
        {"metric": "bad", "value": "NaN", "unit": None},
        {"metric": "", "value": 1},
        {"metric": "inf", "value": float("inf")},
    ])
    assert [r["metric"] for r in wrote] == ["cold_start_ms"]
    assert store.append("2026-09-25T10:00:00.000Z", "bench", "run_1", [{"metric": "cold_start_ms", "value": 1590, "unit": "ms"}]) == []
    assert ReadingsStore(ws).append("2026-09-25T10:00:00.000Z", "bench", "run_1", [{"metric": "cold_start_ms", "value": 1, "unit": "ms"}]) == []
    store.append("2026-09-25T11:00:00.000Z", "bench", "run_2", [
        {"metric": "cold_start_ms", "value": 1412, "unit": "ms"},
        {"metric": "size_kb", "value": 300, "unit": "kb"},
    ])
    assert [r["value"] for r in store.list("cold_start_ms")] == [1412, 1590]
    assert store.list("cold_start_ms", limit=1) == [{
        "ts": "2026-09-25T11:00:00.000Z", "metric": "cold_start_ms", "value": 1412, "unit": "ms",
        "source": {"kind": "operation", "op": "bench", "run_id": "run_2"},
    }]
    assert len(store.list(limit=2)) == 2
    assert {r["metric"]: r["value"] for r in store.latest()} == {"cold_start_ms": 1412, "size_kb": 300}
    prev = store.with_previous("2026-09-25T10:30:00.000Z", "2026-09-26T00:00:00.000Z")
    assert {r["metric"]: r["previous"] for r in prev} == {"cold_start_ms": 1590, "size_kb": None}
    assert store.counter.get() == 2
    lines = (goals / "metrics.jsonl").read_text().splitlines()
    assert len(lines) == 4 and "kind" not in json.loads(lines[0])


def test_readings_endpoint_and_snapshot(cockpit_env):
    env = cockpit_env
    ReadingsStore(env.b).append("2026-09-25T11:00:00.000Z", "bench", "run_2", [{"metric": "m", "value": 3, "unit": None}])
    r = env.client.get("/cockpit/readings", headers=hdr(env.b), params={"metric": "m"})
    assert [x["value"] for x in r.json()["data"]] == [3]
    assert env.client.get("/cockpit/readings", headers=hdr(env.a)).json()["data"] == []
    snap = env.client.get("/cockpit/snapshot", headers=hdr(env.b)).json()["data"]
    assert snap["version"] == 1 and [x["metric"] for x in snap["readings"]["latest"]] == ["m"]


def test_operation_wins_and_history(cockpit_env, events_dir, monkeypatch):
    env = cockpit_env
    now = datetime.now(timezone.utc).replace(microsecond=0)
    E = make_event
    write_events(events_dir, [
        E("operation.result", now - timedelta(hours=3), {"run_id": "run_a", "op": "electron:build", "status": "passed",
          "exit_code": 0, "duration_ms": 5, "by": "user", "inputs_sig": None,
          "readings": [{"metric": "cold_start_ms", "value": 1412, "unit": "ms"}]}, workspace=str(env.a)),
        E("operation.result", now - timedelta(hours=2), {"run_id": "run_b", "op": "electron:build", "status": "failed",
          "exit_code": 1, "duration_ms": 5, "by": "user", "readings": []}, workspace=str(env.a)),
        E("operation.result", now - timedelta(hours=1), {"run_id": "run_c", "op": "other", "status": "passed",
          "exit_code": 0, "duration_ms": 5, "by": "user", "readings": []}, workspace=str(env.b)),
    ])
    wins = digest.verified_wins(env.a, since=now - timedelta(days=1), until=now, events_dir=events_dir)
    assert [(w["kind"], w["title"], w["ref"]) for w in wins] == [("operation", "electron:build passed", "run_a")]
    assert wins[0]["verified"] is True and wins[0]["readings"][0]["value"] == 1412

    d = digest.build_digest(env.a, since=now - timedelta(days=1), attention_items=[], events_dir=events_dir, now=now)
    assert [w["kind"] for w in d["wins"]] == ["operation"]

    store = CockpitTaskStore(env.a)
    store.upsert({"id": "task-cccccccc", "title": "Closed one"})
    store.close("task-cccccccc", {"status": "done"})
    store.upsert({"id": "task-dddddddd", "title": "Still open"})
    ReadingsStore(env.a).append(iso(now - timedelta(days=10)), "bench", "r0", [{"metric": "cold_start_ms", "value": 1590, "unit": "ms"}])
    ReadingsStore(env.a).append(iso(now - timedelta(hours=3)), "bench", "r1", [{"metric": "cold_start_ms", "value": 1412, "unit": "ms"}])

    import hester.daemon.cockpit.history as history
    import hester.daemon.cockpit.routes as routes
    monkeypatch.setattr(routes, "build_history", lambda ws, days: history.build_history(ws, days, events_dir=events_dir))
    r = env.client.get("/cockpit/history", headers=hdr(env.a), params={"days": 7})
    data = r.json()["data"]
    assert [w["ref"] for w in data["wins"]] == ["run_a"]
    assert [t["id"] for t in data["tasks"]] == ["task-cccccccc"]
    assert [(x["value"], x["previous"]) for x in data["readings"]] == [(1412, 1590)]
    assert env.client.get("/cockpit/history", headers=hdr(env.a), params={"days": "x"}).status_code == 400
