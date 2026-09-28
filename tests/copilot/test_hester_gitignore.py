"""`.hester/` stays out of the project's git: Hester writes .hester/.gitignore the first time it writes there."""

import subprocess

from hester.daemon import hester_dir
from hester.daemon.cockpit.desk import DeskStore
from hester.daemon.copilot.someday import SomedayStore


def git(ws, *args):
    return subprocess.run(["git", *args], cwd=ws, capture_output=True, text=True, check=True).stdout


def test_desk_and_ideas_are_ignored_but_plugins_are_not(tmp_path):
    hester_dir._done.clear()
    git(tmp_path, "init", "-q")
    store = DeskStore(tmp_path)
    store.create_page({"area_id": store.create_area({"name": "Mesh"})["id"], "text": "private thinking\n"})
    SomedayStore(tmp_path).create("an idea")
    plugin = tmp_path / ".hester" / "plugins" / "p" / "plugin.yaml"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("name: p\n")
    (tmp_path / "README.md").write_text("hi\n")
    untracked = git(tmp_path, "status", "--porcelain", "--untracked-files=all").split("\n")
    assert sorted(line for line in untracked if line) == ["?? .hester/plugins/p/plugin.yaml", "?? README.md"]
    assert (tmp_path / ".gitignore").exists() is False, "the project's own .gitignore is never touched"


def test_an_existing_gitignore_is_left_alone(tmp_path):
    hester_dir._done.clear()
    mine = tmp_path / ".hester" / ".gitignore"
    mine.parent.mkdir()
    mine.write_text("# mine\n")
    assert hester_dir.ensure_gitignored(tmp_path) is False
    assert mine.read_text() == "# mine\n"


def test_written_once_and_never_raises(tmp_path):
    hester_dir._done.clear()
    assert hester_dir.ensure_gitignored(tmp_path) is True
    assert (tmp_path / ".hester" / ".gitignore").read_text() == hester_dir.GITIGNORE
    assert hester_dir.ensure_gitignored(tmp_path) is False
    assert hester_dir.ensure_gitignored(tmp_path / "missing") is False
