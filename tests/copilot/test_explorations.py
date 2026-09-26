import asyncio
import os
import stat

import yaml

from hester.daemon.cockpit import explorations as ex
from hester.daemon.cockpit.explorations import ExplorationStore, exploration_id_from_session, record_session_turn
from hester.daemon.session import InMemorySessionManager

from .cockpit_helpers import SHARED, cockpit_env, hdr  # noqa: F401


def test_store_create_list_patch_and_file_format(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "**Could** we replace Redis sessions with files?\n\nMore thoughts."})
    assert ex.EXP_ID_RE.match(exp["id"]) and exp["status"] == "active" and exp["turns"] == 0
    assert exp["title"] == "Could we replace Redis sessions with files?", "title from the seed, made plain"
    assert exp["session_id"] == f"explore-{exp['id']}" and exp["origin"] == {"kind": "cockpit", "ref": None}
    path = tmp_path / ".hester" / "explore" / f"{exp['id']}.md"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    meta = yaml.safe_load(path.read_text().split("---\n")[1])
    assert meta["title"] == exp["title"] and meta["version"] == 1
    assert "## Seed" in store.body(exp["id"]) and "## Log" in store.body(exp["id"])

    other = store.create({"title": "Second", "origin": {"kind": "someday", "ref": "sd_1"}})
    assert {e["id"] for e in store.list("active")} == {other["id"], exp["id"]}
    archived = store.patch(exp["id"], {"status": "archived"})
    assert archived["status"] == "archived" and archived["archived_at"]
    assert [e["id"] for e in store.list("active")] == [other["id"]]
    assert [e["id"] for e in store.list("archived")] == [exp["id"]]
    assert len(store.list("all")) == 2
    assert store.patch(exp["id"], {"status": "active"})["archived_at"] is None


def test_store_rejects_bad_input(tmp_path):
    store = ExplorationStore(tmp_path)
    for body in ({}, {"title": "  "}, {"title": 5}, {"title": "x", "origin": {"kind": "nope"}}, {"id": "../x", "title": "x"}):
        try:
            store.create(body)
        except ex.ExplorationError:
            continue
        raise AssertionError(f"accepted {body}")
    exp = store.create({"title": "x"})
    for body in ({"seed": "y"}, {"status": "done"}, {"title": ""}):
        try:
            store.patch(exp["id"], body)
        except ex.ExplorationError:
            continue
        raise AssertionError(f"patched {body}")


def test_record_turn_appends_to_log_and_reactivates(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Files vs Redis"})
    store.patch(exp["id"], {"status": "archived"})
    out = store.record_turn(exp["id"], "What breaks?", "TTL-based cleanup.")
    assert out["turns"] == 1 and out["status"] == "active"
    body = store.body(exp["id"])
    assert body.index("## Log") < body.index("### You") < body.index("What breaks?") < body.index("### Hester") < body.index("TTL-based")
    assert "What breaks?" in store.context_text(exp["id"])


def test_session_writeback_by_session_id(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Deep dive"})
    sid = f"explore-{exp['id']}"
    assert exploration_id_from_session(sid) == exp["id"]
    assert exploration_id_from_session("tui-1234") is None
    assert exploration_id_from_session("explore-../../x") is None
    # Not opened in this daemon: found through the TUI's working directory.
    assert record_session_turn(sid, str(tmp_path), "Q", "A") is True
    assert store.get(exp["id"])["turns"] == 1
    assert record_session_turn("tui-1", str(tmp_path), "Q", "A") is False
    assert record_session_turn(sid, str(tmp_path / "elsewhere"), "Q", "A") is False


def test_open_session_seeds_once(tmp_path, monkeypatch):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Seeded", "seed": "Start from the Library code."})
    store.record_turn(exp["id"], "earlier q", "earlier a")
    mgr = InMemorySessionManager(ttl_seconds=60)
    monkeypatch.setattr(ex, "_session_manager_getter", lambda: mgr)
    first = asyncio.run(ex.open_session(store, exp["id"]))
    assert first == {"session_id": f"explore-{exp['id']}", "seeded": True}
    session = asyncio.run(mgr.get(first["session_id"]))
    roles = [m.role for m in session.conversation_history]
    assert roles.count("system") == 2 and roles[-1] == "assistant"
    assert any("earlier a" in m.content for m in session.conversation_history if m.role == "system")
    assert "Exploring: Seeded" in session.conversation_history[-1].content
    again = asyncio.run(ex.open_session(store, exp["id"]))
    assert again["seeded"] is False
    # Opened here, so write-back no longer needs the working directory.
    assert record_session_turn(first["session_id"], None, "q", "a") is True


def test_routes(cockpit_env):
    env = cockpit_env
    c = env.client
    r = c.post("/cockpit/explorations", headers=hdr(env.b), json={"workspace": str(env.b), "title": "Explore X", "seed": "why"})
    assert r.status_code == 201, r.text
    exp = r.json()["data"]
    assert exp["workspace"] == str(env.b) and exp["status"] == "active"
    assert (env.b / ".hester" / "explore" / f"{exp['id']}.md").exists()
    assert c.get("/cockpit/explorations", headers=hdr(env.a)).json()["data"] == [], "per workspace"
    listed = c.get("/cockpit/explorations", headers=hdr(env.b)).json()["data"]
    assert [e["id"] for e in listed] == [exp["id"]]
    one = c.get(f"/cockpit/explorations/{exp['id']}", headers=hdr(env.b)).json()["data"]
    assert "## Seed" in one["body"]
    r = c.patch(f"/cockpit/explorations/{exp['id']}", headers=hdr(env.b), json={"status": "archived"})
    assert r.status_code == 200 and r.json()["data"]["status"] == "archived"
    assert c.get("/cockpit/explorations?status=archived", headers=hdr(env.b)).json()["data"][0]["id"] == exp["id"]
    r = c.post(f"/cockpit/explorations/{exp['id']}/open", headers=hdr(env.b), json={})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["session_id"] == f"explore-{exp['id']}"
    assert c.get("/cockpit/explorations/exp-00000000", headers=hdr(env.b)).status_code == 404
    assert c.get("/cockpit/explorations/nope", headers=hdr(env.b)).status_code == 400
    assert c.post("/cockpit/explorations", headers=hdr(env.b), json={}).status_code == 400
    assert c.get("/cockpit/explorations", headers={}).status_code == 401


def test_someday_promote_to_explore(cockpit_env):
    env = cockpit_env
    c = env.client
    r = c.post("/someday", headers=SHARED, json={"text": "Durable explorations\nwith a tree", "workspace": str(env.b)})
    item = r.json()["data"]
    r = c.post(f"/someday/{item['id']}/triage", headers=hdr(env.b),
               json={"workspace": str(env.b), "action": "explore", "to": "explore"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    exp, triaged = data["exploration"], data["item"]
    assert triaged["status"] == "explored" and triaged["triage"]["note"] == f"explore:{exp['id']}"
    assert exp["title"] == "Durable explorations" and exp["origin"] == {"kind": "someday", "ref": item["id"]}
    assert "with a tree" in c.get(f"/cockpit/explorations/{exp['id']}", headers=hdr(env.b)).json()["data"]["body"]
    bad = c.post(f"/someday/{item['id']}/triage", headers=hdr(env.b), json={"workspace": str(env.b), "action": "keep", "to": "explore"})
    assert bad.status_code == 400
    missing = c.post("/someday/sd_nope/triage", headers=hdr(env.b), json={"workspace": str(env.b), "action": "explore", "to": "explore"})
    assert missing.status_code in (400, 404)
    assert c.get("/cockpit/explorations", headers=hdr(env.b)).json()["data"][0]["id"] == exp["id"]
