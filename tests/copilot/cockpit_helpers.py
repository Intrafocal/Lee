"""Shared fixtures for the Copilot v2 (multi-workspace, Cockpit) tests.

Nothing binds a port or touches the real ~/.lee or ~/.hester: HOME points at a
temp dir, Lee's /windows is a stub and every request goes through TestClient.
"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from hester.shared import auth

SHARED = {"Authorization": "Bearer shared-secret"}
DEVICE = {"Authorization": "Bearer device-token"}


def hdr(workspace=None, device=False):
    h = dict(DEVICE if device else SHARED)
    if workspace is not None:
        h["X-Lee-Workspace"] = str(workspace)
    return h


@pytest.fixture
def cockpit_env(tmp_path, monkeypatch):
    import hester.daemon.main as main
    from hester.daemon.workspaces import registry as reg
    from hester.shared import workspace as ws_mod

    from .test_device_auth import write_device

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HESTER_COCKPIT_STATE_DIR", str(tmp_path / "cockpit-state"))

    a = (tmp_path / "wsA")
    b = (tmp_path / "wsB")
    a.mkdir()
    b.mkdir()
    a, b = a.resolve(), b.resolve()
    monkeypatch.setattr(ws_mod, "_current_workspace", a)

    windows = {"rows": [{"id": 1, "workspace": str(a), "focused": True}]}

    async def fetch_windows():
        return windows["rows"]

    registry = reg.WorkspaceRegistry(boot=a, fetch_windows=fetch_windows)
    monkeypatch.setattr(reg, "_registry", registry)

    devices = tmp_path / "devices"
    monkeypatch.setenv("LEE_API_TOKEN", "shared-secret")
    monkeypatch.delenv("HESTER_AUTH_DISABLED", raising=False)
    monkeypatch.setattr(main, "device_for_token", lambda t: auth.device_for_token(t, devices))
    write_device(devices, "dev_00000000abcd", "device-token", kind="aeronaut")

    return SimpleNamespace(
        client=TestClient(main.app), a=a, b=b, registry=registry, windows=windows,
        main=main, tmp=tmp_path,
    )


@pytest.fixture
def switchable(cockpit_env, monkeypatch):
    """Stub the follow-active singletons so POST /workspace can run its switch."""
    main = cockpit_env.main
    state = main.app_state
    for attr, value in {
        "settings": SimpleNamespace(working_directory=str(cockpit_env.a)),
        "knowledge_engine": None,
        "knowledge_store": None,
        "bundle_service": None,
        "git_watcher": None,
        "task_watcher": None,
        "proactive_watcher": None,
    }.items():
        monkeypatch.setattr(state, attr, value, raising=False)
    monkeypatch.setattr(main, "_load_plugins_for_workspace", lambda _ws: 0)
    return cockpit_env
