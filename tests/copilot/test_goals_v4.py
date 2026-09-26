"""Copilot v4: GOALS.md parsing, goal status, History goal impact, drafts, workstreams, knowledge hints."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from hester.daemon.cockpit import goal_status, steward
from hester.daemon.cockpit.goals import load_goals, parse_goals_full, parse_target
from hester.daemon.cockpit.tasks import CockpitTaskStore

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401

REPO = Path(__file__).resolve().parents[2]

MINI_GOALS = """# Goals

## Constraints

- **C1 Local-first.** Nothing leaves the machine.
  - telemetry: calls not caused by a user action. Target: 0.
  - available: no

## Goals (in priority order)

### G1 Fun

Fun first.

- metric: **peek_rate**: peeks per hour.
  - kind: runnable
  - target: falling
- metric: **human_balance**: share of focus on important work.
  - kind: runnable
  - target: ≥ 50%
- metric: **weekly_retro**: two questions.
  - kind: judged

### G2 Managed

- metric: **lost_threads**: threads lost.
  - kind: runnable
  - target: falling
  - measure: op:count-lost

## Tensions

- **G1 vs G2 (fun vs management):** tension text. Default: fun wins. Arbiter: peek_rate.
"""


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def record(ws: Path, ts: datetime, **metrics) -> dict:
    return {"ts": iso(ts), "from": iso(ts - timedelta(days=7)), "to": iso(ts), "formula_version": 4,
            "workspace": str(ws), "metrics": metrics, "unavailable": []}


def write_lines(ws: Path, lines) -> None:
    p = ws / ".hester" / "goals" / "metrics.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


@pytest.fixture
def ws(tmp_path, monkeypatch):
    w = (tmp_path / "ws")
    w.mkdir()
    (w / "GOALS.md").write_text(MINI_GOALS)
    goal_status.invalidate()

    def no_run(*a, **k):
        raise AssertionError("metrics.run should not be needed")

    monkeypatch.setattr(goal_status, "run_metrics", no_run)
    return w.resolve()


# ---------------------------------------------------------------- parsing


def test_parse_real_goals_file():
    parsed = parse_goals_full((REPO / "GOALS.md").read_text())
    goals = parsed["goals"]
    assert [g["id"] for g in goals] == ["G1", "G4", "G2", "G3"]
    assert [g["priority"] for g in goals] == [0, 1, 2, 3]
    assert goals[0]["title"] == "Humane, fun development"
    assert goals[0]["prose"].startswith("Lee makes orchestration easy") and len(goals[0]["prose"]) <= 1500
    assert "Keep good friction" in goals[0]["prose"] and "metric:" not in goals[0]["prose"]
    names = {g["id"]: [m["name"] for m in g["metrics"]] for g in goals}
    assert names == {
        "G1": ["peek_rate", "toil_load", "tool_failures", "creative_share", "catch_up_time", "weekly_retro"],
        "G4": ["focus_interruptions", "background_leverage", "device_creative_share", "capture_pickup"],
        "G2": ["attributed_agent_time", "attention_latency", "lost_threads"],
        "G3": ["nudge_acceptance", "pull_usage", "human_balance", "surprise"],
    }
    for g in goals:
        for m in g["metrics"]:
            assert m["kind"] in ("runnable", "proxy", "judged"), m
            assert m["available"], m
            assert m["description"], m
            if m["kind"] != "judged":
                assert m["signal"] and m["target_text"], m
            if m["target"]["direction"] == "rising":
                assert m["guard"], m
    by = {m["name"]: m for g in goals for m in g["metrics"]}
    assert by["peek_rate"]["target"] == {"direction": "falling", "op": None, "value": None, "unit": None}
    assert by["human_balance"]["target"] == {"direction": None, "op": ">=", "value": 0.5, "unit": "%"}
    assert by["focus_interruptions"]["target"]["op"] == "<=" and by["focus_interruptions"]["target"]["value"] == 1
    assert by["device_creative_share"]["target"]["op"] == ">"
    assert by["capture_pickup"]["target"]["value"] == 0.7
    assert by["pull_usage"]["target"]["direction"] == "rising"
    assert by["background_leverage"]["guard"].startswith("agent spend per accepted result") and by["background_leverage"]["guard"].endswith("all not rising")
    assert by["weekly_retro"]["kind"] == "judged" and by["weekly_retro"]["target_text"] is None

    cons = parsed["constraints"]
    assert [c["id"] for c in cons] == ["C1", "C2", "C3"]
    assert cons[0]["title"] == "Local-first"
    for c in cons:
        assert c["telemetry"] and c["available"] and c["target_text"] == "0"
        assert c["target"]["op"] == "<=" and c["target"]["value"] == 0
        assert "Target" not in c["telemetry"]

    tens = parsed["tensions"]
    assert len(tens) == 9
    t0 = tens[0]
    assert (t0["a"], t0["b"], t0["label"]) == ("G1", "G2", "management becomes toil")
    assert t0["default"].startswith("a feature that asks you to manage") and "Arbiter" not in t0["default"]
    assert t0["arbiter"].startswith("toil_load") and t0["arbiter_metrics"] == ["toil_load"]
    assert t0["ids"] == ["G1", "G2"]
    assert tens[1]["a"] == "Good friction" and tens[1]["label"] is None
    reading = next(t for t in tens if t["a"] == "Less reading")
    assert reading["b"] == "informed review" and reading["label"] == "G1 vs C3"
    for t in tens:
        assert t["default"] and t["arbiter"], t


def test_link_picker_unchanged():
    ids = [g["id"] for g in load_goals(REPO)]
    assert ids[:3] == ["C1", "C2", "C3"] and set(ids[3:]) == {"G1", "G2", "G3", "G4"}


@pytest.mark.parametrize("text,want", [
    ("falling", {"direction": "falling", "op": None, "value": None, "unit": None}),
    ("rising over the first month, then steady", {"direction": "rising", "op": None, "value": None, "unit": None}),
    ("≥ 50%", {"direction": None, "op": ">=", "value": 0.5, "unit": "%"}),
    ("≤ 1 per session", {"direction": None, "op": "<=", "value": 1, "unit": None}),
    ("> 50%", {"direction": None, "op": ">", "value": 0.5, "unit": "%"}),
    ("≥ 70% within two weeks", {"direction": None, "op": ">=", "value": 0.7, "unit": "%"}),
    ("steady", {"direction": None, "op": None, "value": None, "unit": None}),
    (None, {"direction": None, "op": None, "value": None, "unit": None}),
])
def test_parse_target(text, want):
    assert parse_target(text) == want


# ---------------------------------------------------------------- status


def test_status_values_trend_ok_and_readings(ws):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    write_lines(ws, [
        record(ws, now - timedelta(days=7), peek_rate=2.0, human_balance=0.3, lost_threads=5, c1_violations=1),
        record(ws, now - timedelta(days=3), peek_rate=1.5),
        record(ws, now - timedelta(minutes=5), peek_rate=1.0, human_balance=0.6, lost_threads=4, c1_violations=0,
               human_balance_ms={"Q1": 0, "Q2": 60000, "Q3": 0, "Q4": 0, "play": 0, "unclassified": 0},
               human_balance_by_goal={"G1": 60000}),
        {"ts": iso(now - timedelta(days=1)), "kind": "reading", "metric": "lost_threads", "value": 7,
         "source": {"kind": "operation", "op": "count-lost", "run_id": "r1"}, "workspace": str(ws)},
        {"ts": iso(now - timedelta(minutes=1)), "kind": "reading", "metric": "lost_threads", "value": 9,
         "source": {"kind": "operation", "op": "count-lost", "run_id": "r2"}, "workspace": str(ws)},
        # another workspace's record is ignored
        {**record(Path("/elsewhere"), now, peek_rate=99.0)},
    ])
    s = goal_status.build_status(ws, 7, now)
    assert s["days"] == 7 and s["generated_at"]
    g1, g2 = s["goals"]
    assert (g1["id"], g1["priority"], g1["prose"]) == ("G1", 0, "Fun first.")
    peek = g1["metrics"][0]
    assert peek["value"] == 1.0 and peek["previous"] == 2.0 and peek["trend"] == "down"
    assert peek["ok"] is True and peek["source"] == "metrics" and peek["target_text"] == "falling"
    hb = g1["metrics"][1]
    assert hb["value"] == 0.6 and hb["ok"] is True and hb["trend"] == "up"
    retro_m = g1["metrics"][2]
    assert retro_m["source"] == "judged" and retro_m["value"] is None and retro_m["at"] is None
    lost = g2["metrics"][0]
    assert lost["source"] == "reading" and lost["value"] == 9 and lost["previous"] == 7
    assert lost["trend"] == "up" and lost["ok"] is False
    assert g1["focus_ms_7d"] == 60000 and g2["focus_ms_7d"] == 0
    # G2: nothing serving and a metric going the wrong way
    assert g2["flagged"] is True and g1["flagged"] is False
    assert s["constraints"][0]["id"] == "C1" and s["constraints"][0]["violations"] == 0
    assert s["tensions"][0]["a"] == "G1" and s["tensions"][0]["arbiter"] == "peek_rate"
    assert s["human_balance"]["share"] == 0.6
    assert s["human_balance"]["line"] == "100% Q2; G2 got none of your time this week."


def test_status_serving_clears_flag(ws):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    write_lines(ws, [
        record(ws, now - timedelta(days=7), lost_threads=1),
        record(ws, now - timedelta(minutes=1), lost_threads=5),
    ])
    store = CockpitTaskStore(ws)
    t, _ = store.upsert({"title": "Reduce lost threads", "serves": ["G2"]})
    old, _ = store.upsert({"title": "Old one", "serves": ["G2"]})
    store.close(old["id"], {"status": "done"}, now=now - timedelta(days=20))
    s = goal_status.build_status(ws, 7, now)
    g2 = s["goals"][1]
    assert [x["id"] for x in g2["serving"]["tasks"]] == [t["id"]]
    assert g2["serving"]["tasks"][0]["quadrant"] == "Q2"
    assert g2["flagged"] is False


def test_status_runs_metrics_when_stale(ws, monkeypatch):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    write_lines(ws, [record(ws, now - timedelta(hours=3), peek_rate=3.0)])
    calls = []

    def fake_run(start, end, workspace):
        calls.append((start, end, workspace))
        return record(Path(workspace), end, peek_rate=1.0)

    monkeypatch.setattr(goal_status, "run_metrics", fake_run)
    s = goal_status.build_status(ws, 7, now)
    assert len(calls) == 1 and calls[0][2] == str(ws) and calls[0][1] - calls[0][0] == timedelta(days=7)
    assert s["goals"][0]["metrics"][0]["value"] == 1.0
    assert s["goals"][0]["metrics"][0]["previous"] == 3.0
    lines = (ws / ".hester" / "goals" / "metrics.jsonl").read_text().splitlines()
    assert len(lines) == 2
    # cached: a second call within 10 min doesn't recompute
    goal_status.build_status(ws, 7, now)
    assert len(calls) == 1


def test_status_no_data(ws, monkeypatch):
    now = datetime.now(timezone.utc)
    monkeypatch.setattr(goal_status, "run_metrics", lambda start, end, workspace: None)
    s = goal_status.build_status(ws, 7, now)
    m = s["goals"][0]["metrics"][0]
    assert m["value"] is None and m["ok"] is None and m["trend"] is None and m["source"] is None
    assert s["goals"][0]["flagged"] is False
    assert s["human_balance"]["line"] == "No focus time recorded this week."
    assert s["human_balance"]["share"] is None


def test_strip_line():
    goals = [{"id": "G1", "priority": 0}, {"id": "G4", "priority": 1}]
    ms = {"Q1": 0, "Q2": 4, "Q3": 50, "Q4": 46, "play": 0, "unclassified": 900}
    assert goal_status.strip_line(ms, {"G4": 4}, goals) == "4% Q2; G1 got none of your time this week."
    assert goal_status.strip_line(ms, {"G1": 1, "G4": 3}, goals) == "4% Q2."
    assert goal_status.strip_line({}, {}, goals) == "No focus time recorded this week."
    assert goal_status.strip_line({"unclassified": 10}, {}, goals) == "0% Q2; G1 got none of your time this week."


def test_status_route(cockpit_env, monkeypatch):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(MINI_GOALS)
    goal_status.invalidate()
    monkeypatch.setattr(goal_status, "run_metrics", lambda s, e, w: record(Path(w), e, peek_rate=1.0))
    r = env.client.get("/cockpit/goals/status", headers=hdr(env.a), params={"days": 7})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert [g["id"] for g in data["goals"]] == ["G1", "G2"]
    assert set(data["human_balance"]) == {"share", "ms", "by_goal", "line"}
    assert set(data["human_balance"]["ms"]) == {"Q1", "Q2", "Q3", "Q4", "play", "unclassified"}
    assert env.client.get("/cockpit/goals", headers=hdr(env.a)).json()["data"][0]["id"] == "C1"


# ---------------------------------------------------------------- history


def test_history_goal_impact_and_reading_delta(ws, monkeypatch):
    from hester.daemon.cockpit import history

    monkeypatch.setattr(history, "verified_wins", lambda *a, **k: [])
    now = datetime.now(timezone.utc).replace(microsecond=0)
    store = CockpitTaskStore(ws)
    t, _ = store.upsert({"title": "Serve both", "serves": ["G1", "G2", "C1", "X9"]})
    store.close(t["id"], {"status": "done"}, now=now - timedelta(hours=1))
    write_lines(ws, [
        {"ts": iso(now - timedelta(days=2)), "kind": "reading", "metric": "lost_threads", "value": 7,
         "source": {"kind": "operation", "op": "count-lost", "run_id": "r1"}},
        {"ts": iso(now - timedelta(hours=2)), "kind": "reading", "metric": "lost_threads", "value": 4,
         "source": {"kind": "operation", "op": "count-lost", "run_id": "r2"}},
        {"ts": iso(now - timedelta(hours=1)), "kind": "reading", "metric": "boot_ms", "value": 900,
         "source": {"kind": "operation", "op": "count-lost", "run_id": "r3"}},
        {"ts": iso(now - timedelta(hours=1)), "kind": "reading", "metric": "unrelated", "value": 1,
         "source": {"kind": "operation", "op": "other", "run_id": "r4"}},
    ])
    h = history.build_history(ws, 7, now=now)
    assert h["tasks"][0]["goal_impact"] == ["G1", "G2"]
    by = {}
    for r in h["readings"]:  # newest first
        by.setdefault(r["metric"], r)
    assert by["lost_threads"]["goal_id"] == "G2" and by["lost_threads"]["delta"] == -3
    assert by["boot_ms"]["goal_id"] == "G2" and by["boot_ms"]["delta"] is None  # linked by measure: op
    assert by["unrelated"]["goal_id"] is None


# ---------------------------------------------------------------- drafts


def test_draft_diff_and_apply(ws):
    now = datetime.now(timezone.utc)
    proposed = MINI_GOALS.replace("Fun first.", "Fun first, always.")
    d = steward.save_draft(ws, proposed, "tighten G1", "G1", now)
    assert d["draft_id"].startswith("draft-") and "-Fun first." in d["diff"] and "+Fun first, always." in d["diff"]
    assert (ws / ".hester" / "goals" / "drafts" / f"{d['draft_id']}.GOALS.md").read_text() == proposed
    assert (ws / "GOALS.md").read_text() == MINI_GOALS  # nothing written yet
    out = steward.apply_draft(ws, d["draft_id"])
    assert out["applied"] is True and (ws / "GOALS.md").read_text() == proposed

    d2 = steward.save_draft(ws, proposed + "\n", "again", None, now)
    (ws / "GOALS.md").write_text(proposed + "edited by hand\n")
    with pytest.raises(steward.StewardError) as e:
        steward.apply_draft(ws, d2["draft_id"])
    assert e.value.status == 409
    assert (ws / "GOALS.md").read_text().endswith("edited by hand\n")
    with pytest.raises(steward.StewardError) as e:
        steward.apply_draft(ws, "draft-20260101T000000-abcd")
    assert e.value.status == 404


def test_draft_routes(cockpit_env, monkeypatch):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(MINI_GOALS)
    new = MINI_GOALS.replace("### G2 Managed", "### G2 Well managed")

    async def fake_call(workspace, surface, message, context, request_id):
        assert surface == "goal-edit" and "### G1 Fun" in context and "rename G2" in message
        return f"Renamed G2.\n\n```markdown\n{new}```\n"

    monkeypatch.setattr(steward, "call_model", fake_call)
    c, h = env.client, hdr(env.a)
    assert c.post("/cockpit/goals/draft", headers=h, json={}).status_code == 400
    r = c.post("/cockpit/goals/draft", headers=h, json={"instruction": "rename G2", "goal_id": "G2"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["surface"] == "goal-edit" and data["text"] == "Renamed G2."
    assert "+### G2 Well managed" in data["diff"] and data["draft_id"]
    assert (env.a / "GOALS.md").read_text() == MINI_GOALS
    r = c.post(f"/cockpit/goals/draft/{data['draft_id']}/apply", headers=h, json={})
    assert r.status_code == 200 and (env.a / "GOALS.md").read_text() == new
    # the base changed (it's the applied text now): 409
    r = c.post(f"/cockpit/goals/draft/{data['draft_id']}/apply", headers=h, json={})
    assert r.status_code == 409


# ---------------------------------------------------------------- workstreams


def test_build_toward_workstream(cockpit_env):
    env = cockpit_env
    (env.a / "GOALS.md").write_text(MINI_GOALS)
    r = env.client.post("/cockpit/goals/G2/workstream", headers=hdr(env.a), json={})
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["title"] == "Toward G2: Managed" and data["phase"] == "exploration"
    snap = env.client.get("/cockpit/snapshot", headers=hdr(env.a)).json()["data"]
    assert [w["serves"] for w in snap["workstreams"] if w["id"] == data["workstream_id"]] == [["G2"]]
    assert env.client.post("/cockpit/goals/G9/workstream", headers=hdr(env.a), json={}).status_code == 404


def test_workstream_serves_soft_phases_and_tradeoff(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hester.daemon.workstream.models import DesignDoc
    from hester.daemon.workstream.routes import create_workstream_router
    from hester.daemon.workstream.store import WorkstreamStore

    store = WorkstreamStore(working_dir=tmp_path)
    app = FastAPI()
    app.include_router(create_workstream_router(ws_store=store))
    c = TestClient(app)
    ws = c.post("/workstream/", json={"title": "W", "serves": ["G1"]}).json()
    assert ws["serves"] == ["G1"] and ws["phase"] == "exploration"
    wid = ws["id"]
    # soft: jump ahead, back, to review/done, and back to exploration, never paused
    assert c.post(f"/workstream/{wid}/phase/execution").json()["phase"] == "execution"
    assert c.post(f"/workstream/{wid}/phase/design").json()["phase"] == "design"
    r = c.post(f"/workstream/{wid}/design/decision", json={
        "question": "Q", "decision": "D", "rationale": "R",
        "tradeoff": {"favoured": ["G2"], "over": ["G4"], "note": "attention beats focus here"},
    })
    assert r.status_code == 200
    assert c.post(f"/workstream/{wid}/phase/review").json()["phase"] == "review"
    assert c.post(f"/workstream/{wid}/phase/planning").json()["phase"] == "planning"
    assert c.post(f"/workstream/{wid}/phase/exploration").json()["phase"] == "exploration"
    assert c.post(f"/workstream/{wid}/phase/bogus").status_code == 400
    doc_text = (store._ws_dir(wid) / "design.md").read_text()
    assert "**Trade-off:** G2 over G4 because attention beats focus here" in doc_text
    [d] = DesignDoc.from_markdown(doc_text).decisions
    assert d.tradeoff.favoured == ["G2"] and d.tradeoff.over == ["G4"] and d.tradeoff.note == "attention beats focus here"
    assert c.get(f"/workstream/{wid}").json()["serves"] == ["G1"]


# ---------------------------------------------------------------- knowledge hints


def test_git_watcher_pushes_no_hints(tmp_path, monkeypatch):
    from hester.daemon.knowledge import git_watcher as gw

    watcher = gw.GitWatcher(working_dir=tmp_path)
    pushed = []

    async def push(*a, **k):
        pushed.append(a)

    async def status():
        return gw.GitStatus(untracked_files=[f"f{i}.py" for i in range(8)], modified_files=["a.py"])

    monkeypatch.setattr(watcher, "_push_status", push)
    monkeypatch.setattr(watcher, "_get_git_status", status)
    asyncio.run(watcher.check_status())
    assert pushed == []
    assert watcher.get_last_status().total_changes == 9


def test_knowledge_engine_has_no_doc_gap_check():
    from hester.daemon.knowledge.engine import KnowledgeEngine

    assert not hasattr(KnowledgeEngine, "_check_doc_gap")
    assert not hasattr(KnowledgeEngine, "_idle_check_loop")
