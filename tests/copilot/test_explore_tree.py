"""Copilot v3: Explore absorbs the Library (contracts 2026-09-26-copilot-v3 §1-§8)."""

import asyncio
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from hester.daemon.cockpit import explore_ops, spikes
from hester.daemon.cockpit import explorations as ex
from hester.daemon.cockpit.explorations import ExplorationError, ExplorationStore
from hester.daemon.cockpit.follower import EventFollower
from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.session import InMemorySessionManager
from hester.daemon.workstream.store import WorkstreamStore

from .cockpit_helpers import SHARED, cockpit_env, hdr  # noqa: F401
from .conftest import commit_file, git, make_event, write_events

ANSWER_WITH_HEADINGS = "Here is a plan.\n\n## Log\n\n### Step one\n\n## Node n-00000000 · not a node\n\n# Big heading\n\nDone."


class Ctx:
    """The parts of a WorkspaceContext the Explore code uses."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.id = "ws-test"
        self.lock = asyncio.Lock()
        self._tasks = CockpitTaskStore(self.path)
        self._exp = ExplorationStore(self.path)
        self._ws = WorkstreamStore(self.path / ".hester" / "workstreams")

    def tasks(self):
        return self._tasks

    def explorations(self):
        return self._exp

    def ws_store(self):
        return self._ws


# ---------------------------------------------------------------- file format / parser


def test_parser_round_trips_with_headings_inside_answers(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Tree", "seed": "Seed text"})
    store.record_turn(exp["id"], "Root question?", ANSWER_WITH_HEADINGS)
    node = store.add_node(exp["id"], "root", "Try a file-first store", mode="explore")
    store.record_turn(exp["id"], "Branch q", "Branch answer\n\n### Not a message heading", node_id=node["id"])
    store.record_turn(exp["id"], "Root again", "Second root answer")
    store.record_turn(exp["id"], None, ANSWER_WITH_HEADINGS, node_id=node["id"])

    root_conv = store.conversation(exp["id"], "root")
    assert [m["role"] for m in root_conv] == ["user", "assistant", "user", "assistant"]
    assert root_conv[1]["content"] == ANSWER_WITH_HEADINGS, "headings inside an answer are content"
    assert root_conv[3]["content"] == "Second root answer"
    assert root_conv[0]["metadata"] == {} and ex.MSG_HEADING_RE.match(f"### You · {root_conv[0]['timestamp']}")
    branch = store.conversation(exp["id"], node["id"])
    assert [m["content"] for m in branch] == ["Branch q", "Branch answer\n\n### Not a message heading", ANSWER_WITH_HEADINGS]

    body = store.body(exp["id"])
    # Root appends go before the first node section; the node section is at the end.
    assert body.index("Second root answer") < body.index(f"## Node {node['id']} · Try a file-first store")
    got = store.require(exp["id"])
    assert got["turns"] == 4
    by_id = {n["id"]: n for n in got["nodes"]}
    assert by_id["root"]["turns"] == 2 and by_id[node["id"]]["turns"] == 2
    assert by_id[node["id"]]["mode"] == "explore" and got["active_node"] == node["id"]


def test_v_now_file_loads_unchanged(tmp_path):
    d = tmp_path / ".hester" / "explore"
    d.mkdir(parents=True)
    path = d / "exp-0a0b0c0d.md"
    content = (
        "---\nid: exp-0a0b0c0d\nworkspace: /x\ntitle: Old one\nstatus: active\nseed: s\n"
        "origin:\n  kind: cockpit\n  ref: null\nsession_id: explore-exp-0a0b0c0d\nturns: 1\n"
        "created_at: '2026-09-20T10:00:00Z'\nupdated_at: '2026-09-20T10:00:00Z'\n"
        "last_touched_at: '2026-09-20T10:00:00Z'\narchived_at: null\nversion: 2\n---\n"
        "# Old one\n\n## Seed\n\ns\n\n## Log\n\n### You · 2026-09-20T10:00:00Z\n\nq\n\n"
        "### Hester · 2026-09-20T10:00:05Z\n\na\n"
    )
    path.write_text(content)
    store = ExplorationStore(tmp_path)
    exp = store.require("exp-0a0b0c0d")
    assert [n["id"] for n in exp["nodes"]] == ["root"]
    assert exp["nodes"][0]["label"] == "Old one" and exp["nodes"][0]["turns"] == 1
    assert exp["active_node"] == "root" and exp["serves"] == [] and exp["promoted"] == [] and exp["knowledge_path"] is None
    assert [m["content"] for m in store.conversation(exp["id"])] == ["q", "a"]
    # Deep D1: loading moves the flat file into its directory, byte for byte.
    moved = d / "exp-0a0b0c0d" / "exploration.md"
    assert not path.exists() and moved.read_text() == content, "migration moves, never rewrites"
    assert (d / "exp-0a0b0c0d" / "page.md").read_text() == ""


# ---------------------------------------------------------------- nodes, decisions


def test_add_rename_collapse_and_prune(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Tree"})
    a = store.add_node(exp["id"], "root", "Option A")
    b = store.add_node(exp["id"], "root", "Option B", kind="source_file")
    assert ex.NODE_ID_RE.match(a["id"]) and a["parent"] == "root" and b["kind"] == "source_file"
    store.record_turn(exp["id"], "q", "a", node_id=a["id"])
    store.rename_node(exp["id"], a["id"], "Option A (files)")
    assert f"## Node {a['id']} · Option A (files)" in store.body(exp["id"])
    assert store.conversation(exp["id"], a["id"])[0]["content"] == "q"
    store.set_collapsed(exp["id"], a["id"], True)
    assert store.node(exp["id"], a["id"])["collapsed"] is True

    store.rename_node(exp["id"], "root", "Renamed tree")
    got = store.require(exp["id"])
    assert got["title"] == "Renamed tree" and got["nodes"][0]["label"] == "Renamed tree"
    assert store.body(exp["id"]).startswith("# Renamed tree\n")

    node, decision = store.prune(exp["id"], b["id"])
    assert node["pruned"] is True
    assert decision["kind"] == "decision" and decision["parent"] == "root"
    assert decision["decision"] == {"text": "Pruned: Option B", "chosen": [], "pruned": [b["id"]], "reason": None}
    assert b["id"] in [n["id"] for n in store.nodes(exp["id"])], "a pruned node stays in the file"

    with pytest.raises(ExplorationError):
        store.prune(exp["id"], "root")
    with pytest.raises(ex.ExplorationNotFound):
        store.add_node(exp["id"], "n-deadbeef", "orphan")
    with pytest.raises(ExplorationError):
        store.add_node(exp["id"], "root", "  ")
    with pytest.raises(ExplorationError):
        store.record_turn(exp["id"], "q", "a", node_id=decision["id"])


def test_decision_with_and_without_reason(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Choose"})
    a = store.add_node(exp["id"], "root", "Files")
    b = store.add_node(exp["id"], "root", "Redis")
    plain = store.decide(exp["id"], {"text": "Go file-first", "chosen": [a["id"]], "pruned": [b["id"]]})
    assert plain["decision"]["reason"] is None and store.node(exp["id"], b["id"])["pruned"] is True
    reasoned = store.decide(exp["id"], {"text": "Keep a TTL cache", "reason": "cheap"})
    assert reasoned["decision"]["reason"] == "cheap"
    later = store.patch_node(exp["id"], plain["id"], {"reason": "nothing expires"})
    assert later["decision"]["reason"] == "nothing expires"
    with pytest.raises(ExplorationError):
        store.patch_node(exp["id"], a["id"], {"reason": "x"})
    with pytest.raises(ExplorationError):
        store.decide(exp["id"], {"text": ""})
    outline = store.outline(exp["id"])
    assert "Decision: Go file-first; chose: Files; pruned: Redis; reason: nothing expires" in outline
    assert "~~Redis~~ (pruned)" in outline


# ---------------------------------------------------------------- spikes


def test_spike_nodes_and_sync_status_mapping(tmp_path):
    ctx = Ctx(tmp_path)
    store = ctx.explorations()
    exp = store.create({"title": "Spiky"})
    spike = store.add_spike(exp["id"], {"prompt": "Prototype a file-first store"})
    assert spike["kind"] == "spike" and spike["spike"]["status"] == "pending" and spike["spike"]["timebox_min"] == 30
    assert spike["label"] == "Prototype a file-first store"
    with pytest.raises(ExplorationError):
        store.add_node(exp["id"], spike["id"], "child of a spike")

    task, _ = ctx.tasks().upsert({
        "title": "Spike: files", "status": "running",
        "origin": {"kind": "explore", "ref": f"{exp['id']}/{spike['id']}"},
    })
    for status, want in (("running", "running"), ("waiting", "running"), ("idle", "running"), ("queued", "running")):
        task["status"] = status
        node = spikes.sync(ctx, task)
        assert node["spike"]["status"] == want and node["spike"]["task_id"] == task["id"]
    assert node["spike"]["started_at"]

    task["status"] = "review"
    task["summary"] = "Store works; tests pass."
    assert spikes.sync(ctx, task)["spike"]["status"] == "review"
    kids = [n for n in store.nodes(exp["id"]) if n["parent"] == spike["id"]]
    assert len(kids) == 1 and kids[0]["kind"] == "evidence"
    ev = kids[0]["evidence"]
    assert ev["claim"] is True and ev["summary"] == "Store works; tests pass." and ev["diff_path"] is None, "no worktree: no diff"

    task["status"] = "discarded"
    node = spikes.sync(ctx, task)
    assert node["spike"]["status"] == "discarded" and node["spike"]["ended_at"]
    assert len([n for n in store.nodes(exp["id"]) if n["kind"] == "evidence"]) == 1, "one evidence node per spike"

    # Another task never takes over a spike, and junk never raises.
    other = dict(task, id="task-other")
    assert spikes.sync(ctx, other) is None
    assert spikes.sync(ctx, {"id": "task-x", "origin": {"kind": "explore", "ref": "garbage"}}) is None
    assert spikes.sync(ctx, {"id": "task-x", "origin": {"kind": "launcher"}}) is None
    assert spikes.sync(None, {"id": "task-x", "origin": {"kind": "explore", "ref": f"{exp['id']}/{spike['id']}"}}) is None


def test_spike_evidence_from_a_real_worktree(tmp_path):
    ws = tmp_path / "repo"
    ws.mkdir()
    git(ws, "init", "-q", "-b", "main")
    t0 = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    commit_file(ws, "a.txt", "one\n", "base", t0)
    wt = ws / ".claude" / "worktrees" / "spike1"
    git(ws, "worktree", "add", "-q", "-b", "worktree-spike1", str(wt))
    commit_file(wt, "b.txt", "new file\n", "add b", t0)
    (wt / "a.txt").write_text("one\ntwo (uncommitted)\n")
    (wt / "scratch.txt").write_text("untracked\n")
    commit_file(ws, "main-only.txt", "x\n", "main moves on", t0)

    ctx = Ctx(ws)
    store = ctx.explorations()
    exp = store.create({"title": "Worktree spike"})
    spike = store.add_spike(exp["id"], {"prompt": "Try it", "title": "Try"})
    worktree = {"slug": "spike1", "path": str(wt), "branch": "worktree-spike1"}
    task, _ = ctx.tasks().upsert({
        "title": "Spike: Try", "status": "running", "worktree": worktree,
        "origin": {"kind": "explore", "ref": f"{exp['id']}/{spike['id']}"},
    })
    assert task["worktree"] == worktree
    spikes.sync(ctx, task)
    assert store.node(exp["id"], spike["id"])["spike"]["worktree"] == worktree

    task.update({"status": "review", "files": [str(wt / "b.txt")], "lee_status": {"status": "done", "summary": "Added b"}})
    spikes.sync(ctx, task)
    ev = next(n for n in store.nodes(exp["id"]) if n["kind"] == "evidence")["evidence"]
    assert ev["summary"] == "Added b" and ev["lee_status"]["status"] == "done" and ev["claim"] is True
    assert ev["files"] == [str(wt / "b.txt")]
    assert len(ev["commits"]) == 1, "only the worktree's commit since the merge base"
    assert "a.txt" in ev["diffstat"] and "b.txt" in ev["diffstat"] and "main-only" not in ev["diffstat"]
    assert ev["untracked"] == ["scratch.txt"]
    diff_path = ws / ev["diff_path"]
    assert ev["diff_path"] == f".hester/explore/evidence/{exp['id']}-{spike['id']}.diff"
    diff = diff_path.read_text()
    assert "+two (uncommitted)" in diff and "+new file" in diff and "untracked\n" not in diff.split("\n", 2)[2]
    assert "scratch.txt" in diff.splitlines()[1], "untracked files are listed"
    assert stat.S_IMODE(os.stat(diff_path).st_mode) == 0o600

    # A later turn_end in review re-captures (replacing, not duplicating).
    commit_file(wt, "c.txt", "c\n", "add c", t0)
    spikes.sync(ctx, task)
    assert len(next(n for n in store.nodes(exp["id"]) if n["kind"] == "evidence")["evidence"]["commits"]) == 1, "no turn_end: no recapture"
    spikes.sync(ctx, task, turn_end=True)
    evs = [n for n in store.nodes(exp["id"]) if n["kind"] == "evidence"]
    assert len(evs) == 1 and len(evs[0]["evidence"]["commits"]) == 2

    # The outline carries the spike and its evidence.
    outline = store.outline(exp["id"])
    assert f"Spike [review]: Try (task {task['id']})" in outline and "Evidence (agent's claim): Added b" in outline


def test_follower_launch_links_spike_and_carries_worktree(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    ctx = Ctx(ws)
    exp = ctx.explorations().create({"title": "Follow"})
    spike = ctx.explorations().add_spike(exp["id"], {"prompt": "go"})
    ref = f"{exp['id']}/{spike['id']}"

    class Registry:
        def get(self, path, source="request"):
            return ctx

        def list(self):
            return [ctx]

    events = tmp_path / "events"
    now = datetime.now(timezone.utc).replace(microsecond=0)
    worktree = {"slug": "s1", "path": str(ws / ".claude" / "worktrees" / "s1"), "branch": "worktree-s1"}
    write_events(events, [
        make_event("task.launch", now, {
            "task_id": "task-spike1", "pty_id": 3, "session_id": "sess-1", "lead": "delegate", "kind": "prototype",
            "confirmed": True, "worktree": worktree, "origin_kind": "explore", "origin_ref": ref,
        }, workspace=str(ws)),
    ])
    follower = EventFollower(registry=Registry(), events_dir=events, state_file=tmp_path / "f.json", clock=lambda: now)
    asyncio.run(follower.tick())
    task = ctx.tasks().require("task-spike1")
    assert task["origin"] == {"kind": "explore", "ref": ref} and task["worktree"] == worktree
    node = ctx.explorations().node(exp["id"], spike["id"])
    assert node["spike"]["task_id"] == "task-spike1" and node["spike"]["status"] == "running"
    assert node["spike"]["worktree"] == worktree

    later = now + timedelta(seconds=1)
    write_events(events, [
        make_event("agent.session_end", later, {"session_id": "sess-1", "pty_id": 3}, workspace=str(ws)),
    ])
    asyncio.run(follower.tick())
    assert ctx.explorations().node(exp["id"], spike["id"])["spike"]["status"] == "review"
    assert any(n["kind"] == "evidence" for n in ctx.explorations().nodes(exp["id"]))


# ---------------------------------------------------------------- promotes


def _tree(ctx):
    store = ctx.explorations()
    exp = store.create({"title": "Durable explorations", "seed": "Files instead of Redis.", "serves": ["G2"]})
    a = store.add_node(exp["id"], "root", "File-first store")
    b = store.add_node(exp["id"], "root", "Redis with a longer TTL")
    store.record_turn(exp["id"], "does it scale?", "LONG TRANSCRIPT ANSWER", node_id=a["id"])
    store.decide(exp["id"], {"text": "Store", "chosen": [a["id"]], "pruned": [b["id"]], "reason": "nothing expires"})
    return store, exp, a, b


def test_promote_to_task(tmp_path):
    ctx = Ctx(tmp_path)
    store, exp, a, _ = _tree(ctx)
    out = asyncio.run(explore_ops.promote(ctx, exp["id"], {"to": "task"}))
    task = out["task"]
    assert task["title"] == "Durable explorations" and task["status"] == "queued" and task["lead"] == "delegate"
    assert task["kind"] == "unknown" and task["confirmed"] is True and task["serves"] == ["G2"]
    assert task["origin"] == {"kind": "explore", "ref": exp["id"]}
    note = ctx.tasks()._body(task["id"])
    assert "Decision: Store; chose: File-first store" in note and "LONG TRANSCRIPT ANSWER" not in note, "an outline, not a transcript"
    got = out["exploration"]
    assert got["status"] == "active" and got["promoted"][0]["to"] == "task" and got["promoted"][0]["ref"] == task["id"]
    assert any(n["kind"] == "decision" and n["decision"]["text"] == f"Promoted to task: {task['id']}" for n in got["nodes"])
    long = asyncio.run(explore_ops.promote(ctx, exp["id"], {"to": "task", "title": "x" * 200}))
    assert len(long["task"]["title"]) <= 80


def test_promote_to_workstream_with_decisions(tmp_path):
    ctx = Ctx(tmp_path)
    store, exp, a, b = _tree(ctx)
    out = asyncio.run(explore_ops.promote(ctx, exp["id"], {"to": "workstream", "node_ids": [a["id"]]}))
    ws = ctx.ws_store().get(out["workstream_id"])
    assert out["title"] == "Durable explorations" and out["phase"] == ws.phase.value
    assert ws.serves == ["G2"] and ws.brief.conversation_id == exp["id"]
    assert "File-first store" in ws.brief.objective and "Redis with a longer TTL" in ws.brief.objective, "the decision names both"
    assert "LONG TRANSCRIPT ANSWER" not in ws.brief.objective
    decisions = ws.design_doc.decisions
    assert len(decisions) == 1 and decisions[0].question == "Store"
    assert decisions[0].decision == "File-first store" and decisions[0].rationale == "nothing expires"
    assert out["exploration"]["promoted"][0]["node_ids"] == [a["id"]]


def test_promote_to_goal_draft(tmp_path):
    ctx = Ctx(tmp_path)
    goals = "# Goals\n\n### G1 One\n\ntext\n\n### G4 Four\n\n- **C1 Local.** x\n"
    (tmp_path / "GOALS.md").write_text(goals)
    store, exp, _, _ = _tree(ctx)
    out = asyncio.run(explore_ops.promote(ctx, exp["id"], {"to": "goal"}))
    assert out["draft_path"] == f".hester/goals/drafts/{exp['id']}.md"
    draft = (tmp_path / out["draft_path"]).read_text()
    assert "### G5 Durable explorations" in draft and "Files instead of Redis." in draft
    assert "- Store (chose: File-first store) (pruned: Redis with a longer TTL). nothing expires" in draft
    for field in ("- metric: **", "  - kind:", "  - signal:", "  - available:", "  - target:", "  - guard:"):
        assert field in draft
    assert (tmp_path / "GOALS.md").read_text() == goals, "GOALS.md is never touched"
    with pytest.raises(ExplorationError):
        asyncio.run(explore_ops.promote(ctx, exp["id"], {"to": "nope"}))
    with pytest.raises(ExplorationError):
        asyncio.run(explore_ops.promote(ctx, exp["id"], {"to": "task", "node_ids": ["n-deadbeef"]}))


# ---------------------------------------------------------------- escalate, archive, knowledge


def test_escalate_task(tmp_path):
    ctx = Ctx(tmp_path)
    task, _ = ctx.tasks().upsert({"title": "Flaky follower", "status": "running", "serves": ["G1"]})
    task["lee_status"] = {"status": "blocked", "summary": "Cursor resets on rotate"}
    task["files"] = [f"/w/f{i}.py" for i in range(25)]
    ctx.tasks().save(task)
    task, exp = explore_ops.escalate(ctx, task["id"])
    assert exp["title"] == "Flaky follower" and exp["origin"] == {"kind": "task", "ref": task["id"]} and exp["serves"] == ["G1"]
    seed = exp["seed"]
    assert seed.startswith("Flaky follower\n\n") and "(the agent's words): Cursor resets on rotate" in seed
    assert "/w/f19.py" in seed and "/w/f20.py" not in seed and "(+5 more)" in seed
    assert task["status"] == "running", "the task stays open"
    assert f"explore:{exp['id']}" in ctx.tasks()._body(task["id"])


def test_archive_as_knowledge_and_tool(tmp_path):
    ctx = Ctx(tmp_path)
    store, exp, a, b = _tree(ctx)
    store.record_turn(exp["id"], "root q", "ROOT FINAL " + "x" * 3000)
    store.record_turn(exp["id"], "b q", "PRUNED ANSWER", node_id=b["id"])
    plain = explore_ops.archive(ctx, exp["id"])
    assert plain["exploration"]["status"] == "archived" and "knowledge_path" not in plain
    out = explore_ops.archive(ctx, exp["id"], as_knowledge=True)
    rel = f".hester/knowledge/explore-{exp['id']}.md"
    assert out["knowledge_path"] == rel and out["exploration"]["knowledge_path"] == rel
    assert out["exploration"]["status"] == "archived"
    note = (tmp_path / rel).read_text()
    assert "# Durable explorations" in note and "Files instead of Redis." in note
    assert "Decision: Store" in note and "LONG TRANSCRIPT ANSWER" in note and "PRUNED ANSWER" not in note
    root_answer = note[note.index("ROOT FINAL"):].split("\n")[0]
    assert len(root_answer) <= 1500
    assert stat.S_IMODE(os.stat(tmp_path / rel).st_mode) == 0o600
    again = explore_ops.archive(ctx, exp["id"], as_knowledge=True)
    assert (tmp_path / rel).read_text() == note or again["knowledge_path"] == rel

    from hester.daemon.tools.cockpit_tools import knowledge_notes
    from hester.daemon.tools.definitions import COCKPIT_TOOLS, TOOL_CATEGORIES

    listed = asyncio.run(knowledge_notes(working_dir=str(tmp_path)))
    assert listed["success"] and listed["data"]["notes"][0]["name"] == f"explore-{exp['id']}"
    assert listed["data"]["notes"][0]["title"] == "Durable explorations" and listed["data"]["notes"][0]["archived_at"]
    one = asyncio.run(knowledge_notes(name=f"explore-{exp['id']}", working_dir=str(tmp_path)))
    assert one["success"] and one["data"]["content"] == note
    assert asyncio.run(knowledge_notes(name="../etc/passwd", working_dir=str(tmp_path)))["success"] is False
    assert asyncio.run(knowledge_notes(name="missing", working_dir=str(tmp_path)))["success"] is False
    assert "knowledge_notes" in [t.name for t in COCKPIT_TOOLS] and "knowledge_notes" in TOOL_CATEGORIES["cockpit"]


# ---------------------------------------------------------------- HTTP: cockpit routes


def test_cockpit_tree_routes(cockpit_env):
    env = cockpit_env
    c = env.client
    h = hdr(env.b)
    exp = c.post("/cockpit/explorations", headers=h, json={"title": "Routes"}).json()["data"]
    assert exp["nodes"][0]["id"] == "root" and exp["active_node"] == "root" and exp["serves"] == []
    eid = exp["id"]
    r = c.post(f"/cockpit/explorations/{eid}/nodes", headers=h, json={"parent": "root", "label": "A", "mode": "learn"})
    assert r.status_code == 201, r.text
    a = r.json()["data"]
    assert c.post(f"/cockpit/explorations/{eid}/nodes", headers=h, json={"parent": "n-deadbeef", "label": "x"}).status_code == 404
    r = c.patch(f"/cockpit/explorations/{eid}/nodes/{a['id']}", headers=h, json={"label": "A2", "collapsed": True})
    assert r.json()["data"]["label"] == "A2" and r.json()["data"]["collapsed"] is True
    r = c.post(f"/cockpit/explorations/{eid}/decisions", headers=h, json={"text": "Pick A"})
    assert r.status_code == 201 and r.json()["data"]["decision"]["reason"] is None
    dec = r.json()["data"]
    r = c.patch(f"/cockpit/explorations/{eid}/nodes/{dec['id']}", headers=h, json={"reason": "later"})
    assert r.json()["data"]["decision"]["reason"] == "later"
    b = c.post(f"/cockpit/explorations/{eid}/nodes", headers=h, json={"parent": "root", "label": "B"}).json()["data"]
    r = c.post(f"/cockpit/explorations/{eid}/nodes/{b['id']}/prune", headers=h, json={})
    assert r.status_code == 200 and r.json()["data"]["node"]["pruned"] is True
    assert r.json()["data"]["decision"]["decision"]["pruned"] == [b["id"]]
    r = c.post(f"/cockpit/explorations/{eid}/spikes", headers=h, json={"parent": a["id"], "prompt": "try A", "timebox_min": 15})
    assert r.status_code == 201 and r.json()["data"]["spike"]["timebox_min"] == 15
    sp = r.json()["data"]
    r = c.patch(f"/cockpit/explorations/{eid}/spikes/{sp['id']}", headers=h, json={"task_id": "task-abc", "status": "running"})
    assert r.json()["data"]["spike"]["task_id"] == "task-abc" and r.json()["data"]["spike"]["started_at"]
    assert c.patch(f"/cockpit/explorations/{eid}/spikes/{sp['id']}", headers=h, json={"status": "bogus"}).status_code == 400
    r = c.patch(f"/cockpit/explorations/{eid}", headers=h, json={"serves": ["G2"]})
    assert r.json()["data"]["serves"] == ["G2"]

    one = c.get(f"/cockpit/explorations/{eid}", headers=h).json()["data"]
    kinds = {n["id"]: n for n in one["nodes"]}
    assert kinds["root"]["conversation"] == [] and kinds[a["id"]]["conversation"] == []
    assert "conversation" not in kinds[dec["id"]] and "conversation" not in kinds[sp["id"]]

    r = c.post(f"/cockpit/explorations/{eid}/promote", headers=h, json={"to": "task"})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["task"]["origin"] == {"kind": "explore", "ref": eid}
    r = c.post(f"/cockpit/explorations/{eid}/promote", headers=h, json={"to": "workstream"})
    assert r.json()["data"]["workstream_id"] and r.json()["data"]["phase"]
    r = c.post(f"/cockpit/explorations/{eid}/promote", headers=h, json={"to": "goal"})
    assert r.json()["data"]["draft_path"].startswith(".hester/goals/drafts/")
    r = c.post(f"/cockpit/explorations/{eid}/archive", headers=h, json={"as_knowledge": True})
    assert r.status_code == 200 and r.json()["data"]["knowledge_path"] == f".hester/knowledge/explore-{eid}.md"
    assert (env.b / r.json()["data"]["knowledge_path"]).exists()


def test_escalate_route_and_relay_links_spike(cockpit_env):
    env = cockpit_env
    c = env.client
    h = hdr(env.b)
    task = c.post("/cockpit/tasks", headers=h, json={"workspace": str(env.b), "title": "Hard bug"}).json()["data"]
    r = c.post(f"/cockpit/tasks/{task['id']}/escalate", headers=h, json={})
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["exploration"]["origin"] == {"kind": "task", "ref": task["id"]} and data["task"]["status"] == "queued"
    assert c.post("/cockpit/tasks/task-missing/escalate", headers=h, json={}).status_code == 404

    eid = data["exploration"]["id"]
    sp = c.post(f"/cockpit/explorations/{eid}/spikes", headers=h, json={"prompt": "repro"}).json()["data"]
    worktree = {"slug": "x", "path": "/nowhere", "branch": "worktree-x"}
    relayed = c.post("/cockpit/tasks", headers=h, json={
        "workspace": str(env.b), "title": "Spike: repro", "status": "running", "lead": "delegate", "kind": "prototype",
        "origin": {"kind": "explore", "ref": f"{eid}/{sp['id']}"}, "worktree": worktree,
    }).json()["data"]
    assert relayed["worktree"] == worktree and relayed["origin"]["kind"] == "explore"
    node = next(n for n in c.get(f"/cockpit/explorations/{eid}", headers=h).json()["data"]["nodes"] if n["id"] == sp["id"])
    assert node["spike"]["task_id"] == relayed["id"] and node["spike"]["status"] == "running"
    c.post(f"/cockpit/tasks/{relayed['id']}/close", headers=h, json={"status": "discarded"})
    nodes = c.get(f"/cockpit/explorations/{eid}", headers=h).json()["data"]["nodes"]
    assert next(n for n in nodes if n["id"] == sp["id"])["spike"]["status"] == "discarded"
    assert any(n["kind"] == "evidence" and n["parent"] == sp["id"] for n in nodes)


# ---------------------------------------------------------------- HTTP: the Library


def test_library_routes_shapes(cockpit_env):
    env = cockpit_env
    c = env.client
    h = hdr(env.b)
    r = c.post("/library/sessions", headers=h, json={"title": "Library tree", "working_directory": "."})
    assert r.status_code == 200, r.text
    created = r.json()
    sid = created["session_id"]
    assert ex.EXP_ID_RE.match(sid) and created["root_id"] == "root" and set(created["nodes"]) == {"root"}
    assert (env.b / ".hester" / "explore" / sid / "exploration.md").exists()
    assert ExplorationStore(env.b).require(sid)["origin"] == {"kind": "library", "ref": None}

    listed = c.get("/library/sessions", headers=h).json()
    assert listed["count"] == 1 and listed["sessions"][0]["session_id"] == sid
    assert set(listed["sessions"][0]) == {"session_id", "title", "node_count", "created_at", "last_activity"}
    assert c.get("/library/sessions", headers=hdr(env.a)).json()["count"] == 0, "per workspace"

    r = c.post(f"/library/sessions/{sid}/nodes", headers=h, json={"parent_id": "root", "label": "Branch", "agent_mode": "learn"})
    assert r.status_code == 200, r.text
    nid = r.json()["node_id"]
    assert r.json()["node"]["agent_mode"] == "learn" and r.json()["node"]["parent_id"] == "root"
    assert c.post(f"/library/sessions/{sid}/nodes", headers=h, json={"parent_id": "n-deadbeef", "label": "x"}).status_code == 404
    r = c.patch(f"/library/sessions/{sid}/nodes/{nid}", headers=h, json={"label": "Branch 2"})
    assert r.json() == {"success": True, "node_id": nid, "label": "Branch 2"}

    store = ExplorationStore(env.b)
    store.record_turn(sid, "q?", "an answer", node_id=nid)
    store.decide(sid, {"text": "Decide it"})
    got = c.get(f"/library/sessions/{sid}", headers=h).json()
    assert got["session_id"] == sid and got["root_id"] == "root" and got["active_node_id"] == nid
    root, branch = got["nodes"]["root"], got["nodes"][nid]
    assert root["children"][0] == nid and len(root["children"]) == 2
    expected = {"id", "parent_id", "label", "node_type", "agent_mode", "conversation_history", "children",
                "collapsed", "created_at", "pruned", "kind"}
    assert expected <= set(branch)
    assert branch["conversation_history"][0]["role"] == "user" and branch["conversation_history"][1]["content"] == "an answer"
    dec = next(n for n in got["nodes"].values() if n["kind"] == "decision")
    assert dec["node_type"] == "decision" and dec["decision"]["text"] == "Decide it"

    r = c.post(f"/library/sessions/{sid}/save", headers=h, json={"node_id": nid})
    assert r.json()["success"] is True
    items = c.get(f"/someday?workspace={env.b}&status=open", headers=SHARED).json()["data"]
    item = next(i for i in items if i["id"] == r.json()["idea_id"])
    assert item["as"] == "explore" and item["source"]["surface"] == "lee" and "an answer" in item["text"]

    r = c.post(f"/library/sessions/{sid}/promote-to-workstream", headers=h, json={"node_ids": [nid]})
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"workstream_id", "title", "phase"}
    assert store.require(sid)["promoted"][0]["to"] == "workstream"

    r = c.delete(f"/library/sessions/{sid}", headers=h)
    assert r.json() == {"status": "archived", "session_id": sid}
    assert (env.b / ".hester" / "explore" / sid / "exploration.md").exists() and store.require(sid)["status"] == "archived"
    assert c.get("/library/sessions", headers=h).json()["count"] == 0
    assert c.get("/library/sessions/exp-00000000", headers=h).status_code == 404
    assert c.get("/library/sessions/not-an-id", headers=h).status_code == 404


def _sse(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        out.append((lines.get("event"), json.loads(lines.get("data", "null"))))
    return out


def test_library_chat_writes_back_to_the_file(cockpit_env, monkeypatch):
    env = cockpit_env
    c = env.client
    h = hdr(env.b)
    calls = []

    class Agent:
        async def process_context(self, request, phase_callback=None):
            calls.append(request)
            return SimpleNamespace(status="success", response="Stubbed answer\n\n## Heading inside", trace=None)

    mgr = InMemorySessionManager(ttl_seconds=60)
    monkeypatch.setattr(ex, "_session_manager_getter", lambda: mgr)
    env.main.app.dependency_overrides[env.main.get_agent] = lambda: Agent()
    try:
        sid = c.post("/library/sessions", headers=h, json={"title": "Chatty"}).json()["session_id"]
        nid = c.post(f"/library/sessions/{sid}/nodes", headers=h,
                     json={"parent_id": "root", "label": "Branch", "agent_mode": "explore"}).json()["node_id"]
        ExplorationStore(env.b).record_turn(sid, "earlier", "EARLIER ANSWER", node_id=nid)
        r = c.post(f"/library/sessions/{sid}/nodes/{nid}/chat", headers=h, json={"message": "What next?"})
        assert r.status_code == 200, r.text
        events = _sse(r.text)
        assert [e for e, _ in events][-2:] == ["response", "done"]
        assert events[-2][1]["text"] == "Stubbed answer\n\n## Heading inside" and events[-2][1]["node_id"] == nid

        req = calls[0]
        assert req.session_id == f"library-{sid}-{nid}" and req.message.startswith("@idea_explorer [Exploration context: Chatty")
        session = asyncio.run(mgr.get(req.session_id))
        system = [m.content for m in session.conversation_history if m.role == "system"]
        assert any("EARLIER ANSWER" in m for m in system), "seeded from the file"

        conv = ExplorationStore(env.b).conversation(sid, nid)
        assert [m["content"] for m in conv] == ["earlier", "EARLIER ANSWER", "What next?", "Stubbed answer\n\n## Heading inside"]
        got = c.get(f"/library/sessions/{sid}", headers=h).json()
        assert len(got["nodes"][nid]["conversation_history"]) == 4

        r = c.post(f"/library/sessions/{sid}/synthesize", headers=h, json={"action": "summarize", "node_ids": [nid]})
        events = _sse(r.text)
        assert events[0][0] == "node_created"
        new_id = events[0][1]["node_id"]
        assert ExplorationStore(env.b).conversation(sid, new_id)[-1]["content"].startswith("Stubbed answer")

        dec = ExplorationStore(env.b).decide(sid, {"text": "no chat here"})
        assert c.post(f"/library/sessions/{sid}/nodes/{dec['id']}/chat", headers=h, json={"message": "x"}).status_code == 400
    finally:
        env.main.app.dependency_overrides.pop(env.main.get_agent, None)
