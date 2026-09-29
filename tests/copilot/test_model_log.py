import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import models as genai_models

from hester.daemon.copilot import lee_events, model_log

from .conftest import queued


@pytest.fixture
def fake_genai(monkeypatch):
    """Replace the genai methods with local fakes, then install the wrapper over them."""
    calls = []

    def generate_content(self, *, model, contents, config=None):
        calls.append(("generate", model))
        return {"text": "ok"}

    def embed_content(self, *, model, contents, config=None):
        calls.append(("embed", model))
        raise RuntimeError("quota")

    def generate_content_stream(self, *, model, contents, config=None):
        calls.append(("stream", model))
        yield "a"
        yield "b"

    async def agenerate_content(self, *, model, contents, config=None):
        calls.append(("agenerate", model))
        return {"text": "ok"}

    async def agenerate_content_stream(self, *, model, contents, config=None):
        async def gen():
            yield "x"
        return gen()

    monkeypatch.setattr(genai_models.Models, "generate_content", generate_content)
    monkeypatch.setattr(genai_models.Models, "embed_content", embed_content)
    monkeypatch.setattr(genai_models.Models, "generate_content_stream", generate_content_stream)
    monkeypatch.setattr(genai_models.AsyncModels, "generate_content", agenerate_content)
    monkeypatch.setattr(genai_models.AsyncModels, "generate_content_stream", agenerate_content_stream)
    assert model_log.install_model_call_logging() is True
    assert model_log.install_model_call_logging() is False
    return calls


def model_calls(client):
    return [e for e in queued(client) if e["type"] == "model.call"]


def test_outside_a_request_is_unknown(fake_genai, isolated_copilot):
    genai_models.Models.generate_content(object(), model="gemini-2.5-flash", contents="hi")
    [ev] = model_calls(isolated_copilot)
    assert ev["actor"] == {"kind": "hester"}
    d = ev["data"]
    assert d["provider"] == "gemini"
    assert d["model"] == "gemini-2.5-flash"
    assert d["op"] == "generate"
    assert d["location"] == "cloud"
    assert d["trigger"] == {"kind": "unknown"}
    assert d["ok"] is True
    assert "duration_ms" in d and "ts_source" in d


def test_failure_stream_async_and_explicit_trigger(fake_genai, isolated_copilot):
    with pytest.raises(RuntimeError):
        genai_models.Models.embed_content(object(), model="gemini-embedding-001", contents="x")
    with model_log.trigger("automatic", name="knowledge.auto_match"):
        assert list(genai_models.Models.generate_content_stream(object(), model="m", contents="x")) == ["a", "b"]

    async def run():
        model_log.set_trigger("automatic", name="proactive.bundles")
        await genai_models.AsyncModels.generate_content(object(), model="m2", contents="x")
        stream = await genai_models.AsyncModels.generate_content_stream(object(), model="m3", contents="x")
        return [c async for c in stream]

    assert asyncio.run(run()) == ["x"]
    evs = model_calls(isolated_copilot)
    assert [(e["data"]["op"], e["data"]["ok"]) for e in evs] == [
        ("embed", False), ("stream", True), ("generate", True), ("stream", True),
    ]
    assert evs[1]["data"]["trigger"] == {"kind": "automatic", "name": "knowledge.auto_match"}
    assert evs[2]["data"]["trigger"] == {"kind": "automatic", "name": "proactive.bundles"}
    assert model_log.get_trigger() == {"kind": "unknown"}


def test_inside_a_request_is_user(fake_genai, isolated_copilot, monkeypatch):
    import hester.daemon.main as main

    monkeypatch.setenv("HESTER_AUTH_DISABLED", "1")
    if not any(getattr(r, "path", None) == "/__test/model" for r in main.app.router.routes):
        @main.app.post("/__test/model")
        async def _model():
            async def spawned():
                await genai_models.AsyncModels.generate_content(object(), model="spawned", contents="x")
            await asyncio.create_task(spawned())
            genai_models.Models.generate_content(object(), model="direct", contents="x")
            return {"ok": True}

    r = TestClient(main.app).post("/__test/model", headers={"X-Lee-Trigger": "palette"})
    assert r.status_code == 200
    evs = model_calls(isolated_copilot)
    assert {e["data"]["model"] for e in evs} == {"spawned", "direct"}
    for e in evs:
        assert e["data"]["trigger"] == {"kind": "user", "surface": "palette", "request_path": "/__test/model"}

    genai_models.Models.generate_content(object(), model="after", contents="x")
    assert model_calls(isolated_copilot)[-1]["data"]["trigger"] == {"kind": "unknown"}


def test_ingest_client_batches_requeues_and_caps():
    sent = []
    status = {"code": 503}

    def handler(request):
        body = request.read()
        import json
        events = json.loads(body)["events"]
        sent.append(len(events))
        if status["code"] != 200:
            return httpx.Response(status["code"])
        return httpx.Response(200, json={"success": True, "data": {"accepted": len(events), "rejected": []}})

    client = lee_events.LeeEventsClient(lee_url="http://lee.test", headers=lambda: {}, max_buffer=1200)
    for i in range(1300):
        client.enqueue({"type": "model.call", "data": {"i": i}})
    assert len(client) == 1200
    assert queued(client)[0]["data"]["i"] == 100

    async def flush():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            return await client.flush(http)

    assert asyncio.run(flush()) == 0
    assert len(client) == 1200
    status["code"] = 200
    sent.clear()
    assert asyncio.run(flush()) == 1200
    assert sent == [500, 500, 200]
    assert len(client) == 0


def test_ingest_rejects_unknown_types():
    with pytest.raises(ValueError):
        lee_events.ingest("attention.reply", {})
