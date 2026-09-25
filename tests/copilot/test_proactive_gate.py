import asyncio
import subprocess

import pytest

from hester.daemon.copilot import model_log, presence
from hester.daemon.knowledge import proactive_watcher as pw_mod
from hester.daemon.knowledge.proactive_watcher import ProactiveWatcher
from hester.daemon.proactive.models import ProactiveConfig

from .conftest import queued


def set_presence(monkeypatch, value):
    async def fake():
        return value
    monkeypatch.setattr(presence, "at_machine", fake)


def make_watcher(tmp_path, **cfg):
    w = ProactiveWatcher(working_dir=tmp_path)
    w._config = ProactiveConfig(**cfg)
    return w


def run_task(watcher, task_id):
    ran = []

    async def handler():
        ran.append(model_log.get_trigger())

    did = asyncio.run(watcher._run_task(task_id, handler))
    return did, ran


def test_defaults_are_quiet():
    cfg = ProactiveConfig()
    assert cfg.knowledge_auto_match is False
    assert cfg.run_while_present is False
    assert not cfg.tasks.docs_index.enabled
    assert not cfg.tasks.drift_check.enabled
    assert not cfg.tasks.bundles.enabled
    assert cfg.tasks.devops.enabled and cfg.tasks.tests.enabled
    legacy = ProactiveConfig.model_validate({"tasks": {"ideas": {"enabled": True, "interval": 60}}})
    assert legacy.tasks.ideas.enabled


@pytest.mark.parametrize("value", [True, None])
def test_model_task_skipped_at_machine_or_unknown(tmp_path, monkeypatch, value):
    set_presence(monkeypatch, value)
    for task in ("docs_index", "drift_check", "bundles"):
        did, ran = run_task(make_watcher(tmp_path), task)
        assert did is False and ran == []


def test_model_task_runs_when_away(tmp_path, monkeypatch):
    set_presence(monkeypatch, False)
    did, ran = run_task(make_watcher(tmp_path), "docs_index")
    assert did is True
    assert ran == [{"kind": "automatic", "name": "proactive.docs_index"}]
    assert model_log.get_trigger() == {"kind": "unknown"}


def test_run_while_present_overrides(tmp_path, monkeypatch):
    set_presence(monkeypatch, True)
    did, ran = run_task(make_watcher(tmp_path, run_while_present=True), "drift_check")
    assert did is True and len(ran) == 1


def test_non_model_task_ignores_presence(tmp_path, monkeypatch):
    async def boom():
        raise AssertionError("presence must not be consulted")
    monkeypatch.setattr(presence, "at_machine", boom)
    did, ran = run_task(make_watcher(tmp_path), "devops")
    assert did is True and len(ran) == 1


def test_docs_subprocess_logged_as_model_call(tmp_path, monkeypatch, isolated_copilot):
    set_presence(monkeypatch, False)
    watcher = make_watcher(tmp_path)

    async def fake_run(cmd, timeout=30.0, cwd=None):
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(watcher, "_run_command", fake_run)
    monkeypatch.setattr(watcher, "_push_status", lambda *a, **k: asyncio.sleep(0))
    assert asyncio.run(watcher._run_task("docs_index", watcher.check_docs_index)) is True
    evs = [e for e in queued(isolated_copilot) if e["type"] == "model.call"]
    assert len(evs) == 1
    d = evs[0]["data"]
    assert d["op"] == "subprocess"
    assert d["location"] == "cloud"
    assert d["trigger"] == {"kind": "automatic", "name": "proactive.docs_index"}

    asyncio.run(watcher._run_hester_command(["devops", "status"]))
    assert len([e for e in queued(isolated_copilot) if e["type"] == "model.call"]) == 1


def test_ideas_task_gone():
    assert not hasattr(ProactiveWatcher, "check_ideas")
    assert not hasattr(ProactiveWatcher, "_score_ideas")
    assert "ideas" not in pw_mod.MODEL_TASKS


def test_presence_client_push_and_unreachable():
    client = presence.PresenceClient(lee_url="http://127.0.0.1:9", headers=lambda: {})
    assert asyncio.run(client.at_machine()) is None
    client.update({"at_machine": False, "lee_active": False, "engaged": True})
    assert asyncio.run(client.at_machine()) is False
    presence.on_presence_message({"at_machine": True})
