"""Tether, Review and voice, Hester side (docs/plans/2026-09-28-tether-review-voice.md §2, §4.4)."""

import json
import os
import stat

from click.testing import CliRunner

from hester.cli.desk import desk as desk_cli
from hester.daemon.cockpit.desk import MAX_ASSET_BYTES, DeskStore

from .cockpit_helpers import SHARED, cockpit_env, hdr  # noqa: F401
from .desk_helpers import main_area, page

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


# ---------------------------------------------------------------- Put away -> Stashed (§2.3)


def old_desk_json(ws, area_id="area-0a0b0c0d", drawer_name="Put away"):
    """A desk.json from before the rename: the 'put-away' Drawer and put_away_at."""
    d = ws / ".hester" / "desk"
    d.mkdir(parents=True)
    raw = {
        "version": 1,
        "areas": [
            {"id": area_id, "name": "Old", "x": 0, "y": 0, "w": 1200, "h": 800, "drawer_id": "put-away",
             "put_away_at": "2026-09-20T10:00:00Z", "created_at": "2026-09-01T10:00:00Z",
             "updated_at": "2026-09-20T10:00:00Z", "migrated_from": None},
            {"id": "area-0e0e0e0e", "name": "Main", "x": 1400, "y": 0, "w": 1200, "h": 800, "drawer_id": None,
             "put_away_at": None, "created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:00:00Z",
             "migrated_from": None},
        ],
        "cards": [], "strokes": [], "goals_card_id": None, "last": None,
        "drawers": [{"id": "put-away", "name": drawer_name}, {"id": "drw-01020304", "name": "Mine"}],
        "migration": {"map": {}, "last_report": None},
    }
    (d / "desk.json").write_text(json.dumps(raw))
    return d / "desk.json"


def test_put_away_becomes_stashed_once_in_desk_json(tmp_path):
    path = old_desk_json(tmp_path)
    store = DeskStore(tmp_path)
    raw = store.load()
    on_disk = json.loads(path.read_text())
    assert [d["id"] for d in on_disk["drawers"]] == ["stashed", "drw-01020304"]
    assert on_disk["drawers"][0]["name"] == "Stashed"
    old = next(a for a in on_disk["areas"] if a["id"] == "area-0a0b0c0d")
    assert old["drawer_id"] == "stashed" and old["stashed_at"] == "2026-09-20T10:00:00Z" and "put_away_at" not in old
    assert all("put_away_at" not in a for a in on_disk["areas"])
    assert "_renamed_put_away" not in on_disk and "_renamed_put_away" not in raw

    api = store.desk()
    stashed = next(d for d in api["drawers"] if d["id"] == "stashed")
    assert stashed["area_ids"] == ["area-0a0b0c0d"] and stashed["name"] == "Stashed"
    area = next(a for a in api["areas"] if a["id"] == "area-0a0b0c0d")
    assert area["stashed_at"] == "2026-09-20T10:00:00Z" and "put_away_at" not in area

    mtime = path.stat().st_mtime_ns
    store.load()
    assert path.stat().st_mtime_ns == mtime, "already migrated: no second write"


def test_a_renamed_put_away_drawer_keeps_its_name(tmp_path):
    path = old_desk_json(tmp_path, drawer_name="Shelf")
    DeskStore(tmp_path).load()
    assert json.loads(path.read_text())["drawers"][0] == {"id": "stashed", "name": "Shelf"}


def test_stash_and_unstash_routes_and_the_old_ones_are_gone(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    area = c.post("/desk/areas", headers=h, json={"name": "Later"}).json()["data"]
    r = c.post(f"/desk/areas/{area['id']}/stash", headers=h, json={})
    assert r.status_code == 200 and r.json()["data"]["drawer_id"] == "stashed" and r.json()["data"]["stashed_at"]
    r = c.post(f"/desk/areas/{area['id']}/unstash", headers=h, json={})
    assert r.status_code == 200 and r.json()["data"]["drawer_id"] is None and r.json()["data"]["stashed_at"] is None
    assert c.post(f"/desk/areas/{area['id']}/unstash", headers=h, json={}).json()["error"] == "not_stashed"
    assert c.post(f"/desk/areas/{area['id']}/put-away", headers=h, json={}).status_code == 404
    assert c.post(f"/desk/areas/{area['id']}/take-out", headers=h, json={}).status_code == 404


# ---------------------------------------------------------------- removed (§2.4)


def test_open_next_and_pre_desk_routes_are_gone(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    gone = [
        ("GET", "/copilot/open-next"), ("POST", "/copilot/open-next"), ("DELETE", "/copilot/open-next"),
        ("GET", "/cockpit/explorations"), ("POST", "/cockpit/explorations"),
        ("GET", "/cockpit/explorations/exp-0a0b0c0d"), ("PATCH", "/cockpit/explorations/exp-0a0b0c0d"),
        ("GET", "/cockpit/explorations/exp-0a0b0c0d/page"), ("POST", "/cockpit/explorations/exp-0a0b0c0d/nodes"),
        ("POST", "/cockpit/explorations/exp-0a0b0c0d/decisions"), ("POST", "/cockpit/explorations/exp-0a0b0c0d/spikes"),
        ("POST", "/cockpit/explorations/exp-0a0b0c0d/promote"), ("POST", "/cockpit/explorations/exp-0a0b0c0d/archive"),
        ("POST", "/cockpit/explorations/exp-0a0b0c0d/handoffs"),
        ("POST", "/cockpit/explorations/exp-0a0b0c0d/draft-from-readme"),
        ("GET", "/library/sessions"), ("POST", "/library/sessions"), ("GET", "/library/sessions/exp-0a0b0c0d"),
        ("GET", "/someday"), ("POST", "/someday"),
    ]
    for method, url in gone:
        r = c.request(method, url, headers=h, json={})
        assert r.status_code in (404, 405), (method, url, r.status_code)
    # what stays: the Desk's last card, and the hand-off template
    assert c.get("/desk/last", headers=h).status_code == 200
    assert c.get("/cockpit/handoff-template?kind=docs", headers=h).status_code == 200


def test_desk_last_has_no_open_next(tmp_path):
    store = DeskStore(tmp_path)
    card = page(store, "Written", "some words\n")
    (tmp_path / ".hester" / "deep").mkdir(parents=True)
    (tmp_path / ".hester" / "deep" / "open_next.json").write_text(json.dumps({"card_id": card["id"]}))
    last = store.last()
    assert last["source"] == "recent", "open_next.json is ignored"


# ---------------------------------------------------------------- escalate -> a Page card (§2.4)


def test_escalate_makes_a_page_card_in_the_first_area(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.b)
    task = c.post("/cockpit/tasks", headers=h, json={"workspace": str(env.b), "title": "Flaky follower", "serves": ["G1"]}).json()["data"]
    ctx = env.registry.get(env.b)
    rec = ctx.tasks().require(task["id"])
    rec["lee_status"] = {"status": "blocked", "summary": "Cursor resets on rotate"}
    rec["files"] = [f"/w/f{i}.py" for i in range(25)]
    ctx.tasks().save(rec)

    r = c.post(f"/cockpit/tasks/{task['id']}/escalate", headers=h, json={})
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert set(data) == {"card", "area"}
    card, area = data["card"], data["area"]
    first = c.get("/desk", headers=h).json()["data"]["areas"][0]
    assert area["id"] == first["id"] == card["area_id"] and card["title"] == "Flaky follower"

    store = DeskStore(env.b)
    meta = store.pages.read_card(card["id"])
    assert meta["origin"] == {"kind": "task", "ref": task["id"]} and meta["goals"] == ["G1"]
    text = store.pages.page_text(card["id"])
    assert text.startswith("Flaky follower\n\n") and "(the agent's words): Cursor resets on rotate" in text
    assert "/w/f19.py" in text and "/w/f20.py" not in text and "(+5 more)" in text

    after = ctx.tasks().require(task["id"])
    assert after["status"] == "queued", "the task stays open"
    assert f"page:{card['id']}" in ctx.tasks()._body(task["id"])
    assert c.post("/cockpit/tasks/task-missing/escalate", headers=h, json={}).status_code == 404
    assert not (env.b / ".hester" / "explore").exists(), "no exploration any more"


# ---------------------------------------------------------------- images on a Page (§4.4)


def test_page_assets_upload_serve_and_go_with_the_card(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    area = c.get("/desk", headers=h).json()["data"]["areas"][0]["id"]
    card = c.post("/desk/pages", headers=h, json={"area_id": area, "title": "Taxonomy"}).json()["data"]["card"]["id"]
    url = f"/desk/pages/{card}/assets"

    r = c.post(url, headers={**h, "Content-Type": "image/png"}, content=PNG)
    assert r.status_code == 201, r.text
    got = r.json()["data"]
    assert got["name"].startswith("img-") and got["name"].endswith(".png") and got["path"] == f"assets/{got['name']}"
    path = env.a / ".hester" / "desk" / "pages" / card / "assets" / got["name"]
    assert path.read_bytes() == PNG and stat.S_IMODE(os.stat(path).st_mode) == 0o600

    r = c.get(f"{url}/{got['name']}", headers=h)
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"
    jpg = c.post(url, headers={**h, "Content-Type": "image/jpeg"}, content=JPEG).json()["data"]
    assert jpg["name"].endswith(".jpg")
    assert c.get(f"{url}/{jpg['name']}", headers=h).headers["content-type"] == "image/jpeg"

    assert c.post(url, headers={**h, "Content-Type": "text/plain"}, content=b"hello").status_code == 415
    assert c.post(url, headers={**h, "Content-Type": "image/png"}, content=JPEG).status_code == 400, "not a PNG"
    assert c.post(url, headers={**h, "Content-Type": "image/png"}, content=b"").status_code == 400
    big = PNG + b"\x00" * MAX_ASSET_BYTES
    assert c.post(url, headers={**h, "Content-Type": "image/png"}, content=big).status_code == 413
    assert c.post("/desk/pages/pg-00000000/assets", headers={**h, "Content-Type": "image/png"}, content=PNG).status_code == 404
    assert c.get(f"{url}/img-00000000.png", headers=h).status_code == 404
    assert c.get(f"{url}/..%2Fcard.json", headers=h).status_code in (400, 404)
    assert c.get(f"{url}/card.json", headers=h).status_code == 400
    assert c.post(url, content=PNG).status_code == 401

    # the CLI lists a Page's images as paths
    r = CliRunner().invoke(desk_cli, ["page", card, "--dir", str(env.a), "--json"])
    assert r.exit_code == 0 and sorted(json.loads(r.output)["images"]) == sorted([got["path"], jpg["path"]])
    r = CliRunner().invoke(desk_cli, ["page", card, "--dir", str(env.a)])
    assert "## Images (2)" in r.output and got["path"] in r.output

    # deleting the card deletes its images
    assert c.request("DELETE", f"/desk/pages/{card}", headers=h, json={"force": True}).status_code == 200
    assert not path.exists() and not path.parent.exists()


# ---------------------------------------------------------------- hester desk on an unmigrated desk.json


def test_desk_cli_reads_an_old_put_away_drawer_as_stashed(tmp_path):
    path = old_desk_json(tmp_path)
    before = path.read_text()
    r = CliRunner().invoke(desk_cli, ["drawer", "--dir", str(tmp_path), "--json"])
    assert r.exit_code == 0, r.output
    data = json.loads(r.output)
    assert [(a["name"], a["folder"], a["at"]) for a in data["stashed"]] == [("Old", "Stashed", "2026-09-20T10:00:00Z")]
    assert path.read_text() == before, "read-only: the CLI never migrates"
    r = CliRunner().invoke(desk_cli, ["overview", "--dir", str(tmp_path)])
    assert r.exit_code == 0 and "1 stashed Areas" in r.output


def test_desk_cli_reads_stashed_at(tmp_path):
    store = DeskStore(tmp_path)
    area = store.create_area({"name": "Parked"})
    page(store, "Board", "tldraw or our own?\n", area_id=area["id"])
    stashed = store.stash(area["id"], {})
    assert main_area(store)
    r = CliRunner().invoke(desk_cli, ["drawer", "--dir", str(tmp_path), "--json"])
    [row] = json.loads(r.output)["stashed"]
    assert row["folder"] == "Stashed" and row["at"] == stashed["stashed_at"] and row["cards"][0]["title"] == "Board"
