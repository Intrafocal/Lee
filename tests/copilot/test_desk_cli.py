"""`hester desk`: the read-only view of the Desk and Drawer that Lee's Claude skills call."""

import json

from click.testing import CliRunner

from hester.cli.desk import desk
from hester.daemon.cockpit import deep
from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.copilot.ideas import IdeasStore


def build(ws):
    store = DeskStore(ws)
    area = store.create_area({"name": "Mesh"})
    card, _, _ = store.create_page({"area_id": area["id"], "text": "# Mesh sync\n\nthe vector clock only helps if every write\n", "title": "Mesh sync"})
    deep.add_question(store.pages, card["id"], {"text": "Does it partition?", "source": "page"})
    parked = store.create_area({"name": "Old board idea"})
    store.create_page({"area_id": parked["id"], "text": "tldraw or our own?\n", "title": "Board"})
    store.stash(parked["id"], {})
    store.set_last(card["id"])
    IdeasStore(ws).create("Try a CRDT for the queue", source={"surface": "aeronaut"})
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


def test_boards_in_the_overview_and_hester_desk_board(tmp_path):
    card = build(tmp_path)
    store = DeskStore(tmp_path)
    b, _ = store.create_board({"area_id": card["area_id"], "title": "Header renders"})
    bid = b["id"]
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 8
    img = store.boards.add_asset(bid, "image/png", png, source={"kind": "url", "url": "https://example.com/a"})
    sel = store.boards.add_asset(bid, "image/png", png, kind="selection")
    items = [
        {"id": "it-00000001", "kind": "image", "x": 0, "y": 0, "w": 200, "h": 100, "z": 1, "asset": img["name"]},
        {"id": "it-00000002", "kind": "highlight", "x": 10, "y": 10, "w": 50, "h": 20, "z": 2, "item_id": "it-00000001"},
        {"id": "it-00000003", "kind": "note", "x": 300, "y": 0, "w": 120, "h": 60, "z": 3, "text": "Too tall",
         "pin": {"item_id": "it-00000002", "u": 0.5, "v": 0.5}},
        {"id": "it-00000004", "kind": "link", "x": 300, "y": 100, "w": 120, "h": 40, "z": 4, "card_id": card["id"]},
    ]
    store.boards.write(bid, {"version": None, "items": items})
    anchor = {"kind": "board", "item_ids": ["it-00000001"], "rect": {"x": 0, "y": 0, "w": 200, "h": 100},
              "snapshot": sel["path"], "notes": ["Too tall"]}
    ask = deep.new_answer(store.boards, bid, {"question": "Which is cleaner?", "anchor": anchor})
    deep.update_answer(store.boards, bid, ask["id"], {"status": "done", "answer": "The left one."})
    deep.new_handoff(store.boards, bid, {"kind": "research", "brief": "Research: header heights", "anchor": anchor})
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))

    code, out = run("overview", "--dir", str(tmp_path))
    assert code == 0 and f"Header renders ({bid}) · board · 4 items" in out and f"Mesh sync ({card['id']}) · page ·" in out

    code, out = run("board", "header", "--dir", str(tmp_path))
    folder = tmp_path / ".hester" / "desk" / "boards" / bid
    assert code == 0, out
    assert f"{folder / 'assets' / img['name']} (from url: https://example.com/a)" in out
    assert "- Too tall [pinned to highlight it-00000002]" in out and f"- on image {img['name']}: Too tall" in out
    assert f"- Mesh sync ({card['id']})" in out
    assert "### Q: Which is cleaner?" in out and "The left one." in out and f"Selection (image): {folder / sel['path']}" in out
    assert "### Research to claude: queued" in out and "Brief: Research: header heights" in out

    code, out = run("page", bid, "--dir", str(tmp_path), "--json")
    data = json.loads(out)
    assert code == 0 and data["kind"] == "board" and [n["text"] for n in data["notes"]] == ["Too tall"]
    assert data["images"][0]["source"] == {"kind": "url", "url": "https://example.com/a"}
    code, _ = run("board", "mesh", "--dir", str(tmp_path))
    assert code == 1, "a Page isn't a Board"
    assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before, "read-only: nothing written"
