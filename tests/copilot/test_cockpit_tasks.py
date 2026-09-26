import os
import stat
from datetime import datetime, timedelta, timezone

import yaml

from hester.daemon.cockpit.goals import parse_goals
from hester.daemon.cockpit.tasks import CockpitTaskStore, iso_s

from .cockpit_helpers import SHARED, cockpit_env, hdr  # noqa: F401
from .conftest import commit_file, git


def relay(ws, **over):
    body = {
        "id": "task-7f3a91c2", "workspace": str(ws), "title": "Fix /fs/list 404", "title_source": "user",
        "kind": "bug", "lead": "delegate", "play": False, "status": "running",
        "agent": {"provider": "claude", "pty_id": 12, "session_id": "sess-1", "tab_label": "Fix", "model": None},
        "serves": [], "confirmed": True, "origin": {"kind": "launcher"},
    }
    body.update(over)
    return body


def test_create_defaults_and_file_format(cockpit_env):
    env = cockpit_env
    c = env.client
    r = c.post("/cockpit/tasks", headers=hdr(env.a), json={"workspace": str(env.a), "title": "  Look   into it "})
    assert r.status_code == 201, r.text
    t = r.json()["data"]
    assert t["id"].startswith("task-") and len(t["id"]) == 13
    assert t["title"] == "Look into it" and t["title_source"] == "user"
    assert (t["kind"], t["lead"], t["status"], t["confirmed"]) == ("unknown", "delegate", "queued", False)
    assert t["timebox_min"] == 30 and t["quadrant"] is None and t["version"] == 1
    assert "applied_through" not in t
    path = env.a / ".hester" / "cockpit" / "tasks" / f"{t['id']}.md"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    head = path.read_text().split("---\n")[1]
    meta = yaml.safe_load(head)
    assert "applied_through" in meta and meta["created_at"] == t["created_at"]
    assert not (env.a / ".hester" / "tasks").exists(), "must not collide with the batch Task System"

    assert c.post("/cockpit/tasks", headers=SHARED, json={"workspace": str(env.a)}).status_code == 400
    assert c.post("/cockpit/tasks", headers=SHARED, json={"title": "x", "kind": "nope"}).status_code == 400
    assert c.post("/cockpit/tasks", headers=SHARED, json={"id": "../evil", "title": "x"}).status_code == 400
    assert c.post("/cockpit/tasks", headers=hdr(env.a), json={"workspace": str(env.b), "title": "x"}).status_code == 400


def test_upsert_merges_and_keeps_follower_fields(cockpit_env):
    env = cockpit_env
    c = env.client
    store = CockpitTaskStore(env.a)
    # the follower's stub arrived first
    stub, _ = store.upsert({"id": "task-7f3a91c2", "title": "(untitled)", "title_source": "auto", "status": "running"})
    stub["busy_ms"] = 5000
    stub["turns"] = 2
    stub["files"] = ["/x/a.py"]
    stub["sessions"] = ["sess-1"]
    store.save(stub)

    r = c.post("/cockpit/tasks", headers=hdr(env.a), json=relay(env.a, busy_ms=0, turns=0, files=[], sessions=[]))
    assert r.status_code == 200, r.text
    t = r.json()["data"]
    assert t["title"] == "Fix /fs/list 404" and t["title_source"] == "user" and t["kind"] == "bug"
    assert t["confirmed"] is True and t["confirmed_at"]
    assert (t["busy_ms"], t["turns"], t["files"], t["sessions"]) == (5000, 2, ["/x/a.py"], ["sess-1"])
    assert t["agent"]["pty_id"] == 12 and t["agent"]["session_id"] == "sess-1"

    # relayed again (spool retry): idempotent, still one task
    c.post("/cockpit/tasks", headers=hdr(env.a), json=relay(env.a))
    assert len(c.get("/cockpit/tasks", headers=hdr(env.a), params={"status": "all"}).json()["data"]) == 1


def test_patch_confirm_link(cockpit_env):
    env = cockpit_env
    c = env.client
    tid = c.post("/cockpit/tasks", headers=hdr(env.a), json={"title": "Claude in wsA", "title_source": "auto"}).json()["data"]["id"]

    r = c.patch(f"/cockpit/tasks/{tid}", headers=hdr(env.a), json={"title": "Better title", "kind": "chore", "status": "running"})
    t = r.json()["data"]
    assert t["title"] == "Better title" and t["title_source"] == "user" and t["status"] == "running"
    assert c.patch(f"/cockpit/tasks/{tid}", headers=hdr(env.a), json={"status": "done"}).status_code == 400
    assert c.patch(f"/cockpit/tasks/{tid}", headers=hdr(env.a), json={"busy_ms": 1}).status_code == 400

    r = c.post(f"/cockpit/tasks/{tid}/confirm", headers=hdr(env.a), json={"serves": ["G2", "G2", "G1"], "workstream": "ws-1"})
    t = r.json()["data"]
    assert t["confirmed"] is True and t["serves"] == ["G2", "G1"] and t["workstream"] == "ws-1"

    tid2 = c.post("/cockpit/tasks", headers=hdr(env.a), json={"title": "Unlinked"}).json()["data"]["id"]
    assert c.post(f"/cockpit/tasks/{tid2}/link", headers=hdr(env.a), json={}).status_code == 400
    r = c.post(f"/cockpit/tasks/{tid2}/link", headers=hdr(env.a), json={"pty_id": 7, "session_id": "s-7", "tab_label": "Claude"})
    t = r.json()["data"]
    assert t["confirmed"] is True
    assert t["agent"] == {"provider": "claude", "pty_id": 7, "session_id": "s-7", "tab_label": "Claude", "model": None}

    assert c.get("/cockpit/tasks/task-00000000", headers=hdr(env.a)).status_code == 404
    assert c.post("/cockpit/tasks/task-00000000/confirm", headers=hdr(env.a), json={}).status_code == 404


def test_close_outcome_and_commits(cockpit_env):
    env = cockpit_env
    c = env.client
    ws = env.a
    git(ws, "init", "-q", "-b", "main")
    old = datetime.now(timezone.utc) - timedelta(days=2)
    commit_file(ws, "a.py", "1", "before the task", old)

    store = CockpitTaskStore(ws)
    task, _ = store.upsert({"id": "task-aaaaaaaa", "title": "Fix a", "confirmed": True})
    task["created_at"] = iso_s(datetime.now(timezone.utc) - timedelta(hours=1))
    task["files"] = [str(ws / "a.py"), "b.py"]
    task["summary"] = "Fixed the thing"
    task["lee_status"] = {"status": "done", "summary": "All tests pass"}
    store.save(task)
    now = datetime.now(timezone.utc)
    commit_file(ws, "a.py", "2", "touch a", now - timedelta(minutes=30))
    commit_file(ws, "c.py", "3", "unrelated", now - timedelta(minutes=20))
    commit_file(ws, "b.py", "4", "touch b", now - timedelta(minutes=10))
    shas = git(ws, "log", "--format=%h %s").splitlines()
    want = {line.split()[0][:7] for line in shas if "touch" in line}

    r = c.post("/cockpit/tasks/task-aaaaaaaa/close", headers=hdr(ws), json={"status": "done", "note": "Shipped."})
    assert r.status_code == 200, r.text
    t = r.json()["data"]
    assert t["status"] == "done" and t["accepted"] is True and t["closed_at"]
    assert t["outcome"] == "Done by you. Agent's last report (the agent's words): All tests pass Shipped."
    assert set(t["commits"]) == want and len(t["commits"]) == 2

    task2, _ = store.upsert({"id": "task-bbbbbbbb", "title": "Nope"})
    r = c.post("/cockpit/tasks/task-bbbbbbbb/close", headers=hdr(ws), json={"status": "discarded"})
    t = r.json()["data"]
    assert t["accepted"] is False and t["commits"] == [] and t["outcome"] == "Discarded by you."
    assert c.post("/cockpit/tasks/task-bbbbbbbb/close", headers=hdr(ws), json={"status": "review"}).status_code == 400

    open_ids = [x["id"] for x in c.get("/cockpit/tasks", headers=hdr(ws)).json()["data"]]
    closed_ids = {x["id"] for x in c.get("/cockpit/tasks", headers=hdr(ws), params={"status": "closed"}).json()["data"]}
    assert open_ids == [] and closed_ids == {"task-aaaaaaaa", "task-bbbbbbbb"}


def test_promote_creates_workstream(cockpit_env):
    env = cockpit_env
    c = env.client
    tid = c.post("/cockpit/tasks", headers=hdr(env.b), json={"title": "Big thing", "serves": ["G2"]}).json()["data"]["id"]
    r = c.post(f"/cockpit/tasks/{tid}/promote", headers=hdr(env.b), json={})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    wid = data["workstream_id"]
    assert data["task"]["workstream"] == wid and data["task"]["confirmed"] is True
    ws = c.get(f"/workstream/{wid}", headers=hdr(env.b)).json()
    assert ws["title"] == "Big thing" and ws["brief"]["objective"].startswith("Big thing")
    snap = c.get("/cockpit/snapshot", headers=hdr(env.b)).json()["data"]
    assert snap["workstreams"] == [{"id": wid, "title": "Big thing", "phase": "exploration", "serves": ["G2"], "task_ids": [tid]}]


def test_snapshot_version_and_per_workspace_isolation(cockpit_env):
    env = cockpit_env
    c = env.client
    snap = c.get("/cockpit/snapshot", headers=hdr(env.a)).json()["data"]
    assert snap["version"] == 0 and snap["tasks"]["open"] == []
    assert snap["someday"] == {"open": 0, "untriaged_over_7d": 0}
    assert snap["readings"] == {"latest": []}

    c.post("/cockpit/tasks", headers=hdr(env.a), json={"title": "A queued"})
    rid = c.post("/cockpit/tasks", headers=hdr(env.a), json={"title": "A running", "status": "running"}).json()["data"]["id"]
    c.post("/cockpit/tasks", headers=hdr(env.b), json={"title": "B only"})

    snap = c.get("/cockpit/snapshot", headers=hdr(env.a)).json()["data"]
    assert snap["workspace"] == str(env.a) and snap["version"] == 2
    assert [t["title"] for t in snap["tasks"]["open"]] == ["A running", "A queued"]
    assert [e["kind"] for e in snap["tasks"]["recent_events"]] == ["created", "created"]
    r = c.get("/cockpit/snapshot", headers=hdr(env.a), params={"since_version": 2}).json()["data"]
    assert r == {"unchanged": True, "version": 2}

    c.post(f"/cockpit/tasks/{rid}/close", headers=hdr(env.a), json={"status": "done"})
    snap = c.get("/cockpit/snapshot", headers=hdr(env.a), params={"since_version": 2}).json()["data"]
    assert snap["version"] == 3 and [t["id"] for t in snap["tasks"]["recent_closed"]] == [rid]

    assert [t["title"] for t in c.get("/cockpit/tasks", headers=hdr(env.b)).json()["data"]] == ["B only"]
    # a device token may read too
    assert c.get("/cockpit/tasks", headers=hdr(env.b, device=True)).status_code == 200


def test_goals(cockpit_env):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(
        "# Goals\n\n- **C1 Local-first.** Core editing works.\n- **C2 Quiet while you work.** x\n\n"
        "### G1 Humane, fun development\n\ntext\n\n### G2 Better than one-off agent sessions\n"
    )
    r = env.client.get("/cockpit/goals", headers=hdr(env.a))
    assert r.json()["data"] == [
        {"id": "C1", "title": "Local-first", "kind": "constraint"},
        {"id": "C2", "title": "Quiet while you work", "kind": "constraint"},
        {"id": "G1", "title": "Humane, fun development", "kind": "goal"},
        {"id": "G2", "title": "Better than one-off agent sessions", "kind": "goal"},
    ]
    assert env.client.get("/cockpit/goals", headers=hdr(env.b)).json()["data"] == []
    assert parse_goals("### G9 Nine\n### G9 Dup\n") == [{"id": "G9", "title": "Nine", "kind": "goal"}]


def test_cockpit_tools_are_read_or_propose_only(cockpit_env, monkeypatch):
    import asyncio

    from hester.daemon.tools import cockpit_tools
    from hester.daemon.tools.definitions import get_tools_by_categories

    names = set(get_tools_by_categories(["cockpit"]))
    assert names == {"cockpit_tasks", "knowledge_notes", "lee_tabs", "lee_tab_read", "lee_tab_checkin", "lee_operations",
                     "lee_operation_run", "lee_operation_propose", "lee_operation_result"}

    calls = []

    async def fake(domain, action, params, workspace, timeout=10.0):
        calls.append((domain, action, params, workspace))
        if action == "run" and params["name"] == "flash":
            return {"status": 202, "body": {"success": True, "data": {"proposal_id": "p1"}}}
        return {"status": 200, "body": {"success": True, "data": {"ok": True}}}

    monkeypatch.setattr(cockpit_tools, "lee_command", fake)
    ws = str(cockpit_env.b)
    out = asyncio.run(cockpit_tools.lee_operation_run("flash", working_dir=ws))
    assert out["success"] and "approv" in out["message"]
    out = asyncio.run(cockpit_tools.lee_operation_run("build", {"x": 1}, working_dir=ws))
    assert out["success"] and "running" in out["message"]
    asyncio.run(cockpit_tools.lee_tab_read(3, lines=5000, working_dir=ws))
    asyncio.run(cockpit_tools.lee_tab_checkin(3, working_dir=ws))
    assert calls[1] == ("ops", "run", {"workspace": ws, "name": "build", "params": {"x": 1}}, ws)
    assert calls[2] == ("tab", "read_output", {"pty_id": 3, "lines": 200}, ws)
    assert calls[3][:2] == ("tab", "checkin")
    assert not any(c[1] in ("send_input", "agent") for c in calls)

    CockpitTaskStore(cockpit_env.b).upsert({"title": "Visible to tools"})
    out = asyncio.run(cockpit_tools.cockpit_tasks(working_dir=ws))
    assert [t["title"] for t in out["data"]["tasks"]] == ["Visible to tools"]


def test_late_relay_keeps_follower_status_and_pty(cockpit_env):
    store = CockpitTaskStore(cockpit_env.a)
    task, _ = store.upsert({"id": "task-0000aaaa", "title": "Fix bug", "status": "running",
                            "agent": {"provider": "claude", "pty_id": 5, "session_id": "s1"}})
    # the follower saw the agent finish
    task["status"] = "review"
    task["agent"] = dict(task["agent"], pty_id=None)
    task["applied_through"] = "2026-09-25T10:00:00.000Z|ev1"
    store.save(task)
    # the spooled relay lands late with the launch-time status and pty
    t, created = store.upsert({"id": "task-0000aaaa", "title": "Fix bug", "status": "running",
                               "agent": {"provider": "claude", "pty_id": 5, "session_id": "s1", "model": "opus"}})
    assert not created
    assert t["status"] == "review" and t["agent"]["pty_id"] is None
    assert t["agent"]["model"] == "opus", "missing agent fields are still filled in"
    # before the follower touched a task, the relay's fields win as before
    store.upsert({"id": "task-0000bbbb", "title": "Other", "status": "queued"})
    t, _ = store.upsert({"id": "task-0000bbbb", "status": "running", "agent": {"pty_id": 9}})
    assert t["status"] == "running" and t["agent"]["pty_id"] == 9


def test_load_all_reuses_parsed_files_until_they_change(cockpit_env, monkeypatch):
    store = CockpitTaskStore(cockpit_env.a)
    store.upsert({"id": "task-0000cccc", "title": "One"})
    store.load_all()
    calls = []
    orig = CockpitTaskStore._parse
    monkeypatch.setattr(CockpitTaskStore, "_parse", staticmethod(lambda c: calls.append(1) or orig(c)))
    first = store.load_all()
    assert calls == [], "unchanged files are not re-parsed"
    first[0]["title"] = "mutated"
    assert store.load_all()[0]["title"] == "One", "callers get their own copy"
    store.patch("task-0000cccc", {"title": "Two"})
    assert store.load_all()[0]["title"] == "Two"
