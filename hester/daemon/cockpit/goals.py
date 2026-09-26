"""
Goal and constraint ids from ``<workspace>/GOALS.md`` for the Cockpit's link
picker: ``### G<n> <title>`` headings and ``- **C<n> <title>.**`` lines.
"""

import re
from pathlib import Path
from typing import Dict, List

_GOAL_RE = re.compile(r"^###\s+(G\d+)\s+(.+?)\s*$")
_CONSTRAINT_RE = re.compile(r"^\s*[-*]\s+\*\*(C\d+)\s+(.+?)\.?\*\*")


def parse_goals(text: str) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    seen = set()
    for line in text.splitlines():
        m = _GOAL_RE.match(line)
        kind = "goal"
        if not m:
            m = _CONSTRAINT_RE.match(line)
            kind = "constraint"
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        out.append({"id": m.group(1), "title": m.group(2).strip().rstrip("."), "kind": kind})
    return out


def load_goals(workspace: Path) -> List[Dict[str, str]]:
    try:
        text = (Path(workspace) / "GOALS.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return parse_goals(text)
