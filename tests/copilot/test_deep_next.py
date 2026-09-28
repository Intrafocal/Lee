"""Deep, next revision, package B (contract 2026-09-27 section 2)."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from hester.daemon.cockpit import deep, deep_ask, goal_status, handoffs, steward
from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.cockpit.explorations import ExplorationStore, seed_title
from hester.daemon.cockpit.follower import EventFollower
from hester.daemon.cockpit.goals import parse_goals_full
from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.workspaces.registry import WorkspaceRegistry
from hester.shared import workspace as ws_mod

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import make_event, queued, write_events
from .test_deep_ask import PAGE, FakeAgent, anchor, seeded

SECTION = "## Sync\n\nThe vector clock only helps if every write carries one.\n"


# ---------------------------------------------------------------- asks with their section (R2)


def test_section_text_goes_after_the_seed_before_the_anchor(tmp_path):
    store, exp = seeded(tmp_path)
    ans = deep.new_answer(store, exp["id"], {"question": "What do you think?", "anchor": anchor(), "section_text": SECTION})
    assert ans["section_text"] == SECTION
    text = deep_ask.context_for(store, exp["id"], ans)
    order = ["### Exploration", "Mesh sync without a server", "### The section this is about",
             "every write carries one", "### Where the question was asked", "### The Page"]
    at = [text.index(s) for s in order]
    assert at == sorted(at), text

    # absent (or blank): as before
    plain = deep.new_answer(store, exp["id"], {"question": "q", "anchor": anchor(), "section_text": "  \n"})
    assert "section_text" not in plain
    assert "The section this is about" not in deep_ask.context_for(store, exp["id"], plain)

    # long sections are cut to 6 000, not refused; non-strings are
    long = deep.new_answer(store, exp["id"], {"question": "q", "anchor": anchor(), "section_text": "x" * 7000})
    assert len(long["section_text"]) == deep.MAX_SECTION_TEXT and long["section_text"].endswith("…")
    with pytest.raises(deep.ExplorationError):
        deep.new_answer(store, exp["id"], {"question": "q", "anchor": anchor(), "section_text": 3})


# ---------------------------------------------------------------- hand-offs (R3)


def desk_page(c, h, text=PAGE, **body):
    """A Page card in the Desk's first Area (or the Goals card); its id."""
    if body.get("purpose") != "goals":
        body.setdefault("area_id", c.get("/desk", headers=h).json()["data"]["areas"][0]["id"])
    r = c.post("/desk/pages", headers=h, json=dict(body, text=text))
    assert r.status_code in (200, 201), r.text
    return r.json()["data"]["card"]["id"]


def handoff_body(**kw):
    body = {"kind": "spike", "provider": "claude", "brief": "Spike: try it\n\nThe section.", "anchor": anchor()}
    body.update(kw)
    return body


def test_handoff_create_patch_and_guards(cockpit_env, monkeypatch):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    card = desk_page(c, h, title="Mesh")
    base = f"/desk/pages/{card}"

    for bad in ({"kind": "essay"}, {"provider": "gpt"}, {"brief": "  "}, {"brief": 3}):
        assert c.post(f"{base}/handoffs", headers=h, json=handoff_body(**bad)).status_code == 400, bad
    no_anchor = handoff_body()
    del no_anchor["anchor"]
    assert c.post(f"{base}/handoffs", headers=h, json=no_anchor).status_code == 400
    assert c.post("/desk/pages/pg-00000000/handoffs", headers=h, json=handoff_body()).status_code == 404

    r = c.post(f"{base}/handoffs", headers=h, json=handoff_body())
    assert r.status_code == 201, r.text
    rec = r.json()["data"]
    assert rec["kind"] == "handoff" and rec["surface"] == "deep-handoff" and rec["status"] == "queued"
    assert rec["question"] == "Spike: try it" and rec["anchor"]["section"] == "Sync"
    assert rec["handoff"] == {"kind": "spike", "provider": "claude", "brief": "Spike: try it\n\nThe section.",
                              "task_id": None, "state": "launching"}
    aid = rec["id"]

    # PATCH task_id: running
    assert c.patch(f"{base}/answers/{aid}", headers=h, json={"task_id": "not a task"}).status_code == 400
    r = c.patch(f"{base}/answers/{aid}", headers=h, json={"task_id": "task-0000abcd"})
    assert r.status_code == 200, r.text
    row = r.json()["data"]
    assert row["handoff"]["task_id"] == "task-0000abcd" and row["handoff"]["state"] == "running"
    assert row["status"] == "running"
    assert c.patch(f"{base}/answers/{aid}", headers=h, json={"task_id": "task-9999abcd"}).status_code == 400
    assert c.get(base, headers=h).json()["data"]["summary"]["handoffs_in_flight"] == 1

    # a hand-off isn't retried as an Ask
    assert c.post(f"{base}/answers/{aid}/retry", headers=h).status_code == 400

    # a failed launch: status error
    other = c.post(f"{base}/handoffs", headers=h, json=handoff_body(kind="research", provider="pi")).json()["data"]
    r = c.patch(f"{base}/answers/{other['id']}", headers=h, json={"status": "error", "error": "no_window"})
    assert r.status_code == 200
    row = r.json()["data"]
    assert row["status"] == "error" and row["error"] == "no_window" and row["handoff"]["state"] == "error"
    assert c.patch(f"{base}/answers/{other['id']}", headers=h, json={"status": "done"}).status_code == 400

    # an Ask takes neither
    monkeypatch.setattr(deep_ask.get_runner(), "schedule", lambda job: None)
    ask = c.post(f"{base}/asks", headers=h, json={"question": "q", "anchor": anchor()}).json()["data"]
    assert c.patch(f"{base}/answers/{ask['id']}", headers=h, json={"task_id": "task-0000abcd"}).status_code == 400

    # a daemon restart leaves hand-offs alone (their agents run in Lee)
    store = DeskStore(env.a).pages
    assert deep.interrupt_pending(store) == 1
    assert deep.get_answer(store, card, aid)["status"] == "running"
    assert deep.get_answer(store, card, ask["id"])["status"] == "interrupted"


def test_patch_task_id_never_steps_back(tmp_path):
    store, exp = seeded(tmp_path)
    rec = deep.new_handoff(store, exp["id"], handoff_body())
    deep.update_answer(store, exp["id"], rec["id"], {"handoff": dict(rec["handoff"], task_id="task-0000abcd", state="review")})
    row = deep.patch_answer(store, exp["id"], rec["id"], {"task_id": "task-0000abcd"})
    assert row["handoff"]["state"] == "review"


def test_handoff_templates_and_brief(cockpit_env):
    for kind in deep.HANDOFF_KINDS:
        assert deep.handoff_template(kind)
    assert "throwaway prototype" in deep.handoff_template("spike") and "merg" in deep.handoff_template("spike")
    assert "docs/" in deep.handoff_template("docs") and "nothing else" in deep.handoff_template("docs")
    assert "no code changes" in deep.handoff_template("research") and "sources" in deep.handoff_template("research")
    brief = deep.handoff_brief("docs", SECTION, "Mesh sync", "exp-1a2b3c4d")
    assert brief == (deep.handoff_template("docs") + "\n\n" + SECTION.rstrip("\n")
                     + "\n\nFrom the exploration 'Mesh sync' (exp-1a2b3c4d)")
    with pytest.raises(deep.ExplorationError):
        deep.handoff_template("essay")

    c, h = cockpit_env.client, hdr(cockpit_env.a)
    r = c.get("/cockpit/handoff-template?kind=research", headers=h)
    assert r.status_code == 200 and r.json()["data"] == {"template": deep.handoff_template("research")}
    assert c.get("/cockpit/handoff-template?kind=nope", headers=h).status_code == 400


def test_parse_ref():
    assert handoffs.parse_ref("exp-1a2b3c4d#ans-5e6f7a8b") == ("exp-1a2b3c4d", "ans-5e6f7a8b")
    for bad in (None, "exp-1a2b3c4d/n-5e6f7a8b", "exp-1a2b3c4d#nope", "x#ans-5e6f7a8b"):
        assert handoffs.parse_ref(bad) == (None, None)


T0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)


class FollowEnv:
    def __init__(self, tmp_path, monkeypatch):
        self.ws = (tmp_path / "ws")
        self.ws.mkdir()
        self.ws = self.ws.resolve()
        monkeypatch.setattr(ws_mod, "_current_workspace", self.ws)
        self.events = tmp_path / "events"
        self.registry = WorkspaceRegistry(boot=self.ws)
        self.follower = EventFollower(registry=self.registry, events_dir=self.events, state_file=tmp_path / "f.json")
        self.n = 0

    def write(self, type, minutes, data):
        self.n += 1
        e = make_event(type, T0 + timedelta(minutes=minutes), data, workspace=str(self.ws))
        e["id"] = f"ev{self.n:04d}"
        write_events(self.events, [e])

    def tick(self):
        return asyncio.run(self.follower.tick())


def test_follower_keeps_the_handoff_in_step(tmp_path, monkeypatch, isolated_copilot):
    env = FollowEnv(tmp_path, monkeypatch)
    store = ExplorationStore(env.ws)
    exp = store.create({"seed": "Mesh sync", "page": PAGE})
    rec = deep.new_handoff(store, exp["id"], handoff_body())
    ref = f"{exp['id']}#{rec['id']}"
    tid = "task-0000abcd"
    s = {"session_id": "s1", "pty_id": 4}

    def row():
        return deep.get_answer(store, exp["id"], rec["id"])

    # launch: the record learns its task and runs (the renderer's PATCH may come later)
    env.write("task.launch", 0, {"task_id": tid, **s, "provider": "claude", "lead": "delegate", "kind": "prototype",
                                  "confirmed": True, "origin_kind": "exploration", "origin_ref": ref, "timebox_min": 45})
    env.tick()
    task = CockpitTaskStore(env.ws).get(tid)
    assert task["origin"] == {"kind": "exploration", "ref": ref} and task["timebox_min"] == 45
    assert row()["handoff"]["task_id"] == tid and row()["handoff"]["state"] == "running" and row()["status"] == "running"

    # a pending approval: waiting
    env.write("agent.waiting", 1, {**s, "kind": "approval", "item_id": "att-1"})
    env.tick()
    assert row()["handoff"]["state"] == "waiting" and row()["status"] == "running"

    # a turn end in review: the answer is the lee-status summary and next
    env.write("agent.turn_end", 2, {**s, "busy_ms": 1000, "summary": "the long message",
                                    "lee_status": {"status": "done", "summary": "Tried a CRDT; 300 lines.", "next": "Measure sync"}})
    env.tick()
    r = row()
    assert r["handoff"]["state"] == "review" and r["status"] == "running"
    assert r["answer"] == "Tried a CRDT; 300 lines.\n\nNext: Measure sync"

    # a later turn in review refreshes it; without lee-status, the message
    env.write("agent.prompt", 3, s)
    env.write("agent.turn_end", 4, {**s, "busy_ms": 1000, "summary": "Also tried a log.",
                                    "lee_status": {"status": "done", "summary": None, "next": None}})
    env.tick()
    assert row()["answer"] == "Also tried a log." and row()["handoff"]["state"] == "review"

    # closed as done
    tstore = CockpitTaskStore(env.ws)
    tstore.close(tid, {"status": "done"})
    handoffs.sync(env.registry.get(env.ws), tstore.get(tid))
    r = row()
    assert r["handoff"]["state"] == "done" and r["status"] == "done" and r["answered_at"]
    assert r["answer"] == "Also tried a log."

    states = [e["data"]["state"] for e in queued(isolated_copilot)
              if e["type"] == "deep.answer" and e["data"]["answer_id"] == rec["id"]]
    assert states == ["running", "waiting", "review", "review", "done"]
    assert all(e["data"]["kind"] == "handoff" for e in queued(isolated_copilot) if e["type"] == "deep.answer")


def test_discarded_task_and_close_route(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    card = desk_page(c, h, title="Mesh")
    rec = c.post(f"/desk/pages/{card}/handoffs", headers=h, json=handoff_body(kind="docs")).json()["data"]
    ref = f"{card}#{rec['id']}"
    # the relay (Lee's launcher) creates the task with the Page's origin
    r = c.post("/cockpit/tasks", headers=h, json={
        "id": "task-0000beef", "title": "Docs", "lead": "delegate", "kind": "chore", "status": "running",
        "origin": {"kind": "page", "ref": ref}, "timebox_min": 30,
    })
    assert r.status_code == 201, r.text
    got = c.get(f"/desk/pages/{card}/answers", headers=h).json()["data"][0]
    assert got["handoff"]["task_id"] == "task-0000beef" and got["handoff"]["state"] == "running"
    # the renderer's PATCH arriving after is fine
    assert c.patch(f"/desk/pages/{card}/answers/{rec['id']}", headers=h,
                   json={"task_id": "task-0000beef"}).status_code == 200
    assert c.post("/cockpit/tasks/task-0000beef/close", headers=h, json={"status": "discarded"}).status_code == 200
    got = c.get(f"/desk/pages/{card}/answers", headers=h).json()["data"][0]
    assert got["handoff"]["state"] == "error" and got["status"] == "error" and got["error"] == "discarded"


def test_another_tasks_origin_is_ignored(tmp_path):
    store, exp = seeded(tmp_path)
    rec = deep.new_handoff(store, exp["id"], handoff_body())
    deep.patch_answer(store, exp["id"], rec["id"], {"task_id": "task-0000abcd"})
    ctx = WorkspaceRegistry(boot=tmp_path).get(tmp_path)
    task = {"id": "task-ffff0000", "status": "review", "summary": "x",
            "origin": {"kind": "exploration", "ref": f"{exp['id']}#{rec['id']}"}}
    assert handoffs.sync(ctx, task) is None
    assert deep.get_answer(store, exp["id"], rec["id"])["handoff"]["state"] == "running"
    ask = deep.new_answer(store, exp["id"], {"question": "q", "anchor": anchor()})
    task["origin"]["ref"] = f"{exp['id']}#{ask['id']}"
    assert handoffs.sync(ctx, task) is None, "only hand-off records follow tasks"


def test_idle_agent_with_an_answer_is_review(tmp_path):
    """A research agent answers and waits (task idle, session open): the result is ready."""
    store, exp = seeded(tmp_path)
    rec = deep.new_handoff(store, exp["id"], handoff_body())
    deep.patch_answer(store, exp["id"], rec["id"], {"task_id": "task-0000abcd"})
    ctx = WorkspaceRegistry(boot=tmp_path).get(tmp_path)
    task = {"id": "task-0000abcd", "status": "idle", "turns": 1, "summary": "Workbook vs Machine: …",
            "origin": {"kind": "exploration", "ref": f"{exp['id']}#{rec['id']}"}}
    row = handoffs.sync(ctx, task)
    assert row["handoff"]["state"] == "review" and row["answer"].startswith("Workbook vs Machine")
    task.update(status="running")
    assert handoffs.sync(ctx, task)["handoff"]["state"] == "running", "a reply that starts a turn"
    fresh = {"id": "task-0000abcd", "status": "idle", "turns": 0, "summary": None,
             "origin": task["origin"]}
    assert handoffs.sync(ctx, fresh)["handoff"]["state"] == "running", "idle before any turn is still running"


# ---------------------------------------------------------------- delete empty explorations (R8)


# ---------------------------------------------------------------- file references (R10)


def test_file_references(tmp_path):
    store, exp = seeded(tmp_path)
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "14-Deep-Work.md").write_text("line\n" * 200)
    (tmp_path.parent / "outside.md").write_text("secret")
    ref = deep.add_reference(store, exp["id"], {
        "kind": "quote", "quote": "the quoted text", "file": "docs/14-Deep-Work.md", "lines": [120, 128],
        "section": "Sync", "source": {"kind": "file"},
    })
    assert ref["file"] == "docs/14-Deep-Work.md" and ref["lines"] == [120, 128] and ref["source"] == {"kind": "file"}
    link = deep.add_reference(store, exp["id"], {"kind": "link", "file": "./docs/../docs/14-Deep-Work.md", "source": {"kind": "file"}})
    assert link["file"] == "docs/14-Deep-Work.md" and "url" not in link and "lines" not in link

    bad = [
        {"file": "/etc/passwd"}, {"file": "../outside.md"}, {"file": "docs/missing.md"}, {"file": "docs"},
        {"file": "docs/14-Deep-Work.md", "lines": [0, 3]}, {"file": "docs/14-Deep-Work.md", "lines": [5, 4]},
        {"file": "docs/14-Deep-Work.md", "lines": [1]}, {"file": "docs/14-Deep-Work.md", "lines": ["1", "2"]},
        {"url": "https://x.org", "lines": [1, 2]},
    ]
    for body in bad:
        with pytest.raises(deep.ExplorationError):
            deep.add_reference(store, exp["id"], {"kind": "link", **body})
    (tmp_path / "escape.md").symlink_to(tmp_path.parent / "outside.md")
    with pytest.raises(deep.ExplorationError):
        deep.add_reference(store, exp["id"], {"kind": "link", "file": "escape.md"})


# ---------------------------------------------------------------- the Goals Page (R12)


def test_draft_from_readme(cockpit_env, monkeypatch, isolated_copilot):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    fake = FakeAgent(reply="```markdown\n## What is this for, and who is it for?\n\nLee.\n```")
    monkeypatch.setattr(steward, "_agent_provider", lambda: fake)
    card = desk_page(c, h, text="", purpose="goals")
    url = f"/desk/pages/{card}/draft-from-readme"

    assert c.post(url, headers=h).status_code == 400, "no README.md or CLAUDE.md"
    assert fake.requests == []
    (env.a / "README.md").write_text("# Lee\n\nA terminal-native IDE. " + "x" * 20000)
    (env.a / "CLAUDE.md").write_text("Local-first. Keyboard-driven.")
    r = c.post(url, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"text": "## What is this for, and who is it for?\n\nLee.", "sources": ["README.md", "CLAUDE.md"]}
    [req] = fake.requests
    assert req.surface == "goals-readme" and req.surface not in steward.STEER_SURFACES
    for prompt in deep_ask.GOALS_PROMPTS:
        assert f"## {prompt}" in req.message
    assert "A terminal-native IDE" in req.steward_context and "Keyboard-driven" in req.steward_context
    assert len(req.steward_context) < 2 * deep_ask.README_CAP + 500, "each file is capped"
    assert fake.triggers[0]["kind"] == "user" and fake.triggers[0]["surface"] == "goals-readme"
    assert "You are also the user's steward" not in steward.prompt_layer_for_request(req, str(env.a))
    assert c.get(f"/desk/pages/{card}/page", headers=h).json()["data"]["text"] == "", "never writes the Page"
    assert c.post("/desk/pages/pg-00000000/draft-from-readme", headers=h).status_code == 404


GOALS_MD = """# Goals

## Goals

### G1 Ship a Page people use

It should be where the thinking happens, not a form.

### G2 Measured goal

Prose.

- metric: **pull_usage**: asks per week
  - kind: outcome
  - target: >= 5
"""


def test_metric_less_goals(tmp_path):
    parsed = parse_goals_full("### G1 Just a heading\n\nAnd a paragraph.\n")
    assert [(g["id"], g["title"], g["prose"], g["metrics"]) for g in parsed["goals"]] == [
        ("G1", "Just a heading", "And a paragraph.", [])
    ]
    (tmp_path / "GOALS.md").write_text(GOALS_MD)
    status = goal_status.build_status(tmp_path)
    by_id = {g["id"]: g for g in status["goals"]}
    assert by_id["G1"]["measured"] is False and by_id["G1"]["flagged"] is False and by_id["G1"]["metrics"] == []
    assert by_id["G2"]["measured"] is True


# ---------------------------------------------------------------- explorations from existing text


def test_seed_opens_the_page(tmp_path):
    store = ExplorationStore(tmp_path)
    seed = "Try a CRDT for the queue. It might remove the server entirely, which would be a big deal for offline use."
    exp = store.create({"seed": seed})
    assert store.page_path(exp["id"]).read_text() == seed + "\n\n"
    assert exp["title"] == "Try a CRDT for the queue."
    # the opener's page wins
    given = store.create({"seed": "The question", "page": "My own words\n"})
    assert store.page_path(given["id"]).read_text() == "My own words\n"
    # Explore from a selection opens on the selection
    child = deep.explore_child(store, exp["id"], {"seed": "every write carries one"})
    assert store.page_path(child["id"]).read_text() == "every write carries one\n\n"


def test_seed_titles():
    assert seed_title("First line\nSecond line that is longer") == "First line"
    long = "A very long single line about syncing a mesh of devices without any server at all"
    t = seed_title(long)
    assert len(t) <= 60 and t.endswith("…") and not t[:-1].endswith(" ")
    assert seed_title("Short one. Then more words here.") == "Short one."
    assert seed_title("Exactly fits") == "Exactly fits"
    assert seed_title("") == ""


