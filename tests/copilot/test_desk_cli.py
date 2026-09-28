"""`hester desk`: the read-only view of the Desk and Drawer that Lee's Claude skills call."""

import json

from click.testing import CliRunner

from hester.cli.desk import desk
from hester.daemon.cockpit import deep
from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.copilot.someday import SomedayStore


def build(ws):
    store = DeskStore(ws)
    area = store.create_area({"name": "Mesh"})
    card, _, _ = store.create_page({"area_id": area["id"], "text": "# Mesh sync\n\nthe vector clock only helps if every write\n", "title": "Mesh sync"})
    deep.add_question(store.pages, card["id"], {"text": "Does it partition?", "source": "page"})
    parked = store.create_area({"name": "Old board idea"})
    store.create_page({"area_id": parked["id"], "text": "tldraw or our own?\n", "title": "Board"})
    store.put_away(parked["id"], {})
    store.set_last(card["id"])
    SomedayStore(ws).create("Try a CRDT for the queue", source={"surface": "aeronaut"})
    return card


def run(*args):
    r = CliRunner().invoke(desk, list(args))
    return r.exit_code, r.output


def test_overview_page_last_and_drawer(tmp_path):
    card = build(tmp_path)
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    code, out = run("overview", "--dir", str(tmp_path / ".hester"))  # any directory inside: it looks upward
    assert code == 0 and "## Mesh" in out and f"Mesh sync ({card['id']})" in out and "Old board idea" not in out
    assert "1 stashed Areas, 1 ideas" in out

    code, out = run("page", "mesh", "--dir", str(tmp_path))
    assert code == 0 and "the vector clock only helps" in out and "## Open questions (1)" in out and "Does it partition?" in out

    code, out = run("last", "--dir", str(tmp_path), "--json")
    data = json.loads(out)
    assert code == 0 and data["id"] == card["id"] and data["stopped_at"] == "the vector clock only helps if every write"

    code, out = run("drawer", "--dir", str(tmp_path))
    assert code == 0 and "Old board idea" in out and "Stashed" in out and "Try a CRDT" in out and "from aeronaut" in out
    code, out = run("drawer", "crdt", "--dir", str(tmp_path), "--json")
    data = json.loads(out)
    assert [i["text"] for i in data["ideas"]] == ["Try a CRDT for the queue"] and data["stashed"] == []

    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before, "read-only: nothing written"


def test_no_desk_and_ambiguous_titles(tmp_path):
    code, out = run("overview", "--dir", str(tmp_path))
    assert code == 1
    build(tmp_path)
    store = DeskStore(tmp_path)
    store.create_page({"area_id": store.load()["areas"][0]["id"], "text": "x\n", "title": "Mesh notes"})
    code, out = run("page", "mesh", "--dir", str(tmp_path))
    assert code == 2 and "Several cards match" in out
    code, out = run("page", "nothing like this", "--dir", str(tmp_path))
    assert code == 1
