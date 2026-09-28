"""Copilot v3: Explore absorbs the Library (contracts 2026-09-26-copilot-v3 §1-§8)."""

import asyncio
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from hester.daemon.cockpit import explore_ops, spikes
from hester.daemon.cockpit import explorations as ex
from hester.daemon.cockpit.explorations import ExplorationError, ExplorationStore
from hester.daemon.cockpit.follower import EventFollower
from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.workstream.store import WorkstreamStore

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


# ---------------------------------------------------------------- archive, knowledge


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
