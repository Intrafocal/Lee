import os
import stat
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest
from click.testing import CliRunner

from hester.daemon.copilot import ideas as ideas_mod
from hester.daemon.copilot.ideas import ID_RE, IdeaError, Idea, IdeasStore


def test_create_writes_frontmatter_file(tmp_path):
    store = IdeasStore(tmp_path)
    now = datetime(2026, 9, 25, 14, 15, 0, tzinfo=timezone.utc)
    item = store.create("Idea text\nwith a second line", source={"surface": "aeronaut", "device_id": "dev_3f9a1c2b7d10"}, now=now)

    assert ID_RE.match(item.id)
    assert item.id.startswith("idea_20260925T141500_")
    path = tmp_path / ".hester" / "ideas" / f"{item.id}.md"
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    content = path.read_text()
    assert content.startswith("---\n")
    assert f"id: {item.id}" in content
    assert "status: open" in content
    assert "as: someday" in content
    assert "surface: aeronaut" in content
    assert "device_id: dev_3f9a1c2b7d10" in content
    assert "triage: null" in content
    assert content.endswith("---\nIdea text\nwith a second line\n")


def test_frontmatter_round_trip_keeps_text_exactly(tmp_path):
    store = IdeasStore(tmp_path)
    text = "  leading spaces, trailing newline\n\n---\nnot a fence\n"
    item = store.create(text, as_="explore", source={"surface": "cli"}, tags=["a", "b"])
    back = store.get(item.id)
    assert back is not None
    assert back.to_dict() == item.to_dict()
    assert back.text == text
    assert back.as_ == "explore"
    assert back.tags == ["a", "b"]
    assert Idea.parse(item.render()).to_dict() == item.to_dict()


def test_list_newest_first_and_status_filter(tmp_path):
    store = IdeasStore(tmp_path)
    base = datetime(2026, 9, 20, 9, 0, tzinfo=timezone.utc)
    a = store.create("first", now=base)
    b = store.create("second", now=base + timedelta(hours=1))
    c = store.create("third", now=base + timedelta(hours=2))
    store.triage(b.id, "drop")

    assert [i.id for i in store.list("open")] == [c.id, a.id]
    assert [i.id for i in store.list("all")] == [c.id, b.id, a.id]
    (store.dir / "junk.md").write_text("not an item")
    (store.dir / "idea_bad.md").write_text("---\nnope")
    assert len(store.list("all")) == 3


def test_triage_sets_status_and_record(tmp_path):
    store = IdeasStore(tmp_path)
    item = store.create("promote me")
    at = datetime(2026, 9, 26, 8, 0, tzinfo=timezone.utc)
    out = store.triage(item.id, "promote", note="into the repo", now=at)
    assert out.status == "promoted"
    assert out.triage == {"action": "promote", "at": "2026-09-26T08:00:00Z", "note": "into the repo"}
    again = store.get(item.id)
    assert again.status == "promoted"
    assert again.triage["action"] == "promote"
    assert again.triage["at"] == "2026-09-26T08:00:00Z"

    for action, status in (("explore", "explored"), ("drop", "dropped"), ("keep", "kept")):
        other = store.create(action)
        assert store.triage(other.id, action).status == status

    with pytest.raises(IdeaError):
        store.triage(item.id, "archive")
    with pytest.raises(KeyError):
        store.triage("idea_20260101T000000_abcd", "keep")
    with pytest.raises(IdeaError):
        store.get("../../etc/passwd")


def test_validation(tmp_path):
    store = IdeasStore(tmp_path)
    with pytest.raises(IdeaError):
        store.create("   ")
    with pytest.raises(IdeaError):
        store.create("x", as_="later")
    with pytest.raises(IdeaError):
        store.create("x" * (ideas_mod.MAX_TEXT + 1))
    item = store.create("x", source={"surface": "toaster", "device_id": "dev_1"})
    assert item.source == {"surface": "device", "device_id": "dev_1"}


def test_atomic_write_leaves_old_file_on_failure(tmp_path):
    store = IdeasStore(tmp_path)
    item = store.create("keep me")
    path = store.dir / f"{item.id}.md"
    before = path.read_text()
    with mock.patch.object(ideas_mod.os, "replace", side_effect=OSError("disk full")):
        with pytest.raises(OSError):
            store.triage(item.id, "drop")
    assert path.read_text() == before
    assert [p.name for p in store.dir.iterdir()] == [path.name]


def test_counts(tmp_path):
    store = IdeasStore(tmp_path)
    now = datetime(2026, 9, 25, tzinfo=timezone.utc)
    store.create("old", now=now - timedelta(days=10))
    store.create("new", now=now - timedelta(days=1))
    dropped = store.create("gone", now=now - timedelta(days=20))
    store.triage(dropped.id, "drop")
    assert store.counts(now=now) == {"open": 2, "untriaged_over_7d": 1}


def test_cli_capture_and_list(tmp_path):
    from hester.cli.ideas import ideas

    runner = CliRunner()
    result = runner.invoke(ideas, ["capture", "an", "idea", "--dir", str(tmp_path)])
    assert result.exit_code == 0, result.output
    files = list((tmp_path / ".hester" / "ideas").glob("idea_*.md"))
    assert len(files) == 1
    item = IdeasStore(tmp_path).list()[0]
    assert item.text == "an idea"
    assert item.source == {"surface": "cli"}

    result = runner.invoke(ideas, ["capture", "explore this", "--explore", "--dir", str(tmp_path)])
    assert result.exit_code == 0
    by_text = {i.text: i for i in IdeasStore(tmp_path).list()}
    assert by_text["explore this"].as_ == "explore"

    result = runner.invoke(ideas, ["list", "--dir", str(tmp_path), "--all"])
    assert result.exit_code == 0
    assert by_text["an idea"].id in result.output


def test_old_someday_directory_is_never_read(tmp_path):
    old = tmp_path / ".hester" / "someday"
    old.mkdir(parents=True)
    (old / "sd_20260101T000000_abcd.md").write_text("---\nid: sd_20260101T000000_abcd\nstatus: open\n---\nold\n")
    assert IdeasStore(tmp_path).list("all") == []
    with pytest.raises(IdeaError):
        IdeasStore(tmp_path).get("sd_20260101T000000_abcd")


def test_ideas_command_replaces_someday():
    from hester.cli.main import cli

    assert "ideas" in cli.commands
    assert "someday" not in cli.commands
    assert "goals" in cli.commands
