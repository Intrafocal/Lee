"""Desk D2 (contract docs/plans/2026-09-27-desk-foundation-contract.md §3, §4): the store and its routes."""

import asyncio
from types import SimpleNamespace

from hester.daemon.cockpit import deep, deep_ask
from hester.daemon.cockpit.desk import AREA_ID_RE, PAGE_ID_RE, DeskStore
from hester.daemon.copilot.ideas import IdeasStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued
from .test_deep_ask import PAGE, FakeAgent, anchor
from .test_deep_ask import agent  # noqa: F401


def main_area(c, h):
    return c.get("/desk", headers=h).json()["data"]["areas"][0]


def new_page(c, h, **body):
    r = c.post("/desk/pages", headers=h, json=body)
    assert r.status_code == 201, r.text
    return r.json()["data"]["card"]


# ---------------------------------------------------------------- the store


def test_an_empty_desk_gets_main_and_the_built_in_drawers(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    r = c.get("/desk", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] and body["workspace"] == str(cockpit_env.a) and body["workspace_id"]
    desk = body["data"]
    assert desk["version"] == 1 and desk["workspace"] == str(cockpit_env.a)
    [area] = desk["areas"]
    assert area["name"] == "Main" and (area["x"], area["y"], area["w"], area["h"]) == (0, 0, 1200, 800)
    assert AREA_ID_RE.match(area["id"]) and area["drawer_id"] is None and area["migrated_from"] is None
    assert desk["cards"] == [] and desk["goals_card_id"] is None and desk["last"] is None and desk["migration"] is None
    assert [(d["id"], d["kind"]) for d in desk["drawers"]] == [("ideas", "ideas"), ("stashed", "areas")]
    # read again: still one Main
    assert len(c.get("/desk", headers=h).json()["data"]["areas"]) == 1


def test_areas_create_patch_place_and_delete(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    r = c.post("/desk/areas", headers=h, json={"name": "  Mesh   sync "})
    assert r.status_code == 201, r.text
    sync = r.json()["data"]
    assert sync["name"] == "Mesh sync" and (sync["x"], sync["y"]) == (1400, 0), "the next free grid slot"
    placed = c.post("/desk/areas", headers=h, json={"name": "Placed", "x": 5, "y": 6000, "w": 300, "h": 200}).json()["data"]
    assert (placed["x"], placed["y"], placed["w"], placed["h"]) == (5, 6000, 300, 200)
    for bad in ({}, {"name": ""}, {"name": "x" * 121}, {"name": 3}, {"name": "ok", "w": -1}, {"name": "ok", "x": "1"}):
        assert c.post("/desk/areas", headers=h, json=bad).status_code == 400, bad
    r = c.patch(f"/desk/areas/{sync['id']}", headers=h, json={"name": "Sync", "x": 10})
    assert r.status_code == 200 and r.json()["data"]["name"] == "Sync" and r.json()["data"]["x"] == 10
    assert c.patch(f"/desk/areas/{sync['id']}", headers=h, json={"drawer_id": "stashed"}).status_code == 400
    assert c.patch("/desk/areas/area-00000000", headers=h, json={"name": "x"}).status_code == 404

    new_page(c, h, area_id=main["id"], text="words")
    r = c.delete(f"/desk/areas/{main['id']}", headers=h)
    assert r.status_code == 409 and r.json() == {"success": False, "error": "not_empty"}
    assert c.delete(f"/desk/areas/{placed['id']}", headers=h).json()["data"] == {"deleted": True, "cards": 0}
    assert c.delete(f"/desk/areas/{placed['id']}", headers=h).status_code == 404


def test_stash_unstash_and_drawers(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    other = c.post("/desk/areas", headers=h, json={"name": "Other"}).json()["data"]
    r = c.post(f"/desk/areas/{main['id']}/stash", headers=h, json={})
    assert r.status_code == 200 and r.json()["data"]["drawer_id"] == "stashed"
    assert c.post(f"/desk/areas/{other['id']}/stash", headers=h, json={"drawer_id": "ideas"}).status_code == 400
    assert c.post(f"/desk/areas/{other['id']}/stash", headers=h, json={"drawer_id": "drw-00000000"}).status_code == 400

    r = c.post("/desk/drawers", headers=h, json={"name": "Archive"})
    assert r.status_code == 201
    drawer = r.json()["data"]
    assert drawer["id"].startswith("drw-") and drawer["kind"] == "areas" and drawer["count"] == 0
    assert c.patch(f"/desk/drawers/{drawer['id']}", headers=h, json={"name": "Old"}).json()["data"]["name"] == "Old"
    assert c.patch("/desk/drawers/ideas", headers=h, json={"name": "x"}).status_code == 400
    assert c.patch("/desk/drawers/stashed", headers=h, json={"name": "Shelf"}).json()["data"]["name"] == "Shelf"
    assert c.patch("/desk/drawers/drw-00000000", headers=h, json={"name": "x"}).status_code == 404
    assert c.post(f"/desk/areas/{other['id']}/stash", headers=h, json={"drawer_id": drawer["id"]}).status_code == 200

    IdeasStore(cockpit_env.a).create("an idea", source={"surface": "lee"})
    drawers = c.get("/desk", headers=h).json()["data"]["drawers"]
    assert [d["id"] for d in drawers] == ["ideas", "stashed", drawer["id"]]
    assert drawers[0]["count"] == 1 and drawers[0]["area_ids"] == []
    assert drawers[1]["area_ids"] == [main["id"]] and drawers[1]["name"] == "Shelf"
    assert drawers[2]["area_ids"] == [other["id"]] and drawers[2]["count"] == 1

    r = c.post(f"/desk/areas/{main['id']}/unstash", headers=h, json={"x": 7})
    assert r.status_code == 200 and r.json()["data"]["drawer_id"] is None and r.json()["data"]["x"] == 7
    r = c.post(f"/desk/areas/{main['id']}/unstash", headers=h, json={})
    assert r.status_code == 409 and r.json()["error"] == "not_stashed"


def test_pages_create_place_move_and_titles(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    main = main_area(c, h)
    r = c.post("/desk/pages", headers=h, json={"area_id": main["id"], "text": "First words\n"})
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    card = data["card"]
    assert data["created"] is True and data["page"] == {"text": "First words\n", "version": deep.page_version("First words\n")}
    assert PAGE_ID_RE.match(card["id"]) and card["kind"] == "page" and card["title"] == "Untitled"
    assert (card["x"], card["y"], card["w"], card["h"]) == (48, 96, 360, 240)
    assert card["area_id"] == main["id"] and card["pinned"] is False and card["purpose"] is None
    assert card["summary"]["page_chars"] == 12 and card["summary"]["excerpt"] == "First words\n"
    second = new_page(c, h, area_id=main["id"])
    assert (second["x"], second["y"]) == (456, 96), "the next free spot in the Area"
    beside = new_page(c, h, **{"from": {"card_id": card["id"], "anchor": {"kind": "none"}}, "text": "More"})
    assert beside["area_id"] == main["id"] and (beside["x"], beside["y"]) == (456, 96)

    assert c.post("/desk/pages", headers=h, json={"text": "no area"}).status_code == 400
    assert c.post("/desk/pages", headers=h, json={"from": {"card_id": "pg-00000000"}}).status_code == 404
    assert c.post("/desk/pages", headers=h, json={"area_id": "area-00000000"}).status_code == 404
    assert c.post("/desk/pages", headers=h, json={"area_id": main["id"], "text": 3}).status_code == 400
    assert c.post("/desk/pages", headers=h, json={"area_id": main["id"], "purpose": "notes"}).status_code == 400

    other = c.post("/desk/areas", headers=h, json={"name": "Other"}).json()["data"]
    r = c.patch(f"/desk/cards/{card['id']}", headers=h, json={"x": 100, "y": 200, "area_id": other["id"]})
    assert r.status_code == 200 and (r.json()["data"]["x"], r.json()["data"]["area_id"]) == (100, other["id"])
    assert c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": "area-00000000"}).status_code == 404
    assert c.patch(f"/desk/cards/{card['id']}", headers=h, json={"kind": "board"}).status_code == 400
    c.post(f"/desk/areas/{main['id']}/stash", headers=h, json={})
    assert c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": main["id"]}).status_code == 400
    assert c.post("/desk/pages", headers=h, json={"area_id": main["id"]}).status_code == 400

    r = c.patch(f"/desk/pages/{card['id']}", headers=h, json={"title": "Mesh sync"})
    assert r.status_code == 200 and r.json()["data"]["title"] == "Mesh sync"
    assert c.patch(f"/desk/pages/{card['id']}", headers=h, json={"title": " "}).status_code == 400
    assert c.patch(f"/desk/pages/{card['id']}", headers=h, json={"x": 1}).status_code == 400
    got = c.get(f"/desk/pages/{card['id']}", headers=h).json()["data"]
    assert got["title"] == "Mesh sync" and got["id"] == card["id"]
    assert c.get("/desk/pages/pg-00000000", headers=h).status_code == 404
    assert c.get("/desk/pages/exp-00000000", headers=h).status_code == 400
    # titles live in card.json, layout in desk.json; GET /desk joins them
    raw = DeskStore(cockpit_env.a)._read()
    assert "title" not in next(e for e in raw["cards"] if e["id"] == card["id"])
    assert next(x for x in c.get("/desk", headers=h).json()["data"]["cards"] if x["id"] == card["id"])["title"] == "Mesh sync"


def test_the_goals_card_is_unique_and_pinned(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    r = c.post("/desk/pages", headers=h, json={"purpose": "goals", "text": "## What is this for?\n\nMesh.\n"})
    assert r.status_code == 201, r.text
    goals = r.json()["data"]["card"]
    assert goals["pinned"] is True and goals["purpose"] == "goals" and goals["area_id"] is None
    assert (goals["x"], goals["y"], goals["w"], goals["h"]) == (0, 0, 0, 0) and goals["title"] == "Goals"
    r = c.post("/desk/pages", headers=h, json={"purpose": "goals", "text": "another"})
    assert r.status_code == 200
    again = r.json()["data"]
    assert again["created"] is False and again["card"]["id"] == goals["id"]
    assert again["page"]["text"] == "## What is this for?\n\nMesh.\n"
    assert c.get("/desk", headers=h).json()["data"]["goals_card_id"] == goals["id"]
    for move in ({"x": 5}, {"area_id": main_area(c, h)["id"]}, {"w": 10}):
        assert c.patch(f"/desk/cards/{goals['id']}", headers=h, json=move).status_code == 400, move
    assert c.patch(f"/desk/cards/{goals['id']}", headers=h, json={"title": "What this is for"}).status_code == 200
    # "New Page from" the Goals card lands in the first Area on the Desk
    beside = new_page(c, h, **{"from": {"card_id": goals["id"]}, "text": "x"})
    assert beside["area_id"] == main_area(c, h)["id"]


def test_last_card(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    card = new_page(c, h, area_id=main_area(c, h)["id"], text="x")
    r = c.put("/desk/last", headers=h, json={"card_id": card["id"]})
    assert r.status_code == 200 and r.json()["data"]["card_id"] == card["id"] and r.json()["data"]["at"]
    assert c.get("/desk", headers=h).json()["data"]["last"]["card_id"] == card["id"]
    assert c.put("/desk/last", headers=h, json={"card_id": "pg-00000000"}).status_code == 404
    assert c.put("/desk/last", headers=h, json={}).status_code == 400


# ---------------------------------------------------------------- a Page card's routes


def test_page_conflict_and_the_delete_guard(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    area = main_area(c, h)["id"]
    card = new_page(c, h, area_id=area, text="one\n")
    base = f"/desk/pages/{card['id']}"
    page = c.get(f"{base}/page", headers=h).json()["data"]
    assert page == {"text": "one\n", "version": deep.page_version("one\n")}
    r = c.put(f"{base}/page", headers=h, json={"text": "two\n", "base_version": page["version"]})
    assert r.status_code == 200 and r.json()["data"]["version"] == deep.page_version("two\n")
    r = c.put(f"{base}/page", headers=h, json={"text": "three\n", "base_version": page["version"]})
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "version_conflict" and body["text"] == "two\n" and body["data"]["version"] == deep.page_version("two\n")
    too_big = "x" * (1024 * 1024 + 1)
    assert c.put(f"{base}/page", headers=h, json={"text": too_big, "base_version": deep.page_version("two\n")}).status_code == 400
    assert c.get("/desk/pages/pg-00000000/page", headers=h).status_code == 404

    r = c.delete(base, headers=h)
    assert r.status_code == 409 and r.json()["error"] == "not_empty"
    empty = new_page(c, h, area_id=area)
    q = new_page(c, h, area_id=area)
    c.post(f"/desk/pages/{q['id']}/questions", headers=h, json={"text": "Why?", "source": "page"})
    assert c.delete(f"/desk/pages/{q['id']}", headers=h).status_code == 409, "a question keeps it"
    named = new_page(c, h, area_id=area, title="Named")
    assert c.delete(f"/desk/pages/{named['id']}", headers=h).status_code == 409, "a title keeps it"
    c.put("/desk/last", headers=h, json={"card_id": empty["id"]})
    r = c.delete(f"/desk/pages/{empty['id']}", headers=h)
    assert r.status_code == 200 and r.json()["data"] == {"deleted": True}
    assert not (cockpit_env.a / ".hester" / "desk" / "pages" / empty["id"]).exists()
    desk = c.get("/desk", headers=h).json()["data"]
    assert empty["id"] not in [x["id"] for x in desk["cards"]] and desk["last"] is None
    assert c.delete(f"/desk/pages/{empty['id']}", headers=h).status_code == 404


def test_references_questions_asks_and_handoffs_on_a_card(cockpit_env, monkeypatch):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    (env.a / "src").mkdir()
    (env.a / "src" / "sync.py").write_text("x = 1\n")
    card = new_page(c, h, area_id=main_area(c, h)["id"], text=PAGE)
    base = f"/desk/pages/{card['id']}"

    # file references: workspace-relative, existing, inside
    for bad in ("../etc/passwd", "/etc/passwd", "src/missing.py"):
        r = c.post(f"{base}/references", headers=h, json={"kind": "link", "file": bad})
        assert r.status_code == 400, bad
    r = c.post(f"{base}/references", headers=h, json={"kind": "link", "file": "src/sync.py", "lines": [1, 1]})
    assert r.status_code == 201 and r.json()["data"]["file"] == "src/sync.py"
    ref = c.post(f"{base}/references", headers=h, json={"kind": "link", "url": "https://crdt.tech"}).json()["data"]
    assert c.patch(f"{base}/references/{ref['id']}", headers=h, json={"opened": True}).json()["data"]["opened_at"]
    assert len(c.get(f"{base}/references", headers=h).json()["data"]) == 2

    # questions live in questions.jsonl
    q = c.post(f"{base}/questions", headers=h, json={"text": "Does it partition?", "source": "page"}).json()["data"]
    assert c.patch(f"{base}/questions/{q['id']}", headers=h, json={"status": "closed"}).json()["data"]["status"] == "closed"
    assert c.patch(f"{base}/questions/q-00000000", headers=h, json={"status": "closed"}).status_code == 404
    assert [x["id"] for x in c.get(f"{base}/questions", headers=h).json()["data"]] == [q["id"]]
    assert (env.a / ".hester" / "desk" / "pages" / card["id"] / "questions.jsonl").exists()

    # asks with section_text
    scheduled = []
    monkeypatch.setattr(deep_ask.get_runner(), "schedule", lambda job: scheduled.append(job))
    r = c.post(f"{base}/asks", headers=h, json={"question": "Why?", "anchor": anchor(), "section_text": "## Sync\n\ntext"})
    assert r.status_code == 202, r.text
    ask = r.json()["data"]
    assert ask["section_text"] == "## Sync\n\ntext" and ask["status"] == "queued"
    assert scheduled[0].exp_id == card["id"] and scheduled[0].answer_id == ask["id"]

    # a hand-off, then Lee's PATCH with the task
    r = c.post(f"{base}/handoffs", headers=h, json={"kind": "docs", "provider": "claude", "brief": "Docs: x", "anchor": anchor()})
    assert r.status_code == 201, r.text
    ho = r.json()["data"]
    assert ho["handoff"]["state"] == "launching"
    r = c.patch(f"{base}/answers/{ho['id']}", headers=h, json={"task_id": "task-0000abcd"})
    assert r.status_code == 200 and r.json()["data"]["handoff"]["state"] == "running"
    assert c.post(f"{base}/answers/{ho['id']}/retry", headers=h).status_code == 400
    summary = c.get(base, headers=h).json()["data"]["summary"]
    assert summary["handoffs_in_flight"] == 1 and summary["answers_pending"] == 1 and summary["open_questions"] == 0
    assert {a["id"] for a in c.get(f"{base}/answers", headers=h).json()["data"]} == {ho["id"], ask["id"]}


def test_deep_ask_on_a_card_runs_and_tells_lee(tmp_path, agent, isolated_copilot):  # noqa: F811
    desk = DeskStore(tmp_path)
    area = desk.load()["areas"][0]["id"]
    card, _, _ = desk.create_page({"area_id": area, "title": "Mesh sync", "text": PAGE})
    ans = deep.new_answer(desk.pages, card["id"], {"question": "What's a vector clock?", "anchor": anchor()})

    async def go():
        ctx = SimpleNamespace(path=tmp_path, lock=asyncio.Lock(), desk=lambda: desk, explorations=None)
        runner = deep_ask.DeepAskRunner()
        runner.schedule(deep_ask.Job(ctx, card["id"], ans["id"], {"kind": "user", "surface": "deep-ask"}))
        await runner.drain()

    asyncio.run(go())
    done = deep.get_answer(desk.pages, card["id"], ans["id"])
    assert done["status"] == "done" and done["answer"] == "The answer."
    [req] = agent.requests
    assert "### Page" in req.steward_context and "Title: Mesh sync" in req.steward_context
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "deep.answer"]
    assert ev["data"]["card_id"] == ev["data"]["exploration_id"] == card["id"]


def test_ask_on_the_palette_about_a_page(cockpit_env, monkeypatch):
    from hester.daemon.cockpit import steward

    fake = FakeAgent()
    monkeypatch.setattr(steward, "_agent_provider", lambda: fake)
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    card = new_page(c, h, area_id=main_area(c, h)["id"], title="Mesh sync", text="The vector clock idea.\n")
    r = c.post("/cockpit/ask", headers=h, json={"question": "What's missing here?", "about": {"kind": "page", "id": card["id"]}})
    assert r.status_code == 200, r.text
    [req] = fake.requests
    assert "Page card" in req.steward_context and "The vector clock idea." in req.steward_context
    r = c.post("/cockpit/ask", headers=h, json={"question": "q", "about": {"kind": "page", "id": "pg-00000000"}})
    assert r.status_code == 404


def test_confirmed_deletes_take_cards_with_them(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    area = c.post("/desk/areas", headers=h, json={"name": "Doomed"}).json()["data"]
    one = new_page(c, h, area_id=area["id"], text="words")
    two = new_page(c, h, area_id=area["id"], text="more", title="Named")
    c.put("/desk/last", headers=h, json={"card_id": one["id"]})
    assert c.delete(f"/desk/areas/{area['id']}", headers=h).status_code == 409, "unconfirmed: not_empty"
    r = c.request("DELETE", f"/desk/areas/{area['id']}", headers=h, json={"with_cards": True})
    assert r.status_code == 200 and r.json()["data"] == {"deleted": True, "cards": 2}
    desk = c.get("/desk", headers=h).json()["data"]
    assert all(x["id"] != area["id"] for x in desk["areas"])
    assert all(x["id"] not in (one["id"], two["id"]) for x in desk["cards"])
    assert not (cockpit_env.a / ".hester" / "desk" / "pages" / one["id"]).exists()
    assert (desk.get("last") or {}).get("card_id") != one["id"]

    keep = main_area(c, h)["id"]
    written = new_page(c, h, area_id=keep, text="not empty", title="Written")
    assert c.delete(f"/desk/pages/{written['id']}", headers=h).status_code == 409
    r = c.request("DELETE", f"/desk/pages/{written['id']}", headers=h, json={"force": True})
    assert r.status_code == 200 and r.json()["data"] == {"deleted": True}
    assert c.get(f"/desk/pages/{written['id']}/page", headers=h).status_code == 404
