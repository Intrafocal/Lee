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

    logged_before_run = []

    async def fake_run(cmd, timeout=30.0, cwd=None):
        # Contract §8.2: the model.call is recorded before the subprocess runs.
        logged_before_run.append(len([e for e in queued(isolated_copilot) if e["type"] == "model.call"]))
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(watcher, "_run_command", fake_run)
    monkeypatch.setattr(watcher, "_push_status", lambda *a, **k: asyncio.sleep(0))
    assert asyncio.run(watcher._run_task("docs_index", watcher.check_docs_index)) is True
    assert logged_before_run == [1]
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


def test_switch_workspace_resets_knowledge_auto_match(tmp_path, monkeypatch):
    """An opt-in from workspace A must not carry over to workspace B (C1/C2)."""
    from types import SimpleNamespace

    import hester.daemon.main as main
    from hester.shared import workspace as ws_mod

    class FakeEngine:
        _working_dir = None
        _auto_match = True

        def set_auto_match(self, enabled):
            self._auto_match = bool(enabled)

    engine = FakeEngine()
    state = main.app_state
    for attr, value in {
        "settings": SimpleNamespace(working_directory=str(tmp_path / "a")),
        "knowledge_engine": engine,
        "knowledge_store": None,
        "bundle_service": None,
        "git_watcher": None,
        "task_watcher": None,
        "proactive_watcher": None,
        "ws_store": state.ws_store,
    }.items():
        monkeypatch.setattr(state, attr, value, raising=False)
    monkeypatch.setattr(main, "_load_plugins_for_workspace", lambda _ws: 0)
    monkeypatch.setattr(ws_mod, "_current_workspace", ws_mod._current_workspace)
    import hester.daemon.tools.workstream_tools as wt
    monkeypatch.setattr(wt, "init_workstream_tools", lambda _store: None)

    b = tmp_path / "b"
    b.mkdir()
    changes = asyncio.run(main._switch_workspace(b))
    assert changes["knowledge"] == "rebound"
    assert engine._auto_match is False
