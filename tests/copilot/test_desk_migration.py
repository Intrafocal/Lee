"""Desk D2 §6.1: the migration from .hester/explore/ copies, runs again safely, and never writes there."""

import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from hester.daemon.cockpit import deep
from hester.daemon.cockpit.desk import DeskStore, PageStore, new_card
from hester.daemon.cockpit.explorations import ExplorationStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401

NOW = datetime(2026, 9, 26, 9, 0, tzinfo=timezone.utc)
PAGE = "# Mesh sync\n\nThe vector clock only helps if every write carries one.\n"


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def snapshot(root: Path):
    """Every file under ``root`` with its bytes and mode, and every directory."""
    out = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        out[rel] = ("dir", None) if p.is_dir() else (p.read_bytes(), oct(os.stat(p).st_mode))
    return out


def fixture(ws: Path):
    """An active, an archived, an empty-Untitled, a goals and a legacy single-file exploration."""
    store = ExplorationStore(ws)
    active = store.create({"seed": "Mesh sync without a server", "page": PAGE, "serves": ["G1"]}, now=NOW - timedelta(days=5))
    q = deep.add_question(store, active["id"], {"text": "Does it partition?", "source": "page"})
    pending = deep.new_answer(store, active["id"], {"question": "What's a vector clock?", "anchor": {"kind": "none"}})
    done = deep.new_answer(store, active["id"], {"question": "Old", "anchor": {"kind": "none"}})
    deep.update_answer(store, active["id"], done["id"], {"status": "done", "answer": "a"})
    handoff = deep.new_handoff(store, active["id"], {"kind": "docs", "brief": "Docs: x", "anchor": {"kind": "none"}})
    deep.patch_answer(store, active["id"], handoff["id"], {"task_id": "task-0000abcd"})
    deep.add_reference(store, active["id"], {"kind": "link", "url": "https://crdt.tech"})
    deep.add_session(store, active["id"], {
        "focus_session_id": "f-1", "started_at": iso(NOW - timedelta(days=1, hours=1)), "ended_at": iso(NOW - timedelta(days=1)),
        "reason": "ritual", "stopped_at": "every write carries one", "rating": "deep", "questions_kept": [q["id"]],
    })

    archived = store.create({"seed": "An old line of thought", "page": "old\n"}, now=NOW - timedelta(days=9))
    store.patch(archived["id"], {"status": "archived"}, now=NOW - timedelta(days=8))
    empty = store.create({"title": "Untitled · Sep 26", "page": ""}, now=NOW - timedelta(days=2))
    goals = store.create({"title": "Goals", "purpose": "goals", "page": "## What is this for?\n\nMesh.\n"}, now=NOW - timedelta(days=4))

    legacy_id = "exp-0badf00d"
    (store.dir).mkdir(parents=True, exist_ok=True)
    (store.dir / f"{legacy_id}.md").write_text(
        "---\nid: exp-0badf00d\ntitle: A legacy idea\nstatus: active\nseed: The legacy seed text\n"
        "created_at: '2026-09-01T10:00:00Z'\nlast_touched_at: '2026-09-02T10:00:00Z'\n---\n# A legacy idea\n\n## Seed\n\nThe legacy seed text\n"
    )
    return {"active": active, "archived": archived, "empty": empty, "goals": goals, "legacy": legacy_id,
            "q": q, "pending": pending, "handoff": handoff}


def pg(exp_id):
    return "pg-" + exp_id[4:]


def test_migrates_copies_and_runs_again(tmp_path):
    fx = fixture(tmp_path)
    explore = tmp_path / ".hester" / "explore"
    before = snapshot(explore)
    desk = DeskStore(tmp_path)

    report = desk.migrate(NOW)
    assert (report["migrated"], report["already"], report["skipped_empty"], report["errors"]) == (4, 0, 1, [])
    assert report["goals_card_id"] == pg(fx["goals"]["id"])
    assert snapshot(explore) == before, "the explore tree is byte-identical"

    raw = desk._read()
    mapping = raw["migration"]["map"]
    assert mapping == {
        fx["active"]["id"]: pg(fx["active"]["id"]), fx["archived"]["id"]: pg(fx["archived"]["id"]),
        fx["empty"]["id"]: None, fx["goals"]["id"]: pg(fx["goals"]["id"]), fx["legacy"]: pg(fx["legacy"]),
    }
    api = desk.desk(NOW)
    assert api["migration"]["migrated"] == 4
    cards = {c["id"]: c for c in api["cards"]}
    areas = {a["id"]: a for a in api["areas"]}
    assert "Main" not in [a["name"] for a in api["areas"]], "a migrated Desk isn't empty"

    # the active one: an Area named after it, one Page in it, the files copied with their ids
    a_id = pg(fx["active"]["id"])
    card = cards[a_id]
    area = areas["area-" + fx["active"]["id"][4:]]
    assert card["area_id"] == area["id"] and area["name"] == fx["active"]["title"] and area["drawer_id"] is None
    assert (card["x"], card["y"], card["w"], card["h"]) == (48, 96, 360, 240)
    assert card["migrated_from"] == fx["active"]["id"] and area["migrated_from"] == fx["active"]["id"]
    on_disk = json.loads((tmp_path / ".hester" / "desk" / "pages" / a_id / "card.json").read_text())
    assert on_disk["seed"] == "Mesh sync without a server" and on_disk["goals"] == ["G1"] and on_disk["kind"] == "page"
    assert on_disk["created_at"] == fx["active"]["created_at"]
    pages = PageStore(tmp_path)
    assert pages.page_path(a_id).read_bytes() == (explore / fx["active"]["id"] / "page.md").read_bytes()
    assert (tmp_path / ".hester/desk/pages" / a_id / "references.jsonl").read_bytes() == \
        (explore / fx["active"]["id"] / "references.jsonl").read_bytes()
    answers = {a["id"]: a for a in deep.list_answers(pages, a_id)}
    assert answers[fx["pending"]["id"]]["status"] == "interrupted", "a pending ask offers Retry"
    assert answers[fx["handoff"]["id"]]["handoff"]["state"] == "running", "a hand-off runs in Lee: left alone"
    assert [q["id"] for q in deep.list_questions(pages, a_id)] == [fx["q"]["id"]]
    assert not (tmp_path / ".hester/desk/pages" / a_id / "exploration.md").exists(), "no node tree, no Log"

    # sessions move to the Desk, questions_kept as card-and-question pairs
    [ses] = desk.list_sessions()
    assert ses["focus_session_id"] == "f-1" and ses["stopped_card_id"] == a_id and ses["cards_touched"] == [a_id]
    assert ses["questions_kept"] == [{"card_id": a_id, "question_id": fx["q"]["id"]}]
    assert ses["stopped_at"] == "every write carries one" and ses["rating"] == "deep"

    # archived: its Area is put away; goals: pinned, no Area; legacy: the Page from its seed
    arch_area = areas["area-" + fx["archived"]["id"][4:]]
    assert arch_area["drawer_id"] == "put-away"
    put_away = next(d for d in api["drawers"] if d["id"] == "put-away")
    assert put_away["area_ids"] == [arch_area["id"]]
    goals = cards[pg(fx["goals"]["id"])]
    assert goals["pinned"] and goals["area_id"] is None and api["goals_card_id"] == goals["id"]
    assert "area-" + fx["goals"]["id"][4:] not in areas
    assert pages.page_text(pg(fx["legacy"])) == "The legacy seed text\n\n"
    assert cards[pg(fx["legacy"])]["title"] == "A legacy idea"
    assert pg(fx["empty"]["id"]) not in cards

    # a grid of 1200x800 slots with a 200 gap, in created_at order (legacy, archived, active)
    placed = sorted((a["x"], a["y"]) for a in api["areas"])
    assert placed == [(0, 0), (1400, 0), (2800, 0)]
    assert (areas["area-0badf00d"]["x"], areas["area-" + fx["archived"]["id"][4:]]["x"]) == (0, 1400)

    # again: nothing new
    again = desk.migrate(NOW + timedelta(minutes=1))
    assert (again["migrated"], again["already"], again["skipped_empty"]) == (0, 4, 0)
    assert desk.desk()["migration"]["at"] == report["at"], "only a run that migrated something is kept"
    assert len(desk.list_sessions()) == 1 and len(desk.desk()["cards"]) == 4
    assert snapshot(explore) == before

    # an exploration made later (an old client) comes over on the next read
    late = ExplorationStore(tmp_path).create({"seed": "Late idea", "page": "late\n"})
    assert pg(late["id"]) in [c["id"] for c in desk.desk()["cards"]]
    assert desk._read()["migration"]["map"][late["id"]] == pg(late["id"])


def test_collisions_take_fresh_ids(tmp_path):
    exp = ExplorationStore(tmp_path).create({"seed": "Clash", "page": "c\n"})
    hexpart = exp["id"][4:]
    desk = DeskStore(tmp_path)
    # a card and an Area that already hold this hex but aren't from this exploration
    desk.pages.write_card(new_card(f"pg-{hexpart}", "Someone else", NOW))
    raw = desk._read()
    raw["areas"].append(desk._area_record(f"area-{hexpart}", "Someone else's", 0, 0, 1200, 800, NOW))
    desk._write(raw)
    report = desk.migrate(NOW)
    assert report["migrated"] == 1
    mapped = desk._read()["migration"]["map"][exp["id"]]
    assert mapped != f"pg-{hexpart}" and mapped.startswith("pg-")
    assert desk.pages.read_card(f"pg-{hexpart}")["title"] == "Someone else", "never overwritten"
    card = next(c for c in desk.desk()["cards"] if c["id"] == mapped)
    assert card["migrated_from"] == exp["id"] and card["area_id"] != f"area-{hexpart}"
    # a legacy ref still finds it through the map
    assert desk.card_for_exploration(exp["id"]) == mapped


def test_a_second_goals_exploration_is_an_ordinary_page(tmp_path):
    store = ExplorationStore(tmp_path)
    first = store.create({"title": "Goals", "purpose": "goals", "page": "one\n"}, now=NOW - timedelta(days=2))
    # a copied-in second one (create_or_get would refuse it)
    second = store.create({"title": "Goals again", "page": "two\n"}, now=NOW - timedelta(days=1))
    path = store.exp_dir(second["id"]) / "exploration.md"
    path.write_text(path.read_text().replace("purpose: null", "purpose: goals"))
    desk = DeskStore(tmp_path)
    desk.migrate(NOW)
    api = desk.desk()
    assert api["goals_card_id"] == pg(first["id"])
    other = next(c for c in api["cards"] if c["id"] == pg(second["id"]))
    assert other["pinned"] is False and other["area_id"] is not None


def test_routes_migrate_on_read_and_on_post(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    fx = fixture(env.a)
    before = snapshot(env.a / ".hester" / "explore")
    data = c.get("/desk", headers=h).json()["data"]
    assert data["migration"]["migrated"] == 4 and len(data["cards"]) == 4
    r = c.post("/desk/migrate", headers=h)
    assert r.status_code == 200 and (r.json()["data"]["migrated"], r.json()["data"]["already"]) == (0, 4)
    # the old routes still work, on the old files
    assert c.get(f"/cockpit/explorations/{fx['archived']['id']}/page", headers=h).json()["data"]["text"] == "old\n"
    # the card is its own copy from here on
    card = pg(fx["archived"]["id"])
    page = c.get(f"/desk/pages/{card}/page", headers=h).json()["data"]
    c.put(f"/desk/pages/{card}/page", headers=h, json={"text": "new\n", "base_version": page["version"]})
    assert (env.a / ".hester" / "explore" / fx["archived"]["id"] / "page.md").read_text() == "old\n"
    after = snapshot(env.a / ".hester" / "explore")
    assert after == before, "Desk reads and writes never touch .hester/explore/"
    shutil.rmtree(env.a / ".hester" / "desk")
