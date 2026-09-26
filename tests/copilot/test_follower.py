import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from hester.daemon.cockpit.follower import EventFollower
from hester.daemon.cockpit.tasks import CockpitTaskStore
from hester.daemon.workspaces.registry import WorkspaceRegistry
from hester.shared import workspace as ws_mod

from .conftest import make_event, write_events

T0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)


def at(minutes):
    return T0 + timedelta(minutes=minutes)


class Env:
    def __init__(self, tmp_path, monkeypatch):
        self.a = (tmp_path / "wsA")
        self.b = (tmp_path / "wsB")
        self.a.mkdir()
        self.b.mkdir()
        self.a, self.b = self.a.resolve(), self.b.resolve()
        monkeypatch.setattr(ws_mod, "_current_workspace", self.a)
        self.events = tmp_path / "events"
        self.state = tmp_path / "state" / "follower.json"
        self.registry = WorkspaceRegistry(boot=self.a)
        self.registry.get(self.b)
        self.n = 0

    def follower(self):
        return EventFollower(registry=self.registry, events_dir=self.events, state_file=self.state)

    def ev(self, type, minutes, data, workspace="A", **kw):
        self.n += 1
        ws = {"A": str(self.a), "B": str(self.b), None: None}[workspace]
        e = make_event(type, at(minutes), data, workspace=ws, **kw)
        e["id"] = f"ev{self.n:04d}"
        return e

    def write(self, *events):
        write_events(self.events, list(events))

    def tasks(self, ws=None):
        return {t["id"]: t for t in CockpitTaskStore(ws or self.a).load_all()}


@pytest.fixture
def env(tmp_path, monkeypatch):
    return Env(tmp_path, monkeypatch)


def tick(f):
    return asyncio.run(f.tick())


def test_launch_stub_session_and_turns(env):
    E = env.ev
    env.write(
        E("task.launch", 0, {"task_id": "task-11111111", "pty_id": 5, "session_id": "s1", "provider": "claude",
                              "lead": "delegate", "kind": "bug", "confirmed": True, "play": False, "worktree": True,
                              "origin_kind": "launcher"}),
        E("agent.session_start", 0.1, {"session_id": "s1", "pty_id": 5, "cwd": str(env.a)}),
        E("agent.prompt", 0.2, {"session_id": "s1", "pty_id": 5, "prompt_chars": 40}),
        E("agent.tool", 1, {"session_id": "s1", "pty_id": 5, "tool": "Edit", "phase": "post", "writes": True, "files": ["src/a.py", str(env.a / "src/a.py")]}),
        E("agent.waiting", 2, {"session_id": "s1", "pty_id": 5}),
        E("agent.turn_end", 3, {"session_id": "s1", "pty_id": 5, "busy_ms": 120000, "summary": "Did it",
                                "lee_status": {"status": "done", "summary": "Fixed the 404\nmore"}}),
    )
    f = env.follower()
    assert tick(f) == 6
    t = env.tasks()["task-11111111"]
    assert t["title"] == "Fixed the 404" and t["title_source"] == "agent"
    assert t["confirmed"] is True and t["origin"] == {"kind": "launcher", "ref": None}
    assert t["status"] == "review" and t["busy_ms"] == 120000 and t["turns"] == 1
    assert t["files"] == [str(env.a / "src/a.py")] and t["files_count"] == 1
    assert t["sessions"] == ["s1"] and t["agent"]["pty_id"] == 5
    assert t["summary"] == "Did it" and t["lee_status"]["status"] == "done"
    assert t["applied_through"].endswith("|ev0006")

    # the relay arrives later: user fields win, follower fields stay
    store = CockpitTaskStore(env.a)
    store.upsert({"id": "task-11111111", "title": "Fix /fs/list", "title_source": "user", "status": "running"})
    t = env.tasks()["task-11111111"]
    assert t["title"] == "Fix /fs/list" and t["busy_ms"] == 120000 and t["turns"] == 1

    # a later turn doesn't overwrite a user title
    env.write(E("agent.prompt", 4, {"session_id": "s1", "pty_id": 5}),
              E("agent.turn_end", 5, {"session_id": "s1", "pty_id": 5, "busy_ms": 1000, "summary": "again"}))
    tick(f)
    t = env.tasks()["task-11111111"]
    assert t["title"] == "Fix /fs/list" and t["status"] == "idle" and t["busy_ms"] == 121000 and t["turns"] == 2

    env.write(E("agent.session_end", 6, {"session_id": "s1", "pty_id": 5}))
    tick(f)
    t = env.tasks()["task-11111111"]
    assert t["status"] == "review" and t["agent"]["pty_id"] is None


def test_auto_task_only_after_prompt(env):
    E = env.ev
    env.write(
        E("agent.session_start", 0, {"session_id": "pre", "pty_id": 9, "cwd": str(env.a / "sub")}, workspace=None),
        E("agent.session_start", 0.5, {"session_id": "used", "pty_id": 10, "cwd": str(env.b)}, workspace=None),
    )
    f = env.follower()
    tick(f)
    assert env.tasks() == {} and env.tasks(env.b) == {}, "a prewarmed session alone makes no task"

    env.write(
        E("agent.prompt", 1, {"session_id": "used", "pty_id": 10}, workspace=None),
        E("agent.tool", 2, {"session_id": "used", "pty_id": 10, "tool": "Bash", "phase": "pre"}, workspace=None),
        E("agent.turn_end", 3, {"session_id": "used", "pty_id": 10, "busy_ms": 5000,
                                "lee_status": {"status": "blocked", "summary": "Need the API key"}}, workspace=None),
    )
    tick(f)
    assert env.tasks() == {}
    [t] = env.tasks(env.b).values()
    assert t["confirmed"] is False and t["origin"] == {"kind": "agent", "ref": None}
    assert t["title"] == "Need the API key" and t["title_source"] == "agent"
    assert t["status"] == "waiting" and t["busy_ms"] == 5000 and t["agent"]["pty_id"] == 10
    recent = CockpitTaskStore(env.b).recent_events()
    assert {r["kind"] for r in recent} == {"auto_created", "status"}


def test_pending_session_survives_restart(env):
    E = env.ev
    env.write(E("agent.session_start", 0, {"session_id": "s9", "pty_id": 3, "cwd": str(env.a)}))
    tick(env.follower())
    env.write(E("agent.prompt", 1, {"session_id": "s9", "pty_id": 3}, workspace=None))
    tick(env.follower())
    [t] = env.tasks().values()
    assert t["title"] == "Claude in wsA" and t["title_source"] == "auto"


def test_checkin_updates_or_creates(env):
    E = env.ev
    CockpitTaskStore(env.a).upsert({"id": "task-22222222", "title": "Mine", "agent": {"pty_id": 4}, "status": "running"})
    env.write(
        E("checkin.result", 1, {"checkin_id": "c1", "pty_id": 4, "ok": True, "source": "screen",
                                "lee_status": {"status": "in-progress", "summary": "Halfway"}, "summary": "Halfway there",
                                "duration_ms": 9000}),
        E("checkin.result", 2, {"checkin_id": "c2", "pty_id": 8, "ok": True, "source": "screen",
                                "lee_status": {"status": "done", "summary": "Wrote the docs"}, "duration_ms": 9000}),
        E("checkin.result", 3, {"checkin_id": "c3", "pty_id": 11, "ok": False, "error": "timeout", "source": "screen", "duration_ms": 1}),
    )
    tick(env.follower())
    tasks = env.tasks()
    mine = tasks["task-22222222"]
    assert mine["title"] == "Mine" and mine["summary"] == "Halfway there" and mine["status"] == "running"
    assert mine["last_checkin_at"]
    [other] = [t for t in tasks.values() if t["id"] != "task-22222222"]
    assert other["origin"] == {"kind": "checkin", "ref": "c2"} and other["confirmed"] is False
    assert other["status"] == "review" and other["title"] == "Wrote the docs"
    assert len(tasks) == 2


def test_idempotent_after_cursor_reset_and_restart(env):
    E = env.ev
    env.write(
        E("task.launch", 0, {"task_id": "task-33333333", "pty_id": 1, "session_id": "sx", "lead": "delegate",
                              "kind": "chore", "confirmed": True, "play": False, "origin_kind": "launcher"}),
        E("agent.prompt", 1, {"session_id": "sx", "pty_id": 1}),
        E("agent.turn_end", 2, {"session_id": "sx", "pty_id": 1, "busy_ms": 7000}),
        E("agent.prompt", 3, {"session_id": "auto", "pty_id": 2}),
        E("agent.turn_end", 4, {"session_id": "auto", "pty_id": 2, "busy_ms": 3000}),
        E("operation.result", 5, {"run_id": "run_1", "op": "bench", "status": "passed", "exit_code": 0,
                                  "duration_ms": 10, "readings": [{"metric": "cold_start_ms", "value": 1412, "unit": "ms"}]}),
    )
    f = env.follower()
    tick(f)
    before = env.tasks()
    assert len(before) == 2

    # nothing new: no writes
    assert tick(f) == 0
    # a new follower (daemon restart) with the cursor file: nothing re-applied
    assert tick(env.follower()) == 0

    # cursor lost entirely: replay from the start of the files, still no double counting
    env.state.unlink()
    f2 = env.follower()
    tick(f2)
    after = env.tasks()
    assert after.keys() == before.keys()
    for tid in before:
        assert after[tid]["busy_ms"] == before[tid]["busy_ms"]
        assert after[tid]["turns"] == before[tid]["turns"]
    assert after["task-33333333"]["busy_ms"] == 7000
    lines = (env.a / ".hester" / "goals" / "metrics.jsonl").read_text().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {
        "ts": env.ev("x", 5, {})["ts"], "kind": "reading", "metric": "cold_start_ms", "value": 1412, "unit": "ms",
        "source": {"kind": "operation", "op": "bench", "run_id": "run_1"}, "workspace": str(env.a),
    }


def test_partial_lines_rotation_and_truncation(env):
    E = env.ev
    env.write(E("agent.prompt", 0, {"session_id": "p1", "pty_id": 1}))
    f = env.follower()
    [path] = list(env.events.glob("*.jsonl"))
    line = json.dumps(E("agent.turn_end", 1, {"session_id": "p1", "pty_id": 1, "busy_ms": 100}))
    with open(path, "a") as fh:
        fh.write(line[:20])
    tick(f)
    assert list(env.tasks().values())[0]["turns"] == 0
    with open(path, "a") as fh:
        fh.write(line[20:] + "\n")
    tick(f)
    assert list(env.tasks().values())[0]["turns"] == 1

    # a continuation file for the same day is picked up
    cont = path.with_name(path.name.replace(".jsonl", ".1.jsonl"))
    cont.write_text(json.dumps(E("agent.turn_end", 2, {"session_id": "p1", "pty_id": 1, "busy_ms": 100})) + "\n")
    tick(f)
    assert list(env.tasks().values())[0]["turns"] == 2

    # truncated file: offset resets, already-applied events are skipped by applied_through
    cont.write_text("")
    tick(f)
    cont.write_text(json.dumps(E("agent.turn_end", 3, {"session_id": "p1", "pty_id": 1, "busy_ms": 100})) + "\n")
    tick(f)
    t = list(env.tasks().values())[0]
    assert t["turns"] == 3 and t["busy_ms"] == 300


def test_closed_task_sessions_are_ignored_for_24h(env):
    E = env.ev
    env.write(
        E("task.launch", 0, {"task_id": "task-44444444", "pty_id": 1, "session_id": "done-s", "lead": "delegate",
                              "kind": "bug", "confirmed": True, "play": False, "origin_kind": "launcher"}),
        E("agent.turn_end", 1, {"session_id": "done-s", "pty_id": 1, "busy_ms": 10}),
    )
    f = env.follower()
    tick(f)
    store = CockpitTaskStore(env.a)
    store.close("task-44444444", {"status": "done"}, now=at(2))
    env.write(E("agent.prompt", 3, {"session_id": "done-s", "pty_id": 1}),
              E("agent.turn_end", 4, {"session_id": "done-s", "pty_id": 1, "busy_ms": 99}))
    tick(f)
    tasks = env.tasks()
    assert list(tasks) == ["task-44444444"]
    assert tasks["task-44444444"]["busy_ms"] == 10 and tasks["task-44444444"]["status"] == "done"


def test_events_outside_48h_on_first_start_are_skipped(env):
    E = env.ev
    old = make_event("agent.prompt", datetime.now(timezone.utc) - timedelta(hours=60), {"session_id": "old", "pty_id": 1}, workspace=str(env.a))
    old["id"] = "old1"
    env.write(old, E("agent.prompt", 0, {"session_id": "new", "pty_id": 2}))
    tick(env.follower())
    assert [t["sessions"] for t in env.tasks().values()] == [["new"]]


def test_background_loop_starts_and_stops(env):
    E = env.ev
    env.write(E("agent.prompt", 0, {"session_id": "loop", "pty_id": 1}))

    async def main():
        f = env.follower()
        f.start()
        for _ in range(50):
            if env.tasks():
                break
            await asyncio.sleep(0.02)
        await f.stop()
        return f

    asyncio.run(main())
    assert len(env.tasks()) == 1
    assert json.loads(env.state.read_text())["cursor"]["offset"] > 0


def test_task_linked_over_http_is_not_duplicated(env):
    E = env.ev
    env.write(E("agent.session_start", 0, {"session_id": "s-link", "pty_id": 21, "cwd": str(env.a)}))
    f = env.follower()
    tick(f)
    store = CockpitTaskStore(env.a)
    store.upsert({"id": "task-55555555", "title": "Assigned by hand"})
    store.link("task-55555555", {"pty_id": 21, "session_id": "s-link"})
    env.write(E("agent.prompt", 1, {"session_id": "s-link", "pty_id": 21}),
              E("agent.turn_end", 2, {"session_id": "s-link", "pty_id": 21, "busy_ms": 50}))
    tick(f)
    tasks = env.tasks()
    assert list(tasks) == ["task-55555555"]
    assert tasks["task-55555555"]["busy_ms"] == 50 and tasks["task-55555555"]["title"] == "Assigned by hand"


def test_failed_apply_replays_the_batch(env, monkeypatch):
    E = env.ev
    env.write(
        E("agent.session_start", 0, {"session_id": "sb", "pty_id": 3, "cwd": str(env.b)}, workspace="B"),
        E("agent.prompt", 0.1, {"session_id": "sb", "pty_id": 3}, workspace="B"),
        E("agent.session_start", 0.2, {"session_id": "sa", "pty_id": 4, "cwd": str(env.a)}),
        E("agent.prompt", 0.3, {"session_id": "sa", "pty_id": 4}),
    )
    f = env.follower()
    real_save = CockpitTaskStore.save
    broken = {"on": True}

    def save(self, task, *a, **kw):
        if broken["on"] and self.workspace == env.b:
            raise PermissionError("read-only checkout")
        return real_save(self, task, *a, **kw)

    monkeypatch.setattr(CockpitTaskStore, "save", save)
    tick(f)
    assert len(env.tasks()) == 1, "workspace A is applied even though B failed"
    assert env.tasks(env.b) == {}
    broken["on"] = False
    tick(f)
    assert len(env.tasks(env.b)) == 1, "B's events were replayed, not skipped"
    assert len(env.tasks()) == 1, "A's replay is de-duplicated"


def test_failing_workspace_gives_up_after_retries(env, monkeypatch):
    from hester.daemon.cockpit import follower as fmod

    E = env.ev
    env.write(E("agent.session_start", 0, {"session_id": "sb", "pty_id": 3, "cwd": str(env.b)}, workspace="B"),
              E("agent.prompt", 0.1, {"session_id": "sb", "pty_id": 3}, workspace="B"))
    f = env.follower()

    def save(self, task, *a, **kw):
        raise PermissionError("read-only")

    monkeypatch.setattr(CockpitTaskStore, "save", save)
    for _ in range(fmod.MAX_APPLY_RETRIES - 1):
        tick(f)
        assert f._cursor is None or not env.state.exists()
    tick(f)
    assert env.state.exists() and json.loads(env.state.read_text())["cursor"] is not None


def test_slow_relay_launch_folds_the_automatic_task(env):
    E = env.ev
    env.write(
        E("agent.session_start", 0, {"session_id": "s1", "pty_id": 5, "cwd": str(env.a)}),
        E("agent.prompt", 0.1, {"session_id": "s1", "pty_id": 5}),
        E("task.launch", 0.2, {"task_id": "task-abc12345", "pty_id": 5, "session_id": "s1", "provider": "claude",
                               "lead": "delegate", "kind": "bug", "confirmed": True, "origin_kind": "launcher"}),
        E("agent.turn_end", 1, {"session_id": "s1", "pty_id": 5, "busy_ms": 5000,
                                "lee_status": {"status": "done", "summary": "Fixed"}}),
    )
    f = env.follower()
    tick(f)
    tasks = env.tasks()
    assert list(tasks) == ["task-abc12345"], "no duplicate automatic task"
    t = tasks["task-abc12345"]
    assert t["busy_ms"] == 5000 and t["turns"] == 1 and t["status"] == "review" and t["confirmed"] is True
    assert t["sessions"] == ["s1"]
    # the spooled relay lands afterwards and merges into it without undoing the follower's status
    t, created = CockpitTaskStore(env.a).upsert({"id": "task-abc12345", "title": "Fix bug", "status": "running",
                                                 "agent": {"provider": "claude", "pty_id": 5, "session_id": "s1"}})
    assert not created and t["title"] == "Fix bug" and t["status"] == "review" and t["busy_ms"] == 5000


def test_stale_pty_from_before_a_lee_restart_is_not_matched(env):
    E = env.ev
    env.write(
        E("checkin.result", 0, {"ok": True, "pty_id": 5, "checkin_id": "c1", "summary": "Old work",
                                "lee_status": {"status": "in-progress", "summary": "Old work"}}),
    )
    f = env.follower()
    tick(f)
    (old_id,) = env.tasks()
    env.write(
        E("app.start", 10, {"version": "x", "pid": 1}, workspace=None),
        E("checkin.result", 11, {"ok": True, "pty_id": 5, "checkin_id": "c2", "summary": "New work",
                                 "lee_status": {"status": "in-progress", "summary": "New work"}}),
    )
    tick(f)
    tasks = env.tasks()
    assert len(tasks) == 2 and tasks[old_id]["summary"] == "Old work"
    (new_id,) = set(tasks) - {old_id}
    assert tasks[new_id]["summary"] == "New work"
    # within the same Lee run the new task keeps matching by pty
    env.write(E("checkin.result", 12, {"ok": True, "pty_id": 5, "checkin_id": "c3", "summary": "More",
                                       "lee_status": {"status": "in-progress", "summary": "More"}}))
    tick(f)
    assert len(env.tasks()) == 2 and env.tasks()[new_id]["summary"] == "More"
    # the boot survives a restart of the follower (state file)
    f2 = env.follower()
    f2._load_state()
    assert f2._boots
