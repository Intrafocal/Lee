"""Task names, launch context and context bundles (addendum 2026-09-26b)."""

import yaml

from hester.daemon.cockpit.tasks import CockpitTaskStore, apply_name, default_task

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401


def launch(ws, **over):
    body = {
        "id": "task-0a0b0c0d", "workspace": str(ws), "title": "(untitled)", "title_source": "auto",
        "kind": "bug", "lead": "delegate", "status": "running",
        "agent": {"provider": "claude", "pty_id": 7, "session_id": "sess-n", "tab_label": "Login fix", "model": None},
        "confirmed": True, "origin": {"kind": "launcher"},
    }
    body.update(over)
    return body


def test_precedence_rule():
    t = default_task("task-1", "/w")
    assert apply_name(t, "Claude's idea", "ai-title") and t["name_source"] == "ai-title"
    assert apply_name(t, "Better title", "ai-title") and t["name"] == "Better title"
    assert apply_name(t, "Mine", "user") and (t["name"], t["name_source"]) == ("Mine", "user")
    # An AI title never replaces yours; neither does a custom-title Lee already saw.
    assert not apply_name(t, "Claude again", "ai-title")
    t["name_custom_seen"] = "old rename"
    assert not apply_name(t, "old rename", "custom-title")
    # A later, different /rename does.
    assert apply_name(t, "  Renamed \n in   Claude ", "custom-title")
    assert (t["name"], t["name_source"], t["name_custom_seen"]) == ("Renamed in Claude", "custom-title", "Renamed in Claude")
    assert not apply_name(t, "AI", "ai-title")
    # Yours again, then clear it.
    assert apply_name(t, "Mine 2", "user") and t["name_source"] == "user"
    assert apply_name(t, "", "user") and (t["name"], t["name_source"]) == (None, None)
    # --name echoing your name: recorded as seen, nothing changes.
    t2 = default_task("task-2", "/w")
    apply_name(t2, "Login fix", "user")
    assert not apply_name(t2, "Login fix", "custom-title")
    assert t2["name_source"] == "user" and t2["name_custom_seen"] == "Login fix"


def test_launch_record_name_and_context(cockpit_env):
    env = cockpit_env
    c = env.client
    body = launch(env.a, name="Login fix", name_source="user", context={"files": ["src/a.py", "README.md"], "bundles": ["auth"]})
    r = c.post("/cockpit/tasks", headers=hdr(env.a), json=body)
    assert r.status_code == 201, r.text
    t = r.json()["data"]
    assert (t["name"], t["name_source"]) == ("Login fix", "user")
    assert t["context"] == {"files": ["src/a.py", "README.md"], "bundles": ["auth"]}
    assert "name_custom_seen" not in t
    path = env.a / ".hester" / "cockpit" / "tasks" / "task-0a0b0c0d.md"
    meta = yaml.safe_load(path.read_text().split("---\n")[1])
    assert meta["name"] == "Login fix" and "name_custom_seen" in meta

    bad = launch(env.a, id="task-0a0b0c0e", context={"files": ["../etc/passwd"]})
    assert c.post("/cockpit/tasks", headers=hdr(env.a), json=bad).status_code == 400


def test_name_endpoint_by_task_and_session(cockpit_env):
    env = cockpit_env
    c = env.client
    assert c.post("/cockpit/tasks", headers=hdr(env.a), json=launch(env.a)).status_code == 201
    # Claude's AI title, by session id (Lee may not know the task id).
    r = c.post("/cockpit/tasks/name", headers=hdr(env.a), json={"session_id": "sess-n", "name": "Fix login loop", "source": "ai-title"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["changed"] is True
    assert r.json()["data"]["task"]["name"] == "Fix login loop"
    # Rename in the Cockpit (PATCH): yours.
    r = c.patch("/cockpit/tasks/task-0a0b0c0d", headers=hdr(env.a), json={"name": "My login task"})
    assert r.status_code == 200, r.text
    assert (r.json()["data"]["name"], r.json()["data"]["name_source"]) == ("My login task", "user")
    r = c.post("/cockpit/tasks/name", headers=hdr(env.a), json={"task_id": "task-0a0b0c0d", "name": "AI", "source": "ai-title"})
    assert r.json()["data"]["changed"] is False
    # A /rename in the session wins over yours.
    r = c.post("/cockpit/tasks/name", headers=hdr(env.a), json={"task_id": "task-0a0b0c0d", "name": "Renamed", "source": "custom-title"})
    assert r.json()["data"]["task"]["name_source"] == "custom-title"
    assert c.post("/cockpit/tasks/name", headers=hdr(env.a), json={"session_id": "nope", "name": "x", "source": "ai-title"}).status_code == 404
    assert c.post("/cockpit/tasks/name", headers=hdr(env.a), json={"task_id": "task-0a0b0c0d", "name": "x", "source": "bogus"}).status_code == 400
    # Stored on disk for the follower and snapshots.
    assert CockpitTaskStore(env.a).get("task-0a0b0c0d")["name"] == "Renamed"


def test_context_bundles_list(cockpit_env):
    env = cockpit_env
    c = env.client
    r = c.get("/cockpit/context/bundles", headers=hdr(env.a))
    assert r.status_code == 200 and r.json()["data"] == []
    bundles = env.a / ".hester" / "context" / "bundles"
    bundles.mkdir(parents=True)
    (bundles / "auth.md").write_text(
        "---\nid: auth\ntitle: Auth flow\ncreated: '2026-09-20T10:00:00+00:00'\nupdated: '2026-09-21T10:00:00+00:00'\n"
        "ttl_hours: 0\ntags: [security]\n---\n\n# Auth flow\n\nSECRET-BODY\n"
    )
    r = c.get("/cockpit/context/bundles", headers=hdr(env.a))
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert [b["id"] for b in data] == ["auth"], data
    assert data[0]["title"] == "Auth flow"
    assert data[0]["relative_path"] == ".hester/context/bundles/auth.md"
    assert data[0]["path"] == str(bundles / "auth.md")
    assert "SECRET-BODY" not in r.text, "references only, never content"
