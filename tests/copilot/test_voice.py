"""Voice on Hester (docs/plans/2026-09-28-tether-review-voice.md §5.2), with fake providers: no model runs."""

import asyncio
import io
import json
import wave
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.copilot import lee_events
from hester.daemon.voice import audio, config as vconfig, hints
from hester.daemon.voice.providers import ProviderError, STTProvider, set_provider
from hester.daemon.voice.providers.gemini import GeminiSTT
from hester.daemon.voice.providers.whisper import WhisperSTT

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401
from .conftest import queued
from .desk_helpers import page


def wav(ms=1000, rate=16000, channels=1, width=2) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(b"\x10\x00" * channels * int(rate * ms / 1000))
    return buf.getvalue()


# ---------------------------------------------------------------- audio


def test_parse_and_validate_the_wire_format():
    info = audio.parse_wav(wav(1500))
    assert (info.sample_rate, info.channels, info.sample_width, info.duration_ms) == (16000, 1, 2, 1500)
    audio.validate(info, 60)

    for bad in (b"", b"not a wav at all", b"RIFF\x00\x00\x00\x00WAVEjunk"):
        with pytest.raises(audio.AudioError) as e:
            audio.parse_wav(bad)
        assert (e.value.code, e.value.status) == ("unsupported_media_type", 415)
    for kw in ({"rate": 44100}, {"channels": 2}, {"width": 1}):
        with pytest.raises(audio.AudioError) as e:
            audio.validate(audio.parse_wav(wav(1000, **kw)), 60)
        assert e.value.code == "unsupported_media_type"
    with pytest.raises(audio.AudioError) as e:
        audio.validate(audio.parse_wav(wav(200)), 60)
    assert (e.value.code, e.value.status) == ("too_short", 422)
    with pytest.raises(audio.AudioError) as e:
        audio.validate(audio.parse_wav(wav(3000)), 2)
    assert (e.value.code, e.value.status) == ("too_long", 413)
    audio.validate(audio.parse_wav(wav(2300)), 2)  # a little past the cap: the client's auto-stop


def test_pcm16_to_float32_and_max_bytes():
    samples = audio.pcm16_to_float32(b"\x00\x00\x00\x40\x00\xc0\xff\x7f")
    assert [round(float(s), 4) for s in samples] == [0.0, 0.5, -0.5, 1.0]
    assert audio.max_bytes(60) == 4096 + 60 * 32000
    assert len(wav(60000)) < audio.max_bytes(60)


# ---------------------------------------------------------------- config


def test_config_defaults_env_and_bounds():
    c = vconfig.parse(None, env={})
    assert c == vconfig.VoiceConfig() and c.enabled is False and c.provider == "gemini"
    assert c.whisper_model == "base.en" and c.max_seconds == 60 and c.timeout_s == 30
    c = vconfig.parse({"enabled": True, "provider": "whisper", "max_seconds": 999}, env={"HESTER_VOICE_TIMEOUT_S": "5"})
    assert (c.enabled, c.provider, c.max_seconds, c.timeout_s) == (True, "whisper", vconfig.MAX_SECONDS_CAP, 5)
    c = vconfig.parse({"enabled": True, "provider": "siri"}, env={"HESTER_VOICE_ENABLED": "false"})
    assert c.enabled is False and c.provider == "gemini", "env wins; an unknown provider is gemini"


def test_config_from_the_merged_files_cached_by_mtime(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".lee").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    for k in ("ENABLED", "PROVIDER", "GEMINI_MODEL", "WHISPER_MODEL", "MAX_SECONDS", "TIMEOUT_S"):
        monkeypatch.delenv(f"HESTER_VOICE_{k}", raising=False)
    vconfig.clear_cache()
    cfg = home / ".lee" / "config.yaml"
    cfg.write_text("hester:\n  voice:\n    enabled: true\n    gemini_model: gemini-x\n")
    ws = tmp_path / "ws"
    (ws / ".lee").mkdir(parents=True)
    assert vconfig.load_voice_config(ws).gemini_model == "gemini-x"
    (ws / ".lee" / "config.yaml").write_text("hester:\n  voice:\n    max_seconds: 20\n")
    got = vconfig.load_voice_config(ws)
    assert got.enabled is True and got.max_seconds == 20, "the workspace's file merges over the home one"

    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert vconfig.google_api_key(ws) is None
    cfg.write_text("hester:\n  google_api_key: from-config\n")
    assert vconfig.google_api_key(ws) == "from-config"
    monkeypatch.setenv("GOOGLE_API_KEY", "from-env")
    assert vconfig.google_api_key(ws) == "from-env"
    vconfig.clear_cache()


# ---------------------------------------------------------------- hints


def test_name_words_headings_and_caps():
    words = hints.name_words("Please rename the DeskStore in desk_routes.py. Sync is v2 now, ask Taxonomy about it")
    assert words == ["DeskStore", "desk_routes.py", "v2", "Taxonomy"], "Sync starts a sentence"
    assert hints.headings("# Title\n\ntext\n## Sync ##\n    # code\n### Open questions\n") == ["Title", "Sync", "Open questions"]
    many = [f"Term{i}" for i in range(100)]
    assert len(hints.build_hint(many)) == hints.MAX_TERMS
    long = ["x" * 70 + str(i) for i in range(40)]
    out = hints.build_hint(long)
    assert len(", ".join(out)) <= hints.MAX_CHARS and len(out) < 40
    assert hints.build_hint(["Lee", "lee", " Lee  "], ["Hester"]) == ["Lee", "Hester"], "deduplicated ignoring case"


def test_hint_for_reply_send_and_context(tmp_path):
    ctx = {"editor": {"file": "/ws/src/desk_routes.py"}, "tabs": [{"label": "Claude · tether"}, {"label": "lazygit"}]}
    seen = []

    async def fetch(item_id):
        seen.append(item_id)
        return {"title": "Approve edit to DeskStore", "text": "Claude wants to change stash_area in deskModel.ts"}

    got = asyncio.run(hints.hint_for("reply", "att_1", tmp_path, ctx, fetch_item=fetch))
    assert seen == ["att_1"]
    assert got[:4] == ["Approve edit to DeskStore", "DeskStore", "stash_area", "deskModel.ts"]
    assert got[-4:] == ["desk_routes.py", "Claude · tether", "lazygit", tmp_path.name]

    desk = DeskStore(tmp_path)
    card = page(desk, "Taxonomy", "# Taxonomy\n\n## Stashed\n\nwords\n")
    got = asyncio.run(hints.hint_for("send", card["id"], tmp_path, None, fetch_item=fetch))
    assert got == ["Taxonomy", "Stashed", tmp_path.name] and seen == ["att_1"], "a Page, not an attention item"
    assert asyncio.run(hints.hint_for("capture", None, tmp_path, None, fetch_item=fetch)) == [tmp_path.name]


# ---------------------------------------------------------------- providers (fakes)


class FakeModels:
    def __init__(self, reply=None, error=None):
        self.calls = []
        self.reply = reply
        self.error = error

    async def generate_content(self, **kw):
        self.calls.append(kw)
        if self.error:
            raise self.error
        return SimpleNamespace(text=self.reply)


def fake_client(models):
    return lambda api_key: SimpleNamespace(aio=SimpleNamespace(models=models), api_key=api_key)


def test_gemini_transcribes_with_the_instruction_schema_and_audio():
    models = FakeModels(reply=json.dumps({"text": "Stash the Taxonomy area"}))
    p = GeminiSTT("gemini-3-flash-preview", api_key=lambda: "k", client_factory=fake_client(models))
    assert p.availability() is None and p.location == "cloud"
    data = wav(800)
    text = asyncio.run(p.transcribe(data, audio.parse_wav(data), ["Taxonomy", "DeskStore"]))
    assert text == "Stash the Taxonomy area"
    [call] = models.calls
    assert call["model"] == "gemini-3-flash-preview"
    prompt, part = call["contents"]
    assert "verbatim" in prompt and "Do not answer" in prompt and "Taxonomy, DeskStore" in prompt
    assert part.inline_data.mime_type == "audio/wav" and part.inline_data.data == data
    assert call["config"].temperature == 0 and call["config"].response_mime_type == "application/json"
    assert call["config"].response_schema is not None

    assert GeminiSTT("m", api_key=lambda: None).availability() == "no_api_key"
    for bad in (FakeModels(reply="not json"), FakeModels(reply=json.dumps({"answer": "x"})), FakeModels(error=RuntimeError("boom"))):
        p = GeminiSTT("m", api_key=lambda: "k", client_factory=fake_client(bad))
        with pytest.raises(ProviderError):
            asyncio.run(p.transcribe(data, audio.parse_wav(data), []))


class FakeWhisperModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, samples, **kw):
        self.calls.append((len(samples), kw))
        return iter([SimpleNamespace(text=" Pick up "), SimpleNamespace(text="the Taxonomy page. ")]), None


def test_whisper_availability_lazy_load_logging_and_unload(isolated_copilot):
    now = [1000.0]
    loads = []
    model = FakeWhisperModel()

    def loader(name):
        loads.append(name)
        return model

    assert WhisperSTT("base.en", is_installed=lambda: False).availability() == "whisper_not_installed"
    assert WhisperSTT("base.en", is_installed=lambda: True, model_present=lambda n: False).availability() == "whisper_model_missing"
    p = WhisperSTT("base.en", is_installed=lambda: True, model_present=lambda n: True, loader=loader, clock=lambda: now[0])
    assert p.availability() is None and p.location == "local" and not p.loaded and loads == []

    data = wav(1000)
    text = asyncio.run(p.transcribe(data, audio.parse_wav(data), ["Taxonomy"]))
    assert text == "Pick up the Taxonomy page." and loads == ["base.en"] and p.loaded
    n, kw = model.calls[0]
    assert n == 16000 and kw["initial_prompt"] == "Taxonomy" and kw["vad_filter"] is True and kw["language"] == "en"
    asyncio.run(p.transcribe(data, audio.parse_wav(data), []))
    assert loads == ["base.en"], "loaded once"
    [ev, _] = [e for e in queued(isolated_copilot) if e["type"] == "model.call"]
    assert ev["data"]["provider"] == "other" and ev["data"]["location"] == "local" and ev["data"]["ok"] is True
    assert ev["data"]["model"] == "whisper-base.en" and "text" not in json.dumps(ev["data"])

    now[0] += 599
    assert p.maybe_unload() is False and p.loaded
    now[0] += 2
    assert p.maybe_unload() is True and not p.loaded, "unloaded after 10 minutes idle"

    broken = WhisperSTT("base.en", is_installed=lambda: True, model_present=lambda n: True,
                        loader=lambda n: (_ for _ in ()).throw(RuntimeError("no model")))
    with pytest.raises(ProviderError):
        asyncio.run(broken.transcribe(data, audio.parse_wav(data), []))


# ---------------------------------------------------------------- routes


class FakeSTT(STTProvider):
    name = "fake"
    location = "cloud"

    def __init__(self, text="Send it to Taxonomy", reason=None, delay=0.0, error=False):
        self.text, self.reason, self.delay, self.error = text, reason, delay, error
        self.calls = []

    @property
    def model(self):
        return "fake-1"

    def availability(self):
        return self.reason

    async def transcribe(self, wav_bytes, info, hint):
        self.calls.append({"bytes": len(wav_bytes), "ms": info.duration_ms, "hint": list(hint)})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise ProviderError("RuntimeError")
        return self.text


@pytest.fixture
def voice_env(cockpit_env, monkeypatch):
    for k in ("PROVIDER", "GEMINI_MODEL", "WHISPER_MODEL", "MAX_SECONDS", "TIMEOUT_S"):
        monkeypatch.delenv(f"HESTER_VOICE_{k}", raising=False)
    monkeypatch.setenv("HESTER_VOICE_ENABLED", "true")
    vconfig.clear_cache()
    fake = FakeSTT()
    cfg = vconfig.load_voice_config(cockpit_env.a)
    set_provider(cfg, fake)
    yield SimpleNamespace(env=cockpit_env, fake=fake, cfg=cfg)
    set_provider(cfg, None)
    vconfig.clear_cache()


def post(c, h, body, purpose="capture", ctype="audio/wav", **params):
    return c.post("/voice/transcribe", params={"purpose": purpose, **params}, headers={**h, "Content-Type": ctype}, content=body)


def test_capabilities(voice_env, monkeypatch):
    c, h = voice_env.env.client, hdr(voice_env.env.a)
    caps = c.get("/voice", headers=h).json()["data"]
    assert caps == {
        "enabled": True, "available": True, "provider": "fake", "model": "fake-1", "location": "cloud",
        "accepts": ["audio/wav"], "sample_rate": 16000, "channels": 1, "max_seconds": 60,
        "max_bytes": audio.max_bytes(60),
    }
    voice_env.fake.reason = "no_api_key"
    caps = c.get("/voice", headers=h).json()["data"]
    assert caps["available"] is False and caps["reason"] == "no_api_key"
    monkeypatch.setenv("HESTER_VOICE_ENABLED", "false")
    caps = c.get("/voice", headers=h).json()["data"]
    assert (caps["enabled"], caps["available"], caps["reason"]) == (False, False, "disabled")
    assert c.get("/voice").status_code == 401


def test_transcribe_returns_the_text_and_logs_no_content(voice_env, isolated_copilot):
    env = voice_env.env
    c, h = env.client, hdr(env.a)
    card = page(DeskStore(env.a), "Taxonomy", "# Taxonomy\n\n## Stashed\n")
    r = post(c, h, wav(1200), purpose="send", item_id=card["id"])
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["text"] == "Send it to Taxonomy" and data["audio_ms"] == 1200
    assert (data["provider"], data["model"], data["location"]) == ("fake", "fake-1", "cloud")
    assert isinstance(data["latency_ms"], int)
    [call] = voice_env.fake.calls
    assert call["hint"][:2] == ["Taxonomy", "Stashed"] and env.a.name in call["hint"]

    [ev] = [e for e in queued(isolated_copilot) if e["type"] == "voice.transcribe"]
    d = ev["data"]
    assert {k: d[k] for k in ("purpose", "provider", "model", "location", "audio_ms", "ok", "text_chars")} == {
        "purpose": "send", "provider": "fake", "model": "fake-1", "location": "cloud", "audio_ms": 1200,
        "ok": True, "text_chars": len("Send it to Taxonomy"),
    }
    assert d["bytes"] == len(wav(1200)) and "error" not in d
    assert "Taxonomy" not in json.dumps(ev), "never the text or the hint"
    assert "voice.transcribe" in lee_events.INGEST_TYPES


def test_transcribe_errors(voice_env, monkeypatch, isolated_copilot):
    env = voice_env.env
    c, h = env.client, hdr(env.a)
    assert post(c, h, wav(), purpose="dictate").status_code == 400
    r = post(c, h, wav(), ctype="audio/webm")
    assert (r.status_code, r.json()["error"]) == (415, "unsupported_media_type")
    r = post(c, h, b"RIFF....WAVEnope")
    assert (r.status_code, r.json()["error"]) == (415, "unsupported_media_type")
    r = post(c, h, wav(1000, rate=48000))
    assert (r.status_code, r.json()["error"]) == (415, "unsupported_media_type")
    r = post(c, h, wav(100))
    assert (r.status_code, r.json()["error"]) == (422, "too_short")
    r = post(c, h, wav(1000) + b"\x00" * audio.max_bytes(60))
    assert (r.status_code, r.json()["error"]) == (413, "too_large")

    voice_env.fake.error = True
    r = post(c, h, wav())
    assert (r.status_code, r.json()["error"]) == (502, "provider_error")
    voice_env.fake.error, voice_env.fake.delay = False, 1.0
    monkeypatch.setenv("HESTER_VOICE_TIMEOUT_S", "0.1")
    vconfig.clear_cache()
    set_provider(vconfig.load_voice_config(env.a), voice_env.fake)
    r = post(c, h, wav())
    assert (r.status_code, r.json()["error"]) == (504, "timeout")

    voice_env.fake.delay, voice_env.fake.reason = 0.0, "whisper_model_missing"
    r = post(c, h, wav())
    assert (r.status_code, r.json()["error"], r.json()["reason"]) == (503, "voice_unavailable", "whisper_model_missing")
    monkeypatch.setenv("HESTER_VOICE_ENABLED", "0")
    r = post(c, h, wav())
    assert (r.status_code, r.json()["error"]) == (503, "voice_disabled")

    evs = [e["data"] for e in queued(isolated_copilot) if e["type"] == "voice.transcribe"]
    assert [e["error"] for e in evs] == [
        "unsupported_media_type", "unsupported_media_type", "unsupported_media_type", "too_short", "too_large",
        "provider_error", "timeout", "voice_unavailable", "voice_disabled",
    ], "every attempt past the purpose check, never the bad purpose"
    assert all(e["ok"] is False for e in evs)


def test_too_long_by_its_length(voice_env, monkeypatch):
    env = voice_env.env
    monkeypatch.setenv("HESTER_VOICE_MAX_SECONDS", "2")
    vconfig.clear_cache()
    cfg = vconfig.load_voice_config(env.a)
    set_provider(cfg, voice_env.fake)
    try:
        r = post(env.client, hdr(env.a), wav(3000)[: audio.max_bytes(2)])  # claims 3 s, carries what fits
        assert r.status_code == 200 and r.json()["data"]["audio_ms"] <= 2200, "the frames it carries count"
        r = post(env.client, hdr(env.a), wav(2800))
        assert (r.status_code, r.json()["error"]) == (413, "too_large")
    finally:
        set_provider(cfg, None)


# ---------------------------------------------------------------- hester voice


def test_cli_status_and_test(voice_env, tmp_path):
    from hester.cli.main import cli
    from hester.cli.voice import voice

    assert "voice" in cli.commands
    env = voice_env.env
    r = CliRunner().invoke(voice, ["status", "--dir", str(env.a), "--json"])
    assert r.exit_code == 0, r.output
    assert json.loads(r.output)["available"] is True
    r = CliRunner().invoke(voice, ["status", "--dir", str(env.a)])
    assert "available" in r.output and "fake-1" in r.output

    f = tmp_path / "clip.wav"
    f.write_bytes(wav(900))
    r = CliRunner().invoke(voice, ["test", str(f), "--dir", str(env.a)])
    assert r.exit_code == 0, r.output
    assert r.output.strip().endswith("Send it to Taxonomy")
    f.write_bytes(wav(100))
    r = CliRunner().invoke(voice, ["test", str(f), "--dir", str(env.a)])
    assert r.exit_code == 1 and "too_short" in r.output
    r = CliRunner().invoke(voice, ["setup", "--dir", str(env.a)])
    assert r.exit_code == 0 and "nothing to download" in r.output
