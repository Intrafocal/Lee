"""Copilot v4: quadrants, urgency, overrides and ordering (contract section 4)."""

from datetime import datetime, timezone

import pytest

from hester.daemon.cockpit.tasks import CockpitTaskStore, default_task, derive

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued
from .test_follower import env, tick  # noqa: F401

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)
GOALS = [{"id": "G1", "priority": 0}, {"id": "G4", "priority": 1}, {"id": "G2", "priority": 2}]
GOALS_MD = "# Goals\n\n## Goals\n\n### G1 One\n\n### G4 Four\n\n### G2 Two\n"


def task(**kw):
    t = default_task("task-aaaa0001", "/ws", NOW)
    t["status"] = "running"
    t.update(kw)
    return t


@pytest.mark.parametrize("kw,quadrant,signal", [
    ({"serves": ["G1"], "status": "waiting"}, "Q1", "agent-waiting"),
    ({"serves": ["G1"]}, "Q2", None),
    ({"status": "waiting"}, "Q3", "agent-waiting"),
    ({}, None, None),
    ({"play": True}, "Q4", None),
    ({"play": True, "serves": ["G2"]}, "Q2", None),
    ({"urgency_cleared_at": "2026-09-25T00:00:00Z"}, "Q4", None),
    ({"serves": ["G9", "C1"]}, None, None),  # unknown ids aren't important
    ({"origin": {"kind": "operation", "ref": "tests"}}, "Q3", "op-failure"),
    ({"due": "2026-09-27"}, "Q3", "due"),
    ({"due": "2026-09-28"}, None, None),
    ({"due": "2026-09-20T10:00:00Z", "serves": ["G4"]}, "Q1", "due"),
    ({"overrides": {"important": False, "urgent": None, "at": "x"}, "serves": ["G1"]}, "Q4", None),
    ({"overrides": {"important": True, "urgent": None, "at": "x"}}, "Q2", None),
    ({"overrides": {"important": None, "urgent": True, "at": "x"}}, "Q3", "override"),
    ({"overrides": {"important": None, "urgent": False, "at": "x"}, "status": "waiting", "serves": ["G1"]}, "Q2", None),
])
def test_quadrant_table(kw, quadrant, signal):
    d = derive(task(**kw), GOALS, NOW)
    assert d["quadrant"] == quadrant
    assert (d["urgency"] or {}).get("signal") == signal


def test_importance_rank_and_op_ref():
    d = derive(task(serves=["G2", "G4"], origin={"kind": "operation", "ref": "run-1"}), GOALS, NOW)
    assert d["importance_rank"] == 1 and d["urgency"] == {"signal": "op-failure", "ref": "run-1"}
    closed = task(origin={"kind": "operation", "ref": "run-1"}, status="done")
    assert derive(closed, GOALS, NOW)["urgency"] is None
    assert derive(task(due="2026-09-27"), GOALS, NOW)["urgency"] == {"signal": "due", "ref": "2026-09-27"}


def test_save_derives_and_stamps_urgency_cleared(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "GOALS.md").write_text(GOALS_MD)
    store = CockpitTaskStore(ws)
    t, _ = store.upsert({"title": "t", "serves": ["G4"]})
    assert (t["quadrant"], t["importance_rank"], t["urgency"]) == ("Q2", 1, None)
    u, _ = store.upsert({"title": "u"})
    assert u["quadrant"] is None and u["urgency_cleared_at"] is None
    u["status"] = "waiting"
    store.save(u)
    assert store.get(u["id"])["quadrant"] == "Q3"
    u = store.get(u["id"])
    u["status"] = "running"
    store.save(u)
    u = store.get(u["id"])
    # Waiting then resuming is the ordinary rhythm, not cleared urgency.
    assert u["urgency"] is None and u["urgency_cleared_at"] is None and u["quadrant"] is None
    u["due"] = "2000-01-01"
    store.save(u)
    u = store.get(u["id"])
    assert u["urgency"]["signal"] == "due" and u["quadrant"] == "Q3"
    u["due"] = None
    store.save(u)
    u = store.get(u["id"])
    assert u["urgency"] is None and u["urgency_cleared_at"] and u["quadrant"] == "Q4"


def test_patch_overrides_and_event(cockpit_env, isolated_copilot):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(GOALS_MD)
    c, h = env.client, hdr(env.a)
    t = c.post("/cockpit/tasks", headers=h, json={"title": "Drift", "serves": ["G1"]}).json()["data"]
    assert t["quadrant"] == "Q2" and t["importance_rank"] == 0 and t["overrides"] is None
    r = c.patch(f"/cockpit/tasks/{t['id']}", headers=h, json={"important": False})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["quadrant"] == "Q4" and d["overrides"]["important"] is False and d["overrides"]["urgent"] is None
    assert d["overrides"]["at"]
    r = c.patch(f"/cockpit/tasks/{t['id']}", headers=h, json={"urgent": True})
    assert r.json()["data"]["quadrant"] == "Q3" and r.json()["data"]["overrides"]["important"] is False
    r = c.patch(f"/cockpit/tasks/{t['id']}", headers=h, json={"important": None, "urgent": None})
    assert r.json()["data"]["quadrant"] in ("Q2",)
    assert c.patch(f"/cockpit/tasks/{t['id']}", headers=h, json={"important": "yes"}).status_code == 400
    evs = [e for e in queued(isolated_copilot) if e["type"] == "task.override"]
    assert [(e["data"]["important"], e["data"]["urgent"]) for e in evs] == [(False, None), (False, True), (None, None)]
    assert all(e["data"]["task_id"] == t["id"] and e["workspace"] == str(env.a) for e in evs)
    # no override event for ordinary patches
    c.patch(f"/cockpit/tasks/{t['id']}", headers=h, json={"title": "Renamed"})
    assert len([e for e in queued(isolated_copilot) if e["type"] == "task.override"]) == 3


def test_origin_goal_eval(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    t, _ = CockpitTaskStore(ws).upsert({"title": "From eval", "origin": {"kind": "goal-eval", "ref": "G1"}})
    assert t["origin"] == {"kind": "goal-eval", "ref": "G1"}


def test_snapshot_orders_by_quadrant(cockpit_env):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(GOALS_MD)
    store = CockpitTaskStore(env.a)
    ids = {}
    for name, payload in [
        ("none", {}), ("q4", {"play": True}), ("q2_g2", {"serves": ["G2"]}), ("q2_g1", {"serves": ["G1"]}),
        ("q3", {"due": "2020-01-01"}), ("q1", {"serves": ["G4"], "due": "2020-01-01"}),
    ]:
        t, _ = store.upsert({"title": name, "status": "running", **payload})
        ids[t["id"]] = name
    queued_t, _ = store.upsert({"title": "queued", "serves": ["G1"], "status": "queued"})
    ids[queued_t["id"]] = "queued"
    snap = env.client.get("/cockpit/snapshot", headers=hdr(env.a)).json()["data"]
    order = [ids[t["id"]] for t in snap["tasks"]["open"]]
    assert order == ["q1", "q2_g1", "q2_g2", "q3", "none", "q4", "queued"]
    t0 = snap["tasks"]["open"][0]
    for key in ("quadrant", "importance_rank", "overrides", "urgency_cleared_at", "files_at_first_report",
                "serves", "timebox_min", "busy_ms", "files", "files_count", "lead", "play", "status", "agent",
                "urgency", "updated_at"):
        assert key in t0


def test_files_at_first_report_set_once(env):  # noqa: F811
    E = env.ev
    env.write(
        E("task.launch", 0, {"task_id": "task-22222222", "pty_id": 5, "session_id": "s1", "lead": "delegate"}),
        E("agent.tool", 1, {"session_id": "s1", "pty_id": 5, "tool": "Edit", "phase": "post", "writes": True,
                            "files": ["a.py", "b.py"]}),
        E("agent.turn_end", 2, {"session_id": "s1", "pty_id": 5, "busy_ms": 1000, "summary": "first"}),
        E("agent.prompt", 3, {"session_id": "s1", "pty_id": 5}),
        E("agent.tool", 4, {"session_id": "s1", "pty_id": 5, "tool": "Edit", "phase": "post", "writes": True,
                            "files": ["c.py", "d.py", "e.py"]}),
        E("agent.turn_end", 5, {"session_id": "s1", "pty_id": 5, "busy_ms": 1000, "summary": "second"}),
    )
    tick(env.follower())
    t = env.tasks()["task-22222222"]
    assert t["files_count"] == 5 and t["files_at_first_report"] == 2
