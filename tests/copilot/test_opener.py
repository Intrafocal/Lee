"""Deep D1 (contract section 8.1): the opener at the top of Copilot, built deterministically."""

from datetime import datetime, timedelta, timezone

from hester.daemon.cockpit import deep
from hester.daemon.cockpit.explorations import ExplorationStore
from hester.daemon.copilot import opener
from hester.daemon.copilot.someday import SomedayStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import make_event, queued, write_events

NOW = datetime(2026, 9, 26, 9, 0, tzinfo=timezone.utc)


def ago(**kw):
    return NOW - timedelta(**kw)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def deep_session(ws, sid, exp_id, start, end, reason, rating=None):
    item = {"kind": "exploration", "workspace": str(ws), "exploration_id": exp_id, "title": "t"}
    return [
        make_event("focus.start", start, {"session_id": sid, "source": "deep", "policy": "none", "item": item}),
        make_event("focus.end", end, {"session_id": sid, "source": "deep", "reason": reason, "deep_rating": rating}),
    ]


def kinds(op):
    return [s["kind"] for s in op["surfaces"]]


def test_empty_workspace_is_just_blank(tmp_path, events_dir):
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"] is None and op["surfaces"] == [{"kind": "blank"}]
    assert op["workspace"] == str(tmp_path) and op["generated_at"]


def test_pick_up_falls_back_to_the_latest_page(tmp_path, events_dir):
    store = ExplorationStore(tmp_path)
    store.create({"seed": "No page yet"}, now=ago(hours=1))
    written = store.create({"seed": "Mesh sync", "page": "First thought\n\nthe vector clock only helps if every write\n\n"}, now=ago(days=2))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"]["exploration"]["id"] == written["id"]
    assert op["pick_up"]["stopped_at"] == "the vector clock only helps if every write"
    assert op["pick_up"]["arrived"] == {"answers": 0, "open_questions": 0}


def test_pick_up_prefers_the_latest_session_and_counts_arrivals(tmp_path, events_dir):
    store = ExplorationStore(tmp_path)
    paged = store.create({"seed": "Paged", "page": "lots of writing\n"}, now=ago(hours=1))
    sessioned = store.create({"seed": "Sessioned"}, now=ago(days=3))
    deep.add_session(store, sessioned["id"], {
        "focus_session_id": "f1", "started_at": iso(ago(days=1, hours=2)), "ended_at": iso(ago(days=1)),
        "reason": "ritual", "stopped_at": "where I stopped", "rating": "deep", "questions_kept": [],
    })
    before = deep.new_answer(store, sessioned["id"], {"question": "old", "anchor": {"kind": "none"}})
    deep.update_answer(store, sessioned["id"], before["id"], {"status": "done", "answer": "a", "answered_at": iso(ago(days=2))})
    after = deep.new_answer(store, sessioned["id"], {"question": "new", "anchor": {"kind": "none"}})
    deep.update_answer(store, sessioned["id"], after["id"], {"status": "done", "answer": "b", "answered_at": iso(ago(hours=5))})
    deep.add_question(store, sessioned["id"], {"text": "Does it partition?", "source": "page"})
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert op["pick_up"]["exploration"]["id"] == sessioned["id"] != paged["id"]
    assert op["pick_up"]["stopped_at"] == "where I stopped"
    assert op["pick_up"]["arrived"] == {"answers": 1, "open_questions": 1}


def test_missing_session_records_written_for_away_and_quit(tmp_path, events_dir):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "Away one"}, now=ago(days=1))
    other = store.create({"seed": "Ritual one"}, now=ago(days=1))
    deep.add_session(store, other["id"], {
        "focus_session_id": "f-ritual", "started_at": iso(ago(hours=9)), "ended_at": iso(ago(hours=8)),
        "reason": "ritual", "stopped_at": None, "rating": None, "questions_kept": [],
    })
    write_events(events_dir, [
        *deep_session(tmp_path, "f-away", exp["id"], ago(hours=4), ago(hours=3), "away"),
        *deep_session(tmp_path, "f-quit", exp["id"], ago(hours=2), ago(hours=1), "quit"),
        *deep_session(tmp_path, "f-ritual", other["id"], ago(hours=9), ago(hours=8), "deep_end", "deep"),
        *deep_session("/elsewhere", "f-other-ws", exp["id"], ago(hours=6), ago(hours=5), "away"),
    ])
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    rows = deep.list_sessions(store, exp["id"])
    assert sorted(r["focus_session_id"] for r in rows) == ["f-away", "f-quit"]
    assert all(r["stopped_at"] is None and r["rating"] is None for r in rows)
    assert {r["reason"] for r in rows} == {"away", "quit"}
    assert len(deep.list_sessions(store, other["id"])) == 1, "a ritual session is never written twice"
    assert op["pick_up"]["exploration"]["id"] == exp["id"], "the quit session is the latest"
    # idempotent
    opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    assert len(deep.list_sessions(store, exp["id"])) == 2


def test_captured_away_windows_on_the_last_deep_session(tmp_path, events_dir):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "Sync"}, now=ago(days=1))
    someday = SomedayStore(tmp_path)
    someday.create("from the phone, before", source={"surface": "aeronaut"}, now=ago(hours=6))
    after = someday.create("from the watch, after", source={"surface": "dirigible"}, now=ago(hours=2))
    someday.create("typed in Lee", source={"surface": "lee"}, now=ago(hours=1))
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    [cap] = [s for s in op["surfaces"] if s["kind"] == "captured_away"]
    assert cap["count"] == 2, "no Deep session yet: the last 7 days, away surfaces only"

    deep.add_session(store, exp["id"], {
        "focus_session_id": "f", "started_at": iso(ago(hours=5)), "ended_at": iso(ago(hours=4)),
        "reason": "ritual", "stopped_at": None, "rating": None, "questions_kept": [],
    })
    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    [cap] = [s for s in op["surfaces"] if s["kind"] == "captured_away"]
    assert cap["count"] == 1 and cap["items"][0]["someday_id"] == after.id
    assert cap["items"][0]["surface"] == "dirigible"

    old = SomedayStore(tmp_path / "old")
    old.create("ten days ago", source={"surface": "aeronaut"}, now=ago(days=10))
    assert "captured_away" not in kinds(opener.build_opener(tmp_path / "old", now=NOW, events_dir=events_dir))


def test_reading_list_questions_quiet_and_fixed_order(tmp_path, events_dir):
    store = ExplorationStore(tmp_path)
    picked = store.create({"seed": "Picked, old", "page": "writing\n"}, now=ago(days=20))
    quiet = store.create({"seed": "Quiet one"}, now=ago(days=10))
    fresh = store.create({"seed": "Fresh one"}, now=ago(days=1))
    archived = store.create({"seed": "Archived"}, now=ago(days=30))
    store.patch(archived["id"], {"status": "archived"}, now=ago(days=30))
    unread = deep.add_reference(store, fresh["id"], {"kind": "link", "url": "https://crdt.tech", "title": "CRDTs"})
    opened = deep.add_reference(store, fresh["id"], {"kind": "link", "url": "https://example.com"})
    deep.patch_reference(store, fresh["id"], opened["id"], {"opened": True})
    deep.add_reference(store, fresh["id"], {"kind": "quote", "quote": "not a link"})
    deep.add_reference(store, archived["id"], {"kind": "link", "url": "https://archived.example"})
    q1 = deep.add_question(store, quiet["id"], {"text": "First?", "source": "page"}, now=ago(days=2))
    q2 = deep.add_question(store, fresh["id"], {"text": "Second?", "source": "ask"}, now=ago(hours=1))
    closed = deep.add_question(store, fresh["id"], {"text": "Closed?", "source": "page"})
    deep.patch_question(store, fresh["id"], closed["id"], {"status": "closed"})
    deep.add_session(store, picked["id"], {
        "focus_session_id": "f", "started_at": iso(ago(hours=3)), "ended_at": iso(ago(hours=2)),
        "reason": "esc", "stopped_at": None, "rating": None, "questions_kept": [],
    })
    SomedayStore(tmp_path).create("phone note", source={"surface": "aeronaut"}, now=ago(hours=1))

    op = opener.build_opener(tmp_path, now=NOW, events_dir=events_dir)
    order = kinds(op)
    assert order == [k for k in opener.SURFACE_ORDER if k in order] and order[0] == "blank"
    assert {"open_questions", "captured_away", "reading_list", "quiet"} <= set(order)
    s = {x["kind"]: x for x in op["surfaces"]}
    assert [i["question_id"] for i in s["open_questions"]["items"]] == [q2["id"], q1["id"]], "newest first"
    assert s["open_questions"]["items"][0]["exploration_title"] == fresh["title"]
    assert s["reading_list"]["count"] == 1
    assert s["reading_list"]["items"] == [
        {"exploration_id": fresh["id"], "reference_id": unread["id"], "title": "CRDTs", "url": "https://crdt.tech"}
    ]
    assert op["pick_up"]["exploration"]["id"] == picked["id"]
    assert [i["exploration_id"] for i in s["quiet"]["items"]] == [quiet["id"]], "quiet excludes pick_up and fresh ones"
    for surface in op["surfaces"]:
        assert "exploration-quiet" not in [c.get("kind") for c in surface.get("items") or []]


def test_opener_route_logs_opener_shown(cockpit_env, isolated_copilot):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    c.post("/cockpit/explorations", headers=h, json={"seed": "Mesh", "page": "hello\n", "origin": {"kind": "opener"}})
    r = c.get("/copilot/opener", params={"workspace": str(env.a)}, headers=h)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["pick_up"]["stopped_at"] == "hello"
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "opener.shown"]
    assert {k: ev["data"][k] for k in ("workspace", "pick_up", "surfaces")} == {"workspace": data["workspace"], "pick_up": True, "surfaces": [s["kind"] for s in data["surfaces"]]}
