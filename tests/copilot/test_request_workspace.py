from pathlib import Path

from hester.shared import workspace as ws_mod

from .cockpit_helpers import SHARED, cockpit_env, hdr, switchable  # noqa: F401


def test_get_current_workspace_precedence(tmp_path, monkeypatch):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    monkeypatch.setattr(ws_mod, "_current_workspace", None)
    monkeypatch.setenv("HESTER_WORKING_DIRECTORY", str(a))
    assert ws_mod.get_current_workspace() == a.resolve()
    monkeypatch.setattr(ws_mod, "_current_workspace", b.resolve())
    assert ws_mod.get_active_workspace() == b.resolve()
    with ws_mod.use_workspace(a) as scoped:
        assert scoped == a.resolve()
        assert ws_mod.get_current_workspace() == a.resolve()
        assert ws_mod.get_active_workspace() == b.resolve()
        assert ws_mod.workspace_key_prefix() == f"hester:ws:{ws_mod.workspace_id(a)}:"
    assert ws_mod.get_current_workspace() == b.resolve()
    assert ws_mod.request_workspace.get() is None


def test_header_and_query_resolution(cockpit_env):
    env = cockpit_env
    c = env.client

    r = c.get("/cockpit/tasks", headers=SHARED)
    assert r.status_code == 200 and r.json()["workspace"] == str(env.a)

    r = c.get("/cockpit/tasks", headers=hdr(env.b))
    assert r.json()["workspace"] == str(env.b)
    assert r.json()["workspace_id"] == ws_mod.workspace_id(env.b)

    r = c.get("/cockpit/tasks", headers=hdr(env.b), params={"workspace": str(env.a)})
    assert r.json()["workspace"] == str(env.a), "query wins over header"

    # the request's workspace is registered
    assert env.registry.peek(env.b) is not None and "request" in env.registry.peek(env.b).sources

    # copilot routes default to the request's workspace too
    c.post("/someday", headers=hdr(env.b), json={"text": "idea in b"})
    assert [i["text"] for i in c.get("/someday", headers=hdr(env.b)).json()["data"]] == ["idea in b"]
    assert c.get("/someday", headers=SHARED).json()["data"] == []


def test_bad_workspace_is_400_before_the_route(cockpit_env, tmp_path):
    c = cockpit_env.client
    f = tmp_path / "file.txt"
    f.write_text("x")
    for bad in ("relative/dir", str(tmp_path / "missing"), str(f)):
        for kwargs in ({"headers": hdr(bad)}, {"headers": SHARED, "params": {"workspace": bad}}):
            r = c.get("/cockpit/tasks", **kwargs)
            assert r.status_code == 400, (bad, kwargs)
            assert r.json()["error"] == "workspace must be an absolute directory"
    # auth still comes first
    assert c.get("/cockpit/tasks", headers={"X-Lee-Workspace": "relative"}).status_code == 401


def test_post_workspace_backward_compatible(switchable):
    env = switchable
    c = env.client

    r = c.get("/workspace", headers=SHARED)
    assert r.json() == {"workspace": str(env.a), "workspace_id": ws_mod.workspace_id(env.a)}

    r = c.post("/workspace", headers=SHARED, json={"path": str(env.b)})
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("success", "changed", "workspace", "workspace_id", "previous", "plugins_loaded", "workstreams"):
        assert key in body, key
    assert body["success"] is True and body["changed"] is True and body["workspace"] == str(env.b)
    assert {w["path"]: w["active"] for w in body["workspaces"]} == {str(env.a): False, str(env.b): True}
    assert ws_mod.get_active_workspace() == env.b
    assert env.main.app_state.settings.working_directory == str(env.b)

    # GET /workspace returns the active one even when a request names another
    r = c.get("/workspace", headers=hdr(env.a))
    assert r.json()["workspace"] == str(env.b)

    # same path again: unchanged, old fields kept
    r = c.post("/workspace", headers=SHARED, json={"path": str(env.b)})
    body = r.json()
    assert body["success"] is True and body["changed"] is False
    assert body["workspace"] == str(env.b) and body["workspace_id"] == ws_mod.workspace_id(env.b)
    assert "workspaces" in body

    assert c.post("/workspace", headers=SHARED, json={}).status_code == 400
    assert c.post("/workspace", headers=SHARED, json={"path": str(Path(env.tmp) / "missing")}).status_code == 400


def test_requests_without_header_follow_the_active_workspace(switchable):
    env = switchable
    c = env.client
    c.post("/cockpit/tasks", headers=SHARED, json={"title": "in A"})
    c.post("/workspace", headers=SHARED, json={"path": str(env.b)})
    c.post("/cockpit/tasks", headers=SHARED, json={"title": "in B"})
    assert [t["title"] for t in c.get("/cockpit/tasks", headers=hdr(env.a)).json()["data"]] == ["in A"]
    assert [t["title"] for t in c.get("/cockpit/tasks", headers=SHARED).json()["data"]] == ["in B"]


def test_non_ascii_workspace_header_is_percent_encoded(cockpit_env, tmp_path):
    import httpx

    env = cockpit_env
    c = env.client
    for name in ("Développement", "项目", "100% done"):
        d = (tmp_path / name)
        d.mkdir()
        d = d.resolve()
        value = ws_mod.encode_workspace_header(d)
        value.encode("ascii")  # a header value httpx and fetch accept
        httpx.Request("GET", "http://x/", headers={"X-Lee-Workspace": value})
        r = c.get("/cockpit/tasks", headers={**SHARED, "X-Lee-Workspace": value})
        assert r.status_code == 200 and r.json()["workspace"] == str(d), name
    # ASCII paths (spaces included) go out unchanged, and an older sender's raw value still works
    spaced = (tmp_path / "my project")
    spaced.mkdir()
    assert ws_mod.encode_workspace_header(spaced) == str(spaced)
    raw = (tmp_path / "a%20b")
    raw.mkdir()
    r = c.get("/cockpit/tasks", headers={**SHARED, "X-Lee-Workspace": str(raw.resolve())})
    assert r.status_code == 200 and r.json()["workspace"] == str(raw.resolve())


def test_chat_tui_daemon_headers_are_ascii(tmp_path):
    from types import SimpleNamespace

    from hester.daemon.tui.handlers.message_processor import MessageProcessor

    d = tmp_path / "Développement"
    d.mkdir()
    mp = MessageProcessor.__new__(MessageProcessor)
    mp.runner = SimpleNamespace(working_directory=str(d))
    headers = mp._daemon_headers()
    headers["X-Lee-Workspace"].encode("ascii")
    assert ws_mod.workspace_header_candidates(headers["X-Lee-Workspace"])[0] == str(d)
