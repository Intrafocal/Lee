"""Copilot v4 review fixes: steward tool allow-list, draft base, model failures, parser shapes,
snapshot inputs, goal status windows, proposals store, steer classifier, local due dates,
pull_usage, follower fold, steward sessions."""

import asyncio
import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from hester.daemon.cockpit import goal_status, steward, steward_routes
from hester.daemon.cockpit import tasks as tasks_mod
from hester.daemon.cockpit.tasks import CockpitTaskStore, derive
from hester.daemon.copilot import metrics

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import make_event, write_events
from .test_goals_v4 import MINI_GOALS, iso, record, write_lines

WRITE_TOOLS = {
    "write_markdown", "update_markdown", "ui_control", "status_message", "change_directory",
    "devops_start_service", "devops_stop_service", "devops_compose_up", "devops_compose_down",
    "devops_compose_build", "devops_compose_rebuild", "git_add", "git_commit",
    "create_task", "update_task", "delete_task", "add_batch", "add_context", "mark_task_ready",
    "create_context_bundle", "refresh_context_bundle", "add_bundle_source", "redis_delete_key",
    "workstream_create", "workstream_set_brief", "workstream_advance_to_design",
    "lee_tab_checkin", "lee_operation_run", "lee_operation_propose", "generate_image", "web_search",
}


# ---------------------------------------------------------------- 1. read-only tools


def test_steward_tools_are_read_only_and_real():
    from hester.daemon.tools.definitions import get_available_tools

    names = {t.name for t in get_available_tools("daemon")}
    assert set(steward.STEWARD_TOOLS) <= names
    assert not set(steward.STEWARD_TOOLS) & WRITE_TOOLS
    assert {"read_file", "search_content", "cockpit_tasks", "knowledge_notes", "semantic_doc_search"} <= set(steward.STEWARD_TOOLS)


def test_effective_tool_filter_only_narrows():
    from hester.daemon.agent import effective_tool_filter

    allow = list(steward.STEWARD_TOOLS)
    assert effective_tool_filter(None, None) is None
    assert effective_tool_filter(["write_markdown"], None) == ["write_markdown"]
    assert effective_tool_filter(["write_markdown", "read_file"], allow) == ["read_file"]
    assert effective_tool_filter(["write_markdown"], allow) == allow
    assert effective_tool_filter(None, allow) == allow


def test_steward_request_declares_no_write_tools():
    from hester.daemon.agent import effective_tool_filter
    from hester.daemon.tools.definitions import get_available_tools
    from hester.shared.react.capability import ReActCapability

    fake = SimpleNamespace(_tool_definitions=[
        {"name": t.name, "description": t.description, "parameters": t.parameters} for t in get_available_tools("daemon")
    ])
    everything = ReActCapability._build_tool_declarations(fake, tool_filter=None)
    all_names = {d.name for d in everything[0].function_declarations}
    assert {"write_markdown", "update_markdown", "ui_control"} <= all_names  # the unrestricted set has them
    prepared = ["write_markdown", "update_markdown", "devops_start_service", "read_file", "ui_control"]
    decl = ReActCapability._build_tool_declarations(fake, tool_filter=effective_tool_filter(prepared, list(steward.STEWARD_TOOLS)))
    names = {d.name for d in decl[0].function_declarations}
    assert names == {"read_file"}
    decl = ReActCapability._build_tool_declarations(fake, tool_filter=effective_tool_filter(None, list(steward.STEWARD_TOOLS)))
    names = {d.name for d in decl[0].function_declarations}
    assert names == set(steward.STEWARD_TOOLS) and not names & WRITE_TOOLS


def test_agent_refuses_tools_outside_the_allowlist_at_call_time():
    from hester.daemon import agent as agent_mod
    from hester.daemon.agent import HesterDaemonAgent

    ran = []

    async def handler(**kw):
        ran.append(kw)
        return {"ok": True}

    fake = object.__new__(HesterDaemonAgent)
    fake._tool_handlers = {"write_markdown": handler, "read_file": handler}

    async def go():
        token = agent_mod._TOOL_ALLOWLIST.set(frozenset(steward.STEWARD_TOOLS))
        try:
            bad = await fake._execute_tool("write_markdown", {"path": "GOALS.md"})
            good = await fake._execute_tool("read_file", {"path": "x"})
        finally:
            agent_mod._TOOL_ALLOWLIST.reset(token)
        free = await fake._execute_tool("write_markdown", {"path": "y"})
        return bad, good, free

    bad, good, free = asyncio.run(go())
    assert bad.success is False and "not available" in bad.error
    assert good.success is True and free.success is True
    assert ran == [{"path": "x"}, {"path": "y"}]


def test_process_context_scopes_the_allowlist_to_the_request():
    from hester.daemon import agent as agent_mod
    from hester.daemon.agent import HesterDaemonAgent

    seen = []

    async def inner(request, phase_callback=None):
        seen.append(agent_mod._TOOL_ALLOWLIST.get())
        return "ok"

    fake = SimpleNamespace(_process_context=inner)
    asyncio.run(HesterDaemonAgent.process_context(fake, SimpleNamespace(surface="what-next", tool_allowlist=["read_file"])))
    asyncio.run(HesterDaemonAgent.process_context(fake, SimpleNamespace(surface="palette", tool_allowlist=None)))
    assert seen == [frozenset({"read_file"}), None]
    assert agent_mod._TOOL_ALLOWLIST.get() is None


# ---------------------------------------------------------------- endpoint stub


@pytest.fixture
def stub(cockpit_env, monkeypatch):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(MINI_GOALS)
    goal_status.invalidate()
    now = datetime.now(timezone.utc)
    write_lines(env.a, [record(env.a, now - timedelta(days=7), peek_rate=2.0), record(env.a, now - timedelta(minutes=1), peek_rate=1.0)])
    monkeypatch.setattr(goal_status, "run_metrics", lambda *a: None)

    calls, deleted = [], []
    state = {"reply": "Answer.", "status": "complete", "during": None, "raise": None}

    class Sessions:
        async def delete(self, sid):
            deleted.append(sid)
            return True

    class FakeAgent:
        sessions = Sessions()

        async def process_context(self, request, phase_callback=None):
            calls.append(request)
            if state["during"]:
                state["during"]()
            if state["raise"]:
                raise state["raise"]
            return SimpleNamespace(status=state["status"], response=state["reply"])

    monkeypatch.setattr(steward, "_agent_provider", lambda: FakeAgent())

    async def fake_digest(ctx):
        return {"top_line": "0 wins", "wins": [], "agent_claims": [], "waiting": [], "q2_candidates": [], "retro": None}

    monkeypatch.setattr(steward_routes, "digest_for", fake_digest)
    env.calls, env.state, env.deleted = calls, state, deleted
    return env


def test_steward_call_passes_the_allowlist_and_drops_its_session(stub):
    env = stub
    r = env.client.post("/cockpit/what-next", headers=hdr(env.a), json={})
    assert r.status_code == 200, r.text
    [req] = env.calls
    assert req.tool_allowlist == list(steward.STEWARD_TOOLS)
    assert env.deleted == [req.session_id] and req.session_id.startswith("steward-st-")
    # dropped on failure too
    env.state["reply"] = ""
    env.client.post("/cockpit/what-next", headers=hdr(env.a), json={})
    assert env.deleted[-1] == env.calls[-1].session_id and len(env.deleted) == 2


# ---------------------------------------------------------------- 2. draft base


def test_draft_base_is_the_text_the_model_saw(stub):
    env = stub
    goals = env.a / "GOALS.md"
    new = MINI_GOALS.replace("### G2 Managed", "### G2 Well managed")
    env.state["reply"] = f"Renamed.\n\n```markdown\n{new}```\n"
    env.state["during"] = lambda: goals.write_text(MINI_GOALS + "\nEdited meanwhile.\n")
    r = env.client.post("/cockpit/goals/draft", headers=hdr(env.a), json={"instruction": "rename G2"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    # the diff is against what the model saw, so the concurrent edit is not in it
    assert "Edited meanwhile" not in data["diff"] and "+### G2 Well managed" in data["diff"]
    r = env.client.post(f"/cockpit/goals/draft/{data['draft_id']}/apply", headers=hdr(env.a), json={})
    assert r.status_code == 409
    assert goals.read_text().endswith("Edited meanwhile.\n")


# ---------------------------------------------------------------- 3. model failures


@pytest.mark.parametrize("status,reply", [
    ("complete", "I encountered an error: 429 quota"),
    ("complete", "An unexpected error occurred: boom"),
    ("max_iterations", None),
    ("complete", ""),
    ("complete", "   "),
    ("error", "bad"),
    ("complete", "I couldn't generate a response. Please try rephrasing your question."),
])
def test_model_failures_are_502_and_save_nothing(stub, status, reply):
    env = stub
    env.state.update(status=status, reply=reply)
    h = hdr(env.a)
    for path, body in [
        ("/cockpit/what-next", {}),
        ("/cockpit/goals/G1/evaluate", {}),
        ("/cockpit/goals/draft", {"instruction": "tighten G1"}),
        ("/cockpit/ask", {"question": "why?"}),
    ]:
        r = env.client.post(path, headers=h, json=body)
        assert r.status_code == 502, (path, r.text)
        assert r.json()["success"] is False and "Hester couldn't answer" in r.json()["error"]
    hester = env.a / ".hester"
    assert not (hester / "goals" / "evaluations").exists()
    assert not (hester / "goals" / "drafts").exists()
    assert not (hester / "cockpit" / "proposals.jsonl").exists()


def test_unexpected_exception_is_a_clean_502(stub, caplog):
    env = stub
    env.state["raise"] = RuntimeError("kaboom secret detail")
    r = env.client.post("/cockpit/what-next", headers=hdr(env.a), json={})
    assert r.status_code == 502
    body = r.json()
    assert body["success"] is False and "kaboom" not in body["error"]
    assert any("kaboom" in (rec.exc_text or "") or "kaboom" in rec.getMessage() or rec.exc_info for rec in caplog.records)


def test_model_failure_helper():
    assert steward.model_failure("complete", "Fine.") is None
    assert steward.model_failure("complete", "I encountered an error: x") == "error"
    assert steward.model_failure("max_iterations", None) == "ran out of steps"
    assert steward.model_failure("complete", None) == "empty answer"


# ---------------------------------------------------------------- 4. lee-proposals shapes


def _parse(block):
    return steward.parse_proposals(f"Text.\n```lee-proposals\n{block}\n```")[1]


def test_proposals_block_style_yaml_list():
    props = _parse(
        "- label: Spike the cache\n"
        "  action: create_task\n"
        "  params:\n"
        "    title: Spike the cache\n"
        "    serves: [G1]\n"
        "- label: Park it\n"
        "  action: park\n"
        "  params:\n"
        "    text: later\n"
    )
    assert [p["action"] for p in props] == ["create_task", "park"]
    assert props[0]["params"] == {"title": "Spike the cache", "serves": ["G1"]}


def test_proposals_json_list():
    props = _parse(json.dumps([
        {"label": "Launch", "action": "launch", "params": {"prompt": "Try: defer mDNS", "lead": "delegate"}},
        {"label": "Open G1", "action": "open", "params": {"kind": "goal", "id": "G1"}},
        "not a dict",
    ]))
    assert [p["action"] for p in props] == ["launch", "open"]
    assert props[0]["params"]["prompt"] == "Try: defer mDNS"


def test_proposals_unquoted_colons():
    props = _parse(
        "- {label: Spike: defer mDNS, action: create_task, params: {title: Spike: defer mDNS start, lead: delegate}}\n"
        "- {label: Park, action: park, params: {text: note: revisit after v4}}\n"
        "- label: Explore: what if\n"
        "  action: explore\n"
        "  params:\n"
        "    seed: what if: no daemon\n"
    )
    assert [p["action"] for p in props] == ["create_task", "park", "explore"]
    assert props[0]["label"] == "Spike: defer mDNS"
    assert props[0]["params"] == {"title": "Spike: defer mDNS start", "lead": "delegate"}
    assert props[1]["params"] == {"text": "note: revisit after v4"}
    assert props[2]["label"] == "Explore: what if" and props[2]["params"] == {"seed": "what if: no daemon"}


def test_proposals_malformed_and_cap():
    assert _parse("[{unclosed") == []
    assert _parse("- {label: x, action: rm_rf, params: {}}\n- ]]]\n- {: :}") == []
    assert _parse("just: a scalar mapping") == []
    many = json.dumps([{"label": f"P{i}", "action": "park", "params": {"text": str(i)}} for i in range(9)])
    assert [p["label"] for p in _parse(many)] == ["P0", "P1", "P2", "P3", "P4"]
    block = "\n".join(f"- label: P{i}\n  action: park\n  params:\n    text: t: {i}" for i in range(8))
    assert len(_parse(block)) == 5


# ---------------------------------------------------------------- 5. snapshot inputs, derived reads


def test_snapshot_version_moves_with_goals_and_date(cockpit_env, monkeypatch):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    v = c.get("/cockpit/snapshot", headers=h).json()["data"]["version"]
    assert c.get("/cockpit/snapshot", headers=h, params={"since_version": v}).json()["data"] == {"unchanged": True, "version": v}
    (env.a / "GOALS.md").write_text(MINI_GOALS)
    snap = c.get("/cockpit/snapshot", headers=h, params={"since_version": v}).json()["data"]
    assert "unchanged" not in snap and snap["version"] == v + 1
    v = snap["version"]
    assert c.get("/cockpit/snapshot", headers=h, params={"since_version": v}).json()["data"]["unchanged"] is True
    tomorrow = datetime.now(timezone.utc) + timedelta(days=1)
    monkeypatch.setattr(tasks_mod, "utc_now", lambda: tomorrow)
    snap = c.get("/cockpit/snapshot", headers=h, params={"since_version": v}).json()["data"]
    assert "unchanged" not in snap and snap["version"] == v + 1


def test_task_reads_recompute_due_urgency(cockpit_env, monkeypatch):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    due = (datetime.now().astimezone() + timedelta(days=5)).date().isoformat()
    t, _ = CockpitTaskStore(env.a).upsert({"title": "Due later", "due": due})
    assert t["urgency"] is None
    later = datetime.now(timezone.utc) + timedelta(days=4)
    monkeypatch.setattr(tasks_mod, "utc_now", lambda: later)
    [row] = c.get("/cockpit/tasks", headers=h).json()["data"]
    assert row["urgency"] == {"signal": "due", "ref": due} and row["quadrant"] == "Q3"
    one = c.get(f"/cockpit/tasks/{t['id']}", headers=h).json()["data"]
    assert one["urgency"]["signal"] == "due"


# ---------------------------------------------------------------- 6. goal status windows


def _window_record(ws, ts, days, **m):
    r = record(ws, ts, **m)
    r["from"] = iso(ts - timedelta(days=days))
    return r


def test_status_uses_the_requested_window(tmp_path, monkeypatch):
    ws = (tmp_path / "ws")
    ws.mkdir()
    ws = ws.resolve()
    (ws / "GOALS.md").write_text(MINI_GOALS)
    goal_status.invalidate()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    write_lines(ws, [
        _window_record(ws, now - timedelta(days=8), 7, peek_rate=5.0),
        _window_record(ws, now - timedelta(days=2), 7, peek_rate=4.0),
        _window_record(ws, now - timedelta(minutes=10), 7, peek_rate=3.0),
        _window_record(ws, now - timedelta(days=2), 30, peek_rate=9.0),
    ])
    calls = []

    def fake_run(start, end, workspace):
        calls.append(end - start)
        return _window_record(Path(workspace), end, (end - start).days, peek_rate=8.0)

    monkeypatch.setattr(goal_status, "run_metrics", fake_run)
    s7 = goal_status.build_status(ws, 7, now)
    peek = s7["goals"][0]["metrics"][0]
    # the 2-day-old record is under half a window older: previous is the 8-day-old one
    assert calls == [] and peek["value"] == 3.0 and peek["previous"] == 5.0 and peek["trend"] == "down"
    s30 = goal_status.build_status(ws, 30, now)
    assert calls == [timedelta(days=30)]
    peek = s30["goals"][0]["metrics"][0]
    # the new 30-day record; the 2-day-old 30-day record is too recent to be previous
    assert peek["value"] == 8.0 and peek["previous"] is None and peek["trend"] is None
    assert s30["record_at"] == iso(now)


def test_status_previous_needs_half_a_window(tmp_path, monkeypatch):
    ws = (tmp_path / "ws")
    ws.mkdir()
    ws = ws.resolve()
    (ws / "GOALS.md").write_text(MINI_GOALS)
    goal_status.invalidate()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    write_lines(ws, [record(ws, now - timedelta(hours=2), peek_rate=2.0), record(ws, now - timedelta(minutes=1), peek_rate=1.0)])
    monkeypatch.setattr(goal_status, "run_metrics", lambda *a: None)
    peek = goal_status.build_status(ws, 7, now)["goals"][0]["metrics"][0]
    assert peek["value"] == 1.0 and peek["previous"] is None and peek["trend"] is None


# ---------------------------------------------------------------- 7. proposals store


def test_proposals_store_trims_and_is_thread_safe(tmp_path):
    store = steward.ProposalStore(tmp_path, max_rows=50)
    now = datetime.now(timezone.utc)

    def write(n):
        for i in range(20):
            store.record_answer({"request_id": f"st-{n}-{i}", "surface": "what-next", "text": "x" * 200,
                                 "proposals": [], "steer": None}, {}, now)

    threads = [threading.Thread(target=write, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    lines = store.path.read_text().splitlines()
    assert len(lines) == 50 and all(json.loads(line)["kind"] == "answer" for line in lines)
    assert steward.MAX_PROPOSAL_ROWS == 2000


def test_goal_edit_stores_explanation_not_the_goals_file(stub):
    env = stub
    new = MINI_GOALS.replace("### G2 Managed", "### G2 Well managed")
    env.state["reply"] = f"Renamed G2.\n\n```markdown\n{new}```\n"
    r = env.client.post("/cockpit/goals/draft", headers=hdr(env.a), json={"instruction": "rename G2"})
    assert r.status_code == 200
    [row] = [json.loads(x) for x in (env.a / ".hester" / "cockpit" / "proposals.jsonl").read_text().splitlines()]
    assert row["surface"] == "goal-edit" and row["text"] == "Renamed G2." and "### G1" not in json.dumps(row)


# ---------------------------------------------------------------- 8. classifier


@pytest.mark.parametrize("q,want", [
    ("Starting…?", "ask"), ("Stopwatch?", "ask"), ("Waiting on what?", "ask"), ("starting over is it?", "ask"),
    ("stop now", "steer"), ("wait", "steer"), ("keep going on the tests", "steer"), ("Stop.", "steer"),
    ("continuous integration is red", "ask"), ("please add a test", "steer"), ("don't touch the schema", "steer"),
    ("stop?", "ask"), ("should it stop?", "ask"), ("keep going?", "ask"),
    ("can you tell it to add tests?", "steer"), ("Tell it to check the logs?", "steer"),
    ("could you ask the agent to summarise?", "steer"), ("nowhere near done?", "ask"), ("now run the tests", "steer"),
])
def test_classify_word_boundaries_and_questions(q, want):
    live = {"status": "running", "agent": {"pty_id": 4}}
    assert steward.classify(q, "task", live) == want


# ---------------------------------------------------------------- 9. local due date


def test_due_within_a_day_uses_the_local_date(monkeypatch):
    now = datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc)  # 2026-09-26 20:00 at UTC-7
    task = {"status": "queued", "due": "2026-09-28"}
    monkeypatch.setattr(tasks_mod, "LOCAL_TZ", timezone(timedelta(hours=-7)))
    assert derive(task, [], now)["urgency"] is None
    assert derive({**task, "due": "2026-09-27"}, [], now)["urgency"] == {"signal": "due", "ref": "2026-09-27"}
    monkeypatch.setattr(tasks_mod, "LOCAL_TZ", timezone.utc)
    assert derive(task, [], now)["urgency"] == {"signal": "due", "ref": "2026-09-28"}


# ---------------------------------------------------------------- 10. pull_usage


def test_pull_usage_counts_user_steward_requests(tmp_path):
    start = datetime(2026, 9, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=14)
    surfaces = ["what-next", "evaluate", "rail-ask", "goal-edit", "palette", "tui"]
    events = [make_event("steward.request", start + timedelta(days=i + 1), {"surface": s}, workspace="/w")
              for i, s in enumerate(surfaces)]
    events.append(make_event("steward.request", end + timedelta(hours=1), {"surface": "what-next"}, workspace="/w"))
    write_events(tmp_path / "ev", events)
    rec = metrics.run(start, end, workspace="/w", events_dir=tmp_path / "ev", now=end + timedelta(days=1), task_workspaces=[])
    m = rec["metrics"]
    assert rec["formula_version"] == metrics.FORMULA_VERSION == 6
    assert m["pull_requests"] == 4 and m["pull_usage"] == 2.0
    assert m["pull_usage_by_surface"] == {"evaluate": 1, "goal-edit": 1, "rail-ask": 1, "what-next": 1}
    status = goal_status.metric_status({"name": "pull_usage", "kind": "runnable", "target": {"direction": "rising"}},
                                       [rec], [], end, 14)
    assert status["value"] == 2.0 and status["source"] == "metrics"


# ---------------------------------------------------------------- 11. follower fold


def test_fold_carries_files_at_first_report(tmp_path, monkeypatch):
    from .test_follower import Env, tick

    env = Env(tmp_path, monkeypatch)
    E = env.ev
    env.write(
        E("agent.session_start", 0, {"session_id": "s1", "pty_id": 5, "cwd": str(env.a)}),
        E("agent.prompt", 0.1, {"session_id": "s1", "pty_id": 5}),
        E("agent.tool", 0.5, {"session_id": "s1", "pty_id": 5, "tool": "Edit", "phase": "post", "writes": True,
                              "files": ["src/a.py"]}),
        E("agent.turn_end", 1, {"session_id": "s1", "pty_id": 5, "busy_ms": 5000,
                                "lee_status": {"status": "in-progress", "summary": "Working"}}),
    )
    f = env.follower()
    tick(f)
    [auto] = env.tasks().values()
    assert auto["files_at_first_report"] == 1
    env.write(
        E("task.launch", 2, {"task_id": "task-abc12345", "pty_id": 5, "session_id": "s1", "provider": "claude",
                             "lead": "delegate", "kind": "bug", "confirmed": True, "origin_kind": "launcher"}),
    )
    tick(f)
    tasks = env.tasks()
    assert list(tasks) == ["task-abc12345"]
    assert tasks["task-abc12345"]["files_at_first_report"] == 1
