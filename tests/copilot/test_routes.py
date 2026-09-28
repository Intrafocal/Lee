import json
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from hester.daemon.copilot import retro
from hester.shared import auth

from .conftest import queued
from .test_device_auth import write_device


@pytest.fixture
def client(tmp_path, monkeypatch):
    import hester.daemon.main as main

    devices = tmp_path / "devices"
    monkeypatch.setenv("LEE_API_TOKEN", "shared-secret")
    monkeypatch.delenv("HESTER_AUTH_DISABLED", raising=False)
    monkeypatch.setattr(main, "device_for_token", lambda t: auth.device_for_token(t, devices))
    write_device(devices, "dev_00000000abcd", "device-token", kind="aeronaut")
    return TestClient(main.app)


SHARED = {"Authorization": "Bearer shared-secret"}
DEVICE = {"Authorization": "Bearer device-token"}


def test_ideas_create_list_triage(client, tmp_path, isolated_copilot):
    ws = tmp_path / "ws"
    ws.mkdir()
    r = client.post("/ideas", headers=SHARED, json={
        "text": "idea one", "workspace": str(ws), "as": "explore", "source": {"surface": "lee"},
    })
    assert r.status_code == 201, r.text
    item = r.json()["data"]
    assert item["text"] == "idea one" and item["as"] == "explore" and item["source"] == {"surface": "lee"}

    r = client.post("/ideas", headers=DEVICE, json={"text": "from phone", "workspace": str(ws), "source": {"surface": "lee"}})
    assert r.status_code == 201
    assert r.json()["data"]["source"] == {"surface": "aeronaut", "device_id": "dev_00000000abcd"}

    r = client.get("/ideas", headers=SHARED, params={"workspace": str(ws)})
    assert sorted(i["text"] for i in r.json()["data"]) == ["from phone", "idea one"]

    r = client.post(f"/ideas/{item['id']}/triage", headers=DEVICE, json={"workspace": str(ws), "action": "promote", "note": "go"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["status"] == "promoted"
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "idea.triage"]
    assert ev["data"]["idea_id"] == item["id"] and ev["data"]["action"] == "promote"
    assert ev["actor"] == {"kind": "user", "surface": "device", "device_id": "dev_00000000abcd", "device_kind": "aeronaut"}
    assert ev["workspace"] == str(ws.resolve())

    r = client.get("/ideas", headers=SHARED, params={"workspace": str(ws)})
    assert len(r.json()["data"]) == 1
    r = client.get("/ideas", headers=SHARED, params={"workspace": str(ws), "status": "all"})
    assert len(r.json()["data"]) == 2


def test_ideas_errors(client, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    assert client.post("/ideas", headers=SHARED, json={"text": "", "workspace": str(ws)}).status_code == 400
    assert client.post("/ideas", headers=SHARED, json={"text": "x", "workspace": "relative/path"}).status_code == 400
    assert client.post("/ideas", headers=SHARED, json={"text": "x", "workspace": str(tmp_path / "nope")}).status_code == 404
    assert client.post("/ideas", headers=SHARED, content="not json").status_code == 400
    r = client.post("/ideas/idea_20260101T000000_abcd/triage", headers=SHARED, json={"workspace": str(ws), "action": "keep"})
    assert r.status_code == 404
    assert r.json() == {"success": False, "error": "not found"}
    r = client.post("/ideas/bad/triage", headers=SHARED, json={"workspace": str(ws), "action": "keep"})
    assert r.status_code == 400
    assert client.post("/ideas", json={"text": "x", "workspace": str(ws)}).status_code == 401


def test_digest_lee_offline(client, tmp_path, isolated_copilot):
    ws = tmp_path / "ws"
    ws.mkdir()
    since = (datetime.now().astimezone() - timedelta(hours=2)).isoformat()
    focus = json.dumps({"kind": "files", "workspace": str(ws), "paths": [str(ws / "a.py")]})
    r = client.get("/copilot/digest", headers=DEVICE, params={"workspace": str(ws), "since": since, "focus": focus, "only_related": "1"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["workspace"] == str(ws.resolve())
    assert data["waiting"] == []
    assert "Lee offline" in data["top_line"]
    assert data["focus"]["kind"] == "files"
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "digest.shown"]
    assert ev["data"]["surface"] == "aeronaut"
    assert ev["actor"]["surface"] == "device"

    assert client.get("/copilot/digest", headers=SHARED, params={"workspace": str(ws), "since": "yesterday"}).status_code == 400
    assert client.get("/copilot/digest", headers=SHARED, params={"workspace": str(ws), "focus": "{"}).status_code == 400


def test_retro_get_and_post(client, tmp_path, isolated_copilot, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr(retro, "load_copilot_config", lambda: {"retro": {"day": "mon", "time": "00:00"}})

    r = client.get("/copilot/retro", headers=SHARED, params={"workspace": str(ws), "peek": "1"})
    assert r.status_code == 200 and r.json()["data"]["due"] is True
    assert not [e for e in queued(isolated_copilot) if e["type"] == "retro.shown"]

    r = client.get("/copilot/retro", headers=SHARED, params={"workspace": str(ws)})
    assert r.status_code == 200
    data = r.json()["data"]
    week = data["week"]
    assert data["due"] is True and data["answered"] is False
    assert [q["id"] for q in data["questions"]] == ["ideas_or_plumbing", "stuck_good_bad", "surprise"]
    assert data["wins"] == []
    client.get("/copilot/retro", headers=SHARED, params={"workspace": str(ws)})
    assert len([e for e in queued(isolated_copilot) if e["type"] == "retro.shown"]) == 1

    r = client.post("/copilot/retro", headers=SHARED, json={
        "week": week, "workspace": str(ws), "answers": {"surprise": "yes: the peek rate", "ideas_or_plumbing": "  "},
    })
    assert r.status_code == 200, r.text
    saved = json.loads((tmp_path / "retro" / f"{week}.json").read_text())
    assert saved["answers"] == {"surprise": "yes: the peek rate"}
    assert saved["answered_at"] and saved["skipped"] is False and saved["shown_at"]
    assert saved["wins_count"] == 0
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "retro.answered"]
    assert ev["data"] == {"week": week, "answered": ["surprise"], "ts_source": ev["data"]["ts_source"]}

    r = client.get("/copilot/retro", headers=SHARED, params={"workspace": str(ws)})
    assert r.json()["data"]["due"] is False and r.json()["data"]["answered"] is True

    assert client.post("/copilot/retro", headers=SHARED, json={"week": "39"}).status_code == 400
    assert client.post("/copilot/retro", headers=SHARED, json={"answers": {"surprise": 3}}).status_code == 400
    # matches the regex but is not an ISO week: 400, not 500
    for bad in ("2025-W53", "2026-W00", "2026-W60"):
        r = client.post("/copilot/retro", headers=SHARED, json={"week": bad, "workspace": str(ws)})
        assert r.status_code == 400, (bad, r.text)


def test_retro_past_week_wins_bounded_to_that_week(client, tmp_path, monkeypatch):
    from hester.daemon.copilot import digest

    ws = tmp_path / "ws"
    ws.mkdir()
    calls = []

    def fake_wins(workspace, since, until=None, **kw):
        calls.append((since, until))
        return []

    monkeypatch.setattr(digest, "verified_wins", fake_wins)
    r = client.post("/copilot/retro", headers=SHARED, json={"week": "2026-W30", "workspace": str(ws), "skipped": True})
    assert r.status_code == 200, r.text
    [(since, until)] = calls
    assert until - since == timedelta(days=7)
    assert since == retro.week_start("2026-W30").astimezone().astimezone(since.tzinfo)


def test_retro_schedule_and_skip(tmp_path):
    cfg = {"retro": {"day": "fri", "time": "16:00"}}
    before = datetime(2026, 9, 25, 15, 59).astimezone()
    after = datetime(2026, 9, 25, 16, 0).astimezone()
    assert retro.week_id(before) == "2026-W39"
    assert retro.status(now=before, config=cfg, directory=tmp_path)["due"] is False
    assert retro.status(now=after, config=cfg, directory=tmp_path)["due"] is True
    retro.save("2026-W39", skipped=True, directory=tmp_path)
    st = retro.status(now=after, config=cfg, directory=tmp_path)
    assert st["due"] is False and st["skipped"] is True
    assert retro.status(now=datetime(2026, 9, 28, 17, 0).astimezone(), config=cfg, directory=tmp_path)["week"] == "2026-W40"
    assert retro.schedule({"retro": {"day": "Sunday", "time": "25:99"}}) == (6, retro.dtime(16, 0))
