"""docs/15-Usage.md §3.4 and §8: usage on Hester's model.call events, and the price table."""

import asyncio
from types import SimpleNamespace

import pytest
from google.genai import models as genai_models

from hester.daemon.copilot import model_log, prices

from .conftest import queued


@pytest.fixture(autouse=True)
def fresh_prices(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    prices.set_table_for_tests(None)
    yield home
    prices.set_table_for_tests(None)


def model_calls(client):
    return [e["data"] for e in queued(client) if e["type"] == "model.call"]


def meta(prompt=1000, candidates=200, cached=None, thoughts=None):
    return SimpleNamespace(
        prompt_token_count=prompt, candidates_token_count=candidates, cached_content_token_count=cached,
        thoughts_token_count=thoughts, tool_use_prompt_token_count=None,
    )


# ---------------------------------------------------------------- price table


def test_shipped_table_and_unknown_models():
    table = prices.price_table(force=True)
    assert table["gemini-2.5-flash"]["input"] == 0.30
    assert prices.normalize_model("models/gemini-2.5-flash") == "gemini-2.5-flash"
    assert prices.normalize_model("claude-haiku-4-5-20251001") == "claude-haiku-4-5"
    # 1M input + 1M output at 0.30 / 2.50
    assert prices.cost_usd("gemini-2.5-flash", {"input": 1_000_000, "output": 1_000_000}) == pytest.approx(2.80)
    # cache reads at their own price; thinking is a subset of output, never added
    assert prices.cost_usd("gemini-2.5-flash", {"input": 0, "output": 0, "cache_read": 1_000_000, "thinking": 99}) == pytest.approx(0.03)
    # a missing cache price charges the input price
    assert prices.cost_usd("gemini-2.0-flash-lite", {"cache_read": 1_000_000}) == pytest.approx(0.075)
    assert prices.cost_usd("gemini-9-mystery", {"input": 10, "output": 10}) is None
    assert prices.cost_usd("gemini-2.5-flash", {}) is None
    # prefixes never match: flash-image is not flash
    assert prices.price_for("gemini-2.5-flash-image") is None


def test_config_overrides_and_extends(fresh_prices):
    (fresh_prices / ".lee").mkdir()
    (fresh_prices / ".lee" / "config.yaml").write_text(
        "usage:\n  prices:\n"
        "    gemini-2.5-flash: { input: 1.0, output: 2.0 }\n"
        "    gemini-3.1-pro-preview: { input: 2.0, output: 12.0, cache_read: 0.2 }\n"
        "    broken: { input: 1.0 }\n"
    )
    table = prices.price_table(force=True)
    assert table["gemini-2.5-flash"] == {"input": 1.0, "output": 2.0}
    assert table["gemini-3.1-pro-preview"]["output"] == 12.0
    assert "broken" not in table
    assert table["claude-opus-5"]["input"] == 5.0  # shipped entries stay


# ---------------------------------------------------------------- record_model_call


def test_record_without_tokens_has_no_usage(isolated_copilot):
    model_log.record_model_call(provider="gemini", model="gemini-2.5-flash", op="generate", location="cloud", ok=True)
    [d] = model_calls(isolated_copilot)
    assert "usage" not in d


def test_record_gemini_estimate_priced(isolated_copilot):
    model_log.record_model_call(
        provider="gemini", model="gemini-2.5-flash", op="generate", location="cloud", ok=True,
        duration_ms=812.0, tokens={"input": 1000, "output": 200, "bogus": 5, "cache_read": -1},
    )
    [d] = model_calls(isolated_copilot)
    assert d["usage"] == {
        "provider": "google", "model": "gemini-2.5-flash", "tokens": {"input": 1000, "output": 200},
        "cost_usd": pytest.approx((1000 * 0.30 + 200 * 2.50) / 1e6), "cost_basis": "estimate", "duration_ms": 812.0,
    }


def test_unknown_model_gets_tokens_no_cost(isolated_copilot):
    model_log.record_model_call(provider="gemini", model="gemini-next", op="generate", location="cloud", ok=True,
                                tokens={"input": 5, "output": 7})
    [d] = model_calls(isolated_copilot)
    assert d["usage"]["tokens"] == {"input": 5, "output": 7}
    assert "cost_usd" not in d["usage"] and d["usage"]["cost_basis"] == "estimate"


def test_anthropic_joins_the_provider_set(isolated_copilot):
    model_log.record_model_call(provider="anthropic", model="claude-opus-5", op="delegate", location="cloud", ok=True,
                                tokens={"input": 3, "output": 4}, cost_usd=0.25, cost_basis="subscription")
    model_log.record_model_call(provider="mistral", model="x", op="generate", location="cloud", ok=True)
    first, second = model_calls(isolated_copilot)
    assert first["provider"] == "anthropic"
    assert first["usage"]["provider"] == "anthropic" and first["usage"]["cost_basis"] == "subscription"
    assert first["usage"]["cost_usd"] == 0.25  # recorded; the UI never shows subscription dollars
    assert second["provider"] == "other"


def test_ollama_is_local_and_never_costed(isolated_copilot):
    usage = model_log.ollama_usage({"prompt_eval_count": 120, "eval_count": 40, "total_duration": 2_500_000_000})
    assert usage == {"tokens": {"input": 120, "output": 40}, "compute_ms": 2500.0}
    assert model_log.ollama_usage({"response": "x"}) == {}
    model_log.record_model_call(provider="ollama", model="gemma3:4b", op="generate", location="local", ok=True,
                                duration_ms=2600.0, cost_usd=1.0, **usage)
    [d] = model_calls(isolated_copilot)
    assert d["duration_ms"] == 2600.0
    assert d["usage"] == {"provider": "ollama", "model": "gemma3:4b", "tokens": {"input": 120, "output": 40},
                          "cost_basis": "local", "duration_ms": 2500.0}


def test_gemini_token_mapping():
    assert model_log.gemini_tokens(None) is None
    assert model_log.gemini_tokens(meta(prompt=0, candidates=0)) is None
    # prompt includes cached; thoughts are output
    assert model_log.gemini_tokens(meta(prompt=1000, candidates=200, cached=600, thoughts=50)) == {
        "input": 400, "output": 250, "cache_read": 600, "thinking": 50,
    }
    assert model_log.gemini_tokens({"prompt_token_count": 3, "candidates_token_count": 2}) == {"input": 3, "output": 2}


# ---------------------------------------------------------------- the genai wrapper


@pytest.fixture
def fake_genai(monkeypatch):
    def generate_content(self, *, model, contents, config=None):
        return SimpleNamespace(text="ok", usage_metadata=meta(1000, 200) if contents != "bare" else None)

    def embed_content(self, *, model, contents, config=None):
        stats = SimpleNamespace(token_count=7)
        return SimpleNamespace(embeddings=[SimpleNamespace(statistics=stats), SimpleNamespace(statistics=stats)], metadata=None)

    def generate_content_stream(self, *, model, contents, config=None):
        yield SimpleNamespace(text="a", usage_metadata=None)
        yield SimpleNamespace(text="b", usage_metadata=meta(10, 1))
        yield SimpleNamespace(text="c", usage_metadata=meta(10, 5, thoughts=2))

    async def agenerate_content(self, *, model, contents, config=None):
        return SimpleNamespace(text="ok", usage_metadata=meta(50, 5))

    async def aembed_content(self, *, model, contents, config=None):
        return SimpleNamespace(embeddings=[SimpleNamespace(statistics=None)], metadata=None)

    async def agenerate_content_stream(self, *, model, contents, config=None):
        async def gen():
            yield SimpleNamespace(text="x", usage_metadata=meta(20, 3))
            yield SimpleNamespace(text="y", usage_metadata=None)
        return gen()

    monkeypatch.setattr(genai_models.Models, "generate_content", generate_content)
    monkeypatch.setattr(genai_models.Models, "embed_content", embed_content)
    monkeypatch.setattr(genai_models.Models, "generate_content_stream", generate_content_stream)
    monkeypatch.setattr(genai_models.AsyncModels, "generate_content", agenerate_content)
    monkeypatch.setattr(genai_models.AsyncModels, "embed_content", aembed_content)
    monkeypatch.setattr(genai_models.AsyncModels, "generate_content_stream", agenerate_content_stream)
    assert model_log.install_model_call_logging() is True


def test_wrapper_reads_usage_metadata(fake_genai, isolated_copilot):
    genai_models.Models.generate_content(object(), model="gemini-2.5-flash", contents="hi")
    genai_models.Models.generate_content(object(), model="gemini-2.5-flash", contents="bare")
    genai_models.Models.embed_content(object(), model="gemini-embedding-001", contents=["a", "b"])
    assert [c.text for c in genai_models.Models.generate_content_stream(object(), model="gemini-2.5-flash", contents="x")] == ["a", "b", "c"]

    async def run():
        await genai_models.AsyncModels.generate_content(object(), model="gemini-2.5-flash", contents="x")
        await genai_models.AsyncModels.embed_content(object(), model="gemini-embedding-001", contents="x")
        stream = await genai_models.AsyncModels.generate_content_stream(object(), model="gemini-2.5-flash", contents="x")
        return [c.text async for c in stream]

    assert asyncio.run(run()) == ["x", "y"]
    evs = model_calls(isolated_copilot)
    assert [e["op"] for e in evs] == ["generate", "generate", "embed", "stream", "generate", "embed", "stream"]
    usage = [e.get("usage") for e in evs]
    assert usage[0]["tokens"] == {"input": 1000, "output": 200} and usage[0]["cost_usd"] > 0
    assert usage[1] is None  # no usage_metadata: the call is still recorded, without tokens
    assert usage[2]["tokens"] == {"input": 14} and usage[2]["cost_usd"] == pytest.approx(14 * 0.15 / 1e6)
    # streams keep the last chunk that reported usage
    assert usage[3]["tokens"] == {"input": 10, "output": 7, "thinking": 2}
    assert usage[4]["tokens"] == {"input": 50, "output": 5}
    assert usage[5] is None
    assert usage[6]["tokens"] == {"input": 20, "output": 3}


# ---------------------------------------------------------------- Claude delegates


def test_delegate_records_anthropic_usage(isolated_copilot, monkeypatch):
    from hester.daemon.tasks.claude_delegate import ClaudeDelegate

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    d = ClaudeDelegate(model="claude-sonnet-4-6", api_key="x")
    d._record_usage({"cost_usd": 0.42, "is_error": False, "usage": {
        "input_tokens": 12, "output_tokens": 300, "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 700,
    }}, started=0.0)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    d._record_usage(None, started=0.0)
    sub, failed = model_calls(isolated_copilot)
    assert sub["provider"] == "anthropic" and sub["op"] == "delegate" and sub["ok"] is True
    assert sub["usage"] == {
        "provider": "anthropic", "model": "claude-sonnet-4-6",
        "tokens": {"input": 12, "output": 300, "cache_read": 9000, "cache_write": 700},
        "cost_usd": 0.42, "cost_basis": "subscription", "duration_ms": sub["duration_ms"],
    }
    assert failed["ok"] is False and "usage" not in failed
