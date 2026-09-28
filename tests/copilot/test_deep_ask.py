"""Deep D1 (contract section 6): deep-ask, the background runner behind Ask."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from hester.daemon.cockpit import deep, deep_ask, steward
from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.cockpit.explorations import ExplorationStore
from hester.daemon.copilot import metrics, model_log

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued

STEWARD_MARK = "You are also the user's steward"
PAGE = "# Intro\n\nSome opening words.\n\n## Sync\n\nThe vector clock only helps if every write carries one.\n"


class FakeAgent:
    """Records each ContextRequest and the trigger it ran under; answers with ``reply``."""

    def __init__(self, reply="The answer.", gate=None, fail=False):
        self.reply, self.gate, self.fail = reply, gate, fail
        self.requests, self.triggers = [], []
        self.in_flight = self.max_in_flight = 0

    async def process_context(self, request, phase_callback=None):
        self.requests.append(request)
        self.triggers.append(model_log.get_trigger())
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.gate is not None:
                await self.gate.wait()
            model_log.record_model_call(provider="gemini", model="gemini-2.5-flash", op="generate", location="cloud", ok=True)
            if self.fail:
                return SimpleNamespace(status="error", response="I encountered an error: boom")
            return SimpleNamespace(status="complete", response=self.reply)
        finally:
            self.in_flight -= 1


def make_ctx(ws: Path):
    return SimpleNamespace(path=ws, lock=asyncio.Lock(), explorations=lambda: ExplorationStore(ws))


def seeded(ws: Path):
    store = ExplorationStore(ws)
    exp = store.create({"seed": "Mesh sync without a server", "page": PAGE})
    return store, exp


def anchor(quote="vector clock"):
    return {"kind": "page", "quote": quote, "offset": PAGE.index(quote), "section": "Sync"}


@pytest.fixture
def agent(monkeypatch):
    fake = FakeAgent()
    monkeypatch.setattr(steward, "_agent_provider", lambda: fake)
    return fake


# ---------------------------------------------------------------- context


def test_context_order_and_cap(tmp_path):
    store, exp = seeded(tmp_path)
    q = deep.add_question(store, exp["id"], {"text": "Does it survive partitions?", "source": "page"})
    deep.add_reference(store, exp["id"], {"kind": "link", "url": "https://crdt.tech", "title": "CRDTs"})
    first = deep.new_answer(store, exp["id"], {"question": "What's a vector clock?", "anchor": anchor()})
    deep.update_answer(store, exp["id"], first["id"], {"status": "done", "answer": "A causality counter."})
    follow = deep.new_answer(store, exp["id"], {"question": "And why every write?", "anchor": anchor(), "follow_up_of": first["id"]})
    text = deep_ask.context_for(store, exp["id"], follow)
    order = ["### Exploration", "Mesh sync without a server", "### Where the question was asked", "Section: Sync",
             "### The Page", "### Open questions", q["text"], "### References kept", "https://crdt.tech",
             "### This follows up", "A causality counter."]
    at = [text.index(s) for s in order]
    assert at == sorted(at), text

    # The cap holds, and the Page is what gets cut, keeping the anchor's neighbourhood.
    big = "filler line\n" * 5000 + PAGE + "tail line\n" * 5000
    ans = {"anchor": {"kind": "page", "quote": "vector clock", "offset": big.index("vector clock"), "section": "Sync"}}
    capped = deep_ask.build_context(store.require(exp["id"]), big, ans, [])
    assert len(capped) <= deep_ask.CONTEXT_CAP and "vector clock only helps" in capped
    assert capped.index("### Exploration") < capped.index("### The Page")
    # no anchor: the Page is cut from the far end
    none = deep_ask.build_context(store.require(exp["id"]), big, {"anchor": {"kind": "none"}}, [])
    assert len(none) <= deep_ask.CONTEXT_CAP and "filler line" in none and "tail line" not in none


def test_locate_picks_the_occurrence_nearest_offset():
    page = "x a x a x a"
    assert deep_ask.locate(page, "a", 9) == 10 and deep_ask.locate(page, "a", 0) == 2
    assert deep_ask.locate(page, "zzz", 3) is None and deep_ask.locate(page, "", 3) is None


def test_deep_ask_is_never_a_steer_surface():
    assert deep_ask.SURFACE not in steward.STEER_SURFACES
    assert STEWARD_MARK not in steward.prompt_layer(deep_ask.SURFACE, "CTX", active=True)
    assert "deep-ask" in metrics.PULL_SURFACES and metrics.FORMULA_VERSION == 6


# ---------------------------------------------------------------- runner


def test_queued_running_done(tmp_path, agent, isolated_copilot):
    store, exp = seeded(tmp_path)
    ans = deep.new_answer(store, exp["id"], {"question": "", "anchor": anchor()})
    assert ans["status"] == "queued" and ans["question"] == "Explain this."
    seen = {}

    async def go():
        ctx = make_ctx(tmp_path)
        gate = asyncio.Event()
        agent.gate = gate
        runner = deep_ask.DeepAskRunner()
        runner.schedule(deep_ask.Job(ctx, exp["id"], ans["id"], {"kind": "user", "surface": "deep-ask"}))
        await asyncio.sleep(0.05)
        seen["mid"] = deep.get_answer(store, exp["id"], ans["id"])["status"]
        gate.set()
        await runner.drain()

    asyncio.run(go())
    assert seen["mid"] == "running"
    done = deep.get_answer(store, exp["id"], ans["id"])
    assert done["status"] == "done" and done["answer"] == "The answer." and done["answered_at"]
    assert done["model"] == {"location": "cloud", "name": "gemini-2.5-flash"}
    [req] = agent.requests
    assert req.surface == "deep-ask" and req.message == "Explain this."
    assert req.steward_context.startswith(deep_ask.INSTRUCTION) and "vector clock" in req.steward_context
    assert STEWARD_MARK not in steward.prompt_layer_for_request(req, str(tmp_path)), "steward.md is never layered"
    assert agent.triggers == [{"kind": "user", "surface": "deep-ask"}], "the request's trigger is re-entered in the task"
    ev = [e for e in queued(isolated_copilot) if e["type"] == "deep.answer"]
    assert [{k: e["data"][k] for k in ("workspace", "exploration_id", "answer_id", "status")} for e in ev] == [
        {"workspace": str(tmp_path), "exploration_id": exp["id"], "answer_id": ans["id"], "status": "done"}
    ]
    calls = [e for e in queued(isolated_copilot) if e["type"] == "model.call"]
    assert calls and calls[0]["data"]["trigger"] == {"kind": "user", "surface": "deep-ask"}


def test_error_is_recorded(tmp_path, agent, isolated_copilot):
    agent.fail = True
    store, exp = seeded(tmp_path)
    ans = deep.new_answer(store, exp["id"], {"question": "Why?", "anchor": {"kind": "none"}})

    async def go():
        runner = deep_ask.DeepAskRunner()
        runner.schedule(deep_ask.Job(make_ctx(tmp_path), exp["id"], ans["id"], {"kind": "user", "surface": "deep-ask"}))
        await runner.drain()

    asyncio.run(go())
    row = deep.get_answer(store, exp["id"], ans["id"])
    assert row["status"] == "error" and 0 < len(row["error"]) <= deep.MAX_ERROR and "answer" not in row
    assert [e["data"]["status"] for e in queued(isolated_copilot) if e["type"] == "deep.answer"] == ["error"]


def test_concurrency_capped_at_two_fifo(tmp_path, agent):
    store, exp = seeded(tmp_path)
    ids = [deep.new_answer(store, exp["id"], {"question": f"q{i}", "anchor": {"kind": "none"}})["id"] for i in range(5)]

    async def go():
        ctx = make_ctx(tmp_path)
        agent.gate = asyncio.Event()
        runner = deep_ask.DeepAskRunner()
        for aid in ids:
            runner.schedule(deep_ask.Job(ctx, exp["id"], aid, {"kind": "user", "surface": "deep-ask"}))
        await asyncio.sleep(0.05)
        statuses = [deep.get_answer(store, exp["id"], a)["status"] for a in ids]
        agent.gate.set()
        await runner.drain()
        return statuses, runner

    statuses, runner = asyncio.run(go())
    assert statuses == ["running", "running", "queued", "queued", "queued"]
    assert agent.max_in_flight == 2 and max(runner.max_seen.values()) == 2
    assert [r.message for r in agent.requests] == ["q0", "q1", "q2", "q3", "q4"], "FIFO"
    assert all(deep.get_answer(store, exp["id"], a)["status"] == "done" for a in ids)


def test_restart_interrupts_and_retry_requeues(tmp_path, agent):
    store, exp = seeded(tmp_path)
    a = deep.new_answer(store, exp["id"], {"question": "a", "anchor": {"kind": "none"}})
    b = deep.new_answer(store, exp["id"], {"question": "b", "anchor": {"kind": "none"}})
    deep.update_answer(store, exp["id"], b["id"], {"status": "running"})
    done = deep.new_answer(store, exp["id"], {"question": "c", "anchor": {"kind": "none"}})
    deep.update_answer(store, exp["id"], done["id"], {"status": "done", "answer": "x"})

    async def go():
        ctx = make_ctx(tmp_path)
        runner = deep_ask.DeepAskRunner()  # a fresh process
        n = await runner.ensure_recovered(ctx)
        again = await runner.ensure_recovered(ctx)
        return n, again

    assert asyncio.run(go()) == (2, 0)
    assert [deep.get_answer(store, exp["id"], x["id"])["status"] for x in (a, b, done)] == ["interrupted", "interrupted", "done"]
    assert ExplorationStore(tmp_path).require(exp["id"])["answers_pending"] == 0

    with pytest.raises(deep.ExplorationError):
        deep.requeue_answer(store, exp["id"], done["id"])
    row = deep.requeue_answer(store, exp["id"], a["id"])
    assert row["status"] == "queued"

    async def retry():
        runner = deep_ask.DeepAskRunner()
        runner.schedule(deep_ask.Job(make_ctx(tmp_path), exp["id"], a["id"], {"kind": "user", "surface": "deep-ask"}))
        await runner.drain()

    asyncio.run(retry())
    assert deep.get_answer(store, exp["id"], a["id"])["status"] == "done"


# ---------------------------------------------------------------- routes


def test_ask_route_validates_and_returns_202(cockpit_env, agent, isolated_copilot, monkeypatch):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    scheduled = []
    monkeypatch.setattr(deep_ask.get_runner(), "schedule", lambda job: scheduled.append(job))
    area = c.get("/desk", headers=h).json()["data"]["areas"][0]["id"]
    card = c.post("/desk/pages", headers=h, json={"area_id": area, "title": "Mesh", "text": PAGE}).json()["data"]["card"]["id"]
    base = f"/desk/pages/{card}"

    assert c.post(f"{base}/asks", headers=h, json={"question": "x" * 2001, "anchor": {"kind": "none"}}).status_code == 400
    assert c.post(f"{base}/asks", headers=h, json={"question": "q"}).status_code == 400, "anchor is required"
    assert c.post(f"{base}/asks", headers=h, json={"question": "q", "anchor": {"kind": "page"}}).status_code == 400
    assert c.post("/desk/pages/pg-00000000/asks", headers=h, json={"question": "q", "anchor": {"kind": "none"}}).status_code == 404

    r = c.post(f"{base}/asks", headers=h, json={"question": "What's a vector clock?", "anchor": anchor()})
    assert r.status_code == 202, r.text
    ans = r.json()["data"]
    assert ans["status"] == "queued" and ans["surface"] == "deep-ask" and ans["anchor"]["section"] == "Sync"
    [job] = scheduled
    assert job.answer_id == ans["id"] and job.exp_id == card
    assert job.trigger["kind"] == "user" and job.trigger["surface"] == "deep-ask"
    ev = [e for e in queued(isolated_copilot) if e["type"] == "steward.request"]
    assert [(e["data"]["surface"], e["data"]["about_kind"]) for e in ev] == [("deep-ask", "exploration")]

    listed = c.get(f"{base}/answers", headers=h).json()["data"]
    assert [a["id"] for a in listed] == [ans["id"]]
    assert c.get(base, headers=h).json()["data"]["summary"]["answers_pending"] == 1

    # retry only an errored or interrupted answer
    assert c.post(f"{base}/answers/{ans['id']}/retry", headers=h).status_code == 400
    deep.update_answer(DeskStore(env.a).pages, card, ans["id"], {"status": "error", "error": "boom"})
    r = c.post(f"{base}/answers/{ans['id']}/retry", headers=h)
    assert r.status_code == 202 and r.json()["data"]["status"] == "queued" and "error" not in r.json()["data"]
    assert len(scheduled) == 2

    # PATCH flags
    deep.update_answer(DeskStore(env.a).pages, card, ans["id"], {"status": "done", "answer": "A"})
    r = c.patch(f"{base}/answers/{ans['id']}", headers=h, json={"read": True, "kept": True})
    assert r.status_code == 200 and r.json()["data"]["read_at"] and r.json()["data"]["kept_at"]
    assert c.patch(f"{base}/answers/{ans['id']}", headers=h, json={"answer": "mine"}).status_code == 400
    assert c.patch(f"{base}/answers/ans-00000000", headers=h, json={"read": True}).status_code == 404
