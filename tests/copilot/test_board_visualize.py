"""Visualize on a Board (Boards B6, plan docs/plans/2026-09-28-boards.md §5b): the route, the diagram agent run, the result, hints and the CLI."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from hester.cli.desk import desk as desk_cli
from hester.daemon.cockpit import deep, deep_ask, visualize
from hester.daemon.cockpit.board import board_version
from hester.daemon.copilot import model_log
from hester.daemon.tools import visualization_tools
from hester.daemon.voice import hints

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued
from .test_board import PNG, _ask_ctx, _board_with_selection, _run, board_anchor, item, new_board, no_agent, selection  # noqa: F401

JPG = b"\xff\xd8\xff\xe0" + b"\0" * 32


class FakeLoop:
    """The diagram agent's ReAct loop: runs a script of tool calls through the registered handlers, as the real loop does."""

    def __init__(self, script=(), text="A flow of the header's three states.", success=True):
        self.script, self.text, self.success = list(script), text, success
        self.runs = []

    def factory(self, key, model):
        self.key, self.model = key, model
        return self

    def register_tools(self, tools, handlers):
        self.tools, self.handlers = [t["name"] for t in tools], handlers

    async def generate_with_tools(self, system_prompt, messages, max_iterations, model, tool_filter):
        self.runs.append({"system_prompt": system_prompt, "messages": messages, "max_iterations": max_iterations,
                          "model": model, "tool_filter": tool_filter, "trigger": model_log.get_trigger()})
        model_log.record_model_call(provider="gemini", model=model, op="generate", location="cloud", ok=self.success)
        if not self.success:
            return {"success": False, "error": "quota", "text": None, "tool_calls": []}
        for name, args in self.script:
            result = await self.handlers[name](**args)
            if isinstance(result, dict):
                result.pop("_image_data", None)  # the loop pops it before serialising
        return {"success": True, "text": self.text, "tool_calls": [], "model_used": model}


@pytest.fixture
def gemini_key(monkeypatch):
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: "k-viz")


def _visualize(desk, bid, snap, brief="A flowchart of the header's states\nshort and plain"):
    return deep.new_visualize(desk.boards, bid, {"brief": brief, "anchor": board_anchor(snap, ["Too tall", "Try 48px"])})


# ---------------------------------------------------------------- the route and the record


def test_the_visualize_route_records_and_schedules(cockpit_env, monkeypatch):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    scheduled = []
    monkeypatch.setattr(deep_ask.get_runner(), "schedule", lambda job: scheduled.append(job))
    bid = new_board(c, h, title="Header")["card"]["id"]
    snap = selection(c, h, bid)

    r = c.post(f"/desk/boards/{bid}/visualize", headers=h, json={"brief": "A flowchart of the states\nmore", "anchor": board_anchor(snap)})
    assert r.status_code == 201, r.text
    row = r.json()["data"]
    assert row["kind"] == "visualize" and row["status"] == "queued" and row["visual"] is None
    assert row["question"] == "A flowchart of the states" and row["brief"] == "A flowchart of the states\nmore"
    assert row["anchor"]["kind"] == "board" and row["anchor"]["snapshot"] == snap
    assert scheduled[-1].exp_id == bid and scheduled[-1].answer_id == row["id"]
    assert scheduled[-1].trigger.get("surface") == "deep-ask"
    [listed] = c.get(f"/desk/boards/{bid}/answers", headers=h).json()["data"]
    assert listed["id"] == row["id"] and listed["visual"] is None

    for body in (
        {"brief": "", "anchor": board_anchor(snap)},
        {"brief": "x" * (deep.MAX_QUESTION + 1), "anchor": board_anchor(snap)},
        {"brief": "a diagram", "anchor": {"kind": "none"}},
        {"brief": "a diagram"},
        {"brief": "a diagram", "anchor": board_anchor("assets/sel-00000000.png")},
    ):
        assert c.post(f"/desk/boards/{bid}/visualize", headers=h, json=body).status_code == 400, body
    area = c.get("/desk", headers=h).json()["data"]["areas"][0]["id"]
    pid = c.post("/desk/pages", headers=h, json={"area_id": area, "text": "words"}).json()["data"]["card"]["id"]
    assert c.post(f"/desk/boards/{pid}/visualize", headers=h, json={"brief": "x", "anchor": board_anchor(snap)}).status_code == 400
    assert c.post("/desk/boards/bd-0000beef/visualize", headers=h, json={"brief": "x", "anchor": board_anchor(snap)}).status_code == 404
    assert c.post(f"/desk/boards/{bid}/answers/{row['id']}/retry", headers=h).status_code == 400, "only an errored one"


def test_a_visual_item_is_checked(cockpit_env):
    c, h = cockpit_env.client, hdr(cockpit_env.a)
    bid = new_board(c, h)["card"]["id"]
    base = f"/desk/boards/{bid}/board"
    target = {"item_ids": ["it-00000001"], "rect": {"x": 0, "y": 0, "w": 10, "h": 10}}
    ok = [item("image", 1, asset="img-0000000a.png"),
          item("visual", 2, answer_id="ans-0000000a", target=target, result_item_id="it-00000003", open=False),
          item("visual", 4, answer_id="ans-0000000b", target=target)]
    r = c.put(base, headers=h, json={"version": None, "items": ok})
    assert r.status_code == 200, r.text
    version = r.json()["data"]["version"]
    assert version == board_version(ok)
    for bad in (
        item("visual", 5, answer_id="ans-1", target=target),
        item("visual", 5, answer_id="ans-0000000c", target={"item_ids": "x"}),
        item("visual", 5, answer_id="ans-0000000c", target=target, result_item_id="nope"),
        item("visual", 5, answer_id="ans-0000000c", target=target, open="yes"),
    ):
        assert c.put(base, headers=h, json={"version": version, "items": ok + [bad]}).status_code == 400, bad


# ---------------------------------------------------------------- the run


def test_a_mermaid_visualize_runs_the_diagram_agent_with_the_image(tmp_path, monkeypatch, isolated_copilot, no_agent, gemini_key):
    fake = FakeLoop([("render_markdown", {"markdown": "| a | b |", "title": "First try"}),
                     ("render_mermaid", {"mermaid": "flowchart LR\n  A --> B", "title": "Header states"})])
    monkeypatch.setattr(visualize, "_capability", fake.factory)
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    row = _visualize(desk, bid, snap)
    _run(ctx, bid, row["id"])

    done = deep.get_answer(desk.boards, bid, row["id"])
    assert done["status"] == "done", done
    assert done["visual"] == {"type": "mermaid", "dsl": "flowchart LR\n  A --> B", "title": "Header states"}, "the last visual one"
    assert done["answer"] == fake.text and done["model"] == {"location": "cloud", "name": fake.model}

    setup = visualize.agent_setup(tmp_path)
    assert fake.key == "k-viz" and fake.tools == list(visualize.VISUAL_TOOLS) and set(setup["tools"]) == set(visualize.VISUAL_TOOLS)
    [run] = fake.runs
    assert run["tool_filter"] == setup["tools"] and run["max_iterations"] == setup["max_iterations"] == 8
    assert "## On a Board" in run["system_prompt"] and "Visualize Agent" in run["system_prompt"]
    assert run["trigger"]["kind"] == "user" and run["trigger"]["surface"] == "deep-ask"
    [msg] = run["messages"]
    assert msg["images"] == [{"data": PNG, "mime_type": "image/png"}]
    assert "Title: Layouts" in msg["content"] and "- Too tall" in msg["content"] and "- Try 48px" in msg["content"]
    assert msg["content"].rstrip().endswith("A flowchart of the header's states\nshort and plain")
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "deep.answer"]
    assert ev["data"]["card_id"] == bid and ev["data"]["answer_id"] == row["id"] and ev["data"]["status"] == "done"


def test_an_image_visualize_is_saved_as_a_board_asset(tmp_path, monkeypatch, no_agent, gemini_key):
    made = []

    async def fake_generate(prompt, title=None, working_dir=None):
        made.append({"prompt": prompt, "working_dir": working_dir})
        return {"type": "image", "content": "[Image generated]", "mime_type": "image/png", "title": title,
                "_image_data": PNG, "_image_mime_type": "image/png"}

    monkeypatch.setattr(visualization_tools, "execute_generate_image", fake_generate)
    fake = FakeLoop([("render_mermaid", {"mermaid": "graph TD; A-->B"}),
                     ("generate_image", {"prompt": "the header, shorter", "title": "Shorter header"})])
    monkeypatch.setattr(visualize, "_capability", fake.factory)
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    row = _visualize(desk, bid, snap)
    _run(ctx, bid, row["id"])

    done = deep.get_answer(desk.boards, bid, row["id"])
    assert done["status"] == "done", done
    visual = done["visual"]
    assert visual["type"] == "image" and visual["title"] == "Shorter header"
    assert made == [{"prompt": "the header, shorter", "working_dir": str(tmp_path)}]
    path, mime = desk.boards.asset_path(bid, visual["asset"])
    assert path.read_bytes() == PNG and mime == "image/png" and visual["asset"].startswith("img-")
    [asset] = [a for a in desk.boards.list_assets(bid) if a["name"] == visual["asset"]]
    assert asset["source"] == {"kind": "answer", "card_id": bid, "answer_id": row["id"]}

    # a JPEG is kept as one; a title-less text result gets a plain one
    assert visualize.save_result(desk.boards, bid, row["id"], {"type": "image", "_image_data": JPG})["asset"].endswith(".jpg")
    assert visualize.save_result(desk.boards, bid, row["id"], {"type": "markdown", "content": "| a |"}) == {
        "type": "markdown", "text": "| a |", "title": "Visualization"}


def test_visualize_errors_retry_and_restart(tmp_path, monkeypatch, no_agent):
    key = {"value": None}
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: key["value"])
    fake = FakeLoop([])
    monkeypatch.setattr(visualize, "_capability", fake.factory)
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    row = _visualize(desk, bid, snap)

    _run(ctx, bid, row["id"])
    got = deep.get_answer(desk.boards, bid, row["id"])
    assert got["status"] == "error" and got["error"] == visualize.NO_GEMINI and got["visual"] is None and fake.runs == []

    # the agent made nothing visual (its image tool failed, say): an error, and Retry runs it again
    key["value"] = "k"
    fake.script = [("render_markdown", {"markdown": ""})]
    deep.requeue_answer(desk.boards, bid, row["id"])
    _run(ctx, bid, row["id"])
    got = deep.get_answer(desk.boards, bid, row["id"])
    assert got["status"] == "error" and got["error"] == visualize.NOTHING_MADE

    fake.success = False
    requeued = deep.requeue_answer(desk.boards, bid, row["id"])
    assert requeued["status"] == "queued" and requeued["visual"] is None and "error" not in requeued
    _run(ctx, bid, row["id"])
    got = deep.get_answer(desk.boards, bid, row["id"])
    assert got["status"] == "error" and "the diagram agent failed (quota)" in got["error"]

    fake.success, fake.script = True, [("render_markdown", {"markdown": "| a | b |", "title": "Compare"})]
    deep.requeue_answer(desk.boards, bid, row["id"])
    _run(ctx, bid, row["id"])
    got = deep.get_answer(desk.boards, bid, row["id"])
    assert got["status"] == "done" and got["visual"] == {"type": "markdown", "text": "| a | b |", "title": "Compare"}

    # the selection's file is gone
    (desk.boards.exp_dir(bid) / snap).unlink()
    runs = len(fake.runs)
    deep.update_answer(desk.boards, bid, row["id"], {"status": "error"})
    deep.requeue_answer(desk.boards, bid, row["id"])
    _run(ctx, bid, row["id"])
    got = deep.get_answer(desk.boards, bid, row["id"])
    assert got["status"] == "error" and "image is gone" in got["error"] and len(fake.runs) == runs

    # left queued by a daemon that stopped: interrupted, like an Ask
    other = _visualize(*_second_selection(desk, bid))
    n = asyncio.run(deep_ask.DeepAskRunner().ensure_recovered(ctx, "desk"))
    assert n == 1 and deep.get_answer(desk.boards, bid, other["id"])["status"] == "interrupted"


def _second_selection(desk, bid):
    sel = desk.boards.add_asset(bid, "image/png", PNG, kind="selection")
    return desk, bid, sel["path"]


# ---------------------------------------------------------------- generate_image's key


def test_generate_image_reads_the_configured_key(tmp_path, monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    seen = {}
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: seen.setdefault("ws", ws) and "cfg-key")

    class Models:
        async def generate_content(self, model, contents, config):
            seen["model"], seen["contents"] = model, contents
            part = SimpleNamespace(inline_data=SimpleNamespace(data=PNG, mime_type="image/png"), text=None)
            return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))])

    def client(api_key):
        seen["key"] = api_key
        return SimpleNamespace(aio=SimpleNamespace(models=Models()))

    monkeypatch.setattr(visualization_tools, "_image_client", client)
    out = asyncio.run(visualization_tools.execute_generate_image("a header", title="H", working_dir=str(tmp_path)))
    assert out["type"] == "image" and out["_image_data"] == PNG and out["title"] == "H"
    assert seen["key"] == "cfg-key" and seen["ws"] == tmp_path and seen["contents"] == "a header"

    # no key anywhere: an error result, never a call; the old two-argument call still works
    monkeypatch.setattr("hester.daemon.voice.config.google_api_key", lambda ws=None: None)
    seen.clear()
    out = asyncio.run(visualization_tools.execute_generate_image("a header", "H"))
    assert out["type"] == "error" and "GOOGLE_API_KEY" in out["error"] and "key" not in seen


# ---------------------------------------------------------------- voice hints and the CLI


def test_voice_hints_for_a_board(tmp_path):
    ctx, desk = _ask_ctx(tmp_path)
    card, _ = desk.create_board({"title": "Header renders"})
    bid = card["id"]
    notes = [
        item("note", 1, text="Too tall"),
        item("note", 2, text="The DeskSurface header should match [[pg-0000abcd|Layout grid]] in header_v2, says Taxonomy"),
        item("image", 3, asset="img-0000000a.png"),
    ]
    desk.boards.write(bid, {"version": None, "items": notes})
    terms = hints.board_terms(tmp_path, bid)
    assert terms[:3] == ["Header renders", "Too tall", "Layout grid"]
    assert "DeskSurface" in terms and "header_v2" in terms and "Taxonomy" in terms
    got = asyncio.run(hints.hint_for("send", bid, tmp_path, None, fetch_item=None))
    assert got[0] == "Header renders" and got[-1] == tmp_path.name
    assert hints.board_terms(tmp_path, "bd-0000beef") == [] and hints.board_terms(None, bid) == []
    assert hints.board_terms(tmp_path, "pg-0000abcd") == []


def test_hester_desk_board_prints_visualizes(tmp_path):
    ctx, desk = _ask_ctx(tmp_path)
    bid, snap = _board_with_selection(desk)
    mermaid = _visualize(desk, bid, snap, "A flowchart of the states")
    deep.update_answer(desk.boards, bid, mermaid["id"], {
        "status": "done", "answer": "Three states.", "visual": {"type": "mermaid", "dsl": "graph TD; A-->B", "title": "States"}})
    image = _visualize(desk, bid, snap, "Draw it shorter")
    asset = desk.boards.add_asset(bid, "image/png", PNG, source={"kind": "answer", "card_id": bid, "answer_id": image["id"]})
    deep.update_answer(desk.boards, bid, image["id"], {
        "status": "done", "visual": {"type": "image", "asset": asset["name"], "title": "Shorter"}})
    failed = _visualize(desk, bid, snap, "A table")
    deep.update_answer(desk.boards, bid, failed["id"], {"status": "error", "error": visualize.NOTHING_MADE})

    r = CliRunner().invoke(desk_cli, ["board", bid, "--dir", str(tmp_path)])
    assert r.exit_code == 0, r.output
    folder = tmp_path / ".hester" / "desk" / "boards" / bid
    out = r.output
    assert "## Visualizes (3), made by Hester's diagram agent" in out and "## Asks" not in out
    assert "### A flowchart of the states" in out and 'Result: mermaid diagram "States"' in out and "Three states." in out
    assert f'Result: {folder / "assets" / asset["name"]} "Shorter"' in out
    assert f"Status: error ({visualize.NOTHING_MADE})" in out and f"Selection (image): {folder / snap}" in out
    data = json.loads(CliRunner().invoke(desk_cli, ["board", bid, "--dir", str(tmp_path), "--json"]).output)
    assert len(data["visualizes"]) == 3 and data["asks"] == []
