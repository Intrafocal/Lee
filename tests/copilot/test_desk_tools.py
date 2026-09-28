"""The Desk's tools (docs/16-Desk.md §2): moving cards between Areas, and strokes (lines that mean nothing)."""

from hester.daemon.cockpit import desk as desk_mod
from hester.daemon.cockpit.desk import STROKE_ID_RE, DeskStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .test_desk import main_area, new_page


def test_a_card_moves_between_areas_with_validation(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    other = c.post("/desk/areas", headers=h, json={"name": "Other"}).json()["data"]
    card = new_page(c, h, area_id=main["id"], text="words")

    r = c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": other["id"], "x": 300, "y": 120})
    assert r.status_code == 200, r.text
    moved = r.json()["data"]
    assert (moved["area_id"], moved["x"], moved["y"]) == (other["id"], 300, 120)
    got = next(x for x in c.get("/desk", headers=h).json()["data"]["cards"] if x["id"] == card["id"])
    assert got["area_id"] == other["id"] and (got["w"], got["h"]) == (360, 240), "size kept"

    for bad in (None, 3, "", "main", "exp-00000000"):
        r = c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": bad})
        assert r.status_code == 400, bad
    assert c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": "area-00000000"}).status_code == 404
    assert c.patch(f"/desk/cards/{card['id']}", headers=h, json={"x": "1"}).status_code == 400
    c.post(f"/desk/areas/{main['id']}/stash", headers=h, json={})
    r = c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": main["id"]})
    assert r.status_code == 400 and "stashed" in r.json()["error"]
    # still where it was put
    got = next(x for x in c.get("/desk", headers=h).json()["data"]["cards"] if x["id"] == card["id"])
    assert got["area_id"] == other["id"]


def test_an_area_moves_and_its_cards_and_lines_go_with_it(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    card = new_page(c, h, area_id=main["id"], text="words")
    s = c.post("/desk/strokes", headers=h, json={"area_id": main["id"], "points": [[10, 10], [20, 30]]}).json()["data"]
    r = c.patch(f"/desk/areas/{main['id']}", headers=h, json={"x": 500, "y": -200})
    assert r.status_code == 200 and (r.json()["data"]["x"], r.json()["data"]["y"]) == (500, -200)
    desk = c.get("/desk", headers=h).json()["data"]
    got = next(x for x in desk["cards"] if x["id"] == card["id"])
    assert (got["x"], got["y"], got["area_id"]) == (card["x"], card["y"], main["id"]), "relative to the Area"
    assert next(x for x in desk["strokes"] if x["id"] == s["id"])["points"] == [[10, 10], [20, 30]]


def test_strokes_create_list_and_delete(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    assert c.get("/desk", headers=h).json()["data"]["strokes"] == []

    r = c.post("/desk/strokes", headers=h, json={"area_id": main["id"], "points": [[1, 2], [3.14159, 4.5], [5, 6]], "width": 2})
    assert r.status_code == 201, r.text
    inside = r.json()["data"]
    assert STROKE_ID_RE.match(inside["id"]) and inside["area_id"] == main["id"]
    assert inside["points"] == [[1, 2], [3.14, 4.5], [5, 6]] and inside["width"] == 2 and inside["created_at"]
    r = c.post("/desk/strokes", headers=h, json={"area_id": None, "points": [[-100, -100], [-50, -80]]})
    assert r.status_code == 201
    bare = r.json()["data"]
    assert bare["area_id"] is None and bare["width"] == 2, "Desk-level, the default width"

    strokes = c.get("/desk", headers=h).json()["data"]["strokes"]
    assert [s["id"] for s in strokes] == [inside["id"], bare["id"]]

    r = c.delete(f"/desk/strokes/{bare['id']}", headers=h)
    assert r.status_code == 200 and r.json()["data"] == {"deleted": True}
    assert c.delete(f"/desk/strokes/{bare['id']}", headers=h).status_code == 404
    assert c.delete("/desk/strokes/nope", headers=h).status_code == 400
    assert [s["id"] for s in c.get("/desk", headers=h).json()["data"]["strokes"]] == [inside["id"]]


def test_stroke_validation(cockpit_env, monkeypatch):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    ok = [[0, 0], [1, 1]]
    bad = [
        {},
        {"points": [[0, 0]]},
        {"points": "0,0 1,1"},
        {"points": [[0, 0], [1]]},
        {"points": [[0, 0], [1, "1"]]},
        {"points": [[0, 0], [True, 1]]},
        {"points": [[0, 0], [1e12, 1]]},
        {"points": [[0, 0]] * (desk_mod.MAX_STROKE_POINTS + 1)},
        {"points": ok, "width": 0},
        {"points": ok, "width": 65},
        {"points": ok, "width": "2"},
        {"points": ok, "area_id": "main"},
        {"points": ok, "area_id": 3},
        {"points": ok, "colour": "red"},
    ]
    for body in bad:
        r = c.post("/desk/strokes", headers=h, json=body)
        assert r.status_code == 400, (body if len(str(body)) < 200 else "too many points", r.text)
    assert c.post("/desk/strokes", headers=h, json={"points": ok, "area_id": "area-00000000"}).status_code == 404
    assert c.post("/desk/strokes", headers=h, json={"points": [[0, 0]] * desk_mod.MAX_STROKE_POINTS}).status_code == 201

    c.post(f"/desk/areas/{main['id']}/stash", headers=h, json={})
    r = c.post("/desk/strokes", headers=h, json={"points": ok, "area_id": main["id"]})
    assert r.status_code == 400 and "stashed" in r.json()["error"]

    monkeypatch.setattr(desk_mod, "MAX_STROKES", 2)
    assert c.post("/desk/strokes", headers=h, json={"points": ok}).status_code == 201
    r = c.post("/desk/strokes", headers=h, json={"points": ok})
    assert r.status_code == 400 and "lines" in r.json()["error"]


def test_stash_keeps_lines_and_delete_takes_them(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    other = c.post("/desk/areas", headers=h, json={"name": "Other"}).json()["data"]
    new_page(c, h, area_id=other["id"], text="words")
    mine = c.post("/desk/strokes", headers=h, json={"area_id": other["id"], "points": [[0, 0], [9, 9]]}).json()["data"]
    kept = c.post("/desk/strokes", headers=h, json={"area_id": main["id"], "points": [[0, 0], [9, 9]]}).json()["data"]
    bare = c.post("/desk/strokes", headers=h, json={"points": [[0, 0], [9, 9]]}).json()["data"]

    c.post(f"/desk/areas/{other['id']}/stash", headers=h, json={})
    ids = {s["id"] for s in c.get("/desk", headers=h).json()["data"]["strokes"]}
    assert ids == {mine["id"], kept["id"], bare["id"]}, "stashed: its lines stay with it"
    c.post(f"/desk/areas/{other['id']}/unstash", headers=h, json={})

    assert c.delete(f"/desk/areas/{other['id']}", headers=h).status_code == 409, "lines don't confirm a delete; cards do"
    r = c.request("DELETE", f"/desk/areas/{other['id']}", headers=h, json={"with_cards": True})
    assert r.status_code == 200
    ids = {s["id"] for s in c.get("/desk", headers=h).json()["data"]["strokes"]}
    assert ids == {kept["id"], bare["id"]}, "the Area's lines went with it"

    # An empty Area with only lines deletes without a confirm, lines and all.
    empty = c.post("/desk/areas", headers=h, json={"name": "Sketch"}).json()["data"]
    c.post("/desk/strokes", headers=h, json={"area_id": empty["id"], "points": [[0, 0], [9, 9]]})
    assert c.delete(f"/desk/areas/{empty['id']}", headers=h).status_code == 200
    raw = DeskStore(cockpit_env.a)._read()
    assert all(s["area_id"] != empty["id"] for s in raw["strokes"])


def test_a_desk_json_without_strokes_reads_as_none(tmp_path):
    desk = DeskStore(tmp_path)
    raw = desk.load()
    raw.pop("strokes")
    raw["strokes_bogus"] = 1
    desk._write(raw)
    assert desk.desk()["strokes"] == []
    raw = desk._read()
    raw["strokes"] = [{"id": "bad"}, "x", {"id": "stk-0000000a", "area_id": None, "points": [[0, 0], [1, 1]], "width": 2}]
    desk._write(raw)
    assert [s["id"] for s in desk.desk()["strokes"]] == ["stk-0000000a"]
