"""Boards (docs/16-Desk.md §3.1; plan docs/plans/2026-09-28-boards.md §2, §3): the store, its routes, anchors, image Asks."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hester.daemon.cockpit import board as board_mod
from hester.daemon.cockpit import deep, deep_ask, handoffs, steward
from hester.daemon.cockpit.board import BOARD_ITEM_KINDS, MAX_BOARD_ITEMS, board_version
from hester.daemon.cockpit.desk import BOARD_ID_RE, DeskStore
from hester.daemon.copilot import model_log

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
JPG = b"\xff\xd8\xff\xe0" + b"\0" * 32


def item(kind, n, **fields):
    base = {"id": f"it-{n:08x}", "kind": kind, "x": 10 * n, "y": 20, "w": 100, "h": 80, "z": n}
    base.update(fields)
    return base


def sample_items(asset="img-0000000a.png"):
    return [
        item("image", 1, asset=asset),
        item("highlight", 2, item_id="it-00000001"),
        item("note", 3, text="The **header** is too tall; see [[pg-0000abcd|Layout]]", pin={"item_id": "it-00000002", "u": 0.5, "v": 0.25}),
        item("stroke", 4, points=[[0, 0], [5, 5], [9, 2]], width=2),
        item("link", 5, card_id="pg-0000abcd"),
    ]


def new_board(c, h, **body):
    r = c.post("/desk/boards", headers=h, json=body)
    assert r.status_code == 201, r.text
    return r.json()["data"]


def upload(c, h, bid, data=PNG, ctype="image/png", **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return c.post(f"/desk/boards/{bid}/assets" + (f"?{q}" if q else ""), headers={**h, "Content-Type": ctype}, content=data)


def selection(c, h, bid):
    r = upload(c, h, bid, kind="selection")
    assert r.status_code == 201, r.text
    return r.json()["data"]["path"]


def board_anchor(snapshot, notes=("The header is too tall",)):
    return {"kind": "board", "item_ids": ["it-00000001", "it-00000003"], "rect": {"x": 0, "y": 0, "w": 300, "h": 200},
            "snapshot": snapshot, "notes": list(notes)}


# ---------------------------------------------------------------- the store and GET /desk


def test_a_board_is_a_card_on_the_desk(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    made = new_board(c, h, title="Layouts")
    card, doc = made["card"], made["board"]
    assert BOARD_ID_RE.match(card["id"]) and card["kind"] == "board" and card["title"] == "Layouts"
    assert doc == {"version": board_version([]), "items": []}
    folder = cockpit_env.a / ".hester" / "desk" / "boards" / card["id"]
    meta = json.loads((folder / "card.json").read_text())
    assert set(meta) == {"id", "kind", "title", "origin", "created_at", "updated_at", "last_touched_at"} and meta["kind"] == "board"
    assert json.loads((folder / "board.json").read_text())["items"] == []

    desk = c.get("/desk", headers=h).json()["data"]
    [entry] = [x for x in desk["cards"] if x["id"] == card["id"]]
    assert entry["kind"] == "board" and entry["area_id"] == desk["areas"][0]["id"], "no area_id: the first Area"
    s = entry["summary"]
    assert s["page_chars"] == 0 and s["open_questions"] == 0 and s["board"]["items"] == 0 and s["board"]["preview_at"] is None

    # move, rename, and GET by id
    area = c.post("/desk/areas", headers=h, json={"name": "Other"}).json()["data"]
    r = c.patch(f"/desk/cards/{card['id']}", headers=h, json={"area_id": area["id"], "x": 5, "y": 6})
    assert r.status_code == 200 and r.json()["data"]["area_id"] == area["id"]
    assert c.patch(f"/desk/boards/{card['id']}", headers=h, json={"title": "Renders"}).json()["data"]["title"] == "Renders"
    assert c.get(f"/desk/boards/{card['id']}", headers=h).json()["data"]["title"] == "Renders"
    assert c.get("/desk/boards/bd-00000000", headers=h).status_code == 404
    assert c.get("/desk/boards/pg-00000000", headers=h).status_code == 400
    assert c.post("/desk/boards", headers=h, json={"area_id": "area-00000000"}).status_code == 404

    # last and sessions take Board ids
    assert c.put("/desk/last", headers=h, json={"card_id": card["id"]}).status_code == 200
    last = c.get("/desk/last", headers=h).json()["data"]
    assert last["card"]["id"] == card["id"] and last["card"]["kind"] == "board" and last["stopped_line"] is None
    r = c.post("/desk/sessions", headers=h, json={
        "focus_session_id": "f1", "started_at": "2026-09-28T10:00:00Z", "ended_at": "2026-09-28T11:00:00Z",
        "reason": "ritual", "cards_touched": [card["id"]], "stopped_card_id": card["id"],
    })
    assert r.status_code == 201 and r.json()["data"]["cards_touched"] == [card["id"]]
    # B5: the ritual keeps a Board's open Asks (answer ids on a Board card), as it does a Page's
    r = c.post("/desk/sessions", headers=h, json={
        "focus_session_id": "f2", "started_at": "2026-09-28T12:00:00Z", "ended_at": "2026-09-28T13:00:00Z",
        "reason": "ritual", "cards_touched": [card["id"]], "stopped_card_id": card["id"],
        "questions_kept": [{"card_id": card["id"], "question_id": "ans-0000abcd"}, {"card_id": "bd-00000000", "question_id": "ans-0000abcd"}],
    })
    assert r.status_code == 201, r.text
    assert r.json()["data"]["questions_kept"] == [{"card_id": card["id"], "question_id": "ans-0000abcd"}]
    assert c.post("/desk/sessions", headers=h, json={
        "focus_session_id": "f3", "started_at": "2026-09-28T12:00:00Z", "ended_at": "2026-09-28T13:00:00Z",
        "reason": "ritual", "questions_kept": [{"card_id": card["id"], "question_id": "it-0000abcd"}],
    }).status_code == 400


def test_board_json_is_versioned_and_checked(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    bid = new_board(c, h)["card"]["id"]
    base = f"/desk/boards/{bid}/board"
    items = sample_items()
    r = c.put(base, headers=h, json={"version": None, "items": items})
    assert r.status_code == 200, r.text
    v1 = r.json()["data"]["version"]
    assert c.get(base, headers=h).json()["data"] == {"version": v1, "items": items}

    # stale: 409 with the current items; null is only for an empty Board
    for stale in (None, board_version([])):
        r = c.put(base, headers=h, json={"version": stale, "items": []})
        assert r.status_code == 409
        body = r.json()
        assert body["error"] == "version_conflict" and body["version"] == v1 and body["items"] == items and body["data"]["items"] == items
    r = c.put(base, headers=h, json={"version": v1, "items": items[:2]})
    assert r.status_code == 200 and r.json()["data"]["version"] == board_version(items[:2])

    bad = [
        {"items": items},                                            # no version
        {"version": 3, "items": items},
        {"version": None, "items": "x"},
        {"version": None, "items": [item("shape", 1)]},             # unknown kind
        {"version": None, "items": [dict(item("note", 1, text="x"), id="note-1")]},
        {"version": None, "items": [{k: v for k, v in item("note", 1, text="x").items() if k != "z"}]},
        {"version": None, "items": [item("note", 1, text="x", x="1")]},
        {"version": None, "items": [item("note", 1, text="x", w=-1)]},
        {"version": None, "items": [item("note", 1, text="x"), item("note", 1, text="y")]},  # the same id twice
        {"version": None, "items": [item("note", 1, text=3)]},
        {"version": None, "items": [item("note", 1, text="x", pin={"item_id": "it-00000002", "u": 2, "v": 0})]},
        {"version": None, "items": [item("image", 1, asset="../../etc/passwd")]},
        {"version": None, "items": [item("stroke", 1, points=[], width=2)]},
        {"version": None, "items": [item("stroke", 1, points=[[0, 0]], width=0)]},
        {"version": None, "items": [item("ask", 1, answer_id="ans-1", target={"item_ids": [], "rect": {"x": 0, "y": 0, "w": 1, "h": 1}})]},
        {"version": None, "items": [item("handoff", 1, answer_id="ans-0000000a", target={"item_ids": ["x"], "rect": {"x": 0, "y": 0, "w": 1, "h": 1}})]},
        {"version": None, "items": [item("link", 1, card_id="exp-0000abcd")]},
        {"version": None, "items": [item("note", i, text="x") for i in range(MAX_BOARD_ITEMS + 1)]},
        {"version": None, "items": [item("note", 1, text="x" * 1_000_001)]},  # over 1 MB
    ]
    for body in bad:
        r = c.put(base, headers=h, json=dict(body, version=board_version(items[:2])) if "version" in body and body["version"] is None else body)
        assert r.status_code == 400, (json.dumps(body)[:300], r.text)
    assert set(BOARD_ITEM_KINDS) == {"image", "note", "highlight", "stroke", "ask", "handoff", "link", "visual"}
    ask = item("ask", 9, answer_id="ans-0000000a", target={"item_ids": ["it-00000001"], "rect": {"x": 0, "y": 0, "w": 10, "h": 10}}, open=True)
    r = c.put(base, headers=h, json={"version": board_version(items[:2]), "items": items[:2] + [ask]})
    assert r.status_code == 200, r.text
    s = c.get(f"/desk/boards/{bid}", headers=h).json()["data"]["summary"]["board"]
    assert (s["items"], s["images"], s["highlights"], s["asks"]) == (3, 1, 1, 1)


def test_assets_with_a_source_and_the_preview(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    bid = new_board(c, h)["card"]["id"]
    src = {"kind": "url", "url": "https://example.com/shot", "taken_at": "2026-09-28T10:00:00Z"}
    r = upload(c, h, bid, source=json.dumps(src))
    assert r.status_code == 201, r.text
    row = r.json()["data"]
    assert board_mod.BOARD_ASSET_RE.match(row["name"]) and row["name"].startswith("img-") and row["path"] == f"assets/{row['name']}"
    assert row["mime"] == "image/png" and row["bytes"] == len(PNG) and row["source"] == src
    jpg = upload(c, h, bid, JPG, "image/jpeg").json()["data"]
    assert jpg["name"].endswith(".jpg") and "source" not in jpg
    sel = upload(c, h, bid, kind="selection").json()["data"]
    assert sel["name"].startswith("sel-") and sel["name"].endswith(".png")
    assert upload(c, h, bid, JPG, "image/jpeg", kind="selection").status_code == 400, "a selection is a PNG"
    assert upload(c, h, bid, kind="thumbnail").status_code == 400

    for bad in ({"kind": "ftp", "url": "x"}, {"kind": "url", "url": "file:///etc"}, {"kind": "card", "card_id": "exp-1"},
                {"kind": "answer", "card_id": "pg-0000abcd"}, {"kind": "file"}, {"kind": "file", "path": "a", "taken_at": "soon"}):
        assert upload(c, h, bid, source=json.dumps(bad)).status_code == 400, bad
    assert upload(c, h, bid, source="{nope").status_code == 400
    assert upload(c, h, bid, b"GIF89a", "image/gif").status_code == 415
    assert upload(c, h, bid, b"not a png").status_code == 400
    big = c.post(f"/desk/boards/{bid}/assets", headers={**h, "Content-Type": "image/png"}, content=PNG + b"\0" * (10 * 1024 * 1024))
    assert big.status_code == 413
    assert upload(c, h, "bd-00000000").status_code == 404

    rows = c.get(f"/desk/boards/{bid}/assets", headers=h).json()["data"]
    assert [x["name"] for x in rows] == [row["name"], jpg["name"], sel["name"]]
    r = c.get(f"/desk/boards/{bid}/assets/{row['name']}", headers=h)
    assert r.status_code == 200 and r.content == PNG and r.headers["content-type"] == "image/png"
    assert c.get(f"/desk/boards/{bid}/assets/img-00000000.png", headers=h).status_code == 404
    assert c.get(f"/desk/boards/{bid}/assets/..%2Fcard.json", headers=h).status_code in (400, 404)

    assert c.get(f"/desk/boards/{bid}/preview", headers=h).status_code == 404
    r = c.put(f"/desk/boards/{bid}/preview", headers={**h, "Content-Type": "image/png"}, content=PNG)
    assert r.status_code == 200 and r.json()["data"] == {"bytes": len(PNG)}
    r = c.get(f"/desk/boards/{bid}/preview", headers=h)
    assert r.status_code == 200 and r.content == PNG and r.headers["cache-control"] == "no-cache"
    assert c.put(f"/desk/boards/{bid}/preview", headers={**h, "Content-Type": "image/jpeg"}, content=JPG).status_code == 400
    assert c.get(f"/desk/boards/{bid}", headers=h).json()["data"]["summary"]["board"]["preview_at"]


def test_page_assets_take_a_source_too(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    area = c.get("/desk", headers=h).json()["data"]["areas"][0]["id"]
    pid = c.post("/desk/pages", headers=h, json={"area_id": area}).json()["data"]["card"]["id"]
    plain = c.post(f"/desk/pages/{pid}/assets", headers={**h, "Content-Type": "image/png"}, content=PNG)
    assert plain.status_code == 201 and set(plain.json()["data"]) == {"name", "path"}
    src = {"kind": "card", "card_id": "bd-0000abcd", "item_id": "it-00000001"}
    r = c.post(f"/desk/pages/{pid}/assets?source={json.dumps(src)}", headers={**h, "Content-Type": "image/png"}, content=PNG)
    assert r.status_code == 201 and set(r.json()["data"]) == {"name", "path"}
    rows = deep.read_jsonl(cockpit_env.a / ".hester" / "desk" / "pages" / pid / "assets.jsonl")
    assert [x.get("source") for x in rows] == [None, src]
    bad = c.post(f"/desk/pages/{pid}/assets?source={json.dumps({'kind': 'x'})}", headers={**h, "Content-Type": "image/png"}, content=PNG)
    assert bad.status_code == 400


def test_delete_guard_areas_and_stash(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    area = c.post("/desk/areas", headers=h, json={"name": "Visual"}).json()["data"]
    empty = new_board(c, h, area_id=area["id"])["card"]["id"]
    full = new_board(c, h, area_id=area["id"], title="Kept")["card"]["id"]
    c.put(f"/desk/boards/{full}/board", headers=h, json={"version": None, "items": sample_items()})
    assert c.delete(f"/desk/boards/{full}", headers=h).json()["error"] == "not_empty"
    named = new_board(c, h, area_id=area["id"], title="Named")["card"]["id"]
    assert c.delete(f"/desk/boards/{named}", headers=h).status_code == 409, "a title keeps it"
    assert c.request("DELETE", f"/desk/boards/{named}", headers=h, json={"force": True}).json()["data"] == {"deleted": True}
    assert c.delete(f"/desk/pages/{empty}", headers=h).status_code == 400, "a Board isn't a Page"
    r = c.delete(f"/desk/boards/{empty}", headers=h)
    assert r.status_code == 200 and not (cockpit_env.a / ".hester" / "desk" / "boards" / empty).exists()

    # stash: the Board goes to the Drawer with its Area
    assert c.post(f"/desk/areas/{area['id']}/stash", headers=h, json={}).status_code == 200
    desk = DeskStore(cockpit_env.a)
    [brief] = [b for b in desk.briefs() if b["id"] == full]
    assert brief["kind"] == "board" and brief["stashed"] is True
    assert all(b["id"] != full for b in desk.briefs(on_desk=True))
    c.post(f"/desk/areas/{area['id']}/unstash", headers=h, json={})

    # a confirmed Area delete takes its Boards
    c.put("/desk/last", headers=h, json={"card_id": full})
    r = c.request("DELETE", f"/desk/areas/{area['id']}", headers=h, json={"with_cards": True})
    assert r.status_code == 200 and r.json()["data"]["cards"] == 1
    assert not (cockpit_env.a / ".hester" / "desk" / "boards" / full).exists()
    d = c.get("/desk", headers=h).json()["data"]
    assert all(x["id"] != full for x in d["cards"]) and d["last"] is None


# ---------------------------------------------------------------- anchors, asks and hand-offs


def test_board_anchors(cockpit_env, monkeypatch):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    scheduled = []
    monkeypatch.setattr(deep_ask.get_runner(), "schedule", lambda job: scheduled.append(job))
    bid = new_board(c, h)["card"]["id"]
    other = new_board(c, h)["card"]["id"]
    snap = selection(c, h, bid)
    img = upload(c, h, bid).json()["data"]["path"]
    area = c.get("/desk", headers=h).json()["data"]["areas"][0]["id"]
    pid = c.post("/desk/pages", headers=h, json={"area_id": area, "text": "words"}).json()["data"]["card"]["id"]

    r = c.post(f"/desk/boards/{bid}/asks", headers=h, json={"question": "Which is cleaner?", "anchor": board_anchor(snap)})
    assert r.status_code == 202, r.text
    ask = r.json()["data"]
    assert ask["anchor"] == {**board_anchor(snap), "kind": "board"} and ask["status"] == "queued"
    assert scheduled[-1].exp_id == bid and scheduled[-1].answer_id == ask["id"]
    none = c.post(f"/desk/boards/{bid}/asks", headers=h, json={"question": "Overall?", "anchor": {"kind": "none"}})
    assert none.status_code == 202

    bad = [
        board_anchor("assets/sel-00000000.png"),            # not there
        board_anchor(img),                                  # an image, not a selection
        board_anchor("../" + snap),
        dict(board_anchor(snap), item_ids="it-00000001"),
        dict(board_anchor(snap), rect={"x": 0}),
        dict(board_anchor(snap), notes=[3]),
        {"kind": "page", "quote": "x", "offset": 0, "section": None},
    ]
    for anchor in bad:
        assert c.post(f"/desk/boards/{bid}/asks", headers=h, json={"question": "q", "anchor": anchor}).status_code == 400, anchor
    # another Board's selection, and a board anchor on a Page
    assert c.post(f"/desk/boards/{other}/asks", headers=h, json={"question": "q", "anchor": board_anchor(snap)}).status_code == 400
    assert c.post(f"/desk/pages/{pid}/asks", headers=h, json={"question": "q", "anchor": board_anchor(snap)}).status_code == 400

    answers = c.get(f"/desk/boards/{bid}/answers", headers=h).json()["data"]
    assert {a["id"] for a in answers} == {ask["id"], none.json()["data"]["id"]}
    s = c.get(f"/desk/boards/{bid}", headers=h).json()["data"]["summary"]
    assert s["answers_pending"] == 2 and s["board"]["asks_open"] == 2
    assert c.patch(f"/desk/boards/{bid}/answers/{ask['id']}", headers=h, json={"read": True}).json()["data"]["read_at"]
    assert c.post(f"/desk/boards/{bid}/answers/{ask['id']}/retry", headers=h).status_code == 400, "only an errored one"


def test_a_board_handoff_carries_the_image_and_follows_its_task(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    card = new_board(c, h, title="Header")["card"]
    bid = card["id"]
    snap = selection(c, h, bid)
    r = c.post(f"/desk/boards/{bid}/handoffs", headers=h, json={
        "kind": "research", "provider": "claude", "brief": "Research: which header height reads best?",
        "anchor": board_anchor(snap, ["Too tall", "Try 48px"]),
    })
    assert r.status_code == 201, r.text
    ho = r.json()["data"]
    path = str((cockpit_env.a / ".hester" / "desk" / "boards" / bid / snap).absolute())
    brief = ho["handoff"]["brief"]
    assert brief.startswith("Research: which header") and path in brief and "- Too tall" in brief and "- Try 48px" in brief
    assert ho["question"] == "Research: which header height reads best?"
    assert deep.handoff_brief("docs", "x", "Header", bid).endswith(f"From the Board 'Header' ({bid})")

    # the task Lee launches has origin {kind: 'board', ref: '<bd>#<ans>'}; the record follows it
    ctx = SimpleNamespace(desk=lambda: DeskStore(cockpit_env.a), path=cockpit_env.a)
    origin = {"kind": "board", "ref": f"{bid}#{ho['id']}"}
    assert handoffs.parse_ref(origin["ref"], "board") == (bid, ho["id"])
    assert handoffs.parse_ref(origin["ref"], "page") == (None, None)
    row = handoffs.sync(ctx, {"id": "task-0000abcd", "status": "review", "origin": origin, "summary": "48px reads best."})
    assert row["handoff"]["state"] == "review" and row["answer"] == "48px reads best." and row["handoff"]["task_id"] == "task-0000abcd"
    from hester.daemon.cockpit.tasks import ORIGIN_KINDS
    assert "board" in ORIGIN_KINDS


class FakeGemini:
    """``genai.Client`` enough for ask_with_image: records what was sent, logs the call like the class-level wrap."""

    def __init__(self, reply="The left one: the header is shorter.", fail=False):
        self.reply, self.fail, self.calls, self.keys = reply, fail, [], []
        self.aio = SimpleNamespace(models=SimpleNamespace(generate_content=self._generate))

    def client(self, key):
        self.keys.append(key)
        return self

    async def _generate(self, model, contents, **kw):
        self.calls.append({"model": model, "contents": contents, "trigger": model_log.get_trigger()})
        model_log.record_model_call(provider="gemini", model=model, op="generate", location="cloud", ok=not self.fail)
        if self.fail:
            raise RuntimeError("quota")
        return SimpleNamespace(text=self.reply)


def _ask_ctx(ws: Path):
    desk = DeskStore(ws)
    return SimpleNamespace(path=ws, lock=asyncio.Lock(), desk=lambda: desk, explorations=None), desk


def _board_with_selection(desk: DeskStore):
    card, _ = desk.create_board({"title": "Layouts"})
    bid = card["id"]
    desk.boards.write(bid, {"version": None, "items": sample_items()})
    sel = desk.boards.add_asset(bid, "image/png", PNG, kind="selection")
    return bid, sel["path"]


def _run(ctx, bid, aid):
    async def go():
        runner = deep_ask.DeepAskRunner()
        runner.schedule(deep_ask.Job(ctx, bid, aid, {"kind": "user", "surface": "deep-ask"}))
        await runner.drain()
    asyncio.run(go())


@pytest.fixture
def no_agent(monkeypatch):
    """A Board Ask must never go through the agent (hybrid routing could pick a local model)."""
    def boom():
        raise AssertionError("a Board Ask reached the agent")
    monkeypatch.setattr(steward, "_agent_provider", boom)


def test_a_board_ask_sends_the_image_to_gemini(tmp_path, monkeypatch, isolated_copilot, no_agent):
    fake = FakeGemini()
    monkeypatch.setattr(deep_ask, "_gemini_client", fake.client)
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: "k-123")
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    ans = deep.new_answer(desk.boards, bid, {"question": "Which header is cleaner?", "anchor": board_anchor(snap, ["The header is too tall"])})
    _run(ctx, bid, ans["id"])

    done = deep.get_answer(desk.boards, bid, ans["id"])
    assert done["status"] == "done" and done["answer"] == fake.reply
    assert done["model"]["location"] == "cloud" and done["model"]["name"] == fake.calls[0]["model"]
    [call] = fake.calls
    assert fake.keys == ["k-123"] and call["trigger"]["kind"] == "user" and call["trigger"]["surface"] == "deep-ask"
    prompt, part = call["contents"]
    assert "Title: Layouts" in prompt and "- The header is too tall" in prompt and prompt.rstrip().endswith("Which header is cleaner?")
    assert part.inline_data.mime_type == "image/png" and part.inline_data.data == PNG
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "deep.answer"]
    assert ev["data"]["card_id"] == bid and ev["data"]["status"] == "done"

    # a follow-up carries the earlier Q and A; an Ask with no selection sends the Board's annotations and no image
    follow = deep.new_answer(desk.boards, bid, {"question": "And the footer?", "anchor": {"kind": "none"}, "follow_up_of": ans["id"]})
    _run(ctx, bid, follow["id"])
    prompt2 = fake.calls[-1]["contents"]
    assert len(prompt2) == 1 and "This follows up" in prompt2[0] and fake.reply in prompt2[0] and "[[pg-0000abcd|Layout]]" in prompt2[0]


def test_a_board_ask_without_a_gemini_key_says_so(tmp_path, monkeypatch, no_agent):
    fake = FakeGemini()
    monkeypatch.setattr(deep_ask, "_gemini_client", fake.client)
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: None)
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    ans = deep.new_answer(desk.boards, bid, {"question": "q", "anchor": board_anchor(snap)})
    _run(ctx, bid, ans["id"])
    row = deep.get_answer(desk.boards, bid, ans["id"])
    assert row["status"] == "error" and row["error"] == deep_ask.NO_GEMINI and "\n" not in row["error"]
    assert fake.calls == []

    # a failing call is an error too, and Retry runs it again
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: "k")
    fake.fail = True
    deep.requeue_answer(desk.boards, bid, ans["id"])
    _run(ctx, bid, ans["id"])
    row = deep.get_answer(desk.boards, bid, ans["id"])
    assert row["status"] == "error" and "Gemini couldn't answer (RuntimeError)" in row["error"]

    # the selection's file is gone
    fake.fail, fake.calls = False, []
    (desk.boards.exp_dir(bid) / snap).unlink()
    deep.requeue_answer(desk.boards, bid, ans["id"])
    _run(ctx, bid, ans["id"])
    row = deep.get_answer(desk.boards, bid, ans["id"])
    assert row["status"] == "error" and "image is gone" in row["error"] and fake.calls == []


def test_unfinished_board_asks_are_interrupted_on_recovery(tmp_path):
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    ans = deep.new_answer(desk.boards, bid, {"question": "q", "anchor": board_anchor(snap)})
    n = asyncio.run(deep_ask.DeepAskRunner().ensure_recovered(ctx, "desk"))
    assert n == 1 and deep.get_answer(desk.boards, bid, ans["id"])["status"] == "interrupted"
