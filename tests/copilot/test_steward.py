"""Copilot v4 steward: layering, proposals, steer, classification, endpoints (model stubbed)."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from hester.daemon.cockpit import goal_status, steward, steward_routes
from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.copilot import model_log

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued
from .test_goals_v4 import MINI_GOALS, record

STEWARD_MARK = "You are also the user's steward"


# ---------------------------------------------------------------- the prompt file


def test_steward_md_is_the_appendix_verbatim():
    contract = (Path(__file__).resolve().parents[2] / "docs" / "plans" / "2026-09-26-copilot-v4-contracts.md").read_text()
    start = contract.index("````markdown\n## Steward") + len("````markdown\n")
    end = contract.index("\n````", start)
    assert steward.PROMPT_PATH.read_text() == contract[start:end] + "\n"
    assert steward.steward_prompt().startswith("## Steward")


# ---------------------------------------------------------------- layering


@pytest.mark.parametrize("surface", sorted(steward.STEER_SURFACES))
def test_layer_on_steer_surfaces(surface):
    layer = steward.prompt_layer(surface, "CTX", active=True)
    assert STEWARD_MARK in layer and layer.endswith("CTX")
    assert layer.index(STEWARD_MARK) < layer.index("CTX")
    off = steward.prompt_layer(surface, "CTX", active=False)
    assert STEWARD_MARK not in off and "CTX" in off


@pytest.mark.parametrize("surface", ["rail-ask", "palette", "tui", None, "http"])
def test_layer_never_on_other_surfaces(surface):
    assert STEWARD_MARK not in steward.prompt_layer(surface, "CTX", active=True)


def test_rail_steer_instruction_even_when_off():
    assert "lee-steer" in steward.prompt_layer("rail-steer", None, active=False)
    assert "lee-steer" not in steward.prompt_layer("rail-ask", None, active=True)


def test_layer_for_request_follows_config_and_not_today(cockpit_env):
    env = cockpit_env
    req = SimpleNamespace(surface="what-next", steward_context="CTX")
    assert STEWARD_MARK in steward.prompt_layer_for_request(req, str(env.a))
    # not today
    steward.set_not_today(env.a, {}, True)
    assert STEWARD_MARK not in steward.prompt_layer_for_request(req, str(env.a))
    steward.set_not_today(env.a, {}, False)
    assert STEWARD_MARK in steward.prompt_layer_for_request(req, str(env.a))
    # config off (YAML reads `off` as False)
    (env.a / ".lee").mkdir()
    (env.a / ".lee" / "config.yaml").write_text("hester:\n  steward: off\n")
    assert STEWARD_MARK not in steward.prompt_layer_for_request(req, str(env.a))
    assert "CTX" in steward.prompt_layer_for_request(req, str(env.a))
    assert steward.prompt_layer_for_request(SimpleNamespace(surface=None, steward_context=None), str(env.a)) == ""


def test_config_enabled_values():
    assert steward.config_enabled({}) is True
    assert steward.config_enabled({"hester": {"steward": False}}) is False
    assert steward.config_enabled({"hester": {"steward": "off"}}) is False
    assert steward.config_enabled({"hester": {"steward": "on"}}) is True
    assert steward.config_enabled({"hester": {"steward": True}}) is True


def test_not_today_lasts_until_local_midnight(tmp_path):
    now = datetime.now(timezone.utc)
    s = steward.set_not_today(tmp_path, {}, True, now)
    until = datetime.fromisoformat(s["not_today_until"].replace("Z", "+00:00"))
    local = until.astimezone()
    assert (local.hour, local.minute) == (0, 0) and now < until <= now + timedelta(days=1, hours=1)
    assert s["active"] is False and s["enabled"] is True
    assert steward.state(tmp_path, {}, until + timedelta(seconds=1))["active"] is True
    assert json.loads((tmp_path / ".hester" / "cockpit" / "steward.json").read_text())["not_today_until"]


def test_agent_system_prompt_gets_layer_only_for_steer_surfaces(cockpit_env):
    from hester.daemon.agent import HesterDaemonAgent
    from hester.daemon.models import ContextRequest, EditorState

    env = cockpit_env
    fake = SimpleNamespace(
        _build_editor_context=lambda session: "",
        _get_prompt_from_registry=lambda **kw: "BASE PROMPT",
    )
    prepare = SimpleNamespace(relevant_tools=["read_file"], prompt_id="general")

    def system_prompt(surface):
        req = ContextRequest(session_id="s", message="hi", surface=surface, steward_context="THE CONTEXT",
                             editor_state=EditorState(working_directory=str(env.a)))
        layer = HesterDaemonAgent._steward_layer(req, str(env.a))
        return HesterDaemonAgent._build_system_prompt(fake, SimpleNamespace(working_directory=str(env.a)), prepare_result=prepare, extra_layer=layer)

    for surface in steward.STEER_SURFACES:
        p = system_prompt(surface)
        assert p.startswith("BASE PROMPT") and STEWARD_MARK in p and p.endswith("THE CONTEXT")
    for surface in ("rail-ask", "palette", "tui"):
        p = system_prompt(surface)
        assert STEWARD_MARK not in p and "THE CONTEXT" in p


def test_process_context_sets_trigger_surface():
    from hester.daemon.agent import HesterDaemonAgent

    seen = {}

    async def inner(self, request, phase_callback=None):
        seen["trigger"] = model_log.get_trigger()
        return "ok"

    fake = SimpleNamespace(_process_context=lambda request, phase_callback=None: inner(None, request, phase_callback))
    import asyncio

    token = model_log.set_trigger("user", surface="http", request_path="/cockpit/what-next")
    try:
        asyncio.run(HesterDaemonAgent.process_context(fake, SimpleNamespace(surface="what-next")))
        assert seen["trigger"] == {"kind": "user", "surface": "what-next", "request_path": "/cockpit/what-next"}
        asyncio.run(HesterDaemonAgent.process_context(fake, SimpleNamespace(surface=None)))
        assert seen["trigger"]["surface"] == "http"
    finally:
        model_log.reset_trigger(token)
    assert model_log.get_trigger() == {"kind": "unknown"}


# ---------------------------------------------------------------- blocks


def test_parse_proposals_valid_and_malformed():
    text = """Do the spike.

```lee-proposals
- {label: "Spike: defer mDNS start", action: create_task, params: {title: "Defer mDNS", serves: [G1], lead: delegate, kind: prototype}}
- {label: "Launch it", action: launch, params: {prompt: "Try deferring mDNS", lead: delegate}}
- {label: "Link", action: link_goal, params: {task_id: task-abc, serves: G2}}
- {label: "Bad lead", action: set_lead, params: {task_id: task-abc, lead: boss}}
- {label: "Unknown", action: rm_rf, params: {}}
- {label: "Missing params", action: run_op}
- not yaml: [: {
- {label: "Open", action: open, params: {kind: goal, id: G1, extra: 1}}
- {label: "Park", action: park, params: {text: "later"}}
- {label: "Explore", action: explore, params: {seed: "what if"}}
```
"""
    clean, props = steward.parse_proposals(text, origin={"kind": "goal-eval", "ref": "G1"})
    assert clean == "Do the spike."
    assert [p["action"] for p in props] == ["create_task", "launch", "link_goal", "open", "park"]  # capped at 5
    assert props[0]["params"] == {"title": "Defer mDNS", "serves": ["G1"], "lead": "delegate", "kind": "prototype",
                                  "origin": {"kind": "goal-eval", "ref": "G1"}}
    assert "origin" not in props[1]["params"]
    assert props[2]["params"] == {"task_id": "task-abc", "serves": ["G2"]}
    assert props[3]["params"] == {"kind": "goal", "id": "G1"}
    assert all(steward.PROPOSAL_ID_RE.match(p["id"]) for p in props)
    assert len({p["id"] for p in props}) == 5


def test_parse_proposals_none_and_garbage():
    assert steward.parse_proposals("Just text.") == ("Just text.", [])
    clean, props = steward.parse_proposals("A\n```lee-proposals\ngarbage\n- 42\n- [1, 2]\n```")
    assert clean == "A" and props == []
    # unterminated block still parses
    _, props = steward.parse_proposals('x\n```lee-proposals\n- {label: P, action: park, params: {text: t}}\n')
    assert [p["action"] for p in props] == ["park"]


def test_parse_steer():
    clean, text = steward.parse_steer("Tell it to stop.\n\n```lee-steer\nPlease stop and summarise.\n```\n")
    assert clean == "Tell it to stop." and text == "Please stop and summarise."
    assert steward.parse_steer("no block") == ("no block", None)
    assert steward.parse_steer("```lee-steer\n\n```")[1] is None
    assert len(steward.parse_steer("```lee-steer\n" + "x" * 3000 + "\n```")[1]) == 2000


# ---------------------------------------------------------------- classification


def test_classify_ask_vs_steer():
    live = {"status": "running", "agent": {"pty_id": 4}}
    dead = {"status": "running", "agent": {"pty_id": None}}
    closed = {"status": "done", "agent": {"pty_id": 4}}
    assert steward.classify("keep going", "task", live) == "steer"
    assert steward.classify("  Tell the agent to add tests", "tile", live) == "steer"
    assert steward.classify("Don't touch the schema", "task", live) == "steer"
    assert steward.classify("now run the tests", "task", live) == "steer"
    assert steward.classify("nowhere near done?", "task", live) == "ask"
    assert steward.classify("why is this slow?", "task", live) == "ask"
    assert steward.classify("keep going", "task", dead) == "ask"
    assert steward.classify("keep going", "task", closed) == "ask"
    assert steward.classify("keep going", "exploration", live) == "ask"
    assert steward.classify("stop", "task", None) == "ask"


# ---------------------------------------------------------------- endpoints


@pytest.fixture
def stub(cockpit_env, monkeypatch):
    """A fake agent: records each ContextRequest and answers with ``reply``."""
    env = cockpit_env
    (env.a / "GOALS.md").write_text(MINI_GOALS)
    goal_status.invalidate()
    now = datetime.now(timezone.utc)
    lines = [record(env.a, now - timedelta(days=7), peek_rate=2.0), record(env.a, now - timedelta(minutes=1), peek_rate=1.0)]
    p = env.a / ".hester" / "goals" / "metrics.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(json.dumps(line) + "\n" for line in lines))
    monkeypatch.setattr(goal_status, "run_metrics", lambda *a: None)

    calls = []
    state = {"reply": "Answer."}

    class FakeAgent:
        async def process_context(self, request, phase_callback=None):
            calls.append(request)
            return SimpleNamespace(status="complete", response=state["reply"])

    monkeypatch.setattr(steward, "_agent_provider", lambda: FakeAgent())

    async def fake_digest(ctx):
        return {"top_line": "0 wins", "wins": [], "agent_claims": [], "waiting": [], "q2_candidates": [], "retro": None}

    monkeypatch.setattr(steward_routes, "digest_for", fake_digest)
    env.calls, env.state = calls, state
    return env


def test_what_next(stub, isolated_copilot):
    env = stub
    store = CockpitTaskStore(env.a)
    store.upsert({"title": "Important thing", "serves": ["G1"]})
    env.state["reply"] = 'Do the important thing.\n```lee-proposals\n- {label: "Go", action: park, params: {text: "x"}}\n```'
    r = env.client.post("/cockpit/what-next", headers=hdr(env.a), json={})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["text"] == "Do the important thing." and data["surface"] == "what-next"
    assert data["request_id"].startswith("st-") and data["steer"] is None and len(data["proposals"]) == 1
    assert "raw" not in data
    [req] = env.calls
    assert req.surface == "what-next" and req.editor_state.working_directory == str(env.a)
    assert "Important thing" in req.steward_context and "Goal status" in req.steward_context
    # the agent would layer steward.md for this request
    assert STEWARD_MARK in steward.prompt_layer_for_request(req, str(env.a))
    ev = [e for e in queued(isolated_copilot) if e["type"] == "steward.request"]
    assert [e["data"]["surface"] for e in ev] == ["what-next"]
    rows = (env.a / ".hester" / "cockpit" / "proposals.jsonl").read_text().splitlines()
    assert json.loads(rows[0])["proposals"][0]["id"] == data["proposals"][0]["id"]


def test_evaluate_packet_file_and_goal_eval_origin(stub):
    env = stub
    store = CockpitTaskStore(env.a)
    t, _ = store.upsert({"title": "Cut peeks", "serves": ["G1"]})
    env.state["reply"] = 'On track.\n```lee-proposals\n- {label: "Spike", action: create_task, params: {title: "Spike"}}\n```'
    r = env.client.post("/cockpit/goals/G1/evaluate", headers=hdr(env.a), json={})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["surface"] == "evaluate" and data["text"] == "On track."
    assert data["proposals"][0]["params"]["origin"] == {"kind": "goal-eval", "ref": "G1"}
    packet = data["packet"]
    assert packet["goal"]["id"] == "G1" and [m["name"] for m in packet["goal"]["metrics"]] == ["peek_rate", "human_balance", "weekly_retro"]
    peek = packet["metrics"][0]
    assert peek["value"] == 1.0 and [h["value"] for h in peek["history"]] == [2.0, 1.0]
    assert [x["id"] for x in packet["serving"]["tasks"]] == [t["id"]]
    assert packet["focus_ms_7d"] == 0 and "q2_candidates" in packet and "commits" in packet
    assert data["stale_measure"] is None
    path = env.a / data["evaluation_path"]
    assert path.name.startswith("G1-") and "On track." in path.read_text() and '"peek_rate"' in path.read_text()
    [req] = env.calls
    assert req.surface == "evaluate" and "Evidence packet for G1" in req.steward_context
    # last_evaluated_at now set
    s = goal_status.build_status(env.a, 7)
    assert s["goals"][0]["last_evaluated_at"]
    # stale measure: G2's lost_threads has measure op:count-lost and no reading
    r = env.client.post("/cockpit/goals/G2/evaluate", headers=hdr(env.a), json={"packet_only": True})
    assert r.json()["data"]["stale_measure"] == "count-lost" and r.json()["data"]["text"] == ""
    assert len(env.calls) == 1  # packet_only runs no model
    assert env.client.post("/cockpit/goals/G7/evaluate", headers=hdr(env.a), json={}).status_code == 404


def test_task_suggest(stub):
    env = stub
    store = CockpitTaskStore(env.a)
    t, _ = store.upsert({"title": "Mine", "serves": ["G1"]})
    other, _ = store.upsert({"title": "Sibling", "serves": ["G1"]})
    store.upsert({"title": "Unrelated"})
    r = env.client.post(f"/cockpit/tasks/{t['id']}/suggest", headers=hdr(env.a), json={})
    assert r.status_code == 200 and r.json()["data"]["surface"] == "launch-suggest"
    ctx = env.calls[0].steward_context
    assert "Sibling" in ctx and "Unrelated" not in ctx and '"G2"' in ctx
    assert env.client.post("/cockpit/tasks/task-nope0000/suggest", headers=hdr(env.a), json={}).status_code == 404


def test_ask_steer_rail_and_lint(stub, isolated_copilot):
    env = stub
    store = CockpitTaskStore(env.a)
    t, _ = store.upsert({"title": "Agent task", "status": "running", "agent": {"pty_id": 7, "tab_label": "Claude 1"}})
    env.state["reply"] = "Sure.\n```lee-steer\nPlease wrap up and summarise.\n```"
    c, h = env.client, hdr(env.a)
    r = c.post("/cockpit/ask", headers=h, json={"question": "tell it to wrap up", "about": {"kind": "task", "id": t["id"]}})
    data = r.json()["data"]
    assert data["surface"] == "rail-steer" and data["text"] == "Sure."
    assert data["steer"] == {"task_id": t["id"], "pty_id": 7, "text": "Please wrap up and summarise."}
    assert "Claude 1" in env.calls[-1].steward_context

    # a tile by pty id
    r = c.post("/cockpit/ask", headers=h, json={"question": "keep going", "about": {"kind": "tile", "id": "7"}})
    assert r.json()["data"]["surface"] == "rail-steer" and r.json()["data"]["steer"]["task_id"] == t["id"]

    env.state["reply"] = "It's slow because X."
    r = c.post("/cockpit/ask", headers=h, json={"question": "why is it slow?", "about": {"kind": "task", "id": t["id"]}})
    assert r.json()["data"]["surface"] == "rail-ask" and r.json()["data"]["steer"] is None

    r = c.post("/cockpit/ask", headers=h, json={
        "question": "should I fix this?", "about": {"kind": "lint", "id": "d1", "record": {"rule": "commit/large-diff"}},
    })
    assert r.json()["data"]["surface"] == "lint-ask" and "commit/large-diff" in env.calls[-1].steward_context

    r = c.post("/cockpit/ask", headers=h, json={"question": "how is it going?", "about": {"kind": "goal", "id": "G1"}})
    assert r.json()["data"]["surface"] == "rail-ask" and "peek_rate" in env.calls[-1].steward_context

    assert c.post("/cockpit/ask", headers=h, json={"about": {"kind": "task", "id": t["id"]}}).status_code == 400
    assert c.post("/cockpit/ask", headers=h, json={"question": "q", "about": {"kind": "nope", "id": "x"}}).status_code == 400
    assert c.post("/cockpit/ask", headers=h, json={"question": "q", "about": {"kind": "task", "id": "task-nope0000"}}).status_code == 404
    surfaces = [e["data"]["surface"] for e in queued(isolated_copilot) if e["type"] == "steward.request"]
    assert surfaces == ["rail-steer", "rail-steer", "rail-ask", "lint-ask", "rail-ask"]


def test_steward_on_off_route(stub, isolated_copilot):
    env = stub
    c, h = env.client, hdr(env.a)
    r = c.get("/cockpit/steward", headers=h)
    assert r.json()["data"] == {"enabled": True, "not_today_until": None, "active": True}
    r = c.post("/cockpit/steward", headers=h, json={"not_today": True})
    d = r.json()["data"]
    assert d["active"] is False and d["not_today_until"] and d["enabled"] is True
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "steward.quiet"]
    assert ev["data"]["not_today"] is True and ev["data"]["until"] == d["not_today_until"]
    # inactive: steer surfaces still answer, without steward.md
    c.post("/cockpit/what-next", headers=h, json={})
    assert STEWARD_MARK not in steward.prompt_layer_for_request(env.calls[-1], str(env.a))
    assert c.post("/cockpit/steward", headers=h, json={"not_today": False}).json()["data"]["active"] is True
    assert c.post("/cockpit/steward", headers=h, json={"not_today": "yes"}).status_code == 400


def test_proposal_outcome(stub, isolated_copilot):
    env = stub
    env.state["reply"] = 'x\n```lee-proposals\n- {label: "P", action: park, params: {text: "t"}}\n```'
    pid = env.client.post("/cockpit/what-next", headers=hdr(env.a), json={}).json()["data"]["proposals"][0]["id"]
    r = env.client.post(f"/cockpit/proposals/{pid}/outcome", headers=hdr(env.a), json={"outcome": "accepted"})
    assert r.status_code == 200 and r.json()["data"]["outcome"] == "accepted" and r.json()["data"]["action"] == "park"
    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "proposal.outcome"]
    assert ev["data"]["proposal_id"] == pid and ev["data"]["outcome"] == "accepted" and ev["data"]["surface"] == "what-next"
    assert env.client.post(f"/cockpit/proposals/{pid}/outcome", headers=hdr(env.a), json={"outcome": "meh"}).status_code == 400
    assert env.client.post("/cockpit/proposals/prop-00000000/outcome", headers=hdr(env.a), json={"outcome": "dismissed"}).status_code == 404


def test_agent_not_ready(stub, monkeypatch):
    monkeypatch.setattr(steward, "_agent_provider", lambda: None)
    assert stub.client.post("/cockpit/what-next", headers=hdr(stub.a), json={}).status_code == 503
