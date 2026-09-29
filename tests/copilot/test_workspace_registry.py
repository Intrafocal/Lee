import asyncio

import pytest

from hester.daemon.workspaces.registry import WorkspaceError, WorkspaceRegistry, validate_workspace
from hester.shared import workspace as ws_mod

from .cockpit_helpers import SHARED, cockpit_env, hdr  # noqa: F401


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    out = []
    for name in ("a", "b", "c", "d"):
        p = tmp_path / name
        p.mkdir()
        out.append(p.resolve())
    monkeypatch.setattr(ws_mod, "_current_workspace", out[0])
    return out


def test_validate_workspace(tmp_path):
    f = tmp_path / "file"
    f.write_text("x")
    for bad in ("", "relative/path", str(tmp_path / "missing"), str(f), None, 3):
        with pytest.raises(WorkspaceError):
            validate_workspace(bad)
    assert validate_workspace(str(tmp_path)) == tmp_path.resolve()


def test_get_active_and_sources(dirs):
    a, b, c, _ = dirs
    reg = WorkspaceRegistry(boot=a)
    boot = reg.active()
    assert boot.path == a and boot.sources == {"boot", "active"}
    ctx = reg.get(str(b))
    assert ctx.sources == {"request"} and ctx.id == ws_mod.workspace_id(b)
    assert reg.get(b) is ctx
    reg.set_active(c)
    assert "active" not in reg.peek(a).sources and "active" in reg.peek(c).sources
    with pytest.raises(WorkspaceError):
        reg.get("not/absolute")


def test_stores_are_per_workspace_and_cached(dirs):
    a, b, _, _ = dirs
    reg = WorkspaceRegistry(boot=a)
    ca, cb = reg.get(a), reg.get(b)
    assert ca.tasks() is ca.tasks() and ca.tasks() is not cb.tasks()
    assert ca.tasks().workspace == a and cb.readings().workspace == b
    assert ca.ws_store().working_dir == a and cb.ideas().workspace == b
    (b / ".lee").mkdir()
    (b / ".lee" / "config.yaml").write_text("cockpit:\n  enabled: true\n")
    assert cb.config().get("cockpit") == {"enabled": True}


def test_sync_from_lee_and_evict(dirs):
    a, b, c, d = dirs
    clock = Clock()
    rows = {"v": [{"id": 1, "workspace": str(b)}, {"id": 2, "workspace": "relative"}, {"id": 3, "workspace": None}]}

    async def fetch():
        return rows["v"]

    reg = WorkspaceRegistry(boot=a, fetch_windows=fetch, clock=clock)
    reg.get(d)
    asyncio.run(reg.sync_from_lee())
    assert "window" in reg.peek(b).sources
    assert {str(x.path) for x in reg.list()} == {str(a), str(b), str(d)}

    # Lee unreachable: keep the current set
    rows["v"] = None
    asyncio.run(reg.sync_from_lee())
    assert "window" in reg.peek(b).sources

    # Window on b closed, c opened
    rows["v"] = [{"id": 2, "workspace": str(c)}]
    asyncio.run(reg.sync_from_lee())
    assert "window" not in reg.peek(b).sources and "window" in reg.peek(c).sources

    # Idle 30 min: request/ex-window contexts go, boot/active/window stay
    clock.t += 31 * 60
    assert reg.evict_idle() == 2
    assert {x.path for x in reg.list()} == {a, c}


def test_cap_is_lru_and_keeps_active(tmp_path, monkeypatch):
    a = tmp_path / "boot"
    a.mkdir()
    monkeypatch.setattr(ws_mod, "_current_workspace", a.resolve())
    clock = Clock()
    reg = WorkspaceRegistry(boot=a, clock=clock, max_contexts=3)
    made = []
    for i in range(4):
        p = tmp_path / f"w{i}"
        p.mkdir()
        clock.t += 1
        reg.get(p)
        made.append(p.resolve())
    paths = {x.path for x in reg.list()}
    assert len(paths) == 3 and a.resolve() in paths
    assert made[0] not in paths and made[1] not in paths


def test_close_and_open(dirs):
    a, b, _, _ = dirs
    reg = WorkspaceRegistry(boot=a)
    reg.open(b)
    assert reg.close(b) is True
    assert reg.close(b) is False
    with pytest.raises(WorkspaceError):
        reg.close(a)


def test_workspaces_routes(cockpit_env):
    env = cockpit_env
    c = env.client
    r = c.get("/workspaces", headers=SHARED)
    assert r.status_code == 200
    [entry] = r.json()["data"]
    assert entry["path"] == str(env.a) and entry["active"] is True and "boot" in entry["sources"]

    r = c.post("/workspaces/open", headers=SHARED, json={"path": str(env.b)})
    assert r.status_code == 200 and r.json()["data"]["active"] is False
    assert {e["path"] for e in c.get("/workspaces", headers=SHARED).json()["data"]} == {str(env.a), str(env.b)}

    assert c.post("/workspaces/close", headers=SHARED, json={"path": str(env.a)}).status_code == 400
    assert c.post("/workspaces/close", headers=SHARED, json={"path": str(env.b)}).json()["data"] == {"closed": True}
    assert c.post("/workspaces/open", headers=SHARED, json={"path": "nope"}).status_code == 400
    assert c.get("/workspaces").status_code == 401
