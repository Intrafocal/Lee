import asyncio

from hester.daemon.tools import workstream_tools
from hester.shared import workspace as ws_mod

from .cockpit_helpers import SHARED, cockpit_env, hdr, switchable  # noqa: F401


def titles(resp):
    assert resp.status_code == 200, resp.text
    return sorted(w["title"] for w in resp.json())


def test_workstreams_follow_the_request_workspace(cockpit_env):
    env = cockpit_env
    c = env.client
    r = c.post("/workstream/", headers=hdr(env.a), json={"title": "Alpha"})
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    c.post("/workstream/", headers=hdr(env.b), json={"title": "Beta"})

    assert titles(c.get("/workstream/", headers=hdr(env.a))) == ["Alpha"]
    assert titles(c.get("/workstream/", headers=hdr(env.b))) == ["Beta"]
    assert titles(c.get("/workstream/", headers=SHARED)) == ["Alpha"]
    assert (env.a / ".hester" / "workstreams" / wid / "workstream.yaml").exists()
    assert c.get(f"/workstream/{wid}", headers=hdr(env.b)).status_code == 404
    assert c.get(f"/workstream/{wid}", headers=hdr(env.a)).status_code == 200


def test_workstream_router_follows_active_after_switch(switchable):
    """Regression: /workstream/ used to keep serving the boot workspace after POST /workspace."""
    env = switchable
    c = env.client
    c.post("/workstream/", headers=SHARED, json={"title": "Boot one"})
    r = c.post("/workspace", headers=SHARED, json={"path": str(env.b)})
    assert r.status_code == 200
    assert titles(c.get("/workstream/", headers=SHARED)) == []
    c.post("/workstream/", headers=SHARED, json={"title": "After switch"})
    assert titles(c.get("/workstream/", headers=SHARED)) == ["After switch"]
    assert titles(c.get("/workstream/", headers=hdr(env.a))) == ["Boot one"]


def test_workstream_tools_use_the_provider(cockpit_env, monkeypatch):
    env = cockpit_env
    monkeypatch.setattr(workstream_tools, "_store_provider", None)
    workstream_tools.init_workstream_tools(env.main._current_ws_store)

    async def create_and_list(ws):
        with ws_mod.use_workspace(ws):
            await workstream_tools.execute_workstream_create(title=f"tool in {ws.name}")
            return await workstream_tools.execute_workstream_list()

    out_b = asyncio.run(create_and_list(env.b))
    assert [w["title"] for w in out_b["workstreams"]] == ["tool in wsB"]
    out_a = asyncio.run(workstream_tools.execute_workstream_list())
    assert out_a["count"] == 0


def test_telemetry_bridge_finds_the_workstream(cockpit_env):
    env = cockpit_env
    c = env.client
    wid = c.post("/workstream/", headers=hdr(env.b), json={"title": "Beta"}).json()["id"]
    env.main.app_state.agent_sessions.pop("s-tel", None)
    r = c.post("/orchestrate/telemetry", headers=SHARED, json={
        "action": "register", "session_id": "s-tel", "agent_type": "claude_code", "workstream_id": wid,
    })
    assert r.status_code == 200 and r.json()["success"], r.text
    # no header: the active workspace (A) doesn't hold the workstream; the registry finds it in B
    r = c.post("/orchestrate/telemetry", headers=SHARED, json={
        "action": "update", "session_id": "s-tel", "tool": "Edit", "active_file": "x.py",
    })
    assert r.json()["success"], r.text
    env.main.app_state.agent_sessions.pop("s-tel", None)
    events = c.get(f"/workstream/{wid}/telemetry", headers=hdr(env.b)).json()["events"]
    assert [e.get("event_type") for e in events] == ["agent_update"]
