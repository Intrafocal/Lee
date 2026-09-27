"""The opener at the top of Copilot (Deep D1 §8.1), built deterministically from the Desk (Desk D2 §6.4)."""

from datetime import datetime, timedelta, timezone

from hester.daemon.cockpit import deep
from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.cockpit.explorations import ExplorationStore
from hester.daemon.copilot import opener
from hester.daemon.copilot.someday import SomedayStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import make_event, queued, write_events
from .desk_helpers import page, session

NOW = datetime(2026, 9, 26, 9, 0, tzinfo=timezone.utc)


def ago(**kw):
    return NOW - timedelta(**kw)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def deep_session(ws, sid, card_ids, start, end, reason, rating=None, kind="card"):
    """focus.start on the first card, focus.item for each next one, then focus.end."""
    def item(cid):
        if kind == "exploration":
            return {"kind": "exploration", "workspace": str(ws), "exploration_id": cid, "title": "t"}
        return {"kind": "card", "workspace": str(ws), "card_id": cid, "card_kind": "page", "title": "t"}

    evs = [make_event("focus.start", start, {"session_id": sid, "source": "deep", "policy": "none", "item": item(card_ids[0])})]
    for i, cid in enumerate(card_ids[1:], 1):
        evs.append(make_event("focus.item", start + timedelta(seconds=i), {"session_id": sid, "item": item(cid)}))
    evs.append(make_event("focus.end", end, {"session_id": sid, "source": "deep", "reason": reason, "deep_rating": rating}))
    return evs


def kinds(op):
    return [s["kind"] for s in op["surfaces"]]


def test_empty_workspace_is_just_blank(tmp_path, events_dir):
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"] is None and op["surfaces"] == [{"kind": "blank"}]
    assert op["workspace"] == str(tmp_path) and op["generated_at"]


def test_pick_up_falls_back_to_the_latest_page(tmp_path, events_dir):
    desk = DeskStore(tmp_path)
    page(desk, "No page yet", now=ago(hours=1))
    written = page(desk, "Mesh sync", "First thought\n\nthe vector clock only helps if every write\n\n", now=ago(days=2))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    pick = op["pick_up"]
    assert pick["card"]["id"] == written["id"] and pick["card"]["kind"] == "page"
    assert pick["exploration"] == {"id": written["id"], "title": "Mesh sync", "last_touched_at": iso(ago(days=2))}
    assert pick["stopped_at"] == "the vector clock only helps if every write" and pick["stopped_line"] == 3
    assert pick["arrived"] == {"answers": 0, "open_questions": 0} and pick["open_next"] is False


def test_pick_up_prefers_the_latest_session_and_counts_arrivals(tmp_path, events_dir):
    desk = DeskStore(tmp_path)
    page(desk, "Paged", "lots of writing\n", now=ago(hours=1))
    sessioned = page(desk, "Sessioned", "where I stopped, more or less\n", now=ago(days=3))
    session(desk, [sessioned["id"]], ago(days=1, hours=2), ago(days=1), stopped_at="where I stopped", rating="deep")
    before = deep.new_answer(desk.pages, sessioned["id"], {"question": "old", "anchor": {"kind": "none"}})
    deep.update_answer(desk.pages, sessioned["id"], before["id"], {"status": "done", "answer": "a", "answered_at": iso(ago(days=2))})
    after = deep.new_answer(desk.pages, sessioned["id"], {"question": "new", "anchor": {"kind": "none"}})
    deep.update_answer(desk.pages, sessioned["id"], after["id"], {"status": "done", "answer": "b", "answered_at": iso(ago(hours=5))})
    deep.add_question(desk.pages, sessioned["id"], {"text": "Does it partition?", "source": "page"})
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"]["card"]["id"] == sessioned["id"]
    assert op["pick_up"]["stopped_at"] == "where I stopped" and op["pick_up"]["stopped_line"] == 1
    assert op["pick_up"]["arrived"] == {"answers": 1, "open_questions": 1}


def test_missing_session_records_written_for_away_and_quit(tmp_path, events_dir):
    desk = DeskStore(tmp_path)
    a = page(desk, "Away one", "a\n", now=ago(days=1))
    b = page(desk, "Second card", "b\n", now=ago(days=1))
    other = page(desk, "Ritual one", "c\n", now=ago(days=1))
    session(desk, [other["id"]], ago(hours=9), ago(hours=8), fsid="f-ritual")
    write_events(events_dir, [
        *deep_session(tmp_path, "f-away", [a["id"]], ago(hours=4), ago(hours=3), "away"),
        # zoomed into b, back into a and into b again: first-touched order, the last one is where it stopped
        *deep_session(tmp_path, "f-quit", [b["id"], a["id"], b["id"]], ago(hours=2), ago(hours=1), "quit"),
        *deep_session(tmp_path, "f-ritual", [other["id"]], ago(hours=9), ago(hours=8), "deep_end", "deep"),
        *deep_session("/elsewhere", "f-other-ws", [a["id"]], ago(hours=6), ago(hours=5), "away"),
        *deep_session(tmp_path, "f-deep-end", [a["id"]], ago(hours=7), ago(hours=6), "deep_end"),
    ])
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    rows = {r["focus_session_id"]: r for r in desk.list_sessions()}
    assert sorted(rows) == ["f-away", "f-quit", "f-ritual"], "only away and quit, only here, never twice"
    assert rows["f-away"]["cards_touched"] == [a["id"]] and rows["f-away"]["stopped_card_id"] == a["id"]
    assert rows["f-quit"]["cards_touched"] == [b["id"], a["id"]] and rows["f-quit"]["stopped_card_id"] == b["id"]
    assert all(rows[k]["stopped_at"] is None and rows[k]["rating"] is None for k in ("f-away", "f-quit"))
    assert {rows[k]["reason"] for k in ("f-away", "f-quit")} == {"away", "quit"}
    assert op["pick_up"]["card"]["id"] == b["id"], "the quit session is the latest"
    # idempotent
    opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert len(desk.list_sessions()) == 3


def test_missing_sessions_from_legacy_exploration_events(tmp_path, events_dir):
    """A Deep session logged before the Desk (item kind 'exploration') lands on the migrated card."""
    exp = ExplorationStore(tmp_path).create({"seed": "Old one", "page": "text\n"}, now=ago(days=2))
    write_events(events_dir, deep_session(tmp_path, "f-old", [exp["id"]], ago(hours=3), ago(hours=2), "away",
                                          kind="exploration"))
    opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    [row] = DeskStore(tmp_path).list_sessions()
    assert row["cards_touched"] == ["pg-" + exp["id"][4:]] and row["stopped_card_id"] == "pg-" + exp["id"][4:]


def test_captured_away_windows_on_the_last_deep_session(tmp_path, events_dir):
    desk = DeskStore(tmp_path)
    card = page(desk, "Sync", "s\n", now=ago(days=1))
    someday = SomedayStore(tmp_path)
    someday.create("from the phone, before", source={"surface": "aeronaut"}, now=ago(hours=6))
    after = someday.create("from the watch, after", source={"surface": "dirigible"}, now=ago(hours=2))
    someday.create("typed in Lee", source={"surface": "lee"}, now=ago(hours=1))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    [cap] = [s for s in op["surfaces"] if s["kind"] == "captured_away"]
    assert cap["count"] == 2, "no Deep session yet: the last 7 days, away surfaces only"
    assert cap["items"][0]["someday_id"] == after.id, "newest first"

    session(desk, [card["id"]], ago(hours=5), ago(hours=4))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    [cap] = [s for s in op["surfaces"] if s["kind"] == "captured_away"]
    assert cap["count"] == 1 and cap["items"][0]["someday_id"] == after.id
    assert cap["items"][0]["surface"] == "dirigible"

    old = SomedayStore(tmp_path / "old")
    old.create("ten days ago", source={"surface": "aeronaut"}, now=ago(days=10))
    assert "captured_away" not in kinds(opener.build_opener(tmp_path / "old", now=NOW, events_dir=events_dir))


def test_reading_list_questions_quiet_and_fixed_order(tmp_path, events_dir):
    desk = DeskStore(tmp_path)
    picked = page(desk, "Picked, old", "writing\n", now=ago(days=20))
    quiet = page(desk, "Quiet one", now=ago(days=10))
    fresh = page(desk, "Fresh one", now=ago(days=1))
    shelf = desk.create_area({"name": "Shelved"})
    put_away = page(desk, "Put away", now=ago(days=30), area_id=shelf["id"])
    desk.put_away(shelf["id"], {})
    unread = deep.add_reference(desk.pages, fresh["id"], {"kind": "link", "url": "https://crdt.tech", "title": "CRDTs"})
    opened = deep.add_reference(desk.pages, fresh["id"], {"kind": "link", "url": "https://example.com"})
    deep.patch_reference(desk.pages, fresh["id"], opened["id"], {"opened": True})
    deep.add_reference(desk.pages, fresh["id"], {"kind": "quote", "quote": "not a link"})
    deep.add_reference(desk.pages, put_away["id"], {"kind": "link", "url": "https://archived.example"})
    q1 = deep.add_question(desk.pages, quiet["id"], {"text": "First?", "source": "page"}, now=ago(days=2))
    q2 = deep.add_question(desk.pages, fresh["id"], {"text": "Second?", "source": "ask"}, now=ago(hours=1))
    closed = deep.add_question(desk.pages, fresh["id"], {"text": "Closed?", "source": "page"})
    deep.patch_question(desk.pages, fresh["id"], closed["id"], {"status": "closed"})
    session(desk, [picked["id"]], ago(hours=3), ago(hours=2), reason="esc")
    SomedayStore(tmp_path).create("phone note", source={"surface": "aeronaut"}, now=ago(hours=1))

    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    order = kinds(op)
    assert order == [k for k in opener.SURFACE_ORDER if k in order] and order[0] == "blank"
    assert {"open_questions", "captured_away", "reading_list", "quiet"} <= set(order)
    s = {x["kind"]: x for x in op["surfaces"]}
    assert [i["question_id"] for i in s["open_questions"]["items"]] == [q2["id"], q1["id"]], "newest first"
    first = s["open_questions"]["items"][0]
    assert first["card_id"] == first["exploration_id"] == fresh["id"]
    assert first["card_title"] == first["exploration_title"] == "Fresh one"
    assert s["reading_list"]["count"] == 1, "a put-away Area's cards aren't read"
    assert s["reading_list"]["items"] == [{
        "card_id": fresh["id"], "exploration_id": fresh["id"], "reference_id": unread["id"],
        "title": "CRDTs", "url": "https://crdt.tech",
    }]
    assert op["pick_up"]["card"]["id"] == picked["id"]
    assert [i["card_id"] for i in s["quiet"]["items"]] == [quiet["id"]], "quiet excludes pick_up and fresh ones"
    assert s["quiet"]["items"][0]["exploration_id"] == quiet["id"]
    for surface in op["surfaces"]:
        assert "page-quiet" not in [c.get("kind") for c in surface.get("items") or []]


def test_opener_route_logs_opener_shown(cockpit_env, isolated_copilot):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    area = c.get("/desk", headers=h).json()["data"]["areas"][0]["id"]
    c.post("/desk/pages", headers=h, json={"area_id": area, "text": "hello\n"})
    r = c.get("/copilot/opener", params={"workspace": str(env.a)}, headers=h)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["pick_up"]["stopped_at"] == "hello"
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "opener.shown"]
    assert {k: ev["data"][k] for k in ("workspace", "pick_up", "surfaces")} == {"workspace": data["workspace"], "pick_up": True, "surfaces": [s["kind"] for s in data["surfaces"]]}
