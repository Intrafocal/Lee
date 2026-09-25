from datetime import timedelta

import pytest

from hester.daemon.copilot import digest
from hester.daemon.copilot.someday import SomedayStore

from .conftest import commit_file, git, make_event, minutes, write_events


@pytest.fixture
def repo(tmp_path, now):
    """main: old commit, commit A (src/a.py), --no-ff merge of feature (src/feat.py); other branch unmerged."""
    ws = tmp_path / "ws"
    ws.mkdir()
    git(ws, "init", "-q", "-b", "main")
    commit_file(ws, "README.md", "hi", "chore: init", now - timedelta(days=3))
    commit_file(ws, "src/a.py", "a = 1", "fix(api): handle empty queue", now - timedelta(hours=2))
    git(ws, "checkout", "-q", "-b", "feature")
    commit_file(ws, "src/feat.py", "f = 1", "feat: the feature", now - timedelta(minutes=100))
    git(ws, "checkout", "-q", "main")
    git(ws, "merge", "-q", "--no-ff", "feature", "-m", "Merge branch 'feature'", when=now - timedelta(minutes=90))
    git(ws, "checkout", "-q", "-b", "other")
    commit_file(ws, "src/other.py", "o = 1", "wip: unmerged", now - timedelta(minutes=80))
    git(ws, "checkout", "-q", "main")
    return ws


@pytest.fixture
def agent_events(repo, now, events_dir):
    ws = str(repo)
    other = "/somewhere/else"
    evs = [
        make_event("agent.session_start", now - minutes(200), {"session_id": "s1", "pty_id": 7, "provider": "claude", "cwd": ws}, workspace=ws),
        make_event("agent.turn_end", now - minutes(150), {
            "session_id": "s1", "pty_id": 7, "busy_ms": 1000, "summary": "Which database?",
            "lee_status": {"status": "waiting", "summary": "Need a call", "blockers": "Use Postgres or SQLite?", "files": [], "next": None},
        }, workspace=ws),
        make_event("attention.open", now - minutes(149), {
            "item_id": "att_1", "kind": "decision", "severity": "needs-you",
            "source": {"kind": "agent", "provider": "claude", "session_id": "s1", "pty_id": 7, "window_id": 1,
                       "tab_id": 3, "tab_label": "Claude", "workspace": ws, "cwd": ws},
        }, workspace=ws),
        make_event("attention.reply", now - minutes(140), {
            "item_id": "att_1", "kind": "decision", "action": "text", "text_chars": 8, "latency_ms": 540000,
        }, workspace=ws, actor={"kind": "user", "surface": "lee"}),
        make_event("agent.tool", now - minutes(130), {
            "session_id": "s1", "pty_id": 7, "phase": "pre", "tool": "Edit", "files": [f"{ws}/src/a.py"], "writes": True, "signature": "abc",
        }, workspace=ws),
        make_event("agent.turn_end", now - minutes(120), {
            "session_id": "s1", "pty_id": 7, "busy_ms": 60000, "summary": "Done. Tests pass.",
            "lee_status": {"status": "done", "summary": "Tests pass", "blockers": None, "files": ["src/b.py"], "next": None},
        }, workspace=ws),
        make_event("agent.session_start", now - minutes(200), {"session_id": "s2", "pty_id": 8, "provider": "claude", "cwd": other}, workspace=other),
        make_event("agent.turn_end", now - minutes(110), {"session_id": "s2", "pty_id": 8, "busy_ms": 5, "summary": "Elsewhere"}, workspace=other),
        make_event("agent.turn_end", now - minutes(600), {"session_id": "s1", "pty_id": 7, "busy_ms": 5, "summary": "Too old"}, workspace=ws),
    ]
    write_events(events_dir, evs)
    return evs


def build(repo, now, events_dir, tmp_path, **kw):
    kw.setdefault("since", now - timedelta(hours=3))
    kw.setdefault("attention_items", [])
    return digest.build_digest(repo, now=now, events_dir=events_dir, retro_config={}, retro_dir=tmp_path / "retro", **kw)


def test_detect_since_prefers_latest_long_away(now, events_dir):
    evs = [
        make_event("handoff.start", now - timedelta(hours=5), {"handoff_id": "h1"}),
        make_event("presence.change", now - timedelta(hours=3), {"from": {"at_machine": True}, "to": {"at_machine": False}, "reason": "os_idle"}),
        make_event("presence.change", now - timedelta(hours=1), {"from": {"at_machine": False}, "to": {"at_machine": True}, "reason": "os_active", "away_ms": 7200000}),
        make_event("presence.change", now - minutes(30), {"from": {"at_machine": True}, "to": {"at_machine": False}, "reason": "os_idle"}),
        make_event("presence.change", now - minutes(20), {"from": {"at_machine": False}, "to": {"at_machine": True}, "reason": "os_active", "away_ms": 600000}),
    ]
    write_events(events_dir, evs)
    assert digest.detect_since(now=now, events_dir=events_dir) == now - timedelta(hours=3)


def test_detect_since_handoff_and_default(now, events_dir, tmp_path):
    assert digest.detect_since(now=now, events_dir=tmp_path / "none") == now - timedelta(hours=12)
    write_events(events_dir, [make_event("handoff.start", now - minutes(45), {"handoff_id": "h1"})])
    assert digest.detect_since(now=now, events_dir=events_dir) == now - minutes(45)


def test_detect_since_uses_away_ms_without_start_line(now, events_dir):
    write_events(events_dir, [make_event("presence.change", now - minutes(10), {
        "from": {"at_machine": False}, "to": {"at_machine": True}, "away_ms": 3600000})])
    assert digest.detect_since(now=now, events_dir=events_dir) == now - minutes(70)


def test_verified_wins_vs_claims(repo, now, events_dir, agent_events, tmp_path):
    store = SomedayStore(repo)
    item = store.create("Try CRDTs", now=now - timedelta(days=2))
    store.triage(item.id, "keep", now=now - minutes(30))

    d = build(repo, now, events_dir, tmp_path)
    kinds = sorted(w["kind"] for w in d["wins"])
    assert kinds == ["commit", "decision", "merge", "someday_decided"]
    titles = {w["title"] for w in d["wins"]}
    assert "fix(api): handle empty queue" in titles
    assert "Merge branch 'feature'" in titles
    assert "Answered Claude: Use Postgres or SQLite?" in titles
    assert not any("wip" in t or "init" in t or "the feature" in t for t in titles)
    assert all(w["verified"] is True for w in d["wins"])
    assert not any("_files" in w or "_pty" in w for w in d["wins"])

    assert len(d["agent_claims"]) == 1
    claim = d["agent_claims"][0]
    assert claim["session_id"] == "s1"
    assert claim["summary"] == "Done. Tests pass."
    assert claim["verified"] is False
    assert not any("Tests pass" in w["title"] for w in d["wins"])

    assert d["changed"]["commits"] == 2
    assert d["changed"]["agent_files"] == [f"{repo}/src/a.py"]
    assert d["top_line"] == "4 wins · 0 waiting · 1 agent claim"
    assert d["someday"] == {"open": 0, "untriaged_over_7d": 0}
    assert set(d["retro"]) == {"due", "week"}


def test_focus_files_filter(repo, now, events_dir, agent_events, tmp_path):
    focus = {"kind": "files", "workspace": str(repo), "paths": [f"{repo}/src/a.py"]}
    d = build(repo, now, events_dir, tmp_path, focus=focus)
    assert d["focus"] == focus
    related = [w for w in d["wins"] if w["related"]]
    assert {w["kind"] for w in related} == {"commit", "decision"}
    assert d["wins"][0]["related"] and d["wins"][1]["related"]
    assert not d["wins"][-1]["related"]
    assert d["agent_claims"][0]["related"] is True

    only = build(repo, now, events_dir, tmp_path, focus=focus, only_related=True)
    assert {w["kind"] for w in only["wins"]} == {"commit", "decision"}

    merge_focus = {"kind": "files", "workspace": str(repo), "paths": ["src/feat.py"]}
    d2 = build(repo, now, events_dir, tmp_path, focus=merge_focus, only_related=True)
    assert [w["kind"] for w in d2["wins"]] == ["merge"]
    assert d2["agent_claims"] == []


def test_focus_agent_filter(repo, now, events_dir, agent_events, tmp_path):
    d = build(repo, now, events_dir, tmp_path, focus={"kind": "agent", "pty_id": 7, "window_id": 1, "label": "Claude"}, only_related=True)
    assert [w["kind"] for w in d["wins"]] == ["decision"]
    assert len(d["agent_claims"]) == 1
    d = build(repo, now, events_dir, tmp_path, focus={"kind": "agent", "pty_id": 99, "window_id": 1, "label": "x"}, only_related=True)
    assert d["wins"] == [] and d["agent_claims"] == []


def test_waiting_filtered_and_lee_offline(repo, now, events_dir, agent_events, tmp_path):
    items = [
        {"id": "att_2", "kind": "approval", "source": {"workspace": str(repo)}},
        {"id": "att_3", "kind": "waiting", "source": {"workspace": "/elsewhere"}},
    ]
    d = build(repo, now, events_dir, tmp_path, attention_items=items)
    assert [i["id"] for i in d["waiting"]] == ["att_2"]
    assert "1 waiting" in d["top_line"]

    offline = build(repo, now, events_dir, tmp_path, attention_items=None)
    assert offline["waiting"] == []
    assert "Lee offline" in offline["top_line"]


def test_waiting_cap_applies_after_workspace_filter(repo, now, events_dir, agent_events, tmp_path):
    others = [{"id": f"o_{n}", "kind": "blocker", "source": {"workspace": "/elsewhere"}} for n in range(30)]
    mine = [{"id": f"m_{n}", "kind": "waiting", "source": {"workspace": str(repo)}} for n in range(27)]
    d = build(repo, now, events_dir, tmp_path, attention_items=others + mine)
    assert [i["id"] for i in d["waiting"]] == [f"m_{n}" for n in range(25)]
    assert "27 waiting" in d["top_line"]


def test_fetch_attention_items_compacts_locally(monkeypatch):
    import asyncio

    import httpx

    from hester.daemon.copilot import routes

    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"success": True, "data": {"items": [
            {"id": "a", "state": "open", "text": "x" * 400, "files": ["f"], "lee_status": {"s": 1}},
            {"id": "b", "state": "snoozed", "text": "zz"},
        ]}})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(routes.httpx, "AsyncClient",
                        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    items = asyncio.run(routes.fetch_attention_items())
    assert "compact" not in seen["params"]
    assert [i["id"] for i in items] == ["a"]
    assert len(items[0]["text"]) == 280 and items[0]["text"].endswith("\u2026")
    assert "files" not in items[0] and "lee_status" not in items[0]


def test_since_detected_from_events(repo, now, events_dir, agent_events, tmp_path):
    write_events(events_dir, [make_event("handoff.start", now - minutes(100), {"handoff_id": "h"})])
    d = digest.build_digest(repo, now=now, events_dir=events_dir, attention_items=[], retro_config={}, retro_dir=tmp_path / "r")
    assert d["since"].startswith((now - minutes(100)).strftime("%Y-%m-%dT%H:%M"))
    kinds = sorted(w["kind"] for w in d["wins"])
    assert kinds == ["merge"]


def test_not_a_git_repo(tmp_path, now, events_dir):
    ws = tmp_path / "plain"
    ws.mkdir()
    d = digest.build_digest(ws, now=now, since=now - timedelta(hours=1), events_dir=events_dir, attention_items=[],
                            retro_config={}, retro_dir=tmp_path / "r")
    assert d["wins"] == [] and d["changed"]["commits"] == 0
