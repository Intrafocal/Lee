"""
Keep a workspace's ``.hester/`` out of git.

Hester's local state (the Desk and its Pages, Ideas, tasks, goal drafts)
lives in ``<workspace>/.hester/``, and in most projects nothing tells git to
ignore it, so a ``git add -A`` would commit it. The first time Hester writes
there, it adds ``.hester/.gitignore``, which ignores everything in
``.hester/`` (itself included) except ``plugins/``, a project's own Hester
plugins, which are meant to be committed. The project's own .gitignore is
never touched, and an existing ``.hester/.gitignore`` is left as it is.
"""

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("hester.daemon.hester_dir")

GITIGNORE = """\
# Written by Hester: its local state here (the Desk, Ideas, tasks, drafts) stays
# out of git. plugins/ is the project's own Hester plugins, meant to be committed.
# Edit or delete this file to change that; Hester won't rewrite it.
*
!plugins/
!plugins/**
"""

_done: set = set()


def ensure_gitignored(workspace: Any) -> bool:
    """Write ``<workspace>/.hester/.gitignore`` unless there is one. True when it wrote it. Never raises."""
    try:
        ws = Path(workspace).expanduser().resolve()
        key = str(ws)
        if key in _done:
            return False
        if not ws.is_dir():
            return False
        hester = ws / ".hester"
        target = hester / ".gitignore"
        if target.exists():
            _done.add(key)
            return False
        hester.mkdir(exist_ok=True)
        target.write_text(GITIGNORE, encoding="utf-8")
        _done.add(key)
        return True
    except OSError as e:
        logger.debug("Couldn't write .hester/.gitignore in %s: %s", workspace, e)
        return False
