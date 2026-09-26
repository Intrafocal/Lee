from .cockpit_helpers import SHARED, cockpit_env, hdr  # noqa: F401
from .conftest import queued


def capture(c, ws, text):
    r = c.post("/someday", headers=SHARED, json={"text": text, "workspace": str(ws), "source": {"surface": "lee"}})
    assert r.status_code == 201, r.text
    return r.json()["data"]


def test_promote_to_task(cockpit_env, isolated_copilot):
    env = cockpit_env
    c = env.client
    item = capture(c, env.b, "Try a CRDT for the queue\nwith more detail below")
    r = c.post(f"/someday/{item['id']}/triage", headers=hdr(env.b, device=True),
               json={"workspace": str(env.b), "action": "promote", "to": "task"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    task, promoted = data["task"], data["item"]
    assert promoted["status"] == "promoted" and promoted["triage"]["note"] == f"task:{task['id']}"
    assert task["title"] == "Try a CRDT for the queue" and task["status"] == "queued"
    assert task["confirmed"] is True and task["lead"] == "delegate" and task["kind"] == "unknown"
    assert task["origin"] == {"kind": "someday", "ref": item["id"]} and task["workspace"] == str(env.b)
    assert [t["id"] for t in c.get("/cockpit/tasks", headers=hdr(env.b)).json()["data"]] == [task["id"]]
    assert c.get("/cockpit/tasks", headers=hdr(env.a)).json()["data"] == []
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "someday.triage"]
    assert ev["data"]["action"] == "promote"


def test_promote_keeps_a_given_note_and_plain_promote_is_unchanged(cockpit_env):
    env = cockpit_env
    c = env.client
    item = capture(c, env.a, "idea one")
    r = c.post(f"/someday/{item['id']}/triage", headers=SHARED,
               json={"workspace": str(env.a), "action": "promote", "to": "task", "note": "because"})
    assert r.json()["data"]["item"]["triage"]["note"] == "because"

    other = capture(c, env.a, "idea two")
    r = c.post(f"/someday/{other['id']}/triage", headers=SHARED, json={"workspace": str(env.a), "action": "promote"})
    data = r.json()["data"]
    assert data["id"] == other["id"] and data["status"] == "promoted" and "task" not in data
    assert len(c.get("/cockpit/tasks", headers=hdr(env.a)).json()["data"]) == 1


def test_promote_errors(cockpit_env):
    env = cockpit_env
    c = env.client
    item = capture(c, env.a, "idea")
    url = f"/someday/{item['id']}/triage"
    assert c.post(url, headers=SHARED, json={"workspace": str(env.a), "action": "keep", "to": "task"}).status_code == 400
    assert c.post(url, headers=SHARED, json={"workspace": str(env.a), "action": "promote", "to": "workstream"}).status_code == 400
    r = c.post("/someday/sd_20260101T000000_abcd/triage", headers=SHARED, json={"workspace": str(env.a), "action": "promote", "to": "task"})
    assert r.status_code == 404
    assert c.get("/cockpit/tasks", headers=hdr(env.a)).json()["data"] == []
    assert c.get("/someday", headers=SHARED, params={"workspace": str(env.a)}).json()["data"][0]["status"] == "open"
