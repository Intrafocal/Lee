"""Desk D2 §5, §6.2, §6.4: sessions, GET /desk/last, hand-offs on cards, Ideas to Page and the G0 metrics."""

from datetime import datetime, timedelta, timezone

from hester.daemon.cockpit import deep, handoffs
from hester.daemon.cockpit.desk import DeskStore, stopped_line, tail_clip
from hester.daemon.cockpit.explorations import ExplorationStore
from hester.daemon.copilot import metrics, open_next
from hester.daemon.copilot.someday import SomedayStore
from hester.daemon.workspaces.registry import WorkspaceRegistry

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import make_event, queued, write_events
from .desk_helpers import iso, page, session

NOW = datetime(2026, 9, 26, 9, 0, tzinfo=timezone.utc)


def ago(**kw):
    return NOW - timedelta(**kw)


def body(**kw):
    b = {"focus_session_id": "f1", "started_at": iso(ago(hours=2)), "ended_at": iso(ago(hours=1)),
         "reason": "ritual", "stopped_at": "here", "rating": "deep", "questions_kept": [], "cards_touched": []}
    b.update(kw)
    return b


# ---------------------------------------------------------------- sessions


def test_session_post_validation_and_list(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    desk = DeskStore(cockpit_env.a)
    a, b = page(desk, "A", "a\n"), page(desk, "B", "b\n")
    for bad in (
        {"reason": "bored"}, {"started_at": "yesterday"}, {"focus_session_id": ""}, {"rating": "great"},
        {"cards_touched": ["exp-1a2b3c4d"]}, {"cards_touched": "pg-1a2b3c4d"}, {"stopped_card_id": "nope"},
        {"questions_kept": ["q-1a2b3c4d"]}, {"questions_kept": [{"card_id": a["id"], "question_id": "x"}]},
    ):
        r = c.post("/desk/sessions", headers=h, json=body(**bad))
        assert r.status_code == 400, bad

    r = c.post("/desk/sessions", headers=h, json=body(
        reason="device", cards_touched=[b["id"], "pg-00000000", a["id"], b["id"]], stopped_card_id="pg-00000000",
        questions_kept=[{"card_id": a["id"], "question_id": "q-1a2b3c4d"}, {"card_id": "pg-00000000", "question_id": "q-1a2b3c4d"}],
    ))
    assert r.status_code == 201, r.text
    rec = r.json()["data"]
    assert rec["id"].startswith("ses-") and rec["reason"] == "device"
    assert rec["cards_touched"] == [b["id"], a["id"]], "unknown ids dropped, not refused; first-touched order"
    assert rec["stopped_card_id"] is None
    assert rec["questions_kept"] == [{"card_id": a["id"], "question_id": "q-1a2b3c4d"}]

    for i in range(3):
        c.post("/desk/sessions", headers=h, json=body(focus_session_id=f"g{i}", ended_at=iso(ago(minutes=30 - i)),
                                                      cards_touched=[a["id"]], stopped_card_id=a["id"]))
    rows = c.get("/desk/sessions", headers=h).json()["data"]
    assert [r["focus_session_id"] for r in rows] == ["g2", "g1", "g0", "f1"], "newest first"
    assert len(c.get("/desk/sessions?limit=2", headers=h).json()["data"]) == 2
    assert c.get("/desk/sessions?limit=x", headers=h).status_code == 400


# ---------------------------------------------------------------- GET /desk/last


def test_last_picks_in_order(tmp_path):
    desk = DeskStore(tmp_path)
    assert desk.last(NOW) == {
        "card": None, "source": None, "stopped_at": None, "stopped_line": None,
        "arrived": {"answers": 0, "handoffs": 0, "open_questions": 0, "captured": 0}, "last_session": None,
    }
    old = page(desk, "Old", "old words\n", now=ago(days=3))
    blank = page(desk, "Blank", now=ago(hours=1))
    newer = page(desk, "Newer", "newer words\n", now=ago(days=1))
    # 4: the most recently written page (a blank one doesn't count)
    last = desk.last(NOW)
    assert last["source"] == "recent" and last["card"]["id"] in (old["id"], newer["id"]) and last["card"]["id"] != blank["id"]
    assert set(last["card"]) == {"id", "kind", "title", "area_id", "area_name", "purpose", "last_touched_at"}
    assert last["card"]["area_name"] == "Main"
    # 3: the latest session's stopped card
    session(desk, [newer["id"], old["id"]], ago(hours=5), ago(hours=4), stopped_at="old words")
    last = desk.last(NOW)
    assert (last["source"], last["card"]["id"], last["stopped_at"]) == ("session", old["id"], "old words")
    assert last["last_session"]["focus_session_id"] == "f1"
    # 2: desk.json last
    desk.set_last(blank["id"], NOW)
    last = desk.last(NOW)
    assert (last["source"], last["card"]["id"]) == ("last", blank["id"])
    assert last["stopped_at"] is None and last["stopped_line"] is None, "an empty Page has no line"
    # 1: a live Open next
    open_next.set_(tmp_path, card_id=newer["id"], now=NOW)
    last = desk.last(NOW, open_next.get(tmp_path, NOW))
    assert (last["source"], last["card"]["id"], last["stopped_at"]) == ("open_next", newer["id"], "newer words")


def test_stopped_line_found_not_found_and_absent():
    text = "# Title\n\nthe vector   clock only helps\n\nlast line here\n\n"
    assert stopped_line(text, "the vector clock only helps") == 3
    assert stopped_line(text, "…vector clock only helps") == 3, "the leading … is dropped"
    assert stopped_line(text, "not on the page") == 5, "not found: the last non-empty line"
    assert stopped_line(text, None) == 5
    assert stopped_line("  \n\n", "anything") is None and stopped_line("", None) is None
    repeated = "same\nother\nsame\n"
    assert stopped_line(repeated, "same") == 3, "the last occurrence"
    assert tail_clip("x" * 200).startswith("…") and len(tail_clip("x" * 200)) == 160


def test_last_counts_what_arrived(tmp_path):
    desk = DeskStore(tmp_path)
    card = page(desk, "Card", "one\ntwo\n", now=ago(days=2))
    other = page(desk, "Other", now=ago(days=2))  # blank: "recent" picks the written card
    old = deep.new_answer(desk.pages, card["id"], {"question": "old", "anchor": {"kind": "none"}})
    deep.update_answer(desk.pages, card["id"], old["id"], {"status": "done", "answer": "a", "answered_at": iso(ago(days=1))})
    new = deep.new_answer(desk.pages, card["id"], {"question": "new", "anchor": {"kind": "none"}})
    deep.update_answer(desk.pages, card["id"], new["id"], {"status": "done", "answer": "b", "answered_at": iso(ago(minutes=30))})
    ho = deep.new_handoff(desk.pages, card["id"], {"kind": "research", "brief": "R", "anchor": {"kind": "none"}})
    deep.update_answer(desk.pages, card["id"], ho["id"], {"status": "done", "answered_at": iso(ago(minutes=20)),
                                                          "handoff": dict(ho["handoff"], state="done")})
    deep.add_question(desk.pages, card["id"], {"text": "Open?", "source": "page"})
    someday = SomedayStore(tmp_path)
    someday.create("before", source={"surface": "aeronaut", "card_id": card["id"]}, now=ago(hours=3))
    someday.create("after", source={"surface": "aeronaut", "card_id": card["id"]}, now=ago(minutes=10))
    someday.create("elsewhere", source={"surface": "aeronaut", "card_id": other["id"]}, now=ago(minutes=10))

    # no session yet: unread answers, all captures on it
    last = desk.last(NOW)
    assert last["arrived"] == {"answers": 2, "handoffs": 1, "open_questions": 1, "captured": 2}
    session(desk, [card["id"]], ago(hours=2), ago(hours=1), stopped_at="two")
    last = desk.last(NOW)
    assert last["card"]["id"] == card["id"] and last["stopped_line"] == 2
    assert last["arrived"] == {"answers": 1, "handoffs": 1, "open_questions": 1, "captured": 1}


def test_last_route(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    r = c.get("/desk/last", headers=h)
    assert r.status_code == 200 and r.json()["data"]["card"] is None
    card = page(DeskStore(cockpit_env.a), "Card", "the end of it\n")
    c.put("/desk/last", headers=h, json={"card_id": card["id"]})
    data = c.get("/desk/last", headers=h).json()["data"]
    assert data["source"] == "last" and data["stopped_at"] == "the end of it" and data["stopped_line"] == 1


# ---------------------------------------------------------------- hand-offs


def handoff_task(tid, ref, kind="page", status="review"):
    return {"id": tid, "status": status, "turns": 1, "summary": "It's done: the docs are in.",
            "origin": {"kind": kind, "ref": ref}}


def test_handoff_sync_for_page_refs(tmp_path, isolated_copilot):
    desk = DeskStore(tmp_path)
    card = page(desk, "Card", "text\n")
    rec = deep.new_handoff(desk.pages, card["id"], {"kind": "docs", "brief": "Docs: x", "anchor": {"kind": "none"}})
    ctx = WorkspaceRegistry(boot=tmp_path).get(tmp_path)
    row = handoffs.sync(ctx, handoff_task("task-0000abcd", f"{card['id']}#{rec['id']}"))
    assert row["handoff"]["state"] == "review" and row["handoff"]["task_id"] == "task-0000abcd"
    assert row["answer"] == "It's done: the docs are in."
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "deep.answer"]
    assert ev["data"]["card_id"] == ev["data"]["exploration_id"] == card["id"] and ev["data"]["kind"] == "handoff"
    assert handoffs.sync(ctx, handoff_task("task-0000abcd", "pg-00000000#" + rec["id"])) is None
    assert handoffs.sync(ctx, handoff_task("task-0000abcd", f"{card['id']}#{rec['id']}", kind="explore")) is None
    assert handoffs.parse_ref(f"{card['id']}#{rec['id']}", "page") == (card["id"], rec["id"])
    assert handoffs.parse_ref(f"{card['id']}#{rec['id']}") == (None, None), "an exploration ref is exp-…"


def test_handoff_sync_follows_the_migration(tmp_path):
    xs = ExplorationStore(tmp_path)
    exp = xs.create({"seed": "Mesh", "page": "text\n"})
    rec = deep.new_handoff(xs, exp["id"], {"kind": "docs", "brief": "Docs: x", "anchor": {"kind": "none"}})
    ctx = WorkspaceRegistry(boot=tmp_path).get(tmp_path)
    task = handoff_task("task-0000abcd", f"{exp['id']}#{rec['id']}", kind="exploration", status="running")
    # not migrated yet: the exploration's record
    assert handoffs.sync(ctx, task)["handoff"]["state"] == "running"
    assert deep.get_answer(xs, exp["id"], rec["id"])["handoff"]["state"] == "running"
    DeskStore(tmp_path).migrate()
    task["status"] = "done"
    row = handoffs.sync(ctx, task)
    card_id = "pg-" + exp["id"][4:]
    assert row["status"] == "done" and deep.get_answer(ctx.desk().pages, card_id, rec["id"])["status"] == "done"
    assert deep.get_answer(xs, exp["id"], rec["id"])["handoff"]["state"] == "running", "the old record isn't touched"


def test_page_origin_tasks_and_the_brief(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    card = page(DeskStore(cockpit_env.a), "Mesh sync", "text\n")
    base = f"/desk/pages/{card['id']}"
    rec = c.post(f"{base}/handoffs", headers=h, json={"kind": "docs", "brief": "Docs: x", "anchor": {"kind": "none"}}).json()["data"]
    r = c.post("/cockpit/tasks", headers=h, json={
        "id": "task-0000beef", "title": "Docs", "lead": "delegate", "kind": "chore", "status": "running",
        "origin": {"kind": "page", "ref": f"{card['id']}#{rec['id']}"}, "timebox_min": 30,
    })
    assert r.status_code == 201, r.text
    got = c.get(f"{base}/answers", headers=h).json()["data"][0]
    assert got["handoff"]["task_id"] == "task-0000beef" and got["handoff"]["state"] == "running"
    assert c.post("/cockpit/tasks/task-0000beef/close", headers=h, json={"status": "done"}).status_code == 200
    assert c.get(f"{base}/answers", headers=h).json()["data"][0]["status"] == "done"
    brief = deep.handoff_brief("docs", "## S\n\ntext", "Mesh sync", card["id"])
    assert brief.endswith(f"From the Page 'Mesh sync' ({card['id']})")
    assert deep.handoff_brief("docs", "", "Old", "exp-1a2b3c4d").endswith("From the exploration 'Old' (exp-1a2b3c4d)")


# ---------------------------------------------------------------- Ideas to Page


def test_idea_to_page_new_area_or_given(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    someday = SomedayStore(cockpit_env.a)
    long = someday.create("Try a CRDT for the attention queue so devices can merge offline edits without a server\nmore",
                          source={"surface": "aeronaut"})
    r = c.post(f"/desk/ideas/{long.id}/page", headers=h, json={})
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["someday_id"] == long.id and data["card"]["area_id"] == data["area"]["id"]
    assert len(data["area"]["name"]) <= 60 and data["area"]["name"].endswith("…") and " " in data["area"]["name"]
    assert data["card"]["title"] == data["area"]["name"]
    assert c.get(f"/desk/pages/{data['card']['id']}/page", headers=h).json()["data"]["text"] == long.text
    assert someday.get(long.id).status == "explored"
    assert someday.get(long.id).triage["note"] == f"page:{data['card']['id']}"
    card_json = DeskStore(cockpit_env.a).pages.read_card(data["card"]["id"])
    assert card_json["origin"] == {"kind": "someday", "ref": long.id}

    again = c.post(f"/desk/ideas/{long.id}/page", headers=h, json={})
    assert again.status_code == 409 and again.json()["error"] == "not_open"
    assert c.post("/desk/ideas/sd_20260101T000000_abcd/page", headers=h, json={}).status_code == 404
    assert c.post("/desk/ideas/nope/page", headers=h, json={}).status_code == 400

    short = someday.create("Short idea", source={"surface": "lee"})
    main = next(a for a in c.get("/desk", headers=h).json()["data"]["areas"] if a["name"] == "Main")
    r = c.post(f"/desk/ideas/{short.id}/page", headers=h, json={"area_id": main["id"], "x": 500, "y": 500})
    assert r.status_code == 201
    data = r.json()["data"]
    assert data["area"]["id"] == main["id"] and (data["card"]["x"], data["card"]["y"]) == (500, 500)
    assert data["card"]["title"] == "Short idea"


# ---------------------------------------------------------------- G0 metrics with card items


def test_g0_metrics_read_card_focus_items(events_dir):
    t0 = datetime(2026, 9, 21, 10, 0, tzinfo=timezone.utc)

    def at(m):
        return t0 + timedelta(minutes=m)

    card = {"kind": "card", "workspace": "/w", "card_id": "pg-0a0b0c0d", "card_kind": "page", "title": "t"}
    events = [
        make_event("input.counts", at(0), {"tab_id": 1, "tab_type": "editor", "keys": 1, "clicks": 0, "wheels": 0, "span_ms": 1000}),
        make_event("focus.start", at(5), {"session_id": "f1", "source": "deep", "policy": "none", "item": dict(card, card_id=None, card_kind=None)}),
        make_event("desk.zoom", at(6), {"card_id": "pg-0a0b0c0d", "card_kind": "page", "via": "land"}),
        make_event("focus.item", at(6), {"session_id": "f1", "item": card}),
        make_event("deep.input", at(8), {"card_id": "pg-0a0b0c0d", "card_kind": "page", "view": "page", "keys": 10,
                                          "clicks": 0, "wheels": 0, "span_ms": 30 * 60000}, focus_session_id="f1"),
        make_event("focus.end", at(40), {"session_id": "f1", "reason": "deep_end", "deep_rating": "deep", "interruptions": 0,
                                         "duration_ms": 1000, "ended_via": "device"}),
    ]
    write_events(events_dir, events)
    end = t0 + timedelta(days=1)
    m = metrics.run(t0, end, events_dir=events_dir, now=end + timedelta(minutes=1))["metrics"]
    assert m["deep_time"]["minutes"] == 30.0 and m["deep_time"]["sessions"] == 1
    assert m["time_to_deep"] == {"value_s": 480.0, "n": 1}
    assert m["session_depth"]["deep"] == 1 and m["session_depth"]["share_deep"] == 1.0


def test_one_record_per_deep_session(tmp_path):
    desk = DeskStore(tmp_path)
    first = desk.add_session(body(reason="away", stopped_at=None, rating=None))
    again = desk.add_session(body(reason="away", stopped_at=None, rating=None))
    assert again["id"] == first["id"], "Lee main and the opener can both write an away session"
    assert len(desk.list_sessions()) == 1
