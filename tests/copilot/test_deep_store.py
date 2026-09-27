"""Deep D1 (contract section 3): explorations as directories, the Page, references, questions, sessions, Explore."""

import json
import os
import stat

import pytest

from hester.daemon.cockpit import deep
from hester.daemon.cockpit import explorations as ex
from hester.daemon.cockpit.explorations import ExplorationError, ExplorationNotFound, ExplorationStore, record_session_turn
from hester.daemon.copilot.someday import normalize_source

from .cockpit_helpers import cockpit_env, hdr  # noqa: F401

LEGACY = (
    "---\nid: {id}\nworkspace: /x\ntitle: Old one\nstatus: active\nseed: s\n"
    "origin:\n  kind: cockpit\n  ref: null\nsession_id: explore-{id}\nturns: 0\n"
    "created_at: '2026-09-20T10:00:00Z'\nupdated_at: '2026-09-20T10:00:00Z'\n"
    "last_touched_at: '2026-09-20T10:00:00Z'\narchived_at: null\nversion: 2\n---\n"
    "# Old one\n\n## Seed\n\ns\n\n## Log\n"
)


def legacy(tmp_path, exp_id="exp-0a0b0c0d", meta_id=True):
    d = tmp_path / ".hester" / "explore"
    d.mkdir(parents=True, exist_ok=True)
    text = LEGACY.format(id=exp_id)
    if not meta_id:
        text = text.replace(f"id: {exp_id}\n", "", 1)
    (d / f"{exp_id}.md").write_text(text)
    return d, text


# ---------------------------------------------------------------- layout and migration


def test_create_makes_a_directory(tmp_path):
    store = ExplorationStore(tmp_path)
    exp = store.create({"seed": "Why are syncs slow?", "page": "First line\n\n"})
    d = tmp_path / ".hester" / "explore" / exp["id"]
    assert stat.S_IMODE(os.stat(d).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(d / "exploration.md").st_mode) == 0o600
    assert (d / "page.md").read_text() == "First line\n\n"
    assert exp["page_chars"] == len("First line\n\n") and exp["page_updated_at"]
    api = ex.to_api(exp)
    assert api["links"] == [] and api["open_questions"] == 0 and api["answers_unread"] == 0 and api["last_session"] is None
    assert "page_chars" not in (d / "exploration.md").read_text(), "derived fields never reach frontmatter"
    blank = store.create({"title": "Untitled"})
    assert (tmp_path / ".hester" / "explore" / blank["id"] / "page.md").read_text() == ""
    with pytest.raises(ExplorationError):
        store.create({"title": "x", "origin": {"kind": "nope"}})
    assert store.create({"title": "o", "origin": {"kind": "opener"}})["origin"]["kind"] == "opener"


def test_migration_flat_to_directory_idempotent(tmp_path):
    d, text = legacy(tmp_path)
    store = ExplorationStore(tmp_path)
    [exp] = store.load_all()
    assert exp["id"] == "exp-0a0b0c0d"
    assert not (d / "exp-0a0b0c0d.md").exists()
    assert (d / "exp-0a0b0c0d" / "exploration.md").read_text() == text
    assert (d / "exp-0a0b0c0d" / "page.md").read_text() == ""
    # idempotent: a second load changes nothing
    assert [e["id"] for e in store.load_all()] == ["exp-0a0b0c0d"]
    assert (d / "exp-0a0b0c0d" / "exploration.md").read_text() == text


def test_migration_on_get(tmp_path):
    d, _ = legacy(tmp_path)
    assert ExplorationStore(tmp_path).get("exp-0a0b0c0d")["title"] == "Old one"
    assert (d / "exp-0a0b0c0d" / "exploration.md").exists() and not (d / "exp-0a0b0c0d.md").exists()


def test_directory_wins_over_flat_file(tmp_path, caplog):
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "New format"})
    d = tmp_path / ".hester" / "explore"
    stale = LEGACY.format(id=exp["id"])
    (d / f"{exp['id']}.md").write_text(stale)
    with caplog.at_level("WARNING"):
        assert store.require(exp["id"])["title"] == "New format"
    assert (d / f"{exp['id']}.md").read_text() == stale, "the flat file is left alone"
    assert any("Both" in r.message for r in caplog.records)
    assert [e["id"] for e in store.load_all()] == [exp["id"]]


def test_id_from_frontmatter_or_directory_name(tmp_path):
    store = ExplorationStore(tmp_path)
    d = tmp_path / ".hester" / "explore" / "exp-0b0b0b0b"
    d.mkdir(parents=True)
    (d / "exploration.md").write_text(LEGACY.format(id="exp-0b0b0b0b").replace("id: exp-0b0b0b0b\n", "", 1))
    assert store.require("exp-0b0b0b0b")["id"] == "exp-0b0b0b0b", "the parent directory name, not the stem"
    legacy(tmp_path, "exp-0c0c0c0c", meta_id=False)
    assert store.require("exp-0c0c0c0c")["id"] == "exp-0c0c0c0c"


def test_session_turn_writeback_after_migration(tmp_path):
    legacy(tmp_path)
    sid = "explore-exp-0a0b0c0d"
    assert record_session_turn(sid, str(tmp_path), "Q", "A") is True
    store = ExplorationStore(tmp_path)
    assert store.require("exp-0a0b0c0d")["turns"] == 1
    body = (tmp_path / ".hester" / "explore" / "exp-0a0b0c0d" / "exploration.md").read_text()
    assert "### You ·" in body and "### Hester ·" in body
    assert record_session_turn(sid, str(tmp_path), "Q2", "A2") is True, "and on the new path"


# ---------------------------------------------------------------- page


def test_page_get_put_conflict_and_cap(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    exp = c.post("/cockpit/explorations", headers=h, json={"title": "P"}).json()["data"]
    base = f"/cockpit/explorations/{exp['id']}/page"
    got = c.get(base, headers=h).json()["data"]
    assert got == {"text": "", "version": deep.page_version("")} and len(got["version"]) == 12
    r = c.put(base, headers=h, json={"text": "Hello\n", "base_version": got["version"]})
    assert r.status_code == 200, r.text
    v1 = r.json()["data"]["version"]
    assert v1 == deep.page_version("Hello\n")
    assert (env.a / ".hester" / "explore" / exp["id"] / "page.md").read_text() == "Hello\n"
    # stale base: 409 carries the current text and version
    r = c.put(base, headers=h, json={"text": "Mine\n", "base_version": got["version"]})
    assert r.status_code == 409
    body = r.json()
    assert body["error"] == "version_conflict" and body["version"] == v1 and body["text"] == "Hello\n"
    assert body["data"] == {"error": "version_conflict", "version": v1, "text": "Hello\n"}
    assert (env.a / ".hester" / "explore" / exp["id"] / "page.md").read_text() == "Hello\n", "nothing dropped"
    # keep mine: re-PUT with the new version
    assert c.put(base, headers=h, json={"text": "Mine\n", "base_version": v1}).status_code == 200
    big = "x" * (1024 * 1024 + 1)
    assert c.put(base, headers=h, json={"text": big, "base_version": deep.page_version("Mine\n")}).status_code == 400
    assert c.put(base, headers=h, json={"text": "y"}).status_code == 400
    assert c.get("/cockpit/explorations/exp-00000000/page", headers=h).status_code == 404
    listed = c.get("/cockpit/explorations", headers=h).json()["data"][0]
    assert listed["page_chars"] == len("Mine\n")


def test_page_put_touches_at_most_every_few_minutes(tmp_path):
    from datetime import timedelta

    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "T"})
    t0 = ex.utc_now()
    v = deep.read_page(store, exp["id"])["version"]
    v = deep.write_page(store, exp["id"], {"text": "a", "base_version": v}, t0 + timedelta(minutes=1))["version"]
    assert store.require(exp["id"])["last_touched_at"] == exp["last_touched_at"], "within 5 min: no rewrite"
    deep.write_page(store, exp["id"], {"text": "ab", "base_version": v}, t0 + timedelta(minutes=10))
    assert store.require(exp["id"])["last_touched_at"] > exp["last_touched_at"]


def test_opener_create_with_page(cockpit_env):
    env = cockpit_env
    r = env.client.post("/cockpit/explorations", headers=hdr(env.a),
                        json={"seed": "Mesh sync", "page": "Mesh sync\n\n", "origin": {"kind": "opener"}})
    assert r.status_code == 201, r.text
    exp = r.json()["data"]
    assert exp["origin"] == {"kind": "opener", "ref": None} and exp["page_chars"] == len("Mesh sync\n\n")


# ---------------------------------------------------------------- references


def test_references_crud(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    exp = c.post("/cockpit/explorations", headers=h, json={"title": "R"}).json()["data"]
    base = f"/cockpit/explorations/{exp['id']}/references"
    r = c.post(base, headers=h, json={"kind": "quote", "quote": "the vector clock", "section": "Sync", "source": {"kind": "page"}})
    assert r.status_code == 201, r.text
    q = r.json()["data"]
    assert deep.REF_ID_RE.match(q["id"]) and q["source"] == {"kind": "page"} and q["at"]
    r = c.post(base, headers=h, json={"kind": "link", "url": "https://example.com/a", "title": "A"})
    link = r.json()["data"]
    assert r.status_code == 201 and "opened_at" not in link
    assert [x["id"] for x in c.get(base, headers=h).json()["data"]] == [link["id"], q["id"]] or \
        {x["id"] for x in c.get(base, headers=h).json()["data"]} == {link["id"], q["id"]}
    for bad in ({"kind": "link", "url": "javascript:alert(1)"}, {"kind": "quote"}, {"kind": "nope"},
                {"kind": "quote", "quote": "x", "source": {"kind": "elsewhere"}}):
        assert c.post(base, headers=h, json=bad).status_code == 400, bad
    r = c.patch(f"{base}/{link['id']}", headers=h, json={"opened": True, "note": "read later"})
    assert r.status_code == 200 and r.json()["data"]["opened_at"] and r.json()["data"]["note"] == "read later"
    assert c.patch(f"{base}/{link['id']}", headers=h, json={"title": "x"}).status_code == 400
    assert c.patch(f"{base}/ref-00000000", headers=h, json={"opened": True}).status_code == 404


def test_jsonl_cap_and_atomic_rewrite(tmp_path, monkeypatch):
    monkeypatch.setattr(deep, "MAX_RECORDS", 3)
    store = ExplorationStore(tmp_path)
    exp = store.create({"title": "Cap"})
    refs = [deep.add_reference(store, exp["id"], {"kind": "quote", "quote": f"q{i}"}) for i in range(5)]
    path = tmp_path / ".hester" / "explore" / exp["id"] / "references.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [r["quote"] for r in rows] == ["q2", "q3", "q4"], "oldest dropped"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    # PATCH rewrites the file whole: no temp files left behind
    deep.patch_reference(store, exp["id"], refs[-1]["id"], {"note": "n"})
    assert [p.name for p in path.parent.iterdir() if p.name.startswith(".")] == []
    assert json.loads(path.read_text().splitlines()[-1])["note"] == "n"


# ---------------------------------------------------------------- questions


def test_questions_crud(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    exp = c.post("/cockpit/explorations", headers=h, json={"title": "Q"}).json()["data"]
    base = f"/cockpit/explorations/{exp['id']}/questions"
    anchor = {"kind": "page", "quote": "Why does it drift?", "offset": 10, "section": "Sync"}
    r = c.post(base, headers=h, json={"text": "Why does it drift?", "source": "page", "anchor": anchor})
    assert r.status_code == 201, r.text
    q = r.json()["data"]
    assert q["status"] == "open" and q["anchor"] == anchor and q["id"].startswith("q-")
    assert c.get(base, headers=h).json()["data"] == [q]
    assert c.get(f"/cockpit/explorations/{exp['id']}", headers=h).json()["data"]["open_questions"] == 1
    r = c.patch(f"{base}/{q['id']}", headers=h, json={"status": "closed"})
    assert r.json()["data"]["status"] == "closed" and r.json()["data"]["closed_at"]
    assert c.get(f"/cockpit/explorations/{exp['id']}", headers=h).json()["data"]["open_questions"] == 0
    assert c.post(base, headers=h, json={"text": "x", "source": "nope"}).status_code == 400
    assert c.post(base, headers=h, json={"text": " ", "source": "page"}).status_code == 400
    assert c.post(base, headers=h, json={"text": "x", "source": "page", "anchor": {"kind": "page"}}).status_code == 400
    assert c.patch(f"{base}/q-00000000", headers=h, json={"status": "closed"}).status_code == 404
    long = c.post(base, headers=h, json={"text": "y" * 900, "source": "ask"}).json()["data"]
    assert len(long["text"]) == 500


# ---------------------------------------------------------------- sessions


def test_sessions(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    exp = c.post("/cockpit/explorations", headers=h, json={"title": "S"}).json()["data"]
    base = f"/cockpit/explorations/{exp['id']}/sessions"
    rec = {"focus_session_id": "fs_1", "started_at": "2026-09-26T10:00:00Z", "ended_at": "2026-09-26T11:00:00Z",
           "reason": "ritual", "stopped_at": "…only helps if every write", "rating": "deep", "questions_kept": ["q-00000001"]}
    r = c.post(base, headers=h, json=rec)
    assert r.status_code == 201, r.text
    saved = r.json()["data"]
    assert deep.SESSION_ID_RE.match(saved["id"]) and {k: saved[k] for k in rec} == rec
    got = c.get(f"/cockpit/explorations/{exp['id']}", headers=h).json()["data"]
    assert got["last_session"] == saved
    unrated = dict(rec, reason="esc", rating=None, stopped_at=None, questions_kept=None)
    assert c.post(base, headers=h, json=unrated).json()["data"]["questions_kept"] == []
    for bad in (dict(rec, reason="nope"), dict(rec, rating="wow"), dict(rec, started_at="yesterday"),
                {k: v for k, v in rec.items() if k != "focus_session_id"}):
        assert c.post(base, headers=h, json=bad).status_code == 400, bad
    assert len(c.post(base, headers=h, json=dict(rec, stopped_at="z" * 2000)).json()["data"]["stopped_at"]) == 1000


# ---------------------------------------------------------------- explore


def test_explore_child_links_both_ways(cockpit_env):
    env = cockpit_env
    c, h = env.client, hdr(env.a)
    parent = c.post("/cockpit/explorations", headers=h, json={"title": "Parent"}).json()["data"]
    anchor = {"kind": "page", "quote": "CRDTs", "offset": 0, "section": None}
    r = c.post(f"/cockpit/explorations/{parent['id']}/explore", headers=h, json={"seed": "CRDTs for the queue", "anchor": anchor})
    assert r.status_code == 201, r.text
    child = r.json()["data"]
    assert child["origin"] == {"kind": "exploration", "ref": parent["id"]} and child["seed"] == "CRDTs for the queue"
    assert child["links"][0]["id"] == parent["id"] and child["links"][0]["rel"] == "parent"
    after = ExplorationStore(env.a).require(parent["id"])
    assert after["links"][0]["id"] == child["id"] and after["links"][0]["rel"] == "child"
    assert after["last_touched_at"] == parent["last_touched_at"], "the parent isn't touched"
    assert c.post(f"/cockpit/explorations/{parent['id']}/explore", headers=h, json={"seed": ""}).status_code == 400


def test_bad_ids_and_missing(tmp_path):
    store = ExplorationStore(tmp_path)
    with pytest.raises(ExplorationError):
        deep.read_page(store, "../etc")
    with pytest.raises(ExplorationNotFound):
        deep.list_references(store, "exp-00000000")


# ---------------------------------------------------------------- someday source


def test_normalize_source_keeps_deep_fields():
    src = normalize_source({
        "surface": "lee", "exploration_id": "exp-0a0b0c0d", "section": "S" * 300, "url": "https://x.dev/a",
        "file": "src/a.py", "context": "c" * 900, "secret": "dropped", "device_id": None,
    })
    assert src["surface"] == "lee" and src["exploration_id"] == "exp-0a0b0c0d" and src["url"] == "https://x.dev/a"
    assert src["file"] == "src/a.py" and len(src["section"]) == 200 and len(src["context"]) == 500
    assert "secret" not in src and "device_id" not in src
    bad = normalize_source({"surface": "lee", "exploration_id": "exp-nope", "url": "ftp://x", "file": "/etc/passwd"})
    assert bad == {"surface": "lee"}
    assert "file" not in normalize_source({"file": "../../x"}) and "file" not in normalize_source({"file": "a/../../b"})
    assert "url" not in normalize_source({"url": "https://" + "a" * 2000})


def test_someday_device_override_keeps_capture_source(cockpit_env):
    env = cockpit_env
    body = {"workspace": str(env.a), "text": "an idea", "source": {"surface": "lee", "exploration_id": "exp-0a0b0c0d", "junk": 1}}
    r = env.client.post("/someday", headers=hdr(device=True), json=body)
    assert r.status_code == 201, r.text
    src = r.json()["data"]["source"]
    assert src["surface"] == "aeronaut" and src["device_id"] == "dev_00000000abcd"
    assert src["exploration_id"] == "exp-0a0b0c0d" and "junk" not in src
    r = env.client.post("/someday", headers=hdr(), json=dict(body, source={"surface": "lee", "section": "Intro"}))
    assert r.json()["data"]["source"] == {"surface": "lee", "section": "Intro"}
