"""Open next (docs/14-Deep-Work.md §8.1; device contract item 3)."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from hester.daemon.cockpit import deep
from hester.daemon.cockpit.explorations import ExplorationStore
from hester.daemon.copilot import open_next, opener
from hester.daemon.copilot.someday import SomedayStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401

NOW = datetime(2026, 9, 26, 9, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def session(store, exp_id, start, end, fsid="f1"):
    return deep.add_session(store, exp_id, {
        "focus_session_id": fsid, "started_at": iso(start), "ended_at": iso(end),
        "reason": "ritual", "stopped_at": None, "rating": None, "questions_kept": [],
    })


# ---------------------------------------------------------------- store


def test_set_get_and_validation(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "Mesh sync"}, now=NOW - timedelta(days=1))
    assert open_next.get(tmp_path, NOW) is None
    with pytest.raises(open_next.OpenNextError) as e:
        open_next.set_(tmp_path, now=NOW)
    assert e.value.status == 400
    with pytest.raises(open_next.OpenNextError):
        open_next.set_(tmp_path, exploration_id="../etc", now=NOW)
    with pytest.raises(open_next.OpenNextError) as e:
        open_next.set_(tmp_path, exploration_id="exp-20260101-000000-dead", now=NOW)
    assert e.value.status in (400, 404)
    with pytest.raises(open_next.OpenNextError) as e:
        open_next.set_(tmp_path, someday_id="sd_20260101T000000_abcd", now=NOW)
    assert e.value.status == 404

    rec = open_next.set_(tmp_path, exploration_id=exp["id"], surface="aeronaut", now=NOW)
    assert rec == {"exploration_id": exp["id"], "set_at": "2026-09-26T09:00:00Z", "surface": "aeronaut"}
    on_disk = json.loads((tmp_path / ".hester" / "deep" / "open_next.json").read_text())
    assert on_disk == rec
    assert open_next.get(tmp_path, NOW + timedelta(hours=1)) == rec


def test_clears_after_three_days(tmp_path):
    exp = ExplorationStore(tmp_path).create({"seed": "Mesh sync"}, now=NOW)
    open_next.set_(tmp_path, exploration_id=exp["id"], now=NOW)
    assert open_next.get(tmp_path, NOW + timedelta(days=2, hours=23)) is not None
    assert open_next.get(tmp_path, NOW + timedelta(days=3)) is None
    assert not open_next.path_for(tmp_path).exists()


def test_clears_when_the_next_session_is_recorded(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "Mesh sync"}, now=NOW - timedelta(days=1))
    other = store.create({"seed": "Queue design"}, now=NOW - timedelta(days=1))
    open_next.set_(tmp_path, exploration_id=exp["id"], now=NOW)
    # a session that started before the pick (e.g. an auto record for the last one) doesn't clear it
    rec = session(store, exp["id"], NOW - timedelta(hours=2), NOW - timedelta(hours=1))
    assert open_next.on_session(tmp_path, exp["id"], rec) is False
    assert open_next.get(tmp_path, NOW + timedelta(hours=1)) is not None
    # another exploration's session doesn't either
    rec = session(store, other["id"], NOW + timedelta(hours=1), NOW + timedelta(hours=2), "f2")
    assert open_next.on_session(tmp_path, other["id"], rec) is False
    # the next session on it does
    rec = session(store, exp["id"], NOW + timedelta(hours=3), NOW + timedelta(hours=4), "f3")
    assert open_next.on_session(tmp_path, exp["id"], rec) is True
    assert open_next.get(tmp_path, NOW + timedelta(hours=5)) is None


def test_read_clears_after_a_session_even_without_the_hook(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "Mesh sync"}, now=NOW - timedelta(days=1))
    open_next.set_(tmp_path, exploration_id=exp["id"], now=NOW)
    session(store, exp["id"], NOW + timedelta(minutes=5), NOW + timedelta(hours=1))
    assert open_next.get(tmp_path, NOW + timedelta(hours=2)) is None


def test_someday_pick_clears_once_triaged(tmp_path):
    item = SomedayStore(tmp_path).create("Try a CRDT", source={"surface": "aeronaut"})
    open_next.set_(tmp_path, someday_id=item.id, surface="aeronaut", now=datetime.now(timezone.utc))
    assert open_next.get(tmp_path)["someday_id"] == item.id
    SomedayStore(tmp_path).triage(item.id, "keep")
    assert open_next.get(tmp_path) is None


# ---------------------------------------------------------------- opener


def test_opener_prefers_the_open_next_exploration(tmp_path, events_dir):
    store = ExplorationStore(tmp_path)
    picked = store.create({"seed": "Picked on the walk"}, now=NOW - timedelta(days=5))
    recent = store.create({"seed": "Recent"}, now=NOW - timedelta(days=2))
    session(store, recent["id"], NOW - timedelta(days=1, hours=2), NOW - timedelta(days=1))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"]["exploration"]["id"] == recent["id"] and op["pick_up"]["open_next"] is False
    assert op["open_next"] is None

    open_next.set_(tmp_path, exploration_id=picked["id"], surface="dirigible", now=NOW - timedelta(hours=3))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"]["exploration"]["id"] == picked["id"] and op["pick_up"]["open_next"] is True
    assert op["open_next"]["surface"] == "dirigible"


def test_opener_lists_the_open_next_capture_first(tmp_path, events_dir):
    store = SomedayStore(tmp_path)
    old = store.create("Captured at the desk long ago", source={"surface": "lee"}, now=NOW - timedelta(days=20))
    away = store.create("From the phone", source={"surface": "aeronaut"}, now=NOW - timedelta(hours=2))
    open_next.set_(tmp_path, someday_id=old.id, now=NOW - timedelta(hours=1))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    captured = next(s for s in op["surfaces"] if s["kind"] == "captured_away")
    assert [c["someday_id"] for c in captured["items"]] == [old.id, away.id]
    assert captured["items"][0]["open_next"] is True


# ---------------------------------------------------------------- routes


def test_routes_with_a_device(cockpit_env, events_dir):  # noqa: F811
    c = cockpit_env.client
    exp = ExplorationStore(cockpit_env.a).create({"seed": "Queue design"})
    r = c.get("/copilot/open-next", headers=hdr(device=True))
    assert r.status_code == 200 and r.json()["data"] is None

    r = c.post("/copilot/open-next", json={"exploration_id": exp["id"]}, headers=hdr(device=True))
    assert r.status_code == 200, r.text
    assert r.json()["data"]["surface"] == "aeronaut" and r.json()["data"]["exploration_id"] == exp["id"]
    assert c.get(f"/copilot/open-next?workspace={cockpit_env.a}", headers=hdr()).json()["data"]["exploration_id"] == exp["id"]
    assert c.get("/copilot/opener", headers=hdr()).json()["data"]["pick_up"]["open_next"] is True

    assert c.post("/copilot/open-next", json={}, headers=hdr()).status_code == 400
    assert c.post("/copilot/open-next", json={"someday_id": "sd_20260101T000000_abcd"}, headers=hdr()).status_code == 404
    assert c.post("/copilot/open-next", json={"exploration_id": exp["id"], "workspace": "rel"}, headers=hdr()).status_code == 400

    # posting the next session record clears it
    started = datetime.now(timezone.utc) + timedelta(seconds=5)
    r = c.post(f"/cockpit/explorations/{exp['id']}/sessions", json={
        "focus_session_id": "f9", "started_at": iso(started), "ended_at": iso(started + timedelta(minutes=40)),
        "reason": "ritual", "stopped_at": "here", "rating": "deep", "questions_kept": [],
    }, headers=hdr(cockpit_env.a))
    assert r.status_code == 201, r.text
    assert not open_next.path_for(cockpit_env.a).exists()

    # Lee main relays POST /carry/open-next with the shared token and names the device's surface;
    # a device can't claim another surface.
    r = c.post("/copilot/open-next", json={"exploration_id": exp["id"], "surface": "dirigible"}, headers=hdr())
    assert r.json()["data"]["surface"] == "dirigible"
    r = c.post("/copilot/open-next", json={"exploration_id": exp["id"], "surface": "lee"}, headers=hdr(device=True))
    assert r.json()["data"]["surface"] == "aeronaut"
    r = c.delete("/copilot/open-next", headers=hdr(device=True))
    assert r.json()["data"] == {"cleared": True}
    assert c.delete("/copilot/open-next", headers=hdr()).json()["data"] == {"cleared": False}


def test_device_capture_keeps_exploration_id(cockpit_env):  # noqa: F811
    """Carry capture: a device's source keeps exploration_id; only surface (and device_id) are the principal's."""
    exp = ExplorationStore(cockpit_env.a).create({"seed": "Queue design"})
    r = cockpit_env.client.post("/someday", json={
        "text": "the retry budget is per tenant", "as": "someday",
        "source": {"surface": "lee", "device_id": "spoofed", "exploration_id": exp["id"]},
    }, headers=hdr(device=True))
    assert r.status_code == 201, r.text
    assert r.json()["data"]["source"] == {
        "surface": "aeronaut", "device_id": "dev_00000000abcd", "exploration_id": exp["id"],
    }
